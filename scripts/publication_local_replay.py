"""Private, invocation-local transport evidence for read-only publication workers.

The response is never a serialized source capability. It only avoids executing
the same normal worker several times during one synchronous page render.
"""
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import json
from pathlib import Path
import signal
import sys
import os
import stat
import time
import weakref
from publish_common import PublishDataValidationError

ROOT = Path(__file__).resolve().parent
POLICY = json.loads((ROOT / 'publication_replay_policy.json').read_text())
SOURCE_REPLAY_SECONDS = POLICY['sourceReplaySeconds']
SIMPLE_REPLAY_SECONDS = POLICY['simpleReplaySeconds']
_scope = ContextVar('publication_local_replay', default=None)
_issued = set()
_deadlines = weakref.WeakKeyDictionary()
_WORKERS = frozenset({'reader-resource-claims-replay-cli.js', 'core-summary-semantic-replay-cli.js'})


class RenderDeadlineExceeded(TimeoutError):
    """Only a real SIGALRM recorded by the active guard can issue its protocol."""
    pass


def _sha(value):
    return hashlib.sha256(value).hexdigest()


class LocalReplayFailure(PublishDataValidationError):
    def __init__(self, message, *, worker, result=None, timeout_seconds=None):
        super().__init__(message)
        self.worker = worker
        self.timed_out = bool(result and result.timed_out)
        self.output_truncated = bool(result and result.output_truncated)
        self.returncode = result.returncode if result else None
        self.timeout_seconds = timeout_seconds
        self.stdout_sha256 = _sha((result.stdout or '').encode()) if result else _sha(b'')
        self.stderr_sha256 = _sha((getattr(result, 'stderr', '') or '').encode()) if result else _sha(b'')
        self.stdout_bytes = len((result.stdout or '').encode()) if result else 0
        self.stderr_bytes = len((getattr(result, 'stderr', '') or '').encode()) if result else 0

    def protocol(self, renderer):
        worker = ROOT / 'lib' / self.worker
        return {'contract': 'publication-local-replay-failure-v1',
                'renderer': Path(renderer).name, 'worker': self.worker,
                'workerSha256': _sha(worker.read_bytes()) if self.worker in _WORKERS else None,
                'rendererSha256': _sha(Path(renderer).read_bytes()),
                'timedOut': self.timed_out, 'outputTruncated': self.output_truncated,
                'returncode': self.returncode, 'timeoutSeconds': self.timeout_seconds,
                'stdoutSha256': self.stdout_sha256, 'stderrSha256': self.stderr_sha256,
                'stdoutBytes': self.stdout_bytes, 'stderrBytes': self.stderr_bytes}


def checked_replay_response(result, *, worker, timeout_seconds, failure_label='真实来源冷重放未完整正常退出'):
    """Inspect execution flags before parsing JSON; retain safe physical diagnostics."""
    if worker not in _WORKERS:
        raise ValueError('Unknown fixed publication replay worker')
    if result.timed_out or result.output_truncated or result.returncode != 0:
        failure = LocalReplayFailure(failure_label, worker=worker,
                                    result=result, timeout_seconds=timeout_seconds)
        raise failure
    try:
        response = json.loads(result.stdout)
    except (ValueError, TypeError) as error:
        raise LocalReplayFailure('本地来源重放响应不是完整 JSON', worker=worker,
                                 result=result, timeout_seconds=timeout_seconds) from error
    if not isinstance(response, dict):
        raise LocalReplayFailure('本地来源重放响应必须为对象', worker=worker,
                                 result=result, timeout_seconds=timeout_seconds)
    return response


def requires_source_replay(paper):
    if not isinstance(paper, dict):
        return False
    locator = paper.get('conferenceSourceCorrection')
    return (isinstance(locator, dict) and locator.get('contract') in {
        'conference-source-resource-correction-v1', 'conference-source-core-correction-v1'}) \
        or any(isinstance(b, dict) and 'authenticatedPdfTableEvidence' in b
               for b in (paper.get('apiReaderPlan') or {}).get('tableBindings', [])) \
        or any(isinstance(r, dict) and 'authenticatedPdfFootnoteEvidence' in r
               for r in (paper.get('apiReaderResources') or {}).get('resources', []))


def render_budget_seconds(packet, kind):
    if isinstance(packet, dict) and 'aggregatePresentationBatch' in packet:
        records = packet['aggregatePresentationBatch']
        if isinstance(records, list) and 1 <= len(records) <= POLICY['maxAggregatePapers']:
            return POLICY['renderOverheadSeconds'] + sum(
                SOURCE_REPLAY_SECONDS if requires_source_replay(r.get('paper')) else SIMPLE_REPLAY_SECONDS
                for r in records if isinstance(r, dict))
    if isinstance(packet, dict) and requires_source_replay(packet.get('paper')):
        return SOURCE_REPLAY_SECONDS + POLICY['renderOverheadSeconds']
    return POLICY['ordinaryConferenceSeconds' if kind == 'conference' else 'ordinaryHistorySeconds']


@contextmanager
def render_process_guard(seconds, *, renderer=None):
    """Interrupt the active bounded wait so its existing finally kills its process group."""
    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGALRM, signal.SIGTERM)}
    old_timer = signal.getitimer(signal.ITIMER_REAL)
    started = time.monotonic()
    def interrupted(signum, _frame):
        if signum == signal.SIGTERM:
            raise InterruptedError('本地页面渲染已停止，正在清理子进程')
        if time.monotonic() - started < seconds:
            raise InterruptedError('非本地期限触发的信号已停止页面渲染')
        error = RenderDeadlineExceeded('固定本地页面渲染总期限已到，正在清理子进程')
        if renderer is not None:
            filename = Path(renderer)
            if filename.parent.resolve() == ROOT and filename.name in {'conference-page-render.py', 'historical-page-render.py'}:
                _deadlines[error] = {'contract': 'publication-fixed-render-deadline-v1',
                    'renderer': filename.name, 'rendererSha256': _sha(filename.read_bytes()),
                    'signal': 'SIGALRM', 'timeoutSeconds': seconds}
        raise error
    try:
        for sig in previous:
            signal.signal(sig, interrupted)
        signal.setitimer(signal.ITIMER_REAL, seconds)
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        if old_timer[0]:
            signal.setitimer(signal.ITIMER_REAL,
                max(0.000001, old_timer[0] - (time.monotonic() - started)), old_timer[1])


def emit_replay_failure(error, renderer):
    # This descriptor is created by the fixed Node bridge. Article text and
    # ordinary stderr cannot manufacture the bridge's typed failure channel.
    if isinstance(error, RenderDeadlineExceeded):
        protocol = _deadlines.pop(error, None)
        if protocol is None:
            raise ValueError('未登记的页面期限错误不能签发本地超时身份')
    elif isinstance(error, LocalReplayFailure):
        protocol = error.protocol(renderer)
    else:
        raise ValueError('未知本地重放错误不能签发身份')
    raw = os.environ.get('PD_PUBLICATION_ERROR_FD', '')
    if raw.isdecimal() and int(raw) >= 3:
        fd = int(raw); info = os.fstat(fd)
        if stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_mode & 0o777 == 0o600 \
                and info.st_size == 0:
            os.write(fd, json.dumps(protocol, separators=(',', ':')).encode())
    sys.stderr.write('固定本地出版重放未完整完成；退出码、超时及输出摘要已保留。\n')


def _paper_pin(paper):
    return _sha(json.dumps(paper, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode())


def publication_replay_result(paper, source_text=None, publication_evidence=None):
    value = _scope.get()
    if value is None or id(value) not in _issued or value['paper'] is not paper:
        return None
    if _paper_pin(paper) != value['paperSha256']:
        raise ValueError('同次出版重放期间原论文发生变化')
    if source_text is not None and source_text != value['sourceText']:
        raise ValueError('同次出版重放的封存来源发生变化')
    if publication_evidence is not None and publication_evidence != value['publicationEvidence']:
        raise ValueError('同次出版补证发生变化')
    if _paper_pin(value['response']) != value['responseSha256']:
        raise ValueError('同次真实重放返回内容发生变化')
    return value['response']


@contextmanager
def publication_replay_scope(paper, source_text, publication_evidence=None, *, publisher):
    """One genuine private-FD response, scoped to one exact in-memory paper."""
    if not requires_source_replay(paper) or not isinstance(source_text, str):
        yield
        return
    import os
    import shutil
    import tempfile
    if _sha(source_text.encode()) != paper.get('sourceSha256'):
        raise ValueError('同次出版重放缺少匹配的封存全文')
    node = shutil.which('node')
    if not node:
        raise ValueError('同次出版重放需要 Node.js')
    request = {'paper': paper, 'sourceText': source_text, 'resourcePresentation': True,
               'publicationReplay': True}
    if publication_evidence is not None:
        request['publicationEvidence'] = publication_evidence
    payload = json.dumps(request, ensure_ascii=False, separators=(',', ':')).encode()
    if len(payload) > 128 * 1024 * 1024:
        raise ValueError('同次出版重放输入超过上限')
    worker = 'reader-resource-claims-replay-cli.js'
    with tempfile.TemporaryFile() as source:
        source.write(payload); source.flush(); source.seek(0)
        result = publisher._run_bounded_subprocess(
            [node, str(ROOT / 'lib' / worker), str(source.fileno())], cwd=str(ROOT.parent),
            env={k: v for k, v in os.environ.items() if k not in {'NODE_OPTIONS', 'NODE_PATH'}},
            timeout_seconds=SOURCE_REPLAY_SECONDS, max_output_bytes=1024 * 1024,
            pass_fds=(source.fileno(),))
    response = checked_replay_response(result, worker=worker, timeout_seconds=SOURCE_REPLAY_SECONDS)
    if response.get('verified') is not True or not isinstance(response.get('resources'), list) \
            or 'coreSummaryIssue' not in response \
            or response['coreSummaryIssue'] is not None \
            or response.get('publicationReplay') != {
                'contract': 'publication-one-invocation-source-replay-v1', 'inputSha256': _sha(payload)}:
        raise ValueError('同次出版的来源、资源或核心阶段未通过正常重放')
    value = {'paper': paper, 'paperSha256': _paper_pin(paper), 'sourceText': source_text,
             'publicationEvidence': publication_evidence, 'response': response,
             'responseSha256': _paper_pin(response)}
    _issued.add(id(value)); token = _scope.set(value)
    try:
        yield
        publication_replay_result(paper, source_text, publication_evidence)
    finally:
        _scope.reset(token); _issued.remove(id(value))


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('publication_local_replay.py')
    raise SystemExit('此模块由已核验的发布与页面入口调用，不是独立生产入口。')
