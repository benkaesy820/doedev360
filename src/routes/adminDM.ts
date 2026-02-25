import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { and, desc, eq, isNull, inArray, lt, or, sql } from 'drizzle-orm'
import { ulid, decodeTime } from 'ulid'
import { db } from '../db/index.js'
import { directMessages, users, directMessageReactions, media } from '../db/schema.js'
import { requireApprovedUser, requireUser, sendError, sendOk } from '../middleware/auth.js'
import { isAdmin, canDeleteMessage } from '../lib/permissions.js'
import { sanitizeText, isValidId } from '../lib/utils.js'
import { emitToUser } from '../socket/index.js'
import { serverState, getUserFromCache } from '../state.js'
import { logger } from '../lib/logger.js'
import { getConfig } from '../lib/config.js'

const emojiRegex = /^[\p{Emoji}]+$/u

const sendDMSchema = z.object({
  content: z.string().min(1).max(100000).optional(),
  type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']).default('TEXT'),
  mediaId: z.string().min(1).max(26).optional(),
  tempId: z.string().max(64).optional(),
  replyToId: z.string().min(1).max(26).optional(),
}).refine(d => d.content || d.mediaId, { message: 'content or mediaId required' })

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().optional(),
})

export async function adminDMRoutes(fastify: FastifyInstance) {
  fastify.get('/dm/conversations', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return
    if (!isAdmin(user)) return sendError(reply, 403, 'FORBIDDEN', 'Admins only')

    const q = paginationSchema.safeParse(request.query)
    const limit = q.success ? q.data.limit : 50
    const before = q.success ? q.data.before : undefined

    let beforeTs: number | undefined
    if (before && isValidId(before)) {
      beforeTs = decodeTime(before)
    }

    // Single query: join partner user row, filter by admin role, group by partner — no JS sort/filter
    const rows = await db
      .select({
        partnerId: sql<string>`CASE WHEN ${directMessages.senderId} = ${user.id} THEN ${directMessages.recipientId} ELSE ${directMessages.senderId} END`,
        partnerName: users.name,
        partnerRole: users.role,
        msgId: sql<string>`max(${directMessages.id})`,
        content: directMessages.content,
        type: directMessages.type,
        senderId: directMessages.senderId,
        createdAt: directMessages.createdAt,
      })
      .from(directMessages)
      .innerJoin(users, sql`${users.id} = CASE WHEN ${directMessages.senderId} = ${user.id} THEN ${directMessages.recipientId} ELSE ${directMessages.senderId} END`)
      .where(and(
        isNull(directMessages.deletedAt),
        or(eq(directMessages.senderId, user.id), eq(directMessages.recipientId, user.id))!,
        inArray(users.role, ['ADMIN', 'SUPER_ADMIN'] as const),
        beforeTs ? lt(directMessages.createdAt, new Date(beforeTs)) : undefined
      ))
      .groupBy(sql`CASE WHEN ${directMessages.senderId} = ${user.id} THEN ${directMessages.recipientId} ELSE ${directMessages.senderId} END`)
      .orderBy(sql`max(${directMessages.id}) DESC`)
      .limit(limit + 1)

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    const conversations = page.map(r => {
      const ts = r.createdAt instanceof Date ? r.createdAt.getTime() : Number(r.createdAt)
      return {
        partner: { id: r.partnerId, name: r.partnerName, role: r.partnerRole },
        lastMessage: { id: r.msgId, content: r.content, type: r.type, senderId: r.senderId, createdAt: ts }
      }
    })

    return sendOk(reply, { conversations, hasMore })
  })

  fastify.get('/dm/:adminId', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return
    if (!isAdmin(user)) return sendError(reply, 403, 'FORBIDDEN', 'Admins only')

    const { adminId } = request.params as { adminId: string }
    if (!isValidId(adminId)) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid admin ID')
    if (adminId === user.id) return sendError(reply, 400, 'VALIDATION_ERROR', 'Cannot DM yourself')

    const other = await db.query.users.findFirst({
      where: and(eq(users.id, adminId), eq(users.status, 'APPROVED')),
      columns: { id: true, name: true, role: true }
    })
    if (!other || (other.role !== 'ADMIN' && other.role !== 'SUPER_ADMIN')) {
      return sendError(reply, 404, 'NOT_FOUND', 'Admin not found')
    }

    const query = paginationSchema.safeParse(request.query)
    const limit = query.success ? query.data.limit : 50
    const before = query.success ? query.data.before : undefined

    const conditions = [
      isNull(directMessages.deletedAt),
      sql`NOT EXISTS (SELECT 1 FROM json_each(${directMessages.hiddenFor}) WHERE value = ${user.id})`,
      or(
        and(eq(directMessages.senderId, user.id), eq(directMessages.recipientId, adminId)),
        and(eq(directMessages.senderId, adminId), eq(directMessages.recipientId, user.id))
      )!
    ]

    if (before && isValidId(before)) {
      // Decode timestamp from ULID — no extra DB round-trip needed
      const beforeMs = decodeTime(before)
      conditions.push(lt(directMessages.createdAt, new Date(beforeMs)))
    }

    const msgs = await db.query.directMessages.findMany({
      where: and(...conditions),
      orderBy: [desc(directMessages.createdAt)],
      limit: limit + 1,
      with: {
        sender: { columns: { id: true, name: true, role: true } },
        media: { columns: { id: true, type: true, cdnUrl: true, filename: true, size: true, mimeType: true } },
        reactions: { with: { user: { columns: { name: true } } } },
        replyTo: { columns: { id: true, content: true, type: true, deletedAt: true }, with: { sender: { columns: { id: true, name: true, role: true } } } }
      }
    })

    const hasMore = msgs.length > limit
    const result = (hasMore ? msgs.slice(0, -1) : msgs).map(msg => ({
      ...msg,
      replyTo: msg.replyTo
        ? {
          ...msg.replyTo,
          // Don't expose content of soft-deleted reply targets (#28)
          content: msg.replyTo.deletedAt ? null : msg.replyTo.content,
        }
        : null,
    }))

    return sendOk(reply, { messages: result, hasMore, partner: other })
  })

  fastify.post('/dm/:adminId', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return
    if (!isAdmin(user)) return sendError(reply, 403, 'FORBIDDEN', 'Admins only')

    const { adminId } = request.params as { adminId: string }
    if (!isValidId(adminId)) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid admin ID')
    if (adminId === user.id) return sendError(reply, 400, 'VALIDATION_ERROR', 'Cannot DM yourself')

    const other = await db.query.users.findFirst({
      where: and(eq(users.id, adminId), eq(users.status, 'APPROVED')),
      columns: { id: true, name: true, role: true }
    })
    if (!other || (other.role !== 'ADMIN' && other.role !== 'SUPER_ADMIN')) {
      return sendError(reply, 404, 'NOT_FOUND', 'Admin not found')
    }

    const body = sendDMSchema.safeParse(request.body)
    if (!body.success) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid input', body.error.issues)

    const config = getConfig()
    const { type, mediaId, tempId } = body.data
    const content = body.data.content ? sanitizeText(body.data.content) : null

    if (type === 'TEXT' && content && content.length > (config.limits.message.teamTextMaxLength || 5000)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', `Message too long (max ${config.limits.message.teamTextMaxLength || 5000} characters)`)
    }

    const id = ulid()
    const createdAt = new Date()

    // Pre-fetch media and replyTo before insert — eliminates post-insert SELECT
    const [mediaRecord, replyToRow] = await Promise.all([
      mediaId
        ? db.query.media.findFirst({
          where: eq(media.id, mediaId),
          columns: { id: true, type: true, cdnUrl: true, filename: true, size: true, mimeType: true }
        })
        : Promise.resolve(null),
      body.data.replyToId
        ? db.query.directMessages.findFirst({
          where: eq(directMessages.id, body.data.replyToId),
          columns: { id: true, content: true, type: true, deletedAt: true },
          with: { sender: { columns: { id: true, name: true, role: true } } }
        })
        : Promise.resolve(null),
    ])

    try {
      await db.insert(directMessages).values({ id, senderId: user.id, recipientId: adminId, type, content, mediaId: mediaId ?? null, replyToId: body.data.replyToId ?? null, createdAt })
    } catch (err) {
      logger.error({ userId: user.id, error: err }, 'DM send failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to send message')
    }

    const cachedSender = getUserFromCache(user.id)
    const msg = {
      id,
      senderId: user.id,
      sender: { id: user.id, name: cachedSender?.name ?? user.id, role: user.role },
      recipientId: adminId,
      type,
      content,
      mediaId: mediaId ?? null,
      media: mediaRecord ?? null,
      hiddenFor: null,
      deletedAt: null,
      replyToId: body.data.replyToId ?? null,
      replyTo: replyToRow ?? null,
      reactions: [],
      createdAt,
    }

    emitToUser(adminId, 'dm:message', { message: msg, tempId })
    reply.code(201)
    return sendOk(reply, { message: msg, tempId })
  })

  fastify.delete('/dm/message/:messageId', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return
    if (!isAdmin(user)) return sendError(reply, 403, 'FORBIDDEN', 'Admins only')

    const { messageId } = request.params as { messageId: string }
    if (!isValidId(messageId)) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid message ID')

    const scopeRaw = (request.query as { scope?: string }).scope ?? 'me'
    const scope: 'me' | 'all' = scopeRaw === 'all' ? 'all' : 'me'

    const msg = await db.query.directMessages.findFirst({
      where: and(eq(directMessages.id, messageId), isNull(directMessages.deletedAt)),
      columns: { id: true, senderId: true, recipientId: true, hiddenFor: true, createdAt: true }
    })

    if (!msg) return sendError(reply, 404, 'NOT_FOUND', 'Message not found')

    // Only actual participants (or super admin) should even attempt deletion
    if (msg.senderId !== user.id && msg.recipientId !== user.id && user.role !== 'SUPER_ADMIN') {
      return sendError(reply, 403, 'FORBIDDEN', 'Not part of this conversation')
    }

    if (!canDeleteMessage(user, msg as any, scope)) {
      return sendError(reply, 403, 'FORBIDDEN', 'Cannot delete this message or time limit exceeded')
    }

    const now = new Date()

    if (scope === 'me') {
      await db.run(sql`
        UPDATE direct_messages
        SET hidden_for = CASE
          WHEN hidden_for IS NULL OR hidden_for = '[]' THEN json_array(${user.id})
          WHEN json_type(hidden_for) = 'array'
            AND NOT EXISTS (SELECT 1 FROM json_each(hidden_for) WHERE value = ${user.id})
          THEN json_insert(hidden_for, '$[#]', ${user.id})
          ELSE hidden_for
        END
        WHERE id = ${messageId}
      `)
    } else {
      await db.update(directMessages).set({ deletedAt: now }).where(eq(directMessages.id, messageId))
      const otherId = msg.senderId === user.id ? msg.recipientId : msg.senderId
      emitToUser(otherId, 'dm:message:deleted', { messageId })
    }

    return sendOk(reply, { success: true })
  })
  // ========================================================================
  // REACTIONS
  // ========================================================================
  fastify.post('/dm/:adminId/:messageId/reaction', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return
    if (!isAdmin(user)) return sendError(reply, 403, 'FORBIDDEN', 'Admins only')

    const { adminId, messageId } = request.params as { adminId: string; messageId: string }
    const { emoji } = request.body as { emoji: string }

    if (!isValidId(adminId) || !isValidId(messageId)) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid IDs')
    if (typeof emoji !== 'string' || !emoji || !emojiRegex.test(emoji)) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid emoji')

    const msg = await db.query.directMessages.findFirst({
      where: and(eq(directMessages.id, messageId), isNull(directMessages.deletedAt)),
      columns: { id: true, senderId: true, recipientId: true }
    })
    if (!msg) return sendError(reply, 404, 'NOT_FOUND', 'Message not found')

    // Verify user is part of the conversation
    if (msg.senderId !== user.id && msg.recipientId !== user.id) {
      return sendError(reply, 403, 'FORBIDDEN', 'Not part of this conversation')
    }

    try {
      // Upsert: unique constraint (messageId, userId) — replaces emoji atomically
      const reactionId = ulid()
      await db.insert(directMessageReactions)
        .values({ id: reactionId, messageId, userId: user.id, emoji })
        .onConflictDoUpdate({
          target: [directMessageReactions.messageId, directMessageReactions.userId],
          set: { emoji, id: reactionId }
        })

      // Use name from server state (populated on socket connect) — no extra DB lookup
      const userName = serverState.userNames.get(user.id) ?? 'Unknown'
      const reaction = { id: reactionId, messageId, userId: user.id, emoji, user: { name: userName } }

      // Notify both parties
      emitToUser(user.id, 'dm:message:reaction', { adminId, messageId, type: 'add', reaction })
      if (adminId !== user.id) {
        emitToUser(adminId, 'dm:message:reaction', { adminId: user.id, messageId, type: 'add', reaction })
      }

      return sendOk(reply, { success: true, reaction })
    } catch (err) {
      logger.error({ userId: user.id, error: err }, 'Add DM reaction failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to add reaction')
    }
  })

  fastify.delete('/dm/:adminId/:messageId/reaction/:emoji', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return
    if (!isAdmin(user)) return sendError(reply, 403, 'FORBIDDEN', 'Admins only')

    const { adminId, messageId, emoji } = request.params as { adminId: string; messageId: string; emoji: string }

    if (!isValidId(adminId) || !isValidId(messageId)) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid IDs')
    if (!emoji) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid emoji')

    const decodedEmoji = decodeURIComponent(emoji)
    if (!emojiRegex.test(decodedEmoji)) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid emoji')

    const result = await db.delete(directMessageReactions).where(
      and(
        eq(directMessageReactions.messageId, messageId),
        eq(directMessageReactions.userId, user.id),
        eq(directMessageReactions.emoji, decodedEmoji)
      )
    )

    if (result.rowsAffected && result.rowsAffected > 0) {
      const reaction = { messageId, userId: user.id, emoji: decodedEmoji }
      // Notify both parties
      emitToUser(user.id, 'dm:message:reaction', { adminId, messageId, type: 'remove', reaction })
      if (adminId !== user.id) {
        emitToUser(adminId, 'dm:message:reaction', { adminId: user.id, messageId, type: 'remove', reaction })
      }
    }

    return sendOk(reply, { success: true })
  })
}
