"""Same-invocation reuse must not remove the next independent cold boundary."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_publish_to_blog import (
    publish_to_blog as publish, llm_api_publication_fixture,
)
from publish_common import PublishDataValidationError


def manifest_for(paper, reference=None):
    papers = [paper]
    bindings = publish.llm_api_publication_bindings(papers)
    proof = publish.llm_api_production_proof(papers)
    result = {
        'schemaVersion': 3, 'category': '论文速递', 'publishAll': False,
        'publishedPapers': papers,
        'publishedPapersFingerprintContract': publish.PUBLISHED_PAPERS_FINGERPRINT_CONTRACT,
        'publishedPapersFingerprint': publish.published_papers_fingerprint(papers),
        'publicationMode': publish.LLM_API_PRODUCTION_MODE,
        'manualV6Bindings': [], 'manualV6BindingsFingerprint': publish._stable_json_sha256([]),
        'llmApiBindings': bindings, 'llmApiBindingsFingerprint': publish._stable_json_sha256(bindings),
        'llmApiProduction': proof, 'llmApiProductionFingerprint': publish._stable_json_sha256(proof),
    }
    if reference is not None:
        result['inputSourceReference'] = reference
    rebind_input(result)
    return result


def rebind_input(manifest):
    manifest['inputFingerprint'] = publish.generation_input_fingerprint(
        manifest['publishedPapers'], '2026-08-31', '论文速递', False,
        input_source_reference=manifest.get('inputSourceReference'),
        _include_pdf_page_derivations=False,
    )
    manifest['publishedPapersFingerprint'] = publish.published_papers_fingerprint(
        manifest['publishedPapers'])


class PublicationBindingReuseTests(unittest.TestCase):
    def test_public_proof_stays_cold_and_matches_the_local_assembly(self):
        paper = llm_api_publication_fixture()
        with mock.patch.object(publish, 'llm_api_publication_bindings',
                               wraps=publish.llm_api_publication_bindings) as check:
            first = publish.llm_api_production_proof([paper])
            second = publish.llm_api_production_proof([paper])
            self.assertEqual(check.call_count, 2)
        self.assertEqual(first, second)
        paper['analysisManifest']['stages']['scoringAudit']['outputAnalysisSha256'] = '0' * 64
        with self.assertRaises(PublishDataValidationError):
            publish.llm_api_production_proof([paper])

    def test_each_integrity_boundary_recomputes_exactly_once(self):
        manifest = manifest_for(llm_api_publication_fixture())
        with mock.patch.object(publish, 'llm_api_publication_bindings',
                               wraps=publish.llm_api_publication_bindings) as check:
            first = publish._validate_generation_input_integrity(manifest, '2026-08-31')
            second = publish._validate_generation_input_integrity(manifest, '2026-08-31')
            self.assertEqual(check.call_count, 2)
        self.assertEqual(first, second)

    def test_save_reuses_only_local_evidence_and_rechecks_before_write(self):
        for mode in (None, publish.LLM_API_PRODUCTION_MODE):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                page = root / 'content/posts/2026-08-31-test.md'
                page.parent.mkdir(parents=True)
                page.write_text('test\n')
                paper = llm_api_publication_fixture()
                fingerprint = publish.generation_input_fingerprint(
                    [paper], '2026-08-31', '论文速递', False)
                with mock.patch.object(publish, 'BLOG_REPO', str(root)), \
                        mock.patch.object(publish, 'generation_manifest_path', return_value=root/'generation.json'), \
                        mock.patch.object(publish, 'review_receipt_path', return_value=root/'receipt.json'), \
                        mock.patch.object(publish, 'review_failure_path', return_value=root/'failure.json'), \
                        mock.patch.object(publish, 'save_review_pass_cache'), \
                        mock.patch.object(publish, 'llm_api_publication_bindings',
                                          wraps=publish.llm_api_publication_bindings) as check:
                    path = publish.save_generation_manifest(
                        '2026-08-31', [page], input_fingerprint=fingerprint,
                        template_fingerprint='1'*64, base_head='2'*40,
                        published_papers=[paper], publication_mode=mode)
                    self.assertEqual(check.call_count, 2)  # local + independent integrity
                    written = json.loads(path.read_text())
                    self.assertEqual(written['llmApiProduction'],
                                     publish.llm_api_production_proof([paper]))

    def test_changed_input_bytes_and_bad_sha_are_not_reused(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / 'input.json'
            source.write_text('{"papers": []}\n')
            reference = publish.build_generation_input_source_reference(source)
            manifest = manifest_for(llm_api_publication_fixture(), reference)
            publish._validate_generation_input_integrity(manifest, '2026-08-31')
            source.write_text('{"papers": []} \n')
            with self.assertRaisesRegex(PublishDataValidationError, '漂移'):
                publish._validate_generation_input_integrity(manifest, '2026-08-31')
        manifest = manifest_for(llm_api_publication_fixture())
        publish._validate_generation_input_integrity(manifest, '2026-08-31')
        manifest['llmApiBindingsFingerprint'] = '0'*64
        with self.assertRaises(PublishDataValidationError):
            publish._validate_generation_input_integrity(manifest, '2026-08-31')

    def test_parent_stage_change_cannot_reuse_prior_success(self):
        manifest = manifest_for(llm_api_publication_fixture())
        publish._validate_generation_input_integrity(manifest, '2026-08-31')
        manifest['publishedPapers'][0]['analysisManifest']['stages']['apiReaderArticle']['planSha256'] = '0'*64
        # Even consistent outer snapshot hashes cannot authorize a bad inner parent.
        rebind_input(manifest)
        with self.assertRaisesRegex(PublishDataValidationError, 'SHA'):
            publish._validate_generation_input_integrity(manifest, '2026-08-31')

    def test_exception_is_not_a_success_or_a_persistent_failure_cache(self):
        manifest = manifest_for(llm_api_publication_fixture())
        actual = publish.llm_api_publication_bindings
        with mock.patch.object(publish, 'llm_api_publication_bindings',
                               side_effect=PublishDataValidationError('transient read')):
            with self.assertRaisesRegex(PublishDataValidationError, 'transient read'):
                publish._validate_generation_input_integrity(manifest, '2026-08-31')
        with mock.patch.object(publish, 'llm_api_publication_bindings', wraps=actual) as check:
            publish._validate_generation_input_integrity(manifest, '2026-08-31')
            self.assertEqual(check.call_count, 1)

    def test_changed_proof_and_duplicate_ids_still_reject(self):
        manifest = manifest_for(llm_api_publication_fixture())
        manifest['llmApiProduction']['bindingsFingerprint'] = '0'*64
        manifest['llmApiProductionFingerprint'] = publish._stable_json_sha256(manifest['llmApiProduction'])
        with self.assertRaises(PublishDataValidationError):
            publish._validate_generation_input_integrity(manifest, '2026-08-31')
        paper = llm_api_publication_fixture()
        with self.assertRaisesRegex(PublishDataValidationError, '重复'):
            publish.llm_api_production_proof([paper, copy.deepcopy(paper)])
