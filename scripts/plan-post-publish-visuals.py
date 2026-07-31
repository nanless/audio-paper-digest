#!/usr/bin/env python3
"""Safely replan post-publication visuals under the blog publication lock."""

import argparse
import sys

from project_env import load_project_env
load_project_env()

from blog_entry_loader import load_publish_to_blog
from runtime_guard import require_external_runtime


def parse_date(module, argv=None):
    parser = argparse.ArgumentParser(
        prog='plan-post-publish-visuals.py',
        description='在博客远端 OID 验证后幂等建立论文长图与汇总封面任务。',
        allow_abbrev=False,
    )
    parser.add_argument('--date', action='append',
                        help='博客批次日期（YYYY-MM-DD；省略时为北京时间今天）')
    args = parser.parse_args(argv)
    if args.date and len(args.date) > 1:
        parser.error('--date 只能指定一次')
    return module.validate_publish_date(module.get_today_bj(args.date[0] if args.date else None))


def main():
    require_external_runtime('plan-post-publish-visuals.py')
    from log_setup import setup_script_logging
    setup_script_logging(__file__)
    module = load_publish_to_blog()
    try:
        date_str = parse_date(module)
        with module.blog_publication_lock(date_str):
            if not module.plan_post_publish_visual_assets(date_str):
                sys.exit(1)
    except (module.PublishDataValidationError, TimeoutError) as exc:
        print(f'❌ 发布后视觉任务规划失败: {exc}')
        sys.exit(1)


if __name__ == '__main__':
    main()
