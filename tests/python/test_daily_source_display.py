"""Publication-only display of unchanged real saved source captions/headers."""
import copy
import hashlib
import json
from pathlib import Path
import unittest
from test_publish_to_blog import publish_to_blog as blog
from publish_common import strict_source_cell_math_display

ROOT = Path(__file__).resolve().parents[2]
RAW = (ROOT / 'tests/fixtures/daily-source-display-20261021-real.json').read_bytes()
assert hashlib.sha256(RAW).hexdigest() == 'aba809e9cfef540c2a59ce7463cff05ef403647c83b3d716145e5621bb88a862'
FIXTURE = json.loads(RAW)


class DailySourceDisplayTests(unittest.TestCase):
    def test_real_complete_bound_headers_project_exact_tex_and_keep_other_bytes(self):
        case = FIXTURE['headers']
        self.assertEqual(hashlib.sha256(case['article'].encode()).hexdigest(), case['articleSha256'])
        before = copy.deepcopy(case)
        actual = blog._project_bound_source_cell_math_display(case['article'], case['plan'])
        table = blog._api_reader_markdown_tables(actual)[0]
        self.assertEqual(table['header'], case['expectedHeaders'])
        restored = actual
        for cell in case['plan']['tableBindings'][0]['cellBindings']:
            proof = strict_source_cell_math_display(cell['sourceText'])
            if proof:
                restored = restored.replace(proof['displayText'], proof['sourceText'])
        self.assertEqual(restored, case['article'])
        self.assertEqual(case, before)
        unbound = copy.deepcopy(case['plan'])
        unbound['tableBindings'][0]['sourceType'] = 'source_quotes'
        self.assertEqual(blog._project_bound_source_cell_math_display(case['article'], unbound), case['article'])

    def test_identifier_scripts_never_guess_another_symbol_value_or_annotation(self):
        for raw in ['T_{v}', 'TvT_{w}', 'TvX_{v}', 'TwrongT_{v}',
                    'TmodelaT^{model}_{b}', 'dmodeld^{model}^{model}',
                    'dmodeld^{model} ms', 'T1T_{2}', 'TvT_v', 'TvT_{v}\n']:
            with self.subTest(raw=raw):
                self.assertIsNone(strict_source_cell_math_display(raw))
        for raw, expected in [('T1T_{1}', r'\(T_{1}\)'),
                              ('TamodelT^{model}_{a}', r'\(T^{model}_{a}\)'),
                              ('TmodelaT_{a}^{model}', r'\(T_{a}^{model}\)')]:
            proof = strict_source_cell_math_display(raw)
            self.assertEqual(proof['displayText'], expected)
            self.assertEqual(proof['sourceText'], raw)

    def test_real_same_source_caption_tokens_are_visible_and_canonical_reader_unchanged(self):
        case = FIXTURE['caption']
        self.assertEqual(hashlib.sha256(case['article'].encode()).hexdigest(), case['articleSha256'])
        before = copy.deepcopy(case)
        actual = blog.render_ephemeral_api_reader_figures(case['article'], case['figures'])
        for token in ['<Visual.>', '<Independent.>', '<Silence.>']:
            self.assertIn('`' + token + '`', actual)
            actual = actual.replace('`' + token + '`', token)
        self.assertEqual(actual, case['article'])
        once = blog.render_ephemeral_api_reader_figures(case['article'], case['figures'])
        self.assertEqual(blog.render_ephemeral_api_reader_figures(once, case['figures']), once)
        self.assertEqual(case, before)

    def test_token_projection_requires_exact_adjacent_caption_and_same_image_url(self):
        figure = {'ordinal': 2, 'label': 'Figure 2:', 'url': 'https://arxiv.org/html/example/figure.png',
                  'caption': 'Figure 2: Examples. <Visual.> indicates a visual query.'}
        image = '![A <Visual.> example](' + figure['url'] + ')'
        note = '*论文图 2。原论文 Figure 2:：“Examples. <Visual.> indicates a visual query.”。*'
        expected = (image.replace('<Visual.>', '`<Visual.>`'), note.replace('<Visual.>', '`<Visual.>`'))
        self.assertEqual(blog._source_bound_figure_literal_tokens(image, note, figure), expected)
        self.assertEqual(blog._source_bound_figure_literal_tokens(*expected, figure), expected)
        for bad_image, bad_note, bad_figure in [
                (image.replace('figure.png', 'other.png'), note, figure),
                (image, note.replace('Figure 2:', 'Figure 3:'), figure),
                (image, note.replace('visual query', 'another claim'), figure),
                (image, note, {**figure, 'caption': 'Figure 2: No token in this caption.'})]:
            self.assertEqual(blog._source_bound_figure_literal_tokens(bad_image, bad_note, bad_figure), (bad_image, bad_note))
        fenced = '```markdown\n' + image + '\n\n' + note + '\n```\n\n'
        actual = blog.render_ephemeral_api_reader_figures(fenced + image + '\n\n' + note, [figure])
        self.assertTrue(actual.startswith(fenced))
        self.assertEqual(actual[len(fenced):], expected[0] + '\n\n' + expected[1])


if __name__ == '__main__':
    unittest.main()
