"""记录模型请求的用量、状态与摘要，不保存请求或响应正文；格式与 lib/llm-usage.js 一致。"""
if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('llm_usage.py')

import contextvars
import base64
import hashlib
import json
import os
import re
import stat
import sys
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from path_config import LLM_USAGE_DIR, LLM_RESPONSE_RECOVERY_DIR

VERSION = 'llm-usage-v1'
_SCOPE = contextvars.ContextVar('paper_digest_llm_usage', default={})

class LlmUsagePersistenceError(RuntimeError):
    __slots__ = ('_llm_response', '_usage_event', '_response_recovery_error')
    code = 'LLM_USAGE_NOT_PERSISTED'
    scope = 'run'
    category = 'storage'
    retryable = False

    llm_response = property(lambda self: self._llm_response,
                            lambda self, value: setattr(self, '_llm_response', value))
    usage_event = property(lambda self: self._usage_event,
                           lambda self, value: setattr(self, '_usage_event', value))
    response_recovery_error = property(lambda self: self._response_recovery_error,
                                      lambda self, value: setattr(self, '_response_recovery_error', value))


def _now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 9007199254740991 else None


def _label(value):
    return value if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.:/-]{1,200}', value) else None


def _digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def normalize_usage_paper_id(value):
    if not isinstance(value, str):
        return None
    arxiv = value.removeprefix('arxiv:')
    if re.fullmatch(r'(?:[0-9]{4}\.[0-9]{4,5}|[a-z-]+(?:\.[A-Z]{2})?/[0-9]{7})(?:v[0-9]+)?', arxiv):
        return arxiv
    parts = value.split(':')
    if len(parts) != 5 or parts[0] != 'conference' or not re.fullmatch(r'[A-Za-z0-9:._-]+', value):
        return None
    try:
        from paper_identity import canonical_conference_paper_id
        canonical = canonical_conference_paper_id(
            {'id': f'{parts[1]}-{parts[2]}', 'year': int(parts[2])},
            {'type': parts[3], 'value': parts[4]})
        return value if canonical == value else None
    except (ValueError, TypeError):
        return None


def normalize_llm_usage(protocol, body):
    usage = body.get('usage') if isinstance(body, dict) else None
    usage = usage if isinstance(usage, dict) else {}
    chat = protocol in {'openai', 'openai_chat'}
    input_details = usage.get('prompt_tokens_details' if chat else 'input_tokens_details') or {}
    output_details = usage.get('completion_tokens_details' if chat else 'output_tokens_details') or {}
    input_details = input_details if isinstance(input_details, dict) else {}
    output_details = output_details if isinstance(output_details, dict) else {}
    values = {
        'inputTokens': _count(usage.get('prompt_tokens' if chat else 'input_tokens')),
        'outputTokens': _count(usage.get('completion_tokens' if chat else 'output_tokens')),
        'totalTokens': _count(usage.get('total_tokens')),
        'cachedInputTokens': _count(input_details.get('cached_tokens', usage.get('cache_read_input_tokens'))),
        'cacheCreationInputTokens': _count(usage.get('cache_creation_input_tokens')),
        'reasoningTokens': _count(output_details.get('reasoning_tokens')),
    }
    return {'status': 'reported' if any(value is not None for value in values.values()) else 'unavailable',
            'inputSemantics': 'provider_reported', **values}


@contextmanager
def with_llm_usage_context(context):
    token = _SCOPE.set({**_SCOPE.get(), **(context or {})})
    try:
        yield
    finally:
        _SCOPE.reset(token)


def build_llm_usage_event(*, protocol, model, request, response=None, status_code=None,
                          duration_ms=0, error_code=None, output_text=None, context=None,
                          event_id=None, at=None, transport_started=None):
    context = {**_SCOPE.get(), **(context or {})}
    body = response if isinstance(response, dict) else {}
    messages = request.get('input', request.get('messages', []))
    text_chars = len(messages) if isinstance(messages, str) else 0
    images = 0
    for message in messages if isinstance(messages, list) else []:
        content = message.get('content') if isinstance(message, dict) else None
        if isinstance(content, str):
            text_chars += len(content)
        elif isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get('type') in {'text', 'input_text'}:
                    text_chars += len(str(block.get('text') or ''))
                elif block.get('type') in {'image', 'image_url', 'input_image'}:
                    images += 1
    choices = body.get('choices') if isinstance(body.get('choices'), list) else []
    incomplete = body.get('status') == 'incomplete' or body.get('stop_reason') == 'max_tokens' \
        or any(isinstance(choice, dict) and choice.get('finish_reason') == 'length'
               for choice in choices)
    response_status = body.get('status') if protocol == 'openai_responses' else None
    chat_terminal_failed = protocol in {'openai', 'openai_chat'} and any(
        isinstance(choice, dict) and 'finish_reason' in choice
        and choice.get('finish_reason') not in ('stop', 'length') for choice in choices)
    anthropic_terminal_failed = protocol == 'anthropic' and 'stop_reason' in body \
        and body.get('stop_reason') not in ('end_turn', 'stop_sequence', 'max_tokens')
    if transport_started is False:
        outcome = 'blocked_before_transport'
    elif error_code:
        outcome = 'transport_error'
    elif not isinstance(status_code, int) or not 200 <= status_code < 300:
        outcome = 'http_error'
    elif protocol == 'openai_responses' and 'status' in body and response_status not in ('completed', 'incomplete'):
        outcome = 'provider_error'
    elif chat_terminal_failed or anthropic_terminal_failed:
        outcome = 'provider_error'
    elif incomplete:
        outcome = 'incomplete'
    else:
        outcome = 'completed'
    paper_id = context.get('paperId')
    return {
        'version': VERSION, 'kind': 'request', 'eventId': event_id or str(uuid.uuid4()),
        'at': at or _now(), 'runtime': 'python',
        'runId': context.get('runId') if re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', str(context.get('runId') or '')) else None,
        'paperId': normalize_usage_paper_id(paper_id),
        'stage': _label(context.get('stage')) or 'unknown',
        'unitId': context.get('unitId') if re.fullmatch(r'[a-f0-9]{64}', str(context.get('unitId') or '')) else None,
        'contentAttempt': _count(context.get('contentAttempt')), 'transportAttempt': _count(context.get('transportAttempt')),
        'protocol': _label(protocol), 'model': _label(model), 'outcome': outcome,
        'statusCode': _count(status_code), 'errorCode': _label(error_code), 'durationMs': _count(round(duration_ms)),
        'inputSha256': _digest(json.dumps(request, ensure_ascii=False, separators=(',', ':'))),
        'outputTextSha256': _digest(output_text) if isinstance(output_text, str) else None,
        'estimates': {'textCharacters': text_chars, 'estimatedInputTextTokens': (text_chars + 2) // 3, 'images': images},
        'usage': normalize_llm_usage(protocol, response),
        **({'transportStarted': transport_started} if isinstance(transport_started, bool) else {}),
    }


def write_llm_usage_event(event, directory=None):
    """用新的随机 UUID 命名用量文件，先写临时文件，再改名保存。

    本函数有自己的目录和文件检查，不能直接改用公共的文件替换函数：
    - 逐级检查父目录，拒绝符号链接或非目录；新建目录指定 0700，
      最终用量目录再设为 0700，不更改已有上级目录的权限。
    - 每次生成新的 uuid4 文件名，不用于改写某个指定的已有用量文件。
    - 临时文件以 O_EXCL|O_NOFOLLOW 创建，写完并同步文件后再改名。
    """
    target_dir = Path(directory or LLM_USAGE_DIR).absolute()
    current = Path(target_dir.anchor)
    for part in target_dir.parts[1:]:
        current /= part
        try:
            current.mkdir(mode=0o700)
        except FileExistsError:
            pass
        mode = current.lstat().st_mode
        if not stat.S_ISDIR(mode) or stat.S_ISLNK(mode):
            raise ValueError('用量目录必须是真实目录，不能是符号链接')
    target_dir.chmod(0o700)
    ident = str(uuid.uuid4())
    temporary = target_dir / f'.{ident}.tmp'
    target = target_dir / f'{ident}.json'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        json.dump(event, handle, ensure_ascii=False)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)
    directory_fd = os.open(target_dir, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    saved_stat = target.lstat()
    if not stat.S_ISREG(saved_stat.st_mode) or saved_stat.st_nlink != 1 \
            or stat.S_IMODE(saved_stat.st_mode) != 0o600:
        raise OSError('用量文件保存后的类型、链接或权限不符合要求')
    return target


def preserve_response_recovery(event, response, *, directory=None):
    """Keep actual returned bytes separately from the metadata-only fee ledger."""
    target_dir = Path(directory) / 'response-recovery' if directory else LLM_RESPONSE_RECOVERY_DIR
    saved_response = response
    body = {'contract': 'llm-response-recovery-v1', 'event': event,
            'eventSha256': _digest(json.dumps(event, ensure_ascii=False, separators=(',', ':'))),
            'response': saved_response,
            'responseSha256': _digest(json.dumps(saved_response, ensure_ascii=False, separators=(',', ':')))}
    # The writer applies the same private directories, exclusive atomic file and
    # fsync discipline. Capture its actual filename for controlled recovery.
    filename = write_llm_usage_event(body, target_dir)
    named = Path(filename).lstat()
    fd = os.open(filename, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(fd, 'rb') as handle:
        before = os.fstat(handle.fileno())
        raw = handle.read()
        after = os.fstat(handle.fileno())
    final = Path(filename).lstat()
    fields = ('st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
    if any(not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or stat.S_IMODE(value.st_mode) != 0o600
           or any(getattr(value, field) != getattr(named, field) for field in fields)
           for value in (before, after, final)) or raw != (json.dumps(body, ensure_ascii=False) + '\n').encode():
        raise OSError('响应恢复文件回读字节或身份不一致')
    return {'filename': str(filename), 'sha256': hashlib.sha256(raw).hexdigest(),
            'responseSha256': body['responseSha256'], 'eventId': event.get('eventId') if event else None}


def persistence_error(cause, event, response=None, *, directory=None):
    error = LlmUsagePersistenceError('模型费用记录保存失败，已停止新请求；保留原费用和实际响应后受控恢复')
    error.__cause__ = cause
    error.event_id = event.get('eventId') if event else None
    # Python exception string/repr does not display these response attributes.
    error.llm_response = response
    error.usage_event = event
    try:
        error.response_recovery = preserve_response_recovery(event, response, directory=directory)
    except Exception as recovery_error:
        error.response_recovery_failed = True
        error.response_recovery_error = recovery_error
    return error


def begin_pending_llm_request(*, directory=None, **kwargs):
    shape = build_llm_usage_event(**kwargs)
    labels = ('runId', 'paperId', 'stage', 'unitId', 'contentAttempt', 'transportAttempt',
              'protocol', 'model', 'inputSha256', 'estimates')
    event = {'version': VERSION, 'kind': 'request_started', 'eventId': shape['eventId'],
             'at': shape['at'], 'runtime': 'python', **{key: shape[key] for key in labels},
             'phase': 'authorized_before_transport', 'outcome': 'result_unknown', 'chargeState': 'unknown'}
    try:
        if directory is not None or not _running_unittest():
            write_llm_usage_event(event, directory)
    except Exception as cause:
        error = LlmUsagePersistenceError('模型请求发送前的持久记录无法保存，尚未调用传输层')
        error.code = 'LLM_REQUEST_START_NOT_PERSISTED'
        raise error from cause
    return event


def record_llm_usage(*, sink=None, directory=None, **kwargs):
    event = None
    raw_response = kwargs.pop('raw_response', None)
    raw_truncated = kwargs.pop('raw_response_truncated', False)
    try:
        event = build_llm_usage_event(**kwargs)
        if sink is not None:
            sink(event)
        elif directory is not None or not _running_unittest():
            write_llm_usage_event(event, directory)
        else:
            event['recordingStatus'] = 'skipped_test_runner_without_explicit_sink'
        return event
    except Exception as cause:
        raw_fields = {}
        if isinstance(raw_response, bytes):
            raw_fields = {'rawBytes': len(raw_response), 'rawSha256': hashlib.sha256(raw_response).hexdigest()}
            try:
                raw_fields['raw'] = raw_response.decode('utf-8')
            except UnicodeError:
                raw_fields['rawBase64'] = base64.b64encode(raw_response).decode('ascii')
        elif isinstance(raw_response, str):
            raw_fields = {'raw': raw_response}
        if raw_fields and raw_truncated:
            raw_fields['rawTruncated'] = True
        response = None if kwargs.get('response') is None and not raw_fields else {
            'statusCode': kwargs.get('status_code'), 'body': kwargs.get('response'), **raw_fields}
        raise persistence_error(cause, event, response, directory=directory) from cause


def _running_unittest():
    """识别 unittest 命令，或已加载 unittest 且直接运行的 test_ 文件。"""
    main = sys.modules.get('__main__')
    spec = getattr(main, '__spec__', None)
    if getattr(spec, 'name', None) == 'unittest.__main__':
        return True
    filename = Path(getattr(main, '__file__', '') or '').name
    return spec is None and filename.startswith('test_') and 'unittest' in sys.modules
