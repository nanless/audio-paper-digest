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


def sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


def paper(value, quote):
    result = llm_api_publication_fixture()
    table = f'| Split | Utterances |\n| --- | --- |\n| Training | {value} |'
    previous = publish._api_reader_markdown_tables(result['apiReaderArticle'])[0]['markdown']
    result['apiReaderArticle'] = result['apiReaderArticle'].replace(previous, table)
    result['apiReaderPlan']['tableBindings'] = [{
        'tableIndex': 1,
        'sourceType': 'source_quotes',
        'sourceTableOrdinal': None,
        'cellBindings': [],
        'renderedTableSha256': sha(table),
        'sourceQuotes': [{'quote': quote, 'sourceQuoteSha256': sha(quote)}],
    }]
    return reseal_llm_api_reader_fixture(result)


class ReaderNumberPreservationTest(unittest.TestCase):
    def test_legacy_hashes_do_not_prove_guessed_half_numbers(self):
        for source_value, rendered in [
            ('130130', '130'), ('6868', '68'), ('40964096', '4096'),
            ('500,000500,000', '500,000'), ('3.093.09 dB', '3.09 dB'),
            ('20202020 s', '2020 s'), ('.119.119', '.119'),
            ('０.１５0.15', '0.15'), ('0.15０．１５', '0.15'),
            ('+0.15+0.15 dB', '+0.15 dB'), ('−5.6-5.6 dB', '-5.6 dB'),
        ]:
            with self.subTest(source_value=source_value):
                quote = f'Training reports {source_value} under the controlled protocol.'
                with self.assertRaises(publish.PublishDataValidationError):
                    publish._validate_api_reader_source_bindings(paper(rendered, quote))
                with self.assertRaises(publish.PublishDataValidationError):
                    publish._api_reader_payload(paper(rendered, quote))

    def test_complete_original_values_and_explicit_tex_remain_valid(self):
        for value in ['130130', '6868', '40964096', '2020', '1212']:
            with self.subTest(value=value):
                quote = f'Training reports {value} under the controlled protocol.'
                self.assertEqual(
                    publish._validate_api_reader_source_bindings(paper(value, quote))['tableCount'], 1,
                )
                self.assertIsInstance(publish._api_reader_payload(paper(value, quote)), dict)
        quote = 'Observed latency was μ=4,852\\mu=4{,}852 ms under the controlled protocol.'
        self.assertEqual(
            publish._validate_api_reader_source_bindings(paper('4,852 ms', quote))['tableCount'], 1,
        )

    def test_legacy_dom_cells_keep_numbers_and_signs_exact(self):
        # 2026-11-13 起逐格来源比较两侧都做「双写折叠」：来源 DOM 会把同一数值写两遍
        # （130130、−22.9-22.9、++20%），文章只写一份。折叠只在两侧投影后完全相等时
        # 才算通过，所以数值不同（−22.9 对 −22.8）仍逐字拒绝。
        for rendered, source_value, rendered_accepted in [
            ('130', '130130', True),
            ('−22.9', '−22.9-22.9', True),
            ('−22.9', '−22.9-22.8', False),
            ('+20%', '++20%', True),
            ('+20%', '++21%', False),
        ]:
            for value, accepted in [(rendered, rendered_accepted), (source_value, True)]:
                with self.subTest(value=value, source_value=source_value):
                    result = paper(value, f'Training reports {value} under the controlled protocol.')
                    binding = result['apiReaderPlan']['tableBindings'][0]
                    binding.update({
                        'sourceType': 'artifact_table', 'sourceTableOrdinal': 1,
                        'sourceTableDomSha256': sha('original table'), 'sourceQuotes': [],
                        'cellBindings': [{
                            'renderedRow': row, 'renderedColumn': column,
                            'sourceRow': row, 'sourceColumn': column,
                            'renderedText': text,
                            'sourceText': source_value if row == 1 and column == 1 else text,
                            'sourceDomSha256': sha(f'original cell {row}:{column}'),
                        } for row, values in enumerate([['Split', 'Utterances'], ['Training', value]])
                            for column, text in enumerate(values)],
                    })
                    reseal_llm_api_reader_fixture(result)
                    if accepted:
                        self.assertEqual(publish._validate_api_reader_source_bindings(result)['tableCount'], 1)
                    else:
                        with self.assertRaises(publish.PublishDataValidationError):
                            publish._validate_api_reader_source_bindings(result)

    def test_separate_decimals_and_ranges_remain_valid(self):
        for value, quote in [
            ('.119', 'The measured ratio is .119 under the controlled protocol.'),
            ('+0.15 dB', 'The two measurements are +0.15 and +0.15 dB under the protocol.'),
            ('+0.15 dB', 'The two measurements are +0.15, +0.15 dB under the protocol.'),
            ('1.2–1.4', 'The accepted interval is 1.2–1.4 under the controlled protocol.'),
        ]:
            with self.subTest(value=value, quote=quote):
                self.assertEqual(publish._validate_api_reader_source_bindings(paper(value, quote))['tableCount'], 1)
