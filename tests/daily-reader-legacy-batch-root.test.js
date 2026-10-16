'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const actual = process.env.PD_TEST_LEGACY_BATCH_ROOT_DESCRIPTOR;
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const legacy = require('../scripts/lib/daily-reader-legacy-batch-root');
const descriptor = () => ({ contract: legacy.CONTRACT, failedParentFile: '/tmp/original-failed.json',
    failedParentFileSha256: 'a'.repeat(64), authorizationFile: '/tmp/original-authorization.json', authorizationFileSha256: 'b'.repeat(64) });
test('旧批次根只接受明确失败父与原授权文件，不容冒充API或历史', () => {
    assert.doesNotThrow(() => legacy.assertDescriptor(descriptor()));
    for (const mutate of [d => delete d.failedParentFile, d => d.failedParentFileSha256 = 'bad',
        d => d.authorizationFile = '../authorization.json', d => d.contract = 'api', d => d.originApiStage = {},
        d => d.authorizationFileSha256 = 'B'.repeat(64), d => d.failedParentFile = null]) {
        const d = descriptor(); mutate(d); assert.throws(() => legacy.assertDescriptor(d), /精确文件SHA/);
    }
});
test('没有真实完成的batch operator root不能进入来源、文件或模型路线', () => {
    for (const stage of [{}, { status: 'complete', executionKind: 'api' },
        { status: 'complete', executionKind: 'operator', model: 'operator-local', protocol: 'local_operator', newReaderApiRequests: 1 }]) {
        assert.throws(() => legacy.validateLegacyBatchRoot({ descriptor: descriptor(),
            paper: { arxivId: '2610.00001v1', analysisManifest: { stages: { apiReaderArticle: stage } } }, plan: {} }), /真实原批次operator根/);
    }
});
// An explicitly selected existing immutable real bundle is used only for this
// read-only integration test. CI needs no runtime data and cannot manufacture
// an approved legacy root from a synthetic fixture.
test('真实原paid、完整失败父、用户授权和三节点批次patch完整私有解析重放；篡改均拒', { skip: !actual }, async () => {
    const daily = require('../scripts/lib/daily-fresh-source-plan'), engine = require('../scripts/analysis-engine');
    const fresh = require('../scripts/lib/fresh-analysis-context'), stop = require('../scripts/lib/analysis-stop-control');
    const formalFile = require('../scripts/config').FILES.deepAnalysisResult, formalBytes = fs.readFileSync(formalFile);
    const data = JSON.parse(formalBytes), config = JSON.parse(fs.readFileSync(actual));
    const paper = data.papers.find(p => p.arxivId === config.paperId), plan = daily.readDailyFreshSourcePlan(data.dailyFreshSourceRun);
    assert(paper); const before = JSON.stringify(paper);
    await stop.withModelRequestsForbidden(() => daily.withDailyFreshAnalysisContext(plan, () => engine.withPaperAnalysisLock(paper, () =>
        fresh.withFreshPaperContext(paper, () => daily.withDailyFreshPaperSource(plan, paper, source => {
            const run = p => legacy.validateLegacyBatchRoot({ descriptor: config.descriptor, paper: p, plan, source });
            const checked = run(paper); checked.assertUnchanged();
            assert.equal(checked.rootStage.executionKind, 'operator');
            assert.equal(checked.rootStage.operatorProvenance.contract, 'daily-reader-operator-correction-v1');
            assert.equal(checked.rootStage.originApiStage, undefined);
            assert.equal(checked.rootStage.operatorHistory, undefined);
            assert.equal(require('../scripts/lib/reader-repair').hashDraft(checked.draft), checked.rootStage.operatorProvenance.afterDraftSha256);
            const originalBytes = checked.snapshots.map(s => [s.file, fs.readFileSync(s.file)]);
            for (const mutate of [p => p.apiReaderArticle += '额外错误事实', p => p.analysis += '改评分主文',
                p => p.analysisManifest.stages.apiReaderArticle.attempts++, p => p.analysisManifest.stages.apiReaderArticle.fullAttempts++,
                p => p.analysisManifest.stages.apiReaderArticle.operatorProvenance.retainedNoProgress = 0,
                p => p.analysisManifest.stages.apiReaderArticle.imageEvidenceSha256 = 'a'.repeat(64),
                p => p.analysisManifest.stages.apiReaderArticle.operatorProvenance.originalCandidateEnvelopeSha256 = 'a'.repeat(64),
                p => p.analysisManifest.stages.apiReaderArticle.operatorProvenance.sourceDescriptor.sourceSha256 = 'a'.repeat(64),
                p => p.analysisManifest.stages.apiReaderArticle.operatorHistory = [],
                p => p.analysisManifest.stages.apiReaderArticle.originApiStage = { executionKind: 'api' },
                p => p.apiReaderFigures[0].assetSha256 = 'a'.repeat(64),
                p => p.apiReaderAuthors.authors[0].name = 'Wrong Author',
                p => p.apiReaderResources.resources.push({ url: 'https://example.org/forged' }),
                p => p.analysisManifest.stages.scoringAudit.finalScore = 10]) {
                const changed = structuredClone(paper); mutate(changed); assert.throws(() => run(changed));
            }
            for (const change of [d => d.failedParentFileSha256 = 'a'.repeat(64), d => d.authorizationFileSha256 = 'a'.repeat(64),
                d => d.failedParentFile = path.resolve('/tmp/not-in-controlled-runtime.json')]) {
                const altered = structuredClone(config.descriptor); change(altered);
                assert.throws(() => legacy.validateLegacyBatchRoot({ descriptor: altered, paper, plan, source }));
            }
            checked.assertUnchanged();
            for (const [file, bytes] of originalBytes) assert(fs.readFileSync(file).equals(bytes));
            assert.equal(JSON.stringify(paper), before);
        }, { fetchFigure: () => assert.fail('Legacy root may not download images') })))));
    assert(fs.readFileSync(formalFile).equals(formalBytes));
    assert.equal(crypto.createHash('sha256').update(formalBytes).digest('hex').length, 64);
});
