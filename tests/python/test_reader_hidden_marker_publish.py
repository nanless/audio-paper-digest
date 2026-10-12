import copy
import json
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_publish_to_blog as fixture
publish = fixture.publish_to_blog


def wrap_hidden(value):
    return '<!--\n\n' + value + '\n\n-->'


class ReaderHiddenMarkerPublishTests(unittest.TestCase):
    def test_public_generation_refuses_hidden_concept_formula_and_figure(self):
        for kind in ['concept', 'formula', 'figure']:
            with self.subTest(kind=kind):
                paper = fixture.llm_api_ephemeral_figure_fixture() if kind == 'figure' else fixture.llm_api_publication_fixture()
                publish.generate_paper_page(paper, '2026-08-31')
                if kind == 'concept':
                    piece = paper['apiReaderPlan']['conceptBridges'][0]['explanation']
                elif kind == 'formula':
                    piece = publish._api_reader_display_formula_blocks(paper['apiReaderArticle'])[0]
                else:
                    figure = paper['apiReaderFigures'][0]
                    start = paper['apiReaderArticle'].index(figure['leadQuote'])
                    end = paper['apiReaderArticle'].index(figure['explanationQuote']) + len(figure['explanationQuote'])
                    piece = paper['apiReaderArticle'][start:end]
                paper['apiReaderArticle'] = paper['apiReaderArticle'].replace(piece, wrap_hidden(piece))
                fixture.reseal_llm_api_reader_fixture(paper)
                before = json.dumps(paper, sort_keys=True, ensure_ascii=False)
                with self.assertRaises(publish.PublishDataValidationError):
                    publish.generate_paper_page(paper, '2026-08-31')
                self.assertEqual(json.dumps(paper, sort_keys=True, ensure_ascii=False), before)

    def test_visible_quoted_concept_and_formula_remain_publishable(self):
        paper = fixture.llm_api_publication_fixture()
        concept = paper['apiReaderPlan']['conceptBridges'][0]['explanation']
        formula = publish._api_reader_display_formula_blocks(paper['apiReaderArticle'])[0]
        paper['apiReaderArticle'] = paper['apiReaderArticle'].replace(concept, '> ' + concept).replace(formula, '> ' + formula)
        fixture.reseal_llm_api_reader_fixture(paper)
        page, _ = publish.generate_paper_page(paper, '2026-08-31')
        self.assertIn(concept, page)
        self.assertIn(formula, page)

    def test_code_examples_do_not_add_formula_or_image_bindings(self):
        paper = fixture.llm_api_ephemeral_figure_fixture()
        url = paper['apiReaderFigures'][0]['url']
        example = '```text\n\\[x=1\\]\n![example](' + url + ')\n```'
        paper['apiReaderArticle'] += '\n\n' + example
        fixture.reseal_llm_api_reader_fixture(paper)
        publish.generate_paper_page(paper, '2026-08-31')
        self.assertEqual(len(publish._api_reader_display_formula_blocks(paper['apiReaderArticle'])), 1)
        self.assertEqual(publish._api_reader_article_image_urls(paper['apiReaderArticle']), [url])

    def test_partial_inline_concept_code_and_balanced_image_url_remain_valid(self):
        paper = fixture.llm_api_ephemeral_figure_fixture()
        bridge = paper['apiReaderPlan']['conceptBridges'][0]
        before = bridge['explanation']
        bridge['explanation'] = before.replace('术语 1A', '`术语 1A`', 1)
        paper['apiReaderArticle'] = paper['apiReaderArticle'].replace(before, bridge['explanation'])
        figure = paper['apiReaderFigures'][0]
        before_url = figure['url']
        figure['url'] = before_url.replace('figure-1.png', 'figure(1).png')
        paper['apiReaderArticle'] = paper['apiReaderArticle'].replace(before_url, figure['url'])
        paper['analysisManifest']['stages']['apiReaderArticle']['figuresSha256'] = publish._stable_json_sha256(paper['apiReaderFigures'])
        fixture.reseal_llm_api_reader_fixture(paper)
        publish.generate_paper_page(paper, '2026-08-31')
        self.assertEqual(publish._api_reader_article_image_urls(paper['apiReaderArticle']), [figure['url']])
        self.assertEqual(publish._api_reader_article_image_urls('`![example](' + figure['url'] + ')`'), [])

    def test_quoted_code_examples_do_not_add_formula_or_image_bindings(self):
        text = '> ```text\n> \\[x=1\\]\n> ![example](https://arxiv.org/figure(1).png)\n> ```'
        self.assertEqual(publish._api_reader_display_formula_blocks(text), [])
        self.assertEqual(publish._api_reader_article_image_urls(text), [])

    def test_visible_unregistered_http_and_relative_images_are_refused(self):
        for url in ['http://example.com/extra.png', 'extra.png']:
            with self.subTest(url=url):
                paper = fixture.llm_api_ephemeral_figure_fixture()
                paper['apiReaderArticle'] += '\n\n![未知](' + url + ')'
                fixture.reseal_llm_api_reader_fixture(paper)
                with self.assertRaisesRegex(publish.PublishDataValidationError, '图片 URL'):
                    publish.generate_paper_page(paper, '2026-08-31')

    def test_multiline_code_spans_hide_content_but_do_not_cross_blank_paragraphs(self):
        formula = r'\[x=1\]'
        url = 'https://arxiv.org/figure(1).png'
        image = '![example](' + url + ')'
        self.assertEqual(publish._api_reader_display_formula_blocks('`\n' + formula + '\n`'), [])
        self.assertEqual(publish._api_reader_article_image_urls('`\n' + image + '\n`'), [])
        self.assertEqual(publish._api_reader_article_image_urls('`\n\n' + image + '\n\n`'), [url])
        self.assertEqual(publish._api_reader_display_formula_blocks('`\n\n' + formula + '\n\n`'), [formula])

    def test_formatting_outside_complete_code_explanation_is_not_real_prose(self):
        paper = fixture.llm_api_publication_fixture()
        bridge = paper['apiReaderPlan']['conceptBridges'][0]
        before = bridge['explanation']
        bridge['explanation'] = '**`' + before + '`**'
        paper['apiReaderArticle'] = paper['apiReaderArticle'].replace(before, bridge['explanation'])
        fixture.reseal_llm_api_reader_fixture(paper)
        with self.assertRaises(publish.PublishDataValidationError):
            publish.generate_paper_page(paper, '2026-08-31')

    def test_real_figure_and_multiline_same_url_code_example_are_not_duplicates(self):
        paper = fixture.llm_api_ephemeral_figure_fixture()
        url = paper['apiReaderFigures'][0]['url']
        paper['apiReaderArticle'] += '\n\n`\n![代码中的图](' + url + ')\n`'
        fixture.reseal_llm_api_reader_fixture(paper)
        publish.generate_paper_page(paper, '2026-08-31')
        self.assertEqual(publish._api_reader_article_image_urls(paper['apiReaderArticle']), [url])

    def test_multiline_formula_keeps_exact_source_bytes(self):
        formula = '\\[a =\n    b+c\\]'
        self.assertEqual(publish._api_reader_display_formula_blocks(formula), [formula])


if __name__ == '__main__':
    unittest.main()
