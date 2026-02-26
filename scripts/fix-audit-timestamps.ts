/**
 * One-shot script: fix audit_logs rows where created_at was stored as
 * milliseconds instead of seconds (values > 9999999999 = beyond year 2286).
 * Run: node --import tsx scripts/fix-audit-timestamps.ts
 */
import { createClient } from '@libsql/client'
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env' })
dotenv.config({ path: '.env.local', override: true })

const url = process.env.TURSO_DATABASE_URL
if (!url) {
    console.error('TURSO_DATABASE_URL not set')
    process.exit(1)
}

const client = createClient({
    url,
    ...(process.env.TURSO_AUTH_TOKEN ? { authToken: process.env.TURSO_AUTH_TOKEN } : {}),
})

// Any created_at > 9999999999 (year ~2286 in seconds) is a millisecond timestamp
const THRESHOLD = 9_999_999_999

const count = await client.execute(
    `SELECT COUNT(*) as c FROM audit_logs WHERE created_at > ${THRESHOLD}`
)
const badCount = Number((count.rows[0] as unknown as { c: number }).c)
console.log(`Found ${badCount} rows with bad timestamps`)

if (badCount === 0) {
    console.log('Nothing to fix.')
    await client.close()
    process.exit(0)
}

// Divide millisecond values by 1000 to get correct Unix seconds
const result = await client.execute(
    `UPDATE audit_logs SET created_at = CAST(created_at / 1000 AS INTEGER) WHERE created_at > ${THRESHOLD}`
)
console.log(`✅ Fixed ${result.rowsAffected} rows`)

// Verify
const verify = await client.execute(
    `SELECT COUNT(*) as c FROM audit_logs WHERE created_at > ${THRESHOLD}`
)
const remaining = Number((verify.rows[0] as unknown as { c: number }).c)
console.log(`Remaining bad rows: ${remaining}`)

await client.close()
