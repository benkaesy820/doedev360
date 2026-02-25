-- Partial index to serve COUNT(*) on non-deleted messages (used by stats route).
-- Without this, SQLite does a full table scan since idx_messages_conv_created
-- requires a conversation_id filter and cannot be used for global counts.
CREATE INDEX IF NOT EXISTS `idx_messages_not_deleted` ON `messages` (`id`) WHERE `deleted_at` IS NULL;
