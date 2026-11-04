'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { validateExperimentTableEvidenceDepth } = require('../scripts/analysis-contract');
const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures/ufakzeka-pilot-real.json.gz'))));
test('真实训练试点的三项对照及原文数值需同时对应', () => {
    const validate = (analysis, sourceText) => validateExperimentTableEvidenceDepth(analysis, { sourceText });
    assert.equal(validate(fixture.analysis, fixture.sourceText), null);
    assert.match(validate(fixture.analysis, fixture.sourceText.replaceAll('0.0115', '0.0915')), /消融|组件对照/);
    assert.match(validate(fixture.analysis.replace('0.0115', '0.0915'), fixture.sourceText), /消融|组件对照/);
    assert.match(validate(fixture.analysis.replace('BPE-dropout', '其他设置'), fixture.sourceText), /消融|组件对照/);
});
