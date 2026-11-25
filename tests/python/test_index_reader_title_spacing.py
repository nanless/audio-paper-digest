import copy
import unittest

from test_publish_to_blog import (
    llm_api_publication_fixture,
    publish_to_blog as blog,
    reseal_llm_api_reader_fixture,
)
from publish_common import validate_manual_reader_quality


class IndexReaderTitleSpacingTests(unittest.TestCase):
    def test_hyphenated_model_boundary_changes_only_display_spacing(self):
        title = '把说话、看图和选动作装进一个检查点：DRVEXO-4B-统一系统解读'
        def quality(value):
            return validate_manual_reader_quality(
                '## 核心摘要\n### [' + value + '](/audio-research-portal/posts/drvexo)')
        self.assertIn('中英文技术词边界缺少空格',
                      quality(title))
        displayed = blog.digest_index_reader_title(title)
        self.assertEqual(displayed, title.replace('4B-统', '4B- 统'))
        self.assertIsNone(quality(displayed))
        # The source itself remains invalid; rendering does not relax the guard.
        self.assertIn('DRVEXO-4B-统',
                      quality(title))

    def test_model_internals_numbers_math_and_markdown_escaping_remain(self):
        for title in ['DRVEXO-4B-Unified', 'WeMM-Video-35B-A3B',
                      '3D Talking Face', 'Qwen3.5-Omni-Flash',
                      '已经分隔 DRVEXO-4B- 统一系统']:
            with self.subTest(title=title):
                self.assertEqual(blog.digest_index_reader_title(title), title)
        self.assertEqual(blog.digest_index_reader_title('中文DRVEXO-4B-统一系统'),
                         '中文 DRVEXO-4B- 统一系统')
        self.assertEqual(blog.digest_index_reader_title('模型$5*方案'),
                         blog.markdown_title_for_publish('模型$5*方案'))

    def test_both_index_routes_preserve_signed_paper_and_link_target(self):
        for scored_route in [True, False]:
            with self.subTest(scored=scored_route):
                paper = llm_api_publication_fixture()
                paper['apiReaderPlan']['readerTitle'] = '检查点：DRVEXO-4B-统一系统解读'
                reseal_llm_api_reader_fixture(paper)
                before = copy.deepcopy(paper)
                slug = 'drvexo-4b-unified-2608-30002'
                target = '/audio-research-portal/posts/2026-08-31-' + slug
                markdown = blog.generate_index_page(
                    [(6.1, paper, paper['parsed'])] if scored_route else [],
                    [] if scored_route else [paper], '2026-08-31',
                    {paper['arxivId']: slug})
                self.assertIn('[检查点：DRVEXO-4B- 统一系统解读](' + target + ')', markdown)
                self.assertNotIn('[检查点：DRVEXO-4B-统一系统解读]', markdown)
                self.assertIsNone(blog.validate_digest_index_reader_quality(markdown, required=True))
                self.assertEqual(paper, before)
