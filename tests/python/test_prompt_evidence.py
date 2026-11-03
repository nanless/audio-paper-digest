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
        current = 'prompts/current/filter.md'
        self.index['retiredPaths'][current] = self.sha
        self.index['blobs'][self.sha]['paths'].append(current)
        self.save()
        with self.assertRaises(FileNotFoundError):
            evidence.read_prompt_evidence_bytes(current, project_root=self.root)
        target = self.root / current
        target.parent.mkdir(parents=True)
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
        output = subprocess.run(['node', '-e', "process.stdout.write(JSON.stringify(require('./scripts/lib/prompt-contracts').CURRENT_PROMPT_FILES))"],
                                cwd=ROOT, capture_output=True, check=True).stdout
        self.assertEqual(set(json.loads(output)), set(evidence.CURRENT_PROMPT_FILES))

    def test_writing_upgrades_preserve_real_retired_git_bytes(self):
        for retired, whole_sha, current in (
            ('prompts/deep-analysis-v6.md',
             'b36705353d116b99cde778625f21b14334378dff54b83474de29f9a83e04f0ff',
             'prompts/current/deep-analysis.md'),
            ('prompts/api-reader-article-v9.md',
             'a2630453bfbd506619b7b3e80ece91ffc9f53951b80bab043cc6d889731d7ff8',
             'prompts/current/api-reader-article.md'),
            ('prompts/deep-analysis-v7.md',
             'b8856b5e510d17f610f98b2292329553f8f8df361be23db66d5140df45639b22',
             'prompts/current/deep-analysis.md'),
            ('prompts/api-reader-article-v10.md',
             '676bd4cd5cfd6486a9ae1c8737e02cbc2db0695880985dd3119d3869d1811026',
             'prompts/current/api-reader-article.md'),
            ('prompts/gap-fill-v4.md',
             'b1b3619eeb05e568253c30b67f34fb692aeb6dcace9abc875c9e26276427cc84',
             'prompts/current/gap-fill.md'),
            ('prompts/structure-repair-v3.md',
             'fcb0890e1176bc9dc10a7600b5c553ba901fbaafc18bf97f5cb7f2fd754bbb88',
             'prompts/current/structure-repair.md'),
        ):
            with self.subTest(retired=retired):
                original = evidence.read_prompt_evidence_bytes(retired, whole_sha)
                self.assertEqual(hashlib.sha256(original).hexdigest(), whole_sha)
                self.assertNotIn(retired, evidence.CURRENT_PROMPT_FILES)
                self.assertIn(current, evidence.CURRENT_PROMPT_FILES)
                self.assertNotEqual(original, evidence.read_prompt_evidence_bytes(current))
                self.assertFalse((ROOT / retired).exists())
                with self.assertRaises(ValueError):
                    evidence.read_prompt_evidence_bytes(retired, 'f' * 64)


if __name__ == '__main__':
    unittest.main()
