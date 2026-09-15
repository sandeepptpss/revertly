-- Adds the missing LOW severity alert toggle.
--
-- Detection rules have always allowed a severity of LOW, but AppSettings had
-- no matching column, so LOW incidents were silently dropped before any alert
-- was sent. Defaults to false to preserve existing (silent) behaviour until a
-- merchant opts in from Settings.
ALTER TABLE `AppSettings` ADD COLUMN `alertOnLow` BOOLEAN NOT NULL DEFAULT false;
