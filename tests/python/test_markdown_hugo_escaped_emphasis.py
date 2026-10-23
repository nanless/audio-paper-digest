"""Escaped-star spacing regression, with actual Goldmark output.

The raw prefix was supplied by the daily owner from a failed Reader line; its
explanation is deliberately elided. Other cases are mechanical variants, not
complete paid manuscripts or source-authority fixtures.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from markdown_hugo_gate import math_and_emphasis_issues
from publish_common import sanitize_markdown_for_publish


RAW = '**CFG-Zero* × 权重 λ：** **CFG-Zero* × 权重 λ：** CFG-Zero* 指…'
SINGLE = r'**CFG-Zero\* × 权重 λ：** CFG-Zero* 指…'
ADJACENT = r'**CFG-Zero\* × 权重 λ：** **CFG-Zero\* × 权重 λ：** CFG-Zero* 指…'
TIGHT = r'**CFG-Zero\* × 权重 λ：**正文'


class EscapedStrongSpacingTests(unittest.TestCase):
    def test_escaped_stars_in_adjacent_strong_do_not_borrow_delimiters(self):
        for text in [ADJACENT, r'**带\*号** **另\*一项** 说明。']:
            with self.subTest(text=text):
                self.assertEqual(math_and_emphasis_issues(text, 'fragment'), [])

    def test_escaped_literal_star_closing_still_rejects_glued_text(self):
        for text in [TIGHT, r'**带\*号**word', r'**带\*号**9',
                     r'**路径\\**正文', r'**普通强调**正文']:
            with self.subTest(text=text):
                self.assertTrue(any('加粗结束符后紧贴正文' in issue
                                    for issue in math_and_emphasis_issues(text, 'fragment')))

    def test_original_broken_raw_prefix_and_code_boundaries_are_preserved(self):
        self.assertTrue(math_and_emphasis_issues(RAW, 'fragment'))
        self.assertEqual(math_and_emphasis_issues('`' + TIGHT + '`', 'code'), [])
        self.assertEqual(math_and_emphasis_issues('```text\n' + TIGHT + '\n```', 'code'), [])

    def test_actual_hugo_preserves_escaped_names_and_exposes_bad_variants(self):
        hugo = shutil.which('hugo')
        if not hugo:
            if os.environ.get('REQUIRE_HUGO_INTEGRATION_TESTS') == '1' or os.environ.get('PD_REQUIRE_HUGO_TESTS') == '1':
                self.fail('real Hugo is required')
            self.skipTest('real Hugo is unavailable')
        cases = {
            'raw': (RAW, '<p><em><em>CFG-Zero</em> × 权重 λ：</em>* <em><em>CFG-Zero</em> × 权重 λ：</em>* CFG-Zero* 指…</p>', True),
            'single': (SINGLE, '<p><strong>CFG-Zero* × 权重 λ：</strong> CFG-Zero* 指…</p>', False),
            'adjacent': (ADJACENT, '<p><strong>CFG-Zero* × 权重 λ：</strong> <strong>CFG-Zero* × 权重 λ：</strong> CFG-Zero* 指…</p>', False),
            'tight': (TIGHT, '<p>**CFG-Zero* × 权重 λ：**正文</p>', True),
        }
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            (project / 'content').mkdir()
            (project / 'layouts/_default').mkdir(parents=True)
            (project / 'hugo.toml').write_text('baseURL = "https://example.test/"\n', encoding='utf8')
            (project / 'layouts/_default/single.html').write_text('{{ .Content }}', encoding='utf8')
            for name, (raw, _expected, _rejected) in cases.items():
                sanitized = sanitize_markdown_for_publish(raw)
                self.assertEqual(sanitized, raw)
                (project / f'content/{name}.md').write_text(
                    '---\ntitle: "Local emphasis fragment"\n---\n\n' + sanitized,
                    encoding='utf8')
            result = subprocess.run(
                [hugo, '--source', str(project), '--destination', str(project / 'public'),
                 '--cacheDir', str(project / 'cache'), '--quiet'],
                capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            for name, (raw, expected, rejected) in cases.items():
                with self.subTest(case=name):
                    self.assertEqual((project / f'public/{name}/index.html').read_text(encoding='utf8').strip(), expected)
                    self.assertEqual(bool(math_and_emphasis_issues(raw, name)), rejected)


if __name__ == '__main__':
    unittest.main()
