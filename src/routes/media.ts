import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import crypto from 'crypto'
import { eq, and } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '../db/index.js'
import { media, auditLogs, messages, conversations } from '../db/schema.js'
import { requireApprovedUser, requireUser, sendError, sendOk } from '../middleware/auth.js'
import { canUploadMedia, isAdmin } from '../lib/permissions.js'
import { createRateLimiters } from '../middleware/rateLimit.js'
import { getConfig, isAllowedMimeType, getMaxFileSize, normalizeMimeType } from '../lib/config.js'
import { generateUploadUrl, getCdnUrl, deleteFromR2, uploadToR2, getSignedR2Url } from '../services/storage.js'
import { serverState } from '../state.js'
import { sanitizeFilename, isValidId, validateFileSignature } from '../lib/utils.js'
import { logger } from '../lib/logger.js'

const DEFAULT_STREAM_RATE_LIMIT_WINDOW_MS = 60000
const DEFAULT_STREAM_RATE_LIMIT_MAX_REQUESTS = 30
const DEFAULT_STREAM_RATE_LIMIT_MAX_ENTRIES = 10000
const DEFAULT_STREAM_RATE_LIMIT_CLEANUP_INTERVAL_MS = 60000
const streamRateLimiters = new Map<string, { count: number; resetAt: number }>()

function getStreamRateLimitConfig(): {
  windowMs: number
  maxRequests: number
  maxEntries: number
  cleanupIntervalMs: number
} {
  const streamConfig = getConfig().rateLimit.stream
  return {
    windowMs: streamConfig?.windowMs ?? DEFAULT_STREAM_RATE_LIMIT_WINDOW_MS,
    maxRequests: streamConfig?.maxRequests ?? DEFAULT_STREAM_RATE_LIMIT_MAX_REQUESTS,
    maxEntries: streamConfig?.maxEntries ?? DEFAULT_STREAM_RATE_LIMIT_MAX_ENTRIES,
    cleanupIntervalMs: streamConfig?.cleanupIntervalMs ?? DEFAULT_STREAM_RATE_LIMIT_CLEANUP_INTERVAL_MS
  }
}

function checkStreamRateLimit(userId: string): boolean {
  const config = getStreamRateLimitConfig()
  const now = Date.now()
  const entry = streamRateLimiters.get(userId)

  if (!entry || entry.resetAt <= now) {
    streamRateLimiters.set(userId, { count: 1, resetAt: now + config.windowMs })
    return true
  }

  if (entry.count >= config.maxRequests) {
    return false
  }

  entry.count++
  return true
}

const streamRateLimitCleanupInterval = setInterval(() => {
  const config = getStreamRateLimitConfig()
  const now = Date.now()
  for (const [key, entry] of streamRateLimiters.entries()) {
    if (entry.resetAt <= now) {
      streamRateLimiters.delete(key)
    }
  }
  if (streamRateLimiters.size > config.maxEntries) {
    const entries = [...streamRateLimiters.entries()]
      .sort((a, b) => a[1].resetAt - b[1].resetAt)
    const toDelete = entries.slice(0, Math.floor(config.maxEntries * 0.3))
    for (const [key] of toDelete) {
      streamRateLimiters.delete(key)
    }
  }
}, getStreamRateLimitConfig().cleanupIntervalMs)

export function stopStreamRateLimitCleanup(): void {
  clearInterval(streamRateLimitCleanupInterval)
}

export const uploadUrlSchema = z.object({
  type: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT']),
  mimeType: z.string(),
  size: z.number().int().positive(),
  filename: z.string().min(1),
})

const confirmSchema = z.object({
  mediaId: z.string().min(26).max(26).refine(isValidId, 'Invalid media ID format')
})

async function composePreHandlers(
  handlers: Array<(req: FastifyRequest, rep: FastifyReply) => Promise<void>>,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  for (const handler of handlers) {
    if (reply.sent) return
    await handler(request, reply)
  }
}

async function canAccessMediaRecord(
  user: NonNullable<FastifyRequest['user']>,
  mediaRecord: { uploadedBy: string; messageId: string | null }
): Promise<boolean> {
  if (isAdmin(user) || mediaRecord.uploadedBy === user.id) {
    return true
  }

  if (!mediaRecord.messageId) {
    return false
  }

  const row = await db.select({ userId: conversations.userId })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(and(eq(messages.id, mediaRecord.messageId)))
    .limit(1)

  return row[0]?.userId === user.id
}

export async function mediaRoutes(fastify: FastifyInstance) {
  const rateLimiters = createRateLimiters()

  const uploadPreHandler = async (req: FastifyRequest, rep: FastifyReply) => {
    await requireApprovedUser(req, rep)
    if (rep.sent) return
    const u = req.user
    if (!u || u.role === 'ADMIN' || u.role === 'SUPER_ADMIN') return
    await rateLimiters.mediaUpload(req, rep)
  }

  fastify.post('/upload-url', { preHandler: uploadPreHandler }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }

    const config = getConfig()
    if (!config.features.mediaUpload) {
      return sendError(reply, 403, 'FORBIDDEN', 'Media uploads are disabled')
    }

    const body = uploadUrlSchema.safeParse(request.body)
    if (!body.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid input', body.error.issues)
    }

    if (!canUploadMedia(user)) {
      return sendError(reply, 403, 'FORBIDDEN', 'Media uploads not permitted')
    }

    if (config.limits.media.perDay) {
      const startOfDay = new Date()
      startOfDay.setUTCHours(0, 0, 0, 0)

      const countResult = await db.select({ count: sql<number>`count(*)` })
        .from(media)
        .where(
          and(
            eq(media.uploadedBy, user.id),
            sql`${media.uploadedAt} >= ${startOfDay}`
          )
        )

      const currentCount = countResult[0]?.count ?? 0
      if (currentCount >= config.limits.media.perDay) {
        return sendError(reply, 429, 'RATE_LIMITED', 'Daily media upload limit reached')
      }
    }

    const category = body.data.type.toLowerCase() as 'image' | 'video' | 'document'
    const normalizedMime = normalizeMimeType(body.data.mimeType)

    if (!isAllowedMimeType(normalizedMime, category)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'File type not allowed')
    }

    const maxSize = getMaxFileSize(category)
    if (body.data.size > maxSize) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'File too large', {
        maxSize,
        actualSize: body.data.size
      })
    }

    try {
      const auth = await generateUploadUrl({
        type: body.data.type,
        mimeType: normalizedMime,
        size: body.data.size,
        filename: sanitizeFilename(body.data.filename)
      })

      // We still record it as PENDING. 
      // The frontend will upload directly to ImageKit using these auth params,
      // and then call /confirm with this mediaId.
      await db.insert(media).values({
        id: auth.mediaId,
        uploadedBy: user.id,
        type: body.data.type,
        mimeType: normalizedMime,
        size: body.data.size,
        filename: sanitizeFilename(body.data.filename),
        r2Key: auth.r2Key,
        cdnUrl: getCdnUrl(auth.r2Key, body.data.type),
        hash: null,
        status: 'PENDING'
      })

      serverState.activeUploads.set(auth.mediaId, {
        userId: user.id,
        mediaId: auth.mediaId,
        type: body.data.type,
        startedAt: Date.now()
      })

      const config = getConfig()
      // Return the ImageKit specific auth parameters so the frontend SDK can use them
      return sendOk(reply, {
        token: auth.token,
        expire: auth.expire,
        signature: auth.signature,
        urlEndpoint: auth.urlEndpoint,
        uploadUrl: auth.uploadUrl,
        provider: auth.provider,
        mediaId: auth.mediaId,
        expiresIn: config.limits.upload.presignedUrlTTL
      })
    } catch (error) {
      logger.error({ userId: user.id, error }, 'Upload URL generation failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to generate upload URL')
    }
  })

  fastify.post('/upload', { preHandler: uploadPreHandler }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }
    const config = getConfig()
    if (!config.features.mediaUpload) {
      return sendError(reply, 403, 'FORBIDDEN', 'Media uploads are disabled')
    }

    if (!canUploadMedia(user)) {
      return sendError(reply, 403, 'FORBIDDEN', 'Media uploads not permitted')
    }

    if (config.limits.media.perDay) {
      const startOfDay = new Date()
      startOfDay.setUTCHours(0, 0, 0, 0)

      const countResult = await db.select({ count: sql<number>`count(*)` })
        .from(media)
        .where(
          and(
            eq(media.uploadedBy, user.id),
            sql`${media.uploadedAt} >= ${startOfDay}`
          )
        )

      const currentCount = countResult[0]?.count ?? 0
      if (currentCount >= config.limits.media.perDay) {
        return sendError(reply, 429, 'RATE_LIMITED', 'Daily media upload limit reached')
      }
    }

    const mediaType = request.headers['x-media-type'] as string
    const rawMime = request.headers['content-type'] || 'application/octet-stream'
    const mimeType = normalizeMimeType(rawMime)
    const rawFilename = request.headers['x-filename']
    let decodedFilename: string
    try {
      decodedFilename = decodeURIComponent((typeof rawFilename === 'string' ? rawFilename : 'upload') || 'upload')
    } catch {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid filename encoding')
    }
    const filename = sanitizeFilename(decodedFilename)
    const validMediaTypes = ['IMAGE', 'VIDEO', 'DOCUMENT'] as const
    if (!validMediaTypes.includes(mediaType as typeof validMediaTypes[number])) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid media type')
    }

    const category = mediaType.toLowerCase() as 'image' | 'video' | 'document'
    if (!isAllowedMimeType(mimeType, category)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'File type not allowed')
    }

    const body = request.body as Buffer
    if (!body || body.length === 0) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Empty file')
    }

    const maxSize = getMaxFileSize(category)
    if (body.length > maxSize) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'File too large', {
        maxSize,
        actualSize: body.length
      })
    }

    if (!validateFileSignature(body, mimeType)) {
      logger.warn({ userId: user.id, mimeType, size: body.length }, 'File signature validation failed')
      return sendError(reply, 400, 'VALIDATION_ERROR', 'File content does not match declared type')
    }

    const fileHash = crypto.createHash('sha256').update(body).digest('hex')

    if (fileHash) {
      // 100% efficiency: Deduplication check
      const existingMedia = await db.query.media.findFirst({
        where: and(
          eq(media.hash, fileHash),
          eq(media.status, 'CONFIRMED')
        ),
        columns: { id: true, filename: true, r2Key: true, cdnUrl: true }
      })

      if (existingMedia) {
        logger.info({ userId: user.id, hash: fileHash }, 'Bypassing upload via file deduplication (R2)')
        const deduplicatedMediaId = ulid()
        const confirmedAt = new Date()

        await db.transaction(async (tx) => {
          await tx.insert(media).values({
            id: deduplicatedMediaId,
            uploadedBy: user.id,
            type: mediaType as 'IMAGE' | 'VIDEO' | 'DOCUMENT',
            mimeType,
            size: body.length,
            filename: existingMedia.filename,
            r2Key: existingMedia.r2Key,
            cdnUrl: existingMedia.cdnUrl,
            hash: fileHash,
            status: 'CONFIRMED',
            confirmedAt
          })

          await tx.insert(auditLogs).values({
            id: ulid(),
            userId: user.id,
            ipAddress: request.ip,
            action: 'media.upload_deduplicated',
            entityType: 'media',
            entityId: deduplicatedMediaId,
            details: JSON.stringify({ type: mediaType, size: body.length, hash: fileHash })
          })
        })

        // Return inline — no extra DB round-trip
        return sendOk(reply, {
          success: true,
          media: {
            id: deduplicatedMediaId,
            type: mediaType,
            cdnUrl: existingMedia.cdnUrl,
            filename: existingMedia.filename,
            size: body.length,
            mimeType,
            status: 'CONFIRMED'
          }
        })
      }
    }

    try {
      const mediaId = ulid()
      const extension = filename.split('.').pop() || 'bin'
      const r2Key = `${category}/${mediaId}.${extension}`

      await uploadToR2(r2Key, body, mimeType)

      const cdnUrl = getCdnUrl(r2Key, mediaType)

      await db.transaction(async (tx) => {
        await tx.insert(media).values({
          id: mediaId,
          uploadedBy: user.id,
          type: mediaType as 'IMAGE' | 'VIDEO' | 'DOCUMENT',
          mimeType,
          size: body.length,
          filename,
          r2Key,
          cdnUrl,
          hash: fileHash ?? null,
          status: 'CONFIRMED',
          confirmedAt: new Date()
        })

        await tx.insert(auditLogs).values({
          id: ulid(),
          userId: user.id,
          ipAddress: request.ip,
          action: 'media.upload',
          entityType: 'media',
          entityId: mediaId,
          details: JSON.stringify({ type: mediaType, size: body.length })
        })
      })

      return sendOk(reply, {
        media: {
          id: mediaId,
          type: mediaType,
          cdnUrl,
          filename,
          size: body.length
        }
      })
    } catch (error) {
      logger.error({ userId: user.id, error }, 'Upload failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Upload failed')
    }
  })

  fastify.post('/confirm', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }

    const body = confirmSchema.safeParse(request.body)
    if (!body.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid input', body.error.issues)
    }

    const mediaRecord = await db.query.media.findFirst({
      where: eq(media.id, body.data.mediaId),
      columns: { id: true, status: true, uploadedBy: true, type: true, mimeType: true, cdnUrl: true, filename: true, size: true }
    })

    if (!mediaRecord) {
      return sendError(reply, 404, 'NOT_FOUND', 'Media not found')
    }

    if (mediaRecord.uploadedBy !== user.id && !isAdmin(user)) {
      return sendError(reply, 403, 'FORBIDDEN', 'Access denied')
    }

    if (mediaRecord.status !== 'PENDING') {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Media already confirmed or failed')
    }

    try {
      await db.transaction(async (tx) => {
        await tx.update(media)
          .set({
            status: 'CONFIRMED',
            confirmedAt: new Date()
          })
          .where(eq(media.id, body.data.mediaId))

        await tx.insert(auditLogs).values({
          id: ulid(),
          userId: user.id,
          ipAddress: request.ip,
          action: 'media.upload',
          entityType: 'media',
          entityId: mediaRecord.id,
          details: JSON.stringify({ type: mediaRecord.type, size: mediaRecord.size })
        })
      })
      serverState.activeUploads.delete(body.data.mediaId)
    } catch (error) {
      logger.error({ mediaId: body.data.mediaId, error }, 'Confirm failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to confirm upload')
    }

    return sendOk(reply, {
      media: {
        id: mediaRecord.id,
        type: mediaRecord.type,
        mimeType: mediaRecord.mimeType,
        cdnUrl: mediaRecord.cdnUrl,
        filename: mediaRecord.filename,
        size: mediaRecord.size
      }
    })
  })

  fastify.delete('/:mediaId', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }

    const { mediaId } = request.params as { mediaId: string }

    if (!isValidId(mediaId)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid media ID')
    }

    const mediaRecord = await db.query.media.findFirst({
      where: eq(media.id, mediaId),
      columns: { id: true, status: true, uploadedBy: true, r2Key: true, type: true, messageId: true }
    })

    if (!mediaRecord) {
      return sendError(reply, 404, 'NOT_FOUND', 'Media not found')
    }

    const userIsAdmin = isAdmin(user)
    const isOwner = mediaRecord.uploadedBy === user.id
    const isAttachedToMessage = mediaRecord.messageId !== null

    if (!userIsAdmin && (!isOwner || isAttachedToMessage)) {
      return sendError(reply, 403, 'FORBIDDEN', 'Cannot delete this media')
    }

    try {
      await deleteFromR2(mediaRecord.r2Key)
    } catch (error) {
      logger.warn({ mediaId, r2Key: mediaRecord.r2Key, error }, 'R2 delete failed, continuing with DB delete')
    }

    await db.transaction(async (tx) => {
      await tx.delete(media).where(eq(media.id, mediaId))

      await tx.insert(auditLogs).values({
        id: ulid(),
        userId: user.id,
        ipAddress: request.ip,
        action: 'media.delete',
        entityType: 'media',
        entityId: mediaId
      })
    })

    return sendOk(reply, { message: 'Media deleted' })
  })

  fastify.get('/:mediaId/stream', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }

    if (!checkStreamRateLimit(user.id)) {
      return sendError(reply, 429, 'RATE_LIMITED', 'Too many stream requests')
    }

    const { mediaId } = request.params as { mediaId: string }

    if (!isValidId(mediaId)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid media ID')
    }

    const mediaRecord = await db.query.media.findFirst({
      where: eq(media.id, mediaId),
      columns: { id: true, status: true, uploadedBy: true, r2Key: true, messageId: true }
    })

    if (!mediaRecord) {
      return sendError(reply, 404, 'NOT_FOUND', 'Media not found')
    }

    if (mediaRecord.status !== 'CONFIRMED') {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Media not ready')
    }

    const canAccess = await canAccessMediaRecord(user, mediaRecord)
    if (!canAccess) {
      return sendError(reply, 403, 'FORBIDDEN', 'Access denied')
    }

    try {
      const signedUrl = await getSignedR2Url(mediaRecord.r2Key, 60)
      return reply.redirect(signedUrl, 302)
    } catch (error) {
      logger.error({ mediaId, error }, 'Stream URL generation failed')
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to generate stream URL')
    }
  })

  fastify.get('/:mediaId', { preHandler: requireApprovedUser }, async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) {
      return
    }

    const { mediaId } = request.params as { mediaId: string }

    if (!isValidId(mediaId)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid media ID')
    }

    const mediaRecord = await db.query.media.findFirst({
      where: eq(media.id, mediaId),
      columns: { id: true, status: true, uploadedBy: true, messageId: true, type: true, mimeType: true, size: true, filename: true, cdnUrl: true, uploadedAt: true, confirmedAt: true }
    })

    if (!mediaRecord) {
      return sendError(reply, 404, 'NOT_FOUND', 'Media not found')
    }

    const canAccess = await canAccessMediaRecord(user, mediaRecord)
    if (!canAccess) {
      return sendError(reply, 403, 'FORBIDDEN', 'Access denied')
    }

    return sendOk(reply, {
      media: {
        id: mediaRecord.id,
        type: mediaRecord.type,
        mimeType: mediaRecord.mimeType,
        size: mediaRecord.size,
        filename: mediaRecord.filename,
        cdnUrl: mediaRecord.cdnUrl,
        status: mediaRecord.status,
        uploadedAt: mediaRecord.uploadedAt,
        confirmedAt: mediaRecord.confirmedAt
      }
    })
  })
}
