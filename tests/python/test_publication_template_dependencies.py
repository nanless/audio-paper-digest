"""New replay implementations participate in generation's content fingerprint."""
import shutil
import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest import mock
from test_publish_to_blog import publish_to_blog as publisher


class PublicationTemplateDependencyTest(unittest.TestCase):
    def test_each_new_replay_leaf_changes_current_generation_and_review_protocol(self):
        scripts = Path(publisher.__file__).resolve().parent
        original = publisher._sha256_file
        targets = [scripts/'publication_local_replay.py', scripts/'publication_replay_policy.json',
                   scripts/'lib/reader-resource-claims-replay-cli.js']
        with mock.patch.object(publisher, 'blog_runtime_fingerprint', return_value='9'*64), \
                mock.patch.object(publisher, '_run_bounded_subprocess', return_value=SimpleNamespace(
                    returncode=0, timed_out=False, output_truncated=False, stdout='hugo fixture', stderr='')), \
                mock.patch.dict(publisher._REVIEW_PROTOCOL_CACHE, {}, clear=True):
            generation = publisher.generation_template_fingerprint()
            review = publisher.review_protocol_fingerprint()
            for target in targets:
                with self.subTest(target=target), mock.patch.object(publisher, '_sha256_file',
                        side_effect=lambda value, changed=target: '0'*64 if Path(value) == changed else original(value)):
                    self.assertNotEqual(publisher.generation_template_fingerprint(), generation)
                    self.assertNotEqual(publisher.review_protocol_fingerprint(), review)
            self.assertEqual(publisher.generation_template_fingerprint(), generation)
            self.assertEqual(publisher.review_protocol_fingerprint(), review)

    def test_author_bridge_and_pdf_helpers_use_current_actual_file_bytes(self):
        original = publisher._sha256_file
        with mock.patch.object(publisher, '_sha256_file', wraps=original) as reads:
            expected = publisher.generation_template_fingerprint()
        scripts = Path(publisher.__file__).resolve().parent
        paths = [Path(call.args[0]) for call in reads.call_args_list]
        targets = ['lib/reader-author-replay-cli.js',
                   'lib/reader-pdf-extraction-scope.js',
                   'lib/reader-sealed-pdf-column-units.js']
        for target in targets:
            self.assertIn(scripts/target, paths)
        with tempfile.TemporaryDirectory() as tmp:
            isolated = Path(tmp)/'scripts'
            for file in paths:
                if file.is_relative_to(scripts):
                    destination = isolated/file.relative_to(scripts)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(file, destination)
            with mock.patch.object(publisher, '__file__', str(isolated/'publish-to-blog.py')):
                self.assertEqual(publisher.generation_template_fingerprint(), expected)
                for target in targets:
                    with self.subTest(target=target):
                        file = isolated/target
                        before = file.read_bytes()
                        file.write_bytes(before+b'\n// controlled fingerprint mutation\n')
                        self.assertNotEqual(publisher.generation_template_fingerprint(), expected)
                        file.write_bytes(before)
                        self.assertEqual(publisher.generation_template_fingerprint(), expected)
