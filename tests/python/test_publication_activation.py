import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import publication_activation as activation


class ActivationTransactionTest(unittest.TestCase):
    def fixture(self, root):
        root = root.resolve()
        current = root / 'current'; current.mkdir()
        run = root / '11111111-1111-4111-8111-111111111111'; run.mkdir()
        run_raw = activation.encoded({'runId': run.name, 'date': '2026-09-04', 'status': 'promoted'})
        (run / 'run.json').write_bytes(run_raw)
        records = []
        for index in range(6):
            name = f'state-{index}.json'
            raw = json.dumps({'index': index}).encode()
            (current / name).write_bytes(raw)
            records.append({'path': name, 'sha256': activation.sha(raw)})
        intent = {'contract': activation.CONTRACT, 'runId': run.name, 'runSha256': activation.sha(run_raw),
                  'date': '2026-09-04', 'files': records, 'canonicalSha256': 'a' * 64}
        return current, run, intent

    def test_archive_is_exact_private_and_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            current, run, intent = self.fixture(Path(tmp))
            activation.retire_files(current, run, intent)
            activation.assert_no_pending(current, intent['date'], run.parent)
            activation.retire_files(current, run, intent)
            for record in intent['files']:
                archived = run / 'publication-archive' / record['path']
                self.assertEqual(activation.sha(archived.read_bytes()), record['sha256'])
                self.assertEqual(archived.stat().st_mode & 0o777, 0o600)
                self.assertFalse((current / record['path']).exists())

    def test_each_crash_window_stays_closed_and_resumes(self):
        for stop in range(7):
            with self.subTest(stop=stop), tempfile.TemporaryDirectory() as tmp:
                current, run, intent = self.fixture(Path(tmp))
                def crash(index):
                    if index == stop:
                        raise RuntimeError('injected crash')
                with self.assertRaisesRegex(RuntimeError, 'injected'):
                    activation.retire_files(current, run, intent, after_move=crash)
                with self.assertRaisesRegex(ValueError, 'activation'):
                    activation.assert_no_pending(current, intent['date'], run.parent)
                activation.retire_files(current, run, intent)
                activation.assert_no_pending(current, intent['date'], run.parent)

    def test_drift_missing_archive_and_unsafe_paths_refuse(self):
        for failure in ('drift', 'missing', 'traversal', 'symlink'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                current, run, intent = self.fixture(Path(tmp))
                if failure == 'drift': (current / 'state-0.json').write_text('changed')
                if failure == 'missing': (current / 'state-0.json').unlink()
                if failure == 'traversal': intent['files'][0]['path'] = '../escape'
                if failure == 'symlink':
                    (current / 'state-0.json').unlink()
                    (current / 'state-0.json').symlink_to(current / 'state-1.json')
                with self.assertRaises((ValueError, OSError)):
                    activation.retire_files(current, run, intent)
                self.assertTrue((current / 'state-5.json').exists())

    def test_completed_reentry_never_retires_new_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            current, run, intent = self.fixture(Path(tmp))
            activation.retire_files(current, run, intent)
            (current / 'state-0.json').write_text('new generation')
            activation.retire_files(current, run, intent)
            self.assertEqual((current / 'state-0.json').read_text(), 'new generation')

    def test_corrupt_pending_marker_is_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = Path(tmp)
            target = activation.marker_path(current, '2026-09-04')
            target.parent.mkdir()
            target.write_text('{broken')
            with self.assertRaises(ValueError):
                activation.assert_no_pending(current, '2026-09-04')

    def test_completed_marker_must_bind_intent_final_run_and_archive(self):
        for drift in ('intent', 'final', 'run', 'archive'):
            with self.subTest(drift=drift), tempfile.TemporaryDirectory() as tmp:
                current, run, intent = self.fixture(Path(tmp))
                activation.retire_files(current, run, intent)
                target = {'intent': run / 'publication-activation-intent.json',
                          'final': run / 'publication-activation.json', 'run': run / 'run.json',
                          'archive': run / 'publication-archive' / 'state-0.json'}[drift]
                target.write_text('{}')
                with self.assertRaises(ValueError): activation.assert_no_pending(current, intent['date'], run.parent)

    def test_hardlink_commit_crash_is_recognized_and_recovered(self):
        import os
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp).resolve() / 'archive.json'; raw = b'{"proof":true}'
            temporary = target.parent / f'.activation-write-{target.name}-{activation.sha(raw)}'
            temporary.write_bytes(raw); temporary.chmod(0o600); os.link(temporary, target)
            self.assertEqual(target.stat().st_nlink, 2)
            self.assertEqual(activation.read(target), raw)
            activation.write(target, raw)
            self.assertEqual(target.stat().st_nlink, 1)
            self.assertFalse(temporary.exists())

    def test_partial_unlinked_temp_is_resumable_without_overwriting_final(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp).resolve() / 'archive.json'; raw = b'{"proof":true}'
            temporary = target.parent / f'.activation-write-{target.name}-{activation.sha(raw)}'
            temporary.write_bytes(raw[:4]); temporary.chmod(0o600)
            activation.write(target, raw)
            self.assertEqual(activation.read(target), raw)
            self.assertFalse(temporary.exists())

    def test_completed_dry_verifier_detects_archive_corruption(self):
        with tempfile.TemporaryDirectory() as tmp:
            current, run, intent = self.fixture(Path(tmp))
            activation.retire_files(current, run, intent)
            (run / 'publication-archive' / 'state-1.json').write_text('bad')
            with self.assertRaises(ValueError): activation.verify_completed(current, run, intent)

    def test_mid_transaction_scientific_cas_drift_stays_pending(self):
        with tempfile.TemporaryDirectory() as tmp:
            current, run, intent = self.fixture(Path(tmp))
            checks = mock.Mock(side_effect=[None, ValueError('CAS drift')])
            with self.assertRaisesRegex(ValueError, 'CAS drift'):
                activation.retire_files(current, run, intent, validate=checks)
            self.assertTrue(all((current / r['path']).exists() for r in intent['files']))
            with self.assertRaises(ValueError): activation.assert_no_pending(current, intent['date'], run.parent)

    def test_shared_publication_lock_blocks_all_stage_bodies(self):
        from blog_entry_loader import load_publish_to_blog
        module = load_publish_to_blog()
        with tempfile.TemporaryDirectory() as tmp:
            current = Path(tmp).resolve()
            marker = activation.marker_path(current, '2026-09-04')
            activation.write(marker, activation.encoded({'contract': activation.CONTRACT,
                'date': '2026-09-04', 'status': 'pending'}))
            with mock.patch.object(module, 'CURRENT_DIR', current):
                for stage in ('generate', 'review', 'push'):
                    body = mock.Mock(name=stage)
                    with self.assertRaises(module.PublishDataValidationError):
                        with module.blog_publication_lock('2026-09-04'):
                            body()
                    body.assert_not_called()


class ActivationPreflightTest(unittest.TestCase):
    def fixture(self, root):
        root = root.resolve(); current = root / 'current'; current.mkdir()
        repo = root / 'blog'; repo.mkdir()
        run = root / 'run-id'; run.mkdir()
        date = '2026-09-04'; head = 'b' * 40; old = 'a' * 40
        page = repo / 'page.md'; page.write_text('current single page')
        ids = ['2609.03622']
        canonical = {'generation': 831, 'papers': [{'arxivId': ids[0]}],
                     'freshRewritePromotion': {'runId': run.name}}
        canonical_raw = activation.encoded(canonical)
        (current / 'deep-analysis-result.json').write_bytes(canonical_raw)
        baseline = {'contract': 'fresh-rewrite-baseline-v1', 'date': date, 'paperIds': ids,
                    'blog': {'repo': str(repo), 'head': head}, 'files': []}
        def backup(category, name, raw):
            relative = 'baseline-files/' + category + '/' + name
            activation.write(run / relative, raw)
            baseline['files'].append({'category': category, 'relativePath': name,
                'backupPath': relative, 'sha256': activation.sha(raw)})
        backup('blog', 'page.md', page.read_bytes())
        for scope, commit in [('', old), ('-single-2609-03622-fixture', head)]:
            stem = date + scope
            manifest = b'{"schemaVersion":3}'
            receipt = activation.encoded({'date': date, 'publicationCommit': commit,
                'remoteVerifiedOid': commit, 'remoteIdentitySha256': 'c' * 64,
                'remoteVerifiedAt': 'now', 'generationManifestSha256': activation.sha(manifest),
                'files': [{'path': 'page.md', 'sha256': 'd' * 64}]})
            for kind, raw in [('generation-manifest', manifest), ('review-receipt', receipt)]:
                name = f'blog-{kind}-{stem}.json'; (current / name).write_bytes(raw)
                backup('data', name, raw)
            (current / f'blog-review-passes-{stem}.json').write_text('{}')
        baseline_raw = activation.encoded(baseline)
        (run / 'baseline.json').write_bytes(baseline_raw)
        (run / 'run.json').write_bytes(activation.encoded({'status': 'promoted', 'runId': run.name,
            'date': date, 'paperIds': ids, 'baseline': {'sha256': activation.sha(baseline_raw)}}))
        (run / 'promotion.json').write_bytes(activation.encoded({'runId': run.name,
            'baselineSha256': activation.sha(baseline_raw), 'canonicalSha256': activation.sha(canonical_raw),
            'canonicalGeneration': 831}))
        def git(args, **_kwargs):
            if args == ['rev-parse', 'HEAD']: value = head
            elif args == ['branch', '--show-current']: value = 'main'
            else: value = ''
            return SimpleNamespace(stdout=value)
        module = SimpleNamespace(CURRENT_DIR=current, BLOG_REPO=repo, _run_git=mock.Mock(side_effect=git),
            _remote_main_oid=mock.Mock(return_value=(head, '')),
            _remote_identity_sha256=mock.Mock(return_value=('c' * 64, '')),
            validate_git_commit_against_review_receipt=mock.Mock())
        return module, run, current, repo

    def test_preflight_checks_original_commits_and_never_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            module, run, current, repo = self.fixture(Path(tmp))
            before = {str(p): p.read_bytes() for p in Path(tmp).rglob('*') if p.is_file()}
            intent = activation.prepare_intent(module, run)
            self.assertEqual(len(intent['files']), 6)
            self.assertEqual([c.kwargs['commit'] for c in module.validate_git_commit_against_review_receipt.call_args_list],
                             ['b' * 40, 'a' * 40])
            self.assertEqual(before, {str(p): p.read_bytes() for p in Path(tmp).rglob('*') if p.is_file()})

    def test_preflight_rejects_canonical_blog_remote_and_receipt_drift(self):
        for drift in ('canonical', 'blog', 'remote', 'identity', 'receipt', 'extra'):
            with self.subTest(drift=drift), tempfile.TemporaryDirectory() as tmp:
                module, run, current, repo = self.fixture(Path(tmp))
                if drift == 'canonical': (current / 'deep-analysis-result.json').write_text('{}')
                if drift == 'blog': (repo / 'page.md').write_text('drift')
                if drift == 'remote': module._remote_main_oid.return_value = ('e' * 40, '')
                if drift == 'identity': module._remote_identity_sha256.return_value = ('e' * 64, '')
                if drift == 'receipt': (current / 'blog-review-receipt-2026-09-04.json').write_text('{}')
                if drift == 'extra': (current / 'blog-generation-journal-2026-09-04.json').write_text('{}')
                with self.assertRaises(ValueError): activation.prepare_intent(module, run)
                self.assertFalse((run / 'publication-activation-intent.json').exists())

    def test_partial_retirement_repreflight_uses_immutable_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            module, run, current, repo = self.fixture(Path(tmp))
            intent = activation.prepare_intent(module, run)
            def crash(index):
                if index == 2: raise RuntimeError('stop')
            with self.assertRaises(RuntimeError): activation.retire_files(current, run, intent, crash)
            self.assertEqual(activation.prepare_intent(module, run), intent)
            activation.retire_files(current, run, intent)


if __name__ == '__main__':
    unittest.main()
