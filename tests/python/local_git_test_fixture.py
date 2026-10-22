"""System-temp Git preparation only; no normal/publication qualification."""
import hashlib
import os
from pathlib import Path
import shutil
import stat
import subprocess


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def git_environment(home):
    return {'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
            'HOME': str(home), 'TMPDIR': str(home), 'LANG': 'C', 'LC_ALL': 'C',
            'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_SYSTEM': '/dev/null',
            'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0'}


def git(repo, *args, data=None, environment=None, check=True):
    executable = shutil.which('git', path='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')
    result = subprocess.run([executable, *args], cwd=repo,
                            env=environment or git_environment(repo.parent), input=data,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
    if check and result.returncode:
        raise AssertionError('Temp Git preparation failed: ' + result.stderr.decode('utf-8', 'replace'))
    return result


def inventory(root):
    rows = {}
    for path in sorted(root.rglob('*')):
        meta = path.lstat()
        name = path.relative_to(root).as_posix()
        if stat.S_ISREG(meta.st_mode):
            raw = path.read_bytes()
            rows[name] = (stat.S_IMODE(meta.st_mode), len(raw), sha(raw))
        elif stat.S_ISLNK(meta.st_mode):
            rows[name] = ('symlink', os.readlink(path))
    return rows


def object_oid(kind, raw):
    return hashlib.sha1(kind.encode('ascii') + b' ' + str(len(raw)).encode('ascii')
                        + bytes([0]) + raw).hexdigest()


def create_repo(root):
    repo = root / 'repo'
    template = root / 'empty-template'
    template.mkdir(exist_ok=True)
    git(root, 'init', '--initial-branch=main', '--template=' + str(template), str(repo))
    git(repo, 'config', 'user.name', 'Mechanical Fixture')
    git(repo, 'config', 'user.email', 'fixture@example.invalid')
    git(repo, 'config', 'gc.auto', '0')
    path = repo / '中文 tree' / 'name with space.bin'
    path.parent.mkdir()
    path.write_bytes(b'actual binary\x00\xff\nsecond line\r\n')
    git(repo, 'add', '--', '.')
    git(repo, 'commit', '-m', 'Isolated mechanical raw objects')
    oid = git(repo, 'rev-parse', 'HEAD').stdout.decode().strip()
    tree = git(repo, 'rev-parse', 'HEAD^{tree}').stdout.decode().strip()
    blob = git(repo, 'rev-parse', 'HEAD:中文 tree/name with space.bin').stdout.decode().strip()
    objects = {}
    for kind, value in (('commit', oid), ('tree', tree), ('blob', blob)):
        raw = git(repo, 'cat-file', kind, value).stdout
        if object_oid(kind, raw) != value:
            raise AssertionError('Actual fixture raw object OID mismatch')
        objects[kind] = (value, raw)
    return repo, objects


def create_promisor(root, source, blob_oid, *, name='partial', fill_blob=False):
    bare = root / (name + '-remote.git')
    git(root, 'clone', '--bare', str(source), str(bare))
    git(bare, 'config', 'uploadpack.allowFilter', 'true')
    partial = root / name
    git(root, '-c', 'protocol.file.allow=always', 'clone', '--filter=blob:none',
        '--no-checkout', '--no-local', bare.as_uri(), str(partial))
    if not list((partial / '.git/objects/pack').glob('*.promisor')):
        raise AssertionError('Actual partial clone lacks .promisor pack')
    listed = git(partial, '--no-lazy-fetch', 'cat-file', '--batch-all-objects', '--batch-check').stdout
    if blob_oid.encode() in [line.split()[0] for line in listed.splitlines()]:
        raise AssertionError('Promisor target blob was already local')
    if fill_blob:
        target = partial / '.git/objects' / blob_oid[:2] / blob_oid[2:]
        target.parent.mkdir(exist_ok=True)
        shutil.copyfile(source / '.git/objects' / blob_oid[:2] / blob_oid[2:], target)
    log = root / (name + '-canary.log')
    command = root / (name + '-canary.sh')
    command.write_text('#!/bin/sh\nprintf "entered\\n" >> "' + str(log) + '"\nexit 73\n')
    command.chmod(0o700)
    git(partial, 'config', 'remote.origin.url', 'ext::' + str(command))
    return partial, log
