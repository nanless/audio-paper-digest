"""把已晋升的新批次顶掉的旧发布下线，过程可恢复。

这里不生成内容、不请求模型、不写博客，也不改动任何科研状态。对外入口是
activate-fresh-publication.js，Node 侧的运行锁由它持有。
"""
if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('publication_activation.py')

import argparse
import hashlib
import json
import os
import re
import socket
import stat
import uuid
from pathlib import Path

from path_config import FRESH_REWRITE_RUNS_DIR, PUBLICATION_ACTIVATION_DIRNAME

CONTRACT = 'fresh-publication-activation-v1'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2).encode()


def safe_dir(path, create=False):
    path = Path(path).absolute()
    for parent in [*reversed(path.parents), path]:
        if create and not parent.exists():
            parent.mkdir(mode=0o700)
        if parent.is_symlink() or not parent.is_dir():
            raise ValueError('发布启用目录类型或符号链接检查未通过')
    return path


def read(path):
    path = Path(path)
    safe_dir(path.parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, 'O_NONBLOCK', 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink not in (1, 2) or info.st_size > 256 * 1024 * 1024:
            raise ValueError('发布启用文件不是普通文件、硬链接数不符合要求，或大小超过限制')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            raw = stream.read()
        if info.st_nlink == 2:
            temporary = path.parent / f'.activation-write-{path.name}-{sha(raw)}'
            other = temporary.lstat()
            if not stat.S_ISREG(other.st_mode) or other.st_ino != info.st_ino \
                    or other.st_dev != info.st_dev or other.st_nlink != 2 \
                    or other.st_mode & 0o777 != 0o600:
                raise ValueError('无法识别这个激活硬链接：临时文件的 inode、设备号、链接数或权限不符')
        return raw
    finally:
        os.close(fd)


def child(root, relative):
    if not isinstance(relative, str) or not relative or '\\' in relative or any(
        part in ('', '.', '..') for part in relative.split('/')
    ) or Path(relative).is_absolute():
        raise ValueError('发布启用文件路径无效：须为不含目录越界的相对路径')
    return Path(root) / relative


def sync_dir(directory):
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write(path, raw, immutable=True):
    path = Path(path); safe_dir(path.parent, create=True)
    if immutable and path.exists():
        if read(path) != raw or path.stat().st_mode & 0o777 != 0o600:
            raise ValueError('不可变激活凭证与已有字节不一致（要求内容相同且权限为 0600）')
        temporary = path.parent / f'.activation-write-{path.name}-{sha(raw)}'
        if temporary.exists():
            if not os.path.samestat(path.lstat(), temporary.lstat()):
                raise ValueError('激活临时文件与目标文件不是同一份 inode')
            temporary.unlink(); sync_dir(path.parent)
        return
    temporary = path.parent / f'.activation-write-{path.name}-{sha(raw)}'
    if temporary.exists() or temporary.is_symlink():
        partial = read(temporary)
        if not raw.startswith(partial) or temporary.stat().st_mode & 0o777 != 0o600 \
                or temporary.stat().st_nlink != 1:
            raise ValueError('激活临时文件的字节不是目标内容的完整前缀，或权限、链接数不符')
        temporary.unlink(); sync_dir(path.parent)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(raw); stream.flush(); os.fsync(fd)
    finally:
        os.close(fd)
    try:
        if immutable:
            os.link(temporary, path)
        else:
            os.replace(temporary, path)
        sync_dir(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def marker_path(current, date):
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date):
        raise ValueError('激活日期不合法：必须是 YYYY-MM-DD')
    return Path(current) / PUBLICATION_ACTIVATION_DIRNAME / f'{date}.json'


def assert_no_pending(current, date, runs_root=None):
    marker = marker_path(current, date)
    if not marker.exists() and not marker.is_symlink():
        return
    try:
        value = json.loads(read(marker))
        if value.get('contract') != CONTRACT or value.get('date') != date or value.get('status') != 'activated':
            raise ValueError('激活记录未完成')
        run_id = value.get('runId')
        if not isinstance(run_id, str) or str(uuid.UUID(run_id)) != run_id:
            raise ValueError('激活记录的 runId 不是规范 UUID')
        run_dir = safe_dir(Path(runs_root or FRESH_REWRITE_RUNS_DIR) / run_id)
        intent_raw = read(run_dir / 'publication-activation-intent.json')
        intent = json.loads(intent_raw)
        if sha(intent_raw) != value.get('intentSha256') or intent.get('runId') != run_id \
                or intent.get('date') != date or intent.get('contract') != CONTRACT \
                or json.loads(read(run_dir / 'publication-activation.json')) != value:
            raise ValueError('激活完成凭证与意图记录不一致')
        run = json.loads(read(run_dir / 'run.json'))
        if run.get('runId') != run_id or run.get('date') != date or run.get('status') != 'promoted' \
                or sha(read(run_dir / 'run.json')) != intent.get('runSha256'):
            raise ValueError('已晋升的运行记录与激活意图不一致：runId、日期或 run.json 的 SHA 不符')
        files = intent['files']
        if len(files) != 6 or len({r['path'] for r in files}) != 6:
            raise ValueError('激活归档不是 6 个互不重复的状态路径')
        for record in files:
            if sha(read(child(run_dir / 'publication-archive', record['path']))) != record['sha256']:
                raise ValueError('激活归档中的文件字节与意图记录的 SHA 不符')
    except (OSError, ValueError, TypeError, KeyError) as exc:
        # 未完成或损坏的启用记录都阻止发布；须从专用入口恢复后重新检查。
        raise ValueError('发布启用尚未完成，或其记录已损坏；请从专用的发布启用入口恢复') from exc


def verify_completed(current, run_dir, intent):
    completion = {'contract': CONTRACT, 'date': intent['date'], 'runId': intent['runId'],
                  'status': 'activated', 'intentSha256': sha(encoded(intent))}
    pending = {**completion, 'status': 'pending'}
    if json.loads(read(run_dir / 'publication-activation.json')) != completion \
            or read(run_dir / 'publication-activation-intent.json') != encoded(intent):
        raise ValueError('已完成激活的身份记录被改动：完成凭证或意图字节不符')
    for record in intent['files']:
        if sha(read(child(run_dir / 'publication-archive', record['path']))) != record['sha256']:
            raise ValueError('已完成激活的归档字节被改动')
    if json.loads(read(marker_path(current, intent['date']))) not in (pending, completion):
        raise ValueError('这个日期已被另一次激活占用')
    return completion


def retire_files(current, run_dir, intent, after_move=lambda _index: None, validate=lambda: None):
    """调用方已经持有运行锁、仓库锁和日期锁，并核过全部 CAS 凭证。"""
    current = safe_dir(current); run_dir = safe_dir(run_dir)
    intent_raw = encoded(intent); digest = sha(intent_raw)
    intent_path = run_dir / 'publication-activation-intent.json'
    final_path = run_dir / 'publication-activation.json'
    marker = marker_path(current, intent['date'])
    archive = run_dir / 'publication-archive'
    records = intent['files']
    if len(records) != 6 or len({r['path'] for r in records}) != 6:
        raise ValueError('激活要求恰好 6 个互不重复的状态路径')
    for record in records:
        child(current, record['path']); child(archive, record['path'])
    completion = {'contract': CONTRACT, 'date': intent['date'], 'runId': intent['runId'],
                  'status': 'activated', 'intentSha256': digest}
    pending = {**completion, 'status': 'pending'}
    if final_path.exists():
        verify_completed(current, run_dir, intent)
        write(intent_path, intent_raw)
        write(final_path, encoded(completion))
        for record in records:
            saved = child(archive, record['path'])
            write(saved, read(saved))
        # 已经写完完成记录、还没来得及清掉 pending 闸门时崩掉也没关系。
        write(marker, encoded(completion), immutable=False)
        return completion
    for record in records:
        source = child(current, record['path']); saved = child(archive, record['path'])
        candidate = source if source.exists() or source.is_symlink() else saved
        if sha(read(candidate)) != record['sha256']:
            raise ValueError('现役发布文件的字节与激活记录不符')
        if saved.exists() and sha(read(saved)) != record['sha256']:
            raise ValueError('激活归档的字节与激活记录不符')
    validate()
    write(intent_path, intent_raw)
    if marker.exists() and json.loads(read(marker)) != pending:
        raise ValueError('这个日期已被另一次激活占用')
    write(marker, encoded(pending))
    # 先把每个字节复制过去并 fsync，再动任何现役路径。
    for record in records:
        source = child(current, record['path']); saved = child(archive, record['path'])
        write(saved, read(saved) if saved.exists() else read(source))
    after_move(0)
    validate()
    for index, record in enumerate(records, 1):
        source = child(current, record['path'])
        if source.exists() or source.is_symlink():
            if sha(read(source)) != record['sha256']:
                raise ValueError('下线现役文件前发现它的字节与激活记录不符')
            source.unlink(); sync_dir(current)
        after_move(index)
    validate()
    write(final_path, encoded(completion))
    write(marker, encoded(completion), immutable=False)
    return completion


def verify_paper_scope(run_dir, run, baseline, analysis):
    """本批论文必须完整；其他日期记录须与已封存的旧正式结果相同。"""
    expected = run.get('paperIds')
    if not isinstance(expected, list) or not expected or any(
            not isinstance(value, str) or not value for value in expected
    ) or len(set(expected)) != len(expected):
        raise ValueError('激活运行的论文集合无效或重复')
    expected = set(expected)

    def split_papers(payload):
        if not isinstance(payload, dict) or not isinstance(payload.get('papers'), list):
            raise ValueError('激活正式结果缺少论文列表')
        by_id = {}
        for paper in payload['papers']:
            paper_id = paper.get('arxivId') if isinstance(paper, dict) else None
            if not isinstance(paper_id, str) or not paper_id or paper_id in by_id:
                raise ValueError('激活正式结果包含无效或重复论文 ID')
            by_id[paper_id] = paper
        target_date_ids = set()
        for paper_id, paper in by_id.items():
            fetched_at = paper.get('fetchedAt') or ''
            if not isinstance(fetched_at, str):
                raise ValueError('激活论文的抓取时间不是字符串')
            date = (paper.get('fetchBatchDate') or paper.get('batchDate')
                    or fetched_at[:10] or payload.get('batchDate'))
            if date == run['date']:
                target_date_ids.add(paper_id)
        if target_date_ids != expected or not expected.issubset(by_id):
            raise ValueError('激活日期的论文集合与运行不一致')
        return {paper_id: paper for paper_id, paper in by_id.items() if paper_id not in expected}

    current_outside = split_papers(analysis)
    records = [record for record in baseline.get('files', [])
               if record.get('category') == 'data'
               and record.get('relativePath') == 'deep-analysis-result.json']
    if len(records) != 1:
        raise ValueError('激活基线缺少唯一的旧正式结果备份，无法核验其他日期论文')
    record = records[0]
    backup_path = record.get('backupPath')
    if not isinstance(backup_path, str) or not backup_path.startswith('baseline-files/'):
        raise ValueError('旧正式结果备份路径不在激活基线内')
    raw = read(child(run_dir, backup_path))
    if sha(raw) != record.get('sha256') or sha(raw) != baseline.get('canonical', {}).get('sha256'):
        raise ValueError('旧正式结果备份与激活基线的 SHA 不一致')
    old_outside = split_papers(json.loads(raw))
    if encoded(old_outside) != encoded(current_outside):
        raise ValueError('其他日期论文相对基线发生了新增、删除或内容变更')


def prepare_intent(module, run_dir):
    """只读预检，包括到各自原始提交上读取旧的发布凭证。"""
    run_dir = safe_dir(run_dir)
    run_raw = read(run_dir / 'run.json'); run = json.loads(run_raw)
    baseline_raw = read(run_dir / 'baseline.json'); baseline = json.loads(baseline_raw)
    promotion_raw = read(run_dir / 'promotion.json'); promotion = json.loads(promotion_raw)
    current = Path(module.CURRENT_DIR); repo = Path(module.BLOG_REPO).resolve()
    analysis_result_bytes = read(current / 'deep-analysis-result.json'); analysis_result = json.loads(analysis_result_bytes)
    if run.get('status') != 'promoted' or run.get('runId') != run_dir.name \
            or sha(baseline_raw) != run['baseline']['sha256'] \
            or baseline.get('contract') != 'fresh-rewrite-baseline-v1' \
            or baseline['date'] != run['date'] or baseline['paperIds'] != run['paperIds'] \
            or Path(baseline['blog']['repo']).resolve() != repo \
            or promotion.get('runId') != run['runId'] \
            or promotion.get('baselineSha256') != sha(baseline_raw) \
            or sha(analysis_result_bytes) != promotion.get('canonicalSha256') \
            or analysis_result.get('generation') != promotion.get('canonicalGeneration') \
            or analysis_result.get('freshRewritePromotion', {}).get('runId') != run['runId']:
        raise ValueError('已晋升运行、基线与正式分析结果之间对不上')
    verify_paper_scope(run_dir, run, baseline, analysis_result)
    git = lambda args: module._run_git(args, text=True, check=True).stdout.strip()
    head = git(['rev-parse', 'HEAD'])
    if head != baseline['blog']['head'] or git(['branch', '--show-current']) != 'main' \
            or git(['status', '--porcelain=v1', '--untracked-files=all']):
        raise ValueError('博客必须停在基线 HEAD 上且没有未提交改动')
    remote_oid, error = module._remote_main_oid()
    identity, identity_error = module._remote_identity_sha256()
    if error or identity_error or remote_oid != head or not identity:
        raise ValueError('远端 main 的 OID 或身份无法证明当前基线')
    data_records = {}
    for record in baseline['files']:
        backup = child(run_dir, record['backupPath'])
        if not record['backupPath'].startswith('baseline-files/') or sha(read(backup)) != record['sha256'] \
                or backup.stat().st_mode & 0o777 != 0o600:
            raise ValueError('基线备份的字节或权限已漂移')
        if record['category'] == 'blog':
            if sha(read(child(repo, record['relativePath']))) != record['sha256']:
                raise ValueError('博客当前目标文件与基线字节不符')
        elif record['category'] == 'data':
            data_records[record['relativePath']] = record
    date = run['date']
    names = sorted(name for name in data_records if re.fullmatch(
        rf'blog-(?:generation-manifest|review-receipt)-{re.escape(date)}(?:-single-[\w-]+)?\.json', name))
    if len(names) != 4:
        raise ValueError('激活只支持一次全量加一次单篇的发布事务，当前同名状态文件不是 4 个')
    receipts = [name for name in names if name.startswith('blog-review-receipt-')]
    if f'blog-review-receipt-{date}.json' not in receipts or len(receipts) != 2:
        raise ValueError('需要一份全量审查凭证和一份单篇审查凭证')
    names += [name.replace('blog-review-receipt-', 'blog-review-passes-') for name in receipts]
    allowed = set(names)
    for target in current.iterdir():
        if re.match(rf'blog-(?:generation|review)-.*{re.escape(date)}', target.name) and target.name not in allowed:
            raise ValueError('发现同日期但预期外的发布状态文件，需要人工确认后才能继续')
    checkpoints = current / 'blog-review-checkpoints'
    if checkpoints.exists() and any(target.name.startswith(date) for target in checkpoints.iterdir()):
        raise ValueError('已存在同日期的审查检查点，需要人工确认后才能继续')
    prior_path = run_dir / 'publication-activation-intent.json'
    prior = json.loads(read(prior_path)) if prior_path.exists() else None
    expected_prior = {r['path']: r['sha256'] for r in prior['files']} if prior else {}
    records = []
    def active_bytes(name):
        target = child(current, name)
        return read(target if target.exists() or target.is_symlink() else child(run_dir / 'publication-archive', name))
    for name in sorted(names):
        raw = active_bytes(name)
        expected = data_records[name]['sha256'] if name in data_records else expected_prior.get(name, sha(raw))
        if sha(raw) != expected:
            raise ValueError('旧发布状态文件与基线或激活意图的 SHA 不符')
        records.append({'path': name, 'sha256': expected})
    latest = False
    for name in receipts:
        receipt = json.loads(active_bytes(name)); commit = receipt.get('publicationCommit')
        manifest_name = name.replace('blog-review-receipt-', 'blog-generation-manifest-')
        if receipt.get('date') != date or receipt.get('remoteIdentitySha256') != identity \
                or receipt.get('remoteVerifiedOid') != commit or not receipt.get('remoteVerifiedAt') \
                or receipt.get('generationManifestSha256') != sha(active_bytes(manifest_name)):
            raise ValueError('旧审查凭证与发布身份或生成清单对不上')
        git(['merge-base', '--is-ancestor', commit, head])
        paths = [child(repo, record['path']) for record in receipt['files']]
        module.validate_git_commit_against_review_receipt(receipt, paths, commit=commit)
        latest |= commit == head
    if not latest:
        raise ValueError('没有已下线的审查凭证对应当前基线 HEAD')
    intent = {'contract': CONTRACT, 'runId': run['runId'], 'date': date, 'files': records,
              'runSha256': sha(run_raw), 'baselineSha256': sha(baseline_raw),
              'promotionSha256': sha(promotion_raw), 'canonicalSha256': sha(analysis_result_bytes),
              'canonicalGeneration': analysis_result['generation'], 'paperIds': run['paperIds'],
              'blogHead': head, 'remoteOid': remote_oid, 'remoteIdentitySha256': identity}
    if prior and prior != intent:
        raise ValueError('激活意图与已保存的记录不一致')
    return intent


def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if str(uuid.UUID(args.run_id)) != args.run_id:
        raise ValueError('--run-id 不是规范 UUID')
    run_dir = safe_dir(FRESH_REWRITE_RUNS_DIR / args.run_id)
    owner = json.loads(read(run_dir / '.operation.lock' / 'owner.json'))
    if owner.get('pid') != os.getppid() or owner.get('hostname') != socket.gethostname() or not owner.get('token'):
        raise ValueError('激活必须在官方 Node 运行操作锁下执行：锁属主的 pid、主机名或令牌不符')
    from blog_entry_loader import load_publish_to_blog
    module = load_publish_to_blog()
    date = json.loads(read(run_dir / 'run.json'))['date']
    with module.blog_repository_lock():
        with module.blog_transaction_lock(date):
            completed = run_dir / 'publication-activation.json'
            # 常规生成此时可能已经替换了现役路径、改动了博客。已完成的这次
            # 下线不会去动这些新字节。
            if completed.exists():
                intent = json.loads(read(run_dir / 'publication-activation-intent.json'))
                if intent.get('runId') != args.run_id or intent.get('date') != date:
                    raise ValueError('已完成激活属于另一次运行或另一个日期')
                verify_completed(module.CURRENT_DIR, run_dir, intent)
            else:
                intent = prepare_intent(module, run_dir)
            def validate_cas():
                if json.loads(read(run_dir / '.operation.lock' / 'owner.json')) != owner \
                        or owner['pid'] != os.getppid():
                    raise ValueError('运行操作锁的属主已变化')
                for target, expected in [
                    (run_dir / 'run.json', intent['runSha256']),
                    (run_dir / 'promotion.json', intent['promotionSha256']),
                    (Path(module.CURRENT_DIR) / 'deep-analysis-result.json', intent['canonicalSha256']),
                ]:
                    if sha(read(target)) != expected:
                        raise ValueError('激活期间科研晋升文件发生了变化')
            result = {'status': 'ready', 'intent': intent} if args.dry_run else retire_files(
                module.CURRENT_DIR, run_dir, intent, validate=validate_cas)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
