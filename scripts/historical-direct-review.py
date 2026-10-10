#!/usr/bin/env python3
"""检查单批历史页面的正文及图片，保留进度以便失败后继续。"""

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

from blog_entry_loader import load_publish_to_blog
from runtime_guard import require_external_runtime

CONTRACT = 'historical-direct-semantic-review-v1'
CHECKPOINT_CONTRACT = 'historical-direct-semantic-review-checkpoint-v1'
SHA_RE = re.compile(r'^[a-f0-9]{64}$')


def stable(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode()).hexdigest()


def read_json(path):
    value = json.loads(Path(path).read_text(encoding='utf-8'))
    if not isinstance(value, dict):
        raise ValueError(f'JSON 文件的顶层必须是对象： {path}')
    return value


def atomic_json(path, value, *, dir_mode=0o700):
    """原子写检查点 JSON：临时文件 + fsync + 改名。

    dir_mode 默认 0700，仅用于新建的直接父目录，并受 umask 限制；
    缺失的更高层父目录使用默认创建权限，已有目录不改权限。
    这里保留专用保存函数：检查点文件固定为 0600，临时文件须独占创建，
    不直接沿用 path_config.atomic_write_json 的文件权限处理。
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True, mode=dir_mode)
    raw = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()
    temporary = target.with_name(f'.{target.name}.{os.getpid()}.tmp')
    with temporary.open('xb') as handle:
        os.chmod(temporary, 0o600)
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)


def blocking(issues):
    return any(str(item.get('severity', '')).lower() == 'error'
               for item in issues if isinstance(item, dict))


def checkpoint_path(root, page_key, unit, index, input_sha=None):
    material = f'{page_key}\0{unit}\0{index}'
    if input_sha is not None:
        material += f'\0{input_sha}'
    identity = hashlib.sha256(material.encode()).hexdigest()
    return Path(root) / f'{identity}.json'


def checkpoint(root, identity, unit, index, input_sha, protocol, runner):
    target = checkpoint_path(root, identity, unit, index, input_sha)
    legacy = checkpoint_path(root, identity, unit, index)
    for candidate in (target, legacy):
        if not candidate.is_file():
            continue
        value = read_json(candidate)
        body = dict(value)
        declared = body.pop('checkpointSha256', None)
        if (value.get('contract') != CHECKPOINT_CONTRACT or value.get('version') != 1
                or value.get('identity') != identity or value.get('unit') != unit
                or value.get('index') != index
                or not isinstance(value.get('inputSha256'), str)
                or not isinstance(value.get('protocol'), dict)
                or declared != stable(body)):
            raise ValueError(f'正文或图片审查检查点的格式、身份或 SHA 不符： {candidate}')
        if (value.get('inputSha256') == input_sha
                and value['result'].get('passed') is True):
            if candidate == legacy and not target.exists():
                atomic_json(target, value)
            return value['result']
        if value.get('inputSha256') == input_sha:
            raise ValueError('正式审查检查点只能保存通过结果')
    attempt_prefix = f'{target.stem}.attempt-'
    # 失败的尝试只留作审计，不当作永久的否定缓存。
    # 每次调用最多做一次审查请求（传输层自带有限重试），
    # 后面再跑还能从故障里恢复。
    # 编号接在已有序号后面，读不懂的审计文件也算数，
    # 以前留下的证据不删不盖。
    attempt_numbers = []
    for candidate in target.parent.glob(f'{attempt_prefix}*.json') if target.parent.exists() else []:
        match = re.fullmatch(re.escape(attempt_prefix) + r'(\d+)\.json', candidate.name)
        if match:
            attempt_numbers.append(int(match.group(1)))
    run_error = None
    try:
        result = runner()
    except Exception as exc:
        if getattr(exc, 'scope', None) == 'run':
            run_error = exc
        result = {'passed': False, 'issues': [{
            'severity': 'error', 'type': 'infrastructure',
            'description': f'页面审查执行失败： {type(exc).__name__}: {str(exc)[:500]}'
        }]}
    issues = result.get('issues') if isinstance(result, dict) else None
    if not isinstance(issues, list) or not isinstance(result.get('passed'), bool):
        result = {'passed': False, 'issues': [{
            'severity': 'error', 'type': 'protocol',
            'description': '页面审查结果缺少有效的 issues 列表或 passed 布尔值'
        }]}
    if blocking(result['issues']):
        result['passed'] = False
    if result['passed'] is False and not blocking(result['issues']):
        result['issues'].append({'severity': 'error', 'type': 'protocol',
                                 'description': '页面审查未通过，但结果没有列出阻断问题'})
    body = {'contract': CHECKPOINT_CONTRACT, 'version': 1, 'identity': identity,
            'unit': unit, 'index': index, 'inputSha256': input_sha,
            'protocol': protocol, 'result': result}
    checkpoint_record = {**body, 'checkpointSha256': stable(body)}
    if result['passed'] is True:
        atomic_json(target, checkpoint_record)
    else:
        attempt_path = target.with_name(f'{attempt_prefix}{max(attempt_numbers, default=0) + 1:03d}.json')
        if attempt_path.exists():
            if read_json(attempt_path) != checkpoint_record:
                raise ValueError('已有同序号失败记录与本次失败记录不同')
        else:
            atomic_json(attempt_path, checkpoint_record)
    if run_error is not None:
        raise run_error
    return result


def review_page(module, page, staged_repo, checkpoint_root, protocol):
    relative = page['path']
    target = (staged_repo / relative).resolve()
    if not str(target).startswith(str(staged_repo) + os.sep):
        raise ValueError('待审页面路径超出临时博客目录')
    raw = target.read_bytes()
    actual_sha = hashlib.sha256(raw).hexdigest()
    if actual_sha != page['sha256']:
        raise ValueError(f'待审页面 SHA 与请求记录不同： {relative}')
    page_checkpoint = checkpoint_path(checkpoint_root, relative, 'page', 0, actual_sha)
    legacy_page_checkpoint = checkpoint_path(checkpoint_root, relative, 'page', 0)
    for candidate in (page_checkpoint, legacy_page_checkpoint):
        if not candidate.is_file():
            continue
        value = read_json(candidate)
        body = dict(value)
        declared = body.pop('checkpointSha256', None)
        if (value.get('contract') != CHECKPOINT_CONTRACT or value.get('unit') != 'page'
                or value.get('identity') != relative
                or not isinstance(value.get('inputSha256'), str)
                or not isinstance(value.get('protocol'), dict)
                or declared != stable(body)):
            raise ValueError(f'页面审查检查点的格式、身份或 SHA 不符： {candidate}')
        if (value.get('inputSha256') == actual_sha
                and value.get('result', {}).get('passed') is True):
            if candidate == legacy_page_checkpoint and not page_checkpoint.exists():
                atomic_json(page_checkpoint, value)
            return value['result']
    content = raw.decode('utf-8')
    title_match = re.search(r'^title:\s*["\']?(.*?)["\']?\s*$', content, re.MULTILINE)
    title = title_match.group(1) if title_match else relative
    chunks = module.split_review_content(content, module.get_blog_review_chunk_chars())
    chunk_results = []
    for index, chunk in enumerate(chunks):
        chunk_sha = hashlib.sha256(chunk.encode()).hexdigest()
        result = checkpoint(checkpoint_root, relative, 'text', index, chunk_sha, protocol,
            lambda chunk=chunk, index=index: dict(zip(('passed', 'issues'),
                module._llm_review_post_chunk(chunk, title, required=True,
                                              chunk_label=f'{index + 1}/{len(chunks)}')[:2])))
        chunk_results.append(result)
    image_matches = module.parse_markdown_images(content)
    # 审查器拿到的是全文，不只是图片链接。周围说法变了，
    # 就不能沿用对旧解释的结论。
    image_input_sha = stable({'pageSha256': actual_sha,
                             'images': [{'alt': item['alt'], 'url': item['url']}
                                        for item in image_matches]})
    if image_matches:
        image_result = checkpoint(checkpoint_root, relative, 'images', 0, image_input_sha, protocol,
            lambda: dict(zip(('passed', 'issues'),
                             module.multimodal_review_images(content, title, required=True))))
    else:
        image_result = {'passed': True, 'issues': []}
    issues = [issue for result in [*chunk_results, image_result]
              for issue in result.get('issues', [])]
    result = {'path': relative, 'sha256': actual_sha, 'textChunks': len(chunks),
              'imageCount': len(image_matches), 'imageReviewMode':
              ('multimodal' if image_matches else 'not-required'),
              'passed': not blocking(issues) and all(item['passed'] for item in chunk_results)
                        and image_result['passed'], 'issues': issues}
    result['resultSha256'] = stable(result)
    if result['passed']:
        body = {'contract': CHECKPOINT_CONTRACT, 'version': 1, 'identity': relative,
                'unit': 'page', 'index': 0, 'inputSha256': actual_sha,
                'protocol': protocol, 'result': result}
        atomic_json(page_checkpoint, {**body, 'checkpointSha256': stable(body)})
    return result


def validate_semantic_protocol(value):
    expected = {'contract', 'version', 'model', 'secondaryModel', 'endpointSha256',
                'implementationSha256', 'promptSha256', 'textReview', 'imageReview',
                'budgets', 'protocolSha256'}
    budget_fields = {'chunkChars', 'maxTokens', 'timeoutSeconds', 'maxRetries',
                     'temperature', 'imageMaxBytes', 'pageConcurrency'}
    if (not isinstance(value, dict) or set(value) != expected
            or value.get('contract') != 'historical-direct-semantic-review-protocol-v1'
            or value.get('version') != 1 or not isinstance(value.get('model'), str)
            or not isinstance(value.get('secondaryModel'), str)
            or any(not SHA_RE.fullmatch(str(value.get(field, ''))) for field in
                   ('endpointSha256', 'implementationSha256', 'promptSha256'))
            or not isinstance(value.get('budgets'), dict)
            or set(value['budgets']) != budget_fields):
        raise ValueError('页面内容审查规则的格式、版本、模型或预算字段无效')
    body = dict(value)
    declared = body.pop('protocolSha256')
    if declared != stable(body):
        raise ValueError('页面内容审查规则的自校验 SHA 不符')
    budgets = value['budgets']
    if (not 4000 <= budgets['chunkChars'] <= 16000
            or not 1000 <= budgets['maxTokens'] <= 16000
            or budgets['timeoutSeconds'] != 120 or budgets['maxRetries'] != 5
            or budgets['temperature'] != 0.1 or budgets['imageMaxBytes'] != 8 * 1024 * 1024
            or not 1 <= budgets['pageConcurrency'] <= 5):
        raise ValueError('页面内容审查的分块长度、输出预算、超时、重试、温度、图片大小或并发设置无效')
    return value


def review_pages_bounded(module, pages, staged, checkpoints, protocol, concurrency):
    """别把整个历史一次排完，先让服务故障有机会暴露。"""
    results = []
    remaining = iter(pages)
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        def submit_next():
            page = next(remaining, None)
            if page is None:
                return None
            return executor.submit(review_page, module, page, staged, checkpoints, protocol)

        pending = {future for _ in range(min(concurrency, len(pages)))
                   if (future := submit_next()) is not None}
        while pending:
            done, pending = concurrent.futures.wait(pending,
                return_when=concurrent.futures.FIRST_COMPLETED)
            # 先看完所有已出结果再补新任务。遇到致命错误，
            # 执行器关闭时只等已经开工的页面。
            completed = [future.result() for future in done]
            for result in completed:
                results.append(result)
                print(json.dumps({
                    'contract': 'historical-direct-semantic-review-progress-v1',
                    'completed': len(results), 'total': len(pages),
                    'path': result['path'],
                    'outcome': 'passed' if result['passed'] else 'blocked',
                }, ensure_ascii=False, separators=(',', ':')), file=sys.stderr, flush=True)
            for _ in done:
                future = submit_next()
                if future is not None:
                    pending.add(future)
    return results


def run(request_path, output_path, checkpoint_root, concurrency):
    request = read_json(request_path)
    expected = {'contract', 'version', 'publicationId', 'generationSha256',
                'reviewProtocolFingerprint', 'semanticProtocol', 'blogRepo',
                'bundleRoot', 'files', 'fileSetSha256'}
    if (set(request) != expected or request['contract'] != 'historical-direct-semantic-review-request-v1'
            or request['version'] != 1 or not SHA_RE.fullmatch(request['generationSha256'])
            or not SHA_RE.fullmatch(request['reviewProtocolFingerprint'])
            or stable(request['files']) != request['fileSetSha256']):
        raise ValueError('页面内容审查请求的字段、格式、版本或 SHA 无效')
    validate_semantic_protocol(request['semanticProtocol'])
    if request['semanticProtocol']['budgets']['pageConcurrency'] != concurrency:
        raise ValueError('页面审查并发数与请求中已绑定的规则不同')
    blog_repo = Path(request['blogRepo']).resolve(strict=True)
    bundle_root = Path(request['bundleRoot']).resolve(strict=True)
    output = Path(output_path).resolve()
    checkpoints = Path(checkpoint_root).resolve()
    transaction_root = Path(request_path).resolve().parent
    if not str(output).startswith(str(transaction_root) + os.sep) \
            or not str(checkpoints).startswith(str(transaction_root) + os.sep):
        raise ValueError('审查结果或检查点目录超出本次发布目录')
    pages = [item for item in request['files'] if item['path'].endswith('.md')]
    with tempfile.TemporaryDirectory(prefix='historical-direct-semantic-review-') as temporary:
        staged = Path(temporary) / 'site'
        shutil.copytree(blog_repo, staged, ignore=shutil.ignore_patterns('.git', 'public', 'resources'))
        staged = staged.resolve(strict=True)
        for item in request['files']:
            source = (bundle_root / item['path']).resolve(strict=True)
            if not str(source).startswith(str(bundle_root) + os.sep):
                raise ValueError('待审文件路径超出本次页面生成目录')
            raw = source.read_bytes()
            if hashlib.sha256(raw).hexdigest() != item['sha256']:
                raise ValueError(f'待审文件 SHA 与请求记录不同： {item["path"]}')
            target = staged / item['path']
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
        module = load_publish_to_blog()
        module.BLOG_REPO = str(staged)
        module.CONTENT_DIR = str(staged / 'content' / 'posts')
        results = review_pages_bounded(module, pages, staged, checkpoints,
                                       request['semanticProtocol'], concurrency)
    results.sort(key=lambda item: item['path'])
    body = {'contract': CONTRACT, 'version': 1, 'publicationId': request['publicationId'],
            'generationSha256': request['generationSha256'],
            'reviewProtocolFingerprint': request['reviewProtocolFingerprint'],
            'semanticProtocol': request['semanticProtocol'], 'results': results,
            'resultSetSha256': stable(results), 'passed': bool(results)
            and all(item['passed'] for item in results)}
    receipt = {**body, 'semanticReviewSha256': stable(body)}
    if receipt['passed']:
        if output.exists():
            if read_json(output) != receipt:
                atomic_json(output, receipt)
        else:
            atomic_json(output, receipt)
    return receipt


def main(argv=None):
    require_external_runtime('historical-direct-review.py')
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--request', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--checkpoint-dir', required=True)
    parser.add_argument('--concurrency', required=True, type=int)
    args = parser.parse_args(argv)
    if not 1 <= args.concurrency <= 5:
        parser.error('--concurrency 必须为 1 到 5')
    result = run(args.request, args.output, args.checkpoint_dir, args.concurrency)
    print(json.dumps({'status': 'passed' if result['passed'] else 'blocked',
                      'semanticReviewSha256': result['semanticReviewSha256'],
                      'pages': len(result['results'])}, ensure_ascii=False))
    if not result['passed']:
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
