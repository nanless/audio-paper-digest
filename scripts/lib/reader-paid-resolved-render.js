'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const child = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const paidFigureScope = new (require('node:async_hooks').AsyncLocalStorage)();
const paidRenderScope = new (require('node:async_hooks').AsyncLocalStorage)();
const OLD_RENDERER_COMMIT = 'e2a275a87ee1c277e69d0be2d0978c53e00d4ede';
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

function legacyCodeFiles(legacyDirectory, repositoryRoot) {
    const repo = repositoryRoot || path.resolve(__dirname, '../..');
    const names = child.execFileSync('git', ['ls-tree', '-r', '--name-only', OLD_RENDERER_COMMIT,
        'scripts', 'manual', 'config', 'prompts'], { cwd: repo, encoding: 'utf8' }).trim().split('\n');
    const selected = names.filter(name => /\.(js|json|md)$/.test(name));
    const objects = child.execFileSync('git', ['cat-file', '--batch'], { cwd: repo,
        input: selected.map(name => `${OLD_RENDERER_COMMIT}:${name}\n`).join(''), maxBuffer: 64 * 1024 * 1024 });
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

function replayLegacyReader(legacyDirectory, input, repositoryRoot) {
    const files = legacyCodeFiles(legacyDirectory, repositoryRoot);
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

module.exports = { CONTRACT, OLD_RENDERER_COMMIT, readResolvedFile, validatePaidResolvedInput,
    replayLegacyReader, assertOriginalRendering, copyUnchangedSignedFigures, reuseVerifiedPaidResolvedFigures,
    assertPaidResolvedRenderSnapshot, parseOptions, rerenderPaidResolvedReader };
