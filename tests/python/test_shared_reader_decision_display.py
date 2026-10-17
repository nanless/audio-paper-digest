"""Three real renderer adapters share display decisions, never eligibility."""
import copy
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_env_isolation import isolate_module_environment, restore_environment_after
from test_publish_to_blog import publish_to_blog as publisher, llm_api_publication_fixture
import test_conference_page_render as conference_tests
import test_historical_page_render as historical_tests
import paper_reader_presentation as presentation

setUpModule, tearDownModule = isolate_module_environment()


def historical_conference_paper():
    paper = llm_api_publication_fixture()
    paper.pop('arxivId')
    paper['directPaperId'] = 'conference:icassp:2026:icassp-arnumber:100'
    paper['analysis'] += ('\n\n## 标签\n#语音识别 #Transformer #低资源\n'
                          '主任务标签: #语音识别\n主方法标签: #Transformer\n补充标签: #低资源')
    paper['analysisManifest']['stages']['scoringAudit']['outputAnalysisSha256'] = (
        hashlib.sha256(paper['analysis'].encode()).hexdigest())
    return paper


class SharedReaderDecisionDisplayTests(unittest.TestCase):
    def setUp(self):
        restore_environment_after(self)
        self.network = mock.patch('socket.socket.connect', side_effect=AssertionError('no network'))
        self.models = mock.patch('publish_common.call_publish_llm_api', side_effect=AssertionError('no model'))
        self.network.start(); self.models.start()
        self.addCleanup(self.network.stop); self.addCleanup(self.models.stop)

    def test_daily_old_fields_and_cached_parsed_choice_are_exact_without_reloading_module(self):
        paper = llm_api_publication_fixture()
        payload = publisher._api_reader_payload(paper)
        before = copy.deepcopy(paper)
        expected = {
            'summary': publisher._validated_detailed_core_summary(paper, paper['parsed']),
            'opensource': publisher.render_verified_reader_resources(
                payload['resourceIdentityProof']['resources'], paper=paper),
            'scoringReason': publisher.render_verified_reader_scoring_notes(paper, paper['parsed']),
        }
        with mock.patch.object(presentation, 'load_publish_to_blog', side_effect=AssertionError('second module')):
            self.assertEqual(publisher._build_api_reader_display_fields(paper, payload), expected)
        # The detailed-core verifier reparses by design; the display adapter
        # itself must still select the nonempty saved parsed object first.
        calls = []
        actual = presentation.resolve_reader_decision_display
        def observed(module, row, **kwargs):
            calls.append(kwargs['parsed'])
            return actual(module, row, **kwargs)
        with mock.patch.object(presentation, 'resolve_reader_decision_display', side_effect=observed):
            publisher._build_api_reader_display_fields(paper, payload)
        self.assertIs(calls[0], paper['parsed'])
        paper['parsed'] = {}
        with mock.patch.object(presentation, 'resolve_reader_decision_display', side_effect=observed):
            publisher._build_api_reader_display_fields(paper, payload)
        self.assertEqual(calls[-1]['summary'], before['parsed']['summary'])
        paper['parsed'] = before['parsed']
        self.assertEqual(paper, before)

    def test_shared_projection_changes_propagate_through_three_actual_page_renderers(self):
        daily = llm_api_publication_fixture()
        conference = conference_tests.ConferencePageRenderTest().packet()
        history = historical_conference_paper()
        originals = copy.deepcopy((daily, conference, history))
        actual = presentation.resolve_reader_decision_display
        seen = []
        def observed(module, paper, **kwargs):
            result = actual(module, paper, **kwargs)
            seen.append(paper.get('arxivId') or paper.get('directPaperId') or paper.get('conferencePaperId'))
            return {**result, 'summary': result['summary'] + '\n\n共享展示投影传播验证。'}
        with mock.patch.object(presentation, 'resolve_reader_decision_display', side_effect=observed):
            daily_md, _ = publisher.generate_paper_page(daily, '2026-09-04')
            with mock.patch.object(presentation, 'load_publish_to_blog', side_effect=AssertionError('reload')):
                conference_md = conference_tests.MODULE.render_packet(conference)['markdown']
                historical_md = historical_tests.renderer.render_packet({
                    'directStaging': True, 'paper': history, 'cohortDate': '2026-09-04'})['markdown']
        for content in (daily_md, conference_md, historical_md):
            self.assertIn('共享展示投影传播验证。', content)
            self.assertIn('## 👥 作者与机构', content)
            self.assertIn('**研究分类**', content)
        self.assertIn('paper_digest_arxiv_id:', daily_md)
        self.assertIn('会议来源：[官方记录]', conference_md)
        self.assertNotIn('paper_digest_arxiv_id:', conference_md)
        self.assertIn('paper_digest_direct_paper_id:', historical_md)
        self.assertNotIn('paper_digest_arxiv_id:', historical_md)
        self.assertIn(daily['arxivId'], seen)
        self.assertIn(history['directPaperId'], seen)
        self.assertEqual((daily, conference, history), originals)

    def test_display_correction_is_shared_and_does_not_rewrite_summary_evidence(self):
        paper = llm_api_publication_fixture()
        original = copy.deepcopy(paper)
        duplicate = '音频推测推测解码 Audio Speculative Speculative Decoding'
        with mock.patch.object(publisher, '_validated_detailed_core_summary', return_value=duplicate) as cold:
            decision = presentation.resolve_reader_decision_display(
                publisher, paper, plan=paper['apiReaderPlan'],
                resources=paper['apiReaderResources']['resources'], parsed=paper['parsed'])
        self.assertEqual(decision['summary'], '音频推测解码 Audio Speculative Decoding')
        cold.assert_called_once_with(paper, paper['parsed'])
        self.assertEqual(paper, original)

    def test_core_replay_failures_never_fall_back_in_either_adapter(self):
        paper = llm_api_publication_fixture()
        payload = publisher._api_reader_payload(paper)
        before = copy.deepcopy(paper)
        with mock.patch.object(publisher, '_validated_detailed_core_summary',
                               side_effect=ValueError('source/paid replay rejected')) as cold:
            with self.assertRaisesRegex(ValueError, 'source/paid replay rejected'):
                publisher._build_api_reader_display_fields(paper, payload)
            with self.assertRaisesRegex(ValueError, 'source/paid replay rejected'):
                presentation.build_reader_presentation(paper, publisher=publisher,
                    plan=paper['apiReaderPlan'], resources=paper['apiReaderResources']['resources'],
                    authors=paper['apiReaderAuthors']['authors'])
        self.assertEqual(cold.call_count, 2)
        self.assertEqual(paper, before)

    def test_original_saved_object_source_and_reader_guards_still_reject(self):
        paper = llm_api_publication_fixture()
        kwargs = dict(publisher=publisher, plan=paper['apiReaderPlan'],
                      resources=paper['apiReaderResources']['resources'],
                      authors=paper['apiReaderAuthors']['authors'])
        for key, value in [('plan', {}), ('resources', []), ('authors', [])]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                presentation.build_reader_presentation(paper, **{**kwargs, key: value})
        with self.assertRaisesRegex(ValueError, '封存全文 SHA'):
            presentation.build_reader_presentation(paper, source_text='different source', **kwargs)
        with self.assertRaisesRegex(ValueError, '不能脱离'):
            presentation.build_reader_presentation(paper, publication_evidence={}, **kwargs)
        corrupted = copy.deepcopy(paper); corrupted['apiReaderArticleSha256'] = '0' * 64
        with self.assertRaises(ValueError):
            publisher._build_api_reader_display_fields(corrupted)
        paper['parsed']['summary'] = 'stale cached summary'
        with self.assertRaisesRegex(ValueError, '不一致'):
            publisher._build_api_reader_display_fields(paper)

    def test_filtered_source_resource_view_precedes_shared_resolver_without_reloading(self):
        paper = llm_api_publication_fixture()
        source_text = ('In our evaluation on the public test set, our method reduces WER '
                       'from 10.2% to 8.4% compared with the baseline.')
        source_sha = hashlib.sha256(source_text.encode('utf-8')).hexdigest()
        paper['sourceSha256'] = source_sha
        paper['analysisManifest']['sourceAcquisition']['sourceSha256'] = source_sha
        # This synthetic fixture declares an unchanged core stage. Supply its
        # actual input/output text so the full Node stage replay can verify it.
        paper['analysisStageCheckpoints'] = {
            'structureRepair': paper['analysis'], 'coreSummaryRepair': paper['analysis'],
        }
        saved = paper['apiReaderResources']['resources']
        raw = copy.deepcopy(paper)
        replay = [dict(saved[0], originalUrl='https://arxiv.org/abs/2608.30002')]
        actual = presentation.resolve_reader_decision_display
        with (mock.patch.object(presentation, 'replay_resource_presentation', return_value=replay) as source,
             mock.patch.object(presentation, 'resolve_reader_decision_display', wraps=actual) as shared,
             mock.patch.object(presentation, 'load_publish_to_blog', side_effect=AssertionError('reload'))):
            view = presentation.build_reader_presentation(paper, publisher=publisher,
                plan=paper['apiReaderPlan'], resources=saved, authors=paper['apiReaderAuthors']['authors'],
                source_text=source_text,
                exclude_resource_url=lambda url: str(url).startswith('https://arxiv.org/'))
        source.assert_called_once_with(paper, source_text, None, publisher=publisher)
        self.assertEqual(shared.call_args.kwargs['resources'], [])
        self.assertNotIn('https://arxiv.org/', view['resourceBlock'])
        self.assertIn('预印本/扩展版链接未在会议页展示', view['resourceBlock'])
        self.assertEqual(paper, raw)

    def test_shared_implementation_is_content_fingerprinted(self):
        original = publisher._sha256_file
        with mock.patch.object(publisher, '_sha256_file', wraps=original) as reads:
            expected = publisher.generation_template_fingerprint()
        scripts = Path(publisher.__file__).resolve().parent
        paths = [Path(call.args[0]) for call in reads.call_args_list]
        target = scripts / 'paper_reader_presentation.py'
        self.assertIn(target, paths)
        with tempfile.TemporaryDirectory() as directory:
            isolated = Path(directory) / 'scripts'
            for filename in paths:
                if filename.is_relative_to(scripts):
                    output = isolated / filename.relative_to(scripts)
                    output.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(filename, output)
            with mock.patch.object(publisher, '__file__', str(isolated / 'publish-to-blog.py')):
                self.assertEqual(publisher.generation_template_fingerprint(), expected)
                (isolated / target.name).write_bytes(target.read_bytes() + b'\n# fixture mutation\n')
                self.assertNotEqual(publisher.generation_template_fingerprint(), expected)


if __name__ == '__main__':
    unittest.main()
