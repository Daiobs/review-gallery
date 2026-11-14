#!/usr/bin/env python3
"""Review Outpost v4 Agent CLI (hub_client.py).

Responsibilities:
- Strict storage path guard (forbids /tmp, /private/tmp, /var/tmp, and system dirs).
- Append-only local JSONL ledger (<workspace_dir>/ledger-<agent_id>.jsonl) with flush + fsync
  written BEFORE cloud HTTP push.
- Original-resolution WebP (quality=90) preview generation via Pillow and chunked upload
  (default 10 items/chunk) with per-item retry on server-reported `rejected` items.
- Cross-batch `round+1` repair re-push keeping `item_id` unchanged, plus `R` redraw lineage
  tracking with `MAX_REDRAW_ROUNDS` stop protection.
- Verdict pull (`pull` / `pull --watch`) implementing exact Rule 3 bucket priority:
    1) flags intersect {"H", "F", "O"} -> repair (preserving full verdict incl. tier)
    2) "R" in flags                    -> redraw (tracking consecutive redraws)
    3) tier in (1, 2, 3)               -> archived (drive_path=None until archived/backfilled)
    4) else                            -> discarded (move original to _trash/<batch_id>/, state="trashed",
                                          and auto-purge _trash files older than 7 days)
- Three archive modes (`connector`, `mount`, `rclone`) x two layouts (`ai_archive`, `aigc_tier`).
- Mandatory pre-ack local ledger safety gate refusing `ack` if any `archived` item lacks `drive_path`,
  plus automatic `ledger-<agent_id>.jsonl` backup sync on successful `ack` in `mount`/`rclone` modes.

Compatible with Python 3.9+ using only stdlib + Pillow.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
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

VALID_ARCHIVE_MODES: Tuple[str, ...] = ("connector", "mount", "rclone")
VALID_ARCHIVE_LAYOUTS: Tuple[str, ...] = ("ai_archive", "aigc_tier")
REPAIR_FLAGS: Set[str] = {"H", "F", "O"}
TIER_DIR_NAMES: Dict[int, str] = {
    1: "1-神图",
    2: "2-心动",
    3: "3-高品质",
}
ARCHIVE_ROOTS: Dict[str, str] = {
    "ai_archive": "AI_Archive",
    "aigc_tier": "aigc/成图收录",
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


def classify_bucket(tier: Optional[int], flags: Optional[Sequence[str]]) -> str:
    """Exact Rule 3 mutually exclusive bucket priority matching Worker and Frontend."""
    flag_set = {str(f).strip().upper() for f in (flags or []) if str(f).strip()}
    if flag_set & REPAIR_FLAGS:
        return "repair"
    if "R" in flag_set:
        return "redraw"
    if tier in (1, 2, 3):
        return "archived"
    return "discarded"


def format_rclone_dest(remote: str, rel_path: str) -> str:
    """Join RCLONE_REMOTE (e.g. 'gdrive:' or 'gdrive:base') with relative Drive path."""
    cleaned_remote = remote.strip()
    if not cleaned_remote:
        raise HubClientError("RCLONE_REMOTE is required for rclone archive mode.")
    if ":" not in cleaned_remote:
        cleaned_remote = cleaned_remote + ":"
    cleaned_rel = rel_path.lstrip("/")
    if cleaned_remote.endswith(":") or cleaned_remote.endswith("/"):
        return f"{cleaned_remote}{cleaned_rel}"
    return f"{cleaned_remote}/{cleaned_rel}"


def archive_root_for_layout(archive_layout: str) -> str:
    if archive_layout not in ARCHIVE_ROOTS:
        raise HubClientError(f"Unsupported archive_layout: {archive_layout!r}")
    return ARCHIVE_ROOTS[archive_layout]


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


def discover_sidecar_prompt(image_path: Path) -> Tuple[Optional[str], Optional[str]]:
    """Return (prompt_field, prompt_text) if <stem>.txt or <stem>.prompt.txt exists next to image."""
    candidates = [
        image_path.with_suffix(".txt"),
        image_path.parent / f"{image_path.stem}.prompt.txt",
    ]
    for sidecar in candidates:
        if sidecar.is_file():
            safe_sidecar = validate_safe_storage_path(sidecar, "prompt sidecar")
            text = safe_sidecar.read_text(encoding="utf-8", errors="replace")
            return str(safe_sidecar), text
    return None, None


@dataclass
class ClientConfig:
    url: str
    agent_id: str
    token: str
    workspace_dir: Path
    archive_mode: str = "connector"
    archive_layout: str = "ai_archive"
    mount_root: Optional[Path] = None
    rclone_remote: Optional[str] = None
    rclone_bin: str = "rclone"
    max_redraw_rounds: int = 3

    @property
    def ledger_path(self) -> Path:
        return validate_safe_storage_path(
            self.workspace_dir / f"ledger-{self.agent_id}.jsonl",
            "ledger file",
        )

    @property
    def trash_root(self) -> Path:
        return validate_safe_storage_path(self.workspace_dir / "_trash", "trash directory")

    @property
    def archive_root(self) -> str:
        return archive_root_for_layout(self.archive_layout)


@dataclass
class PreparedPushItem:
    item_id: str
    batch_id: str
    round: int
    original_path: Path
    filename: str
    width: int
    height: int
    webp_bytes: bytes
    preview_sha256: str
    prompt: Optional[str]
    prompt_text: Optional[str]
    redraw_from: Optional[str] = None
    redraw_lineage_id: Optional[str] = None
    prior_redraws: int = 0
    prior_verdict: Optional[Dict[str, Any]] = None


@dataclass
class BatchLedgerView:
    batch_id: str
    items: Dict[Tuple[str, int], Dict[str, Any]]
    acked: bool = False


class Ledger:
    """Append-only JSONL local ledger with mandatory flush + os.fsync on every write."""

    def __init__(self, path: Path, agent_id: str) -> None:
        self.path: Path = validate_safe_storage_path(path, "ledger path")
        self.agent_id: str = validate_slug(agent_id, "agent_id")

    def append(self, record: Dict[str, Any]) -> Dict[str, Any]:
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

    def next_batch_id(self, date_str: Optional[str] = None) -> str:
        day = date_str or today_yyyymmdd()
        prefix = f"{day}-{self.agent_id}-"
        max_seq = 0
        for rec in self.read_all():
            bid = str(rec.get("batch_id") or "")
            if bid.startswith(prefix):
                tail = bid[len(prefix) :]
                if tail.isdigit():
                    max_seq = max(max_seq, int(tail))
        return f"{prefix}{max_seq + 1:02d}"

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

    def latest_unacked_batch_id(self) -> Optional[str]:
        records = self.read_all()
        acked_batches: Set[str] = set()
        ordered_batches: List[str] = []
        for rec in records:
            bid = rec.get("batch_id")
            if not bid:
                continue
            if rec.get("state") == "batch_acked":
                acked_batches.add(str(bid))
            else:
                if str(bid) not in ordered_batches:
                    ordered_batches.append(str(bid))
        for bid in reversed(ordered_batches):
            if bid not in acked_batches:
                return bid
        return None

    def get_item_lineage(self, item_id: str) -> Optional[Dict[str, Any]]:
        """Reconstruct latest cross-batch state for `item_id` (highest round, latest record)."""
        records = [r for r in self.read_all() if r.get("item_id") == item_id]
        if not records:
            return None

        merged: Dict[str, Any] = {}
        max_round = 0
        for rec in records:
            if rec.get("state") == "push_rejected":
                continue
            r_num = int(rec.get("round") or 1)
            if r_num >= max_round:
                max_round = r_num
                for key, val in rec.items():
                    if val is not None or key not in merged:
                        merged[key] = val
                if "drive_path" in rec:
                    merged["drive_path"] = rec["drive_path"]
                if "verdict" in rec and rec["verdict"] is not None:
                    merged["verdict"] = rec["verdict"]
        merged["max_round"] = max_round if max_round > 0 else int(records[-1].get("round") or 1)
        return merged

    def get_redraw_lineage_state(self, item_id: str) -> Optional[Dict[str, Any]]:
        """Resolve latest redraw counter & stop status across the entire redraw lineage."""
        base = self.get_item_lineage(item_id)
        if base is None:
            return None
        lineage_id = str(base.get("redraw_lineage_id") or item_id)
        consecutive = 0
        stopped = False
        prompt_val = base.get("prompt")
        prompt_text_val = base.get("prompt_text")
        max_round = int(base.get("max_round") or 1)

        for rec in self.read_all():
            if rec.get("state") == "push_rejected":
                continue
            rec_item = str(rec.get("item_id") or "")
            rec_lin = str(rec.get("redraw_lineage_id") or "")
            rec_from = str(rec.get("redraw_from") or "")
            if rec_item == lineage_id or rec_lin == lineage_id or rec_item == item_id or rec_from == item_id:
                if rec.get("prompt") is not None:
                    prompt_val = rec.get("prompt")
                if rec.get("prompt_text") is not None:
                    prompt_text_val = rec.get("prompt_text")
                st = rec.get("state")
                if st in ("redraw", "redraw_stopped"):
                    consecutive = int(rec.get("consecutive_redraws") or consecutive)
                    stopped = bool(rec.get("redraw_stopped") or False)
                elif st == "archived":
                    consecutive = 0
                    stopped = False

        return {
            "lineage_id": lineage_id,
            "consecutive_redraws": consecutive,
            "redraw_stopped": stopped,
            "prompt": prompt_val,
            "prompt_text": prompt_text_val,
            "max_round": max_round,
        }

    def get_batch_view(self, batch_id: str) -> BatchLedgerView:
        items: Dict[Tuple[str, int], Dict[str, Any]] = {}
        rejected_keys: Set[Tuple[str, int]] = set()
        acked = False

        for rec in self.read_all():
            if rec.get("batch_id") != batch_id:
                continue
            state = rec.get("state")
            if state == "batch_acked":
                acked = True
                continue

            item_id = rec.get("item_id")
            if not item_id:
                continue
            round_num = int(rec.get("round") or 1)
            key = (str(item_id), round_num)

            if state == "pushed":
                rejected_keys.discard(key)
                items[key] = {
                    "item_id": str(item_id),
                    "batch_id": batch_id,
                    "round": round_num,
                    "original_path": rec.get("original_path"),
                    "filename": rec.get("filename"),
                    "width": rec.get("width"),
                    "height": rec.get("height"),
                    "prompt": rec.get("prompt"),
                    "prompt_text": rec.get("prompt_text"),
                    "preview_sha256": rec.get("preview_sha256"),
                    "state": "pushed",
                    "verdict": None,
                    "drive_path": None,
                    "prompt_drive_path": None,
                    "trash_path": None,
                    "redraw_from": rec.get("redraw_from"),
                    "redraw_lineage_id": rec.get("redraw_lineage_id") or str(item_id),
                    "prior_redraws": int(rec.get("prior_redraws") or 0),
                    "consecutive_redraws": int(rec.get("consecutive_redraws") or 0),
                    "redraw_stopped": bool(rec.get("redraw_stopped") or False),
                    "reason": rec.get("reason"),
                    "stop_reason": rec.get("stop_reason"),
                    "review_done_pulled": False,
                }
            elif state == "push_rejected":
                rejected_keys.add(key)
                items.pop(key, None)
            else:
                if key not in items:
                    items[key] = {
                        "item_id": str(item_id),
                        "batch_id": batch_id,
                        "round": round_num,
                        "original_path": rec.get("original_path"),
                        "filename": rec.get("filename"),
                        "width": rec.get("width"),
                        "height": rec.get("height"),
                        "prompt": rec.get("prompt"),
                        "prompt_text": rec.get("prompt_text"),
                        "preview_sha256": rec.get("preview_sha256"),
                        "state": state,
                        "verdict": rec.get("verdict"),
                        "drive_path": rec.get("drive_path"),
                        "prompt_drive_path": rec.get("prompt_drive_path"),
                        "trash_path": rec.get("trash_path"),
                        "redraw_from": rec.get("redraw_from"),
                        "redraw_lineage_id": rec.get("redraw_lineage_id") or str(item_id),
                        "prior_redraws": int(rec.get("prior_redraws") or 0),
                        "consecutive_redraws": int(rec.get("consecutive_redraws") or 0),
                        "redraw_stopped": bool(rec.get("redraw_stopped") or False),
                        "reason": rec.get("reason"),
                        "stop_reason": rec.get("stop_reason"),
                        "review_done_pulled": bool(rec.get("review_done") or False),
                    }
                else:
                    cur = items[key]
                    cur["state"] = state
                    for field in (
                        "original_path",
                        "filename",
                        "width",
                        "height",
                        "prompt",
                        "prompt_text",
                        "preview_sha256",
                        "trash_path",
                        "redraw_from",
                        "redraw_lineage_id",
                        "prompt_drive_path",
                    ):
                        if rec.get(field) is not None:
                            cur[field] = rec.get(field)
                    if "verdict" in rec and rec["verdict"] is not None:
                        cur["verdict"] = rec["verdict"]
                    if "drive_path" in rec:
                        cur["drive_path"] = rec["drive_path"]
                    if "consecutive_redraws" in rec and rec["consecutive_redraws"] is not None:
                        cur["consecutive_redraws"] = int(rec["consecutive_redraws"])
                    if "redraw_stopped" in rec and rec["redraw_stopped"] is not None:
                        cur["redraw_stopped"] = bool(rec["redraw_stopped"])
                    if "reason" in rec:
                        cur["reason"] = rec["reason"]
                    if "stop_reason" in rec:
                        cur["stop_reason"] = rec["stop_reason"]
                    if rec.get("review_done") is True or state in (
                        "archived",
                        "repair",
                        "redraw",
                        "trashed",
                    ):
                        cur["review_done_pulled"] = True

        return BatchLedgerView(batch_id=batch_id, items=items, acked=acked)


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
    """Zero-dependency urllib HTTP client for /api/agent/*."""

    def __init__(self, base_url: str, agent_id: str, token: str, timeout: float = 60.0) -> None:
        cleaned_url = (base_url or "").strip().rstrip("/")
        if not cleaned_url:
            raise HubClientError("OUTPOST_URL (--url) is required.")
        if not (token or "").strip():
            raise HubClientError("OUTPOST_TOKEN (--token) is required.")
        self.base_url = cleaned_url
        self.agent_id = validate_slug(agent_id, "agent_id")
        self.token = token.strip()
        self.timeout = timeout

        parsed = urllib.parse.urlparse(self.base_url)
        host = (parsed.hostname or "").lower()
        if host in ("127.0.0.1", "localhost", "::1"):
            self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        else:
            self._opener = urllib.request.build_opener()

    def _auth_headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "X-Agent-Id": self.agent_id,
            "Accept": "application/json",
            "User-Agent": "review-outpost-hub-client/4.0",
        }

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

    def push_chunk(self, batch_id: str, items: Sequence[PreparedPushItem]) -> Dict[str, Any]:
        manifest = {
            "agent_id": self.agent_id,
            "batch_id": batch_id,
            "items": [
                {
                    "item_id": it.item_id,
                    "round": it.round,
                    "filename": it.filename,
                    "width": it.width,
                    "height": it.height,
                }
                for it in items
            ],
        }
        body, content_type = build_multipart_form_data(manifest, items)
        return self._request_json("POST", "/api/agent/push", body=body, content_type=content_type)

    def get_verdicts(self, batch_id: str) -> Dict[str, Any]:
        query = urllib.parse.urlencode({"batch_id": batch_id})
        return self._request_json("GET", f"/api/agent/verdicts?{query}")

    def post_ack(self, batch_id: str, counts: Dict[str, int]) -> Dict[str, Any]:
        payload = json.dumps({"batch_id": batch_id, "counts": counts}).encode("utf-8")
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
        # Still run path guard in case a forbidden file path that didn't exist was passed
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


def cleanup_trash(workspace_dir: Path, max_age_days: float = 7.0, now_ts: Optional[float] = None) -> Dict[str, Any]:
    """Delete files inside <workspace_dir>/_trash older than `max_age_days` days."""
    safe_ws = validate_safe_storage_path(workspace_dir, "workspace_dir")
    trash_root = validate_safe_storage_path(safe_ws / "_trash", "trash directory")
    if not trash_root.is_dir():
        return {"deleted_files": [], "deleted_count": 0}

    current_ts = time.time() if now_ts is None else now_ts
    cutoff = current_ts - (max_age_days * 86400.0)
    deleted: List[str] = []

    for root_str, dirs, files in os.walk(str(trash_root), topdown=False):
        root_path = Path(root_str)
        for fname in files:
            fpath = root_path / fname
            try:
                stat_res = fpath.stat()
            except OSError:
                continue
            if stat_res.st_mtime <= cutoff:
                try:
                    fpath.unlink()
                    deleted.append(str(fpath))
                except OSError:
                    pass
        if root_path != trash_root:
            try:
                if not any(root_path.iterdir()):
                    root_path.rmdir()
            except OSError:
                pass

    return {"deleted_files": deleted, "deleted_count": len(deleted)}


def cmd_push(
    config: ClientConfig,
    paths: Sequence[Union[str, Path]],
    batch_id: Optional[str] = None,
    chunk_size: int = 10,
    max_retries: int = 2,
    inline_prompt: Optional[str] = None,
    explicit_item_id: Optional[str] = None,
    explicit_round: Optional[int] = None,
    repush_item: Optional[str] = None,
    repush_map_raw: Optional[str] = None,
    redraw_from: Optional[str] = None,
    redraw_map_raw: Optional[str] = None,
    http_client: Optional[HubHttpClient] = None,
) -> Dict[str, Any]:
    """Encode WebP q90, write ledger FIRST (flush+fsync), then upload in chunks of `chunk_size`."""
    if chunk_size < 1:
        raise HubClientError("--chunk-size must be >= 1.")
    if max_retries < 0:
        raise HubClientError("--max-retries must be >= 0.")

    validate_safe_storage_path(config.workspace_dir, "workspace_dir")
    ledger = Ledger(config.ledger_path, config.agent_id)
    client = http_client or HubHttpClient(config.url, config.agent_id, config.token)

    resolved_batch_id = validate_slug(batch_id, "batch_id") if batch_id else ledger.next_batch_id()
    expanded_files = expand_input_image_paths(paths)

    repush_pairs: List[Tuple[str, Path]] = []
    if repush_item:
        orig_id = validate_slug(repush_item, "repush_item")
        if len(expanded_files) != 1:
            raise HubClientError("--repush-item requires exactly 1 image file path.")
        repush_pairs.append((orig_id, expanded_files[0]))
        expanded_files = []

    if repush_map_raw:
        loaded_map = _load_json_arg(repush_map_raw, "repush_map")
        if not isinstance(loaded_map, dict) or not loaded_map:
            raise HubClientError("--repush-map must be a non-empty JSON object {item_id: image_path}.")
        for orig_id_raw, img_raw in loaded_map.items():
            orig_id = validate_slug(str(orig_id_raw), "repush_map item_id")
            img_path = validate_safe_storage_path(str(img_raw), "repaired image")
            if not img_path.is_file():
                raise HubClientError(f"Repaired image not found for {orig_id}: {img_path}")
            repush_pairs.append((orig_id, img_path))

    redraw_pairs: List[Tuple[str, Path]] = []
    if redraw_from:
        src_id = validate_slug(redraw_from, "redraw_from")
        if len(expanded_files) != 1:
            raise HubClientError("--redraw-from requires exactly 1 image file path.")
        redraw_pairs.append((src_id, expanded_files[0]))
        expanded_files = []

    if redraw_map_raw:
        loaded_rmap = _load_json_arg(redraw_map_raw, "redraw_map")
        if not isinstance(loaded_rmap, dict) or not loaded_rmap:
            raise HubClientError("--redraw-map must be a non-empty JSON object {orig_item_id: image_path}.")
        for src_id_raw, img_raw in loaded_rmap.items():
            src_id = validate_slug(str(src_id_raw), "redraw_map item_id")
            img_path = validate_safe_storage_path(str(img_raw), "redrawn image")
            if not img_path.is_file():
                raise HubClientError(f"Redrawn image not found for {src_id}: {img_path}")
            redraw_pairs.append((src_id, img_path))

    if explicit_item_id and len(expanded_files) != 1:
        raise HubClientError("--item-id can only be used when pushing a single image file.")

    prepared_items: List[PreparedPushItem] = []
    next_seq = ledger.next_item_seq(resolved_batch_id)

    # 1. Prepare repush (round+1) items keeping original item_id unchanged
    for orig_id, img_path in repush_pairs:
        prior = ledger.get_item_lineage(orig_id)
        if prior is None:
            raise HubClientError(f"Cannot repush unknown item_id {orig_id!r}: not found in local ledger.")
        new_round = explicit_round if explicit_round is not None else (int(prior["max_round"]) + 1)
        webp_bytes, width, height, sha256_hex = encode_webp_preview(img_path)

        sidecar_prompt, sidecar_text = discover_sidecar_prompt(img_path)
        if inline_prompt is not None:
            prompt_val: Optional[str] = inline_prompt
            prompt_text_val: Optional[str] = inline_prompt
        elif sidecar_prompt is not None:
            prompt_val = sidecar_prompt
            prompt_text_val = sidecar_text
        else:
            prompt_val = prior.get("prompt")
            prompt_text_val = prior.get("prompt_text")

        prepared_items.append(
            PreparedPushItem(
                item_id=orig_id,
                batch_id=resolved_batch_id,
                round=new_round,
                original_path=img_path,
                filename=img_path.name,
                width=width,
                height=height,
                webp_bytes=webp_bytes,
                preview_sha256=sha256_hex,
                prompt=prompt_val,
                prompt_text=prompt_text_val,
                prior_verdict=prior.get("verdict"),
            )
        )

    # 2. Prepare redraw lineage items (new item_id, round=1, consecutive redraw guard)
    for src_id, img_path in redraw_pairs:
        prior = ledger.get_redraw_lineage_state(src_id)
        if prior is None:
            raise HubClientError(f"Cannot redraw from unknown item_id {src_id!r}: not found in local ledger.")
        prior_count = int(prior.get("consecutive_redraws") or 0)
        lineage_id = str(prior.get("lineage_id") or src_id)
        if prior.get("redraw_stopped") or prior_count >= config.max_redraw_rounds:
            ledger.append(
                {
                    "item_id": src_id,
                    "batch_id": resolved_batch_id,
                    "round": int(prior.get("max_round") or 1),
                    "original_path": str(img_path),
                    "state": "redraw_stopped",
                    "redraw_from": src_id,
                    "redraw_lineage_id": lineage_id,
                    "consecutive_redraws": prior_count,
                    "redraw_stopped": True,
                    "reason": "max_redraw_exceeded",
                    "stop_reason": "max_redraw_exceeded",
                }
            )
            raise HubClientError(
                f"Redraw stopped for {src_id} (lineage {lineage_id}): "
                f"consecutive redraws ({prior_count}) >= MAX_REDRAW_ROUNDS ({config.max_redraw_rounds})."
            )

        item_id = f"{resolved_batch_id}-{next_seq:03d}"
        next_seq += 1
        webp_bytes, width, height, sha256_hex = encode_webp_preview(img_path)

        sidecar_prompt, sidecar_text = discover_sidecar_prompt(img_path)
        if inline_prompt is not None:
            prompt_val = inline_prompt
            prompt_text_val = inline_prompt
        elif sidecar_prompt is not None:
            prompt_val = sidecar_prompt
            prompt_text_val = sidecar_text
        else:
            prompt_val = prior.get("prompt")
            prompt_text_val = prior.get("prompt_text")

        prepared_items.append(
            PreparedPushItem(
                item_id=item_id,
                batch_id=resolved_batch_id,
                round=1,
                original_path=img_path,
                filename=img_path.name,
                width=width,
                height=height,
                webp_bytes=webp_bytes,
                preview_sha256=sha256_hex,
                prompt=prompt_val,
                prompt_text=prompt_text_val,
                redraw_from=src_id,
                redraw_lineage_id=lineage_id,
                prior_redraws=prior_count,
            )
        )

    # 3. Prepare fresh round=1 (or explicit item_id/round) items
    for img_path in expanded_files:
        if explicit_item_id:
            item_id = validate_slug(explicit_item_id, "item_id")
            round_num = explicit_round if explicit_round is not None else 1
        else:
            item_id = f"{resolved_batch_id}-{next_seq:03d}"
            next_seq += 1
            round_num = explicit_round if explicit_round is not None else 1

        webp_bytes, width, height, sha256_hex = encode_webp_preview(img_path)
        sidecar_prompt, sidecar_text = discover_sidecar_prompt(img_path)
        if inline_prompt is not None:
            prompt_val = inline_prompt
            prompt_text_val = inline_prompt
        else:
            prompt_val = sidecar_prompt
            prompt_text_val = sidecar_text

        prepared_items.append(
            PreparedPushItem(
                item_id=item_id,
                batch_id=resolved_batch_id,
                round=round_num,
                original_path=img_path,
                filename=img_path.name,
                width=width,
                height=height,
                webp_bytes=webp_bytes,
                preview_sha256=sha256_hex,
                prompt=prompt_val,
                prompt_text=prompt_text_val,
                redraw_from=None,
                redraw_lineage_id=item_id,
                prior_redraws=0,
            )
        )

    if not prepared_items:
        raise HubClientError("No images found to push.")

    # 4. Upload in chunks of `chunk_size`, strictly appending + fsyncing ledger BEFORE each HTTP push!
    accepted_all: List[str] = []
    rejected_final: List[Dict[str, Any]] = []
    chunk_count = 0
    last_cloud_pushed_count: Optional[int] = None

    for start_idx in range(0, len(prepared_items), chunk_size):
        chunk = prepared_items[start_idx : start_idx + chunk_size]
        chunk_count += 1

        # CRITICAL RULE 6 / SPEC §5: Write ledger state="pushed" + fsync BEFORE HTTP push!
        for item in chunk:
            record: Dict[str, Any] = {
                "item_id": item.item_id,
                "batch_id": item.batch_id,
                "round": item.round,
                "original_path": str(item.original_path),
                "filename": item.filename,
                "width": item.width,
                "height": item.height,
                "prompt": item.prompt,
                "prompt_text": item.prompt_text,
                "preview_sha256": item.preview_sha256,
                "state": "pushed",
                "verdict": None,
                "drive_path": None,
                "redraw_from": item.redraw_from,
                "redraw_lineage_id": item.redraw_lineage_id or item.item_id,
                "prior_redraws": item.prior_redraws,
                "consecutive_redraws": item.prior_redraws,
            }
            if item.prior_verdict is not None:
                record["prior_verdict"] = item.prior_verdict
            ledger.append(record)

        item_by_id: Dict[str, PreparedPushItem] = {it.item_id: it for it in chunk}
        pending_chunk: List[PreparedPushItem] = list(chunk)
        attempt = 0
        latest_rejections: List[Dict[str, Any]] = []

        while pending_chunk:
            resp = client.push_chunk(resolved_batch_id, pending_chunk)
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
                    }
                )

    result = {
        "batch_id": resolved_batch_id,
        "agent_id": config.agent_id,
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


def _move_to_trash(workspace_dir: Path, batch_id: str, item_id: str, orig_path_str: Optional[str]) -> Optional[str]:
    if not orig_path_str:
        return None
    orig_path = validate_safe_storage_path(orig_path_str, "original_path")
    if not orig_path.is_file():
        return None
    batch_trash_dir = validate_safe_storage_path(workspace_dir / "_trash" / batch_id, "batch trash dir")
    batch_trash_dir.mkdir(parents=True, exist_ok=True)
    dest = batch_trash_dir / orig_path.name
    if dest.exists():
        dest = batch_trash_dir / f"{item_id}_{orig_path.name}"
    shutil.move(str(orig_path), str(dest))
    return str(dest)


def _restore_from_trash_if_needed(orig_path_str: Optional[str], trash_path_str: Optional[str]) -> None:
    if not orig_path_str or not trash_path_str:
        return
    orig_path = validate_safe_storage_path(orig_path_str, "original_path")
    trash_path = validate_safe_storage_path(trash_path_str, "trash_path")
    if not orig_path.exists() and trash_path.is_file():
        orig_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(trash_path), str(orig_path))


def cmd_pull(
    config: ClientConfig,
    batch_id: Optional[str] = None,
    watch: bool = False,
    interval: float = 5.0,
    max_polls: Optional[int] = None,
    auto_archive: bool = False,
    trash_now_ts: Optional[float] = None,
    http_client: Optional[HubHttpClient] = None,
) -> Dict[str, Any]:
    """Pull verdicts for a batch; when review_done=True, apply Rule 3 bucket transitions to ledger."""
    validate_safe_storage_path(config.workspace_dir, "workspace_dir")
    ledger = Ledger(config.ledger_path, config.agent_id)
    resolved_batch_id = (
        validate_slug(batch_id, "batch_id") if batch_id else ledger.latest_unacked_batch_id()
    )
    if not resolved_batch_id:
        raise HubClientError("No --batch specified and no un-acked batch found in local ledger.")

    client = http_client or HubHttpClient(config.url, config.agent_id, config.token)

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
                "review_done": False,
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

    bucket_summary: Dict[str, int] = {
        "pushed": len(srv_items),
        "archived": 0,
        "repair": 0,
        "redraw": 0,
        "discarded": 0,
    }
    processed_items: List[Dict[str, Any]] = []

    for srv in srv_items:
        item_id = str(srv["item_id"])
        round_num = int(srv.get("round") or 1)
        tier_raw = srv.get("tier")
        tier: Optional[int] = int(tier_raw) if tier_raw in (1, 2, 3) else None
        flags: List[str] = [str(f).strip().upper() for f in (srv.get("flags") or []) if str(f).strip()]
        note: str = str(srv.get("note") or "")
        judged_at: Optional[str] = srv.get("judged_at")

        bucket = classify_bucket(tier, flags)
        bucket_summary[bucket] += 1
        target_state = "trashed" if bucket == "discarded" else bucket

        verdict_snapshot: Dict[str, Any] = {
            "tier": tier,
            "flags": flags,
            "note": note,
            "judged_at": judged_at,
            "bucket": bucket,
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
                "width": lineage.get("width"),
                "height": lineage.get("height"),
                "prompt": lineage.get("prompt"),
                "prompt_text": lineage.get("prompt_text"),
                "preview_sha256": lineage.get("preview_sha256"),
                "state": "pushed",
                "verdict": None,
                "drive_path": None,
                "trash_path": None,
                "redraw_from": lineage.get("redraw_from"),
                "redraw_lineage_id": lineage.get("redraw_lineage_id") or item_id,
                "prior_redraws": int(lineage.get("prior_redraws") or 0),
                "consecutive_redraws": int(lineage.get("consecutive_redraws") or 0),
                "redraw_stopped": False,
                "review_done_pulled": False,
            }

        already_identical = (
            local.get("review_done_pulled") is True
            and local.get("state") == target_state
            and local.get("verdict") == verdict_snapshot
        )

        if already_identical:
            processed_items.append(
                {
                    "item_id": item_id,
                    "round": round_num,
                    "bucket": bucket,
                    "state": target_state,
                    "tier": tier,
                    "flags": flags,
                    "note": note,
                    "drive_path": local.get("drive_path"),
                    "trash_path": local.get("trash_path"),
                    "consecutive_redraws": local.get("consecutive_redraws", 0),
                    "redraw_stopped": local.get("redraw_stopped", False),
                }
            )
            continue

        # If previously trashed before a review_done revoke, restore original before re-bucketing
        if target_state != "trashed" and local.get("trash_path"):
            _restore_from_trash_if_needed(local.get("original_path"), local.get("trash_path"))

        base_fields: Dict[str, Any] = {
            "item_id": item_id,
            "batch_id": resolved_batch_id,
            "round": round_num,
            "original_path": local.get("original_path"),
            "filename": local.get("filename"),
            "width": local.get("width"),
            "height": local.get("height"),
            "prompt": local.get("prompt"),
            "prompt_text": local.get("prompt_text"),
            "preview_sha256": local.get("preview_sha256"),
        }

        # Step 1: Append verdict snapshot entry (pushed -> verdict)
        verdict_rec = dict(base_fields)
        verdict_rec.update(
            {
                "state": "verdict",
                "verdict": verdict_snapshot,
                "drive_path": local.get("drive_path") if target_state == "archived" else None,
                "review_done": True,
            }
        )
        ledger.append(verdict_rec)

        # Step 2: Append bucket transition entry (verdict -> repair | redraw | archived | trashed)
        state_rec = dict(base_fields)
        state_rec["verdict"] = verdict_snapshot
        state_rec["review_done"] = True

        if bucket == "repair":
            state_rec.update(
                {
                    "state": "repair",
                    "target_tier": tier,
                    "drive_path": None,
                }
            )
        elif bucket == "redraw":
            prior_redraws = int(local.get("prior_redraws") or 0)
            new_redraws = prior_redraws + 1
            stopped = new_redraws >= config.max_redraw_rounds
            stop_reason = "max_redraw_exceeded" if stopped else None
            state_rec.update(
                {
                    "state": "redraw",
                    "drive_path": None,
                    "redraw_from": local.get("redraw_from"),
                    "redraw_lineage_id": local.get("redraw_lineage_id") or item_id,
                    "prior_redraws": prior_redraws,
                    "consecutive_redraws": new_redraws,
                    "redraw_stopped": stopped,
                    "reason": stop_reason,
                    "stop_reason": stop_reason,
                }
            )
        elif bucket == "archived":
            preserved_drive = local.get("drive_path") if local.get("state") == "archived" else None
            state_rec.update(
                {
                    "state": "archived",
                    "drive_path": preserved_drive,
                    "consecutive_redraws": 0,
                    "redraw_stopped": False,
                }
            )
        else:
            trash_dest = _move_to_trash(
                config.workspace_dir,
                resolved_batch_id,
                item_id,
                local.get("original_path"),
            )
            state_rec.update(
                {
                    "state": "trashed",
                    "drive_path": None,
                    "trash_path": trash_dest or local.get("trash_path"),
                }
            )

        ledger.append(state_rec)
        processed_items.append(
            {
                "item_id": item_id,
                "round": round_num,
                "bucket": bucket,
                "state": state_rec["state"],
                "tier": tier,
                "flags": flags,
                "note": note,
                "drive_path": state_rec.get("drive_path"),
                "trash_path": state_rec.get("trash_path"),
                "consecutive_redraws": state_rec.get("consecutive_redraws", 0),
                "redraw_stopped": state_rec.get("redraw_stopped", False),
                "stop_reason": state_rec.get("stop_reason"),
            }
        )

    trash_cleanup = cleanup_trash(config.workspace_dir, max_age_days=7.0, now_ts=trash_now_ts)

    result: Dict[str, Any] = {
        "batch_id": resolved_batch_id,
        "review_done": True,
        "counts": bucket_summary,
        "items": processed_items,
        "trash_purged_count": trash_cleanup["deleted_count"],
    }

    if auto_archive and config.archive_mode in ("mount", "rclone"):
        exec_res = cmd_archive_plan(
            config=config,
            batch_id=resolved_batch_id,
            execute=True,
            run_ack=True,
            http_client=client,
        )
        result["archive_execution"] = exec_res

    return result


def _resolve_prompt_source_for_archive(
    workspace_dir: Path,
    batch_id: str,
    item: Dict[str, Any],
) -> Optional[Path]:
    """Resolve existing sidecar prompt file or materialize inline prompt text into _prompts/."""
    prompt_field = item.get("prompt")
    prompt_text = item.get("prompt_text")
    orig_path_str = item.get("original_path")

    if isinstance(prompt_field, str) and prompt_field.strip():
        if prompt_field.startswith("/") or prompt_field.startswith("~"):
            try:
                p_candidate = validate_safe_storage_path(prompt_field, "prompt file")
                if p_candidate.is_file():
                    return p_candidate
            except HubClientError:
                raise

    if orig_path_str:
        orig_path = validate_safe_storage_path(orig_path_str, "original_path")
        sidecar_path_str, _ = discover_sidecar_prompt(orig_path)
        if sidecar_path_str:
            return Path(sidecar_path_str)

    inline_content: Optional[str] = None
    if isinstance(prompt_text, str):
        inline_content = prompt_text
    elif isinstance(prompt_field, str) and prompt_field:
        inline_content = prompt_field

    if inline_content is not None:
        prompts_dir = validate_safe_storage_path(
            workspace_dir / "_prompts" / batch_id,
            "materialized prompt dir",
        )
        prompts_dir.mkdir(parents=True, exist_ok=True)
        out_file = prompts_dir / f"{item['item_id']}_r{item['round']}.txt"
        out_file.write_text(inline_content, encoding="utf-8")
        return out_file

    return None


def _build_archive_plan_entries(
    config: ClientConfig,
    batch_id: str,
    batch_view: BatchLedgerView,
) -> List[Dict[str, Any]]:
    plan_items: List[Dict[str, Any]] = []
    used_targets: Set[str] = set()

    if len(batch_id) >= 8 and batch_id[:8].isdigit():
        batch_date = batch_id[:8]
    else:
        batch_date = today_yyyymmdd()

    sorted_keys = sorted(batch_view.items.keys())
    for key in sorted_keys:
        item = batch_view.items[key]
        if item.get("state") != "archived":
            continue

        verdict = item.get("verdict") or {}
        tier_raw = verdict.get("tier")
        tier = int(tier_raw) if tier_raw in (1, 2, 3) else 3

        orig_path_str = item.get("original_path")
        if not orig_path_str:
            raise HubClientError(f"Archived item {item['item_id']} missing original_path in ledger.")
        orig_path = validate_safe_storage_path(orig_path_str, "original_path")

        if config.archive_layout == "ai_archive":
            folder = f"AI_Archive/{config.agent_id}/{batch_id}"
        elif config.archive_layout == "aigc_tier":
            tier_dir = TIER_DIR_NAMES[tier]
            folder = f"aigc/成图收录/{batch_date}/{tier_dir}"
        else:
            raise HubClientError(f"Unsupported ARCHIVE_LAYOUT: {config.archive_layout!r}")

        chosen_name = orig_path.name
        chosen_stem = orig_path.stem
        candidate_target = f"{folder}/{chosen_name}"
        if candidate_target in used_targets:
            chosen_name = f"{item['item_id']}_{orig_path.name}"
            chosen_stem = f"{item['item_id']}_{orig_path.stem}"
            candidate_target = f"{folder}/{chosen_name}"
        used_targets.add(candidate_target)

        prompt_src_path = _resolve_prompt_source_for_archive(config.workspace_dir, batch_id, item)
        prompt_target = f"{folder}/{chosen_stem}.txt" if prompt_src_path is not None else None

        plan_items.append(
            {
                "item_id": item["item_id"],
                "round": int(item["round"]),
                "tier": tier,
                "original_path": str(orig_path),
                "prompt_source": str(prompt_src_path) if prompt_src_path is not None else None,
                "target_drive_path": candidate_target,
                "prompt_target_drive_path": prompt_target,
                "drive_path": item.get("drive_path"),
            }
        )

    return plan_items


def sync_ledger_backup(config: ClientConfig, ledger: Ledger) -> Optional[str]:
    """Sync ledger-<agent_id>.jsonl copy to Drive archive root in mount or rclone mode."""
    if not ledger.path.is_file():
        return None
    rel_backup = f"{config.archive_root}/ledger-{config.agent_id}.jsonl"

    if config.archive_mode == "mount":
        if config.mount_root is None:
            raise HubClientError("DRIVE_MOUNT_ROOT (--mount-root) is required in mount mode.")
        safe_mount = validate_safe_storage_path(config.mount_root, "mount_root")
        dest_file = validate_safe_storage_path(safe_mount / rel_backup, "ledger backup target")
        dest_file.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(ledger.path), str(dest_file))
        return str(dest_file)

    if config.archive_mode == "rclone":
        if not config.rclone_remote:
            raise HubClientError("RCLONE_REMOTE (--rclone-remote) is required in rclone mode.")
        dest_remote = format_rclone_dest(config.rclone_remote, rel_backup)
        proc = subprocess.run(
            [config.rclone_bin, "copyto", str(ledger.path), dest_remote],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            raise HubClientError(
                f"rclone ledger backup failed (exit {proc.returncode}): {proc.stderr or proc.stdout}"
            )
        return dest_remote

    return None


def cmd_archive_plan(
    config: ClientConfig,
    batch_id: Optional[str] = None,
    execute: bool = False,
    run_ack: bool = True,
    http_client: Optional[HubHttpClient] = None,
) -> Dict[str, Any]:
    """Generate archive manifest JSON; when execute=True in mount/rclone, copy/upload, backfill, ack & backup."""
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

    # If execute=True and verdicts were not pulled yet, auto-pull first if server review_done=True
    unpulled = [it for it in batch_view.items.values() if not it.get("review_done_pulled")]
    if unpulled and execute:
        pull_res = cmd_pull(
            config=config,
            batch_id=resolved_batch_id,
            watch=False,
            auto_archive=False,
            http_client=http_client,
        )
        if not pull_res.get("review_done"):
            raise HubClientError(
                f"Cannot execute archive for batch {resolved_batch_id}: review_done is false."
            )
        batch_view = ledger.get_batch_view(resolved_batch_id)
    elif unpulled:
        raise HubClientError(
            f"Batch {resolved_batch_id} has not been pulled with review_done=true yet; run 'pull' first."
        )

    plan_items = _build_archive_plan_entries(config, resolved_batch_id, batch_view)
    backup_rel = f"{config.archive_root}/ledger-{config.agent_id}.jsonl"

    output: Dict[str, Any] = {
        "batch_id": resolved_batch_id,
        "agent_id": config.agent_id,
        "archive_mode": config.archive_mode,
        "archive_layout": config.archive_layout,
        "archive_root": config.archive_root,
        "ledger_backup_drive_path": backup_rel,
        "executed": False,
        "items": plan_items,
    }

    if not execute or config.archive_mode == "connector":
        return output

    if config.archive_mode == "mount":
        if config.mount_root is None:
            raise HubClientError("DRIVE_MOUNT_ROOT (--mount-root) is required to execute mount archive.")
        safe_mount = validate_safe_storage_path(config.mount_root, "mount_root")

        for entry in plan_items:
            src_img = validate_safe_storage_path(entry["original_path"], "original_path")
            if not src_img.is_file():
                raise HubClientError(f"Original image missing for archive: {src_img}")
            dest_img = validate_safe_storage_path(
                safe_mount / entry["target_drive_path"],
                "mount target image",
            )
            dest_img.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(src_img), str(dest_img))

            if entry["prompt_source"] and entry["prompt_target_drive_path"]:
                src_prompt = validate_safe_storage_path(entry["prompt_source"], "prompt_source")
                dest_prompt = validate_safe_storage_path(
                    safe_mount / entry["prompt_target_drive_path"],
                    "mount target prompt",
                )
                dest_prompt.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(src_prompt), str(dest_prompt))

            item_rec = batch_view.items[(entry["item_id"], int(entry["round"]))]
            ledger.append(
                {
                    "item_id": entry["item_id"],
                    "batch_id": resolved_batch_id,
                    "round": int(entry["round"]),
                    "original_path": entry["original_path"],
                    "prompt": item_rec.get("prompt"),
                    "prompt_text": item_rec.get("prompt_text"),
                    "preview_sha256": item_rec.get("preview_sha256"),
                    "state": "archived",
                    "verdict": item_rec.get("verdict"),
                    "drive_path": entry["target_drive_path"],
                    "prompt_drive_path": entry["prompt_target_drive_path"],
                    "review_done": True,
                }
            )
            entry["drive_path"] = entry["target_drive_path"]

    elif config.archive_mode == "rclone":
        if not config.rclone_remote:
            raise HubClientError("RCLONE_REMOTE (--rclone-remote) is required to execute rclone archive.")

        for entry in plan_items:
            src_img = validate_safe_storage_path(entry["original_path"], "original_path")
            if not src_img.is_file():
                raise HubClientError(f"Original image missing for archive: {src_img}")
            dest_img_remote = format_rclone_dest(config.rclone_remote, entry["target_drive_path"])
            proc_img = subprocess.run(
                [config.rclone_bin, "copyto", str(src_img), dest_img_remote],
                capture_output=True,
                text=True,
            )
            if proc_img.returncode != 0:
                raise HubClientError(
                    f"rclone copyto failed for {src_img} -> {dest_img_remote} "
                    f"(exit {proc_img.returncode}): {proc_img.stderr or proc_img.stdout}"
                )

            if entry["prompt_source"] and entry["prompt_target_drive_path"]:
                src_prompt = validate_safe_storage_path(entry["prompt_source"], "prompt_source")
                dest_prompt_remote = format_rclone_dest(
                    config.rclone_remote,
                    entry["prompt_target_drive_path"],
                )
                proc_pr = subprocess.run(
                    [config.rclone_bin, "copyto", str(src_prompt), dest_prompt_remote],
                    capture_output=True,
                    text=True,
                )
                if proc_pr.returncode != 0:
                    raise HubClientError(
                        f"rclone copyto failed for prompt {src_prompt} -> {dest_prompt_remote} "
                        f"(exit {proc_pr.returncode}): {proc_pr.stderr or proc_pr.stdout}"
                    )

            item_rec = batch_view.items[(entry["item_id"], int(entry["round"]))]
            ledger.append(
                {
                    "item_id": entry["item_id"],
                    "batch_id": resolved_batch_id,
                    "round": int(entry["round"]),
                    "original_path": entry["original_path"],
                    "prompt": item_rec.get("prompt"),
                    "prompt_text": item_rec.get("prompt_text"),
                    "preview_sha256": item_rec.get("preview_sha256"),
                    "state": "archived",
                    "verdict": item_rec.get("verdict"),
                    "drive_path": entry["target_drive_path"],
                    "prompt_drive_path": entry["prompt_target_drive_path"],
                    "review_done": True,
                }
            )
            entry["drive_path"] = entry["target_drive_path"]

    output["executed"] = True
    if run_ack:
        ack_res = cmd_ack(config=config, batch_id=resolved_batch_id, http_client=http_client)
        output["ack"] = ack_res
    return output


def cmd_mark_archived(
    config: ClientConfig,
    batch_id: Optional[str] = None,
    item_id: Optional[str] = None,
    drive_path: Optional[str] = None,
    round_num: Optional[int] = None,
    from_json_raw: Optional[str] = None,
) -> Dict[str, Any]:
    """Backfill `drive_path` in local ledger after connector upload."""
    validate_safe_storage_path(config.workspace_dir, "workspace_dir")
    ledger = Ledger(config.ledger_path, config.agent_id)

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
                # Also support flat mapping {"<item_id>": "<drive_path>"}
                raw_list = [
                    {"item_id": str(k), "drive_path": str(v)}
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
            dp = entry.get("drive_path") or entry.get("target_drive_path")
            if not dp:
                raise HubClientError(f"Missing drive_path for item {entry.get('item_id')!r}")
            updates.append(
                {
                    "batch_id": entry.get("batch_id") or inferred_batch_id,
                    "item_id": str(entry["item_id"]),
                    "round": int(entry["round"]) if entry.get("round") is not None else None,
                    "drive_path": str(dp),
                    "prompt_drive_path": entry.get("prompt_drive_path")
                    or entry.get("prompt_target_drive_path"),
                }
            )

    if item_id or drive_path:
        if not (item_id and drive_path):
            raise HubClientError("Both --item-id and --drive-path are required for single-item backfill.")
        updates.append(
            {
                "batch_id": inferred_batch_id,
                "item_id": item_id,
                "round": round_num,
                "drive_path": drive_path,
                "prompt_drive_path": None,
            }
        )

    if not updates:
        raise HubClientError("Provide either (--item-id and --drive-path) or --from-json.")

    updated_records: List[Dict[str, Any]] = []
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

        rec = {
            "item_id": cur["item_id"],
            "batch_id": resolved_bid,
            "round": cur["round"],
            "original_path": cur.get("original_path"),
            "prompt": cur.get("prompt"),
            "prompt_text": cur.get("prompt_text"),
            "preview_sha256": cur.get("preview_sha256"),
            "state": "archived",
            "verdict": cur.get("verdict"),
            "drive_path": str(upd["drive_path"]).strip(),
            "prompt_drive_path": upd.get("prompt_drive_path"),
            "review_done": True,
        }
        ledger.append(rec)
        updated_records.append(
            {
                "batch_id": resolved_bid,
                "item_id": cur["item_id"],
                "round": cur["round"],
                "drive_path": rec["drive_path"],
            }
        )

    return {"ok": True, "updated": updated_records}


def cmd_ack(
    config: ClientConfig,
    batch_id: Optional[str] = None,
    http_client: Optional[HubHttpClient] = None,
) -> Dict[str, Any]:
    """Enforce mandatory pre-ack local ledger safety gate, call /api/agent/ack, and sync ledger backup."""
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

    # Gate 1: Verify batch verdicts have been pulled with review_done=True
    unpulled = [
        it["item_id"]
        for it in batch_view.items.values()
        if not it.get("review_done_pulled")
        or it.get("state") not in ("archived", "repair", "redraw", "trashed")
    ]
    if unpulled:
        # Also query cloud if reachable so review_not_done is reported accurately
        if http_client is not None or (config.url and config.token):
            client_probe = http_client or HubHttpClient(config.url, config.agent_id, config.token)
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

    # Gate 2 (Rule 6): Refuse ack if ANY archived item lacks drive_path!
    plan_for_pending = _build_archive_plan_entries(config, resolved_batch_id, batch_view)
    pending_uploads = [
        entry
        for entry in plan_for_pending
        if not (entry.get("drive_path") and str(entry["drive_path"]).strip())
    ]
    if pending_uploads:
        raise AckGateError(
            f"Refusing ack for batch {resolved_batch_id}: {len(pending_uploads)} archived item(s) "
            f"missing drive_path in local ledger. Upload originals/prompts and backfill via 'mark-archived' "
            f"(or run 'archive-plan --batch {resolved_batch_id} --execute' in mount/rclone mode).",
            pending_items=pending_uploads,
        )

    # Compute exact 4-bucket counts from local ledger
    counts = {
        "pushed": len(batch_view.items),
        "archived": 0,
        "repair": 0,
        "redraw": 0,
        "discarded": 0,
    }
    for it in batch_view.items.values():
        st = it.get("state")
        if st == "archived":
            counts["archived"] += 1
        elif st == "repair":
            counts["repair"] += 1
        elif st == "redraw":
            counts["redraw"] += 1
        elif st == "trashed":
            counts["discarded"] += 1
        else:
            raise AckGateError(f"Unexpected item state {st!r} for {it.get('item_id')!r} during ack.")

    client = http_client or HubHttpClient(config.url, config.agent_id, config.token)
    cloud_resp = client.post_ack(resolved_batch_id, counts)

    ledger.append(
        {
            "batch_id": resolved_batch_id,
            "agent_id": config.agent_id,
            "state": "batch_acked",
            "counts": counts,
            "deleted_previews": cloud_resp.get("deleted_previews"),
        }
    )

    backup_dest = sync_ledger_backup(config, ledger)
    return {
        "ok": True,
        "batch_id": resolved_batch_id,
        "counts": counts,
        "cloud_response": cloud_resp,
        "ledger_backup": backup_dest,
        "ledger_backup_drive_path": f"{config.archive_root}/ledger-{config.agent_id}.jsonl",
    }


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

    archive_mode = (
        getattr(args, "archive_mode", None) or environ.get("ARCHIVE_MODE") or "connector"
    ).strip()
    if archive_mode not in VALID_ARCHIVE_MODES:
        raise HubClientError(
            f"Invalid ARCHIVE_MODE {archive_mode!r}; expected one of {VALID_ARCHIVE_MODES}."
        )

    archive_layout = (
        getattr(args, "archive_layout", None) or environ.get("ARCHIVE_LAYOUT") or "ai_archive"
    ).strip()
    if archive_layout not in VALID_ARCHIVE_LAYOUTS:
        raise HubClientError(
            f"Invalid ARCHIVE_LAYOUT {archive_layout!r}; expected one of {VALID_ARCHIVE_LAYOUTS}."
        )

    mount_raw = getattr(args, "mount_root", None) or environ.get("DRIVE_MOUNT_ROOT")
    mount_root = validate_safe_storage_path(mount_raw, "mount_root") if mount_raw else None

    rclone_remote = getattr(args, "rclone_remote", None) or environ.get("RCLONE_REMOTE")
    rclone_bin = (
        getattr(args, "rclone_bin", None) or environ.get("RCLONE_BIN") or "rclone"
    ).strip()

    max_redraw_raw = getattr(args, "max_redraw_rounds", None)
    if max_redraw_raw is None:
        max_redraw_rounds = int(environ.get("MAX_REDRAW_ROUNDS", "3"))
    else:
        max_redraw_rounds = int(max_redraw_raw)
    if max_redraw_rounds < 1:
        raise HubClientError("MAX_REDRAW_ROUNDS must be >= 1.")

    return ClientConfig(
        url=url,
        agent_id=validate_slug(agent_id_raw, "agent_id"),
        token=token,
        workspace_dir=workspace_dir,
        archive_mode=archive_mode,
        archive_layout=archive_layout,
        mount_root=mount_root,
        rclone_remote=rclone_remote,
        rclone_bin=rclone_bin,
        max_redraw_rounds=max_redraw_rounds,
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
        "--archive-mode",
        dest="archive_mode",
        choices=VALID_ARCHIVE_MODES,
        default=argparse.SUPPRESS,
        help="Archive mode: connector | mount | rclone (ARCHIVE_MODE)",
    )
    common.add_argument(
        "--archive-layout",
        dest="archive_layout",
        choices=VALID_ARCHIVE_LAYOUTS,
        default=argparse.SUPPRESS,
        help="Drive directory layout: ai_archive | aigc_tier (ARCHIVE_LAYOUT)",
    )
    common.add_argument(
        "--mount-root",
        dest="mount_root",
        default=argparse.SUPPRESS,
        help="Local Google Drive mount root for mount mode (DRIVE_MOUNT_ROOT)",
    )
    common.add_argument(
        "--rclone-remote",
        dest="rclone_remote",
        default=argparse.SUPPRESS,
        help="rclone remote prefix, e.g. gdrive: (RCLONE_REMOTE)",
    )
    common.add_argument(
        "--rclone-bin",
        dest="rclone_bin",
        default=argparse.SUPPRESS,
        help="rclone executable path/name (RCLONE_BIN)",
    )
    common.add_argument(
        "--max-redraw-rounds",
        dest="max_redraw_rounds",
        type=int,
        default=argparse.SUPPRESS,
        help="Max consecutive R redraws before stopping (MAX_REDRAW_ROUNDS, default 3)",
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
        help="Encode WebP q90, write local ledger first, and push previews in chunks",
    )
    p_push.add_argument("paths", nargs="*", help="Original image file(s) or directory(ies)")
    p_push.add_argument("--batch", dest="batch_id", help="Explicit batch_id override")
    p_push.add_argument("--chunk-size", dest="chunk_size", type=int, default=10, help="Items per upload chunk")
    p_push.add_argument("--max-retries", dest="max_retries", type=int, default=2, help="Retries for rejected items")
    p_push.add_argument("--prompt", dest="inline_prompt", help="Explicit inline prompt override")
    p_push.add_argument("--item-id", dest="explicit_item_id", help="Explicit item_id (single file)")
    p_push.add_argument("--round", dest="explicit_round", type=int, help="Explicit round override")
    p_push.add_argument(
        "--repush-item",
        dest="repush_item",
        help="Re-push repaired image for existing item_id (keeps item_id, round=last_round+1)",
    )
    p_push.add_argument(
        "--repush-map",
        "--repush",
        dest="repush_map",
        help="JSON file or inline JSON mapping {orig_item_id: repaired_image_path}",
    )
    p_push.add_argument(
        "--redraw-from",
        dest="redraw_from",
        help="Lineage item_id that triggered this redraw (enforces MAX_REDRAW_ROUNDS)",
    )
    p_push.add_argument(
        "--redraw-map",
        dest="redraw_map",
        help="JSON file or inline JSON mapping {orig_item_id: redrawn_image_path}",
    )

    # pull
    p_pull = subparsers.add_parser(
        "pull",
        parents=[common],
        help="Pull verdicts for a batch and update local ledger",
    )
    p_pull.add_argument("--batch", dest="batch_id", help="Target batch_id (defaults to latest un-acked)")
    p_pull.add_argument("--watch", action="store_true", help="Poll until review_done=true")
    p_pull.add_argument("--interval", type=float, default=5.0, help="Watch poll interval in seconds")
    p_pull.add_argument("--max-polls", dest="max_polls", type=int, help="Max polls in --watch mode")
    p_pull.add_argument(
        "--auto",
        "--auto-archive",
        dest="auto_archive",
        action="store_true",
        help="Automatically execute archive + ack + ledger backup when ARCHIVE_MODE is mount/rclone",
    )

    # archive-plan (and alias archive)
    for sub_name, default_exec in (("archive-plan", False), ("archive", True)):
        p_arch = subparsers.add_parser(
            sub_name,
            parents=[common],
            help="Generate or execute Drive archive plan",
        )
        p_arch.add_argument("--batch", dest="batch_id", help="Target batch_id")
        p_arch.add_argument(
            "--execute",
            action="store_true",
            default=default_exec,
            help="Execute copy/rclone, backfill drive_path, ack, and sync ledger backup",
        )
        p_arch.add_argument(
            "--no-ack",
            dest="no_ack",
            action="store_true",
            help="Do not automatically call ack after executing mount/rclone archive",
        )

    # mark-archived
    p_mark = subparsers.add_parser(
        "mark-archived",
        parents=[common],
        help="Backfill drive_path in local ledger after connector upload",
    )
    p_mark.add_argument("--batch", dest="batch_id", help="Target batch_id")
    p_mark.add_argument("--item-id", dest="item_id", help="Item ID to mark archived")
    p_mark.add_argument("--round", dest="round_num", type=int, help="Optional round number")
    p_mark.add_argument("--drive-path", dest="drive_path", help="Uploaded Drive path")
    p_mark.add_argument(
        "--from-json",
        dest="from_json",
        help="JSON file or inline JSON containing archived item drive_path mappings",
    )

    # ack
    p_ack = subparsers.add_parser(
        "ack",
        parents=[common],
        help="Verify pre-ack ledger gate, notify cloud to purge batch, and backup ledger",
    )
    p_ack.add_argument("--batch", dest="batch_id", help="Target batch_id")

    # cleanup-trash
    p_trash = subparsers.add_parser(
        "cleanup-trash",
        parents=[common],
        help="Purge local _trash files older than N days (default 7)",
    )
    p_trash.add_argument("--days", type=float, default=7.0, help="Max age in days (default 7)")

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
                chunk_size=args.chunk_size,
                max_retries=args.max_retries,
                inline_prompt=args.inline_prompt,
                explicit_item_id=args.explicit_item_id,
                explicit_round=args.explicit_round,
                repush_item=args.repush_item,
                repush_map_raw=args.repush_map,
                redraw_from=args.redraw_from,
                redraw_map_raw=args.redraw_map,
            )
        elif cmd == "pull":
            res = cmd_pull(
                config=config,
                batch_id=args.batch_id,
                watch=args.watch,
                interval=args.interval,
                max_polls=args.max_polls,
                auto_archive=args.auto_archive,
            )
        elif cmd in ("archive-plan", "archive"):
            res = cmd_archive_plan(
                config=config,
                batch_id=args.batch_id,
                execute=bool(args.execute),
                run_ack=not bool(args.no_ack),
            )
        elif cmd == "mark-archived":
            res = cmd_mark_archived(
                config=config,
                batch_id=args.batch_id,
                item_id=args.item_id,
                drive_path=args.drive_path,
                round_num=args.round_num,
                from_json_raw=args.from_json,
            )
        elif cmd == "ack":
            res = cmd_ack(config=config, batch_id=args.batch_id)
        elif cmd == "cleanup-trash":
            res = cleanup_trash(config.workspace_dir, max_age_days=args.days)
        else:
            raise HubClientError(f"Unknown command: {cmd!r}")

        print(json.dumps(res, ensure_ascii=False, indent=2))
        return 0

    except AckGateError as exc:
        err_payload = {
            "ok": False,
            "error": "ack_blocked_by_ledger_gate",
            "message": str(exc),
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
