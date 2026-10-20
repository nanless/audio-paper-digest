"""Literal metadata dollars are escaped only at the authenticated author display."""
import copy
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_env_isolation import project_env_scope
from markdown_hugo_gate import mask_source_bound_author_dollars, math_and_emphasis_issues
SPEC = importlib.util.spec_from_file_location('author_dollar_publisher_tests', ROOT / 'scripts/publish-to-blog.py')
publisher = importlib.util.module_from_spec(SPEC)
with project_env_scope():
    SPEC.loader.exec_module(publisher)


class SourceAuthorDollarTests(unittest.TestCase):
    def artifact(self, body=None):
        return {'body': body if body is not None else '## 👥 作者与机构\n\n- Rui Gong\\$：Org\n',
                'frontmatter': {'paper_digest_api_reader_author_identity_contract': 'api-reader-author-identity-v1',
                    'paper_digest_api_reader_author_identity_sha256': 'a' * 64,
                    'paper_digest_api_reader_author_count': 1,
                    'paper_digest_authors': [{'name': 'Rui Gong$', 'affiliations': ['Org']}]}}

    def html(self, item='Rui Gong$：Org'):
        return '<h2>👥 作者与机构</h2><ul><li>' + item + '</li></ul>'

    def test_complete_verified_source_literal_is_escaped_without_mutation(self):
        authors = [{'name': 'Rui Gong$', 'affiliations': ['Org$']}]
        before = copy.deepcopy(authors)
        rendered = publisher.render_verified_reader_authors(authors)
        self.assertIn(r'Rui Gong\$', rendered)
        self.assertIn(r'Org\$', rendered)
        self.assertEqual(authors, before)
        self.assertEqual(math_and_emphasis_issues(self.artifact()['body'], 'Markdown'), [])
        masked = mask_source_bound_author_dollars(self.html(), self.artifact())
        self.assertNotIn('$', masked)
        self.assertEqual(math_and_emphasis_issues(masked, 'HTML', rendered_html=True), [])

    def test_source_metadata_and_every_dollar_must_match(self):
        for source in ('## 👥 作者与机构\n\n- Rui Gong$：Org\n',
                       '## 👥 作者与机构\n\n- Rui Gong\\$：Org$$\n',
                       '## 👥 作者与机构\n\n- Rui Gong\\\\$：Org\n',
                       '## Other\n\n- Rui Gong\\$：Org\n',
                       '## 👥 作者与机构\n\n- Other\\$：Org\n'):
            with self.subTest(source=source):
                self.assertEqual(mask_source_bound_author_dollars(self.html(), self.artifact(source)), self.html())
        for key in ('paper_digest_api_reader_author_identity_contract', 'paper_digest_api_reader_author_identity_sha256', 'paper_digest_authors'):
            artifact = self.artifact(); artifact['frontmatter'].pop(key)
            self.assertEqual(mask_source_bound_author_dollars(self.html(), artifact), self.html())
        self.assertEqual(mask_source_bound_author_dollars(self.html(), {'body': self.artifact()['body']}), self.html())

    def test_mixed_unescaped_dollars_and_even_slashes_fail_even_when_metadata_matches(self):
        artifact = self.artifact('## 👥 作者与机构\n\n- Rui Gong\\$：Org$$\n')
        artifact['frontmatter']['paper_digest_authors'][0]['affiliations'] = ['Org$$']
        page = self.html('Rui Gong$：Org$$')
        self.assertEqual(mask_source_bound_author_dollars(page, artifact), page)
        artifact = self.artifact('## 👥 作者与机构\n\n- Rui Gong\\\\$：Org\n')
        artifact['frontmatter']['paper_digest_authors'][0]['name'] = 'Rui Gong\\$'
        page = self.html('Rui Gong\\$：Org')
        self.assertEqual(mask_source_bound_author_dollars(page, artifact), page)

    def test_index_author_block_is_bound_to_the_original_renderer(self):
        paper = {'arxivId': '2610.24681v1'}
        content = ('## 📋 论文列表\n### Example\n[原文](https://arxiv.org/abs/2610.24681v1)\n\n'
                   '👥 **作者与机构**\n\n- Rui Gong\\$：Org\n\n'
                   '📌 **核心摘要**\n\nSummary\n\n🔗 **开源资源**\n\nResources\n\n---')
        with mock.patch.object(publisher, '_api_reader_payload', return_value={}), \
             mock.patch.object(publisher, '_build_api_reader_display_fields', return_value={'summary': 'Summary', 'opensource': 'Resources'}), \
             mock.patch.object(publisher, '_visible_arxiv_source_url', return_value='https://arxiv.org/abs/2610.24681v1'), \
             mock.patch.object(publisher, '_render_api_reader_author_block', return_value='- Rui Gong\\$：Org'):
            self.assertIsNone(publisher._api_reader_index_display_fields_issue(content, [paper]))
            for changed in (content.replace('Rui Gong', 'Other'), content.replace('Org', 'Else'), content.replace('Gong\\$', 'Gong$')):
                self.assertIn('作者机构', publisher._api_reader_index_display_fields_issue(changed, [paper]))

    def test_entire_visible_list_and_strict_html_structure_are_required(self):
        pages = [self.html('Other$：Org'), self.html('Rui Gong$：Else'),
                 self.html('Rui Gong$：Org extra'), self.html('Rui Gong$：<span>Org</span>'),
                 self.html('Rui Gong$：<a href="x">Org</a>'), self.html('Rui Gong$：Org<!--x-->'),
                 '<h2>👥 作者与机构</h2><ul hidden><li>Rui Gong$：Org</li></ul>',
                 '<h2>👥 作者与机构</h2><ul><li hidden>Rui Gong$：Org</li></ul>',
                 '<h2>👥 作者与机构</h2><ul><li id="x" id="y">Rui Gong$：Org</li></ul>',
                 '<h2>👥 作者与机构</h2><ul><li>Rui Gong$：Org</em></li></ul>',
                 '<h2>👥 作者与机构</h2><ul><li>Rui Gong$：Org</ul>',
                 '<h2>👥 作者与机构</h2><ul><li>Rui Gong$：Org</li><li>Rui Gong$：Org</li></ul>',
                 '<h2>Other</h2><ul><li>Rui Gong$：Org</li></ul>',
                 '<p>👥 作者与机构</p><ul><li>Rui Gong$：Org</li></ul>',
                 '<h2>作者与机构</h2><ul><li>Rui Gong$：Org</li></ul>',
                 '<h2><strong>👥 作者与机构</strong></h2><ul><li>Rui Gong$：Org</li></ul>',
                 '<h2><strong hidden>👥 作者与机构</strong></h2><ul><li>Rui Gong$：Org</li></ul>']
        for page in pages:
            with self.subTest(page=page):
                self.assertIn('$', mask_source_bound_author_dollars(page, self.artifact()))

    def test_exact_actual_hugo_heading_anchor_only(self):
        heading = '<h2 id="-作者与机构">👥 作者与机构<a hidden class="anchor" aria-hidden="true" href="#-作者与机构">#</a></h2>'
        page = heading + '<ul><li>Rui Gong$：Org</li></ul>'
        self.assertNotIn('$', mask_source_bound_author_dollars(page, self.artifact()))
        for changed in (page.replace('href="#-作者与机构"', 'href="#other"'),
                        page.replace('>#</a>', '>hidden text</a>'),
                        page.replace('>#</a>', '><strong>#</strong></a>'),
                        page.replace('class="anchor"', 'class="other"'),
                        page.replace('id="-作者与机构"', 'id="other"')):
            self.assertIn('$', mask_source_bound_author_dollars(changed, self.artifact()))

    def test_other_lists_prose_and_math_are_never_waived(self):
        for suffix in ('<p>$x$</p>', '<p>$$x$$</p>', '<ul><li>Rui Gong$：Org</li></ul>', '<p>extra$</p>'):
            result = mask_source_bound_author_dollars(self.html() + suffix, self.artifact())
            self.assertTrue(math_and_emphasis_issues(result, 'HTML', rendered_html=True))

if __name__ == '__main__':
    unittest.main()
