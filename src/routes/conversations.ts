import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { and, desc, eq, isNull, lt, sql, ne } from 'drizzle-orm'
import { ulid, decodeTime } from 'ulid'
import { db } from '../db/index.js'
import { conversations, messages, media, auditLogs, messageReactions, users } from '../db/schema.js'
import { requireApprovedUser, requireUser, sendError, sendOk } from '../middleware/auth.js'
import { canAccessConversation, canDeleteMessage, canUploadMedia, isAdmin } from '../lib/permissions.js'
import { getConfig } from '../lib/config.js'
import { emitToUser, emitToAdmins } from '../socket/index.js'
import { cancelEmailNotification, queueEmailNotification } from '../services/emailQueue.js'
import { createRateLimiters } from '../middleware/rateLimit.js'
import { setConversationOwner, serverState, getUserFromCache } from '../state.js'
import { sanitizeText, isValidId } from '../lib/utils.js'
import { logger } from '../lib/logger.js'

const textMessageSchema = z.object({
  type: z.literal('TEXT'),
  content: z.string().min(1).max(100000),
  replyToId: z.string().min(1).max(26).optional(),
  announcementId: z.string().min(1).max(26).optional(),
})

const mediaMessageSchema = z.object({
  type: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT']),
  mediaId: z.string().min(1),
  content: z.string().max(100000).optional(),
  replyToId: z.string().min(1).max(26).optional(),
  announcementId: z.string().min(1).max(26).optional(),
})

const messageSchema = z.discriminatedUnion('type', [
  textMessageSchema,
  mediaMessageSchema
])

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().optional()
})

/** Error interface for database constraint errors */
interface DbError {
  code?: string
  message?: string
}

/** Checks if error is a database constraint error */
function isDbConstraintError(error: unknown): boolean {
  const err = error as DbError
  return err?.code === 'SQLITE_CONSTRAINT' || (err?.message?.includes('UNIQUE constraint') ?? false)
}

export async function conversationRoutes(fastify: FastifyInstance) {
  const rateLimiters = createRateLimiters()

  fastify.get('/', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }

    const userIsAdmin = isAdmin(user)

    if (userIsAdmin) {
      const adminQuery = paginationSchema.safeParse(request.query)
      const limit = adminQuery.success ? adminQuery.data.limit : 50
      const before = adminQuery.success ? adminQuery.data.before : undefined

      const conditions = []
      // Regular ADMINs only see conversations assigned to them
      if (user.role === 'ADMIN') {
        conditions.push(eq(conversations.assignedAdminId, user.id))
      }
      if (before && isValidId(before)) {
        // Decode timestamp from ULID — no extra DB round-trip needed
        const beforeMs = decodeTime(before)
        conditions.push(lt(conversations.lastMessageAt, new Date(beforeMs)))
      }

      const allConversations = await db.query.conversations.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        orderBy: [desc(conversations.lastMessageAt)],
        limit: limit + 1,
        with: {
          user: { columns: { id: true, name: true, email: true, status: true } },
          assignedAdmin: { columns: { id: true, name: true, role: true } },
          messages: {
            where: isNull(messages.deletedAt),
            orderBy: [desc(messages.createdAt)],
            limit: 1,
            columns: { id: true, type: true, content: true, senderId: true, createdAt: true }
          }
        }
      })

      const hasMore = allConversations.length > limit
      const conversationsToReturn = hasMore ? allConversations.slice(0, -1) : allConversations

      const result = conversationsToReturn.map(conv => ({
        id: conv.id,
        userId: conv.userId,
        user: conv.user,
        assignedAdminId: conv.assignedAdminId,
        assignedAdmin: conv.assignedAdmin ?? null,
        unreadCount: conv.unreadCount,
        adminUnreadCount: conv.adminUnreadCount,
        lastMessageAt: conv.lastMessageAt,
        createdAt: conv.createdAt,
        lastMessage: conv.messages[0] || null
      }))

      return sendOk(reply, { conversations: result, hasMore })
    } else {
      const conversation = await db.query.conversations.findFirst({
        where: eq(conversations.userId, user.id),
        columns: { id: true, userId: true, assignedAdminId: true, unreadCount: true, lastMessageAt: true, createdAt: true, updatedAt: true },
        with: {
          assignedAdmin: { columns: { id: true, name: true, role: true } },
          messages: {
            where: isNull(messages.deletedAt),
            orderBy: [desc(messages.createdAt)],
            limit: 1,
            columns: { id: true, type: true, content: true, senderId: true, createdAt: true }
          }
        }
      })

      if (!conversation) {
        return sendOk(reply, { conversation: null })
      }

      return sendOk(reply, {
        conversation: {
          id: conversation.id,
          userId: conversation.userId,
          assignedAdminId: conversation.assignedAdminId,
          assignedAdmin: conversation.assignedAdmin ?? null,
          unreadCount: conversation.unreadCount,
          lastMessageAt: conversation.lastMessageAt,
          createdAt: conversation.createdAt,
          lastMessage: conversation.messages[0] || null
        }
      })
    }
  })

  fastify.get('/:id', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return
    if (!isAdmin(user)) return sendError(reply, 403, 'FORBIDDEN', 'Admins only')

    const { id } = request.params as { id: string }
    if (!isValidId(id)) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid conversation ID')

    const conv = await db.query.conversations.findFirst({
      where: eq(conversations.id, id),
      with: {
        user: { columns: { id: true, name: true, email: true, status: true } },
        assignedAdmin: { columns: { id: true, name: true, role: true } },
        messages: {
          where: isNull(messages.deletedAt),
          orderBy: [desc(messages.createdAt)],
          limit: 1,
          columns: { id: true, type: true, content: true, senderId: true, createdAt: true }
        }
      }
    })

    if (!conv) return sendError(reply, 404, 'NOT_FOUND', 'Conversation not found')
    if (!canAccessConversation(user, conv)) return sendError(reply, 403, 'FORBIDDEN', 'Access denied')

    return sendOk(reply, {
      conversation: {
        id: conv.id,
        userId: conv.userId,
        user: conv.user,
        assignedAdminId: conv.assignedAdminId,
        assignedAdmin: conv.assignedAdmin ?? null,
        unreadCount: conv.unreadCount,
        adminUnreadCount: conv.adminUnreadCount,
        lastMessageAt: conv.lastMessageAt,
        createdAt: conv.createdAt,
        lastMessage: conv.messages[0] || null
      }
    })
  })

  fastify.post('/', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }

    if (isAdmin(user)) {
      return sendError(reply, 400, 'BAD_REQUEST', 'Admins do not have their own conversations')
    }

    const existing = await db.query.conversations.findFirst({
      where: eq(conversations.userId, user.id),
      columns: { id: true }
    })

    if (existing) {
      return sendOk(reply, { conversation: existing })
    }

    const id = ulid()
    const now = new Date()

    try {
      await db.insert(conversations).values({
        id,
        userId: user.id,
        createdAt: now,
        updatedAt: now,
        unreadCount: 0
      })
      setConversationOwner(id, user.id)
    } catch (error) {
      if (isDbConstraintError(error)) {
        const existingConv = await db.query.conversations.findFirst({
          where: eq(conversations.userId, user.id),
          columns: { id: true }
        })
        if (existingConv) {
          return sendOk(reply, { conversation: existingConv })
        }
      }
      logger.error({ userId: user.id, error }, 'Conversation creation failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to create conversation')
    }

    const conversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, id)
    })

    return reply.code(201).send({ success: true, conversation })
  })

  fastify.post('/for-user', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return
    if (!isAdmin(user)) return sendError(reply, 403, 'FORBIDDEN', 'Admins only')

    const body = z.object({ userId: z.string().min(1).max(26) }).safeParse(request.body)
    if (!body.success) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid input')

    const { userId } = body.data
    if (!isValidId(userId)) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid user ID')

    const targetUser = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true, role: true, status: true }
    })
    if (!targetUser || targetUser.role !== 'USER') return sendError(reply, 404, 'NOT_FOUND', 'User not found')

    const existing = await db.query.conversations.findFirst({
      where: eq(conversations.userId, userId),
      columns: { id: true }
    })
    if (existing) return sendOk(reply, { conversation: existing })

    const id = ulid()
    const now = new Date()
    try {
      await db.insert(conversations).values({
        id,
        userId,
        assignedAdminId: user.role === 'ADMIN' ? user.id : null,
        createdAt: now,
        updatedAt: now,
        unreadCount: 0
      })
      setConversationOwner(id, userId)
    } catch (error) {
      if (isDbConstraintError(error)) {
        const conv = await db.query.conversations.findFirst({ where: eq(conversations.userId, userId), columns: { id: true } })
        if (conv) return sendOk(reply, { conversation: conv })
      }
      logger.error({ userId: user.id, error }, 'Conversation initiation failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to initiate conversation')
    }
    reply.code(201)
    return sendOk(reply, { conversation: { id } })
  })

  fastify.get('/:conversationId/messages', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }

    const { conversationId } = request.params as { conversationId: string }

    if (!isValidId(conversationId)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid conversation ID')
    }

    const query = paginationSchema.safeParse(request.query)
    if (!query.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid query', query.error.issues)
    }

    const conversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
      columns: { id: true, userId: true, assignedAdminId: true }
    })

    if (!conversation) {
      return sendError(reply, 404, 'NOT_FOUND', 'Conversation not found')
    }

    if (!canAccessConversation(user, conversation)) {
      return sendError(reply, 403, 'FORBIDDEN', 'Access denied')
    }

    const conditions = [
      eq(messages.conversationId, conversationId),
      isNull(messages.deletedAt),
      sql`NOT EXISTS (SELECT 1 FROM json_each(${messages.hiddenFor}) WHERE value = ${user.id})`
    ]

    if (query.data.before && isValidId(query.data.before)) {
      // Decode timestamp from ULID — no extra DB round-trip needed
      const beforeMs = decodeTime(query.data.before)
      conditions.push(lt(messages.createdAt, new Date(beforeMs)))
    }

    const messageList = await db.query.messages.findMany({
      where: and(...conditions),
      orderBy: [desc(messages.createdAt)],
      limit: query.data.limit + 1,
      with: {
        sender: {
          columns: { id: true, name: true, role: true }
        },
        media: {
          columns: { id: true, type: true, cdnUrl: true, filename: true, size: true, mimeType: true, metadata: true }
        },
        reactions: {
          with: {
            user: { columns: { id: true, name: true } }
          }
        },
        replyTo: {
          columns: { id: true, type: true, content: true, deletedAt: true },
          with: { sender: { columns: { name: true } } },
        },
        linkedAnnouncement: { columns: { id: true, title: true, type: true, template: true } },
      }
    })

    const hasMore = messageList.length > query.data.limit
    const messagesToReturn = hasMore ? messageList.slice(0, -1) : messageList

    const validatedMessages = messagesToReturn.map(msg => ({
      id: msg.id,
      conversationId: msg.conversationId,
      senderId: msg.senderId,
      sender: msg.sender,
      type: msg.type,
      content: msg.content,
      status: msg.status,
      readAt: msg.readAt,
      createdAt: msg.createdAt,
      media: msg.media,
      reactions: msg.reactions?.map(r => ({
        id: r.id,
        emoji: r.emoji,
        userId: r.userId,
        user: r.user
      })) || [],
      replyToId: msg.replyToId,
      replyTo: msg.replyTo ?? null,
      announcementId: msg.announcementId,
      linkedAnnouncement: msg.linkedAnnouncement ?? null,
    }))

    return sendOk(reply, {
      messages: validatedMessages,
      hasMore
    })
  })

  // GET a single message by ID — used for notification deep-links and reply navigation (#12)
  fastify.get('/:conversationId/messages/:messageId', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { conversationId, messageId } = request.params as { conversationId: string; messageId: string }
    if (!isValidId(conversationId) || !isValidId(messageId)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid ID')
    }

    const conversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
      columns: { id: true, userId: true, assignedAdminId: true }
    })
    if (!conversation) return sendError(reply, 404, 'NOT_FOUND', 'Conversation not found')
    if (!canAccessConversation(user, conversation)) return sendError(reply, 403, 'FORBIDDEN', 'Access denied')

    const msg = await db.query.messages.findFirst({
      where: and(
        eq(messages.id, messageId),
        eq(messages.conversationId, conversationId),
        isNull(messages.deletedAt),
        sql`NOT EXISTS (SELECT 1 FROM json_each(${messages.hiddenFor}) WHERE value = ${user.id})`
      ),
      with: {
        sender: { columns: { id: true, name: true, role: true } },
        media: { columns: { id: true, type: true, cdnUrl: true, filename: true, size: true, mimeType: true, metadata: true } },
        reactions: { with: { user: { columns: { id: true, name: true } } } },
        replyTo: {
          columns: { id: true, type: true, content: true, deletedAt: true },
          with: { sender: { columns: { name: true } } }
        },
        linkedAnnouncement: { columns: { id: true, title: true, type: true, template: true } }
      }
    })

    if (!msg) return sendError(reply, 404, 'NOT_FOUND', 'Message not found')

    return sendOk(reply, {
      message: {
        id: msg.id,
        conversationId: msg.conversationId,
        senderId: msg.senderId,
        sender: msg.sender,
        type: msg.type,
        content: msg.content,
        status: msg.status,
        readAt: msg.readAt,
        createdAt: msg.createdAt,
        media: msg.media,
        reactions: msg.reactions?.map(r => ({
          id: r.id,
          emoji: r.emoji,
          userId: r.userId,
          user: r.user
        })) ?? [],
        replyToId: msg.replyToId,
        replyTo: msg.replyTo
          ? { ...msg.replyTo, content: msg.replyTo.deletedAt ? null : msg.replyTo.content }
          : null,
        announcementId: msg.announcementId,
        linkedAnnouncement: msg.linkedAnnouncement ?? null
      }
    })
  })

  fastify.post('/:conversationId/messages', {
    preHandler: [requireApprovedUser, rateLimiters.message]
  }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }

    const { conversationId } = request.params as { conversationId: string }

    if (!isValidId(conversationId)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid conversation ID')
    }

    const body = messageSchema.safeParse(request.body)
    if (!body.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid input', body.error.issues)
    }

    const config = getConfig()

    if (body.data.type === 'TEXT' && body.data.content) {
      if (user.role === 'USER' && body.data.content.length > config.limits.message.textMaxLength) {
        return sendError(reply, 400, 'VALIDATION_ERROR', `Message too long (max ${config.limits.message.textMaxLength} characters)`)
      }
    }

    if (body.data.type !== 'TEXT' && !config.features.mediaUpload) {
      return sendError(reply, 403, 'FORBIDDEN', 'Media uploads are disabled')
    }

    const conversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
      columns: { id: true, userId: true, assignedAdminId: true, unreadCount: true, adminUnreadCount: true, lastMessageAt: true, createdAt: true, updatedAt: true }
    })

    if (!conversation) {
      return sendError(reply, 404, 'NOT_FOUND', 'Conversation not found')
    }

    if (!canAccessConversation(user, conversation)) {
      return sendError(reply, 403, 'FORBIDDEN', 'Access denied')
    }

    if (body.data.type !== 'TEXT') {
      if (!canUploadMedia(user)) {
        return sendError(reply, 403, 'FORBIDDEN', 'Media uploads not permitted')
      }

      const mediaRecord = await db.query.media.findFirst({
        where: eq(media.id, body.data.mediaId),
        columns: { id: true, status: true, type: true, messageId: true, uploadedBy: true, cdnUrl: true, filename: true, size: true, mimeType: true, metadata: true }
      })

      if (!mediaRecord || mediaRecord.status !== 'CONFIRMED') {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid or unconfirmed media')
      }

      if (mediaRecord.type !== body.data.type) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Media type does not match message type')
      }

      if (mediaRecord.messageId !== null) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Media is already attached to a message')
      }

      if (mediaRecord.uploadedBy !== user.id && !isAdmin(user)) {
        return sendError(reply, 403, 'FORBIDDEN', 'Media does not belong to you')
      }
    }

    const messageId = ulid()
    const now = new Date()
    const userIsAdmin = isAdmin(user)
    const isAdminSending = userIsAdmin && conversation.userId !== user.id
    // Capture media record reference so we can reuse it in the payload without an extra SELECT (#32)
    const mediaForPayload = body.data.type !== 'TEXT'
      ? (await db.query.media.findFirst({
        where: eq(media.id, body.data.mediaId),
        columns: { id: true, type: true, cdnUrl: true, filename: true, size: true, mimeType: true, metadata: true }
      }) ?? null)
      : null

    try {
      await db.transaction(async (tx) => {
        await tx.insert(messages).values({
          id: messageId,
          conversationId,
          senderId: user.id,
          type: body.data.type,
          content: body.data.type === 'TEXT'
            ? sanitizeText(body.data.content)
            : (body.data.content ? sanitizeText(body.data.content) : null),
          replyToId: body.data.replyToId || null,
          announcementId: body.data.announcementId || null,
        })

        // Auto-assign on first user message — use online admins only, matching socket path (#26)
        if (!userIsAdmin && !conversation.assignedAdminId) {
          const onlineAdminIds = Array.from(serverState.connectedUsers.keys()).filter(uid => {
            const cached = getUserFromCache(uid)
            return cached && cached.role === 'ADMIN'
          })
          if (onlineAdminIds.length > 0) {
            const pick = onlineAdminIds[Math.floor(Math.random() * onlineAdminIds.length)]!
            await tx.update(conversations).set({ assignedAdminId: pick }).where(eq(conversations.id, conversationId))
          }
        }

        if (body.data.type !== 'TEXT') {
          const mediaUpdateResult = await tx.update(media)
            .set({ messageId })
            .where(and(
              eq(media.id, body.data.mediaId),
              isNull(media.messageId)
            ))

          // Check rowsAffected directly — consistent with socket path (#9)
          if (!mediaUpdateResult.rowsAffected) {
            throw new Error('Media is already attached to a different message')
          }
        }

        await tx.update(conversations)
          .set({
            lastMessageAt: now,
            updatedAt: now,
            ...(isAdminSending ? { unreadCount: sql`unread_count + 1` } : { adminUnreadCount: sql`admin_unread_count + 1` })
          })
          .where(eq(conversations.id, conversationId))

        await tx.insert(auditLogs).values({
          id: ulid(),
          userId: user.id,
          ipAddress: request.ip,
          action: 'message.send',
          entityType: 'message',
          entityId: messageId,
          details: JSON.stringify({ conversationId, type: body.data.type })
        })
      })
    } catch (error) {
      logger.error({ userId: user.id, conversationId, error }, 'Message send failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to send message')
    }

    // Re-read conversation for fresh unread counts after the transaction (#4 #42)
    const updatedConversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
      columns: { unreadCount: true, adminUnreadCount: true, assignedAdminId: true }
    })
    const freshUnreadCount = updatedConversation?.unreadCount ?? 0
    const freshAdminUnreadCount = updatedConversation?.adminUnreadCount ?? 0

    // Fetch replyTo snippet only if present (1 small query vs 4-JOIN full SELECT) (#32)
    let replyToSnippet: { id: string; type: string; content: string | null; deletedAt: Date | null; sender: { name: string } | null } | null = null
    if (body.data.replyToId && isValidId(body.data.replyToId)) {
      const rt = await db.query.messages.findFirst({
        where: eq(messages.id, body.data.replyToId),
        columns: { id: true, type: true, content: true, deletedAt: true },
        with: { sender: { columns: { name: true } } }
      })
      if (rt) {
        replyToSnippet = { ...rt, content: rt.deletedAt ? null : rt.content, sender: rt.sender ?? null }
      }
    }

    // Fetch linkedAnnouncement snippet only if present (#32)
    let linkedAnnouncement: { id: string; title: string; type: string; template: string | null } | null = null
    if (body.data.announcementId && isValidId(body.data.announcementId)) {
      const { announcements } = await import('../db/schema.js')
      linkedAnnouncement = await db.query.announcements.findFirst({
        where: eq(announcements.id, body.data.announcementId),
        columns: { id: true, title: true, type: true, template: true }
      }) ?? null
    }

    // Build cached sender from state — avoids the JOIN entirely
    const cachedSender = getUserFromCache(user.id)
    const senderShape = { id: user.id, name: cachedSender?.name ?? 'Unknown', role: user.role }

    const messagePayload = {
      id: messageId,
      conversationId,
      senderId: user.id,
      sender: senderShape,
      type: body.data.type,
      content: body.data.type === 'TEXT' ? sanitizeText(body.data.content) : (body.data.content ? sanitizeText(body.data.content) : null),
      status: 'SENT',
      createdAt: now,
      media: mediaForPayload,
      replyToId: body.data.replyToId ?? null,
      replyTo: replyToSnippet,
      announcementId: body.data.announcementId ?? null,
      linkedAnnouncement,
    }

    if (userIsAdmin) {
      emitToUser(conversation.userId, 'message:new', { message: messagePayload })
    } else {
      emitToAdmins('message:new', { message: messagePayload })
      // Also notify the sender's other tabs/sessions (#5)
      emitToUser(user.id, 'message:new', { message: messagePayload })
    }

    emitToAdmins('conversation:updated', {
      conversationId,
      userId: conversation.userId,
      unreadCount: freshUnreadCount,
      adminUnreadCount: freshAdminUnreadCount,
      lastMessageAt: now.getTime(),
      lastMessage: messagePayload
    })

    if (isAdminSending) {
      queueEmailNotification(conversation.userId)
    }

    return reply.code(201).send({
      success: true,
      message: messagePayload
    })
  })

  fastify.patch('/:conversationId/assign', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    // Only SUPER_ADMIN can assign conversations
    if (user.role !== 'SUPER_ADMIN') return sendError(reply, 403, 'FORBIDDEN', 'Super admin only')

    const { conversationId } = request.params as { conversationId: string }
    if (!isValidId(conversationId)) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid conversation ID')

    const body = z.object({
      adminId: z.string().min(1).max(26).nullable(),
    }).safeParse(request.body)
    if (!body.success) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid input')

    const conversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
      with: { user: { columns: { id: true, name: true } } },
    })
    if (!conversation) return sendError(reply, 404, 'NOT_FOUND', 'Conversation not found')

    const oldAdminId = conversation.assignedAdminId
    const newAdminId = body.data.adminId

    // Validate the target admin exists and is an admin/super_admin
    if (newAdminId) {
      const targetAdmin = await db.query.users.findFirst({
        where: eq(users.id, newAdminId),
        columns: { id: true, name: true, role: true, status: true },
      })
      if (!targetAdmin || targetAdmin.status !== 'APPROVED' || (targetAdmin.role !== 'ADMIN' && targetAdmin.role !== 'SUPER_ADMIN')) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid admin target')
      }
    }

    await db.transaction(async (tx) => {
      await tx.update(conversations)
        .set({ assignedAdminId: newAdminId })
        .where(eq(conversations.id, conversationId))

      await tx.insert(auditLogs).values({
        id: ulid(),
        userId: user.id,
        ipAddress: request.ip,
        action: 'conversation.assign',
        entityType: 'conversation',
        entityId: conversationId,
        details: JSON.stringify({ oldAdminId, newAdminId })
      })
    })

    const chatUserName = conversation.user?.name ?? 'a user'

    // Notify old admin they lost this conversation
    if (oldAdminId && oldAdminId !== newAdminId) {
      emitToUser(oldAdminId, 'conversation:removed', {
        conversationId,
        userName: chatUserName,
      })
    }

    // Notify new admin they have been assigned
    if (newAdminId && newAdminId !== oldAdminId) {
      emitToUser(newAdminId, 'conversation:assigned_to_you', {
        conversationId,
        userName: chatUserName,
      })
    }

    // Broadcast assignment update to all admins (for super admin overview)
    emitToAdmins('conversation:assigned', {
      conversationId,
      assignedAdminId: newAdminId,
      oldAdminId,
    })

    return sendOk(reply, { success: true })
  })

  fastify.patch('/:conversationId/mark-read', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }

    const { conversationId } = request.params as { conversationId: string }

    if (!isValidId(conversationId)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid conversation ID')
    }

    const conversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
      columns: { id: true, userId: true, assignedAdminId: true, unreadCount: true, lastMessageAt: true }
    })

    if (!conversation) {
      return sendError(reply, 404, 'NOT_FOUND', 'Conversation not found')
    }

    if (!canAccessConversation(user, conversation)) {
      return sendError(reply, 403, 'FORBIDDEN', 'Access denied')
    }

    const now = new Date()
    const userIsAdmin = isAdmin(user)

    const senderFilter = userIsAdmin
      ? eq(messages.senderId, conversation.userId)
      : ne(messages.senderId, user.id)

    const unreadCondition = and(
      eq(messages.conversationId, conversationId),
      eq(messages.status, 'SENT'),
      isNull(messages.deletedAt),
      senderFilter
    )

    // Single UPDATE — no pre-fetch of IDs needed
    const updateResult = await db.update(messages)
      .set({ status: 'READ', readAt: now, updatedAt: now })
      .where(unreadCondition)

    const readCount = updateResult.rowsAffected ?? 0

    const isOwnerReading = conversation.userId === user.id
    if (readCount > 0) {
      if (isOwnerReading) {
        await db.update(conversations)
          .set({ unreadCount: 0, updatedAt: now })
          .where(eq(conversations.id, conversationId))
      } else if (userIsAdmin) {
        await db.update(conversations)
          .set({ adminUnreadCount: 0, updatedAt: now })
          .where(eq(conversations.id, conversationId))
      }
    }

    const readPayload = {
      conversationId,
      readBy: user.id,
      readAt: now.getTime()
    }

    if (readCount > 0) {
      emitToAdmins('messages:read', readPayload)

      if (userIsAdmin) {
        emitToAdmins('conversation:updated', {
          conversationId,
          userId: conversation.userId,
          unreadCount: conversation.unreadCount,
          adminUnreadCount: 0,
          lastMessageAt: conversation.lastMessageAt ? conversation.lastMessageAt.getTime() : null
        })
      }

      if (conversation.userId !== user.id) {
        emitToUser(conversation.userId, 'messages:read', readPayload)
      }

      if (conversation.userId === user.id) {
        cancelEmailNotification(user.id)
      }
    }

    return sendOk(reply, { readCount })
  })
}


const reactionSchema = z.object({
  emoji: z.string().min(1).max(10).regex(/^[\p{Emoji}]+$/u, 'Must be valid emoji')
})

export async function messageRoutes(fastify: FastifyInstance) {
  fastify.delete('/:messageId', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { messageId } = request.params as { messageId: string }
    if (!isValidId(messageId)) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid message ID')

    const permanent = (request.query as { permanent?: string }).permanent === 'true'
    const scopeRaw = (request.query as { scope?: string }).scope ?? 'all'
    const scope: 'me' | 'all' = scopeRaw === 'me' ? 'me' : 'all'

    const message = await db.query.messages.findFirst({
      where: permanent
        ? eq(messages.id, messageId)
        : and(
          eq(messages.id, messageId),
          isNull(messages.deletedAt)
        ),
      columns: { id: true, senderId: true, conversationId: true, hiddenFor: true, createdAt: true, deletedAt: true }
    })

    if (!message) return sendError(reply, 404, 'NOT_FOUND', 'Message not found')

    // unified permissions check
    if (!canDeleteMessage(user, message as any, scope)) {
      return sendError(reply, 403, 'FORBIDDEN', 'Cannot delete this message or time limit exceeded')
    }

    if (permanent && user.role !== 'SUPER_ADMIN') {
      return sendError(reply, 403, 'FORBIDDEN', 'Only super admins can permanently delete messages')
    }

    const conversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, message.conversationId),
      columns: { id: true, userId: true, assignedAdminId: true }
    })

    const now = new Date()

    try {
      await db.transaction(async (tx) => {
        if (permanent) {
          await tx.delete(messages).where(eq(messages.id, messageId))
        } else if (scope === 'me') {
          let hidden: string[] = []
          try { hidden = JSON.parse(message.hiddenFor ?? '[]') } catch { hidden = [] }
          if (!hidden.includes(user.id)) hidden.push(user.id)

          await tx.update(messages)
            .set({ hiddenFor: JSON.stringify(hidden), updatedAt: now })
            .where(eq(messages.id, messageId))
        } else {
          // scope === 'all' (soft delete for everyone)
          await tx.update(messages)
            .set({ deletedAt: now, deletedBy: user.id, updatedAt: now })
            .where(eq(messages.id, messageId))
        }

        await tx.insert(auditLogs).values({
          id: ulid(),
          userId: user.id,
          ipAddress: request.ip,
          action: permanent ? 'message.delete_permanent' : (scope === 'me' ? 'message.hide' : 'message.delete'),
          entityType: 'message',
          entityId: messageId,
          details: JSON.stringify({ conversationId: message.conversationId, permanent, scope })
        })
      })
    } catch (error) {
      logger.error({ userId: user.id, messageId, error }, 'Message delete failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to delete message')
    }

    // Only emit deletion events if we actually deleted it for everyone (soft or perm)
    if (scope === 'all' || permanent) {
      const payload = { messageId, conversationId: message.conversationId, deletedBy: user.id, deletedAt: now.getTime() }
      emitToAdmins('message:deleted', payload)
      if (conversation) emitToUser(conversation.userId, 'message:deleted', payload)
    }

    return sendOk(reply, { success: true })
  })
}

export async function reactionRoutes(fastify: FastifyInstance) {
  fastify.post('/:messageId/reactions', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }

    const { messageId } = request.params as { messageId: string }

    if (!isValidId(messageId)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid message ID')
    }

    const body = reactionSchema.safeParse(request.body)
    if (!body.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid emoji', body.error.issues)
    }

    const message = await db.query.messages.findFirst({
      where: and(eq(messages.id, messageId), isNull(messages.deletedAt)),
      columns: { id: true, conversationId: true }
    })

    if (!message) {
      return sendError(reply, 404, 'NOT_FOUND', 'Message not found')
    }

    const conversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, message.conversationId),
      columns: { id: true, userId: true, assignedAdminId: true }
    })

    if (!conversation || !canAccessConversation(user, conversation)) {
      return sendError(reply, 403, 'FORBIDDEN', 'Access denied')
    }

    const reactionId = ulid()

    try {
      // Single upsert: ON CONFLICT (messageId, userId) replaces the emoji
      await db.insert(messageReactions)
        .values({ id: reactionId, messageId, userId: user.id, emoji: body.data.emoji })
        .onConflictDoUpdate({
          target: [messageReactions.messageId, messageReactions.userId],
          set: { emoji: body.data.emoji, id: reactionId }
        })
    } catch (error) {
      const err = error as { code?: string }
      if (err.code === 'SQLITE_CONSTRAINT') {
        return sendOk(reply, { success: true, alreadyReacted: true })
      }
      logger.error({ userId: user.id, messageId, error }, 'Reaction add failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to add reaction')
    }

    const userName = serverState.userNames.get(user.id) || 'Unknown'
    const reaction = {
      id: reactionId,
      messageId,
      userId: user.id,
      emoji: body.data.emoji,
      user: { id: user.id, name: userName }
    }

    emitToAdmins('message:reaction', { messageId, reaction, action: 'add' })
    emitToUser(conversation.userId, 'message:reaction', { messageId, reaction, action: 'add' })

    return reply.code(201).send({ success: true, reaction })
  })

  fastify.delete('/:messageId/reactions/:emoji', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }

    const { messageId, emoji } = request.params as { messageId: string; emoji: string }

    if (!isValidId(messageId)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid message ID')
    }

    const message = await db.query.messages.findFirst({
      where: and(eq(messages.id, messageId), isNull(messages.deletedAt)),
      columns: { id: true, conversationId: true }
    })

    if (!message) {
      return sendError(reply, 404, 'NOT_FOUND', 'Message not found')
    }

    const conversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, message.conversationId),
      columns: { id: true, userId: true, assignedAdminId: true }
    })

    if (!conversation || !canAccessConversation(user, conversation)) {
      return sendError(reply, 403, 'FORBIDDEN', 'Access denied')
    }

    let decodedEmoji: string
    try {
      decodedEmoji = decodeURIComponent(emoji)
    } catch {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid emoji')
    }

    if (!/^[\p{Emoji}]+$/u.test(decodedEmoji)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid emoji')
    }

    const reaction = await db.query.messageReactions.findFirst({
      where: and(
        eq(messageReactions.messageId, messageId),
        eq(messageReactions.userId, user.id)
      ),
      columns: { id: true }
    })

    if (!reaction) {
      return sendError(reply, 404, 'NOT_FOUND', 'Reaction not found')
    }

    await db.delete(messageReactions).where(eq(messageReactions.id, reaction.id))

    emitToAdmins('message:reaction', {
      messageId,
      reaction: { userId: user.id, emoji: decodedEmoji },
      action: 'remove'
    })
    emitToUser(conversation.userId, 'message:reaction', {
      messageId,
      reaction: { userId: user.id, emoji: decodedEmoji },
      action: 'remove'
    })

    return sendOk(reply, { success: true })
  })
}