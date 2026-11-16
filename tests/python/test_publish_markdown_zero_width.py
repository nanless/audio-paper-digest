"""发布前 Markdown 清洗：零宽字符集合的回归测试。

2026-11-16 审计：`sanitize_markdown_for_publish` 统一剔除 200B/200C/200D/
2060/FEFF；`publish-to-blog` 的来源单元格比较复用同一集合（
PUBLISH_ZERO_WIDTH_CHARACTERS），避免封存 DOM 里夹带的连接符/词连接符/BOM
让同一单元格在两侧被判定为不同。这里锁住集合本身：五个字符都删，
其它不可见或正常字符必须原样保留，不能顺手放宽成更大的清洗口径。
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import publish_common as common  # noqa: E402

ZERO_WIDTH_CHARACTERS = ('\u200b', '\u200c', '\u200d', '\u2060', '\ufeff')


class PublishMarkdownZeroWidthTest(unittest.TestCase):
    def test_each_publish_zero_width_character_is_removed(self):
        for zero_width in ZERO_WIDTH_CHARACTERS:
            with self.subTest(code=hex(ord(zero_width))):
                self.assertEqual(
                    common.sanitize_markdown_for_publish('左' + zero_width + '右'),
                    '左右',
                )

    def test_other_characters_are_preserved_verbatim(self):
        # U+00A0 不换行空格、U+2061 函数应用符、U+2028 行分隔符以及普通
        # 中文、emoji、圈号都不在发布清洗集合里，必须逐字保留。
        text = 'A\u00a0B\u2061C\u2028D\U0001F600E①②'
        self.assertEqual(common.sanitize_markdown_for_publish(text), text)
        # 真实用途：表格单元格里的零宽字符删掉后，数字应与渲染文本一致。
        dirty = '| 0.9\u200b3\u2060 dB |\n'
        self.assertEqual(common.sanitize_markdown_for_publish(dirty), '| 0.93 dB |\n')


if __name__ == '__main__':
    unittest.main()
