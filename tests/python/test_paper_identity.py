"""Cross-runtime conformance tests for paper-identity-v1."""

from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from scripts import paper_identity as identity


VECTORS = json.loads((Path(__file__).resolve().parents[2] / "config" / "paper-identity-v1-vectors.json").read_text("utf-8"))


class PaperIdentityTests(unittest.TestCase):
    def test_vectors_are_canonical_and_cross_runtime_stable(self) -> None:
        self.assertEqual(VECTORS["contract"], identity.CONTRACT)
        for vector in VECTORS["vectors"]:
            normalized = identity.normalize_identity(vector["record"])
            self.assertEqual(normalized, vector["normalized"], vector["name"])
            self.assertEqual(identity.stable_json(normalized), vector["stableJson"], vector["name"])
            self.assertEqual(identity.identity_sha256(normalized), vector["identitySha256"], vector["name"])
            self.assertEqual(identity.record_sha256(normalized), vector["recordSha256"], vector["name"])

    def test_citation_is_not_identity_and_title_cannot_be_identity_scheme(self) -> None:
        record = copy.deepcopy(VECTORS["vectors"][1]["record"])
        original = identity.identity_sha256(record)
        record["citation"]["title"] = "A different display title is not an identifier"
        self.assertEqual(identity.identity_sha256(record), original)
        record["canonicalId"] = "conference:icassp:2026:icassp-arnumber:A-title"
        with self.assertRaisesRegex(ValueError, "canonicalId|invalid"):
            identity.normalize_identity(record)

    def test_unknown_fields_and_unsafe_url_fail_closed(self) -> None:
        record = copy.deepcopy(VECTORS["vectors"][0]["record"])
        record["title"] = "not a schema field"
        with self.assertRaisesRegex(ValueError, "unknown or missing"):
            identity.normalize_identity(record)
        record = copy.deepcopy(VECTORS["vectors"][1]["record"])
        for url in ("https://user:pass@ieeexplore.ieee.org/document/10910001", "https://127.0.0.1/document/10910001", "https://ieeexplore.ieee.org/document/../10910001"):
            changed = copy.deepcopy(record)
            changed["source"]["url"] = url
            with self.assertRaisesRegex(ValueError, "source.url"):
                identity.normalize_identity(changed)


if __name__ == "__main__":
    unittest.main()
