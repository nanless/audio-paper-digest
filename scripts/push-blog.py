#!/usr/bin/env python3
"""Push reviewed blog pages, verify the remote OID, then plan independent visual tasks."""

import argparse
import sys

from project_env import load_project_env
load_project_env()

from blog_entry_loader import load_publish_to_blog
from runtime_guard import require_external_runtime


def parse_options(module, argv=None):
    parser = argparse.ArgumentParser(
        prog='push-blog.py',
        description='只提交并推送已经取得严格 review 凭证的博客文件。',
        allow_abbrev=False,
    )
    parser.add_argument('--date', action='append',
                        help='博客批次日期（YYYY-MM-DD；省略时为北京时间今天）')
    parser.add_argument('--require-visual-plan', action='store_true',
                        help='视觉规划失败时以非零状态退出（默认日更编排使用）')
    args = parser.parse_args(argv)
    if args.date and len(args.date) > 1:
        parser.error('--date 只能指定一次')
    return (
        module.validate_publish_date(module.get_today_bj(args.date[0] if args.date else None)),
        args.require_visual_plan,
    )


def parse_date(module, argv=None):
    return parse_options(module, argv)[0]


def main():
    require_external_runtime('push-blog.py')
    from log_setup import setup_script_logging
    setup_script_logging(__file__)
    module = load_publish_to_blog()
    try:
        module.validate_publish_target()
        date_str, require_visual_plan = parse_options(module)
        with module.blog_publication_lock(date_str):
            paths, receipt = module.load_verified_review_receipt(date_str)
            visual_capable = module.preflight_post_publish_visual_capability(
                date_str, require_visual_plan=require_visual_plan,
            )
            module.validate_git_publish_branch()
            module.validate_git_index(paths)
            print(f'🧾 已验证审查凭证: {receipt}')
            print(f'📦 直接提交推送 {len(paths)} 个已审查路径（不生成、不 review）')
            if not module.git_push(date_str, paths):
                raise module.PublishDataValidationError('Git 提交或推送未完成')
            if visual_capable:
                print('🎨 全部博客已发布并通过远端 OID 校验，开始建立发布后视觉任务')
                visual_planned = module.plan_post_publish_visual_assets(date_str)
                if require_visual_plan and not visual_planned:
                    print('\n❌ 博客已发布并验证远端 OID，但发布后视觉任务规划失败')
                    print(f'   可重试: npm run visual:post-publish -- --date {date_str}')
                    sys.exit(2)
            else:
                visual_planned = None
    except module.PublishDataValidationError as exc:
        print(f'\n❌ 博客推送失败: {exc}')
        sys.exit(1)
    except TimeoutError as exc:
        print(f'\n❌ 博客仓库或同日期事务正在运行: {exc}')
        sys.exit(1)
    if visual_planned:
        print('\n🎉 全部博客推送完成；TOP 10 论文长图与汇总图任务已建立！')
    elif visual_planned is False:
        print('\n🎉 全部博客推送完成；发布后视觉任务尚待重试。')
    else:
        print('\n🎉 历史维护博客推送完成；该 generation schema 不适用发布后视觉任务。')


if __name__ == '__main__':
    main()
