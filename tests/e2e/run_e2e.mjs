#!/usr/bin/env node
/**
 * Review Outpost v4 — Live Cross-Stack End-to-End Acceptance Suite
 *
 * Runs the REAL Cloudflare Worker (`src/index.ts`) over a live localhost HTTP server
 * backed by:
 *   - Real file-backed SQLite D1 (`node:sqlite` + `migrations/0001_init.sql`)
 *   - Paginated In-Memory R2 (`r2PageSize = 5`)
 *   - Real `./public` Static Assets (`index.html`, `styles.css`, `app.js`, `robots.txt`)
 *   - Real Web Crypto RS256 JWKS verification + SHA-256 constant-time Agent Token Auth
 * and invokes the REAL `python3 agent/hub_client.py` CLI subprocess against the live port
 * to verify all 5 Acceptance Criteria in Spec §11 + Rules 1–6 end-to-end.
 *
 * Strictly uses `.test-sandboxes/e2e/` inside the repository (never `/tmp`).
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computeBucket as frontendComputeBucket } from "../../public/app.js";
import { resolveBucket as backendResolveBucket } from "../../src/buckets.js";
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
const HUB_CLIENT_PY = path.join(REPO_ROOT, "agent", "hub_client.py");
const PUBLIC_DIR = path.join(REPO_ROOT, "public");

const AGENT_ID = "muse-main";
const AGENT_TOKEN = "e2e-dummy-token-muse-main-0000000000000001";
const OTHER_AGENT_ID = "argon-mac";
const OTHER_AGENT_TOKEN = "e2e-dummy-token-argon-mac-0000000000000002";

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
  const env = { ...process.env };
  delete env.DRIVE_MOUNT_ROOT;
  delete env.RCLONE_REMOTE;
  delete env.RCLONE_BIN;
  delete env.MAX_REDRAW_ROUNDS;
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
  // Guardrail: ensure E2E sandbox is strictly inside repo and clean on start
  assert(!E2E_SANDBOX.startsWith("/tmp") && !E2E_SANDBOX.startsWith("/private/tmp"));
  fs.rmSync(E2E_SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(E2E_SANDBOX, { recursive: true });

  const sqlitePath = path.join(E2E_SANDBOX, "outpost-d1.sqlite");
  const workspaceDir = path.join(E2E_SANDBOX, "workspace");
  const batch1OrigDir = path.join(E2E_SANDBOX, "originals_batch1");
  const batch2OrigDir = path.join(E2E_SANDBOX, "originals_batch2");
  const repairedDir = path.join(E2E_SANDBOX, "repaired");
  const mountRootDir = path.join(E2E_SANDBOX, "gdrive_mount");

  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(mountRootDir, { recursive: true });

  const harness = await createTestHarness({
    sqlitePath,
    r2PageSize: 5, // Force cursor pagination across R2 list/delete on 12-item batch
    publicDir: PUBLIC_DIR,
    agentTokens: {
      [AGENT_ID]: AGENT_TOKEN,
      [OTHER_AGENT_ID]: OTHER_AGENT_TOKEN,
    },
    allowedEmails: "reviewer@example.test",
    accessAud: "e2e-access-aud-tag-0001",
  });

  const srv = await startLocalWorkerServer(harness.env, "127.0.0.1");
  console.log(`[E2E] Live Worker HTTP server listening at ${srv.baseUrl}`);

  const baseCliEnv = {
    OUTPOST_URL: srv.baseUrl,
    OUTPOST_AGENT_ID: AGENT_ID,
    OUTPOST_TOKEN: AGENT_TOKEN,
    OUTPOST_HOME: workspaceDir,
    ARCHIVE_MODE: "connector",
    ARCHIVE_LAYOUT: "ai_archive",
  };

  function runHubCli(cliArgs, extraEnv = {}) {
    return runPython([HUB_CLIENT_PY, ...cliArgs], { ...baseCliEnv, ...extraEnv });
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
    // 0. Exhaustive 3-Way Rule 3 Bucket Parity (Worker TS vs Frontend JS vs Agent PY)
    // =========================================================================
    logStep("0. Exhaustive 64-case Rule 3 Bucket Parity (src/buckets.ts == public/app.js == agent/hub_client.py)");
    const tiers = [null, 1, 2, 3];
    const flagAtoms = ["H", "F", "O", "R"];
    const testCases = [];
    for (const tier of tiers) {
      for (let mask = 0; mask < 16; mask++) {
        const flags = flagAtoms.filter((_, i) => (mask & (1 << i)) !== 0);
        testCases.push({ tier, flags });
      }
    }

    const pyBucketProc = await runPython([
      "-c",
      `import json, sys; sys.path.insert(0, "agent"); import hub_client; cases = json.loads(sys.argv[1]); print(json.dumps([hub_client.classify_bucket(c["tier"], c["flags"]) for c in cases]))`,
      JSON.stringify(testCases),
    ]);
    assert.equal(pyBucketProc.status, 0, pyBucketProc.stderr);
    const pyBuckets = JSON.parse(pyBucketProc.stdout);

    testCases.forEach((tc, idx) => {
      const bBucket = backendResolveBucket(tc.tier, tc.flags);
      const fBucket = frontendComputeBucket(tc.tier, tc.flags);
      const pBucket = pyBuckets[idx];
      assert.equal(fBucket, bBucket, `Frontend != Backend for ${JSON.stringify(tc)}`);
      assert.equal(pBucket, bBucket, `Python != Backend for ${JSON.stringify(tc)}`);
    });
    console.log(`[E2E] Verified 64/64 (tier x flags) combinations match across Backend, Frontend, and Agent CLI.`);

    // =========================================================================
    // 1. Spec §11 Criterion 5 (Part A) — Unauthenticated & Bad Token Rejection
    // =========================================================================
    logStep("1. Spec §11 (5) — Unauthenticated / Invalid JWT / Bad Agent Token Access Control");
    for (const route of [
      "/",
      "/app.js",
      "/styles.css",
      "/robots.txt",
      "/api/review/batches",
      "/api/review/previews/20261113-muse-main-01/20261113-muse-main-01-001/1",
    ]) {
      const noJwtRes = await fetch(`${srv.baseUrl}${route}`);
      assert.equal(noJwtRes.status, 401, `Expected 401 without JWT on ${route}`);
      assertSecurityHeaders(noJwtRes, `no-jwt ${route}`);

      const tamperedRes = await fetch(`${srv.baseUrl}${route}`, {
        headers: { "Cf-Access-Jwt-Assertion": validJwt.slice(0, -5) + "ZZZZZ" },
      });
      assert.equal(tamperedRes.status, 401, `Expected 401 with tampered JWT on ${route}`);

      const wrongKeyRes = await fetch(`${srv.baseUrl}${route}`, {
        headers: { "Cf-Access-Jwt-Assertion": wrongKeyJwt },
      });
      assert.equal(wrongKeyRes.status, 401, `Expected 401 with rogue RSA key on ${route}`);

      const expiredRes = await fetch(`${srv.baseUrl}${route}`, {
        headers: { "Cf-Access-Jwt-Assertion": expiredJwt },
      });
      assert.equal(expiredRes.status, 401, `Expected 401 with expired JWT on ${route}`);

      const wrongEmailRes = await fetch(`${srv.baseUrl}${route}`, {
        headers: { "Cf-Access-Jwt-Assertion": unauthorizedEmailJwt },
      });
      assert.equal(wrongEmailRes.status, 403, `Expected 403 with non-allowlisted email on ${route}`);
    }

    for (const [method, agentRoute] of [
      ["POST", "/api/agent/push"],
      ["GET", "/api/agent/verdicts?batch_id=20261113-muse-main-01"],
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

    // Verify bad agent token via real hub_client.py subprocess returns 401 failure
    const badTokCliProc = await runHubCli(["pull", "--batch", "20261113-muse-main-01"], {
      OUTPOST_TOKEN: "invalid-agent-token-xyz",
    });
    assert.notEqual(badTokCliProc.status, 0, "CLI must fail with bad OUTPOST_TOKEN");
    assert.match(badTokCliProc.stdout + badTokCliProc.stderr, /401/);

    // Verify strict /tmp rejection in real CLI subprocess
    const tmpRejectProc = await runHubCli([
      "cleanup-trash",
      "--workspace-dir",
      "/tmp/forbidden-e2e",
    ]);
    assert.equal(tmpRejectProc.status, 2, "CLI must reject /tmp workspace with exit code 2");
    assert.equal(JSON.parse(tmpRejectProc.stdout).error, "forbidden_storage_path");

    // =========================================================================
    // 2. Spec §11 Criterion 1 — Chunked Push (12 images = 10 + 2), Web UI, Previews & Verdicts
    // =========================================================================
    logStep("2. Spec §11 (1) — Chunked Push (12 images), Static Assets, Previews, Metadata & Verdicts");
    const batch1Id = "20261113-muse-main-01";
    const batch1Specs = [];
    const dimensionsCycle = [
      [832, 1216], // portrait
      [1024, 1024], // square
      [1344, 768], // landscape
    ];
    for (let i = 1; i <= 12; i++) {
      const [w, h] = dimensionsCycle[(i - 1) % dimensionsCycle.length];
      const name = `art_${String(i).padStart(3, "0")}.png`;
      batch1Specs.push({
        path: path.join(batch1OrigDir, name),
        width: w,
        height: h,
        color: [20 + i * 10, 60 + i * 8, 120 + i * 5],
        prompt: `masterpiece prompt #${i}, cinematic lighting`,
      });
    }
    await createSamplePngs(batch1Specs);

    // Push 12 images via real hub_client.py (default --chunk-size 10 -> 2 chunks: 10 + 2)
    const push1Proc = await runHubCli(["push", batch1OrigDir, "--batch", batch1Id]);
    assert.equal(push1Proc.status, 0, `hub_client.py push failed: ${push1Proc.stderr}`);
    const push1Out = JSON.parse(push1Proc.stdout);
    assert.equal(push1Out.batch_id, batch1Id);
    assert.equal(push1Out.pushed_count, 12);
    assert.equal(push1Out.accepted.length, 12);
    assert.deepEqual(push1Out.rejected, []);
    assert.equal(push1Out.chunks, 2);

    // Verify ledger-muse-main.jsonl was written with all 12 pushed entries + preview_sha256
    const ledgerPath = path.join(workspaceDir, `ledger-${AGENT_ID}.jsonl`);
    const pushedLedgerEntries = readJsonl(ledgerPath);
    assert.equal(pushedLedgerEntries.length, 12);
    assert.ok(pushedLedgerEntries.every((e) => e.state === "pushed" && e.preview_sha256?.length === 64));

    // Verify R2 holds 12 private WebP objects
    assert.equal(harness.r2.keys(`previews/${AGENT_ID}/${batch1Id}/`).length, 12);

    // Fetch real Static Assets (/, /app.js, /styles.css, /robots.txt) with valid RS256 Access JWT
    const indexRes = await fetch(`${srv.baseUrl}/`, {
      headers: { "Cf-Access-Jwt-Assertion": validJwt },
    });
    assert.equal(indexRes.status, 200);
    assertSecurityHeaders(indexRes, "GET /");
    const indexHtml = await indexRes.text();
    assert.match(indexHtml, /noindex,\s*nofollow,\s*noarchive/);
    assert.match(indexHtml, /撤回审完状态/);
    assert.match(indexHtml, /mode-grid/);

    const appJsRes = await fetch(`${srv.baseUrl}/app.js`, {
      headers: { "Cf-Access-Jwt-Assertion": validJwt },
    });
    assert.equal(appJsRes.status, 200);
    assertSecurityHeaders(appJsRes, "GET /app.js");
    const appJsText = await appJsRes.text();
    assert.match(appJsText, /aspectRatio/);

    // Fetch batch detail via /api/review/batches/:id and verify D1 metadata (width, height, filename)
    const detail1Res = await fetch(`${srv.baseUrl}/api/review/batches/${batch1Id}`, {
      headers: { "Cf-Access-Jwt-Assertion": validJwt },
    });
    assert.equal(detail1Res.status, 200);
    assertSecurityHeaders(detail1Res, "GET /api/review/batches/:id");
    const detail1Json = await detail1Res.json();
    assert.equal(detail1Json.batch.pushed_count, 12);
    assert.equal(detail1Json.batch.review_done, false);
    assert.equal(detail1Json.items.length, 12);
    assert.equal(detail1Json.items[0].filename, "art_001.png");
    assert.equal(detail1Json.items[0].width, 832);
    assert.equal(detail1Json.items[0].height, 1216);
    assert.equal(detail1Json.items[1].width, 1024);
    assert.equal(detail1Json.items[1].height, 1024);
    assert.equal(detail1Json.items[2].width, 1344);
    assert.equal(detail1Json.items[2].height, 768);

    // Fetch real R2 preview via Worker route: verify 401 without JWT, 200 WebP matching ledger sha256 with JWT
    const item001PreviewUrl = `${srv.baseUrl}${detail1Json.items[0].preview_url}`;
    const unauthPreviewRes = await fetch(item001PreviewUrl);
    assert.equal(unauthPreviewRes.status, 401, "Live preview must reject unauthenticated fetch");

    const authPreviewRes = await fetch(item001PreviewUrl, {
      headers: { "Cf-Access-Jwt-Assertion": validJwt },
    });
    assert.equal(authPreviewRes.status, 200);
    assert.equal(authPreviewRes.headers.get("content-type"), "image/webp");
    assertSecurityHeaders(authPreviewRes, "GET preview WebP");
    const previewBytes = Buffer.from(await authPreviewRes.arrayBuffer());
    assert.equal(previewBytes.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(previewBytes.subarray(8, 12).toString("ascii"), "WEBP");
    const previewSha = crypto.createHash("sha256").update(previewBytes).digest("hex");
    assert.equal(previewSha, pushedLedgerEntries[0].preview_sha256);

    // Cross-agent isolation check against live batch
    const crossAgentRes = await fetch(`${srv.baseUrl}/api/agent/verdicts?batch_id=${batch1Id}`, {
      headers: {
        Authorization: `Bearer ${OTHER_AGENT_TOKEN}`,
        "X-Agent-Id": OTHER_AGENT_ID,
      },
    });
    assert.equal(crossAgentRes.status, 403);

    // Reviewer applies 1/2/3 tiers (including toggle back to null & re-set) + H/F/O/R stackable flags + N notes
    async function patchVerdict(seqNum, payload, round = 1) {
      const itemId = `${batch1Id}-${String(seqNum).padStart(3, "0")}`;
      const res = await fetch(`${srv.baseUrl}/api/review/batches/${batch1Id}/items/${itemId}/${round}`, {
        method: "PATCH",
        headers: {
          "Cf-Access-Jwt-Assertion": validJwt,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      return res;
    }

    // Toggle test on item 001: 1 -> null -> 1
    assert.equal((await patchVerdict(1, { tier: 1 })).status, 200);
    const toggledNullRes = await patchVerdict(1, { tier: null });
    assert.equal(toggledNullRes.status, 200);
    assert.equal((await toggledNullRes.json()).item.tier, null);
    assert.equal((await patchVerdict(1, { tier: 1, flags: [], note: "神图收录" })).status, 200);

    // Remaining judgments across all buckets:
    assert.equal((await patchVerdict(2, { tier: 2, flags: [], note: "心动光影" })).status, 200);
    assert.equal((await patchVerdict(3, { tier: 3, flags: [] })).status, 200);
    assert.equal(
      (await patchVerdict(4, { tier: 1, flags: ["H"], note: "修左手食指，保留1档" })).status,
      200
    );
    assert.equal(
      (await patchVerdict(5, { tier: 2, flags: ["F", "O"], note: "修脚部与背景杂物" })).status,
      200
    );
    assert.equal((await patchVerdict(6, { tier: 1, flags: ["H", "R"] })).status, 200); // H beats R -> repair
    assert.equal((await patchVerdict(7, { tier: null, flags: ["R"], note: "重抽一版" })).status, 200);
    assert.equal((await patchVerdict(8, { tier: 3, flags: ["R"] })).status, 200); // R beats tier -> redraw
    assert.equal((await patchVerdict(9, { tier: null, flags: [], note: "构图散乱不收" })).status, 200);
    // Items 010, 011, 012 left unjudged for now

    // =========================================================================
    // 3. Spec §11 Criterion 2 — Reject Ack Before Done, Lock/Revoke, Pull Verdicts
    // =========================================================================
    logStep("3. Spec §11 (2) — Premature Ack Rejection, review_done Lock/Revoke, and hub_client.py pull");

    // Pull while review_done=false -> read-only, does NOT move discarded items to _trash
    const earlyPullProc = await runHubCli(["pull", "--batch", batch1Id]);
    assert.equal(earlyPullProc.status, 0);
    assert.equal(JSON.parse(earlyPullProc.stdout).review_done, false);
    assert.ok(fs.existsSync(path.join(batch1OrigDir, "art_010.png")));

    // CLI ack before review_done=true -> blocked
    const earlyAckCli = await runHubCli(["ack", "--batch", batch1Id]);
    assert.notEqual(earlyAckCli.status, 0);
    assert.match(earlyAckCli.stdout, /review_not_done/);

    // Direct HTTP POST /api/agent/ack before review_done=true -> 409 review_not_done
    const earlyAckHttp = await fetch(`${srv.baseUrl}/api/agent/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AGENT_TOKEN}`,
        "X-Agent-Id": AGENT_ID,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        batch_id: batch1Id,
        counts: { pushed: 12, archived: 3, repair: 3, redraw: 2, discarded: 4 },
      }),
    });
    assert.equal(earlyAckHttp.status, 409);
    assert.equal((await earlyAckHttp.json()).error, "review_not_done");

    // Click「审完本批」(review_done: true)
    const markDone1 = await fetch(`${srv.baseUrl}/api/review/batches/${batch1Id}/done`, {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": validJwt,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ review_done: true }),
    });
    assert.equal(markDone1.status, 200);
    assert.equal((await markDone1.json()).batch.review_done, true);

    // Locked batch rejects PATCH with 409 batch_locked
    const lockedPatch = await patchVerdict(12, { tier: 2 });
    assert.equal(lockedPatch.status, 409);

    // Click「撤回审完状态」(review_done: false) before ack, modify item 012 -> tier=2, then re-lock!
    const revokeDone = await fetch(`${srv.baseUrl}/api/review/batches/${batch1Id}/done`, {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": validJwt,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ review_done: false }),
    });
    assert.equal(revokeDone.status, 200);
    assert.equal((await revokeDone.json()).batch.review_done, false);

    const unlockedPatch12 = await patchVerdict(12, {
      tier: 2,
      flags: [],
      note: "撤回审完后补收2档",
    });
    assert.equal(unlockedPatch12.status, 200);

    const markDone2 = await fetch(`${srv.baseUrl}/api/review/batches/${batch1Id}/done`, {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": validJwt,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ review_done: true }),
    });
    assert.equal(markDone2.status, 200);

    // Run real hub_client.py pull
    const pull1Proc = await runHubCli(["pull", "--batch", batch1Id]);
    assert.equal(pull1Proc.status, 0, `hub_client.py pull failed: ${pull1Proc.stderr}`);
    const pull1Out = JSON.parse(pull1Proc.stdout);
    const expectedBatch1Counts = {
      pushed: 12,
      archived: 4, // 001, 002, 003, 012
      repair: 3, // 004 (tier 1 + H), 005 (tier 2 + F,O), 006 (tier 1 + H,R)
      redraw: 2, // 007 (R), 008 (tier 3 + R)
      discarded: 3, // 009 (note only), 010, 011
    };
    assert.equal(pull1Out.review_done, true);
    assert.deepEqual(pull1Out.counts, expectedBatch1Counts);

    // Verify discarded originals (009, 010, 011) moved to _trash/<batch1Id>/
    for (const trashedName of ["art_009.png", "art_010.png", "art_011.png"]) {
      assert.ok(!fs.existsSync(path.join(batch1OrigDir, trashedName)), `${trashedName} should leave originals`);
      assert.ok(
        fs.existsSync(path.join(workspaceDir, "_trash", batch1Id, trashedName)),
        `${trashedName} should exist in _trash`
      );
    }

    // Verify repair item 004 preserved tier=1 in local ledger
    const ledgerAfterPull1 = readJsonl(ledgerPath);
    const repair004 = ledgerAfterPull1.find(
      (r) => r.item_id === `${batch1Id}-004` && r.round === 1 && r.state === "repair"
    );
    assert.ok(repair004, "Missing state=repair ledger record for item 004");
    assert.equal(repair004.verdict.tier, 1);
    assert.deepEqual(repair004.verdict.flags, ["H"]);

    // =========================================================================
    // 4. Spec §11 Criterion 3 — Ack 409 Count Mismatch, Connector Gate, Backfill & Purge
    // =========================================================================
    logStep("4. Spec §11 (3) — Ack 409 Count Mismatch, Connector Pre-Ack Gate, Backfill & Physical Purge");

    // Tampered count submission -> HTTP 409 counts_mismatch + cloud_counts returned, 0 deletions
    const mismatchAckRes = await fetch(`${srv.baseUrl}/api/agent/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AGENT_TOKEN}`,
        "X-Agent-Id": AGENT_ID,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        batch_id: batch1Id,
        counts: { pushed: 12, archived: 5, repair: 2, redraw: 2, discarded: 3 },
      }),
    });
    assert.equal(mismatchAckRes.status, 409);
    const mismatchBody = await mismatchAckRes.json();
    assert.equal(mismatchBody.error, "counts_mismatch");
    assert.deepEqual(mismatchBody.cloud_counts, expectedBatch1Counts);
    assert.equal(harness.r2.keys(`previews/${AGENT_ID}/${batch1Id}/`).length, 12);

    // Connector mode archive-plan outputs exact 4 archived items
    const plan1Proc = await runHubCli(["archive-plan", "--batch", batch1Id]);
    assert.equal(plan1Proc.status, 0, plan1Proc.stderr);
    const plan1 = JSON.parse(plan1Proc.stdout);
    assert.equal(plan1.archive_mode, "connector");
    assert.equal(plan1.items.length, 4);
    assert.equal(plan1.items[0].target_drive_path, `AI_Archive/${AGENT_ID}/${batch1Id}/art_001.png`);
    assert.equal(plan1.items[0].prompt_target_drive_path, `AI_Archive/${AGENT_ID}/${batch1Id}/art_001.txt`);

    // Connector mode pre-ack safety gate: refuses ack locally BEFORE drive_path backfill!
    const blockedAckProc = await runHubCli(["ack", "--batch", batch1Id]);
    assert.equal(blockedAckProc.status, 2);
    const blockedAckJson = JSON.parse(blockedAckProc.stdout);
    assert.equal(blockedAckJson.error, "ack_blocked_by_ledger_gate");
    assert.equal(blockedAckJson.pending_uploads.length, 4);
    // Cloud batch must still exist untouched
    assert.equal(harness.r2.keys(`previews/${AGENT_ID}/${batch1Id}/`).length, 12);

    // Backfill item 001 via CLI flags and items 002, 003, 012 via --from-json
    const markOneProc = await runHubCli([
      "mark-archived",
      "--batch",
      batch1Id,
      "--item-id",
      plan1.items[0].item_id,
      "--drive-path",
      plan1.items[0].target_drive_path,
    ]);
    assert.equal(markOneProc.status, 0, markOneProc.stderr);

    const backfillJsonPath = path.join(E2E_SANDBOX, "connector-backfill.json");
    const remainingMap = {};
    for (const entry of plan1.items.slice(1)) {
      remainingMap[entry.item_id] = entry.target_drive_path;
    }
    fs.writeFileSync(backfillJsonPath, JSON.stringify(remainingMap, null, 2), "utf8");

    const markRestProc = await runHubCli([
      "mark-archived",
      "--batch",
      batch1Id,
      "--from-json",
      backfillJsonPath,
    ]);
    assert.equal(markRestProc.status, 0, markRestProc.stderr);

    // Now run hub_client.py ack -> must succeed and physically delete all 12 R2 objects + D1 rows!
    const ack1Proc = await runHubCli(["ack", "--batch", batch1Id]);
    assert.equal(ack1Proc.status, 0, `hub_client.py ack failed: ${ack1Proc.stderr}`);
    const ack1Json = JSON.parse(ack1Proc.stdout);
    assert.equal(ack1Json.ok, true);
    assert.equal(ack1Json.cloud_response.deleted_previews, 12);

    assert.equal(harness.r2.keys(`previews/${AGENT_ID}/${batch1Id}/`).length, 0);
    const d1Batch1Row = await harness.db
      .prepare("SELECT * FROM batches WHERE batch_id = ?")
      .bind(batch1Id)
      .first();
    assert.equal(d1Batch1Row, null);
    const d1Verdicts1 = await harness.db
      .prepare("SELECT * FROM verdicts WHERE batch_id = ?")
      .bind(batch1Id)
      .all();
    assert.equal(d1Verdicts1.results.length, 0);

    const deletedBatchRes = await fetch(`${srv.baseUrl}/api/review/batches/${batch1Id}`, {
      headers: { "Cf-Access-Jwt-Assertion": validJwt },
    });
    assert.equal(deletedBatchRes.status, 404);

    // =========================================================================
    // 5. Spec §11 Criterion 4 — ARCHIVE_MODE=mount Auto Archive + Backup + round+1 Re-push
    // =========================================================================
    logStep("5. Spec §11 (4) — ARCHIVE_MODE=mount Full Auto-Archive + Ledger Backup + round+1 Cross-Batch Re-push");
    const batch2Id = "20261113-muse-main-02";
    const origRepairItemId = `${batch1Id}-004`; // Was tier=1 + H in batch 1

    // Create repaired image WITHOUT sidecar .txt (verifies prompt carry-forward from round 1!)
    // plus 2 fresh images for batch 2
    await createSamplePngs([
      {
        path: path.join(repairedDir, "art_004_hands_repaired.png"),
        width: 832,
        height: 1216,
        color: [90, 180, 140],
        prompt: null,
      },
      {
        path: path.join(batch2OrigDir, "fresh_01.png"),
        width: 1024,
        height: 1024,
        color: [180, 90, 140],
        prompt: "fresh batch2 masterpiece, glowing forest",
      },
      {
        path: path.join(batch2OrigDir, "fresh_02.png"),
        width: 1344,
        height: 768,
        color: [70, 110, 210],
        prompt: "fresh batch2 draft, misty river",
      },
    ]);

    const mountEnv = {
      ARCHIVE_MODE: "mount",
      ARCHIVE_LAYOUT: "ai_archive",
      DRIVE_MOUNT_ROOT: mountRootDir,
    };

    // Push fresh images + round+1 repaired item into batch 2 (chunked append to same batch_id)
    const push2FreshProc = await runHubCli(["push", batch2OrigDir, "--batch", batch2Id], mountEnv);
    assert.equal(push2FreshProc.status, 0, push2FreshProc.stderr);

    const push2RepairProc = await runHubCli(
      [
        "push",
        path.join(repairedDir, "art_004_hands_repaired.png"),
        "--batch",
        batch2Id,
        "--repush-item",
        origRepairItemId,
      ],
      mountEnv
    );
    assert.equal(push2RepairProc.status, 0, push2RepairProc.stderr);
    const push2RepairOut = JSON.parse(push2RepairProc.stdout);
    assert.equal(push2RepairOut.pushed_count, 3);
    assert.deepEqual(push2RepairOut.accepted, [origRepairItemId]);

    // Verify batch 2 contains original item_id `20261113-muse-main-01-004` at `round = 2`!
    const detail2Res = await fetch(`${srv.baseUrl}/api/review/batches/${batch2Id}`, {
      headers: { "Cf-Access-Jwt-Assertion": validJwt },
    });
    assert.equal(detail2Res.status, 200);
    const detail2Json = await detail2Res.json();
    const repushedItemView = detail2Json.items.find((it) => it.item_id === origRepairItemId);
    assert.ok(repushedItemView, "Repushed item must keep its original item_id in batch 2");
    assert.equal(repushedItemView.round, 2);
    assert.equal(repushedItemView.width, 832);
    assert.equal(repushedItemView.height, 1216);

    // Reviewer approves repaired round=2 item (tier=1) & fresh_01 (tier=2), leaves fresh_02 discarded
    const approveRepairedRes = await fetch(
      `${srv.baseUrl}/api/review/batches/${batch2Id}/items/${origRepairItemId}/2`,
      {
        method: "PATCH",
        headers: {
          "Cf-Access-Jwt-Assertion": validJwt,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tier: 1, flags: [], note: "手指已修好，按原定1档入库" }),
      }
    );
    assert.equal(approveRepairedRes.status, 200);

    const approveFresh1Res = await fetch(
      `${srv.baseUrl}/api/review/batches/${batch2Id}/items/${batch2Id}-001/1`,
      {
        method: "PATCH",
        headers: {
          "Cf-Access-Jwt-Assertion": validJwt,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tier: 2, flags: [] }),
      }
    );
    assert.equal(approveFresh1Res.status, 200);

    const doneBatch2Res = await fetch(`${srv.baseUrl}/api/review/batches/${batch2Id}/done`, {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": validJwt,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ review_done: true }),
    });
    assert.equal(doneBatch2Res.status, 200);

    // Pull batch 2 verdicts first in connector mode, then preview ARCHIVE_LAYOUT=aigc_tier target routing
    const pull2ConnectorProc = await runHubCli(["pull", "--batch", batch2Id], {
      ARCHIVE_MODE: "connector",
    });
    assert.equal(pull2ConnectorProc.status, 0, pull2ConnectorProc.stderr);

    const tierPlanProc = await runHubCli(["archive-plan", "--batch", batch2Id], {
      ARCHIVE_MODE: "connector",
      ARCHIVE_LAYOUT: "aigc_tier",
    });
    assert.equal(tierPlanProc.status, 0, tierPlanProc.stderr);
    const tierPlanJson = JSON.parse(tierPlanProc.stdout);
    const tier1Entry = tierPlanJson.items.find((it) => it.item_id === origRepairItemId);
    const tier2Entry = tierPlanJson.items.find((it) => it.item_id === `${batch2Id}-001`);
    assert.equal(
      tier1Entry.target_drive_path,
      "aigc/成图收录/20261113/1-神图/art_004_hands_repaired.png"
    );
    assert.equal(tier2Entry.target_drive_path, "aigc/成图收录/20261113/2-心动/fresh_01.png");

    // Execute full automatic mount archive + ack + ledger backup!
    const mountExecProc = await runHubCli(
      ["archive-plan", "--batch", batch2Id, "--execute"],
      mountEnv
    );
    assert.equal(mountExecProc.status, 0, `mount execute failed: ${mountExecProc.stderr}`);
    const mountExecJson = JSON.parse(mountExecProc.stdout);
    assert.equal(mountExecJson.executed, true);
    assert.equal(mountExecJson.ack.ok, true);

    // Verify simulated Google Drive mount files: originals + paired .txt prompts + ledger backup!
    const mountBatch2Dir = path.join(mountRootDir, "AI_Archive", AGENT_ID, batch2Id);
    assert.ok(fs.existsSync(path.join(mountBatch2Dir, "art_004_hands_repaired.png")));
    assert.equal(
      fs.readFileSync(path.join(mountBatch2Dir, "art_004_hands_repaired.txt"), "utf8"),
      "masterpiece prompt #4, cinematic lighting"
    );
    assert.ok(fs.existsSync(path.join(mountBatch2Dir, "fresh_01.png")));
    assert.equal(
      fs.readFileSync(path.join(mountBatch2Dir, "fresh_01.txt"), "utf8"),
      "fresh batch2 masterpiece, glowing forest"
    );

    const mountLedgerBackup = path.join(mountRootDir, "AI_Archive", `ledger-${AGENT_ID}.jsonl`);
    assert.ok(fs.existsSync(mountLedgerBackup), "Ledger backup must exist at mount archive root");
    const backedUpRecords = readJsonl(mountLedgerBackup);
    assert.ok(
      backedUpRecords.some(
        (r) => r.item_id === origRepairItemId && r.round === 1 && r.state === "repair" && r.verdict?.tier === 1
      ),
      "Round 1 repair history must remain intact in backed-up ledger"
    );
    assert.ok(
      backedUpRecords.some(
        (r) =>
          r.item_id === origRepairItemId &&
          r.round === 2 &&
          r.state === "archived" &&
          r.drive_path === `AI_Archive/${AGENT_ID}/${batch2Id}/art_004_hands_repaired.png`
      ),
      "Round 2 archived drive_path must be recorded in backed-up ledger"
    );
    assert.equal(
      backedUpRecords.filter((r) => r.state === "batch_acked").length,
      2,
      "Both batch 1 and batch 2 must be recorded as batch_acked"
    );

    // Verify batch 2 R2 objects and D1 rows are physically purged
    assert.equal(harness.r2.keys().length, 0);
    const postAckBatch2Res = await fetch(`${srv.baseUrl}/api/review/batches/${batch2Id}`, {
      headers: { "Cf-Access-Jwt-Assertion": validJwt },
    });
    assert.equal(postAckBatch2Res.status, 404);

    console.log("\n[E2E] ALL 5 SPEC §11 ACCEPTANCE CRITERIA & RULES 1–6 PASSED 100%!");
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
