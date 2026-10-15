'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const environment = {PAPER_ANALYZER_MODEL:'muse-spark-1.3-contributor',PAPER_ANALYZER_ENDPOINT:'https://example.invalid/v1',PAPER_ANALYZER_API_KEY:'test-never-sent',HTTPS_PROXY:'http://127.0.0.1:1'};
Object.assign(process.env,environment);
const utils = require('../scripts/utils');
utils.loadEnvFile = () => Object.assign(process.env,environment);
utils.requestLlmJson = () => { throw Error('本测试禁止网络'); };
const deep = require('../scripts/deep-analyzer');

test('完整格布尔符号只合并同值显式TeX副本，不把乘积或续式当格值', () => {
    const normalize = require('../scripts/lib/reader-source-display').normalizeExplicitReaderSymbolProjection;
    for (const [raw, expected] of [[String.raw`✓\checkmark`, '✓'], [String.raw`×\times`, '×'],
        [String.raw`| ✓\checkmark | ×\times |`, '| ✓ | × |'],
        [String.raw`  ✓\checkmark  `, '  ✓  ']]) {
        assert.equal(normalize(raw), expected);
        assert.equal(deep.normalizeReaderSourceCell(raw), deep.normalizeReaderSourceCell(expected));
    }
    for (const raw of [String.raw`✓\times`, String.raw`×\checkmark`, String.raw`××\times`,
        String.raw`✓✓`, String.raw`\times`, String.raw`a×\times`, String.raw`×\times b`,
        String.raw`×\times^{2}`, String.raw`✓\checkmark _{j}`, String.raw`×\times\unknown`,
        String.raw`×\times + 2`, String.raw`✓\checkmarker`]) assert.equal(normalize(raw), raw);
});

test('同格完整符号与TeX原子严格同值才合并显示',()=>{
    const samples = [
        [String.raw`𝚫𝐚𝐯𝐠\boldsymbol{\Delta_{\mathrm{avg}}} ↑\uparrow`,'Δavg ↑'],
        [String.raw`SctrlS_{\mathrm{ctrl}} ↑\uparrow`,'Sctrl ↑'],
        [String.raw`Smtgt\mathrm{Sm}_{\mathrm{tgt}} ↑\uparrow`,'Smtgt ↑'],
        [String.raw`Enear↑E_{\text{near}}\uparrow`,'Enear↑'],
        [String.raw`ℒself​(τ)\mathcal{L}_{\mathrm{self}}(\tau)`,'Lself​(τ)'],
        [String.raw`CTC /\;/\; WB`,'CTC / WB'],
        [String.raw`Modified-CTC +\;+\; LLM-CE`,'Modified-CTC + LLM-CE']
    ];
    for(const [raw,expected] of samples){assert.equal(deep.normalizeReaderSourceCell(raw),expected);assert.equal(deep.normalizeReaderSourceCell(expected),expected);}
});

test('不同下标方向未知命令裸复写与不完整乘积均不借展示形状猜值',()=>{
    const samples = [String.raw`SctrlS_{\mathrm{other}}`,String.raw`Enear↑E_{\text{near}}\downarrow`,String.raw`α\alphaBeta`,String.raw`Lself(τ)\mathcal{L}_{\mathrm{self}}(\omega)`,String.raw`Sctrl×SmtgtS_{\mathrm{ctrl}}\!\times\!_{\mathrm{tgt}}`,String.raw`19.119.1`,String.raw`K=1K=1`,String.raw`6×10−46×10−4`,String.raw`/\;+\;`];
    for(const raw of samples){
        const expected=raw.normalize('NFKC').replace(/[*_`]/g,'').replace(/\s+/g,' ').trim();
        assert.equal(deep.normalizeReaderSourceCell(raw),expected,raw);
    }
});

test('超长未知变量不借尾部子串视作完整符号',()=>{
    const raw='A'.repeat(2000)+String.raw`SctrlS_{\mathrm{ctrl}}`;
    assert.equal(deep.normalizeReaderSourceCell(raw),raw.replace(/_/g,''));
});

test('命令后的数学续尾必须整体保留，不只消掉相等前缀',()=>{
    for(const raw of [String.raw`α\alpha_{j}`,String.raw`α\alpha^{2}`,String.raw`α\alpha\unknown`,String.raw`α\alphaβ`,String.raw`Lself\mathcal{L}_{\mathrm{self}}^{2}`]) {
        assert.equal(deep.normalizeReaderSourceCell(raw),raw.normalize('NFKC').replace(/_/g,''));
    }
});

test('数学续尾前的空白及TeX间距都不构成原子结束',()=>{
    for(const raw of [String.raw`α\alpha _{j}`,String.raw`SctrlS_{\mathrm{ctrl}} ^{2}`,String.raw`α\alpha \unknown`,String.raw`α\alpha \beta`,String.raw`α\alpha \; _{j}`,String.raw`α\alpha \quad β`]) {
        assert.equal(deep.normalizeReaderSourceCell(raw),raw.normalize('NFKC').replace(/_/g,''));
    }
});

test('独立箭头注解同样保留下标幂和未知续尾',()=>{
    for(const raw of [String.raw`↑\uparrow_{j}`,String.raw`↑\uparrow ^{2}`,String.raw`↑\uparrow\unknown`,String.raw`↓\downarrow _{j}`,String.raw`↓\downarrow ^{2}`,String.raw`↓\downarrow \unknown`,String.raw`↑\downarrow`]) {
        assert.equal(deep.normalizeReaderSourceCell(raw),raw.replace(/_/g,''));
    }
});
