"""Daily publication replays the actual Node pending-score guard without a model."""
import copy
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_daily_publication_table_source import verified_input, publisher, ROOT
from publish_common import PublishDataValidationError


class DailyScoringCheckpointPublishTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(temporary.cleanup)
        cls.workspace = Path(temporary.name).resolve() / 'workspace'
        cls.workspace.mkdir()
        for name in ('scripts', 'manual', 'prompts', 'config'):
            shutil.copytree(ROOT / name, cls.workspace / name,
                            ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        (cls.workspace / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        (cls.workspace / '.env').write_text(
            'PAPER_ANALYZER_API_KEY=synthetic-offline\n'
            'PAPER_ANALYZER_ENDPOINT=https://example.invalid/v1\n'
            'PAPER_ANALYZER_MODEL=muse-spark-1.3-contributor\n'
            'HTTPS_PROXY=http://127.0.0.1:9\nPD_WORKSPACE_ALLOW_CROSS_ROLE=1\n')
        (cls.workspace / '.env').chmod(0o600)
        subprocess.run(['node', '-e',
                        "require('./scripts/workspace-role').writeWorkspaceRole('daily')"],
                       cwd=cls.workspace, check=True, capture_output=True)
        cls.recovery = cls.workspace / 'data' / 'runtime' / 'daily-scoring-refresh-recovery'

    def setUp(self):
        if self.recovery.exists():
            shutil.rmtree(self.recovery)
        self.recovery.mkdir(parents=True, mode=0o700)
        self.patchers = [
            mock.patch.object(publisher, 'DAILY_SCORING_REFRESH_RECOVERY_DIR', self.recovery),
            mock.patch.object(publisher, 'SHARED_SCRIPTS_DIR', self.workspace / 'scripts'),
        ]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    def orphan(self, payload, *, run_id=None):
        paper_id = payload['papers'][0]['arxivId']
        run_id = run_id or payload['dailyFreshSourceRun']['runId']
        filename = self.recovery / f'{run_id}-{hashlib.sha256(paper_id.encode()).hexdigest()}-{"a" * 64}.json'
        filename.write_text('{}\n')
        filename.chmod(0o600)
        return filename

    def test_private_orphan_blocks_full_gate_and_later_actual_owner_assertion(self):
        with verified_input() as (_, data, payload):
            owner = publisher.validate_daily_fresh_sources_for_publish(data, payload['batchDate'])
            original_assert, _ = publisher._daily_publication_operation_state(owner)
            original_assert()
            filename = self.orphan(payload)
            before = filename.read_bytes()
            self.assertNotIn('dailyScoringRefreshCheckpoint', payload['papers'][0])
            self.assertNotIn('latestAnalysisAttemptError', payload['papers'][0])
            for action in (original_assert, lambda: publisher.validate_daily_fresh_sources_for_publish(
                    data, payload['batchDate'])):
                with self.assertRaisesRegex(PublishDataValidationError, '评分私有保存稿'):
                    action()
            self.assertEqual(filename.read_bytes(), before)

    def test_same_paper_other_daily_owner_keeps_original_private_file_and_passes(self):
        with verified_input() as (_, data, payload):
            filename = self.orphan(payload, run_id='22222222-2222-4222-8222-222222222222')
            owner = publisher.validate_daily_fresh_sources_for_publish(data, payload['batchDate'])
            publisher._daily_publication_operation_state(owner)[0]()
            self.assertEqual(filename.read_bytes(), b'{}\n')

    def test_forged_history_cannot_consume_a_real_unfinished_private_candidate(self):
        with verified_input() as (_, data, payload):
            self.orphan(payload)
            archive = self.recovery / 'completed' / 'fake.json'
            archive.parent.mkdir(mode=0o700)
            archive.write_text('{}\n')
            archive.chmod(0o600)
            payload['papers'][0]['dailyScoringRefreshHistory'] = [{
                'contract': 'daily-scoring-refresh-checkpoint-v1', 'status': 'complete',
                'parentPaperSha256': 'a' * 64,
                'archive': {'filename': str(archive), 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()},
            }]
            data.write_text(json.dumps(payload))
            with self.assertRaisesRegex(PublishDataValidationError, '评分私有保存稿'):
                publisher.validate_daily_fresh_sources_for_publish(data, payload['batchDate'])

    def test_selected_orphan_cannot_disappear_through_python_boolean_number_owner_equality(self):
        changes = (
            lambda paper: paper['analysisManifest']['freshRewriteProvenance'].update(sourceGeneration=True),
            lambda paper: [proof.update(sourceGeneration=True) for proof in (
                paper['freshRewriteProvenance'], paper['analysisManifest']['freshRewriteProvenance'])],
            lambda paper: paper['analysisManifest']['freshRewriteProvenance'].update(sourceOnly=1),
            lambda paper: paper['analysisManifest']['freshRewriteProvenance'].update(oldGeneratedTextIncluded=0),
        )
        for index, change in enumerate(changes):
            with self.subTest(change=index), verified_input() as (_, data, payload):
                filename = self.orphan(payload)
                original = filename.read_bytes()
                change(payload['papers'][0])
                data.write_text(json.dumps(payload))
                with self.assertRaisesRegex(PublishDataValidationError, '评分私有保存稿'):
                    publisher.validate_daily_fresh_sources_for_publish(data, payload['batchDate'])
                self.assertEqual(filename.read_bytes(), original)

    def test_pending_presence_blocks_source_gate_without_failure_or_private_directory(self):
        shutil.rmtree(self.recovery)
        for marker in (None, {}, {'contract': 'daily-scoring-refresh-checkpoint-v1'}):
            with self.subTest(marker=marker), verified_input() as (_, data, payload):
                payload['papers'][0]['dailyScoringRefreshCheckpoint'] = copy.deepcopy(marker)
                data.write_text(json.dumps(payload))
                with self.assertRaisesRegex(PublishDataValidationError, '评分刷新后的 Reader 尚未完成'):
                    publisher.validate_daily_fresh_sources_for_publish(data, payload['batchDate'])

    def test_bridge_rejects_sandbox_and_wrong_role_before_accepting_private_input(self):
        script = self.workspace / 'scripts/lib/daily-scoring-refresh-checkpoint-cli.js'
        for extra in ({'CODEX_SANDBOX': 'test-runtime-rejection'},
                      {'AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE': 'history'}):
            with self.subTest(extra=extra), tempfile.TemporaryFile() as private:
                private.write(b'{"contract":"daily-scoring-refresh-publication-check-v1","papers":[{}]}')
                private.flush(); private.seek(0)
                result = subprocess.run(['node', str(script), str(private.fileno())],
                    cwd=self.workspace, env={**os.environ, **extra},
                    pass_fds=(private.fileno(),), capture_output=True, timeout=30)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b'{"verified":false}')
