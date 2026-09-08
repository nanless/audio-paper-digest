import copy
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
SPEC = importlib.util.spec_from_file_location(
    'publish_to_blog_daily_fresh_gate', ROOT / 'scripts' / 'publish-to-blog.py',
)
publish_to_blog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publish_to_blog)


def _write_private(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    path.chmod(0o600)


def _canonical_bytes(value):
    return publish_to_blog._daily_fresh_canonical_json_bytes(value)


def _compact_sha(value):
    return hashlib.sha256(
        publish_to_blog._daily_fresh_compact_json_bytes(value)
    ).hexdigest()


def _source_artifacts(text_sha):
    body = publish_to_blog._daily_fresh_canonical({
        'figures': [], 'flattenedTextSha256': text_sha, 'formulas': [],
        'source': 'html', 'tables': [], 'version': 1,
    })
    return publish_to_blog._daily_fresh_canonical({
        **body,
        'payloadSha256': _compact_sha(body),
    })


def _daily_payload(root, paper_ids):
    """Create source-store bytes in the same shape as the Node capture path."""
    date = '2026-09-07'
    run_id = '11111111-1111-4111-8111-111111111111'
    batch_id = 'python-publish-gate'
    root = Path(root)
    run_dir = root / run_id
    papers = []
    for paper_id in sorted(paper_ids):
        source_dir = run_dir / 'sources' / paper_id / 'generation-000001'
        text = (f'Official fresh text for {paper_id}.\n' * 20).encode('utf-8')
        pdf = f'%PDF-1.4\n{paper_id}\n%%EOF\n'.encode('ascii')
        text_sha = hashlib.sha256(text).hexdigest()
        pdf_sha = hashlib.sha256(pdf).hexdigest()
        artifacts = _source_artifacts(text_sha)
        runtime = {
            'contract': 'fresh-arxiv-rewrite-runtime-metadata-v1', 'version': 1,
            'paperId': f'arxiv:{paper_id}', 'title': f'Fresh {paper_id}',
            'textSha256': text_sha, 'structuredArtifacts': artifacts,
            'imageInfos': [], 'readerAuthors': None,
            'htmlAvailability': 'available', 'htmlAttempts': 1, 'warnings': [],
        }
        runtime_bytes = _canonical_bytes(runtime)
        manifest = {
            'contract': 'fresh-arxiv-rewrite-source-v1', 'version': 2,
            'arxivId': paper_id, 'paperId': f'arxiv:{paper_id}', 'generation': 1,
            'capturedAt': '2026-09-07T00:00:00.000Z',
            'text': {
                'filename': 'source.txt', 'source': 'html', 'sourceId': paper_id,
                'url': f'https://arxiv.org/html/{paper_id}',
                'fetchedAt': '2026-09-07T00:00:00.000Z',
                'extractor': {
                    'contract': 'deep-analyzer-official-arxiv-fulltext-v1',
                    'version': 'arxiv-html-or-pdf-text-v1',
                },
                'responseSha256': text_sha, 'responseBytes': len(text),
            },
            'runtimeMetadata': {
                'filename': 'source-runtime.json',
                'responseSha256': hashlib.sha256(runtime_bytes).hexdigest(),
                'responseBytes': len(runtime_bytes),
            },
            'pdf': {
                'filename': 'source.pdf',
                'url': f'https://arxiv.org/pdf/{paper_id}.pdf',
                'fetchedAt': '2026-09-07T00:00:01.000Z',
                'responseSha256': pdf_sha, 'responseBytes': len(pdf),
            },
        }
        manifest_bytes = _canonical_bytes(manifest)
        _write_private(source_dir / 'source.txt', text)
        _write_private(source_dir / 'source.pdf', pdf)
        _write_private(source_dir / 'source-runtime.json', runtime_bytes)
        _write_private(source_dir / 'source-manifest.json', manifest_bytes)
        details = {
            'text': text.decode('utf-8'), 'source': 'html', 'sourceId': paper_id,
            'imageInfos': [], 'structuredArtifacts': artifacts,
            'readerAuthors': {'authors': []}, 'htmlAvailability': 'available',
            'htmlAttempts': 1, 'warnings': [],
        }
        proof = {
            'contract': 'fresh-source-analysis-v1', 'runId': run_id,
            'sourceGeneration': 1,
            'sourceManifestSha256': hashlib.sha256(manifest_bytes).hexdigest(),
            'sourceSha256': text_sha,
            'sourceSnapshotSha256': _compact_sha({
                'sourceManifestSha256': hashlib.sha256(manifest_bytes).hexdigest(),
                'sourceGeneration': 1, 'details': details,
            }),
            'sourceOnly': True, 'oldGeneratedTextIncluded': False,
        }
        papers.append({
            'arxivId': paper_id, 'freshRewriteProvenance': proof,
            'sourceSha256': text_sha,
            'analysisManifest': {
                'freshRewriteProvenance': copy.deepcopy(proof),
                'sourceAcquisition': {'sourceSha256': text_sha},
            },
        })
    paper_ids = sorted(paper_ids)
    source_set_sha = _compact_sha(publish_to_blog._daily_fresh_canonical({
        'batchDate': date, 'batchId': batch_id, 'paperIds': paper_ids,
        'sourceGeneration': 1,
    }))
    run = {
        'contract': 'daily-fresh-source-run-v1', 'version': 1,
        'runId': run_id, 'batchDate': date, 'batchId': batch_id,
        'paperIds': paper_ids, 'sourceSetSha256': source_set_sha,
        'sourceExpectations': {
            paper_id: {
                'sourceMode': 'sealed-arxiv-bundle-v1', 'sourceGeneration': 1,
            }
            for paper_id in paper_ids
        },
    }
    run_bytes = _canonical_bytes(run)
    _write_private(run_dir / 'run.json', run_bytes)
    return {
        'batchDate': date,
        'dailyFreshSourceRun': {
            'contract': 'daily-fresh-source-reference-v1', 'version': 1,
            'runId': run_id, 'batchDate': date, 'batchId': batch_id,
            'sourceGeneration': 1, 'sourceSetSha256': source_set_sha,
            'runManifestSha256': hashlib.sha256(run_bytes).hexdigest(),
        },
        'papers': papers,
    }


class DailyFreshPublishGateTest(unittest.TestCase):
    def _write_payload(self, root, payload):
        data_file = Path(root) / 'deep-analysis-result.json'
        data_file.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
        return data_file

    def test_runtime_accepts_manifest_authenticated_legacy_artifact_signature(self):
        text = b'legacy sealed full text'
        text_sha = hashlib.sha256(text).hexdigest()
        artifacts = {
            'version': 1, 'parserVersion': 'arxiv-html-dom-v4',
            'sourceKind': 'arxiv_html', 'tables': [], 'formulas': [],
            'figures': [], 'flattenedTextSha256': text_sha,
            'payloadSha256': 'a' * 64,
        }
        runtime = {
            'contract': 'fresh-arxiv-rewrite-runtime-metadata-v1', 'version': 1,
            'paperId': 'arxiv:2609.12340', 'title': 'Legacy artifact',
            'textSha256': text_sha, 'structuredArtifacts': artifacts,
            'imageInfos': [], 'readerAuthors': None,
            'htmlAvailability': 'available', 'htmlAttempts': 1, 'warnings': [],
        }
        manifest = {'text': {'responseSha256': text_sha}}
        self.assertIs(
            publish_to_blog._daily_fresh_validate_runtime(
                runtime, manifest, text, '2609.12340',
            ),
            artifacts,
        )
        incompatible = copy.deepcopy(runtime)
        incompatible['structuredArtifacts'].pop('parserVersion')
        with self.assertRaisesRegex(
                publish_to_blog.PublishDataValidationError,
                'structuredArtifacts 未绑定 sealed TXT'):
            publish_to_blog._daily_fresh_validate_runtime(
                incompatible, manifest, text, '2609.12340',
            )

    def test_all_fresh_daily_batch_replays_and_mixed_batch_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            source_root = Path(tmp) / 'daily-fresh-source-runs'
            payload = _daily_payload(source_root, ['2609.12341', '2609.12342'])
            data_file = self._write_payload(tmp, payload)
            with mock.patch.object(
                    publish_to_blog, 'DAILY_FRESH_SOURCE_RUNS_DIR', source_root,
            ):
                publish_to_blog.validate_daily_fresh_sources_for_publish(
                    data_file, '2026-09-07',
                )
                mixed = copy.deepcopy(payload)
                mixed['papers'][1].pop('freshRewriteProvenance')
                mixed['papers'][1]['analysisManifest'].pop('freshRewriteProvenance')
                self._write_payload(tmp, mixed)
                with self.assertRaisesRegex(
                        publish_to_blog.PublishDataValidationError,
                        '缺少精确 daily sealed fresh provenance',
                ):
                    publish_to_blog.validate_daily_fresh_sources_for_publish(
                        data_file, '2026-09-07',
                    )

    def test_schema_v3_all_fresh_generation_replays_input_source_reference(self):
        with tempfile.TemporaryDirectory() as tmp:
            source_root = Path(tmp) / 'daily-fresh-source-runs'
            payload = _daily_payload(source_root, ['2609.12346', '2609.12347'])
            data_file = self._write_payload(tmp, payload)
            reference = publish_to_blog.build_generation_input_source_reference(data_file)
            papers = payload['papers']
            manifest = {
                'category': '论文速递',
                'publishAll': False,
                'publishedPapers': papers,
                'publishedPapersFingerprintContract': (
                    publish_to_blog.PUBLISHED_PAPERS_FINGERPRINT_CONTRACT
                ),
                'publishedPapersFingerprint': publish_to_blog.published_papers_fingerprint(papers),
                'manualV6Bindings': [],
                'manualV6BindingsFingerprint': publish_to_blog._stable_json_sha256([]),
                'llmApiBindings': [],
                'llmApiBindingsFingerprint': publish_to_blog._stable_json_sha256([]),
                'publicationMode': publish_to_blog.LEGACY_V5_MAINTENANCE_MODE,
                'inputSourceReference': reference,
            }
            manifest['inputFingerprint'] = publish_to_blog.generation_input_fingerprint(
                papers, '2026-09-07', '论文速递', False,
                input_source_reference=reference,
            )
            with mock.patch.object(
                    publish_to_blog, 'DAILY_FRESH_SOURCE_RUNS_DIR', source_root,
            ):
                publish_to_blog._validate_generation_input_integrity(
                    manifest, '2026-09-07',
                )

    def test_runtime_missing_or_drifted_fails_before_publication(self):
        with tempfile.TemporaryDirectory() as tmp:
            source_root = Path(tmp) / 'daily-fresh-source-runs'
            payload = _daily_payload(source_root, ['2609.12343'])
            data_file = self._write_payload(tmp, payload)
            runtime = source_root / '11111111-1111-4111-8111-111111111111' / 'sources' \
                / '2609.12343' / 'generation-000001' / 'source-runtime.json'
            with mock.patch.object(
                    publish_to_blog, 'DAILY_FRESH_SOURCE_RUNS_DIR', source_root,
            ):
                runtime.unlink()
                with self.assertRaisesRegex(
                        publish_to_blog.PublishDataValidationError, 'source generation|source-runtime.json',
                ):
                    publish_to_blog.validate_daily_fresh_sources_for_publish(
                        data_file, '2026-09-07',
                    )
                _write_private(runtime, b'{}\n')
                with self.assertRaisesRegex(
                        publish_to_blog.PublishDataValidationError, 'source manifest|source-runtime.json',
                ):
                    publish_to_blog.validate_daily_fresh_sources_for_publish(
                        data_file, '2026-09-07',
                    )


if __name__ == '__main__':
    unittest.main()
