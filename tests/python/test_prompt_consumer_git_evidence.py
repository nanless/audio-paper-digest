import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prompt_evidence_fixtures import ROOT, install_git_prompt_evidence_fixture
sys.path.insert(0, str(ROOT / 'scripts'))
from prompt_evidence import read_prompt_evidence_bytes
from test_publish_to_blog import publish_to_blog as publisher


class PromptConsumerGitEvidenceTest(unittest.TestCase):
    def test_visual_evidence_requires_declared_stage_path_and_retains_prior_same_path(self):
        index = json.loads((ROOT / 'scripts/lib/git-prompt-evidence-index.json').read_text())
        with tempfile.TemporaryDirectory() as directory:
            root = install_git_prompt_evidence_fixture(directory)
            for stage in ('visual-summary', 'digest-cover'):
                relative = f'prompts/{stage}.md'
                original = read_prompt_evidence_bytes(relative, project_root=ROOT)
                latest = hashlib.sha256(original).hexdigest()
                prior = next(sha for sha, blob in index['blobs'].items()
                             if relative in blob['paths'] and sha != latest)
                with patch.object(publisher, 'PROJECT_ROOT', root):
                    self.assertEqual(publisher._resolved_visual_prompt_sha256(
                        stage, {'promptSha256': prior}, root / relative), prior)
                    other_stage = 'digest-cover' if stage == 'visual-summary' else 'visual-summary'
                    for other_path in ('prompts/deep-analysis.md', f'prompts/{other_stage}.md'):
                        other = read_prompt_evidence_bytes(other_path, project_root=ROOT)
                        digest = hashlib.sha256(other).hexdigest()
                        self.assertNotEqual(publisher._resolved_visual_prompt_sha256(
                            stage, {'promptSha256': digest}, root / relative), digest)
                self.assertFalse((root / relative).exists())

    def test_visual_legacy_sha_replays_git_bytes_without_recreating_old_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = install_git_prompt_evidence_fixture(directory)
            original = read_prompt_evidence_bytes('prompts/visual-summary.md', project_root=ROOT)
            digest = hashlib.sha256(original).hexdigest()
            prompt = root / 'prompts/visual-summary.md'
            self.assertFalse(prompt.exists())
            with patch.object(publisher, 'PROJECT_ROOT', root):
                self.assertEqual(publisher._resolved_visual_prompt_sha256(
                    'visual-summary', {'promptSha256': digest}, prompt), digest)
            self.assertFalse(prompt.exists())

    def test_unknown_declared_sha_does_not_become_original_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = install_git_prompt_evidence_fixture(directory)
            with patch.object(publisher, 'PROJECT_ROOT', root):
                digest = publisher._resolved_visual_prompt_sha256(
                    'visual-summary', {'promptSha256': 'f' * 64}, root / 'prompts/visual-summary.md')
            self.assertNotEqual(digest, 'f' * 64)
            self.assertFalse((root / 'prompts/visual-summary.md').exists())

    def test_missing_current_prompt_cannot_fall_back_to_historical_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = install_git_prompt_evidence_fixture(directory)
            original = read_prompt_evidence_bytes('prompts/visual-summary-v2.md', project_root=ROOT)
            digest = hashlib.sha256(original).hexdigest()
            with patch.object(publisher, 'PROJECT_ROOT', root), \
                    patch.object(publisher, '_historical_prompt_bytes', return_value=original) as historical:
                with self.assertRaisesRegex(publisher.PublishDataValidationError, '原提示词证据缺失'):
                    publisher._resolved_visual_prompt_sha256(
                        'visual-summary', {'promptSha256': digest}, root / 'prompts/visual-summary-v2.md')
            historical.assert_not_called()
