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
from tag_catalog import (FACET_IDS, LABEL_MODE_LEGACY, TAG_FLAT_COMPAT_CONTRACT,
                            LEGACY_TAG_FLAT_COMPAT_CONTRACT,
                            TAG_PROMPT_TEXT_CONTRACT, LEGACY_TAG_PROMPT_TEXT_CONTRACT,
                            build_tag_prompt_text, tag_prompt_text_sha256,
                            active_preferred_labels,
                            ancestors, load_tag_catalog, normalize_label,
                            prune_ancestors, resolve_current_label, resolve_label,
                            resolve_label_candidates, validate_tag_catalog)

SPEC = importlib.util.spec_from_file_location('build_tag_preview', ROOT / 'scripts/build-tag-preview.py')
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
    def test_versioned_prompt_preserves_legacy_bytes_and_defaults_to_new_text(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'catalog.json'
            target.write_text(json.dumps(registry(), ensure_ascii=False), encoding='utf-8')
            catalog = load_tag_catalog(target)
        expected = (
            'contract=paper-taxonomy-prompt-projection-v1\n'
            'registry_version=paper-taxonomy-v1\n'
            f'registry_sha256={catalog["registrySha256"]}\n'
            '只允许输出下列 active 概念的中文首选标签；ID 用于消歧，不得自造标签或输出同义词。\n'
            '[task]\n'
            'task.asr|#语音识别|Defined concept.|No inferred semantic classification.\n'
            'task.speech|#语音任务|Defined concept.|No inferred semantic classification.\n'
            '[method]\n'
            'method.lora|#低秩适配|Defined concept.|No inferred semantic classification.\n'
            'method.peft|#参数高效微调|Defined concept.|No inferred semantic classification.\n'
            '[setting]\n'
            'setting.low-resource|#低资源|Defined concept.|No inferred semantic classification.\n'
        )
        self.assertEqual(build_tag_prompt_text(catalog, LEGACY_TAG_PROMPT_TEXT_CONTRACT), expected)
        self.assertEqual(tag_prompt_text_sha256(catalog, LEGACY_TAG_PROMPT_TEXT_CONTRACT),
                         hashlib.sha256(expected.encode('utf-8')).hexdigest())
        new_lines = expected.splitlines(keepends=True)
        new_lines[0] = 'contract=paper-tag-prompt-text-v2\n'
        new_lines[3] = ('只能选择以下已启用概念的中文首选标签。ID 用于区分概念；'
                        '不要创建新标签，也不要改用同义词。\n')
        new_text = ''.join(new_lines)
        self.assertEqual(build_tag_prompt_text(catalog), new_text)
        self.assertEqual(build_tag_prompt_text(catalog, TAG_PROMPT_TEXT_CONTRACT), new_text)
        self.assertEqual(tag_prompt_text_sha256(catalog),
                         hashlib.sha256(new_text.encode('utf-8')).hexdigest())
        for contract in (None, '', 'paper-tag-prompt-text-v3', 2, [], {}):
            with self.subTest(contract=contract):
                with self.assertRaisesRegex(ValueError, '版本不受支持'):
                    build_tag_prompt_text(catalog, contract)
                with self.assertRaisesRegex(ValueError, '版本不受支持'):
                    tag_prompt_text_sha256(catalog, contract)

    def test_catalog_versions_keep_explicit_legacy_bytes_and_require_current_default(self):
        self.assertEqual(load_tag_catalog()['version'], 'paper-tag-catalog-v2')
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'legacy.json'
            raw = json.dumps(registry(), ensure_ascii=False).encode('utf-8')
            target.write_bytes(raw)
            loaded = load_tag_catalog(target)
            self.assertEqual(loaded['version'], 'paper-taxonomy-v1')
            self.assertEqual(loaded['registrySha256'], hashlib.sha256(raw).hexdigest())
            with mock.patch('tag_paths.TAG_CATALOG_FILE', target):
                with self.assertRaisesRegex(ValueError, '当前标签词表必须使用 paper-tag-catalog-v2'):
                    load_tag_catalog()
        for version in (None, '', 'paper-tag-catalog-v3', 2, [], {}):
            data = registry()
            data['version'] = version
            with self.subTest(version=version), self.assertRaisesRegex(ValueError, '版本不受支持'):
                validate_tag_catalog(data)

    def test_flat_hugo_compat_contract_is_versioned(self):
        self.assertEqual(
            TAG_FLAT_COMPAT_CONTRACT,
            'paper-tag-flat-tags-v2',
        )

        self.assertEqual(LEGACY_TAG_FLAT_COMPAT_CONTRACT, 'paper-taxonomy-flat-tags-compat-v1')

    def test_current_resolution_only_exposes_active_chinese_preferred_labels(self):
        data = registry()
        self.assertIs(validate_tag_catalog(data), data)
        for label in ('语音识别', '#语音识别', ' ＃语音识别 '):
            self.assertEqual(resolve_current_label(data, label)['id'], 'task.asr')
        for label in ('ASR', 'asr', ' ＃ＡＳＲ ', '\ufeff#ASR\ufeff',
                      'Automatic speech recognition'):
            self.assertIsNone(resolve_current_label(data, label))
            # The generic library resolver retains its historical namespace;
            # production parsing opts into current mode independently.
            self.assertEqual(resolve_label(data, label)['id'], 'task.asr')
            self.assertEqual(resolve_label(data, label, mode=LABEL_MODE_LEGACY)['id'],
                             'task.asr')
        self.assertEqual(resolve_label(data, '参数高效微调')['id'], 'method.peft')
        self.assertIsNone(resolve_label(data, 'online'))
        self.assertEqual(ancestors(data, 'method.lora'), ['method.peft'])
        self.assertEqual(prune_ancestors(data, ['method.peft', 'method.lora', 'method.lora']),
                         ['method.lora', 'method.lora'])
        self.assertEqual(normalize_label('\u0085ASR\u0085'), '\u0085asr\u0085')
        self.assertIsNone(resolve_label(data, '\u0085ASR\u0085'))
        self.assertEqual(active_preferred_labels(data, ('task',)), ('语音任务', '语音识别'))
        self.assertEqual([item['id'] for item in resolve_label_candidates(
            data, 'ASR', mode=LABEL_MODE_LEGACY)], ['task.asr'])

    def test_cross_facet_ambiguity_requires_role_and_deprecated_never_autoforwards(self):
        data = registry()
        data['concepts'][0]['aliases'] = ['shared']
        data['concepts'][2]['aliases'] = ['shared']
        self.assertIsNone(resolve_label(data, 'shared'))
        self.assertIsNone(resolve_current_label(data, 'shared', 'method'))
        self.assertEqual(resolve_label(
            data, 'shared', 'method', mode=LABEL_MODE_LEGACY)['id'], 'method.peft')
        old = concept('method.old-peft', '旧适配', 'Old adaptation')
        old.update(status='deprecated', replacedBy='method.peft')
        data['concepts'].append(old)
        self.assertIsNone(resolve_current_label(data, '旧适配'))
        self.assertEqual(resolve_label(
            data, '旧适配', mode=LABEL_MODE_LEGACY)['id'], 'method.old-peft')

    def test_current_projection_rejects_cross_facet_preferred_label_collision(self):
        data = registry()
        data['concepts'][2]['preferredLabel']['zh'] = '语音识别'
        self.assertIs(validate_tag_catalog(data), data)
        with self.assertRaisesRegex(ValueError, '所选分类维度中已启用概念的中文首选名称不能重复。'):
            active_preferred_labels(data)
        with self.assertRaisesRegex(ValueError, '未知的标签查找模式：automatic。'):
            resolve_label(data, '语音识别', mode='automatic')

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
                validate_tag_catalog(data)
        for bad in ({**registry(), 'extra': 'x'}, {**registry(), 'registrySha256': 'bad'}):
            with self.assertRaises(ValueError):
                resolve_label(bad, 'ASR')

    def test_raw_sha_no_cache_duplicate_key_and_utf8_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'registry.json'
            target.write_text(json.dumps(registry()), encoding='utf-8')
            first = load_tag_catalog(target)
            self.assertEqual(first['registrySha256'], hashlib.sha256(target.read_bytes()).hexdigest())
            target.write_text(json.dumps(registry(), indent=2), encoding='utf-8')
            self.assertNotEqual(first['registrySha256'], load_tag_catalog(target)['registrySha256'])
            target.write_bytes(b'\xef\xbb\xbf' + json.dumps(registry()).encode())
            self.assertEqual(load_tag_catalog(target)['registrySha256'], hashlib.sha256(target.read_bytes()).hexdigest())
            target.write_text('{"version":1,"\\u0076ersion":2}', encoding='utf-8')
            with self.assertRaises(ValueError): load_tag_catalog(target)
            target.write_bytes(b'\xff')
            with self.assertRaises(UnicodeDecodeError): load_tag_catalog(target)


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
        self.assertEqual(result['version'], 'paper-tag-preview-v2')
        self.assertEqual(result['tagCatalogVersion'], registry()['version'])
        self.assertNotIn('taxonomyVersion', result)
        self.assertEqual(result['summary']['dispositionSchema'], 'paper-tag-seven-state-disposition-v2')
        self.assertEqual(preview.tag_paths.TAG_PREVIEW_DIR.parts[-2:], ('runtime', 'tag-preview'))
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
        self.assertEqual(bundle['version'], 'paper-tag-preview-bundle-v2')
        report = json.loads((self.output / 'migration-report.json').read_text())
        self.assertEqual(report['version'], 'paper-tag-migration-report-v2')
        for document in (bundle, report):
            self.assertEqual(document['tagCatalogVersion'], result['tagCatalogVersion'])
            self.assertNotIn('taxonomyVersion', document)
        self.assertEqual(report['dispositionSchema'], 'paper-tag-seven-state-disposition-v2')
        self.assertEqual(report['summary']['dispositionSchema'], report['dispositionSchema'])
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

    def test_seven_state_csv_schema_and_initial_dispositions(self):
        self.page(tags=['语音任务', 'ASR', '自动语音识别', '语音任务与语音识别', 'totally-unknown'])
        self.commit(); self.build()
        with (self.output / 'tag-disposition.csv').open() as handle:
            reader = csv.DictReader(handle)
            self.assertEqual(reader.fieldnames, list(preview.DISPOSITION_CSV_COLUMNS))
            rows = {row['tag']: row for row in reader}
        # 旧列原样保留且语义不变
        for column in preview.LEGACY_CSV_COLUMNS:
            self.assertIn(column, rows['ASR'])
        self.assertEqual(rows['ASR']['status'], 'mapped')
        self.assertEqual(rows['ASR']['conceptId'], 'task.asr')
        self.assertEqual(rows['ASR']['semanticReview'], 'not_performed')
        # 初始处理方式：唯一命中启用概念的中文首选名称时选 keep，经别名命中时选 alias。
        self.assertEqual(rows['语音任务']['disposition'], 'keep')
        self.assertEqual(rows['ASR']['disposition'], 'alias')
        # 原标签只包含一个候选中文标签时，初始处理方式为 broader；仍保留原标签并标为 needs_review。
        self.assertEqual(rows['自动语音识别']['disposition'], 'broader')
        self.assertEqual(rows['自动语音识别']['status'], 'needs_review')
        self.assertEqual(rows['自动语音识别']['conceptId'], '')
        evidence = json.loads(rows['自动语音识别']['evidence'])
        self.assertEqual(evidence['upperConceptId'], 'task.asr')
        # 没有候选或有多个候选时，暂不选择处理方式，并记录原因或候选。
        self.assertEqual(rows['totally-unknown']['disposition'], '')
        self.assertIn('词表中没有与该标签对应的名称或别名', json.loads(rows['totally-unknown']['evidence'])['reason'])
        multi = json.loads(rows['语音任务与语音识别']['evidence'])
        self.assertEqual(len(multi['candidates']), 2)
        summary = json.loads((self.output / 'migration-report.json').read_text())['summary']
        self.assertEqual(summary['dispositionSchema'], preview.DISPOSITION_SCHEMA)
        self.assertEqual(summary['dispositionCounts'],
                         {'keep': 1, 'alias': 1, 'broader': 1, 'split_review': 0,
                          'move_facet': 0, 'deprecated': 0, 'out_of_scope': 0})
        self.assertEqual(summary['pendingDispositions'], 2)
        # 兼容旧列读取：新 CSV 能被统一读取器解析并再次通过校验
        preview.read_disposition_rows((self.output / 'tag-disposition.csv').read_text())


    def test_dirty_tree_and_unsafe_metadata_urls_fail_without_output_index(self):
        page = self.page(); self.commit()
        page.write_text(page.read_text() + 'changed')
        with self.assertRaisesRegex(ValueError, '博客输入必须是已提交的干净 Git 工作区。'): self.build()
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
        with self.assertRaisesRegex(ValueError, '博客内容目录中不得包含符号链接。'): self.build()
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
        with self.assertRaisesRegex(ValueError, '的 arXiv ID 相互冲突。'): self.build()
        page.write_text(page.read_text().replace('2609.00002v1', '2609.00001v2'))
        self.commit()
        self.assertEqual(self.build()['papers'][0]['id'], '2609.00001')

    def test_current_preview_rejects_overwriting_legacy_bundle_without_changing_files(self):
        page = self.page()
        self.commit()
        self.build()
        original_page = page.read_bytes()
        versions = {'index.json': 'paper-taxonomy-preview-v1',
                    'migration-report.json': 'paper-taxonomy-migration-report-v1',
                    'bundle-manifest.json': 'paper-taxonomy-preview-bundle-v1'}
        for name, version in versions.items():
            target = self.output / name
            document = json.loads(target.read_bytes())
            document['version'] = version
            document['taxonomyVersion'] = document.pop('tagCatalogVersion')
            if 'summary' in document:
                document['summary']['dispositionSchema'] = 'paper-taxonomy-seven-state-disposition-v1'
            if 'dispositionSchema' in document:
                document['dispositionSchema'] = 'paper-taxonomy-seven-state-disposition-v1'
            target.write_text(json.dumps(document, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        manifest_path = self.output / 'bundle-manifest.json'
        manifest = json.loads(manifest_path.read_bytes())
        for name in manifest['files']:
            manifest['files'][name] = hashlib.sha256((self.output / name).read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        before = {name: ((self.output / name).read_bytes(), stat.S_IMODE((self.output / name).stat().st_mode))
                  for name in (*manifest['files'], 'bundle-manifest.json')}
        with self.assertRaisesRegex(ValueError, '已有索引的版本不符合标签预览协议，拒绝覆盖。'):
            self.build()
        self.assertEqual({name: ((self.output / name).read_bytes(), stat.S_IMODE((self.output / name).stat().st_mode))
                          for name in before}, before)
        self.assertEqual(page.read_bytes(), original_page)
        new_output = self.root / 'current-preview'
        current = preview.build_preview(self.repo, new_output, self.registry)
        self.assertEqual(current['version'], 'paper-tag-preview-v2')
        self.assertEqual((new_output / 'tag-disposition.csv').read_bytes(), before['tag-disposition.csv'][0])
        self.assertEqual({name: ((self.output / name).read_bytes(), stat.S_IMODE((self.output / name).stat().st_mode))
                          for name in before}, before)

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


class SevenStateDispositionTest(unittest.TestCase):
    """核对七种处理方式的适用条件、证据要求及旧表头兼容读取。"""

    def row(self, **overrides):
        base = {'tag': '旧标签', 'pageCount': 3, 'disposition': '', 'status': 'needs_review',
                'conceptId': '', 'facet': '', 'semanticReview': 'not_performed',
                'evidence': {'reason': '待评审'}}
        base.update(overrides)
        return base

    def test_seven_state_membership_and_mutual_exclusion(self):
        valid = self.row(disposition='keep', status='mapped', conceptId='task.asr')
        self.assertEqual(preview.validate_disposition_rows([valid]), [valid])
        # 拒绝不在七种处理方式中的取值。
        for bad in ('drop', 'KEEP', 'merged'):
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, '不在允许的七种处理方式中'):
                preview.validate_disposition_rows([self.row(disposition=bad)])
        # keep/alias 只能出现在 status=mapped 且必须带 conceptId
        with self.assertRaisesRegex(ValueError, '采用 keep 处理方式时，status 必须为 mapped。'):
            preview.validate_disposition_rows([self.row(disposition='keep', conceptId='task.asr')])
        with self.assertRaisesRegex(ValueError, 'conceptId'):
            preview.validate_disposition_rows([self.row(disposition='alias', status='mapped')])
        # 未评审的 needs_review 行不得凭空变 keep/alias
        with self.assertRaisesRegex(ValueError, '采用 keep 处理方式时，status 必须为 mapped。'):
            preview.validate_disposition_rows([self.row(disposition='keep', status='needs_review',
                                                        conceptId='task.asr')])
        # broader 记录必须保留 needs_review 状态并提供候选概念 ID。
        with self.assertRaisesRegex(ValueError, 'broader 处理方式要求 status 为 needs_review，并在 evidence.upperConceptId 中填写上级概念 ID。'):
            preview.validate_disposition_rows([self.row(disposition='broader')])
        preview.validate_disposition_rows([self.row(disposition='broader',
                                                    evidence={'upperConceptId': 'task.asr'})])

    def test_split_review_requires_candidate_term_list(self):
        for evidence in ({}, {'candidates': []}, {'candidates': ['']},
                         {'candidates': [1]}, 'not-json'):
            with self.subTest(evidence=evidence), self.assertRaises(ValueError):
                preview.validate_disposition_rows([self.row(disposition='split_review',
                                                            evidence=evidence)])
        preview.validate_disposition_rows([self.row(disposition='split_review',
                                                    evidence={'candidates': ['语音识别', '说话人分离']})])

    def test_deprecated_and_out_of_scope_need_zero_hit_scan_and_reviewer(self):
        # “本次会议没用到”不构成证据：缺跨会零命中扫描或人工评审一律报错
        for state in ('deprecated', 'out_of_scope'):
            for evidence in ({}, {'crossConferenceZeroHit': {}},
                             {'crossConferenceZeroHit': {'scan': 'seal-1'}},
                             {'crossConferenceZeroHit': {'scan': 'seal-1'}, 'reviewedBy': ' '}):
                with self.subTest(state=state, evidence=evidence), self.assertRaises(ValueError):
                    preview.validate_disposition_rows([self.row(disposition=state, evidence=evidence)])
            preview.validate_disposition_rows([
                self.row(disposition=state, status='mapped', conceptId='task.asr',
                         evidence={'crossConferenceZeroHit': {'scan': 'cross-conference-scan-v1',
                                                              'papersScanned': 4069},
                                   'reviewedBy': 'human-reviewer'})])

    def test_move_facet_and_pending_rows_are_guarded(self):
        with self.assertRaisesRegex(ValueError, 'evidence.facet 必须属于九个分类维度之一。'):
            preview.validate_disposition_rows([self.row(disposition='move_facet', status='mapped',
                                                        conceptId='task.asr', facet='task',
                                                        evidence={'facet': 'bogus'})])
        with self.assertRaisesRegex(ValueError, '目标分类维度必须与当前维度不同'):
            preview.validate_disposition_rows([self.row(disposition='move_facet', status='mapped',
                                                        conceptId='task.asr', facet='task',
                                                        evidence={'facet': 'task'})])
        # 未处置必须写原因；重复 tag 必须拒绝
        with self.assertRaisesRegex(ValueError, 'reason'):
            preview.validate_disposition_rows([self.row(evidence={})])
        with self.assertRaisesRegex(ValueError, '重复'):
            preview.validate_disposition_rows([self.row(), self.row()])

    def test_legacy_six_column_rows_stay_readable(self):
        legacy = ('tag,pageCount,status,conceptId,facet,semanticReview\n'
                  'ASR,12,mapped,task.asr,task,not_performed\n'
                  '未知词,4,needs_review,,,not_performed\n')
        rows = preview.read_disposition_rows(legacy)
        self.assertEqual(len(rows), 2)
        self.assertNotIn('disposition', rows[0])
        self.assertEqual(rows[0]['conceptId'], 'task.asr')

    def test_initial_disposition_mapping_rules(self):
        data = registry()
        data['concepts'].append(concept('task.old-asr', '旧识别', 'Old recognition',
                                        'task.speech', ['识别旧名']))
        data['concepts'][-1].update(status='deprecated', replacedBy='task.asr')
        by_id = {item['id']: item for item in data['concepts']}
        cases = [('语音识别', 'task.asr', 'keep'),
                 ('ASR', 'task.asr', 'alias'),
                 ('automatic speech recognition', 'task.asr', 'alias'),
                 ('自动语音识别', None, 'broader'),
                 ('语音任务与语音识别', None, ''),
                 ('完全没有的词', None, ''),
                 ('旧识别', 'task.old-asr', '')]
        for tag, cid, expected in cases:
            concept_value = by_id.get(cid)
            disposition, evidence = preview.initial_disposition(tag, concept_value, data)
            with self.subTest(tag=tag):
                self.assertEqual(disposition, expected)
                if not disposition:
                    self.assertTrue(evidence.get('reason') or evidence.get('candidates'))
                if disposition == 'broader':
                    self.assertEqual(evidence['upperConceptId'], 'task.asr')
        # deprecated 命中只能是 pending：禁按单会议频次/零命中缺证据自动判 deprecated
        disposition, evidence = preview.initial_disposition('旧识别', by_id['task.old-asr'], data)
        self.assertEqual(disposition, '')
        self.assertIn('须经跨会议扫描和人工评审，确认没有命中', evidence['reason'])
