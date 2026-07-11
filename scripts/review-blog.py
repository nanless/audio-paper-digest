#!/usr/bin/env python3
"""Strictly review an existing generated blog manifest and save a hash receipt."""

import re
import sys
from pathlib import Path

from project_env import load_project_env
load_project_env()

from log_setup import setup_script_logging
setup_script_logging(__file__)

from blog_entry_loader import load_publish_to_blog


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


def main():
    module = load_publish_to_blog()
    try:
        blog_repo, content_dir = module.validate_publish_target()
        date_str = parse_date(module)
        paths, manifest_path = module.load_generation_manifest(date_str)
        paper_slugs, scored_papers = read_generated_pages(module, date_str, paths)
        print(f'📋 读取生成清单: {manifest_path}')
        print(f'🔍 开始严格 review: {len(paper_slugs)} 篇论文')
        fixed, blocking = module.review_all_posts(
            date_str,
            paper_slugs,
            scored_papers,
            require_llm=True,
            content_dir=str(content_dir),
        )
        if blocking:
            raise module.PublishDataValidationError(f'review 仍有 {blocking} 个未解决阻断问题')
        if fixed:
            print(f'✅ review 自动修复 {fixed} 个文件')
        module.validate_staged_posts(Path(content_dir), date_str, date_only=True)
        gate = module.run_hugo_gate(blog_repo, Path(content_dir), required=True)
        receipt = module.save_review_receipt(date_str, paths, gate)
    except (module.PublishDataValidationError, module.PublishLLMUnavailable) as exc:
        print(f'\n❌ review 失败，未生成审查凭证: {exc}')
        sys.exit(1)
    print(f'🧾 审查凭证: {receipt}')
    print(f'\n✅ review 完成；下一步: python3 scripts/push-blog.py --date {date_str}')


if __name__ == '__main__':
    main()
