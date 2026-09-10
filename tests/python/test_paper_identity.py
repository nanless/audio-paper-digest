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

    def test_conference_ledger_coordinates_match_js_canonical_id(self) -> None:
        conference = {"id": "icassp-2026", "year": 2026}
        source_identity = {"type": "icassp-arnumber", "value": "10910001"}
        expected = "conference:icassp:2026:icassp-arnumber:10910001"
        self.assertEqual(identity.canonical_conference_paper_id(conference, source_identity), expected)
        self.assertEqual(identity.assert_canonical_conference_paper_id(
            expected, conference, source_identity), expected)
        with self.assertRaisesRegex(ValueError, "conference paperId"):
            identity.assert_canonical_conference_paper_id(
                "icassp-2026:icassp-arnumber:10910001", conference, source_identity)

    def test_official_conference_ids_preserve_dots_and_letters(self) -> None:
        conference = {"id": "odyssey-2026", "year": 2026}
        source_identity = {"type": "conference-paper-id", "value": "ando26_odyssey.1"}
        expected = "conference:odyssey:2026:conference-paper-id:ando26_odyssey.1"
        self.assertEqual(identity.canonical_conference_paper_id(conference, source_identity), expected)

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

    def test_official_url_accepts_one_trailing_slash_and_rejects_ambiguous_paths(self) -> None:
        trailing = "https://aclanthology.org/2026.eacl-long.102/"
        self.assertEqual(identity.validate_official_url(trailing, "official record URL"), trailing)
        without_trailing = "https://aclanthology.org/2026.eacl-long.102"
        self.assertEqual(identity.validate_official_url(
            without_trailing, "official record URL"), without_trailing)
        for url in (
            "https://aclanthology.org/2026.eacl-long.102//",
            "https://aclanthology.org/2026.eacl-long.102//appendix",
            "https://aclanthology.org/2026.eacl-long.102/./appendix",
            "https://aclanthology.org/2026.eacl-long.102/../appendix",
            "https://aclanthology.org/2026.eacl-long.102/%2e%2e/appendix",
            "https://aclanthology.org/2026.eacl-long.102/%2Fappendix",
            "https://ACLANthology.org/2026.eacl-long.102/",
        ):
            with self.subTest(url=url), self.assertRaisesRegex(
                    ValueError, "unsafe or non-canonical|canonical public HTTPS|canonical URL spelling"):
                identity.validate_official_url(url, "official record URL")

    def test_large_official_collaboration_author_lists_remain_bounded_without_truncation(self) -> None:
        record = copy.deepcopy(VECTORS["vectors"][1]["record"])
        record["citation"]["authors"] = [f"Author {index + 1}" for index in range(102)]
        self.assertEqual(len(identity.normalize_identity(record)["citation"]["authors"]), 102)
        record["citation"]["authors"] = [f"Author {index + 1}" for index in range(1001)]
        with self.assertRaisesRegex(ValueError, "at most 1000 names"):
            identity.normalize_identity(record)


if __name__ == "__main__":
    unittest.main()
