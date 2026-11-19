#!/usr/bin/env python3
"""Comprehensive offline test suite for Review Outpost v4 Agent CLI & Cutover Tool.

Covers Spec §6 & §7.2 (Python 3.9+ compatible, zero external network):
1. Ledger `batch_reserved` + `pushed` written & fsynced BEFORE HTTP push, plus 25-image
   10+10+5 chunking & per-item retry.
2. Multiprocess `fcntl.flock` atomic `batch_id` reservation (`<YYYYMMDD>-<source>-<line>-<NN>`)
   with zero collision under concurrent subprocesses, plus `GET /api/agent/batches` filtering.
3. Strictly read-only `cmd_pull` (local originals & sidecars 100% untouched), `tier = 0`
   end-to-end preservation, and orthogonal `destination + redraw` rules.
4. `--anonymize-names` blind-review filename desensitization (`001.webp`... on cloud while
   preserving real `filename` + `original_path` + `display_filename` in local ledger).
5. Lineage (`--parent-item-id`, `--parent-map` multi-candidate redraws with no hard cap,
   `--repush-item` / `--repush-map`) and local-only `generation_context` (`.json` / `.txt` /
   `--context-map`, never uploaded to cloud).
6. `mark-archived` destination guard (rejects `repair` / `discard` items, supports
   `--archive-ref` and legacy `--drive-path`) + pre-`ack` local gate + item-level
   `POST /api/agent/ack` 409/200 verification with `receipt`.
7. Cloudflare Access Service Token header injection (`CF-Access-Client-Id` &
   `CF-Access-Client-Secret`) with isolated `env` dict configuration.
8. `cutover_v4_star_scale` mixed historical/v4 ledger parsing (`1 <-> 3` before marker,
   direct `3/2/1/0` after marker, legacy `drive_path` -> `archive_ref`).
9. `agent/migrate_v4_cutover.py` (`mark-ledger` idempotency & `flip-star-table` atomic
   flip with strict count conservation across flat/list/nested JSON schemas).
10. Strict `/tmp` and system directory path guard across both CLIs.

All test sandboxes reside strictly under repo-relative `.test-sandboxes/agent/`.
"""

from __future__ import annotations

import contextlib
import email.parser
import email.policy
import hashlib
import hmac
import http.server
import io
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENT_DIR = REPO_ROOT / "agent"
HUB_CLIENT_SCRIPT = AGENT_DIR / "hub_client.py"
CUTOVER_SCRIPT = AGENT_DIR / "migrate_v4_cutover.py"
SANDBOX_ROOT = REPO_ROOT / ".test-sandboxes" / "agent"

if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import hub_client  # noqa: E402
import migrate_v4_cutover  # noqa: E402


DUMMY_AGENT_ID = "argon-mac"
DUMMY_AGENT_TOKEN = "test-only-dummy-agent-token-argon-01"
DUMMY_MUSE_ID = "muse-main"
DUMMY_MUSE_TOKEN = "test-only-dummy-agent-token-muse-02"
DUMMY_ACCESS_JWT = "test-only-dummy-cf-access-jwt-assertion"
DUMMY_CF_CLIENT_ID = "test-only-cf-service-client-id.access"
DUMMY_CF_CLIENT_SECRET = "test-only-cf-service-client-secret-placeholder"


def create_test_png(
    path: Path,
    size: Tuple[int, int] = (320, 240),
    color: Tuple[int, int, int] = (40, 120, 200),
) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", size, color=color)
    img.save(path, format="PNG")
    return path


class OutpostV4MockState:
    """Thread-safe in-memory simulation of v4 Worker D1 + R2 + Access/Service-Auth."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.agent_tokens: Dict[str, str] = {
            DUMMY_AGENT_ID: DUMMY_AGENT_TOKEN,
            DUMMY_MUSE_ID: DUMMY_MUSE_TOKEN,
        }
        self.valid_access_jwt: str = DUMMY_ACCESS_JWT
        self.require_cf_service_token: bool = False
        self.expected_cf_client_id: str = DUMMY_CF_CLIENT_ID
        self.expected_cf_client_secret: str = DUMMY_CF_CLIENT_SECRET
        self.observed_agent_headers: List[Dict[str, str]] = []
        self.observed_push_manifests: List[Dict[str, Any]] = []

        self.batches: Dict[str, Dict[str, Any]] = {}
        self.verdicts: Dict[Tuple[str, int], Dict[str, Any]] = {}
        self.r2_objects: Dict[str, bytes] = {}

        # Fault injection & timing hooks
        self.push_chunk_sizes: List[int] = []
        self.ack_http_calls: int = 0
        self.fail_next_push_count: int = 0
        self.push_delay_sec: float = 0.0
        self.reject_once_suffixes: Set[str] = set()
        self._already_rejected_once: Set[str] = set()
        self.on_push_arrival: Optional[Callable[[Dict[str, Any]], None]] = None

    def authenticate_agent(self, auth_header: str) -> Optional[str]:
        if not auth_header.startswith("Bearer "):
            return None
        provided = auth_header[len("Bearer ") :].strip()
        if not provided:
            return None
        provided_digest = hashlib.sha256(provided.encode("utf-8")).digest()
        matched_agent: Optional[str] = None
        for agent_id, secret in self.agent_tokens.items():
            expected_digest = hashlib.sha256(secret.encode("utf-8")).digest()
            if hmac.compare_digest(provided_digest, expected_digest):
                matched_agent = agent_id
        return matched_agent

    def compute_batch_counts(self, batch_id: str) -> Dict[str, int]:
        rows = [v for v in self.verdicts.values() if v["batch_id"] == batch_id]
        counts = {
            "pushed": len(rows),
            "archive": 0,
            "repair": 0,
            "discard": 0,
            "redraw": 0,
        }
        for row in rows:
            disp = hub_client.resolve_disposition(row["tier"], row["flags"])
            counts[disp["destination"]] += 1
            if disp["redraw"]:
                counts["redraw"] += 1
        return counts


class OutpostV4MockHandler(http.server.BaseHTTPRequestHandler):
    server_version = "MockOutpostWorkerV4/4.1"

    @property
    def state(self) -> OutpostV4MockState:
        return self.server.mock_state  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def _send_json(self, status: int, payload: Any) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("X-Robots-Tag", "noindex, nofollow, noarchive")
        self.send_header("Cache-Control", "private, no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or "0")
        return self.rfile.read(length) if length > 0 else b""

    def _require_agent_auth(self) -> Optional[str]:
        with self.state.lock:
            self.state.observed_agent_headers.append(
                {k.lower(): v for k, v in self.headers.items()}
            )
            if self.state.require_cf_service_token:
                cid = (self.headers.get("CF-Access-Client-Id") or "").strip()
                csec = (self.headers.get("CF-Access-Client-Secret") or "").strip()
                if cid != self.state.expected_cf_client_id or csec != self.state.expected_cf_client_secret:
                    self._send_json(403, {"error": "cf_access_service_token_rejected"})
                    return None

        authed = self.state.authenticate_agent(self.headers.get("Authorization") or "")
        if authed is None:
            self._send_json(401, {"error": "unauthorized_agent"})
            return None
        hdr_agent = (self.headers.get("X-Agent-Id") or "").strip()
        if hdr_agent and hdr_agent != authed:
            self._send_json(403, {"error": "agent_id_mismatch"})
            return None
        return authed

    def _require_access_jwt(self) -> bool:
        jwt_hdr = (self.headers.get("Cf-Access-Jwt-Assertion") or "").strip()
        if jwt_hdr != self.state.valid_access_jwt:
            self._send_json(401, {"error": "missing_or_invalid_access_jwt"})
            return False
        return True

    def _parse_multipart(
        self,
        content_type: str,
        body: bytes,
    ) -> Tuple[Dict[str, bytes], Dict[str, Tuple[Optional[str], str, bytes]]]:
        wire = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8") + body
        msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(wire)
        fields: Dict[str, bytes] = {}
        files: Dict[str, Tuple[Optional[str], str, bytes]] = {}
        for part in msg.iter_parts():
            name = part.get_param("name", header="content-disposition")
            if not name:
                continue
            fname = part.get_filename()
            ctype = part.get_content_type()
            payload = part.get_payload(decode=True) or b""
            if fname is not None:
                files[name] = (fname, ctype, payload)
            else:
                fields[name] = payload
        return fields, files

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/api/agent/batches":
            authed = self._require_agent_auth()
            if authed is None:
                return
            src_filter = (qs.get("source") or [None])[0]
            line_filter = (qs.get("line") or [None])[0]
            rd_filter = (qs.get("review_done") or [None])[0]

            with self.state.lock:
                results = []
                for bid, b in sorted(self.state.batches.items()):
                    if b["agent_id"] != authed:
                        continue
                    if src_filter and b["source"] != src_filter:
                        continue
                    if line_filter and b["line"] != line_filter:
                        continue
                    if rd_filter is not None:
                        want_done = rd_filter.lower() in ("1", "true")
                        if bool(b["review_done"]) != want_done:
                            continue
                    results.append(
                        {
                            "batch_id": bid,
                            "source": b["source"],
                            "line": b["line"],
                            "channel_id": hub_client.build_channel_id(b["source"], b["line"]),
                            "batch_type": b["batch_type"],
                            "pushed_count": b["pushed_count"],
                            "review_done": bool(b["review_done"]),
                            "review_done_at": b["review_done_at"],
                            "created_at": b["created_at"],
                        }
                    )
            self._send_json(200, {"batches": results})
            return

        if path == "/api/agent/verdicts":
            authed = self._require_agent_auth()
            if authed is None:
                return
            batch_id = (qs.get("batch_id") or [""])[0]
            with self.state.lock:
                batch = self.state.batches.get(batch_id)
                if batch is None:
                    self._send_json(404, {"error": "batch_not_found"})
                    return
                if batch["agent_id"] != authed:
                    self._send_json(403, {"error": "forbidden_batch"})
                    return
                counts = self.state.compute_batch_counts(batch_id)
                items = []
                for _, v in sorted(self.state.verdicts.items(), key=lambda kv: (kv[0][0], kv[0][1])):
                    if v["batch_id"] != batch_id:
                        continue
                    disp = hub_client.resolve_disposition(v["tier"], v["flags"])
                    items.append(
                        {
                            "item_id": v["item_id"],
                            "round": v["round"],
                            "parent_item_id": v["parent_item_id"],
                            "tier": v["tier"],
                            "flags": list(v["flags"]),
                            "destination": disp["destination"],
                            "redraw": disp["redraw"],
                            "note": v["note"],
                            "judged_at": v["judged_at"],
                        }
                    )
                self._send_json(
                    200,
                    {
                        "batch_id": batch_id,
                        "agent_id": batch["agent_id"],
                        "source": batch["source"],
                        "line": batch["line"],
                        "channel_id": hub_client.build_channel_id(batch["source"], batch["line"]),
                        "batch_type": batch["batch_type"],
                        "review_done": bool(batch["review_done"]),
                        "review_done_at": batch["review_done_at"],
                        "counts": counts,
                        "items": items,
                    },
                )
            return

        if not self._require_access_jwt():
            return

        if path.startswith("/api/review/batches/"):
            batch_id = path[len("/api/review/batches/") :]
            with self.state.lock:
                batch = self.state.batches.get(batch_id)
                if batch is None:
                    self._send_json(404, {"error": "batch_not_found"})
                    return
                items = []
                for _, v in sorted(self.state.verdicts.items()):
                    if v["batch_id"] != batch_id:
                        continue
                    disp = hub_client.resolve_disposition(v["tier"], v["flags"])
                    items.append(
                        dict(v, destination=disp["destination"], redraw=disp["redraw"])
                    )
                self._send_json(200, {"batch": dict(batch), "items": items})
            return

        self._send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body = self._read_body()

        if path == "/api/agent/push":
            authed = self._require_agent_auth()
            if authed is None:
                return
            if self.state.push_delay_sec > 0:
                time.sleep(self.state.push_delay_sec)

            ctype = self.headers.get("Content-Type") or ""
            fields, files = self._parse_multipart(ctype, body)
            manifest = json.loads(fields["manifest"].decode("utf-8"))

            if self.state.on_push_arrival is not None:
                self.state.on_push_arrival(manifest)

            with self.state.lock:
                self.state.observed_push_manifests.append(manifest)
                if self.state.fail_next_push_count > 0:
                    self.state.fail_next_push_count -= 1
                    self._send_json(500, {"error": "simulated_internal_error"})
                    return

                if manifest.get("agent_id") != authed:
                    self._send_json(403, {"error": "manifest_agent_mismatch"})
                    return

                batch_id = manifest["batch_id"]
                src = hub_client.resolve_default_source(authed, manifest.get("source"))
                line = hub_client.normalize_line(manifest.get("line"))
                try:
                    btype = hub_client.normalize_batch_type(manifest.get("batch_type"))
                except hub_client.HubClientError:
                    self._send_json(400, {"error": "invalid_batch_type"})
                    return

                existing_batch = self.state.batches.get(batch_id)
                if existing_batch is not None:
                    if existing_batch["agent_id"] != authed:
                        self._send_json(403, {"error": "batch_owner_mismatch"})
                        return
                    if existing_batch["review_done"]:
                        self._send_json(409, {"error": "review_already_done"})
                        return
                    if (
                        existing_batch["source"] != src
                        or existing_batch["line"] != line
                        or existing_batch["batch_type"] != btype
                    ):
                        self._send_json(409, {"error": "batch_metadata_conflict"})
                        return
                else:
                    self.state.batches[batch_id] = {
                        "batch_id": batch_id,
                        "agent_id": authed,
                        "source": src,
                        "line": line,
                        "batch_type": btype,
                        "pushed_count": 0,
                        "review_done": 0,
                        "review_done_at": None,
                        "created_at": hub_client.now_utc_iso(),
                    }

                m_items = manifest.get("items") or []
                self.state.push_chunk_sizes.append(len(m_items))
                accepted: List[str] = []
                rejected: List[Dict[str, str]] = []

                for m_it in m_items:
                    iid = m_it["item_id"]
                    rnd = int(m_it["round"])

                    if any(iid.endswith(sfx) for sfx in self.state.reject_once_suffixes) and (
                        iid not in self.state._already_rejected_once
                    ):
                        self.state._already_rejected_once.add(iid)
                        rejected.append({"item_id": iid, "reason": "simulated_transient_error"})
                        continue

                    existing_row = self.state.verdicts.get((iid, rnd))
                    if existing_row is not None and existing_row["batch_id"] != batch_id:
                        rejected.append({"item_id": iid, "reason": "conflict_other_batch"})
                        continue

                    if iid not in files:
                        rejected.append({"item_id": iid, "reason": "missing_webp_part"})
                        continue

                    part_fname, part_ctype, webp_bytes = files[iid]
                    if part_ctype != "image/webp" or part_fname != f"{iid}_r{rnd}.webp":
                        rejected.append({"item_id": iid, "reason": "invalid_part_headers"})
                        continue

                    with Image.open(io.BytesIO(webp_bytes)) as verify_img:
                        if verify_img.format != "WEBP" or verify_img.size != (
                            int(m_it["width"]),
                            int(m_it["height"]),
                        ):
                            rejected.append({"item_id": iid, "reason": "invalid_webp"})
                            continue

                    r2_key = f"previews/{authed}/{batch_id}/{iid}_r{rnd}.webp"
                    self.state.r2_objects[r2_key] = webp_bytes
                    self.state.verdicts[(iid, rnd)] = {
                        "item_id": iid,
                        "round": rnd,
                        "batch_id": batch_id,
                        "filename": m_it.get("filename"),
                        "width": int(m_it["width"]),
                        "height": int(m_it["height"]),
                        "parent_item_id": m_it.get("parent_item_id"),
                        "pushed_at": hub_client.now_utc_iso(),
                        "tier": None,
                        "flags": [],
                        "note": "",
                        "judged_at": None,
                    }
                    accepted.append(iid)

                pushed_count = sum(
                    1 for v in self.state.verdicts.values() if v["batch_id"] == batch_id
                )
                self.state.batches[batch_id]["pushed_count"] = pushed_count
                self._send_json(
                    200,
                    {
                        "batch_id": batch_id,
                        "pushed_count": pushed_count,
                        "accepted": accepted,
                        "rejected": rejected,
                    },
                )
            return

        if path == "/api/agent/ack":
            authed = self._require_agent_auth()
            if authed is None:
                return
            payload = json.loads(body.decode("utf-8"))
            batch_id = payload.get("batch_id")
            recv_items = payload.get("items")
            if not isinstance(recv_items, list):
                self._send_json(400, {"error": "invalid_items"})
                return

            with self.state.lock:
                self.state.ack_http_calls += 1
                batch = self.state.batches.get(batch_id)
                if batch is None:
                    self._send_json(404, {"error": "batch_not_found"})
                    return
                if batch["agent_id"] != authed:
                    self._send_json(403, {"error": "forbidden_batch"})
                    return
                if not batch["review_done"]:
                    self._send_json(409, {"error": "review_not_done", "review_done": False})
                    return

                d1_rows = {
                    (v["item_id"], v["round"]): v
                    for v in self.state.verdicts.values()
                    if v["batch_id"] == batch_id
                }
                seen_keys: Set[Tuple[str, int]] = set()
                recv_map: Dict[Tuple[str, int], Dict[str, Any]] = {}
                for entry in recv_items:
                    key = (str(entry.get("item_id")), int(entry.get("round") or 0))
                    if key in seen_keys:
                        self._send_json(409, {"error": "items_coverage_mismatch", "reason": "duplicate"})
                        return
                    seen_keys.add(key)
                    recv_map[key] = entry

                if seen_keys != set(d1_rows.keys()):
                    self._send_json(409, {"error": "items_coverage_mismatch"})
                    return

                missing_refs: List[str] = []
                receipt: Dict[str, List[str]] = {
                    "archive": [],
                    "repair": [],
                    "discard": [],
                    "redraw": [],
                }

                for key in sorted(d1_rows.keys()):
                    row = d1_rows[key]
                    req_it = recv_map[key]
                    disp = hub_client.resolve_disposition(row["tier"], row["flags"])
                    if (
                        req_it.get("destination") != disp["destination"]
                        or bool(req_it.get("redraw")) != disp["redraw"]
                    ):
                        self._send_json(
                            409,
                            {
                                "error": "disposition_mismatch",
                                "item_id": row["item_id"],
                                "expected": disp,
                            },
                        )
                        return
                    if disp["destination"] == "archive":
                        aref = req_it.get("archive_ref")
                        if not isinstance(aref, str) or not aref.strip():
                            missing_refs.append(row["item_id"])
                    receipt[disp["destination"]].append(row["item_id"])
                    if disp["redraw"]:
                        receipt["redraw"].append(row["item_id"])

                if missing_refs:
                    self._send_json(
                        409,
                        {"error": "missing_archive_ref", "missing_items": missing_refs},
                    )
                    return

                prefix = f"previews/{authed}/{batch_id}/"
                keys_to_delete = [k for k in self.state.r2_objects if k.startswith(prefix)]
                for k in keys_to_delete:
                    del self.state.r2_objects[k]
                for vk in list(d1_rows.keys()):
                    del self.state.verdicts[vk]
                del self.state.batches[batch_id]

                self._send_json(
                    200,
                    {
                        "ok": True,
                        "batch_id": batch_id,
                        "purged_previews": len(keys_to_delete),
                        "receipt": receipt,
                    },
                )
            return

        if path.startswith("/api/review/batches/") and path.endswith("/done"):
            if not self._require_access_jwt():
                return
            batch_id = path[len("/api/review/batches/") : -len("/done")]
            payload = json.loads(body.decode("utf-8"))
            with self.state.lock:
                batch = self.state.batches.get(batch_id)
                if batch is None:
                    self._send_json(404, {"error": "batch_not_found"})
                    return
                if payload.get("review_done"):
                    batch["review_done"] = 1
                    batch["review_done_at"] = hub_client.now_utc_iso()
                else:
                    batch["review_done"] = 0
                    batch["review_done_at"] = None
                self._send_json(200, {"batch": dict(batch)})
            return

        self._send_json(404, {"error": "not_found"})

    def do_PATCH(self) -> None:
        if not self._require_access_jwt():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body = self._read_body()

        prefix = "/api/review/batches/"
        if path.startswith(prefix) and "/items/" in path:
            rest = path[len(prefix) :]
            batch_id, tail = rest.split("/items/", 1)
            item_id, round_str = tail.split("/", 1)
            rnd = int(round_str)
            patch = json.loads(body.decode("utf-8"))

            with self.state.lock:
                batch = self.state.batches.get(batch_id)
                if batch is None:
                    self._send_json(404, {"error": "batch_not_found"})
                    return
                if batch["review_done"]:
                    self._send_json(409, {"error": "batch_locked"})
                    return
                row = self.state.verdicts.get((item_id, rnd))
                if row is None or row["batch_id"] != batch_id:
                    self._send_json(404, {"error": "item_not_found"})
                    return
                if "tier" in patch:
                    t_val = patch["tier"]
                    if t_val is not None and (
                        isinstance(t_val, bool) or t_val not in (0, 1, 2, 3)
                    ):
                        self._send_json(400, {"error": "invalid_tier"})
                        return
                    row["tier"] = t_val
                if "flags" in patch:
                    row["flags"] = hub_client.normalize_flags(patch["flags"])
                if "note" in patch:
                    row["note"] = str(patch["note"])
                has_judgment = (
                    row["tier"] is not None
                    or len(row["flags"]) > 0
                    or bool(row["note"].strip())
                )
                row["judged_at"] = hub_client.now_utc_iso() if has_judgment else None
                self._send_json(200, {"item": dict(row), "batch": dict(batch)})
            return

        self._send_json(404, {"error": "not_found"})


class ThreadedMockServer(http.server.ThreadingHTTPServer):
    allow_reuse_address = True

    def __init__(self, addr: Tuple[str, int], handler_cls: Any, mock_state: OutpostV4MockState) -> None:
        super().__init__(addr, handler_cls)
        self.mock_state = mock_state


class HubClientV4TestSuite(unittest.TestCase):
    def setUp(self) -> None:
        SANDBOX_ROOT.mkdir(parents=True, exist_ok=True)
        self.case_dir = SANDBOX_ROOT / self._testMethodName
        if self.case_dir.exists():
            shutil.rmtree(self.case_dir)
        self.case_dir.mkdir(parents=True, exist_ok=True)

        self.workspace_dir = self.case_dir / "workspace"
        self.originals_dir = self.case_dir / "originals"
        self.workspace_dir.mkdir(parents=True, exist_ok=True)
        self.originals_dir.mkdir(parents=True, exist_ok=True)

        self.mock_state = OutpostV4MockState()
        self.httpd = ThreadedMockServer(("127.0.0.1", 0), OutpostV4MockHandler, self.mock_state)
        self.port = self.httpd.server_address[1]
        self.base_url = f"http://127.0.0.1:{self.port}"
        self.server_thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.server_thread.start()

        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.server_thread.join(timeout=3.0)
        if self.case_dir.exists():
            shutil.rmtree(self.case_dir)

    def _base_env(self, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        env = dict(os.environ)
        for k in (
            "OUTPOST_SOURCE",
            "OUTPOST_LINE",
            "OUTPOST_BATCH_TYPE",
            "OUTPOST_ANONYMIZE_NAMES",
            "CF_ACCESS_CLIENT_ID",
            "CF_ACCESS_CLIENT_SECRET",
        ):
            env.pop(k, None)
        env.update(
            {
                "OUTPOST_URL": self.base_url,
                "OUTPOST_AGENT_ID": DUMMY_AGENT_ID,
                "OUTPOST_TOKEN": DUMMY_AGENT_TOKEN,
                "OUTPOST_HOME": str(self.workspace_dir),
            }
        )
        if extra:
            env.update(extra)
        return env

    def _run_cli(
        self,
        args: List[str],
        extra_env: Optional[Dict[str, str]] = None,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(HUB_CLIENT_SCRIPT)] + args,
            env=self._base_env(extra_env),
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
        )

    def _run_cutover_cli(self, args: List[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(CUTOVER_SCRIPT)] + args,
            env=self._base_env(),
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
        )

    def _review_request(
        self,
        method: str,
        path: str,
        payload: Optional[Dict[str, Any]] = None,
        access_jwt: Optional[str] = DUMMY_ACCESS_JWT,
    ) -> Tuple[int, Any]:
        headers: Dict[str, str] = {}
        if access_jwt is not None:
            headers["Cf-Access-Jwt-Assertion"] = access_jwt
        data: Optional[bytes] = None
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
        try:
            with self._opener.open(req, timeout=10.0) as resp:
                ctype = resp.headers.get("Content-Type") or ""
                raw = resp.read()
                if "application/json" in ctype:
                    return resp.status, json.loads(raw.decode("utf-8"))
                return resp.status, raw
        except urllib.error.HTTPError as exc:
            err_raw = exc.read().decode("utf-8", errors="replace")
            try:
                return exc.code, json.loads(err_raw)
            except json.JSONDecodeError:
                return exc.code, err_raw

    def _read_ledger_lines(self, agent_id: str = DUMMY_AGENT_ID) -> List[Dict[str, Any]]:
        ledger_file = self.workspace_dir / f"ledger-{agent_id}.jsonl"
        if not ledger_file.is_file():
            return []
        return [
            json.loads(line)
            for line in ledger_file.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    # ------------------------------------------------------------------
    # (1) Ledger written BEFORE HTTP push + 25-image chunking & retry
    # ------------------------------------------------------------------
    def test_01_ledger_before_http_push_and_25_image_chunk_retry(self) -> None:
        shot = create_test_png(self.originals_dir / "first.png", size=(512, 384))
        seen_mid_flight: List[Dict[str, Any]] = []

        def on_arrival(_manifest: Dict[str, Any]) -> None:
            seen_mid_flight.extend(self._read_ledger_lines())

        self.mock_state.on_push_arrival = on_arrival
        self.mock_state.fail_next_push_count = 1

        fail_proc = self._run_cli(["push", str(shot), "--line", "banana"])
        self.assertNotEqual(fail_proc.returncode, 0)
        # Both batch_reserved AND pushed records must be durably on disk BEFORE server responded!
        self.assertEqual([r.get("event") or r.get("state") for r in seen_mid_flight], ["batch_reserved", "pushed"])
        self.assertEqual(len(self.mock_state.batches), 0)

        # Now test 25 images auto-chunked 10+10+5 with retry on -005
        self.mock_state.on_push_arrival = None
        batch25_dir = self.case_dir / "batch25"
        for i in range(1, 26):
            create_test_png(batch25_dir / f"img_{i:03d}.png", size=(300 + i, 200 + i))
        self.mock_state.reject_once_suffixes.add("-005")

        ok_proc = self._run_cli(["push", str(batch25_dir), "--line", "banana"])
        self.assertEqual(ok_proc.returncode, 0, ok_proc.stderr)
        out = json.loads(ok_proc.stdout)
        self.assertTrue(out["batch_id"].endswith("-gallery-banana-02"))
        self.assertEqual(out["pushed_count"], 25)
        self.assertEqual(self.mock_state.push_chunk_sizes, [10, 1, 10, 5])

    # ------------------------------------------------------------------
    # (2) Concurrent subprocess `fcntl.flock` reservation & `/api/agent/batches`
    # ------------------------------------------------------------------
    def test_02_concurrent_flock_batch_reservation_and_batches_endpoint(self) -> None:
        img_a = create_test_png(self.originals_dir / "proc_a.png", size=(640, 640))
        img_b = create_test_png(self.originals_dir / "proc_b.png", size=(640, 640))

        # Delay server push handling so Process A is still uploading while Process B reserves batch_id
        self.mock_state.push_delay_sec = 0.18

        p1 = subprocess.Popen(
            [
                sys.executable,
                str(HUB_CLIENT_SCRIPT),
                "push",
                str(img_a),
                "--source",
                "gallery",
                "--line",
                "banana",
                "--batch-type",
                "脸模",
            ],
            env=self._base_env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=str(REPO_ROOT),
        )
        p2 = subprocess.Popen(
            [
                sys.executable,
                str(HUB_CLIENT_SCRIPT),
                "push",
                str(img_b),
                "--source",
                "gallery",
                "--line",
                "banana",
                "--batch-type",
                "服装",
            ],
            env=self._base_env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=str(REPO_ROOT),
        )

        out1_raw, err1 = p1.communicate(timeout=15.0)
        out2_raw, err2 = p2.communicate(timeout=15.0)
        self.assertEqual(p1.returncode, 0, err1)
        self.assertEqual(p2.returncode, 0, err2)

        res1 = json.loads(out1_raw)
        res2 = json.loads(out2_raw)
        self.assertNotEqual(res1["batch_id"], res2["batch_id"], "Concurrent flock must prevent collision!")

        seqs = sorted(res["batch_id"].rsplit("-", 1)[-1] for res in (res1, res2))
        self.assertEqual(seqs, ["01", "02"])
        self.assertEqual({res1["batch_type"], res2["batch_type"]}, {"face", "outfit"})

        # Push another pipeline line (`gpt`) under same agent token and test `batches` filtering
        self.mock_state.push_delay_sec = 0.0
        img_c = create_test_png(self.originals_dir / "proc_c.png")
        p3 = self._run_cli(["push", str(img_c), "--line", "gpt"])
        self.assertEqual(p3.returncode, 0, p3.stderr)
        b_gpt = json.loads(p3.stdout)["batch_id"]
        self._review_request("POST", f"/api/review/batches/{b_gpt}/done", {"review_done": True})

        all_b = json.loads(self._run_cli(["batches"]).stdout)["batches"]
        self.assertEqual(len(all_b), 3)

        banana_b = json.loads(self._run_cli(["batches", "--line", "banana"]).stdout)["batches"]
        self.assertEqual(len(banana_b), 2)

        done_b = json.loads(self._run_cli(["batches", "--review-done", "1"]).stdout)["batches"]
        self.assertEqual([b["batch_id"] for b in done_b], [b_gpt])

    # ------------------------------------------------------------------
    # (3) Read-only `pull` (originals untouched) + `tier = 0` + orthogonal rules
    # ------------------------------------------------------------------
    def test_03_pull_read_only_originals_untouched_and_tier_zero_orthogonal(self) -> None:
        files: List[Path] = []
        for idx in range(1, 7):
            img_p = create_test_png(self.originals_dir / f"item_{idx}.png")
            txt_p = self.originals_dir / f"item_{idx}.txt"
            txt_p.write_text(f"prompt for item {idx}", encoding="utf-8")
            files.extend([img_p, txt_p])

        before_hashes = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}

        batch_id = "20261119-gallery-banana-01"
        push_proc = self._run_cli(["push", str(self.originals_dir), "--batch", batch_id, "--line", "banana"])
        self.assertEqual(push_proc.returncode, 0, push_proc.stderr)

        # 001: tier=0, flags=[] -> archive (final_tier=0, must NOT be swallowed as null!)
        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_id}/items/{batch_id}-001/1",
            {"tier": 0, "flags": [], "note": "keep sample"},
        )
        # 002: tier=3 + R -> archive + redraw=True (final_tier=3)
        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_id}/items/{batch_id}-002/1",
            {"tier": 3, "flags": ["R"], "note": "archive AND redraw"},
        )
        # 003: tier=0 + H + R -> repair + redraw=True (intent_tier=0, final_tier=None!)
        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_id}/items/{batch_id}-003/1",
            {"tier": 0, "flags": ["H", "R"], "note": "repair hand, intent 0-star"},
        )
        # 004: tier=3 + F -> repair + redraw=False (intent_tier=3, final_tier=None)
        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_id}/items/{batch_id}-004/1",
            {"tier": 3, "flags": ["F"], "note": "fix foot"},
        )
        # 005: tier=None + R -> discard + redraw=True
        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_id}/items/{batch_id}-005/1",
            {"tier": None, "flags": ["R"], "note": "only redraw"},
        )
        # 006: tier=None, flags=[] -> discard + redraw=False
        self._review_request("POST", f"/api/review/batches/{batch_id}/done", {"review_done": True})

        pull_proc = self._run_cli(["pull", "--batch", batch_id])
        self.assertEqual(pull_proc.returncode, 0, pull_proc.stderr)
        pulled = json.loads(pull_proc.stdout)

        self.assertEqual(
            pulled["counts"],
            {"pushed": 6, "archive": 2, "repair": 2, "discard": 2, "redraw": 3},
        )

        # CRITICAL §6.1.1: Every single original image and sidecar file MUST be completely untouched!
        for p in files:
            self.assertTrue(p.is_file(), f"File must NOT be moved or deleted by pull: {p}")
            self.assertEqual(hashlib.sha256(p.read_bytes()).hexdigest(), before_hashes[str(p)])
        self.assertFalse((self.workspace_dir / "_trash").exists(), "hub_client must NOT create _trash!")

        # Verify ledger view exact fields (especially tier=0 and intent_tier=0!)
        ledger = hub_client.Ledger(self.workspace_dir / f"ledger-{DUMMY_AGENT_ID}.jsonl", DUMMY_AGENT_ID)
        bview = ledger.get_batch_view(batch_id)

        it1 = bview.items[(f"{batch_id}-001", 1)]
        self.assertEqual(it1["destination"], "archive")
        self.assertIs(it1["final_tier"], 0)
        self.assertIsNone(it1["intent_tier"])
        self.assertFalse(it1["redraw"])

        it2 = bview.items[(f"{batch_id}-002", 1)]
        self.assertEqual(it2["destination"], "archive")
        self.assertEqual(it2["final_tier"], 3)
        self.assertTrue(it2["redraw"])

        it3 = bview.items[(f"{batch_id}-003", 1)]
        self.assertEqual(it3["destination"], "repair")
        self.assertIsNone(it3["final_tier"])
        self.assertIs(it3["intent_tier"], 0)
        self.assertEqual(it3["repair_flags"], ["H"])
        self.assertTrue(it3["redraw"])

        it5 = bview.items[(f"{batch_id}-005", 1)]
        self.assertEqual(it5["destination"], "discard")
        self.assertIsNone(it5["final_tier"])
        self.assertTrue(it5["redraw"])

    # ------------------------------------------------------------------
    # (4) `--anonymize-names`: cloud desensitized, local ledger faithful
    # ------------------------------------------------------------------
    def test_04_anonymize_names_cloud_desensitized_ledger_faithful(self) -> None:
        f1 = create_test_png(self.originals_dir / "01_secret_model_alice_v3.png")
        f2 = create_test_png(self.originals_dir / "02_private_outfit_crimson.png")

        proc = self._run_cli(
            ["push", str(f1), str(f2), "--line", "gpt", "--anonymize-names"],
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        batch_id = json.loads(proc.stdout)["batch_id"]

        # Verify cloud manifest & review endpoint NEVER saw "alice" or "crimson"
        raw_manifests = json.dumps(self.mock_state.observed_push_manifests)
        self.assertNotIn("alice", raw_manifests)
        self.assertNotIn("crimson", raw_manifests)

        st, detail = self._review_request("GET", f"/api/review/batches/{batch_id}")
        self.assertEqual(st, 200)
        self.assertEqual([it["filename"] for it in detail["items"]], ["001.webp", "002.webp"])

        # Verify local ledger preserved real `filename`, `original_path`, and `display_filename`
        ledger = hub_client.Ledger(self.workspace_dir / f"ledger-{DUMMY_AGENT_ID}.jsonl", DUMMY_AGENT_ID)
        bview = ledger.get_batch_view(batch_id)
        rec1 = bview.items[(f"{batch_id}-001", 1)]
        rec2 = bview.items[(f"{batch_id}-002", 1)]
        self.assertEqual(rec1["filename"], "01_secret_model_alice_v3.png")
        self.assertEqual(rec1["original_path"], str(f1))
        self.assertEqual(rec1["display_filename"], "001.webp")
        self.assertEqual(rec2["filename"], "02_private_outfit_crimson.png")
        self.assertEqual(rec2["display_filename"], "002.webp")

    # ------------------------------------------------------------------
    # (5) `parent_item_id`, `--parent-map` multi-candidates, & `generation_context`
    # ------------------------------------------------------------------
    def test_05_parent_lineage_multi_candidates_and_local_generation_context(self) -> None:
        root_img = create_test_png(self.originals_dir / "seed_shot.png")
        (self.originals_dir / "seed_shot.json").write_text(
            json.dumps({"prompt": "sunlit portrait", "seed": 424242, "lora": "film_v2"}),
            encoding="utf-8",
        )

        b1_proc = self._run_cli(["push", str(root_img), "--batch", "20261119-gallery-gpt-01", "--line", "gpt"])
        self.assertEqual(b1_proc.returncode, 0, b1_proc.stderr)
        parent_id = "20261119-gallery-gpt-01-001"

        # Verify generation_context was NEVER sent to cloud manifest!
        self.assertNotIn("424242", json.dumps(self.mock_state.observed_push_manifests))
        self.assertNotIn("generation_context", json.dumps(self.mock_state.observed_push_manifests))

        # Push 4 candidate redraws derived from the SAME parent_id via --parent-map (no MAX_REDRAW_ROUNDS cap!)
        cand_dir = self.case_dir / "candidates"
        cands = [create_test_png(cand_dir / f"cand_{i}.png") for i in range(1, 5)]
        pmap_file = self.case_dir / "parent_map.json"
        pmap_file.write_text(
            json.dumps(
                {
                    "cand_1.png": parent_id,
                    "cand_2.png": parent_id,
                    str(cands[2]): parent_id,
                    str(cands[3]): parent_id,
                }
            ),
            encoding="utf-8",
        )
        cmap_json = json.dumps({"cand_4.png": {"prompt": "override prompt", "seed": 999}})

        b2_proc = self._run_cli(
            [
                "push",
                str(cand_dir),
                "--batch",
                "20261119-gallery-gpt-02",
                "--line",
                "gpt",
                "--parent-map",
                str(pmap_file),
                "--context-map",
                cmap_json,
            ]
        )
        self.assertEqual(b2_proc.returncode, 0, b2_proc.stderr)

        st, b2_detail = self._review_request("GET", "/api/review/batches/20261119-gallery-gpt-02")
        self.assertEqual(st, 200)
        self.assertEqual([it["parent_item_id"] for it in b2_detail["items"]], [parent_id] * 4)

        ledger = hub_client.Ledger(self.workspace_dir / f"ledger-{DUMMY_AGENT_ID}.jsonl", DUMMY_AGENT_ID)
        b2_view = ledger.get_batch_view("20261119-gallery-gpt-02")
        # cand_1 inherited generation_context from parent_id; cand_4 used --context-map override!
        self.assertEqual(
            b2_view.items[("20261119-gallery-gpt-02-001", 1)]["generation_context"]["seed"],
            424242,
        )
        self.assertEqual(
            b2_view.items[("20261119-gallery-gpt-02-004", 1)]["generation_context"]["seed"],
            999,
        )

        # Also verify single `--parent-item-id` and `--repush-item` round+1
        single_cand = create_test_png(self.case_dir / "single_child.png")
        b3_proc = self._run_cli(
            [
                "push",
                str(single_cand),
                "--batch",
                "20261119-gallery-gpt-03",
                "--line",
                "gpt",
                "--parent-item-id",
                parent_id,
            ]
        )
        self.assertEqual(b3_proc.returncode, 0, b3_proc.stderr)
        st3, b3_detail = self._review_request("GET", "/api/review/batches/20261119-gallery-gpt-03")
        self.assertEqual(st3, 200)
        self.assertEqual(b3_detail["items"][0]["parent_item_id"], parent_id)

        repaired_r2 = create_test_png(self.case_dir / "seed_shot_r2.png")
        b4_proc = self._run_cli(
            [
                "push",
                str(repaired_r2),
                "--batch",
                "20261119-gallery-gpt-04",
                "--line",
                "gpt",
                "--repush-item",
                parent_id,
            ]
        )
        self.assertEqual(b4_proc.returncode, 0, b4_proc.stderr)
        st4, b4_detail = self._review_request("GET", "/api/review/batches/20261119-gallery-gpt-04")
        self.assertEqual(st4, 200)
        self.assertEqual([(it["item_id"], it["round"]) for it in b4_detail["items"]], [(parent_id, 2)])

    # ------------------------------------------------------------------
    # (6) `mark-archived` destination guard + `ack` gate & item-level `receipt`
    # ------------------------------------------------------------------
    def test_06_mark_archived_guard_and_ack_item_level_receipt(self) -> None:
        for i in range(1, 5):
            create_test_png(self.originals_dir / f"g_{i}.png")

        batch_id = "20261119-gallery-banana-06"
        self.assertEqual(
            self._run_cli(["push", str(self.originals_dir), "--batch", batch_id, "--line", "banana"]).returncode,
            0,
        )

        # Premature ack before review_done=true -> rejected locally (exit 2)
        early_ack = self._run_cli(["ack", "--batch", batch_id])
        self.assertEqual(early_ack.returncode, 2)
        self.assertIn("review_not_done", early_ack.stdout)
        self.assertEqual(self.mock_state.ack_http_calls, 0)

        # 001: tier=3 + R -> archive + redraw
        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_id}/items/{batch_id}-001/1",
            {"tier": 3, "flags": ["R"]},
        )
        # 002: tier=0 -> archive (0-star!)
        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_id}/items/{batch_id}-002/1",
            {"tier": 0, "flags": []},
        )
        # 003: tier=2 + H -> repair (intent_tier=2)
        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_id}/items/{batch_id}-003/1",
            {"tier": 2, "flags": ["H"]},
        )
        # 004: discard
        self._review_request("POST", f"/api/review/batches/{batch_id}/done", {"review_done": True})
        self.assertEqual(self._run_cli(["pull", "--batch", batch_id]).returncode, 0)

        # mark-archived MUST reject `repair` (003) and `discard` (004) items with non-zero exit!
        bad_mark_repair = self._run_cli(
            [
                "mark-archived",
                "--batch",
                batch_id,
                "--item-id",
                f"{batch_id}-003",
                "--archive-ref",
                "should_not_allow.png",
            ]
        )
        self.assertNotEqual(bad_mark_repair.returncode, 0)
        bad_mark_discard = self._run_cli(
            [
                "mark-archived",
                "--batch",
                batch_id,
                "--item-id",
                f"{batch_id}-004",
                "--archive-ref",
                "should_not_allow_discard.png",
            ]
        )
        self.assertNotEqual(bad_mark_discard.returncode, 0)

        # Verify `repair` item 003 was NOT mutated in ledger
        ledger = hub_client.Ledger(self.workspace_dir / f"ledger-{DUMMY_AGENT_ID}.jsonl", DUMMY_AGENT_ID)
        self.assertEqual(ledger.get_batch_view(batch_id).items[(f"{batch_id}-003", 1)]["destination"], "repair")
        self.assertEqual(ledger.get_batch_view(batch_id).items[(f"{batch_id}-003", 1)]["intent_tier"], 2)

        # ack BEFORE marking 001 & 002 archived -> blocked by local gate (exit 2, 0 HTTP calls)
        blocked_ack = self._run_cli(["ack", "--batch", batch_id])
        self.assertEqual(blocked_ack.returncode, 2)
        blocked_payload = json.loads(blocked_ack.stdout)
        self.assertEqual(len(blocked_payload["missing_items"]), 2)
        self.assertEqual(self.mock_state.ack_http_calls, 0)

        # Mark 001 via --archive-ref, and 002 (tier=0!) via legacy alias --drive-path
        self.assertEqual(
            self._run_cli(
                [
                    "mark-archived",
                    "--batch",
                    batch_id,
                    "--item-id",
                    f"{batch_id}-001",
                    "--archive-ref",
                    "00_anchors/anchor_01.png",
                ]
            ).returncode,
            0,
        )
        self.assertEqual(
            self._run_cli(
                [
                    "mark-archived",
                    "--batch",
                    batch_id,
                    "--item-id",
                    f"{batch_id}-002",
                    "--drive-path",
                    "gdrive:aigc/成图收录/收藏/g_2.png",
                ]
            ).returncode,
            0,
        )

        # Test server 409 checks directly via HubHttpClient before valid ack
        http_client = hub_client.HubHttpClient(self.base_url, DUMMY_AGENT_ID, DUMMY_AGENT_TOKEN)
        with self.assertRaises(hub_client.HttpApiError) as cov_err:
            http_client.post_ack(batch_id, [{"item_id": f"{batch_id}-001", "round": 1, "destination": "archive", "redraw": True, "archive_ref": "x"}])
        self.assertEqual(cov_err.exception.status_code, 409)
        self.assertEqual(cov_err.exception.payload["error"], "items_coverage_mismatch")

        # Now run CLI `ack` -> 200 OK with full `receipt` and physical R2/D1 deletion!
        ack_ok = self._run_cli(["ack", "--batch", batch_id])
        self.assertEqual(ack_ok.returncode, 0, ack_ok.stderr)
        ack_resp = json.loads(ack_ok.stdout)
        self.assertTrue(ack_resp["ok"])
        self.assertEqual(ack_resp["purged_previews"], 4)
        self.assertEqual(
            ack_resp["receipt"],
            {
                "archive": [f"{batch_id}-001", f"{batch_id}-002"],
                "repair": [f"{batch_id}-003"],
                "discard": [f"{batch_id}-004"],
                "redraw": [f"{batch_id}-001"],
            },
        )
        st_404, _ = self._review_request("GET", f"/api/review/batches/{batch_id}")
        self.assertEqual(st_404, 404)

    # ------------------------------------------------------------------
    # (7) `CF-Access-Client-Id` & `CF-Access-Client-Secret` dual header injection
    # ------------------------------------------------------------------
    def test_07_cf_access_service_token_headers_and_isolated_env(self) -> None:
        self.mock_state.require_cf_service_token = True
        img = create_test_png(self.originals_dir / "workers_dev.png")

        # Without CF_ACCESS_CLIENT_ID / SECRET -> rejected at simulated Access edge (403)
        denied = self._run_cli(["push", str(img), "--line", "colab"])
        self.assertNotEqual(denied.returncode, 0)
        self.assertIn("403", denied.stdout + denied.stderr)

        # With isolated `env` dict passed to `hub_client.main(argv, env=...)` (os.environ untouched!)
        isolated_env = {
            "OUTPOST_URL": self.base_url,
            "OUTPOST_AGENT_ID": DUMMY_MUSE_ID,
            "OUTPOST_TOKEN": DUMMY_MUSE_TOKEN,
            "OUTPOST_HOME": str(self.workspace_dir),
            "CF_ACCESS_CLIENT_ID": DUMMY_CF_CLIENT_ID,
            "CF_ACCESS_CLIENT_SECRET": DUMMY_CF_CLIENT_SECRET,
        }
        self.assertNotIn("CF_ACCESS_CLIENT_ID", os.environ)

        with contextlib.redirect_stdout(io.StringIO()):
            rc = hub_client.main(["push", str(img), "--line", "colab"], env=isolated_env)
        self.assertEqual(rc, 0)

        last_hdrs = self.mock_state.observed_agent_headers[-1]
        self.assertEqual(last_hdrs.get("cf-access-client-id"), DUMMY_CF_CLIENT_ID)
        self.assertEqual(last_hdrs.get("cf-access-client-secret"), DUMMY_CF_CLIENT_SECRET)

        # Verify default source mapping `muse-main -> museai`
        muse_batches = hub_client.cmd_batches(
            hub_client.resolve_config(hub_client.build_arg_parser().parse_args(["batches"]), env=isolated_env)
        )
        self.assertEqual(len(muse_batches["batches"]), 1)
        self.assertEqual(muse_batches["batches"][0]["source"], "museai")
        self.assertEqual(muse_batches["batches"][0]["channel_id"], "museai-colab")

    # ------------------------------------------------------------------
    # (8) `cutover_v4_star_scale` mixed old + new ledger parsing
    # ------------------------------------------------------------------
    def test_08_cutover_mixed_legacy_and_v4_ledger_parsing(self) -> None:
        ledger_path = self.workspace_dir / f"ledger-{DUMMY_MUSE_ID}.jsonl"
        old_batch = "20261110-muse-main-01"
        legacy_lines = [
            # Legacy tier=1 ("神图" in old scale) with drive_path -> must map to final_tier=3 + archive_ref!
            {
                "item_id": f"{old_batch}-001",
                "batch_id": old_batch,
                "round": 1,
                "original_path": str(self.originals_dir / "old1.png"),
                "state": "archived",
                "verdict": {"tier": 1, "flags": [], "note": "old 1=god"},
                "drive_path": "AI_Archive/muse-main/old1.png",
                "review_done": True,
            },
            # Legacy tier=3 ("高品质" in old scale) -> must map to final_tier=1!
            {
                "item_id": f"{old_batch}-002",
                "batch_id": old_batch,
                "round": 1,
                "original_path": str(self.originals_dir / "old2.png"),
                "state": "archived",
                "verdict": {"tier": 3, "flags": [], "note": "old 3=1star"},
                "drive_path": "AI_Archive/muse-main/old2.png",
                "review_done": True,
            },
            # Legacy tier=1 + H repair -> must map to destination="repair", intent_tier=3!
            {
                "item_id": f"{old_batch}-003",
                "batch_id": old_batch,
                "round": 1,
                "original_path": str(self.originals_dir / "old3.png"),
                "state": "repair",
                "verdict": {"tier": 1, "flags": ["H"], "note": "old 1+H"},
                "drive_path": None,
                "review_done": True,
            },
        ]
        ledger_path.write_text(
            "\n".join(json.dumps(x) for x in legacy_lines) + "\n",
            encoding="utf-8",
        )

        # Mark cutover via migrate_v4_cutover.py CLI
        mark_proc = self._run_cutover_cli(["mark-ledger", "--ledger", str(ledger_path)])
        self.assertEqual(mark_proc.returncode, 0, mark_proc.stderr)
        self.assertFalse(json.loads(mark_proc.stdout)["already_marked"])

        # Append post-cutover records (tier=3, tier=1, tier=0) WITHOUT needing tier_scale field
        new_batch = "20261119-museai-gpt-01"
        post_lines = [
            {
                "item_id": f"{new_batch}-001",
                "batch_id": new_batch,
                "round": 1,
                "state": "archive",
                "verdict": {"tier": 3, "flags": []},
                "archive_ref": "gdrive:3star.png",
                "review_done": True,
            },
            {
                "item_id": f"{new_batch}-002",
                "batch_id": new_batch,
                "round": 1,
                "state": "archive",
                "verdict": {"tier": 1, "flags": []},
                "archive_ref": "gdrive:1star.png",
                "review_done": True,
            },
            {
                "item_id": f"{new_batch}-003",
                "batch_id": new_batch,
                "round": 1,
                "state": "archive",
                "verdict": {"tier": 0, "flags": []},
                "archive_ref": "gdrive:0star.png",
                "review_done": True,
            },
        ]
        with open(ledger_path, "a", encoding="utf-8") as fh:
            for pl in post_lines:
                fh.write(json.dumps(pl) + "\n")

        ledger = hub_client.Ledger(ledger_path, DUMMY_MUSE_ID)
        old_view = ledger.get_batch_view(old_batch)
        self.assertEqual(old_view.items[(f"{old_batch}-001", 1)]["final_tier"], 3)
        self.assertEqual(
            old_view.items[(f"{old_batch}-001", 1)]["archive_ref"],
            "AI_Archive/muse-main/old1.png",
        )
        self.assertEqual(old_view.items[(f"{old_batch}-002", 1)]["final_tier"], 1)
        self.assertEqual(old_view.items[(f"{old_batch}-003", 1)]["destination"], "repair")
        self.assertEqual(old_view.items[(f"{old_batch}-003", 1)]["intent_tier"], 3)

        new_view = ledger.get_batch_view(new_batch)
        self.assertEqual(new_view.items[(f"{new_batch}-001", 1)]["final_tier"], 3)
        self.assertEqual(new_view.items[(f"{new_batch}-002", 1)]["final_tier"], 1)
        self.assertIs(new_view.items[(f"{new_batch}-003", 1)]["final_tier"], 0)

    # ------------------------------------------------------------------
    # (9) `migrate_v4_cutover.py`: idempotency & `flip-star-table` verification
    # ------------------------------------------------------------------
    def test_09_migrate_v4_cutover_idempotency_and_flip_star_table(self) -> None:
        # 1. mark-ledger idempotency (even if file lacks trailing newline!)
        ledger_p = self.workspace_dir / "ledger-test.jsonl"
        ledger_p.write_text('{"item_id":"x-001","batch_id":"x","round":1,"state":"pushed"}', encoding="utf-8")

        m1 = self._run_cutover_cli(["mark-ledger", "--ledger", str(ledger_p)])
        self.assertEqual(m1.returncode, 0, m1.stderr)
        self.assertFalse(json.loads(m1.stdout)["already_marked"])

        m2 = self._run_cutover_cli(["mark-ledger", "--ledger", str(ledger_p)])
        self.assertEqual(m2.returncode, 0, m2.stderr)
        self.assertTrue(json.loads(m2.stdout)["already_marked"])

        lines = [json.loads(line) for line in ledger_p.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[1]["event"], "cutover_v4_star_scale")

        # 2. flip-star-table on flat dict {id: tier} (--in-place)
        flat_table = self.case_dir / "face_stars_flat.json"
        flat_table.write_text(
            json.dumps({"f1": 1, "f2": 1, "f3": 2, "f4": 3, "f5": 0, "f6": None}),
            encoding="utf-8",
        )
        f_proc = self._run_cutover_cli(["flip-star-table", "--file", str(flat_table), "--in-place"])
        self.assertEqual(f_proc.returncode, 0, f_proc.stderr)
        f_summary = json.loads(f_proc.stdout)
        self.assertEqual(f_summary["before_counts"], {"total": 6, "3": 1, "2": 1, "1": 2, "0": 1, "null": 1})
        self.assertEqual(f_summary["after_counts"], {"total": 6, "3": 2, "2": 1, "1": 1, "0": 1, "null": 1})
        self.assertEqual(
            json.loads(flat_table.read_text(encoding="utf-8")),
            {"f1": 3, "f2": 3, "f3": 2, "f4": 1, "f5": 0, "f6": None},
        )

        # 3. flip-star-table on wrapper object with object list (--output)
        nested_in = self.case_dir / "outfit_stars_nested.json"
        nested_out = self.case_dir / "outfit_stars_flipped.json"
        nested_in.write_text(
            json.dumps(
                {
                    "schema": 1,
                    "items": [
                        {"id": "o1", "star": 1},
                        {"id": "o2", "star": 2},
                        {"id": "o3", "star": 3},
                    ],
                }
            ),
            encoding="utf-8",
        )
        n_proc = self._run_cutover_cli(
            ["flip-star-table", "--file", str(nested_in), "--output", str(nested_out)]
        )
        self.assertEqual(n_proc.returncode, 0, n_proc.stderr)
        flipped_nested = json.loads(nested_out.read_text(encoding="utf-8"))
        self.assertEqual([x["star"] for x in flipped_nested["items"]], [3, 2, 1])

    # ------------------------------------------------------------------
    # (10) Strict `/tmp` and system directory path guard across both CLIs
    # ------------------------------------------------------------------
    def test_10_strict_path_guard_both_clis(self) -> None:
        for bad in (
            "/tmp/outpost-forbidden",
            "/private/tmp/outpost-forbidden",
            "/var/tmp/outpost-forbidden",
            "/etc/outpost-forbidden",
            "/usr/local/outpost-forbidden",
            "/System/Library/Fonts",
            "/Library/Caches/outpost-forbidden",
        ):
            with self.assertRaises(hub_client.PathGuardError):
                hub_client.validate_safe_storage_path(bad)
            with self.assertRaises(migrate_v4_cutover.PathGuardError):
                migrate_v4_cutover.validate_safe_storage_path(bad)

        bad_hub = self._run_cli(["batches", "--workspace-dir", "/tmp/forbidden-ws"])
        self.assertEqual(bad_hub.returncode, 2)

        bad_cutover = self._run_cutover_cli(["mark-ledger", "--ledger", "/tmp/forbidden-ledger.jsonl"])
        self.assertEqual(bad_cutover.returncode, 2)


if __name__ == "__main__":
    unittest.main()
