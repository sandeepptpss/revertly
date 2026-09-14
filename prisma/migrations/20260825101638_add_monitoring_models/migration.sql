-- CreateTable
CREATE TABLE `ProductSnapshot` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `productId` VARCHAR(255) NOT NULL,
    `title` VARCHAR(500) NOT NULL,
    `status` VARCHAR(50) NOT NULL,
    `vendor` VARCHAR(255) NULL,
    `productType` VARCHAR(255) NULL,
    `tags` TEXT NULL,
    `bodyHtml` LONGTEXT NULL,
    `handle` VARCHAR(255) NULL,
    `publishedAt` DATETIME(3) NULL,
    `snapshotData` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ProductSnapshot_shop_idx`(`shop`),
    UNIQUE INDEX `ProductSnapshot_shop_productId_key`(`shop`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ChangeEvent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `productId` VARCHAR(255) NOT NULL,
    `productTitle` VARCHAR(500) NOT NULL,
    `fieldName` VARCHAR(255) NOT NULL,
    `variantId` VARCHAR(255) NULL,
    `oldValue` LONGTEXT NULL,
    `newValue` LONGTEXT NULL,
    `changedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `incidentId` INTEGER NULL,

    INDEX `ChangeEvent_shop_idx`(`shop`),
    INDEX `ChangeEvent_productId_idx`(`productId`),
    INDEX `ChangeEvent_changedAt_idx`(`changedAt`),
    INDEX `ChangeEvent_incidentId_idx`(`incidentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Incident` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `name` VARCHAR(500) NOT NULL,
    `severity` VARCHAR(50) NOT NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'OPEN',
    `affectedCount` INTEGER NOT NULL DEFAULT 0,
    `triggeredRuleId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolvedAt` DATETIME(3) NULL,
    `notes` TEXT NULL,

    INDEX `Incident_shop_idx`(`shop`),
    INDEX `Incident_status_idx`(`status`),
    INDEX `Incident_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DetectionRule` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `field` VARCHAR(100) NOT NULL,
    `condition` VARCHAR(100) NOT NULL,
    `threshold` DOUBLE NULL,
    `minProducts` INTEGER NULL,
    `windowMinutes` INTEGER NULL DEFAULT 10,
    `severity` VARCHAR(50) NOT NULL DEFAULT 'HIGH',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `DetectionRule_shop_isActive_idx`(`shop`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RollbackJob` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `incidentId` INTEGER NULL,
    `restorePointId` INTEGER NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    `totalProducts` INTEGER NOT NULL DEFAULT 0,
    `processedCount` INTEGER NOT NULL DEFAULT 0,
    `successCount` INTEGER NOT NULL DEFAULT 0,
    `failedCount` INTEGER NOT NULL DEFAULT 0,
    `fieldsToRestore` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,

    INDEX `RollbackJob_shop_idx`(`shop`),
    INDEX `RollbackJob_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RollbackResult` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `rollbackJobId` INTEGER NOT NULL,
    `productId` VARCHAR(255) NOT NULL,
    `productTitle` VARCHAR(500) NOT NULL,
    `status` VARCHAR(50) NOT NULL,
    `errorMessage` TEXT NULL,
    `restoredFields` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `RollbackResult_rollbackJobId_idx`(`rollbackJobId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RestorePoint` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `name` VARCHAR(500) NOT NULL,
    `description` TEXT NULL,
    `productCount` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(50) NOT NULL DEFAULT 'CREATING',
    `snapshotData` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `RestorePoint_shop_idx`(`shop`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AppSettings` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `alertEmail` VARCHAR(255) NULL,
    `alertOnCritical` BOOLEAN NOT NULL DEFAULT true,
    `alertOnHigh` BOOLEAN NOT NULL DEFAULT true,
    `alertOnMedium` BOOLEAN NOT NULL DEFAULT false,
    `monitoringEnabled` BOOLEAN NOT NULL DEFAULT true,
    `bulkThreshold` INTEGER NOT NULL DEFAULT 20,
    `bulkWindowMinutes` INTEGER NOT NULL DEFAULT 10,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AppSettings_shop_key`(`shop`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ChangeEvent` ADD CONSTRAINT `ChangeEvent_incidentId_fkey` FOREIGN KEY (`incidentId`) REFERENCES `Incident`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Incident` ADD CONSTRAINT `Incident_triggeredRuleId_fkey` FOREIGN KEY (`triggeredRuleId`) REFERENCES `DetectionRule`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RollbackJob` ADD CONSTRAINT `RollbackJob_incidentId_fkey` FOREIGN KEY (`incidentId`) REFERENCES `Incident`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RollbackJob` ADD CONSTRAINT `RollbackJob_restorePointId_fkey` FOREIGN KEY (`restorePointId`) REFERENCES `RestorePoint`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RollbackResult` ADD CONSTRAINT `RollbackResult_rollbackJobId_fkey` FOREIGN KEY (`rollbackJobId`) REFERENCES `RollbackJob`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
