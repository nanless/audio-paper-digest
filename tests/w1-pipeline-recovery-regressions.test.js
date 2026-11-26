'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const codec = require('../scripts/lib/protocol-codec');
const repair = require('../scripts/lib/reader-repair');
const parentRecovery = require('../scripts/lib/reader-parent-recovery');
const readerTables = require('../scripts/lib/reader-tables');
const deep = require('../scripts/deep-analyzer');
const engine = require('../scripts/analysis-engine');
const hf = require('../scripts/fetch-huggingface-papers');
const { ArxivOriginGate } = require('../scripts/lib/arxiv-origin-gate');

function makeV5Draft(sectionCount = 6, overrides = {}) {
    const header = codec.recordHeader(codec.contract('reader-draft'), 'reader-draft');
    const kinds = ['problem', 'method_overview', 'component', 'experiment_setup', 'result', 'limitation', 'ablation', 'synthesis', 'reproduction'];
    const sections = Array.from({ length: sectionCount }, (_, i) => ({
        kind: kinds[i % kinds.length],
        heading: `论文特有技术问题与关键机制分析第${i + 1}节`,
        body: `这是第 ${i + 1} 节的完整正文内容，讨论语音建模与实验设置细节，字数充足以满足恢复校验要求。`.repeat(4)
    }));
    return {
        ...header,
        readerTitle: '端到端语音建模为什么需要显式上下文融合机制？',
        oneSentenceThesis: '论文通过在编码器与解码器之间引入显式上下文融合模块显著降低噪声语音词错误率。',
        sections,
        conceptBridges: [],
        figurePlacements: [],
        tableBindings: [],
        formulaBindings: [],
        ...overrides
    };
}

test('CP-P0-2: reader-parent-recovery fullReason and reader-repair accept 5-9 section v5 drafts', () => {
    const draft = makeV5Draft(6);
    const issues = [{ path: '/sections/0/body', message: '示例问题' }];
    const payload = {
        status: 'failed',
        draft,
        rawDraft: JSON.stringify(draft),
        attempts: 2,
        fullAttempts: 1,
        noProgress: 2,
        validationFailureStreak: 0,
        failureSignature: 'a'.repeat(64),
        issues
    };
    const reason = parentRecovery.fullReason(payload);
    assert.ok(reason);
    assert.equal(reason.code, 'complete_failed_draft_no_progress');
    assert.equal(reason.draftSha256, repair.hashDraft(draft));

    // A 4-section v5 draft is still below v5 minimumSections (5) and must not qualify.
    const tooShort = makeV5Draft(4);
    assert.equal(parentRecovery.fullReason({ ...payload, draft: tooShort, rawDraft: JSON.stringify(tooShort) }), null);

    // buildMissingConceptBridgesOperation uses format limits (5..9 for v5) instead of hardcoded 12..18.
    const bridgeDraft = makeV5Draft(6, {
        conceptBridges: [{
            terms: ['上下文编码', '局部帧'],
            sectionKind: 'method_overview',
            marker: '[[CONCEPT_BRIDGE_1]]',
            explanation: '上下文编码负责聚合跨帧长程语义依赖，而局部帧保留细粒度声学时频边界，两者协同融合可有效避免强背景噪声片段误判。'
        }]
    });
    bridgeDraft.sections[1].body += '\n\n[[CONCEPT_BRIDGE_1]]';
    const op = repair.buildMissingConceptBridgesOperation(bridgeDraft, [{ message: 'conceptBridges 必须包含 4-10 个术语组合解释' }]);
    assert.ok(op);
    assert.equal(op.kind, 'complete_existing_concept_bridges_v1');
});

test('CP-P1-5: reader-tables order mismatch attaches TABLE_BINDING_ORDER_ERROR_CODE and satisfies classifyTableBindingOrderError', () => {
    const artifacts = {
        tables: [{
            ordinal: 1,
            caption: 'Table 1: Main results',
            rows: [['Method', 'WER'], ['Ours', '9.8%']],
            domSha256: 'a'.repeat(64)
        }]
    };
    // Section has an inline Markdown table BEFORE [[TABLE_1]], so priorTables + 1 === 2 !== tableIndex (1).
    const sections = [{
        kind: 'result',
        heading: '实验对比结果分析',
        body: '| Method | WER |\n| --- | --- |\n| Base | 12.4% |\n\n[[TABLE_1]]'
    }];
    const tableBindings = [{
        tableIndex: 1,
        completeTable: {
            contract: readerTables.READER_COMPLETE_TABLE_ELIGIBILITY_CONTRACT,
            sourceTableOrdinal: 1
        }
    }];
    let caught = null;
    try {
        readerTables.compileReaderTableSelections(sections, tableBindings, artifacts);
    } catch (error) {
        caught = error;
    }
    assert.ok(caught);
    assert.equal(caught.code, repair.TABLE_BINDING_ORDER_ERROR_CODE);
    assert.ok(Array.isArray(caught.readerIssues) && caught.readerIssues.length === 1);
    assert.equal(caught.readerIssues[0].path, '/tableBindings/0');
    assert.equal(caught.readerIssues[0].code, repair.TABLE_BINDING_ORDER_ISSUE_CODE);
    assert.equal(caught.readerIssues[0].message, caught.message);
    const classified = repair.classifyTableBindingOrderError(caught);
    assert.equal(classified.validOrderError, true);
    assert.equal(classified.actionable, true);
    assert.equal(classified.kind, 'typed');
});

test('CP-P1-7: enrichHfOnlyPapersWithArxivMetadata routes through originGate and tracks failedCount & 429 cooldown', async () => {
    const gate = new ArxivOriginGate({ maxConcurrency: 1 });
    let gateUsed = false;
    const origRun = gate.run.bind(gate);
    gate.run = async fn => { gateUsed = true; return origRun(fn); };

    const papers = [{ arxivId: '2611.12345', categories: [] }];
    const okResult = await hf.enrichHfOnlyPapersWithArxivMetadata(papers, new Set(), {
        originGate: gate,
        fetchArxivMetadataBatchByIds: async () => new Map([['2611.12345', { categories: ['cs.SD'] }]])
    });
    assert.equal(gateUsed, true);
    assert.equal(okResult.enrichedCount, 1);
    assert.equal(okResult.failedCount, 0);
    assert.deepEqual(papers[0].categories, ['cs.SD']);

    const failPapers = [{ arxivId: '2611.54321', categories: [] }];
    const failResult = await hf.enrichHfOnlyPapersWithArxivMetadata(failPapers, new Set(), {
        originGate: gate,
        fetchArxivMetadataBatchByIds: async () => { throw new Error('arXiv id_list 查询返回异常响应（HTTP 429）'); }
    });
    assert.equal(failResult.failedCount, 1);
    assert.ok(gate.remainingCooldownMs() > 0);
});

test('CP-P2-4: local dead .reclaiming.json is reclaimed immediately after 5s grace under LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY', t => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reclaim-marker-dead-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
    assert.equal(child.status, 0);

    const target = path.join(dir, 'state.json');
    const lock = `${target}.lock`;
    fs.mkdirSync(lock, { mode: 0o700 });
    const ownerAt = new Date(Date.now() - 10_000);
    const ownerFile = path.join(lock, 'owner.json');
    fs.writeFileSync(ownerFile, JSON.stringify({
        pid: child.pid, hostname: os.hostname(), token: crypto.randomUUID(), acquiredAt: ownerAt.toISOString()
    }), { mode: 0o600 });
    fs.utimesSync(ownerFile, ownerAt, ownerAt);

    // Dead local reclaimer marker 10s old (<< staleMs 600_000, > 5s grace)
    const markerFile = path.join(lock, '.reclaiming.json');
    fs.writeFileSync(markerFile, JSON.stringify({
        pid: child.pid, hostname: os.hostname(), token: crypto.randomUUID(), acquiredAt: ownerAt.toISOString()
    }), { mode: 0o600 });
    fs.utimesSync(markerFile, ownerAt, ownerAt);

    // Without local-dead recovery policy, 600s staleMs does NOT reclaim it.
    assert.throws(() => engine.acquireFileLockSync(target, { timeoutMs: 25, staleMs: 600_000 }), /超时/);
    // With LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY, dead local .reclaiming.json > 5s old IS reclaimed immediately!
    const release = engine.acquireFileLockSync(target, {
        timeoutMs: 100,
        staleMs: 600_000,
        recoveryPolicy: engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY
    });
    assert.equal(release(), true);
});

test('PC-P1-2, PC-P1-3, PC-P2-2: heading normalization before dup check, post-normalization conceptBridge terms length, and patch context paths', () => {
    // PC-P2-2: isSafeExistingReaderPatchContext allows leaf body/explanation targets while rejecting whole /sections/0
    const draft = makeV5Draft(6, {
        conceptBridges: [{
            terms: ['语音表征', '声学编码'],
            sectionKind: 'method_overview',
            marker: '[[CONCEPT_BRIDGE_1]]',
            explanation: '语音表征把连续波形压缩为离散或连续向量，声学编码负责提取帧级特征并保留上下文边界。'
        }],
        figurePlacements: [{
            figureOrdinal: 1,
            targetKind: 'method_overview',
            marker: '[[FIGURE_1]]',
            explanationQuote: '编码器输入特征维度与解码器融合位置如图所示。',
            focusPoints: ['编码器输入特征维度', '解码器融合位置']
        }]
    });
    const makeCtx = targetPath => {
        const parts = targetPath.split('/').slice(1);
        let value = draft;
        for (const p of parts) value = value[p];
        return {
            draftSha256: repair.hashDraft(draft),
            targets: [{ path: targetPath, oldSha256: repair.hashDraft(value), value }],
            issues: [{ path: targetPath, message: '测试局部修复' }],
            figureOrdinals: [1],
            evidence: ''
        };
    };
    for (const allowedPath of ['/sections/0/body', '/conceptBridges/0/explanation', '/figurePlacements/0/explanationQuote']) {
        const ctx = makeCtx(allowedPath);
        assert.equal(repair.isSafeExistingReaderPatchContext(draft, ctx, false, ctx.issues), true, allowedPath);
    }
    const wholeSectionCtx = makeCtx('/sections/0');
    assert.equal(repair.isSafeExistingReaderPatchContext(draft, wholeSectionCtx, false, wholeSectionCtx.issues), false, '/sections/0 must be rejected');

    // PC-P1-2: headings that collide ONLY after normalizeReaderProseFormatting are rejected as duplicate!
    const dupHeadingDraft = makeV5Draft(5);
    dupHeadingDraft.sections[0].heading = '基于Transformer的声学上下文融合为什么有效';
    dupHeadingDraft.sections[1].heading = '基于 Transformer 的声学上下文融合为什么有效';
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(dupHeadingDraft), {
        arxivId: '2611.00001',
        sourceText: 'Transformer 声学上下文融合在公开测试集上提升了性能。'.repeat(20)
    }), /小节标题重复/);

    // PC-P1-3: conceptBridges.terms exceeding 48 chars AFTER CJK-Latin spacing normalization is rejected!
    const longTermDraft = makeV5Draft(6, {
        conceptBridges: [{
            terms: ['语音识别ASR模型架构Transformer编码器解码器融合机制Audio特征提取模块', '上下文融合'],
            sectionKind: 'problem',
            marker: '[[CONCEPT_BRIDGE_1]]',
            explanation: '该术语组合用于说明语音识别模型中声学编码器与上下文融合模块之间的特征对齐与残差传递机制，避免在长段音频中丢失语义边界。'
        }]
    });
    // Raw length is <= 48, but CJK/Latin spacing pushes normalized length > 48!
    assert.ok(longTermDraft.conceptBridges[0].terms[0].length <= 48);
    longTermDraft.sections[0].body += '\n\n[[CONCEPT_BRIDGE_1]]';
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(longTermDraft), {
        arxivId: '2611.00001',
        sourceText: '语音识别 ASR 模型架构 Transformer 编码器解码器融合机制 Audio 特征提取模块。'.repeat(20)
    }), /terms|48/);
});

test('CP-P2-2: fetchFreshSource re-registers verifiedBundleAuthorSources on cache miss and concurrent wait', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fresh-author-weakmap-'));
    const Config = require('../scripts/config');
    const daily = require('../scripts/lib/daily-fresh-source-plan');
    const fresh = require('../scripts/lib/fresh-analysis-context');
    const sourceApi = require('../scripts/lib/fresh-arxiv-rewrite-source');
    const prevRunsDir = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
    t.after(() => {
        Config.FILES.dailyFreshSourceRunsDir = prevRunsDir;
        fs.rmSync(root, { recursive: true, force: true });
    });

    const paperId = '2611.11111';
    const plan = daily.createDailyFreshSourcePlan({
        batchDate: '2026-11-26',
        batchId: 'weakmap-clone-test',
        papers: [{ arxivId: `${paperId}v1`, title: 'Author WeakMap test', authors: ['Alice'] }]
    });
    const text = 'Official paper text for author WeakMap propagation test. '.repeat(200);
    const structuredArtifacts = deep.bindStructuredArtifactsToText({
        version: 1, source: 'html', tables: [], formulas: [], figures: []
    }, text);

    const origCapture = sourceApi.captureFreshArxivRewriteSource;
    sourceApi.captureFreshArxivRewriteSource = (opts) => origCapture(opts, {
        fetchText: async sourceId => ({
            text, title: 'Author WeakMap test', source: 'html', sourceId,
            url: `https://arxiv.org/html/${sourceId}`, fetchedAt: '2026-11-26T00:00:00.000Z',
            imageInfos: [], structuredArtifacts, readerAuthors: { authors: [{ name: 'Alice', affiliations: ['Lab'] }] },
            htmlAvailability: 'available', htmlAttempts: 1, warnings: []
        }),
        fetchPdf: async sourceId => ({
            bytes: Buffer.from('%PDF-1.7\n%%EOF\n'),
            url: `https://arxiv.org/pdf/${sourceId}.pdf`, fetchedAt: '2026-11-26T00:00:00.000Z'
        })
    });
    t.after(() => { sourceApi.captureFreshArxivRewriteSource = origCapture; });

    await daily.withDailyFreshAnalysisContext(plan, async () => {
        // Trigger cache miss + concurrent wait simultaneously!
        const [first, second] = await Promise.all([
            fresh.fetchFreshSource(paperId, async () => { throw new Error('unused'); }),
            fresh.fetchFreshSource(paperId, async () => { throw new Error('unused'); })
        ]);
        assert.equal(fresh.hasVerifiedBundleAuthorSource(first), true);
        assert.equal(fresh.hasVerifiedBundleAuthorSource(second), true);
        assert.notEqual(first, second);
    });
});

test('PC-P1-7 & image probe: parseApiReaderArticleResult defaults requireImplementationSpecs=false; image probe sets reasoningStage', async () => {
    // PC-P1-7: cold parseApiReaderArticleResult keeps requireImplementationSpecs default false (v5 draft without implementationSpecs passes top-level check)
    const draftNoSpecs = makeV5Draft(6);
    let errDefault = null;
    try {
        deep.parseApiReaderArticleResult(JSON.stringify(draftNoSpecs), {
            arxivId: '2611.00002',
            sourceText: '端到端语音建模与上下文融合实验详情。'.repeat(20)
        });
    } catch (e) { errDefault = e; }
    assert.ok(!errDefault || !/implementationSpecs/.test(errDefault.message),
        `Default parseApiReaderArticleResult must not require implementationSpecs: ${errDefault?.message}`);

    // With requireImplementationSpecs: true, missing implementationSpecs IS rejected!
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(draftNoSpecs), {
        arxivId: '2611.00002',
        requireImplementationSpecs: true,
        sourceText: '端到端语音建模与上下文融合实验详情。'.repeat(20)
    }), /implementationSpecs/);

    // Image probe passes reasoningStage: 'apiReaderImageProbe' explicitly (overriding caller reasoningStage)
    const probeOptionsSeen = [];
    let callIdx = 0;
    const img1 = { inputId: 'figure:1:aaa', label: 'fig1', base64: 'AA==', mime: 'image/png', sourceSha256: 'a'.repeat(64), modelPayloadSha256: 'b'.repeat(64) };
    const img2 = { inputId: 'figure:2:ccc', label: 'fig2', base64: 'BB==', mime: 'image/png', sourceSha256: 'c'.repeat(64), modelPayloadSha256: 'd'.repeat(64) };
    const res = await deep.requestReaderModelWithImageIsolation({
        imageInputs: [img1, img2],
        maxTokens: 1000,
        requestOptions: { reasoningStage: 'apiReaderArticle', usageContext: { stage: 'apiReaderArticle' } },
        buildMessages: active => [{ role: 'user', content: `count=${active.length}` }],
        requestModel: async (_msgs, tokens, reqOpts) => {
            callIdx += 1;
            if (tokens === 32) {
                probeOptionsSeen.push({ reasoningStage: reqOpts.reasoningStage, stage: reqOpts.usageContext?.stage });
                if (reqOpts.usageContext?.imageInputId === img1.inputId) {
                    const err = new Error('invalid image data');
                    err.status = 400;
                    throw err;
                }
                return 'ok';
            }
            if (callIdx === 1) {
                const err = new Error('invalid image data');
                err.status = 400;
                throw err;
            }
            return 'final-ok';
        }
    });
    assert.equal(res.raw, 'final-ok');
    assert.equal(probeOptionsSeen.length, 2);
    for (const seen of probeOptionsSeen) {
        assert.equal(seen.reasoningStage, 'apiReaderImageProbe');
        assert.equal(seen.stage, 'apiReaderImageProbe');
    }
});
