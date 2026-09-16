-- Platform-admin-granted yearly discounts, one active row per merchant shop.
CREATE TABLE `StoreDiscount` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `discountPercent` INTEGER NOT NULL,
    `note` VARCHAR(500) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdByEmail` VARCHAR(255) NULL,
    `updatedByEmail` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `StoreDiscount_shop_key`(`shop`),
    INDEX `StoreDiscount_shop_isActive_idx`(`shop`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
