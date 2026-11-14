import { isItemJudged, isValidTier, normalizeFlags, parseFlagsJson } from "../buckets.js";
import type { BatchRow, Env, FlagCode, TierValue, VerdictRow } from "../types.js";
import {
  buildBatchSummary,
  buildPreviewR2Key,
  buildReviewItemView,
  isSafeId,
  jsonResponse,
  normalizeTierFromDb,
  parsePositiveInt,
  withSecurityHeaders,
} from "../utils.js";

function decodeSegments(pathname: string): string[] | null {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const rawParts = trimmed.split("/");
  const decoded: string[] = [];
  for (const part of rawParts) {
    try {
      decoded.push(decodeURIComponent(part));
    } catch {
      return null;
    }
  }
  return decoded;
}

async function handleListBatches(env: Env): Promise<Response> {
  const { results: batches } = await env.DB.prepare(
    "SELECT * FROM batches ORDER BY created_at DESC, batch_id DESC"
  ).all<BatchRow>();

  if (batches.length === 0) {
    return jsonResponse({ batches: [] });
  }

  const { results: allVerdicts } = await env.DB.prepare(
    "SELECT * FROM verdicts"
  ).all<VerdictRow>();

  const verdictsByBatch = new Map<string, VerdictRow[]>();
  for (const row of allVerdicts) {
    const list = verdictsByBatch.get(row.batch_id);
    if (list) {
      list.push(row);
    } else {
      verdictsByBatch.set(row.batch_id, [row]);
    }
  }

  const summaries = batches.map((batch) =>
    buildBatchSummary(batch, verdictsByBatch.get(batch.batch_id) ?? [])
  );

  return jsonResponse({ batches: summaries });
}

async function handleGetBatchDetail(env: Env, batchId: string): Promise<Response> {
  if (!isSafeId(batchId)) {
    return jsonResponse({ error: "invalid_batch_id" }, 400);
  }

  const batch = await env.DB.prepare("SELECT * FROM batches WHERE batch_id = ?")
    .bind(batchId)
    .first<BatchRow>();

  if (!batch) {
    return jsonResponse({ error: "batch_not_found" }, 404);
  }

  const { results: verdictRows } = await env.DB.prepare(
    "SELECT * FROM verdicts WHERE batch_id = ? ORDER BY item_id ASC, round ASC"
  )
    .bind(batchId)
    .all<VerdictRow>();

  const batchSummary = buildBatchSummary(batch, verdictRows);
  const items = verdictRows.map((row) => buildReviewItemView(row));

  return jsonResponse({ batch: batchSummary, items });
}

async function handleGetPreview(
  env: Env,
  batchId: string,
  itemId: string,
  roundStr: string
): Promise<Response> {
  const round = parsePositiveInt(roundStr);
  if (!isSafeId(batchId) || !isSafeId(itemId) || round === null) {
    return jsonResponse({ error: "invalid_preview_params" }, 400);
  }

  const batch = await env.DB.prepare("SELECT * FROM batches WHERE batch_id = ?")
    .bind(batchId)
    .first<BatchRow>();

  if (!batch) {
    return jsonResponse({ error: "batch_not_found" }, 404);
  }

  const verdict = await env.DB.prepare(
    "SELECT item_id FROM verdicts WHERE batch_id = ? AND item_id = ? AND round = ?"
  )
    .bind(batchId, itemId, round)
    .first<{ item_id: string }>();

  if (!verdict) {
    return jsonResponse({ error: "item_not_found" }, 404);
  }

  const r2Key = buildPreviewR2Key(batch.agent_id, batchId, itemId, round);
  const obj = await env.PREVIEWS_BUCKET.get(r2Key);
  if (!obj) {
    return jsonResponse({ error: "preview_not_found" }, 404);
  }

  const contentType = obj.httpMetadata?.contentType || "image/webp";
  return withSecurityHeaders(
    new Response(obj.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
      },
    })
  );
}

async function handlePatchItem(
  request: Request,
  env: Env,
  batchId: string,
  itemId: string,
  roundStr: string
): Promise<Response> {
  const round = parsePositiveInt(roundStr);
  if (!isSafeId(batchId) || !isSafeId(itemId) || round === null) {
    return jsonResponse({ error: "invalid_item_params" }, 400);
  }

  const batch = await env.DB.prepare("SELECT * FROM batches WHERE batch_id = ?")
    .bind(batchId)
    .first<BatchRow>();

  if (!batch) {
    return jsonResponse({ error: "batch_not_found" }, 404);
  }

  if (Number(batch.review_done) === 1) {
    return jsonResponse({ error: "batch_locked", message: "Batch is marked review_done" }, 409);
  }

  const existingRow = await env.DB.prepare(
    "SELECT * FROM verdicts WHERE batch_id = ? AND item_id = ? AND round = ?"
  )
    .bind(batchId, itemId, round)
    .first<VerdictRow>();

  if (!existingRow) {
    return jsonResponse({ error: "item_not_found" }, 404);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ error: "invalid_body" }, 400);
  }

  const patch = body as Record<string, unknown>;

  let nextTier: TierValue = normalizeTierFromDb(
    existingRow.tier === null ? null : Number(existingRow.tier)
  );
  if ("tier" in patch && patch.tier !== undefined) {
    if (!isValidTier(patch.tier)) {
      return jsonResponse({ error: "invalid_tier", message: "tier must be 1, 2, 3, or null" }, 400);
    }
    nextTier = patch.tier;
  }

  let nextFlags: FlagCode[] = parseFlagsJson(existingRow.flags_json);
  if ("flags" in patch && patch.flags !== undefined) {
    try {
      nextFlags = normalizeFlags(patch.flags, true);
    } catch (err) {
      return jsonResponse(
        { error: "invalid_flags", message: err instanceof Error ? err.message : "Invalid flags" },
        400
      );
    }
  }

  let nextNote: string = existingRow.note ?? "";
  if ("note" in patch && patch.note !== undefined) {
    if (patch.note === null) {
      nextNote = "";
    } else if (typeof patch.note === "string") {
      if (patch.note.length > 4000) {
        return jsonResponse({ error: "note_too_long" }, 400);
      }
      nextNote = patch.note;
    } else {
      return jsonResponse({ error: "invalid_note", message: "note must be a string" }, 400);
    }
  }

  const judged = isItemJudged(nextTier, nextFlags, nextNote);
  const nextJudgedAt = judged ? new Date().toISOString() : null;
  const nextFlagsJson = JSON.stringify(nextFlags);

  await env.DB.prepare(
    "UPDATE verdicts SET tier = ?, flags_json = ?, note = ?, judged_at = ? WHERE batch_id = ? AND item_id = ? AND round = ?"
  )
    .bind(nextTier, nextFlagsJson, nextNote, nextJudgedAt, batchId, itemId, round)
    .run();

  const { results: updatedRows } = await env.DB.prepare(
    "SELECT * FROM verdicts WHERE batch_id = ? ORDER BY item_id ASC, round ASC"
  )
    .bind(batchId)
    .all<VerdictRow>();

  const updatedRow =
    updatedRows.find((r) => r.item_id === itemId && Number(r.round) === round) ?? {
      ...existingRow,
      tier: nextTier,
      flags_json: nextFlagsJson,
      note: nextNote,
      judged_at: nextJudgedAt,
    };

  const itemView = buildReviewItemView(updatedRow);
  const batchSummary = buildBatchSummary(batch, updatedRows);

  return jsonResponse({
    item: itemView,
    batch: batchSummary,
  });
}

async function handleSetReviewDone(
  request: Request,
  env: Env,
  batchId: string
): Promise<Response> {
  if (!isSafeId(batchId)) {
    return jsonResponse({ error: "invalid_batch_id" }, 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof (body as { review_done?: unknown }).review_done !== "boolean"
  ) {
    return jsonResponse(
      { error: "invalid_body", message: "Expected { review_done: boolean }" },
      400
    );
  }

  const reviewDone = (body as { review_done: boolean }).review_done;

  const batch = await env.DB.prepare("SELECT * FROM batches WHERE batch_id = ?")
    .bind(batchId)
    .first<BatchRow>();

  if (!batch) {
    return jsonResponse({ error: "batch_not_found" }, 404);
  }

  const nextFlag = reviewDone ? 1 : 0;
  await env.DB.prepare("UPDATE batches SET review_done = ? WHERE batch_id = ?")
    .bind(nextFlag, batchId)
    .run();

  const updatedBatch: BatchRow = {
    ...batch,
    review_done: nextFlag,
  };

  const { results: verdictRows } = await env.DB.prepare(
    "SELECT * FROM verdicts WHERE batch_id = ? ORDER BY item_id ASC, round ASC"
  )
    .bind(batchId)
    .all<VerdictRow>();

  const batchSummary = buildBatchSummary(updatedBatch, verdictRows);
  return jsonResponse({ batch: batchSummary });
}

export async function handleReviewRequest(request: Request, url: URL, env: Env): Promise<Response> {
  const segments = decodeSegments(url.pathname);
  if (!segments) {
    return jsonResponse({ error: "invalid_path" }, 400);
  }

  // GET /api/review/batches
  if (segments.length === 4 && segments[3] === "batches") {
    if (request.method !== "GET") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    return handleListBatches(env);
  }

  // GET /api/review/batches/:batchId
  if (segments.length === 5 && segments[3] === "batches" && segments[4]) {
    if (request.method !== "GET") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    return handleGetBatchDetail(env, segments[4]);
  }

  // POST /api/review/batches/:batchId/done
  if (segments.length === 6 && segments[3] === "batches" && segments[4] && segments[5] === "done") {
    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    return handleSetReviewDone(request, env, segments[4]);
  }

  // PATCH /api/review/batches/:batchId/items/:itemId/:round
  if (
    segments.length === 8 &&
    segments[3] === "batches" &&
    segments[4] &&
    segments[5] === "items" &&
    segments[6] &&
    segments[7]
  ) {
    if (request.method !== "PATCH") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    return handlePatchItem(request, env, segments[4], segments[6], segments[7]);
  }

  // GET /api/review/previews/:batchId/:itemId/:round
  if (
    segments.length === 7 &&
    segments[3] === "previews" &&
    segments[4] &&
    segments[5] &&
    segments[6]
  ) {
    if (request.method !== "GET") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    return handleGetPreview(env, segments[4], segments[5], segments[6]);
  }

  return jsonResponse({ error: "not_found" }, 404);
}
