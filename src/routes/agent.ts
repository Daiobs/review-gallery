import { authenticateAgent } from "../auth.js";
import { computeBatchCounts, countsMatch, parseFlagsJson } from "../buckets.js";
import type { BatchCountsPayload } from "./agent-types.js";
import type { BatchRow, BucketCounts, Env, PushManifest, VerdictRow } from "../types.js";
import {
  buildBatchR2Prefix,
  buildPreviewR2Key,
  deleteR2Prefix,
  isSafeId,
  jsonResponse,
  normalizeTierFromDb,
} from "../utils.js";

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isSafeInteger(value) && value >= 0;
}

function parseCountsObject(raw: unknown): BucketCounts | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Partial<BatchCountsPayload>;
  if (
    !isNonNegativeInt(obj.pushed) ||
    !isNonNegativeInt(obj.archived) ||
    !isNonNegativeInt(obj.repair) ||
    !isNonNegativeInt(obj.redraw) ||
    !isNonNegativeInt(obj.discarded)
  ) {
    return null;
  }
  return {
    pushed: obj.pushed,
    archived: obj.archived,
    repair: obj.repair,
    redraw: obj.redraw,
    discarded: obj.discarded,
  };
}

async function readManifestFromFormData(formData: FormData): Promise<PushManifest | null> {
  const manifestPart = formData.get("manifest");
  if (manifestPart === null) {
    return null;
  }
  let manifestText: string;
  if (typeof manifestPart === "string") {
    manifestText = manifestPart;
  } else if (manifestPart instanceof Blob) {
    manifestText = await manifestPart.text();
  } else {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(manifestText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.agent_id !== "string" ||
      typeof candidate.batch_id !== "string" ||
      !Array.isArray(candidate.items)
    ) {
      return null;
    }
    return {
      agent_id: candidate.agent_id,
      batch_id: candidate.batch_id,
      items: candidate.items as PushManifest["items"],
    };
  } catch {
    return null;
  }
}

async function handlePush(request: Request, env: Env, authenticatedAgentId: string): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ error: "invalid_multipart", message: "Expected multipart/form-data" }, 400);
  }

  const manifest = await readManifestFromFormData(formData);
  if (!manifest) {
    return jsonResponse({ error: "invalid_manifest", message: "Missing or invalid manifest JSON part" }, 400);
  }

  if (manifest.agent_id !== authenticatedAgentId) {
    return jsonResponse(
      { error: "forbidden_agent_mismatch", message: "manifest.agent_id does not match authenticated agent" },
      403
    );
  }

  const batchId = manifest.batch_id;
  if (!isSafeId(batchId)) {
    return jsonResponse({ error: "invalid_batch_id", message: "Unsafe or malformed batch_id" }, 400);
  }

  if (manifest.items.length === 0) {
    return jsonResponse({ error: "empty_items", message: "manifest.items must not be empty" }, 400);
  }

  const existingBatch = await env.DB.prepare("SELECT * FROM batches WHERE batch_id = ?")
    .bind(batchId)
    .first<BatchRow>();

  if (existingBatch) {
    if (existingBatch.agent_id !== authenticatedAgentId) {
      return jsonResponse(
        { error: "forbidden_batch_owner", message: "Batch belongs to a different agent" },
        403
      );
    }
    if (Number(existingBatch.review_done) === 1) {
      return jsonResponse(
        { error: "review_already_done", message: "Cannot push to a locked batch where review_done=1" },
        409
      );
    }
  }

  const nowIso = new Date().toISOString();
  let batchEnsured = Boolean(existingBatch);
  const accepted: string[] = [];
  const acceptedSet = new Set<string>();
  const rejected: Array<{ item_id: string; reason: string }> = [];

  for (const rawItem of manifest.items) {
    if (!rawItem || typeof rawItem !== "object") {
      rejected.push({ item_id: "", reason: "invalid_item_entry" });
      continue;
    }

    const rawItemId = (rawItem as { item_id?: unknown }).item_id;
    const itemIdStr = typeof rawItemId === "string" ? rawItemId : String(rawItemId ?? "");
    if (!isSafeId(rawItemId)) {
      rejected.push({ item_id: itemIdStr, reason: "invalid_item_id" });
      continue;
    }
    const itemId = rawItemId;

    const rawRound = (rawItem as { round?: unknown }).round;
    if (typeof rawRound !== "number" || !Number.isInteger(rawRound) || rawRound < 1) {
      rejected.push({ item_id: itemId, reason: "invalid_round" });
      continue;
    }
    const round = rawRound;

    let filename: string | null = null;
    if (rawItem.filename !== undefined && rawItem.filename !== null) {
      if (typeof rawItem.filename !== "string" || rawItem.filename.length > 512 || rawItem.filename.includes("\0")) {
        rejected.push({ item_id: itemId, reason: "invalid_filename" });
        continue;
      }
      filename = rawItem.filename;
    }

    let width: number | null = null;
    if (rawItem.width !== undefined && rawItem.width !== null) {
      if (typeof rawItem.width !== "number" || !Number.isInteger(rawItem.width) || rawItem.width < 1) {
        rejected.push({ item_id: itemId, reason: "invalid_dimensions" });
        continue;
      }
      width = rawItem.width;
    }

    let height: number | null = null;
    if (rawItem.height !== undefined && rawItem.height !== null) {
      if (typeof rawItem.height !== "number" || !Number.isInteger(rawItem.height) || rawItem.height < 1) {
        rejected.push({ item_id: itemId, reason: "invalid_dimensions" });
        continue;
      }
      height = rawItem.height;
    }

    const filePart = formData.get(itemId);
    if (!filePart || typeof filePart === "string" || !(filePart instanceof Blob)) {
      rejected.push({ item_id: itemId, reason: "missing_file_part" });
      continue;
    }

    const bytes = await filePart.arrayBuffer();
    if (bytes.byteLength === 0) {
      rejected.push({ item_id: itemId, reason: "empty_file_part" });
      continue;
    }

    const existingVerdict = await env.DB.prepare(
      "SELECT batch_id FROM verdicts WHERE item_id = ? AND round = ?"
    )
      .bind(itemId, round)
      .first<{ batch_id: string }>();

    if (existingVerdict && existingVerdict.batch_id !== batchId) {
      rejected.push({ item_id: itemId, reason: "conflict_other_batch" });
      continue;
    }

    if (!batchEnsured) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO batches (batch_id, agent_id, pushed_count, review_done, created_at, previews_purged_at) VALUES (?, ?, 0, 0, ?, NULL)"
      )
        .bind(batchId, authenticatedAgentId, nowIso)
        .run();
      batchEnsured = true;
    }

    const r2Key = buildPreviewR2Key(authenticatedAgentId, batchId, itemId, round);
    await env.PREVIEWS_BUCKET.put(r2Key, bytes, {
      httpMetadata: { contentType: "image/webp" },
    });

    await env.DB.prepare(
      `INSERT INTO verdicts (item_id, round, batch_id, filename, width, height, pushed_at, tier, flags_json, note, judged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '[]', '', NULL)
       ON CONFLICT(item_id, round) DO UPDATE SET
         filename = excluded.filename,
         width = excluded.width,
         height = excluded.height,
         pushed_at = excluded.pushed_at,
         tier = NULL,
         flags_json = '[]',
         note = '',
         judged_at = NULL`
    )
      .bind(itemId, round, batchId, filename, width, height, nowIso)
      .run();

    if (!acceptedSet.has(itemId)) {
      acceptedSet.add(itemId);
      accepted.push(itemId);
    }
  }

  let pushedCount = existingBatch ? Number(existingBatch.pushed_count) : 0;
  if (batchEnsured) {
    const countRow = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM verdicts WHERE batch_id = ?"
    )
      .bind(batchId)
      .first<{ cnt: number }>();
    pushedCount = Number(countRow?.cnt ?? 0);

    await env.DB.prepare(
      "UPDATE batches SET pushed_count = ?, previews_purged_at = NULL WHERE batch_id = ?"
    )
      .bind(pushedCount, batchId)
      .run();
  }

  return jsonResponse({
    batch_id: batchId,
    pushed_count: pushedCount,
    accepted,
    rejected,
  });
}

async function handleGetVerdicts(
  url: URL,
  env: Env,
  authenticatedAgentId: string
): Promise<Response> {
  const batchId = url.searchParams.get("batch_id");
  if (!isSafeId(batchId)) {
    return jsonResponse({ error: "invalid_batch_id", message: "Missing or invalid batch_id" }, 400);
  }

  const batch = await env.DB.prepare("SELECT * FROM batches WHERE batch_id = ?")
    .bind(batchId)
    .first<BatchRow>();

  if (!batch) {
    return jsonResponse({ error: "batch_not_found", message: "Batch not found" }, 404);
  }

  if (batch.agent_id !== authenticatedAgentId) {
    return jsonResponse(
      { error: "forbidden_batch_owner", message: "Batch belongs to a different agent" },
      403
    );
  }

  const { results: rows } = await env.DB.prepare(
    "SELECT * FROM verdicts WHERE batch_id = ? ORDER BY item_id ASC, round ASC"
  )
    .bind(batchId)
    .all<VerdictRow>();

  const items = rows.map((row) => {
    const tier = normalizeTierFromDb(row.tier === null ? null : Number(row.tier));
    const flags = parseFlagsJson(row.flags_json);
    return {
      item_id: row.item_id,
      round: Number(row.round),
      tier,
      flags,
      note: row.note ?? "",
      judged_at: row.judged_at ?? null,
    };
  });

  const counts = computeBatchCounts(items, Number(batch.pushed_count));

  return jsonResponse({
    batch_id: batch.batch_id,
    review_done: Boolean(Number(batch.review_done)),
    counts,
    items,
  });
}

async function handleAck(
  request: Request,
  env: Env,
  authenticatedAgentId: string
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json", message: "Expected JSON request body" }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ error: "invalid_body", message: "Expected JSON object" }, 400);
  }

  const rawBatchId = (body as { batch_id?: unknown }).batch_id;
  if (!isSafeId(rawBatchId)) {
    return jsonResponse({ error: "invalid_batch_id", message: "Missing or invalid batch_id" }, 400);
  }
  const receivedCounts = parseCountsObject((body as { counts?: unknown }).counts);
  if (!receivedCounts) {
    return jsonResponse({ error: "invalid_counts", message: "Missing or invalid counts object" }, 400);
  }

  const batch = await env.DB.prepare("SELECT * FROM batches WHERE batch_id = ?")
    .bind(rawBatchId)
    .first<BatchRow>();

  if (!batch) {
    return jsonResponse({ error: "batch_not_found", message: "Batch not found" }, 404);
  }

  if (batch.agent_id !== authenticatedAgentId) {
    return jsonResponse(
      { error: "forbidden_batch_owner", message: "Batch belongs to a different agent" },
      403
    );
  }

  if (Number(batch.review_done) === 0) {
    return jsonResponse({ error: "review_not_done", review_done: false }, 409);
  }

  const { results: rows } = await env.DB.prepare(
    "SELECT * FROM verdicts WHERE batch_id = ?"
  )
    .bind(batch.batch_id)
    .all<VerdictRow>();

  const parsedItems = rows.map((row) => ({
    tier: normalizeTierFromDb(row.tier === null ? null : Number(row.tier)),
    flags: parseFlagsJson(row.flags_json),
  }));

  const cloudCounts = computeBatchCounts(parsedItems, Number(batch.pushed_count));

  if (parsedItems.length !== cloudCounts.pushed || !countsMatch(receivedCounts, cloudCounts)) {
    return jsonResponse(
      {
        error: "counts_mismatch",
        cloud_counts: cloudCounts,
        received_counts: receivedCounts,
      },
      409
    );
  }

  const prefix = buildBatchR2Prefix(batch.agent_id, batch.batch_id);
  const deletedPreviews = await deleteR2Prefix(env.PREVIEWS_BUCKET, prefix);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM verdicts WHERE batch_id = ?").bind(batch.batch_id),
    env.DB.prepare("DELETE FROM batches WHERE batch_id = ?").bind(batch.batch_id),
  ]);

  return jsonResponse({
    ok: true,
    batch_id: batch.batch_id,
    deleted_previews: deletedPreviews,
    counts: cloudCounts,
  });
}

export async function handleAgentRequest(request: Request, url: URL, env: Env): Promise<Response> {
  const auth = await authenticateAgent(request, env);
  if (!auth.ok) {
    return auth.response;
  }

  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (pathname === "/api/agent/push") {
    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    return handlePush(request, env, auth.agentId);
  }

  if (pathname === "/api/agent/verdicts") {
    if (request.method !== "GET") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    return handleGetVerdicts(url, env, auth.agentId);
  }

  if (pathname === "/api/agent/ack") {
    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    return handleAck(request, env, auth.agentId);
  }

  return jsonResponse({ error: "not_found" }, 404);
}
