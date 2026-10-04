"""Isolated AST fixtures: no .env, API, daily writes or imported publisher main."""
import ast
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
NAMES = {'_validate_taxonomy_presentation_policy', '_taxonomy_historical_projection_sha256',
    '_taxonomy_presentation_selection', 'build_taxonomy_registry_snapshot', 'taxonomy_registry_snapshot_bytes',
    '_validate_taxonomy_snapshot', '_validate_taxonomy_catalog', '_taxonomy_asset_relative',
    '_read_taxonomy_asset', 'taxonomy_registry_asset_payloads',
    'prepare_taxonomy_registry_staged_assets', 'export_taxonomy_registry_snapshot',
    '_manifest_record', 'attest_taxonomy_registry_assets', 'publish_manifest_paths',
    'prepare_generation_installation', 'resume_generation_installation',
    'validate_manifest_clean_against_head'}


class TaxonomyAssetsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.repo = self.root / 'blog'
        self.repo.mkdir()
        self.stage = self.root / 'stage'
        self.stage.mkdir()
        tree = ast.parse(SOURCE.read_text())
        nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in NAMES]
        self.assertEqual({node.name for node in nodes}, NAMES)
        class ValidationError(Exception):
            pass
        self.error = ValidationError
        self.env = {'Path': Path, 'json': json, 're': re, 'hashlib': hashlib,
            'PublishDataValidationError': ValidationError, 'BLOG_REPO': str(self.repo),
            'TAXONOMY_REGISTRY_SNAPSHOT_CONTRACT': 'paper-taxonomy-registry-snapshot-v1',
            'VISUAL_SUMMARY_KINDS': set(), 'RESEARCHER_SIDECAR_FILENAMES': set()}
        self.env['_atomic_write_bytes'] = self.write
        self.env['_sha256_file'] = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
        self.env['_PAGE_TAG_CATALOG'] = {'registrySha256': 'b'*64, 'version': 'v2', 'concepts': [
            {'id': 'task.child', 'facet': 'task', 'preferredLabel': {'zh': '新名字', 'en': 'new'},
             'aliases': [], 'broaderId': None, 'status': 'active',
             'definition': '原登记定义', 'scopeNote': '原登记排除说明'}]}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SOURCE), 'exec'), self.env)
        self.current = self.call('build_taxonomy_registry_snapshot')
        self.old = json.loads(json.dumps(self.current))
        self.old.update(registrySha256='a'*64, registryVersion='v1')
        self.old['concepts'][0]['zh'] = '旧名字'
        self.old['concepts'][0]['definition'] = '旧定义'

    def call(self, name, *args, **kwargs):
        return self.env[name](*args, **kwargs)

    @staticmethod
    def write(path, raw):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)

    def put(self, relative, data):
        self.write(self.repo / relative, self.call('taxonomy_registry_snapshot_bytes', data))

    def seed(self):
        for prefix in ('data', 'static/data'):
            self.put(f'{prefix}/taxonomy-registry.json', self.old)

    def test_canonical_export_preserves_old_snapshot_and_current_definitions(self):
        self.seed()
        paths = self.call('export_taxonomy_registry_snapshot', self.repo)
        self.assertEqual(len(paths), 8)
        catalog = json.loads((self.repo/'data/taxonomy-catalog.json').read_text())
        self.assertEqual(catalog['currentSha256'], 'b'*64)
        self.assertEqual(catalog['snapshots'], [self.old, self.current])
        self.assertEqual(self.call('export_taxonomy_registry_snapshot', self.repo), [])
        self.assertEqual((self.repo/'data/taxonomy-snapshots'/('a'*64+'.json')).read_bytes(),
                         (self.repo/'static/data/taxonomy-snapshots'/('a'*64+'.json')).read_bytes())

    def test_staging_never_installs_blog_assets(self):
        self.seed()
        before = (self.repo/'data/taxonomy-registry.json').read_bytes()
        paths = self.call('prepare_taxonomy_registry_staged_assets', self.stage, self.repo)
        self.assertEqual(len(paths), 8)
        self.assertEqual((self.repo/'data/taxonomy-registry.json').read_bytes(), before)
        self.assertFalse((self.repo/'data/taxonomy-catalog.json').exists())

    def test_invalid_archive_fails_before_any_write(self):
        self.seed()
        self.put('data/taxonomy-snapshots/'+'c'*64+'.json', self.old)
        with self.assertRaisesRegex(self.error, '文件名 SHA'):
            self.call('prepare_taxonomy_registry_staged_assets', self.stage, self.repo)
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_immutable_sha_collision_and_catalog_drift_are_rejected(self):
        self.seed()
        changed = json.loads(json.dumps(self.old))
        changed['concepts'][0]['ancestorIds'] = ['task.absent']
        self.put('data/taxonomy-snapshots/'+'a'*64+'.json', changed)
        with self.assertRaisesRegex(self.error, 'chain'):
            self.call('taxonomy_registry_asset_payloads', self.repo)
        changed['concepts'][0]['ancestorIds'] = []
        changed['concepts'][0]['zh'] = '冒名'
        self.put('data/taxonomy-snapshots/'+'a'*64+'.json', changed)
        with self.assertRaisesRegex(self.error, '内容冲突'):
            self.call('taxonomy_registry_asset_payloads', self.repo)

    def test_symlink_and_uncontrolled_paths_rejected(self):
        (self.repo/'data').symlink_to(self.stage, target_is_directory=True)
        with self.assertRaisesRegex(self.error, '逃逸'):
            self.call('taxonomy_registry_asset_payloads', self.repo)
        for relative in ('data/unrelated.json', 'static/data/taxonomy-snapshots/no.json',
                         'data/../taxonomy-registry.json', 'data\\taxonomy-registry.json'):
            self.assertFalse(self.call('_taxonomy_asset_relative', relative))
        self.assertTrue(self.call('_taxonomy_asset_relative', 'data/taxonomy-registry.json'))

    def test_single_page_cannot_upgrade_global_registry(self):
        self.seed()
        with self.assertRaisesRegex(self.error, '单篇发布不得'):
            self.call('prepare_taxonomy_registry_staged_assets', self.stage, self.repo, single_page=True)
        self.call('export_taxonomy_registry_snapshot', self.repo)
        self.assertEqual(self.call('prepare_taxonomy_registry_staged_assets', self.stage,
                                  self.repo, single_page=True), [])

    def test_taxonomy_assets_are_precise_manifest_members_and_journalled(self):
        self.seed()
        paths = self.call('prepare_taxonomy_registry_staged_assets', self.stage, self.repo)
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
        self.call('resume_generation_installation', journal, self.root/'journal.json', posts)
        self.assertTrue(all(record['installed'] for record in records))
        self.assertEqual(json.loads((self.repo/'data/taxonomy-registry.json').read_text()), self.current)

    def test_review_covers_all_bytes_and_detects_tampering(self):
        paths = self.call('export_taxonomy_registry_snapshot', self.repo)
        manifest = {'files': [{'path': path.relative_to(self.repo).as_posix(), 'deleted': False,
                              'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in paths]}
        self.env['_load_json_object'] = lambda *args: manifest
        results = {}
        self.assertEqual(self.call('attest_taxonomy_registry_assets', '2026-09-30',
                                  paths, self.root/'manifest.json', results), 0)
        self.assertEqual(len(results), 6)
        paths[0].write_bytes(b'{}\n')
        self.assertGreater(self.call('attest_taxonomy_registry_assets', '2026-09-30',
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
            self.call('prepare_taxonomy_registry_staged_assets', self.stage, self.repo)
        self.assertEqual((self.repo/'data/taxonomy-registry.json').read_bytes(), before)
        self.assertFalse((self.repo/'data/taxonomy-catalog.json').exists())

    def test_prior_receipt_permits_only_exact_valid_taxonomy_owned_bytes(self):
        paths = self.call('export_taxonomy_registry_snapshot', self.repo)
        target = paths[0]
        relative = target.relative_to(self.repo).as_posix()
        self.env['_git_relative_manifest'] = lambda paths: [relative]
        self.env['_run_git'] = lambda *args, **kw: SimpleNamespace(stdout=(f' M {relative}\0').encode())
        self.env['_sha256_file'] = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
        allowance = {relative: {'sha256': self.env['_sha256_file'](target), 'controlledTaxonomy': True}}
        self.call('validate_manifest_clean_against_head', [target], allowance)
        target.write_text('{}')
        with self.assertRaises(self.error):
            self.call('validate_manifest_clean_against_head', [target], allowance)
        allowance[relative]['sha256'] = self.env['_sha256_file'](target)
        with self.assertRaises(self.error):
            self.call('validate_manifest_clean_against_head', [target], allowance)

    def test_source_integration_never_exports_before_generation_journal(self):
        tree = ast.parse(SOURCE.read_text())
        main = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'generate_main')
        calls = [node for node in ast.walk(main) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)]
        names = {node.func.id for node in calls}
        self.assertNotIn('export_taxonomy_registry_snapshot', names)
        self.assertIn('prepare_taxonomy_registry_staged_assets', names)
        prep = next(node.lineno for node in calls if node.func.id == 'prepare_generation_journal')
        stage = next(node.lineno for node in calls if node.func.id == 'prepare_taxonomy_registry_staged_assets')
        self.assertLess(prep, stage)

    def test_interrupted_mirror_install_recovers_only_journal_staging_bytes(self):
        self.seed()
        self.call('export_taxonomy_registry_snapshot', self.repo)
        # Prepare a third version so one replacement leaves data/static catalog
        # temporarily different, while the original complete stage remains intact.
        self.env['_PAGE_TAG_CATALOG']['registrySha256'] = 'c'*64
        self.env['_PAGE_TAG_CATALOG']['version'] = 'v3'
        self.env['_PAGE_TAG_CATALOG']['concepts'][0]['preferredLabel']['zh'] = '最新名字'
        paths = self.call('prepare_taxonomy_registry_staged_assets', self.stage, self.repo)
        records = [{'path': path.relative_to(self.stage).as_posix(), 'delete': False,
                    'stagedRelativePath': path.relative_to(self.stage).as_posix(),
                    'expectedSha256': self.env['_sha256_file'](path)} for path in paths]
        self.write(self.repo/'data/taxonomy-catalog.json', (self.stage/'data/taxonomy-catalog.json').read_bytes())
        with self.assertRaisesRegex(self.error, '镜像漂移'):
            self.call('taxonomy_registry_asset_payloads', self.repo)
        resumed = self.call('prepare_taxonomy_registry_staged_assets', self.stage, self.repo,
                            installation={'files': records})
        self.assertEqual(set(resumed), set(paths))
        paths[0].write_bytes(b'{}')
        with self.assertRaises(self.error):
            self.call('prepare_taxonomy_registry_staged_assets', self.stage, self.repo,
                      installation={'files': records})


if __name__ == '__main__':
    unittest.main()
