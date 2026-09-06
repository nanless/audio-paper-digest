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

function successfulReaderDraft(sourceText) {
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
    [6, 7].forEach((sectionIndex, index) => {
        draft.sections[sectionIndex].body += '\n\n下表比较统一数据协议中的报告值，输入条件和基线保持一致，得分越高越好。\n\n'
            + '| 比较条件 | 控制变量 | 数据集 | 指标方向 | 报告值 | 解释 |\n|---|---|---|---|---:|---|\n'
            + `| ${index ? '完整方法' : '基线'} | 统一设置 | 测试集 | 越高越好 | 1.0 | 仅支持当前口径 |\n\n`
            + `第${index + 1}张表中数字只能支持当前数据和控制条件下的比较，原始输入范围与评估样本规模都必须保持一致。它没有覆盖的反例、方差、跨域条件和部署成本仍然是结论边界，不能从一行数字向外推广。`;
        draft.tableBindings.push({ tableIndex: index + 1, sourceType: 'source_quotes', sourceTableOrdinal: null,
            cellBindings: [], sourceQuotes: [sourceText] });
    });
    return draft;
}

test('weak conference PDF prepares isolated canonical identity with unavailable structured capabilities', t => {
    const fixture = productionPlanFixture(t);
    const analysisRoot = path.join(fixture.root, 'analysis');
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

test('mock common analysis observes source only through authenticated context and persists isolated canonical', async t => {
    const fixture = productionPlanFixture(t); const analysisRoot = path.join(fixture.root, 'analysis');
    adapter.prepareConferenceAnalysis({ planHandle: fixture.planHandle, paperId: fixture.paperId,
        sourceRoot: fixture.sourceRoot, analysisRoot, executionId: EXECUTION });
    let calls = 0;
    const engine = { withPaperAnalysisLock: async (_paper, callback) => callback(), analyzeBatch: async (papers, options) => {
        calls += 1; const prepared = await options.preparePaperLocked(papers[0]);
        assert.equal(prepared.paper.id, fixture.paperId); assert.equal(prepared.paper.fullText, undefined);
        const injected = context.getConferenceAnalysisSource(prepared.paper);
        assert.equal(injected.source, 'conference_pdf_text'); assert.ok(injected.text.length > 1000);
        assert.deepEqual(injected.conferenceCapabilities,
            { fullText: 'weak', tables: 'unavailable', formulas: 'unavailable', figures: 'unavailable' });
        await options.onPaperResultLocked(prepared.paper,
            { success: true, result: { ...prepared.paper, analysis: 'mock conference analysis' } });
        return { results: [], stats: { success: 1, failed: 0 } };
    } };
    const result = await adapter.analyzeConference({ analysisRoot, executionId: EXECUTION,
        planHandle: fixture.planHandle, sourceRoot: fixture.sourceRoot }, { engine, maxRetries: 0 });
    assert.equal(result.status, 'complete'); assert.equal(calls, 1);
    const loaded = adapter.loadConferenceAnalysis({ analysisRoot, executionId: EXECUTION });
    assert.equal(loaded.analysis.papers[0].analysis, 'mock conference analysis');
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
    analysis.papers[0].analysis = 'completed before run receipt';
    fs.writeFileSync(analysisFile, `${JSON.stringify(analysis, null, 2)}\n`);
    assert.equal(adapter.loadConferenceAnalysis({ analysisRoot, executionId: EXECUTION }).completionPending, true);
    await assert.rejects(adapter.analyzeConference({ analysisRoot, executionId: EXECUTION }), /live plan authority/);
    const recovered = await adapter.analyzeConference({ analysisRoot, executionId: EXECUTION,
        planHandle: fixture.planHandle, sourceRoot: fixture.sourceRoot });
    assert.equal(recovered.status, 'complete'); assert.equal(recovered.productionAuthorized, true);
    const sealed = adapter.loadConferenceAnalysis({ analysisRoot, executionId: EXECUTION });
    assert.equal(sealed.run.status, 'complete'); assert.equal(sealed.completionPending, false);
    analysis.papers[0].title = 'tampered after completion';
    fs.writeFileSync(analysisFile, `${JSON.stringify(analysis, null, 2)}\n`);
    assert.throws(() => adapter.loadConferenceAnalysis({ analysisRoot, executionId: EXECUTION }), /does not bind canonical analysis/);
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

test('conference analysis CLI requires complete authority for prepare and supports isolated status/analyze', async () => {
    const authorityPairs = executionCli.AUTHORITY_FLAGS.flatMap(flag => [flag,
        flag === '--filter' ? '11111111-1111-4111-8111-111111111111' : `${flag.slice(2)}.json`]);
    const paperId = 'conference:icassp:2026:icassp-arnumber:100';
    const prepared = cli.parseArgs(['prepare', ...authorityPairs, '--paper-id', paperId, '--analysis-run', EXECUTION]);
    assert.equal(prepared.paperId, paperId);
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
        imageInfos: [], structuredArtifacts: artifacts };
    await context.withConferenceAnalysisSource({ executionId: EXECUTION, executionDir: root, paperId,
        sourceDetails: details }, async () => {
        assert.deepEqual(await deep.materializeApiReaderFigures([], paperId), []);
        await assert.rejects(deep.materializeApiReaderFigures([{ ordinal: 1 }], paperId), /会议 weak PDF/);
        const authors = deep.resolveApiReaderAuthors({ id: paperId, authors: ['作者甲'] }, details);
        assert.deepEqual(authors.authors[0].affiliations, ['机构信息未能从会议 PDF 纯文本可靠映射']);
        assert.doesNotMatch(JSON.stringify(authors), /arXiv/);
        assert.equal(context.conferenceReaderAttemptsDirectory(), path.join(root, 'reader-attempts'));
        let calls = 0;
        const readerError = await deep.generateApiReaderArticleDetailed({ id: paperId, title: '会议论文', authors: ['作者甲'] },
            'canonical analysis', details.text, { sourceText: details.text,
                structuredArtifacts: artifacts, readerMaxAttempts: 1,
                readerRecordDisposition: () => {}, readerCallModel: async () => { calls += 1; return 'invalid JSON'; } })
            .then(() => null, error => error);
        assert.ok(readerError instanceof Error);
        assert.ok(calls > 0, `mock model was not reached: ${readerError.message}`);
        await assert.rejects(deep.generateApiReaderArticleDetailed({ id: paperId, title: '会议论文' },
            'canonical analysis', details.text, { sourceText: details.text,
                readerAttemptsDir: path.join(root, 'outside'), readerCallModel: async () => 'unused' }),
        /must stay inside/);
    });
});

test('weak PDF with zero structured tables and figures completes the real Reader parser using source-quote tables', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-reader-success-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paperId = 'conference:icassp:2026:icassp-arnumber:100';
    const sourceText = '在统一数据协议与输入条件下，基线和完整方法的报告得分均为1.0，仅用于当前离线对照。';
    const artifactBody = { version: 1, source: 'conference_pdf_weak_text', tables: [], formulas: [], figures: [],
        flattenedTextSha256: crypto.createHash('sha256').update(sourceText).digest('hex'), capabilityProfile: 'weak-text-only-v1' };
    const artifacts = { ...artifactBody, payloadSha256: crypto.createHash('sha256').update(JSON.stringify(artifactBody)).digest('hex') };
    const details = { text: sourceText, source: 'conference_pdf_text', sourceId: paperId,
        imageInfos: [], structuredArtifacts: artifacts };
    let calls = 0;
    const result = await context.withConferenceAnalysisSource({ executionId: EXECUTION, executionDir: root, paperId,
        sourceDetails: details }, () => deep.generateApiReaderArticleDetailed({ id: paperId, title: '会议论文', authors: ['作者甲'] },
        'canonical analysis', sourceText, { sourceText, structuredArtifacts: artifacts, readerMaxAttempts: 1,
            readerRecordDisposition: () => {}, readerCallModel: async () => {
                calls += 1; return JSON.stringify(successfulReaderDraft(sourceText));
            } }));
    assert.equal(calls, 1); assert.equal(result.plan.figurePlacements.length, 0);
    assert.equal(result.plan.tableBindings.length, 2);
    assert.ok(result.plan.tableBindings.every(item => item.sourceType === 'source_quotes'));
    assert.match(result.article, /\| 比较条件 \| 控制变量 \|/);
});
