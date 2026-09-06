"""Explicit, recoverable retirement of a promoted fresh run's old publication.

No content generation, model requests, blog writes, or scientific state changes.
The public entry is activate-fresh-publication.js, which owns the Node run lock.
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
            raise ValueError('Unsafe activation directory')
    return path


def read(path):
    path = Path(path)
    safe_dir(path.parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink not in (1, 2) or info.st_size > 256 * 1024 * 1024:
            raise ValueError('Unsafe activation file')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            raw = stream.read()
        if info.st_nlink == 2:
            temporary = path.parent / f'.activation-write-{path.name}-{sha(raw)}'
            other = temporary.lstat()
            if not stat.S_ISREG(other.st_mode) or other.st_ino != info.st_ino \
                    or other.st_dev != info.st_dev or other.st_nlink != 2 \
                    or other.st_mode & 0o777 != 0o600:
                raise ValueError('Unrecognized activation hard link')
        return raw
    finally:
        os.close(fd)


def child(root, relative):
    if not isinstance(relative, str) or not relative or '\\' in relative or any(
        part in ('', '.', '..') for part in relative.split('/')
    ) or Path(relative).is_absolute():
        raise ValueError('Unsafe activation path')
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
            raise ValueError('Immutable activation evidence differs')
        temporary = path.parent / f'.activation-write-{path.name}-{sha(raw)}'
        if temporary.exists():
            if not os.path.samestat(path.lstat(), temporary.lstat()):
                raise ValueError('Activation temporary file conflicts')
            temporary.unlink(); sync_dir(path.parent)
        return
    temporary = path.parent / f'.activation-write-{path.name}-{sha(raw)}'
    if temporary.exists() or temporary.is_symlink():
        partial = read(temporary)
        if not raw.startswith(partial) or temporary.stat().st_mode & 0o777 != 0o600 \
                or temporary.stat().st_nlink != 1:
            raise ValueError('Activation temporary bytes differ')
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
        raise ValueError('Invalid activation date')
    return Path(current) / PUBLICATION_ACTIVATION_DIRNAME / f'{date}.json'


def assert_no_pending(current, date, runs_root=None):
    marker = marker_path(current, date)
    if not marker.exists() and not marker.is_symlink():
        return
    try:
        value = json.loads(read(marker))
        if value.get('contract') != CONTRACT or value.get('date') != date or value.get('status') != 'activated':
            raise ValueError('incomplete')
        run_id = value.get('runId')
        if not isinstance(run_id, str) or str(uuid.UUID(run_id)) != run_id:
            raise ValueError('Invalid activation run UUID')
        run_dir = safe_dir(Path(runs_root or FRESH_REWRITE_RUNS_DIR) / run_id)
        intent_raw = read(run_dir / 'publication-activation-intent.json')
        intent = json.loads(intent_raw)
        if sha(intent_raw) != value.get('intentSha256') or intent.get('runId') != run_id \
                or intent.get('date') != date or intent.get('contract') != CONTRACT \
                or json.loads(read(run_dir / 'publication-activation.json')) != value:
            raise ValueError('Activation completion proof differs')
        run = json.loads(read(run_dir / 'run.json'))
        if run.get('runId') != run_id or run.get('date') != date or run.get('status') != 'promoted' \
                or sha(read(run_dir / 'run.json')) != intent.get('runSha256'):
            raise ValueError('Activation promoted run differs')
        files = intent['files']
        if len(files) != 6 or len({r['path'] for r in files}) != 6:
            raise ValueError('Activation archive set differs')
        for record in files:
            if sha(read(child(run_dir / 'publication-archive', record['path']))) != record['sha256']:
                raise ValueError('Activation archive differs')
    except (OSError, ValueError, TypeError, KeyError) as exc:
        raise ValueError('Publication activation is pending or corrupt; resume the explicit activation entry') from exc


def verify_completed(current, run_dir, intent):
    completion = {'contract': CONTRACT, 'date': intent['date'], 'runId': intent['runId'],
                  'status': 'activated', 'intentSha256': sha(encoded(intent))}
    pending = {**completion, 'status': 'pending'}
    if json.loads(read(run_dir / 'publication-activation.json')) != completion \
            or read(run_dir / 'publication-activation-intent.json') != encoded(intent):
        raise ValueError('Completed activation identity changed')
    for record in intent['files']:
        if sha(read(child(run_dir / 'publication-archive', record['path']))) != record['sha256']:
            raise ValueError('Completed activation archive changed')
    if json.loads(read(marker_path(current, intent['date']))) not in (pending, completion):
        raise ValueError('Another activation owns this date')
    return completion


def retire_files(current, run_dir, intent, after_move=lambda _index: None, validate=lambda: None):
    """Caller owns run, repository and date locks and validated all CAS proofs."""
    current = safe_dir(current); run_dir = safe_dir(run_dir)
    intent_raw = encoded(intent); digest = sha(intent_raw)
    intent_path = run_dir / 'publication-activation-intent.json'
    final_path = run_dir / 'publication-activation.json'
    marker = marker_path(current, intent['date'])
    archive = run_dir / 'publication-archive'
    records = intent['files']
    if len(records) != 6 or len({r['path'] for r in records}) != 6:
        raise ValueError('Activation requires the exact six state paths')
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
        # A crash after completion but before clearing the pending gate is safe.
        write(marker, encoded(completion), immutable=False)
        return completion
    for record in records:
        source = child(current, record['path']); saved = child(archive, record['path'])
        candidate = source if source.exists() or source.is_symlink() else saved
        if sha(read(candidate)) != record['sha256']:
            raise ValueError('Active publication CAS drifted')
        if saved.exists() and sha(read(saved)) != record['sha256']:
            raise ValueError('Activation archive drifted')
    validate()
    write(intent_path, intent_raw)
    if marker.exists() and json.loads(read(marker)) != pending:
        raise ValueError('Another activation owns this date')
    write(marker, encoded(pending))
    # Copy and fsync every byte before retiring any active path.
    for record in records:
        source = child(current, record['path']); saved = child(archive, record['path'])
        write(saved, read(saved) if saved.exists() else read(source))
    after_move(0)
    validate()
    for index, record in enumerate(records, 1):
        source = child(current, record['path'])
        if source.exists() or source.is_symlink():
            if sha(read(source)) != record['sha256']:
                raise ValueError('Active publication CAS drifted before retirement')
            source.unlink(); sync_dir(current)
        after_move(index)
    validate()
    write(final_path, encoded(completion))
    write(marker, encoded(completion), immutable=False)
    return completion


def prepare_intent(module, run_dir):
    """Read-only preflight, including old receipts at their own original commits."""
    run_dir = safe_dir(run_dir)
    run_raw = read(run_dir / 'run.json'); run = json.loads(run_raw)
    baseline_raw = read(run_dir / 'baseline.json'); baseline = json.loads(baseline_raw)
    promotion_raw = read(run_dir / 'promotion.json'); promotion = json.loads(promotion_raw)
    current = Path(module.CURRENT_DIR); repo = Path(module.BLOG_REPO).resolve()
    canonical_raw = read(current / 'deep-analysis-result.json'); canonical = json.loads(canonical_raw)
    if run.get('status') != 'promoted' or run.get('runId') != run_dir.name \
            or sha(baseline_raw) != run['baseline']['sha256'] \
            or baseline.get('contract') != 'fresh-rewrite-baseline-v1' \
            or baseline['date'] != run['date'] or baseline['paperIds'] != run['paperIds'] \
            or Path(baseline['blog']['repo']).resolve() != repo \
            or promotion.get('runId') != run['runId'] \
            or promotion.get('baselineSha256') != sha(baseline_raw) \
            or sha(canonical_raw) != promotion.get('canonicalSha256') \
            or canonical.get('generation') != promotion.get('canonicalGeneration') \
            or canonical.get('freshRewritePromotion', {}).get('runId') != run['runId'] \
            or sorted(p.get('arxivId', '') for p in canonical.get('papers', [])) != sorted(run['paperIds']):
        raise ValueError('Promoted run/baseline/canonical CAS mismatch')
    git = lambda args: module._run_git(args, text=True, check=True).stdout.strip()
    head = git(['rev-parse', 'HEAD'])
    if head != baseline['blog']['head'] or git(['branch', '--show-current']) != 'main' \
            or git(['status', '--porcelain=v1', '--untracked-files=all']):
        raise ValueError('Blog must remain clean at the exact baseline HEAD')
    remote_oid, error = module._remote_main_oid()
    identity, identity_error = module._remote_identity_sha256()
    if error or identity_error or remote_oid != head or not identity:
        raise ValueError('Live remote OID/identity cannot attest the baseline')
    data_records = {}
    for record in baseline['files']:
        backup = child(run_dir, record['backupPath'])
        if not record['backupPath'].startswith('baseline-files/') or sha(read(backup)) != record['sha256'] \
                or backup.stat().st_mode & 0o777 != 0o600:
            raise ValueError('Baseline backup bytes/permissions drifted')
        if record['category'] == 'blog':
            if sha(read(child(repo, record['relativePath']))) != record['sha256']:
                raise ValueError('Current blog target differs from baseline')
        elif record['category'] == 'data':
            data_records[record['relativePath']] = record
    date = run['date']
    names = sorted(name for name in data_records if re.fullmatch(
        rf'blog-(?:generation-manifest|review-receipt)-{re.escape(date)}(?:-single-[\w-]+)?\.json', name))
    if len(names) != 4:
        raise ValueError('Activation only supports one full and one single published transaction')
    receipts = [name for name in names if name.startswith('blog-review-receipt-')]
    if f'blog-review-receipt-{date}.json' not in receipts or len(receipts) != 2:
        raise ValueError('Expected full and single receipt pair')
    names += [name.replace('blog-review-receipt-', 'blog-review-passes-') for name in receipts]
    allowed = set(names)
    for target in current.iterdir():
        if re.match(rf'blog-(?:generation|review)-.*{re.escape(date)}', target.name) and target.name not in allowed:
            raise ValueError('Unexpected same-date publication state requires explicit inspection')
    checkpoints = current / 'blog-review-checkpoints'
    if checkpoints.exists() and any(target.name.startswith(date) for target in checkpoints.iterdir()):
        raise ValueError('Existing same-date review checkpoints require explicit inspection')
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
            raise ValueError('Old publication state differs from the baseline/intent')
        records.append({'path': name, 'sha256': expected})
    latest = False
    for name in receipts:
        receipt = json.loads(active_bytes(name)); commit = receipt.get('publicationCommit')
        manifest_name = name.replace('blog-review-receipt-', 'blog-generation-manifest-')
        if receipt.get('date') != date or receipt.get('remoteIdentitySha256') != identity \
                or receipt.get('remoteVerifiedOid') != commit or not receipt.get('remoteVerifiedAt') \
                or receipt.get('generationManifestSha256') != sha(active_bytes(manifest_name)):
            raise ValueError('Old receipt publication identity/manifest binding mismatch')
        git(['merge-base', '--is-ancestor', commit, head])
        paths = [child(repo, record['path']) for record in receipt['files']]
        module.validate_git_commit_against_review_receipt(receipt, paths, commit=commit)
        latest |= commit == head
    if not latest:
        raise ValueError('No retired receipt attests the exact current baseline HEAD')
    intent = {'contract': CONTRACT, 'runId': run['runId'], 'date': date, 'files': records,
              'runSha256': sha(run_raw), 'baselineSha256': sha(baseline_raw),
              'promotionSha256': sha(promotion_raw), 'canonicalSha256': sha(canonical_raw),
              'canonicalGeneration': canonical['generation'], 'paperIds': run['paperIds'],
              'blogHead': head, 'remoteOid': remote_oid, 'remoteIdentitySha256': identity}
    if prior and prior != intent:
        raise ValueError('Activation intent CAS drifted')
    return intent


def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if str(uuid.UUID(args.run_id)) != args.run_id:
        raise ValueError('Invalid canonical run UUID')
    run_dir = safe_dir(FRESH_REWRITE_RUNS_DIR / args.run_id)
    owner = json.loads(read(run_dir / '.operation.lock' / 'owner.json'))
    if owner.get('pid') != os.getppid() or owner.get('hostname') != socket.gethostname() or not owner.get('token'):
        raise ValueError('Activation must run under the official Node run operation lock')
    from blog_entry_loader import load_publish_to_blog
    module = load_publish_to_blog()
    date = json.loads(read(run_dir / 'run.json'))['date']
    with module.blog_repository_lock():
        with module.blog_transaction_lock(date):
            completed = run_dir / 'publication-activation.json'
            # Normal generation may now replace active paths and change the
            # blog. A completed activation never retires those new bytes.
            if completed.exists():
                intent = json.loads(read(run_dir / 'publication-activation-intent.json'))
                if intent.get('runId') != args.run_id or intent.get('date') != date:
                    raise ValueError('Completed activation belongs to another run/date')
                verify_completed(module.CURRENT_DIR, run_dir, intent)
            else:
                intent = prepare_intent(module, run_dir)
            def validate_cas():
                if json.loads(read(run_dir / '.operation.lock' / 'owner.json')) != owner \
                        or owner['pid'] != os.getppid():
                    raise ValueError('Run operation lock ownership changed')
                for target, expected in [
                    (run_dir / 'run.json', intent['runSha256']),
                    (run_dir / 'promotion.json', intent['promotionSha256']),
                    (Path(module.CURRENT_DIR) / 'deep-analysis-result.json', intent['canonicalSha256']),
                ]:
                    if sha(read(target)) != expected:
                        raise ValueError('Scientific promotion CAS changed during activation')
            result = {'status': 'ready', 'intent': intent} if args.dry_run else retire_files(
                module.CURRENT_DIR, run_dir, intent, validate=validate_cas)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
