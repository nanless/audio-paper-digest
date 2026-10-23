"""Offline metadata mechanics; fixture data never grants normal/Source authority."""
import importlib
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))


class GithubPagesDeploymentTest(unittest.TestCase):
    def setUp(self):
        self.module = importlib.import_module('github_pages_deployment')
        self.directory = Path(__file__).parent / 'fixtures/github-pages-metadata'
        self.data = {name: json.loads((self.directory / (name + '.json')).read_text()) for name in
            ('repository', 'workflows', 'runs', 'attempt', 'source', 'jobs', 'deployments', 'statuses', 'artifacts')}
        self.commit = self.data['attempt']['head_sha']
        self.run_id = self.data['attempt']['id']
        self.run_attempt = self.data['attempt']['run_attempt']

    def respond(self, path, **kwargs):
        module = self.module
        for name in ('repository', 'workflows', 'runs', 'attempt', 'source', 'jobs', 'deployments', 'statuses', 'artifacts'):
            expected = module._path(name, run=self.run_id, attempt=self.run_attempt,
                deployment=self.data['deployments'][0]['id'], commit=self.commit)
            if path == expected:
                return 200, json.dumps(self.data[name], ensure_ascii=False).encode()
        self.fail('Unexpected fixed route: ' + path)

    def call(self, responder=None):
        with mock.patch.object(self.module, '_get', side_effect=responder or self.respond) as http:
            result = self.module.collect_github_pages_metadata(self.commit)
        return result, http

    def issue(self, result, domain, code, reason):
        self.assertEqual(result['issues'], [{'domain': domain, 'code': code, 'reason': reason}])
        self.assertNotEqual(result['status'], 'metadata_observed')
        self.assertTrue(result['partial'])
        self.assertFalse(result['fullE05'])

    def test_fixed_mechanical_entry_exists(self):
        self.assertTrue(callable(self.module.collect_github_pages_metadata))

    def test_historical_metadata_and_synthetic_complete_discovery_are_partial(self):
        result, http = self.call()
        self.assertEqual(result['status'], 'metadata_observed', result)
        self.assertEqual(result['metadataOutcome'], 'success')
        self.assertTrue(result['partial'])
        self.assertFalse(result['fullE05'])
        self.assertEqual([job['role'] for job in result['jobs']], ['unit', 'build', 'deploy'])
        self.assertFalse(result['deployment']['productionEnvironment'])
        self.assertEqual(result['deployment']['latestStatus']['jobId'], 119269521648)
        self.assertEqual(result['artifacts']['listing'], 'observed_empty')
        self.assertTrue(all(value == 'not_checked' for key, value in result['artifacts'].items() if key not in ('listing', 'totalCount')))
        self.assertEqual(result['coverage']['artifactLineage'], 'not_checked')
        self.assertTrue(all(value is False for value in result['capabilities'].values()))
        unsigned = {key: value for key, value in result.items() if key != 'metadataSha256'}
        expected = hashlib.sha256(json.dumps(unsigned, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        self.assertEqual(result['metadataSha256'], expected)
        self.assertEqual(len(result['requests']), http.call_count)
        self.assertTrue(all(row['outcome'] == 'received' for row in result['requests']))
        self.assertTrue(all('status=success' not in call.args[0] for call in http.call_args_list))

    def native_runs_responder(self, mutate=None):
        """Synthetic complete listings retain every native REST field, including ignored ones."""
        sample_raw = (self.directory / 'native-run.json').read_bytes()
        self.assertEqual(hashlib.sha256(sample_raw).hexdigest(),
                         '9683eb58c247337bc181c514cc901f8fc2413e7d838a5afe9b57b1c32c0aef93')
        sample = json.loads(sample_raw)
        self.assertEqual(self.json_nodes(sample), 214)
        pages = {}
        for number in range(1, 7):
            rows = []
            for index in range((number - 1) * 100, min(number * 100, 511)):
                row = copy.deepcopy(sample)
                if index != 510:
                    row.update(id=self.run_id + 1000 + index, run_number=1000 + index,
                               head_sha='2' * 40)
                rows.append(row)
            value = {'total_count': 511, 'workflow_runs': rows}
            if mutate is not None:
                mutate(number, value)
            pages[self.module._path('runs', page=number)] = json.dumps(value, ensure_ascii=False).encode()
        calls = []
        def response(path, **kwargs):
            status, raw = (200, pages[path]) if path in pages else self.respond(path, **kwargs)
            calls.append((path, raw))
            return status, raw
        return response, calls

    def json_nodes(self, value):
        # Independent oracle matches the declared values/containers budget, not JSON key count.
        if type(value) is dict:
            return 1 + sum(self.json_nodes(item) for item in value.values())
        if type(value) is list:
            return 1 + sum(self.json_nodes(item) for item in value)
        return 1

    def test_native_rest_shape_complete_pages_and_both_final_frontiers_are_observed(self):
        response, calls = self.native_runs_responder()
        result, http = self.call(response)
        self.assertEqual(result['status'], 'metadata_observed', result)
        self.assertEqual(result['selection']['runId'], self.run_id)
        self.assertEqual(result['coverage']['pagination'], 'complete')
        routes = [path for path, raw in calls]
        for page in range(1, 7):
            self.assertEqual(routes.count(self.module._path('runs', page=page)), 2 if page in (1, 6) else 1)
        nodes = [self.json_nodes(json.loads(raw)) for path, raw in calls]
        self.assertGreater(sum(nodes), 100000)
        self.assertLess(max(nodes), 100000)
        self.assertLess(max(len(raw) for path, raw in calls), 2 * 1024 * 1024)
        self.assertLess(sum(len(raw) for path, raw in calls), 24 * 1024 * 1024)
        self.assertEqual(len(result['requests']), len(calls))
        self.assertEqual(http.call_count, len(calls))
        self.assertTrue(result['partial'])
        self.assertFalse(result['fullE05'])
        self.assertTrue(all(value is False for value in result['capabilities'].values()))

    def test_native_rest_response_and_aggregate_node_limits_stop_without_extra_dispatch(self):
        # The last page alone exceeds 100k while its encoded body remains below the byte limit.
        def add_unobserved_nodes(page, value):
            if page == 6:
                value['ignored_native_extension'] = [None] * 100001
        response, calls = self.native_runs_responder(add_unobserved_nodes)
        result, http = self.call(response)
        self.issue(result, 'limits', 'unavailable', 'node_count')
        self.assertEqual(calls[-1][0], self.module._path('runs', page=6))
        self.assertLess(len(calls[-1][1]), 2 * 1024 * 1024)
        self.assertGreater(self.json_nodes(json.loads(calls[-1][1])), 100000)
        self.assertEqual(http.call_count, 8)
        self.assertEqual(len(result['requests']), 8)
        self.assertEqual(result['requests'][-1]['outcome'], 'limit')
        # A separately lowered aggregate stops at page five, despite every response fitting 100k.
        response, calls = self.native_runs_responder()
        values = dict(self.module.POLICY)
        with mock.patch.object(self.module, '_p', side_effect=lambda name: 100000 if name == 'total_nodes' else values[name]):
            result, http = self.call(response)
        self.issue(result, 'limits', 'unavailable', 'node_count')
        self.assertEqual(calls[-1][0], self.module._path('runs', page=5))
        self.assertTrue(all(self.json_nodes(json.loads(raw)) < 100000 for path, raw in calls))
        self.assertEqual(http.call_count, 7)
        self.assertEqual(len(result['requests']), 7)
        self.assertEqual(result['requests'][-1]['outcome'], 'limit')

    def test_global_final_rechecks_consume_the_same_aggregate_node_budget(self):
        response, calls = self.native_runs_responder()
        baseline, unused = self.call(response)
        self.assertEqual(baseline['status'], 'metadata_observed', baseline)
        artifact = self.module._path('artifacts', run=self.run_id)
        end = next(index for index, (path, raw) in enumerate(calls) if path == artifact)
        initial_nodes = sum(self.json_nodes(json.loads(raw)) for path, raw in calls[:end + 1])
        response, limited_calls = self.native_runs_responder()
        values = dict(self.module.POLICY)
        with mock.patch.object(self.module, '_p', side_effect=lambda name: initial_nodes if name == 'total_nodes' else values[name]):
            result, http = self.call(response)
        self.issue(result, 'limits', 'unavailable', 'node_count')
        self.assertEqual(len(limited_calls), end + 2)
        self.assertEqual(limited_calls[-1][0], self.module._path('runs', page=1))
        self.assertEqual(result['coverage']['pagination'], 'incomplete')
        self.assertEqual(len(result['requests']), http.call_count)
        self.assertEqual(result['requests'][-1]['outcome'], 'limit')

    def test_invalid_argument_types_have_no_http_and_no_arbitrary_echo(self):
        for value in (None, True, 3, {}, 'A' * 40, 'x' * 100000):
            with self.subTest(value_type=type(value).__name__), mock.patch.object(self.module, '_get') as http:
                result = self.module.collect_github_pages_metadata(value)
                self.issue(result, 'input', 'invalid', 'commit_oid')
                self.assertIsNone(result['requestedCommit'])
                http.assert_not_called()

    def test_exact_repository_workflow_run_attempt_fields_cannot_be_name_guessed(self):
        mutations = (
            ('repository', lambda value: value.update(id=True)),
            ('repository', lambda value: value.update(full_name='somewhere/else')),
            ('workflows', lambda value: value['workflows'][0].update(path='.github/workflows/other.yaml')),
            ('runs', lambda value: value['workflow_runs'][0].update(workflow_id=2)),
            ('runs', lambda value: value['workflow_runs'][0]['head_repository'].update(id=2)),
            ('runs', lambda value: value['workflow_runs'][0].update(event='pull_request')),
            ('runs', lambda value: value['workflow_runs'][0].update(head_branch='other')),
            ('attempt', lambda value: value.update(run_attempt=2)),
            ('attempt', lambda value: value.update(jobs_url='https://api.github.com/other')),
        )
        for name, mutate in mutations:
            with self.subTest(name=name):
                original = copy.deepcopy(self.data[name])
                mutate(self.data[name])
                result, unused = self.call()
                self.assertNotEqual(result['status'], 'metadata_observed', result)
                self.data[name] = original

    def test_different_commit_historical_dispatch_does_not_block_selected_push(self):
        old = copy.deepcopy(self.data['runs']['workflow_runs'][0])
        old.update(id=old['id'] - 1, run_number=old['run_number'] - 1, head_sha='1' * 40,
            event='workflow_dispatch', path='.github/workflows/old.yaml')
        old['head_repository']['full_name'] = 'old/fork'
        self.data['runs']['workflow_runs'].append(old)
        self.data['runs']['total_count'] = 2
        result, unused = self.call()
        self.assertEqual(result['status'], 'metadata_observed', result)

    def test_new_same_commit_failure_or_pending_never_falls_back_to_success(self):
        for status, conclusion, code, reason in (('queued', None, 'pending', 'run_pending'),
                                                ('completed', 'failure', 'failed', 'run_failed')):
            with self.subTest(status=status):
                newest = copy.deepcopy(self.data['runs']['workflow_runs'][0])
                newest.update(id=newest['id'] + 2, run_number=newest['run_number'] + 1,
                    status=status, conclusion=conclusion)
                self.data['runs']['workflow_runs'] = [copy.deepcopy(self.data['attempt']), newest]
                self.data['runs']['total_count'] = 2
                result, http = self.call()
                self.issue(result, 'selection', code, reason)
                self.assertEqual(result['selection']['runId'], newest['id'])
                self.assertEqual(result['coverage']['jobs'], 'not_checked')
                self.assertFalse(any('/jobs?' in call.args[0] for call in http.call_args_list))

    def test_global_frontiers_are_after_artifacts_and_reject_updates(self):
        for kind in ('runs', 'deployments', 'statuses'):
            with self.subTest(kind=kind):
                counts, order = {}, []
                target = self.module._path(kind, commit=self.commit, deployment=self.data['deployments'][0]['id'])
                def response(path, **kwargs):
                    order.append(path)
                    counts[path] = counts.get(path, 0) + 1
                    status, raw = self.respond(path, **kwargs)
                    if path == target and counts[path] > 1:
                        value = json.loads(raw)
                        if kind == 'runs':
                            value['workflow_runs'][0]['run_attempt'] = 2
                        elif kind == 'deployments':
                            value.append({**value[0], 'id': value[0]['id'] + 1})
                        else:
                            value[0]['state'] = 'queued'
                        raw = json.dumps(value).encode()
                    return status, raw
                result, unused = self.call(response)
                self.issue(result, 'selection' if kind == 'runs' else 'deployment', 'stale', 'frontier_changed')
                artifact = self.module._path('artifacts', run=self.data['attempt']['id'])
                self.assertLess(order.index(artifact), max(index for index, path in enumerate(order) if path == target))

    def test_selected_rows_on_second_pages_are_rechecked(self):
        module = self.module
        for kind in ('runs', 'deployments', 'statuses'):
            with self.subTest(kind=kind):
                page_one = module._path(kind, page=1, commit=self.commit, deployment=self.data['deployments'][0]['id'])
                page_two = module._path(kind, page=2, commit=self.commit, deployment=self.data['deployments'][0]['id'])
                if kind == 'runs':
                    base = self.data['runs']['workflow_runs'][0]
                    rows = [{**copy.deepcopy(base), 'id': 100 + index, 'run_number': 100 + index, 'head_sha': '2' * 40} for index in range(100)]
                    first, second = {'total_count': 101, 'workflow_runs': rows}, {'total_count': 101, 'workflow_runs': [base]}
                else:
                    base = self.data[kind][0]
                    rows = [{**copy.deepcopy(base), 'id': 100 + index, 'created_at': '2026-10-20T00:00:00Z'} for index in range(100)]
                    first, second = rows, [base]
                counts = {}
                def response(path, **kwargs):
                    counts[path] = counts.get(path, 0) + 1
                    if path == page_one:
                        return 200, json.dumps(first).encode()
                    if path == page_two:
                        value = copy.deepcopy(second)
                        if counts[path] > 1:
                            if kind == 'runs':
                                value['workflow_runs'][0]['run_attempt'] += 1
                            elif kind == 'deployments':
                                value[0]['task'] = 'changed'
                            else:
                                value[0]['state'] = 'waiting'
                        return 200, json.dumps(value).encode()
                    return self.respond(path, **kwargs)
                result, unused = self.call(response)
                self.issue(result, 'selection' if kind == 'runs' else 'deployment', 'stale', 'frontier_changed')
                self.assertEqual(counts[page_two], 2)

    def test_jobs_are_complete_and_attempt_bound_with_fixed_steps(self):
        mutations = (
            lambda value: value['jobs'].pop(),
            lambda value: value['jobs'][0].update(run_attempt=2),
            lambda value: value['jobs'][1].update(name='not-a-deploy-job'),
            lambda value: value['jobs'][1]['steps'][5].update(conclusion='skipped'),
            lambda value: value['jobs'][2].update(started_at='2026-10-21T13:00:00Z'),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                original = copy.deepcopy(self.data['jobs'])
                mutate(self.data['jobs'])
                result, unused = self.call()
                self.assertNotEqual(result['status'], 'metadata_observed', result)
                self.data['jobs'] = original

    def test_source_is_at_exact_commit_and_bound_to_size_git_blob_and_profile(self):
        raw = (self.directory / 'hugo.yaml').read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), self.module._p('workflow_sha256'))
        for change in ('base64', 'size', 'blob', 'profile'):
            with self.subTest(change=change):
                original = copy.deepcopy(self.data['source'])
                if change == 'base64':
                    self.data['source']['content'] += '@'
                elif change == 'size':
                    self.data['source']['size'] += 1
                elif change == 'blob':
                    self.data['source']['sha'] = '1' * 40
                else:
                    altered = raw + b'\n'
                    self.data['source'].update(content=base64.b64encode(altered).decode(), size=len(altered),
                        sha=hashlib.sha1(b'blob ' + str(len(altered)).encode() + bytes([0]) + altered).hexdigest())
                result, unused = self.call()
                self.assertEqual(result['issues'][0]['domain'], 'workflow', result)
                self.data['source'] = original

    def test_old_deployments_and_statuses_do_not_block_new_selected_chain(self):
        # Synthetic rerun 2: historical attempt-1 deployment/status links cannot veto this new chain.
        self.run_attempt = 2
        self.data['runs']['workflow_runs'][0]['run_attempt'] = 2
        self.data['attempt']['run_attempt'] = 2
        self.data['attempt']['jobs_url'] = 'https://api.github.com' + self.module._path('jobs', run=self.run_id, attempt=2).split('?')[0]
        for job in self.data['jobs']['jobs']:
            job['run_attempt'] = 2
            job['id'] += 100
        selected_job = next(job for job in self.data['jobs']['jobs'] if job['name'] == 'deploy')
        link = 'https://github.com/nanless/audio-paper-digest-blog/actions/runs/' + str(self.run_id) + '/job/' + str(selected_job['id'])
        self.data['statuses'][0].update(log_url=link, target_url=link)
        original = copy.deepcopy(self.data['deployments'][0])
        original.update(id=original['id'] - 1, created_at='2026-10-20T00:00:00Z')
        self.data['deployments'].append(original)
        self.data['statuses'][-1]['log_url'] = 'https://github.com/old/job'
        self.data['statuses'][-1]['target_url'] = 'https://github.com/old/job'
        result, http = self.call()
        self.assertEqual(result['status'], 'metadata_observed', result)
        self.assertEqual(result['selection']['runAttempt'], 2)
        self.assertEqual(result['deployment']['latestStatus']['jobId'], selected_job['id'])
        self.assertFalse(any('/' + str(original['id']) + '/statuses' in call.args[0] for call in http.call_args_list))

    def test_selected_deployment_links_and_latest_state_not_old_success(self):
        for change in ('link', 'environment', 'new_deployment', 'pending', 'failure'):
            with self.subTest(change=change):
                saved_deployments, saved_statuses = copy.deepcopy(self.data['deployments']), copy.deepcopy(self.data['statuses'])
                if change == 'link':
                    self.data['statuses'][0]['target_url'] += '?unexpected=1'
                elif change == 'environment':
                    self.data['deployments'][0]['original_environment'] = 'staging'
                elif change == 'new_deployment':
                    self.data['deployments'].append({**saved_deployments[0], 'id': saved_deployments[0]['id'] + 2,
                        'created_at': '2026-10-22T00:00:00Z'})
                else:
                    self.data['statuses'].append({**saved_statuses[0], 'id': saved_statuses[0]['id'] + 1,
                        'created_at': '2026-10-22T00:00:00Z', 'state': 'waiting' if change == 'pending' else 'error'})
                if change == 'new_deployment':
                    selected = self.data['deployments'][-1]['id']
                    def response(path, **kwargs):
                        if '/deployments/' + str(selected) + '/statuses?' in path:
                            return 200, json.dumps([{**saved_statuses[0], 'target_url': 'https://github.com/other/job'}]).encode()
                        return self.respond(path, **kwargs)
                    result, unused = self.call(response)
                else:
                    result, unused = self.call()
                self.assertNotEqual(result['status'], 'metadata_observed', result)
                self.data['deployments'], self.data['statuses'] = saved_deployments, saved_statuses

    def test_nonempty_artifacts_stay_uninterpreted_and_never_add_digest(self):
        self.data['artifacts'] = {'total_count': 1, 'artifacts': [{'some_future_field': 'opaque'}]}
        result, unused = self.call()
        self.assertEqual(result['status'], 'metadata_observed', result)
        self.assertEqual(result['artifacts']['listing'], 'observed_nonempty_uninterpreted')
        self.assertEqual(result['artifacts']['attemptBinding'], 'not_checked')
        self.assertNotIn('digest', result['artifacts'])

    def test_bounded_pagination_rejects_counts_duplicates_and_full_last_page(self):
        for mode in ('missing', 'duplicate', 'large'):
            with self.subTest(mode=mode):
                saved = copy.deepcopy(self.data['runs'])
                if mode == 'missing':
                    self.data['runs']['total_count'] = 2
                elif mode == 'duplicate':
                    self.data['runs']['workflow_runs'] *= 2
                    self.data['runs']['total_count'] = 2
                else:
                    self.data['runs']['total_count'] = 1001
                result, unused = self.call()
                self.assertNotEqual(result['status'], 'metadata_observed', result)
                self.data['runs'] = saved
        with mock.patch.object(self.module, '_p', side_effect=lambda name: 1 if name == 'pages' else dict(self.module.POLICY)[name]):
            original = self.data['deployments'][0]
            self.data['deployments'] = [{**original, 'id': index + 1} for index in range(100)]
            result, unused = self.call()
            self.issue(result, 'limits', 'unavailable', 'page_count')

    def test_bad_json_duplicate_keys_unknown_error_and_no_retries(self):
        for payload, reason in ((b'{', 'json_shape'), (b'{"id":1,"id":2}', 'duplicate_key'), (b'{"x":NaN}', 'json_shape')):
            with self.subTest(payload=payload), mock.patch.object(self.module, '_get', return_value=(200, payload)) as http:
                result = self.module.collect_github_pages_metadata(self.commit)
                self.issue(result, 'api', 'invalid', reason)
                self.assertEqual(http.call_count, 1)
        with mock.patch.object(self.module, '_get', side_effect=self.module.DeploymentMetadataError('network', 'unavailable', 'secret_token')):
            result = self.module.collect_github_pages_metadata(self.commit)
            self.issue(result, 'api', 'invalid', 'response_shape')
            self.assertNotIn('secret_token', json.dumps(result))

    def test_small_budget_stops_before_request_or_row_dispatch(self):
        values = dict(self.module.POLICY)
        for key, value, reason in (('request_count', 1, 'request_count'), ('total_bytes', 1, 'total_bytes'),
                                   ('nodes', 1, 'node_count'), ('string_bytes', 1, 'string_bytes')):
            with self.subTest(key=key), mock.patch.object(self.module, '_p', side_effect=lambda name: value if name == key else values[name]):
                result, http = self.call()
                self.assertEqual(result['issues'][0]['domain'], 'limits', result)
                self.assertLessEqual(http.call_count, 1)
        with mock.patch.object(self.module, '_p', side_effect=lambda name: 1 if name == 'response_bytes' else values[name]):
            result, http = self.call()
            self.issue(result, 'limits', 'unavailable', 'response_bytes')
            self.assertEqual(http.call_count, 1)

    def test_result_limit_preserves_actual_request_ledger_without_new_dispatch(self):
        baseline, first_http = self.call()
        self.assertEqual(baseline['status'], 'metadata_observed')
        compact = json.dumps({key: value for key, value in baseline.items() if key != 'metadataSha256'},
            ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
        values = dict(self.module.POLICY)
        with mock.patch.object(self.module, '_p', side_effect=lambda name: len(compact) - 1 if name == 'result_bytes' else values[name]):
            result, http = self.call()
        self.issue(result, 'limits', 'unavailable', 'result_bytes')
        self.assertEqual(http.call_count, first_http.call_count)
        self.assertEqual(result['requests'], baseline['requests'])
        self.assertEqual(len(result['requests']), http.call_count)

    def test_actual_private_transport_is_fixed_tls_get_without_auth_proxy_redirects(self):
        record = {}
        class Response:
            status = 200
            def getheader(self, key, default=''):
                return {'Content-Type': 'application/json', 'Content-Encoding': 'identity'}.get(key, default)
            def read(self, size):
                value = b'{}' if not record.get('read') else b''
                record['read'] = True
                return value
        class Connection:
            sock = None
            def __init__(self, host, port, **kwargs):
                record.update(host=host, port=port, kwargs=kwargs)
            def request(self, method, path, headers):
                record.update(method=method, path=path, headers=headers)
            def getresponse(self):
                return Response()
            def close(self):
                record['closed'] = True
        with mock.patch.object(self.module.http.client, 'HTTPSConnection', Connection), mock.patch.dict(os.environ,
                {'HTTPS_PROXY': 'http://private.invalid', 'GH_TOKEN': 'secret-canary'}):
            status, body = self.module._get('/repos/nanless/audio-paper-digest-blog', stop=self.module.time.monotonic() + 10, limit=100)
        self.assertEqual((status, body), (200, b'{}'))
        self.assertEqual((record['host'], record['port'], record['method']), ('api.github.com', 443, 'GET'))
        self.assertTrue(record['kwargs']['context'].check_hostname)
        self.assertNotIn('Authorization', record['headers'])
        self.assertNotIn('secret-canary', repr(record))
        self.assertTrue(record['closed'])

    def test_transport_limits_errors_and_control_objects_close_without_following(self):
        for status, encoding, data, expected in ((302, 'identity', b'', 'redirect'),
                (403, 'identity', b'', 'http_status'), (429, 'identity', b'', 'http_status'),
                (200, 'gzip', b'', 'content_encoding'), (200, 'identity', b'xxxx', 'response_bytes')):
            with self.subTest(status=status, encoding=encoding):
                closed = []
                class Response:
                    def getheader(self, key, default=''):
                        return {'Content-Type': 'application/json', 'Content-Encoding': encoding}.get(key, default)
                    def read(self, size):
                        return data[:size]
                response = Response()
                response.status = status
                connection = mock.Mock(sock=None)
                connection.getresponse.return_value = response
                connection.close.side_effect = lambda: closed.append(True)
                with mock.patch.object(self.module.http.client, 'HTTPSConnection', return_value=connection):
                    with self.assertRaises(self.module.DeploymentMetadataError) as error:
                        self.module._get('/repos/fixed', stop=self.module.time.monotonic() + 10, limit=3)
                self.assertEqual(error.exception.reason, expected)
                self.assertEqual(closed, [True])
                self.assertEqual(connection.request.call_count, 1)
        control = KeyboardInterrupt('original')
        with mock.patch.object(self.module, '_get', side_effect=control):
            with self.assertRaises(KeyboardInterrupt) as caught:
                self.module.collect_github_pages_metadata(self.commit)
            self.assertIs(caught.exception, control)
        for control in (KeyboardInterrupt('original-read'), SystemExit(73)):
            with self.subTest(control=type(control).__name__):
                response = mock.Mock(status=200)
                response.getheader.side_effect = lambda key, default='': {'Content-Type': 'application/json', 'Content-Encoding': 'identity'}.get(key, default)
                response.read.side_effect = control
                connection = mock.Mock(sock=None)
                connection.getresponse.return_value = response
                connection.close.side_effect = OSError('cleanup-canary')
                with mock.patch.object(self.module.http.client, 'HTTPSConnection', return_value=connection):
                    try:
                        self.module._get('/repos/fixed', stop=self.module.time.monotonic() + 10, limit=100)
                    except BaseException as error:
                        self.assertIs(error, control)
                    else:
                        self.fail('Expected the original control object')
                connection.close.assert_called_once()

    def test_import_has_no_runtime_guard_or_business_network_and_direct_main_rejects_sandbox(self):
        source = Path(self.module.__file__)
        script = '''
import builtins, importlib, pathlib, socket, ssl, sys
from unittest import mock
for name in ('base64','datetime','hashlib','http.client','json','re','socket','ssl','time'):
 importlib.import_module(name)
raw=pathlib.Path(sys.argv[1]).read_bytes()
real=builtins.__import__
def checked(name,*args,**kwargs):
 if name=='runtime_guard': raise AssertionError('eager guard')
 return real(name,*args,**kwargs)
with mock.patch('builtins.open',side_effect=AssertionError('file')), mock.patch('socket.socket',side_effect=AssertionError('network')), mock.patch('ssl.create_default_context',side_effect=AssertionError('tls')), mock.patch('builtins.__import__',side_effect=checked):
 exec(compile(raw,str(sys.argv[1]),'exec'),{'__name__':'_private_no_io'})
'''
        result = subprocess.run([sys.executable, '-B', '-c', script, str(source)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        env = dict(os.environ, CODEX_SANDBOX='seatbelt')
        result = subprocess.run([sys.executable, '-B', str(source)], env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('CODEX_SANDBOX', result.stderr)


if __name__ == '__main__':
    unittest.main()
