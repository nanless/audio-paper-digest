#!/usr/bin/env python3

import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT_DIR = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = ROOT_DIR / 'scripts'
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import importlib.util

def _load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

pub = _load_module('publish_to_blog_w12_2', SCRIPTS_DIR / 'publish-to-blog.py')


class Wave12Track122ReviewUpgradeTests(unittest.TestCase):
    def test_text_review_prompt_places_static_rules_first_and_targets_semantic_consistency(self):
        captured = []
        def fake_call(prompt, **kwargs):
            captured.append(prompt)
            return json.dumps({'passed': True, 'issues': []})

        with mock.patch.object(pub, 'call_llm_api', side_effect=fake_call):
            passed, issues, _ = pub._llm_review_post_chunk(
                '## 核心摘要\n本文在 LibriSpeech 上 WER 3.1%。',
                title='Audio Codec Paper',
                required=True,
                chunk_label='1/2',
            )
        self.assertTrue(passed)
        self.assertEqual(issues, [])
        self.assertEqual(len(captured), 1)
        prompt = captured[0]
        # Semantic consistency focus
        self.assertIn('表文极值与指标方向自洽', prompt)
        self.assertIn('跨栏目一致性', prompt)
        # Static prefix placed BEFORE dynamic <review_input> block
        input_pos = prompt.rindex('\n<review_input>\n')
        self.assertGreater(input_pos / len(prompt), 0.70)

    def test_multimodal_review_uses_deplot_read_first_schema_and_static_prefix(self):
        captured = []
        deplot_response = json.dumps({
            'figureObservation': {
                'chartType': '折线图',
                'axesAndScale': '横轴码率 (kbps)，纵轴 ViSQOL（线性轴，非对数轴）',
                'legendSeries': ['蓝实线：Ours', '橙虚线：EnCodec'],
                'errorBarsAndUnits': '无误差棒，单位为 MOS-LQO 分值',
                'keyVisualFacts': ['Ours 在 1.5–6 kbps 全区间高于 EnCodec'],
            },
            'passed': True,
            'issues': [],
        })

        def fake_call(prompt, **kwargs):
            captured.append(prompt)
            return deplot_response

        pixels = {'media_type': 'image/png', 'data': 'cG5n'}
        content = '前文导读。\n![模型对比](https://example.com/fig1.png)\n后文说明 Ours 领先。'
        with mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'muse-spark-1.3-contributor'}), \
                mock.patch.object(pub, '_load_review_image', return_value=pixels), \
                mock.patch.object(pub, 'call_llm_api', side_effect=fake_call):
            passed, issues = pub.multimodal_review_images(content, 'Paper Title', required=True)

        self.assertTrue(passed)
        self.assertEqual(issues, [])
        self.assertEqual(len(captured), 1)
        prompt = captured[0]
        self.assertIn('DePlot Read-First', prompt)
        self.assertIn('figureObservation', prompt)
        self.assertIn('对数轴（log scale）、双纵轴（dual y-axis）', prompt)
        # Static prefix sits cleanly ahead of dynamic <image_review_input>
        input_pos = prompt.index('<image_review_input>')
        self.assertGreater(input_pos / len(prompt), 0.75)


if __name__ == '__main__':
    unittest.main()
