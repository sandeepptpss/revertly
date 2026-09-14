-- CreateTable
CREATE TABLE `Session` (
    `id` VARCHAR(255) NOT NULL,
    `shop` VARCHAR(255) NOT NULL,
    `state` VARCHAR(255) NOT NULL,
    `isOnline` BOOLEAN NOT NULL DEFAULT false,
    `scope` TEXT,
    `expires` DATETIME(3),
    `accessToken` TEXT NOT NULL,
    `userId` BIGINT,
    `firstName` VARCHAR(255),
    `lastName` VARCHAR(255),
    `email` VARCHAR(255),
    `accountOwner` BOOLEAN NOT NULL DEFAULT false,
    `locale` VARCHAR(100),
    `collaborator` BOOLEAN DEFAULT false,
    `emailVerified` BOOLEAN DEFAULT false,
    `refreshToken` TEXT,
    `refreshTokenExpires` DATETIME(3),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
