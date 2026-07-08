import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRIPTS = os.path.join(ROOT, 'scripts')
sys.path.insert(0, SCRIPTS)

from path_config import (  # noqa: E402
    CURRENT_DIR,
    DEEP_ANALYSIS_RESULT_FILE,
    FILTER_DECISIONS_FILE,
    PAPERS_FILE,
    PROJECT_ROOT,
    backfill_result_path,
    resolve_deep_analysis_result_path,
    wechat_preview_path,
    xiaohongshu_markdown_path,
)


class PathConfigTest(unittest.TestCase):
    def test_runtime_json_paths_match_expected_names(self):
        self.assertEqual(str(PROJECT_ROOT), os.path.abspath(ROOT))
        self.assertEqual(PAPERS_FILE.name, 'papers.json')
        self.assertEqual(FILTER_DECISIONS_FILE.name, 'filter-decisions.json')
        self.assertEqual(DEEP_ANALYSIS_RESULT_FILE.name, 'deep-analysis-result.json')
        self.assertEqual(PAPERS_FILE.parent, CURRENT_DIR)
        self.assertEqual(DEEP_ANALYSIS_RESULT_FILE.parent, CURRENT_DIR)

    def test_publish_output_helpers(self):
        self.assertEqual(
            xiaohongshu_markdown_path('2026-07-08', 'top5'),
            CURRENT_DIR / 'xiaohongshu-2026-07-08-top5.md'
        )
        self.assertEqual(
            wechat_preview_path('2026-07-08'),
            CURRENT_DIR / 'wechat-preview-2026-07-08.html'
        )
        self.assertEqual(backfill_result_path().name, 'backfill-result.json')

    def test_resolve_deep_analysis_result_prefers_current_then_legacy(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = Path(tmp) / 'current.json'
            legacy = Path(tmp) / 'legacy.json'

            self.assertEqual(resolve_deep_analysis_result_path(current, legacy), current)

            legacy.write_text('[]', encoding='utf-8')
            self.assertEqual(resolve_deep_analysis_result_path(current, legacy), legacy)

            current.write_text('[]', encoding='utf-8')
            self.assertEqual(resolve_deep_analysis_result_path(current, legacy), current)


if __name__ == '__main__':
    unittest.main()
