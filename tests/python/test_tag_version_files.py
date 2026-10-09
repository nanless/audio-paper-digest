"""隔离的测试环境：从语法树中只加载所需函数，不读 .env、不调 API、不写日更数据，也不引入发布主模块。"""
import ast
import base64
import copy
import hashlib
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


SOURCE = Path(os.environ.get('SOURCE_PUBLISHER_PATH',
    str(Path(__file__).resolve().parents[2] / 'scripts/publish-to-blog.py')))
NAMES = {'_validate_tag_display_policy', '_historical_tag_prompt_text_sha256',
    '_select_tag_display_version', 'build_tag_catalog_snapshot', 'tag_catalog_snapshot_bytes',
    '_validate_tag_catalog_snapshot', '_validate_tag_version_catalog', '_is_tag_catalog_file_path',
    '_read_tag_catalog_file', 'tag_catalog_file_contents', '_legacy_tag_catalog_file_contents',
    '_build_tag_catalog_display_snapshot', '_read_approved_tag_display_policy',
    '_saved_tag_catalog_file_contents',
    'prepare_tag_catalog_staged_files', 'export_tag_catalog_files',
    '_manifest_record', 'review_tag_catalog_files', 'publish_manifest_paths',
    'prepare_generation_installation', 'resume_generation_installation',
    'validate_manifest_clean_against_head'}


class TagVersionFilesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.repo = self.root / 'blog'
        self.repo.mkdir()
        self.stage = self.root / 'stage'
        self.stage.mkdir()
        tree = ast.parse(SOURCE.read_text())
        current_names = NAMES - {'_legacy_tag_catalog_file_contents'}
        nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                 and node.name in current_names]
        # 旧生成器只用于离线构造旧格式测试数据，保存的旧生成器原字节不随 SOURCE 改变。
        original_writer_path = (Path(__file__).resolve().parents[1] / 'fixtures'
                                / 'tag-catalog-original-writer.txt')
        original_writer_raw = original_writer_path.read_bytes()
        self.assertEqual(hashlib.sha256(original_writer_raw).hexdigest(),
                         '70b72b96a3b40a5be82b9f1c5b0e35093d51af2bc457fed84b71c0e7e7b87a3c')
        original_writer_tree = ast.parse(original_writer_raw)
        self.assertEqual(len(original_writer_tree.body), 1)
        original_writer = original_writer_tree.body[0]
        self.assertIsInstance(original_writer, ast.FunctionDef)
        self.assertEqual(original_writer.name, '_legacy_tag_catalog_file_contents')
        nodes.append(original_writer)
        self.assertEqual({node.name for node in nodes}, NAMES)
        class ValidationError(Exception):
            pass
        self.error = ValidationError
        self.env = {'Path': Path, 'json': json, 're': re, 'hashlib': hashlib,
            'PublishDataValidationError': ValidationError, 'BLOG_REPO': str(self.repo),
            'TAG_CATALOG_SNAPSHOT_CONTRACT': 'paper-tag-catalog-snapshot-v2',
            'LEGACY_TAG_CATALOG_SNAPSHOT_CONTRACT': 'paper-taxonomy-registry-snapshot-v1',
            'TAG_CATALOG_VERSIONS_CONTRACT': 'paper-tag-catalog-versions-v2',
            'LEGACY_TAG_CATALOG_VERSIONS_CONTRACT': 'paper-taxonomy-version-catalog-v1',
            'TAG_PRESENTATION_POLICY_CONTRACT': 'paper-tag-presentation-policy-v2',
            'LEGACY_TAG_PRESENTATION_POLICY_CONTRACT': 'paper-taxonomy-presentation-selection-v1',
            'TAG_DISPLAY_POLICY_PATH': self.root / 'absent-approved-policy.json',
            'VISUAL_SUMMARY_KINDS': set(), 'RESEARCHER_SIDECAR_FILENAMES': set()}
        self.env['_atomic_write_bytes'] = self.write
        self.env['_sha256_file'] = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
        self.env['_PAGE_TAG_CATALOG'] = {'registrySha256': 'b'*64, 'version': 'v2', 'concepts': [
            {'id': 'task.child', 'facet': 'task', 'preferredLabel': {'zh': '新名字', 'en': 'new'},
             'aliases': [], 'broaderId': None, 'status': 'active',
             'definition': '原登记定义', 'scopeNote': '原登记排除说明'}]}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SOURCE), 'exec'), self.env)
        self.current = self.call('build_tag_catalog_snapshot')
        self.old = json.loads(json.dumps(self.current))
        self.old.update(registrySha256='a'*64, registryVersion='v1',
                        contract='paper-taxonomy-registry-snapshot-v1')
        self.old['concepts'][0]['zh'] = '旧名字'
        self.old['concepts'][0]['definition'] = '旧定义'

    def call(self, name, *args, **kwargs):
        return self.env[name](*args, **kwargs)

    @staticmethod
    def write(path, raw):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)

    def put(self, relative, data):
        self.write(self.repo / relative, self.call('tag_catalog_snapshot_bytes', data))

    def seed(self):
        for prefix in ('data', 'static/data'):
            self.put(f'{prefix}/taxonomy-registry.json', self.old)

    def test_canonical_export_preserves_old_snapshot_and_current_definitions(self):
        self.seed()
        paths = self.call('export_tag_catalog_files', self.repo)
        self.assertEqual(len(paths), 8)
        catalog = json.loads((self.repo/'data/tag-catalog-versions.json').read_text())
        self.assertEqual(catalog['currentSha256'], 'b'*64)
        self.assertEqual(catalog['snapshots'], [self.old, self.current])
        self.assertEqual(self.call('export_tag_catalog_files', self.repo), [])
        self.assertEqual((self.repo/'data/tag-catalog-history'/('a'*64+'.json')).read_bytes(),
                         (self.repo/'static/data/tag-catalog-history'/('a'*64+'.json')).read_bytes())
        self.assertFalse((self.repo / 'data/taxonomy-snapshots').exists())

    def test_staging_never_installs_blog_assets(self):
        self.seed()
        before = (self.repo/'data/taxonomy-registry.json').read_bytes()
        paths = self.call('prepare_tag_catalog_staged_files', self.stage, self.repo)
        self.assertEqual(len(paths), 8)
        self.assertEqual((self.repo/'data/taxonomy-registry.json').read_bytes(), before)
        self.assertFalse((self.repo/'data/taxonomy-catalog.json').exists())

    def test_invalid_archive_fails_before_any_write(self):
        self.seed()
        self.put('data/taxonomy-snapshots/'+'c'*64+'.json', self.old)
        with self.assertRaisesRegex(self.error, '标签词表归档文件名中的 SHA 与快照记录不一致。'):
            self.call('prepare_tag_catalog_staged_files', self.stage, self.repo)
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_immutable_sha_collision_and_catalog_drift_are_rejected(self):
        self.seed()
        changed = json.loads(json.dumps(self.old))
        changed['concepts'][0]['ancestorIds'] = ['task.absent']
        self.put('data/taxonomy-snapshots/'+'a'*64+'.json', changed)
        with self.assertRaisesRegex(self.error, '保存的标签概念的上级列表包含缺失、跨分类或停用的概念，或与上级概念记录的顺序不一致。'):
            self.call('tag_catalog_file_contents', self.repo)
        changed['concepts'][0]['ancestorIds'] = []
        changed['concepts'][0]['zh'] = '冒名'
        self.put('data/taxonomy-snapshots/'+'a'*64+'.json', changed)
        with self.assertRaisesRegex(self.error, '标签词表的同一个 SHA 对应了不同的快照内容'):
            self.call('tag_catalog_file_contents', self.repo)

    def test_symlink_and_uncontrolled_paths_rejected(self):
        (self.repo/'data').symlink_to(self.stage, target_is_directory=True)
        with self.assertRaisesRegex(self.error, '标签词表文件的路径超出了博客仓库。'):
            self.call('tag_catalog_file_contents', self.repo)
        for relative in ('data/unrelated.json', 'static/data/taxonomy-snapshots/no.json',
                         'data/../taxonomy-registry.json', 'data\\taxonomy-registry.json'):
            self.assertFalse(self.call('_is_tag_catalog_file_path', relative))
        self.assertTrue(self.call('_is_tag_catalog_file_path', 'data/taxonomy-registry.json'))
        self.assertTrue(self.call('_is_tag_catalog_file_path', 'data/tag-catalog-history/'+'a'*64+'.json'))
        self.assertTrue(self.call('_is_tag_catalog_file_path', 'static/data/tag-catalog-history/'+'a'*64+'.json'))
        self.assertFalse(self.call('_is_tag_catalog_file_path', 'data/tag-catalog-history/not-a-sha.json'))

    def test_single_page_cannot_upgrade_global_registry(self):
        self.seed()
        with self.assertRaisesRegex(self.error, '单篇发布不得'):
            self.call('prepare_tag_catalog_staged_files', self.stage, self.repo, single_page=True)
        self.call('export_tag_catalog_files', self.repo)
        self.assertEqual(self.call('prepare_tag_catalog_staged_files', self.stage,
                                  self.repo, single_page=True), [])

    def test_tag_files_are_precise_manifest_members_and_journalled(self):
        self.seed()
        paths = self.call('prepare_tag_catalog_staged_files', self.stage, self.repo)
        posts = self.stage/'posts'
        posts.mkdir()
        (posts/'2026-09-30-example.md').write_text('a page')
        target = self.repo/'content/posts'
        target.mkdir(parents=True)
        captured = []
        self.env.update({'prior_api_reader_manifest_assets': lambda date: [],
            '_is_pipeline_owned_paper': lambda path, date: False,
            'generation_manifest_path': lambda date: self.root/'absent.json',
            'validate_manifest_clean_against_head': lambda paths, **kw: captured.extend(paths),
            '_sha256_file': lambda path: hashlib.sha256(path.read_bytes()).hexdigest(),
            '_file_fingerprint': lambda path: {'deleted': not path.exists(),
                'sha256': hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None},
            '_save_generation_journal': lambda *args: None})
        journal = {}
        records = self.call('prepare_generation_installation', journal, self.root/'journal.json',
                            posts, target, '2026-09-30', staged_assets=paths)
        self.assertEqual(len(records), 9)
        self.assertEqual(len(captured), 9)
        self.assertTrue(all(not record['delete'] and record['expectedSha256'] for record in records))
        self.assertTrue(any('/tag-catalog-history/' in record['path'] for record in records))
        self.assertFalse(any('/taxonomy-snapshots/' in record['path'] for record in records))
        self.call('resume_generation_installation', journal, self.root/'journal.json', posts)
        self.assertTrue(all(record['installed'] for record in records))
        self.assertEqual(json.loads((self.repo/'data/tag-catalog-snapshot.json').read_text()), self.current)
        before = {record['path']: (self.repo / record['path']).read_bytes() for record in records}
        self.call('resume_generation_installation', journal, self.root/'journal.json', posts)
        self.assertEqual({record['path']: (self.repo / record['path']).read_bytes() for record in records}, before)

    def test_review_covers_all_bytes_and_detects_tampering(self):
        paths = self.call('export_tag_catalog_files', self.repo)
        manifest = {'files': [{'path': path.relative_to(self.repo).as_posix(), 'deleted': False,
                              'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in paths]}
        self.env['_load_json_object'] = lambda *args: manifest
        results = {}
        self.assertEqual(self.call('review_tag_catalog_files', '2026-09-30',
                                  paths, self.root/'manifest.json', results), 0)
        self.assertEqual(len(results), 6)
        paths[0].write_bytes(b'{}\n')
        self.assertGreater(self.call('review_tag_catalog_files', '2026-09-30',
                                    paths, self.root/'manifest.json', {}), 0)

    def test_staging_io_failure_leaves_blog_unchanged(self):
        self.seed()
        before = (self.repo/'data/taxonomy-registry.json').read_bytes()
        calls = []
        def failing(path, raw):
            calls.append(path)
            if len(calls) == 2:
                raise OSError('fixture staging failure')
            self.write(path, raw)
        self.env['_atomic_write_bytes'] = failing
        with self.assertRaises(OSError):
            self.call('prepare_tag_catalog_staged_files', self.stage, self.repo)
        self.assertEqual((self.repo/'data/taxonomy-registry.json').read_bytes(), before)
        self.assertFalse((self.repo/'data/taxonomy-catalog.json').exists())

    def test_prior_receipt_permits_only_exact_valid_tag_selection_owned_bytes(self):
        paths = self.call('export_tag_catalog_files', self.repo)
        target = paths[0]
        relative = target.relative_to(self.repo).as_posix()
        self.env['_git_relative_manifest'] = lambda paths: [relative]
        self.env['_run_git'] = lambda *args, **kw: SimpleNamespace(stdout=(f' M {relative}\0').encode())
        self.env['_sha256_file'] = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
        allowance = {relative: {'sha256': self.env['_sha256_file'](target), 'controlledTagFiles': True}}
        self.call('validate_manifest_clean_against_head', [target], allowance)
        target.write_text('{}')
        with self.assertRaises(self.error):
            self.call('validate_manifest_clean_against_head', [target], allowance)
        allowance[relative]['sha256'] = self.env['_sha256_file'](target)
        with self.assertRaises(self.error):
            self.call('validate_manifest_clean_against_head', [target], allowance)
        # 新目录也必须核归档文件名中的来源 SHA，不能只因记录字节匹配便放行。
        archive = next(path for path in paths if path.parent.name == 'tag-catalog-history')
        archive_relative = archive.relative_to(self.repo).as_posix()
        self.env['_git_relative_manifest'] = lambda paths: [archive_relative]
        self.env['_run_git'] = lambda *args, **kw: SimpleNamespace(stdout=(f' M {archive_relative}\0').encode())
        archive_allowance = {archive_relative: {'sha256': self.env['_sha256_file'](archive),
                                              'controlledTagFiles': True}}
        self.call('validate_manifest_clean_against_head', [archive], archive_allowance)
        wrong_source = json.loads(archive.read_bytes())
        wrong_source['registrySha256'] = 'c'*64
        archive.write_bytes(self.call('tag_catalog_snapshot_bytes', wrong_source))
        archive_allowance[archive_relative]['sha256'] = self.env['_sha256_file'](archive)
        with self.assertRaises(self.error):
            self.call('validate_manifest_clean_against_head', [archive], archive_allowance)

    def test_source_integration_never_exports_before_generation_journal(self):
        tree = ast.parse(SOURCE.read_text())
        main = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'generate_main')
        calls = [node for node in ast.walk(main) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)]
        names = {node.func.id for node in calls}
        self.assertNotIn('export_tag_catalog_files', names)
        self.assertIn('prepare_tag_catalog_staged_files', names)
        prep = next(node.lineno for node in calls if node.func.id == 'prepare_generation_journal')
        stage = next(node.lineno for node in calls if node.func.id == 'prepare_tag_catalog_staged_files')
        self.assertLess(prep, stage)

    def test_interrupted_mirror_install_recovers_only_journal_staging_bytes(self):
        self.seed()
        self.call('export_tag_catalog_files', self.repo)
        # 先准备第三个版本，这样替换一次之后 data/static 里的词表
        # 会短暂不一致，而原来那个完整阶段仍然完好。
        self.env['_PAGE_TAG_CATALOG']['registrySha256'] = 'c'*64
        self.env['_PAGE_TAG_CATALOG']['version'] = 'v3'
        self.env['_PAGE_TAG_CATALOG']['concepts'][0]['preferredLabel']['zh'] = '最新名字'
        paths = self.call('prepare_tag_catalog_staged_files', self.stage, self.repo)
        records = [{'path': path.relative_to(self.stage).as_posix(), 'delete': False,
                    'stagedRelativePath': path.relative_to(self.stage).as_posix(),
                    'expectedSha256': self.env['_sha256_file'](path)} for path in paths]
        self.write(self.repo/'data/tag-catalog-versions.json', (self.stage/'data/tag-catalog-versions.json').read_bytes())
        with self.assertRaisesRegex(self.error, 'data 与 static/data 中的标签词表版本目录内容不一致。'):
            self.call('tag_catalog_file_contents', self.repo)
        resumed = self.call('prepare_tag_catalog_staged_files', self.stage, self.repo,
                            installation={'files': records})
        self.assertEqual(set(resumed), set(paths))
        paths[0].write_bytes(b'{}')
        with self.assertRaises(self.error):
            self.call('prepare_tag_catalog_staged_files', self.stage, self.repo,
                      installation={'files': records})


    def test_new_display_does_not_replace_issued_snapshot_and_partial_new_files_reject(self):
        self.seed()
        original = (self.repo / 'data/taxonomy-registry.json').read_bytes()
        assets = self.call('tag_catalog_file_contents', self.repo)
        catalog = json.loads(assets['data/tag-catalog-versions.json'])
        self.assertEqual(catalog['contract'], 'paper-tag-catalog-versions-v2')
        self.assertEqual(catalog['snapshots'][0], self.old)
        self.assertEqual(json.loads(assets['data/tag-catalog-history/'+'a'*64+'.json']), self.old)
        self.call('export_tag_catalog_files', self.repo)
        self.assertEqual((self.repo / 'data/taxonomy-registry.json').read_bytes(), original)
        (self.repo / 'static/data/tag-catalog-versions.json').unlink()
        with self.assertRaisesRegex(self.error, '新版标签显示文件缺少'):
            self.call('tag_catalog_file_contents', self.repo)

    def test_old_installation_and_review_preserve_bound_files_without_current_config(self):
        self.seed()
        assets = self.call('_legacy_tag_catalog_file_contents', self.repo, current=self.old)
        for relative, raw in assets.items():
            self.write(self.stage / relative, raw)
        records = [{'path': relative, 'delete': False, 'stagedRelativePath': relative,
                    'expectedSha256': hashlib.sha256(raw).hexdigest()} for relative, raw in assets.items()]
        before = {relative: (self.stage / relative).read_bytes() for relative in assets}
        paths = self.call('prepare_tag_catalog_staged_files', self.stage, self.repo,
                          installation={'files': records})
        self.assertEqual({p.relative_to(self.stage).as_posix() for p in paths}, set(assets))
        self.assertEqual({relative: (self.stage / relative).read_bytes() for relative in assets}, before)
        manifest = {'files': [{'path': relative, 'deleted': False,
            'sha256': hashlib.sha256(raw).hexdigest()} for relative, raw in assets.items()]}
        for relative, raw in assets.items():
            self.write(self.repo / relative, raw)
        self.env['_load_json_object'] = lambda *args: manifest
        self.assertEqual(self.call('review_tag_catalog_files', '2026-09-30',
            [self.repo / relative for relative in assets], self.root/'manifest.json', {}), 0)
        self.env['TAG_DISPLAY_POLICY_PATH'].write_text('{}')
        self.assertEqual(self.call('prepare_tag_catalog_staged_files', self.stage, self.repo,
            installation={'files': records}), paths)

    def test_原实现生成的两类资产按原路径和字节恢复(self):
        captured_raw = (Path(__file__).resolve().parents[1] / 'fixtures' /
                        'tag-catalog-assets/original-display-bundles.json').read_bytes()
        self.assertEqual(hashlib.sha256(captured_raw).hexdigest(),
            'f48509ba85134a307d97daa45d89955e66f70ac2214ef96ab2ac092238e6651e')
        captured = json.loads(captured_raw)
        self.assertEqual(captured['producerSourceSha256'],
            '2185883ec8684445dfbb9883680c296ff4b92ff775f31b7077b53ebc068fcadc')
        self.assertEqual(captured['producerCommit'], 'a8c9e258157d770391d67dbeae9071900acfbbe1')
        default_formatter = self.env['tag_catalog_file_contents']
        def forbidden_default(*args, **kwargs):
            self.fail('恢复原资产不得调用当前默认生成器')
        for family, bundle in captured['bundles'].items():
            with self.subTest(family=family):
                self.repo = self.root / family / 'blog'
                self.stage = self.root / family / 'stage'
                self.repo.mkdir(parents=True)
                self.stage.mkdir()
                self.env['BLOG_REPO'] = str(self.repo)
                raw_files = {}
                for relative, asset in bundle['assets'].items():
                    raw = base64.b64decode(asset['rawBase64'], validate=True)
                    self.assertEqual(len(raw), asset['bytes'])
                    self.assertEqual(hashlib.sha256(raw).hexdigest(), asset['sha256'])
                    raw_files[relative] = raw
                    self.write(self.stage / relative, raw)
                    self.write(self.repo / relative, raw)
                self.write(self.stage / 'posts/2026-09-30-example.md', b'a page')
                self.write(self.repo / 'content/posts/2026-09-30-example.md', b'a page')
                original_installation = copy.deepcopy(bundle['installation'])
                manifest = copy.deepcopy(bundle['manifest'])
                self.env.update({'tag_catalog_file_contents': forbidden_default,
                    '_load_json_object': lambda *args: manifest,
                    '_file_fingerprint': lambda path: {'deleted': not path.exists(),
                        'sha256': hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None},
                    '_save_generation_journal': lambda *args: None})
                try:
                    paths = self.call('prepare_tag_catalog_staged_files', self.stage, self.repo,
                        installation=original_installation)
                    self.assertEqual([path.relative_to(self.stage).as_posix() for path in paths],
                                     bundle['recoveredPaths'])
                    self.assertEqual({relative: (self.stage / relative).read_bytes() for relative in raw_files}, raw_files)
                    journal = {'installation': copy.deepcopy(original_installation)}
                    self.call('resume_generation_installation', journal, self.root/'journal.json', self.stage/'posts')
                    self.assertEqual(journal['installation'], original_installation)
                    results = {}
                    self.assertEqual(self.call('review_tag_catalog_files', '2026-09-30',
                        [self.repo / relative for relative in raw_files], self.root/'manifest.json', results), 0)
                    self.assertEqual({Path(path).relative_to(self.repo).as_posix(): value for path, value in results.items()},
                                     bundle['reviewResults'])
                    self.assertEqual({relative: (self.repo / relative).read_bytes() for relative in raw_files}, raw_files)
                    self.assertFalse((self.repo / 'data/tag-catalog-history').exists())
                    self.assertEqual(original_installation, bundle['installation'])
                    self.assertEqual(manifest, bundle['manifest'])
                finally:
                    self.env['tag_catalog_file_contents'] = default_formatter

    def test_坏的新归档或缺失副本不能回退到旧目录(self):
        self.seed()
        for prefix in ('data', 'static/data'):
            self.put(f'{prefix}/taxonomy-snapshots/'+ 'a'*64 + '.json', self.old)
        for defect in ('invalid-json', 'missing-mirror', 'different-mirror-bytes',
                       'conflicting-object', 'wrong-filename'):
            with self.subTest(defect=defect):
                current_root = self.repo / 'data/tag-catalog-history'
                mirror_root = self.repo / 'static/data/tag-catalog-history'
                for directory in (current_root, mirror_root):
                    directory.mkdir(parents=True, exist_ok=True)
                    for path in directory.iterdir():
                        path.unlink()
                raw = self.call('tag_catalog_snapshot_bytes', self.old)
                if defect == 'invalid-json':
                    raw = b'{not-json}'
                elif defect == 'conflicting-object':
                    changed = copy.deepcopy(self.old)
                    changed['concepts'][0]['zh'] = '不同名称'
                    raw = self.call('tag_catalog_snapshot_bytes', changed)
                filename = ('c' if defect == 'wrong-filename' else 'a') * 64 + '.json'
                self.write(current_root / filename, raw)
                if defect != 'missing-mirror':
                    mirror_raw = ((json.dumps(self.old, ensure_ascii=False, indent=2) + '\n').encode()
                                  if defect == 'different-mirror-bytes' else raw)
                    self.write(mirror_root / filename, mirror_raw)
                with self.assertRaises(self.error):
                    self.call('prepare_tag_catalog_staged_files', self.stage, self.repo)
                self.assertEqual(list(self.stage.iterdir()), [])
                self.assertEqual((self.repo/'data/taxonomy-snapshots'/('a'*64+'.json')).read_bytes(),
                                 self.call('tag_catalog_snapshot_bytes', self.old))

    def test_暂存资产先核原字节再拒绝混合归档目录(self):
        self.seed()
        assets = self.call('tag_catalog_file_contents', self.repo)
        for relative, raw in assets.items():
            self.write(self.stage / relative, raw)
        records = [{'path': relative, 'delete': False, 'stagedRelativePath': relative,
                    'expectedSha256': hashlib.sha256(raw).hexdigest()} for relative, raw in assets.items()]
        original = copy.deepcopy(records)
        record = next(item for item in records if '/tag-catalog-history/' in item['path'])
        old_relative = record['path'].replace('/tag-catalog-history/', '/taxonomy-snapshots/')
        source = self.stage / record['path']
        target = self.stage / old_relative
        self.write(target, source.read_bytes())
        source.unlink()
        record.update(path=old_relative, stagedRelativePath=old_relative)
        target.write_bytes(b'{not-json}')
        with self.assertRaisesRegex(self.error, '字节或 SHA 与原记录不一致'):
            self.call('prepare_tag_catalog_staged_files', self.stage, self.repo,
                      installation={'files': records})
        target.write_bytes(assets[original[records.index(record)]['path']])
        with self.assertRaisesRegex(self.error, '原标签词表文件集合缺少归档目录，或混用了不兼容的归档目录。'):
            self.call('prepare_tag_catalog_staged_files', self.stage, self.repo,
                      installation={'files': records})

    def test_旧非选用归档保持原来的对象比较范围(self):
        raw = (Path(__file__).resolve().parents[1] / 'fixtures' /
               'tag-catalog-assets/original-display-bundles.json').read_bytes()
        bundle = json.loads(raw)['bundles']['current-display-old-archive']
        records = copy.deepcopy(bundle['installation']['files'])
        for relative, asset in bundle['assets'].items():
            self.write(self.stage / relative, base64.b64decode(asset['rawBase64']))
        # 原读取器不要求没有展示策略约束的历史归档使用相同 JSON 排版。
        relative = 'data/taxonomy-snapshots/' + 'a'*64 + '.json'
        reformatted = (json.dumps(self.old, ensure_ascii=False, indent=2) + '\n').encode()
        self.write(self.stage / relative, reformatted)
        next(item for item in records if item['path'] == relative)['expectedSha256'] = hashlib.sha256(reformatted).hexdigest()
        paths = self.call('prepare_tag_catalog_staged_files', self.stage, self.repo,
                          installation={'files': records})
        self.assertEqual(len(paths), 8)
        self.assertEqual((self.stage / relative).read_bytes(), reformatted)
        self.assertNotEqual(reformatted, (self.stage / ('static/' + relative)).read_bytes())

if __name__ == '__main__':
    unittest.main()
