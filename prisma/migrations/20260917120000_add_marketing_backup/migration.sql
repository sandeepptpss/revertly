-- Email marketing (ESP) backup: Klaviyo & Mailchimp.
--
-- Credentials sit on AppSettings beside the cloud-sync tokens. Mailchimp keys
-- carry their datacenter as a "-usX" suffix, which becomes the API host, so it
-- is stored rather than re-parsed on every call.
ALTER TABLE `AppSettings`
  ADD COLUMN `klaviyoConnected` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `klaviyoApiKey` TEXT NULL,
  ADD COLUMN `klaviyoAccountName` VARCHAR(255) NULL,
  ADD COLUMN `mailchimpConnected` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `mailchimpApiKey` TEXT NULL,
  ADD COLUMN `mailchimpServerPrefix` VARCHAR(20) NULL,
  ADD COLUMN `mailchimpAccountName` VARCHAR(255) NULL,
  ADD COLUMN `marketingAutoBackup` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `lastMarketingBackupAt` DATETIME(3) NULL;

-- A Klaviyo list/segment or a Mailchimp audience/segment. Unique on
-- (shop, provider, listId) so a re-run updates in place instead of duplicating.
CREATE TABLE `MarketingList` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `provider` VARCHAR(20) NOT NULL,
    `listId` VARCHAR(255) NOT NULL,
    `name` VARCHAR(500) NOT NULL,
    `listType` VARCHAR(20) NOT NULL DEFAULT 'LIST',
    `memberCount` INTEGER NOT NULL DEFAULT 0,
    `listData` JSON NOT NULL,
    `capturedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MarketingList_shop_provider_listId_key`(`shop`, `provider`, `listId`),
    INDEX `MarketingList_shop_provider_idx`(`shop`, `provider`),
    INDEX `MarketingList_shop_listType_idx`(`shop`, `listType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- A subscriber profile. Counts against the plan's marketingProfiles cap.
CREATE TABLE `MarketingProfile` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `provider` VARCHAR(20) NOT NULL,
    `profileId` VARCHAR(255) NOT NULL,
    `email` VARCHAR(255) NULL,
    `firstName` VARCHAR(255) NULL,
    `lastName` VARCHAR(255) NULL,
    `phone` VARCHAR(100) NULL,
    `status` VARCHAR(50) NULL,
    `listIds` JSON NULL,
    `profileData` JSON NOT NULL,
    `capturedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MarketingProfile_shop_provider_profileId_key`(`shop`, `provider`, `profileId`),
    INDEX `MarketingProfile_shop_provider_idx`(`shop`, `provider`),
    INDEX `MarketingProfile_shop_email_idx`(`shop`, `email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- A Klaviyo flow or Mailchimp journey. Business and above (marketingFlows).
CREATE TABLE `MarketingFlow` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `provider` VARCHAR(20) NOT NULL,
    `flowId` VARCHAR(255) NOT NULL,
    `name` VARCHAR(500) NOT NULL,
    `status` VARCHAR(50) NULL,
    `triggerType` VARCHAR(100) NULL,
    `flowData` JSON NOT NULL,
    `capturedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MarketingFlow_shop_provider_flowId_key`(`shop`, `provider`, `flowId`),
    INDEX `MarketingFlow_shop_provider_idx`(`shop`, `provider`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
