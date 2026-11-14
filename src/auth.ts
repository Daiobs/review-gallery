import type { Env } from "./types.js";
import { isSafeId, jsonResponse } from "./utils.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type AgentAuthResult =
  | { ok: true; agentId: string }
  | { ok: false; response: Response };

export type AccessAuthResult =
  | { ok: true; email: string }
  | { ok: false; response: Response };

interface CachedJwks {
  keys: JsonWebKey[];
  fetchedAt: number;
}

const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const JWKS_ROTATION_MIN_REFETCH_MS = 10 * 1000;
const jwksCache = new Map<string, CachedJwks>();

export function clearJwksCache(): void {
  jwksCache.clear();
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return new Uint8Array(digest);
}

function constantTimeEqual32(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.byteLength ^ b.byteLength;
  const len = Math.max(a.byteLength, b.byteLength);
  for (let i = 0; i < len; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

function parseBearerToken(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }
  const trimmed = authHeader.trim();
  const match = /^Bearer\s+(\S+)$/i.exec(trimmed);
  if (!match || !match[1]) {
    return null;
  }
  return match[1];
}

function parseAgentTokensMap(rawJson: string | undefined): Array<[string, string]> {
  if (!rawJson || !rawJson.trim()) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    const entries: Array<[string, string]> = [];
    for (const [agentId, token] of Object.entries(parsed as Record<string, unknown>)) {
      if (isSafeId(agentId) && typeof token === "string" && token.length > 0) {
        entries.push([agentId, token]);
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Machine-side authentication for `/api/agent/*`.
 * Computes SHA-256 digests via Web Crypto and performs constant-time comparison
 * across ALL configured entries without early-return short-circuiting.
 */
export async function authenticateAgent(request: Request, env: Env): Promise<AgentAuthResult> {
  const providedToken = parseBearerToken(request.headers.get("Authorization"));
  if (!providedToken) {
    return {
      ok: false,
      response: jsonResponse({ error: "unauthorized", message: "Missing or invalid Bearer token" }, 401),
    };
  }

  const configuredEntries = parseAgentTokensMap(env.AGENT_TOKENS_JSON);
  if (configuredEntries.length === 0) {
    return {
      ok: false,
      response: jsonResponse({ error: "unauthorized", message: "No agent tokens configured" }, 401),
    };
  }

  const providedDigest = await sha256Bytes(providedToken);
  let matchedAgentId: string | null = null;

  // Iterate across ALL configured entries without early exit to avoid timing side channels.
  for (const [candidateAgentId, candidateToken] of configuredEntries) {
    const expectedDigest = await sha256Bytes(candidateToken);
    const isMatch = constantTimeEqual32(providedDigest, expectedDigest);
    if (isMatch && matchedAgentId === null) {
      matchedAgentId = candidateAgentId;
    }
  }

  if (matchedAgentId === null) {
    return {
      ok: false,
      response: jsonResponse({ error: "unauthorized", message: "Invalid agent token" }, 401),
    };
  }

  if (request.headers.has("X-Agent-Id")) {
    const headerAgentId = (request.headers.get("X-Agent-Id") ?? "").trim();
    if (headerAgentId !== matchedAgentId) {
      return {
        ok: false,
        response: jsonResponse(
          { error: "forbidden_agent_mismatch", message: "X-Agent-Id does not match token owner" },
          403
        ),
      };
    }
  }

  return { ok: true, agentId: matchedAgentId };
}

function base64UrlToBytes(segment: string): Uint8Array | null {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    return null;
  }
  const mod = segment.length % 4;
  if (mod === 1) {
    return null;
  }
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/") + (mod === 0 ? "" : "=".repeat(4 - mod));
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function normalizeTeamDomain(rawDomain: string | undefined): string | null {
  if (!rawDomain) {
    return null;
  }
  let cleaned = rawDomain.trim();
  cleaned = cleaned.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!cleaned || !/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(cleaned) || cleaned.includes("..")) {
    return null;
  }
  return cleaned;
}

function extractJwkList(raw: unknown): JsonWebKey[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const maybeKeys = (raw as { keys?: unknown }).keys;
  if (!Array.isArray(maybeKeys)) {
    return [];
  }
  return maybeKeys.filter(
    (k): k is JsonWebKey =>
      Boolean(k) &&
      typeof k === "object" &&
      (k as JsonWebKey).kty === "RSA" &&
      typeof (k as JsonWebKey).n === "string" &&
      typeof (k as JsonWebKey).e === "string"
  );
}

async function loadAccessJwks(
  env: Env,
  requiredKid: string | undefined,
  nowMs: number
): Promise<JsonWebKey[]> {
  if (env.CF_ACCESS_JWKS_JSON && env.CF_ACCESS_JWKS_JSON.trim()) {
    try {
      const parsed: unknown = JSON.parse(env.CF_ACCESS_JWKS_JSON);
      return extractJwkList(parsed);
    } catch {
      return [];
    }
  }

  const teamDomain = normalizeTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  if (!teamDomain) {
    return [];
  }

  const cached = jwksCache.get(teamDomain);
  const cacheValid = cached !== undefined && nowMs - cached.fetchedAt < JWKS_CACHE_TTL_MS;
  const hasKidInCache =
    cached !== undefined &&
    (!requiredKid || cached.keys.some((k) => (k as { kid?: string }).kid === requiredKid));

  if (cacheValid && hasKidInCache) {
    return cached.keys;
  }

  if (
    cached !== undefined &&
    !hasKidInCache &&
    nowMs - cached.fetchedAt < JWKS_ROTATION_MIN_REFETCH_MS
  ) {
    return cached.keys;
  }

  const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
  try {
    const resp = await fetch(certsUrl, {
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) {
      return cached ? cached.keys : [];
    }
    const data: unknown = await resp.json();
    const keys = extractJwkList(data);
    if (keys.length > 0) {
      jwksCache.set(teamDomain, { keys, fetchedAt: nowMs });
    }
    return keys;
  } catch {
    return cached ? cached.keys : [];
  }
}

interface JwtHeader {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
}

interface JwtPayload {
  aud?: unknown;
  email?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iss?: unknown;
  sub?: unknown;
}

function matchesAudience(claimAud: unknown, configuredAudRaw: string | undefined): boolean {
  if (!configuredAudRaw || !configuredAudRaw.trim()) {
    return false;
  }
  const expectedAuds = configuredAudRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (expectedAuds.length === 0) {
    return false;
  }

  if (typeof claimAud === "string") {
    return expectedAuds.includes(claimAud);
  }
  if (Array.isArray(claimAud)) {
    return claimAud.some((entry) => typeof entry === "string" && expectedAuds.includes(entry));
  }
  return false;
}

function parseAllowedEmails(raw: string | undefined): Set<string> {
  if (!raw || !raw.trim()) {
    return new Set();
  }
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Human reviewer authentication for static UI assets and `/api/review/*`.
 * Verifies Cloudflare Access `Cf-Access-Jwt-Assertion` RS256 signature, `exp`/`nbf`,
 * `aud`, and case-insensitive `email` allowlist.
 */
export async function authenticateAccess(
  request: Request,
  env: Env,
  now: Date = new Date()
): Promise<AccessAuthResult> {
  if (env.ENVIRONMENT === "development" && env.DEV_BYPASS_ACCESS === "true") {
    return { ok: true, email: "dev-bypass@localhost" };
  }

  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion || !assertion.trim()) {
    return {
      ok: false,
      response: jsonResponse(
        { error: "unauthorized", message: "Missing Cf-Access-Jwt-Assertion header" },
        401
      ),
    };
  }

  const parts = assertion.trim().split(".");
  if (parts.length !== 3) {
    return {
      ok: false,
      response: jsonResponse({ error: "unauthorized", message: "Malformed JWT structure" }, 401),
    };
  }

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  const headerBytes = base64UrlToBytes(headerB64);
  const payloadBytes = base64UrlToBytes(payloadB64);
  const signatureBytes = base64UrlToBytes(signatureB64);

  if (!headerBytes || !payloadBytes || !signatureBytes) {
    return {
      ok: false,
      response: jsonResponse({ error: "unauthorized", message: "Invalid JWT base64url encoding" }, 401),
    };
  }

  let header: JwtHeader;
  let payload: JwtPayload;
  try {
    header = JSON.parse(textDecoder.decode(headerBytes)) as JwtHeader;
    payload = JSON.parse(textDecoder.decode(payloadBytes)) as JwtPayload;
  } catch {
    return {
      ok: false,
      response: jsonResponse({ error: "unauthorized", message: "Invalid JWT JSON payload" }, 401),
    };
  }

  if (header.alg !== "RS256") {
    return {
      ok: false,
      response: jsonResponse({ error: "unauthorized", message: "Unsupported JWT algorithm" }, 401),
    };
  }

  const kid = typeof header.kid === "string" && header.kid.length > 0 ? header.kid : undefined;
  const nowMs = now.getTime();
  const allKeys = await loadAccessJwks(env, kid, nowMs);

  const candidateKeys = allKeys.filter((jwk) => {
    const jwkWithMeta = jwk as JsonWebKey & { kid?: string; use?: string };
    if (jwkWithMeta.use && jwkWithMeta.use !== "sig") {
      return false;
    }
    if (jwk.alg && jwk.alg !== "RS256") {
      return false;
    }
    if (kid && jwkWithMeta.kid !== kid) {
      return false;
    }
    return true;
  });

  if (candidateKeys.length === 0) {
    return {
      ok: false,
      response: jsonResponse({ error: "unauthorized", message: "No matching JWKS key found" }, 401),
    };
  }

  const signingInput = textEncoder.encode(`${headerB64}.${payloadB64}`);
  const sigBuffer = new Uint8Array(signatureBytes).buffer;
  const dataBuffer = new Uint8Array(signingInput).buffer;

  let signatureVerified = false;
  for (const jwk of candidateKeys) {
    try {
      const cryptoKey = await crypto.subtle.importKey(
        "jwk",
        {
          kty: "RSA",
          n: jwk.n,
          e: jwk.e,
          alg: "RS256",
          ext: true,
        },
        {
          name: "RSASSA-PKCS1-v1_5",
          hash: "SHA-256",
        },
        false,
        ["verify"]
      );
      const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, sigBuffer, dataBuffer);
      if (valid) {
        signatureVerified = true;
        break;
      }
    } catch {
      // Ignore invalid key entry and try next candidate key if any.
    }
  }

  if (!signatureVerified) {
    return {
      ok: false,
      response: jsonResponse({ error: "unauthorized", message: "Invalid JWT signature" }, 401),
    };
  }

  const nowSec = Math.floor(nowMs / 1000);
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= nowSec) {
    return {
      ok: false,
      response: jsonResponse({ error: "unauthorized", message: "JWT expired or missing exp" }, 401),
    };
  }

  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf) || payload.nbf > nowSec) {
      return {
        ok: false,
        response: jsonResponse({ error: "unauthorized", message: "JWT not yet valid (nbf)" }, 401),
      };
    }
  }

  if (!matchesAudience(payload.aud, env.CF_ACCESS_AUD)) {
    return {
      ok: false,
      response: jsonResponse({ error: "unauthorized", message: "JWT audience mismatch" }, 401),
    };
  }

  const allowedEmails = parseAllowedEmails(env.CF_ACCESS_ALLOWED_EMAILS);
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email || !allowedEmails.has(email)) {
    return {
      ok: false,
      response: jsonResponse({ error: "forbidden_email", message: "Email not permitted" }, 403),
    };
  }

  return { ok: true, email };
}
