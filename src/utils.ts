import { computeBatchCounts, isItemJudged, parseFlagsJson, resolveBucket } from "./buckets.js";
import type {
  BatchRow,
  BatchSummary,
  R2Bucket,
  ReviewItemView,
  TierValue,
  VerdictRow,
} from "./types.js";

const SAFE_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeId(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (!SAFE_ID_REGEX.test(value)) {
    return false;
  }
  if (value.includes("..") || value.includes("/") || value.includes("\\")) {
    return false;
  }
  return true;
}

export function parsePositiveInt(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1 ? value : null;
  }
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
  }
  return null;
}

export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function jsonResponse(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(body), { status, headers });
}

export function buildPreviewR2Key(
  agentId: string,
  batchId: string,
  itemId: string,
  round: number
): string {
  return `previews/${agentId}/${batchId}/${itemId}_r${round}.webp`;
}

export function buildBatchR2Prefix(agentId: string, batchId: string): string {
  return `previews/${agentId}/${batchId}/`;
}

/**
 * Delete all R2 objects under a prefix, handling pagination (`truncated` / `cursor`).
 */
export async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined = undefined;

  while (true) {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = listed.objects.map((obj) => obj.key);
    if (keys.length > 0) {
      await bucket.delete(keys);
      deleted += keys.length;
    }
    if (!listed.truncated || !listed.cursor) {
      break;
    }
    cursor = listed.cursor;
  }

  return deleted;
}

export function normalizeTierFromDb(rawTier: number | null | undefined): TierValue {
  if (rawTier === 1 || rawTier === 2 || rawTier === 3) {
    return rawTier;
  }
  return null;
}

export function buildReviewItemView(row: VerdictRow): ReviewItemView {
  const tier = normalizeTierFromDb(row.tier === null ? null : Number(row.tier));
  const flags = parseFlagsJson(row.flags_json);
  const note = row.note ?? "";
  const round = Number(row.round);
  const bucket = resolveBucket(tier, flags);
  return {
    item_id: row.item_id,
    round,
    batch_id: row.batch_id,
    filename: row.filename ?? null,
    width: row.width === null || row.width === undefined ? null : Number(row.width),
    height: row.height === null || row.height === undefined ? null : Number(row.height),
    pushed_at: row.pushed_at,
    tier,
    flags,
    note,
    judged_at: row.judged_at ?? null,
    bucket,
    preview_url: `/api/review/previews/${encodeURIComponent(row.batch_id)}/${encodeURIComponent(row.item_id)}/${round}`,
  };
}

export function buildBatchSummary(batch: BatchRow, verdictRows: readonly VerdictRow[]): BatchSummary {
  let judgedCount = 0;
  const parsedItems = verdictRows.map((row) => {
    const tier = normalizeTierFromDb(row.tier === null ? null : Number(row.tier));
    const flags = parseFlagsJson(row.flags_json);
    const note = row.note ?? "";
    if (isItemJudged(tier, flags, note)) {
      judgedCount += 1;
    }
    return { tier, flags };
  });

  const pushedCount = Number(batch.pushed_count);
  const counts = computeBatchCounts(parsedItems, pushedCount);

  return {
    batch_id: batch.batch_id,
    agent_id: batch.agent_id,
    pushed_count: pushedCount,
    judged_count: judgedCount,
    review_done: Boolean(Number(batch.review_done)),
    created_at: batch.created_at,
    previews_purged_at: batch.previews_purged_at ?? null,
    counts,
  };
}
