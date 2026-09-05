"""Metadata-only LLM usage events, interoperable with lib/llm-usage.js."""
if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('llm_usage.py')

import contextvars
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
from path_config import LLM_USAGE_DIR

VERSION = 'llm-usage-v1'
_SCOPE = contextvars.ContextVar('paper_digest_llm_usage', default={})
_WARNED = False


def _count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 9007199254740991 else None


def _label(value):
    return value if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.:/-]{1,200}', value) else None


def _digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


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
                          duration_ms=0, error_code=None, output_text=None, context=None):
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
    outcome = 'transport_error' if error_code else 'incomplete' if incomplete else \
        'completed' if isinstance(status_code, int) and 200 <= status_code < 300 else 'http_error'
    paper_id = context.get('paperId')
    return {
        'version': VERSION, 'kind': 'request', 'eventId': str(uuid.uuid4()),
        'at': datetime.now(timezone.utc).isoformat(), 'runtime': 'python',
        'runId': context.get('runId') if re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', str(context.get('runId') or '')) else None,
        'paperId': paper_id if isinstance(paper_id, str) and re.fullmatch(r'\d{4}\.\d{4,5}(?:v\d+)?', paper_id) else None,
        'stage': _label(context.get('stage')) or 'unknown',
        'unitId': context.get('unitId') if re.fullmatch(r'[a-f0-9]{64}', str(context.get('unitId') or '')) else None,
        'contentAttempt': _count(context.get('contentAttempt')), 'transportAttempt': _count(context.get('transportAttempt')),
        'protocol': _label(protocol), 'model': _label(model), 'outcome': outcome,
        'statusCode': _count(status_code), 'errorCode': _label(error_code), 'durationMs': _count(round(duration_ms)),
        'inputSha256': _digest(json.dumps(request, ensure_ascii=False, separators=(',', ':'))),
        'outputTextSha256': _digest(output_text) if isinstance(output_text, str) else None,
        'estimates': {'textCharacters': text_chars, 'estimatedInputTextTokens': (text_chars + 2) // 3, 'images': images},
        'usage': normalize_llm_usage(protocol, response),
    }


def write_llm_usage_event(event, directory=None):
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
            raise ValueError('Unsafe usage directory')
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


def record_llm_usage(*, sink=None, directory=None, **kwargs):
    global _WARNED
    try:
        event = build_llm_usage_event(**kwargs)
        if sink is not None:
            sink(event)
        elif directory is not None or not _running_unittest():
            write_llm_usage_event(event, directory)
        else:
            event['recordingStatus'] = 'skipped_test_runner_without_explicit_sink'
        return event
    except Exception:
        if not _WARNED:
            print('[llm-usage] 用量元数据未能记录；不改变模型请求结果')
            _WARNED = True
        return None


def _running_unittest():
    """Importing unittest.mock in a real research script is not a test run."""
    main = sys.modules.get('__main__')
    spec = getattr(main, '__spec__', None)
    if getattr(spec, 'name', None) == 'unittest.__main__':
        return True
    filename = Path(getattr(main, '__file__', '') or '').name
    return spec is None and filename.startswith('test_') and 'unittest' in sys.modules
