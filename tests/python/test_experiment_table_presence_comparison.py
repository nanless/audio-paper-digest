import gzip
import hashlib
import json
import unittest
from pathlib import Path
from test_experiment_table_source_identity import validate

# The input is an unchanged extraction of analysisCheckpoint and sealed source.txt.
# It does not authorize adoption or replace production provenance checks.
class PresenceComparisonTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        raw=(Path(__file__).resolve().parents[1]/'fixtures/presence-comparison-daily-20261021-real.json.gz').read_bytes()
        assert hashlib.sha256(raw).hexdigest()=='2f27661fdc6f738b5eb16db8dca92118f4ec8d872f52b76c1cbc1fcf70cabe09'
        cls.f=json.loads(gzip.decompress(raw))
        for key in ('analysis','source'):
            assert hashlib.sha256(cls.f[key].encode()).hexdigest()==cls.f['provenance'][key+'Sha256']

    def test_real_paid_checkpoint_unchanged(self):
        self.assertIsNone(validate(self.f['analysis'],self.f['source']))
        self.assertIn('没有保留关键消融',self.f['provenance']['originalFailure'])

    def test_reject_missing_measurement_or_hypothetical_and_foreign_claims(self):
        a=self.f['analysis']; s=self.f['source']
        mutations=[a.replace('有草图后','有提示后'),a.replace('无草图时','原设置时'),
                   a.replace('| 60.8 | 67.6 |','| 61.8 | 67.6 |'),a.replace('本组比较','本组介绍'),
                   a.replace('本组比较','计划比较'),a.replace('Avg. % ↑','Avg. ms ↑'),
                   a.replace('| 直接对照 | 0.5 / 0.2 | 60.8 | 67.6 |','| 直接对照 | 0.5 / 0.2 | 60.8 | 69.5 |').replace('| SKAD | 1.0 | 63.7 | 69.5 |','| SKAD | 1.0 | 63.7 | 67.6 |')]
        mutations += [a.replace('无草图时',prefix+'无草图时') for prefix in ('如果','假设','假定','假如','倘若','若','设想','拟','该研究中，','该论文中，','文献中，','据报告，','他人实验中，','未来实验中，','没有观察到：','“')]
        for text in mutations:
            self.assertRegex(validate(text,s),'没有保留关键消融')
        for source in (s.replace('without','excluding').replace('Without','Excluding'),
                       s.replace('First, directly applying','Hypothetical experiment: directly applying'),
                       s.replace('First, directly applying','Other study: directly applying'),
                       *[s.replace('First, directly applying',prefix+'directly applying') for prefix in ('In [12], ','Zhang et al. ','文献[12]报告，')]):
            self.assertRegex(validate(a,source),'没有保留关键消融')

if __name__=='__main__':
    unittest.main()
