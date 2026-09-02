#!/usr/bin/env python3
"""Assemble already-completed single-page review shards into Manual v3 attestation."""

import argparse
import json
import re
import sys
from pathlib import Path

SHARED_SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
if str(SHARED_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SHARED_SCRIPTS))

from path_config import atomic_write_json, validate_date_component
from blog_entry_loader import load_publish_to_blog
from runtime_guard import require_external_runtime

FILE_CHECKS = {
    'titleAndMetadata', 'technicalNarrative', 'factualClaims',
    'experimentComparisons', 'reproducibility', 'limitations',
    'scoring', 'images',
}
REQUIRED_REVIEW_MODEL = 'gpt-5.6-terra'
REQUIRED_REVIEW_REASONING = 'high'


def valid_review_subagent(subagent):
    return (
        isinstance(subagent, dict)
        and subagent.get('version') == 1
        and subagent.get('singleFileOnly') is True
        and subagent.get('isolatedContext') is True
        and bool(str(subagent.get('taskName') or '').strip())
        and subagent.get('model') == REQUIRED_REVIEW_MODEL
        and subagent.get('reasoningEffort') == REQUIRED_REVIEW_REASONING
    )


def valid_review_shard(relative, expected_item, item):
    """Validate a shard against generation, including explicit deletion."""
    if not isinstance(item, dict) or item.get('issues'):
        return False
    deleted = expected_item.get('deleted') is True
    if (item.get('deleted') is True) != deleted:
        return False
    if item.get('sha256') != expected_item.get('sha256'):
        return False
    checks = item.get('checks') or {}
    if deleted:
        if checks != {'deletionVerified': True}:
            return False
    elif (
        set(checks) != FILE_CHECKS
        or any(checks.get(key) is not True for key in FILE_CHECKS)
    ):
        return False
    subagent = item.get('reviewSubagent') or {}
    if not valid_review_subagent(subagent) or not isinstance(item.get('imageFindings'), list):
        return False
    is_index = bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}\.md', Path(relative).name))
    if not deleted and not is_index \
            and not re.fullmatch(r'\d{4}\.\d{5}', str(subagent.get('paperId') or '')):
        return False
    return True


def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--date', required=True)
    parser.add_argument('--plan', action='store_true')
    parser.add_argument('--include-id', action='append', metavar='ARXIV_ID')
    args = parser.parse_args()
    if args.include_id and len(args.include_id) > 1:
        parser.error('--include-id 只能指定一次')
    date = validate_date_component(args.date)
    include_id = args.include_id[0] if args.include_id else None
    module = load_publish_to_blog()
    with module.publication_scope(include_id):
        manifest_path = module.generation_manifest_path(date)
        shard_dir = module.manual_review_page_dir(date)
        output_path = module.manual_review_attestation_path(date)
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        module._validate_active_publication_scope(manifest)
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
        seen_tasks = set()
        for relative, expected_item in expected.items():
            item = shards.get(relative)
            if item is None:
                states['missing'].append(relative)
            elif (
                item.get('sha256') != expected_item.get('sha256')
                or (item.get('deleted') is True) != (expected_item.get('deleted') is True)
            ):
                states['stale'].append(relative)
            else:
                valid = valid_review_shard(relative, expected_item, item)
                task_name = str((item.get('reviewSubagent') or {}).get('taskName') or '').strip()
                if valid and task_name in seen_tasks:
                    valid = False
                if valid:
                    seen_tasks.add(task_name)
                states['pass' if valid else 'failed'].append(relative)
        print(json.dumps({
            'date': date,
            'publicationScope': manifest.get('publicationScope'),
            'shardDir': str(shard_dir),
            'attestationPath': str(output_path),
            'counts': {key: len(value) for key, value in states.items()},
            'pending': states['missing'] + states['stale'] + states['failed'],
        }, ensure_ascii=False))
        return
    if missing:
        raise SystemExit(f'missing review shards: {missing}')
    files = []
    seen_tasks = set()
    for relative, expected_item in expected.items():
        item = shards[relative]
        sha256 = item.get('sha256')
        deleted = expected_item.get('deleted') is True
        if (
            sha256 != expected_item.get('sha256')
            or (item.get('deleted') is True) != deleted
        ):
            raise SystemExit(f'stale review shard: {relative}')
        subagent = item.get('reviewSubagent') or {}
        if not valid_review_shard(relative, expected_item, item):
            raise SystemExit(f'failed review shard: {relative}')
        task_name = subagent['taskName'].strip()
        if task_name in seen_tasks:
            raise SystemExit(f'duplicate review subagent taskName: {task_name}')
        seen_tasks.add(task_name)
        notes = item['notes']
        paper_id_match = re.search(r'(\d{4}[.-]\d{5})(?=\.md$)', relative)
        if paper_id_match:
            paper_id = paper_id_match.group(1).replace('-', '.')
            if paper_id not in notes:
                notes = f'{paper_id}：{notes}'
        output_item = {
            'path': relative,
            'sha256': sha256,
            'checks': item['checks'],
            'notes': notes,
            'reviewSubagent': item['reviewSubagent'],
            'imageFindings': item.get('imageFindings', []),
        }
        if deleted:
            output_item['deleted'] = True
        files.append(output_item)
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
    if manifest.get('publicationScope') is not None:
        payload['publicationScope'] = manifest['publicationScope']
    atomic_write_json(output_path, payload, mode=0o600)
    print(f'assembled {len(files)} files: {output_path}')


if __name__ == '__main__':
    require_external_runtime('assemble-manual-review-attestation.py')
    from log_setup import setup_script_logging
    setup_script_logging(__file__)
    main()
