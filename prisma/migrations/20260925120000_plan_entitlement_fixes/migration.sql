-- Plans & Billing QA fixes (2026-09-25).
--
-- AppSettings.isPartnerDevelopment lets every entitlement gate honour the free
-- Growth access that Shopify Partner development stores are promised. It
-- defaults to false and is filled in on the next token exchange.
ALTER TABLE `AppSettings` ADD COLUMN `isPartnerDevelopment` BOOLEAN NOT NULL DEFAULT false;

-- RestorePoint.source tells automatic snapshots apart from the merchant's own,
-- so only automatic ones are rotated out to keep a store within its plan's
-- restore-point allowance. Existing rows are classified by the names the
-- automatic paths have always used; everything else stays MANUAL, which is the
-- safe default because MANUAL points are never deleted to make room.
ALTER TABLE `RestorePoint` ADD COLUMN `source` VARCHAR(20) NOT NULL DEFAULT 'MANUAL';

UPDATE `RestorePoint` SET `source` = 'SCHEDULED' WHERE `name` LIKE 'Automated % Backup - %';
UPDATE `RestorePoint` SET `source` = 'BASELINE' WHERE `name` = 'Initial Store Setup Baseline';
UPDATE `RestorePoint` SET `source` = 'THEME_PUBLISH' WHERE `name` LIKE 'Auto Snapshot: Theme Published%';
UPDATE `RestorePoint` SET `source` = 'PRE_RESTORE' WHERE `name` LIKE 'Pre-Rollback Safety Snapshot%';
