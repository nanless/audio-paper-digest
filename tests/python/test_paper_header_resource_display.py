import copy
import hashlib
import unittest
from unittest import mock
from test_publish_to_blog import publish_to_blog as blog


class PaperHeaderResourceDisplayTests(unittest.TestCase):
    def fixture(self):
        text = 'A real paper title\nAuthor A\nAffiliation: Institute A https://example.com/repo\nAuthor B\nAffiliation: Institute B\nAbstract\nBody resource https://example.com/repo\nReferences\nOther paper Author A https://example.com/repo\n'
        quote = text[:text.index('Author B')]
        paper = {'arxivId': '2610.00001', 'title': 'A real paper title',
                 'authors': ['Author A', 'Author B'],
                 'sourceSha256': hashlib.sha256(text.encode()).hexdigest(),
                 'freshRewriteProvenance': {'runId': '00000000-0000-0000-0000-000000000000',
                                           'sourceSha256': hashlib.sha256(text.encode()).hexdigest()}}
        resource = {'type': 'third_party', 'origin': 'paper_source', 'sourceQuote': quote,
                    'sourceQuoteSha256': blog._javascript_string_sha256(quote),
                    'originalUrl': 'https://example.com/repo'}
        return paper, resource, text

    def evaluate(self, paper, resource, text):
        with mock.patch.object(blog, '_daily_fresh_safe_directory'), \
                mock.patch.object(blog, '_daily_fresh_validate_bundle') as guard, \
                mock.patch.object(blog, '_daily_fresh_read_private_file', return_value=text.encode()):
            result = blog._paper_header_resource_display_label(paper, resource)
            return result, guard.call_count

    def test_only_precise_sealed_header_display_not_ownership(self):
        paper, resource, text = self.fixture()
        original = copy.deepcopy((paper, resource))
        result, guard_count = self.evaluate(paper, resource, text)
        self.assertEqual(result, '论文首页资源')
        self.assertEqual(guard_count, 1)
        self.assertEqual((paper, resource), original)
        self.assertNotIn('官方', result)
        self.assertNotIn('开源', result)

    def test_body_reference_and_different_resource_type_keep_original(self):
        paper, resource, text = self.fixture()
        for quote in ['Body resource https://example.com/repo',
                      'Other paper Author A https://example.com/repo']:
            altered = dict(resource, sourceQuote=quote,
                           sourceQuoteSha256=blog._javascript_string_sha256(quote))
            result, guard_count = self.evaluate(paper, altered, text)
            self.assertIsNone(result)
            self.assertEqual(guard_count, 0)
        for field, value in [('type', 'code'), ('origin', 'validated_demo')]:
            result, guard_count = self.evaluate(paper, dict(resource, **{field:value}), text)
            self.assertIsNone(result)
            self.assertEqual(guard_count, 0)

    def test_fake_prefix_author_order_and_non_affiliation_url_never_project(self):
        paper, resource, text = self.fixture()
        for changed in ['Leading text\n' + text, text.replace('Author B', 'Invented person'),
                        text.replace('Affiliation: Institute A', 'Third party repository:'),
                        text.replace('Abstract\n', 'Introduction\n')]:
            bound_paper = copy.deepcopy(paper)
            bound_paper['sourceSha256'] = hashlib.sha256(changed.encode()).hexdigest()
            bound_paper['freshRewriteProvenance']['sourceSha256'] = bound_paper['sourceSha256']
            result, guard_count = self.evaluate(bound_paper, resource, changed)
            self.assertIsNone(result)
            self.assertEqual(guard_count, 1)
        reordered = dict(paper, authors=['Author A', 'Author C', 'Author B'])
        self.assertIsNone(self.evaluate(reordered, resource, text)[0])

    def test_quote_and_sealed_source_proof_errors_block(self):
        paper, resource, text = self.fixture()
        with self.assertRaises(blog.PublishDataValidationError):
            self.evaluate(paper, dict(resource, sourceQuoteSha256='0' * 64), text)
        with mock.patch.object(blog, '_daily_fresh_safe_directory'), \
                mock.patch.object(blog, '_daily_fresh_validate_bundle',
                                  side_effect=blog.PublishDataValidationError('source SHA drift')):
            with self.assertRaises(blog.PublishDataValidationError):
                blog._paper_header_resource_display_label(paper, resource)


if __name__ == '__main__':
    unittest.main()
