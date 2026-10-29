"""Synthetic-only redirect regression tests; no product imports, env or network.

AST loading executes only the named definitions, never project startup/configuration.
The real urllib error/redirect dispatch runs over in-memory transport responses.
Proxy wiring is inspected, not connected; normal policy/account/ledger collaborators
are isolated mocks, so these tests do not claim live CONNECT or model integration.
"""
import ast
import contextlib
import io
import json
from email.message import Message
from pathlib import Path
import random
import socket
import time
import types
import unittest
from unittest.mock import Mock, patch
import urllib.error
import urllib.request
import urllib.response


SOURCE = Path(__file__).resolve().parents[2] / 'scripts' / 'publish_common.py'
DEFINITIONS = {
    '_PublishLLMRedirectError', '_PublishLLMNoRedirectHandler',
    '_read_publish_http_error', '_sanitize_publish_llm_error',
    '_open_publish_json_with_account_pool', 'call_publish_llm_api',
}
TREE = ast.parse(SOURCE.read_text(encoding='utf-8'), filename='scripts/publish_common.py')
SELECTED = [node for node in TREE.body if isinstance(node, (ast.ClassDef, ast.FunctionDef))
            and node.name in DEFINITIONS]
REAL_BUILD_OPENER = urllib.request.build_opener
SYNTHETIC_MARKER = 'AUDIT_ONLY_PRIVATE_RESPONSE_MARKER'
SYNTHETIC_KEY = 'AUDIT_ONLY_NOT_A_REAL_CREDENTIAL'
SUCCESS = {'choices': [{'message': {'content': 'synthetic success'}, 'finish_reason': 'stop'}]}
STATUSES = (301, 302, 303, 307, 308)
TARGETS = (
    'https://second.example/v1?token=' + SYNTHETIC_MARKER,
    'http://first.example/v1?token=' + SYNTHETIC_MARKER,
    'https://fixture-user:' + SYNTHETIC_MARKER + '@second.example/v1',
    '/same-origin?token=' + SYNTHETIC_MARKER,
    'file:///synthetic/' + SYNTHETIC_MARKER,
    'ftp://second.example/' + SYNTHETIC_MARKER,
    'http://[malformed/' + SYNTHETIC_MARKER,
    None,
)


class Fixture:
    def __init__(self, responses, *, proxy=False, go=False, keys=None):
        self.responses = list(responses)
        self.requests = []
        self.reply_objects = []
        self.events = []
        self.proxy_maps = []
        self.installed_handlers = []
        self.output = io.StringIO()
        self.go = go
        self.keys = keys or [SYNTHETIC_KEY]
        self.next_account = 0
        self.sleep = Mock()
        self.quota = Mock(return_value=None)
        self.mark_quota = Mock(return_value=1_800_000_000_000)
        self.proxy_lookup = Mock(return_value='http://fixture-user:fixture-password@proxy.example:8080')
        self.ns = self.make_namespace(proxy)
        assert {node.name for node in SELECTED} == DEFINITIONS
        module = ast.Module(body=SELECTED, type_ignores=[])
        exec(compile(module, 'scripts/publish_common.py', 'exec'), self.ns)

    def make_namespace(self, proxy):
        owner = self

        class SyntheticHTTPS(urllib.request.HTTPSHandler):
            def https_open(self, req):
                return owner.response(req)

        class SyntheticHTTP(urllib.request.HTTPHandler):
            def http_open(self, req):
                return owner.response(req)

        def build_opener(*handlers):
            owner.installed_handlers.extend(handlers)
            for handler in handlers:
                if isinstance(handler, urllib.request.ProxyHandler):
                    owner.proxy_maps.append(dict(handler.proxies))
            # Exercise actual redirect/error dispatch without proxy_bypass/env/DNS.
            safe_handlers = [h for h in handlers if not isinstance(h, urllib.request.ProxyHandler)]
            return REAL_BUILD_OPENER(
                urllib.request.ProxyHandler({}), *safe_handlers, SyntheticHTTP(), SyntheticHTTPS(),
            )

        def select_key(keys, endpoint, state, **kwargs):
            index = self.next_account
            self.next_account += 1
            return {'api_key': keys[index], 'account_id': 'synthetic-account-' + str(index)}

        errors = {name: type(name, (RuntimeError,), {}) for name in (
            'PublishLLMUnavailable', 'LlmUsagePersistenceError', 'LlmAccountPoolExhaustedError',
            'LlmAccountAuthError', 'LlmAccountPoolStateError', 'LlmAccountPoolConfigError',
        )}
        for name in ('LlmUsagePersistenceError', 'LlmAccountAuthError'):
            errors[name].scope = 'run'
        from datetime import datetime, timezone
        return {
            '__name__': 'synthetic_redirect_fixture', **errors,
            'urllib': types.SimpleNamespace(error=urllib.error, request=types.SimpleNamespace(
                HTTPRedirectHandler=urllib.request.HTTPRedirectHandler,
                ProxyHandler=urllib.request.ProxyHandler, Request=urllib.request.Request,
                build_opener=build_opener)),
            'os': types.SimpleNamespace(environ={
                'PAPER_ANALYZER_API_KEY': self.keys[0],
                'PAPER_ANALYZER_ENDPOINT': 'https://first.example/v1',
                'PAPER_ANALYZER_MODEL': 'muse-spark-fixture' if proxy else 'fixture-model',
            }),
            'json': json, 're': __import__('re'), 'Path': Path,
            'time': types.SimpleNamespace(monotonic=time.monotonic, sleep=self.sleep),
            'random': random, 'datetime': datetime, 'timezone': timezone,
            'LLM_ACCOUNT_POOL_STATE_FILE': Path('synthetic-unused-state'),
            'resolve_primary_api_key_pool': lambda *args: list(self.keys),
            'detect_publish_api_type': lambda *args: 'openai',
            'build_publish_api_url': lambda protocol, endpoint: endpoint + '/chat/completions',
            '_canonical_publish_request_url': lambda url: url,
            'is_opencode_go_endpoint': lambda endpoint: self.go,
            'build_publish_headers': lambda protocol, key: {
                'Authorization': 'Bearer ' + key, 'x-api-key': key},
            'build_publish_payload': lambda protocol, model, prompt, *args, **kwargs: {
                'model': model, 'messages': [{'role': 'user', 'content': prompt}]},
            '_publish_llm_requires_proxy': lambda endpoint, model: model.startswith('muse-spark-'),
            'get_required_fetch_proxy': self.proxy_lookup,
            'with_llm_usage_context': lambda *args: contextlib.nullcontext(),
            'begin_pending_llm_request': lambda **kwargs: {'eventId': 'synthetic-event-' + str(len(self.events))},
            'record_llm_usage': lambda **kwargs: self.events.append(kwargs),
            'parse_publish_response_text': lambda protocol, body: (
                body.get('choices', [{}])[0].get('message', {}).get('content', '') if body else ''),
            'select_api_key': select_key, '_publish_opencode_session_id': lambda: 'synthetic-session',
            'classify_opencode_go_quota_response': self.quota,
            'mark_quota_exhausted': self.mark_quota,
        }

    def response(self, req):
        self.requests.append(req)
        if not self.responses:
            raise AssertionError('unexpected second dispatch')
        code, body, location = self.responses.pop(0)
        headers = Message()
        if location is not None:
            headers['Location'] = location
        response = urllib.response.addinfourl(io.BytesIO(body), headers, req.full_url, code)
        response.msg = SYNTHETIC_MARKER if code in STATUSES else 'synthetic status'
        self.reply_objects.append(response)
        return response

    def call(self, **kwargs):
        # Even an accidental failure of the memory transport must not open a socket.
        with patch.object(socket, 'create_connection', side_effect=AssertionError('network forbidden')), \
                patch.object(socket, 'socket', side_effect=AssertionError('network forbidden')), \
                contextlib.redirect_stdout(self.output):
            return self.ns['call_publish_llm_api']('synthetic public prompt', **kwargs)


class PublishRedirectSecurityTests(unittest.TestCase):
    def test_handler_rejects_all_target_forms_before_location_parsing(self):
        fixture = Fixture([])
        handler = fixture.ns['_PublishLLMNoRedirectHandler']()
        for code in STATUSES:
            for target in TARGETS:
                with self.subTest(code=code, target_form=TARGETS.index(target)):
                    request = urllib.request.Request(
                        'https://first.example/v1', data=b'synthetic payload',
                        headers={'Authorization': 'Bearer ' + SYNTHETIC_KEY, 'x-api-key': SYNTHETIC_KEY},
                    )
                    body = io.BytesIO(SYNTHETIC_MARKER.encode())
                    headers = {'Location': target} if target is not None else {}
                    with self.assertRaises(fixture.ns['_PublishLLMRedirectError']) as caught:
                        getattr(handler, 'http_error_' + str(code))(
                            request, body, code, SYNTHETIC_MARKER, headers,
                        )
                    error = caught.exception
                    self.assertEqual(error.code, code)
                    self.assertTrue(body.closed)
                    self.assertFalse(error.url)
                    self.assertFalse(error.headers)
                    self.assertFalse(error.read())
                    self.assertNotIn(SYNTHETIC_MARKER, str(error))
                    self.assertNotIn(SYNTHETIC_KEY, str(error))
                    self.assertIsNone(error.__cause__)
                    self.assertTrue(error.__suppress_context__)
                    self.assertTrue(request.has_header('Authorization'))

    def test_direct_transformation_hook_also_refuses(self):
        fixture = Fixture([])
        handler = fixture.ns['_PublishLLMNoRedirectHandler']()
        with self.assertRaises(fixture.ns['_PublishLLMRedirectError']):
            handler.redirect_request(None, None, 302, SYNTHETIC_MARKER, {}, TARGETS[0])

    def test_cleanup_failure_does_not_replace_fixed_denial(self):
        fixture = Fixture([])
        body = Mock()
        body.close.side_effect = RuntimeError(SYNTHETIC_MARKER)
        with self.assertRaises(fixture.ns['_PublishLLMRedirectError']) as caught:
            fixture.ns['_PublishLLMNoRedirectHandler']().http_error_302(
                None, body, 302, SYNTHETIC_MARKER, {'Location': TARGETS[0]},
            )
        self.assertNotIn(SYNTHETIC_MARKER, str(caught.exception))
        self.assertTrue(caught.exception.__suppress_context__)

    def test_public_call_installs_guard_in_both_proxy_branches_and_does_not_retry(self):
        for proxy in (False, True):
            for code, target in ((code, target) for code in STATUSES for target in TARGETS):
                with self.subTest(proxy=proxy, code=code, target_form=TARGETS.index(target)):
                    fixture = Fixture([(code, SYNTHETIC_MARKER.encode(), target)], proxy=proxy)
                    with self.assertRaises(fixture.ns['PublishLLMUnavailable']) as caught:
                        fixture.call(required=True, max_retries=5)
                    self.assertEqual(len(fixture.requests), 1)
                    self.assertEqual(len(fixture.events), 1)
                    self.assertEqual(fixture.events[0]['status_code'], code)
                    self.assertTrue(fixture.events[0]['transport_started'])
                    self.assertTrue(fixture.events[0]['event_id'].startswith('synthetic-event-'))
                    self.assertTrue(fixture.reply_objects[0].closed)
                    self.assertTrue(any(isinstance(h, fixture.ns['_PublishLLMNoRedirectHandler'])
                                        for h in fixture.installed_handlers))
                    self.assertNotIn(SYNTHETIC_MARKER, fixture.output.getvalue() + str(caught.exception)
                                     + json.dumps(fixture.events))
                    self.assertNotIn(SYNTHETIC_KEY, fixture.output.getvalue() + str(caught.exception)
                                     + json.dumps(fixture.events))
                    fixture.sleep.assert_not_called()
                    self.assertEqual(fixture.proxy_lookup.call_count, int(proxy))
                    self.assertEqual(bool(fixture.proxy_maps[0]), proxy)

    def test_optional_redirect_failure_is_not_success_and_does_not_retry(self):
        fixture = Fixture([(302, b'synthetic body', TARGETS[0])])
        self.assertIsNone(fixture.call(required=False, max_retries=5))
        self.assertEqual(len(fixture.requests), 1)
        fixture.sleep.assert_not_called()

    def test_success_and_usage_binding_are_preserved(self):
        for proxy in (False, True):
            fixture = Fixture([(200, json.dumps(SUCCESS).encode(), None)], proxy=proxy)
            self.assertEqual(fixture.call(required=True), 'synthetic success')
            self.assertEqual(len(fixture.requests), 1)
            self.assertEqual(fixture.events[0]['status_code'], 200)
            self.assertEqual(fixture.events[0]['response'], SUCCESS)
            self.assertEqual(fixture.events[0]['event_id'], 'synthetic-event-0')
            self.assertTrue(fixture.events[0]['transport_started'])
            self.assertTrue(fixture.requests[0].has_header('Authorization'))
            self.assertTrue(fixture.requests[0].has_header('X-api-key'))
            fixture.sleep.assert_not_called()

    def test_original_http_failures_keep_status_and_bounded_retry(self):
        body = b'{"error":{"message":"synthetic provider rejection"}}'
        for code in (400, 401, 403, 429, 500, 503):
            with self.subTest(code=code):
                fixture = Fixture([(code, body, None), (code, body, None)])
                with self.assertRaises(fixture.ns['PublishLLMUnavailable']):
                    fixture.call(required=True, max_retries=2)
                self.assertEqual(len(fixture.requests), 2)
                self.assertEqual([e['status_code'] for e in fixture.events], [code, code])
                self.assertIn('synthetic provider rejection', fixture.output.getvalue())
                self.assertEqual(fixture.sleep.call_count, 1)
                fixture.mark_quota.assert_not_called()

    def test_go_authentication_failure_still_stops_without_switching_accounts(self):
        fixture = Fixture([(401, b'{"error":"synthetic denied"}', None)], go=True,
                          keys=[SYNTHETIC_KEY, 'AUDIT_SECOND_SYNTHETIC_KEY'])
        with self.assertRaises(fixture.ns['LlmAccountAuthError']):
            fixture.call(required=True, max_retries=5)
        self.assertEqual(len(fixture.requests), 1)
        self.assertEqual(fixture.next_account, 1)
        self.assertEqual(fixture.events[0]['status_code'], 401)
        fixture.mark_quota.assert_not_called()
        fixture.sleep.assert_not_called()

    def test_confirmed_go_quota_switch_and_per_attempt_usage_are_unchanged(self):
        fixture = Fixture([(429, b'{"error":"synthetic quota"}', None),
                           (200, json.dumps(SUCCESS).encode(), None)], go=True,
                          keys=[SYNTHETIC_KEY, 'AUDIT_SECOND_SYNTHETIC_KEY'])
        fixture.quota.side_effect = lambda status, *args, **kwargs: (
            {'limit_class': 'synthetic quota'} if status == 429 else None)
        self.assertEqual(fixture.call(required=True), 'synthetic success')
        self.assertEqual(len(fixture.requests), 2)
        self.assertEqual([e['status_code'] for e in fixture.events], [429, 200])
        self.assertEqual([e['event_id'] for e in fixture.events],
                         ['synthetic-event-0', 'synthetic-event-1'])
        self.assertEqual(fixture.mark_quota.call_count, 1)
        fixture.sleep.assert_not_called()

    def test_usage_persistence_failure_remains_terminal(self):
        fixture = Fixture([(200, json.dumps(SUCCESS).encode(), None)])
        fixture.ns['record_llm_usage'] = Mock(side_effect=fixture.ns['LlmUsagePersistenceError'](
            'synthetic persistence failure'))
        with self.assertRaises(fixture.ns['LlmUsagePersistenceError']):
            fixture.call(required=True, max_retries=5)
        self.assertEqual(len(fixture.requests), 1)
        fixture.sleep.assert_not_called()


if __name__ == '__main__':
    unittest.main()
