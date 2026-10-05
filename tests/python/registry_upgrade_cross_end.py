#!/usr/bin/env python3
"""跨端词表升级测试的辅助入口，不属于 unittest 用例。

读取共享样本 tests/fixtures/registry-upgrade-cross-end.json，调用 Python
接口 _validate_tag_catalog_upgrade。以 CROSS_END_RESULT: 开头输出一行 JSON，
供 tests/tag-catalog-change.test.js 与 Node 的结果逐项比较。
"""

import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

from publish_common import _validate_tag_catalog_upgrade  # noqa: E402

FIXTURE = os.path.join(ROOT, 'tests', 'fixtures', 'registry-upgrade-cross-end.json')
MARKER = 'CROSS_END_RESULT:'


def main():
    with open(FIXTURE, encoding='utf-8') as handle:
        fixture = json.load(handle)
    results = []
    for case in fixture['cases']:
        outcome = _validate_tag_catalog_upgrade(
            case['fromRegistrySha256'], case.get('conceptIds'), case.get('annotation'))
        detail = outcome.get('detail') or {}
        results.append({
            'name': case['name'],
            'ok': outcome['ok'],
            'changeLevel': outcome['changeLevel'],
            'summary': detail.get('summary'),
            'reasonCodes': sorted({reason['code'] for reason in detail.get('reasons', [])})
            if outcome['detail'] is not None else None,
            'counts': detail.get('counts'),
            'error': outcome['error'],
        })
    print(MARKER + json.dumps(results, ensure_ascii=False, sort_keys=True))


if __name__ == '__main__':
    main()
