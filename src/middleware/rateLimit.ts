import type { FastifyRequest, FastifyReply } from 'fastify'
import { getConfig } from '../lib/config.js'
import { logger } from '../lib/logger.js'

interface RateLimitEntry {
  count: number
  resetAt: number
}

interface LoginAttempt {
  attempts: number
  firstAttemptAt: number
  lockedUntil: number | null
}

const DEFAULT_MAX_ENTRIES = 10000
const DEFAULT_CLEANUP_INTERVAL_MS = 60000

function getCacheConfig() {
  const config = getConfig()
  return {
    maxEntries: config.cache?.maxRateLimitEntries ?? DEFAULT_MAX_ENTRIES,
    cleanupIntervalMs: config.cache?.rateLimitCleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS
  }
}

class RateLimitStore {
  private store: Map<string, RateLimitEntry> = new Map()
  private maxEntries: number
  private cleanupInterval: NodeJS.Timeout

  constructor() {
    const cacheConfig = getCacheConfig()
    this.maxEntries = cacheConfig.maxEntries
    this.cleanupInterval = setInterval(() => this.runCleanup(), cacheConfig.cleanupIntervalMs)
  }

  increment(key: string, windowMs: number, maxRequests: number): { count: number; resetAt: number; blocked: boolean } {
    const now = Date.now()
    const resetAt = now + windowMs
    const entry = this.store.get(key)

    if (!entry || entry.resetAt <= now || entry.resetAt > now + windowMs) {
      this.store.set(key, { count: 1, resetAt })
      return { count: 1, resetAt, blocked: false }
    }

    entry.count++
    const blocked = entry.count > maxRequests
    return { count: entry.count, resetAt: entry.resetAt, blocked }
  }

  reset(key: string): void {
    this.store.delete(key)
  }

  stop(): void {
    clearInterval(this.cleanupInterval)
  }

  getStats(): { size: number } {
    return { size: this.store.size }
  }

  private runCleanup(): void {
    const now = Date.now()
    let deleted = 0

    for (const [key, entry] of this.store.entries()) {
      if (entry.resetAt <= now) {
        this.store.delete(key)
        deleted++
      }
    }

    if (this.store.size > this.maxEntries) {
      let toDelete = this.store.size - this.maxEntries
      for (const [key, entry] of this.store.entries()) {
        if (toDelete <= 0) break
        this.store.delete(key)
        deleted++
        toDelete--
      }
    }

    if (deleted > 0) {
      logger.debug({ deleted, remaining: this.store.size }, 'Rate limit store cleanup')
    }
  }
}

class LoginLockoutStore {
  private attempts: Map<string, LoginAttempt> = new Map()
  private maxEntries: number
  private cleanupInterval: NodeJS.Timeout

  constructor() {
    const cacheConfig = getCacheConfig()
    this.maxEntries = cacheConfig.maxEntries
    this.cleanupInterval = setInterval(() => this.runCleanup(), cacheConfig.cleanupIntervalMs)
  }

  recordAttempt(ip: string, success: boolean): void {
    const now = Date.now()
    const config = getConfig() // Read live configuration
    const windowMs = config.rateLimit.login.windowMinutes * 60 * 1000
    const entry = this.attempts.get(ip)

    if (!entry || entry.firstAttemptAt + windowMs <= now || entry.firstAttemptAt > now) {
      if (success) {
        this.attempts.delete(ip)
        return
      }
      this.attempts.set(ip, {
        attempts: 1,
        firstAttemptAt: now,
        lockedUntil: null
      })
      return
    }

    if (success) {
      this.attempts.delete(ip)
      return
    }

    entry.attempts++

    if (entry.attempts >= config.rateLimit.login.maxAttempts && !entry.lockedUntil) {
      entry.lockedUntil = now + config.rateLimit.login.lockoutMinutes * 60 * 1000
    }
  }

  checkLockout(ip: string): { locked: boolean; retryAfter?: number } {
    const entry = this.attempts.get(ip)
    if (!entry || !entry.lockedUntil) {
      return { locked: false }
    }

    const now = Date.now()
    const config = getConfig()
    const configuredLockoutMs = config.rateLimit.login.lockoutMinutes * 60 * 1000

    // If the configured timeout shrank dynamically, existing locks might be floating too far in the future
    if (entry.lockedUntil > now && entry.lockedUntil <= now + configuredLockoutMs) {
      return { locked: true, retryAfter: Math.ceil((entry.lockedUntil - now) / 1000) }
    }

    this.attempts.delete(ip)
    return { locked: false }
  }

  stop(): void {
    clearInterval(this.cleanupInterval)
  }

  private runCleanup(): void {
    const now = Date.now()
    const config = getConfig()
    const maxAge = (config.rateLimit.login.windowMinutes + config.rateLimit.login.lockoutMinutes) * 60 * 1000

    for (const [key, entry] of this.attempts.entries()) {
      if (entry.firstAttemptAt + maxAge <= now) {
        this.attempts.delete(key)
      }
    }

    if (this.attempts.size > this.maxEntries) {
      let toDelete = this.attempts.size - this.maxEntries
      for (const [key] of this.attempts.entries()) {
        if (toDelete <= 0) break
        this.attempts.delete(key)
        toDelete--
      }
    }
  }
}

const apiStore = new RateLimitStore()
const loginStore = new RateLimitStore()
const registrationStore = new RateLimitStore()
const passwordResetStore = new RateLimitStore()
const passwordChangeStore = new RateLimitStore()
const mediaUploadStore = new RateLimitStore()
const messageMinuteStore = new RateLimitStore()
const messageHourStore = new RateLimitStore()
const loginLockoutStore = new LoginLockoutStore()

export function checkLoginLockout(ip: string): { locked: boolean; retryAfter?: number } {
  return loginLockoutStore.checkLockout(ip)
}

export function recordLoginAttempt(ip: string, success: boolean): void {
  loginLockoutStore.recordAttempt(ip, success)
}

function createRateLimiter(
  store: RateLimitStore,
  configGetter: () => { windowMs: number; maxRequests: number },
  keyFn: (req: FastifyRequest) => string = (req) => req.ip
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const key = keyFn(request)
    const { windowMs, maxRequests } = configGetter() // Live dynamically resolved limits
    const { count, resetAt, blocked } = store.increment(key, windowMs, maxRequests)

    reply.header('X-RateLimit-Limit', maxRequests.toString())
    reply.header('X-RateLimit-Remaining', Math.max(0, maxRequests - count).toString())
    reply.header('X-RateLimit-Reset', new Date(resetAt).toISOString())

    if (blocked) {
      const retryAfter = Math.ceil((resetAt - Date.now()) / 1000)
      reply.header('Retry-After', retryAfter.toString())
      reply.code(429).send({
        success: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests, please try again later',
          retryAfter
        }
      })
      return
    }
  }
}

export interface RateLimiters {
  api: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  login: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  registration: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  passwordReset: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  passwordChange: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  mediaUpload: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  message: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  socketMessage: (userId: string) => boolean
}

export function createRateLimiters(): RateLimiters {
  // Rather than capturing config values, we dynamically read from getConfig()
  // within each preHandler middleware via our configGetter approach.

  const messageRateLimiter = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const config = getConfig() // Read dynamically
    const role = request.user?.role
    if (role === 'ADMIN' || role === 'SUPER_ADMIN') return
    const key = request.user?.id ?? request.ip
    const minuteResult = messageMinuteStore.increment(key, 60 * 1000, config.limits.message.perMinute)
    const hourResult = messageHourStore.increment(key, 60 * 60 * 1000, config.limits.message.perHour)

    reply.header('X-RateLimit-Limit', config.limits.message.perMinute.toString())
    reply.header('X-RateLimit-Remaining', Math.max(0, config.limits.message.perMinute - minuteResult.count).toString())
    reply.header('X-RateLimit-Reset', new Date(minuteResult.resetAt).toISOString())

    if (minuteResult.blocked || hourResult.blocked) {
      const retryAfterMs = Math.max(minuteResult.resetAt, hourResult.resetAt) - Date.now()
      const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000))
      reply.header('Retry-After', retryAfter.toString())
      reply.code(429).send({
        success: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests, please try again later',
          retryAfter
        }
      })
      return
    }
  }

  return {
    api: createRateLimiter(
      apiStore,
      () => ({ windowMs: 60000, maxRequests: getConfig().rateLimit.api.requestsPerMinute })
    ),

    login: createRateLimiter(
      loginStore,
      () => {
        const c = getConfig().rateLimit.login;
        return { windowMs: c.windowMinutes * 60 * 1000, maxRequests: c.maxAttempts }
      }
    ),

    registration: createRateLimiter(
      registrationStore,
      () => {
        const c = getConfig().rateLimit.registration;
        return { windowMs: c.windowHours * 60 * 60 * 1000, maxRequests: c.maxAttempts }
      }
    ),

    passwordReset: createRateLimiter(
      passwordResetStore,
      () => {
        const c = getConfig().rateLimit.passwordReset;
        return { windowMs: c.windowMinutes * 60 * 1000, maxRequests: c.maxAttempts }
      }
    ),

    passwordChange: createRateLimiter(
      passwordChangeStore,
      () => {
        const c = getConfig().rateLimit.passwordChange;
        return { windowMs: c.windowMinutes * 60 * 1000, maxRequests: c.maxAttempts }
      }
    ),

    mediaUpload: createRateLimiter(
      mediaUploadStore,
      () => ({ windowMs: 24 * 60 * 60 * 1000, maxRequests: getConfig().limits.media.perDay })
    ),

    message: messageRateLimiter,

    socketMessage: (userId: string): boolean => {
      const config = getConfig()
      const minuteResult = messageMinuteStore.increment(`socket:minute:${userId}`, 60 * 1000, config.limits.message.perMinute)
      const hourResult = messageHourStore.increment(`socket:hour:${userId}`, 60 * 60 * 1000, config.limits.message.perHour)
      return !minuteResult.blocked && !hourResult.blocked
    }
  }
}

export function getRateLimitStats(): Record<string, { size: number }> {
  return {
    api: apiStore.getStats(),
    login: loginStore.getStats(),
    registration: registrationStore.getStats(),
    passwordReset: passwordResetStore.getStats(),
    passwordChange: passwordChangeStore.getStats(),
    mediaUpload: mediaUploadStore.getStats(),
    messageMinute: messageMinuteStore.getStats(),
    messageHour: messageHourStore.getStats()
  }
}

export function stopRateLimitCleanup(): void {
  apiStore.stop()
  loginStore.stop()
  registrationStore.stop()
  passwordResetStore.stop()
  passwordChangeStore.stop()
  mediaUploadStore.stop()
  messageMinuteStore.stop()
  messageHourStore.stop()
  loginLockoutStore.stop()
}
