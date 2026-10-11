import copy
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_daily_fresh_publish_gate import (
    _canonical_bytes,
    _compact_sha,
    _daily_payload,
    _write_private,
    publish_to_blog as publisher,
)


class SealedAuthorPublicationParentTest(unittest.TestCase):
    def create_sample(self, temporary_root):
        temporary_root = Path(temporary_root).resolve()
        payload = _daily_payload(temporary_root / 'runs', ['2610.12345'])
        paper = payload['papers'][0]
        run_dir = Path(temporary_root) / 'runs' / payload['dailyFreshSourceRun']['runId']
        source_dir = run_dir / 'sources/2610.12345/generation-000001'
        runtime_path = source_dir / 'source-runtime.json'
        runtime = json.loads(runtime_path.read_text())
        runtime['readerAuthors'] = {
            'authors': [{'name': 'Alice Brown', 'affiliations': ['University A']}],
            'sourceDomSha256': hashlib.sha256(b'Original author DOM').hexdigest(),
        }
        runtime_bytes = _canonical_bytes(runtime)
        _write_private(runtime_path, runtime_bytes)
        runtime = json.loads(runtime_bytes)
        manifest_path = source_dir / 'source-manifest.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['runtimeMetadata']['responseBytes'] = len(runtime_bytes)
        manifest['runtimeMetadata']['responseSha256'] = hashlib.sha256(runtime_bytes).hexdigest()
        manifest_bytes = _canonical_bytes(manifest)
        _write_private(manifest_path, manifest_bytes)
        details = {
            'text': (source_dir / 'source.txt').read_text(),
            'source': manifest['text']['source'],
            'sourceId': manifest['text']['sourceId'],
            'imageInfos': runtime['imageInfos'],
            'structuredArtifacts': runtime['structuredArtifacts'],
            'readerAuthors': runtime['readerAuthors'],
            'htmlAvailability': runtime['htmlAvailability'],
            'htmlAttempts': runtime['htmlAttempts'],
            'warnings': runtime['warnings'],
        }
        proof = paper['freshRewriteProvenance']
        proof['sourceManifestSha256'] = hashlib.sha256(manifest_bytes).hexdigest()
        proof['sourceSnapshotSha256'] = _compact_sha({
            'sourceManifestSha256': proof['sourceManifestSha256'],
            'sourceGeneration': 1,
            'details': details,
        })
        paper['analysisManifest']['freshRewriteProvenance'] = copy.deepcopy(proof)
        paper['authors'] = ['Alice Brown']
        paper['analysisManifest']['contracts'] = {'apiReaderArticle': 'beginner-researcher-v3'}
        paper['analysisManifest']['sourceAcquisition']['modelTextSanitizationContract'] = 'model-text-unicode-scalars-v1'
        stage = {
            'status': 'complete',
            'structuredArtifactsSha256': runtime['structuredArtifacts']['payloadSha256'],
        }
        paper['analysisManifest']['stages'] = {'apiReaderArticle': stage}
        node_code = r'''
const input = JSON.parse(process.argv[1]);
const fresh = require('./scripts/lib/fresh-analysis-context.js');
const parser = require('./scripts/lib/reader-author-parser.js');
fresh.withVerifiedBundleReaderAuthorFiles(input.source, details => {
    process.stdout.write(JSON.stringify(parser.resolveVerifiedReaderAuthors(input.paper, details)));
});
'''
        source = {
            'rootDir': str(run_dir / 'sources'),
            'arxivId': '2610.12345',
            'generation': 1,
            'sourceManifestSha256': proof['sourceManifestSha256'],
            'sourceSnapshotSha256': proof['sourceSnapshotSha256'],
        }
        result = subprocess.run(
            ['node', '-e', node_code, json.dumps({'paper': paper, 'source': source})],
            cwd=ROOT, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        paper['apiReaderAuthors'] = json.loads(result.stdout)
        stage['readerAuthorIdentitySha256'] = paper['apiReaderAuthors']['identitySha256']
        stage['readerAuthorsSha256'] = publisher._reader_record_sha256(paper['apiReaderAuthors'], 'test')
        self.assertEqual(paper['apiReaderAuthors']['authors'][0]['affiliations'], ['University A'])
        self.assertNotIn('sourceHtml', runtime['readerAuthors'])
        return run_dir, paper, runtime_path

    def test_parent_publication_accepts_actual_sealed_authors_without_html_string(self):
        with tempfile.TemporaryDirectory() as temporary_root:
            run_dir, paper, runtime_path = self.create_sample(temporary_root)
            before = runtime_path.read_bytes()
            publisher._daily_fresh_validate_bundle(
                run_dir, '2610.12345', paper['freshRewriteProvenance'], paper,
            )
            self.assertEqual(runtime_path.read_bytes(), before)

    def test_parent_publication_rejects_self_signed_wrong_institution(self):
        with tempfile.TemporaryDirectory() as temporary_root:
            run_dir, paper, runtime_path = self.create_sample(temporary_root)
            before = runtime_path.read_bytes()
            record = paper['apiReaderAuthors']
            record['authors'][0]['affiliations'] = ['Invented University']
            bound = record['identity']['authors'][0]
            bound['affiliations'] = ['Invented University']
            bound['affiliationBindings'][0]['sourceValue'] = 'Invented University'
            record['identitySha256'] = publisher._reader_record_sha256(record['identity'], 'test')
            stage = paper['analysisManifest']['stages']['apiReaderArticle']
            stage['readerAuthorIdentitySha256'] = record['identitySha256']
            stage['readerAuthorsSha256'] = publisher._reader_record_sha256(record, 'test')
            with self.assertRaisesRegex(publisher.PublishDataValidationError, '作者姓名或机构'):
                publisher._daily_fresh_validate_bundle(
                    run_dir, '2610.12345', paper['freshRewriteProvenance'], paper,
                )
            self.assertEqual(runtime_path.read_bytes(), before)

    def test_parent_publication_rejects_changed_physical_source(self):
        with tempfile.TemporaryDirectory() as temporary_root:
            run_dir, paper, runtime_path = self.create_sample(temporary_root)
            runtime_path.write_bytes(runtime_path.read_bytes() + b' ')
            damaged = runtime_path.read_bytes()
            with self.assertRaises(publisher.PublishDataValidationError):
                publisher._daily_fresh_validate_bundle(
                    run_dir, '2610.12345', paper['freshRewriteProvenance'], paper,
                )
            self.assertEqual(runtime_path.read_bytes(), damaged)


if __name__ == '__main__':
    unittest.main()
