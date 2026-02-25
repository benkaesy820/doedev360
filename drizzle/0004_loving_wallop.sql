DROP INDEX `idx_conversations_assigned_admin`;--> statement-breakpoint
ALTER TABLE `conversations` ADD `admin_unread_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_conversations_admin_unread` ON `conversations` (`last_message_at`) WHERE "conversations"."admin_unread_count" > 0;--> statement-breakpoint
CREATE INDEX `idx_conversations_assigned_admin` ON `conversations` (`assigned_admin_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `idx_users_name` ON `users` (`name`);