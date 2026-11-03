"""Return registered original bytes; never execute code or grant source/completion authority."""
import json
from pathlib import Path
import re
from git_file_bytes import read_regular_bytes, read_git_blob

ROOT = Path(__file__).resolve().parent.parent
SHA = re.compile(r'[a-f0-9]{64}\Z')
OID = re.compile(r'(?:[a-f0-9]{40}|[a-f0-9]{64})\Z')
CONTROLLED = re.compile(r'manual/(?:docs|scripts)/[A-Za-z0-9_-]+\.(?:md|js)\Z')


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate key in original file catalog')
        result[key] = value
    return result


def _catalog(root):
    value = json.loads(read_regular_bytes(root / 'config/original-file-evidence.json'), object_pairs_hook=_unique)
    if type(value) is not dict or set(value) != {'files', 'blobs'} \
            or type(value['files']) is not dict or type(value['blobs']) is not dict:
        raise ValueError('Invalid original file catalog')
    for relative, row in value['files'].items():
        if not CONTROLLED.fullmatch(relative) or type(row) is not dict \
                or not SHA.fullmatch(str(row.get('defaultSha256', ''))) \
                or relative not in value['blobs'].get(row['defaultSha256'], {}).get('paths', []):
            raise ValueError('Original file lacks registered Git bytes')
    for sha, row in value['blobs'].items():
        if not SHA.fullmatch(sha) or type(row) is not dict or not OID.fullmatch(str(row.get('blobOid', ''))) \
                or type(row.get('paths')) is not list or not row['paths'] \
                or any(type(relative) is not str for relative in row['paths']) \
                or len(set(row['paths'])) != len(row['paths']) \
                or any(not CONTROLLED.fullmatch(relative) or relative not in value['files'] for relative in row['paths']):
            raise ValueError('Invalid original file blob')
    return value


def is_original_file_path(relative, *, project_root=None):
    return type(relative) is str and CONTROLLED.fullmatch(relative) is not None \
        and relative in _catalog(Path(project_root or ROOT).resolve(strict=True))['files']


def read_original_file_bytes(relative, expected_sha256=None, *, project_root=None):
    root = Path(project_root or ROOT).resolve(strict=True)
    registered = _catalog(root)
    if type(relative) is not str or not CONTROLLED.fullmatch(relative) or relative not in registered['files']:
        raise ValueError('Unregistered original file path')
    sha = registered['files'][relative]['defaultSha256'] if expected_sha256 is None else expected_sha256
    if type(sha) is not str or not SHA.fullmatch(sha) or relative not in registered['blobs'].get(sha, {}).get('paths', []):
        raise ValueError('Unregistered original file path/SHA256')
    return read_git_blob(root, registered['blobs'][sha]['blobOid'], sha)
