import copy
import hashlib
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_publish_to_blog import publish_to_blog as blog, llm_api_publication_fixture


def author_fixture(names):
    paper = llm_api_publication_fixture()
    paper['authors'] = list(names)
    raw = paper['apiReaderAuthors']
    identity = raw['identity']
    identity['metadataSha256'] = blog._stable_json_sha256(names)
    original = identity['authors'][0]
    identity['authors'] = []
    raw['authors'] = []
    for name in names:
        bound = copy.deepcopy(original)
        bound['name'] = name
        bound['nameBinding'] = {'sourceKind': 'paper_metadata', 'sourceValue': name,
                               'metadataSha256': identity['metadataSha256']}
        identity['authors'].append(bound)
        raw['authors'].append({'name': name, 'affiliations': list(bound['affiliations'])})
    reseal_author(paper)
    return paper


def reseal_author(paper):
    raw = paper['apiReaderAuthors']
    raw['identitySha256'] = blog._stable_json_sha256(raw['identity'])
    stage = paper['analysisManifest']['stages']['apiReaderArticle']
    stage['readerAuthorIdentitySha256'] = raw['identitySha256']
    stage['readerAuthorsSha256'] = blog._stable_json_sha256(raw)


class PublicationSourceDisplayTests(unittest.TestCase):
    def test_author_metadata_projection_preserves_original_identity_and_citations(self):
        paper = author_fixture(['Researcher A', ':', 'Researcher B'])
        original = copy.deepcopy(paper)
        payload = {'contract': blog.LLM_API_READER_CONTRACT, 'readerAuthors': paper['apiReaderAuthors']}
        view = blog._api_reader_author_display(paper, payload)
        self.assertEqual([a['name'] for a in view['authors']], ['Researcher A', 'Researcher B'])
        self.assertEqual(view['originalCount'], 3)
        self.assertEqual(view['omittedSourceIndices'], [1])
        self.assertIn('1 项仅为分隔标点', view['sourceNote'])
        self.assertEqual(blog._workbench_authors(paper, payload), view['authors'])
        self.assertIn(view['sourceNote'], blog._render_api_reader_author_block(paper, payload))
        self.assertEqual(paper, original)

    def test_author_forged_metadata_or_changed_payload_rejected(self):
        paper = author_fixture(['Researcher A', ':'])
        paper['authors'] = ['Researcher A']
        raw = paper['apiReaderAuthors']
        raw['identity']['metadataSha256'] = blog._stable_json_sha256(paper['authors'])
        for author in raw['identity']['authors']:
            author['nameBinding']['metadataSha256'] = raw['identity']['metadataSha256']
        reseal_author(paper)
        payload = {'contract': blog.LLM_API_READER_CONTRACT, 'readerAuthors': raw}
        with self.assertRaises(blog.PublishDataValidationError):
            blog._api_reader_author_display(paper, payload)
        changed = copy.deepcopy(payload)
        changed['readerAuthors']['authors'][0]['name'] = 'Invented person'
        with self.assertRaises(blog.PublishDataValidationError):
            blog._api_reader_author_display(paper, changed)

    def test_all_separators_show_unavailable_but_citation_fails_closed(self):
        paper = author_fixture([':'])
        payload = {'contract': blog.LLM_API_READER_CONTRACT, 'readerAuthors': paper['apiReaderAuthors']}
        self.assertEqual(blog._api_reader_author_display(paper, payload)['authors'], [])
        self.assertIn('可靠披露', blog._render_api_reader_author_block(paper, payload))
        with self.assertRaises(blog.PublishDataValidationError):
            blog._workbench_authors(paper, payload)

    def test_current_reader_citation_missing_raw_authors_never_falls_back(self):
        paper = author_fixture(['Researcher A'])
        for raw in (None, [], 'untrusted', {}):
            payload = {'contract': blog.LLM_API_READER_CONTRACT, 'readerAuthors': raw}
            with self.subTest(raw=raw):
                with self.assertRaises(blog.PublishDataValidationError):
                    blog._workbench_authors(paper, payload)
        self.assertEqual(blog._workbench_authors(paper),
                         [{'name': 'Researcher A', 'affiliations': []}])

    def test_only_complete_exact_resources_deduplicate_without_mutation(self):
        paper = llm_api_publication_fixture()
        payload = blog._api_reader_payload(paper)
        resource = payload['resourceIdentityProof']['resources'][0]
        payload['resourceIdentityProof']['resources'] = [resource, copy.deepcopy(resource)]
        before = copy.deepcopy(payload)
        output = blog._build_api_reader_display_fields(paper, payload)['opensource']
        self.assertEqual(output.count('- 代码相关资源：'), 1)
        self.assertEqual(payload, before)
        for field, value in [('type', 'dataset'), ('availability', 'temporarily_unreachable'),
                             ('sourceQuote', 'A different source quote.'), ('status', 204),
                             ('documentationEvidence', {'completeness': 'complete'}),
                             ('additionalEvidence', 'different')]:
            with self.subTest(field=field):
                other = copy.deepcopy(resource)
                other[field] = value
                payload['resourceIdentityProof']['resources'] = [resource, other]
                output = blog._build_api_reader_display_fields(paper, payload)['opensource']
                self.assertEqual(sum(line.startswith('- ') for line in output.splitlines()), 2)

    def inline_fixture(self):
        raw = b'\x89PNG\r\n\x1a\ncontrolled pixel fixture'
        sha = hashlib.sha256(raw).hexdigest()
        url = 'https://arxiv.org/html/2610.00001v1/#S1.F1'
        figure = {'url': url, 'ordinal': 1, 'inlineSvgSourceSha256': 'a' * 64,
                  'inlineSvgRenderContract': 'sealed-inline-svg', 'assetSha256': sha}
        paper = {'arxivId': '2610.00001', 'apiReaderFigures': [figure]}
        filename = f'figure-1-{sha[:16]}.png'
        asset = {'generatedBytes': raw, 'sourceUrl': url, 'sha256': sha,
                 'destination': f'static/images/papers/2610.00001/{filename}',
                 'publicUrl': f'{blog.BASE_PATH.rstrip("/")}/images/papers/2610.00001/{filename}'}
        payload = {'figures': paper['apiReaderFigures'], 'assets': [asset]}
        return paper, payload, f'![Actual source alt]({url})'

    def test_inline_source_preview_uses_exact_pixel_with_original_locator(self):
        paper, payload, article = self.inline_fixture()
        before = copy.deepcopy((paper, payload))
        output = blog._index_figure_preview(paper, article, payload)
        self.assertEqual(output, f'[![原论文配图（完整图注与解读见独立文章）]({payload["assets"][0]["publicUrl"]})]({paper["apiReaderFigures"][0]["url"]})')
        self.assertEqual((paper, payload), before)
        self.assertEqual(blog._index_figure_preview({'apiReaderFigures': []}, '![plain](https://arxiv.org/html/x.png)'), '![原论文配图（完整图注与解读见独立文章）](https://arxiv.org/html/x.png)')

    def test_summary_marks_verified_pdf_page(self):
        paper, payload, article = self.inline_fixture()
        payload['assets'][0]['derivedAssetProof'] = {'displayLabel': '原论文 PDF 第 4 页（含图 2）'}
        with mock.patch.object(blog, '_api_reader_payload', return_value=copy.deepcopy(payload)):
            output = blog._index_figure_preview(paper, article, payload)
        self.assertIn('图片来源：原论文 PDF 第 4 页（含图 2）', output)
        self.assertIn(payload['assets'][0]['publicUrl'], output)
        for good_label in ['原论文 PDF 第 14 页（含图 S1）', '原论文 PDF 第 12 页（含图 A.1）']:
            payload['assets'][0]['derivedAssetProof'] = {'displayLabel': good_label}
            with mock.patch.object(blog, '_api_reader_payload', return_value=copy.deepcopy(payload)):
                supp_output = blog._index_figure_preview(paper, article, payload)
            self.assertIn(f'图片来源：{good_label}', supp_output)
        for bad_label in ['不明来源', '原论文 PDF 第 14 页（含图 S0）', '原论文 PDF 第 14 页（含图 s1）', '原论文 PDF 第 1\u0660 页（含图 S1\u0660）']:
            payload['assets'][0]['derivedAssetProof']['displayLabel'] = bad_label
            with mock.patch.object(blog, '_api_reader_payload', return_value=copy.deepcopy(payload)):
                with self.assertRaises(blog.PublishDataValidationError):
                    blog._index_figure_preview(paper, article, payload)

    def test_inline_missing_ambiguous_and_tampered_asset_rejected(self):
        paper, payload, article = self.inline_fixture()
        variants = []
        empty = copy.deepcopy(payload); empty['assets'] = []; variants.append(empty)
        duplicate = copy.deepcopy(payload); duplicate['assets'] *= 2; variants.append(duplicate)
        for field, value in [('generatedBytes', b'\x89PNG\r\n\x1a\nchanged'), ('sha256', 'b' * 64),
                             ('destination', 'static/images/elsewhere.png'), ('publicUrl', 'https://evil.example/image.png'),
                             ('sourceUrl', 'https://arxiv.org/html/other#figure')]:
            bad = copy.deepcopy(payload); bad['assets'][0][field] = value; variants.append(bad)
        for bad in variants:
            with self.assertRaises(blog.PublishDataValidationError):
                blog._index_figure_preview(paper, article, bad)

    def test_summary_uses_neutral_alt_without_truncating_a_qualified_source_claim(self):
        # Real 2610.20327 source Figure 2 caption: the qualification and dagger
        # distinguish author-run systems from the lower self-reported result.
        url = 'https://arxiv.org/html/2610.20327v2/fig_leaderboard.svg'
        caption = ('Figure 2: Anuvani-Diarization is the most accurate of all systems we ran on IndicDiarBench. '
                   'Duration weighted DER on all 1,164 recordings (zero collar, overlap scored). '
                   '†Joint transcription and diarization services reported by the benchmark’s authors '
                   '(Mehendale et al., 2026); all others were run under our protocol (Table 3).')
        figure = {'ordinal': 2, 'label': 'Figure 2:', 'caption': caption, 'url': url}
        paper = {'arxivId': '2610.20327v2', 'apiReaderFigures': [figure]}
        article = (f'![原论文 Figure 2：{caption.split(". ")[0]}.]({url})\n\n'
                   '本文系统是作者亲手跑过的系统里最好的，但并不是所有文献数字里最低的。')
        before = copy.deepcopy((paper, article))
        output = blog._index_figure_preview(paper, article)
        self.assertEqual(output, f'![原论文配图（完整图注与解读见独立文章）]({url})')
        self.assertNotIn('most accurate', output)
        self.assertNotIn('Figure 2', output)
        self.assertEqual((paper, article), before)

    def test_legacy_caption_star_projection_is_full_note_and_adjacent_source_bound(self):
        figure = {'ordinal': 1, 'label': 'Figure 1:', 'url': 'https://arxiv.org/html/x.png',
                  'caption': r'Figure 1: Guidance scales with \beta_{*}; p < 0.05 *.'}
        note = '*论文图 1。原论文 Figure 1:：“Guidance scales with \\beta_一个星号; p < 0.05 一个星号.”。*'
        original = f'正文中的 beta_一个星号 保留。\n\n![source](https://arxiv.org/html/x.png)\n\n{note}\n\n后文一个星号。'
        result = blog.render_ephemeral_api_reader_figures(original, [figure])
        self.assertIn(r'`\beta_{*}`', result)
        self.assertIn('p < 0.05 一个星号', result)
        self.assertIn('正文中的 beta_一个星号 保留', result)
        self.assertEqual(blog.render_ephemeral_api_reader_figures(result, [figure]), result)
        hidden = f'```markdown\nexample\n\n![source](https://arxiv.org/html/x.png)\n\n{note}\n\n```\n\n'
        protected_result = blog.render_ephemeral_api_reader_figures(hidden + original, [figure])
        self.assertTrue(protected_result.startswith(hidden))
        self.assertEqual(protected_result[len(hidden):], result)
        self.assertEqual(blog._source_bound_figure_math_note(note.replace('0.05', '0.99'), figure), note.replace('0.05', '0.99'))
        missing = dict(figure, caption='Figure 1: Guidance scales without a math star.')
        self.assertEqual(blog._source_bound_figure_math_note(note, missing), note)

    def test_legacy_caption_spacing_command_star_is_exact_source_bound(self):
        figure = {'ordinal': 3, 'label': 'Figure 3:',
                  'caption': r'Figure 3: Residual source-language LID mass at \lambda^{\!*}=0.33.'}
        note = '*论文图 3。原论文 Figure 3:：“Residual source-language LID mass at \\lambda^\\!一个星号=0.33.”。*'
        result = blog._source_bound_figure_math_note(note, figure)
        self.assertIn(r'`\lambda^{\!*}`=0.33', result)
        self.assertEqual(blog._source_bound_figure_math_note(result, figure), result)
        self.assertEqual(blog._source_bound_figure_math_note(note.replace('0.33', '0.34'), figure),
                         note.replace('0.33', '0.34'))
        other = dict(figure, caption=figure['caption'].replace(r'\!', r'\quad'))
        self.assertEqual(blog._source_bound_figure_math_note(note, other), note)

    def test_parenthesized_signed_scalar_double_write_folds_only_exact_signed_copy(self):
        positives = [
            ('46.4 (−1.4)(-1.4)', '46.4 (−1.4)'),
            ('57.5 (−0.8)(-0.8)', '57.5 (−0.8)'),
            ('47.9 (+0.2)(+0.2)', '47.9 (+0.2)'),
            ('(-1.4)(-1.4)', '(-1.4)'),
            ('(-1.4)(−1.4)', '(-1.4)'),
            ('(+9.9%)(+9.9%)', '(+9.9%)'),
            ('(−1.4%)(-1.4%)', '(−1.4%)'),
            ('Non-native (−15)(-15); background (−30)(-30)', 'Non-native (−15); background (−30)'),
            ('[fig](https://example.test/fig-2-2.png) 46.4 (−1.4)(-1.4)', '[fig](https://example.test/fig-2-2.png) 46.4 (−1.4)'),
        ]
        for raw, expected in positives:
            with self.subTest(raw=raw):
                self.assertEqual(blog._collapse_mathjax_double_write(raw), expected)
                self.assertEqual(blog._collapse_mathjax_double_write(expected), expected)
                self.assertEqual(blog._normalize_api_reader_display_artifacts(raw), expected)
                self.assertEqual(blog._normalize_api_reader_display_artifacts(expected), expected)
                self.assertEqual(blog._project_reader_cell_tex_display(raw), expected)
                self.assertEqual(blog._project_reader_cell_tex_display(expected), expected)
                self.assertEqual(blog._reader_cell_comparison(raw), blog._reader_cell_comparison(expected))
                self.assertEqual(blog._normalize_api_reader_source_cell(raw),
                                 blog._normalize_api_reader_source_cell(expected))

        negatives = [
            '46.4 (−1.4)(-0.8)',
            '46.4 (+1.4)(-1.4)',
            '46.4 (-1.4)(+1.4)',
            '(1.4)(1.4)',
            '46.4 (1.4)(1.4)',
            '(1.40)(-1.4)',
            '(−1.40)(-1.4)',
            '(-1.4)(-1.40)',
            '(−1.4%)(-1.4)',
            '(−1.4)(-1.4%)',
            '[text](-1.4)',
            '[text](-1.4)(-1.4)',
            '[text](https://example.test/(-1.4)(-1.4))',
            'https://example.test/(-1.4)(-1.4)',
            'f(-1.4)(-1.4)',
            '2(-1.4)(-1.4)',
            '𝑓(-1.4)(-1.4)',
            '𝟐(-1.4)(-1.4)',
            '(-1.4)(-1.4)𝑓',
            '(-1.4)(-1.4)𝟐',
            '(-1.4)(-1.4).𝟐',
            '(−１.４)(-１.４)',
            '(−١.٤)(-١.٤)',
            '(-1.4)(-1.4)^2',
            '(-1.4)(-1.4)_i',
            '(-1.4)(-1.4)(+0.2)',
            '1+(-1.4)(-1.4)',
        ]
        for raw in negatives:
            with self.subTest(raw=raw):
                self.assertEqual(blog._collapse_mathjax_double_write(raw), raw)
                self.assertEqual(blog._normalize_api_reader_display_artifacts(raw), raw)
                self.assertEqual(blog._project_reader_cell_tex_display(raw), raw)
        self.assertEqual(blog._collapse_mathjax_double_write(r'\(-1.4\)(-1.4)'), r'\(-1.4\)(-1.4)')
        self.assertEqual(blog._normalize_api_reader_display_artifacts(r'\(-1.4\)(-1.4)'), r'\(-1.4\)(-1.4)')

    def test_leading_empty_reference_link_cell_prefix_projection_and_guards(self):
        positives = [
            ('[][] VideoLLaMA2-AV+PACD', 'VideoLLaMA2-AV+PACD'),
            ('[][] OmniVinci+PACD', 'OmniVinci+PACD'),
            ('  [][] VideoLLaMA2-AV+PACD', 'VideoLLaMA2-AV+PACD'),
            ('[][]\tOmniVinci+PACD', 'OmniVinci+PACD'),
            ('[][] Model (−1.4)(-1.4)', 'Model (−1.4)'),
        ]
        for raw, expected in positives:
            with self.subTest(raw=raw):
                self.assertEqual(blog._project_reader_cell_tex_display(raw), expected)
                self.assertEqual(blog._project_reader_cell_tex_display(expected), expected)
                self.assertEqual(blog._reader_cell_comparison(raw), blog._reader_cell_comparison(expected))

        b3_negatives = [
            ('[][]', '[][]'),
            ('[][]   ', '[][]   '),
            ('[][] \u200b', '[][] \u200b'),
            ('[][] ()', '[][]'),
            (r'[][] \(\)', '[][] '),
            (r'[][] \,', '[][] '),
            (r'[][] \;', '[][] '),
            ('[][] \\(\u200b\\)', '[][] \u200b'),
            (r'[][] (\,)', '[][]'),
            (r'[][] (\,) [][] foo', '[][] [][] foo'),
            (r'[][] \(\) [][] foo', '[][]  [][] foo'),
            ('foo [][] bar', 'foo [][] bar'),
            ('foo; [][] bar', 'foo; [][] bar'),
            (r'foo; [][] bar\uparrow', 'foo; [] bar↑'),
            ('[a][b] foo', '[a][b] foo'),
            ('[x][] foo', '[x][] foo'),
            ('[][y] foo', '[][y] foo'),
            ('[][] [][] foo', '[][] [][] foo'),
        ]
        for raw, expected in b3_negatives:
            with self.subTest(raw=raw):
                actual = blog._project_reader_cell_tex_display(raw)
                self.assertEqual(actual, expected)
                self.assertEqual(blog._project_reader_cell_tex_display(actual), actual)
                self.assertEqual(blog._reader_cell_comparison(actual), blog._reader_cell_comparison(raw))
                self.assertTrue(actual.strip('\u200b\u200c\u200d\u2060\ufeff \t\r\n'))
                guard_article = f'| Col | Val |\n| --- | --- |\n| {raw.strip()} | 1.0 |\n'
                guard_plan = {
                    'tableBindings': [{
                        'tableIndex': 1,
                        'sourceType': 'artifact_table',
                        'sourceTableOrdinal': 1,
                        'cellBindings': [
                            {'renderedRow': 0, 'renderedColumn': 0, 'sourceText': 'Col'},
                            {'renderedRow': 0, 'renderedColumn': 1, 'sourceText': 'Val'},
                            {'renderedRow': 1, 'renderedColumn': 0, 'sourceText': raw},
                            {'renderedRow': 1, 'renderedColumn': 1, 'sourceText': '1.0'},
                        ],
                    }],
                }
                blog._project_artifact_table_cell_tex_display(guard_article, guard_plan)
        self.assertNotEqual(blog._reader_cell_comparison('[][]'), blog._reader_cell_comparison(''))
        self.assertNotEqual(blog._reader_cell_comparison(r'[][] \(\)'), blog._reader_cell_comparison(''))
        self.assertNotEqual(blog._reader_cell_comparison(r'[][] \,'), blog._reader_cell_comparison(''))
        self.assertNotEqual(blog._reader_cell_comparison(r'[][] (\,)'), blog._reader_cell_comparison(''))

        article = (
            '### 对比结果\n\n'
            '| Model | World | Daily |\n'
            '| --- | --- | --- |\n'
            '| [][] VideoLLaMA2-AV+PACD | 46.4 (−1.4)(-1.4) | 47.9 (+0.2)(+0.2) |\n'
            '| [][] OmniVinci+PACD | 57.5 (−0.8)(-0.8) | 58.1 (−0.2)(-0.2) |\n'
        )
        plan = {
            'tableBindings': [{
                'tableIndex': 1,
                'sourceType': 'artifact_table',
                'sourceTableOrdinal': 4,
                'cellBindings': [
                    {'renderedRow': 0, 'renderedColumn': 0, 'sourceText': 'Model'},
                    {'renderedRow': 0, 'renderedColumn': 1, 'sourceText': 'World'},
                    {'renderedRow': 0, 'renderedColumn': 2, 'sourceText': 'Daily'},
                    {'renderedRow': 1, 'renderedColumn': 0, 'sourceText': '[][] VideoLLaMA2-AV+PACD'},
                    {'renderedRow': 1, 'renderedColumn': 1, 'sourceText': '46.4 (−1.4)(-1.4)'},
                    {'renderedRow': 1, 'renderedColumn': 2, 'sourceText': '47.9 (+0.2)(+0.2)'},
                    {'renderedRow': 2, 'renderedColumn': 0, 'sourceText': '[][] OmniVinci+PACD'},
                    {'renderedRow': 2, 'renderedColumn': 1, 'sourceText': '57.5 (−0.8)(-0.8)'},
                    {'renderedRow': 2, 'renderedColumn': 2, 'sourceText': '58.1 (−0.2)(-0.2)'},
                ],
            }],
        }
        plan_before = copy.deepcopy(plan)
        projected = blog._project_artifact_table_cell_tex_display(article, plan)
        self.assertEqual(plan, plan_before)
        self.assertNotIn('[][]', projected)
        self.assertIn('| VideoLLaMA2-AV+PACD | 46.4 (−1.4) | 47.9 (+0.2) |', projected)
        self.assertIn('| OmniVinci+PACD | 57.5 (−0.8) | 58.1 (−0.2) |', projected)

        mismatched = copy.deepcopy(plan)
        mismatched['tableBindings'][0]['cellBindings'][3]['sourceText'] = '[][] OtherModel'
        with self.assertRaises(blog.PublishDataValidationError):
            blog._project_artifact_table_cell_tex_display(article, mismatched)

    def test_leading_booktabs_rule_cell_prefix_projection_and_guards(self):
        positives = [
            (r'\topruleCodebook', 'Codebook'),
            (r'\midrule1', '1'),
            (r'\bottomrule', ''),
            (r'  \bottomrule  ', ''),
            (r'\toprule Codebook', 'Codebook'),
            ('  \\midrule\t1', '1'),
            (r'\midruleModel (−1.4)(-1.4)', 'Model (−1.4)'),
        ]
        for raw, expected in positives:
            with self.subTest(raw=raw):
                self.assertEqual(blog._project_reader_cell_tex_display(raw), expected)
                self.assertEqual(blog._project_reader_cell_tex_display(expected), expected)
                self.assertEqual(blog._reader_cell_comparison(raw), blog._reader_cell_comparison(expected))

        negatives = [
            r'foo \toprule bar',
            r'\top x',
            r'\mid',
            r'\bot',
            r'\toprule_1',
            r'\midrule^2',
            r'\bottomrule{x}',
            r'\toprule {x}',
            r'\toprule\midrule1',
            r'\toprule \midrule 1',
            r'\bottomrule\bottomrule',
            r'\toprule \,',
            r'\toprule (\,)',
            r'\toprule (\,) \toprule foo',
            '\\toprule \u200b',
            r'\mathrm{Acc}',
            r'\hlineCodebook',
        ]
        for raw in negatives:
            with self.subTest(raw=raw):
                actual = blog._project_reader_cell_tex_display(raw)
                self.assertEqual(blog._project_reader_cell_tex_display(actual), actual)
                self.assertEqual(blog._reader_cell_comparison(actual), blog._reader_cell_comparison(raw))
                self.assertTrue(actual.startswith('\\') or '\\' in actual)

        article = (
            '#### 性别排他率定位偏置来源\n\n'
            '| \\topruleCodebook | Total Tokens | Exclusive Tokens | ratio |\n'
            '| --- | --- | --- |\n'
            '| \\midrule1 | 858 | 265 | 30.90% |\n'
            '| 2 | 1,641 | 362 | 22.10% |\n'
            '| \\bottomrule |  |  |  |\n'
        ).replace('| --- | --- | --- |', '| --- | --- | --- | --- |')
        plan = {
            'tableBindings': [{
                'tableIndex': 1,
                'sourceType': 'artifact_table',
                'sourceTableOrdinal': 3,
                'cellBindings': [
                    {'renderedRow': 0, 'renderedColumn': 0, 'sourceText': r'\topruleCodebook'},
                    {'renderedRow': 0, 'renderedColumn': 1, 'sourceText': 'Total Tokens'},
                    {'renderedRow': 0, 'renderedColumn': 2, 'sourceText': 'Exclusive Tokens'},
                    {'renderedRow': 0, 'renderedColumn': 3, 'sourceText': 'ratio'},
                    {'renderedRow': 1, 'renderedColumn': 0, 'sourceText': r'\midrule1'},
                    {'renderedRow': 1, 'renderedColumn': 1, 'sourceText': '858'},
                    {'renderedRow': 1, 'renderedColumn': 2, 'sourceText': '265'},
                    {'renderedRow': 1, 'renderedColumn': 3, 'sourceText': '30.90%'},
                    {'renderedRow': 2, 'renderedColumn': 0, 'sourceText': '2'},
                    {'renderedRow': 2, 'renderedColumn': 1, 'sourceText': '1,641'},
                    {'renderedRow': 2, 'renderedColumn': 2, 'sourceText': '362'},
                    {'renderedRow': 2, 'renderedColumn': 3, 'sourceText': '22.10%'},
                    {'renderedRow': 3, 'renderedColumn': 0, 'sourceText': r'\bottomrule'},
                    {'renderedRow': 3, 'renderedColumn': 1, 'sourceText': ''},
                    {'renderedRow': 3, 'renderedColumn': 2, 'sourceText': ''},
                    {'renderedRow': 3, 'renderedColumn': 3, 'sourceText': ''},
                ],
            }],
        }
        plan_before = copy.deepcopy(plan)
        projected = blog._project_artifact_table_cell_tex_display(article, plan)
        self.assertEqual(plan, plan_before)
        blog._assert_rendered_tables_have_no_bare_tex(projected)
        self.assertIn('| Codebook | Total Tokens | Exclusive Tokens | ratio |', projected)
        self.assertIn('| 1 | 858 | 265 | 30.90% |', projected)
        self.assertIn('|  |  |  |  |', projected)

        tampered = copy.deepcopy(plan)
        tampered['tableBindings'][0]['cellBindings'][0]['sourceText'] = r'\topruleOther'
        with self.assertRaises(blog.PublishDataValidationError):
            blog._project_artifact_table_cell_tex_display(article, tampered)


if __name__ == '__main__':
    unittest.main()
