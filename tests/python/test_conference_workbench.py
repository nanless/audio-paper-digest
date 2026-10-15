import base64
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_conference_page_render as render_fixture
RENDERER = render_fixture.MODULE
from test_publish_conference import M as PUBLICATION
from project_env_isolation import isolate_module_environment

setUpModule, tearDownModule = isolate_module_environment()


class ConferenceWorkbenchPublicationTest(unittest.TestCase):
    def records(self, root):
        packet = render_fixture.ConferencePageRenderTest().packet()
        result = RENDERER.render_packet(packet)
        records = []
        for asset in result['assets']:
            filename = root / asset['path']
            filename.parent.mkdir(parents=True, exist_ok=True)
            raw = base64.b64decode(asset['base64'], validate=True)
            filename.write_bytes(raw)
            records.append({'kind': 'sidecar', 'paperId': packet['paper_id'], 'path': asset['path'],
                            'sourcePath': str(filename), 'sourceSha256': hashlib.sha256(raw).hexdigest(),
                            'size': len(raw)})
        manifest = {'date': packet['date'], 'tagMetadata': packet['taxonomy'],
                    'publication': packet['publication']}
        return packet, result, manifest, records

    def test_full_process_bundle_admits_and_cold_verifies_all_four_exports(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            packet, result, metadata, records = self.records(root / 'exports')
            paper_id, conference_id = packet['paper_id'], packet['conference']['id']
            process_id, execution_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
            page_dir, aggregate_dir = root / 'pages' / execution_id, root / 'aggregates' / conference_id / 'one'
            process_dir = root / 'processes' / process_id
            for folder in (page_dir, aggregate_dir, process_dir):
                folder.mkdir(parents=True)
            page_raw = result['markdown'].encode()
            analysis_raw = PUBLICATION.json_bytes({'papers': [packet['paper']]})
            page_manifest = {
                **metadata, 'contract': 'conference-paper-page-staging-v1', 'version': 1,
                'taxonomy': metadata['tagMetadata'], 'status': 'complete', 'paperId': paper_id,
                'analysisExecutionId': execution_id, 'pagePath': 'content/posts/conference-test.md',
                'contentSha256': PUBLICATION.sha_bytes(page_raw), 'assets': [],
                'analysisSha256': PUBLICATION.sha_bytes(analysis_raw),
                'completionReceiptSha256': 'd' * 64, 'sourceSnapshotSha256': 'e' * 64,
                'authors': packet['paper']['apiReaderAuthors']['authors'],
            }
            page_manifest.pop('tagMetadata')
            # v1 page records remain readable, but carry their original assignment family.
            page_manifest['taxonomy'] = {**page_manifest['taxonomy'],
                                        'contract': 'conference-taxonomy-assignment-v1', 'version': 1}
            for record in records:
                raw = Path(record['sourcePath']).read_bytes()
                target = page_dir / 'assets' / record['path']
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(raw)
                page_manifest['assets'].append({'path': record['path'], 'sha256': PUBLICATION.sha_bytes(raw), 'size': len(raw)})
            page_manifest['manifestSha256'] = PUBLICATION.stable(page_manifest)
            (page_dir / 'page.md').write_bytes(page_raw)
            (page_dir / 'manifest.json').write_bytes(PUBLICATION.json_bytes(page_manifest))
            aggregate_text = ('---\npaper_digest_page_type: index\n---\n'
                              f'conference-{conference_id}\n')
            aggregate = {'contract': 'conference-aggregate-staging-v1', 'version': 1,
                         'status': 'complete', 'conferenceId': conference_id, 'aggregateId': 'one',
                         'pagePath': f'content/posts/conference-{conference_id}.md',
                         'markdown': aggregate_text, 'markdownSha256': PUBLICATION.sha_bytes(aggregate_text.encode())}
            aggregate['manifestSha256'] = PUBLICATION.stable(aggregate)
            (aggregate_dir / 'aggregate.md').write_text(aggregate_text)
            (aggregate_dir / 'manifest.json').write_bytes(PUBLICATION.json_bytes(aggregate))
            analysis_file = root / 'conference-analysis-executions' / execution_id / 'analysis.json'
            analysis_file.parent.mkdir(parents=True)
            analysis_file.write_bytes(analysis_raw)
            completion = {'processId': process_id, 'authority': {'conferenceId': conference_id}}
            completion['receiptSha256'] = PUBLICATION.stable(completion)
            state = {'processId': process_id, 'status': 'complete', 'authority': completion['authority'],
                     'completionReceiptSha256': completion['receiptSha256'],
                     'items': {paper_id: {'status': 'complete', 'analysisRunId': execution_id,
                               'analysisProof': {'analysisSha256': PUBLICATION.sha_bytes(analysis_raw)},
                               'pageProof': {key: page_manifest[key] for key in ('manifestSha256', 'contentSha256')}}},
                     'aggregate': {key: aggregate[key] for key in ('manifestSha256', 'markdownSha256', 'aggregateId', 'pagePath')}}
            (process_dir / 'state.json').write_bytes(PUBLICATION.json_bytes(state))
            (process_dir / 'completion-receipt.json').write_bytes(PUBLICATION.json_bytes(completion))
            author_proof = {key: page_manifest[key] for key in
                            ('analysisSha256', 'completionReceiptSha256', 'sourceSnapshotSha256', 'authors')}
            with patch.object(PUBLICATION, 'PROCESS_ROOT', root / 'processes'), \
                    patch.object(PUBLICATION, 'PAGE_ROOT', root / 'pages'), \
                    patch.object(PUBLICATION, 'AGGREGATE_ROOT', root / 'aggregates'), \
                    patch.object(PUBLICATION, 'RUNTIME', root), \
                    patch.object(PUBLICATION, 'verify_process_author_sources', return_value={paper_id: author_proof}):
                bundle = PUBLICATION.process_bundle(conference_id, process_id)
                self.assertEqual(len(bundle['files']), 6)
                self.assertEqual(sum(record['kind'] == 'sidecar' for record in bundle['files']), 4)
                self.assertEqual(bundle['imageFiles'], [])
                # Admission alone is not approval: a modified export still fails cold replay.
                asset = page_manifest['assets'][0]
                target = page_dir / 'assets' / asset['path']
                target.write_bytes(target.read_bytes() + b'changed')
                with self.assertRaisesRegex(PUBLICATION.ConferencePublicationError, '资产与 staging 不一致'):
                    PUBLICATION.process_bundle(conference_id, process_id)

    def test_author_gate_replays_real_multilevel_block_but_rejects_changed_or_unrelated_comments(self):
        packet = render_fixture.ConferencePageRenderTest().packet()
        page = RENDERER.render_packet(packet)['markdown']
        proof = {'analysisSha256': 'a' * 64, 'completionReceiptSha256': 'b' * 64,
                 'sourceSnapshotSha256': 'c' * 64, 'authors': packet['paper']['apiReaderAuthors']['authors']}
        original = str(page)
        PUBLICATION.validate_staged_authors(proof, page, proof)
        self.assertEqual(page, original)
        start, end = PUBLICATION.TAG_HIERARCHY_START, PUBLICATION.TAG_HIERARCHY_END
        block = page[page.index(start):page.index(end) + len(end)]
        for modified in (
                page.replace('**研究分类**', '**伪造分类**'),
                page.replace(end, ''),
                page.replace(block, block + '\n' + block),
                page.replace('## 👥 作者与机构', '<!--任意包装注释-->\n## 👥 作者与机构'),
                page.replace('## 👥 作者与机构', '<div>伪造包装</div>\n## 👥 作者与机构')):
            with self.subTest(modified=modified[:80]), self.assertRaises(PUBLICATION.ConferencePublicationError):
                PUBLICATION.validate_staged_authors(proof, modified, proof)

    def test_export_path_admission_rejects_other_assets_and_cross_kind_paths(self):
        prefix = 'static/data/papers/2026-09-07/conference-' + 'a' * 24 + '/'
        for name in PUBLICATION.CONFERENCE_WORKBENCH_NAMES:
            self.assertEqual(PUBLICATION.safe_relative(prefix + name, 'export'), prefix + name)
        for path in (prefix + 'notes.md', prefix + '../citation.json',
                     prefix.replace('conference-', 'arxiv-') + 'citation.json',
                     prefix.replace('2026-09-07', 'today') + 'citation.json',
                     prefix.replace('a' * 24, 'a' * 23) + 'citation.json',
                     prefix + 'nested/citation.json', '/' + prefix + 'citation.json'):
            with self.subTest(path=path), self.assertRaises(PUBLICATION.ConferencePublicationError):
                PUBLICATION.safe_relative(path, 'export')

    def test_publication_cold_rebuilds_all_four_exports_from_real_saved_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            packet, result, manifest, records = self.records(Path(directory))
            original = copy.deepcopy(packet['paper'])
            verified = PUBLICATION.validate_conference_workbench_assets(
                packet['paper_id'], manifest, result['markdown'], records, {'papers': [packet['paper']]})
            self.assertEqual(len(verified), 4)
            self.assertEqual(packet['paper'], original)
            self.assertEqual({Path(record['path']).name for record in verified},
                             PUBLICATION.CONFERENCE_WORKBENCH_NAMES)

    def test_consistently_resigned_bibliography_cannot_replace_the_saved_source(self):
        with tempfile.TemporaryDirectory() as directory:
            packet, result, manifest, records = self.records(Path(directory))
            record = next(item for item in records if item['path'].endswith('citation.bib'))
            filename = Path(record['sourcePath'])
            original_sha = record['sourceSha256']
            raw = filename.read_bytes().replace('会议论文'.encode(), '伪造标题'.encode())
            filename.write_bytes(raw)
            record.update(sourceSha256=hashlib.sha256(raw).hexdigest(), size=len(raw))
            page = result['markdown'].replace(original_sha, record['sourceSha256'])
            with self.assertRaisesRegex(PUBLICATION.ConferencePublicationError, '导出字节'):
                PUBLICATION.validate_conference_workbench_assets(
                    packet['paper_id'], manifest, page, records, {'papers': [packet['paper']]})

    def test_sidecar_online_verification_checks_real_final_urls_and_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            packet, _, _, records = self.records(Path(directory))
            generation = {'files': records}
            pages = [{'url': 'https://example.com/audio-paper-digest-blog/posts/conference-paper/'}]
            objects = {url: Path(record['sourcePath']).read_bytes()
                       for url, record in PUBLICATION.conference_sidecar_urls(pages, generation)}
            baseline = {'status': 'passed', 'contract': PUBLICATION.GATE_CONTRACT,
                        'checks': [{'url': pages[0]['url'], 'sha256': 'a' * 64}]}
            with patch.object(PUBLICATION, 'verify_publication_urls', return_value=baseline), \
                    patch.object(PUBLICATION, 'fetch_public', side_effect=lambda url: {'url': url, 'body': objects[url]}):
                passed = PUBLICATION.verify_conference_publication_urls(pages, [], generation)
                self.assertEqual(len(passed['checks']), 5)
            with patch.object(PUBLICATION, 'verify_publication_urls', return_value=baseline), \
                    patch.object(PUBLICATION, 'fetch_public', side_effect=lambda url: {'url': url, 'body': b'wrong deployment bytes'}):
                with self.assertRaisesRegex(PUBLICATION.ConferencePublicationError, '线上地址或实际字节'):
                    PUBLICATION.verify_conference_publication_urls(pages, [], generation)
