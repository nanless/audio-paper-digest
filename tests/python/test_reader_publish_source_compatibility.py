import copy
import hashlib
import sys
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import reader_inline_svg as svg
import reader_inline_svg_pixel_replay as replay
from test_publish_to_blog import (publish_to_blog as publish,
    llm_api_publication_fixture, reseal_llm_api_reader_fixture)


class PublicationSourceCompatibilityTests(unittest.TestCase):
    def test_pdf_quote_binding_keeps_numeric_and_unit_guards(self):
        quote = 'Results: SDR (dB): 13.2; SI-SDR (dB): 12.1.'
        article = '| Method | SDR (dB) | SI-SDR (dB) |\n| --- | --- | --- |\n| VM | 13.2 | 12.1 |'
        paper = llm_api_publication_fixture()
        paper['apiReaderArticle'] = article
        paper['apiReaderPlan']['formulaBindings'] = []
        paper['apiReaderPlan']['tableBindings'] = [{
            'tableIndex': 1, 'sourceType': 'source_quotes', 'sourceTableOrdinal': None,
            'renderedTableSha256': hashlib.sha256(article.encode()).hexdigest(),
            'cellBindings': [], 'sourceQuotes': [], 'sealedPdfQuoteEvidence': [{'quote': quote}]}]
        reseal_llm_api_reader_fixture(paper)
        with patch.object(publish, '_verify_reader_sealed_pdf_quote_bindings', return_value={1: [quote]}):
            publish._validate_api_reader_source_bindings(paper)
            bad = copy.deepcopy(paper)
            bad['apiReaderArticle'] = article.replace('13.2', '13.3')
            bad['apiReaderPlan']['tableBindings'][0]['renderedTableSha256'] = hashlib.sha256(
                bad['apiReaderArticle'].encode()).hexdigest()
            reseal_llm_api_reader_fixture(bad)
            with self.assertRaisesRegex(publish.PublishDataValidationError, '数字|单位'):
                publish._validate_api_reader_source_bindings(bad)
        with patch.object(publish, '_verify_reader_sealed_pdf_quote_bindings', return_value={}):
            with self.assertRaisesRegex(publish.PublishDataValidationError, '逐字引文来源记录'):
                publish._validate_api_reader_source_bindings(paper)

    @unittest.skipUnless(os.environ.get('PD_PDF_QUOTE_REAL_PROOFS') and os.environ.get('PD_GENERIC_PDF_REAL_DATA_FILE'),
                         'Requires private controlled daily sources and actual PDF quotations')
    def test_real_publisher_reextracts_pdf_quotes_and_rejects_tampering(self):
        examples = json.loads(Path(os.environ['PD_PDF_QUOTE_REAL_PROOFS']).read_text())
        batch = json.loads(Path(os.environ['PD_GENERIC_PDF_REAL_DATA_FILE']).read_text())
        checked = 0
        for example in examples:
            paper = copy.deepcopy(next(p for p in batch['papers']
                if publish.normalize_publish_arxiv_id(p['arxivId']) == example['paperId']))
            proof = paper['freshRewriteProvenance']
            source_dir = publish.DAILY_FRESH_SOURCE_RUNS_DIR / proof['runId'] / 'sources' \
                / example['paperId'] / 'generation-000001'
            artifacts = json.loads((source_dir / 'source-runtime.json').read_text())['structuredArtifacts']
            paper['apiReaderPlan'] = {'structuredSourcePayload': json.dumps(
                {key: value for key, value in artifacts.items() if key != 'payloadSha256'},
                ensure_ascii=False, sort_keys=True, separators=(',', ':')), 'tableBindings': [{
                    'tableIndex': 1, 'sourceType': 'source_quotes', 'sourceQuotes': [],
                    'sealedPdfQuoteEvidence': [example['evidence']]}]}
            before = copy.deepcopy(paper)
            self.assertEqual(publish._verify_reader_sealed_pdf_quote_bindings(paper),
                             {1: [example['evidence']['quote']]})
            self.assertEqual(paper, before)
            checked += 1
            for field in ['quote', 'rawFragment', 'pdfSha256', 'normalizedStartCodePoint']:
                bad = copy.deepcopy(paper)
                evidence = bad['apiReaderPlan']['tableBindings'][0]['sealedPdfQuoteEvidence'][0]
                evidence[field] = evidence[field] + (' altered' if isinstance(evidence[field], str) else 1)
                with self.assertRaises((publish.PublishDataValidationError, ValueError)):
                    publish._verify_reader_sealed_pdf_quote_bindings(bad)
            bad = copy.deepcopy(paper)
            bad['apiReaderPlan']['tableBindings'][0]['sealedPdfQuoteEvidence'] = []
            with self.assertRaises(publish.PublishDataValidationError):
                publish._verify_reader_sealed_pdf_quote_bindings(bad)
            bad = copy.deepcopy(paper)
            bad['apiReaderPlan']['tableBindings'] *= 2
            with self.assertRaises(publish.PublishDataValidationError):
                publish._verify_reader_sealed_pdf_quote_bindings(bad)
        self.assertGreaterEqual(checked, 4)

    def test_original_static_html_break_preserves_raw_source_identity(self):
        text = '<svg id="figure1" width="100" height="100" viewBox="0 0 100 100"><foreignObject><div>A<br>B</div></foreignObject></svg>'
        resource = {'kind': 'inline_svg', 'mediaType': 'image/svg+xml', 'inlineSvg': text,
                    'inlineSvgBytes': len(text.encode()), 'inlineSvgSha256': hashlib.sha256(text.encode()).hexdigest()}
        before = copy.deepcopy(resource)
        descriptor = svg.source_descriptor(resource, '2610.99999v2')
        self.assertEqual(descriptor['inlineSvgSourceSha256'], resource['inlineSvgSha256'])
        self.assertIn('<br/>', svg.validate_svg(text.encode()))
        self.assertEqual(resource, before)

    def test_replay_requires_exact_saved_pixels_and_trusted_producer(self):
        source = b'<svg width="100" height="100" viewBox="0 0 100 100"/>'
        png = b'\x89PNG\r\n\x1a\noriginal-model-pixels'
        expected = hashlib.sha256(png).hexdigest()
        code = b'def render_svg(raw):\n return '+repr(png).encode()+b'\n'
        provenance = {'gitCommitOid': 'a'*40, 'rendererBlobOid': 'b'*40, 'rendererSha256': hashlib.sha256(code).hexdigest()}
        with patch.object(svg, 'render_svg', return_value=b'\x89PNG\r\n\x1a\nnew-pixels'), \
                patch.object(replay, '_trusted_renderers', return_value=iter([(code, provenance)])):
            pixels, proof = replay.replay_saved_inline_svg_pixels(source, expected)
        self.assertEqual(pixels, png)
        self.assertEqual(proof['savedPixelSha256'], expected)
        self.assertEqual(proof['sourceSvgSha256'], hashlib.sha256(source).hexdigest())
        with patch.object(svg, 'render_svg', return_value=png), \
                patch.object(replay, '_trusted_renderers', return_value=iter([(code, provenance)])):
            with self.assertRaisesRegex(ValueError, 'No trusted original'):
                replay.replay_saved_inline_svg_pixels(source, 'c'*64)

    def test_replay_security_guard_rejects_external_resources_before_any_producer(self):
        source = b'<svg width="100" height="100" viewBox="0 0 100 100"><use href="https://example.com/a.svg"/></svg>'
        with patch.object(svg, 'render_svg') as producer, patch.object(replay, '_trusted_renderers') as history:
            with self.assertRaises(ValueError):
                replay.replay_saved_inline_svg_pixels(source, 'c'*64)
            producer.assert_not_called()
            history.assert_not_called()

    def test_original_caption_absence_requires_unique_complete_source(self):
        figure = {'ordinal': 1, 'url': 'https://arxiv.org/html/2610.99999v1/F1.png',
                  'sourceDomSha256': 'a'*64, 'caption': ''}
        source = {'ordinal': 1, 'recoveryStatus': 'complete', 'sourceDomSha256': 'a'*64,
                  'caption': '', 'images': [{'url': figure['url']}]}
        proof = {'structuredArtifactsSha256': 'b'*64}
        paper = {'sourceSha256': 'c'*64}
        for change in [None, {'caption': 'Real original caption'}, {'ordinal': 2},
                       {'sourceDomSha256': 'd'*64}, {'recoveryStatus': 'partial'},
                       {'images': [{'url': 'https://arxiv.org/html/2610.99999v1/F2.png'}]}]:
            item = {**source, **(change or {})}
            with patch.object(publish, '_reader_source_payload_artifacts', return_value={'figures': [item]}):
                self.assertEqual(publish._reader_missing_figure_caption_matches(paper, {}, figure, proof), change is None)
        with patch.object(publish, '_reader_source_payload_artifacts', return_value={'figures': [source, source]}):
            self.assertFalse(publish._reader_missing_figure_caption_matches(paper, {}, figure, proof))

    def test_caption_note_formats_source_whitespace_without_editing_record(self):
        record = {'ordinal': 1, 'caption': 'original\ncaption'}
        before = copy.deepcopy(record)
        self.assertIn('original caption', publish._ephemeral_figure_note(record))
        self.assertEqual(record, before)
        self.assertIn('原始来源未提供图注', publish._ephemeral_figure_note({'ordinal': 1, 'caption': ''}))
        with self.assertRaises(publish.PublishDataValidationError):
            publish._ephemeral_figure_note({'ordinal': True, 'caption': ''})

    @unittest.skipUnless(os.environ.get('PD_GENERIC_PDF_REAL_DATA_FILE'),
                         'Requires the private controlled daily source fixture')
    def test_real_publisher_replays_complete_pdf_grid_and_rejects_tampered_proofs(self):
        from reader_sealed_pdf_table_evidence import prove_pdf_bytes
        batch = json.loads(Path(os.environ['PD_GENERIC_PDF_REAL_DATA_FILE']).read_text())
        checked = 0
        for original in batch['papers']:
            if not original.get('error'):
                continue
            proof = original.get('freshRewriteProvenance') or {}
            if not proof.get('runId'):
                continue
            paper = copy.deepcopy(original)
            source_dir = publish.DAILY_FRESH_SOURCE_RUNS_DIR / proof['runId'] / 'sources' \
                / publish.normalize_publish_arxiv_id(paper['arxivId']) / 'generation-000001'
            artifacts = json.loads((source_dir / 'source-runtime.json').read_text())['structuredArtifacts']
            derived = prove_pdf_bytes((source_dir / 'source.pdf').read_bytes(), artifacts['tables'])
            bindings = []
            for entry in derived:
                if not entry.get('eligible'):
                    continue
                table = next(t for t in artifacts['tables'] if t['ordinal'] == entry['sourceTableOrdinal'])
                evidence = entry['evidence']
                bindings.append({'tableIndex': len(bindings) + 1, 'sourceType': 'artifact_table',
                    'sourceTableOrdinal': table['ordinal'], 'sourceTableDomSha256': table['sourceDomSha256'],
                    'sealedPdfTableEvidence': evidence, 'cellBindings': [
                        {'sourceRow': c['row'], 'sourceColumn': c['column'],
                         'renderedRow': c['row'], 'renderedColumn': c['column'],
                         'sourceText': c['text'], 'sourceDomSha256': c['sourceDomSha256'],
                         'renderedText': evidence['displayMatrix'][c['row']][c['column']]}
                        for c in table['cells']]})
            if not bindings:
                continue
            source_body = {key: value for key, value in artifacts.items() if key != 'payloadSha256'}
            paper['apiReaderPlan'] = {'tableBindings': bindings, 'structuredSourcePayload':
                json.dumps(source_body, ensure_ascii=False, sort_keys=True, separators=(',', ':'))}
            before = copy.deepcopy(paper)
            self.assertEqual(len(publish._verify_reader_sealed_pdf_grid_bindings(paper)), len(bindings))
            self.assertEqual(paper, before)
            checked += len(bindings)
            for change in ['glyph', 'source', 'coordinate', 'drop']:
                bad = copy.deepcopy(paper)
                binding = bad['apiReaderPlan']['tableBindings'][0]
                if change == 'glyph':
                    binding['sealedPdfTableEvidence']['displayMatrix'][1][1] = '9999'
                elif change == 'source':
                    binding['cellBindings'][0]['sourceText'] = 'Unproven source'
                elif change == 'coordinate':
                    binding['cellBindings'][0]['renderedColumn'] = 1
                else:
                    binding['cellBindings'].pop()
                with self.subTest(paper=paper['arxivId'], mutation=change):
                    with self.assertRaises(publish.PublishDataValidationError):
                        publish._verify_reader_sealed_pdf_grid_bindings(bad)
        self.assertGreaterEqual(checked, 4)
