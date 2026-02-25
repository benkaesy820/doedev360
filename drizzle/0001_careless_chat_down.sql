DROP TABLE IF EXISTS `direct_message_reactions`;
DROP TABLE IF EXISTS `internal_message_reactions`;

CREATE INDEX `idx_ann_reactions_announcement` ON `announcement_reactions` (`announcement_id`);
CREATE INDEX `idx_announcement_votes_announcement` ON `announcement_votes` (`announcement_id`);
CREATE INDEX `idx_message_reactions_message` ON `message_reactions` (`message_id`);

ALTER TABLE `direct_messages` DROP COLUMN `reply_to_id`;
ALTER TABLE `direct_messages` DROP COLUMN `hidden_for`;
ALTER TABLE `internal_messages` DROP COLUMN `reply_to_id`;
ALTER TABLE `messages` DROP COLUMN `hidden_for`;
