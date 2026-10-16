"""Bounded FD batching preserves each item's actual sealed-source authority."""
import copy
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import test_reader_sealed_author_publication_parent as sealed_fixture
publisher = sealed_fixture.publisher


class ReaderAuthorReplayBatchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        maker = sealed_fixture.SealedAuthorPublicationParentTest()
        self.run, self.paper, self.runtime = maker.create_sample(Path(self.tmp.name).resolve())
        self.author_payloads = []
        original = publisher._run_bounded_subprocess
        def observed(command, *args, **kwargs):
            if Path(command[1]).name == 'reader-author-replay-cli.js':
                fd = kwargs['pass_fds'][0]
                raw = os.pread(fd, os.fstat(fd).st_size, 0)
                self.author_payloads.append(json.loads(raw))
            return original(command, *args, **kwargs)
        patch = mock.patch.object(publisher, '_run_bounded_subprocess', side_effect=observed)
        patch.start()
        self.addCleanup(patch.stop)

    def bundle(self, paper=None):
        paper = self.paper if paper is None else paper
        publisher._daily_fresh_validate_bundle(
            self.run, '2610.12345', paper['freshRewriteProvenance'], paper)

    def test_legacy_single_object_and_nine_items_split_eight_plus_one(self):
        self.bundle()
        self.assertNotIn('contract', self.author_payloads[-1])
        before = self.runtime.read_bytes()
        with publisher._reader_author_replay_batch_scope():
            for _ in range(9):
                self.bundle()
        batches = self.author_payloads[1:]
        self.assertEqual([len(x['items']) for x in batches], [8, 1])
        self.assertTrue(all(x['contract'] == 'reader-author-replay-batch-v1' for x in batches))
        self.assertEqual(self.runtime.read_bytes(), before)

    def test_function_returns_only_after_all_real_items_pass(self):
        completed = []
        @publisher._with_reader_author_replay_batch
        def evaluate(papers):
            for paper in papers:
                self.bundle(paper)
            completed.append(True)
            return 'not allowed to escape on failed author replay'
        bad = copy.deepcopy(self.paper)
        record = bad['apiReaderAuthors']
        record['authors'][0]['affiliations'] = ['Invented University']
        bound = record['identity']['authors'][0]
        bound['affiliations'] = ['Invented University']
        bound['affiliationBindings'][0]['sourceValue'] = 'Invented University'
        record['identitySha256'] = publisher._reader_record_sha256(record['identity'], 'test')
        stage = bad['analysisManifest']['stages']['apiReaderArticle']
        stage['readerAuthorIdentitySha256'] = record['identitySha256']
        stage['readerAuthorsSha256'] = publisher._reader_record_sha256(record, 'test')
        with self.assertRaisesRegex(publisher.PublishDataValidationError, '作者姓名或机构'):
            evaluate([self.paper, bad])
        self.assertTrue(completed)
        self.assertEqual(publisher._READER_AUTHOR_REPLAY_BATCH.get(), None)
        self.assertEqual(evaluate([self.paper]), 'not allowed to escape on failed author replay')

    def test_each_current_physical_source_is_reread_at_flush(self):
        for filename in ['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json']:
            with self.subTest(filename=filename):
                file = self.runtime.parent / filename
                original = file.read_bytes()
                try:
                    with self.assertRaisesRegex(publisher.PublishDataValidationError, '作者姓名或机构'):
                        with publisher._reader_author_replay_batch_scope():
                            self.bundle()
                            file.write_bytes(original + b' ')
                finally:
                    file.write_bytes(original)
        self.bundle()  # neither failures nor success are cached

    def test_parent_identity_mutation_cannot_reuse_preceding_success(self):
        self.bundle()
        bad = copy.deepcopy(self.paper)
        bad['analysisManifest']['freshRewriteProvenance']['sourceManifestSha256'] = 'f'*64
        with self.assertRaises(publisher.PublishDataValidationError):
            with publisher._reader_author_replay_batch_scope():
                self.bundle(bad)
        self.bundle()

    def test_empty_oversized_unknown_shape_and_forged_flags_reject(self):
        self.bundle()
        single = self.author_payloads[0]
        valid = {'contract': 'reader-author-replay-batch-v1', 'items': [single]}
        mutations = [
            {**valid, 'items': []},
            {**valid, 'items': [single]*9},
            {**valid, 'verified': True},
            {**valid, 'items': [{**single, 'verified': True}]},
            {**valid, 'items': [{key: value for key, value in single.items()
                                if key != 'sealedBundleRoot'}]},
            {**valid, 'items': [{'paper': self.paper, 'sourceDetails': {},
                                'sealedBundleRoot': str(self.run/'sources')}]},
            {**valid, 'items': [single, {'verified': True}]},
            {**valid, 'items': [{'verified': True}, single]},
        ]
        for value in mutations:
            with self.subTest(shape=list(value)):
                with self.assertRaises(publisher.PublishDataValidationError):
                    publisher._run_reader_author_source_replay(
                        publisher._daily_fresh_compact_json_bytes(value), ['controlled test'])
        # Actual protocol byte limit, not merely a mocked Python threshold.
        # Whitespace changes only transport size: the parsed item remains valid.
        too_large = publisher._daily_fresh_compact_json_bytes(valid) + b' '*(32*1024*1024)
        with self.assertRaises(publisher.PublishDataValidationError):
            publisher._run_reader_author_source_replay(too_large, ['controlled size test'])

    def test_unexpected_truthy_verifier_result_is_not_batch_permission(self):
        self.bundle()
        payload = publisher._daily_fresh_compact_json_bytes({
            'contract': 'reader-author-replay-batch-v1', 'items': [self.author_payloads[0]]})
        # A controlled parser mock tests the protocol's exact-true boundary;
        # this is a negative unit case, never a qualification fixture.
        code = r"""
const path = require('node:path');
const parser = require('./scripts/lib/reader-author-parser');
parser.readerAuthorIdentityMatchesSource = () => ({ unexpectedTruthy: true });
const fd = process.argv[1], cli = path.resolve('scripts/lib/reader-author-replay-cli.js');
process.argv = [process.execPath, cli, fd];
require(cli);
"""
        with tempfile.TemporaryFile() as file:
            file.write(payload); file.flush(); file.seek(0)
            result = subprocess.run(['node', '-e', code, str(file.fileno())],
                cwd=Path(__file__).resolve().parents[2], capture_output=True, text=True,
                timeout=30, pass_fds=(file.fileno(),),
                env={key: value for key, value in os.environ.items()
                     if key not in {'NODE_OPTIONS', 'NODE_PATH'}})
        self.assertEqual(result.stdout, '{"verified":false}')
        self.assertNotEqual(result.returncode, 0)

    def test_python_byte_bound_flush_and_original_large_single_fallback(self):
        seen = []
        def transport(raw, ids):
            seen.append((raw, list(ids)))
        with mock.patch.object(publisher, '_run_reader_author_source_replay', side_effect=transport), \
                mock.patch.object(publisher, '_READER_AUTHOR_BATCH_MAX_BYTES', 200):
            with publisher._reader_author_replay_batch_scope():
                for index in range(3):
                    self.assertTrue(publisher._defer_sealed_reader_author_replay(
                        json.dumps({'value': 'x'*50}).encode(), str(index)))
                self.assertFalse(publisher._defer_sealed_reader_author_replay(b'x'*201, 'large'))
        for raw, ids in seen:
            self.assertLessEqual(len(raw), 200)
            self.assertEqual(len(json.loads(raw)['items']), len(ids))

    def test_nested_scope_and_exception_never_leak_unverified_work(self):
        before = len(self.author_payloads)
        with self.assertRaisesRegex(RuntimeError, 'body failed'):
            with publisher._reader_author_replay_batch_scope():
                self.bundle()
                raise RuntimeError('body failed')
        self.assertEqual(len(self.author_payloads), before)
        self.assertIsNone(publisher._READER_AUTHOR_REPLAY_BATCH.get())
        with publisher._reader_author_replay_batch_scope():
            with publisher._reader_author_replay_batch_scope():
                self.bundle()
            self.assertEqual(len(self.author_payloads), before)
        self.assertEqual(len(self.author_payloads), before+1)
