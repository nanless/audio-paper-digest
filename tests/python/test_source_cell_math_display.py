import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest

ACTUAL = os.environ.get('PD_SOURCE_CELL_DISPLAY_ACTUAL') == '1'
from test_publish_to_blog import publish_to_blog as blog
from publish_common import strict_source_cell_math_display

ROOT = Path(__file__).resolve().parents[2]


class SourceCellMathDisplayTests(unittest.TestCase):
    def test_exact_zero_width_ms_duplicate_preserves_numeric_bytes_and_source_proof(self):
        for scalar in ('0.991', '1.290', '1.216', '9.760', '.5', '-0.50', '+1', '−2.0'):
            raw = scalar + '\u200bm\u200bs' + scalar + 'ms'
            with self.subTest(raw=raw):
                proof = strict_source_cell_math_display(raw)
                self.assertEqual(proof, {
                    'contract': 'source-cell-math-display-v1', 'kind': 'zero-width-unit-duplicate',
                    'sourceText': raw, 'sourceTextSha256': hashlib.sha256(raw.encode()).hexdigest(),
                    'displayText': scalar + ' ms'})
                self.assertIsNone(strict_source_cell_math_display(proof['displayText']))
        raw = '0.991\u200bm\u200bs0.991ms'
        for wrong in (
            '0.991ms0.991ms', '0.991 ms0.991ms',
            raw.replace('\u200b', '', 1), raw.replace('\u200b', '\u200b\u200b', 1),
            raw.replace('\u200b', '\u200c'), raw.replace('\u200b', '\ufeff'),
            raw.replace('0.991ms', '0.992ms'), raw.replace('0.991ms', '0.9910ms'),
            raw.replace('0.991ms', '.991ms'), raw.replace('ms', 's'),
            raw.replace('ms', 'MS'), raw.replace('ms', ' ms'),
            raw.replace('m\u200bs', 's\u200bm'), raw.replace('m\u200bs', 'm\u200bs\u200b'),
            raw.replace('m\u200bs', 'm\u200b s'),
            ' ' + raw, raw + ' ', raw + '\n', 'x=' + raw, raw + '+1',
            raw + '/2', raw + ' Hz', '`' + raw + '`', '**' + raw + '**',
            '[' + raw + '](https://example.org)', '<span>' + raw + '</span>',
        ):
            with self.subTest(wrong=wrong):
                self.assertIsNone(strict_source_cell_math_display(wrong))

    def test_zero_width_ms_view_requires_bound_whole_cell_and_protects_other_regions(self):
        raw = '0.991\u200bm\u200bs0.991ms'
        table = f'| Method | Time |\n| --- | --- |\n| A | {raw} |'
        article = ('正文 ' + raw + '\n\n`' + raw + '`\n\n'
                   '```text\n' + table + '\n```\n\n'
                   '> ' + table.replace('\n', '\n> ') + '\n\n'
                   '    ' + table.replace('\n', '\n    ') + '\n\n' + table)
        plan = {'tableBindings': [{'tableIndex': 1, 'sourceType': 'artifact_table', 'cellBindings': [
            {'renderedRow': 1, 'renderedColumn': 1, 'renderedText': raw, 'sourceText': raw}]}]}
        before = copy.deepcopy(plan)
        projected = blog._project_bound_source_cell_math_display(article, plan)
        self.assertEqual(projected, article[:-len(table)] + table.replace(raw, '0.991 ms'))
        self.assertEqual(plan, before)
        self.assertEqual(blog._project_bound_source_cell_math_display(article, {'tableBindings': []}), article)
        quotes = copy.deepcopy(plan); quotes['tableBindings'][0]['sourceType'] = 'source_quotes'
        self.assertEqual(blog._project_bound_source_cell_math_display(article, quotes), article)
        for field, value in [('sourceText', '0.992\u200bm\u200bs0.992ms'),
                             ('renderedText', '0.992\u200bm\u200bs0.992ms')]:
            wrong = copy.deepcopy(plan); wrong['tableBindings'][0]['cellBindings'][0][field] = value
            self.assertEqual(blog._project_bound_source_cell_math_display(article, wrong), article)

    def test_shared_real_and_negative_cell_fixtures(self):
        fixture = json.loads((ROOT / 'tests/fixtures/source-cell-math-display-cases.json').read_text())
        for item in fixture['cases']:
            with self.subTest(value=item['input']):
                proof = strict_source_cell_math_display(item['input'])
                self.assertEqual(proof['displayText'] if proof else None, item['displayText'])
                if proof:
                    self.assertEqual(proof['sourceText'], item['input'])
                    self.assertEqual(proof['sourceTextSha256'], hashlib.sha256(item['input'].encode()).hexdigest())
                    self.assertEqual(proof['kind'], item.get('proofKind', proof['kind']))

    def test_only_bound_whole_artifact_cell_is_projected_without_mutation(self):
        raw = '[22]8[2^{2}]^{8}'
        article = (f'正文 {raw} 保持。\n\n```text\n| Config | Value |\n| --- | --- |\n| {raw} | 2 |\n```\n\n'
                   f'| Config | Value |\n| --- | --- |\n| {raw} | 2 |\n')
        plan = {'tableBindings': [{'tableIndex': 1, 'sourceType': 'artifact_table', 'cellBindings': [
            {'renderedRow': 1, 'renderedColumn': 0, 'renderedText': raw, 'sourceText': raw}]}]}
        before = copy.deepcopy(plan)
        result = blog._project_bound_source_cell_math_display(article, plan)
        self.assertTrue(result.startswith(article.split('```\n\n')[0] + '```\n\n'))
        self.assertEqual(result.count(r'\([2^{2}]^{8}\)'), 1)
        self.assertEqual(plan, before)
        quote_plan = copy.deepcopy(plan); quote_plan['tableBindings'][0]['sourceType'] = 'source_quotes'
        self.assertEqual(blog._project_bound_source_cell_math_display(article, quote_plan), article)
        changed = article.rsplit(raw, 1)[0] + article.rsplit(raw, 1)[1].replace('| 2 |', '| 2 |', 1)
        with self.assertRaises(blog.PublishDataValidationError):
            blog._project_bound_source_cell_math_display(changed, plan)

    def test_final_binding_decoder_never_accepts_a_different_canonical_cell(self):
        from test_table_currency_unit_literals import TableCurrencyUnitLiteralTest
        for raw in ('[22]8[2^{2}]^{8}', r'0.5117±0.0042¯\underline{0.5117\pm 0.0042}',
                    '0.991\u200bm\u200bs0.991ms'):
            publisher, paper, reseal = TableCurrencyUnitLiteralTest().currency_source_fixture(raw)
            before = copy.deepcopy(paper)
            view = publisher._project_bound_source_cell_math_display(paper['apiReaderArticle'], paper['apiReaderPlan'])
            publisher._validate_api_reader_source_bindings(paper, article=view)
            self.assertEqual(paper, before)
            for field, value in (('sourceText', raw + ' ms'), ('renderedText', raw + ' ms'),
                                 ('sourceDomSha256', 'invalid')):
                bad = copy.deepcopy(paper)
                bad['apiReaderPlan']['tableBindings'][0]['cellBindings'][1][field] = value
                reseal(bad)
                with self.assertRaises(publisher.PublishDataValidationError):
                    publisher._validate_api_reader_source_bindings(bad, article=view)
            wrong = copy.deepcopy(paper)
            wrong['apiReaderPlan']['tableBindings'][0]['renderedTableSha256'] = 'a' * 64
            reseal(wrong)
            with self.assertRaises(publisher.PublishDataValidationError):
                publisher._validate_api_reader_source_bindings(wrong, article=view)

    @unittest.skipUnless(ACTUAL, 'requires the selected immutable real daily parent')
    def test_actual_revise_full_page_source_binding_markdown_and_hugo(self):
        formal = ROOT / 'data/current/deep-analysis-result.json'
        original_bytes = formal.read_bytes()
        data = json.loads(original_bytes)
        paper = next(p for p in data['papers'] if p['arxivId'] == '2610.19499v1')
        original = copy.deepcopy(paper)
        payload = blog._api_reader_payload(paper)
        self.assertEqual(payload['renderedArticle'].count(r'\([2^{2}]^{8}\)'), 6)
        self.assertEqual(payload['renderedArticle'].count(r'\([2^{4}]^{8}\)'), 6)
        self.assertNotIn('[22]8[2^{2}]^{8}', payload['renderedArticle'])
        self.assertNotIn('[24]8[2^{4}]^{8}', payload['renderedArticle'])
        blog._validate_api_reader_source_bindings(paper, article=payload['renderedArticle'])
        for wrong in (payload['renderedArticle'].replace(r'\([2^{2}]^{8}\)', r'\([2^{4}]^{8}\)', 1),
                      payload['renderedArticle'].replace('0.427', '0.428', 1)):
            with self.assertRaises(blog.PublishDataValidationError):
                blog._validate_api_reader_source_bindings(paper, article=wrong)
        # Rehashing local metadata cannot change a real sealed DOM cell.
        changed_source = copy.deepcopy(paper)
        cell = next(c for c in changed_source['apiReaderPlan']['tableBindings'][2]['cellBindings']
                    if c['sourceText'] == '[22]8[2^{2}]^{8}')
        cell['sourceText'] = '[24]8[2^{4}]^{8}'
        bindings_sha = blog._stable_json_sha256({
            'tableBindings': changed_source['apiReaderPlan']['tableBindings'],
            'formulaBindings': changed_source['apiReaderPlan']['formulaBindings']})
        changed_source['apiReaderPlan']['sourceBindingsSha256'] = bindings_sha
        changed_source['analysisManifest']['stages']['apiReaderArticle']['sourceBindingsSha256'] = bindings_sha
        with self.assertRaises(blog.PublishDataValidationError):
            blog._validate_api_reader_source_bindings(changed_source, article=payload['renderedArticle'])
        content, _slug = blog.generate_paper_page(paper, '2026-10-16')
        with tempfile.TemporaryDirectory(prefix='reader-math-view-') as directory:
            posts = Path(directory)
            page = posts / '2026-10-16-revise-tts-a-non-masking-refinement-framework-for-2610-19499.md'
            page.write_text(content)
            artifact = blog.build_final_page_artifact(page, paper)
            self.assertEqual(artifact['markdownFormatIssues'], [])
            self.assertIsNone(artifact['apiReaderIssue'])
            self.assertIsNone(artifact['manualIssue'])
            self.assertEqual(blog.run_hugo_gate(blog.BLOG_REPO, posts, required=True, source_paths=[page]), 'hugo')
        self.assertEqual(paper, original)
        self.assertEqual(formal.read_bytes(), original_bytes)


if __name__ == '__main__':
    unittest.main()
