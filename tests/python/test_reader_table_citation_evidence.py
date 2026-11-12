"""Reader 表格中的参考文献编号不是测量值；真实数值仍必须有精确引文证据。"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_env_isolation import isolate_module_environment
from test_publish_to_blog import publish_to_blog as publisher

setUpModule, tearDownModule = isolate_module_environment()

QUOTE = 'The baseline reports WER 5.57 with SIM 0.46 under the shared protocol.'


def rendered(row):
    return {
        'header': ['Method', 'WER', 'SIM'],
        'rows': [[row, '5.57', '0.46']],
        'markdown': '| Method | WER | SIM |\n| --- | --- | --- |\n'
                    f'| {row} | 5.57 | 0.46 |',
    }


def missing_tokens(row):
    table = rendered(row)
    projection = publisher._api_reader_scientific_quote_projection(table, [QUOTE])
    return (projection['tokens']
            - set(publisher._api_reader_numeric_tokens(QUOTE))
            - publisher._reader_citation_only_numeric_tokens(table))


class ReaderTableCitationEvidenceTests(unittest.TestCase):
    def test_citation_only_bracket_number_is_not_a_measurement(self):
        self.assertEqual(publisher._reader_citation_only_numeric_tokens(
            rendered('Orig. CFM [37]')), {'37'})
        self.assertEqual(missing_tokens('Orig. CFM [37]'), set())
        self.assertEqual(missing_tokens('Orig. CFM [12, 37]'), set())

    def test_real_value_outside_brackets_still_requires_exact_quote(self):
        self.assertEqual(publisher._reader_citation_only_numeric_tokens(
            rendered('Value 37')), set())
        self.assertEqual(missing_tokens('Value 37'), {'37'})
        # 同一数字既出现在引用编号里、又作为真实数值出现时，仍按测量值要求证据。
        self.assertEqual(publisher._reader_citation_only_numeric_tokens(
            rendered('Orig. CFM [37] 37')), set())
        self.assertEqual(missing_tokens('Orig. CFM [37] 37'), {'37'})


if __name__ == '__main__':
    unittest.main()
