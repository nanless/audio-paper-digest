#!/usr/bin/env python3
"""Wave 13 Track 13.1A Python tests: singular comment resource extraction and safe venueBadge/DOI rendering."""

import copy
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / 'scripts'
TESTS_PY_DIR = REPO_ROOT / 'tests' / 'python'
for p in (SCRIPTS_DIR, TESTS_PY_DIR):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from test_reader_structured_v5 import (  # noqa: E402
    build_structured_v5_publication_paper,
    pub as publish_to_blog,
)


class Wave13Track131ABlogMetadataTest(unittest.TestCase):
    def setUp(self):
        policy_directory = tempfile.TemporaryDirectory()
        self.addCleanup(policy_directory.cleanup)
        policy_patch = mock.patch.object(
            publish_to_blog,
            'TAG_DISPLAY_POLICY_PATH',
            Path(policy_directory.name) / 'absent-policy.json',
        )
        policy_patch.start()
        self.addCleanup(policy_patch.stop)

    def test_enrich_opensource_reads_singular_arxiv_comment(self):
        paper = {
            'abstract': 'A low-latency neural audio codec.',
            'comment': 'Accepted to ICASSP 2026. Code: https://github.com/audiolab/streamcodec Space: https://huggingface.co/spaces/audiolab/streamcodec',
        }
        enriched = publish_to_blog.enrich_opensource({'opensource': '- 代码状态：待补充'}, paper)
        self.assertIn('https://github.com/audiolab/streamcodec', enriched)
        self.assertIn('https://huggingface.co/spaces/audiolab/streamcodec', enriched)

    def test_generate_paper_page_renders_safe_venue_badge_and_doi_and_rejects_malformed(self):
        paper = build_structured_v5_publication_paper()
        paper['venueBadge'] = 'ICASSP 2026'
        paper['doi'] = '10.1109/ICASSP.2026.123456'

        md, _ = publish_to_blog.generate_paper_page(paper, '2026-11-24')
        self.assertIn('> 发表/录用标记：ICASSP 2026', md)
        self.assertIn('> DOI：`10.1109/ICASSP.2026.123456`', md)
        self.assertIsNone(publish_to_blog._api_reader_page_binding_issue(md, paper))

        # Malformed / injection / $-LaTeX values MUST NOT render
        bad_paper = copy.deepcopy(build_structured_v5_publication_paper())
        bad_paper['venueBadge'] = '<script>alert(1)</script>'
        bad_paper['doi'] = '10.1109/ICASSP.$x$.2026'
        bad_md, _ = publish_to_blog.generate_paper_page(bad_paper, '2026-11-24')
        self.assertNotIn('发表/录用标记：', bad_md)
        self.assertNotIn('DOI：', bad_md)
        self.assertNotIn('<script>', bad_md)

        # Non-string comment does not crash enrich_opensource
        self.assertEqual(
            publish_to_blog.enrich_opensource({'opensource': '- 代码状态：待补充'}, {'comment': ['not-a-string']}),
            '- 代码状态：待补充',
        )


if __name__ == '__main__':
    unittest.main()
