"""Index-only quality checks never cross a copied paper component's boundary."""
import unittest
from unittest import mock
from urllib.parse import quote
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from publish_common import validate_digest_index_reader_quality, dedupe_image_alts

HEADER = ('---\npaper_digest_page_type: index\n'
          'paper_digest_reader_quality: reader-facing-v3\n---\n'
          '## 今日概览\n\n本页整理对应论文的研究问题与已绑定的来源信息。\n\n'
          '## 论文列表\n\n')
ENTRY = '### 1. [论文](https://example.org/posts/paper/)\n\n'

class DigestIndexComponentBoundaryTests(unittest.TestCase):
    def check(self, text):
        return validate_digest_index_reader_quality(HEADER + text, required=True)

    def test_summary_without_resources_stops_at_separator_next_paper_or_eof(self):
        for end in ['\n\n---\n', '\n\n### 2. [后篇](https://example.org/posts/next/)\n\n', '']:
            with self.subTest(end=end):
                text = ENTRY + '📌 **核心摘要**\n\n单篇来源说明图2的结论。' + end
                before = text
                self.assertIsNone(self.check(text))
                self.assertEqual(text, before)

    def test_missing_resource_cannot_hide_next_entry_or_overview_typography(self):
        copied = ENTRY + '📌 **核心摘要**\n\n单篇来源摘要。\n\n'
        bad_next = '### 2. [后篇](https://example.org/posts/next/)\n\n汇总自身提到图2。\n\n'
        self.assertIn('数值排版', self.check(copied + bad_next))
        self.assertIn('数值排版', self.check(copied + '\n---\n\n汇总自身提到图2。'))
        page = HEADER.replace('## 论文列表', '📌 **核心摘要**\n\n汇总自身提到图2。\n\n## 论文列表') + copied
        self.assertIn('数值排版', validate_digest_index_reader_quality(page, required=True))

    def test_authors_and_resources_are_bounded_independently(self):
        for label in ['👥 **作者与机构**', '🔗 **开源资源**']:
            with self.subTest(label=label):
                copied = ENTRY + label + '\n\n' + ('- ' if label.startswith('👥') else '') + '已绑定内容中可含图2。\n\n'
                self.assertIsNone(self.check(copied))
                self.assertIn('数值排版', self.check(copied + '---\n\n汇总自身图2。'))
                next_entry = '### 2. [后篇](https://example.org/posts/next/)\n\n汇总自身图2。'
                self.assertIn('数值排版', self.check(copied + next_entry))

    def test_images_remain_checked_inside_every_borrowed_component(self):
        for label in ['👥 **作者与机构**', '📌 **核心摘要**', '🔗 **开源资源**']:
            with self.subTest(label=label):
                copied = ENTRY + label + '\n\n' + ('- ' if label.startswith('👥') else '') + '来源正文。\n\n![图2](https://example.org/image.png)\n\n'
                self.assertIn('数值排版', self.check(copied))
                self.assertIsNone(self.check(copied.replace('![图2]', '![图 2]')))

    def test_only_current_root_task_overview_navigation_is_metadata(self):
        from tag_catalog import load_tag_catalog
        from tag_presentation import mask_verified_overview_root_task_links_for_quality
        root = next(n for n in load_tag_catalog()['concepts'] if n['id'] == 'task.audio-driven-3d-generation')
        label = root['preferredLabel']['zh']
        self.assertIn('三维', label)
        for base in ('/audio-paper-digest-blog', '/custom/site', ''):
            with mock.patch.dict('os.environ', {'PAPER_DIGEST_BLOG_BASE_PATH': base}):
                link = f'[{label}]({base}/papers/?concept={quote(root["id"], safe="")})'
                page = HEADER.replace('## 论文列表', f'| 主任务 |\n|---|\n| {link} |\n\n## 论文列表') + ENTRY
                before = page
                self.assertIsNone(validate_digest_index_reader_quality(page, required=True))
                self.assertEqual(page, before)
                masked = mask_verified_overview_root_task_links_for_quality(page)
                self.assertEqual(len(masked), len(page))
                self.assertNotIn(link, masked)
                for wrong in (link.replace(label, label + '三次'),
                              link.replace(root['id'], 'task.asr'),
                              link.replace(root['id'], 'task.av-speech-separation'),
                              link.replace('/papers/', '/wrong/'),
                              link.replace('concept=', 'other='),
                              link.replace('/papers/', '/papers/?extra=1&'),
                              f'[{label}](https://example.org/papers/?concept={root["id"]})'):
                    self.assertIn('精确定量', validate_digest_index_reader_quality(page.replace(link, wrong), required=True))
                # The same canonical link cannot hide scientific text after the list boundary.
                self.assertIn('精确定量', validate_digest_index_reader_quality(HEADER + ENTRY + link, required=True))
                self.assertIn('精确定量', validate_digest_index_reader_quality(page + '\n\n三维特征在三次运行中测量。', required=True))
                self.assertIn('精确定量', validate_digest_index_reader_quality(page.replace(link, '三维'), required=True))
                self.assertIn('精确定量', validate_digest_index_reader_quality(page.replace(link, '三次运行'), required=True))
                # Image alt text is not navigation metadata.
                self.assertIn('精确定量', validate_digest_index_reader_quality(page.replace(link, '!' + link), required=True))

    def test_source_links_and_duplicate_alt_generator_preserve_values(self):
        source = '![原文图 1](https://example.org/fig2.png)\n![same](a.png)\n![same](b.png)\n![](c.png)'
        actual = dedupe_image_alts(source)
        self.assertIn('![原文图 1](https://example.org/fig2.png)', actual)
        self.assertIn('![same - 图 2](b.png)', actual)
        self.assertIn('![论文图 4](c.png)', actual)
        self.assertEqual(source.splitlines()[0], actual.splitlines()[0])

if __name__ == '__main__':
    unittest.main()
