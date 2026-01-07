import { Router } from 'express';
import prisma from '../config/database.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { updateUserStatusSchema } from '../utils/validators.js';

const router = Router();

// Get all users (Admin only)
router.get('/', authenticate, requireAdmin, async (req, res, next) => {
    try {
        const { status, search, page = 1, limit = 20 } = req.query;

        const where = {};
        if (status) where.status = status;
        if (search) {
            where.OR = [
                { name: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
                { phone: { contains: search } }
            ];
        }

        const [users, total] = await Promise.all([
            prisma.user.findMany({
                where,
                select: {
                    id: true,
                    name: true,
                    email: true,
                    phone: true,
                    status: true,
                    role: true,
                    mediaPermission: true,
                    rejectionCount: true,
                    createdAt: true,
                    lastLogin: true
                },
                skip: (page - 1) * limit,
                take: parseInt(limit),
                orderBy: { createdAt: 'desc' }
            }),
            prisma.user.count({ where })
        ]);

        res.json({
            users,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        next(error);
    }
});

// Get user by ID (Admin only)
router.get('/:id', authenticate, requireAdmin, async (req, res, next) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: parseInt(req.params.id) },
            select: {
                id: true,
                name: true,
                email: true,
                phone: true,
                status: true,
                role: true,
                mediaPermission: true,
                rejectionCount: true,
                createdAt: true,
                lastLogin: true,
                statusHistory: {
                    orderBy: { createdAt: 'desc' },
                    take: 10,
                    include: {
                        changer: { select: { name: true } }
                    }
                }
            }
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({ user });
    } catch (error) {
        next(error);
    }
});

// Update user status (Admin only)
router.patch('/:id/status', authenticate, requireAdmin, async (req, res, next) => {
    try {
        const data = updateUserStatusSchema.parse(req.body);
        const userId = parseInt(req.params.id);

        const user = await prisma.user.findUnique({
            where: { id: userId }
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Update user and create history
        const [updatedUser] = await prisma.$transaction([
            prisma.user.update({
                where: { id: userId },
                data: {
                    status: data.status,
                    rejectionCount: data.status === 'REJECTED' ? { increment: 1 } : undefined
                },
                select: {
                    id: true,
                    name: true,
                    email: true,
                    status: true
                }
            }),
            prisma.userStatusHistory.create({
                data: {
                    userId,
                    oldStatus: user.status,
                    newStatus: data.status,
                    changedBy: req.user.id,
                    reason: data.reason
                }
            })
        ]);

        res.json({
            message: `User ${data.status.toLowerCase()} successfully`,
            user: updatedUser
        });
    } catch (error) {
        next(error);
    }
});

// Toggle media permission (Admin only)
router.patch('/:id/media-permission', authenticate, requireAdmin, async (req, res, next) => {
    try {
        const userId = parseInt(req.params.id);
        const { granted } = req.body;

        const user = await prisma.user.update({
            where: { id: userId },
            data: { mediaPermission: Boolean(granted) },
            select: {
                id: true,
                name: true,
                mediaPermission: true
            }
        });

        res.json({
            message: `Media permission ${granted ? 'granted' : 'revoked'}`,
            user
        });
    } catch (error) {
        next(error);
    }
});

export default router;
