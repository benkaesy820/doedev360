import 'dotenv/config'
import { ulid } from 'ulid'
import { initDb, closeDb, getDb, schema } from '../src/db/index.js'

async function main() {
    console.log('🔄 Initializing DB...')
    const db = await initDb()

    const title = `Sync Test ${new Date().toISOString()}`
    const id = ulid()

    const auth = process.env.TURSO_AUTH_TOKEN
    const syncUrl = process.env.TURSO_SYNC_URL

    const admin = await db.query.users.findFirst({ columns: { id: true } })
    const testUserId = admin ? admin.id : id

    if (!admin) {
        await db.insert(schema.users).values({
            id: testUserId,
            name: 'Sync Tester',
            email: 'sync@test.com',
            passwordHash: 'dummy',
            role: 'SUPER_ADMIN',
            status: 'APPROVED'
        })
    }

    console.log(`\n✍️  Targetting local db...`)
    await db.insert(schema.announcements).values({
        id,
        title,
        content: 'This announcement is to prove the embedded replica syncs correctly.',
        isActive: true,
        createdBy: testUserId,

    })
    console.log(`✅ Inserted natively into local replica! Announcement ID: ${id}`)

    console.log(`\n⏳ Waiting 6 seconds for background @tursodatabase/sync interval...`)
    await new Promise(resolve => setTimeout(resolve, 6000))

    console.log(`\n☁️  Checking if record synced to Turso cloud...`)

    // Direct HTTP ping bypassing our local embedded client
    const res = await fetch(`${syncUrl}/v2/pipeline`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${auth}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            requests: [
                { type: 'execute', stmt: { sql: `SELECT title FROM announcements WHERE id = '${id}'`, args: [] } },
                { type: 'close' }
            ]
        })
    })

    const result = await res.json()
    const rows = result.results?.[0]?.response?.result?.rows

    if (rows && rows.length > 0) {
        console.log(`🎉 SUCCESS! The row was found in the remote cloud DB: ${JSON.stringify(rows[0])}`)
    } else {
        console.log(`❌ FAILURE. The row did NOT sync to the remote cloud. Response: ${JSON.stringify(result)}`)
    }

    await closeDb()
    process.exit(0)
}

main().catch(console.error)
