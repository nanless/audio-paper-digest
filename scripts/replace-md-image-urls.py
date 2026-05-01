#!/usr/bin/env python3
"""
替换博客 Markdown 中的本地图片路径为 R2 外部 URL

用法：
    python3 scripts/replace-md-image-urls.py [--base-path /audio-paper-digest-blog]

逻辑：
    1. 读取 data/current/r2-image-mapping.json
    2. 遍历博客仓库 content/posts/ 下所有 .md 文件
    3. 将 BASE_PATH/images/... 替换为 IMAGE_BASE_URL/...
    4. git commit 推送

前置条件：
    migrate-images-to-r2.py 已运行并生成映射文件
"""
import os
import re
import sys
import json
import subprocess

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from log_setup import setup_script_logging

setup_script_logging(__file__)

BLOG_REPO = os.path.expanduser(
    os.environ.get("PAPER_DIGEST_BLOG_REPO", "~/code/github_repos/audio-paper-digest-blog")
)
CONTENT_DIR = os.path.join(BLOG_REPO, 'content', 'posts')
BASE_PATH = os.environ.get('PAPER_DIGEST_BLOG_BASE_PATH', '/audio-paper-digest-blog').rstrip('/')

# 从 image_host 读取 IMAGE_BASE_URL
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from image_host import IMAGE_BASE_URL

MAPPING_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    'data', 'current', 'r2-image-mapping.json'
)

GITHUB_REMOTE = os.environ.get('PAPER_DIGEST_GITHUB_REMOTE', 'origin')


def main():
    if not IMAGE_BASE_URL:
        print("❌ IMAGE_BASE_URL 未设置，请检查 ~/.hermes/.env")
        sys.exit(1)

    if not os.path.exists(MAPPING_FILE):
        print(f"❌ 映射文件不存在：{MAPPING_FILE}")
        print("   请先运行：python3 scripts/migrate-images-to-r2.py")
        sys.exit(1)

    with open(MAPPING_FILE, 'r') as f:
        mapping = json.load(f)

    if not mapping:
        print("❌ 映射文件为空")
        sys.exit(1)

    # 收集所有 md 文件
    md_files = []
    for root, dirs, files in os.walk(CONTENT_DIR):
        for f in files:
            if f.endswith('.md'):
                md_files.append(os.path.join(root, f))

    print(f"📄 发现 {len(md_files)} 个 Markdown 文件")
    print(f"🔗 映射条目：{len(mapping)}")
    print()

    replaced = 0
    modified_files = []

    # 构建替换规则：本地路径 -> 外部 URL
    # Markdown 中的图片引用格式：![desc](/base-path/images/icassp-2026/.../file.png)
    # 需要替换的是 /base-path/images/xxx -> https://images.xxx/xxx
    for md_path in md_files:
        with open(md_path, 'r', encoding='utf-8') as f:
            content = f.read()

        original = content
        # 按映射文件中的路径进行替换
        for rel_path, public_url in mapping.items():
            # 本地 Markdown 中的路径格式
            local_pattern = f'{BASE_PATH}/images/{rel_path}'
            if local_pattern in content:
                content = content.replace(local_pattern, public_url)

        if content != original:
            with open(md_path, 'w', encoding='utf-8') as f:
                f.write(content)
            replaced += 1
            modified_files.append(md_path)
            rel_md = os.path.relpath(md_path, BLOG_REPO)
            print(f"  ✅ 已替换 {rel_md}")

    print()
    print(f"📊 完成：{replaced}/{len(md_files)} 个文件被修改")

    if replaced == 0:
        print("ℹ️ 没有需要替换的路径，可能已经是外部 URL")
        return

    # git commit + push
    print()
    print("🚀 提交到 Git...")
    subprocess.run(['git', 'add', '-A'], check=True, cwd=BLOG_REPO)
    result = subprocess.run(
        ['git', 'diff', '--cached', '--stat'],
        capture_output=True, text=True, cwd=BLOG_REPO
    )
    print(result.stdout)

    subprocess.run(
        ['git', 'commit', '-m', 'refactor: 将图片引用迁移到 R2 图床'],
        check=True, cwd=BLOG_REPO
    )
    subprocess.run(
        ['git', 'push', GITHUB_REMOTE, 'main'],
        check=True, cwd=BLOG_REPO
    )
    print("✅ 已推送到 GitHub")
    print()
    print("💡 下一步（可选）：")
    print("   1. 删除 static/images/ 目录并提交")
    print("   2. 运行 hugo server 本地验证")
    print("   3. 确认图片正常加载后 push")


if __name__ == '__main__':
    main()
