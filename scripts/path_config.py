#!/usr/bin/env python3
"""Shared Python-side project paths and durable file-write helpers."""

import json
import os
import re
import shutil
import socket
import stat
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
CURRENT_DIR = DATA_DIR / "current"
ARCHIVE_DIR = DATA_DIR / "archive"
LOGS_DIR = PROJECT_ROOT / "logs"
LLM_ACCOUNT_POOL_STATE_FILE = DATA_DIR / "runtime" / "llm-account-pool.json"
LLM_USAGE_DIR = DATA_DIR / "runtime" / "llm-usage"
FRESH_REWRITE_RUNS_DIR = DATA_DIR / "runtime" / "fresh-rewrites"
HISTORICAL_PAGE_INVENTORY_DIR = DATA_DIR / "runtime" / "historical-page-inventories"
CONFERENCE_STAGING_SOURCE_DIR = DATA_DIR / "runtime" / "conference-staging-sources"
PUBLICATION_ACTIVATION_DIRNAME = 'blog-publication-activations'
# Repository-relative Hugo publication root. The publisher joins this only to
# its already validated blog repo or transaction staging root.
RESEARCHER_SIDECAR_RELATIVE_ROOT = Path("static") / "data" / "papers"

PAPERS_FILE = CURRENT_DIR / "papers.json"
PAPERS_LEGACY_FILE = DATA_DIR / "papers.json"
RAW_CANDIDATES_FILE = CURRENT_DIR / "raw-candidates.json"
FILTER_DECISIONS_FILE = CURRENT_DIR / "filter-decisions.json"
FILTERED_PAPERS_FILE = CURRENT_DIR / "filtered-papers.json"
DEEP_ANALYSIS_RESULT_FILE = CURRENT_DIR / "deep-analysis-result.json"
DEEP_ANALYSIS_RESULT_LEGACY_FILE = DATA_DIR / "deep-analysis-result.json"
# Formal Manual v6 workflow evidence is date-isolated here.  The publisher
# still consumes the standard canonical file above; this root is the durable
# source of the spec-v6 / records-v4 evidence referenced by that canonical.
MANUAL_V6_PRODUCTION_DIR = CURRENT_DIR / "manual-v6"
VISUAL_SUMMARY_MANIFEST_DIR = CURRENT_DIR / "visual-summary-manifests"
# 发布后视觉资产按批次日期直接归档。调用方必须继续拼接
# <date>/visual-summaries/*.png，论文长图与汇总封面扁平归档。
VISUAL_SUMMARY_ASSET_DIR = ARCHIVE_DIR
DIGEST_COVER_MANIFEST_DIR = CURRENT_DIR / "digest-cover-manifests"
DIGEST_COVER_ASSET_DIR = ARCHIVE_DIR
ANALYZED_FILE = CURRENT_DIR / "analyzed.json"
ANALYZED_LEGACY_FILE = DATA_DIR / "analyzed.json"


def resolve_deep_analysis_result_path(current_path=DEEP_ANALYSIS_RESULT_FILE, legacy_path=DEEP_ANALYSIS_RESULT_LEGACY_FILE):
    if current_path.exists() or not legacy_path.exists():
        return current_path
    return legacy_path


def resolve_deep_analysis_result_for_date(
    target_date,
    current_path=DEEP_ANALYSIS_RESULT_FILE,
    legacy_path=DEEP_ANALYSIS_RESULT_LEGACY_FILE,
    archive_dir=ARCHIVE_DIR,
):
    """Resolve a default publish input while preferring an exact dated archive.

    Current/legacy data is used when it is an exact single-date batch.  When it
    has already rolled to another or mixed batch, the controlled dated archive
    is preferred.  If no archive exists, the normal current/legacy path is
    returned so the caller can fail closed with its ordinary data validation.
    """
    target_date = validate_date_component(target_date)
    current = Path(resolve_deep_analysis_result_path(Path(current_path), Path(legacy_path)))
    if current.is_file():
        try:
            raw = json.loads(current.read_text(encoding="utf-8"))
            papers = raw.get("papers") if isinstance(raw, dict) else raw
            dates = set()
            if isinstance(papers, list):
                for paper in papers:
                    if not isinstance(paper, dict):
                        continue
                    value = paper.get("fetchBatchDate") or paper.get("batchDate")
                    if value is None and isinstance(paper.get("fetchedAt"), str):
                        match = re.fullmatch(
                            r"(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d"
                            r"(?:\.\d{3})?\+08:00",
                            paper["fetchedAt"],
                        )
                        value = match.group(1) if match else None
                    if value is not None:
                        dates.add(validate_date_component(value))
            if papers and dates == {target_date}:
                return current
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
            pass
    archived = Path(archive_dir) / target_date / "deep-analysis-result.json"
    if archived.is_file():
        return archived
    return current


def validate_date_component(target_date):
    value = str(target_date or '')
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError(f'日期必须为 YYYY-MM-DD: {value!r}')
    try:
        datetime.strptime(value, '%Y-%m-%d')
    except ValueError as exc:
        raise ValueError(f'日期非法: {value!r}') from exc
    return value


def xiaohongshu_markdown_path(target_date, suffix):
    target_date = validate_date_component(target_date)
    if not re.fullmatch(r'[A-Za-z0-9_-]+', str(suffix or '')):
        raise ValueError(f'小红书输出后缀非法: {suffix!r}')
    return CURRENT_DIR / f"xiaohongshu-{target_date}-{suffix}.md"


def xiaohongshu_oneliner_cache_path(target_date):
    target_date = validate_date_component(target_date)
    return CURRENT_DIR / f"xiaohongshu-oneliners-{target_date}.json"


def wechat_preview_path(target_date):
    return CURRENT_DIR / f"wechat-preview-{target_date}.html"


def backfill_result_path():
    return DATA_DIR / "backfill-result.json"


def atomic_write_text(path, content, encoding="utf-8", mode=None):
    """Durably replace a text file without exposing a partially written target."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    existing_mode = stat.S_IMODE(target.stat().st_mode) if target.exists() else None
    final_mode = mode if mode is not None else existing_mode
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding=encoding,
            dir=target.parent,
            prefix=f".{target.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temp_path = Path(handle.name)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        if final_mode is not None:
            os.chmod(temp_path, final_mode)
        os.replace(temp_path, target)
        temp_path = None
        try:
            directory_fd = os.open(target.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            # Some filesystems do not support fsync on directories.
            pass
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def atomic_write_json(path, data, *, ensure_ascii=False, indent=2, mode=None):
    """Serialize JSON and atomically replace the destination file."""
    content = json.dumps(data, ensure_ascii=ensure_ascii, indent=indent) + "\n"
    atomic_write_text(path, content, mode=mode)


def read_json_strict(path, *, allow_missing=False):
    target = Path(path)
    try:
        with target.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        if allow_missing:
            return None
        raise
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"JSON 文件损坏或不可读，已阻止覆盖 {target}: {exc}") from exc
    if not isinstance(data, (dict, list)):
        raise RuntimeError(f"JSON 文件顶层必须是对象或数组，已阻止覆盖 {target}")
    return data


def _lock_reclaimable(lock_path, stale_seconds):
    try:
        owner_path = lock_path / "owner.json"
        mtimes = [lock_path.stat().st_mtime]
        if owner_path.exists():
            mtimes.append(owner_path.stat().st_mtime)
        age = time.time() - max(mtimes)
    except FileNotFoundError:
        return True
    try:
        owner = json.loads((lock_path / "owner.json").read_text(encoding="utf-8"))
        if owner.get("hostname") == socket.gethostname() and isinstance(owner.get("pid"), int):
            try:
                os.kill(owner["pid"], 0)
            except ProcessLookupError:
                return True
            except PermissionError:
                return False
            return False
        if owner.get("hostname"):
            # 远端 PID 无法判活；以持续续期的 lease 为准，避免永久死锁。
            return age > stale_seconds
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        pass
    return age > stale_seconds


@contextmanager
def file_lock(path, *, timeout_seconds=30, stale_seconds=2 * 60 * 60):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    lock_path = Path(f"{target}.lock")
    owner_token = uuid.uuid4().hex
    acquired_at = datetime_now_iso()
    heartbeat_stop = threading.Event()
    heartbeat_thread = None
    started = time.monotonic()
    while True:
        try:
            lock_path.mkdir()
            atomic_write_json(lock_path / "owner.json", {
                "pid": os.getpid(),
                "hostname": socket.gethostname(),
                "token": owner_token,
                "acquiredAt": acquired_at,
                "heartbeatAt": acquired_at,
                "leaseSeconds": stale_seconds,
            }, mode=0o600)
            break
        except FileExistsError:
            if _lock_reclaimable(lock_path, stale_seconds):
                shutil.rmtree(lock_path, ignore_errors=True)
                continue
            if time.monotonic() - started >= timeout_seconds:
                raise TimeoutError(f"等待文件锁超时: {lock_path}")
            time.sleep(0.05)
        except Exception:
            shutil.rmtree(lock_path, ignore_errors=True)
            raise

    heartbeat_interval = max(0.05, min(30.0, stale_seconds / 3.0))

    def renew_lease():
        while not heartbeat_stop.wait(heartbeat_interval):
            try:
                owner_path = lock_path / "owner.json"
                owner = json.loads(owner_path.read_text(encoding="utf-8"))
                if owner.get("token") != owner_token:
                    return
                owner["heartbeatAt"] = datetime_now_iso()
                atomic_write_json(owner_path, owner, mode=0o600)
            except (FileNotFoundError, OSError, json.JSONDecodeError):
                return

    heartbeat_thread = threading.Thread(
        target=renew_lease,
        name=f"file-lock-heartbeat-{owner_token[:8]}",
        daemon=True,
    )
    heartbeat_thread.start()
    try:
        yield
    finally:
        heartbeat_stop.set()
        heartbeat_thread.join(timeout=max(1.0, heartbeat_interval * 2))
        try:
            owner = json.loads((lock_path / "owner.json").read_text(encoding="utf-8"))
            if owner.get("token") == owner_token:
                shutil.rmtree(lock_path, ignore_errors=True)
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            pass


def datetime_now_iso():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def update_json_file_locked(path, updater, *, allow_missing=True, expected_generation=None):
    target = Path(path)
    with file_lock(target):
        current = read_json_strict(target, allow_missing=allow_missing)
        current_generation = current.get("generation", 0) if isinstance(current, dict) else 0
        if expected_generation is not None and current_generation != expected_generation:
            raise RuntimeError(
                f"generation 冲突: 期望 {expected_generation}，当前 {current_generation}，已拒绝陈旧快照覆盖"
            )
        updated = updater(current)
        if updated is None:
            return current
        if isinstance(updated, dict):
            updated = dict(updated)
            updated["generation"] = current_generation + 1
        atomic_write_json(target, updated)
        return updated


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('path_config.py')
