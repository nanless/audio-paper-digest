import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from publish_common import _source_experiment_evidence


class SourceExperimentEvidenceRomanSectionsTest(unittest.TestCase):
    """与 Node sourceExperimentEvidence 对齐：罗马数字章节号同样界定实验证据范围。"""

    SOURCE = '\n'.join([
        'I Introduction', 'Adaptation can fail without care.',
        'IV Experimental Setup', 'We train on simulated data.',
        'V Results and Discussion', 'Our model improves WER.',
        'VI Limitations', 'Prolonged adaptation degrades speech intelligibility.',
        'VII Conclusion', 'We conclude.',
    ])

    def test_roman_numbered_headings_bound_the_experiment_evidence(self):
        evidence = _source_experiment_evidence(self.SOURCE)
        self.assertIn('Our model improves WER.', evidence)
        self.assertIn('We train on simulated data.', evidence)
        self.assertNotIn('degrades speech intelligibility', evidence)
        self.assertNotIn('Adaptation can fail', evidence)

    def test_arabic_numbered_headings_keep_working(self):
        source = '1 Introduction\nfail text\n4.1 Experiments\nresult text\n6 Conclusion\ndegrades text\n'
        evidence = _source_experiment_evidence(source)
        self.assertIn('result text', evidence)
        self.assertNotIn('degrades text', evidence)
        self.assertNotIn('fail text', evidence)


if __name__ == '__main__':
    unittest.main()
