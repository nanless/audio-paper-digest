#!/usr/bin/env python3
"""Push reviewed blog pages, verify the remote OID, then plan independent visual tasks."""

import sys

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


def main():
    require_external_runtime('push-blog.py')
    from log_setup import setup_script_logging
    setup_script_logging(__file__)
    module = load_publish_to_blog()
    try:
        module.validate_publish_target()
        date_str = parse_date(module)
        with module.blog_publication_lock(date_str):
            paths, receipt = module.load_verified_review_receipt(date_str)
            module.validate_git_publish_branch()
            module.validate_git_index(paths)
            print(f'🧾 已验证审查凭证: {receipt}')
            print(f'📦 直接提交推送 {len(paths)} 个已审查路径（不生成、不 review）')
            if not module.git_push(date_str, paths):
                raise module.PublishDataValidationError('Git 提交或推送未完成')
            print('🎨 全部博客已发布并通过远端 OID 校验，开始建立发布后视觉任务')
            visual_planned = module.plan_post_publish_visual_assets(date_str)
    except module.PublishDataValidationError as exc:
        print(f'\n❌ 博客推送失败: {exc}')
        sys.exit(1)
    except TimeoutError as exc:
        print(f'\n❌ 博客仓库或同日期事务正在运行: {exc}')
        sys.exit(1)
    if visual_planned:
        print('\n🎉 全部博客推送完成；TOP 10 论文长图与汇总图任务已建立！')
    else:
        print('\n🎉 全部博客推送完成；发布后视觉任务尚待重试。')


if __name__ == '__main__':
    main()
