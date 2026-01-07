import { Router } from 'express';
import prisma from '../config/database.js';
import { authenticate, requireApproved, requireAdmin } from '../middleware/auth.js';
import { reportSchema, updateReportStatusSchema } from '../utils/validators.js';

const router = Router();

// Get user's reports
router.get('/my-reports', authenticate, requireApproved, async (req, res, next) => {
    try {
        const reports = await prisma.businessReport.findMany({
            where: { userId: req.user.id },
            orderBy: { createdAt: 'desc' }
        });

        res.json({ reports });
    } catch (error) {
        next(error);
    }
});

// Submit a report
router.post('/', authenticate, requireApproved, async (req, res, next) => {
    try {
        const data = reportSchema.parse(req.body);

        const report = await prisma.businessReport.create({
            data: {
                userId: req.user.id,
                orderId: data.orderId,
                paystackReference: data.paystackReference,
                momoTransactionId: data.momoTransactionId,
                description: data.description
            }
        });

        res.status(201).json({
            message: 'Report submitted successfully',
            report
        });
    } catch (error) {
        next(error);
    }
});

// Get all reports (Admin only)
router.get('/', authenticate, requireAdmin, async (req, res, next) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;

        const where = status ? { status } : {};

        const [reports, total] = await Promise.all([
            prisma.businessReport.findMany({
                where,
                skip: (page - 1) * limit,
                take: parseInt(limit),
                orderBy: { createdAt: 'desc' },
                include: {
                    user: {
                        select: { id: true, name: true, email: true }
                    }
                }
            }),
            prisma.businessReport.count({ where })
        ]);

        res.json({
            reports,
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

// Update report status (Admin only)
router.patch('/:id/status', authenticate, requireAdmin, async (req, res, next) => {
    try {
        const data = updateReportStatusSchema.parse(req.body);
        const reportId = parseInt(req.params.id);

        const report = await prisma.businessReport.update({
            where: { id: reportId },
            data: {
                status: data.status,
                adminNotes: data.adminNotes
            }
        });

        res.json({
            message: 'Report status updated',
            report
        });
    } catch (error) {
        next(error);
    }
});

export default router;
