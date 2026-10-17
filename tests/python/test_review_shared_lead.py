"""Shared figure-transition review inputs retain their exact source paragraph."""
import base64
import json
import os
import unittest
from pathlib import Path
from unittest import mock
from test_publish_to_blog import publish_to_blog as pub

ROOT=Path(__file__).resolve().parents[2]
FIXTURE=ROOT/'tests/fixtures/blog-review-shared-lead-13300.json'


class SharedLeadReviewInputTest(unittest.TestCase):
    def test_actual_sonic_shared_paragraph_keeps_bytes_and_marks_previous_figure(self):
        fixture=json.loads(FIXTURE.read_text())
        content=fixture['content'];images=pub.parse_markdown_images(content)
        regions=pub._review_image_context_regions(content,images)
        self.assertEqual(len(images),2)
        self.assertNotIn('sharedPreviousExplanationLead',regions[0])
        shared=regions[1]['sharedPreviousExplanationLead']
        self.assertEqual(shared['previousImageIndex'],0)
        self.assertEqual(content[shared['start']:shared['end']],fixture['sharedParagraph'])
        self.assertTrue(all(r['readerFigureCluster'] for r in regions))
        self.assertIn('音乐到爆炸到鸟鸣',fixture['sharedParagraph'])
        captured=[]
        def api(prompt,**kwargs):
            captured.append(prompt)
            return '{"passed":true,"issues":[]}'
        with mock.patch.dict(os.environ,{'PAPER_ANALYZER_MODEL':'fixture-model'}), \
                mock.patch.object(pub,'_load_review_image',return_value={'media_type':'image/png','data':base64.b64encode(b'explicit offline fixture pixels').decode()}), \
                mock.patch.object(pub,'call_llm_api',side_effect=api):
            self.assertEqual(pub.multimodal_review_images(content,'Sonic共用导读真实稿',required=True),(True,[]))
        self.assertEqual(len(captured),2)
        self.assertNotIn('【相邻过渡段：',captured[0])
        self.assertIn('【相邻过渡段：正文前一图片 1 的解释，同时用作本图导读】',captured[1])
        self.assertIn(fixture['sharedParagraph'],captured[1])
        self.assertIn('【以下为本张图片自己的看图路径、原图、图注和解释】',captured[1])
        self.assertIn('qualitative_full_audio.png',captured[1])
        self.assertNotIn('teaser_image.png',captured[1])

    def test_model_reported_current_figure_conflict_still_blocks(self):
        content=json.loads(FIXTURE.read_text())['content']
        images=pub.parse_markdown_images(content)
        content += '\n\n本张图无条件声称黄色人体全部为蓝色，保留此真实冲突给审查。'
        issue={'severity':'error','description':'本图自有解释仍与实际像素颜色冲突。'}
        def api(prompt,**kwargs):
            if '【相邻过渡段：' in prompt:
                self.assertIn('如确实无条件声称本张图存在某特征，仍应核对并报告真实冲突',prompt)
                return json.dumps({'passed':False,'issues':[issue]},ensure_ascii=False)
            return '{"passed":true,"issues":[]}'
        with mock.patch.dict(os.environ,{'PAPER_ANALYZER_MODEL':'fixture-model'}), \
                mock.patch.object(pub,'_load_review_image',return_value={'media_type':'image/png','data':base64.b64encode(b'fixture pixels').decode()}), \
                mock.patch.object(pub,'call_llm_api',side_effect=api):
            result = pub.multimodal_review_images(content,'真问题不能免审',required=True)
            self.assertEqual(result,(False,[{**issue,'type':'model_content'}]))
            self.assertEqual(pub.classify_review_failure(result[1]),'content')

    def test_independent_five_part_context_has_no_new_annotation(self):
        blocks=[]
        for i in (1,2):
            blocks += [f'第{i}张自己的独立导读。',f'> **看图路径：** 1. 第{i}张自己的方向',
                f'![图{i}](https://example.com/{i}.png)',f'*论文图 {i}。自己的图注。*',f'第{i}张自己的解释。']
        content='\n\n'.join(blocks)
        regions=pub._review_image_context_regions(content,pub.parse_markdown_images(content))
        self.assertTrue(all(r['readerFigureCluster'] for r in regions))
        self.assertTrue(all(set(r)=={'start','end','readerFigureCluster'} for r in regions))
        for i,r in enumerate(regions):
            self.assertEqual(content[r['start']:r['end']],'\n\n'.join(blocks[i*5:(i+1)*5]))
