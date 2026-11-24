#!/usr/bin/env python3
"""标签受控词表快照、版本目录、展示策略、确定性序列化缓存与页面标签投影。"""

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

import hashlib
import json
import os
import re
import stat
import sys
import tempfile
import threading
from collections import OrderedDict
from collections.abc import Mapping
from pathlib import Path
from urllib.parse import quote

_SHARED_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SHARED_SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SHARED_SCRIPTS_DIR)

import protocol_codec as public_protocols  # noqa: E402
from publish_common import PublishDataValidationError  # noqa: E402
from tag_catalog import (  # noqa: E402
    TAG_FLAT_COMPAT_CONTRACT,
    _parse_tag_catalog_bytes,
    is_strict_append_only_catalog,
    is_supported_flat_tag_contract,
    load_tag_catalog,
    resolve_compatible_proof_catalog,
    tag_catalog_identity,
)
from tag_presentation import render_tag_hierarchy_markdown  # noqa: E402
from utils import parse_analysis, read_tag_validation  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parent.parent
_CURRENT_CONTEXT_SCHEMA = object()
_UNSET_CONTRACT = object()
FLAT_TAG_COMPAT_CONTRACT = TAG_FLAT_COMPAT_CONTRACT
_PAGE_TAG_CATALOG = load_tag_catalog()
_PAGE_ACTIVE_TAGS_BY_ID = {
    item['id']: item for item in _PAGE_TAG_CATALOG['concepts']
    if item['status'] == 'active'
}
TAG_CATALOG_SNAPSHOT_CONTRACT = public_protocols.contract('paper-tag-catalog-snapshot')
LEGACY_TAG_CATALOG_SNAPSHOT_CONTRACT = public_protocols.historical_contract(
    'paper-tag-catalog-snapshot', 'legacy-public-concept-hierarchy',
)
TAG_CATALOG_VERSIONS_CONTRACT = public_protocols.contract('paper-tag-catalog-versions')
LEGACY_TAG_CATALOG_VERSIONS_CONTRACT = public_protocols.historical_contract(
    'paper-tag-catalog-versions', 'legacy-sha-keyed-snapshot-set',
)
SITE_TAG_CATALOG_SNAPSHOT_CONTRACT = public_protocols.historical_contract(
    'paper-tag-catalog-snapshot', 'public-concept-hierarchy',
)
SITE_TAG_CATALOG_VERSIONS_CONTRACT = public_protocols.historical_contract(
    'paper-tag-catalog-versions', 'sha-keyed-snapshot-set',
)
TAG_PRESENTATION_POLICY_CONTRACT = public_protocols.contract('paper-tag-presentation-policy')
LEGACY_TAG_PRESENTATION_POLICY_CONTRACT = public_protocols.historical_contract(
    'paper-tag-presentation-policy', 'legacy-display-catalog',
)
TAG_CATALOG_PATH = PROJECT_ROOT / 'config' / 'tag-catalog.json'
TAG_CATALOG_HISTORY_DIR = PROJECT_ROOT / 'config' / 'tag-catalog-history'
TAG_DISPLAY_POLICY_PATH = PROJECT_ROOT / 'config' / 'tag-display-policy.json'
_INITIAL_PAGE_TAG_CATALOG_SHA256 = _PAGE_TAG_CATALOG['registrySha256']
_INITIAL_PAGE_TAG_CATALOG_MEM_SHA256 = hashlib.sha256(
    json.dumps(_PAGE_TAG_CATALOG, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
).hexdigest()
TAG_CATALOG_SERIALIZATION_CACHE_MAX = 4
_TAG_CATALOG_SERIALIZATION_CACHE: OrderedDict = OrderedDict()
_TAG_CATALOG_SERIALIZATION_CACHE_LOCK = threading.Lock()
TAG_CATALOG_SNAPSHOT_RELATIVE = Path('data') / 'tag-catalog-snapshot.json'
TAG_CATALOG_STATIC_RELATIVE = Path('static') / 'data' / 'tag-catalog-snapshot.json'


def _hook(hooks: Mapping | None, name: str, default=None):
    if hooks is not None and name in hooks:
        return hooks[name]
    return default


def _default_sha256_file(path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


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


def _default_load_json_object(path, label: str, err_cls):
    try:
        data = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise err_cls(f'无法读取 {label}: {path}') from exc
    if not isinstance(data, dict):
        raise err_cls(f'{label} 必须是 JSON 对象: {path}')
    return data


def build_tag_catalog_snapshot(
    tag_catalog=None, *, snapshot_contract=_UNSET_CONTRACT, hooks: Mapping | None = None,
):
    """根据只读词表生成博客搜索使用的精简快照。

    每个概念保留 id、facet、中英文名称和别名，ancestorIds 按从最高层到直接上级的顺序记录。
    博客可据此按上级概念查询论文，或用别名匹配标签，无需在浏览器中重新推导标签含义和层级。
    """
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    protocols = _hook(hooks, 'public_protocols', public_protocols)
    identity_fn = _hook(hooks, 'tag_catalog_identity', tag_catalog_identity)
    page_catalog = _hook(hooks, '_PAGE_TAG_CATALOG', _PAGE_TAG_CATALOG)
    contract = (
        _hook(hooks, 'TAG_CATALOG_SNAPSHOT_CONTRACT', TAG_CATALOG_SNAPSHOT_CONTRACT)
        if snapshot_contract is _UNSET_CONTRACT else snapshot_contract
    )

    if not protocols.is_contract(contract, 'paper-tag-catalog-snapshot'):
        raise err_cls('标签词表快照的格式版本不受支持。')
    registry = page_catalog if tag_catalog is None else tag_catalog
    if not isinstance(registry, dict):
        raise err_cls('生成标签词表快照的输入必须是对象。')
    registry_sha256 = registry.get('registrySha256')
    if not isinstance(registry_sha256, str) or not re.fullmatch(r'[0-9a-f]{64}', registry_sha256):
        raise err_cls('标签词表快照缺少有效的 registrySha256。')
    registry_version = identity_fn(registry)
    if not isinstance(registry_version, str) or not registry_version:
        raise err_cls('标签词表快照缺少有效的版本名称。')
    concepts = registry.get('concepts')
    if not isinstance(concepts, list) or not concepts:
        raise err_cls('标签词表快照缺少非空的概念列表。')
    records = {}
    ordered = []
    for concept in concepts:
        if not isinstance(concept, dict):
            raise err_cls('标签词表快照中的每个概念都必须是对象。')
        concept_id = concept.get('id')
        preferred = concept.get('preferredLabel')
        aliases = concept.get('aliases')
        if (not isinstance(concept_id, str) or not concept_id or concept_id in records
                or not isinstance(concept.get('facet'), str) or not concept.get('facet')
                or not isinstance(preferred, dict)
                or not isinstance(preferred.get('zh'), str) or not preferred.get('zh')
                or not isinstance(preferred.get('en'), str) or not preferred.get('en')
                or not isinstance(aliases, list)
                or any(not isinstance(alias, str) or not alias for alias in aliases)):
            raise err_cls(
                f'标签词表快照中的概念无效：{concept_id!r}'
            )
        record = {
            'id': concept_id,
            'facet': concept['facet'],
            'zh': preferred['zh'],
            'en': preferred['en'],
            'aliases': list(aliases),
            'ancestorIds': [],
        }
        for field in ('definition', 'scopeNote', 'status'):
            value = concept.get(field)
            if value is not None:
                if not isinstance(value, str) or not value:
                    raise err_cls(f'标签概念 {concept_id} 的 {field} 必须是非空字符串。')
                record[field] = value
        records[concept_id] = (record, concept)
        ordered.append(record)
    for record, concept in records.values():
        chain = []
        seen = {concept['id']}
        parent_id = concept.get('broaderId')
        while parent_id is not None:
            parent = records.get(parent_id)
            if parent is None or parent_id in seen:
                raise err_cls(
                    f'标签概念 {concept["id"]} 的上级概念缺失，或上级关系存在循环。'
                )
            seen.add(parent_id)
            chain.append(parent_id)
            parent_id = parent[1].get('broaderId')
        record['ancestorIds'] = list(reversed(chain))
    return {
        **protocols.record_header(contract, 'paper-tag-catalog-snapshot'),
        'registryVersion': registry_version,
        'registrySha256': registry_sha256,
        'concepts': ordered,
    }


def tag_catalog_snapshot_bytes(snapshot, *, hooks: Mapping | None = None) -> bytes:
    """按固定 JSON 格式生成不含时间戳的字节；相同快照会生成相同文件。"""
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    if not isinstance(snapshot, dict):
        raise err_cls('标签词表快照必须是对象。')
    return (
        json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        + '\n'
    ).encode('utf-8')


def validate_tag_catalog_snapshot(snapshot, *, hooks: Mapping | None = None):
    """核验已保存词表快照的格式和上级关系，不补造缺失的上级概念。"""
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    protocols = _hook(hooks, 'public_protocols', public_protocols)
    if (not isinstance(snapshot, dict)
            or not protocols.has_valid_header(snapshot, 'paper-tag-catalog-snapshot')
            or not re.fullmatch(r'[0-9a-f]{64}', str(snapshot.get('registrySha256') or ''))
            or not isinstance(snapshot.get('registryVersion'), str)
            or not snapshot['registryVersion']
            or not isinstance(snapshot.get('concepts'), list) or not snapshot['concepts']):
        raise err_cls('保存的标签词表快照格式无效，或缺少协议、版本、SHA 或概念列表。')
    by_id = {}
    facets = {'task', 'method', 'setting', 'signal', 'application', 'research_focus',
              'artifact', 'scientific_topic', 'model_family'}
    for node in snapshot['concepts']:
        if not isinstance(node, dict):
            raise err_cls('保存的标签词表快照中的每个概念都必须是对象。')
        concept_id = node.get('id')
        facet = node.get('facet')
        if (not isinstance(concept_id, str)
                or not re.fullmatch(r'[a-z][a-z0-9_]*\.[a-z0-9][a-z0-9.-]*', concept_id)
                or concept_id in by_id or facet not in facets
                or not concept_id.startswith(f'{facet}.')
                or not isinstance(node.get('zh'), str) or not node['zh']
                or not isinstance(node.get('en'), str) or not node['en']
                or not isinstance(node.get('aliases'), list)
                or any(not isinstance(value, str) or not value for value in node['aliases'])
                or not isinstance(node.get('ancestorIds'), list)
                or any(not isinstance(value, str) or not value for value in node['ancestorIds'])
                or node.get('status', 'active') not in {'active', 'deprecated'}):
            raise err_cls(f'保存的标签词表快照中存在无效概念：{concept_id!r}')
        for field in ('definition', 'scopeNote'):
            if field in node and (not isinstance(node[field], str) or not node[field]):
                raise err_cls(f'保存的标签概念中，{field} 必须是非空字符串。')
        by_id[concept_id] = node
    for node in by_id.values():
        chain = node['ancestorIds']
        if len(set(chain)) != len(chain) or node['id'] in chain:
            raise err_cls('保存的标签概念的上级列表存在重复，或包含概念自身。')
        for position, ancestor in enumerate(chain):
            parent = by_id.get(ancestor)
            if (parent is None or parent['facet'] != node['facet']
                    or parent['ancestorIds'] != chain[:position]
                    or parent.get('status', 'active') != 'active'):
                raise err_cls('保存的标签概念的上级列表包含缺失、跨分类或停用的概念，或与上级概念记录的顺序不一致。')
    return snapshot


def validate_tag_version_catalog(catalog, *, hooks: Mapping | None = None):
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    protocols = _hook(hooks, 'public_protocols', public_protocols)
    validate_snapshot_fn = _hook(
        hooks, '_validate_tag_catalog_snapshot',
        lambda snap: validate_tag_catalog_snapshot(snap, hooks=hooks),
    )
    if (not isinstance(catalog, dict)
            or not protocols.has_valid_header(catalog, 'paper-tag-catalog-versions')
            or not isinstance(catalog.get('snapshots'), list) or not catalog['snapshots']
            or not re.fullmatch(r'[a-f0-9]{64}', str(catalog.get('currentSha256') or ''))):
        raise err_cls('标签词表版本目录格式无效，或缺少协议、快照列表或当前版本 SHA。')
    versions = {}
    for snapshot in catalog['snapshots']:
        validate_snapshot_fn(snapshot)
        sha = snapshot['registrySha256']
        if sha in versions:
            raise err_cls('标签词表版本目录中存在重复的 SHA。')
        versions[sha] = snapshot
    if catalog['currentSha256'] not in versions:
        raise err_cls('标签词表版本目录中未保存当前版本的快照。')
    return versions


def validate_tag_display_policy(policy, *, hooks: Mapping | None = None):
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    protocols = _hook(hooks, 'public_protocols', public_protocols)
    fields = {'baseRegistrySha256', 'baseSnapshotSha256',
              'preferredRegistrySha256', 'preferredSnapshotSha256',
              'preferredProjectionSha256'}
    if (not isinstance(policy, dict)
            or not protocols.has_valid_header(policy, 'paper-tag-presentation-policy')
            or set(policy) != fields | set(
                protocols.record_header(
                    policy['contract'], 'paper-tag-presentation-policy', policy.get('schemaFingerprint'),
                )
            )
            or any(not isinstance(policy[key], str)
                   or not re.fullmatch(r'[a-f0-9]{64}', policy[key])
                   for key in fields - {'contract'})
            or policy['baseRegistrySha256'] == policy['preferredRegistrySha256']):
        raise err_cls('标签展示策略的字段、协议或 SHA 格式无效，或选用版本与基础版本相同。')
    return policy


def historical_tag_prompt_text_sha256(snapshot) -> str:
    # 历史提示文本按固定的九个分类维度排序，概念 ID 使用 ASCII 字符。
    # 重新生成的完整字节必须与明确批准的 SHA 一致；
    # 未知的排序或文本格式不能用于选择展示版本。
    facets = ['task', 'method', 'setting', 'signal', 'application', 'research_focus',
              'artifact', 'scientific_topic', 'model_family']

    def compact(value):
        return re.sub(r'\s+', ' ', re.sub(r'[\r\n|]+', ' ', value or '')).strip()

    lines = ['contract=paper-taxonomy-prompt-projection-v1',
             f'registry_version={snapshot["registryVersion"]}',
             f'registry_sha256={snapshot["registrySha256"]}',
             '只允许输出下列 active 概念的中文首选标签；ID 用于消歧，不得自造标签或输出同义词。']
    current_facet = None
    nodes = [node for node in snapshot['concepts'] if node.get('status') == 'active']
    for node in sorted(nodes, key=lambda item: (facets.index(item['facet']), item['id'])):
        if node['facet'] != current_facet:
            current_facet = node['facet']
            lines.append(f'[{current_facet}]')
        lines.append('|'.join([node['id'], '#' + node['zh'],
                               compact(node.get('definition')), compact(node.get('scopeNote'))]))
    raw = ('historical-taxonomy-prompt-projection-v2\n' + '\n'.join(lines) + '\n').encode('utf-8')
    return hashlib.sha256(raw).hexdigest()


def select_tag_display_version(
    repo, current, versions, *, legacy=False, approved_raw=None, hooks: Mapping | None = None,
):
    """按明确的展示策略选择词表版本，不改变单篇论文当时保存的记录。"""
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    protocols = _hook(hooks, 'public_protocols', public_protocols)
    validate_policy_fn = _hook(
        hooks, '_validate_tag_display_policy',
        lambda pol: validate_tag_display_policy(pol, hooks=hooks),
    )
    snapshot_bytes_fn = _hook(
        hooks, 'tag_catalog_snapshot_bytes',
        lambda snap: tag_catalog_snapshot_bytes(snap, hooks=hooks),
    )
    prompt_sha_fn = _hook(
        hooks, '_historical_tag_prompt_text_sha256', historical_tag_prompt_text_sha256,
    )
    snapshot_body_fn = _hook(
        hooks, '_tag_snapshot_body',
        lambda snap: tag_snapshot_body(snap, hooks=hooks),
    )
    read_file_fn = _hook(
        hooks, '_read_tag_catalog_file',
        lambda r, rel: read_tag_catalog_file(r, rel, hooks=hooks),
    )
    validate_versions_fn = _hook(
        hooks, '_validate_tag_version_catalog',
        lambda cat: validate_tag_version_catalog(cat, hooks=hooks),
    )

    filename = 'taxonomy-presentation-policy.json' if legacy else 'tag-presentation-policy.json'
    relatives = [f'data/{filename}', f'static/data/{filename}']

    def read_regular(relative):
        target = repo / relative
        # 即使是悬空链接、以及指向仓库内其他位置的链接，也要拒绝。
        for item in [target, *target.parents]:
            if item == repo:
                break
            if item.is_symlink():
                raise err_cls('标签展示策略或快照的路径及其父目录不得是符号链接。')
        if not target.exists():
            return None
        if not target.is_file() or target.stat().st_nlink != 1:
            raise err_cls('标签展示策略和快照必须是普通文件，且只能有一个硬链接。')
        return target.read_bytes()

    raw_mirrors = [read_regular(relative) for relative in relatives]
    if raw_mirrors == [None, None]:
        if approved_raw is None:
            return current, {}
        raw_mirrors = [approved_raw, approved_raw]
    elif approved_raw is not None and raw_mirrors != [approved_raw, approved_raw]:
        raise err_cls('已保存的标签展示策略与本次批准的策略字节不一致。')
    if raw_mirrors[0] is None or raw_mirrors[0] != raw_mirrors[1]:
        raise err_cls('标签展示策略只缺少一份副本，或 data 与 static/data 中的文件内容不完全一致。')

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise err_cls('标签展示策略的 JSON 中存在重复键。')
            result[key] = value
        return result

    try:
        policy = validate_policy_fn(
            json.loads(raw_mirrors[0].decode('utf-8'), object_pairs_hook=unique_object))
    except (ValueError, UnicodeError) as exc:
        raise err_cls('标签展示策略文件无法按 UTF-8 JSON 读取，或其中的策略内容未通过校验。') from exc
    expected_format = 'legacy-display-catalog' if legacy else 'approved-display-catalog'
    if protocols.format(
        policy['contract'], 'paper-tag-presentation-policy', policy.get('schemaFingerprint'),
    ) != expected_format:
        raise err_cls('标签展示策略的文件路径与格式版本不一致。')
    base_sha = policy['baseRegistrySha256']
    preferred_sha = policy['preferredRegistrySha256']
    issued_base = versions.get(base_sha)
    if (issued_base is None
            or hashlib.sha256(snapshot_bytes_fn(issued_base)).hexdigest()
            != policy['baseSnapshotSha256']):
        raise err_cls('标签展示策略记录的基础词表 SHA 或快照 SHA 与实际签发来源不一致。')
    preferred = versions.get(preferred_sha)
    if preferred is None:
        raise err_cls('标签展示策略选用的版本没有保存对应的词表快照。')
    raw = snapshot_bytes_fn(preferred)
    if (hashlib.sha256(raw).hexdigest() != policy['preferredSnapshotSha256']
            or prompt_sha_fn(preferred) != policy['preferredProjectionSha256']):
        raise err_cls('标签展示策略记录的快照 SHA 或提示文本 SHA 与重新计算的结果不一致。')
    if preferred['concepts'][:len(issued_base['concepts'])] != issued_base['concepts']:
        raise err_cls('标签展示策略选用的词表修改了已有概念，或改变了它们的顺序；只允许在原列表末尾追加概念。')
    historical_base = current['registrySha256'] != base_sha
    if not historical_base:
        if current != issued_base:
            raise err_cls('当前基础词表与策略签发时的同 SHA 快照不一致。')
    else:
        identity_base = preferred if len(current['concepts']) == len(preferred['concepts']) else issued_base
        current_body = snapshot_body_fn(current)
        original_body = snapshot_body_fn(issued_base)
        original_version = original_body['registryVersion']
        version_matches = (
            current_body['registryVersion'] == original_version
            or current_body['registryVersion'] == protocols.contract('paper-tag-catalog')
            and protocols.is_contract(original_version, 'paper-tag-catalog', 'nine-facet-concept-registry')
        )
        if (set(current_body) != set(original_body) or not version_matches
                or any(current_body[key] != original_body[key] for key in current_body
                       if key not in {'registrySha256', 'registryVersion', 'concepts'})
                or len(current['concepts']) != len(identity_base['concepts'])
                or any(set(actual) != set(original)
                       or any(actual[key] != original[key] for key in actual
                              if key not in {'definition', 'scopeNote'})
                       for actual, original in zip(current['concepts'], identity_base['concepts']))):
            raise err_cls('当前分类词表与展示策略签发基础的概念身份不一致；只允许定义和范围说明的值不同。')
    archive_name = 'taxonomy-snapshots'
    if not legacy and any((repo / prefix / 'tag-catalog-history').exists()
                          or (repo / prefix / 'tag-catalog-history').is_symlink()
                          for prefix in ('data', 'static/data')):
        archive_name = 'tag-catalog-history'
    required_snapshots = [issued_base, preferred] if historical_base else [preferred]
    for prefix in ('data', 'static/data'):
        for snapshot in required_snapshots:
            if read_regular(f'{prefix}/{archive_name}/{snapshot["registrySha256"]}.json') != snapshot_bytes_fn(snapshot):
                raise err_cls('标签展示策略签发基础或选用版本的归档副本缺失，或文件内容与对应快照不完全一致。')
        catalog_name = 'taxonomy-catalog.json' if legacy else 'tag-catalog-versions.json'
        catalog = read_file_fn(repo, f'{prefix}/{catalog_name}')
        if not legacy and catalog is None:
            catalog = read_file_fn(repo, f'{prefix}/taxonomy-catalog.json')
        saved_versions = validate_versions_fn(catalog) if catalog is not None else {}
        if any(saved_versions.get(snapshot['registrySha256']) != snapshot for snapshot in required_snapshots):
            raise err_cls('标签展示策略签发基础或选用版本未在对应版本目录中保存，或目录中的快照内容不一致。')
    return preferred, dict(zip(relatives, raw_mirrors))


def is_tag_catalog_file_path(relative) -> bool:
    parts = Path(relative).parts
    if Path(relative).is_absolute() or '..' in parts or '\\' in str(relative):
        return False
    if Path(relative).as_posix() in {
            'data/taxonomy-registry.json', 'static/data/taxonomy-registry.json',
            'data/taxonomy-catalog.json', 'static/data/taxonomy-catalog.json',
            'data/taxonomy-presentation-policy.json',
            'static/data/taxonomy-presentation-policy.json',
            'data/tag-catalog-snapshot.json', 'static/data/tag-catalog-snapshot.json',
            'data/tag-catalog-versions.json', 'static/data/tag-catalog-versions.json',
            'data/tag-presentation-policy.json', 'static/data/tag-presentation-policy.json'}:
        return True
    archive_names = {'taxonomy-snapshots', 'tag-catalog-history'}
    return bool((len(parts) == 3 and parts[0] == 'data' and parts[1] in archive_names
                 or len(parts) == 4 and parts[:2] == ('static', 'data') and parts[2] in archive_names)
                and re.fullmatch(r'[a-f0-9]{64}\.json', parts[-1]))


def read_tag_catalog_file(repo, relative, *, hooks: Mapping | None = None):
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    target = repo / relative
    try:
        target.resolve().relative_to(repo)
    except ValueError as exc:
        raise err_cls('标签词表文件的路径超出了博客仓库。') from exc
    for parent in [target, *target.parents]:
        if parent == repo:
            break
        if parent.is_symlink():
            raise err_cls('标签词表文件不得是符号链接。')
    if not target.exists():
        return None
    if not target.is_file():
        raise err_cls('标签词表文件必须是普通文件。')
    try:
        return json.loads(target.read_text(encoding='utf-8'))
    except (ValueError, UnicodeError) as exc:
        raise err_cls('标签词表文件不是有效的 UTF-8 JSON。') from exc


def tag_snapshot_body(snapshot, *, hooks: Mapping | None = None) -> dict:
    protocols = _hook(hooks, 'public_protocols', public_protocols)
    validate_snapshot_fn = _hook(
        hooks, '_validate_tag_catalog_snapshot',
        lambda snap: validate_tag_catalog_snapshot(snap, hooks=hooks),
    )
    validate_snapshot_fn(snapshot)
    header = protocols.record_header(
        snapshot['contract'], 'paper-tag-catalog-snapshot', snapshot.get('schemaFingerprint'),
    )
    return {key: value for key, value in snapshot.items() if key not in header}


def build_tag_catalog_display_snapshot(
    issued_snapshot, *, target_header=None, hooks: Mapping | None = None,
) -> dict:
    """建立单独的显示副本，不用它替换当时保存的快照。"""
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    protocols = _hook(hooks, 'public_protocols', public_protocols)
    validate_snapshot_fn = _hook(
        hooks, '_validate_tag_catalog_snapshot',
        lambda snap: validate_tag_catalog_snapshot(snap, hooks=hooks),
    )
    snapshot_body_fn = _hook(
        hooks, '_tag_snapshot_body',
        lambda snap: tag_snapshot_body(snap, hooks=hooks),
    )
    snap_contract = _hook(hooks, 'TAG_CATALOG_SNAPSHOT_CONTRACT', TAG_CATALOG_SNAPSHOT_CONTRACT)
    validate_snapshot_fn(issued_snapshot)
    header = (
        protocols.record_header(snap_contract, 'paper-tag-catalog-snapshot')
        if target_header is None else target_header
    )
    if not protocols.has_valid_header(header, 'paper-tag-catalog-snapshot'):
        raise err_cls('显示快照的目标格式声明无效。')
    return {**snapshot_body_fn(issued_snapshot), **header}


def read_approved_tag_display_policy(*, hooks: Mapping | None = None):
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    protocols = _hook(hooks, 'public_protocols', public_protocols)
    validate_policy_fn = _hook(
        hooks, '_validate_tag_display_policy',
        lambda pol: validate_tag_display_policy(pol, hooks=hooks),
    )
    policy_path_val = _hook(hooks, 'TAG_DISPLAY_POLICY_PATH', TAG_DISPLAY_POLICY_PATH)
    proj_root = hooks.get('PROJECT_ROOT') if hooks is not None else PROJECT_ROOT

    path = Path(policy_path_val).expanduser()
    if proj_root is not None:
        proj_abs = Path(os.path.abspath(os.fspath(Path(proj_root).expanduser())))
        path_abs = Path(os.path.abspath(os.fspath(path)))
        try:
            rel_parts = path_abs.parent.relative_to(proj_abs).parts
        except ValueError:
            rel_parts = None
        if rel_parts is not None:
            try:
                root_st = os.lstat(proj_abs)
            except OSError as exc:
                raise err_cls('批准的标签展示策略父目录无法安全读取。') from exc
            if stat.S_ISLNK(root_st.st_mode) or not stat.S_ISDIR(root_st.st_mode):
                raise err_cls('批准的标签展示策略不得是符号链接。')
            root_real = Path(os.path.realpath(proj_abs))
            cur = proj_abs
            for idx, part in enumerate(rel_parts):
                cur = cur / part
                try:
                    dir_st = os.lstat(cur)
                except FileNotFoundError:
                    return None
                except OSError as exc:
                    raise err_cls('批准的标签展示策略父目录无法安全读取。') from exc
                if stat.S_ISLNK(dir_st.st_mode) or not stat.S_ISDIR(dir_st.st_mode):
                    raise err_cls('批准的标签展示策略不得是符号链接。')
                if Path(os.path.realpath(cur)) != root_real.joinpath(*rel_parts[:idx + 1]):
                    raise err_cls('批准的标签展示策略不得是符号链接。')
    try:
        parent_st = os.lstat(path.parent)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise err_cls('批准的标签展示策略父目录无法安全读取。') from exc
    if stat.S_ISLNK(parent_st.st_mode) or not stat.S_ISDIR(parent_st.st_mode):
        raise err_cls('批准的标签展示策略不得是符号链接。')
    try:
        st_before = os.lstat(path)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise err_cls('批准的标签展示策略内容无法读取或未通过校验。') from exc
    if stat.S_ISLNK(st_before.st_mode):
        raise err_cls('批准的标签展示策略不得是符号链接。')
    if not stat.S_ISREG(st_before.st_mode) or (os.name != 'nt' and st_before.st_nlink != 1):
        raise err_cls('批准的标签展示策略必须是只有一个硬链接的普通文件。')
    if st_before.st_size > 2 * 1024 * 1024:
        raise err_cls('批准的标签展示策略内容无法读取或未通过校验。')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise err_cls('批准的标签展示策略不得是符号链接。') from exc
    try:
        st_open = os.fstat(fd)
        sig_before = (
            st_before.st_dev, st_before.st_ino, st_before.st_size,
            st_before.st_mtime_ns, st_before.st_ctime_ns, int(st_before.st_nlink),
        )
        sig_open = (
            st_open.st_dev, st_open.st_ino, st_open.st_size,
            st_open.st_mtime_ns, st_open.st_ctime_ns, int(st_open.st_nlink),
        )
        if (not stat.S_ISREG(st_open.st_mode)
                or (os.name != 'nt' and st_open.st_nlink != 1)
                or sig_open != sig_before):
            raise err_cls('批准的标签展示策略必须是只有一个硬链接的普通文件。')
        chunks = []
        remaining = st_open.st_size + 1
        while remaining > 0:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b''.join(chunks)
        st_after = os.fstat(fd)
    finally:
        os.close(fd)
    try:
        st_post = os.lstat(path)
    except OSError as exc:
        raise err_cls('批准的标签展示策略内容无法读取或未通过校验。') from exc
    sig_after = (
        st_after.st_dev, st_after.st_ino, st_after.st_size,
        st_after.st_mtime_ns, st_after.st_ctime_ns, int(st_after.st_nlink),
    )
    sig_post = (
        st_post.st_dev, st_post.st_ino, st_post.st_size,
        st_post.st_mtime_ns, st_post.st_ctime_ns, int(st_post.st_nlink),
    )
    if len(raw) != st_after.st_size or sig_after != sig_before or sig_post != sig_before:
        raise err_cls('批准的标签展示策略内容无法读取或未通过校验。')

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise err_cls('标签展示策略的 JSON 中存在重复键。')
            result[key] = value
        return result

    try:
        policy = validate_policy_fn(json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object))
    except (ValueError, UnicodeError) as exc:
        raise err_cls('批准的标签展示策略内容无法读取或未通过校验。') from exc
    if protocols.format(
        policy['contract'], 'paper-tag-presentation-policy', policy.get('schemaFingerprint'),
    ) != 'approved-display-catalog':
        raise err_cls('批准的标签展示策略的格式版本不受支持。')
    return raw


def file_stat_signature(st) -> tuple:
    return (
        st.st_dev,
        st.st_ino,
        st.st_size,
        st.st_mtime_ns,
        st.st_ctime_ns,
        int(st.st_nlink),
    )


def verify_intermediate_dirs_nofollow(root_dir, target_dir) -> bool:
    """对从 root_dir 到 target_dir 的每一级中间目录显式执行 os.lstat 与 realpath 包含核验。"""
    root_abs = Path(os.path.abspath(os.fspath(Path(root_dir).expanduser())))
    target_abs = Path(os.path.abspath(os.fspath(Path(target_dir).expanduser())))
    try:
        rel_parts = target_abs.relative_to(root_abs).parts
    except ValueError:
        return False
    if any(part in ('', '.', '..') for part in rel_parts):
        return False
    try:
        st_root = os.lstat(root_abs)
    except OSError:
        return False
    if stat.S_ISLNK(st_root.st_mode) or not stat.S_ISDIR(st_root.st_mode):
        return False
    root_real = Path(os.path.realpath(root_abs))
    cur = root_abs
    for idx, part in enumerate(rel_parts):
        cur = cur / part
        try:
            st_dir = os.lstat(cur)
        except FileNotFoundError:
            return True
        except OSError:
            return False
        if stat.S_ISLNK(st_dir.st_mode) or not stat.S_ISDIR(st_dir.st_mode):
            return False
        cur_real = Path(os.path.realpath(cur))
        try:
            cur_real.relative_to(root_real)
        except ValueError:
            return False
        if cur_real != root_real.joinpath(*rel_parts[:idx + 1]):
            return False
    return True


def verify_config_target_dirs_nofollow(
    target_path, *, target_is_dir=False, hooks: Mapping | None = None,
):
    proj_root_val = _hook(hooks, 'PROJECT_ROOT', PROJECT_ROOT)
    verify_inter_fn = _hook(
        hooks, '_verify_intermediate_dirs_nofollow', verify_intermediate_dirs_nofollow,
    )
    target_expanded = Path(target_path).expanduser()
    proj_root = Path(proj_root_val).expanduser().resolve()
    proj_abs = Path(os.path.abspath(os.fspath(proj_root)))
    check_dir = target_expanded if target_is_dir else target_expanded.parent
    check_abs = Path(os.path.abspath(os.fspath(check_dir)))
    try:
        check_abs.relative_to(proj_abs)
        under_proj = True
    except ValueError:
        under_proj = False
    if under_proj:
        return verify_inter_fn(proj_root, check_dir), proj_root
    try:
        st_parent = os.lstat(target_expanded.parent)
    except FileNotFoundError:
        return (True, target_expanded.parent) if target_is_dir else (False, target_expanded.parent)
    except OSError:
        return False, target_expanded.parent
    if stat.S_ISLNK(st_parent.st_mode) or not stat.S_ISDIR(st_parent.st_mode):
        return False, target_expanded.parent
    parent_real = Path(os.path.realpath(target_expanded.parent))
    if target_is_dir:
        try:
            st_self = os.lstat(target_expanded)
        except FileNotFoundError:
            return True, parent_real
        except OSError:
            return False, parent_real
        if stat.S_ISLNK(st_self.st_mode) or not stat.S_ISDIR(st_self.st_mode):
            return False, parent_real
        if Path(os.path.realpath(target_expanded)) != parent_real / target_expanded.name:
            return False, parent_real
        return True, Path(os.path.realpath(target_expanded))
    return True, parent_real


def read_nofollow_regular_sha256(
    target, stop_dir, *, max_bytes=8 * 1024 * 1024, hooks: Mapping | None = None,
):
    """三段 O_NOFOLLOW + 打开前后 lstat/fstat 全签名核验读取，防符号链接、硬链接与 os.replace TOCTOU。"""
    verify_inter_fn = _hook(
        hooks, '_verify_intermediate_dirs_nofollow', verify_intermediate_dirs_nofollow,
    )
    stat_sig_fn = _hook(hooks, '_file_stat_signature', file_stat_signature)
    target = Path(target).expanduser()
    if stop_dir is not None:
        if not verify_inter_fn(stop_dir, target.parent):
            return None
        stop_real = Path(os.path.realpath(Path(stop_dir).expanduser()))
    else:
        stop_real = None
    try:
        st_before = os.lstat(target)
    except FileNotFoundError:
        return ('ABSENT', None, None)
    except OSError:
        return None
    if stat.S_ISLNK(st_before.st_mode) or not stat.S_ISREG(st_before.st_mode):
        return None
    if (os.name != 'nt' and st_before.st_nlink != 1) or st_before.st_size < 0 or st_before.st_size > max_bytes:
        return None
    if stop_real is not None:
        try:
            Path(os.path.realpath(target)).relative_to(stop_real)
        except ValueError:
            return None
    sig_before = stat_sig_fn(st_before)
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    try:
        fd = os.open(target, flags)
    except OSError:
        return None
    try:
        st_open = os.fstat(fd)
        if (not stat.S_ISREG(st_open.st_mode)
                or (os.name != 'nt' and st_open.st_nlink != 1)
                or stat_sig_fn(st_open) != sig_before):
            return None
        chunks = []
        remaining = st_open.st_size + 1
        while remaining > 0:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b''.join(chunks)
        st_after = os.fstat(fd)
    except OSError:
        return None
    finally:
        os.close(fd)
    try:
        st_post = os.lstat(target)
    except OSError:
        return None
    if (len(raw) != st_after.st_size
            or stat_sig_fn(st_after) != sig_before
            or stat_sig_fn(st_post) != sig_before):
        return None
    return ('FILE', hashlib.sha256(raw).hexdigest(), raw)


def probe_tag_catalog_serialization_key(repo, approved_raw, *, hooks: Mapping | None = None):
    """每次真实 O_NOFOLLOW 读取磁盘词表、历史归档与博客仓库副本的完整原始字节 SHA。"""
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    protocols = _hook(hooks, 'public_protocols', public_protocols)
    page_catalog = _hook(hooks, '_PAGE_TAG_CATALOG', _PAGE_TAG_CATALOG)
    init_sha = _hook(hooks, '_INITIAL_PAGE_TAG_CATALOG_SHA256', _INITIAL_PAGE_TAG_CATALOG_SHA256)
    init_mem_sha = _hook(hooks, '_INITIAL_PAGE_TAG_CATALOG_MEM_SHA256', _INITIAL_PAGE_TAG_CATALOG_MEM_SHA256)
    catalog_path_val = _hook(hooks, 'TAG_CATALOG_PATH', TAG_CATALOG_PATH)
    history_dir_val = _hook(hooks, 'TAG_CATALOG_HISTORY_DIR', TAG_CATALOG_HISTORY_DIR)
    policy_path_val = _hook(hooks, 'TAG_DISPLAY_POLICY_PATH', TAG_DISPLAY_POLICY_PATH)
    parse_catalog_bytes_fn = _hook(hooks, '_parse_tag_catalog_bytes', _parse_tag_catalog_bytes)
    verify_cfg_fn = _hook(
        hooks, '_verify_config_target_dirs_nofollow',
        lambda p, *, target_is_dir=False: verify_config_target_dirs_nofollow(
            p, target_is_dir=target_is_dir, hooks=hooks,
        ),
    )
    verify_inter_fn = _hook(
        hooks, '_verify_intermediate_dirs_nofollow', verify_intermediate_dirs_nofollow,
    )
    read_nofollow_fn = _hook(
        hooks, '_read_nofollow_regular_sha256',
        lambda t, sd, *, max_bytes=8 * 1024 * 1024: read_nofollow_regular_sha256(
            t, sd, max_bytes=max_bytes, hooks=hooks,
        ),
    )

    mem_sha = hashlib.sha256(
        json.dumps(page_catalog, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    ).hexdigest()
    catalog_path = Path(catalog_path_val).expanduser()
    cat_dirs_ok, cat_root = verify_cfg_fn(catalog_path, target_is_dir=False)
    catalog_probe = (
        read_nofollow_fn(catalog_path, cat_root, max_bytes=2 * 1024 * 1024)
        if cat_dirs_ok else None
    )
    if mem_sha == init_mem_sha:
        if catalog_probe is None or catalog_probe[0] != 'FILE':
            if cat_dirs_ok:
                try:
                    st_cat = os.lstat(catalog_path)
                except OSError:
                    st_cat = None
                if (st_cat is not None and not stat.S_ISLNK(st_cat.st_mode)
                        and stat.S_ISREG(st_cat.st_mode) and os.name != 'nt' and st_cat.st_nlink != 1):
                    raise err_cls('当前标签词表文件必须是只有一个硬链接的普通文件。')
            raise err_cls('当前标签词表文件无法安全读取或包含符号链接。')
        _, catalog_sha, catalog_raw = catalog_probe
        if catalog_sha != init_sha:
            try:
                active_catalog = parse_catalog_bytes_fn(catalog_raw, uses_default_catalog=True)
            except (OSError, ValueError, UnicodeError) as exc:
                raise err_cls(f'当前标签词表文件未通过校验：{exc}') from exc
        else:
            active_catalog = page_catalog
        catalog_key = ('disk', catalog_sha)
    else:
        active_catalog = page_catalog
        catalog_key = (
            'memory', mem_sha,
            None if catalog_probe is None else (catalog_probe[0], catalog_probe[1]),
        )

    policy_dirs_ok, _ = verify_cfg_fn(
        Path(policy_path_val).expanduser(), target_is_dir=False,
    )
    if not policy_dirs_ok:
        return None, active_catalog
    if approved_raw is None:
        policy_key = ('ABSENT', None)
    elif isinstance(approved_raw, (bytes, bytearray)):
        policy_key = ('RAW', hashlib.sha256(bytes(approved_raw)).hexdigest())
    else:
        return None, active_catalog

    history_dir = Path(history_dir_val).expanduser()
    hist_dirs_ok, hist_root = verify_cfg_fn(history_dir, target_is_dir=True)
    if not hist_dirs_ok:
        return None, active_catalog
    history_entries = []
    try:
        st_hist = os.lstat(history_dir)
    except FileNotFoundError:
        st_hist = None
    except OSError:
        return None, active_catalog
    if st_hist is not None:
        if stat.S_ISLNK(st_hist.st_mode) or not stat.S_ISDIR(st_hist.st_mode):
            return None, active_catalog
        for child in sorted(history_dir.iterdir(), key=lambda item: item.name):
            if not re.fullmatch(r'[a-f0-9]{64}\.json', child.name):
                return None, active_catalog
            probe = read_nofollow_fn(child, hist_root, max_bytes=2 * 1024 * 1024)
            if probe is None or probe[0] != 'FILE':
                return None, active_catalog
            history_entries.append((child.name, probe[1]))

    for sub in (
        'data', 'data/taxonomy-snapshots', 'data/tag-catalog-history',
        'static', 'static/data', 'static/data/taxonomy-snapshots', 'static/data/tag-catalog-history',
    ):
        if not verify_inter_fn(repo, repo / sub):
            return None, active_catalog

    repo_files = []
    fixed_names = (
        'taxonomy-catalog.json', 'tag-catalog-versions.json',
        'taxonomy-registry.json', 'tag-catalog-snapshot.json',
        'taxonomy-presentation-policy.json', 'tag-presentation-policy.json',
    )
    for prefix in ('data', 'static/data'):
        for name in fixed_names:
            rel = f'{prefix}/{name}'
            probe = read_nofollow_fn(repo / rel, repo)
            if probe is None:
                return None, active_catalog
            repo_files.append((rel, probe[0], probe[1]))
        for archive_name in ('taxonomy-snapshots', 'tag-catalog-history'):
            archive_rel = f'{prefix}/{archive_name}'
            archive_dir = repo / archive_rel
            try:
                st_arch = os.lstat(archive_dir)
            except FileNotFoundError:
                repo_files.append((archive_rel, 'DIR_ABSENT', None))
                continue
            except OSError:
                return None, active_catalog
            if stat.S_ISLNK(st_arch.st_mode) or not stat.S_ISDIR(st_arch.st_mode):
                return None, active_catalog
            repo_files.append((archive_rel, 'DIR_PRESENT', None))
            for child in sorted(archive_dir.iterdir(), key=lambda item: item.name):
                if not re.fullmatch(r'[a-f0-9]{64}\.json', child.name):
                    return None, active_catalog
                child_rel = f'{archive_rel}/{child.name}'
                probe = read_nofollow_fn(child, repo)
                if probe is None or probe[0] != 'FILE':
                    return None, active_catalog
                repo_files.append((child_rel, 'FILE', probe[1]))

    snap_contract = _hook(hooks, 'TAG_CATALOG_SNAPSHOT_CONTRACT', TAG_CATALOG_SNAPSHOT_CONTRACT)
    site_snap_contract = _hook(hooks, 'SITE_TAG_CATALOG_SNAPSHOT_CONTRACT', SITE_TAG_CATALOG_SNAPSHOT_CONTRACT)
    legacy_snap_contract = _hook(hooks, 'LEGACY_TAG_CATALOG_SNAPSHOT_CONTRACT', LEGACY_TAG_CATALOG_SNAPSHOT_CONTRACT)
    vers_contract = _hook(hooks, 'TAG_CATALOG_VERSIONS_CONTRACT', TAG_CATALOG_VERSIONS_CONTRACT)
    site_vers_contract = _hook(hooks, 'SITE_TAG_CATALOG_VERSIONS_CONTRACT', SITE_TAG_CATALOG_VERSIONS_CONTRACT)
    legacy_vers_contract = _hook(hooks, 'LEGACY_TAG_CATALOG_VERSIONS_CONTRACT', LEGACY_TAG_CATALOG_VERSIONS_CONTRACT)
    pol_contract = _hook(hooks, 'TAG_PRESENTATION_POLICY_CONTRACT', TAG_PRESENTATION_POLICY_CONTRACT)
    legacy_pol_contract = _hook(hooks, 'LEGACY_TAG_PRESENTATION_POLICY_CONTRACT', LEGACY_TAG_PRESENTATION_POLICY_CONTRACT)

    key_payload = (
        str(repo),
        snap_contract,
        site_snap_contract,
        legacy_snap_contract,
        vers_contract,
        site_vers_contract,
        legacy_vers_contract,
        pol_contract,
        legacy_pol_contract,
        protocols.record_header(site_snap_contract, 'paper-tag-catalog-snapshot'),
        protocols.record_header(snap_contract, 'paper-tag-catalog-snapshot'),
        protocols.record_header(site_vers_contract, 'paper-tag-catalog-versions'),
        protocols.record_header(vers_contract, 'paper-tag-catalog-versions'),
        protocols.record_header(pol_contract, 'paper-tag-presentation-policy'),
        catalog_key,
        policy_key,
        tuple(history_entries),
        tuple(repo_files),
    )
    digest = hashlib.sha256(
        json.dumps(key_payload, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
    ).hexdigest()
    return digest, active_catalog


def tag_catalog_file_contents(blog_repo=None, *, hooks: Mapping | None = None) -> dict[str, bytes]:
    """准备新版显示文件和词表归档，保留原快照对象及旧文件的字节。"""
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    protocols = _hook(hooks, 'public_protocols', public_protocols)
    default_repo = _hook(hooks, 'BLOG_REPO', '.')
    repo = Path(default_repo if blog_repo is None else blog_repo).expanduser().resolve()

    if hooks is not None:
        cache = hooks.get('_TAG_CATALOG_SERIALIZATION_CACHE')
        cache_lock = hooks.get('_TAG_CATALOG_SERIALIZATION_CACHE_LOCK')
        max_entries = hooks.get('TAG_CATALOG_SERIALIZATION_CACHE_MAX', TAG_CATALOG_SERIALIZATION_CACHE_MAX)
        probe_fn = hooks.get('_probe_tag_catalog_serialization_key')
    else:
        cache = _TAG_CATALOG_SERIALIZATION_CACHE
        cache_lock = _TAG_CATALOG_SERIALIZATION_CACHE_LOCK
        max_entries = TAG_CATALOG_SERIALIZATION_CACHE_MAX
        probe_fn = lambda r, raw: probe_tag_catalog_serialization_key(r, raw, hooks=hooks)

    read_policy_fn = _hook(
        hooks, '_read_approved_tag_display_policy',
        lambda: read_approved_tag_display_policy(hooks=hooks),
    )
    build_snapshot_fn = _hook(
        hooks, 'build_tag_catalog_snapshot',
        lambda cat=None, *, snapshot_contract=_UNSET_CONTRACT: build_tag_catalog_snapshot(
            cat, snapshot_contract=snapshot_contract, hooks=hooks,
        ),
    )
    validate_snapshot_fn = _hook(
        hooks, '_validate_tag_catalog_snapshot',
        lambda snap: validate_tag_catalog_snapshot(snap, hooks=hooks),
    )
    read_file_fn = _hook(
        hooks, '_read_tag_catalog_file',
        lambda r, rel: read_tag_catalog_file(r, rel, hooks=hooks),
    )
    validate_versions_fn = _hook(
        hooks, '_validate_tag_version_catalog',
        lambda cat: validate_tag_version_catalog(cat, hooks=hooks),
    )
    build_display_fn = _hook(
        hooks, '_build_tag_catalog_display_snapshot',
        lambda snap, *, target_header=None: build_tag_catalog_display_snapshot(
            snap, target_header=target_header, hooks=hooks,
        ),
    )
    select_display_fn = _hook(
        hooks, '_select_tag_display_version',
        lambda r, cur, vers, *, legacy=False, approved_raw=None: select_tag_display_version(
            r, cur, vers, legacy=legacy, approved_raw=approved_raw, hooks=hooks,
        ),
    )
    snapshot_bytes_fn = _hook(
        hooks, 'tag_catalog_snapshot_bytes',
        lambda snap: tag_catalog_snapshot_bytes(snap, hooks=hooks),
    )
    site_snap_contract = _hook(hooks, 'SITE_TAG_CATALOG_SNAPSHOT_CONTRACT', SITE_TAG_CATALOG_SNAPSHOT_CONTRACT)
    legacy_snap_contract = _hook(hooks, 'LEGACY_TAG_CATALOG_SNAPSHOT_CONTRACT', LEGACY_TAG_CATALOG_SNAPSHOT_CONTRACT)
    site_vers_contract = _hook(hooks, 'SITE_TAG_CATALOG_VERSIONS_CONTRACT', SITE_TAG_CATALOG_VERSIONS_CONTRACT)

    cache_key = None
    active_catalog = None
    approved_raw_preloaded = False
    approved_raw = None
    if cache is not None and cache_lock is not None and callable(probe_fn):
        approved_raw = read_policy_fn()
        approved_raw_preloaded = True
        cache_key, active_catalog = probe_fn(repo, approved_raw)
        if not isinstance(max_entries, int) or max_entries <= 0:
            with cache_lock:
                cache.clear()
        elif cache_key is not None:
            with cache_lock:
                cached = cache.get(cache_key)
                if cached is not None:
                    cache.move_to_end(cache_key)
                    return {relative: bytes(raw) for relative, raw in cached.items()}
    current = validate_snapshot_fn(
        build_snapshot_fn(
            active_catalog, snapshot_contract=site_snap_contract,
        ) if active_catalog is not None else build_snapshot_fn(
            snapshot_contract=site_snap_contract,
        )
    )
    versions = {}
    archive_bytes = {}
    new_archive_paths = [repo / prefix / 'tag-catalog-history'
                         for prefix in ('data', 'static/data')]
    new_archive_presence = [path.exists() or path.is_symlink() for path in new_archive_paths]
    if any(new_archive_presence) and not all(new_archive_presence):
        raise err_cls('新版标签词表归档缺少对应的目录副本。')

    def retain(snapshot):
        validate_snapshot_fn(snapshot)
        sha = snapshot['registrySha256']
        if sha in versions and versions[sha] != snapshot:
            raise err_cls(f'标签词表的同一个 SHA 对应了不同的快照内容：{sha}')
        versions[sha] = snapshot

    new_names = ('tag-catalog-snapshot.json', 'tag-catalog-versions.json')
    new_presence = [((repo / prefix / name).exists() or (repo / prefix / name).is_symlink())
                    for prefix in ('data', 'static/data') for name in new_names]
    if any(new_presence) and not all(new_presence):
        raise err_cls('新版标签显示文件缺少快照、版本目录或对应副本。')
    catalogs_by_name = {}
    for name in ('taxonomy-catalog.json', 'tag-catalog-versions.json'):
        catalogs = []
        for prefix in ('data', 'static/data'):
            catalog = read_file_fn(repo, f'{prefix}/{name}')
            if catalog is not None:
                validate_versions_fn(catalog)
                expected = 'legacy-sha-keyed-snapshot-set' if name == 'taxonomy-catalog.json' else 'sha-keyed-snapshot-set'
                if protocols.format(
                    catalog.get('contract'), 'paper-tag-catalog-versions', catalog.get('schemaFingerprint'),
                ) != expected:
                    raise err_cls('标签词表版本目录的路径与格式版本不一致。')
                catalogs.append(catalog)
                for snapshot in catalog['snapshots']:
                    retain(snapshot)
        if len(catalogs) == 2 and catalogs[0] != catalogs[1]:
            raise err_cls('data 与 static/data 中的标签词表版本目录内容不一致。')
        catalogs_by_name[name] = catalogs
    for prefix in ('data', 'static/data'):
        old_display = read_file_fn(repo, f'{prefix}/taxonomy-registry.json')
        if old_display is not None:
            validate_snapshot_fn(old_display)
            if old_display.get('contract') != legacy_snap_contract:
                raise err_cls('旧标签显示文件的格式版本无效。')
            retain(old_display)
        for archive_name in ('taxonomy-snapshots', 'tag-catalog-history'):
            archive = repo / prefix / archive_name
            if archive.exists() or archive.is_symlink():
                if archive.is_symlink() or not archive.is_dir():
                    raise err_cls('标签词表归档路径必须是目录，且不得是符号链接。')
                for target in sorted(archive.iterdir()):
                    if not re.fullmatch(r'[a-f0-9]{64}\.json', target.name):
                        raise err_cls('标签词表归档目录中存在不符合 SHA 文件命名要求的文件。')
                    snapshot = read_file_fn(repo, target.relative_to(repo))
                    validate_snapshot_fn(snapshot)
                    if target.stem != snapshot['registrySha256']:
                        raise err_cls('标签词表归档文件名中的 SHA 与快照记录不一致。')
                    retain(snapshot)
                    if archive_name == 'tag-catalog-history':
                        archive_bytes[target.relative_to(repo).as_posix()] = target.read_bytes()
    for relative, raw in archive_bytes.items():
        sha_filename = Path(relative).name
        if any(archive_bytes.get(f'{prefix}/tag-catalog-history/{sha_filename}') != raw
               for prefix in ('data', 'static/data')):
            raise err_cls('新版标签词表归档缺少对应副本，或两个副本的字节不一致。')
    if any(new_presence):
        displays = [read_file_fn(repo, f'{prefix}/tag-catalog-snapshot.json')
                    for prefix in ('data', 'static/data')]
        if displays[0] != displays[1]:
            raise err_cls('新版标签显示快照的两个副本内容不一致。')
        for display in displays:
            validate_snapshot_fn(display)
            issued = versions.get(display['registrySha256'])
            if (protocols.format(
                    display['contract'], 'paper-tag-catalog-snapshot', display.get('schemaFingerprint'),
                ) != 'public-concept-hierarchy'
                    or issued is None
                    or display != build_display_fn(
                        issued,
                        target_header=protocols.record_header(
                            display['contract'], 'paper-tag-catalog-snapshot', display.get('schemaFingerprint'),
                        ),
                    )
                    or catalogs_by_name['tag-catalog-versions.json'][0]['currentSha256'] != display['registrySha256']):
                raise err_cls('新版标签显示快照与保存的原快照或版本目录不一致。')
    retain(current)
    display, policy_assets = select_display_fn(
        repo, current, versions,
        approved_raw=approved_raw if approved_raw_preloaded else read_policy_fn(),
    )
    catalog = {
        **protocols.record_header(site_vers_contract, 'paper-tag-catalog-versions'),
        'currentSha256': display['registrySha256'],
        'snapshots': [versions[sha] for sha in sorted(versions)],
    }
    display_header = protocols.record_header(
        site_snap_contract, 'paper-tag-catalog-snapshot',
    )
    assets = dict(policy_assets)
    for prefix in ('data', 'static/data'):
        assets[f'{prefix}/tag-catalog-snapshot.json'] = snapshot_bytes_fn(
            build_display_fn(display, target_header=display_header))
        assets[f'{prefix}/tag-catalog-versions.json'] = snapshot_bytes_fn(catalog)
        for sha, snapshot in sorted(versions.items()):
            relative = f'{prefix}/tag-catalog-history/{sha}.json'
            assets[relative] = archive_bytes.get(relative, snapshot_bytes_fn(snapshot))
    if cache is not None and cache_lock is not None and cache_key is not None:
        max_entries = (
            hooks.get('TAG_CATALOG_SERIALIZATION_CACHE_MAX', TAG_CATALOG_SERIALIZATION_CACHE_MAX)
            if hooks is not None else TAG_CATALOG_SERIALIZATION_CACHE_MAX
        )
        frozen_assets = {relative: bytes(raw) for relative, raw in assets.items()}
        with cache_lock:
            if not isinstance(max_entries, int) or max_entries <= 0:
                cache.clear()
                return frozen_assets
            cache[cache_key] = frozen_assets
            cache.move_to_end(cache_key)
            while len(cache) > max_entries:
                cache.popitem(last=False)
            return {relative: bytes(raw) for relative, raw in cache[cache_key].items()}
    return assets


def saved_tag_catalog_file_contents(
    repo, records, *, installation=False, hooks: Mapping | None = None,
) -> dict[str, bytes]:
    """先读取凭证绑定的完整原字节，再按原格式核对显示束。"""
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    protocols = _hook(hooks, 'public_protocols', public_protocols)
    is_tag_path_fn = _hook(hooks, '_is_tag_catalog_file_path', is_tag_catalog_file_path)
    validate_snapshot_fn = _hook(
        hooks, '_validate_tag_catalog_snapshot',
        lambda snap: validate_tag_catalog_snapshot(snap, hooks=hooks),
    )
    validate_versions_fn = _hook(
        hooks, '_validate_tag_version_catalog',
        lambda cat: validate_tag_version_catalog(cat, hooks=hooks),
    )
    build_display_fn = _hook(
        hooks, '_build_tag_catalog_display_snapshot',
        lambda snap, *, target_header=None: build_tag_catalog_display_snapshot(
            snap, target_header=target_header, hooks=hooks,
        ),
    )
    validate_policy_fn = _hook(
        hooks, '_validate_tag_display_policy',
        lambda pol: validate_tag_display_policy(pol, hooks=hooks),
    )
    snapshot_bytes_fn = _hook(
        hooks, 'tag_catalog_snapshot_bytes',
        lambda snap: tag_catalog_snapshot_bytes(snap, hooks=hooks),
    )
    prompt_sha_fn = _hook(
        hooks, '_historical_tag_prompt_text_sha256', historical_tag_prompt_text_sha256,
    )

    raw_files = {}
    for record in records:
        relative = record.get('path', '')
        if not is_tag_path_fn(relative):
            continue
        target = repo / relative
        try:
            target.resolve().relative_to(repo)
        except ValueError as exc:
            raise err_cls('标签词表文件的路径超出了博客仓库。') from exc
        for parent in [target, *target.parents]:
            if parent == repo:
                break
            if parent.is_symlink():
                raise err_cls('标签词表文件及其父目录不得是符号链接。')
        if target.name in {'taxonomy-presentation-policy.json', 'tag-presentation-policy.json'} \
                and target.exists() and target.stat().st_nlink != 1:
            raise err_cls('标签展示策略和快照必须是普通文件，且只能有一个硬链接。')
        expected_sha = record.get('expectedSha256') if installation else record.get('sha256')
        deleted = record.get('delete') if installation else record.get('deleted')
        if (deleted is not False or target.is_symlink() or not target.is_file()
                or installation and record.get('stagedRelativePath') != relative):
            raise err_cls('标签词表文件的路径或删除标记与原记录不一致。')
        raw = target.read_bytes()
        if hashlib.sha256(raw).hexdigest() != expected_sha or relative in raw_files:
            raise err_cls('标签词表文件的字节或 SHA 与原记录不一致。')
        raw_files[relative] = raw
    current = any(Path(relative).name in {'tag-catalog-snapshot.json', 'tag-catalog-versions.json',
                  'tag-presentation-policy.json'} for relative in raw_files)
    legacy = any(Path(relative).name in {'taxonomy-registry.json', 'taxonomy-catalog.json',
                 'taxonomy-presentation-policy.json'} for relative in raw_files)
    if current and legacy:
        raise err_cls('标签显示文件不能混用新旧文件集合。')
    if not raw_files:
        return {}
    archive_names = {Path(relative).parent.name for relative in raw_files
                     if Path(relative).parent.name in {'taxonomy-snapshots', 'tag-catalog-history'}}
    if len(archive_names) != 1 or not current and 'tag-catalog-history' in archive_names:
        raise err_cls('原标签词表文件集合缺少归档目录，或混用了不兼容的归档目录。')
    archive_name = next(iter(archive_names))
    snapshot_name = 'tag-catalog-snapshot.json' if current else 'taxonomy-registry.json'
    catalog_name = 'tag-catalog-versions.json' if current else 'taxonomy-catalog.json'
    policy_name = 'tag-presentation-policy.json' if current else 'taxonomy-presentation-policy.json'

    def pair(name, *, optional=False):
        paths = [f'{prefix}/{name}' for prefix in ('data', 'static/data')]
        values = [raw_files.get(path) for path in paths]
        if optional and values == [None, None]:
            return None
        if values[0] is None or values[0] != values[1]:
            raise err_cls('标签显示文件缺少对应副本，或两个副本的字节不一致。')
        return values[0]

    display = validate_snapshot_fn(json.loads(pair(snapshot_name).decode('utf-8')))
    catalog = json.loads(pair(catalog_name).decode('utf-8'))
    versions = validate_versions_fn(catalog)
    expected_contract = 'sha-keyed-snapshot-set' if current else 'legacy-sha-keyed-snapshot-set'
    expected_snapshot = 'public-concept-hierarchy' if current else 'legacy-public-concept-hierarchy'
    display_header = protocols.record_header(
        display['contract'], 'paper-tag-catalog-snapshot', display.get('schemaFingerprint'),
    )
    if (protocols.format(display['contract'], 'paper-tag-catalog-snapshot', display.get('schemaFingerprint')) != expected_snapshot
            or protocols.format(catalog['contract'], 'paper-tag-catalog-versions', catalog.get('schemaFingerprint')) != expected_contract
            or catalog['currentSha256'] != display['registrySha256']
            or display != (build_display_fn(versions[display['registrySha256']], target_header=display_header)
                           if current else versions[display['registrySha256']])):
        raise err_cls('标签显示快照与原版本目录不一致。')
    policy_raw = pair(policy_name, optional=True)
    if policy_raw is not None:
        def unique_object(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise err_cls('标签展示策略的 JSON 中存在重复键。')
                result[key] = value
            return result
        policy = validate_policy_fn(json.loads(policy_raw.decode('utf-8'), object_pairs_hook=unique_object))
        expected_policy = 'approved-display-catalog' if current else 'legacy-display-catalog'
        base = versions.get(policy['baseRegistrySha256'])
        preferred = versions.get(policy['preferredRegistrySha256'])
        if (protocols.format(policy['contract'], 'paper-tag-presentation-policy', policy.get('schemaFingerprint')) != expected_policy
                or base is None or preferred is None
                or preferred['registrySha256'] != display['registrySha256']
                or hashlib.sha256(snapshot_bytes_fn(base)).hexdigest() != policy['baseSnapshotSha256']
                or hashlib.sha256(snapshot_bytes_fn(preferred)).hexdigest() != policy['preferredSnapshotSha256']
                or prompt_sha_fn(preferred) != policy['preferredProjectionSha256']
                or preferred['concepts'][:len(base['concepts'])] != base['concepts']):
            raise err_cls('原标签展示策略与完整快照、提示文本或概念顺序不一致。')
    expected_paths = {f'{prefix}/{name}' for prefix in ('data', 'static/data')
                      for name in (snapshot_name, catalog_name)}
    if policy_raw is not None:
        expected_paths.update(f'{prefix}/{policy_name}' for prefix in ('data', 'static/data'))
    for sha, snapshot in versions.items():
        for prefix in ('data', 'static/data'):
            relative = f'{prefix}/{archive_name}/{sha}.json'
            raw = raw_files.get(relative)
            if raw is None or json.loads(raw.decode('utf-8')) != snapshot:
                raise err_cls('原标签版本目录缺少对应的完整归档副本。')
            other = raw_files.get(f'static/data/{archive_name}/{sha}.json')
            if archive_name == 'tag-catalog-history' and raw != other:
                raise err_cls('新版标签词表归档的两个副本字节不一致。')
            if policy_raw is not None and sha == policy['preferredRegistrySha256']:
                if (hashlib.sha256(raw).hexdigest() != policy['preferredSnapshotSha256']
                        or raw != other):
                    raise err_cls('标签展示策略选用版本的归档原字节与批准的快照 SHA 不一致。')
            expected_paths.add(relative)
    if set(raw_files) != expected_paths:
        raise err_cls('原标签词表文件集合与完整显示束不一致。')
    return raw_files


def prepare_tag_catalog_staged_files(
    stage_root, blog_repo=None, *, single_page=False, installation=None, hooks: Mapping | None = None,
) -> list[Path]:
    """将词表文件写入与页面共用的暂存区，并绑定安装记录、审查凭证和本次精确文件差异。"""
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    default_repo = _hook(hooks, 'BLOG_REPO', '.')
    is_tag_path_fn = _hook(hooks, '_is_tag_catalog_file_path', is_tag_catalog_file_path)
    saved_fn = _hook(
        hooks, '_saved_tag_catalog_file_contents',
        lambda r, recs, *, installation=False: saved_tag_catalog_file_contents(
            r, recs, installation=installation, hooks=hooks,
        ),
    )
    sha256_file_fn = _hook(hooks, '_sha256_file', _default_sha256_file)
    contents_fn = _hook(
        hooks, 'tag_catalog_file_contents',
        lambda r=None: tag_catalog_file_contents(r, hooks=hooks),
    )
    write_bytes_fn = _hook(hooks, '_atomic_write_bytes', _default_atomic_write_bytes)

    repo = Path(default_repo if blog_repo is None else blog_repo).expanduser().resolve()
    stage = Path(stage_root).resolve()
    if installation is not None:
        records = installation.get('files') if isinstance(installation, dict) else None
        if not isinstance(records, list):
            raise err_cls('标签词表安装记录缺少有效的文件列表。')
        selected = [record for record in records if isinstance(record, dict)
                    and is_tag_path_fn(record.get('path', ''))]
        if single_page:
            if selected:
                raise err_cls('单篇发布的安装记录不得包含全站标签词表文件。')
            return []
        expected = saved_fn(stage, selected, installation=True)
        if {record['path'] for record in selected} != set(expected):
            raise err_cls('安装记录中的标签词表文件集合与暂存区应有的文件集合不一致。')
        paths = []
        for record in selected:
            relative = record['path']
            target = stage / relative
            if (record.get('delete') is not False
                    or record.get('stagedRelativePath') != relative
                    or target.is_symlink() or not target.is_file()
                    or sha256_file_fn(target) != record.get('expectedSha256')
                    or target.read_bytes() != expected[relative]):
                raise err_cls('标签词表暂存文件无效，或其安装路径、删除标记、SHA 或文件内容与安装记录不一致。')
            paths.append(target)
        return paths
    assets = contents_fn(repo)
    if single_page:
        if any(not (repo / relative).is_file() or (repo / relative).read_bytes() != raw
               for relative, raw in assets.items()):
            raise err_cls('单篇发布不得更新全站标签词表；请先通过完整批次发布词表版本文件。')
        return []
    paths = []
    for relative, raw in assets.items():
        target = stage / relative
        try:
            target.resolve().relative_to(stage)
        except ValueError as exc:
            raise err_cls('标签词表文件的暂存路径超出了暂存目录。') from exc
        if target.is_symlink():
            raise err_cls('标签词表暂存文件不得是符号链接。')
        write_bytes_fn(target, raw)
        paths.append(target)
    return paths


def export_tag_catalog_files(blog_repo=None, *, hooks: Mapping | None = None) -> list[Path]:
    """将词表版本文件写入博客仓库，不修改原词表。

    返回实际写入的文件路径。已有文件内容相同时跳过写入；博客根目录不存在时不写入任何文件。
    """
    default_repo = _hook(hooks, 'BLOG_REPO', '.')
    contents_fn = _hook(
        hooks, 'tag_catalog_file_contents',
        lambda r=None: tag_catalog_file_contents(r, hooks=hooks),
    )
    write_bytes_fn = _hook(hooks, '_atomic_write_bytes', _default_atomic_write_bytes)

    repo = Path(default_repo if blog_repo is None else blog_repo).expanduser().resolve()
    if not repo.is_dir():
        return []
    assets = contents_fn(repo)
    written = []
    for relative, raw in assets.items():
        target = repo / relative
        if target.is_file() and target.read_bytes() == raw:
            continue
        write_bytes_fn(target, raw)
        written.append(target)
    return written


def build_flat_tag_compat_metadata(
    parsed,
    *,
    required=False,
    flat_tag_contract=_UNSET_CONTRACT,
    flat_tag_schema_fingerprint=_CURRENT_CONTEXT_SCHEMA,
    saved_tag_registry=None,
    hooks: Mapping | None = None,
):
    """保留 Hugo 的 tags 字段，并记录当前词表中标签的含义和层级。

    旧记录维护时可以缺少当前标签选择记录；required 为 True 时必须提供有效记录。
    输入声明标签选择有效后，本函数仍按当前词表逐项核对 ID、中文名称、分类维度和主标签角色。
    """
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    protocols = _hook(hooks, 'public_protocols', public_protocols)
    supported_flat_fn = _hook(hooks, 'is_supported_flat_tag_contract', is_supported_flat_tag_contract)
    read_val_fn = _hook(hooks, 'read_tag_validation', read_tag_validation)
    identity_fn = _hook(hooks, 'tag_catalog_identity', tag_catalog_identity)
    resolve_proof_fn = _hook(hooks, 'resolve_compatible_proof_catalog', resolve_compatible_proof_catalog)
    append_only_fn = _hook(hooks, 'is_strict_append_only_catalog', is_strict_append_only_catalog)
    page_catalog = _hook(hooks, '_PAGE_TAG_CATALOG', _PAGE_TAG_CATALOG)
    active_by_id = _hook(hooks, '_PAGE_ACTIVE_TAGS_BY_ID', _PAGE_ACTIVE_TAGS_BY_ID)
    current_schema_sentinel = _hook(hooks, '_CURRENT_CONTEXT_SCHEMA', _CURRENT_CONTEXT_SCHEMA)
    contract = (
        _hook(hooks, 'FLAT_TAG_COMPAT_CONTRACT', FLAT_TAG_COMPAT_CONTRACT)
        if flat_tag_contract is _UNSET_CONTRACT else flat_tag_contract
    )

    if not supported_flat_fn(contract):
        raise err_cls('页面标签的格式版本不受支持。')
    is_default_schema = (
        flat_tag_schema_fingerprint is _CURRENT_CONTEXT_SCHEMA
        or flat_tag_schema_fingerprint is current_schema_sentinel
    )
    flat_header = (
        protocols.record_header(contract, 'paper-tag-flat-tags')
        if is_default_schema else
        protocols.record_header(contract, 'paper-tag-flat-tags', flat_tag_schema_fingerprint)
    )
    if 'schemaFingerprint' in flat_header:
        flat_schema = protocols.declared_schema(
            flat_header['contract'], 'paper-tag-flat-tags', flat_header['schemaFingerprint'],
        )
        selection_header = flat_schema.get('selectionFormat')
        if not protocols.has_valid_header(selection_header, 'paper-tag-selection'):
            raise err_cls('页面标签的原结构声明没有绑定有效选择格式。')
    else:
        selection_header = protocols.historical_header(
            'paper-tag-selection', 'task-and-method-concept-selection', None,
        )
    try:
        validation = read_val_fn(parsed)
    except ValueError as error:
        raise err_cls(str(error)) from error
    if not isinstance(validation, dict) or validation.get('valid') is not True:
        if required:
            raise err_cls('新页面缺少通过当前词表检查的标签选择记录。')
        return None
    proof_catalog = page_catalog
    if validation.get('registryVersion') != identity_fn(page_catalog) \
            or validation.get('registrySha256') != page_catalog['registrySha256']:
        original = resolve_proof_fn(
            validation.get('registrySha256'), page_catalog)
        if original is None or validation.get('registryVersion') != identity_fn(original):
            raise err_cls('页面的标签选择记录与当前词表版本或 SHA 不一致。')
        proof_catalog = original
        from utils import _validate_tag_selection
        original_selection = _validate_tag_selection(
            original, parsed.get('tags'),
            parsed.get('primaryTaskTag'), parsed.get('primaryMethodTag'),
        )
        if (not original_selection['valid'] or any(original_selection.get(key) != validation.get(key)
                for key in ('primaryTaskId', 'primaryMethodId', 'conceptIds'))):
            raise err_cls('页面的旧标签选择不能按真实归档词表完整重放。')
        validation = _validate_tag_selection(
            page_catalog, parsed.get('tags'),
            parsed.get('primaryTaskTag'), parsed.get('primaryMethodTag'),
        )
        if not validation['valid']:
            raise err_cls('页面的旧标签选择未通过当前纯追加词表的校验。')
    display_catalog = page_catalog
    if saved_tag_registry is not None and saved_tag_registry != (
            identity_fn(display_catalog), display_catalog['registrySha256']):
        version, digest = saved_tag_registry
        archived = resolve_proof_fn(digest, page_catalog)
        if (archived is None or version != identity_fn(archived)
                or (digest != proof_catalog['registrySha256']
                    and not append_only_fn(proof_catalog, archived))):
            raise err_cls('页面声明的旧词表与原标签选择或归档字节不一致。')
        display_catalog = archived
    tags = parsed.get('tags')
    concept_ids = validation.get('conceptIds')
    if not isinstance(tags, list) or not isinstance(concept_ids, list) \
            or len(tags) != len(concept_ids) or len(tags) not in range(3, 6):
        raise err_cls('页面标签或概念 ID 列表无效，或两者数量不一致；标签数量必须为 3–5 个。')
    concepts = []
    for tag, concept_id in zip(tags, concept_ids):
        concept = active_by_id.get(concept_id)
        label = str(tag or '').removeprefix('#')
        if not concept or concept['preferredLabel']['zh'] != label:
            raise err_cls('页面标签与对应概念的中文首选名称不一致，或该概念未在当前词表中启用。')
        concepts.append({
            'id': concept_id,
            'facet': concept['facet'],
            'label': label,
        })
    primary_task_id = validation.get('primaryTaskId')
    primary_method_id = validation.get('primaryMethodId')
    primary_task = str(parsed.get('primaryTaskTag') or '').removeprefix('#')
    primary_method = str(parsed.get('primaryMethodTag') or '').removeprefix('#')
    task = active_by_id.get(primary_task_id)
    method = active_by_id.get(primary_method_id)
    if not task or task['facet'] != 'task' or task['preferredLabel']['zh'] != primary_task \
            or not method or method['facet'] != 'method' \
            or method['preferredLabel']['zh'] != primary_method \
            or primary_task_id not in concept_ids or primary_method_id not in concept_ids:
        raise err_cls('页面的主任务或主方法不符合对应的分类、中文首选名称或已选概念。')
    return {
        **flat_header,
        'selectionContract': selection_header['contract'],
        'registryVersion': identity_fn(display_catalog),
        'registrySha256': display_catalog['registrySha256'],
        'primaryTaskId': primary_task_id,
        'primaryMethodId': primary_method_id,
        'primaryTask': primary_task,
        'primaryMethod': primary_method,
        'concepts': concepts,
    }


def page_flat_tag_contract(frontmatter, *, hooks: Mapping | None = None):
    """读取页面声明的标签格式，用于核对原有元数据和附属文件。"""
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    protocols = _hook(hooks, 'public_protocols', public_protocols)
    flat_contract = _hook(hooks, 'FLAT_TAG_COMPAT_CONTRACT', FLAT_TAG_COMPAT_CONTRACT)
    tag_field_names = ('contract', 'schema_fingerprint', 'selection_contract', 'registry_version',
                       'registry_sha256', 'concepts', 'scope')
    has_current_tags = any('paper_digest_tags_' + field in frontmatter for field in tag_field_names)
    has_legacy_tags = any('paper_digest_taxonomy_' + field in frontmatter for field in tag_field_names)
    if has_current_tags and has_legacy_tags:
        raise err_cls('页面不能同时包含 paper_digest_tags_* 和旧字段 paper_digest_taxonomy_*。')
    if not has_current_tags and not has_legacy_tags:
        return flat_contract
    prefix = 'paper_digest_tags_' if has_current_tags else 'paper_digest_taxonomy_'
    contract = frontmatter.get(prefix + 'contract')
    header = {'contract': contract}
    if prefix + 'schema_fingerprint' in frontmatter:
        header['schemaFingerprint'] = frontmatter[prefix + 'schema_fingerprint']
    if not protocols.has_valid_header(header, 'paper-tag-flat-tags'):
        raise err_cls('页面标签的原格式头或结构指纹无效。')
    return contract


def page_flat_tag_fingerprint(frontmatter, *, hooks: Mapping | None = None):
    page_contract_fn = _hook(
        hooks, '_page_flat_tag_contract',
        lambda fm: page_flat_tag_contract(fm, hooks=hooks),
    )
    current_schema_sentinel = _hook(hooks, '_CURRENT_CONTEXT_SCHEMA', _CURRENT_CONTEXT_SCHEMA)
    page_contract_fn(frontmatter)
    prefix = (
        'paper_digest_tags_'
        if any(key.startswith('paper_digest_tags_') for key in frontmatter)
        else 'paper_digest_taxonomy_'
    )
    return (
        frontmatter.get(prefix + 'schema_fingerprint')
        if prefix + 'contract' in frontmatter
        else current_schema_sentinel
    )


def page_saved_tag_registry(frontmatter):
    for prefix in ('paper_digest_tags_', 'paper_digest_taxonomy_'):
        if prefix + 'contract' in frontmatter:
            return (frontmatter.get(prefix + 'registry_version'),
                    frontmatter.get(prefix + 'registry_sha256'))
    return None


def render_paper_tag_hierarchy(parsed, *, hooks: Mapping | None = None) -> str:
    page_catalog = _hook(hooks, '_PAGE_TAG_CATALOG', _PAGE_TAG_CATALOG)
    identity_fn = _hook(hooks, 'tag_catalog_identity', tag_catalog_identity)
    build_meta_fn = _hook(
        hooks, 'build_flat_tag_compat_metadata',
        lambda p: build_flat_tag_compat_metadata(p, hooks=hooks),
    )
    render_md_fn = _hook(hooks, 'render_tag_hierarchy_markdown', render_tag_hierarchy_markdown)
    base_path = _hook(hooks, 'BASE_PATH', '/audio-paper-digest-blog')
    metadata = build_meta_fn(parsed)
    if metadata is None and not any(key in parsed for key in ('tagValidation', 'taxonomyValidation')):
        by_label = {item['preferredLabel']['zh']: item for item in page_catalog['concepts']
                    if item['status'] == 'active'}
        selected = []
        for raw in parsed.get('tags') or []:
            concept = by_label.get(str(raw).removeprefix('#'))
            if concept is not None and concept['id'] not in {item['id'] for item in selected}:
                selected.append({'id': concept['id'], 'facet': concept['facet'],
                                 'label': concept['preferredLabel']['zh']})
        metadata = {'registryVersion': identity_fn(page_catalog),
                    'registrySha256': page_catalog['registrySha256'], 'concepts': selected}
    return render_md_fn(metadata, page_catalog, base_path=base_path) if metadata else ''


def top_level_task_concept(concept_id, *, hooks: Mapping | None = None) -> dict:
    """只投影主任务的最上级用于统计，不将祖先写回论文直接分类。"""
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    page_catalog = _hook(hooks, '_PAGE_TAG_CATALOG', _PAGE_TAG_CATALOG)
    by_id = {node['id']: node for node in page_catalog['concepts']}
    node = by_id.get(concept_id)
    seen = set()
    while node is not None:
        if node['id'] in seen or node['facet'] != 'task' or node['status'] != 'active':
            raise err_cls('主任务的最上级统计路径无效。')
        seen.add(node['id'])
        if node['broaderId'] is None:
            return {'id': node['id'], 'facet': 'task', 'label': node['preferredLabel']['zh']}
        node = by_id.get(node['broaderId'])
    raise err_cls('主任务的最上级统计缺少受控词表概念。')


def current_batch_tag_metadata(papers, *, hooks: Mapping | None = None):
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    protocols = _hook(hooks, 'public_protocols', public_protocols)
    read_val_fn = _hook(hooks, 'read_tag_validation', read_tag_validation)
    parse_analysis_fn = _hook(hooks, 'parse_analysis', parse_analysis)
    build_meta_fn = _hook(
        hooks, 'build_flat_tag_compat_metadata',
        lambda p: build_flat_tag_compat_metadata(p, hooks=hooks),
    )
    top_task_fn = _hook(
        hooks, '_top_level_task_concept',
        lambda cid: top_level_task_concept(cid, hooks=hooks),
    )
    flat_contract = _hook(hooks, 'FLAT_TAG_COMPAT_CONTRACT', FLAT_TAG_COMPAT_CONTRACT)

    if not papers:
        return None
    papers = list(papers)
    try:
        for paper in papers:
            read_val_fn(paper.get('parsed'))
    except ValueError as error:
        raise err_cls(str(error)) from error
    selections = []
    for paper in papers:
        parsed = paper.get('parsed') or parse_analysis_fn(paper.get('analysis', '')) or {}
        metadata = build_meta_fn(parsed)
        if metadata is None:
            return None
        selections.append(metadata)
    first = selections[0]
    if any(item['registryVersion'] != first['registryVersion']
           or item['registrySha256'] != first['registrySha256']
           or item['selectionContract'] != first['selectionContract']
           for item in selections[1:]):
        raise err_cls('汇总页中的标签选择记录使用了不同的词表版本、词表 SHA 或标签选择协议。')
    counts, task_concepts, root_counts, root_concepts = {}, {}, {}, {}
    for item in selections:
        tag = f'#{item["primaryTask"]}'
        counts[tag] = counts.get(tag, 0) + 1
        task_concepts[tag] = next(concept for concept in item['concepts']
                                  if concept['id'] == item['primaryTaskId'])
        root = top_task_fn(item['primaryTaskId'])
        root_counts[root['id']] = root_counts.get(root['id'], 0) + 1
        root_concepts[root['id']] = root
    primary_tasks = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return {
        **protocols.record_header(flat_contract, 'paper-tag-flat-tags'),
        'selectionContract': first['selectionContract'],
        'registryVersion': first['registryVersion'],
        'registrySha256': first['registrySha256'],
        'primaryTasks': primary_tasks,
        'concepts': [task_concepts[tag] for tag, _count in primary_tasks],
        'rootPrimaryTasks': [(root_concepts[cid], count) for cid, count in
                             sorted(root_counts.items(), key=lambda pair:
                                    (-pair[1], root_concepts[pair[0]]['label']))],
    }


def root_task_link(concept, *, hooks: Mapping | None = None) -> str:
    base_path = _hook(hooks, 'BASE_PATH', '/audio-paper-digest-blog')
    return f'[{concept["label"]}]({base_path}/papers/?concept={quote(concept["id"], safe="")})'


def review_tag_catalog_files(
    date_str, publish_paths, manifest_path, file_results, *, hooks: Mapping | None = None,
) -> int:
    """按应发布的文件集合检查词表 JSON 内容、两处副本和版本记录。"""
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    load_json_fn = _hook(
        hooks, '_load_json_object',
        lambda p, label: _default_load_json_object(p, label, err_cls),
    )
    blog_repo = _hook(hooks, 'BLOG_REPO', '.')
    is_tag_path_fn = _hook(hooks, '_is_tag_catalog_file_path', is_tag_catalog_file_path)
    saved_fn = _hook(
        hooks, '_saved_tag_catalog_file_contents',
        lambda r, recs, *, installation=False: saved_tag_catalog_file_contents(
            r, recs, installation=installation, hooks=hooks,
        ),
    )

    manifest = load_json_fn(manifest_path, 'generation manifest')
    repo = Path(blog_repo).expanduser().resolve()
    records = {item['path']: item for item in manifest.get('files', [])
               if isinstance(item, dict) and isinstance(item.get('path'), str)}
    paths = [Path(item).resolve() for item in publish_paths
             if is_tag_path_fn(Path(item).resolve().relative_to(repo))]
    if not paths:
        return 0
    try:
        expected = saved_fn(
            repo,
            [records[item.relative_to(repo).as_posix()]
             for item in paths if item.relative_to(repo).as_posix() in records],
        )
        actual = {item.relative_to(repo).as_posix() for item in paths}
        if actual != set(expected):
            raise err_cls('待审查的标签词表文件集合与应发布的版本文件集合不一致。')
        failure = None
    except (OSError, ValueError, UnicodeError, err_cls) as exc:
        expected = {}
        failure = str(exc)
    blocking = 0
    for target in paths:
        relative = target.relative_to(repo).as_posix()
        record = records.get(relative, {})
        try:
            raw = target.read_bytes() if not target.is_symlink() else None
        except OSError:
            raw = None
        valid = bool(failure is None and raw is not None and raw == expected.get(relative)
                     and record.get('deleted') is False
                     and hashlib.sha256(raw).hexdigest() == record.get('sha256'))
        file_results[str(target)] = {
            'passed': valid, 'completed': True, 'failureKind': None if valid else 'content',
            'blockingCount': 0 if valid else 1,
            'reviewedSha256': record.get('sha256') if valid else None,
            'imageReviewMode': 'deterministic_only',
            'tagReviewMode': 'frozen-version-bytes-v1',
        }
        blocking += not valid
    return blocking


# 兼容带下划线前缀的既有内部别名
_validate_tag_catalog_snapshot = validate_tag_catalog_snapshot
_validate_tag_version_catalog = validate_tag_version_catalog
_validate_tag_display_policy = validate_tag_display_policy
_historical_tag_prompt_text_sha256 = historical_tag_prompt_text_sha256
_select_tag_display_version = select_tag_display_version
_is_tag_catalog_file_path = is_tag_catalog_file_path
_read_tag_catalog_file = read_tag_catalog_file
_tag_snapshot_body = tag_snapshot_body
_build_tag_catalog_display_snapshot = build_tag_catalog_display_snapshot
_read_approved_tag_display_policy = read_approved_tag_display_policy
_file_stat_signature = file_stat_signature
_verify_intermediate_dirs_nofollow = verify_intermediate_dirs_nofollow
_verify_config_target_dirs_nofollow = verify_config_target_dirs_nofollow
_read_nofollow_regular_sha256 = read_nofollow_regular_sha256
_probe_tag_catalog_serialization_key = probe_tag_catalog_serialization_key
_saved_tag_catalog_file_contents = saved_tag_catalog_file_contents
_page_flat_tag_contract = page_flat_tag_contract
_page_flat_tag_fingerprint = page_flat_tag_fingerprint
_page_saved_tag_registry = page_saved_tag_registry
_current_batch_tag_metadata = current_batch_tag_metadata
_top_level_task_concept = top_level_task_concept
_root_task_link = root_task_link
