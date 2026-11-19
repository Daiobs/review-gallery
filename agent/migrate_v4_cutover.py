#!/usr/bin/env python3
"""Review Outpost v4 Cutover Migration CLI (migrate_v4_cutover.py).

Pure Python 3.9+ standard library tool with two idempotent/atomic subcommands:
1. `mark-ledger --ledger <ledger.jsonl>`
   Checks if `{"event": "cutover_v4_star_scale"}` already exists in the ledger;
   if not, atomically appends `{"event": "cutover_v4_star_scale", "ts": "..."}` with
   flock + flush + fsync.
2. `flip-star-table --file <star_table.json> [--in-place] [--output <path>]`
   Atomically flips legacy star values `1 <-> 3` (`2`, `0`, and `null` remain unchanged)
   across `{id: tier}` mappings or object lists/dicts carrying star fields, verifies
   100% pre/post entry count & per-tier symmetry (`old_1 == new_3`, `old_3 == new_1`,
   `old_2 == new_2`, `old_0 == new_0`, `old_null == new_null`), and writes via a
   same-directory temporary file + fsync + os.replace (strictly forbidding `/tmp`).
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import fcntl
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

FORBIDDEN_PATH_PREFIXES: Tuple[str, ...] = (
    "/tmp",
    "/private/tmp",
    "/var/tmp",
    "/private/var/tmp",
    "/etc",
    "/private/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/System",
    "/Library",
)

CUTOVER_EVENT_NAME = "cutover_v4_star_scale"
STAR_FIELD_CANDIDATES: Tuple[str, ...] = ("tier", "star", "stars", "final_tier", "intent_tier")
COLLECTION_WRAPPER_KEYS: Tuple[str, ...] = ("items", "entries", "records", "faces", "outfits", "anchors", "data")


class CutoverError(RuntimeError):
    """Base error for cutover migration failures."""


class PathGuardError(CutoverError):
    """Raised when any target path points to /tmp or system directories."""


def now_utc_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _matches_forbidden_prefix(normalized_path: str) -> Optional[str]:
    for prefix in FORBIDDEN_PATH_PREFIXES:
        if normalized_path == prefix or normalized_path.startswith(prefix + "/"):
            return prefix
    return None


def validate_safe_storage_path(path_value: Union[str, Path], label: str = "path") -> Path:
    raw = str(path_value).strip()
    if not raw or "\x00" in raw:
        raise PathGuardError(f"Invalid empty or null-containing {label}.")

    expanded = os.path.expanduser(raw)
    abs_path = os.path.abspath(expanded)
    real_path = os.path.realpath(expanded)

    for candidate in (abs_path, real_path):
        hit = _matches_forbidden_prefix(candidate)
        if hit is not None:
            raise PathGuardError(
                f"Rejected {label} '{path_value}' (resolved '{candidate}'): "
                f"storage under '{hit}' is strictly forbidden."
            )
    return Path(abs_path)


def flip_single_tier_value(val: Any, context: str = "tier") -> Optional[int]:
    """Flip legacy 1 <-> 3 while keeping 2, 0, and None unchanged."""
    if val is None:
        return None
    if isinstance(val, bool) or not isinstance(val, int) or val not in (0, 1, 2, 3):
        raise CutoverError(f"Unsupported star/tier value {val!r} at {context}; expected 0, 1, 2, 3, or null.")
    if val == 1:
        return 3
    if val == 3:
        return 1
    return val


def mark_ledger(ledger_path_raw: Union[str, Path]) -> Dict[str, Any]:
    """Idempotently append cutover_v4_star_scale marker to JSONL ledger under flock + fsync."""
    ledger_path = validate_safe_storage_path(ledger_path_raw, "ledger path")
    lock_path = validate_safe_storage_path(f"{ledger_path}.lock", "ledger lock path")
    ledger_path.parent.mkdir(parents=True, exist_ok=True)

    with open(lock_path, "a+", encoding="utf-8") as lock_fh:
        fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX)
        try:
            existing_marker: Optional[Dict[str, Any]] = None
            needs_leading_newline = False

            if ledger_path.is_file():
                raw_bytes = ledger_path.read_bytes()
                if raw_bytes and not raw_bytes.endswith(b"\n"):
                    needs_leading_newline = True
                text = raw_bytes.decode("utf-8", errors="strict")
                for line_no, raw_line in enumerate(text.splitlines(), start=1):
                    stripped = raw_line.strip()
                    if not stripped:
                        continue
                    try:
                        obj = json.loads(stripped)
                    except json.JSONDecodeError as exc:
                        raise CutoverError(
                            f"Corrupted JSON in ledger {ledger_path}:{line_no}: {exc}"
                        ) from exc
                    if isinstance(obj, dict) and obj.get("event") == CUTOVER_EVENT_NAME:
                        existing_marker = obj

            if existing_marker is not None:
                return {
                    "ok": True,
                    "ledger": str(ledger_path),
                    "already_marked": True,
                    "event": CUTOVER_EVENT_NAME,
                    "ts": existing_marker.get("ts"),
                }

            marker = {
                "event": CUTOVER_EVENT_NAME,
                "ts": now_utc_iso(),
            }
            prefix = "\n" if needs_leading_newline else ""
            payload = prefix + json.dumps(marker, ensure_ascii=False) + "\n"
            with open(ledger_path, "a", encoding="utf-8") as fh:
                fh.write(payload)
                fh.flush()
                os.fsync(fh.fileno())

            return {
                "ok": True,
                "ledger": str(ledger_path),
                "already_marked": False,
                "event": CUTOVER_EVENT_NAME,
                "ts": marker["ts"],
            }
        finally:
            fcntl.flock(lock_fh.fileno(), fcntl.LOCK_UN)


def _is_tier_scalar(val: Any) -> bool:
    return val is None or (isinstance(val, int) and not isinstance(val, bool) and val in (0, 1, 2, 3))


def _transform_and_count(data: Any, apply_flip: bool) -> Tuple[Any, Dict[str, int]]:
    """Traverse star table, optionally flipping 1<->3, and tally exact tier distribution."""
    counts: Dict[str, int] = {"total": 0, "3": 0, "2": 0, "1": 0, "0": 0, "null": 0}

    def record_tier(val: Optional[int]) -> None:
        counts["total"] += 1
        if val is None:
            counts["null"] += 1
        else:
            counts[str(val)] += 1

    def process_record_obj(obj: Dict[str, Any], ctx: str) -> Dict[str, Any]:
        matched_keys = [k for k in STAR_FIELD_CANDIDATES if k in obj]
        if not matched_keys:
            raise CutoverError(
                f"Object at {ctx} contains none of expected star fields {STAR_FIELD_CANDIDATES}."
            )
        out_obj = dict(obj)
        for k in matched_keys:
            raw_v = out_obj[k]
            # Validate even during pre-count pass
            flipped_v = flip_single_tier_value(raw_v, f"{ctx}.{k}")
            final_v = flipped_v if apply_flip else (None if raw_v is None else int(raw_v))
            out_obj[k] = final_v
            record_tier(final_v)
        return out_obj

    def process_collection(node: Any, ctx: str) -> Any:
        if isinstance(node, list):
            return [
                process_record_obj(elem, f"{ctx}[{idx}]")
                if isinstance(elem, dict)
                else _fail_invalid_elem(elem, f"{ctx}[{idx}]")
                for idx, elem in enumerate(node)
            ]

        if isinstance(node, dict):
            if not node:
                return {}

            # Case 1: Flat mapping {"face_01": 1, "face_02": 3, ...}
            if all(not isinstance(v, (dict, list)) for v in node.values()):
                out_flat: Dict[str, Any] = {}
                for k, raw_v in node.items():
                    flipped_v = flip_single_tier_value(raw_v, f"{ctx}.{k}")
                    final_v = flipped_v if apply_flip else (None if raw_v is None else int(raw_v))
                    out_flat[k] = final_v
                    record_tier(final_v)
                return out_flat

            # Case 2: Wrapper object containing a known collection key (e.g. {"version": 1, "items": [...]})
            wrapper_hits = [
                wk for wk in COLLECTION_WRAPPER_KEYS if wk in node and isinstance(node[wk], (list, dict))
            ]
            if wrapper_hits and not any(sk in node for sk in STAR_FIELD_CANDIDATES):
                out_wrap = dict(node)
                for wk in wrapper_hits:
                    out_wrap[wk] = process_collection(node[wk], f"{ctx}.{wk}")
                return out_wrap

            # Case 3: Mapping of ID -> record object {"face_01": {"tier": 1, ...}, ...}
            if all(isinstance(v, dict) for v in node.values()):
                out_map: Dict[str, Any] = {}
                for k, sub_obj in node.items():
                    out_map[k] = process_record_obj(sub_obj, f"{ctx}.{k}")
                return out_map

        raise CutoverError(f"Unsupported star table JSON structure at {ctx}.")

    def _fail_invalid_elem(elem: Any, ctx: str) -> Any:
        raise CutoverError(f"Unsupported list element {elem!r} at {ctx}; expected object.")

    transformed = process_collection(copy.deepcopy(data), "$")
    return transformed, counts


def _atomic_write_json(target_path: Path, data: Any) -> None:
    """Write JSON via a same-directory temp file + fsync + os.replace (never /tmp)."""
    safe_target = validate_safe_storage_path(target_path, "output path")
    safe_target.parent.mkdir(parents=True, exist_ok=True)
    tmp_name = f".{safe_target.name}.tmp.{os.getpid()}.{uuid.uuid4().hex[:8]}"
    tmp_path = validate_safe_storage_path(safe_target.parent / tmp_name, "temporary output file")

    serialized = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    try:
        with open(tmp_path, "w", encoding="utf-8") as fh:
            fh.write(serialized)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(str(tmp_path), str(safe_target))
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass


def flip_star_table(
    file_path_raw: Union[str, Path],
    in_place: bool = False,
    output_path_raw: Optional[Union[str, Path]] = None,
) -> Dict[str, Any]:
    """Flip 1 <-> 3 in a star table JSON file, verify exact count conservation, and save atomically."""
    if in_place and output_path_raw is not None:
        raise CutoverError("Pass either --in-place or --output, not both.")

    src_path = validate_safe_storage_path(file_path_raw, "star table file")
    if not src_path.is_file():
        raise CutoverError(f"Star table file not found: {src_path}")

    try:
        original_data = json.loads(src_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise CutoverError(f"Invalid JSON in {src_path}: {exc}") from exc

    _, before_counts = _transform_and_count(original_data, apply_flip=False)
    flipped_data, _ = _transform_and_count(original_data, apply_flip=True)
    # Re-scan flipped structure independently to verify post-flip counts 100%
    _, after_counts = _transform_and_count(flipped_data, apply_flip=False)

    symmetry_ok = (
        before_counts["total"] == after_counts["total"]
        and before_counts["1"] == after_counts["3"]
        and before_counts["3"] == after_counts["1"]
        and before_counts["2"] == after_counts["2"]
        and before_counts["0"] == after_counts["0"]
        and before_counts["null"] == after_counts["null"]
    )
    if not symmetry_ok:
        raise CutoverError(
            f"Count verification failed! before={before_counts}, after={after_counts}"
        )

    target_path: Optional[Path] = None
    if in_place:
        target_path = src_path
    elif output_path_raw is not None:
        target_path = validate_safe_storage_path(output_path_raw, "output path")

    if target_path is not None:
        _atomic_write_json(target_path, flipped_data)

    return {
        "ok": True,
        "source_file": str(src_path),
        "written_to": str(target_path) if target_path is not None else None,
        "dry_run": target_path is None,
        "before_counts": before_counts,
        "after_counts": after_counts,
        "data": flipped_data if target_path is None else None,
    }


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="migrate_v4_cutover.py",
        description="Review Outpost v4 star-scale cutover migration helper",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_ledger = sub.add_parser(
        "mark-ledger",
        help="Idempotently append cutover_v4_star_scale marker to ledger JSONL",
    )
    p_ledger.add_argument("--ledger", required=True, help="Path to ledger-<agent_id>.jsonl")

    p_flip = sub.add_parser(
        "flip-star-table",
        help="Flip legacy 1 <-> 3 star values in JSON table with strict count verification",
    )
    p_flip.add_argument("--file", required=True, help="Input star table JSON file")
    p_flip.add_argument("--in-place", dest="in_place", action="store_true", help="Atomically overwrite --file")
    p_flip.add_argument("--output", dest="output_path", help="Atomically write flipped JSON to this path")

    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "mark-ledger":
            res = mark_ledger(args.ledger)
        elif args.command == "flip-star-table":
            res = flip_star_table(
                file_path_raw=args.file,
                in_place=bool(args.in_place),
                output_path_raw=args.output_path,
            )
        else:
            raise CutoverError(f"Unknown command: {args.command!r}")

        print(json.dumps(res, ensure_ascii=False, indent=2))
        return 0
    except PathGuardError as exc:
        err = {"ok": False, "error": "forbidden_storage_path", "message": str(exc)}
        formatted = json.dumps(err, ensure_ascii=False, indent=2)
        print(formatted)
        print(formatted, file=sys.stderr)
        return 2
    except CutoverError as exc:
        err = {"ok": False, "error": "cutover_error", "message": str(exc)}
        formatted = json.dumps(err, ensure_ascii=False, indent=2)
        print(formatted)
        print(formatted, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
