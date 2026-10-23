'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { findMissingComparisonUnits } = require('../scripts/editorial-quality.js');

// These are constructed positive/negative rule-boundary fixtures, not paper facts.
// Authentic paid-draft replay remains in the independent runtime acceptance record.
// This portable test reads no data/current, source archive, private response or .env.
const cases = [
 ['existing en dash tail unit unchanged','准确率随频率下降，1–8 kHz最强。',false],
 ['existing ASCII tail unit unchanged','准确率随频率下降，1-8 kHz最强。',false],
 ['existing Chinese tail unit unchanged','准确率随频率下降，1至8 kHz最强。',false],
 ['existing decimal tail unit unchanged','准确率随频率下降，1.5–8 kHz最强。',false],
 ['existing fractional tail unit unchanged','准确率随频率下降，0.5–8 kHz最强。',false],
 ['decimal both endpoints explicit','准确率随频率下降，1.5 kHz–8 kHz最强。',false],
 ['trailing unit with real bare WER retained','准确率随频率下降，1.5–8 kHz最强，WER从12降至8。',true],
 ['direct raised 到了 retained','准确率提高到了8 kHz。',true],
 ['direct lowered 至 retained','准确率下降至8 kHz。',true],
 ['direct promoted 到了 retained','准确率提升到了8 kHz。',true],
 ['direct increased 到 retained','准确率增加到8 kHz。',true],
 ['direct decreased 到 retained','准确率从75降到8 kHz。',true],
 ['direct comma retained','准确率提高到了，8 kHz。',true],
 ['direct comparison retained','准确率从1 kHz提高到8 kHz。',true],
 ['bare assignment retained','准确率提高8 kHz。',true],
 ['bare comma assignment retained','准确率提高，8 kHz。',true],
 ['single explicit frequency','分类准确率在8 kHz以上仍高于基线。',false],
 ['both endpoints explicit','分类准确率随频率下降，1 kHz–8 kHz最强。',false],
 ['ASCII range','分类准确率随频率下降，1 kHz-8 kHz最强。',false],
 ['case insensitive','分类准确率随频率下降，1 KHZ–8 khz最强。',false],
 ['Hz and MHz','分类准确率随频率下降，100 Hz到1 MHz最强。',false],
 ['true bare WER retained','分类准确率在8 kHz以上仍高于基线，WER从12降至8。',true],
 ['true bare accuracy retained','频带为8 kHz，准确率从75提高到80。',true],
 ['existing ratio semantics unchanged','频带为8 kHz，准确率提高到0.8。',false],
 ['no cross-sentence waiver','频率为8 kHz。WER从12降至8。',true],
 ['unitless interval retained','准确率随频率下降，1–8最强。',true],
 ['unitless scalar retained','准确率随频率下降，8以上最强。',true],
 ['unknown unit retained','准确率随频率下降，8 kiloHz最强。',true],
 ['direct metric assignment retained','频带比较中，准确率提高到8 kHz。',true],
 ['proper percentage unchanged','频带为8 kHz，准确率从75%提高到80%。',false],
 ['other numeric parameter unchanged','参数为8，准确率从75提高到80。',true]
];

describe('显式频率条件与百分尺度结果的单位边界（构造例）', () => {
    for (const [name, text, reject] of cases) {
        it(`${reject ? '负例仍拒绝' : '正例可接受'}: ${name}`, () => {
            const before = text;
            assert.equal(findMissingComparisonUnits(text).length > 0, reject);
            assert.equal(text, before);
        });
    }
});
