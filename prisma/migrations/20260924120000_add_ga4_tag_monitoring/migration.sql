-- GA4 / Google Tag Manager tag health monitoring (app/ga4Monitor.server.js).
--
-- Every column is nullable with no default, so existing rows and every
-- existing query are untouched: a NULL ga4Status simply means the store has
-- not been checked yet, and a NULL ga4NextCheckAt makes it due on the next
-- background sweep.
--
-- ga4AlertedAt vs ga4LastDetectedAt is what limits missing-tag alerts to one
-- per loss: an alert is only sent while ga4AlertedAt is older than the last
-- time the tag was seen on the live storefront.
ALTER TABLE `AppSettings` ADD COLUMN `ga4AlertedAt` DATETIME(3) NULL,
    ADD COLUMN `ga4DetectedIn` VARCHAR(20) NULL,
    ADD COLUMN `ga4LastCheckedAt` DATETIME(3) NULL,
    ADD COLUMN `ga4LastDetectedAt` DATETIME(3) NULL,
    ADD COLUMN `ga4MeasurementId` VARCHAR(255) NULL,
    ADD COLUMN `ga4NextCheckAt` DATETIME(3) NULL,
    ADD COLUMN `ga4Status` VARCHAR(20) NULL,
    ADD COLUMN `ga4StatusDetail` VARCHAR(500) NULL,
    ADD COLUMN `gtmContainerId` VARCHAR(255) NULL;
