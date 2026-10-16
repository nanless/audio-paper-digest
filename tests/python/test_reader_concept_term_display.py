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
        numeric = self.sample('6 维感知轴负责诊断，2 次复核负责统一校对。二者按清楚的接口组合，说明感知结果如何进入复核过程，以及哪些边界仍需额外证据。',
                              ['六维感知轴', '二次复核'])
        before = copy.deepcopy(numeric)
        self.assertIsNotNone(publish._api_reader_payload(numeric))
        self.assertEqual(numeric, before)

    def test_actual_publisher_keeps_missing_words_and_hidden_explanation_rejected(self):
        text = '强制对齐负责定位，`<score>` 标记负责保留词边界的声学表示。两者按清楚的接口组合，说明定位信息如何进入评分过程，以及哪些边界仍需额外证据。'
        cases = [(text.replace('强制对齐', '其他定位'), None),
                 ('2 阶段训练负责顺序，另一个模块负责校对。两者按清楚的接口组合，说明结果如何进入训练过程，以及哪些边界仍需额外证据。', ['两阶段训练', '二阶段训练']),
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


    def test_atomic_multiplication_is_part_of_a_declared_complete_term(self):
        text = '**时间遮挡 × 时间×模态遮挡：** 时间遮挡用于定位上下文中起作用的时刻，时间×模态遮挡再区分该时刻对应的模态，两者结合解释各自分工、共同作用与证据边界。'
        paper = self.sample(text, ['时间遮挡', '时间×模态遮挡'])
        before = copy.deepcopy(paper)
        self.assertIsNotNone(publish._api_reader_payload(paper))
        self.assertEqual(paper, before)
        self.assertFalse(publish._api_reader_concept_term_present(text, '时间×模态掩蔽'))


if __name__ == '__main__':
    unittest.main()
