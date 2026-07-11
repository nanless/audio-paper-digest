#!/usr/bin/env python3
"""Verify a saved review receipt, then commit and push without re-reviewing."""

import sys

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


def main():
    module = load_publish_to_blog()
    try:
        module.validate_publish_target()
        date_str = parse_date(module)
        paths, receipt = module.load_verified_review_receipt(date_str)
        module.validate_git_publish_branch()
        module.validate_git_index(paths)
        print(f'🧾 已验证审查凭证: {receipt}')
        print(f'📦 直接提交推送 {len(paths)} 个已审查路径（不生成、不 review）')
        if not module.git_push(date_str, paths):
            raise module.PublishDataValidationError('Git 提交或推送未完成')
    except module.PublishDataValidationError as exc:
        print(f'\n❌ 博客推送失败: {exc}')
        sys.exit(1)
    print('\n🎉 博客推送完成！')


if __name__ == '__main__':
    main()
