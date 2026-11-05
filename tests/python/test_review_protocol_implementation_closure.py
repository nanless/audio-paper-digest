"""日更审查协议跟随共享实现闭包，而不是手写文件清单。"""
import hashlib
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# 从仓库根按点分路径单跑（python -m unittest tests.python.<模块>）时，
# tests/python 不在 sys.path 上；补一条引导，与既有发布测试的导入方式一致。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_publish_to_blog import publish_to_blog as publisher

ROOT = Path(publisher.__file__).resolve().parent.parent
SHARED = ROOT / 'scripts'


class ReviewProtocolImplementationClosureTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(publisher._REVIEW_IMPLEMENTATION_CLOSURE_CACHE.clear)
        self.blog = Path(self.tmp.name) / 'blog'
        (self.blog / 'layouts').mkdir(parents=True)
        (self.blog / 'hugo.yaml').write_text('baseURL: https://example.test/\n', encoding='utf-8')
        (self.blog / 'layouts' / 'single.html').write_text('{{ .Content }}', encoding='utf-8')

    def fingerprint(self):
        with mock.patch.object(publisher, 'BLOG_REPO', str(self.blog)):
            return publisher.review_protocol_fingerprint()

    def test_repeated_computations_match_and_shared_validators_are_included(self):
        first = self.fingerprint()
        self.assertEqual(self.fingerprint(), first)
        closure = set(publisher.review_implementation_closure())
        for relative in (
                'scripts/publish-to-blog.py',
                'scripts/publish_common.py',
                'scripts/review-blog.py',
                'scripts/generate-blog.py',
                'scripts/paper_reader_presentation.py',
                'scripts/markdown_hugo_gate.py',
                'scripts/lib/workflow-implementation-files.js',
                'scripts/lib/workflow-implementation-files-cli.js',
                'config/protocols/tags.json'):
            self.assertIn(relative, closure)

    def test_shared_validator_bytes_change_the_review_protocol(self):
        real_hash = publisher._sha256_file
        shared_validator = SHARED / 'publish_common.py'
        before = self.fingerprint()
        with mock.patch.object(
                publisher, '_sha256_file',
                side_effect=lambda value: '0' * 64
                if Path(value) == shared_validator else real_hash(value)):
            self.assertNotEqual(self.fingerprint(), before)
        self.assertEqual(self.fingerprint(), before)

    def test_isolated_copy_tracks_changed_and_new_shared_dependencies(self):
        root = Path(self.tmp.name) / 'project'
        (root / 'scripts' / 'lib').mkdir(parents=True)
        for name in ('workflow-implementation-files.js',
                     'workflow-implementation-files-cli.js'):
            shutil.copy2(SHARED / 'lib' / name, root / 'scripts' / 'lib' / name)
        entry = root / 'scripts' / 'shared-validator.py'
        entry.write_text('from publish_common import check\n', encoding='utf-8')
        common = root / 'scripts' / 'publish_common.py'
        common.write_text('def check():\n    return 1\n', encoding='utf-8')
        entries = ('scripts/shared-validator.py',
                   'scripts/lib/workflow-implementation-files-cli.js')
        first = publisher._review_protocol_dependency_hashes(root, entries)
        self.assertEqual(publisher._review_protocol_dependency_hashes(root, entries), first)
        self.assertEqual(set(first), {
            'scripts/shared-validator.py',
            'scripts/publish_common.py',
            'scripts/lib/workflow-implementation-files-cli.js',
            'scripts/lib/workflow-implementation-files.js',
        })
        original_common = common.read_bytes()
        common.write_text('def check():\n    return 2\n', encoding='utf-8')
        changed = publisher._review_protocol_dependency_hashes(root, entries)
        self.assertNotEqual(changed, first)
        self.assertEqual(changed['scripts/publish_common.py'],
                         hashlib.sha256(common.read_bytes()).hexdigest())
        common.write_bytes(original_common)
        self.assertEqual(publisher._review_protocol_dependency_hashes(root, entries), first)

        # 新增共享校验器不需要改任何清单：入口再次 import 后自动进入闭包。
        (root / 'scripts' / 'extra_check.py').write_text('VALUE = 3\n', encoding='utf-8')
        entry.write_text('from publish_common import check\nfrom extra_check import VALUE\n',
                         encoding='utf-8')
        publisher._REVIEW_IMPLEMENTATION_CLOSURE_CACHE.clear()
        expanded = publisher._review_protocol_dependency_hashes(root, entries)
        self.assertIn('scripts/extra_check.py', expanded)
        self.assertNotEqual(expanded, first)


if __name__ == '__main__':
    unittest.main()
