import copy
import unittest
from test_publish_to_blog import (
    publish_to_blog as publish,
    llm_api_publication_fixture,
    reseal_llm_api_reader_fixture,
)


class ReaderConceptTermCountTests(unittest.TestCase):
    def sample(self, terms):
        paper = llm_api_publication_fixture()
        bridge = paper['apiReaderPlan']['conceptBridges'][0]
        previous = bridge['explanation']
        bridge['terms'] = terms
        bridge['explanation'] = '、'.join(terms) + '分别负责保留证据、限定决策与连接过程，组合后形成完整的可核对机制。'
        paper['apiReaderArticle'] = paper['apiReaderArticle'].replace(previous, bridge['explanation'])
        reseal_llm_api_reader_fixture(paper)
        return paper

    def test_two_to_four_terms_pass_without_mutating_the_record(self):
        for count in (2, 3, 4):
            with self.subTest(count=count):
                paper = self.sample(['概念甲', '概念乙', '概念丙', '概念丁'][:count])
                before = copy.deepcopy(paper)
                self.assertIsNotNone(publish._api_reader_payload(paper))
                self.assertEqual(paper, before)

    def test_invalid_count_duplicates_and_missing_explanation_term_reject(self):
        for terms in (
            ['概念甲'],
            ['概念甲', '概念乙', '概念丙', '概念丁', '概念戊'],
            ['概念甲', '概念甲'],
            ['概念甲', ''],
            ['概念甲', 'K'],
        ):
            with self.subTest(terms=terms):
                paper = self.sample(terms)
                before = copy.deepcopy(paper)
                with self.assertRaises(publish.PublishDataValidationError):
                    publish._api_reader_payload(paper)
                self.assertEqual(paper, before)
        paper = self.sample(['概念甲', '概念乙', '概念丙'])
        bridge = paper['apiReaderPlan']['conceptBridges'][0]
        paper['apiReaderArticle'] = paper['apiReaderArticle'].replace(bridge['explanation'], bridge['explanation'].replace('概念丙', '该成分'))
        bridge['explanation'] = bridge['explanation'].replace('概念丙', '该成分')
        reseal_llm_api_reader_fixture(paper)
        with self.assertRaises(publish.PublishDataValidationError):
            publish._api_reader_payload(paper)


if __name__ == '__main__':
    unittest.main()
