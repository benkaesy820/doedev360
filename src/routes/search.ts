import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { or, like, eq, isNull, desc, and, inArray } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users, conversations, announcements, messages } from '../db/schema.js'
import { requireAdmin, requireUser, sendError, sendOk } from '../middleware/auth.js'

const searchSchema = z.object({
  q: z.string().min(1).max(100).trim(),
  type: z.enum(['all', 'users', 'conversations', 'announcements', 'messages']).default('all'),
  limit: z.coerce.number().int().min(1).max(20).default(5),
})

export async function searchRoutes(fastify: FastifyInstance) {
  fastify.get('/search', { preHandler: requireAdmin }, async (request, reply) => {
    const actor = requireUser(request, reply)
    if (!actor) return

    const parsed = searchSchema.safeParse(request.query)
    if (!parsed.success) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid query')

    const { q, type, limit } = parsed.data
    const pattern = `%${q}%`
    const prefixPattern = `${q}%`

    // Step 1: find users matching the query (needed for both users and conversations results)
    const needUsers = type === 'all' || type === 'users' || type === 'conversations'
    const matchingUsers = needUsers
      ? await db.query.users.findMany({
        where: or(like(users.name, pattern), like(users.email, prefixPattern)),
        columns: { id: true, name: true, email: true, role: true, status: true, createdAt: true },
        orderBy: [desc(users.createdAt)],
        limit: limit * 2,
      })
      : []

    const matchingUserIds = matchingUsers.map((u) => u.id)

    // Step 2: parallel fetch of all result types
    const [matchConversations, matchAnnouncements, matchMessages] = await Promise.all([
      (type === 'all' || type === 'conversations') && matchingUserIds.length > 0
        ? db.query.conversations.findMany({
          where: and(
            inArray(conversations.userId, matchingUserIds),
            actor.role === 'ADMIN' ? eq(conversations.assignedAdminId, actor.id) : undefined
          ),
          with: { user: { columns: { id: true, name: true, email: true, status: true } } },
          columns: { id: true, lastMessageAt: true, unreadCount: true, adminUnreadCount: true, assignedAdminId: true },
          orderBy: [desc(conversations.lastMessageAt)],
          limit,
        })
        : Promise.resolve([]),

      (type === 'all' || type === 'announcements')
        ? db.query.announcements.findMany({
          where: or(like(announcements.title, pattern), like(announcements.content, pattern)),
          columns: { id: true, title: true, type: true, isActive: true, createdAt: true },
          orderBy: [desc(announcements.createdAt)],
          limit,
        })
        : Promise.resolve([]),

      (type === 'all' || type === 'messages')
        ? db.query.messages.findMany({
          where: and(
            like(messages.content, pattern),
            isNull(messages.deletedAt),
            eq(messages.type, 'TEXT'),
            actor.role === 'ADMIN' ? inArray(messages.conversationId,
              db.select({ id: conversations.id }).from(conversations).where(eq(conversations.assignedAdminId, actor.id))
            ) : undefined
          ),
          columns: { id: true, conversationId: true, content: true, createdAt: true },
          with: { sender: { columns: { id: true, name: true, role: true } } },
          orderBy: [desc(messages.createdAt)],
          limit,
        })
        : Promise.resolve([]),
    ])

    const matchUsers = type === 'all' || type === 'users'
      ? matchingUsers.filter((_, i) => i < limit)
      : []

    return sendOk(reply, {
      users: matchUsers,
      conversations: matchConversations,
      announcements: matchAnnouncements,
      messages: matchMessages,
    })
  })
}
