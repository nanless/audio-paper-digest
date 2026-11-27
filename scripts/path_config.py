#!/usr/bin/env python3
"""Python 侧共用的项目路径，以及确保文件内容完整保存的写入辅助函数。"""

import json
import errno
import fcntl
import os
import re
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
RUNTIME_PATHS_FILE = PROJECT_ROOT / "config" / "runtime-paths.json"

_FALLBACK_RUNTIME_PATHS = {
    "dirs": {
        "data": "data",
        "current": "data/current",
        "archive": "data/archive",
        "runtime": "data/runtime",
        "logs": "logs",
    },
    "currentFiles": {
        "papers": "papers.json",
        "rawCandidates": "raw-candidates.json",
        "fetchCheckpoint": "fetch-checkpoint.json",
        "filterDecisions": "filter-decisions.json",
        "filteredPapers": "filtered-papers.json",
        "deepAnalysisResult": "deep-analysis-result.json",
        "analyzed": "analyzed.json",
    },
    "currentDirs": {
        "manualV6Production": "manual-v6",
        "visualSummaryManifests": "visual-summary-manifests",
        "digestCoverManifests": "digest-cover-manifests",
        "analysisWaivers": "analysis-waivers",
        "postPublishVisualWaivers": "post-publish-visual-waivers",
        "digestRunReports": "digest-run-reports",
        "blogReviewCheckpoints": "blog-review-checkpoints",
        "blogRepublications": "blog-republications",
        "blogPublicationActivations": "blog-publication-activations",
        "imageCache": "image-cache",
    },
    "runtimeEntries": {
        "llmAccountPoolState": "llm-account-pool.json",
        "llmUsage": "llm-usage",
        "llmUsageDaily": "llm-usage-daily",
        "llmResponseRecovery": "llm-response-recovery",
        "freshRewrites": "fresh-rewrites",
        "dailyFreshSourceRuns": "daily-fresh-source-runs",
        "dailyScoringRefreshRecovery": "daily-scoring-refresh-recovery",
        "dailyRenderObservations": "daily-render-observations",
        "dailyDeploymentObservations": "daily-deployment-observations",
        "dailyRepublications": "daily-republications",
        "dailyPodcast": "daily-podcast",
        "historicalPageInventories": "historical-page-inventories",
        "conferenceStagingSources": "conference-staging-sources",
    },
    "projectEntries": {
        "tagCatalogFile": "config/tag-catalog.json",
        "tagCatalogHistoryDir": "config/tag-catalog-history",
        "tagExplorerAssets": "web/tag-explorer",
    },
    "blogRelativePaths": {
        "defaultBasePath": "/audio-research-portal",
        "contentPosts": "content/posts",
        "researcherSidecarRoot": "static/data/papers",
    },
}


def _validate_relative_runtime_path(value, label):
    if not isinstance(value, str) or not value or "\0" in value or "\\" in value or value.startswith("/"):
        raise ValueError(f"config/runtime-paths.json 字段 {label} 必须为非空相对路径")
    parts = value.split("/")
    if any(not part or part in (".", "..") for part in parts):
        raise ValueError(f"config/runtime-paths.json 字段 {label} 包含非法路径段: {value}")
    return value


def load_runtime_paths_spec(spec_path=RUNTIME_PATHS_FILE):
    target = Path(spec_path)
    try:
        parsed = json.loads(target.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {section: dict(entries) for section, entries in _FALLBACK_RUNTIME_PATHS.items()}
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"无法读取或解析共享路径配置 {target}: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError(f"共享路径配置 {target} 必须是 JSON 对象")
    validated = {}
    for section, required_entries in _FALLBACK_RUNTIME_PATHS.items():
        raw_section = parsed.get(section)
        if not isinstance(raw_section, dict):
            raise ValueError(f"共享路径配置 {target} 缺少对象字段 {section}")
        section_copy = {}
        for key in required_entries:
            if key not in raw_section:
                raise ValueError(f"共享路径配置 {target} 缺少 {section}.{key}")
            value = raw_section[key]
            if section == "blogRelativePaths" and key == "defaultBasePath":
                if not isinstance(value, str):
                    raise ValueError(f"共享路径配置 {target} 字段 {section}.{key} 必须是字符串")
                section_copy[key] = value
            else:
                section_copy[key] = _validate_relative_runtime_path(value, f"{section}.{key}")
        for key, value in raw_section.items():
            if key not in section_copy:
                section_copy[key] = _validate_relative_runtime_path(value, f"{section}.{key}")
        validated[section] = section_copy
    return validated


def _join_relative(root, relative_path):
    return Path(root).joinpath(*str(relative_path).split("/"))


RUNTIME_PATHS = load_runtime_paths_spec()
DEFAULT_BLOG_BASE_PATH = RUNTIME_PATHS["blogRelativePaths"]["defaultBasePath"]


def resolve_blog_base_path(value=None):
    """返回经验证的站内部署前缀；根目录部署使用空前缀。"""
    value = os.environ.get('PAPER_DIGEST_BLOG_BASE_PATH', DEFAULT_BLOG_BASE_PATH) if value is None else value
    if not isinstance(value, str):
        raise ValueError('PAPER_DIGEST_BLOG_BASE_PATH 必须是站内路径')
    normalized = value.rstrip('/')
    if value.startswith('//') or (normalized and (
            not re.fullmatch(r'/[A-Za-z0-9._~/-]*', normalized)
            or '//' in normalized
            or any(part in ('.', '..') for part in normalized.split('/')))):
        raise ValueError('PAPER_DIGEST_BLOG_BASE_PATH 不是安全站内路径')
    return normalized


DATA_DIR = _join_relative(PROJECT_ROOT, RUNTIME_PATHS["dirs"]["data"])
CURRENT_DIR = _join_relative(PROJECT_ROOT, RUNTIME_PATHS["dirs"]["current"])
ARCHIVE_DIR = _join_relative(PROJECT_ROOT, RUNTIME_PATHS["dirs"]["archive"])
RUNTIME_DIR = _join_relative(PROJECT_ROOT, RUNTIME_PATHS["dirs"]["runtime"])
LOGS_DIR = _join_relative(PROJECT_ROOT, RUNTIME_PATHS["dirs"]["logs"])
LLM_ACCOUNT_POOL_STATE_FILE = _join_relative(RUNTIME_DIR, RUNTIME_PATHS["runtimeEntries"]["llmAccountPoolState"])
LLM_USAGE_DIR = _join_relative(RUNTIME_DIR, RUNTIME_PATHS["runtimeEntries"]["llmUsage"])
LLM_USAGE_DAILY_DIR = _join_relative(RUNTIME_DIR, RUNTIME_PATHS["runtimeEntries"]["llmUsageDaily"])
LLM_RESPONSE_RECOVERY_DIR = _join_relative(RUNTIME_DIR, RUNTIME_PATHS["runtimeEntries"]["llmResponseRecovery"])
FRESH_REWRITE_RUNS_DIR = _join_relative(RUNTIME_DIR, RUNTIME_PATHS["runtimeEntries"]["freshRewrites"])
DAILY_FRESH_SOURCE_RUNS_DIR = _join_relative(RUNTIME_DIR, RUNTIME_PATHS["runtimeEntries"]["dailyFreshSourceRuns"])
DAILY_SCORING_REFRESH_RECOVERY_DIR = _join_relative(RUNTIME_DIR, RUNTIME_PATHS["runtimeEntries"]["dailyScoringRefreshRecovery"])
DAILY_RENDER_OBSERVATIONS_DIR = _join_relative(RUNTIME_DIR, RUNTIME_PATHS["runtimeEntries"]["dailyRenderObservations"])
DAILY_DEPLOYMENT_OBSERVATIONS_DIR = _join_relative(RUNTIME_DIR, RUNTIME_PATHS["runtimeEntries"]["dailyDeploymentObservations"])
DAILY_REPUBLICATION_RUNS_DIR = _join_relative(RUNTIME_DIR, RUNTIME_PATHS["runtimeEntries"]["dailyRepublications"])
DAILY_PODCAST_DIR = _join_relative(RUNTIME_DIR, RUNTIME_PATHS["runtimeEntries"]["dailyPodcast"])
DAILY_REPUBLICATION_MARKER_DIRNAME = RUNTIME_PATHS["currentDirs"]["blogRepublications"]
HISTORICAL_PAGE_INVENTORY_DIR = _join_relative(RUNTIME_DIR, RUNTIME_PATHS["runtimeEntries"]["historicalPageInventories"])
CONFERENCE_STAGING_SOURCE_DIR = _join_relative(RUNTIME_DIR, RUNTIME_PATHS["runtimeEntries"]["conferenceStagingSources"])
PUBLICATION_ACTIVATION_DIRNAME = RUNTIME_PATHS["currentDirs"]["blogPublicationActivations"]
BLOG_REVIEW_CHECKPOINTS_DIR = _join_relative(CURRENT_DIR, RUNTIME_PATHS["currentDirs"]["blogReviewCheckpoints"])
# 相对仓库根目录的 Hugo 发布根。发布器只把它拼到已经校验过的
# 博客仓库或事务暂存根上。
RESEARCHER_SIDECAR_RELATIVE_ROOT = Path(*RUNTIME_PATHS["blogRelativePaths"]["researcherSidecarRoot"].split("/"))

PAPERS_FILE = _join_relative(CURRENT_DIR, RUNTIME_PATHS["currentFiles"]["papers"])
PAPERS_LEGACY_FILE = _join_relative(DATA_DIR, RUNTIME_PATHS["currentFiles"]["papers"])
RAW_CANDIDATES_FILE = _join_relative(CURRENT_DIR, RUNTIME_PATHS["currentFiles"]["rawCandidates"])
FETCH_CHECKPOINT_FILE = _join_relative(CURRENT_DIR, RUNTIME_PATHS["currentFiles"]["fetchCheckpoint"])
FILTER_DECISIONS_FILE = _join_relative(CURRENT_DIR, RUNTIME_PATHS["currentFiles"]["filterDecisions"])
FILTERED_PAPERS_FILE = _join_relative(CURRENT_DIR, RUNTIME_PATHS["currentFiles"]["filteredPapers"])
DEEP_ANALYSIS_RESULT_FILE = _join_relative(CURRENT_DIR, RUNTIME_PATHS["currentFiles"]["deepAnalysisResult"])
DEEP_ANALYSIS_RESULT_LEGACY_FILE = _join_relative(DATA_DIR, RUNTIME_PATHS["currentFiles"]["deepAnalysisResult"])
# 正式 Manual v6 流程证据按日期隔离存放在这里。发布器读取的仍是上面
# 的标准文件；那个文件引用的 spec-v6 / records-v4 证据，持久来源在
# 这个根目录。
MANUAL_V6_PRODUCTION_DIR = _join_relative(CURRENT_DIR, RUNTIME_PATHS["currentDirs"]["manualV6Production"])
VISUAL_SUMMARY_MANIFEST_DIR = _join_relative(CURRENT_DIR, RUNTIME_PATHS["currentDirs"]["visualSummaryManifests"])
# 发布后视觉资产按批次日期直接归档。调用方必须继续拼接
# <date>/visual-summaries/*.png，论文长图与汇总封面扁平归档。
VISUAL_SUMMARY_ASSET_DIR = ARCHIVE_DIR
DIGEST_COVER_MANIFEST_DIR = _join_relative(CURRENT_DIR, RUNTIME_PATHS["currentDirs"]["digestCoverManifests"])
DIGEST_COVER_ASSET_DIR = ARCHIVE_DIR
ANALYSIS_WAIVER_DIR = _join_relative(CURRENT_DIR, RUNTIME_PATHS["currentDirs"]["analysisWaivers"])
POST_PUBLISH_VISUAL_WAIVER_DIR = _join_relative(CURRENT_DIR, RUNTIME_PATHS["currentDirs"]["postPublishVisualWaivers"])
DIGEST_RUN_REPORT_DIR = _join_relative(CURRENT_DIR, RUNTIME_PATHS["currentDirs"]["digestRunReports"])
ANALYZED_FILE = _join_relative(CURRENT_DIR, RUNTIME_PATHS["currentFiles"]["analyzed"])
ANALYZED_LEGACY_FILE = _join_relative(DATA_DIR, RUNTIME_PATHS["currentFiles"]["analyzed"])


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
    archived = Path(archive_dir) / target_date / RUNTIME_PATHS["currentFiles"]["deepAnalysisResult"]
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
    existing_mode = None
    try:
        existing_stat = target.lstat()
        if stat.S_ISREG(existing_stat.st_mode):
            existing_mode = stat.S_IMODE(existing_stat.st_mode)
    except FileNotFoundError:
        existing_mode = None
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
            if final_mode is not None and hasattr(os, "fchmod"):
                os.fchmod(handle.fileno(), final_mode)
            os.fsync(handle.fileno())
        if final_mode is not None and not hasattr(os, "fchmod"):
            os.chmod(temp_path, final_mode)
        os.replace(temp_path, target)
        temp_path = None
        try:
            directory_fd = os.open(target.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError as exc:
            # 只兼容明确不支持目录同步的文件系统；真实 I/O 或权限错误须上报。
            if exc.errno not in {errno.EINVAL, errno.ENOTSUP, errno.EOPNOTSUPP, errno.EPERM, errno.EACCES, errno.EBADF}:
                raise
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


class _LockSnapshotChanged(RuntimeError):
    """同一文件锁的创建或续租正在更新内容，等待方需要重新读取。"""


def _lock_identity(info):
    return info.st_dev, info.st_ino


def _lock_open_directory(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0)
                 | getattr(os, 'O_NOFOLLOW', 0))
    try:
        opened = os.fstat(fd)
        named = path.lstat()
        if not stat.S_ISDIR(opened.st_mode) or not stat.S_ISDIR(named.st_mode) \
                or opened.st_uid != os.getuid() or _lock_identity(opened) != _lock_identity(named):
            raise RuntimeError(f'文件锁目录身份发生变化：{path}')
        return fd
    except BaseException:
        os.close(fd)
        raise


def _lock_read_owner(directory_fd):
    fd = os.open('owner.json', os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
                 | getattr(os, 'O_NONBLOCK', 0), dir_fd=directory_fd)
    try:
        opened = os.fstat(fd)
        named = os.stat('owner.json', dir_fd=directory_fd, follow_symlinks=False)
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1 \
                or opened.st_uid != os.getuid() or _lock_identity(opened) != _lock_identity(named):
            raise RuntimeError('文件锁持有人记录不是本人拥有的普通单链接文件')
        data = bytearray()
        while len(data) <= 16384:
            chunk = os.read(fd, min(4096, 16385 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        after = os.fstat(fd)
        named = os.stat('owner.json', dir_fd=directory_fd, follow_symlinks=False)
        signature = lambda info: (_lock_identity(info), info.st_size, info.st_mtime_ns,
                                  info.st_ctime_ns, info.st_nlink)
        if len(data) > 16384 or after.st_size > 16384 or named.st_size > 16384:
            raise RuntimeError('文件锁持有人记录超过大小上限')
        for info in (after, named):
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 \
                    or info.st_uid != os.getuid() or _lock_identity(info) != _lock_identity(opened):
                raise RuntimeError('读取文件锁持有人记录时，文件身份或链接发生变化')
        if signature(opened) != signature(after) or signature(after) != signature(named) \
                or len(data) != after.st_size:
            raise _LockSnapshotChanged('读取文件锁持有人记录时，同一文件的内容正在更新')
        try:
            record = json.loads(data)
        except (ValueError, UnicodeError):
            record = None
        named = os.stat('owner.json', dir_fd=directory_fd, follow_symlinks=False)
        if not stat.S_ISREG(named.st_mode) or named.st_nlink != 1 \
                or named.st_uid != os.getuid() or _lock_identity(after) != _lock_identity(named):
            raise RuntimeError('解析文件锁持有人记录时，路径对应的文件发生变化')
        if named.st_size > 16384:
            raise RuntimeError('文件锁持有人记录超过大小上限')
        if signature(after) != signature(named):
            raise _LockSnapshotChanged('解析文件锁持有人记录时，同一文件的内容正在更新')
        return {'identity': _lock_identity(opened), 'mtime': opened.st_mtime_ns,
                'ctime': opened.st_ctime_ns, 'bytes': bytes(data),
                'record': record if isinstance(record, dict) else None}
    finally:
        os.close(fd)


def _lock_snapshot(lock_path):
    fd = _lock_open_directory(lock_path)
    try:
        info = os.fstat(fd)
        entries = sorted(os.listdir(fd))
        if entries not in ([], ['owner.json']):
            raise RuntimeError(f'文件锁目录含未知文件，已保留：{lock_path}：{entries}')
        owner = _lock_read_owner(fd) if entries else None
        after = os.fstat(fd)
        named = lock_path.lstat()
        if not stat.S_ISDIR(named.st_mode) or named.st_uid != os.getuid() \
                or _lock_identity(named) != _lock_identity(info):
            raise RuntimeError(f'读取文件锁期间目录发生变化：{lock_path}')
        if info.st_mtime_ns != after.st_mtime_ns:
            if sorted(os.listdir(fd)) not in ([], ['owner.json']):
                raise RuntimeError(f'文件锁目录含未知文件，已保留：{lock_path}')
            raise _LockSnapshotChanged(f'读取文件锁期间，持有人记录正在创建或移除：{lock_path}')
        return {'path': lock_path, 'identity': _lock_identity(info),
                'mtime': info.st_mtime_ns, 'entries': entries, 'owner': owner}
    finally:
        os.close(fd)


def _lock_snapshot_reclaimable(snapshot, stale_seconds):
    owner = snapshot['owner']
    record = (owner or {}).get('record') or {}
    newest = max(snapshot['mtime'], (owner or {}).get('mtime', 0))
    pid = record.get('pid')
    if record.get('hostname') == socket.gethostname() and type(pid) is int and pid > 0:
        from blog_repository_lock import BOOT_TIME_DRIFT_TOLERANCE_SECONDS, _boot_time_seconds, _pid_start_time
        recorded_boot = record.get('bootTime')
        if type(recorded_boot) is int:
            current_boot = _boot_time_seconds()
            if current_boot is not None and abs(current_boot - recorded_boot) > BOOT_TIME_DRIFT_TOLERANCE_SECONDS:
                return True
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            return False
        recorded_start = record.get('pidStartTime')
        if isinstance(recorded_start, str) and recorded_start:
            actual = _pid_start_time(pid)
            if actual is not None and actual != recorded_start:
                return True
        return False
    return time.time() - newest / 1_000_000_000 > stale_seconds


def _lock_reclaimable(lock_path, stale_seconds):
    try:
        return _lock_snapshot_reclaimable(_lock_snapshot(lock_path), stale_seconds)
    except FileNotFoundError:
        return True


def _lock_remove(snapshot):
    """只删除同一目录和同一持有人记录；替换文件、额外文件都保留。"""
    path = snapshot['path']
    try:
        if _lock_snapshot(path) != snapshot:
            return False
        fd = _lock_open_directory(path)
    except FileNotFoundError:
        return False
    try:
        if _lock_identity(os.fstat(fd)) != snapshot['identity'] \
                or sorted(os.listdir(fd)) != snapshot['entries']:
            return False
        if snapshot['owner'] is not None:
            owner_fd = os.open('owner.json', os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
                               | getattr(os, 'O_NONBLOCK', 0), dir_fd=fd)
            try:
                # 续租与最终回收共用原持有人 inode 的进程锁，防止检查后心跳更新。
                fcntl.flock(owner_fd, fcntl.LOCK_EX)
                if _lock_identity(os.fstat(owner_fd)) != snapshot['owner']['identity'] \
                        or _lock_read_owner(fd) != snapshot['owner']:
                    return False
                os.unlink('owner.json', dir_fd=fd)
            finally:
                os.close(owner_fd)
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        if _lock_identity(path.lstat()) != snapshot['identity']:
            return False
        path.rmdir()
    except FileNotFoundError:
        return False
    return True


def _lock_write_all(fd, data):
    offset = 0
    while offset < len(data):
        written = os.write(fd, data[offset:])
        if written <= 0:
            raise OSError('文件锁持有人记录没有完整写入')
        offset += written


def _lock_create(lock_path, stale_seconds):
    lock_path.mkdir(mode=0o700)
    created = _lock_identity(lock_path.lstat())
    fd = None
    owner_identity = None
    try:
        fd = _lock_open_directory(lock_path)
        if _lock_identity(os.fstat(fd)) != created:
            raise RuntimeError(f'新建文件锁目录被替换：{lock_path}')
        os.fchmod(fd, 0o700)
        owner_fd = os.open('owner.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL
                           | getattr(os, 'O_NOFOLLOW', 0), 0o600, dir_fd=fd)
        try:
            owner_identity = _lock_identity(os.fstat(owner_fd))
            os.fchmod(owner_fd, 0o600)
            acquired_at = datetime_now_iso()
            pid = os.getpid()
            record = {'pid': pid, 'hostname': socket.gethostname(),
                      'token': uuid.uuid4().hex, 'acquiredAt': acquired_at,
                      'heartbeatAt': acquired_at, 'leaseSeconds': stale_seconds}
            from blog_repository_lock import _boot_time_seconds, _pid_start_time
            boot_time = _boot_time_seconds()
            if boot_time is not None:
                record['bootTime'] = boot_time
            pid_start = _pid_start_time(pid)
            if pid_start is not None:
                record['pidStartTime'] = pid_start
            data = (json.dumps(record, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
            _lock_write_all(owner_fd, data)
            os.fsync(owner_fd)
        finally:
            os.close(owner_fd)
        os.fsync(fd)
        snapshot = _lock_snapshot(lock_path)
        if snapshot['identity'] != created or snapshot['owner']['identity'] != owner_identity \
                or snapshot['owner']['bytes'] != data:
            raise RuntimeError(f'新建文件锁持有人记录发生变化：{lock_path}')
        return snapshot
    except BaseException as original:
        # 创建失败也不能按路径递归删锁：目录可能已被别的进程替换。
        try:
            snapshot = _lock_snapshot(lock_path)
            if snapshot['identity'] == created and (snapshot['owner'] is None
                    or snapshot['owner']['identity'] == owner_identity):
                _lock_remove(snapshot)
        except FileNotFoundError:
            pass
        except Exception as cleanup_error:
            raise original from cleanup_error
        raise
    finally:
        if fd is not None:
            os.close(fd)


def _lock_renew(snapshot):
    path = snapshot['path']
    if _lock_snapshot(path) != snapshot:
        raise RuntimeError(f'文件锁续租前已失去所有权：{path}')
    directory_fd = _lock_open_directory(path)
    try:
        if _lock_identity(os.fstat(directory_fd)) != snapshot['identity']:
            raise RuntimeError(f'文件锁续租前目录被替换：{path}')
        fd = os.open('owner.json', os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0)
                     | getattr(os, 'O_NONBLOCK', 0), dir_fd=directory_fd)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            if _lock_identity(os.fstat(fd)) != snapshot['owner']['identity'] \
                    or _lock_read_owner(directory_fd) != snapshot['owner']:
                raise RuntimeError(f'文件锁续租前持有人记录被替换：{path}')
            record = dict(snapshot['owner']['record'])
            record['heartbeatAt'] = datetime_now_iso()
            data = (json.dumps(record, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
            _lock_write_all(fd, data)
            os.ftruncate(fd, len(data))
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        os.close(directory_fd)
    renewed = _lock_snapshot(path)
    if renewed['identity'] != snapshot['identity'] \
            or renewed['owner']['identity'] != snapshot['owner']['identity'] \
            or renewed['owner']['bytes'] != data:
        raise RuntimeError(f'文件锁续租期间已失去所有权：{path}')
    return renewed


def _lock_acquire(lock_path, timeout_seconds, stale_seconds):
    started = time.monotonic()
    reclaim_path = lock_path.with_name(f'{lock_path.name}.reclaim')
    while True:
        try:
            try:
                marker = _lock_snapshot(reclaim_path)
            except FileNotFoundError:
                marker = None
            if marker is not None:
                if _lock_snapshot_reclaimable(marker, stale_seconds):
                    _lock_remove(marker)
                    continue
            else:
                try:
                    return _lock_create(lock_path, stale_seconds)
                except FileExistsError:
                    pass
                try:
                    stale = _lock_snapshot(lock_path)
                except FileNotFoundError:
                    continue
                if _lock_snapshot_reclaimable(stale, stale_seconds):
                    guard = None
                    try:
                        guard = _lock_create(reclaim_path, stale_seconds)
                        current = _lock_snapshot(lock_path)
                        if current == stale and _lock_snapshot_reclaimable(current, stale_seconds):
                            _lock_remove(current)
                    except (FileExistsError, FileNotFoundError):
                        pass
                    finally:
                        if guard is not None:
                            _lock_remove(guard)
                    continue
        except _LockSnapshotChanged:
            pass
        if time.monotonic() - started >= timeout_seconds:
            raise TimeoutError(f'等待文件锁超时：{lock_path}')
        time.sleep(0.05)


@contextmanager
def file_lock(path, *, timeout_seconds=30, stale_seconds=2 * 60 * 60):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    lock_path = Path(f'{target}.lock')
    snapshot = _lock_acquire(lock_path, timeout_seconds, stale_seconds)
    stop = threading.Event()
    state = {'snapshot': snapshot, 'error': None}
    interval = max(0.05, min(30.0, stale_seconds / 3.0))

    def renew_lease():
        while not stop.wait(interval):
            try:
                state['snapshot'] = _lock_renew(state['snapshot'])
            except Exception as exc:
                state['error'] = exc
                return

    thread = threading.Thread(target=renew_lease, name=f'file-lock-heartbeat-{os.getpid()}', daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join()
        _lock_remove(state['snapshot'])
    if state['error'] is not None:
        raise RuntimeError(f'文件锁续租失败：{lock_path}') from state['error']


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
