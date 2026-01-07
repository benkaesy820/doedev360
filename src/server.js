import { createServer } from 'http';
import { Server } from 'socket.io';

import app from './app.js';
import config from './config/index.js';
import logger from './utils/logger.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { setupSocketHandlers } from './sockets/socketHandler.js';

const httpServer = createServer(app);

// Socket.io setup
const io = new Server(httpServer, {
    cors: {
        origin: config.frontendUrl,
        credentials: true
    }
});

// Setup socket handlers
setupSocketHandlers(io);

// Graceful shutdown
async function shutdown(signal) {
    logger.info(`${signal} received. Shutting down gracefully...`);

    httpServer.close(async () => {
        logger.info('HTTP server closed');
        await disconnectDatabase();
        process.exit(0);
    });

    // Force close after 10s
    setTimeout(() => {
        logger.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start server
async function start() {
    await connectDatabase();

    httpServer.listen(config.port, () => {
        logger.info(`Server running on port ${config.port}`);
        logger.info(`Environment: ${config.nodeEnv}`);
    });
}

start().catch((error) => {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
});

export { io };
