/**
 * seed-admin.ts
 * Creates a Super Admin user in the database.
 * Run: npx tsx scripts/seed-admin.ts
 */
import 'dotenv/config'
import { hash } from '@node-rs/argon2'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import * as schema from '../src/db/schema.js'

// ── Config ——————————————————————————————————————————————————
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@wighaven.com'
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'Admin1234!'
const ADMIN_NAME = process.env.SEED_ADMIN_NAME ?? 'Super Admin'

const DATABASE_URL = process.env.TURSO_DATABASE_URL
const AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN

if (!DATABASE_URL) {
    console.error('❌  TURSO_DATABASE_URL is not set')
    process.exit(1)
}

// ── DB ——————————————————————————————————————————————————————
const client = createClient({
    url: DATABASE_URL,
    ...(AUTH_TOKEN ? { authToken: AUTH_TOKEN } : {})
})
const db = drizzle(client, { schema })

// ── Seed ————————————————————————————————————————————————————
async function seed() {
    console.log(`\n🌱  Seeding Super Admin...`)
    console.log(`   Email   : ${ADMIN_EMAIL}`)
    console.log(`   Name    : ${ADMIN_NAME}`)
    console.log(`   DB      : ${DATABASE_URL?.substring(0, 30)}...\n`)

    // Check if already exists
    const existing = await db
        .select({ id: schema.users.id, role: schema.users.role })
        .from(schema.users)
        .where(eq(schema.users.email, ADMIN_EMAIL))
        .limit(1)

    if (existing.length > 0) {
        console.log(`⚠️   User already exists (role: ${existing[0]?.role}). Skipping.`)
        console.log(`    If you want to reset, delete the user first.`)
        client.close()
        return
    }

    const passwordHash = await hash(ADMIN_PASSWORD)

    await db.insert(schema.users).values({
        id: ulid(),
        email: ADMIN_EMAIL,
        passwordHash,
        name: ADMIN_NAME,
        role: 'SUPER_ADMIN',
        status: 'APPROVED',
        mediaPermission: true,
        emailNotifyOnMessage: true,
    })

    console.log(`✅  Super Admin created!`)
    console.log(`\n   Login at your frontend with:`)
    console.log(`   Email   : ${ADMIN_EMAIL}`)
    console.log(`   Password: ${ADMIN_PASSWORD}`)
    console.log(`\n   ⚠️  Change your password after first login!\n`)

    client.close()
}

seed().catch((err) => {
    console.error('❌  Seed failed:', err)
    client.close()
    process.exit(1)
})
