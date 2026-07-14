#!/usr/bin/env python3
"""Safely replan post-publication visuals under the blog publication lock."""

import sys

from project_env import load_project_env
load_project_env()

from blog_entry_loader import load_publish_to_blog
from runtime_guard import require_external_runtime


def main():
    require_external_runtime('plan-post-publish-visuals.py')
    from log_setup import setup_script_logging
    setup_script_logging(__file__)
    module = load_publish_to_blog()
    target = None
    for index, arg in enumerate(sys.argv[1:]):
        if arg == '--date' and index + 2 < len(sys.argv):
            target = sys.argv[index + 2]
    date_str = module.validate_publish_date(module.get_today_bj(target))
    try:
        with module.blog_publication_lock(date_str):
            if not module.plan_post_publish_visual_assets(date_str):
                sys.exit(1)
    except (module.PublishDataValidationError, TimeoutError) as exc:
        print(f'❌ 发布后视觉任务规划失败: {exc}')
        sys.exit(1)


if __name__ == '__main__':
    main()
