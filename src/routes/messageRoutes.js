import { Router } from 'express';
import prisma from '../config/database.js';
import { authenticate, requireApproved, requireAdmin } from '../middleware/auth.js';
import { messageSchema } from '../utils/validators.js';
import { emitNewMessage } from '../sockets/socketHandler.js';

const router = Router();

// Get user's conversation (creates one if doesn't exist)
router.get('/my-conversation', authenticate, requireApproved, async (req, res, next) => {
    try {
        let conversation = await prisma.conversation.findFirst({
            where: { userId: req.user.id },
            include: {
                messages: {
                    orderBy: { createdAt: 'desc' },
                    take: 50
                }
            }
        });

        if (!conversation) {
            conversation = await prisma.conversation.create({
                data: { userId: req.user.id },
                include: { messages: true }
            });
        }

        res.json({ conversation });
    } catch (error) {
        next(error);
    }
});

// Get all conversations (Admin only)
router.get('/', authenticate, requireAdmin, async (req, res, next) => {
    try {
        const { status = 'ACTIVE', unreadOnly } = req.query;

        const conversations = await prisma.conversation.findMany({
            where: {
                status,
                ...(unreadOnly === 'true' && {
                    messages: {
                        some: {
                            isRead: false,
                            senderType: 'USER'
                        }
                    }
                })
            },
            include: {
                user: {
                    select: { id: true, name: true, email: true }
                },
                messages: {
                    orderBy: { createdAt: 'desc' },
                    take: 1
                },
                _count: {
                    select: {
                        messages: {
                            where: { isRead: false, senderType: 'USER' }
                        }
                    }
                }
            },
            orderBy: { lastMessageAt: 'desc' }
        });

        res.json({ conversations });
    } catch (error) {
        next(error);
    }
});

// Get conversation messages
router.get('/:id/messages', authenticate, async (req, res, next) => {
    try {
        const conversationId = parseInt(req.params.id);
        const { before, limit = 50 } = req.query;

        // Verify access
        const conversation = await prisma.conversation.findUnique({
            where: { id: conversationId }
        });

        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        // Users can only see their own conversation
        if (req.user.role !== 'ADMIN' && conversation.userId !== req.user.id) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const messages = await prisma.message.findMany({
            where: {
                conversationId,
                ...(before && { createdAt: { lt: new Date(before) } })
            },
            orderBy: { createdAt: 'desc' },
            take: parseInt(limit),
            include: {
                sender: {
                    select: { id: true, name: true, role: true }
                }
            }
        });

        res.json({ messages: messages.reverse() });
    } catch (error) {
        next(error);
    }
});

// Send message
router.post('/:id/messages', authenticate, requireApproved, async (req, res, next) => {
    try {
        const data = messageSchema.parse(req.body);
        const conversationId = parseInt(req.params.id);

        // Verify access
        const conversation = await prisma.conversation.findUnique({
            where: { id: conversationId }
        });

        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        // Users can only send to their own conversation
        if (req.user.role !== 'ADMIN' && conversation.userId !== req.user.id) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Check media permission
        if (data.mediaUrl && req.user.role !== 'ADMIN' && !req.user.mediaPermission) {
            return res.status(403).json({ error: 'Media permission not granted' });
        }

        const message = await prisma.message.create({
            data: {
                conversationId,
                senderId: req.user.id,
                senderType: req.user.role === 'ADMIN' ? 'ADMIN' : 'USER',
                messageText: data.messageText,
                mediaUrl: data.mediaUrl,
                mediaType: data.mediaType
            },
            include: {
                sender: {
                    select: { id: true, name: true, role: true }
                }
            }
        });

        // Update conversation last message time
        await prisma.conversation.update({
            where: { id: conversationId },
            data: { lastMessageAt: new Date() }
        });

        // Emit real-time message to conversation participants
        const io = req.app.get('io');
        if (io) {
            emitNewMessage(io, conversationId, message);
        }

        res.status(201).json({ message });
    } catch (error) {
        next(error);
    }
});

// Mark messages as read
router.patch('/:id/read', authenticate, async (req, res, next) => {
    try {
        const conversationId = parseInt(req.params.id);

        // Mark messages from other party as read
        const senderType = req.user.role === 'ADMIN' ? 'USER' : 'ADMIN';

        await prisma.message.updateMany({
            where: {
                conversationId,
                senderType,
                isRead: false
            },
            data: { isRead: true }
        });

        res.json({ message: 'Messages marked as read' });
    } catch (error) {
        next(error);
    }
});

export default router;
