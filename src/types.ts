export type FlagCode = "H" | "F" | "O" | "R";
export type TierValue = 1 | 2 | 3 | null;
export type BucketName = "archived" | "repair" | "redraw" | "discarded";

export interface BucketCounts {
  pushed: number;
  archived: number;
  repair: number;
  redraw: number;
  discarded: number;
}

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export interface R2HttpMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
}

export interface R2PutOptions {
  httpMetadata?: R2HttpMetadata;
  customMetadata?: Record<string, string>;
}

export interface R2Object {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
  httpMetadata?: R2HttpMetadata;
  customMetadata?: Record<string, string>;
}

export interface R2ObjectBody extends R2Object {
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  bytes?(): Promise<Uint8Array>;
}

export interface R2ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface R2Objects {
  objects: R2Object[];
  truncated: boolean;
  cursor?: string;
}

export interface R2Bucket {
  put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string | Blob | null,
    options?: R2PutOptions
  ): Promise<R2Object | null>;
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: R2ListOptions): Promise<R2Objects>;
}

export interface Fetcher {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

export interface ScheduledController {
  scheduledTime: number;
  cron: string;
  noRetry?: () => void;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?: () => void;
}

export interface Env {
  DB: D1Database;
  PREVIEWS_BUCKET: R2Bucket;
  ASSETS: Fetcher;

  AGENT_TOKENS_JSON?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_ALLOWED_EMAILS?: string;
  CF_ACCESS_JWKS_JSON?: string;
  ENVIRONMENT?: string;
  DEV_BYPASS_ACCESS?: string;
}

export interface BatchRow {
  batch_id: string;
  agent_id: string;
  pushed_count: number;
  review_done: number;
  created_at: string;
  previews_purged_at: string | null;
}

export interface VerdictRow {
  item_id: string;
  round: number;
  batch_id: string;
  filename: string | null;
  width: number | null;
  height: number | null;
  pushed_at: string;
  tier: number | null;
  flags_json: string;
  note: string;
  judged_at: string | null;
}

export interface PushManifestItem {
  item_id: string;
  round: number;
  filename?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface PushManifest {
  agent_id: string;
  batch_id: string;
  items: PushManifestItem[];
}

export interface BatchSummary {
  batch_id: string;
  agent_id: string;
  pushed_count: number;
  judged_count: number;
  review_done: boolean;
  created_at: string;
  previews_purged_at: string | null;
  counts: BucketCounts;
}

export interface ReviewItemView {
  item_id: string;
  round: number;
  batch_id: string;
  filename: string | null;
  width: number | null;
  height: number | null;
  pushed_at: string;
  tier: TierValue;
  flags: FlagCode[];
  note: string;
  judged_at: string | null;
  bucket: BucketName;
  preview_url: string;
}
