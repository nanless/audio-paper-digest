import multiprocessing
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock

from test_publish_to_blog import publish_to_blog as blog, valid_png


class LocalImageFileTests(unittest.TestCase):
    def test_internal_links_use_remote_and_root_alias_keeps_local(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / 'repo'
            repo.mkdir()
            image = repo / 'folder/image.png'
            image.parent.mkdir()
            image.write_bytes(valid_png())
            (repo / 'linked.png').symlink_to(image)
            (repo / 'linked-directory').symlink_to(image.parent)
            alias = root / 'root-alias'
            alias.symlink_to(repo)
            base = 'https://raw.githubusercontent.com/owner/repository/main'
            with mock.patch.dict(os.environ, {
                'PAPER_DIGEST_IMAGE_REPO': str(alias),
                'PAPER_DIGEST_IMAGE_BASE_URL': base,
            }):
                for relative in ['linked.png', 'linked-directory/image.png']:
                    url = base + '/' + relative
                    with mock.patch.object(blog, '_download_review_image', return_value={'remote': url}) as remote:
                        self.assertEqual(blog._load_review_image(url), {'remote': url})
                        remote.assert_called_once_with(url)
                with mock.patch.object(blog, '_download_review_image') as remote:
                    self.assertEqual(blog._load_review_image(base + '/folder/image.png')['data'],
                                     blog.base64.b64encode(valid_png()).decode('ascii'))
                    remote.assert_not_called()
                self.assertTrue((repo / 'linked.png').is_symlink())
                self.assertTrue((repo / 'linked-directory').is_symlink())
                self.assertEqual(image.read_bytes(), valid_png())

    @unittest.skipUnless(hasattr(os, 'mkfifo'), '系统不支持命名管道')
    def test_file_replaced_with_fifo_after_is_file_uses_remote_without_wait(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary).resolve()
            image = repo / 'image.png'
            image.write_bytes(valid_png())
            base = 'https://raw.githubusercontent.com/owner/repository/main'
            receive, send = multiprocessing.get_context('fork').Pipe(duplex=False)

            def invoke():
                original = Path.is_file
                swapped = False

                def check(candidate):
                    nonlocal swapped
                    result = original(candidate)
                    if candidate == image and not swapped:
                        swapped = True
                        image.unlink()
                        os.mkfifo(image, 0o600)
                    return result

                with mock.patch.dict(os.environ, {
                    'PAPER_DIGEST_IMAGE_REPO': str(repo),
                    'PAPER_DIGEST_IMAGE_BASE_URL': base,
                }), mock.patch.object(Path, 'is_file', check), mock.patch.object(
                        blog, '_download_review_image', return_value={'remote': True}) as remote:
                    result = blog._load_review_image(base + '/image.png')
                    send.send((result, remote.call_count, image.lstat().st_ino))
                send.close()

            child = multiprocessing.get_context('fork').Process(target=invoke)
            child.start()
            send.close()
            try:
                child.join(4)
                self.assertFalse(child.is_alive(), '本地图片读取不能等待 FIFO 写者')
                self.assertEqual(child.exitcode, 0)
                result, calls, inode = receive.recv()
                self.assertEqual(result, {'remote': True})
                self.assertEqual(calls, 1)
                self.assertTrue(stat.S_ISFIFO(image.lstat().st_mode))
                self.assertEqual(image.lstat().st_ino, inode)
            finally:
                if child.is_alive():
                    child.terminate()
                    child.join()
                receive.close()

    def test_oversize_regular_image_is_rejected_before_read(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            image = repo / 'large.png'
            with image.open('wb') as output:
                output.truncate(blog.REVIEW_IMAGE_MAX_BYTES + 1)
            base = 'https://raw.githubusercontent.com/owner/repository/main'
            with mock.patch.dict(os.environ, {
                'PAPER_DIGEST_IMAGE_REPO': str(repo),
                'PAPER_DIGEST_IMAGE_BASE_URL': base,
            }), mock.patch.object(blog, '_download_review_image') as remote:
                with self.assertRaisesRegex(blog.PublishDataValidationError, '8 MiB'):
                    blog._load_review_image(base + '/large.png')
                remote.assert_not_called()
