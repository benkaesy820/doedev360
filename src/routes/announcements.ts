import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { desc, eq, and, isNull, gt, lt, sql, or, inArray, asc } from 'drizzle-orm'
import { ulid, decodeTime } from 'ulid'
import { db } from '../db/index.js'
import { announcements, announcementVotes, announcementReactions, announcementComments, auditLogs, media } from '../db/schema.js'
import { requireAdmin, requireApprovedUser, requireUser, sendError, sendOk } from '../middleware/auth.js'
import { isAdmin } from '../lib/permissions.js'
import { emitToAdmins, emitToUsers } from '../socket/index.js'
import { sanitizeText, escapeHtml, isValidId } from '../lib/utils.js'
import { logger } from '../lib/logger.js'
import { serverState, getUserFromCache } from '../state.js'

const reactionSchema = z.object({
  emoji: z.string().min(1).max(10),
})

const commentSchema = z.object({
  content: z.string().min(1).max(1000).transform((s) => sanitizeText(s.trim())),
})

const commentListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.string().optional(),
})

const createAnnouncementSchema = z.object({
  title: z.string().min(1).max(200).transform(s => escapeHtml(s.trim())),
  content: z.string().min(1).max(10000).transform(s => sanitizeText(s)),
  type: z.enum(['INFO', 'WARNING', 'IMPORTANT']).default('INFO'),
  template: z.enum(['DEFAULT', 'BANNER', 'CARD', 'MINIMAL']).default('DEFAULT'),
  mediaId: z.string().optional(),
  targetRoles: z.array(z.enum(['USER', 'ADMIN', 'SUPER_ADMIN'])).max(3).optional(),
  expiresAt: z.string().datetime().optional(),
})

const updateAnnouncementSchema = z.object({
  title: z.string().min(1).max(200).transform(s => escapeHtml(s.trim())).optional(),
  content: z.string().min(1).max(10000).transform(s => sanitizeText(s)).optional(),
  type: z.enum(['INFO', 'WARNING', 'IMPORTANT']).optional(),
  template: z.enum(['DEFAULT', 'BANNER', 'CARD', 'MINIMAL']).optional(),
  mediaId: z.string().nullable().optional(),
  targetRoles: z.array(z.enum(['USER', 'ADMIN', 'SUPER_ADMIN'])).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  isActive: z.boolean().optional(),
})

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.string().optional(),
  includeInactive: z.coerce.boolean().optional(),
})

const voteSchema = z.object({
  vote: z.enum(['UP', 'DOWN']),
})

type RoleTarget = 'USER' | 'ADMIN' | 'SUPER_ADMIN'

function parseTargetRoles(rawTargetRoles: string | null): RoleTarget[] | null {
  if (!rawTargetRoles) {
    return null
  }

  try {
    const parsed = JSON.parse(rawTargetRoles)
    if (!Array.isArray(parsed)) {
      return null
    }

    const roles = parsed.filter((role): role is RoleTarget => (
      role === 'USER' || role === 'ADMIN' || role === 'SUPER_ADMIN'
    ))

    return roles.length > 0 ? roles : null
  } catch {
    return null
  }
}

function canUserAccessAnnouncement(
  userRole: RoleTarget,
  announcement: { isActive: boolean; expiresAt: Date | null; targetRoles: string | null },
  now: Date
): boolean {
  if (!announcement.isActive) {
    return false
  }

  if (announcement.expiresAt && announcement.expiresAt <= now) {
    return false
  }

  const targetRoles = parseTargetRoles(announcement.targetRoles)
  if (!targetRoles) {
    return true
  }

  return targetRoles.includes(userRole)
}

async function validateAnnouncementMediaId(mediaId: string): Promise<boolean> {
  const mediaRecord = await db.query.media.findFirst({
    where: eq(media.id, mediaId),
    columns: { id: true, status: true }
  })
  return !!mediaRecord && mediaRecord.status === 'CONFIRMED'
}

export async function announcementRoutes(fastify: FastifyInstance) {
  fastify.get('/', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }

    const query = listSchema.safeParse(request.query)
    if (!query.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid query', query.error.issues)
    }

    const userIsAdmin = isAdmin(user)
    const now = new Date()

    const conditions = []

    if (!query.data.includeInactive || !userIsAdmin) {
      conditions.push(eq(announcements.isActive, true))
      conditions.push(or(
        isNull(announcements.expiresAt),
        gt(announcements.expiresAt, now)
      ))
    }

    if (query.data.before && isValidId(query.data.before)) {
      const beforeMs = decodeTime(query.data.before)
      conditions.push(lt(announcements.createdAt, new Date(beforeMs)))
    }

    // For non-admin users, filter targetRoles in SQL:
    // include rows where targetRoles is null (applies to all) OR where it contains the user's role.
    // This keeps the DB LIMIT accurate so hasMore is never misstated (#33).
    if (!userIsAdmin || (userIsAdmin && !query.data.includeInactive)) {
      conditions.push(
        or(
          isNull(announcements.targetRoles),
          sql`json_type(${announcements.targetRoles}) = 'array' AND EXISTS (
            SELECT 1 FROM json_each(${announcements.targetRoles}) WHERE value = ${user.role}
          )`
        )
      )
    }

    const result = await db.query.announcements.findMany({
      where: conditions.length > 0 ? and(...conditions.map(c => c)) : undefined,
      orderBy: [desc(announcements.createdAt)],
      limit: query.data.limit + 1,
      with: {
        author: { columns: { id: true, name: true, role: true } },
        mediaAttachment: { columns: { id: true, type: true, cdnUrl: true, filename: true, size: true, mimeType: true } },
      }
    })

    const hasMore = result.length > query.data.limit
    const items = hasMore ? result.slice(0, -1) : result

    const annIds = items.map(a => a.id)
    const userVotes = annIds.length > 0
      ? await db.query.announcementVotes.findMany({
        where: and(
          eq(announcementVotes.userId, user.id),
          inArray(announcementVotes.announcementId, annIds)
        ),
        columns: { announcementId: true, vote: true }
      })
      : []

    const voteMap = new Map(userVotes.map(v => [v.announcementId, v.vote]))

    const enriched = items.map(ann => ({
      id: ann.id,
      title: ann.title,
      content: ann.content,
      type: ann.type,
      template: ann.template,
      targetRoles: parseTargetRoles(ann.targetRoles),
      mediaAttachment: ann.mediaAttachment || null,
      author: ann.author,
      upvoteCount: ann.upvoteCount,
      downvoteCount: ann.downvoteCount,
      userVote: voteMap.get(ann.id) || null,
      isActive: ann.isActive,
      createdBy: ann.createdBy,
      createdAt: ann.createdAt,
      expiresAt: ann.expiresAt,
    }))

    return sendOk(reply, { announcements: enriched, hasMore })
  })

  fastify.post('/', { preHandler: requireAdmin }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }

    const body = createAnnouncementSchema.safeParse(request.body)
    if (!body.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid input', body.error.issues)
    }

    if (body.data.mediaId) {
      if (!isValidId(body.data.mediaId)) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid media ID')
      }

      const mediaIsValid = await validateAnnouncementMediaId(body.data.mediaId)
      if (!mediaIsValid) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid or unconfirmed media')
      }
    }

    const id = ulid()
    const now = new Date()

    try {
      await db.transaction(async (tx) => {
        await tx.insert(announcements).values({
          id,
          title: body.data.title,
          content: body.data.content,
          type: body.data.type,
          template: body.data.template,
          mediaId: body.data.mediaId || null,
          targetRoles: body.data.targetRoles ? JSON.stringify(body.data.targetRoles) : null,
          createdBy: user.id,
          createdAt: now,
          expiresAt: body.data.expiresAt ? new Date(body.data.expiresAt) : null,
          isActive: true,
        })

        await tx.insert(auditLogs).values({
          id: ulid(),
          userId: user.id,
          ipAddress: request.ip,
          action: 'announcement.create',
          entityType: 'announcement',
          entityId: id,
          details: JSON.stringify({
            title: body.data.title,
            type: body.data.type,
          })
        })
      })
    } catch (error) {
      logger.error({ userId: user.id, error }, 'Announcement create failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to create announcement')
    }

    const raw = await db.query.announcements.findFirst({
      where: eq(announcements.id, id),
      with: {
        author: { columns: { id: true, name: true, role: true } },
        mediaAttachment: { columns: { id: true, type: true, cdnUrl: true, filename: true, size: true, mimeType: true } },
      }
    })

    const announcement = raw ? {
      ...raw,
      targetRoles: parseTargetRoles(raw.targetRoles),
      mediaAttachment: raw.mediaAttachment || null,
      userVote: null,
    } : null

    try {
      const roles = parseTargetRoles(body.data.targetRoles ? JSON.stringify(body.data.targetRoles) : null)
      if (!roles) {
        emitToAdmins('announcement:new', { announcement })
        emitToUsers('announcement:new', { announcement })
      } else {
        if (roles.includes('ADMIN') || roles.includes('SUPER_ADMIN')) {
          emitToAdmins('announcement:new', { announcement })
        }
        if (roles.includes('USER')) {
          emitToUsers('announcement:new', { announcement })
        }
      }
    } catch { logger.debug('Socket not initialized, skipping announcement broadcast') }

    return sendOk(reply, { announcement })
  })

  fastify.get('/:id', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { id } = request.params as { id: string }
    if (!isValidId(id)) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid announcement ID')

    const raw = await db.query.announcements.findFirst({
      where: eq(announcements.id, id),
      with: {
        author: { columns: { id: true, name: true, role: true } },
        mediaAttachment: { columns: { id: true, type: true, cdnUrl: true, filename: true, size: true, mimeType: true } },
      }
    })

    if (!raw) return sendError(reply, 404, 'NOT_FOUND', 'Announcement not found')

    const userIsAdmin = isAdmin(user)
    const now = new Date()
    if (!userIsAdmin && !canUserAccessAnnouncement(user.role, raw, now)) {
      return sendError(reply, 403, 'FORBIDDEN', 'Access denied')
    }

    const [userVoteRow, reactionRows] = await Promise.all([
      db.query.announcementVotes.findFirst({
        where: and(eq(announcementVotes.userId, user.id), eq(announcementVotes.announcementId, id)),
        columns: { vote: true },
      }),
      db.query.announcementReactions.findMany({
        where: eq(announcementReactions.announcementId, id),
        columns: { id: true, emoji: true, userId: true },
      }),
    ])

    const userReaction = reactionRows.find((r) => r.userId === user.id) ?? null

    const announcement = {
      id: raw.id,
      title: raw.title,
      content: raw.content,
      type: raw.type,
      template: raw.template,
      targetRoles: parseTargetRoles(raw.targetRoles),
      mediaAttachment: raw.mediaAttachment || null,
      author: raw.author,
      upvoteCount: raw.upvoteCount,
      downvoteCount: raw.downvoteCount,
      userVote: userVoteRow?.vote ?? null,
      isActive: raw.isActive,
      createdBy: raw.createdBy,
      createdAt: raw.createdAt,
      expiresAt: raw.expiresAt,
      reactions: reactionRows,
      userReaction,
    }

    return sendOk(reply, { announcement })
  })

  fastify.patch('/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }

    const { id } = request.params as { id: string }

    if (!isValidId(id)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid announcement ID')
    }

    const body = updateAnnouncementSchema.safeParse(request.body)
    if (!body.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid input', body.error.issues)
    }

    const existing = await db.query.announcements.findFirst({
      where: eq(announcements.id, id)
    })
    if (!existing) {
      return sendError(reply, 404, 'NOT_FOUND', 'Announcement not found')
    }

    const updates: Record<string, unknown> = {}
    if (body.data.title !== undefined) updates.title = body.data.title
    if (body.data.content !== undefined) updates.content = body.data.content
    if (body.data.type !== undefined) updates.type = body.data.type
    if (body.data.template !== undefined) updates.template = body.data.template
    if (body.data.mediaId !== undefined) {
      if (body.data.mediaId !== null) {
        if (!isValidId(body.data.mediaId)) {
          return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid media ID')
        }

        const mediaIsValid = await validateAnnouncementMediaId(body.data.mediaId)
        if (!mediaIsValid) {
          return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid or unconfirmed media')
        }
      }

      updates.mediaId = body.data.mediaId
    }
    if (body.data.targetRoles !== undefined) {
      updates.targetRoles = body.data.targetRoles ? JSON.stringify(body.data.targetRoles) : null
    }
    if (body.data.expiresAt !== undefined) {
      updates.expiresAt = body.data.expiresAt ? new Date(body.data.expiresAt) : null
    }
    if (body.data.isActive !== undefined) {
      updates.isActive = body.data.isActive
    }

    if (Object.keys(updates).length > 0) {
      await db.transaction(async (tx) => {
        await tx.update(announcements).set(updates).where(eq(announcements.id, id))

        await tx.insert(auditLogs).values({
          id: ulid(),
          userId: user.id,
          ipAddress: request.ip,
          action: 'announcement.update',
          entityType: 'announcement',
          entityId: id,
          details: JSON.stringify({
            title: body.data.title ?? existing.title,
            changes: Object.keys(updates)
          })
        })
      })
    }

    const raw = await db.query.announcements.findFirst({
      where: eq(announcements.id, id),
      with: {
        author: { columns: { id: true, name: true, role: true } },
        mediaAttachment: { columns: { id: true, type: true, cdnUrl: true, filename: true, size: true, mimeType: true } },
      }
    })

    const updated = raw ? {
      ...raw,
      targetRoles: parseTargetRoles(raw.targetRoles),
      mediaAttachment: raw.mediaAttachment || null,
      userVote: null,
    } : null

    // Broadcast to all connected clients so they can update their cache immediately.
    // If isActive was toggled off, users will remove it from their list.
    try {
      emitToAdmins('announcement:updated', { announcement: updated })
      emitToUsers('announcement:updated', { announcement: updated })
    } catch { logger.debug('Socket not initialized, skipping announcement:updated broadcast') }

    return sendOk(reply, { announcement: updated })
  })

  fastify.post('/:id/vote', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }

    const { id } = request.params as { id: string }

    if (!isValidId(id)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid announcement ID')
    }

    const body = voteSchema.safeParse(request.body)
    if (!body.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid input', body.error.issues)
    }

    const ann = await db.query.announcements.findFirst({
      where: eq(announcements.id, id)
    })

    const now = new Date()
    const userIsAdmin = isAdmin(user)
    if (!ann || (!userIsAdmin && !canUserAccessAnnouncement(user.role, ann, now))) {
      return sendError(reply, 404, 'NOT_FOUND', 'Announcement not found')
    }

    try {
      const result = await db.transaction(async (tx) => {
        const existing = await tx.query.announcementVotes.findFirst({
          where: and(
            eq(announcementVotes.announcementId, id),
            eq(announcementVotes.userId, user.id),
          )
        })

        if (existing) {
          if (existing.vote === body.data.vote) {
            await tx.delete(announcementVotes).where(eq(announcementVotes.id, existing.id))

            if (body.data.vote === 'UP') {
              await tx.update(announcements)
                .set({ upvoteCount: sql`CASE WHEN upvote_count > 0 THEN upvote_count - 1 ELSE 0 END` })
                .where(eq(announcements.id, id))
            } else {
              await tx.update(announcements)
                .set({ downvoteCount: sql`CASE WHEN downvote_count > 0 THEN downvote_count - 1 ELSE 0 END` })
                .where(eq(announcements.id, id))
            }

            return { vote: null }
          } else {
            await tx.update(announcementVotes)
              .set({ vote: body.data.vote, createdAt: new Date() })
              .where(eq(announcementVotes.id, existing.id))

            if (body.data.vote === 'UP') {
              await tx.update(announcements)
                .set({
                  upvoteCount: sql`upvote_count + 1`,
                  downvoteCount: sql`CASE WHEN downvote_count > 0 THEN downvote_count - 1 ELSE 0 END`,
                })
                .where(eq(announcements.id, id))
            } else {
              await tx.update(announcements)
                .set({
                  downvoteCount: sql`downvote_count + 1`,
                  upvoteCount: sql`CASE WHEN upvote_count > 0 THEN upvote_count - 1 ELSE 0 END`,
                })
                .where(eq(announcements.id, id))
            }

            return { vote: body.data.vote }
          }
        }

        await tx.insert(announcementVotes).values({
          id: ulid(),
          announcementId: id,
          userId: user.id,
          vote: body.data.vote,
        })

        if (body.data.vote === 'UP') {
          await tx.update(announcements)
            .set({ upvoteCount: sql`upvote_count + 1` })
            .where(eq(announcements.id, id))
        } else {
          await tx.update(announcements)
            .set({ downvoteCount: sql`downvote_count + 1` })
            .where(eq(announcements.id, id))
        }

        return { vote: body.data.vote }
      })

      return sendOk(reply, result)
    } catch (error) {
      logger.error({ userId: user.id, announcementId: id, error }, 'Vote failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to process vote')
    }
  })

  fastify.delete('/:id/vote', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }

    const { id } = request.params as { id: string }

    if (!isValidId(id)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid announcement ID')
    }

    const ann = await db.query.announcements.findFirst({
      where: eq(announcements.id, id)
    })

    const now = new Date()
    if (!ann || !canUserAccessAnnouncement(user.role, ann, now)) {
      return sendError(reply, 404, 'NOT_FOUND', 'Announcement not found')
    }

    try {
      await db.transaction(async (tx) => {
        const existing = await tx.query.announcementVotes.findFirst({
          where: and(
            eq(announcementVotes.announcementId, id),
            eq(announcementVotes.userId, user.id),
          )
        })

        if (!existing) {
          return
        }

        await tx.delete(announcementVotes).where(eq(announcementVotes.id, existing.id))

        if (existing.vote === 'UP') {
          await tx.update(announcements)
            .set({ upvoteCount: sql`MAX(0, upvote_count - 1)` })
            .where(eq(announcements.id, id))
        } else {
          await tx.update(announcements)
            .set({ downvoteCount: sql`MAX(0, downvote_count - 1)` })
            .where(eq(announcements.id, id))
        }
      })

      return sendOk(reply, { vote: null })
    } catch (error) {
      logger.error({ userId: user.id, announcementId: id, error }, 'Vote removal failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to remove vote')
    }
  })

  fastify.delete('/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }

    const { id } = request.params as { id: string }

    if (!isValidId(id)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid announcement ID')
    }

    const existing = await db.query.announcements.findFirst({
      where: eq(announcements.id, id)
    })
    if (!existing) {
      return sendError(reply, 404, 'NOT_FOUND', 'Announcement not found')
    }

    await db.transaction(async (tx) => {
      await tx.update(announcements)
        .set({ isActive: false })
        .where(eq(announcements.id, id))

      await tx.insert(auditLogs).values({
        id: ulid(),
        userId: user.id,
        ipAddress: request.ip,
        action: 'announcement.delete',
        entityType: 'announcement',
        entityId: id,
        details: JSON.stringify({ title: existing.title })
      })
    })

    return sendOk(reply, { message: 'Announcement removed' })
  })

  // ── Reactions ───────────────────────────────────────────────────────────────

  // POST /:id/reaction — add or replace the current user's emoji reaction
  fastify.post('/:id/reaction', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { id } = request.params as { id: string }
    if (!isValidId(id)) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid ID')

    const ann = await db.query.announcements.findFirst({ where: eq(announcements.id, id), columns: { id: true, isActive: true } })
    if (!ann || !ann.isActive) return sendError(reply, 404, 'NOT_FOUND', 'Announcement not found')

    const body = reactionSchema.safeParse(request.body)
    if (!body.success) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid emoji')

    // Upsert: single INSERT OR REPLACE instead of DELETE + INSERT
    const newId = ulid()
    await db.insert(announcementReactions).values({
      id: newId,
      announcementId: id,
      userId: user.id,
      emoji: body.data.emoji,
    }).onConflictDoUpdate({
      target: [announcementReactions.announcementId, announcementReactions.userId],
      set: { emoji: body.data.emoji, id: newId }
    })
    return sendOk(reply, { reaction: { id: newId, emoji: body.data.emoji, userId: user.id } })
  })

  // DELETE /:id/reaction — remove current user's reaction
  fastify.delete('/:id/reaction', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { id } = request.params as { id: string }
    if (!isValidId(id)) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid ID')

    await db.delete(announcementReactions).where(
      and(eq(announcementReactions.announcementId, id), eq(announcementReactions.userId, user.id))
    )
    return sendOk(reply, { reaction: null })
  })

  // ── Comments ────────────────────────────────────────────────────────────────

  // GET /:id/comments — paginated, newest first (with before cursor)
  fastify.get('/:id/comments', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { id } = request.params as { id: string }
    if (!isValidId(id)) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid ID')

    const query = commentListSchema.safeParse(request.query)
    if (!query.success) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid query')

    const { limit, before } = query.data
    const conditions = [
      eq(announcementComments.announcementId, id),
      isNull(announcementComments.deletedAt),
    ]

    if (before && isValidId(before)) {
      const beforeMs = decodeTime(before)
      conditions.push(lt(announcementComments.createdAt, new Date(beforeMs)))
    }

    const rows = await db.query.announcementComments.findMany({
      where: and(...conditions),
      orderBy: [desc(announcementComments.createdAt)],
      limit: limit + 1,
      with: {
        user: { columns: { id: true, name: true, role: true } },
      },
    })

    const hasMore = rows.length > limit
    const comments = rows.slice(0, limit).map((c) => ({
      id: c.id,
      content: c.content,
      createdAt: c.createdAt,
      user: c.user,
    }))

    return sendOk(reply, { comments, hasMore })
  })

  // POST /:id/comments — add a comment (approved users only)
  fastify.post('/:id/comments', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { id } = request.params as { id: string }
    if (!isValidId(id)) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid ID')

    const ann = await db.query.announcements.findFirst({ where: eq(announcements.id, id), columns: { id: true, isActive: true } })
    if (!ann || !ann.isActive) return sendError(reply, 404, 'NOT_FOUND', 'Announcement not found')

    const body = commentSchema.safeParse(request.body)
    if (!body.success) return sendError(reply, 400, 'VALIDATION_ERROR', body.error.errors[0]?.message ?? 'Invalid content')

    const newId = ulid()
    await db.insert(announcementComments).values({
      id: newId,
      announcementId: id,
      userId: user.id,
      content: body.data.content,
    })

    const cachedUser = getUserFromCache(user.id)
    const userName = cachedUser?.name ?? 'User'

    const comment = {
      id: newId,
      content: body.data.content,
      createdAt: new Date(),
      user: { id: user.id, name: userName, role: user.role },
    }

    return sendOk(reply, { comment })
  })

  // DELETE /:id/comments/:commentId — soft delete (own comment or admin)
  fastify.delete('/:id/comments/:commentId', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { id, commentId } = request.params as { id: string; commentId: string }
    if (!isValidId(id) || !isValidId(commentId)) return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid ID')

    const comment = await db.query.announcementComments.findFirst({
      where: and(eq(announcementComments.id, commentId), eq(announcementComments.announcementId, id)),
      columns: { id: true, userId: true, deletedAt: true },
    })

    if (!comment || comment.deletedAt) return sendError(reply, 404, 'NOT_FOUND', 'Comment not found')

    const canDelete = comment.userId === user.id || user.role === 'ADMIN' || user.role === 'SUPER_ADMIN'
    if (!canDelete) return sendError(reply, 403, 'FORBIDDEN', 'Cannot delete this comment')

    await db.update(announcementComments)
      .set({ deletedAt: new Date() })
      .where(eq(announcementComments.id, commentId))

    return sendOk(reply, { deleted: true })
  })
}