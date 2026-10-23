"""Actual normal/D1/temp-bare preparation plus offline deployment observations.

Composes existing factories, never collects their tests. A transport adapter only
in preparation executes real Git against temp-bare; no public deployment claim.
"""
import contextlib
import copy
import fcntl
import hashlib
import http.client
import importlib
import inspect
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_daily_local_publication as publication_fixture
from project_env_isolation import project_env_scope

DATE = publication_fixture.DATE
publisher = publication_fixture.publisher
ORIGIN = 'https://github.com/nanless/audio-paper-digest-blog.git'


class DailyDeploymentObservationIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.case = publication_fixture.DailyLocalPublicationIntegrationTest('runTest')
        self.addCleanup(self.case.doCleanups)
        self.case.setUp()
        self.fixture = self.case.fixture
        self.store_root = self.fixture.root / 'deployment-observations'
        self.preparation_commands = []
        self.transport_commands = []
        self.normal_calls = []
        self.events = []
        self.http_requests = []
        self.blog_depth = 0
        self.after_http = lambda _path: None
        self.include_id = None
        self.http_status = 200
        self.http_bodies = {}
        self.before_result_link = lambda: None
        self.normal_after = lambda _number: None
        self.fail_link_name = None
        self.link_failures = []

    def owner(self):
        return importlib.import_module('daily_observed_projection')

    def canonical(self, value):
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()

    def protected(self):
        return {key: value for key, value in self.case.case.case.inventory().items()
                if not key.startswith('deployment-observations/')}

    def http_fixture(self, commit):
        directory = Path(__file__).parent / 'fixtures/github-pages-metadata'
        data = {name: json.loads((directory / (name + '.json')).read_text()) for name in
                ('repository', 'workflows', 'runs', 'attempt', 'source', 'jobs', 'deployments', 'statuses', 'artifacts')}
        old = data['attempt']['head_sha']
        # These bodies are explicitly synthetic comparisons with this temp C.
        data = json.loads(json.dumps(data).replace(old, commit))
        root = '/repos/nanless/audio-paper-digest-blog'
        run, attempt, deploy = data['attempt']['id'], data['attempt']['run_attempt'], data['deployments'][0]['id']
        routes = {
            root: 'repository', root + '/actions/workflows?per_page=100&page=1': 'workflows',
            root + '/actions/workflows/262722446/runs?branch=main&per_page=100&page=1': 'runs',
            root + f'/actions/runs/{run}/attempts/{attempt}': 'attempt',
            root + '/contents/.github/workflows/hugo.yaml?ref=' + commit: 'source',
            root + f'/actions/runs/{run}/attempts/{attempt}/jobs?per_page=100&page=1': 'jobs',
            root + '/deployments?sha=' + commit + '&environment=github-pages&per_page=100&page=1': 'deployments',
            root + f'/deployments/{deploy}/statuses?per_page=100&page=1': 'statuses',
            root + f'/actions/runs/{run}/artifacts?per_page=100&page=1': 'artifacts',
        }
        self.http_bodies = {path: self.canonical(data[name]) for path, name in routes.items()}
        return data, routes

    @contextlib.contextmanager
    def observation_scope(self):
        import blog_entry_loader
        import path_config
        actual_load, actual_popen = blog_entry_loader.load_publish_to_blog, subprocess.Popen
        actual_flock, actual_close, actual_link = fcntl.flock, os.close, os.link
        forbidden, store_fds = [], set()
        self.normal_calls, self.events, self.http_requests = [], [], []

        def load():
            with project_env_scope():
                module = actual_load()
            for name, value in (
                    ('BLOG_REPO', str(self.fixture.repo)), ('CONTENT_DIR', str(self.fixture.posts)),
                    ('CURRENT_DIR', self.fixture.current), ('DAILY_FRESH_SOURCE_RUNS_DIR', self.fixture.source_root),
                    ('DAILY_RENDER_OBSERVATIONS_DIR', self.fixture.observation_root),
                    ('TAG_DISPLAY_POLICY_PATH', self.fixture.root / 'absent-policy.json')):
                setattr(module, name, value)
            normal, lock = module.load_verified_review_receipt, module.blog_publication_lock

            def gate(date):
                row = {'owner': module, 'scope': module._ACTIVE_PUBLICATION_INCLUDE_ID, 'returned': False}
                self.normal_calls.append(row)
                self.events.append('normal')
                value = normal(date)
                row['returned'] = True
                self.normal_after(len(self.normal_calls))
                return value

            @contextlib.contextmanager
            def held(date, **kwargs):
                self.assertEqual(self.blog_depth, 0, 'No reentrant shared blog lock')
                self.assertEqual(store_fds, set(), 'No store/blog double lock')
                self.events.append('blog-enter')
                with lock(date, **kwargs):
                    self.blog_depth += 1
                    try:
                        yield
                    finally:
                        self.blog_depth -= 1
                self.events.append('blog-exit')

            module.load_verified_review_receipt, module.blog_publication_lock = gate, held
            for name in ('git_push', '_remote_main_oid', '_remote_identity_sha256',
                         'validate_git_commit_against_review_receipt', 'save_review_receipt',
                         'save_generation_manifest', 'run_hugo_gate', 'call_publish_llm_api', '_llm_review_post_chunk'):
                def stop(*_args, _name=name, **_kwargs):
                    forbidden.append(_name)
                    raise AssertionError('Observed interval must not call ' + _name)
                setattr(module, name, stop)
            return module

        def popen(argv, *args, **kwargs):
            tokens = list(argv) if type(argv) in (list, tuple) else [str(argv)]
            if (set(tokens) & {'push', 'fetch', 'ls-remote', '--destination', '--contentDir'}
                    or Path(str(tokens[0])).name in {'curl', 'wget', 'gh'}):
                forbidden.append('subprocess')
                raise AssertionError('No transport/build in consumer')
            return actual_popen(argv, *args, **kwargs)

        def is_store_lock(fd):
            info = os.fstat(fd)
            if self.store_root.exists():
                for path in self.store_root.rglob('*'):
                    if path.name == 'store.lock' or path.name.startswith('.store.lock.'):
                        found = path.stat()
                        if (found.st_dev, found.st_ino) == (info.st_dev, info.st_ino):
                            return True
            return False

        def flock(fd, flags):
            result = actual_flock(fd, flags)
            if is_store_lock(fd):
                self.assertEqual(self.blog_depth, 0, 'No store/blog double lock')
                if flags & fcntl.LOCK_UN:
                    store_fds.discard(fd)
                else:
                    store_fds.add(fd)
            return result

        def close(fd):
            try:
                return actual_close(fd)
            finally:
                store_fds.discard(fd)

        def link(source, target, *args, **kwargs):
            if target == self.fail_link_name:
                descriptor = kwargs['dst_dir_fd']
                info = os.fstat(descriptor)
                directories = [self.store_root, *self.store_root.rglob('*')]
                self.assertTrue(any(path.is_dir() and (path.stat().st_dev, path.stat().st_ino) ==
                                    (info.st_dev, info.st_ino) for path in directories))
                self.link_failures.append(target)
                raise OSError('Finite dedicated observation directory link failure')
            if target == 'result.json':
                self.before_result_link()
            return actual_link(source, target, *args, **kwargs)

        case = self
        class Response:
            def __init__(self, path):
                self.status = case.http_status
                self.raw, self.used = case.http_bodies[path], 0
            def getheader(self, key, default=''):
                return {'Content-Type': 'application/json', 'Content-Encoding': 'identity'}.get(key, default)
            def read(self, size):
                raw = self.raw[self.used:self.used + size]
                self.used += len(raw)
                return raw
        class Connection:
            sock = None
            def __init__(self, host, port, **kwargs):
                case.assertEqual((host, port), ('api.github.com', 443))
            def request(self, method, path, **kwargs):
                case.assertEqual(method, 'GET')
                case.assertEqual(case.blog_depth, 0)
                case.assertEqual(store_fds, set())
                case.assertIn(path, case.http_bodies)
                intents = [(json.loads(item.read_bytes()), item.parent)
                           for item in case.store_root.rglob('intent.json')]
                case.assertTrue(intents, 'Intent must actually be present before HTTP')
                intent, attempt = max(intents, key=lambda item: item[0]['sequence'])
                binding = json.loads((attempt / 'binding.json').read_bytes())
                snapshot = (attempt / 'local-snapshot.json').read_bytes()
                case.assertEqual(binding['snapshot']['sha256'], hashlib.sha256(snapshot).hexdigest())
                case.assertEqual(binding['attemptId'], intent['attemptId'])
                case.http_requests.append(path)
                case.events.append('http')
                self.path = path
                case.after_http(path)
            def getresponse(self):
                return Response(self.path)
            def close(self):
                pass

        with mock.patch.object(blog_entry_loader, 'load_publish_to_blog', side_effect=load), \
                mock.patch.object(path_config, 'DAILY_DEPLOYMENT_OBSERVATIONS_DIR', self.store_root, create=True), \
                mock.patch.object(subprocess, 'Popen', side_effect=popen), \
                mock.patch.object(http.client, 'HTTPSConnection', Connection), \
                mock.patch.object(socket, 'socket', side_effect=AssertionError('No real Python network')), \
                mock.patch.object(fcntl, 'flock', side_effect=flock), \
                mock.patch.object(os, 'close', side_effect=close), \
                mock.patch.object(os, 'link', side_effect=link):
            yield
        self.assertEqual(forbidden, [])
        self.assertEqual(self.blog_depth, 0)
        self.assertEqual(store_fds, set())

    def observe(self, *, include_id=None, unchanged=True):
        before = self.protected()
        with self.observation_scope():
            outcome = self.owner().observe_daily_deployment(DATE, include_id=include_id)
            count = len(self.normal_calls)
            requests = list(self.http_requests)
            status = self.owner().read_daily_deployment_observation(DATE, include_id=include_id)
            self.assertEqual(len(self.normal_calls), count, 'Cold status never replays normal')
            self.assertEqual(self.http_requests, requests, 'Cold status never sends HTTP')
        if unchanged:
            self.assertEqual(self.protected(), before)
        return outcome, status

    def stored_result(self, outcome):
        selector = {'workflow': 'daily', 'date': DATE, 'includeId': self.include_id}
        key = hashlib.sha256(self.canonical(selector)).hexdigest()
        directory = self.store_root / key / 'attempts' / outcome['attemptId']
        raw = (directory / 'result.json').read_bytes()
        self.assertEqual(outcome['resultRef'], {'path': 'result.json',
            'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)})
        value = json.loads(raw)
        digest = value.pop('recordSha256')
        self.assertEqual(digest, hashlib.sha256(self.canonical(value)).hexdigest())
        value['recordSha256'] = digest
        return value, directory

    def recorded(self, outcome, status, *, state='metadata_observed', normals=4):
        self.assertEqual(outcome['contract'], 'daily-deployment-attempt-outcome-v1')
        self.assertEqual(outcome['recording'], 'recorded', (outcome, self.events))
        self.assertEqual(outcome['issues'], [])
        result, directory = self.stored_result(outcome)
        self.assertEqual(status['latestAttempt']['state'], state, (status, result, self.events))
        self.assertTrue(outcome['partial'])
        self.assertFalse(outcome['fullE05'])
        self.assertTrue(all(value is False for value in outcome['capabilities'].values()))
        self.assertEqual(result['status'], state)
        self.assertEqual(result['partial'], True)
        self.assertEqual(result['fullE05'], False)
        self.assertEqual(len(self.normal_calls), normals, self.events)
        if normals == 4:
            self.assertTrue(all(row['returned'] for row in self.normal_calls))
            self.assertIs(self.normal_calls[0]['owner'], self.normal_calls[1]['owner'])
            self.assertIs(self.normal_calls[2]['owner'], self.normal_calls[3]['owner'])
            self.assertIsNot(self.normal_calls[0]['owner'], self.normal_calls[2]['owner'])
            self.assertTrue(all(row['scope'] == self.include_id for row in self.normal_calls))
            self.assertEqual(self.events.count('blog-enter'), 2)
            self.assertEqual(self.events.count('blog-exit'), 2)
            start, finish = self.events.index('http'), len(self.events) - 1 - self.events[::-1].index('http')
            self.assertEqual(self.events[:start].count('normal'), 2)
            self.assertEqual(self.events[finish + 1:].count('normal'), 2)
        return result, directory

    def prepare(self, *, changes=False, include_id=None, publish=True):
        self.include_id = include_id
        self.case.include_id = include_id
        git = publication_fixture.targets_fixture.observed_fixture.normal_fixture.git
        git(self.fixture.repo, 'remote', 'set-url', 'origin', ORIGIN)
        if changes:
            self.assertIsNone(include_id)
            self.case.case.prepare_changes()
        else:
            self.case.case.case.prepare(include_id=include_id)
        if not publish:
            return self.case.receipt()
        runner = publisher._run_bounded_subprocess
        bare = str(self.fixture.remote.resolve())

        def prepared_runner(command, **kwargs):
            command = list(command)
            self.preparation_commands.append(tuple(command))
            target = list(command)
            if command == ['git', 'push', 'origin', 'HEAD:main']:
                target[2] = bare
                self.transport_commands.append((tuple(command), tuple(target)))
            elif command == ['git', 'ls-remote', '--exit-code', 'origin', 'refs/heads/main']:
                target[3] = bare
                self.transport_commands.append((tuple(command), tuple(target)))
            elif command[0] == 'git' and set(command) & {'push', 'fetch', 'ls-remote'}:
                raise AssertionError('Unexpected preparation transport argv')
            return runner(target, **kwargs)

        with publisher.publication_scope(include_id), publisher.blog_publication_lock(DATE), \
                mock.patch.object(publisher, '_run_bounded_subprocess', side_effect=prepared_runner), \
                mock.patch.object(socket, 'socket', side_effect=AssertionError('No public network')), \
                contextlib.redirect_stdout(io.StringIO()):
            paths, _receipt_path = publisher.load_verified_review_receipt(DATE)
            self.assertTrue(publisher.git_push(DATE, paths))
        receipt = self.case.receipt()
        self.assertEqual(receipt['publicationCommit'], receipt['remoteVerifiedOid'])
        self.assertEqual(receipt['remoteName'], 'origin')
        expected_hash = hashlib.sha256(json.dumps({'remote': 'origin', 'pushUrl': ORIGIN},
            ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        self.assertEqual(receipt['remoteIdentitySha256'], expected_hash)
        self.assertEqual(git(self.fixture.repo, 'remote', 'get-url', '--push', 'origin').stdout.strip(), ORIGIN)
        self.assertEqual(git(self.fixture.remote, 'rev-parse', 'refs/heads/main').stdout.strip(), receipt['publicationCommit'])
        self.assertEqual(git(self.fixture.repo, 'rev-parse', 'HEAD^').stdout.strip(), receipt['baseHead'])
        self.assertEqual(sum(command[0][1] == 'push' for command in self.transport_commands), 1)
        self.assertEqual(sum(command[0][1] == 'ls-remote' for command in self.transport_commands), 1)
        return receipt

    def test_original_normal_and_actual_writer_precede_new_deployment_apis(self):
        receipt = self.prepare()
        publisher.load_verified_review_receipt(DATE)
        targets = self.case.case.target(self.case.case.read())
        self.assertEqual(len(targets['primaryPages']), 2)
        self.case.available(self.case.read())
        self.assertEqual(receipt['publicationCommit'], self.case.receipt()['publicationCommit'])
        owner = self.owner()
        missing = [name for name in ('observe_daily_deployment', 'read_daily_deployment_observation')
                   if not callable(getattr(owner, name, None))]
        self.assertEqual(missing, [], 'Actual normal/D1/C/full targets positive reached before missing new APIs')
        for name in ('observe_daily_deployment', 'read_daily_deployment_observation'):
            self.assertEqual(str(inspect.signature(getattr(owner, name))), '(date_str, *, include_id=None)')
        self.http_fixture(receipt['publicationCommit'])
        outcome, status = self.observe()
        result, directory = self.recorded(outcome, status)
        self.assertTrue(result['bindingVerified'])
        self.assertEqual(result['metadata']['requestedCommit'], receipt['publicationCommit'])
        self.assertEqual(result['metadata']['status'], 'metadata_observed')
        self.assertGreater(len(self.http_requests), 0)
        snapshot = json.loads((directory / 'local-snapshot.json').read_bytes())
        binding = json.loads((directory / 'binding.json').read_bytes())
        self.assertEqual(snapshot['publicationBinding']['commitOid'], receipt['publicationCommit'])
        self.assertEqual(binding['normalBinding'], snapshot['normalBinding'])
        self.assertEqual(binding['snapshot']['sha256'], hashlib.sha256((directory / 'local-snapshot.json').read_bytes()).hexdigest())
        self.assertEqual(status['lastObserved']['id'], outcome['attemptId'])
        for field in ('artifactContent', 'productionArtifact', 'publicPages', 'publicAssets', 'remoteNow',
                      'currentEligibility', 'sourceRecoveryEligibility', 'browserExecution', 'finalAcceptance'):
            self.assertEqual(result['coverage'][field], 'not_checked')

    def test_single_selector_uses_its_own_normal_scope_and_store_namespace(self):
        paper_id = '2609.12341'
        receipt = self.prepare(include_id=paper_id)
        self.http_fixture(receipt['publicationCommit'])
        outcome, status = self.observe(include_id=paper_id)
        result, directory = self.recorded(outcome, status)
        self.assertEqual(result['selector']['includeId'], paper_id)
        snapshot = json.loads((directory / 'local-snapshot.json').read_bytes())
        self.assertEqual(len(snapshot['reviewedTargets']['primaryPages']), 1)
        self.assertEqual(snapshot['normalBinding']['publicationScope'], {'mode': 'single-paper', 'includeId': paper_id})
        with self.observation_scope():
            batch = self.owner().read_daily_deployment_observation(DATE)
        self.assertEqual(batch['status'], 'not_recorded')

    def test_full_reviewed_assets_and_true_tombstones_bind_the_real_commit(self):
        receipt = self.prepare(changes=True)
        self.http_fixture(receipt['publicationCommit'])
        outcome, status = self.observe()
        _result, directory = self.recorded(outcome, status)
        snapshot = json.loads((directory / 'local-snapshot.json').read_bytes())
        target = snapshot['reviewedTargets']
        rows = sorted(({key: item[key] for key in ('path', 'deleted', 'sha256')}
                       for item in receipt['files']), key=lambda item: item['path'].encode())
        self.assertEqual(target['reviewedFileCount'], len(rows))
        self.assertEqual(target['reviewedFileSetSha256'], hashlib.sha256(self.canonical(rows)).hexdigest())
        self.assertEqual(target['changes']['deletedPaths'], self.case.case.deleted)
        self.assertTrue(any(not row['path'].endswith('.md') for row in rows))

    def test_initial_bad_normal_receipt_records_failure_without_http(self):
        self.prepare()
        receipt = self.case.receipt()
        receipt['strictReview'] = False
        self.case.receipt_path().write_text(json.dumps(receipt))
        outcome, status = self.observe()
        result, _directory = self.recorded(outcome, status, state='blocked', normals=1)
        self.assertFalse(self.normal_calls[0]['returned'])
        self.assertEqual(self.http_requests, [])
        self.assertFalse(result['bindingVerified'])
        self.assertIsNone(result['metadata'])
        self.assertIsNone(status['lastObserved'])
        self.assertEqual(result['issues'], [{'domain': 'normal', 'code': 'normal_rejected', 'reason': 'initial'}])

    def test_no_ref_is_not_reconstructed_and_never_sends_http(self):
        self.prepare()
        receipt = self.case.receipt()
        receipt.pop('renderObservation')
        self.case.receipt_path().write_text(json.dumps(receipt))
        outcome, status = self.observe()
        result, _directory = self.recorded(outcome, status, state='blocked', normals=1)
        self.assertTrue(self.normal_calls[0]['returned'])
        self.assertEqual(self.http_requests, [])
        self.assertFalse(result['bindingVerified'])
        self.assertEqual(result['issues'], [{'domain': 'normal', 'code': 'not_recorded', 'reason': 'render_not_recorded'}])

    def test_genuinely_unpublished_normal_scope_never_queries_deployment(self):
        receipt = self.prepare(publish=False)
        self.assertNotIn('publicationCommit', receipt)
        outcome, status = self.observe()
        result, _directory = self.recorded(outcome, status, state='blocked', normals=2)
        self.assertTrue(all(row['returned'] for row in self.normal_calls))
        self.assertEqual(self.http_requests, [])
        self.assertFalse(result['bindingVerified'])
        self.assertEqual(result['issues'], [{'domain': 'publication', 'code': 'not_published', 'reason': 'publication_fields_absent'}])

    def test_latest_failed_metadata_keeps_older_success_historical(self):
        receipt = self.prepare()
        _data, routes = self.http_fixture(receipt['publicationCommit'])
        first, status = self.observe()
        self.recorded(first, status)
        path = next(path for path, name in routes.items() if name == 'statuses')
        payload = json.loads(self.http_bodies[path])
        payload[0]['state'] = 'failure'
        self.http_bodies[path] = self.canonical(payload)
        second, status = self.observe()
        result, _directory = self.recorded(second, status, state='failed')
        self.assertTrue(result['bindingVerified'])
        self.assertEqual(result['metadata']['status'], 'failed')
        self.assertEqual(result['issues'], [{'domain': 'metadata', 'code': 'failed', 'reason': 'metadata_failure'}])
        self.assertEqual(status['lastObserved']['id'], first['attemptId'])
        self.assertEqual(status['latestAttempt']['id'], second['attemptId'])

    def test_http_error_still_rechecks_normal_but_never_promotes_partial_metadata(self):
        receipt = self.prepare()
        self.http_fixture(receipt['publicationCommit'])
        self.http_status = 403
        outcome, status = self.observe()
        result, _directory = self.recorded(outcome, status, state='unavailable')
        self.assertEqual(len(self.http_requests), 1)
        self.assertTrue(result['bindingVerified'])
        self.assertEqual(result['metadata']['status'], 'unknown')
        self.assertIsNone(status['lastObserved'])
        self.assertEqual(result['issues'], [{'domain': 'metadata', 'code': 'unavailable', 'reason': 'metadata_unknown'}])
        self.assertEqual(result['metadata']['issues'], [{'domain': 'network', 'code': 'unavailable', 'reason': 'http_status'}])

    def test_http_receipt_bytes_drift_reaches_four_real_normal_gates_then_stales_binding(self):
        receipt = self.prepare()
        self.http_fixture(receipt['publicationCommit'])
        path = self.case.receipt_path()
        original = path.read_bytes()
        changed = []
        def drift(_path):
            if not changed:
                path.write_bytes(original + b'\n')
                changed.append(True)
        self.after_http = drift
        try:
            outcome, status = self.observe(unchanged=False)
            result, _directory = self.recorded(outcome, status, state='stale')
            self.assertEqual(changed, [True])
            self.assertFalse(result['bindingVerified'])
            self.assertEqual(result['metadata']['status'], 'metadata_observed')
            self.assertIsNone(status['lastObserved'])
            self.assertEqual(result['issues'], [{'domain': 'binding', 'code': 'stale', 'reason': 'inputs_changed'}])
        finally:
            path.write_bytes(original)

    def test_http_asset_change_is_rejected_by_actual_final_normal(self):
        receipt = self.prepare(changes=True)
        self.http_fixture(receipt['publicationCommit'])
        path = self.case.case.assets[0]
        original = path.read_bytes()
        changed = []
        def drift(_path):
            if not changed:
                path.write_bytes(original + b'\n')
                changed.append(True)
        self.after_http = drift
        try:
            outcome, status = self.observe(unchanged=False)
            result, _directory = self.recorded(outcome, status, state='blocked', normals=3)
            self.assertEqual(changed, [True])
            self.assertTrue(all(row['returned'] for row in self.normal_calls[:2]))
            self.assertFalse(self.normal_calls[-1]['returned'])
            self.assertFalse(result['bindingVerified'])
            self.assertEqual(result['metadata']['status'], 'metadata_observed')
            self.assertEqual(result['issues'], [{'domain': 'normal', 'code': 'normal_rejected', 'reason': 'final'}])
        finally:
            path.write_bytes(original)

    def test_result_storage_failure_preserves_pending_without_claiming_recorded_success(self):
        receipt = self.prepare()
        self.http_fixture(receipt['publicationCommit'])
        hits = []
        def fail_result():
            hits.append(True)
            raise OSError('synthetic finite result write failure')
        self.before_result_link = fail_result
        outcome, status = self.observe()
        self.assertEqual(hits, [True])
        self.assertNotEqual(outcome['recording'], 'recorded')
        self.assertIsNone(outcome['resultRef'])
        self.assertEqual(status['latestAttempt']['state'], 'pending_unresolved')
        self.assertIsNone(status['lastObserved'])
        self.assertEqual(len(self.normal_calls), 4)
        self.assertGreater(len(self.http_requests), 0)

    def test_cold_absence_is_read_only_without_normal_or_http(self):
        before = self.protected()
        with self.observation_scope():
            status = self.owner().read_daily_deployment_observation(DATE)
        self.assertEqual(status['status'], 'not_recorded')
        self.assertEqual(self.normal_calls, [])
        self.assertEqual(self.http_requests, [])
        self.assertFalse(self.store_root.exists())
        self.assertEqual(self.protected(), before)

    def test_intent_and_binding_actual_link_failures_stop_before_http(self):
        receipt = self.prepare()
        self.http_fixture(receipt['publicationCommit'])
        for name in ('intent.json', 'binding.json'):
            with self.subTest(stage=name):
                self.fail_link_name, self.link_failures = name, []
                outcome, status = self.observe()
                self.assertEqual(self.link_failures, [name])
                self.assertNotEqual(outcome['recording'], 'recorded')
                self.assertIsNone(outcome['resultRef'])
                self.assertEqual(self.http_requests, [])
                self.assertIsNone(status['lastObserved'])
                if name == 'intent.json':
                    self.assertEqual(self.normal_calls, [])
                    self.assertIsNone(status['latestAttempt'])
                else:
                    self.assertEqual(len(self.normal_calls), 2)
                    self.assertTrue(all(row['returned'] for row in self.normal_calls))
                    self.assertEqual(status['latestAttempt']['state'], 'pending_unresolved')
                    self.assertEqual(outcome['recording'], 'partially_saved')

    def test_actual_http_control_objects_survive_and_all_locks_are_released(self):
        receipt = self.prepare()
        self.http_fixture(receipt['publicationCommit'])
        for control in (KeyboardInterrupt(), SystemExit(73)):
            with self.subTest(control=type(control).__name__):
                def interrupt(_path):
                    raise control
                self.after_http = interrupt
                before = self.protected()
                with self.observation_scope():
                    with self.assertRaises(type(control)) as caught:
                        self.owner().observe_daily_deployment(DATE)
                    self.assertIs(caught.exception, control)
                    requests = list(self.http_requests)
                    status = self.owner().read_daily_deployment_observation(DATE)
                    self.assertEqual(self.http_requests, requests)
                self.assertEqual(len(self.http_requests), 1)
                self.assertEqual(len(self.normal_calls), 2)
                self.assertTrue(all(row['returned'] for row in self.normal_calls))
                self.assertEqual(status['latestAttempt']['state'], 'interrupted')
                self.assertIsNone(status['lastObserved'])
                selector = {'workflow': 'daily', 'date': DATE, 'includeId': None}
                key = hashlib.sha256(self.canonical(selector)).hexdigest()
                result = json.loads((self.store_root / key / 'attempts' / status['latestAttempt']['id'] / 'result.json').read_bytes())
                self.assertEqual(result['issues'], [{'domain': 'operation', 'code': 'interrupted', 'reason': 'control_exception'}])
                self.assertEqual(self.protected(), before)

    def test_invalid_selectors_have_fixed_issues_without_store_or_http(self):
        before = self.protected()
        for date, include, reason in (('not-a-date', None, 'date'), (DATE, '../unsafe-id', 'include_id')):
            with self.subTest(reason=reason), self.observation_scope():
                outcome = self.owner().observe_daily_deployment(date, include_id=include)
                self.assertEqual(outcome['issues'], [{'domain': 'selection', 'code': 'invalid_argument', 'reason': reason}])
                self.assertEqual(outcome['recording'], 'not_saved')
                self.assertEqual(self.normal_calls, [])
                self.assertEqual(self.http_requests, [])
                self.assertFalse(self.store_root.exists())
        self.assertEqual(self.protected(), before)
