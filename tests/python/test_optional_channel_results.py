import asyncio
import base64
import importlib.util
import io
import os
import sys
import tempfile
import unittest
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_env_isolation import project_env_scope


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


with project_env_scope():
    xhs = load_module('xhs_result_tested', 'xiaohongshu-publisher.py')
    wechat = load_module('wechat_result_tested', 'publish-wechat-full.py')


class OptionalChannelResultsTest(unittest.TestCase):
    def run_xhs(self, title_found=True, body_found=True, confirmed=True, stale_notice=False):
        page = mock.MagicMock()
        page.url = 'https://creator.xiaohongshu.com/publish/publish'
        for name in ['goto', 'wait_for_timeout', 'screenshot']:
            setattr(page, name, mock.AsyncMock())
        page.query_selector_all = mock.AsyncMock(return_value=[])
        nav = mock.MagicMock()
        nav.count = mock.AsyncMock(return_value=0)
        nav.first = nav
        success = mock.MagicMock()
        async def wait_success(*, state, timeout):
            if state == 'hidden' and stale_notice or state == 'visible' and not confirmed:
                raise xhs.PWTimeout('没有本次发布的成功确认')

        success.wait_for = mock.AsyncMock(side_effect=wait_success)
        page.get_by_text.side_effect = lambda text, **kwargs: success if text == '发布成功' else nav
        page.locator.return_value = nav
        button = mock.MagicMock()
        button.click = mock.AsyncMock()

        async def selector(value, **kwargs):
            if value == 'button:has-text("发布")':
                return button
            raise xhs.PWTimeout('没有匹配元素')

        async def evaluate(source, *args):
            if args == ('测试标题',):
                return 'found by placeholder' if title_found else 'not found'
            if args == ('测试正文',):
                return 'found contenteditable' if body_found else 'not found'
            return 'not found'

        page.wait_for_selector = selector
        page.evaluate = mock.AsyncMock(side_effect=evaluate)
        context = mock.MagicMock()
        context.new_page = mock.AsyncMock(return_value=page)
        browser = mock.MagicMock()
        browser.new_context = mock.AsyncMock(return_value=context)
        browser.close = mock.AsyncMock()
        playwright = mock.MagicMock()
        playwright.chromium.launch = mock.AsyncMock(return_value=browser)
        manager = mock.MagicMock()
        manager.__aenter__ = mock.AsyncMock(return_value=playwright)
        manager.__aexit__ = mock.AsyncMock(return_value=False)
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            stack.enter_context(mock.patch.object(xhs, 'PROJECT_ROOT', Path(tmp)))
            stack.enter_context(mock.patch.object(xhs, 'async_playwright', return_value=manager))
            stack.enter_context(mock.patch.object(xhs, 'load_cookies', mock.AsyncMock(return_value=True)))
            save = stack.enter_context(mock.patch.object(xhs, 'save_cookies', mock.AsyncMock()))
            stack.enter_context(mock.patch.object(asyncio, 'sleep', mock.AsyncMock()))
            stack.enter_context(mock.patch.object(sys.stdin, 'isatty', return_value=False))
            stack.enter_context(redirect_stdout(io.StringIO()))
            result = asyncio.run(xhs.publish_note('测试标题', '测试正文'))
        return result, button.click.await_count, save.await_count, success.wait_for.await_count

    def test_missing_title_or_body_never_clicks_publish(self):
        for title, body in [(False, True), (True, False), (False, False)]:
            with self.subTest(title=title, body=body):
                self.assertEqual(self.run_xhs(title, body), (False, 0, 0, 0))

    def test_click_without_platform_confirmation_is_not_success(self):
        self.assertEqual(self.run_xhs(confirmed=False), (False, 1, 0, 2))

    def test_platform_confirmation_completes_the_existing_publish_flow(self):
        self.assertEqual(self.run_xhs(), (True, 1, 1, 2))

    def test_existing_success_notice_never_authorizes_another_publish(self):
        self.assertEqual(self.run_xhs(stale_notice=True), (False, 0, 0, 1))

    def test_wechat_rejects_local_files_before_reading_or_uploading(self):
        with tempfile.TemporaryDirectory() as tmp:
            local = Path(tmp) / 'fake-local-data'
            local.write_bytes(b'fixture content only\n' * 20)
            with mock.patch.dict(os.environ, {'HTTPS_PROXY': 'http://127.0.0.1:9'}), \
                    mock.patch.object(wechat, 'upload_to_wechat') as upload, redirect_stdout(io.StringIO()):
                self.assertIsNone(wechat.download_image(local.as_uri()))
                self.assertIsNone(wechat.download_image('http://127.0.0.1/example.png'))
                self.assertIsNone(wechat.download_image('https://127.0.0.1/example.png'))
            upload.assert_not_called()

    def test_wechat_uses_checked_image_bytes_and_the_actual_file_type(self):
        data = b'\x89PNG\r\n\x1a\n' + b'checked fixture'
        downloader = mock.Mock(return_value={'media_type': 'image/png', 'data': base64.b64encode(data).decode()})
        url = 'https://arxiv.org/html/fixture/figure.svg'
        with mock.patch.object(wechat, '_image_downloader', return_value=downloader), \
                mock.patch.object(wechat, '_image_cache', {}), \
                mock.patch.object(wechat, 'upload_to_wechat', return_value='https://example.com/cdn.png') as upload, \
                mock.patch.object(wechat, 'atomic_write_json'):
            self.assertEqual(wechat.get_wechat_image_url('fixture-token', url), 'https://example.com/cdn.png')
        downloader.assert_called_once_with(url)
        upload.assert_called_once_with('fixture-token', data, 'fig.png')
