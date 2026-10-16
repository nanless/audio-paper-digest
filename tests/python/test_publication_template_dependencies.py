"""New replay implementations participate in generation's content fingerprint."""
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from test_publish_to_blog import publish_to_blog as publisher


class PublicationTemplateDependencyTest(unittest.TestCase):
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
