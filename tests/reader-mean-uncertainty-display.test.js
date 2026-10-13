'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const deep = require('../scripts/deep-analyzer');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const table = value => `| Method | Value |\n| --- | --- |\n| A | ${value} |`;
const cases = [
    ['3.8±.0113.8\\pm.011', '3.8 ± .011'],
    ['.96±.0008.96\\pm.0008', '.96 ± .0008'],
    ['83.3±0.3\\mathbf{83.3}\\scriptscriptstyle{\\pm 0.3}', '83.3 ± 0.3'],
    ['−1.20±.03−1.20\\pm.03', '−1.20 ± .03'],
    ['3.8±.0113.9\\pm.011'], ['3.8±.0113.8\\pm.012'],
    ['3.8±.0113.8±.011'], ['1.521.52'],
    ['83.3±0.3\\mathbf{83.3}\\scriptscriptstyle{\\pm 0.4}'],
    ['83.3±0.3\\mathbf{83.30}\\scriptscriptstyle{\\pm 0.3}'],
    ['3.8±.0113.8\\pm.0112'], ['−1.2±.03+1.2\\pm.03'],
    ['DDSP+F0F_{0}', 'DDSP+F0'], ['Mean F1F_{1}', 'Mean F1'],
    ['Slow speech (c1c_{1})', 'Slow speech (c1)'],
    ['F0F_{1}'], ['F0G_{0}'], ['F0F0'], ['c01c_{1}'], ['F0F_{00}'],
    ['F１２F_{１２}'], ['３.８±.０１１３.８\\pm.０１１'], ['F١F_{١}'],
];
test('带明确TeX的均值和误差逐字相同才合并，不猜裸数字或改精度', () => {
    for (const [original, expected = original] of cases) {
        assert.equal(deep.normalizeApiReaderTablePasteArtifacts(table(original)), table(expected), original);
    }
});
test('整数下标显示合并仍保留原格，错字母和错下标不能借来源通过', () => {
    const original = 'Slow speech (c1c_{1})';
    const sourceText = 'The table describes the concept identifier.';
    const matrix = [['Method', 'Value'], ['A', original]];
    const cells = matrix.flatMap((row, r) => row.map((text, c) => ({ row: r, column: c,
        rowspan: 1, colspan: 1, text, sourceDomSha256: sha(`${r}:${c}:${text}`) })));
    const body = { version: 1, source: 'direct_conference_pdf_text', sourceKind: 'conference_pdf',
        flattenedTextSha256: sha(sourceText), formulas: [], figures: [],
        tables: [{ ordinal: 1, recoveryStatus: 'complete', sourceDomSha256: sha('concepts'), cells, matrix }] };
    const artifacts = { ...body, payloadSha256: deep.stableFingerprint(body) };
    const binding = [{ tableIndex: 1, sourceType: 'artifact_table', sourceTableOrdinal: 1,
        sourceQuotes: [], cellBindings: cells.map(c => ({ renderedRow: c.row, renderedColumn: c.column,
            sourceRow: c.row, sourceColumn: c.column })) }];
    const options = { sourceText, structuredArtifacts: artifacts };
    const output = deep.bindApiReaderSourceEvidence(table(original), binding, [], options);
    assert.equal(output.article, table('Slow speech (c1)'));
    assert.equal(output.tableBindings[0].cellBindings[3].sourceText, original);
    for (const wrong of ['Slow speech (c2)', 'Slow speech (d1)']) {
        assert.throws(() => deep.bindApiReaderSourceEvidence(table(wrong), binding, [], options), /原始 cell 不一致/);
    }
});
test('Python发布显示与Reader对同一组正反例结果一致', () => {
    const script = `import ast,json,pathlib,re,sys
p=pathlib.Path(sys.argv[1])/'scripts/publish-to-blog.py'
tree=ast.parse(p.read_text())
fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_normalize_api_reader_display_artifacts')
exec(compile(ast.Module(body=[fn],type_ignores=[]),str(p),'exec'))
print(json.dumps([_normalize_api_reader_display_artifacts(x) for x in json.loads(sys.argv[2])]))`;
    const root = path.resolve(__dirname, '..');
    const result = JSON.parse(execFileSync('bash', [path.join(root, 'scripts/python-runtime.sh'),
        '-c', script, root, JSON.stringify(cases.map(([input]) => input))], { encoding: 'utf8' }));
    assert.deepEqual(result, cases.map(([original, expected = original]) => expected));
});
test('显示修正仍绑定原DOM单元格，均值或误差被改动必须拒绝', () => {
    for (const [source, expected] of cases.slice(0, 4)) {
        const sourceText = 'The reported uncertainty belongs to the original result table.';
        const matrix = [['Method', 'Value'], ['A', source]];
        const cells = matrix.flatMap((row, r) => row.map((text, c) => ({ row: r,
            column: c, rowspan: 1, colspan: 1, text, sourceDomSha256: sha(`${r}:${c}:${text}`) })));
        const body = { version: 1, source: 'direct_conference_pdf_text', sourceKind: 'conference_pdf',
            flattenedTextSha256: sha(sourceText), formulas: [], figures: [],
            tables: [{ ordinal: 1, recoveryStatus: 'complete', sourceDomSha256: sha('source table'), cells, matrix }] };
        const artifacts = { ...body, payloadSha256: deep.stableFingerprint(body) };
        const bindings = [{ tableIndex: 1, sourceType: 'artifact_table', sourceTableOrdinal: 1,
            sourceQuotes: [], cellBindings: cells.map(cell => ({ renderedRow: cell.row,
                renderedColumn: cell.column, sourceRow: cell.row, sourceColumn: cell.column })) }];
        const options = { sourceText, structuredArtifacts: artifacts };
        const before = JSON.stringify(artifacts);
        const output = deep.bindApiReaderSourceEvidence(table(source), bindings, [], options);
        assert.equal(output.article, table(expected));
        assert.equal(output.tableBindings[0].cellBindings[3].sourceText, source);
        assert.equal(output.tableBindings[0].cellBindings[3].sourceDomSha256, cells[3].sourceDomSha256);
        assert.equal(JSON.stringify(artifacts), before);
        assert.throws(() => deep.bindApiReaderSourceEvidence(table(expected.replace(' ± ', '9 ± ')), bindings, [], options), /原始 cell 不一致/);
        assert.throws(() => deep.bindApiReaderSourceEvidence(table(expected + '9'), bindings, [], options), /原始 cell 不一致/);
    }
});
