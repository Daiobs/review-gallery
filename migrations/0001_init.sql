-- Review Outpost v4 initial D1 schema
CREATE TABLE IF NOT EXISTS batches (
  batch_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  pushed_count INTEGER NOT NULL DEFAULT 0,
  review_done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  previews_purged_at TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS verdicts (
  item_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  batch_id TEXT NOT NULL,
  filename TEXT,
  width INTEGER,
  height INTEGER,
  pushed_at TEXT NOT NULL,
  tier INTEGER CHECK (tier IN (1, 2, 3) OR tier IS NULL),
  flags_json TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  judged_at TEXT,
  PRIMARY KEY (item_id, round)
);

CREATE INDEX IF NOT EXISTS idx_verdicts_batch_id ON verdicts(batch_id);
CREATE INDEX IF NOT EXISTS idx_batches_created_at ON batches(created_at);
