#!/usr/bin/env python3
"""根据历史博客元数据生成私有标签预览，不改写论文页面。

同时输出旧标签的七种处理方式，保留原标签和状态列。
"""

import argparse
import collections
import csv
import hashlib
import io
import json
import os
import re
import stat
import subprocess
from datetime import date, datetime
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit, urlunsplit

import path_config
import tag_paths
from markdown_hugo_gate import parse_frontmatter_content
from tag_catalog import (FACET_IDS, LABEL_MODE_LEGACY, ancestors,
                            load_tag_catalog, normalize_label, prune_ancestors,
                            resolve_label)
from project_env import build_child_process_env, load_project_env
from runtime_guard import require_external_runtime

VERSION = 'paper-tag-preview-v2'
REPORT_VERSION = 'paper-tag-migration-report-v2'
BUNDLE_VERSION = 'paper-tag-preview-bundle-v2'
MAX_PAGE_BYTES = 8 * 1024 * 1024
ARXIV_ID = re.compile(r'\d{4}\.\d{4,5}(?:v[1-9]\d*)?')

# 旧标签的七种处理方式见 docs/tag-system-design.md 5.3。每个旧标签最终须选择一种方式；
# 尚未选择时 disposition 留空，并保留原标签。
DISPOSITION_SCHEMA = 'paper-tag-seven-state-disposition-v2'
DISPOSITIONS = ('keep', 'alias', 'broader', 'split_review', 'move_facet',
                'deprecated', 'out_of_scope')
# 保留旧 CSV 列及含义，只追加新列，方便已有读取程序继续使用。
LEGACY_CSV_COLUMNS = ('tag', 'pageCount', 'status', 'conceptId', 'facet', 'semanticReview')
DISPOSITION_CSV_COLUMNS = ('tag', 'pageCount', 'disposition', 'status', 'conceptId',
                           'facet', 'semanticReview', 'evidence')
# 只匹配至少三个字符的中文首选名称，减少较短泛词造成的误匹配。
MIN_CONTAINED_LABEL_CHARS = 3
PENDING_RULE = '尚未选择处理方式的标签保留原值，等待评审。采用 deprecated 或 out_of_scope 前，须提供跨会议扫描未命中的证据并经人工评审，不能仅依据某一个会议的出现频次作判断。'


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def stable_hash(value):
    return sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))


def parse_evidence(value, where):
    """evidence 在内存里必须是 JSON 对象；CSV 里是它的紧凑 JSON 字符串。"""
    if value is None or value == '':
        return {}
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except ValueError as error:
            raise ValueError(f'{where}: evidence 必须是 JSON 对象，当前内容无法解析：{error}') from error
        if isinstance(parsed, dict):
            return parsed
    raise ValueError(f'{where}: evidence 必须是 JSON 对象。')


def find_contained_tag_concepts(tag_catalog, tag):
    """找出原标签中包含的已启用概念中文首选名称。

    只比较规范化后的文字，不判断概念的上下级关系，也不进行语义推断；
    结果供后续处理和人工复核使用。
    """
    normalized = normalize_label(tag)
    if not normalized:
        return []
    contained_concepts_by_id = {}
    for concept in tag_catalog['concepts']:
        if concept['status'] != 'active':
            continue
        label = normalize_label(concept['preferredLabel']['zh'])
        if len(label) >= MIN_CONTAINED_LABEL_CHARS and label != normalized and label in normalized:
            contained_concepts_by_id.setdefault(concept['id'], {'conceptId': concept['id'],
                                             'label': concept['preferredLabel']['zh']})
    return [contained_concepts_by_id[cid] for cid in sorted(contained_concepts_by_id)]


def initial_disposition(tag, concept, tag_catalog):
    """根据词表中的名称和别名初步选择处理方式，不进行语义评审。

    返回 (disposition, evidence)，semanticReview 保持 not_performed。
    disposition 为空表示尚未选择处理方式，evidence.reason 须说明原因。
    """
    if concept is not None:
        if concept['status'] != 'active':
            return '', {'reason': '字面匹配到了已弃用概念；须经跨会议扫描和人工评审，确认没有命中后再决定是否弃用。'}
        normalized = normalize_label(tag)
        if normalized == normalize_label(concept['preferredLabel']['zh']):
            return 'keep', {'matchKind': 'zh_preferred_label'}
        if normalized == normalize_label(concept['preferredLabel']['en']):
            return 'alias', {'matchKind': 'en_preferred_label'}
        return 'alias', {'matchKind': 'alias'}
    candidates = find_contained_tag_concepts(tag_catalog, tag)
    if len(candidates) == 1:
        return 'broader', {'matchKind': 'upper_label_containment',
                           'upperConceptId': candidates[0]['conceptId'],
                           'upperLabel': candidates[0]['label']}
    if candidates:
        return '', {'reason': '原标签同时包含多个候选标签，需要人工判断是否拆分；确认后可采用 split_review。',
                    'candidates': candidates}
    return '', {'reason': '词表中没有与该标签对应的名称或别名，需要进一步进行语义判断或人工评审。'}


def build_dispositions(tag_page_counts, concepts_by_tag, tag_catalog):
    rows = [
        {'tag': tag, 'pageCount': count, 'disposition': None,
         'status': 'mapped' if concepts_by_tag[tag] else 'needs_review',
         'conceptId': concepts_by_tag[tag]['id'] if concepts_by_tag[tag] else '',
         'facet': concepts_by_tag[tag]['facet'] if concepts_by_tag[tag] else '',
         'semanticReview': 'not_performed', 'evidence': None}
        for tag, count in sorted(tag_page_counts.items(), key=lambda item: (-item[1], item[0]))
    ]
    for row in rows:
        disposition, evidence = initial_disposition(row['tag'], concepts_by_tag[row['tag']], tag_catalog)
        row['disposition'], row['evidence'] = disposition, evidence
    return validate_disposition_rows(rows)


def validate_disposition_rows(rows):
    """核对标签处理方式及所需证据；没有 disposition 和 evidence 列的旧记录按原规则兼容读取。"""
    if not isinstance(rows, list):
        raise ValueError('标签处理记录必须是数组。')
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('tag'), str) or not row['tag']:
            raise ValueError('标签处理记录必须是对象，并在 tag 中填写非空标签。')
        tag = row['tag']
        if tag in seen:
            raise ValueError(f'{tag}: 标签处理表中存在重复的标签。')
        seen.add(tag)
        status = row.get('status')
        if status not in ('mapped', 'needs_review'):
            raise ValueError(f'{tag}: 处理记录的 status 必须为 mapped 或 needs_review。')
        # 旧记录没有 disposition 和 evidence 字段时，按原规则兼容读取，不检查处理方式。
        if 'disposition' not in row and 'evidence' not in row:
            continue
        disposition = row.get('disposition') or ''
        if disposition not in ('', *DISPOSITIONS):
            raise ValueError(f'{tag}: disposition 的值 {disposition!r} 不在允许的七种处理方式中：{DISPOSITIONS}')
        evidence = parse_evidence(row.get('evidence'), tag)
        if not disposition:
            reason = evidence.get('reason')
            if not isinstance(reason, str) or not reason.strip():
                raise ValueError(f'{tag}: 尚未选择处理方式时，必须在 evidence.reason 中写明原因。')
            continue
        if disposition in ('keep', 'alias'):
            if status != 'mapped':
                raise ValueError(f'{tag}: 采用 {disposition} 处理方式时，status 必须为 mapped。')
            if not isinstance(row.get('conceptId'), str) or not row.get('conceptId'):
                raise ValueError(f'{tag}: 采用 {disposition} 处理方式时，必须填写非空的 conceptId。')
        elif disposition == 'broader':
            if status != 'needs_review' or not isinstance(evidence.get('upperConceptId'), str) \
                    or not evidence['upperConceptId']:
                raise ValueError(f'{tag}: broader 处理方式要求 status 为 needs_review，并在 evidence.upperConceptId 中填写上级概念 ID。')
        elif disposition == 'split_review':
            if status != 'needs_review':
                raise ValueError(f'{tag}: 采用 split_review 处理方式时，status 必须为 needs_review。')
            candidates = evidence.get('candidates')
            if not isinstance(candidates, list) or not candidates \
                    or any(not isinstance(item, str) or not item.strip() for item in candidates):
                raise ValueError(f'{tag}: 采用 split_review 处理方式时，evidence.candidates 必须是非空数组，且每个候选词都是非空字符串。')
        elif disposition == 'move_facet':
            if status != 'mapped':
                raise ValueError(f'{tag}: 采用 move_facet 处理方式时，status 必须为 mapped。')
            target = evidence.get('facet')
            if target not in FACET_IDS:
                raise ValueError(f'{tag}: 采用 move_facet 处理方式时，evidence.facet 必须属于九个分类维度之一。')
            if row.get('facet') and target == row['facet']:
                raise ValueError(f'{tag}: 采用 move_facet 处理方式时，目标分类维度必须与当前维度不同。')
        else:  # 其余情况：deprecated 或 out_of_scope
            zero = evidence.get('crossConferenceZeroHit')
            if not isinstance(zero, dict) or not isinstance(zero.get('scan'), str) or not zero['scan'].strip():
                raise ValueError(f'{tag}: 采用 {disposition} 处理方式时，必须提供跨会议扫描未命中的证据：'
                                 'evidence.crossConferenceZeroHit.scan；不能仅凭单个会议的出现频次作判断。')
            reviewer = evidence.get('reviewedBy')
            if not isinstance(reviewer, str) or not reviewer.strip():
                raise ValueError(f'{tag}: 采用 {disposition} 处理方式时，必须在 evidence.reviewedBy 中填写人工评审者。')
    return rows


def read_disposition_rows(text):
    """按新旧两种表头读取标签处理记录；旧六列记录不含 disposition 和 evidence 字段。"""
    rows = list(csv.DictReader(io.StringIO(text)))
    return validate_disposition_rows(rows)


def disposition_summary(dispositions):
    disposition_counts = {state: sum(row['disposition'] == state for row in dispositions)
              for state in DISPOSITIONS}
    return {'dispositionSchema': DISPOSITION_SCHEMA, 'dispositionCounts': disposition_counts,
            'pendingDispositions': sum(not row['disposition'] for row in dispositions),
            'disposedDispositions': sum(bool(row['disposition']) for row in dispositions),
            'dispositionRule': PENDING_RULE}


def safe_directory(value, *, create=False):
    target = Path(os.path.abspath(Path(value).expanduser()))
    current = Path(target.anchor)
    for part in target.parts[1:]:
        current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            if not create:
                raise
            current.mkdir(mode=0o700, exist_ok=True)
            info = current.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise ValueError('标签预览路径中存在符号链接，或某一层不是目录。')
    return target


def read_regular(path, limit=MAX_PAGE_BYTES):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            raise ValueError('标签预览输入必须是普通文件，只有一个硬链接，且大小不能超过限制。')
        with os.fdopen(fd, 'rb', closefd=False) as handle:
            raw = handle.read(limit + 1)
        if len(raw) > limit:
            raise ValueError('标签预览输入文件超过大小限制。')
        return raw
    finally:
        os.close(fd)


def git_snapshot(repo):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(repo), *args],
                                       env=build_child_process_env(), text=True, timeout=30).strip()
    if Path(git('rev-parse', '--show-toplevel')).resolve() != repo:
        raise ValueError('博客输入路径必须是 Git 仓库根目录。')
    head = git('rev-parse', 'HEAD')
    if not re.fullmatch(r'[a-f0-9]{40,64}', head) or git('status', '--porcelain=v1', '--untracked-files=all'):
        raise ValueError('博客输入必须是已提交的干净 Git 工作区。')
    return head


def markdown_paths(repo):
    root = safe_directory(repo / 'content' / 'posts')
    found = []
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in [*dirs, *files]:
            path = Path(directory) / name
            if path.is_symlink():
                raise ValueError('博客内容目录中不得包含符号链接。')
        found.extend(Path(directory) / name for name in files if name.lower().endswith('.md'))
    return sorted(found, key=lambda path: path.relative_to(repo).as_posix())


def normalized_date(value):
    if isinstance(value, (date, datetime)):
        return value.isoformat()[:10], value.isoformat()
    if not isinstance(value, str) or not re.match(r'^\d{4}-\d{2}-\d{2}(?:$|[T ])', value):
        raise ValueError('论文日期必须是有效的 ISO 日期。')
    if len(value) == 10:
        date.fromisoformat(value)
    else:
        datetime.fromisoformat(value.replace('Z', '+00:00'))
    return value[:10], value


def blog_base_url(repo):
    config = repo / 'hugo.yaml'
    raw = read_regular(config).decode('utf-8')
    values, _ = parse_frontmatter_content(config, '---\n' + raw + '\n---\n')
    if values.get('permalinks') or values.get('uglyURLs'):
        raise ValueError('配置了自定义 Hugo 永久链接或 uglyURLs，预览程序需要明确的 URL 生成规则。')
    base = values.get('baseURL')
    if not isinstance(base, str):
        raise ValueError('Hugo 配置必须填写 baseURL。')
    parsed = urlsplit(base)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.port not in (None, 443) or parsed.query or parsed.fragment
            or re.search(r'[\x00-\x20\x7f\\]', base)):
        raise ValueError('Hugo 的 baseURL 必须是安全的 HTTPS 地址。')
    return base.rstrip('/') + '/'


def page_url(repo, path, frontmatter, base):
    root = urlsplit(base)
    raw = frontmatter.get('url')
    if raw is None:
        slug = frontmatter.get('slug', path.stem)
        if not isinstance(slug, str) or not slug or slug != slug.strip() or re.search(r'[\x00-\x1f\x7f/\\?#]', slug):
            raise ValueError('页面的 slug 无效，或包含不允许的路径字符。')
        relative = path.parent.relative_to(repo / 'content' / 'posts').as_posix()
        parts = ([] if relative == '.' else relative.split('/')) + [slug]
        raw = root.path + 'posts/' + '/'.join(quote(part, safe='-._~') for part in parts) + '/'
    if not isinstance(raw, str) or not raw or re.search(r'[\x00-\x20\x7f\\]', raw) or raw.startswith('//'):
        raise ValueError('页面 URL 为空、格式无效，或包含不允许的字符。')
    parsed = urlsplit(raw)
    if parsed.scheme and (parsed.scheme != 'https' or parsed.netloc != root.netloc):
        raise ValueError('页面 URL 必须使用 HTTPS，并属于当前博客站点。')
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('页面 URL 不得包含用户凭据、查询参数或片段。')
    url_path = parsed.path if parsed.path.startswith('/') else root.path + parsed.path
    decoded = url_path
    for _ in range(4):
        next_value = unquote(decoded)
        if next_value == decoded:
            break
        decoded = next_value
    if (any(part in ('.', '..') for part in decoded.split('/'))
            or '\\' in decoded or re.search(r'[\x00-\x1f\x7f]', decoded)
            or not decoded.startswith(unquote(root.path))):
        raise ValueError('页面 URL 超出了博客的基础路径，或包含不允许的路径字符。')
    return urlunsplit((root.scheme, root.netloc, url_path, '', ''))


def paper_metadata(repo, path, raw, base):
    relative = path.relative_to(repo).as_posix()
    if '\\' in relative or any(part in ('.', '..') for part in Path(relative).parts):
        raise ValueError('来源文件的相对路径包含不允许的路径字符。')
    frontmatter, body = parse_frontmatter_content(path, raw.decode('utf-8'))
    kind = frontmatter.get('paper_digest_page_type')
    if (re.fullmatch(r'\d{4}-\d{2}-\d{2}', path.stem)
            or re.fullmatch(r'(?:icassp|iclr|icml)\d{4}-(?:task-.+|summary)', path.stem)
            or kind in ('summary', 'index', 'digest') or path.name == '_index.md'):
        return None, 'summary/index'
    if frontmatter.get('draft') is True:
        return None, 'draft'
    tags = frontmatter.get('tags', [])
    if not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
        raise ValueError(f'页面 {relative} 的标签必须是字符串数组。')
    title = frontmatter.get('title')
    if not isinstance(title, str) or not title.strip() or re.search(r'[\x00-\x1f\x7f]', title):
        raise ValueError(f'页面 {relative} 的论文标题必须是非空字符串，且不得包含控制字符。')
    public_date, sort_date = normalized_date(frontmatter.get('date'))
    identity_evidence = []
    for key in ('paper_digest_arxiv_id', 'arxiv_id', 'arxivId'):
        explicit = frontmatter.get(key)
        if explicit is None:
            continue
        if not isinstance(explicit, str) or not ARXIV_ID.fullmatch(explicit):
            raise ValueError(f'页面 {relative} 的 arXiv ID 格式无效，字段为 {key}。')
        identity_evidence.append((re.sub(r'v[1-9]\d*$', '', explicit), 'frontmatter'))
    filename = re.search(r'-(\d{4})-(\d{4,5})(?:v[1-9]\d*)?$', path.stem)
    if filename:
        identity_evidence.append(('.'.join(filename.groups()), 'filename'))
    # 正文仅用于读取显式标注的 arXiv 链接以补充论文 ID；
    # 正文内容不写入预览文件，也不参与标签分类。
    linked = set(re.findall(r'\[arxiv\]\(https://arxiv\.org/abs/(\d{4}\.\d{4,5})(?:v[1-9]\d*)?\)', body, re.I))
    identity_evidence.extend((value, 'explicit_arxiv_link') for value in sorted(linked))
    if len({value for value, _origin in identity_evidence}) > 1:
        raise ValueError(f'页面 {relative} 中记录的 arXiv ID 相互冲突。')
    arxiv_id, arxiv_id_source = identity_evidence[0] if identity_evidence else (None, None)
    primary_keys = ('paper_digest_primary_task', 'primaryTask', 'primary_task', 'primaryTaskTag', 'primary_task_tag')
    if any(key in frontmatter and frontmatter[key] is not None and not isinstance(frontmatter[key], str)
           for key in primary_keys):
        raise ValueError(f'页面 {relative} 的主任务字段必须是字符串或 null。')
    primary_values = [{'field': key, 'value': value} for key, value in frontmatter.items()
                      if key in primary_keys
                      and isinstance(value, str) and value.strip()]
    return {'id': arxiv_id, 'idSource': arxiv_id_source, 'title': title, 'date': public_date,
            'url': page_url(repo, path, frontmatter, base), 'tags': tags,
            'sourceSha256': sha256(raw), 'relativePath': relative,
            '_sortDate': sort_date, '_primaryValues': primary_values}, None


def classify_page(page, tag_catalog, concepts_by_tag):
    concepts_by_id = {concept['id']: concept for concept in tag_catalog['concepts']}
    mapped_concept_ids, unresolved_tags = [], []
    for tag in page['tags']:
        concept = concepts_by_tag[tag]
        if concept is None:
            if tag not in unresolved_tags:
                unresolved_tags.append(tag)
        elif concept['id'] not in mapped_concept_ids:
            mapped_concept_ids.append(concept['id'])
    primary_matches = [resolve_label(
        tag_catalog, value['value'], 'task', mode=LABEL_MODE_LEGACY)
        for value in page['_primaryValues']]
    primary_ids = {concept['id'] for concept in primary_matches if concept is not None}
    primary_task_id = next(iter(primary_ids)) if len(primary_ids) == 1 and all(primary_matches) else None
    primary_unresolved = [{**item, 'reason': 'conflicting_explicit_tasks' if len(primary_ids) > 1
                          else 'unknown_or_wrong_role'} for item, concept in zip(page['_primaryValues'], primary_matches)
                          if concept is None or len(primary_ids) > 1]
    if primary_task_id is not None and primary_task_id not in mapped_concept_ids:
        mapped_concept_ids.append(primary_task_id)
    facet_ids = {facet: [cid for cid in mapped_concept_ids if concepts_by_id[cid]['facet'] == facet] for facet in FACET_IDS}
    ancestor_ids = {facet: list(dict.fromkeys(parent for cid in values for parent in ancestors(tag_catalog, cid)))
                    for facet, values in facet_ids.items()}
    classified_page = {key: value for key, value in page.items() if not key.startswith('_')}
    classified_page.update({'recordId': f'arxiv:{page["id"]}' if page['id'] else 'page:' + sha256(page['relativePath'].encode()),
                   'mappedIds': mapped_concept_ids, 'displayIds': prune_ancestors(tag_catalog, mapped_concept_ids),
                   'facetIds': facet_ids, 'ancestorIds': ancestor_ids, 'unresolvedTags': unresolved_tags,
                   'primaryTaskId': primary_task_id, 'primaryTaskSource': page['_primaryValues'],
                   'primaryUnresolved': primary_unresolved, 'classificationStatus':
                       'unresolved' if not mapped_concept_ids else 'partial' if unresolved_tags or primary_unresolved else 'legacy_mapped'})
    return classified_page


def validate_output_root(value, repo):
    output = Path(os.path.abspath(Path(value).expanduser()))
    project = path_config.PROJECT_ROOT.resolve()
    forbidden = [repo, path_config.CURRENT_DIR.resolve(), path_config.FRESH_REWRITE_RUNS_DIR.resolve()]
    if (output == project or output in project.parents
            or any(output == root or root in output.parents or output in root.parents
                   for root in forbidden)):
        raise ValueError('标签预览输出目录与输入目录或受保护目录重叠。')
    if project in output.parents and project / 'data' / 'runtime' not in output.parents:
        raise ValueError('仓库内的标签预览输出必须保存在 data/runtime 下。')
    safe_directory(output, create=True)
    for name in ('index.json', 'migration-report.json', 'tag-disposition.csv', 'bundle-manifest.json'):
        target = output / name
        if target.exists() or target.is_symlink():
            read_regular(target, 64 * 1024 * 1024)
    if (output / 'index.json').exists():
        if json.loads(read_regular(output / 'index.json', 64 * 1024 * 1024))['version'] != VERSION:
            raise ValueError('已有索引的版本不符合标签预览协议，拒绝覆盖。')
    elif (output / 'tag-disposition.csv').exists() and not (output / 'migration-report.json').exists():
        raise ValueError('已有标签处置表缺少对应的预览报告，无法确认其来源，拒绝覆盖。')
    if (output / 'migration-report.json').exists():
        if json.loads(read_regular(output / 'migration-report.json', 64 * 1024 * 1024))['version'] != REPORT_VERSION:
            raise ValueError('已有报告的版本不符合标签预览协议，拒绝覆盖。')
    if (output / 'bundle-manifest.json').exists():
        if json.loads(read_regular(output / 'bundle-manifest.json'))['version'] != BUNDLE_VERSION:
            raise ValueError('已有文件清单的版本不符合标签预览协议，拒绝覆盖。')
    return output


def _build_preview_locked(blog_repo, output, tag_catalog_path=None):
    require_external_runtime('build-tag-preview.py')
    repo = safe_directory(blog_repo)
    destination = validate_output_root(output, repo)
    commit = git_snapshot(repo)
    tag_catalog_path = Path(tag_catalog_path or tag_paths.TAG_CATALOG_FILE)
    tag_catalog = load_tag_catalog(tag_catalog_path)
    base = blog_base_url(repo)
    paths = markdown_paths(repo)
    pages, excluded, page_content_hashes = [], [], []
    for path in paths:
        raw = read_regular(path)
        page_content_hashes.append({'relativePath': path.relative_to(repo).as_posix(), 'sha256': sha256(raw)})
        page, reason = paper_metadata(repo, path, raw, base)
        if page is None:
            excluded.append({'relativePath': path.relative_to(repo).as_posix(), 'reason': reason})
        else:
            pages.append(page)
    if not pages:
        raise ValueError('未找到可用于标签预览的论文页面。')
    tag_page_counts = collections.Counter(tag for page in pages for tag in set(page['tags']))
    # 本工具核对历史 Hugo 元数据，因此按历史读取规则接受别名；
    # 正式解析器仍只接受当前允许的名称。
    resolved_concepts = {tag: resolve_label(
        tag_catalog, tag, mode=LABEL_MODE_LEGACY) for tag in tag_page_counts}
    pages_by_arxiv_id, pages_without_arxiv_id = collections.defaultdict(list), []
    for page in pages:
        (pages_by_arxiv_id[page['id']] if page['id'] else pages_without_arxiv_id).append(page)
    representatives = []
    for group in pages_by_arxiv_id.values():
        latest = max(group, key=lambda page: (page['_sortDate'], page['relativePath']))
        latest['duplicatePaths'] = sorted(page['relativePath'] for page in group if page is not latest)
        representatives.append(latest)
    for page in pages_without_arxiv_id:
        page['duplicatePaths'] = []
    papers = [classify_page(page, tag_catalog, resolved_concepts) for page in representatives + pages_without_arxiv_id]
    papers.sort(key=lambda paper: (paper['date'], paper['relativePath']), reverse=True)
    blog_input_snapshot = {'commit': commit, 'pagesSha256': stable_hash(page_content_hashes)}
    summary = {'markdownPages': len(paths), 'paperPages': len(pages), 'excludedPages': len(excluded),
               'records': len(papers), 'knownIdCount': len(pages_by_arxiv_id),
               'knownIdPages': sum(map(len, pages_by_arxiv_id.values())), 'unknownIdPages': len(pages_without_arxiv_id),
               'duplicateIdGroups': sum(len(group) > 1 for group in pages_by_arxiv_id.values()),
               'uniqueTags': len(tag_page_counts), 'unresolvedTags': sum(value is None for value in resolved_concepts.values()),
               'unresolvedRecords': sum(paper['classificationStatus'] == 'unresolved' for paper in papers),
               'partialRecords': sum(paper['classificationStatus'] == 'partial' for paper in papers),
               'legacyMappedRecords': sum(paper['classificationStatus'] == 'legacy_mapped' for paper in papers),
               'explicitPrimaryTaskRecords': sum(paper['primaryTaskId'] is not None for paper in papers),
               'semanticallyReviewedRecords': 0}
    occurrences = collections.Counter(tag for page in pages for tag in page['tags'])
    dispositions = build_dispositions(tag_page_counts, resolved_concepts, tag_catalog)
    summary.update({
        'mappedUniqueTags': sum(value is not None for value in resolved_concepts.values()),
        'tagOccurrences': sum(occurrences.values()),
        'mappedTagOccurrences': sum(
            count for tag, count in occurrences.items() if resolved_concepts[tag] is not None),
        'uniqueTagCoverage': (
            sum(value is not None for value in resolved_concepts.values()) / len(tag_page_counts)
            if tag_page_counts else 0),
        'tagOccurrenceCoverage': (
            sum(count for tag, count in occurrences.items() if resolved_concepts[tag] is not None)
            / sum(occurrences.values()) if occurrences else 0),
        'coverageMeaning': 'literal_registry_mapping_not_semantic_accuracy'
    })
    summary.update(disposition_summary(dispositions))
    index = {'version': VERSION, 'tagCatalogVersion': tag_catalog['version'], 'registrySha256': tag_catalog['registrySha256'],
             'source': blog_input_snapshot, 'summary': summary, 'facets': tag_catalog['facets'],
             'concepts': tag_catalog['concepts'], 'papers': papers}
    report = {'version': REPORT_VERSION, 'tagCatalogVersion': tag_catalog['version'],
              'registrySha256': tag_catalog['registrySha256'], 'source': blog_input_snapshot, 'summary': summary,
              'dispositionSchema': DISPOSITION_SCHEMA, 'dispositionRule': PENDING_RULE,
              'note': '本报告只统计标签名称与词表的字面对照结果，不代表语义分类正确。未取得论文 ID 的记录也不能证明彼此属于不同论文。',
              'pages': page_content_hashes, 'excluded': excluded, 'tagDispositions': dispositions,
              'duplicates': [{'id': pid, 'relativePaths': sorted(page['relativePath'] for page in group)}
                             for pid, group in sorted(pages_by_arxiv_id.items()) if len(group) > 1]}
    # 写入输出前，再核对 Markdown 文件列表、Git 状态、页面内容 SHA 和词表 SHA。
    # 仅检查 Git 提交不能发现忽略文件的变化。
    if markdown_paths(repo) != paths or git_snapshot(repo) != commit:
        raise ValueError('生成标签预览期间，博客文件列表或 Git 状态发生变化。')
    for path, expected in zip(paths, page_content_hashes):
        if sha256(read_regular(path)) != expected['sha256']:
            raise ValueError('生成标签预览期间，博客页面的 SHA 发生变化。')
    if load_tag_catalog(tag_catalog_path)['registrySha256'] != tag_catalog['registrySha256']:
        raise ValueError('生成标签预览期间，标签词表的 SHA 发生变化。')
    preview_index_json = json.dumps(index, ensure_ascii=False, indent=2) + '\n'
    if str(repo) in preview_index_json or str(path_config.PROJECT_ROOT) in preview_index_json:
        raise ValueError('公开的标签预览元数据不得包含用户本地的绝对路径。')
    csv_text = io.StringIO(newline='')
    writer = csv.DictWriter(csv_text, fieldnames=list(DISPOSITION_CSV_COLUMNS))
    writer.writeheader()
    writer.writerows({**row,
                      'evidence': json.dumps(row['evidence'], ensure_ascii=False, separators=(',', ':')),
                      'tag': "'" + row['tag'] if row['tag'].lstrip().startswith(('=', '+', '-', '@'))
                      else row['tag']}
                     for row in dispositions)
    report_text = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
    csv_output = csv_text.getvalue()
    preview_file_manifest = {'version': BUNDLE_VERSION, 'tagCatalogVersion': tag_catalog['version'],
              'registrySha256': tag_catalog['registrySha256'], 'source': blog_input_snapshot,
              'files': {'index.json': sha256(preview_index_json.encode('utf-8')),
                        'migration-report.json': sha256(report_text.encode('utf-8')),
                        'tag-disposition.csv': sha256(csv_output.encode('utf-8'))}}
    # 最后写入文件清单。中断可能留下不同批次的私有文件；
    # 读取端须核对三份文件的 SHA，旧清单不能认证新旧混合内容。
    validate_output_root(destination, repo)
    path_config.atomic_write_text(destination / 'migration-report.json', report_text, mode=0o600)
    path_config.atomic_write_text(destination / 'tag-disposition.csv', csv_output, mode=0o600)
    path_config.atomic_write_text(destination / 'index.json', preview_index_json, mode=0o600)
    path_config.atomic_write_json(destination / 'bundle-manifest.json', preview_file_manifest, mode=0o600)
    return index


def build_preview(blog_repo, output, tag_catalog_path=None):
    require_external_runtime('build-tag-preview.py')
    repo = safe_directory(blog_repo)
    destination = validate_output_root(output, repo)
    with path_config.file_lock(destination / '.preview-build'):
        return _build_preview_locked(repo, destination, tag_catalog_path)


def main(argv=None):
    require_external_runtime('build-tag-preview.py')
    load_project_env()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--blog-repo')
    parser.add_argument('--output', default=str(tag_paths.TAG_PREVIEW_DIR))
    args = parser.parse_args(argv)
    # 先检查用户传入的路径，再交给统一路径解析器；
    # 避免符号链接在解析后被当作普通路径接受。
    if args.blog_repo:
        safe_directory(args.blog_repo)
    result = build_preview(tag_paths.resolve_blog_repo_path(args.blog_repo), args.output)
    print(json.dumps({'version': result['version'], 'source': result['source'], 'summary': result['summary']}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
