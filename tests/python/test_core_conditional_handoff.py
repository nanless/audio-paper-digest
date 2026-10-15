import importlib.util
import json
from pathlib import Path
import re
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('conditional_handoff_publish', ROOT / 'scripts/publish-to-blog.py')
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)
CASES = json.loads((ROOT / 'tests/fixtures/core-conditional-handoff-cases.json').read_text())


class ConditionalHandoffTest(unittest.TestCase):
    def test_bound_generated_inputs_and_conditional_rate_deltas(self):
        metric = re.compile(r'准确率|正确率|错误率|词错率|WER|EER|UAR|accuracy', re.I)
        for group, fn, expected in [
            ('chainPositive', publish._has_generated_input_model_head_chain, True),
            ('chainNegative', publish._has_generated_input_model_head_chain, False),
            ('directionPositive', lambda text: publish._has_conditional_metric_delta_direction(text, metric), True),
            ('directionNegative', lambda text: publish._has_conditional_metric_delta_direction(text, metric), False),
        ]:
            for text in CASES[group]:
                with self.subTest(group=group, text=text):
                    self.assertEqual(fn(text), expected)


if __name__ == '__main__':
    unittest.main()
