-- Review Outpost v4 upgrade migration:
-- 1) Extend batches with source, line, batch_type, review_done_at and backfill source
-- 2) Rebuild verdicts to support tier = 0, add parent_item_id, and atomically flip legacy tiers 1 <-> 3
-- NOTE: No BEGIN/COMMIT or PRAGMA foreign_keys statements (Cloudflare D1 wraps remote migrations in its own transaction).

ALTER TABLE batches ADD COLUMN source TEXT NOT NULL DEFAULT '';
ALTER TABLE batches ADD COLUMN line TEXT DEFAULT NULL;
ALTER TABLE batches ADD COLUMN batch_type TEXT NOT NULL DEFAULT 'artwork';
ALTER TABLE batches ADD COLUMN review_done_at TEXT DEFAULT NULL;

UPDATE batches
SET source = CASE agent_id
  WHEN 'muse-main' THEN 'museai'
  WHEN 'argon-mac' THEN 'gallery'
  ELSE agent_id
END
WHERE source = '';

CREATE TABLE verdicts_v4 (
  item_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  batch_id TEXT NOT NULL,
  filename TEXT,
  width INTEGER,
  height INTEGER,
  parent_item_id TEXT DEFAULT NULL,
  pushed_at TEXT NOT NULL,
  tier INTEGER CHECK (tier IN (0, 1, 2, 3) OR tier IS NULL),
  flags_json TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  judged_at TEXT,
  PRIMARY KEY (item_id, round)
);

INSERT INTO verdicts_v4 (
  item_id, round, batch_id, filename, width, height, parent_item_id,
  pushed_at, tier, flags_json, note, judged_at
)
SELECT
  item_id, round, batch_id, filename, width, height, NULL,
  pushed_at,
  CASE tier WHEN 1 THEN 3 WHEN 3 THEN 1 ELSE tier END,
  flags_json, note, judged_at
FROM verdicts;

DROP TABLE verdicts;
ALTER TABLE verdicts_v4 RENAME TO verdicts;

CREATE INDEX IF NOT EXISTS idx_verdicts_batch_id ON verdicts(batch_id);
CREATE INDEX IF NOT EXISTS idx_batches_source_line ON batches(source, line);
