import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { and, desc, eq, isNull, like, lt, or } from 'drizzle-orm'
import { ulid, decodeTime } from 'ulid'
import { db } from '../db/index.js'
import { auditLogs, sessions, userStatusHistory, users, refreshTokens } from '../db/schema.js'
import { requireAdmin, requireUser, sendError, sendOk } from '../middleware/auth.js'
import { updateUserCache } from '../state.js'
import { sendEmail } from '../services/email.js'
import { emitToUser, forceLogout } from '../socket/index.js'
import { mediaCleanupService } from '../services/mediaCleanup.js'
import { sanitizeText, isValidId } from '../lib/utils.js'
import { logger } from '../lib/logger.js'

const statusUpdateSchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED']),
  reason: z.string().max(500).transform(s => sanitizeText(s)).optional()
})

const mediaPermissionSchema = z.object({
  mediaPermission: z.boolean()
})

const adminListSchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED']).optional(),
  search: z.string().max(255).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().optional()
})

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase().replace(/[%_]/g, '\\$&')
}

export async function adminUserRoutes(fastify: FastifyInstance) {
  fastify.get('/users', { preHandler: requireAdmin }, async (request, reply) => {
    const requestUser = requireUser(request, reply)
    if (!requestUser) return

    const query = adminListSchema.safeParse(request.query)
    if (!query.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid query', query.error.issues)
    }

    const conditions = []
    if (query.data.status) conditions.push(eq(users.status, query.data.status))
    // Always scope to regular users only — admin management is done through /admin/admins
    conditions.push(eq(users.role, 'USER'))
    if (query.data.search) {
      const search = `%${normalizeSearch(query.data.search)}%`
      conditions.push(or(like(users.email, search), like(users.name, search)))
    }
    if (query.data.before && isValidId(query.data.before)) {
      const beforeMs = decodeTime(query.data.before)
      conditions.push(lt(users.createdAt, new Date(beforeMs)))
    }

    const result = await db.query.users.findMany({
      where: conditions.length ? and(...conditions) : undefined,
      orderBy: [desc(users.createdAt)],
      limit: query.data.limit + 1,
      columns: {
        id: true,
        email: true,
        name: true,
        phone: true,
        role: true,
        status: true,
        mediaPermission: true,
        rejectionReason: true,
        createdAt: true,
        lastSeenAt: true
      }
    })

    const hasMore = result.length > query.data.limit
    const usersToReturn = hasMore ? result.slice(0, -1) : result

    return sendOk(reply, { users: usersToReturn, hasMore })
  })

  fastify.patch('/users/:userId/status', { preHandler: requireAdmin }, async (request, reply) => {
    const admin = requireUser(request, reply)
    if (!admin) {
      return
    }

    const { userId } = request.params as { userId: string }

    if (!isValidId(userId)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid user ID')
    }

    const body = statusUpdateSchema.safeParse(request.body)
    if (!body.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid input', body.error.issues)
    }

    if (userId === admin.id) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Cannot change your own status')
    }

    if ((body.data.status === 'REJECTED' || body.data.status === 'SUSPENDED') && !body.data.reason) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Reason required for rejection/suspension')
    }

    const target = await db.query.users.findFirst({
      where: eq(users.id, userId)
    })

    if (!target) {
      return sendError(reply, 404, 'NOT_FOUND', 'User not found')
    }

    if (target.role !== 'USER' && admin.role !== 'SUPER_ADMIN') {
      return sendError(reply, 403, 'FORBIDDEN', 'Only super admins can change admin status')
    }

    if (target.role === 'SUPER_ADMIN') {
      return sendError(reply, 403, 'FORBIDDEN', 'Cannot change super admin status')
    }

    if (target.status === body.data.status) {
      return sendError(reply, 409, 'CONFLICT', 'Status already set')
    }

    const now = new Date()

    try {
      await db.transaction(async (tx) => {
        await tx.update(users)
          .set({
            status: body.data.status,
            rejectionReason: body.data.reason || null,
            updatedAt: now
          })
          .where(eq(users.id, userId))

        await tx.insert(userStatusHistory).values({
          id: ulid(),
          userId,
          previousStatus: target.status,
          newStatus: body.data.status,
          changedBy: admin.id,
          reason: body.data.reason || null
        })

        await tx.insert(auditLogs).values({
          id: ulid(),
          userId: admin.id,
          ipAddress: request.ip,
          action: 'user.status_change',
          entityType: 'user',
          entityId: userId,
          details: JSON.stringify({
            previousStatus: target.status,
            newStatus: body.data.status,
            reason: body.data.reason
          })
        })

        if (body.data.status === 'REJECTED' || body.data.status === 'SUSPENDED') {
          await tx.update(sessions)
            .set({ revokedAt: now })
            .where(and(
              eq(sessions.userId, userId),
              isNull(sessions.revokedAt)
            ))

          await tx.update(refreshTokens)
            .set({ revokedAt: now })
            .where(and(
              eq(refreshTokens.userId, userId),
              isNull(refreshTokens.revokedAt)
            ))
        }
      })
    } catch (error) {
      logger.error({ userId, adminId: admin.id, error }, 'Status update failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to update status')
    }

    updateUserCache(userId, { status: body.data.status })

    emitToUser(userId, 'user:status_changed', {
      userId,
      status: body.data.status,
      reason: body.data.reason,
      changedAt: now.getTime()
    })

    if (body.data.status === 'REJECTED' || body.data.status === 'SUSPENDED') {
      forceLogout(userId, `Account ${body.data.status.toLowerCase()}`)
    }

    try {
      if (body.data.status === 'APPROVED') {
        await sendEmail({ type: 'accountApproved', userId })
      } else if (body.data.status === 'REJECTED' && body.data.reason) {
        await sendEmail({ type: 'accountRejected', userId, reason: body.data.reason })
      } else if (body.data.status === 'SUSPENDED' && body.data.reason) {
        await sendEmail({ type: 'accountSuspended', userId, reason: body.data.reason })
      }
    } catch (error) {
      logger.warn({ userId, status: body.data.status, error }, 'Failed to send status email')
    }

    return sendOk(reply, { message: 'Status updated' })
  })

  fastify.patch('/users/:userId/media-permission', { preHandler: requireAdmin }, async (request, reply) => {
    const admin = requireUser(request, reply)
    if (!admin) {
      return
    }

    const { userId } = request.params as { userId: string }

    if (!isValidId(userId)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid user ID')
    }

    const body = mediaPermissionSchema.safeParse(request.body)
    if (!body.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid input', body.error.issues)
    }

    const target = await db.query.users.findFirst({
      where: eq(users.id, userId)
    })

    if (!target) {
      return sendError(reply, 404, 'NOT_FOUND', 'User not found')
    }

    if (target.role !== 'USER') {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Admins always have media permission')
    }

    const now = new Date()

    try {
      await db.transaction(async (tx) => {
        await tx.update(users)
          .set({
            mediaPermission: body.data.mediaPermission,
            updatedAt: now
          })
          .where(eq(users.id, userId))

        await tx.insert(auditLogs).values({
          id: ulid(),
          userId: admin.id,
          ipAddress: request.ip,
          action: 'user.media_permission_change',
          entityType: 'user',
          entityId: userId,
          details: JSON.stringify({ mediaPermission: body.data.mediaPermission })
        })
      })
    } catch (error) {
      logger.error({ userId, error }, 'Media permission update failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to update media permission')
    }

    updateUserCache(userId, { mediaPermission: body.data.mediaPermission })

    emitToUser(userId, 'user:media_permission_changed', {
      mediaPermission: body.data.mediaPermission
    })

    return sendOk(reply, {
      user: {
        id: userId,
        mediaPermission: body.data.mediaPermission
      }
    })
  })

  fastify.post('/users/:userId/revoke-sessions', { preHandler: requireAdmin }, async (request, reply) => {
    const admin = requireUser(request, reply)
    if (!admin) {
      return
    }

    const { userId } = request.params as { userId: string }

    if (!isValidId(userId)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid user ID')
    }

    const target = await db.query.users.findFirst({
      where: eq(users.id, userId)
    })

    if (!target) {
      return sendError(reply, 404, 'NOT_FOUND', 'User not found')
    }

    const now = new Date()

    try {
      await db.transaction(async (tx) => {
        await tx.update(sessions)
          .set({ revokedAt: now })
          .where(and(
            eq(sessions.userId, userId),
            isNull(sessions.revokedAt)
          ))

        await tx.update(refreshTokens)
          .set({ revokedAt: now })
          .where(and(
            eq(refreshTokens.userId, userId),
            isNull(refreshTokens.revokedAt)
          ))

        await tx.insert(auditLogs).values({
          id: ulid(),
          userId: admin.id,
          ipAddress: request.ip,
          action: 'user.sessions_revoke',
          entityType: 'user',
          entityId: userId
        })
      })
    } catch (error) {
      logger.error({ userId, adminId: admin.id, error }, 'Session revocation failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to revoke sessions')
    }

    forceLogout(userId, 'Sessions revoked by administrator')

    return sendOk(reply, { message: 'Sessions revoked' })
  })

  fastify.post('/cleanup/media', { preHandler: requireAdmin }, async (request, reply) => {
    const admin = requireUser(request, reply)
    if (!admin) {
      return
    }

    try {
      const result = await mediaCleanupService.triggerManualCleanup()

      await db.insert(auditLogs).values({
        id: ulid(),
        userId: admin.id,
        ipAddress: request.ip,
        action: 'admin.media_cleanup',
        entityType: 'system',
        entityId: 'media_cleanup_service',
        details: JSON.stringify({
          cleanedCount: result.cleanedCount,
          failedCount: result.failedCount,
          totalProcessed: result.cleanedCount + result.failedCount
        })
      })

      return sendOk(reply, {
        message: 'Media cleanup completed',
        results: {
          cleanedCount: result.cleanedCount,
          failedCount: result.failedCount,
          totalProcessed: result.cleanedCount + result.failedCount
        }
      })
    } catch (error) {
      logger.error({ error }, 'Media cleanup failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Media cleanup failed')
    }
  })

  fastify.get('/users/:userId', { preHandler: requireAdmin }, async (request, reply) => {
    const { userId } = request.params as { userId: string }

    if (!isValidId(userId)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid user ID')
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        email: true,
        name: true,
        phone: true,
        role: true,
        status: true,
        mediaPermission: true,
        emailNotifyOnMessage: true,
        rejectionReason: true,
        createdAt: true,
        updatedAt: true,
        lastSeenAt: true
      }
    })

    if (!user) {
      return sendError(reply, 404, 'NOT_FOUND', 'User not found')
    }

    return sendOk(reply, { user })
  })

  const statusHistorySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.string().optional()
  })

  fastify.get('/users/:userId/status-history', { preHandler: requireAdmin }, async (request, reply) => {
    const { userId } = request.params as { userId: string }

    if (!isValidId(userId)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid user ID')
    }

    const query = statusHistorySchema.safeParse(request.query)
    if (!query.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid query', query.error.issues)
    }

    const target = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true }
    })
    if (!target) {
      return sendError(reply, 404, 'NOT_FOUND', 'User not found')
    }

    const conditions = [eq(userStatusHistory.userId, userId)]
    if (query.data.before && isValidId(query.data.before)) {
      const beforeMs = decodeTime(query.data.before)
      conditions.push(lt(userStatusHistory.createdAt, new Date(beforeMs)))
    }

    const history = await db.query.userStatusHistory.findMany({
      where: and(...conditions),
      orderBy: [desc(userStatusHistory.createdAt)],
      limit: query.data.limit + 1,
      with: {
        changedByUser: {
          columns: { id: true, name: true, role: true }
        }
      }
    })

    const hasMore = history.length > query.data.limit
    const historyToReturn = hasMore ? history.slice(0, -1) : history

    return sendOk(reply, { history: historyToReturn, hasMore })
  })

  const auditLogSchema = z.object({
    action: z.string().max(100).optional(),
    entityType: z.string().max(50).optional(),
    userId: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.string().optional()
  })

  fastify.get('/audit-logs', { preHandler: requireAdmin }, async (request, reply) => {
    const query = auditLogSchema.safeParse(request.query)
    if (!query.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid query', query.error.issues)
    }

    const conditions = []
    if (query.data.action) conditions.push(eq(auditLogs.action, query.data.action))
    if (query.data.entityType) conditions.push(eq(auditLogs.entityType, query.data.entityType))
    if (query.data.userId && isValidId(query.data.userId)) {
      conditions.push(eq(auditLogs.userId, query.data.userId))
    }
    if (query.data.before && isValidId(query.data.before)) {
      const beforeMs = decodeTime(query.data.before)
      conditions.push(lt(auditLogs.createdAt, new Date(beforeMs)))
    }

    const logs = await db.query.auditLogs.findMany({
      where: conditions.length ? and(...conditions) : undefined,
      orderBy: [desc(auditLogs.createdAt)],
      limit: query.data.limit + 1,
      with: {
        user: {
          columns: { id: true, name: true, role: true }
        }
      }
    })

    const hasMore = logs.length > query.data.limit
    const logsToReturn = hasMore ? logs.slice(0, -1) : logs

    return sendOk(reply, { logs: logsToReturn, hasMore })
  })
}