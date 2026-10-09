import importlib.util
import json
import sys
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_env_isolation import project_env_scope

with project_env_scope():
    spec = importlib.util.spec_from_file_location('feishu_content_fidelity', ROOT / 'scripts/publish-to-feishu.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)


def text(blocks):
    return '\n'.join(element['text_run']['content'] for block in blocks
                     for value in block.values() if isinstance(value, dict)
                     for element in value.get('elements', []))


class FeishuContentFidelityTests(unittest.TestCase):
    def test_http_success_without_explicit_api_success_is_rejected(self):
        for payload in [{}, [], {'code': False}, {'code': '0'}, {'code': 1, 'msg': '写入失败'}]:
            with self.subTest(payload=payload), mock.patch.object(urllib.request, 'urlopen') as open_url:
                open_url.return_value.__enter__.return_value.read.return_value = json.dumps(payload).encode()
                with self.assertRaises(RuntimeError):
                    module.create_blocks('test-token', 'document', 'root', [])

    def test_explicit_success_preserves_api_data(self):
        with mock.patch.object(urllib.request, 'urlopen') as open_url:
            open_url.return_value.__enter__.return_value.read.return_value = b'{"code":0,"data":{"children":[]}}'
            self.assertEqual(module.create_blocks('test-token', 'document', 'root', []), {'children': []})

    def test_table_headers_units_and_all_cells_survive_conversion(self):
        table = '| 模型 | 错误率 ↓ | 耗时 |\n| --- | --- | --- |\n| A | 2.5% | 10 ms |\n| B | 3.0% | 9 ms |'
        blocks = module.md_to_feishu_blocks('比较相同数据集。\n\n' + table + '\n\nB 更快，但错误率较高。')
        self.assertIn(table, text(blocks))
        self.assertIn('B 更快，但错误率较高。', text(blocks))
        self.assertNotIn('请手动粘贴', text(blocks))

    def test_links_and_formula_asterisks_remain_verbatim_in_paragraphs_and_lists(self):
        content = '[代码](https://example.invalid/repo_(v2)) 与 $a*b*c$'
        for prefix in ['', '- ', '1. ']:
            with self.subTest(prefix=prefix):
                self.assertEqual(text(module.md_to_feishu_blocks(prefix + content)), content)

    def test_headings_and_lists_keep_their_existing_native_block_types(self):
        blocks = module.md_to_feishu_blocks('# 标题\n## 小节\n### 实验\n- 项目\n1. 步骤')
        self.assertEqual([item['block_type'] for item in blocks], [3, 4, 5, 12, 13])
        self.assertEqual(text(blocks), '标题\n小节\n实验\n项目\n步骤')
