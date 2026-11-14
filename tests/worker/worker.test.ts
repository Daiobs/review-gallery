import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearJwksCache } from "../../src/auth.js";
import { computeBatchCounts, resolveBucket } from "../../src/buckets.js";
import { runCleanup } from "../../src/cleanup.js";
import worker from "../../src/index.js";
import {
  WORKER_SANDBOX_DIR,
  createTestAccessKeys,
  createTestHarness,
  signTestAccessJwt,
  startLocalWorkerServer,
} from "./test-env.js";

function makeFakeWebpBytes(label: string): Uint8Array {
  // Minimal RIFF....WEBP header + deterministic payload
  const payload = new TextEncoder().encode(label);
  const out = new Uint8Array(12 + payload.byteLength);
  out.set([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50], 0);
  out.set(payload, 12);
  return out;
}

function buildPushRequest(options: {
  token: string;
  headerAgentId?: string | null;
  manifestAgentId: string;
  batchId: string;
  items: Array<{
    item_id: string;
    round: number;
    filename?: string;
    width?: number;
    height?: number;
    bytes?: Uint8Array | null;
  }>;
}): Request {
  const form = new FormData();
  const manifest = {
    agent_id: options.manifestAgentId,
    batch_id: options.batchId,
    items: options.items.map(({ item_id, round, filename, width, height }) => ({
      item_id,
      round,
      filename: filename ?? `${item_id}.png`,
      width: width ?? 1024,
      height: height ?? 1536,
    })),
  };
  form.set("manifest", JSON.stringify(manifest));

  for (const item of options.items) {
    if (item.bytes !== null) {
      const content = item.bytes ?? makeFakeWebpBytes(`${item.item_id}-r${item.round}`);
      form.set(
        item.item_id,
        new File([new Uint8Array(content)], `${item.item_id}_r${item.round}.webp`, {
          type: "image/webp",
        })
      );
    }
  }

  const headers = new Headers({
    Authorization: `Bearer ${options.token}`,
  });
  if (options.headerAgentId !== null) {
    headers.set("X-Agent-Id", options.headerAgentId ?? options.manifestAgentId);
  }

  return new Request("https://review.example.test/api/agent/push", {
    method: "POST",
    headers,
    body: form,
  });
}

function assertSecurityHeaders(res: Response): void {
  expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
  expect(res.headers.get("Cache-Control")).toBe("private, no-store");
}

afterEach(() => {
  clearJwksCache();
  vi.restoreAllMocks();
});

describe("Cloudflare Access RS256 Auth & Static Assets Gate", () => {
  it("rejects unauthenticated requests (401) across static pages, JS, review APIs, and previews with noindex headers", async () => {
    const h = await createTestHarness();

    for (const target of [
      "/",
      "/app.js",
      "/robots.txt",
      "/api/review/batches",
      "/api/review/previews/20261113-muse-main-01/item-001/1",
    ]) {
      const res = await worker.fetch(new Request(`https://review.example.test${target}`), h.env);
      expect(res.status).toBe(401);
      assertSecurityHeaders(res);
    }
    h.db.close();
  });

  it("verifies RS256 JWT signature, exp, nbf, aud (401) and case-insensitive email allowlist (403 vs 200)", async () => {
    const h = await createTestHarness({
      allowedEmails: "owner@example.test, Reviewer@Example.Test",
    });
    const nowSec = Math.floor(Date.now() / 1000);

    // 1. Tampered signature -> 401
    const validJwt = await h.signReviewerJwt();
    const tamperedJwt = validJwt.slice(0, -4) + "AAAA";
    const tamperedRes = await worker.fetch(
      new Request("https://review.example.test/", {
        headers: { "Cf-Access-Jwt-Assertion": tamperedJwt },
      }),
      h.env
    );
    expect(tamperedRes.status).toBe(401);

    // 2. Signed by an unknown RSA key -> 401
    const rogueKeys = await createTestAccessKeys("rogue-kid");
    const rogueJwt = await signTestAccessJwt(rogueKeys, {
      email: "reviewer@example.test",
      aud: [h.accessAud],
    });
    const rogueRes = await worker.fetch(
      new Request("https://review.example.test/", {
        headers: { "Cf-Access-Jwt-Assertion": rogueJwt },
      }),
      h.env
    );
    expect(rogueRes.status).toBe(401);

    // 3. Expired JWT -> 401
    const expiredJwt = await h.signReviewerJwt({ exp: nowSec - 5 });
    const expiredRes = await worker.fetch(
      new Request("https://review.example.test/api/review/batches", {
        headers: { "Cf-Access-Jwt-Assertion": expiredJwt },
      }),
      h.env
    );
    expect(expiredRes.status).toBe(401);

    // 4. Future nbf -> 401
    const futureNbfJwt = await h.signReviewerJwt({ nbf: nowSec + 120 });
    const futureRes = await worker.fetch(
      new Request("https://review.example.test/api/review/batches", {
        headers: { "Cf-Access-Jwt-Assertion": futureNbfJwt },
      }),
      h.env
    );
    expect(futureRes.status).toBe(401);

    // 5. Wrong audience -> 401
    const wrongAudJwt = await h.signReviewerJwt({ aud: ["wrong-aud-tag"] });
    const wrongAudRes = await worker.fetch(
      new Request("https://review.example.test/api/review/batches", {
        headers: { "Cf-Access-Jwt-Assertion": wrongAudJwt },
      }),
      h.env
    );
    expect(wrongAudRes.status).toBe(401);

    // 6. Valid RS256 JWT with unauthorized email -> 403
    const outsiderJwt = await h.signReviewerJwt({ email: "intruder@other.test" });
    const outsiderRes = await worker.fetch(
      new Request("https://review.example.test/", {
        headers: { "Cf-Access-Jwt-Assertion": outsiderJwt },
      }),
      h.env
    );
    expect(outsiderRes.status).toBe(403);
    assertSecurityHeaders(outsiderRes);

    // 7. Valid RS256 JWT with uppercase email matching allowlist -> 200 & serves ASSETS with security headers
    const upperEmailJwt = await h.signReviewerJwt({ email: "REVIEWER@EXAMPLE.TEST" });
    const homeRes = await worker.fetch(
      new Request("https://review.example.test/", {
        headers: { "Cf-Access-Jwt-Assertion": upperEmailJwt },
      }),
      h.env
    );
    expect(homeRes.status).toBe(200);
    assertSecurityHeaders(homeRes);
    expect(await homeRes.text()).toContain("审图哨所");

    h.db.close();
  });

  it("fetches and caches JWKS from https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs when override is unset", async () => {
    const h = await createTestHarness({
      envOverrides: {
        CF_ACCESS_JWKS_JSON: undefined,
        CF_ACCESS_TEAM_DOMAIN: "my-team.cloudflareaccess.com",
      },
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(h.accessKeys.jwksJson, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const jwt = await h.signReviewerJwt();
    const res1 = await worker.fetch(
      new Request("https://review.example.test/api/review/batches", {
        headers: { "Cf-Access-Jwt-Assertion": jwt },
      }),
      h.env
    );
    const res2 = await worker.fetch(
      new Request("https://review.example.test/api/review/batches", {
        headers: { "Cf-Access-Jwt-Assertion": jwt },
      }),
      h.env
    );

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://my-team.cloudflareaccess.com/cdn-cgi/access/certs");

    h.db.close();
  });

  it("allows local dev bypass ONLY when ENVIRONMENT='development' AND DEV_BYPASS_ACCESS='true'", async () => {
    const prodWithFlag = await createTestHarness({
      envOverrides: { ENVIRONMENT: "production", DEV_BYPASS_ACCESS: "true" },
    });
    const denied = await worker.fetch(
      new Request("https://review.example.test/api/review/batches"),
      prodWithFlag.env
    );
    expect(denied.status).toBe(401);
    prodWithFlag.db.close();

    const devBypass = await createTestHarness({
      envOverrides: { ENVIRONMENT: "development", DEV_BYPASS_ACCESS: "true" },
    });
    const allowed = await worker.fetch(
      new Request("https://review.example.test/api/review/batches"),
      devBypass.env
    );
    expect(allowed.status).toBe(200);
    assertSecurityHeaders(allowed);
    devBypass.db.close();
  });
});

describe("Constant-Time Agent Auth & Cross-Agent Isolation", () => {
  it("evaluates SHA-256 across ALL configured agent tokens without short-circuiting and enforces 401/403", async () => {
    const h = await createTestHarness({
      agentTokens: {
        "muse-main": "dummy-token-first-entry-0001",
        "argon-mac": "dummy-token-second-entry-0002",
        "extra-node": "dummy-token-third-entry-0003",
      },
    });

    // Missing / wrong token -> 401
    const badRes = await worker.fetch(
      new Request("https://review.example.test/api/agent/verdicts?batch_id=20261113-muse-main-01", {
        headers: { Authorization: "Bearer wrong-token" },
      }),
      h.env
    );
    expect(badRes.status).toBe(401);
    assertSecurityHeaders(badRes);

    // Even when the VERY FIRST token ("muse-main") matches, crypto.subtle.digest MUST run
    // 1 (input token) + 3 (all configured entries) = 4 times (no early return!).
    const digestSpy = vi.spyOn(crypto.subtle, "digest");
    const pushRes = await worker.fetch(
      buildPushRequest({
        token: "dummy-token-first-entry-0001",
        manifestAgentId: "muse-main",
        batchId: "20261113-muse-main-01",
        items: [{ item_id: "20261113-muse-main-01-001", round: 1 }],
      }),
      h.env
    );
    expect(pushRes.status).toBe(200);
    expect(digestSpy).toHaveBeenCalledTimes(4);

    // X-Agent-Id mismatch -> 403
    const wrongHeaderRes = await worker.fetch(
      buildPushRequest({
        token: "dummy-token-first-entry-0001",
        headerAgentId: "argon-mac",
        manifestAgentId: "muse-main",
        batchId: "20261113-muse-main-01",
        items: [{ item_id: "20261113-muse-main-01-002", round: 1 }],
      }),
      h.env
    );
    expect(wrongHeaderRes.status).toBe(403);

    // manifest.agent_id mismatch -> 403
    const wrongManifestRes = await worker.fetch(
      buildPushRequest({
        token: "dummy-token-first-entry-0001",
        headerAgentId: "muse-main",
        manifestAgentId: "argon-mac",
        batchId: "20261113-argon-mac-01",
        items: [{ item_id: "20261113-argon-mac-01-001", round: 1 }],
      }),
      h.env
    );
    expect(wrongManifestRes.status).toBe(403);

    // Cross-agent batch isolation: argon-mac cannot read verdicts, push to, or ack muse-main's batch -> 403
    const crossVerdictsRes = await worker.fetch(
      new Request("https://review.example.test/api/agent/verdicts?batch_id=20261113-muse-main-01", {
        headers: {
          Authorization: "Bearer dummy-token-second-entry-0002",
          "X-Agent-Id": "argon-mac",
        },
      }),
      h.env
    );
    expect(crossVerdictsRes.status).toBe(403);

    const crossPushRes = await worker.fetch(
      buildPushRequest({
        token: "dummy-token-second-entry-0002",
        manifestAgentId: "argon-mac",
        batchId: "20261113-muse-main-01",
        items: [{ item_id: "20261113-muse-main-01-099", round: 1 }],
      }),
      h.env
    );
    expect(crossPushRes.status).toBe(403);

    const crossAckRes = await worker.fetch(
      new Request("https://review.example.test/api/agent/ack", {
        method: "POST",
        headers: {
          Authorization: "Bearer dummy-token-second-entry-0002",
          "X-Agent-Id": "argon-mac",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          batch_id: "20261113-muse-main-01",
          counts: { pushed: 1, archived: 0, repair: 0, redraw: 0, discarded: 1 },
        }),
      }),
      h.env
    );
    expect(crossAckRes.status).toBe(403);

    h.db.close();
  });
});

describe("Chunked Push, Idempotent Overwrite, Cross-Batch Conflict & round+1 Re-push", () => {
  it("supports chunked appends, partial rejection, same-round overwrite resetting verdict, and round+1 cross-batch re-push", async () => {
    const h = await createTestHarness();
    const token = h.agentTokens["muse-main"]!;
    const reviewerJwt = await h.signReviewerJwt();
    const batch1 = "20261113-muse-main-01";

    // Chunk 1: 3 items
    const chunk1Res = await worker.fetch(
      buildPushRequest({
        token,
        manifestAgentId: "muse-main",
        batchId: batch1,
        items: [
          { item_id: `${batch1}-001`, round: 1, width: 832, height: 1216 },
          { item_id: `${batch1}-002`, round: 1, width: 1024, height: 1024 },
          { item_id: `${batch1}-003`, round: 1, width: 1344, height: 768 },
        ],
      }),
      h.env
    );
    expect(chunk1Res.status).toBe(200);
    expect(await chunk1Res.json()).toEqual({
      batch_id: batch1,
      pushed_count: 3,
      accepted: [`${batch1}-001`, `${batch1}-002`, `${batch1}-003`],
      rejected: [],
    });

    // Chunk 2: 2 valid items + 1 missing file part + 1 unsafe slug
    const chunk2Res = await worker.fetch(
      buildPushRequest({
        token,
        manifestAgentId: "muse-main",
        batchId: batch1,
        items: [
          { item_id: `${batch1}-004`, round: 1 },
          { item_id: `${batch1}-005`, round: 1 },
          { item_id: `${batch1}-006`, round: 1, bytes: null },
          { item_id: "../bad-slug", round: 1 },
        ],
      }),
      h.env
    );
    expect(chunk2Res.status).toBe(200);
    const chunk2Body = (await chunk2Res.json()) as {
      pushed_count: number;
      accepted: string[];
      rejected: Array<{ item_id: string; reason: string }>;
    };
    expect(chunk2Body.pushed_count).toBe(5);
    expect(chunk2Body.accepted).toEqual([`${batch1}-004`, `${batch1}-005`]);
    expect(chunk2Body.rejected).toEqual([
      { item_id: `${batch1}-006`, reason: "missing_file_part" },
      { item_id: "../bad-slug", reason: "invalid_item_id" },
    ]);

    // Reviewer marks item 001 with tier=1, flags=["H"], note="left thumb"
    const patchRes = await worker.fetch(
      new Request(
        `https://review.example.test/api/review/batches/${batch1}/items/${batch1}-001/1`,
        {
          method: "PATCH",
          headers: {
            "Cf-Access-Jwt-Assertion": reviewerJwt,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ tier: 1, flags: ["H"], note: "left thumb" }),
        }
      ),
      h.env
    );
    expect(patchRes.status).toBe(200);

    // Same (item_id, round=1) re-pushed to SAME batch -> overwrites R2 & resets verdict to null/[]/""
    const updatedBytes = makeFakeWebpBytes("overwritten-r1");
    const overwriteRes = await worker.fetch(
      buildPushRequest({
        token,
        manifestAgentId: "muse-main",
        batchId: batch1,
        items: [{ item_id: `${batch1}-001`, round: 1, bytes: updatedBytes }],
      }),
      h.env
    );
    expect(overwriteRes.status).toBe(200);
    expect((await overwriteRes.json()) as Record<string, unknown>).toMatchObject({
      pushed_count: 5,
      accepted: [`${batch1}-001`],
    });

    const previewRes = await worker.fetch(
      new Request(
        `https://review.example.test/api/review/previews/${batch1}/${batch1}-001/1`,
        { headers: { "Cf-Access-Jwt-Assertion": reviewerJwt } }
      ),
      h.env
    );
    expect(previewRes.status).toBe(200);
    expect(new Uint8Array(await previewRes.arrayBuffer())).toEqual(updatedBytes);

    const detailAfterOverwrite = (await (
      await worker.fetch(
        new Request(`https://review.example.test/api/review/batches/${batch1}`, {
          headers: { "Cf-Access-Jwt-Assertion": reviewerJwt },
        }),
        h.env
      )
    ).json()) as { items: Array<Record<string, unknown>> };
    const item001 = detailAfterOverwrite.items.find((i) => i.item_id === `${batch1}-001`);
    expect(item001).toMatchObject({
      tier: null,
      flags: [],
      note: "",
      judged_at: null,
      bucket: "discarded",
    });

    // Attempting to push SAME (item_id, round=1) into a DIFFERENT batch -> rejected with conflict_other_batch
    const batch2 = "20261113-muse-main-02";
    const conflictRes = await worker.fetch(
      buildPushRequest({
        token,
        manifestAgentId: "muse-main",
        batchId: batch2,
        items: [{ item_id: `${batch1}-002`, round: 1 }],
      }),
      h.env
    );
    expect(conflictRes.status).toBe(200);
    expect(await conflictRes.json()).toEqual({
      batch_id: batch2,
      pushed_count: 0,
      accepted: [],
      rejected: [{ item_id: `${batch1}-002`, reason: "conflict_other_batch" }],
    });

    // Re-judge item 002 in batch1 as tier=1 + H (repair), then push round=2 of ORIGINAL item_id into batch2!
    await worker.fetch(
      new Request(
        `https://review.example.test/api/review/batches/${batch1}/items/${batch1}-002/1`,
        {
          method: "PATCH",
          headers: {
            "Cf-Access-Jwt-Assertion": reviewerJwt,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ tier: 1, flags: ["H"], note: "fix fingers" }),
        }
      ),
      h.env
    );

    const round2Res = await worker.fetch(
      buildPushRequest({
        token,
        manifestAgentId: "muse-main",
        batchId: batch2,
        items: [
          {
            item_id: `${batch1}-002`,
            round: 2,
            filename: "repaired_002.png",
            width: 1024,
            height: 1024,
          },
        ],
      }),
      h.env
    );
    expect(round2Res.status).toBe(200);
    expect(await round2Res.json()).toEqual({
      batch_id: batch2,
      pushed_count: 1,
      accepted: [`${batch1}-002`],
      rejected: [],
    });

    // Verify round=1 in batch1 was NOT modified and round=2 lives in batch2
    const b1Verdicts = (await (
      await worker.fetch(
        new Request(`https://review.example.test/api/agent/verdicts?batch_id=${batch1}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        h.env
      )
    ).json()) as { items: Array<Record<string, unknown>> };
    expect(b1Verdicts.items.find((i) => i.item_id === `${batch1}-002`)).toMatchObject({
      round: 1,
      tier: 1,
      flags: ["H"],
      note: "fix fingers",
    });

    const b2Verdicts = (await (
      await worker.fetch(
        new Request(`https://review.example.test/api/agent/verdicts?batch_id=${batch2}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        h.env
      )
    ).json()) as { items: Array<Record<string, unknown>> };
    expect(b2Verdicts.items).toEqual([
      {
        item_id: `${batch1}-002`,
        round: 2,
        tier: null,
        flags: [],
        note: "",
        judged_at: null,
      },
    ]);

    h.db.close();
  });
});

describe("Bucket Priority, Review Lock/Revoke & Full Ack Lifecycle (Paginated R2)", () => {
  it("enforces H/F/O > R > tier > discarded priority, review_done lock & revoke, 409 ack guards, and full R2+D1 purge", async () => {
    // Use r2PageSize: 3 to exercise cursor pagination during R2 deletion!
    const h = await createTestHarness({ r2PageSize: 3 });
    const token = h.agentTokens["muse-main"]!;
    const jwt = await h.signReviewerJwt();
    const batchId = "20261113-muse-main-03";

    // Direct unit check on resolveBucket & computeBatchCounts
    expect(resolveBucket(1, ["H"])).toBe("repair");
    expect(resolveBucket(2, ["F", "R"])).toBe("repair");
    expect(resolveBucket(3, ["O"])).toBe("repair");
    expect(resolveBucket(1, ["R"])).toBe("redraw");
    expect(resolveBucket(2, [])).toBe("archived");
    expect(resolveBucket(null, [])).toBe("discarded");
    expect(
      computeBatchCounts([
        { tier: 1, flags: ["H"] },
        { tier: 1, flags: ["R"] },
        { tier: 3, flags: [] },
        { tier: null, flags: [] },
      ])
    ).toEqual({
      pushed: 4,
      archived: 1,
      repair: 1,
      redraw: 1,
      discarded: 1,
    });

    // Push 7 items
    const itemsToPush = Array.from({ length: 7 }, (_, idx) => ({
      item_id: `${batchId}-00${idx + 1}`,
      round: 1,
      width: 1024,
      height: 1536,
    }));
    const pushRes = await worker.fetch(
      buildPushRequest({
        token,
        manifestAgentId: "muse-main",
        batchId,
        items: itemsToPush,
      }),
      h.env
    );
    expect(pushRes.status).toBe(200);
    expect(h.r2.keys(`previews/muse-main/${batchId}/`)).toHaveLength(7);

    // Apply diverse verdicts:
    // 001: tier=1 + H -> repair (retaining tier=1 in D1!)
    // 002: tier=2 + F + R -> repair
    // 003: tier=1 + R -> redraw
    // 004: tier=1 -> archived
    // 005: tier=3 -> archived
    // 006: tier=null + note="composition off" -> discarded (judged_count includes this!)
    // 007: untouched -> discarded (unjudged)
    const patches: Array<[string, Record<string, unknown>]> = [
      [`${batchId}-001`, { tier: 1, flags: ["H"], note: "six fingers" }],
      [`${batchId}-002`, { tier: 2, flags: ["R", "F"] }],
      [`${batchId}-003`, { tier: 1, flags: ["R"] }],
      [`${batchId}-004`, { tier: 1 }],
      [`${batchId}-005`, { tier: 3 }],
      [`${batchId}-006`, { note: "composition off" }],
    ];

    for (const [itemId, payload] of patches) {
      const res = await worker.fetch(
        new Request(`https://review.example.test/api/review/batches/${batchId}/items/${itemId}/1`, {
          method: "PATCH",
          headers: {
            "Cf-Access-Jwt-Assertion": jwt,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }),
        h.env
      );
      expect(res.status).toBe(200);
    }

    // Check GET /api/review/batches summary
    const listRes = await worker.fetch(
      new Request("https://review.example.test/api/review/batches", {
        headers: { "Cf-Access-Jwt-Assertion": jwt },
      }),
      h.env
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { batches: Array<Record<string, unknown>> };
    expect(listJson.batches[0]).toMatchObject({
      batch_id: batchId,
      pushed_count: 7,
      judged_count: 6,
      review_done: false,
      counts: {
        pushed: 7,
        archived: 2,
        repair: 2,
        redraw: 1,
        discarded: 2,
      },
    });

    // Attempt ack BEFORE review_done=true -> 409 review_not_done
    const prematureAck = await worker.fetch(
      new Request("https://review.example.test/api/agent/ack", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          batch_id: batchId,
          counts: { pushed: 7, archived: 2, repair: 2, redraw: 1, discarded: 2 },
        }),
      }),
      h.env
    );
    expect(prematureAck.status).toBe(409);
    expect(await prematureAck.json()).toEqual({
      error: "review_not_done",
      review_done: false,
    });

    // Mark review_done = true
    const doneTrueRes = await worker.fetch(
      new Request(`https://review.example.test/api/review/batches/${batchId}/done`, {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": jwt,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ review_done: true }),
      }),
      h.env
    );
    expect(doneTrueRes.status).toBe(200);
    expect(((await doneTrueRes.json()) as { batch: { review_done: boolean } }).batch.review_done).toBe(
      true
    );

    // While locked (review_done=1), both PATCH item and POST /api/agent/push MUST return 409
    const lockedPatchRes = await worker.fetch(
      new Request(
        `https://review.example.test/api/review/batches/${batchId}/items/${batchId}-007/1`,
        {
          method: "PATCH",
          headers: {
            "Cf-Access-Jwt-Assertion": jwt,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ tier: 2 }),
        }
      ),
      h.env
    );
    expect(lockedPatchRes.status).toBe(409);
    expect(await lockedPatchRes.json()).toMatchObject({ error: "batch_locked" });

    const lockedPushRes = await worker.fetch(
      buildPushRequest({
        token,
        manifestAgentId: "muse-main",
        batchId,
        items: [{ item_id: `${batchId}-008`, round: 1 }],
      }),
      h.env
    );
    expect(lockedPushRes.status).toBe(409);
    expect(await lockedPushRes.json()).toMatchObject({ error: "review_already_done" });

    // Revoke review_done -> false before ack, modify item 007 to tier=2, then lock again!
    const revokeRes = await worker.fetch(
      new Request(`https://review.example.test/api/review/batches/${batchId}/done`, {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": jwt,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ review_done: false }),
      }),
      h.env
    );
    expect(revokeRes.status).toBe(200);
    expect(((await revokeRes.json()) as { batch: { review_done: boolean } }).batch.review_done).toBe(
      false
    );

    const unlockedPatch = await worker.fetch(
      new Request(
        `https://review.example.test/api/review/batches/${batchId}/items/${batchId}-007/1`,
        {
          method: "PATCH",
          headers: {
            "Cf-Access-Jwt-Assertion": jwt,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ tier: 2 }),
        }
      ),
      h.env
    );
    expect(unlockedPatch.status).toBe(200);

    await worker.fetch(
      new Request(`https://review.example.test/api/review/batches/${batchId}/done`, {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": jwt,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ review_done: true }),
      }),
      h.env
    );

    // Expected counts now: pushed=7, archived=3 (004,005,007), repair=2 (001,002), redraw=1 (003), discarded=1 (006)
    // Test ack count mismatch -> 409 returning cloud_counts without deleting anything
    const mismatchAck = await worker.fetch(
      new Request("https://review.example.test/api/agent/ack", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          batch_id: batchId,
          counts: { pushed: 7, archived: 2, repair: 2, redraw: 1, discarded: 2 },
        }),
      }),
      h.env
    );
    expect(mismatchAck.status).toBe(409);
    expect(await mismatchAck.json()).toEqual({
      error: "counts_mismatch",
      cloud_counts: { pushed: 7, archived: 3, repair: 2, redraw: 1, discarded: 1 },
      received_counts: { pushed: 7, archived: 2, repair: 2, redraw: 1, discarded: 2 },
    });
    expect(h.r2.keys(`previews/muse-main/${batchId}/`)).toHaveLength(7);

    // Valid ack -> 200, deletes all 7 R2 objects across paginated list calls + deletes D1 rows
    const validAck = await worker.fetch(
      new Request("https://review.example.test/api/agent/ack", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          batch_id: batchId,
          counts: { pushed: 7, archived: 3, repair: 2, redraw: 1, discarded: 1 },
        }),
      }),
      h.env
    );
    expect(validAck.status).toBe(200);
    expect(await validAck.json()).toEqual({
      ok: true,
      batch_id: batchId,
      deleted_previews: 7,
      counts: { pushed: 7, archived: 3, repair: 2, redraw: 1, discarded: 1 },
    });

    expect(h.r2.keys(`previews/muse-main/${batchId}/`)).toHaveLength(0);
    const afterDetail = await worker.fetch(
      new Request(`https://review.example.test/api/review/batches/${batchId}`, {
        headers: { "Cf-Access-Jwt-Assertion": jwt },
      }),
      h.env
    );
    expect(afterDetail.status).toBe(404);

    // Attempting to revoke review_done after batch was acked & deleted -> 404
    const revokeDeleted = await worker.fetch(
      new Request(`https://review.example.test/api/review/batches/${batchId}/done`, {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": jwt,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ review_done: false }),
      }),
      h.env
    );
    expect(revokeDeleted.status).toBe(404);

    h.db.close();
  });
});

describe("Daily Cron Cleanup (7-day R2 preview purge & 30-day full purge)", () => {
  it("purges R2 previews at >=7 days keeping D1 verdicts, and deletes R2 + D1 at >=30 days", async () => {
    const h = await createTestHarness();
    const token = h.agentTokens["muse-main"]!;
    const jwt = await h.signReviewerJwt();

    const now = new Date("2026-12-20T04:00:00.000Z");
    const dayMs = 24 * 60 * 60 * 1000;

    const batchFresh = "20261218-muse-main-01"; // 2 days old
    const batch8d = "20261211-muse-main-01"; // 9 days old
    const batch35d = "20261114-muse-main-01"; // 36 days old

    for (const bId of [batchFresh, batch8d, batch35d]) {
      await worker.fetch(
        buildPushRequest({
          token,
          manifestAgentId: "muse-main",
          batchId: bId,
          items: [
            { item_id: `${bId}-001`, round: 1 },
            { item_id: `${bId}-002`, round: 1 },
          ],
        }),
        h.env
      );
    }

    // Backdate created_at in D1
    await h.db
      .prepare("UPDATE batches SET created_at = ? WHERE batch_id = ?")
      .bind(new Date(now.getTime() - 2 * dayMs).toISOString(), batchFresh)
      .run();
    await h.db
      .prepare("UPDATE batches SET created_at = ? WHERE batch_id = ?")
      .bind(new Date(now.getTime() - 9 * dayMs).toISOString(), batch8d)
      .run();
    await h.db
      .prepare("UPDATE batches SET created_at = ? WHERE batch_id = ?")
      .bind(new Date(now.getTime() - 36 * dayMs).toISOString(), batch35d)
      .run();

    // Run via scheduled handler
    await worker.scheduled({ scheduledTime: now.getTime(), cron: "0 4 * * *" }, h.env);

    // 1. Fresh batch: R2 + D1 intact, previews_purged_at is null
    expect(h.r2.keys(`previews/muse-main/${batchFresh}/`)).toHaveLength(2);
    const freshRow = await h.db
      .prepare("SELECT previews_purged_at FROM batches WHERE batch_id = ?")
      .bind(batchFresh)
      .first<{ previews_purged_at: string | null }>();
    expect(freshRow?.previews_purged_at).toBeNull();

    // 2. 9-day batch: R2 deleted, previews_purged_at populated, D1 verdicts STILL available!
    expect(h.r2.keys(`previews/muse-main/${batch8d}/`)).toHaveLength(0);
    const row8d = await h.db
      .prepare("SELECT previews_purged_at FROM batches WHERE batch_id = ?")
      .bind(batch8d)
      .first<{ previews_purged_at: string | null }>();
    expect(row8d?.previews_purged_at).toBe(now.toISOString());

    const verdicts8dRes = await worker.fetch(
      new Request(`https://review.example.test/api/agent/verdicts?batch_id=${batch8d}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      h.env
    );
    expect(verdicts8dRes.status).toBe(200);
    expect(((await verdicts8dRes.json()) as { items: unknown[] }).items).toHaveLength(2);

    const purgedPreviewRes = await worker.fetch(
      new Request(`https://review.example.test/api/review/previews/${batch8d}/${batch8d}-001/1`, {
        headers: { "Cf-Access-Jwt-Assertion": jwt },
      }),
      h.env
    );
    expect(purgedPreviewRes.status).toBe(404);

    // Idempotency: running cleanup again does not re-purge already marked 8d batch
    const secondRun = await runCleanup(h.env, now);
    expect(secondRun.purged_previews_batches).toEqual([]);
    expect(secondRun.deleted_expired_batches).toEqual([]);

    // 3. 36-day batch: both R2 and D1 completely gone
    expect(h.r2.keys(`previews/muse-main/${batch35d}/`)).toHaveLength(0);
    const row35d = await h.db
      .prepare("SELECT * FROM batches WHERE batch_id = ?")
      .bind(batch35d)
      .first();
    expect(row35d).toBeNull();
    const verdicts35d = await h.db
      .prepare("SELECT * FROM verdicts WHERE batch_id = ?")
      .bind(batch35d)
      .all();
    expect(verdicts35d.results).toHaveLength(0);

    h.db.close();
  });
});

describe("Local Sandbox SQLite Persistence & HTTP Bridge Helper", () => {
  it("supports file-backed SQLite inside .test-sandboxes/worker and serves real localhost HTTP requests", async () => {
    fs.mkdirSync(WORKER_SANDBOX_DIR, { recursive: true });
    const dbFile = path.join(WORKER_SANDBOX_DIR, "test-bridge.sqlite");
    if (fs.existsSync(dbFile)) {
      fs.unlinkSync(dbFile);
    }

    const h = await createTestHarness({ sqlitePath: dbFile });
    const srv = await startLocalWorkerServer(h.env);

    try {
      const unauthRes = await fetch(`${srv.baseUrl}/api/review/batches`);
      expect(unauthRes.status).toBe(401);

      const jwt = await h.signReviewerJwt();
      const authRes = await fetch(`${srv.baseUrl}/api/review/batches`, {
        headers: { "Cf-Access-Jwt-Assertion": jwt },
      });
      expect(authRes.status).toBe(200);
      expect(await authRes.json()).toEqual({ batches: [] });
    } finally {
      await srv.close();
      h.db.close();
      if (fs.existsSync(dbFile)) {
        fs.unlinkSync(dbFile);
      }
    }
  });
});
