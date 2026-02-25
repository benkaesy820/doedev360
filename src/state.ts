import { getConfig } from './lib/config.js'
import { logger } from './lib/logger.js'

interface CachedUser {
  role: 'USER' | 'ADMIN' | 'SUPER_ADMIN'
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED'
  name: string
  mediaPermission: boolean
  emailNotifyOnMessage: boolean
  lastAccessedAt: number
}

interface ConnectedUser {
  socketId: string
  userId: string
  connectedAt: number
  lastActivity: number
}

interface UserPresence {
  status: 'online' | 'away' | 'offline'
  lastSeen: number
}

interface TypingIndicator {
  userId: string
  updatedAt: number
}

interface PendingEmail {
  userId: string
  messageCount: number
  firstMessageAt: number
  timer: NodeJS.Timeout
}

interface ActiveUpload {
  userId: string
  mediaId: string
  type: string
  startedAt: number
}

interface ConversationOwner {
  userId: string
  lastActivityAt: number
}

interface SessionValidationCacheEntry {
  valid: boolean
  expiresAt: number
}

const DEFAULT_MAX_CACHE_SIZE = 10000
const DEFAULT_MAX_TYPING_INDICATORS = 1000
const DEFAULT_MAX_ACTIVE_UPLOADS = 500
const DEFAULT_MAX_CONVERSATION_OWNERS = 50000
const DEFAULT_MAX_SESSION_CACHE_SIZE = 50000
const CONVERSATION_OWNER_TTL_MS = 24 * 60 * 60 * 1000

class StateManager {
  private cleanupInterval: NodeJS.Timeout | null = null
  private initialized: boolean = false
  private initLock: boolean = false

  readonly userCache: Map<string, CachedUser> = new Map()
  readonly connectedUsers: Map<string, ConnectedUser> = new Map()
  readonly userPresence: Map<string, UserPresence> = new Map()
  readonly typingIndicators: Map<string, TypingIndicator> = new Map()
  readonly emailPreferences: Map<string, boolean> = new Map()
  readonly pendingEmails: Map<string, PendingEmail> = new Map()
  readonly userNames: Map<string, string> = new Map()
  readonly activeUploads: Map<string, ActiveUpload> = new Map()
  readonly conversationOwners: Map<string, ConversationOwner> = new Map()
  readonly userToConversation: Map<string, string> = new Map()
  readonly sessionValidationCache: Map<string, SessionValidationCacheEntry> = new Map()
  readonly userSessionKeys: Map<string, Set<string>> = new Map()

  private getMaxCacheSize(): number {
    return getConfig().cache?.maxUserCacheSize ?? DEFAULT_MAX_CACHE_SIZE
  }

  private getMaxTypingIndicators(): number {
    return getConfig().cache?.maxTypingIndicators ?? DEFAULT_MAX_TYPING_INDICATORS
  }

  private getMaxActiveUploads(): number {
    return getConfig().cache?.maxActiveUploads ?? DEFAULT_MAX_ACTIVE_UPLOADS
  }

  private getMaxConversationOwners(): number {
    return DEFAULT_MAX_CONVERSATION_OWNERS
  }

  init(): void {
    if (this.initLock) {
      logger.warn('State manager initialization already in progress')
      return
    }
    if (this.initialized) {
      logger.warn('State manager already initialized')
      return
    }

    this.initLock = true

    const config = getConfig()

    this.cleanupInterval = setInterval(() => {
      this.runCleanup()
    }, config.presence.cleanupIntervalMs)

    this.initialized = true
    this.initLock = false

    logger.info('State manager initialized')
  }

  private runCleanup(): void {
    const config = getConfig()
    const now = Date.now()

    const presenceThreshold = now - config.presence.offlineThresholdMs
    for (const [userId, presence] of this.userPresence.entries()) {
      if (presence.lastSeen < presenceThreshold) {
        this.userPresence.delete(userId)
      }
    }

    const typingThreshold = now - config.presence.typingIndicatorTTL
    for (const [conversationId, indicator] of this.typingIndicators.entries()) {
      if (indicator.updatedAt < typingThreshold) {
        this.typingIndicators.delete(conversationId)
      }
    }

    const maxTypingIndicators = this.getMaxTypingIndicators()
    if (this.typingIndicators.size > maxTypingIndicators) {
      const entries = [...this.typingIndicators.entries()]
      const toDelete = entries.slice(0, Math.floor(maxTypingIndicators * 0.3))
      for (const [key] of toDelete) {
        this.typingIndicators.delete(key)
      }
    }

    const uploadStaleMs = getConfig().limits.upload.confirmTimeout * 1000
    const uploadThreshold = now - uploadStaleMs
    for (const [mediaId, upload] of this.activeUploads.entries()) {
      if (upload.startedAt < uploadThreshold) {
        this.activeUploads.delete(mediaId)
      }
    }

    const maxActiveUploads = this.getMaxActiveUploads()
    if (this.activeUploads.size > maxActiveUploads) {
      let evict = Math.floor(maxActiveUploads * 0.3)
      for (const [key] of this.activeUploads) {
        if (evict-- <= 0) break
        this.activeUploads.delete(key)
      }
    }

    const maxCacheSize = this.getMaxCacheSize()
    if (this.userCache.size > maxCacheSize) {
      const evictCount = Math.floor(maxCacheSize * 0.2)
      let removed = 0
      for (const key of this.userCache.keys()) {
        if (removed >= evictCount) break
        this.userCache.delete(key)
        this.userNames.delete(key)
        this.emailPreferences.delete(key)
        removed++
      }
      logger.warn({ removed }, 'User cache pruned (LRU front)')
    }

    const conversationThreshold = now - CONVERSATION_OWNER_TTL_MS
    for (const [conversationId, owner] of this.conversationOwners.entries()) {
      if (owner.lastActivityAt < conversationThreshold) {
        this.conversationOwners.delete(conversationId)
        this.userToConversation.delete(owner.userId)
      }
    }

    for (const [cacheKey, entry] of this.sessionValidationCache.entries()) {
      if (entry.expiresAt <= now) {
        this.sessionValidationCache.delete(cacheKey)
      }
    }

    const maxConvOwners = this.getMaxConversationOwners()
    if (this.conversationOwners.size > maxConvOwners) {
      const evictCount = Math.floor(maxConvOwners * 0.2)
      let removed = 0
      for (const [conversationId, owner] of this.conversationOwners.entries()) {
        if (removed >= evictCount) break
        this.conversationOwners.delete(conversationId)
        this.userToConversation.delete(owner.userId)
        removed++
      }
      logger.warn({ removed }, 'Conversation owners cache pruned (LRU front)')
    }
  }

  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }

    for (const [, pending] of this.pendingEmails.entries()) {
      clearTimeout(pending.timer)
    }
    this.pendingEmails.clear()

    this.connectedUsers.clear()
    this.userPresence.clear()
    this.typingIndicators.clear()
    this.activeUploads.clear()
    this.conversationOwners.clear()
    this.userToConversation.clear()
    this.sessionValidationCache.clear()

    this.initialized = false
    logger.info('State manager shutdown complete')
  }

  getStats(): {
    userCache: number
    connectedUsers: number
    userPresence: number
    typingIndicators: number
    pendingEmails: number
    activeUploads: number
    conversationOwners: number
  } {
    return {
      userCache: this.userCache.size,
      connectedUsers: this.connectedUsers.size,
      userPresence: this.userPresence.size,
      typingIndicators: this.typingIndicators.size,
      pendingEmails: this.pendingEmails.size,
      activeUploads: this.activeUploads.size,
      conversationOwners: this.conversationOwners.size
    }
  }
}

export const serverState = new StateManager()

export function initServerState(): void {
  serverState.init()
}

export function shutdownServerState(): void {
  serverState.shutdown()
}

export function addUserToCache(userId: string, data: Omit<CachedUser, 'lastAccessedAt'>): void {
  const now = Date.now()
  serverState.userCache.set(userId, { ...data, lastAccessedAt: now })
  serverState.userNames.set(userId, data.name)
  serverState.emailPreferences.set(userId, data.emailNotifyOnMessage)
}

export function updateUserCache(userId: string, updates: Partial<CachedUser>): void {
  const existing = serverState.userCache.get(userId)
  if (existing) {
    serverState.userCache.set(userId, { ...existing, ...updates })
    if (updates.name) {
      serverState.userNames.set(userId, updates.name)
    }
    if (updates.emailNotifyOnMessage !== undefined) {
      serverState.emailPreferences.set(userId, updates.emailNotifyOnMessage)
    }
  }
}

export function removeUserFromCache(userId: string): void {
  serverState.userCache.delete(userId)
  serverState.userNames.delete(userId)
  serverState.emailPreferences.delete(userId)
  serverState.userPresence.delete(userId)
  serverState.connectedUsers.delete(userId)

  const sessionKeys = serverState.userSessionKeys.get(userId)
  if (sessionKeys) {
    for (const sessionKey of sessionKeys) {
      serverState.sessionValidationCache.delete(sessionKey)
    }
    serverState.userSessionKeys.delete(userId)
  }
}

export function getUserFromCache(userId: string): CachedUser | undefined {
  const user = serverState.userCache.get(userId)
  if (user) {
    user.lastAccessedAt = Date.now()
    // Re-insert to push to the back of the Map (refresh LRU status)
    serverState.userCache.delete(userId)
    serverState.userCache.set(userId, user)
  }
  return user
}

export function setConversationOwner(conversationId: string, userId: string): void {
  const now = Date.now()
  serverState.conversationOwners.set(conversationId, { userId, lastActivityAt: now })
  serverState.userToConversation.set(userId, conversationId)
}

export function getUserConversationId(userId: string): string | undefined {
  const conversationId = serverState.userToConversation.get(userId)
  if (conversationId) {
    const owner = serverState.conversationOwners.get(conversationId)
    if (owner) {
      owner.lastActivityAt = Date.now()
      // Re-insert to push to the back of the Map (refresh LRU status)
      serverState.conversationOwners.delete(conversationId)
      serverState.conversationOwners.set(conversationId, owner)
    }
  }
  return conversationId
}

export function touchConversationOwner(conversationId: string): void {
  const owner = serverState.conversationOwners.get(conversationId)
  if (owner) {
    owner.lastActivityAt = Date.now()
    // Re-insert to push to the back of the Map (refresh LRU status)
    serverState.conversationOwners.delete(conversationId)
    serverState.conversationOwners.set(conversationId, owner)
  }
}

function getSessionValidationCacheKey(userId: string, sessionId: string): string {
  return `${userId}:${sessionId}`
}

export function getSessionValidationCache(userId: string, sessionId: string): boolean | undefined {
  const key = getSessionValidationCacheKey(userId, sessionId)
  const entry = serverState.sessionValidationCache.get(key)
  if (!entry) {
    return undefined
  }

  if (entry.expiresAt <= Date.now()) {
    serverState.sessionValidationCache.delete(key)
    return undefined
  }

  return entry.valid
}

export function setSessionValidationCache(
  userId: string,
  sessionId: string,
  valid: boolean,
  ttlMs: number
): void {
  const key = getSessionValidationCacheKey(userId, sessionId)

  // Enforce max size to prevent memory leak
  if (serverState.sessionValidationCache.size >= DEFAULT_MAX_SESSION_CACHE_SIZE) {
    // Remove expired entries first
    const now = Date.now()
    for (const [k, entry] of serverState.sessionValidationCache.entries()) {
      if (entry.expiresAt <= now) {
        serverState.sessionValidationCache.delete(k)
      }
    }

    // If still over limit, remove oldest 20%
    if (serverState.sessionValidationCache.size >= DEFAULT_MAX_SESSION_CACHE_SIZE) {
      const toDeleteCount = Math.floor(DEFAULT_MAX_SESSION_CACHE_SIZE * 0.2)
      let removed = 0
      for (const k of serverState.sessionValidationCache.keys()) {
        if (removed >= toDeleteCount) break
        serverState.sessionValidationCache.delete(k)
        removed++
      }
    }
  }

  serverState.sessionValidationCache.set(key, {
    valid,
    expiresAt: Date.now() + ttlMs
  })

  let userKeys = serverState.userSessionKeys.get(userId)
  if (!userKeys) {
    userKeys = new Set()
    serverState.userSessionKeys.set(userId, userKeys)
  }
  userKeys.add(key)
}

export function invalidateSessionCache(userId: string, sessionId: string): void {
  const key = getSessionValidationCacheKey(userId, sessionId)
  serverState.sessionValidationCache.delete(key)
  const userKeys = serverState.userSessionKeys.get(userId)
  if (userKeys) {
    userKeys.delete(key)
    if (userKeys.size === 0) {
      serverState.userSessionKeys.delete(userId)
    }
  }
}
