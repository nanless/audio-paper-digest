import importlib.util
from pathlib import Path
import sys
import unittest

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location('reader_header_condition_publisher', SCRIPTS / 'publish-to-blog.py')
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class HeaderConditionUnits(unittest.TestCase):
    def test_conditions_and_true_metric_units(self):
        def failures(header, value='1.23', quotes=None):
            return publisher._reader_table_header_unit_evidence_failures(
                {'header': ['模型', header], 'rows': [['Model', value]]}, quotes or [])
        for header in ['多数模型 -10 dB', 'SNR +10 dB', 'Noise 0 dB', '−10 dB', '-10 (dB)']:
            self.assertEqual(failures(header, '39–46%'), [], header)
        for header in ['EDT (s)', 'C50 dB', 'P95 [s]', 'P5 [s]', 'SI-SDR 提升 dB', 'EER (%)', 'Top-1 (%)', 'Top 1 (%)']:
            self.assertEqual(len(failures(header)), 1, header)
        self.assertEqual(failures('C50 dB', quotes=['C50 is 1.23 dB under the measured setup.']), [])
        self.assertEqual(len(failures('C50 dB', quotes=['C50 is not 1.23 dB in this setup.'])), 1)


if __name__ == '__main__':
    unittest.main()
