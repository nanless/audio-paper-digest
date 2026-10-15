"""使用真实审查文件和发布凭证验证各入口接受的论文编号一致。"""
import contextlib
import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from test_manual_review_blog import ROOT, current_attestation, manual_review_blog
from blog_entry_loader import load_publish_to_blog

SPEC = importlib.util.spec_from_file_location(
    'review_identity_assembler', ROOT / 'manual/scripts/assemble-manual-review-attestation.py',
)
assembler = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(assembler)
publisher = load_publish_to_blog()
VALID_IDS = ('2608.12345', '0704.0001', 'hep-th/9901001', 'math.gt/0309136')
INVALID_IDS = (None, 1234, '0704.0001v1', 'hep-th/9901001v2',
               'arXiv:0704.0001', 'https://arxiv.org/abs/0704.0001',
               ' 0704.0001', 'HEP-TH/9901001', '../9901001',
               'hep-th/../9901001', '0704.001', 'hep-th/990100')
DATE = '2026-08-25'


@contextlib.contextmanager
def assembler_workspace(directory):
    """仅隔离文件位置，分区、机器资产和异常传播均使用真实发布器。"""
    root = Path(directory).resolve()
    workspace = SimpleNamespace(root=root, repo=root / 'blog', current=root / 'current',
        shards=root / 'shards', manifest=root / 'generation.json', output=root / 'assembled.json')
    for directory in (workspace.repo, workspace.current, workspace.shards):
        directory.mkdir(exist_ok=True)
    with mock.patch.object(publisher, 'BLOG_REPO', str(workspace.repo)), \
            mock.patch.object(publisher, 'CURRENT_DIR', workspace.current), \
            mock.patch.object(publisher, 'generation_manifest_path', return_value=workspace.manifest), \
            mock.patch.object(publisher, 'manual_review_page_dir', return_value=workspace.shards), \
            mock.patch.object(publisher, 'manual_review_statement_path', return_value=workspace.output), \
            mock.patch.object(assembler, 'load_publish_to_blog', return_value=publisher):
        yield workspace


def write_assembler_inputs(workspace, item, *, page_text=None, assets=()):
    page = workspace.repo / item['path']
    page.parent.mkdir(parents=True, exist_ok=True)
    page.write_text(page_text or '---\ntitle: 构造测试页面\n---\n正文报告 WER 7.1%。\n', encoding='utf-8')
    item['sha256'] = hashlib.sha256(page.read_bytes()).hexdigest()
    shard = workspace.shards / 'page.json'
    shard.write_text(json.dumps(item), encoding='utf-8')
    records = [{'path': item['path'], 'deleted': False, 'sha256': item['sha256']}, *assets]
    workspace.manifest.write_text(json.dumps({
        'schemaVersion': 3, 'date': DATE, 'files': records,
    }), encoding='utf-8')
    return shard


def statement(paper_id):
    payload = current_attestation()
    item = payload['files'][0]
    item['reviewSubagent']['paperId'] = paper_id
    item['notes'] = f'{paper_id}：核对方法数据流、WER 7.1% 实验数字、开源范围与局限边界。'
    return payload


class ManualReviewArxivIdentityTest(unittest.TestCase):
    def test_statement_file_accepts_all_canonical_id_families(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'statement.json'
            for paper_id in VALID_IDS:
                with self.subTest(paper_id=paper_id):
                    path.write_text(json.dumps(statement(paper_id)), encoding='utf-8')
                    actual, digest = manual_review_blog._load_review_statement(path)
                    self.assertEqual(actual['files'][0]['reviewSubagent']['paperId'], paper_id)
                    self.assertEqual(digest, hashlib.sha256(path.read_bytes()).hexdigest())

    def test_statement_file_rejects_aliases_versions_and_unsafe_ids(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'statement.json'
            for paper_id in INVALID_IDS:
                with self.subTest(paper_id=paper_id):
                    path.write_text(json.dumps(statement(paper_id)), encoding='utf-8')
                    with self.assertRaisesRegex(ValueError, 'paperId'):
                        manual_review_blog._load_review_statement(path)

    def run_assembler(self, directory, paper_id):
        item = statement(paper_id)['files'][0]
        with assembler_workspace(directory) as workspace:
            write_assembler_inputs(workspace, item)
            with mock.patch.object(sys, 'argv', ['assemble', '--date', DATE]), \
                    contextlib.redirect_stdout(io.StringIO()):
                assembler.main()
            payload = json.loads(workspace.output.read_text())
            self.assertNotIn('machineAssets', payload, '纯Markdown清单不应伪造机器资产证明')
            self.assertEqual(payload['files'][0]['sha256'], item['sha256'])
            return workspace.output

    def test_assembler_writes_statement_for_each_canonical_id(self):
        for paper_id in VALID_IDS:
            with self.subTest(paper_id=paper_id), tempfile.TemporaryDirectory() as tmp:
                output = self.run_assembler(tmp, paper_id)
                actual, _ = manual_review_blog._load_review_statement(output)
                self.assertEqual(actual['files'][0]['reviewSubagent']['paperId'], paper_id)

    def test_assembler_rejects_noncanonical_shards_before_writing(self):
        for paper_id in INVALID_IDS:
            with self.subTest(paper_id=paper_id), tempfile.TemporaryDirectory() as tmp:
                with self.assertRaisesRegex(SystemExit, '未通过核验'):
                    self.run_assembler(tmp, paper_id)
                self.assertFalse((Path(tmp) / 'assembled.json').exists())

    def test_assembler_preserves_exact_machine_asset_partition(self):
        with tempfile.TemporaryDirectory() as tmp, assembler_workspace(tmp) as workspace:
            pixels = publisher.PNG_SIGNATURE + b'synthetic-test-only'
            digest = hashlib.sha256(pixels).hexdigest()
            relative = f'static/images/papers/2608.12345/figure-1-{digest[:16]}.png'
            image = workspace.repo / relative
            image.parent.mkdir(parents=True)
            image.write_bytes(pixels)
            asset = {'path': relative, 'deleted': False, 'sha256': digest}
            url = f'{publisher.BASE_PATH.rstrip("/")}/{relative[len("static/"):]}'
            item = statement('2608.12345')['files'][0]
            shard = write_assembler_inputs(workspace, item,
                page_text=f'---\ntitle: 构造回归\n---\n![仅测试]({url})\nWER 7.1%。\n', assets=[asset])
            before = shard.read_bytes()
            with mock.patch.object(sys, 'argv', ['assemble', '--date', DATE]), \
                    contextlib.redirect_stdout(io.StringIO()):
                assembler.main()
            payload = json.loads(workspace.output.read_text())
            self.assertEqual([record['path'] for record in payload['files']], [item['path']])
            self.assertEqual(payload['machineAssets'], {
                'contract': 'manual-review-controlled-assets-v1', 'files': [asset],
            })
            self.assertEqual(shard.read_bytes(), before)
            self.assertEqual(image.read_bytes(), pixels)

    def test_real_partition_error_propagates_without_writing_or_leaking_scope(self):
        with tempfile.TemporaryDirectory() as tmp, assembler_workspace(tmp) as workspace:
            item = statement('2608.12345')['files'][0]
            shard = write_assembler_inputs(workspace, item, assets=[{
                'path': 'static/unknown.bin', 'deleted': False, 'sha256': 'a' * 64,
            }])
            before = shard.read_bytes()
            previous_scope = publisher._ACTIVE_PUBLICATION_INCLUDE_ID
            with mock.patch.object(sys, 'argv', ['assemble', '--date', DATE]):
                with self.assertRaisesRegex(publisher.PublishDataValidationError, '不允许发布的路径'):
                    assembler.main()
            self.assertEqual(publisher._ACTIVE_PUBLICATION_INCLUDE_ID, previous_scope)
            self.assertFalse(workspace.output.exists())
            self.assertEqual(shard.read_bytes(), before)

    def receipt_error(self, root, paper_id, *, reviewed_id=None):
        payload = statement(paper_id)
        page = root / payload['files'][0]['path']
        page.parent.mkdir(parents=True, exist_ok=True)
        page.write_text(f'---\npaper_digest_arxiv_id: "{paper_id}"\n---\n正文报告 WER 7.1%。\n', encoding='utf-8')
        item = payload['files'][0]
        item['sha256'] = hashlib.sha256(page.read_bytes()).hexdigest()
        if reviewed_id is not None:
            item['reviewSubagent']['paperId'] = reviewed_id
        files = [{'path': item['path'], 'sha256': item['sha256'], 'deleted': False}]
        payload.update(completedAt='2026-08-25T12:00:00.000+08:00',
                       generationManifestSha256='a' * 64, baseHead='b' * 40,
                       fileCount=1, reviewedPathSetSha256=publisher._reviewed_path_set_sha256(files),
                       reviewProtocolFingerprint='c' * 64)
        receipt = {'reviewMode': 'manual_complete', 'files': files, 'reviewProvenance': payload}
        with mock.patch.object(publisher, 'BLOG_REPO', root):
            return publisher._manual_review_record_error(receipt, date_str='2026-08-25',
                generation_manifest_sha256='a' * 64, expected_base_head='b' * 40)

    def test_publisher_validates_real_page_and_canonical_review_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            for paper_id in VALID_IDS:
                with self.subTest(paper_id=paper_id):
                    self.assertIsNone(self.receipt_error(Path(tmp), paper_id))

    def test_publisher_still_rejects_different_paper_and_noncanonical_review_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertIn('不一致', self.receipt_error(root, 'hep-th/9901001', reviewed_id='hep-th/9901002'))
            for paper_id in INVALID_IDS:
                if paper_id is None:
                    continue
                with self.subTest(paper_id=paper_id):
                    self.assertIn('不是规范', self.receipt_error(root, 'hep-th/9901001', reviewed_id=paper_id))


if __name__ == '__main__':
    unittest.main()
