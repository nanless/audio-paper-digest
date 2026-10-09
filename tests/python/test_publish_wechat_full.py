import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_env_isolation import project_env_scope
from test_publish_common import complete_analysis
from utils import parse_analysis

with project_env_scope():
    spec = importlib.util.spec_from_file_location('wechat_full_test', ROOT / 'scripts/publish-wechat-full.py')
    publisher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(publisher)


class WechatMainRenderingTest(unittest.TestCase):
    def invoke(self, *, dry_run, embedded_image=True):
        url = 'https://example.invalid/figure.png?x="&y=<value>'
        cdn_url = 'https://example.invalid/cdn.png?x="&y=<value>'
        analysis = complete_analysis() + '\n## 作者与机构\n作者 <甲> & 乙\n\n## 论文评价\n评价 <范围> & 证据\n\n## 核心摘要\n正文 <script> & 内容\n'
        if embedded_image:
            analysis += f'\n![图 "甲" & <乙>]({url})\n'
        paper = {'arxivId': '2607.00001', 'title': '标题 <甲> & "乙"',
                 'analysis': analysis, 'parsed': parse_analysis(analysis),
                 'scoringRubricVersion': 'type-aware-v1', 'selectedImageUrls': [url]}
        with tempfile.TemporaryDirectory(prefix='wechat-main-render-') as directory:
            preview = Path(directory) / 'preview.html'
            response = mock.Mock()
            response.read.return_value = b'{"media_id":"offline-draft"}'
            response.__enter__ = mock.Mock(return_value=response)
            response.__exit__ = mock.Mock(return_value=False)
            with contextlib.ExitStack() as stack:
                stack.enter_context(mock.patch.object(sys, 'argv', ['publish-wechat-full.py', '--date', '2026-07-01'] + (['--dry-run'] if dry_run else [])))
                loaded = stack.enter_context(mock.patch.object(publisher, 'load_papers_for_publication_date', return_value=[paper]))
                snapshot = stack.enter_context(mock.patch.object(publisher, 'select_blog_published_snapshot', side_effect=lambda papers, date: papers))
                validated = stack.enter_context(mock.patch.object(publisher, 'validate_papers_for_publish', side_effect=lambda papers: papers))
                stack.enter_context(mock.patch.object(publisher, 'wechat_preview_path', return_value=preview))
                stack.enter_context(mock.patch.multiple(publisher, APP_ID='offline-app', APP_SECRET='offline-secret', THUMB_MEDIA_ID='offline-thumb'))
                token = stack.enter_context(mock.patch.object(publisher, 'get_token', return_value='offline-token'))
                upload = stack.enter_context(mock.patch.object(publisher, 'get_wechat_image_url', return_value=cdn_url))
                download = stack.enter_context(mock.patch.object(publisher, 'download_image', side_effect=AssertionError('network forbidden')))
                request = stack.enter_context(mock.patch.object(publisher.urllib.request, 'urlopen', return_value=response if not dry_run else None))
                stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                self.assertTrue(publisher.main())
                loaded.assert_called_once_with('2026-07-01', None)
                snapshot.assert_called_once_with([paper], '2026-07-01')
                validated.assert_called_once_with([paper])
                rendered = preview.read_text()
                self.assertIn('标题 &lt;甲&gt; &amp; &quot;乙&quot;', rendered)
                self.assertIn('正文 &lt;script&gt; &amp; 内容', rendered)
                self.assertNotIn('<script>', rendered)
                expected_url = url if dry_run else cdn_url
                import html
                self.assertIn(f'src="{html.escape(expected_url)}"', rendered)
                if embedded_image:
                    self.assertIn('alt="图 &quot;甲&quot; &amp; &lt;乙&gt;"', rendered)
                download.assert_not_called()
                if dry_run:
                    token.assert_not_called(); upload.assert_not_called(); request.assert_not_called()
                else:
                    token.assert_called_once(); upload.assert_called_once_with('offline-token', url)
                    request.assert_called_once()
                    payload = json.loads(request.call_args.args[0].data)
                    self.assertEqual(payload['articles'][0]['thumb_media_id'], 'offline-thumb')
                    self.assertIn('标题 &lt;甲&gt;', payload['articles'][0]['content'])
                    self.assertIn(f'src="{html.escape(cdn_url)}"', payload['articles'][0]['content'])

    def test_dry_run_renders_escaped_local_preview_without_network(self):
        self.invoke(dry_run=True)

    def test_fake_draft_keeps_rendered_html_payload(self):
        self.invoke(dry_run=False)

    def test_selected_image_fallback_escapes_attribute(self):
        self.invoke(dry_run=True, embedded_image=False)
