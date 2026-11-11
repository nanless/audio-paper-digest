"""表格单元格同义 TeX 双写的显示投影：Python 与 Reader 共用同一套规则。

覆盖三件事：
1. 共享语料（tests/fixtures/reader-cell-tex-display.json）逐条一致；
2. 已核对 artifact_table 单元格只在页面显示时投影，保存的 Reader 字节不变；
3. 渲染后的表格不得残留裸 TeX，\\(...\\)、$...$ 与转义竖线不算残留。
"""
import json
import sys
import unittest
from pathlib import Path

ROOT = next(parent for parent in Path(__file__).resolve().parents
            if (parent / 'package.json').is_file() and (parent / 'scripts/publish_common.py').is_file())
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'tests/python'))

from project_env_isolation import project_env_scope  # noqa: E402
from blog_entry_loader import load_publish_to_blog  # noqa: E402

with project_env_scope():
    publish = load_publish_to_blog()

PARITY = json.loads((ROOT / 'tests/fixtures/reader-cell-tex-display.json').read_text())


class ReaderCellTexDisplayTest(unittest.TestCase):
    def test_shared_parity_corpus_matches_python_projection(self):
        self.assertEqual(PARITY['contract'], 'reader-cell-tex-display-parity-v1')
        self.assertGreaterEqual(len(PARITY['cases']), 40)
        for item in PARITY['cases']:
            with self.subTest(input=item['input']):
                self.assertEqual(publish._project_reader_cell_tex_display(item['input']), item['expected'])

    def test_unknown_commands_and_different_values_stay_raw(self):
        for value in ('k=\\tilde{k}', 'FD\\mathrm{FD_{norm}}', '\\unknowncommand'):
            with self.subTest(value=value):
                self.assertIn('\\', publish._project_reader_cell_tex_display(value))

    def test_artifact_cell_projection_keeps_saved_reader_bytes(self):
        source_cell = 'FDPANNs\\mathrm{\\textbf{FD}_{\\textbf{PANNs}}}↓'
        article = ('### 结果如何比较？\n\n'
                   f'| Method | {source_cell} |\n| --- | --- |\n| A | 1.0 |\n')
        plan = {'tableBindings': [{'tableIndex': 1, 'sourceType': 'artifact_table',
                                   'sourceTableOrdinal': 1, 'cellBindings': [
                                       {'renderedRow': 0, 'renderedColumn': 1,
                                        'sourceText': source_cell}]}]}
        projected = publish._project_artifact_table_cell_tex_display(article, plan)
        self.assertIn('| Method | FDPANNs↓ |', projected)
        self.assertNotIn('\\mathrm', projected)
        # 保存的来源文本与计划未被改写。
        self.assertEqual(plan['tableBindings'][0]['cellBindings'][0]['sourceText'], source_cell)
        self.assertEqual(article.count(source_cell), 1)

    def test_rendered_tables_must_not_keep_bare_tex(self):
        publish._assert_rendered_tables_have_no_bare_tex(
            '| Method | FDPANNs↓ |\n| --- | --- |\n| A | 1.0 |\n')
        publish._assert_rendered_tables_have_no_bare_tex(
            '| Model | formula | note |\n| --- | --- | --- |\n| A | \\(x^2\\) | 3.0 \\| 4.0 |\n')
        with self.assertRaises(publish.PublishDataValidationError):
            publish._assert_rendered_tables_have_no_bare_tex(
                '| Method | FDPANNs\\mathrm{FD}↓ |\n| --- | --- |\n| A | 1.0 |\n')
        with self.assertRaises(publish.PublishDataValidationError):
            publish._assert_rendered_tables_have_no_bare_tex(
                '| Model | value |\n| --- | --- |\n| A | 22.9\\tau |\n')


if __name__ == '__main__':
    unittest.main()
