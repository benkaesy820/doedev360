import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger.js';
import config from './index.js';

// Create Prisma client for PostgreSQL
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: config.databaseUrl,
    },
  },
});

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
    logger.info('Database disconnected');
}

export default prisma;
