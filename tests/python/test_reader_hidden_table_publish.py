import copy
import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_publish_to_blog as fixture
from publish_common import extract_markdown_tables, mask_protected_markdown_table_regions
publish = fixture.publish_to_blog


class ReaderHiddenTablePublishTests(unittest.TestCase):
    def test_shared_visibility_matches_node_without_network_or_per_paper_process(self):
        data = json.loads((ROOT / 'tests/fixtures/reader-table-visibility.json').read_text())
        node = shutil.which('node')
        self.assertIsNotNone(node, '跨语言离线测试需要 Node.js')
        script = ('const fs=require("node:fs"); const c=require(process.argv[1]); '
                  'const inputs=JSON.parse(fs.readFileSync(0,"utf8")); '
                  'process.stdout.write(JSON.stringify(inputs.map(x=>c.extractMarkdownTables(x).length)));')
        result = subprocess.run([node, '-e', script, str(ROOT / 'scripts/analysis-contract.js')],
                                input=json.dumps([item['body'] for item in data['cases']]),
                                capture_output=True, text=True, timeout=20,
                                env={key: value for key, value in os.environ.items()
                                     if key not in {'NODE_OPTIONS', 'NODE_PATH'}})
        self.assertEqual(result.returncode, 0, result.stderr)
        node_counts = json.loads(result.stdout)
        for item, node_count in zip(data['cases'], node_counts):
            with self.subTest(case=item['name']):
                common = extract_markdown_tables(item['body'])
                reader = publish._api_reader_markdown_tables(item['body'])
                self.assertEqual(len(common), item['reader'])
                self.assertEqual(len(reader), node_count)
                self.assertEqual(len(mask_protected_markdown_table_regions(item['body'])), len(item['body']))
                if item['name'] == 'inline-tokens':
                    self.assertEqual(reader[0]['markdown'], item['body'])

    def test_public_generate_rejects_hidden_bound_tables_preserving_record_bytes(self):
        wrappers = {
            'comment': lambda table: '<!--\n\n' + table + '\n\n-->',
            'pre': lambda table: '<pre>\n\n' + table + '\n\n</pre>',
            'long-s-script': lambda table: '<ſcript>\n\n' + table + '\n\n</script>',
            'script': lambda table: '<script>\n\n' + table + '\n\n</script>',
            'html': lambda table: '<div>\n' + table + '\n</div>',
            'blockquote': lambda table: '\n'.join('> ' + line for line in table.splitlines()),
        }
        original = fixture.llm_api_publication_fixture()
        table = publish._api_reader_markdown_tables(original['apiReaderArticle'])[0]['markdown']
        # 正控调用公开页面生成；不运行保存、审查、推送或模型入口。
        page, _ = publish.generate_paper_page(original, '2026-08-31')
        self.assertIn(table, page)
        for name, wrap in wrappers.items():
            with self.subTest(case=name):
                paper = copy.deepcopy(original)
                paper['apiReaderArticle'] = paper['apiReaderArticle'].replace(table, wrap(table))
                fixture.reseal_llm_api_reader_fixture(paper)
                before = json.dumps(paper, sort_keys=True, ensure_ascii=False)
                with self.assertRaisesRegex(publish.PublishDataValidationError, '表格数'):
                    publish.generate_paper_page(paper, '2026-08-31')
                self.assertEqual(json.dumps(paper, sort_keys=True, ensure_ascii=False), before)

    def test_source_binding_checks_still_reject_changed_numeric_cells(self):
        paper = fixture.llm_api_publication_fixture()
        paper['apiReaderArticle'] = paper['apiReaderArticle'].replace('| Ours | 8.4 |', '| Ours | 8.5 |')
        fixture.reseal_llm_api_reader_fixture(paper)
        with self.assertRaises(publish.PublishDataValidationError):
            publish.generate_paper_page(paper, '2026-08-31')

    def test_mask_keeps_original_line_numbers_and_visible_bytes(self):
        table = '| Method | WER |\n| --- | --- |\n| A | 4.1% |'
        text = '<!--\n隐藏说明\n-->\n\n' + table
        result = extract_markdown_tables(text)[0]
        self.assertEqual(result['start_line'], 4)
        self.assertEqual(publish._api_reader_markdown_tables(text)[0]['markdown'], table)


if __name__ == '__main__':
    unittest.main()
