import type { BucketCounts, BucketName, FlagCode, TierValue } from "./types.js";

export const VALID_FLAGS: readonly FlagCode[] = ["H", "F", "O", "R"] as const;
const REPAIR_FLAGS = new Set<FlagCode>(["H", "F", "O"]);

export function isValidFlag(value: unknown): value is FlagCode {
  return typeof value === "string" && (VALID_FLAGS as readonly string[]).includes(value);
}

export function isValidTier(value: unknown): value is TierValue {
  return value === null || value === 1 || value === 2 || value === 3;
}

/**
 * Normalize and deduplicate flags in canonical order: H, F, O, R.
 * Throws Error if any flag is invalid when strict=true.
 */
export function normalizeFlags(input: unknown, strict = true): FlagCode[] {
  if (!Array.isArray(input)) {
    if (strict) {
      throw new Error("flags must be an array");
    }
    return [];
  }
  const seen = new Set<FlagCode>();
  for (const raw of input) {
    if (!isValidFlag(raw)) {
      if (strict) {
        throw new Error(`Invalid flag: ${String(raw)}`);
      }
      continue;
    }
    seen.add(raw);
  }
  return VALID_FLAGS.filter((code) => seen.has(code));
}

export function parseFlagsJson(flagsJson: string | null | undefined): FlagCode[] {
  if (!flagsJson) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(flagsJson);
    return normalizeFlags(parsed, false);
  } catch {
    return [];
  }
}

/**
 * Strict mutually exclusive bucket classification (Rule 3):
 * 1. Any of H / F / O in flags -> "repair" (original tier stays stored in D1/ledger)
 * 2. Else R in flags -> "redraw"
 * 3. Else tier in {1, 2, 3} -> "archived"
 * 4. Else -> "discarded"
 */
export function resolveBucket(tier: TierValue, flags: readonly FlagCode[]): BucketName {
  for (const flag of flags) {
    if (REPAIR_FLAGS.has(flag)) {
      return "repair";
    }
  }
  if (flags.includes("R")) {
    return "redraw";
  }
  if (tier === 1 || tier === 2 || tier === 3) {
    return "archived";
  }
  return "discarded";
}

export function isItemJudged(tier: TierValue, flags: readonly FlagCode[], note: string): boolean {
  return tier !== null || flags.length > 0 || note.trim() !== "";
}

export function computeBatchCounts(
  items: ReadonlyArray<{ tier: TierValue; flags: readonly FlagCode[] }>,
  pushedCountOverride?: number
): BucketCounts {
  let archived = 0;
  let repair = 0;
  let redraw = 0;
  let discarded = 0;

  for (const item of items) {
    const bucket = resolveBucket(item.tier, item.flags);
    if (bucket === "repair") {
      repair += 1;
    } else if (bucket === "redraw") {
      redraw += 1;
    } else if (bucket === "archived") {
      archived += 1;
    } else {
      discarded += 1;
    }
  }

  const pushed = pushedCountOverride !== undefined ? pushedCountOverride : items.length;
  return {
    pushed,
    archived,
    repair,
    redraw,
    discarded,
  };
}

export function countsMatch(a: BucketCounts, b: BucketCounts): boolean {
  const sumA = a.archived + a.repair + a.redraw + a.discarded;
  const sumB = b.archived + b.repair + b.redraw + b.discarded;
  return (
    sumA === a.pushed &&
    sumB === b.pushed &&
    a.pushed === b.pushed &&
    a.archived === b.archived &&
    a.repair === b.repair &&
    a.redraw === b.redraw &&
    a.discarded === b.discarded
  );
}
