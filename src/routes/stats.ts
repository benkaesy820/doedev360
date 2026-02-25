import type { FastifyInstance } from 'fastify'
import { sql, and, isNull, gt, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users, conversations, messages, sessions, announcements } from '../db/schema.js'
import { requireAdmin, sendOk, sendError } from '../middleware/auth.js'
import { logger } from '../lib/logger.js'

const STATS_CACHE_TTL_MS = 30_000
let statsCache: { data: unknown; expiresAt: number } | null = null

export async function statsRoutes(fastify: FastifyInstance) {
    fastify.get('/', { preHandler: requireAdmin }, async (_request, reply) => {
        if (statsCache && statsCache.expiresAt > Date.now()) {
            return sendOk(reply, statsCache.data as Record<string, unknown>)
        }

        try {
            const now = new Date()
            
            const [
                userStats,
                conversationCount,
                messageCount,
                activeSessionCount,
                announcementCount,
            ] = await Promise.all([
                db.select({
                    status: users.status,
                    count: sql<number>`count(*)`.as('count'),
                })
                    .from(users)
                    .where(eq(users.role, 'USER'))
                    .groupBy(users.status),

                db.select({ count: sql<number>`count(*)`.as('count') })
                    .from(conversations),

                db.select({ count: sql<number>`count(*)`.as('count') })
                    .from(messages)
                    .where(isNull(messages.deletedAt)),

                db.select({ count: sql<number>`count(*)`.as('count') })
                    .from(sessions)
                    .where(and(
                        isNull(sessions.revokedAt),
                        gt(sessions.expiresAt, now)
                    )),

                db.select({ count: sql<number>`count(*)`.as('count') })
                    .from(announcements)
                    .where(eq(announcements.isActive, true)),
            ])

            const statusMap: Record<string, number> = {}
            let totalUsers = 0
            for (const row of userStats) {
                statusMap[row.status] = Number(row.count)
                totalUsers += Number(row.count)
            }

            const payload = {
                stats: {
                    users: {
                        total: totalUsers,
                        pending: statusMap['PENDING'] ?? 0,
                        approved: statusMap['APPROVED'] ?? 0,
                        rejected: statusMap['REJECTED'] ?? 0,
                        suspended: statusMap['SUSPENDED'] ?? 0,
                    },
                    conversations: Number(conversationCount[0]?.count ?? 0),
                    messages: Number(messageCount[0]?.count ?? 0),
                    activeSessions: Number(activeSessionCount[0]?.count ?? 0),
                    activeAnnouncements: Number(announcementCount[0]?.count ?? 0),
                },
            }
            statsCache = { data: payload, expiresAt: Date.now() + STATS_CACHE_TTL_MS }
            return sendOk(reply, payload)
        } catch (error) {
            logger.error({ error }, 'Stats query failed')
            return sendError(reply, 503, 'INTERNAL_ERROR', 'Failed to fetch stats')
        }
    })
}
