import copy
import unittest
from test_publish_to_blog import publish_to_blog as publish, llm_api_publication_fixture, reseal_llm_api_reader_fixture


class ReaderConceptMarkerTests(unittest.TestCase):
    def test_normal_complete_explanation_is_unchanged(self):
        sample = llm_api_publication_fixture()
        original = copy.deepcopy(sample)
        self.assertIsNotNone(publish._api_reader_payload(sample))
        self.assertEqual(sample, original)

    def test_self_consistent_saved_article_cannot_publish_reserved_markers(self):
        for marker in ('[[CONCEPT_BRIDGE_0]]', '[[CONCEPT_BRIDGE_1]]', '[[CONCEPT_BRIDGE_99]]'):
            with self.subTest(marker=marker):
                sample = llm_api_publication_fixture()
                sample['apiReaderArticle'] += '\n\n' + marker
                reseal_llm_api_reader_fixture(sample)
                original = copy.deepcopy(sample)
                with self.assertRaisesRegex(publish.PublishDataValidationError, '未装配的术语组合标记'):
                    publish._api_reader_payload(sample)
                self.assertEqual(sample, original)
