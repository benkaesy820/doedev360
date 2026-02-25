import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { env } from '../lib/env.js'
import { getConfig } from '../lib/config.js'
import { emitToAdmins } from '../socket/index.js'
import { retryWithBackoff, escapeHtml } from '../lib/utils.js'
import { logger } from '../lib/logger.js'
import { CircuitBreaker } from '../lib/circuitBreaker.js'

interface EmailParams {
  type: 'accountApproved' | 'accountRejected' | 'accountSuspended' | 'newMessage' | 'passwordReset'
  userId: string
  reason?: string
  messageCount?: number
  resetToken?: string
}

type EmailProvider = 'brevo' | 'smtp' | 'resend'

interface EmailResult {
  success: boolean
  provider: EmailProvider
  error?: string
}

const DEFAULT_MAX_QUEUE_SIZE = 1000
/** Email timeout capped at 8 seconds to prevent long hangs */
const EMAIL_TIMEOUT_MS = 8000

const emailQueue: Array<{ params: EmailParams; resolve: () => void; reject: (err: Error) => void }> = []
let isProcessingQueue = false

const providerCircuitBreakers: Record<EmailProvider, CircuitBreaker> = {
  brevo: new CircuitBreaker({
    name: 'Email-Brevo',
    failureThreshold: getConfig().storage.circuitBreaker.failureThreshold,
    recoveryTimeoutMs: getConfig().storage.circuitBreaker.recoveryTimeoutMs,
    onStateChange: (state, failures) => {
      if (state === 'OPEN') {
        emitToAdmins('email:provider_circuit_opened', {
          provider: 'brevo',
          state,
          failures,
          timestamp: Date.now()
        })
      }
    }
  }),
  smtp: new CircuitBreaker({
    name: 'Email-SMTP',
    failureThreshold: getConfig().storage.circuitBreaker.failureThreshold,
    recoveryTimeoutMs: getConfig().storage.circuitBreaker.recoveryTimeoutMs,
    onStateChange: (state, failures) => {
      if (state === 'OPEN') {
        emitToAdmins('email:provider_circuit_opened', {
          provider: 'smtp',
          state,
          failures,
          timestamp: Date.now()
        })
      }
    }
  }),
  resend: new CircuitBreaker({
    name: 'Email-Resend',
    failureThreshold: getConfig().storage.circuitBreaker.failureThreshold,
    recoveryTimeoutMs: getConfig().storage.circuitBreaker.recoveryTimeoutMs,
    onStateChange: (state, failures) => {
      if (state === 'OPEN') {
        emitToAdmins('email:provider_circuit_opened', {
          provider: 'resend',
          state,
          failures,
          timestamp: Date.now()
        })
      }
    }
  })
}

async function withProviderCircuitBreaker<T>(provider: EmailProvider, operation: () => Promise<T>): Promise<T> {
  return providerCircuitBreakers[provider].execute(operation)
}

function getMaxQueueSize(): number {
  return getConfig().cache?.maxEmailQueueSize ?? DEFAULT_MAX_QUEUE_SIZE
}

function queueEmail(params: EmailParams): Promise<void> {
  return new Promise((resolve, reject) => {
    const maxQueueSize = getMaxQueueSize()
    if (emailQueue.length >= maxQueueSize) {
      logger.warn({ queueSize: emailQueue.length, maxQueueSize }, 'Email queue full, rejecting')
      reject(new Error('Email queue is full'))
      return
    }
    emailQueue.push({ params, resolve, reject })
    processQueue()
  })
}

async function processQueue(): Promise<void> {
  if (isProcessingQueue || emailQueue.length === 0) return

  isProcessingQueue = true

  try {
    while (emailQueue.length > 0) {
      const item = emailQueue.shift()
      if (!item) break

      try {
        await sendEmailInternal(item.params)
        item.resolve()
      } catch (error) {
        item.reject(error instanceof Error ? error : new Error('Email failed'))
      }
    }
  } finally {
    isProcessingQueue = false
  }
}

export async function sendEmail(params: EmailParams): Promise<void> {
  if (env.isDev && !env.smtpHost) {
    logger.info({ type: params.type, userId: params.userId }, 'Email skipped (dev mode)')
    return
  }

  return queueEmail(params)
}

async function sendEmailInternal(params: EmailParams): Promise<void> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, params.userId),
    columns: { email: true, name: true }
  })

  if (!user) {
    throw new Error('User not found')
  }

  const appUrl = env.appUrl
  const appName = env.appName

  let subject: string
  let htmlContent: string

  switch (params.type) {
    case 'accountApproved':
      subject = `Welcome to ${appName} - Account Approved`
      htmlContent = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #1a1a1a;">Your account has been approved!</h2>
          <p>Hi ${escapeHtml(user.name)},</p>
          <p>Great news! Your account has been approved and you can now start using ${escapeHtml(appName)}.</p>
          <p style="margin: 30px 0;">
            <a href="${appUrl}/login" style="background: #000; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Login Now</a>
          </p>
          <p>If you have any questions, feel free to reach out to us.</p>
          <p>Best regards,<br>${escapeHtml(appName)} Team</p>
        </div>
      `
      break

    case 'accountRejected':
      subject = `${appName} - Account Application Update`
      htmlContent = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #1a1a1a;">Account Application Update</h2>
          <p>Hi ${escapeHtml(user.name)},</p>
          <p>We're unable to approve your account at this time.</p>
          ${params.reason ? `<p><strong>Reason:</strong> ${escapeHtml(params.reason)}</p>` : ''}
          <p>If you believe this was a mistake or have questions, please contact us.</p>
          <p>Best regards,<br>${escapeHtml(appName)} Team</p>
        </div>
      `
      break

    case 'accountSuspended':
      subject = `${appName} - Account Suspended`
      htmlContent = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #dc2626;">Account Suspended</h2>
          <p>Hi ${escapeHtml(user.name)},</p>
          <p>Your account has been suspended.</p>
          ${params.reason ? `<p><strong>Reason:</strong> ${escapeHtml(params.reason)}</p>` : ''}
          <p>If you believe this was a mistake, please contact us.</p>
          <p>Best regards,<br>${escapeHtml(appName)} Team</p>
        </div>
      `
      break

    case 'newMessage': {
      const messageText = params.messageCount === 1
        ? 'You have 1 new message'
        : `You have ${params.messageCount} new messages`

      subject = `New message from ${appName}`
      htmlContent = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #1a1a1a;">${messageText}</h2>
          <p>Hi ${escapeHtml(user.name)},</p>
          <p>${messageText} waiting for you.</p>
          <p style="margin: 30px 0;">
            <a href="${appUrl}/messages" style="background: #000; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">View Messages</a>
          </p>
          <hr style="margin: 24px 0; border: none; border-top: 1px solid #eee;">
          <p style="color: #666; font-size: 12px;">
            Don't want these emails? 
            <a href="${appUrl}/settings" style="color: #666;">Update your preferences</a>
          </p>
        </div>
      `
      break
    }

    case 'passwordReset':
      if (!params.resetToken) {
        throw new Error('Reset token missing')
      }
      subject = `${appName} - Reset Your Password`
      htmlContent = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #1a1a1a;">Reset your password</h2>
          <p>Hi ${escapeHtml(user.name)},</p>
          <p>We received a request to reset your password. If you made this request, use the button below.</p>
          <p style="margin: 30px 0;">
            <a href="${appUrl}/reset-password?token=${params.resetToken}" style="background: #000; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Reset Password</a>
          </p>
          <p>If you did not request this, you can safely ignore this email.</p>
          <p>Best regards,<br>${escapeHtml(appName)} Team</p>
        </div>
      `
      break
  }

  const results: EmailResult[] = []

  if (env.isProd && env.brevoApiKey) {
    try {
      await withProviderCircuitBreaker('brevo', () => retryWithBackoff(async () => {
        await sendWithBrevo(user.email, user.name, subject, htmlContent)
      }, 3, 1000))
      results.push({ success: true, provider: 'brevo' })
      logger.info({ provider: 'brevo', type: params.type, userId: params.userId }, 'Email sent')
      return
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      results.push({ success: false, provider: 'brevo', error: errorMsg })
      logger.warn({ provider: 'brevo', error: errorMsg, userId: params.userId }, 'Email failed')

      emitToAdmins('email:provider_failed', {
        provider: 'brevo',
        recipient: user.email,
        error: errorMsg,
        timestamp: Date.now()
      })
    }
  }

  if (env.smtpHost && env.smtpPort) {
    try {
      await withProviderCircuitBreaker('smtp', () => retryWithBackoff(async () => {
        await sendWithSMTP(user.email, user.name, subject, htmlContent)
      }, 2, 500))
      results.push({ success: true, provider: 'smtp' })
      logger.info({ provider: 'smtp', type: params.type, userId: params.userId }, 'Email sent')
      return
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      results.push({ success: false, provider: 'smtp', error: errorMsg })

      emitToAdmins('email:provider_failed', {
        provider: 'smtp',
        recipient: user.email,
        error: errorMsg,
        timestamp: Date.now()
      })
    }
  }

  if (env.resendApiKey) {
    try {
      await withProviderCircuitBreaker('resend', () => retryWithBackoff(async () => {
        await sendWithResend(user.email, user.name, subject, htmlContent)
      }, 2, 500))
      results.push({ success: true, provider: 'resend' })
      logger.info({ provider: 'resend', type: params.type, userId: params.userId }, 'Email sent')
      return
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      results.push({ success: false, provider: 'resend', error: errorMsg })

      emitToAdmins('email:provider_failed', {
        provider: 'resend',
        recipient: user.email,
        error: errorMsg,
        timestamp: Date.now()
      })
    }
  }

  if (env.isDev) {
    logger.debug({ type: params.type, userId: params.userId, email: user.email }, 'Email (dev mode)')
    return
  }

  const failureSummary = {
    recipient: user.email,
    type: params.type,
    results,
    timestamp: Date.now()
  }

  logger.error(failureSummary, 'All email providers failed')
  emitToAdmins('email:all_providers_failed', failureSummary)

  throw new Error(`All email providers failed for ${user.email}`)
}

async function sendWithBrevo(
  email: string,
  name: string,
  subject: string,
  htmlContent: string
): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS)

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'accept': 'application/json',
        'api-key': env.brevoApiKey!,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: {
          name: env.brevoSenderName || env.appName,
          email: env.brevoSenderEmail
        },
        to: [{ email, name }],
        subject,
        htmlContent
      })
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Brevo API error: ${error}`)
    }
  } finally {
    clearTimeout(timeout)
  }
}

interface SmtpTransporter { sendMail: (opts: Record<string, unknown>) => Promise<unknown> }
let cachedSmtpTransporter: SmtpTransporter | null = null

async function getSmtpTransporter(): Promise<SmtpTransporter> {
  if (cachedSmtpTransporter) return cachedSmtpTransporter
  const nodemailer = await import('nodemailer')
  cachedSmtpTransporter = nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpPort === 465,
    connectionTimeout: EMAIL_TIMEOUT_MS,
    socketTimeout: EMAIL_TIMEOUT_MS
  })
  return cachedSmtpTransporter
}

async function sendWithSMTP(
  email: string,
  name: string,
  subject: string,
  htmlContent: string
): Promise<void> {
  const transporter = await getSmtpTransporter()
  const senderEmail = env.smtpSenderEmail || env.brevoSenderEmail || `noreply@${new URL(env.appUrl).hostname}`
  await transporter.sendMail({
    from: `"${env.appName}" <${senderEmail}>`,
    to: `"${name}" <${email}>`,
    subject,
    html: htmlContent
  })
}

async function sendWithResend(
  email: string,
  name: string,
  subject: string,
  htmlContent: string
): Promise<void> {
  const fromDomain = new URL(env.appUrl).hostname

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS)

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${env.resendApiKey!}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: `${env.appName} <noreply@${fromDomain}>`,
        to: [`${name} <${email}>`],
        subject,
        html: htmlContent
      })
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Resend API error: ${error}`)
    }
  } finally {
    clearTimeout(timeout)
  }
}