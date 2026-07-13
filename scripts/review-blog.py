#!/usr/bin/env python3
"""Strictly review an existing generated blog manifest and save a hash receipt."""

import re
import sys
from pathlib import Path

from project_env import load_project_env
load_project_env()

from blog_entry_loader import load_publish_to_blog
from runtime_guard import require_external_runtime


def parse_date(module):
    target = None
    for index, arg in enumerate(sys.argv[1:]):
        if arg == '--date' and index + 2 < len(sys.argv):
            target = sys.argv[index + 2]
    return module.validate_publish_date(module.get_today_bj(target))


def read_generated_pages(module, date_str, paths):
    paper_slugs = {}
    scored_papers = []
    prefix = f'{date_str}-'
    for path in paths:
        path = Path(path)
        if not path.is_file() or path.name == f'{date_str}.md':
            continue
        if not path.name.startswith(prefix) or path.suffix != '.md':
            raise module.PublishDataValidationError(f'生成清单含非当日论文页: {path.name}')
        content = path.read_text(encoding='utf-8')
        if not re.search(r'^paper_digest_page_type:\s*paper\s*$', content, re.MULTILINE):
            raise module.PublishDataValidationError(f'论文页缺少流水线所有权标记: {path.name}')
        id_match = re.search(r'^paper_digest_arxiv_id:\s*"?([^"\s]+)"?\s*$', content, re.MULTILINE)
        title_match = re.search(r'^title:\s*"(.*)"\s*$', content, re.MULTILINE)
        if not id_match or not title_match:
            raise module.PublishDataValidationError(f'论文页缺少 arXiv ID 或标题: {path.name}')
        arxiv_id = id_match.group(1)
        slug = path.stem[len(prefix):]
        paper_slugs[arxiv_id] = slug
        paper = {'arxivId': arxiv_id, 'title': title_match.group(1)}
        scored_papers.append((0.0, paper, {}))
    if not paper_slugs:
        raise module.PublishDataValidationError('生成清单中没有可审查的论文页')
    return paper_slugs, scored_papers


def _run_review(module, date_str):
        blog_repo, content_dir = module.validate_publish_target()
        paths, manifest_path = module.load_generation_manifest(date_str)
        paper_slugs, scored_papers = read_generated_pages(module, date_str, paths)
        base_head = module.validate_git_publish_branch()
        # A review attempt invalidates any older success receipt immediately.
        module.review_receipt_path(date_str).unlink(missing_ok=True)
        plan = module.plan_incremental_review(
            date_str, paths, manifest_path, base_head,
        )
        print(f'📋 读取生成清单: {manifest_path}')
        if plan['mode'] == 'incremental':
            print(
                f'♻️ 失败集续审: {len(plan["paths"])} 个已修改失败文件；'
                f'{len(plan["unchangedFailed"])} 个失败文件尚未修改'
            )
        else:
            if plan.get('reason'):
                print(f'ℹ️ 续审证据不可复用，退回全量 review: {plan["reason"]}')
            print(f'🔍 开始严格全量 review: {len(paper_slugs)} 篇论文')
        combined_results = dict(plan['priorResults'])
        # Persist pending work before the first LLM call. A crash or API outage
        # can then resume only unfinished/transient files on the next run.
        module.save_review_failure_state(
            date_str, paths, manifest_path, base_head, combined_results,
        )

        def checkpoint(path, result):
            reviewed_sha = result.get('reviewedSha256')
            resolved = Path(path).resolve()
            if result.get('passed') and (
                not resolved.is_file()
                or module._sha256_file(resolved) != reviewed_sha
            ):
                raise module.PublishDataValidationError(
                    f'review worker 返回后页面字节已变化: {resolved.name}'
                )
            combined_results[str(Path(path).resolve())] = result
            module.save_review_failure_state(
                date_str, paths, manifest_path, base_head, combined_results,
            )

        fixed, blocking, current_results = module.review_all_posts(
            date_str,
            paper_slugs,
            scored_papers,
            require_llm=True,
            content_dir=str(content_dir),
            review_paths=plan['paths'],
            return_details=True,
            result_callback=checkpoint,
        )
        combined_results.update(current_results)
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
            module.validate_staged_posts(Path(content_dir), date_str, date_only=True)
            gate = module.run_hugo_gate(blog_repo, Path(content_dir), required=True)
            module.validate_reviewed_file_hashes(
                date_str, paths, manifest_path, combined_results,
            )
        except Exception:
            # A site-wide deterministic/Hugo failure is not safely attributable
            # to a subset of pages; force the next attempt back to full review.
            module.review_failure_path(date_str).unlink(missing_ok=True)
            raise
        receipt = module.save_review_receipt(
            date_str, paths, gate, expected_base_head=base_head,
            generation_manifest=manifest_path,
            reviewed_results=combined_results,
        )
        module.review_failure_path(date_str).unlink(missing_ok=True)
        return receipt


def main():
    require_external_runtime('review-blog.py')
    from log_setup import setup_script_logging
    setup_script_logging(__file__)
    module = load_publish_to_blog()
    date_str = parse_date(module)
    try:
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
