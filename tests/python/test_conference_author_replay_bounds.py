"""Transport limits only; synthetic JSON is not an author/source qualification."""
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))


class ConferenceAuthorReplayBoundsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('conference_author_bounds_publisher', ROOT / 'scripts/publish-conference.py')
        cls.publisher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.publisher)
        cls.real_subprocess = staticmethod(cls.publisher.load_publish_to_blog()._run_bounded_subprocess)

    def run_transport(self, output_bytes):
        proof = {'verified': True, 'papers': [{'paperId': 'synthetic-transport-only', 'padding': ''}]}
        padding = output_bytes - len(json.dumps(proof, separators=(',', ':')).encode())
        code = ('import json,sys; value=' + repr(proof) + '; '
                "value['papers'][0]['padding']='x'*" + str(padding)
                + "; sys.stdout.write(json.dumps(value,separators=(',',':')))" )
        observed = {}

        def actual_bounded_child(command, **kwargs):
            self.assertTrue(command[1].endswith('conference-publication-author-replay-cli.js'))
            self.assertEqual(kwargs['timeout_seconds'], 60)
            self.assertEqual(kwargs['max_output_bytes'], 2 * 1024 * 1024)
            self.assertGreaterEqual(kwargs['pass_fds'][0], 3)
            # Replace only the author's semantic program with explicit synthetic
            # output; exercise the real process runner, FD and output limit.
            result = self.real_subprocess([sys.executable, '-c', code], **kwargs)
            observed['result'] = result
            return result

        runner = type('TransportRunner', (), {'_run_bounded_subprocess': staticmethod(actual_bounded_child)})()
        with mock.patch.object(self.publisher, 'load_publish_to_blog', return_value=runner):
            result = self.publisher.verify_process_author_sources(
                {'items': {'synthetic-transport-only': {}}}, {})
        return result, observed['result']

    def test_actual_1354_output_size_exceeding_old_one_mib_fits_new_two_mib(self):
        size = 1_129_245
        self.assertGreater(size, 1024 * 1024)
        result, child = self.run_transport(size)
        self.assertEqual(set(result), {'synthetic-transport-only'})
        self.assertEqual(len(child.stdout.encode()), size)
        self.assertFalse(child.output_truncated)
        self.assertFalse(child.timed_out)

    def test_larger_than_two_mib_still_rejects_without_parsing_a_partial_proof(self):
        with self.assertRaisesRegex(self.publisher.ConferencePublicationError, '会议作者来源未由'):
            self.run_transport(2 * 1024 * 1024 + 1)


if __name__ == '__main__':
    unittest.main()
