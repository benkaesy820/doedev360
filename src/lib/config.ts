import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { z } from 'zod'

const brandSchema = z.object({
    siteName: z.string().min(1),
    tagline: z.string(),
    company: z.string(),
    supportEmail: z.string().email(),
    logoUrl: z.string().optional(),
    primaryColor: z.string().optional()
})

export type BrandConfig = z.infer<typeof brandSchema>

export { brandSchema }

const configSchema = z.object({
    brand: brandSchema.optional(),
    limits: z.object({
        message: z.object({
            textMaxLength: z.number().positive(),
            teamTextMaxLength: z.number().positive().default(5000),
            perMinute: z.number().positive(),
            perHour: z.number().positive()
        }),
        media: z.object({
            maxSizeImage: z.number().positive(),
            maxSizeVideo: z.number().positive(),
            maxSizeDocument: z.number().positive(),
            perDay: z.number().positive()
        }),
        upload: z.object({
            presignedUrlTTL: z.number().positive(),
            confirmTimeout: z.number().positive()
        })
    }),
    rateLimit: z.object({
        login: z.object({
            maxAttempts: z.number().positive(),
            windowMinutes: z.number().positive(),
            lockoutMinutes: z.number().positive()
        }),
        passwordReset: z.object({
            maxAttempts: z.number().positive(),
            windowMinutes: z.number().positive()
        }),
        passwordChange: z.object({
            maxAttempts: z.number().positive(),
            windowMinutes: z.number().positive()
        }),
        registration: z.object({
            maxAttempts: z.number().positive(),
            windowHours: z.number().positive()
        }),
        api: z.object({
            requestsPerMinute: z.number().positive()
        }),
        stream: z.object({
            maxRequests: z.number().positive(),
            windowMs: z.number().positive(),
            maxEntries: z.number().positive(),
            cleanupIntervalMs: z.number().positive()
        }).optional()
    }),
    session: z.object({
        maxDevices: z.number().positive(),
        passwordResetTokenMinutes: z.number().positive(),
        refreshTokenDays: z.number().positive(),
        accessTokenDays: z.number().positive()
    }),
    email: z.object({
        notification: z.object({
            debounceSeconds: z.number().positive(),
            maxDelaySeconds: z.number().positive(),
            minOfflineSeconds: z.number().positive(),
            maxRetries: z.number().positive(),
            retryBackoffMs: z.number().positive()
        })
    }),
    storage: z.object({
        timeoutMs: z.number().positive(),
        circuitBreaker: z.object({
            failureThreshold: z.number().positive(),
            recoveryTimeoutMs: z.number().positive()
        }),
        retry: z.object({
            maxAttempts: z.number().positive(),
            baseDelayMs: z.number().positive()
        })
    }),
    socket: z.object({
        authWindowMs: z.number().positive(),
        authMaxAttempts: z.number().positive(),
        pingTimeoutMs: z.number().positive(),
        pingIntervalMs: z.number().positive(),
        maxTimeoutMs: z.number().positive(),
        maxConnectionsPerIp: z.number().positive().optional(),
        connectionWindowMs: z.number().positive().optional()
    }),
    presence: z.object({
        typingIndicatorTTL: z.number().positive(),
        awayThresholdMs: z.number().positive(),
        offlineThresholdMs: z.number().positive(),
        cleanupIntervalMs: z.number().positive(),
        sessionDbCleanupIntervalMs: z.number().positive(),
        socketRateCleanupIntervalMs: z.number().positive()
    }),
    allowedMimeTypes: z.object({
        image: z.array(z.string()),
        video: z.array(z.string()),
        document: z.array(z.string())
    }),
    features: z.object({
        userRegistration: z.boolean(),
        mediaUpload: z.boolean(),
        messageDelete: z.boolean(),
        messageDeleteTimeLimit: z.number().positive()
    }),
    server: z.object({
        maxBodySize: z.number().positive(),
        requestTimeoutMs: z.number().positive(),
        shutdownTimeoutMs: z.number().positive(),
        statsLogIntervalMs: z.number().positive().optional()
    }).optional(),
    cache: z.object({
        maxUserCacheSize: z.number().positive(),
        maxTypingIndicators: z.number().positive(),
        maxActiveUploads: z.number().positive(),
        maxSocketRateLimiters: z.number().positive(),
        maxEmailQueueSize: z.number().positive(),
        maxRateLimitEntries: z.number().positive().optional(),
        rateLimitCleanupIntervalMs: z.number().positive().optional()
    }).optional(),
    subsidiaries: z.array(z.record(z.string(), z.unknown())).optional()
})

export interface AppConfig {
    brand?: {
        siteName: string
        tagline: string
        company: string
        supportEmail: string
        logoUrl?: string | undefined
        primaryColor?: string | undefined
    }
    limits: {
        message: {
            textMaxLength: number
            teamTextMaxLength: number
            perMinute: number
            perHour: number
        }
        media: {
            maxSizeImage: number
            maxSizeVideo: number
            maxSizeDocument: number
            perDay: number
        }
        upload: {
            presignedUrlTTL: number
            confirmTimeout: number
        }
    }
    rateLimit: {
        login: {
            maxAttempts: number
            windowMinutes: number
            lockoutMinutes: number
        }
        passwordReset: {
            maxAttempts: number
            windowMinutes: number
        }
        passwordChange: {
            maxAttempts: number
            windowMinutes: number
        }
        registration: {
            maxAttempts: number
            windowHours: number
        }
        api: {
            requestsPerMinute: number
        }
        stream?: {
            maxRequests: number
            windowMs: number
            maxEntries: number
            cleanupIntervalMs: number
        }
    }
    session: {
        maxDevices: number
        passwordResetTokenMinutes: number
        refreshTokenDays: number
        accessTokenDays: number
    }
    email: {
        notification: {
            debounceSeconds: number
            maxDelaySeconds: number
            minOfflineSeconds: number
            maxRetries: number
            retryBackoffMs: number
        }
    }
    storage: {
        timeoutMs: number
        circuitBreaker: {
            failureThreshold: number
            recoveryTimeoutMs: number
        }
        retry: {
            maxAttempts: number
            baseDelayMs: number
        }
    }
    socket: {
        authWindowMs: number
        authMaxAttempts: number
        pingTimeoutMs: number
        pingIntervalMs: number
        maxTimeoutMs: number
        maxConnectionsPerIp?: number
        connectionWindowMs?: number
    }
    presence: {
        typingIndicatorTTL: number
        awayThresholdMs: number
        offlineThresholdMs: number
        cleanupIntervalMs: number
        sessionDbCleanupIntervalMs: number
        socketRateCleanupIntervalMs: number
    }
    allowedMimeTypes: {
        image: string[]
        video: string[]
        document: string[]
    }
    features: {
        userRegistration: boolean
        mediaUpload: boolean
        messageDelete: boolean
        messageDeleteTimeLimit: number
    }
    server?: {
        maxBodySize: number
        requestTimeoutMs: number
        shutdownTimeoutMs: number
        statsLogIntervalMs?: number
    }
    cache?: {
        maxUserCacheSize: number
        maxTypingIndicators: number
        maxActiveUploads: number
        maxSocketRateLimiters: number
        maxEmailQueueSize: number
        maxRateLimitEntries?: number
        rateLimitCleanupIntervalMs?: number
    }
    subsidiaries?: Record<string, unknown>[]
}

let config: AppConfig | null = null
let configWriteLock: Promise<void> = Promise.resolve()

export function getConfigPath(): string {
    const __dirname = path.dirname(fileURLToPath(import.meta.url))
    return path.join(__dirname, '..', '..', 'config.json')
}

export async function atomicWriteConfig(patch: (cfg: Record<string, unknown>) => void): Promise<void> {
    configWriteLock = configWriteLock
        .catch(() => undefined)
        .then(async () => {
            const configPath = getConfigPath()
            const tempPath = `${configPath}.tmp`
            const fullConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>
            patch(fullConfig)
            await fs.promises.writeFile(tempPath, JSON.stringify(fullConfig, null, 4))
            await fs.promises.rename(tempPath, configPath)

            // Apply immediately to running memory
            const result = configSchema.safeParse(fullConfig)
            if (result.success) {
                config = result.data as AppConfig
            }
        })
    return configWriteLock
}

export function loadConfig(): AppConfig {
    if (config) return config

    const configPath = getConfigPath()
    const configFile = fs.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(configFile)

    const result = configSchema.safeParse(parsed)
    if (!result.success) {
        const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
        throw new Error(`Invalid config.json: ${issues}`)
    }

    config = result.data as AppConfig
    return config
}

export function getConfig(): AppConfig {
    if (!config) {
        return loadConfig()
    }
    return config
}

export function getBrand(): BrandConfig {
    const cfg = getConfig()
    return cfg.brand || {
        siteName: 'Customer Hub',
        tagline: 'Your direct line to our team',
        company: '',
        supportEmail: '',
        logoUrl: undefined,
        primaryColor: undefined
    }
}

export async function updateBrand(newBrand: BrandConfig): Promise<void> {
    await atomicWriteConfig((cfg) => { cfg.brand = newBrand })
}

export function normalizeMimeType(mimeType: string): string {
    return (mimeType.split(';')[0] ?? mimeType).trim()
}

export function isAllowedMimeType(
    mimeType: string,
    category: 'image' | 'video' | 'document'
): boolean {
    return getConfig().allowedMimeTypes[category].includes(normalizeMimeType(mimeType))
}

export function getMaxFileSize(
    category: 'image' | 'video' | 'document'
): number {
    const cfg = getConfig()
    const key = `maxSize${category.charAt(0).toUpperCase() + category.slice(1)}` as
        | 'maxSizeImage'
        | 'maxSizeVideo'
        | 'maxSizeDocument'
    return cfg.limits.media[key]
}

export function getMediaCategory(
    mimeType: string
): 'image' | 'video' | 'document' | null {
    const cfg = getConfig()
    const normalized = normalizeMimeType(mimeType)
    if (cfg.allowedMimeTypes.image.includes(normalized)) return 'image'
    if (cfg.allowedMimeTypes.video.includes(normalized)) return 'video'
    if (cfg.allowedMimeTypes.document.includes(normalized)) return 'document'
    return null
}
