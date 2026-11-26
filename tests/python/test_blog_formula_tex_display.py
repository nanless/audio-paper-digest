"""Regression tests for scripts/blog_formula_tex_display.py TeX duplicate folding and cross-runtime parity."""

import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import blog_formula_tex_display as py_tex  # noqa: E402


def _run_node_cell_projection(samples):
    env = {k: v for k, v in os.environ.items() if k != 'CODEX_SANDBOX'}
    env['VERIFY_PROJECT_DISABLE_FILE_LOGS'] = '1'
    proc = subprocess.run(
        [
            'node',
            '-e',
            "const fs=require('node:fs');"
            "const d=require('./scripts/lib/reader-source-display.js');"
            "const samples=JSON.parse(fs.readFileSync(0,'utf8'));"
            "process.stdout.write(JSON.stringify(samples.map(s => d.projectReaderCellTexDisplay(s))));",
        ],
        cwd=str(ROOT),
        input=json.dumps(samples, ensure_ascii=False),
        capture_output=True,
        text=True,
        timeout=30,
        env=env,
    )
    if proc.returncode != 0:
        raise AssertionError(f'Node projection failed ({proc.returncode}):\n{proc.stderr}')
    return json.loads(proc.stdout)


class BlogFormulaTexDisplayFoldingTest(unittest.TestCase):
    def test_word_boundary_offset_false_negatives_and_false_positives_parity(self):
        cases = [
            # False-negative fixes: true token start is preceded by non-alphanumeric boundary
            (r'Metric (SNR\mathrm{SNR})', 'Metric (SNR)'),
            (r'Sample rate (16kHz\mathrm{16kHz})', 'Sample rate (16kHz)'),
            (r'Window (20ms\mathrm{20ms})', 'Window (20ms)'),
            (r'Metric (f × 8{f}\times 8)', 'Metric (f × 8)'),
            (
                r'Aligned temporal granularity (†:f×8{}^{\dagger}\!:{f}\times 8; ‡:f×4{}^{\ddagger}\!:{f}\times 4)',
                'Aligned temporal granularity (†:f×8; ‡:f×4)',
            ),
            # False-positive fixes: true token start is preceded by alphanumeric/CJK character
            (r'Base12.3\mathrm{.3})', r'Base12.3\mathrm{.3})'),
            (r'foo1†:f×8{}^{\dagger}\!:{f}\times 8)', r'foo1†:f×8{}^{\dagger}\!:{f}\times 8)'),
            (r'中文SNR\mathrm{SNR})', r'中文SNR\mathrm{SNR})'),
        ]
        inputs = [raw for raw, _ in cases]
        js_outputs = _run_node_cell_projection(inputs)
        for (raw, expected), js_out in zip(cases, js_outputs):
            with self.subTest(raw=raw):
                py_out = py_tex._project_reader_cell_tex_display(raw)
                self.assertEqual(py_out, expected)
                self.assertEqual(py_tex._project_reader_cell_tex_display(py_out), py_out)
                self.assertEqual(js_out, expected)
                self.assertEqual(py_out, js_out)

    def test_direct_fold_helper_boundary_cases(self):
        self.assertEqual(py_tex._fold_reader_tex_cell_duplicate(r'Metric (SNR\mathrm{SNR})'), 'Metric (SNR)')
        self.assertEqual(py_tex._fold_reader_tex_cell_duplicate(r'Base12.3\mathrm{.3})'), r'Base12.3\mathrm{.3})')
        self.assertEqual(
            py_tex._fold_reader_tex_cell_duplicate(r'foo1†:f×8{}^{\dagger}\!:{f}\times 8)'),
            r'foo1†:f×8{}^{\dagger}\!:{f}\times 8)',
        )

    def test_all_shared_fixture_cases_remain_green_and_parity(self):
        fixture_path = ROOT / 'tests' / 'fixtures' / 'reader-cell-tex-display.json'
        payload = json.loads(fixture_path.read_text(encoding='utf-8'))
        cases = payload['cases']
        self.assertGreaterEqual(len(cases), 116)
        inputs = [item['input'] for item in cases]
        js_outputs = _run_node_cell_projection(inputs)
        for item, js_out in zip(cases, js_outputs):
            py_out = py_tex._project_reader_cell_tex_display(item['input'])
            self.assertEqual(py_out, item['expected'], f'Python fixture drift: {item["input"]!r}')
            self.assertEqual(js_out, item['expected'], f'JS fixture drift: {item["input"]!r}')


if __name__ == '__main__':
    unittest.main()
