-- AlterTable
ALTER TABLE `AppSettings` ADD COLUMN `planId` VARCHAR(50) NOT NULL DEFAULT 'free';

-- CreateTable
CREATE TABLE `SupportTicket` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `subject` VARCHAR(500) NOT NULL,
    `category` VARCHAR(100) NOT NULL DEFAULT 'General',
    `message` LONGTEXT NOT NULL,
    `email` VARCHAR(255) NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'OPEN',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SupportTicket_shop_idx`(`shop`),
    INDEX `SupportTicket_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
