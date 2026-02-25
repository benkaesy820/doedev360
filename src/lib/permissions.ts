import type { User, Message, Conversation } from '../db/schema.js'
import { getConfig } from '../lib/config.js'

export function canUploadMedia(user: Pick<User, 'status' | 'role'> & { mediaPermission?: boolean }): boolean {
    if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') return true
    return user.status === 'APPROVED' && (user.mediaPermission ?? false) === true
}

export function canDeleteMessage(
    user: Pick<User, 'id' | 'role'>,
    message: Pick<Message, 'senderId' | 'createdAt'>,
    scope: 'me' | 'all' = 'all'
): boolean {
    // "Delete for Me" is always allowed for participants
    // (Route-level checks ensure the user is actually part of the conversation)
    if (scope === 'me') {
        return true
    }

    // "Delete for Everyone" logic
    if (user.role === 'SUPER_ADMIN') {
        return true // Super Admins can hard delete or soft delete anything anytime
    }

    const config = getConfig()

    // If global message deletion is disabled, non-SuperAdmins cannot delete for everyone
    if (!config.features.messageDelete) {
        return false
    }

    // Admins and Users can "Delete for Everyone" for their own messages within the configured time limit
    if (message.senderId === user.id) {
        const createdTime = message.createdAt instanceof Date
            ? message.createdAt.getTime()
            : new Date(message.createdAt).getTime()
        const messageAge = Date.now() - createdTime

        // Convert configured seconds to milliseconds
        const timeLimitMs = config.features.messageDeleteTimeLimit * 1000

        return messageAge < timeLimitMs
    }

    return false
}

export function canAccessConversation(
    user: Pick<User, 'id' | 'role'>,
    conversation: Pick<Conversation, 'userId' | 'assignedAdminId'>
): boolean {
    // SUPER_ADMIN can access all conversations
    if (user.role === 'SUPER_ADMIN') return true
    // Regular ADMIN can only access conversations assigned to them
    if (user.role === 'ADMIN') return conversation.assignedAdminId === user.id
    // Users can only access their own conversation
    return conversation.userId === user.id
}

export function isAdmin(user: Pick<User, 'role'>): boolean {
    return user.role === 'ADMIN' || user.role === 'SUPER_ADMIN'
}
