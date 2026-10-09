import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from test_publish_to_blog import publish_to_blog as blog, valid_png


class LocalImageParentReplacementTests(unittest.TestCase):
    def invoke(self, repo, relative):
        base = 'https://raw.githubusercontent.com/owner/repository/main'
        with mock.patch.dict(os.environ, {
            'PAPER_DIGEST_IMAGE_REPO': str(repo),
            'PAPER_DIGEST_IMAGE_BASE_URL': base,
        }), mock.patch.object(
            blog, '_download_review_image', return_value={'remote': True}) as remote:
            result = blog._load_review_image(base + '/' + relative)
            return result, remote.call_count

    def test_parent_replaced_before_open_cannot_read_outside_repo(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            repo = root / 'repo'
            inside = repo / 'folder'
            outside = root / 'outside'
            inside.mkdir(parents=True)
            outside.mkdir()
            inside.joinpath('image.png').write_bytes(valid_png())
            external = valid_png() + b'outside sentinel'
            outside.joinpath('image.png').write_bytes(external)
            original = os.open
            swapped = False

            def opening(file, flags, *args, **kwargs):
                nonlocal swapped
                # 旧实现直接打开完整文件路径；新实现按目录描述符逐层打开。
                if not swapped and (file == inside / 'image.png' or str(file) == 'folder'):
                    swapped = True
                    inside.rename(repo / 'original-folder')
                    inside.symlink_to(outside, target_is_directory=True)
                return original(file, flags, *args, **kwargs)

            with mock.patch.object(os, 'open', opening):
                result, calls = self.invoke(repo, 'folder/image.png')
            self.assertTrue(swapped, '测试必须实际替换父目录')
            self.assertEqual(result, {'remote': True}, '已被替换的父目录不能提供本地图片字节')
            self.assertEqual(calls, 1)
            self.assertEqual(outside.joinpath('image.png').read_bytes(), external)
            self.assertEqual(repo.joinpath('original-folder/image.png').read_bytes(), valid_png())

    def test_parent_replaced_after_directory_open_uses_already_open_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            repo = root / 'repo'
            inside = repo / 'folder'
            outside = root / 'outside'
            inside.mkdir(parents=True)
            outside.mkdir()
            inside.joinpath('image.png').write_bytes(valid_png())
            external = valid_png() + b'outside sentinel'
            outside.joinpath('image.png').write_bytes(external)
            original = os.open
            swapped = False

            def opening(file, flags, *args, **kwargs):
                nonlocal swapped
                descriptor = original(file, flags, *args, **kwargs)
                if not swapped and str(file) == 'folder' and kwargs.get('dir_fd') is not None:
                    swapped = True
                    inside.rename(repo / 'original-folder')
                    inside.symlink_to(outside, target_is_directory=True)
                return descriptor

            with mock.patch.object(os, 'open', opening):
                result, calls = self.invoke(repo, 'folder/image.png')
            self.assertTrue(swapped, '测试必须在打开目录后实际替换父目录')
            self.assertEqual(result['data'], blog.base64.b64encode(valid_png()).decode('ascii'))
            self.assertEqual(calls, 0)
            self.assertEqual(outside.joinpath('image.png').read_bytes(), external)
