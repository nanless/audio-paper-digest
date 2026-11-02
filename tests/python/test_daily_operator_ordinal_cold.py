import copy
import hashlib
import json
import os
from pathlib import Path
import unittest

from test_publish_to_blog import publish_to_blog as publish


@unittest.skipUnless(os.environ.get('PD_OPERATOR_ORDINAL_REAL_EVIDENCE'), 'Requires explicit SHA-bound actual two paid drafts')
class ActualOperatorOrdinalColdTests(unittest.TestCase):
    def test_existing_private_fd_bridge_replays_operator_and_cannot_cache_stripped_markers(self):
        raw = Path(os.environ['PD_OPERATOR_ORDINAL_REAL_EVIDENCE']).read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), os.environ['PD_OPERATOR_ORDINAL_REAL_EVIDENCE_SHA256'])
        evidence = json.loads(raw)
        for entry in evidence['cases']:
            paper = entry['privateFinalizerProjection']
            proof = paper['analysisManifest']['stages']['apiReaderArticle']['operatorProvenance']
            source_text = (Path(proof['originalCandidateFile']).parent.parent / 'sources' / entry['paperId']
                           / 'generation-000001' / 'source.txt').read_text()
            self.assertTrue(publish._has_source_bound_reader_patch_completion(paper))
            publish._validate_reader_resource_claim_source_replay(paper, {'text': source_text}, entry['paperId'])
            changed = copy.deepcopy(paper)
            stage = changed['analysisManifest']['stages']['apiReaderArticle']
            stage.pop('operatorProvenance', None)
            stage.pop('ordinalPatchHistory', None)
            stage.pop('executionKind', None)
            self.assertTrue(publish._has_source_bound_reader_patch_completion(changed))
            with self.assertRaises(publish.PublishDataValidationError):
                publish._validate_reader_resource_claim_source_replay(changed, {'text': source_text}, entry['paperId'])
        for file, expected in evidence['originals'].items():
            self.assertEqual(hashlib.sha256(Path(file).read_bytes()).hexdigest(), expected)


if __name__ == '__main__':
    unittest.main()
