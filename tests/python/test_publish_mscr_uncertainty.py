"""Keep publication scalar replay in parity with the actual MSCR paid tables."""
import gzip
import hashlib
import importlib.util
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_env_isolation import project_env_scope

SPEC = importlib.util.spec_from_file_location('publisher_mscr_uncertainty_tests', ROOT / 'scripts/publish-to-blog.py')
publisher = importlib.util.module_from_spec(SPEC)
with project_env_scope():
    SPEC.loader.exec_module(publisher)


def fixture():
    # Reuse the committed original paid draft and full sealed text, rather than
    # depending on a current runtime or copying another production snapshot.
    raw = (ROOT / 'tests/fixtures/reader-mscr-real-paid-uncertainty.json.gz').read_bytes()
    f = json.loads(gzip.decompress(raw))
    source = f['sourceText']
    caption = 'Table 5: Ablation study of the anti-dominance objective'
    assert source.count(caption) == 1
    start = source.index(caption)
    end = source.index('As shown in Table\u00a05,', start)
    ablation_quote = source[start:end]
    assert 12 <= len(ablation_quote) <= 4000
    tables = []
    for section, quotes in [(9, f['draft']['tableBindings'][0]['sourceQuotes']),
                            (12, [ablation_quote])]:
        markdown = '\n'.join(line for line in f['draft']['sections'][section]['body'].split('\n')
                             if line.startswith('|'))
        tables.append({'rendered': {'markdown': markdown}, 'binding': {'sourceQuotes': [
            {'quote': quote, 'sourceQuoteSha256': hashlib.sha256(quote.encode()).hexdigest()}
            for quote in quotes]}})
    return {'sourceText': source, 'sourceFiles': f['sourceFiles'], 'tables': tables,
            'notFullPublicationQualification': True}


class PublishMscrUncertaintyTests(unittest.TestCase):
    def test_actual_paid_mscr_18_main_and_28_ablation_pairs_keep_complete_uncertainties(self):
        f = fixture()
        self.assertEqual(hashlib.sha256(f['sourceText'].encode()).hexdigest(), f['sourceFiles']['source.txt'])
        pair_counts = []
        for item in f['tables']:
            quotes = item['binding']['sourceQuotes']
            for quote in quotes:
                self.assertIn(quote['quote'], f['sourceText'])
                self.assertEqual(hashlib.sha256(quote['quote'].encode()).hexdigest(), quote['sourceQuoteSha256'])
            corpus = '\n'.join(q['quote'] for q in quotes)
            supported = set(publisher._api_reader_numeric_tokens(corpus))
            markdown = item['rendered']['markdown']
            pairs = re.findall(r'([0-9]+\.[0-9]+)\s*±\s*([0-9]+\.[0-9]+)', markdown)
            pair_counts.append(len(pairs))
            self.assertFalse(set(publisher._api_reader_numeric_tokens(markdown)) - supported)
            for mean, uncertainty in pairs:
                self.assertIn(publisher._normalize_api_reader_numeric_token(mean), supported)
                self.assertIn(publisher._normalize_api_reader_numeric_token(uncertainty), supported)
        self.assertEqual(pair_counts, [18, 28])
        # Exact scalar evidence is not a new full-table semantic/condition proof.
        self.assertTrue(f['notFullPublicationQualification'])

    def test_exact_duplicate_operator_only_and_original_source_bytes_remain_unchanged(self):
        tokens = publisher._api_reader_numeric_tokens
        source = '75.7±\\pm1.1 86.4±\\pm0.9'
        original = source.encode()
        self.assertEqual(tokens(source), ['75.7', '1.1', '86.4', '0.9'])
        self.assertEqual(source.encode(), original)
        self.assertEqual(tokens('0.8±\\pm0.08'), ['0.8', '0.08'])
        for value in ['75.7±\\pmodel1.1', '75.7±\\pmvalue1.1', '75.7±\\pm1.1foo',
                      '75.7±\\pm1.1.2', '75.7±\\mp1.1', '75.7\\pm1.1']:
            with self.subTest(value=value):
                self.assertNotIn('1.1', tokens(value))
        self.assertEqual(tokens('75.7±\\pm-1.1'), tokens('75.7±\\unknown-1.1'))

    def test_wrong_mean_uncertainty_and_units_do_not_gain_quote_coverage(self):
        f = fixture()
        item = f['tables'][0]
        supported = set(publisher._api_reader_numeric_tokens('\n'.join(
            q['quote'] for q in item['binding']['sourceQuotes'])))
        original = item['rendered']['markdown']
        for replacement, missing in [('975.7123 ± 1.1', '975.7123'),
                                     ('75.7 ± 91.1123', '91.1123'),
                                     ('75.7 ms ± 1.1', '75.7ms')]:
            with self.subTest(replacement=replacement):
                altered = original.replace('75.7 ± 1.1', replacement)
                self.assertNotEqual(altered, original)
                self.assertIn(missing, set(publisher._api_reader_numeric_tokens(altered)) - supported)
