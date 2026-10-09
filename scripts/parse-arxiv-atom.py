#!/usr/bin/env python3
"""严格解析抓取阶段的 Atom 响应，只向标准输出写入结构化 JSON。"""

import json
import re
import sys
import xml.etree.ElementTree as ET

from runtime_guard import require_external_runtime

MAX_BYTES = 16 * 1024 * 1024
ATOM_NAMESPACE = 'http://www.w3.org/2005/Atom'
ARXIV_URL = re.compile(
    r'https?://arxiv\.org/abs/((?:[0-9]{4}\.[0-9]{4,5}|[a-z-]+(?:\.[A-Z]{2})?/[0-9]{7})(?:v[1-9][0-9]*)?)'
)


def parse_atom(source):
    if re.search(r'<!\s*(?:DOCTYPE|ENTITY)\b', source, re.IGNORECASE):
        raise ValueError('Atom 响应不能包含文档类型或实体声明')
    root = ET.fromstring(source)
    if root.tag == 'feed':
        prefix = ''
    elif root.tag == f'{{{ATOM_NAMESPACE}}}feed':
        prefix = f'{{{ATOM_NAMESPACE}}}'
    else:
        raise ValueError('Atom 响应的根元素必须是 feed')
    entries = root.findall(f'{prefix}entry')
    all_entries = [element for element in root.iter()
                   if element.tag.rsplit('}', 1)[-1] == 'entry']
    if len(entries) != len(all_entries):
        raise ValueError('Atom 论文条目必须使用 feed 的命名空间，并且是其直接子元素')
    records = []
    for entry in entries:
        def field(name, required=False):
            values = entry.findall(f'{prefix}{name}')
            if len(values) > 1 or (required and len(values) != 1):
                raise ValueError(f'Atom 条目必须包含唯一的 {name}')
            value = ''.join(values[0].itertext()).replace('\n', ' ').strip() if values else ''
            if required and not value:
                raise ValueError(f'Atom 条目的 {name} 不能为空')
            return value

        identity = field('id', required=True)
        match = ARXIV_URL.fullmatch(identity)
        if not match:
            raise ValueError('Atom 条目不是完整的官方 arXiv 论文地址，不能采用错误条目或截断 ID')
        records.append({
            'arxivId': match[1],
            'title': field('title', required=True),
            'abstract': field('summary', required=True),
            'authors': [''.join(name.itertext()).strip()
                        for author in entry.findall(f'{prefix}author')
                        for name in author.findall(f'{prefix}name')],
            'published': field('published'),
            'categories': [category.get('term', '')
                           for category in entry.findall(f'{prefix}category')],
        })
    return records


def main():
    require_external_runtime('parse-arxiv-atom.py')
    raw = sys.stdin.buffer.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError(f'Atom 响应超过 {MAX_BYTES} 字节上限')
    records = parse_atom(raw.decode('utf-8', errors='strict'))
    encoded = json.dumps(records, ensure_ascii=False).encode('utf-8')
    if len(encoded) > MAX_BYTES:
        raise ValueError(f'Atom 解析结果超过 {MAX_BYTES} 字节上限')
    sys.stdout.buffer.write(encoded)


if __name__ == '__main__':
    main()
