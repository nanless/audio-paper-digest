import copy
import hashlib
import json
import unittest
from test_publish_to_blog import publish_to_blog as publish


def sample():
    source_sha = hashlib.sha256(b'sealed original source').hexdigest()
    label = 'Control data'
    table = {
        'ordinal': 1, 'recoveryStatus': 'complete', 'sourceDomSha256': 'a' * 64,
        'matrix': [[label, label, label], ['Base', '12.4%', '3.1%']],
        'cells': [{'row': 0, 'column': 0, 'colspan': 3, 'rowspan': 1,
                   'text': label, 'sourceDomSha256': 'b' * 64}],
    }
    payload = json.dumps({'flattenedTextSha256': source_sha, 'tables': [table]})
    paper = {
        'sourceSha256': source_sha,
        'analysisManifest': {'sourceAcquisition': {
            'sourceSha256': source_sha,
            'structuredArtifactsSha256': hashlib.sha256(payload.encode()).hexdigest(),
        }},
        'apiReaderPlan': {'structuredSourcePayload': payload},
    }
    binding = {'sourceTableOrdinal': 1, 'sourceTableDomSha256': 'a' * 64}
    cell = {'sourceRow': 0, 'sourceColumn': 2, 'sourceDomSha256': 'b' * 64,
            'sourceText': label, 'renderedText': ''}
    return paper, binding, cell, table


class FullWidthLabelDisplayTests(unittest.TestCase):
    def test_source_payload_and_full_dom_span_allow_only_empty_display(self):
        paper, binding, cell, _ = sample()
        before = copy.deepcopy(paper)
        self.assertTrue(publish._reader_merged_cell_matches(paper, binding, cell, ''))
        self.assertFalse(publish._reader_merged_cell_matches(paper, binding, cell, 'Other'))
        self.assertEqual(paper, before)

    def test_wrong_source_coordinates_hash_and_partial_span_reject(self):
        for fields in [{'sourceColumn': '2'}, {'sourceColumn': 3}, {'sourceRow': 1},
                       {'sourceDomSha256': 'c' * 64}, {'sourceText': 'Other'}]:
            with self.subTest(fields=fields):
                paper, binding, cell, _ = sample()
                cell.update(fields)
                self.assertFalse(publish._reader_merged_cell_matches(paper, binding, cell, ''))
        for changes in [{'colspan': 2}, {'rowspan': 2}, {'rowspan': '2'}, {'text': '0.5'}]:
            with self.subTest(changes=changes):
                paper, binding, cell, table = sample()
                table['cells'][0].update(changes)
                payload = json.dumps({'flattenedTextSha256': paper['sourceSha256'], 'tables': [table]})
                paper['apiReaderPlan']['structuredSourcePayload'] = payload
                paper['analysisManifest']['sourceAcquisition']['structuredArtifactsSha256'] = hashlib.sha256(payload.encode()).hexdigest()
                self.assertFalse(publish._reader_merged_cell_matches(paper, binding, cell, ''))
        paper, binding, cell, _ = sample()
        paper['apiReaderPlan']['structuredSourcePayload'] += ' '
        self.assertFalse(publish._reader_merged_cell_matches(paper, binding, cell, ''))
