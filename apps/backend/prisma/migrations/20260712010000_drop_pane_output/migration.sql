-- Pane output is no longer persisted (ADR-0032, superseding ADR-0030's DB storage). Captured terminal
-- content is now relayed purely through the backend's in-process memory (src/output/store.ts) and never
-- written to the database. Drop the table that used to hold it. The request lifecycle stays in
-- `OutputRequest` (no terminal content).
DROP TABLE IF EXISTS `PaneOutput`;
