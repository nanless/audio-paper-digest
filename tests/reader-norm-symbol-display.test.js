'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const sourceProject = process.env.PD_READER_NORM_SOURCE_PROJECT;
const paidFile = process.env.PD_READER_NORM_PAID_FILE;
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const deep = require('../scripts/deep-analyzer');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const cases = [
    [String.raw`ℓ∞\ell_{\infty}`, 'l∞'],
    [String.raw`PGD-ℓ∞\ell_{\infty}`, 'PGD-l∞'],
    [String.raw`ℓ2\ell_{2}`, 'l2'],
    [String.raw`PGD-ℓ2\ell_{2}`, 'PGD-l2'],
    [String.raw`ℓ∞\ell_{2}`], [String.raw`ℓ2\ell_{\infty}`],
    [String.raw`ℓ02\ell_{2}`], [String.raw`ℓ2\ell_{02}`],
    [String.raw`ℓ２\ell_{2}`], [String.raw`ℓ2\ell_{２}`],
    [String.raw`ℓ∞\ell_{\infty}^{2}`], [String.raw`ℓ∞\ell_{\infty} ^{2}`],
    [String.raw`ℓ∞\ell_{\infty}\unknown`], [String.raw`ℓ∞\ell_{\infty} \unknown`],
    [String.raw`ℓ∞\ell_{\infty}+2`], [String.raw`ℓ∞\ell_{\infty} - 2`],
    [String.raw`ℓ∞\ell_{\infty}×2`], [String.raw`ℓ∞\ell_{\infty}=2`],
    [String.raw`ℓ∞\ell_{\infty}(x)`], [String.raw`ℓ∞\ell_{\infty} β`],
    [String.raw`ℓ∞\ell_{\infty} _{j}`], [String.raw`Aℓ∞\ell_{\infty}`],
    [String.raw`ℓ∞ℓ∞`], [String.raw`3030`], [String.raw`ℓp\ell_{p}`],
];
const unchanged = value => value.normalize('NFKC').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
test('范数只合并同值完整原子，不删错下标、续式或裸重复', () => {
    for (const [input, expected] of cases) assert.equal(deep.normalizeReaderSourceCell(input),
        expected === undefined ? unchanged(input) : expected, input);
});
test('Python发布对每个范数正反例重放同一严格规则', () => {
    const code = `import ast,json,re,unicodedata,sys
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1]).resolve().parent))
source=ast.parse(open(sys.argv[1],encoding='utf-8').read())
keep={'_normalize_api_reader_explicit_symbol_projection','_normalize_api_reader_display_artifacts','_normalize_api_reader_source_cell'}
exec(compile(ast.Module(body=[n for n in source.body if isinstance(n,ast.FunctionDef) and n.name in keep],type_ignores=[]),sys.argv[1],'exec'))
print(json.dumps([_normalize_api_reader_source_cell(v) for v in json.loads(sys.stdin.read())],ensure_ascii=False))`;
    const result = execFileSync('bash', [path.resolve(__dirname, '../scripts/python-runtime.sh'), '-c', code,
        path.resolve(__dirname, '../scripts/publish-to-blog.py')], { input: JSON.stringify(cases.map(([raw]) => raw)), encoding: 'utf8' });
    assert.deepEqual(JSON.parse(result), cases.map(([raw]) => deep.normalizeReaderSourceCell(raw)));
});
test('公共来源绑定保留原格和DOM，替换范数或DOM签名仍拒绝', () => {
    const value = String.raw`ℓ∞\ell_{\infty}`;
    const sourceText = 'The attack uses the infinity norm with a fixed budget.';
    const matrix = [['Attack', 'Norm'], ['PGD', value]];
    const cells = matrix.flatMap((row, r) => row.map((text, c) => ({ row: r, column: c,
        rowspan: 1, colspan: 1, text, sourceDomSha256: sha(`${r}:${c}:${text}`) })));
    const body = { version: 1, source: 'direct_conference_pdf_text', sourceKind: 'conference_pdf',
        flattenedTextSha256: sha(sourceText), formulas: [], figures: [],
        tables: [{ ordinal: 1, recoveryStatus: 'complete', sourceDomSha256: sha('norm table'), cells, matrix }] };
    const artifacts = { ...body, payloadSha256: deep.stableFingerprint(body) };
    const bindings = [{ tableIndex: 1, sourceType: 'artifact_table', sourceTableOrdinal: 1,
        sourceQuotes: [], cellBindings: cells.map(cell => ({ renderedRow: cell.row, renderedColumn: cell.column,
            sourceRow: cell.row, sourceColumn: cell.column })) }];
    const table = norm => `| Attack | Norm |\n| --- | --- |\n| PGD | ${norm} |`;
    const before = JSON.stringify(artifacts);
    const parsed = deep.bindApiReaderSourceEvidence(table(value), bindings, [], { sourceText, structuredArtifacts: artifacts });
    assert.equal(parsed.article, table('ℓ∞'));
    assert.equal(parsed.tableBindings[0].cellBindings[3].sourceText, value);
    assert.equal(parsed.tableBindings[0].cellBindings[3].sourceDomSha256, cells[3].sourceDomSha256);
    assert.equal(JSON.stringify(artifacts), before);
    assert.throws(() => deep.bindApiReaderSourceEvidence(table('ℓ2'), bindings, [], { sourceText, structuredArtifacts: artifacts }), /原始 cell 不一致/);
    const changed = structuredClone(bindings);
    changed[0].cellBindings[3].sourceDomSha256 = 'f'.repeat(64);
    assert.throws(() => deep.bindApiReaderSourceEvidence(table('ℓ∞'), changed, [], { sourceText, structuredArtifacts: artifacts }), /额外字段/);
});
test('真实10752原付费稿经完整公共解析，源格与旧费用字节不改',
    { skip: !sourceProject || !paidFile }, () => {
        const Config = require('../scripts/config');
        const daily = require('../scripts/lib/daily-fresh-source-plan');
        const previous = Config.FILES.dailyFreshSourceRunsDir;
        Config.FILES.dailyFreshSourceRunsDir = path.join(sourceProject, 'data/runtime/daily-fresh-source-runs');
        try {
            const data = JSON.parse(fs.readFileSync(path.join(sourceProject, 'data/current/deep-analysis-result.json'), 'utf8'));
            const paper = data.papers.find(item => String(item.arxivId || item.id).replace(/v\d+$/, '') === '2610.10752');
            const plan = daily.requireDailyFreshSourceRecoveryPlan(data);
            const source = daily.readDailyFreshSource(plan, paper);
            const bytes = fs.readFileSync(paidFile);
            const saved = JSON.parse(bytes);
            assert.equal(saved.identity.paperId.replace(/v\d+$/, ''), '2610.10752');
            assert.equal(saved.identity.sourceSha256, sha(source.text));
            assert.equal(saved.identity.freshAnalysis.structuredArtifactsSha256, source.structuredArtifacts.payloadSha256);
            const draft = saved.payload.draft || JSON.parse(saved.payload.rawDraft);
            const originalArtifacts = JSON.stringify(source.structuredArtifacts);
            const parsed = deep.parseApiReaderArticleResult(JSON.stringify(
                require('../scripts/lib/reader-draft-order').normalizeReaderDraftOrder(draft, { structuredArtifacts: source.structuredArtifacts }).draft), {
                arxivId: '2610.10752', requiredVersion: 3, requireIntegratedTables: true, minimumIntegratedTables: 2,
                requireSourceBindings: true, sourceText: source.text, structuredArtifacts: source.structuredArtifacts,
                availableFigureOrdinals: (saved.payload.imageEvidence || []).map(image => image.ordinal),
                allowDeterministicQuoteRepair: true, allowDeterministicUnsupportedClaimPruning: true,
            });
            assert.ok(!parsed.article.includes(String.raw`ℓ∞\ell_{\infty}`));
            const normCells = source.structuredArtifacts.tables.flatMap(table => table.cells || [])
                .filter(cell => cell.text.includes(String.raw`ℓ∞\ell_{\infty}`));
            assert.ok(normCells.length > 0);
            for (const cell of normCells) {
                assert.ok(cell.sourceDomSha256);
                assert.ok(!deep.normalizeReaderSourceCell(cell.text).includes('\\ell'));
            }
            assert.equal(deep.stableFingerprint(JSON.parse(parsed.plan.structuredSourcePayload)), source.structuredArtifacts.payloadSha256);
            assert.equal(JSON.stringify(source.structuredArtifacts), originalArtifacts);
            assert.equal(sha(fs.readFileSync(paidFile)), sha(bytes));
        } finally { Config.FILES.dailyFreshSourceRunsDir = previous; }
    });
