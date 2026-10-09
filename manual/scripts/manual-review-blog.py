#!/usr/bin/env python3
"""核对人工审查声明和最终文件，签发人工审查方式的博客发布凭证。

本命令用于模型审查服务不可用时由操作者或代理接手，不会调用模型。
代码检查、文件内容哈希、Hugo 构建、Git 基线及生成清单仍须通过核验，
不会降低原有审查要求。发布凭证保留 ``reviewMode=manual_complete`` 标记，
并记录人工审查声明文件的哈希，供推送和状态检查区分人工审查与模型审查。
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
from publish_common import is_canonical_publish_arxiv_id

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
        description='模型审查不可用时，核对完整人工审查记录并签发发布凭证。',
        allow_abbrev=False,
    )
    parser.add_argument('--date', required=True, metavar='YYYY-MM-DD')
    parser.add_argument('--attestation', required=True,
                        help='人工语义审查声明的 JSON 文件；所有检查结果必须为 true')
    parser.add_argument('--include-id', action='append', metavar='ARXIV_ID',
                        help='只为指定论文的单篇试发布结果签发人工审查凭证')
    args = parser.parse_args(argv)
    if args.include_id and len(args.include_id) > 1:
        parser.error('--include-id 只能指定一次')
    return (
        module.validate_publish_date(args.date),
        Path(args.attestation).expanduser().resolve(),
        args.include_id[0] if args.include_id else None,
    )


def _load_review_statement(path):
    try:
        raw = path.read_bytes()
        payload = json.loads(raw.decode('utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f'无法读取或解析人工审查声明：{path}') from exc
    if not isinstance(payload, dict):
        raise ValueError('人工审查声明必须是 JSON 对象。')
    if payload.get('version') not in (2, 3) or payload.get('mode') != 'manual_complete':
        raise ValueError('人工审查声明必须采用 v2 或 v3 版本，并标明人工审查方式。')
    current_v3 = payload.get('version') == 3
    if not isinstance(payload.get('agent'), str) or not payload['agent'].strip():
        raise ValueError('人工审查声明必须填写非空的审查者名称。')
    if payload.get('basis') != 'deterministic_and_manual_semantic_review':
        raise ValueError('人工审查声明必须注明已完成代码检查和人工语义审查。')
    if not isinstance(payload.get('reason'), str) or len(payload['reason'].strip()) < 20:
        raise ValueError('人工审查声明中的审查理由必须是至少 20 个字符的非空文字。')
    checks = payload.get('checks')
    required = {
        'generationManifestVerified', 'baseHeadVerified', 'fileHashesVerified',
        'frontmatterVerified', 'markdownVerified', 'contentSemanticsVerified',
        'imageReferencesVerified', 'hugoGateVerified',
    }
    if not isinstance(checks, dict) or set(checks) != required:
        raise ValueError('人工审查声明必须完整列出规定的八项检查，不能缺项或增加其他项。')
    if any(checks.get(key) is not True for key in required):
        raise ValueError('人工审查声明中的八项检查结果必须全部为 true。')
    files = payload.get('files')
    file_checks = {
        'titleAndMetadata', 'technicalNarrative', 'factualClaims',
        'experimentComparisons', 'reproducibility', 'limitations',
        'scoring', 'images',
    }
    if not isinstance(files, list) or not files:
        raise ValueError('人工审查声明必须用非空数组逐文件列出语义审查记录。')
    seen = set()
    seen_notes = set()
    seen_subagent_tasks = set()
    for index, item in enumerate(files):
        if not isinstance(item, dict):
            raise ValueError(f'文件审查记录 files[{index}] 必须是对象。')
        deleted = item.get('deleted') is True
        allowed = {'path', 'sha256', 'checks', 'notes', 'deleted'}
        required_fields = {'path', 'sha256', 'checks', 'notes'}
        if current_v3:
            allowed.update({'reviewSubagent', 'imageFindings'})
            required_fields.update({'reviewSubagent', 'imageFindings'})
        if not required_fields.issubset(item) or not set(item).issubset(allowed):
            raise ValueError(
                f'文件审查记录 files[{index}] 缺少必要字段'
                '，或含有不允许的字段。'
            )
        rel_path = item.get('path')
        if (not isinstance(rel_path, str) or not rel_path.startswith('content/posts/')
                or '..' in Path(rel_path).parts or rel_path in seen):
            raise ValueError(f'文件审查记录 files[{index}] 的路径格式无效、超出文章目录，或与其他记录重复。')
        seen.add(rel_path)
        item_checks = item.get('checks')
        if deleted:
            if item.get('sha256') is not None:
                raise ValueError(f'文件审查记录 files[{index}] 对应已删除文件，其内容 SHA 必须为 null。')
            if item_checks != {'deletionVerified': True}:
                raise ValueError(
                    f'文件审查记录 files[{index}] 对应已删除文件，必须只包含结果为 true 的删除确认项。'
                )
        else:
            if item.get('deleted') not in (None, False):
                raise ValueError(f'文件审查记录 files[{index}] 的删除标记不符合未删除文件的要求。')
            if not re.fullmatch(r'[a-f0-9]{64}', str(item.get('sha256', ''))):
                raise ValueError(f'文件审查记录 files[{index}] 的内容 SHA 缺失或格式无效。')
            if not isinstance(item_checks, dict) or set(item_checks) != file_checks \
                    or any(item_checks.get(key) is not True for key in file_checks):
                raise ValueError(f'文件审查记录 files[{index}] 必须完整列出规定的检查项，且每项结果均为 true。')
        if not isinstance(item.get('notes'), str) or len(item['notes'].strip()) < 20:
            raise ValueError(f'文件审查记录 files[{index}] 中的审查说明必须是至少 20 个字符的非空文字。')
        subagent = item.get('reviewSubagent')
        if current_v3 and (not isinstance(subagent, dict) or subagent.get('version') != 1
                or not isinstance(subagent.get('taskName'), str)
                or len(subagent['taskName'].strip()) < 4
                or subagent.get('singleFileOnly') is not True
                or subagent.get('isolatedContext') is not True
                or subagent.get('model') != REQUIRED_REVIEW_MODEL
                or subagent.get('reasoningEffort') != REQUIRED_REVIEW_REASONING):
            raise ValueError(
                f'文件审查记录 files[{index}] 必须注明独立单页任务及规定的模型和推理等级：'
                f'{REQUIRED_REVIEW_MODEL}/{REQUIRED_REVIEW_REASONING}。'
            )
        if current_v3:
            task_name = subagent['taskName'].strip()
            if task_name in seen_subagent_tasks:
                raise ValueError('各页面的审查任务名称必须逐页唯一，不能跨页面复用。')
            seen_subagent_tasks.add(task_name)
            is_index = bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}\.md', Path(rel_path).name))
            if not deleted and not is_index \
                    and not is_canonical_publish_arxiv_id(subagent.get('paperId')):
                raise ValueError(
                    f'文件审查记录 files[{index}] 中的论文页审查任务必须在 paperId 中填写规范的 arXiv ID。'
                )
        if current_v3 and not isinstance(item.get('imageFindings'), list):
            raise ValueError(f'文件审查记录 files[{index}] 中的逐图检查结果必须是数组。')
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
                    f'文件审查记录 files[{index}] 中的图片审查记录 imageFindings[{finding_index}] '
                    '格式无效，或未按要求记录 HTTPS 地址、检查结果、可见事实和审查说明。'
                )
        normalized_notes = re.sub(r'[\W_]+', '', item['notes'], flags=re.UNICODE).casefold()
        if normalized_notes in seen_notes:
            raise ValueError('文件审查说明必须逐文件独立，不能批量复用同一句。')
        seen_notes.add(normalized_notes)
    return payload, hashlib.sha256(raw).hexdigest()


def _validate_file_specific_notes(module, review_file_records_by_path, actual_paths, deletions, date_str,
                                  require_subagent_images=False):
    """核对逐页审查说明是否包含本页标识和可在正文中核对的事实，并检查说明是否重复。"""
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
                f'人工审查说明在去除页面 ID 后仍重复，必须逐页记录独立事实：{relative}'
            )
        seen_semantic_notes.add(key)

    for relative, resolved in actual_paths.items():
        item = review_file_records_by_path[relative]
        notes = item['notes']
        if deletions[relative]:
            stem = Path(relative).stem
            if '删除' not in notes or stem not in notes:
                raise module.PublishDataValidationError(
                    f'删除项的审查说明必须包含“删除”和页面不含扩展名的文件名 {stem}：{relative}'
                )
            require_unique_semantics(notes, (stem, date_str), relative)
            continue
        text = resolved.read_text(encoding='utf-8')
        parse_images = getattr(module, 'parse_markdown_images', lambda _text: [])
        image_urls = [image.get('url') for image in parse_images(text)]
        finding_urls = [finding.get('url') for finding in item.get('imageFindings', [])]
        if require_subagent_images and finding_urls != image_urls:
            raise module.PublishDataValidationError(
                f'逐图审查记录必须按正文顺序完整覆盖页面中的图片：{relative}'
            )
        arxiv_match = re.search(
            r'^paper_digest_arxiv_id:\s*"?([^"\s]+)"?\s*$', text, re.MULTILINE,
        )
        if arxiv_match:
            if arxiv_match.group(1) not in notes:
                raise module.PublishDataValidationError(
                    f'论文页的审查说明必须包含本页的 arXiv ID '
                    f'{arxiv_match.group(1)}: {relative}'
                )
            if not has_reader_fact(notes, text, (arxiv_match.group(1), date_str)):
                raise module.PublishDataValidationError(
                    f'论文页的审查说明必须包含可在正文中核对的技术词或实验数字：{relative}'
                )
            require_unique_semantics(
                notes, (arxiv_match.group(1), date_str), relative,
            )
            if require_subagent_images and (subagent_id := item.get('reviewSubagent', {}).get('paperId')):
                if module.normalize_publish_arxiv_id(subagent_id) != \
                        module.normalize_publish_arxiv_id(arxiv_match.group(1)):
                    raise module.PublishDataValidationError(
                        f'审查任务中的 paperId 与页面的论文 ID 不一致：{relative}'
                    )
        elif date_str not in notes or '汇总' not in notes:
            raise module.PublishDataValidationError(
                f'汇总页的审查说明必须包含批次日期 {date_str} 和“汇总”字样：{relative}'
            )
        elif not has_reader_fact(notes, text, (date_str,)):
            raise module.PublishDataValidationError(
                f'汇总页的审查说明必须包含可在正文中核对的排名、数量或论文术语：{relative}'
            )
        else:
            require_unique_semantics(notes, (date_str,), relative)


def _require_current_review_statement_version(module, generation_payload, review_statement):
    if generation_payload.get('schemaVersion') != 3:
        return
    requires_v3 = any(
        isinstance(paper, dict)
        and (((paper.get('analysisManifest') or {}).get('contracts') or {}).get('manualDepth')
             in {'full-text-evidence-v5', 'full-text-evidence-v6'})
        for paper in generation_payload.get('publishedPapers') or []
    )
    if requires_v3 and review_statement.get('version') != 3:
        raise module.PublishDataValidationError(
            'Manual v5/v6 新页面必须使用 v3 人工审查声明；历史 v2 声明不能替代独立单页任务和逐图审查记录。'
        )


def _validate_review_statement_scope(module, generation_payload, review_statement):
    generation_scope = generation_payload.get('publicationScope')
    statement_publication_scope = review_statement.get('publicationScope')
    if generation_scope != statement_publication_scope:
        raise module.PublishDataValidationError(
            '人工审查声明的发布范围与生成清单不一致。'
        )
    if generation_scope is not None:
        module._validate_active_publication_scope(generation_payload)
        if review_statement.get('version') != 3 or len(review_statement.get('files') or []) != 1:
            raise module.PublishDataValidationError(
                '单篇试发布必须使用 v3 人工审查声明，且声明中只能包含一个页面。'
            )
    return generation_scope


def _semantic_checks(module, paths, date_str):
    """在签发凭证前，检查页面是否为空、是否有编辑残留，以及论文标记和图片地址是否符合要求。"""
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
            raise module.PublishDataValidationError(f'页面包含分析失败或编辑残留标记：{path.name}')
        if path.name != f'{date_str}.md':
            if not re.search(r'^paper_digest_page_type:\s*paper\s*$', text, re.MULTILINE):
                raise module.PublishDataValidationError(f'论文页缺少指定的页面类型标记：{path.name}')
            if not re.search(r'^paper_digest_arxiv_id:\s*"?[^"\s]+"?\s*$', text, re.MULTILINE):
                raise module.PublishDataValidationError(f'论文页缺少 arXiv ID: {path.name}')
        for image in module.parse_markdown_images(text):
            url = image.get('url', '')
            if url.startswith(('http://', '//')):
                raise module.PublishDataValidationError(f'图片地址使用了 HTTP，或以 // 开头，不符合要求：{path.name}')
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
        '页面需要代码自动修正，原人工审查声明已失效；'
        f'请先重新生成页面，再审查最终文件并签发新声明：{changed}{suffix}'
    )


def _run(module, date_str, review_statement_path):
    blog_repo, content_dir = module.validate_publish_target()
    paths, manifest_path = module.load_generation_manifest(date_str)
    base_head = module.validate_git_publish_branch()
    reusable = module.reusable_verified_publication_review(date_str, base_head)
    if reusable is not None:
        print('♻️ 本次生成结果已有可复用的有效发布凭证，无须再次签发。')
        return reusable[2]
    if module.has_publication_evidence_for_generation(date_str):
        raise module.PublishDataValidationError(
            '本次生成结果已有发布记录，但未通过严格复核，不能覆盖原发布凭证。'
        )
    review_statement, review_statement_sha256 = _load_review_statement(review_statement_path)
    try:
        generation_payload = json.loads(Path(manifest_path).read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise module.PublishDataValidationError('生成清单无法解析。') from exc
    authoritative_by_id = {}
    if generation_payload.get('schemaVersion') == 3:
        _require_current_review_statement_version(module, generation_payload, review_statement)
        _validate_review_statement_scope(module, generation_payload, review_statement)
        for paper in generation_payload.get('publishedPapers') or []:
            if not isinstance(paper, dict):
                raise module.PublishDataValidationError(
                    '生成清单中的论文记录不是对象。'
                )
            paper_id = module.normalize_publish_arxiv_id(paper.get('arxivId'))
            if paper_id in authoritative_by_id:
                raise module.PublishDataValidationError(
                    f'生成清单中的论文记录包含重复的 arXiv ID：{paper_id}'
                )
            authoritative_by_id[paper_id] = paper
    expected_attested = {}
    for item in review_statement['files']:
        expected_attested[item['path']] = item
    deletion_expectations = module.generation_manifest_expectations(manifest_path, date_str)
    actual_paths = {}
    for path in paths:
        resolved = Path(path).resolve()
        try:
            relative = resolved.relative_to(Path(blog_repo).resolve()).as_posix()
        except ValueError as exc:
            raise module.PublishDataValidationError(f'生成清单中的文件不在博客仓库内：{resolved}') from exc
        actual_paths[relative] = resolved
    if set(expected_attested) != set(actual_paths):
        missing = sorted(set(actual_paths) - set(expected_attested))
        extra = sorted(set(expected_attested) - set(actual_paths))
        raise module.PublishDataValidationError(
            f'人工审查声明中的文件集合与生成清单不一致：缺少 {missing or "-"}；多出 {extra or "-"}'
        )
    for relative, resolved in actual_paths.items():
        deleted = deletion_expectations.get(relative)
        if deleted is None:
            raise module.PublishDataValidationError(
                f'人工审查声明中的路径不在生成清单的文件记录中：{relative}'
            )
        item = expected_attested[relative]
        if deleted != (item.get('deleted') is True):
            raise module.PublishDataValidationError(
                f'人工审查声明中的删除标记与生成清单不一致：{relative}'
            )
        if deleted:
            if resolved.exists():
                raise module.PublishDataValidationError(
                    f'人工审查声明记录了删除，但对应页面重新出现：{relative}'
                )
            continue
        if _sha256(resolved) != item['sha256']:
            raise module.PublishDataValidationError(f'文件内容 SHA 与人工审查声明不一致：{relative}')
    _validate_file_specific_notes(
        module, expected_attested, actual_paths, deletion_expectations, date_str,
        require_subagent_images=review_statement.get('version') == 3,
    )

    # 人工审查只核对已审文件，不改写页面。预演检查若发现页面需要自动修正，
    # 原声明便不能继续使用，必须回到生成阶段修正页面，再重新审查。
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
                    f'论文页对应的论文不在本次生成清单的论文记录中：{paper_id}'
                )
            if paper is not None:
                authoritative_by_filename[path.name] = paper
        fixed, issues = module.review_and_fix_post(path, paper, dry_run=True)
        if fixed:
            fixes.append({'path': str(path), 'issues': [str(item) for item in issues]})
            continue
        if issues:
            raise module.PublishDataValidationError(
                f'页面 {path.name} 的代码检查仍有阻断问题：{issues}'
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
        raise module.PublishDataValidationError('已审文件数量在凭证签发前发生变化。')
    manifest_sha = _sha256(manifest_path)
    manual_review_record = dict(review_statement)
    manual_review_record.pop('checks', None)
    manual_review_record['completedAt'] = _now_bj()
    manual_review_record['checks'] = review_statement['checks']
    manual_review_record['attestationSha256'] = review_statement_sha256
    manual_review_record['generationManifestSha256'] = manifest_sha
    manual_review_record['baseHead'] = base_head
    manual_review_record['fileCount'] = len(paths)
    manual_review_record['reviewProtocolFingerprint'] = protocol
    manual_review_record['deterministicFixes'] = fixes
    manual_review_record['checkedFiles'] = checked_files
    receipt = module.save_review_receipt(
        date_str, paths, gate, expected_base_head=base_head,
        generation_manifest=manifest_path, reviewed_results=reviewed,
        manual_review_record=manual_review_record,
    )
    print(f'🧾 已签发人工审查凭证：{receipt}')
    print(f'   人工审查声明文件 SHA：{review_statement_sha256}')
    return receipt


def main():
    require_external_runtime('manual-review-blog.py')
    from log_setup import setup_script_logging
    setup_script_logging(__file__)
    module = load_publish_to_blog()
    try:
        date_str, review_statement_path, include_id = _parse_args(module)
        with module.publication_scope(include_id):
            expected_statement_path = module.manual_review_statement_path(date_str)
            if include_id and review_statement_path != expected_statement_path.resolve():
                raise module.PublishDataValidationError(
                    f'单篇试发布只接受对应的独立人工审查声明：{expected_statement_path}'
                )
            with module.blog_publication_lock(date_str):
                receipt = _run(module, date_str, review_statement_path)
    except (ValueError, module.PublishDataValidationError) as exc:
        print(f'\n❌ 人工审查或凭证签发失败：{exc}')
        sys.exit(1)
    except TimeoutError as exc:
        print(f'\n❌ 博客仓库或同日期事务正在运行: {exc}')
        sys.exit(1)
    include_hint = f' --include-id {include_id}' if include_id else ''
    print(
        f'\n✅ 人工审查和凭证签发完成；下一步：python3 scripts/push-blog.py '
        f'--date {date_str}{include_hint}'
    )
    return receipt


if __name__ == '__main__':
    main()
