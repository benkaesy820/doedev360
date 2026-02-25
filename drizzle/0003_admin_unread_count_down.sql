ALTER TABLE `conversations` DROP COLUMN `admin_unread_count`;
DROP INDEX IF EXISTS `idx_conversations_admin_unread`;
DROP INDEX IF EXISTS `idx_users_name`;
