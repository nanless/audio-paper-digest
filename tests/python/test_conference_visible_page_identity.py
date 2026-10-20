import json
from pathlib import Path
import sys
import unittest
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import conference_publication_gate as gate


class VisibleIdentityTests(unittest.TestCase):
    url = 'https://example.invalid/posts/fixture/'
    def page(self):
        return ('<html><head><title>真实论文标题</title><link rel="canonical" href="' + self.url
            + '"></head><body><h1>真实论文标题</h1><section class="paper-tags">'
              '<div data-classification-facet="task"><a href="/papers/?concept=task">语音任务</a></div>'
              '</section><div class="post-content"><p>同一正文。</p></div></body></html>')

    def expected(self):
        page = gate.Page(self.page())
        return {'url': self.url, 'formulaCount': 0,
            'projectionSha256': gate.digest(json.dumps(page.visible_content_fields(), ensure_ascii=False, sort_keys=True).encode()),
            'pageIdentityContract': 'conference-visible-page-identity-v1',
            'pageIdentitySha256': gate.digest(json.dumps(page.page_identity_fields(), ensure_ascii=False, sort_keys=True).encode())}

    def check(self, html, expected):
        with mock.patch.object(gate, 'fetch_public', return_value={'url': self.url, 'contentType': 'text/html', 'body': html.encode()}):
            return gate.verify_publication_urls([expected], [], 'https://example.invalid/images')

    def test_new_identity_binds_title_h1_classification_links_and_facets(self):
        self.assertEqual(self.check(self.page(), self.expected())['status'], 'passed')
        for old, new in [('<title>真实论文标题', '<title>错误标题'), ('<h1>真实论文标题','<h1>错误标题'),
                         ('语音任务', '错误标签'), ('concept=task', 'concept=wrong'), ('facet="task"', 'facet="method"')]:
            with self.subTest(change=old), self.assertRaisesRegex(ValueError, '标题、H1或多级研究分类'):
                self.check(self.page().replace(old, new), self.expected())

    def test_old_published_projection_is_readable_without_resigning(self):
        expected = self.expected(); del expected['pageIdentityContract']; del expected['pageIdentitySha256']
        self.assertEqual(self.check(self.page(), expected)['status'], 'passed')

    def test_partial_or_unknown_identity_never_downgrades_to_legacy(self):
        for delta in ({'pageIdentityContract': 'unknown'}, {'pageIdentitySha256': None}):
            expected = self.expected(); expected.update(delta)
            with self.subTest(delta=delta), self.assertRaises(ValueError): self.check(self.page(), expected)

    def test_current_source_selected_tags_must_actually_render_once_without_empty_facet(self):
        markdown = ('---\ntitle: 真实论文标题\npaper_digest_page_type: paper\n'
            'paper_digest_tags_contract: paper-tag-flat-tags-v2\n'
            'paper_digest_tags_concepts: [{id: task, facet: task, label: 语音任务}]\n---\n同一正文。\n')
        good = self.page().replace('<a href=', '<li data-classification-concept="task" data-direct-classification="true"><a href=').replace('</a></div>', '</a></li></div>')
        self.assertIn('pageIdentitySha256', gate.inspect_html(markdown, good, [], 'https://example.invalid/images'))
        for html in (self.page(), good.replace('data-direct-classification="true"', ''),
                     good.replace('facet="task"','facet="method"'), good.replace('语音任务','错误标签')):
            with self.subTest(html=html), self.assertRaisesRegex(ValueError, '分类'):
                gate.inspect_html(markdown, html, [], 'https://example.invalid/images')


if __name__ == '__main__': unittest.main()
