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
