import copy
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
SPEC = importlib.util.spec_from_file_location(
    'publish_daily_historical_version_test', ROOT / 'scripts' / 'publish-to-blog.py',
)
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)

NODE_SOURCE_FIXTURE = r'''
const crypto = require('node:crypto');
const path = require('node:path');
const daily = require('./scripts/lib/daily-fresh-source-plan.js');
const source = require('./scripts/lib/fresh-arxiv-rewrite-source.js');
const direct = require('./scripts/lib/direct-rewrite-analysis-context.js');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
(async () => {
    const rootDir = process.argv[1];
    require('./scripts/config.js').FILES.dailyFreshSourceRunsDir = rootDir;
    const historical = process.argv[2] === 'historical';
    const id = '2609.12409'; const selected = `${id}v2`;
    const plan = daily.createDailyFreshSourcePlan({ rootDir, batchDate: '2026-09-07',
        batchId: 'python-node-version-test', papers: [{ arxivId: id }] });
    await daily.captureDailyFreshSources(plan, {
        concurrency: 1,
        capture: options => source.captureFreshArxivRewriteSource(options, {
            fetchText: async () => ({ text: '', source: 'unavailable', sourceId: selected,
                title: 'Official paper title', htmlAvailability: 'unavailable',
                htmlAttempts: 1, warnings: [] }),
            fetchPdf: async () => ({ bytes: Buffer.from('%PDF-1.7\nFixture paper\n%%EOF\n'),
                sourceId: historical ? selected : id,
                url: `https://arxiv.org/pdf/${historical ? selected : id}`,
                ...(historical ? { currentPdfUnavailable: true, currentPdfStatus: 404 } : {}) }),
            extractPdfText: async () => ({ title: 'Official paper title',
                text: 'Paper methods, experiments, results, and limitations. '.repeat(120) })
        })
    });
    const analyze = daily.createDailyAnalyzeFn(plan, {
        analyze: async paper => {
            const details = direct.getDirectRewriteSource(paper);
            const manifest = { sourceAcquisition: { sourceSha256: sha(details.text) } };
            direct.attachDirectSourceProvenance(paper, manifest, details);
            return { ...paper, sourceSha256: sha(details.text), analysisManifest: manifest };
        }
    });
    const paper = await daily.withDailyFreshAnalysisContext(plan, () => analyze({ arxivId: id }));
    process.stdout.write(JSON.stringify({ batchDate: plan.batchDate,
        dailyFreshSourceRun: daily.dailyFreshSourceReference(plan), papers: [paper] }));
})().catch(error => { process.stderr.write(String(error.stack)); process.exitCode = 1; });
'''


def _node_payload(root, historical=True):
    result = subprocess.run(
        ['node', '-e', NODE_SOURCE_FIXTURE, str(root),
         'historical' if historical else 'current'],
        cwd=ROOT, capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _reseal_bundle(root, payload, change):
    """Recompute outer hashes so negative cases exercise identity checks."""
    paper = payload['papers'][0]
    directory = root / payload['dailyFreshSourceRun']['runId'] / 'sources' \
        / paper['arxivId'] / 'generation-000001'
    manifest_path = directory / 'source-manifest.json'
    runtime_path = directory / 'source-runtime.json'
    manifest = json.loads(manifest_path.read_text())
    runtime = json.loads(runtime_path.read_text())
    change(runtime, manifest, paper)
    runtime_raw = publisher._daily_fresh_canonical_json_bytes(runtime)
    runtime_path.write_bytes(runtime_raw)
    manifest['runtimeMetadata'].update(responseSha256=_sha(runtime_raw), responseBytes=len(runtime_raw))
    manifest_raw = publisher._daily_fresh_canonical_json_bytes(manifest)
    manifest_path.write_bytes(manifest_raw)
    text = (directory / 'source.txt').read_text()
    details = {
        'text': text, 'source': manifest['text']['source'], 'sourceId': manifest['text']['sourceId'],
        'imageInfos': runtime['imageInfos'], 'structuredArtifacts': runtime['structuredArtifacts'],
        'readerAuthors': {'authors': []} if runtime['readerAuthors'] is None else runtime['readerAuthors'],
        'htmlAvailability': runtime['htmlAvailability'], 'htmlAttempts': runtime['htmlAttempts'],
        'warnings': runtime['warnings'],
    }
    proof = paper['freshRewriteProvenance']
    proof['sourceManifestSha256'] = _sha(manifest_raw)
    proof['sourceSnapshotSha256'] = _sha(publisher._daily_fresh_compact_json_bytes({
        'sourceManifestSha256': _sha(manifest_raw), 'sourceGeneration': 1, 'details': details,
    }))
    paper['analysisManifest']['freshRewriteProvenance'] = copy.deepcopy(proof)


class DailyHistoricalVersionPublishTest(unittest.TestCase):
    def _validate(self, root, payload):
        filename = root.parent / 'result.json'
        filename.write_text(json.dumps(payload, ensure_ascii=False))
        with mock.patch.object(publisher, 'DAILY_FRESH_SOURCE_RUNS_DIR', root):
            publisher.validate_daily_fresh_sources_for_publish(filename, '2026-09-07')

    def test_python_accepts_actual_node_current_and_historical_source_bundles(self):
        for historical in (False, True):
            with self.subTest(historical=historical), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve() / 'sources'
                payload = _node_payload(root, historical)
                self._validate(root, payload)
                if historical:
                    identity = payload['papers'][0]['sourceVersion']
                    self.assertEqual(identity['selectedSourceId'], '2609.12409v2')
                    self.assertEqual(payload['papers'][0]['freshRewriteProvenance'][
                        'sourceVersionIdentitySha256'], identity['identitySha256'])
                else:
                    self.assertNotIn('sourceVersion', payload['papers'][0])
                    self.assertNotIn('sourceVersionIdentitySha256', payload['papers'][0]['freshRewriteProvenance'])

    def test_rejects_invalid_historical_identity_after_outer_hashes_are_resealed(self):
        mutations = {
            'unknown field': lambda r, m, p: r['sourceVersion'].update(extra=True),
            'boolean version': lambda r, m, p: r['sourceVersion'].update(version=True),
            'missing 404': lambda r, m, p: r['sourceVersion'].update(attemptedCurrentPdfStatus=503),
            'current available': lambda r, m, p: r['sourceVersion'].update(currentPdfAvailable=True),
            'wrong warning': lambda r, m, p: r['sourceVersion'].update(warning='当前版本仍然可用'),
            'missing warning': lambda r, m, p: r.update(warnings=[]),
            'wrong identity hash': lambda r, m, p: r['sourceVersion'].update(identitySha256='a' * 64),
            'other paper': lambda r, m, p: r['sourceVersion'].update(selectedSourceId='2609.12408v2'),
            'text version': lambda r, m, p: m['text'].update(sourceId='2609.12409v1'),
            'HTML with historical PDF': lambda r, m, p: m['text'].update(source='html', url='https://arxiv.org/html/2609.12409v2'),
            'PDF version': lambda r, m, p: m['pdf'].update(url='https://arxiv.org/pdf/2609.12409v1'),
            'nonofficial URL': lambda r, m, p: m['pdf'].update(url='https://example.org/pdf/2609.12409v2'),
            'query URL': lambda r, m, p: m['pdf'].update(url='https://arxiv.org/pdf/2609.12409v2?download=1'),
            'fragment URL': lambda r, m, p: m['pdf'].update(url='https://arxiv.org/pdf/2609.12409v2#page=1'),
            'credentials URL': lambda r, m, p: m['pdf'].update(url='https://user@arxiv.org/pdf/2609.12409v2'),
            'PDF path parameters': lambda r, m, p: m['pdf'].update(url='https://arxiv.org/pdf/2609.12409v2;other'),
            'empty PDF path parameters': lambda r, m, p: m['pdf'].update(url='https://arxiv.org/pdf/2609.12409v2;'),
            'text path parameters': lambda r, m, p: m['text'].update(url='https://arxiv.org/pdf/2609.12409v2;other'),
            'identity path parameters': lambda r, m, p: r['sourceVersion'].update(selectedPdfUrl='https://arxiv.org/pdf/2609.12409v2;other'),
            'current identity path parameters': lambda r, m, p: r['sourceVersion'].update(attemptedCurrentPdfUrl='https://arxiv.org/pdf/2609.12409;other'),
            'missing paper identity': lambda r, m, p: p.pop('sourceVersion'),
            'changed paper identity': lambda r, m, p: p['sourceVersion'].update(warning='changed'),
            'old proof without identity': lambda r, m, p: p['freshRewriteProvenance'].pop('sourceVersionIdentitySha256'),
        }
        for label, change in mutations.items():
            with self.subTest(case=label), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve() / 'sources'
                payload = _node_payload(root)
                _reseal_bundle(root, payload, change)
                with self.assertRaises(publisher.PublishDataValidationError):
                    self._validate(root, payload)

    def test_current_pdf_rejects_historical_claim_and_nonofficial_url(self):
        for label in ('runtime identity', 'paper identity', 'proof identity', 'wrong URL'):
            with self.subTest(case=label), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve() / 'current'
                payload = _node_payload(root, False)
                historical = _node_payload(Path(temporary).resolve() / 'historical')['papers'][0]['sourceVersion']

                def change(runtime, manifest, paper):
                    if label == 'runtime identity':
                        runtime['sourceVersion'] = historical
                        runtime['warnings'] = [historical['warning']]
                    elif label == 'paper identity':
                        paper['sourceVersion'] = historical
                    elif label == 'proof identity':
                        paper['freshRewriteProvenance']['sourceVersionIdentitySha256'] = historical['identitySha256']
                    else:
                        manifest['text']['url'] = 'https://example.org/pdf/2609.12409'

                _reseal_bundle(root, payload, change)
                with self.assertRaises(publisher.PublishDataValidationError):
                    self._validate(root, payload)

    def test_all_workbench_formats_reference_the_sealed_selected_version(self):
        with tempfile.TemporaryDirectory() as temporary:
            paper = _node_payload(Path(temporary).resolve() / 'sources')['papers'][0]
            paper.update(title='Official paper title', abstract='A source abstract.', authors=['Alice'],
                         parsed={'score': 8, 'primaryTaskTag': '#语音识别', 'rankBucket': '前25%',
                                 'documentType': '方法研究'})
            plan = {'readerTitle': '论文导读', 'oneSentenceThesis': '这篇论文介绍语音识别方法。'}
            bundle = publisher.build_researcher_workbench_bundle(paper, '2026-09-07', reader_plan=plan)
            self.assertEqual(bundle['identity']['versionedId'], '2609.12409v2')
            frontmatter = publisher._researcher_workbench_frontmatter(bundle)
            self.assertIn('2609.12409v2', frontmatter)
            self.assertIn('paper_digest_arxiv_version: 2', frontmatter)
            for path, raw in bundle['sidecars'].items():
                with self.subTest(format=path.name):
                    self.assertIn(b'https://arxiv.org/abs/2609.12409v2', raw)
                    self.assertIn(b'2609.12409v2', raw)
                    self.assertNotIn(b'https://arxiv.org/abs/2609.12409"', raw)
                    if path.suffix == '.json':
                        record = json.loads(raw)
                        self.assertEqual(record['arxivVersion'], 2)
                        self.assertEqual(record['arxivId'], '2609.12409')
            tampered = copy.deepcopy(paper)
            tampered['freshRewriteProvenance']['sourceVersionIdentitySha256'] = 'a' * 64
            tampered['analysisManifest']['freshRewriteProvenance'] = copy.deepcopy(tampered['freshRewriteProvenance'])
            with self.assertRaises(publisher.PublishDataValidationError):
                publisher.build_researcher_workbench_bundle(tampered, '2026-09-07', reader_plan=plan)


if __name__ == '__main__':
    unittest.main()
