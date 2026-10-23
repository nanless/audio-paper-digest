"""Mechanical local records only; no normal, Source, GitHub or publication proof."""
import copy
import hashlib
import importlib
import json
import os
import signal
import select
import subprocess
import threading
import time
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))


class DailyDeploymentStoreTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='deployment-store-')
        self.addCleanup(self.temp.cleanup)
        self.root = str((Path(self.temp.name).resolve() / 'observations'))
        self.selector = {'workflow': 'daily', 'date': '2026-09-07', 'includeId': None}

    def leaf(self):
        return importlib.import_module('daily_deployment_store')

    def test_real_temporary_store_reservation_precedes_any_network(self):
        self.assertTrue(Path(self.temp.name).is_dir())
        self.assertFalse(Path(self.root).exists())
        intent, handle = self.leaf().reserve(self.root, self.selector)
        self.assertEqual(intent['sequence'], 1)
        self.assertEqual(intent['selector'], self.selector)
        self.assertIsNotNone(handle)
        self.assertEqual(self.leaf().read_status(self.root, self.selector)['latestAttempt']['state'],
                         'pending_unresolved')


    def canonical(self, value):
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()

    def hashed(self, value, field):
        return dict(value, **{field: hashlib.sha256(self.canonical(value)).hexdigest()})

    def directory(self, intent):
        key = hashlib.sha256(self.canonical(self.selector)).hexdigest()
        return Path(self.root) / key / 'attempts' / intent['attemptId']

    def metadata(self, commit):
        # Schema-complete declarations only: no HTTP/Git/normal proof is claimed.
        sha = 'a' * 64
        policy = {'repositoryId': 1214235086, 'fullName': 'nanless/audio-paper-digest-blog',
            'workflowId': 262722446, 'workflowPath': '.github/workflows/hugo.yaml', 'branch': 'main',
            'environment': 'github-pages', 'profile': 'fixed-hugo-workflow-v1',
            'workflowSourceSha256': 'cbf3a52e317973a4273f5c64c0a8d4e1c5dda2ee709f0e4ad12863c78cc5fe0d'}
        repo = {'id': 1214235086, 'fullName': 'nanless/audio-paper-digest-blog'}
        when = '2026-09-07T00:00:00+00:00'
        jobs = []
        definitions = [('unit', [(5, 'Unit checks')]),
            ('build', [(6, 'Build and verify'), (7, 'Upload artifact')]),
            ('deploy', [(2, 'Deploy to GitHub Pages')])]
        for number, (role, steps) in enumerate(definitions):
            jobs.append({'role': role, 'id': number + 10, 'runId': 1, 'runAttempt': 1,
                'headSha': commit, 'branch': 'main', 'status': 'completed', 'conclusion': 'success',
                'startedAt': when, 'completedAt': when,
                'requiredSteps': [{'number': step, 'name': name, 'status': 'completed',
                                   'conclusion': 'success'} for step, name in steps]})
        coverage = dict.fromkeys(('repository', 'workflow', 'attempt', 'jobs', 'deploymentJob'), 'verified')
        coverage.update(pagination='complete')
        coverage.update(dict.fromkeys(('artifactLineage', 'productionInputs', 'web', 'assets',
                                       'remoteNow', 'currentEligibility'), 'not_checked'))
        return self.hashed({'contract': 'github-pages-metadata-observation-v1', 'version': 1,
            'status': 'metadata_observed', 'metadataOutcome': 'success', 'partial': True, 'fullE05': False,
            'requestedCommit': commit, 'policy': policy,
            'selection': {'runId': 1, 'runNumber': 1, 'runAttempt': 1, 'headSha': commit, 'branch': 'main',
                'event': 'push', 'status': 'completed', 'conclusion': 'success',
                'repository': repo, 'headRepository': dict(repo)},
            'workflowSource': {'path': policy['workflowPath'], 'commit': commit, 'gitBlobOid': 'b' * 40,
                'bytes': 2242, 'sha256': policy['workflowSourceSha256'], 'profileMatched': True},
            'jobs': jobs, 'deployment': {'id': 1, 'sha': commit, 'ref': 'main', 'environment': 'github-pages',
                'originalEnvironment': 'github-pages', 'task': 'deploy', 'productionEnvironment': False,
                'transientEnvironment': False, 'createdAt': when,
                'latestStatus': {'id': 1, 'state': 'success', 'createdAt': when, 'environment': 'github-pages',
                                'runId': 1, 'jobId': 12, 'environmentUrlSha256': sha}, 'exactJobMatched': True},
            'artifacts': {'listing': 'observed_empty', 'totalCount': 0, 'content': 'not_checked',
                          'attemptBinding': 'not_checked', 'consumedByDeploy': 'not_checked'},
            'requests': [{'ordinal': 1, 'route': 'repository', 'page': None, 'httpStatus': 200,
                          'bytes': 1, 'sha256': sha, 'outcome': 'received'}],
            'coverage': coverage, 'issues': [], 'capabilities': self.caps()}, 'metadataSha256')

    def caps(self):
        return {'canPublish': False, 'canResumeAnalysis': False, 'canGrantSource': False, 'canExecuteBrowser': False}

    def implementation(self):
        execution = {'contract': 'daily-deployment-private-execution-v1', 'version': 1,
            'modules': [{'file': name, 'sourceSha256': 'a' * 64, 'codeAndPolicySha256': 'b' * 64}
                        for name in ('github_pages_deployment.py', 'daily_deployment_store.py')],
            'compiler': {'dontInherit': True, 'optimize': 0, 'dependencyMapping': []},
            'objectBinding': 'actual_objects_before_after', 'fullExecutionClosure': 'not_established'}
        return {'contract': 'daily-deployment-implementation-observation-v1', 'version': 1,
            'ownerObservationSha256': 'a' * 64, 'runtimeSha256': 'a' * 64,
            'executionBinding': execution, 'executionBindingSha256': hashlib.sha256(self.canonical(execution)).hexdigest(),
            'fullExecutionClosure': 'not_established'}

    def bind_data(self, intent, handle):
        # Full schema does not make these invented bytes scientific or published facts.
        sha = 'a' * 64
        normal = {'date': self.selector['date'], 'publicationMode': 'legacy_v5_maintenance',
            'publicationScope': None, 'generationManifestSha256': sha, 'receiptSha256': sha,
            'reviewBaseHead': 'a' * 40, 'reviewProtocolFingerprint': sha,
            'reviewedAt': '2026-09-07T00:00:00+00:00'}
        publication = {'baseOid': 'a' * 40, 'commitOid': 'b' * 40, 'headOid': 'b' * 40,
            'branch': 'refs/heads/main', 'recordedRemote': {'name': 'origin', 'oid': 'b' * 40,
                'verifiedAt': normal['reviewedAt']}, 'localRemoteConfigurationMatch': 'verified'}
        ref = {'contract': 'daily-render-observation-ref-v1', 'path': '2026-09-07/mechanical/manifest.json', 'sha256': sha}
        profile = {'contract': 'daily-static-html-projection-v2', 'fingerprint': sha}
        target = {'contract': 'daily-reviewed-primary-targets-v2', 'version': 2, 'status': 'reviewed_targets_observed',
            'selector': self.selector, 'normalBinding': normal, 'observationRef': ref, 'profile': profile,
            'implementationObservation': {}, 'primaryPages': [], 'reviewedSitePolicy': {},
            'reviewedFileSetSha256': sha, 'reviewedFileCount': 1, 'primarySourceSetSha256': sha,
            'changes': {'deletedPaths': [], 'deletedPathSetSha256': hashlib.sha256(b'[]').hexdigest(),
                        'deletedUrls': None, 'deletionUrlCoverage': 'not_recorded', 'aliasCoverage': 'not_checked'},
            'inputBinding': 'observed_before_after', 'fullInputSnapshot': 'not_established',
            'observationCoverage': {}, 'coverage': {},
            'unknownInputs': ['MECHANICAL DATA ONLY; NO NORMAL OR SOURCE QUALIFICATION']}
        keys = ('contract', 'version', 'selector', 'reviewedSitePolicy', 'reviewedFileSetSha256',
                'reviewedFileCount', 'primarySourceSetSha256', 'primaryPages', 'changes', 'profile', 'coverage')
        target['targetsSha256'] = hashlib.sha256(self.canonical({key: target[key] for key in keys})).hexdigest()
        target = self.hashed(target, 'recordSha256')
        git = {'contract': 'local-git-publication-observation-v1', 'version': 1,
            'context1ObservationSha256': sha, 'context2ObservationSha256': sha,
            'refPhysicalIdentitySha256': sha, 'deltaObservationSha256': sha, 'reviewedFileSetSha256': sha,
            'reviewedFileFactsSha256': sha, 'scopeFileCount': 1, 'coverage': {}}
        snapshot = self.hashed({'contract': 'daily-local-publication-observation-v1', 'version': 1,
            'status': 'local_publication_observed', 'selector': self.selector, 'normalBinding': normal,
            'reviewedTargets': target, 'publicationBinding': publication, 'gitBinding': git,
            'implementationBinding': {}, 'inputBinding': 'observed_before_after',
            'fullInputSnapshot': 'not_established', 'observationCoverage': {}, 'coverage': {},
            'unknownInputs': ['MECHANICAL DATA ONLY'], 'capabilities': self.caps()}, 'recordSha256')
        raw = self.canonical(snapshot)
        target_binding = {key: target[key] for key in ('contract', 'version', 'targetsSha256', 'recordSha256',
            'reviewedFileSetSha256', 'reviewedFileCount', 'primarySourceSetSha256', 'observationRef', 'profile')}
        local = {'contextObservationSha256': sha, 'refPhysicalIdentitySha256': sha,
            'deltaObservationSha256': sha, 'reviewedFileSetSha256': sha, 'reviewedFileFactsSha256': sha,
            'implementationBindingSha256': hashlib.sha256(self.canonical(snapshot['implementationBinding'])).hexdigest()}
        repository = {'repositoryId': 1214235086, 'fullName': 'nanless/audio-paper-digest-blog',
            'workflowId': 262722446, 'workflowPath': '.github/workflows/hugo.yaml', 'branch': 'main',
            'environment': 'github-pages', 'policySha256': sha, 'localRepositoryMapping': 'verified'}
        binding = self.hashed({'contract': 'daily-deployment-input-binding-v1', 'version': 1,
            'attemptId': intent['attemptId'], 'sequence': intent['sequence'], 'selector': self.selector,
            'normalBinding': normal, 'publicationBinding': publication, 'targetBinding': target_binding,
            'localBinding': local, 'repositoryPolicy': repository,
            'snapshot': {'path': 'local-snapshot.json', 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}},
            'bindingSha256')
        self.leaf().bind(handle, binding, snapshot)
        return binding

    def terminal(self, intent, binding=None, *, state='blocked'):
        success = state == 'metadata_observed'
        coverage = dict.fromkeys(('artifactContent', 'productionArtifact', 'publicPages', 'publicAssets',
            'remoteNow', 'currentEligibility', 'sourceRecoveryEligibility', 'browserExecution', 'finalAcceptance'), 'not_checked')
        coverage.update(localPublication='observed_before_after' if binding else 'not_verified',
                        deploymentMetadata='observed' if success else 'not_available')
        return self.hashed({'contract': 'daily-deployment-metadata-observation-v1', 'version': 1,
            'attemptId': intent['attemptId'], 'sequence': intent['sequence'], 'selector': self.selector,
            'intentSha256': intent['intentSha256'],
            'bindingSha256': binding['bindingSha256'] if binding is not None else None,
            'startedAt': intent['requestedAt'], 'finishedAt': intent['requestedAt'], 'status': state,
            'bindingVerified': binding is not None,
            'metadata': self.metadata(binding['publicationBinding']['commitOid']) if success else None,
            'partial': True, 'fullE05': False, 'implementationObservation': self.implementation() if success else None,
            'coverage': coverage, 'issues': [] if success else [{'domain': 'normal', 'code': 'normal_rejected', 'reason': 'initial'}],
            'capabilities': self.caps()}, 'recordSha256')

    def inventory(self):
        out = {}
        if Path(self.root).exists():
            for path in Path(self.root).rglob('*'):
                if path.is_file() and not path.is_symlink():
                    out[str(path.relative_to(self.root))] = path.read_bytes()
        return out

    def test_mechanical_binding_and_terminal_roundtrip_never_grant_capabilities(self):
        leaf = self.leaf()
        intent, handle = leaf.reserve(self.root, self.selector)
        binding = self.bind_data(intent, handle)
        result = self.terminal(intent, binding, state='metadata_observed')
        outcome = leaf.finish(handle, result)
        self.assertEqual(outcome['recording'], 'recorded')
        self.assertEqual(outcome['resultRef']['sha256'], hashlib.sha256(self.canonical(result)).hexdigest())
        self.assertEqual((self.directory(intent) / 'result.json').read_bytes(), self.canonical(result))
        before = self.inventory()
        status = leaf.read_status(self.root, self.selector)
        self.assertEqual(status['latestAttempt']['state'], 'metadata_observed')
        self.assertEqual(status['lastObserved']['id'], intent['attemptId'])
        self.assertTrue(status['partial'])
        self.assertFalse(status['fullE05'])
        self.assertTrue(all(value is False for value in status['capabilities'].values()))
        self.assertEqual(self.inventory(), before)

    def test_older_late_success_never_hides_new_pending_or_failed(self):
        leaf = self.leaf()
        old, old_handle = leaf.reserve(self.root, self.selector)
        binding = self.bind_data(old, old_handle)
        new, new_handle = leaf.reserve(self.root, self.selector)
        leaf.finish(old_handle, self.terminal(old, binding, state='metadata_observed'))
        status = leaf.read_status(self.root, self.selector)
        self.assertEqual(status['latestAttempt']['id'], new['attemptId'])
        self.assertEqual(status['latestAttempt']['state'], 'pending_unresolved')
        self.assertEqual(status['lastObserved']['id'], old['attemptId'])
        leaf.finish(new_handle, self.terminal(new, state='failed'))
        status = leaf.read_status(self.root, self.selector)
        self.assertEqual(status['latestAttempt']['state'], 'failed')
        self.assertEqual(status['lastObserved']['id'], old['attemptId'])

    def test_batch_and_single_namespaces_are_separate(self):
        leaf = self.leaf()
        batch, _batch_handle = leaf.reserve(self.root, self.selector)
        single = dict(self.selector, includeId='2301.00001')
        other, _other_handle = leaf.reserve(self.root, single)
        self.assertEqual((batch['sequence'], other['sequence']), (1, 1))
        self.assertNotEqual(batch['attemptId'], other['attemptId'])
        self.assertEqual(leaf.read_status(self.root, self.selector)['latestAttempt']['id'], batch['attemptId'])
        self.assertEqual(leaf.read_status(self.root, single)['latestAttempt']['id'], other['attemptId'])

    def test_exact_result_is_idempotent_but_conflicting_result_never_overwrites(self):
        leaf = self.leaf()
        intent, handle = leaf.reserve(self.root, self.selector)
        result = self.terminal(intent)
        leaf.finish(handle, result)
        original = (self.directory(intent) / 'result.json').read_bytes()
        self.assertEqual(leaf.finish(handle, result)['recording'], 'recorded')
        different = self.terminal(intent, state='failed')
        with self.assertRaises(leaf.DeploymentStoreError) as caught:
            leaf.finish(handle, different)
        self.assertEqual((caught.exception.code, caught.exception.reason), ('conflict', 'record_exists'))
        self.assertEqual((self.directory(intent) / 'result.json').read_bytes(), original)
        with self.assertRaises(leaf.DeploymentStoreError):
            leaf.bind(handle, {}, {})
        with self.assertRaises(leaf.DeploymentStoreError):
            copy.copy(handle)
        with self.assertRaises(leaf.DeploymentStoreError):
            copy.deepcopy(handle)

    def test_counter_gap_and_orphan_pre_intent_directory_are_not_an_attempt(self):
        leaf = self.leaf()
        actual = leaf._publish
        def stop(fd, name, raw, **kwargs):
            if name == 'intent.json':
                raise leaf.DeploymentStoreError('unavailable', 'write_failed')
            return actual(fd, name, raw, **kwargs)
        with mock.patch.object(leaf, '_publish', side_effect=stop):
            with self.assertRaises(leaf.DeploymentStoreError):
                leaf.reserve(self.root, self.selector)
        self.assertEqual(leaf.read_status(self.root, self.selector)['status'], 'not_recorded')
        intent, _handle = leaf.reserve(self.root, self.selector)
        self.assertEqual(intent['sequence'], 2)

    def test_durable_intent_with_failed_index_is_visible_without_read_repair(self):
        leaf = self.leaf()
        actual = leaf._publish
        def stop(fd, name, raw, **kwargs):
            if name == 'index.json':
                raise leaf.DeploymentStoreError('unavailable', 'write_failed')
            return actual(fd, name, raw, **kwargs)
        with mock.patch.object(leaf, '_publish', side_effect=stop):
            with self.assertRaises(leaf.DeploymentStoreError) as caught:
                leaf.reserve(self.root, self.selector)
        self.assertEqual(caught.exception.recording, 'partially_saved')
        before = self.inventory()
        status = leaf.read_status(self.root, self.selector)
        self.assertEqual(status['latestAttempt']['state'], 'pending_unresolved')
        self.assertFalse(status['indexConsistent'])
        self.assertEqual(self.inventory(), before)

    def test_durable_result_with_failed_index_remains_cold_visible_and_retryable(self):
        leaf = self.leaf()
        intent, handle = leaf.reserve(self.root, self.selector)
        actual = leaf._publish
        def stop(fd, name, raw, **kwargs):
            if name == 'index.json':
                raise leaf.DeploymentStoreError('unavailable', 'write_failed')
            return actual(fd, name, raw, **kwargs)
        result = self.terminal(intent)
        with mock.patch.object(leaf, '_publish', side_effect=stop):
            with self.assertRaises(leaf.DeploymentStoreError) as caught:
                leaf.finish(handle, result)
        self.assertEqual(caught.exception.reason, 'index_update')
        self.assertIsNotNone(caught.exception.result_ref)
        status = leaf.read_status(self.root, self.selector)
        self.assertEqual(status['latestAttempt']['state'], 'blocked')
        self.assertFalse(status['indexConsistent'])
        self.assertEqual(leaf.finish(handle, result)['recording'], 'recorded')
        self.assertTrue(leaf.read_status(self.root, self.selector)['indexConsistent'])

    def test_snapshot_durable_binding_failure_never_becomes_bound_terminal(self):
        leaf = self.leaf()
        intent, handle = leaf.reserve(self.root, self.selector)
        actual = leaf._publish
        def stop(fd, name, raw, **kwargs):
            if name == 'binding.json':
                raise leaf.DeploymentStoreError('unavailable', 'write_failed')
            return actual(fd, name, raw, **kwargs)
        with mock.patch.object(leaf, '_publish', side_effect=stop):
            with self.assertRaises(leaf.DeploymentStoreError):
                self.bind_data(intent, handle)
        self.assertTrue((self.directory(intent) / 'local-snapshot.json').is_file())
        self.assertFalse((self.directory(intent) / 'binding.json').exists())
        self.assertEqual(leaf.read_status(self.root, self.selector)['latestAttempt']['state'], 'pending_unresolved')
        self.bind_data(intent, handle)

    def test_file_and_post_link_directory_fsync_failures_report_actual_disk_state(self):
        leaf = self.leaf()
        intent, handle = leaf.reserve(self.root, self.selector)
        result = self.terminal(intent)
        actual = leaf._sync
        def file_error(fd, reason):
            if reason == 'file_sync':
                raise leaf.DeploymentStoreError('unavailable', reason)
            return actual(fd, reason)
        with mock.patch.object(leaf, '_sync', side_effect=file_error):
            with self.assertRaises(leaf.DeploymentStoreError):
                leaf.finish(handle, result)
        self.assertFalse((self.directory(intent) / 'result.json').exists())
        def directory_error(fd, reason):
            if reason == 'directory_sync':
                raise leaf.DeploymentStoreError('unavailable', reason)
            return actual(fd, reason)
        with mock.patch.object(leaf, '_sync', side_effect=directory_error):
            with self.assertRaises(leaf.DeploymentStoreError) as caught:
                leaf.finish(handle, result)
        self.assertEqual(caught.exception.recording, 'durability_uncertain')
        self.assertEqual((self.directory(intent) / 'result.json').read_bytes(), self.canonical(result))
        self.assertEqual(leaf.read_status(self.root, self.selector)['latestAttempt']['state'], 'blocked')

    def test_json_exact_budget_precedes_encoding_including_escaped_and_unicode_text(self):
        leaf = self.leaf()
        for value in ({'x': '中文\n\x00"\\'}, {'x': [None, False, True, -123, 9007199254740991]}):
            raw = self.canonical(value)
            self.assertEqual(leaf._canonical(value, len(raw)), raw)
            with mock.patch.object(json, 'dumps', side_effect=AssertionError('Encoded before budget')):
                with self.assertRaises(leaf.DeploymentStoreError) as caught:
                    leaf._canonical(value, len(raw) - 1)
            self.assertEqual(caught.exception.code, 'limit_exceeded')
        with mock.patch.object(json, 'dumps', side_effect=AssertionError('Large encoded allocation')):
            with self.assertRaises(leaf.DeploymentStoreError):
                leaf._canonical({'x': '\x01' * 2000}, 100)

    def test_corrupt_noncanonical_hash_or_cross_selector_records_never_fall_back(self):
        leaf = self.leaf()
        intent, handle = leaf.reserve(self.root, self.selector)
        leaf.finish(handle, self.terminal(intent))
        path = self.directory(intent) / 'intent.json'
        original = path.read_bytes()
        for changed in (original + b'\n', original.replace(b'daily', b'other', 1), b'{"x":1,"x":2}'):
            with self.subTest(changed=changed[:20]):
                path.write_bytes(changed)
                status = leaf.read_status(self.root, self.selector)
                self.assertEqual(status['status'], 'unavailable')
                self.assertIsNone(status['lastObserved'])
                self.assertIsNone(status['latestAttempt'])
        path.write_bytes(original)
        self.assertEqual(leaf.read_status(self.root, self.selector)['status'], 'local_record_observed')

    def test_missing_counter_or_future_index_pointer_is_unavailable(self):
        leaf = self.leaf()
        intent, _handle = leaf.reserve(self.root, self.selector)
        selector_dir = self.directory(intent).parent.parent
        counter = selector_dir / 'counter.json'
        raw = counter.read_bytes()
        counter.unlink()
        self.assertEqual(leaf.read_status(self.root, self.selector)['status'], 'unavailable')
        counter.write_bytes(raw)
        counter.chmod(0o600)
        index = selector_dir / 'index.json'
        value = json.loads(index.read_bytes())
        value['latestAttempt']['sequence'] += 1
        index.write_bytes(self.canonical(value))
        self.assertEqual(leaf.read_status(self.root, self.selector)['status'], 'unavailable')

    def test_symlinks_and_fifo_are_refused_without_reading_external_data(self):
        leaf = self.leaf()
        intent, _handle = leaf.reserve(self.root, self.selector)
        path = self.directory(intent) / 'intent.json'
        original = path.read_bytes()
        target = Path(self.temp.name) / 'outside.json'
        target.write_bytes(original)
        path.unlink()
        path.symlink_to(target)
        self.assertEqual(leaf.read_status(self.root, self.selector)['status'], 'unavailable')
        self.assertEqual(target.read_bytes(), original)
        path.unlink()
        os.mkfifo(path, 0o600)
        began = time.monotonic()
        self.assertEqual(leaf.read_status(self.root, self.selector)['status'], 'unavailable')
        self.assertLess(time.monotonic() - began, 1)

    def test_handle_rejects_same_path_root_inode_replacement_before_writing(self):
        leaf = self.leaf()
        intent, handle = leaf.reserve(self.root, self.selector)
        moved = Path(self.root).with_name('original-store')
        Path(self.root).rename(moved)
        import shutil
        shutil.copytree(moved, self.root)
        before = self.inventory()
        with self.assertRaises(leaf.DeploymentStoreError) as caught:
            leaf.finish(handle, self.terminal(intent))
        self.assertEqual(caught.exception.reason, 'record_binding')
        self.assertEqual(self.inventory(), before)

    def test_strict_parameters_and_guard_fail_before_any_root_io(self):
        leaf = self.leaf()
        class Trap:
            def __fspath__(self):
                raise AssertionError('No caller path callback')
        with mock.patch.object(leaf, '_directory', side_effect=AssertionError('Unexpected root IO')):
            for root, selector in ((Trap(), self.selector), ('relative', self.selector),
                    (self.root, dict(self.selector, extra=True)),
                    (self.root, dict(self.selector, date='2026-02-30'))):
                with self.subTest(root=repr(root)), self.assertRaises(leaf.DeploymentStoreError):
                    leaf.reserve(root, selector)
        import runtime_guard
        with mock.patch.object(runtime_guard, 'require_external_runtime', side_effect=RuntimeError('guard first')):
            with self.assertRaisesRegex(RuntimeError, 'guard first'):
                leaf.reserve(None, None)
        self.assertFalse(Path(self.root).exists())

    def test_parallel_real_process_reservations_have_unique_monotone_sequences(self):
        script = """import json,sys
import daily_deployment_store as s
for number in range(4):
    intent,handle=s.reserve(sys.argv[1],json.loads(sys.argv[2]))
    print(intent['sequence'],flush=True)
"""
        processes = []
        env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[2] / 'scripts'))
        try:
            for _number in range(3):
                processes.append(subprocess.Popen([sys.executable, '-B', '-c', script, self.root,
                    json.dumps(self.selector)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env))
            sequences = []
            for process in processes:
                stdout, stderr = process.communicate(timeout=10)
                self.assertEqual(process.returncode, 0, stderr.decode())
                sequences.extend(int(line) for line in stdout.splitlines())
            self.assertEqual(sorted(sequences), list(range(1, 13)))
            self.assertEqual(self.leaf().read_status(self.root, self.selector)['latestAttempt']['sequence'], 12)
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=3)

    def test_real_kill_after_durable_intent_releases_lock_and_cold_keeps_pending(self):
        marker = Path(self.temp.name) / 'intent-durable'
        script = """import json,pathlib,sys,time
import daily_deployment_store as s
actual=s._publish
def publish(fd,name,raw,**kwargs):
    if name=='index.json':
        pathlib.Path(sys.argv[3]).write_text('durable')
        while True: time.sleep(0.02)
    return actual(fd,name,raw,**kwargs)
s._publish=publish
s.reserve(sys.argv[1],json.loads(sys.argv[2]))
"""
        env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[2] / 'scripts'))
        process = subprocess.Popen([sys.executable, '-B', '-c', script, self.root,
            json.dumps(self.selector), str(marker)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        try:
            deadline = time.monotonic() + 5
            while not marker.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(marker.exists(), 'Actual durable-intent handshake not reached')
            process.kill()
            process.communicate(timeout=3)
            self.assertEqual(process.returncode, -signal.SIGKILL)
            status = self.leaf().read_status(self.root, self.selector)
            self.assertEqual(status['latestAttempt']['state'], 'pending_unresolved')
            self.assertFalse(status['indexConsistent'])
            new, _new_handle = self.leaf().reserve(self.root, self.selector)
            self.assertEqual(new['sequence'], 2)
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=3)

    def test_control_exception_is_not_rewritten_or_hidden_by_cleanup(self):
        leaf = self.leaf()
        intent, handle = leaf.reserve(self.root, self.selector)
        control = KeyboardInterrupt('mechanical-control')
        with mock.patch.object(leaf, '_write_all', side_effect=control):
            with self.assertRaises(KeyboardInterrupt) as caught:
                leaf.finish(handle, self.terminal(intent))
        self.assertIs(caught.exception, control)
        self.assertFalse((self.directory(intent) / 'result.json').exists())
        self.assertEqual(leaf.read_status(self.root, self.selector)['latestAttempt']['state'], 'pending_unresolved')

    def test_import_has_no_store_environment_or_network_io_and_direct_guard_is_real(self):
        source = Path(__file__).resolve().parents[2] / 'scripts/daily_deployment_store.py'
        script = """import builtins,os,socket,sys
sys.path.insert(0,sys.argv[1])
actual_import=builtins.__import__
def checked(name,*args,**kwargs):
    if name=='runtime_guard': raise AssertionError('Ordinary leaf import loaded project guard')
    return actual_import(name,*args,**kwargs)
builtins.__import__=checked
def forbidden(*a,**k): raise AssertionError('Unexpected import IO')
builtins.open=forbidden
os.open=forbidden
socket.socket=forbidden
import daily_deployment_store
print('imported')
"""
        result = subprocess.run([sys.executable, '-B', '-c', script, str(source.parent)],
                                capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b'imported', result.stdout)
        env = dict(os.environ, CODEX_SANDBOX='test-guard')
        result = subprocess.run([sys.executable, '-B', str(source)], env=env, capture_output=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('必须在沙箱外运行'.encode(), result.stderr)


    def test_cold_read_item_and_aggregate_budget_stop_before_the_next_body_read(self):
        leaf = self.leaf()
        for _number in range(2):
            leaf.reserve(self.root, self.selector)
        self.assertEqual(leaf.read_status(self.root, self.selector)['latestAttempt']['sequence'], 2)
        actual_policy = leaf.POLICY
        reduced = tuple((name, 1 if name == 'store_items' else value) for name, value in actual_policy)
        with mock.patch.object(leaf, 'POLICY', reduced):
            status = leaf.read_status(self.root, self.selector)
        self.assertEqual(status['status'], 'unavailable')
        self.assertEqual(status['issues'][0]['reason'], 'store_items')
        actual_read = os.read
        body_reads = []
        def read(fd, maximum):
            body_reads.append(maximum)
            return actual_read(fd, maximum)
        reduced = tuple((name, 1 if name == 'store_bytes' else value) for name, value in actual_policy)
        with mock.patch.object(leaf, 'POLICY', reduced), mock.patch.object(os, 'read', side_effect=read):
            status = leaf.read_status(self.root, self.selector)
        self.assertEqual(status['issues'][0]['reason'], 'store_bytes')
        self.assertEqual(body_reads, [])

    def test_oversized_regular_file_is_refused_before_open_and_fifo_never_blocks(self):
        leaf = self.leaf()
        intent, _handle = leaf.reserve(self.root, self.selector)
        fd = os.open(self.directory(intent), os.O_RDONLY | os.O_DIRECTORY)
        try:
            with mock.patch.object(os, 'open', side_effect=AssertionError('Opened before size reserve')):
                with self.assertRaises(leaf.DeploymentStoreError) as caught:
                    leaf._read(fd, 'intent.json', 1)
            self.assertEqual(caught.exception.reason, 'store_bytes')
        finally:
            os.close(fd)

    def test_result_capabilities_binding_types_and_hash_fail_before_exclusive_publish(self):
        leaf = self.leaf()
        intent, handle = leaf.reserve(self.root, self.selector)
        original = self.terminal(intent)
        variants = []
        for key, value in (('version', True), ('partial', False), ('fullE05', True),
                           ('bindingVerified', 1), ('metadata', {'unbound': 'must be null'})):
            item = copy.deepcopy(original)
            item[key] = value
            item.pop('recordSha256')
            variants.append(self.hashed(item, 'recordSha256'))
        item = copy.deepcopy(original)
        item['capabilities']['canPublish'] = True
        item.pop('recordSha256')
        variants.append(self.hashed(item, 'recordSha256'))
        item = copy.deepcopy(original)
        item['recordSha256'] = 'f' * 64
        variants.append(item)
        for value in variants:
            with self.subTest(value=value), self.assertRaises(leaf.DeploymentStoreError):
                leaf.finish(handle, value)
            self.assertFalse((self.directory(intent) / 'result.json').exists())
        leaf.finish(handle, original)

    def test_missing_lock_does_not_initialize_or_return_older_success(self):
        leaf = self.leaf()
        intent, handle = leaf.reserve(self.root, self.selector)
        leaf.finish(handle, self.terminal(intent))
        lock = self.directory(intent).parent.parent / 'store.lock'
        lock.unlink()
        before = self.inventory()
        status = leaf.read_status(self.root, self.selector)
        self.assertEqual(status['status'], 'unavailable')
        self.assertIsNone(status['latestAttempt'])
        self.assertEqual(self.inventory(), before)
        self.assertFalse(lock.exists())

    def test_shared_reader_lock_times_out_without_waiting_its_full_production_budget(self):
        leaf = self.leaf()
        intent, _handle = leaf.reserve(self.root, self.selector)
        import fcntl
        path = self.directory(intent).parent.parent / 'store.lock'
        fd = os.open(path, os.O_RDONLY)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            actual_policy = leaf.POLICY
            reduced = tuple((name, 0 if name == 'lock_seconds' else value) for name, value in actual_policy)
            with mock.patch.object(leaf, 'POLICY', reduced):
                began = time.monotonic()
                status = leaf.read_status(self.root, self.selector)
            self.assertEqual(status['status'], 'unavailable')
            self.assertEqual(status['issues'][0]['reason'], 'lock_failed')
            self.assertLess(time.monotonic() - began, 1)
        finally:
            os.close(fd)
        self.assertEqual(leaf.read_status(self.root, self.selector)['status'], 'local_record_observed')

    def test_actual_write_or_replace_failure_does_not_overwrite_prior_terminal(self):
        leaf = self.leaf()
        old, old_handle = leaf.reserve(self.root, self.selector)
        leaf.finish(old_handle, self.terminal(old))
        original = (self.directory(old) / 'result.json').read_bytes()
        with mock.patch.object(os, 'replace', side_effect=OSError('SecretNeedle')):
            with self.assertRaises(leaf.DeploymentStoreError) as caught:
                leaf.reserve(self.root, self.selector)
        self.assertNotIn('SecretNeedle', str(caught.exception))
        self.assertEqual((self.directory(old) / 'result.json').read_bytes(), original)
        self.assertEqual(leaf.read_status(self.root, self.selector)['latestAttempt']['id'], old['attemptId'])

    def test_reserve_control_object_survives_real_source_close_error_and_releases_all_fds(self):
        leaf = self.leaf()
        positive, _positive_handle = leaf.reserve(self.root, self.selector)
        self.assertEqual(leaf.read_status(self.root, self.selector)['latestAttempt']['id'], positive['attemptId'])
        for number, control in enumerate((KeyboardInterrupt('original-control'), SystemExit(73))):
            root = str(Path(self.temp.name).resolve() / ('control-' + str(number)))
            actual_open, actual_close = os.open, os.close
            opened, source, close_hits = [], [], []
            def open_file(*args, **kwargs):
                fd = actual_open(*args, **kwargs)
                opened.append(fd)
                return fd
            def write_error(fd, _raw):
                source.append(fd)
                raise control
            def close_file(fd):
                actual_close(fd)
                if source and fd == source[0] and not close_hits:
                    close_hits.append(fd)
                    raise OSError('cleanup EIO')
            caught = None
            with mock.patch.object(os, 'open', side_effect=open_file), \
                    mock.patch.object(os, 'close', side_effect=close_file), \
                    mock.patch.object(leaf, '_write_all', side_effect=write_error):
                try:
                    leaf.reserve(root, self.selector)
                except BaseException as error:
                    caught = error
            with self.subTest(control=type(control).__name__):
                self.assertEqual(len(close_hits), 1)
                for fd in opened:
                    with self.assertRaises(OSError):
                        os.fstat(fd)
                self.assertIs(caught, control)


    def test_local_metadata_shape_and_commit_mismatch_are_rejected_even_when_rehashed(self):
        leaf = self.leaf()
        for mutation in ('empty_metadata', 'wrong_commit'):
            with self.subTest(mutation=mutation):
                intent, handle = leaf.reserve(self.root, self.selector)
                binding = self.bind_data(intent, handle)
                original = self.terminal(intent, binding, state='metadata_observed')
                item = copy.deepcopy(original)
                if mutation == 'empty_metadata':
                    item['metadata'] = {}
                else:
                    item['metadata']['requestedCommit'] = 'c' * 40
                    item['metadata'].pop('metadataSha256')
                    item['metadata'] = self.hashed(item['metadata'], 'metadataSha256')
                item.pop('recordSha256')
                item = self.hashed(item, 'recordSha256')
                with self.assertRaises(leaf.DeploymentStoreError):
                    leaf.finish(handle, item)
                self.assertFalse((self.directory(intent) / 'result.json').exists())
                leaf.finish(handle, original)

    def test_cleanup_control_beats_ordinary_primary_and_earlier_close_error_after_all_fds(self):
        leaf = self.leaf()
        intent, _handle = leaf.reserve(self.root, self.selector)
        self.assertEqual(leaf.read_status(self.root, self.selector)['latestAttempt']['id'], intent['attemptId'])
        ordinary = leaf.DeploymentStoreError('unavailable', 'write_failed')
        control = KeyboardInterrupt('cleanup-control')
        target, close_hits = [], []
        actual_close = os.close
        def write_error(fd, _raw):
            target.append(fd)
            raise ordinary
        def close_control(fd):
            actual_close(fd)
            if target and fd == target[0] and not close_hits:
                close_hits.append(fd)
                raise control
        caught = None
        with mock.patch.object(leaf, '_write_all', side_effect=write_error), \
                mock.patch.object(os, 'close', side_effect=close_control):
            try:
                leaf.reserve(str(Path(self.temp.name).resolve() / 'cleanup-control'), self.selector)
            except BaseException as error:
                caught = error
        with self.subTest(case='ordinary-write-plus-cleanup-control'):
            self.assertEqual(len(close_hits), 1)
            self.assertIs(caught, control)
        first = os.open(Path(self.temp.name) / 'fd-first', os.O_WRONLY | os.O_CREAT, 0o600)
        second = os.open(Path(self.temp.name) / 'fd-second', os.O_WRONLY | os.O_CREAT, 0o600)
        third = os.open(Path(self.temp.name) / 'fd-third', os.O_WRONLY | os.O_CREAT, 0o600)
        control = SystemExit(74)
        released = []
        def mixed_close(fd):
            actual_close(fd)
            released.append(fd)
            if fd == first:
                raise OSError('earlier close EIO')
            if fd == second:
                raise control
        caught = None
        with mock.patch.object(os, 'close', side_effect=mixed_close):
            try:
                leaf._close_fds((first, second, third), ordinary)
            except BaseException as error:
                caught = error
        with self.subTest(case='first-close-eio-then-control-and-third-close'):
            self.assertEqual(released, [first, second, third])
            for fd in released:
                with self.assertRaises(OSError):
                    os.fstat(fd)
            self.assertIs(caught, control)


    def test_nested_implementation_coverage_and_capabilities_are_not_self_hash_permission(self):
        leaf = self.leaf()
        mutations = ('empty_implementation', 'execution_hash', 'metadata_capability', 'metadata_coverage',
                     'outer_coverage', 'unverified_success')
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                intent, handle = leaf.reserve(self.root, self.selector)
                binding = self.bind_data(intent, handle)
                original = self.terminal(intent, binding, state='metadata_observed')
                item = copy.deepcopy(original)
                if mutation == 'empty_implementation':
                    item['implementationObservation'] = {}
                elif mutation == 'execution_hash':
                    item['implementationObservation']['executionBinding']['modules'][0]['codeAndPolicySha256'] = 'c' * 64
                elif mutation == 'metadata_capability':
                    item['metadata']['capabilities']['canGrantSource'] = True
                elif mutation == 'metadata_coverage':
                    item['metadata']['coverage']['artifactLineage'] = 'verified'
                elif mutation == 'outer_coverage':
                    item['coverage']['publicPages'] = 'observed'
                else:
                    item['bindingVerified'] = False
                item['metadata'].pop('metadataSha256')
                item['metadata'] = self.hashed(item['metadata'], 'metadataSha256')
                item.pop('recordSha256')
                item = self.hashed(item, 'recordSha256')
                with self.assertRaises(leaf.DeploymentStoreError):
                    leaf.finish(handle, item)
                self.assertFalse((self.directory(intent) / 'result.json').exists())
                leaf.finish(handle, original)

    def test_binding_domains_are_exact_and_match_the_original_snapshot(self):
        leaf = self.leaf()
        intent, handle = leaf.reserve(self.root, self.selector)
        binding = self.bind_data(intent, handle)
        snapshot = json.loads((self.directory(intent) / 'local-snapshot.json').read_bytes())
        for domain in ('normalBinding', 'publicationBinding', 'targetBinding', 'localBinding', 'repositoryPolicy'):
            with self.subTest(domain=domain):
                item = copy.deepcopy(binding)
                item[domain] = {}
                item.pop('bindingSha256')
                item = self.hashed(item, 'bindingSha256')
                with self.assertRaises(leaf.DeploymentStoreError) as caught:
                    leaf.bind(handle, item, snapshot)
                self.assertEqual(caught.exception.code, 'invalid_record')
                self.assertEqual(caught.exception.reason, 'record_shape')
        item = copy.deepcopy(binding)
        item['normalBinding']['reviewProtocolFingerprint'] = 'c' * 64
        item.pop('bindingSha256')
        item = self.hashed(item, 'bindingSha256')
        with self.assertRaises(leaf.DeploymentStoreError) as caught:
            leaf.bind(handle, item, snapshot)
        self.assertEqual((caught.exception.code, caught.exception.reason), ('invalid_record', 'record_binding'))
        leaf.finish(handle, self.terminal(intent, binding, state='metadata_observed'))
        path = self.directory(intent) / 'result.json'
        value = json.loads(path.read_bytes())
        value['metadata']['requestedCommit'] = 'c' * 40
        value['metadata'].pop('metadataSha256')
        value['metadata'] = self.hashed(value['metadata'], 'metadataSha256')
        value.pop('recordSha256')
        value = self.hashed(value, 'recordSha256')
        path.write_bytes(self.canonical(value))
        status = leaf.read_status(self.root, self.selector)
        self.assertEqual(status['status'], 'unavailable')
        self.assertIsNone(status['lastObserved'])

    def test_workflow_string_subclass_is_rejected_before_creating_another_root(self):
        leaf = self.leaf()
        intent, _handle = leaf.reserve(self.root, self.selector)
        self.assertEqual(leaf.read_status(self.root, self.selector)['latestAttempt']['id'], intent['attemptId'])
        class Daily(str):
            pass
        target = Path(self.temp.name).resolve() / 'invalid-workflow-root'
        self.assertFalse(target.exists())
        caught = None
        try:
            leaf.reserve(str(target), dict(self.selector, workflow=Daily('daily')))
        except leaf.DeploymentStoreError as error:
            caught = error
        self.assertIsNotNone(caught)
        self.assertFalse(target.exists(), 'Strict argument rejection must precede root IO')
        self.assertEqual(caught.code, 'invalid_argument')

    def test_read_growth_after_fstat_cannot_exceed_reserved_bytes_plus_one_probe(self):
        leaf = self.leaf()
        intent, _handle = leaf.reserve(self.root, self.selector)
        self.assertEqual(leaf.read_status(self.root, self.selector)['latestAttempt']['id'], intent['attemptId'])
        directory = Path(self.temp.name) / 'growth'
        directory.mkdir(mode=0o700)
        path = directory / 'body.bin'
        path.write_bytes(b'x')
        path.chmod(0o600)
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            self.assertEqual(leaf._read(fd, 'body.bin', 16), b'x')
            actual_fstat, actual_read, actual_policy = os.fstat, os.read, leaf.POLICY
            reduced = tuple((name, 10 if name == 'store_bytes' else value) for name, value in actual_policy)
            grown, reads = [], []
            def fstat(source):
                info = actual_fstat(source)
                if info.st_size == 1 and not grown:
                    path.write_bytes(b'xxxxx')
                    grown.append(True)
                return info
            def read(source, maximum):
                raw = actual_read(source, maximum)
                reads.append((maximum, len(raw)))
                return raw
            with mock.patch.object(leaf, 'POLICY', reduced), \
                    mock.patch.object(os, 'fstat', side_effect=fstat), \
                    mock.patch.object(os, 'read', side_effect=read):
                with self.assertRaises(leaf.DeploymentStoreError):
                    leaf._read(fd, 'body.bin', 16, aggregate=[9])
            self.assertEqual(grown, [True])
            self.assertEqual(path.read_bytes(), b'xxxxx')
            self.assertTrue(reads)
            self.assertLessEqual(sum(item[1] for item in reads), 2)
            self.assertLessEqual(max(item[0] for item in reads), 2)
        finally:
            os.close(fd)

    def test_cold_named_final_stat_size_drift_rejects_previously_valid_metadata(self):
        leaf = self.leaf()
        intent, handle = leaf.reserve(self.root, self.selector)
        binding = self.bind_data(intent, handle)
        leaf.finish(handle, self.terminal(intent, binding, state='metadata_observed'))
        self.assertEqual(leaf.read_status(self.root, self.selector)['latestAttempt']['state'], 'metadata_observed')
        path = self.directory(intent) / 'result.json'
        original, actual_stat = path.read_bytes(), os.stat
        calls, observed = [], []
        def stat_file(name, *args, **kwargs):
            if name == 'result.json':
                calls.append(True)
                if len(calls) == 2:
                    with path.open('ab') as target:
                        target.write(b' ')
                    info = actual_stat(name, *args, **kwargs)
                    observed.append((info.st_ino, info.st_size, info.st_mtime_ns))
                    return info
            return actual_stat(name, *args, **kwargs)
        before = actual_stat(path)
        try:
            with mock.patch.object(os, 'stat', side_effect=stat_file):
                status = leaf.read_status(self.root, self.selector)
            self.assertEqual(len(calls), 2)
            self.assertEqual(len(observed), 1)
            self.assertEqual(observed[0][0], before.st_ino)
            self.assertEqual(observed[0][1], len(original) + 1)
            self.assertEqual(status['status'], 'unavailable')
            self.assertEqual(status['coverage']['recordIntegrity'], 'not_available')
            self.assertIsNone(status['lastObserved'])
        finally:
            path.write_bytes(original)
            self.assertEqual(leaf.read_status(self.root, self.selector)['latestAttempt']['state'], 'metadata_observed')

    def test_primary_page_container_count_and_item_types_remain_mechanical_schema(self):
        leaf = self.leaf()
        original_intent, original_handle = leaf.reserve(self.root, self.selector)
        template = self.bind_data(original_intent, original_handle)
        leaf.finish(original_handle, self.terminal(original_intent, template, state='metadata_observed'))
        self.assertEqual(leaf.read_status(self.root, self.selector)['latestAttempt']['state'], 'metadata_observed')
        saved_snapshot = json.loads((self.directory(original_intent) / 'local-snapshot.json').read_bytes())
        for name, pages in (('dict', {}), ('too_many', [{}] * 513), ('non_dict_item', ['not a page dict'])):
            with self.subTest(mutation=name):
                intent, handle = leaf.reserve(self.root, self.selector)
                snapshot = copy.deepcopy(saved_snapshot)
                target = snapshot['reviewedTargets']
                target['primaryPages'] = pages
                keys = ('contract', 'version', 'selector', 'reviewedSitePolicy', 'reviewedFileSetSha256',
                        'reviewedFileCount', 'primarySourceSetSha256', 'primaryPages', 'changes', 'profile', 'coverage')
                target['targetsSha256'] = hashlib.sha256(self.canonical({key: target[key] for key in keys})).hexdigest()
                target.pop('recordSha256')
                snapshot['reviewedTargets'] = self.hashed(target, 'recordSha256')
                snapshot.pop('recordSha256')
                snapshot = self.hashed(snapshot, 'recordSha256')
                binding = copy.deepcopy(template)
                binding.update(attemptId=intent['attemptId'], sequence=intent['sequence'])
                binding['targetBinding']['targetsSha256'] = snapshot['reviewedTargets']['targetsSha256']
                binding['targetBinding']['recordSha256'] = snapshot['reviewedTargets']['recordSha256']
                raw = self.canonical(snapshot)
                binding['snapshot'] = {'path': 'local-snapshot.json', 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
                binding.pop('bindingSha256')
                binding = self.hashed(binding, 'bindingSha256')
                caught = None
                try:
                    leaf.bind(handle, binding, snapshot)
                    leaf.finish(handle, self.terminal(intent, binding, state='metadata_observed'))
                    state = leaf.read_status(self.root, self.selector)
                    self.assertEqual(state['latestAttempt']['state'], 'metadata_observed')
                except leaf.DeploymentStoreError as error:
                    caught = error
                self.assertIsNotNone(caught, 'Invalid primaryPages must be rejected despite consistent propagated hashes')
                self.assertEqual((caught.code, caught.reason), ('invalid_record', 'record_shape'))
                self.assertFalse((self.directory(intent) / 'result.json').exists())


    def bootstrap_process(self, mode, root, stage):
        script = r"""import fcntl,json,os,sys
sys.path.insert(0,sys.argv[1])
import daily_deployment_store as s
mode,root,stage=sys.argv[2:5]
original_flock,original_link,original_publish=fcntl.flock,os.link,s._publish
first,waiting=False,False
def flock(fd,flags):
    global first,waiting
    if flags & fcntl.LOCK_EX and not first:
        first=True
        if mode=='creator' and stage=='first':
            print('before_first_flock',flush=True)
            assert sys.stdin.readline().strip()=='go'
    try:
        return original_flock(fd,flags)
    except BlockingIOError:
        if mode=='second' and not waiting:
            waiting=True
            print('waiter_blocked',flush=True)
        raise
def link(source,target,*args,**kwargs):
    result=original_link(source,target,*args,**kwargs)
    if mode=='creator' and stage=='linked' and target=='store.lock':
        info=os.stat(target,dir_fd=kwargs['dst_dir_fd'],follow_symlinks=False)
        print('published_nlink_'+str(info.st_nlink),flush=True)
        assert sys.stdin.readline().strip()=='go'
    return result
def publish(fd,name,raw,**kwargs):
    if mode=='creator' and stage=='counter' and name=='counter.json':
        print('before_counter',flush=True)
        assert sys.stdin.readline().strip()=='go'
    return original_publish(fd,name,raw,**kwargs)
fcntl.flock=flock
os.link=link
s._publish=publish
try:
    intent,handle=s.reserve(root,json.loads(sys.argv[5]))
    print(json.dumps({'ok':True,'sequence':intent['sequence']}),flush=True)
except s.DeploymentStoreError as error:
    print(json.dumps({'ok':False,'code':error.code,'reason':error.reason}),flush=True)
    raise SystemExit(1)
"""
        return subprocess.Popen([sys.executable, '-B', '-c', script,
            str(Path(__file__).resolve().parents[2] / 'scripts'), mode, root, stage, json.dumps(self.selector)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def bootstrap_line(self, process):
        ready, _write, _error = select.select([process.stdout], [], [], 5)
        self.assertTrue(ready, 'Bounded actual-process handshake not reached')
        return process.stdout.readline().decode().strip()

    def cleanup_processes(self, processes):
        for process in processes:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=3)

    def test_first_lock_creator_paused_before_flock_does_not_reject_the_other_writer(self):
        creator = self.bootstrap_process('creator', self.root, 'first')
        processes = [creator]
        try:
            self.assertEqual(self.bootstrap_line(creator), 'before_first_flock')
            second = self.bootstrap_process('second', self.root, 'first')
            processes.append(second)
            second_out, second_err = second.communicate(timeout=5)
            creator.stdin.write(b'go\n')
            creator.stdin.flush()
            creator_out, creator_err = creator.communicate(timeout=5)
            self.assertEqual(second.returncode, 0, (second_out, second_err))
            self.assertEqual(creator.returncode, 0, (creator_out, creator_err))
            rows = [json.loads(second_out.splitlines()[-1]), json.loads(creator_out.splitlines()[-1])]
            self.assertEqual(sorted(row['sequence'] for row in rows), [1, 2])
            self.assertEqual(self.leaf().read_status(self.root, self.selector)['latestAttempt']['sequence'], 2)
        finally:
            self.cleanup_processes(processes)

    def test_waiter_handles_published_lock_two_links_only_after_acquiring_same_inode(self):
        creator = self.bootstrap_process('creator', self.root, 'linked')
        processes = [creator]
        try:
            self.assertEqual(self.bootstrap_line(creator), 'published_nlink_2')
            key = hashlib.sha256(self.canonical(self.selector)).hexdigest()
            lock = Path(self.root) / key / 'store.lock'
            initial = lock.stat()
            self.assertEqual(initial.st_nlink, 2)
            second = self.bootstrap_process('second', self.root, 'linked')
            processes.append(second)
            self.assertEqual(self.bootstrap_line(second), 'waiter_blocked')
            self.assertEqual(lock.stat().st_ino, initial.st_ino)
            self.assertEqual(lock.stat().st_nlink, 2)
            creator.stdin.write(b'go\n')
            creator.stdin.flush()
            creator_out, creator_err = creator.communicate(timeout=5)
            second_out, second_err = second.communicate(timeout=5)
            self.assertEqual(creator.returncode, 0, (creator_out, creator_err))
            self.assertEqual(second.returncode, 0, (second_out, second_err))
            self.assertEqual(json.loads(creator_out.splitlines()[-1])['sequence'], 1)
            self.assertEqual(json.loads(second_out.splitlines()[-1])['sequence'], 2)
            self.assertEqual(lock.stat().st_ino, initial.st_ino)
            self.assertEqual(lock.stat().st_nlink, 1)
            self.assertEqual(list(lock.parent.glob('.store.lock.*.tmp')), [])
        finally:
            self.cleanup_processes(processes)

    def test_killed_initializer_keeps_published_lock_and_rejects_missing_counter_without_rows(self):
        creator = self.bootstrap_process('creator', self.root, 'counter')
        try:
            self.assertEqual(self.bootstrap_line(creator), 'before_counter')
            key = hashlib.sha256(self.canonical(self.selector)).hexdigest()
            lock = Path(self.root) / key / 'store.lock'
            original = lock.stat()
            self.assertEqual(original.st_nlink, 1)
            self.assertFalse((lock.parent / 'counter.json').exists())
            creator.kill()
            creator.communicate(timeout=3)
            self.assertEqual(creator.returncode, -signal.SIGKILL)
            leaf = self.leaf()
            status = leaf.read_status(self.root, self.selector)
            self.assertEqual(status['status'], 'unavailable')
            self.assertEqual(status['issues'][0]['reason'], 'sequence_conflict')
            with self.assertRaises(leaf.DeploymentStoreError) as caught:
                leaf.reserve(self.root, self.selector)
            self.assertEqual(caught.exception.reason, 'sequence_conflict')
            self.assertEqual(lock.stat().st_ino, original.st_ino)
            self.assertEqual(lock.stat().st_nlink, 1)
            self.assertFalse((lock.parent / 'counter.json').exists())
        finally:
            self.cleanup_processes([creator])

    def test_exclusive_temp_name_collision_never_removes_an_existing_inode(self):
        leaf = self.leaf()
        intent, _handle = leaf.reserve(self.root, self.selector)
        self.assertEqual(intent['sequence'], 1)
        fixed = mock.Mock(hex='c' * 32)
        for operation in ('new_lock', 'publish'):
            with self.subTest(operation=operation):
                directory = Path(self.temp.name).resolve() / operation
                directory.mkdir(mode=0o700)
                if operation == 'new_lock':
                    key = hashlib.sha256(self.canonical(self.selector)).hexdigest()
                    target = directory / key
                    target.mkdir(mode=0o700)
                    name = '.store.lock.' + fixed.hex + '.tmp'
                else:
                    target = directory
                    name = '.record.json.' + fixed.hex + '.tmp'
                existing = target / name
                existing.write_bytes(b'owned-by-another-attempt')
                existing.chmod(0o600)
                original = existing.stat()
                with mock.patch.object(leaf.uuid, 'uuid4', return_value=fixed):
                    with self.assertRaises(leaf.DeploymentStoreError):
                        if operation == 'new_lock':
                            leaf.reserve(str(directory), self.selector)
                        else:
                            descriptor = os.open(target, os.O_RDONLY | os.O_DIRECTORY)
                            try:
                                leaf._publish(descriptor, 'record.json', b'new-record')
                            finally:
                                os.close(descriptor)
                self.assertTrue(existing.exists(), 'Failed O_EXCL never created this existing temp')
                self.assertEqual(existing.read_bytes(), b'owned-by-another-attempt')
                self.assertEqual(existing.stat().st_ino, original.st_ino)
                self.assertFalse((target / ('store.lock' if operation == 'new_lock' else 'record.json')).exists())

    def test_retired_temp_name_recreated_before_directory_sync_is_not_cleaned_again(self):
        leaf = self.leaf()
        intent, _handle = leaf.reserve(self.root, self.selector)
        self.assertEqual(intent['sequence'], 1)
        fixed = mock.Mock(hex='d' * 32)
        actual_sync = leaf._sync
        for operation in ('new_lock', 'publish', 'replace'):
            with self.subTest(operation=operation):
                directory = Path(self.temp.name).resolve() / ('retired-' + operation)
                directory.mkdir(mode=0o700)
                key = hashlib.sha256(self.canonical(self.selector)).hexdigest()
                target = directory / key if operation == 'new_lock' else directory
                temp_name = ('.store.lock.' if operation == 'new_lock' else '.record.json.') + fixed.hex + '.tmp'
                replacement = target / temp_name
                observed = []
                def sync(descriptor, reason):
                    if (reason == 'directory_sync' and not observed
                            and (operation != 'new_lock' or (target / 'store.lock').exists())):
                        self.assertFalse(replacement.exists(), 'Original owned temp must already be retired')
                        replacement.write_bytes(b'new-owner-after-retirement')
                        replacement.chmod(0o600)
                        observed.append(replacement.stat().st_ino)
                    return actual_sync(descriptor, reason)
                with mock.patch.object(leaf.uuid, 'uuid4', return_value=fixed), mock.patch.object(leaf, '_sync', side_effect=sync):
                    if operation == 'new_lock':
                        # Stop after the real lock scope: reserve would reuse the fixed UUID for other records.
                        with leaf._Scope(str(directory), self.selector, create=True):
                            pass
                    else:
                        descriptor = os.open(target, os.O_RDONLY | os.O_DIRECTORY)
                        try:
                            if operation == 'replace':
                                (target / 'record.json').write_bytes(b'old')
                                (target / 'record.json').chmod(0o600)
                            leaf._publish(descriptor, 'record.json', b'new-record',
                                          replace=operation == 'replace', expected=b'old')
                        finally:
                            os.close(descriptor)
                self.assertEqual(len(observed), 1)
                self.assertTrue(replacement.exists(), 'A retired name now belongs to another attempt')
                self.assertEqual(replacement.read_bytes(), b'new-owner-after-retirement')
                self.assertEqual(replacement.stat().st_ino, observed[0])
