"""表格单元格同义 TeX 双写的显示投影：Python 与 Reader 共用同一套规则。

覆盖三件事：
1. 共享语料（tests/fixtures/reader-cell-tex-display.json）逐条一致；
2. 已核对 artifact_table 单元格只在页面显示时投影，保存的 Reader 字节不变；
3. 渲染后的表格不得残留裸 TeX，\\(...\\)、$...$ 与转义竖线不算残留。
"""
import json
import copy
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
    def test_page_preserves_final_source_cell_projection_without_normalizing_it_again(self):
        from test_table_currency_unit_literals import TableCurrencyUnitLiteralTest
        # The real FLUID source cell contains both minus and ± TeX copies.
        # Its bound final projection preserves the literal space before ±,
        # while another general display normalization would insert a new one.
        publisher, paper, _reseal = TableCurrencyUnitLiteralTest().currency_source_fixture(
            r'−-0.008 ±\pm0.026')
        before = copy.deepcopy(paper)
        payload = publisher._api_reader_payload(paper)
        self.assertIn('−0.008 ±0.026', payload['renderedArticle'])
        self.assertNotEqual(publisher._normalize_api_reader_display_artifacts(
            payload['renderedArticle']), payload['renderedArticle'])
        content, _slug = publisher.generate_paper_page(paper, '2026-08-31')
        self.assertIn('−0.008 ±0.026', content)
        self.assertIsNone(publisher._api_reader_page_binding_issue(content, paper))
        for changed in ('−0.008 ± 0.026', '−0.009 ±0.026'):
            with self.subTest(changed=changed):
                self.assertIn('正式 Reader 正文的渲染结果不一致',
                              publisher._api_reader_page_binding_issue(
                                  content.replace('−0.008 ±0.026', changed, 1), paper))
        self.assertEqual(paper, before)

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

    def test_single_digit_and_year_cells_are_not_folded_as_duplicates(self):
        """55、99 是正常数值，2020 是年份，都不能当成「重复写了两遍」折叠。"""
        for value in ('55', '99', '22', '2020', '2021'):
            self.assertEqual(publish._project_reader_cell_tex_display(value), value)
        for value, expected in (('6464', '64'), ('3232', '32'),
                                ('1616', '16'), ('100100', '100')):
            self.assertEqual(publish._project_reader_cell_tex_display(value), expected)

    def test_duplicate_numbers_never_cross_a_decimal_point(self):
        """`0.7070.707` 里的 7070 是两份 0.707 的接缝，不是重复写了两遍的整数。

        真实稿里出现过这个格；按整数折叠会得到 `0.70.707`，比原样保留更糟。
        小数双写本轮不折叠，与共享语料里的 2.222.22 / 3.093.09 保持一致。
        """
        for value in ('0.7070.707', '12.1212.12', '2.222.22', '3.093.09', '5.15.1 %'):
            with self.subTest(value=value):
                self.assertEqual(publish._project_reader_cell_tex_display(value), value)

    def test_years_inside_a_cell_are_not_folded_as_duplicates(self):
        """年份夹在文字或区间里时也不能折成两位数。"""
        for value in ('2020', '1919', '2020-2021', 'trained 2020', 'WER 2020'):
            with self.subTest(value=value):
                self.assertEqual(publish._project_reader_cell_tex_display(value), value)
        # 同一份年份确实写了两遍时仍然折叠。
        for value, expected in (('20192019', '2019'), ('20202020', '2020'),
                                ('3232 3232', '32 32')):
            with self.subTest(value=value):
                self.assertEqual(publish._project_reader_cell_tex_display(value), expected)

    def test_thousands_annotation_is_not_a_duplicate_value(self):
        self.assertEqual(publish._project_reader_cell_tex_display('55{,}00855{,}008'), '55,008')
        self.assertEqual(publish._project_reader_cell_tex_display('1{,}0241{,}024'), '1,024')
        # 负例：{,} 只是千位分隔写法，不能当成重复证据。
        self.assertEqual(publish._project_reader_cell_tex_display('1{,}5'), '1,5')
        self.assertEqual(publish._project_reader_cell_tex_display('1,024'), '1,024')

    def test_anonymous_macro_projects_only_the_anonymous_form(self):
        self.assertEqual(publish._project_reader_cell_tex_display(r'\anon[Anonymous Author]John'),
                         'Anonymous Author')
        self.assertEqual(publish._project_reader_cell_tex_display(r'\anon[匿名写法]RealName'),
                         '匿名写法')
        # 紧跟真实仓库地址时整条丢掉；只吃掉 https 会把地址留在页面上。
        projected = publish._project_reader_cell_tex_display(
            r'\anon[anonymised for review]https://github.com/jasper-zheng/music2latent-scripted')
        self.assertEqual(projected, 'anonymised for review')
        self.assertNotIn('github.com', projected)
        # 负例：不是这个宏的写法原样保留。
        for value in (r'\another[X]Name', 'anon[Anonymous]Name'):
            self.assertEqual(publish._project_reader_cell_tex_display(value), value)

    def test_inline_math_delimiters_are_only_wrappers(self):
        self.assertEqual(publish._project_reader_cell_tex_display(r'\(x^2\)'), 'x^2')
        self.assertEqual(publish._project_reader_cell_tex_display(r'\(a\)b'), 'ab')
        # 负例：普通括号与 $...$ 不是这两个定界符。
        for value in ('(a)', '$x$'):
            self.assertEqual(publish._project_reader_cell_tex_display(value), value)

    def test_repeated_signs_keep_one_copy_only_before_a_number(self):
        for value, expected in (('++0.0', '+0.0'), ('−-19.6', '−19.6'), ('+-3.2', '+3.2')):
            with self.subTest(value=value):
                self.assertEqual(publish._project_reader_cell_tex_display(value), expected)
        for value in ('+ 0.0', '--19.6', '±0.5', 'p<0.05'):
            with self.subTest(value=value):
                self.assertEqual(publish._project_reader_cell_tex_display(value), value)

    def test_simple_exponent_projects_to_the_visible_unicode_minus(self):
        self.assertEqual(publish._project_reader_cell_tex_display('10^{-4}'), '10−4')
        self.assertEqual(publish._project_reader_cell_tex_display('10^{−4}'), '10−4')
        # 负例：指数不是整数时没有等价可见写法，保留原样由裸 TeX 检查拒绝。
        raw = r'10^{-4.5}\mathrm{ms}'
        self.assertEqual(publish._project_reader_cell_tex_display(raw), raw)

    def test_whole_cell_sub_superscripts_use_the_visible_form(self):
        self.assertEqual(publish._project_reader_cell_tex_display('d_{z}'), 'dz')
        self.assertEqual(publish._project_reader_cell_tex_display('x_{i}^{2}'), 'xi2')
        # 负例：带命令或超长（不是「整格一小段上下标」）时保持不变。
        for value in (r'\mathrm{d}_{z}', 'd_{z}' + 'x' * 45):
            with self.subTest(value=value):
                self.assertEqual(publish._project_reader_cell_tex_display(value), value)

    def test_symbol_table_covers_the_commands_the_reader_knows(self):
        """JS 侧符号表必须和这里一致，否则分析端会留下 TeX、发布端却折叠。"""
        for value, expected in ((r'A∅\varnothing', 'A∅'), (r'AB∅\emptyset', 'AB∅'),
                                (r'AB∘\circ', 'AB∘'), (r'AB⋆\star', 'AB⋆'),
                                (r'AB•\bullet', 'AB•'), (r'AB′\prime', 'AB′'),
                                # 整格只有一个可见符号 + 同义命令时同样是完整双写。
                                (r'∅\varnothing', '∅'), (r'∘\circ', '∘'),
                                (r'⋆\star', '⋆'), (r'•\bullet', '•'),
                                (r'′\prime', '′'), (r'∅\emptyset', '∅')):
            with self.subTest(value=value):
                self.assertEqual(publish._project_reader_cell_tex_display(value), expected)
        # 负例：命令值不同（∅ 与 ∘）时不是重复，保留原样由裸 TeX 检查拒绝。
        self.assertEqual(publish._project_reader_cell_tex_display(r'∅\circ'), r'∅\circ')

    def test_brace_sub_superscript_duplicate_drops_the_annotation(self):
        self.assertEqual(publish._project_reader_cell_tex_display(r'abc{}_{a}^{c}'), 'abc')
        self.assertEqual(publish._project_reader_cell_tex_display(r'test{}_{t}^{st}'), 'test')
        self.assertEqual(
            publish._project_reader_cell_tex_display(
                r'vv-MF∅CFGmSTFT{}_{\mathrm{mSTFT}}^{\varnothing\mathrm{CFG}}'),
            'vv-MF∅CFGmSTFT')
        # 负例：副本里有可见部分没有的字符时不能删。
        raw = r'AB{}_{cd}^{\mathrm{int}}'
        self.assertEqual(publish._project_reader_cell_tex_display(raw), raw)

    def test_projection_stays_comparable_with_the_saved_source_cell(self):
        """投影只改显示：折叠后的可见值必须仍能和保存的原单元格比较相等。"""
        for source, projected in (('3232', '32'), ('55{,}00855{,}008', '55,008'),
                                  ('d_{z}', 'dz'), ('10^{-4}', '10−4'), ('x_{i}^{2}', 'xi2'),
                                  (r'abc{}_{a}^{c}', 'abc'),
                                  (r'vv-MF∅CFGmSTFT{}_{\mathrm{mSTFT}}^{\varnothing\mathrm{CFG}}',
                                   'vv-MF∅CFGmSTFT')):
            with self.subTest(source=source):
                self.assertEqual(publish._reader_cell_comparison(source),
                                 publish._reader_cell_comparison(projected))


if __name__ == '__main__':
    unittest.main()
