"""Thread-safe persistent Node JSON-RPC client for read-only publication replay CLIs.

Avoids repeated V8 startup and JS module parse/compile across 66-paper replays
while preserving cold-disk reads, 0600 single-link O_NOFOLLOW request files,
network-denied execution, complete transitive JS/JSON/.env stamp invalidation,
strict per-request timeouts, and process-group SIGKILL cleanup on timeout,
truncation, interruption, or crash.
"""

import atexit
import base64
import binascii
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import itertools
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from types import SimpleNamespace


SCRIPTS_DIR = Path(__file__).resolve().parent
DEFAULT_WORKER_SCRIPT = SCRIPTS_DIR / 'lib' / 'publish-node-replay-worker.js'
WORKER_SCRIPT_NAME = DEFAULT_WORKER_SCRIPT.name

SUPPORTED_REPLAY_CLIS = frozenset({
    'core-summary-semantic-replay-cli.js',
    'reader-dom-span-replay-cli.js',
    'reader-pdf-selection-replay-cli.js',
    'reader-resource-claims-replay-cli.js',
    'reader-author-replay-cli.js',
    'daily-scoring-refresh-checkpoint-cli.js',
})

MAX_IDLE_WORKERS_PER_KEY = max(1, min(8, os.cpu_count() or 4))
_FORBIDDEN_NODE_ENV_KEYS = frozenset({'NODE_OPTIONS', 'NODE_PATH'})
_STAMP_SKIP_DIRS = frozenset({
    '__pycache__', 'node_modules', '.git', '.venv', 'data', 'logs', 'tmp',
    '.pytest_cache', 'fixtures', '_understanding', 'output',
})
_STAMP_CODE_SUFFIXES = ('.js', '.cjs', '.mjs', '.json')

_POOL_LOCK = threading.Lock()
_TREE_DIGEST_CACHE_LOCK = threading.Lock()
_IDLE_WORKERS = {}
_TREE_DIGEST_CACHE = {}
_TREE_DIGEST_BATCH_SCOPE = ContextVar('_TREE_DIGEST_BATCH_SCOPE', default=None)
_REQUEST_ID_COUNTER = itertools.count(1)
_WORKER_SPAWN_COUNTER = itertools.count(1)
_TOTAL_SPAWNED_WORKERS = 0


@contextmanager
def tree_digest_batch_scope():
    """在单次只读批量重放期间按 project_root 缓存已核验代码树摘要，避免每条 RPC 重扫磁盘。"""
    existing = _TREE_DIGEST_BATCH_SCOPE.get()
    if existing is not None:
        yield existing
        return
    token = _TREE_DIGEST_BATCH_SCOPE.set({})
    try:
        yield _TREE_DIGEST_BATCH_SCOPE.get()
    finally:
        _TREE_DIGEST_BATCH_SCOPE.reset(token)


def _file_stamp(path):
    try:
        info = os.lstat(path)
    except OSError:
        return None
    return (info.st_mtime_ns, info.st_size, info.st_ino)


def _dir_stamp(path):
    try:
        info = os.lstat(path)
    except OSError:
        return None
    return (info.st_mtime_ns, info.st_ino)


def _project_root_for_worker(worker_realpath):
    worker_path = Path(worker_realpath)
    if len(worker_path.parents) > 2:
        return worker_path.parents[2]
    return worker_path.parent


def _tree_code_digest(project_root):
    root_key = str(project_root)
    batch = _TREE_DIGEST_BATCH_SCOPE.get()
    with _TREE_DIGEST_CACHE_LOCK:
        if batch is not None and root_key in batch:
            return batch[root_key]
        cached = _TREE_DIGEST_CACHE.get(root_key)
    if cached is not None:
        dir_stamps, file_stamps, cached_digest = cached
        unchanged = True
        for dpath, expected in dir_stamps:
            if _dir_stamp(dpath) != expected:
                unchanged = False
                break
        if unchanged:
            for fpath, expected in file_stamps:
                if _file_stamp(fpath) != expected:
                    unchanged = False
                    break
        if unchanged:
            if batch is not None:
                with _TREE_DIGEST_CACHE_LOCK:
                    batch[root_key] = cached_digest
            return cached_digest

    entries = []
    dir_stamps = []
    file_stamps = []

    def scan_dir(abs_dir, rel_prefix):
        dir_stamps.append((abs_dir, _dir_stamp(abs_dir)))
        try:
            it = os.scandir(abs_dir)
        except OSError:
            return
        with it:
            items = sorted(it, key=lambda item: item.name)
            for entry in items:
                name = entry.name
                if name in _STAMP_SKIP_DIRS:
                    continue
                rel = f'{rel_prefix}/{name}'
                try:
                    if entry.is_symlink():
                        entries.append((rel, 'symlink'))
                        file_stamps.append((entry.path, _file_stamp(entry.path)))
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        scan_dir(entry.path, rel)
                    elif name.endswith(_STAMP_CODE_SUFFIXES) and entry.is_file(follow_symlinks=False):
                        st = entry.stat(follow_symlinks=False)
                        stamp = (st.st_mtime_ns, st.st_size, st.st_ino)
                        entries.append((rel, st.st_mtime_ns, st.st_size, st.st_ino))
                        file_stamps.append((entry.path, stamp))
                except OSError:
                    entries.append((rel, 'missing'))
                    file_stamps.append((entry.path, None))

    for sub in ('scripts', 'manual/scripts', 'config'):
        scan_dir(os.path.join(root_key, sub), sub)
    digest = hashlib.blake2b(repr(entries).encode('utf-8'), digest_size=32).hexdigest()
    with _TREE_DIGEST_CACHE_LOCK:
        _TREE_DIGEST_CACHE[root_key] = (tuple(dir_stamps), tuple(file_stamps), digest)
        if batch is not None:
            batch[root_key] = digest
    return digest


def _sanitized_worker_env(env):
    source = os.environ if env is None else env
    cleaned = {
        str(k): str(v)
        for k, v in source.items()
        if k not in _FORBIDDEN_NODE_ENV_KEYS
    }
    cleaned['VERIFY_PROJECT_DISABLE_FILE_LOGS'] = '1'
    return cleaned


def _env_fingerprint(cleaned_env):
    encoded = json.dumps(cleaned_env, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def _implementation_stamp(worker_realpath, cwd_realpath):
    project_root = _project_root_for_worker(worker_realpath)
    return (
        _file_stamp(worker_realpath),
        _file_stamp(Path(cwd_realpath) / '.env'),
        _file_stamp(project_root / '.env'),
        _tree_code_digest(str(project_root)),
    )


def _worker_loaded_files_unchanged(worker):
    for loaded_path, expected_stamp in worker.loaded_file_stamps.items():
        if _file_stamp(loaded_path) != expected_stamp:
            return False
    return True


def _read_bounded_temp_stderr(handle, max_output_bytes):
    try:
        handle.flush()
        size = os.fstat(handle.fileno()).st_size
        truncated = size > max_output_bytes
        handle.seek(0)
        raw = handle.read(max_output_bytes)
        return raw, truncated
    except OSError:
        return b'', False


class _PersistentReplayWorker:
    __slots__ = (
        'pool_key',
        'stamp',
        'cli_stamps',
        'loaded_file_stamps',
        'process',
        'stdin_fd',
        'resp_r',
        '_resp_r_closed',
        'stderr_file',
        'temp_dir',
        'disposed',
    )

    def __init__(self, *, pool_key, stamp, process, stdin_fd, resp_r, stderr_file, temp_dir):
        self.pool_key = pool_key
        self.stamp = stamp
        self.cli_stamps = {}
        self.loaded_file_stamps = {}
        self.process = process
        self.stdin_fd = stdin_fd
        self.resp_r = resp_r
        self._resp_r_closed = False
        self.stderr_file = stderr_file
        self.temp_dir = temp_dir
        self.disposed = False


def _kill_process_group(process):
    if process.poll() is None:
        if os.name != 'nt':
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except OSError:
                try:
                    process.kill()
                except OSError:
                    pass
        else:
            try:
                process.kill()
            except OSError:
                pass
    try:
        return process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            process.kill()
        except OSError:
            pass
        return process.wait()


def _nonzero_timeout_returncode(rc):
    return rc if (isinstance(rc, int) and rc != 0) else -signal.SIGKILL


def _dispose_worker(worker):
    if worker is None or worker.disposed:
        return -signal.SIGKILL
    worker.disposed = True
    # IMPORTANT: Always SIGKILL and reap the worker process group BEFORE closing
    # stdin so Node's stdin 'end' listener can never exit(0) during a timeout!
    returncode = -signal.SIGKILL
    try:
        returncode = _kill_process_group(worker.process)
    finally:
        try:
            if worker.process.stdin is not None:
                worker.process.stdin.close()
        except OSError:
            pass
        if not worker._resp_r_closed:
            worker._resp_r_closed = True
            try:
                os.close(worker.resp_r)
            except OSError:
                pass
        try:
            worker.stderr_file.close()
        except OSError:
            pass
        try:
            shutil.rmtree(worker.temp_dir, ignore_errors=True)
        except OSError:
            pass
    return returncode


def _spawn_worker(*, node_path, worker_path, cwd_path, worker_env, pool_key, stamp):
    global _TOTAL_SPAWNED_WORKERS
    temp_dir = None
    stderr_file = None
    resp_r = None
    resp_w = None
    resp_r_open = False
    resp_w_open = False
    process = None
    try:
        temp_dir = Path(tempfile.mkdtemp(prefix='pd-node-replay-worker-'))
        os.chmod(temp_dir, 0o700)
        stderr_file = tempfile.TemporaryFile()
        resp_r, resp_w = os.pipe()
        resp_r_open = True
        resp_w_open = True
        process = subprocess.Popen(
            [node_path, str(worker_path), str(resp_w)],
            cwd=str(cwd_path),
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=stderr_file,
            env=worker_env,
            start_new_session=(os.name != 'nt'),
            pass_fds=(resp_w,),
        )
        # Close child's write end in parent immediately so EOF is observed on crash/exit.
        os.close(resp_w)
        resp_w_open = False
        os.set_blocking(resp_r, False)
        worker = _PersistentReplayWorker(
            pool_key=pool_key,
            stamp=stamp,
            process=process,
            stdin_fd=process.stdin.fileno(),
            resp_r=resp_r,
            stderr_file=stderr_file,
            temp_dir=temp_dir,
        )
        with _POOL_LOCK:
            _TOTAL_SPAWNED_WORKERS += 1
        next(_WORKER_SPAWN_COUNTER)
        return worker
    except BaseException:
        if process is not None:
            try:
                _kill_process_group(process)
            except BaseException:
                pass
            try:
                if process.stdin is not None:
                    process.stdin.close()
            except OSError:
                pass
        if resp_w_open and resp_w is not None:
            try:
                os.close(resp_w)
            except OSError:
                pass
        if resp_r_open and resp_r is not None:
            try:
                os.close(resp_r)
            except OSError:
                pass
        if stderr_file is not None:
            try:
                stderr_file.close()
            except OSError:
                pass
        if temp_dir is not None:
            shutil.rmtree(temp_dir, ignore_errors=True)
        raise


def _acquire_worker(*, node_path, worker_path, cli_realpath, cwd_path, worker_env, out_box=None):
    node_real = os.path.realpath(node_path)
    worker_real = os.path.realpath(worker_path)
    cwd_real = Path(os.path.realpath(cwd_path))
    pool_key = (node_real, worker_real, str(cwd_real), _env_fingerprint(worker_env))
    stamp = _implementation_stamp(worker_real, cwd_real)
    cli_stamp = _file_stamp(cli_realpath)

    stale = []
    chosen = None
    handed_off = False
    try:
        with _POOL_LOCK:
            bucket = _IDLE_WORKERS.get(pool_key)
            while bucket:
                candidate = bucket.pop()
                if (
                    candidate.process.poll() is not None
                    or candidate.stamp != stamp
                    or (cli_realpath in candidate.cli_stamps and candidate.cli_stamps[cli_realpath] != cli_stamp)
                    or not _worker_loaded_files_unchanged(candidate)
                ):
                    stale.append(candidate)
                    continue
                chosen = candidate
                break
            if bucket is not None and not bucket:
                _IDLE_WORKERS.pop(pool_key, None)

        while stale:
            dead = stale.pop()
            _dispose_worker(dead)

        if chosen is None:
            chosen = _spawn_worker(
                node_path=node_path,
                worker_path=worker_real,
                cwd_path=cwd_real,
                worker_env=worker_env,
                pool_key=pool_key,
                stamp=stamp,
            )
        chosen.stamp = stamp
        chosen.cli_stamps[cli_realpath] = cli_stamp
        if out_box is not None:
            out_box.append(chosen)
        handed_off = True
        return chosen
    finally:
        # Guarantee zero leaked workers/temp_dirs even if an async signal
        # (e.g., RenderDeadlineExceeded) interrupts stale disposal or handoff.
        cleanup_targets = list(stale)
        stale.clear()
        if not handed_off and chosen is not None:
            cleanup_targets.append(chosen)
        first_cleanup_exc = None
        for item in cleanup_targets:
            try:
                _dispose_worker(item)
            except BaseException as exc:
                if first_cleanup_exc is None:
                    first_cleanup_exc = exc
        if first_cleanup_exc is not None:
            raise first_cleanup_exc


def _release_worker(worker):
    if worker is None or worker.disposed or worker.process.poll() is not None:
        _dispose_worker(worker)
        return
    overflow = None
    with _POOL_LOCK:
        bucket = _IDLE_WORKERS.setdefault(worker.pool_key, [])
        if len(bucket) < MAX_IDLE_WORKERS_PER_KEY:
            bucket.append(worker)
        else:
            overflow = worker
    if overflow is not None:
        _dispose_worker(overflow)


def shutdown_all_workers():
    with _POOL_LOCK:
        workers = [w for bucket in _IDLE_WORKERS.values() for w in bucket]
        _IDLE_WORKERS.clear()
    first_exc = None
    for worker in workers:
        try:
            _dispose_worker(worker)
        except BaseException as exc:
            if first_exc is None:
                first_exc = exc
    if first_exc is not None:
        raise first_exc


def total_spawned_workers():
    with _POOL_LOCK:
        return _TOTAL_SPAWNED_WORKERS


def idle_worker_count():
    with _POOL_LOCK:
        return sum(len(bucket) for bucket in _IDLE_WORKERS.values())


if hasattr(os, 'register_at_fork'):
    def _before_fork_lock_pool():
        _POOL_LOCK.acquire()
        _TREE_DIGEST_CACHE_LOCK.acquire()

    def _after_fork_in_parent():
        _TREE_DIGEST_CACHE_LOCK.release()
        _POOL_LOCK.release()

    def _reset_pool_in_forked_child():
        global _POOL_LOCK, _TREE_DIGEST_CACHE_LOCK
        # Never kill parent workers or unlink parent temp_dirs in a forked child;
        # close inherited pipe/file descriptors cleanly, drop references, and
        # reinitialize locks so the child cannot deadlock on inherited state.
        workers = [w for bucket in _IDLE_WORKERS.values() for w in bucket]
        _IDLE_WORKERS.clear()
        for worker in workers:
            worker.disposed = True
            try:
                if worker.process.stdin is not None:
                    worker.process.stdin.close()
            except OSError:
                pass
            if not worker._resp_r_closed:
                worker._resp_r_closed = True
                try:
                    os.close(worker.resp_r)
                except OSError:
                    pass
            try:
                worker.stderr_file.close()
            except OSError:
                pass
        _POOL_LOCK = threading.Lock()
        _TREE_DIGEST_CACHE_LOCK = threading.Lock()

    os.register_at_fork(
        before=_before_fork_lock_pool,
        after_in_parent=_after_fork_in_parent,
        after_in_child=_reset_pool_in_forked_child,
    )

atexit.register(shutdown_all_workers)


def _write_private_request_file(temp_dir, req_id, payload):
    req_path = temp_dir / f'req-{req_id}.json'
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(req_path, flags, 0o600)
    try:
        view = memoryview(payload)
        offset = 0
        total = len(view)
        while offset < total:
            offset += os.write(fd, view[offset:])
    finally:
        os.close(fd)
    return req_path


def _write_request_line_with_deadline(worker, frame_bytes, deadline):
    os.set_blocking(worker.stdin_fd, False)
    try:
        with selectors.DefaultSelector() as sel:
            sel.register(worker.stdin_fd, selectors.EVENT_WRITE)
            view = memoryview(frame_bytes)
            offset = 0
            total = len(view)
            while offset < total:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                if not sel.select(remaining):
                    continue
                try:
                    written = os.write(worker.stdin_fd, view[offset:])
                    offset += written
                except BlockingIOError:
                    continue
            return True
    finally:
        try:
            os.set_blocking(worker.stdin_fd, True)
        except OSError:
            pass


def can_handle_replay_cli(cli_path):
    candidate = Path(cli_path)
    if candidate.name not in SUPPORTED_REPLAY_CLIS:
        return False
    worker_path = candidate.resolve().parent / WORKER_SCRIPT_NAME
    return worker_path.is_file() and not worker_path.is_symlink()


def run_node_replay_request(
    *,
    node,
    cli_path,
    payload,
    cwd,
    env,
    timeout_seconds,
    max_output_bytes,
    text=True,
):
    """Execute one read-only replay CLI request on a persistent network-denied worker.

    Returns a SimpleNamespace with the exact attributes of ``_run_bounded_subprocess``:
    ``(args, returncode, stdout, stderr, timed_out, output_truncated)``.
    """
    if not isinstance(payload, (bytes, bytearray, memoryview)):
        raise TypeError('Replay payload must be bytes-like')
    payload_bytes = bytes(payload)
    cli_resolved = Path(cli_path).resolve(strict=True)
    cli_name = cli_resolved.name
    if cli_name not in SUPPORTED_REPLAY_CLIS:
        raise ValueError(f'Unsupported replay CLI for persistent worker: {cli_name}')
    worker_path = cli_resolved.parent / WORKER_SCRIPT_NAME
    if not worker_path.is_file() or worker_path.is_symlink():
        raise FileNotFoundError(f'Replay worker missing or symlink: {worker_path}')
    if timeout_seconds is None or timeout_seconds <= 0:
        raise ValueError('timeout_seconds must be positive')
    if not isinstance(max_output_bytes, int) or max_output_bytes < 1:
        raise ValueError('max_output_bytes must be a positive integer')

    worker_env = _sanitized_worker_env(env)
    deadline = time.monotonic() + float(timeout_seconds)
    req_id = next(_REQUEST_ID_COUNTER)
    synthetic_args = [node, str(cli_path), '<worker-private-file>']

    acquired_box = []
    worker = None
    req_path = None
    keep_worker = False
    try:
        worker = _acquire_worker(
            node_path=node,
            worker_path=worker_path,
            cli_realpath=str(cli_resolved),
            cwd_path=cwd,
            worker_env=worker_env,
            out_box=acquired_box,
        )
        req_path = _write_private_request_file(worker.temp_dir, req_id, payload_bytes)
        request_frame = (
            json.dumps(
                {
                    'id': req_id,
                    'cli': cli_name,
                    'cliPath': str(cli_resolved),
                    'inputPath': str(req_path),
                    'maxOutputBytes': max_output_bytes,
                },
                ensure_ascii=False,
                separators=(',', ':'),
            )
            + '\n'
        ).encode('utf-8')

        try:
            wrote = _write_request_line_with_deadline(worker, request_frame, deadline)
        except BrokenPipeError:
            wrote = True  # Fall through to EOF handling on resp_r to capture startup stderr.

        if not wrote:
            stderr_raw, _ = _read_bounded_temp_stderr(worker.stderr_file, max_output_bytes)
            rc = _nonzero_timeout_returncode(_dispose_worker(worker))
            stdout_val = '' if text else b''
            stderr_val = stderr_raw.decode('utf-8', errors='replace') if text else stderr_raw
            return SimpleNamespace(
                args=synthetic_args,
                returncode=rc,
                stdout=stdout_val,
                stderr=stderr_val,
                timed_out=True,
                output_truncated=False,
            )

        # Base64 expands up to 4/3x; include 256 KiB framing headroom for JSON keys + newLoadedFiles.
        max_wire_bytes = max(262144, max_output_bytes * 4 + 262144)
        wire_buf = bytearray()
        response_line = None

        with selectors.DefaultSelector() as sel:
            sel.register(worker.resp_r, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    stderr_raw, _ = _read_bounded_temp_stderr(worker.stderr_file, max_output_bytes)
                    rc = _nonzero_timeout_returncode(_dispose_worker(worker))
                    stdout_val = '' if text else b''
                    stderr_val = stderr_raw.decode('utf-8', errors='replace') if text else stderr_raw
                    return SimpleNamespace(
                        args=synthetic_args,
                        returncode=rc,
                        stdout=stdout_val,
                        stderr=stderr_val,
                        timed_out=True,
                        output_truncated=False,
                    )
                events = sel.select(remaining)
                if not events:
                    continue
                try:
                    chunk = os.read(worker.resp_r, 65536)
                except BlockingIOError:
                    continue
                if not chunk:
                    # Premature EOF: worker crashed or rejected startup (e.g., CODEX_SANDBOX).
                    try:
                        rc = worker.process.wait(timeout=min(0.5, max(0.01, deadline - time.monotonic())))
                    except subprocess.TimeoutExpired:
                        rc = _kill_process_group(worker.process)
                    stderr_raw, stderr_trunc = _read_bounded_temp_stderr(worker.stderr_file, max_output_bytes)
                    _dispose_worker(worker)
                    stdout_val = '' if text else b''
                    stderr_val = stderr_raw.decode('utf-8', errors='replace') if text else stderr_raw
                    return SimpleNamespace(
                        args=synthetic_args,
                        returncode=rc if rc != 0 else 1,
                        stdout=stdout_val,
                        stderr=stderr_val,
                        timed_out=False,
                        output_truncated=stderr_trunc,
                    )
                wire_buf.extend(chunk)
                if len(wire_buf) > max_wire_bytes:
                    _dispose_worker(worker)
                    stdout_val = '' if text else b''
                    stderr_val = '' if text else b''
                    return SimpleNamespace(
                        args=synthetic_args,
                        returncode=1,
                        stdout=stdout_val,
                        stderr=stderr_val,
                        timed_out=False,
                        output_truncated=True,
                    )
                newline_idx = wire_buf.find(0x0A)
                if newline_idx != -1:
                    if newline_idx != len(wire_buf) - 1:
                        # Unexpected extra bytes on synchronized request-response pipe; fail closed.
                        _dispose_worker(worker)
                        return SimpleNamespace(
                            args=synthetic_args,
                            returncode=1,
                            stdout='' if text else b'',
                            stderr='Unexpected trailing bytes in replay worker protocol' if text else b'Unexpected trailing bytes in replay worker protocol',
                            timed_out=False,
                            output_truncated=False,
                        )
                    response_line = bytes(wire_buf[:newline_idx])
                    break

        try:
            envelope = json.loads(response_line.decode('utf-8'))
            if (
                not isinstance(envelope, dict)
                or envelope.get('id') != req_id
                or type(envelope.get('returncode')) is not int
                or not isinstance(envelope.get('stdoutBase64'), str)
                or not isinstance(envelope.get('stderrBase64'), str)
                or not isinstance(envelope.get('stdoutTruncated'), bool)
                or not isinstance(envelope.get('stderrTruncated'), bool)
            ):
                raise ValueError('Invalid worker response envelope')
            new_loaded_files = envelope.get('newLoadedFiles', [])
            if not isinstance(new_loaded_files, list) or any(not isinstance(p, str) for p in new_loaded_files):
                raise ValueError('Invalid worker newLoadedFiles list')
            stdout_raw = base64.b64decode(envelope['stdoutBase64'], validate=True)
            stderr_raw = base64.b64decode(envelope['stderrBase64'], validate=True)
        except (UnicodeDecodeError, ValueError, binascii.Error):
            _dispose_worker(worker)
            return SimpleNamespace(
                args=synthetic_args,
                returncode=1,
                stdout='' if text else b'',
                stderr='Malformed replay worker response envelope' if text else b'Malformed replay worker response envelope',
                timed_out=False,
                output_truncated=False,
            )

        for loaded_file in new_loaded_files:
            worker.loaded_file_stamps[loaded_file] = _file_stamp(loaded_file)

        output_truncated = (
            envelope['stdoutTruncated']
            or envelope['stderrTruncated']
            or len(stdout_raw) > max_output_bytes
            or len(stderr_raw) > max_output_bytes
        )
        stdout_raw = stdout_raw[:max_output_bytes]
        stderr_raw = stderr_raw[:max_output_bytes]

        if not output_truncated:
            keep_worker = True
        else:
            # Recycle worker immediately on output truncation as required.
            _dispose_worker(worker)

        stdout_val = stdout_raw.decode('utf-8', errors='replace') if text else stdout_raw
        stderr_val = stderr_raw.decode('utf-8', errors='replace') if text else stderr_raw
        return SimpleNamespace(
            args=synthetic_args,
            returncode=envelope['returncode'],
            stdout=stdout_val,
            stderr=stderr_val,
            timed_out=False,
            output_truncated=output_truncated,
        )
    finally:
        target_worker = worker if worker is not None else (acquired_box[0] if acquired_box else None)
        if req_path is not None:
            try:
                os.unlink(req_path)
            except FileNotFoundError:
                pass
            except OSError:
                keep_worker = False
        if keep_worker and target_worker is not None:
            _release_worker(target_worker)
        elif target_worker is not None:
            _dispose_worker(target_worker)


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('publish_node_replay_client.py')
    raise SystemExit('此模块由发布与页面校验入口调用，不是独立生产命令。')
