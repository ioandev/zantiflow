-- CreateTable
CREATE TABLE `PaneActivity` (
    `machineId` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `activity` JSON NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PaneActivity_accountId_idx`(`accountId`),
    PRIMARY KEY (`machineId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
