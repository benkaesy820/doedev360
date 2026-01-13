import { z } from 'zod';

export const userRegistrationSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
  phone: z.string().min(10, 'Phone number must be at least 10 characters'),
  password: z.string().min(6, 'Password must be at least 6 characters')
});

export const userLoginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required')
});

export const userStatusUpdateSchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED']),
  reason: z.string().optional()
});

export const messageSchema = z.object({
  messageText: z.string().min(1, 'Message cannot be empty').optional(),
  mediaUrl: z.string().url('Invalid media URL').optional(),
  conversationId: z.number().int().positive()
}).refine(data => data.messageText || data.mediaUrl, {
  message: 'Either message text or media URL must be provided'
});

export const conversationCreateSchema = z.object({
  userId: z.number().int().positive()
});
