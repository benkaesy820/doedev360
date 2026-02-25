CREATE TABLE `announcement_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`announcement_id` text NOT NULL,
	`user_id` text NOT NULL,
	`content` text NOT NULL,
	`deleted_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`announcement_id`) REFERENCES `announcements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ann_comments_announcement` ON `announcement_comments` (`announcement_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_ann_comments_user` ON `announcement_comments` (`user_id`);--> statement-breakpoint
CREATE TABLE `announcement_reactions` (
	`id` text PRIMARY KEY NOT NULL,
	`announcement_id` text NOT NULL,
	`user_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`announcement_id`) REFERENCES `announcements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ann_reactions_announcement` ON `announcement_reactions` (`announcement_id`);--> statement-breakpoint
CREATE INDEX `idx_ann_reactions_user` ON `announcement_reactions` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_announcement_reaction` ON `announcement_reactions` (`announcement_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `announcement_votes` (
	`id` text PRIMARY KEY NOT NULL,
	`announcement_id` text NOT NULL,
	`user_id` text NOT NULL,
	`vote` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`announcement_id`) REFERENCES `announcements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_announcement_votes_announcement` ON `announcement_votes` (`announcement_id`);--> statement-breakpoint
CREATE INDEX `idx_announcement_votes_user` ON `announcement_votes` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_announcement_vote` ON `announcement_votes` (`announcement_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `announcements` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`type` text DEFAULT 'INFO' NOT NULL,
	`template` text DEFAULT 'DEFAULT' NOT NULL,
	`media_id` text,
	`target_roles` text,
	`created_by` text NOT NULL,
	`upvote_count` integer DEFAULT 0 NOT NULL,
	`downvote_count` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_announcements_active` ON `announcements` (`is_active`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_announcements_created_by` ON `announcements` (`created_by`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`ip_address` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`details` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_audit_action` ON `audit_logs` (`action`);--> statement-breakpoint
CREATE INDEX `idx_audit_entity` ON `audit_logs` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_user_created` ON `audit_logs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_created` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_entity_created` ON `audit_logs` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`assigned_admin_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_message_at` integer,
	`unread_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assigned_admin_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_user_id_unique` ON `conversations` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_conversations_user_id` ON `conversations` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_conversations_last_message` ON `conversations` (`last_message_at`);--> statement-breakpoint
CREATE INDEX `idx_conversations_unread` ON `conversations` (`unread_count`);--> statement-breakpoint
CREATE INDEX `idx_conversations_unread_last` ON `conversations` (`unread_count`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `idx_conversations_assigned_admin` ON `conversations` (`assigned_admin_id`);--> statement-breakpoint
CREATE TABLE `direct_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`sender_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`type` text DEFAULT 'TEXT' NOT NULL,
	`content` text,
	`media_id` text,
	`deleted_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_dm_sender` ON `direct_messages` (`sender_id`);--> statement-breakpoint
CREATE INDEX `idx_dm_recipient` ON `direct_messages` (`recipient_id`);--> statement-breakpoint
CREATE INDEX `idx_dm_thread` ON `direct_messages` (`sender_id`,`recipient_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_dm_created` ON `direct_messages` (`created_at`);--> statement-breakpoint
CREATE TABLE `internal_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`sender_id` text NOT NULL,
	`type` text DEFAULT 'TEXT' NOT NULL,
	`content` text,
	`media_id` text,
	`deleted_at` integer,
	`hidden_for` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_internal_messages_sender` ON `internal_messages` (`sender_id`);--> statement-breakpoint
CREATE INDEX `idx_internal_messages_created` ON `internal_messages` (`created_at`);--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`uploaded_by` text NOT NULL,
	`type` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`filename` text NOT NULL,
	`r2_key` text NOT NULL,
	`cdn_url` text NOT NULL,
	`metadata` text,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`uploaded_at` integer DEFAULT (unixepoch()) NOT NULL,
	`confirmed_at` integer,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_r2_key_unique` ON `media` (`r2_key`);--> statement-breakpoint
CREATE INDEX `idx_media_message_id` ON `media` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_media_uploaded_by` ON `media` (`uploaded_by`);--> statement-breakpoint
CREATE INDEX `idx_media_status_uploaded` ON `media` (`status`,`uploaded_at`);--> statement-breakpoint
CREATE INDEX `idx_media_r2_key` ON `media` (`r2_key`);--> statement-breakpoint
CREATE TABLE `message_reactions` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_message_reactions_message` ON `message_reactions` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_message_reactions_user` ON `message_reactions` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_message_reaction` ON `message_reactions` (`message_id`,`user_id`,`emoji`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`type` text NOT NULL,
	`content` text,
	`status` text DEFAULT 'SENT' NOT NULL,
	`read_at` integer,
	`reply_to_id` text,
	`announcement_id` text,
	`deleted_at` integer,
	`deleted_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deleted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_messages_conversation_created` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_messages_conversation_status` ON `messages` (`conversation_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_messages_sender` ON `messages` (`sender_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_deleted` ON `messages` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `idx_messages_conv_del_created` ON `messages` (`conversation_id`,`deleted_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `password_reset_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`ip_address` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `password_reset_tokens_token_hash_unique` ON `password_reset_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_password_reset_user_id` ON `password_reset_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_password_reset_expires` ON `password_reset_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_password_reset_used_at` ON `password_reset_tokens` (`used_at`);--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`device_info` text,
	`ip_address` text NOT NULL,
	`last_used_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_tokens_token_hash_unique` ON `refresh_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_refresh_session` ON `refresh_tokens` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_refresh_user` ON `refresh_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_refresh_expires` ON `refresh_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_refresh_active` ON `refresh_tokens` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device_info` text NOT NULL,
	`ip_address` text NOT NULL,
	`priority` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL,
	`last_active_at` integer DEFAULT (unixepoch()) NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_user_id` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_user_active` ON `sessions` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_priority` ON `sessions` (`user_id`,`priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_expires` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `user_status_history` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`previous_status` text NOT NULL,
	`new_status` text NOT NULL,
	`changed_by` text NOT NULL,
	`reason` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_status_history_user_created` ON `user_status_history` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_status_history_changed_by` ON `user_status_history` (`changed_by`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`role` text DEFAULT 'USER' NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`media_permission` integer DEFAULT false NOT NULL,
	`email_notify_on_message` integer DEFAULT true NOT NULL,
	`rejection_reason` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_seen_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `idx_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `idx_users_status` ON `users` (`status`);--> statement-breakpoint
CREATE INDEX `idx_users_role` ON `users` (`role`);--> statement-breakpoint
CREATE INDEX `idx_users_status_created` ON `users` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_users_last_seen` ON `users` (`last_seen_at`);