"""Bounded append-only mechanical deployment records; never normal authority."""
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import stat
import time
import uuid

POLICY_NAMES = ('POLICY',)
POLICY = (
    # Pinned wire headers. Keep the catalogue parity test in sync.
    # This restricted leaf must not import application modules or read config.
    ('protocol_headers', (
        ('intent', 'daily-deployment-intent',
         'a035197bdf3ace2a8b9401341de9f897c0aa8982a1816e0ea8a9b368dcf2d9c1', 'daily-deployment-intent-v1'),
        ('binding', 'daily-deployment-input-binding',
         'f710068d3d94ffd0c22c14e4cac8040a8f07478b8c5eeb3be783ec346f57c86b', 'daily-deployment-input-binding-v1'),
        ('result', 'daily-deployment-metadata-observation',
         '25e49d02c0c9e21ab4a6b1a574fe5a7519241469232cc60244a20ccf0fd50894', 'daily-deployment-metadata-observation-v1'),
        ('index', 'daily-deployment-index',
         'd68f9431b4c9bf973fc812f1885c8dda3183cba1541320a320a6991d1d987fb8', 'daily-deployment-index-v1'),
        ('counter', 'daily-deployment-sequence',
         'b9f85a0c3d1d2a4b688e9523cc534b4db8a80612a7eb776c1782eda2efcc29ab', 'daily-deployment-sequence-v1'),
        ('status', 'daily-deployment-local-status',
         '09c198d25e6a3e658212f5ed70f2c662022a5ad9e42ea2779a3404f0e4c3d668', 'daily-deployment-local-status-v1'),
        ('outcome', 'daily-deployment-attempt-outcome',
         'f62646531a8680943b2ce2310b62dbe6ad576892df07df282f0ec578b66d0651', 'daily-deployment-attempt-outcome-v1'),
        ('collector', 'github-pages-metadata-observation',
         '2b8190d13f6920a0a2a603ff20d905ab4c91f2d35dc8b3e21eab1f5addc262c6', 'github-pages-metadata-observation-v1'),
    )),
    ('collector_profile', ('fixed-hugo-workflow', '9713785163253df82d691f5bf9e3ef82b5ff322eb1857a0671ac83dc051f4fd0', 'fixed-hugo-workflow-v1')),
    ('intent_bytes', 8192), ('binding_bytes', 65536), ('snapshot_bytes', 2097152),
    ('result_bytes', 2097152), ('control_bytes', 65536), ('store_items', 10000), ('primary_pages', 512),
    ('store_bytes', 134217728), ('text_bytes', 8192), ('json_depth', 32),
    ('json_nodes', 100000), ('sequence_max', 9007199254740990),
    ('lock_seconds', 30), ('lock_poll_ms', 20),
    ('states', ('metadata_observed', 'pending', 'failed', 'unavailable',
                'unsupported', 'stale', 'blocked', 'interrupted')),
    ('recording_states', ('recorded', 'not_saved', 'partially_saved', 'durability_uncertain')),
    ('error_codes', ('invalid_argument', 'invalid_record', 'unavailable', 'limit_exceeded', 'conflict')),
    ('error_reasons', ('root_path', 'selector', 'handle_closed', 'handle_identity',
        'record_exists', 'unsupported_platform', 'file_type', 'missing', 'read_failed',
        'write_failed', 'lock_failed', 'file_sync', 'directory_sync', 'record_shape',
        'record_binding', 'record_hash', 'sequence_conflict', 'index_update',
        'intent_bytes', 'binding_bytes', 'snapshot_bytes', 'result_bytes',
        'store_items', 'store_bytes')),
    ('intent_keys', ('attemptId', 'sequence', 'selector',
                    'requestedAt', 'scope', 'parentAttemptId', 'intentSha256')),
    ('binding_keys', ('attemptId', 'sequence', 'selector',
        'normalBinding', 'publicationBinding', 'targetBinding', 'localBinding',
        'repositoryPolicy', 'snapshot', 'bindingSha256')),
    ('result_keys', ('attemptId', 'sequence', 'selector',
        'intentSha256', 'bindingSha256', 'startedAt', 'finishedAt', 'status',
        'bindingVerified', 'metadata', 'partial', 'fullE05', 'implementationObservation',
        'coverage', 'issues', 'capabilities', 'recordSha256')),
    ('capability_keys', ('canPublish', 'canResumeAnalysis', 'canGrantSource', 'canExecuteBrowser')),
    ('normal_keys', ('date', 'publicationMode', 'publicationScope', 'generationManifestSha256',
                     'receiptSha256', 'reviewBaseHead', 'reviewProtocolFingerprint', 'reviewedAt')),
    ('publication_keys', ('baseOid', 'commitOid', 'headOid', 'branch', 'recordedRemote', 'localRemoteConfigurationMatch')),
    ('target_headers', (('daily-reviewed-primary-targets', '90cb9fce654e68792895caee5db036a6ff91ba72467a026673273495ed3c535f'),
                        ('daily-reviewed-primary-targets-v2', 2))),
    ('target_profiles', (('daily-static-html-projection', 'ae53f55be53d088ec169f39fe03caed4e5376acfb0cb1a4e1b827da65b274fe3'),
                         ('daily-static-html-projection-v2', None))),
    ('target_binding_keys', ('targetsSha256', 'recordSha256', 'reviewedFileSetSha256',
                            'reviewedFileCount', 'primarySourceSetSha256', 'observationRef', 'profile')),
    ('local_binding_keys', ('contextObservationSha256', 'refPhysicalIdentitySha256', 'deltaObservationSha256',
                           'reviewedFileSetSha256', 'reviewedFileFactsSha256', 'implementationBindingSha256')),
    ('repository_keys', ('repositoryId', 'fullName', 'workflowId', 'workflowPath', 'branch', 'environment',
                         'policySha256', 'localRepositoryMapping')),
    ('snapshot_keys', ('contract', 'version', 'status', 'selector', 'normalBinding', 'reviewedTargets',
                      'publicationBinding', 'gitBinding', 'implementationBinding', 'inputBinding',
                      'fullInputSnapshot', 'observationCoverage', 'coverage', 'unknownInputs', 'capabilities', 'recordSha256')),
    ('target_keys', ('status', 'selector', 'normalBinding', 'observationRef', 'profile',
                    'implementationObservation', 'primaryPages', 'reviewedSitePolicy', 'reviewedFileSetSha256',
                    'reviewedFileCount', 'primarySourceSetSha256', 'changes', 'inputBinding', 'fullInputSnapshot',
                    'observationCoverage', 'coverage', 'unknownInputs', 'targetsSha256', 'recordSha256')),
    ('target_hash_keys', ('selector', 'reviewedSitePolicy', 'reviewedFileSetSha256',
                         'reviewedFileCount', 'primarySourceSetSha256', 'primaryPages', 'changes', 'profile', 'coverage')),
    ('collector_keys', ('status', 'metadataOutcome', 'partial', 'fullE05', 'requestedCommit',
                       'policy', 'selection', 'workflowSource', 'jobs', 'deployment', 'artifacts', 'requests',
                       'coverage', 'issues', 'metadataSha256', 'capabilities')),
    ('collector_policy', (('repositoryId', 1214235086), ('fullName', 'nanless/audio-paper-digest-blog'),
        ('workflowId', 262722446), ('workflowPath', '.github/workflows/hugo.yaml'), ('branch', 'main'),
        ('environment', 'github-pages'),
        ('workflowSourceSha256', 'cbf3a52e317973a4273f5c64c0a8d4e1c5dda2ee709f0e4ad12863c78cc5fe0d'))),
    ('collector_states', (('metadata_observed', 'success'), ('pending', 'pending'), ('failed', 'failure'),
                          ('unknown', 'unknown'), ('stale', 'unknown'), ('unsupported', 'unknown'), ('blocked', 'unknown'))),
    ('record_not_checked', ('artifactContent', 'productionArtifact', 'publicPages', 'publicAssets', 'remoteNow',
                           'currentEligibility', 'sourceRecoveryEligibility', 'browserExecution', 'finalAcceptance')),
    ('collector_not_checked', ('artifactLineage', 'productionInputs', 'web', 'assets', 'remoteNow', 'currentEligibility')),
    ('steps', (('unit', ((5, 'Unit checks'),)), ('build', ((6, 'Build and verify'), (7, 'Upload artifact'))),
               ('deploy', ((2, 'Deploy to GitHub Pages'),)))),

)


def _p(name):
    for key, value in POLICY:
        if name == key:
            return value
    raise RuntimeError('Unknown fixed policy')


class DeploymentStoreError(Exception):
    def __init__(self, code, reason):
        if code not in _p('error_codes') or reason not in _p('error_reasons'):
            code, reason = 'unavailable', 'read_failed'
        self.code = code
        self.reason = reason
        self.recording = 'not_saved'
        self.attempt_id = None
        self.sequence = None
        self.result_ref = None
        super().__init__(code, reason)


def _fail(code, reason):
    raise DeploymentStoreError(code, reason)


def _guard():
    from runtime_guard import require_external_runtime
    require_external_runtime('daily_deployment_store.py')


def _text(value, maximum, *, argument=False):
    if type(value) is not str:
        _fail('invalid_argument' if argument else 'invalid_record', 'record_shape')
    used = 0
    for char in value:
        point = ord(char)
        if 0xD800 <= point <= 0xDFFF:
            _fail('invalid_argument' if argument else 'invalid_record', 'record_shape')
        used += 1 if point < 128 else 2 if point < 2048 else 3 if point < 65536 else 4
        if used > maximum:
            _fail('limit_exceeded', 'result_bytes')
    return used


def _charge(budget, amount):
    budget[0] -= amount
    if budget[0] < 0:
        _fail('limit_exceeded', 'result_bytes')


def _measure_walk(item, depth, budget):
    if depth > _p('json_depth'):
        _fail('invalid_record', 'record_shape')
    budget[1] += 1
    if budget[1] > _p('json_nodes'):
        _fail('limit_exceeded', 'result_bytes')
    if item is None:
        _charge(budget, 4)
    elif type(item) is bool:
        _charge(budget, 4 if item else 5)
    elif type(item) is int:
        if abs(item) > 9007199254740991:
            _fail('invalid_record', 'record_shape')
        _charge(budget, len(str(item)))
    elif type(item) is str:
        _charge(budget, 2)
        for char in item:
            point = ord(char)
            if 0xD800 <= point <= 0xDFFF:
                _fail('invalid_record', 'record_shape')
            if char in ('"', '\\', '\b', '\f', '\n', '\r', '\t'):
                count = 2
            elif point < 32:
                count = 6
            else:
                count = 1 if point < 128 else 2 if point < 2048 else 3 if point < 65536 else 4
            _charge(budget, count)
    elif type(item) is list or type(item) is dict:
        _charge(budget, 2 + max(0, len(item) - 1))
        if type(item) is dict:
            _charge(budget, len(item))
            for key, child in item.items():
                if type(key) is not str:
                    _fail('invalid_record', 'record_shape')
                _measure_walk(key, depth + 1, budget)
                _measure_walk(child, depth + 1, budget)
        else:
            for child in item:
                _measure_walk(child, depth + 1, budget)
    else:
        _fail('invalid_record', 'record_shape')


def _measure(value, limit):
    _measure_walk(value, 0, [limit, 0])


def _canonical(value, limit):
    _measure(value, limit)
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True,
                     separators=(',', ':'), allow_nan=False).encode('utf-8')
    if len(raw) > limit:
        _fail('limit_exceeded', 'result_bytes')
    return raw


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _digest(value):
    return _sha(_canonical(value, _p('result_bytes')))


def _hashed(value, field):
    out = dict(value)
    out[field] = _digest(value)
    return out


def _without(value, field):
    out = dict(value)
    out.pop(field, None)
    return out


def _pairs(rows):
    out = {}
    for key, value in rows:
        if key in out:
            _fail('invalid_record', 'record_shape')
        out[key] = value
    return out


def _parse(raw, limit):
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=_pairs,
                           parse_constant=_bad_constant)
    except (ValueError, UnicodeError, RecursionError):
        _fail('invalid_record', 'record_shape')
    if type(value) is not dict or _canonical(value, limit) != raw:
        _fail('invalid_record', 'record_shape')
    return value


def _bad_constant(_value):
    _fail('invalid_record', 'record_shape')


def _selector(value):
    if type(value) is not dict or set(value) != {'workflow', 'date', 'includeId'}:
        _fail('invalid_argument', 'selector')
    if type(value['workflow']) is not str or value['workflow'] != 'daily' or type(value['date']) is not str:
        _fail('invalid_argument', 'selector')
    try:
        if datetime.date.fromisoformat(value['date']).isoformat() != value['date']:
            _fail('invalid_argument', 'selector')
    except ValueError:
        _fail('invalid_argument', 'selector')
    include = value['includeId']
    if include is not None:
        if type(include) is not str or not include:
            _fail('invalid_argument', 'selector')
        _text(include, _p('text_bytes'), argument=True)
        for char in include:
            if ord(char) < 32 or 127 <= ord(char) <= 159:
                _fail('invalid_argument', 'selector')
    return dict(value)


def _root(value):
    if type(value) is not str or not value or len(value) > _p('text_bytes'):
        _fail('invalid_argument', 'root_path')
    _text(value, _p('text_bytes'), argument=True)
    if not value.startswith('/') or value.startswith('//') or value == '/' or os.path.normpath(value) != value or '\x00' in value:
        _fail('invalid_argument', 'root_path')
    return value


def _close_fds(descriptors, primary=None):
    first, control = None, None
    for fd in descriptors:
        if fd is not None:
            try:
                os.close(fd)
            except BaseException as error:
                if first is None:
                    first = error
                if control is None and isinstance(error, (KeyboardInterrupt, SystemExit)):
                    control = error
    if isinstance(primary, (KeyboardInterrupt, SystemExit)):
        return
    if control is not None:
        raise control
    if primary is None and first is not None:
        if isinstance(first, (KeyboardInterrupt, SystemExit)):
            raise first
        _fail('unavailable', 'read_failed')


class _Fd:
    def __init__(self, fd):
        self.fd = fd

    def __enter__(self):
        return self.fd

    def __exit__(self, kind, value, traceback):
        _close_fds((self.fd,), value)
        return False


def _directory(path, create=False):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open('/', flags)
    try:
        for component in path.split('/')[1:]:
            if create:
                try:
                    os.mkdir(component, 0o700, dir_fd=fd)
                    _sync(fd, 'directory_sync')
                except FileExistsError:
                    pass
            child = os.open(component, flags, dir_fd=fd)
            previous, fd = fd, child
            _close_fds((previous,))
        return fd
    except BaseException as error:
        _close_fds((fd,), error)
        raise


def _mkdir(fd, name):
    try:
        os.mkdir(name, 0o700, dir_fd=fd)
        _sync(fd, 'directory_sync')
    except FileExistsError:
        pass
    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
    info = os.fstat(child)
    if info.st_mode & 0o077 or info.st_uid != os.getuid():
        _close_fds((child,))
        _fail('unavailable', 'file_type')
    return child


def _identity(fd):
    info = os.fstat(fd)
    return (info.st_dev, info.st_ino)


def _file_facts(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
            info.st_mode, info.st_nlink, info.st_uid, info.st_gid)


def _read(fd, name, limit, *, optional=False, aggregate=None):
    try:
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        if optional:
            return None
        _fail('unavailable', 'missing')
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077:
        _fail('unavailable', 'file_type')
    if info.st_size > limit:
        _fail('limit_exceeded', 'store_bytes')
    available = limit
    if aggregate is not None:
        available = min(available, _p('store_bytes') - aggregate[0])
        if info.st_size > available:
            _fail('limit_exceeded', 'store_bytes')
        aggregate[0] += info.st_size
    cap = min(limit, available, info.st_size)
    source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    with _Fd(source):
        before = os.fstat(source)
        if _file_facts(before) != _file_facts(info):
            _fail('unavailable', 'read_failed')
        chunks, used = [], 0
        while True:
            chunk = os.read(source, min(65536, cap - used + 1))
            if not chunk:
                break
            used += len(chunk)
            if used > cap:
                _fail('limit_exceeded', 'store_bytes')
            chunks.append(chunk)
        after = os.fstat(source)
        final = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if (_file_facts(before) != _file_facts(after) or _file_facts(final) != _file_facts(before)
                or used != before.st_size):
            _fail('unavailable', 'read_failed')
        return b''.join(chunks)


def _sync(fd, reason):
    try:
        os.fsync(fd)
    except OSError:
        _fail('unavailable', reason)


def _write_all(fd, raw):
    used = 0
    while used < len(raw):
        amount = os.write(fd, raw[used:])
        if amount <= 0:
            _fail('unavailable', 'write_failed')
        used += amount


def _publish(fd, name, raw, *, replace=False, expected=None, aggregate=None):
    temp = '.' + name + '.' + uuid.uuid4().hex + '.tmp'
    source = None
    owns_temp = False
    visible = False
    primary = None
    try:
        source = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        owns_temp = True
        _write_all(source, raw)
        _sync(source, 'file_sync')
        closing, source = source, None
        _close_fds((closing,))
        if replace:
            current = _read(fd, name, _p('control_bytes'), optional=True, aggregate=aggregate)
            if current != expected:
                _fail('conflict', 'record_binding')
            os.replace(temp, name, src_dir_fd=fd, dst_dir_fd=fd)
            owns_temp = False
            visible = True
        else:
            try:
                os.link(temp, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                visible = True
            except FileExistsError:
                if _read(fd, name, len(raw), aggregate=aggregate) != raw:
                    _fail('conflict', 'record_exists')
            os.unlink(temp, dir_fd=fd)
            owns_temp = False
        _sync(fd, 'directory_sync')
    except DeploymentStoreError as error:
        primary = error
        if visible:
            error.recording = 'durability_uncertain'
        raise
    except OSError:
        error = DeploymentStoreError('unavailable', 'write_failed')
        primary = error
        if visible:
            error.recording = 'durability_uncertain'
        raise error from None
    except BaseException as error:
        primary = error
        raise
    finally:
        cleanup = None
        try:
            _close_fds((source,), primary)
        except BaseException as error:
            cleanup = error
        if owns_temp:
            try:
                os.unlink(temp, dir_fd=fd)
            except FileNotFoundError:
                pass
            except BaseException as error:
                if cleanup is None:
                    cleanup = error
        if isinstance(cleanup, (KeyboardInterrupt, SystemExit)) and not isinstance(primary, (KeyboardInterrupt, SystemExit)):
            raise cleanup
        if primary is None and cleanup is not None:
            if isinstance(cleanup, (KeyboardInterrupt, SystemExit)):
                raise cleanup
            error = DeploymentStoreError('unavailable', 'write_failed')
            error.recording = 'durability_uncertain' if visible else 'not_saved'
            raise error from None


def _flock(fd, exclusive):
    deadline = time.monotonic() + _p('lock_seconds')
    while True:
        try:
            fcntl.flock(fd, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.monotonic() >= deadline:
                _fail('unavailable', 'lock_failed')
            time.sleep(_p('lock_poll_ms') / 1000)


class _Scope:
    def __init__(self, root, selector, create=False, exclusive=True):
        self.root, self.selector, self.create, self.exclusive = root, selector, create, exclusive
        self.root_fd, self.fd, self.lock_fd = None, None, None
        self.created_lock = False
        self.private_lock_name = None
        self.budget = [0]

    def _new_lock(self):
        candidate = '.store.lock.' + uuid.uuid4().hex + '.tmp'
        self.lock_fd = os.open(candidate,
            os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
        self.private_lock_name = candidate
        # A final lock is never visible until its actual inode is already locked.
        _flock(self.lock_fd, True)
        _sync(self.lock_fd, 'file_sync')
        try:
            os.link(self.private_lock_name, 'store.lock', src_dir_fd=self.fd,
                    dst_dir_fd=self.fd, follow_symlinks=False)
        except FileExistsError:
            os.unlink(self.private_lock_name, dir_fd=self.fd)
            self.private_lock_name = None
            private_fd, self.lock_fd = self.lock_fd, None
            _close_fds((private_fd,))
            return False
        self.created_lock = True
        os.unlink(self.private_lock_name, dir_fd=self.fd)
        self.private_lock_name = None
        _sync(self.fd, 'directory_sync')
        return True

    def __enter__(self):
        try:
            self.root_fd = _directory(self.root, self.create)
            info = os.fstat(self.root_fd)
            if info.st_uid != os.getuid() or info.st_mode & 0o077:
                _fail('unavailable', 'file_type')
            self.name = _digest(self.selector)
            if self.create:
                self.fd = _mkdir(self.root_fd, self.name)
            else:
                self.fd = os.open(self.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.root_fd)
            owns_new_lock = self._new_lock() if self.create else False
            if not owns_new_lock:
                self.lock_fd = os.open('store.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
                _flock(self.lock_fd, self.exclusive)
            # The publisher can transiently have two links. Validate only after
            # flock, when the initializer has removed its private link.
            lock_info = os.fstat(self.lock_fd)
            named = os.stat('store.lock', dir_fd=self.fd, follow_symlinks=False)
            if (not stat.S_ISREG(lock_info.st_mode) or lock_info.st_nlink != 1
                    or lock_info.st_mode & 0o077 or lock_info.st_uid != os.getuid()
                    or _file_facts(named) != _file_facts(lock_info)):
                _fail('unavailable', 'lock_failed')
            self.root_identity = _identity(self.root_fd)
            self.selector_identity = _identity(self.fd)
            return self
        except BaseException as error:
            self.close(error)
            raise

    def __exit__(self, kind, value, traceback):
        primary = value
        try:
            if kind is None:
                with _Fd(_directory(self.root)) as actual:
                    if _identity(actual) != self.root_identity:
                        _fail('unavailable', 'record_binding')
                    with _Fd(os.open(self.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                     dir_fd=actual)) as child:
                        if _identity(child) != self.selector_identity:
                            _fail('unavailable', 'record_binding')
        except BaseException as error:
            primary = error
            raise
        finally:
            self.close(primary)
        return False

    def close(self, primary=None):
        cleanup = None
        if self.private_lock_name is not None and self.fd is not None:
            name, self.private_lock_name = self.private_lock_name, None
            try:
                os.unlink(name, dir_fd=self.fd)
            except FileNotFoundError:
                pass
            except BaseException as error:
                cleanup = error
        descriptors = (self.lock_fd, self.fd, self.root_fd)
        self.lock_fd, self.fd, self.root_fd = None, None, None
        try:
            _close_fds(descriptors, primary if primary is not None else cleanup)
        except BaseException as error:
            cleanup = error
        if isinstance(primary, (KeyboardInterrupt, SystemExit)):
            return
        if isinstance(cleanup, (KeyboardInterrupt, SystemExit)):
            raise cleanup
        if primary is None and cleanup is not None:
            _fail('unavailable', 'read_failed')


class _Handle:
    def __init__(self, root, selector, intent, scope):
        self._owner = self
        self.root, self.selector = root, dict(selector)
        self.intent = _canonical(intent, _p('intent_bytes'))
        self.root_identity = scope.root_identity
        self.selector_identity = scope.selector_identity
        self.closed = False
        self.recording = 'partially_saved'

    def __copy__(self):
        _fail('invalid_argument', 'handle_identity')

    def __deepcopy__(self, _memo):
        _fail('invalid_argument', 'handle_identity')


def _handle(value, scope, allow_closed=False):
    if type(value) is not _Handle or value._owner is not value:
        _fail('invalid_argument', 'handle_identity')
    if value.closed and not allow_closed:
        _fail('invalid_argument', 'handle_closed')
    if value.root_identity != scope.root_identity or value.selector_identity != scope.selector_identity:
        _fail('conflict', 'record_binding')
    intent = _parse(value.intent, _p('intent_bytes'))
    return intent


def _seq(value):
    return type(value) is int and 1 <= value <= _p('sequence_max')


def _time(value, maximum=64):
    if type(value) is not str or len(value) > maximum:
        _fail('invalid_record', 'record_shape')
    try:
        parsed = datetime.datetime.fromisoformat(value)
    except ValueError:
        _fail('invalid_record', 'record_shape')
    if parsed.tzinfo is None:
        _fail('invalid_record', 'record_shape')


def _check_hash(value, field):
    if not re.fullmatch('[0-9a-f]{64}', str(value.get(field, ''))) or _digest(_without(value, field)) != value[field]:
        _fail('invalid_record', 'record_hash')


def _protocol_header(kind, *, historical=False):
    for key, name, fingerprint, original in _p('protocol_headers'):
        if key == kind:
            return ({'contract': original, 'version': 1} if historical else
                    {'contract': name, 'schemaFingerprint': fingerprint})
    raise RuntimeError('Unknown deployment protocol')


def _record_format(value, kind, fields):
    header = _protocol_header(kind)
    if type(value) is dict and set(value) == set(fields) | header.keys():
        if all(value[key] == expected for key, expected in header.items()):
            return 'current'
    original = _protocol_header(kind, historical=True)
    if type(value) is dict and set(value) == set(fields) | original.keys():
        if value['contract'] == original['contract'] and type(value['version']) is int and value['version'] == original['version']:
            return 'original'
    return None


def _intent(value, selector, directory):
    if (_record_format(value, 'intent', _p('intent_keys')) is None
            or value['selector'] != selector or not _seq(value['sequence'])
            or type(value['attemptId']) is not str or value['attemptId'] != directory
            or not re.fullmatch(str(value['sequence']) + '-[0-9a-f]{32}', directory)
            or value['scope'] != 'deployment_metadata_only' or value['parentAttemptId'] is not None):
        _fail('invalid_record', 'record_binding')
    _time(value['requestedAt'])
    _check_hash(value, 'intentSha256')


def _keys(value, names):
    if type(value) is not dict or set(value) != set(names):
        _fail('invalid_record', 'record_shape')


def _hex(value, length=64):
    if type(value) is not str or not re.fullmatch('[0-9a-f]{' + str(length) + '}', value):
        _fail('invalid_record', 'record_shape')


def _id(value, zero=False):
    if type(value) is not int or not (0 if zero else 1) <= value <= 9007199254740991:
        _fail('invalid_record', 'record_shape')


def _version(value, expected=1):
    if type(value) is not int or value != expected:
        _fail('invalid_record', 'record_shape')


def _caps_check(value):
    _keys(value, _p('capability_keys'))
    for item in value.values():
        if item is not False:
            _fail('invalid_record', 'record_shape')


def _issue_shape(value):
    if type(value) is not list or len(value) > 1:
        _fail('invalid_record', 'record_shape')
    for issue in value:
        _keys(issue, ('domain', 'code', 'reason'))
        for token in issue.values():
            if type(token) is not str or not re.fullmatch('[a-z][a-z0-9_]{0,63}', token):
                _fail('invalid_record', 'record_shape')


def _implementation_check(value):
    _keys(value, ('contract', 'version', 'ownerObservationSha256', 'runtimeSha256', 'executionBinding',
                  'executionBindingSha256', 'fullExecutionClosure'))
    if value['contract'] != 'daily-deployment-implementation-observation-v1' or value['fullExecutionClosure'] != 'not_established':
        _fail('invalid_record', 'record_shape')
    _version(value['version'])
    for field in ('ownerObservationSha256', 'runtimeSha256', 'executionBindingSha256'):
        _hex(value[field])
    execution = value['executionBinding']
    _keys(execution, ('contract', 'version', 'modules', 'compiler', 'objectBinding', 'fullExecutionClosure'))
    _version(execution['version'])
    if (execution['contract'] != 'daily-deployment-private-execution-v1'
            or execution['objectBinding'] != 'actual_objects_before_after'
            or execution['fullExecutionClosure'] != 'not_established'):
        _fail('invalid_record', 'record_shape')
    compiler = execution['compiler']
    _keys(compiler, ('dontInherit', 'optimize', 'dependencyMapping'))
    if compiler['dontInherit'] is not True or type(compiler['optimize']) is not int or compiler['optimize'] != 0 or compiler['dependencyMapping'] != []:
        _fail('invalid_record', 'record_shape')
    if type(execution['modules']) is not list or len(execution['modules']) != 2:
        _fail('invalid_record', 'record_shape')
    names = ('github_pages_deployment.py', 'daily_deployment_store.py')
    for index, row in enumerate(execution['modules']):
        _keys(row, ('file', 'sourceSha256', 'codeAndPolicySha256'))
        if row['file'] != names[index]:
            _fail('invalid_record', 'record_shape')
        _hex(row['sourceSha256'])
        _hex(row['codeAndPolicySha256'])
    if _digest(execution) != value['executionBindingSha256']:
        _fail('invalid_record', 'record_hash')


def _target_header(value, fields, attempt_format):
    if type(value) is not dict:
        _fail('invalid_record', 'record_shape')
    (name, fingerprint), (original, version) = _p('target_headers')
    if (attempt_format == 'current' and value.get('contract') == name
            and value.get('schemaFingerprint') == fingerprint):
        header = {'contract': name, 'schemaFingerprint': fingerprint}
    elif (value.get('contract') == original and type(value.get('version')) is int
            and value['version'] == version):
        header = {'contract': original, 'version': version}
    else:
        _fail('invalid_record', 'record_shape')
    _keys(value, (*header, *fields))
    return header


def _binding_relations(value, snapshot, attempt_format):
    normal, publication = value['normalBinding'], value['publicationBinding']
    target, local, policy = value['targetBinding'], value['localBinding'], value['repositoryPolicy']
    _keys(normal, _p('normal_keys'))
    _keys(publication, _p('publication_keys'))
    target_header = _target_header(target, _p('target_binding_keys'), attempt_format)
    _keys(local, _p('local_binding_keys'))
    _keys(policy, _p('repository_keys'))
    if normal['date'] != value['selector']['date'] or normal['publicationMode'] not in ('llm_api_production', 'legacy_v5_maintenance', 'empty_daily_batch'):
        _fail('invalid_record', 'record_binding')
    expected_scope = None
    if value['selector']['includeId'] is not None:
        expected_scope = {'mode': 'single-paper', 'includeId': value['selector']['includeId']}
    if normal['publicationScope'] != expected_scope:
        _fail('invalid_record', 'record_binding')
    for field in ('generationManifestSha256', 'receiptSha256', 'reviewProtocolFingerprint'):
        _hex(normal[field])
    _hex(normal['reviewBaseHead'], 40)
    _text(normal['reviewedAt'], _p('text_bytes'))
    _time(normal['reviewedAt'], _p('text_bytes'))
    for field in ('baseOid', 'commitOid', 'headOid'):
        _hex(publication[field], 40)
    if (publication['baseOid'] != normal['reviewBaseHead'] or publication['headOid'] != publication['commitOid']
            or publication['branch'] != 'refs/heads/main' or publication['localRemoteConfigurationMatch'] != 'verified'):
        _fail('invalid_record', 'record_binding')
    remote = publication['recordedRemote']
    _keys(remote, ('name', 'oid', 'verifiedAt'))
    if type(remote['name']) is not str or not re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,127}', remote['name']) or remote['oid'] != publication['commitOid']:
        _fail('invalid_record', 'record_binding')
    _time(remote['verifiedAt'])
    for field in ('targetsSha256', 'recordSha256', 'reviewedFileSetSha256', 'primarySourceSetSha256'):
        _hex(target[field])
    _id(target['reviewedFileCount'])
    observation_ref = target['observationRef']
    if type(observation_ref) is not dict:
        _fail('invalid_record', 'record_shape')
    if observation_ref.get('contract') == 'daily-render-observation-ref':
        _keys(observation_ref, ('contract', 'schemaFingerprint', 'path', 'sha256'))
        # The restricted deployment store cannot load another module.
        # Keep this exact approved fingerprint in sync with the shared catalog.
        if observation_ref['schemaFingerprint'] != '0d76178713fcca26dea934f39be0ae0d53ca75bedc318732e2fb2b089cd2e00d':
            _fail('invalid_record', 'record_shape')
    else:
        _keys(observation_ref, ('contract', 'path', 'sha256'))
        if observation_ref['contract'] != 'daily-render-observation-ref-v1':
            _fail('invalid_record', 'record_shape')
    _hex(observation_ref['sha256'])
    path = observation_ref['path']
    if type(path) is not str or not path.startswith(normal['date'] + '/') or not path.endswith('/manifest.json') or '..' in path.split('/') or path.startswith('/'):
        _fail('invalid_record', 'record_shape')
    _text(path, _p('text_bytes'))
    current_profile, original_profile = _p('target_profiles')
    profile, fingerprint = current_profile if 'schemaFingerprint' in target_header else original_profile
    profile_header = {'contract': profile}
    if fingerprint is not None:
        profile_header['schemaFingerprint'] = fingerprint
    _keys(target['profile'], (*profile_header, 'fingerprint'))
    if any(target['profile'][key] != expected for key, expected in profile_header.items()):
        _fail('invalid_record', 'record_shape')
    _hex(target['profile']['fingerprint'])
    for sha in local.values():
        _hex(sha)
    expected_policy = dict(_p('collector_policy'))
    for name in ('repositoryId', 'fullName', 'workflowId', 'workflowPath', 'branch', 'environment'):
        if type(policy[name]) is not type(expected_policy[name]) or policy[name] != expected_policy[name]:
            _fail('invalid_record', 'record_binding')
    if policy['localRepositoryMapping'] != 'verified':
        _fail('invalid_record', 'record_binding')
    _hex(policy['policySha256'])
    _keys(snapshot, _p('snapshot_keys'))
    _version(snapshot['version'])
    if snapshot['contract'] != 'daily-local-publication-observation-v1' or snapshot['status'] != 'local_publication_observed':
        _fail('invalid_record', 'record_shape')
    for name in ('selector', 'normalBinding', 'publicationBinding'):
        if snapshot[name] != value[name]:
            _fail('invalid_record', 'record_binding')
    _check_hash(snapshot, 'recordSha256')
    _caps_check(snapshot['capabilities'])
    actual = snapshot['reviewedTargets']
    if _target_header(actual, _p('target_keys'), attempt_format) != target_header:
        _fail('invalid_record', 'record_binding')
    pages = actual['primaryPages']
    if type(pages) is not list or len(pages) > _p('primary_pages'):
        _fail('invalid_record', 'record_shape')
    for page in pages:
        if type(page) is not dict:
            _fail('invalid_record', 'record_shape')
    for key in target:
        if target[key] != actual[key]:
            _fail('invalid_record', 'record_binding')
    if actual['selector'] != value['selector'] or actual['normalBinding'] != normal or actual['status'] != 'reviewed_targets_observed':
        _fail('invalid_record', 'record_binding')
    _check_hash(actual, 'recordSha256')
    projected = dict(target_header)
    for name in _p('target_hash_keys'):
        projected[name] = actual[name]
    if _digest(projected) != actual['targetsSha256']:
        _fail('invalid_record', 'record_hash')
    git = snapshot['gitBinding']
    _keys(git, ('contract', 'version', 'context1ObservationSha256', 'context2ObservationSha256',
                'refPhysicalIdentitySha256', 'deltaObservationSha256', 'reviewedFileSetSha256',
                'reviewedFileFactsSha256', 'scopeFileCount', 'coverage'))
    if git['contract'] != 'local-git-publication-observation-v1':
        _fail('invalid_record', 'record_shape')
    _version(git['version'])
    for key in ('refPhysicalIdentitySha256', 'deltaObservationSha256', 'reviewedFileSetSha256', 'reviewedFileFactsSha256'):
        if git[key] != local[key]:
            _fail('invalid_record', 'record_binding')
    _id(git['scopeFileCount'])
    if (git['context1ObservationSha256'] != local['contextObservationSha256']
            or git['context2ObservationSha256'] != local['contextObservationSha256']
            or git['scopeFileCount'] != target['reviewedFileCount']
            or _digest(snapshot['implementationBinding']) != local['implementationBindingSha256']
            or snapshot['inputBinding'] != 'observed_before_after' or snapshot['fullInputSnapshot'] != 'not_established'):
        _fail('invalid_record', 'record_binding')


def _collector_metadata(value, commit, attempt_format):
    metadata_format = _record_format(value, 'collector', _p('collector_keys'))
    if metadata_format is None or (attempt_format == 'original' and metadata_format != 'original'):
        _fail('invalid_record', 'record_shape')
    _canonical(value, 1048576)
    if (value['partial'] is not True or value['fullE05'] is not False or value['requestedCommit'] != commit):
        _fail('invalid_record', 'record_binding')
    _hex(value['requestedCommit'], 40)
    states = dict(_p('collector_states'))
    if type(value['status']) is not str or value['status'] not in states or value['metadataOutcome'] != states[value['status']]:
        _fail('invalid_record', 'record_shape')
    profile, fingerprint, original_profile = _p('collector_profile')
    expected_policy = dict(_p('collector_policy'))
    if metadata_format == 'original':
        expected_policy['profile'] = original_profile
    else:
        expected_policy.update(profile=profile, profileSchemaFingerprint=fingerprint)
    if value['policy'] != expected_policy:
        _fail('invalid_record', 'record_binding')
    _caps_check(value['capabilities'])
    _issue_shape(value['issues'])
    _check_hash(value, 'metadataSha256')
    verified = value['status'] == 'metadata_observed'
    coverage = value['coverage']
    _keys(coverage, ('repository', 'workflow', 'pagination', 'attempt', 'jobs', 'deploymentJob') + _p('collector_not_checked'))
    for name in _p('collector_not_checked'):
        if coverage[name] != 'not_checked':
            _fail('invalid_record', 'record_shape')
    for name in ('repository', 'workflow', 'attempt', 'jobs', 'deploymentJob'):
        if coverage[name] not in ('verified', 'not_checked') or (verified and coverage[name] != 'verified'):
            _fail('invalid_record', 'record_shape')
    if coverage['pagination'] not in ('complete', 'incomplete', 'not_checked') or (verified and coverage['pagination'] != 'complete'):
        _fail('invalid_record', 'record_shape')
    selection = value['selection']
    if selection is not None:
        _keys(selection, ('runId', 'runNumber', 'runAttempt', 'headSha', 'branch', 'event', 'status', 'conclusion', 'repository', 'headRepository'))
        for key in ('runId', 'runNumber', 'runAttempt'):
            _id(selection[key])
        for key in ('repository', 'headRepository'):
            _keys(selection[key], ('id', 'fullName'))
            if selection[key] != {'id': 1214235086, 'fullName': 'nanless/audio-paper-digest-blog'} or type(selection[key]['id']) is not int:
                _fail('invalid_record', 'record_binding')
        if selection['headSha'] != commit or selection['branch'] != 'main' or selection['event'] != 'push':
            _fail('invalid_record', 'record_binding')
    workflow = value['workflowSource']
    if workflow is not None:
        _keys(workflow, ('path', 'commit', 'gitBlobOid', 'bytes', 'sha256', 'profileMatched'))
        _hex(workflow['gitBlobOid'], 40)
        _id(workflow['bytes'], True)
        if (workflow['path'] != '.github/workflows/hugo.yaml' or workflow['commit'] != commit
                or workflow['sha256'] != dict(_p('collector_policy'))['workflowSourceSha256']
                or type(workflow['profileMatched']) is not bool):
            _fail('invalid_record', 'record_binding')
    jobs = value['jobs']
    if type(jobs) is not list or len(jobs) > 3:
        _fail('invalid_record', 'record_shape')
    roles, ids = {}, set()
    for row in jobs:
        _keys(row, ('role', 'id', 'runId', 'runAttempt', 'headSha', 'branch', 'status', 'conclusion', 'startedAt', 'completedAt', 'requiredSteps'))
        for key in ('id', 'runId', 'runAttempt'):
            _id(row[key])
        if type(row['role']) is not str or row['role'] not in dict(_p('steps')) or row['role'] in roles or row['id'] in ids or selection is None:
            _fail('invalid_record', 'record_shape')
        if row['runId'] != selection['runId'] or row['runAttempt'] != selection['runAttempt'] or row['headSha'] != commit or row['branch'] != 'main':
            _fail('invalid_record', 'record_binding')
        roles[row['role']] = row
        ids.add(row['id'])
        if row['startedAt'] is not None:
            _time(row['startedAt'])
        if row['completedAt'] is not None:
            _time(row['completedAt'])
        if type(row['requiredSteps']) is not list or len(row['requiredSteps']) > 100:
            _fail('invalid_record', 'record_shape')
        step_rows = []
        for step in row['requiredSteps']:
            _keys(step, ('number', 'name', 'status', 'conclusion'))
            _id(step['number'])
            step_rows.append((step['number'], step['name']))
            if verified and (step['status'] != 'completed' or step['conclusion'] != 'success'):
                _fail('invalid_record', 'record_binding')
        if verified and tuple(step_rows) != dict(_p('steps'))[row['role']]:
            _fail('invalid_record', 'record_binding')
    deployment = value['deployment']
    if deployment is not None:
        _keys(deployment, ('id', 'sha', 'ref', 'environment', 'originalEnvironment', 'task', 'productionEnvironment',
                           'transientEnvironment', 'createdAt', 'latestStatus', 'exactJobMatched'))
        _id(deployment['id'])
        if (deployment['sha'] != commit or deployment['ref'] != 'main' or deployment['environment'] != 'github-pages'
                or deployment['originalEnvironment'] != 'github-pages' or deployment['task'] != 'deploy'
                or type(deployment['productionEnvironment']) is not bool or type(deployment['transientEnvironment']) is not bool
                or type(deployment['exactJobMatched']) is not bool):
            _fail('invalid_record', 'record_binding')
        _time(deployment['createdAt'])
        latest = deployment['latestStatus']
        _keys(latest, ('id', 'state', 'createdAt', 'environment', 'runId', 'jobId', 'environmentUrlSha256'))
        for key in ('id', 'runId', 'jobId'):
            _id(latest[key])
        _time(latest['createdAt'])
        if latest['environmentUrlSha256'] is not None:
            _hex(latest['environmentUrlSha256'])
        if (selection is None or 'deploy' not in roles or latest['runId'] != selection['runId']
                or latest['jobId'] != roles['deploy']['id'] or latest['environment'] != 'github-pages'):
            _fail('invalid_record', 'record_binding')
    artifact = value['artifacts']
    _keys(artifact, ('listing', 'totalCount', 'content', 'attemptBinding', 'consumedByDeploy'))
    if artifact['listing'] not in ('not_checked', 'unknown', 'observed_empty', 'observed_nonempty_uninterpreted'):
        _fail('invalid_record', 'record_shape')
    for key in ('content', 'attemptBinding', 'consumedByDeploy'):
        if artifact[key] != 'not_checked':
            _fail('invalid_record', 'record_shape')
    if artifact['totalCount'] is not None:
        _id(artifact['totalCount'], True)
    if artifact['listing'] == 'observed_empty' and (type(artifact['totalCount']) is not int or artifact['totalCount'] != 0):
        _fail('invalid_record', 'record_shape')
    if artifact['listing'] == 'observed_nonempty_uninterpreted' and (type(artifact['totalCount']) is not int or artifact['totalCount'] < 1):
        _fail('invalid_record', 'record_shape')
    if type(value['requests']) is not list or len(value['requests']) > 48:
        _fail('invalid_record', 'record_shape')
    for index, request in enumerate(value['requests']):
        _keys(request, ('ordinal', 'route', 'page', 'httpStatus', 'bytes', 'sha256', 'outcome'))
        if type(request['ordinal']) is not int or request['ordinal'] != index + 1:
            _fail('invalid_record', 'record_shape')
        if type(request['route']) is not str or '://' in request['route']:
            _fail('invalid_record', 'record_shape')
        _text(request['route'], 1024)
        if request['page'] is not None:
            _id(request['page'])
        if request['httpStatus'] is not None:
            _id(request['httpStatus'])
        _id(request['bytes'], True)
        if request['sha256'] is not None:
            _hex(request['sha256'])
        if request['outcome'] not in ('received', 'http_error', 'timeout', 'invalid', 'limit'):
            _fail('invalid_record', 'record_shape')
    if verified:
        if selection is None or workflow is None or not workflow['profileMatched'] or set(roles) != {'unit', 'build', 'deploy'} or deployment is None or value['issues'] != []:
            _fail('invalid_record', 'record_shape')
        if selection['status'] != 'completed' or selection['conclusion'] != 'success' or not deployment['exactJobMatched'] or deployment['latestStatus']['state'] != 'success':
            _fail('invalid_record', 'record_binding')
        for job in jobs:
            if job['status'] != 'completed' or job['conclusion'] != 'success':
                _fail('invalid_record', 'record_binding')
    return value['status']


def _binding(value, intent, snapshot_raw):
    format_name = _record_format(value, 'binding', _p('binding_keys'))
    if format_name is None or format_name != _record_format(intent, 'intent', _p('intent_keys')):
        _fail('invalid_record', 'record_shape')
    for name in ('attemptId', 'sequence', 'selector'):
        if value[name] != intent[name] or type(value[name]) is not type(intent[name]):
            _fail('invalid_record', 'record_binding')
    if value['snapshot'] != {'path': 'local-snapshot.json', 'sha256': _sha(snapshot_raw), 'bytes': len(snapshot_raw)}:
        _fail('invalid_record', 'record_binding')
    for name in ('normalBinding', 'publicationBinding', 'targetBinding', 'localBinding', 'repositoryPolicy'):
        if type(value[name]) is not dict:
            _fail('invalid_record', 'record_shape')
    _check_hash(value, 'bindingSha256')
    _binding_relations(value, _parse(snapshot_raw, _p('snapshot_bytes')), format_name)


def _result(value, intent, binding):
    format_name = _record_format(value, 'result', _p('result_keys'))
    if (format_name is None or format_name != _record_format(intent, 'intent', _p('intent_keys'))
            or value['status'] not in _p('states') or value['partial'] is not True or value['fullE05'] is not False
            or type(value['bindingVerified']) is not bool):
        _fail('invalid_record', 'record_shape')
    for name in ('attemptId', 'sequence', 'selector'):
        if value[name] != intent[name] or type(value[name]) is not type(intent[name]):
            _fail('invalid_record', 'record_binding')
    if value['intentSha256'] != intent['intentSha256']:
        _fail('invalid_record', 'record_binding')
    expected_hash = binding['bindingSha256'] if binding is not None else None
    if value['bindingSha256'] != expected_hash or (value['bindingVerified'] and binding is None) or (binding is None and value['metadata'] is not None):
        _fail('invalid_record', 'record_binding')
    if value['status'] == 'metadata_observed' and (not value['bindingVerified'] or value['metadata'] is None
            or value['implementationObservation'] is None or value['issues'] != []):
        _fail('invalid_record', 'record_shape')
    if ((value['metadata'] is not None and type(value['metadata']) is not dict)
            or (value['implementationObservation'] is not None and type(value['implementationObservation']) is not dict)):
        _fail('invalid_record', 'record_shape')
    caps = value['capabilities']
    if type(caps) is not dict or set(caps) != set(_p('capability_keys')):
        _fail('invalid_record', 'record_shape')
    for item in caps.values():
        if item is not False:
            _fail('invalid_record', 'record_shape')
    if type(value['coverage']) is not dict or type(value['issues']) is not list or len(value['issues']) > 1:
        _fail('invalid_record', 'record_shape')
    for issue in value['issues']:
        if type(issue) is not dict or set(issue) != {'domain', 'code', 'reason'}:
            _fail('invalid_record', 'record_shape')
        for item in issue.values():
            if type(item) is not str or not re.fullmatch('[a-z][a-z0-9_]{0,63}', item):
                _fail('invalid_record', 'record_shape')
    _keys(value['coverage'], ('localPublication', 'deploymentMetadata') + _p('record_not_checked'))
    for name in _p('record_not_checked'):
        if value['coverage'][name] != 'not_checked':
            _fail('invalid_record', 'record_shape')
    if value['coverage']['localPublication'] != ('observed_before_after' if value['bindingVerified'] else 'not_verified'):
        _fail('invalid_record', 'record_binding')
    if value['implementationObservation'] is not None:
        _implementation_check(value['implementationObservation'])
    if value['metadata'] is not None:
        if binding is None:
            _fail('invalid_record', 'record_binding')
        metadata_status = _collector_metadata(value['metadata'], binding['publicationBinding']['commitOid'],
                                              format_name)
        expected_status = 'unavailable' if metadata_status == 'unknown' else metadata_status
        if value['bindingVerified'] and value['status'] != expected_status:
            _fail('invalid_record', 'record_binding')
        expected_coverage = 'observed' if metadata_status == 'metadata_observed' else 'partial'
    else:
        expected_coverage = 'not_available'
    if value['coverage']['deploymentMetadata'] != expected_coverage:
        _fail('invalid_record', 'record_binding')
    _time(value['startedAt'])
    _time(value['finishedAt'])
    _check_hash(value, 'recordSha256')


def _attempt(scope, name):
    attempts = os.open('attempts', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=scope.fd)
    with _Fd(attempts):
        return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=attempts)


def _load_attempt(scope, name, aggregate):
    fd = _attempt(scope, name)
    with _Fd(fd):
        intent_raw = _read(fd, 'intent.json', _p('intent_bytes'), optional=True, aggregate=aggregate)
        if intent_raw is None:
            with os.scandir(fd) as unfinished:
                for item in unfinished:
                    if not item.name.startswith('.'):
                        _fail('invalid_record', 'record_binding')
            return None
        intent = _parse(intent_raw, _p('intent_bytes'))
        _intent(intent, scope.selector, name)
        binding_raw = _read(fd, 'binding.json', _p('binding_bytes'), optional=True, aggregate=aggregate)
        snapshot_raw = _read(fd, 'local-snapshot.json', _p('snapshot_bytes'), optional=True, aggregate=aggregate)
        binding = None
        if binding_raw is not None:
            if snapshot_raw is None:
                _fail('invalid_record', 'record_binding')
            _parse(snapshot_raw, _p('snapshot_bytes'))
            binding = _parse(binding_raw, _p('binding_bytes'))
            _binding(binding, intent, snapshot_raw)
        elif snapshot_raw is not None:
            _parse(snapshot_raw, _p('snapshot_bytes'))
        result_raw = _read(fd, 'result.json', _p('result_bytes'), optional=True, aggregate=aggregate)
        result = None
        if result_raw is not None:
            result = _parse(result_raw, _p('result_bytes'))
            _result(result, intent, binding)
        return {'intent': intent, 'binding': binding, 'result': result}


def _scan(scope):
    try:
        fd = os.open('attempts', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=scope.fd)
    except FileNotFoundError:
        return []
    rows, seen, aggregate, directory_count = [], set(), scope.budget, 0
    with _Fd(fd):
        with os.scandir(fd) as entries:
            for entry in entries:
                if entry.name.startswith('.'):
                    continue
                directory_count += 1
                if directory_count > _p('store_items'):
                    _fail('limit_exceeded', 'store_items')
                if not re.fullmatch('[1-9][0-9]{0,15}-[0-9a-f]{32}', entry.name):
                    _fail('invalid_record', 'record_shape')
                row = _load_attempt(scope, entry.name, aggregate)
                if row is None:
                    continue
                sequence = row['intent']['sequence']
                if sequence in seen:
                    _fail('invalid_record', 'sequence_conflict')
                seen.add(sequence)
                rows.append(row)
    rows.sort(key=_row_sequence)
    return rows


def _row_sequence(row):
    return row['intent']['sequence']


def _reference(row, terminal=False):
    intent = row['intent']
    if terminal:
        return {'sequence': intent['sequence'], 'id': intent['attemptId'],
                'recordSha256': row['result']['recordSha256']}
    return {'sequence': intent['sequence'], 'id': intent['attemptId'],
            'intentSha256': intent['intentSha256']}


def _index(rows, selector, revision, *, historical=False):
    latest, terminal, observed = None, None, None
    for row in rows:
        latest = _reference(row)
        if row['result'] is not None:
            terminal = _reference(row, True)
            if row['result']['status'] == 'metadata_observed' and row['result']['bindingVerified']:
                observed = _reference(row, True)
    return {**_protocol_header('index', historical=historical), 'selector': selector,
            'revision': revision, 'latestAttempt': latest, 'latestTerminal': terminal, 'lastObserved': observed}


def _control(scope, name):
    raw = _read(scope.fd, name, _p('control_bytes'), optional=True, aggregate=scope.budget)
    return raw, _parse(raw, _p('control_bytes')) if raw is not None else None


def _counter(scope, rows):
    raw, value = _control(scope, 'counter.json')
    if value is None:
        if rows or not scope.created_lock:
            _fail('invalid_record', 'sequence_conflict')
        return raw, 1
    if (_record_format(value, 'counter', ('selector', 'nextSequence')) is None
            or value['selector'] != scope.selector or type(value['nextSequence']) is not int
            or not 1 <= value['nextSequence'] <= _p('sequence_max') + 1
            or (rows and value['nextSequence'] <= rows[-1]['intent']['sequence'])):
        _fail('invalid_record', 'sequence_conflict')
    return raw, value['nextSequence']


def _old_index(scope, rows):
    raw, old = _control(scope, 'index.json')
    if old is None:
        return raw, None
    if (_record_format(old, 'index', ('selector', 'revision', 'latestAttempt', 'latestTerminal', 'lastObserved')) is None
            or old['selector'] != scope.selector or type(old['revision']) is not int
            or not 1 <= old['revision'] <= _p('sequence_max')):
        _fail('invalid_record', 'record_shape')
    for field in ('latestAttempt', 'latestTerminal', 'lastObserved'):
        reference = old[field]
        if reference is None:
            continue
        if type(reference) is not dict or not _seq(reference.get('sequence')) or type(reference.get('id')) is not str:
            _fail('invalid_record', 'record_shape')
        matched = False
        for row in rows:
            if field == 'latestAttempt':
                candidate = _reference(row)
            elif row['result'] is None:
                continue
            elif field == 'lastObserved' and (row['result']['status'] != 'metadata_observed'
                                              or not row['result']['bindingVerified']):
                continue
            else:
                candidate = _reference(row, True)
            if reference == candidate:
                matched = True
                break
        if not matched:
            _fail('invalid_record', 'record_binding')
    return raw, old


def _save_index(scope, rows):
    raw, old = _old_index(scope, rows)
    revision = old['revision'] + 1 if old is not None else 1
    if revision > _p('sequence_max'):
        _fail('limit_exceeded', 'store_items')
    new = _canonical(_index(rows, scope.selector, revision), _p('control_bytes'))
    try:
        _publish(scope.fd, 'index.json', new, replace=True, expected=raw, aggregate=scope.budget)
    except DeploymentStoreError as error:
        error.reason = 'index_update'
        raise


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _attach(error, handle=None, intent=None):
    if handle is not None:
        if error.recording == 'not_saved':
            error.recording = handle.recording
        intent = _parse(handle.intent, _p('intent_bytes'))
    if intent is not None:
        error.attempt_id = intent['attemptId']
        error.sequence = intent['sequence']
    return error


def reserve(root, selector):
    _guard()
    root, selector = _root(root), _selector(selector)
    intent, handle = None, None
    try:
        with _Scope(root, selector, True) as scope:
            attempts = _mkdir(scope.fd, 'attempts')
            _close_fds((attempts,))
            rows = _scan(scope)
            counter_raw, sequence = _counter(scope, rows)
            if sequence > _p('sequence_max'):
                _fail('limit_exceeded', 'store_items')
            counter = {**_protocol_header('counter'),
                       'selector': selector, 'nextSequence': sequence + 1}
            _publish(scope.fd, 'counter.json', _canonical(counter, _p('control_bytes')),
                     replace=True, expected=counter_raw, aggregate=scope.budget)
            attempt_id = str(sequence) + '-' + uuid.uuid4().hex
            intent = _hashed({**_protocol_header('intent'),
                'attemptId': attempt_id, 'sequence': sequence, 'selector': selector,
                'requestedAt': _now(), 'scope': 'deployment_metadata_only',
                'parentAttemptId': None}, 'intentSha256')
            attempts = os.open('attempts', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=scope.fd)
            with _Fd(attempts):
                fd = _mkdir(attempts, attempt_id)
            with _Fd(fd):
                _publish(fd, 'intent.json', _canonical(intent, _p('intent_bytes')), aggregate=scope.budget)
            handle = _Handle(root, selector, intent, scope)
            _save_index(scope, _scan(scope))
        return dict(intent), handle
    except DeploymentStoreError as error:
        raise _attach(error, handle, intent) from None
    except (OSError, UnicodeError, RuntimeError):
        raise _attach(DeploymentStoreError('unavailable', 'write_failed'), handle, intent) from None


def _handle_inputs(handle, allow_closed=False):
    if type(handle) is not _Handle or handle._owner is not handle:
        _fail('invalid_argument', 'handle_identity')
    if handle.closed and not allow_closed:
        _fail('invalid_argument', 'handle_closed')
    return _root(handle.root), _selector(handle.selector)


def bind(handle, binding, snapshot):
    _guard()
    root, selector = _handle_inputs(handle)
    if type(binding) is not dict or type(snapshot) is not dict:
        _fail('invalid_record', 'record_shape')
    try:
        snapshot_raw = _canonical(snapshot, _p('snapshot_bytes'))
        binding_raw = _canonical(binding, _p('binding_bytes'))
        with _Scope(root, selector) as scope:
            intent = _handle(handle, scope)
            row = _load_attempt(scope, intent['attemptId'], scope.budget)
            if row is None:
                _fail('conflict', 'record_binding')
            if _canonical(row['intent'], _p('intent_bytes')) != handle.intent:
                _fail('conflict', 'record_binding')
            if row['result'] is not None:
                _fail('conflict', 'record_exists')
            _binding(binding, intent, snapshot_raw)
            fd = _attempt(scope, intent['attemptId'])
            with _Fd(fd):
                _publish(fd, 'local-snapshot.json', snapshot_raw, aggregate=scope.budget)
                _publish(fd, 'binding.json', binding_raw, aggregate=scope.budget)
        return {'path': 'binding.json', 'sha256': _sha(binding_raw), 'bytes': len(binding_raw)}
    except DeploymentStoreError as error:
        raise _attach(error, handle) from None
    except (OSError, UnicodeError, RuntimeError):
        raise _attach(DeploymentStoreError('unavailable', 'write_failed'), handle) from None


def _caps():
    out = {}
    for name in _p('capability_keys'):
        out[name] = False
    return out


def _outcome(intent, ref):
    return {**_protocol_header('outcome'), 'selector': intent['selector'],
        'attemptId': intent['attemptId'], 'sequence': intent['sequence'], 'recording': 'recorded',
        'resultRef': ref, 'issues': [], 'partial': True, 'fullE05': False, 'capabilities': _caps()}


def finish(handle, result):
    _guard()
    root, selector = _handle_inputs(handle, allow_closed=True)
    if type(result) is not dict:
        _fail('invalid_record', 'record_shape')
    ref = None
    try:
        raw = _canonical(result, _p('result_bytes'))
        with _Scope(root, selector) as scope:
            intent = _handle(handle, scope, allow_closed=True)
            row = _load_attempt(scope, intent['attemptId'], scope.budget)
            if row is None:
                _fail('conflict', 'record_binding')
            if _canonical(row['intent'], _p('intent_bytes')) != handle.intent:
                _fail('conflict', 'record_binding')
            _result(result, intent, row['binding'])
            if row['result'] is not None and _canonical(row['result'], _p('result_bytes')) != raw:
                _fail('conflict', 'record_exists')
            fd = _attempt(scope, intent['attemptId'])
            with _Fd(fd):
                _publish(fd, 'result.json', raw, aggregate=scope.budget)
            ref = {'path': 'result.json', 'sha256': _sha(raw), 'bytes': len(raw)}
            _save_index(scope, _scan(scope))
        handle.closed = True
        return _outcome(intent, ref)
    except DeploymentStoreError as error:
        error = _attach(error, handle)
        error.result_ref = ref
        raise error from None
    except (OSError, UnicodeError, RuntimeError):
        error = _attach(DeploymentStoreError('unavailable', 'write_failed'), handle)
        error.result_ref = ref
        raise error from None


def _empty(selector):
    return {**_protocol_header('status'), 'status': 'not_recorded',
        'selector': selector, 'observedAt': _now(), 'latestAttempt': None, 'lastObserved': None,
        'indexConsistent': True, 'partial': True, 'fullE05': False,
        'coverage': {'recordIntegrity': 'checked', 'currentInputs': 'not_checked',
                     'deploymentNow': 'not_checked', 'finalAcceptance': 'not_checked'},
        'issues': [], 'capabilities': _caps()}


def read_status(root, selector):
    _guard()
    root, selector = _root(root), _selector(selector)
    result = _empty(selector)
    try:
        try:
            scope = _Scope(root, selector, exclusive=False)
            scope.__enter__()
        except FileNotFoundError:
            # Missing lock inside an existing selector is corruption, not absence.
            target = pathlib.Path(root) / _digest(selector)
            if target.exists():
                _fail('unavailable', 'lock_failed')
            return result
        try:
            rows = _scan(scope)
            _counter(scope, rows)
            _raw, old = _old_index(scope, rows)
            expected = _index(rows, selector, old['revision'] if old is not None else 1,
                              historical=old is not None and old['contract'] == _protocol_header('index', historical=True)['contract'])
            result['indexConsistent'] = old == expected
            if rows:
                latest = rows[-1]
                intent, terminal = latest['intent'], latest['result']
                result['status'] = 'local_record_observed'
                result['latestAttempt'] = {**_reference(latest),
                    'state': terminal['status'] if terminal is not None else 'pending_unresolved',
                    'recordSha256': terminal['recordSha256'] if terminal is not None else None}
                result['lastObserved'] = expected['lastObserved']
        except BaseException as error:
            scope.__exit__(type(error), error, None)
            raise
        else:
            scope.__exit__(None, None, None)
        return result
    except DeploymentStoreError as error:
        result['status'] = 'unavailable'
        result['latestAttempt'], result['lastObserved'] = None, None
        result['indexConsistent'] = False
        result['coverage']['recordIntegrity'] = 'not_available'
        result['issues'] = [{'domain': 'storage', 'code': error.code, 'reason': error.reason}]
        return result
    except (OSError, UnicodeError, RuntimeError):
        result['status'] = 'unavailable'
        result['latestAttempt'], result['lastObserved'] = None, None
        result['indexConsistent'] = False
        result['coverage']['recordIntegrity'] = 'not_available'
        result['issues'] = [{'domain': 'storage', 'code': 'unavailable', 'reason': 'read_failed'}]
        return result


if __name__ == '__main__':
    _guard()
    raise SystemExit('此模块只供部署观察机械存储内部调用。')
