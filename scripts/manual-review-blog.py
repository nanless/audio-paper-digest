#!/usr/bin/env python3
"""Issue an explicitly attested manual_complete blog review receipt.

This command is only for an operator/agent takeover when the configured LLM
review service is unavailable.  It never calls an LLM and never downgrades the
ordinary review protocol: deterministic checks, exact file hashes, Hugo, Git
base, and the generation manifest remain mandatory.  The resulting receipt is
marked ``reviewMode=manual_complete`` and carries a separately hashed
attestation document so downstream push/status tooling can distinguish it from
an ordinary model review.
"""

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from project_env import load_project_env
load_project_env()

from blog_entry_loader import load_publish_to_blog
from runtime_guard import require_external_runtime


BJ = timezone(timedelta(hours=8))


def _now_bj():
    return datetime.now(BJ).isoformat(timespec='milliseconds')


def _sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _parse_args(module):
    parser = argparse.ArgumentParser(
        prog='manual-review-blog.py',
        description='在 LLM review 不可用时，以完整 provenance 签发 manual_complete 审查凭证。',
        allow_abbrev=False,
    )
    parser.add_argument('--date', required=True, metavar='YYYY-MM-DD')
    parser.add_argument('--attestation', required=True,
                        help='JSON 人工语义审查声明；必须声明所有检查为 true')
    args = parser.parse_args()
    return module.validate_publish_date(args.date), Path(args.attestation).expanduser().resolve()


def _load_attestation(path):
    try:
        raw = path.read_bytes()
        payload = json.loads(raw.decode('utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f'无法读取 attestation: {path}') from exc
    if not isinstance(payload, dict):
        raise ValueError('attestation 必须是 JSON 对象')
    if payload.get('version') != 1 or payload.get('mode') != 'manual_complete':
        raise ValueError('attestation version/mode 必须为 manual_complete v1')
    if not isinstance(payload.get('agent'), str) or not payload['agent'].strip():
        raise ValueError('attestation 缺少 agent')
    if payload.get('basis') != 'deterministic_and_manual_semantic_review':
        raise ValueError('attestation basis 非法')
    if not isinstance(payload.get('reason'), str) or len(payload['reason'].strip()) < 20:
        raise ValueError('attestation reason 至少需要 20 个字符')
    checks = payload.get('checks')
    required = {
        'generationManifestVerified', 'baseHeadVerified', 'fileHashesVerified',
        'frontmatterVerified', 'markdownVerified', 'contentSemanticsVerified',
        'imageReferencesVerified', 'hugoGateVerified',
    }
    if not isinstance(checks, dict) or set(checks) != required:
        raise ValueError('attestation checks 必须完整列出八项门禁')
    if any(checks.get(key) is not True for key in required):
        raise ValueError('attestation checks 必须全部为 true')
    return payload, hashlib.sha256(raw).hexdigest()


def _semantic_checks(module, paths, date_str):
    """Run conservative, deterministic content checks before attestation."""
    forbidden = (
        '该论文分析失败', '分析失败', 'latestAnalysisAttemptError',
        'TODO', '待补充', '模型自检', '这里需要生成最终文本',
    )
    checked = 0
    for path in paths:
        path = Path(path)
        if not path.is_file():
            continue
        text = path.read_text(encoding='utf-8')
        if not text.strip():
            raise module.PublishDataValidationError(f'页面为空: {path.name}')
        if any(marker in text for marker in forbidden):
            raise module.PublishDataValidationError(f'页面含失败/编辑残留标记: {path.name}')
        if path.name != f'{date_str}.md':
            if not re.search(r'^paper_digest_page_type:\s*paper\s*$', text, re.MULTILINE):
                raise module.PublishDataValidationError(f'论文页缺少所有权标记: {path.name}')
            if not re.search(r'^paper_digest_arxiv_id:\s*"?[^"\s]+"?\s*$', text, re.MULTILINE):
                raise module.PublishDataValidationError(f'论文页缺少 arXiv ID: {path.name}')
        for image in module.parse_markdown_images(text):
            url = image.get('url', '')
            if url.startswith(('http://', '//')):
                raise module.PublishDataValidationError(f'图片 URL 非 HTTPS: {path.name}')
        checked += 1
    if checked <= 0:
        raise module.PublishDataValidationError('没有可进行语义审查的页面')
    return checked


def _run(module, date_str, attestation_path):
    blog_repo, content_dir = module.validate_publish_target()
    paths, manifest_path = module.load_generation_manifest(date_str)
    base_head = module.validate_git_publish_branch()
    reusable = module.reusable_verified_publication_review(date_str, base_head)
    if reusable is not None:
        print('♻️ 当前 generation 已有严格发布凭证，manual_complete 不重复签发')
        return reusable[2]
    if module.has_publication_evidence_for_generation(date_str):
        raise module.PublishDataValidationError(
            '当前 generation 已有发布证据但未能严格复核，拒绝覆盖 receipt'
        )
    attestation, attestation_sha = _load_attestation(attestation_path)

    # Apply only deterministic, idempotent repairs.  A second pass must be
    # clean; unresolved defects are never hidden by manual provenance.
    fixes = []
    for path in paths:
        path = Path(path)
        if not path.is_file():
            continue
        fixed, first_issues = module.review_and_fix_post(path)
        _second_fixed, remaining = module.review_and_fix_post(path)
        if remaining:
            raise module.PublishDataValidationError(
                f'确定性 review 仍有阻断问题 {path.name}: {remaining}'
            )
        if fixed:
            fixes.append({'path': str(path), 'issues': [str(item) for item in first_issues]})

    module.validate_staged_posts(content_dir, date_str, date_only=True)
    checked_files = _semantic_checks(module, paths, date_str)
    gate = module.run_hugo_gate(blog_repo, content_dir, required=True)
    module.validate_staged_posts(content_dir, date_str, date_only=True)

    protocol = module.review_protocol_fingerprint()
    reviewed = {}
    for path in paths:
        path = Path(path).resolve()
        if not path.is_file():
            continue
        reviewed[str(path)] = {
            'passed': True,
            'completed': True,
            'failureKind': None,
            'reviewedSha256': module._sha256_file(path),
            'reviewProtocolFingerprint': protocol,
            'imageReviewMode': 'deterministic_only',
        }
    if len(reviewed) != len([path for path in paths if Path(path).is_file()]):
        raise module.PublishDataValidationError('reviewed 文件数量在签发前发生变化')
    manifest_sha = _sha256(manifest_path)
    provenance = dict(attestation)
    provenance.pop('checks', None)
    provenance['completedAt'] = _now_bj()
    provenance['checks'] = attestation['checks']
    provenance['attestationSha256'] = attestation_sha
    provenance['generationManifestSha256'] = manifest_sha
    provenance['baseHead'] = base_head
    provenance['fileCount'] = len(paths)
    provenance['reviewProtocolFingerprint'] = protocol
    provenance['deterministicFixes'] = fixes
    provenance['checkedFiles'] = checked_files
    receipt = module.save_review_receipt(
        date_str, paths, gate, expected_base_head=base_head,
        generation_manifest=manifest_path, reviewed_results=reviewed,
        review_provenance=provenance,
    )
    print(f'🧾 manual_complete 审查凭证: {receipt}')
    print(f'   provenance SHA: {attestation_sha}')
    return receipt


def main():
    require_external_runtime('manual-review-blog.py')
    from log_setup import setup_script_logging
    setup_script_logging(__file__)
    module = load_publish_to_blog()
    try:
        date_str, attestation = _parse_args(module)
        with module.blog_publication_lock(date_str):
            receipt = _run(module, date_str, attestation)
    except (ValueError, module.PublishDataValidationError) as exc:
        print(f'\n❌ manual_complete review 失败，未签发凭证: {exc}')
        sys.exit(1)
    except TimeoutError as exc:
        print(f'\n❌ 博客仓库或同日期事务正在运行: {exc}')
        sys.exit(1)
    print(f'\n✅ manual_complete review 完成；下一步: python3 scripts/push-blog.py --date {date_str}')
    return receipt


if __name__ == '__main__':
    main()
