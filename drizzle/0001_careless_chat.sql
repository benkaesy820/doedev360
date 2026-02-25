CREATE TABLE `direct_message_reactions` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `direct_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_dm_reactions_user` ON `direct_message_reactions` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_dm_reaction` ON `direct_message_reactions` (`message_id`,`user_id`,`emoji`);--> statement-breakpoint
CREATE TABLE `internal_message_reactions` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `internal_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_internal_reactions_user` ON `internal_message_reactions` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_internal_reaction` ON `internal_message_reactions` (`message_id`,`user_id`,`emoji`);--> statement-breakpoint
DROP INDEX `idx_ann_reactions_announcement`;--> statement-breakpoint
DROP INDEX `idx_announcement_votes_announcement`;--> statement-breakpoint
DROP INDEX `idx_message_reactions_message`;--> statement-breakpoint
ALTER TABLE `direct_messages` ADD `reply_to_id` text REFERENCES direct_messages(id);--> statement-breakpoint
ALTER TABLE `direct_messages` ADD `hidden_for` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_dm_reply_to` ON `direct_messages` (`reply_to_id`);--> statement-breakpoint
ALTER TABLE `internal_messages` ADD `reply_to_id` text REFERENCES internal_messages(id);--> statement-breakpoint
CREATE INDEX `idx_internal_messages_reply_to` ON `internal_messages` (`reply_to_id`);--> statement-breakpoint
ALTER TABLE `messages` ADD `hidden_for` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_messages_reply_to` ON `messages` (`reply_to_id`);