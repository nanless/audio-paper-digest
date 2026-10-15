import copy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from tag_catalog import (load_tag_catalog, is_strict_append_only_catalog,
                         resolve_append_only_proof_catalog, tag_prompt_text_sha256,
                         TAG_PROMPT_TEXT_CONTRACT, LEGACY_TAG_PROMPT_TEXT_CONTRACT)
import publish_common
import test_publish_common as fixtures

OLD_SHA = '0a0847314ab2059d95efac33376414498e598a1f02a1486869bee0efc481d1f7'


class AppendOnlyProofTest(unittest.TestCase):
    def setUp(self):
        self.old = load_tag_catalog(ROOT / 'config/tag-catalog-history' / f'{OLD_SHA}.json')
        self.current = load_tag_catalog()

    def test_real_archive_and_every_full_prefix_field(self):
        self.assertEqual(len(self.old['concepts']), 262)
        self.assertEqual(len(self.current['concepts']), 386)
        self.assertTrue(is_strict_append_only_catalog(self.old, self.current))
        self.assertEqual(resolve_append_only_proof_catalog(OLD_SHA, self.current), self.old)
        for mutate in (
                lambda c: c.update(version='paper-taxonomy-v1'),
                lambda c: c['facets'][0].update(label='新分面'),
                lambda c: c['concepts'][0].update(definition='改定义'),
                lambda c: c['concepts'][0].update(scopeNote='改范围'),
                lambda c: c['concepts'][0].update(broaderId='task.av-asr'),
                lambda c: c['concepts'][0]['aliases'].append('另一个别名'),
                lambda c: c['concepts'].reverse()):
            changed = copy.deepcopy(self.current); mutate(changed)
            self.assertFalse(is_strict_append_only_catalog(self.old, changed))
            self.assertIsNone(resolve_append_only_proof_catalog(OLD_SHA, changed))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / f'{OLD_SHA}.json'
            self.assertIsNone(resolve_append_only_proof_catalog(OLD_SHA, self.current, history_dir=directory))
            path.write_text(json.dumps({k: self.old[k] for k in ('version', 'facets', 'concepts')}))
            self.assertIsNone(resolve_append_only_proof_catalog(OLD_SHA, self.current, history_dir=directory))
            path.unlink(); path.symlink_to(ROOT / 'config/tag-catalog-history' / f'{OLD_SHA}.json')
            self.assertIsNone(resolve_append_only_proof_catalog(OLD_SHA, self.current, history_dir=directory))

    def old_paper(self, contract):
        paper = fixtures.complete_paper(); manifest = {'version': 1}; paper['analysisManifest'] = manifest
        with mock.patch.object(fixtures, '_PUBLISH_TAG_CATALOG', self.old):
            fixtures.attach_tag_stage_record(paper, manifest, status='complete', with_checkpoints=True,
                prompt_text_contract=contract, record_format='current')
        return paper

    def test_original_stage_binding_checkpoint_and_prompt_are_replayed_without_resigning(self):
        for contract in (TAG_PROMPT_TEXT_CONTRACT, LEGACY_TAG_PROMPT_TEXT_CONTRACT):
            paper = self.old_paper(contract); before = copy.deepcopy(paper)
            publish_common._validate_tag_stage_record(paper, paper['analysisManifest'], 'old')
            self.assertEqual(paper, before)
            for mutate in (
                    lambda p: p['analysisManifest']['stages']['tagSelection'].update(projectionSha256='f' * 64),
                    lambda p: p['analysisManifest']['stages']['tagSelection'].update(bindingSha256='f' * 64),
                    lambda p: p['analysisManifest']['stages']['tagSelection'].update(registryUpgradeFrom=None),
                    lambda p: p['analysisStageCheckpoints'].update(tagSelection=p['analysis'] + '\n漂移')):
                bad = copy.deepcopy(paper); mutate(bad)
                with self.assertRaises(publish_common.PublishDataValidationError):
                    publish_common._validate_tag_stage_record(bad, bad['analysisManifest'], 'bad')

    def test_new_appended_tag_cannot_be_claimed_as_an_old_stage(self):
        paper = fixtures.complete_paper(); manifest = {'version': 1}; paper['analysisManifest'] = manifest
        old_task = fixtures.parse_analysis(paper['analysis'])['primaryTaskTag']
        new_task = next(c for c in self.current['concepts'][262:] if c['facet'] == 'task')
        paper['analysis'] = paper['analysis'].replace(old_task, '#' + new_task['preferredLabel']['zh'])
        self.assertTrue(fixtures.parse_analysis(paper['analysis'])['tagValidation']['valid'])
        stage = fixtures.attach_tag_stage_record(paper, manifest, status='complete', with_checkpoints=True, record_format='current')
        self.assertIn(new_task['id'], stage['conceptIds'])
        stage.update(registrySha256=OLD_SHA, registryVersion=self.old['version'],
                     projectionSha256=tag_prompt_text_sha256(self.old))
        record = publish_common.read_tag_stage_record(manifest, paper['analysisStageCheckpoints'])
        stage['bindingSha256'] = publish_common._manual_hash({k: stage[k] for k in record['bindingFields']})
        with self.assertRaises(publish_common.PublishDataValidationError):
            publish_common._validate_tag_stage_record(paper, manifest, 'new-in-old')


if __name__ == '__main__':
    unittest.main()
