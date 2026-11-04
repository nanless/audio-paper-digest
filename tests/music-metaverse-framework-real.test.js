'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { validateCoreSummarySemanticContract } = require('../scripts/analysis-contract');
const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures/music-metaverse-framework-real.json.gz'))));
test('文献延迟目标不当作实测，三支柱须有真实分工', () => {
    const validate = (analysis, sourceText) => validateCoreSummarySemanticContract(analysis, { sourceText });
    assert.equal(validate(fixture.analysis, fixture.sourceText), null);
    const changedSource = fixture.sourceText.replace('Latency values are indicative targets; see Table', 'Latency values are measured results; see Table');
    assert.match(validate(fixture.analysis, changedSource), /关键定量结果/);
    const changedSummary = fixture.analysis.replace('语义提取负责', '语义提取涉及').replace('语义编排负责', '语义编排涉及').replace('同步负责', '同步涉及');
    assert.match(validate(changedSummary, fixture.sourceText), /方法链/);
});
