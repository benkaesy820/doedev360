import { z } from 'zod';

export const registerSchema = z.object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email('Invalid email address'),
    phone: z.string().min(10, 'Phone must be at least 10 characters'),
    password: z.string().min(8, 'Password must be at least 8 characters')
});

export const loginSchema = z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(1, 'Password is required')
});

export const messageSchema = z.object({
    messageText: z.string().min(1, 'Message cannot be empty').optional(),
    mediaUrl: z.string().url().optional(),
    mediaType: z.string().optional()
}).refine(data => data.messageText || data.mediaUrl, {
    message: 'Either message text or media is required'
});

export const announcementSchema = z.object({
    title: z.string().optional(),
    content: z.string().min(1, 'Content is required'),
    userIds: z.array(z.number()).optional() // If empty, send to all
});

export const reportSchema = z.object({
    orderId: z.string().optional(),
    paystackReference: z.string().optional(),
    momoTransactionId: z.string().optional(),
    description: z.string().min(10, 'Description must be at least 10 characters')
}).refine(data => data.orderId || data.paystackReference || data.momoTransactionId, {
    message: 'At least one transaction reference is required'
});

export const updateUserStatusSchema = z.object({
    status: z.enum(['APPROVED', 'REJECTED', 'SUSPENDED']),
    reason: z.string().optional()
});

export const updateReportStatusSchema = z.object({
    status: z.enum(['WORKING', 'COMPLETED', 'REJECTED']),
    adminNotes: z.string().optional()
});
