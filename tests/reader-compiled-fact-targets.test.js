'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const zlib = require('node:zlib'), crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reader-compiled-fact-')));
const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,
    'fixtures/reader-compiled-fact-2610.41381-real.json.gz'))));
require('./helpers/isolated-tmp-write-guard.cjs').installTmpOnlyWriteGuard(tmp, {
    readOnlyPythonScripts: ['reader_sealed_pdf_quote_evidence.py', 'reader_sealed_pdf_table_evidence.py', 'reader_pdf_cell_evidence.py']
        .map(name => path.join(tmp, 'scripts', name)),
    readOnlyPythonStdinScripts: [path.join(tmp, 'scripts/reader_pdf_cell_evidence.py')],
    readOnlyGitBlobOids: Object.keys(fixture.promptGitBlobs)
});
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function write(file, bytes) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, bytes, { mode: 0o600 });
}
function copy(from, to) {
    if (fs.statSync(from).isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        for (const name of fs.readdirSync(from)) copy(path.join(from, name), path.join(to, name));
    } else write(to, fs.readFileSync(from));
}
for (const name of ['scripts', 'manual', 'config', 'prompts']) copy(path.join(ROOT, name), path.join(tmp, name));
for (const [oid, encoded] of Object.entries(fixture.promptGitBlobs)) {
    const bytes = Buffer.from(encoded, 'base64'), object = Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes]);
    assert.equal(crypto.createHash('sha1').update(object).digest('hex'), oid);
    write(path.join(tmp, '.git/objects', oid.slice(0, 2), oid.slice(2)), zlib.deflateSync(object));
}
write(path.join(tmp, '.git/HEAD'), 'ref: refs/heads/test\n');
write(path.join(tmp, '.git/config'), '[core]\nrepositoryformatversion = 0\nbare = false\n');
fs.mkdirSync(path.join(tmp, '.git/refs/heads'), { recursive: true });
write(path.join(tmp, 'package.json'), '{"type":"commonjs"}');
write(path.join(tmp, '.paper-digest-workspace-role.json'), JSON.stringify({ contract: 'paper-digest-workspace-role-v1',
    version: 1, role: 'daily', workspaceRealpath: tmp }));
write(path.join(tmp, '.env'), 'PAPER_ANALYZER_MODEL=muse-spark-1.3-contributor\nPAPER_ANALYZER_API_KEY=unused-no-network\n'
    + 'PAPER_ANALYZER_ENDPOINT=https://invalid.example/v1\nHTTPS_PROXY=http://127.0.0.1:9\nHTTP_PROXY=http://127.0.0.1:9\n');
const shellQuote = value => "'" + value.replace(/'/g, "'\\''") + "'";
write(path.join(tmp, '.venv/bin/python'), '#!/bin/sh\ncd ' + shellQuote(ROOT) + '\nexec bash '
    + shellQuote(path.join(ROOT, 'scripts/python-runtime.sh')) + ' "$@"\n');
fs.chmodSync(path.join(tmp, '.venv/bin/python'), 0o700);
process.env.NODE_PATH = [path.join(ROOT, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
require('node:module').Module._initPaths();
process.env.TMPDIR = tmp; process.env.TMP = tmp; process.env.TEMP = tmp;
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1'; process.env.PYTHONDONTWRITEBYTECODE = '1';
const deny = () => { throw Error('test forbids network/model requests'); };
require('node:net').Socket.prototype.connect = deny; require('node:tls').connect = deny;
for (const name of ['node:http', 'node:https']) { require(name).request = deny; require(name).get = deny; }
globalThis.fetch = deny;
const load = name => require(path.join(tmp, 'scripts', name));
const Config = load('config'), daily = load('lib/daily-fresh-source-plan'), fresh = load('lib/fresh-analysis-context');
const direct = load('lib/direct-rewrite-analysis-context'), facts = load('lib/daily-fact-review');
const repair = load('lib/reader-repair'), deep = load('deep-analyzer');
const runDir = path.join(Config.FILES.dailyFreshSourceRunsDir, fixture.reference.runId);
write(path.join(runDir, 'run.json'), fixture.runBytes);
for (const [name, bytes] of Object.entries(fixture.sourceFiles)) write(path.join(runDir,
    'sources/2610.41381/generation-000001', name), Buffer.from(bytes, 'base64'));
const plan = daily.readDailyFreshSourcePlan(fixture.reference), paper = fixture.paper;
const envelope = JSON.parse(fixture.candidateBytes), feedback = JSON.parse(fixture.feedbackBytes);
const draft = envelope.payload.draft, expectedPaths = ['/sections/12/body', '/tableBindings/2', '/tableBindings/3'];
function parse(value, source) {
    return deep.parseApiReaderArticleResult(JSON.stringify(value), { arxivId: paper.arxivId,
        availableFigureOrdinals: envelope.payload.imageEvidence.map(item => item.ordinal), requiredVersion: 3,
        requireIntegratedTables: true, minimumIntegratedTables: 4, requireSourceBindings: true,
        allowDeterministicQuoteRepair: true, allowDeterministicUnsupportedClaimPruning: true,
        verifiedResourceIdentity: paper.apiReaderResources, enforceResourceAvailabilityClaims: true,
        structuredArtifacts: source.structuredArtifacts, sourceText: source.text });
}
const scoped = callback => daily.withDailyFreshAnalysisContext(plan, () => fresh.withFreshPaperContext(paper,
    () => daily.withDailyFreshPaperSource(plan, structuredClone(paper), callback)));

test('actual paid patch/source/full parser reproduces two rejected rendered tables and exactly three old-SHA nodes', async () => {
    assert.equal(sha(fixture.candidateBytes), fixture.provenance.candidateSha256);
    assert.equal(repair.hashDraft(envelope.payload), envelope.payloadSha256);
    assert.equal(envelope.payload.attempts, 2); assert.equal(envelope.payload.fullAttempts, 1);
    assert.equal(envelope.payload.noProgress, 1); assert.equal(envelope.payload.validationFailureStreak, 2);
    const before = JSON.stringify(envelope);
    const request = JSON.parse(fixture.requestBytes), response = JSON.parse(fixture.responseBytes);
    assert.equal(response.requestSha256, sha(fixture.requestBytes));
    assert.equal(response.outputTextSha256, sha(response.rawResponse));
    assert.equal(repair.hashDraft(request.identity), repair.hashDraft(envelope.identity));
    assert.equal(request.contentAttempt, 2);
    const paid = repair.applyReaderPatch(request.draft, JSON.parse(response.rawResponse), request.repairTargets.map(t => t.path));
    assert.deepEqual(paid, draft, 'actual saved paid patch yields current candidate without manufacturing a repaired draft');
    assert.match(JSON.parse(response.rawResponse).replacements[0].value, /9,932\.444/);
    await scoped(source => {
        const parsed = parse(paid, source), bound = facts.validateFeedback(feedback, plan, paper);
        assert.deepEqual(feedback.rejectedReaderClaims.map(claim => parsed.article.includes(claim)), [false, true, true]);
        facts.withFactReview(bound, () => assert.throws(() => facts.validateRepairedClaims('apiReaderArticle', parsed.article,
            paper.arxivId), /仍包含已证实错误/));
        const issues = repair.verifiedCompiledReaderTableFactIssues(paid, feedback.rejectedReaderClaims, parsed);
        assert.deepEqual(issues.map(issue => issue.sourceTableOrdinal), [3, 8]);
        assert.deepEqual(issues.map(issue => issue.path), ['/sections/12/body', '/sections/12/body']);
        const error = Object.assign(Error('actual fact gate rejection'), { code: 'READER_VERIFIED_FACT_CLAIM', readerIssues: issues });
        const collected = repair.collectDraftIssues(paid, error, { sourceText: source.text, structuredArtifacts: source.structuredArtifacts });
        const targets = repair.buildRepairTargets(paid, collected, { structuredArtifacts: source.structuredArtifacts });
        assert.deepEqual(targets.map(target => target.path).sort(), expectedPaths);
        for (const target of targets) assert.equal(target.oldSha256,
            repair.hashDraft(target.path.slice(1).split('/').reduce((value, key) => value[key], paid)));
        load('lib/reader-sealed-pdf-quote-evidence').withArtifacts(source.structuredArtifacts, paper.arxivId, () => {
            const context = repair.buildRepairContext(paid, collected, '', source.text, { structuredArtifacts: source.structuredArtifacts });
            assert.match(repair.repairOperationProtocol(context), /source_quotes/);
            assert.match(repair.repairOperationProtocol(context), /pdfSourceQuotes/);
            assert.equal(context.sealedPdfQuoteDocumentAvailable, true);
            assert.match(context.targetGuidance, /独立的官方封存 PDF 原字符全文/);
            assert.doesNotMatch(repair.repairOperationProtocol(context), /本轮不修改表格/);
        });
        assert.equal(parsed.article.includes('即 9,932.444 个密集特征值'), true);
        assert.equal(parsed.article.includes('−-1.90 [−-3.29, −-0.50]'), true, 'real negative evidence remains rejected, not silently cleaned');
    });
    assert.equal(JSON.stringify(envelope), before, 'no candidate/count/failure mutation');
});

test('copied result/issues, changed current draft, forged article/binding and cross-scope reuse cannot grant nodes', async () => {
    let escapedParsed, escapedIssues;
    await scoped(source => {
        const parsed = parse(draft, source), issues = repair.verifiedCompiledReaderTableFactIssues(draft, feedback.rejectedReaderClaims, parsed);
        assert.equal(issues.length, 2); escapedParsed = parsed; escapedIssues = issues;
        assert.deepEqual(repair.verifiedCompiledReaderTableFactIssues(draft, feedback.rejectedReaderClaims, structuredClone(parsed)), []);
        assert.deepEqual(repair.buildRepairTargets(draft, structuredClone(issues)), []);
        for (const mutate of [value => { value.sections[12].body += '\nchanged'; }, value => { value.tableBindings[2].selection.sourceTableOrdinal = 8; }]) {
            const changed = structuredClone(draft); mutate(changed);
            assert.notDeepEqual(changed, draft);
            assert.deepEqual(repair.verifiedCompiledReaderTableFactIssues(changed, feedback.rejectedReaderClaims, parsed), []);
            assert.deepEqual(repair.buildRepairTargets(changed, issues), []);
        }
        const old = parsed.article; parsed.article += '\nforged';
        assert.deepEqual(repair.verifiedCompiledReaderTableFactIssues(draft, feedback.rejectedReaderClaims, parsed), []);
        parsed.article = old;
        const ordinal = parsed.plan.tableBindings[2].sourceTableOrdinal; parsed.plan.tableBindings[2].sourceTableOrdinal = 8;
        assert.deepEqual(repair.verifiedCompiledReaderTableFactIssues(draft, feedback.rejectedReaderClaims, parsed), []);
        parsed.plan.tableBindings[2].sourceTableOrdinal = ordinal;
        const issue = issues[0], oldPath = issue.path; issue.path = '/sections/0/body';
        assert.deepEqual(repair.buildRepairTargets(draft, issues), []); issue.path = oldPath;
    });
    assert.equal(deep.readParsedReaderFactContext(escapedParsed, draft), null);
    assert.deepEqual(repair.buildRepairTargets(draft, escapedIssues), []);
    await scoped(() => assert.equal(deep.readParsedReaderFactContext(escapedParsed, draft), null));
});

test('ordinary direct JSON context, even with actual source SHA, is insufficient without actual daily paper scope', () => {
    const source = daily.readDailyFreshSource(plan, paper), descriptor = source.freshSourceDescriptor;
    direct.withDirectRewriteAnalysisSource({ paperId: 'arxiv:2610.41381', route: 'arxiv-fresh-fetch', sourceDetails: source,
        runId: plan.runId, sourceSha256: descriptor.sourceSha256, structuredArtifactsSha256: descriptor.structuredArtifactsSha256,
        sourceSnapshotSha256: descriptor.sourceSnapshotSha256, sourceGeneration: descriptor.sourceGeneration,
        sourceManifestSha256: descriptor.sourceManifestSha256, readerAttemptsDir: plan.readerAttemptsDir }, () => {
        const parsed = parse(draft, source);
        assert.equal(deep.readParsedReaderFactContext(parsed, draft), null);
        assert.deepEqual(repair.verifiedCompiledReaderTableFactIssues(draft, feedback.rejectedReaderClaims, parsed), []);
    });
});

test('wrong/mixed table claims and ambiguous repeated tables cannot authorize unrelated marker slots', async () => scoped(source => {
    const parsed = parse(draft, source);
    const claims = feedback.rejectedReaderClaims;
    assert.deepEqual(repair.verifiedCompiledReaderTableFactIssues(draft, [claims[1] + '\n\n' + claims[2]], parsed), []);
    assert.deepEqual(repair.verifiedCompiledReaderTableFactIssues(draft, [claims[1].replace('−-0.37', '−-0.38')], parsed), []);
    // The actual paid draft intentionally repeats source6 in two legitimate slots.
    const repeated = load('analysis-contract').extractMarkdownTables(parsed.article)[0].markdown;
    assert.equal(parsed.article.split(repeated).length, 3);
    assert.deepEqual(repair.verifiedCompiledReaderTableFactIssues(draft, [repeated], parsed), []);
    assert.deepEqual(repair.buildRepairTargets(draft, [{ path: null, code: 'reader_verified_fact_unlocated', message: 'unlocated' }]), []);
}));

test('each read rechecks real four-source bytes; modified sealed text cannot reuse the parsed source capability', async () => scoped(source => {
    const parsed = parse(draft, source), filename = path.join(plan.sourcesDir, '2610.41381/generation-000001/source.txt');
    const bytes = fs.readFileSync(filename); fs.appendFileSync(filename, '\nchanged');
    try { assert.throws(() => repair.verifiedCompiledReaderTableFactIssues(draft, feedback.rejectedReaderClaims, parsed)); }
    finally { fs.writeFileSync(filename, bytes, { mode: 0o600 }); }
}));
