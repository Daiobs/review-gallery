#!/usr/bin/env python3
"""Review Outpost v4 Agent CLI (hub_client.py).

Core protocol capabilities (v4 de-cloud-drive architecture):
- Strict storage path guard (forbids /tmp, /private/tmp, /var/tmp, and system dirs).
- Native Cloudflare Access Service Auth header injection (`CF-Access-Client-Id` &
  `CF-Access-Client-Secret`) alongside Bearer Token + `X-Agent-Id`.
- Multi-pipeline `source x line x batch_type` metadata and multiprocess-safe atomic
  `batch_id` reservation via `fcntl.flock` on `<ledger_path>.lock` (`batch_reserved`
  written + fsynced BEFORE WebP encoding and HTTP upload).
- Blind-review filename anonymization (`--anonymize-names`: cloud receives `001.webp`...,
  while local ledger preserves real `filename` + `original_path` alongside `display_filename`).
- Lineage (`parent_item_id` via `--parent-item-id` / `--parent-map`, plus `--repush-item` /
  `--repush-map` for `round+1`) and local-only `generation_context` sidecar capture
  (`.json` / `.txt` / `--context-map`, never uploaded to cloud).
- Pure read-only `pull` (`GET /api/agent/verdicts`, never moves or deletes local files),
  4-star scale (`3 | 2 | 1 | 0 | null`, never swallowing `tier = 0`), orthogonal disposition
  (`destination in {"archive", "repair", "discard"}` + independent `redraw: bool`), and
  `cutover_v4_star_scale` historical ledger compatibility (`1 <-> 3` before marker).
- Multi-pipeline batch listing (`batches` -> `GET /api/agent/batches`).
- Strict `mark-archived` (`--archive-ref` / `--drive-path`, rejecting non-`archive` items)
  and pre-`ack` local ledger safety gate + item-by-item `POST /api/agent/ack` returning `receipt`.

Compatible with Python 3.9+ using only stdlib + Pillow.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple, Union

from PIL import Image, ImageOps

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

IMAGE_EXTENSIONS: Set[str] = {
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".bmp",
    ".tif",
    ".tiff",
}

CUTOVER_EVENT_NAME = "cutover_v4_star_scale"
TIER_SCALE_V4 = "v4_star"

VALID_TIERS: Tuple[int, ...] = (0, 1, 2, 3)
FLAG_ORDER: Tuple[str, ...] = ("H", "F", "O", "R")
REPAIR_FLAGS: Set[str] = {"H", "F", "O"}

BATCH_TYPE_ALIASES: Dict[str, str] = {
    "artwork": "artwork",
    "成图": "artwork",
    "face": "face",
    "脸模": "face",
    "outfit": "outfit",
    "服装": "outfit",
}

SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class HubClientError(RuntimeError):
    """Base error for hub_client operations."""


class PathGuardError(HubClientError):
    """Raised when a path violates the strict no-/tmp and no-system-dir rule."""


class AckGateError(HubClientError):
    """Raised when local pre-ack safety checks block sending ack to cloud."""

    def __init__(self, message: str, pending_items: Optional[List[Dict[str, Any]]] = None) -> None:
        super().__init__(message)
        self.pending_items: List[Dict[str, Any]] = pending_items or []


class HttpApiError(HubClientError):
    """Raised when the Worker HTTP API returns a non-2xx response or fails."""

    def __init__(
        self,
        status_code: int,
        message: str,
        payload: Optional[Any] = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload


def now_utc_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def today_yyyymmdd() -> str:
    return dt.datetime.now().strftime("%Y%m%d")


def _matches_forbidden_prefix(normalized_path: str) -> Optional[str]:
    for prefix in FORBIDDEN_PATH_PREFIXES:
        if normalized_path == prefix or normalized_path.startswith(prefix + "/"):
            return prefix
    return None


def validate_safe_storage_path(path_value: Union[str, Path], label: str = "path") -> Path:
    """Reject /tmp, /private/tmp, /var/tmp, and system dirs on both abspath and realpath."""
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
                f"storage under '{hit}' is strictly forbidden; use a persistent workspace directory."
            )

    return Path(abs_path)


def validate_slug(value: str, label: str = "identifier") -> str:
    cleaned = (value or "").strip()
    if not cleaned or ".." in cleaned or "/" in cleaned or "\\" in cleaned or not SLUG_RE.match(cleaned):
        raise HubClientError(f"Invalid {label}: {value!r}")
    return cleaned


def normalize_tier(raw: Any) -> Optional[int]:
    """Normalize tier preserving 0 as a valid star rating; never treat bool as int."""
    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, int) and raw in VALID_TIERS:
        return raw
    return None


def flip_legacy_tier(tier: Optional[int]) -> Optional[int]:
    """Map pre-cutover tier values: 1 -> 3, 2 -> 2, 3 -> 1 (0 and None unchanged)."""
    if tier is None:
        return None
    if tier == 1:
        return 3
    if tier == 3:
        return 1
    return tier


def normalize_flags(flags: Optional[Sequence[Any]]) -> List[str]:
    if not flags:
        return []
    present = {str(f).strip().upper() for f in flags if str(f).strip()}
    return [flag for flag in FLAG_ORDER if flag in present]


def resolve_disposition(
    tier: Any,
    flags: Optional[Sequence[Any]],
) -> Dict[str, Any]:
    """Orthogonal v4 single-item conclusion formula (§2.2).

    - destination in {"archive", "repair", "discard"}:
        1) any of {"H", "F", "O"} in flags -> "repair" (tier preserved as intent_tier, final_tier=None)
        2) else tier is not None (0|1|2|3)  -> "archive" (final_tier=tier, intent_tier=None)
        3) else                             -> "discard" (final_tier=None, intent_tier=None)
    - redraw = ("R" in flags), completely orthogonal to destination.
    """
    norm_tier = normalize_tier(tier)
    norm_flags = normalize_flags(flags)
    repair_flags = [f for f in norm_flags if f in REPAIR_FLAGS]
    redraw = "R" in norm_flags

    if len(repair_flags) > 0:
        return {
            "destination": "repair",
            "redraw": redraw,
            "final_tier": None,
            "intent_tier": norm_tier,
            "repair_flags": repair_flags,
        }
    if norm_tier is not None:
        return {
            "destination": "archive",
            "redraw": redraw,
            "final_tier": norm_tier,
            "intent_tier": None,
            "repair_flags": [],
        }
    return {
        "destination": "discard",
        "redraw": redraw,
        "final_tier": None,
        "intent_tier": None,
        "repair_flags": [],
    }


def resolve_default_source(agent_id: str, explicit_source: Optional[str] = None) -> str:
    if explicit_source is not None and str(explicit_source).strip():
        return validate_slug(str(explicit_source).strip(), "source")
    if agent_id == "muse-main":
        return "museai"
    if agent_id == "argon-mac":
        return "gallery"
    return validate_slug(agent_id, "source")


def normalize_line(raw_line: Optional[str]) -> Optional[str]:
    if raw_line is None:
        return None
    cleaned = str(raw_line).strip()
    if not cleaned:
        return None
    return validate_slug(cleaned, "line")


def normalize_batch_type(raw_batch_type: Optional[str]) -> str:
    if raw_batch_type is None or not str(raw_batch_type).strip():
        return "artwork"
    cleaned = str(raw_batch_type).strip()
    lower_key = cleaned.lower()
    if lower_key in BATCH_TYPE_ALIASES:
        return BATCH_TYPE_ALIASES[lower_key]
    if cleaned in BATCH_TYPE_ALIASES:
        return BATCH_TYPE_ALIASES[cleaned]
    raise HubClientError(
        f"Invalid batch_type {raw_batch_type!r}; expected artwork/face/outfit (or 成图/脸模/服装)."
    )


def build_channel_id(source: str, line: Optional[str]) -> str:
    return f"{source}-{line}" if line else source


def parse_env_bool(raw: Optional[str], default: bool = False) -> bool:
    if raw is None:
        return default
    cleaned = raw.strip().lower()
    if not cleaned:
        return default
    return cleaned in ("1", "true", "yes", "on")


def encode_webp_preview(image_path: Path, quality: int = 90) -> Tuple[bytes, int, int, str]:
    """Convert original image to original-resolution WebP (q90) and return (bytes, w, h, sha256)."""
    safe_path = validate_safe_storage_path(image_path, "original image")
    if not safe_path.is_file():
        raise HubClientError(f"Original image not found: {safe_path}")

    with Image.open(safe_path) as img:
        transposed = ImageOps.exif_transpose(img)
        width, height = transposed.size
        if transposed.mode not in ("RGB", "RGBA"):
            has_alpha = ("A" in transposed.getbands()) or ("transparency" in transposed.info)
            converted = transposed.convert("RGBA" if has_alpha else "RGB")
        else:
            converted = transposed

        buf = io.BytesIO()
        converted.save(buf, format="WEBP", quality=quality, method=4)
        webp_bytes = buf.getvalue()

    sha256_hex = hashlib.sha256(webp_bytes).hexdigest()
    return webp_bytes, width, height, sha256_hex


def discover_sidecar_context(image_path: Path) -> Tuple[Optional[str], Optional[str], Any]:
    """Auto-discover same-directory sidecar `.json` or `.txt`/`.prompt.txt` for local ledger.

    Returns `(prompt_path_or_none, prompt_text_or_none, generation_context)`.
    Never uploaded to cloud.
    """
    json_candidates = [
        image_path.with_suffix(".json"),
        image_path.parent / f"{image_path.stem}.context.json",
    ]
    txt_candidates = [
        image_path.with_suffix(".txt"),
        image_path.parent / f"{image_path.stem}.prompt.txt",
    ]

    prompt_field: Optional[str] = None
    prompt_text: Optional[str] = None
    for txt_cand in txt_candidates:
        if txt_cand.is_file():
            safe_txt = validate_safe_storage_path(txt_cand, "prompt sidecar")
            prompt_text = safe_txt.read_text(encoding="utf-8", errors="replace")
            prompt_field = str(safe_txt)
            break

    json_context: Any = None
    for js_cand in json_candidates:
        if js_cand.is_file():
            safe_js = validate_safe_storage_path(js_cand, "json context sidecar")
            raw_js = safe_js.read_text(encoding="utf-8", errors="replace")
            try:
                json_context = json.loads(raw_js)
            except json.JSONDecodeError as exc:
                raise HubClientError(f"Invalid JSON in sidecar {safe_js}: {exc}") from exc
            break

    if json_context is not None:
        if isinstance(json_context, dict) and prompt_text is not None and "prompt" not in json_context:
            enriched = dict(json_context)
            enriched["prompt"] = prompt_text
            return prompt_field, prompt_text, enriched
        return prompt_field, prompt_text, json_context

    if prompt_text is not None:
        return prompt_field, prompt_text, prompt_text

    return None, None, None


@dataclass
class ClientConfig:
    url: str
    agent_id: str
    token: str
    workspace_dir: Path
    source: Optional[str] = None
    line: Optional[str] = None
    batch_type: Optional[str] = None
    anonymize_names: bool = False
    cf_access_client_id: Optional[str] = None
    cf_access_client_secret: Optional[str] = None

    @property
    def ledger_path(self) -> Path:
        return validate_safe_storage_path(
            self.workspace_dir / f"ledger-{self.agent_id}.jsonl",
            "ledger file",
        )


@dataclass
class PreparedPushItem:
    item_id: str
    batch_id: str
    round: int
    original_path: Path
    filename: str
    display_filename: str
    width: int
    height: int
    webp_bytes: bytes
    preview_sha256: str
    parent_item_id: Optional[str] = None
    prompt: Optional[str] = None
    prompt_text: Optional[str] = None
    generation_context: Any = None
    prior_intent_tier: Optional[int] = None


@dataclass
class BatchLedgerView:
    batch_id: str
    items: Dict[Tuple[str, int], Dict[str, Any]] = field(default_factory=dict)
    acked: bool = False
    source: Optional[str] = None
    line: Optional[str] = None
    channel_id: Optional[str] = None
    batch_type: str = "artwork"
    review_done_at: Optional[str] = None


class Ledger:
    """Append-only JSONL local ledger with flock + flush + os.fsync and v4 cutover support."""

    def __init__(self, path: Path, agent_id: str) -> None:
        self.path: Path = validate_safe_storage_path(path, "ledger path")
        self.lock_path: Path = validate_safe_storage_path(f"{self.path}.lock", "ledger lock path")
        self.agent_id: str = validate_slug(agent_id, "agent_id")

    def _append_unlocked(self, record: Dict[str, Any]) -> Dict[str, Any]:
        validate_safe_storage_path(self.path, "ledger path")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        entry = dict(record)
        entry.setdefault("ts", now_utc_iso())
        serialized = json.dumps(entry, ensure_ascii=False) + "\n"
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(serialized)
            fh.flush()
            os.fsync(fh.fileno())
        return entry

    def append(self, record: Dict[str, Any]) -> Dict[str, Any]:
        validate_safe_storage_path(self.lock_path, "ledger lock path")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.lock_path, "a+", encoding="utf-8") as lock_fh:
            fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX)
            try:
                return self._append_unlocked(record)
            finally:
                fcntl.flock(lock_fh.fileno(), fcntl.LOCK_UN)

    def read_all(self) -> List[Dict[str, Any]]:
        if not self.path.is_file():
            return []
        entries: List[Dict[str, Any]] = []
        with open(self.path, "r", encoding="utf-8") as fh:
            for line_no, raw_line in enumerate(fh, start=1):
                stripped = raw_line.strip()
                if not stripped:
                    continue
                try:
                    obj = json.loads(stripped)
                except json.JSONDecodeError as exc:
                    raise HubClientError(
                        f"Corrupted ledger JSON at {self.path}:{line_no}: {exc}"
                    ) from exc
                if isinstance(obj, dict):
                    entries.append(obj)
        return entries

    def reserve_batch_id(
        self,
        source: str,
        line: Optional[str],
        batch_type: str,
        date_str: Optional[str] = None,
    ) -> str:
        """Atomically allocate `<YYYYMMDD>-<source>[-<line>]-<NN>` under flock and fsync reservation."""
        safe_source = validate_slug(source, "source")
        safe_line = normalize_line(line)
        safe_bt = normalize_batch_type(batch_type)
        day = date_str or today_yyyymmdd()
        prefix = f"{day}-{safe_source}-{safe_line}-" if safe_line else f"{day}-{safe_source}-"

        validate_safe_storage_path(self.lock_path, "ledger lock path")
        self.path.parent.mkdir(parents=True, exist_ok=True)

        with open(self.lock_path, "a+", encoding="utf-8") as lock_fh:
            fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX)
            try:
                max_seq = 0
                for rec in self.read_all():
                    bid = str(rec.get("batch_id") or "")
                    if bid.startswith(prefix):
                        tail = bid[len(prefix) :]
                        if tail.isdigit():
                            max_seq = max(max_seq, int(tail))

                reserved_batch_id = f"{prefix}{max_seq + 1:02d}"
                self._append_unlocked(
                    {
                        "event": "batch_reserved",
                        "agent_id": self.agent_id,
                        "batch_id": reserved_batch_id,
                        "source": safe_source,
                        "line": safe_line,
                        "channel_id": build_channel_id(safe_source, safe_line),
                        "batch_type": safe_bt,
                        "tier_scale": TIER_SCALE_V4,
                    }
                )
                return reserved_batch_id
            finally:
                fcntl.flock(lock_fh.fileno(), fcntl.LOCK_UN)

    def next_item_seq(self, batch_id: str) -> int:
        prefix = f"{batch_id}-"
        max_seq = 0
        for rec in self.read_all():
            iid = str(rec.get("item_id") or "")
            if iid.startswith(prefix):
                tail = iid[len(prefix) :]
                if tail.isdigit():
                    max_seq = max(max_seq, int(tail))
        return max_seq + 1

    def count_pushed_items_in_batch(self, batch_id: str) -> int:
        return len(self.get_batch_view(batch_id).items)

    def latest_unacked_batch_id(self) -> Optional[str]:
        records = self.read_all()
        acked_batches: Set[str] = set()
        ordered_batches: List[str] = []
        for rec in records:
            bid = rec.get("batch_id")
            if not bid:
                continue
            if rec.get("state") == "batch_acked" or rec.get("event") == "batch_acked":
                acked_batches.add(str(bid))
            elif rec.get("item_id"):
                if str(bid) not in ordered_batches:
                    ordered_batches.append(str(bid))
        for bid in reversed(ordered_batches):
            if bid not in acked_batches:
                return bid
        return None

    @staticmethod
    def _interpret_tier(raw_tier: Any, is_v4: bool) -> Optional[int]:
        norm = normalize_tier(raw_tier)
        return norm if is_v4 else flip_legacy_tier(norm)

    def _apply_item_record(
        self,
        items: Dict[Tuple[str, int], Dict[str, Any]],
        rec: Dict[str, Any],
        batch_id: str,
        is_v4: bool,
    ) -> None:
        item_id = rec.get("item_id")
        if not item_id:
            return
        round_num = int(rec.get("round") or 1)
        key = (str(item_id), round_num)
        state = rec.get("state")

        if state == "pushed":
            items[key] = {
                "item_id": str(item_id),
                "batch_id": batch_id,
                "round": round_num,
                "original_path": rec.get("original_path"),
                "filename": rec.get("filename"),
                "display_filename": rec.get("display_filename") or rec.get("filename"),
                "width": rec.get("width"),
                "height": rec.get("height"),
                "parent_item_id": rec.get("parent_item_id"),
                "prompt": rec.get("prompt"),
                "prompt_text": rec.get("prompt_text"),
                "generation_context": rec.get("generation_context"),
                "preview_sha256": rec.get("preview_sha256"),
                "state": "pushed",
                "destination": None,
                "redraw": False,
                "final_tier": None,
                "intent_tier": self._interpret_tier(rec.get("prior_intent_tier"), is_v4)
                if "prior_intent_tier" in rec
                else None,
                "repair_flags": [],
                "verdict": None,
                "archive_ref": None,
                "review_done_pulled": False,
            }
            return

        if state == "push_rejected":
            items.pop(key, None)
            return

        if key not in items:
            items[key] = {
                "item_id": str(item_id),
                "batch_id": batch_id,
                "round": round_num,
                "original_path": rec.get("original_path"),
                "filename": rec.get("filename"),
                "display_filename": rec.get("display_filename") or rec.get("filename"),
                "width": rec.get("width"),
                "height": rec.get("height"),
                "parent_item_id": rec.get("parent_item_id"),
                "prompt": rec.get("prompt"),
                "prompt_text": rec.get("prompt_text"),
                "generation_context": rec.get("generation_context"),
                "preview_sha256": rec.get("preview_sha256"),
                "state": state or "pushed",
                "destination": None,
                "redraw": False,
                "final_tier": None,
                "intent_tier": None,
                "repair_flags": [],
                "verdict": None,
                "archive_ref": None,
                "review_done_pulled": False,
            }

        cur = items[key]
        if state:
            cur["state"] = state

        for meta_field in (
            "original_path",
            "filename",
            "display_filename",
            "width",
            "height",
            "parent_item_id",
            "prompt",
            "prompt_text",
            "generation_context",
            "preview_sha256",
        ):
            if rec.get(meta_field) is not None:
                cur[meta_field] = rec.get(meta_field)

        verdict_raw = rec.get("verdict")
        if isinstance(verdict_raw, dict):
            v_tier = self._interpret_tier(verdict_raw.get("tier"), is_v4)
            v_flags = normalize_flags(verdict_raw.get("flags"))
            disp = resolve_disposition(v_tier, v_flags)

            norm_verdict = dict(verdict_raw)
            norm_verdict["tier"] = v_tier
            norm_verdict["flags"] = v_flags
            norm_verdict["destination"] = disp["destination"]
            norm_verdict["redraw"] = disp["redraw"]

            prev_dest = cur.get("destination")
            cur["verdict"] = norm_verdict
            cur["destination"] = disp["destination"]
            cur["redraw"] = disp["redraw"]
            cur["repair_flags"] = disp["repair_flags"]
            cur["final_tier"] = disp["final_tier"]

            if disp["destination"] == "repair":
                if disp["intent_tier"] is not None:
                    cur["intent_tier"] = disp["intent_tier"]
                elif prev_dest != "repair":
                    cur["intent_tier"] = None
            else:
                cur["intent_tier"] = None
                if disp["destination"] != "archive":
                    cur["archive_ref"] = None
        else:
            # Record without full verdict dict (e.g., mark-archived or minimal legacy entry)
            if rec.get("destination") in ("archive", "repair", "discard"):
                cur["destination"] = rec["destination"]
            elif not is_v4 and cur.get("destination") is None:
                if state == "archived":
                    cur["destination"] = "archive"
                elif state == "repair":
                    cur["destination"] = "repair"
                elif state in ("trashed", "discard", "redraw"):
                    cur["destination"] = "discard"

            if "redraw" in rec and rec["redraw"] is not None:
                cur["redraw"] = bool(rec["redraw"])
            elif not is_v4 and state == "redraw":
                cur["redraw"] = True

            if "repair_flags" in rec and isinstance(rec.get("repair_flags"), list):
                cur["repair_flags"] = normalize_flags(rec["repair_flags"])

            if "final_tier" in rec and rec["final_tier"] is not None:
                cur["final_tier"] = self._interpret_tier(rec["final_tier"], is_v4)
            elif cur.get("destination") != "archive":
                cur["final_tier"] = None

            if cur.get("destination") == "repair":
                if "intent_tier" in rec and rec["intent_tier"] is not None:
                    cur["intent_tier"] = self._interpret_tier(rec["intent_tier"], is_v4)
                elif "target_tier" in rec and rec["target_tier"] is not None:
                    cur["intent_tier"] = self._interpret_tier(rec["target_tier"], is_v4)
            else:
                cur["intent_tier"] = None

        # Archive reference resolution (supports v4 `archive_ref` + legacy `drive_path`)
        if cur.get("destination") == "archive":
            if "archive_ref" in rec and rec["archive_ref"] is not None and str(rec["archive_ref"]).strip():
                cur["archive_ref"] = str(rec["archive_ref"]).strip()
            elif "drive_path" in rec and rec["drive_path"] is not None and str(rec["drive_path"]).strip():
                cur["archive_ref"] = str(rec["drive_path"]).strip()
        else:
            cur["archive_ref"] = None

        if rec.get("review_done") is True or state in (
            "pulled",
            "archive",
            "archived",
            "repair",
            "redraw",
            "discard",
            "trashed",
        ):
            if cur.get("destination") in ("archive", "repair", "discard"):
                cur["review_done_pulled"] = True

    def get_batch_view(self, batch_id: str) -> BatchLedgerView:
        view = BatchLedgerView(batch_id=batch_id)
        after_cutover = False

        for rec in self.read_all():
            if rec.get("event") == CUTOVER_EVENT_NAME:
                after_cutover = True
                continue

            if rec.get("batch_id") != batch_id:
                continue

            is_v4 = after_cutover or (rec.get("tier_scale") == TIER_SCALE_V4)

            if rec.get("source"):
                view.source = str(rec["source"])
            if "line" in rec and rec.get("line") is not None:
                view.line = str(rec["line"]) if str(rec["line"]).strip() else None
            if rec.get("channel_id"):
                view.channel_id = str(rec["channel_id"])
            if rec.get("batch_type"):
                try:
                    view.batch_type = normalize_batch_type(str(rec["batch_type"]))
                except HubClientError:
                    pass
            if rec.get("review_done_at"):
                view.review_done_at = str(rec["review_done_at"])

            if rec.get("state") == "batch_acked" or rec.get("event") == "batch_acked":
                view.acked = True
                continue

            if rec.get("event") == "batch_reserved":
                continue

            self._apply_item_record(view.items, rec, batch_id, is_v4)

        if view.source and not view.channel_id:
            view.channel_id = build_channel_id(view.source, view.line)
        return view

    def get_item_lineage(self, item_id: str) -> Optional[Dict[str, Any]]:
        """Reconstruct latest cross-batch state for `item_id` (cutover-aware)."""
        per_round: Dict[Tuple[str, int], Dict[str, Any]] = {}
        after_cutover = False

        for rec in self.read_all():
            if rec.get("event") == CUTOVER_EVENT_NAME:
                after_cutover = True
                continue
            if rec.get("item_id") != item_id:
                continue
            is_v4 = after_cutover or (rec.get("tier_scale") == TIER_SCALE_V4)
            bid = str(rec.get("batch_id") or "")
            self._apply_item_record(per_round, rec, bid, is_v4)

        if not per_round:
            return None

        highest_key = max(per_round.keys(), key=lambda k: k[1])
        merged = dict(per_round[highest_key])
        merged["max_round"] = highest_key[1]
        return merged


def build_multipart_form_data(
    manifest: Dict[str, Any],
    items: Sequence[PreparedPushItem],
) -> Tuple[bytes, str]:
    """Encode multipart/form-data with 'manifest' JSON field and '<item_id>' WebP file parts."""
    boundary = f"----OutpostBoundary{uuid.uuid4().hex}"
    crlf = b"\r\n"
    chunks: List[bytes] = []

    manifest_json = json.dumps(manifest, ensure_ascii=False).encode("utf-8")
    chunks.append(f"--{boundary}".encode("ascii"))
    chunks.append(b'Content-Disposition: form-data; name="manifest"')
    chunks.append(b"")
    chunks.append(manifest_json)

    for item in items:
        part_filename = f"{item.item_id}_r{item.round}.webp"
        chunks.append(f"--{boundary}".encode("ascii"))
        chunks.append(
            f'Content-Disposition: form-data; name="{item.item_id}"; filename="{part_filename}"'.encode(
                "utf-8"
            )
        )
        chunks.append(b"Content-Type: image/webp")
        chunks.append(b"")
        chunks.append(item.webp_bytes)

    chunks.append(f"--{boundary}--".encode("ascii"))
    chunks.append(b"")
    body = crlf.join(chunks)
    content_type = f"multipart/form-data; boundary={boundary}"
    return body, content_type


class HubHttpClient:
    """Zero-dependency urllib HTTP client for /api/agent/* with optional CF-Access Service Auth."""

    def __init__(
        self,
        base_url: str,
        agent_id: str,
        token: str,
        cf_access_client_id: Optional[str] = None,
        cf_access_client_secret: Optional[str] = None,
        timeout: float = 60.0,
    ) -> None:
        cleaned_url = (base_url or "").strip().rstrip("/")
        if not cleaned_url:
            raise HubClientError("OUTPOST_URL (--url) is required.")
        if not (token or "").strip():
            raise HubClientError("OUTPOST_TOKEN (--token) is required.")
        self.base_url = cleaned_url
        self.agent_id = validate_slug(agent_id, "agent_id")
        self.token = token.strip()
        self.cf_access_client_id = (
            cf_access_client_id.strip() if cf_access_client_id and cf_access_client_id.strip() else None
        )
        self.cf_access_client_secret = (
            cf_access_client_secret.strip()
            if cf_access_client_secret and cf_access_client_secret.strip()
            else None
        )
        self.timeout = timeout

        parsed = urllib.parse.urlparse(self.base_url)
        host = (parsed.hostname or "").lower()
        if host in ("127.0.0.1", "localhost", "::1"):
            self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        else:
            self._opener = urllib.request.build_opener()

    @classmethod
    def from_config(cls, config: ClientConfig, timeout: float = 60.0) -> "HubHttpClient":
        return cls(
            base_url=config.url,
            agent_id=config.agent_id,
            token=config.token,
            cf_access_client_id=config.cf_access_client_id,
            cf_access_client_secret=config.cf_access_client_secret,
            timeout=timeout,
        )

    def _auth_headers(self) -> Dict[str, str]:
        headers: Dict[str, str] = {
            "Authorization": f"Bearer {self.token}",
            "X-Agent-Id": self.agent_id,
            "Accept": "application/json",
            "User-Agent": "review-outpost-hub-client/4.1",
        }
        if self.cf_access_client_id and self.cf_access_client_secret:
            headers["CF-Access-Client-Id"] = self.cf_access_client_id
            headers["CF-Access-Client-Secret"] = self.cf_access_client_secret
        return headers

    def _request_json(
        self,
        method: str,
        path: str,
        body: Optional[bytes] = None,
        content_type: Optional[str] = None,
    ) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        headers = self._auth_headers()
        if content_type:
            headers["Content-Type"] = content_type

        req = urllib.request.Request(url=url, data=body, headers=headers, method=method)
        try:
            with self._opener.open(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                return json.loads(raw) if raw.strip() else {}
        except urllib.error.HTTPError as exc:
            err_raw = ""
            try:
                err_raw = exc.read().decode("utf-8", errors="replace")
            except Exception:
                err_raw = ""
            parsed_err: Any = None
            if err_raw.strip():
                try:
                    parsed_err = json.loads(err_raw)
                except json.JSONDecodeError:
                    parsed_err = err_raw
            raise HttpApiError(
                status_code=exc.code,
                message=f"HTTP {exc.code} on {method} {path}: {err_raw or exc.reason}",
                payload=parsed_err,
            ) from exc
        except urllib.error.URLError as exc:
            raise HttpApiError(
                status_code=0,
                message=f"Network error on {method} {path}: {exc.reason}",
                payload=None,
            ) from exc

    def push_chunk(
        self,
        batch_id: str,
        source: str,
        line: Optional[str],
        batch_type: str,
        items: Sequence[PreparedPushItem],
    ) -> Dict[str, Any]:
        manifest: Dict[str, Any] = {
            "agent_id": self.agent_id,
            "batch_id": batch_id,
            "source": source,
            "line": line,
            "batch_type": batch_type,
            "items": [
                {
                    "item_id": it.item_id,
                    "round": it.round,
                    "filename": it.display_filename,
                    "width": it.width,
                    "height": it.height,
                    "parent_item_id": it.parent_item_id,
                }
                for it in items
            ],
        }
        body, content_type = build_multipart_form_data(manifest, items)
        return self._request_json("POST", "/api/agent/push", body=body, content_type=content_type)

    def get_verdicts(self, batch_id: str) -> Dict[str, Any]:
        query = urllib.parse.urlencode({"batch_id": batch_id})
        return self._request_json("GET", f"/api/agent/verdicts?{query}")

    def get_batches(
        self,
        source: Optional[str] = None,
        line: Optional[str] = None,
        review_done: Optional[str] = None,
    ) -> Dict[str, Any]:
        params: Dict[str, str] = {}
        if source is not None and str(source).strip():
            params["source"] = str(source).strip()
        if line is not None and str(line).strip():
            params["line"] = str(line).strip()
        if review_done is not None and str(review_done).strip():
            params["review_done"] = str(review_done).strip()
        query = urllib.parse.urlencode(params)
        suffix = f"?{query}" if query else ""
        return self._request_json("GET", f"/api/agent/batches{suffix}")

    def post_ack(self, batch_id: str, items: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
        payload = json.dumps({"batch_id": batch_id, "items": list(items)}, ensure_ascii=False).encode(
            "utf-8"
        )
        return self._request_json(
            "POST",
            "/api/agent/ack",
            body=payload,
            content_type="application/json; charset=utf-8",
        )


def _load_json_arg(raw_value: str, label: str) -> Any:
    """Load JSON either from an existing validated file path or inline JSON string."""
    candidate_str = raw_value.strip()
    if not candidate_str:
        raise HubClientError(f"Empty {label}.")
    if not candidate_str.startswith(("{", "[")):
        candidate_path = validate_safe_storage_path(candidate_str, label)
        if candidate_path.is_file():
            try:
                return json.loads(candidate_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                raise HubClientError(f"Invalid JSON in {candidate_path}: {exc}") from exc
    try:
        return json.loads(candidate_str)
    except json.JSONDecodeError as exc:
        if candidate_str.startswith("/") or candidate_str.startswith("~"):
            validate_safe_storage_path(candidate_str, label)
        raise HubClientError(f"Invalid JSON or non-existent file for {label}: {exc}") from exc


def expand_input_image_paths(raw_paths: Sequence[Union[str, Path]]) -> List[Path]:
    discovered: List[Path] = []
    for p_raw in raw_paths:
        safe_p = validate_safe_storage_path(p_raw, "input path")
        if not safe_p.exists():
            raise HubClientError(f"Input path does not exist: {safe_p}")
        if safe_p.is_dir():
            children = sorted(
                child
                for child in safe_p.iterdir()
                if child.is_file()
                and not child.name.startswith(".")
                and child.suffix.lower() in IMAGE_EXTENSIONS
            )
            for child in children:
                discovered.append(validate_safe_storage_path(child, "original image"))
        elif safe_p.is_file():
            discovered.append(safe_p)
        else:
            raise HubClientError(f"Unsupported input path type: {safe_p}")
    return discovered


def _lookup_path_keyed_map(mapping: Dict[str, Any], img_path: Path, label: str) -> Tuple[bool, Any]:
    """Match an image against a JSON map keyed by full path, relative/expanded path, or basename."""
    abs_str = str(img_path)
    if abs_str in mapping:
        return True, mapping[abs_str]
    if img_path.name in mapping:
        return True, mapping[img_path.name]
    for raw_k, val in mapping.items():
        if "/" in raw_k or raw_k.startswith("~") or raw_k.startswith("."):
            norm_k = str(validate_safe_storage_path(raw_k, label))
            if norm_k == abs_str:
                return True, val
    return False, None


def _resolve_context_value(raw_ctx: Any) -> Any:
    """If context-map points to an existing .json/.txt file path, read it; else store as-is."""
    if isinstance(raw_ctx, str) and (raw_ctx.startswith("/") or raw_ctx.startswith("~")):
        safe_p = validate_safe_storage_path(raw_ctx, "context_map file")
        if safe_p.is_file():
            content = safe_p.read_text(encoding="utf-8", errors="replace")
            if safe_p.suffix.lower() == ".json":
                try:
                    return json.loads(content)
                except json.JSONDecodeError as exc:
                    raise HubClientError(f"Invalid JSON in context file {safe_p}: {exc}") from exc
            return content
    return raw_ctx


def cmd_push(
    config: ClientConfig,
    paths: Sequence[Union[str, Path]],
    batch_id: Optional[str] = None,
    source: Optional[str] = None,
    line: Optional[str] = None,
    batch_type: Optional[str] = None,
    anonymize_names: Optional[bool] = None,
    chunk_size: int = 10,
    max_retries: int = 2,
    inline_prompt: Optional[str] = None,
    explicit_item_id: Optional[str] = None,
    explicit_round: Optional[int] = None,
    parent_item_id: Optional[str] = None,
    parent_map_raw: Optional[str] = None,
    context_map_raw: Optional[str] = None,
    repush_item: Optional[str] = None,
    repush_map_raw: Optional[str] = None,
    http_client: Optional[HubHttpClient] = None,
    date_str: Optional[str] = None,
) -> Dict[str, Any]:
    """Reserve batch_id under flock, encode WebP q90, write ledger FIRST (fsync), and upload chunks."""
    if chunk_size < 1:
        raise HubClientError("--chunk-size must be >= 1.")
    if max_retries < 0:
        raise HubClientError("--max-retries must be >= 0.")

    validate_safe_storage_path(config.workspace_dir, "workspace_dir")
    ledger = Ledger(config.ledger_path, config.agent_id)
    client = http_client or HubHttpClient.from_config(config)

    existing_view: Optional[BatchLedgerView] = None
    if batch_id:
        existing_candidate_id = validate_slug(batch_id, "batch_id")
        cand_view = ledger.get_batch_view(existing_candidate_id)
        if cand_view.source is not None or cand_view.items:
            existing_view = cand_view

    eff_source_arg = source if source is not None else config.source
    if eff_source_arg is None and existing_view is not None and existing_view.source:
        resolved_source = existing_view.source
    else:
        resolved_source = resolve_default_source(config.agent_id, eff_source_arg)

    eff_line_arg = line if line is not None else config.line
    if eff_line_arg is None and existing_view is not None and existing_view.line is not None:
        resolved_line = existing_view.line
    else:
        resolved_line = normalize_line(eff_line_arg)

    eff_bt_arg = batch_type if batch_type is not None else config.batch_type
    if eff_bt_arg is None and existing_view is not None and existing_view.batch_type:
        resolved_batch_type = normalize_batch_type(existing_view.batch_type)
    else:
        resolved_batch_type = normalize_batch_type(eff_bt_arg)

    use_anonymize = config.anonymize_names if anonymize_names is None else bool(anonymize_names)

    parent_map: Dict[str, Optional[str]] = {}
    if parent_map_raw:
        loaded_pmap = _load_json_arg(parent_map_raw, "parent_map")
        if not isinstance(loaded_pmap, dict) or not loaded_pmap:
            raise HubClientError("--parent-map must be a non-empty JSON object {path_or_name: parent_item_id}.")
        for k_raw, v_raw in loaded_pmap.items():
            p_slug = validate_slug(str(v_raw), "parent_map parent_item_id") if v_raw is not None else None
            parent_map[str(k_raw)] = p_slug

    context_map: Dict[str, Any] = {}
    if context_map_raw:
        loaded_cmap = _load_json_arg(context_map_raw, "context_map")
        if not isinstance(loaded_cmap, dict):
            raise HubClientError("--context-map must be a JSON object {path_or_name: context}.")
        context_map = {str(k): v for k, v in loaded_cmap.items()}

    validated_parent_id = (
        validate_slug(parent_item_id, "parent_item_id") if parent_item_id is not None else None
    )

    expanded_files = expand_input_image_paths(paths)
    # If `paths` omitted alongside `--parent-map` keyed by real file paths, discover those files
    if not expanded_files and parent_map and not repush_item and not repush_map_raw:
        inferred_paths: List[Path] = []
        for key_str in parent_map.keys():
            cand = validate_safe_storage_path(key_str, "parent_map image path")
            if cand.is_file():
                inferred_paths.append(cand)
        expanded_files = inferred_paths

    repush_pairs: List[Tuple[str, Path]] = []
    if repush_item:
        orig_id = validate_slug(repush_item, "repush_item")
        if len(expanded_files) != 1:
            raise HubClientError("--repush-item requires exactly 1 image file path.")
        repush_pairs.append((orig_id, expanded_files[0]))
        expanded_files = []

    if repush_map_raw:
        loaded_rmap = _load_json_arg(repush_map_raw, "repush_map")
        if not isinstance(loaded_rmap, dict) or not loaded_rmap:
            raise HubClientError("--repush-map must be a non-empty JSON object {item_id: image_path}.")
        for orig_id_raw, img_raw in loaded_rmap.items():
            orig_id = validate_slug(str(orig_id_raw), "repush_map item_id")
            img_path = validate_safe_storage_path(str(img_raw), "repaired image")
            if not img_path.is_file():
                raise HubClientError(f"Repaired image not found for {orig_id}: {img_path}")
            repush_pairs.append((orig_id, img_path))

    if explicit_item_id and len(expanded_files) != 1:
        raise HubClientError("--item-id can only be used when pushing a single image file.")

    if not repush_pairs and not expanded_files:
        raise HubClientError("No images found to push.")

    # Step 1 (§6.1.3): Reserve batch_id atomically under flock + fsync BEFORE slow WebP encoding!
    if batch_id:
        resolved_batch_id = validate_slug(batch_id, "batch_id")
    else:
        resolved_batch_id = ledger.reserve_batch_id(
            source=resolved_source,
            line=resolved_line,
            batch_type=resolved_batch_type,
            date_str=date_str,
        )

    existing_count = ledger.count_pushed_items_in_batch(resolved_batch_id)
    total_after_push = existing_count + len(repush_pairs) + len(expanded_files)
    anon_pad_width = max(3, len(str(max(1, total_after_push))))
    anon_counter = existing_count

    def next_display_name(real_name: str) -> str:
        nonlocal anon_counter
        anon_counter += 1
        if use_anonymize:
            return f"{anon_counter:0{anon_pad_width}d}.webp"
        return real_name

    prepared_items: List[PreparedPushItem] = []
    next_seq = ledger.next_item_seq(resolved_batch_id)

    # Step 2a: Prepare same-item `round+1` repush entries
    for orig_id, img_path in repush_pairs:
        prior = ledger.get_item_lineage(orig_id)
        if prior is None:
            raise HubClientError(f"Cannot repush unknown item_id {orig_id!r}: not found in local ledger.")
        new_round = explicit_round if explicit_round is not None else (int(prior["max_round"]) + 1)
        webp_bytes, width, height, sha256_hex = encode_webp_preview(img_path)

        sidecar_prompt, sidecar_text, sidecar_ctx = discover_sidecar_context(img_path)
        has_cmap, mapped_ctx = _lookup_path_keyed_map(context_map, img_path, "context_map")
        has_pmap, mapped_parent = _lookup_path_keyed_map(parent_map, img_path, "parent_map")

        if has_cmap:
            gen_ctx = _resolve_context_value(mapped_ctx)
            prompt_val = inline_prompt if inline_prompt is not None else (sidecar_prompt or prior.get("prompt"))
            prompt_text_val = inline_prompt if inline_prompt is not None else (sidecar_text or prior.get("prompt_text"))
        elif inline_prompt is not None:
            prompt_val = inline_prompt
            prompt_text_val = inline_prompt
            gen_ctx = inline_prompt
        elif sidecar_ctx is not None:
            prompt_val = sidecar_prompt
            prompt_text_val = sidecar_text
            gen_ctx = sidecar_ctx
        else:
            prompt_val = prior.get("prompt")
            prompt_text_val = prior.get("prompt_text")
            gen_ctx = prior.get("generation_context")

        resolved_parent = (
            mapped_parent
            if has_pmap
            else (validated_parent_id if validated_parent_id is not None else prior.get("parent_item_id"))
        )

        prepared_items.append(
            PreparedPushItem(
                item_id=orig_id,
                batch_id=resolved_batch_id,
                round=new_round,
                original_path=img_path,
                filename=img_path.name,
                display_filename=next_display_name(img_path.name),
                width=width,
                height=height,
                webp_bytes=webp_bytes,
                preview_sha256=sha256_hex,
                parent_item_id=resolved_parent,
                prompt=prompt_val,
                prompt_text=prompt_text_val,
                generation_context=gen_ctx,
                prior_intent_tier=prior.get("intent_tier"),
            )
        )

    # Step 2b: Prepare standard / lineage-linked round=1 entries
    for img_path in expanded_files:
        if explicit_item_id:
            item_id = validate_slug(explicit_item_id, "item_id")
            round_num = explicit_round if explicit_round is not None else 1
        else:
            item_id = f"{resolved_batch_id}-{next_seq:03d}"
            next_seq += 1
            round_num = explicit_round if explicit_round is not None else 1

        webp_bytes, width, height, sha256_hex = encode_webp_preview(img_path)
        sidecar_prompt, sidecar_text, sidecar_ctx = discover_sidecar_context(img_path)
        has_cmap, mapped_ctx = _lookup_path_keyed_map(context_map, img_path, "context_map")
        has_pmap, mapped_parent = _lookup_path_keyed_map(parent_map, img_path, "parent_map")

        resolved_parent = mapped_parent if has_pmap else validated_parent_id
        prior_parent = ledger.get_item_lineage(resolved_parent) if resolved_parent else None

        if has_cmap:
            gen_ctx = _resolve_context_value(mapped_ctx)
            prompt_val = inline_prompt if inline_prompt is not None else sidecar_prompt
            prompt_text_val = inline_prompt if inline_prompt is not None else sidecar_text
        elif inline_prompt is not None:
            prompt_val = inline_prompt
            prompt_text_val = inline_prompt
            gen_ctx = inline_prompt
        elif sidecar_ctx is not None:
            prompt_val = sidecar_prompt
            prompt_text_val = sidecar_text
            gen_ctx = sidecar_ctx
        elif prior_parent is not None:
            prompt_val = prior_parent.get("prompt")
            prompt_text_val = prior_parent.get("prompt_text")
            gen_ctx = prior_parent.get("generation_context")
        else:
            prompt_val = None
            prompt_text_val = None
            gen_ctx = None

        prepared_items.append(
            PreparedPushItem(
                item_id=item_id,
                batch_id=resolved_batch_id,
                round=round_num,
                original_path=img_path,
                filename=img_path.name,
                display_filename=next_display_name(img_path.name),
                width=width,
                height=height,
                webp_bytes=webp_bytes,
                preview_sha256=sha256_hex,
                parent_item_id=resolved_parent,
                prompt=prompt_val,
                prompt_text=prompt_text_val,
                generation_context=gen_ctx,
            )
        )

    # Step 3: Upload in chunks of `chunk_size`, strictly appending + fsyncing ledger BEFORE each HTTP push!
    accepted_all: List[str] = []
    rejected_final: List[Dict[str, Any]] = []
    chunk_count = 0
    last_cloud_pushed_count: Optional[int] = None
    channel_id = build_channel_id(resolved_source, resolved_line)

    for start_idx in range(0, len(prepared_items), chunk_size):
        chunk = prepared_items[start_idx : start_idx + chunk_size]
        chunk_count += 1

        for item in chunk:
            record: Dict[str, Any] = {
                "item_id": item.item_id,
                "batch_id": item.batch_id,
                "round": item.round,
                "source": resolved_source,
                "line": resolved_line,
                "channel_id": channel_id,
                "batch_type": resolved_batch_type,
                "original_path": str(item.original_path),
                "filename": item.filename,
                "display_filename": item.display_filename,
                "width": item.width,
                "height": item.height,
                "parent_item_id": item.parent_item_id,
                "prompt": item.prompt,
                "prompt_text": item.prompt_text,
                "generation_context": item.generation_context,
                "preview_sha256": item.preview_sha256,
                "state": "pushed",
                "destination": None,
                "redraw": False,
                "final_tier": None,
                "intent_tier": item.prior_intent_tier,
                "repair_flags": [],
                "verdict": None,
                "archive_ref": None,
                "tier_scale": TIER_SCALE_V4,
            }
            if item.prior_intent_tier is not None:
                record["prior_intent_tier"] = item.prior_intent_tier
            ledger.append(record)

        item_by_id: Dict[str, PreparedPushItem] = {it.item_id: it for it in chunk}
        pending_chunk: List[PreparedPushItem] = list(chunk)
        attempt = 0
        latest_rejections: List[Dict[str, Any]] = []

        while pending_chunk:
            resp = client.push_chunk(
                batch_id=resolved_batch_id,
                source=resolved_source,
                line=resolved_line,
                batch_type=resolved_batch_type,
                items=pending_chunk,
            )
            if "pushed_count" in resp and resp["pushed_count"] is not None:
                last_cloud_pushed_count = int(resp["pushed_count"])

            chunk_accepted = [str(x) for x in (resp.get("accepted") or [])]
            for acc_id in chunk_accepted:
                if acc_id not in accepted_all:
                    accepted_all.append(acc_id)

            raw_rejected = list(resp.get("rejected") or [])
            if not raw_rejected:
                latest_rejections = []
                break

            latest_rejections = raw_rejected
            if attempt >= max_retries:
                break

            retry_ids = [str(r.get("item_id")) for r in raw_rejected if r.get("item_id") in item_by_id]
            if not retry_ids:
                break
            pending_chunk = [item_by_id[rid] for rid in retry_ids]
            attempt += 1

        for rej in latest_rejections:
            rej_id = str(rej.get("item_id") or "")
            reason = str(rej.get("reason") or "rejected")
            rejected_final.append({"item_id": rej_id, "reason": reason})
            if rej_id in item_by_id:
                failed_it = item_by_id[rej_id]
                ledger.append(
                    {
                        "item_id": failed_it.item_id,
                        "batch_id": failed_it.batch_id,
                        "round": failed_it.round,
                        "original_path": str(failed_it.original_path),
                        "state": "push_rejected",
                        "reason": reason,
                        "tier_scale": TIER_SCALE_V4,
                    }
                )

    result = {
        "batch_id": resolved_batch_id,
        "agent_id": config.agent_id,
        "source": resolved_source,
        "line": resolved_line,
        "channel_id": channel_id,
        "batch_type": resolved_batch_type,
        "anonymized_names": use_anonymize,
        "pushed_count": last_cloud_pushed_count if last_cloud_pushed_count is not None else len(accepted_all),
        "accepted": accepted_all,
        "rejected": rejected_final,
        "chunks": chunk_count,
    }
    if rejected_final:
        raise HubClientError(
            f"Push completed with {len(rejected_final)} permanently rejected item(s): "
            f"{json.dumps(rejected_final, ensure_ascii=False)}"
        )
    return result


def cmd_batches(
    config: ClientConfig,
    source: Optional[str] = None,
    line: Optional[str] = None,
    review_done: Optional[str] = None,
    http_client: Optional[HubHttpClient] = None,
) -> Dict[str, Any]:
    """List un-acked batches for the authenticated agent (`GET /api/agent/batches`)."""
    validate_safe_storage_path(config.workspace_dir, "workspace_dir")
    client = http_client or HubHttpClient.from_config(config)
    return client.get_batches(source=source, line=line, review_done=review_done)


def cmd_pull(
    config: ClientConfig,
    batch_id: Optional[str] = None,
    watch: bool = False,
    interval: float = 5.0,
    max_polls: Optional[int] = None,
    http_client: Optional[HubHttpClient] = None,
) -> Dict[str, Any]:
    """Purely read-only local pull: fetch verdicts and append v4 dispositions to ledger (never touches originals!)."""
    validate_safe_storage_path(config.workspace_dir, "workspace_dir")
    ledger = Ledger(config.ledger_path, config.agent_id)
    resolved_batch_id = (
        validate_slug(batch_id, "batch_id") if batch_id else ledger.latest_unacked_batch_id()
    )
    if not resolved_batch_id:
        raise HubClientError("No --batch specified and no un-acked batch found in local ledger.")

    client = http_client or HubHttpClient.from_config(config)

    polls = 0
    while True:
        polls += 1
        resp = client.get_verdicts(resolved_batch_id)
        review_done = bool(resp.get("review_done"))
        if review_done:
            break
        if not watch:
            return {
                "batch_id": resolved_batch_id,
                "source": resp.get("source"),
                "line": resp.get("line"),
                "channel_id": resp.get("channel_id"),
                "batch_type": resp.get("batch_type"),
                "review_done": False,
                "review_done_at": resp.get("review_done_at"),
                "counts": resp.get("counts"),
                "items": resp.get("items") or [],
                "message": "Review not done yet (read-only status; ledger not finalized, ack disabled).",
            }
        if max_polls is not None and polls >= max_polls:
            raise HubClientError(
                f"Timed out waiting for review_done=true on batch {resolved_batch_id} after {polls} polls."
            )
        time.sleep(max(0.01, interval))

    batch_view = ledger.get_batch_view(resolved_batch_id)
    srv_items: List[Dict[str, Any]] = list(resp.get("items") or [])

    srv_source = resp.get("source") or batch_view.source
    srv_line = resp.get("line") if "line" in resp else batch_view.line
    srv_channel = resp.get("channel_id") or (
        build_channel_id(str(srv_source), srv_line) if srv_source else batch_view.channel_id
    )
    srv_batch_type = normalize_batch_type(resp.get("batch_type") or batch_view.batch_type)
    srv_review_done_at = resp.get("review_done_at")

    counts_summary: Dict[str, int] = {
        "pushed": len(srv_items),
        "archive": 0,
        "repair": 0,
        "discard": 0,
        "redraw": 0,
    }
    processed_items: List[Dict[str, Any]] = []

    for srv in srv_items:
        item_id = str(srv["item_id"])
        round_num = int(srv.get("round") or 1)
        tier = normalize_tier(srv.get("tier"))
        flags = normalize_flags(srv.get("flags"))
        note = str(srv.get("note") or "")
        judged_at: Optional[str] = srv.get("judged_at")
        srv_parent_id: Optional[str] = srv.get("parent_item_id")

        disp = resolve_disposition(tier, flags)
        destination: str = disp["destination"]
        redraw: bool = disp["redraw"]
        final_tier: Optional[int] = disp["final_tier"]
        intent_tier: Optional[int] = disp["intent_tier"]
        repair_flags: List[str] = disp["repair_flags"]

        counts_summary[destination] += 1
        if redraw:
            counts_summary["redraw"] += 1

        verdict_snapshot: Dict[str, Any] = {
            "tier": tier,
            "flags": flags,
            "note": note,
            "judged_at": judged_at,
            "destination": destination,
            "redraw": redraw,
        }

        local = batch_view.items.get((item_id, round_num))
        if local is None:
            lineage = ledger.get_item_lineage(item_id) or {}
            local = {
                "item_id": item_id,
                "batch_id": resolved_batch_id,
                "round": round_num,
                "original_path": lineage.get("original_path"),
                "filename": lineage.get("filename"),
                "display_filename": lineage.get("display_filename"),
                "width": lineage.get("width"),
                "height": lineage.get("height"),
                "parent_item_id": srv_parent_id or lineage.get("parent_item_id"),
                "prompt": lineage.get("prompt"),
                "prompt_text": lineage.get("prompt_text"),
                "generation_context": lineage.get("generation_context"),
                "preview_sha256": lineage.get("preview_sha256"),
                "state": "pushed",
                "destination": None,
                "redraw": False,
                "final_tier": None,
                "intent_tier": None,
                "repair_flags": [],
                "verdict": None,
                "archive_ref": None,
                "review_done_pulled": False,
            }

        already_identical = (
            local.get("review_done_pulled") is True
            and local.get("destination") == destination
            and bool(local.get("redraw")) == redraw
            and local.get("verdict") == verdict_snapshot
        )

        if already_identical:
            processed_items.append(
                {
                    "item_id": item_id,
                    "round": round_num,
                    "parent_item_id": local.get("parent_item_id") or srv_parent_id,
                    "tier": tier,
                    "flags": flags,
                    "destination": destination,
                    "redraw": redraw,
                    "final_tier": local.get("final_tier"),
                    "intent_tier": local.get("intent_tier"),
                    "repair_flags": list(local.get("repair_flags") or []),
                    "note": note,
                    "archive_ref": local.get("archive_ref"),
                }
            )
            continue

        preserved_archive_ref = (
            local.get("archive_ref")
            if (destination == "archive" and local.get("destination") == "archive")
            else None
        )
        preserved_intent_tier = (
            intent_tier
            if intent_tier is not None
            else (local.get("intent_tier") if destination == "repair" else None)
        )

        pulled_rec: Dict[str, Any] = {
            "item_id": item_id,
            "batch_id": resolved_batch_id,
            "round": round_num,
            "source": srv_source,
            "line": srv_line,
            "channel_id": srv_channel,
            "batch_type": srv_batch_type,
            "review_done_at": srv_review_done_at,
            "original_path": local.get("original_path"),
            "filename": local.get("filename"),
            "display_filename": local.get("display_filename"),
            "width": local.get("width"),
            "height": local.get("height"),
            "parent_item_id": srv_parent_id if srv_parent_id is not None else local.get("parent_item_id"),
            "prompt": local.get("prompt"),
            "prompt_text": local.get("prompt_text"),
            "generation_context": local.get("generation_context"),
            "preview_sha256": local.get("preview_sha256"),
            "state": destination,
            "destination": destination,
            "redraw": redraw,
            "final_tier": final_tier,
            "intent_tier": preserved_intent_tier if destination == "repair" else None,
            "repair_flags": repair_flags,
            "verdict": verdict_snapshot,
            "archive_ref": preserved_archive_ref,
            "review_done": True,
            "tier_scale": TIER_SCALE_V4,
        }
        ledger.append(pulled_rec)

        processed_items.append(
            {
                "item_id": item_id,
                "round": round_num,
                "parent_item_id": pulled_rec["parent_item_id"],
                "tier": tier,
                "flags": flags,
                "destination": destination,
                "redraw": redraw,
                "final_tier": pulled_rec["final_tier"],
                "intent_tier": pulled_rec["intent_tier"],
                "repair_flags": repair_flags,
                "note": note,
                "archive_ref": preserved_archive_ref,
            }
        )

    return {
        "batch_id": resolved_batch_id,
        "source": srv_source,
        "line": srv_line,
        "channel_id": srv_channel,
        "batch_type": srv_batch_type,
        "review_done": True,
        "review_done_at": srv_review_done_at,
        "counts": counts_summary,
        "items": processed_items,
    }


def cmd_mark_archived(
    config: ClientConfig,
    batch_id: Optional[str] = None,
    item_id: Optional[str] = None,
    archive_ref: Optional[str] = None,
    drive_path: Optional[str] = None,
    round_num: Optional[int] = None,
    from_json_raw: Optional[str] = None,
) -> Dict[str, Any]:
    """Backfill `archive_ref` in local ledger ONLY for items whose pulled destination == 'archive'."""
    validate_safe_storage_path(config.workspace_dir, "workspace_dir")
    ledger = Ledger(config.ledger_path, config.agent_id)

    effective_single_ref = archive_ref if archive_ref is not None else drive_path
    updates: List[Dict[str, Any]] = []
    inferred_batch_id = batch_id

    if from_json_raw:
        loaded = _load_json_arg(from_json_raw, "from_json")
        if isinstance(loaded, dict):
            if "items" in loaded and isinstance(loaded.get("items"), list):
                if not inferred_batch_id and loaded.get("batch_id"):
                    inferred_batch_id = str(loaded["batch_id"])
                raw_list = loaded["items"]
            else:
                raw_list = [
                    {"item_id": str(k), "archive_ref": str(v)}
                    for k, v in loaded.items()
                    if str(k).strip()
                ]
        elif isinstance(loaded, list):
            raw_list = loaded
        else:
            raise HubClientError("--from-json must be a JSON list or object.")

        for entry in raw_list:
            if not isinstance(entry, dict) or not entry.get("item_id"):
                raise HubClientError(f"Invalid mark-archived JSON item: {entry!r}")
            ref_val = entry.get("archive_ref")
            if ref_val is None or not str(ref_val).strip():
                ref_val = entry.get("drive_path")
            if ref_val is None or not str(ref_val).strip():
                raise HubClientError(
                    f"Missing non-empty archive_ref (or drive_path) for item {entry.get('item_id')!r}"
                )
            updates.append(
                {
                    "batch_id": entry.get("batch_id") or inferred_batch_id,
                    "item_id": str(entry["item_id"]),
                    "round": int(entry["round"]) if entry.get("round") is not None else None,
                    "archive_ref": str(ref_val).strip(),
                }
            )

    if item_id is not None or effective_single_ref is not None:
        if not item_id or effective_single_ref is None or not str(effective_single_ref).strip():
            raise HubClientError(
                "Both --item-id and a non-empty --archive-ref (or --drive-path) are required."
            )
        updates.append(
            {
                "batch_id": inferred_batch_id,
                "item_id": item_id,
                "round": round_num,
                "archive_ref": str(effective_single_ref).strip(),
            }
        )

    if not updates:
        raise HubClientError(
            "Provide either (--item-id and --archive-ref/--drive-path) or --from-json."
        )

    # Validate ALL target items first before writing any ledger lines (atomic fail-fast!)
    staged_appends: List[Dict[str, Any]] = []
    updated_summary: List[Dict[str, Any]] = []

    for upd in updates:
        bid = upd.get("batch_id") or ledger.latest_unacked_batch_id()
        if not bid:
            raise HubClientError(f"Cannot determine batch_id for item {upd['item_id']!r}; pass --batch.")
        resolved_bid = validate_slug(str(bid), "batch_id")
        batch_view = ledger.get_batch_view(resolved_bid)

        matching_keys = [
            k
            for k in batch_view.items.keys()
            if k[0] == upd["item_id"] and (upd["round"] is None or k[1] == int(upd["round"]))
        ]
        if not matching_keys:
            raise HubClientError(
                f"Item {upd['item_id']!r} not found in batch {resolved_bid!r} in local ledger."
            )
        target_key = sorted(matching_keys)[-1]
        cur = batch_view.items[target_key]

        if not cur.get("review_done_pulled") or cur.get("destination") != "archive":
            raise HubClientError(
                f"Cannot mark item {cur['item_id']!r} (round {cur['round']}) as archived: "
                f"current destination is {cur.get('destination')!r} (must be 'archive' after review_done=true pull)."
            )

        rec: Dict[str, Any] = {
            "item_id": cur["item_id"],
            "batch_id": resolved_bid,
            "round": cur["round"],
            "original_path": cur.get("original_path"),
            "filename": cur.get("filename"),
            "display_filename": cur.get("display_filename"),
            "parent_item_id": cur.get("parent_item_id"),
            "prompt": cur.get("prompt"),
            "prompt_text": cur.get("prompt_text"),
            "generation_context": cur.get("generation_context"),
            "preview_sha256": cur.get("preview_sha256"),
            "state": "archived",
            "destination": "archive",
            "redraw": bool(cur.get("redraw")),
            "final_tier": cur.get("final_tier"),
            "intent_tier": None,
            "repair_flags": list(cur.get("repair_flags") or []),
            "verdict": cur.get("verdict"),
            "archive_ref": upd["archive_ref"],
            "review_done": True,
            "tier_scale": TIER_SCALE_V4,
        }
        staged_appends.append(rec)
        updated_summary.append(
            {
                "batch_id": resolved_bid,
                "item_id": cur["item_id"],
                "round": cur["round"],
                "final_tier": cur.get("final_tier"),
                "archive_ref": upd["archive_ref"],
            }
        )

    for rec in staged_appends:
        ledger.append(rec)

    return {"ok": True, "updated": updated_summary}


def cmd_ack(
    config: ClientConfig,
    batch_id: Optional[str] = None,
    http_client: Optional[HubHttpClient] = None,
) -> Dict[str, Any]:
    """Enforce pre-ack local ledger safety gate and send item-by-item POST /api/agent/ack."""
    validate_safe_storage_path(config.workspace_dir, "workspace_dir")
    ledger = Ledger(config.ledger_path, config.agent_id)
    resolved_batch_id = (
        validate_slug(batch_id, "batch_id") if batch_id else ledger.latest_unacked_batch_id()
    )
    if not resolved_batch_id:
        raise HubClientError("No --batch specified and no un-acked batch found in local ledger.")

    batch_view = ledger.get_batch_view(resolved_batch_id)
    if not batch_view.items:
        raise HubClientError(f"Batch {resolved_batch_id!r} not found in local ledger.")

    if batch_view.acked:
        return {"ok": True, "batch_id": resolved_batch_id, "already_acked": True}

    sorted_keys = sorted(batch_view.items.keys(), key=lambda k: (k[0], k[1]))

    # Gate 1: Verify every pushed item has been pulled under review_done=true
    unpulled = [
        batch_view.items[k]["item_id"]
        for k in sorted_keys
        if not batch_view.items[k].get("review_done_pulled")
        or batch_view.items[k].get("destination") not in ("archive", "repair", "discard")
    ]
    if unpulled:
        if http_client is not None or (config.url and config.token):
            client_probe = http_client or HubHttpClient.from_config(config)
            try:
                v_resp = client_probe.get_verdicts(resolved_batch_id)
                if not v_resp.get("review_done"):
                    raise AckGateError(
                        f"Refusing ack for batch {resolved_batch_id}: review_not_done (cloud review_done=false)."
                    )
            except AckGateError:
                raise
            except HubClientError:
                pass
        raise AckGateError(
            f"Refusing ack for batch {resolved_batch_id}: verdicts have not been pulled into local ledger "
            f"(pending items: {unpulled}). Run 'pull --batch {resolved_batch_id}' after review_done=true."
        )

    # Gate 2: Every destination == 'archive' item MUST have a non-empty archive_ref
    missing_archive_refs: List[Dict[str, Any]] = []
    ack_items_payload: List[Dict[str, Any]] = []

    for k in sorted_keys:
        it = batch_view.items[k]
        dest = str(it["destination"])
        redraw = bool(it.get("redraw"))
        raw_ref = it.get("archive_ref")
        cleaned_ref = str(raw_ref).strip() if raw_ref is not None else ""

        if dest == "archive":
            if not cleaned_ref:
                missing_archive_refs.append(
                    {
                        "item_id": it["item_id"],
                        "round": int(it["round"]),
                        "final_tier": it.get("final_tier"),
                        "original_path": it.get("original_path"),
                    }
                )
            ack_items_payload.append(
                {
                    "item_id": it["item_id"],
                    "round": int(it["round"]),
                    "destination": "archive",
                    "redraw": redraw,
                    "archive_ref": cleaned_ref,
                }
            )
        else:
            ack_items_payload.append(
                {
                    "item_id": it["item_id"],
                    "round": int(it["round"]),
                    "destination": dest,
                    "redraw": redraw,
                    "archive_ref": None,
                }
            )

    if missing_archive_refs:
        missing_ids = [m["item_id"] for m in missing_archive_refs]
        raise AckGateError(
            f"Refusing ack for batch {resolved_batch_id}: {len(missing_archive_refs)} archive item(s) "
            f"missing non-empty archive_ref ({missing_ids}). Backfill via 'mark-archived' before ack.",
            pending_items=missing_archive_refs,
        )

    client = http_client or HubHttpClient.from_config(config)
    cloud_resp = client.post_ack(resolved_batch_id, ack_items_payload)

    ledger.append(
        {
            "event": "batch_acked",
            "state": "batch_acked",
            "batch_id": resolved_batch_id,
            "agent_id": config.agent_id,
            "purged_previews": cloud_resp.get("purged_previews"),
            "receipt": cloud_resp.get("receipt"),
            "tier_scale": TIER_SCALE_V4,
        }
    )

    return cloud_resp


def resolve_config(args: argparse.Namespace, env: Optional[Dict[str, str]] = None) -> ClientConfig:
    environ = os.environ if env is None else env

    url = getattr(args, "url", None) or environ.get("OUTPOST_URL", "")
    agent_id_raw = getattr(args, "agent_id", None) or environ.get("OUTPOST_AGENT_ID", "muse-main")
    token = getattr(args, "token", None) or environ.get("OUTPOST_TOKEN", "")

    ws_raw = (
        getattr(args, "workspace_dir", None)
        or environ.get("OUTPOST_HOME")
        or "~/workspace/review-outpost"
    )
    workspace_dir = validate_safe_storage_path(ws_raw, "workspace_dir")

    raw_source = getattr(args, "source", None)
    if raw_source is None:
        raw_source = environ.get("OUTPOST_SOURCE")
    source = validate_slug(raw_source, "source") if (raw_source and raw_source.strip()) else None

    raw_line = getattr(args, "line", None)
    if raw_line is None:
        raw_line = environ.get("OUTPOST_LINE")
    line = normalize_line(raw_line)

    raw_bt = getattr(args, "batch_type", None)
    if raw_bt is None:
        raw_bt = environ.get("OUTPOST_BATCH_TYPE")
    batch_type = (
        normalize_batch_type(raw_bt)
        if (raw_bt is not None and str(raw_bt).strip())
        else None
    )

    arg_anon = getattr(args, "anonymize_names", None)
    if arg_anon is not None:
        anonymize_names = bool(arg_anon)
    else:
        anonymize_names = parse_env_bool(environ.get("OUTPOST_ANONYMIZE_NAMES"), default=False)

    cf_id_raw = getattr(args, "cf_access_client_id", None)
    if cf_id_raw is None:
        cf_id_raw = environ.get("CF_ACCESS_CLIENT_ID")
    cf_secret_raw = getattr(args, "cf_access_client_secret", None)
    if cf_secret_raw is None:
        cf_secret_raw = environ.get("CF_ACCESS_CLIENT_SECRET")

    cf_id = cf_id_raw.strip() if cf_id_raw and cf_id_raw.strip() else None
    cf_secret = cf_secret_raw.strip() if cf_secret_raw and cf_secret_raw.strip() else None

    return ClientConfig(
        url=url,
        agent_id=validate_slug(agent_id_raw, "agent_id"),
        token=token,
        workspace_dir=workspace_dir,
        source=source,
        line=line,
        batch_type=batch_type,
        anonymize_names=anonymize_names,
        cf_access_client_id=cf_id,
        cf_access_client_secret=cf_secret,
    )


def build_arg_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--url", default=argparse.SUPPRESS, help="Worker base URL (OUTPOST_URL)")
    common.add_argument(
        "--agent-id",
        dest="agent_id",
        default=argparse.SUPPRESS,
        help="Agent slug bound to token (OUTPOST_AGENT_ID)",
    )
    common.add_argument("--token", default=argparse.SUPPRESS, help="Agent Bearer token (OUTPOST_TOKEN)")
    common.add_argument(
        "--workspace-dir",
        "--home",
        dest="workspace_dir",
        default=argparse.SUPPRESS,
        help="Persistent local workspace dir (OUTPOST_HOME, default ~/workspace/review-outpost)",
    )
    common.add_argument(
        "--cf-access-client-id",
        dest="cf_access_client_id",
        default=argparse.SUPPRESS,
        help="Optional Cloudflare Access Service Token Client ID (CF_ACCESS_CLIENT_ID)",
    )
    common.add_argument(
        "--cf-access-client-secret",
        dest="cf_access_client_secret",
        default=argparse.SUPPRESS,
        help="Optional Cloudflare Access Service Token Client Secret (CF_ACCESS_CLIENT_SECRET)",
    )

    parser = argparse.ArgumentParser(
        prog="hub_client.py",
        description="Review Outpost v4 Agent CLI",
        parents=[common],
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # push
    p_push = subparsers.add_parser(
        "push",
        parents=[common],
        help="Reserve batch_id, encode WebP q90, write local ledger first, and push previews in chunks",
    )
    p_push.add_argument("paths", nargs="*", help="Original image file(s) or directory(ies)")
    p_push.add_argument("--batch", dest="batch_id", help="Explicit batch_id override")
    p_push.add_argument("--source", dest="source", default=argparse.SUPPRESS, help="Workbench slug (OUTPOST_SOURCE)")
    p_push.add_argument("--line", dest="line", default=argparse.SUPPRESS, help="Pipeline line slug (OUTPOST_LINE)")
    p_push.add_argument(
        "--batch-type",
        dest="batch_type",
        default=argparse.SUPPRESS,
        help="Batch type: artwork | face | outfit (or 成图 | 脸模 | 服装; OUTPOST_BATCH_TYPE)",
    )
    p_push.add_argument(
        "--anonymize-names",
        dest="anonymize_names",
        action="store_true",
        default=argparse.SUPPRESS,
        help="Send sequential 001.webp... filenames to cloud while keeping real names in local ledger",
    )
    p_push.add_argument("--chunk-size", dest="chunk_size", type=int, default=10, help="Items per upload chunk")
    p_push.add_argument("--max-retries", dest="max_retries", type=int, default=2, help="Retries for rejected items")
    p_push.add_argument("--prompt", dest="inline_prompt", help="Explicit inline prompt override")
    p_push.add_argument("--item-id", dest="explicit_item_id", help="Explicit item_id (single file)")
    p_push.add_argument("--round", dest="explicit_round", type=int, help="Explicit round override")
    p_push.add_argument(
        "--parent-item-id",
        "--redraw-from",
        dest="parent_item_id",
        help="Parent item_id for candidate redraw/repair lineage",
    )
    p_push.add_argument(
        "--parent-map",
        dest="parent_map",
        help="JSON file or inline JSON mapping {local_path_or_filename: parent_item_id}",
    )
    p_push.add_argument(
        "--context-map",
        dest="context_map",
        help="JSON file or inline JSON mapping {local_path_or_filename: generation_context}",
    )
    p_push.add_argument(
        "--repush-item",
        dest="repush_item",
        help="Re-push repaired image keeping existing item_id with round=last_round+1",
    )
    p_push.add_argument(
        "--repush-map",
        "--repush",
        dest="repush_map",
        help="JSON file or inline JSON mapping {orig_item_id: repaired_image_path}",
    )

    # batches
    p_batches = subparsers.add_parser(
        "batches",
        parents=[common],
        help="List un-acked batches for this agent (supports multi-pipeline filtering)",
    )
    p_batches.add_argument("--source", dest="batches_source", help="Filter by source slug")
    p_batches.add_argument("--line", dest="batches_line", help="Filter by line slug")
    p_batches.add_argument(
        "--review-done",
        dest="batches_review_done",
        help="Filter by review_done (1/0/true/false)",
    )

    # pull
    p_pull = subparsers.add_parser(
        "pull",
        parents=[common],
        help="Read-only pull of verdicts into local ledger (never moves local files)",
    )
    p_pull.add_argument("--batch", dest="batch_id", help="Target batch_id (defaults to latest un-acked)")
    p_pull.add_argument("--watch", action="store_true", help="Poll until review_done=true")
    p_pull.add_argument("--interval", type=float, default=5.0, help="Watch poll interval in seconds")
    p_pull.add_argument("--max-polls", dest="max_polls", type=int, help="Max polls in --watch mode")

    # mark-archived
    p_mark = subparsers.add_parser(
        "mark-archived",
        parents=[common],
        help="Record archive_ref in local ledger for destination=='archive' items",
    )
    p_mark.add_argument("--batch", dest="batch_id", help="Target batch_id")
    p_mark.add_argument("--item-id", dest="item_id", help="Item ID to mark archived")
    p_mark.add_argument("--round", dest="round_num", type=int, help="Optional round number")
    p_mark.add_argument(
        "--archive-ref",
        "--drive-path",
        dest="archive_ref",
        help="Non-empty archive reference (--drive-path kept as backward-compatible alias)",
    )
    p_mark.add_argument(
        "--from-json",
        dest="from_json",
        help="JSON file or inline JSON mapping item_id -> archive_ref (or drive_path)",
    )

    # ack
    p_ack = subparsers.add_parser(
        "ack",
        parents=[common],
        help="Verify pre-ack ledger gate and send item-by-item ack to purge cloud batch",
    )
    p_ack.add_argument("--batch", dest="batch_id", help="Target batch_id")

    return parser


def main(argv: Optional[Sequence[str]] = None, env: Optional[Dict[str, str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    try:
        config = resolve_config(args, env=env)
        cmd = args.command

        if cmd == "push":
            res = cmd_push(
                config=config,
                paths=args.paths,
                batch_id=args.batch_id,
                source=getattr(args, "source", None),
                line=getattr(args, "line", None),
                batch_type=getattr(args, "batch_type", None),
                anonymize_names=getattr(args, "anonymize_names", None),
                chunk_size=args.chunk_size,
                max_retries=args.max_retries,
                inline_prompt=args.inline_prompt,
                explicit_item_id=args.explicit_item_id,
                explicit_round=args.explicit_round,
                parent_item_id=args.parent_item_id,
                parent_map_raw=args.parent_map,
                context_map_raw=args.context_map,
                repush_item=args.repush_item,
                repush_map_raw=args.repush_map,
            )
        elif cmd == "batches":
            res = cmd_batches(
                config=config,
                source=args.batches_source,
                line=args.batches_line,
                review_done=args.batches_review_done,
            )
        elif cmd == "pull":
            res = cmd_pull(
                config=config,
                batch_id=args.batch_id,
                watch=args.watch,
                interval=args.interval,
                max_polls=args.max_polls,
            )
        elif cmd == "mark-archived":
            res = cmd_mark_archived(
                config=config,
                batch_id=args.batch_id,
                item_id=args.item_id,
                archive_ref=args.archive_ref,
                round_num=args.round_num,
                from_json_raw=args.from_json,
            )
        elif cmd == "ack":
            res = cmd_ack(config=config, batch_id=args.batch_id)
        else:
            raise HubClientError(f"Unknown command: {cmd!r}")

        print(json.dumps(res, ensure_ascii=False, indent=2))
        return 0

    except AckGateError as exc:
        err_payload = {
            "ok": False,
            "error": "ack_blocked_by_ledger_gate",
            "message": str(exc),
            "missing_items": exc.pending_items,
            "pending_uploads": exc.pending_items,
        }
        formatted = json.dumps(err_payload, ensure_ascii=False, indent=2)
        print(formatted)
        print(formatted, file=sys.stderr)
        return 2
    except PathGuardError as exc:
        err_payload = {
            "ok": False,
            "error": "forbidden_storage_path",
            "message": str(exc),
        }
        formatted = json.dumps(err_payload, ensure_ascii=False, indent=2)
        print(formatted)
        print(formatted, file=sys.stderr)
        return 2
    except HttpApiError as exc:
        err_payload = {
            "ok": False,
            "error": "http_api_error",
            "status_code": exc.status_code,
            "message": str(exc),
            "server_payload": exc.payload,
        }
        formatted = json.dumps(err_payload, ensure_ascii=False, indent=2)
        print(formatted)
        print(formatted, file=sys.stderr)
        return 1
    except HubClientError as exc:
        err_payload = {
            "ok": False,
            "error": "hub_client_error",
            "message": str(exc),
        }
        formatted = json.dumps(err_payload, ensure_ascii=False, indent=2)
        print(formatted)
        print(formatted, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
