'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const Config = require('../scripts/config');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const fresh = require('../scripts/lib/fresh-analysis-context');
const deep = require('../scripts/deep-analyzer');
const engine = require('../scripts/analysis-engine');
const order = require('../scripts/lib/reader-draft-order');
const repair = require('../scripts/lib/reader-repair');
const pdfEvidence = require('../scripts/lib/reader-table-pdf-evidence');
const {
    collapseParenthesizedSignedDoubleWrite,
    normalizeReaderSourceDisplayArtifacts,
    projectReaderCellTexDisplay,
    stripLeadingEmptyReferenceLinkCellPrefix,
} = require('../scripts/lib/reader-source-display');

const B2_POSITIVE_CASES = [
    ['46.4 (−1.4)(-1.4)', '46.4 (−1.4)'],
    ['57.5 (−0.8)(-0.8)', '57.5 (−0.8)'],
    ['47.9 (+0.2)(+0.2)', '47.9 (+0.2)'],
    ['46.6 (+2.5)(+2.5)', '46.6 (+2.5)'],
    ['43.8 (−4.0)(-4.0)', '43.8 (−4.0)'],
    ['(-1.4)(-1.4)', '(-1.4)'],
    ['(-1.4)(−1.4)', '(-1.4)'],
    ['(+9.9%)(+9.9%)', '(+9.9%)'],
    ['(−1.4%)(-1.4%)', '(−1.4%)'],
    ['(-1.4%)(-1.4%)', '(-1.4%)'],
    ['46.4\u2009(−1.4)(-1.4)', '46.4\u2009(−1.4)'],
    ['(−1.52)(-1.52)', '(−1.52)'],
    ['Non-native (−15)(-15); background (−30)(-30)', 'Non-native (−15); background (−30)'],
    ['WER drops by (−1.4)(-1.4).', 'WER drops by (−1.4).'],
    ['[paper](https://example.test/fig-2-2.png) achieves 47.9 (+0.2)(+0.2)', '[paper](https://example.test/fig-2-2.png) achieves 47.9 (+0.2)'],
];

const B2_NEGATIVE_CASES = [
    '46.4 (−1.4)(-0.8)',
    '46.4 (+1.4)(-1.4)',
    '46.4 (-1.4)(+1.4)',
    '(1.4)(1.4)',
    '46.4 (1.4)(1.4)',
    '(1.40)(-1.4)',
    '(−1.40)(-1.4)',
    '(-1.4)(-1.40)',
    '(−1.4%)(-1.4)',
    '(−1.4)(-1.4%)',
    '[text](-1.4)',
    '[text](-1.4)(-1.4)',
    '[text](https://example.test/(-1.4)(-1.4))',
    'https://example.test/(-1.4)(-1.4)',
    'f(-1.4)(-1.4)',
    '2(-1.4)(-1.4)',
    '𝑓(-1.4)(-1.4)',
    '𝟐(-1.4)(-1.4)',
    '(-1.4)(-1.4)𝑓',
    '(-1.4)(-1.4)𝟐',
    '(-1.4)(-1.4).𝟐',
    '(−１.４)(-１.４)',
    '(−١.٤)(-١.٤)',
    '(-1.4)(-1.4)^2',
    '(-1.4)(-1.4)_i',
    '(-1.4)(-1.4)(+0.2)',
    '(-1.4)(-1.4)x',
    '(-1.4)(-1.4)%',
    '(-1.4)(-1.4).5',
    '1+(-1.4)(-1.4)',
];

const B3_POSITIVE_CASES = [
    ['[][] VideoLLaMA2-AV+PACD', 'VideoLLaMA2-AV+PACD'],
    ['[][] OmniVinci+PACD', 'OmniVinci+PACD'],
    ['  [][] VideoLLaMA2-AV+PACD', 'VideoLLaMA2-AV+PACD'],
    ['[][]\tOmniVinci+PACD', 'OmniVinci+PACD'],
    ['[][] Model (−1.4)(-1.4)', 'Model (−1.4)'],
    ['[][] Audio-LLM↑\\uparrow', 'Audio-LLM↑'],
];

const B3_NEGATIVE_CASES = [
    ['[][]', '[][]'],
    ['[][]   ', '[][]   '],
    ['[][] \u200b', '[][] \u200b'],
    ['[][] ()', '[][]'],
    ['[][] \\(\\)', '[][] '],
    ['[][] \\,', '[][] '],
    ['[][] \\;', '[][] '],
    ['[][] \\(\u200b\\)', '[][] \u200b'],
    ['[][] (\\,)', '[][]'],
    ['[][] (\\,) [][] foo', '[][] [][] foo'],
    ['[][] \\(\\) [][] foo', '[][]  [][] foo'],
    ['foo [][] bar', 'foo [][] bar'],
    ['foo; [][] bar', 'foo; [][] bar'],
    ['foo; [][] bar\\uparrow', 'foo; [] bar↑'],
    ['[a][b] foo', '[a][b] foo'],
    ['[x][] foo', '[x][] foo'],
    ['[][y] foo', '[][y] foo'],
    ['[][] [][] foo', '[][] [][] foo'],
];

test('B2 带括号有符号标量双写仅在符号与数值精度百分号完全相同时折叠，排除非BMP邻接与全角数字', () => {
    for (const [raw, expected] of B2_POSITIVE_CASES) {
        assert.equal(collapseParenthesizedSignedDoubleWrite(raw), expected, `collapse: ${raw}`);
        assert.equal(collapseParenthesizedSignedDoubleWrite(expected), expected, `idempotent collapse: ${raw}`);
        assert.equal(normalizeReaderSourceDisplayArtifacts(raw), expected, `display artifacts: ${raw}`);
        assert.equal(normalizeReaderSourceDisplayArtifacts(expected), expected, `idempotent display artifacts: ${raw}`);
        assert.equal(projectReaderCellTexDisplay(raw), expected, `cell project: ${raw}`);
        assert.equal(projectReaderCellTexDisplay(expected), expected, `idempotent cell project: ${raw}`);
    }
    for (const raw of B2_NEGATIVE_CASES) {
        assert.equal(collapseParenthesizedSignedDoubleWrite(raw), raw, `must not collapse: ${raw}`);
        assert.equal(normalizeReaderSourceDisplayArtifacts(raw), raw, `display must not fold: ${raw}`);
        assert.equal(projectReaderCellTexDisplay(raw), raw, `cell must not fold: ${raw}`);
    }
    assert.equal(collapseParenthesizedSignedDoubleWrite('\\(-1.4\\)(-1.4)'), '\\(-1.4\\)(-1.4)');
});

test('B3 单元格行首空引用链接前缀仅在剥离后仍含非空可见正文时生效，绝不置空单元格且二阶幂等', () => {
    for (const [raw, expected] of B3_POSITIVE_CASES) {
        assert.equal(projectReaderCellTexDisplay(raw), expected, `cell project: ${raw}`);
        assert.equal(projectReaderCellTexDisplay(expected), expected, `idempotent: ${raw}`);
    }
    assert.equal(stripLeadingEmptyReferenceLinkCellPrefix('[][] VideoLLaMA2-AV+PACD'), 'VideoLLaMA2-AV+PACD');
    for (const [raw, expected] of B3_NEGATIVE_CASES) {
        const actual = projectReaderCellTexDisplay(raw);
        assert.equal(actual, expected, `must preserve guard: ${raw}`);
        assert.equal(projectReaderCellTexDisplay(actual), actual, `second-order idempotent guard: ${raw}`);
        assert.ok(/[^\s\u200b\u200c\u200d\u2060\ufeff]/.test(actual), `must never blank non-empty cell: ${raw}`);
    }
});

test('Node 与 Python 发布端（含 AST 独立抽取模式）对 B2 和 B3 全量正反例保持逐字节对称', () => {
    const projectRoot = path.resolve(__dirname, '..');
    const cellInputs = [
        ...B2_POSITIVE_CASES.map(([raw]) => raw),
        ...B2_NEGATIVE_CASES,
        ...B3_POSITIVE_CASES.map(([raw]) => raw),
        ...B3_NEGATIVE_CASES.map(([raw]) => raw),
    ];
    const displayInputs = [
        ...B2_POSITIVE_CASES.map(([raw]) => raw),
        ...B2_NEGATIVE_CASES,
        '\\(-1.4\\)(-1.4)',
    ];
    const pairs = [...B2_POSITIVE_CASES, ...B3_POSITIVE_CASES];
    const probe = `import ast, json, re, sys, unicodedata
from pathlib import Path
root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root / 'scripts'))
sys.path.insert(0, str(root / 'tests' / 'python'))
from project_env_isolation import project_env_scope
from blog_entry_loader import load_publish_to_blog
with project_env_scope():
    publish = load_publish_to_blog()

# 同时校验仅按 AST 抽取 {'_normalize_api_reader_explicit_symbol_projection', '_normalize_api_reader_display_artifacts'} 的自包含契约
p = root / 'scripts' / 'publish-to-blog.py'
tree = ast.parse(p.read_text(encoding='utf-8'))
keep = {'_normalize_api_reader_explicit_symbol_projection', '_normalize_api_reader_display_artifacts'}
ast_ns = {'re': re, 'unicodedata': unicodedata}
exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in keep], type_ignores=[]), str(p), 'exec'), ast_ns)

payload = json.loads(sys.stdin.read())
out = {
    'cell': [publish._project_reader_cell_tex_display(v) for v in payload['cell']],
    'mathjax': [publish._collapse_mathjax_double_write(v) for v in payload['display']],
    'display': [publish._normalize_api_reader_display_artifacts(v) for v in payload['display']],
    'astDisplay': [ast_ns['_normalize_api_reader_display_artifacts'](v) for v in payload['display']],
    'sourceCell': [publish._normalize_api_reader_source_cell(v) for v in payload['display']],
    'cmpSame': [
        publish._reader_cell_comparison(raw) == publish._reader_cell_comparison(exp)
        for raw, exp in payload['pairs']
    ],
    'cmpGuards': [
        publish._reader_cell_comparison(raw) == publish._reader_cell_comparison(publish._project_reader_cell_tex_display(raw))
        for raw in payload['b3Guards']
    ],
    'cmpDiff': [
        publish._reader_cell_comparison('46.4 (−1.4)') != publish._reader_cell_comparison('46.4 (−1.4)(-0.8)'),
        publish._reader_cell_comparison('') != publish._reader_cell_comparison('[][]'),
        publish._reader_cell_comparison('') != publish._reader_cell_comparison('[][] \\(\\)'),
        publish._reader_cell_comparison('') != publish._reader_cell_comparison('[][] \\,'),
        publish._reader_cell_comparison('') != publish._reader_cell_comparison('[][] (\\,)'),
        publish._reader_cell_comparison('OmniVinci+PACD') != publish._reader_cell_comparison('[][] VideoLLaMA2-AV+PACD'),
    ],
}
sys.stdout.write(json.dumps(out, ensure_ascii=False))
`;
    const b3Guards = B3_NEGATIVE_CASES.map(([raw]) => raw);
    const py = JSON.parse(execFileSync('bash', [path.join(projectRoot, 'scripts/python-runtime.sh'), '-c', probe, projectRoot], {
        cwd: projectRoot,
        input: JSON.stringify({ cell: cellInputs, display: displayInputs, pairs, b3Guards }),
        encoding: 'utf8',
        env: { ...process.env, VERIFY_PROJECT_DISABLE_FILE_LOGS: '1' },
    }));
    assert.deepEqual(py.cell, cellInputs.map(v => projectReaderCellTexDisplay(v)));
    assert.deepEqual(py.mathjax, displayInputs.map(v => collapseParenthesizedSignedDoubleWrite(v)));
    assert.deepEqual(py.display, displayInputs.map(v => normalizeReaderSourceDisplayArtifacts(v)));
    assert.deepEqual(py.astDisplay, displayInputs.map(v => normalizeReaderSourceDisplayArtifacts(v)));
    assert.deepEqual(py.sourceCell, displayInputs.map(v => deep.normalizeReaderSourceCell(v)));
    assert.deepEqual(py.cmpSame, pairs.map(() => true));
    assert.deepEqual(py.cmpGuards, b3Guards.map(() => true));
    assert.deepEqual(py.cmpDiff, [true, true, true, true, true, true]);
});

test('HTML 全幅 colspan 表同时含 [][] 行首前缀与 (±X)(±X) 双写时新旧落盘稿均通过发布重放且拒篡改', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-w2-span-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
    t.after(() => {
        Config.FILES.dailyFreshSourceRunsDir = previous;
        fs.rmSync(root, { recursive: true, force: true });
    });
    const text = 'The source reports a controlled measurement of 1.0 under the same protocol. '.repeat(100).trim();
    const s = require('./reader-signed-draft-fixture').fixture({ noFigures: true, sourceText: text });

    const spanMatrix = [
        ['Method', 'World.↑\\uparrow', 'Daily.↑\\uparrow', 'Gain', 'D', 'E'],
        Array(6).fill('[][] Highlighted Group (−1.0)(-1.0)'),
        ['[][] VideoLLaMA2-AV+PACD', '46.4 (−1.4)(-1.4)', '47.9 (+0.2)(+0.2)', '(+9.9%)(+9.9%)', '1.0', '1.0'],
        ['[][] OmniVinci+PACD', '57.5 (−0.8)(-0.8)', '58.1 (−0.2)(-0.2)', '(−1.4%)(-1.4%)', '1.0', '1.0'],
    ];
    const spanTable = {
        ordinal: 1,
        recoveryStatus: 'complete',
        sourceDomSha256: 'a'.repeat(64),
        headerRows: [0],
        bodyRows: [1, 2, 3],
        matrix: spanMatrix,
        cells: [],
    };
    for (const [r, row] of spanMatrix.entries()) {
        if (r === 1) {
            spanTable.cells.push({
                row: r, column: 0, text: row[0], rowspan: 1, colspan: 6,
                header: false, sourceDomSha256: 'b'.repeat(64),
            });
        } else {
            for (const [c, value] of row.entries()) {
                spanTable.cells.push({
                    row: r, column: c, text: value, rowspan: 1, colspan: 1,
                    header: r === 0, sourceDomSha256: repair.shaText(`w2-span-${r}:${c}`),
                });
            }
        }
    }

    const { payloadSha256: _unused, ...body } = s.sourceDetails.structuredArtifacts;
    const sort = v => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
    const artifactBody = sort({ ...body, tables: [spanTable], formulas: [] });
    const artifacts = { ...artifactBody, payloadSha256: repair.shaText(JSON.stringify(artifactBody)) };
    const plan = daily.createDailyFreshSourcePlan({
        batchDate: '2026-11-19',
        batchId: 'w2-span-only',
        papers: [{ arxivId: s.paper.arxivId, title: 'W2 Span Table' }],
    });
    await daily.captureDailyFreshSources(plan, {
        concurrency: 1,
        capture: args => require('../scripts/lib/fresh-arxiv-rewrite-source').captureFreshArxivRewriteSource(args, {
            fetchText: async id => ({
                text, structuredArtifacts: artifacts, source: 'html', sourceId: id,
                url: `https://arxiv.org/html/${id}`, fetchedAt: '2026-11-19T00:00:00.000Z',
                imageInfos: [], warnings: [],
            }),
            fetchPdf: async id => ({
                bytes: Buffer.from('%PDF-1.7\n%%EOF\n'),
                url: `https://arxiv.org/pdf/${id}`,
                fetchedAt: '2026-11-19T00:00:01.000Z',
            }),
        }),
    });
    const source = daily.readDailyFreshSource(plan, s.paper);
    const draft = s.draft;
    draft.formulaBindings = [];
    draft.sections[4].body = draft.sections[4].body.replace(/\s*\[\[FORMULA_1\]\]/g, '');
    draft.sections[7].body = draft.sections[7].body.replace(/\| 比较条件[\s\S]*?仅支持当前口径 \|/, '[[TABLE_2]]');
    draft.tableBindings[1] = { tableIndex: 2, completeTable: { sourceTableOrdinal: 1 } };
    const prepared = order.normalizeReaderDraftOrder(draft, { structuredArtifacts: artifacts }).draft;
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(prepared), {
        requiredVersion: 3,
        requireIntegratedTables: true,
        minimumIntegratedTables: 2,
        requireSourceBindings: true,
        allowDeterministicQuoteRepair: true,
        sourceText: text,
        structuredArtifacts: artifacts,
        availableFigureOrdinals: [],
    });
    const paper = s.paper;
    parsed.plan.structuredSourcePayload = deep.readerStructuredSourcePayload(artifacts);
    Object.assign(paper, {
        sourceSha256: source.freshSourceDescriptor.sourceSha256,
        apiReaderArticle: parsed.article,
        apiReaderPlan: parsed.plan,
    });
    daily.withDailyFreshAnalysisContext(plan, () => fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source));
    paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256 = artifacts.payloadSha256;
    const stage = paper.analysisManifest.stages.apiReaderArticle;
    Object.assign(stage, {
        formulaBindingCount: 0,
        structuredArtifactsSha256: artifacts.payloadSha256,
        qualityMetrics: parsed.qualityMetrics,
        sourceBindingsSha256: parsed.plan.sourceBindingsSha256,
        articleSha256: repair.shaText(parsed.article),
        planSha256: daily.stableHash(parsed.plan),
    });
    paper.apiReaderArticleSha256 = stage.articleSha256;
    paper.apiReaderPlanSha256 = stage.planSha256;

    assert.equal(engine.hasValidIntegratedApiReaderRecords(paper), true);

    const projectRoot = path.resolve(__dirname, '..');
    let checkPageSeq = 0;
    const checkPage = (targetPaper, renderedOverride) => {
        const reqFile = path.join(root, `check-page-${++checkPageSeq}.json`);
        fs.writeFileSync(reqFile, JSON.stringify({ paper: targetPaper, runs: path.dirname(plan.runDir), override: renderedOverride || null }), 'utf8');
        return JSON.parse(execFileSync('bash', [path.join(projectRoot, 'scripts/python-runtime.sh'), '-c', `import sys, json
from pathlib import Path
sys.path.insert(0, 'tests/python')
from test_publish_to_blog import publish_to_blog as publish
req = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
publish.DAILY_FRESH_SOURCE_RUNS_DIR = Path(req['runs'])
p = req['paper']
projected = publish._collapse_mathjax_double_write(
    publish._project_artifact_table_cell_tex_display(
        publish._normalize_api_reader_display_artifacts(p['apiReaderArticle']),
        p['apiReaderPlan'],
    )
)
rendered = req.get('override') or projected
try:
    publish._validate_api_reader_source_bindings(p, rendered)
    print(json.dumps({'issue': None, 'rendered': projected}))
except Exception as e:
    print(json.dumps({'issue': str(e), 'rendered': projected}))`, reqFile], {
            cwd: projectRoot,
            encoding: 'utf8',
            env: { ...process.env, VERIFY_PROJECT_DISABLE_FILE_LOGS: '1' },
        }).trim());
    };

    const beforePaper = JSON.stringify(paper);
    const ok = checkPage(paper, null);
    assert.equal(ok.issue, null, ok.issue || '');
    assert.equal(JSON.stringify(paper), beforePaper);
    assert(!ok.rendered.includes('[][]'), 'rendered table must strip leading empty-link prefix');
    assert(ok.rendered.includes('| Highlighted Group (−1.0) |  |  |  |  |  |'));
    assert(ok.rendered.includes('| VideoLLaMA2-AV+PACD | 46.4 (−1.4) | 47.9 (+0.2) | (+9.9%) | 1.0 | 1.0 |'));
    assert(ok.rendered.includes('| OmniVinci+PACD | 57.5 (−0.8) | 58.1 (−0.2) | (−1.4%) | 1.0 | 1.0 |'));

    // 历史落盘稿兼容：全幅标题行及数据行保留未折叠原始 (±X)(±X) 字节与原 SHA，Node 与 Python 均通过校验。
    const legacySaved = structuredClone(paper);
    legacySaved.apiReaderArticle = legacySaved.apiReaderArticle
        .replace('46.4 (−1.4)', '46.4 (−1.4)(-1.4)')
        .replace('47.9 (+0.2)', '47.9 (+0.2)(+0.2)')
        .replace('Highlighted Group (−1.0)', 'Highlighted Group (−1.0)(-1.0)');
    for (const c of legacySaved.apiReaderPlan.tableBindings[1].cellBindings) {
        if (c.renderedText === '46.4 (−1.4)') c.renderedText = '46.4 (−1.4)(-1.4)';
        if (c.renderedText === '47.9 (+0.2)') c.renderedText = '47.9 (+0.2)(+0.2)';
        if (c.renderedText === '[][] Highlighted Group (−1.0)') {
            c.renderedText = '[][] Highlighted Group (−1.0)(-1.0)';
        }
    }
    const legacyTables = require('../scripts/analysis-contract').extractMarkdownTables(legacySaved.apiReaderArticle);
    legacySaved.apiReaderPlan.tableBindings[1].renderedTableSha256 = repair.shaText(legacyTables[1].markdown);
    legacySaved.apiReaderPlan.sourceBindingsSha256 = daily.stableHash({
        tableBindings: legacySaved.apiReaderPlan.tableBindings,
        formulaBindings: legacySaved.apiReaderPlan.formulaBindings,
    });
    legacySaved.apiReaderArticleSha256 = repair.shaText(legacySaved.apiReaderArticle);
    legacySaved.apiReaderPlanSha256 = daily.stableHash(legacySaved.apiReaderPlan);
    Object.assign(legacySaved.analysisManifest.stages.apiReaderArticle, {
        sourceBindingsSha256: legacySaved.apiReaderPlan.sourceBindingsSha256,
        articleSha256: legacySaved.apiReaderArticleSha256,
        planSha256: legacySaved.apiReaderPlanSha256,
    });
    assert.equal(engine.hasValidIntegratedApiReaderRecords(legacySaved), true);
    const legacyOk = checkPage(legacySaved, null);
    assert.equal(legacyOk.issue, null, legacyOk.issue || '');
    assert(legacyOk.rendered.includes('| Highlighted Group (−1.0) |  |  |  |  |  |'));

    for (const bad of [
        ok.rendered.replace('46.4 (−1.4)', '46.4 (−0.8)'),
        ok.rendered.replace('47.9 (+0.2)', '47.9 (−0.2)'),
        ok.rendered.replace('Highlighted Group (−1.0)', 'Other Group (−1.0)'),
        ok.rendered.replace('| VideoLLaMA2-AV+PACD |', '| OmniVinci+PACD |'),
        ok.rendered.replace('| VideoLLaMA2-AV+PACD |', '|  |'),
    ]) {
        assert.notEqual(checkPage(paper, bad).issue, null, `tampered rendered markdown must fail: ${bad}`);
        assert.notEqual(checkPage(legacySaved, bad).issue, null, `tampered legacy rendered markdown must fail: ${bad}`);
    }
});

test('配对 DOM 特征格表同含 [][] 与 (±X)(±X) 时新旧落盘稿均通过 Node 与 Python 配对校验且拒篡改', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-w2-paired-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
    t.after(() => {
        Config.FILES.dailyFreshSourceRunsDir = previous;
        fs.rmSync(root, { recursive: true, force: true });
    });
    const text = 'The source reports a controlled measurement of 1.0 under the same protocol. '.repeat(100).trim();
    const s = require('./reader-signed-draft-fixture').fixture({ noFigures: true, sourceText: text });

    const pairedMatrix = [
        ['Model', 'Latency↓{\\downarrow}', 'Score', 'Delta'],
        ['[][] VideoLLaMA2-AV+PACD', '12.4 ± \\pm 0.5 ms', '46.4 (−1.4)(-1.4)', '47.9 (+0.2)(+0.2)'],
        ['[][] OmniVinci+PACD', '10.2 ± \\pm 0.3 ms', '57.5 (−0.8)(-0.8)', '(+9.9%)(+9.9%)'],
    ];
    const pairedTable = {
        ordinal: 1,
        recoveryStatus: 'complete',
        sourceDomSha256: 'c'.repeat(64),
        headerRows: [0],
        bodyRows: [1, 2],
        matrix: pairedMatrix,
        cells: pairedMatrix.flatMap((row, r) => row.map((value, c) => ({
            row: r, column: c, text: value, rowspan: 1, colspan: 1,
            header: r === 0, sourceDomSha256: repair.shaText(`w2-paired-${r}:${c}`),
        }))),
    };

    const { payloadSha256: _unused, ...body } = s.sourceDetails.structuredArtifacts;
    const sort = v => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
    const artifactBody = sort({ ...body, tables: [pairedTable], formulas: [] });
    const artifacts = { ...artifactBody, payloadSha256: repair.shaText(JSON.stringify(artifactBody)) };
    const plan = daily.createDailyFreshSourcePlan({
        batchDate: '2026-11-19',
        batchId: 'w2-paired-dom',
        papers: [{ arxivId: s.paper.arxivId, title: 'W2 Paired DOM Table' }],
    });
    await daily.captureDailyFreshSources(plan, {
        concurrency: 1,
        capture: args => require('../scripts/lib/fresh-arxiv-rewrite-source').captureFreshArxivRewriteSource(args, {
            fetchText: async id => ({
                text, structuredArtifacts: artifacts, source: 'html', sourceId: id,
                url: `https://arxiv.org/html/${id}`, fetchedAt: '2026-11-19T00:00:00.000Z',
                imageInfos: [], warnings: [],
            }),
            fetchPdf: async id => ({
                bytes: Buffer.from('%PDF-1.7\n%%EOF\n'),
                url: `https://arxiv.org/pdf/${id}`,
                fetchedAt: '2026-11-19T00:00:01.000Z',
            }),
        }),
    });
    const source = daily.readDailyFreshSource(plan, s.paper);
    const paper = s.paper;
    daily.withDailyFreshAnalysisContext(plan, () => fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source));
    paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256 = artifacts.payloadSha256;

    const draft = s.draft;
    draft.formulaBindings = [];
    draft.sections[4].body = draft.sections[4].body.replace(/\s*\[\[FORMULA_1\]\]/g, '');
    draft.sections[7].body = draft.sections[7].body.replace(/\| 比较条件[\s\S]*?仅支持当前口径 \|/, '[[TABLE_2]]');
    draft.tableBindings[1] = { tableIndex: 2, completeTable: { sourceTableOrdinal: 1 } };
    const prepared = order.normalizeReaderDraftOrder(draft, { structuredArtifacts: artifacts }).draft;
    const parsed = daily.withDailyFreshAnalysisContext(plan, () => fresh.withFreshPaperContext(paper, () => deep.parseApiReaderArticleResult(JSON.stringify(prepared), {
        arxivId: paper.arxivId,
        requiredVersion: 3,
        requireIntegratedTables: true,
        minimumIntegratedTables: 2,
        requireSourceBindings: true,
        allowDeterministicQuoteRepair: true,
        sourceText: text,
        structuredArtifacts: artifacts,
        availableFigureOrdinals: [],
    })));
    parsed.plan.structuredSourcePayload = deep.readerStructuredSourcePayload(artifacts);
    Object.assign(paper, {
        sourceSha256: source.freshSourceDescriptor.sourceSha256,
        apiReaderArticle: parsed.article,
        apiReaderPlan: parsed.plan,
    });
    const stage = paper.analysisManifest.stages.apiReaderArticle;
    Object.assign(stage, {
        formulaBindingCount: 0,
        structuredArtifactsSha256: artifacts.payloadSha256,
        qualityMetrics: parsed.qualityMetrics,
        sourceBindingsSha256: parsed.plan.sourceBindingsSha256,
        articleSha256: repair.shaText(parsed.article),
        planSha256: daily.stableHash(parsed.plan),
    });
    paper.apiReaderArticleSha256 = stage.articleSha256;
    paper.apiReaderPlanSha256 = stage.planSha256;

    assert.doesNotThrow(() => pdfEvidence.withSavedPaper(paper, () => true));
    assert.equal(engine.hasValidIntegratedApiReaderRecords(paper), true);

    const projectRoot = path.resolve(__dirname, '..');
    let checkPairedSeq = 0;
    const checkPaired = targetPaper => {
        const reqFile = path.join(root, `check-paired-${++checkPairedSeq}.json`);
        fs.writeFileSync(reqFile, JSON.stringify({ paper: targetPaper, runs: path.dirname(plan.runDir) }), 'utf8');
        return JSON.parse(execFileSync('bash', [path.join(projectRoot, 'scripts/python-runtime.sh'), '-c', `import sys, json
from pathlib import Path
sys.path.insert(0, 'tests/python')
from test_publish_to_blog import publish_to_blog as publish
req = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
publish.DAILY_FRESH_SOURCE_RUNS_DIR = Path(req['runs'])
p = req['paper']
try:
    publish._verify_reader_paired_dom_bindings(p)
    projected = publish._collapse_mathjax_double_write(
        publish._project_artifact_table_cell_tex_display(
            publish._normalize_api_reader_display_artifacts(p['apiReaderArticle']),
            p['apiReaderPlan'],
        )
    )
    publish._validate_api_reader_source_bindings(p, projected)
    print(json.dumps({'issue': None, 'rendered': projected}))
except Exception as e:
    print(json.dumps({'issue': str(e)}))`, reqFile], {
            cwd: projectRoot,
            encoding: 'utf8',
            env: { ...process.env, VERIFY_PROJECT_DISABLE_FILE_LOGS: '1' },
        }).trim());
    };

    const ok = checkPaired(paper);
    assert.equal(ok.issue, null, ok.issue || '');
    assert(!ok.rendered.includes('[][]'));
    assert(ok.rendered.includes('| VideoLLaMA2-AV+PACD | 12.4 ± 0.5 ms | 46.4 (−1.4) | 47.9 (+0.2) |'));
    assert(ok.rendered.includes('| OmniVinci+PACD | 10.2 ± 0.3 ms | 57.5 (−0.8) | (+9.9%) |'));

    // 历史落盘稿兼容：配对 DOM 表保留未折叠原始 (±X)(±X) 字节与原 SHA，Node 与 Python 均通过校验。
    const legacyPaired = structuredClone(paper);
    legacyPaired.apiReaderArticle = legacyPaired.apiReaderArticle
        .replace('46.4 (−1.4)', '46.4 (−1.4)(-1.4)')
        .replace('47.9 (+0.2)', '47.9 (+0.2)(+0.2)');
    for (const c of legacyPaired.apiReaderPlan.tableBindings[1].cellBindings) {
        if (c.renderedText === '46.4 (−1.4)') c.renderedText = '46.4 (−1.4)(-1.4)';
        if (c.renderedText === '47.9 (+0.2)') c.renderedText = '47.9 (+0.2)(+0.2)';
    }
    const legacyTables = require('../scripts/analysis-contract').extractMarkdownTables(legacyPaired.apiReaderArticle);
    legacyPaired.apiReaderPlan.tableBindings[1].renderedTableSha256 = repair.shaText(legacyTables[1].markdown);
    legacyPaired.apiReaderPlan.sourceBindingsSha256 = daily.stableHash({
        tableBindings: legacyPaired.apiReaderPlan.tableBindings,
        formulaBindings: legacyPaired.apiReaderPlan.formulaBindings,
    });
    legacyPaired.apiReaderArticleSha256 = repair.shaText(legacyPaired.apiReaderArticle);
    legacyPaired.apiReaderPlanSha256 = daily.stableHash(legacyPaired.apiReaderPlan);
    Object.assign(legacyPaired.analysisManifest.stages.apiReaderArticle, {
        sourceBindingsSha256: legacyPaired.apiReaderPlan.sourceBindingsSha256,
        articleSha256: legacyPaired.apiReaderArticleSha256,
        planSha256: legacyPaired.apiReaderPlanSha256,
    });
    assert.doesNotThrow(() => pdfEvidence.withSavedPaper(legacyPaired, () => true));
    assert.equal(engine.hasValidIntegratedApiReaderRecords(legacyPaired), true);
    const legacyOk = checkPaired(legacyPaired);
    assert.equal(legacyOk.issue, null, legacyOk.issue || '');
    assert(legacyOk.rendered.includes('| VideoLLaMA2-AV+PACD | 12.4 ± 0.5 ms | 46.4 (−1.4) | 47.9 (+0.2) |'));

    // 篡改已落盘配对 DOM 数值仍须同时被 Node 与 Python 拒绝
    const tampered = structuredClone(paper);
    tampered.apiReaderArticle = tampered.apiReaderArticle.replace('46.4 (−1.4)', '46.4 (−0.8)');
    tampered.apiReaderPlan.tableBindings[1].cellBindings.find(c => c.renderedRow === 1 && c.renderedColumn === 2).renderedText = '46.4 (−0.8)';
    assert.throws(() => pdfEvidence.withSavedPaper(tampered, () => true));
    assert.notEqual(checkPaired(tampered).issue, null);
});

test('LaTeXML booktabs rule cell prefix projection stays symmetric and 2nd-order idempotent across Node and Python', () => {
    const { projectReaderCellTexDisplay } = require('../scripts/lib/reader-source-display');
    const positives = [
        ['\\topruleCodebook', 'Codebook'],
        ['\\midrule1', '1'],
        ['\\bottomrule', ''],
        ['  \\bottomrule  ', ''],
        ['\\toprule Codebook', 'Codebook'],
        ['  \\midrule\t1', '1'],
        ['\\midruleModel (−1.4)(-1.4)', 'Model (−1.4)'],
    ];
    const negatives = [
        'foo \\toprule bar',
        '\\top x',
        '\\mid',
        '\\bot',
        '\\toprule_1',
        '\\midrule^2',
        '\\bottomrule{x}',
        '\\toprule {x}',
        '\\toprule\\midrule1',
        '\\toprule \\midrule 1',
        '\\bottomrule\\bottomrule',
        '\\toprule \\,',
        '\\toprule (\\,)',
        '\\toprule (\\,) \\toprule foo',
        '\\toprule \u200b',
        '\\mathrm{Acc}',
        '\\hlineCodebook',
    ];
    for (const [raw, expected] of positives) {
        const out = projectReaderCellTexDisplay(raw);
        assert.equal(out, expected);
        assert.equal(projectReaderCellTexDisplay(out), out);
    }
    for (const raw of negatives) {
        const out = projectReaderCellTexDisplay(raw);
        assert.equal(projectReaderCellTexDisplay(out), out);
        assert(out.includes('\\'), `negative must preserve backslash: ${raw} -> ${out}`);
    }
    const allInputs = [...positives.map(([r]) => r), ...negatives];
    const projectRoot = path.resolve(__dirname, '..');
    const pyResults = JSON.parse(execFileSync('bash', [path.join(projectRoot, 'scripts/python-runtime.sh'), '-c', `import sys, json
sys.path.insert(0, 'tests/python')
from test_publish_to_blog import publish_to_blog as publish
items = json.load(sys.stdin)
print(json.dumps([publish._project_reader_cell_tex_display(x) for x in items]))`], {
        cwd: projectRoot,
        input: JSON.stringify(allInputs),
        encoding: 'utf8',
        env: { ...process.env, VERIFY_PROJECT_DISABLE_FILE_LOGS: '1' },
    }).trim());
    allInputs.forEach((raw, idx) => {
        assert.equal(projectReaderCellTexDisplay(raw), pyResults[idx], `Node vs Python mismatch for ${JSON.stringify(raw)}`);
    });
});
