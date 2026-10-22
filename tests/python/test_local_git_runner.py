"""Real inert OS processes test private IO mechanics, never Git qualification."""
import importlib
import contextlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))


class LocalGitRunnerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='local-git-runner-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.env = {'PATH': '/usr/bin:/bin', 'HOME': str(self.root), 'LANG': 'C', 'LC_ALL': 'C'}

    def module(self):
        return importlib.import_module('local_git_object')

    def invoke(self, code, *, stdout_limit=1024, stderr_limit=1024, seconds=2, timeout=1):
        return self.module()._run_bounded(
            [sys.executable, '-I', '-c', code], cwd=str(self.root), env=self.env,
            stdout_limit=stdout_limit, stderr_limit=stderr_limit,
            deadline=time.monotonic() + seconds, command_timeout=timeout)

    def test_actual_process_binary_stdout_and_bounded_stderr(self):
        code = "import os; os.write(1, b'raw\\x00\\xff\\n'); os.write(2, b'inert stderr\\n')"
        control = subprocess.run([sys.executable, '-I', '-c', code], cwd=self.root,
                                 env=self.env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=2)
        self.assertEqual(control.stdout, b'raw\x00\xff\n')
        self.assertEqual(control.stderr, b'inert stderr\n')
        self.assertEqual(self.invoke(code), (0, control.stdout))

    @contextlib.contextmanager
    def watchdog(self):
        previous = signal.getsignal(signal.SIGALRM)
        timer = signal.getitimer(signal.ITIMER_REAL)

        def expired(_signum, _frame):
            raise AssertionError('Private runner exceeded the independent five-second watchdog')

        signal.signal(signal.SIGALRM, expired)
        signal.setitimer(signal.ITIMER_REAL, 5)
        try:
            yield
        finally:
            signal.setitimer(signal.ITIMER_REAL, *timer)
            signal.signal(signal.SIGALRM, previous)

    def test_nonzero_exit_is_not_rewritten_as_success(self):
        self.assertEqual(self.invoke("import os; os.write(1,b'partial'); os.write(2,b'inert'); raise SystemExit(7)"),
                         (7, b'partial'))
        # A known failed leader must not wait for a live descendant's pipe EOF.
        # The rc0 descendant-held-pipe deadline case below remains unchanged.
        ready = self.root / 'nonzero-ready.json'
        ticks = self.root / 'nonzero-ticks'
        code = (
            'import json,os,pathlib,signal,time\n'
            'leader=os.getpid()\n'
            'os.write(1,b"failed-leader")\n'
            'child=os.fork()\n'
            'if child==0:\n'
            ' signal.signal(signal.SIGTERM,signal.SIG_IGN)\n'
            ' pathlib.Path(' + repr(str(ready)) + ').write_text(json.dumps({"leader":leader,"child":os.getpid(),"pgid":os.getpgrp()}))\n'
            ' with open(' + repr(str(ticks)) + ',"ab",buffering=0) as output:\n'
            '  while True:\n   output.write(b"tick\\n"); time.sleep(0.01)\n'
            'until=time.monotonic()+1\n'
            'while not pathlib.Path(' + repr(str(ticks)) + ').exists() and time.monotonic()<until:\n time.sleep(0.002)\n'
            'os._exit(7)\n')
        try:
            start = time.monotonic()
            with self.watchdog():
                result = self.invoke(code, seconds=1.5, timeout=2)
            self.assertEqual(result, (7, b'failed-leader'))
            self.assertLess(time.monotonic() - start, 1.0, 'Known nonzero must not wait until its pipe deadline')
            self.assertTrue(ready.exists() and ticks.exists(), 'Parent and child must reach the real handshake')
            info = json.loads(ready.read_text())
            self.assertEqual(info['leader'], info['pgid'])
            self.assertNotEqual(info['pgid'], os.getpgrp())
            before = ticks.read_bytes()
            self.assertTrue(before)
            time.sleep(0.06)
            self.assertEqual(ticks.read_bytes(), before)
            state = subprocess.run(['/bin/ps', '-o', 'stat=', '-p', str(info['child'])],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1)
            self.assertTrue(state.returncode != 0 or all(line.lstrip().startswith(b'Z')
                            for line in state.stdout.splitlines()), state.stdout)
        finally:
            if ready.exists():
                info = json.loads(ready.read_text())
                try:
                    if info['pgid'] != os.getpgrp():
                        os.killpg(info['pgid'], signal.SIGKILL)
                    else:
                        os.kill(info['child'], signal.SIGKILL)
                except ProcessLookupError:
                    pass
                except PermissionError:
                    # macOS may deny a second signal to an already orphaned
                    # zombie group. Accept only an independently nonrunning PID.
                    state = subprocess.run(['/bin/ps', '-o', 'stat=', '-p', str(info['child'])],
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1)
                    self.assertTrue(state.returncode != 0 or all(line.lstrip().startswith(b'Z')
                                    for line in state.stdout.splitlines()), state.stdout)

    def test_stdout_and_stderr_are_bounded_while_an_unfinished_process_is_writing(self):
        module = self.module()
        for fd, reason in ((1, 'stdout_bytes'), (2, 'stderr_bytes')):
            code = ('import os\n'
                    'chunk=b"fixture-secret-do-not-return-"+b"x"*4096\n'
                    'while True:\n os.write(' + str(fd) + ',chunk)\n')
            before = time.monotonic()
            with self.subTest(fd=fd), self.watchdog(), self.assertRaises(module.LocalGitReadError) as error:
                self.invoke(code, seconds=2, timeout=2)
            self.assertEqual(error.exception.code, 'output_limit')
            self.assertEqual(error.exception.reason, reason)
            self.assertNotIn('fixture-secret', str(error.exception))
            self.assertLess(time.monotonic() - before, 3)

    def test_both_pipes_can_make_progress_without_a_single_pipe_deadlock(self):
        code = ('import os\n'
                'for _ in range(64):\n os.write(1,b"a"*1024); os.write(2,b"b"*1024)\n')
        with self.watchdog():
            self.assertEqual(self.invoke(code, stdout_limit=65536, stderr_limit=65536),
                             (0, b'a' * 65536))

    def test_command_and_shared_deadline_are_both_enforced(self):
        module = self.module()
        for seconds, timeout in ((0.2, 2), (2, 0.2)):
            code = ('import pathlib,time\n'
                    'pathlib.Path("started").write_text("ready")\n'
                    'time.sleep(20)\n')
            before = time.monotonic()
            with self.subTest(seconds=seconds, timeout=timeout), self.watchdog(), \
                    self.assertRaises(module.LocalGitReadError) as error:
                self.invoke(code, seconds=seconds, timeout=timeout)
            self.assertTrue((self.root / 'started').exists(), 'The child must reach its real handshake')
            self.assertEqual(error.exception.code, 'timeout')
            self.assertEqual(error.exception.reason, 'child_deadline')
            self.assertLess(time.monotonic() - before, 2)
            (self.root / 'started').unlink()

    def test_timeout_kills_the_known_group_even_after_its_leader_exits(self):
        module = self.module()
        for leader_exits in (False, True):
            ready = self.root / ('ready-' + str(leader_exits) + '.json')
            ticks = self.root / ('ticks-' + str(leader_exits))
            code = (
                'import json,os,pathlib,signal,time\n'
                'leader=os.getpid()\n'
                'pid=os.fork()\n'
                'if pid==0:\n'
                ' signal.signal(signal.SIGTERM,signal.SIG_IGN)\n'
                ' pathlib.Path(' + repr(str(ready)) + ').write_text(json.dumps({"leader":leader,"child":os.getpid(),"pgid":os.getpgrp()}))\n'
                ' with open(' + repr(str(ticks)) + ',"ab",buffering=0) as output:\n'
                '  while True:\n   output.write(b"tick\\n"); time.sleep(0.01)\n'
                'signal.signal(signal.SIGTERM,signal.SIG_IGN)\n'
                'until=time.monotonic()+2\n'
                'while not pathlib.Path(' + repr(str(ready)) + ').exists() and time.monotonic()<until:\n time.sleep(0.005)\n'
                + ('os._exit(0)\n' if leader_exits else 'while True:\n time.sleep(20)\n'))
            try:
                with self.subTest(leader_exits=leader_exits), self.watchdog(), \
                        self.assertRaises(module.LocalGitReadError) as error:
                    self.invoke(code, seconds=0.8, timeout=2)
                self.assertTrue(ready.exists(), 'Both parent/child phases need a real handshake')
                self.assertTrue(ticks.exists())
                info = json.loads(ready.read_text())
                self.assertEqual(info['pgid'], info['leader'], 'Child must remain in the runner-owned session')
                self.assertNotEqual(info['pgid'], os.getpgrp())
                self.assertEqual(error.exception.code, 'timeout')
                before = ticks.read_bytes()
                self.assertTrue(before)
                time.sleep(0.06)
                self.assertEqual(ticks.read_bytes(), before, 'A terminated child must stop its independent file writes')
                state = subprocess.run(['/bin/ps', '-o', 'stat=', '-p', str(info['child'])],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1)
                self.assertTrue(state.returncode != 0 or all(line.lstrip().startswith(b'Z')
                                for line in state.stdout.splitlines()), state.stdout)
            finally:
                if ready.exists():
                    info = json.loads(ready.read_text())
                    try:
                        if info['pgid'] != os.getpgrp():
                            os.killpg(info['pgid'], signal.SIGKILL)
                        else:
                            os.kill(info['child'], signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_start_failure_uses_a_fixed_typed_error_without_raw_path(self):
        module = self.module()
        path = self.root / 'fixture-secret-missing-executable'
        with self.assertRaises(module.LocalGitReadError) as error:
            module._run_bounded([str(path)], cwd=str(self.root), env=self.env,
                                stdout_limit=1024, stderr_limit=1024,
                                deadline=time.monotonic() + 1, command_timeout=1)
        self.assertEqual((error.exception.code, error.exception.reason), ('read_error', 'process_start'))
        self.assertNotIn('fixture-secret', str(error.exception))

    def test_simultaneous_overflow_is_finite_and_never_returns_partial_output(self):
        module = self.module()
        code = ('import os\n'
                'while True:\n os.write(1,b"a"*512); os.write(2,b"b"*512)\n')
        with self.watchdog(), self.assertRaises(module.LocalGitReadError) as error:
            self.invoke(code, stdout_limit=1024, stderr_limit=1024)
        self.assertEqual(error.exception.code, 'output_limit')
        self.assertIn(error.exception.reason, ('stdout_bytes', 'stderr_bytes'))


if __name__ == '__main__':
    unittest.main()
