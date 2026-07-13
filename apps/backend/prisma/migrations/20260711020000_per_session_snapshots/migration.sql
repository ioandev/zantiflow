-- Per-session snapshots + pane activity (ADR-0008). Zellij delivers only the current session to a
-- plugin, so each Zellij session's plugin instance reports just its own session; the machine view is
-- the UNION of its sessions on read, keyed by (machineId, sid). Existing rows are ephemeral,
-- latest-only telemetry (regenerated every second), so we clear them before repartitioning the PK.

DELETE FROM `Snapshot`;
ALTER TABLE `Snapshot`
    DROP PRIMARY KEY,
    ADD COLUMN `sid` VARCHAR(191) NOT NULL,
    ADD PRIMARY KEY (`machineId`, `sid`);
CREATE INDEX `Snapshot_machineId_receivedAt_idx` ON `Snapshot`(`machineId`, `receivedAt`);

DELETE FROM `PaneActivity`;
ALTER TABLE `PaneActivity`
    DROP PRIMARY KEY,
    ADD COLUMN `sid` VARCHAR(191) NOT NULL,
    ADD PRIMARY KEY (`machineId`, `sid`);
