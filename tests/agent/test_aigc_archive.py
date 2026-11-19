#!/usr/bin/env python3
"""Offline end-to-end test suite for optional Drive auto-archive module (`agent/aigc_archive.py`).

Covers Spec §8 & Commit 2 requirements (Python 3.9+ compatible, zero external network):
1. `artwork`, `face`, and `outfit` routing across all 4 star levels (`final_tier = 3, 2, 1, 0`,
   explicitly verifying `tier = 0` lands in `收藏` / `留样`).
2. `artwork` (`write_combo_card: true`) generates & uploads companion `.md` combo cards from
   `generation_context`, while `face` and `outfit` (`write_combo_card: false`) do not.
3. Strict Drive `copyto`-only invariant (zero `move` / `moveto`), parallel transfers, and
   fail-fast abort on non-zero `rclone` exit code (blocking `mark-archived` and `ack`).
4. `--upload-repair` stages `repair` originals to `repair_staging_dir` without mutating
   their `repair` destination or `intent_tier`.
5. `--trash-discarded` moves `discard` files into `<workspace_dir>/_trash/<batch_id>/` and
   purges >7d expired trash directories (leaving files untouched when flag is omitted).
6. Full closure: `archive_ref` backfill -> `cmd_ack` `200 OK` + cloud purge ->
   `AI_Archive/ledger-<agent_id>.jsonl` remote backup containing `batch_acked`.

All test sandboxes reside strictly under repo-relative `.test-sandboxes/agent/`.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import threading
import time
import unittest
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENT_DIR = REPO_ROOT / "agent"
TESTS_AGENT_DIR = REPO_ROOT / "tests" / "agent"
HUB_CLIENT_SCRIPT = AGENT_DIR / "hub_client.py"
AIGC_ARCHIVE_SCRIPT = AGENT_DIR / "aigc_archive.py"
EXAMPLE_CONFIG_FILE = AGENT_DIR / "aigc_archive_config.example.json"
SANDBOX_ROOT = REPO_ROOT / ".test-sandboxes" / "agent"

for p in (AGENT_DIR, TESTS_AGENT_DIR):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

import aigc_archive  # noqa: E402
import hub_client  # noqa: E402
from test_hub_client import (  # noqa: E402
    DUMMY_ACCESS_JWT,
    DUMMY_MUSE_ID,
    DUMMY_MUSE_TOKEN,
    OutpostV4MockHandler,
    OutpostV4MockState,
    ThreadedMockServer,
    create_test_png,
)


class AigcArchiveTestSuite(unittest.TestCase):
    def setUp(self) -> None:
        SANDBOX_ROOT.mkdir(parents=True, exist_ok=True)
        self.case_dir = SANDBOX_ROOT / self._testMethodName
        if self.case_dir.exists():
            shutil.rmtree(self.case_dir)
        self.case_dir.mkdir(parents=True, exist_ok=True)

        self.workspace_dir = self.case_dir / "workspace"
        self.originals_dir = self.case_dir / "originals"
        self.remote_drive_root = self.case_dir / "simulated_gdrive_remote"
        self.rclone_log_file = self.case_dir / "rclone_invocations.jsonl"
        self.workspace_dir.mkdir(parents=True, exist_ok=True)
        self.originals_dir.mkdir(parents=True, exist_ok=True)
        self.remote_drive_root.mkdir(parents=True, exist_ok=True)

        # Build multiprocess-safe executable fake `rclone` script
        self.fake_rclone_bin = self.case_dir / "bin" / "fake_rclone.py"
        self.fake_rclone_bin.parent.mkdir(parents=True, exist_ok=True)
        fake_script = (
            f"#!{sys.executable}\n"
            "import fcntl, json, os, shutil, sys\n"
            "from pathlib import Path\n"
            f"DEST_ROOT = Path({str(self.remote_drive_root)!r})\n"
            f"LOG_FILE = Path({str(self.rclone_log_file)!r})\n"
            "LOCK_FILE = Path(str(LOG_FILE) + '.lock')\n"
            "args = sys.argv[1:]\n"
            "with open(LOCK_FILE, 'a+', encoding='utf-8') as lfh:\n"
            "    fcntl.flock(lfh.fileno(), fcntl.LOCK_EX)\n"
            "    try:\n"
            "        with open(LOG_FILE, 'a', encoding='utf-8') as lf:\n"
            "            lf.write(json.dumps(args, ensure_ascii=False) + '\\n')\n"
            "            lf.flush()\n"
            "    finally:\n"
            "        fcntl.flock(lfh.fileno(), fcntl.LOCK_UN)\n"
            "fail_sub = os.environ.get('FAKE_RCLONE_FAIL_SUBSTR', '')\n"
            "if fail_sub and any(fail_sub in a for a in args):\n"
            "    sys.stderr.write(f'Simulated rclone failure on {fail_sub}\\n')\n"
            "    sys.exit(17)\n"
            "if len(args) != 3 or args[0] != 'copyto':\n"
            "    sys.stderr.write(f'Forbidden or malformed rclone command: {args!r}\\n')\n"
            "    sys.exit(2)\n"
            "src, remote_spec = args[1], args[2]\n"
            "if not remote_spec.startswith('gdrive:'):\n"
            "    sys.stderr.write(f'Unexpected remote prefix: {remote_spec!r}\\n')\n"
            "    sys.exit(3)\n"
            "rel = remote_spec[len('gdrive:'):].lstrip('/')\n"
            "out_path = DEST_ROOT / rel\n"
            "out_path.parent.mkdir(parents=True, exist_ok=True)\n"
            "shutil.copy2(src, out_path)\n"
        )
        self.fake_rclone_bin.write_text(fake_script, encoding="utf-8")
        self.fake_rclone_bin.chmod(self.fake_rclone_bin.stat().st_mode | stat.S_IXUSR)

        # Derive test config directly from committed `agent/aigc_archive_config.example.json`
        example_cfg = json.loads(EXAMPLE_CONFIG_FILE.read_text(encoding="utf-8"))
        example_cfg["rclone_bin"] = str(self.fake_rclone_bin)
        self.config_path = self.case_dir / "aigc_archive_config.json"
        self.config_path.write_text(
            json.dumps(example_cfg, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

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
            "FAKE_RCLONE_FAIL_SUBSTR",
        ):
            env.pop(k, None)
        env.update(
            {
                "OUTPOST_URL": self.base_url,
                "OUTPOST_AGENT_ID": DUMMY_MUSE_ID,
                "OUTPOST_TOKEN": DUMMY_MUSE_TOKEN,
                "OUTPOST_HOME": str(self.workspace_dir),
            }
        )
        if extra:
            env.update(extra)
        return env

    def _run_hub(self, args: List[str], extra_env: Optional[Dict[str, str]] = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(HUB_CLIENT_SCRIPT)] + args,
            env=self._base_env(extra_env),
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
        )

    def _run_archive(self, args: List[str], extra_env: Optional[Dict[str, str]] = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(AIGC_ARCHIVE_SCRIPT), "--config", str(self.config_path)] + args,
            env=self._base_env(extra_env),
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
        )

    def _review_request(self, method: str, path: str, payload: Optional[Dict[str, Any]] = None) -> Tuple[int, Any]:
        headers = {"Cf-Access-Jwt-Assertion": DUMMY_ACCESS_JWT}
        data: Optional[bytes] = None
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
        try:
            with self._opener.open(req, timeout=10.0) as resp:
                raw = resp.read().decode("utf-8")
                return resp.status, json.loads(raw)
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read().decode("utf-8"))

    def _read_rclone_calls(self) -> List[List[str]]:
        if not self.rclone_log_file.is_file():
            return []
        return [
            json.loads(line)
            for line in self.rclone_log_file.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    # ------------------------------------------------------------------
    # (1) `artwork` all 4 tiers (3,2,1,0) + `.md` combo cards + repair staging + discard untouched + ledger backup
    # ------------------------------------------------------------------
    def test_01_artwork_four_tiers_combo_cards_upload_repair_and_ledger_backup(self) -> None:
        # Verify hub_client stays 100% decoupled (never imports aigc_archive)
        hub_src = HUB_CLIENT_SCRIPT.read_text(encoding="utf-8")
        self.assertNotIn("aigc_archive", hub_src)

        names = ["art_3star.png", "art_2star.png", "art_1star.png", "art_0star.png", "art_repair.png", "art_discard.png"]
        ordered_paths: List[str] = []
        for idx, name in enumerate(names, start=1):
            p = create_test_png(self.originals_dir / name)
            ordered_paths.append(str(p))
            (self.originals_dir / f"{p.stem}.json").write_text(
                json.dumps({"prompt": f"cinematic scene #{idx}", "seed": 1000 + idx, "model": "gpt-image"}),
                encoding="utf-8",
            )

        push_res = self._run_hub(["push"] + ordered_paths + ["--line", "gpt", "--batch-type", "artwork"])
        self.assertEqual(push_res.returncode, 0, push_res.stderr)
        batch_id = json.loads(push_res.stdout)["batch_id"]

        # Rate 001..004 as tiers 3, 2, 1, 0; 005 as tier=3 + H (repair); 006 as null (discard)
        for seq_idx, tier_val in ((1, 3), (2, 2), (3, 1), (4, 0)):
            self._review_request(
                "PATCH",
                f"/api/review/batches/{batch_id}/items/{batch_id}-{seq_idx:03d}/1",
                {"tier": tier_val, "flags": ["R"] if tier_val == 3 else [], "note": f"tier-{tier_val}-note"},
            )
        self._review_request(
            "PATCH",
            f"/api/review/batches/{batch_id}/items/{batch_id}-005/1",
            {"tier": 3, "flags": ["H"], "note": "fix fingers"},
        )
        self._review_request("POST", f"/api/review/batches/{batch_id}/done", {"review_done": True})
        self.assertEqual(self._run_hub(["pull", "--batch", batch_id]).returncode, 0)

        # Run aigc_archive with --upload-repair (WITHOUT --trash-discarded -> discard stays untouched!)
        arch_proc = self._run_archive(["--batch", batch_id, "--upload-repair"])
        self.assertEqual(arch_proc.returncode, 0, arch_proc.stderr)
        arch_out = json.loads(arch_proc.stdout)
        self.assertTrue(arch_out["ok"])
        self.assertEqual(arch_out["ack"]["purged_previews"], 6)

        # Assert all 4 artwork tier directories received BOTH image AND `.md` combo card (including tier=0 -> 收藏!)
        expected_artwork_targets = [
            ("aigc/成图收录/神图", "art_3star"),
            ("aigc/成图收录/心动", "art_2star"),
            ("aigc/成图收录/高品质", "art_1star"),
            ("aigc/成图收录/收藏", "art_0star"),
        ]
        for rel_dir, stem in expected_artwork_targets:
            img_remote = self.remote_drive_root / rel_dir / f"{stem}.png"
            md_remote = self.remote_drive_root / rel_dir / f"{stem}.md"
            self.assertTrue(img_remote.is_file(), f"Missing archived image {img_remote}")
            self.assertTrue(md_remote.is_file(), f"Missing combo card {md_remote}")
            md_text = md_remote.read_text(encoding="utf-8")
            self.assertIn("cinematic scene #", md_text)
            self.assertIn("gpt-image", md_text)

        # Assert repair item staged to `aigc/待修复-修手修脚` AND kept `destination == "repair"` + `intent_tier == 3` in ledger!
        self.assertTrue((self.remote_drive_root / "aigc/待修复-修手修脚/art_repair.png").is_file())
        ledger = hub_client.Ledger(self.workspace_dir / f"ledger-{DUMMY_MUSE_ID}.jsonl", DUMMY_MUSE_ID)
        bview = ledger.get_batch_view(batch_id)
        rep_item = bview.items[(f"{batch_id}-005", 1)]
        self.assertEqual(rep_item["destination"], "repair")
        self.assertEqual(rep_item["intent_tier"], 3)
        self.assertIsNone(rep_item["archive_ref"])

        # Assert tier=0 archive_ref was properly backfilled
        t0_item = bview.items[(f"{batch_id}-004", 1)]
        self.assertEqual(t0_item["archive_ref"], "gdrive:aigc/成图收录/收藏/art_0star.png")

        # Assert discard file untouched because --trash-discarded was NOT passed
        self.assertTrue((self.originals_dir / "art_discard.png").is_file())
        self.assertFalse((self.workspace_dir / "_trash").exists())

        # Assert remote ledger backup exists and contains `batch_acked`
        remote_ledger = self.remote_drive_root / f"AI_Archive/ledger-{DUMMY_MUSE_ID}.jsonl"
        self.assertTrue(remote_ledger.is_file())
        self.assertIn("batch_acked", remote_ledger.read_text(encoding="utf-8"))

        # Assert EVERY rclone call used `copyto` (zero `move` / `moveto`)
        calls = self._read_rclone_calls()
        self.assertTrue(len(calls) > 0)
        self.assertTrue(all(c[0] == "copyto" for c in calls))

    # ------------------------------------------------------------------
    # (2) `face` and `outfit` 4-tier routing (including `tier = 0 -> 留样`) with NO combo cards
    # ------------------------------------------------------------------
    def test_02_face_and_outfit_four_tiers_no_combo_cards(self) -> None:
        for batch_type, base_folder in (("face", "aigc/脸模库"), ("outfit", "aigc/服装库")):
            sub_dir = self.originals_dir / batch_type
            for t in (3, 2, 1, 0):
                create_test_png(sub_dir / f"{batch_type}_t{t}.png")
                (sub_dir / f"{batch_type}_t{t}.txt").write_text(f"{batch_type} prompt {t}", encoding="utf-8")

            p_res = self._run_hub(["push", str(sub_dir), "--line", "colab", "--batch-type", batch_type])
            self.assertEqual(p_res.returncode, 0, p_res.stderr)
            bid = json.loads(p_res.stdout)["batch_id"]

            # Items sorted alphabetically: t0 (001), t1 (002), t2 (003), t3 (004)
            for idx, tier_val in ((1, 0), (2, 1), (3, 2), (4, 3)):
                self._review_request(
                    "PATCH",
                    f"/api/review/batches/{bid}/items/{bid}-{idx:03d}/1",
                    {"tier": tier_val, "flags": []},
                )
            self._review_request("POST", f"/api/review/batches/{bid}/done", {"review_done": True})
            self.assertEqual(self._run_hub(["pull", "--batch", bid]).returncode, 0)

            a_res = self._run_archive(["--batch", bid])
            self.assertEqual(a_res.returncode, 0, a_res.stderr)

            tier_subdirs = {
                3: f"{base_folder}/三星-核心锚",
                2: f"{base_folder}/二星-优质锚",
                1: f"{base_folder}/一星-达标锚",
                0: f"{base_folder}/留样",
            }
            for t_val, rel_folder in tier_subdirs.items():
                self.assertTrue(
                    (self.remote_drive_root / rel_folder / f"{batch_type}_t{t_val}.png").is_file(),
                    f"Missing {batch_type} tier={t_val} image",
                )
                self.assertFalse(
                    (self.remote_drive_root / rel_folder / f"{batch_type}_t{t_val}.md").exists(),
                    f"{batch_type} must NOT generate combo cards!",
                )

    # ------------------------------------------------------------------
    # (3) Fail-fast on `rclone` non-zero exit code + `--trash-discarded` & >7d purge
    # ------------------------------------------------------------------
    def test_03_rclone_failure_blocks_mark_and_ack_plus_trash_discarded_purge(self) -> None:
        # Plant expired (>8d) and fresh (1d) files in _trash
        expired_dir = self.workspace_dir / "_trash" / "20261101-museai-gpt-01"
        fresh_dir = self.workspace_dir / "_trash" / "20261118-museai-gpt-01"
        expired_dir.mkdir(parents=True, exist_ok=True)
        fresh_dir.mkdir(parents=True, exist_ok=True)
        expired_f = expired_dir / "old_discard.png"
        fresh_f = fresh_dir / "recent_discard.png"
        expired_f.write_bytes(b"expired")
        fresh_f.write_bytes(b"fresh")
        now_ts = time.time()
        os.utime(expired_f, (now_ts - 8 * 86400, now_ts - 8 * 86400))
        os.utime(fresh_f, (now_ts - 1 * 86400, now_ts - 1 * 86400))

        img_keep = create_test_png(self.originals_dir / "keep_heart.png")
        img_drop = create_test_png(self.originals_dir / "drop_me.png")
        drop_txt = self.originals_dir / "drop_me.txt"
        drop_txt.write_text("discarded sidecar", encoding="utf-8")

        p_res = self._run_hub(["push", str(img_keep), str(img_drop), "--line", "gpt"])
        self.assertEqual(p_res.returncode, 0, p_res.stderr)
        bid = json.loads(p_res.stdout)["batch_id"]

        # Positional file push: img_keep.png is 001 -> tier=2 (心动); img_drop.png is 002 -> discard
        self._review_request(
            "PATCH",
            f"/api/review/batches/{bid}/items/{bid}-001/1",
            {"tier": 2, "flags": []},
        )
        self._review_request("POST", f"/api/review/batches/{bid}/done", {"review_done": True})
        self.assertEqual(self._run_hub(["pull", "--batch", bid]).returncode, 0)

        # 1. Inject fake rclone failure on "心动" -> MUST fail before mark-archived & ack!
        fail_proc = self._run_archive(
            ["--batch", bid, "--trash-discarded"],
            extra_env={"FAKE_RCLONE_FAIL_SUBSTR": "心动"},
        )
        self.assertNotEqual(fail_proc.returncode, 0)
        self.assertEqual(self.mock_state.ack_http_calls, 0, "Failed rclone transfer must block ack!")
        self.assertIn(bid, self.mock_state.batches, "Cloud batch must NOT be deleted when upload fails!")

        ledger = hub_client.Ledger(self.workspace_dir / f"ledger-{DUMMY_MUSE_ID}.jsonl", DUMMY_MUSE_ID)
        self.assertIsNone(
            ledger.get_batch_view(bid).items[(f"{bid}-001", 1)]["archive_ref"],
            "archive_ref must NOT be backfilled when rclone upload fails!",
        )
        self.assertTrue(img_drop.is_file(), "Discard trash move must NOT happen if upload aborted!")

        # 2. Re-run without fault injection -> full success + trash move + >7d purge!
        ok_proc = self._run_archive(["--batch", bid, "--trash-discarded"])
        self.assertEqual(ok_proc.returncode, 0, ok_proc.stderr)
        ok_out = json.loads(ok_proc.stdout)

        self.assertEqual(ok_out["trash"]["purged_count"], 1)
        self.assertFalse(expired_f.exists(), ">7d trash file must be purged")
        self.assertFalse(expired_dir.exists(), "Empty expired batch trash dir must be removed")
        self.assertTrue(fresh_f.exists(), "<7d trash file must be retained")

        self.assertFalse(img_drop.exists())
        self.assertFalse(drop_txt.exists())
        self.assertTrue((self.workspace_dir / "_trash" / bid / "drop_me.png").is_file())
        self.assertTrue((self.workspace_dir / "_trash" / bid / "drop_me.txt").is_file())
        self.assertNotIn(bid, self.mock_state.batches)

        # Path guard check on aigc_archive CLI
        bad_cfg = self._run_archive(["--batch", bid, "--workspace-dir", "/tmp/forbidden-ws"])
        self.assertEqual(bad_cfg.returncode, 2)


if __name__ == "__main__":
    unittest.main()
