import copy
import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRIPTS = os.path.join(ROOT, 'scripts')
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from tag_catalog import active_preferred_labels, load_tag_catalog  # noqa: E402
from utils import (ALLOWED_TAGS, PRIMARY_METHOD_TAGS, PRIMARY_TASK_TAGS,
                   parse_analysis, read_tag_validation)  # noqa: E402


def analysis(tags, task=None, method=None, *, summary_task=None, summary_method=None):
    summary = ['## 机器摘要']
    if summary_task is not None:
        summary.append(f'primary_task_tag: {summary_task}')
    if summary_method is not None:
        summary.append(f'primary_method_tag: {summary_method}')
    tag_section = ['## 标签', tags]
    if task is not None:
        tag_section.append(f'主任务标签: {task}')
    if method is not None:
        tag_section.append(f'主方法标签: {method}')
    return '\n'.join(['## 评分', '6.0/10', '', *summary, '', *tag_section, ''])


class UtilsTagRulesTests(unittest.TestCase):
    def test_validation_reader_preserves_old_cache_and_rejects_mixed_fields(self):
        parsed = parse_analysis(analysis(
            '#语音识别 #Transformer #统一音频模型', '#语音识别', '#Transformer'))
        self.assertIn('tagValidation', parsed)
        self.assertNotIn('taxonomyValidation', parsed)
        self.assertEqual(list(parsed['tagValidation']), [
            'valid', 'errors', 'registryVersion', 'registrySha256',
            'primaryTaskId', 'primaryMethodId', 'conceptIds', 'specificityWarning'])
        old = copy.deepcopy(parsed)
        old['taxonomyValidation'] = old.pop('tagValidation')
        before = copy.deepcopy(old)
        self.assertIs(read_tag_validation(old), old['taxonomyValidation'])
        self.assertEqual(read_tag_validation(old), read_tag_validation(parsed))
        self.assertEqual(old, before)
        for value in (None, False, [], 'invalid'):
            for key in ('tagValidation', 'taxonomyValidation'):
                self.assertIsNone(read_tag_validation({key: value}))
        for parsed_value in (None, [], 'invalid', {}):
            self.assertIsNone(read_tag_validation(parsed_value))
        for new_value, old_value in (({}, {}), (None, None),
                                     (parsed['tagValidation'], parsed['tagValidation']),
                                     (None, parsed['tagValidation'])):
            with self.subTest(new_value=new_value, old_value=old_value):
                with self.assertRaisesRegex(ValueError, '不能同时包含'):
                    read_tag_validation({'tagValidation': new_value,
                                         'taxonomyValidation': old_value})

    def test_compatibility_sets_are_registry_projections(self):
        tag_catalog = load_tag_catalog()
        self.assertEqual(ALLOWED_TAGS, set(active_preferred_labels(tag_catalog)))
        self.assertEqual(PRIMARY_TASK_TAGS,
                         set(active_preferred_labels(tag_catalog, ('task',))))
        self.assertEqual(PRIMARY_METHOD_TAGS,
                         set(active_preferred_labels(tag_catalog, ('method',))))
        self.assertNotIn('统一音频模型', PRIMARY_METHOD_TAGS)
        self.assertNotIn('预训练', PRIMARY_METHOD_TAGS)

    def test_current_parser_binds_canonical_tags_and_explicit_roles(self):
        parsed = parse_analysis(analysis(
            '#语音识别 #Transformer #统一音频模型',
            '#语音识别', '#Transformer',
            summary_task='#语音识别', summary_method='#Transformer'))
        self.assertEqual(parsed['tags'],
                         ['#语音识别', '#Transformer', '#统一音频模型'])
        self.assertEqual(parsed['primaryTaskTag'], '#语音识别')
        self.assertEqual(parsed['primaryMethodTag'], '#Transformer')
        self.assertEqual(parsed['tagValidation'], {
            'valid': True,
            'errors': [],
            'registryVersion': 'paper-tag-catalog-v2',
            'registrySha256': load_tag_catalog()['registrySha256'],
            'primaryTaskId': 'task.asr',
            'primaryMethodId': 'method.transformer',
            'conceptIds': ['task.asr', 'method.transformer',
                           'model_family.unified-audio'],
            'specificityWarning': (
                '主任务标签过于宽泛：#语音识别 的下级概念中有未被选中的已启用概念'
                '（共 6 个）：#音视频语音识别 #逆文本规范化 #唇读 #多说话人语音识别 #重叠语音识别 #标点恢复'),
        })
        with self.assertRaisesRegex(ValueError, 'legacy_tags'):
            parse_analysis(analysis('#语音识别 #Transformer #低资源'),
                           legacy_tags=1)

    def test_task_facet_count_must_stay_within_one_to_three(self):
        rejected = parse_analysis(analysis(
            '#语音合成 #语音克隆 #音视频生成 #音频理解 #Transformer',
            '#语音合成', '#Transformer'))
        self.assertFalse(rejected['tagValidation']['valid'])
        self.assertEqual(rejected['tagValidation']['conceptIds'], [])
        self.assertEqual(
            rejected['tagValidation']['errors'],
            ['任务标签须有 1–3 个，其中主任务为 1 个，次任务不超过 2 个；'
             '当前 4 个: #语音合成 #语音克隆 #音视频生成 #音频理解'])

        accepted = parse_analysis(analysis(
            '#语音合成 #语音克隆 #语音转换 #Transformer',
            '#语音合成', '#Transformer'))
        self.assertTrue(accepted['tagValidation']['valid'],
                        accepted['tagValidation']['errors'])
        self.assertEqual(accepted['tagValidation']['conceptIds'],
                         ['task.speech-synthesis', 'task.voice-cloning',
                          'task.voice-conversion', 'method.transformer'])
        # 3 个任务标签符合数量要求，但主任务仍有下级概念，照常给出告警。
        self.assertIsNotNone(
            accepted['tagValidation']['specificityWarning'])

    def test_primary_task_specificity_is_a_warning_not_a_block(self):
        # 主任务仍有下级概念时，valid 保持 True，已有阶段记录仍按原规则核验。
        # 新的标签选择与修复流程另用 specificityWarning 判断是否需要细化。
        parsed = parse_analysis(analysis(
            '#语音识别 #Transformer #低资源', '#语音识别', '#Transformer'))
        validation = parsed['tagValidation']
        self.assertTrue(validation['valid'], validation['errors'])
        self.assertEqual(validation['specificityWarning'],
                         '主任务标签过于宽泛：#语音识别 的下级概念中有未被选中的已启用概念'
                         '（共 6 个）：#音视频语音识别 #逆文本规范化 #唇读 #多说话人语音识别 #重叠语音识别 #标点恢复')

        # 主任务没有已启用的下级概念时，不产生宽泛告警。
        # v1.1 换表后 #音视频语音识别 有了子节点（#唇读），叶子用例改用 #标点恢复。
        leaf = parse_analysis(analysis(
            '#标点恢复 #Transformer #低资源',
            '#标点恢复', '#Transformer'))
        self.assertTrue(leaf['tagValidation']['valid'],
                        leaf['tagValidation']['errors'])
        self.assertIsNone(leaf['tagValidation']['specificityWarning'])

        # 缺少标签章节时告警字段同样存在且为 None。
        missing = parse_analysis('## 评分\n6.0/10\n')
        self.assertIsNone(
            missing['tagValidation']['specificityWarning'])

    def test_aliases_require_explicit_legacy_mode_and_are_canonicalized(self):
        source = analysis('#ASR #TTA #低资源', '#ASR', '#TTA')
        current = parse_analysis(source)
        self.assertFalse(current['tagValidation']['valid'])
        self.assertEqual(current['tagValidation']['conceptIds'], [])
        self.assertEqual(current['tags'], ['#低资源'])
        self.assertEqual(current['primaryTaskTag'], '')
        self.assertEqual(current['primaryMethodTag'], '')

        legacy = parse_analysis(source, legacy_tags=True)
        self.assertTrue(legacy['tagValidation']['valid'])
        self.assertEqual(legacy['tags'], ['#语音识别', '#测试时自适应', '#低资源'])
        self.assertEqual(legacy['primaryTaskTag'], '#语音识别')
        self.assertEqual(legacy['primaryMethodTag'], '#测试时自适应')
        self.assertEqual(legacy['tagValidation']['conceptIds'],
                         ['task.asr', 'method.test-time-adaptation',
                          'setting.low-resource'])

    def test_current_mode_is_exact_and_never_uses_tag_position_as_role(self):
        parsed = parse_analysis(analysis('#语音识别 #Transformer #低资源'))
        self.assertFalse(parsed['tagValidation']['valid'])
        self.assertEqual(parsed['primaryTaskTag'], '')
        self.assertEqual(parsed['primaryMethodTag'], '')
        self.assertIsNone(parsed['tagValidation']['primaryTaskId'])
        self.assertIsNone(parsed['tagValidation']['primaryMethodId'])

        for malformed in ('语音识别 #Transformer', '#ＡＳＲ #Transformer',
                          '#ASR #Transformer'):
            with self.subTest(malformed=malformed):
                rejected = parse_analysis(analysis(malformed))
                self.assertFalse(rejected['tagValidation']['valid'])
                self.assertEqual(rejected['tagValidation']['conceptIds'], [])

    def test_wrong_role_and_machine_summary_do_not_trigger_fallback(self):
        wrong_role = parse_analysis(analysis(
            '#模型评估 #音频理解 #Transformer', '#模型评估', '#统一音频模型'))
        self.assertFalse(wrong_role['tagValidation']['valid'])
        self.assertEqual(wrong_role['primaryTaskTag'], '')
        self.assertEqual(wrong_role['primaryMethodTag'], '')
        self.assertEqual(wrong_role['tagValidation']['conceptIds'], [])

        machine_disagreement = parse_analysis(analysis(
            '#语音识别 #语音合成 #Transformer', '#语音识别', '#Transformer',
            summary_task='#语音合成', summary_method='#Transformer'))
        self.assertTrue(machine_disagreement['tagValidation']['valid'])
        self.assertEqual(machine_disagreement['primaryTaskTag'], '#语音识别')
        self.assertEqual(machine_disagreement['tagValidation']['primaryTaskId'],
                         'task.asr')

    def test_deprecated_legacy_concept_is_reported_without_replacement(self):
        tag_catalog = copy.deepcopy(load_tag_catalog())
        tag_catalog.pop('registrySha256')
        old = copy.deepcopy(next(
            concept for concept in tag_catalog['concepts']
            if concept['id'] == 'method.peft'))
        old.update({
            'id': 'method.old-peft',
            'preferredLabel': {'zh': '旧参数适配', 'en': 'Old parameter adaptation'},
            'aliases': ['OldPEFT'],
            'broaderId': None,
            'status': 'deprecated',
            'replacedBy': 'method.peft',
        })
        tag_catalog['concepts'].append(old)
        parsed = parse_analysis(
            analysis('#OldPEFT #语音识别', '#语音识别', '#OldPEFT'),
            tag_catalog=tag_catalog, legacy_tags=True)
        self.assertFalse(parsed['tagValidation']['valid'])
        self.assertEqual(parsed['primaryMethodTag'], '')
        self.assertNotIn('method.peft', parsed['tagValidation']['conceptIds'])
        self.assertTrue(parsed['tagValidation']['errors'])


if __name__ == '__main__':
    unittest.main()
