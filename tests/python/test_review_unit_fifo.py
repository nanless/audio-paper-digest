import multiprocessing
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_publish_to_blog import publish_to_blog as blog


class ReviewUnitSpecialFileTests(unittest.TestCase):
    def check_fifo(self, replace_after_link_check=False):
        with tempfile.TemporaryDirectory() as temporary:
            current = Path(temporary) / 'current'
            with mock.patch.object(blog, 'CURRENT_DIR', current), mock.patch.object(
                blog, 'review_protocol_fingerprint', return_value='a' * 64
            ):
                with blog.review_unit_cache('2026-07-10', Path(temporary) / 'page.md', required=True):
                    self.assertEqual(blog.review_cached_unit('text', {'chunk': 'one'}, lambda: (True, [])), (True, []))
                    checkpoint = next(current.rglob('units/**/*.json'))
                    if not replace_after_link_check:
                        checkpoint.unlink()
                        os.mkfifo(checkpoint, 0o600)
                    context = multiprocessing.get_context('fork')
                    receive, send = context.Pipe(duplex=False)

                    def invoke():
                        request = mock.Mock(side_effect=AssertionError('特殊节点不能启动审查请求'))
                        original = Path.is_symlink
                        swapped = False
                        def check_link(candidate):
                            nonlocal swapped
                            result = original(candidate)
                            if replace_after_link_check and candidate == checkpoint and not swapped:
                                swapped = True
                                checkpoint.unlink()
                                os.mkfifo(checkpoint, 0o600)
                            return result
                        try:
                            with mock.patch.object(Path, 'is_symlink', check_link):
                                blog.review_cached_unit('text', {'chunk': 'one'}, request)
                            send.send(('accepted', '', request.call_count, checkpoint.lstat().st_ino))
                        except Exception as error:
                            send.send((type(error).__name__, str(error), request.call_count, checkpoint.lstat().st_ino))
                        finally:
                            send.close()

                    child = context.Process(target=invoke)
                    child.start()
                    send.close()
                    try:
                        child.join(4)
                        self.assertFalse(child.is_alive(), '真实审查恢复入口不能在 FIFO 上等待')
                        self.assertEqual(child.exitcode, 0)
                        self.assertTrue(receive.poll(1), '子进程必须返回检查结果')
                        error_type, message, calls, inode = receive.recv()
                        self.assertEqual(error_type, 'PublishDataValidationError')
                        self.assertIn('普通 JSON 文件', message)
                        self.assertEqual(calls, 0)
                        after = checkpoint.lstat()
                        self.assertTrue(stat.S_ISFIFO(after.st_mode))
                        self.assertEqual(after.st_ino, inode)
                    finally:
                        if child.is_alive():
                            child.terminate()
                            child.join()
                        receive.close()

    def test_existing_fifo_rejected_before_request(self):
        self.check_fifo()

    def test_regular_checkpoint_replaced_after_link_check_rejected(self):
        self.check_fifo(replace_after_link_check=True)


if __name__ == '__main__':
    unittest.main()
