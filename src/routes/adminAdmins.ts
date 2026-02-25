import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { and, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import { ulid, decodeTime } from 'ulid'
import { hash } from '@node-rs/argon2'
import { db } from '../db/index.js'
import { auditLogs, refreshTokens, sessions, userStatusHistory, users } from '../db/schema.js'
import { normalizeEmail, isValidId, sanitizeName } from '../lib/utils.js'
import { requireAdmin, requireSuperAdmin, requireUser, sendError, sendOk } from '../middleware/auth.js'
import { passwordSchema } from '../lib/passwordPolicy.js'
import { addUserToCache, updateUserCache } from '../state.js'
import { forceLogout } from '../socket/index.js'
import { logger } from '../lib/logger.js'

const createAdminSchema = z.object({
  email: z.string().email().max(255),
  password: passwordSchema,
  name: z.string().min(2).max(100).transform(s => sanitizeName(s))
}).strict()

const updateRoleSchema = z.object({
  role: z.enum(['USER', 'ADMIN', 'SUPER_ADMIN'])
}).strict()

const listAdminsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().optional()
}).strict()


export async function adminAdminRoutes(fastify: FastifyInstance) {
  fastify.get('/admins', { preHandler: requireAdmin }, async (request, reply) => {
    const query = listAdminsSchema.safeParse(request.query)
    if (!query.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid query', query.error.issues)
    }

    let beforeCreatedAt: Date | undefined
    if (query.data.before) {
      if (!isValidId(query.data.before)) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid before cursor')
      }
      const beforeMs = decodeTime(query.data.before)
      beforeCreatedAt = new Date(beforeMs)
    }

    const statusFilter = or(eq(users.status, 'APPROVED'), eq(users.status, 'SUSPENDED'))
    const cols = {
      id: true, email: true, name: true, role: true,
      status: true, createdAt: true, lastSeenAt: true
    } as const

    const adminWhere = beforeCreatedAt
      ? and(statusFilter, eq(users.role, 'ADMIN'), lt(users.createdAt, beforeCreatedAt))
      : and(statusFilter, eq(users.role, 'ADMIN'))

    const superAdminWhere = beforeCreatedAt
      ? and(statusFilter, eq(users.role, 'SUPER_ADMIN'), lt(users.createdAt, beforeCreatedAt))
      : and(statusFilter, eq(users.role, 'SUPER_ADMIN'))

    const [adminRows, superAdminRows] = await Promise.all([
      db.query.users.findMany({
        where: adminWhere,
        orderBy: [desc(users.createdAt)],
        limit: query.data.limit + 1,
        columns: cols
      }),
      db.query.users.findMany({
        where: superAdminWhere,
        orderBy: [desc(users.createdAt)],
        limit: query.data.limit + 1,
        columns: cols
      }),
    ])

    const hasMoreAdmins = adminRows.length > query.data.limit
    const hasMoreSuperAdmins = superAdminRows.length > query.data.limit

    const admins = hasMoreAdmins ? adminRows.slice(0, query.data.limit) : adminRows
    const superAdmins = hasMoreSuperAdmins ? superAdminRows.slice(0, query.data.limit) : superAdminRows

    return sendOk(reply, { admins, superAdmins, hasMoreAdmins, hasMoreSuperAdmins })
  })

  fastify.post('/admins', { preHandler: requireSuperAdmin }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }

    const body = createAdminSchema.safeParse(request.body)
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
    const now = new Date()

    try {
      await db.transaction(async (tx) => {
        await tx.insert(users).values({
          id: userId,
          email,
          passwordHash,
          name: body.data.name,
          phone: null,
          role: 'ADMIN',
          status: 'APPROVED',
          mediaPermission: true,
          emailNotifyOnMessage: true,
          rejectionReason: null,
          createdAt: now,
          updatedAt: now,
          lastSeenAt: null
        })

        await tx.insert(userStatusHistory).values({
          id: ulid(),
          userId,
          previousStatus: 'PENDING',
          newStatus: 'APPROVED',
          changedBy: user.id,
          reason: 'admin_create'
        })

        await tx.insert(auditLogs).values({
          id: ulid(),
          userId: user.id,
          ipAddress: request.ip,
          action: 'admin.create',
          entityType: 'user',
          entityId: userId,
          details: JSON.stringify({ role: 'ADMIN' })
        })
      })
    } catch (error) {
      logger.error({ email, error }, 'Admin creation failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to create admin')
    }

    addUserToCache(userId, {
      role: 'ADMIN',
      status: 'APPROVED',
      name: body.data.name,
      mediaPermission: true,
      emailNotifyOnMessage: true
    })

    reply.code(201)
    return sendOk(reply, {
      admin: {
        id: userId,
        email,
        name: body.data.name,
        role: 'ADMIN',
        status: 'APPROVED'
      }
    })
  })

  fastify.patch('/admins/:userId/suspend', { preHandler: requireSuperAdmin }, async (request, reply) => {
    const actor = requireUser(request, reply)
    if (!actor) return

    const { userId } = request.params as { userId: string }
    if (!isValidId(userId)) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid user ID')
    if (userId === actor.id) return sendError(reply, 400, 'VALIDATION_ERROR', 'Cannot suspend yourself')

    const target = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { id: true, role: true, status: true, name: true } })
    if (!target) return sendError(reply, 404, 'NOT_FOUND', 'User not found')
    if (!['ADMIN', 'SUPER_ADMIN'].includes(target.role)) return sendError(reply, 400, 'VALIDATION_ERROR', 'User is not an admin')
    if (target.status === 'SUSPENDED') return sendError(reply, 409, 'CONFLICT', 'Admin is already suspended')

    const now = new Date()
    try {
      await db.transaction(async (tx) => {
        await tx.update(users).set({ status: 'SUSPENDED', updatedAt: now }).where(eq(users.id, userId))
        await tx.insert(userStatusHistory).values({ id: ulid(), userId, previousStatus: target.status, newStatus: 'SUSPENDED', changedBy: actor.id, reason: 'admin_suspend' })
        await tx.insert(auditLogs).values({ id: ulid(), userId: actor.id, ipAddress: request.ip, action: 'admin.suspend', entityType: 'user', entityId: userId, details: JSON.stringify({ name: target.name, role: target.role }) })
        await tx.update(sessions).set({ revokedAt: now }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
        await tx.update(refreshTokens).set({ revokedAt: now }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
      })
    } catch (error) {
      logger.error({ userId, error }, 'Admin suspend failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to suspend admin')
    }

    updateUserCache(userId, { status: 'SUSPENDED' })
    forceLogout(userId, 'Account suspended')
    return sendOk(reply, { message: 'Admin suspended' })
  })

  fastify.patch('/admins/:userId/reactivate', { preHandler: requireSuperAdmin }, async (request, reply) => {
    const actor = requireUser(request, reply)
    if (!actor) return

    const { userId } = request.params as { userId: string }
    if (!isValidId(userId)) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid user ID')

    const target = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { id: true, role: true, status: true, name: true } })
    if (!target) return sendError(reply, 404, 'NOT_FOUND', 'User not found')
    if (!['ADMIN', 'SUPER_ADMIN'].includes(target.role)) return sendError(reply, 400, 'VALIDATION_ERROR', 'User is not an admin')
    if (target.status !== 'SUSPENDED') return sendError(reply, 409, 'CONFLICT', 'Admin is not suspended')

    const now = new Date()
    try {
      await db.transaction(async (tx) => {
        await tx.update(users).set({ status: 'APPROVED', updatedAt: now }).where(eq(users.id, userId))
        await tx.insert(userStatusHistory).values({ id: ulid(), userId, previousStatus: 'SUSPENDED', newStatus: 'APPROVED', changedBy: actor.id, reason: 'admin_reactivate' })
        await tx.insert(auditLogs).values({ id: ulid(), userId: actor.id, ipAddress: request.ip, action: 'admin.reactivate', entityType: 'user', entityId: userId, details: JSON.stringify({ name: target.name, role: target.role }) })
      })
    } catch (error) {
      logger.error({ userId, error }, 'Admin reactivate failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to reactivate admin')
    }

    updateUserCache(userId, { status: 'APPROVED' })
    return sendOk(reply, { message: 'Admin reactivated' })
  })

  fastify.patch('/admins/:userId/role', { preHandler: requireSuperAdmin }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }

    const { userId } = request.params as { userId: string }

    if (!isValidId(userId)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid user ID')
    }

    const body = updateRoleSchema.safeParse(request.body)
    if (!body.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid input', body.error.issues)
    }

    if (userId === user.id) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Cannot change your own role')
    }

    const target = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true, role: true, status: true, name: true }
    })

    if (!target) {
      return sendError(reply, 404, 'NOT_FOUND', 'User not found')
    }

    if (target.role === body.data.role) {
      return sendError(reply, 409, 'CONFLICT', 'Role already set')
    }

    // Prevent demoting a SUPER_ADMIN — only the super admin themselves (caught above) can change their own role
    if (target.role === 'SUPER_ADMIN') {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Cannot change super admin role')
    }

    const now = new Date()

    try {
      await db.transaction(async (tx) => {
        await tx.update(users)
          .set({ role: body.data.role, updatedAt: now })
          .where(eq(users.id, userId))

        await tx.insert(auditLogs).values({
          id: ulid(),
          userId: user.id,
          ipAddress: request.ip,
          action: 'admin.role_change',
          entityType: 'user',
          entityId: userId,
          details: JSON.stringify({ previousRole: target.role, newRole: body.data.role })
        })

        if (body.data.role === 'USER') {
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
      logger.error({ userId, error }, 'Role update failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to update role')
    }

    updateUserCache(userId, { role: body.data.role })

    if (body.data.role === 'USER') {
      forceLogout(userId, 'Role changed to user')
    }

    return sendOk(reply, { message: 'Role updated' })
  })
}