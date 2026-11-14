import type { BatchRow, Env } from "./types.js";
import { buildBatchR2Prefix, deleteR2Prefix } from "./utils.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const PREVIEW_TTL_MS = 7 * DAY_MS;
const D1_RETENTION_TTL_MS = 30 * DAY_MS;

export interface CleanupSummary {
  purged_previews_batches: string[];
  deleted_expired_batches: string[];
  deleted_r2_objects: number;
}

/**
 * Daily Cron cleanup:
 * - Batches with `created_at <= now - 30 days`: delete R2 objects + delete `verdicts` & `batches` from D1.
 * - Batches with `created_at <= now - 7 days` and `previews_purged_at IS NULL`:
 *   delete R2 objects under `previews/<agent_id>/<batch_id>/` and set `previews_purged_at = nowIso` (keeping D1 verdicts).
 */
export async function runCleanup(env: Env, now: Date = new Date()): Promise<CleanupSummary> {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const cutoff7dMs = nowMs - PREVIEW_TTL_MS;
  const cutoff30dMs = nowMs - D1_RETENTION_TTL_MS;

  const { results: batches } = await env.DB.prepare(
    "SELECT * FROM batches ORDER BY created_at ASC"
  ).all<BatchRow>();

  const purgedPreviewsBatches: string[] = [];
  const deletedExpiredBatches: string[] = [];
  let deletedR2Objects = 0;

  for (const batch of batches) {
    const createdMs = Date.parse(batch.created_at);
    if (Number.isNaN(createdMs)) {
      continue;
    }

    if (createdMs <= cutoff30dMs) {
      const prefix = buildBatchR2Prefix(batch.agent_id, batch.batch_id);
      deletedR2Objects += await deleteR2Prefix(env.PREVIEWS_BUCKET, prefix);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM verdicts WHERE batch_id = ?").bind(batch.batch_id),
        env.DB.prepare("DELETE FROM batches WHERE batch_id = ?").bind(batch.batch_id),
      ]);
      deletedExpiredBatches.push(batch.batch_id);
      continue;
    }

    if (createdMs <= cutoff7dMs && (batch.previews_purged_at === null || batch.previews_purged_at === "")) {
      const prefix = buildBatchR2Prefix(batch.agent_id, batch.batch_id);
      deletedR2Objects += await deleteR2Prefix(env.PREVIEWS_BUCKET, prefix);
      await env.DB.prepare("UPDATE batches SET previews_purged_at = ? WHERE batch_id = ?")
        .bind(nowIso, batch.batch_id)
        .run();
      purgedPreviewsBatches.push(batch.batch_id);
    }
  }

  return {
    purged_previews_batches: purgedPreviewsBatches,
    deleted_expired_batches: deletedExpiredBatches,
    deleted_r2_objects: deletedR2Objects,
  };
}
