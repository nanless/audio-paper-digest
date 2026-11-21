import copy
import hashlib
import unittest
from pathlib import Path
from unittest import mock

import fitz

from test_publication_source_display_projections import author_fixture, reseal_author
from test_publish_to_blog import publish_to_blog as blog


AFFILIATION = 'University of Bristol{alice, bob, carol,'
SOURCE = 'Muhuan Wu\nAffiliation: ' + AFFILIATION + '\nAbstract\n'
PAGE = ('Title\nMuhuan Wu4\n4University of Bristol\n'
        '{alice, bob, carol,\ndave}@example.edu\nAbstract\nBody\n')


class AuthorContactDisplayTests(unittest.TestCase):
    def test_author_marker_institution_and_complete_contact_group_are_all_required(self):
        project = blog._author_contact_tail_prefix
        self.assertEqual(project('Muhuan Wu', AFFILIATION, SOURCE, PAGE), 'University of Bristol')
        variants = {
            'no author marker': PAGE.replace('Muhuan Wu4', 'Muhuan Wu'),
            'wrong author marker': PAGE.replace('Muhuan Wu4', 'Muhuan Wu3'),
            'wrong institution': PAGE.replace('4University of Bristol', '4University of Elsewhere'),
            'institution not independent': PAGE.replace('4University of Bristol\n', '4University of Bristol '),
            'missing email boundary': PAGE.replace('\n{alice,', '\nContact: {alice,'),
            'email group incomplete': PAGE.replace('}@example.edu', '} contact'),
            'duplicate author mapping': PAGE.replace('Muhuan Wu4', 'Muhuan Wu4\nMuhuan Wu4'),
            'body evidence only': PAGE.replace('Title\n', 'Abstract\n'),
        }
        for label, changed in variants.items():
            with self.subTest(case=label):
                self.assertEqual(project('Muhuan Wu', AFFILIATION, SOURCE, changed), AFFILIATION)
        for name, affiliation, source in [
            ('Other Person', AFFILIATION, SOURCE),
            ('Muhuan Wu', AFFILIATION, SOURCE + 'Affiliation: ' + AFFILIATION + '\n'),
            ('Muhuan Wu', AFFILIATION, SOURCE.replace('Bristol{', 'Elsewhere{')),
            ('Muhuan Wu', 'University of Bristol', SOURCE),
            ('Muhuan Wu', 'University of Bristol {Research, Engineering, Science}', SOURCE),
            ('Muhuan Wu', 'University of Bristol{alice, bob, carol}@example.edu', SOURCE),
        ]:
            with self.subTest(affiliation=affiliation, name=name):
                self.assertEqual(project(name, affiliation, source, PAGE), affiliation)

    def fixture(self):
        paper = author_fixture(['Muhuan Wu'])
        raw = paper['apiReaderAuthors']
        author = raw['authors'][0]
        bound = raw['identity']['authors'][0]
        author['affiliations'] = [AFFILIATION]
        bound['affiliations'] = [AFFILIATION]
        bound['nameBinding'] = {'sourceKind': 'html_dom', 'sourceValue': 'Muhuan Wu',
                                'sourceDomSha256': raw['sourceDomSha256']}
        bound['affiliationBindings'] = [{'sourceKind': 'html_dom', 'association': 'direct_author',
                                        'sourceValue': AFFILIATION,
                                        'sourceDomSha256': raw['sourceDomSha256']}]
        paper['freshRewriteProvenance'] = {'runId': '12345678-1234-4234-8234-123456789abc'}
        reseal_author(paper)
        payload = {'contract': blog.LLM_API_READER_CONTRACT, 'readerAuthors': raw}
        with fitz.open() as doc:
            page = doc.new_page()
            page.insert_text((72, 72), PAGE)
            pdf = doc.tobytes()
        files = {'files': ((Path('/unused/source.txt'), 0, '0' * 64, 1024),
                           (Path('/unused/source.pdf'), len(pdf), hashlib.sha256(pdf).hexdigest(), 1048576))}
        details = {'text': SOURCE, 'readerAuthors': {
            'authors': copy.deepcopy(raw['authors']), 'sourceDomSha256': raw['sourceDomSha256']}}
        return paper, payload, files, details, pdf

    def test_display_uses_existing_safe_source_reader_and_preserves_every_raw_field(self):
        paper, payload, files, details, pdf = self.fixture()
        before = copy.deepcopy((paper, payload))
        with mock.patch.object(blog, '_daily_fresh_read_bundle_source_identity', return_value=(files, details)) as source_read, \
                mock.patch.object(blog, '_daily_fresh_read_private_file', return_value=pdf):
            view = blog._api_reader_author_display(paper, payload)
            self.assertEqual(view['authors'], [{'name': 'Muhuan Wu', 'affiliations': ['University of Bristol']}])
            self.assertEqual(blog._workbench_authors(paper, payload), view['authors'])
            self.assertIn('Muhuan Wu：University of Bristol', blog._render_api_reader_author_block(paper, payload))
            self.assertGreaterEqual(source_read.call_count, 1)
        self.assertEqual((paper, payload), before)

    def test_source_drift_and_unbound_metadata_cannot_supply_a_clean_institution(self):
        paper, payload, files, details, pdf = self.fixture()
        with mock.patch.object(blog, '_daily_fresh_read_bundle_source_identity', side_effect=blog.PublishDataValidationError('source drift')):
            with self.assertRaisesRegex(blog.PublishDataValidationError, 'source drift'):
                blog._api_reader_author_display(paper, payload)
        with mock.patch.object(blog, '_daily_fresh_read_bundle_source_identity', return_value=(files, details)), \
                mock.patch.object(blog, '_daily_fresh_read_private_file', return_value=pdf + b'changed'):
            with self.assertRaisesRegex(blog.PublishDataValidationError, 'PDF 字节发生变化'):
                blog._api_reader_author_display(paper, payload)
        changed = copy.deepcopy(details)
        changed['readerAuthors']['authors'][0]['affiliations'] = ['University of Elsewhere']
        with mock.patch.object(blog, '_daily_fresh_read_bundle_source_identity', return_value=(files, changed)):
            self.assertEqual(blog._api_reader_author_display(paper, payload)['authors'][0]['affiliations'], [AFFILIATION])
        bound = paper['apiReaderAuthors']['identity']['authors'][0]
        bound['nameBinding'] = {'sourceKind': 'paper_metadata', 'sourceValue': 'Muhuan Wu',
                                'metadataSha256': paper['apiReaderAuthors']['identity']['metadataSha256']}
        reseal_author(paper)
        with mock.patch.object(blog, '_daily_fresh_read_bundle_source_identity') as reader:
            self.assertEqual(blog._api_reader_author_display(paper, payload)['authors'][0]['affiliations'], [AFFILIATION])
            reader.assert_not_called()
