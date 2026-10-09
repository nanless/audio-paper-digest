import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from test_publish_to_blog import publish_to_blog as blog, valid_png


class LocalImageOwnerTests(unittest.TestCase):
    def test_configured_owner_repo_main_uses_local_pixels(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary) / 'arbitrary-local-directory'
            image = repo / 'conf/figure.png'
            image.parent.mkdir(parents=True)
            image.write_bytes(valid_png())
            base = 'https://raw.githubusercontent.com/expected-owner/image-repository/main'
            with mock.patch.dict(os.environ, {
                'PAPER_DIGEST_IMAGE_REPO': str(repo),
                'PAPER_DIGEST_IMAGE_BASE_URL': base + '/',
            }), mock.patch.object(blog, '_download_review_image') as download:
                result = blog._load_review_image(base + '/conf/figure.png')
            self.assertEqual(result['media_type'], 'image/png')
            self.assertTrue(result['data'])
            download.assert_not_called()

    def test_other_identity_and_similar_prefix_use_remote_loader(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary) / 'image-repository'
            image = repo / 'conf/figure.png'
            image.parent.mkdir(parents=True)
            image.write_bytes(valid_png())
            base = 'https://raw.githubusercontent.com/expected-owner/image-repository/main'
            urls = [
                base.replace('expected-owner', 'other-owner') + '/conf/figure.png',
                base.replace('image-repository', 'other-repository') + '/conf/figure.png',
                base.replace('/main', '/develop') + '/conf/figure.png',
                base + '-similar/conf/figure.png',
                base.replace('expected-owner', 'expected-owner-similar') + '/conf/figure.png',
            ]
            with mock.patch.dict(os.environ, {
                'PAPER_DIGEST_IMAGE_REPO': str(repo),
                'PAPER_DIGEST_IMAGE_BASE_URL': base,
            }):
                for url in urls:
                    with self.subTest(url=url), mock.patch.object(
                            blog, '_download_review_image', return_value={'remote': url}) as download:
                        self.assertEqual(blog._load_review_image(url), {'remote': url})
                        download.assert_called_once_with(url)
