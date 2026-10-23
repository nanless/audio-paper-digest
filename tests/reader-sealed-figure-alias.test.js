'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), zlib = require('node:zlib');
const Config = require('../scripts/config'), daily = require('../scripts/lib/daily-fresh-source-plan');
const fresh = require('../scripts/lib/fresh-analysis-context'), deep = require('../scripts/deep-analyzer');
const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,
    'fixtures/reader-cavc-source-figure-alias-20261023-real.json.gz'))));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
async function setup(t) {
    require('../scripts/env-loader').requireExternalRuntime('reader-sealed-figure-alias-test');
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cavc-sealed-figure-alias-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous; fs.rmSync(root, { recursive: true, force: true }); });
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-23', batchId: 'cavc-original-sealed-source',
        papers: [{ arxivId: fixture.paperId }] });
    const directory = path.join(plan.sourcesDir, fixture.paperId, 'generation-000001');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const [name, file] of Object.entries(fixture.files)) {
        const bytes = Buffer.from(file.base64, 'base64'); assert.equal(sha(bytes), file.sha256);
        fs.writeFileSync(path.join(directory, name), bytes, { mode: 0o600, flag: 'wx' });
    }
    // The normal four-file reader authenticates the original exact manifest and all bytes.
    const paper = { arxivId: fixture.paperId, analysisManifest: { stages: {} } };
    const source = daily.readDailyFreshSource(plan, paper);
    const enter = callback => daily.withDailyFreshAnalysisContext(plan, () => daily.withDailyFreshPaperSource(plan, paper,
        actual => { fresh.attachFreshSourceRecord(paper, paper.analysisManifest, actual);
            return fresh.withFreshPaperContext(paper, () => callback(actual)); }, {
            fetchFigure: async () => { throw new Error('offline alias test must not fetch pixels'); }
        }));
    let generated, parsed;
    await enter(actual => {
        // Match the existing normal saved-paid-reader replay route (not the
        // stricter default parser invocation recorded in the earlier probe).
        parsed = deep.parseApiReaderArticleResult(JSON.stringify(fixture.draft), {
            arxivId: fixture.paperId, requiredVersion: 3, requireIntegratedTables: true,
            requireSourceBindings: true, allowDeterministicQuoteRepair: true,
            verifiedResourceIdentity: fixture.resourceIdentity, enforceResourceAvailabilityClaims: true,
            availableFigureOrdinals: [1, 2, 3, 4, 5],
            structuredArtifacts: actual.structuredArtifacts, sourceText: actual.text });
        generated = deep.injectApiReaderFigures(parsed, actual.structuredArtifacts, fixture.paperId);
    });
    assert.deepEqual(generated.figures.map(f => f.ordinal), [1, 2, 4, 3]);
    const evidence = structuredClone(fixture.imageEvidence);
    assert.equal(evidence[2].url, evidence[4].url); assert.equal(evidence[2].sourceSha256, evidence[4].sourceSha256);
    return { root, plan, directory, paper, source, parsed, generated, evidence, enter };
}

test('CAVC原四文件及完整付费稿：未选5与3同像素DOM别名可有界认证，不改原证据', async t => {
    const { generated, evidence, enter } = await setup(t);
    const before = JSON.stringify({ generated, evidence });
    assert.equal(deep.bindDirectApiReaderFiguresToEvidence(generated.figures, evidence.slice(0, 4)).length, 4);
    // The original real duplicate rejection is preserved in helper-formal-red.tap.
    // A normal call outside the actual daily scope must remain rejected.
    assert.throws(() => deep.bindDirectApiReaderFiguresToEvidence(generated.figures, evidence), /actual same-paper/);
    const aliases = require('../scripts/lib/reader-sealed-figure-alias');
    await enter(() => {
        const bound = deep.bindDirectApiReaderFiguresToEvidence(generated.figures, evidence);
        assert.deepEqual(bound.map(item => [item.ordinal, item.assetSha256]), generated.figures.map(figure => [figure.ordinal, evidence.find(item => item.ordinal === figure.ordinal).sourceSha256]));
        return aliases.withSourceAliases(generated.figures, evidence, ticket => {
            assert.equal(aliases.assertUnselectedDuplicate(ticket, generated.figures, evidence, evidence[2], evidence[4]), true);
        });
    });
    assert.equal(JSON.stringify({ generated, evidence }), before);
});

test('别名ticket不能从普通JSON、克隆、另一数组或退出作用域后取得', async t => {
    const { generated, evidence, enter } = await setup(t), aliases = require('../scripts/lib/reader-sealed-figure-alias');
    assert.throws(() => aliases.withSourceAliases(generated.figures, evidence, () => {}), /actual same-paper/);
    let retired;
    await enter(() => aliases.withSourceAliases(generated.figures, evidence, ticket => {
        retired = ticket;
        for (const fake of [{}, structuredClone(ticket), { allowed: true }]) assert.throws(() =>
            aliases.assertUnselectedDuplicate(fake, generated.figures, evidence, evidence[2], evidence[4]), /no active/);
        assert.throws(() => aliases.assertUnselectedDuplicate(ticket, [...generated.figures], evidence, evidence[2], evidence[4]), /no active/);
        assert.throws(() => aliases.assertUnselectedDuplicate(ticket, generated.figures, structuredClone(evidence), evidence[2], evidence[4]), /no active/);
    }));
    assert.throws(() => aliases.assertUnselectedDuplicate(retired, generated.figures, evidence, evidence[2], evidence[4]), /no active/);
});

test('同URL不同asset或model身份、坏全量证据、错成员及selected重复均拒', async t => {
    const { generated, evidence, enter } = await setup(t), aliases = require('../scripts/lib/reader-sealed-figure-alias');
    const mutations = [items => { items[4].sourceSha256 = items[4].sha256 = '0'.repeat(64); items[4].inputId = `figure:5:${items[4].sha256}`; },
        items => { items[4].modelPayloadSha256 = '0'.repeat(64); },
        items => { items[4].modelPayloadWidth -= 1; }, items => { items[0].status = 'failed'; },
        items => { items[0].modelPayloadTransform = 'unbound'; }, items => { items[4].inputId = items[2].inputId; },
        items => { items[4].ordinal = 6; items[4].inputId = `figure:6:${items[4].sourceSha256}`; }];
    for (const mutate of mutations) {
        const changed = structuredClone(evidence); mutate(changed);
        await enter(() => assert.throws(() => aliases.withSourceAliases(generated.figures, changed, ticket =>
            aliases.assertUnselectedDuplicate(ticket, generated.figures, changed, changed[2], changed[4])), /rejected/));
    }
    const selected = [...generated.figures, { ...generated.figures.find(item => item.ordinal === 3), ordinal: 5 }];
    await enter(() => assert.throws(() => aliases.withSourceAliases(selected, evidence, () => {}), /selected.*duplicated/));
    const duplicateOrdinal = structuredClone(evidence); duplicateOrdinal[4] = structuredClone(duplicateOrdinal[2]);
    await enter(() => assert.throws(() => aliases.withSourceAliases(generated.figures, duplicateOrdinal, () => {}), /unique ready/));
});

test('来源和输入每次物理重放且返回前CAS，冷JSON只在新真实scope内重派生', async t => {
    const { generated, evidence, enter, directory } = await setup(t), aliases = require('../scripts/lib/reader-sealed-figure-alias');
    const filename = path.join(directory, 'source.pdf'), original = fs.readFileSync(filename);
    const before = JSON.stringify({ generated, evidence });
    await enter(() => {
        assert.throws(() => aliases.withSourceAliases(generated.figures, evidence, ticket => {
            aliases.assertUnselectedDuplicate(ticket, generated.figures, evidence, evidence[2], evidence[4]);
            fs.appendFileSync(filename, 'changed');
        }), /SHA|sha|changed|hash|哈希|来源/);
    }).finally(() => fs.writeFileSync(filename, original));
    await enter(() => assert.throws(() => aliases.withSourceAliases(generated.figures, evidence, () => {
        evidence[4].modelPayloadBytes += 1;
    }), /inputs changed/)).finally(() => { evidence[4].modelPayloadBytes -= 1; });
    const saved = JSON.parse(JSON.stringify({ generated, evidence }));
    assert.throws(() => aliases.withSourceAliases(saved.generated.figures, saved.evidence, () => {}), /actual same-paper/);
    await enter(() => aliases.withSourceAliases(saved.generated.figures, saved.evidence, ticket => {
        aliases.assertUnselectedDuplicate(ticket, saved.generated.figures, saved.evidence, saved.evidence[2], saved.evidence[4]);
    }));
    assert.equal(JSON.stringify({ generated, evidence }), before);
    assert.equal(sha(fs.readFileSync(filename)), fixture.files['source.pdf'].sha256);
});

test('真实saved-paid解析接正常Reader finalizer不重新下载，保存后新scope物理重派生并冷重放相同展示', async t => {
    const { root, plan, paper, parsed, evidence, enter } = await setup(t);
    paper.analysisManifest.stages.openSourceScan = {};
    const originalEvidence = JSON.stringify(evidence), originalDraft = JSON.stringify(fixture.draft);
    const result = await enter(actual => {
        paper.sourceSha256 = actual.freshSourceDescriptor.sourceSha256;
        return deep.finalizeApiReaderRefresh(paper, actual, { ...parsed, imageEvidence: evidence }, {
            readerResources: structuredClone(fixture.resourceIdentity),
            execution: { executionKind: 'api', attempts: 4, fullAttempts: 1, transportFailures: 0 }
        });
    });
    assert.equal(result.analysisManifest.stages.apiReaderArticle.status, 'complete');
    assert.deepEqual(result.apiReaderFigures.map(item => item.ordinal), [1, 2, 4, 3]);
    assert.equal(result.apiReaderFigures.length, 4);
    assert.equal(result.analysisManifest.stages.apiReaderArticle.imageEvidenceCount, 5);
    assert.equal(result.analysisManifest.stages.apiReaderArticle.attempts, 4);
    assert.equal(result.analysisManifest.stages.apiReaderArticle.fullAttempts, 1);
    const savedFile = path.join(root, 'saved-reader.json');
    const fd = fs.openSync(savedFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ reference: daily.dailyFreshSourceReference(plan), paper: result })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    const directoryFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    const savedSha = sha(fs.readFileSync(savedFile));
    const child = require('node:child_process').spawnSync(process.execPath, ['-e', `
        process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
        const fs = require('node:fs'), crypto = require('node:crypto'), zlib = require('node:zlib'), assert = require('node:assert/strict');
        const Config = require('./scripts/config'), daily = require('./scripts/lib/daily-fresh-source-plan');
        const fresh = require('./scripts/lib/fresh-analysis-context'), deep = require('./scripts/deep-analyzer');
        Config.FILES.dailyFreshSourceRunsDir = process.argv[1];
        const archive = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
        const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync('tests/fixtures/reader-cavc-source-figure-alias-20261023-real.json.gz')));
        const plan = daily.readDailyFreshSourcePlan(archive.reference), saved = archive.paper;
        daily.withDailyFreshAnalysisContext(plan, () => daily.withDailyFreshPaperSource(plan, saved, actual =>
            fresh.withFreshPaperContext(saved, () => {
                const cold = deep.parseApiReaderArticleResult(JSON.stringify(fixture.draft), {
                    arxivId: fixture.paperId, requiredVersion: 3, requireIntegratedTables: true,
                    requireSourceBindings: true, allowDeterministicQuoteRepair: true,
                    verifiedResourceIdentity: saved.apiReaderResources, enforceResourceAvailabilityClaims: true,
                    availableFigureOrdinals: [1, 2, 3, 4, 5], structuredArtifacts: actual.structuredArtifacts, sourceText: actual.text });
                assert.equal(deep.stableFingerprint(fixture.imageEvidence), saved.analysisManifest.stages.apiReaderArticle.imageEvidenceSha256);
                assert.equal(fixture.imageEvidence.length, saved.analysisManifest.stages.apiReaderArticle.imageEvidenceCount);
                const bound = deep.bindDirectApiReaderFiguresToEvidence(saved.apiReaderFigures, fixture.imageEvidence);
                assert.deepEqual(bound, saved.apiReaderFigures);
                const replay = deep.replayApiReaderFinalDisplay(cold, actual, bound, fixture.paperId);
                assert.equal(replay.article, saved.apiReaderArticle);
                assert.equal(deep.stableFingerprint(replay.plan), saved.apiReaderPlanSha256);
                assert.equal(deep.stableFingerprint(replay.figures), saved.analysisManifest.stages.apiReaderArticle.figuresSha256);
                process.stdout.write('COLD_ALIAS_OK');
            }), { fetchFigure: async () => { throw new Error('cold replay must not download'); } }))
            .catch(error => { process.stderr.write(error.stack); process.exitCode = 1; });
    `, Config.FILES.dailyFreshSourceRunsDir, savedFile], {
        cwd: path.resolve(__dirname, '..'), env: { ...process.env, VERIFY_PROJECT_DISABLE_FILE_LOGS: '1' },
        encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.equal(child.status, 0, child.stderr || String(child.error || child.stdout));
    assert.equal(child.stdout, 'COLD_ALIAS_OK');
    assert.equal(sha(fs.readFileSync(savedFile)), savedSha);
    assert.equal(JSON.stringify(evidence), originalEvidence);
    assert.equal(JSON.stringify(fixture.draft), originalDraft);
    // This exercises the actual Reader owner only, not complete scientific,
    // publication, request-budget adoption or production qualification.
});
