import hashlib
import importlib.util
import io
import os
import subprocess
import sys
import tempfile
import tarfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
SPEC = importlib.util.spec_from_file_location('conference_git_execution', ROOT / 'scripts' / 'publish-conference.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
REAL_LOAD_PUBLISHER = M.load_publish_to_blog


def completed(stdout=b'', stderr=b'', code=0, **extra):
    return SimpleNamespace(stdout=stdout, stderr=stderr, returncode=code,
                           timed_out=False, output_truncated=False, **extra)


class ConferenceGitExecutionTest(unittest.TestCase):
    def setUp(self):
        M._git_process_runtime.cache_clear()
        self.runtime = SimpleNamespace(
            GIT_LOCAL_TIMEOUT_SECONDS=30, GIT_COMMIT_TIMEOUT_SECONDS=180, GIT_NETWORK_TIMEOUT_SECONDS=180,
            _bounded_positive_seconds=mock.Mock(side_effect=lambda name, default, low, high: default),
            _run_bounded_subprocess=mock.Mock(return_value=completed()), BLOG_REPO='unchanged')
        self.loader = mock.patch.object(M, 'load_publish_to_blog', return_value=self.runtime)
        self.load = self.loader.start()
        self.addCleanup(self.loader.stop)
        self.addCleanup(M._git_process_runtime.cache_clear)

    def test_completed_process_text_newlines_cwd_env_and_cached_loader(self):
        self.runtime._run_bounded_subprocess.return_value = completed('中文\r\n第二\r末'.encode(), b'err\r\n')
        result = M.git('/repo', 'status', check=False)
        self.assertIsInstance(result, subprocess.CompletedProcess)
        self.assertEqual(result.stdout, '中文\n第二\n末')
        self.assertEqual(result.stderr, 'err\n')
        result.check_returncode()
        M.git('/repo', 'commit', '-m', 'fixture')
        M.git('/repo', 'ls-remote', 'origin')
        self.assertEqual(self.load.call_count, 1)
        self.assertEqual(self.runtime.BLOG_REPO, 'unchanged')
        calls = self.runtime._run_bounded_subprocess.call_args_list
        self.assertEqual([call.kwargs['timeout_seconds'] for call in calls], [30, 180, 180])
        for call in calls:
            self.assertEqual(call.kwargs['cwd'], M.ROOT)
            self.assertEqual(call.kwargs['env'], M.build_child_process_env(allowed_keys=M.VCS_CHILD_ENV_KEYS))
            self.assertFalse(call.kwargs['text'])
            self.assertFalse(call.kwargs['check'])
            self.assertEqual(call.kwargs['max_output_bytes'], 128 * 1024 * 1024)

    def test_binary_blob_and_strict_locale_decode(self):
        value = b'\x89PNG\x00\r\n\xffno-final-newline'
        self.runtime._run_bounded_subprocess.return_value = completed(value)
        self.assertEqual(M.git('/repo', 'show', 'HEAD:image.png', binary=True).stdout, value)
        self.assertEqual(M.blob_sha('/repo', 'HEAD', 'image.png'), hashlib.sha256(value).hexdigest())
        with self.assertRaises(UnicodeDecodeError):
            M.git('/repo', 'show', 'HEAD:image.png')

    def test_archive_has_its_own_budget_without_changing_blob_local_or_commit(self):
        for command, kind, seconds, low, high, cap in (
                ('archive', 'ARCHIVE', 180, 10, 900, 1024),
                ('show', 'LOCAL', 30, 5, 300, 128),
                ('commit', 'COMMIT', 180, 10, 900, 128)):
            M.git('/repo', command, binary=True)
            self.runtime._bounded_positive_seconds.assert_called_with(
                f'PD_GIT_{kind}_TIMEOUT_SECONDS', seconds, low, high)
            self.assertEqual(self.runtime._run_bounded_subprocess.call_args.kwargs['max_output_bytes'],
                             cap * 1024 * 1024)
        real = REAL_LOAD_PUBLISHER()
        with mock.patch.dict(os.environ, {'PD_GIT_ARCHIVE_TIMEOUT_SECONDS': '901',
                                        'PD_GIT_COMMIT_TIMEOUT_SECONDS': '11'}):
            self.assertEqual(real._bounded_positive_seconds('PD_GIT_ARCHIVE_TIMEOUT_SECONDS', 180, 10, 900), 900)
            self.assertEqual(real._bounded_positive_seconds('PD_GIT_COMMIT_TIMEOUT_SECONDS', 180, 10, 900), 11)
        with mock.patch.dict(os.environ, {'PD_GIT_ARCHIVE_TIMEOUT_SECONDS': '1'}):
            self.assertEqual(real._bounded_positive_seconds('PD_GIT_ARCHIVE_TIMEOUT_SECONDS', 180, 10, 900), 10)

    def test_real_small_git_archive_keeps_binary_tar_and_original_member_bytes(self):
        self.load.return_value = REAL_LOAD_PUBLISHER()
        original = b'\x89PNG\x00\r\n\xffno-final-newline'
        with tempfile.TemporaryDirectory(prefix='conference-small-archive-') as directory:
            M.git(directory, 'init', '-b', 'main')
            for key, value in (('user.name', 'Archive fixture'), ('user.email', 'fixture@example.invalid'),
                               ('commit.gpgsign', 'false'), ('core.autocrlf', 'false')):
                M.git(directory, 'config', key, value)
            (Path(directory) / 'image.bin').write_bytes(original)
            M.git(directory, 'add', '--', 'image.bin')
            M.git(directory, 'commit', '-m', 'local bounded archive fixture')
            raw = M.git(directory, 'archive', '--format=tar', 'HEAD', binary=True).stdout
            with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
                self.assertEqual([member.name for member in archive.getmembers()], ['image.bin'])
                self.assertEqual(archive.extractfile('image.bin').read(), original)
            self.assertEqual(M.blob_sha(directory, 'HEAD', 'image.bin'), hashlib.sha256(original).hexdigest())

    def test_check_false_preserves_only_ordinary_nonzero(self):
        self.runtime._run_bounded_subprocess.return_value = completed(b'no', code=128)
        result = M.git('/repo', 'rev-parse', 'missing', check=False)
        self.assertEqual(result.returncode, 128)
        with self.assertRaises(subprocess.CalledProcessError):
            result.check_returncode()
        with self.assertRaises(M.ConferencePublicationError):
            M.git('/repo', 'rev-parse', 'missing')
        with self.assertRaisesRegex(M.ConferencePublicationError, 'blob 不可读'):
            M.blob_sha('/repo', 'HEAD', 'missing')

    def test_timeout_truncation_signal_invalid_status_never_hash_even_check_false(self):
        for field, value in [('timed_out', True), ('output_truncated', True),
                             ('returncode', -15), ('returncode', None), ('returncode', False)]:
            with self.subTest(field=field, value=value):
                raw = completed(b'a' * 40)
                setattr(raw, field, value)
                self.runtime._run_bounded_subprocess.return_value = raw
                with self.assertRaises(M.ConferencePublicationError):
                    M.git('/repo', 'show', 'HEAD:file', check=False)
                with mock.patch.object(M, 'sha_bytes') as hash_bytes:
                    with self.assertRaises(M.ConferencePublicationError):
                        M.blob_sha('/repo', 'HEAD', 'file')
                    hash_bytes.assert_not_called()
        self.runtime._run_bounded_subprocess.side_effect = OSError('secret remote')
        with self.assertRaisesRegex(M.ConferencePublicationError, '^Git 子进程无法完整执行$'):
            M.git('/repo', 'status', check=False)

    def test_actual_shared_executor_short_timeout_and_output_cap(self):
        # 使用真实日更执行器；仅超时分支缩短期限，输出cap分支保留正常本地预算。
        runtime = REAL_LOAD_PUBLISHER()
        timeout = [0.08]
        self.runtime._bounded_positive_seconds.side_effect = lambda *args: timeout[0]
        original = runtime._run_bounded_subprocess
        observations = []
        def run(command, **kwargs):
            kwargs['max_output_bytes'] = 64
            result = original(command, **kwargs)
            observations.append(result)
            return result
        self.runtime._run_bounded_subprocess.side_effect = run
        with tempfile.TemporaryDirectory(prefix='conference-fake-git-') as directory:
            executable = Path(directory) / 'git'
            # 受控延迟只复现旧2s将输出cap检查混为超时；不代表原机器的启动耗时。
            executable.write_text(f'#!{sys.executable}\nimport sys,time\n'
                                  'if "slow" in sys.argv: time.sleep(10)\n'
                                  'else:\n time.sleep(2.1)\n sys.stdout.buffer.write(b"a"*4096)\n')
            executable.chmod(0o700)
            env = dict(os.environ, PATH=directory)
            with mock.patch.object(M, 'build_child_process_env', return_value=env):
                for operation in ('slow', 'large'):
                    with self.subTest(operation=operation), self.assertRaises(M.ConferencePublicationError):
                        timeout[0] = 0.08 if operation == 'slow' else runtime.GIT_LOCAL_TIMEOUT_SECONDS
                        M.git(directory, operation, check=False)
        self.assertTrue(observations[0].timed_out)
        self.assertFalse(observations[0].output_truncated)
        self.assertFalse(observations[1].timed_out)
        self.assertTrue(observations[1].output_truncated)


if __name__ == '__main__':
    unittest.main()
