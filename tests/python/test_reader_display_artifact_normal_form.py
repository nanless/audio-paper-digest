"""Publisher display normalization is a fixed point without editing evidence."""
import unittest
from test_publish_to_blog import publish_to_blog as blog

class ReaderDisplayArtifactNormalFormTests(unittest.TestCase):
    def test_all_adjacent_identical_heading_copies_collapse_once(self):
        for count in [1, 2, 3, 4, 12]:
            for title in ['机制组合', 'CLAP × SongEval × Audiobox-Aesthetics', '成本 2 ms']:
                for colon in ['：', ':']:
                    for whitespace in [' ', '  ', '\t']:
                        with self.subTest(count=count,title=title,colon=colon,space=whitespace):
                            unit = f'**{title}{colon}**'
                            text = whitespace.join(f'**{whitespace}{title}{colon}**' for _ in range(count)) + whitespace + '来源正文为 73.35，单位 ms，不作改写。'
                            normalized = blog._normalize_api_reader_display_artifacts(text)
                            self.assertEqual(blog._normalize_api_reader_display_artifacts(normalized), normalized)
                            if count > 1:
                                self.assertEqual(normalized, unit + ' 来源正文为 73.35，单位 ms，不作改写。')
                            else:
                                self.assertEqual(normalized, text)

    def test_distinct_titles_values_units_and_colons_stay_distinct(self):
        cases = [
            '**成本 2 ms：** **成本 3 ms：** 来源正文。',
            '**成本 2 ms：** **成本 2 s：** 来源正文。',
            '**机制甲：** **机制乙：** 来源正文。',
            '**机制：** **机制:** 来源正文。',
            '**机制：** **机 制：** 来源正文。',
        ]
        for text in cases:
            self.assertEqual(blog._normalize_api_reader_display_artifacts(text), text)

    def test_paragraph_and_line_boundaries_never_merge_headings(self):
        for separator in ['\n', '\n\n', '\n\n---\n\n']:
            text = '**机制：**' + separator + '**机制：** 原数字 2 ms 与 URL https://example.org/path。'
            self.assertEqual(blog._normalize_api_reader_display_artifacts(text), text)

    def test_only_redundant_prefix_changes_and_reader_body_tampering_still_visible(self):
        body = '原文 73.35%，2 ms；`<p>`；[来源](https://example.org/paper)。'
        text = '**机制：** **机制：** **机制：** ' + body
        expected = '**机制：** ' + body
        normalized = blog._normalize_api_reader_display_artifacts(text)
        self.assertEqual(normalized, expected)
        self.assertNotEqual(blog._normalize_api_reader_display_artifacts(text.replace('73.35', '73.36')), expected)
        self.assertEqual(blog.sanitize_markdown_for_publish(blog.sanitize_markdown_for_publish(normalized)), blog.sanitize_markdown_for_publish(normalized))

if __name__ == '__main__':
    unittest.main()
