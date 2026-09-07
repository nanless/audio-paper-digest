import copy
import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRIPTS = os.path.join(ROOT, 'scripts')
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from paper_taxonomy import active_preferred_labels, load_taxonomy  # noqa: E402
from utils import (ALLOWED_TAGS, PRIMARY_METHOD_TAGS, PRIMARY_TASK_TAGS,
                   parse_analysis)  # noqa: E402


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


class UtilsTaxonomyContractTests(unittest.TestCase):
    def test_compatibility_sets_are_registry_projections(self):
        taxonomy = load_taxonomy()
        self.assertEqual(ALLOWED_TAGS, set(active_preferred_labels(taxonomy)))
        self.assertEqual(PRIMARY_TASK_TAGS,
                         set(active_preferred_labels(taxonomy, ('task',))))
        self.assertEqual(PRIMARY_METHOD_TAGS,
                         set(active_preferred_labels(taxonomy, ('method',))))
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
        self.assertEqual(parsed['taxonomyValidation'], {
            'valid': True,
            'errors': [],
            'registryVersion': 'paper-taxonomy-v1',
            'registrySha256': load_taxonomy()['registrySha256'],
            'primaryTaskId': 'task.asr',
            'primaryMethodId': 'method.transformer',
            'conceptIds': ['task.asr', 'method.transformer',
                           'model_family.unified-audio'],
        })
        with self.assertRaisesRegex(ValueError, 'legacy_tags'):
            parse_analysis(analysis('#语音识别 #Transformer #低资源'),
                           legacy_tags=1)

    def test_aliases_require_explicit_legacy_mode_and_are_canonicalized(self):
        source = analysis('#ASR #TTA #低资源', '#ASR', '#TTA')
        current = parse_analysis(source)
        self.assertFalse(current['taxonomyValidation']['valid'])
        self.assertEqual(current['taxonomyValidation']['conceptIds'], [])
        self.assertEqual(current['tags'], ['#低资源'])
        self.assertEqual(current['primaryTaskTag'], '')
        self.assertEqual(current['primaryMethodTag'], '')

        legacy = parse_analysis(source, legacy_tags=True)
        self.assertTrue(legacy['taxonomyValidation']['valid'])
        self.assertEqual(legacy['tags'], ['#语音识别', '#测试时自适应', '#低资源'])
        self.assertEqual(legacy['primaryTaskTag'], '#语音识别')
        self.assertEqual(legacy['primaryMethodTag'], '#测试时自适应')
        self.assertEqual(legacy['taxonomyValidation']['conceptIds'],
                         ['task.asr', 'method.test-time-adaptation',
                          'setting.low-resource'])

    def test_current_mode_is_exact_and_never_uses_tag_position_as_role(self):
        parsed = parse_analysis(analysis('#语音识别 #Transformer #低资源'))
        self.assertFalse(parsed['taxonomyValidation']['valid'])
        self.assertEqual(parsed['primaryTaskTag'], '')
        self.assertEqual(parsed['primaryMethodTag'], '')
        self.assertIsNone(parsed['taxonomyValidation']['primaryTaskId'])
        self.assertIsNone(parsed['taxonomyValidation']['primaryMethodId'])

        for malformed in ('语音识别 #Transformer', '#ＡＳＲ #Transformer',
                          '#ASR #Transformer'):
            with self.subTest(malformed=malformed):
                rejected = parse_analysis(analysis(malformed))
                self.assertFalse(rejected['taxonomyValidation']['valid'])
                self.assertEqual(rejected['taxonomyValidation']['conceptIds'], [])

    def test_wrong_role_and_machine_summary_do_not_trigger_fallback(self):
        wrong_role = parse_analysis(analysis(
            '#模型评估 #音频理解 #Transformer', '#模型评估', '#统一音频模型'))
        self.assertFalse(wrong_role['taxonomyValidation']['valid'])
        self.assertEqual(wrong_role['primaryTaskTag'], '')
        self.assertEqual(wrong_role['primaryMethodTag'], '')
        self.assertEqual(wrong_role['taxonomyValidation']['conceptIds'], [])

        machine_disagreement = parse_analysis(analysis(
            '#语音识别 #语音合成 #Transformer', '#语音识别', '#Transformer',
            summary_task='#语音合成', summary_method='#Transformer'))
        self.assertTrue(machine_disagreement['taxonomyValidation']['valid'])
        self.assertEqual(machine_disagreement['primaryTaskTag'], '#语音识别')
        self.assertEqual(machine_disagreement['taxonomyValidation']['primaryTaskId'],
                         'task.asr')

    def test_deprecated_legacy_concept_is_reported_without_replacement(self):
        taxonomy = copy.deepcopy(load_taxonomy())
        taxonomy.pop('registrySha256')
        old = copy.deepcopy(next(
            concept for concept in taxonomy['concepts']
            if concept['id'] == 'method.peft'))
        old.update({
            'id': 'method.old-peft',
            'preferredLabel': {'zh': '旧参数适配', 'en': 'Old parameter adaptation'},
            'aliases': ['OldPEFT'],
            'broaderId': None,
            'status': 'deprecated',
            'replacedBy': 'method.peft',
        })
        taxonomy['concepts'].append(old)
        parsed = parse_analysis(
            analysis('#OldPEFT #语音识别', '#语音识别', '#OldPEFT'),
            taxonomy=taxonomy, legacy_tags=True)
        self.assertFalse(parsed['taxonomyValidation']['valid'])
        self.assertEqual(parsed['primaryMethodTag'], '')
        self.assertNotIn('method.peft', parsed['taxonomyValidation']['conceptIds'])
        self.assertTrue(parsed['taxonomyValidation']['errors'])


if __name__ == '__main__':
    unittest.main()
