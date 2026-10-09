import hashlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_publish_to_blog import (
    publish_to_blog as publish,
    llm_api_publication_fixture,
    reseal_llm_api_reader_fixture,
)

TABLE = "\n".join([
    "| 策略 | 数据集 | 评测任务 | EER (%) | 运行条件 |",
    "| --- | --- | --- | --- | --- |",
    "| A | TidyVoice | validation set | 5.2% | matched |",
])


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def fixture(quote):
    paper = llm_api_publication_fixture()
    old = publish._api_reader_markdown_tables(paper["apiReaderArticle"])[0]["markdown"]
    paper["apiReaderArticle"] = paper["apiReaderArticle"].replace(old, TABLE)
    paper["apiReaderPlan"]["tableBindings"] = [{
        "tableIndex": 1,
        "sourceType": "source_quotes",
        "sourceTableOrdinal": None,
        "cellBindings": [],
        "renderedTableSha256": sha(TABLE),
        "sourceQuotes": [{"quote": quote, "sourceQuoteSha256": sha(quote)}],
    }]
    return reseal_llm_api_reader_fixture(paper)


class ReaderDatasetCacheTest(unittest.TestCase):
    def test_publisher_rechecks_legacy_dataset_relation_even_with_consistent_output_hashes(self):
        for quote in [
            "The validation set is AudioSet. The EER is 5.2%.",
            "We evaluate TidyVoice training data. The validation set is AudioSet, with EER 5.2%.",
            "The validation set is not TidyVoice; its EER is 5.2%.",
            "验证集来自 TidyVoice2，EER 为 5.2%。",
            "验证集来自 TidyVoice２，EER 为 5.2%。",
            'The validation set is from TidyVoice-Plus, with EER 5.2%.',
            'The validation set is from TidyVoice-2, with EER 5.2%.',
            'The validation set is from TidyVoiceé, with EER 5.2%.',
            '验证集来自 TidyVoiceé，EER 为 5.2%。',
            'The validation set is from TidyVoiceλ, with EER 5.2%.',

            "验证集来自 TidyVoicePlus，EER 为 5.2%。",
            "NotTidyVoice 的验证集 EER 为 5.2%。",
        ]:
            with self.subTest(quote=quote), self.assertRaisesRegex(
                publish.PublishDataValidationError, "TidyVoice/validation set"
            ):
                publish._validate_api_reader_source_bindings(fixture(quote))

    def test_original_explicit_dataset_relation_remains_compatible(self):
        for quote in [
            "The validation set is from TidyVoice, with EER 5.2%.",
            "The TidyVoice validation set reports an EER of 5.2%.",
            "验证集来自 TidyVoice，EER 为 5.2%。",
            "验证集来自 TidyVoice数据集，EER 为 5.2%。",
        ]:
            with self.subTest(quote=quote):
                result = publish._validate_api_reader_source_bindings(fixture(quote))
                self.assertEqual(result["tableCount"], 1)
