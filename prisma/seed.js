import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import argon2 from 'argon2';

// Create PostgreSQL connection pool
const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined
});

// Create Prisma adapter and client
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
    console.log('Seeding database...');

    // Create admin user
    const adminPassword = await argon2.hash('admin123');
    const admin = await prisma.user.upsert({
        where: { email: 'admin@evmessages.com' },
        update: {},
        create: {
            name: 'Admin User',
            email: 'admin@evmessages.com',
            phone: '+1234567890',
            passwordHash: adminPassword,
            role: 'ADMIN',
            status: 'APPROVED'
        }
    });
    console.log('Created admin user:', admin.email);

    // Create test user
    const userPassword = await argon2.hash('user123');
    const user = await prisma.user.upsert({
        where: { email: 'user@example.com' },
        update: {},
        create: {
            name: 'Test User',
            email: 'user@example.com',
            phone: '+0987654321',
            passwordHash: userPassword,
            role: 'USER',
            status: 'APPROVED'
        }
    });
    console.log('Created test user:', user.email);

    console.log('Seeding complete!');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
        await pool.end();
    });
