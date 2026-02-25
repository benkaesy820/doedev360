import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ulid } from 'ulid'
import { getConfig, getBrand, updateBrand, brandSchema, atomicWriteConfig } from '../lib/config.js'
import { db } from '../db/index.js'
import { auditLogs } from '../db/schema.js'
import { requireSuperAdmin, sendError } from '../middleware/auth.js'
import { createRateLimiters } from '../middleware/rateLimit.js'
import { logger } from '../lib/logger.js'
import { getIO } from '../socket/index.js'

const subsidiarySchema = z.object({
  id: z.string().min(1).max(26),
  name: z.string().min(1).max(100),
  description: z.string().max(300).optional(),
  url: z.string().url().optional().or(z.literal('')),
  industry: z.string().max(60).optional(),
  founded: z.string().max(10).optional(),
})

const featuresSchema = z.object({
  userRegistration: z.boolean(),
  mediaUpload: z.boolean(),
  messageDelete: z.boolean(),
  messageDeleteTimeLimit: z.number().positive(),
})

const limitsSchema = z.object({
  message: z.object({
    textMaxLength: z.number().int().positive().max(10000),
    teamTextMaxLength: z.number().int().positive().max(10000).optional(),
    perMinute: z.number().int().positive().optional(),
    perHour: z.number().int().positive().optional(),
  }).optional(),
  media: z.object({
    maxSizeImage: z.number().positive(),
    maxSizeVideo: z.number().positive(),
    maxSizeDocument: z.number().positive(),
    perDay: z.number().int().positive().optional(),
  }).optional(),
})

const securitySchema = z.object({
  rateLimit: z.object({
    login: z.object({
      maxAttempts: z.number().int().positive(),
      windowMinutes: z.number().int().positive(),
      lockoutMinutes: z.number().int().positive(),
    }).optional(),
    api: z.object({
      requestsPerMinute: z.number().int().positive(),
    }).optional(),
  }).optional(),
  session: z.object({
    maxDevices: z.number().int().positive(),
    accessTokenDays: z.number().int().positive(),
  }).optional(),
  allowedMimeTypes: z.object({
    image: z.array(z.string()),
    video: z.array(z.string()),
    document: z.array(z.string()),
  }).optional(),
})

export async function configRoutes(fastify: FastifyInstance) {
  const rateLimiters = createRateLimiters()

  fastify.get('/', { preHandler: rateLimiters.api }, async (_request, reply) => {
    const config = getConfig()
    const brand = getBrand()
    return reply.send({
      success: true,
      brand,
      features: config.features,
      limits: {
        message: { textMaxLength: config.limits.message.textMaxLength, teamTextMaxLength: config.limits.message.teamTextMaxLength },
        media: {
          maxSizeImage: config.limits.media.maxSizeImage,
          maxSizeVideo: config.limits.media.maxSizeVideo,
          maxSizeDocument: config.limits.media.maxSizeDocument,
        },
      },
      allowedMimeTypes: config.allowedMimeTypes,
      subsidiaries: config.subsidiaries ?? [],
    })
  })

  fastify.patch('/brand', { preHandler: [requireSuperAdmin] }, async (request, reply) => {
    const result = brandSchema.safeParse(request.body)
    if (!result.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid brand data', result.error.issues)
    }

    try {
      await updateBrand(result.data)

      if (request.user) {
        await db.insert(auditLogs).values({
          id: ulid(),
          userId: request.user.id,
          ipAddress: request.ip,
          action: 'config.brand_update',
          entityType: 'config',
          entityId: 'brand',
          details: JSON.stringify({ siteName: result.data.siteName })
        })
      }

      logger.info({ userId: request.user?.id }, 'Brand updated')
      try { getIO().emit('cache:invalidate', { keys: ['appConfig'] }) } catch (e) { logger.error(e, 'Failed to broadcast config update') }
      return reply.send({ success: true, brand: result.data })
    } catch (error) {
      logger.error({ error }, 'Brand update failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to update brand')
    }
  })

  fastify.patch('/features', { preHandler: [requireSuperAdmin] }, async (request, reply) => {
    const result = featuresSchema.safeParse(request.body)
    if (!result.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid features data', result.error.issues)
    }
    try {
      await atomicWriteConfig((cfg) => { cfg.features = result.data })
      if (request.user) {
        await db.insert(auditLogs).values({
          id: ulid(), userId: request.user.id, ipAddress: request.ip,
          action: 'config.features_update', entityType: 'config', entityId: 'features',
          details: JSON.stringify(result.data)
        })
      }
      logger.info({ userId: request.user?.id }, 'Features updated')
      try { getIO().emit('cache:invalidate', { keys: ['appConfig'] }) } catch (e) { logger.error(e, 'Failed to broadcast config update') }
      return reply.send({ success: true, features: result.data })
    } catch (error) {
      logger.error({ error }, 'Features update failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to update features')
    }
  })

  fastify.patch('/limits', { preHandler: [requireSuperAdmin] }, async (request, reply) => {
    const result = limitsSchema.safeParse(request.body)
    if (!result.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid limits data', result.error.issues)
    }
    try {
      await atomicWriteConfig((cfg) => {
        const limits = cfg.limits as Record<string, unknown>
        if (result.data.message) {
          const existing = (limits.message as Record<string, unknown>) ?? {}
          const merged = { ...existing, ...result.data.message }
          // Ensure rate fields are both present or both absent to prevent half-config (#15)
          if ((merged.perMinute === undefined) !== (merged.perHour === undefined)) {
            throw new Error('Both perMinute and perHour must be set together')
          }
          limits.message = merged
        }
        if (result.data.media) Object.assign((limits.media as Record<string, unknown>), result.data.media)
      })
      if (request.user) {
        await db.insert(auditLogs).values({
          id: ulid(), userId: request.user.id, ipAddress: request.ip,
          action: 'config.limits_update', entityType: 'config', entityId: 'limits',
          details: JSON.stringify(result.data)
        })
      }
      logger.info({ userId: request.user?.id }, 'Limits updated')
      try { getIO().emit('cache:invalidate', { keys: ['appConfig'] }) } catch (e) { logger.error(e, 'Failed to broadcast config update') }
      return reply.send({ success: true, limits: result.data })
    } catch (error) {
      logger.error({ error }, 'Limits update failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to update limits')
    }
  })

  fastify.patch('/subsidiaries', { preHandler: [requireSuperAdmin] }, async (request, reply) => {
    const result = z.array(subsidiarySchema).safeParse(request.body)
    if (!result.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid subsidiaries data', result.error.issues)
    }
    try {
      await atomicWriteConfig((cfg) => { cfg.subsidiaries = result.data })
      if (request.user) {
        await db.insert(auditLogs).values({
          id: ulid(), userId: request.user.id, ipAddress: request.ip,
          action: 'config.subsidiaries_update', entityType: 'config', entityId: 'subsidiaries',
          details: JSON.stringify({ count: result.data.length })
        })
      }
      logger.info({ userId: request.user?.id }, 'Subsidiaries updated')
      try { getIO().emit('cache:invalidate', { keys: ['appConfig'] }) } catch (e) { logger.error(e, 'Failed to broadcast config update') }
      return reply.send({ success: true, subsidiaries: result.data })
    } catch (error) {
      logger.error({ error }, 'Subsidiaries update failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to update subsidiaries')
    }
  })

  fastify.patch('/security', { preHandler: [requireSuperAdmin] }, async (request, reply) => {
    const result = securitySchema.safeParse(request.body)
    if (!result.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid security data', result.error.issues)
    }
    try {
      await atomicWriteConfig((cfg) => {
        const data = result.data
        if (data.rateLimit?.login) Object.assign((cfg as any).rateLimit.login, data.rateLimit.login)
        if (data.rateLimit?.api) Object.assign((cfg as any).rateLimit.api, data.rateLimit.api)
        if (data.session) Object.assign((cfg as any).session, data.session)
        if (data.allowedMimeTypes) (cfg as any).allowedMimeTypes = data.allowedMimeTypes
      })
      if (request.user) {
        await db.insert(auditLogs).values({
          id: ulid(), userId: request.user.id, ipAddress: request.ip,
          action: 'config.security_update', entityType: 'config', entityId: 'security',
          details: JSON.stringify(result.data)
        })
      }
      logger.info({ userId: request.user?.id }, 'Security config updated')
      try { getIO().emit('cache:invalidate', { keys: ['appConfig'] }) } catch (e) { logger.error(e, 'Failed to broadcast config update') }
      return reply.send({ success: true })
    } catch (error) {
      logger.error({ error }, 'Security update failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to update security config')
    }
  })
}
