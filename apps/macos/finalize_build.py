"""Publish a verified local build and optionally replace its per-user installation."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


APP_NAME = '论文速递工作台.app'
REGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'


@contextmanager
def output_lock(directory):
    # Keep the lock inode stable across builds. The kernel releases it on exit.
    descriptor = os.open(directory / '.paperdigest-build.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'r+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def require_closed(bundle=None):
    running = subprocess.run(['/usr/bin/pgrep', '-x', 'PaperDigest'], capture_output=True, text=True)
    if running.returncode not in (0, 1):
        raise RuntimeError('无法确认工作台是否正在运行')
    for pid in running.stdout.split():
        if bundle is not None:
            process = subprocess.run(['/bin/ps', '-p', pid, '-o', 'comm='], capture_output=True, text=True)
            if process.stdout.strip() != str(bundle / 'Contents/MacOS/PaperDigest'):
                continue
        raise RuntimeError(f'论文速递工作台仍在运行（PID {pid}），请先保存并正常退出。')


def replace_bundle(candidate, target, previous, validate):
    if target.is_symlink() or (target.exists() and not target.is_dir()):
        raise RuntimeError(f'应用目标不是普通目录：{target}')
    if previous.exists() or previous.is_symlink():
        raise RuntimeError(f'已有待核对的旧应用：{previous}')
    had_previous = target.exists()
    if had_previous:
        target.rename(previous)
    try:
        candidate.rename(target)
        try:
            validate(target)
        except BaseException:
            target.rename(candidate)
            raise
    except BaseException:
        if had_previous:
            previous.rename(target)
        raise


def write_history(bundle, history):
    metadata = (bundle / 'Contents/Resources/build-metadata.json').read_bytes()
    marker = json.loads(metadata)
    binary = bundle / 'Contents/MacOS/PaperDigest'
    record = {
        'contract': 'paper-digest-mac-signed-build-v1',
        'builtAt': marker['builtAt'],
        'bundlePath': str(bundle),
        'sourceCommit': marker['sourceCommit'],
        'architecture': marker['architecture'],
        'signing': marker['signing'],
        'buildMetadataSHA256': hashlib.sha256(metadata).hexdigest(),
        'binary': {
            'path': 'Contents/MacOS/PaperDigest',
            'bytes': binary.stat().st_size,
            'sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
        },
    }
    history.mkdir(parents=True, exist_ok=True)
    name = marker['builtAt'].replace(':', '-').replace('+', '_')
    destination = history / name
    with tempfile.TemporaryDirectory(prefix='.record-', dir=history) as temp:
        receipt = Path(temp) / 'receipt'
        receipt.mkdir()
        (receipt / 'build-metadata.json').write_bytes(metadata)
        (receipt / 'signed-build.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
        if destination.exists():
            raise FileExistsError(destination)
        receipt.rename(destination)
    print(f'本次源码与已签名程序校验记录：{destination}')


def install_bundle(source, applications):
    applications.mkdir(parents=True, exist_ok=True)
    destination = applications / APP_NAME
    with output_lock(applications):
        require_closed()
        # Keep recovery material on exceptional failures. A successful install
        # removes the old bundle only after Launch Services accepts the new one.
        work = Path(tempfile.mkdtemp(prefix='.paper-digest-install.', dir=applications))
        candidate = work / APP_NAME
        subprocess.run(['/usr/bin/ditto', str(source), str(candidate)], check=True)
        subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(candidate)], check=True)
        require_closed()
        replace_bundle(candidate, destination, work / 'previous.app',
                       lambda target: subprocess.run([REGISTER, '-f', str(target)], check=True))
        shutil.rmtree(work)
    print(f'已安装：{destination}')


def finalize(work, history, applications=None):
    candidate = work / APP_NAME
    target = work.parent / APP_NAME
    if applications is not None:
        marker = json.loads((candidate / 'Contents/Resources/build-metadata.json').read_bytes())
        if marker.get('distributionChannel') != 'release':
            raise RuntimeError('只允许安装正式通道的构建')
    with output_lock(work.parent):
        require_closed(target)
        replace_bundle(candidate, target, work / 'previous-build.app',
                       lambda bundle: write_history(bundle, history))
        print(f'构建与签名检查通过：{target}')
        print('这是本机开发签名，尚未经过 Apple 公证。')
        if applications is not None:
            install_bundle(target, applications)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('work', type=Path)
    parser.add_argument('history', type=Path)
    parser.add_argument('--applications', type=Path)
    args = parser.parse_args()
    try:
        finalize(args.work, args.history, args.applications)
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'构建或安装未完成：{error}\n构建材料：{args.work}\n')
