DROP INDEX IF EXISTS `idx_users_name`;
DROP INDEX IF EXISTS `idx_conversations_assigned_admin`;
DROP INDEX IF EXISTS `idx_conversations_admin_unread`;
ALTER TABLE `conversations` DROP COLUMN `admin_unread_count`;
CREATE INDEX `idx_conversations_assigned_admin` ON `conversations` (`assigned_admin_id`);
