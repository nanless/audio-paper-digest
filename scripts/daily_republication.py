"""显式退休已发布日批的活动发布凭证，保留原字节并恢复正常生成/审查。

只从持有共享博客锁和日期锁的 generate 入口调用；不修改论文、费用或博客。
"""
import datetime
import json
from pathlib import Path
import re
import uuid

from path_config import DAILY_REPUBLICATION_RUNS_DIR, DAILY_REPUBLICATION_MARKER_DIRNAME
from publication_activation import child, encoded, read, safe_dir, sha, sync_dir, write

CONTRACT = 'daily-published-batch-republication-v1'
SHA = re.compile(r'^[a-f0-9]{64}$')
OID = re.compile(r'^[a-f0-9]{40}(?:[a-f0-9]{24})?$')
CATALOG_MAINTENANCE_PATHS = frozenset(
    f'{prefix}/tag-catalog-{name}.json'
    for prefix in ('data', 'static/data') for name in ('snapshot', 'versions'))


def validate_id(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('--republish 需要规范小写 UUID')
    return value


def marker_path(current, date):
    datetime.date.fromisoformat(date)
    return Path(current) / DAILY_REPUBLICATION_MARKER_DIRNAME / f'{date}.json'


def load_json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('日更重新发布凭证存在重复 JSON 字段')
            result[key] = value
        return result
    return json.loads(read(path), object_pairs_hook=unique)


def transaction(runs_root, run_id):
    return Path(runs_root or DAILY_REPUBLICATION_RUNS_DIR) / validate_id(run_id)


def validate_intent(intent, run_id, date):
    if not isinstance(intent, dict) or intent.get('contract') != CONTRACT \
            or intent.get('runId') != run_id or intent.get('date') != date \
            or not isinstance(intent.get('files'), list) or not intent['files']:
        raise ValueError('日更重新发布意图身份或文件清单无效')
    expected_retired = {f'blog-{kind}-{date}.json' for kind in (
        'generation-manifest', 'review-receipt', 'review-failure', 'generation-journal')}
    seen = set()
    for record in intent['files']:
        name = record.get('path')
        if not isinstance(name, str) or name in seen or set(record) != {'path', 'sha256', 'remove'} \
                or not SHA.fullmatch(str(record['sha256'])) or type(record['remove']) is not bool:
            raise ValueError('日更重新发布归档清单重复或不完整')
        child(Path('.'), name)
        retained = name == f'blog-review-passes-{date}.json' \
            or name.startswith(f'blog-review-checkpoints/{date}/')
        if (record['remove'] and name not in expected_retired) or (not record['remove'] and not retained):
            raise ValueError('日更重新发布意图包含越界状态路径')
        seen.add(name)
    if not {f'blog-generation-manifest-{date}.json', f'blog-review-receipt-{date}.json'} <= seen:
        raise ValueError('日更重新发布缺少原生成清单或审查凭证')
    for key in ('canonicalSha256', 'newInputFingerprint', 'newTemplateFingerprint', 'remoteIdentitySha256'):
        if not SHA.fullmatch(str(intent.get(key) or '')):
            raise ValueError('日更重新发布意图缺少有效内容身份')
    if not OID.fullmatch(str(intent.get('blogHead') or '')):
        raise ValueError('日更重新发布缺少博客提交身份')
    controlled = intent.get('controlledFiles')
    if not isinstance(controlled, list) or not controlled \
            or len({item.get('path') for item in controlled}) != len(controlled):
        raise ValueError('日更重新发布缺少原已验文件的 CAS 集合')
    for item in controlled:
        child(Path('.'), item['path'])
        if set(item) != {'path', 'sha256'} or (item['sha256'] is not None and not SHA.fullmatch(str(item['sha256']))):
            raise ValueError('日更重新发布已验文件 CAS 无效')
    return intent


def completion_for(intent):
    return {'contract': CONTRACT, 'runId': intent['runId'], 'date': intent['date'],
            'status': 'activated', 'intentSha256': sha(encoded(intent))}


def verify_completed(current, directory, intent):
    validate_intent(intent, directory.name, intent['date'])
    completion = completion_for(intent)
    if read(directory / 'intent.json') != encoded(intent) \
            or load_json(directory / 'completion.json') != completion:
        raise ValueError('日更重新发布完成凭证与原意图不一致')
    for record in intent['files']:
        if sha(read(child(directory / 'archive', record['path']))) != record['sha256']:
            raise ValueError('日更重新发布原凭证归档已变化')
    return completion


def assert_no_pending(current, date, *, allow_run_id=None, runs_root=None):
    marker = marker_path(current, date)
    if not marker.exists() and not marker.is_symlink():
        return
    try:
        value = load_json(marker)
        run_id = validate_id(value.get('runId'))
        directory = safe_dir(transaction(runs_root, run_id))
        intent = validate_intent(load_json(directory / 'intent.json'), run_id, date)
        completion = completion_for(intent)
        if value == {**completion, 'status': 'pending'}:
            if allow_run_id == run_id:
                return
            raise ValueError('请用相同 --republish UUID 恢复')
        if value != completion:
            raise ValueError('日期记录与不可变意图不一致')
        verify_completed(current, directory, intent)
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise ValueError('日更重新发布尚未完成或凭证损坏；普通生成、审查和推送已阻断') from error


def _status_files(current, date):
    records = []
    for kind in ('generation-manifest', 'review-receipt', 'review-failure', 'generation-journal', 'review-passes'):
        name = f'blog-{kind}-{date}.json'
        target = current / name
        if target.exists() or target.is_symlink():
            records.append({'path': name, 'sha256': sha(read(target)), 'remove': kind != 'review-passes'})
    stage = current / f'blog-generation-stage-{date}'
    if stage.exists() or stage.is_symlink():
        raise ValueError('已发布批次仍有生成暂存目录，须先核验并恢复原事务')
    checkpoints = current / 'blog-review-checkpoints' / date
    if checkpoints.exists() or checkpoints.is_symlink():
        safe_dir(checkpoints)
        for item in sorted(checkpoints.rglob('*')):
            if item.is_symlink():
                raise ValueError('审查检查点不能包含符号链接')
            if item.is_dir():
                continue
            records.append({'path': item.relative_to(current).as_posix(), 'sha256': sha(read(item)), 'remove': False})
    return sorted(records, key=lambda item: item['path'])


def _git(module, args, *, text=False):
    result = module._run_git(args, text=text)
    if result.returncode != 0:
        raise ValueError('日更重新发布 Git 证明失败：' + args[0])
    return result.stdout.strip() if text else result.stdout


def _blob(module, commit, relative):
    result = module._run_git(['show', f'{commit}:{relative}'])
    return result.stdout if result.returncode == 0 else None


def verify_authority(module, date, manifest_raw, receipt_raw, canonical_sha, *, expected_head=None):
    """当前已签来源与原发布证明分别重放，维护提交不能替换原页面或图片。"""
    manifest, receipt = json.loads(manifest_raw), json.loads(receipt_raw)
    current = Path(module.CURRENT_DIR); repo = Path(module.BLOG_REPO).resolve()
    formal_path = current / 'deep-analysis-result.json'
    if sha(read(formal_path)) != canonical_sha:
        raise ValueError('正式分析发生变化，不能作为同批次重新呈现')
    formal = json.loads(read(formal_path))
    if not isinstance(formal.get('dailyFreshSourceRun'), dict) \
            or formal['dailyFreshSourceRun'].get('contract') != 'daily-fresh-source-reference-v1':
        raise ValueError('重新发布必须使用当前完整日更封存来源')
    for value in (manifest, receipt):
        if value.get('schemaVersion') != 3 or value.get('date') != date or value.get('publicationScope'):
            raise ValueError('日更重新发布仅支持完整已发布 schema3 日批')
    commit = receipt.get('publicationCommit')
    if not OID.fullmatch(str(commit or '')) or receipt.get('remoteVerifiedOid') != commit \
            or receipt.get('strictReview') is not True or receipt.get('hugoGate') != 'hugo' \
            or receipt.get('generationManifestSha256') != sha(manifest_raw) \
            or receipt.get('baseHead') != manifest.get('baseHead') \
            or not SHA.fullmatch(str(receipt.get('reviewProtocolFingerprint') or '')) \
            or receipt.get('remoteName') != module.GITHUB_REMOTE or not receipt.get('remoteVerifiedAt'):
        raise ValueError('原发布凭证、审查或生成清单身份不一致')
    if receipt.get('generationInputIntegrity') != module.PUBLISHED_PAPERS_FINGERPRINT_CONTRACT:
        raise ValueError('原审查凭证缺少完整输入核验规则')
    bindings = {'generationInputFingerprint': 'inputFingerprint',
                'publishedPapersFingerprint': 'publishedPapersFingerprint',
                'generationInputSourceReference': 'inputSourceReference',
                'publicationMode': 'publicationMode',
                'llmApiProductionFingerprint': 'llmApiProductionFingerprint',
                'manualV6ProductionFingerprint': 'manualV6ProductionFingerprint'}
    if any(receipt.get(key) != manifest.get(source) for key, source in bindings.items()):
        raise ValueError('原审查凭证与生成输入、论文快照或发布证明不一致')
    try:
        verified_at = receipt['remoteVerifiedAt']
        if not isinstance(verified_at, str) or not re.fullmatch(
                r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+08:00', verified_at) \
                or datetime.datetime.fromisoformat(verified_at).utcoffset() != datetime.timedelta(hours=8):
            raise ValueError('远端验证时间格式非法')
    except (TypeError, ValueError) as error:
        raise ValueError('原审查凭证远端验证时间非法') from error
    reference = manifest.get('inputSourceReference')
    current_reference = module.build_generation_input_source_reference(str(formal_path))
    if reference != current_reference:
        raise ValueError('原发布输入不是当前完整正式分析字节')
    module.validate_daily_fresh_sources_for_publish(str(formal_path), date)
    module._validate_generation_input_integrity(manifest, date)
    head = module.validate_git_publish_branch()
    if expected_head is not None and head != expected_head:
        raise ValueError('重新发布归档期间博客 HEAD 变化')
    remote, error = module._remote_main_oid(); identity, identity_error = module._remote_identity_sha256()
    if error or identity_error or remote != head or identity != receipt.get('remoteIdentitySha256'):
        raise ValueError('当前博客 main 与实际远端身份/OID 不一致')
    _git(module, ['merge-base', '--is-ancestor', commit, head])
    if _git(module, ['diff', '--cached', '--name-only'], text=True):
        raise ValueError('博客暂存区非空，不能退休原发布凭证')
    files, reviewed = manifest.get('files'), receipt.get('files')
    if not isinstance(files, list) or not isinstance(reviewed, list) or not files or len(files) != len(reviewed):
        raise ValueError('原生成/审查文件集合缺失')
    by_path = {item.get('path'): item for item in files}
    if len(by_path) != len(files) or len({item.get('path') for item in reviewed}) != len(reviewed):
        raise ValueError('原发布文件路径重复')
    for item in reviewed:
        if type(item.get('deleted')) is not bool or (item['deleted'] and item.get('sha256') is not None) \
                or (not item['deleted'] and not SHA.fullmatch(str(item.get('sha256') or ''))):
            raise ValueError('原已审文件的 SHA 或删除标记无效')
        if by_path.get(item.get('path'), {}).get('sha256') != item.get('sha256') \
                or by_path.get(item.get('path'), {}).get('deleted') != item.get('deleted'):
            raise ValueError('原生成/审查文件 SHA 或删除状态不符')
    paths = [child(repo, item['path']) for item in reviewed]
    for path in paths:
        module._validate_manifest_path_date(path, repo, date)
    module.validate_git_commit_against_review_receipt(receipt, paths, commit=commit)
    # 只准许四个已经受控维护的目录资源变化；成对资源、完整当前原档和
    # 当前386概念身份均须独立通过，不能将任意静态文件视为“目录升级”。
    from tag_catalog_publication import validate_published_tag_catalog
    catalog = module._PAGE_TAG_CATALOG
    availability = validate_published_tag_catalog(repo, catalog['registrySha256'], catalog['version'])
    expected_assets = module.tag_catalog_file_contents(repo)
    maintained = []
    for item, path in zip(reviewed, paths):
        relative = item['path']; saved = _blob(module, head, relative)
        raw = None if not path.exists() else read(path)
        expected = None if item['deleted'] else item['sha256']
        if (None if saved is None else sha(saved)) == expected and raw == saved:
            continue
        if relative not in CATALOG_MAINTENANCE_PATHS or item['deleted'] \
                or raw is None or raw != saved or expected_assets.get(relative) != raw:
            raise ValueError('原已审页面或资产相对当前 HEAD/工作区发生漂移：' + relative)
        maintained.append({'path': relative, 'originalSha256': expected, 'currentSha256': sha(raw)})
    for item in availability['files']:
        if _blob(module, head, item['path']) != read(child(repo, item['path'])):
            raise ValueError('标签目录双份资源未以当前 HEAD 字节受控提交')
    current_files = {item['path']: item.get('sha256') for item in reviewed}
    current_files.update({item['path']: item['currentSha256'] for item in maintained})
    current_files.update({item['path']: item['sha256'] for item in availability['files']})
    for relative, expected_raw in expected_assets.items():
        if read(child(repo, relative)) != expected_raw or _blob(module, head, relative) != expected_raw:
            raise ValueError('完整标签目录束尚未以当前 HEAD 字节受控提交：' + relative)
        current_files[relative] = sha(expected_raw)
    ids = sorted(module.normalize_publish_arxiv_id(item.get('arxivId')) for item in formal['papers'])
    published_ids = sorted(module.normalize_publish_arxiv_id(item.get('arxivId')) for item in manifest['publishedPapers'])
    if ids != published_ids or not ids or len(set(ids)) != len(ids) or formal.get('batchDate') != date:
        raise ValueError('原发布与当前封存完整论文集合不一致')
    return {'blogHead': head, 'publicationCommit': commit, 'remoteIdentitySha256': identity,
            'canonicalSha256': canonical_sha, 'paperIds': ids, 'catalogMaintenance': maintained,
            'catalogAvailability': availability,
            'controlledFiles': [{'path': name, 'sha256': current_files[name]} for name in sorted(current_files)]}


def validate_cas(module, current, directory, intent, pending):
    """首次完整核验后的提交是不可变对象；只重核已绑定 HEAD、实时远端及全部现有字节。"""
    if sha(read(current / 'deep-analysis-result.json')) != intent['canonicalSha256']:
        raise ValueError('重新发布期间正式分析 CAS 变化')
    module.validate_daily_fresh_sources_for_publish(str(current / 'deep-analysis-result.json'), intent['date'])
    remote, error = module._remote_main_oid(); identity, identity_error = module._remote_identity_sha256()
    if module.validate_git_publish_branch() != intent['blogHead'] or error or identity_error \
            or remote != intent['blogHead'] or identity != intent['remoteIdentitySha256'] \
            or _git(module, ['diff', '--cached', '--name-only'], text=True):
        raise ValueError('重新发布期间博客 HEAD、暂存区或实际远端 CAS 变化')
    if load_json(marker_path(current, intent['date'])) != pending:
        raise ValueError('重新发布期间日期标记 CAS 变化')
    repo = Path(module.BLOG_REPO).resolve()
    for record in intent['controlledFiles']:
        path = child(repo, record['path'])
        module._validate_manifest_path_date(path, repo, intent['date'])
        actual = None if not path.exists() and not path.is_symlink() else sha(read(path))
        if actual != record['sha256']:
            raise ValueError('重新发布期间原受控页面、资产或目录 CAS 变化：' + record['path'])
    for record in intent['files']:
        if sha(read(child(directory / 'archive', record['path']))) != record['sha256']:
            raise ValueError('重新发布期间归档 CAS 变化')


def activate(module, date, run_id, new_input, new_template, *, runs_root=None, after_step=lambda _step: None):
    """调用方持有仓库锁、日期锁；每个中断窗口均保留来源与原发布证明。"""
    validate_id(run_id)
    current = safe_dir(module.CURRENT_DIR)
    directory = safe_dir(transaction(runs_root, run_id), create=True)
    intent_path = directory / 'intent.json'
    marker = marker_path(current, date)
    if intent_path.exists():
        intent = validate_intent(load_json(intent_path), run_id, date)
        if (intent['newInputFingerprint'], intent['newTemplateFingerprint']) != (new_input, new_template):
            raise ValueError('同一重新发布 UUID 不能切换生成输入或模板')
        if (directory / 'completion.json').exists():
            result = verify_completed(current, directory, intent)
            marked = load_json(marker)
            if marked not in (result, {**result, 'status': 'pending'}):
                raise ValueError('当前日期已属于另一次重新发布事务')
            if marked != result:
                write(marker, encoded(result), immutable=False)
            return result
    else:
        assert_no_pending(current, date, runs_root=runs_root)
        manifest_raw = read(current / f'blog-generation-manifest-{date}.json')
        receipt_raw = read(current / f'blog-review-receipt-{date}.json')
        canonical_sha = sha(read(current / 'deep-analysis-result.json'))
        authority = verify_authority(module, date, manifest_raw, receipt_raw, canonical_sha)
        prior = sha(read(marker)) if marker.exists() else None
        intent = {'contract': CONTRACT, 'runId': run_id, 'date': date,
                  'newInputFingerprint': new_input, 'newTemplateFingerprint': new_template,
                  **authority, 'previousDateMarkerSha256': prior, 'files': _status_files(current, date)}
        validate_intent(intent, run_id, date)
        write(intent_path, encoded(intent))
        after_step('intent')
    completion = completion_for(intent); pending = {**completion, 'status': 'pending'}
    if marker.exists():
        existing = load_json(marker)
        if existing != pending and sha(read(marker)) != intent['previousDateMarkerSha256']:
            raise ValueError('日期重新发布标记的 CAS 变化')
    elif intent['previousDateMarkerSha256'] is not None:
        raise ValueError('原日期标记丢失')
    write(marker, encoded(pending), immutable=False)
    after_step('pending')
    for record in intent['files']:
        source = child(current, record['path']); saved = child(directory / 'archive', record['path'])
        candidate = source if source.exists() or source.is_symlink() else saved
        raw = read(candidate)
        if sha(raw) != record['sha256']:
            raise ValueError('归档前原发布状态字节发生变化')
        write(saved, raw)
        after_step('archive:' + record['path'])
    def validate():
        validate_cas(module, current, directory, intent, pending)
    validate()
    for record in intent['files']:
        if not record['remove']:
            continue
        source = child(current, record['path'])
        if source.exists() or source.is_symlink():
            if sha(read(source)) != record['sha256']:
                raise ValueError('退休前原发布状态 CAS 变化')
            source.unlink(); sync_dir(source.parent)
        after_step('retire:' + record['path'])
    validate()
    write(directory / 'completion.json', encoded(completion))
    after_step('completion')
    write(marker, encoded(completion), immutable=False)
    return completion


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('daily_republication.py')
    raise SystemExit('请通过 blog:generate -- --date DATE --republish UUID 使用受控入口')
