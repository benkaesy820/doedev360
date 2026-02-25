import { z } from 'zod'
import { isValidId } from './utils.js'

const ulid26 = (field: z.ZodString) =>
  field.refine((v) => isValidId(v), { message: 'Invalid ID format' })

const optionalUlid = z.string().min(1).max(26).refine((v) => isValidId(v), { message: 'Invalid ID format' }).optional()

export const socketMessageSchema = z.object({
  conversationId: ulid26(z.string().min(1).max(26)),
  type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']),
  content: z.string().max(100000).optional(),
  mediaId: optionalUlid,
  tempId: z.string().max(100).optional(),
  replyToId: optionalUlid,
  announcementId: optionalUlid,
}).refine(
  d => d.type === 'TEXT' ? !!d.content?.trim() : !!d.mediaId,
  { message: 'TEXT requires content; media types require mediaId' }
)

export const socketInternalMessageSchema = z.object({
  type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']).default('TEXT'),
  content: z.string().max(100000).optional(),
  mediaId: optionalUlid,
  tempId: z.string().max(100).optional(),
  replyToId: optionalUlid,
}).refine(
  d => d.type === 'TEXT' ? !!d.content?.trim() : !!d.mediaId,
  { message: 'TEXT requires content; media types require mediaId' }
)

export const socketPresenceSchema = z.object({
  status: z.enum(['online', 'away'])
})

export type SocketMessageInput = z.infer<typeof socketMessageSchema>
export type SocketPresenceInput = z.infer<typeof socketPresenceSchema>
