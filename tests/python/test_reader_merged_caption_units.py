import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('merged_caption_publish', ROOT / 'scripts/publish-to-blog.py')
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)
FIXTURE = json.loads((ROOT / 'tests/fixtures/reader-merged-caption-unit-cases.json').read_text())

class MergedCaptionUnitsTest(unittest.TestCase):
    def test_shared_complete_source_and_adversarial_cases(self):
        for item in FIXTURE['cases']:
            with self.subTest(name=item['name']):
                value = copy.deepcopy(FIXTURE['base'])
                for op in item['operations']:
                    parts = op['path'].split('/')[1:]
                    target = value
                    for part in parts[:-1]:
                        target = target[int(part)] if isinstance(target, list) else target[part]
                    last = int(parts[-1]) if isinstance(target, list) else parts[-1]
                    if op.get('remove'):
                        target.pop(last)
                    elif isinstance(target, list) and last == len(target):
                        target.append(copy.deepcopy(op['value']))
                    else:
                        target[last] = copy.deepcopy(op['value'])
                actual = publish._reader_dom_table_unit_coverage(value['table'], value['quotes'], value['tables'])
                self.assertEqual(actual, {tuple(row) for row in item['expected']})

if __name__ == '__main__':
    unittest.main()
