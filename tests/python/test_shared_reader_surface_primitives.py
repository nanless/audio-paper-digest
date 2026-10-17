"""Portable shared presentation/readonly-unit tests, never publication receipts."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_env_isolation import isolate_module_environment, restore_environment_after
import paper_reader_presentation as presentation
import publish_common as common
from test_publish_to_blog import publish_to_blog as publisher, llm_api_publication_fixture
import test_conference_page_render as conference
import test_historical_page_render as historical
import test_historical_direct_review as history_review
import test_publish_conference as conference_review
from test_shared_reader_decision_display import historical_conference_paper

setUpModule, tearDownModule = isolate_module_environment()


class SharedReaderSurfacePrimitiveTests(unittest.TestCase):
    def setUp(self):
        restore_environment_after(self)

    def test_one_score_spec_keeps_original_daily_and_conference_format_and_limits(self):
        self.assertIs(conference.MODULE.SCORE_DIMENSIONS, presentation.SCORE_DIMENSIONS)
        parsed = {'score': '0', **{field: '0' for field, _label, _maximum in presentation.SCORE_DIMENSIONS}}
        daily = publisher.format_complete_score_line(parsed)
        official = conference.MODULE.score_line(parsed)
        self.assertTrue(daily.startswith('**0/10** | 创新 0/2'))
        self.assertTrue(official.startswith('**0.0/10** | 创新 0.0/2'))
        for _field, label, _maximum in presentation.SCORE_DIMENSIONS:
            self.assertEqual(daily.count(label + ' '), 1)
            self.assertEqual(official.count(label + ' '), 1)
        for field, _label, maximum in presentation.SCORE_DIMENSIONS:
            bad = dict(parsed, **{field: str(float(maximum) + 0.1)})
            with self.subTest(field=field), self.assertRaises(ValueError):
                conference.MODULE.score_line(bad)
        for score in ('NaN', 'Infinity', '-1'):
            with self.assertRaises(ValueError):
                conference.MODULE.score_line(dict(parsed, score=score))
        missing = dict(parsed); missing.pop('engineeringScore')
        with self.assertRaises(ValueError):
            conference.MODULE.score_line(missing)
        self.assertNotIn('工程/实践', publisher.format_complete_score_line(missing))

    def test_prefix_projection_is_exact_idempotent_and_preserves_protected_bytes(self):
        project = presentation.normalize_repeated_bold_prefixes
        for raw, expected in (
            ('**分工：** **分工：**解释', '**分工：** 解释'),
            ('**分工：**\t** 分工：** **分工：** 解释', '**分工：** 解释'),
            ('**A:** **A:** x', '**A:** x'),
            ('**分工：** **其它：**解释', '**分工：** **其它：**解释'),
            ('**分工：**\n**分工：**解释', '**分工：**\n**分工：**解释'),
        ):
            with self.subTest(raw=raw):
                self.assertEqual(project(raw), expected)
                self.assertEqual(project(project(raw)), expected)
        duplicate = '**分工：** **分工：**解释'
        protected = [f'`{duplicate}`', f'`` `{duplicate}` ``', f'`{duplicate}',
                     f'```python\n{duplicate}\n```\n', f'~~~text\n{duplicate}\n~~~\n',
                     f'```\n```python\n{duplicate}\n', f'```\n{duplicate}',
                     f'~~~\n~~~oops\n{duplicate}\n',
                     f'![{duplicate}](https://example.org/a.png)',
                     f'[{duplicate}](https://example.org/source)',
                     f'*论文图 1。原论文 Figure 1：“{duplicate}”。*',
                     '> 原文引句：' + duplicate, '    ' + duplicate]
        for raw in protected:
            with self.subTest(protected=raw):
                self.assertEqual(project(raw), raw)
        # An info-string marker is not a closing fence; a real closing line is.
        self.assertEqual(project('```\n```python\n' + duplicate + '\n```\n' + duplicate),
                         '```\n```python\n' + duplicate + '\n```\n**分工：** 解释')

    def test_daily_numeric_and_source_cell_rules_keep_the_same_shared_prefix_projection(self):
        self.assertIs(conference.MODULE.normalize_repeated_bold_prefixes,
                      presentation.normalize_repeated_bold_prefixes)
        self.assertIs(historical.renderer.normalize_repeated_bold_prefixes,
                      presentation.normalize_repeated_bold_prefixes)
        for raw in ('| 1.06×\\times |', '| 1.060×\\times |', '| 1.06×\\times+1 |',
                    'x=2 x{=}2', '4.50 ± 0.20 4.50\\pm0.20'):
            projected = publisher._normalize_api_reader_display_artifacts(raw)
            self.assertEqual(publisher._normalize_api_reader_display_artifacts(projected), projected)
        self.assertEqual(publisher._normalize_api_reader_display_artifacts('| 1.06×\\times |'), '| 1.06× |')
        self.assertEqual(publisher._normalize_api_reader_display_artifacts('| 1.06×\\times+1 |'), '| 1.06×\\times+1 |')
        self.assertEqual(publisher._normalize_api_reader_display_artifacts('**分工：** **分工：**解释'), '**分工：** 解释')
        raw = '`**分工：** **分工：**解释`'
        self.assertEqual(publisher._normalize_api_reader_display_artifacts(raw), raw)
        self.assertEqual(publisher._normalize_api_reader_source_cell('**分工：** **分工：**解释'),
                         publisher._normalize_api_reader_source_cell('**分工：** 解释'))

    def test_both_conference_renderers_project_only_the_view_not_saved_reader(self):
        duplicate = '**组件分工：** **组件分工：** 同一原始说明。'
        packet = conference.ConferencePageRenderTest().packet()
        packet['paper']['apiReaderArticle'] += '\n\n' + duplicate
        digest = hashlib.sha256(packet['paper']['apiReaderArticle'].encode()).hexdigest()
        packet['paper']['apiReaderArticleSha256'] = digest
        packet['paper']['analysisManifest']['stages']['apiReaderArticle']['articleSha256'] = digest
        before = copy.deepcopy(packet)
        actual = conference.MODULE.render_packet(packet)['markdown']
        self.assertIn('**组件分工：** 同一原始说明。', actual)
        self.assertNotIn(duplicate, actual)
        self.assertEqual(packet, before)
        paper = historical_conference_paper()
        paper['apiReaderArticle'] += '\n\n' + duplicate
        paper['apiReaderArticleSha256'] = hashlib.sha256(paper['apiReaderArticle'].encode()).hexdigest()
        paper['analysisManifest']['stages']['apiReaderArticle']['articleSha256'] = paper['apiReaderArticleSha256']
        before = copy.deepcopy(paper)
        actual = historical.renderer.render_packet({
            'directStaging': True, 'paper': paper, 'cohortDate': '2026-09-04'})['markdown']
        self.assertIn('**组件分工：** 同一原始说明。', actual)
        self.assertNotIn(duplicate, actual)
        self.assertEqual(paper, before)

    def test_both_workbench_builders_use_the_same_four_file_records(self):
        paper = llm_api_publication_fixture()
        official = conference.ConferencePageRenderTest().packet()['paper']
        parsed = {**official['parsed'], 'primaryTaskTag': '#语音识别', 'primaryMethodTag': '#Transformer'}
        with mock.patch.object(publisher, '_workbench_sidecar_records',
                               wraps=publisher._workbench_sidecar_records) as shared:
            daily = publisher.build_researcher_workbench_bundle(paper, '2026-09-04',
                parsed=paper['parsed'], api_reader_payload=publisher._api_reader_payload(paper), require_reader=True)
            meeting = publisher.build_verified_conference_workbench_bundle(official, '2026-09-04',
                paper_id=official['conferencePaperId'], publication=official['conferencePublication'],
                reader_plan=official['apiReaderPlan'], parsed=parsed, authors=official['apiReaderAuthors']['authors'])
        self.assertEqual(shared.call_count, 2)
        for bundle in (daily, meeting):
            self.assertEqual(set(bundle['sidecarRecords']), set(publisher.RESEARCHER_SIDECAR_FILENAMES))
            for relative, raw in bundle['sidecars'].items():
                record = bundle['sidecarRecords'][relative.name]
                self.assertEqual(record['sha256'], hashlib.sha256(raw).hexdigest())
                self.assertEqual(record['url'], publisher._researcher_public_url(relative))
        self.assertIn('arxivId', json.loads(daily['sidecars'][next(p for p in daily['sidecars'] if p.name == 'citation.json')]))
        self.assertNotIn('arxivId', json.loads(meeting['sidecars'][next(p for p in meeting['sidecars'] if p.name == 'citation.json')]))

    def test_four_file_record_builder_rejects_bad_bytes_and_incomplete_names(self):
        root = Path('static/data/papers/2026-09-04/test')
        files = {root / name: b'{}\n' for name in publisher.RESEARCHER_SIDECAR_FILENAMES}
        before = copy.deepcopy(files)
        legacy = publisher._workbench_sidecar_records(files, context_contract=publisher.LEGACY_RESEARCH_CONTEXT_CONTRACT)
        self.assertNotIn('contract', legacy['rethink-context.json'])
        for bad in (b'', b'{}', b'{}\r\n', b'\xff\n', b'x' * publisher.RESEARCHER_SIDECAR_MAX_BYTES + b'\n'):
            broken = dict(files); broken[root / 'citation.json'] = bad
            with self.subTest(raw=bad[:10]), self.assertRaises(ValueError):
                publisher._workbench_sidecar_records(broken, context_contract=publisher.RESEARCH_CONTEXT_CONTRACT)
        broken = dict(files); broken.pop(root / 'citation.bib')
        with self.assertRaises(ValueError):
            publisher._workbench_sidecar_records(broken, context_contract=publisher.RESEARCH_CONTEXT_CONTRACT)
        self.assertEqual(files, before)

    def test_review_protocol_reads_shared_presentation_leaf_and_changes_with_its_bytes(self):
        original = publisher._sha256_file
        with mock.patch.object(publisher, 'blog_runtime_fingerprint', return_value='a' * 64), \
                mock.patch.object(publisher, '_run_bounded_subprocess', return_value=SimpleNamespace(
                    returncode=0, timed_out=False, stdout='hugo fixture\n')), \
                mock.patch.dict(publisher._REVIEW_PROTOCOL_CACHE, {}, clear=True), \
                mock.patch.object(publisher, '_sha256_file', wraps=original) as reads:
            expected = publisher.review_protocol_fingerprint()
            scripts = Path(publisher.__file__).resolve().parent
            paths = [Path(call.args[0]) for call in reads.call_args_list]
            self.assertIn(scripts / 'paper_reader_presentation.py', paths)
            with tempfile.TemporaryDirectory() as directory:
                isolated = Path(directory) / 'scripts'
                for source in paths:
                    if source.is_relative_to(scripts):
                        target = isolated / source.relative_to(scripts)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(source.read_bytes())
                with mock.patch.object(publisher, '__file__', str(isolated / 'publish-to-blog.py')):
                    self.assertEqual(publisher.review_protocol_fingerprint(), expected)
                    target = isolated / 'paper_reader_presentation.py'
                    before = target.read_bytes()
                    target.write_bytes(before + b'\n# controlled leaf mutation\n')
                    self.assertNotEqual(publisher.review_protocol_fingerprint(), expected)
                    target.write_bytes(before)
                    self.assertEqual(publisher.review_protocol_fingerprint(), expected)

    def test_readonly_unit_does_not_accept_changed_proposals_or_silent_false(self):
        self.assertIs(publisher.interpret_readonly_text_unit, common.interpret_readonly_text_unit)
        self.assertIs(history_review.MODULE.interpret_readonly_text_unit, common.interpret_readonly_text_unit)
        self.assertIs(conference_review.M.interpret_readonly_text_unit, common.interpret_readonly_text_unit)
        warning = {'severity': 'warning', 'description': 'localized suggestion'}
        original = copy.deepcopy(warning)
        passed, issues, proposed = common.interpret_readonly_text_unit('original', (True, [warning], 'changed'))
        self.assertFalse(passed); self.assertEqual(proposed, 'changed')
        self.assertEqual(issues[0], original)
        self.assertEqual(issues[-1]['type'], 'readonly_change')
        self.assertEqual(common.classify_review_failure(issues), 'content')
        self.assertEqual(warning, original)
        for result in ((False, [], 'original'), (True, [], None), (1, [], 'original'), (True,)):
            passed, issues, _proposed = common.interpret_readonly_text_unit('original', result)
            self.assertFalse(passed)
            self.assertGreater(common.count_blocking_review_issues(issues), 0)
            self.assertEqual(common.classify_review_failure(issues), 'transient')
        self.assertEqual(common.interpret_readonly_text_unit('original', (True, [], 'original')),
                         (True, [], 'original'))

    def test_daily_and_history_actual_wrappers_block_a_changed_proposal_without_writing(self):
        content = '正文原字节。'
        response = (True, [{'severity': 'warning', 'description': 'localized suggestion'}], 'PROPOSED-PRIVATE')
        with mock.patch.object(publisher, '_llm_review_post_chunk', return_value=response), \
                mock.patch.object(publisher, 'split_review_content', return_value=[content]):
            passed, issues, _view = publisher.llm_review_post(content, required=True)
        self.assertFalse(passed)
        self.assertTrue(any(issue.get('type') == 'readonly_change' for issue in issues))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); target = root / 'page.md'
            target.write_text(content)
            model = history_review.FakePublisher()
            with mock.patch.object(model, '_llm_review_post_chunk', return_value=response):
                result = history_review.MODULE.review_page(model,
                    {'path': 'page.md', 'sha256': hashlib.sha256(content.encode()).hexdigest()},
                    root, root / 'audits', {'protocolSha256': 'a' * 64})
            self.assertFalse(result['passed'])
            self.assertEqual(target.read_text(), content)
            self.assertFalse(list((root / 'audits').glob('*.json')) == [])
            for filename in (root / 'audits').glob('*.json'):
                self.assertNotIn('PROPOSED-PRIVATE', filename.read_text())


if __name__ == '__main__':
    unittest.main()
