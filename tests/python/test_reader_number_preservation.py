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
        for rendered, source_value in [('130', '130130'), ('−22.9', '−22.9-22.9'), ('+20%', '++20%')]:
            for value, accepted in [(rendered, False), (source_value, True)]:
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
