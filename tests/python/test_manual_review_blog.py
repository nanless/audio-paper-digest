import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
SPEC = importlib.util.spec_from_file_location(
    'manual_review_blog_test', ROOT / 'scripts' / 'manual-review-blog.py',
)
manual_review_blog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(manual_review_blog)


FILE_CHECKS = {
    'titleAndMetadata': True,
    'technicalNarrative': True,
    'factualClaims': True,
    'experimentComparisons': True,
    'reproducibility': True,
    'limitations': True,
    'scoring': True,
    'images': True,
}


def attestation():
    return {
        'version': 2,
        'mode': 'manual_complete',
        'agent': 'Codex',
        'basis': 'deterministic_and_manual_semantic_review',
        'reason': '逐文件核对技术叙事、事实、实验、复现、局限、评分与图片语义。',
        'checks': {
            'generationManifestVerified': True,
            'baseHeadVerified': True,
            'fileHashesVerified': True,
            'frontmatterVerified': True,
            'markdownVerified': True,
            'contentSemanticsVerified': True,
            'imageReferencesVerified': True,
            'hugoGateVerified': True,
        },
        'files': [{
            'path': 'content/posts/2026-08-25-paper.md',
            'sha256': 'a' * 64,
            'checks': dict(FILE_CHECKS),
            'notes': '已核对问题到方法、实验比较、复现条件和双层局限的论证链。',
        }],
    }


class ManualReviewAttestationTest(unittest.TestCase):
    def write_payload(self, directory, payload):
        path = Path(directory) / 'attestation.json'
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
        return path

    def test_accepts_exact_v2_per_file_semantic_attestation(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write_payload(tmp, attestation())
            expected_digest = hashlib.sha256(path.read_bytes()).hexdigest()
            payload, digest = manual_review_blog._load_attestation(path)
        self.assertEqual(payload['version'], 2)
        self.assertEqual(payload['files'][0]['checks'], FILE_CHECKS)
        self.assertEqual(digest, expected_digest)

    def test_rejects_legacy_batch_only_or_incomplete_file_checks(self):
        cases = []
        legacy = attestation()
        legacy['version'] = 1
        cases.append(legacy)
        no_files = attestation()
        del no_files['files']
        cases.append(no_files)
        incomplete = attestation()
        del incomplete['files'][0]['checks']['technicalNarrative']
        cases.append(incomplete)
        duplicate = attestation()
        duplicate['files'].append(dict(duplicate['files'][0]))
        cases.append(duplicate)
        with tempfile.TemporaryDirectory() as tmp:
            for index, payload in enumerate(cases):
                with self.subTest(index=index):
                    path = self.write_payload(tmp, payload)
                    with self.assertRaises(ValueError):
                        manual_review_blog._load_attestation(path)

    def test_rejects_attestation_when_deterministic_review_mutated_final_bytes(self):
        class Module:
            class PublishDataValidationError(ValueError):
                pass

        manual_review_blog._reject_deterministic_fixes(Module, [])
        with self.assertRaisesRegex(Module.PublishDataValidationError, '旧 attestation 已失效'):
            manual_review_blog._reject_deterministic_fixes(Module, [
                {'path': '/tmp/content/posts/changed.md', 'issues': ['重复段落']},
            ])


if __name__ == '__main__':
    unittest.main()
