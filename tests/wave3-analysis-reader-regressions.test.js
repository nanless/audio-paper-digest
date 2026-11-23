'use strict';

require('./core-diagnostics-test-isolation')();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('B-C1: resetReaderForSelectedReanalysis 与 resetReaderForForcedReanalysis 删除所有 Reader 专属契约', () => {
    const {
        resetReaderForSelectedReanalysis,
        resetReaderForForcedReanalysis
    } = require('../scripts/lib/reanalysis-helpers');
    const paper = {
        arxivId: '2611.99901',
        analysis: '## 核心摘要\n正文',
        parsed: { score: 8.0 },
        apiReaderArticle: '### 标题\n\n正文',
        apiReaderPlan: { version: 3 },
        analysisManifest: {
            stages: {
                imageSupplement: {
                    status: 'complete',
                    analysisSha256: '9'.repeat(64)
                },
                apiReaderArticle: {
                    status: 'complete',
                    articleSha256: 'a'.repeat(64),
                    planSha256: 'b'.repeat(64),
                    ordinalCompletionProof: { path: '/tmp/000001.json', sha256: 'c'.repeat(64) },
                    ordinalPatchCompilations: [{ requestId: 'req-1' }]
                }
            },
            contracts: {
                apiReaderArticle: 'reader-draft',
                apiReaderSourceBindings: 'reader-source-bindings-v1',
                apiReaderAuthorIdentity: 'reader-author-identity-v1',
                apiReaderResourceIdentity: 'reader-resource-identity-v1',
                apiReaderFigurePersistence: 'reader-figure-persistence-v1',
                imageNarrative: 'image-narrative-v1',
                readerTargetOrdinalPatch: 'reader-target-ordinal-patch-v1',
                readerResourceClaims: 'reader-resource-availability-claims',
                readerVersionMetadataRecovery: 'reader-version-metadata-recovery-v1',
                otherContract: 'keep-me'
            }
        }
    };

    for (const resetFn of [resetReaderForSelectedReanalysis, resetReaderForForcedReanalysis]) {
        const next = resetFn(paper);
        assert.equal(next.readerRevisionHistory?.contract, 'daily-reader-revision-history-v1');
        assert.equal(next.readerRevisionHistory?.reason, 'stage-invalidated');
        assert.equal(next.analysisManifest.stages.apiReaderArticle, undefined);
        assert.equal(next.analysisManifest.stages.imageSupplement, undefined);
        assert.equal(next.analysisManifest.contracts.readerTargetOrdinalPatch, undefined);
        assert.equal(next.analysisManifest.contracts.readerResourceClaims, undefined);
        assert.equal(next.analysisManifest.contracts.readerVersionMetadataRecovery, undefined);
        assert.equal(next.analysisManifest.contracts.apiReaderArticle, undefined);
        assert.equal(next.analysisManifest.contracts.apiReaderSourceBindings, undefined);
        assert.equal(next.analysisManifest.contracts.apiReaderAuthorIdentity, undefined);
        assert.equal(next.analysisManifest.contracts.apiReaderResourceIdentity, undefined);
        assert.equal(next.analysisManifest.contracts.apiReaderFigurePersistence, undefined);
        assert.equal(next.analysisManifest.contracts.imageNarrative, undefined);
        assert.equal(next.analysisManifest.contracts.otherContract, 'keep-me');
    }
});

test('B-C1: mergePapersById 失败保留原 Reader 时同步恢复全部 Reader 与 imageSupplement 契约', () => {
    const { mergePapersById } = require('../scripts/analysis-engine');
    const { resetReaderForSelectedReanalysis } = require('../scripts/lib/reanalysis-helpers');
    const readerResourceClaimsFormat = require('../scripts/lib/reader-resource-claims-format');
    const { validAnalysisText } = require('./valid-analysis-fixture');
    const { parseAnalysis } = require('../scripts/utils');
    const validAnalysis = validAnalysisText();
    const resourceHeader = readerResourceClaimsFormat.header();

    const existing = {
        arxivId: '2611.99902',
        sourceSha256: '1'.repeat(64),
        analysis: validAnalysis,
        parsed: parseAnalysis(validAnalysis),
        apiReaderArticle: '### 问题\n\n旧正文',
        apiReaderPlan: { version: 3 },
        analysisManifest: {
            stages: {
                imageSupplement: {
                    status: 'complete',
                    analysisSha256: '9'.repeat(64)
                },
                apiReaderArticle: {
                    status: 'complete',
                    articleSha256: 'a'.repeat(64),
                    planSha256: 'b'.repeat(64),
                    ordinalCompletionProof: { path: '/tmp/000001.json', sha256: 'c'.repeat(64) },
                    ordinalPatchCompilations: [{ requestId: 'req-1' }],
                    readerResourceClaimsProtocol: resourceHeader
                }
            },
            contracts: {
                apiReaderArticle: 'reader-draft',
                apiReaderSourceBindings: 'reader-source-bindings-v1',
                apiReaderAuthorIdentity: 'reader-author-identity-v1',
                apiReaderResourceIdentity: 'reader-resource-identity-v1',
                apiReaderFigurePersistence: 'reader-figure-persistence-v1',
                imageNarrative: 'image-narrative-v1',
                readerTargetOrdinalPatch: 'reader-target-ordinal-patch-v1',
                readerResourceClaims: resourceHeader.contract,
                readerVersionMetadataRecovery: 'reader-version-metadata-recovery-v1'
            }
        }
    };

    // Case 1: 重置后在主分析阶段即失败（incoming 无 apiReader* 字段，但有 readerRevisionHistory）
    const resetFailedBeforeReader = resetReaderForSelectedReanalysis(existing);
    resetFailedBeforeReader.error = '主分析超时';
    const [merged1] = mergePapersById([existing], [resetFailedBeforeReader], { preserveSuccessfulAnalysis: true });
    assert.deepEqual(merged1.analysisManifest.stages.imageSupplement, existing.analysisManifest.stages.imageSupplement);
    assert.equal(merged1.analysisManifest.contracts.imageNarrative, 'image-narrative-v1');
    assert.equal(merged1.analysisManifest.contracts.apiReaderSourceBindings, 'reader-source-bindings-v1');
    assert.equal(merged1.analysisManifest.contracts.apiReaderAuthorIdentity, 'reader-author-identity-v1');
    assert.equal(merged1.analysisManifest.contracts.apiReaderResourceIdentity, 'reader-resource-identity-v1');
    assert.equal(merged1.analysisManifest.contracts.apiReaderFigurePersistence, 'reader-figure-persistence-v1');
    assert.equal(merged1.analysisManifest.contracts.readerTargetOrdinalPatch, 'reader-target-ordinal-patch-v1');
    assert.equal(merged1.analysisManifest.contracts.readerResourceClaims, resourceHeader.contract);
    assert.equal(merged1.analysisManifest.contracts.readerVersionMetadataRecovery, 'reader-version-metadata-recovery-v1');
    assert.equal(
        readerResourceClaimsFormat.matches(merged1.analysisManifest, merged1.analysisManifest.stages.apiReaderArticle),
        true
    );
    assert.deepEqual(
        merged1.analysisManifest.stages.apiReaderArticle.ordinalCompletionProof,
        existing.analysisManifest.stages.apiReaderArticle.ordinalCompletionProof
    );
    assert.equal(merged1.readerRevisionHistory, undefined);
    assert.equal(Object.hasOwn(merged1, 'readerRevisionHistory'), false);
    assert.equal(merged1.apiReaderFailedBundleHistory?.length, 1);
    assert.deepEqual(merged1.apiReaderFailedBundleHistory[0].contracts, {});
    assert.equal(merged1.apiReaderFailedBundleHistory[0].readerRevisionHistory?.reason, 'stage-invalidated');

    // Case 2: existing 无活跃 Reader 阶段时，incoming 的 readerRevisionHistory 必须保留
    const existingNoReader = {
        ...existing,
        analysisManifest: { stages: {}, contracts: {} }
    };
    delete existingNoReader.apiReaderArticle;
    delete existingNoReader.apiReaderPlan;
    const incomingWithRevision = {
        ...existingNoReader,
        analysis: null,
        parsed: null,
        error: '主分析失败',
        readerRevisionHistory: {
            contract: 'daily-reader-revision-history-v1',
            reason: 'stage-invalidated',
            completionProof: { path: '/tmp/000001.json', sha256: 'c'.repeat(64) }
        }
    };
    const [merged2] = mergePapersById([existingNoReader], [incomingWithRevision], { preserveSuccessfulAnalysis: true });
    assert.deepEqual(merged2.readerRevisionHistory, incomingWithRevision.readerRevisionHistory);

    // Case 3: existing 的 stages.apiReaderArticle 仅为非 complete（如 invalid_output）且无活跃正文/序号标记时，
    // 必须保留 incoming.readerRevisionHistory，避免第 2 轮重跑触发 READER_ORDINAL_ORIGIN_MISSING。
    const existingFailedReaderStage = {
        ...existingNoReader,
        analysisManifest: {
            stages: { apiReaderArticle: { status: 'invalid_output', error: '旧失败' } },
            contracts: {}
        }
    };
    const [merged3] = mergePapersById([existingFailedReaderStage], [incomingWithRevision], { preserveSuccessfulAnalysis: true });
    assert.deepEqual(merged3.readerRevisionHistory, incomingWithRevision.readerRevisionHistory);

    // Case 4: saved-fact-feedback.js 与 merge-failed-reader-bundle.js 共享 Reader 契约判定，
    // 确保带 readerResourceClaims / readerVersionMetadataRecovery 的归档包不被误过滤且上游保护不误报。
    const { isReaderContractKey } = require('../scripts/lib/merge-failed-reader-bundle');
    const { protectedReaderUpstream } = require('../scripts/lib/saved-fact-feedback');
    for (const key of ['apiReaderArticle', 'apiReaderSourceBindings', 'readerResourceClaims', 'readerTargetOrdinalPatch', 'readerVersionMetadataRecovery']) {
        assert.equal(isReaderContractKey(key), true, `${key} 应属于 Reader 契约`);
    }
    assert.equal(isReaderContractKey('otherContract'), false);
    const upstream = protectedReaderUpstream(existing);
    assert.equal(upstream.analysisManifest.contracts.readerResourceClaims, undefined);
    assert.equal(upstream.analysisManifest.contracts.readerTargetOrdinalPatch, undefined);
    assert.equal(upstream.analysisManifest.contracts.readerVersionMetadataRecovery, undefined);
    assert.equal(upstream.analysisManifest.contracts.imageNarrative, undefined);
    const savedFeedbackSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/saved-fact-feedback.js'), 'utf8');
    assert.match(savedFeedbackSrc, /Object\.keys\(packet\.contracts \|\| \{\}\)\.every\(isReaderContractKey\)/);
});

test('B-L3: analyzeBatch 成功路径清除内存中遗留的 paper.analysisFactReviewObligation', async t => {
    const { analyzeBatch } = require('../scripts/analysis-engine');
    const pendingFeedback = require('../scripts/lib/pending-fact-feedback');
    const { validAnalysisPaper } = require('./valid-analysis-fixture');
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave3-bl3-lock-'));
    const origCompleted = pendingFeedback.completed;
    pendingFeedback.completed = () => true;
    t.after(() => {
        pendingFeedback.completed = origCompleted;
        fs.rmSync(lockDir, { recursive: true, force: true });
    });
    const completed = validAnalysisPaper('2611.99908');
    const paper = {
        arxivId: '2611.99908',
        title: completed.title,
        analysisFactReviewObligation: { feedbackSha256: 'f'.repeat(64) },
        latestAnalysisAttemptError: '旧错误'
    };
    const batch = await analyzeBatch([paper], {
        concurrency: 1,
        maxRounds: 1,
        paperLockOptions: { lockDir },
        analyzeFn: async () => structuredClone(completed)
    });
    assert.equal(batch.stats.success, 1, '分析应成功完成');
    assert.equal(Object.hasOwn(paper, 'analysisFactReviewObligation'), false);
    assert.equal(Object.hasOwn(paper, 'latestAnalysisAttemptError'), false);
});

test('B-H1: applyReaderPatch 事实局部补丁线性匹配无 ReDoS 且等价校验所有边界', () => {
    const { applyReaderPatch, hashDraft } = require('../scripts/lib/reader-repair');
    const makeDraft = body => ({
        version: 3,
        readerTitle: '标题',
        oneSentenceThesis: '主旨',
        sections: [{ kind: 'result', heading: '结果', body }],
        conceptBridges: [],
        figurePlacements: [],
        tableBindings: [],
        formulaBindings: []
    });
    const makePatch = (draft, value) => ({
        version: 1,
        draftSha256: hashDraft(draft),
        replacements: [{
            path: '/sections/0/body',
            oldSha256: hashDraft(draft.sections[0].body),
            value
        }]
    });

    const claims = Array.from({ length: 10 }, (_, i) => `错误句${i}。`);
    const oldBody = '前缀固定文字。' + claims.join('') + '后缀固定文字。';
    const draft = makeDraft(oldBody);
    const evilReplacement = '前缀固定文字。' + 'a'.repeat(3000) + '错误后缀';
    const start = Date.now();
    assert.throws(
        () => applyReaderPatch(draft, makePatch(draft, evilReplacement), ['/sections/0/body'], {
            readerFactLocalClaims: { '/sections/0/body': claims }
        }),
        /事实局部补丁改变了错误原句以外正文或引入图表标记/
    );
    const elapsedMs = Date.now() - start;
    assert.ok(elapsedMs < 200, `ReDoS 探针耗时过长: ${elapsedMs}ms`);

    const okReplacement = '前缀固定文字。' + claims.map((_, i) => `正确句${i}。`).join('') + '后缀固定文字。';
    const patched = applyReaderPatch(draft, makePatch(draft, okReplacement), ['/sections/0/body'], {
        readerFactLocalClaims: { '/sections/0/body': claims }
    });
    assert.equal(patched.sections[0].body, okReplacement);

    const twoClaims = ['错句A。', '错句B。'];
    const adjDraft = makeDraft('前。错句A。错句B。后。');
    for (const bad of ['前。修改[[修改。后。', '前。修![改。后。', '前。修|改。后。', '前。   a   后。']) {
        assert.throws(
            () => applyReaderPatch(adjDraft, makePatch(adjDraft, bad), ['/sections/0/body'], {
                readerFactLocalClaims: { '/sections/0/body': twoClaims }
            }),
            /事实局部补丁改变了错误原句以外正文或引入图表标记/
        );
    }

    const tableMid = '\n\n| 方法 | 指标 |\n| --- | --- |\n| 基线 | 1.0 |\n\n';
    const tableDraft = makeDraft(`首句错误。${tableMid}尾句错误。`);
    const tableUpdated = `首句已修正。${tableMid}尾句已修正。`;
    const tablePatched = applyReaderPatch(tableDraft, makePatch(tableDraft, tableUpdated), ['/sections/0/body'], {
        readerFactLocalClaims: { '/sections/0/body': ['首句错误。', '尾句错误。'] }
    });
    assert.equal(tablePatched.sections[0].body, tableUpdated);
});

test('B-H2 & B-L1: 动态替换含 $\' / $` / $& / $$ 不破坏正文，且 \\Downarrow 原表不被误拒', () => {
    const readerTables = require('../scripts/lib/reader-tables');
    const makeCells = rows => rows.flatMap((row, r) => row.map((text, c) => ({
        row: r,
        column: c,
        text,
        sourceDomSha256: `${r}${c}`.repeat(32)
    })));
    const downarrowMatrix = [['Method', 'WER \\Downarrow'], ['Ours', '4.2']];
    const downarrowTable = {
        ordinal: 1,
        caption: 'Table 1: WER metrics',
        matrix: downarrowMatrix,
        cells: makeCells(downarrowMatrix),
        recoveryStatus: 'complete',
        sourceDomSha256: 'e'.repeat(64)
    };
    const elig = readerTables.assessReaderCompleteTableEligibility(downarrowTable);
    assert.equal(elig.eligible, true, `\\Downarrow 原表应判定为可渲染: ${JSON.stringify(elig)}`);

    const matrix = [['模型', '成本符号'], ['MethodA', "$& $' $$10"]];
    const domSha = 'd'.repeat(64);
    const artifacts = {
        tables: [{
            ordinal: 1,
            caption: 'Table 1: Cost symbols',
            headers: matrix[0],
            rows: [matrix[1]],
            matrix,
            cells: makeCells(matrix),
            recoveryStatus: 'complete',
            sourceDomSha256: domSha
        }]
    };
    const sections = [{
        kind: 'result',
        heading: '结果',
        body: '表前导语。\n\n[[TABLE_1]]\n\n表后尾注。'
    }];
    const tableBindings = [{
        tableIndex: 1,
        completeTable: { sourceTableOrdinal: 1 }
    }];
    const compiled = readerTables.compileReaderTableSelections(sections, tableBindings, artifacts);
    assert.ok(compiled.sections[0].body.includes("$& $' $$10"), `特殊 $ 序列被破坏: ${compiled.sections[0].body}`);
    assert.ok(!compiled.sections[0].body.includes('[[TABLE_1]]'));
});

test('B-H4: normalizeApiReaderDraftPreOrder 统一收口去不可用图与引号空白，遇不可渲染原表 SHA 与 blocked 精确对齐', () => {
    const deep = require('../scripts/deep-analyzer');
    const sourceBlocked = require('../scripts/lib/reader-source-blocked-normalization');
    const draftOrder = require('../scripts/lib/reader-draft-order');
    const { hashDraft } = require('../scripts/lib/reader-repair');
    const makeCells = rows => rows.flatMap((row, r) => row.map((text, c) => ({
        row: r, column: c, text, sourceDomSha256: `${r}${c}`.repeat(32)
    })));
    const badMatrix = [['Method', 'Score'], ['Ours', '\\unknowncmd{4.2}']];
    const artifacts = {
        tables: [{
            ordinal: 1,
            caption: 'Table 1: Unrenderable TeX',
            matrix: badMatrix,
            cells: makeCells(badMatrix),
            recoveryStatus: 'complete',
            sourceDomSha256: 'a'.repeat(64)
        }]
    };
    const sourceText = 'Our streaming encoder achieves low latency on TestClean.';
    const rawDraft = {
        ...require('../scripts/lib/protocol-codec').record('reader-draft'),
        readerTitle: '标题',
        oneSentenceThesis: '主旨',
        sections: [{
            kind: 'result',
            heading: '结果',
            body: '紧贴表格标记的说明。[[TABLE_1]]\n\n[[FIGURE_2]]\n\n| 模型 | 延迟 |\n| --- | --- |\n| Ours | 10ms |\n\n表后解释。'
        }],
        conceptBridges: [],
        figurePlacements: [{
            figureOrdinal: 2,
            targetKind: 'result',
            marker: '[[FIGURE_2]]',
            focusPoints: ['核对曲线趋势与纵轴刻度']
        }],
        tableBindings: [
            { tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } },
            {
                tableIndex: 2,
                sourceType: 'source_quotes',
                sourceQuotes: ['Our   streaming\nencoder achieves  low latency on TestClean.']
            }
        ],
        formulaBindings: []
    };
    // 预处理必须统一完成不可用图剥离、sourceQuote 空白归一与 [[TABLE_1]] 独立成段，
    // 从而使 normalizeApiReaderRecoveryDraftForSource 抛出 READER_SOURCE_TABLE_UNRENDERABLE 时
    // error.normalizationInputSha256 与预处理后的草稿哈希严格一致。
    const preOrdered = deep.normalizeApiReaderDraftPreOrder(structuredClone(rawDraft), [], {
        pixelFigureOrdinals: [],
        sourceText
    });
    assert.ok(preOrdered.sections[0].body.includes('\n\n[[TABLE_1]]\n\n'));
    assert.equal(preOrdered.figurePlacements.length, 0);
    assert.ok(!preOrdered.sections[0].body.includes('[[FIGURE_2]]'));
    assert.equal(preOrdered.tableBindings[1].sourceQuotes[0], sourceText);

    let thrownOrder = null;
    try {
        draftOrder.normalizeReaderDraftOrder(structuredClone(preOrdered), { structuredArtifacts: artifacts });
    } catch (error) {
        thrownOrder = error;
    }
    assert.ok(thrownOrder, '不可渲染完整原表应抛出阻塞异常');
    assert.equal(thrownOrder.code, 'READER_SOURCE_TABLE_UNRENDERABLE');
    assert.equal(thrownOrder.normalizationInputSha256, hashDraft(preOrdered));
    assert.equal(sourceBlocked.readSourceTableNormalizationError(thrownOrder, rawDraft, artifacts), null);
    assert.ok(sourceBlocked.readSourceTableNormalizationError(thrownOrder, preOrdered, artifacts));

    let thrownRecovery = null;
    try {
        deep.normalizeApiReaderRecoveryDraftForSource(structuredClone(preOrdered), [], {
            paperId: '2611.99907',
            sourceText,
            structuredArtifacts: artifacts,
            pixelFigureOrdinals: []
        });
    } catch (error) {
        thrownRecovery = error;
    }
    assert.ok(thrownRecovery, 'normalizeApiReaderRecoveryDraftForSource 应传播阻塞异常');
    assert.equal(thrownRecovery.code, 'READER_SOURCE_TABLE_UNRENDERABLE');
    assert.equal(thrownRecovery.normalizationInputSha256, hashDraft(preOrdered));
    assert.ok(
        sourceBlocked.readSourceTableNormalizationError(thrownRecovery, preOrdered, artifacts),
        '通过 normalizeApiReaderRecoveryDraftForSource 抛出的 blocked 异常必须与 preOrdered 精确对齐'
    );
});

test('B-H4 (R3): loadReaderRecoveryRevision 在省略 imageEvidence 且提供 normalizeReplayDraft 时遇不可渲染原表不失步', t => {
    const crypto = require('node:crypto');
    const Config = require('../scripts/config');
    const deep = require('../scripts/deep-analyzer');
    const sourceBlocked = require('../scripts/lib/reader-source-blocked-normalization');
    const { withFreshAnalysisContext } = require('../scripts/lib/fresh-analysis-context');
    const { loadReaderRecoveryRevision } = require('../scripts/lib/reader-recovery-revision');
    const { saveFailedCandidate } = require('../scripts/lib/reader-repair');

    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wave3-bh4-r3-'));
    const prevDir = Config.FILES.freshRewriteRunsDir;
    Config.FILES.freshRewriteRunsDir = root;
    t.after(() => {
        Config.FILES.freshRewriteRunsDir = prevDir;
        fs.rmSync(root, { recursive: true, force: true });
    });

    const runId = crypto.randomUUID();
    const runDir = path.join(root, runId);
    const paperId = '2611.99911';
    fs.mkdirSync(runDir, { mode: 0o700 });
    const sourceText = 'Our streaming encoder achieves low latency on TestClean.';
    const sourceSha = crypto.createHash('sha256').update(sourceText).digest('hex');
    const makeCells = rows => rows.flatMap((row, r) => row.map((text, c) => ({
        row: r, column: c, text, sourceDomSha256: `${r}${c}`.repeat(32)
    })));
    const badMatrix = [['Method', 'Score'], ['Ours', '\\unknowncmd{4.2}']];
    const artifacts = {
        tables: [{
            ordinal: 1,
            caption: 'Table 1: Unrenderable TeX',
            matrix: badMatrix,
            cells: makeCells(badMatrix),
            recoveryStatus: 'complete',
            sourceDomSha256: 'a'.repeat(64)
        }]
    };
    const sourceExpectations = { [paperId]: { sourceSha256: sourceSha, structuredArtifactsSha256: 'b'.repeat(64) } };
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
        version: 1, contract: 'fresh-rewrite-run-v1', runId, paperIds: [paperId], sourceExpectations
    }), { mode: 0o600 });

    const directory = path.join(runDir, 'reader-attempts');
    const oldIdentity = {
        paperId,
        freshAnalysis: { runId, paperId, ...sourceExpectations[paperId] },
        sourceSha256: sourceSha,
        inputFingerprint: 'same-input',
        model: { model: 'test-model', maxTokens: 48000 },
        promptSha256: 'p',
        repairPromptSha256: 'q',
        maxAttempts: 6,
        repairMaxTokens: 8000,
        repairImplementationSha256: 'c'.repeat(64)
    };
    const identity = {
        ...oldIdentity,
        repairImplementationSha256: 'd'.repeat(64),
        draftOrderContract: 'reader-draft-order-v1',
        draftOrderImplementationSha256: 'e'.repeat(64),
        sourceDiagnosticsImplementationSha256: 'f'.repeat(64),
        parserImplementationSha256: '1'.repeat(64),
        editorialImplementationSha256: '2'.repeat(64),
        mechanicalContractSha256: '3'.repeat(64)
    };
    const rawDraft = {
        ...require('../scripts/lib/protocol-codec').record('reader-draft'),
        readerTitle: '标题',
        oneSentenceThesis: '主旨',
        sections: [{
            kind: 'result',
            heading: '结果',
            body: '紧贴表格标记的说明。[[TABLE_1]]\n\n[[FIGURE_2]]\n\n表后解释。'
        }],
        conceptBridges: [],
        figurePlacements: [{
            figureOrdinal: 2,
            targetKind: 'result',
            marker: '[[FIGURE_2]]',
            focusPoints: ['核对指标变化与趋势']
        }],
        tableBindings: [{ tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } }],
        formulaBindings: []
    };
    // 刻意省略 imageEvidence（undefined），验证 loadReaderRecoveryRevision 按 [] 对齐 normalizeReplayDraft
    const payload = {
        status: 'failed',
        draft: rawDraft,
        rawDraft: JSON.stringify(rawDraft),
        issues: [{ path: null, message: 'old diagnostic' }],
        attempts: 2,
        fullAttempts: 1,
        transportFailures: 0,
        noProgress: 1,
        failureSignature: 'old-sig',
        validationFailureStreak: 1,
        validationFailureSignature: 'old-norm-sig'
    };

    const context = { runId, runDir, sourceExpectations, refreshReaderDiagnostics: true };
    const recovered = withFreshAnalysisContext(context, () => {
        saveFailedCandidate(directory, oldIdentity, payload);
        return loadReaderRecoveryRevision(directory, identity, {
            allowNewImplementationAllowance: false,
            sourceText,
            structuredArtifacts: artifacts,
            normalizeReplayDraft: (draft, issues, imageEvidence = []) => {
                try {
                    return deep.normalizeApiReaderRecoveryDraftForSource(structuredClone(draft), issues, {
                        paperId,
                        sourceText,
                        structuredArtifacts: artifacts,
                        pixelFigureOrdinals: imageEvidence.filter(i => i?.kind === 'figure').map(i => i.ordinal)
                    });
                } catch (error) {
                    const blocked = sourceBlocked.readSourceTableNormalizationError(error, draft, artifacts);
                    if (!blocked) throw error;
                    return blocked;
                }
            }
        });
    });
    assert.ok(recovered, '应成功加载并归一化阻塞来源表候选');
    assert.equal(recovered.draft.figurePlacements.length, 0, '缺失 imageEvidence 时仍须先剥离不可用图');
    assert.ok(recovered.blockedSourceTableNormalization, '应完整记录 blockedSourceTableNormalization');

    const rrSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/reader-recovery-revision.js'), 'utf8');
    assert.match(rrSrc, /const sourceQuoteMarkerRepair = deepAnalyzer\.normalizeReaderSourceQuoteTableMarkers\(updated\.draft\);/);
});

test('B-H5: 核心摘要数值溯源覆盖连字符/单位区间、LaTeX/重复 p 值、长表/底注表及 batch size 旁路防卫', () => {
    const { validateCoreSummarySemanticContract } = require('../scripts/analysis-contract');
    const summaryHeader = require('../scripts/lib/core-summary-format').currentHeader();
    const { validAnalysisText } = require('./valid-analysis-fixture');
    const baseline = validAnalysisText();
    const replaceSummary = body => baseline.replace(
        /## 核心摘要\n[\s\S]*?(?=\n## 方法概述和架构)/,
        `## 核心摘要\n${body}\n`
    );
    const makeExecutiveSummary = expSentence => [
        '**问题与瓶颈：** 现有流式语音识别系统在严格低延迟约束下难以维持稳定的声学上下文连贯性。固定短窗口切分在跨帧边界处截断长程声学依赖，使模型在高噪声与强混响条件下频繁出现声母混淆。传统离线整句编码器虽能利用全局上下文，但其等待整段话音结束的缓冲机制无法满足实时语音交互需求。如何在受限前向视窗内同时保住频谱细节与跨块语义连贯，成为流式语音建模的核心瓶颈。',
        '**核心思路与方法架构：** 本文提出一种带缓存门控的流式双路编码解码框架。前端模块将输入波形转换为帧级梅尔频谱特征，并送入因果深度可分离卷积编码器提取局部声学表征。随后，跨块注意力记忆模块通过可学习门控向量将当前块特征与历史压缩状态融合，避免直接拼接全历史序列带来的二次复杂度膨胀。最终，轻量化预测网络与联合层逐帧输出字符后验概率，整个推理路径严格保持单向因果依赖且无需整句回看。',
        `**关键实验与核心代价：** ${expSentence} 进一步消融实验表明，移除跨块记忆门控后系统在噪声子集上的错词率明显回升，证实状态融合机制是主要收益来源。在工程开销方面，该架构需常驻固定大小的缓存状态显存，并在每帧前向步引入额外的门控投影运算。虽然实时率仍满足常规边缘计算需求，但在内存高度紧张的微控制器上仍需权衡缓存容量与解码吞吐。`,
        '**适用边界与深读导览：** 上述结论主要在英文干净及近场语音评测协议下得到验证。远场多说话人严重重叠、极低信噪比以及跨语种低资源场景尚未纳入系统测试，且本文未与超大参数离线模型做等算力对照。工程团队若准备迁移到真实会议拾音设备，仍需补测麦克风阵列前端失配的影响。读者若希望深入核对门控状态更新方程、各子模块消融明细与部署时延剖面，可继续阅读下方方法架构与实验结果章节。'
    ].join('\n\n');

    const source = [
        'Table 1: Main Results in WER (%) on TestClean:',
        'Baseline achieves 10 and Ours achieves 5 with statistical significance (p < 0.05).',
        'Our audio runs at 2.4 GHz and 16 kHz with latency between 8 and 12 ms.'
    ].join('\n');

    // 1. 合法 % 表格整数 5% 不被 p < 0.05 误杀
    assert.equal(
        validateCoreSummarySemanticContract(
            replaceSummary(makeExecutiveSummary('在 TestClean 评测集上，本文方法词错误率 WER 降至 5%，明显低于强基线的 10%，且运行于 16 kHz 与 2.4 GHz 硬件环境，推理时延处于 8-12 ms 区间。')),
            { sourceText: source, summaryHeader }
        ),
        null
    );

    // 2. 底注表 + LaTeX p \leq 0.05 仍允许合法 5%
    const bottomCaptionSource = [
        'On TestClean benchmark, Baseline achieves 10 WER and Ours achieves 5 WER (evaluated in %, prior baseline 12.4%).',
        'Table 1: Main Results in WER (%) on TestClean.',
        'Significance holds with p \\leq 0.05.'
    ].join('\n');
    assert.equal(
        validateCoreSummarySemanticContract(
            replaceSummary(makeExecutiveSummary('在 TestClean 评测集上，本文方法词错误率 WER 降至 5%，低于基线的 10%。')),
            { sourceText: bottomCaptionSource, summaryHeader }
        ),
        null
    );

    // 3. >600 字符长表 + LaTeXML 重复 p<0.05p<0.05 仍允许合法 5%
    const longTableSource = [
        'Table 1: WER (%) on TestClean:',
        'MethodX 12.4 13.5 14.6 15.7 16.8\n'.repeat(25),
        'Ours 5, Baseline 10. Statistical test shows p<0.05p<0.05.'
    ].join('\n');
    assert.equal(
        validateCoreSummarySemanticContract(
            replaceSummary(makeExecutiveSummary('在 TestClean 评测集上，本文方法词错误率 WER 为 5%，优于基线的 10%。')),
            { sourceText: longTableSource, summaryHeader }
        ),
        null
    );

    // 4. 连字符区间右端点（8-12.5、5-15%、16kHz-48.5kHz）编造全部拦截
    assert.match(
        validateCoreSummarySemanticContract(
            replaceSummary(makeExecutiveSummary('在 TestClean 评测集上，本文方法词错误率 WER 为 5%，优于基线 10%，实测延迟位于 8-12.5 ms 区间。')),
            { sourceText: source, summaryHeader }
        ) || '',
        /12\.5.*未在原文中以相同精度出现/
    );
    assert.match(
        validateCoreSummarySemanticContract(
            replaceSummary(makeExecutiveSummary('在 TestClean 评测集上，本文方法词错误率 WER 处于 5-15% 区间，低于基线 10%。')),
            { sourceText: source, summaryHeader }
        ) || '',
        /15%.*未在原文中以相同精度出现/
    );
    assert.match(
        validateCoreSummarySemanticContract(
            replaceSummary(makeExecutiveSummary('在 TestClean 评测集上，本文方法词错误率 WER 为 5%，低于基线 10%，支持 16kHz-48.5kHz 采样率。')),
            { sourceText: source, summaryHeader }
        ) || '',
        /48\.5.*未在原文中以相同精度出现/
    );

    // 5. 大小写单位与 GHz（如 3.6 GHz / 48 khz）必须拦截
    assert.match(
        validateCoreSummarySemanticContract(
            replaceSummary(makeExecutiveSummary('在 TestClean 评测集上，本文方法词错误率 WER 为 5%，低于基线 10%，并运行于 3.6 GHz 平台。')),
            { sourceText: source, summaryHeader }
        ) || '',
        /3\.6.*未在原文中以相同精度出现/
    );
    assert.match(
        validateCoreSummarySemanticContract(
            replaceSummary(makeExecutiveSummary('在 TestClean 评测集上，本文方法词错误率 WER 为 5%，低于基线 10%，采样率为 48 khz。')),
            { sourceText: source, summaryHeader }
        ) || '',
        /48.*未在原文中以相同精度出现/
    );

    // 6. 单位小数误转百分数（85 epochs 或 batch size 85 + F1 = 0.85 -> 85%）必须拒绝
    for (const scaledSource of [
        'Table 1: WER (%): Baseline 12.3, Ours 10.1. We train for 85 epochs and obtain F1 = 0.85.',
        'Table 1: WER (%): Baseline 12.3, Ours 10.1. We use batch size 85 and obtain F1 = 0.85.'
    ]) {
        assert.match(
            validateCoreSummarySemanticContract(
                replaceSummary(makeExecutiveSummary('在公开测试集上，本文方法 WER 从 12.3% 降至 10.1%，且 F1 达到 85%。')),
                { sourceText: scaledSource, summaryHeader }
            ) || '',
            /85%.*添加了原文不存在的百分号/
        );
    }
});

test('B-M1: 围栏代码块内 ### 标题（LF/CRLF 与制表符缩进）不影响表格评述节号与签名稿逆向重建', () => {
    const { findMisalignedTableCommentaryIssues } = require('../scripts/analysis-contract');
    const lines = [
        '### 第一节',
        '',
        '```markdown',
        '### 围栏里的假标题',
        '',
        '代码块内容',
        '```',
        '',
        '| AlphaMetric | BetaMetric |',
        '| --- | --- |',
        '| AlphaSys | 12.3 |',
        '| AlphaBase | 15.1 |',
        '',
        '本表首句显示 GammaSys 的 GammaMetric 达到 99.1，高于 DeltaBase 的 81.2，体现跨领域优势。',
        '',
        '### 第二节',
        '',
        '| GammaMetric | DeltaMetric |',
        '| --- | --- |',
        '| GammaSys | 99.1 |',
        '| DeltaBase | 81.2 |',
        '',
        '本表首句显示 AlphaSys 的 AlphaMetric 为 12.3，优于 AlphaBase 的 15.1，体现低错词优势。'
    ];
    for (const sep of ['\n', '\r\n']) {
        const issues = findMisalignedTableCommentaryIssues(lines.join(sep));
        assert.equal(issues.length, 2, `应检出两处错位评述（sep=${JSON.stringify(sep)}）`);
        assert.equal(issues[0].sectionIndex, 0, `表 1 应属于第 0 节（sep=${JSON.stringify(sep)}）`);
        assert.equal(issues[1].sectionIndex, 1, `表 2 应属于第 1 节（sep=${JSON.stringify(sep)}）`);
    }

    const { reconstructReaderDraftSurface } = require('../scripts/lib/reader-signed-draft-surface');
    const readerFormat = require('../scripts/lib/reader-record-format');
    const planHeader = readerFormat.compiledPlanHeader({
        current: true,
        profile: readerFormat.INTEGRATED,
        editorialProfile: readerFormat.COHESIVE_V4
    });
    const bodyWithFence = '正文示例：\n\n```markdown\n### 围栏内伪标题\n\n伪正文\n```\n\n正文结束。';
    const article = `### 真实小节一\n\n${bodyWithFence}\n\n### 真实小节二\n\n第二节正文。`;
    const paper = {
        apiReaderArticle: article,
        apiReaderFigures: [],
        apiReaderPlan: {
            ...planHeader,
            readerTitle: '标题',
            oneSentenceThesis: '主旨',
            sections: [
                { kind: 'problem', heading: '真实小节一' },
                { kind: 'result', heading: '真实小节二' }
            ],
            conceptBridges: [],
            figurePlacements: [],
            formulaBindings: [],
            tableBindings: []
        }
    };
    const reconstructed = reconstructReaderDraftSurface({ paper, paperId: '2611.99903' });
    assert.equal(reconstructed.draft.sections.length, 2);
    assert.equal(reconstructed.draft.sections[0].body, bodyWithFence);
    assert.equal(reconstructed.draft.sections[1].body, '第二节正文。');
});

test('B-M2: runFailureRounds 第 2 轮未捕获异常清除旧 outcomes，且未启动项不混入当轮 failedIds', async () => {
    const { runFailureRounds } = require('../scripts/lib/analysis-failure-rounds');
    let err = null;
    try {
        await runFailureRounds([{ id: 'p1' }, { id: 'p2' }], {
            maxRounds: 2,
            concurrency: 1,
            getItemId: item => item.id,
            runItem: async (item, { round }) => {
                if (round === 1) {
                    return { success: false, retryable: true, error: `${item.id} 临时错误` };
                }
                if (item.id === 'p1') throw new Error('第 2 轮意外崩溃');
                return { success: true };
            }
        });
    } catch (caught) {
        err = caught;
    }
    assert.ok(err, '应抛出第 2 轮未捕获异常');
    assert.deepEqual(err.unfinishedIds, ['p1']);
    assert.deepEqual(err.failedIds, ['p2']);
    assert.equal(err.outcomes[0], undefined);
    assert.deepEqual(err.rounds[1].unstartedIds, ['p2']);
    assert.deepEqual(err.rounds[1].failedIds, []);
    assert.deepEqual(err.rounds[1].retryableFailedIds, []);
});

test('B-M3: 西里尔乱码检测覆盖拉丁词、中文句号、ASCII !/? 旁路，且 sourceText 仅按整词豁免', () => {
    const { findCyrillicProseGarbleIssues } = require('../scripts/analysis-contract');
    assert.equal(findCyrillicProseGarbleIssues('模型在训练时使用了 LSTM сбалансированный 模块。').length, 1);
    assert.equal(findCyrillicProseGarbleIssues('方法对 WER показатели 进行评估。').length, 1);
    assert.equal(findCyrillicProseGarbleIssues('性能提升明显。показатели。').length, 1);
    assert.equal(findCyrillicProseGarbleIssues('模型表现很好。Note! показатели? 后续继续分析。').length, 1);
    assert.equal(
        findCyrillicProseGarbleIssues('收敛速度 бы 很快。', { sourceText: 'original term субъективный in paper' }).length,
        1
    );
    assert.equal(
        findCyrillicProseGarbleIssues('标注使用了 субъективный 词形。', { sourceText: 'original term субъективный in paper' }).length,
        0
    );
    assert.equal(
        findCyrillicProseGarbleIssues('Марков, Колмогоров (1950).\n本文在此离散状态转移假设上进一步引入声学观测先验。').length,
        0
    );
});

test('F-P0-4, F-P1-6, F-P1-7: v4 缺节修复保护唯一 problem，focusPoints 用 6–120 门槛，事实快修透传 editorialProfile', () => {
    const { buildRepairTargets, collectReaderLanguageIssues } = require('../scripts/lib/reader-repair');
    const draftHeader = require('../scripts/lib/protocol-codec').record('reader-draft');

    const v4MissingMethod = {
        ...draftHeader,
        readerTitle: '标题',
        oneSentenceThesis: '主旨',
        sections: [
            { kind: 'problem', heading: '问题本质：核心卡点', body: '问题描述正文。'.repeat(10) },
            { kind: 'result', heading: '主实验验证：核心对比', body: '实验结果正文。'.repeat(10) },
            { kind: 'limitation', heading: '局限收束：边界条件', body: '局限讨论正文。'.repeat(10) }
        ],
        conceptBridges: [],
        figurePlacements: [],
        tableBindings: [],
        formulaBindings: []
    };
    const missingTargets = buildRepairTargets(v4MissingMethod, [{
        code: 'reader_missing_required_kinds',
        missingKinds: ['method_overview'],
        message: '读者文章缺少教学阶段: method_overview'
    }]);
    assert.deepEqual(missingTargets, [], '唯一必需节 problem 绝不可作为替代目标');

    const v4BadFocus = {
        ...draftHeader,
        readerTitle: '标题',
        oneSentenceThesis: '主旨',
        sections: [
            {
                kind: 'result',
                heading: '主实验验证：曲线趋势',
                body: `${'图前自然导读说明实验横纵轴与评测条件。'.repeat(2)}\n\n[[FIGURE_1]]\n\n${'图后详细结合曲线趋势和坐标轴解释该方法相较基线的优势与代价。'.repeat(2)}`
            }
        ],
        conceptBridges: [],
        figurePlacements: [{
            figureOrdinal: 1,
            targetKind: 'result',
            marker: '[[FIGURE_1]]',
            focusPoints: ['太短']
        }],
        tableBindings: [],
        formulaBindings: []
    };
    const focusTargets = buildRepairTargets(v4BadFocus, [{
        path: null,
        message: '读者文章 figurePlacements[0]（Figure 1）图片的插入位置、相邻导读与解释段，或观察点不符合要求（focusPoints[0]=2字，须为6–120字）'
    }], { availableFigureOrdinals: [1] });
    assert.equal(focusTargets.length, 1);
    assert.equal(focusTargets[0].path, '/figurePlacements/0');
    assert.match(focusTargets[0].repairInstruction, /6–120字符/);

    const claim = '这张图确实可见基线词错率为 12.3%。';
    const v4FactDraft = {
        ...draftHeader,
        readerTitle: '标题',
        oneSentenceThesis: '主旨',
        sections: [{
            kind: 'result',
            heading: '主实验验证：对比分析',
            body: `第一句正常描述实验条件。${claim}第三句总结工程权衡。`
        }],
        conceptBridges: [],
        figurePlacements: [],
        tableBindings: [],
        formulaBindings: []
    };
    const langIssues = collectReaderLanguageIssues(v4FactDraft);
    assert.ok(langIssues.length >= 1, 'v4 应检出“这张图确实可见”语言告警');
    const factTargets = buildRepairTargets(v4FactDraft, [
        ...langIssues,
        { code: 'reader_verified_fact_claim', path: '/sections/0/body', claim, message: '事实错误' }
    ], {
        readerFactLocalPaths: ['/sections/0/body'],
        readerFactLocalClaims: [claim]
    });
    assert.equal(factTargets.length, 1);
    assert.equal(factTargets[0].path, '/sections/0/body');
});

test('F-P1-8: scoring-audit-contract 先校验 ablationStatus 合法枚举再归约，合法值仍归约为 not_applicable', () => {
    const { parseScoringAuditResult } = require('../scripts/lib/scoring-audit-contract');
    const header = require('../scripts/lib/scoring-record-format').currentEvidenceProfileHeader();
    const makeAudit = ablationStatus => ({
        documentType: '理论研究',
        confidence: '高',
        dimensions: {
            innovation: { score: 1.5, reason: '提出清晰的理论界限与严格可验证的证明框架，问题抽象具有代表性 [E1]。' },
            technicalRigor: { score: 1.4, reason: '定理前提条件、收敛假设与推导步骤完整严密，未见明显逻辑漏洞 [E1]。' },
            experimentalSufficiency: { score: 1.0, reason: '受控仿真实验覆盖核心理论预测与关键假设边界，验证较充分 [E1]。' },
            clarity: { score: 0.8, reason: '符号定义前后一致、章节层次清楚，核心推导易于跟随理解 [E1]。' },
            impact: { score: 1.0, reason: '为后续信号处理与音频建模分析提供可复用的理论界限工具 [E1]。' },
            openSource: { score: 0.0, reason: '理论研究论文未发布可执行代码仓库、模型权重或公开数据集 [E1]。' },
            reproducibility: { score: 0.4, reason: '公式推导与证明过程完整可逐步核对，便于同行复现验证 [E1]。' },
            engineering: { score: 0.8, reason: '提供可直接指导系统参数选择的推导边界与定量设计准则 [E1]。' }
        },
        evidenceProfile: {
            ...header,
            multiComponentClaimed: false,
            ablationStatus,
            targetEvaluation: 'not_applicable',
            sampleScaleReported: false,
            deploymentMeasured: false,
            engineeringEvidence: 'not_applicable',
            publicGeneralizationEvaluated: false,
            evidenceBoundary: '本结论基于理论假设 [E1] 在高斯噪声条件下成立。',
            evidenceIds: ['E1']
        }
    });

    assert.throws(
        () => parseScoringAuditResult(JSON.stringify(makeAudit('bogus_invalid_value')), new Set(['E1'])),
        /ablationStatus 非法/
    );
    const coerced = parseScoringAuditResult(JSON.stringify(makeAudit('direct')), new Set(['E1']));
    assert.equal(coerced.evidenceProfile.ablationStatus, 'not_applicable');
});

test('F-P1-10: methodRepair 剥离 ## 方法概述和架构 标题后再做 600 中文字符检查', () => {
    const { normalizeSectionContent } = require('../scripts/lib/public-resource-probe');
    const { validateMethodDetailContract } = require('../scripts/analysis-contract');
    const countChineseChars = text => (String(text || '').match(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g) || []).length;
    const para = '该模块接收输入声学特征并经由网络结构输出中间表征，整个流程清晰明确，涵盖组件参数衔接与变换细节。'.repeat(4);
    const tail = '第三阶段进一步完成解码重建与后处理校正流程，确保整体系统输出稳定可靠且满足既定声学保真目标与实时约束。'.repeat(2);
    let trimmedBody = `${para}\n\n${para}\n\n${tail.repeat(3)}`;
    while (countChineseChars(trimmedBody) > 596) trimmedBody = trimmedBody.slice(0, -1);
    const bodyCount = countChineseChars(trimmedBody);
    assert.equal(bodyCount, 596, `期望正文恰好 596 字，实际 ${bodyCount}`);
    const withHeading = `## 方法概述和架构\n\n${trimmedBody}`;
    assert.ok(countChineseChars(withHeading) >= 600, '带标题字数应 >= 600 以复现旧缺陷');
    const normalized = normalizeSectionContent('方法概述和架构', withHeading);
    assert.equal(countChineseChars(normalized), 596);
    assert.match(validateMethodDetailContract(`## 方法概述和架构\n${normalized}\n\n## 核心创新点\n创新`) || '', /600/);
    const deepSrc = fs.readFileSync(path.join(ROOT, 'scripts/deep-analyzer.js'), 'utf8');
    assert.match(
        deepSrc,
        /const normalizedFixedSection = normalizeSectionContent\('方法概述和架构', fixedSection\);\s*if \(!normalizedFixedSection \|\| !isMethodSectionDetailed\(normalizedFixedSection\)\)/
    );
});

test('F-P0-1 & F-P1-8/9/10 & F-P3-17: 7 份提示词契约对齐检查', () => {
    const readPrompt = name => fs.readFileSync(path.join(ROOT, 'prompts/current', name), 'utf8');
    const readerPrompt = readPrompt('api-reader-article.md');
    assert.equal((readerPrompt.match(/\{mechanicalContract\}/g) || []).length, 1, 'api-reader-article.md 不得重复包含 {mechanicalContract}');
    assert.match(readerPrompt, /`focusPoints` 可输出 `\[\]` 或 2–4 个针对这张图的简短观察要点（每项 6–120 字）/);

    const scoringPrompt = readPrompt('scoring-audit.md');
    assert.match(scoringPrompt, /总分不得超过 9\.0/);
    assert.match(scoringPrompt, /总分不得超过 8\.5/);
    assert.match(scoringPrompt, /至少 20 个字符/);

    for (const file of ['deep-analysis.md', 'gap-fill.md', 'tag-repair.md']) {
        assert.match(readPrompt(file), /最多 3 个/, `${file} 必须声明任务标签最多 3 个`);
    }
    assert.match(readPrompt('method-fill.md'), /至少分成 3 个由空行分隔的实质自然段/);
    assert.match(readPrompt('api-reader-fact-local.md'), /行内反引号 ` 或加粗标记 \*\* \/ __/);
});

test('B-C2 & B-H3: 三处恢复/冷核入口均动态计算 minimumIntegratedTables，不硬编码 2', () => {
    for (const rel of [
        'scripts/lib/daily-reader-signed-correction.js',
        'scripts/lib/daily-reader-operator-correction.js',
        'scripts/lib/reader-completed-source-recovery.js'
    ]) {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        assert.doesNotMatch(src, /minimumIntegratedTables\s*:\s*2\b/, `${rel} 不得硬编码 minimumIntegratedTables: 2`);
        assert.match(src, /readerRequirements\(/, `${rel} 须通过 readerRequirements 动态计算表下限`);
    }
    const recoverySrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/reader-completed-source-recovery.js'), 'utf8');
    assert.match(recoverySrc, /replayVerifiedReaderResourceIdentity\(/);
    assert.match(recoverySrc, /buildRepairContext\(payload\.draft,\s*issues,\s*evidence,\s*source\.text,\s*\{[\s\S]*availableFigureOrdinals/);
    const signedSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/daily-reader-signed-correction.js'), 'utf8');
    assert.match(signedSrc, /options\.normalizeCurrentBatchRoot/);
});

test('F-P2-16: repairCoreSummarySection 旧核心摘要模式加载历史旧提示词，不与 v4 700–1400 规格冲突', async () => {
    const { repairCoreSummarySection } = require('../scripts/deep-analyzer');
    const { validAnalysisText } = require('./valid-analysis-fixture');
    const paper = { arxivId: '2611.99904', title: 'Legacy Summary Prompt Test' };
    const baseline = validAnalysisText();
    const analysis = baseline.replace(/## 核心摘要\n[\s\S]*?(?=\n## 方法概述和架构)/, '## 核心摘要\n摘要待修复。\n');
    const sourceText = 'Experiment results on the public test set report baseline WER 12.4% and our method WER 9.8%.';
    const seenPrompts = [];
    await assert.rejects(
        () => repairCoreSummarySection(paper, analysis, sourceText, sourceText, {
            callModelFn: async messages => {
                seenPrompts.push(messages[0].content);
                return '## 核心摘要\n还是太短。';
            }
        })
    );
    assert.ok(seenPrompts.length >= 1);
    assert.match(seenPrompts[0], /320–600/);
    assert.doesNotMatch(seenPrompts[0], /700–1400/);
});

test('saved-fact-feedback: 强制重分析已完成新 scoringAudit 时忽略原旧 apiReaderArticle 遗留 factReview 证明', () => {
    const crypto = require('node:crypto');
    const saved = require('../scripts/lib/saved-fact-feedback');
    const sha = s => crypto.createHash('sha256').update(s).digest('hex');
    const oldAnalysis = '旧分析正文（6.4 分）';
    const newScoring = '强制重分析新评分正文（8.0 分）';
    const oldProof = {
        contract: 'daily-bound-fact-review-v1',
        paperId: '2611.26409',
        coreAnalysisSha256: sha(oldAnalysis),
        feedbackSha256: 'a'.repeat(64)
    };
    const reanalyzedPaper = {
        arxivId: '2611.26409v1',
        analysis: oldAnalysis,
        analysisStageCheckpoints: { scoringAudit: newScoring },
        analysisManifest: {
            stages: {
                primaryAnalysis: { status: 'complete' },
                scoringAudit: { status: 'complete' },
                apiReaderArticle: { status: 'complete', factReview: oldProof }
            }
        }
    };
    assert.equal(saved.hasSavedProof(reanalyzedPaper), false, '被新 scoringAudit 替代的旧 Reader factReview 不得阻断重分析尾修');

    // 负例 1：scoringAudit 仍对应同一旧正文时必须保留证明
    const sameParent = structuredClone(reanalyzedPaper);
    sameParent.analysisStageCheckpoints.scoringAudit = oldAnalysis;
    assert.equal(saved.hasSavedProof(sameParent), true);

    // 负例 2：上游阶段带有 factReview 或存在待完成 obligation 时必须保留证明
    const upstreamFact = structuredClone(reanalyzedPaper);
    upstreamFact.analysisManifest.stages.primaryAnalysis.factReview = oldProof;
    assert.equal(saved.hasSavedProof(upstreamFact), true);
    const withObligation = structuredClone(reanalyzedPaper);
    withObligation.analysisFactReviewObligation = { feedbackSha256: 'b'.repeat(64) };
    assert.equal(saved.hasSavedProof(withObligation), true);
});
