"""Actual aggregate packet paths reuse the paper decision resolver, not eligibility."""
import copy
import hashlib
import json
import subprocess
from pathlib import Path
import sys
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_publish_to_blog import publish_to_blog as publisher, llm_api_publication_fixture
from test_conference_page_render import MODULE as conference
from project_env_isolation import isolate_module_environment, restore_environment_after
import paper_reader_presentation as shared

setUpModule, tearDownModule = isolate_module_environment()


class AggregateReaderPresentationTest(unittest.TestCase):
    def setUp(self):
        restore_environment_after(self)
        self.network = mock.patch('socket.socket.connect', side_effect=AssertionError('no network'))
        self.models = mock.patch('publish_common.call_publish_llm_api', side_effect=AssertionError('no model'))
        self.network.start(); self.models.start()
        self.addCleanup(self.network.stop); self.addCleanup(self.models.stop)

    def records(self):
        paper = json.loads(subprocess.check_output(['node', '-e',
            "const f=require('./tests/valid-analysis-fixture.js'),p=f.validLegacyApiAnalysisPaper('2609.00001'),n=f.validAnalysisPaper('2609.00001');for(const k of ['taxonomySeal','coreSummaryRepair'])p.analysisManifest.stages[k]=n.analysisManifest.stages[k];for(const k of ['taxonomy','coreSummary'])p.analysisManifest.contracts[k]=n.analysisManifest.contracts[k];for(const k of ['coreSummaryInputAnalysisSha256','inputCoreSummarySha256','outputCoreSummarySha256'])p.analysisManifest.stages.scoringAudit[k]=n.analysisManifest.stages.scoringAudit[k];process.stdout.write(JSON.stringify(p));"], cwd=ROOT))
        source = 'In our evaluation on the LibriSpeech test set, our model reduces WER from 10.2% to 9.8% compared with the baseline.'
        paper['sourceSha256'] = hashlib.sha256(source.encode()).hexdigest()
        paper['analysisManifest'].setdefault('sourceAcquisition', {})['sourceSha256'] = paper['sourceSha256']
        return [{'paperKey': 'arxiv:2609.00001', 'paper': paper,
                 'sourceText': source, 'resources': copy.deepcopy(paper['apiReaderResources']['resources'])}]

    def test_actual_packet_uses_same_daily_decision_and_score_tuple(self):
        records = self.records(); original = copy.deepcopy(records)
        paper = records[0]['paper']
        parsed = publisher.parse_analysis(paper['analysis'])
        expected = shared.resolve_reader_decision_display(publisher, paper,
            plan=paper['apiReaderPlan'], resources=records[0]['resources'], parsed=parsed, source_text=records[0]['sourceText'])
        with mock.patch.object(shared, 'load_publish_to_blog', return_value=publisher) as loader:
            result = conference.render_packet({'aggregatePresentationBatch': records})
        self.assertEqual(loader.call_count, 1)
        self.assertEqual(result, {'readerPresentations': [{'paperKey': records[0]['paperKey'],
            **expected, 'scoreLine': shared.reader_score_line(parsed)}]})
        self.assertEqual(records, original)

    def test_shared_change_propagates_but_bad_core_stage_cannot_be_displayed(self):
        records = self.records()
        original = shared.resolve_reader_decision_display
        def changed(*args, **kwargs):
            value = original(*args, **kwargs)
            return {**value, 'summary': value['summary'] + '共享变更。'}
        with mock.patch.object(shared, 'load_publish_to_blog', return_value=publisher), \
                mock.patch.object(shared, 'resolve_reader_decision_display', side_effect=changed):
            result = conference.render_packet({'aggregatePresentationBatch': records})
        self.assertTrue(result['readerPresentations'][0]['summary'].endswith('共享变更。'))
        records[0]['paper']['analysisManifest']['stages']['coreSummaryRepair']['summarySha256'] = '0' * 64
        with mock.patch.object(shared, 'load_publish_to_blog', return_value=publisher), self.assertRaises(ValueError):
            conference.render_packet({'aggregatePresentationBatch': records})

    def test_bad_packet_bounds_urls_and_unknown_fields_do_not_mint_permission(self):
        records = self.records()
        for packet in ({'aggregatePresentationBatch': []}, {'aggregatePresentationBatch': records * 9},
                       {'aggregatePresentationBatch': records, 'paper': records[0]['paper']}):
            with self.subTest(packet_fields=list(packet)), self.assertRaises(ValueError):
                conference.render_packet(packet)
        for mutate in (lambda row: row.update(eligible=True),
                       lambda row: row.update(resources=[{'originalUrl': 'http://example.com', 'finalUrl': 'https://example.com'}]),
                       lambda row: row.update(resources=[{'originalUrl': 'https://127.0.0.1', 'finalUrl': 'https://example.com'}])):
            bad = copy.deepcopy(records); mutate(bad[0])
            with mock.patch.object(shared, 'load_publish_to_blog', return_value=publisher), self.assertRaises(ValueError):
                conference.render_packet({'aggregatePresentationBatch': bad})

    def test_filtered_arxiv_is_not_reintroduced_from_original_paper(self):
        records = self.records()
        records[0]['paper']['apiReaderResources']['resources'] = [{
            'type': 'code', 'originalUrl': 'https://arxiv.org/abs/2609.00001',
            'finalUrl': 'https://arxiv.org/abs/2609.00001', 'availability': 'available', 'status': 200}]
        records[0]['resources'] = []
        with mock.patch.object(shared, 'load_publish_to_blog', return_value=publisher):
            block = conference.render_packet({'aggregatePresentationBatch': records})['readerPresentations'][0]['resourceBlock']
        self.assertNotIn('arxiv.org', block)
        self.assertIn('开放状态尚未核实', block)

    def test_explicit_source_replays_stage_every_time_and_refuses_paid_scope(self):
        record = self.records()[0]
        paper, source = record['paper'], record['sourceText']
        parsed = publisher.parse_analysis(paper['analysis'])
        with mock.patch.object(publisher, '_run_core_summary_node_replay',
                               wraps=publisher._run_core_summary_node_replay) as replay:
            for _ in range(2):
                publisher._validated_detailed_core_summary(paper, parsed, source_text=source)
            self.assertEqual(replay.call_count, 2)
            self.assertTrue(all(call.kwargs['stage_replay'] is True for call in replay.call_args_list))
        plain = copy.deepcopy(paper)
        plain['analysisManifest']['stages']['coreSummaryRepair']['paidDiagnosticReplay'] = {
            'id': '11111111-1111-4111-8111-111111111111'}
        self.assertEqual(publisher._validated_detailed_core_summary(plain, parsed, source_text=source), parsed['summary'])
        for field, value in [('operatorLiteralCorrection', None),
                             ('paidDiagnosticReplay', {'operatorLiteralCorrectionRequired': True}),
                             ('paidDiagnosticReplay', {'operatorLiteralCorrectionRequired': None}),
                             ('paidDiagnosticReplay', {'operatorLiteralCorrectionRequired': False})]:
            bad = copy.deepcopy(paper)
            bad['analysisManifest']['stages']['coreSummaryRepair'][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                publisher._validated_detailed_core_summary(bad, parsed, source_text=source)
        for value in ('', source + 'changed', 1):
            with self.subTest(source=value), self.assertRaises(ValueError):
                publisher._validated_detailed_core_summary(paper, parsed, source_text=value)
        bad = copy.deepcopy(paper)
        bad['freshRewriteProvenance'] = {'contract': 'fresh-source-analysis-v1', 'sourceSha256': '0' * 64}
        with self.assertRaises(ValueError):
            publisher._validated_detailed_core_summary(bad, parsed, source_text=source)


class LiteralSummaryDisplayOnlyTest(unittest.TestCase):
    # Explicit display doubles: these tests do not mint source or scientific authority.
    def publisher(self, summary):
        stub = mock.Mock()
        stub.render_verified_reader_resources.return_value = '原资源显示。'
        stub.render_verified_reader_scoring_notes.return_value = '原评分显示。'
        stub._validated_detailed_core_summary.return_value = summary
        return stub

    def test_actual_lopez_summary_token_is_visible_and_original_record_unchanged(self):
        raw = '保留填充词与<unk>的转写与交叉复核'
        paper = {'analysis': raw, 'retained': {'fees': [1, 2]}}
        before = copy.deepcopy(paper)
        stub = self.publisher(raw)
        result = shared.resolve_reader_decision_display(stub, paper, plan={}, resources=[], parsed={})
        self.assertEqual(result['summary'], '保留填充词与`<unk>`的转写与交叉复核')
        self.assertEqual(paper, before)
        stub._validated_detailed_core_summary.assert_called_once_with(paper, {})
        self.assertEqual(result['resourceBlock'], '原资源显示。')
        self.assertEqual(result['scoringBlock'], '原评分显示。')

    def test_closed_tokens_and_normal_math_stay_idempotent(self):
        for raw in ('保留`<unk>`。', r'公式 \(x+y\) 和 [来源](https://example.org)。'):
            stub = self.publisher(raw)
            first = shared.resolve_reader_decision_display(stub, {}, plan={}, resources=[], parsed={})
            self.assertEqual(first['summary'], raw)
            stub._validated_detailed_core_summary.return_value = first['summary']
            self.assertEqual(shared.resolve_reader_decision_display(stub, {}, plan={}, resources=[], parsed={}), first)

    def test_bad_core_source_replay_cannot_be_cleaned_into_a_display_success(self):
        stub = self.publisher('不得借此投影未通过摘要')
        stub._validated_detailed_core_summary.side_effect = ValueError('source replay refused')
        with self.assertRaisesRegex(ValueError, 'source replay refused'):
            shared.resolve_reader_decision_display(stub, {}, plan={}, resources=[], parsed={})
