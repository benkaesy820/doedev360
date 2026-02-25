import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '../db/index.js'
import { users, auditLogs } from '../db/schema.js'
import { requireApprovedUser, requireUser, sendError, sendOk } from '../middleware/auth.js'
import { updateUserCache } from '../state.js'
import { cancelEmailNotification } from '../services/emailQueue.js'
import { emitToUser } from '../socket/index.js'
import { logger } from '../lib/logger.js'

const emailPreferenceSchema = z.object({
  emailNotifyOnMessage: z.boolean()
})

export async function preferencesRoutes(fastify: FastifyInstance) {
  fastify.get('/', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }

    const userRecord = await db.query.users.findFirst({
      where: eq(users.id, user.id),
      columns: {
        emailNotifyOnMessage: true,
        mediaPermission: true
      }
    })

    if (!userRecord) {
      return sendError(reply, 404, 'NOT_FOUND', 'User not found')
    }

    return sendOk(reply, { preferences: userRecord })
  })

  fastify.patch('/email-notifications', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }

    const body = emailPreferenceSchema.safeParse(request.body)
    if (!body.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid input', body.error.issues)
    }

    try {
      await db.transaction(async (tx) => {
        await tx.update(users)
          .set({
            emailNotifyOnMessage: body.data.emailNotifyOnMessage,
            updatedAt: new Date()
          })
          .where(eq(users.id, user.id))

        await tx.insert(auditLogs).values({
          id: ulid(),
          userId: user.id,
          ipAddress: request.ip,
          action: 'user.preferences_change',
          entityType: 'user',
          entityId: user.id,
          details: JSON.stringify({ emailNotifyOnMessage: body.data.emailNotifyOnMessage })
        })
      })

      updateUserCache(user.id, {
        emailNotifyOnMessage: body.data.emailNotifyOnMessage
      })

      if (!body.data.emailNotifyOnMessage) {
        cancelEmailNotification(user.id)
      }

      emitToUser(user.id, 'preferences:updated', {
        emailNotifyOnMessage: body.data.emailNotifyOnMessage
      })

      return sendOk(reply, {
        preferences: {
          emailNotifyOnMessage: body.data.emailNotifyOnMessage
        }
      })
    } catch (error) {
      logger.error({ userId: user.id, error }, 'Preferences update failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to update preferences')
    }
  })
}