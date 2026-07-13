#!/usr/bin/env python3
"""Shared Python-side project paths and durable file-write helpers."""

import json
import os
import re
import shutil
import socket
import stat
import tempfile
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

PAPERS_FILE = CURRENT_DIR / "papers.json"
PAPERS_LEGACY_FILE = DATA_DIR / "papers.json"
RAW_CANDIDATES_FILE = CURRENT_DIR / "raw-candidates.json"
FILTER_DECISIONS_FILE = CURRENT_DIR / "filter-decisions.json"
FILTERED_PAPERS_FILE = CURRENT_DIR / "filtered-papers.json"
DEEP_ANALYSIS_RESULT_FILE = CURRENT_DIR / "deep-analysis-result.json"
DEEP_ANALYSIS_RESULT_LEGACY_FILE = DATA_DIR / "deep-analysis-result.json"
ANALYZED_FILE = CURRENT_DIR / "analyzed.json"
ANALYZED_LEGACY_FILE = DATA_DIR / "analyzed.json"


def resolve_deep_analysis_result_path(current_path=DEEP_ANALYSIS_RESULT_FILE, legacy_path=DEEP_ANALYSIS_RESULT_LEGACY_FILE):
    if current_path.exists() or not legacy_path.exists():
        return current_path
    return legacy_path


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
        age = time.time() - lock_path.stat().st_mtime
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
            # 共享目录上的远端 PID 无法由本机可靠判活，不按时间擅自删除。
            return False
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        pass
    return age > stale_seconds


@contextmanager
def file_lock(path, *, timeout_seconds=30, stale_seconds=2 * 60 * 60):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    lock_path = Path(f"{target}.lock")
    owner_token = uuid.uuid4().hex
    started = time.monotonic()
    while True:
        try:
            lock_path.mkdir()
            atomic_write_json(lock_path / "owner.json", {
                "pid": os.getpid(),
                "hostname": socket.gethostname(),
                "token": owner_token,
                "acquiredAt": datetime_now_iso(),
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
    try:
        yield
    finally:
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
