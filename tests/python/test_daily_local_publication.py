"""Actual normal/D1/temp-bare publication composition, not scientific Source.

Preparation uses real normal gates/Hugo/writer/push and an offline text LLM leaf.
The observed business entry must perform no build, transport or adoption.
"""
import contextlib
import copy
import importlib
import importlib.util
import inspect
import io
import json
from pathlib import Path
import shutil
import socket
import subprocess
import sys
from types import FunctionType
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_daily_reviewed_targets as targets_fixture
from project_env_isolation import project_env_scope

DATE = targets_fixture.DATE
publisher = targets_fixture.publisher


class DailyLocalPublicationIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.case = targets_fixture.DailyReviewedTargetsIntegrationTest('runTest')
        self.addCleanup(self.case.doCleanups)
        self.case.setUp()
        self.fixture = self.case.fixture
        self.include_id = None
        self.normal_calls = []
        self.events = []
        self.commands = []
        self.after_normal = lambda _number: None
        self.after_last_git = lambda: None
        self.last_git_hits = []

    def prepare_publication(self, *, changes=False, include_id=None, publish=True):
        self.include_id = include_id
        if changes:
            self.case.prepare_changes()
        else:
            self.case.case.prepare(include_id=include_id)
        if not publish:
            return self.receipt()
        with publisher.publication_scope(include_id), publisher.blog_publication_lock(DATE), \
                contextlib.redirect_stdout(io.StringIO()):
            paths, _receipt_path = publisher.load_verified_review_receipt(DATE)
            self.assertTrue(publisher.git_push(DATE, paths))
        return self.receipt()

    def receipt(self):
        with publisher.publication_scope(self.include_id):
            return self.fixture.receipt()

    def receipt_path(self):
        with publisher.publication_scope(self.include_id):
            return publisher.review_receipt_path(DATE)

    def owner(self):
        return importlib.import_module('daily_observed_projection')

    def read(self, *, include_id=None, owner=None, kind='publication', unchanged=True, date_str=DATE):
        import blog_entry_loader
        actual_load = blog_entry_loader.load_publish_to_blog
        actual_popen = subprocess.Popen
        before = self.case.case.inventory()
        local_normals, remote_queries, forbidden = [], [], []
        self.normal_calls, self.events, self.commands, self.last_git_hits = [], [], [], []

        def load():
            with project_env_scope():
                module = actual_load()
            for name, value in (
                    ('BLOG_REPO', str(self.fixture.repo)), ('CONTENT_DIR', str(self.fixture.posts)),
                    ('CURRENT_DIR', self.fixture.current),
                    ('DAILY_FRESH_SOURCE_RUNS_DIR', self.fixture.source_root),
                    ('DAILY_RENDER_OBSERVATIONS_DIR', self.fixture.observation_root),
                    ('TAG_DISPLAY_POLICY_PATH', self.fixture.root / 'absent-policy.json')):
                setattr(module, name, value)
            normal, lock = module.load_verified_review_receipt, module.blog_publication_lock

            def gate(date):
                call = {'owner': module, 'scope': module._ACTIVE_PUBLICATION_INCLUDE_ID, 'returned': False}
                local_normals.append(call)
                self.normal_calls.append(call)
                self.events.append('normal-' + str(len(local_normals)))
                result = normal(date)
                call['returned'] = True
                self.after_normal(len(local_normals))
                return result

            @contextlib.contextmanager
            def held(date, **kwargs):
                self.events.append('lock-enter')
                with lock(date, **kwargs):
                    yield
                self.events.append('lock-exit')

            module.load_verified_review_receipt = gate
            module.blog_publication_lock = held
            for name in ('git_push', '_remote_main_oid', '_remote_identity_sha256',
                         'validate_git_commit_against_review_receipt',
                         'reusable_verified_publication_generation', 'save_review_receipt',
                         'save_generation_manifest', 'run_hugo_gate', 'call_publish_llm_api',
                         '_llm_review_post_chunk'):
                if hasattr(module, name):
                    def stop(*_args, _name=name, **_kwargs):
                        forbidden.append(_name)
                        raise AssertionError('Read-only entry called ' + _name)
                    setattr(module, name, stop)
            return module

        def popen(argv, *args, **kwargs):
            tokens = list(argv) if isinstance(argv, (tuple, list)) else [str(argv)]
            self.commands.append(tuple(str(value) for value in tokens))
            if (set(tokens) & {'fetch', 'push', 'ls-remote', '--destination', '--contentDir'}
                    or Path(str(tokens[0])).name in {'curl', 'wget', 'gh'}):
                forbidden.append('subprocess')
                raise AssertionError('No build or transport in the observed interval')
            process = actual_popen(argv, *args, **kwargs)
            if 'get-url' in tokens:
                remote_queries.append(True)
                if len(remote_queries) == 4:
                    actual_wait = process.wait

                    def wait(*wait_args, **wait_kwargs):
                        code = actual_wait(*wait_args, **wait_kwargs)
                        if not self.last_git_hits:
                            self.last_git_hits.append(True)
                            self.events.append('last-git-completed')
                            self.after_last_git()
                        return code
                    process.wait = wait
            return process

        module = owner or self.owner()
        function = {'publication': 'read_daily_local_publication',
                    'targets': 'read_daily_reviewed_targets',
                    'projection': 'read_daily_observed_projection'}[kind]
        with mock.patch.object(blog_entry_loader, 'load_publish_to_blog', side_effect=load), \
                mock.patch.object(subprocess, 'Popen', side_effect=popen), \
                mock.patch.object(socket, 'socket', side_effect=AssertionError('No Python network')):
            result = getattr(module, function)(date_str, include_id=include_id)
        self.assertEqual(forbidden, [])
        if unchanged:
            self.assertEqual(self.case.case.inventory(), before)
        return result

    def available(self, result, *, include_id=None):
        self.assertEqual(result['status'], 'local_publication_observed', (result, self.events))
        self.assertEqual(result['contract'], 'daily-local-publication-observation-v1')
        self.assertEqual(result['version'], 1)
        self.assertEqual(set(result), {'contract', 'version', 'status', 'selector', 'normalBinding',
            'reviewedTargets', 'publicationBinding', 'gitBinding', 'implementationBinding',
            'inputBinding', 'fullInputSnapshot', 'observationCoverage', 'coverage',
            'unknownInputs', 'capabilities', 'recordSha256'})
        self.assertEqual(result['capabilities'], {'canPublish': False, 'canResumeAnalysis': False,
            'canGrantSource': False, 'canExecuteBrowser': False})
        self.assertEqual(result['selector'], {'workflow': 'daily', 'date': DATE, 'includeId': include_id})
        target = self.case.target(result['reviewedTargets'])
        self.assertEqual(result['normalBinding'], target['normalBinding'])
        receipt = self.receipt()
        binding = result['publicationBinding']
        self.assertEqual(binding, {'baseOid': receipt['baseHead'], 'commitOid': receipt['publicationCommit'],
            'headOid': receipt['publicationCommit'], 'branch': 'refs/heads/main',
            'recordedRemote': {'name': receipt['remoteName'], 'oid': receipt['remoteVerifiedOid'],
                               'verifiedAt': receipt['remoteVerifiedAt']},
            'localRemoteConfigurationMatch': 'verified'})
        self.assertEqual(result['normalBinding']['receiptSha256'], targets_fixture.sha(
            self.receipt_path().read_bytes()))
        git = result['gitBinding']
        self.assertEqual(git['scopeFileCount'], len(receipt['files']))
        rows = [{key: row[key] for key in ('path', 'deleted', 'sha256')} for row in receipt['files']]
        self.assertEqual(git['reviewedFileSetSha256'], targets_fixture.sha(targets_fixture.canonical(
            sorted(rows, key=lambda row: row['path'].encode()))))
        self.assertEqual(git['context1ObservationSha256'], git['context2ObservationSha256'])
        for field in ('head', 'worktree', 'index', 'remote', 'normal', 'source', 'publication'):
            self.assertEqual(git['coverage'][field], 'not_checked')
        for field in ('remoteNow', 'deployment', 'onlineGet', 'browserExecution', 'productionArtifact',
                      'currentEligibility', 'sourceRecoveryEligibility', 'index', 'wholeRepositoryClean'):
            self.assertEqual(result['coverage'][field], 'not_checked')
        self.assertEqual(result['coverage']['normalReviewScope'], 'replayed_twice')
        self.assertEqual(result['coverage']['normalSourceObservation'], 'checked_at_normal2')
        self.assertEqual(result['coverage']['currentReviewedScopeFiles'], 'byte_rechecked_after_context2')
        self.assertEqual(result['fullInputSnapshot'], 'not_established')
        self.assertEqual(result['inputBinding'], 'observed_before_after')
        self.assertEqual(result['implementationBinding']['fullExecutionClosure'], 'not_established')
        self.assertEqual(result['recordSha256'], targets_fixture.sha(targets_fixture.canonical({
            key: value for key, value in result.items() if key != 'recordSha256'})))
        self.assertEqual(len(self.normal_calls), 2)
        self.assertTrue(all(row['returned'] and row['scope'] == include_id for row in self.normal_calls))
        self.assertIs(self.normal_calls[0]['owner'], self.normal_calls[1]['owner'])
        self.assertEqual(self.events.count('lock-enter'), 1)
        self.assertEqual(self.events.count('lock-exit'), 1)
        self.assertLessEqual(len(targets_fixture.canonical(result)), 2 * 1024 * 1024)
        return result

    def failure(self, result, status='blocked', *, domain=None):
        self.assertEqual(result['contract'], 'daily-local-publication-observation-v1')
        self.assertEqual(result['version'], 1)
        self.assertEqual(result['status'], status, (result, self.events))
        self.assertEqual(set(result), {'contract', 'version', 'status', 'issues', 'capabilities'})
        self.assertEqual(len(result['issues']), 1)
        issue = result['issues'][0]
        self.assertEqual(set(issue), {'domain', 'code', 'reason'})
        if domain is not None:
            self.assertEqual(issue['domain'], domain)
        for value in issue.values():
            self.assertRegex(value, '^[a-z][a-z0-9_]{0,63}$')
        self.assertEqual(result['capabilities'], {'canPublish': False, 'canResumeAnalysis': False,
            'canGrantSource': False, 'canExecuteBrowser': False})
        text = targets_fixture.canonical(result)
        self.assertLessEqual(len(text), 4096)
        self.assertNotIn(str(self.fixture.root).encode(), text)
        self.assertNotIn(b'SecretNeedle', text)
        return issue

    def test_real_normal_writer_publication_precedes_the_new_business_api(self):
        receipt = self.prepare_publication()
        self.assertEqual(receipt['publicationCommit'], receipt['remoteVerifiedOid'])
        publisher.load_verified_review_receipt(DATE)
        prior_targets = self.case.target(self.case.read())
        self.assertEqual(len(prior_targets['primaryPages']), 2)
        delta = importlib.import_module('local_git_commit_delta')
        files = [{key: row[key] for key in ('path', 'deleted', 'sha256')}
                 for row in receipt['files']]
        observed = delta.read_local_commit_delta(str(self.fixture.repo),
            base_oid=receipt['baseHead'], commit_oid=receipt['publicationCommit'], expected_files=files)
        self.assertEqual(observed['status'], 'commit_delta_observed')
        self.assertEqual(observed['expectedFilesSha256'], targets_fixture.sha(
            targets_fixture.canonical(sorted(files, key=lambda row: row['path'].encode()))))
        self.available(self.read())

    def test_full_assets_and_tombstones_join_the_actual_normal_git_scope(self):
        receipt = self.prepare_publication(changes=True)
        result = self.available(self.read())
        self.assertGreater(len(receipt['files']), len(self.fixture.paths))
        self.assertEqual(result['reviewedTargets']['changes']['deletedPaths'], self.case.deleted)
        self.assertEqual(result['reviewedTargets']['changes']['deletedUrls'], None)
        self.assertTrue(any(row['path'].endswith('.json') and not row['deleted'] for row in receipt['files']))
        self.assertEqual(result['reviewedTargets']['reviewedFileCount'], len(receipt['files']))

    def test_single_scope_is_owned_by_the_same_fresh_normal_instance(self):
        include_id = '2609.12341'
        self.prepare_publication(include_id=include_id)
        result = self.available(self.read(include_id=include_id), include_id=include_id)
        self.assertEqual(len(result['reviewedTargets']['primaryPages']), 1)
        with publisher.publication_scope(include_id):
            self.failure(self.read(), 'not_recorded', domain='selection')

    def test_real_review_only_and_missing_receipt_have_distinct_safe_states(self):
        self.failure(self.read(), 'not_recorded', domain='selection')
        self.prepare_publication(publish=False)
        self.failure(self.read(), 'not_published', domain='publication')
        self.case.target(self.read(kind='targets'))

    def test_original_normal_writer_without_ref_is_not_rebuilt_or_adopted(self):
        self.prepare_publication(publish=False)
        plan = publisher.plan_incremental_review(DATE, self.fixture.paths,
            self.fixture.manifest_path, self.fixture.base_head)
        self.assertEqual(plan['paths'], [])
        publisher.save_review_receipt(DATE, self.fixture.paths, 'hugo',
            expected_base_head=self.fixture.base_head, generation_manifest=self.fixture.manifest_path,
            reviewed_results=plan['priorResults'])
        publisher.load_verified_review_receipt(DATE)
        self.assertNotIn('renderObservation', self.fixture.receipt())
        self.failure(self.read(), 'not_recorded', domain='selection')
        self.assertTrue(self.normal_calls and self.normal_calls[0]['returned'])

    def test_present_invalid_publication_fields_never_become_not_published(self):
        original = self.prepare_publication()
        for key in ('publicationCommit', 'remoteVerifiedOid', 'remoteVerifiedAt',
                    'remoteName', 'remoteIdentitySha256'):
            with self.subTest(key=key):
                changed = copy.deepcopy(original)
                del changed[key]
                self.fixture.write_receipt(changed)
                self.failure(self.read(), domain='publication')
                self.assertTrue(self.normal_calls[0]['returned'])
        for key, value in (('publicationCommit', None), ('remoteVerifiedOid', '0' * 40),
                           ('remoteName', 'different'), ('remoteVerifiedAt', 'not-a-time')):
            with self.subTest(key=key, kind='invalid'):
                self.fixture.write_receipt({**original, key: value})
                self.failure(self.read(), domain='publication')
        self.fixture.write_receipt(original)
        self.available(self.read())

    def test_head_and_remote_new_gates_do_not_restrict_old_reviewed_targets(self):
        original = self.prepare_publication()
        repository = self.fixture.repo
        git = targets_fixture.observed_fixture.normal_fixture.git
        git(repository, 'checkout', '--detach', original['publicationCommit'])
        self.failure(self.read(), 'unsupported', domain='git')
        self.case.target(self.read(kind='targets'))
        git(repository, 'checkout', 'main')
        git(repository, 'commit', '--allow-empty', '-m', 'Mechanical later commit')
        self.failure(self.read(), domain='git')
        self.case.target(self.read(kind='targets'))
        git(repository, 'reset', '--soft', original['publicationCommit'])
        git(repository, 'remote', 'set-url', 'origin', 'https://user:SecretNeedle@example.invalid/elsewhere.git')
        self.failure(self.read(), domain='git')
        self.case.target(self.read(kind='targets'))

    def test_index_and_unrelated_worktree_changes_remain_explicitly_unchecked(self):
        self.prepare_publication()
        extra = self.fixture.repo / 'unrelated-mechanical-note.txt'
        extra.write_text('Caller change is outside the complete receipt scope.\n')
        targets_fixture.observed_fixture.normal_fixture.git(self.fixture.repo, 'add', '--', extra.name)
        result = self.available(self.read())
        self.assertEqual(result['coverage']['index'], 'not_checked')
        self.assertEqual(result['coverage']['wholeRepositoryClean'], 'not_checked')

    def test_warm_git_modules_are_forbidden_while_real_private_compilation_succeeds(self):
        self.prepare_publication()
        calls = []
        with contextlib.ExitStack() as stack:
            identities = {}
            for name in ('local_git_object', 'local_git_commit_delta', 'local_git_publication'):
                module = importlib.import_module(name)
                identities[name] = module
                for key, value in list(vars(module).items()):
                    if ((type(value) is FunctionType and value.__globals__ is vars(module))
                            or isinstance(value, type) and value.__module__ == name):
                        def forbidden(*_args, _key=name + '.' + key, **_kwargs):
                            calls.append(_key)
                            raise AssertionError('No warm Git function or class')
                        stack.enter_context(mock.patch.object(module, key, forbidden))
            self.available(self.read())
            self.assertEqual(calls, [])
            for name, module in identities.items():
                self.assertIs(sys.modules[name], module)

    def test_complete_scope_bytes_are_rechecked_after_the_last_git_context(self):
        self.prepare_publication(changes=True)
        self.available(self.read())
        markdown = self.fixture.paths[0]
        asset = self.case.assets[0]
        deleted = self.fixture.repo / self.case.deleted[0]
        for target in (markdown, asset, deleted):
            original = target.read_bytes() if target.exists() else None
            try:
                self.after_last_git = lambda target=target: target.write_bytes(b'Actual late scope drift\n')
                with self.subTest(path=target.name):
                    result = self.read(unchanged=False)
                    self.assertEqual(self.last_git_hits, [True])
                    self.assertEqual(len(self.normal_calls), 2)
                    self.assertTrue(all(row['returned'] for row in self.normal_calls))
                    self.assertLess(self.events.index('normal-2'), self.events.index('last-git-completed'))
                    self.failure(result, domain='local_io')
            finally:
                self.after_last_git = lambda: None
                if original is None:
                    target.unlink(missing_ok=True)
                else:
                    target.write_bytes(original)
        self.available(self.read())

    def test_late_non_markdown_scope_symlink_keeps_the_local_io_error_domain(self):
        self.prepare_publication(changes=True)
        self.available(self.read())
        asset = self.case.assets[0]
        self.assertNotEqual(asset.suffix, '.md')
        original = asset.read_bytes()
        outside = self.fixture.root / 'same-original-scope-asset-bytes'
        outside.write_bytes(original)

        def replace_after_context():
            asset.unlink()
            asset.symlink_to(outside)

        try:
            self.after_last_git = replace_after_context
            result = self.read(unchanged=False)
            self.assertEqual(self.last_git_hits, [True])
            self.assertEqual(len(self.normal_calls), 2)
            self.assertTrue(all(row['returned'] for row in self.normal_calls))
            self.assertLess(self.events.index('normal-2'), self.events.index('last-git-completed'))
            self.assertTrue(asset.is_symlink())
            self.assertEqual(asset.resolve(), outside)
            self.assertEqual(outside.read_bytes(), original)
            issue = self.failure(result, domain='local_io')
            self.assertEqual(issue, {'domain': 'local_io', 'code': 'stale',
                                     'reason': 'scope_files_changed'})
        finally:
            self.after_last_git = lambda: None
            asset.unlink(missing_ok=True)
            asset.write_bytes(original)
            outside.unlink(missing_ok=True)
            self.available(self.read())

    def test_receipt_generation_record_html_and_map_keep_the_last_physical_cas(self):
        self.prepare_publication()
        receipt = self.fixture.receipt()
        manifest = self.fixture.observation_root / receipt['renderObservation']['path']
        record = json.loads(manifest.read_bytes())
        files = [publisher.review_receipt_path(DATE), self.fixture.manifest_path, manifest,
                 manifest.parent / record['pages'][0]['html']['path'],
                 manifest.parent / record['pages'][0]['record']['path']]
        self.available(self.read())
        for path in files:
            original = path.read_bytes()
            try:
                self.after_last_git = lambda path=path, original=original: path.write_bytes(original + b'\n')
                with self.subTest(file=path.name):
                    result = self.read(unchanged=False)
                    self.assertEqual(self.last_git_hits, [True])
                    self.assertTrue(all(row['returned'] for row in self.normal_calls))
                    self.failure(result, domain='local_io')
            finally:
                self.after_last_git = lambda: None
                path.write_bytes(original)
        self.available(self.read())

    def test_the_real_second_normal_gate_rejects_source_drift(self):
        self.prepare_publication()
        source = next(self.fixture.source_root.rglob('source.txt'))
        original = source.read_bytes()
        try:
            with self.case.case.after_projection_feed(lambda: source.write_bytes(original + b' changed')) as hits:
                self.failure(self.read(unchanged=False), domain='normal')
            self.assertEqual(hits, [True])
            self.assertEqual(len(self.normal_calls), 2)
            self.assertTrue(self.normal_calls[0]['returned'])
            self.assertFalse(self.normal_calls[1]['returned'])
        finally:
            source.write_bytes(original)
        self.available(self.read())

    def test_second_context_exposes_config_and_physical_root_drift_after_normal2(self):
        self.prepare_publication()
        config = self.fixture.repo / '.git/config'
        original = config.read_bytes()
        changed = original.replace(b'publish@example.com', b'changed@example.com')
        self.assertNotEqual(changed, original)
        try:
            self.after_normal = lambda number: config.write_bytes(changed) if number == 2 else None
            self.failure(self.read(unchanged=False), domain='git')
            self.assertTrue(all(row['returned'] for row in self.normal_calls))
        finally:
            self.after_normal = lambda _number: None
            config.write_bytes(original)
        self.available(self.read())
        previous = self.fixture.repo.parent / 'old-root-container'

        def replace_root(number):
            if number != 2:
                return
            repo = self.fixture.repo
            repo.rename(previous)
            repo.mkdir()
            for child in previous.iterdir():
                shutil.move(str(child), str(repo / child.name))

        self.after_normal = replace_root
        self.failure(self.read(unchanged=False), domain='git')
        self.assertTrue(all(row['returned'] for row in self.normal_calls))
        self.after_normal = lambda _number: None
        self.available(self.read())

    def copied_owner(self):
        """Actual __file__/startup policy in temp; never patch owner globals."""
        directory = self.fixture.root / 'fixed-consumer-copy'
        directory.mkdir()
        scripts = Path(__file__).resolve().parents[2] / 'scripts'
        for name in ('daily_observed_projection.py', 'daily_html_projection.py',
                     'daily_hugo_capture.py', 'blog_entry_loader.py', 'runtime_guard.py',
                     'local_git_object.py', 'local_git_commit_delta.py', 'local_git_publication.py'):
            shutil.copyfile(scripts / name, directory / name)
        spec = importlib.util.spec_from_file_location('_normal_publication_test_owner',
                                                     directory / 'daily_observed_projection.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module, directory

    def test_fixed_source_copy_uses_its_real_file_and_rejects_inflight_git_bytes(self):
        self.prepare_publication()
        owner, directory = self.copied_owner()
        first = self.available(self.read(owner=owner))
        self.assertEqual(first['implementationBinding']['ownerObservation']['ownerSourceSha256'],
                         targets_fixture.sha((directory / 'daily_observed_projection.py').read_bytes()))
        capture = self.fixture.capture_module()
        real_read = capture.read_profile_file
        target = directory / 'local_git_publication.py'
        original = target.read_bytes()
        hits = []

        def reading(path, *args, **kwargs):
            raw = real_read(path, *args, **kwargs)
            if Path(path) == target and not hits:
                hits.append(True)
                target.write_bytes(original + b'\n# Actual temporary in-flight source drift.\n')
            return raw

        try:
            with mock.patch.object(capture, 'read_profile_file', side_effect=reading):
                self.failure(self.read(owner=owner, unchanged=False), domain='implementation')
            self.assertEqual(hits, [True])
        finally:
            target.write_bytes(original)
        self.available(self.read(owner=owner))

    def test_new_source_budget_is_exclusive_to_the_new_route(self):
        self.prepare_publication()
        owner, directory = self.copied_owner()
        self.available(self.read(owner=owner))
        target = directory / 'local_git_publication.py'
        target.write_bytes(b'#' + b'x' * (1024 * 1024))
        self.failure(self.read(owner=owner), domain='limits')
        self.assertFalse(any('symbolic-ref' in command for command in self.commands))
        self.case.target(self.read(owner=owner, kind='targets'))

    def test_imported_callable_shadowing_is_rejected_after_real_normal_admission(self):
        self.prepare_publication()
        owner, directory = self.copied_owner()
        self.available(self.read(owner=owner))
        raw = directory / 'local_git_object.py'
        raw.write_bytes(raw.read_bytes() + b'\nPath = str\n')
        issue = self.failure(self.read(owner=owner), 'unsupported', domain='implementation')
        self.assertEqual(issue['reason'], 'callable_profile')
        self.assertTrue(self.normal_calls and self.normal_calls[0]['returned'])
        self.assertFalse(any('symbolic-ref' in command for command in self.commands))
        self.case.target(self.read(owner=owner, kind='targets'))

    def test_new_api_has_only_a_fixed_selector_and_no_trusted_result_inputs(self):
        parameters = inspect.signature(self.owner().read_daily_local_publication).parameters
        self.assertEqual(tuple(parameters), ('date_str', 'include_id'))
        self.assertEqual(parameters['include_id'].kind, inspect.Parameter.KEYWORD_ONLY)
        for name in ('repo', 'receipt', 'targets', 'git', 'expected_files', 'source'):
            with self.subTest(name=name), self.assertRaises(TypeError):
                self.owner().read_daily_local_publication(DATE, **{name: {}})

    def test_invalid_selector_has_its_fixed_argument_reason_before_normal(self):
        for changes, reason in (({'date_str': 'not-a-date'}, 'date'),
                                ({'include_id': '../unsafe-id'}, 'include_id')):
            with self.subTest(reason=reason):
                issue = self.failure(self.read(**changes), domain='selection')
                self.assertEqual((issue['code'], issue['reason']), ('invalid_argument', reason))
                self.assertEqual(self.normal_calls, [])


if __name__ == '__main__':
    unittest.main()
