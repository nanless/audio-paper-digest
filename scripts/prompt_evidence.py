"""Read current templates or SHA-pinned retired Git evidence, without writes/network."""

import hashlib
import json
from pathlib import Path
import re

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LIMIT = 8 * 1024 * 1024
SHA = re.compile(r'^[a-f0-9]{64}$')
OID = re.compile(r'^(?:[a-f0-9]{40}|[a-f0-9]{64})$')
PROMPT = re.compile(r'^(?:prompts|manual/prompts)/[A-Za-z0-9_/-]+\.md$')


def _path(value):
    if not isinstance(value, str) or not PROMPT.fullmatch(value) \
            or any(part in {'', '.', '..'} for part in value.split('/')):
        raise ValueError('Prompt evidence path is outside the registered namespace')
    return value


def _regular_bytes(filename):
    from git_file_bytes import read_regular_bytes
    return read_regular_bytes(filename)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate key in Git Prompt evidence index')
        result[key] = value
    return result


CURRENT_PROMPT_REGISTRY = json.loads(
    _regular_bytes(PROJECT_ROOT / 'scripts/lib/prompt-current-records.json'),
    object_pairs_hook=_unique_object)
LEGACY_PROMPT_RECORDS = json.loads(
    _regular_bytes(PROJECT_ROOT / 'scripts/lib/prompt-legacy-records.json'),
    object_pairs_hook=_unique_object)
CURRENT_PROMPT_FILES = frozenset(
    [entry['path'] for entry in CURRENT_PROMPT_REGISTRY['stages'].values()]
    + [CURRENT_PROMPT_REGISTRY['filter']] + CURRENT_PROMPT_REGISTRY['special'])


def _index(root):
    value = json.loads(_regular_bytes(root / 'scripts/lib/git-prompt-evidence-index.json'),
                       object_pairs_hook=_unique_object)
    import protocol_codec as protocol
    valid_header = protocol.has_valid_header(value, 'git-prompt-evidence')
    if not valid_header \
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
    from git_file_bytes import read_git_blob
    return read_git_blob(root, blob['blobOid'], sha)


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
