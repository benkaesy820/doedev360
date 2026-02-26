import { drizzle, LibSQLDatabase } from 'drizzle-orm/libsql'
import { createClient, type Client } from '@libsql/client'
import { and, isNull, lt, inArray, isNotNull, or } from 'drizzle-orm'
import { env } from '../lib/env.js'
import { logger } from '../lib/logger.js'
import { getConfig } from '../lib/config.js'
import { CircuitBreaker } from '../lib/circuitBreaker.js'
import { retryWithBackoff } from '../lib/utils.js'
import { emitToAdmins } from '../socket/index.js'
import * as schema from './schema.js'
import { sessions, refreshTokens, passwordResetTokens } from './schema.js'

// ============================================================================
// PRAGMA BOOT SEQUENCE
// Applied once per process on the raw libsql client before handing it to Drizzle.
// These are connection-level settings — not schema migrations.
// ============================================================================
// Pragmas that require a local file — must be skipped for remote HTTP connections
const LOCAL_ONLY_PRAGMAS = new Set([
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA mmap_size = 134217728',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA cache_size = -32000',
  'PRAGMA temp_store = MEMORY',
])

const BOOT_PRAGMAS = [
  // WAL mode: concurrent readers + single writer (local only)
  `PRAGMA journal_mode = WAL`,
  // Biggest write speedup available: skip full fsync after every write (safe with WAL)
  `PRAGMA synchronous = NORMAL`,
  // libsql does NOT enable FK enforcement by default — critical for cascade correctness
  `PRAGMA foreign_keys = ON`,
  // 32 MB page cache in RAM — hot rows never touch disk
  `PRAGMA cache_size = -32000`,
  // 128 MB memory-mapped IO — zero-copy OS-level reads for sequential scans (local only)
  `PRAGMA mmap_size = 134217728`,
  // Sorts / group-by spill stays in RAM, never hits disk temp file
  `PRAGMA temp_store = MEMORY`,
  // Wait up to 5 s on WAL lock instead of immediate SQLITE_BUSY — prevents retry storms
  `PRAGMA busy_timeout = 5000`,
] as const

// Feed ANALYZE stats to the query planner without a full table scan
const BOOT_OPTIMIZE = `PRAGMA optimize`

let client: Client | null = null
let db: LibSQLDatabase<typeof schema> | null = null

const DEFAULT_DB_TIMEOUT_MS = 8000

function withDbTimeout<T>(promise: Promise<T>, timeoutMs: number = getConfig().server?.requestTimeoutMs ?? DEFAULT_DB_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Database operation timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    promise
      .then((result) => {
        clearTimeout(timeoutId)
        resolve(result)
      })
      .catch((error) => {
        clearTimeout(timeoutId)
        reject(error)
      })
  })
}

const dbCircuitBreaker = new CircuitBreaker({
  name: 'Database',
  failureThreshold: getConfig().storage.circuitBreaker.failureThreshold,
  recoveryTimeoutMs: getConfig().storage.circuitBreaker.recoveryTimeoutMs,
  onStateChange: (state, failures) => {
    if (state === 'OPEN') {
      try {
        emitToAdmins('database:circuit_opened', {
          state,
          failures,
          timestamp: Date.now()
        })
      } catch (error) {
        logger.debug({
          error: error instanceof Error ? error.message : 'Unknown error'
        }, 'Unable to emit database circuit event')
      }
    }
  }
})

function wrapDbClientWithResilience(baseClient: Client): Client {
  return new Proxy(baseClient, {
    get(target, prop, receiver) {
      if (prop === 'execute') {
        return async (...args: unknown[]) => {
          const execute = (target as any).execute.bind(target) as (...params: unknown[]) => Promise<unknown>
          return withDbCircuitBreaker(() => withDbTimeout(execute(...args)))
        }
      }

      if (prop === 'batch') {
        return async (...args: unknown[]) => {
          const batch = (target as any).batch.bind(target) as (...params: unknown[]) => Promise<unknown>
          return withDbCircuitBreaker(() => withDbTimeout(batch(...args)))
        }
      }

      const value = Reflect.get(target, prop, receiver)
      if (typeof value === 'function') {
        return value.bind(target)
      }
      return value
    }
  }) as Client
}

// Removed appliedBootPragmas since @tursodatabase/sync manages its own underlying SQLite pragmas (WAL/synchronous)
// and running them concurrently/randomly breaks the client synchronization process.

async function createDbClient(): Promise<any> {
  if (client) return client

  const url = env.databaseUrl
  const syncUrl = env.tursoSyncUrl
  const authToken = env.authToken

  let rawClient: any

  logger.info({ url, syncUrl, hasAuth: !!authToken }, 'Initializing database connection...')

  // EMBEDDED REPLICA MODE — @libsql/client handles local file + cloud sync natively.
  // This is the officially supported way to do embedded replicas with Turso + Drizzle.
  // The client exposes the full execute/batch/close interface Drizzle requires.
  if (url.startsWith('file:') && syncUrl && authToken) {
    rawClient = createClient({
      url,
      syncUrl,
      authToken,
    })

    // Perform an initial sync so the local replica has the schema and data
    // before any service (e.g. media cleanup) queries it.
    try {
      await rawClient.sync()
      logger.info('Database: initial sync complete')
    } catch (err) {
      logger.warn({ err }, 'Database: initial sync failed — local replica may be stale')
    }

    logger.info('Database: Turso embedded replica mode (@libsql/client)')
  }
  // LOCAL FILE MODE: plain local SQLite (no cloud sync)
  else if (url.startsWith('file:')) {
    rawClient = createClient({ url })
    try { await rawClient.execute('PRAGMA journal_mode = WAL') } catch { }
    logger.info({ url: url.substring(0, 20) + '...' }, 'Database: local file mode')
  }
  // REMOTE TURSO: direct cloud HTTP connection
  else {
    if (!authToken) {
      throw new Error('TURSO_AUTH_TOKEN is required for remote database')
    }
    rawClient = createClient({ url, authToken })
    logger.info({ url: url.substring(0, 20) + '...' }, 'Database: remote Turso mode')
  }

  client = wrapDbClientWithResilience(rawClient)
  return client
}

export async function initDb(): Promise<LibSQLDatabase<typeof schema>> {
  if (db) return db

  const rawClientRef = await createDbClient()

  // Drizzle expects a `@libsql/client` (or heavily compatible duck-type interface)
  db = drizzle(rawClientRef as Client, { schema, logger: env.isDev })
  dbReady = Promise.resolve()
  return db
}

export function getDb(): LibSQLDatabase<typeof schema> {
  if (!db) throw new Error('Database not initialized. Call initDb() first at startup.')
  return db
}

// Deferred init — awaited by startServer() via initDb()
// DO NOT call initDb() at module level; it races with config/PRAGMA setup
export let dbReady: Promise<void> = Promise.resolve()

// Backwards-compatible synchronous accessor (safe after initDb() has resolved)
const database = (() => {
  // Return a proxy that defers until init resolves
  return new Proxy({} as LibSQLDatabase<typeof schema>, {
    get(_target, prop, receiver) {
      if (!db) throw new Error('db accessed before initDb() resolved')
      const value = Reflect.get(db, prop, receiver)
      return typeof value === 'function' ? value.bind(db) : value
    }
  })
})()
export { database as db }

export { schema }

export async function checkDbHealth(): Promise<{
  status: 'healthy' | 'degraded' | 'unhealthy'
  latency?: number
  error?: string
}> {
  try {
    const start = Date.now()
    await retryWithBackoff(async () => {
      // In @tursodatabase/sync embedded mode, execute isn't strictly recreating the client,
      // it's just pinging the existing client if we already have it.
      const dbClient = client || await createDbClient()
      await dbClient.execute('SELECT 1')
    }, 2, 250)

    const latency = Date.now() - start

    if (latency > 1000) {
      return { status: 'degraded', latency }
    }

    return { status: 'healthy', latency }
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function cleanupExpiredSessions(): Promise<{ cleaned: number }> {
  const now = new Date()
  const database = getDb()

  try {
    let totalCleaned = 0
    while (true) {
      const expiredSessions = await database.query.sessions.findMany({
        where: and(
          isNull(sessions.revokedAt),
          lt(sessions.expiresAt, now)
        ),
        columns: { id: true },
        limit: 500
      })

      if (expiredSessions.length === 0) break

      const sessionIds = expiredSessions.map(s => s.id)

      await database.transaction(async (tx) => {
        await tx.update(refreshTokens)
          .set({ revokedAt: now })
          .where(and(
            isNull(refreshTokens.revokedAt),
            inArray(refreshTokens.sessionId, sessionIds)
          ))

        await tx.update(sessions)
          .set({ revokedAt: now })
          .where(inArray(sessions.id, sessionIds))
      })

      totalCleaned += sessionIds.length
      if (expiredSessions.length < 500) break
    }

    const cleaned = totalCleaned
    if (cleaned > 0) {
      logger.info({ cleaned }, 'Expired sessions cleaned (batch)')
    }

    const deletedTokens = await database.delete(passwordResetTokens)
      .where(or(
        isNotNull(passwordResetTokens.usedAt),
        lt(passwordResetTokens.expiresAt, now)
      ))

    return { cleaned }
  } catch (error) {
    logger.error({ error }, 'Session cleanup failed')
    return { cleaned: 0 }
  }
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close()
    client = null
    db = null
    logger.info('Database connection closed')
  }
}

export { sessions, refreshTokens }

export function getDbCircuitBreakerState(): { state: string; failures: number } {
  return dbCircuitBreaker.getState()
}

export async function withDbCircuitBreaker<T>(operation: () => Promise<T>): Promise<T> {
  return dbCircuitBreaker.execute(operation)
}
