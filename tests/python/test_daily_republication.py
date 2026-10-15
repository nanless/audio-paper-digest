import copy
import contextlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_env_isolation import isolate_module_environment
from test_daily_fresh_publish_gate import _daily_payload, publish_to_blog as M
import daily_republication as R

setUpModule, tearDownModule = isolate_module_environment()
DATE = '2026-09-07'
RUN = '22222222-2222-4222-8222-222222222222'
H = R.sha

class DailyRepublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.repo = self.root / 'blog'; self.repo.mkdir()
        self.current = self.root / 'current'; self.current.mkdir()
        self.runs = self.root / 'transactions'
        self.git('init', '-b', 'main')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'user.name', 'Fixture')
        remote = self.root / 'remote.git'
        subprocess.run(['git', 'init', '--bare', str(remote)], capture_output=True, check=True)
        self.git('remote', 'add', 'origin', str(remote))
        self.stack = contextlib.ExitStack(); self.addCleanup(self.stack.close)
        for name, value in [('BLOG_REPO', str(self.repo)), ('CURRENT_DIR', self.current),
                            ('DAILY_FRESH_SOURCE_RUNS_DIR', self.root / 'sources')]:
            self.stack.enter_context(mock.patch.object(M, name, value))
        self.stack.enter_context(mock.patch.object(R, 'DAILY_REPUBLICATION_RUNS_DIR', self.runs))
        # 该隔离站点只有当前词表，没有真实站点的历史发布策略；生产预检另用真实双份策略。
        self.stack.enter_context(mock.patch.object(M, '_read_approved_tag_display_policy', return_value=None))
        for name, raw in M.tag_catalog_file_contents(self.repo).items():
            path = self.repo / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(raw)
        self.write_blog('content/posts/unrelated.md', b'original unrelated bytes')
        self.git('add', '.'); self.git('commit', '-m', 'baseline fixture')
        base = self.git('rev-parse', 'HEAD').strip()
        payload = _daily_payload(self.root / 'sources', ['2609.12341'])
        self.formal = self.current / 'deep-analysis-result.json'
        self.formal.write_bytes(R.encoded(payload))
        records = []
        for name, raw in [(f'content/posts/{DATE}.md', b'---\ntitle: fixture\n---\nReviewed fixture body\n'),
                          ('static/images/papers/2609.12341/figure-1-0123456789abcdef.png', b'original pixel fixture')]:
            self.write_blog(name, raw); records.append({'path': name, 'deleted': False, 'sha256': H(raw)})
        for prefix in ('data', 'static/data'):
            name = prefix + '/tag-catalog-versions.json'
            records.append({'path': name, 'deleted': False, 'sha256': H((self.repo / name).read_bytes())})
        self.git('add', '.'); self.git('commit', '-m', 'reviewed publication fixture')
        commit = self.git('rev-parse', 'HEAD').strip()
        self.git('push', 'origin', 'HEAD:main')
        reference = M.build_generation_input_source_reference(str(self.formal))
        manifest = {'schemaVersion': 3, 'date': DATE, 'baseHead': base, 'files': records,
                    'category': '论文速递', 'publishAll': False, 'publishedPapers': payload['papers'],
                    'inputSourceReference': reference,
                    'publishedPapersFingerprintContract': M.PUBLISHED_PAPERS_FINGERPRINT_CONTRACT,
                    'publishedPapersFingerprint': M.published_papers_fingerprint(payload['papers'])}
        manifest['inputFingerprint'] = M.generation_input_fingerprint(payload['papers'], DATE, '论文速递', False,
                                                                    input_source_reference=reference)
        manifest_raw = R.encoded(manifest)
        identity, error = M._remote_identity_sha256(); self.assertFalse(error)
        receipt = {'schemaVersion': 3, 'date': DATE, 'baseHead': base, 'files': copy.deepcopy(records),
                   'publicationCommit': commit, 'remoteVerifiedOid': commit,
                   'remoteVerifiedAt': '2026-09-07T12:00:00+08:00', 'remoteName': 'origin',
                   'remoteIdentitySha256': identity, 'strictReview': True, 'hugoGate': 'hugo',
                   'reviewProtocolFingerprint': 'a' * 64, 'generationManifestSha256': H(manifest_raw),
                   'generationInputIntegrity': M.PUBLISHED_PAPERS_FINGERPRINT_CONTRACT,
                   'generationInputFingerprint': manifest['inputFingerprint'],
                   'publishedPapersFingerprint': manifest['publishedPapersFingerprint'],
                   'generationInputSourceReference': reference}
        self.manifest_path = self.current / f'blog-generation-manifest-{DATE}.json'
        self.receipt_path = self.current / f'blog-review-receipt-{DATE}.json'
        self.manifest_path.write_bytes(manifest_raw); self.receipt_path.write_bytes(R.encoded(receipt))
        self.pass_path = self.current / f'blog-review-passes-{DATE}.json'; self.pass_path.write_bytes(b'{"originalPass":true}')
        self.checkpoint = self.current / 'blog-review-checkpoints' / DATE / 'units' / 'saved.json'
        self.checkpoint.parent.mkdir(parents=True); self.checkpoint.write_bytes(b'{"paidResponse":"original"}')
        self.write_blog('content/posts/unrelated.md', b'unrelated human modifications remain')
        self.original = {p.relative_to(self.current).as_posix(): p.read_bytes()
                         for p in self.current.rglob('*') if p.is_file()}

    def git(self, *args):
        result = subprocess.run(['git', '-C', str(self.repo), *args], capture_output=True, text=True, check=True)
        return result.stdout

    def write_blog(self, name, raw):
        path = self.repo / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(raw)

    def activate(self, after_step=lambda _step: None):
        return R.activate(M, DATE, RUN, 'b' * 64, 'c' * 64, after_step=after_step)

    def test_real_remote_sources_and_unrelated_dirty_are_preserved(self):
        result = self.activate(); self.assertEqual(result['status'], 'activated')
        R.assert_no_pending(self.current, DATE)
        self.assertFalse(self.manifest_path.exists()); self.assertFalse(self.receipt_path.exists())
        self.assertEqual(self.pass_path.read_bytes(), self.original[self.pass_path.name])
        self.assertEqual(self.checkpoint.read_bytes(), b'{"paidResponse":"original"}')
        self.assertEqual((self.repo / 'content/posts/unrelated.md').read_bytes(), b'unrelated human modifications remain')
        intent = R.load_json(self.runs / RUN / 'intent.json')
        for record in intent['files']:
            saved = self.runs / RUN / 'archive' / record['path']
            self.assertEqual(saved.read_bytes(), self.original[record['path']])
            self.assertEqual(saved.stat().st_mode & 0o777, 0o600)
        self.manifest_path.write_bytes(b'new generation must survive')
        self.activate()
        self.assertEqual(self.manifest_path.read_bytes(), b'new generation must survive')
        self.assertEqual(self.formal.read_bytes(), self.original[self.formal.name])

    def test_recovery_after_each_immutable_and_retirement_window(self):
        # Every checkpoint runs against a real isolated Git remote and sealed four-source fixture.
        steps = ['intent', 'pending'] + ['archive:' + name for name in sorted([
            self.manifest_path.name, self.receipt_path.name, self.pass_path.name,
            self.checkpoint.relative_to(self.current).as_posix()])] + [
            'retire:' + self.manifest_path.name, 'retire:' + self.receipt_path.name, 'completion']
        for step in steps:
            with self.subTest(step=step):
                # Restore fixture state only inside this unit test's private directory.
                for name, raw in self.original.items():
                    path = self.current / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(raw)
                import shutil
                shutil.rmtree(self.runs, ignore_errors=True)
                shutil.rmtree(self.current / R.DAILY_REPUBLICATION_MARKER_DIRNAME, ignore_errors=True)
                def crash(actual):
                    if actual == step: raise RuntimeError('injected crash')
                with self.assertRaisesRegex(RuntimeError, 'injected crash'):
                    self.activate(crash)
                if step != 'intent':
                    with self.assertRaises(ValueError): R.assert_no_pending(self.current, DATE)
                    R.assert_no_pending(self.current, DATE, allow_run_id=RUN)
                if step == 'completion': self.manifest_path.write_bytes(b'new generation stays intact')
                self.activate(); R.assert_no_pending(self.current, DATE)
                if step == 'completion': self.assertEqual(self.manifest_path.read_bytes(), b'new generation stays intact')

    def test_page_and_asset_head_or_worktree_drift_fail_before_retirement(self):
        for name in [f'content/posts/{DATE}.md', 'static/images/papers/2609.12341/figure-1-0123456789abcdef.png']:
            with self.subTest(path=name):
                path = self.repo / name; before = path.read_bytes(); path.write_bytes(b'changed')
                with self.assertRaisesRegex(ValueError, '漂移'): self.activate()
                self.assertEqual(self.manifest_path.read_bytes(), self.original[self.manifest_path.name])
                path.write_bytes(before)
        self.write_blog(f'content/posts/{DATE}.md', b'committed changed page')
        self.git('add', f'content/posts/{DATE}.md'); self.git('commit', '-m', 'fixture changed reviewed page'); self.git('push', 'origin', 'HEAD:main')
        with self.assertRaisesRegex(ValueError, '漂移'): self.activate()

    def test_missing_tampered_sealed_sources_and_partial_collection_refuse(self):
        source = next((self.root / 'sources').rglob('source.pdf'))
        raw = source.read_bytes(); source.write_bytes(raw + b'tampered')
        with self.assertRaises(Exception): self.activate()
        self.assertTrue(self.manifest_path.exists()); self.assertFalse(R.marker_path(self.current, DATE).exists())
        source.write_bytes(raw); source.unlink()
        with self.assertRaises(Exception): self.activate()
        self.assertTrue(self.receipt_path.exists())

    def test_corrupt_receipt_staged_index_and_unsynced_remote_refuse(self):
        before = self.receipt_path.read_bytes(); self.receipt_path.write_bytes(b'{broken')
        with self.assertRaises(ValueError): self.activate()
        self.receipt_path.write_bytes(before)
        self.git('add', 'content/posts/unrelated.md')
        with self.assertRaisesRegex(ValueError, '暂存区'): self.activate()
        self.git('restore', '--staged', 'content/posts/unrelated.md')
        self.git('commit', '--allow-empty', '-m', 'local not pushed')
        with self.assertRaisesRegex(ValueError, '实际远端'): self.activate()

    def test_pending_cas_catalog_identity_and_archive_corruption_refuse(self):
        def crash(step):
            if step == 'pending': raise RuntimeError('injected')
        with self.assertRaises(RuntimeError): self.activate(crash)
        self.manifest_path.write_bytes(self.manifest_path.read_bytes() + b' ')
        with self.assertRaisesRegex(ValueError, '归档前'): self.activate()
        self.manifest_path.write_bytes(self.original[self.manifest_path.name])
        self.activate()
        (self.runs / RUN / 'archive' / self.receipt_path.name).write_bytes(b'tampered evidence')
        with self.assertRaisesRegex(ValueError, '原凭证归档'): self.activate()
        with self.assertRaises(ValueError): R.assert_no_pending(self.current, DATE)

    def test_cli_requires_canonical_whole_batch_and_unique_uuid(self):
        valid = M.parse_generation_args(['--date', DATE, '--republish', RUN])
        self.assertEqual(valid['republish_id'], RUN)
        for argv in [
            ['--republish', RUN], ['--date', DATE, '--republish', 'INVALID'],
            ['--date', DATE, '--republish', RUN, '--republish', RUN],
            ['--date', DATE, '--republish', RUN, '--all'],
            ['--date', DATE, '--republish', RUN, '--include-id', '2609.12341'],
            ['--date', DATE, '--republish', RUN, '--exclude-id', '2609.12341'],
            ['--date', DATE, '--republish', RUN, '--legacy-v5-maintenance'],
            ['source.json', '--date', DATE, '--republish', RUN],
        ]:
            with self.subTest(argv=argv), contextlib.redirect_stderr(__import__('io').StringIO()):
                with self.assertRaises(SystemExit): M.parse_generation_args(argv)

    def test_every_original_receipt_binding_and_verified_time_is_replayed(self):
        before = self.receipt_path.read_bytes()
        for key in ['generationInputIntegrity', 'generationInputFingerprint',
                    'publishedPapersFingerprint', 'generationInputSourceReference',
                    'publicationMode', 'llmApiProductionFingerprint',
                    'manualV6ProductionFingerprint', 'remoteVerifiedAt']:
            with self.subTest(field=key):
                value = json.loads(before); value[key] = 'tampered binding'
                self.receipt_path.write_bytes(R.encoded(value))
                with self.assertRaises(ValueError): self.activate()
                self.assertTrue(self.manifest_path.exists())
                self.assertFalse(R.marker_path(self.current, DATE).exists())
        self.receipt_path.write_bytes(before)

    def test_current_complete_paper_set_cannot_be_replaced_by_resealed_partial_duplicate_or_extra(self):
        oldmanifest = self.manifest_path.read_bytes(); oldreceipt = self.receipt_path.read_bytes()
        original = json.loads(oldmanifest)
        variants = [[], original['publishedPapers'] * 2]
        extra = copy.deepcopy(original['publishedPapers']); extra.append(copy.deepcopy(extra[0])); extra[-1]['arxivId'] = '2609.54321'
        variants.append(extra)
        for papers in variants:
            with self.subTest(count=len(papers)):
                manifest = copy.deepcopy(original); manifest['publishedPapers'] = papers
                manifest['publishedPapersFingerprint'] = M.published_papers_fingerprint(papers) if papers else 'f' * 64
                manifest['inputFingerprint'] = M.generation_input_fingerprint(papers, DATE, '论文速递', False,
                    input_source_reference=manifest['inputSourceReference'])
                raw = R.encoded(manifest); self.manifest_path.write_bytes(raw)
                receipt = json.loads(oldreceipt); receipt.update(generationManifestSha256=H(raw),
                    generationInputFingerprint=manifest['inputFingerprint'],
                    publishedPapersFingerprint=manifest['publishedPapersFingerprint'])
                self.receipt_path.write_bytes(R.encoded(receipt))
                with self.assertRaises(ValueError): self.activate()
                self.assertFalse(R.marker_path(self.current, DATE).exists())

    def install_catalog_maintenance(self):
        from tag_catalog import load_tag_catalog
        project = Path(__file__).resolve().parents[2]
        oldsha = '0a0847314ab2059d95efac33376414498e598a1f02a1486869bee0efc481d1f7'
        older = load_tag_catalog(project / 'config/tag-catalog-history' / (oldsha + '.json'))
        raw = M.tag_catalog_snapshot_bytes(M.build_tag_catalog_snapshot(older))
        paths = []
        for prefix in ('data', 'static/data'):
            name = prefix + '/tag-catalog-history/' + oldsha + '.json'; self.write_blog(name, raw); paths.append(name)
        for name, data in M.tag_catalog_file_contents(self.repo).items(): self.write_blog(name, data)
        paths += ['data/tag-catalog-versions.json', 'static/data/tag-catalog-versions.json']
        self.git('add', '--', *paths); self.git('commit', '-m', 'controlled valid catalog maintenance fixture'); self.git('push', 'origin', 'HEAD:main')
        return paths

    def test_catalog_maintenance_accepts_only_controlled_paired_committed_current_bytes(self):
        paths = self.install_catalog_maintenance()
        self.activate()
        intent = R.load_json(self.runs / RUN / 'intent.json')
        self.assertEqual({x['path'] for x in intent['catalogMaintenance']}, set(paths[-2:]))
        self.assertEqual((self.repo / 'content/posts/unrelated.md').read_bytes(), b'unrelated human modifications remain')

    def test_cas_covers_all_validated_catalog_archives_and_canonical_source(self):
        paths = self.install_catalog_maintenance()
        def crash(step):
            if step == 'pending': raise RuntimeError('injected crash')
        with self.assertRaises(RuntimeError): self.activate(crash)
        with self.assertRaises(ValueError): R.assert_no_pending(self.current, DATE)
        with self.assertRaises(M.PublishDataValidationError):
            with M.blog_publication_lock(DATE): pass
        with M.blog_publication_lock(DATE, republish_id=RUN): pass
        # 此历史归档不在原receipt，也不在availability的当前词表六文件中。
        target = self.repo / paths[0]; before = target.read_bytes(); target.write_bytes(before + b' ')
        with self.assertRaisesRegex(ValueError, 'CAS 变化'): self.activate()
        self.assertTrue(self.manifest_path.exists())
        target.write_bytes(before)
        self.formal.write_bytes(self.formal.read_bytes() + b' ')
        with self.assertRaisesRegex(ValueError, '正式分析 CAS'): self.activate()
        self.assertTrue(self.receipt_path.exists())

    def test_unpaired_or_noncanonical_catalog_changes_are_not_maintenance_exceptions(self):
        targets = [self.repo / prefix / 'tag-catalog-versions.json' for prefix in ('data', 'static/data')]
        before = targets[0].read_bytes()
        targets[0].write_bytes(before + b' ')
        self.git('add', str(targets[0])); self.git('commit', '-m', 'unpaired invalid catalog fixture'); self.git('push', 'origin', 'HEAD:main')
        with self.assertRaises(ValueError): self.activate()
        targets[1].write_bytes(before + b' ')
        self.git('add', str(targets[1])); self.git('commit', '-m', 'paired noncanonical invalid catalog fixture'); self.git('push', 'origin', 'HEAD:main')
        with self.assertRaises(ValueError): self.activate()
        self.assertTrue(self.receipt_path.exists())

if __name__ == '__main__': unittest.main()
