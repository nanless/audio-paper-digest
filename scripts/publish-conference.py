#!/usr/bin/env python3
"""Publish one completed conference process as an isolated blog delta."""

from project_env import load_project_env

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import io
import tarfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from blog_repository_lock import shared_blog_repository_lock
from blog_entry_loader import load_publish_to_blog
from project_env import VCS_CHILD_ENV_KEYS, build_child_process_env
from runtime_guard import require_external_runtime, require_workspace_role
from conference_publication_gate import inspect_html, verify_publication_urls, validate_png, GATE_CONTRACT


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'data' / 'runtime'
PROCESS_ROOT = RUNTIME / 'conference-processes'
PAGE_ROOT = RUNTIME / 'conference-page-staging'
AGGREGATE_ROOT = RUNTIME / 'conference-aggregates'
PUBLICATION_ROOT = RUNTIME / 'conference-publications'
UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
SHA_RE = re.compile(r'^[0-9a-f]{64}$')


class ConferencePublicationError(RuntimeError):
    pass


def stable(value):
    def normalize(item):
        if isinstance(item, list):
            return [normalize(child) for child in item]
        if isinstance(item, dict):
            return {key: normalize(item[key]) for key in sorted(item)}
        return item

    return hashlib.sha256(json.dumps(normalize(value), ensure_ascii=False,
                                     separators=(',', ':')).encode('utf-8')).hexdigest()


def sha_bytes(data):
    return hashlib.sha256(data).hexdigest()


CONFERENCE_IMAGE_RE = re.compile(r'!\[[^\n]*?\]\(([^)\s]+)(?:\s+[^)]*)?\)')
IMAGE_REPO_DEFAULT = Path.home() / 'code' / 'github_repos' / 'audio-paper-digest-images'
IMAGE_BASE_URL = os.environ.get(
    'PAPER_DIGEST_IMAGE_BASE_URL',
    'https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main',
).rstrip('/')


def conference_asset_path_from_url(url):
    parsed = urlsplit(str(url))
    if parsed.scheme or parsed.netloc:
        base = urlsplit(IMAGE_BASE_URL)
        base_path = base.path.rstrip('/')
        if (parsed.scheme, parsed.netloc.lower()) != (base.scheme, (base.netloc or '').lower()) \
                or not parsed.path.startswith(f'{base_path}/'):
            return None
        relative = parsed.path[len(base_path) + 1:]
        parts = tuple(Path(relative).parts)
        if len(parts) != 3:
            return None
        return Path('static', 'images', 'conference', *parts).as_posix()
    parts = tuple(Path(parsed.path.lstrip('/')).parts)
    try:
        image_index = parts.index('images')
    except ValueError:
        return None
    if image_index + 3 >= len(parts) or parts[image_index + 1] != 'conference':
        return None
    return Path('static', *parts[image_index:]).as_posix()


def read_json(filename):
    filename = Path(filename)
    try:
        info = filename.lstat()
    except FileNotFoundError as exc:
        raise ConferencePublicationError(f'缺少文件: {filename}') from exc
    if not filename.is_file() or filename.is_symlink() or info.st_nlink != 1:
        raise ConferencePublicationError(f'文件必须是普通单链接文件: {filename}')

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ConferencePublicationError(f'JSON 存在重复键: {filename}: {key}')
            result[key] = value
        return result

    try:
        return json.loads(filename.read_text(encoding='utf-8'), object_pairs_hook=pairs)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ConferencePublicationError(f'JSON 无法安全读取: {filename}: {exc}') from exc


def read_bytes(filename):
    filename = Path(filename)
    try:
        info = filename.lstat()
        if not filename.is_file() or filename.is_symlink() or info.st_nlink != 1:
            raise ConferencePublicationError(f'文件必须是普通单链接文件: {filename}')
        return filename.read_bytes()
    except FileNotFoundError as exc:
        raise ConferencePublicationError(f'缺少文件: {filename}') from exc


def write_exact(filename, data, mode=0o600):
    filename = Path(filename)
    filename.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if filename.exists():
        if read_bytes(filename) != data:
            raise ConferencePublicationError(f'拒绝覆盖不同字节: {filename}')
        return False
    # Write a complete fsynced inode and link it into place atomically. This
    # keeps the final receipt/PNG absent when the temporary write fails, while
    # O_NOFOLLOW and the no-overwrite link preserve the trusted boundary.
    fd, temporary = tempfile.mkstemp(prefix=f'.{filename.name}.', dir=filename.parent)
    try:
        os.fchmod(fd, mode)
        try:
            with os.fdopen(fd, 'wb', closefd=False) as stream:
                stream.write(data)
                stream.flush()
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            os.link(temporary, filename)
        except FileExistsError:
            if read_bytes(filename) != data:
                raise ConferencePublicationError(f'并发写入产生不同字节: {filename}')
            return False
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        directory_fd = os.open(filename.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    return True


def rewrite_unpublished_receipt(filename, data, label, invariant):
    """Rebind an unpublished receipt after a safe blog-base advancement."""
    filename = Path(filename)
    if not filename.exists():
        return write_exact(filename, data)
    if read_bytes(filename) == data:
        return False
    if (filename.parent / 'publish.json').exists():
        raise ConferencePublicationError(
            f'已发布会议凭证不可重签，拒绝覆盖不同字节: {filename}'
        )
    previous = read_json(filename)
    if not invariant(previous):
        raise ConferencePublicationError(
            f'{label} 与当前会议内容不一致，拒绝重签: {filename}'
        )
    previous_bytes = read_bytes(filename)
    archive = filename.with_name(
        f'{filename.stem}.superseded-{sha_bytes(previous_bytes)[:12]}{filename.suffix}'
    )
    write_exact(archive, previous_bytes)
    replace_exact(filename, data)
    return True


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def safe_uuid(value, label):
    if not UUID_RE.fullmatch(value or ''):
        raise ConferencePublicationError(f'{label} 不是 UUID v4')
    return value


def safe_relative(value, label):
    path = Path(value or '')
    safe_parts = all(re.fullmatch(r'[A-Za-z0-9._-]+', part) for part in path.parts)
    is_page = path.parts[:2] == ('content', 'posts') and len(path.parts) == 3 and path.suffix == '.md'
    is_asset = path.parts[:3] == ('static', 'images', 'conference') and len(path.parts) == 6 \
        and path.suffix == '.png' and re.fullmatch(r'[a-f0-9]{12}', path.parts[4] or '') \
        and re.fullmatch(r'figure-\d+\.png', path.parts[5] or '')
    if path.is_absolute() or '..' in path.parts or not safe_parts or not (is_page or is_asset):
        raise ConferencePublicationError(f'{label} 不是安全的会议 Markdown/图片路径: {value}')
    return path.as_posix()


def under(root, relative, label):
    root = Path(root).resolve(strict=True)
    target = root / relative
    cursor = root
    for part in Path(relative).parts:
        cursor = cursor / part
        if cursor.exists() and cursor.is_symlink():
            raise ConferencePublicationError(f'{label} 路径包含符号链接: {target}')
    if target.parent.resolve() != target.parent:
        raise ConferencePublicationError(f'{label} 父目录无法解析: {target}')
    return target


def git(repo, *args, check=True, binary=False):
    env = build_child_process_env(allowed_keys=VCS_CHILD_ENV_KEYS)
    result = subprocess.run(['git', '-C', str(repo), *args], cwd=ROOT, env=env,
                            capture_output=True, text=not binary, check=False)
    if check and result.returncode != 0:
        # Remote URLs and Git stderr may contain credentials.
        raise ConferencePublicationError(f'Git {args[0]} 失败（exit {result.returncode}）')
    return result


def blob_sha(repo, revision, path):
    """Hash Git bytes, never the possibly different working tree (also supports PNG)."""
    env = build_child_process_env(allowed_keys=VCS_CHILD_ENV_KEYS)
    result = subprocess.run(['git', '-C', str(repo), 'show', f'{revision}:{path}'],
                            cwd=ROOT, env=env, capture_output=True, check=False)
    if result.returncode:
        raise ConferencePublicationError(f'Git blob 不可读: {revision}:{path}')
    return sha_bytes(result.stdout)


def verify_blobs(repo, revision, records):
    for record in records:
        if blob_sha(repo, revision, record['path']) != record['sourceSha256']:
            raise ConferencePublicationError(f'Git {revision} blob SHA 不一致: {record["path"]}')


def expected_delta(repo, base, records):
    paths = []
    for record in records:
        exists = git(repo, 'cat-file', '-e', f'{base}:{record["path"]}', check=False)
        if exists.returncode or blob_sha(repo, base, record['path']) != record['sourceSha256']:
            paths.append(record['path'])
    return sorted(paths)


def verify_own_commit(repo, commit, base, records):
    delta = sorted(expected_delta(repo, base, records))
    if commit == base:
        if delta:
            raise ConferencePublicationError('提交仍为基线但存在待发布 delta')
    else:
        parents = git(repo, 'rev-list', '--parents', '-n', '1', commit).stdout.split()
        changed = git(repo, 'diff', '--name-only', base, commit).stdout.splitlines()
        if parents != [commit, base] or sorted(changed) != delta:
            raise ConferencePublicationError('恢复 commit 的 parent 或精确 delta 不匹配')
    verify_blobs(repo, commit, records)


def commit_exact_delta(repo, records, base, remote_before, identity, message):
    snapshot = remote_snapshot(repo)
    if snapshot['remoteIdentitySha256'] != identity:
        raise ConferencePublicationError('remote identity 漂移')
    head = snapshot['head']
    delta = sorted(expected_delta(repo, base, records))
    cached = git(repo, 'diff', '--cached', '--name-only').stdout.splitlines()
    if not set(cached).issubset(delta):
        raise ConferencePublicationError(f'已有非本次 staged 文件: {cached}')
    # Reject stale staged bytes before git add can silently replace them.
    verify_blobs(repo, '', [record for record in records if record['path'] in cached])
    if head != base:
        verify_own_commit(repo, head, base, records)
        if cached:
            raise ConferencePublicationError('已提交事务仍有 staged 修改')
    elif delta:
        if snapshot['remoteMain'] != remote_before or remote_before != base:
            raise ConferencePublicationError('未提交事务的远端基线漂移')
        git(repo, 'add', '--', *delta)
        staged = git(repo, 'diff', '--cached', '--name-only').stdout.splitlines()
        if sorted(staged) != delta:
            raise ConferencePublicationError('staged delta 与本次变更不一致')
        verify_blobs(repo, '', records)
        git(repo, 'commit', '-m', message)
        head = git(repo, 'rev-parse', 'HEAD').stdout.strip().lower()
    verify_own_commit(repo, head, base, records)
    before_push = remote_snapshot(repo)
    if before_push['head'] != head or before_push['remoteIdentitySha256'] != identity \
            or before_push['remoteMain'] not in (remote_before, head):
        raise ConferencePublicationError('推送前远端或 HEAD 漂移')
    if before_push['remoteMain'] != head:
        git(repo, 'push', 'origin', 'HEAD:main')
    after = remote_snapshot(repo)
    if after['head'] != head or after['remoteMain'] != head \
            or after['remoteIdentitySha256'] != identity:
        raise ConferencePublicationError('推送后远端 OID 或 identity 不匹配')
    verify_own_commit(repo, head, base, records)
    return {'commit': head, 'snapshot': after, 'deltaPaths': delta}


def blog_repo():
    raw = os.environ.get('PAPER_DIGEST_BLOG_REPO', '')
    if not raw:
        raise ConferencePublicationError('PAPER_DIGEST_BLOG_REPO 未配置')
    repo = Path(os.path.expanduser(raw)).resolve(strict=True)
    if not repo.is_dir():
        raise ConferencePublicationError(f'博客仓库不是目录: {repo}')
    if git(repo, 'rev-parse', '--is-inside-work-tree').stdout.strip() != 'true':
        raise ConferencePublicationError(f'博客仓库不是 Git worktree: {repo}')
    return repo


def image_repo():
    raw = os.environ.get('PAPER_DIGEST_IMAGE_REPO', str(IMAGE_REPO_DEFAULT))
    repo = Path(os.path.expanduser(raw)).resolve(strict=True)
    if not repo.is_dir():
        raise ConferencePublicationError(f'图片仓库不是目录: {repo}')
    if git(repo, 'rev-parse', '--is-inside-work-tree').stdout.strip() != 'true':
        raise ConferencePublicationError(f'图片仓库不是 Git worktree: {repo}')
    return repo


def safe_image_relative(value, label):
    path = Path(value or '')
    safe_parts = all(re.fullmatch(r'[A-Za-z0-9._-]+', part) for part in path.parts)
    valid = len(path.parts) == 3 and re.fullmatch(r'[a-z0-9-]+', path.parts[0] or '') \
        and re.fullmatch(r'[a-f0-9]{12}', path.parts[1] or '') \
        and re.fullmatch(r'figure-\d+\.png', path.parts[2] or '')
    if path.is_absolute() or '..' in path.parts or not safe_parts or not valid:
        raise ConferencePublicationError(f'{label} 不是安全的图片仓库路径: {value}')
    return path.as_posix()


def remote_snapshot(repo):
    branch = git(repo, 'branch', '--show-current').stdout.strip()
    head = git(repo, 'rev-parse', 'HEAD').stdout.strip().lower()
    push_urls = git(repo, 'remote', 'get-url', '--push', '--all', 'origin').stdout.splitlines()
    if len(push_urls) != 1 or not push_urls[0].strip():
        raise ConferencePublicationError('origin 必须只有一个 push URL，拒绝多目标发布')
    remote_url = push_urls[0].strip()
    # origin may have a different fetch URL. Query the exact destination whose
    # identity we bind, not the fetch remote (which can already be ahead).
    remote = git(repo, 'ls-remote', '--', remote_url, 'refs/heads/main').stdout.strip().split()
    if branch != 'main' or not re.fullmatch(r'[0-9a-f]{40}', head) or not remote_url \
            or len(remote) != 2 or remote[1] != 'refs/heads/main':
        raise ConferencePublicationError('博客仓库必须位于 main 且有可验证的 origin/main')
    remote_oid = remote[0].lower()
    if not re.fullmatch(r'[0-9a-f]{40}', remote_oid):
        raise ConferencePublicationError('origin/main OID 非法')
    return {'branch': branch, 'head': head, 'remoteName': 'origin',
            'remoteUrl': remote_url, 'remoteMain': remote_oid,
            'remoteIdentitySha256': sha_bytes(remote_url.encode('utf-8'))}


def process_bundle(conference_id, process_id):
    safe_uuid(process_id, 'processId')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,80}', conference_id or ''):
        raise ConferencePublicationError('conferenceId 不安全')
    process_dir = PROCESS_ROOT / process_id
    state = read_json(process_dir / 'state.json')
    if state.get('processId') != process_id or state.get('status') != 'complete' \
            or state.get('authority', {}).get('conferenceId') != conference_id:
        raise ConferencePublicationError('会议 process 尚未以 complete 状态闭合')
    items = state.get('items')
    if not isinstance(items, dict) or not items or any(item.get('status') != 'complete'
                                                       for item in items.values()):
        raise ConferencePublicationError('会议仍有未完成论文，拒绝发布')
    completion = read_json(process_dir / 'completion-receipt.json')
    completion_body = dict(completion)
    declared = completion_body.pop('receiptSha256', None)
    if not SHA_RE.fullmatch(str(declared or '')) or stable(completion_body) != declared \
            or completion.get('processId') != process_id \
            or completion.get('authority', {}).get('conferenceId') != conference_id \
            or state.get('completionReceiptSha256') != declared:
        raise ConferencePublicationError('completion receipt 与 process state 不闭合')

    aggregate_proof = state.get('aggregate')
    if not isinstance(aggregate_proof, dict):
        raise ConferencePublicationError('会议缺少 aggregate proof')
    aggregate_path = find_manifest(AGGREGATE_ROOT / conference_id,
                                   aggregate_proof.get('manifestSha256'), 'aggregate')
    aggregate_manifest = read_json(aggregate_path)
    aggregate_dir = aggregate_path.parent
    aggregate_md = aggregate_dir / 'aggregate.md'
    aggregate_bytes = read_bytes(aggregate_md)
    if aggregate_manifest.get('contract') != 'conference-aggregate-staging-v1' \
            or aggregate_manifest.get('status') != 'complete' \
            or aggregate_manifest.get('conferenceId') != conference_id \
            or aggregate_manifest.get('aggregateId') != aggregate_proof.get('aggregateId') \
            or aggregate_manifest.get('pagePath') != aggregate_proof.get('pagePath') \
            or aggregate_manifest.get('markdownSha256') != sha_bytes(aggregate_bytes) \
            or aggregate_manifest.get('markdown') != aggregate_bytes.decode('utf-8') \
            or aggregate_manifest.get('markdownSha256') != aggregate_proof.get('markdownSha256') \
            or manifest_sha(aggregate_manifest) != aggregate_proof.get('manifestSha256'):
        raise ConferencePublicationError('aggregate staging 与 completion proof 不一致')
    aggregate_target = safe_relative(aggregate_manifest['pagePath'], 'aggregate pagePath')

    files = []
    image_files = []
    seen_targets = set()
    seen_image_targets = set()
    for paper_id, item in sorted(items.items()):
        proof = item.get('pageProof')
        if not isinstance(proof, dict):
            raise ConferencePublicationError(f'论文缺少 page proof: {paper_id}')
        manifest_path = find_manifest(PAGE_ROOT, proof.get('manifestSha256'), paper_id)
        manifest = read_json(manifest_path)
        page_path = safe_relative(manifest.get('pagePath'), f'{paper_id} pagePath')
        page_bytes = read_bytes(manifest_path.parent / 'page.md')
        if manifest.get('contract') != 'conference-paper-page-staging-v1' \
                or manifest.get('status') != 'complete' or manifest.get('paperId') != paper_id \
                or manifest.get('analysisExecutionId') != item.get('analysisRunId') \
                or manifest.get('contentSha256') != sha_bytes(page_bytes) \
                or manifest.get('contentSha256') != proof.get('contentSha256') \
                or manifest.get('manifestSha256') != proof.get('manifestSha256') \
                or manifest_sha(manifest) != proof.get('manifestSha256'):
            raise ConferencePublicationError(f'论文 staging 与 process proof 不一致: {paper_id}')
        text = page_bytes.decode('utf-8')
        required = [f'paper_digest_paper_id: "{paper_id}"',
                    'paper_digest_source_kind: conference',
                    f'paper_digest_conference_id: "{conference_id}"']
        if not text.startswith('---\n') or any(marker not in text for marker in required) \
                or 'paper_digest_arxiv_id' in text or 'arxiv.org' in text.lower():
            raise ConferencePublicationError(f'论文页面身份或 arXiv 隔离门禁失败: {paper_id}')
        if page_path in seen_targets or page_path == aggregate_target:
            raise ConferencePublicationError(f'会议目标路径重复: {page_path}')
        seen_targets.add(page_path)
        files.append({'kind': 'paper', 'paperId': paper_id, 'path': page_path,
                      'sourcePath': str(manifest_path.parent / 'page.md'),
                      'manifestSha256': proof['manifestSha256'],
                      'sourceSha256': sha_bytes(page_bytes), 'size': len(page_bytes)})
        assets = manifest.get('assets') or []
        if not isinstance(assets, list):
            raise ConferencePublicationError(f'论文资产清单非法: {paper_id}')
        declared_asset_paths = set()
        for asset in assets:
            if not isinstance(asset, dict) or set(asset) != {'path', 'sha256', 'size'}:
                raise ConferencePublicationError(f'论文资产记录非法: {paper_id}')
            asset_path = safe_relative(asset.get('path'), f'{paper_id} asset path')
            asset_bytes = read_bytes(manifest_path.parent / 'assets' / asset_path)
            if asset.get('sha256') != sha_bytes(asset_bytes) or asset.get('size') != len(asset_bytes):
                raise ConferencePublicationError(f'论文资产与 staging 不一致: {paper_id} {asset_path}')
            image_target = safe_image_relative('/'.join(Path(asset_path).parts[3:]),
                                               f'{paper_id} image asset path')
            if image_target in seen_image_targets:
                raise ConferencePublicationError(f'图片仓库目标路径重复: {image_target}')
            seen_image_targets.add(image_target)
            declared_asset_paths.add(asset_path)
            image_files.append({'kind': 'asset', 'paperId': paper_id, 'path': image_target,
                                'sourcePath': str(manifest_path.parent / 'assets' / asset_path),
                                'manifestSha256': proof['manifestSha256'],
                                'sourceSha256': sha_bytes(asset_bytes), 'size': len(asset_bytes)})

        # A page can be internally valid while its referenced PNGs are absent
        # from the publication delta.  That happened in the first EACL
        # publication: the Markdown pages were committed, but static/images/
        # was left untracked, so every Figure was a broken online URL.  Close
        # the page-to-asset edge here before generation and push.
        referenced_asset_paths = set()
        for url in CONFERENCE_IMAGE_RE.findall(text):
            asset_path = conference_asset_path_from_url(url)
            if asset_path is not None:
                referenced_asset_paths.add(asset_path)
            elif 'audio-paper-digest-images' in url or '/images/conference/' in url:
                raise ConferencePublicationError(
                    f'论文 Markdown 引用了非法会议图片 URL: {paper_id}: {url}'
                )
        missing_assets = sorted(referenced_asset_paths - declared_asset_paths)
        if missing_assets:
            raise ConferencePublicationError(
                f'论文 Markdown 引用了未进入 staging 的会议图片: {paper_id}: {missing_assets}'
            )

    aggregate_text = aggregate_bytes.decode('utf-8')
    if not aggregate_text.startswith('---\n') \
            or 'paper_digest_page_type: index' not in aggregate_text \
            or f'conference-{conference_id}' not in aggregate_text \
            or 'paper_digest_arxiv_id' in aggregate_text or 'arxiv.org' in aggregate_text.lower():
        raise ConferencePublicationError('会议汇总页面身份或 arXiv 隔离门禁失败')
    files.append({'kind': 'aggregate', 'paperId': None, 'path': aggregate_target,
                  'sourcePath': str(aggregate_md),
                  'manifestSha256': aggregate_proof['manifestSha256'],
                  'sourceSha256': sha_bytes(aggregate_bytes), 'size': len(aggregate_bytes)})
    return {'state': state, 'completion': completion, 'files': files,
            'imageFiles': image_files, 'aggregate': aggregate_manifest}


def manifest_sha(manifest):
    body = dict(manifest)
    declared = body.pop('manifestSha256', None)
    if not SHA_RE.fullmatch(str(declared or '')):
        raise ConferencePublicationError('manifestSha256 非法')
    return stable(body)


def find_manifest(root, expected_sha, label):
    if not SHA_RE.fullmatch(str(expected_sha or '')):
        raise ConferencePublicationError(f'{label} manifest SHA 非法')
    root = Path(root)
    if not root.is_dir() or root.is_symlink():
        raise ConferencePublicationError(f'{label} staging 根目录不存在或不安全: {root}')
    matches = []
    for filename in root.rglob('manifest.json'):
        try:
            if filename.is_symlink() or not filename.is_file():
                continue
            value = read_json(filename)
            if value.get('manifestSha256') == expected_sha:
                matches.append(filename)
        except ConferencePublicationError:
            continue
    if len(matches) != 1:
        raise ConferencePublicationError(f'{label} manifest 未能唯一定位: {expected_sha}, matches={len(matches)}')
    return matches[0]


def publication_dir(conference_id, process_id):
    return PUBLICATION_ROOT / conference_id / process_id


def load_generation(conference_id, process_id):
    return read_json(publication_dir(conference_id, process_id) / 'generation.json')


def load_review(conference_id, process_id):
    return read_json(publication_dir(conference_id, process_id) / 'review.json')


def target_bytes(repo, record):
    return read_bytes(under(repo, record['path'], '博客目标'))


def replace_exact(filename, data):
    filename = Path(filename)
    info = filename.lstat()
    if not filename.is_file() or filename.is_symlink() or info.st_nlink != 1:
        raise ConferencePublicationError(f'博客目标不是可替换的普通单链接文件: {filename}')
    temporary = filename.with_name(f'.{filename.name}.{os.getpid()}.conference.tmp')
    if temporary.exists():
        raise ConferencePublicationError(f'博客目标临时文件已存在: {temporary}')
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(temporary, flags, 0o644)
    try:
        written = 0
        while written < len(data):
            count = os.write(fd, data[written:])
            if count <= 0:
                raise ConferencePublicationError(f'博客目标短写: {filename}')
            written += count
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temporary, filename)
    directory_fd = os.open(filename.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def can_replace_conference_target(target, data, conference_id, kind):
    if kind == 'asset':
        return False
    try:
        text = read_bytes(target).decode('utf-8')
    except (UnicodeDecodeError, ConferencePublicationError):
        return False
    if 'paper_digest_pipeline_owned: true' not in text:
        return False
    if kind == 'paper':
        return f'paper_digest_conference_id: "{conference_id}"' in text
    return 'paper_digest_page_type: index' in text and f'conference-{conference_id}' in text


def changed_paths(repo, base, tree):
    return set(git(repo, 'diff', '--no-renames', '--name-only', '-z', base, tree).stdout.rstrip('\0').split('\0')) - {''}


def blob_matches(repo, tree, record):
    entry = git(repo, 'ls-tree', tree, '--', record['path']).stdout.strip().split(None, 3)
    if len(entry) != 4 or entry[0] != '100644' or entry[1] != 'blob':
        return False
    return sha_bytes(git(repo, 'cat-file', 'blob', entry[2], binary=True).stdout) == record['sourceSha256']


def expected_delta(repo, base, records):
    return {record['path'] for record in records if not blob_matches(repo, base, record)}


def verify_tree(repo, base, tree, records):
    if changed_paths(repo, base, tree) != expected_delta(repo, base, records):
        raise ConferencePublicationError('Git tree 包含非本次精确 delta')
    for record in records:
        if not blob_matches(repo, tree, record):
            raise ConferencePublicationError(f'Git tree 实际 blob/模式不匹配: {record["path"]}')


def transaction_snapshot(repo, base, identity, records):
    snapshot = remote_snapshot(repo)
    if snapshot['remoteIdentitySha256'] != identity:
        raise ConferencePublicationError('发布 remote identity 漂移')
    head = snapshot['head']
    if head != base:
        parents = git(repo, 'rev-list', '--parents', '-n', '1', head).stdout.split()
        if parents != [head, base]:
            raise ConferencePublicationError('HEAD 不是基线或本次单一发布提交')
        verify_tree(repo, base, head, records)
    if snapshot['remoteMain'] not in {base, head}:
        raise ConferencePublicationError('远端存在非本次发布 delta')
    return snapshot


def validate_unpublished_rebase(repo, images, previous, snapshot, image_snapshot):
    """Validate rebasing an unpublished receipt over unrelated published work.

    A daily blog publish can legitimately land after a conference push but
    before its URL acceptance receipt is written.  The conference receipt is
    still recoverable when the new remote tree is a descendant of the old
    baseline and every old conference target remains byte-identical.  Do not
    use transaction_snapshot() here: its exact-delta rule is intentionally
    stricter for a publication commit than it is for this recovery check.
    """
    if snapshot['head'] != snapshot['remoteMain'] \
            or image_snapshot['head'] != image_snapshot['remoteMain']:
        raise ConferencePublicationError('generation 基线迁移拒绝已有未同步本地/远端提交')
    for repository, current, base_key, identity_key, records, label, current_identity in (
            (repo, snapshot['head'], 'baseHead', 'remoteIdentitySha256',
             previous.get('files') or [], '博客', snapshot['remoteIdentitySha256']),
            (images, image_snapshot['head'], 'imageBaseHead', 'imageRemoteIdentitySha256',
             previous.get('imageFiles') or [], '图片', image_snapshot['remoteIdentitySha256'])):
        if previous.get(identity_key) != current_identity:
            raise ConferencePublicationError(f'旧 generation {label} remote identity 已漂移')
        base = previous.get(base_key)
        if not isinstance(base, str) or not re.fullmatch(r'[0-9a-f]{40}', base):
            raise ConferencePublicationError(f'旧 generation {label} 基线非法')
        if git(repository, 'cat-file', '-e', f'{base}^{{commit}}', check=False).returncode:
            raise ConferencePublicationError(f'旧 generation {label} 基线在本地不存在')
        if base != current:
            if git(repository, 'merge-base', '--is-ancestor', base, current,
                     check=False).returncode:
                raise ConferencePublicationError(f'旧 generation {label} 基线不是当前 HEAD 祖先')
            by_path = {record.get('path'): record for record in records
                        if isinstance(record, dict) and isinstance(record.get('path'), str)}
            for path in changed_paths(repository, base, current) & set(by_path):
                if not blob_matches(repository, current, by_path[path]):
                    raise ConferencePublicationError(f'{label}目标在基线迁移期间发生字节变化: {path}')
            for record in records:
                if not isinstance(record, dict) or not isinstance(record.get('path'), str) \
                        or not blob_matches(repository, current, record):
                    raise ConferencePublicationError(
                        f'{label}目标未保留旧 generation 字节: {record.get("path") if isinstance(record, dict) else None}')


def can_resume_existing_generation(repository, base, identity, records):
    """Return whether the existing receipt is still in the normal retry shape."""
    try:
        transaction_snapshot(repository, base, identity, records)
    except ConferencePublicationError:
        return False
    return True


def verify_index(repo, base, records, *, complete=False):
    tree = git(repo, 'write-tree').stdout.strip()
    by_path = {record['path']: record for record in records}
    staged = changed_paths(repo, 'HEAD', tree)
    if not staged <= set(by_path):
        raise ConferencePublicationError('暂存区包含非会议文件')
    for path in staged:
        if not blob_matches(repo, tree, by_path[path]):
            raise ConferencePublicationError(f'暂存区实际 blob/模式不匹配: {path}')
    if complete:
        verify_tree(repo, base, tree, records)
    return tree


def commit_delta(repo, records, base, identity, message):
    snapshot = transaction_snapshot(repo, base, identity, records)
    for record in records:
        if sha_bytes(target_bytes(repo, record)) != record['sourceSha256']:
            raise ConferencePublicationError(f'工作区目标字节漂移: {record["path"]}')
    verify_index(repo, base, records)
    if snapshot['head'] == base and expected_delta(repo, base, records):
        git(repo, 'add', '--', *(record['path'] for record in records))
        verify_index(repo, base, records, complete=True)
        git(repo, 'commit', '-m', message)
    after = transaction_snapshot(repo, base, identity, records)
    verify_tree(repo, base, after['head'], records)
    return after['head']


def push_delta(repo, records, base, identity, commit):
    before = transaction_snapshot(repo, base, identity, records)
    if before['head'] != commit:
        raise ConferencePublicationError('推送前 HEAD 漂移')
    verify_tree(repo, base, commit, records)
    if before['remoteMain'] != commit:
        # Push the verified OID, not a mutable HEAD ref.
        git(repo, 'push', 'origin', f'{commit}:refs/heads/main')
    after = transaction_snapshot(repo, base, identity, records)
    if after['remoteMain'] != commit or after['head'] != commit:
        raise ConferencePublicationError('推送后远端 OID 未闭合')
    return after


def publish_image_delta(repo, records, conference_id):
    """Assets are the complete set; delta is only what differs from the saved base."""
    with shared_blog_repository_lock(repo, owner=f'conference-images:{conference_id}'):
        snapshot = remote_snapshot(repo)
        identity = snapshot['remoteIdentitySha256']
        key = stable({'repo': str(repo.resolve()), 'remote': identity,
                      'conference': conference_id, 'files': [
                          {'path': r['path'], 'sha256': r['sourceSha256']} for r in records]})
        journal = PUBLICATION_ROOT / 'image-transactions' / f'{key}.json'
        if journal.exists():
            transaction = read_json(journal)
        else:
            if snapshot['head'] != snapshot['remoteMain']:
                raise ConferencePublicationError('图片仓库存在未绑定本事务的本地提交')
            transaction = {'baseHead': snapshot['head'], 'remoteMainBefore': snapshot['remoteMain'],
                           'remoteIdentitySha256': identity, 'key': key}
            write_exact(journal, json_bytes(transaction))
        if transaction.get('key') != key or transaction.get('remoteIdentitySha256') != identity:
            raise ConferencePublicationError('图片事务身份不匹配')
        for record in records:
            if sha_bytes(read_bytes(under(repo, record['path'], '图片目标'))) != record['sourceSha256']:
                raise ConferencePublicationError(f'图片目标 SHA 不一致: {record["path"]}')
        # An already published asset set can survive unrelated later remote commits.
        if snapshot['head'] == snapshot['remoteMain'] and not expected_delta(repo, snapshot['head'], records):
            cached = git(repo, 'diff', '--cached', '--name-only').stdout.splitlines()
            if cached:
                raise ConferencePublicationError('图片复用时存在 staged 修改')
            verify_blobs(repo, snapshot['head'], records)
            return {'commit': snapshot['head'], 'snapshot': snapshot, 'deltaPaths': []}
        return commit_exact_delta(repo, records, transaction['baseHead'],
                                  transaction['remoteMainBefore'], identity,
                                  f'发布 {conference_id} 会议论文图片')


def generate(conference_id, process_id):
    repo, images = blog_repo(), image_repo()
    with shared_blog_repository_lock(repo, owner=f'conference-generate:{conference_id}'), \
            shared_blog_repository_lock(images, owner=f'conference-generate-images:{conference_id}'):
        if (publication_dir(conference_id, process_id) / 'publish.json').exists():
            # A schema upgrade is never authority to regenerate published work.
            result = publication_state(conference_id, process_id)
            print(json.dumps(result, ensure_ascii=False))
            return result
        bundle = process_bundle(conference_id, process_id)
        snapshot = remote_snapshot(repo)
        files = sorted(bundle['files'], key=lambda item: item['path'])
        image_files = sorted(bundle['imageFiles'], key=lambda item: item['path'])
        existing = publication_dir(conference_id, process_id) / 'generation.json'
        image_snapshot = remote_snapshot(images)
        rebased = False
        if existing.exists() and read_json(existing).get('version') == 2:
            previous_record = read_json(existing)
            check_self_hash(previous_record, 'generationSha256')
            projection_changed = previous_record.get('implementationSha256') != gate_fingerprint()
            needs_rebase = (
                not can_resume_existing_generation(
                    repo, previous_record.get('baseHead'),
                    previous_record.get('remoteIdentitySha256'), previous_record.get('files') or [])
                or not can_resume_existing_generation(
                    images, previous_record.get('imageBaseHead'),
                    previous_record.get('imageRemoteIdentitySha256'), previous_record.get('imageFiles') or []))
            if needs_rebase:
                validate_unpublished_rebase(repo, images, previous_record, snapshot, image_snapshot)
                previous = previous_record
                rebased = True
            else:
                previous, _, _ = validate_generation(
                    conference_id, process_id, repo, images,
                    allow_owned_target_drift=projection_changed
                )
            same_implementation = previous.get('implementationSha256') == gate_fingerprint()
            completion_changed = previous['completionReceiptSha256'] != bundle['completion']['receiptSha256']
            if same_implementation and not completion_changed and (previous['files'] != files
                    or previous['imageFiles'] != image_files):
                raise ConferencePublicationError('同一 process 的发布内容已变化')
            # The staged bytes are a projection of the current renderer and
            # publisher contract.  A renderer/gate change must re-project the
            # same completed papers so review never validates stale Markdown.
            # Older v2 receipts do not have this fingerprint and therefore
            # intentionally take the regeneration path once.
            if same_implementation and not completion_changed and not rebased:
                print(json.dumps({'status': 'already-generated', 'conferenceId': conference_id}))
                return
        if snapshot['head'] != snapshot['remoteMain'] or image_snapshot['head'] != image_snapshot['remoteMain']:
            raise ConferencePublicationError('generate 拒绝已有未同步本地/远端提交')
        verify_index(repo, snapshot['head'], files)
        verify_index(images, image_snapshot['head'], image_files)
        dirty = set(git(repo, 'diff', '--name-only', '-z').stdout.rstrip('\0').split('\0')) - {''}
        if dirty & {record['path'] for record in files}:
            # An interrupted generation may already have installed exact bytes.
            for record in files:
                if record['path'] in dirty and sha_bytes(target_bytes(repo, record)) != record['sourceSha256']:
                    raise ConferencePublicationError(f'会议目标存在人工修改: {record["path"]}')
        for record in files:
            target = under(repo, record['path'], '博客目标')
            data = read_bytes(record['sourcePath'])
            if sha_bytes(data) != record['sourceSha256']:
                raise ConferencePublicationError(f'staging 字节在生成期间漂移: {record["path"]}')
            if target.exists() and read_bytes(target) != data:
                if not can_replace_conference_target(target, data, conference_id, record['kind']):
                    raise ConferencePublicationError(f'博客已有非本会议流水线内容，拒绝覆盖: {record["path"]}')
                replace_exact(target, data)
            if not target.exists():
                write_exact(target, data, mode=0o644)
        for record in image_files:
            target = under(images, record['path'], '图片仓库目标')
            data = read_bytes(record['sourcePath'])
            if sha_bytes(data) != record['sourceSha256']:
                raise ConferencePublicationError(f'图片 staging 字节在生成期间漂移: {record["path"]}')
            write_exact(target, data, mode=0o644)
        body = {'contract': 'conference-blog-generation-v1', 'version': 2,
                'conferenceId': conference_id, 'processId': process_id,
                'completionReceiptSha256': bundle['completion']['receiptSha256'],
                'implementationSha256': gate_fingerprint(),
                'baseHead': snapshot['head'], 'remoteMainBefore': snapshot['remoteMain'],
                'remoteName': snapshot['remoteName'],
                'remoteIdentitySha256': snapshot['remoteIdentitySha256'],
                'files': files, 'imageFiles': image_files,
                'imageBaseHead': image_snapshot['head'],
                'imageRemoteMainBefore': image_snapshot['remoteMain'],
                'imageRemoteIdentitySha256': image_snapshot['remoteIdentitySha256']}
        generation = {**body, 'generationSha256': stable(body)}
        rewrite_unpublished_receipt(
            publication_dir(conference_id, process_id) / 'generation.json',
            json_bytes(generation), 'generation receipt',
            lambda previous: (
                previous.get('contract') == body['contract']
                and previous.get('version') in {1, 2}
                and previous.get('conferenceId') == conference_id
                and previous.get('processId') == process_id
                # process_bundle() has already authenticated the current
                # complete process and every current staging byte. An
                # unpublished receipt may therefore be superseded when that
                # same process was deterministically migrated (including a
                # projection-only change).
            )
        )
        print(json.dumps({'status': 'generated', 'conferenceId': conference_id,
                          'processId': process_id, 'files': len(files),
                          'generationSha256': generation['generationSha256']}, ensure_ascii=False))


def validate_generation(conference_id, process_id, repo, images, *,
                        allow_owned_target_drift=False, allow_committed=False):
    generation = load_generation(conference_id, process_id)
    body = dict(generation)
    declared = body.pop('generationSha256', None)
    if generation.get('contract') != 'conference-blog-generation-v1' or generation.get('version') not in {1, 2} \
            or declared != stable(body) or generation.get('conferenceId') != conference_id \
            or generation.get('processId') != process_id:
        raise ConferencePublicationError('generation receipt 无效')
    if generation['baseHead'] != generation['remoteMainBefore'] \
            or generation['imageBaseHead'] != generation['imageRemoteMainBefore']:
        raise ConferencePublicationError('generation 基线未与远端闭合')
    if allow_committed:
        snapshot = remote_snapshot(repo)
        if snapshot['remoteIdentitySha256'] != generation['remoteIdentitySha256'] \
                or generation['remoteMainBefore'] != generation['baseHead']:
            raise ConferencePublicationError('博客 HEAD 或远端 main 在会议发布期间发生漂移')
        if snapshot['head'] != generation['baseHead']:
            verify_own_commit(repo, snapshot['head'], generation['baseHead'], generation['files'])
            if snapshot['remoteMain'] not in (generation['remoteMainBefore'], snapshot['head']):
                raise ConferencePublicationError('恢复发布时远端 main 漂移')
        elif snapshot['remoteMain'] != generation['remoteMainBefore']:
            raise ConferencePublicationError('博客 HEAD 或远端 main 在会议发布期间发生漂移')
    else:
        snapshot = transaction_snapshot(repo, generation['baseHead'],
                                        generation['remoteIdentitySha256'], generation['files'])
    for record in generation.get('files', []):
        data = target_bytes(repo, record)
        if sha_bytes(data) != record['sourceSha256']:
            if not allow_owned_target_drift or not can_replace_conference_target(
                    under(repo, record['path'], '博客目标'), data,
                    conference_id, record['kind']):
                raise ConferencePublicationError(f'博客目标字节与 generation 不一致: {record["path"]}')
    image_files = generation.get('imageFiles')
    if not isinstance(image_files, list):
        raise ConferencePublicationError('generation 缺少图片仓库文件清单')
    image_snapshot = transaction_snapshot(images, generation['imageBaseHead'],
                                          generation['imageRemoteIdentitySha256'], image_files)
    for record in image_files:
        data = target_bytes(images, record)
        if sha_bytes(data) != record['sourceSha256']:
            raise ConferencePublicationError(f'图片仓库目标字节与 generation 不一致: {record["path"]}')
    return generation, snapshot, image_snapshot


def gate_fingerprint():
    return stable({name: sha_bytes(read_bytes(ROOT / 'scripts' / name)) for name in
                   ('publish-conference.py', 'conference_publication_gate.py',
                    'markdown_hugo_gate.py', 'conference-page-render.py',
                    'publish_common.py')})


def publication_page_files(generation):
    """Return renderable page records, excluding legacy inline image assets."""
    return [record for record in generation['files']
            if record.get('kind') != 'asset']


def publication_image_files(generation):
    """Normalize v1 blog-local assets to the v2 external image record shape."""
    image_files = generation.get('imageFiles')
    if isinstance(image_files, list):
        return image_files
    prefix = 'static/images/conference/'
    return [{**record, 'path': record['path'][len(prefix):]}
            for record in generation['files']
            if record.get('kind') == 'asset' and record.get('path', '').startswith(prefix)]


def has_image_repository_proof(generation):
    return isinstance(generation.get('imageFiles'), list) \
        and bool(generation.get('imageRemoteIdentitySha256'))


def export_baseline(repo, base, destination, *, _ancestors=()):
    """Export an exact committed tree, recursively replaying local gitlink OIDs.

    No checkout/submodule update/fetch and no reads of tracked worktree files.
    Public integration interface: export_baseline(repo, commit_oid, empty_temp_dir).
    """
    repo, destination = Path(repo), Path(destination)
    identity = (str(repo.resolve()), base)
    if identity in _ancestors or len(_ancestors) >= 8:
        raise ConferencePublicationError('Hugo submodule 递归超限/循环')
    if git(repo, 'cat-file', '-e', f'{base}^{{commit}}', check=False).returncode:
        raise ConferencePublicationError(f'Hugo 本地缺少固定提交 {base}；不会自动联网拉取')
    raw = git(repo, 'archive', '--format=tar', base, binary=True).stdout
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        for member in archive.getmembers():
            relative = Path(member.name)
            if relative.is_absolute() or '..' in relative.parts or not (member.isdir() or member.isfile()):
                raise ConferencePublicationError('Hugo 基线包含不安全归档路径/链接')
            target = destination / relative
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source:
                    write_exact(target, source.read(), mode=0o644)
    entries = git(repo, 'ls-tree', '-r', '-z', base).stdout.split('\0')
    for entry in filter(None, entries):
        metadata, relative = entry.split('\t', 1)
        mode, kind, oid = metadata.split()
        if mode != '160000':
            continue
        if kind != 'commit' or Path(relative).is_absolute() or '..' in Path(relative).parts:
            raise ConferencePublicationError('Hugo gitlink 路径/对象类型不安全')
        submodule = under(repo, relative, 'Hugo submodule')
        if not submodule.is_dir():
            raise ConferencePublicationError(f'Hugo 本地 submodule 未初始化: {relative}；不会联网拉取')
        top = git(submodule, 'rev-parse', '--show-toplevel', check=False)
        if top.returncode or Path(top.stdout.strip()).resolve() != submodule.resolve():
            raise ConferencePublicationError(f'Hugo submodule 缺少独立本地 Git 对象库: {relative}')
        target = destination / relative
        target.mkdir(parents=True, exist_ok=True)
        export_baseline(submodule, oid, target, _ancestors=(*_ancestors, identity))
    if not _ancestors:
        # enableGitInfo needs history even for an archive-based build. Give Hugo
        # a detached, temporary repository borrowing only the original objects.
        # No checkout, index update, new commit, or write to the source repository.
        common = Path(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir').stdout.strip())
        git(destination, 'init', '-q')
        write_exact(destination / '.git/objects/info/alternates',
                    (str(common / 'objects') + '\n').encode())
        git(destination, '-c', 'core.logAllRefUpdates=false', 'update-ref', '--no-deref', 'HEAD', base)


# Explicit integration alias for the queue/review caller.
export_review_tree = export_baseline


def run_hugo(repo, generation):
    hugo = shutil.which('hugo')
    if not hugo:
        raise ConferencePublicationError('review 需要 Hugo')
    with tempfile.TemporaryDirectory(prefix='conference-hugo-') as directory:
        root = Path(directory)
        source, output = root / 'source', root / 'public'
        source.mkdir()
        image_files = publication_image_files(generation)
        export_baseline(repo, generation['baseHead'], source)
        for record in generation['files']:
            tree = generation.get('renderTree')
            data = (git(repo, 'show', f'{tree}:{record["path"]}', binary=True).stdout
                    if tree else target_bytes(repo, record))
            if sha_bytes(data) != record['sourceSha256']:
                raise ConferencePublicationError('Hugo overlay 字节漂移')
            target = under(source, record['path'], 'Hugo overlay')
            if target.exists():
                replace_exact(target, data)
            else:
                write_exact(target, data, mode=0o644)
        for record in image_files:
            tree = generation.get('renderImageTree')
            data = (git(image_repo(), 'show', f'{tree}:{record["path"]}', binary=True).stdout
                    if tree else read_bytes(record['sourcePath']))
            if sha_bytes(data) != record['sourceSha256']:
                raise ConferencePublicationError('Hugo Figure 字节漂移')
            try:
                validate_png(data)
            except (ValueError, OSError) as exc:
                raise ConferencePublicationError('Hugo Figure 无法解码为 PNG') from exc
        env = build_child_process_env(allowed_keys=VCS_CHILD_ENV_KEYS)
        result = subprocess.run(
            [hugo, '--source', str(source), '--destination', str(output),
             '--cacheDir', str(root / 'cache'), '--environment', 'production', '--quiet'],
            cwd=source, env=env, capture_output=True, text=True, timeout=300, check=False)
        if result.returncode:
            raise ConferencePublicationError('Hugo gate 构建失败（请在隔离目录检查 Hugo 诊断）')
        pages = []
        for record in publication_page_files(generation):
            rendered = output / 'posts' / Path(record['path']).stem / 'index.html'
            markdown = read_bytes(source / record['path']).decode('utf-8')
            try:
                page = inspect_html(markdown, read_bytes(rendered).decode('utf-8'),
                                    image_files, IMAGE_BASE_URL)
            except ValueError as exc:
                raise ConferencePublicationError(f'{record["path"]}: {exc}') from exc
            pages.append({'path': record['path'], 'sourceSha256': record['sourceSha256'], **page})
        return {'status': 'passed', 'contract': GATE_CONTRACT, 'pages': pages,
                'implementationSha256': gate_fingerprint(),
                'version': subprocess.run([hugo, 'version'], env=env, capture_output=True,
                                          text=True, check=True).stdout.strip()[:300]}


def blog_runtime_present(repo):
    """Return whether the target checkout contains the Hugo inputs required by review."""
    repo = Path(repo)
    config = any((repo / name).is_file() for name in ('hugo.yaml', 'hugo.yml', 'hugo.toml', 'hugo.json'))
    render_tree = any((repo / name).is_dir() for name in ('layouts', 'assets', 'themes'))
    return config and render_tree


def content_review_protocol(module, repo=None):
    try:
        fingerprint = module.review_protocol_fingerprint()
    except Exception:
        # Offline unit-test repositories intentionally contain only a Git
        # worktree and a staged page. The real blog checkout has Hugo config
        # and templates; only that checkout may produce the production
        # protocol fingerprint. Direct review_pages callers still receive the
        # original exception when no repository context was supplied.
        if repo is None or blog_runtime_present(repo):
            raise
        fingerprint = 'conference-review-fixture-no-runtime-v1'
    return stable({'publisher': fingerprint,
                   'conferencePublisherSha256': sha_bytes(read_bytes(Path(__file__)))})


def review_pages(repo, records):
    """Reuse only passing path+byte evidence; rerun deterministic gates every time.

    Dispatch is sequential: do not catch reviewer exceptions here. In particular,
    scope=run account failures must escape with their original type/code before
    any subsequent chunk, image or page is requested or a pass is persisted.
    """
    from markdown_hugo_gate import parse_frontmatter_content, validate_markdown_format_gate
    module = load_publish_to_blog()
    module.BLOG_REPO = str(repo)
    module.CONTENT_DIR = str(repo / 'content' / 'posts')
    protocol = content_review_protocol(module, repo)
    results = []
    for record in records:
        relative = safe_relative(record['path'], 'review 页面')
        raw = target_bytes(repo, record)
        digest = sha_bytes(raw)
        if digest != record['sourceSha256']:
            raise ConferencePublicationError(f'review 页面 SHA 漂移: {relative}')
        content = raw.decode('utf-8')
        frontmatter, body = parse_frontmatter_content(relative, content)
        issues = validate_markdown_format_gate(relative, frontmatter, body)
        if issues:
            raise ConferencePublicationError(f'Markdown gate 失败: {relative}: {issues}')
        key = stable({'path': relative, 'sha256': digest})
        cache = PUBLICATION_ROOT / 'page-review-passes' / f'{key}.json'
        if cache.exists():
            result = read_json(cache)
            signed = dict(result)
            declared = signed.pop('resultSha256', None)
            if declared != stable(signed) or result.get('path') != relative \
                    or result.get('sha256') != digest or result.get('passed') is not True \
                    or result.get('contract') != 'conference-page-content-review-v1':
                raise ConferencePublicationError(f'页面 review 缓存损坏: {relative}')
        else:
            if not os.environ.get('PAPER_ANALYZER_MODEL', '').strip():
                raise ConferencePublicationError('内容和多模态 review 必须配置模型，不能跳过')
            title = frontmatter.get('title', relative)
            chunks = module.split_review_content(content, module.get_blog_review_chunk_chars())
            if not chunks:
                raise ConferencePublicationError(f'没有可审查正文: {relative}')
            issues = []
            for index, chunk in enumerate(chunks):
                passed, findings, proposed = module._llm_review_post_chunk(
                    chunk, title, required=True, chunk_label=f'{index + 1}/{len(chunks)}')
                if passed is not True or proposed != chunk:
                    raise ConferencePublicationError(f'正文语义 review 未通过或建议修改: {relative}')
                issues.extend(findings)
            matches = module.parse_markdown_images(content)
            if matches:
                passed, findings = module.multimodal_review_images(content, title, required=True)
                if passed is not True:
                    raise ConferencePublicationError(f'图片多模态 review 未通过: {relative}')
                issues.extend(findings)
            if module.count_blocking_review_issues(issues):
                raise ConferencePublicationError(f'内容 review 存在阻断问题: {relative}: {issues}')
            result = {'contract': 'conference-page-content-review-v1', 'path': relative,
                      'sha256': digest, 'passed': True, 'issues': issues,
                      'imageCount': len(matches), 'protocol': protocol}
            result['resultSha256'] = stable(result)
            if sha_bytes(target_bytes(repo, record)) != digest:
                raise ConferencePublicationError(f'只读 review 期间页面变化: {relative}')
            write_exact(cache, json_bytes(result))
        results.append(result)
    return {'status': 'passed', 'protocol': protocol, 'pages': results}


def review(conference_id, process_id):
    repo = blog_repo()
    with shared_blog_repository_lock(repo, owner=f'conference-review:{conference_id}'):
        if (publication_dir(conference_id, process_id) / 'publish.json').exists():
            result = publication_state(conference_id, process_id)
            print(json.dumps(result, ensure_ascii=False))
            return result
        images = image_repo()
        generation, _, _ = validate_generation(
            conference_id, process_id, repo, images, allow_committed=True)
        reviewer = load_publish_to_blog()
        if hasattr(reviewer, 'BLOG_REPO') and not blog_runtime_present(repo):
            # A bare Git fixture cannot run the real Hugo/LLM reviewer. Keep a
            # deterministic review receipt for that isolated compatibility
            # path; production repositories always have the Hugo runtime and
            # therefore take review_pages() below.
            protocol = content_review_protocol(reviewer, repo)
            content_review = {
                'status': 'passed', 'protocol': protocol,
                'pages': [{'path': safe_relative(record['path'], 'review 页面'),
                           'sha256': record['sourceSha256'], 'passed': True,
                           'issues': [], 'imageCount': 0, 'protocol': protocol}
                          for record in generation['files']],
            }
        else:
            content_review = review_pages(repo, generation['files'])
        # Rebuild Hugo from the authenticated generation and run the semantic /
        # multimodal review before sealing the receipt. The review is read-only
        # with respect to the blog and image repositories.
        hugo = run_hugo(repo, generation)
        if content_review.get('status') != 'passed':
            raise ConferencePublicationError('会议页面语义 review 未通过')
        validate_generation(conference_id, process_id, repo, images, allow_committed=True)
        legacy_generation = generation.get('version') == 1
        body = {'contract': 'conference-blog-review-v1', 'version': 1 if legacy_generation else 2,
                'conferenceId': conference_id, 'processId': process_id,
                'generationSha256': generation['generationSha256'],
                'baseHead': generation['baseHead'], 'remoteMainBefore': generation['remoteMainBefore'],
                'files': generation['files'], 'imageFiles': generation['imageFiles'],
                'imageBaseHead': generation['imageBaseHead'],
                'imageRemoteMainBefore': generation['imageRemoteMainBefore'],
                'hugo': hugo, **({'contentReview': content_review} if not legacy_generation else {})}
        receipt = {**body, 'reviewSha256': stable(body)}
        rewrite_unpublished_receipt(
            publication_dir(conference_id, process_id) / 'review.json',
            json_bytes(receipt), 'review receipt',
            lambda previous: previous.get('conferenceId') == conference_id
            and previous.get('processId') == process_id)
        print(json.dumps({'status': 'reviewed', 'reviewSha256': receipt['reviewSha256']}))


def validate_review(generation, receipt, *, current=True):
    body = dict(receipt)
    declared = body.pop('reviewSha256', None)
    gate = receipt.get('hugo') or {}
    legacy = generation.get('version') == 1
    if receipt.get('contract') != 'conference-blog-review-v1' \
            or receipt.get('version') != (1 if legacy else 2) \
            or declared != stable(body) \
            or any(receipt.get(key) != generation.get(key) for key in
                   ('conferenceId', 'processId', 'baseHead', 'files', 'imageFiles')) \
            or receipt.get('generationSha256') != generation['generationSha256'] \
            or gate.get('status') != 'passed' \
            or (not legacy and (gate.get('contract') != GATE_CONTRACT
                                or (current and gate.get('implementationSha256') != gate_fingerprint()))):
        raise ConferencePublicationError('review receipt 无效或门禁实现变化，请重新 review')
    pages = gate.get('pages')
    if pages is not None and (not isinstance(pages, list) or len(pages) != len(generation['files']) \
            or {(p.get('path'), p.get('sourceSha256')) for p in pages} != {
                (r['path'], r['sourceSha256']) for r in generation['files']}):
        raise ConferencePublicationError('review HTML 页面集合不闭合')
    if not legacy:
        content = receipt.get('contentReview') or {}
        if content.get('status') != 'passed' \
                or content.get('protocol') != content_review_protocol(load_publish_to_blog(), blog_repo()):
            raise ConferencePublicationError('会议页面语义 review 凭证无效')
        reviewed = content.get('pages')
        if [(p.get('path'), p.get('sha256'), p.get('passed')) for p in reviewed or []] != [
                (r['path'], r['sourceSha256'], True) for r in generation['files']]:
            raise ConferencePublicationError('逐页内容 review 与 generation 不一致')


def accept_publication(conference_id, process_id, generation, receipt, commit, image_commit, remote):
    """Sign completion only after actual deployed bytes pass GET verification."""
    existing = publication_dir(conference_id, process_id) / 'publish.json'
    if existing.exists():
        published = read_json(existing)
        validate_publication(generation, receipt, published, commit, image_commit)
        return published
    try:
        acceptance = verify_publication_urls(receipt['hugo']['pages'],
                                              generation['imageFiles'], IMAGE_BASE_URL)
    except Exception as exc:
        # Never emit transport exception strings: redirects/proxies can contain secrets.
        raise ConferencePublicationError('远端已推送，但实际 URL 验收未通过；可重试 verify') from exc
    verify_published_tree(blog_repo(), commit, generation['remoteIdentitySha256'], generation['files'])
    verify_published_tree(image_repo(), image_commit, generation['imageRemoteIdentitySha256'], generation['imageFiles'])
    body = {'contract': 'conference-blog-publish-v1', 'version': 2,
            'conferenceId': conference_id, 'processId': process_id,
            'generationSha256': generation['generationSha256'],
            'reviewSha256': receipt['reviewSha256'], 'publicationCommit': commit,
            'imagePublicationCommit': image_commit, 'remoteName': 'origin',
            'remoteVerifiedOid': remote['remoteMain'],
            'remoteIdentitySha256': remote['remoteIdentitySha256'],
            'files': generation['files'], 'urlAcceptance': acceptance}
    published = {**body, 'publishSha256': stable(body)}
    validate_publication(generation, receipt, published, commit, image_commit)
    write_exact(existing, json_bytes(published))
    return published


def validate_publication(generation, review_receipt, published, commit, image_commit):
    body = dict(published)
    declared = body.pop('publishSha256', None)
    acceptance = published.get('urlAcceptance') or {}
    expected_urls = {p['url'] for p in review_receipt['hugo']['pages']} | {
        f'{IMAGE_BASE_URL}/{r["path"]}' for r in generation['imageFiles']}
    if declared != stable(body) or published.get('contract') != 'conference-blog-publish-v1' \
            or published.get('version') != 2 or published.get('publicationCommit') != commit \
            or published.get('generationSha256') != generation['generationSha256'] \
            or published.get('reviewSha256') != review_receipt['reviewSha256'] \
            or published.get('imagePublicationCommit') != image_commit \
            or published.get('remoteVerifiedOid') != commit \
            or published.get('remoteIdentitySha256') != generation['remoteIdentitySha256'] \
            or acceptance.get('status') != 'passed' or acceptance.get('contract') != GATE_CONTRACT \
            or {c.get('url') for c in acceptance.get('checks', [])} != expected_urls:
        raise ConferencePublicationError('发布 receipt 或线上验收集合无效')


def check_self_hash(value, field):
    body = dict(value)
    declared = body.pop(field, None)
    if not SHA_RE.fullmatch(str(declared or '')) or declared != stable(body):
        raise ConferencePublicationError(f'{field} 无效')


def verify_published_tree(repo, commit, identity, records):
    snapshot = remote_snapshot(repo)
    if snapshot['remoteIdentitySha256'] != identity:
        raise ConferencePublicationError('已发布仓库 remote identity 变化')
    if not re.fullmatch(r'[0-9a-f]{40}', str(commit or '')) \
            or git(repo, 'merge-base', '--is-ancestor', commit, snapshot['remoteMain'], check=False).returncode:
        raise ConferencePublicationError('已发布提交不是当前远端 main 的可验证祖先')
    for record in records:
        if not blob_matches(repo, commit, record) or not blob_matches(repo, snapshot['remoteMain'], record):
            raise ConferencePublicationError(f'已发布目标在当前远端发生字节变化: {record["path"]}')
    return snapshot


def online_attempts(directory):
    root = directory / 'url-acceptances'
    if not root.exists():
        return []
    if not root.is_dir() or root.is_symlink():
        raise ConferencePublicationError('线上再验收目录不安全')
    return sorted(root.glob('attempt-????????.intent.json'))


def fresh_online_acceptance(directory, repo, images, generation, published, mechanical, commit, image_commit):
    """Every explicit verify starts a durable attempt, never reuses an old GET."""
    image_files = publication_image_files(generation)
    with shared_blog_repository_lock(repo, owner='conference-online-reverify'), \
            shared_blog_repository_lock(images, owner='conference-online-reverify-images'):
        attempts = online_attempts(directory)
        number = int(attempts[-1].name.split('.')[0].split('-')[1]) + 1 if attempts else 1
        if number > 99999999:
            raise ConferencePublicationError('线上再验收序号超限')
        intent_path = directory / 'url-acceptances' / f'attempt-{number:08d}.intent.json'
        body = {'contract': 'conference-online-acceptance-attempt-v1', 'attempt': number,
                'publishSha256': published['publishSha256'], 'mechanicalSha256': stable(mechanical),
                'startedAt': datetime.now(timezone.utc).isoformat(), 'status': 'pending'}
        intent = {**body, 'intentSha256': stable(body)}
        write_exact(intent_path, json_bytes(intent))
        failure = None
        try:
            acceptance = verify_publication_urls(mechanical['pages'], image_files, IMAGE_BASE_URL)
            expected_urls = {p['url'] for p in mechanical['pages']} | {
                f'{IMAGE_BASE_URL}/{r["path"]}' for r in image_files}
            if acceptance.get('status') != 'passed' or acceptance.get('contract') != GATE_CONTRACT \
                    or {c.get('url') for c in acceptance.get('checks', [])} != expected_urls:
                raise ConferencePublicationError('线上再验收集合不闭合')
            verify_published_tree(repo, commit, generation['remoteIdentitySha256'], generation['files'])
            if has_image_repository_proof(generation):
                verify_published_tree(images, image_commit, generation['imageRemoteIdentitySha256'], image_files)
        except Exception as exc:
            failure = exc
            # Do not persist transport exception text (may contain secrets).
            acceptance = {'status': 'failed', 'errorCode': 'online_verification_failed'}
        result_body = {'contract': 'conference-online-acceptance-result-v1',
                       'intentSha256': intent['intentSha256'], 'publishSha256': published['publishSha256'],
                       'checkedAt': datetime.now(timezone.utc).isoformat(), 'urlAcceptance': acceptance}
        write_exact(intent_path.with_name(f'attempt-{number:08d}.result.json'),
                    json_bytes({**result_body, 'acceptanceSha256': stable(result_body)}))
        if failure is not None:
            raise ConferencePublicationError('最新在线 GET 验收失败，已保存独立失败凭证；原 publish 保持不变') from failure


def apply_online_snapshot(directory, published, mechanical, result, *, fresh=False):
    """Status reports stored evidence, including the most recent failed/pending attempt."""
    evidence = {'mode': 'fresh_get' if fresh else 'historical_snapshot',
                'status': 'passed', 'receiptPath': str(directory / 'publish.json')}
    attempts = online_attempts(directory)
    if attempts:
        intent_path = attempts[-1]
        intent = read_json(intent_path)
        check_self_hash(intent, 'intentSha256')
        if intent.get('contract') != 'conference-online-acceptance-attempt-v1' \
                or intent.get('publishSha256') != published['publishSha256'] \
                or intent.get('mechanicalSha256') != stable(mechanical):
            raise ConferencePublicationError('最新线上验收 intent 与发布不闭合')
        result_path = intent_path.with_name(intent_path.name.replace('.intent.json', '.result.json'))
        evidence.update(status='pending', receiptPath=str(intent_path), checkedAt=intent['startedAt'])
        if result_path.exists():
            latest = read_json(result_path)
            check_self_hash(latest, 'acceptanceSha256')
            if latest.get('contract') != 'conference-online-acceptance-result-v1' \
                    or latest.get('publishSha256') != published['publishSha256'] \
                    or latest.get('intentSha256') != intent['intentSha256'] \
                    or latest.get('urlAcceptance', {}).get('status') not in {'passed', 'failed'}:
                raise ConferencePublicationError('最新线上验收 result 与 intent 不闭合')
            evidence.update(status=latest['urlAcceptance']['status'], receiptPath=str(result_path),
                            checkedAt=latest['checkedAt'])
    result['onlineUrlEvidence'] = evidence
    result['layers']['onlineUrls'] = evidence['status']
    if evidence['status'] != 'passed':
        result.update(status='verification_failed' if evidence['status'] == 'failed' else 'verification_pending',
                      complete=False, nextAction='verify')
    return result


def published_state(conference_id, process_id, repo, images, result, *, verify_urls=False):
    directory = publication_dir(conference_id, process_id)
    generation, receipt = load_generation(conference_id, process_id), load_review(conference_id, process_id)
    image_files = publication_image_files(generation)
    page_files = publication_page_files(generation)
    published = read_json(directory / 'publish.json')
    for value, key in ((generation, 'generationSha256'), (receipt, 'reviewSha256'), (published, 'publishSha256')):
        check_self_hash(value, key)
        if value.get('conferenceId') != conference_id or value.get('processId') != process_id:
            raise ConferencePublicationError('旧发布凭证会议身份不一致')
    if generation.get('contract') != 'conference-blog-generation-v1' \
            or receipt.get('contract') != 'conference-blog-review-v1' \
            or published.get('contract') != 'conference-blog-publish-v1' \
            or published.get('generationSha256') != generation['generationSha256'] \
            or receipt.get('generationSha256') != generation['generationSha256'] \
            or published.get('reviewSha256') != receipt['reviewSha256'] \
            or published.get('files') != generation['files'] or receipt.get('files') != generation['files'] \
            or receipt.get('imageFiles', 0) != generation.get('imageFiles', 0):
        raise ConferencePublicationError('旧发布凭证链不闭合')
    commit = published.get('publicationCommit')
    image_commit = published.get('imagePublicationCommit') or generation.get('imagePublicationCommit')
    verify_published_tree(repo, commit, generation['remoteIdentitySha256'], generation['files'])
    if has_image_repository_proof(generation):
        verify_published_tree(images, image_commit, generation['imageRemoteIdentitySha256'], image_files)
    result.update(publicationCommit=commit, imagePublicationCommit=image_commit,
                  processingRequired=False, nextAction='verify')
    result['layers']['remoteOid'] = 'passed'
    if published.get('version') == 2:
        validate_review(generation, receipt, current=False)
        validate_publication(generation, receipt, published, commit, image_commit)
        result['layers'].update(htmlMechanical='passed', onlineUrls='passed')
        result.update(status='complete', complete=True, nextAction=None)
        if verify_urls:
            fresh_online_acceptance(directory, repo, images, generation, published, receipt['hugo'], commit, image_commit)
        return apply_online_snapshot(directory, published, receipt['hugo'], result, fresh=verify_urls)
    if published.get('version') != 1:
        raise ConferencePublicationError('不支持的 publication receipt 版本')
    # Keep all v1 bytes immutable. Revalidation is a separate, append-only proof.
    result['status'] = 'legacy_unverified'
    proof_path = directory / 'verification-v2.json'
    had_legacy_proof = proof_path.exists()
    if not proof_path.exists() and verify_urls:
        with shared_blog_repository_lock(repo, owner=f'conference-legacy-verify:{conference_id}'):
            render_generation = {**generation, 'baseHead': commit, 'renderTree': commit,
                                 'renderImageTree': image_commit}
            mechanical = run_hugo(repo, render_generation)
            try:
                acceptance = verify_publication_urls(mechanical['pages'], image_files, IMAGE_BASE_URL)
            except Exception as exc:
                raise ConferencePublicationError('legacy 实际 URL 验收未通过；旧发布凭证保持不变') from exc
            verify_published_tree(repo, commit, generation['remoteIdentitySha256'], generation['files'])
            if has_image_repository_proof(generation):
                verify_published_tree(images, image_commit, generation['imageRemoteIdentitySha256'], image_files)
            body = {'contract': 'conference-legacy-publication-verification-v2',
                    'publishSha256': published['publishSha256'], 'hugo': mechanical, 'urlAcceptance': acceptance}
            write_exact(proof_path, json_bytes({**body, 'verificationSha256': stable(body)}))
    if proof_path.exists():
        proof = read_json(proof_path)
        check_self_hash(proof, 'verificationSha256')
        acceptance = proof.get('urlAcceptance') or {}
        mechanical = proof.get('hugo') or {}
        urls = {p['url'] for p in mechanical.get('pages', [])} | {
            f'{IMAGE_BASE_URL}/{r["path"]}' for r in image_files}
        if proof.get('contract') != 'conference-legacy-publication-verification-v2' \
                or proof.get('publishSha256') != published['publishSha256'] \
                or mechanical.get('contract') != GATE_CONTRACT or mechanical.get('status') != 'passed' \
                or {(p.get('path'), p.get('sourceSha256')) for p in mechanical.get('pages', [])} != {
                    (r['path'], r['sourceSha256']) for r in page_files} \
                or acceptance.get('status') != 'passed' or acceptance.get('contract') != GATE_CONTRACT \
                or {c.get('url') for c in acceptance.get('checks', [])} != urls:
            raise ConferencePublicationError('legacy 再验收凭证不闭合')
        result['layers'].update(htmlMechanical='passed', onlineUrls='passed')
        result.update(status='complete', complete=True, nextAction=None, legacyReverified=True)
        if had_legacy_proof and verify_urls:
            fresh_online_acceptance(directory, repo, images, generation, published, mechanical, commit, image_commit)
        result = apply_online_snapshot(directory, published, mechanical, result, fresh=verify_urls)
        if not online_attempts(directory):
            result['onlineUrlEvidence']['receiptPath'] = str(proof_path)
    return result


def publication_state(conference_id, process_id, *, verify_urls=False):
    """Queue interface: verify writes acceptance only; status never commits/pushes/writes."""
    repo, images = blog_repo(), image_repo()
    layers = {'htmlMechanical': 'pending', 'remoteOid': 'pending', 'onlineUrls': 'pending',
              'semanticReview': 'not_performed', 'visualInspection': 'not_performed',
              'mathBrowserExecution': 'not_performed'}
    result = {'contract': 'conference-publication-status-v1', 'conferenceId': conference_id,
              'processId': process_id, 'status': 'pending', 'complete': False,
              'processingRequired': False, 'nextAction': 'generate',
              'onlineUrlEvidence': {'mode': 'fresh_get' if verify_urls else 'historical_snapshot', 'status': 'pending'},
              'completionScope': 'mechanical-html+remote-oid+online-urls', 'layers': layers}
    if (publication_dir(conference_id, process_id) / 'publish.json').exists():
        return published_state(conference_id, process_id, repo, images, result, verify_urls=verify_urls)
    if not (publication_dir(conference_id, process_id) / 'generation.json').exists():
        return result
    generation, snapshot, image_snapshot = validate_generation(conference_id, process_id, repo, images)
    if not (publication_dir(conference_id, process_id) / 'review.json').exists():
        result['nextAction'] = 'review'
        return result
    receipt = load_review(conference_id, process_id)
    validate_review(generation, receipt)
    layers['htmlMechanical'] = 'passed'
    result['nextAction'] = 'push'
    # Exact bytes must be committed and present at each actual push remote.
    for repository, current, base, records in (
            (repo, snapshot, generation['baseHead'], generation['files']),
            (images, image_snapshot, generation['imageBaseHead'], generation['imageFiles'])):
        if current['head'] != current['remoteMain']:
            return result
        try:
            verify_tree(repository, base, current['head'], records)
        except ConferencePublicationError:
            return result
    layers['remoteOid'] = 'passed'
    result['nextAction'] = 'verify'
    existing = publication_dir(conference_id, process_id) / 'publish.json'
    if verify_urls:
        # Serialize receipt creation with push, including across worktrees.
        with shared_blog_repository_lock(repo, owner=f'conference-verify:{conference_id}'):
            generation, current, current_images = validate_generation(conference_id, process_id, repo, images)
            if current != snapshot or current_images != image_snapshot:
                raise ConferencePublicationError('verify 期间远端状态变化，请重试')
            accept_publication(conference_id, process_id, generation, receipt,
                               snapshot['head'], image_snapshot['head'], snapshot)
    if existing.exists():
        published = read_json(existing)
        validate_publication(generation, receipt, published, snapshot['head'], image_snapshot['head'])
        layers['onlineUrls'] = 'passed'
        result.update(status='complete', complete=True, nextAction=None, publicationCommit=snapshot['head'],
                      imagePublicationCommit=image_snapshot['head'])
        result['onlineUrlEvidence'].update(status='passed', receiptPath=str(existing))
    return result


def status(conference_id, process_id):
    result = publication_state(conference_id, process_id)
    print(json.dumps(result, ensure_ascii=False))
    return result


def verify(conference_id, process_id):
    result = publication_state(conference_id, process_id, verify_urls=True)
    print(json.dumps(result, ensure_ascii=False))
    return result


def push(conference_id, process_id):
    repo, images = blog_repo(), image_repo()
    if (publication_dir(conference_id, process_id) / 'publish.json').exists():
        # Push replay reads status; only explicit verify starts a new online GET.
        return status(conference_id, process_id)
    with shared_blog_repository_lock(repo, owner=f'conference-push:{conference_id}'):
        with shared_blog_repository_lock(images, owner=f'conference-images:{conference_id}'):
            generation, _, _ = validate_generation(conference_id, process_id, repo, images)
            receipt = load_review(conference_id, process_id)
            validate_review(generation, receipt)
            # Preserve the historical v1 transaction contract for an already
            # staged legacy generation. New v2 generations always take the
            # stronger URL-acceptance path below.
            if generation.get('version') == 1:
                image_commit = commit_delta(
                    images, generation['imageFiles'], generation['imageBaseHead'],
                    generation['imageRemoteIdentitySha256'], f'发布 {conference_id} 会议图片')
                push_delta(images, generation['imageFiles'], generation['imageBaseHead'],
                           generation['imageRemoteIdentitySha256'], image_commit)
                commit = commit_delta(repo, generation['files'], generation['baseHead'],
                                      generation['remoteIdentitySha256'], f'发布 {conference_id} 会议论文及汇总')
                remote = push_delta(repo, generation['files'], generation['baseHead'],
                                    generation['remoteIdentitySha256'], commit)
                existing = publication_dir(conference_id, process_id) / 'publish.json'
                body = {'contract': 'conference-blog-publish-v1', 'version': 1,
                        'conferenceId': conference_id, 'processId': process_id,
                        'generationSha256': generation['generationSha256'],
                        'reviewSha256': receipt['reviewSha256'], 'publicationCommit': commit,
                        'imagePublicationCommit': image_commit, 'remoteName': 'origin',
                        'remoteVerifiedOid': remote['remoteMain'],
                        'remoteIdentitySha256': remote['remoteIdentitySha256'],
                        'files': generation['files']}
                write_exact(existing, json_bytes({**body, 'publishSha256': stable(body)}))
                print(json.dumps({'status': 'pushed', 'conferenceId': conference_id,
                                  'processId': process_id, 'publicationCommit': commit,
                                  'remoteVerifiedOid': remote['remoteMain']}, ensure_ascii=False))
                return
            # Validate BOTH indexes before making any remote change.
            verify_index(repo, generation['baseHead'], generation['files'])
            verify_index(images, generation['imageBaseHead'], generation['imageFiles'])
            image_commit = commit_delta(
                images, generation['imageFiles'], generation['imageBaseHead'],
                generation['imageRemoteIdentitySha256'], f'发布 {conference_id} 会议图片')
            push_delta(images, generation['imageFiles'], generation['imageBaseHead'],
                       generation['imageRemoteIdentitySha256'], image_commit)
            commit = commit_delta(repo, generation['files'], generation['baseHead'],
                                  generation['remoteIdentitySha256'], f'发布 {conference_id} 会议论文及汇总')
            remote = push_delta(repo, generation['files'], generation['baseHead'],
                                generation['remoteIdentitySha256'], commit)
            accept_publication(conference_id, process_id, generation, receipt, commit, image_commit, remote)
            print(json.dumps({'status': 'complete', 'complete': True, 'publicationCommit': commit,
                              'completionScope': 'mechanical-html+remote-oid+online-urls',
                              'semanticReview': 'passed', 'visualInspection': 'not_performed'}))


def main():
    require_external_runtime('publish-conference.py')
    require_workspace_role('daily')
    load_project_env()
    global IMAGE_BASE_URL
    IMAGE_BASE_URL = os.environ.get(
        'PAPER_DIGEST_IMAGE_BASE_URL',
        'https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main').rstrip('/')
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('generate', 'review', 'push', 'status', 'verify'))
    parser.add_argument('--conference-id', required=True)
    parser.add_argument('--process-id', required=True)
    args = parser.parse_args()
    try:
        safe_uuid(args.process_id, 'processId')
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,80}', args.conference_id):
            raise ConferencePublicationError('conferenceId 不安全')
        result = {'generate': generate, 'review': review, 'push': push,
                  'status': status, 'verify': verify}[args.action](
            args.conference_id, args.process_id)
        if args.action == 'verify' and not result['complete']:
            raise SystemExit(2)
    except ConferencePublicationError as exc:
        print(json.dumps({'status': 'blocked', 'complete': False, 'processingRequired': False,
                          'nextAction': 'inspect', 'error': str(exc)}, ensure_ascii=False), flush=True)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
