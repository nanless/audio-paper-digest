"""Read current templates or SHA-pinned retired Git evidence, without writes/network."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LIMIT = 8 * 1024 * 1024
CURRENT_PROMPT_FILES = frozenset((
    "prompts/api-reader-article-v9.md",
    "prompts/api-reader-concept-terms-v1.md",
    "prompts/api-reader-fact-local-v3.md",
    "prompts/api-reader-repair-v13.md",
    "prompts/core-summary-repair-v7.md",
    "prompts/deep-analysis-v6.md",
    "prompts/digest-cover-v2.md",
    "prompts/filter-v5.md",
    "prompts/gap-fill-v4.md",
    "prompts/image-supplement-v3.md",
    "prompts/method-fill-v3.md",
    "prompts/opensource-scan-v3.md",
    "prompts/primary-fact-local-repair-v1.md",
    "prompts/scoring-audit-v5.md",
    "prompts/structure-repair-v3.md",
    "prompts/table-fill-v2.md",
    "prompts/tag-repair-v3.md",
    "prompts/visual-summary-v2.md",
))
SHA = re.compile(r'^[a-f0-9]{64}$')
OID = re.compile(r'^(?:[a-f0-9]{40}|[a-f0-9]{64})$')
PROMPT = re.compile(r'^(?:prompts|manual/prompts)/[A-Za-z0-9_/-]+\.md$')


def _path(value):
    if not isinstance(value, str) or not PROMPT.fullmatch(value) \
            or any(part in {'', '.', '..'} for part in value.split('/')):
        raise ValueError('Prompt evidence path is outside the registered namespace')
    return value


def _regular_bytes(filename):
    filename = Path(filename)
    if filename.resolve(strict=True) != filename:
        raise ValueError('Prompt evidence forbids symlink paths')
    descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        import stat
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > LIMIT:
            raise ValueError('Prompt evidence requires a bounded single-link regular file')
        with os.fdopen(os.dup(descriptor), 'rb') as handle:
            data = handle.read(LIMIT + 1)
        after = os.fstat(descriptor)
        named = filename.lstat()
        keys = ('st_dev', 'st_ino', 'st_size', 'st_nlink', 'st_mtime_ns', 'st_ctime_ns')
        if any(getattr(before, key) != getattr(after, key) for key in keys) \
                or (named.st_dev, named.st_ino) != (after.st_dev, after.st_ino) \
                or filename.resolve(strict=True) != filename or len(data) != before.st_size:
            raise ValueError('Prompt evidence changed during reading')
        return data
    finally:
        os.close(descriptor)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate key in Git Prompt evidence index')
        result[key] = value
    return result


def _index(root):
    value = json.loads(_regular_bytes(root / 'scripts/lib/git-prompt-evidence-index.json'),
                       object_pairs_hook=_unique_object)
    if value.get('contract') != 'git-prompt-evidence-v1' or value.get('version') != 1 \
            or not OID.fullmatch(str(value.get('provenanceCommit', ''))) \
            or not isinstance(value.get('retiredPaths'), dict) or not isinstance(value.get('blobs'), dict):
        raise ValueError('Invalid Git Prompt evidence index')
    for relative, sha in value['retiredPaths'].items():
        _path(relative)
        if not SHA.fullmatch(str(sha)) or relative not in value['blobs'].get(sha, {}).get('paths', []):
            raise ValueError('Retired Prompt path lacks its original Git evidence')
    for sha, blob in value['blobs'].items():
        paths = blob.get('paths') if isinstance(blob, dict) else None
        if not SHA.fullmatch(sha) or not OID.fullmatch(str(blob.get('blobOid', ''))) \
                or not isinstance(paths, list) or not paths or len(paths) != len(set(paths)):
            raise ValueError('Invalid Git Prompt blob identity')
        for relative in paths:
            _path(relative)
    return value


def _blob_bytes(root, blob, sha):
    environment = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    environment.update(GIT_TERMINAL_PROMPT='0', GIT_NO_LAZY_FETCH='1',
                       GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null')
    try:
        size = subprocess.run(['git', '--no-lazy-fetch', '--no-replace-objects', '-C', str(root),
                               'cat-file', '-s', blob['blobOid']], env=environment,
                              capture_output=True, timeout=10, check=True).stdout.strip()
        if len(size) > 20 or not size.isdigit() or int(size) > LIMIT:
            raise ValueError('Retired Prompt Git object exceeds the evidence limit')
        result = subprocess.run(['git', '--no-lazy-fetch', '--no-replace-objects', '-C', str(root),
                                 'cat-file', 'blob', blob['blobOid']], env=environment,
                                capture_output=True, timeout=10, check=True)
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError('Retired Prompt Git object unavailable; restore repository history') from error
    if len(result.stdout) > LIMIT or hashlib.sha256(result.stdout).hexdigest() != sha:
        raise ValueError('Retired Prompt Git bytes do not match the original SHA256')
    return result.stdout


def historical_prompt_evidence_bytes_for_sha256(sha, *, project_root=None, relative_path=None):
    if not SHA.fullmatch(str(sha or '')):
        return None
    root = Path(project_root or PROJECT_ROOT).resolve(strict=True)
    blob = _index(root)['blobs'].get(sha)
    if not blob or relative_path is not None and _path(relative_path) not in blob['paths']:
        return None
    return _blob_bytes(root, blob, sha)


def read_prompt_evidence_bytes(relative_path, expected_sha256=None, *, project_root=None):
    relative = _path(relative_path)
    root = Path(project_root or PROJECT_ROOT).resolve(strict=True)
    if expected_sha256 is not None and not SHA.fullmatch(str(expected_sha256)):
        raise ValueError('Invalid declared Prompt SHA256')
    index = _index(root)
    # Only registered retired paths may use Git; any current or unknown file
    # retains regular-file and missing-file checks in the checkout.
    if relative not in CURRENT_PROMPT_FILES and relative in index['retiredPaths']:
        sha = expected_sha256 or index['retiredPaths'][relative]
        blob = index['blobs'].get(sha)
        if not blob or relative not in blob['paths']:
            raise ValueError('Unregistered retired Prompt path or SHA256')
        data = _blob_bytes(root, blob, sha)
    else:
        data = _regular_bytes(root / relative)
    if expected_sha256 is not None and hashlib.sha256(data).hexdigest() != expected_sha256:
        raise ValueError('Prompt bytes do not match the declared SHA256')
    return data


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('prompt_evidence.py')
    raise SystemExit('This is a shared read-only evidence module.')
