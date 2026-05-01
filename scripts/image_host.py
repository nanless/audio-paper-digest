#!/usr/bin/env python3
"""
图床上传模块 - S3 兼容存储（Cloudflare R2 / 七牛云 / AWS S3 等）

功能：
- 上传图片到 S3 兼容存储，保持目录结构
- 本地缓存避免重复上传（MD5 校验）
- 支持并发上传

环境变量（通用 S3 命名，兼容旧 R2 命名）：
  PAPER_DIGEST_IMAGE_HOST=r2|s3|qiniu
  PAPER_DIGEST_S3_ENDPOINT=https://s3.cn-east-1.qiniucs.com
  PAPER_DIGEST_S3_BUCKET=paper-digest-images
  PAPER_DIGEST_S3_ACCESS_KEY=xxx
  PAPER_DIGEST_S3_SECRET_KEY=xxx
  PAPER_DIGEST_IMAGE_BASE_URL=https://images.your-domain.com
"""

import hashlib
import json
import os
from pathlib import Path

# 上传缓存文件路径
CACHE_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    'data', 'current', 'image-upload-cache.json'
)

# 读取环境变量（兼容 R2 旧命名和新的通用 S3 命名）
IMAGE_HOST = os.environ.get('PAPER_DIGEST_IMAGE_HOST', 'local').lower()
S3_ENDPOINT = os.environ.get('PAPER_DIGEST_S3_ENDPOINT', '') or os.environ.get('PAPER_DIGEST_R2_ENDPOINT', '')
S3_BUCKET = os.environ.get('PAPER_DIGEST_S3_BUCKET', '') or os.environ.get('PAPER_DIGEST_R2_BUCKET', '')
S3_ACCESS_KEY = os.environ.get('PAPER_DIGEST_S3_ACCESS_KEY', '') or os.environ.get('PAPER_DIGEST_R2_ACCESS_KEY', '')
S3_SECRET_KEY = os.environ.get('PAPER_DIGEST_S3_SECRET_KEY', '') or os.environ.get('PAPER_DIGEST_R2_SECRET_KEY', '')
IMAGE_BASE_URL = os.environ.get('PAPER_DIGEST_IMAGE_BASE_URL', '').rstrip('/')


def _load_cache():
    """加载上传缓存"""
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, 'r') as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _save_cache(cache):
    """保存上传缓存"""
    os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
    with open(CACHE_FILE, 'w') as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)


def _file_md5(filepath):
    """计算文件 MD5"""
    h = hashlib.md5()
    with open(filepath, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            h.update(chunk)
    return h.hexdigest()


def _get_s3_client():
    """获取 boto3 S3 client（懒加载）"""
    import boto3
    from botocore.config import Config

    return boto3.client(
        's3',
        endpoint_url=S3_ENDPOINT,
        aws_access_key_id=S3_ACCESS_KEY,
        aws_secret_access_key=S3_SECRET_KEY,
        config=Config(
            retries={'max_attempts': 3, 'mode': 'adaptive'},
            connect_timeout=10,
            read_timeout=30,
        ),
    )


def is_configured():
    """检查 S3/R2 配置是否完整"""
    if IMAGE_HOST not in ('r2', 's3', 'qiniu'):
        return False
    return all([S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, IMAGE_BASE_URL])


def is_uploaded(filepath):
    """检查文件是否已上传（通过 MD5 查缓存）"""
    if not os.path.exists(filepath):
        return False
    cache = _load_cache()
    md5 = _file_md5(filepath)
    return cache.get(md5, {}).get('uploaded', False)


def get_cached_url(filepath):
    """从缓存获取已上传文件的 URL"""
    cache = _load_cache()
    md5 = _file_md5(filepath)
    entry = cache.get(md5)
    if entry and entry.get('uploaded'):
        return entry.get('url')
    return None


def upload_image(filepath, remote_key):
    """
    上传图片到 R2

    Args:
        filepath: 本地文件路径
        remote_key: R2 中的 key，如 'icassp-2026/2026-04-29/11460320-0.png'

    Returns:
        public_url: 完整的公开访问 URL
    """
    if not is_configured():
        raise RuntimeError('R2 配置不完整，请检查环境变量')

    # 先查缓存
    cached = get_cached_url(filepath)
    if cached:
        return cached

    # 推断 Content-Type
    ext = os.path.splitext(filepath)[1].lower()
    content_type_map = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
    }
    content_type = content_type_map.get(ext, 'application/octet-stream')

    # 上传
    client = _get_s3_client()
    with open(filepath, 'rb') as f:
        client.put_object(
            Bucket=S3_BUCKET,
            Key=remote_key,
            Body=f,
            ContentType=content_type,
        )

    public_url = f"{IMAGE_BASE_URL}/{remote_key}"

    # 写入缓存
    cache = _load_cache()
    cache[_file_md5(filepath)] = {
        'uploaded': True,
        'url': public_url,
        'remote_key': remote_key,
        'timestamp': __import__('datetime').datetime.now().isoformat(),
    }
    _save_cache(cache)

    return public_url


def upload_images_batch(file_key_pairs, concurrency=10):
    """
    批量上传图片

    Args:
        file_key_pairs: [(local_path, remote_key), ...]
        concurrency: 并发数

    Returns:
        dict: {local_path: public_url or Exception}
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    results = {}

    def _upload_one(pair):
        filepath, remote_key = pair
        try:
            url = upload_image(filepath, remote_key)
            return filepath, url
        except Exception as e:
            return filepath, e

    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = {executor.submit(_upload_one, pair): pair for pair in file_key_pairs}
        for future in as_completed(futures):
            filepath, result = future.result()
            results[filepath] = result

    return results


def get_image_url(remote_key):
    """通过 remote_key 生成公开 URL（不上传，仅拼接）"""
    if not IMAGE_BASE_URL:
        return None
    return f"{IMAGE_BASE_URL}/{remote_key}"


def build_remote_key(date_str, filename, prefix='icassp-2026'):
    """构建 remote_key，保持与现有目录结构一致"""
    return f"{prefix}/{date_str}/{filename}"
