const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseArgs, loadInputs, replaySnapshotPlan, snapshotFigures, safeOutputDirectory, evaluate, stableHash, BUDGETS }
    = require('../scripts/evaluate-reader-efficiency.js');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-eval-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sourceText = 'Under protocol A, the proposed method reports 12 dB on the held-out set.';
    const artifacts = { sourceId: '2609.99980', tables: [{ ordinal: 1, sourceDomSha256: '1'.repeat(64) }],
        formulas: [{ ordinal: 1, latex: 'a=b', sourceDomSha256: '2'.repeat(64) }], figures: [],
        flattenedTextSha256: sha(sourceText) };
    artifacts.payloadSha256 = sha(JSON.stringify(artifacts));
    const plan = { version: 3, sections: [{ kind: 'result', heading: '同一条件下比较结果' }], figurePlacements: [],
        formulaBindings: [{ formulaOrdinal: 1, latex: 'a=b', sourceDomSha256: '2'.repeat(64) }],
        tableBindings: [{ sourceType: 'artifact_table', sourceTableOrdinal: 1, sourceTableDomSha256: '1'.repeat(64) },
            { sourceType: 'source_quotes', sourceQuotes: [{ quote: sourceText, sourceQuoteSha256: sha(sourceText) }] }] };
    const article = '### 同一条件下比较结果\n\n必须先限定相同测试条件，才可以比较报告值。';
    const paper = { arxivId: '2609.99980', analysis: '已冻结的 canonical 内容',
        sourceSha256: sha(sourceText), structuredArtifactsSha256: artifacts.payloadSha256,
        apiReaderArticle: article, apiReaderArticleSha256: sha(article), apiReaderPlan: plan,
        apiReaderPlanSha256: stableHash(plan), apiReaderFigures: [],
        analysisManifest: { sourceAcquisition: { sourceSha256: sha(sourceText), structuredArtifactsSha256: artifacts.payloadSha256 },
            stages: { apiReaderArticle: { articleSha256: sha(article), planSha256: stableHash(plan), structuredArtifactsSha256: artifacts.payloadSha256 } } } };
    const options = { paperId: paper.arxivId, sourceTextPath: path.join(root, 'source.txt'),
        artifactsPath: path.join(root, 'artifacts.json'), snapshotPath: path.join(root, 'paper.json'),
        outputDir: path.join(root, 'output'), live: false };
    fs.writeFileSync(options.sourceTextPath, sourceText);
    fs.writeFileSync(options.artifactsPath, JSON.stringify(artifacts));
    fs.writeFileSync(options.snapshotPath, JSON.stringify(paper));
    return { root, options, sourceText, artifacts, paper };
}

test('CLI defaults to offline and requires explicit, unique input/output flags', () => {
    const argv = ['--paper', '2609.99980v2', '--source-text', '/private/tmp/source.txt', '--artifacts', '/private/tmp/artifacts.json',
        '--paper-snapshot', '/private/tmp/paper.json', '--output-dir', '/private/tmp/evaluation'];
    assert.equal(parseArgs(argv).live, false);
    assert.equal(parseArgs(argv).paperId, '2609.99980');
    assert.equal(parseArgs([...argv, '--live']).live, true);
    assert.throws(() => parseArgs([...argv, '--live', '--live']), /Duplicate/);
    assert.throws(() => parseArgs(argv.slice(0, -2)), /missing/);
    assert.throws(() => parseArgs([...argv, '--model', 'fake']), /Invalid/);
    assert.equal(BUDGETS.logicalRequests, 3);
    assert.equal(BUDGETS.transportAttemptsPerRequest, 1);
});

test('source and artifact payload must replay the same signed snapshot', t => {
    const f = fixture(t);
    assert.equal(loadInputs(f.options).artifactSha256, f.artifacts.payloadSha256);
    fs.writeFileSync(f.options.sourceTextPath, f.sourceText + ' changed');
    assert.throws(() => loadInputs(f.options), /Source text SHA/);
    fs.writeFileSync(f.options.sourceTextPath, f.sourceText);
    const changed = structuredClone(f.artifacts); changed.tables[0].sourceDomSha256 = '3'.repeat(64);
    fs.writeFileSync(f.options.artifactsPath, JSON.stringify(changed));
    assert.throws(() => loadInputs(f.options), /Structured artifact SHA/);
    delete changed.payloadSha256; changed.payloadSha256 = sha(JSON.stringify(changed));
    fs.writeFileSync(f.options.artifactsPath, JSON.stringify(changed));
    assert.throws(() => loadInputs(f.options), /differs from the signed/);
    fs.writeFileSync(f.options.artifactsPath, JSON.stringify({ text: f.sourceText, tables: [], formulas: [] }));
    assert.throws(() => loadInputs(f.options), /summary cannot be re-signed/);
});

test('baseline replay rejects altered plan/article, formula identity and exact quote provenance', t => {
    const f = fixture(t);
    assert.equal(replaySnapshotPlan(f.paper, f.artifacts, f.sourceText).status, 'replayed');
    const changed = structuredClone(f.paper); changed.apiReaderArticle += 'new';
    assert.throws(() => replaySnapshotPlan(changed, f.artifacts, f.sourceText), /SHA mismatch/);
    const artifacts = structuredClone(f.artifacts); artifacts.formulas[0].latex = 'a=c';
    assert.throws(() => replaySnapshotPlan(f.paper, artifacts, f.sourceText), /formula binding/);
    assert.throws(() => replaySnapshotPlan(f.paper, f.artifacts, 'different source'), /source quote/);
});

test('only existing figure cache bytes with the recorded SHA are accepted', t => {
    const f = fixture(t);
    const cachePath = path.join(f.root, 'figure.png');
    fs.writeFileSync(cachePath, 'fixture pixels');
    f.paper.apiReaderFigures = [{ ordinal: 1, cachePath, assetSha256: sha('fixture pixels') }];
    assert.equal(snapshotFigures(f.paper).length, 1);
    fs.writeFileSync(cachePath, 'changed pixels');
    assert.throws(() => snapshotFigures(f.paper), /SHA mismatch/);
});

test('output refuses current, overlapping inputs, existing content and symlink directories', t => {
    const f = fixture(t);
    const current = path.join(f.root, 'current'); fs.mkdirSync(current);
    assert.throws(() => safeOutputDirectory(path.join(current, 'experiment'), [], current), /outside data\/current/);
    assert.throws(() => safeOutputDirectory(f.root, [f.options.sourceTextPath], current), /contain an input/);
    const existing = path.join(f.root, 'existing'); fs.mkdirSync(existing); fs.writeFileSync(path.join(existing, 'keep.txt'), 'keep');
    assert.throws(() => safeOutputDirectory(existing, [], current), /fresh empty/);
    const target = path.join(f.root, 'target'); fs.mkdirSync(target);
    const link = path.join(f.root, 'link'); fs.symlinkSync(target, link);
    assert.throws(() => safeOutputDirectory(link, [], current), /Unsafe/);
    assert.equal(fs.readFileSync(path.join(existing, 'keep.txt'), 'utf8'), 'keep');
});

test('default offline evaluation makes no model calls, writes a private report, and preserves source/canonical files', async t => {
    const f = fixture(t);
    const before = [f.options.sourceTextPath, f.options.artifactsPath, f.options.snapshotPath]
        .map(filename => sha(fs.readFileSync(filename)));
    const deepModulePath = require.resolve('../scripts/deep-analyzer.js');
    assert.equal(require.cache[deepModulePath], undefined);
    const report = await evaluate(f.options);
    assert.equal(report.status, 'offline_replay_complete');
    assert.equal(report.calls.length, 0);
    assert.equal(report.usage.status, 'not_requested');
    assert.equal(report.integrity.unchanged, true);
    assert.equal(require.cache[deepModulePath], undefined, 'offline evaluation never imports the model generation module');
    assert.deepEqual([f.options.sourceTextPath, f.options.artifactsPath, f.options.snapshotPath]
        .map(filename => sha(fs.readFileSync(filename))), before);
    assert.deepEqual(fs.readdirSync(f.options.outputDir), ['report.json']);
    assert.equal(fs.statSync(path.join(f.options.outputDir, 'report.json')).mode & 0o777, 0o600);
});

test('invalid archived artifact writes a failure report without loading model code', async t => {
    const f = fixture(t);
    fs.writeFileSync(f.options.artifactsPath, JSON.stringify({ text: f.sourceText, tables: [], formulas: [] }));
    const report = await evaluate(f.options);
    assert.equal(report.status, 'failed');
    assert.match(report.error.message, /complete production structured artifact/);
    assert.equal(report.calls.length, 0);
    assert.equal(report.integrity.unchanged, true);
    assert.equal(require.cache[require.resolve('../scripts/deep-analyzer.js')], undefined);
});
