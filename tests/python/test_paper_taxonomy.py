import copy
import csv
import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from paper_taxonomy import (FACET_IDS, ancestors, load_taxonomy, normalize_label,
                            prune_ancestors, resolve_label, validate_taxonomy)

SPEC = importlib.util.spec_from_file_location('build_taxonomy_preview', ROOT / 'scripts/build-taxonomy-preview.py')
preview = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preview)


def concept(cid, zh, en, parent=None, aliases=None):
    return {'id': cid, 'facet': cid.split('.')[0], 'preferredLabel': {'zh': zh, 'en': en},
            'aliases': aliases or [], 'broaderId': parent, 'definition': 'Defined concept.',
            'scopeNote': 'No inferred semantic classification.', 'status': 'active', 'replacedBy': None}


def registry():
    return {'version': 'paper-taxonomy-v1', 'facets': [{'id': facet, 'label': facet} for facet in FACET_IDS],
            'concepts': [concept('task.speech', '语音任务', 'Speech tasks'),
                         concept('task.asr', '语音识别', 'Automatic speech recognition', 'task.speech', ['ASR']),
                         concept('method.peft', '参数高效微调', 'Parameter-efficient fine-tuning'),
                         concept('method.lora', '低秩适配', 'LoRA', 'method.peft'),
                         concept('setting.low-resource', '低资源', 'Low resource')]}


class RegistryTest(unittest.TestCase):
    def test_literal_resolution_does_not_narrow_parent_to_lora(self):
        data = registry()
        self.assertIs(validate_taxonomy(data), data)
        for label in ('ASR', 'asr', ' ＃ＡＳＲ ', '\ufeff#ASR\ufeff'):
            self.assertEqual(resolve_label(data, label)['id'], 'task.asr')
        self.assertEqual(resolve_label(data, '参数高效微调')['id'], 'method.peft')
        self.assertIsNone(resolve_label(data, 'online'))
        self.assertEqual(ancestors(data, 'method.lora'), ['method.peft'])
        self.assertEqual(prune_ancestors(data, ['method.peft', 'method.lora', 'method.lora']),
                         ['method.lora', 'method.lora'])
        self.assertEqual(normalize_label('\u0085ASR\u0085'), '\u0085asr\u0085')
        self.assertIsNone(resolve_label(data, '\u0085ASR\u0085'))

    def test_cross_facet_ambiguity_requires_role_and_deprecated_never_autoforwards(self):
        data = registry()
        data['concepts'][0]['aliases'] = ['shared']
        data['concepts'][2]['aliases'] = ['shared']
        self.assertIsNone(resolve_label(data, 'shared'))
        self.assertEqual(resolve_label(data, 'shared', 'method')['id'], 'method.peft')
        old = concept('method.old-peft', '旧适配', 'Old adaptation')
        old.update(status='deprecated', replacedBy='method.peft')
        data['concepts'].append(old)
        self.assertEqual(resolve_label(data, '旧适配')['id'], 'method.old-peft')

    def test_invalid_ids_roles_cycles_aliases_and_metadata_fail_closed(self):
        changes = [lambda d: d.update(extra=True),
                   lambda d: d['facets'].pop(),
                   lambda d: d['concepts'][0].update(extra=True),
                   lambda d: d['concepts'][1].update(broaderId='method.peft'),
                   lambda d: d['concepts'][0].update(broaderId='task.asr'),
                   lambda d: d['concepts'][1].update(id='task.unsafe/path'),
                   lambda d: d['concepts'][1].update(aliases=['ASR', 'asr']),
                   lambda d: d['concepts'][0].update(aliases=['ASR']),
                   lambda d: d['concepts'][1].update(status='deprecated', replacedBy='missing'),
                   lambda d: d['concepts'][1].update(replacedBy='task.speech')]
        for change in changes:
            data = registry(); change(data)
            with self.subTest(data=data), self.assertRaises(ValueError):
                validate_taxonomy(data)
        for bad in ({**registry(), 'extra': 'x'}, {**registry(), 'registrySha256': 'bad'}):
            with self.assertRaises(ValueError):
                resolve_label(bad, 'ASR')

    def test_raw_sha_no_cache_duplicate_key_and_utf8_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'registry.json'
            target.write_text(json.dumps(registry()), encoding='utf-8')
            first = load_taxonomy(target)
            self.assertEqual(first['registrySha256'], hashlib.sha256(target.read_bytes()).hexdigest())
            target.write_text(json.dumps(registry(), indent=2), encoding='utf-8')
            self.assertNotEqual(first['registrySha256'], load_taxonomy(target)['registrySha256'])
            target.write_bytes(b'\xef\xbb\xbf' + json.dumps(registry()).encode())
            self.assertEqual(load_taxonomy(target)['registrySha256'], hashlib.sha256(target.read_bytes()).hexdigest())
            target.write_text('{"version":1,"\\u0076ersion":2}', encoding='utf-8')
            with self.assertRaises(ValueError): load_taxonomy(target)
            target.write_bytes(b'\xff')
            with self.assertRaises(UnicodeDecodeError): load_taxonomy(target)


class PreviewBuilderTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / 'blog'; self.repo.mkdir()
        self.posts = self.repo / 'content/posts'; self.posts.mkdir(parents=True)
        (self.repo / 'hugo.yaml').write_text('baseURL: "https://nanless.github.io/audio-paper-digest-blog/"\n')
        self.registry = self.root / 'registry.json'
        self.registry.write_text(json.dumps(registry()), encoding='utf-8')
        self.output = self.root / 'preview'
        self.git('init', '-q')
        self.git('config', 'user.name', 'Taxonomy Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], text=True).strip()

    def page(self, name='2026-09-04-paper-2609-00001.md', tags=None, **fields):
        frontmatter = {'title': 'Paper title', 'date': '2026-09-04', 'draft': False,
                       'tags': ['ASR', 'LoRA'] if tags is None else tags, **fields}
        target = self.posts / name
        target.write_text('---\n' + '\n'.join(f'{key}: {json.dumps(value, ensure_ascii=False)}'
                                            for key, value in frontmatter.items()) + '\n---\n'
                          + 'DO_NOT_EXPOSE_BODY_SECRET\n', encoding='utf-8')
        return target

    def commit(self):
        self.git('add', '.'); self.git('commit', '-qm', 'fixture')

    def build(self):
        return preview.build_preview(self.repo, self.output, self.registry)

    def test_read_only_metadata_shadow_preserves_raw_tags_and_never_first_tag_primary(self):
        page = self.page(tags=['语音任务', 'ASR', '参数高效微调', 'LoRA', 'unknown'])
        self.commit(); before = page.read_bytes()
        result = self.build(); item = result['papers'][0]
        self.assertEqual(item['tags'], ['语音任务', 'ASR', '参数高效微调', 'LoRA', 'unknown'])
        self.assertEqual(item['mappedIds'], ['task.speech', 'task.asr', 'method.peft', 'method.lora'])
        self.assertEqual(item['displayIds'], ['task.asr', 'method.lora'])
        self.assertEqual(item['ancestorIds']['task'], ['task.speech'])
        self.assertIsNone(item['primaryTaskId'])
        self.assertEqual(item['classificationStatus'], 'partial')
        self.assertEqual(item['unresolvedTags'], ['unknown'])
        public = (self.output / 'index.json').read_text()
        self.assertNotIn('DO_NOT_EXPOSE_BODY_SECRET', public)
        self.assertNotIn(str(self.repo), public)
        self.assertEqual(page.read_bytes(), before)
        self.assertEqual(self.git('status', '--porcelain=v1'), '')
        for filename in ('index.json', 'migration-report.json', 'tag-disposition.csv', 'bundle-manifest.json'):
            self.assertEqual(stat.S_IMODE((self.output / filename).stat().st_mode), 0o600)
        bundle = json.loads((self.output / 'bundle-manifest.json').read_text())
        for name, digest in bundle['files'].items():
            self.assertEqual(hashlib.sha256((self.output / name).read_bytes()).hexdigest(), digest)

    def test_explicit_task_not_in_tags_is_preserved_and_unknown_primary_is_diagnostic(self):
        self.page(tags=['LoRA'], paper_digest_primary_task='ASR')
        self.page('2026-09-04-other-2609-00002.md', tags=['LoRA'], paper_digest_primary_task='Uncertain task')
        self.commit()
        records = {item['id']: item for item in self.build()['papers']}
        first = records['2609.00001']; second = records['2609.00002']
        self.assertEqual(first['tags'], ['LoRA'])
        self.assertIn('task.asr', first['facetIds']['task'])
        self.assertEqual(first['primaryTaskId'], 'task.asr')
        self.assertEqual(first['primaryTaskSource'], [{'field': 'paper_digest_primary_task', 'value': 'ASR'}])
        self.assertEqual(second['classificationStatus'], 'partial')
        self.assertEqual(second['primaryUnresolved'][0]['value'], 'Uncertain task')
        self.assertIsNone(second['primaryTaskId'])
        self.assertEqual(second['unresolvedTags'], [])

    def test_duplicates_unknown_ids_and_exclusions_keep_auditable_denominators(self):
        self.page('2026-09-03-paper-2609-00001.md', date='2026-09-03')
        self.page('2026-09-04-paper-2609-00001.md', tags=['unknown'])
        self.page('icassp2026-paper-a.md', tags=[])
        self.page('icassp2026-paper-b.md', tags=['ASR'])
        self.page('2026-09-04.md')
        self.page('icassp2026-task-19.md')
        self.page('draft.md', draft=True)
        self.commit(); result = self.build()
        self.assertEqual(result['summary']['markdownPages'], 7)
        self.assertEqual(result['summary']['paperPages'], 4)
        self.assertEqual(result['summary']['records'], 3)
        self.assertEqual(result['summary']['knownIdCount'], 1)
        known = next(item for item in result['papers'] if item['id'])
        self.assertEqual(known['tags'], ['unknown'])
        self.assertEqual(len(known['duplicatePaths']), 1)
        unknown = [item for item in result['papers'] if item['id'] is None]
        self.assertTrue(all(item['recordId'].startswith('page:') for item in unknown))
        self.assertEqual(len({item['recordId'] for item in unknown}), 2)
        self.assertEqual(result['summary']['semanticallyReviewedRecords'], 0)

    def test_csv_formula_injection_is_escaped_but_json_raw_value_is_kept(self):
        self.page(tags=['=SUM(1,2)', '+cmd', '-cmd', '@cmd', 'ASR'])
        self.commit(); result = self.build()
        self.assertIn('=SUM(1,2)', result['papers'][0]['tags'])
        with (self.output / 'tag-disposition.csv').open() as handle:
            tags = [row['tag'] for row in csv.DictReader(handle)]
        self.assertIn("'=SUM(1,2)", tags)
        self.assertIn("'+cmd", tags)
        self.assertEqual(result['summary']['uniqueTagCoverage'], 0.2)

    def test_dirty_tree_and_unsafe_metadata_urls_fail_without_output_index(self):
        page = self.page(); self.commit()
        page.write_text(page.read_text() + 'changed')
        with self.assertRaisesRegex(ValueError, 'clean'): self.build()
        self.assertFalse((self.output / 'index.json').exists())
        self.git('add', '.'); self.git('commit', '-qm', 'changed')
        for url in ('javascript:alert(1)', 'https://evil.example/x', '/audio-paper-digest-blog/../private',
                    '/audio-paper-digest-blog/%252e%252e/private'):
            self.page(url=url); self.commit()
            with self.subTest(url=url), self.assertRaises(ValueError): self.build()

    def test_symlink_input_output_and_protected_output_root_fail_closed(self):
        page = self.page(); self.commit()
        other = self.root / 'foreign.md'; other.write_bytes(page.read_bytes())
        page.unlink(); page.symlink_to(other); self.commit()
        with self.assertRaisesRegex(ValueError, 'symlink'): self.build()
        page.unlink(); self.page(); self.commit()
        self.output.rmdir()
        self.output.symlink_to(self.repo, target_is_directory=True)
        with self.assertRaises((ValueError, OSError)): self.build()
        self.output.unlink()
        with self.assertRaises(ValueError): preview.build_preview(self.repo, self.repo, self.registry)

    def test_page_changes_during_scan_fail_before_installing_public_index(self):
        page = self.page(); self.commit()
        original = preview.paper_metadata
        def drift(*args):
            result = original(*args)
            page.write_text(page.read_text() + 'concurrent change')
            return result
        with mock.patch.object(preview, 'paper_metadata', side_effect=drift):
            with self.assertRaises(ValueError): self.build()
        self.assertFalse((self.output / 'index.json').exists())

    def test_identity_conflicts_invalid_explicit_and_primary_type_do_not_fallback(self):
        cases = [dict(paper_digest_arxiv_id='2609.00002'),
                 dict(paper_digest_arxiv_id='2609.00001', arxivId='2609.00002'),
                 dict(paper_digest_arxiv_id='invalid'), dict(primaryTask=['ASR'])]
        for fields in cases:
            self.page(**fields); self.commit()
            with self.subTest(fields=fields), self.assertRaises(ValueError): self.build()
        page = self.page(paper_digest_arxiv_id='2609.00001v3')
        page.write_text(page.read_text() + '[arxiv](https://arxiv.org/abs/2609.00002v1)')
        self.commit()
        with self.assertRaisesRegex(ValueError, 'Conflicting'): self.build()
        page.write_text(page.read_text().replace('2609.00002v1', '2609.00001v2'))
        self.commit()
        self.assertEqual(self.build()['papers'][0]['id'], '2609.00001')

    def test_interrupted_bundle_write_is_detectable_and_rebuild_recovers(self):
        self.page(); self.commit(); self.build()
        old_bundle = (self.output / 'bundle-manifest.json').read_bytes()
        self.page(tags=['unknown']); self.commit()
        original = preview.path_config.atomic_write_json
        def interrupted(target, *args, **kwargs):
            if Path(target).name == 'bundle-manifest.json':
                raise OSError('injected EIO')
            return original(target, *args, **kwargs)
        with mock.patch.object(preview.path_config, 'atomic_write_json', side_effect=interrupted):
            with self.assertRaises(OSError): self.build()
        self.assertEqual((self.output / 'bundle-manifest.json').read_bytes(), old_bundle)
        stale = json.loads(old_bundle)
        self.assertNotEqual(hashlib.sha256((self.output / 'index.json').read_bytes()).hexdigest(), stale['files']['index.json'])
        self.build()
        bundle = json.loads((self.output / 'bundle-manifest.json').read_text())
        for name, digest in bundle['files'].items():
            self.assertEqual(hashlib.sha256((self.output / name).read_bytes()).hexdigest(), digest)
