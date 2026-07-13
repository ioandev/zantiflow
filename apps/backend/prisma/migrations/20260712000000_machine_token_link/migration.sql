-- Link a Machine to the ingest token that last pushed for it (ADR-0003). Additive + nullable:
-- existing machines predate the link and stay NULL until their next ingest (rendered as "unlinked"
-- on the /tokens page). Enables grouping machines under the token they belong to and the combined
-- revoke + forget action. `tokenId` is derived from the auth principal, never from the wire — the
-- ingest wire contract stays v4.

ALTER TABLE `Machine` ADD COLUMN `tokenId` VARCHAR(191) NULL;
CREATE INDEX `Machine_tokenId_idx` ON `Machine`(`tokenId`);
