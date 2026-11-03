'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const codec = require('../scripts/lib/scoring-record-format');

// Only the format metadata is constructed here. These objects confer no audit,
// source identity, request allowance, or publication eligibility.
function originalFields() {
    const source = execFileSync('git', ['show', '05ab504d:scripts/deep-analyzer.js'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    return Object.fromEntries([
        ['scoringContract', 'SCORING_AUDIT_CONTRACT'],
        ['resourceNormalizationContract', 'SCORING_RESOURCE_NORMALIZATION_CONTRACT'],
        ['requestFormatContract', 'SCORING_REQUEST_FORMAT_CONTRACT'],
        ['capRulesVersion', 'SCORING_CAP_RULES_VERSION']
    ].map(([field, name]) => {
        const match = source.match(new RegExp('const ' + name + " = '([^']+)';"));
        assert.ok(match, 'actual original metadata declaration is present');
        return [field, match[1]];
    }));
}

test('实际原实现声明的四类评分格式仍按原字段读取，原字节不改', () => {
    const original = originalFields();
    const before = JSON.stringify(original);
    assert.equal(codec.hasScoringStageFormats(original), true);
    assert.equal(codec.hasScoringAuditFormat(original), true);
    assert.deepEqual(codec.readHeader(original), { contract: original.scoringContract });
    assert.equal(JSON.stringify(original), before);
});

test('新评分写完整稳定头，混用原字段、错指纹或少指纹不能冒充该格式', () => {
    const current = codec.currentStageFields();
    assert.equal(current.scoringContract, 'api-scoring-audit');
    assert.match(current.scoringSchemaFingerprint, /^[a-f0-9]{64}$/);
    assert.equal('capRulesVersion' in current, false);
    assert.equal(codec.hasScoringStageFormats(current), true);
    for (const mutation of [{ scoringSchemaFingerprint: '0'.repeat(64) },
        { capRulesVersion: originalFields().capRulesVersion }, { requestFormatSchemaFingerprint: undefined },
        { scoringContract: originalFields().scoringContract }, { version: 1 }, { contract: 'other-format' }]) {
        assert.equal(codec.hasScoringStageFormats({ ...current, ...mutation }), false);
    }
    const mixed = { ...originalFields(), scoringContract: current.scoringContract,
        scoringSchemaFingerprint: current.scoringSchemaFingerprint };
    assert.equal(codec.hasScoringAuditFormat(mixed), true);
    assert.equal(codec.hasScoringStageFormats(mixed), false);
});

test('Node 与 Python 对原字段、新字段和混合错误得到相同结论', () => {
    const current = codec.currentStageFields();
    const inputs = [originalFields(), current, { ...current, scoringSchemaFingerprint: '0'.repeat(64) },
        { ...current, capRulesVersion: originalFields().capRulesVersion }, { ...current, version: 1 }, null];
    const text = execFileSync('bash', ['scripts/python-runtime.sh', '-c',
        'import json,sys;sys.path.insert(0,"scripts");from scoring_record_format import has_scoring_stage_formats;print(json.dumps([has_scoring_stage_formats(s) for s in json.load(sys.stdin)]))'], {
        cwd: path.resolve(__dirname, '..'), input: JSON.stringify(inputs), encoding: 'utf8' });
    assert.deepEqual(JSON.parse(text), inputs.map(codec.hasScoringStageFormats));
});
