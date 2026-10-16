import copy
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_publish_conference import M, FakeReviewer
from project_env_isolation import isolate_module_environment, restore_environment_after


setUpModule, tearDownModule = isolate_module_environment()


class ConferenceReviewPageAssetBoundaryTests(unittest.TestCase):
    def setUp(self):
        restore_environment_after(self)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.runtime = self.root / 'review-runtime'
        self.runtime.mkdir()
        (self.runtime / 'hugo.toml').write_text('baseURL = "https://example.invalid/"\n')
        (self.runtime / 'layouts').mkdir()
        self.publisher = M.load_publish_to_blog()
        self.enterContext(mock.patch.object(self.publisher, 'BLOG_REPO', self.runtime))
        self.enterContext(mock.patch.object(M, 'load_publish_to_blog', return_value=self.publisher))

    def fixture(self):
        # A small equivalent of 1355 HTML pages plus 5416 machine sidecars.
        pages = [{'kind': kind, 'path': f'content/posts/{kind}.md', 'sourceSha256': digit * 64}
                 for kind, digit in [('paper', '1'), ('aggregate', '2')]]
        sidecars = [{'kind': 'sidecar', 'path': f'static/data/papers/example/{name}', 'sourceSha256': '3' * 64}
                    for name in ['citation.bib', 'citation.ris', 'context.json', 'paper.json']]
        generation = {'version': 2, 'conferenceId': 'interspeech-2026', 'processId': 'process',
                      'baseHead': 'a' * 40, 'files': pages + sidecars, 'imageFiles': [], 'generationSha256': '4' * 64}
        protocol = M.content_review_protocol(M.load_publish_to_blog())
        receipt = {'contract': 'conference-blog-review-v1', 'version': 2,
                   **{key: generation[key] for key in ['conferenceId', 'processId', 'baseHead', 'files', 'imageFiles', 'generationSha256']},
                   'hugo': {'status': 'passed', 'contract': M.GATE_CONTRACT,
                            'implementationSha256': M.gate_fingerprint(),
                            'pages': [{'path': page['path'], 'sourceSha256': page['sourceSha256']} for page in pages]},
                   'contentReview': {'status': 'passed', 'protocol': protocol,
                                     'pages': [{'path': page['path'], 'sha256': page['sourceSha256'],
                                                'passed': True, 'protocol': protocol} for page in pages]}}
        return generation, self.seal(receipt)

    def seal(self, receipt):
        body = {key: value for key, value in receipt.items() if key != 'reviewSha256'}
        return {**body, 'reviewSha256': M.stable(body)}

    def test_html_set_excludes_sidecars_but_full_receipt_retains_all_assets(self):
        # CI has no adjacent blog checkout. Keep the production refusal real,
        # then compute this fixture's actual protocol using its own runtime.
        missing = self.root / 'missing-default-blog'
        self.assertFalse(missing.exists())
        with mock.patch.object(self.publisher, 'BLOG_REPO', missing), \
                self.assertRaisesRegex(self.publisher.PublishDataValidationError, '博客运行时文件缺失'):
            self.publisher.review_protocol_fingerprint()
        generation, receipt = self.fixture()
        for current in [True, False]:
            M.validate_review(generation, receipt, current=current)
        self.assertEqual(len(receipt['hugo']['pages']), 2)
        self.assertEqual(len(receipt['files']), 6)

    def test_missing_duplicate_wrong_sha_extra_and_sidecar_html_are_rejected(self):
        generation, receipt = self.fixture()
        for mutation in ['missing', 'duplicate', 'sha', 'extra', 'sidecar']:
            bad = copy.deepcopy(receipt)
            pages = bad['hugo']['pages']
            if mutation == 'missing': pages.pop()
            elif mutation == 'duplicate': pages[1] = copy.deepcopy(pages[0])
            elif mutation == 'sha': pages[0]['sourceSha256'] = '0' * 64
            elif mutation == 'extra': pages.append({'path': 'content/posts/unknown.md', 'sourceSha256': '0' * 64})
            else: pages[1] = {key: generation['files'][2][key] for key in ['path', 'sourceSha256']}
            for current in [True, False]:
                with self.subTest(mutation=mutation, current=current), self.assertRaisesRegex(M.ConferencePublicationError, 'HTML 页面集合'):
                    M.validate_review(generation, self.seal(bad), current=current)

    def test_sidecar_removal_or_changes_in_review_still_fail_full_generation_binding(self):
        generation, receipt = self.fixture()
        for mutation in ['missing', 'changed']:
            bad = copy.deepcopy(receipt)
            if mutation == 'missing': bad['files'].pop()
            else: bad['files'][-1]['sourceSha256'] = '0' * 64
            for current in [True, False]:
                with self.subTest(mutation=mutation, current=current), self.assertRaisesRegex(M.ConferencePublicationError, 'review receipt'):
                    M.validate_review(generation, self.seal(bad), current=current)

    def test_real_path_sha_cache_keeps_original_protocol_and_survives_both_receipt_modes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / 'blog'
            target = repo / 'content/posts/paper.md'
            target.parent.mkdir(parents=True)
            raw = '---\ntitle: 原始标题\n---\n正文保持原字节。\n'.encode()
            target.write_bytes(raw)
            page = {'kind': 'paper', 'path': 'content/posts/paper.md', 'sourceSha256': M.sha_bytes(raw)}
            reviewer = FakeReviewer()
            with mock.patch.object(M, 'PUBLICATION_ROOT', root / 'receipts'), \
                    mock.patch.object(M, 'load_publish_to_blog', return_value=reviewer), \
                    mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'offline-mock'}):
                original = M.review_pages(repo, [page])
                key = M.stable({'path': page['path'], 'sha256': page['sourceSha256']})
                cache = M.PUBLICATION_ROOT / 'page-review-passes' / f'{key}.json'
                original_bytes = cache.read_bytes()
                reviewer.protocol = 'protocol-2'
                reused = M.review_pages(repo, [page])
                self.assertEqual(reviewer.calls, 1)
                self.assertNotEqual(original['protocol'], reused['protocol'])
                self.assertEqual(reused['pages'], original['pages'])
                generation, receipt = self.fixture()
                generation['files'] = [page] + generation['files'][2:]
                receipt['files'] = generation['files']
                receipt['contentReview'] = reused
                receipt['hugo']['pages'] = [{'path': page['path'], 'sourceSha256': page['sourceSha256']}]
                receipt = self.seal(receipt)
                for current in [True, False]:
                    M.validate_review(generation, receipt, current=current)
                for mutation in ['protocol', 'selfhash', 'path', 'sha', 'unsigned']:
                    bad = copy.deepcopy(receipt)
                    record = bad['contentReview']['pages'][0]
                    if mutation == 'protocol':
                        record['protocol'] = '0' * 64
                        body = {key: value for key, value in record.items() if key != 'resultSha256'}
                        record['resultSha256'] = M.stable(body)
                    elif mutation == 'selfhash': record['resultSha256'] = '0' * 64
                    elif mutation == 'path': record['path'] += '-other'
                    elif mutation == 'sha': record['sha256'] = '0' * 64
                    else: record.pop('resultSha256')
                    for current in [True, False]:
                        with self.subTest(mutation=mutation, current=current), self.assertRaises(M.ConferencePublicationError):
                            M.validate_review(generation, self.seal(bad), current=current)
                self.assertEqual(cache.read_bytes(), original_bytes)
                self.assertEqual(reviewer.calls, 1)


if __name__ == '__main__':
    unittest.main()
