import type { FastifyRequest, FastifyReply } from 'fastify'
import jwt from 'jsonwebtoken'
import { randomBytes, createHash } from 'crypto'
import { ulid } from 'ulid'
import { db } from '../db/index.js'
import { users, sessions, refreshTokens } from '../db/schema.js'
import { eq, and, isNull, gt } from 'drizzle-orm'
import { env } from '../lib/env.js'
import { getConfig } from '../lib/config.js'
import {
  getUserFromCache,
  addUserToCache,
  getSessionValidationCache,
  setSessionValidationCache
} from '../state.js'
import { logger } from '../lib/logger.js'

const CSRF_HEADER = 'x-csrf-token'
const CSRF_COOKIE = '_csrf'
/** TTL for session validation cache entries */
const SESSION_VALIDATION_TTL_MS = 10000

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      id: string
      email: string
      role: 'USER' | 'ADMIN' | 'SUPER_ADMIN'
      status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED'
      sessionId: string
      mediaPermission?: boolean
    }
    requestId: string
  }
}

export type AuthenticatedUser = NonNullable<FastifyRequest['user']>

function generateRequestId(): string {
  return `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`
}

function generateCsrfToken(): string {
  return randomBytes(32).toString('hex')
}

export function signToken(payload: {
  sub: string
  email: string
  role: string
  status: string
  sessionId: string
}): string {
  return jwt.sign(
    {
      sub: payload.sub,
      email: payload.email,
      role: payload.role,
      status: payload.status,
      sid: payload.sessionId
    },
    env.jwtSecret,
    {
      expiresIn: `${env.jwtExpiryDays}d`,
      issuer: env.jwtIssuer,
      audience: env.jwtAudience,
      jwtid: generateRequestId()
    }
  )
}

export function signRefreshToken(): string {
  return randomBytes(64).toString('base64url')
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createRefreshToken(
  userId: string,
  sessionId: string,
  ipAddress: string,
  deviceInfo: string
): Promise<string> {
  const config = getConfig()

  const token = signRefreshToken()
  const tokenHash = hashRefreshToken(token)
  const expiresAt = new Date(Date.now() + config.session.refreshTokenDays * 24 * 60 * 60 * 1000)

  await db.insert(refreshTokens).values({
    id: ulid(),
    userId,
    sessionId,
    tokenHash,
    deviceInfo,
    ipAddress,
    lastUsedAt: new Date(),
    expiresAt
  })

  return token
}

interface DecodedToken {
  sub: string
  email: string
  role: 'USER' | 'ADMIN' | 'SUPER_ADMIN'
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED'
  sid: string
  iat: number
  exp: number
  iss?: string
  aud?: string
}

interface SessionWithUser {
  sessionValid: boolean
  user?: {
    id: string
    email: string
    role: 'USER' | 'ADMIN' | 'SUPER_ADMIN'
    status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED'
    name: string
    mediaPermission: boolean | null
    emailNotifyOnMessage: boolean | null
  } | undefined
}

async function validateSessionWithUser(userId: string, sessionId: string): Promise<SessionWithUser> {
  const cached = getSessionValidationCache(userId, sessionId)
  if (cached !== undefined) {
    return { sessionValid: cached }
  }

  const now = new Date()
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      role: users.role,
      status: users.status,
      name: users.name,
      mediaPermission: users.mediaPermission,
      emailNotifyOnMessage: users.emailNotifyOnMessage,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now)
      )
    )
    .limit(1)

  const row = rows[0]
  const valid = !!row
  setSessionValidationCache(userId, sessionId, valid, SESSION_VALIDATION_TTL_MS)

  if (!valid) {
    return { sessionValid: false, user: undefined }
  }

  return {
    sessionValid: true,
    user: {
      id: row.userId,
      email: row.email,
      role: row.role,
      status: row.status,
      name: row.name,
      mediaPermission: row.mediaPermission,
      emailNotifyOnMessage: row.emailNotifyOnMessage,
    }
  }
}

export async function authenticateRequest(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  request.requestId = generateRequestId()
  reply.header('x-request-id', request.requestId)

  let token = request.cookies.token
  if (!token && request.headers.authorization?.startsWith('Bearer ')) {
    token = request.headers.authorization.slice(7)
  }

  if (!token) {
    return
  }

  try {
    const decoded = jwt.verify(token, env.jwtSecret, {
      issuer: env.jwtIssuer,
      audience: env.jwtAudience
    }) as DecodedToken

    if (!decoded.sub || !decoded.sid) {
      logger.warn({ requestId: request.requestId }, 'Token missing required fields')
      return
    }

    const cachedUser = getUserFromCache(decoded.sub)
    if (cachedUser) {
      if (cachedUser.status !== decoded.status || cachedUser.role !== decoded.role) {
        logger.warn({ requestId: request.requestId, userId: decoded.sub }, 'Token stale, cache mismatch')
        clearAuthCookies(reply)
        return
      }

      const { sessionValid } = await validateSessionWithUser(decoded.sub, decoded.sid)
      if (!sessionValid) {
        logger.warn({ requestId: request.requestId, userId: decoded.sub }, 'Session invalid or revoked')
        clearAuthCookies(reply)
        return
      }

      request.user = {
        id: decoded.sub,
        email: decoded.email,
        role: decoded.role,
        status: decoded.status,
        sessionId: decoded.sid,
        mediaPermission: cachedUser.mediaPermission ?? false,
      }
      return
    }

    const { sessionValid, user } = await validateSessionWithUser(decoded.sub, decoded.sid)
    if (!sessionValid || !user) {
      logger.warn({ requestId: request.requestId, userId: decoded.sub }, 'Session invalid or user not found')
      clearAuthCookies(reply)
      return
    }

    addUserToCache(user.id, {
      role: user.role,
      status: user.status,
      name: user.name,
      mediaPermission: user.mediaPermission ?? false,
      emailNotifyOnMessage: user.emailNotifyOnMessage ?? true
    })

    request.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      sessionId: decoded.sid
    }
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      logger.debug({ requestId: request.requestId }, 'Token expired')
    } else if (err instanceof jwt.JsonWebTokenError) {
      logger.warn({ requestId: request.requestId, error: err.message }, 'Invalid token')
    } else {
      logger.error({ requestId: request.requestId, error: err }, 'Auth error')
    }
    clearAuthCookies(reply)
  }
}

/**
 * Common authentication check used by requireApprovedUser, requireAdmin, requireSuperAdmin.
 * Returns true if user is authenticated and approved, false otherwise.
 */
function checkAuthenticatedAndApproved(
  request: FastifyRequest,
  reply: FastifyReply
): boolean {
  if (!request.user) {
    sendError(reply, 401, 'UNAUTHORIZED', 'Unauthorized')
    return false
  }

  if (request.user.status !== 'APPROVED') {
    sendError(reply, 403, 'FORBIDDEN', 'Account not approved')
    return false
  }

  return true
}

function hasRequiredRole(userRole: AuthenticatedUser['role'], roles: AuthenticatedUser['role'][]): boolean {
  return roles.includes(userRole)
}

export function requireUser(request: FastifyRequest, reply: FastifyReply): AuthenticatedUser | null {
  if (!request.user) {
    sendError(reply, 401, 'UNAUTHORIZED', 'Unauthorized')
    return null
  }

  return request.user
}

export async function requireApprovedUser(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!checkAuthenticatedAndApproved(request, reply)) return
}

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!checkAuthenticatedAndApproved(request, reply)) {
    return
  }

  if (!hasRequiredRole(request.user!.role, ['ADMIN', 'SUPER_ADMIN'])) {
    sendError(reply, 403, 'FORBIDDEN', 'Admin access required')
    return
  }
}

export async function requireSuperAdmin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!checkAuthenticatedAndApproved(request, reply)) {
    return
  }

  if (!hasRequiredRole(request.user!.role, ['SUPER_ADMIN'])) {
    sendError(reply, 403, 'FORBIDDEN', 'Super admin access required')
    return
  }
}

export interface CsrfTokens {
  csrfToken: string
}

export function issueAuthCookies(reply: FastifyReply, token: string, refreshToken?: string): CsrfTokens {
  const csrfToken = generateCsrfToken()
  const isProd = env.nodeEnv === 'production'

  reply.setCookie('token', token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
    maxAge: env.jwtExpiryDays * 24 * 60 * 60
  })

  if (refreshToken) {
    const config = getConfig()
    reply.setCookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      path: '/api/auth/refresh', // only sent to the refresh endpoint
      maxAge: config.session.refreshTokenDays * 24 * 60 * 60
    })
  }

  reply.setCookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
    maxAge: env.jwtExpiryDays * 24 * 60 * 60
  })

  return { csrfToken }
}

export function validateCsrf(request: FastifyRequest): boolean {
  const csrfCookie = request.cookies[CSRF_COOKIE]
  const csrfHeader = request.headers[CSRF_HEADER] as string | undefined

  if (!csrfCookie || !csrfHeader) {
    return false
  }

  if (csrfCookie !== csrfHeader) {
    return false
  }

  return true
}

export function clearAuthCookies(reply: FastifyReply): void {
  reply.clearCookie('token', { path: '/' })
  reply.clearCookie('refresh_token', { path: '/api/auth/refresh' })
  reply.clearCookie(CSRF_COOKIE, { path: '/' })
}

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown
): FastifyReply {
  const response: {
    success: false
    error: {
      code: string
      message: string
      details?: unknown
    }
  } = {
    success: false,
    error: { code, message }
  }
  if (details !== undefined) {
    response.error.details = details
  }
  return reply.code(statusCode).send(response)
}

export function sendOk(reply: FastifyReply, data?: Record<string, unknown>): FastifyReply {
  return reply.send({ success: true, ...data })
}
