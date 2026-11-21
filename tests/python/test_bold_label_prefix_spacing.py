"""Keep explanation words intact while correcting CommonMark delimiter spacing."""
import unittest
from test_publish_to_blog import publish_to_blog as blog
from publish_common import normalize_bold_label_prefix_spacing
from markdown_hugo_gate import math_and_emphasis_issues


class BoldLabelPrefixSpacingTests(unittest.TestCase):
    def test_real_core_summary_labels_separate_the_original_following_text(self):
        for label, body in [
            ('问题与瓶颈', '输入是带停顿、修正和打断的英语口语请求。'),
            ('思路与架构', '核心洞察是把后端也看成一个工具。'),
            ('对比与代价', '同一 Qwen3-8B 后端和同一流式管线下。'),
            ('边界与导读', '结论成立于预录单轮请求。'),
            ('核心思路与方法架构', '论文先把时间条件视频补全作为先验。'),
        ]:
            for lead in ['', '> ']:
                raw = lead + '**' + label + '：**' + body
                expected = lead + '**' + label + '：** ' + body
                with self.subTest(label=label, lead=lead):
                    self.assertTrue(math_and_emphasis_issues(raw, 'before'))
                    self.assertEqual(normalize_bold_label_prefix_spacing(raw), expected)
                    self.assertEqual(normalize_bold_label_prefix_spacing(expected), expected)
                    self.assertEqual(math_and_emphasis_issues(expected, 'after'), [])
                    self.assertEqual(blog.sanitize_markdown_for_publish(raw), expected)
                    self.assertTrue(math_and_emphasis_issues(raw, 'unchanged guard'))

    def test_label_body_separation_preserves_math_links_multiline_code_and_punctuation(self):
        label = '**问题与瓶颈：**输入'
        for text in [
            '`' + label + '`',
            '``code\n' + label + '\ncode``',
            '```md\n' + label + '\n```',
            '    ' + label,
            r'\[' + '\n' + label + '\n' + r'\]',
            r'\(' + '\n' + label + '\n' + r'\)',
            '[链接\n' + label + '](https://example.org/**问题：**输入)',
            '| 标签 | ' + label + ' |',
            '正文 ' + label,
            '**问题与瓶颈：**，输入。',
            '**问题与瓶颈：** 输入。',
            '**问题与瓶颈：**`输入`',
        ]:
            with self.subTest(text=text):
                self.assertEqual(normalize_bold_label_prefix_spacing(text), text)

    def test_different_adjacent_labels_keep_all_words_and_body(self):
        body = '正文包含 59、8 类、73.35%，2 ms 和 https://example.org/path。'
        for labels in [
            ['结构化音频特征 × AI verdict', '结构化音频特征与 AI verdict'],
            ['分数归一化 × 画廊亲和验证', '分数归一化 × 注册库亲和验证'],
            ['机制甲', '机制乙', '机制丙'],
        ]:
            for colon in ['：', ':']:
                for space in [' ', '  ', '\t']:
                    for lead in ['', '> ', '  ']:
                        text = lead + space.join('**' + space + label + colon + '**' for label in labels) + ' ' + body
                        expected = lead + space.join('**' + label + colon + '**' for label in labels) + ' ' + body
                        with self.subTest(labels=labels, colon=colon, space=space, lead=lead):
                            self.assertEqual(normalize_bold_label_prefix_spacing(text), expected)
                            self.assertEqual(normalize_bold_label_prefix_spacing(expected), expected)
                            self.assertEqual(blog.sanitize_markdown_for_publish(blog.sanitize_markdown_for_publish(text)), blog.sanitize_markdown_for_publish(text))

    def test_code_tables_and_nonprefix_text_are_preserved(self):
        broken = '**机制甲：** ** 机制乙：** 原数字 2 ms。'
        for text in [
            '```markdown\n' + broken + '\n```\n',
            '~~~~md\n' + broken + '\n~~~\n' + broken + '\n~~~~\n',
            '> ```markdown\n> ' + broken + '\n> ```\n',
            '    ' + broken,
            '| 标签 | ' + broken + ' |\n',
            '`' + broken + '`\n',
            '普通正文，' + broken,
            '**甲：**\n\n正文 ** 乙：** 内容。',
            '**甲：** ** $x$：** 正文。',
            '**甲：** ** [乙](https://example.org)：** 正文。',
        ]:
            with self.subTest(text=text):
                self.assertEqual(normalize_bold_label_prefix_spacing(text), text)

    def test_frontmatter_and_unpaired_inner_delimiter_are_preserved(self):
        text = '---\ntitle: "** 名称：**"\n---\n**甲：** ** 乙：** 正文。'
        rendered = blog.sanitize_markdown_for_publish(text)
        self.assertTrue(rendered.startswith('---\ntitle: "** 名称：**"\n---\n'))
        self.assertTrue(rendered.endswith('**甲：** **乙：** 正文。'))
        unpaired = '**甲：** ** 乙正文没有结束符'
        self.assertEqual(normalize_bold_label_prefix_spacing(unpaired), unpaired)


if __name__ == '__main__':
    unittest.main()
