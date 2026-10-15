import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


class ResourceClaimReplayTests(unittest.TestCase):
    def run_replay(self, body, *, wrong_source=False):
        root = Path(__file__).resolve().parents[2]
        source = 'The source document does not release any resources.'
        source_sha = hashlib.sha256(source.encode()).hexdigest()
        identity = {'contract': 'api-reader-resource-identity-v1',
                    'sourceTextSha256': source_sha, 'resources': []}
        identity['identitySha256'] = hashlib.sha256(json.dumps(
            identity, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        paper = {'sourceSha256': source_sha, 'apiReaderResources': identity,
                 'apiReaderPlan': {'readerTitle': '机制分析与资源状态说明',
                                   'oneSentenceThesis': '本文解释训练与推理机制，资源发布状态尚未确认。',
                                   'conceptBridges': [],
                                   'sections': [{'kind': 'reproduction', 'heading': '资源状态与复现边界'}]},
                 'apiReaderArticle': '### 资源状态与复现边界\n\n' + body}
        with tempfile.TemporaryFile() as payload:
            payload.write(json.dumps({'paper': paper, 'sourceText': source + ('wrong' if wrong_source else '')},
                                     ensure_ascii=False).encode())
            payload.flush()
            payload.seek(0)
            result = subprocess.run(['node', 'scripts/lib/reader-resource-claims-replay-cli.js', str(payload.fileno())],
                                    cwd=root, pass_fds=(payload.fileno(),), capture_output=True, text=True, timeout=30)
        return result, json.loads(result.stdout)

    def test_source_bound_denial_is_machine_readable_and_accepted(self):
        result, value = self.run_replay('本次尚未确认作者代码和模型权重的可用状态，不能声称已经开源。')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(value, {'verified': True})

    def test_missing_weights_cannot_be_claimed_as_public(self):
        result, value = self.run_replay('作者的模型权重已经公开，可以直接下载。')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(value['code'], 'READER_RESOURCE_AVAILABILITY_CLAIM')
        self.assertTrue(value['issues'])

    def test_bounded_evidence_and_coordinated_denials_share_actual_publication_replay(self):
        fixture = Path(__file__).resolve().parents[1] / 'reader-resource-scoped-denial-fixture.json'
        cases = json.loads(fixture.read_text())
        for body in cases['accept']:
            with self.subTest(accepted=body):
                result, value = self.run_replay(body)
                self.assertEqual(result.returncode, 0, result.stderr or value)
                self.assertEqual(value, {'verified': True})
        for body in cases['reject']:
            with self.subTest(rejected=body):
                result, value = self.run_replay(body)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(value['code'], 'READER_RESOURCE_AVAILABILITY_CLAIM')
                self.assertTrue(value['issues'])

    def test_source_substitution_is_rejected_before_analysis(self):
        result, value = self.run_replay('本文仅解释训练与推理机制。', wrong_source=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(value['verified'])


if __name__ == '__main__':
    unittest.main()
