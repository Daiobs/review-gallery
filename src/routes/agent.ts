import { authenticateAgent } from "../auth.js";
import { computeBatchCounts, parseFlagsJson, resolveDisposition } from "../buckets.js";
import type { AckItemPayload, AckReceipt } from "./agent-types.js";
import type { BatchRow, DestinationName, Env, PushManifest, VerdictRow } from "../types.js";
import {
  buildAgentBatchSummary,
  buildBatchR2Prefix,
  buildPreviewR2Key,
  deleteR2Prefix,
  isSafeId,
  jsonResponse,
  normalizeBatchSourceLine,
  normalizeTierFromDb,
  resolveBatchTypeInput,
  resolveLineInput,
  resolveSourceInput,
} from "../utils.js";

function isValidDestination(value: unknown): value is DestinationName {
  return value === "archive" || value === "repair" || value === "discard";
}

interface ParsedManifestEnvelope {
  manifest: PushManifest;
  rawObject: Record<string, unknown>;
}

async function readManifestFromFormData(formData: FormData): Promise<ParsedManifestEnvelope | null> {
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
      manifest: {
        agent_id: candidate.agent_id,
        batch_id: candidate.batch_id,
        source: candidate.source as string | null | undefined,
        line: candidate.line as string | null | undefined,
        batch_type: candidate.batch_type as string | null | undefined,
        items: candidate.items as PushManifest["items"],
      },
      rawObject: candidate,
    };
  } catch {
    return null;
  }
}

async function handlePush(
  request: Request,
  env: Env,
  authenticatedAgentId: string
): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ error: "invalid_multipart", message: "Expected multipart/form-data" }, 400);
  }

  const parsedEnvelope = await readManifestFromFormData(formData);
  if (!parsedEnvelope) {
    return jsonResponse(
      { error: "invalid_manifest", message: "Missing or invalid manifest JSON part" },
      400
    );
  }
  const { manifest, rawObject } = parsedEnvelope;

  if (manifest.agent_id !== authenticatedAgentId) {
    return jsonResponse(
      {
        error: "forbidden_agent_mismatch",
        message: "manifest.agent_id does not match authenticated agent",
      },
      403
    );
  }

  const batchId = manifest.batch_id;
  if (!isSafeId(batchId)) {
    return jsonResponse({ error: "invalid_batch_id", message: "Unsafe or malformed batch_id" }, 400);
  }

  const sourceRes = resolveSourceInput(rawObject.source, authenticatedAgentId);
  if (!sourceRes.ok) {
    return jsonResponse({ error: "invalid_source", message: sourceRes.message }, 400);
  }

  const lineRes = resolveLineInput(rawObject.line);
  if (!lineRes.ok) {
    return jsonResponse({ error: "invalid_line", message: lineRes.message }, 400);
  }

  const batchTypeRes = resolveBatchTypeInput(rawObject.batch_type);
  if (!batchTypeRes.ok) {
    return jsonResponse({ error: "invalid_batch_type", message: batchTypeRes.message }, 400);
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
        {
          error: "review_already_done",
          message: "Cannot push to a locked batch where review_done=1",
        },
        409
      );
    }

    const existingMeta = normalizeBatchSourceLine(existingBatch);
    const sourceConflict = sourceRes.explicit && sourceRes.value !== existingMeta.source;
    const lineConflict = lineRes.explicit && lineRes.value !== existingMeta.line;
    const batchTypeConflict =
      batchTypeRes.explicit && batchTypeRes.value !== existingMeta.batch_type;

    if (sourceConflict || lineConflict || batchTypeConflict) {
      return jsonResponse(
        {
          error: "batch_metadata_conflict",
          message: "Chunk metadata conflicts with existing batch metadata",
          existing: {
            source: existingMeta.source,
            line: existingMeta.line,
            batch_type: existingMeta.batch_type,
          },
          received: {
            source: sourceRes.value,
            line: lineRes.value,
            batch_type: batchTypeRes.value,
          },
        },
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
      if (
        typeof rawItem.filename !== "string" ||
        rawItem.filename.length > 512 ||
        rawItem.filename.includes("\0")
      ) {
        rejected.push({ item_id: itemId, reason: "invalid_filename" });
        continue;
      }
      filename = rawItem.filename;
    }

    let width: number | null = null;
    if (rawItem.width !== undefined && rawItem.width !== null) {
      if (
        typeof rawItem.width !== "number" ||
        !Number.isInteger(rawItem.width) ||
        rawItem.width < 1
      ) {
        rejected.push({ item_id: itemId, reason: "invalid_dimensions" });
        continue;
      }
      width = rawItem.width;
    }

    let height: number | null = null;
    if (rawItem.height !== undefined && rawItem.height !== null) {
      if (
        typeof rawItem.height !== "number" ||
        !Number.isInteger(rawItem.height) ||
        rawItem.height < 1
      ) {
        rejected.push({ item_id: itemId, reason: "invalid_dimensions" });
        continue;
      }
      height = rawItem.height;
    }

    let parentItemId: string | null = null;
    const rawParentId = (rawItem as { parent_item_id?: unknown }).parent_item_id;
    if (rawParentId !== undefined && rawParentId !== null && rawParentId !== "") {
      if (!isSafeId(rawParentId)) {
        rejected.push({ item_id: itemId, reason: "invalid_parent_item_id" });
        continue;
      }
      parentItemId = rawParentId;
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
        `INSERT OR IGNORE INTO batches (
           batch_id, agent_id, source, line, batch_type,
           pushed_count, review_done, review_done_at, created_at, previews_purged_at
         ) VALUES (?, ?, ?, ?, ?, 0, 0, NULL, ?, NULL)`
      )
        .bind(
          batchId,
          authenticatedAgentId,
          sourceRes.value,
          lineRes.value,
          batchTypeRes.value,
          nowIso
        )
        .run();
      batchEnsured = true;
    }

    const r2Key = buildPreviewR2Key(authenticatedAgentId, batchId, itemId, round);
    await env.PREVIEWS_BUCKET.put(r2Key, bytes, {
      httpMetadata: { contentType: "image/webp" },
    });

    await env.DB.prepare(
      `INSERT INTO verdicts (
         item_id, round, batch_id, filename, width, height, parent_item_id,
         pushed_at, tier, flags_json, note, judged_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]', '', NULL)
       ON CONFLICT(item_id, round) DO UPDATE SET
         filename = excluded.filename,
         width = excluded.width,
         height = excluded.height,
         parent_item_id = excluded.parent_item_id,
         pushed_at = excluded.pushed_at,
         tier = NULL,
         flags_json = '[]',
         note = '',
         judged_at = NULL`
    )
      .bind(itemId, round, batchId, filename, width, height, parentItemId, nowIso)
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
    const tier = normalizeTierFromDb(row.tier);
    const flags = parseFlagsJson(row.flags_json);
    const { destination, redraw } = resolveDisposition(tier, flags);
    const parentItemId =
      typeof row.parent_item_id === "string" && row.parent_item_id.trim() !== ""
        ? row.parent_item_id
        : null;

    return {
      item_id: row.item_id,
      round: Number(row.round),
      parent_item_id: parentItemId,
      tier,
      flags,
      destination,
      redraw,
      note: row.note ?? "",
      judged_at: row.judged_at ?? null,
    };
  });

  const counts = computeBatchCounts(items, Number(batch.pushed_count));
  const { source, line, channel_id, batch_type } = normalizeBatchSourceLine(batch);

  return jsonResponse({
    batch_id: batch.batch_id,
    agent_id: batch.agent_id,
    source,
    line,
    channel_id,
    batch_type,
    review_done: Boolean(Number(batch.review_done)),
    review_done_at: batch.review_done_at ?? null,
    counts,
    items,
  });
}

async function handleGetAgentBatches(
  url: URL,
  env: Env,
  authenticatedAgentId: string
): Promise<Response> {
  const sourceParam = url.searchParams.get("source");
  const lineParam = url.searchParams.get("line");
  const reviewDoneParam = url.searchParams.get("review_done");

  let wantReviewDone: boolean | null = null;
  if (reviewDoneParam !== null && reviewDoneParam.trim() !== "") {
    const normalized = reviewDoneParam.trim().toLowerCase();
    if (normalized === "1" || normalized === "true") {
      wantReviewDone = true;
    } else if (normalized === "0" || normalized === "false") {
      wantReviewDone = false;
    } else {
      return jsonResponse(
        { error: "invalid_review_done_filter", message: "review_done must be 0, 1, true, or false" },
        400
      );
    }
  }

  const { results: rows } = await env.DB.prepare(
    "SELECT * FROM batches WHERE agent_id = ? ORDER BY created_at DESC, batch_id DESC"
  )
    .bind(authenticatedAgentId)
    .all<BatchRow>();

  let summaries = rows.map((row) => buildAgentBatchSummary(row));

  if (sourceParam !== null && sourceParam.trim() !== "") {
    const expectedSource = sourceParam.trim();
    summaries = summaries.filter((b) => b.source === expectedSource);
  }

  if (lineParam !== null && lineParam.trim() !== "") {
    const expectedLine = lineParam.trim();
    summaries = summaries.filter((b) => b.line === expectedLine);
  }

  if (wantReviewDone !== null) {
    summaries = summaries.filter((b) => b.review_done === wantReviewDone);
  }

  return jsonResponse({ batches: summaries });
}

function parseAckItems(rawItems: unknown): AckItemPayload[] | null {
  if (!Array.isArray(rawItems)) {
    return null;
  }
  const parsed: AckItemPayload[] = [];
  for (const entry of rawItems) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const obj = entry as Record<string, unknown>;
    if (!isSafeId(obj.item_id)) {
      return null;
    }
    if (typeof obj.round !== "number" || !Number.isInteger(obj.round) || obj.round < 1) {
      return null;
    }
    if (!isValidDestination(obj.destination)) {
      return null;
    }
    if (typeof obj.redraw !== "boolean") {
      return null;
    }
    if (
      obj.archive_ref !== undefined &&
      obj.archive_ref !== null &&
      typeof obj.archive_ref !== "string"
    ) {
      return null;
    }
    parsed.push({
      item_id: obj.item_id,
      round: obj.round,
      destination: obj.destination,
      redraw: obj.redraw,
      archive_ref: obj.archive_ref as string | null | undefined,
    });
  }
  return parsed;
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

  const rawItems = (body as { items?: unknown }).items;
  const submittedItems = parseAckItems(rawItems);
  if (!submittedItems) {
    return jsonResponse(
      { error: "invalid_items", message: "Missing or invalid ack items array" },
      400
    );
  }

  // 1. Verify batch exists, belongs to authenticated agent, and has review_done === 1
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

  if (Number(batch.review_done) !== 1) {
    return jsonResponse({ error: "review_not_done", review_done: false }, 409);
  }

  // 2. Verify no duplicates and exact (item_id, round) coverage against D1
  const { results: d1Rows } = await env.DB.prepare(
    "SELECT * FROM verdicts WHERE batch_id = ? ORDER BY item_id ASC, round ASC"
  )
    .bind(batch.batch_id)
    .all<VerdictRow>();

  const submittedByKey = new Map<string, AckItemPayload>();
  const duplicates: Array<{ item_id: string; round: number }> = [];
  for (const sub of submittedItems) {
    const key = `${sub.item_id}#${sub.round}`;
    if (submittedByKey.has(key)) {
      duplicates.push({ item_id: sub.item_id, round: sub.round });
    } else {
      submittedByKey.set(key, sub);
    }
  }

  const d1Keys = new Set<string>();
  const missingItems: Array<{ item_id: string; round: number }> = [];
  for (const row of d1Rows) {
    const round = Number(row.round);
    const key = `${row.item_id}#${round}`;
    d1Keys.add(key);
    if (!submittedByKey.has(key)) {
      missingItems.push({ item_id: row.item_id, round });
    }
  }

  const unexpectedItems: Array<{ item_id: string; round: number }> = [];
  for (const sub of submittedItems) {
    const key = `${sub.item_id}#${sub.round}`;
    if (!d1Keys.has(key)) {
      unexpectedItems.push({ item_id: sub.item_id, round: sub.round });
    }
  }

  if (
    duplicates.length > 0 ||
    missingItems.length > 0 ||
    unexpectedItems.length > 0 ||
    d1Rows.length !== Number(batch.pushed_count)
  ) {
    return jsonResponse(
      {
        error: "items_coverage_mismatch",
        expected_count: d1Rows.length,
        received_count: submittedItems.length,
        duplicates,
        missing_items: missingItems,
        unexpected_items: unexpectedItems,
      },
      409
    );
  }

  // 3. Verify each item's destination & redraw match server-computed disposition
  const mismatches: Array<{
    item_id: string;
    round: number;
    expected: { destination: DestinationName; redraw: boolean };
    received: { destination: DestinationName; redraw: boolean };
  }> = [];

  const serverDispositions = new Map<string, { destination: DestinationName; redraw: boolean }>();

  for (const row of d1Rows) {
    const round = Number(row.round);
    const key = `${row.item_id}#${round}`;
    const tier = normalizeTierFromDb(row.tier);
    const flags = parseFlagsJson(row.flags_json);
    const expected = resolveDisposition(tier, flags);
    serverDispositions.set(key, expected);

    const submitted = submittedByKey.get(key)!;
    if (submitted.destination !== expected.destination || submitted.redraw !== expected.redraw) {
      mismatches.push({
        item_id: row.item_id,
        round,
        expected,
        received: {
          destination: submitted.destination,
          redraw: submitted.redraw,
        },
      });
    }
  }

  if (mismatches.length > 0) {
    return jsonResponse(
      {
        error: "disposition_mismatch",
        mismatches,
      },
      409
    );
  }

  // 4. Verify non-empty archive_ref for every destination === "archive" item
  const missingArchiveRefItems: string[] = [];
  for (const row of d1Rows) {
    const round = Number(row.round);
    const key = `${row.item_id}#${round}`;
    const expected = serverDispositions.get(key)!;
    if (expected.destination === "archive") {
      const submitted = submittedByKey.get(key)!;
      if (typeof submitted.archive_ref !== "string" || submitted.archive_ref.trim().length === 0) {
        missingArchiveRefItems.push(row.item_id);
      }
    }
  }

  if (missingArchiveRefItems.length > 0) {
    return jsonResponse(
      {
        error: "missing_archive_ref",
        missing_items: missingArchiveRefItems,
      },
      409
    );
  }

  // 5. All checks passed -> build receipt, purge R2 prefix & delete D1 batch + verdicts
  const receipt: AckReceipt = {
    archive: [],
    repair: [],
    discard: [],
    redraw: [],
  };

  for (const row of d1Rows) {
    const round = Number(row.round);
    const key = `${row.item_id}#${round}`;
    const disp = serverDispositions.get(key)!;
    receipt[disp.destination].push(row.item_id);
    if (disp.redraw) {
      receipt.redraw.push(row.item_id);
    }
  }

  const prefix = buildBatchR2Prefix(batch.agent_id, batch.batch_id);
  const purgedPreviews = await deleteR2Prefix(env.PREVIEWS_BUCKET, prefix);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM verdicts WHERE batch_id = ?").bind(batch.batch_id),
    env.DB.prepare("DELETE FROM batches WHERE batch_id = ?").bind(batch.batch_id),
  ]);

  return jsonResponse({
    ok: true,
    batch_id: batch.batch_id,
    purged_previews: purgedPreviews,
    receipt,
  });
}

export async function handleAgentRequest(
  request: Request,
  url: URL,
  env: Env
): Promise<Response> {
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

  if (pathname === "/api/agent/batches") {
    if (request.method !== "GET") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    return handleGetAgentBatches(url, env, auth.agentId);
  }

  if (pathname === "/api/agent/ack") {
    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    return handleAck(request, env, auth.agentId);
  }

  return jsonResponse({ error: "not_found" }, 404);
}
