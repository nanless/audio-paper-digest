"""读取并核验标签词表，按指定规则查找标签对应的概念。"""

import hashlib
import json
import re
import unicodedata
from pathlib import Path

FACET_IDS = ('task', 'method', 'setting', 'signal', 'application',
             'research_focus', 'artifact', 'scientific_topic', 'model_family')
LABEL_MODE_CURRENT = 'current'
LABEL_MODE_LEGACY = 'legacy'
LABEL_MODES = (LABEL_MODE_CURRENT, LABEL_MODE_LEGACY)
TAG_PROMPT_TEXT_CONTRACT = 'paper-taxonomy-prompt-projection-v1'
TAG_SELECTION_CONTRACT = 'paper-taxonomy-selection-v1'
TAG_FLAT_COMPAT_CONTRACT = 'paper-taxonomy-flat-tags-compat-v1'
CONCEPT_KEYS = {'id', 'facet', 'preferredLabel', 'aliases', 'broaderId',
                'definition', 'scopeNote', 'status', 'replacedBy'}
# ECMAScript String.trim whitespace, including BOM (Python str.strip differs).
_JS_WHITESPACE = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'


def normalize_label(value):
    if not isinstance(value, str):
        return ''
    result = unicodedata.normalize('NFKC', value).strip(_JS_WHITESPACE)
    if result.startswith('#'):
        result = result[1:].strip(_JS_WHITESPACE)
    return re.sub('[A-Z]', lambda match: match.group().lower(), result)


def _object(value, keys, name):
    if type(value) is not dict or set(value) != set(keys):
        raise ValueError(f'{name} 必须是对象，且字段不能缺失或超出允许范围。')


def _string(value, name):
    if (not isinstance(value, str) or not value.strip(_JS_WHITESPACE)
            or value != value.strip(_JS_WHITESPACE) or re.search(r'[\x00-\x1f\x7f]', value)):
        raise ValueError(f'{name} 必须是非空字符串，不能含首尾空白或控制字符。')


def validate_tag_catalog(data):
    _object(data, {'version', 'facets', 'concepts'}, '标签词表')
    if data['version'] != 'paper-taxonomy-v1':
        raise ValueError('标签词表的版本不受支持。')
    if not isinstance(data['facets'], list) or len(data['facets']) != len(FACET_IDS):
        raise ValueError('标签词表的分类维度必须是包含九项的列表。')
    facets = set()
    for facet in data['facets']:
        _object(facet, {'id', 'label'}, '分类维度记录')
        if facet['id'] not in FACET_IDS or facet['id'] in facets:
            raise ValueError('标签词表含有未知或重复的分类维度。')
        _string(facet['label'], '分类维度名称')
        facets.add(facet['id'])
    if not isinstance(data['concepts'], list) or not data['concepts']:
        raise ValueError('标签词表中的概念必须是非空列表。')
    ids, labels = {}, {}
    for concept in data['concepts']:
        _object(concept, CONCEPT_KEYS, '概念记录')
        facet, cid = concept['facet'], concept['id']
        if (not isinstance(facet, str) or facet not in facets or not isinstance(cid, str)
                or not re.fullmatch(re.escape(facet) + r'\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*', cid)
                or cid in ids):
            raise ValueError('概念的分类维度或 ID 格式无效，或 ID 重复。')
        _object(concept['preferredLabel'], {'zh', 'en'}, f'{cid}.preferredLabel')
        for language in ('zh', 'en'):
            _string(concept['preferredLabel'][language], f'{cid}.{language}')
        _string(concept['definition'], f'{cid}.definition')
        _string(concept['scopeNote'], f'{cid}.scopeNote')
        if not isinstance(concept['aliases'], list):
            raise ValueError(f'{cid} 的别名必须为列表。')
        aliases = set()
        for alias in concept['aliases']:
            _string(alias, f'{cid}.alias')
            normalized = normalize_label(alias)
            if not normalized or normalized in aliases:
                raise ValueError(f'{cid} 的别名经统一格式处理后为空，或存在重复。')
            aliases.add(normalized)
        if concept['status'] not in ('active', 'deprecated'):
            raise ValueError(f'{cid} 的状态必须为 active 或 deprecated。')
        if concept['broaderId'] is not None and not isinstance(concept['broaderId'], str):
            raise ValueError(f'{cid} 的上级概念 ID 必须为字符串或 null。')
        if concept['status'] == 'active' and concept['replacedBy'] is not None:
            raise ValueError(f'{cid} 已启用，不能设置替代概念。')
        if concept['status'] == 'deprecated' and (not isinstance(concept['replacedBy'], str) or not concept['replacedBy']):
            raise ValueError(f'{cid} 已停用，必须填写非空字符串形式的替代概念 ID。')
        ids[cid] = concept
        for label in [*concept['preferredLabel'].values(), *concept['aliases']]:
            normalized = normalize_label(label)
            if not normalized:
                raise ValueError(f'{cid} 的名称经统一格式处理后为空。')
            key = (facet, normalized)
            if key in labels and labels[key] != cid:
                raise ValueError(f'分类维度 {facet} 中的名称 {label} 对应多个概念。')
            labels[key] = cid
    for concept in data['concepts']:
        cid, parent_id = concept['id'], concept['broaderId']
        if parent_id is not None:
            parent = ids.get(parent_id)
            if not parent or parent['facet'] != concept['facet'] or parent['status'] != 'active':
                raise ValueError(f'{cid} 的上级概念必须存在、已启用，并属于同一分类维度。')
        if concept['status'] == 'deprecated':
            replacement = ids.get(concept['replacedBy'])
            if (not replacement or replacement['id'] == cid or replacement['status'] != 'active'
                    or replacement['facet'] != concept['facet']):
                raise ValueError(f'{cid} 的替代概念必须是同一分类维度中另一个已启用的概念。')
        seen = {cid}
        while parent_id is not None:
            if parent_id in seen:
                raise ValueError(f'{cid} 的上级概念链存在循环。')
            seen.add(parent_id)
            parent = ids.get(parent_id)
            if not parent:
                raise ValueError(f'{cid} 的上级概念链包含不存在的概念。')
            parent_id = parent['broaderId']
    return data


def _registry_data(tag_catalog):
    if not isinstance(tag_catalog, dict):
        raise ValueError('标签词表必须为对象。')
    expected = {'version', 'facets', 'concepts'}
    if 'registrySha256' in tag_catalog:
        expected.add('registrySha256')
        if not isinstance(tag_catalog['registrySha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', tag_catalog['registrySha256']):
            raise ValueError('标签词表记录中的 registrySha256 格式无效。')
    _object(tag_catalog, expected, '标签词表')
    return validate_tag_catalog({key: tag_catalog.get(key) for key in ('version', 'facets', 'concepts')})


def load_tag_catalog(file_path=None):
    if file_path is None:
        import tag_paths
        file_path = tag_paths.TAG_CATALOG_FILE
    raw = Path(file_path).read_bytes()
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError('标签词表文件大小超过 2 MiB。')
    def unique_object(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError('标签词表 JSON 中含有重复字段。')
            value[key] = item
        return value
    # Match Node's fatal TextDecoder: UTF-8 BOM is discarded for parsing, while
    # the digest continues to bind the complete original byte sequence.
    data = validate_tag_catalog(json.loads(raw.decode('utf-8-sig'), object_pairs_hook=unique_object))
    return {**data, 'registrySha256': hashlib.sha256(raw).hexdigest()}


def active_preferred_labels(tag_catalog, facets=None):
    """返回指定分类维度中已启用概念的中文首选名称。"""
    data = _registry_data(tag_catalog)
    if facets is None:
        selected_facets = set(FACET_IDS)
    else:
        if (not isinstance(facets, (list, tuple, set, frozenset))
                or any(facet not in FACET_IDS for facet in facets)):
            raise ValueError('分类维度参数必须是列表、元组或集合，且只包含已知维度 ID。')
        selected_facets = set(facets)
    labels = tuple(concept['preferredLabel']['zh'] for concept in data['concepts']
                   if concept['status'] == 'active'
                   and concept['facet'] in selected_facets)
    if len(set(labels)) != len(labels):
        raise ValueError('所选分类维度中已启用概念的中文首选名称不能重复。')
    return labels


def build_tag_prompt_text(tag_catalog):
    """按与 Node 相同的规则生成精简标签提示文本。"""
    data = _registry_data(tag_catalog)
    registry_sha = tag_catalog.get('registrySha256')
    if not isinstance(registry_sha, str) or not re.fullmatch(r'[a-f0-9]{64}', registry_sha):
        raise ValueError('生成标签提示文本需要格式有效的词表 SHA。')
    facet_order = {facet['id']: index for index, facet in enumerate(data['facets'])}
    active = sorted(
        (concept for concept in data['concepts'] if concept['status'] == 'active'),
        key=lambda concept: (facet_order[concept['facet']], concept['id']),
    )
    lines = [
        f'contract={TAG_PROMPT_TEXT_CONTRACT}',
        f'registry_version={data["version"]}',
        f'registry_sha256={registry_sha}',
        '只允许输出下列 active 概念的中文首选标签；ID 用于消歧，不得自造标签或输出同义词。',
    ]
    current_facet = None
    for concept in active:
        if concept['facet'] != current_facet:
            current_facet = concept['facet']
            lines.append(f'[{current_facet}]')
        compact = lambda value: re.sub(
            r'\s+', ' ', re.sub(r'[\r\n|]+', ' ', str(value or ''))).strip()
        lines.append('|'.join((
            concept['id'], f'#{concept["preferredLabel"]["zh"]}',
            compact(concept['definition']), compact(concept['scopeNote']),
        )))
    return '\n'.join(lines) + '\n'


def tag_prompt_text_sha256(tag_catalog):
    return hashlib.sha256(build_tag_prompt_text(tag_catalog).encode('utf-8')).hexdigest()


def resolve_label_candidates(tag_catalog, label, facet=None, *, mode=LABEL_MODE_LEGACY):
    """查找标签对应的概念；无法唯一确定时不替调用方作选择。

    current 模式只接受已启用概念的中文首选名称，并按既有规则统一名称格式。
    legacy 模式另接受英文名称、别名和停用概念。为兼容历史审计，本函数默认
    使用 legacy；生产调用须使用 resolve_current_label 或明确传入 mode='current'。
    调用方仍须拒绝停用概念，不能自动沿 replacedBy 改用替代概念。
    """
    data = _registry_data(tag_catalog)
    if facet is not None and facet not in FACET_IDS:
        raise ValueError(f'未知的分类维度：{facet}。')
    if mode not in LABEL_MODES:
        raise ValueError(f'未知的标签查找模式：{mode}。')
    normalized = normalize_label(label)
    if not normalized:
        return []
    matches = []
    for concept in data['concepts']:
        if facet is not None and concept['facet'] != facet:
            continue
        if mode == LABEL_MODE_CURRENT:
            if concept['status'] != 'active':
                continue
            labels = (concept['preferredLabel']['zh'],)
        else:
            labels = (*concept['preferredLabel'].values(), *concept['aliases'])
        if any(normalize_label(value) == normalized for value in labels):
            matches.append(concept)
    return matches


def resolve_label(tag_catalog, label, facet=None, *, mode=LABEL_MODE_LEGACY):
    matches = resolve_label_candidates(tag_catalog, label, facet, mode=mode)
    return matches[0] if len(matches) == 1 else None


def resolve_current_label(tag_catalog, label, facet=None):
    """仅按已启用概念的中文首选名称查找标签。"""
    return resolve_label(tag_catalog, label, facet, mode=LABEL_MODE_CURRENT)


def ancestors(tag_catalog, cid):
    data = _registry_data(tag_catalog)
    ids = {concept['id']: concept for concept in data['concepts']}
    if not isinstance(cid, str) or cid not in ids:
        raise ValueError(f'概念 ID 不是字符串，或词表中不存在此 ID：{cid}。')
    result, parent_id = [], ids[cid]['broaderId']
    while parent_id is not None:
        result.append(parent_id)
        parent_id = ids[parent_id]['broaderId']
    return result


def prune_ancestors(tag_catalog, ids):
    _registry_data(tag_catalog)
    if not isinstance(ids, list) or any(not isinstance(cid, str) for cid in ids):
        raise ValueError('概念 ID 必须为字符串列表。')
    covered = {parent for cid in ids for parent in ancestors(tag_catalog, cid)}
    return [cid for cid in ids if cid not in covered]


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime(Path(__file__).name)
    print('这是共用标签词表模块；预览标签请使用 build-tag-preview.py。')
