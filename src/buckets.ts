import type {
  DestinationName,
  DispositionCounts,
  FlagCode,
  ItemDisposition,
  TierValue,
} from "./types.js";

export const VALID_FLAGS: readonly FlagCode[] = ["H", "F", "O", "R"] as const;
const REPAIR_FLAGS = new Set<FlagCode>(["H", "F", "O"]);

export function isValidFlag(value: unknown): value is FlagCode {
  return typeof value === "string" && (VALID_FLAGS as readonly string[]).includes(value);
}

export function isValidTier(value: unknown): value is TierValue {
  return value === null || value === 0 || value === 1 || value === 2 || value === 3;
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
 * Orthogonal single-item disposition formula (v4 Spec §2.2):
 * - Mutually exclusive primary `destination`:
 *   1) Any of H / F / O in flags -> "repair" (tier preserved as intent_tier in D1/ledger)
 *   2) Else tier !== null (0 | 1 | 2 | 3) -> "archive"
 *   3) Else -> "discard"
 * - Independent side-channel `redraw`:
 *   `flags.includes("R")`
 */
export function resolveDisposition(tier: TierValue, flags: readonly FlagCode[]): ItemDisposition {
  let destination: DestinationName;
  let hasRepairFlag = false;
  for (const flag of flags) {
    if (REPAIR_FLAGS.has(flag)) {
      hasRepairFlag = true;
      break;
    }
  }

  if (hasRepairFlag) {
    destination = "repair";
  } else if (tier !== null && tier !== undefined) {
    destination = "archive";
  } else {
    destination = "discard";
  }

  return {
    destination,
    redraw: flags.includes("R"),
  };
}

export function isItemJudged(tier: TierValue, flags: readonly FlagCode[], note: string): boolean {
  return (tier !== null && tier !== undefined) || flags.length > 0 || note.trim() !== "";
}

export function computeBatchCounts(
  items: ReadonlyArray<{ tier: TierValue; flags: readonly FlagCode[] }>,
  pushedCountOverride?: number
): DispositionCounts {
  let archive = 0;
  let repair = 0;
  let discard = 0;
  let redraw = 0;

  for (const item of items) {
    const disp = resolveDisposition(item.tier, item.flags);
    if (disp.destination === "repair") {
      repair += 1;
    } else if (disp.destination === "archive") {
      archive += 1;
    } else {
      discard += 1;
    }

    if (disp.redraw) {
      redraw += 1;
    }
  }

  const pushed = pushedCountOverride !== undefined ? pushedCountOverride : items.length;
  return {
    pushed,
    archive,
    repair,
    discard,
    redraw,
  };
}
