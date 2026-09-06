import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from historical_page_scan import (  # noqa: E402
    HistoricalPageInventoryError,
    encoded_json,
    load_inventory_pair,
    scan_historical_pages,
    validate_ledger,
    write_inventory_pair,
)


def load_cli():
    spec = spec_from_file_location("history_inventory_cli", SCRIPTS / "history-inventory.py")
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CLI = load_cli()


def run_git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True,
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)


class HistoricalPageScanTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.repo = self.root / "blog"
        posts = self.repo / "content" / "posts"
        posts.mkdir(parents=True)
        (self.repo / "hugo.yaml").write_text(
            'baseURL: "https://example.test/blog/"\nlanguageCode: zh-CN\n', encoding="utf-8")
        (posts / "2026-01-01-paper-2601-00001.md").write_text(
            "---\n"
            'title: "Paper A"\n'
            "date: 2026-01-01\n"
            "draft: false\n"
            "tags: [语音识别, 模型评估]\n"
            "categories: [论文速递]\n"
            "paper_digest_pipeline_owned: true\n"
            "paper_digest_page_type: paper\n"
            'paper_digest_arxiv_id: "2601.00001"\n'
            'paper_digest_api_reader_contract: "beginner-researcher-v3"\n'
            f'paper_digest_api_reader_article_sha256: "{"a" * 64}"\n'
            'paper_digest_private_token: "sk-this-must-never-leave-frontmatter"\n'
            'paper_digest_sidecars: {unsafe: {sha256: "bad", url: "/Users/private/secret"}}\n'
            "---\n"
            "SECRET OLD BODY MUST NOT BE STORED\n"
            "[汇总](/blog/posts/2026-01-01/)\n"
            "[arXiv](https://arxiv.org/abs/2601.00001v2)\n",
            encoding="utf-8",
        )
        (posts / "2026-01-01.md").write_text(
            "---\n"
            'title: "Daily summary"\n'
            "date: 2026-01-01\n"
            "tags: [每日论文]\n"
            "categories: [论文速递]\n"
            "aliases: [/blog/posts/old-daily/]\n"
            "---\n"
            "[Paper A](/blog/posts/2026-01-01-paper-2601-00001/)\n"
            "[Paper A again](/blog/posts/2026-01-01-paper-2601-00001/)\n"
            "[Mind Your [m]S, Cross Your [t]S](/blog/posts/2026-01-01-paper-2601-00001/)\n"
            "Math must not become a link: \\(\\mathcal{Z}[w](1)\\)\n",
            encoding="utf-8",
        )
        (posts / "2026-04-29-conference-paper.md").write_text(
            "---\n"
            'title: "Conference paper"\n'
            "date: 2026-04-29\n"
            "tags: [语音增强]\n"
            "categories: [icassp-2026]\n"
            'paper_digest_sidecars: "/Users/private/scalar-sidecar-secret"\n'
            "---\n"
            "[IEEE](https://ieeexplore.ieee.org/document/12345678)\n",
            encoding="utf-8",
        )
        (posts / "icassp2026-task-001.md").write_text(
            "---\n"
            'title: "Conference task"\n'
            "date: 2026-04-29\n"
            "tags: [语音增强]\n"
            "categories: [icassp-2026]\n"
            "---\n"
            "[Conference paper](/blog/posts/2026-04-29-conference-paper/)\n",
            encoding="utf-8",
        )
        run_git(self.repo, "init", "-b", "main")
        run_git(self.repo, "config", "user.name", "Fixture")
        run_git(self.repo, "config", "user.email", "fixture@example.test")
        run_git(self.repo, "remote", "add", "origin", "https://example.test/fixture/blog.git")
        run_git(self.repo, "add", ".")
        run_git(self.repo, "commit", "-m", "fixture")

    def tearDown(self):
        self.temporary.cleanup()

    def test_inventory_freezes_routes_hints_links_and_hashes_without_body(self):
        ledger = scan_historical_pages(self.repo, require_clean_main=True)
        self.assertEqual(ledger["contract"], "historical-page-ledger-v1")
        self.assertEqual(ledger["source"]["branch"], "main")
        self.assertTrue(ledger["source"]["clean"])
        self.assertEqual(ledger["counts"], {"pages": 4, "papers": 2, "dailySummaries": 1,
            "conferenceSummaries": 0, "conferenceTasks": 1, "unknown": 0, "urlCollisions": 0,
            "outboundPostLinks": 5, "resolvedOutboundPostLinks": 5,
            "unresolvedOutboundPostLinks": 0, "ambiguousOutboundPostLinks": 0})
        by_name = {Path(page["path"]).name: page for page in ledger["pages"]}
        paper = by_name["2026-01-01-paper-2601-00001.md"]
        self.assertEqual(paper["scope"], {"type": "daily", "key": "2026-01-01"})
        self.assertEqual(paper["identityHints"]["status"], "single")
        self.assertEqual(paper["identityHints"]["candidates"][0]["value"], "2601.00001")
        self.assertTrue(any(link["targetUrl"] == "https://example.test/blog/posts/2026-01-01/"
                            and link["status"] == "resolved" for link in paper["outboundPostLinks"]))
        self.assertTrue(any(link["sourcePath"] == paper["path"] and link["targetPageId"]
                            for link in ledger["outboundPostLinks"]))
        self.assertTrue(any(route["taxonomy"] == "tags" and route["term"] == "语音识别"
                            and route["status"] == "unverified"
                            for route in paper["legacyTaxonomyCandidates"]))
        self.assertRegex(paper["pageId"], r"^page:[a-f0-9]{64}$")
        self.assertEqual(paper["publishedDate"], "2026-01-01")
        self.assertEqual(paper["cohortDate"], "2026-01-01")
        summary = by_name["2026-01-01.md"]
        self.assertEqual(len(summary["outboundPostLinks"]), 3)
        self.assertEqual([link["ordinal"] for link in summary["outboundPostLinks"]], [1, 2, 3])
        self.assertTrue(any(link["sourceByteEnd"] > link["sourceByteStart"]
                            and link["targetPageId"] == paper["pageId"]
                            for link in summary["outboundPostLinks"]))
        self.assertFalse(any(link["targetUrl"].endswith("/1/") for link in summary["outboundPostLinks"]))
        conference = by_name["2026-04-29-conference-paper.md"]
        self.assertEqual(conference["scope"], {"type": "conference", "key": "icassp-2026"})
        self.assertEqual(conference["identityHints"]["candidates"][0]["scheme"], "icassp-arnumber")
        serialized = encoded_json(ledger)
        self.assertNotIn(b"SECRET OLD BODY MUST NOT BE STORED", serialized)
        self.assertNotIn(b"Paper A]", serialized)
        self.assertNotIn(b"https://example.test/fixture/blog.git", serialized)
        self.assertNotIn(b"sk-this-must-never-leave-frontmatter", serialized)
        self.assertNotIn(b"/Users/private/secret", serialized)
        self.assertNotIn(b"/Users/private/scalar-sidecar-secret", serialized)
        self.assertNotIn(b"beginner-researcher-v3", serialized)
        evidence = {item["field"]: item for item in paper["publicationEvidenceRefs"]}
        self.assertIsNone(evidence["paper_digest_api_reader_contract"]["value"])
        self.assertEqual(evidence["paper_digest_arxiv_id"]["value"], "2601.00001")
        self.assertEqual(evidence["paper_digest_page_type"]["value"], "paper")
        self.assertEqual(ledger["source"]["remoteMain"]["availability"], "unavailable")
        self.assertEqual(ledger["source"]["trackedPages"]["count"], 4)
        self.assertEqual(validate_ledger(json.loads(serialized)), ledger)

    def test_pair_is_canonical_o_excl_0600_and_replayable(self):
        ledger = scan_historical_pages(self.repo, require_clean_main=True)
        output = self.root / "inventory"
        written = write_inventory_pair(output, "history.json", "history.receipt.json", ledger,
                                       expected_repo=self.repo)
        self.assertEqual(stat.S_IMODE(Path(written["ledger"]).stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(Path(written["receipt"]).stat().st_mode), 0o600)
        loaded, receipt = load_inventory_pair(Path(written["ledger"]), Path(written["receipt"]))
        self.assertEqual(loaded["ledgerSha256"], ledger["ledgerSha256"])
        self.assertEqual(receipt["ledger"]["fileSha256"], __import__("hashlib").sha256(encoded_json(ledger)).hexdigest())
        with self.assertRaises(FileExistsError):
            write_inventory_pair(output, "history.json", "history.receipt.json", ledger,
                                 expected_repo=self.repo)
        (output / "collision.receipt.json").write_text("occupied", encoding="utf-8")
        with self.assertRaises(FileExistsError):
            write_inventory_pair(output, "new.json", "collision.receipt.json", ledger,
                                 expected_repo=self.repo)
        self.assertFalse((output / "new.json").exists())
        page = self.repo / "content" / "posts" / "2026-01-01.md"
        page.write_text(page.read_text(encoding="utf-8") + "drift after scan\n", encoding="utf-8")
        guarded = self.root / "guarded"
        with self.assertRaisesRegex(HistoricalPageInventoryError, "drifted"):
            write_inventory_pair(guarded, "guarded.json", "guarded.receipt.json", ledger,
                                 expected_repo=self.repo)
        self.assertFalse((guarded / "guarded.json").exists())
        run_git(self.repo, "checkout", "--", ".")
        reserved = self.root / "reserved"
        def drift_after_reservation():
            page.write_text(page.read_text(encoding="utf-8") + "drift after reservation\n", encoding="utf-8")
        with self.assertRaisesRegex(HistoricalPageInventoryError, "drifted"):
            write_inventory_pair(reserved, "reserved.json", "reserved.receipt.json", ledger,
                                 expected_repo=self.repo, after_reservation_hook=drift_after_reservation)
        self.assertFalse((reserved / "reserved.json").exists())
        self.assertFalse((reserved / "reserved.receipt.json").exists())
        run_git(self.repo, "checkout", "--", ".")

    def test_apply_requires_clean_main_and_scan_detects_page_drift(self):
        page = self.repo / "content" / "posts" / "2026-01-01.md"
        with self.assertRaisesRegex(HistoricalPageInventoryError, "drifted"):
            scan_historical_pages(self.repo, after_scan_hook=lambda: page.write_text(
                page.read_text(encoding="utf-8") + "changed\n", encoding="utf-8"))
        run_git(self.repo, "checkout", "--", ".")
        page.write_text(page.read_text(encoding="utf-8") + "dirty\n", encoding="utf-8")
        with self.assertRaisesRegex(HistoricalPageInventoryError, "clean branch main"):
            scan_historical_pages(self.repo, require_clean_main=True)
        run_git(self.repo, "checkout", "--", ".")
        run_git(self.repo, "checkout", "-b", "feature")
        with self.assertRaisesRegex(HistoricalPageInventoryError, "clean branch main"):
            scan_historical_pages(self.repo, require_clean_main=True)

    def test_duplicate_frontmatter_and_tampered_pair_fail_closed(self):
        page = self.repo / "content" / "posts" / "2026-01-01.md"
        page.write_text("---\ntitle: one\ntitle: two\n---\nbody\n", encoding="utf-8")
        with self.assertRaisesRegex(HistoricalPageInventoryError, "duplicate YAML key|mapping key .* already defined"):
            scan_historical_pages(self.repo)
        run_git(self.repo, "checkout", "--", ".")
        owned_page = self.repo / "content" / "posts" / "2026-01-01-paper-2601-00001.md"
        owned_page.write_text(owned_page.read_text(encoding="utf-8").replace(
            "paper_digest_page_type: paper", 'paper_digest_page_type: "https://user:secret@example.test/path"'),
            encoding="utf-8")
        with self.assertRaisesRegex(HistoricalPageInventoryError, "outside the preserved enum"):
            scan_historical_pages(self.repo)
        run_git(self.repo, "checkout", "--", ".")
        ledger = scan_historical_pages(self.repo, require_clean_main=True)
        output = self.root / "pair"
        paths = write_inventory_pair(output, "history.json", "history.receipt.json", ledger,
                                     expected_repo=self.repo)
        raw = json.loads(Path(paths["ledger"]).read_text(encoding="utf-8"))
        raw["pages"][0]["bodySha256"] = "0" * 64
        Path(paths["ledger"]).write_text(json.dumps(raw, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(HistoricalPageInventoryError, "snapshotSha256|recordSha256"):
            load_inventory_pair(Path(paths["ledger"]), Path(paths["receipt"]))
        Path(paths["ledger"]).write_bytes(b'{"contract":"one","contract":"two"}\n')
        with self.assertRaisesRegex(HistoricalPageInventoryError, "duplicate keys"):
            load_inventory_pair(Path(paths["ledger"]), Path(paths["receipt"]))

    def test_cli_dry_run_is_zero_write_and_apply_writes_pair(self):
        output = self.root / "cli-output"
        dry = CLI.main(["--dry-run"], blog_repo=self.repo, output_dir=output)
        self.assertEqual(dry["status"], "dry-run")
        self.assertFalse(output.exists())
        applied = CLI.main(["--apply", "--ledger", "pages.json", "--receipt", "pages.receipt.json"],
                           blog_repo=self.repo, output_dir=output)
        self.assertEqual(applied["status"], "written")
        self.assertTrue((output / "pages.json").exists())
        for args in ([], ["--apply", "--ledger", "../x.json", "--receipt", "r.json"],
                     ["--apply", "--ledger", "same.json", "--receipt", "same.json"]):
            with self.assertRaises(HistoricalPageInventoryError):
                CLI.parse_args(args)


if __name__ == "__main__":
    unittest.main()
