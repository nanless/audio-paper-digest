import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = ROOT / 'scripts'
MANUAL_SCRIPTS = ROOT / 'manual' / 'scripts'
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(MANUAL_SCRIPTS))

import sealed_tutorial_preview as sealed


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


class SealedTutorialPreviewTest(unittest.TestCase):
    def make_fixture(self, authority_root=None):
        authority_root = ROOT if authority_root is None else Path(authority_root)
        temporary = tempfile.TemporaryDirectory()
        current = Path(temporary.name) / 'current'
        paper_id = '2608.25177'
        date_str = '2026-08-27'
        root = current / 'manual-tutorial-previews' / date_str / paper_id
        (root / 'draft').mkdir(parents=True)
        article = '### 方法流程\n\n这是只从本篇证据新写的正文，用于验证发布器逐字复制而不读取旧 canonical。'
        article_path = root / 'draft' / 'article.md'
        article_path.write_text(article, encoding='utf-8')
        quality_path = root / 'quality.json'
        quality_path.write_text('{"passed":true}\n', encoding='utf-8')
        plan = {'paperId': paper_id, 'version': 1, 'tables': []}
        plan_path = root / 'artifact-plan.json'
        plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        stable_plan = json.dumps(
            plan, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
        ).encode('utf-8')
        payload = {
            'contract': 'manual-v5-tutorial-payload-v1',
            'paperId': paper_id,
            'articleSha256': 'a' * 64,
            'freshAuthoringReceiptSha256': 'b' * 64,
            'qualityFileSha256': sha(quality_path.read_bytes()),
            'qualityPacketSha256': 'c' * 64,
            'artifactPlanPath': str(plan_path),
            'artifactPlanFileSha256': sha(plan_path.read_bytes()),
            'artifactPlanSha256': sha(stable_plan),
            'artifactPlanBindingSha256': 'd' * 64,
            'receiptSha256': 'e' * 64,
        }
        score = (
            '**八维分项：** 创新 1.5/2 ｜ 技术严谨 1.0/1.5 ｜ '
            '实验充分 1.2/1.5 ｜ 清晰度 0.8/1 ｜ 影响力 1.1/1.5 ｜ '
            '开源 1.0/1.5 ｜ 可复现 0.4/0.5 ｜ 工程/实践 1.2/1.5'
        )
        post = (
            '---\n'
            'title: "AudioLens 教程"\n'
            f'date: {date_str}\n'
            'draft: false\n'
            'paper_digest_pipeline_owned: true\n'
            'paper_digest_page_type: paper\n'
            f'paper_digest_arxiv_id: "{paper_id}"\n'
            'paper_digest_tutorial_contract: "graduate-researcher-tutorial-quality-v2"\n'
            'paper_digest_fresh_authoring_contract: "fresh-authoring-v1"\n'
            'paper_digest_tutorial_payload_contract: "manual-v5-tutorial-payload-v1"\n'
            f'paper_digest_fresh_authoring_sha256: "{payload["freshAuthoringReceiptSha256"]}"\n'
            f'paper_digest_reader_article_sha256: "{payload["articleSha256"]}"\n'
            f'paper_digest_tutorial_payload_sha256: "{payload["receiptSha256"]}"\n'
            f'paper_digest_tutorial_quality_sha256: "{payload["qualityPacketSha256"]}"\n'
            f'paper_digest_tutorial_artifact_plan_sha256: "{payload["artifactPlanSha256"]}"\n'
            '---\n\n'
            f'{score}\n\n{article}\n'
        )
        post_path = root / 'post.md'
        post_path.write_text(post, encoding='utf-8')
        controlled = {
            'article': article_path,
            'quality': quality_path,
            'editorialContract': authority_root / 'manual' / 'prompts' / 'manual-tutorial-article.md',
            'referenceContract': authority_root / 'manual' / 'docs' / 'editorial-reference-contract.md',
            'qualitySchema': authority_root / 'manual' / 'scripts' / 'manual-tutorial-quality-contract.js',
        }
        manifest = {
            'version': 5,
            'mode': 'manual_tutorial_preview',
            'status': 'complete',
            'date': date_str,
            'paperId': paper_id,
            'inputs': {
                **{
                    key: {'path': str(path), 'sha256': sha(path.read_bytes())}
                    for key, path in controlled.items()
                },
                'tutorialPayload': payload,
            },
            'output': {
                'path': str(post_path),
                'postSha256': sha(post_path.read_bytes()),
                'bytes': len(post_path.read_bytes()),
            },
            'isolation': {
                'singlePaperOnly': True,
                'blogRepositoryTouched': False,
                'canonicalMutated': False,
                'imagesGenerated': False,
                'otherPapersGenerated': False,
            },
        }
        (root / 'manifest.json').write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8',
        )
        current.mkdir(parents=True, exist_ok=True)
        (current / 'filtered-papers.json').write_text(json.dumps({
            'status': 'complete', 'batchDate': date_str,
            'papers': [{
                'arxivId': paper_id,
                'title': 'AudioLens: Multi-Perspective Speech Clustering',
                'authors': ['Alice'],
            }],
        }), encoding='utf-8')
        return temporary, current, date_str, paper_id, post_path

    def test_loads_exact_post_and_returns_prose_free_snapshot(self):
        temporary, current, date_str, paper_id, post_path = self.make_fixture()
        self.addCleanup(temporary.cleanup)
        result = sealed.load_sealed_tutorial_preview(
            date_str, paper_id, current_dir=current,
        )
        self.assertEqual(result['postText'], post_path.read_text(encoding='utf-8'))
        self.assertEqual(result['snapshot']['arxivId'], paper_id)
        self.assertNotIn('analysis', result['snapshot'])
        self.assertNotIn('parsed', result['snapshot'])
        self.assertNotIn('readerArticle', json.dumps(result['snapshot']))

    def test_current_reference_contract_bytes_and_fixed_path_are_required(self):
        for boundary in ('current_bytes', 'old_copy_path'):
            with self.subTest(boundary=boundary), tempfile.TemporaryDirectory() as temporary_root:
                authority_root = Path(temporary_root) / 'project'
                for relative in (
                        'manual/prompts/manual-tutorial-article.md',
                        'manual/docs/editorial-reference-contract.md',
                        'manual/scripts/manual-tutorial-quality-contract.js',
                        'manual/scripts/sealed_tutorial_preview.py'):
                    target = authority_root / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes((ROOT / relative).read_bytes())
                temporary, current, date_str, paper_id, post_path = self.make_fixture(authority_root)
                self.addCleanup(temporary.cleanup)
                manifest_path = post_path.parent / 'manifest.json'
                manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
                self.assertEqual(
                    Path(manifest['inputs']['editorialContract']['path']),
                    authority_root / 'manual/prompts/manual-tutorial-article.md',
                )
                contract_path = authority_root / 'manual/docs/editorial-reference-contract.md'
                self.assertEqual(Path(manifest['inputs']['referenceContract']['path']), contract_path)
                old_bytes = contract_path.read_bytes()
                old_copy = Path(temporary_root) / 'previous-editorial-contract.md'
                old_copy.write_bytes(old_bytes)
                module_path = authority_root / 'manual/scripts/sealed_tutorial_preview.py'
                with mock.patch.object(sealed, '__file__', str(module_path)):
                    original = sealed.load_sealed_tutorial_preview(date_str, paper_id, current_dir=current)
                    self.assertEqual(original['postText'], post_path.read_text(encoding='utf-8'))
                    contract_path.write_bytes(old_bytes + '\n测试中的下一版编辑要求。\n'.encode('utf-8'))
                    binding = manifest['inputs']['referenceContract']
                    self.assertEqual(binding['sha256'], sha(old_copy.read_bytes()))
                    self.assertNotEqual(binding['sha256'], sha(contract_path.read_bytes()))
                    if boundary == 'old_copy_path':
                        binding['path'] = str(old_copy.resolve())
                        expected_error = '未绑定固定受控路径'
                    else:
                        expected_error = 'SHA-256 漂移'
                    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
                    self.assertEqual(manifest['output']['postSha256'], sha(post_path.read_bytes()))
                    self.assertEqual(manifest['output']['bytes'], len(post_path.read_bytes()))
                    with self.assertRaises(sealed.PublishDataValidationError) as failure:
                        sealed.load_sealed_tutorial_preview(date_str, paper_id, current_dir=current)
                    self.assertEqual(
                        str(failure.exception),
                        f'preview.inputs.referenceContract {expected_error}',
                    )
                    if boundary == 'current_bytes':
                        contract_path.write_bytes(old_bytes)
                    else:
                        binding.update(path=str(contract_path.resolve()), sha256=sha(contract_path.read_bytes()))
                        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
                    restored = sealed.load_sealed_tutorial_preview(date_str, paper_id, current_dir=current)
                    self.assertEqual(restored['postText'], original['postText'])

    def test_post_byte_tamper_fails_closed(self):
        temporary, current, date_str, paper_id, post_path = self.make_fixture()
        self.addCleanup(temporary.cleanup)
        post_path.write_text(post_path.read_text(encoding='utf-8') + 'tamper', encoding='utf-8')
        with self.assertRaisesRegex(sealed.PublishDataValidationError, 'SHA/字节数漂移'):
            sealed.load_sealed_tutorial_preview(date_str, paper_id, current_dir=current)

    def test_symlinked_article_fails_closed(self):
        temporary, current, date_str, paper_id, _post_path = self.make_fixture()
        self.addCleanup(temporary.cleanup)
        article = current / 'manual-tutorial-previews' / date_str / paper_id / 'draft' / 'article.md'
        target = article.with_suffix('.real.md')
        article.rename(target)
        article.symlink_to(target)
        with self.assertRaisesRegex(sealed.PublishDataValidationError, '符号链接'):
            sealed.load_sealed_tutorial_preview(date_str, paper_id, current_dir=current)


if __name__ == '__main__':
    unittest.main()
