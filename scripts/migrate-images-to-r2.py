#!/usr/bin/env python3
"""
存量图片批量迁移到 R2 图床

用法：
    python3 scripts/migrate-images-to-r2.py

流程：
    1. 扫描博客仓库 static/images/ 下所有图片
    2. 对每个图片：MD5 查缓存 → 未上传则上传到 R2
    3. 输出统计：总/已上传/跳过/失败
    4. 生成路径映射文件 data/current/r2-image-mapping.json

前置条件：
    环境变量已配置（~/.hermes/.env）
"""
import os
import sys
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from image_host import (
    is_configured,
    upload_image,
    get_cached_url,
    IMAGE_BASE_URL,
)
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


def main():
    if not is_configured():
        print("❌ R2 配置不完整，请检查 ~/.hermes/.env")
        print("   需要：PAPER_DIGEST_IMAGE_HOST=r2 + R2_ENDPOINT + R2_BUCKET + ACCESS_KEY + SECRET_KEY + IMAGE_BASE_URL")
        sys.exit(1)

    if not os.path.exists(STATIC_IMAGES_DIR):
        print(f"❌ 图片目录不存在：{STATIC_IMAGES_DIR}")
        sys.exit(1)

    # 收集所有图片文件
    image_files = []
    for root, dirs, files in os.walk(STATIC_IMAGES_DIR):
        for f in files:
            if f.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg')):
                image_files.append(os.path.join(root, f))

    total = len(image_files)
    if total == 0:
        print("ℹ️ 没有找到图片文件")
        sys.exit(0)

    print(f"📦 发现 {total} 张图片，开始上传到 R2...")
    print(f"   Bucket: 从环境变量读取")
    print(f"   Base URL: {IMAGE_BASE_URL}")
    print()

    uploaded = 0
    skipped = 0
    failed = 0
    mapping = {}  # local_relative_path -> public_url

    for i, filepath in enumerate(image_files, 1):
        # 计算相对于 static/images/ 的路径，作为 remote_key
        rel_path = os.path.relpath(filepath, STATIC_IMAGES_DIR)
        # 统一使用正斜杠
        remote_key = rel_path.replace(os.sep, '/')

        # 先查缓存
        cached = get_cached_url(filepath)
        if cached:
            print(f"  [{i}/{total}] ⏭️  跳过（已缓存）{rel_path}")
            skipped += 1
            mapping[rel_path] = cached
            continue

        try:
            public_url = upload_image(filepath, remote_key)
            print(f"  [{i}/{total}] ✅ 上传成功 {rel_path}")
            uploaded += 1
            mapping[rel_path] = public_url
        except Exception as e:
            print(f"  [{i}/{total}] ❌ 上传失败 {rel_path}: {e}")
            failed += 1

    # 保存映射文件
    os.makedirs(os.path.dirname(MAPPING_FILE), exist_ok=True)
    with open(MAPPING_FILE, 'w') as f:
        json.dump(mapping, f, indent=2, ensure_ascii=False)

    print()
    print("=" * 50)
    print(f"📊 迁移完成")
    print(f"   总计：   {total}")
    print(f"   已上传： {uploaded}")
    print(f"   已缓存： {skipped}")
    print(f"   失败：   {failed}")
    print(f"   映射文件：{MAPPING_FILE}")
    print()
    if failed > 0:
        print("⚠️ 有失败的图片，可重新运行此脚本重试")
    if uploaded > 0 or skipped > 0:
        print("✅ 下一步：运行 scripts/replace-md-image-urls.py 替换 Markdown 中的本地路径")


if __name__ == '__main__':
    main()
