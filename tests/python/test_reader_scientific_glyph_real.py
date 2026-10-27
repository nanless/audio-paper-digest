"""Real saved PDF/paid content; all generated PDFs below are synthetic negatives."""
import base64
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import unittest
import fitz

BASE = Path(__file__).resolve().parent
ROOT = BASE.parent.parent
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
new = load('pdf_scientific', ROOT/'scripts/reader_sealed_pdf_quote_evidence.py')
fixture_bytes = (BASE.parent/'fixtures/reader-scientific-glyph-35042-real.json.gz').read_bytes()
assert hashlib.sha256(fixture_bytes).hexdigest() == 'dfd94d0b1b125f80242c1b48ec80e461f55cbd60cba0b461339519207a7f5ce7'
fixture = json.loads(gzip.decompress(fixture_bytes))
pdf = base64.b64decode(fixture['sourceFiles']['source.pdf']['base64'], validate=True)
assert hashlib.sha256(pdf).hexdigest() == fixture['sourceFiles']['source.pdf']['sha256']
quotes = fixture['binding']['pdfSourceQuotes']
Q = quotes[0]

def extract(raw, quote=Q):
    return new.extract_pdf_scientific_quantities(raw, [quote])['results'][0]

def synthetic(quote=Q, *, style='sup', prefix='', suffix='', split=False):
    """In-memory typography fixture, never a source capability or real paid PDF."""
    text = quote
    if style != 'baseline':
        tag = ('span' if style == 'small-baseline' else 'sup')
        size = {'large-super':'100%', 'tiny-super':'40%'}.get(style, '70%')
        text = re.sub(r'(?<=10)([−+-][0-9]+)', lambda m: f'<{tag} style="font-size:{size}">{m[0]}</{tag}>', text)
    if split:
        text = text.replace('1×10', '1×10<br>')
    doc = fitz.open()
    page = doc.new_page(width=1100, height=450)
    page.insert_htmlbox(fitz.Rect(40, 20, 1050, 430), '<div style="font-family:monospace;font-size:10pt">'
                        + prefix + '<p>Model Configuration</p><p>Our backbone is an encoder. '
                        + text + '</p>' + suffix + '</div>')
    raw = doc.tobytes()
    projection = new.extract_pdf_quote_document(raw)['normalizedFullText']
    start = projection.index('We use AdamW')
    end = projection.index('respectively.', start) + len('respectively.')
    return raw, projection[start:end]

class GlyphEvidence(unittest.TestCase):
    def test_real_source_three_roles_and_original_protocol_bytes_unchanged(self):
        actual = new.extract_pdf_scientific_quantities(pdf, quotes)
        self.assertEqual(new.stable(actual['document']), fixture['legacyDocumentCanonicalSha256'])
        for index, result in enumerate(actual['results']):
            self.assertTrue(result['eligible'])
            self.assertEqual(new.stable(result['evidence']), fixture['legacyQuoteEvidenceCanonicalSha256'][index])
        atoms = actual['results'][0]['scientificQuantities']
        self.assertEqual([(a['role'],a['coefficient'],a['signedExponent'],a['unit']) for a in atoms],
                         [('SFT','1','-4',''),('RL-Stage I','2','-6',''),('RL-Stage II','5','-6','')])
        self.assertEqual({a['page'] for a in atoms}, {5})
        self.assertEqual(len({a['lineRawStartCodePoint'] for a in atoms}), 1)
        for atom in atoms:
            self.assertEqual(Q[atom['quoteStartCodePoint']:atom['quoteEndCodePoint']], atom['text'])
            self.assertEqual(atom['pdfSha256'], hashlib.sha256(pdf).hexdigest())
        self.assertTrue(all(not r['scientificQuantities'] for r in actual['results'][1:]))

    def test_baseline_subtraction_and_invalid_exponent_typography_refused(self):
        for style in ['baseline','small-baseline','large-super','tiny-super']:
            with self.subTest(style=style):
                raw, quote = synthetic(style=style)
                result = extract(raw, quote)
                self.assertTrue(result['eligible'], 'the whole exact quote itself is real in this synthetic PDF')
                self.assertEqual(result['scientificQuantities'], [])
        raw, quote = synthetic(split=True)
        self.assertTrue(extract(raw, quote)['eligible'])
        self.assertEqual(extract(raw, quote)['scientificQuantities'], [])

    def test_foreign_hypothetical_quoted_and_revoked_scope_refused(self):
        prefixes = ['Previous work.','Related Work.','Other work.','External research.',
                    'Third-party study.','Quotation','Hypothetical experiment.',
                    'This schedule was not used.','These settings were not implemented.',
                    'We did not adopt this schedule.','This was never actually implemented.',
                    'We abandoned this schedule.','"','‘','>']
        for prefix in prefixes:
            with self.subTest(prefix=prefix):
                raw, quote = synthetic(prefix='<p>'+prefix+'</p>')
                self.assertEqual(extract(raw, quote)['scientificQuantities'], [])
        for suffix in ['This schedule was not used.','This was only hypothetical.', 'We abandoned this schedule.']:
            with self.subTest(suffix=suffix):
                raw, quote = synthetic(suffix='<p>'+suffix+'</p>')
                self.assertEqual(extract(raw, quote)['scientificQuantities'], [])

    def test_wrong_roles_units_or_partial_quotations_do_not_form_schedule(self):
        for changed in [Q.replace('SFT, RL-Stage I', 'RL-Stage I, SFT'),
                        Q.replace('1×10−4,','1×10−4 ms,'), Q.replace('1×10−4','１×10−4'),
                        Q.replace('RL-Stage II','RL-Stage III')]:
            raw, quote = synthetic(changed)
            self.assertTrue(extract(raw, quote)['eligible'])
            self.assertEqual(extract(raw, quote)['scientificQuantities'], [])
        parts = ['We use AdamW with learning rates of 1×10−4,',
                 '2×10−6, and 5×10−6 for SFT, RL-Stage I, and RL-Stage II, respectively.']
        result = new.extract_pdf_scientific_quantities(pdf, parts)
        self.assertTrue(all(r['eligible'] for r in result['results']))
        self.assertTrue(all(not r['scientificQuantities'] for r in result['results']))
        self.assertFalse(extract(pdf,Q.replace('1×10−4','1×10−9'))['eligible'])
        with self.assertRaises(ValueError):
            new.extract_pdf_scientific_quantities(pdf,[{'quote':Q,'scientificQuantities':[{'coefficient':'1'}]}])

    def test_numeric_values_are_source_glyphs_not_a_value_allowlist(self):
        changed = Q.replace('1×10−4','2.5×10−12').replace('2×10−6','3×10−7').replace('5×10−6','7×10−8')
        raw, quote = synthetic(changed)
        atoms = extract(raw,quote)['scientificQuantities']
        self.assertEqual([(a['coefficient'],a['signedExponent']) for a in atoms],[('2.5','-12'),('3','-7'),('7','-8')])

    def test_adjacent_page_foreign_or_direct_withdrawal_does_not_reset(self):
        with fitz.open(stream=pdf,filetype='pdf') as original:
            real_pair=fitz.open()
            real_pair.insert_pdf(original,from_page=3,to_page=4)
            self.assertEqual(len(extract(real_pair.tobytes())['scientificQuantities']),3)
            for prefix in ['Related Work.','Other work.','Previous work.','Quotation',
                           'Hypothetical experiment.','This schedule was not used.',
                           'These settings were not implemented.','We did not adopt this schedule.']:
                with self.subTest(previousPage=prefix):
                    generated=fitz.open();page=generated.new_page()
                    page.insert_text((54,40),'Source excerpt.\n'+prefix,fontsize=11)
                    generated.insert_pdf(original,from_page=4,to_page=4)
                    self.assertEqual(extract(generated.tobytes())['scientificQuantities'],[])

if __name__ == '__main__':
    unittest.main(verbosity=2)
