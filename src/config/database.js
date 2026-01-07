import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import logger from '../utils/logger.js';
import config from './index.js';

// Create PostgreSQL connection pool
const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseUrl?.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined
});

// Create Prisma adapter
const adapter = new PrismaPg(pool);

// Create Prisma client with adapter
const prisma = new PrismaClient({ adapter });

// Test connection
export async function connectDatabase() {
    try {
        await prisma.$connect();
        logger.info('Database connected successfully');
    } catch (error) {
        logger.error({ error }, 'Failed to connect to database');
        process.exit(1);
    }
}

export async function disconnectDatabase() {
    await prisma.$disconnect();
    await pool.end();
    logger.info('Database disconnected');
}

export default prisma;
