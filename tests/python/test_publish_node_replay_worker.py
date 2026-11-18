"""Unit and security tests for persistent Node JSON-RPC replay worker and Python client."""

import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
if str(ROOT / 'tests' / 'python') not in sys.path:
    sys.path.insert(0, str(ROOT / 'tests' / 'python'))

import protocol_codec
import publication_local_replay
import publish_node_replay_client as replay_client
import test_reader_sealed_author_publication_parent as sealed_fixture
from test_publish_to_blog import publish_to_blog as publisher


def _pid_alive(pid):
    if pid is None or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _valid_core_summary():
    code = (
        "const c = require('./scripts/analysis-contract');"
        "const f = require('./tests/valid-analysis-fixture');"
        "process.stdout.write(c.extractSection(f.validAnalysisText(), '核心摘要'));"
    )
    return subprocess.check_output(['node', '-e', code], cwd=str(ROOT), text=True)


class PublishNodeReplayWorkerPythonTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.node = shutil.which('node')
        if not cls.node:
            raise unittest.SkipTest('Node.js is required')
        cls.valid_summary = _valid_core_summary()

    def setUp(self):
        replay_client.shutdown_all_workers()

    def tearDown(self):
        replay_client.shutdown_all_workers()

    def _base_env(self, **extra):
        env = {
            k: v
            for k, v in os.environ.items()
            if k not in {'NODE_OPTIONS', 'NODE_PATH', 'PD_DISABLE_NODE_REPLAY_WORKER'}
        }
        env['VERIFY_PROJECT_DISABLE_FILE_LOGS'] = '1'
        env.update(extra)
        return env

    def test_worker_reuses_process_and_matches_standalone_cli_and_cold_rereads_disk(self):
        with tempfile.TemporaryDirectory(prefix='worker-cold-reread-') as tmp:
            maker = sealed_fixture.SealedAuthorPublicationParentTest()
            run_dir, paper, runtime_path = maker.create_sample(Path(tmp).resolve())
            spawned_before = replay_client.total_spawned_workers()

            def validate_with_batch():
                with publisher._reader_author_replay_batch_scope():
                    publisher._daily_fresh_validate_bundle(
                        run_dir, '2610.12345', paper['freshRewriteProvenance'], paper
                    )

            # First full validation through real publisher -> spawns 1 persistent worker
            validate_with_batch()
            self.assertEqual(replay_client.total_spawned_workers(), spawned_before + 1)
            spawned_after_first = replay_client.total_spawned_workers()
            self.assertEqual(replay_client.idle_worker_count(), 1)

            # Second identical validation reuses the exact same warm worker without spawning
            validate_with_batch()
            self.assertEqual(replay_client.total_spawned_workers(), spawned_after_first)

            # Mutate physical source.txt in temp dir and call Node reader-dom-span-replay-cli.js
            # directly via run_node_replay_request on the SAME warm worker to prove Node itself
            # cold-reads sealed files on every request without stale in-memory source caching.
            dom_cli = SCRIPTS / 'lib' / 'reader-dom-span-replay-cli.js'
            dom_payload = json.dumps(
                {
                    'paper': paper,
                    'article': paper.get('apiReaderArticle') or '| A | B |\n|---|---|\n| 1 | 2 |\n',
                    'sealedBundleRoot': str(run_dir / 'sources'),
                },
                separators=(',', ':'),
            ).encode('utf-8')

            for filename in ('source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json'):
                target_file = runtime_path.parent / filename
                original_bytes = target_file.read_bytes()
                os.chmod(target_file, 0o600)
                target_file.write_bytes(original_bytes + b' ')
                try:
                    with self.assertRaises(publisher.PublishDataValidationError):
                        validate_with_batch()
                    tampered_node = replay_client.run_node_replay_request(
                        node=self.node,
                        cli_path=dom_cli,
                        payload=dom_payload,
                        cwd=str(ROOT),
                        env=self._base_env(),
                        timeout_seconds=30,
                        max_output_bytes=64 * 1024,
                    )
                    self.assertEqual(tampered_node.returncode, 1, filename)
                    self.assertEqual(tampered_node.stdout, '{"keys":[]}', filename)
                    self.assertEqual(replay_client.total_spawned_workers(), spawned_after_first)
                finally:
                    target_file.write_bytes(original_bytes)

            # Restored bytes pass again on the exact same warm worker
            validate_with_batch()
            self.assertEqual(replay_client.total_spawned_workers(), spawned_after_first)

    def test_timeout_and_render_deadline_sigkill_worker_group_and_respawn_cleanly(self):
        with tempfile.TemporaryDirectory(prefix='worker-timeout-test-') as tmp:
            isolated_lib = Path(tmp) / 'scripts' / 'lib'
            isolated_lib.mkdir(parents=True)
            # Create a self-contained worker + slow CLI fixture in isolated temp dir
            # that records its PID + child sleeper PID, then blocks so timeout & SIGALRM are tested.
            pid_record = Path(tmp) / 'pids.json'
            (Path(tmp) / 'scripts' / 'env-loader.js').write_text(
                "'use strict'; module.exports = { requireExternalRuntime() {} };\n",
                encoding='utf-8',
            )
            shutil.copy2(SCRIPTS / 'lib' / 'publish-node-replay-worker.js', isolated_lib / 'publish-node-replay-worker.js')
            slow_cli = isolated_lib / 'core-summary-semantic-replay-cli.js'
            slow_cli.write_text(
                f"""'use strict';
const fs = require('node:fs');
const {{ spawn }} = require('node:child_process');
function formatReplayError(e) {{ return {{ exitCode: 1, stdout: JSON.stringify({{ issue: String(e.message || e) }}) }}; }}
async function runReplayFd(fd) {{
    const input = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (input.hang) {{
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {{}}, 1000)'], {{ stdio: 'ignore' }});
        fs.writeFileSync({json.dumps(str(pid_record))}, JSON.stringify({{ workerPid: process.pid, childPid: child.pid }}));
        await new Promise(resolve => setTimeout(resolve, 60000));
    }}
    return {{ exitCode: 0, stdout: JSON.stringify({{ issue: null, pid: process.pid }}) }};
}}
module.exports = {{ runReplayFd, formatReplayError }};
""",
                encoding='utf-8',
            )

            # 1. Per-request timeout_seconds -> timed_out=True, nonzero returncode & entire process group SIGKILLed
            res_timeout = replay_client.run_node_replay_request(
                node=self.node,
                cli_path=slow_cli,
                payload=b'{"hang":true}',
                cwd=tmp,
                env=self._base_env(),
                timeout_seconds=0.35,
                max_output_bytes=64 * 1024,
            )
            self.assertTrue(res_timeout.timed_out)
            self.assertNotEqual(res_timeout.returncode, 0)
            self.assertFalse(res_timeout.output_truncated)
            self.assertEqual(replay_client.idle_worker_count(), 0)
            recorded = json.loads(pid_record.read_text(encoding='utf-8'))
            time.sleep(0.05)
            self.assertFalse(_pid_alive(recorded['workerPid']))
            self.assertFalse(_pid_alive(recorded['childPid']))

            # Next request respawns cleanly and succeeds
            res_recovered = replay_client.run_node_replay_request(
                node=self.node,
                cli_path=slow_cli,
                payload=b'{"hang":false}',
                cwd=tmp,
                env=self._base_env(),
                timeout_seconds=10,
                max_output_bytes=64 * 1024,
            )
            self.assertFalse(res_recovered.timed_out)
            self.assertEqual(res_recovered.returncode, 0)
            recovered_data = json.loads(res_recovered.stdout)
            self.assertIsNone(recovered_data['issue'])
            self.assertNotEqual(recovered_data['pid'], recorded['workerPid'])

            # 2. RenderDeadlineExceeded via render_process_guard SIGALRM kills worker group and re-raises
            pid_record.unlink()
            with self.assertRaises(publication_local_replay.RenderDeadlineExceeded):
                with publication_local_replay.render_process_guard(0.35):
                    replay_client.run_node_replay_request(
                        node=self.node,
                        cli_path=slow_cli,
                        payload=b'{"hang":true}',
                        cwd=tmp,
                        env=self._base_env(),
                        timeout_seconds=30,
                        max_output_bytes=64 * 1024,
                    )
            recorded2 = json.loads(pid_record.read_text(encoding='utf-8'))
            time.sleep(0.05)
            self.assertFalse(_pid_alive(recorded2['workerPid']))
            self.assertFalse(_pid_alive(recorded2['childPid']))
            self.assertEqual(replay_client.idle_worker_count(), 0)

    def test_max_output_bytes_sets_output_truncated_and_recycles_worker(self):
        core_cli = SCRIPTS / 'lib' / 'core-summary-semantic-replay-cli.js'
        bad_payload = json.dumps({'summary': '太短摘要。', 'sourceText': ''}).encode('utf-8')

        full = replay_client.run_node_replay_request(
            node=self.node,
            cli_path=core_cli,
            payload=bad_payload,
            cwd=str(ROOT),
            env=self._base_env(),
            timeout_seconds=30,
            max_output_bytes=64 * 1024,
        )
        self.assertEqual(full.returncode, 0)
        self.assertFalse(full.output_truncated)
        self.assertGreater(len(full.stdout.encode('utf-8')), 16)
        spawned_after_full = replay_client.total_spawned_workers()

        truncated = replay_client.run_node_replay_request(
            node=self.node,
            cli_path=core_cli,
            payload=bad_payload,
            cwd=str(ROOT),
            env=self._base_env(),
            timeout_seconds=30,
            max_output_bytes=8,
        )
        self.assertTrue(truncated.output_truncated)
        self.assertLessEqual(len(truncated.stdout.encode('utf-8')), 8)
        # Worker was recycled on truncation instead of returned to idle pool
        self.assertEqual(replay_client.idle_worker_count(), 0)

        with self.assertRaises(publication_local_replay.LocalReplayFailure) as ctx:
            publication_local_replay.checked_replay_response(
                truncated,
                worker='core-summary-semantic-replay-cli.js',
                timeout_seconds=30,
            )
        self.assertTrue(ctx.exception.output_truncated)

        after_recycle = replay_client.run_node_replay_request(
            node=self.node,
            cli_path=core_cli,
            payload=json.dumps({'summary': self.valid_summary, 'sourceText': ''}).encode('utf-8'),
            cwd=str(ROOT),
            env=self._base_env(),
            timeout_seconds=30,
            max_output_bytes=64 * 1024,
        )
        self.assertEqual(after_recycle.returncode, 0)
        self.assertFalse(after_recycle.output_truncated)
        self.assertEqual(json.loads(after_recycle.stdout), {'issue': None})
        self.assertEqual(replay_client.total_spawned_workers(), spawned_after_full + 1)

    def test_concurrent_8_way_thread_pool_execution_bounds_workers_and_isolates_responses(self):
        core_cli = SCRIPTS / 'lib' / 'core-summary-semantic-replay-cli.js'
        valid_payload = json.dumps({'summary': self.valid_summary, 'sourceText': ''}).encode('utf-8')
        invalid_payload = json.dumps({'summary': '本文很好。', 'sourceText': ''}).encode('utf-8')

        spawned_before = replay_client.total_spawned_workers()

        def run_one(idx):
            is_valid = (idx % 2 == 0)
            res = replay_client.run_node_replay_request(
                node=self.node,
                cli_path=core_cli,
                payload=valid_payload if is_valid else invalid_payload,
                cwd=str(ROOT),
                env=self._base_env(),
                timeout_seconds=30,
                max_output_bytes=64 * 1024,
            )
            return idx, is_valid, res

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            outcomes = list(pool.map(run_one, range(66)))

        spawned_delta = replay_client.total_spawned_workers() - spawned_before
        self.assertGreaterEqual(spawned_delta, 1)
        self.assertLessEqual(spawned_delta, 8)
        self.assertLessEqual(replay_client.idle_worker_count(), replay_client.MAX_IDLE_WORKERS_PER_KEY)

        for idx, is_valid, res in outcomes:
            self.assertEqual(res.returncode, 0, f'item {idx} failed')
            parsed = json.loads(res.stdout)
            if is_valid:
                self.assertIsNone(parsed['issue'])
            else:
                self.assertIsInstance(parsed['issue'], str)

    def test_monkeypatch_and_env_disable_passthrough_and_fingerprint_registration(self):
        core_cli = SCRIPTS / 'lib' / 'core-summary-semantic-replay-cli.js'
        payload = json.dumps({'summary': self.valid_summary, 'sourceText': ''}).encode('utf-8')

        # 1. Monkeypatching publisher._run_bounded_subprocess intercepts exact [node, cli, fd]
        intercepted = []

        def fake_subprocess(cmd, **kwargs):
            intercepted.append((cmd, kwargs))
            return SimpleNamespace(
                args=cmd,
                returncode=0,
                stdout='{"issue":null}',
                stderr='',
                timed_out=False,
                output_truncated=False,
            )

        with mock.patch.object(publisher, '_run_bounded_subprocess', side_effect=fake_subprocess):
            res = publisher._run_node_replay_cli(
                core_cli,
                payload,
                cwd=str(ROOT),
                env=self._base_env(),
                timeout_seconds=30,
                max_output_bytes=64 * 1024,
            )
        self.assertEqual(len(intercepted), 1)
        cmd, kwargs = intercepted[0]
        self.assertEqual(Path(cmd[1]).name, 'core-summary-semantic-replay-cli.js')
        self.assertTrue(cmd[2].isdigit() and int(cmd[2]) >= 3)
        self.assertEqual(kwargs['pass_fds'], (int(cmd[2]),))
        self.assertEqual(res.stdout, '{"issue":null}')

        # 2. PD_DISABLE_NODE_REPLAY_WORKER=1 bypasses persistent worker pool
        spawned_before = replay_client.total_spawned_workers()
        with mock.patch.dict(os.environ, {'PD_DISABLE_NODE_REPLAY_WORKER': '1'}):
            res_disabled = publisher._run_node_replay_cli(
                core_cli,
                payload,
                cwd=str(ROOT),
                env=self._base_env(),
                timeout_seconds=30,
                max_output_bytes=64 * 1024,
            )
        self.assertEqual(res_disabled.returncode, 0)
        self.assertEqual(json.loads(res_disabled.stdout), {'issue': None})
        self.assertEqual(replay_client.total_spawned_workers(), spawned_before)

        # 3. Both new files participate in generation_template_fingerprint and review_implementation_closure
        publisher._REVIEW_IMPLEMENTATION_CLOSURE_CACHE.clear()
        closure = set(publisher.review_implementation_closure())
        self.assertIn('scripts/publish_node_replay_client.py', closure)
        self.assertIn('scripts/lib/publish-node-replay-worker.js', closure)

        real_sha = publisher._sha256_file
        base_gen = publisher.generation_template_fingerprint()
        for target in (
            (SCRIPTS / 'publish_node_replay_client.py').resolve(),
            (SCRIPTS / 'lib' / 'publish-node-replay-worker.js').resolve(),
        ):
            with mock.patch.object(
                publisher,
                '_sha256_file',
                side_effect=lambda p, changed=target: '0' * 64 if Path(p).resolve() == changed else real_sha(p),
            ):
                self.assertNotEqual(publisher.generation_template_fingerprint(), base_gen, str(target))

    def test_transitive_js_json_and_project_root_dotenv_invalidate_warm_worker(self):
        with tempfile.TemporaryDirectory(prefix='worker-transitive-stamp-') as tmp_proj, \
                tempfile.TemporaryDirectory(prefix='worker-separate-cwd-') as tmp_cwd:
            proj = Path(tmp_proj).resolve()
            other_cwd = Path(tmp_cwd).resolve()
            isolated_lib = proj / 'scripts' / 'lib'
            isolated_cfg = proj / 'config' / 'protocols'
            isolated_lib.mkdir(parents=True)
            isolated_cfg.mkdir(parents=True)

            (proj / 'scripts' / 'env-loader.js').write_text(
                "'use strict'; module.exports = { requireExternalRuntime() {} };\n",
                encoding='utf-8',
            )
            shutil.copy2(SCRIPTS / 'lib' / 'publish-node-replay-worker.js', isolated_lib / 'publish-node-replay-worker.js')

            leaf_js = isolated_lib / 'transitive-leaf-helper.js'
            leaf_js.write_text("'use strict'; module.exports = { version: 'leaf-v1' };\n", encoding='utf-8')
            sample_json = isolated_cfg / 'sample.json'
            sample_json.write_text('{"catalogVersion":1}\n', encoding='utf-8')

            cli_js = isolated_lib / 'core-summary-semantic-replay-cli.js'
            cli_js.write_text(
                """'use strict';
const fs = require('node:fs');
const path = require('node:path');
const leaf = require('./transitive-leaf-helper.js');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config/protocols/sample.json'), 'utf8'));
function formatReplayError(e) { return { exitCode: 1, stdout: JSON.stringify({ issue: String(e.message || e) }) }; }
function runReplayFd(fd) {
    fs.readFileSync(fd, 'utf8');
    return { exitCode: 0, stdout: JSON.stringify({ pid: process.pid, leaf: leaf.version, cfg: cfg.catalogVersion }) };
}
module.exports = { runReplayFd, formatReplayError };
""",
                encoding='utf-8',
            )

            def call():
                res = replay_client.run_node_replay_request(
                    node=self.node,
                    cli_path=cli_js,
                    payload=b'{"ok":true}',
                    cwd=str(other_cwd),
                    env=self._base_env(),
                    timeout_seconds=10,
                    max_output_bytes=64 * 1024,
                )
                self.assertEqual(res.returncode, 0, res.stderr)
                return json.loads(res.stdout)

            # 1 & 2: Initial spawn + warm reuse with unchanged transitive dependencies
            first = call()
            second = call()
            self.assertEqual(first['pid'], second['pid'])
            self.assertEqual(first['leaf'], 'leaf-v1')
            self.assertEqual(first['cfg'], 1)

            # 3: Mutate transitive leaf JS -> stale warm worker disposed & new worker spawned
            leaf_js.write_text("'use strict'; module.exports = { version: 'leaf-v2-updated' };\n", encoding='utf-8')
            third = call()
            self.assertNotEqual(third['pid'], first['pid'])
            self.assertEqual(third['leaf'], 'leaf-v2-updated')
            time.sleep(0.05)
            self.assertFalse(_pid_alive(first['pid']))

            # 4: Mutate config/protocols/*.json read via fs.readFileSync at module load -> invalidated & respawned
            sample_json.write_text('{"catalogVersion":22}\n', encoding='utf-8')
            fourth = call()
            self.assertNotEqual(fourth['pid'], third['pid'])
            self.assertEqual(fourth['cfg'], 22)
            time.sleep(0.05)
            self.assertFalse(_pid_alive(third['pid']))

            # 5: Create/mutate PROJECT_ROOT/.env while cwd != PROJECT_ROOT -> invalidated & respawned
            (proj / '.env').write_text('PD_TRANSITIVE_STAMP_TEST=1\n', encoding='utf-8')
            os.chmod(proj / '.env', 0o600)
            fifth = call()
            self.assertNotEqual(fifth['pid'], fourth['pid'])
            time.sleep(0.05)
            self.assertFalse(_pid_alive(fourth['pid']))

    def test_spawn_and_acquire_worker_base_exception_cleanup_leaves_zero_orphans(self):
        core_cli = SCRIPTS / 'lib' / 'core-summary-semantic-replay-cli.js'
        payload = json.dumps({'summary': self.valid_summary, 'sourceText': ''}).encode('utf-8')

        # 1. Simulate RenderDeadlineExceeded inside _spawn_worker AFTER subprocess.Popen succeeds
        spawned_pids = []
        created_dirs = []
        real_popen = replay_client.subprocess.Popen
        real_mkdtemp = replay_client.tempfile.mkdtemp

        def tracking_popen(*args, **kwargs):
            proc = real_popen(*args, **kwargs)
            spawned_pids.append(proc.pid)
            return proc

        def tracking_mkdtemp(*args, **kwargs):
            d = real_mkdtemp(*args, **kwargs)
            created_dirs.append(Path(d))
            return d

        with mock.patch.object(replay_client.subprocess, 'Popen', side_effect=tracking_popen), \
                mock.patch.object(replay_client.tempfile, 'mkdtemp', side_effect=tracking_mkdtemp), \
                mock.patch.object(
                    replay_client.os,
                    'set_blocking',
                    side_effect=publication_local_replay.RenderDeadlineExceeded('simulated signal post-Popen'),
                ):
            with self.assertRaises(publication_local_replay.RenderDeadlineExceeded):
                replay_client.run_node_replay_request(
                    node=self.node,
                    cli_path=core_cli,
                    payload=payload,
                    cwd=str(ROOT),
                    env=self._base_env(),
                    timeout_seconds=30,
                    max_output_bytes=64 * 1024,
                )

        self.assertEqual(len(spawned_pids), 1)
        self.assertEqual(len(created_dirs), 1)
        time.sleep(0.05)
        self.assertFalse(_pid_alive(spawned_pids[0]))
        self.assertFalse(created_dirs[0].exists())
        self.assertEqual(replay_client.idle_worker_count(), 0)

        # 2. Simulate RenderDeadlineExceeded interrupting _acquire_worker while disposing 2 stale workers
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            f1 = pool.submit(
                replay_client.run_node_replay_request,
                node=self.node,
                cli_path=core_cli,
                payload=payload,
                cwd=str(ROOT),
                env=self._base_env(),
                timeout_seconds=30,
                max_output_bytes=64 * 1024,
            )
            f2 = pool.submit(
                replay_client.run_node_replay_request,
                node=self.node,
                cli_path=core_cli,
                payload=payload,
                cwd=str(ROOT),
                env=self._base_env(),
                timeout_seconds=30,
                max_output_bytes=64 * 1024,
            )
            self.assertEqual(f1.result().returncode, 0)
            self.assertEqual(f2.result().returncode, 0)

        with replay_client._POOL_LOCK:
            buckets = list(replay_client._IDLE_WORKERS.values())
            idle_workers = [w for b in buckets for w in b]
            for w in idle_workers:
                w.stamp = ('forced-stale',)
        self.assertGreaterEqual(len(idle_workers), 1)
        stale_pids = [w.process.pid for w in idle_workers]
        stale_dirs = [w.temp_dir for w in idle_workers]

        real_dispose = replay_client._dispose_worker
        calls = [0]

        def interrupting_dispose(w):
            calls[0] += 1
            real_dispose(w)
            if calls[0] == 1:
                raise publication_local_replay.RenderDeadlineExceeded('interrupted during stale cleanup')

        with mock.patch.object(replay_client, '_dispose_worker', side_effect=interrupting_dispose):
            with self.assertRaises(publication_local_replay.RenderDeadlineExceeded):
                replay_client.run_node_replay_request(
                    node=self.node,
                    cli_path=core_cli,
                    payload=payload,
                    cwd=str(ROOT),
                    env=self._base_env(),
                    timeout_seconds=30,
                    max_output_bytes=64 * 1024,
                )

        time.sleep(0.05)
        for pid in stale_pids:
            self.assertFalse(_pid_alive(pid))
        for temp_dir in stale_dirs:
            self.assertFalse(temp_dir.exists())
        self.assertEqual(replay_client.idle_worker_count(), 0)


if __name__ == '__main__':
    unittest.main()
