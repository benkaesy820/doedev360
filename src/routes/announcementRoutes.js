import { Router } from 'express';
import prisma from '../config/database.js';
import { authenticate, requireApproved, requireAdmin } from '../middleware/auth.js';
import { announcementSchema } from '../utils/validators.js';

const router = Router();

// Get all announcements (for approved users)
router.get('/', authenticate, requireApproved, async (req, res, next) => {
    try {
        const { page = 1, limit = 20 } = req.query;

        const [announcements, total] = await Promise.all([
            prisma.announcement.findMany({
                skip: (page - 1) * limit,
                take: parseInt(limit),
                orderBy: { createdAt: 'desc' },
                include: {
                    creator: { select: { name: true } },
                    reads: {
                        where: { userId: req.user.id },
                        select: { readAt: true }
                    }
                }
            }),
            prisma.announcement.count()
        ]);

        // Add read status
        const result = announcements.map(a => ({
            ...a,
            isRead: a.reads.length > 0,
            reads: undefined
        }));

        res.json({
            announcements: result,
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

// Get unread count
router.get('/unread-count', authenticate, requireApproved, async (req, res, next) => {
    try {
        const readAnnouncementIds = await prisma.announcementRead.findMany({
            where: { userId: req.user.id },
            select: { announcementId: true }
        });

        const unreadCount = await prisma.announcement.count({
            where: {
                id: { notIn: readAnnouncementIds.map(r => r.announcementId) }
            }
        });

        res.json({ unreadCount });
    } catch (error) {
        next(error);
    }
});

// Create announcement (Admin only)
router.post('/', authenticate, requireAdmin, async (req, res, next) => {
    try {
        const data = announcementSchema.parse(req.body);

        const announcement = await prisma.announcement.create({
            data: {
                title: data.title,
                content: data.content,
                createdBy: req.user.id
            },
            include: {
                creator: { select: { name: true } }
            }
        });

        res.status(201).json({ announcement });
    } catch (error) {
        next(error);
    }
});

// Mark announcement as read
router.post('/:id/read', authenticate, requireApproved, async (req, res, next) => {
    try {
        const announcementId = parseInt(req.params.id);

        await prisma.announcementRead.upsert({
            where: {
                announcementId_userId: {
                    announcementId,
                    userId: req.user.id
                }
            },
            create: {
                announcementId,
                userId: req.user.id
            },
            update: {}
        });

        res.json({ message: 'Marked as read' });
    } catch (error) {
        next(error);
    }
});

export default router;
