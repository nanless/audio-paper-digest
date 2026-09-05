'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { applyOperatorPatch, patchPath } = require('../scripts/lib/reader-operator-patch.js');
const repair = require('../scripts/lib/reader-repair.js');
const runner = require('../scripts/lib/fresh-rewrite-run.js');
const RUN_ID = '11111111-2222-4333-8444-555555555555';
const PAPER_ID = '2609.03107';

function fixture(t) {
    const rootDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-operator-patch-'));
    t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
    const runDir = path.join(rootDir, RUN_ID);
    fs.mkdirSync(path.join(runDir, 'patches'), { recursive: true, mode: 0o700 });
    const paper = { arxivId: PAPER_ID, paper_id: PAPER_ID, title: 'Original title', abstract: 'Original source abstract' };
    const text = 'An original paper reports the measured source result, not a generated Reader.';
    const body = { flattenedTextSha256: runner.sha256(text), tables: [], formulas: [], figures: [] };
    const artifacts = { ...body, payloadSha256: repair.hashDraft(body) };
    const descriptor = { paperId: PAPER_ID, runId: RUN_ID, sourceSha256: runner.sha256(text),
        structuredArtifactsSha256: artifacts.payloadSha256, sourceSnapshotSha256: 'd'.repeat(64) };
    const source = { text, structuredArtifacts: artifacts, freshSourceDescriptor: descriptor };
    const run = { runId: RUN_ID, status: 'analysis_partial', paperIds: [PAPER_ID],
        sourceExpectations: { [PAPER_ID]: { sourceSha256: descriptor.sourceSha256,
            structuredArtifactsSha256: artifacts.payloadSha256 } } };
    const identity = { paperId: PAPER_ID, contentMode: 'reader-source-only-v1', sourceSha256: descriptor.sourceSha256,
        freshAnalysis: { contract: 'fresh-source-analysis-v1', ...descriptor,
            inputSetSha256: runner.stableHash(run.paperIds), sourceOnly: true, oldGeneratedTextIncluded: false } };
    const kinds = ['background', 'related_work', 'problem', 'method_overview', 'component', 'training',
        'experiment_setup', 'result', 'ablation', 'limitation', 'reproduction', 'synthesis'];
    const draft = { version: 3, readerTitle: '测试声音输入到可核对的输出流程', oneSentenceThesis: '原文提供输入、机制和对比条件。',
        sections: kinds.map((kind, index) => ({ kind, heading: `第${index}个阶段`, body: '原始正文。'.repeat(30) })),
        conceptBridges: Array.from({ length: 4 }, () => ({ terms: ['声音', '证据'], explanation: '原始解释' })),
        figurePlacements: [], tableBindings: [], formulaBindings: [] };
    const payload = { status: 'failed', draft, rawDraft: JSON.stringify(draft), attempts: 6, fullAttempts: 2,
        transportFailures: 4, noProgress: 2, failureSignature: 'original-signature',
        issues: [{ path: null, message: 'previous production failure' }], imageEvidence: [],
        readerRecoveryRevisions: [{ preserved: true }], opaqueDiagnostic: { keep: 'unchanged' } };
    const candidateDir = path.join(runDir, 'reader-attempts');
    const candidateFile = repair.saveFailedCandidate(candidateDir, identity, payload);
    const request = { paperId: PAPER_ID, candidateIdentitySha256: repair.hashDraft(identity), sourceSha256: descriptor.sourceSha256,
        reason: '依据原文修正当前新草稿的局部解释，保持来源与预算。', patch: { version: 1, draftSha256: repair.hashDraft(draft),
            replacements: [{ path: '/sections/0/body', oldSha256: repair.hashDraft(draft.sections[0].body), value: '修正后的原文解释。'.repeat(30) }] } };
    const filename = path.join(runDir, 'patches', 'fix.json');
    const writeRequest = () => fs.writeFileSync(filename, JSON.stringify(request), { mode: 0o600 });
    writeRequest();
    const calls = { parser: 0, lock: 0, source: 0 };
    const deps = { rootDir, now: () => '2026-09-06T12:00:00Z',
        readFreshSource: () => { calls.source++; return source; },
        withPaperAnalysisLock: async (p, callback) => { assert.equal(p.arxivId, PAPER_ID); calls.lock++; return callback(); },
        buildApiReaderEvidenceContext: (analysis, textArg, artifactsArg, id) => {
            assert.equal(analysis, ''); assert.equal(textArg, text); assert.equal(artifactsArg, artifacts);
            assert.equal(id, PAPER_ID); return 'TABLE_1: first\nTABLE_2: second\nTABLE_3: third';
        },
        parseApiReaderArticleResult: (raw, options) => {
            calls.parser++; assert.equal(typeof JSON.parse(raw).sections[0].body, 'string');
            assert.equal(options.minimumIntegratedTables, 3);
            assert.equal(options.requiredVersion, 3); assert.equal(options.requireIntegratedTables, true);
            assert.equal(options.requireSourceBindings, true); assert.equal(options.allowDeterministicQuoteRepair, true);
            assert.deepEqual(options.availableFigureOrdinals, []); assert.equal(options.structuredArtifacts, artifacts);
            assert.equal(options.sourceText, text); return { article: 'must never be saved as success' };
        } };
    const loaded = { runDir, run, inputs: { papers: [paper] }, analysis: { papers: [paper] } };
    return { rootDir, runDir, run, paper, loaded, source, identity, payload, draft, candidateDir, candidateFile,
        request, filename, writeRequest, calls, deps, apply: extra => applyOperatorPatch({ loaded, patchFile: 'fix.json' }, { ...deps, ...extra }) };
}

test('operator patch saves only a failed candidate, preserves every budget, and archives exact old bytes', async t => {
    const f = fixture(t); const before = fs.readFileSync(f.candidateFile); const patchBytes = fs.readFileSync(f.filename);
    const result = await f.apply();
    assert.equal(result.status, 'failed'); assert.equal(result.alreadyApplied, false);
    const saved = repair.loadFailedCandidate(f.candidateDir, f.identity);
    for (const key of ['attempts', 'fullAttempts', 'transportFailures', 'noProgress', 'failureSignature', 'issues',
        'readerRecoveryRevisions', 'opaqueDiagnostic', 'imageEvidence']) assert.deepEqual(saved[key], f.payload[key]);
    assert.notEqual(repair.hashDraft(saved.draft), repair.hashDraft(f.draft));
    assert.equal(saved.rawDraft, JSON.stringify(saved.draft)); assert.equal(saved.status, 'failed');
    assert.equal(saved.operatorPatches.length, 1);
    const audit = saved.operatorPatches[0];
    assert.equal(audit.oldPayloadSha256, repair.hashDraft(f.payload));
    assert.equal(audit.oldEnvelopeSha256, runner.sha256(before));
    assert.equal(audit.patchFileSha256, runner.sha256(patchBytes));
    const archive = path.join(f.runDir, audit.archive);
    assert.deepEqual(fs.readFileSync(path.join(archive, 'before.json')), before);
    assert.deepEqual(fs.readFileSync(path.join(archive, 'patch.json')), patchBytes);
    assert.equal(fs.statSync(path.join(archive, 'before.json')).mode & 0o777, 0o600);
    assert.equal(f.calls.lock, 1); assert.equal(f.calls.parser, 1);
    assert.equal(fs.existsSync(path.join(f.runDir, 'analysis.json')), false);
});

test('crashes before and after candidate save reenter with the same audit and unchanged counters', async t => {
    const f = fixture(t); const before = fs.readFileSync(f.candidateFile);
    await assert.rejects(f.apply({ afterArchive: () => { throw new Error('simulated crash after archive'); } }), /simulated crash/);
    assert.deepEqual(fs.readFileSync(f.candidateFile), before);
    await assert.rejects(f.apply({ afterSave: () => { throw new Error('simulated crash after save'); } }), /simulated crash/);
    const installed = fs.readFileSync(f.candidateFile);
    const result = await f.apply(); assert.equal(result.alreadyApplied, true);
    assert.deepEqual(fs.readFileSync(f.candidateFile), installed);
    assert.equal(repair.loadFailedCandidate(f.candidateDir, f.identity).operatorPatches.length, 1);
});

test('invalid production output does not write candidate or an audit directory', async t => {
    const f = fixture(t); const before = fs.readFileSync(f.candidateFile);
    await assert.rejects(f.apply({ parseApiReaderArticleResult: () => { throw new Error('production table/figure/source gate'); } }), /production/);
    assert.deepEqual(fs.readFileSync(f.candidateFile), before);
    assert.deepEqual(fs.readdirSync(path.join(f.runDir, 'patches')), ['fix.json']);
});

test('the real production parser rejects incomplete Reader output before persistence', async t => {
    const f = fixture(t); const before = fs.readFileSync(f.candidateFile);
    await assert.rejects(f.apply({ parseApiReaderArticleResult: require('../scripts/deep-analyzer.js').parseApiReaderArticleResult }));
    assert.deepEqual(fs.readFileSync(f.candidateFile), before);
    assert.equal(fs.existsSync(path.join(f.runDir, 'patches', 'operator-archive')), false);
});

test('stale draft and node SHA, source mismatch, cross-run identity and append paths fail closed', async t => {
    for (const mutate of [f => { f.request.patch.draftSha256 = '0'.repeat(64); },
        f => { f.request.patch.replacements[0].oldSha256 = '0'.repeat(64); },
        f => { f.request.sourceSha256 = '0'.repeat(64); },
        f => { f.request.paperId = '2609.99999'; },
        f => { f.source.freshSourceDescriptor.runId = 'foreign'; },
        f => { f.request.patch.replacements[0].path = '/sections/12'; },
        f => { f.request.patch.replacements[0].path = '/sections'; },
        f => { f.request.patch.replacements[0].path = '/version'; }]) {
        const f = fixture(t); mutate(f); f.writeRequest(); const before = fs.readFileSync(f.candidateFile);
        await assert.rejects(f.apply()); assert.deepEqual(fs.readFileSync(f.candidateFile), before);
        assert.equal(fs.existsSync(path.join(f.runDir, 'patches', 'operator-archive')), false);
    }
});

test('patch file traversal, symlink, hardlink and permissions cannot escape the private run directory', async t => {
    const f = fixture(t);
    for (const name of ['../fix.json', '/tmp/fix.json', 'nested/fix.json', 'fix.txt']) assert.throws(() => patchPath(f.runDir, name));
    fs.chmodSync(f.filename, 0o644); await assert.rejects(f.apply(), /0600/); fs.chmodSync(f.filename, 0o600);
    const copy = path.join(f.runDir, 'original.json'); fs.renameSync(f.filename, copy); fs.symlinkSync(copy, f.filename);
    await assert.rejects(f.apply(), /ELOOP|symbolic/i); fs.unlinkSync(f.filename); fs.linkSync(copy, f.filename);
    await assert.rejects(f.apply(), /single-link/);
});

test('duplicate active identity and resolved-only files cannot be patched', async t => {
    const f = fixture(t);
    const otherIdentity = { ...f.identity, changed: true };
    const otherPath = repair.saveFailedCandidate(f.candidateDir, otherIdentity, f.payload);
    await assert.rejects(f.apply(), /multiple active/);
    fs.unlinkSync(otherPath); fs.renameSync(f.candidateFile, f.candidateFile.replace('.json', '.resolved.json'));
    await assert.rejects(f.apply(), /ENOENT/);
});

test('patch cannot invent unseen pixels and source identity drift blocks the parser', async t => {
    const f = fixture(t); f.request.patch.replacements[0].value = '说明\n\n[[FIGURE_1]]\n\n解释'; f.writeRequest();
    await assert.rejects(f.apply(), /pixels/); assert.equal(f.calls.parser, 0);
    f.source.text += ' drift'; await assert.rejects(f.apply(), /source snapshot/);
});

test('CAS rejects candidate/request races and idempotent replay refuses corrupted old-byte archives', async t => {
    const f = fixture(t);
    await assert.rejects(f.apply({ afterArchive: () => fs.appendFileSync(f.filename, ' ') }), /bytes changed/);
    f.writeRequest(); await f.apply();
    const saved = repair.loadFailedCandidate(f.candidateDir, f.identity);
    fs.appendFileSync(path.join(f.runDir, saved.operatorPatches[0].archive, 'before.json'), ' ');
    await assert.rejects(f.apply(), /audit.*drifted/);
});

test('CLI patch phase is explicit and accepts only run-local patch names', () => {
    assert.deepEqual(runner.parseRewriteArgs(['patch', '--run-id', RUN_ID, '--patch', 'fix.json']),
        { action: 'patch', runId: RUN_ID, patchFile: 'fix.json' });
    for (const args of [['patch', '--run-id', RUN_ID], ['patch', '--run-id', RUN_ID, '--patch', '../fix.json'],
        ['analyze', '--run-id', RUN_ID, '--patch', 'fix.json'],
        ['patch', '--run-id', RUN_ID, '--patch', 'fix.json', '--concurrency', '1']]) assert.throws(() => runner.parseRewriteArgs(args));
});
