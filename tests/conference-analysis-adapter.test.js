'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const adapter = require('../scripts/lib/conference-analysis-adapter.js');
const context = require('../scripts/lib/conference-analysis-context.js');
const cli = require('../scripts/conference-analyze.js');
const executionCli = require('../scripts/conference-execution.js');
const deep = require('../scripts/deep-analyzer.js');
const { productionPlanFixture } = require('./helpers/conference-production-plan-fixture.js');

const EXECUTION = '77777777-7777-4777-8777-777777777777';

function emptyReaderResourceIdentity(text) {
    const body = { contract: 'api-reader-resource-identity-v1',
        sourceTextSha256: crypto.createHash('sha256').update(text).digest('hex'), resources: [] };
    return { ...body, identitySha256: deep.stableFingerprint(body) };
}

test('official proceedings metadata survives into the conference canonical publication identity', () => {
    const source = {
        paperId: 'conference:iwslt:2026:conference-paper-id:2026.iwslt-1.1',
        conference: { id: 'iwslt-2026', year: 2026 },
        identity: { type: 'conference-paper-id', value: '2026.iwslt-1.1' },
        metadata: { title: 'Speech Translation Paper', authors: ['Author One'], abstract: 'Abstract.',
            recordUrl: 'https://aclanthology.org/2026.iwslt-1.1/',
            pdfUrl: 'https://aclanthology.org/2026.iwslt-1.1.pdf',
            doi: '10.18653/v1/2026.iwslt-1.1', track: 'Main' }
    };
    const paper = adapter.normalizedPaper(source);
    assert.deepEqual(paper.conferencePublication, {
        contract: 'conference-official-publication-v1',
        recordUrl: source.metadata.recordUrl, pdfUrl: source.metadata.pdfUrl
    });
    assert.equal(paper.doi, source.metadata.doi);
    assert.equal(paper.conferenceTrack, 'Main');
    assert.throws(() => adapter.normalizedPaper({ ...source,
        metadata: { ...source.metadata, pdfUrl: 'http://aclanthology.org/paper.pdf' } }), /credential-free HTTPS/);
});

function successfulReaderDraft() {
    const kinds = ['background', 'related_work', 'problem', 'method_overview', 'component',
        'training', 'experiment_setup', 'result', 'ablation', 'limitation', 'reproduction', 'synthesis'];
    const draft = { version: 3, readerTitle: '从会议弱结构文本理解声音方法的证据链',
        oneSentenceThesis: '本文沿输入、方法、对照实验和边界逐层解释会议论文，并只依据可逐字核对的纯文本证据陈述结果。',
        sections: kinds.map((kind, index) => ({ kind, heading: `第${index + 1}步如何核对输入、机制与证据边界？`, body: [
            `进入第${index + 1}个教学阶段时，先固定这一阶段的输入、输出和失败现象。读者需要知道当前处理的是哪一类信号，它经过什么变换，以及哪个可观测结果才能证明这步确实工作。`,
            `第${index + 1}个环节对应的类型是${kind}，它不单独追求一个更好看的数字，而是把控制变量、基线、指标方向和证据来源放在同一口径下。只有比较条件一致，后续差异才有解释价值。`,
            `在第${index + 1}个环节的方法层面应沿着数据流检查：原始观测先变成可学习表示，组件再选择或融合证据，目标函数最后把这些选择投影到任务输出。任何一环没有说清，初学者都会把相关性错当成因果。`,
            `第${index + 1}个环节的实验层面则要同时读正面结果与反例。最强结果能说明当前设置下的净收益，未胜出项、未报告方差和缺失的跨域测试则限定该结论能走多远。这些边界不是附注，而是论证的一部分。`,
            `因此，第${index + 1}个教学阶段最终要交给下一节的不是一句重复摘要，而是一份可执行的核对清单：哪些事实来自原文，哪些解释需要消融，哪些判断还缺对照或测量。沿着这份清单，文章才能逐步收紧中心问题。`,
            `完成第${index + 1}个阶段的比较后，还要说明观测条件发生变化时哪些推断需要重新核对。数据采样与部署环境不完全一致时，当前证据仍然有用，但必须结合新的基线实验确定模型是否保留原有优势。`
        ].join('\n\n') })), conceptBridges: Array.from({ length: 4 }, (_, index) => ({
            terms: [`语义锚点${index + 1}`, `声学证据${index + 1}`], sectionKind: 'method_overview',
            marker: `[[CONCEPT_BRIDGE_${index + 1}]]`,
            explanation: `语义锚点${index + 1}负责限定当前候选的意义范围，声学证据${index + 1}负责核对发音与时序细节。两者搭配后才能把语义排除与声学定位连成可检验的决策链。`
        })), figurePlacements: [], tableBindings: [], formulaBindings: [] };
    draft.sections[3].body += `\n\n${draft.conceptBridges.map(item => item.marker).join('\n\n')}`;
    return draft;
}

test('weak conference PDF prepares isolated canonical identity with unavailable structured capabilities', t => {
    const fixture = productionPlanFixture(t);
    const analysisRoot = path.join(fixture.root, 'analysis');
    assert.throws(() => adapter.prepareConferenceAnalysis({ planHandle: fixture.planHandle, paperId: fixture.paperId,
        sourceRoot: fixture.sourceRoot, analysisRoot, executionId: '../escape' }), /UUID v4/);
    const prepared = adapter.prepareConferenceAnalysis({ planHandle: fixture.planHandle,
        paperId: fixture.paperId, sourceRoot: fixture.sourceRoot, analysisRoot,
        executionId: EXECUTION, now: '2026-09-07T00:00:00.000Z' });
    assert.equal(prepared.paperId, fixture.paperId); assert.equal(prepared.status, 'source_ready');
    const loaded = adapter.loadConferenceAnalysis({ analysisRoot, executionId: EXECUTION });
    const paper = loaded.analysis.papers[0];
    assert.equal(paper.id, fixture.paperId); assert.equal(paper.arxivId, undefined);
    assert.equal(paper.paper_id, undefined); assert.equal(paper.fullText, undefined);
    assert.deepEqual(loaded.run.capabilities,
        { fullText: 'weak', tables: 'unavailable', formulas: 'unavailable', figures: 'unavailable' });
    assert.deepEqual(loaded.source.sourceDetails.structuredArtifacts.tables, []);
    assert.deepEqual(loaded.source.sourceDetails.structuredArtifacts.formulas, []);
    assert.deepEqual(loaded.source.sourceDetails.structuredArtifacts.figures, []);
    assert.equal(adapter.prepareConferenceAnalysis({ planHandle: fixture.planHandle,
        paperId: fixture.paperId, sourceRoot: fixture.sourceRoot, analysisRoot,
        executionId: EXECUTION }).recovered, true);
});

test('prepare intent recovers every authenticated prefix and rejects a re-signed mismatch', t => {
    const fixture = productionPlanFixture(t); const analysisRoot = path.join(fixture.root, 'analysis-recovery');
    for (const [index, crashAfter] of ['intent.json', 'source.json', 'analysis.json'].entries()) {
        const executionId = `${index + 1}aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
        let crashed = false;
        assert.throws(() => adapter.prepareConferenceAnalysis({ planHandle: fixture.planHandle, paperId: fixture.paperId,
            sourceRoot: fixture.sourceRoot, analysisRoot, executionId, now: '2026-09-07T00:00:00.000Z' }, {
            afterPersist: name => { if (!crashed && name === crashAfter) { crashed = true; throw new Error(`crash after ${name}`); } }
        }), new RegExp(`crash after ${crashAfter.replace('.', '\\.')}`));
        const recovered = adapter.prepareConferenceAnalysis({ planHandle: fixture.planHandle, paperId: fixture.paperId,
            sourceRoot: fixture.sourceRoot, analysisRoot, executionId, now: '2026-09-07T00:00:01.000Z' });
        assert.equal(recovered.recovered, true); assert.equal(adapter.loadConferenceAnalysis({ analysisRoot, executionId }).run.status, 'source_ready');
    }
    const executionId = '4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; let crashed = false;
    assert.throws(() => adapter.prepareConferenceAnalysis({ planHandle: fixture.planHandle, paperId: fixture.paperId,
        sourceRoot: fixture.sourceRoot, analysisRoot, executionId }, { afterPersist: name => {
        if (!crashed && name === 'intent.json') { crashed = true; throw new Error('intent crash'); }
    } }), /intent crash/);
    const filename = path.join(analysisRoot, executionId, 'intent.json'); const intent = JSON.parse(fs.readFileSync(filename));
    intent.sourceFileSha256 = 'f'.repeat(64); const body = structuredClone(intent); delete body.intentSha256;
    intent.intentSha256 = adapter.stableHash(body); fs.writeFileSync(filename, `${JSON.stringify(intent, null, 2)}\n`);
    assert.throws(() => adapter.prepareConferenceAnalysis({ planHandle: fixture.planHandle, paperId: fixture.paperId,
        sourceRoot: fixture.sourceRoot, analysisRoot, executionId }), /differs from authenticated prepare intent/);
});

test('atomic analysis writer removes its own short EIO temporary and legacy executions fail with migration guidance', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-analysis-write-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true })); const filename = path.join(root, 'record.json');
    let calls = 0; const io = { openSync: fs.openSync, closeSync: fs.closeSync, fsyncSync: fs.fsyncSync,
        writeSync: (fd, buffer, offset, length, position) => {
            calls += 1; if (calls === 1) return fs.writeSync(fd, buffer, offset, Math.min(3, length), position);
            const error = new Error('analysis EIO'); error.code = 'EIO'; throw error;
        } };
    assert.throws(() => adapter.writeBytesAtomic(filename, Buffer.from('{"complete":true}\n'), { io,
        randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }), /analysis EIO/);
    assert.equal(fs.existsSync(filename), false); assert.deepEqual(fs.readdirSync(root), []);

    const fixture = productionPlanFixture(t); const analysisRoot = path.join(fixture.root, 'legacy-analysis');
    adapter.prepareConferenceAnalysis({ planHandle: fixture.planHandle, paperId: fixture.paperId,
        sourceRoot: fixture.sourceRoot, analysisRoot, executionId: EXECUTION });
    fs.unlinkSync(path.join(analysisRoot, EXECUTION, 'intent.json'));
    assert.throws(() => adapter.loadConferenceAnalysis({ analysisRoot, executionId: EXECUTION }), /create a new execution UUID/);

    const partialId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; const partialDir = path.join(analysisRoot, partialId);
    fs.mkdirSync(partialDir); fs.writeFileSync(path.join(partialDir, 'source.json'), '{}');
    assert.throws(() => adapter.prepareConferenceAnalysis({ planHandle: fixture.planHandle, paperId: fixture.paperId,
        sourceRoot: fixture.sourceRoot, analysisRoot, executionId: partialId }), /partial lacks prepare intent/);
});

test('prepare intent binds the untouched pending analysis authoring input', t => {
    const fixture = productionPlanFixture(t); const analysisRoot = path.join(fixture.root, 'analysis-input-binding');
    adapter.prepareConferenceAnalysis({ planHandle: fixture.planHandle, paperId: fixture.paperId,
        sourceRoot: fixture.sourceRoot, analysisRoot, executionId: EXECUTION });
    const filename = path.join(analysisRoot, EXECUTION, 'analysis.json'); const analysis = JSON.parse(fs.readFileSync(filename));
    analysis.papers[0].title = 'self-resigned attacker title'; fs.writeFileSync(filename, `${JSON.stringify(analysis, null, 2)}\n`);
    assert.throws(() => adapter.loadConferenceAnalysis({ analysisRoot, executionId: EXECUTION }), /evidence drifted/);
});

test('mock common analysis observes source only through authenticated context and persists isolated canonical', async t => {
    const fixture = productionPlanFixture(t); const analysisRoot = path.join(fixture.root, 'analysis');
    adapter.prepareConferenceAnalysis({ planHandle: fixture.planHandle, paperId: fixture.paperId,
        sourceRoot: fixture.sourceRoot, analysisRoot, executionId: EXECUTION });
    let calls = 0;
    const recoveryPolicy = Symbol('conference-test-local-dead-recovery');
    const engine = { LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY: recoveryPolicy,
        withPaperAnalysisLock: async (_paper, callback, options) => {
            assert.equal(options.recoveryPolicy, recoveryPolicy); return callback();
        }, analyzeBatch: async (papers, options) => {
        calls += 1; const prepared = await options.preparePaperLocked(papers[0]);
        assert.equal(options.paperLockOptions.recoveryPolicy, recoveryPolicy);
        assert.equal(prepared.paper.id, fixture.paperId); assert.equal(prepared.paper.fullText, undefined);
        const injected = context.getConferenceAnalysisSource(prepared.paper);
        assert.equal(injected.source, 'conference_pdf_text'); assert.ok(injected.text.length > 1000);
        assert.deepEqual(injected.conferenceCapabilities,
            { fullText: 'weak', tables: 'unavailable', formulas: 'unavailable', figures: 'unavailable' });
        const analysisFile = path.join(analysisRoot, EXECUTION, 'analysis.json');
        const checkpoint = JSON.parse(fs.readFileSync(analysisFile));
        checkpoint.status = 'running'; checkpoint.stats = { analysisStatus: 'running' };
        fs.writeFileSync(analysisFile, `${JSON.stringify(checkpoint, null, 2)}\n`);
        await options.onPaperResultLocked(prepared.paper,
            { success: true, result: { ...prepared.paper, analysis: 'mock conference analysis' } });
        return { results: [], stats: { success: 1, failed: 0 } };
    } };
    const result = await adapter.analyzeConference({ analysisRoot, executionId: EXECUTION,
        planHandle: fixture.planHandle, sourceRoot: fixture.sourceRoot }, { engine, maxRetries: 0 });
    assert.equal(result.status, 'complete'); assert.equal(calls, 1);
    const loaded = adapter.loadConferenceAnalysis({ analysisRoot, executionId: EXECUTION });
    assert.equal(loaded.analysis.papers[0].analysis, 'mock conference analysis');
    assert.equal(loaded.analysis.status, 'complete');
    assert.equal(loaded.analysis.stats.analysisStatus, 'complete');
    assert.match(loaded.run.analysisSha256, /^[a-f0-9]{64}$/);
    assert.equal(loaded.run.completionReceipt.analysisSha256, loaded.run.analysisSha256);
    const resumed = await adapter.analyzeConference({ analysisRoot, executionId: EXECUTION,
        planHandle: fixture.planHandle, sourceRoot: fixture.sourceRoot }, { engine });
    assert.equal(resumed.recovered, true); assert.equal(calls, 1);
});

test('completed analysis left before run sealing is deterministically recovered only with live plan authority', async t => {
    const fixture = productionPlanFixture(t); const analysisRoot = path.join(fixture.root, 'analysis');
    adapter.prepareConferenceAnalysis({ planHandle: fixture.planHandle, paperId: fixture.paperId,
        sourceRoot: fixture.sourceRoot, analysisRoot, executionId: EXECUTION });
    const analysisFile = path.join(analysisRoot, EXECUTION, 'analysis.json');
    const analysis = JSON.parse(fs.readFileSync(analysisFile));
    analysis.status = 'complete'; analysis.completedAt = '2026-09-07T01:00:00.000Z';
    analysis.stats = { analysisStatus: 'running' };
    analysis.papers[0].analysis = 'completed before run receipt';
    fs.writeFileSync(analysisFile, `${JSON.stringify(analysis, null, 2)}\n`);
    assert.equal(adapter.loadConferenceAnalysis({ analysisRoot, executionId: EXECUTION }).completionPending, true);
    await assert.rejects(adapter.analyzeConference({ analysisRoot, executionId: EXECUTION }), /live plan authority/);
    const recovered = await adapter.analyzeConference({ analysisRoot, executionId: EXECUTION,
        planHandle: fixture.planHandle, sourceRoot: fixture.sourceRoot });
    assert.equal(recovered.status, 'complete'); assert.equal(recovered.productionAuthorized, true);
    const sealed = adapter.loadConferenceAnalysis({ analysisRoot, executionId: EXECUTION });
    assert.equal(sealed.run.status, 'complete'); assert.equal(sealed.completionPending, false);
    assert.equal(sealed.analysis.stats.analysisStatus, 'complete');
    analysis.papers[0].title = 'tampered after completion';
    fs.writeFileSync(analysisFile, `${JSON.stringify(analysis, null, 2)}\n`);
    assert.throws(() => adapter.loadConferenceAnalysis({ analysisRoot, executionId: EXECUTION }), /does not bind canonical analysis/);
});

test('legacy sealed completion with running stats is demoted, normalized, and rebound under the paper lock', async t => {
    const fixture = productionPlanFixture(t); const analysisRoot = path.join(fixture.root, 'analysis-sealed-status-recovery');
    adapter.prepareConferenceAnalysis({ planHandle: fixture.planHandle, paperId: fixture.paperId,
        sourceRoot: fixture.sourceRoot, analysisRoot, executionId: EXECUTION });
    const analysisFile = path.join(analysisRoot, EXECUTION, 'analysis.json');
    const analysis = JSON.parse(fs.readFileSync(analysisFile));
    analysis.status = 'complete'; analysis.completedAt = '2026-09-07T01:00:00.000Z';
    analysis.stats = { analysisStatus: 'running' }; analysis.papers[0].analysis = 'legacy completed analysis';
    fs.writeFileSync(analysisFile, `${JSON.stringify(analysis, null, 2)}\n`);
    const legacyRun = adapter.sealCompletedRun(adapter.loadConferenceAnalysis({ analysisRoot, executionId: EXECUTION }));
    const legacyAnalysisSha256 = legacyRun.analysisSha256;
    let locks = 0;
    const recoveryPolicy = Symbol('conference-test-local-dead-recovery');
    const engine = { LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY: recoveryPolicy,
        withPaperAnalysisLock: async (_paper, callback, options) => {
            assert.equal(options.recoveryPolicy, recoveryPolicy); locks += 1; return callback();
        },
        analyzeBatch: async () => { throw new Error('completed recovery must not rerun analysis'); } };
    const recovered = await adapter.analyzeConference({ analysisRoot, executionId: EXECUTION,
        planHandle: fixture.planHandle, sourceRoot: fixture.sourceRoot }, { engine });
    const sealed = adapter.loadConferenceAnalysis({ analysisRoot, executionId: EXECUTION });
    assert.equal(recovered.status, 'complete'); assert.equal(recovered.recovered, true); assert.equal(locks, 1);
    assert.equal(sealed.analysis.stats.analysisStatus, 'complete'); assert.equal(sealed.run.status, 'complete');
    assert.notEqual(sealed.run.analysisSha256, legacyAnalysisSha256);
    assert.equal(sealed.run.analysisSha256, sealed.analysisFileSha256);
    assert.equal(sealed.run.completionReceipt.analysisSha256, sealed.analysisFileSha256);
});

test('conference source context rejects arXiv aliases and mismatched identities', () => {
    const details = { text: 'x'.repeat(2000), source: 'conference_pdf_text' };
    assert.throws(() => context.withConferenceAnalysisSource({ executionId: EXECUTION, executionDir: '/tmp/conference-analysis',
        paperId: 'conference:icassp:2026:icassp-arnumber:100', sourceDetails: details }, () =>
        context.getConferenceAnalysisSource({ id: 'conference:icassp:2026:icassp-arnumber:100', arxivId: '2601.00001' })),
    /refuses arXiv aliases/);
    assert.throws(() => context.withConferenceAnalysisSource({ executionId: EXECUTION, executionDir: '/tmp/conference-analysis',
        paperId: 'conference:icassp:2026:icassp-arnumber:100', sourceDetails: details }, () =>
        context.getConferenceAnalysisSource({ id: 'conference:icassp:2026:icassp-arnumber:101' })),
    /different canonical/);
});

test('conference source context preserves official paper IDs containing dots', () => {
    const paperId = 'conference:acl:2026:conference-paper-id:2026.acl-long.17';
    const details = { text: 'official proceedings text', source: 'conference_pdf_text' };
    const value = context.withConferenceAnalysisSource({ executionId: EXECUTION, executionDir: '/tmp/conference-analysis',
        paperId, sourceDetails: details }, () => context.getConferenceAnalysisSource({ id: paperId }));
    assert.deepEqual(value, details);
});

test('conference analysis CLI requires complete authority for prepare and supports isolated status/analyze', async () => {
    const authorityPairs = executionCli.AUTHORITY_FLAGS.flatMap(flag => [flag,
        flag === '--filter' ? '11111111-1111-4111-8111-111111111111' : `${flag.slice(2)}.json`]);
    const paperId = 'conference:icassp:2026:icassp-arnumber:100';
    const prepared = cli.parseArgs(['prepare', ...authorityPairs, '--paper-id', paperId, '--analysis-run', EXECUTION]);
    assert.equal(prepared.paperId, paperId);
    const officialPaperId = 'conference:acl:2026:conference-paper-id:2026.acl-long.17';
    assert.equal(cli.parseArgs(['prepare', ...authorityPairs, '--paper-id', officialPaperId,
        '--analysis-run', EXECUTION]).paperId, officialPaperId);
    assert.throws(() => cli.parseArgs(['prepare', ...authorityPairs, '--paper-id',
        'conference:acl:2026:conference-paper-id:2026/acl/17', '--analysis-run', EXECUTION]), /canonical paperId/);
    assert.equal(cli.parseArgs(['analyze', ...authorityPairs, '--analysis-run', EXECUTION, '--concurrency', '3']).concurrency, 3);
    assert.throws(() => cli.parseArgs(['prepare', '--paper-id', paperId, '--analysis-run', EXECUTION]), /complete/);
    assert.throws(() => cli.parseArgs(['status', '--analysis-run', EXECUTION]), /complete live plan authority/);
    let called = false;
    const result = await cli.main(['status', ...authorityPairs, '--analysis-run', EXECUTION], {
        files: { conferenceAnalysisDir: '/tmp/conference-analysis', conferenceSourceCacheDir: '/tmp/conference-source' },
        loadBoundPlan: () => ({}), adapter: { loadConferenceAnalysis: () => { called = true; return { run: { executionId: EXECUTION,
            paperId, status: 'source_ready', capabilities: { fullText: 'weak' } }, completionPending: false }; },
        verifyPlanAuthority: () => true }
    });
    assert.equal(called, true); assert.equal(result.paperId, paperId);
});

test('real Reader entry uses execution-local attempts, empty figures short-circuit, and author fallback is conference-specific', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-reader-integration-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paperId = 'conference:icassp:2026:icassp-arnumber:100';
    const text = '会议论文可靠纯文本证据。'.repeat(300);
    const artifactBody = { version: 1, source: 'conference_pdf_weak_text', tables: [], formulas: [], figures: [],
        flattenedTextSha256: crypto.createHash('sha256').update(text).digest('hex'), capabilityProfile: 'weak-text-only-v1' };
    const artifacts = { ...artifactBody, payloadSha256: crypto.createHash('sha256').update(JSON.stringify(artifactBody)).digest('hex') };
    const details = { text, source: 'conference_pdf_text', sourceId: paperId,
        imageInfos: [], structuredArtifacts: artifacts,
        conferenceCapabilities: context.WEAK_CONFERENCE_CAPABILITIES };
    await context.withConferenceAnalysisSource({ executionId: EXECUTION, executionDir: root, paperId,
        sourceDetails: details }, async () => {
        assert.deepEqual(await deep.materializeApiReaderFigures([], paperId), []);
        await assert.rejects(deep.materializeApiReaderFigures([{ ordinal: 1 }], paperId), /会议 weak PDF/);
        const authors = deep.resolveApiReaderAuthors({ id: paperId, authors: ['作者甲'] }, details);
        assert.deepEqual(authors.authors[0].affiliations, ['机构信息未能从会议 PDF 纯文本可靠映射']);
        assert.doesNotMatch(JSON.stringify(authors), /arXiv/);
        assert.equal(context.conferenceReaderAttemptsDirectory(), path.join(root, 'reader-attempts'));
        let calls = 0;
        const paper = { id: paperId, title: '会议论文', authors: ['作者甲'],
            apiReaderResources: emptyReaderResourceIdentity(text) };
        const readerError = await deep.generateApiReaderArticleDetailed(paper,
            'canonical analysis', details.text, { sourceText: details.text,
                structuredArtifacts: artifacts, readerMaxAttempts: 1,
                readerRecordDisposition: () => {}, readerCallModel: async () => { calls += 1; return 'invalid JSON'; } })
            .then(() => null, error => error);
        assert.ok(readerError instanceof Error);
        assert.ok(calls > 0, `mock model was not reached: ${readerError.message}`);
        await assert.rejects(deep.generateApiReaderArticleDetailed(paper,
            'canonical analysis', details.text, { sourceText: details.text,
                structuredArtifacts: artifacts, readerAttemptsDir: path.join(root, 'outside'),
                readerCallModel: async () => 'unused' }),
        /must stay inside/);
    });
});

test('weak PDF Reader policy forces empty structure bindings and retries a nonempty model draft in full', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-reader-success-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paperId = 'conference:icassp:2026:icassp-arnumber:100';
    const sourceText = '在统一数据协议与输入条件下，基线和完整方法的报告得分均为1.0，仅用于当前离线对照。';
    const artifactBody = { version: 1, source: 'conference_pdf_weak_text', tables: [], formulas: [], figures: [],
        flattenedTextSha256: crypto.createHash('sha256').update(sourceText).digest('hex'), capabilityProfile: 'weak-text-only-v1' };
    const artifacts = { ...artifactBody, payloadSha256: crypto.createHash('sha256').update(JSON.stringify(artifactBody)).digest('hex') };
    const details = { text: sourceText, source: 'conference_pdf_text', sourceId: paperId,
        imageInfos: [], structuredArtifacts: artifacts,
        conferenceCapabilities: context.WEAK_CONFERENCE_CAPABILITIES };
    let calls = 0; const prompts = [];
    const paper = { id: paperId, title: '会议论文', authors: ['作者甲'],
        apiReaderResources: emptyReaderResourceIdentity(sourceText) };
    const result = await context.withConferenceAnalysisSource({ executionId: EXECUTION, executionDir: root, paperId,
        sourceDetails: details }, () => deep.generateApiReaderArticleDetailed(paper,
        'canonical analysis', sourceText, { sourceText, structuredArtifacts: artifacts, readerMaxAttempts: 2,
            readerRecordDisposition: () => {}, readerCallModel: async messages => {
                calls += 1; prompts.push(messages[0].content[0].text);
                const draft = successfulReaderDraft();
                if (calls === 1) {
                    draft.tableBindings = [{ tableIndex: 1, sourceType: 'source_quotes',
                        sourceTableOrdinal: null, cellBindings: [], sourceQuotes: [sourceText] }];
                    draft.formulaBindings = [{ formulaOrdinal: 1, targetKind: 'component', marker: '[[FORMULA_1]]' }];
                    draft.figurePlacements = [{ figureOrdinal: 1, targetKind: 'component',
                        marker: '[[FIGURE_1]]', focusPoints: ['观察输入', '观察输出'] }];
                    draft.sections[4].body += '\n\n| 方法 | 得分 |\n|---|---:|\n| 本方法 | 1.0 |'
                        + '\n\n\\[L=1\\]\n\n[[TABLE_1]]\n\n[[FORMULA_1]]\n\n[[FIGURE_1]]';
                }
                return JSON.stringify(draft);
            } }));
    assert.equal(calls, 2); assert.equal(result.plan.figurePlacements.length, 0);
    assert.deepEqual(result.plan.tableBindings, []);
    assert.deepEqual(result.plan.formulaBindings, []);
    assert.doesNotMatch(result.article, /(?:^|\n)\s*\|[^\n]*\||\\\[|\[\[(?:TABLE|FORMULA|FIGURE)_/);
    assert.match(prompts[0], /conference-reader-weak-unavailable-structure-v1/);
    assert.match(prompts[0], /tableBindings、formulaBindings、figurePlacements 必须全部为 \[\]/);
    assert.match(prompts[1], /tableBindings、formulaBindings、figurePlacements 必须全部为 \[\]/);
    assert.match(prompts[1], /请为刚进入语音\/音乐\/音频领域的研究生写一篇/);
    assert.doesNotMatch(prompts[1], /Reader 受限局部修复/);

    const policy = context.WEAK_READER_CAPABILITY_POLICY;
    const badFormula = successfulReaderDraft();
    badFormula.formulaBindings = [{ formulaOrdinal: 1, targetKind: 'component', marker: '[[FORMULA_1]]' }];
    badFormula.sections[4].body += '\n\n[[FORMULA_1]]';
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(badFormula), {
        requiredVersion: 3, requireSourceBindings: true, requireIntegratedTables: true,
        minimumIntegratedTables: 0, structuredArtifacts: artifacts, sourceText,
        readerCapabilityPolicy: policy
    }), /会议 weak source 要求 .*全部为空/);

    const badTable = successfulReaderDraft();
    badTable.sections[7].body += '\n\n| 方法 | 得分 |\n|---|---:|\n| 本方法 | 1.0 |';
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(badTable), {
        requiredVersion: 3, requireSourceBindings: true, requireIntegratedTables: true,
        minimumIntegratedTables: 0, structuredArtifacts: artifacts, sourceText,
        readerCapabilityPolicy: policy
    }), /会议 weak source 正文禁止 Markdown 表格/);
});

test('authenticated weak Reader rejects an unverified open-source claim and repairs only its section', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-reader-resource-claim-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paperId = 'conference:icassp:2026:icassp-arnumber:101';
    const sourceText = '论文仅描述方法与实验，没有提供代码、模型、数据集或演示链接。';
    const artifactBody = { version: 1, source: 'conference_pdf_weak_text', tables: [], formulas: [], figures: [],
        flattenedTextSha256: crypto.createHash('sha256').update(sourceText).digest('hex'), capabilityProfile: 'weak-text-only-v1' };
    const artifacts = { ...artifactBody,
        payloadSha256: crypto.createHash('sha256').update(JSON.stringify(artifactBody)).digest('hex') };
    const details = { text: sourceText, source: 'conference_pdf_text', sourceId: paperId,
        imageInfos: [], structuredArtifacts: artifacts,
        conferenceCapabilities: context.WEAK_CONFERENCE_CAPABILITIES };
    const resources = emptyReaderResourceIdentity(sourceText);
    const paper = { id: paperId, title: '会议资源声明门禁', authors: ['作者甲'], apiReaderResources: resources };
    const badDraft = successfulReaderDraft();
    const originalBody = badDraft.sections[10].body;
    badDraft.sections[10].body += '\n\n本文代码已经开源并可下载，读者可以直接取得完整实现。';
    assert.doesNotThrow(() => deep.parseApiReaderArticleResult(JSON.stringify(badDraft), {
        requiredVersion: 3, requireSourceBindings: true, requireIntegratedTables: true,
        minimumIntegratedTables: 0, structuredArtifacts: artifacts, sourceText
    }));
    const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
    let calls = 0;
    const evidence = deep.buildApiReaderEvidenceContext('', sourceText, artifacts, paperId,
        context.WEAK_READER_CAPABILITY_POLICY, resources);
    const result = await context.withConferenceAnalysisSource({
        executionId: EXECUTION, executionDir: root, paperId, sourceDetails: details
    }, () => deep.generateApiReaderArticleDetailed(paper, 'canonical analysis', evidence, {
        sourceText, structuredArtifacts: artifacts, readerMaxAttempts: 2,
        readerRecordDisposition: () => {}, readerCallModel: async () => {
            calls += 1;
            if (calls === 1) return JSON.stringify(badDraft);
            return JSON.stringify({ version: 1, draftSha256: hash(badDraft), replacements: [{
                path: '/sections/10/body', oldSha256: hash(badDraft.sections[10].body), value: originalBody
            }] });
        }
    }));
    assert.equal(calls, 2);
    assert.doesNotMatch(result.article, /代码已经开源并可下载/);
});
