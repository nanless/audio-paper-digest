"""The publisher replays the same full real PDF unit profiles as the Reader."""
import base64
import copy
import gzip
import hashlib
import importlib.util
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_env_isolation import project_env_scope
from reader_sealed_pdf_quote_evidence import extract_pdf_quote_document, quote_evidence
from reader_sealed_pdf_literal_column_units import prove_pdf_bytes as prove_literal

SPEC = importlib.util.spec_from_file_location('publish_literal_pdf_unit_tests', ROOT / 'scripts/publish-to-blog.py')
publisher = importlib.util.module_from_spec(SPEC)
with project_env_scope():
    SPEC.loader.exec_module(publisher)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def private_write(file, raw):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_bytes(raw)
    file.chmod(0o600)


def bundle(root, item):
    """Keep the complete saved original page/text/artifacts, never fake a PDF DOM."""
    paper_id, run_id = item['arxivId'], '11111111-1111-4111-8111-111111111111'
    raw, text = base64.b64decode(item['pdf']['base64']), item['sourceText'].encode()
    assert sha(raw) == item['pdf']['sha256']
    artifacts = copy.deepcopy(item['structuredArtifacts'])
    artifact_body = {k: v for k, v in artifacts.items() if k != 'payloadSha256'}
    payload = json.dumps(artifact_body, ensure_ascii=False, separators=(',', ':'))
    artifacts['payloadSha256'] = sha(payload.encode())
    runtime = {'contract': 'fresh-arxiv-rewrite-runtime-metadata-v1', 'version': 1,
               'paperId': 'arxiv:' + paper_id, 'title': item['title'], 'textSha256': sha(text),
               'structuredArtifacts': artifacts, 'imageInfos': [], 'readerAuthors': None,
               'htmlAvailability': 'available', 'htmlAttempts': 1, 'warnings': []}
    canonical = publisher._daily_fresh_canonical_json_bytes
    runtime_raw = canonical(runtime)
    manifest = {'contract': 'fresh-arxiv-rewrite-source-v1', 'version': 2,
                'arxivId': paper_id, 'paperId': 'arxiv:' + paper_id, 'generation': 1,
                'capturedAt': '2026-10-20T00:00:00.000Z',
                'text': {'filename': 'source.txt', 'source': 'html', 'sourceId': paper_id,
                         'url': 'https://arxiv.org/html/' + paper_id, 'fetchedAt': '2026-10-20T00:00:00.000Z',
                         'extractor': {'contract': 'deep-analyzer-official-arxiv-fulltext-v1', 'version': 'arxiv-html-or-pdf-text-v1'},
                         'responseSha256': sha(text), 'responseBytes': len(text)},
                'pdf': {'filename': 'source.pdf', 'url': 'https://arxiv.org/pdf/' + paper_id + '.pdf',
                        'fetchedAt': '2026-10-20T00:00:01.000Z', 'responseSha256': sha(raw), 'responseBytes': len(raw)},
                'runtimeMetadata': {'filename': 'source-runtime.json', 'responseSha256': sha(runtime_raw), 'responseBytes': len(runtime_raw)}}
    manifest_raw = canonical(manifest)
    details = {'text': text.decode(), 'source': 'html', 'sourceId': paper_id, 'imageInfos': [],
               'structuredArtifacts': artifacts, 'readerAuthors': {'authors': []},
               'htmlAvailability': 'available', 'htmlAttempts': 1, 'warnings': []}
    proof = {'contract': 'fresh-source-analysis-v1', 'runId': run_id, 'sourceGeneration': 1,
             'sourceManifestSha256': sha(manifest_raw), 'sourceSha256': sha(text),
             'sourceSnapshotSha256': sha(publisher._daily_fresh_compact_json_bytes({
                 'sourceManifestSha256': sha(manifest_raw), 'sourceGeneration': 1, 'details': details})),
             'sourceOnly': True, 'oldGeneratedTextIncluded': False}
    directory = root / run_id / 'sources' / paper_id / 'generation-000001'
    for name, data in [('source.txt', text), ('source.pdf', raw), ('source-runtime.json', runtime_raw), ('source-manifest.json', manifest_raw)]:
        private_write(directory / name, data)
    paper = {'arxivId': paper_id, 'freshRewriteProvenance': proof, 'sourceSha256': sha(text),
             'modelTextSanitizationContract': 'model-text-unicode-scalars-v1',
             'analysisManifest': {'freshRewriteProvenance': copy.deepcopy(proof),
                                  'sourceAcquisition': {'sourceSha256': sha(text), 'structuredArtifactsSha256': sha(payload.encode()),
                                                        'modelTextSanitizationContract': 'model-text-unicode-scalars-v1'}},
             'apiReaderPlan': {'structuredSourcePayload': payload}}
    lines = [line for line in item['draft']['sections'][item['sectionIndex']]['body'].splitlines()
             if line.startswith('|') and not re.fullmatch(r'[| :\-]+', line)]
    view = [[v.strip() for v in line.strip('|').split('|')] for line in lines]
    if paper_id == '2610.25342':
        view[3][0] = 'SelfTalk [5]'  # Source PDF numbering, no repair of any value.
    quotes = item.get('fullTablePdfQuotes', item['draft']['tableBindings'][item['bindingIndex']].get('pdfSourceQuotes'))
    document = extract_pdf_quote_document(raw)
    binding = {'sealedPdfQuoteEvidence': [quote_evidence(document, q) for q in quotes]}
    return paper, {'header': view[0], 'rows': view[1:]}, binding, raw, quotes, directory


class PublisherRealLiteralPdfUnitsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads(gzip.decompress((ROOT / 'tests/fixtures/reader-daily-real-unit-tables-20261020.json.gz').read_bytes()))

    def test_actual_publisher_helper_matches_strict_units_for_three_complete_real_pages(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(publisher, 'DAILY_FRESH_SOURCE_RUNS_DIR', Path(tmp)):
            for item in self.data['papers']:
                with self.subTest(paper=item['arxivId']):
                    paper, rendered, binding, raw, quotes, directory = bundle(Path(tmp), item)
                    before = {f.name: f.read_bytes() for f in directory.iterdir()}
                    proof = prove_literal(raw, [rendered['header']] + rendered['rows'], quotes)
                    expected = {(row + 1, col['column'], token, col['unit']) for col in proof['units']
                                for row, value in enumerate(col['values']) for token in publisher._api_reader_numeric_tokens(value)}
                    self.assertTrue(expected)
                    self.assertEqual(publisher._reader_sealed_pdf_column_unit_coverage(paper, rendered, binding), expected)
                    self.assertEqual({f.name: f.read_bytes() for f in directory.iterdir()}, before)

    def test_wrong_identity_unit_value_or_incomplete_quote_never_grants_coverage(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(publisher, 'DAILY_FRESH_SOURCE_RUNS_DIR', Path(tmp)):
            for item in self.data['papers']:
                paper, rendered, binding, raw, quotes, directory = bundle(Path(tmp), item)
                changes = [lambda v: v['rows'].pop(), lambda v: v['rows'].reverse(),
                           lambda v: v['rows'][0].__setitem__(0, 'Wrong Method / Dataset'),
                           lambda v: v['header'].__setitem__(-2 if item['arxivId'] == '2610.25342' else -1, 'Wrong unit (GB)'),
                           lambda v: v['rows'][0].__setitem__(2, '999.99')]
                if item['arxivId'] == '2610.25342':
                    changes += [lambda v: v['rows'][2].__setitem__(0, 'SelfTalk [17]'),
                                lambda v: v['rows'][0].__setitem__(6, '1.97M (1.09%)')]
                if item['arxivId'] == '2610.24522':
                    changes += [lambda v: v['header'].__setitem__(1, 'R-precision Top1 (%)'),
                                lambda v: v['header'].__setitem__(7, 'Skating Ratio (%) ↑'),
                                lambda v: v['rows'][0].__setitem__(1, '0.720 ± 0.001')]
                for change in changes:
                    bad = copy.deepcopy(rendered)
                    change(bad)
                    self.assertEqual(publisher._reader_sealed_pdf_column_unit_coverage(paper, bad, binding), set())
                bad_binding = {'sealedPdfQuoteEvidence': [{'quote': 'The whole table is verified, with % ms and MB.'}]}
                self.assertEqual(publisher._reader_sealed_pdf_column_unit_coverage(paper, rendered, bad_binding), set())
                for field in ('arxivId', 'sourceSha256'):
                    bad_paper = copy.deepcopy(paper)
                    bad_paper[field] = '2610.99999' if field == 'arxivId' else '0' * 64
                    with self.assertRaises((publisher.PublishDataValidationError, FileNotFoundError)):
                        publisher._reader_sealed_pdf_column_unit_coverage(bad_paper, rendered, binding)
                original = (directory / 'source.pdf').read_bytes()
                try:
                    private_write(directory / 'source.pdf', original + b'changed')
                    with self.assertRaises(publisher.PublishDataValidationError):
                        publisher._reader_sealed_pdf_column_unit_coverage(paper, rendered, binding)
                finally:
                    private_write(directory / 'source.pdf', original)

    def test_real_sentry_full_width_condition_bands_replay_in_the_publisher_scope(self):
        fixture = json.loads((ROOT / 'tests/fixtures/reader-real-sentry-full-width-bands.json').read_bytes())
        real = json.loads(gzip.decompress(base64.b64decode(fixture['payloadGzipBase64'])))
        item = {'arxivId': '2610.24468', 'title': fixture['provenance']['title'],
                'sourceText': real['sourceText'], 'structuredArtifacts': real['runtime']['structuredArtifacts'],
                'pdf': {'base64': real['pdfBase64'], 'sha256': fixture['provenance']['files']['source.pdf']['sha256']},
                'draft': {'sections': [real['readerSection']], 'tableBindings': [{'pdfSourceQuotes': [real['pdfQuote']]}]},
                'sectionIndex': 0, 'bindingIndex': 0}
        source = next(t for t in item['structuredArtifacts']['tables'] if t['ordinal'] == 2)
        start = real['sourceText'].index('TABLE II: Detection Accuracy')
        caption = real['sourceText'][start:real['sourceText'].index('\nAI Model', start)].strip()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(publisher, 'DAILY_FRESH_SOURCE_RUNS_DIR', Path(tmp)):
            paper, rendered, binding, raw, quotes, directory = bundle(Path(tmp), item)
            run = directory.parents[2]
            private_write(run / 'run.json', publisher._daily_fresh_canonical_json_bytes({
                'contract': 'daily-fresh-source-run-v1', 'runId': run.name}))
            binding['sourceQuotes'] = [{'quote': caption, 'sourceQuoteSha256': sha(caption.encode())}]
            covered = publisher._reader_dom_column_unit_coverage(paper, rendered, binding)
            self.assertEqual(len(covered), 12)
            self.assertEqual({c[1:] for c in covered}, {(4, value, '%') for value in
                ('0', '0.13', '0.64', '1.57', '1.93', '1.6', '1.89', '2.69', '4.41', '4.58', '6.95')})
            self.assertTrue(publisher._reader_full_width_body_bands(source))
            def changed(callback):
                value = copy.deepcopy(source)
                callback(value)
                return value
            def band(value):
                return next(c for c in value['cells'] if c['colspan'] == 5)
            bad_sources = [
                changed(lambda t: band(t).__setitem__('colspan', 4)),
                changed(lambda t: band(t).__setitem__('rowspan', 2)),
                changed(lambda t: t['cells'].append(copy.deepcopy(band(t)))),
                changed(lambda t: t['cells'].remove(band(t))),
                changed(lambda t: t['matrix'][1].__setitem__(4, 'unowned text')),
                changed(lambda t: band(t).__setitem__('sourceDomSha256', 'forged')),
                changed(lambda t: t['cells'][0].__setitem__('rowspan', 2)),
            ]
            for decoration in ('**', '__', '` `', '* _ ` 　'):
                empty = copy.deepcopy(source)
                cell = band(empty); cell['text'] = decoration
                empty['matrix'][cell['row']] = [decoration] * 5
                bad_sources.append(empty)
            # A band must have a following ordinary data row; no trailing or adjacent band.
            trailing = copy.deepcopy(source)
            last = len(trailing['matrix']) - 1
            trailing['cells'] = [c for c in trailing['cells'] if c['row'] != last]
            last_band = copy.deepcopy(band(trailing)); last_band['row'] = last
            trailing['cells'].append(last_band); trailing['matrix'][last] = [last_band['text']] * 5
            bad_sources.append(trailing)
            adjacent = copy.deepcopy(source)
            adjacent['cells'] = [c for c in adjacent['cells'] if c['row'] != 2]
            next_band = copy.deepcopy(band(adjacent)); next_band['row'] = 2
            adjacent['cells'].append(next_band); adjacent['matrix'][2] = [next_band['text']] * 5
            bad_sources.append(adjacent)
            for bad in bad_sources:
                self.assertFalse(publisher._reader_full_width_body_bands(bad))
                self.assertEqual(publisher._reader_dom_table_unit_coverage(rendered, [caption], [bad]), set())
            self.assertEqual(publisher._reader_dom_table_unit_coverage(rendered, [caption], [source, copy.deepcopy(source)]), set())
            self.assertEqual(publisher._reader_dom_table_unit_coverage(rendered, ['Other table EER (%)'], [source]), set())
            repeated = copy.deepcopy(source)
            cell = next(c for c in repeated['cells'] if c['text'] == 'A06')
            cell['text'] = 'HiFi-GAN'; repeated['matrix'][cell['row']][0] = 'HiFi-GAN'
            repeated_coverage = publisher._reader_dom_table_unit_coverage(rendered, [caption], [repeated])
            self.assertFalse(any(row == 2 for row, column, value, unit in repeated_coverage))
            wrong = copy.deepcopy(rendered); wrong['rows'][-1][4] = '9.95'
            self.assertNotIn((14, 4, '9.95', '%'), publisher._reader_dom_column_unit_coverage(paper, wrong, binding))
            fake = copy.deepcopy(paper); fake['sourceSha256'] = '0' * 64
            with self.assertRaises(publisher.PublishDataValidationError):
                publisher._reader_dom_column_unit_coverage(fake, rendered, binding)

    def test_both_literal_and_its_geometry_implementation_change_generation_fingerprint(self):
        real = publisher._sha256_file
        before = publisher.generation_template_fingerprint()
        for name in ('reader_sealed_pdf_literal_column_units.py', 'reader_authenticated_pdf_hierarchical_table.py'):
            def changed(file):
                return '0' * 64 if Path(file).name == name else real(file)
            with mock.patch.object(publisher, '_sha256_file', side_effect=changed):
                self.assertNotEqual(before, publisher.generation_template_fingerprint(), name)


if __name__ == '__main__':
    unittest.main()
