"""Run the actual publisher cache-routing functions; never import a writer."""
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import types
import unittest

ROOT = Path(os.environ.get('TEST_ORDINAL_PROJECT_ROOT', Path(__file__).resolve().parents[2]))
SOURCE = Path(os.environ.get('TEST_ORDINAL_PUBLISHER_SOURCE', ROOT / 'scripts/publish-to-blog.py'))

class PublicationPatchCache(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='reader-patch-cache-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.run_id = 'ab5efe37-e8fd-4561-9c88-bf0564ec94d2'
        self.run = self.root / self.run_id
        self.run.mkdir()
        (self.run / 'run.json').write_text(json.dumps({'contract': 'daily-fresh-source-run-v1'}))
        script = self.root / 'scripts'
        (script / 'lib').mkdir(parents=True)
        for name in ['deep-analyzer.js', 'lib/reader-resource-claims-replay-cli.js', 'lib/reader-resource-binding.js']:
            (script / name).write_text('synthetic source fingerprint fixture')
        self.calls = []
        def fake_replay(*args, **kwargs):
            self.calls.append((args, kwargs))
            return types.SimpleNamespace(stdout='{"verified":true}', returncode=0, timed_out=False, output_truncated=False)
        stable = lambda value: hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
        self.namespace = {'Path': Path, 're': re, 'json': json, 'os': os, 'tempfile': tempfile, 'shutil': shutil,
            'DAILY_FRESH_SOURCE_RUNS_DIR': self.root, 'SHARED_SCRIPTS_DIR': script,
            '_READER_RESOURCE_CLAIM_REPLAY_CACHE': set(), 'PublishDataValidationError': ValueError,
            '_stable_json_sha256': stable, '_javascript_string_sha256': lambda text: hashlib.sha256(text.encode()).hexdigest(),
            '_sha256_file': lambda path: hashlib.sha256(path.read_bytes()).hexdigest(),
            '_daily_fresh_compact_json_bytes': lambda value: json.dumps(value).encode(), '_run_bounded_subprocess': fake_replay}
        tree = ast.parse(SOURCE.read_text())
        names = {'_has_source_bound_reader_patch_completion', '_validate_reader_resource_claim_source_replay'}
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
        self.assertEqual(len(functions), 2)
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(SOURCE), 'exec'), self.namespace)
        self.paper = {'arxivId': '2610.34477v1', 'sourceSha256': hashlib.sha256(b'actual-test-text').hexdigest(),
            'freshRewriteProvenance': {'runId': self.run_id}, 'analysisManifest': {'contracts': {'apiReaderArticle': 'beginner-researcher-v3'}, 'stages': {'apiReaderArticle': {}}},
            'apiReaderPlan': {}, 'apiReaderArticle': 'synthetic cache-routing article', 'apiReaderResources': {'resources': []}}

    def invoke(self):
        self.namespace['_validate_reader_resource_claim_source_replay'](self.paper, {'text': 'actual-test-text'}, '2610.34477')

    def test_legacy_cache_remains(self):
        self.invoke(); self.invoke()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][1]['timeout_seconds'], 30)

    def test_marked_protocol_never_reuses_qualification_cache(self):
        self.paper['analysisManifest']['contracts']['readerTargetOrdinalPatch'] = 'reader-target-ordinal-patch-v1'
        self.invoke(); self.invoke()
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[0][1]['timeout_seconds'], 180)

    def test_stripped_markers_and_mutated_original_file_still_bypass_cache(self):
        index = self.run / 'reader-attempts/ordinal-completions'
        index.mkdir(parents=True)
        record = index / '2610.34477-00000001.json'
        record.write_text('{}')
        self.invoke(); record.write_text('{"tampered":true}'); self.invoke()
        self.assertEqual(len(self.calls), 2)
        metadata = self.run / 'reader-attempts/version-metadata-completion-index'
        metadata.mkdir()
        record.unlink(); (metadata / '2610.34477.json').write_text('{}')
        self.invoke(); self.invoke()
        self.assertEqual(len(self.calls), 4)

    def test_corrupt_regular_file_index_cannot_hide_behind_cached_qualification(self):
        index = self.run / 'reader-attempts/ordinal-completions'
        index.parent.mkdir(parents=True)
        index.write_text('damaged index is a file')
        self.invoke(); self.invoke()
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[0][1]['timeout_seconds'], 180)

    def test_corrupt_metadata_index_directory_cannot_hide_after_marker_stripping(self):
        index = self.run / 'reader-attempts/version-metadata-completion-index'
        index.parent.mkdir(parents=True)
        self.paper['analysisManifest']['contracts']['readerVersionMetadataRecovery'] = 'version-metadata-proof'
        self.invoke()
        del self.paper['analysisManifest']['contracts']['readerVersionMetadataRecovery']
        index.write_text('damaged metadata index directory is a file')
        self.invoke(); self.invoke()
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(self.calls[-1][1]['timeout_seconds'], 180)

    def test_actual_daily_missing_id_and_non_daily_scope(self):
        del self.paper['arxivId']
        self.assertTrue(self.namespace['_has_source_bound_reader_patch_completion'](self.paper))
        self.paper['freshRewriteProvenance']['runId'] = 'b' * 8 + '-bbbb-4bbb-8bbb-' + 'b' * 12
        self.assertFalse(self.namespace['_has_source_bound_reader_patch_completion'](self.paper))
        self.paper['analysisManifest']['contracts']['readerVersionMetadataRecovery'] = 'version-metadata-proof'
        self.assertTrue(self.namespace['_has_source_bound_reader_patch_completion'](self.paper))

if __name__ == '__main__':
    unittest.main()
