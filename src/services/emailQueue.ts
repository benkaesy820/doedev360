import { serverState } from '../state.js'
import { sendEmail } from './email.js'
import { getConfig } from '../lib/config.js'
import { sleep } from '../lib/utils.js'
import { logger } from '../lib/logger.js'

let pendingSends: Set<Promise<void>> = new Set()

export function queueEmailNotification(userId: string): void {
  const config = getConfig()

  const emailEnabled = serverState.emailPreferences.get(userId)
  if (emailEnabled === false) {
    return
  }

  const presence = serverState.userPresence.get(userId)
  if (presence?.status === 'online') {
    return
  }

  const now = Date.now()
  const offlineThreshold = config.email.notification.minOfflineSeconds * 1000

  if (presence && (now - presence.lastSeen) < offlineThreshold) {
    return
  }

  const existing = serverState.pendingEmails.get(userId)
  const debounceMs = config.email.notification.debounceSeconds * 1000
  const maxDelayMs = config.email.notification.maxDelaySeconds * 1000

  if (existing) {
    clearTimeout(existing.timer)

    const elapsed = now - existing.firstMessageAt
    const shouldSendNow = elapsed >= maxDelayMs

    if (shouldSendNow) {
      scheduleEmailSend(userId, existing.messageCount + 1)
      serverState.pendingEmails.delete(userId)
      return
    }

    const timer = setTimeout(() => {
      scheduleEmailSend(userId, existing.messageCount + 1)
      serverState.pendingEmails.delete(userId)
    }, debounceMs)

    serverState.pendingEmails.set(userId, {
      ...existing,
      messageCount: existing.messageCount + 1,
      timer
    })
  } else {
    const timer = setTimeout(() => {
      scheduleEmailSend(userId, 1)
      serverState.pendingEmails.delete(userId)
    }, debounceMs)

    serverState.pendingEmails.set(userId, {
      userId,
      messageCount: 1,
      firstMessageAt: now,
      timer
    })
  }
}

function scheduleEmailSend(userId: string, messageCount: number): void {
  const emailEnabled = serverState.emailPreferences.get(userId)
  if (emailEnabled === false) {
    return
  }

  const sendPromise = sendEmailWithRetry(userId, messageCount).catch((error) => {
    logger.error({ userId, error: error.message }, 'Email notification failed')
  })
  
  pendingSends.add(sendPromise)
  
  sendPromise.finally(() => {
    pendingSends.delete(sendPromise)
  })
}

async function sendEmailWithRetry(userId: string, messageCount: number): Promise<void> {
  const config = getConfig()
  const maxRetries = config.email.notification.maxRetries
  const backoffMs = config.email.notification.retryBackoffMs

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await sendEmail({
        type: 'newMessage',
        userId,
        messageCount
      })
      logger.info({ userId, messageCount }, 'Email notification sent')
      return
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error'
      logger.warn({ userId, attempt: attempt + 1, error: errMsg }, 'Email notification attempt failed')

      if (attempt < maxRetries - 1) {
        await sleep(backoffMs * Math.pow(2, attempt))
      }
    }
  }

  logger.error({ userId, messageCount }, 'Email notification failed after all retries')
}

export function cancelEmailNotification(userId: string): void {
  const pending = serverState.pendingEmails.get(userId)
  if (pending) {
    clearTimeout(pending.timer)
    serverState.pendingEmails.delete(userId)
  }
}

export async function drainEmailQueue(timeoutMs: number = 5000): Promise<void> {
  const pending = Array.from(serverState.pendingEmails.values())
  
  for (const item of pending) {
    clearTimeout(item.timer)
  }
  
  serverState.pendingEmails.clear()
  
  if (pendingSends.size > 0) {
    const drainPromise = Promise.allSettled(pendingSends)
    const timeoutPromise = sleep(timeoutMs).then(() => {
      logger.warn({ count: pendingSends.size }, 'Email queue drain timed out')
    })
    
    await Promise.race([drainPromise, timeoutPromise])
  }
  
  logger.info({ drained: pending.length }, 'Email queue drained')
}

export function getEmailQueueStats(): { pending: number; inFlight: number } {
  return {
    pending: serverState.pendingEmails.size,
    inFlight: pendingSends.size
  }
}