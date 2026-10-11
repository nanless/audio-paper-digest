import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from utils import parse_analysis


class TaskApplicabilityTests(unittest.TestCase):
    def test_catalog_child_does_not_imply_scene_classification(self):
        text = '## 机器摘要\nprimary_task_tag: #音频分类\nprimary_method_tag: #CNN\n## 标签\n#音频分类 #CNN #低资源\n主任务标签：#音频分类\n主方法标签：#CNN\n补充标签：#低资源\n'
        parsed = parse_analysis(text)
        self.assertTrue(parsed['tagValidation']['valid'])
        self.assertIsNone(parsed['tagValidation']['specificityWarning'])
        invalid = text.replace('#音频分类 #CNN #低资源', '#音频分类 #声学场景分类 #CNN #低资源')
        validation = parse_analysis(invalid)['tagValidation']
        self.assertFalse(validation['valid'])
        self.assertTrue(any('最具体' in error for error in validation['errors']))


if __name__ == '__main__':
    unittest.main()
