'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const child = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const paidFigureScope = new (require('node:async_hooks').AsyncLocalStorage)();
const paidRenderScope = new (require('node:async_hooks').AsyncLocalStorage)();
const OLD_RENDERER_COMMIT = 'e2a275a87ee1c277e69d0be2d0978c53e00d4ede';
const CURRENT_SIGNED_RENDERER_COMMIT = '314aa43c282db28ce2465edcffd76b41936df9dd';
const CONTRACT = 'reader-paid-resolved-render-v1';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hash = value => require('./reader-repair').hashDraft(value);
const stable = value => sha(JSON.stringify((function order(item) {
    if (Array.isArray(item)) return item.map(order);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, order(item[key])]));
})(value)));
const fail = message => { throw new Error(`原付费 Reader 重渲染拒绝：${message}`); };
const statFields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink'];
const sameStat = (a, b) => statFields.every(key => a[key] === b[key]);

function readResolvedFile(directory, filename, expectedSha) {
    require('./fresh-rewrite-run').assertSafeDirectory(directory);
    if (!/^[a-f0-9]{64}$/.test(expectedSha || '')
        || path.dirname(path.resolve(filename)) !== path.resolve(directory)) fail('须显式指定本运行目录内的档案及完整 SHA');
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const before = fs.fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o777n) !== 0o600n
            || before.size > 32n * 1024n * 1024n) fail('档案类型、权限或大小不合法');
        const bytes = fs.readFileSync(fd);
        if (sha(bytes) !== expectedSha) fail('原档案字节改变');
        const envelope = JSON.parse(bytes.toString('utf8'));
        const identitySha = hash(envelope.identity);
        if (!new RegExp(`^${identitySha}\\.[a-f0-9-]{36}\\.resolved\\.json$`).test(path.basename(filename))
            || envelope.version !== require('./reader-repair').REPAIR_VERSION
            || envelope.payloadSha256 !== hash(envelope.payload)) fail('档案名称、版本或内容证明不一致');
        if (!sameStat(before, fs.fstatSync(fd, { bigint: true }))
            || !sameStat(before, fs.lstatSync(filename, { bigint: true }))) fail('读取时档案发生变化');
        return { envelope, identitySha, assertUnchanged() {
            const named = fs.lstatSync(filename, { bigint: true });
            if (!sameStat(before, named) || sha(fs.readFileSync(filename)) !== expectedSha) fail('保存前原档案发生变化');
        } };
    } finally { fs.closeSync(fd); }
}

function validatePaidResolvedInput(paper, source, checked, expectedPaperSha) {
    const { identity, payload } = checked.envelope;
    const stage = paper.analysisManifest?.stages?.apiReaderArticle;
    if (!/^[a-f0-9]{64}$/.test(expectedPaperSha || '') || stable(paper) !== expectedPaperSha) fail('当前论文与独审快照不同');
    if (!stage || stage.status !== 'complete' || payload.status !== 'failed'
        || payload.attempts !== 1 || payload.fullAttempts !== 1
        || (payload.transportFailures || 0) !== 0 || payload.noProgress !== 0
        || (payload.validationFailureStreak || 0) !== 0
        || payload.explicitReaderRetryRound || payload.implementationRepairAllowanceProof
        || payload.implementationRepairAllowanceLineage || payload.consumedImplementationAllowanceSha256
        || payload.readerRecoveryRevisions?.length) fail('只支持原始单次完整初稿，不接受附加授权或迁移链');
    if (identity.contentMode !== 'reader-source-only-v1'
        || identity.paperId.replace(/v\d+$/, '') !== String(paper.arxivId).replace(/v\d+$/, '')
        || identity.sourceSha256 !== sha(source.text)
        || paper.sourceSha256 !== identity.sourceSha256
        || identity.freshAnalysis?.sourceSha256 !== identity.sourceSha256
        || stage.sourceBindingsSourceTextSha256 !== identity.sourceSha256
        || stage.structuredArtifactsSha256 !== source.structuredArtifacts?.payloadSha256) fail('论文及封存来源绑定不一致');
    const model = identity.model;
    if (model?.model !== 'muse-spark-1.3-contributor' || model.protocol !== 'openai_responses'
        || model.endpoint !== 'https://opencode.ai/zen/go/v1') fail('不是本入口支持的原 Muse 1.3 Responses 请求');
    if (identity.promptSha256 !== 'b4f0b864fd338cc3a58a2e061ec952947a6faa4a09971167d6daa7add9ebbd9f'
        || identity.repairPromptSha256 !== 'd3fa5851973b36e0944a9abf13f719aa34b1782f784ee086e6e637deea8979c2'
        || stage.promptTextContract !== 'analysis-prompt-text-v7'
        || stage.repairPromptTextContract !== 'analysis-prompt-text-v11') fail('不是固定原 Git 版本实际使用的提示词组合');
    for (const [key, expected] of Object.entries({ model: model?.model, protocol: model?.protocol,
        temperature: model?.temperature, maxTokens: model?.maxTokens, maxResponseBytes: model?.maxResponseBytes,
        promptTemplateSha256: identity.promptSha256, repairPromptTemplateSha256: identity.repairPromptSha256,
        repairMaxTokens: identity.repairMaxTokens, repairTemperature: identity.repairTemperature, attempts: 1 })) {
        if (expected === undefined || !isDeepStrictEqual(stage[key], expected)) fail(`原请求 ${key} 与当前阶段不一致`);
    }
    if (typeof payload.rawDraft !== 'string' || !payload.rawDraft.trim()
        || !isDeepStrictEqual(JSON.parse(payload.rawDraft), payload.draft)) fail('原始响应与已保存初稿不一致');
    if (!Array.isArray(payload.imageEvidence)
        || stable(payload.imageEvidence) !== stage.imageEvidenceSha256
        || payload.imageEvidence.length !== stage.imageEvidenceCount
        || hash(payload.ephemeralImageEvidence) !== stage.modelImagePreflightEvidenceSha256) fail('原像素请求证明不一致');
    const images = payload.imageEvidence;
    const figures = paper.apiReaderFigures;
    if (!Array.isArray(figures) || figures.length !== images.length
        || images.some(image => image.status !== 'ready' || !/^[a-f0-9]{64}$/.test(image.modelPayloadSha256 || '')
            || !figures.some(figure => figure.ordinal === image.ordinal && figure.url === image.url
                && figure.assetSha256 === image.sha256 && image.sourceSha256 === image.sha256))) fail('原像素与已完成论文图不能逐项对应');
    return structuredClone(payload);
}

function legacyCodeFiles(legacyDirectory, repositoryRoot, rendererCommit = OLD_RENDERER_COMMIT) {
    const repo = repositoryRoot || path.resolve(__dirname, '../..');
    const names = child.execFileSync('git', ['ls-tree', '-r', '--name-only', rendererCommit,
        'scripts', 'manual', 'config', 'prompts'], { cwd: repo, encoding: 'utf8' }).trim().split('\n');
    const selected = names.filter(name => /\.(js|json|md)$/.test(name));
    const objects = child.execFileSync('git', ['cat-file', '--batch'], { cwd: repo,
        input: selected.map(name => `${rendererCommit}:${name}\n`).join(''), maxBuffer: 64 * 1024 * 1024 });
    let offset = 0;
    return selected.map(name => {
        const end = objects.indexOf(10, offset);
        const header = objects.subarray(offset, end).toString('utf8').split(' ');
        if (header[1] !== 'blob' || !/^\d+$/.test(header[2])) fail('无法读取固定 Git 渲染器');
        const size = Number(header[2]);
        const expected = objects.subarray(end + 1, end + 1 + size);
        offset = end + 2 + size;
        const filename = path.join(legacyDirectory, name);
        if (!fs.lstatSync(filename).isFile() || sha(fs.readFileSync(filename)) !== sha(expected)) fail(`原 Git 渲染代码改变：${name}`);
        return { filename, sha256: sha(expected) };
    });
}

function assertOriginalRendering(paper, original) {
    if (original.modelRequests !== 0 || original.articleSha256 !== paper.apiReaderArticleSha256
        || original.planSha256 !== paper.apiReaderPlanSha256) fail('原渲染器无法将原响应准确重放到当前文章与计划');
}

function copyUnchangedSignedFigures(figures, oldFigures) {
    const assetFields = new Set(['cachePath', 'assetFilename', 'assetMediaType', 'assetSha256', 'assetBytes',
        'assetWidth', 'assetHeight', 'rawBytes']);
    const content = figure => Object.fromEntries(Object.entries(figure).filter(([key]) => !assetFields.has(key)));
    if (!Array.isArray(figures) || !Array.isArray(oldFigures) || figures.length !== oldFigures.length
        || figures.some((figure, index) => !isDeepStrictEqual(content(figure), content(oldFigures[index])))) {
        fail('重渲染改变了原论文图说明、位置、顺序或来源，不得复用原像素证明');
    }
    return structuredClone(oldFigures);
}

// 普通生成和 operator 无法打开此范围；只由本文件已经完整核验的入口开启。
function reuseVerifiedPaidResolvedFigures(figures, paper) {
    const scope = paidFigureScope.getStore();
    if (!scope) return null;
    if (stable(paper) !== scope.paperSha256) fail('纯重渲染图复用的父论文已变化');
    return copyUnchangedSignedFigures(figures, scope.figures);
}

function assertPaidResolvedRenderSnapshot() {
    const scope = paidRenderScope.getStore();
    if (!scope) return;
    for (const check of scope.assertions) check();
}

function replayLegacyReader(legacyDirectory, input, repositoryRoot, rendererCommit = OLD_RENDERER_COMMIT) {
    if (![OLD_RENDERER_COMMIT, CURRENT_SIGNED_RENDERER_COMMIT].includes(rendererCommit)) fail('未知原渲染器');
    const files = legacyCodeFiles(legacyDirectory, repositoryRoot, rendererCommit);
    const output = child.execFileSync(process.execPath, [path.join(__dirname, 'reader-paid-resolved-replay-worker.js'), legacyDirectory], {
        input: JSON.stringify({ ...input, files }), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_SANDBOX: process.env.CODEX_SANDBOX || '' }
    });
    const marker = 'PAID_REPLAY_RESULT=';
    const index = output.lastIndexOf(marker);
    if (index < 0) fail('原渲染子进程没有完整结果');
    const result = JSON.parse(output.slice(index + marker.length).trim());
    Object.defineProperty(result, 'assertUnchanged', { value() {
        for (const file of files) {
            if (!fs.lstatSync(file.filename).isFile() || sha(fs.readFileSync(file.filename)) !== file.sha256) {
                fail('保存前原 Git 渲染代码发生变化');
            }
        }
    } });
    return result;
}

function parseOptions(paper, source) {
    const availableFigureOrdinals = paper.apiReaderFigures.map(figure => figure.ordinal);
    return { arxivId: paper.arxivId, requiredVersion: 3, requireSourceBindings: true,
        requireIntegratedTables: true, allowDeterministicQuoteRepair: true,
        allowDeterministicUnsupportedClaimPruning: true,
        sourceText: source.text, structuredArtifacts: source.structuredArtifacts, availableFigureOrdinals };
}

async function rerenderPaidResolvedReader(paperId, options) {
    if (!options || typeof options.legacyDirectory !== 'string') fail('须提供已冻结原 Git 渲染代码');
    const deep = require('../deep-analyzer');
    const engine = require('../analysis-engine');
    const daily = require('./daily-fresh-source-plan');
    const facts = require('./daily-fact-review');
    const refresh = require('../refresh-api-reader');
    const feedback = options.feedbackFile ? facts.readFeedback(options.feedbackFile) : null;
    return paidRenderScope.run({ assertions: [] }, () => refresh.refreshApiReader(paperId, { operations: { article: async (paper, source) => {
        if (!engine.hasValidApiReaderV3Records(paper)) fail('当前 Reader 不是完整来源签名记录');
        const context = require('./fresh-analysis-context').getFreshAnalysisContext();
        if (!context?.runDir) fail('不在正常日更封存来源范围');
        const directory = path.join(context.runDir, 'reader-attempts');
        require('./fresh-analysis-context').freshReaderAttemptsDirectory(directory);
        const checked = readResolvedFile(directory, options.resolvedFile, options.expectedEnvelopeSha256);
        paidRenderScope.getStore().assertions.push(checked.assertUnchanged);
        const payload = validatePaidResolvedInput(paper, source, checked, options.expectedPaperSha256);
        if (!isDeepStrictEqual(checked.envelope.identity.freshAnalysis,
            require('./fresh-analysis-context').freshAnalysisIdentity(paper.arxivId))) fail('当前四份来源身份漂移');
        const original = replayLegacyReader(options.legacyDirectory, { paper, source,
            rawDraft: payload.rawDraft, parseOptions: parseOptions(paper, source) }, options.originalRepositoryRoot);
        assertOriginalRendering(paper, original);
        paidRenderScope.getStore().assertions.push(original.assertUnchanged);
        const old = structuredClone(paper);
        const parse = async () => {
            const parsed = deep.parseApiReaderArticleResult(payload.rawDraft, parseOptions(paper, source));
            checked.assertUnchanged();
            const stage = structuredClone(old.analysisManifest.stages.apiReaderArticle);
            const updated = await paidFigureScope.run({ paperSha256: stable(old), figures: old.apiReaderFigures },
                () => deep.finalizeApiReaderRefresh(paper, source, { ...parsed,
                imageEvidence: payload.imageEvidence,
                modelImagePreflightEvidenceSha256: hash(payload.ephemeralImageEvidence),
                providerImageExclusions: payload.providerImageExclusions || [] }, {
                readerResources: old.apiReaderResources,
                execution: { ...stage, paidResolvedRender: { contract: CONTRACT, originalRendererCommit: OLD_RENDERER_COMMIT,
                    originalIdentitySha256: checked.identitySha, originalEnvelopeSha256: options.expectedEnvelopeSha256,
                    originalRawDraftSha256: sha(payload.rawDraft), originalArticleSha256: original.articleSha256,
                    originalPlanSha256: original.planSha256, originalAttempts: 1, originalFullAttempts: 1,
                    newModelRequests: 0, rendererImplementationSha256: sha(fs.readFileSync(require.resolve('../deep-analyzer'))),
                    editorialImplementationSha256: sha(fs.readFileSync(require.resolve('../editorial-quality'))),
                    replayWorkerImplementationSha256: sha(fs.readFileSync(path.join(__dirname, 'reader-paid-resolved-replay-worker.js'))),
                    entryImplementationSha256: sha(fs.readFileSync(__filename)) } }
            }));
            for (const key of ['analysis', 'parsed', 'apiReaderResources', 'apiReaderAuthors']) {
                if (!isDeepStrictEqual(updated[key], old[key])) fail(`正常收尾改变了原 ${key}`);
            }
            const allowedFields = new Set(['apiReaderArticle', 'apiReaderArticleSha256', 'apiReaderPlan',
                'apiReaderPlanSha256', 'apiReaderFigures', 'apiReaderAuthors', 'apiReaderResources', 'analysisManifest']);
            for (const key of new Set([...Object.keys(old), ...Object.keys(updated)])) {
                if (!allowedFields.has(key) && (Object.hasOwn(old, key) !== Object.hasOwn(updated, key)
                    || !isDeepStrictEqual(old[key], updated[key]))) fail(`重渲染改动了非 Reader 论文字段 ${key}`);
            }
            const otherStages = stages => Object.fromEntries(Object.entries(stages).filter(([name]) => name !== 'apiReaderArticle'));
            const oldManifest = { ...old.analysisManifest, stages: otherStages(old.analysisManifest.stages) };
            const newManifest = { ...updated.analysisManifest, stages: otherStages(updated.analysisManifest.stages) };
            if (!isDeepStrictEqual(newManifest, oldManifest)
                || !isDeepStrictEqual(updated.apiReaderFigures.map(f => ({ ordinal: f.ordinal, url: f.url, sha: f.assetSha256 })),
                    old.apiReaderFigures.map(f => ({ ordinal: f.ordinal, url: f.url, sha: f.assetSha256 })))
                || !engine.hasValidApiReaderV3Records(updated)) fail('评分或原像素身份改变，或重渲染未通过完整签名验证');
            for (const key of ['error', 'latestAnalysisAttemptError', 'latestAnalysisAttemptAt',
                'latestAnalysisAttemptErrorCode', 'latestAnalysisAttemptRetryable', 'analysisCheckpoint',
                'analysisStageCheckpoints', 'analysisStaleSnapshots']) {
                if (!isDeepStrictEqual(updated[key], old[key])) fail(`重渲染改变了原失败状态或恢复记录 ${key}`);
            }
            checked.assertUnchanged();
            return updated;
        };
        if (old.analysisManifest.stages.apiReaderArticle.factReview) {
            if (!feedback) fail('原阶段有事实反馈，必须提供同一原反馈并重新验收');
            const data = engine.readJsonFileStrict(require('../config').FILES.deepAnalysisResult);
            const plan = daily.requireDailyFreshSourceRecoveryPlan(data);
            const bound = facts.validateFeedback(feedback, plan, old);
            if (!isDeepStrictEqual(bound.proof, old.analysisManifest.stages.apiReaderArticle.factReview)) fail('反馈不对应原付费阶段');
            return facts.withFactReview(bound, parse);
        }
        if (feedback) fail('不能向无原反馈的重渲染稿新增修订范围');
        return parse();
    } } }));
}

// This separate entry replays only the currently signed, single-response
// revision whose original producer is exactly reproduced below. It never
// moves a retired envelope back into the active candidate namespace.
function validateCurrentSignedPaidResolvedInput(paper, source, checked, options) {
    const { parent, feedback, request, accepted, expectedPaperSha256, requestWindow } = options;
    const { identity, payload } = checked.envelope;
    const stage = paper.analysisManifest?.stages?.apiReaderArticle;
    if (!/^[a-f0-9]{64}$/.test(expectedPaperSha256 || '') || stable(paper) !== expectedPaperSha256
        || !stage || stage.status !== 'complete' || stage.paidCurrentSignedRender
        || identity.contentMode !== 'reader-source-signed-revision-v1'
        || identity.paperId !== paper.arxivId || checked.identitySha !== hash(identity)
        || checked.envelope.payloadSha256 !== hash(payload)
        || payload.status !== 'failed' || payload.attempts !== 1 || payload.fullAttempts !== 1
        || payload.noProgress !== 0 || (payload.transportFailures || 0) !== 0
        || !Array.isArray(payload.issues) || payload.issues.length
        || payload.failureSignature !== '' || payload.validationFailureSignature !== ''
        || (payload.validationFailureStreak || 0) !== 0
        || payload.explicitReaderRetryRound || payload.implementationRepairAllowanceProof
        || payload.implementationRepairAllowanceLineage || payload.consumedImplementationAllowanceSha256
        || payload.readerRecoveryRevisions?.length) fail('当前签名稿或唯一原始付费候选不符合纯重渲染范围');
    if (!parent || parent.arxivId !== paper.arxivId || !feedback || feedback.paperId !== paper.arxivId
        || typeof feedback.reviewFeedback !== 'string' || !feedback.reviewFeedback.trim()
        || feedback.reviewFeedback.length > 4000
        || feedback.parentArticleSha256 !== parent.apiReaderArticleSha256
        || feedback.parentPlanSha256 !== parent.apiReaderPlanSha256
        || sha(feedback.reviewFeedback.trim()) !== stage.reviewFeedbackSha256
        || stage.revisionSeedArticleSha256 !== parent.apiReaderArticleSha256
        || stage.revisionSeedPlanSha256 !== parent.apiReaderPlanSha256
        || stage.contentMode !== identity.contentMode
        || !/^[a-f0-9]{64}$/.test(stage.fingerprint || '')
        || !/^[a-f0-9]{64}$/.test(identity.inputFingerprint || '')
        || stage.signedRevisionDisplayContract !== identity.signedRevisionDisplayContract
        || stage.signedRevisionDisplaySha256 !== identity.signedRevisionDisplaySha256)
        fail('当前签名阶段、真实父稿、反馈或原输入身份不同');
    if (sha(source.text) !== paper.sourceSha256 || identity.sourceSha256 !== paper.sourceSha256
        || stage.sourceBindingsSourceTextSha256 !== paper.sourceSha256
        || stage.structuredArtifactsSha256 !== source.structuredArtifacts?.payloadSha256
        || identity.freshAnalysis?.sourceSha256 !== paper.sourceSha256)
        fail('原来源或当前来源身份不同');
    const deep = require('../deep-analyzer');
    const seed = deep.prepareApiReaderRevisionSeed(parent, source.text, feedback.reviewFeedback);
    if (!seed || Object.entries(seed.metadata).some(([key, value]) => !isDeepStrictEqual(stage[key], value)))
        fail('当前原阶段不能重放原完整签名父稿 seed');
    const model = identity.model;
    if (model?.model !== 'muse-spark-1.3-contributor' || model.protocol !== 'openai_responses'
        || model.endpoint !== 'https://opencode.ai/zen/go/v1') fail('不是当前入口支持的原模型路线');
    for (const [key, value] of Object.entries({ model: model.model, protocol: model.protocol,
        temperature: model.temperature, maxTokens: model.maxTokens, maxResponseBytes: model.maxResponseBytes,
        repairTemperature: identity.repairTemperature, repairMaxTokens: identity.repairMaxTokens,
        promptTemplateSha256: identity.promptSha256, repairPromptTemplateSha256: identity.repairPromptSha256,
        attempts: payload.attempts, fullAttempts: payload.fullAttempts })) {
        if (value === undefined || !isDeepStrictEqual(stage[key], value)) fail(`当前原阶段 ${key} 不同`);
    }
    if (typeof payload.rawDraft !== 'string' || !isDeepStrictEqual(JSON.parse(payload.rawDraft), payload.draft)
        || stable(payload.imageEvidence) !== stage.imageEvidenceSha256
        || payload.imageEvidence.length !== stage.imageEvidenceCount
        || hash(payload.ephemeralImageEvidence) !== stage.modelImagePreflightEvidenceSha256
        || stable(payload.providerImageExclusions || []) !== stage.providerImageExclusionSha256)
        fail('已接受规范化稿或原请求图片证据不同');
    if (!request || !accepted || !requestWindow || !Number.isFinite(Date.parse(requestWindow.startedAt))
        || !Number.isFinite(Date.parse(requestWindow.finishedAt))
        || !(Date.parse(requestWindow.startedAt) <= Date.parse(request.at))
        || !(Date.parse(accepted.at) <= Date.parse(requestWindow.finishedAt))
        || request.version !== 'llm-usage-v1' || request.kind !== 'request'
        || accepted.version !== 'llm-usage-v1' || accepted.kind !== 'disposition'
        || request.stage !== 'apiReaderArticle' || accepted.stage !== request.stage
        || request.paperId !== paper.arxivId || accepted.paperId !== paper.arxivId
        || request.runId !== identity.freshAnalysis?.runId || accepted.runId !== request.runId
        || request.contentAttempt !== 1 || accepted.contentAttempt !== 1
        || request.transportAttempt !== 1 || request.transportStarted !== true
        || request.statusCode !== 200 || request.outcome !== 'completed'
        || request.protocol !== model.protocol || request.model !== model.model
        || !/^[a-f0-9]{64}$/.test(request.inputSha256 || '')
        || !/^[a-f0-9]{64}$/.test(request.outputTextSha256 || '')
        || accepted.outputTextSha256 !== request.outputTextSha256 || accepted.disposition !== 'accepted'
        || request.usage?.status !== 'reported' || !Number.isSafeInteger(request.usage.totalTokens)
        || request.usage.totalTokens <= 0 || !(Date.parse(request.at) <= Date.parse(accepted.at))
        || !(Date.parse(accepted.at) <= Date.parse(stage.refreshedAt)))
        fail('原真实请求、接受记录及已付用量不闭合');
    for (const key of ['analysis', 'parsed', 'sourceSha256', 'usedTextSha256', 'apiReaderResources', 'apiReaderAuthors']) {
        if (!isDeepStrictEqual(parent[key], paper[key])) fail(`修订后原上游 ${key} 变化`);
    }
    const withoutReader = stages => Object.fromEntries(Object.entries(stages).filter(([key]) => key !== 'apiReaderArticle'));
    if (!isDeepStrictEqual(withoutReader(parent.analysisManifest.stages), withoutReader(paper.analysisManifest.stages)))
        fail('修订后其他原阶段变化');
    return structuredClone(payload);
}

function assertCurrentSignedTableOnlyChange(old, updated) {
    const extract = require('../analysis-contract').extractMarkdownTables;
    const stripTables = article => {
        let result = article;
        const tables = extract(article);
        for (const [index, table] of tables.entries()) {
            if (result.split(table.markdown).length !== 2) fail('原表不是唯一完整 Markdown 块');
            result = result.replace(table.markdown, `[[PAID_TABLE_${index}]]`);
        }
        return { result, count: tables.length };
    };
    const before = stripTables(old.apiReaderArticle), after = stripTables(updated.apiReaderArticle);
    if (before.count !== after.count || before.result !== after.result || before.count < 1)
        fail('纯表重渲染改变了表外正文或表数量');
    const planBody = plan => Object.fromEntries(Object.entries(plan)
        .filter(([key]) => !['tableBindings', 'sourceBindingsSha256'].includes(key)));
    if (!isDeepStrictEqual(planBody(old.apiReaderPlan), planBody(updated.apiReaderPlan)))
        fail('纯表重渲染改变了原计划非表字段');
    const permitted = new Set(['apiReaderArticle', 'apiReaderArticleSha256', 'apiReaderPlan',
        'apiReaderPlanSha256', 'analysisManifest']);
    for (const key of new Set([...Object.keys(old), ...Object.keys(updated)])) {
        if (!permitted.has(key) && (Object.hasOwn(old, key) !== Object.hasOwn(updated, key)
            || !isDeepStrictEqual(old[key], updated[key]))) fail(`纯表重渲染改变了原 ${key}`);
    }
    const manifest = value => ({ ...value, stages: Object.fromEntries(Object.entries(value.stages)
        .filter(([key]) => key !== 'apiReaderArticle')) });
    if (!isDeepStrictEqual(manifest(old.analysisManifest), manifest(updated.analysisManifest)))
        fail('纯表重渲染改变了原其他阶段或来源');
    const a = old.analysisManifest.stages.apiReaderArticle, b = updated.analysisManifest.stages.apiReaderArticle;
    const changed = new Set(['articleSha256', 'planSha256', 'sourceBindingsSha256', 'qualityMetrics',
        'refreshedAt', 'paidCurrentSignedRender']);
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!changed.has(key) && (Object.hasOwn(a, key) !== Object.hasOwn(b, key)
            || !isDeepStrictEqual(a[key], b[key]))) fail(`纯表重渲染改变了原阶段 ${key}`);
    }
}

async function currentSignedPaidResolvedRender(paperId, options, previewOnly) {
    require('../env-loader').requireExternalRuntime('current-signed-paid-reader-render');
    require('../workspace-role').requireWorkspaceRole('daily');
    const deep = require('../deep-analyzer'), engine = require('../analysis-engine');
    const fresh = require('./fresh-analysis-context');
    const implementationFiles = [__filename, require.resolve('../deep-analyzer')].map(file => ({ file, sha256: sha(fs.readFileSync(file)) }));
    const checkedFiles = [() => { for (const item of implementationFiles) {
        if (sha(fs.readFileSync(item.file)) !== item.sha256) fail('保存前当前纯渲染实现变化');
    } }];
    const pinned = (file, expectedSha) => { const value = readPinnedCurrentRenderJson(file, expectedSha);
        checkedFiles.push(value.assertUnchanged); return value.value; };
    const dispatch = pinned(options.dispatchFile, options.dispatchFileSha256);
    if (dispatch.contract !== 'normal-reader-review-tail-cli-dispatch-v1' || !dispatch.finishedAt
        || dispatch.codeHead !== '088bf924c7294f84eaa4e8d010b4d42284b1e4da')
        fail('不是本入口支持的原正常派发记录');
    const feedbackMap = pinned(dispatch.feedbackFile, dispatch.feedbackFileSha256);
    const parents = pinned(dispatch.formalBeforeFile, dispatch.formalBeforeSha256);
    const parent = parents.papers?.filter(p => p.arxivId === paperId);
    const feedback = feedbackMap.members?.filter(p => p.paperId === paperId);
    const dispatched = dispatch.members?.filter(p => p.paperId === paperId);
    if (feedbackMap.contract !== 'daily-blog-review-reader-feedback-map-v1'
        || parent?.length !== 1 || feedback?.length !== 1 || dispatched?.length !== 1
        || dispatched[0].feedbackSha256 !== sha(feedback[0].reviewFeedback)) fail('原派发父稿和反馈成员不是唯一');
    const request = pinned(options.requestUsageFile, options.requestUsageSha256);
    const accepted = pinned(options.acceptedUsageFile, options.acceptedUsageSha256);
    const usageDirectory = path.resolve(require('../config').FILES.llmUsageDir);
    if ([options.requestUsageFile, options.acceptedUsageFile].some(file => path.dirname(path.resolve(file)) !== usageDirectory))
        fail('须读取正常实际用量目录中的原记录');
    let previewResult = null;
    const previewStop = new Error('只读纯重渲染预检已结束，不保存正式稿');
    try {
        return await paidRenderScope.run({ assertions: checkedFiles }, () => require('../refresh-api-reader').refreshApiReader(paperId, {
            operations: { article: async (paper, source) => require('./analysis-stop-control').withModelRequestsForbidden(async () => {
                if (!engine.hasValidApiReaderV3Records(paper)) fail('当前 Reader 完整来源签名无效');
                const context = fresh.getFreshAnalysisContext();
                if (!context?.runDir) fail('须在正常当前四源作用域和论文锁内');
                const directory = fresh.freshReaderAttemptsDirectory(path.join(context.runDir, 'reader-attempts'));
                const checked = readResolvedFile(directory, options.resolvedFile, options.expectedEnvelopeSha256);
                checkedFiles.push(checked.assertUnchanged);
                const stage = paper.analysisManifest.stages.apiReaderArticle;
                const matching = fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.[a-f0-9-]{36}\.resolved\.json$/.test(name))
                    .filter(name => {
                        const value = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
                        return value.identity?.paperId === paperId
                            && value.identity?.contentMode === stage.contentMode
                            && value.identity?.sourceSha256 === stage.sourceBindingsSourceTextSha256
                            && value.identity?.signedRevisionDisplayContract === stage.signedRevisionDisplayContract
                            && value.identity?.signedRevisionDisplaySha256 === stage.signedRevisionDisplaySha256;
                    });
                if (matching.length !== 1 || matching[0] !== path.basename(options.resolvedFile)
                    || !isDeepStrictEqual(checked.envelope.identity.freshAnalysis, fresh.freshAnalysisIdentity(paperId)))
                    fail('当前完整阶段不对应唯一最新实际退休付费稿');
                const payload = validateCurrentSignedPaidResolvedInput(paper, source, checked, {
                    parent: parent[0], feedback: feedback[0], request, accepted,
                    expectedPaperSha256: options.expectedPaperSha256,
                    requestWindow: { startedAt: dispatched[0].startedAt, finishedAt: dispatched[0].finishedAt } });
                const original = replayLegacyReader(options.legacyDirectory, { paper, source, rawDraft: payload.rawDraft,
                    parseOptions: parseOptions(paper, source) }, options.originalRepositoryRoot, CURRENT_SIGNED_RENDERER_COMMIT);
                assertOriginalRendering(paper, original);
                checkedFiles.push(original.assertUnchanged);
                const old = structuredClone(paper), originalStage = structuredClone(stage);
                const parsed = deep.parseApiReaderArticleResult(payload.rawDraft, parseOptions(paper, source));
                const updated = await paidFigureScope.run({ paperSha256: stable(old), figures: old.apiReaderFigures },
                    () => deep.finalizeApiReaderRefresh(paper, source, { ...parsed, imageEvidence: payload.imageEvidence,
                        modelImagePreflightEvidenceSha256: hash(payload.ephemeralImageEvidence),
                        providerImageExclusions: payload.providerImageExclusions || [] }, {
                        preserveReaderUpstream: true, readerAuthors: old.apiReaderAuthors, readerResources: old.apiReaderResources,
                        execution: { ...originalStage, paidCurrentSignedRender: {
                            contract: 'reader-current-signed-paid-render-v1', originalRendererCommit: CURRENT_SIGNED_RENDERER_COMMIT,
                            originalIdentitySha256: checked.identitySha, originalEnvelopeFile: options.resolvedFile,
                            originalEnvelopeSha256: options.expectedEnvelopeSha256, originalNormalizedDraftSha256: sha(payload.rawDraft),
                            originalArticleSha256: old.apiReaderArticleSha256, originalPlanSha256: old.apiReaderPlanSha256,
                            dispatchFileSha256: options.dispatchFileSha256, requestUsageSha256: options.requestUsageSha256,
                            acceptedUsageSha256: options.acceptedUsageSha256, requestEventId: request.eventId,
                            originalStageFingerprint: originalStage.fingerprint, originalCandidateInputFingerprint: checked.envelope.identity.inputFingerprint,
                            originalDispatchStartedAt: dispatched[0].startedAt, originalDispatchFinishedAt: dispatched[0].finishedAt,
                            originalInputSha256: request.inputSha256, originalOutputTextSha256: request.outputTextSha256,
                            rawHttpResponseSeparatelyArchived: false, newModelRequests: 0,
                            originalAttempts: payload.attempts, originalFullAttempts: payload.fullAttempts,
                            rendererImplementationSha256: sha(fs.readFileSync(require.resolve('../deep-analyzer'))),
                            entryImplementationSha256: sha(fs.readFileSync(__filename)) } } }));
                assertCurrentSignedTableOnlyChange(old, updated);
                if (!engine.hasValidApiReaderV3Records(updated)) fail('新正常整篇来源签名无效');
                for (const check of checkedFiles) check();
                const reread = fresh.readFreshSource(context.runDir, paperId, context);
                if (sha(reread.text) !== sha(source.text)
                    || !isDeepStrictEqual(reread.structuredArtifacts, source.structuredArtifacts)) fail('纯渲染期间四源变化');
                if (previewOnly) { previewResult = updated; throw previewStop; }
                return updated;
            }) }
        }));
    } catch (error) { if (previewOnly && error === previewStop && previewResult) return previewResult; throw error; }
}

function readPinnedCurrentRenderJson(file, expectedSha) {
    if (!path.isAbsolute(file || '') || path.resolve(file) !== file
        || !file.startsWith(path.resolve(__dirname, '../../data/runtime') + path.sep)
        || fs.realpathSync(file) !== file) fail('原材料须为当前 runtime 内真实绝对路径');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fs.fstatSync(fd, { bigint: true }), raw = fs.readFileSync(fd);
        if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o777n) !== 0o600n
            || stat.size > 64n * 1024n * 1024n || !/^[a-f0-9]{64}$/.test(expectedSha || '')
            || sha(raw) !== expectedSha || !sameStat(stat, fs.fstatSync(fd, { bigint: true }))
            || !sameStat(stat, fs.lstatSync(file, { bigint: true }))) fail('原材料字节、类型或权限不同');
        return { value: JSON.parse(raw), assertUnchanged() {
            if (!sameStat(stat, fs.lstatSync(file, { bigint: true })) || sha(fs.readFileSync(file)) !== expectedSha)
                fail('保存前原材料变化');
        } };
    } finally { fs.closeSync(fd); }
}
const rerenderCurrentSignedPaidResolvedReader = (paperId, options) => currentSignedPaidResolvedRender(paperId, options, false);
const previewCurrentSignedPaidResolvedReader = (paperId, options) => currentSignedPaidResolvedRender(paperId, options, true);

module.exports = { CONTRACT, OLD_RENDERER_COMMIT, CURRENT_SIGNED_RENDERER_COMMIT,
    validateCurrentSignedPaidResolvedInput, assertCurrentSignedTableOnlyChange,
    rerenderCurrentSignedPaidResolvedReader, previewCurrentSignedPaidResolvedReader, readResolvedFile, validatePaidResolvedInput,
    replayLegacyReader, assertOriginalRendering, copyUnchangedSignedFigures, reuseVerifiedPaidResolvedFigures,
    assertPaidResolvedRenderSnapshot, parseOptions, rerenderPaidResolvedReader };
