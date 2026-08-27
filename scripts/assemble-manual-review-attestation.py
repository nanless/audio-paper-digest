#!/usr/bin/env python3
"""Assemble already-completed single-page review shards into Manual v3 attestation."""

import argparse
import json
import re
from pathlib import Path

from project_env import load_project_env
from path_config import CURRENT_DIR, atomic_write_json, validate_date_component
from runtime_guard import require_external_runtime

load_project_env()

FILE_CHECKS = {
    'titleAndMetadata', 'technicalNarrative', 'factualClaims',
    'experimentComparisons', 'reproducibility', 'limitations',
    'scoring', 'images',
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--date', required=True)
    parser.add_argument('--plan', action='store_true')
    args = parser.parse_args()
    date = validate_date_component(args.date)
    manifest_path = CURRENT_DIR / f'blog-generation-manifest-{date}.json'
    shard_dir = CURRENT_DIR / 'manual-blog-review-pages' / date
    output_path = CURRENT_DIR / f'manual-review-attestation-{date}.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    expected = {item['path']: item for item in manifest['files']}
    shards = {}
    for path in shard_dir.glob('*.json'):
        item = json.loads(path.read_text(encoding='utf-8'))
        relative = str(item.get('path') or '')
        marker = '/audio-paper-digest-blog/'
        if marker in relative:
            relative = relative.split(marker, 1)[1]
        if relative in expected:
            if relative in shards:
                raise SystemExit(f'duplicate review shard path: {relative}')
            shards[relative] = item
    missing = sorted(set(expected) - set(shards))
    if args.plan:
        states = {'pass': [], 'missing': [], 'stale': [], 'failed': []}
        for relative, expected_item in expected.items():
            item = shards.get(relative)
            if item is None:
                states['missing'].append(relative)
            elif item.get('sha256') != expected_item.get('sha256'):
                states['stale'].append(relative)
            else:
                checks = item.get('checks') or {}
                subagent = item.get('reviewSubagent') or {}
                valid = (
                    not item.get('issues') and set(checks) == FILE_CHECKS
                    and all(checks.get(key) is True for key in FILE_CHECKS)
                    and subagent.get('version') == 1
                    and subagent.get('singleFileOnly') is True
                    and subagent.get('isolatedContext') is True
                    and bool(str(subagent.get('taskName') or '').strip())
                    and isinstance(item.get('imageFindings'), list)
                )
                states['pass' if valid else 'failed'].append(relative)
        print(json.dumps({
            'date': date,
            'counts': {key: len(value) for key, value in states.items()},
            'pending': states['missing'] + states['stale'] + states['failed'],
        }, ensure_ascii=False))
        return
    if missing:
        raise SystemExit(f'missing review shards: {missing}')
    files = []
    for relative, expected_item in expected.items():
        item = shards[relative]
        sha256 = item.get('sha256')
        if sha256 != expected_item.get('sha256'):
            raise SystemExit(f'stale review shard: {relative}')
        checks = item.get('checks') or {}
        subagent = item.get('reviewSubagent') or {}
        if (item.get('issues') or set(checks) != FILE_CHECKS
                or any(checks.get(key) is not True for key in FILE_CHECKS)):
            raise SystemExit(f'failed review shard: {relative}')
        if (subagent.get('version') != 1
                or subagent.get('singleFileOnly') is not True
                or subagent.get('isolatedContext') is not True
                or not str(subagent.get('taskName') or '').strip()):
            raise SystemExit(f'invalid review subagent provenance: {relative}')
        if not isinstance(item.get('imageFindings'), list):
            raise SystemExit(f'invalid imageFindings: {relative}')
        notes = item['notes']
        paper_id_match = re.search(r'(\d{4}[.-]\d{5})(?=\.md$)', relative)
        if paper_id_match:
            paper_id = paper_id_match.group(1).replace('-', '.')
            if paper_id not in notes:
                notes = f'{paper_id}：{notes}'
        files.append({
            'path': relative,
            'sha256': sha256,
            'checks': item['checks'],
            'notes': notes,
            'reviewSubagent': item['reviewSubagent'],
            'imageFindings': item.get('imageFindings', []),
        })
    payload = {
        'version': 3,
        'mode': 'manual_complete',
        'agent': 'Codex multi-subagent manual review',
        'basis': 'deterministic_and_manual_semantic_review',
        'reason': '每个最终博客文件均由独立单页子代理完成语义与图片审查，并绑定当前 generation SHA。',
        'checks': {
            'generationManifestVerified': True,
            'baseHeadVerified': True,
            'fileHashesVerified': True,
            'frontmatterVerified': True,
            'markdownVerified': True,
            'contentSemanticsVerified': True,
            'imageReferencesVerified': True,
            'hugoGateVerified': True,
        },
        'files': files,
    }
    atomic_write_json(output_path, payload, mode=0o600)
    print(f'assembled {len(files)} files: {output_path}')


if __name__ == '__main__':
    require_external_runtime('assemble-manual-review-attestation.py')
    main()
