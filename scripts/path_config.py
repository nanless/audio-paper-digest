#!/usr/bin/env python3
"""Python 侧共用的项目路径，以及可靠落盘的文件写入辅助函数。"""

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
DAILY_FRESH_SOURCE_RUNS_DIR = DATA_DIR / "runtime" / "daily-fresh-source-runs"
HISTORICAL_PAGE_INVENTORY_DIR = DATA_DIR / "runtime" / "historical-page-inventories"
CONFERENCE_STAGING_SOURCE_DIR = DATA_DIR / "runtime" / "conference-staging-sources"
PUBLICATION_ACTIVATION_DIRNAME = 'blog-publication-activations'
# 相对仓库根目录的 Hugo 发布根。发布器只把它拼到已经校验过的
# 博客仓库或事务暂存根上。
RESEARCHER_SIDECAR_RELATIVE_ROOT = Path("static") / "data" / "papers"

PAPERS_FILE = CURRENT_DIR / "papers.json"
PAPERS_LEGACY_FILE = DATA_DIR / "papers.json"
RAW_CANDIDATES_FILE = CURRENT_DIR / "raw-candidates.json"
FILTER_DECISIONS_FILE = CURRENT_DIR / "filter-decisions.json"
FILTERED_PAPERS_FILE = CURRENT_DIR / "filtered-papers.json"
DEEP_ANALYSIS_RESULT_FILE = CURRENT_DIR / "deep-analysis-result.json"
DEEP_ANALYSIS_RESULT_LEGACY_FILE = DATA_DIR / "deep-analysis-result.json"
# 正式 Manual v6 流程证据按日期隔离存放在这里。发布器读取的仍是上面
# 的标准文件；那个文件引用的 spec-v6 / records-v4 证据，持久来源在
# 这个根目录。
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
    """解析默认的发布输入路径，优先使用日期精确的归档。

    当前/旧版数据只有在恰好是单日期批次时才使用。若它已经翻到别的批次
    或混合批次，则优先用受控的日期归档。没有归档时返回常规的当前/旧版
    路径，让调用方按既有的数据校验逻辑按失败处理。

    只有「文件不在」才回退到归档。文件在却读不出来、或者里面的批次日期
    不合法，说明这份当前结果已经坏了；此时直接报错，不拿同日归档顶替。
    顶替的后果是发布器把归档里的旧字节当成目标日期的输入发出去，读文件的
    人无从察觉。
    """
    target_date = validate_date_component(target_date)
    current = Path(resolve_deep_analysis_result_path(Path(current_path), Path(legacy_path)))
    if current.exists() and not current.is_file():
        raise ValueError(f'当前分析结果路径存在但不是文件: {current}')
    if current.is_file():
        try:
            raw = json.loads(current.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise ValueError(f'当前分析结果存在但读不出来: {current}（{exc}）') from exc
        papers = raw.get("papers") if isinstance(raw, dict) else raw
        if papers is not None and not isinstance(papers, list):
            raise ValueError(f'当前分析结果的 papers 不是数组: {current}')
        dates = set()
        for paper in papers or []:
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
            if value is None:
                continue
            try:
                dates.add(validate_date_component(value))
            except ValueError as exc:
                label = paper.get("arxivId") or paper.get("id") or '<未知论文>'
                raise ValueError(
                    f'当前分析结果里 {label} 的批次日期不合法: {value!r}（{current}）'
                ) from exc
        if papers and dates == {target_date}:
            return current
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


def atomic_write_bytes(path, content, *, mode=None, dir_mode=None):
    """可靠地替换二进制文件，不暴露写了一半的目标文件。

    只承担「替换型」写入：同目录临时文件 + fsync + 原子改名 + 目录 fsync。
    带封锁性保证的写入不能走这里，各有独有前置契约，见
    publish-conference.py 的 replace_exact（目标必须是普通单链接非符号链接、
    固定 0644）与 llm_usage.py 的 write_llm_usage_event（逐级目录反符号链接、
    按 uuid4 只新增不替换）。

    mode 为 None 时继承目标原有权限位；新建文件不额外 chmod，沿用进程 umask
    下的默认权限。dir_mode 只在需要给新建父目录限定权限时传入。
    """
    target = Path(path)
    if dir_mode is None:
        target.parent.mkdir(parents=True, exist_ok=True)
    else:
        # 只影响新建目录，已存在的目录不动。
        target.parent.mkdir(parents=True, exist_ok=True, mode=dir_mode)
    existing_mode = stat.S_IMODE(target.stat().st_mode) if target.exists() else None
    final_mode = mode if mode is not None else existing_mode
    raw = bytes(content) if isinstance(content, (bytearray, memoryview)) else content
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=target.parent,
            prefix=f".{target.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temp_path = Path(handle.name)
            handle.write(raw)
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
            # 有些文件系统不支持对目录做 fsync。
            pass
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def atomic_write_text(path, content, encoding="utf-8", mode=None, dir_mode=None):
    """可靠地替换文本文件，不暴露写了一半的目标文件。"""
    atomic_write_bytes(path, content.encode(encoding), mode=mode, dir_mode=dir_mode)


def atomic_write_json(path, data, *, ensure_ascii=False, indent=2, mode=None):
    """序列化 JSON，并原子替换目标文件。"""
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
