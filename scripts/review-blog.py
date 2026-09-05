#!/usr/bin/env python3
"""Strictly review an existing generated blog manifest and save a hash receipt."""

import argparse
import json
import re
import sys
from contextlib import nullcontext
from pathlib import Path

from blog_entry_loader import load_publish_to_blog
from runtime_guard import require_external_runtime


def _is_api_reader_asset_path(module, path):
    """Keep the stage wrapper compatible with injected/legacy publisher modules."""
    checker = getattr(module, 'is_api_reader_asset_path', None)
    return bool(checker(path)) if checker else False


def parse_options(module, argv=None):
    parser = argparse.ArgumentParser(
        prog='review-blog.py',
        description='严格审查既有博客 generation manifest；不提交、不推送。',
        allow_abbrev=False,
    )
    parser.add_argument('--date', action='append',
                        help='博客批次日期（YYYY-MM-DD；省略时为北京时间今天）')
    parser.add_argument('--include-id', action='append', metavar='ARXIV_ID',
                        help='只审查该单篇灰度 generation；必须与生成时 ID 一致')
    args = parser.parse_args(argv)
    if args.date and len(args.date) > 1:
        parser.error('--date 只能指定一次')
    if args.include_id and len(args.include_id) > 1:
        parser.error('--include-id 只能指定一次')
    return (
        module.validate_publish_date(module.get_today_bj(args.date[0] if args.date else None)),
        args.include_id[0] if args.include_id else None,
    )


def parse_date(module, argv=None):
    return parse_options(module, argv)[0]


def read_generated_pages(
    module, date_str, paths, authoritative_papers=None, page_artifacts=None,
):
    paper_slugs = {}
    scored_papers = []
    normalize_id = getattr(module, 'normalize_publish_arxiv_id', lambda value: str(value or ''))
    authoritative_by_id = {}
    if authoritative_papers is not None:
        if not isinstance(authoritative_papers, list) or not authoritative_papers:
            raise module.PublishDataValidationError('generation publishedPapers 缺少非空权威快照')
        for paper in authoritative_papers:
            if not isinstance(paper, dict) or not paper.get('arxivId'):
                raise module.PublishDataValidationError('generation publishedPapers 权威快照缺少论文 ID')
            normalized_id = normalize_id(paper['arxivId'])
            if normalized_id in authoritative_by_id:
                raise module.PublishDataValidationError('generation publishedPapers 含重复规范化论文 ID')
            authoritative_by_id[normalized_id] = paper
    seen_page_ids = set()
    prefix = f'{date_str}-'
    for path in paths:
        path = Path(path)
        if module.is_visual_summary_asset_path(path, date_str) \
                or _is_api_reader_asset_path(module, path):
            continue
        if not path.is_file() or path.name == f'{date_str}.md':
            continue
        if not path.name.startswith(prefix) or path.suffix != '.md':
            raise module.PublishDataValidationError(f'生成清单含非当日论文页: {path.name}')
        artifact = (page_artifacts or {}).get(str(path.resolve()))
        content = (
            artifact['content'] if isinstance(artifact, dict)
            else path.read_text(encoding='utf-8')
        )
        if not re.search(r'^paper_digest_page_type:\s*paper\s*$', content, re.MULTILINE):
            raise module.PublishDataValidationError(f'论文页缺少流水线所有权标记: {path.name}')
        id_match = re.search(r'^paper_digest_arxiv_id:\s*"?([^"\s]+)"?\s*$', content, re.MULTILINE)
        title_match = re.search(r'^title:\s*"(.*)"\s*$', content, re.MULTILINE)
        if not id_match or not title_match:
            raise module.PublishDataValidationError(f'论文页缺少 arXiv ID 或标题: {path.name}')
        arxiv_id = id_match.group(1)
        slug = path.stem[len(prefix):]
        paper_slugs[arxiv_id] = slug
        normalized_id = normalize_id(arxiv_id)
        if normalized_id in seen_page_ids:
            raise module.PublishDataValidationError(f'生成清单论文页 ID 重复: {normalized_id}')
        seen_page_ids.add(normalized_id)
        authoritative = authoritative_by_id.get(normalized_id)
        if authoritative_papers is not None and authoritative is None:
            raise module.PublishDataValidationError(
                f'论文页不在 generation publishedPapers 权威快照中: {normalized_id}'
            )
        paper = dict(authoritative or {
            'arxivId': arxiv_id, 'title': title_match.group(1),
        })
        scored_papers.append((0.0, paper, {}))
    if not paper_slugs:
        raise module.PublishDataValidationError('生成清单中没有可审查的论文页')
    return paper_slugs, scored_papers


def validate_reused_pages(
    module, date_str, paths, prior_results, page_artifacts, authoritative_papers=None,
):
    """Re-run current deterministic, canonical-aware gates for cached passes."""
    normalize_id = getattr(module, 'normalize_publish_arxiv_id', lambda value: str(value or ''))
    authoritative_by_id = {
        normalize_id(paper.get('arxivId')): paper
        for paper in (authoritative_papers or [])
        if isinstance(paper, dict) and paper.get('arxivId')
    }
    for path in paths:
        path = Path(path).resolve()
        if _is_api_reader_asset_path(module, path):
            continue
        result = prior_results.get(str(path), {})
        if result.get('passed') is not True or not path.is_file():
            continue
        artifact = page_artifacts.get(str(path))
        content = artifact.get('content') if isinstance(artifact, dict) else path.read_text(encoding='utf-8')
        paper = None
        paper_match = re.search(
            r'^paper_digest_arxiv_id:\s*"?([^"\s]+)"?\s*$', content, re.MULTILINE,
        )
        if paper_match:
            paper_id = normalize_id(paper_match.group(1))
            paper = authoritative_by_id.get(paper_id)
            if authoritative_papers is not None and paper is None:
                raise module.PublishDataValidationError(
                    f'缓存论文页不在 generation publishedPapers 权威快照中: {paper_id}'
                )
        fixed, issues = module.review_and_fix_post(
            path, paper, dry_run=True, source_content=content,
        )
        if fixed or issues:
            raise module.PublishDataValidationError(
                f'缓存页面未通过当前确定性门禁，必须重新生成/审查: {path.name}: {issues}'
            )


def preflight_generated_pages(
    module, date_str, blog_repo, content_dir, paths, page_artifacts,
    authoritative_by_filename, manifest_path,
):
    """Collect independent page defects before any paid review request."""
    issues = []
    for page in paths:
        page = Path(page).resolve()
        if not page.is_file() or page.suffix != '.md':
            continue
        paper = (authoritative_by_filename or {}).get(page.name)
        artifact = page_artifacts.get(str(page), {})
        content = artifact.get('content')
        if hasattr(module, 'review_and_fix_post'):
            try:
                fixed, page_issues = module.review_and_fix_post(
                    page, paper, dry_run=True, source_content=content,
                )
                issues.extend(f'{page.name}: {issue}' for issue in page_issues)
                if fixed and not page_issues:
                    issues.append(f'{page.name}: 最终字节需要确定性修复')
            except module.PublishDataValidationError as exc:
                issues.append(f'{page.name}: {exc}')
        try:
            module.validate_staged_posts(
                Path(content_dir), date_str, date_only=True, publish_paths=[page],
                authoritative_papers=authoritative_by_filename,
            )
        except module.PublishDataValidationError as exc:
            issues.append(f'{page.name}: {exc}')
    attest = getattr(module, 'attest_api_reader_assets', None)
    if attest:
        try:
            asset_results = {}
            if attest(date_str, paths, manifest_path, asset_results, preflight_only=True):
                issues.extend(
                    f'{Path(path).name}: 论文图片或 sidecar 确定性绑定失败'
                    for path, result in asset_results.items() if result.get('passed') is not True
                )
        except module.PublishDataValidationError as exc:
            issues.append(str(exc))
    if issues:
        error = module.PublishDataValidationError('发布预检失败（尚未调用 LLM）: ' + '; '.join(issues))
        error.review_issues = [
            {'severity': 'error', 'type': 'preflight', 'description': issue}
            for issue in issues
        ]
        raise error
    return module.run_hugo_gate(
        blog_repo, Path(content_dir), required=True, source_paths=paths,
    )


def _run_review(module, date_str):
        blog_repo, content_dir = module.validate_publish_target()
        paths, manifest_path = module.load_generation_manifest(date_str)
        base_head = module.validate_git_publish_branch()
        published_reusable = module.reusable_verified_publication_review(
            date_str, base_head,
        )
        if published_reusable is not None:
            reusable_paths, reusable_manifest, receipt_path = published_reusable
            if module._git_relative_manifest(reusable_paths) != module._git_relative_manifest(paths):
                raise module.PublishDataValidationError(
                    '已发布凭证与当前 generation manifest 路径集合不一致'
                )
            if Path(reusable_manifest).resolve() != Path(manifest_path).resolve():
                raise module.PublishDataValidationError('已发布凭证绑定了其他 generation manifest')
            print(
                '♻️ 当前 generation 已通过同一 review 协议发布，且实时远端 OID/remote 身份仍匹配；'
                '保留严格发布凭证并跳过重复 LLM/Hugo review'
            )
            return receipt_path
        if module.has_publication_evidence_for_generation(date_str):
            raise module.PublishDataValidationError(
                '当前 generation 已存在发布证据，但实时 remote/OID 或严格凭证复核失败；'
                '已保留既有 receipt，拒绝开始新 review 覆盖唯一发布证据'
            )
        authoritative_papers = None
        try:
            generation = json.loads(Path(manifest_path).read_text(encoding='utf-8'))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise module.PublishDataValidationError('生成清单权威快照无法读取或解析') from exc
        if not isinstance(generation, dict):
            raise module.PublishDataValidationError('生成清单必须是对象')
        if generation.get('schemaVersion') == 3:
            authoritative_papers = generation.get('publishedPapers') or []
        page_artifacts = {}
        if hasattr(module, 'build_final_page_artifact'):
            for page in paths:
                page = Path(page).resolve()
                if (
                    page.is_file()
                    and not module.is_visual_summary_asset_path(page, date_str)
                    and not _is_api_reader_asset_path(module, page)
                ):
                    artifact = module.build_final_page_artifact(page)
                    page_artifacts[str(page)] = artifact
        paper_slugs, scored_papers = read_generated_pages(
            module, date_str, paths, authoritative_papers, page_artifacts,
        )
        authoritative_by_filename = None
        if authoritative_papers is not None:
            normalize_id = module.normalize_publish_arxiv_id
            reviewed_by_id = {
                normalize_id(paper['arxivId']): paper
                for _score, paper, _parsed in scored_papers
            }
            authoritative_by_filename = {}
            for paper_id, slug in paper_slugs.items():
                paper = reviewed_by_id.get(normalize_id(paper_id))
                if paper is None:
                    raise module.PublishDataValidationError(f'论文页缺少 generation 权威快照: {paper_id}')
                authoritative_by_filename[f'{date_str}-{slug}.md'] = paper
        plan = module.plan_incremental_review(
            date_str, paths, manifest_path, base_head,
        )
        # The batch preflight below replays current deterministic gates for
        # both cached and pending pages, collecting independent defects once.
        # Planning may migrate exact per-file passes from the older receipt.
        # The batch-level receipt itself is invalid once this attempt starts.
        module.review_receipt_path(date_str).unlink(missing_ok=True)
        print(f'📋 读取生成清单: {manifest_path}')
        if plan['mode'] == 'incremental':
            print(
                f'♻️ 按文件 SHA 续审: 复用 {plan.get("reusedPassed", 0)} 个已通过文件；'
                f'本轮审查 {len(plan["paths"])} 个文件；'
                f'{len(plan["unchangedFailed"])} 个内容失败文件尚未修改'
            )
        else:
            if plan.get('reason'):
                print(f'ℹ️ 续审证据不可复用，退回全量 review: {plan["reason"]}')
            print(f'🔍 开始严格全量 review: {len(paper_slugs)} 篇论文')
        combined_results = dict(plan['priorResults'])
        manifest_sha256 = module._sha256_file(manifest_path)
        initial_protocol = (
            module.review_protocol_fingerprint()
            if hasattr(module, 'review_protocol_fingerprint') else None
        )
        # Persist pending work before the first LLM call. A crash or API outage
        # can then resume only unfinished/transient files on the next run.
        module.save_review_failure_state(
            date_str, paths, manifest_path, base_head, combined_results,
        )

        try:
            gate = preflight_generated_pages(
                module, date_str, blog_repo, content_dir, paths, page_artifacts,
                authoritative_by_filename, manifest_path,
            )
        except module.PublishDataValidationError as exc:
            # Persist actionable details without treating preflight as semantic
            # review evidence or replacing successful per-page checkpoints.
            module.save_review_failure_state(
                date_str, paths, manifest_path, base_head, combined_results,
                batch_issues=getattr(exc, 'review_issues', [{
                    'severity': 'error', 'type': 'preflight', 'description': str(exc),
                }]),
            )
            raise

        def checkpoint(path, result):
            resolved = Path(path).resolve()
            if initial_protocol is not None:
                if module.review_protocol_fingerprint() != initial_protocol:
                    raise module.PublishDataValidationError('review 期间审查协议变化，拒绝登记逐页通过凭证')
                result['reviewProtocolFingerprint'] = initial_protocol
            module.save_review_page_checkpoint(
                date_str, resolved, result, manifest_path, base_head,
                manifest_sha256=manifest_sha256,
            )
            combined_results[str(resolved)] = result

        fixed, blocking, current_results = module.review_all_posts(
            date_str,
            paper_slugs,
            scored_papers,
            require_llm=True,
            content_dir=str(content_dir),
            review_paths=plan['paths'],
            return_details=True,
            result_callback=checkpoint,
            page_artifacts=page_artifacts,
        )
        combined_results.update(current_results)
        attest_assets = getattr(module, 'attest_api_reader_assets', None)
        if attest_assets:
            blocking += attest_assets(
                date_str, paths, manifest_path, combined_results,
            )
        blocking += len(plan['unchangedFailed'])
        if blocking:
            failure_path = module.save_review_failure_state(
                date_str,
                paths,
                manifest_path,
                base_head,
                combined_results,
            )
            print(f'💾 已保存失败集续审状态: {failure_path}')
            raise module.PublishDataValidationError(f'review 仍有 {blocking} 个未解决阻断问题')
        if fixed:
            print(f'✅ review 自动修复 {fixed} 个文件')
        try:
            module.validate_reviewed_file_hashes(
                date_str, paths, manifest_path, combined_results,
            )
            module.validate_staged_posts(
                Path(content_dir), date_str, date_only=True, publish_paths=paths,
                authoritative_papers=authoritative_by_filename,
            )
            if initial_protocol is not None and module.review_protocol_fingerprint() != initial_protocol:
                raise module.PublishDataValidationError('review 期间审查协议或 Hugo 运行时变化，请重新审查')
            module.validate_reviewed_file_hashes(
                date_str, paths, manifest_path, combined_results,
            )
        except Exception:
            # A site-wide deterministic/Hugo failure invalidates the batch
            # checkpoint, while exact per-file passes remain durably reusable.
            module.review_failure_path(date_str).unlink(missing_ok=True)
            raise
        receipt = module.save_review_receipt(
            date_str, paths, gate, expected_base_head=base_head,
            generation_manifest=manifest_path,
            reviewed_results=combined_results,
        )
        module.clear_review_page_checkpoints(date_str)
        module.review_failure_path(date_str).unlink(missing_ok=True)
        return receipt


def main():
    require_external_runtime('review-blog.py')
    from log_setup import setup_script_logging
    setup_script_logging(__file__)
    module = load_publish_to_blog()
    try:
        date_str, include_id = parse_options(module)
        scope_context = getattr(module, 'publication_scope', lambda _value: nullcontext())
        with scope_context(include_id):
            with module.blog_publication_lock(date_str):
                receipt = _run_review(module, date_str)
    except (module.PublishDataValidationError, module.PublishLLMUnavailable) as exc:
        print(f'\n❌ review 失败，未生成审查凭证: {exc}')
        sys.exit(1)
    except TimeoutError as exc:
        print(f'\n❌ 博客仓库或同日期事务正在运行: {exc}')
        sys.exit(1)
    print(f'🧾 审查凭证: {receipt}')
    print(f'\n✅ review 完成；下一步: python3 scripts/push-blog.py --date {date_str}')


if __name__ == '__main__':
    main()
