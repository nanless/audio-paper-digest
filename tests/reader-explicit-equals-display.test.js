'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const deep = require('../scripts/deep-analyzer');
const table = value => `| Method | Value |\n| --- | --- |\n| A | ${value} |`;
const accepted = [['w=2.5w{=}2.5', 'w=2.5'], ['K=1K{=}1', 'K=1'],
    ['(w=-2.50w{=}-2.50)', '(w=-2.50)']];
const rejected = ['w=2.5y{=}2.5', 'w=2.5w{=}2.6', 'w=2.5w{=}2.50',
    'ww=2.5w{=}2.5', 'w=2.5w{=}2.5_1', 'w=2.5w{=}2.5\\alpha',
    'w=2.5w{=}2.5 _1', 'w=2.5w{=}2.5 \\alpha',
    'w=2.5w{=}2.5+1', 'w=2.5w{=}2.5 +1', 'w=2.5w{=}2.5-1',
    'w=2.5w{=}2.5 −1', 'w=2.5w{=}2.5*2', 'w=2.5w{=}2.5 /2',
    'w=2.5w{=}2.5%', 'w=2.5w=2.5', 'K=1K=1', '19.119.1', '+.087+.087'];

test('只合并显式TeX关系符且变量、数值和精度相同的完整副本', () => {
    for (const [input, expected] of accepted) {
        assert.equal(deep.normalizeApiReaderTablePasteArtifacts(table(input)), table(expected));
    }
    for (const input of rejected) {
        assert.equal(deep.normalizeApiReaderTablePasteArtifacts(table(input)),
            table(input.replaceAll('{=}', '=')), input);
    }
    for (const input of rejected.slice(-4)) {
        assert.equal(deep.normalizeApiReaderTablePasteArtifacts(table(input)), table(input));
    }
});

test('JS与Python合并条件镜像，错误变量/精度/运算符尾部绝不合并', () => {
    const script = `import ast,json,pathlib,re,sys,unicodedata
p=pathlib.Path(sys.argv[1])/'scripts/publish-to-blog.py'
sys.path.insert(0,str(p.resolve().parent))
tree=ast.parse(p.read_text())
names={'_normalize_api_reader_explicit_symbol_projection','_normalize_api_reader_display_artifacts'}
functions=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names]
assert len(functions)==len(names)
exec(compile(ast.Module(body=functions,type_ignores=[]),str(p),'exec'))
print(json.dumps([_normalize_api_reader_display_artifacts(x) for x in json.loads(sys.argv[2])]))`;
    const root = path.resolve(__dirname, '..');
    const inputs = [...accepted.map(([input]) => input), ...rejected];
    const output = JSON.parse(execFileSync('bash', [path.join(root, 'scripts/python-runtime.sh'), '-c', script, root,
        JSON.stringify(inputs)], { encoding: 'utf8' }));
    assert.deepEqual(output, [...accepted.map(([, value]) => value), ...rejected]);
});

test('来源绑定保留原DOM和SHA，错误变量与数值不能借显示修复过关', () => {
    const original = 'w=2.5w{=}2.5';
    const sha = text => crypto.createHash('sha256').update(text).digest('hex');
    const sourceText = 'The steering weight belongs to the reported setting.';
    const matrix = [['Method', 'Value'], ['A', original]];
    const cells = matrix.flatMap((row, r) => row.map((text, c) => ({
        row: r, column: c, rowspan: 1, colspan: 1, text,
        sourceDomSha256: sha(`${r}:${c}:${text}`),
    })));
    const body = { version: 1, sourceKind: 'conference_pdf', flattenedTextSha256: sha(sourceText),
        formulas: [], figures: [], tables: [{ ordinal: 1, recoveryStatus: 'complete',
            sourceDomSha256: sha('table'), cells, matrix }] };
    const artifacts = { ...body, payloadSha256: deep.stableFingerprint(body) };
    const bindings = [{ tableIndex: 1, sourceType: 'artifact_table', sourceTableOrdinal: 1,
        sourceQuotes: [], cellBindings: cells.map(cell => ({ renderedRow: cell.row,
            renderedColumn: cell.column, sourceRow: cell.row, sourceColumn: cell.column })) }];
    const before = JSON.stringify(artifacts);
    const options = { sourceText, structuredArtifacts: artifacts };
    const output = deep.bindApiReaderSourceEvidence(table(original), bindings, [], options);
    assert.equal(output.article, table('w=2.5'));
    assert.equal(output.tableBindings[0].cellBindings[3].sourceText, original);
    assert.equal(output.tableBindings[0].cellBindings[3].sourceDomSha256, cells[3].sourceDomSha256);
    assert.equal(JSON.stringify(artifacts), before);
    for (const incorrect of ['y=2.5', 'w=2.6']) {
        assert.throws(() => deep.bindApiReaderSourceEvidence(table(incorrect), bindings, [], options));
    }
});
