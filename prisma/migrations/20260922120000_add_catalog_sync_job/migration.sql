-- CreateTable
CREATE TABLE IF NOT EXISTS `CatalogSyncJob` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    `totalEstimated` INTEGER NOT NULL DEFAULT 0,
    `processedCount` INTEGER NOT NULL DEFAULT 0,
    `currentCursor` TEXT NULL,
    `batchSize` INTEGER NOT NULL DEFAULT 50,
    `errorMessage` TEXT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CatalogSyncJob_shop_status_idx`(`shop`, `status`),
    INDEX `CatalogSyncJob_shop_createdAt_idx`(`shop`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
