'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const deep = require('../scripts/deep-analyzer');

function failures(header, values, quotes = []) {
    return deep.readerTableHeaderUnitEvidenceFailures({ header: ['模型', header],
        rows: values.map(value => ['Model', value]) }, quotes);
}

test('带明确数量的噪声条件列不将dB移到WER或比例单元格', () => {
    for (const header of ['多数模型 -10 dB', 'SNR +10 dB', 'Noise 0 dB', '−10 dB', '-10 (dB)']) {
        assert.deepEqual(failures(header, ['39–46%', '0.25']), [], header);
    }
    // 真列头仍需单位与逐项数值证据，不把指标名里的编号当条件值。
    for (const header of ['EDT (s)', 'C50 dB', 'P95 [s]', 'P5 [s]', 'SI-SDR 提升 dB', 'EER (%)', 'Top-1 (%)', 'Top 1 (%)']) {
        assert.equal(failures(header, ['1.23']).length, 1, header);
    }
    assert.deepEqual(failures('C50 dB', ['1.23'], [{ quote: 'C50 is 1.23 dB under the measured setup.' }]), []);
    assert.deepEqual(failures('P95 [s]', ['8.02'], [{ quote: 'P95 is 8.02 s in this split.' }]), []);
    assert.equal(failures('C50 dB', ['1.23'], [{ quote: 'C50 is not 1.23 dB in this setup.' }]).length, 1);
    assert.equal(failures('C50 dB', ['1.23'], [{ quote: 'EDT is 1.23 s and C50 was not measured.' }]).length, 1);
});
