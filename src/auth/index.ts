import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { eq, and, isNull, desc, gt, ne } from 'drizzle-orm'
import { ulid } from 'ulid'
import { hash, verify } from '@node-rs/argon2'
import { randomBytes } from 'crypto'
import { db } from '../db/index.js'
import { users, sessions, auditLogs, passwordResetTokens, refreshTokens } from '../db/schema.js'
import { normalizeEmail, extractDeviceInfo, hashEmail, hashResetToken, safeJsonParse, isValidId, sanitizeName } from '../lib/utils.js'
import { getConfig } from '../lib/config.js'
import { passwordSchema } from '../lib/passwordPolicy.js'
import {
  requireApprovedUser,
  requireUser,
  sendError,
  sendOk,
  issueAuthCookies,
  clearAuthCookies,
  signToken,
  signRefreshToken,
  createRefreshToken,
  hashRefreshToken
} from '../middleware/auth.js'
import { checkLoginLockout, recordLoginAttempt, createRateLimiters } from '../middleware/rateLimit.js'
import { addUserToCache, getUserFromCache } from '../state.js'
import { sendEmail } from '../services/email.js'
import { emitToAdmins, forceLogout, forceLogoutSession } from '../socket/index.js'
import { logger } from '../lib/logger.js'

const DUMMY_HASH = '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

interface LoginResult {
  success: true
  user: typeof users.$inferSelect
}

interface LoginError {
  success: false
  code: string
  message: string
  httpStatus: number
}

async function validateLoginCredentials(
  email: string,
  password: string,
  requestIp: string
): Promise<LoginResult | LoginError> {
  const emailHash = hashEmail(email)
  const user = await db.query.users.findFirst({
    where: eq(users.email, email)
  })

  if (!user) {
    await verify(DUMMY_HASH, password)
    recordLoginAttempt(requestIp, false)
    await db.insert(auditLogs).values({
      id: ulid(),
      ipAddress: requestIp,
      action: 'auth.login_failed',
      entityType: 'email',
      entityId: emailHash,
      details: JSON.stringify({ reason: 'invalid_credentials', emailHash })
    })
    return { success: false, code: 'UNAUTHORIZED', message: 'Invalid credentials', httpStatus: 401 }
  }

  const passwordValid = await verify(user.passwordHash, password)
  if (!passwordValid) {
    recordLoginAttempt(requestIp, false)
    await db.insert(auditLogs).values({
      id: ulid(),
      userId: user.id,
      ipAddress: requestIp,
      action: 'auth.login_failed',
      entityType: 'user',
      entityId: user.id,
      details: JSON.stringify({ reason: 'invalid_credentials', emailHash })
    })
    return { success: false, code: 'UNAUTHORIZED', message: 'Invalid credentials', httpStatus: 401 }
  }

  if (user.status !== 'APPROVED') {
    await db.insert(auditLogs).values({
      id: ulid(),
      userId: user.id,
      ipAddress: requestIp,
      action: 'auth.login_forbidden',
      entityType: 'user',
      entityId: user.id,
      details: JSON.stringify({ status: user.status, emailHash })
    })
    const message = user.status === 'REJECTED'
      ? `Account rejected: ${user.rejectionReason || 'No reason provided'}`
      : user.status === 'SUSPENDED'
        ? 'Account suspended'
        : 'Account pending approval'
    return { success: false, code: 'FORBIDDEN', message, httpStatus: 403 }
  }

  return { success: true, user }
}

async function evictOldestSession(
  userId: string,
  maxDevices: number,
  requestIp: string
): Promise<void> {
  const now = new Date()
  const activeSessions = await db.query.sessions.findMany({
    where: and(
      eq(sessions.userId, userId),
      isNull(sessions.revokedAt),
      gt(sessions.expiresAt, now)
    ),
    orderBy: [sessions.priority, sessions.createdAt],
    limit: maxDevices + 1,
    columns: { id: true, priority: true }
  })

  if (activeSessions.length >= maxDevices) {
    const sessionToRevoke = activeSessions[0]
    if (sessionToRevoke) {
      await db.transaction(async (tx) => {
        await tx.update(sessions)
          .set({ revokedAt: now })
          .where(eq(sessions.id, sessionToRevoke.id))

        await tx.update(refreshTokens)
          .set({ revokedAt: now, lastUsedAt: now })
          .where(and(
            eq(refreshTokens.sessionId, sessionToRevoke.id),
            isNull(refreshTokens.revokedAt)
          ))

        await tx.insert(auditLogs).values({
          id: ulid(),
          userId,
          ipAddress: requestIp,
          action: 'session.evicted',
          entityType: 'session',
          entityId: sessionToRevoke.id,
          details: JSON.stringify({
            reason: 'max_devices',
            maxDevices,
            evictedPriority: sessionToRevoke.priority
          })
        })
      })

      forceLogoutSession(sessionToRevoke.id, 'Session evicted (max devices)')
    }
  }
}

async function createLoginSession(
  user: typeof users.$inferSelect,
  requestIp: string,
  deviceInfo: string,
  sessionPriority: number
): Promise<{ sessionId: string; expiresAt: Date; emailHash: string }> {
  const config = getConfig()
  const now = new Date()
  const sessionId = ulid()
  const expiresAt = new Date(Date.now() + config.session.accessTokenDays * 24 * 60 * 60 * 1000)
  const emailHash = hashEmail(user.email)

  await db.transaction(async (tx) => {
    await tx.insert(sessions).values({
      id: sessionId,
      userId: user.id,
      deviceInfo,
      ipAddress: requestIp,
      priority: Math.min(sessionPriority, 10),
      expiresAt
    })

    await tx.insert(auditLogs).values({
      id: ulid(),
      userId: user.id,
      ipAddress: requestIp,
      action: 'session.login',
      entityType: 'session',
      entityId: sessionId,
      details: JSON.stringify({ emailHash })
    })

    await tx.update(users)
      .set({ lastSeenAt: now })
      .where(eq(users.id, user.id))
  })

  return { sessionId, expiresAt, emailHash }
}

const registerSchema = z.object({
  email: z.string().email().max(255),
  password: passwordSchema,
  name: z.string().min(2).max(100).transform(s => sanitizeName(s)),
  phone: z.string().max(20).optional()
})

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(100)
})

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(100),
  newPassword: passwordSchema
})

const passwordResetRequestSchema = z.object({
  email: z.string().email().max(255)
})

const passwordResetSchema = z.object({
  token: z.string().min(1),
  newPassword: passwordSchema
})

function calculateSessionPriority(deviceInfo: string, ipAddress: string): number {
  try {
    const device = JSON.parse(deviceInfo)
    let priority = 1

    const userAgent = device.userAgent || ''
    if (userAgent.includes('Chrome') || userAgent.includes('Firefox') || userAgent.includes('Safari')) {
      priority += 2
    }

    if (userAgent.includes('Mobile') || userAgent.includes('Android') || userAgent.includes('iPhone')) {
      priority += 1
    }

    if (ipAddress === '127.0.0.1' || ipAddress.startsWith('192.168.') || ipAddress.startsWith('10.') || ipAddress.startsWith('172.')) {
      priority += 1
    }

    return Math.min(priority, 5)
  } catch (error) {
    logger.debug({ error }, 'Failed to parse device info for session priority')
    return 1
  }
}

export async function authRoutes(fastify: FastifyInstance) {
  const rateLimiters = createRateLimiters()

  fastify.post('/register', { preHandler: rateLimiters.registration }, async (request, reply) => {
    const config = getConfig()
    if (!config.features.userRegistration) {
      return sendError(reply, 403, 'FORBIDDEN', 'Registration is disabled')
    }

    const body = registerSchema.safeParse(request.body)
    if (!body.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid input', body.error.issues)
    }

    const email = normalizeEmail(body.data.email)
    const existing = await db.query.users.findFirst({
      where: eq(users.email, email),
      columns: { id: true }
    })

    if (existing) {
      return sendError(reply, 409, 'CONFLICT', 'Email already exists')
    }

    const userId = ulid()
    const passwordHash = await hash(body.data.password)

    try {
      await db.transaction(async (tx) => {
        await tx.insert(users).values({
          id: userId,
          email,
          passwordHash,
          name: body.data.name,
          phone: body.data.phone || null,
          role: 'USER',
          status: 'PENDING',
          mediaPermission: false,
          emailNotifyOnMessage: true
        })

        await tx.insert(auditLogs).values({
          id: ulid(),
          userId,
          ipAddress: request.ip,
          action: 'user.register',
          entityType: 'user',
          entityId: userId,
          details: JSON.stringify({ emailHash: hashEmail(email) })
        })
      })

      addUserToCache(userId, {
        role: 'USER',
        status: 'PENDING',
        name: body.data.name,
        mediaPermission: false,
        emailNotifyOnMessage: true
      })

      emitToAdmins('admin:user_registered', {
        user: {
          id: userId,
          email,
          name: body.data.name,
          status: 'PENDING',
          createdAt: Date.now()
        }
      })

      reply.code(201)
      return sendOk(reply, {
        message: 'Registration successful. Your account is pending approval.',
        user: {
          id: userId,
          email,
          name: body.data.name,
          status: 'PENDING'
        }
      })
    } catch (error) {
      logger.error({ emailHash: hashEmail(email), error }, 'Registration failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Registration failed')
    }
  })

  fastify.post('/login', { preHandler: rateLimiters.login }, async (request, reply) => {
    const lockout = checkLoginLockout(request.ip)
    if (lockout.locked) {
      reply.header('Retry-After', lockout.retryAfter!.toString())
      await db.insert(auditLogs).values({
        id: ulid(),
        ipAddress: request.ip,
        action: 'auth.login_locked',
        entityType: 'ip',
        entityId: request.ip,
        details: JSON.stringify({ retryAfter: lockout.retryAfter })
      })
      return sendError(reply, 429, 'RATE_LIMITED', 'Too many failed attempts', {
        retryAfter: lockout.retryAfter
      })
    }

    const body = loginSchema.safeParse(request.body)
    if (!body.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid input', body.error.issues)
    }

    const email = normalizeEmail(body.data.email)
    const result = await validateLoginCredentials(email, body.data.password, request.ip)

    if (!result.success) {
      return sendError(reply, result.httpStatus, result.code, result.message)
    }

    const user = result.user
    recordLoginAttempt(request.ip, true)

    const config = getConfig()
    await evictOldestSession(user.id, config.session.maxDevices, request.ip)

    const deviceInfo = extractDeviceInfo(request)
    let sessionPriority = calculateSessionPriority(deviceInfo, request.ip)

    if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') {
      sessionPriority += 3
    }

    const { sessionId, expiresAt } = await createLoginSession(user, request.ip, deviceInfo, sessionPriority)

    const token = signToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      sessionId
    })

    const refreshToken = await createRefreshToken(
      user.id,
      sessionId,
      request.ip,
      deviceInfo
    )

    // Issue cookies *after* refresh token generation to set both
    const cookies = issueAuthCookies(reply, token, refreshToken)

    addUserToCache(user.id, {
      role: user.role,
      status: user.status,
      name: user.name,
      mediaPermission: user.mediaPermission ?? false,
      emailNotifyOnMessage: user.emailNotifyOnMessage ?? true
    })

    return sendOk(reply, {
      token,
      csrfToken: cookies.csrfToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status,
        mediaPermission: user.mediaPermission,
        emailNotifyOnMessage: user.emailNotifyOnMessage
      },
      session: {
        id: sessionId,
        expiresAt: expiresAt.getTime()
      }
    })
  })

  fastify.post('/password/forgot', { preHandler: rateLimiters.passwordReset }, async (request, reply) => {
    const body = passwordResetRequestSchema.safeParse(request.body)
    if (!body.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid input', body.error.issues)
    }

    const email = normalizeEmail(body.data.email)
    const emailHash = hashEmail(email)
    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
      columns: { id: true, email: true }
    })

    if (user) {
      const config = getConfig()
      const rawToken = randomBytes(32).toString('hex')
      const tokenHash = hashResetToken(rawToken)
      const expiresAt = new Date(Date.now() + config.session.passwordResetTokenMinutes * 60 * 1000)

      await db.transaction(async (tx) => {
        await tx.delete(passwordResetTokens)
          .where(and(
            eq(passwordResetTokens.userId, user.id),
            isNull(passwordResetTokens.usedAt)
          ))

        await tx.insert(passwordResetTokens).values({
          id: ulid(),
          userId: user.id,
          tokenHash,
          ipAddress: request.ip,
          expiresAt
        })

        await tx.insert(auditLogs).values({
          id: ulid(),
          userId: user.id,
          ipAddress: request.ip,
          action: 'user.password_reset_request',
          entityType: 'user',
          entityId: user.id
        })
      })

      try {
        await sendEmail({ type: 'passwordReset', userId: user.id, resetToken: rawToken })
      } catch (error) {
        logger.warn({ userId: user.id, error }, 'Failed to send reset email')
      }
    } else {
      await db.insert(auditLogs).values({
        id: ulid(),
        ipAddress: request.ip,
        action: 'auth.password_reset_request_unknown',
        entityType: 'email',
        entityId: emailHash,
        details: JSON.stringify({ emailHash })
      })
    }

    return sendOk(reply, { message: 'If an account exists, a reset link has been sent.' })
  })

  fastify.post('/password/reset', { preHandler: rateLimiters.passwordReset }, async (request, reply) => {
    const body = passwordResetSchema.safeParse(request.body)
    if (!body.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid input', body.error.issues)
    }

    const tokenHash = hashResetToken(body.data.token)
    const now = new Date()

    const tokenRecord = await db.query.passwordResetTokens.findFirst({
      where: and(
        eq(passwordResetTokens.tokenHash, tokenHash),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, now)
      ),
      columns: { id: true, userId: true }
    })

    if (!tokenRecord) {
      await db.insert(auditLogs).values({
        id: ulid(),
        ipAddress: request.ip,
        action: 'auth.password_reset_failed',
        entityType: 'token',
        entityId: tokenHash.substring(0, 16),
        details: JSON.stringify({ reason: 'invalid_or_expired' })
      })
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid or expired reset token')
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, tokenRecord.userId),
      columns: { id: true, email: true }
    })

    if (!user) {
      return sendError(reply, 404, 'NOT_FOUND', 'User not found')
    }

    const newHash = await hash(body.data.newPassword)

    await db.transaction(async (tx) => {
      await tx.update(users)
        .set({ passwordHash: newHash, updatedAt: now })
        .where(eq(users.id, user.id))

      await tx.update(passwordResetTokens)
        .set({ usedAt: now })
        .where(eq(passwordResetTokens.id, tokenRecord.id))

      await tx.update(sessions)
        .set({ revokedAt: now })
        .where(and(
          eq(sessions.userId, user.id),
          isNull(sessions.revokedAt)
        ))

      await tx.update(refreshTokens)
        .set({ revokedAt: now, lastUsedAt: now })
        .where(and(
          eq(refreshTokens.userId, user.id),
          isNull(refreshTokens.revokedAt)
        ))

      await tx.insert(auditLogs).values({
        id: ulid(),
        userId: user.id,
        ipAddress: request.ip,
        action: 'user.password_reset',
        entityType: 'user',
        entityId: user.id,
        details: JSON.stringify({ tokenId: tokenRecord.id })
      })
    })

    forceLogout(user.id, 'Password reset')

    return sendOk(reply, { message: 'Password reset successful' })
  })

  fastify.post('/logout', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const now = new Date()
    await db.transaction(async (tx) => {
      await tx.update(sessions)
        .set({ revokedAt: now })
        .where(eq(sessions.id, user.sessionId))

      await tx.update(refreshTokens)
        .set({ revokedAt: now })
        .where(and(
          eq(refreshTokens.sessionId, user.sessionId),
          isNull(refreshTokens.revokedAt)
        ))

      await tx.insert(auditLogs).values({
        id: ulid(),
        userId: user.id,
        ipAddress: request.ip,
        action: 'session.logout',
        entityType: 'session',
        entityId: user.sessionId
      })
    })

    forceLogoutSession(user.sessionId, 'Logged out')

    clearAuthCookies(reply)
    return sendOk(reply, { message: 'Logged out successfully' })
  })

  fastify.get('/me', { preHandler: requireApprovedUser }, async (request, reply) => {
    const authUser = requireUser(request, reply)
    if (!authUser) return

    const csrfToken = request.cookies['_csrf']

    const cached = getUserFromCache(authUser.id)
    if (cached) {
      return sendOk(reply, {
        csrfToken,
        user: {
          id: authUser.id,
          email: authUser.email,
          name: cached.name,
          role: authUser.role,
          status: authUser.status,
          mediaPermission: cached.mediaPermission,
          emailNotifyOnMessage: cached.emailNotifyOnMessage
        }
      })
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, authUser.id),
      columns: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        mediaPermission: true,
        emailNotifyOnMessage: true,
        createdAt: true
      }
    })

    if (!user) {
      return sendError(reply, 404, 'NOT_FOUND', 'User not found')
    }

    return sendOk(reply, { csrfToken, user })
  })

  fastify.get('/sessions', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const now = new Date()
    const userSessions = await db.query.sessions.findMany({
      where: and(
        eq(sessions.userId, user.id),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now)
      ),
      orderBy: [desc(sessions.createdAt)],
      columns: { id: true, deviceInfo: true, ipAddress: true, createdAt: true, lastActiveAt: true }
    })

    return sendOk(reply, {
      sessions: userSessions.map(s => ({
        id: s.id,
        deviceInfo: safeJsonParse(s.deviceInfo),
        ipAddress: s.ipAddress,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
        isCurrent: s.id === user.sessionId
      }))
    })
  })

  fastify.delete('/sessions/:sessionId', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { sessionId } = request.params as { sessionId: string }

    if (!isValidId(sessionId)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid session ID')
    }

    const now = new Date()
    const session = await db.query.sessions.findFirst({
      where: and(
        eq(sessions.id, sessionId),
        eq(sessions.userId, user.id),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now)
      ),
      columns: { id: true }
    })

    if (!session) {
      return sendError(reply, 404, 'NOT_FOUND', 'Session not found')
    }

    const revokeNow = new Date()
    await db.transaction(async (tx) => {
      await tx.update(sessions)
        .set({ revokedAt: revokeNow })
        .where(eq(sessions.id, sessionId))

      await tx.update(refreshTokens)
        .set({ revokedAt: revokeNow })
        .where(and(
          eq(refreshTokens.sessionId, sessionId),
          isNull(refreshTokens.revokedAt)
        ))

      await tx.insert(auditLogs).values({
        id: ulid(),
        userId: user.id,
        ipAddress: request.ip,
        action: 'session.revoke',
        entityType: 'session',
        entityId: sessionId,
        details: JSON.stringify({ reason: 'user_revoked' })
      })
    })

    forceLogoutSession(sessionId, 'Session revoked')

    return sendOk(reply, { message: 'Session revoked' })
  })

  fastify.post('/sessions/revoke-all', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const revokeNow = new Date()

    // Fetch all other active sessions to force-logout individually
    const otherSessions = await db.query.sessions.findMany({
      where: and(
        eq(sessions.userId, user.id),
        isNull(sessions.revokedAt),
        // Exclude the current session using type-safe ne() operator
        ...(user.sessionId ? [ne(sessions.id, user.sessionId)] : [])
      ),
      columns: { id: true }
    })

    await db.transaction(async (tx) => {
      // Revoke all sessions EXCEPT the current one — ne() is safer than raw sql (#8)
      await tx.update(sessions)
        .set({ revokedAt: revokeNow })
        .where(and(
          eq(sessions.userId, user.id),
          isNull(sessions.revokedAt),
          ne(sessions.id, user.sessionId!)
        ))

      await tx.update(refreshTokens)
        .set({ revokedAt: revokeNow })
        .where(and(
          eq(refreshTokens.userId, user.id),
          isNull(refreshTokens.revokedAt),
          ne(refreshTokens.sessionId, user.sessionId!)
        ))

      await tx.insert(auditLogs).values({
        id: ulid(),
        userId: user.id,
        ipAddress: request.ip,
        action: 'session.revoke_all',
        entityType: 'user',
        entityId: user.id,
        details: JSON.stringify({ excludedSessionId: user.sessionId, revokedCount: otherSessions.length })
      })
    })

    // Force-logout each revoked session individually
    for (const session of otherSessions) {
      forceLogoutSession(session.id, 'All other sessions revoked')
    }

    return sendOk(reply, { message: 'All other sessions revoked', revokedCount: otherSessions.length })
  })

  fastify.post('/password/change', {
    preHandler: [requireApprovedUser, rateLimiters.passwordChange]
  }, async (request, reply) => {
    const authUser = requireUser(request, reply)
    if (!authUser) return

    const body = passwordChangeSchema.safeParse(request.body)
    if (!body.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid input', body.error.issues)
    }

    if (body.data.currentPassword === body.data.newPassword) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'New password must be different')
    }

    const dbUser = await db.query.users.findFirst({
      where: eq(users.id, authUser.id),
      columns: { id: true, passwordHash: true, email: true, name: true, role: true, status: true }
    })

    if (!dbUser) {
      return sendError(reply, 404, 'NOT_FOUND', 'User not found')
    }

    const valid = await verify(dbUser.passwordHash, body.data.currentPassword)
    if (!valid) {
      await db.insert(auditLogs).values({
        id: ulid(),
        userId: dbUser.id,
        ipAddress: request.ip,
        action: 'auth.password_change_failed',
        entityType: 'user',
        entityId: dbUser.id,
        details: JSON.stringify({ reason: 'invalid_current_password' })
      })
      return sendError(reply, 401, 'UNAUTHORIZED', 'Invalid current password')
    }

    const newHash = await hash(body.data.newPassword)
    const now = new Date()
    const config = getConfig()
    const deviceInfo = extractDeviceInfo(request)
    const sessionPriority = calculateSessionPriority(deviceInfo, request.ip)

    // Collect old session IDs before the transaction so we can force-logout them below
    const oldSessions = await db.query.sessions.findMany({
      where: and(eq(sessions.userId, dbUser.id), isNull(sessions.revokedAt)),
      columns: { id: true }
    })

    // Revoke all existing sessions + refresh tokens in one transaction
    await db.transaction(async (tx) => {
      await tx.update(users)
        .set({ passwordHash: newHash, updatedAt: now })
        .where(eq(users.id, dbUser.id))

      await tx.update(sessions)
        .set({ revokedAt: now })
        .where(and(
          eq(sessions.userId, dbUser.id),
          isNull(sessions.revokedAt)
        ))

      await tx.update(refreshTokens)
        .set({ revokedAt: now, lastUsedAt: now })
        .where(and(
          eq(refreshTokens.userId, dbUser.id),
          isNull(refreshTokens.revokedAt)
        ))

      await tx.insert(auditLogs).values({
        id: ulid(),
        userId: dbUser.id,
        ipAddress: request.ip,
        action: 'user.password_change',
        entityType: 'user',
        entityId: dbUser.id
      })
    })

    // Force-logout only OLD sessions — NOT the brand-new session we are about to create (#4)
    for (const s of oldSessions) {
      forceLogoutSession(s.id, 'Password changed')
    }

    // Create new session using the canonical helper — ensures priority, audit log, lastSeenAt (#C)
    const { sessionId: newSessionId, expiresAt } = await createLoginSession(
      dbUser as typeof import('../db/schema.js').users.$inferSelect,
      request.ip,
      deviceInfo,
      sessionPriority
    )

    const token = signToken({
      sub: dbUser.id,
      email: dbUser.email,
      role: dbUser.role,
      status: dbUser.status,
      sessionId: newSessionId
    })

    const newRefreshToken = await createRefreshToken(
      dbUser.id,
      newSessionId,
      request.ip,
      deviceInfo
    )

    const { csrfToken } = issueAuthCookies(reply, token, newRefreshToken)

    return sendOk(reply, {
      message: 'Password updated',
      token,
      csrfToken,
    })
  })

  const refreshTokenSchema = z.object({
    refreshToken: z.string().min(1).max(200)
  })

  fastify.post('/refresh', { preHandler: rateLimiters.api }, async (request, reply) => {
    // Attempt to extract refresh token from HttpOnly cookie first, fallback to body for backwards compat
    const bodyResult = refreshTokenSchema.safeParse(request.body || {})
    const cookieToken = request.cookies.refresh_token
    const rawToken = cookieToken || (bodyResult.success ? bodyResult.data.refreshToken : null)

    if (!rawToken) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Refresh token is required')
    }

    try {
      const now = new Date()
      const config = getConfig()

      const presentedTokenHash = hashRefreshToken(rawToken)

      const refreshTokenRecord = await db.query.refreshTokens.findFirst({
        where: and(
          eq(refreshTokens.tokenHash, presentedTokenHash),
          isNull(refreshTokens.revokedAt),
          gt(refreshTokens.expiresAt, now)
        ),
        columns: { userId: true, sessionId: true }
      })

      if (!refreshTokenRecord) {
        return sendError(reply, 401, 'UNAUTHORIZED', 'Invalid refresh token')
      }

      const userId = refreshTokenRecord.userId
      const sessionId = refreshTokenRecord.sessionId

      const session = await db.query.sessions.findFirst({
        where: and(
          eq(sessions.id, sessionId),
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now)
        ),
        columns: { id: true }
      })

      if (!session) {
        return sendError(reply, 401, 'UNAUTHORIZED', 'Session expired or revoked')
      }

      const user = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { id: true, email: true, name: true, role: true, status: true, mediaPermission: true, emailNotifyOnMessage: true }
      })

      if (!user || user.status !== 'APPROVED') {
        return sendError(reply, 403, 'FORBIDDEN', 'Account not approved')
      }

      const newToken = signToken({
        sub: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
        sessionId
      })

      const newRefreshToken = signRefreshToken()
      const newRefreshTokenHash = hashRefreshToken(newRefreshToken)
      const refreshExpiresAt = new Date(now.getTime() + config.session.refreshTokenDays * 24 * 60 * 60 * 1000)

      let revokeRowsAffected = 0
      await db.transaction(async (tx) => {
        const revokeResult = await tx.update(refreshTokens)
          .set({ revokedAt: now, lastUsedAt: now })
          .where(and(
            eq(refreshTokens.tokenHash, presentedTokenHash),
            eq(refreshTokens.userId, userId),
            isNull(refreshTokens.revokedAt)
          ))
        revokeRowsAffected = revokeResult.rowsAffected ?? 0

        // Only proceed if WE were the one to revoke this token.
        // If rowsAffected === 0, a concurrent request already consumed it — abort.
        if (revokeRowsAffected === 0) return

        await tx.insert(refreshTokens).values({
          id: ulid(),
          userId: user.id,
          sessionId,
          tokenHash: newRefreshTokenHash,
          deviceInfo: extractDeviceInfo(request),
          ipAddress: request.ip,
          lastUsedAt: now,
          expiresAt: refreshExpiresAt
        })

        await tx.update(sessions)
          .set({ lastActiveAt: now })
          .where(eq(sessions.id, sessionId))

        await tx.insert(auditLogs).values({
          id: ulid(),
          userId: user.id,
          ipAddress: request.ip,
          action: 'auth.token_refresh',
          entityType: 'session',
          entityId: sessionId
        })
      })

      if (revokeRowsAffected === 0) {
        // Token was already consumed — possible replay attack or race
        logger.warn({ userId, sessionId }, 'Refresh token already consumed — possible replay attack')
        return sendError(reply, 401, 'UNAUTHORIZED', 'Refresh token already used')
      }

      const cookies = issueAuthCookies(reply, newToken, newRefreshToken)
      return sendOk(reply, {
        token: newToken,
        csrfToken: cookies.csrfToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          status: user.status,
          mediaPermission: user.mediaPermission,
          emailNotifyOnMessage: user.emailNotifyOnMessage
        }
      })
    } catch (error) {
      logger.warn({ error }, 'Token refresh failed')
      return sendError(reply, 401, 'UNAUTHORIZED', 'Invalid refresh token')
    }
  })
}