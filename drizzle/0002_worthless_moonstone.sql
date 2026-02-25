PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_media` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`uploaded_by` text NOT NULL,
	`type` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`filename` text NOT NULL,
	`r2_key` text NOT NULL,
	`cdn_url` text NOT NULL,
	`hash` text,
	`metadata` text,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`uploaded_at` integer DEFAULT (unixepoch()) NOT NULL,
	`confirmed_at` integer,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_media`("id", "message_id", "uploaded_by", "type", "mime_type", "size", "filename", "r2_key", "cdn_url", "hash", "metadata", "status", "uploaded_at", "confirmed_at") SELECT "id", "message_id", "uploaded_by", "type", "mime_type", "size", "filename", "r2_key", "cdn_url", "hash", "metadata", "status", "uploaded_at", "confirmed_at" FROM `media`;--> statement-breakpoint
DROP TABLE `media`;--> statement-breakpoint
ALTER TABLE `__new_media` RENAME TO `media`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_media_message_id` ON `media` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_media_uploaded_by` ON `media` (`uploaded_by`);--> statement-breakpoint
CREATE INDEX `idx_media_pending_upload` ON `media` (`uploaded_at`) WHERE "media"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX `idx_media_hash` ON `media` (`hash`) WHERE "media"."hash" IS NOT NULL AND "media"."status" = 'CONFIRMED';--> statement-breakpoint
DROP INDEX `idx_ann_comments_announcement`;--> statement-breakpoint
DROP INDEX `idx_ann_comments_user`;--> statement-breakpoint
CREATE INDEX `idx_ann_comments_created` ON `announcement_comments` (`announcement_id`,`created_at`) WHERE "announcement_comments"."deleted_at" IS NULL;--> statement-breakpoint
DROP INDEX `idx_ann_reactions_user`;--> statement-breakpoint
DROP INDEX `idx_announcement_votes_user`;--> statement-breakpoint
DROP INDEX `idx_announcements_active`;--> statement-breakpoint
CREATE INDEX `idx_announcements_active_created` ON `announcements` (`created_at`) WHERE "announcements"."is_active" = 1;--> statement-breakpoint
DROP INDEX `idx_audit_action`;--> statement-breakpoint
DROP INDEX `idx_audit_entity`;--> statement-breakpoint
DROP INDEX `idx_audit_created`;--> statement-breakpoint
CREATE INDEX `idx_audit_action_created` ON `audit_logs` (`action`,`created_at`);--> statement-breakpoint
DROP INDEX `idx_conversations_user_id`;--> statement-breakpoint
DROP INDEX `idx_conversations_unread`;--> statement-breakpoint
DROP INDEX `idx_conversations_unread_last`;--> statement-breakpoint
CREATE INDEX `idx_conversations_unread_last` ON `conversations` (`last_message_at`) WHERE "conversations"."unread_count" > 0;--> statement-breakpoint
DROP INDEX `idx_dm_reactions_user`;--> statement-breakpoint
DROP INDEX `uq_dm_reaction`;--> statement-breakpoint
CREATE INDEX `idx_dm_reactions_message` ON `direct_message_reactions` (`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_dm_reaction` ON `direct_message_reactions` (`message_id`,`user_id`);--> statement-breakpoint
DROP INDEX `idx_dm_sender`;--> statement-breakpoint
DROP INDEX `idx_dm_recipient`;--> statement-breakpoint
DROP INDEX `idx_dm_thread`;--> statement-breakpoint
DROP INDEX `idx_dm_created`;--> statement-breakpoint
CREATE INDEX `idx_dm_thread_fwd` ON `direct_messages` (`sender_id`,`recipient_id`,`created_at`) WHERE "direct_messages"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_dm_thread_rev` ON `direct_messages` (`recipient_id`,`sender_id`,`created_at`) WHERE "direct_messages"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_dm_recipient_created` ON `direct_messages` (`recipient_id`,`created_at`) WHERE "direct_messages"."deleted_at" IS NULL;--> statement-breakpoint
DROP INDEX `idx_internal_reactions_user`;--> statement-breakpoint
DROP INDEX `uq_internal_reaction`;--> statement-breakpoint
CREATE INDEX `idx_internal_reactions_message` ON `internal_message_reactions` (`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_internal_reaction` ON `internal_message_reactions` (`message_id`,`user_id`);--> statement-breakpoint
DROP INDEX `idx_internal_messages_sender`;--> statement-breakpoint
DROP INDEX `idx_internal_messages_created`;--> statement-breakpoint
CREATE INDEX `idx_internal_messages_created` ON `internal_messages` (`created_at`) WHERE "internal_messages"."deleted_at" IS NULL;--> statement-breakpoint
DROP INDEX `idx_message_reactions_user`;--> statement-breakpoint
DROP INDEX `uq_message_reaction`;--> statement-breakpoint
CREATE INDEX `idx_message_reactions_message` ON `message_reactions` (`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_message_reaction` ON `message_reactions` (`message_id`,`user_id`);--> statement-breakpoint
DROP INDEX `idx_messages_conversation_created`;--> statement-breakpoint
DROP INDEX `idx_messages_conversation_status`;--> statement-breakpoint
DROP INDEX `idx_messages_sender`;--> statement-breakpoint
DROP INDEX `idx_messages_deleted`;--> statement-breakpoint
DROP INDEX `idx_messages_conv_del_created`;--> statement-breakpoint
CREATE INDEX `idx_messages_conv_created` ON `messages` (`conversation_id`,`created_at`) WHERE "messages"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_messages_conv_unread` ON `messages` (`conversation_id`) WHERE "messages"."status" = 'SENT' AND "messages"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_messages_sender_created` ON `messages` (`sender_id`,`created_at`);--> statement-breakpoint
DROP INDEX `idx_password_reset_user_id`;--> statement-breakpoint
DROP INDEX `idx_password_reset_expires`;--> statement-breakpoint
DROP INDEX `idx_password_reset_used_at`;--> statement-breakpoint
CREATE INDEX `idx_password_reset_user_expires` ON `password_reset_tokens` (`user_id`,`expires_at`) WHERE "password_reset_tokens"."used_at" IS NULL;--> statement-breakpoint
DROP INDEX `idx_refresh_user`;--> statement-breakpoint
DROP INDEX `idx_refresh_active`;--> statement-breakpoint
CREATE INDEX `idx_refresh_active` ON `refresh_tokens` (`user_id`,`session_id`) WHERE "refresh_tokens"."revoked_at" IS NULL;--> statement-breakpoint
DROP INDEX `idx_sessions_user_id`;--> statement-breakpoint
DROP INDEX `idx_sessions_user_active`;--> statement-breakpoint
CREATE INDEX `idx_sessions_user_active` ON `sessions` (`user_id`,`last_active_at`) WHERE "sessions"."revoked_at" IS NULL;--> statement-breakpoint
DROP INDEX `idx_users_email`;--> statement-breakpoint
DROP INDEX `idx_users_status`;--> statement-breakpoint
DROP INDEX `idx_users_role`;--> statement-breakpoint
CREATE INDEX `idx_users_role_created` ON `users` (`role`,`created_at`);