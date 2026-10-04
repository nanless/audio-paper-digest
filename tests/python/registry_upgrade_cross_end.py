#!/usr/bin/env python3
"""跨端一致性 harness（不是 unittest 用例）。

读取共享 fixture tests/fixtures/registry-upgrade-cross-end.json，把同一份
(旧 registry SHA, registryUpgradeFrom 注记, conceptIds) 输入喂给 Python 侧
升级门 `_seal_registry_upgrade`（scripts/publish_common.py，Node
validateSealRegistryUpgrade 的镜像），并在一行标记前输出 JSON 结果，
供 tests/tag-catalog-change.test.js spawn 后与 Node 输出逐项比对。
"""

import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

from publish_common import _seal_registry_upgrade  # noqa: E402

FIXTURE = os.path.join(ROOT, 'tests', 'fixtures', 'registry-upgrade-cross-end.json')
MARKER = 'CROSS_END_RESULT:'


def main():
    with open(FIXTURE, encoding='utf-8') as handle:
        fixture = json.load(handle)
    results = []
    for case in fixture['cases']:
        outcome = _seal_registry_upgrade(
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
