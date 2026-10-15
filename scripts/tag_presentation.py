"""只将实际命中的受控标签投影为分类路径，不为论文追加上位标签。"""

import html
import re
from urllib.parse import parse_qs, quote, urlsplit

from tag_catalog import _validate_tag_catalog_content
from path_config import resolve_blog_base_path

FACET_DISPLAY_LABELS = {
    'task': '研究任务', 'method': '研究方法', 'setting': '研究条件',
    'signal': '信号', 'application': '应用', 'research_focus': '研究重点',
    'artifact': '研究产物', 'scientific_topic': '科学主题', 'model_family': '模型家族',
}
TAG_HIERARCHY_START = '<!--paper-tag-hierarchy-v1:start-->'
TAG_HIERARCHY_END = '<!--paper-tag-hierarchy-v1:end-->'


def build_tag_hierarchy(metadata, catalog):
    """输入必须绑定同一真实词表；输出仅含命中维度和命中概念的祖先路径。"""
    _validate_tag_catalog_content(catalog)
    if (not isinstance(metadata, dict)
            or not re.fullmatch(r'[a-f0-9]{64}', str(catalog.get('registrySha256') or ''))
            or metadata.get('registryVersion') != catalog['version']
            or metadata.get('registrySha256') != catalog['registrySha256']
            or not isinstance(metadata.get('concepts'), list)):
        raise ValueError('标签展示必须绑定同一词表版本、SHA 和实际所选概念。')
    by_id = {item['id']: item for item in catalog['concepts']}
    selected, seen = [], set()
    for item in metadata['concepts']:
        if not isinstance(item, dict):
            raise ValueError('标签展示的所选概念必须为对象。')
        concept = by_id.get(item.get('id')) if isinstance(item.get('id'), str) else None
        if (concept is None or concept['status'] != 'active' or concept['id'] in seen
                or item.get('facet') != concept['facet']
                or item.get('label') != concept['preferredLabel']['zh']):
            raise ValueError('标签展示包含重复、未知、停用或名称/维度不一致的所选概念。')
        seen.add(concept['id'])
        selected.append(concept)
    facets = []
    for facet in catalog['facets']:
        paths = []
        for concept in selected:
            if concept['facet'] != facet['id']:
                continue
            path, node = [], concept
            while node is not None:
                path.append({'id': node['id'], 'label': node['preferredLabel']['zh'],
                             'selected': node['id'] == concept['id']})
                node = by_id.get(node['broaderId']) if node['broaderId'] is not None else None
            paths.append({'selectedId': concept['id'], 'nodes': list(reversed(path))})
        if paths:
            facets.append({'id': facet['id'], 'label': FACET_DISPLAY_LABELS[facet['id']], 'paths': paths})
    return facets


def _markdown_text(value):
    return re.sub(r'([\\`*_{\[\]}()|])', r'\\\1', html.escape(str(value), quote=False))


def _tag_link(concept_id, label, base_path):
    return f'[{_markdown_text(label)}]({base_path}/papers/?concept={quote(concept_id, safe="")})'


def render_tag_hierarchy_markdown(metadata, catalog, *, heading='研究分类', base_path=None):
    facets = build_tag_hierarchy(metadata, catalog)
    base_path = resolve_blog_base_path(base_path)
    if not facets:
        return ''
    lines = [TAG_HIERARCHY_START, '', f'**{_markdown_text(heading)}**', '']
    for facet in facets:
        paths = [' → '.join(_tag_link(node['id'], node['label'], base_path) for node in path['nodes'])
                 for path in facet['paths']]
        lines.append(f'- **{facet["label"]}**：' + '；'.join(paths))
    return '\n'.join(lines) + '\n\n' + TAG_HIERARCHY_END + '\n\n'


def mask_verified_tag_hierarchy_for_quality(markdown, catalog=None, *, base_path=None):
    """仅在质量检查副本中屏蔽逐字重放相等的目录元数据，异常边界或内容拒绝。"""
    text = str(markdown or '')
    starts, ends = text.count(TAG_HIERARCHY_START), text.count(TAG_HIERARCHY_END)
    if not starts and not ends:
        if '<!--paper-tag-hierarchy-v1:' in text:
            raise ValueError('多级分类块使用了未知边界。')
        return text
    if starts != ends or starts > 10000 \
            or text.count('<!--paper-tag-hierarchy-v1:') != starts + ends:
        raise ValueError('多级分类块的边界缺失、嵌套或格式无效。')
    if catalog is None:
        from tag_catalog import load_tag_catalog
        catalog = load_tag_catalog()
    _validate_tag_catalog_content(catalog)
    by_id = {item['id']: item for item in catalog['concepts']}
    pattern = re.compile(re.escape(TAG_HIERARCHY_START) + r'[\s\S]*?' + re.escape(TAG_HIERARCHY_END))
    blocks = list(pattern.finditer(text))
    if len(blocks) != starts:
        raise ValueError('多级分类块的边界顺序无效。')

    def verified(match):
        block = match.group(0)
        if block.count(TAG_HIERARCHY_START) != 1 or block.count(TAG_HIERARCHY_END) != 1:
            raise ValueError('多级分类块不能嵌套。')
        ids = []
        for line in block.splitlines()[4:-2]:
            facet = re.fullmatch(r'- \*\*[^*\n]+\*\*：(.+)', line)
            if facet is None:
                raise ValueError('多级分类块包含非目录内容。')
            for path in facet.group(1).split('；'):
                terminal = re.fullmatch(r'\[(?:\\.|[^\]\\\n])+\]\(([^()\s]+)\)', path.split(' → ')[-1])
                if terminal is None:
                    raise ValueError('多级分类路径缺少完整的直接概念链接。')
                query = parse_qs(urlsplit(terminal.group(1)).query, strict_parsing=True)
                if set(query) != {'concept'} or len(query['concept']) != 1:
                    raise ValueError('多级分类路径不是唯一概念导航。')
                ids.append(query['concept'][0])
        if not 1 <= len(ids) <= 5 or len(set(ids)) != len(ids) or any(cid not in by_id for cid in ids):
            raise ValueError('多级分类块包含重复、未知或过多的直接概念。')
        metadata = {'registryVersion': catalog['version'], 'registrySha256': catalog['registrySha256'],
                    'concepts': [{'id': cid, 'facet': by_id[cid]['facet'],
                                  'label': by_id[cid]['preferredLabel']['zh']} for cid in ids]}
        expected = render_tag_hierarchy_markdown(metadata, catalog, base_path=base_path).rstrip('\n')
        if block != expected:
            raise ValueError('多级分类块与当前目录、部署路径及共享展示的逐字重放不一致。')
        return '\n\n已核验分类。\n\n'

    return pattern.sub(verified, text)


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('tag_presentation.py')
    raise SystemExit('这是标签层级展示模块，请通过正常页面发布入口使用。')
