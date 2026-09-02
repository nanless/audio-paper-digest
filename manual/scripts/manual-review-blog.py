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

SHARED_SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
if str(SHARED_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SHARED_SCRIPTS))

from blog_entry_loader import load_publish_to_blog
from runtime_guard import require_external_runtime

REQUIRED_REVIEW_MODEL = 'gpt-5.6-terra'
REQUIRED_REVIEW_REASONING = 'high'


BJ = timezone(timedelta(hours=8))


def _now_bj():
    return datetime.now(BJ).isoformat(timespec='milliseconds')


def _sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _parse_args(module, argv=None):
    parser = argparse.ArgumentParser(
        prog='manual-review-blog.py',
        description='在 LLM review 不可用时，以完整 provenance 签发 manual_complete 审查凭证。',
        allow_abbrev=False,
    )
    parser.add_argument('--date', required=True, metavar='YYYY-MM-DD')
    parser.add_argument('--attestation', required=True,
                        help='JSON 人工语义审查声明；必须声明所有检查为 true')
    parser.add_argument('--include-id', action='append', metavar='ARXIV_ID',
                        help='只签发该单篇灰度 generation 的 Manual review 凭证')
    args = parser.parse_args(argv)
    if args.include_id and len(args.include_id) > 1:
        parser.error('--include-id 只能指定一次')
    return (
        module.validate_publish_date(args.date),
        Path(args.attestation).expanduser().resolve(),
        args.include_id[0] if args.include_id else None,
    )


def _load_attestation(path):
    try:
        raw = path.read_bytes()
        payload = json.loads(raw.decode('utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f'无法读取 attestation: {path}') from exc
    if not isinstance(payload, dict):
        raise ValueError('attestation 必须是 JSON 对象')
    if payload.get('version') not in (2, 3) or payload.get('mode') != 'manual_complete':
        raise ValueError('attestation version/mode 必须为历史 v2 或当前 manual_complete v3')
    current_v3 = payload.get('version') == 3
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
    files = payload.get('files')
    file_checks = {
        'titleAndMetadata', 'technicalNarrative', 'factualClaims',
        'experimentComparisons', 'reproducibility', 'limitations',
        'scoring', 'images',
    }
    if not isinstance(files, list) or not files:
        raise ValueError('attestation.files 必须逐文件列出语义审查')
    seen = set()
    seen_notes = set()
    seen_subagent_tasks = set()
    for index, item in enumerate(files):
        if not isinstance(item, dict):
            raise ValueError(f'attestation.files[{index}] 必须是对象')
        deleted = item.get('deleted') is True
        allowed = {'path', 'sha256', 'checks', 'notes', 'deleted'}
        required_fields = {'path', 'sha256', 'checks', 'notes'}
        if current_v3:
            allowed.update({'reviewSubagent', 'imageFindings'})
            required_fields.update({'reviewSubagent', 'imageFindings'})
        if not required_fields.issubset(item) or not set(item).issubset(allowed):
            raise ValueError(
                f'attestation.files[{index}] 字段必须为 path/sha256/checks/notes'
                '，删除项另加 deleted=true'
            )
        rel_path = item.get('path')
        if (not isinstance(rel_path, str) or not rel_path.startswith('content/posts/')
                or '..' in Path(rel_path).parts or rel_path in seen):
            raise ValueError(f'attestation.files[{index}].path 非法或重复')
        seen.add(rel_path)
        item_checks = item.get('checks')
        if deleted:
            if item.get('sha256') is not None:
                raise ValueError(f'attestation.files[{index}] 删除项 sha256 必须为 null')
            if item_checks != {'deletionVerified': True}:
                raise ValueError(
                    f'attestation.files[{index}] 删除项 checks 必须仅含 deletionVerified=true'
                )
        else:
            if item.get('deleted') not in (None, False):
                raise ValueError(f'attestation.files[{index}].deleted 非法')
            if not re.fullmatch(r'[a-f0-9]{64}', str(item.get('sha256', ''))):
                raise ValueError(f'attestation.files[{index}].sha256 非法')
            if not isinstance(item_checks, dict) or set(item_checks) != file_checks \
                    or any(item_checks.get(key) is not True for key in file_checks):
                raise ValueError(f'attestation.files[{index}].checks 必须完整且全部为 true')
        if not isinstance(item.get('notes'), str) or len(item['notes'].strip()) < 20:
            raise ValueError(f'attestation.files[{index}].notes 至少需要 20 个字符')
        subagent = item.get('reviewSubagent')
        if current_v3 and (not isinstance(subagent, dict) or subagent.get('version') != 1
                or not isinstance(subagent.get('taskName'), str)
                or len(subagent['taskName'].strip()) < 4
                or subagent.get('singleFileOnly') is not True
                or subagent.get('isolatedContext') is not True
                or subagent.get('model') != REQUIRED_REVIEW_MODEL
                or subagent.get('reasoningEffort') != REQUIRED_REVIEW_REASONING):
            raise ValueError(
                f'attestation.files[{index}].reviewSubagent 必须证明独立单页 '
                f'{REQUIRED_REVIEW_MODEL}/{REQUIRED_REVIEW_REASONING} subagent 审查'
            )
        if current_v3:
            task_name = subagent['taskName'].strip()
            if task_name in seen_subagent_tasks:
                raise ValueError('attestation reviewSubagent.taskName 必须逐页唯一，禁止跨页面复用')
            seen_subagent_tasks.add(task_name)
            is_index = bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}\.md', Path(rel_path).name))
            if not deleted and not is_index \
                    and not re.fullmatch(r'\d{4}\.\d{5}', str(subagent.get('paperId') or '')):
                raise ValueError(
                    f'attestation.files[{index}].reviewSubagent.paperId 论文页必须提供规范 arXiv ID'
                )
        if current_v3 and not isinstance(item.get('imageFindings'), list):
            raise ValueError(f'attestation.files[{index}].imageFindings 必须是数组')
        for finding_index, finding in enumerate(item.get('imageFindings', [])):
            if (not isinstance(finding, dict)
                    or set(finding) != {
                        'url', 'captionVerified', 'adjacentNarrativeVerified',
                        'mobileReadable', 'visibleFacts', 'notes',
                    }
                    or not isinstance(finding.get('url'), str)
                    or not finding['url'].startswith('https://')
                    or any(finding.get(key) is not True for key in (
                        'captionVerified', 'adjacentNarrativeVerified', 'mobileReadable',
                    ))
                    or not isinstance(finding.get('visibleFacts'), list)
                    or len(finding['visibleFacts']) < 2
                    or any(not isinstance(fact, str) or len(fact.strip()) < 10
                           for fact in finding['visibleFacts'])
                    or not isinstance(finding.get('notes'), str)
                    or len(finding['notes'].strip()) < 20):
                raise ValueError(
                    f'attestation.files[{index}].imageFindings[{finding_index}] '
                    '必须逐图记录像素事实、caption、邻文和移动端可读性'
                )
        normalized_notes = re.sub(r'[\W_]+', '', item['notes'], flags=re.UNICODE).casefold()
        if normalized_notes in seen_notes:
            raise ValueError('attestation.files.notes 必须逐文件独立，禁止批量复用同一句')
        seen_notes.add(normalized_notes)
    return payload, hashlib.sha256(raw).hexdigest()


def _validate_file_specific_notes(module, attestation_by_path, actual_paths, deletions, date_str,
                                  require_subagent_images=False):
    """Require each note to carry an identifier that can only belong to its page."""
    seen_semantic_notes = set()

    def has_reader_fact(notes, text, ignored=()):
        ignored_text = ' '.join(str(item) for item in ignored).casefold()
        tokens = re.findall(
            r'[A-Za-z][A-Za-z0-9.+-]{2,}|(?<!\d)\d+(?:\.\d+)?%?', notes,
        )
        return any(
            token.casefold() not in ignored_text and token.casefold() in text.casefold()
            for token in tokens
        )

    def require_unique_semantics(notes, identifiers, relative):
        basis = notes
        for identifier in identifiers:
            if identifier:
                basis = basis.replace(str(identifier), '<page>')
        key = re.sub(r'[\W_]+', '', basis, flags=re.UNICODE).casefold()
        if key in seen_semantic_notes:
            raise module.PublishDataValidationError(
                f'attestation notes 去除页面 ID 后仍重复，必须逐页记录独立事实: {relative}'
            )
        seen_semantic_notes.add(key)

    for relative, resolved in actual_paths.items():
        item = attestation_by_path[relative]
        notes = item['notes']
        if deletions[relative]:
            stem = Path(relative).stem
            if '删除' not in notes or stem not in notes:
                raise module.PublishDataValidationError(
                    f'attestation 删除项 notes 必须包含“删除”和页面文件名 {stem}: {relative}'
                )
            require_unique_semantics(notes, (stem, date_str), relative)
            continue
        text = resolved.read_text(encoding='utf-8')
        parse_images = getattr(module, 'parse_markdown_images', lambda _text: [])
        image_urls = [image.get('url') for image in parse_images(text)]
        finding_urls = [finding.get('url') for finding in item.get('imageFindings', [])]
        if require_subagent_images and finding_urls != image_urls:
            raise module.PublishDataValidationError(
                f'attestation imageFindings 必须按正文顺序逐图精确覆盖: {relative}'
            )
        arxiv_match = re.search(
            r'^paper_digest_arxiv_id:\s*"?([^"\s]+)"?\s*$', text, re.MULTILINE,
        )
        if arxiv_match:
            if arxiv_match.group(1) not in notes:
                raise module.PublishDataValidationError(
                    f'attestation 论文页 notes 必须包含本页 arXiv ID '
                    f'{arxiv_match.group(1)}: {relative}'
                )
            if not has_reader_fact(notes, text, (arxiv_match.group(1), date_str)):
                raise module.PublishDataValidationError(
                    f'attestation 论文页 notes 必须包含正文中可核对的技术词或实验数字: {relative}'
                )
            require_unique_semantics(
                notes, (arxiv_match.group(1), date_str), relative,
            )
            if require_subagent_images and (subagent_id := item.get('reviewSubagent', {}).get('paperId')):
                if module.normalize_publish_arxiv_id(subagent_id) != \
                        module.normalize_publish_arxiv_id(arxiv_match.group(1)):
                    raise module.PublishDataValidationError(
                        f'attestation reviewSubagent.paperId 与页面不一致: {relative}'
                    )
        elif date_str not in notes or '汇总' not in notes:
            raise module.PublishDataValidationError(
                f'attestation 汇总页 notes 必须包含批次日期 {date_str} 与“汇总”: {relative}'
            )
        elif not has_reader_fact(notes, text, (date_str,)):
            raise module.PublishDataValidationError(
                f'attestation 汇总页 notes 必须包含正文中可核对的排名、数量或论文术语: {relative}'
            )
        else:
            require_unique_semantics(notes, (date_str,), relative)


def _require_current_attestation_version(module, generation_payload, attestation):
    if generation_payload.get('schemaVersion') != 3:
        return
    requires_v3 = any(
        isinstance(paper, dict)
        and (((paper.get('analysisManifest') or {}).get('contracts') or {}).get('manualDepth')
             == 'full-text-evidence-v5')
        for paper in generation_payload.get('publishedPapers') or []
    )
    if requires_v3 and attestation.get('version') != 3:
        raise module.PublishDataValidationError(
            'Manual v5 新页面必须使用 attestation v3，历史 v2 不得绕过逐页 subagent 与逐图审查'
        )


def _validate_attestation_publication_scope(module, generation_payload, attestation):
    generation_scope = generation_payload.get('publicationScope')
    attestation_scope = attestation.get('publicationScope')
    if generation_scope != attestation_scope:
        raise module.PublishDataValidationError(
            'Manual attestation 发布作用域与 generation manifest 不一致'
        )
    if generation_scope is not None:
        module._validate_active_publication_scope(generation_payload)
        if attestation.get('version') != 3 or len(attestation.get('files') or []) != 1:
            raise module.PublishDataValidationError(
                '单篇灰度 Manual attestation 必须为 v3 且精确包含一个页面'
            )
    return generation_scope


def _semantic_checks(module, paths, date_str):
    """Run conservative, deterministic content checks before attestation."""
    hard_forbidden = (
        '该论文分析失败', 'latestAnalysisAttemptError',
        '模型自检', '这里需要生成最终文本',
    )
    editorial_placeholder = re.compile(
        r'(?im)^\s*(?:[-*]\s*)?(?:TODO(?:\b|\s*[:：].*)|'
        r'待补充(?:\s*[:：].*)?|【待补充】)\s*$'
    )
    checked = 0
    for path in paths:
        path = Path(path)
        if not path.is_file():
            continue
        text = path.read_text(encoding='utf-8')
        if not text.strip():
            raise module.PublishDataValidationError(f'页面为空: {path.name}')
        if any(marker in text for marker in hard_forbidden) \
                or editorial_placeholder.search(text):
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


def _reject_deterministic_fixes(module, fixes):
    if not fixes:
        return
    changed = ', '.join(Path(item['path']).name for item in fixes[:5])
    suffix = '…' if len(fixes) > 5 else ''
    raise module.PublishDataValidationError(
        '确定性 review 修改了已人工审查的页面，旧 attestation 已失效；'
        f'请重新审读最终文件并签发新声明: {changed}{suffix}'
    )


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
    try:
        generation_payload = json.loads(Path(manifest_path).read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise module.PublishDataValidationError('generation manifest 无法解析') from exc
    authoritative_by_id = {}
    if generation_payload.get('schemaVersion') == 3:
        _require_current_attestation_version(module, generation_payload, attestation)
        _validate_attestation_publication_scope(module, generation_payload, attestation)
        for paper in generation_payload.get('publishedPapers') or []:
            if not isinstance(paper, dict):
                raise module.PublishDataValidationError(
                    'generation publishedPapers 含非法论文快照'
                )
            paper_id = module.normalize_publish_arxiv_id(paper.get('arxivId'))
            if paper_id in authoritative_by_id:
                raise module.PublishDataValidationError(
                    f'generation publishedPapers 含重复 arXiv ID: {paper_id}'
                )
            authoritative_by_id[paper_id] = paper
    expected_attested = {}
    for item in attestation['files']:
        expected_attested[item['path']] = item
    deletion_expectations = module.generation_manifest_expectations(manifest_path, date_str)
    actual_paths = {}
    for path in paths:
        resolved = Path(path).resolve()
        try:
            relative = resolved.relative_to(Path(blog_repo).resolve()).as_posix()
        except ValueError as exc:
            raise module.PublishDataValidationError(f'generation 文件不在博客仓库内: {resolved}') from exc
        actual_paths[relative] = resolved
    if set(expected_attested) != set(actual_paths):
        missing = sorted(set(actual_paths) - set(expected_attested))
        extra = sorted(set(expected_attested) - set(actual_paths))
        raise module.PublishDataValidationError(
            f'attestation 逐文件集合与 generation 不一致: missing={missing or "-"} extra={extra or "-"}'
        )
    for relative, resolved in actual_paths.items():
        deleted = deletion_expectations.get(relative)
        if deleted is None:
            raise module.PublishDataValidationError(
                f'attestation 路径不在 generation 删除语义中: {relative}'
            )
        item = expected_attested[relative]
        if deleted != (item.get('deleted') is True):
            raise module.PublishDataValidationError(
                f'attestation 删除语义与 generation 不一致: {relative}'
            )
        if deleted:
            if resolved.exists():
                raise module.PublishDataValidationError(
                    f'attestation 声明删除但页面重新出现: {relative}'
                )
            continue
        if _sha256(resolved) != item['sha256']:
            raise module.PublishDataValidationError(f'attestation 文件 SHA 已漂移: {relative}')
    _validate_file_specific_notes(
        module, expected_attested, actual_paths, deletion_expectations, date_str,
        require_subagent_images=attestation.get('version') == 3,
    )

    # Manual attestation validates already-reviewed bytes and is strictly
    # read-only.  Any deterministic repair that *would* be applied invalidates
    # the supplied SHA and must be moved back to generation before re-review.
    fixes = []
    authoritative_by_filename = {}
    for path in paths:
        path = Path(path)
        if not path.is_file():
            continue
        page_text = path.read_text(encoding='utf-8')
        paper_match = re.search(
            r'^paper_digest_arxiv_id:\s*"?([^"\s]+)"?\s*$',
            page_text, re.MULTILINE,
        )
        paper = None
        if paper_match:
            paper_id = module.normalize_publish_arxiv_id(paper_match.group(1))
            paper = authoritative_by_id.get(paper_id)
            if generation_payload.get('schemaVersion') == 3 and paper is None:
                raise module.PublishDataValidationError(
                    f'论文页不在 generation publishedPapers 快照中: {paper_id}'
                )
            if paper is not None:
                authoritative_by_filename[path.name] = paper
        fixed, issues = module.review_and_fix_post(path, paper, dry_run=True)
        if fixed:
            fixes.append({'path': str(path), 'issues': [str(item) for item in issues]})
            continue
        if issues:
            raise module.PublishDataValidationError(
                f'确定性 review 仍有阻断问题 {path.name}: {issues}'
            )
    _reject_deterministic_fixes(module, fixes)

    module.validate_staged_posts(
        content_dir, date_str, date_only=True, publish_paths=paths,
        authoritative_papers=authoritative_by_filename,
    )
    checked_files = _semantic_checks(module, paths, date_str)
    gate = module.run_hugo_gate(
        blog_repo, content_dir, required=True, source_paths=paths,
    )
    module.validate_staged_posts(
        content_dir, date_str, date_only=True, publish_paths=paths,
        authoritative_papers=authoritative_by_filename,
    )

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
            'imageReviewMode': 'manual_semantic',
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
        date_str, attestation, include_id = _parse_args(module)
        with module.publication_scope(include_id):
            expected_attestation = module.manual_review_attestation_path(date_str)
            if include_id and attestation != expected_attestation.resolve():
                raise module.PublishDataValidationError(
                    f'单篇灰度 Manual review 只接受隔离 attestation: {expected_attestation}'
                )
            with module.blog_publication_lock(date_str):
                receipt = _run(module, date_str, attestation)
    except (ValueError, module.PublishDataValidationError) as exc:
        print(f'\n❌ manual_complete review 失败，未签发凭证: {exc}')
        sys.exit(1)
    except TimeoutError as exc:
        print(f'\n❌ 博客仓库或同日期事务正在运行: {exc}')
        sys.exit(1)
    include_hint = f' --include-id {include_id}' if include_id else ''
    print(
        f'\n✅ manual_complete review 完成；下一步: python3 scripts/push-blog.py '
        f'--date {date_str}{include_hint}'
    )
    return receipt


if __name__ == '__main__':
    main()
