import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearJwksCache } from "../../src/auth.js";
import {
  VALID_FLAGS,
  computeBatchCounts,
  isItemJudged,
  isValidTier,
  resolveDisposition,
} from "../../src/buckets.js";
import { runCleanup } from "../../src/cleanup.js";
import worker from "../../src/index.js";
import type { FlagCode, TierValue } from "../../src/types.js";
import {
  MIGRATION_0002_SQL_PATH,
  MIGRATION_SQL_PATH,
  SqliteD1Database,
  WORKER_SANDBOX_DIR,
  createTestAccessKeys,
  createTestHarness,
  listMigrationSqlPaths,
  signTestAccessJwt,
  startLocalWorkerServer,
} from "./test-env.js";

function makeFakeWebpBytes(label: string): Uint8Array {
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
  source?: string | null;
  line?: string | null;
  batchType?: string | null;
  items: Array<{
    item_id: string;
    round: number;
    filename?: string;
    width?: number;
    height?: number;
    parent_item_id?: string | null;
    bytes?: Uint8Array | null;
  }>;
}): Request {
  const form = new FormData();
  const manifest: Record<string, unknown> = {
    agent_id: options.manifestAgentId,
    batch_id: options.batchId,
    items: options.items.map(({ item_id, round, filename, width, height, parent_item_id }) => {
      const entry: Record<string, unknown> = {
        item_id,
        round,
        filename: filename ?? `${item_id}.webp`,
        width: width ?? 1024,
        height: height ?? 1536,
      };
      if (parent_item_id !== undefined) {
        entry.parent_item_id = parent_item_id;
      }
      return entry;
    }),
  };

  if (options.source !== undefined) {
    manifest.source = options.source;
  }
  if (options.line !== undefined) {
    manifest.line = options.line;
  }
  if (options.batchType !== undefined) {
    manifest.batch_type = options.batchType;
  }

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

describe("D1 Migration 0001 -> 0002 Upgrade & SQL Guardrails", () => {
  it("contains no forbidden transaction/pragma statements and flips legacy tiers 1 <-> 3 while enabling tier = 0", async () => {
    const paths = listMigrationSqlPaths().map((p) => path.basename(p));
    expect(paths).toEqual(["0001_init.sql", "0002_v4_upgrade.sql"]);

    const sql0002 = fs.readFileSync(MIGRATION_0002_SQL_PATH, "utf8");
    const nonCommentLines = sql0002
      .split("\n")
      .map((line) => line.replace(/--.*$/, "").trim())
      .filter(Boolean)
      .join("\n");
    expect(nonCommentLines).not.toMatch(/\bBEGIN\b/i);
    expect(nonCommentLines).not.toMatch(/\bCOMMIT\b/i);
    expect(nonCommentLines).not.toMatch(/PRAGMA\s+foreign_keys/i);

    const db = new SqliteD1Database(":memory:", false);
    db.sqlite.exec(fs.readFileSync(MIGRATION_SQL_PATH, "utf8"));

    // Seed legacy 0001 rows across muse-main, argon-mac, and custom-bot
    await db
      .prepare(
        "INSERT INTO batches (batch_id, agent_id, pushed_count, review_done, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .bind("20261114-muse-main-01", "muse-main", 4, 1, "2026-11-14T10:00:00.000Z")
      .run();
    await db
      .prepare(
        "INSERT INTO batches (batch_id, agent_id, pushed_count, review_done, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .bind("20261114-argon-mac-01", "argon-mac", 0, 0, "2026-11-14T11:00:00.000Z")
      .run();
    await db
      .prepare(
        "INSERT INTO batches (batch_id, agent_id, pushed_count, review_done, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .bind("20261114-custom-bot-01", "custom-bot", 0, 0, "2026-11-14T12:00:00.000Z")
      .run();

    const legacyVerdicts: Array<[string, number | null, string, string]> = [
      ["item-legacy-tier1", 1, '["R"]', "old 1 -> new 3"],
      ["item-legacy-tier2", 2, '["H"]', "old 2 -> stays 2"],
      ["item-legacy-tier3", 3, "[]", "old 3 -> new 1"],
      ["item-legacy-null", null, "[]", "null -> stays null"],
    ];
    for (const [itemId, tier, flagsJson, note] of legacyVerdicts) {
      await db
        .prepare(
          `INSERT INTO verdicts (item_id, round, batch_id, filename, width, height, pushed_at, tier, flags_json, note, judged_at)
           VALUES (?, 1, '20261114-muse-main-01', ?, 1024, 1536, '2026-11-14T10:01:00.000Z', ?, ?, ?, '2026-11-14T10:05:00.000Z')`
        )
        .bind(itemId, `${itemId}.webp`, tier, flagsJson, note)
        .run();
    }

    // Apply 0002_v4_upgrade.sql
    db.sqlite.exec(sql0002);

    const { results: migratedBatches } = await db
      .prepare("SELECT batch_id, agent_id, source, line, batch_type, review_done_at FROM batches ORDER BY batch_id ASC")
      .all();

    expect(migratedBatches).toEqual([
      {
        batch_id: "20261114-argon-mac-01",
        agent_id: "argon-mac",
        source: "gallery",
        line: null,
        batch_type: "artwork",
        review_done_at: null,
      },
      {
        batch_id: "20261114-custom-bot-01",
        agent_id: "custom-bot",
        source: "custom-bot",
        line: null,
        batch_type: "artwork",
        review_done_at: null,
      },
      {
        batch_id: "20261114-muse-main-01",
        agent_id: "muse-main",
        source: "museai",
        line: null,
        batch_type: "artwork",
        review_done_at: null,
      },
    ]);

    const { results: migratedVerdicts } = await db
      .prepare("SELECT item_id, tier, parent_item_id, flags_json, note FROM verdicts ORDER BY item_id ASC")
      .all();

    expect(migratedVerdicts).toEqual([
      {
        item_id: "item-legacy-null",
        tier: null,
        parent_item_id: null,
        flags_json: "[]",
        note: "null -> stays null",
      },
      {
        item_id: "item-legacy-tier1",
        tier: 3,
        parent_item_id: null,
        flags_json: '["R"]',
        note: "old 1 -> new 3",
      },
      {
        item_id: "item-legacy-tier2",
        tier: 2,
        parent_item_id: null,
        flags_json: '["H"]',
        note: "old 2 -> stays 2",
      },
      {
        item_id: "item-legacy-tier3",
        tier: 1,
        parent_item_id: null,
        flags_json: "[]",
        note: "old 3 -> new 1",
      },
    ]);

    // Verify new table accepts tier = 0 and parent_item_id, while rejecting out-of-range tiers
    await db
      .prepare(
        `INSERT INTO verdicts (item_id, round, batch_id, filename, width, height, parent_item_id, pushed_at, tier, flags_json, note, judged_at)
         VALUES ('item-new-tier0', 1, '20261114-muse-main-01', '005.webp', 1024, 1024, 'item-legacy-tier1', '2026-11-19T00:00:00.000Z', 0, '[]', '', '2026-11-19T00:01:00.000Z')`
      )
      .run();

    const tier0Row = await db
      .prepare("SELECT tier, parent_item_id FROM verdicts WHERE item_id = 'item-new-tier0'")
      .first<{ tier: number | null; parent_item_id: string | null }>();
    expect(tier0Row).toEqual({ tier: 0, parent_item_id: "item-legacy-tier1" });

    await expect(
      db
        .prepare(
          `INSERT INTO verdicts (item_id, round, batch_id, pushed_at, tier) VALUES ('bad-tier4', 1, '20261114-muse-main-01', '2026-11-19T00:00:00.000Z', 4)`
        )
        .run()
    ).rejects.toThrow();

    db.close();
  });
});

describe("Cloudflare Access RS256 Auth & Static Assets Gate", () => {
  it("rejects unauthenticated requests (401) across static pages, JS, review APIs, and previews with noindex headers", async () => {
    const h = await createTestHarness();

    for (const target of [
      "/",
      "/app.js",
      "/robots.txt",
      "/api/review/batches",
      "/api/review/previews/20261119-gallery-banana-01/item-001/1",
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

    const validJwt = await h.signReviewerJwt();
    const tamperedJwt = validJwt.slice(0, -4) + "AAAA";
    expect(
      (
        await worker.fetch(
          new Request("https://review.example.test/", {
            headers: { "Cf-Access-Jwt-Assertion": tamperedJwt },
          }),
          h.env
        )
      ).status
    ).toBe(401);

    const rogueKeys = await createTestAccessKeys("rogue-kid");
    const rogueJwt = await signTestAccessJwt(rogueKeys, {
      email: "reviewer@example.test",
      aud: [h.accessAud],
    });
    expect(
      (
        await worker.fetch(
          new Request("https://review.example.test/", {
            headers: { "Cf-Access-Jwt-Assertion": rogueJwt },
          }),
          h.env
        )
      ).status
    ).toBe(401);

    const expiredJwt = await h.signReviewerJwt({ exp: nowSec - 5 });
    expect(
      (
        await worker.fetch(
          new Request("https://review.example.test/api/review/batches", {
            headers: { "Cf-Access-Jwt-Assertion": expiredJwt },
          }),
          h.env
        )
      ).status
    ).toBe(401);

    const futureNbfJwt = await h.signReviewerJwt({ nbf: nowSec + 120 });
    expect(
      (
        await worker.fetch(
          new Request("https://review.example.test/api/review/batches", {
            headers: { "Cf-Access-Jwt-Assertion": futureNbfJwt },
          }),
          h.env
        )
      ).status
    ).toBe(401);

    const wrongAudJwt = await h.signReviewerJwt({ aud: ["wrong-aud-tag"] });
    expect(
      (
        await worker.fetch(
          new Request("https://review.example.test/api/review/batches", {
            headers: { "Cf-Access-Jwt-Assertion": wrongAudJwt },
          }),
          h.env
        )
      ).status
    ).toBe(401);

    const outsiderJwt = await h.signReviewerJwt({ email: "intruder@other.test" });
    const outsiderRes = await worker.fetch(
      new Request("https://review.example.test/", {
        headers: { "Cf-Access-Jwt-Assertion": outsiderJwt },
      }),
      h.env
    );
    expect(outsiderRes.status).toBe(403);
    assertSecurityHeaders(outsiderRes);

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
    expect(
      (
        await worker.fetch(
          new Request("https://review.example.test/api/review/batches"),
          prodWithFlag.env
        )
      ).status
    ).toBe(401);
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

    const badRes = await worker.fetch(
      new Request("https://review.example.test/api/agent/verdicts?batch_id=20261119-museai-gpt-01", {
        headers: { Authorization: "Bearer wrong-token" },
      }),
      h.env
    );
    expect(badRes.status).toBe(401);
    assertSecurityHeaders(badRes);

    const digestSpy = vi.spyOn(crypto.subtle, "digest");
    const pushRes = await worker.fetch(
      buildPushRequest({
        token: "dummy-token-first-entry-0001",
        manifestAgentId: "muse-main",
        batchId: "20261119-museai-gpt-01",
        line: "gpt",
        items: [{ item_id: "20261119-museai-gpt-01-001", round: 1 }],
      }),
      h.env
    );
    expect(pushRes.status).toBe(200);
    expect(digestSpy).toHaveBeenCalledTimes(4);

    // X-Agent-Id mismatch -> 403
    expect(
      (
        await worker.fetch(
          buildPushRequest({
            token: "dummy-token-first-entry-0001",
            headerAgentId: "argon-mac",
            manifestAgentId: "muse-main",
            batchId: "20261119-museai-gpt-01",
            items: [{ item_id: "20261119-museai-gpt-01-002", round: 1 }],
          }),
          h.env
        )
      ).status
    ).toBe(403);

    // manifest.agent_id mismatch -> 403
    expect(
      (
        await worker.fetch(
          buildPushRequest({
            token: "dummy-token-first-entry-0001",
            headerAgentId: "muse-main",
            manifestAgentId: "argon-mac",
            batchId: "20261119-gallery-banana-01",
            items: [{ item_id: "20261119-gallery-banana-01-001", round: 1 }],
          }),
          h.env
        )
      ).status
    ).toBe(403);

    // Cross-agent isolation on verdicts, push, ack, and GET /api/agent/batches
    expect(
      (
        await worker.fetch(
          new Request(
            "https://review.example.test/api/agent/verdicts?batch_id=20261119-museai-gpt-01",
            {
              headers: {
                Authorization: "Bearer dummy-token-second-entry-0002",
                "X-Agent-Id": "argon-mac",
              },
            }
          ),
          h.env
        )
      ).status
    ).toBe(403);

    const argonBatchesRes = await worker.fetch(
      new Request("https://review.example.test/api/agent/batches", {
        headers: {
          Authorization: "Bearer dummy-token-second-entry-0002",
          "X-Agent-Id": "argon-mac",
        },
      }),
      h.env
    );
    expect(argonBatchesRes.status).toBe(200);
    expect(await argonBatchesRes.json()).toEqual({ batches: [] });

    const crossAckRes = await worker.fetch(
      new Request("https://review.example.test/api/agent/ack", {
        method: "POST",
        headers: {
          Authorization: "Bearer dummy-token-second-entry-0002",
          "X-Agent-Id": "argon-mac",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          batch_id: "20261119-museai-gpt-01",
          items: [
            {
              item_id: "20261119-museai-gpt-01-001",
              round: 1,
              destination: "discard",
              redraw: false,
              archive_ref: null,
            },
          ],
        }),
      }),
      h.env
    );
    expect(crossAckRes.status).toBe(403);

    h.db.close();
  });
});

describe("Orthogonal Disposition Rules & Zero-Swallow tier = 0 Guarantee", () => {
  it("verifies all 80 (tier x flags) combinations and preserves tier = 0 end-to-end across PATCH, review, and verdicts", async () => {
    const tiers: TierValue[] = [3, 2, 1, 0, null];
    for (const t of tiers) {
      expect(isValidTier(t)).toBe(true);
    }
    expect(isValidTier(4)).toBe(false);
    expect(isValidTier(-1)).toBe(false);
    expect(isItemJudged(0, [], "")).toBe(true);
    expect(isItemJudged(null, [], "")).toBe(false);

    // Exhaustive 80-combination check: 5 tiers x 16 subsets of [H, F, O, R]
    const allItems: Array<{ tier: TierValue; flags: FlagCode[] }> = [];
    for (const tier of tiers) {
      for (let mask = 0; mask < 16; mask++) {
        const flags: FlagCode[] = [];
        for (let bit = 0; bit < VALID_FLAGS.length; bit++) {
          if ((mask & (1 << bit)) !== 0) {
            flags.push(VALID_FLAGS[bit]!);
          }
        }
        allItems.push({ tier, flags });

        const disp = resolveDisposition(tier, flags);
        const hasRepair = flags.some((f) => f === "H" || f === "F" || f === "O");
        if (hasRepair) {
          expect(disp.destination).toBe("repair");
        } else if (tier !== null) {
          expect(disp.destination).toBe("archive");
        } else {
          expect(disp.destination).toBe("discard");
        }
        expect(disp.redraw).toBe(flags.includes("R"));
      }
    }

    const totalCounts = computeBatchCounts(allItems);
    expect(totalCounts.pushed).toBe(80);
    expect(totalCounts.archive + totalCounts.repair + totalCounts.discard).toBe(80);
    expect(totalCounts.redraw).toBe(40); // R is set in half of the 16 masks across 5 tiers

    // Specific critical v4 orthogonal combinations:
    expect(resolveDisposition(3, ["R"])).toEqual({ destination: "archive", redraw: true });
    expect(resolveDisposition(0, ["R"])).toEqual({ destination: "archive", redraw: true });
    expect(resolveDisposition(3, ["H", "R"])).toEqual({ destination: "repair", redraw: true });
    expect(resolveDisposition(0, ["F"])).toEqual({ destination: "repair", redraw: false });
    expect(resolveDisposition(null, ["R"])).toEqual({ destination: "discard", redraw: true });

    // End-to-end HTTP test for tier = 0 persistence & partial PATCH preservation
    const h = await createTestHarness();
    const token = h.agentTokens["argon-mac"]!;
    const jwt = await h.signReviewerJwt();
    const batchId = "20261119-gallery-banana-01";

    await worker.fetch(
      buildPushRequest({
        token,
        manifestAgentId: "argon-mac",
        batchId,
        source: "gallery",
        line: "banana",
        batchType: "脸模", // Chinese alias -> normalized to "face"
        items: [
          { item_id: `${batchId}-001`, round: 1, filename: "001.webp" },
          { item_id: `${batchId}-002`, round: 1, filename: "002.webp" },
        ],
      }),
      h.env
    );

    // Set item 001 to tier = 0 ("☆ 留样")
    const patch0Res = await worker.fetch(
      new Request(
        `https://review.example.test/api/review/batches/${batchId}/items/${batchId}-001/1`,
        {
          method: "PATCH",
          headers: {
            "Cf-Access-Jwt-Assertion": jwt,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ tier: 0 }),
        }
      ),
      h.env
    );
    expect(patch0Res.status).toBe(200);
    const patch0Json = (await patch0Res.json()) as {
      item: Record<string, unknown>;
      batch: Record<string, unknown>;
    };
    expect(patch0Json.item).toMatchObject({
      item_id: `${batchId}-001`,
      tier: 0,
      flags: [],
      destination: "archive",
      redraw: false,
    });
    expect(patch0Json.item.judged_at).toEqual(expect.any(String));
    expect(patch0Json.batch).toMatchObject({
      batch_type: "face",
      judged_count: 1,
      counts: { pushed: 2, archive: 1, repair: 0, discard: 1, redraw: 0 },
    });

    // Partial PATCH adding flag ["R"] & note WITHOUT resending `tier` MUST NOT swallow existing tier = 0!
    const partialPatchRes = await worker.fetch(
      new Request(
        `https://review.example.test/api/review/batches/${batchId}/items/${batchId}-001/1`,
        {
          method: "PATCH",
          headers: {
            "Cf-Access-Jwt-Assertion": jwt,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ flags: ["R"], note: "keep 0 star + redraw" }),
        }
      ),
      h.env
    );
    expect(partialPatchRes.status).toBe(200);
    expect(((await partialPatchRes.json()) as { item: Record<string, unknown> }).item).toMatchObject(
      {
        tier: 0,
        flags: ["R"],
        destination: "archive",
        redraw: true,
        note: "keep 0 star + redraw",
      }
    );

    // Verify GET /api/agent/verdicts also returns tier: 0 accurately
    const verdictsRes = await worker.fetch(
      new Request(`https://review.example.test/api/agent/verdicts?batch_id=${batchId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      h.env
    );
    expect(verdictsRes.status).toBe(200);
    const verdictsJson = (await verdictsRes.json()) as {
      source: string;
      line: string | null;
      channel_id: string;
      batch_type: string;
      counts: Record<string, number>;
      items: Array<Record<string, unknown>>;
    };
    expect(verdictsJson).toMatchObject({
      source: "gallery",
      line: "banana",
      channel_id: "gallery-banana",
      batch_type: "face",
      counts: { pushed: 2, archive: 1, repair: 0, discard: 1, redraw: 1 },
    });
    expect(verdictsJson.items[0]).toMatchObject({
      item_id: `${batchId}-001`,
      tier: 0,
      flags: ["R"],
      destination: "archive",
      redraw: true,
    });

    h.db.close();
  });
});

describe("Channels (source x line x batch_type), parent_item_id, Metadata Conflict & Agent Batch Polling", () => {
  it("supports channel aggregation/filtering, parent_item_id lineage, chunk metadata conflict (409), and GET /api/agent/batches", async () => {
    const h = await createTestHarness();
    const museToken = h.agentTokens["muse-main"]!;
    const argonToken = h.agentTokens["argon-mac"]!;
    const jwt = await h.signReviewerJwt();

    // Invalid batch_type -> 400
    const badTypeRes = await worker.fetch(
      buildPushRequest({
        token: argonToken,
        manifestAgentId: "argon-mac",
        batchId: "20261119-gallery-banana-99",
        batchType: "invalid_type",
        items: [{ item_id: "20261119-gallery-banana-99-001", round: 1 }],
      }),
      h.env
    );
    expect(badTypeRes.status).toBe(400);

    // 1. muse-main default source ("museai"), no line -> channel_id = "museai"
    const bMuseLegacy = "20261119-museai-01";
    await worker.fetch(
      buildPushRequest({
        token: museToken,
        manifestAgentId: "muse-main",
        batchId: bMuseLegacy,
        items: [{ item_id: `${bMuseLegacy}-001`, round: 1 }],
      }),
      h.env
    );

    // 2. muse-main with explicit source="museai", line="gpt", batch_type="outfit"
    const bMuseGpt = "20261119-museai-gpt-01";
    await worker.fetch(
      buildPushRequest({
        token: museToken,
        manifestAgentId: "muse-main",
        batchId: bMuseGpt,
        source: "museai",
        line: "gpt",
        batchType: "服装",
        items: [
          {
            item_id: `${bMuseGpt}-001`,
            round: 1,
            parent_item_id: `${bMuseLegacy}-001`,
          },
          {
            item_id: `${bMuseGpt}-002`,
            round: 1,
            parent_item_id: "../unsafe-parent",
          },
        ],
      }),
      h.env
    );

    // Verify chunked append metadata conflict -> 409 batch_metadata_conflict
    const conflictLineRes = await worker.fetch(
      buildPushRequest({
        token: museToken,
        manifestAgentId: "muse-main",
        batchId: bMuseGpt,
        source: "museai",
        line: "colab",
        batchType: "outfit",
        items: [{ item_id: `${bMuseGpt}-003`, round: 1 }],
      }),
      h.env
    );
    expect(conflictLineRes.status).toBe(409);
    expect(await conflictLineRes.json()).toMatchObject({
      error: "batch_metadata_conflict",
      existing: { source: "museai", line: "gpt", batch_type: "outfit" },
      received: { source: "museai", line: "colab", batch_type: "outfit" },
    });

    // Chunked append with matching metadata (or omitted optional metadata) succeeds
    const validAppendRes = await worker.fetch(
      buildPushRequest({
        token: museToken,
        manifestAgentId: "muse-main",
        batchId: bMuseGpt,
        items: [{ item_id: `${bMuseGpt}-003`, round: 1 }],
      }),
      h.env
    );
    expect(validAppendRes.status).toBe(200);
    expect(((await validAppendRes.json()) as { pushed_count: number }).pushed_count).toBe(2);

    // 3. argon-mac with source="gallery", line="banana", batch_type="artwork"
    const bGallery = "20261119-gallery-banana-01";
    await worker.fetch(
      buildPushRequest({
        token: argonToken,
        manifestAgentId: "argon-mac",
        batchId: bGallery,
        source: "gallery",
        line: "banana",
        batchType: "artwork",
        items: [{ item_id: `${bGallery}-001`, round: 1 }],
      }),
      h.env
    );

    // Mark bMuseGpt review_done = true
    const doneRes = await worker.fetch(
      new Request(`https://review.example.test/api/review/batches/${bMuseGpt}/done`, {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": jwt,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ review_done: true }),
      }),
      h.env
    );
    expect(doneRes.status).toBe(200);
    expect(((await doneRes.json()) as { batch: { review_done_at: string } }).batch.review_done_at).toEqual(
      expect.any(String)
    );

    // Verify GET /api/review/batches returns full `channels` summary even when filtered by ?channel=
    const filteredReviewRes = await worker.fetch(
      new Request("https://review.example.test/api/review/batches?channel=museai-gpt", {
        headers: { "Cf-Access-Jwt-Assertion": jwt },
      }),
      h.env
    );
    expect(filteredReviewRes.status).toBe(200);
    const filteredReviewJson = (await filteredReviewRes.json()) as {
      batches: Array<Record<string, unknown>>;
      channels: Array<Record<string, unknown>>;
    };
    expect(filteredReviewJson.batches).toHaveLength(1);
    expect(filteredReviewJson.batches[0]?.batch_id).toBe(bMuseGpt);
    expect(filteredReviewJson.channels).toEqual([
      {
        channel_id: "gallery-banana",
        source: "gallery",
        line: "banana",
        total_batches: 1,
        pending_batches: 1,
      },
      {
        channel_id: "museai",
        source: "museai",
        line: null,
        total_batches: 1,
        pending_batches: 1,
      },
      {
        channel_id: "museai-gpt",
        source: "museai",
        line: "gpt",
        total_batches: 1,
        pending_batches: 0,
      },
    ]);

    // Verify parent_item_id in GET /api/review/batches/:batchId
    const detailRes = await worker.fetch(
      new Request(`https://review.example.test/api/review/batches/${bMuseGpt}`, {
        headers: { "Cf-Access-Jwt-Assertion": jwt },
      }),
      h.env
    );
    expect(detailRes.status).toBe(200);
    const detailJson = (await detailRes.json()) as { items: Array<Record<string, unknown>> };
    expect(detailJson.items[0]).toMatchObject({
      item_id: `${bMuseGpt}-001`,
      parent_item_id: `${bMuseLegacy}-001`,
    });

    // Verify GET /api/agent/batches filtering for muse-main
    const agentDoneRes = await worker.fetch(
      new Request("https://review.example.test/api/agent/batches?line=gpt&review_done=1", {
        headers: { Authorization: `Bearer ${museToken}` },
      }),
      h.env
    );
    expect(agentDoneRes.status).toBe(200);
    const agentDoneJson = (await agentDoneRes.json()) as { batches: Array<Record<string, unknown>> };
    expect(agentDoneJson.batches).toHaveLength(1);
    expect(agentDoneJson.batches[0]).toMatchObject({
      batch_id: bMuseGpt,
      source: "museai",
      line: "gpt",
      channel_id: "museai-gpt",
      batch_type: "outfit",
      pushed_count: 2,
      review_done: true,
    });

    const agentPendingRes = await worker.fetch(
      new Request("https://review.example.test/api/agent/batches?review_done=0", {
        headers: { Authorization: `Bearer ${museToken}` },
      }),
      h.env
    );
    expect(agentPendingRes.status).toBe(200);
    const agentPendingJson = (await agentPendingRes.json()) as {
      batches: Array<Record<string, unknown>>;
    };
    expect(agentPendingJson.batches.map((b) => b.batch_id)).toEqual([bMuseLegacy]);

    h.db.close();
  });
});

describe("Strict Item-Level Ack Verification, archive_ref Gate, Revoke Race & Paginated R2 Purge", () => {
  it("rejects premature ack, coverage gaps, stale dispositions after revoke, and empty archive_ref (409), then purges R2+D1 returning receipt", async () => {
    const h = await createTestHarness({ r2PageSize: 2 });
    const token = h.agentTokens["argon-mac"]!;
    const jwt = await h.signReviewerJwt();
    const batchId = "20261119-gallery-banana-03";

    // Push 5 items
    const pushRes = await worker.fetch(
      buildPushRequest({
        token,
        manifestAgentId: "argon-mac",
        batchId,
        source: "gallery",
        line: "banana",
        batchType: "artwork",
        items: [
          { item_id: `${batchId}-001`, round: 1 },
          { item_id: `${batchId}-002`, round: 1 },
          { item_id: `${batchId}-003`, round: 1 },
          { item_id: `${batchId}-004`, round: 1 },
          { item_id: `${batchId}-005`, round: 1 },
        ],
      }),
      h.env
    );
    expect(pushRes.status).toBe(200);
    expect(h.r2.keys(`previews/argon-mac/${batchId}/`)).toHaveLength(5);

    // Verdicts:
    // 001: tier=3 + R -> archive + redraw=true
    // 002: tier=0     -> archive + redraw=false (0-star collection!)
    // 003: tier=3 + H + R -> repair + redraw=true (intent_tier=3)
    // 004: R only     -> discard + redraw=true
    // 005: untouched  -> discard + redraw=false
    const verdictsToApply: Array<[string, Record<string, unknown>]> = [
      [`${batchId}-001`, { tier: 3, flags: ["R"] }],
      [`${batchId}-002`, { tier: 0 }],
      [`${batchId}-003`, { tier: 3, flags: ["H", "R"], note: "fix left hand" }],
      [`${batchId}-004`, { flags: ["R"] }],
    ];
    for (const [itemId, body] of verdictsToApply) {
      const r = await worker.fetch(
        new Request(`https://review.example.test/api/review/batches/${batchId}/items/${itemId}/1`, {
          method: "PATCH",
          headers: {
            "Cf-Access-Jwt-Assertion": jwt,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }),
        h.env
      );
      expect(r.status).toBe(200);
    }

    const validAckItems = [
      {
        item_id: `${batchId}-001`,
        round: 1,
        destination: "archive",
        redraw: true,
        archive_ref: "00_anchors/001_sunlit.png",
      },
      {
        item_id: `${batchId}-002`,
        round: 1,
        destination: "archive",
        redraw: false,
        archive_ref: "00_collect/002_keep.png",
      },
      {
        item_id: `${batchId}-003`,
        round: 1,
        destination: "repair",
        redraw: true,
        archive_ref: null,
      },
      {
        item_id: `${batchId}-004`,
        round: 1,
        destination: "discard",
        redraw: true,
        archive_ref: null,
      },
      {
        item_id: `${batchId}-005`,
        round: 1,
        destination: "discard",
        redraw: false,
        archive_ref: null,
      },
    ];

    // 1. Premature ack before review_done = true -> 409 review_not_done
    const prematureRes = await worker.fetch(
      new Request("https://review.example.test/api/agent/ack", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ batch_id: batchId, items: validAckItems }),
      }),
      h.env
    );
    expect(prematureRes.status).toBe(409);
    expect(await prematureRes.json()).toEqual({
      error: "review_not_done",
      review_done: false,
    });

    // Lock batch (review_done = true)
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

    // 2. Missing item in ack payload -> 409 items_coverage_mismatch (no data deleted!)
    const missingItemRes = await worker.fetch(
      new Request("https://review.example.test/api/agent/ack", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ batch_id: batchId, items: validAckItems.slice(0, 4) }),
      }),
      h.env
    );
    expect(missingItemRes.status).toBe(409);
    expect(await missingItemRes.json()).toMatchObject({
      error: "items_coverage_mismatch",
      missing_items: [{ item_id: `${batchId}-005`, round: 1 }],
    });
    expect(h.r2.keys(`previews/argon-mac/${batchId}/`)).toHaveLength(5);

    // 3. Missing / whitespace archive_ref on tier=0 archived item -> 409 missing_archive_ref
    const missingRefItems = validAckItems.map((it) =>
      it.item_id === `${batchId}-002` ? { ...it, archive_ref: "   " } : it
    );
    const missingRefRes = await worker.fetch(
      new Request("https://review.example.test/api/agent/ack", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ batch_id: batchId, items: missingRefItems }),
      }),
      h.env
    );
    expect(missingRefRes.status).toBe(409);
    expect(await missingRefRes.json()).toEqual({
      error: "missing_archive_ref",
      missing_items: [`${batchId}-002`],
    });
    expect(h.r2.keys(`previews/argon-mac/${batchId}/`)).toHaveLength(5);

    // 4. Reviewer revokes review_done -> false, changes item 005 to tier=2 (archive), re-locks review_done -> true;
    //    Agent tries to ack with stale item 005 (discard) -> 409 disposition_mismatch!
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
    expect(
      ((await revokeRes.json()) as { batch: { review_done: boolean; review_done_at: null } }).batch
    ).toMatchObject({ review_done: false, review_done_at: null });

    await worker.fetch(
      new Request(
        `https://review.example.test/api/review/batches/${batchId}/items/${batchId}-005/1`,
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

    const staleDispositionRes = await worker.fetch(
      new Request("https://review.example.test/api/agent/ack", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ batch_id: batchId, items: validAckItems }),
      }),
      h.env
    );
    expect(staleDispositionRes.status).toBe(409);
    expect(await staleDispositionRes.json()).toMatchObject({
      error: "disposition_mismatch",
      mismatches: [
        {
          item_id: `${batchId}-005`,
          round: 1,
          expected: { destination: "archive", redraw: false },
          received: { destination: "discard", redraw: false },
        },
      ],
    });
    expect(h.r2.keys(`previews/argon-mac/${batchId}/`)).toHaveLength(5);

    // 5. Updated valid ack -> 200 OK with purged_previews + receipt, deleting R2 & D1
    const updatedAckItems = validAckItems.map((it) =>
      it.item_id === `${batchId}-005`
        ? { ...it, destination: "archive", archive_ref: "02_heart/005_portrait.png" }
        : it
    );

    const okAckRes = await worker.fetch(
      new Request("https://review.example.test/api/agent/ack", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ batch_id: batchId, items: updatedAckItems }),
      }),
      h.env
    );
    expect(okAckRes.status).toBe(200);
    expect(await okAckRes.json()).toEqual({
      ok: true,
      batch_id: batchId,
      purged_previews: 5,
      receipt: {
        archive: [`${batchId}-001`, `${batchId}-002`, `${batchId}-005`],
        repair: [`${batchId}-003`],
        discard: [`${batchId}-004`],
        redraw: [`${batchId}-001`, `${batchId}-003`, `${batchId}-004`],
      },
    });

    expect(h.r2.keys(`previews/argon-mac/${batchId}/`)).toHaveLength(0);
    const afterDetail = await worker.fetch(
      new Request(`https://review.example.test/api/review/batches/${batchId}`, {
        headers: { "Cf-Access-Jwt-Assertion": jwt },
      }),
      h.env
    );
    expect(afterDetail.status).toBe(404);

    h.db.close();
  });
});

describe("Same-Round Overwrite, Cross-Batch Conflict & round+1 Lineage", () => {
  it("resets verdict on same-round overwrite, rejects other-batch same-round conflict, and preserves prior round on round+1", async () => {
    const h = await createTestHarness();
    const token = h.agentTokens["muse-main"]!;
    const jwt = await h.signReviewerJwt();
    const b1 = "20261119-museai-gpt-01";
    const b2 = "20261119-museai-gpt-02";

    await worker.fetch(
      buildPushRequest({
        token,
        manifestAgentId: "muse-main",
        batchId: b1,
        source: "museai",
        line: "gpt",
        items: [
          { item_id: `${b1}-001`, round: 1 },
          { item_id: `${b1}-002`, round: 1 },
        ],
      }),
      h.env
    );

    // Reviewer judges 001 as tier=3 + H
    await worker.fetch(
      new Request(`https://review.example.test/api/review/batches/${b1}/items/${b1}-001/1`, {
        method: "PATCH",
        headers: {
          "Cf-Access-Jwt-Assertion": jwt,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tier: 3, flags: ["H"], note: "fix thumb" }),
      }),
      h.env
    );

    // Same-round overwrite in b1 resets verdict
    const newBytes = makeFakeWebpBytes("updated-r1");
    await worker.fetch(
      buildPushRequest({
        token,
        manifestAgentId: "muse-main",
        batchId: b1,
        source: "museai",
        line: "gpt",
        items: [{ item_id: `${b1}-001`, round: 1, bytes: newBytes }],
      }),
      h.env
    );

    const b1Verdicts = (await (
      await worker.fetch(
        new Request(`https://review.example.test/api/agent/verdicts?batch_id=${b1}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        h.env
      )
    ).json()) as { items: Array<Record<string, unknown>> };
    expect(b1Verdicts.items[0]).toMatchObject({
      item_id: `${b1}-001`,
      round: 1,
      tier: null,
      flags: [],
      destination: "discard",
      redraw: false,
      note: "",
    });

    // Conflict in different batch with same round=1
    const conflictRes = await worker.fetch(
      buildPushRequest({
        token,
        manifestAgentId: "muse-main",
        batchId: b2,
        source: "museai",
        line: "gpt",
        items: [{ item_id: `${b1}-002`, round: 1 }],
      }),
      h.env
    );
    expect(await conflictRes.json()).toEqual({
      batch_id: b2,
      pushed_count: 0,
      accepted: [],
      rejected: [{ item_id: `${b1}-002`, reason: "conflict_other_batch" }],
    });

    // round=2 re-push of original item_id into b2 succeeds without modifying round=1 in b1
    const round2Res = await worker.fetch(
      buildPushRequest({
        token,
        manifestAgentId: "muse-main",
        batchId: b2,
        source: "museai",
        line: "gpt",
        items: [{ item_id: `${b1}-002`, round: 2, parent_item_id: `${b1}-002` }],
      }),
      h.env
    );
    expect(await round2Res.json()).toEqual({
      batch_id: b2,
      pushed_count: 1,
      accepted: [`${b1}-002`],
      rejected: [],
    });

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

    const batchFresh = "20261218-museai-gpt-01";
    const batch8d = "20261211-museai-gpt-01";
    const batch35d = "20261114-museai-gpt-01";

    for (const bId of [batchFresh, batch8d, batch35d]) {
      await worker.fetch(
        buildPushRequest({
          token,
          manifestAgentId: "muse-main",
          batchId: bId,
          line: "gpt",
          items: [
            { item_id: `${bId}-001`, round: 1 },
            { item_id: `${bId}-002`, round: 1 },
          ],
        }),
        h.env
      );
    }

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

    await worker.scheduled({ scheduledTime: now.getTime(), cron: "0 4 * * *" }, h.env);

    expect(h.r2.keys(`previews/muse-main/${batchFresh}/`)).toHaveLength(2);
    expect(h.r2.keys(`previews/muse-main/${batch8d}/`)).toHaveLength(0);
    const verdicts8dRes = await worker.fetch(
      new Request(`https://review.example.test/api/agent/verdicts?batch_id=${batch8d}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      h.env
    );
    expect(verdicts8dRes.status).toBe(200);

    const purgedPreviewRes = await worker.fetch(
      new Request(`https://review.example.test/api/review/previews/${batch8d}/${batch8d}-001/1`, {
        headers: { "Cf-Access-Jwt-Assertion": jwt },
      }),
      h.env
    );
    expect(purgedPreviewRes.status).toBe(404);

    const secondRun = await runCleanup(h.env, now);
    expect(secondRun.purged_previews_batches).toEqual([]);
    expect(secondRun.deleted_expired_batches).toEqual([]);

    expect(h.r2.keys(`previews/muse-main/${batch35d}/`)).toHaveLength(0);
    expect(
      await h.db.prepare("SELECT * FROM batches WHERE batch_id = ?").bind(batch35d).first()
    ).toBeNull();

    h.db.close();
  });
});

describe("Local Sandbox SQLite Persistence & HTTP Bridge Helper", () => {
  it("supports file-backed SQLite inside .test-sandboxes/worker and serves real localhost HTTP requests", async () => {
    fs.mkdirSync(WORKER_SANDBOX_DIR, { recursive: true });
    const dbFile = path.join(WORKER_SANDBOX_DIR, "test-bridge-v4.sqlite");
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
      expect(await authRes.json()).toEqual({ batches: [], channels: [] });
    } finally {
      await srv.close();
      h.db.close();
      if (fs.existsSync(dbFile)) {
        fs.unlinkSync(dbFile);
      }
    }
  });
});
