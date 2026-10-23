"""Actual temporary local ref/remote/delta facts, never normal authority."""
import importlib
import contextlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import local_git_test_fixture as fixture


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode('utf-8')


class LocalGitPublicationIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='local-publication-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.repo, self.objects = fixture.create_repo(self.root)
        self.base = self.objects['commit'][0]
        self.page_body = b'New mechanically compared page\n'
        (self.repo / 'page.md').write_bytes(self.page_body)
        fixture.git(self.repo, 'add', '--', 'page.md')
        fixture.git(self.repo, 'commit', '-m', 'Mechanical candidate C')
        self.current = fixture.git(self.repo, 'rev-parse', 'HEAD').stdout.decode().strip()
        self.remote_url = 'https://example.invalid/controlled.git'
        fixture.git(self.repo, 'remote', 'add', 'origin', self.remote_url)
        self.expected = [
            {'path': '中文 tree/name with space.bin', 'deleted': False,
             'sha256': fixture.sha(self.objects['blob'][1])},
            {'path': 'page.md', 'deleted': False, 'sha256': fixture.sha(self.page_body)},
        ]

    def module(self):
        return importlib.import_module('local_git_publication')

    def remote_hash(self, url=None):
        return fixture.sha(canonical({'remote': 'origin', 'pushUrl': self.remote_url if url is None else url}))

    def read(self, *, context=False, **changes):
        inputs = {'commit_oid': self.current, 'remote_name': 'origin',
                  'expected_remote_identity_sha256': self.remote_hash()}
        if not context:
            inputs.update(base_oid=self.base, expected_files=self.expected)
        inputs.update(changes)
        function = (self.module().read_local_publication_context if context
                    else self.module().read_local_publication_git)
        return function(str(self.repo), **inputs)

    def error(self, domain, code, reason=None, *, context=False, **changes):
        module = self.module()
        with self.assertRaises(module.LocalPublicationReadError) as caught:
            self.read(context=context, **changes)
        error = caught.exception
        self.assertEqual(error.code, code)
        if domain is not None:
            self.assertEqual(error.domain, domain)
        self.assertIn(error.domain, ('raw', 'delta', 'publication'))
        if reason is not None:
            self.assertEqual(error.reason, reason)
        for token in (error.domain, error.code, error.reason):
            self.assertRegex(token, r'^[a-z][a-z0-9_]{0,63}$')
        self.assertLessEqual(len(str(error).encode()), 256)
        for private in (str(self.root), self.remote_url, 'SecretNeedle', 'fatal:'):
            self.assertNotIn(private, str(error))
        return error

    def assert_context(self, result):
        self.assertEqual(set(result), {'contract', 'version', 'status', 'repositoryIdentity',
            'admissionIdentity', 'gitIdentity', 'controls', 'branch', 'headOid', 'remoteName',
            'localRemoteConfigurationMatch', 'inputBinding', 'refPhysicalIdentitySha256',
            'observationSha256'})
        self.assertEqual(result['contract'], 'local-git-publication-observation-v1')
        self.assertEqual(result['version'], 1)
        self.assertEqual(result['status'], 'local_publication_context_observed')
        self.assertEqual(result['branch'], 'refs/heads/main')
        self.assertEqual(result['headOid'], self.current)
        self.assertEqual(result['remoteName'], 'origin')
        self.assertEqual(result['localRemoteConfigurationMatch'], 'verified')
        self.assertEqual(result['inputBinding'], 'before_after_observation')
        self.assertEqual(set(result['repositoryIdentity']), {'root', 'git', 'objects'})
        for key, relative in (('root', ''), ('git', '.git'), ('objects', '.git/objects')):
            fact = result['repositoryIdentity'][key]
            self.assertEqual(set(fact), {'path', 'device', 'inode', 'mode', 'bytes', 'mtimeNs'})
            self.assertEqual(fact['path'], str(self.repo / relative))
            actual = (self.repo / relative).lstat()
            self.assertEqual((fact['device'], fact['inode']), (actual.st_dev, actual.st_ino))
        self.assertEqual(set(result['admissionIdentity']),
            {'configSha256', 'controlFilesSha256', 'objectStoreMetadataSha256'})
        self.assertEqual(result['admissionIdentity']['configSha256'],
                         fixture.sha((self.repo / '.git/config').read_bytes()))
        self.assertEqual(set(result['controls']),
            {'refsDirectory', 'headsDirectory', 'head', 'looseMain', 'packedRefs'})
        for key in ('head', 'looseMain', 'packedRefs'):
            fact = result['controls'][key]
            if fact is not None:
                self.assertEqual(set(fact), {'device', 'inode', 'mode', 'bytes', 'mtimeNs', 'sha256'})
        identity = {'contract': 'local-git-publication-ref-identity-v1', 'version': 1,
                    **{key: result[key] for key in ('repositoryIdentity', 'admissionIdentity',
                        'gitIdentity', 'controls', 'branch', 'headOid', 'remoteName')}}
        self.assertEqual(result['refPhysicalIdentitySha256'], fixture.sha(canonical(identity)))
        self.assertEqual(result['observationSha256'], fixture.sha(canonical({
            key: value for key, value in result.items() if key != 'observationSha256'})))
        text = canonical(result)
        self.assertLessEqual(len(text), 64 * 1024)
        self.assertNotIn(self.remote_url.encode(), text)
        self.assertNotIn(self.remote_hash().encode(), text)
        for authority in ('normal', 'published', 'source', 'full', 'localPublicationProof'):
            self.assertNotIn(authority, result)
        return result

    def assert_combined(self, result):
        self.assertEqual(set(result), {'contract', 'version', 'status', 'context',
            'deltaObservationSha256', 'reviewedFileSetSha256', 'reviewedFileFactsSha256',
            'delta', 'coverage', 'observationSha256'})
        self.assertEqual(result['contract'], 'local-git-publication-observation-v1')
        self.assertEqual(result['version'], 1)
        self.assertEqual(result['status'], 'local_publication_git_observed')
        self.assert_context(result['context'])
        self.assertEqual(set(result['delta']), {'baseOid', 'commitOid', 'pathCount', 'pathsSha256'})
        self.assertEqual((result['delta']['baseOid'], result['delta']['commitOid']),
                         (self.base, self.current))
        self.assertEqual(result['reviewedFileSetSha256'], fixture.sha(canonical(
            sorted(self.expected, key=lambda row: row['path'].encode()))))
        self.assertEqual(result['observationSha256'], fixture.sha(canonical({
            key: value for key, value in result.items() if key != 'observationSha256'})))
        for field in ('head', 'branch', 'remote', 'source', 'normal', 'worktree', 'index',
                      'publication', 'deployment', 'productionArtifact'):
            self.assertEqual(result['coverage'][field], 'not_checked')
        self.assertLessEqual(len(canonical(result)), 64 * 1024)
        return result

    @contextlib.contextmanager
    def after_real_command(self, predicate, mutation):
        raw = importlib.import_module('local_git_object')
        actual = raw._git_command
        hits = []

        def command(binary, directory, env, args, limit, limits, deadline, *, phase):
            output = actual(binary, directory, env, args, limit, limits, deadline, phase=phase)
            if not hits and predicate(args):
                hits.append(True)
                mutation()
            return output

        with mock.patch.object(raw, '_git_command', side_effect=command):
            yield hits
        self.assertEqual(hits, [True], 'The intended actual Git command must complete')

    def test_real_delta_positive_precedes_the_new_fixed_publication_api(self):
        delta = importlib.import_module('local_git_commit_delta')
        prior = delta.read_local_commit_delta(str(self.repo), base_oid=self.base,
                    commit_oid=self.current, expected_files=self.expected)
        self.assertEqual(prior['status'], 'commit_delta_observed')
        self.assertEqual(prior['delta']['paths'], ['page.md'])
        before = fixture.inventory(self.repo)
        observed = self.assert_combined(self.read())
        self.assertEqual(observed['deltaObservationSha256'], prior['observationSha256'])
        self.assertEqual(observed['reviewedFileFactsSha256'], prior['reviewedFileFactsSha256'])
        self.assertEqual(observed['delta']['pathsSha256'], prior['delta']['pathsSha256'])
        self.assertEqual(observed['delta']['pathCount'], 1)
        self.assertEqual(fixture.inventory(self.repo), before)

    def test_context_is_an_actual_independent_bounded_read(self):
        before = fixture.inventory(self.repo)
        combined = self.assert_combined(self.read())
        context = self.assert_context(self.read(context=True))
        self.assertEqual(combined['context'], context)
        self.assertEqual(fixture.inventory(self.repo), before)

    def test_native_commands_use_the_fixed_no_transport_runner(self):
        actual = subprocess.Popen
        calls = []

        def popen(argv, *args, **kwargs):
            calls.append((list(argv), kwargs.get('env', {})))
            return actual(argv, *args, **kwargs)

        with mock.patch.object(subprocess, 'Popen', side_effect=popen):
            self.assert_combined(self.read())
        self.assertTrue(any('symbolic-ref' in argv for argv, _ in calls))
        self.assertTrue(any('get-url' in argv for argv, _ in calls))
        for argv, env in calls:
            self.assertTrue(Path(argv[0]).is_absolute())
            for flag in ('--no-lazy-fetch', '--no-replace-objects', '--no-optional-locks'):
                self.assertIn(flag, argv)
            self.assertEqual(env['GIT_ALLOW_PROTOCOL'], '')
            self.assertEqual(env['GIT_NO_LAZY_FETCH'], '1')
            self.assertFalse(set(argv) & {'fetch', 'push', 'ls-remote', 'checkout', 'reset'})

    def test_packed_main_is_real_and_loose_main_takes_precedence(self):
        self.assert_context(self.read(context=True))
        fixture.git(self.repo, 'pack-refs', '--all')
        self.assertFalse((self.repo / '.git/refs/heads/main').exists())
        packed = self.assert_context(self.read(context=True))
        self.assertIsNone(packed['controls']['looseMain'])
        self.assertIsNotNone(packed['controls']['packedRefs'])
        self.assert_combined(self.read())
        loose = self.repo / '.git/refs/heads/main'
        loose.write_text(self.current + '\n')
        packed_file = self.repo / '.git/packed-refs'
        packed_file.write_bytes(packed_file.read_bytes().replace(self.current.encode(), self.base.encode()))
        self.assert_context(self.read(context=True))

    def test_packed_records_must_be_bounded_and_unambiguous(self):
        self.assert_context(self.read(context=True))
        path = self.repo / '.git/packed-refs'
        for content in (
                (self.current + ' refs/heads/main\n') .encode() * 2,
                b'^' + self.current.encode() + b'\n',
                self.current.encode() + b' refs/heads/main\r\n',
                self.current.encode() + b' refs/heads/main\x00\n'):
            with self.subTest(content=content[:1]):
                path.write_bytes(content)
                self.error('publication', 'unsupported_state', 'packed_refs_shape', context=True)
        path.unlink()
        self.assert_context(self.read(context=True))

    def test_direct_head_and_real_main_value_are_separate_gates(self):
        self.assert_context(self.read(context=True))
        head = self.repo / '.git/HEAD'
        saved = head.read_bytes()
        for body in ((self.current + '\n').encode(), b'ref: refs/heads/other\n',
                     b'ref: refs/heads/alias\n'):
            with self.subTest(head=body[:3]):
                fixture.git(self.repo, 'update-ref', 'refs/heads/other', self.current)
                fixture.git(self.repo, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/main')
                head.write_bytes(body)
                self.error('publication', 'unsupported_state', 'head_literal', context=True)
        head.write_bytes(saved)
        main = self.repo / '.git/refs/heads/main'
        main.write_text(self.base + '\n')
        self.error('publication', 'state_mismatch', 'head_commit', context=True)
        main.write_text(self.current + '\n')
        self.assert_context(self.read(context=True))

    def test_refs_parents_and_loose_main_reject_symlinks_and_special_files(self):
        self.assert_context(self.read(context=True))
        main = self.repo / '.git/refs/heads/main'
        saved = main.read_bytes()
        outside = self.root / 'external-main'
        outside.write_bytes(saved)
        main.unlink()
        main.symlink_to(outside)
        self.error('raw', 'unsupported_repository', 'regular_file', context=True)
        main.unlink()
        os.mkfifo(main)
        self.error('raw', 'unsupported_repository', 'regular_file', context=True)
        main.unlink()
        main.write_bytes(saved)
        heads = main.parent
        moved = self.root / 'external-heads'
        heads.rename(moved)
        heads.symlink_to(moved, target_is_directory=True)
        self.error('publication', 'unsupported_state', 'ref_parent_type', context=True)
        heads.unlink()
        moved.rename(heads)
        self.assert_context(self.read(context=True))

    def test_loose_alias_truncation_and_native_failure_are_not_absence(self):
        path = self.repo / '.git/refs/heads/main'
        original = path.read_bytes()
        self.assert_context(self.read(context=True))
        for raw in (b'ref: refs/heads/other\n', self.current.encode(),
                    self.current.upper().encode() + b'\n', b'0' * 40 + b'\n'):
            with self.subTest(rawBytes=len(raw)):
                path.write_bytes(raw)
                with self.assertRaises(self.module().LocalPublicationReadError):
                    self.read(context=True)
        path.write_bytes(original)
        self.assert_context(self.read(context=True))

    def test_unique_pushurl_precedence_and_original_hash_domain(self):
        self.assert_context(self.read(context=True))
        selected = 'https://user:SecretNeedle@example.invalid/声音.git'
        fixture.git(self.repo, 'config', 'remote.origin.pushurl', selected)
        native = fixture.git(self.repo, 'remote', 'get-url', '--push', 'origin').stdout.decode().strip()
        self.assertEqual(native, selected)
        result = self.assert_context(self.read(context=True,
            expected_remote_identity_sha256=self.remote_hash(native)))
        self.assertNotIn('SecretNeedle', canonical(result).decode())
        self.error('publication', 'state_mismatch', 'remote_identity', context=True)

    def test_multiple_effective_remote_urls_and_unsafe_values_are_unsupported(self):
        self.assert_context(self.read(context=True))
        fixture.git(self.repo, 'config', '--add', 'remote.origin.url', self.remote_url)
        self.error('publication', 'unsupported_state', 'remote_url_count', context=True)
        fixture.git(self.repo, 'config', '--unset-all', 'remote.origin.url')
        fixture.git(self.repo, 'config', 'remote.origin.url', self.remote_url)
        fixture.git(self.repo, 'config', '--add', 'remote.origin.pushurl', self.remote_url)
        fixture.git(self.repo, 'config', '--add', 'remote.origin.pushurl', self.remote_url)
        self.error('publication', 'unsupported_state', 'remote_url_count', context=True)
        fixture.git(self.repo, 'config', '--unset-all', 'remote.origin.pushurl')
        for bad in (' ' + self.remote_url, self.remote_url + '\nSecretNeedle', self.remote_url + '\x7f'):
            with self.subTest(kind=bad[:1]):
                fixture.git(self.repo, 'config', 'remote.origin.url', bad)
                reason = 'remote_url_count' if '\n' in bad else 'remote_url_shape'
                self.error('publication', 'unsupported_state', reason, context=True,
                           expected_remote_identity_sha256=self.remote_hash(bad))

    def test_rewrite_config_and_global_environment_never_select_another_remote(self):
        self.assert_context(self.read(context=True))
        environment = self.root / 'malicious-config'
        environment.write_text('[remote "origin"]\n url = https://user:SecretNeedle@example.invalid/wrong\n')
        with mock.patch.dict(os.environ, {'GIT_CONFIG_GLOBAL': str(environment),
                'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'remote.origin.url',
                'GIT_CONFIG_VALUE_0': 'https://user:SecretNeedle@example.invalid/evil'}):
            self.assert_context(self.read(context=True))
        fixture.git(self.repo, 'config', 'url.https://wrong.invalid/.insteadOf', 'https://example.invalid/')
        self.error('raw', 'unsupported_repository', 'config_policy', context=True)

    def test_config_identity_changes_even_when_the_selected_remote_is_unchanged(self):
        first = self.assert_context(self.read(context=True))
        config = self.repo / '.git/config'
        original = config.read_bytes()
        changed = original.replace(b'fixture@example.invalid', b'changed@example.invalid')
        self.assertNotEqual(changed, original)
        self.assertEqual(len(changed), len(original))
        config.write_bytes(changed)
        second = self.assert_context(self.read(context=True))
        self.assertNotEqual(first['admissionIdentity']['configSha256'], second['admissionIdentity']['configSha256'])
        self.assertNotEqual(first['refPhysicalIdentitySha256'], second['refPhysicalIdentitySha256'])
        self.assertEqual(first['headOid'], second['headOid'])
        self.assertEqual(first['localRemoteConfigurationMatch'], second['localRemoteConfigurationMatch'])

    def test_physical_root_replacement_is_visible_even_with_the_same_git_directory(self):
        first = self.assert_context(self.read(context=True))
        old = self.root / 'old-root'
        self.repo.rename(old)
        self.repo.mkdir()
        for child in old.iterdir():
            shutil.move(str(child), str(self.repo / child.name))
        second = self.assert_context(self.read(context=True))
        self.assertNotEqual(first['repositoryIdentity']['root']['inode'], second['repositoryIdentity']['root']['inode'])
        self.assertEqual(first['repositoryIdentity']['git']['inode'], second['repositoryIdentity']['git']['inode'])
        self.assertNotEqual(first['refPhysicalIdentitySha256'], second['refPhysicalIdentitySha256'])

    def test_ref_and_config_mutations_during_actual_reads_hit_the_final_gate(self):
        self.assert_combined(self.read())
        config = self.repo / '.git/config'
        original = config.read_bytes()
        main = self.repo / '.git/refs/heads/main'
        original_main = main.read_bytes()
        for kind in ('config', 'main'):
            def mutate():
                if kind == 'config':
                    config.write_bytes(original.replace(b'fixture@example.invalid', b'changed@example.invalid'))
                else:
                    main.write_text(self.base + '\n')
            try:
                with self.subTest(kind=kind), self.after_real_command(
                        lambda args: args == ['cat-file', 'commit', self.current], mutate):
                    self.error(None, 'metadata_changed')
            finally:
                config.write_bytes(original)
                main.write_bytes(original_main)
        self.assert_combined(self.read())

    def test_ref_change_during_context_admission_overrides_the_new_head_mismatch(self):
        self.assert_context(self.read(context=True))
        main = self.repo / '.git/refs/heads/main'
        original = main.read_bytes()
        try:
            with self.after_real_command(lambda args: args == ['symbolic-ref', '--quiet', 'HEAD'],
                    lambda: main.write_text(self.base + '\n')) as hits:
                with self.assertRaises(self.module().LocalPublicationReadError) as caught:
                    self.read(context=True)
            self.assertEqual(hits, [True])
            self.assertEqual(main.read_text(), self.base + '\n')
            self.assertEqual(caught.exception.code, 'metadata_changed')
        finally:
            main.write_bytes(original)
        self.assert_context(self.read(context=True))

    def test_parent_and_missing_object_failures_keep_the_complete_terminal_observation(self):
        self.assert_combined(self.read())
        candidate = self.current
        fixture.git(self.repo, 'commit', '--allow-empty', '-m', 'Wrong-parent mechanical candidate')
        self.current = fixture.git(self.repo, 'rev-parse', 'HEAD').stdout.decode().strip()
        self.assert_context(self.read(context=True))
        self.error('delta', 'parent_mismatch')
        config = self.repo / '.git/config'
        saved = config.read_bytes()
        try:
            with self.after_real_command(lambda args: args == ['cat-file', 'commit', self.current],
                    lambda: config.write_bytes(saved + b'\n')):
                self.error(None, 'metadata_changed')
        finally:
            config.write_bytes(saved)
        self.current = candidate
        fixture.git(self.repo, 'update-ref', 'refs/heads/main', candidate)
        self.assert_combined(self.read())
        blob_oid = fixture.object_oid('blob', self.page_body)
        blob = self.repo / '.git/objects' / blob_oid[:2] / blob_oid[2:]
        raw, mode = blob.read_bytes(), blob.stat().st_mode & 0o777
        blob.unlink()
        self.error('raw', 'object_unavailable')
        hits = []
        real = subprocess.Popen

        def popen(argv, *args, **kwargs):
            if not hits and 'cat-file' in argv and blob_oid in argv:
                hits.append(True)
                config.write_bytes(saved + b'\n')
            return real(argv, *args, **kwargs)

        try:
            with mock.patch.object(subprocess, 'Popen', side_effect=popen):
                self.error(None, 'metadata_changed')
            self.assertEqual(hits, [True])
        finally:
            config.write_bytes(saved)
            blob.write_bytes(raw)
            blob.chmod(mode)
        self.assert_combined(self.read())

    def test_real_control_exceptions_survive_ref_drift_and_terminal_checks(self):
        main = self.repo / '.git/refs/heads/main'
        original = main.read_bytes()
        for intended in (KeyboardInterrupt(), SystemExit(73)):
            with self.subTest(control=type(intended).__name__):
                self.assert_combined(self.read())
                caught = None
                hits = []
                finishes = []
                delta = importlib.import_module('local_git_commit_delta')
                real_finish = delta._Session._finish

                def finish(session, primary):
                    try:
                        return real_finish(session, primary)
                    finally:
                        finishes.append((session.closed, len(session.cache)))

                def mutate_and_interrupt():
                    main.write_text(self.base + '\n')
                    raise intended

                try:
                    try:
                        with mock.patch.object(delta._Session, '_finish', finish), self.after_real_command(
                                lambda args: args == ['cat-file', 'commit', self.current],
                                mutate_and_interrupt) as hits:
                            self.read()
                    except BaseException as error:
                        caught = error
                    self.assertEqual(hits, [True])
                    self.assertEqual(main.read_text(), self.base + '\n')
                    self.assertEqual(finishes, [(True, 0)], 'Real terminal check must close and clear the scope')
                    self.assertIs(caught, intended, 'Actual control exception must keep its identity')
                finally:
                    main.write_bytes(original)
        self.assert_combined(self.read())

    def test_packed_control_budget_is_checked_before_any_ref_native_query(self):
        self.assert_context(self.read(context=True))
        packed = self.repo / '.git/packed-refs'
        packed.write_bytes(b'#' + b'x' * (1024 * 1024))
        calls = []
        real = subprocess.Popen
        def popen(argv, *args, **kwargs):
            if 'symbolic-ref' in argv:
                calls.append(list(argv))
            return real(argv, *args, **kwargs)
        with mock.patch.object(subprocess, 'Popen', side_effect=popen):
            self.error('raw', 'size_exceeded', 'file_bytes', context=True)
        self.assertEqual(calls, [])

    def test_required_promisor_blob_is_unavailable_without_helper_or_repository_write(self):
        blob_oid = fixture.object_oid('blob', self.page_body)
        partial, canary = fixture.create_promisor(self.root, self.repo, blob_oid, name='publication-partial')
        old_repo = self.repo
        self.repo = partial
        try:
            self.remote_url = fixture.git(partial, 'remote', 'get-url', '--push', 'origin').stdout.decode().strip()
            environment = fixture.git_environment(self.root)
            environment['GIT_ALLOW_PROTOCOL'] = 'ext'
            control = fixture.git(partial, 'cat-file', 'blob', blob_oid, environment=environment, check=False)
            self.assertNotEqual(control.returncode, 0)
            self.assertEqual(canary.read_text().splitlines(), ['entered'])
            before = fixture.inventory(partial)
            calls = []
            real = subprocess.Popen
            def popen(argv, *args, **kwargs):
                if 'cat-file' in argv and blob_oid in argv:
                    calls.append(list(argv))
                return real(argv, *args, **kwargs)
            with mock.patch.object(subprocess, 'Popen', side_effect=popen):
                self.error('raw', 'object_unavailable')
            self.assertTrue(calls, 'The actual missing required blob must reach the strict runner')
            self.assertEqual(canary.read_text().splitlines(), ['entered'])
            self.assertEqual(fixture.inventory(partial), before)
        finally:
            self.repo = old_repo


if __name__ == '__main__':
    unittest.main()
