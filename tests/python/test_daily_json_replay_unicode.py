import json
import subprocess
import tempfile
from pathlib import Path
import unittest
from test_publish_to_blog import publish_to_blog as publish


class DailyJsonReplayUnicodeTest(unittest.TestCase):
    def test_private_transport_exactly_matches_node_well_formed_json(self):
        for value in [
                {'text': 'before\ud835after'}, {'text': '\udfff'},
                {'text': '\ud835\udc00'}, {'text': '𝒜 😀 and \\ud835'},
                {'\ud835': ['中文', '\ud835', '\udc00']}]:
            before = json.dumps(value, ensure_ascii=True)
            expected = subprocess.run(['node', '-e',
                'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s))));'],
                input=before.encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout
            self.assertEqual(publish._daily_fresh_compact_json_bytes(value), expected)
            self.assertEqual(json.dumps(value, ensure_ascii=True), before)

    def test_invalid_objects_and_nonfinite_numbers_remain_rejected(self):
        for value in [{'value': float('nan')}, {'value': float('inf')}, {'value': object()}]:
            with self.assertRaises(publish.PublishDataValidationError):
                publish._daily_fresh_compact_json_bytes(value)

    def test_atomic_manifest_write_preserves_utf16_values_and_normal_unicode(self):
        value = {'publishedPapers': [{'sourceQuote': '中文\ud835正文',
                 'literal': '\\ud835', 'astral': '𝒜 😀'}]}
        original = json.dumps(value, ensure_ascii=True)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'manifest.json'
            publish.atomic_write_json(path, value, mode=0o600)
            raw = path.read_bytes()
            self.assertIn('中文'.encode(), raw)
            self.assertIn(b'\\ud835', raw)
            self.assertEqual(json.loads(raw), value)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.dumps(value, ensure_ascii=True), original)
