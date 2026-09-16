-- VIP tier on the existing per-store discount. Existing grants stay STANDARD.
ALTER TABLE `StoreDiscount`
  ADD COLUMN `tier` VARCHAR(20) NOT NULL DEFAULT 'STANDARD';

-- Platform-wide operator settings: the global yearly discount and the
-- free-Growth promotion. Single row, always id = 1.
CREATE TABLE `PlatformSettings` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `globalDiscountPercent` INTEGER NULL,
    `globalDiscountNote` VARCHAR(500) NULL,
    `globalDiscountActive` BOOLEAN NOT NULL DEFAULT false,
    `globalDiscountExpiresAt` DATETIME(3) NULL,
    `freeGrowthEnabled` BOOLEAN NOT NULL DEFAULT true,
    `freeGrowthSeatLimit` INTEGER NOT NULL DEFAULT 20,
    `updatedByEmail` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Seats in the free-Growth promotion. Released (row deleted) on uninstall.
CREATE TABLE `FreeGrowthGrant` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `grantedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `FreeGrowthGrant_shop_key`(`shop`),
    INDEX `FreeGrowthGrant_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
