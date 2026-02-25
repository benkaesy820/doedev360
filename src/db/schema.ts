import { sqliteTable, text, integer, index, unique } from 'drizzle-orm/sqlite-core'
import { sql, relations } from 'drizzle-orm'

// ============================================================================
// USERS TABLE
// ============================================================================
export const users = sqliteTable('users', {
  id: text('id').primaryKey(), // ulid
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  phone: text('phone'),

  // Access Control
  role: text('role', { enum: ['SUPER_ADMIN', 'ADMIN', 'USER'] }).notNull().default('USER'),
  status: text('status', { enum: ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'] }).notNull().default('PENDING'),
  mediaPermission: integer('media_permission', { mode: 'boolean' }).notNull().default(false),

  // Preferences
  emailNotifyOnMessage: integer('email_notify_on_message', { mode: 'boolean' }).notNull().default(true),

  // Metadata
  rejectionReason: text('rejection_reason'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
}, (table) => ({
  // email is already unique — no separate index needed (unique IS an index)

  // Admin dashboard: list users filtered by status, sorted by time
  // Covers: WHERE status = ? ORDER BY createdAt — single most common admin query
  statusCreatedIdx: index('idx_users_status_created').on(table.status, table.createdAt),

  // Admin: filter by role (list admins, list users)
  roleCreatedIdx: index('idx_users_role_created').on(table.role, table.createdAt),

  // Admin search: prefix search on name (LIKE 'query%' can use this index)
  nameIdx: index('idx_users_name').on(table.name),

  // Presence / last-seen queries
  lastSeenIdx: index('idx_users_last_seen').on(table.lastSeenAt),
}))

// ============================================================================
// SESSIONS TABLE
// ============================================================================
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(), // ulid
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Device Info
  deviceInfo: text('device_info').notNull(), // JSON: { browser, os, device }
  ipAddress: text('ip_address').notNull(),

  // Session priority for conflict resolution (higher = more important)
  priority: integer('priority').notNull().default(1),

  // Lifecycle
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  lastActiveAt: integer('last_active_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
}, (table) => ({
  // HOT PATH: validate session — only active (non-revoked) sessions live in this index
  // Partial: revoked sessions are invisible, keeping the tree tiny
  userActiveIdx: index('idx_sessions_user_active')
    .on(table.userId, table.lastActiveAt)
    .where(sql`${table.revokedAt} IS NULL`),

  // Session conflict resolution: evict oldest lowest-priority sessions
  priorityIdx: index('idx_sessions_priority').on(table.userId, table.priority, table.createdAt),

  // Background cleanup job: find expired sessions (full index — cleanup needs ALL expired)
  expiresIdx: index('idx_sessions_expires').on(table.expiresAt),
}))

// ============================================================================
// PASSWORD RESET TOKENS TABLE
// ============================================================================
export const passwordResetTokens = sqliteTable('password_reset_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(), // JWT hash lookup — unique IS an index
  ipAddress: text('ip_address').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  usedAt: integer('used_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  // Cleanup: unused tokens only — used tokens are never cleaned again
  userExpiresIdx: index('idx_password_reset_user_expires')
    .on(table.userId, table.expiresAt)
    .where(sql`${table.usedAt} IS NULL`),
}))

// ============================================================================
// REFRESH TOKENS TABLE
// ============================================================================
export const refreshTokens = sqliteTable('refresh_tokens', {
  id: text('id').primaryKey(), // ulid
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(), // lookup is always by hash; unique IS an index

  // Device and security info
  deviceInfo: text('device_info'),
  ipAddress: text('ip_address').notNull(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),

  // Lifecycle
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  // Session-level FK lookup
  sessionIdx: index('idx_refresh_session').on(table.sessionId),

  // HOT PATH: validate active token — only non-revoked tokens in index
  activeIdx: index('idx_refresh_active')
    .on(table.userId, table.sessionId)
    .where(sql`${table.revokedAt} IS NULL`),

  // Cleanup job: expired tokens (full index — need all expired regardless of revoke state)
  expiresIdx: index('idx_refresh_expires').on(table.expiresAt),
}))

// ============================================================================
// CONVERSATIONS TABLE
// ============================================================================
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(), // ulid
  userId: text('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),

  // Assignment — which admin is handling this conversation
  assignedAdminId: text('assigned_admin_id').references(() => users.id, { onDelete: 'set null' }),

  // Metadata
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),

  // Tracking — denormalized for O(1) dashboard queries
  lastMessageAt: integer('last_message_at', { mode: 'timestamp' }),
  unreadCount: integer('unread_count').notNull().default(0),
  adminUnreadCount: integer('admin_unread_count').notNull().default(0),
}, (table) => ({
  // HOT PATH: admin dashboard — only conversations WITH unread live in this index
  // Partial WHERE unreadCount > 0: typically a small fraction of all conversations
  unreadLastMessageIdx: index('idx_conversations_unread_last')
    .on(table.lastMessageAt)
    .where(sql`${table.unreadCount} > 0`),

  // Admin: conversations with unread messages from user — partial so it stays tiny
  adminUnreadIdx: index('idx_conversations_admin_unread')
    .on(table.lastMessageAt)
    .where(sql`${table.adminUnreadCount} > 0`),

  // Admin: all conversations sorted by last activity (includes read ones)
  lastMessageIdx: index('idx_conversations_last_message').on(table.lastMessageAt),

  // Filter conversations assigned to a specific admin (composite for ORDER BY lastMessageAt)
  assignedAdminIdx: index('idx_conversations_assigned_admin').on(table.assignedAdminId, table.lastMessageAt),
}))

// ============================================================================
// MESSAGES TABLE
// ============================================================================
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(), // ulid
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  senderId: text('sender_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Content
  type: text('type', { enum: ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'] }).notNull(),
  content: text('content'),

  // Status
  status: text('status', { enum: ['SENT', 'READ'] }).notNull().default('SENT'),
  readAt: integer('read_at', { mode: 'timestamp' }),

  // Reply reference
  replyToId: text('reply_to_id'),

  // Announcement link (optional — message can reference an announcement)
  announcementId: text('announcement_id'),

  // Soft Delete
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
  deletedBy: text('deleted_by').references(() => users.id),
  hiddenFor: text('hidden_for').notNull().default('[]'),

  // Timestamps
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  // HOT PATH: fetch paginated messages — only non-deleted rows in index
  // Partial WHERE deletedAt IS NULL: eliminates 3-column composite, faster traversal
  convCreatedIdx: index('idx_messages_conv_created')
    .on(table.conversationId, table.createdAt)
    .where(sql`${table.deletedAt} IS NULL`),

  // HOT PATH: unread count — only SENT non-deleted messages in index
  // COUNT(*) WHERE conversationId=? hits this tiny partial index
  convUnreadIdx: index('idx_messages_conv_unread')
    .on(table.conversationId)
    .where(sql`${table.status} = 'SENT' AND ${table.deletedAt} IS NULL`),

  // Admin: view messages sent by a user (audit — includes deleted)
  senderCreatedIdx: index('idx_messages_sender_created').on(table.senderId, table.createdAt),

  // Reply threading: FK index prevents full table scan
  replyToIdx: index('idx_messages_reply_to').on(table.replyToId),
}))

// ============================================================================
// MESSAGE REACTIONS TABLE
// ============================================================================
export const messageReactions = sqliteTable('message_reactions', {
  id: text('id').primaryKey(),
  messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  emoji: text('emoji').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  // Unique: one reaction type per user per message (upsert pattern)
  uniqueReaction: unique('uq_message_reaction').on(table.messageId, table.userId),

  // HOT PATH: load all reactions for a message (covers the unique constraint for reads too)
  messageIdIdx: index('idx_message_reactions_message').on(table.messageId),
}))

// ============================================================================
// MEDIA TABLE
// ============================================================================
export const media = sqliteTable('media', {
  id: text('id').primaryKey(), // ulid
  // messageId is NOT a FK — media can belong to messages, internal_messages, or direct_messages
  messageId: text('message_id'),
  uploadedBy: text('uploaded_by').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // File Info
  type: text('type', { enum: ['IMAGE', 'VIDEO', 'DOCUMENT'] }).notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(), // bytes
  filename: text('filename').notNull(),

  // Storage — r2Key is NOT unique: deduplicated media records share the same storage path
  r2Key: text('r2_key').notNull(),
  cdnUrl: text('cdn_url').notNull(),
  hash: text('hash'), // SHA-256 hex — used to detect and skip re-uploads (deduplication)

  // Media-specific metadata (JSON: { width, height, duration, thumbnail })
  metadata: text('metadata'),

  // Lifecycle
  status: text('status', { enum: ['PENDING', 'CONFIRMED', 'FAILED'] }).notNull().default('PENDING'),
  uploadedAt: integer('uploaded_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  confirmedAt: integer('confirmed_at', { mode: 'timestamp' }),
}, (table) => ({
  // Message-to-media lookup (JOIN on any message type)
  messageIdIdx: index('idx_media_message_id').on(table.messageId),

  // User's media library
  uploadedByIdx: index('idx_media_uploaded_by').on(table.uploadedBy),

  // Background cleanup: only PENDING uploads need to be examined
  pendingUploadIdx: index('idx_media_pending_upload')
    .on(table.uploadedAt)
    .where(sql`${table.status} = 'PENDING'`),

  // Deduplication: only CONFIRMED media with a hash matters for dedup checks
  hashIdx: index('idx_media_hash')
    .on(table.hash)
    .where(sql`${table.hash} IS NOT NULL AND ${table.status} = 'CONFIRMED'`),
}))

// ============================================================================
// USER STATUS HISTORY TABLE
// ============================================================================
export const userStatusHistory = sqliteTable('user_status_history', {
  id: text('id').primaryKey(), // ulid
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Change Details
  previousStatus: text('previous_status', { enum: ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'] }).notNull(),
  newStatus: text('new_status', { enum: ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'] }).notNull(),

  // Audit
  changedBy: text('changed_by').notNull().references(() => users.id),
  reason: text('reason'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  // User timeline: WHERE userId = ? ORDER BY createdAt
  userIdCreatedIdx: index('idx_status_history_user_created').on(table.userId, table.createdAt),

  // Admin: what changes did this admin make?
  changedByIdx: index('idx_status_history_changed_by').on(table.changedBy),
}))

// ============================================================================
// AUDIT LOGS TABLE
// ============================================================================
export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(), // ulid

  // Actor
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  ipAddress: text('ip_address').notNull(),

  // Action
  action: text('action').notNull(),       // e.g. 'user.approve', 'message.delete'
  entityType: text('entity_type').notNull(), // e.g. 'user', 'message', 'media'
  entityId: text('entity_id').notNull(),

  // Context (JSON)
  details: text('details'),

  // Timestamp
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  // Any action on a specific entity, paginated by time
  entityCreatedIdx: index('idx_audit_entity_created').on(table.entityType, table.entityId, table.createdAt),

  // All actions by a user, paginated by time
  userIdCreatedIdx: index('idx_audit_user_created').on(table.userId, table.createdAt),

  // Filter by action type (e.g. all media.upload events)
  actionCreatedIdx: index('idx_audit_action_created').on(table.action, table.createdAt),
}))

// ============================================================================
// ANNOUNCEMENTS TABLE
// ============================================================================
export const announcements = sqliteTable('announcements', {
  id: text('id').primaryKey(), // ulid
  title: text('title').notNull(),
  content: text('content').notNull(),
  type: text('type', { enum: ['INFO', 'WARNING', 'IMPORTANT'] }).notNull().default('INFO'),
  template: text('template', { enum: ['DEFAULT', 'BANNER', 'CARD', 'MINIMAL'] }).notNull().default('DEFAULT'),

  // Media (optional attachment)
  mediaId: text('media_id').references(() => media.id, { onDelete: 'set null' }),

  // Targeting (null = all users)
  targetRoles: text('target_roles'), // JSON: ["USER"] | ["ADMIN","SUPER_ADMIN"] | null

  // Author
  createdBy: text('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Denormalized vote counts for fast reads (updated on vote insert/delete)
  upvoteCount: integer('upvote_count').notNull().default(0),
  downvoteCount: integer('downvote_count').notNull().default(0),

  // Lifecycle
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
}, (table) => ({
  // HOT PATH: list active announcements — inactive ones not in index
  activeCreatedIdx: index('idx_announcements_active_created')
    .on(table.createdAt)
    .where(sql`${table.isActive} = 1`),

  // Author's announcements
  createdByIdx: index('idx_announcements_created_by').on(table.createdBy),
}))

// ============================================================================
// ANNOUNCEMENT VOTES TABLE
// ============================================================================
export const announcementVotes = sqliteTable('announcement_votes', {
  id: text('id').primaryKey(), // ulid
  announcementId: text('announcement_id').notNull().references(() => announcements.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  vote: text('vote', { enum: ['UP', 'DOWN'] }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  // One vote per user per announcement
  uniqueVote: unique('uq_announcement_vote').on(table.announcementId, table.userId),
  // No extra index needed — unique constraint covers (announcementId, userId) reads
}))

// ============================================================================
// ANNOUNCEMENT REACTIONS TABLE
// ============================================================================
export const announcementReactions = sqliteTable('announcement_reactions', {
  id: text('id').primaryKey(),
  announcementId: text('announcement_id').notNull().references(() => announcements.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  emoji: text('emoji').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  // One emoji per user per announcement (upsert)
  uniqueReaction: unique('uq_announcement_reaction').on(table.announcementId, table.userId),
  // unique constraint covers (announcementId, userId) reads — no extra index needed
}))

// ============================================================================
// ANNOUNCEMENT COMMENTS TABLE
// ============================================================================
export const announcementComments = sqliteTable('announcement_comments', {
  id: text('id').primaryKey(),
  announcementId: text('announcement_id').notNull().references(() => announcements.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  // HOT PATH: paginated non-deleted comments — only live comments in index
  annCreatedIdx: index('idx_ann_comments_created')
    .on(table.announcementId, table.createdAt)
    .where(sql`${table.deletedAt} IS NULL`),
}))

// ============================================================================
// INTERNAL MESSAGES — Admin group chat channel
// ============================================================================
export const internalMessages = sqliteTable('internal_messages', {
  id: text('id').primaryKey(), // ulid
  senderId: text('sender_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Content
  type: text('type', { enum: ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'] }).notNull().default('TEXT'),
  content: text('content'),
  mediaId: text('media_id').references(() => media.id, { onDelete: 'set null' }),
  replyToId: text('reply_to_id').references((): any => internalMessages.id, { onDelete: 'set null' }),

  // Soft delete (permanent — super admin only)
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),

  // Per-user hide: JSON array of user IDs who hid this message for themselves
  hiddenFor: text('hidden_for').notNull().default('[]'),

  // Timestamps
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  // HOT PATH: paginated non-deleted internal messages — only live messages in index
  createdIdx: index('idx_internal_messages_created')
    .on(table.createdAt)
    .where(sql`${table.deletedAt} IS NULL`),

  // Reply FK index
  replyToIdx: index('idx_internal_messages_reply_to').on(table.replyToId),
}))

// ============================================================================
// INTERNAL MESSAGE REACTIONS TABLE
// ============================================================================
export const internalMessageReactions = sqliteTable('internal_message_reactions', {
  id: text('id').primaryKey(), // ulid
  messageId: text('message_id').notNull().references(() => internalMessages.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  emoji: text('emoji').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  // One reaction per user per message
  uniqueReaction: unique('uq_internal_reaction').on(table.messageId, table.userId),

  // Load all reactions for a message
  messageIdIdx: index('idx_internal_reactions_message').on(table.messageId),
}))

// ============================================================================
// DIRECT MESSAGES — Admin-to-admin private messages
// ============================================================================
export const directMessages = sqliteTable('direct_messages', {
  id: text('id').primaryKey(),
  senderId: text('sender_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  recipientId: text('recipient_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type', { enum: ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'] }).notNull().default('TEXT'),
  content: text('content'),
  mediaId: text('media_id').references(() => media.id, { onDelete: 'set null' }),
  replyToId: text('reply_to_id').references((): any => directMessages.id, { onDelete: 'set null' }),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
  hiddenFor: text('hidden_for').notNull().default('[]'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  // HOT PATH: thread A→B direction, non-deleted only
  threadFwdIdx: index('idx_dm_thread_fwd')
    .on(table.senderId, table.recipientId, table.createdAt)
    .where(sql`${table.deletedAt} IS NULL`),

  // HOT PATH: thread B→A direction — previously missing, caused partial scan on reverse direction
  threadRevIdx: index('idx_dm_thread_rev')
    .on(table.recipientId, table.senderId, table.createdAt)
    .where(sql`${table.deletedAt} IS NULL`),

  // Inbox: messages for a recipient, non-deleted
  recipientCreatedIdx: index('idx_dm_recipient_created')
    .on(table.recipientId, table.createdAt)
    .where(sql`${table.deletedAt} IS NULL`),

  // Reply FK index
  replyToIdx: index('idx_dm_reply_to').on(table.replyToId),
}))

// ============================================================================
// DIRECT MESSAGE REACTIONS TABLE
// ============================================================================
export const directMessageReactions = sqliteTable('direct_message_reactions', {
  id: text('id').primaryKey(), // ulid
  messageId: text('message_id').notNull().references(() => directMessages.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  emoji: text('emoji').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  // One reaction per user per message
  uniqueReaction: unique('uq_dm_reaction').on(table.messageId, table.userId),

  // Load all reactions for a message
  messageIdIdx: index('idx_dm_reactions_message').on(table.messageId),
}))

// ============================================================================
// RELATIONS (required for Drizzle relational query API — with: {})
// ============================================================================
export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  refreshTokens: many(refreshTokens),
  passwordResetTokens: many(passwordResetTokens),
  conversations: many(conversations),
  sentMessages: many(messages),
  uploadedMedia: many(media),
  statusHistory: many(userStatusHistory, { relationName: 'userStatusHistory' }),
  statusChanges: many(userStatusHistory, { relationName: 'changedByHistory' }),
  auditLogs: many(auditLogs),
  announcements: many(announcements),
}))

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
  refreshTokens: many(refreshTokens),
}))

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, { fields: [refreshTokens.userId], references: [users.id] }),
  session: one(sessions, { fields: [refreshTokens.sessionId], references: [sessions.id] }),
}))

export const passwordResetTokensRelations = relations(passwordResetTokens, ({ one }) => ({
  user: one(users, { fields: [passwordResetTokens.userId], references: [users.id] }),
}))

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  user: one(users, { fields: [conversations.userId], references: [users.id] }),
  assignedAdmin: one(users, { fields: [conversations.assignedAdminId], references: [users.id], relationName: 'assignedConversations' }),
  messages: many(messages),
}))

export const messagesRelations = relations(messages, ({ one, many }) => ({
  conversation: one(conversations, { fields: [messages.conversationId], references: [conversations.id] }),
  sender: one(users, { fields: [messages.senderId], references: [users.id] }),
  media: one(media, { fields: [messages.id], references: [media.messageId] }),
  reactions: many(messageReactions),
  replyTo: one(messages, { fields: [messages.replyToId], references: [messages.id], relationName: 'messageReplies' }),
  replies: many(messages, { relationName: 'messageReplies' }),
  linkedAnnouncement: one(announcements, { fields: [messages.announcementId], references: [announcements.id] }),
}))

export const internalMessagesRelations = relations(internalMessages, ({ one, many }) => ({
  sender: one(users, { fields: [internalMessages.senderId], references: [users.id] }),
  media: one(media, { fields: [internalMessages.mediaId], references: [media.id] }),
  reactions: many(internalMessageReactions),
  replyTo: one(internalMessages, { fields: [internalMessages.replyToId], references: [internalMessages.id], relationName: 'internalMessageReplies' }),
  replies: many(internalMessages, { relationName: 'internalMessageReplies' }),
}))

export const internalMessageReactionsRelations = relations(internalMessageReactions, ({ one }) => ({
  message: one(internalMessages, { fields: [internalMessageReactions.messageId], references: [internalMessages.id] }),
  user: one(users, { fields: [internalMessageReactions.userId], references: [users.id] }),
}))

export const messageReactionsRelations = relations(messageReactions, ({ one }) => ({
  message: one(messages, { fields: [messageReactions.messageId], references: [messages.id] }),
  user: one(users, { fields: [messageReactions.userId], references: [users.id] }),
}))

export const mediaRelations = relations(media, ({ one }) => ({
  // uploader is the only reliable FK relation (messageId is intentionally untyped)
  uploader: one(users, { fields: [media.uploadedBy], references: [users.id] }),
}))

export const userStatusHistoryRelations = relations(userStatusHistory, ({ one }) => ({
  user: one(users, { fields: [userStatusHistory.userId], references: [users.id], relationName: 'userStatusHistory' }),
  changedByUser: one(users, { fields: [userStatusHistory.changedBy], references: [users.id], relationName: 'changedByHistory' }),
}))

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  user: one(users, { fields: [auditLogs.userId], references: [users.id] }),
}))

export const announcementsRelations = relations(announcements, ({ one, many }) => ({
  author: one(users, { fields: [announcements.createdBy], references: [users.id] }),
  mediaAttachment: one(media, { fields: [announcements.mediaId], references: [media.id] }),
  votes: many(announcementVotes),
  reactions: many(announcementReactions),
  comments: many(announcementComments),
  referencedInMessages: many(messages),
}))

export const announcementReactionsRelations = relations(announcementReactions, ({ one }) => ({
  announcement: one(announcements, { fields: [announcementReactions.announcementId], references: [announcements.id] }),
  user: one(users, { fields: [announcementReactions.userId], references: [users.id] }),
}))

export const announcementCommentsRelations = relations(announcementComments, ({ one }) => ({
  announcement: one(announcements, { fields: [announcementComments.announcementId], references: [announcements.id] }),
  user: one(users, { fields: [announcementComments.userId], references: [users.id] }),
}))

export const announcementVotesRelations = relations(announcementVotes, ({ one }) => ({
  announcement: one(announcements, { fields: [announcementVotes.announcementId], references: [announcements.id] }),
  user: one(users, { fields: [announcementVotes.userId], references: [users.id] }),
}))

export const directMessagesRelations = relations(directMessages, ({ one, many }) => ({
  sender: one(users, { fields: [directMessages.senderId], references: [users.id], relationName: 'dmSender' }),
  recipient: one(users, { fields: [directMessages.recipientId], references: [users.id], relationName: 'dmRecipient' }),
  media: one(media, { fields: [directMessages.mediaId], references: [media.id] }),
  reactions: many(directMessageReactions),
  replyTo: one(directMessages, { fields: [directMessages.replyToId], references: [directMessages.id], relationName: 'dmReplies' }),
  replies: many(directMessages, { relationName: 'dmReplies' }),
}))

export const directMessageReactionsRelations = relations(directMessageReactions, ({ one }) => ({
  message: one(directMessages, { fields: [directMessageReactions.messageId], references: [directMessages.id] }),
  user: one(users, { fields: [directMessageReactions.userId], references: [users.id] }),
}))

// ============================================================================
// TYPE EXPORTS
// ============================================================================
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert

export type Session = typeof sessions.$inferSelect
export type NewSession = typeof sessions.$inferInsert

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert

export type RefreshToken = typeof refreshTokens.$inferSelect
export type NewRefreshToken = typeof refreshTokens.$inferInsert

export type Conversation = typeof conversations.$inferSelect
export type NewConversation = typeof conversations.$inferInsert

export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert

export type MessageReaction = typeof messageReactions.$inferSelect
export type NewMessageReaction = typeof messageReactions.$inferInsert

export type Media = typeof media.$inferSelect
export type NewMedia = typeof media.$inferInsert

export type UserStatusHistory = typeof userStatusHistory.$inferSelect
export type NewUserStatusHistory = typeof userStatusHistory.$inferInsert

export type AuditLog = typeof auditLogs.$inferSelect
export type NewAuditLog = typeof auditLogs.$inferInsert

export type Announcement = typeof announcements.$inferSelect
export type NewAnnouncement = typeof announcements.$inferInsert

export type AnnouncementVote = typeof announcementVotes.$inferSelect
export type NewAnnouncementVote = typeof announcementVotes.$inferInsert

export type AnnouncementReaction = typeof announcementReactions.$inferSelect
export type NewAnnouncementReaction = typeof announcementReactions.$inferInsert

export type AnnouncementComment = typeof announcementComments.$inferSelect
export type NewAnnouncementComment = typeof announcementComments.$inferInsert

export type InternalMessage = typeof internalMessages.$inferSelect
export type NewInternalMessage = typeof internalMessages.$inferInsert

export type DirectMessage = typeof directMessages.$inferSelect
export type NewDirectMessage = typeof directMessages.$inferInsert

// ============================================================================
// PERFORMANCE ENGINEERING NOTES
// ============================================================================
/*
INDEX DESIGN PRINCIPLES APPLIED:
  1. UNIQUE constraints are automatically indexes — no duplicate index defined alongside them.
  2. Composite indexes always lead with the equality column (=), then range/sort columns (ORDER BY).
  3. Single-column indexes are only created when NOT already covered by a composite.
  4. Every FK that is used as a JOIN target has an index to prevent full table scans.
  5. Hot read paths (paginated lists) have a composite covering (filter, deletedAt, createdAt).

HOT QUERY PATHS:
  - messages in conversation        → idx_messages_conv_del_created
  - unread count in conversation     → idx_messages_conv_status
  - admin dashboard (unread convs)   → idx_conversations_unread_last
  - session validation               → idx_sessions_user_active (unique)
  - internal chat list               → idx_internal_messages_del_created
  - DM thread                        → idx_dm_thread
  - file deduplication               → idx_media_hash_status
  - audit trail                      → idx_audit_entity_created

WRITE EFFICIENCY:
  - Timestamps use unixepoch() integers (8 bytes, no parsing overhead)
  - All FKs have ON DELETE CASCADE/SET NULL (no orphan cleanup needed)
  - Enum constraints prevent invalid inserts reaching the application layer
  - Denormalized counters (unreadCount, upvoteCount) avoid expensive COUNT() queries
*/
