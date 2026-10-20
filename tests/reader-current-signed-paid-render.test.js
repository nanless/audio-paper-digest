'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const os = require('node:os');
const replay = require('../scripts/lib/reader-paid-resolved-render');
const { hashDraft } = require('../scripts/lib/reader-repair');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = value => sha(JSON.stringify((function order(item) {
    if (Array.isArray(item)) return item.map(order);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, order(item[key])]));
})(value)));
function fixture() {
    const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/reader-current-signed-mscr-paid-render.json.gz'));
    assert.equal(sha(bytes), '04cd289d2f7a176e3d07287f263525b3adb5e481bc1878fa2962b7558fe091b0');
    return JSON.parse(zlib.gunzipSync(bytes));
}
// A signed parent cold-replays its actual four-file source. Never rely on a
// developer's production runtime being present, and never mock the seed gate.
const sealed = fixture();
const config = require('../scripts/config');
const previousSourceRoot = config.FILES.dailyFreshSourceRunsDir;
const privateSourceRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'current-paid-sealed-'));
const runDir = path.join(privateSourceRoot, sealed.parent.freshRewriteProvenance.runId);
const bundleDir = path.join(runDir, 'sources', '2610.24395', 'generation-000001');
fs.mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
const runBytes = Buffer.from(sealed.portableSealedSource.runManifestBase64, 'base64');
assert.equal(sha(runBytes), sealed.originalPhysicalSha256['run.json']);
fs.writeFileSync(path.join(runDir, 'run.json'), runBytes, { flag: 'wx', mode: 0o600 });
for (const [name, base64] of Object.entries(sealed.portableSealedSource.filesBase64)) {
    assert(['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json'].includes(name));
    const bytes = Buffer.from(base64, 'base64');
    assert.equal(sha(bytes), sealed.originalPhysicalSha256[name]);
    fs.writeFileSync(path.join(bundleDir, name), bytes, { flag: 'wx', mode: 0o600 });
}
config.FILES.dailyFreshSourceRunsDir = privateSourceRoot;
test.after(() => {
    config.FILES.dailyFreshSourceRunsDir = previousSourceRoot;
    fs.rmSync(privateSourceRoot, { recursive: true, force: true });
});
function input() {
    const f = fixture();
    return { ...f, checked: { envelope: f.envelope, identitySha: hashDraft(f.envelope.identity),
        assertUnchanged() {} }, expectedPaperSha256: stable(f.paper) };
}
function validate(f) {
    return replay.validateCurrentSignedPaidResolvedInput(f.paper, f.source, f.checked, {
        parent: f.parent, feedback: f.feedback, request: f.request, accepted: f.accepted,
        expectedPaperSha256: f.expectedPaperSha256, requestWindow: f.requestWindow
    });
}
function resignEnvelope(f) {
    f.envelope.payloadSha256 = hashDraft(f.envelope.payload);
    f.checked.identitySha = hashDraft(f.envelope.identity);
}
test('真实当前签名修订只接原唯一已付完整稿，不改候选、来源或原费用', () => {
    const f = input(), before = structuredClone(f.envelope);
    const payload = validate(f);
    assert.deepEqual(payload, f.envelope.payload);
    assert.notEqual(payload, f.envelope.payload);
    assert.deepEqual(f.envelope, before);
    // The candidate is the normally normalized accepted JSON, not a separately
    // archived raw HTTP body. Keep both real physical identities distinct.
    assert.equal(sha(payload.rawDraft), 'c2f9f8c8a4f1c4381f2aa0663d4d51128d2f7b50cb977a171d0df040eb2af832');
    assert.equal(f.request.outputTextSha256, '195b29850bb2cfc3ede27dbbc67118a3e65db6c1c2584b6c41e8f250b2c5dd7c');
    assert.notEqual(sha(payload.rawDraft), f.request.outputTextSha256);
    assert.equal(f.accepted.outputTextSha256, f.request.outputTextSha256);
    assert.equal(sha(f.source.text), f.originalPhysicalSha256['source.txt']);
    const draft = JSON.parse(payload.rawDraft);
    const main = draft.sections[9].body.split('\n').filter(line => line.startsWith('|'));
    assert.equal(main.length, 4);
    assert.equal(main[0].split('|').length - 2, 10);
    assert.match(main[2], /^\| MCR \| 74\.5 ± 0\.8 \| 85\.1 ± 0\.5/);
    assert.match(main[3], /^\| MSCR \| 75\.7 ± 1\.1 \| 86\.4 ± 0\.9/);
    assert.equal(draft.sections[12].body.split('\n').filter(line => line.startsWith('|')).length, 7);
});
test('隔离空runtime仍从真实原四文件冷核；缺失PDF或原字节变化不能建立父seed', () => {
    const f = input();
    assert.notEqual(path.resolve(privateSourceRoot), path.resolve(previousSourceRoot));
    assert.deepEqual(require('../scripts/analysis-engine').getApiReaderV3RecordDiagnostics(f.parent), []);
    assert.equal(fs.readdirSync(path.join(runDir, 'sources')).length, 1);
    const pdf = path.join(bundleDir, 'source.pdf'), pdfBytes = fs.readFileSync(pdf);
    fs.unlinkSync(pdf);
    try { assert.throws(() => validate(f), /定向修订需要完整/u); }
    finally { fs.writeFileSync(pdf, pdfBytes, { flag: 'wx', mode: 0o600 }); }
    const text = path.join(bundleDir, 'source.txt'), textBytes = fs.readFileSync(text);
    fs.appendFileSync(text, '\nnot original source bytes');
    try { assert.throws(() => validate(f), /定向修订需要完整/u); }
    finally { fs.writeFileSync(text, textBytes, { mode: 0o600 }); }
    assert.deepEqual(validate(f), f.envelope.payload);
});
test('当前父CAS、原签名parent、反馈、来源和请求身份逐项漂移均拒', () => {
    const changes = [
        f => { f.expectedPaperSha256 = 'f'.repeat(64); },
        f => { f.parent.apiReaderArticle += '\nchanged original parent'; },
        f => { f.parent.apiReaderPlan.readerTitle += ' changed'; },
        f => { f.feedback.reviewFeedback += ' changed'; },
        f => { f.feedback.parentArticleSha256 = 'f'.repeat(64); },
        f => { f.feedback.parentPlanSha256 = 'f'.repeat(64); },
        f => { f.feedback.paperId = '2610.24396v1'; },
        f => { f.source.text += ' changed'; },
        f => { f.source.structuredArtifacts.payloadSha256 = 'f'.repeat(64); },
        f => { f.envelope.identity.paperId = '2610.24396v1'; },
        f => { f.envelope.identity.contentMode = 'reader-source-only-v1'; },
        f => { f.envelope.identity.promptSha256 = 'f'.repeat(64); },
        f => { f.envelope.identity.repairPromptSha256 = 'f'.repeat(64); },
        f => { f.envelope.identity.freshAnalysis.sourceSha256 = 'f'.repeat(64); },
        f => { f.envelope.identity.model.model = 'another-model'; },
        f => { f.paper.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256 = 'f'.repeat(64);
            f.expectedPaperSha256 = stable(f.paper); }
    ];
    for (const [index, change] of changes.entries()) {
        const f = input(); change(f); resignEnvelope(f);
        assert.throws(() => validate(f), undefined, 'mutation ' + index);
    }
});
test('重算普通JSON哈希也不能替换原付费稿、accepted、请求输入或原账次数', () => {
    const changes = [
        f => { f.envelope.payload.draft.sections[9].body += '\nchanged accepted draft'; },
        f => { f.request.outputTextSha256 = 'f'.repeat(64); },
        f => { f.accepted.outputTextSha256 = 'f'.repeat(64); },
        f => { f.request.paperId = '2610.24396v1'; },
        f => { f.accepted.paperId = '2610.24396v1'; },
        f => { f.request.runId = 'another-run'; },
        f => { f.request.contentAttempt = 2; },
        f => { f.accepted.contentAttempt = 2; },
        f => { f.request.outcome = 'failed'; },
        f => { f.accepted.disposition = 'rejected'; },
        f => { f.requestWindow = undefined; },
        f => { f.request.at = '2026-10-20T05:38:34.537Z';
            f.accepted.at = '2026-10-20T05:38:35.157Z'; },
        f => { f.accepted.at = '2026-10-20T10:38:35.157Z'; },
        f => { f.requestWindow.finishedAt = f.requestWindow.startedAt; },
        f => { f.envelope.payload.attempts = 2; },
        f => { f.envelope.payload.fullAttempts = 2; },
        f => { f.envelope.payload.transportFailures = 1; },
        f => { f.envelope.payload.noProgress = 1; },
        f => { f.envelope.payload.validationFailureStreak = 1; },
        f => { f.envelope.payload.issues = [{ path: '/sections/9/body', message: 'still invalid' }]; },
        f => { f.envelope.payload.explicitReaderRetryRound = { roundId: 'fake' }; },
        f => { f.envelope.payload.readerRecoveryRevisions = [{ fake: true }]; },
        f => { f.envelope.payload.imageEvidence[0].sha256 = 'f'.repeat(64); },
        f => { f.checked.identitySha = 'f'.repeat(64); }
    ];
    for (const [index, change] of changes.entries()) {
        const f = input(); change(f);
        if (index !== changes.length - 1) resignEnvelope(f);
        assert.throws(() => validate(f), undefined, 'mutation ' + index);
    }
});

test('真实只读档案物理CAS拒合法SHA替换、规范化等价格式与保存前改写', () => {
    const f = fixture(), directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-current-paid-cas-')));
    fs.chmodSync(directory, 0o700);
    try {
        const name = hashDraft(f.envelope.identity) + '.b679f723-d250-404a-b8c6-e3699e0dd19b.resolved.json';
        const filename = path.join(directory, name);
        const original = JSON.stringify(f.envelope);
        fs.writeFileSync(filename, original, { mode: 0o600 });
        const checked = replay.readResolvedFile(directory, filename, sha(original));
        checked.assertUnchanged();
        for (const mutate of [
            envelope => { envelope.identity.inputFingerprint = 'f'.repeat(64); },
            envelope => { envelope.payload.rawDraft += ' '; },
            envelope => { envelope.payload.draft.sections[9].body += '\nchanged'; }
        ]) {
            const changed = structuredClone(f.envelope); mutate(changed);
            changed.payloadSha256 = hashDraft(changed.payload);
            fs.writeFileSync(filename, JSON.stringify(changed));
            assert.throws(() => replay.readResolvedFile(directory, filename, sha(original)));
            assert.throws(() => checked.assertUnchanged());
        }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

function tableOnlyUpdate(old) {
    const f = fixture(), updated = structuredClone(old);
    const tables = text => text.match(/^\|[^\n]*(?:\n\|[^\n]*)*/gm) || [];
    const original = tables(old.apiReaderArticle);
    const paid = JSON.parse(f.envelope.payload.rawDraft);
    const replacements = [[0, tables(paid.sections[9].body)[0]], [4, tables(paid.sections[12].body)[0]]];
    for (const [index, replacement] of replacements) {
        updated.apiReaderArticle = updated.apiReaderArticle.replace(original[index], replacement);
        updated.apiReaderPlan.tableBindings[index].renderedTableSha256 = sha(replacement);
    }
    updated.apiReaderArticleSha256 = sha(updated.apiReaderArticle);
    updated.apiReaderPlan.sourceBindingsSha256 = stable(updated.apiReaderPlan.tableBindings);
    updated.apiReaderPlanSha256 = stable(updated.apiReaderPlan);
    const stage = updated.analysisManifest.stages.apiReaderArticle;
    stage.articleSha256 = updated.apiReaderArticleSha256;
    stage.planSha256 = updated.apiReaderPlanSha256;
    stage.sourceBindingsSha256 = updated.apiReaderPlan.sourceBindingsSha256;
    return updated;
}
test('纯producer表格恢复保护表外正文、所有图式和非Reader上游及原次数', () => {
    const old = fixture().paper, updated = tableOnlyUpdate(old);
    assert.doesNotThrow(() => replay.assertCurrentSignedTableOnlyChange(old, updated));
    const changes = [
        p => { p.apiReaderArticle += '\nnew outside-table prose'; },
        p => { p.analysis += '\nchanged scientific main'; },
        p => { p.parsed.contribution = 'changed'; },
        p => { p.sourceSha256 = 'f'.repeat(64); },
        p => { p.apiReaderFigures[0].assetSha256 = 'f'.repeat(64); },
        p => { p.apiReaderFigures[0].explanationQuote += ' changed'; },
        p => { p.apiReaderPlan.figurePlacements[0].focusPoints[0] += ' changed'; },
        p => { p.apiReaderPlan.formulaBindings[0].latex += ' changed'; },
        p => { p.apiReaderAuthors = { changed: true }; },
        p => { p.apiReaderResources = { changed: true }; },
        p => { p.analysisManifest.stages.scoringAudit.status = 'failed'; },
        p => { p.analysisManifest.stages.apiReaderArticle.attempts++; },
        p => { p.analysisManifest.stages.apiReaderArticle.fullAttempts++; },
        p => { p.analysisManifest.stages.apiReaderArticle.transportFailures++; },
        p => { p.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256 = 'f'.repeat(64); },
        p => { p.analysisManifest.stages.apiReaderArticle.revisionSeedArticleSha256 = 'f'.repeat(64); },
        p => { p.analysisStageCheckpoints = {}; }
    ];
    for (const [index, change] of changes.entries()) {
        const changed = structuredClone(updated); change(changed);
        assert.throws(() => replay.assertCurrentSignedTableOnlyChange(old, changed), undefined, 'mutation ' + index);
    }
});
