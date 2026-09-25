-- Admin Panel QA follow-ups (2026-09-25).
--
-- Pending terms for re-pricing an ACTIVE Shopify-billed Custom Enterprise Plus
-- plan: the merchant keeps the terms they pay for until they approve these.
ALTER TABLE `AppSettings` ADD COLUMN `customPendingProductLimit` INTEGER NULL;
ALTER TABLE `AppSettings` ADD COLUMN `customPendingPriceAmount` INTEGER NULL;

-- Permanent record of free Growth claims, so uninstalling and reinstalling
-- cannot claim a second seat. Existing grants are carried over.
CREATE TABLE `FreeGrowthClaim` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shopHash` CHAR(64) NOT NULL,
    `claimedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `FreeGrowthClaim_shopHash_key`(`shopHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `FreeGrowthClaim` (`shopHash`, `claimedAt`)
SELECT SHA2(LOWER(TRIM(`shop`)), 256), `grantedAt` FROM `FreeGrowthGrant`;
