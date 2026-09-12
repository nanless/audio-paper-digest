#!/usr/bin/env python3
"""Publish one completed conference process as an isolated blog delta."""

from project_env import load_project_env

load_project_env()

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from blog_repository_lock import shared_blog_repository_lock
from project_env import VCS_CHILD_ENV_KEYS, build_child_process_env
from runtime_guard import require_external_runtime


require_external_runtime('publish-conference.py')

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


CONFERENCE_IMAGE_RE = re.compile(r'!\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)')
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
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    try:
        fd = os.open(filename, flags, mode)
        try:
            os.write(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
    except FileExistsError:
        if read_bytes(filename) != data:
            raise ConferencePublicationError(f'并发写入产生不同字节: {filename}')
        return False
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


def git(repo, *args, check=True):
    env = build_child_process_env(allowed_keys=VCS_CHILD_ENV_KEYS)
    result = subprocess.run(['git', '-C', str(repo), *args], cwd=ROOT, env=env,
                            capture_output=True, text=True, check=False)
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise ConferencePublicationError(f'Git 命令失败: git {" ".join(args)}: {detail}')
    return result


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
    remote_url = git(repo, 'remote', 'get-url', '--push', 'origin').stdout.strip()
    remote = git(repo, 'ls-remote', 'origin', 'refs/heads/main').stdout.strip().split()
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


def publish_image_delta(repo, records, conference_id):
    """Commit the conference PNGs to the dedicated image GitHub Pages repo."""
    if not records:
        snapshot = remote_snapshot(repo)
        return {'commit': snapshot['head'], 'snapshot': snapshot}
    paths = sorted(record['path'] for record in records)
    expected_by_path = {record['path']: record['sourceSha256'] for record in records}
    snapshot = remote_snapshot(repo)
    remote_delta = git(repo, 'diff', '--name-only',
                       f'{snapshot["remoteMain"]}..HEAD').stdout.splitlines()
    if remote_delta and sorted(remote_delta) != paths:
        raise ConferencePublicationError(
            f'图片仓库已有非本会议本地提交，拒绝混入: {remote_delta}'
        )
    cached = git(repo, 'diff', '--cached', '--name-only').stdout.splitlines()
    if cached and sorted(cached) != paths:
        raise ConferencePublicationError(f'图片仓库已有非会议 staged 文件，拒绝混入: {cached}')
    for record in records:
        target = under(repo, record['path'], '图片仓库目标')
        if not target.exists():
            raise ConferencePublicationError(f'图片仓库图片未写入: {record["path"]}')
        if sha_bytes(read_bytes(target)) != record['sourceSha256']:
            raise ConferencePublicationError(f'图片仓库图片字节校验失败: {record["path"]}')
    commit = None
    current_head = git(repo, 'rev-parse', 'HEAD').stdout.strip().lower()
    if sorted(remote_delta) == paths:
        commit = current_head
    elif not cached:
        git(repo, 'add', '--', *paths)
        cached = git(repo, 'diff', '--cached', '--name-only').stdout.splitlines()
        if sorted(cached) != paths:
            raise ConferencePublicationError(f'图片仓库 staged 目标不完整: {cached}')
    if commit is None:
        for record in records:
            staged_sha = sha_bytes(read_bytes(under(repo, record['path'], '图片仓库 staged 目标')))
            if staged_sha != expected_by_path[record['path']]:
                raise ConferencePublicationError(f'图片仓库 staged 图片 SHA 不一致: {record["path"]}')
        staged = git(repo, 'diff', '--cached', '--name-only').stdout.splitlines()
        if not staged:
            commit = current_head
        else:
            git(repo, 'commit', '-m', f'发布 {conference_id} 会议论文图片')
            commit = git(repo, 'rev-parse', 'HEAD').stdout.strip().lower()
            changed = git(repo, 'diff', '--name-only', f'{commit}^', commit).stdout.splitlines()
            if sorted(changed) != paths:
                raise ConferencePublicationError(f'图片仓库新 commit 包含非会议文件: {changed}')
    git(repo, 'push', 'origin', 'HEAD:main')
    after = remote_snapshot(repo)
    if after['head'] != commit or after['remoteMain'] != commit \
            or after['remoteIdentitySha256'] != snapshot['remoteIdentitySha256']:
        raise ConferencePublicationError('图片仓库推送后 OID 或 remote identity 校验失败')
    return {'commit': commit, 'snapshot': after}


def generate(conference_id, process_id):
    repo = blog_repo()
    with shared_blog_repository_lock(repo, owner=f'conference-generate:{conference_id}'):
        bundle = process_bundle(conference_id, process_id)
        snapshot = remote_snapshot(repo)
        images = image_repo()
        files = sorted(bundle['files'], key=lambda item: item['path'])
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
        image_files = sorted(bundle['imageFiles'], key=lambda item: item['path'])
        for record in image_files:
            target = under(images, record['path'], '图片仓库目标')
            data = read_bytes(record['sourcePath'])
            if sha_bytes(data) != record['sourceSha256']:
                raise ConferencePublicationError(f'图片 staging 字节在生成期间漂移: {record["path"]}')
            write_exact(target, data, mode=0o644)
        image_publication = publish_image_delta(images, image_files, conference_id)
        image_snapshot = image_publication['snapshot']
        body = {'contract': 'conference-blog-generation-v1', 'version': 1,
                'conferenceId': conference_id, 'processId': process_id,
                'completionReceiptSha256': bundle['completion']['receiptSha256'],
                'baseHead': snapshot['head'], 'remoteMainBefore': snapshot['remoteMain'],
                'remoteName': snapshot['remoteName'],
                'remoteIdentitySha256': snapshot['remoteIdentitySha256'],
                'files': files, 'imageFiles': image_files,
                'imagePublicationCommit': image_publication['commit'],
                'imageBaseHead': image_snapshot['head'],
                'imageRemoteMainBefore': image_snapshot['remoteMain'],
                'imageRemoteIdentitySha256': image_snapshot['remoteIdentitySha256']}
        generation = {**body, 'generationSha256': stable(body)}
        rewrite_unpublished_receipt(
            publication_dir(conference_id, process_id) / 'generation.json',
            json_bytes(generation), 'generation receipt',
            lambda previous: previous.get('contract') == body['contract']
            and previous.get('version') == body['version']
            and previous.get('conferenceId') == conference_id
            and previous.get('processId') == process_id
            and previous.get('completionReceiptSha256') == body['completionReceiptSha256']
        )
        print(json.dumps({'status': 'generated', 'conferenceId': conference_id,
                          'processId': process_id, 'files': len(files),
                          'generationSha256': generation['generationSha256']}, ensure_ascii=False))


def validate_generation(conference_id, process_id, repo, images):
    generation = load_generation(conference_id, process_id)
    body = dict(generation)
    declared = body.pop('generationSha256', None)
    if generation.get('contract') != 'conference-blog-generation-v1' \
            or declared != stable(body) or generation.get('conferenceId') != conference_id \
            or generation.get('processId') != process_id:
        raise ConferencePublicationError('generation receipt 无效')
    snapshot = remote_snapshot(repo)
    if snapshot['head'] != generation['baseHead'] \
            or snapshot['remoteMain'] != generation['remoteMainBefore'] \
            or snapshot['remoteIdentitySha256'] != generation['remoteIdentitySha256']:
        raise ConferencePublicationError('博客 HEAD 或远端 main 在会议发布期间发生漂移')
    for record in generation.get('files', []):
        data = target_bytes(repo, record)
        if sha_bytes(data) != record['sourceSha256']:
            raise ConferencePublicationError(f'博客目标字节与 generation 不一致: {record["path"]}')
    image_snapshot = remote_snapshot(images)
    if image_snapshot['head'] != generation.get('imageBaseHead') \
            or image_snapshot['remoteMain'] != generation.get('imageRemoteMainBefore') \
            or image_snapshot['remoteIdentitySha256'] != generation.get('imageRemoteIdentitySha256') \
            or image_snapshot['head'] != generation.get('imagePublicationCommit'):
        raise ConferencePublicationError('图片仓库 HEAD 或远端 main 在会议发布期间发生漂移')
    image_files = generation.get('imageFiles')
    if not isinstance(image_files, list):
        raise ConferencePublicationError('generation 缺少图片仓库文件清单')
    for record in image_files:
        data = target_bytes(images, record)
        if sha_bytes(data) != record['sourceSha256']:
            raise ConferencePublicationError(f'图片仓库目标字节与 generation 不一致: {record["path"]}')
    return generation, snapshot, image_snapshot


def run_hugo(repo):
    hugo = shutil.which('hugo')
    if not hugo:
        raise ConferencePublicationError('review 需要 Hugo，但 PATH 中没有 hugo')
    temp_root = Path(tempfile.mkdtemp(prefix='conference-hugo-', dir='/private/tmp'))
    try:
        env = build_child_process_env(allowed_keys=VCS_CHILD_ENV_KEYS)
        result = subprocess.run([hugo, '--source', str(repo), '--destination', str(temp_root), '--quiet'],
                                cwd=ROOT, env=env, capture_output=True, text=True,
                                timeout=300, check=False)
        if result.returncode != 0:
            raise ConferencePublicationError(f'Hugo gate 失败: {(result.stderr or result.stdout).strip()[-2000:]}')
        return {'status': 'passed', 'version': subprocess.run([hugo, 'version'], capture_output=True,
                                                               text=True, check=False).stdout.strip()[:300]}
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


def review(conference_id, process_id):
    repo = blog_repo()
    with shared_blog_repository_lock(repo, owner=f'conference-review:{conference_id}'):
        generation, snapshot, image_snapshot = validate_generation(
            conference_id, process_id, repo, image_repo())
        if (publication_dir(conference_id, process_id) / 'review.json').exists():
            review_receipt = load_review(conference_id, process_id)
            if review_receipt.get('generationSha256') == generation['generationSha256'] \
                    and review_receipt.get('baseHead') == snapshot['head'] \
                    and review_receipt.get('files') == generation['files'] \
                    and review_receipt.get('imageFiles') == generation['imageFiles'] \
                    and review_receipt.get('imagePublicationCommit') == generation['imagePublicationCommit']:
                print(json.dumps({'status': 'already-reviewed', 'conferenceId': conference_id,
                                  'reviewSha256': review_receipt['reviewSha256']}, ensure_ascii=False))
                return
        hugo = run_hugo(repo)
        body = {'contract': 'conference-blog-review-v1', 'version': 1,
                'conferenceId': conference_id, 'processId': process_id,
                'generationSha256': generation['generationSha256'],
                'baseHead': snapshot['head'], 'remoteMainBefore': snapshot['remoteMain'],
                'files': generation['files'], 'imageFiles': generation['imageFiles'],
                'imagePublicationCommit': generation['imagePublicationCommit'],
                'imageBaseHead': image_snapshot['head'],
                'imageRemoteMainBefore': image_snapshot['remoteMain'],
                'hugo': hugo}
        review_receipt = {**body, 'reviewSha256': stable(body)}
        rewrite_unpublished_receipt(
            publication_dir(conference_id, process_id) / 'review.json',
            json_bytes(review_receipt), 'review receipt',
            lambda previous: previous.get('contract') == body['contract']
            and previous.get('version') == body['version']
            and previous.get('conferenceId') == conference_id
            and previous.get('processId') == process_id
        )
        print(json.dumps({'status': 'reviewed', 'conferenceId': conference_id,
                          'processId': process_id, 'reviewSha256': review_receipt['reviewSha256']}, ensure_ascii=False))


def push(conference_id, process_id):
    repo = blog_repo()
    with shared_blog_repository_lock(repo, owner=f'conference-push:{conference_id}'):
        generation, snapshot, image_snapshot = validate_generation(
            conference_id, process_id, repo, image_repo())
        review_receipt = load_review(conference_id, process_id)
        review_body = dict(review_receipt)
        review_sha = review_body.pop('reviewSha256', None)
        if review_receipt.get('contract') != 'conference-blog-review-v1' \
                or review_sha != stable(review_body) \
                or review_receipt.get('generationSha256') != generation['generationSha256'] \
                or review_receipt.get('baseHead') != snapshot['head'] \
                or review_receipt.get('files') != generation['files'] \
                or review_receipt.get('imageFiles') != generation['imageFiles'] \
                or review_receipt.get('imagePublicationCommit') != generation['imagePublicationCommit'] \
                or review_receipt.get('hugo', {}).get('status') != 'passed':
            raise ConferencePublicationError('review receipt 无效或与当前 generation 不一致')
        existing_publish = publication_dir(conference_id, process_id) / 'publish.json'
        if existing_publish.exists():
            receipt = read_json(existing_publish)
            remote = remote_snapshot(repo)
            if receipt.get('remoteVerifiedOid') == remote['remoteMain'] \
                    and remote['head'] == receipt.get('publicationCommit'):
                print(json.dumps({'status': 'already-pushed', 'conferenceId': conference_id,
                                  'publicationCommit': receipt['publicationCommit']}, ensure_ascii=False))
                return
        paths = sorted(record['path'] for record in generation['files'])
        cached = git(repo, 'diff', '--cached', '--name-only').stdout.splitlines()
        if cached and sorted(cached) != paths:
            raise ConferencePublicationError(f'push 前发现已有非会议 staged 文件，拒绝混入: {cached}')
        if cached:
            expected_by_path = {record['path']: record['sourceSha256']
                                for record in generation['files']}
            cached_mismatched = []
            for path in cached:
                try:
                    actual_sha = sha_bytes(target_bytes(repo, {'path': path}))
                except ConferencePublicationError:
                    actual_sha = None
                if actual_sha != expected_by_path.get(path):
                    cached_mismatched.append(path)
            if cached_mismatched:
                raise ConferencePublicationError(
                    f'已有 staged 会议文件与本次 generation SHA 不一致: {cached_mismatched}')
        dirty_targets = git(repo, 'diff', '--name-only', '--', *paths).stdout.splitlines()
        if dirty_targets:
            expected_by_path = {record['path']: record['sourceSha256']
                                for record in generation['files']}
            mismatched = []
            for path in dirty_targets:
                target = repo / path
                try:
                    actual_sha = sha_bytes(read_bytes(target))
                except ConferencePublicationError:
                    actual_sha = None
                if actual_sha != expected_by_path.get(path):
                    mismatched.append(path)
            if mismatched:
                raise ConferencePublicationError(
                    f'会议目标文件存在非本次 generation 的未提交修改，拒绝混入: {mismatched}')
        current_head = git(repo, 'rev-parse', 'HEAD').stdout.strip().lower()
        remote_delta = git(repo, 'diff', '--name-only',
                           f'{snapshot["remoteMain"]}..HEAD').stdout.splitlines()
        commit = None
        if sorted(remote_delta) == paths:
            # A previous attempt may have committed the exact conference delta
            # before a remote fast-forward was discovered. After merging that
            # remote commit, HEAD is already the safe publish candidate.
            commit = current_head
        elif not cached:
            git(repo, 'add', '--', *paths)
            staged = git(repo, 'diff', '--cached', '--name-only').stdout.splitlines()
            if sorted(staged) != paths:
                raise ConferencePublicationError(f'staged delta 不是该会议精确目标集合: {staged}')
        for record in generation['files']:
            staged_sha = sha_bytes(target_bytes(repo, record))
            if staged_sha != record['sourceSha256']:
                raise ConferencePublicationError(f'staged 文件字节校验失败: {record["path"]}')
        if commit != current_head or sorted(remote_delta) != paths:
            paper_count = sum(1 for record in generation['files'] if record.get('kind') == 'paper')
            asset_count = len(generation['imageFiles'])
            message = f'发布 {conference_id} 会议论文解读（{paper_count}篇及汇总，{asset_count}张图）'
            git(repo, 'commit', '-m', message)
            commit = git(repo, 'rev-parse', 'HEAD').stdout.strip().lower()
            changed = git(repo, 'diff', '--name-only', f'{commit}^', commit).stdout.splitlines()
            if sorted(changed) != paths:
                raise ConferencePublicationError(f'新 commit 包含非会议目标文件: {changed}')
        git(repo, 'push', 'origin', 'HEAD:main')
        remote = remote_snapshot(repo)
        if remote['head'] != commit or remote['remoteMain'] != commit \
                or remote['remoteIdentitySha256'] != snapshot['remoteIdentitySha256']:
            raise ConferencePublicationError('推送后远端 main OID 或 remote identity 校验失败')
        body = {'contract': 'conference-blog-publish-v1', 'version': 1,
                'conferenceId': conference_id, 'processId': process_id,
                'generationSha256': generation['generationSha256'],
                'reviewSha256': review_receipt['reviewSha256'],
                'publicationCommit': commit, 'remoteName': 'origin',
                'remoteVerifiedOid': remote['remoteMain'],
                'remoteIdentitySha256': remote['remoteIdentitySha256'],
                'files': generation['files']}
        receipt = {**body, 'publishSha256': stable(body)}
        write_exact(existing_publish, json_bytes(receipt))
        print(json.dumps({'status': 'pushed', 'conferenceId': conference_id,
                          'processId': process_id, 'publicationCommit': commit,
                          'remoteVerifiedOid': remote['remoteMain']}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('generate', 'review', 'push'))
    parser.add_argument('--conference-id', required=True)
    parser.add_argument('--process-id', required=True)
    args = parser.parse_args()
    try:
        {'generate': generate, 'review': review, 'push': push}[args.action](
            args.conference_id, args.process_id)
    except ConferencePublicationError as exc:
        print(f'[publish-conference] {exc}', flush=True)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
