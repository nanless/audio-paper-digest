"""Publisher boundary tests; fabricated JSON never supplies PDF authority."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_env_isolation import isolate_module_environment
from test_publish_to_blog import publish_to_blog as publisher, llm_api_publication_fixture
import paper_reader_presentation as presentation

setUpModule, tearDownModule = isolate_module_environment()


def with_marker():
    paper = llm_api_publication_fixture()
    resource = paper['apiReaderResources']['resources'][0]
    resource['authenticatedPdfFootnoteEvidence'] = {
        'contract': 'reader-authenticated-pdf-footnote-evidence-v1',
        'originalUrl': resource['originalUrl'], 'sourceTextSha256': paper['sourceSha256'],
        'sourceQuote': resource['sourceQuote'], 'sourceQuoteSha256': resource['sourceQuoteSha256'],
        'evidenceSha256': 'a' * 64,
    }
    body = {key: value for key, value in paper['apiReaderResources'].items() if key != 'identitySha256'}
    identity = publisher._stable_json_sha256(body)
    paper['apiReaderResources']['identitySha256'] = identity
    paper['analysisManifest']['stages']['openSourceScan']['resourceEvidenceSha256'] = identity
    paper['analysisManifest']['stages']['apiReaderArticle']['resourceIdentitySha256'] = identity
    return paper


class AuthenticatedFootnotePublicationTests(unittest.TestCase):
    def test_explicit_proof_always_invokes_normal_private_worker_and_rejects_its_failure(self):
        paper = with_marker()
        requests = []

        def replay(_command, **kwargs):
            fd = kwargs['pass_fds'][0]
            os.lseek(fd, 0, os.SEEK_SET)
            requests.append(json.loads(os.read(fd, 128 * 1024 * 1024)))
            self.assertEqual(kwargs['timeout_seconds'], 180)
            return SimpleNamespace(stdout='{"verified":true}', returncode=0,
                                   timed_out=False, output_truncated=False)

        before = copy.deepcopy(paper)
        with mock.patch.object(publisher, '_run_bounded_subprocess', side_effect=replay) as worker:
            publisher._validate_api_reader_resource_identity(paper)
            worker.assert_called_once()
        self.assertEqual(requests[0], {'paper': paper, 'authenticatedPdfResources': True})
        self.assertEqual(paper, before)
        rejected = SimpleNamespace(stdout='{"verified":false,"message":"real source mismatch"}',
                                   returncode=1, timed_out=False, output_truncated=False)
        with mock.patch.object(publisher, '_run_bounded_subprocess', return_value=rejected):
            with self.assertRaisesRegex(publisher.PublishDataValidationError, '真实来源冷重放'):
                publisher._validate_api_reader_resource_identity(paper)

    def test_resource_only_display_uses_long_source_bound_worker_without_inventing_a_table(self):
        source = 'The authenticated source contains the exact current release declaration.'
        paper = {'sourceSha256': hashlib.sha256(source.encode()).hexdigest(), 'apiReaderPlan': {'tableBindings': []},
                 'apiReaderResources': {'resources': [{'authenticatedPdfFootnoteEvidence': {'contract': 'explicit-marker'}}]}}
        success = SimpleNamespace(stdout='{"verified":true,"resources":[]}', returncode=0,
                                  timed_out=False, output_truncated=False)
        with (mock.patch.object(publisher, '_run_bounded_subprocess', return_value=success) as worker,
              mock.patch.object(publisher, '_validate_api_reader_source_bindings') as tables):
            self.assertEqual(presentation.replay_resource_presentation(paper, source, publisher=publisher), [])
            self.assertEqual(worker.call_args.kwargs['timeout_seconds'], 180)
            tables.assert_not_called()
        paper['apiReaderPlan']['tableBindings'] = [{'authenticatedPdfTableEvidence': {}}]
        with mock.patch.object(publisher, '_run_bounded_subprocess', return_value=success):
            with self.assertRaisesRegex(ValueError, '缺少公共来源重放结果'):
                presentation.replay_resource_presentation(paper, source, publisher=publisher)

    def test_footnote_source_claim_replay_is_long_and_never_uses_a_paper_only_warm_cache(self):
        paper = with_marker()
        source = 'The authenticated current source is checked again on every replay.'
        paper['sourceSha256'] = hashlib.sha256(source.encode()).hexdigest()
        success = SimpleNamespace(stdout='{"verified":true}', returncode=0,
                                  timed_out=False, output_truncated=False)
        with (mock.patch.object(publisher, '_run_bounded_subprocess', return_value=success) as worker,
              mock.patch.object(publisher, '_READER_RESOURCE_CLAIM_REPLAY_CACHE', set())):
            for _ in range(2):
                publisher._validate_reader_resource_claim_source_replay(paper, {'text': source}, 'fixture')
            self.assertEqual(worker.call_count, 2)
            self.assertEqual(worker.call_args.kwargs['timeout_seconds'], 180)
        malformed = SimpleNamespace(stdout='[]', returncode=0, timed_out=False, output_truncated=False)
        with mock.patch.object(publisher, '_run_bounded_subprocess', return_value=malformed):
            with self.assertRaises(publisher.PublishDataValidationError):
                publisher._validate_authenticated_pdf_resource_identity_replay(paper)

    def test_declared_source_correction_without_pdf_markers_uses_existing_long_bound_only(self):
        source = 'The retained source correction is verified by the real Node worker.'
        paper = {'sourceSha256': hashlib.sha256(source.encode()).hexdigest(),
                 'apiReaderPlan': {'tableBindings': []}, 'apiReaderResources': {'resources': []}}
        success = SimpleNamespace(stdout='{"verified":true,"resources":[]}', returncode=0,
                                  timed_out=False, output_truncated=False)
        for locator, timeout in [
            (None, 30), ({}, 30), ('conference-source-core-correction-v1', 30),
            ({'contract': 'unknown-source-correction'}, 30),
            ({'contract': 'conference-source-core-correction-v1'}, 180),
            ({'contract': 'conference-source-resource-correction-v1'}, 180),
        ]:
            current = copy.deepcopy(paper)
            if locator is not None:
                current['conferenceSourceCorrection'] = locator
            before = copy.deepcopy(current)
            with (mock.patch.object(publisher, '_run_bounded_subprocess', return_value=success) as worker,
                  mock.patch.object(publisher, '_validate_api_reader_source_bindings') as tables):
                self.assertEqual(presentation.replay_resource_presentation(current, source, publisher=publisher), [])
                self.assertEqual(worker.call_args.kwargs['timeout_seconds'], timeout)
                tables.assert_not_called()
            self.assertEqual(current, before)
        rejected = SimpleNamespace(stdout='{"verified":false,"message":"canonical source mismatch"}',
                                   returncode=1, timed_out=False, output_truncated=False)
        with mock.patch.object(publisher, '_run_bounded_subprocess', return_value=rejected):
            with self.assertRaisesRegex(ValueError, 'canonical source mismatch'):
                presentation.replay_resource_presentation(current, source, publisher=publisher)

    def test_private_cli_resource_json_cannot_fake_source_or_satisfy_table_only(self):
        paper = with_marker()
        for mode, expected in [('authenticatedPdfTables', 'actual saved table proof'),
                               ('authenticatedPdfResources', '原规范完成运行')]:
            with self.subTest(mode=mode), tempfile.TemporaryFile() as stream:
                stream.write(json.dumps({'paper': paper, mode: True}).encode())
                stream.flush(); stream.seek(0)
                result = subprocess.run(['node', 'scripts/lib/reader-resource-claims-replay-cli.js', str(stream.fileno())],
                                        cwd=ROOT, pass_fds=(stream.fileno(),), capture_output=True, text=True, timeout=30)
            value = json.loads(result.stdout)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(value['verified'])
            self.assertIn(expected, value['message'])

    def test_core_stage_binding_source_correction_replays_get_long_bound_without_relaxing_failure(self):
        success = SimpleNamespace(stdout='{"issue":null}', returncode=0,
                                  timed_out=False, output_truncated=False)
        for locator, stage_replay, timeout in [
            (None, True, 30), ({'contract': 'unknown'}, True, 30),
            ({'contract': 'conference-source-core-correction-v1'}, True, 180),
            ({'contract': 'conference-source-resource-correction-v1'}, True, 180),
            ({'contract': 'conference-source-core-correction-v1'}, False, 30),
        ]:
            paper = {} if locator is None else {'conferenceSourceCorrection': locator}
            with (mock.patch.object(publisher, '_run_bounded_subprocess', return_value=success) as worker,
                  mock.patch.object(publisher, '_CORE_SUMMARY_NODE_REPLAY_CACHE', {})):
                self.assertIsNone(publisher._run_core_summary_node_replay(
                    paper, 'summary fixture', 'source fixture', stage_replay=stage_replay))
                self.assertEqual(worker.call_args.kwargs['timeout_seconds'], timeout)
                self.assertEqual(worker.call_args.kwargs['max_output_bytes'], 64 * 1024)
        for changes in [{'returncode': 1}, {'timed_out': True}, {'output_truncated': True}]:
            failure = SimpleNamespace(stdout='{"issue":null}', returncode=0,
                                      timed_out=False, output_truncated=False)
            failure.__dict__.update(changes)
            with mock.patch.object(publisher, '_run_bounded_subprocess', return_value=failure):
                with self.assertRaisesRegex(publisher.PublishDataValidationError, '无法完整重放'):
                    publisher._run_core_summary_node_replay(paper, 'summary fixture', 'source fixture', stage_replay=True)


if __name__ == '__main__':
    unittest.main()
