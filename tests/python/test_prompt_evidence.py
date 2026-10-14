import hashlib
import json
from pathlib import Path
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import prompt_evidence as evidence


class PromptEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        subprocess.run(['git', 'init', '-q', '-b', 'main', str(self.root)], check=True)
        self.data = b'```text\nOriginal bounded repair.\n```\nOriginal tail.\n'
        self.sha = hashlib.sha256(self.data).hexdigest()
        self.oid = subprocess.run(['git', '-C', str(self.root), 'hash-object', '-w', '--stdin'],
                                  input=self.data, capture_output=True, check=True).stdout.decode().strip()
        self.relative = 'prompts/retired-test.md'
        self.index = {'contract': 'git-prompt-evidence-v1', 'version': 1,
                      'provenanceCommit': 'a' * 40, 'retiredPaths': {self.relative: self.sha},
                      'blobs': {self.sha: {'blobOid': self.oid, 'paths': [self.relative]}}}
        self.filename = self.root / 'scripts/lib/git-prompt-evidence-index.json'
        self.filename.parent.mkdir(parents=True)
        self.save()

    def save(self):
        self.filename.write_text(json.dumps(self.index), encoding='utf-8')
        self.filename.chmod(0o600)

    def test_original_git_bytes_without_materializing_prompt(self):
        self.assertEqual(evidence.read_prompt_evidence_bytes(self.relative, self.sha, project_root=self.root), self.data)
        self.assertFalse((self.root / 'prompts').exists())
        self.assertIsNone(evidence.historical_prompt_evidence_bytes_for_sha256('f' * 64, project_root=self.root))

    def test_unknown_path_wrong_sha_and_missing_git_object_reject(self):
        for relative in ['../outside.md', 'prompts/unknown.md']:
            with self.assertRaises((ValueError, OSError)):
                evidence.read_prompt_evidence_bytes(relative, project_root=self.root)
        with self.assertRaises(ValueError):
            evidence.read_prompt_evidence_bytes(self.relative, 'f' * 64, project_root=self.root)
        self.index['blobs'][self.sha]['blobOid'] = 'f' * 40
        self.save()
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            evidence.read_prompt_evidence_bytes(self.relative, project_root=self.root)

    def test_corrupt_metadata_current_missing_and_unsafe_files_cannot_fallback(self):
        current = 'prompts/filter-v5.md'
        self.index['retiredPaths'][current] = self.sha
        self.index['blobs'][self.sha]['paths'].append(current)
        self.save()
        with self.assertRaises(FileNotFoundError):
            evidence.read_prompt_evidence_bytes(current, project_root=self.root)
        target = self.root / current
        target.parent.mkdir()
        target.symlink_to(self.filename)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            evidence.read_prompt_evidence_bytes(current, project_root=self.root)
        target.unlink()
        os.mkfifo(target)
        with self.assertRaisesRegex(ValueError, 'regular'):
            evidence.read_prompt_evidence_bytes(current, project_root=self.root)
        self.filename.write_text('{"version":1,"version":1}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            evidence.read_prompt_evidence_bytes(self.relative, project_root=self.root)

    def test_current_registry_matches_javascript(self):
        output = subprocess.run(['node', '-e', "process.stdout.write(JSON.stringify(require('./scripts/lib/prompt-text-versions').CURRENT_PROMPT_FILES))"],
                                cwd=ROOT, capture_output=True, check=True).stdout
        self.assertEqual(set(json.loads(output)), set(evidence.CURRENT_PROMPT_FILES))


if __name__ == '__main__':
    unittest.main()
