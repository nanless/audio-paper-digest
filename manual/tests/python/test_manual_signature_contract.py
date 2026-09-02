import json
import os
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
import sys
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

from publish_common import (  # noqa: E402
    MANUAL_V6_SIGNATURE_CONTRACT,
    PublishDataValidationError,
    _manual_v6_canonical_json,
    _manual_v6_hash,
    _manual_v6_signature_value,
    _manual_v6_text,
)


class ManualSignatureContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture = os.path.join(ROOT, 'manual', 'tests', 'fixtures', 'manual-stable-json-vectors.json')
        with open(fixture, encoding='utf-8') as handle:
            cls.vectors = json.load(handle)

    def test_shared_stable_json_unicode_nfkc_and_hash_vectors(self):
        self.assertEqual(self.vectors['contract'], MANUAL_V6_SIGNATURE_CONTRACT)
        for vector in self.vectors['accepted']:
            canonical = _manual_v6_canonical_json(
                _manual_v6_signature_value(vector['value'])
            )
            self.assertEqual(canonical, vector['canonicalJson'], vector['name'])
            self.assertEqual(_manual_v6_hash(vector['value']), vector['sha256'], vector['name'])
            self.assertEqual(_manual_v6_text(vector['nfkcInput']), vector['nfkcText'], vector['name'])

    def test_non_ascii_keys_and_illegal_numbers_fail_closed(self):
        for vector in self.vectors['rejected']:
            with self.assertRaises(PublishDataValidationError, msg=vector['name']):
                _manual_v6_signature_value(vector['value'])
        for value in (2 ** 53, float(2 ** 53), float('nan'), float('inf'), -0.0):
            with self.assertRaises(PublishDataValidationError):
                _manual_v6_signature_value({'value': value})


if __name__ == '__main__':
    unittest.main()
