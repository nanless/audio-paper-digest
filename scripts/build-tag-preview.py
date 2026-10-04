#!/usr/bin/env python3
"""Build a private metadata-only tag preview index; never rewrite papers.

Also emits the seven-state legacy tag disposition table
(keep / alias / broader / split_review / move_facet / deprecated / out_of_scope)
with the original tag and status columns preserved verbatim.
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

VERSION = 'paper-taxonomy-preview-v1'
REPORT_VERSION = 'paper-taxonomy-migration-report-v1'
BUNDLE_VERSION = 'paper-taxonomy-preview-bundle-v1'
MAX_PAGE_BYTES = 8 * 1024 * 1024
ARXIV_ID = re.compile(r'\d{4}\.\d{4,5}(?:v[1-9]\d*)?')

# 旧标签的七种处置方式（docs/tag-system-design.md 5.3）：每个旧标签最终必须落入其一，
# 保留原值、不静默删除；空 disposition 表示“尚未处置”，不是第八态。
DISPOSITION_SCHEMA = 'paper-taxonomy-seven-state-disposition-v1'
DISPOSITIONS = ('keep', 'alias', 'broader', 'split_review', 'move_facet',
                'deprecated', 'out_of_scope')
# 旧列原样保留（语义不变），新列只做追加，兼容既有 CSV/报告消费方。
LEGACY_CSV_COLUMNS = ('tag', 'pageCount', 'status', 'conceptId', 'facet', 'semanticReview')
DISPOSITION_CSV_COLUMNS = ('tag', 'pageCount', 'disposition', 'status', 'conceptId',
                           'facet', 'semanticReview', 'evidence')
# “仅上位命中”判定要求上位中文首选标签至少这么长，避免两字泛词误命中。
MIN_UPPER_LABEL_CHARS = 3
PENDING_RULE = '未处置行保留原值待评审；deprecated/out_of_scope 必须有跨会零命中扫描证据 + 人工评审，禁按单会议频次判定'


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
            raise ValueError(f'{where}: evidence 必须是 JSON 对象 ({error})') from error
        if isinstance(parsed, dict):
            return parsed
    raise ValueError(f'{where}: evidence 必须是 JSON 对象')


def upper_label_candidates(tag_catalog, tag):
    """确定性“仅上位命中”检测：未直接命中的标签里，唯一被包含的 active 上位标签。

    只做字面包含判断，不做任何语义推断；命中结果写进 evidence 供人工复核。
    """
    normalized = normalize_label(tag)
    if not normalized:
        return []
    found = {}
    for concept in tag_catalog['concepts']:
        if concept['status'] != 'active':
            continue
        label = normalize_label(concept['preferredLabel']['zh'])
        if len(label) >= MIN_UPPER_LABEL_CHARS and label != normalized and label in normalized:
            found.setdefault(concept['id'], {'conceptId': concept['id'],
                                             'label': concept['preferredLabel']['zh']})
    return [found[cid] for cid in sorted(found)]


def initial_disposition(tag, concept, tag_catalog):
    """七态初始值：只用字面 registry 解析，不重算语义（semanticReview 仍 not_performed）。

    返回 (disposition, evidence)；空 disposition = 尚未处置，必须带 evidence.reason。
    """
    if concept is not None:
        if concept['status'] != 'active':
            return '', {'reason': '字面命中 deprecated 概念：须跨会零命中扫描 + 人工评审后才能判 deprecated'}
        normalized = normalize_label(tag)
        if normalized == normalize_label(concept['preferredLabel']['zh']):
            return 'keep', {'matchKind': 'zh_preferred_label'}
        if normalized == normalize_label(concept['preferredLabel']['en']):
            return 'alias', {'matchKind': 'en_preferred_label'}
        return 'alias', {'matchKind': 'alias'}
    candidates = upper_label_candidates(tag_catalog, tag)
    if len(candidates) == 1:
        return 'broader', {'matchKind': 'upper_label_containment',
                           'upperConceptId': candidates[0]['conceptId'],
                           'upperLabel': candidates[0]['label']}
    if candidates:
        return '', {'reason': '同时命中多个上位标签，待人工判定是否拆分（可升级为 split_review）',
                    'candidates': candidates}
    return '', {'reason': 'registry 字面解析零命中，待语义/人工评审'}


def build_dispositions(counts, resolved, tag_catalog):
    rows = [{'tag': tag, 'pageCount': count, 'disposition': None, 'status': 'mapped' if resolved[tag] else 'needs_review',
             'conceptId': resolved[tag]['id'] if resolved[tag] else '',
             'facet': resolved[tag]['facet'] if resolved[tag] else '',
             'semanticReview': 'not_performed', 'evidence': None}
            for tag, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))]
    for row in rows:
        disposition, evidence = initial_disposition(row['tag'], resolved[row['tag']], tag_catalog)
        row['disposition'], row['evidence'] = disposition, evidence
    return validate_disposition_rows(rows)


def validate_disposition_rows(rows):
    """七态互斥与证据校验；旧六列形状的行按旧 schema 直接放行。"""
    if not isinstance(rows, list):
        raise ValueError('dispositions: 必须是数组')
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('tag'), str) or not row['tag']:
            raise ValueError('disposition 行缺少 tag')
        tag = row['tag']
        if tag in seen:
            raise ValueError(f'{tag}: disposition 行重复')
        seen.add(tag)
        status = row.get('status')
        if status not in ('mapped', 'needs_review'):
            raise ValueError(f'{tag}: status 必须是 mapped 或 needs_review')
        # 旧列形状：既没有 disposition 也没有 evidence → 兼容读取，不施加七态校验。
        if 'disposition' not in row and 'evidence' not in row:
            continue
        disposition = row.get('disposition') or ''
        if disposition not in ('', *DISPOSITIONS):
            raise ValueError(f'{tag}: disposition {disposition!r} 不属于七态 {DISPOSITIONS}')
        evidence = parse_evidence(row.get('evidence'), tag)
        if not disposition:
            reason = evidence.get('reason')
            if not isinstance(reason, str) or not reason.strip():
                raise ValueError(f'{tag}: 空 disposition（尚未处置）必须在 evidence.reason 写明原因')
            continue
        if disposition in ('keep', 'alias'):
            if status != 'mapped':
                raise ValueError(f'{tag}: {disposition} 只能出现在 status=mapped 行（互斥）')
            if not isinstance(row.get('conceptId'), str) or not row.get('conceptId'):
                raise ValueError(f'{tag}: {disposition} 必须携带 conceptId')
        elif disposition == 'broader':
            if status != 'needs_review' or not isinstance(evidence.get('upperConceptId'), str) \
                    or not evidence['upperConceptId']:
                raise ValueError(f'{tag}: broader 只能来自“仅上位命中”（status=needs_review + evidence.upperConceptId）')
        elif disposition == 'split_review':
            if status != 'needs_review':
                raise ValueError(f'{tag}: split_review 只能出现在 status=needs_review 行（互斥）')
            candidates = evidence.get('candidates')
            if not isinstance(candidates, list) or not candidates \
                    or any(not isinstance(item, str) or not item.strip() for item in candidates):
                raise ValueError(f'{tag}: split_review 必须带候选词列表 evidence.candidates（非空字符串数组）')
        elif disposition == 'move_facet':
            if status != 'mapped':
                raise ValueError(f'{tag}: move_facet 只能出现在 status=mapped 行（互斥）')
            target = evidence.get('facet')
            if target not in FACET_IDS:
                raise ValueError(f'{tag}: move_facet 必须带 evidence.facet ∈ 九分面')
            if row.get('facet') and target == row['facet']:
                raise ValueError(f'{tag}: move_facet 目标分面必须与当前分面不同')
        else:  # deprecated / out_of_scope
            zero = evidence.get('crossConferenceZeroHit')
            if not isinstance(zero, dict) or not isinstance(zero.get('scan'), str) or not zero['scan'].strip():
                raise ValueError(f'{tag}: {disposition} 必须带跨会零命中扫描证据 '
                                 'evidence.crossConferenceZeroHit.scan（禁按单会议频次判定）')
            reviewer = evidence.get('reviewedBy')
            if not isinstance(reviewer, str) or not reviewer.strip():
                raise ValueError(f'{tag}: {disposition} 必须带人工评审署名 evidence.reviewedBy')
    return rows


def read_disposition_rows(text):
    """兼容新旧两种表头读取 disposition 行（旧六列缺 disposition/evidence）。"""
    rows = list(csv.DictReader(io.StringIO(text)))
    return validate_disposition_rows(rows)


def disposition_summary(dispositions):
    counts = {state: sum(row['disposition'] == state for row in dispositions)
              for state in DISPOSITIONS}
    return {'dispositionSchema': DISPOSITION_SCHEMA, 'dispositionCounts': counts,
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
            raise ValueError('Taxonomy path contains a symlink or non-directory')
    return target


def read_regular(path, limit=MAX_PAGE_BYTES):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            raise ValueError('Taxonomy input must be bounded regular single-link file')
        with os.fdopen(fd, 'rb', closefd=False) as handle:
            raw = handle.read(limit + 1)
        if len(raw) > limit:
            raise ValueError('Taxonomy input exceeds size limit')
        return raw
    finally:
        os.close(fd)


def git_snapshot(repo):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(repo), *args],
                                       env=build_child_process_env(), text=True, timeout=30).strip()
    if Path(git('rev-parse', '--show-toplevel')).resolve() != repo:
        raise ValueError('Blog input must be the Git repository root')
    head = git('rev-parse', 'HEAD')
    if not re.fullmatch(r'[a-f0-9]{40,64}', head) or git('status', '--porcelain=v1', '--untracked-files=all'):
        raise ValueError('Blog input must be a clean committed worktree')
    return head


def markdown_paths(repo):
    root = safe_directory(repo / 'content' / 'posts')
    found = []
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in [*dirs, *files]:
            path = Path(directory) / name
            if path.is_symlink():
                raise ValueError('Blog content symlink refused')
        found.extend(Path(directory) / name for name in files if name.lower().endswith('.md'))
    return sorted(found, key=lambda path: path.relative_to(repo).as_posix())


def normalized_date(value):
    if isinstance(value, (date, datetime)):
        return value.isoformat()[:10], value.isoformat()
    if not isinstance(value, str) or not re.match(r'^\d{4}-\d{2}-\d{2}(?:$|[T ])', value):
        raise ValueError('Paper date must be a valid ISO date')
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
        raise ValueError('Custom Hugo permalinks require an explicit URL projection contract')
    base = values.get('baseURL')
    if not isinstance(base, str):
        raise ValueError('Hugo baseURL is required')
    parsed = urlsplit(base)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.port not in (None, 443) or parsed.query or parsed.fragment
            or re.search(r'[\x00-\x20\x7f\\]', base)):
        raise ValueError('Hugo baseURL must be safe HTTPS')
    return base.rstrip('/') + '/'


def page_url(repo, path, frontmatter, base):
    root = urlsplit(base)
    raw = frontmatter.get('url')
    if raw is None:
        slug = frontmatter.get('slug', path.stem)
        if not isinstance(slug, str) or not slug or slug != slug.strip() or re.search(r'[\x00-\x1f\x7f/\\?#]', slug):
            raise ValueError('Unsafe page slug')
        relative = path.parent.relative_to(repo / 'content' / 'posts').as_posix()
        parts = ([] if relative == '.' else relative.split('/')) + [slug]
        raw = root.path + 'posts/' + '/'.join(quote(part, safe='-._~') for part in parts) + '/'
    if not isinstance(raw, str) or not raw or re.search(r'[\x00-\x20\x7f\\]', raw) or raw.startswith('//'):
        raise ValueError('Unsafe page URL')
    parsed = urlsplit(raw)
    if parsed.scheme and (parsed.scheme != 'https' or parsed.netloc != root.netloc):
        raise ValueError('Foreign or non-HTTPS page URL')
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('Unsafe page URL components')
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
        raise ValueError('Page URL escapes blog base path')
    return urlunsplit((root.scheme, root.netloc, url_path, '', ''))


def paper_metadata(repo, path, raw, base):
    relative = path.relative_to(repo).as_posix()
    if '\\' in relative or any(part in ('.', '..') for part in Path(relative).parts):
        raise ValueError('Unsafe source relative path')
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
        raise ValueError(f'Invalid tag list: {relative}')
    title = frontmatter.get('title')
    if not isinstance(title, str) or not title.strip() or re.search(r'[\x00-\x1f\x7f]', title):
        raise ValueError(f'Invalid paper title: {relative}')
    public_date, sort_date = normalized_date(frontmatter.get('date'))
    identity_evidence = []
    for key in ('paper_digest_arxiv_id', 'arxiv_id', 'arxivId'):
        explicit = frontmatter.get(key)
        if explicit is None:
            continue
        if not isinstance(explicit, str) or not ARXIV_ID.fullmatch(explicit):
            raise ValueError(f'Invalid explicit arXiv identity: {relative} ({key})')
        identity_evidence.append((re.sub(r'v[1-9]\d*$', '', explicit), 'frontmatter'))
    filename = re.search(r'-(\d{4})-(\d{4,5})(?:v[1-9]\d*)?$', path.stem)
    if filename:
        identity_evidence.append(('.'.join(filename.groups()), 'filename'))
    # Body is read solely for the same explicit primary-arxiv identity fallback
    # as the prior audit. It is never included in any output or classification.
    linked = set(re.findall(r'\[arxiv\]\(https://arxiv\.org/abs/(\d{4}\.\d{4,5})(?:v[1-9]\d*)?\)', body, re.I))
    identity_evidence.extend((value, 'explicit_arxiv_link') for value in sorted(linked))
    if len({value for value, _origin in identity_evidence}) > 1:
        raise ValueError(f'Conflicting arXiv identities: {relative}')
    pid, id_source = identity_evidence[0] if identity_evidence else (None, None)
    primary_keys = ('paper_digest_primary_task', 'primaryTask', 'primary_task', 'primaryTaskTag', 'primary_task_tag')
    if any(key in frontmatter and frontmatter[key] is not None and not isinstance(frontmatter[key], str)
           for key in primary_keys):
        raise ValueError(f'Explicit primary task must be string or null: {relative}')
    primary_values = [{'field': key, 'value': value} for key, value in frontmatter.items()
                      if key in primary_keys
                      and isinstance(value, str) and value.strip()]
    return {'id': pid, 'idSource': id_source, 'title': title, 'date': public_date,
            'url': page_url(repo, path, frontmatter, base), 'tags': tags,
            'sourceSha256': sha256(raw), 'relativePath': relative,
            '_sortDate': sort_date, '_primaryValues': primary_values}, None


def classify_page(page, tag_catalog, resolved_labels):
    by_id = {concept['id']: concept for concept in tag_catalog['concepts']}
    mapped, unresolved = [], []
    for tag in page['tags']:
        concept = resolved_labels[tag]
        if concept is None:
            if tag not in unresolved:
                unresolved.append(tag)
        elif concept['id'] not in mapped:
            mapped.append(concept['id'])
    primary_matches = [resolve_label(
        tag_catalog, value['value'], 'task', mode=LABEL_MODE_LEGACY)
        for value in page['_primaryValues']]
    primary_ids = {concept['id'] for concept in primary_matches if concept is not None}
    primary = next(iter(primary_ids)) if len(primary_ids) == 1 and all(primary_matches) else None
    primary_unresolved = [{**item, 'reason': 'conflicting_explicit_tasks' if len(primary_ids) > 1
                          else 'unknown_or_wrong_role'} for item, concept in zip(page['_primaryValues'], primary_matches)
                          if concept is None or len(primary_ids) > 1]
    if primary is not None and primary not in mapped:
        mapped.append(primary)
    facet_ids = {facet: [cid for cid in mapped if by_id[cid]['facet'] == facet] for facet in FACET_IDS}
    ancestor_ids = {facet: list(dict.fromkeys(parent for cid in values for parent in ancestors(tag_catalog, cid)))
                    for facet, values in facet_ids.items()}
    public = {key: value for key, value in page.items() if not key.startswith('_')}
    public.update({'recordId': f'arxiv:{page["id"]}' if page['id'] else 'page:' + sha256(page['relativePath'].encode()),
                   'mappedIds': mapped, 'displayIds': prune_ancestors(tag_catalog, mapped),
                   'facetIds': facet_ids, 'ancestorIds': ancestor_ids, 'unresolvedTags': unresolved,
                   'primaryTaskId': primary, 'primaryTaskSource': page['_primaryValues'],
                   'primaryUnresolved': primary_unresolved, 'classificationStatus':
                       'unresolved' if not mapped else 'partial' if unresolved or primary_unresolved else 'legacy_mapped'})
    return public


def validate_output_root(value, repo):
    output = Path(os.path.abspath(Path(value).expanduser()))
    project = path_config.PROJECT_ROOT.resolve()
    forbidden = [repo, path_config.CURRENT_DIR.resolve(), path_config.FRESH_REWRITE_RUNS_DIR.resolve()]
    if output == project or output in project.parents or any(output == root or root in output.parents or output in root.parents for root in forbidden):
        raise ValueError('Taxonomy output overlaps an input or protected directory')
    if project in output.parents and project / 'data' / 'runtime' not in output.parents:
        raise ValueError('Project taxonomy output must be under data/runtime')
    safe_directory(output, create=True)
    for name in ('index.json', 'migration-report.json', 'tag-disposition.csv', 'bundle-manifest.json'):
        target = output / name
        if target.exists() or target.is_symlink():
            read_regular(target, 64 * 1024 * 1024)
    if (output / 'index.json').exists():
        if json.loads(read_regular(output / 'index.json', 64 * 1024 * 1024))['version'] != VERSION:
            raise ValueError('Refusing to overwrite non-taxonomy index')
    elif (output / 'tag-disposition.csv').exists() and not (output / 'migration-report.json').exists():
        raise ValueError('Refusing to overwrite unowned taxonomy output')
    if (output / 'migration-report.json').exists():
        if json.loads(read_regular(output / 'migration-report.json', 64 * 1024 * 1024))['version'] != REPORT_VERSION:
            raise ValueError('Refusing to overwrite non-taxonomy report')
    if (output / 'bundle-manifest.json').exists():
        if json.loads(read_regular(output / 'bundle-manifest.json'))['version'] != BUNDLE_VERSION:
            raise ValueError('Refusing to overwrite non-taxonomy bundle manifest')
    return output


def _build_preview_locked(blog_repo, output, registry_path=None):
    require_external_runtime('build-tag-preview.py')
    repo = safe_directory(blog_repo)
    destination = validate_output_root(output, repo)
    commit = git_snapshot(repo)
    registry_path = Path(registry_path or tag_paths.TAG_CATALOG_FILE)
    tag_catalog = load_tag_catalog(registry_path)
    base = blog_base_url(repo)
    paths = markdown_paths(repo)
    pages, excluded, hashes = [], [], []
    for path in paths:
        raw = read_regular(path)
        hashes.append({'relativePath': path.relative_to(repo).as_posix(), 'sha256': sha256(raw)})
        page, reason = paper_metadata(repo, path, raw, base)
        if page is None:
            excluded.append({'relativePath': path.relative_to(repo).as_posix(), 'reason': reason})
        else:
            pages.append(page)
    if not pages:
        raise ValueError('No paper pages found')
    counts = collections.Counter(tag for page in pages for tag in set(page['tags']))
    # This tool is an audit of historical Hugo metadata, so aliases are
    # intentionally enabled here and nowhere in the production parser.
    resolved = {tag: resolve_label(
        tag_catalog, tag, mode=LABEL_MODE_LEGACY) for tag in counts}
    groups, unknown = collections.defaultdict(list), []
    for page in pages:
        (groups[page['id']] if page['id'] else unknown).append(page)
    representatives = []
    for group in groups.values():
        latest = max(group, key=lambda page: (page['_sortDate'], page['relativePath']))
        latest['duplicatePaths'] = sorted(page['relativePath'] for page in group if page is not latest)
        representatives.append(latest)
    for page in unknown:
        page['duplicatePaths'] = []
    papers = [classify_page(page, tag_catalog, resolved) for page in representatives + unknown]
    papers.sort(key=lambda paper: (paper['date'], paper['relativePath']), reverse=True)
    source = {'commit': commit, 'pagesSha256': stable_hash(hashes)}
    summary = {'markdownPages': len(paths), 'paperPages': len(pages), 'excludedPages': len(excluded),
               'records': len(papers), 'knownIdCount': len(groups),
               'knownIdPages': sum(map(len, groups.values())), 'unknownIdPages': len(unknown),
               'duplicateIdGroups': sum(len(group) > 1 for group in groups.values()),
               'uniqueTags': len(counts), 'unresolvedTags': sum(value is None for value in resolved.values()),
               'unresolvedRecords': sum(paper['classificationStatus'] == 'unresolved' for paper in papers),
               'partialRecords': sum(paper['classificationStatus'] == 'partial' for paper in papers),
               'legacyMappedRecords': sum(paper['classificationStatus'] == 'legacy_mapped' for paper in papers),
               'explicitPrimaryTaskRecords': sum(paper['primaryTaskId'] is not None for paper in papers),
               'semanticallyReviewedRecords': 0}
    occurrences = collections.Counter(tag for page in pages for tag in page['tags'])
    dispositions = build_dispositions(counts, resolved, tag_catalog)
    summary.update({'mappedUniqueTags': sum(value is not None for value in resolved.values()),
                    'tagOccurrences': sum(occurrences.values()),
                    'mappedTagOccurrences': sum(count for tag, count in occurrences.items() if resolved[tag] is not None),
                    'uniqueTagCoverage': sum(value is not None for value in resolved.values()) / len(counts) if counts else 0,
                    'tagOccurrenceCoverage': sum(count for tag, count in occurrences.items() if resolved[tag] is not None)
                        / sum(occurrences.values()) if occurrences else 0,
                    'coverageMeaning': 'literal_registry_mapping_not_semantic_accuracy'})
    summary.update(disposition_summary(dispositions))
    index = {'version': VERSION, 'taxonomyVersion': tag_catalog['version'], 'registrySha256': tag_catalog['registrySha256'],
             'source': source, 'summary': summary, 'facets': tag_catalog['facets'],
             'concepts': tag_catalog['concepts'], 'papers': papers}
    report = {'version': REPORT_VERSION, 'taxonomyVersion': tag_catalog['version'],
              'registrySha256': tag_catalog['registrySha256'], 'source': source, 'summary': summary,
              'dispositionSchema': DISPOSITION_SCHEMA, 'dispositionRule': PENDING_RULE,
              'note': 'Literal registry mapping only; not semantic classification. Unknown-ID records are not proven unique papers.',
              'pages': hashes, 'excluded': excluded, 'tagDispositions': dispositions,
              'duplicates': [{'id': pid, 'relativePaths': sorted(page['relativePath'] for page in group)}
                             for pid, group in sorted(groups.items()) if len(group) > 1]}
    # Verify all inputs again before installing any artifact; also catches
    # ignored/untracked-file list drift that a Git HEAD check alone cannot see.
    if markdown_paths(repo) != paths or git_snapshot(repo) != commit:
        raise ValueError('Blog snapshot changed during taxonomy preview')
    for path, expected in zip(paths, hashes):
        if sha256(read_regular(path)) != expected['sha256']:
            raise ValueError('Blog page SHA changed during taxonomy preview')
    if load_tag_catalog(registry_path)['registrySha256'] != tag_catalog['registrySha256']:
        raise ValueError('Taxonomy registry changed during preview')
    public_text = json.dumps(index, ensure_ascii=False, indent=2) + '\n'
    if str(repo) in public_text or str(path_config.PROJECT_ROOT) in public_text:
        raise ValueError('Absolute user path cannot appear in public taxonomy metadata')
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
    bundle = {'version': BUNDLE_VERSION, 'taxonomyVersion': tag_catalog['version'],
              'registrySha256': tag_catalog['registrySha256'], 'source': source,
              'files': {'index.json': sha256(public_text.encode('utf-8')),
                        'migration-report.json': sha256(report_text.encode('utf-8')),
                        'tag-disposition.csv': sha256(csv_output.encode('utf-8'))}}
    # The bundle manifest is the publication point and is installed last.
    # A crash may leave mixed private files, but the previous bundle cannot
    # validate them; serving requires all three exact hashes to match.
    validate_output_root(destination, repo)
    path_config.atomic_write_text(destination / 'migration-report.json', report_text, mode=0o600)
    path_config.atomic_write_text(destination / 'tag-disposition.csv', csv_output, mode=0o600)
    path_config.atomic_write_text(destination / 'index.json', public_text, mode=0o600)
    path_config.atomic_write_json(destination / 'bundle-manifest.json', bundle, mode=0o600)
    return index


def build_preview(blog_repo, output, registry_path=None):
    require_external_runtime('build-tag-preview.py')
    repo = safe_directory(blog_repo)
    destination = validate_output_root(output, repo)
    with path_config.file_lock(destination / '.preview-build'):
        return _build_preview_locked(repo, destination, registry_path)


def main(argv=None):
    require_external_runtime('build-tag-preview.py')
    load_project_env()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--blog-repo')
    parser.add_argument('--output', default=str(tag_paths.TAG_PREVIEW_DIR))
    args = parser.parse_args(argv)
    # Validate the explicit spelling before the central resolver canonicalizes
    # it, so passing a symlink is not silently turned into an accepted path.
    if args.blog_repo:
        safe_directory(args.blog_repo)
    result = build_preview(tag_paths.resolve_blog_repo_path(args.blog_repo), args.output)
    print(json.dumps({'version': result['version'], 'source': result['source'], 'summary': result['summary']}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
