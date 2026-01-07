import logger from '../utils/logger.js';
import { verifyAccessToken } from '../utils/jwt.js';
import prisma from '../config/database.js';

// Store socket connections
const userSockets = new Map(); // userId -> Set of socket ids
const socketUsers = new Map(); // socket id -> userId

export function setupSocketHandlers(io) {
    io.on('connection', (socket) => {
        logger.info({ socketId: socket.id }, 'Client connected');

        // Authentication
        socket.on('authenticate', async (token) => {
            try {
                const payload = await verifyAccessToken(token);
                const user = await prisma.user.findUnique({
                    where: { id: payload.userId },
                    select: { id: true, role: true, status: true }
                });

                if (!user || user.status === 'SUSPENDED') {
                    socket.emit('auth_error', { error: 'Authentication failed' });
                    return;
                }

                // Store connection
                socketUsers.set(socket.id, user.id);
                if (!userSockets.has(user.id)) {
                    userSockets.set(user.id, new Set());
                }
                userSockets.get(user.id).add(socket.id);

                // Join user room
                socket.join(`user:${user.id}`);

                // Join admin room if admin
                if (user.role === 'ADMIN') {
                    socket.join('admin');
                }

                // Join approved users room for announcements
                if (user.status === 'APPROVED') {
                    socket.join('approved_users');
                }

                socket.emit('authenticated', { userId: user.id });
                logger.info({ userId: user.id, socketId: socket.id }, 'User authenticated');
            } catch (error) {
                logger.error({ error }, 'Socket authentication failed');
                socket.emit('auth_error', { error: 'Invalid token' });
            }
        });

        // Typing indicators
        socket.on('typing_start', ({ conversationId }) => {
            const userId = socketUsers.get(socket.id);
            if (userId) {
                socket.to(`conversation:${conversationId}`).emit('typing_start', { userId, conversationId });
            }
        });

        socket.on('typing_stop', ({ conversationId }) => {
            const userId = socketUsers.get(socket.id);
            if (userId) {
                socket.to(`conversation:${conversationId}`).emit('typing_stop', { userId, conversationId });
            }
        });

        // Join conversation room
        socket.on('join_conversation', ({ conversationId }) => {
            socket.join(`conversation:${conversationId}`);
        });

        socket.on('leave_conversation', ({ conversationId }) => {
            socket.leave(`conversation:${conversationId}`);
        });

        // Disconnect
        socket.on('disconnect', () => {
            const userId = socketUsers.get(socket.id);
            if (userId && userSockets.has(userId)) {
                userSockets.get(userId).delete(socket.id);
                if (userSockets.get(userId).size === 0) {
                    userSockets.delete(userId);
                }
            }
            socketUsers.delete(socket.id);
            logger.info({ socketId: socket.id }, 'Client disconnected');
        });
    });

    return io;
}

// Helper functions to emit events
export function emitToUser(io, userId, event, data) {
    io.to(`user:${userId}`).emit(event, data);
}

export function emitToAdmin(io, event, data) {
    io.to('admin').emit(event, data);
}

export function emitToApprovedUsers(io, event, data) {
    io.to('approved_users').emit(event, data);
}

export function emitToConversation(io, conversationId, event, data) {
    io.to(`conversation:${conversationId}`).emit(event, data);
}
