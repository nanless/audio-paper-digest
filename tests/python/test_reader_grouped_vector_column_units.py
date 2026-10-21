"""Real saved vector tables must pass the publisher's own cold source gate."""
import copy
import gzip
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_publish_sealed_pdf_literal_column_units import bundle, publisher, private_write, sha
from reader_grouped_vector_column_units import coverage

RAW = (ROOT / 'tests/fixtures/reader-daily-vector-unit-tables-20261021-real.json.gz').read_bytes()
assert hashlib.sha256(RAW).hexdigest() == '2337fbe91cd6dabbaef83f7cb92e65be51fe9593ce76119cbe6ae170d228d222'
FIXTURE = json.loads(gzip.decompress(RAW))


class PublisherGroupedVectorUnitsTests(unittest.TestCase):
    def prepare(self, root, index):
        item = {**FIXTURE, 'draft': FIXTURE['proposedDraft'],
                'sectionIndex': 7 + index, 'bindingIndex': index}
        paper, rendered, binding, raw, quotes, directory = bundle(root, item)
        original = item['draft']['tableBindings'][index]
        binding.update(tableIndex=index + 1, sourceType='source_quotes', cellBindings=[],
                       sourceQuotes=[{'quote': q, 'sourceQuoteSha256': sha(q.encode())}
                                     for q in original['sourceQuotes']])
        paper['apiReaderPlan']['tableBindings'] = [binding]
        run = directory.parents[2]
        private_write(run / 'run.json', publisher._daily_fresh_canonical_json_bytes({
            'contract': 'daily-fresh-source-run-v1', 'runId': run.name}))
        return paper, rendered, binding, directory

    def test_real_saved_tables_pass_cold_publication_and_preserve_four_sources(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(publisher, 'DAILY_FRESH_SOURCE_RUNS_DIR', Path(tmp)):
            for index, expected_count in [(0, 12), (1, 26)]:
                paper, table, binding, directory = self.prepare(Path(tmp), index)
                before = {file.name: file.read_bytes() for file in directory.iterdir()}
                result = publisher._reader_dom_column_unit_coverage(paper, table, binding)
                self.assertEqual(len(result), expected_count)
                failures = publisher._reader_table_header_unit_evidence_failures(table,
                    [q['quote'] for q in binding['sourceQuotes'] + binding['sealedPdfQuoteEvidence']])
                self.assertTrue(failures)
                self.assertFalse(set(failures) - result)
                self.assertEqual({file.name: file.read_bytes() for file in directory.iterdir()}, before)

    def test_wrong_rows_columns_units_delta_and_forged_source_never_grant_units(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(publisher, 'DAILY_FRESH_SOURCE_RUNS_DIR', Path(tmp)):
            for index in [0, 1]:
                paper, table, binding, directory = self.prepare(Path(tmp), index)
                changes = [lambda t: t['rows'].pop(), lambda t: t['rows'].reverse(),
                           lambda t: t['rows'][0].__setitem__(1, '999'),
                           lambda t: t['header'].__setitem__(1, t['header'][1].replace('%', 'ms')),
                           lambda t: t['rows'][0].__setitem__(0, '(0.9, 0.1)')]
                if index:
                    changes.append(lambda t: t['rows'][-1].__setitem__(1, '+0.16'))
                for change in changes:
                    bad = copy.deepcopy(table)
                    change(bad)
                    self.assertEqual(publisher._reader_dom_column_unit_coverage(paper, bad, binding), set())
                forged = copy.deepcopy(paper)
                forged['apiReaderPlan']['tableBindings'][0]['sealedPdfQuoteEvidence'][0]['pdfSha256'] = '0' * 64
                with self.assertRaises(publisher.PublishDataValidationError):
                    publisher._reader_dom_column_unit_coverage(forged, table, forged['apiReaderPlan']['tableBindings'][0])
                raw = (directory / 'source.pdf').read_bytes()
                try:
                    private_write(directory / 'source.pdf', raw + b'changed')
                    with self.assertRaises(publisher.PublishDataValidationError):
                        publisher._reader_dom_column_unit_coverage(paper, table, binding)
                finally:
                    private_write(directory / 'source.pdf', raw)

    def test_complete_grid_and_pdf_match_are_both_required(self):
        tables = FIXTURE['structuredArtifacts']['tables']
        original = FIXTURE['proposedDraft']['tableBindings'][1]
        body = FIXTURE['proposedDraft']['sections'][8]['body']
        lines = [line for line in body.splitlines() if line.startswith('|') and '---' not in line]
        rows = [[v.strip() for v in line.strip('|').split('|')] for line in lines]
        rendered = {'header': rows[0], 'rows': rows[1:]}
        args = (rendered, original['sourceQuotes'], original['pdfSourceQuotes'])
        self.assertEqual(len(coverage(*args, tables, publisher._normalize_api_reader_source_cell)), 26)
        for mutate in [lambda t: t['cells'][-1].__setitem__('colspan', 1),
                       lambda t: t['cells'][1].__setitem__('text', 'ASR WER (ms) ↓')]:
            bad = copy.deepcopy(tables)
            mutate(bad[1])
            self.assertEqual(coverage(*args, bad, publisher._normalize_api_reader_source_cell), set())
        self.assertEqual(coverage(*args, tables + [copy.deepcopy(tables[1])], publisher._normalize_api_reader_source_cell), set())
        self.assertEqual(coverage(rendered, args[1], args[2] + args[2], tables, publisher._normalize_api_reader_source_cell), set())


if __name__ == '__main__':
    unittest.main()
