import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";

import worker from "../../src/index.js";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  Env,
  Fetcher,
  R2Bucket,
  R2HttpMetadata,
  R2ListOptions,
  R2Object,
  R2ObjectBody,
  R2Objects,
  R2PutOptions,
} from "../../src/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, "../..");
export const MIGRATION_SQL_PATH = path.join(REPO_ROOT, "migrations", "0001_init.sql");
export const WORKER_SANDBOX_DIR = path.join(REPO_ROOT, ".test-sandboxes", "worker");

function toSqlValue(val: unknown): SQLInputValue {
  if (val === undefined || val === null) {
    return null;
  }
  if (typeof val === "boolean") {
    return val ? 1 : 0;
  }
  if (typeof val === "number" || typeof val === "bigint" || typeof val === "string") {
    return val;
  }
  if (val instanceof Uint8Array) {
    return val;
  }
  if (val instanceof ArrayBuffer) {
    return new Uint8Array(val);
  }
  return String(val);
}

class SqliteD1PreparedStatement implements D1PreparedStatement {
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private readonly boundValues: SQLInputValue[];

  constructor(db: DatabaseSync, sql: string, boundValues: SQLInputValue[] = []) {
    this.db = db;
    this.sql = sql;
    this.boundValues = boundValues;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteD1PreparedStatement(this.db, this.sql, values.map(toSqlValue));
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.boundValues) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    const plain = { ...row };
    if (colName !== undefined) {
      const val = plain[colName];
      return (val === undefined ? null : val) as T;
    }
    return plain as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...this.boundValues) as Array<Record<string, unknown>>;
    const results = rows.map((r) => ({ ...r }) as T);
    return {
      results,
      success: true,
      meta: { row_count: results.length },
    };
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const stmt = this.db.prepare(this.sql);
    const res = stmt.run(...this.boundValues);
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(res.changes),
        last_row_id: Number(res.lastInsertRowid),
      },
    };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const stmt = this.db.prepare(this.sql);
    stmt.setReturnArrays(true);
    const rows = stmt.all(...this.boundValues) as unknown[];
    return rows as T[];
  }

  executeSync(): D1Result<Record<string, unknown>> {
    const trimmed = this.sql.trim().toUpperCase();
    const stmt = this.db.prepare(this.sql);
    if (trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA") || trimmed.includes("RETURNING")) {
      const rows = stmt.all(...this.boundValues) as Array<Record<string, unknown>>;
      return {
        results: rows.map((r) => ({ ...r })),
        success: true,
        meta: { row_count: rows.length },
      };
    }
    const res = stmt.run(...this.boundValues);
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(res.changes),
        last_row_id: Number(res.lastInsertRowid),
      },
    };
  }
}

export class SqliteD1Database implements D1Database {
  public readonly sqlite: DatabaseSync;

  constructor(sqlitePath = ":memory:", runMigrations = true) {
    if (sqlitePath !== ":memory:") {
      fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    }
    this.sqlite = new DatabaseSync(sqlitePath);
    if (runMigrations) {
      const migrationSql = fs.readFileSync(MIGRATION_SQL_PATH, "utf8");
      this.sqlite.exec(migrationSql);
    }
  }

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1PreparedStatement(this.sqlite, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results: D1Result<T>[] = [];
      for (const stmt of statements) {
        if (stmt instanceof SqliteD1PreparedStatement) {
          results.push(stmt.executeSync() as D1Result<T>);
        } else {
          results.push(await stmt.run<T>());
        }
      }
      this.sqlite.exec("COMMIT");
      return results;
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    const start = performance.now();
    this.sqlite.exec(query);
    return { count: 1, duration: performance.now() - start };
  }

  close(): void {
    this.sqlite.close();
  }
}

interface StoredR2Entry {
  key: string;
  bytes: Uint8Array;
  etag: string;
  uploaded: Date;
  httpMetadata?: R2HttpMetadata;
  customMetadata?: Record<string, string>;
}

async function normalizeToBytes(
  value: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string | Blob | null
): Promise<Uint8Array> {
  if (value === null) {
    return new Uint8Array(0);
  }
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  // ReadableStream
  const reader = value.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) {
      break;
    }
    if (chunk) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export class InMemoryR2Bucket implements R2Bucket {
  public readonly objects = new Map<string, StoredR2Entry>();
  private readonly defaultPageSize: number;
  private writeSeq = 0;

  constructor(options?: { pageSize?: number }) {
    this.defaultPageSize = options?.pageSize ?? 1000;
  }

  keys(prefix?: string): string[] {
    const all = Array.from(this.objects.keys()).sort();
    if (!prefix) {
      return all;
    }
    return all.filter((k) => k.startsWith(prefix));
  }

  async put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string | Blob | null,
    options?: R2PutOptions
  ): Promise<R2Object> {
    const bytes = await normalizeToBytes(value);
    this.writeSeq += 1;
    const entry: StoredR2Entry = {
      key,
      bytes,
      etag: `"etag-${this.writeSeq}-${bytes.byteLength}"`,
      uploaded: new Date(),
      httpMetadata: options?.httpMetadata ? { ...options.httpMetadata } : undefined,
      customMetadata: options?.customMetadata ? { ...options.customMetadata } : undefined,
    };
    this.objects.set(key, entry);
    return {
      key: entry.key,
      size: entry.bytes.byteLength,
      etag: entry.etag,
      uploaded: entry.uploaded,
      httpMetadata: entry.httpMetadata,
      customMetadata: entry.customMetadata,
    };
  }

  async head(key: string): Promise<R2Object | null> {
    const entry = this.objects.get(key);
    if (!entry) {
      return null;
    }
    return {
      key: entry.key,
      size: entry.bytes.byteLength,
      etag: entry.etag,
      uploaded: entry.uploaded,
      httpMetadata: entry.httpMetadata,
      customMetadata: entry.customMetadata,
    };
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const entry = this.objects.get(key);
    if (!entry) {
      return null;
    }
    const copy = new Uint8Array(entry.bytes);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(copy);
        controller.close();
      },
    });
    return {
      key: entry.key,
      size: copy.byteLength,
      etag: entry.etag,
      uploaded: entry.uploaded,
      httpMetadata: entry.httpMetadata,
      customMetadata: entry.customMetadata,
      body,
      async arrayBuffer(): Promise<ArrayBuffer> {
        return copy.slice().buffer;
      },
      async text(): Promise<string> {
        return new TextDecoder().decode(copy);
      },
      async bytes(): Promise<Uint8Array> {
        return copy.slice();
      },
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      this.objects.delete(k);
    }
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const prefix = options?.prefix ?? "";
    const cursor = options?.cursor;
    const requestedLimit = options?.limit ?? this.defaultPageSize;
    const effectiveLimit = Math.min(requestedLimit, this.defaultPageSize);

    const matchingKeys = Array.from(this.objects.keys())
      .filter((k) => k.startsWith(prefix) && (cursor === undefined || k > cursor))
      .sort();

    const pageKeys = matchingKeys.slice(0, effectiveLimit);
    const truncated = matchingKeys.length > effectiveLimit;
    const nextCursor = truncated ? pageKeys[pageKeys.length - 1] : undefined;

    const objs: R2Object[] = pageKeys.map((k) => {
      const entry = this.objects.get(k)!;
      return {
        key: entry.key,
        size: entry.bytes.byteLength,
        etag: entry.etag,
        uploaded: entry.uploaded,
        httpMetadata: entry.httpMetadata,
        customMetadata: entry.customMetadata,
      };
    });

    return {
      objects: objs,
      truncated,
      cursor: nextCursor,
    };
  }
}

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const DEFAULT_MOCK_ASSETS: Record<string, { body: string; contentType: string }> = {
  "/index.html": {
    body: '<!doctype html><html><head><meta name="robots" content="noindex, nofollow, noarchive"><title>审图哨所</title></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>',
    contentType: "text/html; charset=utf-8",
  },
  "/app.js": {
    body: 'console.log("review-outpost-ui");\n',
    contentType: "application/javascript; charset=utf-8",
  },
  "/styles.css": {
    body: "body { background: #0d0f14; color: #f1f5f9; }\n",
    contentType: "text/css; charset=utf-8",
  },
  "/robots.txt": {
    body: "User-agent: *\nDisallow: /\n",
    contentType: "text/plain; charset=utf-8",
  },
};

export function createAssetsFetcher(options?: {
  publicDir?: string;
  files?: Record<string, { body: string | Uint8Array; contentType: string }>;
}): Fetcher {
  const publicDir = options?.publicDir ? path.resolve(options.publicDir) : null;
  const fallbackFiles = options?.files ?? DEFAULT_MOCK_ASSETS;

  return {
    async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      const url = new URL(req.url);
      const assetPath = url.pathname === "/" ? "/index.html" : url.pathname;

      if (publicDir && fs.existsSync(publicDir)) {
        const safeRel = assetPath.replace(/^\/+/, "");
        const resolved = path.resolve(publicDir, safeRel);
        if (
          (resolved === publicDir || resolved.startsWith(publicDir + path.sep)) &&
          fs.existsSync(resolved) &&
          fs.statSync(resolved).isFile()
        ) {
          const ext = path.extname(resolved).toLowerCase();
          const contentType = MIME_BY_EXT[ext] ?? "application/octet-stream";
          const buf = fs.readFileSync(resolved);
          return new Response(req.method === "HEAD" ? null : buf, {
            status: 200,
            headers: { "Content-Type": contentType },
          });
        }
        return new Response("Not Found", { status: 404 });
      }

      const found = fallbackFiles[assetPath];
      if (!found) {
        return new Response("Not Found", { status: 404 });
      }
      const bodyPayload =
        typeof found.body === "string" ? found.body : new Uint8Array(found.body);
      return new Response(req.method === "HEAD" ? null : bodyPayload, {
        status: 200,
        headers: { "Content-Type": found.contentType },
      });
    },
  };
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function jsonToBase64Url(obj: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(obj)));
}

export interface TestAccessKeys {
  kid: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  jwksJson: string;
}

export async function createTestAccessKeys(kid = "test-access-kid-1"): Promise<TestAccessKeys> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );

  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const jwks = {
    keys: [
      {
        ...publicJwk,
        kid,
        alg: "RS256",
        use: "sig",
      },
    ],
  };

  return {
    kid,
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    jwksJson: JSON.stringify(jwks),
  };
}

export interface SignAccessJwtOptions {
  email?: string | null;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  kid?: string;
  alg?: string;
}

export async function signTestAccessJwt(
  keys: TestAccessKeys,
  options?: SignAccessJwtOptions
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const header: Record<string, unknown> = {
    alg: options?.alg ?? "RS256",
    typ: "JWT",
    kid: options?.kid ?? keys.kid,
  };
  const payload: Record<string, unknown> = {
    aud: options?.aud ?? ["test-aud-tag-0000"],
    iat: nowSec - 10,
    exp: options?.exp ?? nowSec + 3600,
  };
  if (options?.email !== null) {
    payload.email = options?.email ?? "reviewer@example.test";
  }
  if (options?.nbf !== undefined) {
    payload.nbf = options.nbf;
  }

  const signingInput = `${jsonToBase64Url(header)}.${jsonToBase64Url(payload)}`;
  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${bytesToBase64Url(new Uint8Array(sigBuf))}`;
}

export interface TestHarness {
  env: Env;
  db: SqliteD1Database;
  r2: InMemoryR2Bucket;
  accessKeys: TestAccessKeys;
  agentTokens: Record<string, string>;
  allowedEmail: string;
  accessAud: string;
  signReviewerJwt: (overrides?: SignAccessJwtOptions) => Promise<string>;
}

export async function createTestHarness(options?: {
  sqlitePath?: string;
  r2PageSize?: number;
  publicDir?: string;
  agentTokens?: Record<string, string>;
  allowedEmails?: string;
  accessAud?: string;
  envOverrides?: Partial<Env>;
}): Promise<TestHarness> {
  const db = new SqliteD1Database(options?.sqlitePath ?? ":memory:");
  const r2 = new InMemoryR2Bucket({ pageSize: options?.r2PageSize });
  const assets = createAssetsFetcher({ publicDir: options?.publicDir });
  const accessKeys = await createTestAccessKeys();

  const agentTokens = options?.agentTokens ?? {
    "muse-main": "dummy-token-muse-main-0000000000000001",
    "argon-mac": "dummy-token-argon-mac-0000000000000002",
  };
  const allowedEmail = "reviewer@example.test";
  const accessAud = options?.accessAud ?? "test-aud-tag-0000";

  const env: Env = {
    DB: db,
    PREVIEWS_BUCKET: r2,
    ASSETS: assets,
    AGENT_TOKENS_JSON: JSON.stringify(agentTokens),
    CF_ACCESS_TEAM_DOMAIN: "example-team.cloudflareaccess.com",
    CF_ACCESS_AUD: accessAud,
    CF_ACCESS_ALLOWED_EMAILS: options?.allowedEmails ?? allowedEmail,
    CF_ACCESS_JWKS_JSON: accessKeys.jwksJson,
    ENVIRONMENT: "production",
    DEV_BYPASS_ACCESS: "false",
    ...options?.envOverrides,
  };

  return {
    env,
    db,
    r2,
    accessKeys,
    agentTokens,
    allowedEmail,
    accessAud,
    signReviewerJwt: (overrides?: SignAccessJwtOptions) =>
      signTestAccessJwt(accessKeys, {
        email: allowedEmail,
        aud: [accessAud],
        ...overrides,
      }),
  };
}

export interface RunningWorkerServer {
  server: http.Server;
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Starts a real local HTTP server wrapping `src/index.ts` (`worker.fetch`)
 * so cross-stack E2E tests (e.g. `python3 agent/hub_client.py`) can talk to
 * the exact Cloudflare Worker code over localhost TCP.
 */
export async function startLocalWorkerServer(
  env: Env,
  host = "127.0.0.1"
): Promise<RunningWorkerServer> {
  const server = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks);

      const protocol = "http";
      const authority = req.headers.host || `${host}`;
      const fullUrl = `${protocol}://${authority}${req.url || "/"}`;

      const headers = new Headers();
      for (const [key, val] of Object.entries(req.headers)) {
        if (val === undefined) {
          continue;
        }
        if (Array.isArray(val)) {
          for (const item of val) {
            headers.append(key, item);
          }
        } else {
          headers.set(key, val);
        }
      }

      const method = req.method || "GET";
      const hasBody = method !== "GET" && method !== "HEAD" && rawBody.byteLength > 0;
      const webReq = new Request(fullUrl, {
        method,
        headers,
        body: hasBody ? rawBody : undefined,
      });

      const webRes = await worker.fetch(webReq, env);
      res.statusCode = webRes.status;
      webRes.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      const respBuf = Buffer.from(await webRes.arrayBuffer());
      res.end(respBuf);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error: "bridge_error",
          message: err instanceof Error ? err.message : "Unknown error",
        })
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const port = addr.port;
  const baseUrl = `http://${host}:${port}`;

  return {
    server,
    port,
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
