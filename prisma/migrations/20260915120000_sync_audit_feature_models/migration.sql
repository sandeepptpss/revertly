-- AlterTable
ALTER TABLE `AppSettings` ADD COLUMN `autoBackupSchedule` VARCHAR(50) NOT NULL DEFAULT 'DAILY',
    ADD COLUMN `autoBackupTime` VARCHAR(10) NOT NULL DEFAULT '02:00',
    ADD COLUMN `circuitBreakerAction` VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
    ADD COLUMN `circuitBreakerEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `circuitBreakerThreshold` INTEGER NOT NULL DEFAULT 50,
    ADD COLUMN `cloudSyncAccessToken` TEXT NULL,
    ADD COLUMN `cloudSyncAutoUpload` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `cloudSyncConnected` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `cloudSyncEmail` VARCHAR(255) NULL,
    ADD COLUMN `cloudSyncFolder` VARCHAR(255) NOT NULL DEFAULT 'Revertly_Backups',
    ADD COLUMN `cloudSyncProvider` VARCHAR(50) NOT NULL DEFAULT 'NONE',
    ADD COLUMN `cloudSyncRefreshToken` TEXT NULL,
    ADD COLUMN `cloudSyncTokenExpiry` DATETIME(3) NULL,
    ADD COLUMN `hasUsedTrial` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `lastAutoBackupAt` DATETIME(3) NULL,
    ADD COLUMN `nextAutoBackupAt` DATETIME(3) NULL,
    ADD COLUMN `productLimitReachedAt` DATETIME(3) NULL,
    ADD COLUMN `slackWebhookUrl` VARCHAR(500) NULL,
    ADD COLUMN `subscriptionId` VARCHAR(255) NULL,
    ADD COLUMN `trialEndsAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `ProductSnapshot` ADD COLUMN `deletedAt` DATETIME(3) NULL,
    ADD COLUMN `isDeleted` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `RestorePoint` ADD COLUMN `articleCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `articleData` JSON NULL,
    ADD COLUMN `backupType` VARCHAR(50) NOT NULL DEFAULT 'FULL',
    ADD COLUMN `cloudProvider` VARCHAR(50) NULL,
    ADD COLUMN `cloudSyncStatus` VARCHAR(50) NOT NULL DEFAULT 'NOT_SYNCED',
    ADD COLUMN `cloudSyncedAt` DATETIME(3) NULL,
    ADD COLUMN `collectionCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `collectionData` JSON NULL,
    ADD COLUMN `customerCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `customerData` JSON NULL,
    ADD COLUMN `menuCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `menuData` JSON NULL,
    ADD COLUMN `orderCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `orderData` JSON NULL,
    ADD COLUMN `pageCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `pageData` JSON NULL,
    ADD COLUMN `themeCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `themeData` JSON NULL;

-- AlterTable
ALTER TABLE `SupportTicket` ADD COLUMN `isEmergency` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `planTier` VARCHAR(50) NULL,
    ADD COLUMN `priority` VARCHAR(50) NOT NULL DEFAULT 'NORMAL';

-- CreateTable
CREATE TABLE `OrderArchive` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `orderId` VARCHAR(255) NOT NULL,
    `orderNumber` VARCHAR(100) NOT NULL,
    `customerEmail` VARCHAR(255) NULL,
    `customerName` VARCHAR(255) NULL,
    `totalPrice` VARCHAR(50) NOT NULL,
    `currency` VARCHAR(10) NOT NULL DEFAULT 'USD',
    `financialStatus` VARCHAR(50) NULL,
    `fulfillmentStatus` VARCHAR(50) NULL,
    `processedAt` DATETIME(3) NULL,
    `orderData` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `OrderArchive_shop_orderNumber_idx`(`shop`, `orderNumber`),
    INDEX `OrderArchive_shop_customerEmail_idx`(`shop`, `customerEmail`),
    INDEX `OrderArchive_shop_processedAt_idx`(`shop`, `processedAt`),
    UNIQUE INDEX `OrderArchive_shop_orderId_key`(`shop`, `orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CustomerArchive` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `customerId` VARCHAR(255) NOT NULL,
    `email` VARCHAR(255) NULL,
    `firstName` VARCHAR(255) NULL,
    `lastName` VARCHAR(255) NULL,
    `phone` VARCHAR(100) NULL,
    `ordersCount` INTEGER NOT NULL DEFAULT 0,
    `totalSpent` VARCHAR(50) NULL,
    `customerData` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CustomerArchive_shop_email_idx`(`shop`, `email`),
    UNIQUE INDEX `CustomerArchive_shop_customerId_key`(`shop`, `customerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TeamMember` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `name` VARCHAR(255) NULL,
    `role` VARCHAR(50) NOT NULL DEFAULT 'ADMIN',
    `status` VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    `alertsEnabled` BOOLEAN NOT NULL DEFAULT true,
    `lastActiveAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `TeamMember_shop_idx`(`shop`),
    UNIQUE INDEX `TeamMember_shop_email_key`(`shop`, `email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuditLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `userEmail` VARCHAR(255) NULL,
    `userName` VARCHAR(255) NULL,
    `action` VARCHAR(100) NOT NULL,
    `resourceType` VARCHAR(100) NULL,
    `resourceId` VARCHAR(255) NULL,
    `details` JSON NULL,
    `ipAddress` VARCHAR(100) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AuditLog_shop_idx`(`shop`),
    INDEX `AuditLog_shop_action_idx`(`shop`, `action`),
    INDEX `AuditLog_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MonitoredService` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `serviceType` VARCHAR(50) NOT NULL DEFAULT 'STOREFRONT',
    `url` VARCHAR(500) NOT NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'OPERATIONAL',
    `uptimePercent` DOUBLE NOT NULL DEFAULT 100.0,
    `lastResponseTimeMs` INTEGER NULL,
    `lastStatusCode` INTEGER NULL,
    `lastCheckAt` DATETIME(3) NULL,
    `checkIntervalMinutes` INTEGER NOT NULL DEFAULT 5,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `MonitoredService_shop_idx`(`shop`),
    INDEX `MonitoredService_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DowntimeCheck` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `serviceId` INTEGER NOT NULL,
    `isUp` BOOLEAN NOT NULL DEFAULT true,
    `statusCode` INTEGER NULL,
    `responseTimeMs` INTEGER NULL,
    `errorMessage` TEXT NULL,
    `checkedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DowntimeCheck_shop_idx`(`shop`),
    INDEX `DowntimeCheck_serviceId_idx`(`serviceId`),
    INDEX `DowntimeCheck_checkedAt_idx`(`checkedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `QaTestRun` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `healthScore` INTEGER NOT NULL DEFAULT 100,
    `status` VARCHAR(50) NOT NULL DEFAULT 'PASSED',
    `summary` TEXT NULL,
    `testResults` JSON NOT NULL,
    `testedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `QaTestRun_shop_idx`(`shop`),
    INDEX `QaTestRun_testedAt_idx`(`testedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `JobLock` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `owner` VARCHAR(191) NULL,
    `lockedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `JobLock_name_key`(`name`),
    INDEX `JobLock_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `ProductSnapshot_shop_isDeleted_idx` ON `ProductSnapshot`(`shop`, `isDeleted`);

-- AddForeignKey
ALTER TABLE `DowntimeCheck` ADD CONSTRAINT `DowntimeCheck_serviceId_fkey` FOREIGN KEY (`serviceId`) REFERENCES `MonitoredService`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

