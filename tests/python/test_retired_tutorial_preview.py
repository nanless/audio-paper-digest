"""旧预览可以只读检查，但不能作为新的发布依据。"""
import contextlib
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'manual/tests/python'))
from blog_entry_loader import load_publish_to_blog
import test_sealed_tutorial_preview as preview_fixtures
sealed = preview_fixtures.sealed
publisher = load_publish_to_blog()


class RetiredTutorialPreviewTest(unittest.TestCase):
    def test_cli_rejects_retired_preview_option(self):
        output = io.StringIO()
        with contextlib.redirect_stderr(output), self.assertRaises(SystemExit) as caught:
            publisher.parse_generation_args(['--date', '2026-08-27', '--include-id', '2608.25177', '--sealed-tutorial-preview'])
        self.assertEqual(caught.exception.code, 2)
        self.assertIn('仅供只读检查', output.getvalue())

    def test_generate_rejects_self_consistent_preview_before_any_page_write(self):
        fixture = preview_fixtures.SealedTutorialPreviewTest()
        temporary, current, date, paper_id, post = fixture.make_fixture()
        self.addCleanup(temporary.cleanup)
        root = post.parent
        manifest_path = root / 'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        quality = root / 'quality.json'
        quality.write_text('{"passed":false,"paperId":"different-paper"}\n', encoding='utf-8')
        digest = hashlib.sha256(quality.read_bytes()).hexdigest()
        manifest['inputs']['quality']['sha256'] = digest
        manifest['inputs']['tutorialPayload']['qualityFileSha256'] = digest
        manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
        preview = sealed.load_verified_tutorial_preview(date, paper_id, current_dir=current)
        self.assertEqual(preview['postText'], post.read_text())
        before = {str(p.relative_to(current)): p.read_bytes() for p in current.rglob('*') if p.is_file()}
        blog = Path(temporary.name) / 'blog'
        blog.mkdir()
        options = dict(data_file=None, target_date=date, category='论文速递', publish_all=False,
                       excluded_ids=[], include_id=paper_id, sealed_tutorial_preview=True)
        with mock.patch.object(publisher, 'validate_publish_target', return_value=(blog, blog / 'content/posts')), \
                mock.patch.object(publisher, 'load_verified_tutorial_preview', return_value=preview, create=True), \
                mock.patch.object(publisher, '_require_active_publication_request'), \
                mock.patch.object(publisher, 'generation_input_fingerprint', side_effect=AssertionError('旧预览已进入发布准备')) as fingerprint, \
                mock.patch.object(publisher, 'prepare_generation_journal') as prepare, \
                mock.patch.object(publisher, 'atomic_write_text') as write, \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(publisher.PublishDataValidationError, '仅供只读检查'):
                publisher.generate_main(options)
        fingerprint.assert_not_called()
        prepare.assert_not_called()
        write.assert_not_called()
        self.assertEqual(list(blog.rglob('*')), [])
        self.assertEqual(before, {str(p.relative_to(current)): p.read_bytes() for p in current.rglob('*') if p.is_file()})

    def test_new_generation_mode_and_review_receipt_are_rejected(self):
        with self.assertRaisesRegex(publisher.PublishDataValidationError, '仅供只读检查'):
            publisher.validate_generation_publication_mode([], 'sealed_tutorial_preview')
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'generation.json'
            path.write_text(json.dumps({'publicationMode': 'sealed_tutorial_preview'}))
            with mock.patch.object(publisher, 'save_review_pass_cache') as cache, \
                    mock.patch.object(publisher, 'review_protocol_fingerprint', side_effect=AssertionError('不能继续签发')):
                with self.assertRaisesRegex(publisher.PublishDataValidationError, '仅供只读检查'):
                    publisher.save_review_receipt('2026-08-27', [], None, generation_manifest=path, reviewed_results={})
            cache.assert_not_called()

    def test_existing_preview_manifest_cannot_reach_git_operations(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'generation.json'
            path.write_text(json.dumps({'schemaVersion': 3, 'publicationMode': 'sealed_tutorial_preview'}))
            output = io.StringIO()
            with mock.patch.object(publisher, 'generation_manifest_path', return_value=path), \
                    mock.patch.object(publisher, 'load_verified_review_receipt', return_value=([], Path(tmp) / 'receipt.json')), \
                    mock.patch.object(publisher, '_validate_generation_input_integrity'), \
                    mock.patch.object(publisher, '_load_push_receipt', side_effect=AssertionError('不能继续推送')) as receipt, \
                    mock.patch.object(publisher, '_run_git') as git, \
                    contextlib.redirect_stdout(output):
                self.assertFalse(publisher.git_push('2026-08-27', []))
            receipt.assert_not_called()
            git.assert_not_called()
            self.assertIn('仅供只读检查', output.getvalue())
            self.assertEqual(json.loads(path.read_text())['publicationMode'], 'sealed_tutorial_preview')


if __name__ == '__main__':
    unittest.main()
