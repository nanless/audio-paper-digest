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

# 从仓库根按点分路径单跑（python -m unittest tests.python.<模块>）时，tests/python
# 不在 sys.path 上；补一条引导，让三种运行方式都能导入这个平级 helper。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_env_isolation import project_env_scope


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
SPEC = importlib.util.spec_from_file_location(
    'publish_to_blog_daily_fresh_gate', ROOT / 'scripts' / 'publish-to-blog.py',
)
publish_to_blog = importlib.util.module_from_spec(SPEC)
# publish-to-blog.py 导入时会读 .env 并写 os.environ，用完还给进程。
with project_env_scope():
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


def _daily_payload(root, paper_ids, versioned_source_ids=frozenset(), *, text_prefix='', html_urls=None):
    """按 Node 抓取路径的样式在来源库里造出字节。"""
    date = '2026-09-07'
    run_id = '11111111-1111-4111-8111-111111111111'
    batch_id = 'python-publish-gate'
    root = Path(root)
    run_dir = root / run_id
    papers = []
    for paper_id in sorted(paper_ids):
        source_id = f'{paper_id}v1' if paper_id in versioned_source_ids else paper_id
        source_dir = run_dir / 'sources' / paper_id / 'generation-000001'
        text = (text_prefix + f'Official fresh text for {paper_id}.\n' * 20).encode('utf-8')
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
                'filename': 'source.txt', 'source': 'html', 'sourceId': source_id,
                'url': (html_urls or {}).get(paper_id, f'https://arxiv.org/html/{source_id}'),
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
            'text': text.decode('utf-8'), 'source': 'html', 'sourceId': source_id,
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

    def test_old_unicode_inputs_require_reanalysis_after_real_source_validation(self):
        for field, value in (
                ('title', '数学模型 𝑥 与 𝑦'),
                ('authors', ['𠮷田']),
                ('analysisStageCheckpoints', {'revision': '旧修复草稿 😀'}),
                ('apiReaderPlan', {'oneSentenceThesis': '变量 𝑥'}),
                ('source', 'The paper defines 𝑥 = 𝑦 + 1.')):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                root = Path(directory) / 'sources'
                payload = _daily_payload(root, ['2609.12341'],
                                         text_prefix=value if field == 'source' else '')
                paper = payload['papers'][0]
                if field != 'source':
                    paper[field] = value
                before = copy.deepcopy(paper)
                source_file = root / payload['dailyFreshSourceRun']['runId'] / 'sources' / '2609.12341' / 'generation-000001' / 'source.txt'
                source_bytes = source_file.read_bytes()
                data = self._write_payload(directory, payload)
                with mock.patch.object(publish_to_blog, 'DAILY_FRESH_SOURCE_RUNS_DIR', root):
                    with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, 'Unicode.*重新分析'):
                        publish_to_blog.validate_daily_fresh_sources_for_publish(data, payload['batchDate'])
                    self.assertEqual(paper, before)
                    self.assertEqual(source_file.read_bytes(), source_bytes)
                    paper['analysisManifest']['sourceAcquisition']['modelTextSanitizationContract'] = 'model-text-unicode-scalars-v1'
                    data = self._write_payload(directory, payload)
                    publish_to_blog.validate_daily_fresh_sources_for_publish(data, payload['batchDate'])
                    source_file.write_bytes(source_bytes + b'changed')
                    with self.assertRaises(publish_to_blog.PublishDataValidationError):
                        publish_to_blog.validate_daily_fresh_sources_for_publish(data, payload['batchDate'])

    def test_generate_stops_before_loading_or_rendering_affected_old_api_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'sources'
            payload = _daily_payload(root, ['2609.12341'], text_prefix='Original equation 𝑥 = 𝑦. ')
            data = self._write_payload(directory, payload)
            options = {'data_file': str(data), 'target_date': payload['batchDate'],
                       'category': 'all', 'publish_all': False, 'excluded_ids': []}
            with mock.patch.object(publish_to_blog, 'DAILY_FRESH_SOURCE_RUNS_DIR', root), \
                    mock.patch.object(publish_to_blog, 'validate_publish_target', return_value=(directory, directory)), \
                    mock.patch('log_setup.setup_script_logging'), \
                    mock.patch.object(publish_to_blog, 'load_papers', side_effect=AssertionError('不可进入正文加载')) as load:
                with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, 'Unicode.*重新分析'):
                    publish_to_blog.generate_main(options)
                load.assert_not_called()

    def test_bmp_and_literal_escape_old_inputs_keep_eligibility(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'sources'
            payload = _daily_payload(root, ['2609.12341'])
            payload['papers'][0]['title'] = r'普通中文 x，字面量 \uD835\uDC65'
            data = self._write_payload(directory, payload)
            with mock.patch.object(publish_to_blog, 'DAILY_FRESH_SOURCE_RUNS_DIR', root):
                publish_to_blog.validate_daily_fresh_sources_for_publish(data, payload['batchDate'])
            self.assertFalse(publish_to_blog._contains_supplementary_model_character('\ud800'))
            self.assertFalse(publish_to_blog._contains_supplementary_model_character('\udc00'))

    def test_unbound_api_input_is_rejected_without_reclassifying_manual_or_read_only_records(self):
        with tempfile.TemporaryDirectory() as directory:
            api = {'title': '旧 API 正文', 'apiReaderArticle': '普通中文',
                   'analysisManifest': {'contracts': {'apiReaderArticle': 'beginner-researcher-v3'},
                                        'sourceAcquisition': {'modelTextSanitizationContract': 'model-text-unicode-scalars-v1'}}}
            for payload in ([api], {'papers': [api]}):
                data = self._write_payload(directory, payload)
                with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '缺少可重放的封存来源'):
                    publish_to_blog.validate_daily_fresh_sources_for_publish(data, '2026-09-07')
                self.assertEqual(publish_to_blog.load_papers(data), [api])
            for payload in ([], {'papers': []}, {'papers': [{'title': 'Manual 𝑥', 'analysisMode': 'manual'}]}):
                data = self._write_payload(directory, payload)
                publish_to_blog.validate_daily_fresh_sources_for_publish(data, '2026-09-07')

    def test_canonical_json_bytes_are_frozen(self):
        """固定保存预期 JSON 字节，避免用同一个被测函数生成数据和验证数据。

        上面的 _canonical_bytes 用被测函数生成测试数据，再用同一函数核对，
        因此即使该函数不再排序键，也发现不了；这里把嵌套对象键的固定顺序和两种 JSON 输出
        结果固定成字面量，改动 _daily_fresh_canonical 会立刻失败。
        """
        value = {'b': 1, 'a': [2, {'d': 4, 'c': 3}], 's': '中文'}
        self.assertEqual(list(publish_to_blog._daily_fresh_canonical(value)), ['a', 'b', 's'])
        self.assertEqual(
            publish_to_blog._daily_fresh_canonical_json_bytes(value),
            (
                '{\n'
                '  "a": [\n'
                '    2,\n'
                '    {\n'
                '      "c": 3,\n'
                '      "d": 4\n'
                '    }\n'
                '  ],\n'
                '  "b": 1,\n'
                '  "s": "中文"\n'
                '}\n'
            ).encode('utf-8'),
        )
        self.assertEqual(
            publish_to_blog._daily_fresh_compact_json_bytes(
                {'b': 1, 'a': [2, {'d': 4, 'c': 3}]},
            ),
            b'{"b":1,"a":[2,{"d":4,"c":3}]}',
        )

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

    def test_versioned_official_html_source_id_replays_as_the_canonical_paper(self):
        with tempfile.TemporaryDirectory() as tmp:
            source_root = Path(tmp) / 'daily-fresh-source-runs'
            payload = _daily_payload(
                source_root, ['2609.12349'], versioned_source_ids={'2609.12349'},
            )
            data_file = self._write_payload(tmp, payload)
            with mock.patch.object(
                    publish_to_blog, 'DAILY_FRESH_SOURCE_RUNS_DIR', source_root,
            ):
                publish_to_blog.validate_daily_fresh_sources_for_publish(
                    data_file, '2026-09-07',
                )

    def test_conflicting_explicit_html_version_fails_with_self_consistent_sealed_hashes(self):
        with tempfile.TemporaryDirectory() as tmp:
            source_root = Path(tmp) / 'daily-fresh-source-runs'
            payload = _daily_payload(
                source_root, ['2609.12349'], versioned_source_ids={'2609.12349'},
                html_urls={'2609.12349': 'https://arxiv.org/html/2609.12349v2'},
            )
            data_file = self._write_payload(tmp, payload)
            before = {path: path.read_bytes() for path in source_root.rglob('*') if path.is_file()}
            with mock.patch.object(
                    publish_to_blog, 'DAILY_FRESH_SOURCE_RUNS_DIR', source_root,
            ):
                with self.assertRaisesRegex(
                        publish_to_blog.PublishDataValidationError, '官方 HTTPS 地址'):
                    publish_to_blog.validate_daily_fresh_sources_for_publish(
                        data_file, '2026-09-07',
                    )
            self.assertEqual(
                {path: path.read_bytes() for path in source_root.rglob('*') if path.is_file()},
                before,
            )

    def test_html_version_compatibility_replays_real_sealed_sources(self):
        for versioned, url in (
                (True, 'https://arxiv.org/html/2609.12349v1'),
                (True, 'https://arxiv.org/html/2609.12349/'),
                (False, 'https://arxiv.org/html/2609.12349v2'),
                (False, 'https://arxiv.org/html/2609.12349')):
            with self.subTest(versioned=versioned, url=url), tempfile.TemporaryDirectory() as tmp:
                source_root = Path(tmp) / 'daily-fresh-source-runs'
                payload = _daily_payload(
                    source_root, ['2609.12349'],
                    versioned_source_ids={'2609.12349'} if versioned else frozenset(),
                    html_urls={'2609.12349': url},
                )
                data_file = self._write_payload(tmp, payload)
                with mock.patch.object(
                        publish_to_blog, 'DAILY_FRESH_SOURCE_RUNS_DIR', source_root,
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
