'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const deep = require('../scripts/deep-analyzer');
const samples = [
    [String.raw`R3multiR_{3}^{\mathrm{multi}} (multi-space)`, 'R3multi (multi-space)'],
    [String.raw`R3multiR_{3}^{\mathrm{multi}}`, 'R3multi'],
    [String.raw`Sctrl×SmtgtS_{\mathrm{ctrl}}\!\times\!\mathrm{Sm}_{\mathrm{tgt}} ↑\uparrow`, 'Sctrl×Smtgt ↑'],
    [String.raw`-0.09±\pm0.02`, '-0.09 ± 0.02'],
    [String.raw`1±.2+3`],
    [String.raw`1±.2\unknown`],
    [String.raw`8.6%8.6\%`, '8.6%'],
    [String.raw`0.5%∗∗∗0.5\%^{***}`, '0.5%∗∗∗'],
    [String.raw`0.5%∗∗∗0.5\%^{**}`],
    [String.raw`0.5%∗∗∗0.6\%^{***}`],
    [String.raw`−3.9%-3.9\%`, '−3.9%'],
    [String.raw`−3.9%+3.9\%`],
    [String.raw`SctrlS_{\mathrm{ctrl}} ↑\uparrow`, 'Sctrl ↑'],
    [String.raw`Smtgt\mathrm{Sm}_{\mathrm{tgt}} ↑\uparrow`, 'Smtgt ↑'],
    [String.raw`𝚫𝐚𝐯𝐠\boldsymbol{\Delta_{\mathrm{avg}}} ↑\uparrow`, 'Δavg ↑'],
    [String.raw`ℒself(τ)\mathcal{L}_{\mathrm{self}}(\tau)`, 'Lself(τ)'],
    [String.raw`R3multiR_{4}^{\mathrm{multi}}`],
    [String.raw`R3multiR_{3}^{\mathrm{other}}`],
    [String.raw`R3multiR_{3}^{\mathrm{multi}} ^{2}`],
    [String.raw`Sctrl×SmtgtS_{\mathrm{ctrl}}\!\times\!\mathrm{Sm}_{\mathrm{other}}`],
    [String.raw`Sctrl×SmtgtS_{\mathrm{ctrl}}\!+\!\mathrm{Sm}_{\mathrm{tgt}}`],
    [String.raw`Sctrl×SmtgtS_{\mathrm{ctrl}}\!\times\!_{\mathrm{tgt}}`],
    [String.raw`Sctrl×SmtgtS_{\mathrm{ctrl}}\!\times\!\mathrm{Sm}_{\mathrm{tgt}} _{j}`],
    [String.raw`8.6%8.7\%`],
    [String.raw`8.60%8.6\%`],
    [String.raw`8.6%8.6%`],
    [String.raw`3030`],
    [String.raw`+2.77+2.77 [2.44,3.12][2.44,3.12]`],
    [String.raw`α\alpha \unknown`],
    [String.raw`↑\uparrow ^{2}`]
];
const expectedUnchanged = value => value.normalize('NFKC').replace(/<br\s*\/?>/gi, ' ')
    .replace(/[*_`]/g, '').replace(/[％]/g, '%').replace(/\s+/g, ' ').trim();

test('完整同义数学显示不改索引、运算符、值或精度；残式与裸重复保持拒绝依据', () => {
    for (const [raw, expected] of samples) {
        assert.equal(deep.normalizeReaderSourceCell(raw), expected === undefined
            ? expectedUnchanged(raw) : expected, raw);
    }
});

test('Python发布侧逐项重放同一源格，含既有原子和新复合原子正反例', () => {
    const filename = path.resolve(__dirname, '../scripts/publish-to-blog.py');
    const code = `import ast,json,re,unicodedata,sys\nsource=ast.parse(open(sys.argv[1]).read())\nkeep={'_normalize_api_reader_explicit_symbol_projection','_normalize_api_reader_display_artifacts','_normalize_api_reader_source_cell'}\nmodule=ast.Module(body=[n for n in source.body if isinstance(n,ast.FunctionDef) and n.name in keep],type_ignores=[])\nexec(compile(module,sys.argv[1],'exec'))\nprint(json.dumps([_normalize_api_reader_source_cell(v) for v in json.loads(sys.stdin.read())],ensure_ascii=False))`;
    const result = execFileSync('bash', [path.resolve(__dirname, '../scripts/python-runtime.sh'), '-c', code, filename], {
        input: JSON.stringify(samples.map(([raw]) => raw)), encoding: 'utf8'
    });
    assert.deepEqual(JSON.parse(result), samples.map(([raw]) => deep.normalizeReaderSourceCell(raw)));
});
