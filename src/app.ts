import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import { createHmac } from 'node:crypto'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { initServerState, shutdownServerState, serverState } from './state.js'
import { initSocket, closeIO } from './socket/index.js'
import { authRoutes } from './auth/index.js'
import { conversationRoutes, messageRoutes, reactionRoutes } from './routes/conversations.js'
import { mediaRoutes, stopStreamRateLimitCleanup } from './routes/media.js'
import { adminUserRoutes } from './routes/adminUsers.js'
import { adminAdminRoutes } from './routes/adminAdmins.js'
import { healthRoutes } from './routes/health.js'
import { preferencesRoutes } from './routes/preferences.js'
import { announcementRoutes } from './routes/announcements.js'
import { statsRoutes } from './routes/stats.js'
import { configRoutes } from './routes/config.js'
import { internalRoutes } from './routes/internal.js'
import { adminDMRoutes } from './routes/adminDM.js'
import { searchRoutes } from './routes/search.js'
import { mediaCleanupService } from './services/mediaCleanup.js'
import { drainEmailQueue } from './services/emailQueue.js'
import { closeDb, cleanupExpiredSessions, initDb } from './db/index.js'
import { env } from './lib/env.js'
import { getConfig } from './lib/config.js'
import { logger } from './lib/logger.js'
import { authenticateRequest, validateCsrf } from './middleware/auth.js'
import { stopRateLimitCleanup } from './middleware/rateLimit.js'

export async function buildApp(): Promise<FastifyInstance> {
  const config = getConfig()
  const maxBodySize = config.server?.maxBodySize ?? 100 * 1024 * 1024
  const requestTimeout = config.server?.requestTimeoutMs ?? 8000

  const fastify = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: maxBodySize,
    requestTimeout,
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'reqId',
    disableRequestLogging: false,
    routerOptions: {
      ignoreTrailingSlash: true,
      maxParamLength: 100
    }
  })

  const cookieSecret = createHmac('sha256', env.jwtSecret).update('cookie-signing').digest('hex')
  await fastify.register(cookie, {
    secret: cookieSecret,
    hook: 'onRequest',
    parseOptions: {
      httpOnly: true,
      secure: env.isProd,
      sameSite: env.isProd ? 'none' : 'lax'
    }
  })

  const corsOrigins = env.corsOrigin.split(',').map(o => o.trim())
  await fastify.register(cors, {
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-CSRF-Token',
      'X-Request-Id',
      'X-Media-Type',
      'X-Filename',
      'X-Duration-Seconds'
    ],
    exposedHeaders: [
      'X-Request-Id',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After'
    ],
    maxAge: 86400
  })

  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'DENY')
    reply.header('X-XSS-Protection', '1; mode=block')
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()')

    if (env.isProd) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }

    reply.header('Cache-Control', 'no-store')
  })

  // Register health BEFORE the auth hook so load-balancers never get 401 (#2)
  await fastify.register(healthRoutes)

  fastify.addHook('onRequest', authenticateRequest)

  const CSRF_EXEMPT_PREFIXES = ['/api/auth/login', '/api/auth/register', '/api/auth/password/forgot', '/api/auth/password/reset', '/api/auth/refresh']

  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const isExempt = CSRF_EXEMPT_PREFIXES.some(p => request.url.startsWith(p))

      if (request.user && !isExempt && !validateCsrf(request)) {
        reply.code(403).send({
          success: false,
          error: { code: 'CSRF_ERROR', message: 'Invalid CSRF token' }
        })
        return
      }
    }
  })

  fastify.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
    request.log.info({
      method: request.method,
      url: request.url,
      ip: request.ip,
      userAgent: request.headers['user-agent']
    }, 'Incoming request')
  })

  fastify.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const responseTime = reply.elapsedTime
    request.log.info({
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      responseTime
    }, 'Request completed')
  })

  fastify.addHook('onError', async (request: FastifyRequest, _reply: FastifyReply, error: Error) => {
    request.log.error({
      error: error.message,
      stack: error.stack,
      method: request.method,
      url: request.url
    }, 'Request error')
  })

  const ALLOWED_CONTENT_TYPES = [
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    'application/octet-stream'
  ]

  // Dedicated JSON parser with a strict 1MB limit to prevent event-loop blocking
  fastify.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 1048576 }, (request: FastifyRequest, body: string, done: (err: Error | null, body?: unknown) => void) => {
    try {
      done(null, JSON.parse(body))
    } catch {
      const err = new Error('Invalid JSON body') as Error & { statusCode: number }
      err.statusCode = 400
      done(err)
    }
  })

  // Catch-all parser for binary media and form data (respects global 100MB limit from maxBodySize)
  fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (request: FastifyRequest, body: Buffer, done: (err: Error | null, body?: unknown) => void) => {
    const contentType = request.headers['content-type']?.split(';')[0]?.trim() || ''
    const isBinaryMedia = /^(image|video|application)\//.test(contentType)

    if (!ALLOWED_CONTENT_TYPES.includes(contentType) && !isBinaryMedia) {
      const err = new Error(`Unsupported content type: ${contentType}`) as Error & { statusCode: number }
      err.statusCode = 415
      done(err)
      return
    }

    // Form-encoded bodies: parse key=value pairs into a plain object (#E)
    if (contentType === 'application/x-www-form-urlencoded') {
      try {
        const params = new URLSearchParams(body.toString('utf-8'))
        const obj: Record<string, string> = {}
        params.forEach((value, key) => { obj[key] = value })
        done(null, obj)
      } catch {
        const err = new Error('Invalid form body') as Error & { statusCode: number }
        err.statusCode = 400
        done(err)
      }
      return
    }

    // Pass raw Buffer for media uploads
    done(null, body)
  })

  await fastify.register(authRoutes, { prefix: '/api/auth' })
  await fastify.register(conversationRoutes, { prefix: '/api/conversations' })
  await fastify.register(messageRoutes, { prefix: '/api/messages' })
  await fastify.register(reactionRoutes, { prefix: '/api/messages' })
  await fastify.register(mediaRoutes, { prefix: '/api/media' })
  await fastify.register(adminUserRoutes, { prefix: '/api/admin' })
  await fastify.register(adminAdminRoutes, { prefix: '/api/admin' })
  await fastify.register(preferencesRoutes, { prefix: '/api/preferences' })
  await fastify.register(announcementRoutes, { prefix: '/api/announcements' })
  await fastify.register(statsRoutes, { prefix: '/api/admin/stats' })
  await fastify.register(configRoutes, { prefix: '/api/config' })
  await fastify.register(internalRoutes, { prefix: '/api/admin/internal' })
  await fastify.register(adminDMRoutes, { prefix: '/api/admin' })
  await fastify.register(searchRoutes, { prefix: '/api/admin' })
  // healthRoutes registered earlier (before auth hook)

  fastify.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    reply.code(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Route not found' }
    })
  })

  fastify.setErrorHandler((error: Error, request: FastifyRequest, reply: FastifyReply) => {
    if (error.name === 'FastifyError') {
      const statusCode = (error as unknown as { statusCode?: number }).statusCode || 500
      reply.code(statusCode).send({
        success: false,
        error: { code: 'REQUEST_ERROR', message: error.message }
      })
      return
    }

    request.log.error({ error: error.message, stack: error.stack }, 'Unhandled error')
    reply.code(500).send({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error'
      }
    })
  })

  return fastify
}

export async function startServer(): Promise<FastifyInstance> {
  const config = getConfig()
  const statsLogIntervalMs = config.server?.statsLogIntervalMs ?? 60000

  initServerState()

  // Ensure DB is up and PRAGMAs are applied before any request is served
  await initDb()

  const fastify = await buildApp()

  const address = await fastify.listen({ port: env.port, host: env.host })
  logger.info({ address, env: env.nodeEnv }, 'Server started')

  const httpServer = fastify.server
  initSocket(httpServer)

  mediaCleanupService.start()

  const sessionCleanupInterval = setInterval(async () => {
    try {
      const result = await cleanupExpiredSessions()
      if (result.cleaned > 0) {
        logger.info({ cleaned: result.cleaned }, 'Expired sessions cleaned')
      }
    } catch (error) {
      logger.error({ error }, 'Session cleanup failed')
    }
  }, config.presence.sessionDbCleanupIntervalMs)

  let statsInterval: NodeJS.Timeout | undefined

  statsInterval = setInterval(() => {
    const stats = serverState.getStats()
    const memUsage = process.memoryUsage()

    logger.debug({
      stats,
      memory: {
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
        rss: Math.round(memUsage.rss / 1024 / 1024)
      }
    }, 'Server stats')
  }, statsLogIntervalMs)

  const gracefulShutdown = async (signal: string) => {
    logger.info({ signal }, 'Starting graceful shutdown')

    const shutdownTimeoutMs = config.server?.shutdownTimeoutMs ?? 10000
    const shutdownTimeout = setTimeout(() => {
      logger.warn('Forcing shutdown after timeout')
      process.exit(1)
    }, shutdownTimeoutMs)

    try {
      mediaCleanupService.stop()
      clearInterval(sessionCleanupInterval)
      if (statsInterval) clearInterval(statsInterval)
      stopStreamRateLimitCleanup()
      stopRateLimitCleanup()
      await drainEmailQueue(3000)
      shutdownServerState()

      await closeIO()

      await fastify.close()
      await closeDb()

      clearTimeout(shutdownTimeout)
      logger.info('Graceful shutdown complete')
      process.exit(0)
    } catch (error) {
      logger.error({ error }, 'Error during shutdown')
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
  process.on('SIGINT', () => gracefulShutdown('SIGINT'))

  process.on('uncaughtException', (error) => {
    logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception')
    gracefulShutdown('uncaughtException')
  })

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled rejection')
    gracefulShutdown('unhandledRejection')
  })

  return fastify
}
