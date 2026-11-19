#!/usr/bin/env python3
"""Optional Google Drive Auto-Archive Module for Review Outpost v4 (aigc_archive.py).

Decoupled from `hub_client.py` core protocol (`hub_client.py` never imports this module).
For agents (such as cloud VM `muse-main`) that want automated rclone uploads after `pull`:
- Routes `destination == "archive"` originals by `(batch_type, str(final_tier))` across all
  4 star levels (`3`, `2`, `1`, `0` — explicitly guarding `final_tier = 0`).
- Optionally generates companion combo-card files (e.g. `.md`) inside `<workspace_dir>/_combo_cards/`
  when `write_combo_card` is enabled for the route (such as `artwork`).
- Uses ONLY `rclone copyto <local_src> <remote_dst>` (never remote `move` / `moveto`), with
  configurable `parallel_transfers` and strict exit-code verification before any ledger mutation.
- Optional `--upload-repair`: stages `destination == "repair"` originals to `repair_staging_dir`
  without calling `mark-archived` (keeping `repair` + `intent_tier` intact).
- Optional `--trash-discarded`: moves `destination == "discard"` local files into
  `<workspace_dir>/_trash/<batch_id>/` and purges `_trash` items older than 7 days.
- Calls `hub_client.cmd_mark_archived` -> `hub_client.cmd_ack` -> `rclone copyto` backup of
  `ledger-<agent_id>.jsonl` to `ledger_backup_path`.

Compatible with Python 3.9+ using stdlib + one-way `hub_client` helpers.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple, Union

AGENT_DIR = Path(__file__).resolve().parent
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import hub_client  # noqa: E402


STAR_BADGES: Dict[int, str] = {
    3: "★★★",
    2: "★★",
    1: "★",
    0: "☆",
}

SIDECAR_SUFFIXES: Tuple[str, ...] = (".txt", ".prompt.txt", ".json", ".context.json")


class AigcArchiveError(hub_client.HubClientError):
    """Raised when optional rclone archive configuration or execution fails."""


@dataclass
class RouteRule:
    tiers: Dict[str, str]
    write_combo_card: bool = False
    combo_card_ext: str = ".md"


@dataclass
class AigcArchiveConfig:
    schema_version: int
    transport: str
    rclone_remote: str
    rclone_bin: str
    parallel_transfers: int
    ledger_backup_path: str
    repair_staging_dir: str
    routes: Dict[str, RouteRule]


@dataclass
class CopyToTask:
    kind: str
    item_id: Optional[str]
    local_src: Path
    remote_dst: str


def format_rclone_dest(remote: str, rel_path: str) -> str:
    """Format `<rclone_remote><rel_path>` (e.g. `gdrive:aigc/成图收录/神图/001.png`)."""
    cleaned_remote = (remote or "").strip()
    if not cleaned_remote:
        raise AigcArchiveError("rclone_remote must be non-empty in archive config.")
    if ":" not in cleaned_remote:
        cleaned_remote = cleaned_remote + ":"
    cleaned_rel = rel_path.strip().lstrip("/")
    if not cleaned_rel or ".." in cleaned_rel.split("/"):
        raise AigcArchiveError(f"Unsafe relative remote path: {rel_path!r}")
    if cleaned_remote.endswith(":") or cleaned_remote.endswith("/"):
        return f"{cleaned_remote}{cleaned_rel}"
    return f"{cleaned_remote}/{cleaned_rel}"


def load_archive_config(config_path_raw: Union[str, Path]) -> AigcArchiveConfig:
    cfg_path = hub_client.validate_safe_storage_path(config_path_raw, "archive config file")
    if not cfg_path.is_file():
        raise AigcArchiveError(f"Archive config file not found: {cfg_path}")

    try:
        raw = json.loads(cfg_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise AigcArchiveError(f"Invalid JSON in archive config {cfg_path}: {exc}") from exc

    if not isinstance(raw, dict):
        raise AigcArchiveError("Archive config root must be a JSON object.")

    schema_ver = raw.get("schema_version", 1)
    if schema_ver != 1:
        raise AigcArchiveError(f"Unsupported schema_version {schema_ver!r}; expected 1.")

    transport = str(raw.get("transport") or "rclone").strip()
    if transport != "rclone":
        raise AigcArchiveError(f"Unsupported transport {transport!r}; expected 'rclone'.")

    rclone_remote = str(raw.get("rclone_remote") or "").strip()
    if not rclone_remote:
        raise AigcArchiveError("Missing 'rclone_remote' in archive config.")

    rclone_bin = str(raw.get("rclone_bin") or "rclone").strip()
    if not rclone_bin:
        raise AigcArchiveError("Invalid empty 'rclone_bin' in archive config.")

    parallel_transfers = int(raw.get("parallel_transfers") or 4)
    if parallel_transfers < 1:
        raise AigcArchiveError("'parallel_transfers' must be >= 1.")

    ledger_backup_path = str(raw.get("ledger_backup_path") or "AI_Archive/ledger-{agent_id}.jsonl").strip()
    repair_staging_dir = str(raw.get("repair_staging_dir") or "aigc/待修复-修手修脚").strip()

    raw_routes = raw.get("routes")
    if not isinstance(raw_routes, dict) or not raw_routes:
        raise AigcArchiveError("Archive config must define a non-empty 'routes' object.")

    parsed_routes: Dict[str, RouteRule] = {}
    for bt_key, rule_raw in raw_routes.items():
        norm_bt = hub_client.normalize_batch_type(str(bt_key))
        if not isinstance(rule_raw, dict):
            raise AigcArchiveError(f"Route config for {bt_key!r} must be an object.")
        raw_tiers = rule_raw.get("tiers")
        if not isinstance(raw_tiers, dict):
            raise AigcArchiveError(f"Route config for {bt_key!r} missing 'tiers' object.")

        tiers_map: Dict[str, str] = {}
        for t_key in ("3", "2", "1", "0"):
            t_dir = raw_tiers.get(t_key)
            if not isinstance(t_dir, str) or not t_dir.strip():
                raise AigcArchiveError(
                    f"Route config for {norm_bt!r} must define non-empty path for tier {t_key!r}."
                )
            tiers_map[t_key] = t_dir.strip().strip("/")

        write_cc = bool(rule_raw.get("write_combo_card", False))
        ext_raw = str(rule_raw.get("combo_card_ext") or ".md").strip()
        if not ext_raw.startswith("."):
            ext_raw = "." + ext_raw

        parsed_routes[norm_bt] = RouteRule(
            tiers=tiers_map,
            write_combo_card=write_cc,
            combo_card_ext=ext_raw,
        )

    return AigcArchiveConfig(
        schema_version=1,
        transport=transport,
        rclone_remote=rclone_remote,
        rclone_bin=rclone_bin,
        parallel_transfers=parallel_transfers,
        ledger_backup_path=ledger_backup_path,
        repair_staging_dir=repair_staging_dir,
        routes=parsed_routes,
    )


def _extract_generation_context(item: Dict[str, Any], orig_path: Path) -> Any:
    ctx = item.get("generation_context")
    if ctx is not None:
        return ctx
    _, _, sidecar_ctx = hub_client.discover_sidecar_context(orig_path)
    if sidecar_ctx is not None:
        return sidecar_ctx
    if item.get("prompt_text") is not None:
        return item["prompt_text"]
    if item.get("prompt") is not None:
        return item["prompt"]
    return None


def _render_combo_card(
    stem: str,
    batch_view: hub_client.BatchLedgerView,
    item: Dict[str, Any],
    final_tier: int,
    ext: str,
    gen_context: Any,
) -> str:
    verdict = item.get("verdict") if isinstance(item.get("verdict"), dict) else {}
    note = str(verdict.get("note") or "")
    star_badge = STAR_BADGES.get(final_tier, str(final_tier))

    if ext.lower() == ".json":
        payload = {
            "item_id": item["item_id"],
            "batch_id": batch_view.batch_id,
            "round": item["round"],
            "source": batch_view.source,
            "line": batch_view.line,
            "channel_id": batch_view.channel_id,
            "batch_type": batch_view.batch_type,
            "final_tier": final_tier,
            "stars": star_badge,
            "redraw": bool(item.get("redraw")),
            "parent_item_id": item.get("parent_item_id"),
            "note": note,
            "generation_context": gen_context,
        }
        return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"

    lines: List[str] = [
        f"# {stem}",
        "",
        f"- **Item ID**: `{item['item_id']}` (round `{item['round']}`)",
        f"- **Batch ID**: `{batch_view.batch_id}`",
        f"- **Channel**: `{batch_view.channel_id or batch_view.source or 'default'}` (`{batch_view.batch_type}`)",
        f"- **Rating**: `{star_badge}` (`tier = {final_tier}`)",
        f"- **Redraw Flag**: `{'true' if item.get('redraw') else 'false'}`",
    ]
    if item.get("parent_item_id"):
        lines.append(f"- **Parent Item ID**: `{item['parent_item_id']}`")
    if note:
        lines.append(f"- **Review Note**: {note}")

    lines.append("")
    if isinstance(gen_context, dict):
        if "prompt" in gen_context and gen_context["prompt"] is not None:
            lines.extend(["## Prompt", "", str(gen_context["prompt"]).strip(), ""])
        lines.extend(
            [
                "## Generation Context",
                "",
                "```json",
                json.dumps(gen_context, ensure_ascii=False, indent=2),
                "```",
                "",
            ]
        )
    elif isinstance(gen_context, str) and gen_context.strip():
        lines.extend(["## Prompt", "", gen_context.strip(), ""])
    else:
        lines.extend(["## Prompt", "", "_(no generation context recorded)_", ""])

    return "\n".join(lines)


def _run_rclone_copyto(rclone_bin: str, task: CopyToTask) -> CopyToTask:
    """Execute a single `rclone copyto <local_src> <remote_dst>` and verify exit code 0."""
    safe_src = hub_client.validate_safe_storage_path(task.local_src, "rclone source file")
    if not safe_src.is_file():
        raise AigcArchiveError(f"Local file missing before rclone copyto: {safe_src}")

    cmd = [rclone_bin, "copyto", str(safe_src), task.remote_dst]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True)
    except OSError as exc:
        raise AigcArchiveError(
            f"Failed to execute rclone binary {rclone_bin!r} for {safe_src} -> {task.remote_dst}: {exc}"
        ) from exc

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise AigcArchiveError(
            f"rclone copyto failed (exit {proc.returncode}) for {safe_src} -> {task.remote_dst}: {detail}"
        )
    return task


def _execute_parallel_copyto(
    rclone_bin: str,
    tasks: Sequence[CopyToTask],
    max_workers: int,
) -> List[Dict[str, Any]]:
    if not tasks:
        return []
    workers = max(1, min(max_workers, len(tasks)))
    completed: List[Dict[str, Any]] = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        future_map = {
            pool.submit(_run_rclone_copyto, rclone_bin, task): idx
            for idx, task in enumerate(tasks)
        }
        ordered_results: List[Tuple[int, CopyToTask]] = []
        errors: List[Exception] = []
        for fut in concurrent.futures.as_completed(future_map):
            idx = future_map[fut]
            try:
                done_task = fut.result()
                ordered_results.append((idx, done_task))
            except Exception as exc:
                errors.append(exc)

        if errors:
            first_err = errors[0]
            if isinstance(first_err, hub_client.HubClientError):
                raise first_err
            raise AigcArchiveError(str(first_err)) from first_err

        for _, t in sorted(ordered_results, key=lambda pair: pair[0]):
            completed.append(
                {
                    "kind": t.kind,
                    "item_id": t.item_id,
                    "local_src": str(t.local_src),
                    "remote_dst": t.remote_dst,
                }
            )
    return completed


def _trash_discarded_items_and_purge(
    workspace_dir: Path,
    batch_id: str,
    discard_items: Sequence[Dict[str, Any]],
    max_age_days: float = 7.0,
    now_ts: Optional[float] = None,
) -> Dict[str, Any]:
    safe_ws = hub_client.validate_safe_storage_path(workspace_dir, "workspace_dir")
    trash_root = hub_client.validate_safe_storage_path(safe_ws / "_trash", "trash root")
    batch_trash = hub_client.validate_safe_storage_path(trash_root / batch_id, "batch trash dir")

    moved_files: List[str] = []
    for item in discard_items:
        orig_str = item.get("original_path")
        if not orig_str:
            continue
        orig_path = hub_client.validate_safe_storage_path(orig_str, "discard original_path")
        candidates: List[Path] = []
        if orig_path.is_file():
            candidates.append(orig_path)
        for sfx in SIDECAR_SUFFIXES:
            sc = orig_path.parent / f"{orig_path.stem}{sfx}"
            if sc.is_file() and sc not in candidates:
                candidates.append(hub_client.validate_safe_storage_path(sc, "discard sidecar"))

        for src_p in candidates:
            batch_trash.mkdir(parents=True, exist_ok=True)
            dest_p = batch_trash / src_p.name
            if dest_p.exists():
                dest_p = batch_trash / f"{item['item_id']}_{src_p.name}"
            shutil.move(str(src_p), str(dest_p))
            moved_files.append(str(dest_p))

    # Purge files in _trash older than max_age_days and prune empty directories
    purged_files: List[str] = []
    if trash_root.is_dir():
        current_ts = time.time() if now_ts is None else now_ts
        cutoff = current_ts - (max_age_days * 86400.0)
        for root_str, _dirs, files in os.walk(str(trash_root), topdown=False):
            root_path = Path(root_str)
            for fname in files:
                fpath = root_path / fname
                try:
                    st = fpath.stat()
                except OSError:
                    continue
                if st.st_mtime <= cutoff:
                    try:
                        fpath.unlink()
                        purged_files.append(str(fpath))
                    except OSError:
                        pass
            if root_path != trash_root:
                try:
                    if not any(root_path.iterdir()):
                        root_path.rmdir()
                except OSError:
                    pass

    return {
        "moved_to_trash": moved_files,
        "purged_expired_files": purged_files,
        "purged_count": len(purged_files),
    }


def run_aigc_archive(
    hub_config: hub_client.ClientConfig,
    archive_config: AigcArchiveConfig,
    batch_id: Optional[str] = None,
    upload_repair: bool = False,
    trash_discarded: bool = False,
    run_ack: bool = True,
    trash_max_age_days: float = 7.0,
    trash_now_ts: Optional[float] = None,
    http_client: Optional[hub_client.HubHttpClient] = None,
) -> Dict[str, Any]:
    """Execute optional Drive archive workflow for a pulled batch and trigger ack + ledger backup."""
    hub_client.validate_safe_storage_path(hub_config.workspace_dir, "workspace_dir")
    ledger = hub_client.Ledger(hub_config.ledger_path, hub_config.agent_id)

    resolved_batch_id = (
        hub_client.validate_slug(batch_id, "batch_id")
        if batch_id
        else ledger.latest_unacked_batch_id()
    )
    if not resolved_batch_id:
        raise AigcArchiveError("No --batch specified and no un-acked batch found in local ledger.")

    batch_view = ledger.get_batch_view(resolved_batch_id)
    if not batch_view.items:
        raise AigcArchiveError(f"Batch {resolved_batch_id!r} not found in local ledger.")

    sorted_keys = sorted(batch_view.items.keys(), key=lambda k: (k[0], k[1]))
    unpulled = [
        batch_view.items[k]["item_id"]
        for k in sorted_keys
        if not batch_view.items[k].get("review_done_pulled")
        or batch_view.items[k].get("destination") not in ("archive", "repair", "discard")
    ]
    if unpulled:
        raise AigcArchiveError(
            f"Batch {resolved_batch_id} has unpulled items ({unpulled}); "
            f"run 'hub_client.py pull --batch {resolved_batch_id}' after review_done=true first."
        )

    batch_type = hub_client.normalize_batch_type(batch_view.batch_type or "artwork")
    if batch_type not in archive_config.routes:
        raise AigcArchiveError(f"No route configured for batch_type {batch_type!r}.")
    route_rule = archive_config.routes[batch_type]

    copy_tasks: List[CopyToTask] = []
    mark_updates: List[Dict[str, Any]] = []
    discard_items: List[Dict[str, Any]] = []
    used_remote_targets: Set[str] = set()

    combo_dir = hub_client.validate_safe_storage_path(
        hub_config.workspace_dir / "_combo_cards" / resolved_batch_id,
        "combo card staging dir",
    )

    for key in sorted_keys:
        item = batch_view.items[key]
        dest = item.get("destination")

        if dest == "archive":
            # Explicit `is None` check so `final_tier == 0` is NEVER swallowed!
            final_tier = hub_client.normalize_tier(item.get("final_tier"))
            if final_tier is None:
                raise AigcArchiveError(
                    f"Archive item {item['item_id']} missing valid final_tier (got {item.get('final_tier')!r})."
                )
            tier_key = str(final_tier)
            if tier_key not in route_rule.tiers:
                raise AigcArchiveError(
                    f"Route {batch_type!r} missing target directory for tier {tier_key!r}."
                )
            tier_dir = route_rule.tiers[tier_key]

            orig_str = item.get("original_path")
            if not orig_str:
                raise AigcArchiveError(f"Archive item {item['item_id']} missing original_path in ledger.")
            orig_path = hub_client.validate_safe_storage_path(orig_str, "original_path")
            if not orig_path.is_file():
                raise AigcArchiveError(f"Original image not found for {item['item_id']}: {orig_path}")

            chosen_name = orig_path.name
            chosen_stem = orig_path.stem
            remote_img = format_rclone_dest(archive_config.rclone_remote, f"{tier_dir}/{chosen_name}")
            if remote_img in used_remote_targets:
                chosen_name = f"{item['item_id']}_{orig_path.name}"
                chosen_stem = f"{item['item_id']}_{orig_path.stem}"
                remote_img = format_rclone_dest(archive_config.rclone_remote, f"{tier_dir}/{chosen_name}")
            used_remote_targets.add(remote_img)

            copy_tasks.append(
                CopyToTask(
                    kind="archive_image",
                    item_id=item["item_id"],
                    local_src=orig_path,
                    remote_dst=remote_img,
                )
            )

            if route_rule.write_combo_card:
                combo_dir.mkdir(parents=True, exist_ok=True)
                combo_name = f"{chosen_stem}{route_rule.combo_card_ext}"
                combo_local = hub_client.validate_safe_storage_path(
                    combo_dir / combo_name,
                    "combo card file",
                )
                gen_ctx = _extract_generation_context(item, orig_path)
                card_body = _render_combo_card(
                    stem=chosen_stem,
                    batch_view=batch_view,
                    item=item,
                    final_tier=final_tier,
                    ext=route_rule.combo_card_ext,
                    gen_context=gen_ctx,
                )
                combo_local.write_text(card_body, encoding="utf-8")
                remote_combo = format_rclone_dest(
                    archive_config.rclone_remote,
                    f"{tier_dir}/{combo_name}",
                )
                copy_tasks.append(
                    CopyToTask(
                        kind="combo_card",
                        item_id=item["item_id"],
                        local_src=combo_local,
                        remote_dst=remote_combo,
                    )
                )

            mark_updates.append(
                {
                    "batch_id": resolved_batch_id,
                    "item_id": item["item_id"],
                    "round": int(item["round"]),
                    "archive_ref": remote_img,
                }
            )

        elif dest == "repair":
            if upload_repair:
                orig_str = item.get("original_path")
                if not orig_str:
                    raise AigcArchiveError(f"Repair item {item['item_id']} missing original_path.")
                orig_path = hub_client.validate_safe_storage_path(orig_str, "repair original_path")
                if not orig_path.is_file():
                    raise AigcArchiveError(f"Repair original image not found: {orig_path}")

                chosen_name = orig_path.name
                staging_dir = archive_config.repair_staging_dir.strip("/")
                remote_rep = format_rclone_dest(
                    archive_config.rclone_remote,
                    f"{staging_dir}/{chosen_name}",
                )
                if remote_rep in used_remote_targets:
                    chosen_name = f"{item['item_id']}_{orig_path.name}"
                    remote_rep = format_rclone_dest(
                        archive_config.rclone_remote,
                        f"{staging_dir}/{chosen_name}",
                    )
                used_remote_targets.add(remote_rep)

                copy_tasks.append(
                    CopyToTask(
                        kind="repair_staging",
                        item_id=item["item_id"],
                        local_src=orig_path,
                        remote_dst=remote_rep,
                    )
                )

        elif dest == "discard":
            discard_items.append(item)

    # 1. Execute all `rclone copyto` transfers FIRST; any failure aborts before ledger backfill or ack!
    transfers_done = _execute_parallel_copyto(
        rclone_bin=archive_config.rclone_bin,
        tasks=copy_tasks,
        max_workers=archive_config.parallel_transfers,
    )

    # 2. Backfill `archive_ref` ONLY for `destination == "archive"` items via hub_client.cmd_mark_archived
    mark_res: Optional[Dict[str, Any]] = None
    if mark_updates:
        mark_res = hub_client.cmd_mark_archived(
            config=hub_config,
            batch_id=resolved_batch_id,
            from_json_raw=json.dumps(mark_updates, ensure_ascii=False),
        )

    # 3. Optional local trash move & >7d purge for `destination == "discard"`
    trash_res: Optional[Dict[str, Any]] = None
    if trash_discarded:
        trash_res = _trash_discarded_items_and_purge(
            workspace_dir=hub_config.workspace_dir,
            batch_id=resolved_batch_id,
            discard_items=discard_items,
            max_age_days=trash_max_age_days,
            now_ts=trash_now_ts,
        )

    # 4. Call hub_client.cmd_ack to verify & purge cloud batch, then sync ledger backup via `rclone copyto`
    ack_res: Optional[Dict[str, Any]] = None
    ledger_backup_remote: Optional[str] = None
    if run_ack:
        ack_res = hub_client.cmd_ack(
            config=hub_config,
            batch_id=resolved_batch_id,
            http_client=http_client,
        )
        backup_rel = archive_config.ledger_backup_path.format(agent_id=hub_config.agent_id)
        ledger_backup_remote = format_rclone_dest(archive_config.rclone_remote, backup_rel)
        _run_rclone_copyto(
            archive_config.rclone_bin,
            CopyToTask(
                kind="ledger_backup",
                item_id=None,
                local_src=hub_config.ledger_path,
                remote_dst=ledger_backup_remote,
            ),
        )

    return {
        "ok": True,
        "batch_id": resolved_batch_id,
        "batch_type": batch_type,
        "transfers": transfers_done,
        "marked_archived": mark_res["updated"] if mark_res else [],
        "trash": trash_res,
        "ack": ack_res,
        "ledger_backup_remote": ledger_backup_remote,
    }


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="aigc_archive.py",
        description="Optional rclone Google Drive auto-archive runner for Review Outpost v4",
    )
    parser.add_argument(
        "--config",
        dest="config_path",
        default=argparse.SUPPRESS,
        help="Path to aigc_archive_config.json (or AIGC_ARCHIVE_CONFIG)",
    )
    parser.add_argument("--batch", dest="batch_id", help="Target pulled batch_id (defaults to latest un-acked)")
    parser.add_argument(
        "--upload-repair",
        dest="upload_repair",
        action="store_true",
        help="Upload destination=='repair' originals to repair_staging_dir without marking archived",
    )
    parser.add_argument(
        "--trash-discarded",
        dest="trash_discarded",
        action="store_true",
        help="Move destination=='discard' local files to <workspace_dir>/_trash/<batch_id>/ and purge >7d old trash",
    )
    parser.add_argument(
        "--no-ack",
        dest="no_ack",
        action="store_true",
        help="Skip calling ack and ledger backup after uploading & marking archived",
    )

    # Standard hub_client connection & workspace overrides
    parser.add_argument("--url", default=argparse.SUPPRESS, help="Worker base URL (OUTPOST_URL)")
    parser.add_argument("--agent-id", dest="agent_id", default=argparse.SUPPRESS, help="Agent slug (OUTPOST_AGENT_ID)")
    parser.add_argument("--token", default=argparse.SUPPRESS, help="Agent Bearer token (OUTPOST_TOKEN)")
    parser.add_argument(
        "--workspace-dir",
        "--home",
        dest="workspace_dir",
        default=argparse.SUPPRESS,
        help="Local persistent workspace dir (OUTPOST_HOME)",
    )
    parser.add_argument(
        "--cf-access-client-id",
        dest="cf_access_client_id",
        default=argparse.SUPPRESS,
        help="Optional Cloudflare Access Service Token Client ID (CF_ACCESS_CLIENT_ID)",
    )
    parser.add_argument(
        "--cf-access-client-secret",
        dest="cf_access_client_secret",
        default=argparse.SUPPRESS,
        help="Optional Cloudflare Access Service Token Client Secret (CF_ACCESS_CLIENT_SECRET)",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None, env: Optional[Dict[str, str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    environ = os.environ if env is None else env

    try:
        cfg_raw = getattr(args, "config_path", None) or environ.get("AIGC_ARCHIVE_CONFIG")
        if not cfg_raw:
            raise AigcArchiveError("--config <aigc_archive_config.json> (or AIGC_ARCHIVE_CONFIG) is required.")

        hub_cfg = hub_client.resolve_config(args, env=environ)
        archive_cfg = load_archive_config(cfg_raw)
        res = run_aigc_archive(
            hub_config=hub_cfg,
            archive_config=archive_cfg,
            batch_id=args.batch_id,
            upload_repair=bool(args.upload_repair),
            trash_discarded=bool(args.trash_discarded),
            run_ack=not bool(args.no_ack),
        )
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return 0
    except hub_client.AckGateError as exc:
        err = {
            "ok": False,
            "error": "ack_blocked_by_ledger_gate",
            "message": str(exc),
            "missing_items": exc.pending_items,
        }
        formatted = json.dumps(err, ensure_ascii=False, indent=2)
        print(formatted)
        print(formatted, file=sys.stderr)
        return 2
    except hub_client.PathGuardError as exc:
        err = {"ok": False, "error": "forbidden_storage_path", "message": str(exc)}
        formatted = json.dumps(err, ensure_ascii=False, indent=2)
        print(formatted)
        print(formatted, file=sys.stderr)
        return 2
    except hub_client.HttpApiError as exc:
        err = {
            "ok": False,
            "error": "http_api_error",
            "status_code": exc.status_code,
            "message": str(exc),
            "server_payload": exc.payload,
        }
        formatted = json.dumps(err, ensure_ascii=False, indent=2)
        print(formatted)
        print(formatted, file=sys.stderr)
        return 1
    except hub_client.HubClientError as exc:
        err = {"ok": False, "error": "aigc_archive_error", "message": str(exc)}
        formatted = json.dumps(err, ensure_ascii=False, indent=2)
        print(formatted)
        print(formatted, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
