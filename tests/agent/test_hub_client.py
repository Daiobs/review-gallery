#!/usr/bin/env python3
"""Comprehensive offline test suite for agent/hub_client.py (Python 3.9+ compatible).

Covers:
1. Ledger written & fsynced BEFORE HTTP push (verified mid-request & on HTTP 500 failure).
2. 25-image push auto-chunked as 10+10+5 + automatic retry of simulated rejected item.
3. `ack` rejected when `review_done=false`, plus `review_done` revoke (`false`) & `pull --watch`.
4. `pull` with all Rule 3 bucket combinations (H/F/O -> repair preserving tier, R -> redraw &
   consecutive MAX_REDRAW_ROUNDS stop, 1/2/3 -> archived, null -> _trash + >7d trash purge).
5. Server `ack` 409 on tampered counts without deleting R2/D1 batch.
6. `connector` mode pre-ack local ledger safety gate blocking `ack` until `mark-archived` backfill.
7. `mount` mode full automatic archive (`ai_archive` AND `aigc_tier`), `ack`, and ledger backup.
8. `rclone` mode end-to-end using an executable mock `rclone` Python script.
9. `round+1` cross-batch repair re-push (`--repush-item` and `--repush-map`) keeping `item_id`.
10. Strict `/tmp` and system directory path guard rejection + Spec §11 auth checks (401/403).

All test sandboxes reside strictly under:
  .test-sandboxes/agent/
"""

from __future__ import annotations

import email.parser
import email.policy
import hashlib
import hmac
import http.server
import io
import json
import os
import shutil
import stat
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
SANDBOX_ROOT = REPO_ROOT / ".test-sandboxes" / "agent"

if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import hub_client  # noqa: E402


DUMMY_AGENT_ID = "muse-main"
DUMMY_AGENT_TOKEN = "test-only-dummy-agent-token-0001"
DUMMY_OTHER_AGENT_ID = "argon-mac"
DUMMY_OTHER_TOKEN = "test-only-dummy-agent-token-0002"
DUMMY_ACCESS_JWT = "test-only-dummy-cf-access-jwt-assertion"


def create_test_png(path: Path, size: Tuple[int, int] = (320, 240), color: Tuple[int, int, int] = (40, 120, 200)) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", size, color=color)
    img.save(path, format="PNG")
    return path


class OutpostMockState:
    """Thread-safe in-memory simulation of Worker D1 + R2 + Auth."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.agent_tokens: Dict[str, str] = {
            DUMMY_AGENT_ID: DUMMY_AGENT_TOKEN,
            DUMMY_OTHER_AGENT_ID: DUMMY_OTHER_TOKEN,
        }
        self.valid_access_jwt: str = DUMMY_ACCESS_JWT
        self.batches: Dict[str, Dict[str, Any]] = {}
        self.verdicts: Dict[Tuple[str, int], Dict[str, Any]] = {}
        self.r2_objects: Dict[str, bytes] = {}

        # Test instrumentation & fault injection hooks
        self.push_chunk_sizes: List[int] = []
        self.ack_http_calls: int = 0
        self.fail_next_push_count: int = 0
        self.reject_once_item_ids: Set[str] = set()
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
            "archived": 0,
            "repair": 0,
            "redraw": 0,
            "discarded": 0,
        }
        for row in rows:
            b = hub_client.classify_bucket(row["tier"], row["flags"])
            counts[b] += 1
        return counts


class OutpostMockHandler(http.server.BaseHTTPRequestHandler):
    server_version = "MockOutpostWorker/4.0"

    @property
    def state(self) -> OutpostMockState:
        return self.server.mock_state  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep unit test output clean
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

    def _send_bytes(self, status: int, data: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Robots-Tag", "noindex, nofollow, noarchive")
        self.send_header("Cache-Control", "private, no-store")
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or "0")
        return self.rfile.read(length) if length > 0 else b""

    def _require_agent_auth(self) -> Optional[str]:
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

    def _parse_multipart(self, content_type: str, body: bytes) -> Tuple[Dict[str, bytes], Dict[str, Tuple[Optional[str], str, bytes]]]:
        wire = (
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
            + body
        )
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
                items = [
                    {
                        "item_id": v["item_id"],
                        "round": v["round"],
                        "tier": v["tier"],
                        "flags": list(v["flags"]),
                        "note": v["note"],
                        "judged_at": v["judged_at"],
                    }
                    for _, v in sorted(self.state.verdicts.items(), key=lambda kv: (kv[0][0], kv[0][1]))
                    if v["batch_id"] == batch_id
                ]
                self._send_json(
                    200,
                    {
                        "batch_id": batch_id,
                        "review_done": bool(batch["review_done"]),
                        "counts": counts,
                        "items": items,
                    },
                )
            return

        # All static and /api/review/* routes require Cloudflare Access JWT
        if not self._require_access_jwt():
            return

        if path in ("/", "/index.html"):
            html = b'<!doctype html><html><head><meta name="robots" content="noindex"></head><body>Outpost</body></html>'
            self._send_bytes(200, html, "text/html; charset=utf-8")
            return

        if path == "/app.js":
            self._send_bytes(200, b"console.log('outpost');", "application/javascript")
            return

        if path == "/api/review/batches":
            with self.state.lock:
                out = []
                for bid, b in self.state.batches.items():
                    out.append(
                        {
                            "batch_id": bid,
                            "agent_id": b["agent_id"],
                            "pushed_count": b["pushed_count"],
                            "review_done": bool(b["review_done"]),
                            "counts": self.state.compute_batch_counts(bid),
                        }
                    )
            self._send_json(200, {"batches": out})
            return

        if path.startswith("/api/review/batches/"):
            batch_id = path[len("/api/review/batches/") :]
            with self.state.lock:
                batch = self.state.batches.get(batch_id)
                if batch is None:
                    self._send_json(404, {"error": "batch_not_found"})
                    return
                items = [
                    dict(v, bucket=hub_client.classify_bucket(v["tier"], v["flags"]))
                    for _, v in sorted(self.state.verdicts.items())
                    if v["batch_id"] == batch_id
                ]
                self._send_json(200, {"batch": dict(batch), "items": items})
            return

        if path.startswith("/api/review/previews/"):
            parts = path[len("/api/review/previews/") :].split("/")
            if len(parts) != 3:
                self._send_json(400, {"error": "bad_preview_path"})
                return
            batch_id, item_id, round_str = parts
            with self.state.lock:
                batch = self.state.batches.get(batch_id)
                if batch is None:
                    self._send_json(404, {"error": "batch_not_found"})
                    return
                r2_key = f"previews/{batch['agent_id']}/{batch_id}/{item_id}_r{int(round_str)}.webp"
                blob = self.state.r2_objects.get(r2_key)
                if blob is None:
                    self._send_json(404, {"error": "preview_not_found"})
                    return
            self._send_bytes(200, blob, "image/webp")
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
            ctype = self.headers.get("Content-Type") or ""
            fields, files = self._parse_multipart(ctype, body)
            manifest = json.loads(fields["manifest"].decode("utf-8"))

            if self.state.on_push_arrival is not None:
                self.state.on_push_arrival(manifest)

            with self.state.lock:
                if self.state.fail_next_push_count > 0:
                    self.state.fail_next_push_count -= 1
                    self._send_json(500, {"error": "simulated_internal_error"})
                    return

                if manifest.get("agent_id") != authed:
                    self._send_json(403, {"error": "manifest_agent_mismatch"})
                    return

                batch_id = manifest["batch_id"]
                existing_batch = self.state.batches.get(batch_id)
                if existing_batch is not None:
                    if existing_batch["agent_id"] != authed:
                        self._send_json(403, {"error": "batch_owner_mismatch"})
                        return
                    if existing_batch["review_done"]:
                        self._send_json(409, {"error": "review_already_done"})
                        return
                else:
                    self.state.batches[batch_id] = {
                        "batch_id": batch_id,
                        "agent_id": authed,
                        "pushed_count": 0,
                        "review_done": 0,
                        "created_at": hub_client.now_utc_iso(),
                    }

                m_items = manifest.get("items") or []
                self.state.push_chunk_sizes.append(len(m_items))

                accepted: List[str] = []
                rejected: List[Dict[str, str]] = []

                for m_it in m_items:
                    iid = m_it["item_id"]
                    rnd = int(m_it["round"])

                    should_reject_once = iid in self.state.reject_once_item_ids or any(
                        iid.endswith(sfx) for sfx in self.state.reject_once_suffixes
                    )
                    if should_reject_once and iid not in self.state._already_rejected_once:
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
                        if verify_img.format != "WEBP":
                            rejected.append({"item_id": iid, "reason": "not_webp"})
                            continue
                        if verify_img.size != (int(m_it["width"]), int(m_it["height"])):
                            rejected.append({"item_id": iid, "reason": "dimension_mismatch"})
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
            batch_id = payload["batch_id"]
            recv_counts = payload["counts"]

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

                cloud_counts = self.state.compute_batch_counts(batch_id)
                recv_sum = (
                    int(recv_counts.get("archived", -1))
                    + int(recv_counts.get("repair", -1))
                    + int(recv_counts.get("redraw", -1))
                    + int(recv_counts.get("discarded", -1))
                )
                counts_match = (
                    recv_sum == int(recv_counts.get("pushed", -2)) == cloud_counts["pushed"]
                    and all(int(recv_counts.get(k, -1)) == cloud_counts[k] for k in cloud_counts)
                )
                if not counts_match:
                    self._send_json(
                        409,
                        {
                            "error": "counts_mismatch",
                            "cloud_counts": cloud_counts,
                            "received_counts": recv_counts,
                        },
                    )
                    return

                prefix = f"previews/{authed}/{batch_id}/"
                keys_to_delete = [k for k in self.state.r2_objects if k.startswith(prefix)]
                for k in keys_to_delete:
                    del self.state.r2_objects[k]

                verdict_keys = [
                    k for k, v in self.state.verdicts.items() if v["batch_id"] == batch_id
                ]
                for vk in verdict_keys:
                    del self.state.verdicts[vk]
                del self.state.batches[batch_id]

                self._send_json(
                    200,
                    {
                        "ok": True,
                        "batch_id": batch_id,
                        "deleted_previews": len(keys_to_delete),
                        "counts": cloud_counts,
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
                batch["review_done"] = 1 if payload.get("review_done") else 0
                self._send_json(200, {"batch": dict(batch)})
            return

        self._send_json(404, {"error": "not_found"})

    def do_PATCH(self) -> None:
        if not self._require_access_jwt():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body = self._read_body()

        # PATCH /api/review/batches/<batchId>/items/<itemId>/<round>
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
                    row["tier"] = patch["tier"]
                if "flags" in patch:
                    row["flags"] = list(patch["flags"])
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

    def __init__(self, addr: Tuple[str, int], handler_cls: Any, mock_state: OutpostMockState) -> None:
        super().__init__(addr, handler_cls)
        self.mock_state = mock_state


class HubClientOfflineTestSuite(unittest.TestCase):
    def setUp(self) -> None:
        SANDBOX_ROOT.mkdir(parents=True, exist_ok=True)
        self.case_dir = SANDBOX_ROOT / self._testMethodName
        if self.case_dir.exists():
            shutil.rmtree(self.case_dir)
        self.case_dir.mkdir(parents=True, exist_ok=True)

        self.workspace_dir = self.case_dir / "workspace"
        self.originals_dir = self.case_dir / "originals"
        self.mount_dir = self.case_dir / "gdrive_mount"
        self.workspace_dir.mkdir(parents=True, exist_ok=True)
        self.originals_dir.mkdir(parents=True, exist_ok=True)
        self.mount_dir.mkdir(parents=True, exist_ok=True)

        self.mock_state = OutpostMockState()
        self.httpd = ThreadedMockServer(("127.0.0.1", 0), OutpostMockHandler, self.mock_state)
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
        env.update(
            {
                "OUTPOST_URL": self.base_url,
                "OUTPOST_AGENT_ID": DUMMY_AGENT_ID,
                "OUTPOST_TOKEN": DUMMY_AGENT_TOKEN,
                "OUTPOST_HOME": str(self.workspace_dir),
                "ARCHIVE_MODE": "connector",
                "ARCHIVE_LAYOUT": "ai_archive",
            }
        )
        for k in ("DRIVE_MOUNT_ROOT", "RCLONE_REMOTE", "RCLONE_BIN", "MAX_REDRAW_ROUNDS"):
            env.pop(k, None)
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
    # (1) Ledger written & fsynced BEFORE HTTP push
    # ------------------------------------------------------------------
    def test_01_ledger_written_before_http_push(self) -> None:
        img_path = create_test_png(self.originals_dir / "shot_01.png", size=(640, 480))
        (self.originals_dir / "shot_01.txt").write_text("masterpiece, aurora sky", encoding="utf-8")

        ledger_seen_during_request: List[Dict[str, Any]] = []

        def inspect_ledger_on_arrival(_manifest: Dict[str, Any]) -> None:
            ledger_seen_during_request.extend(self._read_ledger_lines())

        self.mock_state.on_push_arrival = inspect_ledger_on_arrival
        self.mock_state.fail_next_push_count = 1

        proc = self._run_cli(["push", str(img_path), "--batch", "20261113-muse-main-01"])
        self.assertNotEqual(proc.returncode, 0, "Push must fail when server returns HTTP 500")

        # Verify ledger was ALREADY on disk while HTTP request was in flight!
        self.assertEqual(len(ledger_seen_during_request), 1)
        in_flight_entry = ledger_seen_during_request[0]
        self.assertEqual(in_flight_entry["state"], "pushed")
        self.assertEqual(in_flight_entry["item_id"], "20261113-muse-main-01-001")
        self.assertEqual(in_flight_entry["original_path"], str(img_path))
        self.assertTrue(len(in_flight_entry["preview_sha256"]) == 64)

        # And after HTTP failure, ledger entry remains durably on disk while cloud has 0 rows
        after_lines = self._read_ledger_lines()
        self.assertEqual(len(after_lines), 1)
        self.assertEqual(after_lines[0]["state"], "pushed")
        self.assertEqual(len(self.mock_state.batches), 0)
        self.assertEqual(len(self.mock_state.r2_objects), 0)

    # ------------------------------------------------------------------
    # (2) 25 images auto-chunked as 10+10+5 + retry of rejected item
    # ------------------------------------------------------------------
    def test_02_chunking_25_images_and_rejected_item_retry(self) -> None:
        for idx in range(1, 26):
            w = 300 + (idx * 4)
            h = 200 + (idx * 6)
            create_test_png(self.originals_dir / f"img_{idx:03d}.png", size=(w, h))
            (self.originals_dir / f"img_{idx:03d}.txt").write_text(f"prompt #{idx}", encoding="utf-8")

        # Simulate transient rejection on item -005 in chunk 1
        self.mock_state.reject_once_suffixes.add("-005")

        proc = self._run_cli(["push", str(self.originals_dir)])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)

        self.assertEqual(out["pushed_count"], 25)
        self.assertEqual(len(out["accepted"]), 25)
        self.assertEqual(out["rejected"], [])
        self.assertEqual(out["chunks"], 3)

        # Chunk 1 (10) -> retry of -005 (1) -> Chunk 2 (10) -> Chunk 3 (5)
        self.assertEqual(self.mock_state.push_chunk_sizes, [10, 1, 10, 5])
        self.assertEqual(len(self.mock_state.r2_objects), 25)

        # Verify page & batch metadata via Access-authenticated review endpoint
        status, batch_detail = self._review_request("GET", f"/api/review/batches/{out['batch_id']}")
        self.assertEqual(status, 200)
        self.assertEqual(len(batch_detail["items"]), 25)
        first_item = batch_detail["items"][0]
        self.assertEqual((first_item["width"], first_item["height"]), (304, 206))

    # ------------------------------------------------------------------
    # (3) `ack` rejected when review_done=false + revoke + pull --watch
    # ------------------------------------------------------------------
    def test_03_ack_rejected_before_review_done_and_revoke_flow(self) -> None:
        for idx in range(1, 3):
            create_test_png(self.originals_dir / f"p_{idx}.png")

        push_proc = self._run_cli(["push", str(self.originals_dir), "--batch", "20261113-muse-main-03"])
        self.assertEqual(push_proc.returncode, 0, push_proc.stderr)
        batch_id = "20261113-muse-main-03"

        # Non-watch pull while review_done=false is read-only
        pull_early = self._run_cli(["pull", "--batch", batch_id])
        self.assertEqual(pull_early.returncode, 0)
        early_data = json.loads(pull_early.stdout)
        self.assertFalse(early_data["review_done"])

        # CLI ack is rejected before review_done=true
        ack_early = self._run_cli(["ack", "--batch", batch_id])
        self.assertNotEqual(ack_early.returncode, 0)
        self.assertIn("review_not_done", ack_early.stdout + ack_early.stderr)

        # Direct HTTP POST /api/agent/ack also returns 409 review_not_done
        http_client = hub_client.HubHttpClient(self.base_url, DUMMY_AGENT_ID, DUMMY_AGENT_TOKEN)
        with self.assertRaises(hub_client.HttpApiError) as ctx:
            http_client.post_ack(
                batch_id,
                {"pushed": 2, "archived": 0, "repair": 0, "redraw": 0, "discarded": 2},
            )
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(ctx.exception.payload["error"], "review_not_done")

        # Mark item 1 tier=1, mark review_done=true, verify PATCH locked (409), then revoke review_done=false
        st, _ = self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_id}/items/{batch_id}-001/1",
            {"tier": 1, "flags": [], "note": "initial"},
        )
        self.assertEqual(st, 200)

        st, _ = self._review_request("POST", f"/api/review/batches/{batch_id}/done", {"review_done": True})
        self.assertEqual(st, 200)

        st_locked, locked_body = self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_id}/items/{batch_id}-001/1",
            {"tier": 2},
        )
        self.assertEqual(st_locked, 409)
        self.assertEqual(locked_body["error"], "batch_locked")

        # Revoke review_done -> unlock -> edit -> set review_done=true in background for pull --watch
        st_rev, _ = self._review_request("POST", f"/api/review/batches/{batch_id}/done", {"review_done": False})
        self.assertEqual(st_rev, 200)
        st_edit, _ = self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_id}/items/{batch_id}-001/1",
            {"tier": 2, "flags": ["H"], "note": "fix hand after revoke"},
        )
        self.assertEqual(st_edit, 200)

        def delayed_done() -> None:
            time.sleep(0.12)
            self._review_request("POST", f"/api/review/batches/{batch_id}/done", {"review_done": True})

        t = threading.Thread(target=delayed_done, daemon=True)
        t.start()

        watch_proc = self._run_cli(["pull", "--watch", "--interval", "0.05", "--max-polls", "20", "--batch", batch_id])
        t.join(timeout=2.0)
        self.assertEqual(watch_proc.returncode, 0, watch_proc.stderr)
        watch_data = json.loads(watch_proc.stdout)
        self.assertTrue(watch_data["review_done"])
        self.assertEqual(watch_data["counts"]["repair"], 1)
        self.assertEqual(watch_data["counts"]["discarded"], 1)

    # ------------------------------------------------------------------
    # (4) Rule 3 priority, consecutive redraw stop, and >7d _trash purge
    # ------------------------------------------------------------------
    def test_04_pull_rule3_buckets_redraw_stop_and_trash_purge(self) -> None:
        # Plant old (>8d) and fresh (1d) files in _trash
        old_trash_dir = self.workspace_dir / "_trash" / "20261101-muse-main-01"
        old_trash_dir.mkdir(parents=True, exist_ok=True)
        stale_file = old_trash_dir / "stale.png"
        fresh_file = old_trash_dir / "fresh.png"
        stale_file.write_bytes(b"stale")
        fresh_file.write_bytes(b"fresh")
        now_ts = time.time()
        os.utime(stale_file, (now_ts - 8 * 86400, now_ts - 8 * 86400))
        os.utime(fresh_file, (now_ts - 1 * 86400, now_ts - 1 * 86400))

        imgs = [create_test_png(self.originals_dir / f"case_{i}.png") for i in range(1, 5)]
        batch_id = "20261113-muse-main-04"
        env_redraw_2 = {"MAX_REDRAW_ROUNDS": "2"}

        p_res = self._run_cli(["push", str(self.originals_dir), "--batch", batch_id], extra_env=env_redraw_2)
        self.assertEqual(p_res.returncode, 0, p_res.stderr)

        # Item 1: tier=1 + H -> repair (preserving tier=1 in verdict!)
        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_id}/items/{batch_id}-001/1",
            {"tier": 1, "flags": ["H", "R"], "note": "great composition, fix thumb"},
        )
        # Item 2: tier=1 + R (no H/F/O) -> redraw (consecutive_redraws = 1 < 2)
        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_id}/items/{batch_id}-002/1",
            {"tier": 1, "flags": ["R"], "note": "pose broken"},
        )
        # Item 3: tier=2 -> archived (drive_path remains None)
        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_id}/items/{batch_id}-003/1",
            {"tier": 2, "flags": [], "note": ""},
        )
        # Item 4: tier=None, flags=[] -> discarded -> moved to _trash/<batch_id>/
        self._review_request("POST", f"/api/review/batches/{batch_id}/done", {"review_done": True})

        pull_proc = self._run_cli(["pull", "--batch", batch_id], extra_env=env_redraw_2)
        self.assertEqual(pull_proc.returncode, 0, pull_proc.stderr)
        pulled = json.loads(pull_proc.stdout)
        self.assertEqual(
            pulled["counts"],
            {"pushed": 4, "archived": 1, "repair": 1, "redraw": 1, "discarded": 1},
        )
        self.assertEqual(pulled["trash_purged_count"], 1)
        self.assertFalse(stale_file.exists(), ">7d trash file must be purged")
        self.assertTrue(fresh_file.exists(), "<7d trash file must be retained")

        # Original of discarded item 4 moved into _trash/<batch_id>/
        self.assertFalse(imgs[3].exists())
        trashed_copy = self.workspace_dir / "_trash" / batch_id / "case_4.png"
        self.assertTrue(trashed_copy.is_file())

        # Inspect ledger state details
        ledger = hub_client.Ledger(self.workspace_dir / f"ledger-{DUMMY_AGENT_ID}.jsonl", DUMMY_AGENT_ID)
        bview = ledger.get_batch_view(batch_id)

        rep_entry = bview.items[(f"{batch_id}-001", 1)]
        self.assertEqual(rep_entry["state"], "repair")
        self.assertEqual(rep_entry["verdict"]["tier"], 1)

        red_entry = bview.items[(f"{batch_id}-002", 1)]
        self.assertEqual(red_entry["state"], "redraw")
        self.assertEqual(red_entry["consecutive_redraws"], 1)
        self.assertFalse(red_entry["redraw_stopped"])

        arch_entry = bview.items[(f"{batch_id}-003", 1)]
        self.assertEqual(arch_entry["state"], "archived")
        self.assertIsNone(arch_entry["drive_path"])

        # Second consecutive R redraw reaches MAX_REDRAW_ROUNDS=2 -> stop_reason="max_redraw_exceeded"
        redraw_img_2 = create_test_png(self.case_dir / "redrawn_v2.png")
        batch_r2 = "20261113-muse-main-05"
        p_r2 = self._run_cli(
            ["push", str(redraw_img_2), "--batch", batch_r2, "--redraw-from", f"{batch_id}-002"],
            extra_env=env_redraw_2,
        )
        self.assertEqual(p_r2.returncode, 0, p_r2.stderr)
        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_r2}/items/{batch_r2}-001/1",
            {"tier": None, "flags": ["R"], "note": "still broken"},
        )
        self._review_request("POST", f"/api/review/batches/{batch_r2}/done", {"review_done": True})

        pull_r2 = self._run_cli(["pull", "--batch", batch_r2], extra_env=env_redraw_2)
        self.assertEqual(pull_r2.returncode, 0, pull_r2.stderr)

        bview_r2 = ledger.get_batch_view(batch_r2)
        stopped_entry = bview_r2.items[(f"{batch_r2}-001", 1)]
        self.assertTrue(stopped_entry["redraw_stopped"])
        self.assertEqual(stopped_entry["consecutive_redraws"], 2)
        self.assertEqual(stopped_entry["stop_reason"], "max_redraw_exceeded")
        self.assertEqual(stopped_entry["reason"], "max_redraw_exceeded")

        # Attempting a 3rd redraw from the same lineage must be blocked!
        redraw_img_3 = create_test_png(self.case_dir / "redrawn_v3.png")
        p_r3 = self._run_cli(
            ["push", str(redraw_img_3), "--batch", "20261113-muse-main-06", "--redraw-from", f"{batch_id}-002"],
            extra_env=env_redraw_2,
        )
        self.assertNotEqual(p_r3.returncode, 0)
        self.assertIn("MAX_REDRAW_ROUNDS", p_r3.stdout + p_r3.stderr)

    # ------------------------------------------------------------------
    # (5) Server `ack` 409 on tampered counts
    # ------------------------------------------------------------------
    def test_05_server_ack_409_on_tampered_counts(self) -> None:
        for i in range(1, 4):
            create_test_png(self.originals_dir / f"t_{i}.png")
        batch_id = "20261113-muse-main-07"
        self.assertEqual(self._run_cli(["push", str(self.originals_dir), "--batch", batch_id]).returncode, 0)

        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_id}/items/{batch_id}-001/1",
            {"tier": 1, "flags": []},
        )
        self._review_request("POST", f"/api/review/batches/{batch_id}/done", {"review_done": True})

        http_client = hub_client.HubHttpClient(self.base_url, DUMMY_AGENT_ID, DUMMY_AGENT_TOKEN)
        # Tampered counts: sum matches pushed=3, but archived=2 instead of 1
        with self.assertRaises(hub_client.HttpApiError) as ctx:
            http_client.post_ack(
                batch_id,
                {"pushed": 3, "archived": 2, "repair": 0, "redraw": 0, "discarded": 1},
            )
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(ctx.exception.payload["error"], "counts_mismatch")
        self.assertEqual(
            ctx.exception.payload["cloud_counts"],
            {"pushed": 3, "archived": 1, "repair": 0, "redraw": 0, "discarded": 2},
        )
        # Verify batch was NOT deleted from D1 or R2
        self.assertIn(batch_id, self.mock_state.batches)
        self.assertEqual(len(self.mock_state.r2_objects), 3)

    # ------------------------------------------------------------------
    # (6) `connector` mode pre-ack safety gate & `mark-archived` backfill
    # ------------------------------------------------------------------
    def test_06_connector_mode_ack_gate_and_mark_archived_backfill(self) -> None:
        for i in range(1, 3):
            create_test_png(self.originals_dir / f"conn_{i}.png")
            (self.originals_dir / f"conn_{i}.txt").write_text(f"connector prompt {i}", encoding="utf-8")

        batch_id = "20261113-muse-main-08"
        self.assertEqual(self._run_cli(["push", str(self.originals_dir), "--batch", batch_id]).returncode, 0)

        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_id}/items/{batch_id}-001/1",
            {"tier": 1, "flags": []},
        )
        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_id}/items/{batch_id}-002/1",
            {"tier": 3, "flags": []},
        )
        self._review_request("POST", f"/api/review/batches/{batch_id}/done", {"review_done": True})
        self.assertEqual(self._run_cli(["pull", "--batch", batch_id]).returncode, 0)

        # Generate archive-plan JSON in connector mode
        plan_proc = self._run_cli(["archive-plan", "--batch", batch_id])
        self.assertEqual(plan_proc.returncode, 0, plan_proc.stderr)
        plan = json.loads(plan_proc.stdout)
        self.assertEqual(len(plan["items"]), 2)
        self.assertEqual(
            plan["items"][0]["target_drive_path"],
            f"AI_Archive/{DUMMY_AGENT_ID}/{batch_id}/conn_1.png",
        )
        self.assertEqual(
            plan["items"][0]["prompt_target_drive_path"],
            f"AI_Archive/{DUMMY_AGENT_ID}/{batch_id}/conn_1.txt",
        )

        # Attempting ack BEFORE drive_path backfill MUST be blocked locally with 0 HTTP ack calls!
        ack_blocked = self._run_cli(["ack", "--batch", batch_id])
        self.assertEqual(ack_blocked.returncode, 2)
        blocked_json = json.loads(ack_blocked.stdout)
        self.assertEqual(blocked_json["error"], "ack_blocked_by_ledger_gate")
        self.assertEqual(len(blocked_json["pending_uploads"]), 2)
        self.assertEqual(self.mock_state.ack_http_calls, 0, "Local gate must prevent HTTP ack call!")

        # Backfill item 1 via CLI flags, still 1 item missing -> still blocked!
        m1 = self._run_cli(
            [
                "mark-archived",
                "--batch",
                batch_id,
                "--item-id",
                f"{batch_id}-001",
                "--drive-path",
                plan["items"][0]["target_drive_path"],
            ]
        )
        self.assertEqual(m1.returncode, 0, m1.stderr)
        ack_blocked_2 = self._run_cli(["ack", "--batch", batch_id])
        self.assertEqual(ack_blocked_2.returncode, 2)
        self.assertEqual(len(json.loads(ack_blocked_2.stdout)["pending_uploads"]), 1)

        # Backfill remaining item via --from-json file (flat dict {item_id: drive_path})
        backfill_file = self.case_dir / "backfill.json"
        backfill_file.write_text(
            json.dumps({f"{batch_id}-002": plan["items"][1]["target_drive_path"]}),
            encoding="utf-8",
        )
        m2 = self._run_cli(["mark-archived", "--batch", batch_id, "--from-json", str(backfill_file)])
        self.assertEqual(m2.returncode, 0, m2.stderr)

        # Now ack succeeds and physically deletes R2 objects + D1 rows!
        ack_ok = self._run_cli(["ack", "--batch", batch_id])
        self.assertEqual(ack_ok.returncode, 0, ack_ok.stderr)
        self.assertEqual(self.mock_state.ack_http_calls, 1)
        self.assertEqual(len(self.mock_state.r2_objects), 0)
        st_404, _ = self._review_request("GET", f"/api/review/batches/{batch_id}")
        self.assertEqual(st_404, 404)

    # ------------------------------------------------------------------
    # (7) `mount` mode full automatic archive (`ai_archive` & `aigc_tier`) + ledger backup
    # ------------------------------------------------------------------
    def test_07_mount_mode_full_auto_archive_both_layouts_and_backup(self) -> None:
        # Part A: ai_archive layout via `pull --auto`
        img_a = create_test_png(self.originals_dir / "mount_a.png")
        (self.originals_dir / "mount_a.txt").write_text("aurora borealis, 8k", encoding="utf-8")
        batch_a = "20261113-muse-main-09"

        mount_env_ai = {
            "ARCHIVE_MODE": "mount",
            "ARCHIVE_LAYOUT": "ai_archive",
            "DRIVE_MOUNT_ROOT": str(self.mount_dir),
        }
        self.assertEqual(
            self._run_cli(["push", str(img_a), "--batch", batch_a], extra_env=mount_env_ai).returncode,
            0,
        )
        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_a}/items/{batch_a}-001/1",
            {"tier": 1, "flags": []},
        )
        self._review_request("POST", f"/api/review/batches/{batch_a}/done", {"review_done": True})

        auto_proc = self._run_cli(["pull", "--batch", batch_a, "--auto"], extra_env=mount_env_ai)
        self.assertEqual(auto_proc.returncode, 0, auto_proc.stderr)

        archived_img_a = self.mount_dir / "AI_Archive" / DUMMY_AGENT_ID / batch_a / "mount_a.png"
        archived_txt_a = self.mount_dir / "AI_Archive" / DUMMY_AGENT_ID / batch_a / "mount_a.txt"
        ledger_backup_ai = self.mount_dir / "AI_Archive" / f"ledger-{DUMMY_AGENT_ID}.jsonl"
        self.assertTrue(archived_img_a.is_file())
        self.assertTrue(archived_txt_a.is_file())
        self.assertEqual(archived_txt_a.read_text(encoding="utf-8"), "aurora borealis, 8k")
        self.assertTrue(ledger_backup_ai.is_file())
        self.assertIn("batch_acked", ledger_backup_ai.read_text(encoding="utf-8"))
        self.assertNotIn(batch_a, self.mock_state.batches)

        # Part B: aigc_tier layout with inline --prompt materialization via `archive-plan --execute`
        img_b1 = create_test_png(self.case_dir / "tier_s.png")
        img_b2 = create_test_png(self.case_dir / "tier_h.png")
        batch_b = "20261113-muse-main-10"
        mount_env_tier = {
            "ARCHIVE_MODE": "mount",
            "ARCHIVE_LAYOUT": "aigc_tier",
            "DRIVE_MOUNT_ROOT": str(self.mount_dir),
        }
        self.assertEqual(
            self._run_cli(
                ["push", str(img_b1), str(img_b2), "--batch", batch_b, "--prompt", "inline neon city"],
                extra_env=mount_env_tier,
            ).returncode,
            0,
        )
        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_b}/items/{batch_b}-001/1",
            {"tier": 1, "flags": []},
        )
        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_b}/items/{batch_b}-002/1",
            {"tier": 2, "flags": []},
        )
        self._review_request("POST", f"/api/review/batches/{batch_b}/done", {"review_done": True})

        exec_proc = self._run_cli(
            ["archive-plan", "--batch", batch_b, "--execute"],
            extra_env=mount_env_tier,
        )
        self.assertEqual(exec_proc.returncode, 0, exec_proc.stderr)

        tier1_img = self.mount_dir / "aigc" / "成图收录" / "20261113" / "1-神图" / "tier_s.png"
        tier1_txt = self.mount_dir / "aigc" / "成图收录" / "20261113" / "1-神图" / "tier_s.txt"
        tier2_img = self.mount_dir / "aigc" / "成图收录" / "20261113" / "2-心动" / "tier_h.png"
        ledger_backup_tier = self.mount_dir / "aigc" / "成图收录" / f"ledger-{DUMMY_AGENT_ID}.jsonl"
        self.assertTrue(tier1_img.is_file())
        self.assertEqual(tier1_txt.read_text(encoding="utf-8"), "inline neon city")
        self.assertTrue(tier2_img.is_file())
        self.assertTrue(ledger_backup_tier.is_file())
        self.assertNotIn(batch_b, self.mock_state.batches)

    # ------------------------------------------------------------------
    # (8) `rclone` mode end-to-end with executable mock `rclone` script
    # ------------------------------------------------------------------
    def test_08_rclone_mode_end_to_end_with_mock_executable(self) -> None:
        rclone_dest_root = self.case_dir / "simulated_rclone_cloud"
        rclone_log_file = self.case_dir / "rclone_calls.jsonl"
        mock_rclone_bin = self.case_dir / "bin" / "mock_rclone.py"
        mock_rclone_bin.parent.mkdir(parents=True, exist_ok=True)

        mock_script = (
            f"#!{sys.executable}\n"
            "import json, os, shutil, sys\n"
            "from pathlib import Path\n"
            f"DEST_ROOT = Path({str(rclone_dest_root)!r})\n"
            f"LOG_FILE = Path({str(rclone_log_file)!r})\n"
            "args = sys.argv[1:]\n"
            "with open(LOG_FILE, 'a', encoding='utf-8') as lf:\n"
            "    lf.write(json.dumps(args, ensure_ascii=False) + '\\n')\n"
            "if len(args) != 3 or args[0] != 'copyto':\n"
            "    sys.exit(2)\n"
            "src, remote_spec = args[1], args[2]\n"
            "if not remote_spec.startswith('gdrive:'):\n"
            "    sys.exit(3)\n"
            "rel = remote_spec[len('gdrive:'):]\n"
            "out = DEST_ROOT / rel\n"
            "out.parent.mkdir(parents=True, exist_ok=True)\n"
            "shutil.copy2(src, out)\n"
        )
        mock_rclone_bin.write_text(mock_script, encoding="utf-8")
        mock_rclone_bin.chmod(mock_rclone_bin.stat().st_mode | stat.S_IXUSR)

        img = create_test_png(self.originals_dir / "cloud_vm.png")
        (self.originals_dir / "cloud_vm.txt").write_text("cyberpunk lighthouse", encoding="utf-8")
        batch_id = "20261113-muse-main-11"

        rclone_env = {
            "ARCHIVE_MODE": "rclone",
            "ARCHIVE_LAYOUT": "ai_archive",
            "RCLONE_REMOTE": "gdrive:",
            "RCLONE_BIN": str(mock_rclone_bin),
        }
        self.assertEqual(
            self._run_cli(["push", str(img), "--batch", batch_id], extra_env=rclone_env).returncode,
            0,
        )
        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_id}/items/{batch_id}-001/1",
            {"tier": 2, "flags": []},
        )
        self._review_request("POST", f"/api/review/batches/{batch_id}/done", {"review_done": True})

        run_proc = self._run_cli(["archive", "--batch", batch_id], extra_env=rclone_env)
        self.assertEqual(run_proc.returncode, 0, run_proc.stderr)

        calls = [
            json.loads(line)
            for line in rclone_log_file.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[0][0], "copyto")
        self.assertEqual(calls[0][2], f"gdrive:AI_Archive/{DUMMY_AGENT_ID}/{batch_id}/cloud_vm.png")
        self.assertEqual(calls[1][2], f"gdrive:AI_Archive/{DUMMY_AGENT_ID}/{batch_id}/cloud_vm.txt")
        self.assertEqual(calls[2][2], f"gdrive:AI_Archive/ledger-{DUMMY_AGENT_ID}.jsonl")

        self.assertTrue((rclone_dest_root / "AI_Archive" / DUMMY_AGENT_ID / batch_id / "cloud_vm.png").is_file())
        self.assertTrue((rclone_dest_root / "AI_Archive" / DUMMY_AGENT_ID / batch_id / "cloud_vm.txt").is_file())
        self.assertTrue((rclone_dest_root / "AI_Archive" / f"ledger-{DUMMY_AGENT_ID}.jsonl").is_file())
        self.assertNotIn(batch_id, self.mock_state.batches)

    # ------------------------------------------------------------------
    # (9) `round+1` cross-batch repair re-push keeping `item_id` unchanged
    # ------------------------------------------------------------------
    def test_09_round_plus_one_cross_batch_repair_repush(self) -> None:
        orig_1 = create_test_png(self.originals_dir / "hand_fix_1.png", size=(500, 600))
        (self.originals_dir / "hand_fix_1.txt").write_text("portrait, detailed hands", encoding="utf-8")
        orig_2 = create_test_png(self.originals_dir / "foot_fix_2.png", size=(500, 600))
        (self.originals_dir / "foot_fix_2.txt").write_text("dancer, detailed feet", encoding="utf-8")

        batch_1 = "20261113-muse-main-12"
        mount_env = {
            "ARCHIVE_MODE": "mount",
            "ARCHIVE_LAYOUT": "ai_archive",
            "DRIVE_MOUNT_ROOT": str(self.mount_dir),
        }
        self.assertEqual(
            self._run_cli(["push", str(orig_1), str(orig_2), "--batch", batch_1], extra_env=mount_env).returncode,
            0,
        )

        orig_item_1 = f"{batch_1}-001"
        orig_item_2 = f"{batch_1}-002"
        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_1}/items/{orig_item_1}/1",
            {"tier": 1, "flags": ["H"], "note": "fix right index finger"},
        )
        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_1}/items/{orig_item_2}/1",
            {"tier": 2, "flags": ["F"], "note": "fix left ankle"},
        )
        self._review_request("POST", f"/api/review/batches/{batch_1}/done", {"review_done": True})

        # Pull + auto archive/ack batch 1 (0 archived, 2 repair -> ack cleans cloud batch 1!)
        self.assertEqual(
            self._run_cli(["pull", "--batch", batch_1, "--auto"], extra_env=mount_env).returncode,
            0,
        )
        self.assertNotIn(batch_1, self.mock_state.batches)

        # Create repaired images WITHOUT sidecar .txt to verify prompt carry-forward from round 1!
        repaired_dir = self.case_dir / "repaired_round2"
        repaired_1 = create_test_png(repaired_dir / "hand_fix_1_r2.png", size=(500, 600))
        repaired_2 = create_test_png(repaired_dir / "foot_fix_2_r2.png", size=(500, 600))

        batch_2 = "20261113-muse-main-13"
        # Push item 1 via --repush-item, then append item 2 to same batch_2 via --repush-map!
        r_push_1 = self._run_cli(
            ["push", str(repaired_1), "--batch", batch_2, "--repush-item", orig_item_1],
            extra_env=mount_env,
        )
        self.assertEqual(r_push_1.returncode, 0, r_push_1.stderr)

        repush_map_json = json.dumps({orig_item_2: str(repaired_2)})
        r_push_2 = self._run_cli(
            ["push", "--batch", batch_2, "--repush-map", repush_map_json],
            extra_env=mount_env,
        )
        self.assertEqual(r_push_2.returncode, 0, r_push_2.stderr)

        # Verify server has original item_ids with round=2 inside batch_2
        st, b2_detail = self._review_request("GET", f"/api/review/batches/{batch_2}")
        self.assertEqual(st, 200)
        self.assertEqual(
            [(it["item_id"], it["round"]) for it in b2_detail["items"]],
            [(orig_item_1, 2), (orig_item_2, 2)],
        )

        # Approve both repaired round=2 images and run auto-archive
        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_2}/items/{orig_item_1}/2",
            {"tier": 1, "flags": []},
        )
        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_2}/items/{orig_item_2}/2",
            {"tier": 2, "flags": []},
        )
        self._review_request("POST", f"/api/review/batches/{batch_2}/done", {"review_done": True})

        self.assertEqual(
            self._run_cli(["pull", "--batch", batch_2, "--auto"], extra_env=mount_env).returncode,
            0,
        )

        # Repaired images AND carried-forward prompts from round 1 must be archived in batch_2!
        arch_dir = self.mount_dir / "AI_Archive" / DUMMY_AGENT_ID / batch_2
        self.assertTrue((arch_dir / "hand_fix_1_r2.png").is_file())
        self.assertEqual((arch_dir / "hand_fix_1_r2.txt").read_text(encoding="utf-8"), "portrait, detailed hands")
        self.assertTrue((arch_dir / "foot_fix_2_r2.png").is_file())
        self.assertEqual((arch_dir / "foot_fix_2_r2.txt").read_text(encoding="utf-8"), "dancer, detailed feet")

        # Verify round 1 repair history in ledger was never mutated/lost
        all_records = self._read_ledger_lines()
        r1_repair = [
            r for r in all_records if r.get("item_id") == orig_item_1 and r.get("round") == 1 and r.get("state") == "repair"
        ]
        r2_arch = [
            r for r in all_records if r.get("item_id") == orig_item_1 and r.get("round") == 2 and r.get("drive_path")
        ]
        self.assertEqual(len(r1_repair), 1)
        self.assertEqual(r1_repair[0]["verdict"]["tier"], 1)
        self.assertEqual(len(r2_arch), 1)

    # ------------------------------------------------------------------
    # (10) Strict `/tmp` & system dir path guard + Spec §11 auth denial checks
    # ------------------------------------------------------------------
    def test_10_strict_path_guard_and_unauthenticated_access_rejection(self) -> None:
        forbidden_examples = [
            "/tmp/outpost-forbidden",
            "/private/tmp/outpost-forbidden",
            "/var/tmp/outpost-forbidden",
            "/etc/outpost-forbidden",
            "/usr/local/outpost-forbidden",
            "/bin/sh",
            "/sbin/mount",
            "/System/Library/Fonts",
            "/Library/Application Support/forbidden",
        ]
        for bad_path in forbidden_examples:
            with self.assertRaises(hub_client.PathGuardError, msg=f"Must reject {bad_path}"):
                hub_client.validate_safe_storage_path(bad_path, "test_path")

        # CLI must exit with code 2 when --workspace-dir, image path, or --mount-root uses /tmp
        bad_ws = self._run_cli(["cleanup-trash", "--workspace-dir", "/tmp/review-outpost-test"])
        self.assertEqual(bad_ws.returncode, 2)
        self.assertIn("forbidden_storage_path", bad_ws.stdout)

        safe_img = create_test_png(self.originals_dir / "ok.png")
        bad_mount = self._run_cli(["push", str(safe_img), "--mount-root", "/private/tmp/mount"])
        self.assertEqual(bad_mount.returncode, 2)

        bad_img = self._run_cli(["push", "/tmp/nonexistent.png"])
        self.assertEqual(bad_img.returncode, 2)

        # Spec §11 (5): Unauthenticated requests to page, batches, previews, and agent API rejected
        for route in ("/", "/app.js", "/api/review/batches", "/api/review/previews/b1/i1/1"):
            st_no_jwt, _ = self._review_request("GET", route, access_jwt=None)
            self.assertEqual(st_no_jwt, 401)
            st_bad_jwt, _ = self._review_request("GET", route, access_jwt="forged-jwt")
            self.assertEqual(st_bad_jwt, 401)

        bad_token_proc = self._run_cli(["push", str(safe_img)], extra_env={"OUTPOST_TOKEN": "wrong-token"})
        self.assertNotEqual(bad_token_proc.returncode, 0)
        self.assertIn("401", bad_token_proc.stdout + bad_token_proc.stderr)


if __name__ == "__main__":
    unittest.main()
