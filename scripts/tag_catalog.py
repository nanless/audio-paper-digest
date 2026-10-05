"""读取并核验标签词表，按指定规则查找标签对应的概念。"""

import hashlib
import json
import re
import unicodedata
from pathlib import Path

FACET_IDS = ('task', 'method', 'setting', 'signal', 'application',
             'research_focus', 'artifact', 'scientific_topic', 'model_family')
TAG_CATALOG_VERSION = 'paper-tag-catalog-v2'
LEGACY_TAG_CATALOG_VERSION = 'paper-taxonomy-v1'
LABEL_MODE_CURRENT = 'current'
LABEL_MODE_LEGACY = 'legacy'
LABEL_MODES = (LABEL_MODE_CURRENT, LABEL_MODE_LEGACY)
TAG_PROMPT_TEXT_CONTRACT = 'paper-tag-prompt-text-v2'
LEGACY_TAG_PROMPT_TEXT_CONTRACT = 'paper-taxonomy-prompt-projection-v1'
TAG_SELECTION_CONTRACT = 'paper-tag-selection-v2'
LEGACY_TAG_SELECTION_CONTRACT = 'paper-taxonomy-selection-v1'
TAG_FLAT_COMPAT_CONTRACT = 'paper-tag-flat-tags-v2'
LEGACY_TAG_FLAT_COMPAT_CONTRACT = 'paper-taxonomy-flat-tags-compat-v1'
CONCEPT_KEYS = {'id', 'facet', 'preferredLabel', 'aliases', 'broaderId',
                'definition', 'scopeNote', 'status', 'replacedBy'}
# 按 ECMAScript String.trim 的空白字符处理，包括 BOM；Python 默认 strip 的字符范围与它不同。
_JS_WHITESPACE = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'


def normalize_label(value):
    if not isinstance(value, str):
        return ''
    result = unicodedata.normalize('NFKC', value).strip(_JS_WHITESPACE)
    if result.startswith('#'):
        result = result[1:].strip(_JS_WHITESPACE)
    return re.sub('[A-Z]', lambda match: match.group().lower(), result)


def _require_exact_object_fields(value, keys, name):
    if type(value) is not dict or set(value) != set(keys):
        raise ValueError(f'{name} 必须是对象，且字段不能缺失或超出允许范围。')


def _validate_catalog_string(value, name):
    if (not isinstance(value, str) or not value.strip(_JS_WHITESPACE)
            or value != value.strip(_JS_WHITESPACE) or re.search(r'[\x00-\x1f\x7f]', value)):
        raise ValueError(f'{name} 必须是非空字符串，不能含首尾空白或控制字符。')


def validate_tag_catalog(data):
    _require_exact_object_fields(data, {'version', 'facets', 'concepts'}, '标签词表')
    if data['version'] not in (TAG_CATALOG_VERSION, LEGACY_TAG_CATALOG_VERSION):
        raise ValueError('标签词表的版本不受支持。')
    if not isinstance(data['facets'], list) or len(data['facets']) != len(FACET_IDS):
        raise ValueError('标签词表的分类维度必须是包含九项的列表。')
    seen_facet_ids = set()
    for facet in data['facets']:
        _require_exact_object_fields(facet, {'id', 'label'}, '分类维度记录')
        if facet['id'] not in FACET_IDS or facet['id'] in seen_facet_ids:
            raise ValueError('标签词表含有未知或重复的分类维度。')
        _validate_catalog_string(facet['label'], '分类维度名称')
        seen_facet_ids.add(facet['id'])
    if not isinstance(data['concepts'], list) or not data['concepts']:
        raise ValueError('标签词表中的概念必须是非空列表。')
    concepts_by_id, concept_ids_by_facet_and_label = {}, {}
    for concept in data['concepts']:
        _require_exact_object_fields(concept, CONCEPT_KEYS, '概念记录')
        facet, concept_id = concept['facet'], concept['id']
        if (not isinstance(facet, str) or facet not in seen_facet_ids or not isinstance(concept_id, str)
                or not re.fullmatch(re.escape(facet) + r'\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*', concept_id)
                or concept_id in concepts_by_id):
            raise ValueError('概念的分类维度或 ID 格式无效，或 ID 重复。')
        _require_exact_object_fields(concept['preferredLabel'], {'zh', 'en'}, f'{concept_id}.preferredLabel')
        for language in ('zh', 'en'):
            _validate_catalog_string(concept['preferredLabel'][language], f'{concept_id}.{language}')
        _validate_catalog_string(concept['definition'], f'{concept_id}.definition')
        _validate_catalog_string(concept['scopeNote'], f'{concept_id}.scopeNote')
        if not isinstance(concept['aliases'], list):
            raise ValueError(f'{concept_id} 的别名必须为列表。')
        normalized_aliases = set()
        for alias in concept['aliases']:
            _validate_catalog_string(alias, f'{concept_id}.alias')
            normalized = normalize_label(alias)
            if not normalized or normalized in normalized_aliases:
                raise ValueError(f'{concept_id} 的别名经统一格式处理后为空，或存在重复。')
            normalized_aliases.add(normalized)
        if concept['status'] not in ('active', 'deprecated'):
            raise ValueError(f'{concept_id} 的状态必须为 active 或 deprecated。')
        if concept['broaderId'] is not None and not isinstance(concept['broaderId'], str):
            raise ValueError(f'{concept_id} 的上级概念 ID 必须为字符串或 null。')
        if concept['status'] == 'active' and concept['replacedBy'] is not None:
            raise ValueError(f'{concept_id} 已启用，不能设置替代概念。')
        if concept['status'] == 'deprecated' and (not isinstance(concept['replacedBy'], str) or not concept['replacedBy']):
            raise ValueError(f'{concept_id} 已停用，必须填写非空字符串形式的替代概念 ID。')
        concepts_by_id[concept_id] = concept
        for label in [*concept['preferredLabel'].values(), *concept['aliases']]:
            normalized = normalize_label(label)
            if not normalized:
                raise ValueError(f'{concept_id} 的名称经统一格式处理后为空。')
            key = (facet, normalized)
            if key in concept_ids_by_facet_and_label and concept_ids_by_facet_and_label[key] != concept_id:
                raise ValueError(f'分类维度 {facet} 中的名称 {label} 对应多个概念。')
            concept_ids_by_facet_and_label[key] = concept_id
    for concept in data['concepts']:
        concept_id, parent_id = concept['id'], concept['broaderId']
        if parent_id is not None:
            parent = concepts_by_id.get(parent_id)
            if not parent or parent['facet'] != concept['facet'] or parent['status'] != 'active':
                raise ValueError(f'{concept_id} 的上级概念必须存在、已启用，并属于同一分类维度。')
        if concept['status'] == 'deprecated':
            replacement = concepts_by_id.get(concept['replacedBy'])
            if (not replacement or replacement['id'] == concept_id or replacement['status'] != 'active'
                    or replacement['facet'] != concept['facet']):
                raise ValueError(f'{concept_id} 的替代概念必须是同一分类维度中另一个已启用的概念。')
        seen = {concept_id}
        while parent_id is not None:
            if parent_id in seen:
                raise ValueError(f'{concept_id} 的上级概念链存在循环。')
            seen.add(parent_id)
            parent = concepts_by_id.get(parent_id)
            if not parent:
                raise ValueError(f'{concept_id} 的上级概念链包含不存在的概念。')
            parent_id = parent['broaderId']
    return data


def _validate_tag_catalog_content(tag_catalog):
    """核验词表及可选 SHA 字段的格式，返回不含 SHA 元数据的词表内容。"""
    if not isinstance(tag_catalog, dict):
        raise ValueError('标签词表必须为对象。')
    expected = {'version', 'facets', 'concepts'}
    if 'registrySha256' in tag_catalog:
        expected.add('registrySha256')
        if not isinstance(tag_catalog['registrySha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', tag_catalog['registrySha256']):
            raise ValueError('标签词表记录中的 registrySha256 格式无效。')
    _require_exact_object_fields(tag_catalog, expected, '标签词表')
    return validate_tag_catalog({key: tag_catalog.get(key) for key in ('version', 'facets', 'concepts')})


def load_tag_catalog(file_path=None):
    uses_default_catalog = file_path is None
    if uses_default_catalog:
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
    # 解析时移除 UTF-8 BOM，并按 Node TextDecoder 的规则拒绝无效编码；
    # SHA 仍根据完整原始文件字节计算。
    data = validate_tag_catalog(json.loads(raw.decode('utf-8-sig'), object_pairs_hook=unique_object))
    if uses_default_catalog and data['version'] != TAG_CATALOG_VERSION:
        raise ValueError('当前标签词表必须使用 paper-tag-catalog-v2。')
    return {**data, 'registrySha256': hashlib.sha256(raw).hexdigest()}


def active_preferred_labels(tag_catalog, facets=None):
    """返回指定分类维度中已启用概念的中文首选名称。"""
    data = _validate_tag_catalog_content(tag_catalog)
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


def build_tag_prompt_text(tag_catalog, prompt_text_contract=TAG_PROMPT_TEXT_CONTRACT):
    """按指定版本生成标签提示；默认用于新请求，旧版只供明确的旧记录核验。"""
    if not isinstance(prompt_text_contract, str) or prompt_text_contract not in (
            LEGACY_TAG_PROMPT_TEXT_CONTRACT, TAG_PROMPT_TEXT_CONTRACT):
        raise ValueError('标签提示文本的版本不受支持。')
    data = _validate_tag_catalog_content(tag_catalog)
    registry_sha = tag_catalog.get('registrySha256')
    if not isinstance(registry_sha, str) or not re.fullmatch(r'[a-f0-9]{64}', registry_sha):
        raise ValueError('生成标签提示文本需要格式有效的词表 SHA。')
    facet_position_by_id = {facet['id']: index for index, facet in enumerate(data['facets'])}
    active_concepts = sorted(
        (concept for concept in data['concepts'] if concept['status'] == 'active'),
        key=lambda concept: (facet_position_by_id[concept['facet']], concept['id']),
    )
    lines = [
        f'contract={prompt_text_contract}',
        f'registry_version={data["version"]}',
        f'registry_sha256={registry_sha}',
        ('只允许输出下列 active 概念的中文首选标签；ID 用于消歧，不得自造标签或输出同义词。'
         if prompt_text_contract == LEGACY_TAG_PROMPT_TEXT_CONTRACT else
         '只能选择以下已启用概念的中文首选标签。ID 用于区分概念；不要创建新标签，也不要改用同义词。'),
    ]
    current_facet = None
    for concept in active_concepts:
        if concept['facet'] != current_facet:
            current_facet = concept['facet']
            lines.append(f'[{current_facet}]')
        format_prompt_field = lambda value: re.sub(
            r'\s+', ' ', re.sub(r'[\r\n|]+', ' ', str(value or ''))).strip()
        lines.append('|'.join((
            concept['id'], f'#{concept["preferredLabel"]["zh"]}',
            format_prompt_field(concept['definition']), format_prompt_field(concept['scopeNote']),
        )))
    return '\n'.join(lines) + '\n'


def tag_prompt_text_sha256(tag_catalog, prompt_text_contract=TAG_PROMPT_TEXT_CONTRACT):
    return hashlib.sha256(build_tag_prompt_text(
        tag_catalog, prompt_text_contract).encode('utf-8')).hexdigest()


def resolve_label_candidates(tag_catalog, label, facet=None, *, mode=LABEL_MODE_LEGACY):
    """查找标签对应的概念；无法唯一确定时不替调用方作选择。

    current 模式只接受已启用概念的中文首选名称，并按既有规则统一名称格式。
    legacy 模式另接受英文名称、别名和停用概念。为兼容历史审计，本函数默认
    使用 legacy；生产调用须使用 resolve_current_label 或明确传入 mode='current'。
    调用方仍须拒绝停用概念，不能自动沿 replacedBy 改用替代概念。
    """
    data = _validate_tag_catalog_content(tag_catalog)
    if facet is not None and facet not in FACET_IDS:
        raise ValueError(f'未知的分类维度：{facet}。')
    if mode not in LABEL_MODES:
        raise ValueError(f'未知的标签查找模式：{mode}。')
    normalized = normalize_label(label)
    if not normalized:
        return []
    matching_concepts = []
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
            matching_concepts.append(concept)
    return matching_concepts


def resolve_label(tag_catalog, label, facet=None, *, mode=LABEL_MODE_LEGACY):
    matching_concepts = resolve_label_candidates(tag_catalog, label, facet, mode=mode)
    return matching_concepts[0] if len(matching_concepts) == 1 else None


def resolve_current_label(tag_catalog, label, facet=None):
    """仅按已启用概念的中文首选名称查找标签。"""
    return resolve_label(tag_catalog, label, facet, mode=LABEL_MODE_CURRENT)


def ancestors(tag_catalog, cid):
    data = _validate_tag_catalog_content(tag_catalog)
    concepts_by_id = {concept['id']: concept for concept in data['concepts']}
    if not isinstance(cid, str) or cid not in concepts_by_id:
        raise ValueError(f'概念 ID 不是字符串，或词表中不存在此 ID：{cid}。')
    ancestor_ids, parent_id = [], concepts_by_id[cid]['broaderId']
    while parent_id is not None:
        ancestor_ids.append(parent_id)
        parent_id = concepts_by_id[parent_id]['broaderId']
    return ancestor_ids


def prune_ancestors(tag_catalog, ids):
    _validate_tag_catalog_content(tag_catalog)
    if not isinstance(ids, list) or any(not isinstance(cid, str) for cid in ids):
        raise ValueError('概念 ID 必须为字符串列表。')
    covered = {parent for cid in ids for parent in ancestors(tag_catalog, cid)}
    return [cid for cid in ids if cid not in covered]


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime(Path(__file__).name)
    print('这是共用标签词表模块；预览标签请使用 build-tag-preview.py。')
