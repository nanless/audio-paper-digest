"""No production data: private-FD replies and real short-lived local children only."""
import copy
import hashlib
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import publication_local_replay as replay
from test_publish_to_blog import publish_to_blog as publisher
import paper_reader_presentation as presentation


class PublicationLocalReplayTests(unittest.TestCase):
    def setUp(self):
        self.source = 'A complete, sealed local source fixture.'
        self.paper = {'sourceSha256': hashlib.sha256(self.source.encode()).hexdigest(),
                      'conferenceSourceCorrection': {'contract': 'conference-source-resource-correction-v1'},
                      'apiReaderPlan': {'tableBindings': []}, 'apiReaderResources': {'resources': []}}
        self.calls = []

    def worker(self, _command, **kwargs):
        fd = kwargs['pass_fds'][0]
        os.lseek(fd, 0, os.SEEK_SET)
        raw = os.read(fd, 128 * 1024 * 1024)
        self.calls.append((json.loads(raw), kwargs))
        response = {'verified': True, 'resources': [], 'coreSummaryIssue': None,
                    'tableEvidence': {'fixture': 'real-worker-result'},
                    'publicationReplay': {'contract': 'publication-one-invocation-source-replay-v1',
                                          'inputSha256': hashlib.sha256(raw).hexdigest()}}
        return SimpleNamespace(stdout=json.dumps(response), stderr='', returncode=0,
                               timed_out=False, output_truncated=False)

    def test_one_actual_transport_covers_scoring_resources_tables_and_core_then_expires(self):
        with mock.patch.object(publisher, '_run_bounded_subprocess', side_effect=self.worker):
            with replay.publication_replay_scope(self.paper, self.source, publisher=publisher):
                self.assertTrue(publisher._validate_authenticated_pdf_resource_identity_replay(self.paper)['verified'])
                self.assertEqual(publisher._replay_authenticated_pdf_table_bindings(self.paper),
                                 {'fixture': 'real-worker-result'})
                self.assertIsNone(publisher._run_core_summary_node_replay(
                    self.paper, 'fixture summary', self.source, stage_replay=True))
                self.assertEqual(presentation.replay_resource_presentation(
                    self.paper, self.source, publisher=publisher), [])
                self.assertIsNone(replay.publication_replay_result(copy.deepcopy(self.paper)))
            self.assertIsNone(replay.publication_replay_result(self.paper))
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(self.calls[0][0]['publicationReplay'])
        self.assertEqual(self.calls[0][1]['timeout_seconds'], 600)

    def test_page_and_source_mutation_never_reuse_previous_replay(self):
        with mock.patch.object(publisher, '_run_bounded_subprocess', side_effect=self.worker):
            with replay.publication_replay_scope(self.paper, self.source, publisher=publisher):
                with self.assertRaisesRegex(ValueError, '封存来源发生变化'):
                    replay.publication_replay_result(self.paper, 'another source')
                self.paper['extra'] = 'changed'
                with self.assertRaisesRegex(ValueError, '原论文发生变化'):
                    replay.publication_replay_result(self.paper)
                del self.paper['extra']

    def test_forged_missing_or_failed_combined_reply_never_creates_scope(self):
        for delta in ({'publicationReplay': {}}, {'coreSummaryIssue': 'failed'},
                      {'resources': None}, {'verified': False}):
            def changed(*args, **kwargs):
                result = self.worker(*args, **kwargs)
                value = json.loads(result.stdout); value.update(delta); result.stdout = json.dumps(value)
                return result
            with self.subTest(delta=delta), mock.patch.object(publisher, '_run_bounded_subprocess', side_effect=changed):
                with self.assertRaisesRegex(ValueError, '未通过正常重放'):
                    with replay.publication_replay_scope(self.paper, self.source, publisher=publisher):
                        self.fail('must not enter')
                self.assertIsNone(replay.publication_replay_result(self.paper))

    def test_flags_are_classified_before_json_and_output_bytes_are_hashed(self):
        for flags in ({'returncode': -15, 'timed_out': True, 'output_truncated': False},
                      {'returncode': 0, 'timed_out': False, 'output_truncated': True},
                      {'returncode': 1, 'timed_out': False, 'output_truncated': False}):
            result = SimpleNamespace(stdout='', stderr='diagnostic fixture', **flags)
            with self.subTest(flags=flags), mock.patch.object(replay.json, 'loads', side_effect=AssertionError('must inspect flags first')):
                with self.assertRaises(replay.LocalReplayFailure) as caught:
                    replay.checked_replay_response(result, worker='reader-resource-claims-replay-cli.js', timeout_seconds=180)
            self.assertEqual(caught.exception.timed_out, flags['timed_out'])
            self.assertEqual(caught.exception.returncode, flags['returncode'])
            self.assertEqual(caught.exception.stderr_sha256, hashlib.sha256(b'diagnostic fixture').hexdigest())
            self.assertNotIn('diagnostic fixture', str(caught.exception))

    def test_invalid_json_and_array_remain_failure_and_never_create_a_pass(self):
        for output in ('', '[1]', '{"verified":'):
            result = SimpleNamespace(stdout=output, stderr='', returncode=0, timed_out=False, output_truncated=False)
            with self.subTest(output=output), self.assertRaises(replay.LocalReplayFailure):
                replay.checked_replay_response(result, worker='reader-resource-claims-replay-cli.js', timeout_seconds=180)

    def test_render_deadline_cleans_the_real_waiting_child_process_group(self):
        with tempfile.TemporaryDirectory() as directory:
            pidfile = Path(directory) / 'child.pid'
            code = 'import os,pathlib,sys,time; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)'
            with self.assertRaises(TimeoutError):
                with replay.render_process_guard(0.15):
                    publisher._run_bounded_subprocess([sys.executable, '-c', code, str(pidfile)],
                        cwd=directory, env=os.environ.copy(), timeout_seconds=20)
            child_pid = int(pidfile.read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(child_pid, 0)

    def test_fixed_budgets_cover_one_combined_replay_and_aggregate_slots(self):
        self.assertEqual(replay.render_budget_seconds({'paper': self.paper}, 'conference'), 720)
        self.assertEqual(replay.render_budget_seconds({'paper': {}}, 'history'), 180)
        self.assertEqual(replay.render_budget_seconds({'aggregatePresentationBatch': [
            {'paper': self.paper}, {'paper': {}}]}, 'conference'), 750)

    def test_aggregate_issues_one_real_transport_per_exact_record_and_never_cross_reuses(self):
        papers = [copy.deepcopy(self.paper), copy.deepcopy(self.paper)]
        for index, paper in enumerate(papers): paper['id'] = f'fixture:{index}'
        parsed = {'score': 4.0, **{field: float(maximum) / 2
                   for field, _label, maximum in presentation.SCORE_DIMENSIONS}}
        scopes_seen = []
        def summary(paper, _parsed, *, source_text):
            value = replay.publication_replay_result(paper, source_text)
            self.assertIsNotNone(value)
            other = papers[1] if paper is papers[0] else papers[0]
            self.assertIsNone(replay.publication_replay_result(other, source_text))
            scopes_seen.append(paper['id'])
            return '经过同次来源核验的摘要'
        fake = SimpleNamespace(_run_bounded_subprocess=self.worker,
            parse_analysis=lambda _: parsed, render_verified_reader_resources=lambda *_a, **_kw: '资源说明',
            render_verified_reader_scoring_notes=lambda *_a, **_kw: '评分说明',
            _validated_detailed_core_summary=summary)
        records = [{'paperKey': paper['id'], 'paper': paper, 'sourceText': self.source, 'resources': []}
                   for paper in papers]
        results = presentation.build_aggregate_reader_presentations(records, publisher=fake)
        self.assertEqual(len(results), 2); self.assertEqual(len(self.calls), 2)
        self.assertEqual(scopes_seen, ['fixture:0', 'fixture:1'])
        for paper in papers: self.assertIsNone(replay.publication_replay_result(paper, self.source))

    def test_aggregate_second_source_failure_never_returns_first_record_as_partial_success(self):
        papers = [copy.deepcopy(self.paper), copy.deepcopy(self.paper)]
        for index, paper in enumerate(papers): paper['id'] = f'fixture:{index}'
        def worker(*args, **kwargs):
            result = self.worker(*args, **kwargs)
            if len(self.calls) == 2:
                result.returncode = 1; result.stdout = '{"verified":false}'
            return result
        parsed = {'score': 4.0, **{field: float(maximum) / 2
                   for field, _label, maximum in presentation.SCORE_DIMENSIONS}}
        fake = SimpleNamespace(_run_bounded_subprocess=worker,
            parse_analysis=lambda _: parsed, render_verified_reader_resources=lambda *_a, **_kw: '资源说明',
            render_verified_reader_scoring_notes=lambda *_a, **_kw: '评分说明',
            _validated_detailed_core_summary=lambda *_a, **_kw: '经过核验的摘要')
        records = [{'paperKey': paper['id'], 'paper': paper, 'sourceText': self.source, 'resources': []}
                   for paper in papers]
        with self.assertRaises(replay.LocalReplayFailure):
            presentation.build_aggregate_reader_presentations(records, publisher=fake)
        self.assertEqual(len(self.calls), 2)
        for paper in papers: self.assertIsNone(replay.publication_replay_result(paper, self.source))

    def test_only_real_registered_renderer_alarm_can_emit_private_deadline_identity(self):
        renderer = replay.ROOT / 'conference-page-render.py'
        with tempfile.NamedTemporaryFile() as channel:
            with mock.patch.dict(os.environ, {'PD_PUBLICATION_ERROR_FD': str(channel.fileno())}):
                try:
                    with replay.render_process_guard(0.01, renderer=renderer):
                        import time
                        time.sleep(0.04)
                except replay.RenderDeadlineExceeded as error:
                    replay.emit_replay_failure(error, renderer)
                channel.seek(0)
                proof = json.load(channel)
                self.assertEqual(proof['contract'], 'publication-fixed-render-deadline-v1')
                self.assertEqual(proof['signal'], 'SIGALRM')
                self.assertEqual(proof['timeoutSeconds'], 0.01)
                with self.assertRaisesRegex(ValueError, '未登记'):
                    replay.emit_replay_failure(replay.RenderDeadlineExceeded('fabricated'), renderer)
        with self.assertRaises(InterruptedError):
            with replay.render_process_guard(60, renderer=renderer):
                signal.raise_signal(signal.SIGALRM)
        with self.assertRaises(InterruptedError):
            with replay.render_process_guard(60, renderer=renderer):
                signal.raise_signal(signal.SIGTERM)


if __name__ == '__main__':
    unittest.main()
