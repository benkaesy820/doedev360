import { createHash } from 'crypto'

const HTML_ENTITY_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
  '`': '&#x60;',
  '=': '&#x3D;'
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase().slice(0, 255)
}

export function escapeHtml(str: string): string {
  return str.replace(/[&<>"'`=/]/g, char => HTML_ENTITY_MAP[char] || char)
}

export function sanitizeText(str: string): string {
  return str
    .trim()
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .slice(0, 10000)
}

export function sanitizeName(str: string): string {
  return str
    .trim()
    .replace(/[<>'"`]/g, '')
    .slice(0, 100)
}

export function sanitizeFilename(str: string): string {
  return str
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\.\./g, '')
    .slice(0, 255)
}

export type RetryableErrorClassifier = (error: unknown) => boolean

const defaultRetryableClassifier: RetryableErrorClassifier = (error): boolean => {
  if (error instanceof Error) {
    const message = error.message.toLowerCase()
    if (message.includes('timeout')) return true
    if (message.includes('econnreset')) return true
    if (message.includes('econnrefused')) return true
    if (message.includes('enotfound')) return true
    if (message.includes('eai_again')) return true
    if (message.includes('socket hang up')) return true
    if (message.includes('network')) return true
    if (message.includes('temporarily unavailable')) return true
    if (message.includes('service unavailable')) return true
    if (message.includes('circuit breaker is open')) return false
    return false
  }
  return false
}

export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelay: number = 1000,
  isRetryable: RetryableErrorClassifier = defaultRetryableClassifier
): Promise<T> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (!isRetryable(error)) {
        throw lastError
      }

      if (attempt === maxAttempts) {
        break
      }

      const delay = baseDelay * Math.pow(2, attempt - 1)
      const jitter = Math.random() * 0.1 * delay
      await new Promise(resolve => setTimeout(resolve, delay + jitter))
    }
  }

  throw lastError || new Error('All retry attempts failed')
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parseUserAgent(ua: string): { browser: string; os: string; device: string } {
  const s = ua.toLowerCase()

  // Browser
  let browser = 'Unknown'
  if (s.includes('edg/') || s.includes('edge/')) browser = 'Edge'
  else if (s.includes('opr/') || s.includes('opera/')) browser = 'Opera'
  else if (s.includes('chrome/') && !s.includes('chromium/')) browser = 'Chrome'
  else if (s.includes('firefox/')) browser = 'Firefox'
  else if (s.includes('safari/') && !s.includes('chrome/')) browser = 'Safari'
  else if (s.includes('msie') || s.includes('trident/')) browser = 'IE'

  // OS
  let os = 'Unknown'
  if (s.includes('windows nt 10')) os = 'Windows 10/11'
  else if (s.includes('windows nt 6.3')) os = 'Windows 8.1'
  else if (s.includes('windows nt 6.1')) os = 'Windows 7'
  else if (s.includes('windows')) os = 'Windows'
  else if (s.includes('iphone os')) { const m = s.match(/iphone os ([\d_]+)/); os = `iOS ${m ? m[1]?.replace(/_/g, '.') ?? '' : ''}`.trim() }
  else if (s.includes('ipad')) { const m = s.match(/cpu os ([\d_]+)/); os = `iPadOS ${m ? m[1]?.replace(/_/g, '.') ?? '' : ''}`.trim() }
  else if (s.includes('android')) { const m = s.match(/android ([\d.]+)/); os = `Android ${m ? m[1] ?? '' : ''}`.trim() }
  else if (s.includes('mac os x')) { const m = s.match(/mac os x ([\d_]+)/); os = `macOS ${m ? m[1]?.replace(/_/g, '.') ?? '' : ''}`.trim() }
  else if (s.includes('linux')) os = 'Linux'

  // Device type
  let device = 'Desktop'
  if (s.includes('mobile') || s.includes('iphone') || s.includes('android') && !s.includes('tablet')) device = 'Mobile'
  else if (s.includes('tablet') || s.includes('ipad')) device = 'Tablet'

  return { browser, os, device }
}

export function extractDeviceInfo(request: { headers: Record<string, string | string[] | undefined> }): string {
  const ua = request.headers['user-agent']
  const userAgent = typeof ua === 'string' ? ua : ua?.[0] || 'unknown'
  const parsed = parseUserAgent(userAgent)

  return JSON.stringify({
    browser: parsed.browser,
    os: parsed.os,
    device: parsed.device,
    userAgent: userAgent.slice(0, 300),
  })
}

export function hashEmail(email: string): string {
  return createHash('sha256').update(email.toLowerCase()).digest('hex')
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/

export function isValidId(id: string): boolean {
  return ULID_REGEX.test(id)
}

const FILE_SIGNATURES: Record<string, { signature: number[]; offset?: number }> = {
  'image/jpeg': { signature: [0xFF, 0xD8, 0xFF] },
  'image/png': { signature: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  'image/gif': { signature: [0x47, 0x49, 0x46, 0x38] },
  'image/webp': { signature: [0x52, 0x49, 0x46, 0x46], offset: 0 },
  'image/bmp': { signature: [0x42, 0x4D] },

  'video/mp4': { signature: [0x00, 0x00, 0x00], offset: 0 },
  'video/webm': { signature: [0x1A, 0x45, 0xDF, 0xA3] },
  'video/quicktime': { signature: [0x00, 0x00, 0x00] },
  'video/x-matroska': { signature: [0x1A, 0x45, 0xDF, 0xA3] },
  'application/pdf': { signature: [0x25, 0x50, 0x44, 0x46] },
  'application/zip': { signature: [0x50, 0x4B, 0x03, 0x04] },
  'application/x-zip-compressed': { signature: [0x50, 0x4B, 0x03, 0x04] },
}

const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46]
const WEBP_WEBP = [0x57, 0x45, 0x42, 0x50]
const MP4_FTYP = [0x66, 0x74, 0x79, 0x70]


function bufferStartsWith(buffer: Buffer, signature: number[], offset: number = 0): boolean {
  if (buffer.length < offset + signature.length) return false
  for (let i = 0; i < signature.length; i++) {
    if (buffer[offset + i] !== signature[i]) return false
  }
  return true
}

export function validateFileSignature(buffer: Buffer, mimeType: string): boolean {
  const sig = FILE_SIGNATURES[mimeType]
  if (!sig) return true

  const offset = sig.offset ?? 0
  if (!bufferStartsWith(buffer, sig.signature, offset)) return false

  if (mimeType === 'image/webp') {
    if (!bufferStartsWith(buffer, WEBP_RIFF, 0)) return false
    if (buffer.length < 12) return false
    if (!bufferStartsWith(buffer, WEBP_WEBP, 8)) return false
    return true
  }

  if (mimeType === 'video/mp4' || mimeType === 'video/quicktime') {
    if (buffer.length < 12) return false
    const ftypOffset = buffer.length > 4 && buffer[4] === 0x66 ? 4 : -1
    if (ftypOffset === -1) return false
    if (!bufferStartsWith(buffer, MP4_FTYP, ftypOffset)) return false
    return true
  }


  return true
}
