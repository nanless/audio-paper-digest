"""核心摘要 6–12 句边界（Python 侧）回归测试。

2026-11-14 用户要求把核心摘要句数上限从 9 放宽到 12；下限 6 与 320–600 字
保持不变。本文件直接调用 `publish-to-blog.py` 的句数/语义检查函数
`_detailed_core_summary_semantic_issue`（不走完整发布流程），锁定 10 句、12 句
通过、13 句拒绝。Node 侧同口径用例见 tests/core-summary-sentence-boundary.test.js。

基线核心摘要从 tests/valid-analysis-fixture.js 里读取，和 Node 用例共用同一
7 句、333 字的合法摘要，避免两侧样本悄悄漂移。
"""
import importlib.util
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
_SPEC = importlib.util.spec_from_file_location(
    'core_summary_boundary_publish', ROOT / 'scripts/publish-to-blog.py'
)
publish = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(publish)

SENTENCE_END = re.compile(r'[。！？!?]')


def base_summary():
    source = (ROOT / 'tests' / 'valid-analysis-fixture.js').read_text(encoding='utf-8')
    block = re.search(r"const summary = \[(.*?)\]\.join\(''\);", source, re.S)
    if block is None:
        raise AssertionError('valid-analysis-fixture.js 里找不到 const summary 数组')
    return ''.join(re.findall(r"'([^']*)'", block.group(1)))


BASE = base_summary()


def summary_with_sentence_count(count):
    summary = BASE + '补充说明。' * (count - 7)
    assert len(SENTENCE_END.findall(summary)) == count, summary
    return summary


class CoreSummarySentenceBoundaryTest(unittest.TestCase):
    def test_ten_sentences_pass(self):
        # 顺带固定共用基线：7 句、333 字的合法摘要本身必须通过。
        self.assertEqual(len(SENTENCE_END.findall(BASE)), 7)
        self.assertIsNone(publish._detailed_core_summary_semantic_issue(BASE))
        self.assertIsNone(
            publish._detailed_core_summary_semantic_issue(summary_with_sentence_count(10))
        )

    def test_twelve_sentences_still_pass(self):
        self.assertIsNone(
            publish._detailed_core_summary_semantic_issue(summary_with_sentence_count(12))
        )

    def test_thirteen_sentences_are_rejected(self):
        issue = publish._detailed_core_summary_semantic_issue(
            summary_with_sentence_count(13)
        )
        self.assertIsNotNone(issue)
        self.assertIn('句数必须为 6–12', issue)
        self.assertIn('当前 13', issue)


if __name__ == '__main__':
    unittest.main()
