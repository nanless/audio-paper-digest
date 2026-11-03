"""Read exact file/Git bytes without executing them or granting workflow authority."""
import hashlib
import os
from pathlib import Path
import re
import stat
import subprocess

LIMIT = 8 * 1024 * 1024


def read_regular_bytes(filename):
    filename = Path(filename)
    if filename.resolve(strict=True) != filename:
        raise ValueError('Evidence forbids symlink paths')
    descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > LIMIT:
            raise ValueError('Evidence requires a bounded single-link regular file')
        with os.fdopen(os.dup(descriptor), 'rb') as handle:
            data = handle.read(LIMIT + 1)
        after = os.fstat(descriptor)
        named = filename.lstat()
        keys = ('st_dev', 'st_ino', 'st_size', 'st_nlink', 'st_mtime_ns', 'st_ctime_ns')
        if any(getattr(before, key) != getattr(after, key) for key in keys) \
                or (named.st_dev, named.st_ino) != (after.st_dev, after.st_ino) \
                or filename.resolve(strict=True) != filename or len(data) != before.st_size:
            raise ValueError('Evidence changed during reading')
        return data
    finally:
        os.close(descriptor)


def read_git_blob(root, blob_oid, sha256):
    if not re.fullmatch(r'(?:[a-f0-9]{40}|[a-f0-9]{64})', str(blob_oid or '')) \
            or not re.fullmatch(r'[a-f0-9]{64}', str(sha256 or '')):
        raise ValueError('Invalid original Git blob identity')
    environment = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    environment.update(GIT_TERMINAL_PROMPT='0', GIT_NO_LAZY_FETCH='1', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null')
    command = ['git', '--no-lazy-fetch', '--no-replace-objects', '-C', str(root), 'cat-file']
    try:
        raw_size = subprocess.run(command + ['-s', blob_oid], env=environment, capture_output=True,
                                  timeout=10, check=True).stdout.strip()
        if len(raw_size) > 20 or not raw_size.isdigit() or int(raw_size) > LIMIT:
            raise ValueError('Original Git blob exceeds evidence size budget')
        size = int(raw_size)
        result = subprocess.run(command + ['blob', blob_oid], env=environment,
                                capture_output=True, timeout=10, check=True)
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError('Original Git object unavailable; restore repository history') from error
    if len(result.stdout) != size or hashlib.sha256(result.stdout).hexdigest() != sha256:
        raise ValueError('Original Git bytes do not match the original SHA256')
    return result.stdout
