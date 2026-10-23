"""Fixed, anonymous Pages metadata observations, never publication authority."""

import base64
import datetime
import hashlib
import http.client
import json
import re
import socket
import ssl
import time


POLICY_NAMES = ('POLICY',)
POLICY = (
    ('contract', 'github-pages-metadata-observation-v1'), ('version', 1),
    ('host', 'api.github.com'), ('repository', 'nanless/audio-paper-digest-blog'),
    ('repository_id', 1214235086), ('workflow_id', 262722446),
    ('workflow_path', '.github/workflows/hugo.yaml'), ('branch', 'main'),
    ('workflow_name', 'Deploy Hugo to Pages'), ('event', 'push'),
    ('environment', 'github-pages'), ('profile', 'fixed-hugo-workflow-v1'),
    ('workflow_sha256', 'cbf3a52e317973a4273f5c64c0a8d4e1c5dda2ee709f0e4ad12863c78cc5fe0d'),
    ('headers', (('User-Agent', 'audio-paper-digest-deployment-observer/1'),
                 ('Accept', 'application/vnd.github+json'), ('Accept-Encoding', 'identity'),
                 ('X-GitHub-Api-Version', '2022-11-28'))),
    ('response_bytes', 2 * 1024 * 1024), ('total_bytes', 24 * 1024 * 1024),
    ('request_count', 48), ('pages', 10), ('page_size', 100), ('rows', 1000),
    ('nodes', 100000), ('total_nodes', 48 * 100000), ('depth', 32), ('string_bytes', 8192),
    ('workflow_bytes', 64 * 1024), ('workflow_encoded_bytes', 96 * 1024),
    ('result_bytes', 1024 * 1024), ('deadline', 120), ('socket_timeout', 20),
    ('max_id', 9007199254740991),
    ('roles', ('unit', 'build', 'deploy')),
    ('steps', (('unit', ((5, 'Unit checks'),)),
               ('build', ((6, 'Build and verify'), (7, 'Upload artifact'))),
               ('deploy', ((2, 'Deploy to GitHub Pages'),)))),
    ('pending', ('queued', 'in_progress', 'waiting', 'pending', 'requested')),
    ('failure', ('failure', 'cancelled', 'timed_out', 'action_required', 'stale',
                 'startup_failure', 'skipped', 'neutral')),
    ('deployment_pending', ('waiting', 'queued', 'in_progress', 'pending')),
    ('deployment_failure', ('failure', 'error', 'inactive')),
    ('errors', (
        ('input', 'invalid', ('commit_oid',)),
        ('network', 'unavailable', ('tls_failed', 'connect_failed', 'read_failed', 'timeout', 'redirect', 'http_status', 'content_encoding')),
        ('api', 'invalid', ('response_shape', 'json_shape', 'duplicate_key', 'field_type', 'timestamp')),
        ('selection', 'unavailable', ('run_not_observed',)),
        ('selection', 'ambiguous', ('identity_mismatch',)),
        ('selection', 'stale', ('pagination_changed', 'frontier_changed')),
        ('selection', 'unsupported', ('event_profile',)),
        ('selection', 'pending', ('run_pending',)), ('selection', 'failed', ('run_failed',)),
        ('workflow', 'unavailable', ('workflow_missing',)),
        ('workflow', 'invalid', ('source_identity',)), ('workflow', 'unsupported', ('workflow_profile',)),
        ('jobs', 'unavailable', ('jobs_incomplete',)),
        ('jobs', 'invalid', ('job_identity', 'step_identity', 'dependency_time')),
        ('jobs', 'unsupported', ('role_profile',)),
        ('jobs', 'pending', ('job_pending',)), ('jobs', 'failed', ('job_failed',)),
        ('deployment', 'unavailable', ('deployment_missing',)),
        ('deployment', 'ambiguous', ('deployment_selection',)),
        ('deployment', 'invalid', ('deployment_identity', 'status_identity', 'job_link')),
        ('deployment', 'stale', ('frontier_changed',)),
        ('deployment', 'pending', ('deployment_pending',)), ('deployment', 'failed', ('deployment_failed',)),
        ('artifacts', 'unavailable', ('artifact_listing',)), ('artifacts', 'invalid', ('artifact_shape',)),
        ('limits', 'unavailable', ('response_bytes', 'total_bytes', 'request_count', 'page_count', 'row_count',
            'node_count', 'string_bytes', 'workflow_bytes', 'result_bytes', 'deadline')),
    )),
)


class DeploymentMetadataError(ValueError):
    def __init__(self, domain, code, reason, received=0, digest=None, status=None):
        self.domain, self.code, self.reason = domain, code, reason
        self.received, self.digest, self.status = received, digest, status
        ValueError.__init__(self, domain, code, reason)


def _p(name):
    for key, value in POLICY:
        if key == name:
            return value
    raise DeploymentMetadataError('api', 'invalid', 'response_shape')


def _fail(domain, code, reason):
    raise DeploymentMetadataError(domain, code, reason)


def _integer(value, zero=False):
    if type(value) is not int or not (0 if zero else 1) <= value <= _p('max_id'):
        _fail('api', 'invalid', 'field_type')
    return value


def _text(value, limit=None):
    maximum = _p('string_bytes') if limit is None else limit
    if type(value) is not str:
        _fail('api', 'invalid', 'field_type')
    if len(value) > maximum:
        _fail('limits', 'unavailable', 'string_bytes')
    try:
        if len(value.encode('utf-8', 'strict')) > maximum:
            _fail('limits', 'unavailable', 'string_bytes')
    except UnicodeError:
        _fail('api', 'invalid', 'field_type')
    return value


def _oid(value):
    if type(value) is not str or re.fullmatch('[0-9a-f]{40}', value) is None:
        _fail('api', 'invalid', 'field_type')
    return value


def _stamp(value):
    _text(value, 64)
    if re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z', value) is None:
        _fail('api', 'invalid', 'timestamp')
    try:
        return datetime.datetime.fromisoformat(value[:-1] + '+00:00')
    except ValueError:
        _fail('api', 'invalid', 'timestamp')


def _hash(value):
    digest, used = hashlib.sha256(), 0
    encoder = json.JSONEncoder(ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
    for piece in encoder.iterencode(value):
        # No user-sized hex/string expansion is performed here; normalized fields are bounded.
        if len(piece) > _p('result_bytes') - used:
            _fail('limits', 'unavailable', 'result_bytes')
        encoded = piece.encode('utf-8', 'strict')
        if len(encoded) > _p('result_bytes') - used:
            _fail('limits', 'unavailable', 'result_bytes')
        used += len(encoded)
        digest.update(encoded)
    return digest.hexdigest()


class _Budget:
    def __init__(self):
        self.stop = time.monotonic() + _p('deadline')
        self.received, self.nodes, self.total_nodes, self.retained = 0, 0, 0, 0
        self.requests = []

    def check(self):
        if time.monotonic() >= self.stop:
            _fail('limits', 'unavailable', 'deadline')

    def inspect(self, value, depth=0, content=False):
        if (depth > _p('depth') or self.nodes >= _p('nodes')
                or self.total_nodes >= _p('total_nodes')):
            _fail('limits', 'unavailable', 'node_count')
        self.nodes += 1
        self.total_nodes += 1
        if type(value) is dict:
            for key, item in value.items():
                _text(key)
                self.inspect(item, depth + 1, content=content and key == 'content')
        elif type(value) is list:
            for item in value:
                self.inspect(item, depth + 1)
        elif type(value) is str:
            _text(value, _p('workflow_encoded_bytes') if content else None)
        elif value is not None and type(value) not in (int, bool):
            _fail('api', 'invalid', 'field_type')

    def keep(self, value):
        # Reserve before adding another normalized row to a retained collection.
        for piece in json.JSONEncoder(ensure_ascii=False, separators=(',', ':'), allow_nan=False).iterencode(value):
            if len(piece) > _p('total_bytes') - self.retained:
                _fail('limits', 'unavailable', 'total_bytes')
            size = len(piece.encode('utf-8', 'strict'))
            if size > _p('total_bytes') - self.retained:
                _fail('limits', 'unavailable', 'total_bytes')
            self.retained += size


def _get(path, *, stop, limit):
    """Private fixed-host transport. Tests replace this boundary, never public policy."""
    connection, received, primary, control = None, 0, False, None
    digest, body, status = hashlib.sha256(), bytearray(), None
    try:
        remaining = stop - time.monotonic()
        if remaining <= 0:
            _fail('limits', 'unavailable', 'deadline')
        context = ssl.create_default_context()
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        connection = http.client.HTTPSConnection(_p('host'), 443,
            timeout=min(_p('socket_timeout'), remaining), context=context)
        connection.request('GET', path, headers=dict(_p('headers')))
        response = connection.getresponse()
        status = response.status
        if status != 200:
            raise DeploymentMetadataError('network', 'unavailable',
                'redirect' if 300 <= status < 400 else 'http_status', status=status)
        if response.getheader('Content-Encoding', 'identity').lower() != 'identity':
            raise DeploymentMetadataError('network', 'unavailable', 'content_encoding', status=status)
        media = response.getheader('Content-Type', '').split(';', 1)[0].strip().lower()
        if media not in ('application/json', 'application/vnd.github+json'):
            raise DeploymentMetadataError('api', 'invalid', 'response_shape', status=status)
        while True:
            remaining = stop - time.monotonic()
            if remaining <= 0:
                raise DeploymentMetadataError('limits', 'unavailable', 'deadline', received, digest.hexdigest(), status)
            if connection.sock is not None:
                connection.sock.settimeout(min(_p('socket_timeout'), remaining))
            chunk = response.read(min(65536, limit - received + 1))
            if not chunk:
                break
            received += len(chunk)
            digest.update(chunk)
            if received > limit:
                raise DeploymentMetadataError('limits', 'unavailable', 'response_bytes', received, digest.hexdigest(), status)
            body.extend(chunk)
        return status, bytes(body)
    except (KeyboardInterrupt, SystemExit) as error:
        primary, control = True, error
        raise
    except DeploymentMetadataError:
        primary = True
        raise
    except ssl.SSLError:
        primary = True
        raise DeploymentMetadataError('network', 'unavailable', 'tls_failed', received, digest.hexdigest(), status) from None
    except (TimeoutError, socket.timeout):
        primary = True
        raise DeploymentMetadataError('network', 'unavailable', 'timeout', received, digest.hexdigest(), status) from None
    except (OSError, http.client.HTTPException):
        primary = True
        raise DeploymentMetadataError('network', 'unavailable', 'read_failed', received, digest.hexdigest(), status) from None
    finally:
        if connection is not None:
            try:
                connection.close()
            except (KeyboardInterrupt, SystemExit):
                if control is None:
                    raise
            except Exception:
                if not primary:
                    raise DeploymentMetadataError('network', 'unavailable', 'read_failed', received, digest.hexdigest(), status) from None


def _pairs(items):
    value = {}
    for key, item in items:
        if key in value:
            _fail('api', 'invalid', 'duplicate_key')
        value[key] = item
    return value


def _constant(value):
    _fail('api', 'invalid', 'json_shape')


def _request(budget, path, page=None, content=False):
    budget.check()
    if len(budget.requests) >= _p('request_count'):
        _fail('limits', 'unavailable', 'request_count')
    remaining = _p('total_bytes') - budget.received
    if remaining <= 0:
        _fail('limits', 'unavailable', 'total_bytes')
    record = {'ordinal': len(budget.requests) + 1, 'route': path, 'page': page,
              'httpStatus': None, 'bytes': 0, 'sha256': None, 'outcome': 'invalid'}
    budget.requests.append(record)
    try:
        status, body = _get(path, stop=budget.stop, limit=min(_p('response_bytes'), remaining))
        if type(status) is not int or status != 200 or type(body) is not bytes:
            _fail('api', 'invalid', 'response_shape')
        record.update(httpStatus=status, bytes=len(body), sha256=hashlib.sha256(body).hexdigest())
        budget.received += len(body)
        if len(body) > _p('response_bytes') or budget.received > _p('total_bytes'):
            _fail('limits', 'unavailable', 'response_bytes' if len(body) > _p('response_bytes') else 'total_bytes')
        try:
            value = json.loads(body.decode('utf-8', 'strict'), object_pairs_hook=_pairs, parse_constant=_constant)
        except (UnicodeError, json.JSONDecodeError, RecursionError):
            _fail('api', 'invalid', 'json_shape')
        # Each complete response has its own cap; all requests, including final
        # frontier rereads, also consume the same invocation aggregate.
        budget.nodes = 0
        budget.inspect(value, content=content)
        budget.check()
        record['outcome'] = 'received'
        return value
    except DeploymentMetadataError as error:
        if error.received:
            budget.received += error.received
            record.update(bytes=error.received, sha256=error.digest)
        if error.status is not None:
            record['httpStatus'] = error.status
        record['outcome'] = ('limit' if error.domain == 'limits' else
            'timeout' if error.reason == 'timeout' else 'http_error' if error.reason in ('http_status', 'redirect') else 'invalid')
        raise


def _root():
    return '/repos/' + _p('repository')


def _path(kind, page=1, run=None, attempt=None, deployment=None, commit=None):
    suffix = '?per_page=100&page=' + str(page)
    if kind == 'repository':
        return _root()
    if kind == 'workflows':
        return _root() + '/actions/workflows' + suffix
    if kind == 'runs':
        return _root() + '/actions/workflows/' + str(_p('workflow_id')) + '/runs?branch=' + _p('branch') + '&per_page=100&page=' + str(page)
    if kind == 'attempt':
        return _root() + '/actions/runs/' + str(run) + '/attempts/' + str(attempt)
    if kind == 'jobs':
        return _path('attempt', run=run, attempt=attempt) + '/jobs' + suffix
    if kind == 'source':
        return _root() + '/contents/' + _p('workflow_path') + '?ref=' + commit
    if kind == 'deployments':
        return _root() + '/deployments?sha=' + commit + '&environment=github-pages&per_page=100&page=' + str(page)
    if kind == 'statuses':
        return _root() + '/deployments/' + str(deployment) + '/statuses' + suffix
    if kind == 'artifacts':
        return _root() + '/actions/runs/' + str(run) + '/artifacts' + suffix
    _fail('api', 'invalid', 'response_shape')


def _repository(value):
    if type(value) is not dict:
        _fail('api', 'invalid', 'response_shape')
    return {'id': _integer(value.get('id')), 'fullName': _text(value.get('full_name'))}


def _row(kind, row):
    if type(row) is not dict:
        _fail('api', 'invalid', 'response_shape')
    if kind == 'artifacts':
        return {}  # Artifact object fields have not been calibrated; do not invent them.
    result = {'id': _integer(row.get('id'))}
    if kind == 'workflows':
        result.update(path=_text(row.get('path'), 1024), state=_text(row.get('state'), 256))
    elif kind == 'runs':
        conclusion = row.get('conclusion')
        if conclusion is not None:
            _text(conclusion, 256)
        result.update(runNumber=_integer(row.get('run_number')), runAttempt=_integer(row.get('run_attempt')),
            headSha=_oid(row.get('head_sha')), branch=_text(row.get('head_branch'), 256),
            event=_text(row.get('event'), 256), status=_text(row.get('status'), 256), conclusion=conclusion,
            workflowId=_integer(row.get('workflow_id')), path=_text(row.get('path'), 1024),
            repository=_repository(row.get('repository')), headRepository=_repository(row.get('head_repository')),
            jobsUrl=_text(row.get('jobs_url')), referencedWorkflows=row.get('referenced_workflows'))
    elif kind == 'deployments':
        _stamp(row.get('created_at'))
        for key in ('production_environment', 'transient_environment'):
            if type(row.get(key)) is not bool:
                _fail('api', 'invalid', 'field_type')
        result.update(createdAt=row['created_at'], sha=_oid(row.get('sha')), ref=_text(row.get('ref')),
            environment=_text(row.get('environment')), originalEnvironment=_text(row.get('original_environment')),
            task=_text(row.get('task')), productionEnvironment=row['production_environment'],
            transientEnvironment=row['transient_environment'])
    elif kind == 'statuses':
        _stamp(row.get('created_at'))
        result.update(createdAt=row['created_at'], state=_text(row.get('state'), 256),
            environment=_text(row.get('environment')), logUrl=_text(row.get('log_url')),
            targetUrl=_text(row.get('target_url')), environmentUrl=_text(row.get('environment_url')))
    elif kind == 'jobs':
        # Keep only bounded fields needed by the exact fixed role profile.
        steps = row.get('steps')
        if type(steps) is not list or len(steps) > 100:
            _fail('api', 'invalid', 'field_type')
        result.update(runId=_integer(row.get('run_id')), runAttempt=_integer(row.get('run_attempt')),
            headSha=_oid(row.get('head_sha')), branch=_text(row.get('head_branch'), 256),
            name=_text(row.get('name'), 256), workflowName=_text(row.get('workflow_name'), 256),
            status=_text(row.get('status'), 256), conclusion=row.get('conclusion'),
            startedAt=row.get('started_at'), completedAt=row.get('completed_at'), steps=steps)
    else:
        _fail('api', 'invalid', 'response_shape')
    return result


def _page(budget, kind, page, **kwargs):
    value = _request(budget, _path(kind, page=page, **kwargs), page)
    names = {'workflows': 'workflows', 'runs': 'workflow_runs', 'jobs': 'jobs', 'artifacts': 'artifacts'}
    total = None
    if kind in names:
        if type(value) is not dict:
            _fail('api', 'invalid', 'response_shape')
        total, values = _integer(value.get('total_count'), zero=True), value.get(names[kind])
        if total > _p('rows'):
            _fail('limits', 'unavailable', 'row_count')
    else:
        values = value
    if type(values) is not list or len(values) > _p('page_size'):
        _fail('api', 'invalid', 'response_shape')
    rows = []
    for value in values:
        row = _row(kind, value)
        budget.keep(row)
        rows.append(row)
    return total, rows


def _pages(budget, kind, **kwargs):
    rows, seen, pages, total = [], set(), {}, None
    for number in range(1, _p('pages') + 1):
        count, page = _page(budget, kind, number, **kwargs)
        if number == 1:
            total = count
        elif count != total:
            _fail('selection', 'stale', 'pagination_changed')
        if len(rows) + len(page) > _p('rows'):
            _fail('limits', 'unavailable', 'row_count')
        for row in page:
            if kind != 'artifacts':
                if row['id'] in seen:
                    _fail('selection', 'ambiguous', 'identity_mismatch')
                seen.add(row['id'])
        pages[number] = page
        rows.extend(page)
        if total is not None and len(rows) > total:
            _fail('api', 'invalid', 'response_shape')
        if (total is not None and len(rows) == total) or len(page) < _p('page_size'):
            if total is not None and len(rows) != total:
                _fail('selection', 'unavailable', 'run_not_observed')
            return rows, pages, total
    _fail('limits', 'unavailable', 'page_count')


def _projection(kind, rows):
    if kind == 'runs':
        keys = ('id', 'runNumber', 'runAttempt', 'headSha', 'status', 'conclusion', 'workflowId', 'path')
    elif kind == 'deployments':
        keys = ('id', 'createdAt', 'sha', 'ref', 'environment', 'originalEnvironment', 'task')
    else:
        keys = ('id', 'state', 'createdAt', 'logUrl', 'targetUrl', 'environment')
    return [tuple(row[key] for key in keys) for row in rows]


def _final_pages(budget, kind, initial, total, selected, **kwargs):
    numbers = [1]
    for number, rows in initial.items():
        if any(row['id'] == selected for row in rows) and number != 1:
            numbers.append(number)
            break
    for number in numbers:
        count, rows = _page(budget, kind, number, **kwargs)
        if count != total or _projection(kind, rows) != _projection(kind, initial[number]):
            _fail('selection' if kind == 'runs' else 'deployment', 'stale', 'frontier_changed')


def _state(status, conclusion, domain):
    if status == 'completed' and conclusion == 'success':
        return
    if status in _p('pending') and conclusion is None:
        _fail(domain, 'pending', 'run_pending' if domain == 'selection' else 'job_pending')
    if status == 'completed' and conclusion in _p('failure'):
        _fail(domain, 'failed', 'run_failed' if domain == 'selection' else 'job_failed')
    _fail('api', 'invalid', 'field_type')


def _run_identity(run, commit):
    expected = {'id': _p('repository_id'), 'fullName': _p('repository')}
    if (run['headSha'] != commit or run['branch'] != _p('branch') or
            run['workflowId'] != _p('workflow_id') or run['path'] != _p('workflow_path') or
            run['repository'] != expected or run['headRepository'] != expected):
        _fail('selection', 'ambiguous', 'identity_mismatch')
    if run['event'] != _p('event'):
        _fail('selection', 'unsupported', 'event_profile')
    if run['referencedWorkflows'] != []:
        _fail('workflow', 'unsupported', 'workflow_profile')


def _source(budget, commit):
    value = _request(budget, _path('source', commit=commit), content=True)
    if type(value) is not dict or value.get('path') != _p('workflow_path') or value.get('encoding') != 'base64':
        _fail('workflow', 'invalid', 'source_identity')
    content = _text(value.get('content'), _p('workflow_encoded_bytes'))
    if re.fullmatch('[A-Za-z0-9+/=\n]*', content) is None:
        _fail('workflow', 'invalid', 'source_identity')
    encoded = content.replace('\n', '')
    if len(encoded) % 4 or re.fullmatch('[A-Za-z0-9+/]*={0,2}', encoded) is None:
        _fail('workflow', 'invalid', 'source_identity')
    padding = 2 if encoded.endswith('==') else 1 if encoded.endswith('=') else 0
    if len(encoded) // 4 * 3 - padding > _p('workflow_bytes'):
        _fail('limits', 'unavailable', 'workflow_bytes')
    try:
        raw = base64.b64decode(encoded, validate=True)
    except ValueError:
        _fail('workflow', 'invalid', 'source_identity')
    if base64.b64encode(raw).decode('ascii') != encoded or len(raw) > _p('workflow_bytes'):
        _fail('workflow', 'invalid', 'source_identity')
    oid = hashlib.sha1(b'blob ' + str(len(raw)).encode('ascii') + bytes([0]) + raw).hexdigest()
    if type(value.get('size')) is not int or len(raw) != value['size'] or oid != value.get('sha'):
        _fail('workflow', 'invalid', 'source_identity')
    digest = hashlib.sha256(raw).hexdigest()
    if digest != _p('workflow_sha256'):
        _fail('workflow', 'unsupported', 'workflow_profile')
    return {'path': _p('workflow_path'), 'commit': commit, 'gitBlobOid': oid, 'bytes': len(raw),
            'sha256': digest, 'profileMatched': True}


def _jobs(rows, run):
    by_role, result = {}, []
    for row in rows:
        role = row['name']
        if role not in _p('roles') or role in by_role:
            _fail('jobs', 'unsupported', 'role_profile')
        if (row['runId'] != run['id'] or row['runAttempt'] != run['runAttempt'] or
                row['headSha'] != run['headSha'] or row['branch'] != _p('branch') or
                row['workflowName'] != _p('workflow_name')):
            _fail('jobs', 'invalid', 'job_identity')
        _state(row['status'], row['conclusion'], 'jobs')
        _stamp(row['startedAt'])
        _stamp(row['completedAt'])
        if _stamp(row['startedAt']) > _stamp(row['completedAt']):
            _fail('jobs', 'invalid', 'dependency_time')
        selected, numbers = [], set()
        for step in row['steps']:
            if type(step) is not dict:
                _fail('jobs', 'invalid', 'step_identity')
            number, name = _integer(step.get('number')), _text(step.get('name'), 256)
            if number in numbers:
                _fail('jobs', 'invalid', 'step_identity')
            numbers.add(number)
            for wanted, expected_name in dict(_p('steps'))[role]:
                if number == wanted:
                    if name != expected_name:
                        _fail('jobs', 'invalid', 'step_identity')
                    _state(step.get('status'), step.get('conclusion'), 'jobs')
                    selected.append({'number': number, 'name': name,
                        'status': step['status'], 'conclusion': step['conclusion']})
        if len(selected) != len(dict(_p('steps'))[role]):
            _fail('jobs', 'invalid', 'step_identity')
        by_role[role] = row
        result.append({'role': role, 'id': row['id'], 'runId': row['runId'], 'runAttempt': row['runAttempt'],
            'headSha': row['headSha'], 'branch': row['branch'], 'status': row['status'],
            'conclusion': row['conclusion'], 'startedAt': row['startedAt'], 'completedAt': row['completedAt'],
            'requiredSteps': sorted(selected, key=lambda item: item['number'])})
    if set(by_role) != set(_p('roles')):
        _fail('jobs', 'unavailable', 'jobs_incomplete')
    if any(_stamp(by_role[role]['completedAt']) > _stamp(by_role['deploy']['startedAt']) for role in ('unit', 'build')):
        _fail('jobs', 'invalid', 'dependency_time')
    return sorted(result, key=lambda item: _p('roles').index(item['role']))


def _deployment(row, status, run, deploy_job):
    if (row['sha'] != run['headSha'] or row['ref'] != _p('branch') or row['task'] != 'deploy' or
            row['environment'] != _p('environment') or row['originalEnvironment'] != _p('environment')):
        _fail('deployment', 'invalid', 'deployment_identity')
    link = 'https://github.com/' + _p('repository') + '/actions/runs/' + str(run['id']) + '/job/' + str(deploy_job['id'])
    # Exact ASCII form is sufficient for the observed fixed URLs; never GET these links.
    if status['logUrl'] != link or status['targetUrl'] != link or status['environment'] != _p('environment'):
        _fail('deployment', 'invalid', 'job_link')
    latest = {'id': status['id'], 'state': status['state'], 'createdAt': status['createdAt'],
        'environment': status['environment'], 'runId': run['id'], 'jobId': deploy_job['id'],
        'environmentUrlSha256': hashlib.sha256(status['environmentUrl'].encode('utf-8')).hexdigest() if status['environmentUrl'] else None}
    return {**row, 'latestStatus': latest, 'exactJobMatched': True}


def _deployment_state(value):
    if value == 'success':
        return
    if value in _p('deployment_pending'):
        _fail('deployment', 'pending', 'deployment_pending')
    if value in _p('deployment_failure'):
        _fail('deployment', 'failed', 'deployment_failed')
    _fail('api', 'invalid', 'field_type')


def _empty(commit, budget):
    return {'contract': _p('contract'), 'version': _p('version'), 'status': 'unknown',
        'metadataOutcome': 'unknown', 'partial': True, 'fullE05': False, 'requestedCommit': commit,
        'policy': {'repositoryId': _p('repository_id'), 'fullName': _p('repository'),
            'workflowId': _p('workflow_id'), 'workflowPath': _p('workflow_path'), 'branch': _p('branch'),
            'environment': _p('environment'), 'profile': _p('profile'), 'workflowSourceSha256': _p('workflow_sha256')},
        'selection': None, 'workflowSource': None, 'jobs': [], 'deployment': None,
        'artifacts': {'listing': 'not_checked', 'totalCount': None, 'content': 'not_checked',
            'attemptBinding': 'not_checked', 'consumedByDeploy': 'not_checked'},
        'requests': budget.requests,
        'coverage': {key: 'not_checked' for key in ('repository', 'workflow', 'pagination', 'attempt', 'jobs',
            'deploymentJob', 'artifactLineage', 'productionInputs', 'web', 'assets', 'remoteNow', 'currentEligibility')},
        'issues': [], 'capabilities': {'canPublish': False, 'canResumeAnalysis': False,
            'canGrantSource': False, 'canExecuteBrowser': False}}


def _issue(result, error):
    if not any(error.domain == domain and error.code == code and error.reason in reasons
               for domain, code, reasons in _p('errors')):
        error = DeploymentMetadataError('api', 'invalid', 'response_shape')
    status = ('blocked' if error.domain == 'input' else error.code if error.code in
              ('unsupported', 'stale', 'pending', 'failed') else 'unknown')
    result.update(status=status, metadataOutcome={'pending': 'pending', 'failed': 'failure'}.get(status, 'unknown'),
        issues=[{'domain': error.domain, 'code': error.code, 'reason': error.reason}])


def _collect(commit, budget, result):
    run_pages, deployment_pages, status_pages = None, None, None
    run_total, run, selected_deployment, selected_status = None, None, None, None
    primary = None
    try:
        repository = _request(budget, _path('repository'))
        if (type(repository) is not dict or _repository(repository) !=
                {'id': _p('repository_id'), 'fullName': _p('repository')} or repository.get('private') is not False):
            _fail('selection', 'ambiguous', 'identity_mismatch')
        result['coverage']['repository'] = 'verified'
        workflows, _unused, _count = _pages(budget, 'workflows')
        matched = [item for item in workflows if item['id'] == _p('workflow_id')]
        if len(matched) != 1 or matched[0]['path'] != _p('workflow_path') or matched[0]['state'] != 'active':
            _fail('workflow', 'unavailable', 'workflow_missing')
        runs, run_pages, run_total = _pages(budget, 'runs')
        candidates = [item for item in runs if item['headSha'] == commit]
        if not candidates:
            _fail('selection', 'unavailable', 'run_not_observed')
        run = max(candidates, key=lambda item: (item['runNumber'], item['id']))
        _run_identity(run, commit)
        result['selection'] = {key: run[key] for key in ('runNumber', 'runAttempt', 'headSha', 'branch', 'event',
            'status', 'conclusion', 'repository', 'headRepository')}
        result['selection']['runId'] = run['id']
        _state(run['status'], run['conclusion'], 'selection')
        attempt = _row('runs', _request(budget, _path('attempt', run=run['id'], attempt=run['runAttempt'])))
        _run_identity(attempt, commit)
        identity = ('id', 'runNumber', 'runAttempt', 'headSha', 'branch', 'event', 'status', 'conclusion',
                    'workflowId', 'path', 'repository', 'headRepository')
        if any(run[key] != attempt[key] for key in identity):
            _fail('selection', 'stale', 'frontier_changed')
        expected_jobs_url = 'https://' + _p('host') + _path('attempt', run=run['id'], attempt=run['runAttempt']) + '/jobs'
        if attempt['jobsUrl'] != expected_jobs_url:
            _fail('selection', 'ambiguous', 'identity_mismatch')
        result['coverage']['attempt'] = 'verified'
        result['workflowSource'] = _source(budget, commit)
        result['coverage']['workflow'] = 'verified'
        jobs, _unused, _count = _pages(budget, 'jobs', run=run['id'], attempt=run['runAttempt'])
        result['jobs'] = _jobs(jobs, run)
        result['coverage']['jobs'] = 'verified'
        deployments, deployment_pages, _count = _pages(budget, 'deployments', commit=commit)
        if not deployments:
            _fail('deployment', 'unavailable', 'deployment_missing')
        selected_deployment = max(deployments, key=lambda item: (_stamp(item['createdAt']), item['id']))
        statuses, status_pages, _count = _pages(budget, 'statuses', deployment=selected_deployment['id'])
        if not statuses:
            _fail('deployment', 'unavailable', 'deployment_missing')
        selected_status = max(statuses, key=lambda item: (_stamp(item['createdAt']), item['id']))
        deploy_job = next(item for item in result['jobs'] if item['role'] == 'deploy')
        result['deployment'] = _deployment(selected_deployment, selected_status, run, deploy_job)
        result['coverage']['deploymentJob'] = 'verified'
        artifacts, _unused, count = _pages(budget, 'artifacts', run=run['id'])
        result['artifacts'].update(listing='observed_empty' if not artifacts else 'observed_nonempty_uninterpreted', totalCount=count)
        _deployment_state(selected_status['state'])
    except DeploymentMetadataError as error:
        primary = error
    # No new requests after network/limit/invalid API errors. A pending/failure still gets its known frontier checked.
    if primary is None or primary.code in ('pending', 'failed'):
        try:
            if run_pages is not None and run is not None:
                _final_pages(budget, 'runs', run_pages, run_total, run['id'])
            if deployment_pages is not None and selected_deployment is not None:
                _final_pages(budget, 'deployments', deployment_pages, None, selected_deployment['id'], commit=commit)
            if status_pages is not None and selected_status is not None:
                _final_pages(budget, 'statuses', status_pages, None, selected_status['id'], deployment=selected_deployment['id'])
        except DeploymentMetadataError as error:
            primary = error
    if primary is not None:
        _issue(result, primary)
        if primary.domain == 'artifacts':
            result['artifacts']['listing'] = 'unknown'
        result['coverage']['pagination'] = 'incomplete'
    else:
        result.update(status='metadata_observed', metadataOutcome='success')
        result['coverage']['pagination'] = 'complete'


def collect_github_pages_metadata(commit_oid):
    """Observe only the fixed public metadata profile. This grants no normal authority."""
    from runtime_guard import require_external_runtime
    require_external_runtime('github_pages_deployment.py')
    budget = _Budget()
    valid = type(commit_oid) is str and re.fullmatch('[0-9a-f]{40}', commit_oid) is not None
    result = _empty(commit_oid if valid else None, budget)
    if not valid:
        _issue(result, DeploymentMetadataError('input', 'invalid', 'commit_oid'))
    else:
        try:
            _collect(commit_oid, budget, result)
        except DeploymentMetadataError as error:
            _issue(result, error)
        except (OSError, ValueError, TypeError, KeyError, RecursionError, UnicodeError):
            _issue(result, DeploymentMetadataError('api', 'invalid', 'response_shape'))
    try:
        result['metadataSha256'] = _hash(result)
    except DeploymentMetadataError:
        # The fixed error envelope is small even if observations exceed the output budget.
        result = _empty(commit_oid if valid else None, budget)
        _issue(result, DeploymentMetadataError('limits', 'unavailable', 'result_bytes'))
        result['metadataSha256'] = _hash(result)
    return result


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('github_pages_deployment.py')
    raise SystemExit('Internal metadata library; use the fixed daily observer.')
