#!/usr/bin/env python3
"""博客 Git 发布事务、索引与提交树精确字节校验、回滚快照与远端 OID 验证。"""

from __future__ import annotations

if __name__ == '__main__':
    import sys as _sys
    from pathlib import Path as _Path
    _scripts_dir = str(_Path(__file__).resolve().parent)
    if _scripts_dir not in _sys.path:
        _sys.path.insert(0, _scripts_dir)
    from runtime_guard import require_external_runtime
    require_external_runtime(__file__)
    raise SystemExit('This pure helper is imported by the normal publisher, not a direct CLI.')

import datetime
import hashlib
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
from collections.abc import Mapping
from pathlib import Path

_SHARED_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SHARED_SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SHARED_SCRIPTS_DIR)

from project_env import VCS_CHILD_ENV_KEYS, build_child_process_env  # noqa: E402
from publish_common import PublishDataValidationError  # noqa: E402

GIT_LOCAL_TIMEOUT_SECONDS = 30
GIT_COMMIT_TIMEOUT_SECONDS = 180
GIT_NETWORK_TIMEOUT_SECONDS = 180
MANUAL_REVIEW_MODE = 'manual_complete'


def _default_git_env() -> dict[str, str]:
    return build_child_process_env(allowed_keys=VCS_CHILD_ENV_KEYS)


def _hook(hooks: Mapping | None, name: str, explicit=None, default=None):
    if explicit is not None:
        return explicit
    if hooks is not None and name in hooks:
        return hooks[name]
    return default


def _default_bounded_positive_seconds(env_name: str, default: int, minimum: int, maximum: int) -> int:
    raw = str(os.environ.get(env_name, default)).strip()
    try:
        value = int(raw)
    except ValueError:
        value = default
    return min(maximum, max(minimum, value))


def _default_atomic_write_bytes(path, content: bytes, mode: int | None = None) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    existing_mode = stat.S_IMODE(target.stat().st_mode) if target.exists() else None
    final_mode = mode if mode is not None else existing_mode
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=target.parent, prefix=f'.{target.name}.', suffix='.tmp', delete=False,
        ) as handle:
            temp_path = Path(handle.name)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        if final_mode is not None:
            os.chmod(temp_path, final_mode)
        os.replace(temp_path, target)
        temp_path = None
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def validate_git_publish_branch(*, run_git=None, error_cls=None, hooks: Mapping | None = None) -> str:
    """只有博客仓库的 main 分支才允许正式发布。"""
    git_runner = _hook(hooks, '_run_git', run_git)
    err_cls = _hook(hooks, 'PublishDataValidationError', error_cls, PublishDataValidationError)
    branch = git_runner(
        ['symbolic-ref', '--quiet', '--short', 'HEAD'], text=True,
    )
    current = branch.stdout.strip() if branch.returncode == 0 else '<detached HEAD>'
    if current != 'main':
        raise err_cls(
            f'正式发布要求博客仓库当前分支为 main，当前为 {current}'
        )
    head = git_runner(
        ['rev-parse', '--verify', 'HEAD'], text=True, check=True,
    ).stdout.strip()
    if not re.fullmatch(r'[0-9a-fA-F]{40,64}', head):
        raise err_cls(f'无法验证博客仓库 HEAD: {head!r}')
    return head.lower()


def capture_git_publish_state(
    paths,
    *,
    git_relative_manifest=None,
    validate_branch=None,
    run_git=None,
    blog_repo=None,
    hooks: Mapping | None = None,
) -> dict:
    """记录安装前的 Git、索引和工作树状态，供 add 与 commit 回滚。"""
    rel_manifest_fn = _hook(hooks, '_git_relative_manifest', git_relative_manifest)
    if validate_branch is not None:
        branch_fn = validate_branch
    elif run_git is not None:
        branch_fn = lambda: validate_git_publish_branch(run_git=run_git, hooks=hooks)
    else:
        branch_fn = _hook(
            hooks, 'validate_git_publish_branch', None,
            lambda: validate_git_publish_branch(hooks=hooks),
        )
    git_runner = _hook(hooks, '_run_git', run_git)
    repo_value = _hook(hooks, 'BLOG_REPO', blog_repo, '.')
    manifest = rel_manifest_fn(paths)
    head = branch_fn()
    index_tree = git_runner(
        ['write-tree'], text=True, check=True,
    ).stdout.strip()
    snapshots = {}
    repo = Path(repo_value).expanduser().resolve()
    for item in manifest:
        path = repo / item
        snapshots[path] = (
            {'content': path.read_bytes(), 'mode': path.stat().st_mode & 0o777}
            if path.exists() else None
        )
    return {
        'head': head,
        'index_tree': index_tree,
        'snapshots': snapshots,
    }


def restore_git_publish_state(
    state,
    *,
    run_git=None,
    atomic_write_bytes=None,
    hooks: Mapping | None = None,
) -> None:
    """按需恢复 HEAD、完整索引，以及清单涉及的工作树文件。"""
    if not state:
        return
    git_runner = _hook(hooks, '_run_git', run_git)
    write_bytes = _hook(hooks, '_atomic_write_bytes', atomic_write_bytes, _default_atomic_write_bytes)
    current = git_runner(
        ['rev-parse', '--verify', 'HEAD'], text=True, check=True,
    ).stdout.strip().lower()
    original = state['head'].lower()
    if current != original:
        git_runner(
            ['update-ref', 'refs/heads/main', original, current], check=True,
        )
    git_runner(
        ['read-tree', state['index_tree']], check=True,
    )
    for path, snapshot in state['snapshots'].items():
        if snapshot is None:
            path.unlink(missing_ok=True)
        else:
            write_bytes(path, snapshot['content'], mode=snapshot['mode'])


def validate_git_index(
    paths,
    *,
    git_relative_manifest=None,
    run_git=None,
    error_cls=None,
    hooks: Mapping | None = None,
) -> None:
    rel_manifest_fn = _hook(hooks, '_git_relative_manifest', git_relative_manifest)
    git_runner = _hook(hooks, '_run_git', run_git)
    err_cls = _hook(hooks, 'PublishDataValidationError', error_cls, PublishDataValidationError)
    allowed = set(rel_manifest_fn(paths))
    result = git_runner(
        ['diff', '--cached', '--name-only', '-z'], check=True,
    )
    staged = {item.decode('utf-8') for item in result.stdout.split(b'\0') if item}
    unrelated = sorted(staged - allowed)
    if unrelated:
        raise err_cls(
            f'博客仓库已有无关 staged 文件，拒绝提交: {", ".join(unrelated)}'
        )


def validate_single_publication_worktree(
    paths,
    *,
    git_relative_manifest=None,
    run_git=None,
    error_cls=None,
    hooks: Mapping | None = None,
) -> None:
    """要求只有一篇论文页和它绑定的图片、伴随文件处于改动状态。"""
    rel_manifest_fn = _hook(hooks, '_git_relative_manifest', git_relative_manifest)
    git_runner = _hook(hooks, '_run_git', run_git)
    err_cls = _hook(hooks, 'PublishDataValidationError', error_cls, PublishDataValidationError)
    allowed = set(rel_manifest_fn(paths))
    pages = {item for item in allowed if item.startswith('content/posts/') and item.endswith('.md')}
    assets = {
        item for item in allowed
        if item.startswith(('static/images/papers/', 'static/data/papers/', 'static/client/papers/'))
    }
    if len(pages) != 1 or len(pages) + len(assets) != len(allowed):
        raise err_cls('单篇灰度发布必须绑定一个论文页及其受控正文图/sidecar')
    result = git_runner(
        ['status', '--porcelain=v1', '-z', '--untracked-files=all'], check=True,
    )
    unrelated = []
    for raw in (item for item in result.stdout.split(b'\0') if item):
        entry = raw.decode('utf-8', errors='replace')
        # 改名和复制记录会带上第二个以 NUL 分隔的路径，
        # 这种形状永远不能用来替换已经审查过的页面。
        if len(entry) < 4 or entry[2] != ' ':
            unrelated.append(entry)
            continue
        relative = entry[3:]
        if entry[:2] in {'R ', ' R', 'C ', ' C'} or relative not in allowed:
            unrelated.append(entry)
    if unrelated:
        raise err_cls(
            '单篇灰度发布检测到清单外 Git 修改，拒绝夹带提交: '
            + ', '.join(unrelated)
        )


def git_batch_blob_bytes(
    rev: str,
    relatives,
    *,
    blog_repo=None,
    git_env=None,
    bounded_positive_seconds=None,
    local_timeout_seconds: int | None = None,
    subprocess_module=None,
    error_cls=None,
    hooks: Mapping | None = None,
) -> dict[str, bytes | None]:
    """用一次 ``git cat-file --batch`` 读取 ``rev:path`` 的全部 blob。

    返回按相对路径索引的字节或 ``None``（路径在该修订里不存在）。只读取
    本地对象库，不改变索引、工作树或任何引用；输出按输入顺序解析，二进制
    内容按头部声明的字节数读取，不会被内容里的换行截断。
    """
    relatives = list(relatives)
    if not relatives:
        return {}
    repo_value = _hook(hooks, 'BLOG_REPO', blog_repo, '.')
    git_env_fn = _hook(hooks, '_git_env', git_env, _default_git_env)
    bounded_fn = _hook(
        hooks, '_bounded_positive_seconds', bounded_positive_seconds, _default_bounded_positive_seconds,
    )
    default_timeout = _hook(
        hooks, 'GIT_LOCAL_TIMEOUT_SECONDS', local_timeout_seconds, GIT_LOCAL_TIMEOUT_SECONDS,
    )
    subproc = _hook(hooks, 'subprocess', subprocess_module, subprocess)
    err_cls = _hook(hooks, 'PublishDataValidationError', error_cls, PublishDataValidationError)

    request = ''.join(f'{rev}:{relative}\n' for relative in relatives).encode('utf-8')
    timeout_seconds = bounded_fn(
        'PD_GIT_LOCAL_TIMEOUT_SECONDS', default_timeout, 5, 300,
    )
    try:
        process = subproc.run(
            ['git', 'cat-file', '--batch'],
            cwd=str(Path(repo_value).expanduser().resolve()),
            env=git_env_fn(),
            input=request,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired:
        raise subprocess.TimeoutExpired(['git', 'cat-file', '--batch'], timeout_seconds)
    if process.returncode != 0:
        detail = process.stderr.decode('utf-8', errors='replace').strip()
        raise err_cls(f'批量读取 Git 对象失败：{detail[-500:]}')
    output = process.stdout
    if len(output) > 512 * 1024 * 1024:
        raise err_cls('批量读取 Git 对象的输出超过安全上限')
    result: dict[str, bytes | None] = {}
    cursor = 0
    for relative in relatives:
        newline = output.find(b'\n', cursor)
        if newline < 0:
            raise err_cls('批量读取 Git 对象的输出不完整')
        header = output[cursor:newline]
        cursor = newline + 1
        if header.endswith(b' missing'):
            result[relative] = None
            continue
        parts = header.split(b' ')
        if len(parts) != 3 or not parts[2].isdigit():
            raise err_cls('批量读取 Git 对象的响应格式无效')
        size = int(parts[2])
        if parts[1] != b'blob':
            raise err_cls(f'发布路径不是普通文件对象: {relative}')
        raw = output[cursor:cursor + size]
        if len(raw) != size:
            raise err_cls('批量读取 Git 对象的字节数不完整')
        result[relative] = raw
        cursor += size
        if output[cursor:cursor + 1] == b'\n':
            cursor += 1
    return result


def validate_git_index_against_review_receipt(
    receipt,
    paths,
    *,
    git_relative_manifest=None,
    batch_blob_bytes=None,
    error_cls=None,
    hooks: Mapping | None = None,
) -> None:
    """校验已暂存的二进制对象和删除记录与已签名审查凭证完全一致。"""
    rel_manifest_fn = _hook(hooks, '_git_relative_manifest', git_relative_manifest)
    batch_fn = _hook(
        hooks, '_git_batch_blob_bytes', batch_blob_bytes,
        lambda rev, rels: git_batch_blob_bytes(rev, rels, hooks=hooks),
    )
    err_cls = _hook(hooks, 'PublishDataValidationError', error_cls, PublishDataValidationError)

    manifest = set(rel_manifest_fn(paths))
    records = receipt.get('files') if isinstance(receipt, dict) else None
    if not isinstance(records, list):
        raise err_cls('审查凭证缺少可校验的文件记录')
    by_path = {
        record.get('path'): record
        for record in records
        if isinstance(record, dict) and isinstance(record.get('path'), str)
    }
    if set(by_path) != manifest or len(by_path) != len(records):
        raise err_cls('审查凭证与待提交路径集合不一致')

    # 一次批量读取代替逐项 git show；逐项校验与错误文案保持不变。
    staged_blobs = batch_fn('', sorted(manifest))
    for relative in sorted(manifest):
        record = by_path[relative]
        staged = staged_blobs.get(relative)
        if record.get('deleted') is True:
            if staged is not None:
                raise err_cls(
                    f'审查凭证要求删除，但 index 仍包含文件: {relative}'
                )
            continue
        expected = str(record.get('sha256') or '')
        if not re.fullmatch(r'[0-9a-f]{64}', expected):
            raise err_cls(f'审查凭证文件哈希非法: {relative}')
        if staged is None:
            raise err_cls(f'index 缺少已审查文件: {relative}')
        actual = hashlib.sha256(staged).hexdigest()
        if actual != expected:
            raise err_cls(
                f'index 中的文件字节与 review 凭证不一致: {relative}'
            )


def expected_commit_delta_paths(
    receipt,
    base_head: str,
    *,
    batch_blob_bytes=None,
    hooks: Mapping | None = None,
) -> set[str]:
    """对照不可变的审查基线，算出确切的已审查差异。"""
    batch_fn = _hook(
        hooks, '_git_batch_blob_bytes', batch_blob_bytes,
        lambda rev, rels: git_batch_blob_bytes(rev, rels, hooks=hooks),
    )
    records = [
        record for record in receipt.get('files') or []
        if isinstance(record, dict) and isinstance(record.get('path'), str)
    ]
    baselines = batch_fn(
        base_head, sorted({record['path'] for record in records}),
    )
    expected: set[str] = set()
    for record in records:
        relative = record['path']
        baseline = baselines.get(relative)
        if record.get('deleted') is True:
            if baseline is not None:
                expected.add(relative)
            continue
        reviewed_sha = str(record.get('sha256') or '')
        baseline_sha = hashlib.sha256(baseline).hexdigest() if baseline is not None else None
        if baseline_sha != reviewed_sha:
            expected.add(relative)
    return expected


def validate_git_commit_against_review_receipt(
    receipt,
    paths,
    commit: str = 'HEAD',
    *,
    git_relative_manifest=None,
    run_git=None,
    expected_delta_paths=None,
    batch_blob_bytes=None,
    error_cls=None,
    hooks: Mapping | None = None,
) -> None:
    """校验父提交、确切差异和不可变二进制对象，堵住所有钩子与竞态窗口。"""
    rel_manifest_fn = _hook(hooks, '_git_relative_manifest', git_relative_manifest)
    git_runner = _hook(hooks, '_run_git', run_git)
    if expected_delta_paths is not None:
        delta_fn = expected_delta_paths
    elif batch_blob_bytes is not None:
        delta_fn = lambda rec, base: expected_commit_delta_paths(
            rec, base, batch_blob_bytes=batch_blob_bytes, hooks=hooks,
        )
    else:
        delta_fn = _hook(
            hooks, '_expected_commit_delta_paths', None,
            lambda rec, base: expected_commit_delta_paths(rec, base, hooks=hooks),
        )
    batch_fn = _hook(
        hooks, '_git_batch_blob_bytes', batch_blob_bytes,
        lambda rev, rels: git_batch_blob_bytes(rev, rels, hooks=hooks),
    )
    err_cls = _hook(hooks, 'PublishDataValidationError', error_cls, PublishDataValidationError)

    manifest = set(rel_manifest_fn(paths))
    records = receipt.get('files') if isinstance(receipt, dict) else None
    if not isinstance(records, list):
        raise err_cls('审查凭证缺少可校验的文件记录')
    by_path = {
        record.get('path'): record
        for record in records
        if isinstance(record, dict) and isinstance(record.get('path'), str)
    }
    if set(by_path) != manifest or len(by_path) != len(records):
        raise err_cls('审查凭证与待提交路径集合不一致')
    base_head = str(receipt.get('baseHead') or '').lower()
    parents = git_runner(
        ['rev-list', '--parents', '-n', '1', commit], text=True, check=True,
    ).stdout.strip().lower().split()
    if len(parents) != 2 or parents[1] != base_head:
        raise err_cls('发布提交必须是 review 基线的唯一单父提交')
    raw_delta = git_runner(
        ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commit],
        text=False, check=True,
    ).stdout
    if isinstance(raw_delta, bytes):
        actual_delta = {entry.decode('utf-8') for entry in raw_delta.split(b'\x00') if entry}
    else:
        entries = raw_delta.split('\x00') if '\x00' in raw_delta else raw_delta.splitlines()
        actual_delta = {entry for entry in entries if entry}
    expected_delta = delta_fn(receipt, base_head)
    if actual_delta != expected_delta:
        unexpected = sorted(actual_delta - expected_delta)
        missing = sorted(expected_delta - actual_delta)
        raise err_cls(
            f'发布提交完整变更集与审查凭证不一致；额外={unexpected}，缺失={missing}'
        )
    # 一次批量读取代替逐项 git show；逐项校验与错误文案保持不变。
    committed_blobs = batch_fn(commit, sorted(manifest))
    for relative in sorted(manifest):
        record = by_path[relative]
        committed = committed_blobs.get(relative)
        if record.get('deleted') is True:
            if committed is not None:
                raise err_cls(
                    f'审查凭证要求删除，但提交仍包含文件: {relative}'
                )
            continue
        expected = str(record.get('sha256') or '')
        if committed is None or hashlib.sha256(committed).hexdigest() != expected:
            raise err_cls(
                f'提交中的文件字节与 review 凭证不一致: {relative}'
            )


def remote_main_oid(
    *,
    run_git=None,
    github_remote: str | None = None,
    hooks: Mapping | None = None,
) -> tuple[str | None, str]:
    git_runner = _hook(hooks, '_run_git', run_git)
    remote = _hook(hooks, 'GITHUB_REMOTE', github_remote, 'origin')
    result = git_runner(
        ['ls-remote', '--exit-code', remote, 'refs/heads/main'],
        text=True, timeout_kind='network',
    )
    if result.returncode != 0:
        if result.timed_out:
            return None, '查询远端 main OID 超时，子进程组已终止'
        return None, (result.stderr or result.stdout or '').strip()
    first_line = (result.stdout or '').splitlines()[0] if result.stdout else ''
    oid = first_line.split(None, 1)[0].lower() if first_line else ''
    if not re.fullmatch(r'[0-9a-f]{40,64}', oid):
        return None, f'远端返回不可验证的 OID: {oid!r}'
    return oid, ''


def remote_identity_sha256(
    *,
    run_git=None,
    github_remote: str | None = None,
    stable_json_sha256=None,
    hooks: Mapping | None = None,
) -> tuple[str | None, str]:
    """把一次已验证的发布绑定到配置远端确切的推送 URL。

    不保存 URL 本身，因为里面可能带凭据。对远端名
    和 Git 解析出的确切推送 URL 求哈希，仍然能让
    把 ``origin`` 换成一个无关仓库的操作作废旧发布证据。
    """
    git_runner = _hook(hooks, '_run_git', run_git)
    remote = _hook(hooks, 'GITHUB_REMOTE', github_remote, 'origin')
    sha_fn = _hook(hooks, '_stable_json_sha256', stable_json_sha256)
    result = git_runner(
        ['remote', 'get-url', '--push', remote], text=True,
    )
    if result.returncode != 0:
        return None, f'无法解析当前 Git remote {remote!r} 的 push URL'
    push_url = (result.stdout or '').strip()
    if not push_url or '\n' in push_url or '\x00' in push_url:
        return None, f'当前 Git remote {remote!r} 的 push URL 非法'
    payload = {
        'remote': remote,
        'pushUrl': push_url,
    }
    if sha_fn is not None:
        return sha_fn(payload), ''
    import json
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest(), ''


def report_push_retry(
    local_head: str,
    detail: str,
    *,
    blog_repo=None,
    github_remote: str | None = None,
    print_fn=None,
    hooks: Mapping | None = None,
) -> None:
    repo = _hook(hooks, 'BLOG_REPO', blog_repo, '.')
    remote = _hook(hooks, 'GITHUB_REMOTE', github_remote, 'origin')
    printer = print_fn if print_fn is not None else _hook(hooks, 'print', None, print)
    printer(f'  ❌ Push/远端验证失败，本地提交 {local_head} 已保留，远端发布尚未确认')
    if detail:
        printer(f'  原因: {detail}')
    printer(f'  可重试: git -C {repo} push {remote} HEAD:main')
    printer(f'  可验证: git -C {repo} ls-remote {remote} refs/heads/main')
    printer(f'  预期远端 OID: {local_head}')


def git_tracks_path(
    relative_path: str,
    *,
    blog_repo=None,
    git_env=None,
    bounded_positive_seconds=None,
    local_timeout_seconds: int | None = None,
    subprocess_module=None,
    hooks: Mapping | None = None,
) -> bool:
    repo = _hook(hooks, 'BLOG_REPO', blog_repo, '.')
    git_env_fn = _hook(hooks, '_git_env', git_env, _default_git_env)
    bounded_fn = _hook(
        hooks, '_bounded_positive_seconds', bounded_positive_seconds, _default_bounded_positive_seconds,
    )
    default_timeout = _hook(
        hooks, 'GIT_LOCAL_TIMEOUT_SECONDS', local_timeout_seconds, GIT_LOCAL_TIMEOUT_SECONDS,
    )
    timeout_seconds = bounded_fn(
        'PD_GIT_LOCAL_TIMEOUT_SECONDS', default_timeout, 5, 300,
    )
    subproc = _hook(hooks, 'subprocess', subprocess_module, subprocess)
    result = subproc.run(
        ['git', 'ls-files', '--error-unmatch', '--', relative_path],
        cwd=str(Path(repo).expanduser().resolve()),
        env=git_env_fn(),
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )
    return result.returncode == 0


def execute_git_push(
    date_str: str,
    publish_paths,
    rollback_state=None,
    *,
    verified_receipt_token=None,
    hooks: Mapping,
) -> bool:
    """提交，把 HEAD 显式推送到 main，并核验远端对象 ID。"""
    err_cls = _hook(hooks, 'PublishDataValidationError', None, PublishDataValidationError)
    subproc = _hook(hooks, 'subprocess', None, subprocess)
    rel_manifest_fn = hooks['_git_relative_manifest']
    manifest = rel_manifest_fn(publish_paths)
    state = rollback_state
    try:
        reused_verified = None
        if verified_receipt_token is not None:
            consume_fn = hooks.get('_consume_verified_push_receipt_token')
            if callable(consume_fn):
                reused_verified = consume_fn(verified_receipt_token, date_str, manifest)
        if reused_verified is not None:
            verified_paths, _verified_receipt_path = reused_verified
            if rel_manifest_fn(verified_paths) != manifest:
                raise err_cls('git push 路径与已验证审查凭证不一致')
        else:
            verified_paths, _verified_receipt_path = hooks['load_verified_review_receipt'](date_str)
            # 这段必须留在 validate_git_publish_branch、索引抓取、
            # add、commit、凭证采纳以及任何远端操作之前。凭证校验
            # 在下面有意重复一次，作为它自己的不可变证据契约的一部分。
            hooks['_validate_push_generation_input_integrity'](date_str)
            if rel_manifest_fn(verified_paths) != manifest:
                raise err_cls('git push 路径与已验证审查凭证不一致')
        receipt, receipt_path, base_head = hooks['_load_push_receipt'](date_str)
        current_head = hooks['validate_git_publish_branch']()
        if hooks.get('_ACTIVE_PUBLICATION_INCLUDE_ID') is not None:
            hooks['validate_single_publication_worktree'](publish_paths)
        hooks['validate_git_index'](publish_paths)
        github_remote = _hook(hooks, 'GITHUB_REMOTE', None, 'origin')
        publication_commit = str(receipt.get('publicationCommit') or '').lower()
        verified_remote_oid = str(receipt.get('remoteVerifiedOid') or '').lower()
        if verified_remote_oid:
            if verified_remote_oid != publication_commit:
                raise err_cls(
                    '已发布凭证的 remoteVerifiedOid 与 publicationCommit 不一致'
                )
            stored_remote_identity = str(
                receipt.get('remoteIdentitySha256') or ''
            ).lower()
            if (
                current_head != publication_commit
                or receipt.get('remoteName') != github_remote
                or not re.fullmatch(r'[0-9a-f]{64}', stored_remote_identity)
            ):
                raise err_cls(
                    '已发布凭证与当前 HEAD 或 Git remote 身份不一致，拒绝向其他远端重放'
                )
            current_remote_identity, identity_error = hooks['_remote_identity_sha256']()
            current_remote_oid, _remote_error = hooks['_remote_main_oid']()
            if (
                current_remote_identity != stored_remote_identity
                or current_remote_oid != publication_commit
            ):
                detail = identity_error or (
                    '无法实时查询当前远端 main OID'
                    if current_remote_oid is None
                    else f'当前远端 main={current_remote_oid}'
                )
                raise err_cls(
                    '已发布凭证实时远端复核失败，拒绝覆盖或重放：' + detail
                )
            hooks['validate_git_commit_against_review_receipt'](
                receipt, publish_paths, publication_commit,
            )
            hooks['validate_manifest_clean_against_head'](publish_paths)
            print(
                f'  ✅ 已发布提交 {publication_commit} 的 remote 身份和远端 main OID '
                '实时复核通过，无需再次 push'
            )
            return True
        retrying_existing_commit = publication_commit and current_head == publication_commit
        if retrying_existing_commit:
            parent = hooks['_run_git'](
                ['rev-parse', 'HEAD^'], text=True, check=True,
            ).stdout.strip().lower()
            if parent != base_head:
                raise err_cls('待重试发布提交的父提交与 review 基线不一致，拒绝推送')
            hooks['validate_git_commit_against_review_receipt'](receipt, publish_paths, current_head)
        # 恢复 commit 成功、receipt 原子写入前崩溃的窗口。只有单父、
        # exact delta 和所有 blob 都严格匹配旧 receipt 时才收养该提交。
        if not retrying_existing_commit and not publication_commit and current_head != base_head:
            hooks['validate_git_commit_against_review_receipt'](receipt, publish_paths, current_head)
            receipt['publicationCommit'] = current_head
            hooks['atomic_write_json'](receipt_path, receipt, ensure_ascii=False, indent=2)
            publication_commit = current_head
            retrying_existing_commit = True
        if not retrying_existing_commit and current_head != base_head:
            raise err_cls('博客 HEAD 已偏离 review 时基线，拒绝推送未审查的本地提交；请重新生成并 review')
        if state is None:
            capture_started = time.monotonic()
            state = hooks['capture_git_publish_state'](publish_paths)
            print(f'  ⏱ capture state: {time.monotonic() - capture_started:.2f}s')
        if manifest and not retrying_existing_commit:
            blog_root = Path(_hook(hooks, 'BLOG_REPO', None, '.')).expanduser().resolve()
            tracks_fn = hooks['_git_tracks_path']
            addable = [
                item for item in manifest
                if (blog_root / item).exists() or tracks_fn(item)
            ]
            if addable:
                from blog_repository_lock import assert_blog_lock_held
                assert_blog_lock_held()
                add_started = time.monotonic()
                hooks['_run_git'](
                    ['add', '--', *addable], check=True,
                )
                print(
                    f'  ⏱ git add ({len(addable)} 路径): '
                    f'{time.monotonic() - add_started:.2f}s'
                )
            hooks['validate_git_index'](publish_paths)
            hooks['validate_git_index_against_review_receipt'](receipt, publish_paths)
        staged = hooks['_run_git'](
            ['diff', '--cached', '--quiet', '--', *manifest],
        ) if manifest else None
        if retrying_existing_commit:
            local_head = current_head
        elif staged is not None and staged.returncode == 1:
            from blog_repository_lock import assert_blog_lock_held
            assert_blog_lock_held()
            manual_mode = _hook(hooks, 'MANUAL_REVIEW_MODE', None, MANUAL_REVIEW_MODE)
            review_description = (
                '提交已通过逐论文独立人工语义、逐图像素事实与 Hugo gate 审查；'
                if receipt.get('reviewMode') == manual_mode
                else '提交已通过严格 LLM、多模态图片与 Hugo gate 审查；'
            )
            commit_started = time.monotonic()
            hooks['_run_git'](
                [
                    'commit',
                    '-m', f'content: 发布 {date_str} 音频研究日报并同步评分与审查结果',
                    '-m', review_description
                          + '推送前已逐文件校验审查凭证 SHA-256，本步不重新生成或 review。',
                ],
                check=True, timeout_kind='commit',
            )
            print(f'  ⏱ git commit: {time.monotonic() - commit_started:.2f}s')
            local_head = hooks['validate_git_publish_branch']()
            hooks['validate_git_commit_against_review_receipt'](receipt, publish_paths, local_head)
            receipt['publicationCommit'] = local_head
            hooks['atomic_write_json'](receipt_path, receipt, ensure_ascii=False, indent=2)
        elif staged is not None and staged.returncode > 1:
            raise subproc.CalledProcessError(staged.returncode, staged.args)
        else:
            raise err_cls('审查文件相对基线没有可提交差异，拒绝推送任意已有本地提交')
    except (
        subproc.CalledProcessError, subproc.TimeoutExpired,
        err_cls, OSError, UnicodeError,
    ) as exc:
        try:
            hooks['restore_git_publish_state'](state)
            print(f'  ❌ Git add/commit 失败，已恢复发布前 index 与工作树: {exc}')
        except Exception as restore_exc:
            print(f'  ❌ Git add/commit 失败，且自动恢复失败: {exc}; 恢复错误: {restore_exc}')
        return False

    from blog_repository_lock import assert_blog_lock_held
    assert_blog_lock_held()
    push_started = time.monotonic()
    remote_identity_before, identity_error = hooks['_remote_identity_sha256']()
    if remote_identity_before is None:
        print(f'  ⏱ remote identity: {time.monotonic() - push_started:.2f}s')
        hooks['_report_push_retry'](local_head, identity_error)
        return False
    github_remote = _hook(hooks, 'GITHUB_REMOTE', None, 'origin')
    result = hooks['_run_git'](
        ['push', github_remote, 'HEAD:main'],
        text=True, timeout_kind='network',
    )
    remote_oid, verify_error = hooks['_remote_main_oid']()
    remote_identity_after, identity_error = hooks['_remote_identity_sha256']()
    if (
        remote_oid == local_head
        and remote_identity_after is not None
        and remote_identity_after == remote_identity_before
    ):
        if result.returncode != 0:
            print('  ℹ️ git push 返回非零，但远端 main 已与本地 HEAD 一致，以 OID 验证结果为准')
        print(f'  ⏱ 远端推送与核验: {time.monotonic() - push_started:.2f}s')
        print(f'  ✅ 已推送并验证远端 main={remote_oid}，自动部署中...')
        receipt['remoteVerifiedOid'] = remote_oid
        receipt['remoteVerifiedAt'] = datetime.datetime.now(
            datetime.timezone(datetime.timedelta(hours=8))
        ).isoformat()
        receipt['remoteName'] = github_remote
        receipt['remoteIdentitySha256'] = remote_identity_after
        hooks['atomic_write_json'](receipt_path, receipt, ensure_ascii=False, indent=2)
        hooked_blog_url = _hook(hooks, 'BLOG_URL')
        initial_blog_url = _hook(hooks, '_INITIAL_BLOG_URL')
        if hooked_blog_url is not None and hooked_blog_url != initial_blog_url:
            blog_url = hooked_blog_url
        else:
            blog_url = os.environ.get(
                'PAPER_DIGEST_BLOG_URL',
                hooked_blog_url if hooked_blog_url is not None
                else 'https://nanless.github.io/audio-research-portal/posts',
            )
        if blog_url:
            print(f'  🌐 {blog_url}/{date_str}/')
        return True

    print(f'  ⏱ 远端推送与核验（失败）: {time.monotonic() - push_started:.2f}s')
    detail = verify_error or identity_error
    if remote_identity_after is not None and remote_identity_after != remote_identity_before:
        detail = 'Git remote 在 push 与远端 OID 校验之间发生变化'
    push_detail = (
        'git push 超时，已终止完整进程组'
        if result.timed_out else (result.stderr or result.stdout or '').strip()
    )
    if push_detail:
        detail = f'{push_detail}; {detail}' if detail else push_detail
    elif remote_oid:
        detail = f'远端 main={remote_oid}，与本地 HEAD 不一致'
    hooks['_report_push_retry'](local_head, detail)
    return False


# 兼容带下划线前缀的既有内部别名
_git_batch_blob_bytes = git_batch_blob_bytes
_expected_commit_delta_paths = expected_commit_delta_paths
_remote_main_oid = remote_main_oid
_remote_identity_sha256 = remote_identity_sha256
_report_push_retry = report_push_retry
_git_tracks_path = git_tracks_path
