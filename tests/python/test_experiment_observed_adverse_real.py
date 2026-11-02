import gzip
import hashlib
import json
import re
import sys
import unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'scripts'))
import publish_common as common
FIXTURE = json.loads(gzip.decompress((ROOT/'tests/fixtures/experiment-observed-adverse-20261102.json.gz').read_bytes()))
MUTATIONS = json.loads((ROOT/'tests/fixtures/experiment-observed-adverse-mutations.json').read_text())


def wrap(value, mode):
    return '```\n'+value+'\n```' if mode == 'code' else '“\n'+value+'\n”' if mode == 'quote' else '<blockquote>'+value+'</blockquote>'


class ObservedAdverseRealTest(unittest.TestCase):
    def test_real_upstreams_are_not_latest_unsaved_structure_responses(self):
        for index, group in enumerate(['listening', 'duration']):
            item = FIXTURE['items'][index]
            with self.subTest(group=group):
                self.assertTrue(item['notStructureRepairRawResponse'])
                self.assertEqual(item['checkpointName'], 'analysisCheckpoint')
                self.assertEqual(hashlib.sha256(item['analysis'].encode()).hexdigest(), item['analysisSha256'])
                self.assertEqual(hashlib.sha256(item['sourceText'].encode()).hexdigest(), item['sourceFiles']['source.txt'])
                self.assertEqual(item['analysisSha256'], ['e44660460d3c259f915fb7168bfa47a709e5615d2db4ac6ab61b512efbacfa49', 'a7ec0be00a4c7aa94468173bee3184741b49f5bd0c5a4bf65679eb3db144819c'][index])
                self.assertIn('没有保留负面证据', item['stageFailure'])
                results = common._extract_analysis_section(item['analysis'], '实验结果')
                helper = [common._source_bound_listening_score_regression, common._source_bound_rendered_duration_shortfall][index]
                before = json.dumps(item, ensure_ascii=False)
                self.assertTrue(helper(results, common.extract_markdown_tables(results), item['sourceText']))
                self.assertEqual(json.dumps(item, ensure_ascii=False), before)
                issue = common._validate_experiment_table_evidence_depth(item['analysis'], source_text=item['sourceText'])
                if index == 0:
                    self.assertIn('没有保留关键消融', issue)
                else:
                    self.assertIsNone(issue)

    def test_mutations_do_not_borrow_numbers_direction_or_foreign_results(self):
        for index, group in enumerate(['listening', 'duration']):
            item = FIXTURE['items'][index]
            results = common._extract_analysis_section(item['analysis'], '实验结果')
            helper = [common._source_bound_listening_score_regression, common._source_bound_rendered_duration_shortfall][index]
            for mutation in MUTATIONS[group]:
                with self.subTest(group=group, name=mutation['name']):
                    r, s, tables = results, item['sourceText'], None
                    target = mutation['target']
                    if target in ['source', 'results']:
                        value = s if target == 'source' else r
                        self.assertIn(mutation['old'], value)
                        value = value.replace(mutation['old'], mutation['new'])
                        if target == 'source':
                            s = value
                        else:
                            r = value
                    elif target == 'emptySource':
                        s = ''
                    elif target == 'noTables':
                        tables = []
                    elif target == 'resultPrefix':
                        self.assertIn(mutation['marker'], r)
                        r = r.replace(mutation['marker'], mutation['new']+mutation['marker'])
                    elif target == 'sourcePrefix':
                        self.assertIn(mutation['marker'], s)
                        s = s.replace(mutation['marker'], mutation['new']+mutation['marker'])
                    elif target == 'resultWrap':
                        r = wrap(r, mutation['new'])
                    elif target == 'sourceWrap':
                        s = wrap(s, mutation['new'])
                    self.assertFalse(helper(r, common.extract_markdown_tables(r) if tables is None else tables, s))


if __name__ == '__main__':
    unittest.main()
