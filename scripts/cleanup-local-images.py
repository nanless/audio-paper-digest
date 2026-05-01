#!/usr/bin/env python3
"""
清理博客仓库中的本地图片文件

用法：
    python3 scripts/cleanup-local-images.py [--dry-run]

流程：
    1. 确认 R2 映射文件存在且有内容
    2. 删除博客仓库 static/images/ 目录
    3. git commit + push

安全：
    --dry-run 只打印要删除的文件，不实际执行
"""
import os
import sys
import json
import subprocess

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from log_setup import setup_script_logging

setup_script_logging(__file__)

BLOG_REPO = os.path.expanduser(
    os.environ.get("PAPER_DIGEST_BLOG_REPO", "~/code/github_repos/audio-paper-digest-blog")
)
STATIC_IMAGES_DIR = os.path.join(BLOG_REPO, 'static', 'images')
MAPPING_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    'data', 'current', 'r2-image-mapping.json'
)
GITHUB_REMOTE = os.environ.get('PAPER_DIGEST_GITHUB_REMOTE', 'origin')


def main():
    dry_run = '--dry-run' in sys.argv

    # 安全检查：确认映射文件存在
    if not os.path.exists(MAPPING_FILE):
        print(f"❌ 映射文件不存在：{MAPPING_FILE}")
        print("   请先运行 migrate-images-to-r2.py 确保图片已上传到图床")
        sys.exit(1)

    with open(MAPPING_FILE, 'r') as f:
        mapping = json.load(f)

    if not mapping:
        print("❌ 映射文件为空，无法确认图片已上传")
        sys.exit(1)

    if not os.path.exists(STATIC_IMAGES_DIR):
        print(f"ℹ️ 本地图片目录不存在：{STATIC_IMAGES_DIR}")
        return

    # 统计要删除的文件
    total_files = 0
    for root, dirs, files in os.walk(STATIC_IMAGES_DIR):
        total_files += len(files)

    du = subprocess.run(
        ['du', '-sh', STATIC_IMAGES_DIR],
        capture_output=True, text=True
    )
    size_str = du.stdout.split()[0] if du.returncode == 0 else '?'

    print(f"🗑️  将删除 {total_files} 个文件，释放约 {size_str}")
    print(f"   目录：{STATIC_IMAGES_DIR}")
    print()

    if dry_run:
        print("📝 [DRY RUN] 以下文件将被删除：")
        for root, dirs, files in os.walk(STATIC_IMAGES_DIR):
            for f in files:
                print(f"   {os.path.join(root, f)}")
        print()
        print("💡 移除 --dry-run 参数以实际执行")
        return

    # 确认
    confirm = input("确认删除并提交到 Git？这将释放 Git 仓库空间 [y/N]: ")
    if confirm.lower() != 'y':
        print("❌ 已取消")
        return

    # 删除目录
    import shutil
    shutil.rmtree(STATIC_IMAGES_DIR)
    print(f"✅ 已删除 {STATIC_IMAGES_DIR}")

    # git commit + push
    subprocess.run(['git', 'add', '-A'], check=True, cwd=BLOG_REPO)
    subprocess.run(
        ['git', 'commit', '-m', 'refactor: 移除本地 static/images，图片已迁移到 R2 图床'],
        check=True, cwd=BLOG_REPO
    )
    subprocess.run(
        ['git', 'push', GITHUB_REMOTE, 'main'],
        check=True, cwd=BLOG_REPO
    )
    print("✅ 已推送到 GitHub")
    print()
    print("💡 提示：")
    print("   1. Git 历史中的旧图片不会被自动清理，如需彻底瘦身可运行：")
    print("      git filter-repo --path static/images/ --invert-paths")
    print("   2. 或使用 BFG Repo-Cleaner：")
    print("      java -jar bfg.jar --delete-folders images")


if __name__ == '__main__':
    main()
