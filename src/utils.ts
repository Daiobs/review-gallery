import { computeBatchCounts, isItemJudged, parseFlagsJson, resolveDisposition } from "./buckets.js";
import type {
  AgentBatchSummary,
  BatchRow,
  BatchSummary,
  BatchType,
  ChannelSummary,
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

export function defaultSourceForAgent(agentId: string): string {
  if (agentId === "muse-main") {
    return "museai";
  }
  if (agentId === "argon-mac") {
    return "gallery";
  }
  return agentId;
}

export function resolveSourceInput(
  rawSource: unknown,
  agentId: string
): { ok: true; value: string; explicit: boolean } | { ok: false; message: string } {
  if (rawSource === undefined || rawSource === null) {
    return { ok: true, value: defaultSourceForAgent(agentId), explicit: false };
  }
  if (typeof rawSource !== "string") {
    return { ok: false, message: "source must be a string" };
  }
  const trimmed = rawSource.trim();
  if (trimmed === "") {
    return { ok: true, value: defaultSourceForAgent(agentId), explicit: false };
  }
  if (!isSafeId(trimmed)) {
    return { ok: false, message: "Invalid source slug" };
  }
  return { ok: true, value: trimmed, explicit: true };
}

export function resolveLineInput(
  rawLine: unknown
): { ok: true; value: string | null; explicit: boolean } | { ok: false; message: string } {
  if (rawLine === undefined) {
    return { ok: true, value: null, explicit: false };
  }
  if (rawLine === null) {
    return { ok: true, value: null, explicit: true };
  }
  if (typeof rawLine !== "string") {
    return { ok: false, message: "line must be a string or null" };
  }
  const trimmed = rawLine.trim();
  if (trimmed === "") {
    return { ok: true, value: null, explicit: false };
  }
  if (!isSafeId(trimmed)) {
    return { ok: false, message: "Invalid line slug" };
  }
  return { ok: true, value: trimmed, explicit: true };
}

const BATCH_TYPE_ALIASES: Record<string, BatchType> = {
  artwork: "artwork",
  face: "face",
  outfit: "outfit",
  成图: "artwork",
  脸模: "face",
  服装: "outfit",
};

export function resolveBatchTypeInput(
  rawBatchType: unknown
): { ok: true; value: BatchType; explicit: boolean } | { ok: false; message: string } {
  if (rawBatchType === undefined || rawBatchType === null) {
    return { ok: true, value: "artwork", explicit: false };
  }
  if (typeof rawBatchType !== "string") {
    return { ok: false, message: "batch_type must be artwork, face, or outfit" };
  }
  const trimmed = rawBatchType.trim();
  if (trimmed === "") {
    return { ok: true, value: "artwork", explicit: false };
  }
  const key = /^[A-Za-z]+$/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
  const mapped = BATCH_TYPE_ALIASES[key];
  if (!mapped) {
    return {
      ok: false,
      message: `Invalid batch_type '${trimmed}': expected artwork, face, or outfit`,
    };
  }
  return { ok: true, value: mapped, explicit: true };
}

export function normalizeBatchTypeFromDb(raw: string | null | undefined): BatchType {
  if (!raw) {
    return "artwork";
  }
  const mapped = BATCH_TYPE_ALIASES[raw] ?? BATCH_TYPE_ALIASES[raw.toLowerCase()];
  return mapped ?? "artwork";
}

export function normalizeBatchSourceLine(batch: BatchRow): {
  source: string;
  line: string | null;
  channel_id: string;
  batch_type: BatchType;
} {
  const source =
    typeof batch.source === "string" && batch.source.trim() !== ""
      ? batch.source.trim()
      : defaultSourceForAgent(batch.agent_id);
  const line =
    typeof batch.line === "string" && batch.line.trim() !== "" ? batch.line.trim() : null;
  const channel_id = line !== null ? `${source}-${line}` : source;
  const batch_type = normalizeBatchTypeFromDb(batch.batch_type);
  return { source, line, channel_id, batch_type };
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

/**
 * Strictly preserves `tier = 0` (`☆ 收藏 / 留样`)!
 */
export function normalizeTierFromDb(rawTier: number | null | undefined): TierValue {
  if (rawTier === null || rawTier === undefined) {
    return null;
  }
  const num = Number(rawTier);
  if (num === 0 || num === 1 || num === 2 || num === 3) {
    return num;
  }
  return null;
}

export function buildReviewItemView(row: VerdictRow): ReviewItemView {
  const tier = normalizeTierFromDb(row.tier);
  const flags = parseFlagsJson(row.flags_json);
  const note = row.note ?? "";
  const round = Number(row.round);
  const { destination, redraw } = resolveDisposition(tier, flags);
  const parentItemId =
    typeof row.parent_item_id === "string" && row.parent_item_id.trim() !== ""
      ? row.parent_item_id
      : null;

  return {
    item_id: row.item_id,
    round,
    batch_id: row.batch_id,
    filename: row.filename ?? null,
    width: row.width === null || row.width === undefined ? null : Number(row.width),
    height: row.height === null || row.height === undefined ? null : Number(row.height),
    parent_item_id: parentItemId,
    pushed_at: row.pushed_at,
    tier,
    flags,
    note,
    judged_at: row.judged_at ?? null,
    destination,
    redraw,
    preview_url: `/api/review/previews/${encodeURIComponent(row.batch_id)}/${encodeURIComponent(row.item_id)}/${round}`,
  };
}

export function buildBatchSummary(
  batch: BatchRow,
  verdictRows: readonly VerdictRow[]
): BatchSummary {
  let judgedCount = 0;
  const parsedItems = verdictRows.map((row) => {
    const tier = normalizeTierFromDb(row.tier);
    const flags = parseFlagsJson(row.flags_json);
    const note = row.note ?? "";
    if (isItemJudged(tier, flags, note)) {
      judgedCount += 1;
    }
    return { tier, flags };
  });

  const pushedCount = Number(batch.pushed_count);
  const counts = computeBatchCounts(parsedItems, pushedCount);
  const { source, line, channel_id, batch_type } = normalizeBatchSourceLine(batch);

  return {
    batch_id: batch.batch_id,
    agent_id: batch.agent_id,
    source,
    line,
    channel_id,
    batch_type,
    pushed_count: pushedCount,
    judged_count: judgedCount,
    review_done: Boolean(Number(batch.review_done)),
    review_done_at: batch.review_done_at ?? null,
    created_at: batch.created_at,
    previews_purged_at: batch.previews_purged_at ?? null,
    counts,
  };
}

export function buildAgentBatchSummary(batch: BatchRow): AgentBatchSummary {
  const { source, line, channel_id, batch_type } = normalizeBatchSourceLine(batch);
  return {
    batch_id: batch.batch_id,
    agent_id: batch.agent_id,
    source,
    line,
    channel_id,
    batch_type,
    pushed_count: Number(batch.pushed_count),
    review_done: Boolean(Number(batch.review_done)),
    review_done_at: batch.review_done_at ?? null,
    created_at: batch.created_at,
  };
}

export function buildChannelsSummary(allBatches: readonly BatchSummary[]): ChannelSummary[] {
  const byChannel = new Map<string, ChannelSummary>();

  for (const b of allBatches) {
    const existing = byChannel.get(b.channel_id);
    if (existing) {
      existing.total_batches += 1;
      if (!b.review_done) {
        existing.pending_batches += 1;
      }
    } else {
      byChannel.set(b.channel_id, {
        channel_id: b.channel_id,
        source: b.source,
        line: b.line,
        total_batches: 1,
        pending_batches: b.review_done ? 0 : 1,
      });
    }
  }

  return Array.from(byChannel.values()).sort((a, b) =>
    a.channel_id.localeCompare(b.channel_id)
  );
}
