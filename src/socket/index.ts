import { Server as HttpServer } from 'http'
import { Server, Socket } from 'socket.io'
import jwt from 'jsonwebtoken'
import { ulid } from 'ulid'
import { eq, and, isNull, gt, ne, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users, messages, conversations, auditLogs, sessions, media, internalMessages, announcements } from '../db/schema.js'
import { env } from '../lib/env.js'
import { getConfig } from '../lib/config.js'
import { serverState, addUserToCache, getUserFromCache, removeUserFromCache, getUserConversationId, touchConversationOwner, invalidateSessionCache } from '../state.js'
import { logger } from '../lib/logger.js'
import { canUploadMedia, isAdmin } from '../lib/permissions.js'
import { socketMessageSchema, socketPresenceSchema, socketInternalMessageSchema, SocketMessageInput, SocketPresenceInput } from '../lib/socketSchemas.js'
import { sanitizeText } from '../lib/utils.js'
import { queueEmailNotification } from '../services/emailQueue.js'

interface DecodedToken {
  sub: string
  email: string
  role: 'USER' | 'ADMIN' | 'SUPER_ADMIN'
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED'
  sid: string
  exp: number
}

interface AuthError {
  message: string
  code: string
}

interface SocketUser {
  id: string
  email: string
  role: 'USER' | 'ADMIN' | 'SUPER_ADMIN'
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED'
  sessionId: string
}

interface SocketRateLimitEntry {
  minuteCount: number
  minuteResetAt: number
  hourCount: number
  hourResetAt: number
}

interface SocketAuthAttemptEntry {
  count: number
  resetAt: number
}

const DEFAULT_MAX_SOCKET_RATE_LIMITERS = 10000
function getConnectionRateConfig() {
  const cfg = getConfig().socket
  return {
    maxPerIp: cfg.maxConnectionsPerIp ?? 10,
    windowMs: cfg.connectionWindowMs ?? 60000
  }
}

const socketRateLimiters = new Map<string, SocketRateLimitEntry>()
let socketRateLimiterLastCleanup = Date.now()

const socketAuthAttempts = new Map<string, SocketAuthAttemptEntry>()
let socketAuthLastCleanup = Date.now()

const connectionAttempts = new Map<string, { count: number; resetAt: number }>()
let connectionLastCleanup = Date.now()

class SocketValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'SocketValidationError'
  }
}

function checkSocketRateLimit(userId: string, maxPerMinute: number, maxPerHour: number): boolean {
  const now = Date.now()
  const config = getConfig()
  const cleanupIntervalMs = config.presence.socketRateCleanupIntervalMs
  const maxSocketRateLimiters = config.cache?.maxSocketRateLimiters ?? DEFAULT_MAX_SOCKET_RATE_LIMITERS

  if (now - socketRateLimiterLastCleanup > cleanupIntervalMs || socketRateLimiters.size > maxSocketRateLimiters) {
    socketRateLimiterLastCleanup = now
    for (const [key, entry] of socketRateLimiters.entries()) {
      if (entry.minuteResetAt <= now && entry.hourResetAt <= now) {
        socketRateLimiters.delete(key)
      }
    }

    if (socketRateLimiters.size > maxSocketRateLimiters) {
      const entries = [...socketRateLimiters.entries()]
        .sort((a, b) => a[1].minuteResetAt - b[1].minuteResetAt)
      const toDelete = entries.slice(0, Math.floor(maxSocketRateLimiters * 0.2))
      for (const [key] of toDelete) {
        socketRateLimiters.delete(key)
      }
    }
  }

  const entry = socketRateLimiters.get(userId)
  const minuteWindowMs = 60 * 1000
  const hourWindowMs = 60 * 60 * 1000

  if (!entry) {
    socketRateLimiters.set(userId, {
      minuteCount: 1,
      minuteResetAt: now + minuteWindowMs,
      hourCount: 1,
      hourResetAt: now + hourWindowMs
    })
    return true
  }

  if (entry.minuteResetAt <= now) {
    entry.minuteCount = 0
    entry.minuteResetAt = now + minuteWindowMs
  }

  if (entry.hourResetAt <= now) {
    entry.hourCount = 0
    entry.hourResetAt = now + hourWindowMs
  }

  if (entry.minuteCount >= maxPerMinute || entry.hourCount >= maxPerHour) {
    return false
  }

  entry.minuteCount++
  entry.hourCount++
  return true
}

function getSocketClientIp(socket: Socket): string {
  const forwarded = socket.handshake.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const ips = forwarded.split(',').map(ip => ip.trim()).filter(Boolean)
    if (ips.length > 0) {
      return ips[0] || socket.handshake.address || 'unknown'
    }
  }

  if (Array.isArray(forwarded) && forwarded.length > 0) {
    const firstIp = forwarded[0]
    return firstIp ? firstIp.trim() : socket.handshake.address || 'unknown'
  }

  return socket.handshake.address || 'unknown'
}

function getSocketAuthTokenFromCookie(socket: Socket): string | null {
  const cookieHeader = socket.handshake.headers.cookie
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return null
  }

  const tokenPair = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('token='))

  if (!tokenPair) {
    return null
  }

  const rawToken = tokenPair.slice('token='.length)
  if (!rawToken) {
    return null
  }

  try {
    return decodeURIComponent(rawToken)
  } catch {
    return rawToken
  }
}

function cleanupSocketAuthAttempts(now: number): void {
  const config = getConfig()
  const cleanupIntervalMs = config.presence.socketRateCleanupIntervalMs
  const maxSocketRateLimiters = config.cache?.maxSocketRateLimiters ?? DEFAULT_MAX_SOCKET_RATE_LIMITERS

  if (now - socketAuthLastCleanup <= cleanupIntervalMs && socketAuthAttempts.size <= maxSocketRateLimiters) {
    return
  }

  socketAuthLastCleanup = now

  for (const [ip, entry] of socketAuthAttempts.entries()) {
    if (entry.resetAt <= now) {
      socketAuthAttempts.delete(ip)
    }
  }

  if (socketAuthAttempts.size > maxSocketRateLimiters) {
    const entries = [...socketAuthAttempts.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt)
    const toDelete = entries.slice(0, Math.floor(maxSocketRateLimiters * 0.2))
    for (const [ip] of toDelete) {
      socketAuthAttempts.delete(ip)
    }
  }
}

function isSocketAuthRateLimited(ip: string): boolean {
  const now = Date.now()
  const config = getConfig()

  cleanupSocketAuthAttempts(now)

  const entry = socketAuthAttempts.get(ip)
  if (!entry || entry.resetAt <= now) {
    return false
  }

  return entry.count >= config.socket.authMaxAttempts
}

function recordSocketAuthAttempt(ip: string, success: boolean): void {
  const now = Date.now()
  const config = getConfig()

  cleanupSocketAuthAttempts(now)

  if (success) {
    socketAuthAttempts.delete(ip)
    return
  }

  const entry = socketAuthAttempts.get(ip)
  if (!entry || entry.resetAt <= now) {
    socketAuthAttempts.set(ip, {
      count: 1,
      resetAt: now + config.socket.authWindowMs
    })
    return
  }

  entry.count++
}

function checkConnectionRateLimit(ip: string): boolean {
  const now = Date.now()

  if (now - connectionLastCleanup > 60000 || connectionAttempts.size > DEFAULT_MAX_SOCKET_RATE_LIMITERS) {
    connectionLastCleanup = now
    for (const [key, entry] of connectionAttempts.entries()) {
      if (entry.resetAt <= now) {
        connectionAttempts.delete(key)
      }
    }
  }

  const entry = connectionAttempts.get(ip)
  if (!entry || entry.resetAt <= now) {
    const { maxPerIp, windowMs } = getConnectionRateConfig()
    connectionAttempts.set(ip, { count: 1, resetAt: now + windowMs })
    return true
  }

  const { maxPerIp } = getConnectionRateConfig()
  if (entry.count >= maxPerIp) {
    return false
  }

  entry.count++
  return true
}

let io: Server | null = null

export function initSocket(httpServer: HttpServer): Server {
  if (io) return io

  const config = getConfig()
  const corsOrigins = env.corsOrigin.split(',').map(o => o.trim())

  io = new Server(httpServer, {
    cors: {
      origin: corsOrigins,
      credentials: true,
      methods: ['GET', 'POST']
    },
    pingTimeout: config.socket.pingTimeoutMs,
    pingInterval: config.socket.pingIntervalMs,
    maxHttpBufferSize: 1e6,
    connectTimeout: config.socket.authWindowMs
  })

  io.use((socket, next) => {
    const clientIp = getSocketClientIp(socket)
    if (!checkConnectionRateLimit(clientIp)) {
      logger.warn({ ip: clientIp }, 'Socket connection rate limited')
      return next(new Error('CONNECTION_RATE_LIMITED'))
    }
    next()
  })

  io.use(async (socket, next) => {
    try {
      await authenticateSocket(socket)
      next()
    } catch (err) {
      const authError = err as AuthError
      logger.warn({ reason: authError.message }, 'Socket auth failed')
      next(new Error(authError.code || 'AUTH_FAILED'))
    }
  })

  io.on('connection', (socket) => {
    handleConnection(socket)
  })

  logger.info('Socket.IO server initialized')
  return io
}

async function authenticateSocket(socket: Socket): Promise<void> {
  const clientIp = getSocketClientIp(socket)

  if (isSocketAuthRateLimited(clientIp)) {
    throw { message: 'Too many authentication attempts', code: 'AUTH_RATE_LIMITED' } as AuthError
  }

  try {
    let token = getSocketAuthTokenFromCookie(socket)

    if (!token && socket.handshake.auth?.token) {
      token = socket.handshake.auth.token
    }

    if (!token) {
      throw { message: 'No token provided', code: 'NO_TOKEN' } as AuthError
    }

    let decoded: DecodedToken
    try {
      decoded = jwt.verify(token, env.jwtSecret, {
        issuer: env.jwtIssuer,
        audience: env.jwtAudience
      }) as DecodedToken
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw { message: 'Token expired', code: 'TOKEN_EXPIRED' } as AuthError
      }
      throw { message: 'Invalid token', code: 'INVALID_TOKEN' } as AuthError
    }

    if (decoded.status !== 'APPROVED') {
      throw { message: 'Account not approved', code: 'NOT_APPROVED' } as AuthError
    }

    const sessionValid = await db.query.sessions.findFirst({
      where: and(
        eq(sessions.id, decoded.sid),
        eq(sessions.userId, decoded.sub),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date())
      ),
      columns: { id: true }
    })

    if (!sessionValid) {
      throw { message: 'Session invalid', code: 'SESSION_INVALID' } as AuthError
    }

    const cachedUser = getUserFromCache(decoded.sub)
    if (!cachedUser) {
      const user = await db.query.users.findFirst({
        where: eq(users.id, decoded.sub),
        columns: {
          id: true,
          email: true,
          role: true,
          status: true,
          name: true,
          mediaPermission: true,
          emailNotifyOnMessage: true
        }
      })

      if (!user) {
        throw { message: 'User not found', code: 'USER_NOT_FOUND' } as AuthError
      }

      addUserToCache(user.id, {
        role: user.role,
        status: user.status,
        name: user.name,
        mediaPermission: user.mediaPermission ?? false,
        emailNotifyOnMessage: user.emailNotifyOnMessage ?? true
      })
    }

    socket.data.user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role,
      status: decoded.status,
      sessionId: decoded.sid
    }

    socket.join(`user:${decoded.sub}`)

    if (isAdmin({ role: decoded.role })) {
      socket.join('admins')
    } else {
      socket.join('users')
    }

    recordSocketAuthAttempt(clientIp, true)
  } catch (error) {
    recordSocketAuthAttempt(clientIp, false)
    throw error
  }
}

function handleConnection(socket: Socket): void {
  const user = socket.data.user as SocketUser
  if (!user) {
    socket.disconnect(true)
    return
  }

  const config = getConfig()

  const existingConnection = serverState.connectedUsers.get(user.id)
  if (existingConnection && existingConnection.socketId !== socket.id) {
    const oldSocket = io?.sockets.sockets.get(existingConnection.socketId)
    if (oldSocket) {
      oldSocket.emit('force_logout', { reason: 'Connected from another location' })
      oldSocket.disconnect(true)
    }
  }

  serverState.connectedUsers.set(user.id, {
    socketId: socket.id,
    userId: user.id,
    connectedAt: Date.now(),
    lastActivity: Date.now()
  })

  serverState.userPresence.set(user.id, {
    status: 'online',
    lastSeen: Date.now()
  })

  const cachedUser = getUserFromCache(user.id)
  if (cachedUser) {
    serverState.emailPreferences.set(user.id, cachedUser.emailNotifyOnMessage)
    serverState.userNames.set(user.id, cachedUser.name)
  }

  logger.info({ userId: user.id, socketId: socket.id }, 'User connected')

  emitToUser(user.id, 'presence:update', {
    userId: user.id,
    status: 'online'
  })

  const onlineUserCache = getUserFromCache(user.id)
  emitToAdmins('user:online', {
    userId: user.id,
    userName: onlineUserCache?.name ?? 'Unknown',
    status: 'online'
  })

  socket.on('disconnect', (reason) => {
    handleDisconnect(socket, user, reason)
  })

  socket.on('error', (err) => {
    logger.error({ userId: user.id, error: err.message }, 'Socket error')
  })

  const clientIp = getSocketClientIp(socket)

  const wrapAsyncHandler = (handler: () => Promise<void>) => {
    handler().catch((err) => {
      logger.error({ userId: user.id, error: err instanceof Error ? err.message : String(err) }, 'Async handler error')
      socket.emit('error', { code: 'INTERNAL_ERROR', message: 'Operation failed' })
    })
  }

  socket.on('message:send', (data: unknown) => {
    if (!isAdmin({ role: user.role }) && !checkSocketRateLimit(user.id, config.limits.message.perMinute, config.limits.message.perHour)) {
      socket.emit('error', { code: 'RATE_LIMITED', message: 'Too many messages' })
      return
    }
    wrapAsyncHandler(() => handleMessageSend(socket, user, data, clientIp))
  })

  if (isAdmin({ role: user.role })) {
    socket.on('internal:message:send', (data: unknown) => {
      if (!checkSocketRateLimit(user.id, config.limits.message.perMinute, config.limits.message.perHour)) {
        socket.emit('error', { code: 'RATE_LIMITED', message: 'Too many messages' })
        return
      }
      wrapAsyncHandler(() => handleInternalMessageSend(socket, user, data))
    })

    socket.on('internal:typing', (data: unknown) => {
      const parsed = (typeof data === 'object' && data !== null && 'isTyping' in data)
        ? { isTyping: !!(data as { isTyping: unknown }).isTyping }
        : null
      if (!parsed) return
      const cachedUser = getUserFromCache(user.id)
      const userName = cachedUser?.name ?? 'Admin'
      // Broadcast to all other admins (excluding sender)
      socket.to('admins').emit('internal:typing', {
        userId: user.id,
        userName,
        isTyping: parsed.isTyping,
      })
    })
  }

  socket.on('messages:mark_read', (data: unknown) => {
    wrapAsyncHandler(() => handleMessagesMarkRead(socket, user, data))
  })

  socket.on('typing:start', (data: unknown) => {
    const convId = (typeof data === 'object' && data !== null && 'conversationId' in data)
      ? String((data as { conversationId: unknown }).conversationId)
      : undefined
    handleTypingStart(socket, user, convId)
  })

  socket.on('typing:stop', (data: unknown) => {
    const convId = (typeof data === 'object' && data !== null && 'conversationId' in data)
      ? String((data as { conversationId: unknown }).conversationId)
      : undefined
    handleTypingStop(socket, user, convId)
  })

  socket.on('dm:typing', (data: unknown) => {
    if (!isAdmin({ role: user.role })) return
    if (typeof data !== 'object' || data === null) return
    const d = data as { partnerId?: unknown; isTyping?: unknown }
    if (typeof d.partnerId !== 'string' || !d.partnerId) return
    const cachedUser = getUserFromCache(user.id)
    const userName = cachedUser?.name ?? 'Admin'
    emitToUser(d.partnerId, 'dm:typing', {
      userId: user.id,
      userName,
      isTyping: !!d.isTyping,
    })
  })

  socket.on('presence:update', (data: unknown) => {
    handlePresenceUpdate(socket, user, data)
  })

  socket.on('ping', () => {
    const userData = serverState.connectedUsers.get(user.id)
    if (userData) {
      userData.lastActivity = Date.now()
    }
    socket.emit('pong')
  })
}

function handleDisconnect(socket: Socket, user: SocketUser, reason: string): void {
  serverState.connectedUsers.delete(user.id)

  serverState.userPresence.set(user.id, {
    status: 'offline',
    lastSeen: Date.now()
  })

  const conversationId = getUserConversationId(user.id)
  if (conversationId) {
    const typingEntry = serverState.typingIndicators.get(conversationId)
    if (typingEntry?.userId === user.id) {
      serverState.typingIndicators.delete(conversationId)
      const disconnectedUser = getUserFromCache(user.id)
      const userName = disconnectedUser?.name ?? 'Unknown'
      emitToAdmins('typing:stop', { conversationId, userId: user.id, userName })
    }
  }

  logger.info({ userId: user.id, reason }, 'User disconnected')

  const offlineUserCache = getUserFromCache(user.id)
  emitToAdmins('user:offline', {
    userId: user.id,
    userName: offlineUserCache?.name ?? 'Unknown',
    status: 'offline',
    lastSeenAt: Date.now()
  })
}

interface MessageContext {
  conversationId: string
  type: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT'
  content?: string | undefined
  mediaId?: string | undefined
  tempId?: string | undefined
  replyToId?: string | undefined
  announcementId?: string | undefined
}

/**
 * Validates incoming socket message data and returns conversation context.
 * Checks conversation access, message length limits, and media permissions.
 * @param socket - Socket.IO socket instance
 * @param user - Authenticated socket user
 * @param data - Raw message data from client
 * @returns Validation result with context on success, or valid: false on failure
 */
async function validateMessageContext(
  socket: Socket,
  user: SocketUser,
  data: unknown
): Promise<{ valid: true; context: MessageContext; conversation: typeof conversations.$inferSelect; isAdminSending: boolean } | { valid: false }> {
  const config = getConfig()

  const parsed = socketMessageSchema.safeParse(data)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => i.message).join(', ')
    socket.emit('error', { code: 'VALIDATION_ERROR', message: issues })
    return { valid: false }
  }

  const validatedData: SocketMessageInput = parsed.data

  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, validatedData.conversationId)
  })

  if (!conversation) {
    socket.emit('error', { code: 'NOT_FOUND', message: 'Conversation not found' })
    return { valid: false }
  }

  const userIsAdmin = isAdmin({ role: user.role })
  // SUPER_ADMIN can access all; regular ADMIN only their assigned; USER only their own
  if (!userIsAdmin && conversation.userId !== user.id) {
    socket.emit('error', { code: 'FORBIDDEN', message: 'Access denied' })
    return { valid: false }
  }
  if (user.role === 'ADMIN' && conversation.userId !== user.id && conversation.assignedAdminId !== user.id) {
    socket.emit('error', { code: 'FORBIDDEN', message: 'Conversation not assigned to you' })
    return { valid: false }
  }

  if (validatedData.type === 'TEXT' && validatedData.content && validatedData.content.length > config.limits.message.textMaxLength) {
    socket.emit('error', { code: 'VALIDATION_ERROR', message: 'Message too long' })
    return { valid: false }
  }

  if (validatedData.type !== 'TEXT' && !config.features.mediaUpload) {
    socket.emit('error', { code: 'FORBIDDEN', message: 'Media uploads are disabled' })
    return { valid: false }
  }

  if (validatedData.type !== 'TEXT') {
    const cachedUser = getUserFromCache(user.id)
    const mediaPermission = cachedUser?.mediaPermission ?? false

    if (!canUploadMedia({ role: user.role, status: user.status, mediaPermission })) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Media uploads not permitted' })
      return { valid: false }
    }
  }

  return {
    valid: true,
    context: validatedData,
    conversation,
    isAdminSending: userIsAdmin && conversation.userId !== user.id
  }
}

type MediaPayload = { id: string; type: string; cdnUrl: string; filename: string; size: number; mimeType: string; metadata?: string | null }

async function validateMediaForMessage(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  mediaId: string,
  messageType: string,
  userId: string,
  userRole: 'USER' | 'ADMIN' | 'SUPER_ADMIN'
): Promise<MediaPayload> {
  const mediaRecord = await tx.query.media.findFirst({
    where: eq(media.id, mediaId),
    columns: { id: true, status: true, type: true, messageId: true, uploadedBy: true, cdnUrl: true, filename: true, size: true, mimeType: true, metadata: true }
  })

  if (!mediaRecord) throw new SocketValidationError('VALIDATION_ERROR', 'Invalid media')
  if (mediaRecord.status !== 'CONFIRMED') throw new SocketValidationError('VALIDATION_ERROR', 'Invalid or unconfirmed media')
  if (mediaRecord.type !== messageType) throw new SocketValidationError('VALIDATION_ERROR', 'Media type does not match message type')
  if (mediaRecord.messageId !== null) throw new SocketValidationError('VALIDATION_ERROR', 'Media is already attached to a message')
  if (mediaRecord.uploadedBy !== userId && !isAdmin({ role: userRole })) throw new SocketValidationError('FORBIDDEN', 'Media does not belong to you')

  return { id: mediaRecord.id, type: mediaRecord.type, cdnUrl: mediaRecord.cdnUrl, filename: mediaRecord.filename, size: mediaRecord.size, mimeType: mediaRecord.mimeType, metadata: mediaRecord.metadata }
}

async function handleMessageSend(socket: Socket, user: SocketUser, data: unknown, clientIp: string): Promise<void> {
  const validation = await validateMessageContext(socket, user, data)
  if (!validation.valid) return

  const { context, conversation, isAdminSending } = validation
  const messageId = ulid()
  const now = new Date()
  const unreadCount = isAdminSending ? conversation.unreadCount + 1 : conversation.unreadCount
  const sanitizedContent = context.content ? sanitizeText(context.content) : null
  let mediaPayloadRef: MediaPayload | null = null

  try {
    await db.transaction(async (tx) => {
      await tx.insert(messages).values({
        id: messageId,
        conversationId: context.conversationId,
        senderId: user.id,
        type: context.type,
        content: sanitizedContent,
        replyToId: context.replyToId || null,
        announcementId: context.announcementId || null,
      })

      // Auto-assign conversation to an online regular ADMIN (not SUPER_ADMIN) when user sends first message
      if (!isAdminSending && !conversation.assignedAdminId) {
        const onlineAdminIds = Array.from(serverState.connectedUsers.keys()).filter(uid => {
          const cached = getUserFromCache(uid)
          return cached && cached.role === 'ADMIN'
        })
        if (onlineAdminIds.length > 0) {
          // Pick admin with fewest assigned conversations (simple round-robin via sort)
          const assignedId = onlineAdminIds[Math.floor(Math.random() * onlineAdminIds.length)]!
          await tx.update(conversations)
            .set({ assignedAdminId: assignedId })
            .where(eq(conversations.id, context.conversationId))
          conversation.assignedAdminId = assignedId
        }
      }

      if (context.mediaId) {
        const validated = await validateMediaForMessage(tx, context.mediaId, context.type, user.id, user.role)
        mediaPayloadRef = validated
        const mediaUpdateResult = await tx.update(media)
          .set({ messageId })
          .where(and(eq(media.id, context.mediaId), isNull(media.messageId)))

        if (!mediaUpdateResult.rowsAffected) {
          throw new SocketValidationError('VALIDATION_ERROR', 'Media is already attached to a different message')
        }
      }

      await tx.update(conversations)
        .set({
          lastMessageAt: now,
          updatedAt: now,
          ...(isAdminSending
            ? { unreadCount: sql`unread_count + 1` }
            : { adminUnreadCount: sql`admin_unread_count + 1` })
        })
        .where(eq(conversations.id, context.conversationId))

      await tx.insert(auditLogs).values({
        id: ulid(),
        userId: user.id,
        ipAddress: clientIp,
        action: 'message.send',
        entityType: 'message',
        entityId: messageId,
        details: JSON.stringify({ conversationId: context.conversationId, type: context.type })
      })
    })
  } catch (error) {
    if (error instanceof SocketValidationError) {
      socket.emit('error', { code: error.code, message: error.message })
      return
    }

    logger.error({ userId: user.id, conversationId: context.conversationId, error }, 'Message transaction failed')
    socket.emit('error', { code: 'INTERNAL_ERROR', message: 'Failed to send message' })
    return
  }

  // Fetch only the lightweight fields we can't derive from insert context
  const [replyToRow, linkedAnnouncementRow] = await Promise.all([
    context.replyToId
      ? db.query.messages.findFirst({
        where: eq(messages.id, context.replyToId),
        columns: { id: true, type: true, content: true, deletedAt: true },
        with: { sender: { columns: { name: true } } },
      })
      : Promise.resolve(null),
    context.announcementId
      ? db.query.announcements.findFirst({
        where: eq(announcements.id, context.announcementId),
        columns: { id: true, title: true, type: true, template: true },
      })
      : Promise.resolve(null),
  ])

  const cachedSender = getUserFromCache(user.id)
  const adminUnreadCount = isAdminSending ? conversation.adminUnreadCount : conversation.adminUnreadCount + 1
  touchConversationOwner(context.conversationId)

  const messagePayload = {
    id: messageId,
    conversationId: context.conversationId,
    senderId: user.id,
    sender: { id: user.id, name: cachedSender?.name ?? user.id, role: user.role },
    type: context.type,
    content: sanitizedContent,
    status: 'SENT',
    createdAt: now,
    media: mediaPayloadRef,
    replyToId: context.replyToId ?? null,
    replyTo: replyToRow ?? null,
    announcementId: context.announcementId ?? null,
    linkedAnnouncement: linkedAnnouncementRow ?? null,
    assignedAdminId: conversation.assignedAdminId,
  }

  if (isAdmin({ role: user.role })) {
    emitToUser(conversation.userId, 'message:new', { message: messagePayload })
  } else {
    emitToAdmins('message:new', { message: messagePayload })
  }

  emitToAdmins('conversation:updated', {
    conversationId: context.conversationId,
    userId: conversation.userId,
    unreadCount,
    adminUnreadCount,
    lastMessageAt: now.getTime(),
    lastMessage: messagePayload,
    assignedAdminId: conversation.assignedAdminId,
  })

  if (isAdminSending) {
    queueEmailNotification(conversation.userId)
  }

  socket.emit('message:sent', { tempId: context.tempId, message: messagePayload })
}

async function handleInternalMessageSend(socket: Socket, user: SocketUser, data: unknown): Promise<void> {
  const config = getConfig()
  const parsed = socketInternalMessageSchema.safeParse(data)
  if (!parsed.success) {
    socket.emit('error', { code: 'VALIDATION_ERROR', message: parsed.error.issues.map(i => i.message).join(', ') })
    return
  }

  const { type, content, mediaId, tempId, replyToId } = parsed.data
  const teamMax = config.limits.message.teamTextMaxLength ?? 5000
  if (type === 'TEXT' && content && content.length > teamMax) {
    socket.emit('error', { code: 'VALIDATION_ERROR', message: `Message too long (max ${teamMax} characters)` })
    return
  }

  const id = ulid()
  const now = new Date()
  const sanitized = content ? sanitizeText(content) : null

  // Pre-fetch related data before the transaction so we can build the payload without a post-insert SELECT
  const [mediaRecord, replyToRow] = await Promise.all([
    mediaId
      ? db.query.media.findFirst({
        where: eq(media.id, mediaId),
        columns: { id: true, status: true, type: true, messageId: true, uploadedBy: true, cdnUrl: true, filename: true, size: true, mimeType: true },
      })
      : Promise.resolve(null),
    replyToId
      ? db.query.internalMessages.findFirst({
        where: eq(internalMessages.id, replyToId),
        columns: { id: true, type: true, content: true, deletedAt: true },
        with: { sender: { columns: { name: true } } },
      })
      : Promise.resolve(null),
  ])

  if (mediaId) {
    if (!mediaRecord) {
      socket.emit('error', { code: 'VALIDATION_ERROR', message: 'Invalid media' })
      return
    }
    if (mediaRecord.status !== 'CONFIRMED') {
      socket.emit('error', { code: 'VALIDATION_ERROR', message: 'Invalid or unconfirmed media' })
      return
    }
    if (mediaRecord.type !== type) {
      socket.emit('error', { code: 'VALIDATION_ERROR', message: 'Media type does not match message type' })
      return
    }
    if (mediaRecord.messageId !== null) {
      socket.emit('error', { code: 'VALIDATION_ERROR', message: 'Media is already attached to a message' })
      return
    }
    if (mediaRecord.uploadedBy !== user.id && !isAdmin({ role: user.role })) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Media does not belong to you' })
      return
    }
  }

  try {
    await db.transaction(async (tx) => {
      await tx.insert(internalMessages).values({
        id,
        senderId: user.id,
        type,
        content: sanitized,
        mediaId: mediaId ?? null,
        replyToId: replyToId ?? null,
      })

      if (mediaId) {
        const mediaUpdateResult = await tx.update(media)
          .set({ messageId: id })
          .where(and(eq(media.id, mediaId), isNull(media.messageId)))
        if (!mediaUpdateResult.rowsAffected) {
          throw new SocketValidationError('VALIDATION_ERROR', 'Media is already attached to a different message')
        }
      }
    })
  } catch (err) {
    if (err instanceof SocketValidationError) {
      socket.emit('error', { code: err.code, message: err.message })
      return
    }
    logger.error({ userId: user.id, error: err }, 'Internal message send failed')
    socket.emit('error', { code: 'INTERNAL_ERROR', message: 'Failed to send message' })
    return
  }

  const cachedSender = getUserFromCache(user.id)
  const mediaPayload = mediaRecord
    ? { id: mediaRecord.id, type: mediaRecord.type, cdnUrl: mediaRecord.cdnUrl, filename: mediaRecord.filename, size: mediaRecord.size, mimeType: mediaRecord.mimeType }
    : null

  const payload = {
    id,
    senderId: user.id,
    sender: { id: user.id, name: cachedSender?.name ?? user.id, role: user.role },
    type,
    content: sanitized,
    media: mediaPayload,
    replyToId: replyToId ?? null,
    replyTo: replyToRow ?? null,
    createdAt: now,
  }

  emitToAdmins('internal:message', { message: payload })
  socket.emit('internal:message:sent', { tempId, message: payload })
}

async function handleMessagesMarkRead(_socket: Socket, user: SocketUser, data: unknown): Promise<void> {
  if (!data || typeof data !== 'object' || !('conversationId' in data)) return
  const conversationId = (data as { conversationId: unknown }).conversationId
  if (typeof conversationId !== 'string' || !conversationId) return

  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { id: true, userId: true }
  })
  if (!conversation) return

  if (!isAdmin({ role: user.role }) && conversation.userId !== user.id) return

  const now = Date.now()

  if (isAdmin({ role: user.role })) {
    // Admin reads user messages — both UPDATEs in one transaction (#36)
    let rowsAffected = 0
    await db.transaction(async (tx) => {
      const result = await tx.update(messages)
        .set({ status: 'READ', readAt: new Date(now), updatedAt: new Date(now) })
        .where(and(
          eq(messages.conversationId, conversationId),
          eq(messages.senderId, conversation.userId),
          eq(messages.status, 'SENT'),
          isNull(messages.deletedAt)
        ))
      rowsAffected = result.rowsAffected ?? 0
      if (rowsAffected > 0) {
        await tx.update(conversations)
          .set({ adminUnreadCount: 0 })
          .where(eq(conversations.id, conversationId))
      }
    })
    if (rowsAffected > 0) {
      emitToAdmins('conversation:updated', { conversationId, adminUnreadCount: 0 })
      emitToUser(conversation.userId, 'messages:read', { conversationId, readBy: user.id, readAt: now })
    }
  } else {
    // User reads admin messages — both UPDATEs in one transaction (#36)
    let rowsAffected = 0
    await db.transaction(async (tx) => {
      const result = await tx.update(messages)
        .set({ status: 'READ', readAt: new Date(now), updatedAt: new Date(now) })
        .where(and(
          eq(messages.conversationId, conversationId),
          ne(messages.senderId, user.id),
          eq(messages.status, 'SENT'),
          isNull(messages.deletedAt)
        ))
      rowsAffected = result.rowsAffected ?? 0
      if (rowsAffected > 0) {
        await tx.update(conversations)
          .set({ unreadCount: 0 })
          .where(eq(conversations.id, conversationId))
      }
    })
    if (rowsAffected > 0) {
      const readPayload = { conversationId, readBy: user.id, readAt: now }
      emitToAdmins('messages:read', readPayload)
      emitToAdmins('conversation:updated', { conversationId, unreadCount: 0 })
      emitToUser(user.id, 'messages:read', readPayload)
    }
  }
}

function handleTypingStart(_socket: Socket, user: SocketUser, providedConvId?: string): void {
  const conversationId = providedConvId || getUserConversationId(user.id)
  if (!conversationId) return

  const cachedUser = getUserFromCache(user.id)
  const userName = cachedUser?.name ?? 'Unknown'

  serverState.typingIndicators.set(conversationId, {
    userId: user.id,
    updatedAt: Date.now()
  })

  const conversationOwner = serverState.conversationOwners.get(conversationId)?.userId

  if (isAdmin({ role: user.role })) {
    if (conversationOwner) {
      emitToUser(conversationOwner, 'typing:start', { conversationId, userId: user.id, userName })
    }
  } else {
    emitToAdmins('typing:start', { conversationId, userId: user.id, userName })
  }
}

function handleTypingStop(_socket: Socket, user: SocketUser, providedConvId?: string): void {
  const conversationId = providedConvId || getUserConversationId(user.id)
  if (!conversationId) return

  const cachedUser = getUserFromCache(user.id)
  const userName = cachedUser?.name ?? 'Unknown'

  serverState.typingIndicators.delete(conversationId)

  const conversationOwner = serverState.conversationOwners.get(conversationId)?.userId

  if (isAdmin({ role: user.role })) {
    if (conversationOwner) {
      emitToUser(conversationOwner, 'typing:stop', { conversationId, userId: user.id, userName })
    }
  } else {
    emitToAdmins('typing:stop', { conversationId, userId: user.id, userName })
  }
}

function handlePresenceUpdate(_socket: Socket, user: SocketUser, data: unknown): void {
  const parsed = socketPresenceSchema.safeParse(data)
  if (!parsed.success) return

  const validatedData: SocketPresenceInput = parsed.data

  serverState.userPresence.set(user.id, {
    status: validatedData.status,
    lastSeen: Date.now()
  })

  emitToAdmins('presence:update', {
    userId: user.id,
    status: validatedData.status,
    lastSeen: Date.now()
  })
}

export function getIO(): Server {
  if (!io) {
    throw new Error('Socket.IO not initialized')
  }
  return io
}

export function closeIO(): Promise<void> {
  return new Promise((resolve) => {
    if (io) {
      io.close(() => resolve())
    } else {
      resolve()
    }
  })
}

export function emitToUser(userId: string, event: string, data: unknown): void {
  if (!io) return
  io.to(`user:${userId}`).emit(event, data)
}

export function emitToAdmins(event: string, data: unknown): void {
  if (!io) return
  io.to('admins').emit(event, data)
}

export function emitToUsers(event: string, data: unknown): void {
  if (!io) return
  io.to('users').emit(event, data)
}

export function forceLogout(userId: string, reason: string): void {
  if (!io) return

  emitToUser(userId, 'force_logout', { reason })

  const sockets = io.sockets.sockets
  for (const [, socket] of sockets) {
    if (socket.data.user?.id === userId) {
      socket.disconnect(true)
    }
  }

  removeUserFromCache(userId)
}

export function forceLogoutSession(sessionId: string, reason: string): void {
  if (!io) return

  const sockets = io.sockets.sockets
  for (const [, socket] of sockets) {
    if (socket.data.user?.sessionId === sessionId) {
      const userId = socket.data.user.id
      emitToUser(userId, 'force_logout', { reason })
      socket.disconnect(true)
      // Evict the session validation cache entry so revoked JWT can't pass cached validation
      invalidateSessionCache(userId, sessionId)
    }
  }
}

export function getConnectedUsersCount(): number {
  return serverState.connectedUsers.size
}

export function getConnectedUsers(): Array<{ userId: string; connectedAt: number }> {
  return Array.from(serverState.connectedUsers.values()).map(u => ({
    userId: u.userId,
    connectedAt: u.connectedAt
  }))
}
