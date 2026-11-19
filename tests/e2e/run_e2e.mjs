#!/usr/bin/env node
/**
 * Review Outpost v4 — Live Cross-Stack End-to-End Acceptance Suite
 *
 * Runs the REAL Cloudflare Worker (`src/index.ts`) over a live localhost HTTP server
 * backed by:
 *   - Real file-backed SQLite D1 (`node:sqlite` + `migrations/0001_init.sql` + `0002_v4_upgrade.sql`)
 *   - Paginated In-Memory R2 (`r2PageSize = 5`)
 *   - Real `./public` Static Assets (`index.html`, `styles.css`, `app.js`, `robots.txt`)
 *   - Real Web Crypto RS256 JWKS verification + SHA-256 constant-time Agent Token Auth
 * and invokes the REAL `python3 agent/hub_client.py` & `python3 agent/migrate_v4_cutover.py`
 * CLI subprocesses against the live TCP port to verify the full v4 specification (§1–§7).
 *
 * Strictly uses `.test-sandboxes/e2e/` inside the repository (never `/tmp`).
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeBatchCounts as frontendComputeBatchCounts,
  computeDisposition as frontendComputeDisposition,
  formatDispositionBadge as frontendFormatBadge,
  isItemJudged as frontendIsItemJudged,
  itemMatchesFilter as frontendMatchesFilter,
} from "../../public/app.js";
import {
  computeBatchCounts as backendComputeBatchCounts,
  isItemJudged as backendIsItemJudged,
  resolveDisposition as backendResolveDisposition,
} from "../../src/buckets.js";
import {
  createTestAccessKeys,
  createTestHarness,
  signTestAccessJwt,
  startLocalWorkerServer,
} from "../worker/test-env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");
const E2E_SANDBOX = path.join(REPO_ROOT, ".test-sandboxes", "e2e");
const E2E_TMP_DIR = path.join(E2E_SANDBOX, "runtime-tmp");
const HUB_CLIENT_PY = path.join(REPO_ROOT, "agent", "hub_client.py");
const MIGRATE_CUTOVER_PY = path.join(REPO_ROOT, "agent", "migrate_v4_cutover.py");
const PUBLIC_DIR = path.join(REPO_ROOT, "public");

const MUSE_AGENT_ID = "muse-main";
const MUSE_AGENT_TOKEN = "e2e-dummy-token-muse-main-0000000000000001";
const ARGON_AGENT_ID = "argon-mac";
const ARGON_AGENT_TOKEN = "e2e-dummy-token-argon-mac-0000000000000002";

function logStep(title) {
  console.log(`\n[E2E] === ${title} ===`);
}

function assertSecurityHeaders(res, label) {
  assert.equal(
    res.headers.get("x-robots-tag"),
    "noindex, nofollow, noarchive",
    `${label}: missing X-Robots-Tag header`
  );
  assert.equal(
    res.headers.get("cache-control"),
    "private, no-store",
    `${label}: missing Cache-Control header`
  );
}

function runPython(args, envOverrides = {}) {
  const env = { ...process.env, TMPDIR: E2E_TMP_DIR };
  delete env.OUTPOST_SOURCE;
  delete env.OUTPOST_LINE;
  delete env.OUTPOST_BATCH_TYPE;
  delete env.OUTPOST_ANONYMIZE_NAMES;
  delete env.CF_ACCESS_CLIENT_ID;
  delete env.CF_ACCESS_CLIENT_SECRET;
  Object.assign(env, envOverrides);

  return new Promise((resolve, reject) => {
    const child = spawn("python3", args, {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        status: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

async function createSamplePngs(specs) {
  const pyCode = `
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw

specs = json.loads(sys.argv[1])
for sp in specs:
    p = Path(sp["path"])
    p.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", (sp["width"], sp["height"]), tuple(sp["color"]))
    draw = ImageDraw.Draw(img)
    draw.rectangle([8, 8, sp["width"] - 8, sp["height"] - 8], outline=(245, 196, 81), width=3)
    img.save(p, format="PNG")
    if sp.get("prompt") is not None:
        p.with_suffix(".txt").write_text(sp["prompt"], encoding="utf-8")
    if sp.get("context_json") is not None:
        p.with_suffix(".json").write_text(json.dumps(sp["context_json"], ensure_ascii=False), encoding="utf-8")
`;
  const proc = await runPython(["-c", pyCode, JSON.stringify(specs)]);
  assert.equal(proc.status, 0, `Failed generating sample PNGs: ${proc.stderr}`);
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function main() {
  const forbiddenTmpPrefix = path.join("/", "tmp");
  assert(
    !E2E_SANDBOX.startsWith(forbiddenTmpPrefix) &&
      !E2E_SANDBOX.startsWith(path.join("/private", "tmp")),
    "E2E sandbox must reside inside the repository, never under system temp directories"
  );

  fs.rmSync(E2E_SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(E2E_TMP_DIR, { recursive: true });

  const sqlitePath = path.join(E2E_SANDBOX, "outpost-v4-d1.sqlite");
  const museWorkspaceDir = path.join(E2E_SANDBOX, "workspace-muse");
  const argonWorkspaceDir = path.join(E2E_SANDBOX, "workspace-argon");
  const batch1OrigDir = path.join(E2E_SANDBOX, "originals_muse_gpt");
  const colabOrigDir = path.join(E2E_SANDBOX, "originals_muse_colab");
  const argonFaceOrigDir = path.join(E2E_SANDBOX, "originals_argon_face");
  const followupOrigDir = path.join(E2E_SANDBOX, "originals_followup");

  fs.mkdirSync(museWorkspaceDir, { recursive: true });
  fs.mkdirSync(argonWorkspaceDir, { recursive: true });

  const harness = await createTestHarness({
    sqlitePath,
    r2PageSize: 5, // Force cursor pagination across R2 list/delete on 12-item batch
    publicDir: PUBLIC_DIR,
    agentTokens: {
      [MUSE_AGENT_ID]: MUSE_AGENT_TOKEN,
      [ARGON_AGENT_ID]: ARGON_AGENT_TOKEN,
    },
    allowedEmails: "reviewer@example.test",
    accessAud: "e2e-access-aud-tag-v4",
  });

  const srv = await startLocalWorkerServer(harness.env, "127.0.0.1");
  const capturedAgentHeaders = [];
  srv.server.on("request", (req) => {
    if (req.url && req.url.startsWith("/api/agent/")) {
      capturedAgentHeaders.push({
        url: req.url,
        headers: { ...req.headers },
      });
    }
  });
  console.log(`[E2E] Live Worker HTTP server listening at ${srv.baseUrl}`);

  const museBaseEnv = {
    OUTPOST_URL: srv.baseUrl,
    OUTPOST_AGENT_ID: MUSE_AGENT_ID,
    OUTPOST_TOKEN: MUSE_AGENT_TOKEN,
    OUTPOST_HOME: museWorkspaceDir,
  };

  const argonBaseEnv = {
    OUTPOST_URL: srv.baseUrl,
    OUTPOST_AGENT_ID: ARGON_AGENT_ID,
    OUTPOST_TOKEN: ARGON_AGENT_TOKEN,
    OUTPOST_HOME: argonWorkspaceDir,
  };

  function runMuseCli(cliArgs, extraEnv = {}) {
    return runPython([HUB_CLIENT_PY, ...cliArgs], { ...museBaseEnv, ...extraEnv });
  }

  function runArgonCli(cliArgs, extraEnv = {}) {
    return runPython([HUB_CLIENT_PY, ...cliArgs], { ...argonBaseEnv, ...extraEnv });
  }

  try {
    const validJwt = await harness.signReviewerJwt();
    const expiredJwt = await harness.signReviewerJwt({
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const rogueKeys = await createTestAccessKeys("rogue-e2e-kid");
    const wrongKeyJwt = await signTestAccessJwt(rogueKeys, {
      email: "reviewer@example.test",
      aud: [harness.accessAud],
    });
    const unauthorizedEmailJwt = await harness.signReviewerJwt({
      email: "outsider@example.test",
    });

    // =========================================================================
    // 0. Exhaustive 80-Combination 3-Way Orthogonal Parity (Worker TS == Frontend JS == Agent PY)
    // =========================================================================
    logStep("0. Exhaustive 80-Case 3-Way Disposition Parity (src/buckets.ts == public/app.js == agent/hub_client.py)");
    const tiers = [3, 2, 1, 0, null];
    const flagAtoms = ["H", "F", "O", "R"];
    const testCases = [];
    for (const tier of tiers) {
      for (let mask = 0; mask < 16; mask++) {
        const flags = flagAtoms.filter((_, i) => (mask & (1 << i)) !== 0);
        testCases.push({ tier, flags });
      }
    }
    assert.equal(testCases.length, 80);

    const pyDispProc = await runPython([
      "-c",
      `import json, sys; sys.path.insert(0, "agent"); import hub_client; cases = json.loads(sys.argv[1]); print(json.dumps([hub_client.resolve_disposition(c["tier"], c["flags"]) for c in cases]))`,
      JSON.stringify(testCases),
    ]);
    assert.equal(pyDispProc.status, 0, pyDispProc.stderr);
    const pyDispositions = JSON.parse(pyDispProc.stdout);

    testCases.forEach((tc, idx) => {
      const bDisp = backendResolveDisposition(tc.tier, tc.flags);
      const fDisp = frontendComputeDisposition(tc.tier, tc.flags);
      const pDisp = pyDispositions[idx];

      assert.deepEqual(fDisp, bDisp, `Frontend != Backend for ${JSON.stringify(tc)}`);
      assert.equal(pDisp.destination, bDisp.destination, `Python destination != Backend for ${JSON.stringify(tc)}`);
      assert.equal(pDisp.redraw, bDisp.redraw, `Python redraw != Backend for ${JSON.stringify(tc)}`);

      // Verify zero-swallow of tier = 0 across all 3 layers!
      if (tc.tier === 0) {
        assert.equal(backendIsItemJudged(0, tc.flags, ""), true);
        assert.equal(frontendIsItemJudged({ tier: 0, flags: tc.flags, note: "" }), true);
        if (bDisp.destination === "archive") {
          assert.equal(pDisp.final_tier, 0);
          assert.equal(pDisp.intent_tier, null);
        } else if (bDisp.destination === "repair") {
          assert.equal(pDisp.intent_tier, 0);
          assert.equal(pDisp.final_tier, null);
        }
      }
    });

    const bAgg = backendComputeBatchCounts(testCases);
    const fAgg = frontendComputeBatchCounts(testCases.map((c) => ({ ...c, note: "" })));
    assert.deepEqual(fAgg.counts, bAgg);
    assert.equal(bAgg.archive + bAgg.repair + bAgg.discard, 80);

    // Verify Frontend §5.3 badge text & filter visibility linkage
    assert.equal(frontendFormatBadge(3, ["R"], "artwork"), "★★★ 神图 · 重抽");
    assert.equal(frontendFormatBadge(3, ["R"], "face"), "★★★ 核心锚 · 重抽");
    assert.equal(frontendFormatBadge(0, [], "artwork"), "☆ 收藏");
    assert.equal(frontendFormatBadge(0, [], "outfit"), "☆ 留样");
    assert.equal(frontendFormatBadge(3, ["H", "R"], "artwork"), "待修复(意向★★★) · H · 重抽");
    assert.equal(frontendFormatBadge(0, ["H"], "artwork"), "待修复(意向☆) · H");
    assert.equal(frontendFormatBadge(null, ["R"], "artwork"), "仅重抽（原图不收）");

    assert.equal(frontendMatchesFilter({ tier: 3, flags: ["R"] }, "archive"), true);
    assert.equal(frontendMatchesFilter({ tier: 3, flags: ["R"] }, "redraw"), true);
    assert.equal(frontendMatchesFilter({ tier: 3, flags: ["H", "R"] }, "repair"), true);
    assert.equal(frontendMatchesFilter({ tier: 3, flags: ["H", "R"] }, "redraw"), true);
    assert.equal(frontendMatchesFilter({ tier: null, flags: ["R"] }, "discard"), true);
    assert.equal(frontendMatchesFilter({ tier: null, flags: ["R"] }, "redraw"), true);
    console.log("[E2E] Verified 80/80 (tier x flags) combinations + zero-swallow tier=0 + badge/filter linkage.");

    // =========================================================================
    // 1. Access RS256 Auth, noindex Headers, Static Assets, Agent Auth & Path Guard
    // =========================================================================
    logStep("1. Access RS256 JWT Gate, Security Headers, Static Assets & Path Guard");
    for (const route of [
      "/",
      "/app.js",
      "/styles.css",
      "/robots.txt",
      "/api/review/batches",
      "/api/review/previews/20261119-museai-gpt-01/20261119-museai-gpt-01-001/1",
    ]) {
      const noJwtRes = await fetch(`${srv.baseUrl}${route}`);
      assert.equal(noJwtRes.status, 401, `Expected 401 without JWT on ${route}`);
      assertSecurityHeaders(noJwtRes, `no-jwt ${route}`);

      const tamperedRes = await fetch(`${srv.baseUrl}${route}`, {
        headers: { "Cf-Access-Jwt-Assertion": validJwt.slice(0, -5) + "ZZZZZ" },
      });
      assert.equal(tamperedRes.status, 401);

      const wrongKeyRes = await fetch(`${srv.baseUrl}${route}`, {
        headers: { "Cf-Access-Jwt-Assertion": wrongKeyJwt },
      });
      assert.equal(wrongKeyRes.status, 401);

      const expiredRes = await fetch(`${srv.baseUrl}${route}`, {
        headers: { "Cf-Access-Jwt-Assertion": expiredJwt },
      });
      assert.equal(expiredRes.status, 401);

      const wrongEmailRes = await fetch(`${srv.baseUrl}${route}`, {
        headers: { "Cf-Access-Jwt-Assertion": unauthorizedEmailJwt },
      });
      assert.equal(wrongEmailRes.status, 403);
    }

    for (const [method, agentRoute] of [
      ["POST", "/api/agent/push"],
      ["GET", "/api/agent/verdicts?batch_id=20261119-museai-gpt-01"],
      ["GET", "/api/agent/batches"],
      ["POST", "/api/agent/ack"],
    ]) {
      const noTok = await fetch(`${srv.baseUrl}${agentRoute}`, { method });
      assert.equal(noTok.status, 401, `Expected 401 without Bearer token on ${agentRoute}`);

      const badTok = await fetch(`${srv.baseUrl}${agentRoute}`, {
        method,
        headers: { Authorization: "Bearer invalid-agent-token-xyz" },
      });
      assert.equal(badTok.status, 401, `Expected 401 with bad Bearer token on ${agentRoute}`);
      assertSecurityHeaders(badTok, `bad-agent-token ${agentRoute}`);
    }

    // Verify static HTML & JS load with valid JWT and contain v4 UI elements + noindex meta
    const indexRes = await fetch(`${srv.baseUrl}/`, {
      headers: { "Cf-Access-Jwt-Assertion": validJwt },
    });
    assert.equal(indexRes.status, 200);
    assertSecurityHeaders(indexRes, "GET /");
    const indexHtml = await indexRes.text();
    assert.match(indexHtml, /noindex,\s*nofollow,\s*noarchive/);
    assert.match(indexHtml, /撤回审完状态/);

    const appJsRes = await fetch(`${srv.baseUrl}/app.js`, {
      headers: { "Cf-Access-Jwt-Assertion": validJwt },
    });
    assert.equal(appJsRes.status, 200);
    assertSecurityHeaders(appJsRes, "GET /app.js");
    const appJsText = await appJsRes.text();
    assert.match(appJsText, /computeDisposition/);

    // Verify strict forbidden system temp path rejection in real CLI subprocess
    const forbiddenPath = path.join(forbiddenTmpPrefix, "forbidden-outpost-e2e");
    const tmpRejectProc = await runMuseCli(["batches", "--workspace-dir", forbiddenPath]);
    assert.equal(tmpRejectProc.status, 2, "CLI must reject forbidden temp workspace with exit 2");
    assert.equal(JSON.parse(tmpRejectProc.stdout).error, "forbidden_storage_path");

    // =========================================================================
    // 2. flock Batch Reservation, Multi-Channel Push, --anonymize-names,
    //    --parent-map, Sidecar generation_context & CF-Access Service Headers
    // =========================================================================
    logStep("2. flock Auto-Batch ID, Multi-Channel Push, Blind Anonymization, Lineage & CF-Access Headers");
    const dimensionsCycle = [
      [832, 1216],
      [1024, 1024],
      [1344, 768],
    ];
    const batch1Specs = [];
    for (let i = 1; i <= 12; i++) {
      const [w, h] = dimensionsCycle[(i - 1) % dimensionsCycle.length];
      const realName = `secret_gpt_seed_${String(i).padStart(3, "0")}.png`;
      batch1Specs.push({
        path: path.join(batch1OrigDir, realName),
        width: w,
        height: h,
        color: [20 + i * 10, 50 + i * 8, 110 + i * 6],
        prompt: `cinematic portrait prompt #${i}`,
        context_json: {
          model: "gpt-image-1",
          seed: 1000 + i,
          prompt: `cinematic portrait prompt #${i}`,
          face_anchor: "anchor_03",
        },
      });
    }
    await createSamplePngs(batch1Specs);

    // Push 12 images WITHOUT --batch (tests flock auto-reservation `<YYYYMMDD>-museai-gpt-01`),
    // with --chunk-size 5 (3 chunks: 5+5+2), --anonymize-names, and CF_ACCESS_CLIENT_ID/SECRET!
    capturedAgentHeaders.length = 0;
    const push1Proc = await runMuseCli(
      [
        "push",
        batch1OrigDir,
        "--source",
        "museai",
        "--line",
        "gpt",
        "--chunk-size",
        "5",
        "--anonymize-names",
      ],
      {
        CF_ACCESS_CLIENT_ID: "dummy-cf-service-client-id.access",
        CF_ACCESS_CLIENT_SECRET: "dummy-cf-service-client-secret-placeholder",
      }
    );
    assert.equal(push1Proc.status, 0, `hub_client.py push failed: ${push1Proc.stderr}`);
    const push1Out = JSON.parse(push1Proc.stdout);
    const batch1Id = push1Out.batch_id;
    assert.match(batch1Id, /^\d{8}-museai-gpt-01$/);
    assert.equal(push1Out.source, "museai");
    assert.equal(push1Out.line, "gpt");
    assert.equal(push1Out.channel_id, "museai-gpt");
    assert.equal(push1Out.batch_type, "artwork");
    assert.equal(push1Out.anonymized_names, true);
    assert.equal(push1Out.pushed_count, 12);
    assert.equal(push1Out.chunks, 3);

    // Verify CF-Access-Client-Id and CF-Access-Client-Secret headers were transmitted across all 3 chunk HTTP requests!
    const pushHeaderHits = capturedAgentHeaders.filter((h) => h.url === "/api/agent/push");
    assert.equal(pushHeaderHits.length, 3, "Expected 3 chunked /api/agent/push HTTP requests");
    for (const hit of pushHeaderHits) {
      assert.equal(hit.headers["cf-access-client-id"], "dummy-cf-service-client-id.access");
      assert.equal(
        hit.headers["cf-access-client-secret"],
        "dummy-cf-service-client-secret-placeholder"
      );
    }

    // Verify local ledger recorded `batch_reserved` FIRST, preserved real filename & generation_context
    const museLedgerPath = path.join(museWorkspaceDir, `ledger-${MUSE_AGENT_ID}.jsonl`);
    const museLedgerInitial = readJsonl(museLedgerPath);
    assert.equal(museLedgerInitial[0].event, "batch_reserved");
    assert.equal(museLedgerInitial[0].batch_id, batch1Id);
    const pushedEntries1 = museLedgerInitial.filter((r) => r.state === "pushed" && r.batch_id === batch1Id);
    assert.equal(pushedEntries1.length, 12);
    assert.equal(pushedEntries1[0].filename, "secret_gpt_seed_001.png");
    assert.equal(pushedEntries1[0].display_filename, "001.webp");
    assert.equal(pushedEntries1[0].generation_context.model, "gpt-image-1");
    assert.equal(pushedEntries1[0].generation_context.seed, 1001);

    // Verify cloud batch received ONLY anonymized `001.webp`..`012.webp` and zero generation_context leak!
    const detail1Res = await fetch(`${srv.baseUrl}/api/review/batches/${batch1Id}`, {
      headers: { "Cf-Access-Jwt-Assertion": validJwt },
    });
    assert.equal(detail1Res.status, 200);
    const detail1Json = await detail1Res.json();
    assert.equal(detail1Json.batch.channel_id, "museai-gpt");
    assert.equal(detail1Json.batch.batch_type, "artwork");
    assert.equal(detail1Json.items.length, 12);
    assert.equal(detail1Json.items[0].filename, "001.webp");
    assert.equal(detail1Json.items[11].filename, "012.webp");
    assert.equal("generation_context" in detail1Json.items[0], false);
    assert.equal(detail1Json.items[0].width, 832);
    assert.equal(detail1Json.items[0].height, 1216);

    // Verify R2 WebP stream matches ledger preview_sha256
    const previewRes = await fetch(`${srv.baseUrl}${detail1Json.items[0].preview_url}`, {
      headers: { "Cf-Access-Jwt-Assertion": validJwt },
    });
    assert.equal(previewRes.status, 200);
    assertSecurityHeaders(previewRes, "GET WebP preview");
    const previewBytes = Buffer.from(await previewRes.arrayBuffer());
    const previewSha = crypto.createHash("sha256").update(previewBytes).digest("hex");
    assert.equal(previewSha, pushedEntries1[0].preview_sha256);

    // Push a second pipeline batch for muse-main (`museai-colab`, `服装` -> `outfit`)
    await createSamplePngs([
      {
        path: path.join(colabOrigDir, "outfit_cand_01.png"),
        width: 1024,
        height: 1536,
        color: [140, 80, 160],
        prompt: "linen coat anchor",
      },
    ]);
    const pushColabProc = await runMuseCli([
      "push",
      colabOrigDir,
      "--source",
      "museai",
      "--line",
      "colab",
      "--batch-type",
      "服装",
    ]);
    assert.equal(pushColabProc.status, 0, pushColabProc.stderr);
    const pushColabOut = JSON.parse(pushColabProc.stdout);
    const colabBatchId = pushColabOut.batch_id;
    assert.match(colabBatchId, /^\d{8}-museai-colab-01$/);
    assert.equal(pushColabOut.batch_type, "outfit");

    // Push a third batch from `argon-mac` (`gallery-banana`, Chinese alias `脸模` -> `face`, with `--parent-map`)
    await createSamplePngs([
      {
        path: path.join(argonFaceOrigDir, "face_cand_a.png"),
        width: 1024,
        height: 1024,
        color: [180, 120, 90],
        prompt: "face candidate A",
      },
      {
        path: path.join(argonFaceOrigDir, "face_cand_b.png"),
        width: 1024,
        height: 1024,
        color: [190, 130, 100],
        prompt: "face candidate B",
      },
    ]);
    const parentMapJson = JSON.stringify({
      "face_cand_a.png": "20261101-gallery-banana-01-007",
      "face_cand_b.png": "20261101-gallery-banana-01-007", // Same parent -> multiple candidates!
    });
    const pushArgonProc = await runArgonCli([
      "push",
      argonFaceOrigDir,
      "--source",
      "gallery",
      "--line",
      "banana",
      "--batch-type",
      "脸模",
      "--parent-map",
      parentMapJson,
    ]);
    assert.equal(pushArgonProc.status, 0, pushArgonProc.stderr);
    const pushArgonOut = JSON.parse(pushArgonProc.stdout);
    const argonBatchId = pushArgonOut.batch_id;
    assert.match(argonBatchId, /^\d{8}-gallery-banana-01$/);
    assert.equal(pushArgonOut.batch_type, "face");

    // Verify parent_item_id on cloud review endpoint
    const argonDetailRes = await fetch(`${srv.baseUrl}/api/review/batches/${argonBatchId}`, {
      headers: { "Cf-Access-Jwt-Assertion": validJwt },
    });
    const argonDetailJson = await argonDetailRes.json();
    assert.equal(argonDetailJson.batch.batch_type, "face");
    assert.equal(argonDetailJson.items[0].parent_item_id, "20261101-gallery-banana-01-007");
    assert.equal(argonDetailJson.items[1].parent_item_id, "20261101-gallery-banana-01-007");

    // Verify `hub_client.py batches` multi-pipeline polling & per-agent isolation
    const museAllBatches = JSON.parse((await runMuseCli(["batches"])).stdout);
    assert.equal(museAllBatches.batches.length, 2);
    const museGptOnly = JSON.parse((await runMuseCli(["batches", "--line", "gpt"])).stdout);
    assert.equal(museGptOnly.batches.length, 1);
    assert.equal(museGptOnly.batches[0].batch_id, batch1Id);
    const argonBatches = JSON.parse((await runArgonCli(["batches"])).stdout);
    assert.equal(argonBatches.batches.length, 1);
    assert.equal(argonBatches.batches[0].batch_id, argonBatchId);

    // =========================================================================
    // 3. Reviewer 4-Star Grading (3/2/1/0/null), Orthogonal Flags, Channels Bar & Lock/Revoke
    // =========================================================================
    logStep("3. Reviewer 4-Star Grading (including tier = 0), Dynamic Channels Bar & Lock/Revoke/Re-lock");

    // Check `/api/review/batches` dynamic `channels` aggregation & `?channel=` filtering
    const reviewListRes = await fetch(`${srv.baseUrl}/api/review/batches?channel=museai-gpt`, {
      headers: { "Cf-Access-Jwt-Assertion": validJwt },
    });
    assert.equal(reviewListRes.status, 200);
    const reviewListJson = await reviewListRes.json();
    assert.equal(reviewListJson.batches.length, 1);
    assert.equal(reviewListJson.batches[0].batch_id, batch1Id);
    assert.deepEqual(reviewListJson.channels, [
      { channel_id: "gallery-banana", source: "gallery", line: "banana", total_batches: 1, pending_batches: 1 },
      { channel_id: "museai-colab", source: "museai", line: "colab", total_batches: 1, pending_batches: 1 },
      { channel_id: "museai-gpt", source: "museai", line: "gpt", total_batches: 1, pending_batches: 1 },
    ]);

    async function patchBatch1Item(seqNum, payload, round = 1) {
      const itemId = `${batch1Id}-${String(seqNum).padStart(3, "0")}`;
      return fetch(`${srv.baseUrl}/api/review/batches/${batch1Id}/items/${itemId}/${round}`, {
        method: "PATCH",
        headers: {
          "Cf-Access-Jwt-Assertion": validJwt,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    }

    // Toggle check on item 001: 3 -> null -> 3
    assert.equal((await patchBatch1Item(1, { tier: 3 })).status, 200);
    assert.equal((await (await patchBatch1Item(1, { tier: null })).json()).item.tier, null);
    assert.equal((await patchBatch1Item(1, { tier: 3, note: "神图入库" })).status, 200);

    // Diverse v4 verdicts across items 002..011 (leaving 012 unjudged before revoke):
    // 001: tier=3               -> archive
    // 002: tier=2               -> archive
    // 003: tier=1               -> archive
    // 004: tier=0               -> archive (0-star collection!)
    // 005: tier=3 + R           -> archive + redraw=true
    // 006: tier=0 + R           -> archive + redraw=true (0-star + redraw!)
    // 007: tier=3 + H           -> repair (intent_tier=3) + redraw=false
    // 008: tier=0 + F + O       -> repair (intent_tier=0) + redraw=false
    // 009: tier=2 + H + R       -> repair (intent_tier=2) + redraw=true
    // 010: null + R             -> discard + redraw=true
    // 011: null + note          -> discard + redraw=false
    // 012: untouched initially  -> discard -> revoked & changed to tier=1 (archive)
    assert.equal((await patchBatch1Item(2, { tier: 2 })).status, 200);
    assert.equal((await patchBatch1Item(3, { tier: 1 })).status, 200);
    assert.equal((await patchBatch1Item(4, { tier: 0, note: "0星收藏测试" })).status, 200);
    assert.equal((await patchBatch1Item(5, { tier: 3, flags: ["R"] })).status, 200);
    assert.equal((await patchBatch1Item(6, { tier: 0, flags: ["R"] })).status, 200);
    assert.equal((await patchBatch1Item(7, { tier: 3, flags: ["H"], note: "修左手拇指" })).status, 200);
    assert.equal((await patchBatch1Item(8, { tier: 0, flags: ["F", "O"] })).status, 200);
    assert.equal((await patchBatch1Item(9, { tier: 2, flags: ["H", "R"] })).status, 200);
    assert.equal((await patchBatch1Item(10, { flags: ["R"], note: "仅重抽" })).status, 200);
    assert.equal((await patchBatch1Item(11, { note: "构图杂乱不收" })).status, 200);

    // Premature CLI ack & HTTP ack before review_done=true -> rejected!
    const prematureCliAck = await runMuseCli(["ack", "--batch", batch1Id]);
    assert.equal(prematureCliAck.status, 2);
    assert.match(prematureCliAck.stdout, /review_not_done/);

    const prematureHttpAck = await fetch(`${srv.baseUrl}/api/agent/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MUSE_AGENT_TOKEN}`,
        "X-Agent-Id": MUSE_AGENT_ID,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ batch_id: batch1Id, items: [] }),
    });
    assert.equal(prematureHttpAck.status, 409);
    assert.equal((await prematureHttpAck.json()).error, "review_not_done");

    // Lock batch (review_done: true) and verify review_done_at + 409 batch_locked
    const lock1Res = await fetch(`${srv.baseUrl}/api/review/batches/${batch1Id}/done`, {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": validJwt,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ review_done: true }),
    });
    assert.equal(lock1Res.status, 200);
    const lock1Batch = (await lock1Res.json()).batch;
    assert.equal(lock1Batch.review_done, true);
    assert.ok(typeof lock1Batch.review_done_at === "string" && lock1Batch.review_done_at.length > 0);
    assert.equal((await patchBatch1Item(12, { tier: 1 })).status, 409);

    // Revoke review_done -> false, update item 012 to tier = 1 (archive), then re-lock!
    const revokeRes = await fetch(`${srv.baseUrl}/api/review/batches/${batch1Id}/done`, {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": validJwt,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ review_done: false }),
    });
    assert.equal(revokeRes.status, 200);
    const revokedBatch = (await revokeRes.json()).batch;
    assert.equal(revokedBatch.review_done, false);
    assert.equal(revokedBatch.review_done_at, null);

    assert.equal((await patchBatch1Item(12, { tier: 1, note: "撤回后补收1星" })).status, 200);

    const lock2Res = await fetch(`${srv.baseUrl}/api/review/batches/${batch1Id}/done`, {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": validJwt,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ review_done: true }),
    });
    assert.equal(lock2Res.status, 200);
    assert.ok((await lock2Res.json()).batch.review_done_at);

    // =========================================================================
    // 4. Read-Only `pull`, `mark-archived` Guard, 409 Server Gates & Full `ack` Purge
    // =========================================================================
    logStep("4. Read-Only pull (Zero File Movement), mark-archived Guard, Ack 409 Gates & Full Purge");

    const pull1Proc = await runMuseCli(["pull", "--batch", batch1Id]);
    assert.equal(pull1Proc.status, 0, `hub_client.py pull failed: ${pull1Proc.stderr}`);
    const pull1Out = JSON.parse(pull1Proc.stdout);
    assert.equal(pull1Out.review_done, true);
    assert.deepEqual(pull1Out.counts, {
      pushed: 12,
      archive: 7, // 001, 002, 003, 004(tier 0), 005(3+R), 006(0+R), 012(1)
      repair: 3, // 007(3+H), 008(0+F,O), 009(2+H,R)
      discard: 2, // 010(R), 011(note)
      redraw: 4, // 005, 006, 009, 010
    });

    // CRITICAL v4 RULE (§6.1.1): ALL 12 originals + .txt + .json sidecars MUST remain untouched in place!
    for (let i = 1; i <= 12; i++) {
      const stem = `secret_gpt_seed_${String(i).padStart(3, "0")}`;
      assert.ok(fs.existsSync(path.join(batch1OrigDir, `${stem}.png`)), `Original ${stem}.png moved!`);
      assert.ok(fs.existsSync(path.join(batch1OrigDir, `${stem}.txt`)), `Sidecar ${stem}.txt moved!`);
      assert.ok(fs.existsSync(path.join(batch1OrigDir, `${stem}.json`)), `Sidecar ${stem}.json moved!`);
    }
    assert.equal(fs.existsSync(path.join(museWorkspaceDir, "_trash")), false, "_trash must NOT be created by pull");

    // Verify ledger accurately stored final_tier (including 0!), intent_tier (including 0 & 3!), and repair_flags
    const byId = new Map(pull1Out.items.map((it) => [it.item_id, it]));
    assert.equal(byId.get(`${batch1Id}-004`).final_tier, 0);
    assert.equal(byId.get(`${batch1Id}-006`).final_tier, 0);
    assert.equal(byId.get(`${batch1Id}-006`).redraw, true);
    assert.equal(byId.get(`${batch1Id}-007`).destination, "repair");
    assert.equal(byId.get(`${batch1Id}-007`).intent_tier, 3);
    assert.deepEqual(byId.get(`${batch1Id}-007`).repair_flags, ["H"]);
    assert.equal(byId.get(`${batch1Id}-008`).destination, "repair");
    assert.equal(byId.get(`${batch1Id}-008`).intent_tier, 0);
    assert.deepEqual(byId.get(`${batch1Id}-008`).repair_flags, ["F", "O"]);

    // Verify `mark-archived` rejects repair (007) and discard (010) items with non-zero exit code!
    const markRepairFail = await runMuseCli([
      "mark-archived",
      "--batch",
      batch1Id,
      "--item-id",
      `${batch1Id}-007`,
      "--archive-ref",
      "illegal/repair.png",
    ]);
    assert.notEqual(markRepairFail.status, 0, "mark-archived must reject repair item");

    const markDiscardFail = await runMuseCli([
      "mark-archived",
      "--batch",
      batch1Id,
      "--item-id",
      `${batch1Id}-010`,
      "--archive-ref",
      "illegal/discard.png",
    ]);
    assert.notEqual(markDiscardFail.status, 0, "mark-archived must reject discard item");

    // Verify local pre-ack safety gate blocks `hub_client.py ack` before all 7 archive items have archive_ref!
    const localBlockedAck = await runMuseCli(["ack", "--batch", batch1Id]);
    assert.equal(localBlockedAck.status, 2);
    const localBlockedJson = JSON.parse(localBlockedAck.stdout);
    assert.equal(localBlockedJson.error, "ack_blocked_by_ledger_gate");
    assert.equal(localBlockedJson.missing_items.length, 7);

    // Verify server-side `POST /api/agent/ack` 409 gates directly (without deleting R2 or D1!):
    const fullAckTemplate = pull1Out.items.map((it) => ({
      item_id: it.item_id,
      round: it.round,
      destination: it.destination,
      redraw: it.redraw,
      archive_ref: it.destination === "archive" ? `vault/${it.item_id}.png` : null,
    }));

    // (a) Missing item -> 409 items_coverage_mismatch
    const covMismatchRes = await fetch(`${srv.baseUrl}/api/agent/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MUSE_AGENT_TOKEN}`,
        "X-Agent-Id": MUSE_AGENT_ID,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ batch_id: batch1Id, items: fullAckTemplate.slice(0, 11) }),
    });
    assert.equal(covMismatchRes.status, 409);
    assert.equal((await covMismatchRes.json()).error, "items_coverage_mismatch");

    // (b) Stale disposition (item 012 submitted as old pre-revoke "discard") -> 409 disposition_mismatch
    const staleItems = fullAckTemplate.map((it) =>
      it.item_id === `${batch1Id}-012` ? { ...it, destination: "discard", archive_ref: null } : it
    );
    const dispMismatchRes = await fetch(`${srv.baseUrl}/api/agent/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MUSE_AGENT_TOKEN}`,
        "X-Agent-Id": MUSE_AGENT_ID,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ batch_id: batch1Id, items: staleItems }),
    });
    assert.equal(dispMismatchRes.status, 409);
    assert.equal((await dispMismatchRes.json()).error, "disposition_mismatch");

    // (c) Empty archive_ref on tier=0 archive item (004) -> 409 missing_archive_ref
    const missingRefPayload = fullAckTemplate.map((it) =>
      it.item_id === `${batch1Id}-004` ? { ...it, archive_ref: "  " } : it
    );
    const missingRefRes = await fetch(`${srv.baseUrl}/api/agent/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MUSE_AGENT_TOKEN}`,
        "X-Agent-Id": MUSE_AGENT_ID,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ batch_id: batch1Id, items: missingRefPayload }),
    });
    assert.equal(missingRefRes.status, 409);
    const missingRefJson = await missingRefRes.json();
    assert.equal(missingRefJson.error, "missing_archive_ref");
    assert.deepEqual(missingRefJson.missing_items, [`${batch1Id}-004`]);
    assert.equal(harness.r2.keys(`previews/${MUSE_AGENT_ID}/${batch1Id}/`).length, 12);

    // Backfill all 7 archive items in local ledger (testing --archive-ref, --drive-path alias, and --from-json)
    const archiveItems = pull1Out.items.filter((it) => it.destination === "archive");
    assert.equal(archiveItems.length, 7);

    const m1 = await runMuseCli([
      "mark-archived",
      "--batch",
      batch1Id,
      "--item-id",
      archiveItems[0].item_id,
      "--archive-ref",
      `gdrive:aigc/成图收录/神图/${archiveItems[0].item_id}.png`,
    ]);
    assert.equal(m1.status, 0, m1.stderr);

    const m2 = await runMuseCli([
      "mark-archived",
      "--batch",
      batch1Id,
      "--item-id",
      archiveItems[1].item_id,
      "--drive-path",
      `gdrive:aigc/成图收录/心动/${archiveItems[1].item_id}.png`,
    ]);
    assert.equal(m2.status, 0, m2.stderr);

    const remainingArchiveMap = {};
    for (const entry of archiveItems.slice(2)) {
      remainingArchiveMap[entry.item_id] = `gdrive:aigc/成图收录/tier_${entry.final_tier}/${entry.item_id}.png`;
    }
    const backfillJsonPath = path.join(E2E_SANDBOX, "archive-refs-batch1.json");
    fs.writeFileSync(backfillJsonPath, JSON.stringify(remainingArchiveMap, null, 2), "utf8");

    const mRest = await runMuseCli([
      "mark-archived",
      "--batch",
      batch1Id,
      "--from-json",
      backfillJsonPath,
    ]);
    assert.equal(mRest.status, 0, mRest.stderr);

    // Execute real `hub_client.py ack` -> 200 OK with receipt, purging all 12 R2 previews & D1 rows!
    const ack1Proc = await runMuseCli(["ack", "--batch", batch1Id]);
    assert.equal(ack1Proc.status, 0, `hub_client.py ack failed: ${ack1Proc.stderr}`);
    const ack1Out = JSON.parse(ack1Proc.stdout);
    assert.equal(ack1Out.ok, true);
    assert.equal(ack1Out.batch_id, batch1Id);
    assert.equal(ack1Out.purged_previews, 12);
    assert.deepEqual(ack1Out.receipt, {
      archive: [
        `${batch1Id}-001`,
        `${batch1Id}-002`,
        `${batch1Id}-003`,
        `${batch1Id}-004`,
        `${batch1Id}-005`,
        `${batch1Id}-006`,
        `${batch1Id}-012`,
      ],
      repair: [`${batch1Id}-007`, `${batch1Id}-008`, `${batch1Id}-009`],
      discard: [`${batch1Id}-010`, `${batch1Id}-011`],
      redraw: [`${batch1Id}-005`, `${batch1Id}-006`, `${batch1Id}-009`, `${batch1Id}-010`],
    });

    assert.equal(harness.r2.keys(`previews/${MUSE_AGENT_ID}/${batch1Id}/`).length, 0);
    assert.equal(
      await harness.db.prepare("SELECT * FROM batches WHERE batch_id = ?").bind(batch1Id).first(),
      null
    );
    const deletedRes = await fetch(`${srv.baseUrl}/api/review/batches/${batch1Id}`, {
      headers: { "Cf-Access-Jwt-Assertion": validJwt },
    });
    assert.equal(deletedRes.status, 404);

    // =========================================================================
    // 5. Cutover Tools (`migrate_v4_cutover.py`), Legacy Ledger Mix & `round+1` / Redraw Lineage
    // =========================================================================
    logStep("5. migrate_v4_cutover.py (mark-ledger + flip-star-table), Cutover Mix & round+1 / Redraw Lineage");

    // 5A. Test `flip-star-table` in-place atomic flip + symmetry verification
    const starTablePath = path.join(E2E_SANDBOX, "face_anchors_stars.json");
    fs.writeFileSync(
      starTablePath,
      JSON.stringify(
        {
          face_001: 1, // old 1 (god/core) -> 3
          face_002: 1, // old 1 -> 3
          face_003: 2, // stays 2
          face_004: 3, // old 3 -> 1
          face_005: 0, // stays 0
          face_006: null, // stays null
        },
        null,
        2
      ),
      "utf8"
    );

    const flipProc = await runPython([
      MIGRATE_CUTOVER_PY,
      "flip-star-table",
      "--file",
      starTablePath,
      "--in-place",
    ]);
    assert.equal(flipProc.status, 0, flipProc.stderr);
    const flipOut = JSON.parse(flipProc.stdout);
    assert.equal(flipOut.ok, true);
    assert.equal(flipOut.before_counts["1"], 2);
    assert.equal(flipOut.after_counts["3"], 2);
    assert.equal(flipOut.before_counts["3"], 1);
    assert.equal(flipOut.after_counts["1"], 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(starTablePath, "utf8")), {
      face_001: 3,
      face_002: 3,
      face_003: 2,
      face_004: 1,
      face_005: 0,
      face_006: null,
    });

    // 5B. Test `mark-ledger` idempotency + mixed pre/post cutover ledger parsing in `hub_client.py`
    const mixedWsDir = path.join(E2E_SANDBOX, "workspace-cutover-mix");
    fs.mkdirSync(mixedWsDir, { recursive: true });
    const mixedLedgerPath = path.join(mixedWsDir, "ledger-muse-main.jsonl");
    const preCutoverRows = [
      {
        item_id: "20261110-muse-main-01-001",
        batch_id: "20261110-muse-main-01",
        round: 1,
        original_path: path.join(batch1OrigDir, "secret_gpt_seed_001.png"),
        state: "archived",
        verdict: { tier: 1, flags: [], note: "legacy tier 1 = 3 stars" },
        drive_path: "AI_Archive/muse-main/legacy_001.png",
      },
      {
        item_id: "20261110-muse-main-01-002",
        batch_id: "20261110-muse-main-01",
        round: 1,
        original_path: path.join(batch1OrigDir, "secret_gpt_seed_002.png"),
        state: "archived",
        verdict: { tier: 3, flags: [], note: "legacy tier 3 = 1 star" },
        drive_path: "AI_Archive/muse-main/legacy_002.png",
      },
    ];
    fs.writeFileSync(
      mixedLedgerPath,
      preCutoverRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8"
    );

    const markLedger1 = await runPython([
      MIGRATE_CUTOVER_PY,
      "mark-ledger",
      "--ledger",
      mixedLedgerPath,
    ]);
    assert.equal(markLedger1.status, 0, markLedger1.stderr);
    assert.equal(JSON.parse(markLedger1.stdout).already_marked, false);

    const markLedger2 = await runPython([
      MIGRATE_CUTOVER_PY,
      "mark-ledger",
      "--ledger",
      mixedLedgerPath,
    ]);
    assert.equal(markLedger2.status, 0, markLedger2.stderr);
    assert.equal(JSON.parse(markLedger2.stdout).already_marked, true);

    // Append a post-cutover v4 record with tier = 0 and verify Ledger parses both eras accurately
    fs.appendFileSync(
      mixedLedgerPath,
      JSON.stringify({
        item_id: "20261119-museai-gpt-09-001",
        batch_id: "20261119-museai-gpt-09",
        round: 1,
        state: "archive",
        destination: "archive",
        final_tier: 0,
        verdict: { tier: 0, flags: [] },
        archive_ref: "gdrive:aigc/collect/001.png",
        review_done: true,
      }) + "\n",
      "utf8"
    );

    const inspectCutoverProc = await runPython([
      "-c",
      `import json, sys; sys.path.insert(0, "agent"); import hub_client; from pathlib import Path
l = hub_client.Ledger(Path(sys.argv[1]), "muse-main")
b_old = l.get_batch_view("20261110-muse-main-01")
b_new = l.get_batch_view("20261119-museai-gpt-09")
print(json.dumps({
  "old_001_tier": b_old.items[("20261110-muse-main-01-001", 1)]["final_tier"],
  "old_001_ref": b_old.items[("20261110-muse-main-01-001", 1)]["archive_ref"],
  "old_002_tier": b_old.items[("20261110-muse-main-01-002", 1)]["final_tier"],
  "new_001_tier": b_new.items[("20261119-museai-gpt-09-001", 1)]["final_tier"],
}))`,
      mixedLedgerPath,
    ]);
    assert.equal(inspectCutoverProc.status, 0, inspectCutoverProc.stderr);
    assert.deepEqual(JSON.parse(inspectCutoverProc.stdout), {
      old_001_tier: 3,
      old_001_ref: "AI_Archive/muse-main/legacy_001.png",
      old_002_tier: 1,
      new_001_tier: 0,
    });

    // 5C. Test `round+1` cross-batch repair re-push (`--repush-item`) + redraw candidate (`--parent-item-id`)
    const origRepairItemId = `${batch1Id}-007`; // Was tier=3 + H (intent_tier=3) in batch 1
    const origRedrawItemId = `${batch1Id}-005`; // Was tier=3 + R in batch 1
    await createSamplePngs([
      {
        path: path.join(followupOrigDir, "007_hands_fixed.png"),
        width: 832,
        height: 1216,
        color: [90, 190, 130],
        prompt: null, // Inherits prompt & context from round 1!
      },
      {
        path: path.join(followupOrigDir, "005_redraw_cand.png"),
        width: 832,
        height: 1216,
        color: [130, 90, 200],
        prompt: "cinematic portrait prompt #5 (redraw candidate)",
      },
    ]);

    // Reserve next gpt batch (`<YYYYMMDD>-museai-gpt-02`) via redraw candidate push, then append round=2 repair item
    const redrawPushProc = await runMuseCli([
      "push",
      path.join(followupOrigDir, "005_redraw_cand.png"),
      "--source",
      "museai",
      "--line",
      "gpt",
      "--parent-item-id",
      origRedrawItemId,
    ]);
    assert.equal(redrawPushProc.status, 0, redrawPushProc.stderr);
    const followupBatchId = JSON.parse(redrawPushProc.stdout).batch_id;
    assert.match(followupBatchId, /^\d{8}-museai-gpt-02$/);

    const repairRepushProc = await runMuseCli([
      "push",
      path.join(followupOrigDir, "007_hands_fixed.png"),
      "--batch",
      followupBatchId,
      "--source",
      "museai",
      "--line",
      "gpt",
      "--repush-item",
      origRepairItemId,
    ]);
    assert.equal(repairRepushProc.status, 0, repairRepushProc.stderr);
    const repairRepushOut = JSON.parse(repairRepushProc.stdout);
    assert.equal(repairRepushOut.pushed_count, 2);
    assert.deepEqual(repairRepushOut.accepted, [origRepairItemId]);

    const followupDetailRes = await fetch(`${srv.baseUrl}/api/review/batches/${followupBatchId}`, {
      headers: { "Cf-Access-Jwt-Assertion": validJwt },
    });
    assert.equal(followupDetailRes.status, 200);
    const followupDetail = await followupDetailRes.json();
    const repushedView = followupDetail.items.find((it) => it.item_id === origRepairItemId);
    const redrawCandView = followupDetail.items.find((it) => it.item_id === `${followupBatchId}-001`);
    assert.ok(repushedView, "Repushed repair item must retain original item_id");
    assert.equal(repushedView.round, 2);
    assert.ok(redrawCandView, "Redraw candidate must get new item_id");
    assert.equal(redrawCandView.round, 1);
    assert.equal(redrawCandView.parent_item_id, origRedrawItemId);

    console.log("\n[E2E] ALL REVIEW OUTPOST V4 CROSS-STACK ACCEPTANCE TESTS PASSED 100%!");
  } finally {
    await srv.close();
    harness.db.close();
    fs.rmSync(E2E_SANDBOX, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("\n[E2E] FAILED:", err);
  process.exit(1);
});
