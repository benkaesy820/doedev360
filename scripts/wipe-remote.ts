import 'dotenv/config'
import { createClient } from "@libsql/client"

async function wipeRemote() {
    const url = process.env.TURSO_SYNC_URL || process.env.TURSO_DATABASE_URL
    const authToken = process.env.TURSO_AUTH_TOKEN

    if (!url || url.startsWith('file:')) {
        throw new Error(`Cannot wipe remote. Invalid URL: ${url}`)
    }

    console.log(`📡 Connecting to remote DB: ${url}`)
    const client = createClient({ url, ...(authToken ? { authToken } : {}) })

    const result = await client.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")

    if (result.rows.length === 0) {
        console.log("✅ No tables found in remote DB. Already clean.")
        return
    }

    console.log(`🗑️ Found ${result.rows.length} tables to drop...`)

    await client.execute("PRAGMA foreign_keys=OFF")

    for (const row of result.rows) {
        const table = row.name as string
        console.log(`   Dropping table: ${table}`)
        await client.execute(`DROP TABLE IF EXISTS "${table}"`)
    }
    console.log('✨ Remote database wipe complete.\n')
}

wipeRemote().catch((e) => {
    console.error("❌ Wipe failed:", e)
    process.exit(1)
})
