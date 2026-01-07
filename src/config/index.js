import dotenv from 'dotenv';
dotenv.config();

export const config = {
    // Server
    nodeEnv: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '5000', 10),

    // Database
    databaseUrl: process.env.DATABASE_URL,

    // Redis
    redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined
    },

    // JWT
    jwt: {
        secret: process.env.JWT_SECRET || 'default-secret-change-me',
        expiresIn: process.env.JWT_EXPIRES_IN || '1h',
        refreshSecret: process.env.REFRESH_TOKEN_SECRET || 'default-refresh-secret',
        refreshExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '7d'
    },

    // File Uploads
    uploads: {
        dir: process.env.UPLOAD_DIR || './uploads',
        maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '10485760', 10) // 10MB
    },

    // Frontend
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000'
};

export default config;
