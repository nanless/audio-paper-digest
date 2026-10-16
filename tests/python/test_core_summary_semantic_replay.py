import copy
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

REAL_AUDIT = os.environ.get('PD_CORE_SUMMARY_REPLAY_REAL_AUDIT')
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_publish_to_blog import publish_to_blog as publish, llm_api_publication_fixture
from publish_common import PublishDataValidationError


class CoreSummarySemanticReplayTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='core-summary-py-replay-')
        self.root = Path(self.tmp.name)
        self.old_cache = dict(publish._CORE_SUMMARY_NODE_REPLAY_CACHE)
        publish._CORE_SUMMARY_NODE_REPLAY_CACHE.clear()
        self.source_patch = mock.patch.object(publish, 'DAILY_FRESH_SOURCE_RUNS_DIR', self.root)
        self.source_patch.start()
        self.paper = llm_api_publication_fixture()
        self.run_id = 'd2d8c135-d801-4de1-8ed2-d5649ea7ec95'
        self.source_dir = self.root / self.run_id / 'sources' / self.paper['arxivId'] / 'generation-000001'
        self.source_dir.mkdir(parents=True)
        self.source = self.source_dir / 'source.txt'
        # This is only a unit fixture for the semantic FD bridge. It does not
        # claim the synthetic paper satisfies the full publication source gate.
        self.source.write_text('On the public evaluation test set, WER improved from 10.2% to 8.4% compared with the baseline.', encoding='utf-8')
        self.source.chmod(0o600)
        source_sha = hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.paper['sourceSha256'] = source_sha
        self.paper['freshRewriteProvenance'] = {'contract': 'fresh-source-analysis-v1', 'runId': self.run_id,
                                               'sourceGeneration': 1, 'sourceSha256': source_sha}
        self.summary = self.paper['parsed']['summary']

    def tearDown(self):
        self.source_patch.stop()
        publish._CORE_SUMMARY_NODE_REPLAY_CACHE.clear()
        publish._CORE_SUMMARY_NODE_REPLAY_CACHE.update(self.old_cache)
        self.tmp.cleanup()

    def test_real_child_fd_stays_linked_private_and_current_node_rules_replay(self):
        calls = []
        original = publish._run_bounded_subprocess

        def inspect(args, **kwargs):
            fd = kwargs['pass_fds'][0]
            info = os.fstat(fd)
            self.assertEqual(info.st_nlink, 1)
            self.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
            self.assertTrue(stat.S_ISREG(info.st_mode))
            self.assertLessEqual(info.st_size, 16 * 1024 * 1024)
            self.assertEqual(args[-1], str(fd))
            self.assertNotIn('NODE_OPTIONS', kwargs['env'])
            self.assertNotIn('NODE_PATH', kwargs['env'])
            calls.append(args)
            return original(args, **kwargs)

        before = copy.deepcopy(self.paper)
        with mock.patch.object(publish, '_run_bounded_subprocess', side_effect=inspect):
            self.assertIsNone(publish._source_bound_core_summary_semantic_issue(self.paper, self.summary))
            self.assertIsNone(publish._source_bound_core_summary_semantic_issue(self.paper, self.summary))
        self.assertEqual(len(calls), 1, 'identical semantic input may reuse only its exact replay')
        self.assertEqual(self.paper, before)

    def test_source_checks_precede_cache_and_missing_sha_uuid_generation_refuse(self):
        self.assertIsNone(publish._source_bound_core_summary_semantic_issue(self.paper, self.summary))
        for change in (lambda p: p.update(sourceSha256='a' * 64),
                       lambda p: p['freshRewriteProvenance'].update(sourceSha256='b' * 64),
                       lambda p: p['freshRewriteProvenance'].update(runId='../../foreign'),
                       lambda p: p['freshRewriteProvenance'].update(runId='not-a-uuid'),
                       lambda p: p['freshRewriteProvenance'].update(sourceGeneration=2)):
            bad = copy.deepcopy(self.paper)
            change(bad)
            with self.subTest(bad=bad['freshRewriteProvenance']), self.assertRaises(PublishDataValidationError):
                publish._source_bound_core_summary_semantic_issue(bad, self.summary)
        original = self.source.read_bytes()
        self.source.unlink()
        with self.assertRaises(PublishDataValidationError):
            publish._source_bound_core_summary_semantic_issue(self.paper, self.summary)
        self.source.write_bytes(original)
        self.source.chmod(0o600)
        self.source.write_bytes(original + b' changed')
        with self.assertRaisesRegex(PublishDataValidationError, 'SHA'):
            publish._source_bound_core_summary_semantic_issue(self.paper, self.summary)

    def test_fake_node_response_timeout_truncation_failure_do_not_poison_cache(self):
        responses = [SimpleNamespace(returncode=0, timed_out=False, output_truncated=False, stdout=text)
                     for text in ('not JSON', '{}', '{"issue":false}', '{"issue":[],"approved":true}', 'null')]
        responses += [SimpleNamespace(returncode=code, timed_out=timeout, output_truncated=truncated,
                                      stdout='{"issue":null}')
                      for code, timeout, truncated in ((1, False, False), (0, True, False), (0, False, True))]
        for response in responses:
            publish._CORE_SUMMARY_NODE_REPLAY_CACHE.clear()
            with self.subTest(response=response), mock.patch.object(publish, '_run_bounded_subprocess', return_value=response), \
                    self.assertRaises(PublishDataValidationError):
                publish._source_bound_core_summary_semantic_issue(self.paper, self.summary)
            self.assertEqual(publish._CORE_SUMMARY_NODE_REPLAY_CACHE, {})

    def test_new_semantic_bridge_keeps_summary_stage_and_upstream_binding_guards(self):
        self.assertEqual(publish._validated_detailed_core_summary(self.paper, self.paper['parsed']), self.summary)
        for change in (lambda p: p['analysisManifest']['stages']['coreSummaryRepair'].update(summarySha256='a' * 64),
                       lambda p: p['analysisManifest']['stages']['coreSummaryRepair'].update(bindingSha256='a' * 64),
                       lambda p: p['analysisManifest']['stages']['coreSummaryRepair'].update(status='failed'),
                       lambda p: p['parsed'].update(summary='altered cached summary')):
            bad = copy.deepcopy(self.paper)
            change(bad)
            with self.assertRaises(PublishDataValidationError):
                publish._validated_detailed_core_summary(bad, bad['parsed'])

    def test_legacy_standalone_semantic_rule_is_preserved(self):
        legacy = llm_api_publication_fixture()
        for text in (self.summary, '本文效果很好。'):
            self.assertEqual(publish._source_bound_core_summary_semantic_issue(legacy, text),
                             publish._detailed_core_summary_semantic_issue(text))

    def test_paid_stage_dispatch_never_reuses_semantic_cache(self):
        # Synthetic receipt tests dispatch only; no claim of valid paid provenance.
        stage = self.paper['analysisManifest']['stages']['coreSummaryRepair']
        stage['paidDiagnosticReplay'] = {'id': 'synthetic-dispatch-only'}
        calls = []
        def inspect(args, **kwargs):
            fd = kwargs['pass_fds'][0]
            payload = json.loads(os.pread(fd, os.fstat(fd).st_size, 0))
            self.assertEqual(set(payload), {'mode', 'paper', 'sourceText'})
            self.assertEqual(payload['mode'], 'stage-binding')
            self.assertEqual(payload['paper'], self.paper)
            calls.append(payload)
            return SimpleNamespace(returncode=0, timed_out=False, output_truncated=False, stdout='{"issue":null}')
        with mock.patch.object(publish, '_run_bounded_subprocess', side_effect=inspect):
            self.assertIsNone(publish._source_bound_core_summary_semantic_issue(self.paper, self.summary))
            self.assertIsNone(publish._source_bound_core_summary_semantic_issue(self.paper, self.summary))
        self.assertEqual(len(calls), 2)
        self.assertEqual(publish._CORE_SUMMARY_NODE_REPLAY_CACHE, {})

    def test_operator_binding_hash_matches_node_fields_and_cannot_drop_whole_receipt(self):
        # Only the Python binding calculation is isolated here; real operator
        # provenance is checked by the source-bound public Node tests.
        stage = self.paper['analysisManifest']['stages']['coreSummaryRepair']
        stage['operatorLiteralCorrection'] = {'contract': 'synthetic-binding-only'}
        stage['paidDiagnosticReplay'] = {'operatorLiteralCorrectionRequired': True}
        keys = ('contractVersion', 'inputAnalysisSha256', 'outputAnalysisSha256', 'inputSummarySha256',
                'summarySha256', 'inputStructureProjectionSha256', 'outputStructureProjectionSha256',
                'operatorLiteralCorrection', 'paidDiagnosticReplay')
        stage['bindingSha256'] = publish._stable_json_sha256({key: stage[key] for key in keys})
        with mock.patch.object(publish, '_source_bound_core_summary_semantic_issue', return_value=None):
            self.assertEqual(publish._validated_detailed_core_summary(self.paper, self.paper['parsed']), self.summary)
            del stage['operatorLiteralCorrection']
            del stage['paidDiagnosticReplay']
            with self.assertRaisesRegex(PublishDataValidationError, '绑定 SHA'):
                publish._validated_detailed_core_summary(self.paper, self.paper['parsed'])

    def test_each_node_implementation_dependency_participates_in_exact_cache_key(self):
        original_hash = publish._sha256_file
        original_run = publish._run_bounded_subprocess
        selected = [None]
        paths = [publish.SHARED_SCRIPTS_DIR / 'lib/core-summary-semantic-replay-cli.js',
                 publish.SHARED_SCRIPTS_DIR / 'analysis-contract.js',
                 publish.SHARED_SCRIPTS_DIR / 'lib/analysis-section-titles.js']

        def fingerprint(file):
            return 'a' * 64 if selected[0] == Path(file) else original_hash(file)

        with mock.patch.object(publish, '_sha256_file', side_effect=fingerprint), \
                mock.patch.object(publish, '_run_bounded_subprocess', wraps=original_run) as run:
            self.assertIsNone(publish._source_bound_core_summary_semantic_issue(self.paper, self.summary))
            for index, dependency in enumerate(paths, 2):
                selected[0] = dependency
                self.assertIsNone(publish._source_bound_core_summary_semantic_issue(self.paper, self.summary))
                self.assertEqual(run.call_count, index)
            self.assertIsNone(publish._source_bound_core_summary_semantic_issue(self.paper, self.summary))
            self.assertEqual(run.call_count, 4)


@unittest.skipUnless(REAL_AUDIT, 'actual private source audit opt-in')
class ActualCoreSummarySemanticReplayTests(unittest.TestCase):
    def test_all_eleven_real_summaries_pass_current_semantics_and_original_stage_proofs_without_writes(self):
        project = Path(__file__).resolve().parents[2]
        formal_file = project / 'data/current/deep-analysis-result.json'
        formal_before_sha = publish._sha256_file(formal_file)
        audit_before = Path(REAL_AUDIT).read_bytes()
        with formal_file.open(encoding='utf-8') as handle:
            formal = json.load(handle)
        # Read once and retain only the actual eleven records; no 108MB copy.
        audited = json.loads(audit_before)
        self.assertEqual(len(audited), 11)
        wanted = {row['paperId'] for row in audited}
        papers = {paper['arxivId']: paper for paper in formal['papers'] if paper['arxivId'] in wanted}
        self.assertEqual(set(papers), wanted)
        run_id = formal['dailyFreshSourceRun']['runId']
        del formal
        sources = project / 'data/runtime/daily-fresh-source-runs' / run_id / 'sources'
        for row in audited:
            paper = papers[row['paperId']]
            before = publish._stable_json_sha256(paper)
            source = sources / row['paperId'].split('v')[0] / 'generation-000001/source.txt'
            source_sha = hashlib.sha256(source.read_bytes()).hexdigest()
            with self.subTest(paper=row['paperId']):
                self.assertIsNone(publish._source_bound_core_summary_semantic_issue(paper, row['summary']))
                self.assertEqual(publish._validated_detailed_core_summary(paper, paper['parsed']), row['summary'])
                self.assertEqual(publish._stable_json_sha256(paper), before)
                self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), source_sha)
        self.assertEqual(publish._sha256_file(formal_file), formal_before_sha)
        self.assertEqual(Path(REAL_AUDIT).read_bytes(), audit_before)


if __name__ == '__main__':
    unittest.main()
