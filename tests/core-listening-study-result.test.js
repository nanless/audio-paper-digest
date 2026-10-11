'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../scripts/analysis-contract');
test('听测直接给出基线与方法的实测变化时属于定量结果', () => {
 const sentence = 'In a listening study with native speakers, region-aware masking reduces perceived accent from 4.3 to 0.5 on a 0-5 scale against the unadapted baseline, and by 18-51% in seen regimes and 35-55% on unseen source languages against bilingual adaptation alone, with no measurable loss in intelligibility or naturalness.';
 assert.equal(contract.hasCoreSummaryQuantitativeEvidence(sentence), true);
 assert.equal(contract.classifySourceQuantitativeEvidence(sentence), true);
});
test('听测人数、量表范围和明确转述的旧工作不补成本次实测结果', () => {
 for (const sentence of [
  'In a listening study with native speakers, 20 raters score each clip for accent on a 0-5 scale.',
  'In a listening study with native speakers, the baseline uses 20 clips on a 0-5 scale.',
  'Prior work reports that in a listening study with native speakers, accent drops from 4.3 to 0.5 against the baseline.',
  'The training dataset contains 20 speakers and 4.3 hours, while the baseline has 0.5 hours.',
  "In a listening study with native speakers, the baseline accent rating scale runs from 0 to 5.",
  "In a listening study with native speakers, the baseline received scores from 0 to 5 on the rating scale.",
  "In a listening study with native speakers, baseline clips range from 4.3 to 0.5 seconds.",
  "In a listening study with native speakers, the baseline accent is predicted to drop from 4.3 to 0.5.",
  "In a listening study with native speakers, prior work reduces perceived accent from 4.3 to 0.5 against the baseline."
 ]) assert.equal(contract.classifySourceQuantitativeEvidence(sentence), false, sentence);
});
