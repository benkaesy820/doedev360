import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

const databaseUrl = process.env.TURSO_DATABASE_URL ?? 'file:./local.db'
const authToken = process.env.TURSO_AUTH_TOKEN

// For local SQLite, don't use authToken
const isLocal = databaseUrl.startsWith('file:')

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'turso',
  dbCredentials: {
    url: databaseUrl,
    ...(isLocal ? {} : { authToken: authToken ?? '' })
  },
  tablesFilter: ['!turso_*']
})
