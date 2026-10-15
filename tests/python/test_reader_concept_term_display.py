import copy
import json
import unittest
from pathlib import Path
from test_publish_to_blog import publish_to_blog as publish, llm_api_publication_fixture, reseal_llm_api_reader_fixture


class ReaderConceptTermDisplayTests(unittest.TestCase):
    def test_same_shared_display_boundaries_as_node(self):
        cases = json.loads((Path(__file__).parents[1] / 'fixtures/reader-concept-term-display-cases.json').read_text())
        for item in cases:
            with self.subTest(item['name']):
                self.assertEqual(publish._api_reader_concept_term_present(item['explanation'], item['term']), item['present'])

    def sample(self, explanation, terms=None):
        paper = llm_api_publication_fixture()
        bridge = paper['apiReaderPlan']['conceptBridges'][0]
        old = bridge['explanation']
        bridge['terms'] = terms or ['强制对齐', '`<score>`标记']
        bridge['explanation'] = explanation
        paper['apiReaderArticle'] = paper['apiReaderArticle'].replace(old, explanation)
        reseal_llm_api_reader_fixture(paper)
        return paper

    def test_actual_publisher_accepts_display_gap_without_mutation(self):
        paper = self.sample('强制对齐负责定位，`<score>` 标记负责保留词边界的声学表示。两者按清楚的接口组合，说明定位信息如何进入评分过程，以及哪些边界仍需额外证据。')
        before = copy.deepcopy(paper)
        self.assertIsNotNone(publish._api_reader_payload(paper))
        self.assertEqual(paper, before)
        other = self.sample('`<word>` 标记负责定位，`<score>` 标记负责保留词边界的声学表示。两者按清楚的接口组合，说明定位信息如何进入评分过程，以及哪些边界仍需额外证据。', ['`<word>`标记', '`<score>`标记'])
        self.assertIsNotNone(publish._api_reader_payload(other))

    def test_actual_publisher_keeps_missing_words_and_hidden_explanation_rejected(self):
        text = '强制对齐负责定位，`<score>` 标记负责保留词边界的声学表示。两者按清楚的接口组合，说明定位信息如何进入评分过程，以及哪些边界仍需额外证据。'
        cases = [(text.replace('强制对齐', '其他定位'), None),
                 (text, ['`<score>`标记', '`<score>` 标记']),
                 (text.replace('强制对齐', 'A BC'), ['AB C', '`<score>`标记']),
                 ('<!--\n\n' + text + '\n\n-->', None),
                 ('```text\n' + text + '\n```', None),
                 ('`' + text.replace('`', '') + '`', None)]
        for explanation, terms in cases:
            paper = self.sample(explanation, terms)
            before = copy.deepcopy(paper)
            with self.assertRaises(publish.PublishDataValidationError):
                publish._api_reader_payload(paper)
            self.assertEqual(paper, before)


if __name__ == '__main__':
    unittest.main()
