#!/usr/bin/env python3
"""只读核验发布页面所绑定的标签词表已完整安装在博客中。"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat

from blog_entry_loader import load_publish_to_blog
from tag_catalog import _parse_tag_catalog_bytes
import tag_paths


def _read_regular(path):
    path = Path(path).absolute()
    for item in (path, *path.parents):
        if item.is_symlink():
            raise ValueError('标签发布词表及其父目录不能是符号链接。')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 \
                or not 0 < before.st_size <= 16 * 1024 * 1024:
            raise ValueError('标签发布词表必须是有界且单硬链接的普通文件。')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            raw = stream.read(16 * 1024 * 1024 + 1)
        after, named = os.fstat(fd), path.lstat()
        signature = lambda value: (value.st_dev, value.st_ino, value.st_size,
                                   value.st_mtime_ns, value.st_ctime_ns)
        if len(raw) != before.st_size or signature(before) != signature(after) \
                or signature(after) != signature(named):
            raise ValueError('标签发布词表在核验期间发生变化。')
        return raw
    finally:
        os.close(fd)


def _json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('标签发布词表含重复 JSON 字段。')
            result[key] = value
        return result
    return json.loads(raw.decode('utf-8'), object_pairs_hook=unique)


def validate_published_tag_catalog(blog_repo, registry_sha, registry_version):
    """核验原配置字节、双份显示资源、版本目录及本次使用的完整归档。"""
    if not isinstance(registry_sha, str) or not re.fullmatch(r'[a-f0-9]{64}', registry_sha) \
            or not isinstance(registry_version, str) or not registry_version:
        raise ValueError('标签发布核验需要有效的词表 SHA 和版本。')
    repo = Path(blog_repo).absolute()
    source_path = Path(tag_paths.TAG_CATALOG_FILE).absolute()
    try:
        source_raw = _read_regular(source_path)
        if hashlib.sha256(source_raw).hexdigest() != registry_sha:
            source_path = source_path.parent / 'tag-catalog-history' / f'{registry_sha}.json'
            source_raw = _read_regular(source_path)
        if hashlib.sha256(source_raw).hexdigest() != registry_sha:
            raise ValueError('项目原词表字节与页面绑定 SHA 不一致。')
        source = _parse_tag_catalog_bytes(source_raw)
        if source['version'] != registry_version:
            raise ValueError('项目原词表版本与页面绑定版本不一致。')
        publisher = load_publish_to_blog()
        expected = publisher.build_tag_catalog_snapshot(source)
        records = []

        def pair(relative):
            names = [f'{prefix}/{relative}' for prefix in ('data', 'static/data')]
            raws = [_read_regular(repo / name) for name in names]
            if raws[0] != raws[1]:
                raise ValueError('博客 data/static 标签词表副本字节不一致。')
            records.extend({'path': name, 'sha256': hashlib.sha256(raw).hexdigest()}
                           for name, raw in zip(names, raws))
            return _json(raws[0])

        display = pair('tag-catalog-snapshot.json')
        versions = pair('tag-catalog-versions.json')
        if not isinstance(display, dict) or not isinstance(versions, dict) \
                or versions.get('contract') != publisher.TAG_CATALOG_VERSIONS_CONTRACT \
                or display.get('contract') != publisher.TAG_CATALOG_SNAPSHOT_CONTRACT:
            raise ValueError('博客标签显示资源不是当前受控格式。')
        saved = publisher._validate_tag_version_catalog(versions)
        publisher._validate_tag_catalog_snapshot(display)
        current = saved[versions['currentSha256']]
        if display != publisher._build_tag_catalog_display_snapshot(current):
            raise ValueError('博客当前显示词表与版本目录不一致。')
        issued = saved.get(registry_sha)
        if issued is None or publisher._build_tag_catalog_display_snapshot(issued) != expected:
            raise ValueError('博客版本目录缺少本次原词表，或概念、名称、维度、层级不一致。')
        archived = pair(f'tag-catalog-history/{registry_sha}.json')
        if archived != issued:
            raise ValueError('博客本次词表完整归档与版本目录不一致。')
        return {'contract': 'published-tag-catalog-availability-v1',
                'registrySha256': registry_sha, 'registryVersion': registry_version,
                'displayRegistrySha256': display['registrySha256'],
                'sourceCatalogSha256': hashlib.sha256(source_raw).hexdigest(),
                'files': records, 'valid': True}
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ValueError('发布标签词表未完整同步；请先通过受控词表发布同步完整版本及双份归档：'
                         + str(error)) from error


def main():
    from runtime_guard import require_external_runtime, require_workspace_role
    require_external_runtime('tag_catalog_publication.py')
    require_workspace_role('daily')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--blog-repo', required=True)
    parser.add_argument('--registry-sha', required=True)
    parser.add_argument('--registry-version', required=True)
    args = parser.parse_args()
    print(json.dumps(validate_published_tag_catalog(
        args.blog_repo, args.registry_sha, args.registry_version), ensure_ascii=False))


if __name__ == '__main__':
    main()
