'use strict';

// 统一管理新获取的官方会议论文。论文只有完成分析凭证核验、生成页面清单，
// 并将两份记录写入进程检查点后，才算完成；不再分别运行彼此独立的分析入口。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const recovery = require('./conference-process-recovery.js');
const { writeImmutableFile } = require('./immutable-file.js');
const promptTextVersions = require('./prompt-text-versions.js');

const CONTRACT = 'conference-process-v2';
const PROCESS_OPERATION_LOCK_HELD = Symbol('conference-process-operation-lock-held');
const LEGACY_CONTRACT = 'conference-process-v1';
const COMPLETION_CONTRACT = 'conference-process-completion-receipt-v2';
const LEGACY_COMPLETION_CONTRACT = 'conference-process-completion-receipt-v1';
const PROCESS_VERSION = 2;
const COMPLETION_VERSION = 2;
const LEGACY_VERSION = 1;
const TAG_REVIEW_QUEUE_CONTRACT = 'conference-tag-review-queue-v2';
const TAG_REVIEW_QUEUE_FILE = 'tag-review-queue.json';
const TAG_REVIEW_QUEUE_VERSION = 2;
// 旧队列仅用于读取已有报告路径；当前写入始终使用新文件名。
const LEGACY_TAG_REVIEW_QUEUE_FILE = 'taxonomy-review-queue.json';
const DEEP_EXECUTION_CONFIG_CONTRACT = 'conference-deep-execution-config-v1';
const VERSION = PROCESS_VERSION;
const DEEP_EXECUTION_CONFIG_VERSION = 1;
const MAX_CONCURRENCY = 5;
const DEEP_EXECUTION_LIMIT_FIELDS = Object.freeze([
    'apiOverallTimeoutMs',
    'apiReaderOverallTimeoutMs',
    'apiMaxRetries',
    'apiRetryBaseDelayMs',
    'apiMaxTokens',
    'apiMaxResponseBytes',
    'repairMaxTokens',
    'apiReaderMaxTokens',
    'apiReaderRepairMaxTokens',
    'apiTemperature',
    'scoringAuditTemperature',
    'imagePlanTemperature',
    'imageDownloadTimeoutMs',
    'imageMaxBytes',
    'imageMaxBase64Chars',
    'imageTotalBase64Chars',
    'imageMaxCount',
    'imageCandidateMax',
    'imageInsertionMax',
    'fullTextMaxChars',
    'openSourceEvidenceMaxChars',
    'revisionEvidenceMaxChars',
    'apiReaderEvidenceMaxChars',
    'apiReaderContextMaxChars',
    'scoringEvidenceMaxChars',
    'repairEvidenceMaxChars',
    'structureEvidenceMaxChars',
    'fullTextMinCharsForFull'
]);
const DEEP_EXECUTION_TEMPERATURE_FIELDS = new Set([
    'apiTemperature', 'scoringAuditTemperature', 'imagePlanTemperature'
]);
const IMPLEMENTATION_FILES = Object.freeze([
    'prompts/api-reader-article.md',
    'prompts/api-reader-repair.md',
    'prompts/core-summary-repair.md',
    'prompts/deep-analysis.md',
    'prompts/gap-fill.md',
    'prompts/image-supplement.md',
    'prompts/method-fill.md',
    'prompts/opensource-scan.md',
    'prompts/scoring-audit.md',
    'prompts/structure-repair.md',
    'prompts/table-fill.md',
    'prompts/tag-repair.md',
    'scripts/analysis-contract.js',
    'scripts/analysis_sections.py',
    'scripts/tag_stage_record.py',
    'scripts/analysis-engine.js',
    'scripts/conference-page-render.py',
    'scripts/conference_extractor.py',
    'scripts/config.js',
    'scripts/deep-analyzer.js',
    'scripts/editorial-quality.js',
    'scripts/env-loader.js',
    'scripts/lib/conference-analysis-adapter.js',
    'scripts/lib/analysis-section-titles.js',
    'scripts/lib/tag-stage-record.js',
    'scripts/lib/conference-analysis-context.js',
    'scripts/lib/conference-postprocess.js',
    'scripts/lib/conference-process.js',
    'scripts/lib/conference-process-recovery.js',
    'scripts/lib/conference-source-upgrade.js',
    'scripts/lib/conference-staging.js',
    'scripts/lib/paper-identity.js',
    'scripts/lib/reader-contract.js',
    'scripts/lib/reader-draft-order.js',
    'scripts/lib/reader-recovery-revision.js',
    'scripts/lib/reader-repair.js',
    'scripts/lib/reader-resource-binding.js',
    'scripts/lib/reader-resource-sync.js',
    'scripts/lib/reader-source-diagnostics.js',
    'scripts/lib/reader-tables.js',
    'scripts/lib/tag-catalog-change.js',
    'scripts/llm-account-pool.js',
    'scripts/publish_common.py',
    'scripts/paper_identity.py',
    'scripts/utils.js',
    'scripts/utils.py'
]);
// 提示词版本映射本身决定「哈希哪份提示词」，所以它必须留在被哈希的集合里。
// 只有当前版本清单收录它；v1 冻结清单保持原样，旧记录仍按当时那份清单复算。
const PROMPT_TEXT_VERSIONS_FILE = 'scripts/lib/prompt-text-versions.js';
const IMPLEMENTATION_PROMPT_TEXT_VERSIONS = Object.freeze(['v1', 'current']);
// 来源核验的一组文件：ledger、离线导入、抽取回执、PDF 描述和来源上下文。
// 它们的字节决定来源是否被正确核验，所以当前指纹必须收录；否则改来源核验逻辑不会
// 换指纹，同一代际的旧来源、ledger 和导入凭证会被接着复用。
// 它们不是提示词文本，v1 冻结清单当初也没有收录，加进去会让旧记录的指纹再也
// 复算不出来，所以只进当前清单，v1 清单保持原样。
const SOURCE_VERIFICATION_FILES = Object.freeze([
    'scripts/lib/conference-source-context.js',
    'scripts/lib/conference-source-ledger.js',
    'scripts/lib/conference-extraction-receipt.js',
    'scripts/lib/conference-pdf-source.js',
    'scripts/lib/conference-importer.js'
]);
// 当前实现清单：把已迁移到 v2 的提示词换成 -v2 路径，其余保持冻结路径。
// 提示词正文本身仍在清单里，所以改正文或改版本映射都会改变指纹。
function currentImplementationFiles() {
    const files = IMPLEMENTATION_FILES.map(name => {
        const stage = promptTextVersions.stageForFrozenPromptPath(name);
        return stage ? promptTextVersions.currentOrFrozenPromptPath(stage) : name;
    });
    files.push(PROMPT_TEXT_VERSIONS_FILE);
    files.push('scripts/lib/prompt-rendering-contract.js');
    files.push('scripts/lib/immutable-file.js');
    files.push('scripts/lib/model-text-sanitization.js');
    files.push(...SOURCE_VERIFICATION_FILES);
    return files;
}
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
function sortJsonKeys(value) {
    if (Array.isArray(value)) return value.map(sortJsonKeys);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortJsonKeys(value[key])]));
    return value;
}
const stableHash = value => sha256(JSON.stringify(sortJsonKeys(value)));
const canonicalBytes = value => Buffer.from(`${JSON.stringify(sortJsonKeys(value), null, 2)}\n`);

function exactKeys(value, expected, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) {
        throw new Error(`${label} has unknown or missing fields`);
    }
    return value;
}
function normalizedModel(value, label) {
    const raw = String(value || ''); const model = raw.trim();
    if (!model || raw !== model || model.length > 256 || /[\u0000-\u001f\u007f]/u.test(model)) {
        throw new Error(`${label} must be a non-empty bounded model name`);
    }
    return model;
}
function endpointAudit(endpoint, model, utilsApi) {
    const rawEndpoint = String(endpoint || ''); const normalizedEndpoint = rawEndpoint.trim();
    if (!normalizedEndpoint || rawEndpoint !== normalizedEndpoint) {
        throw new Error('deep execution endpoint must be a non-empty canonical URL string');
    }
    const protocol = utilsApi.detectApiType(normalizedEndpoint, model);
    const apiUrl = new URL(utilsApi.buildApiUrl(protocol, normalizedEndpoint)).href;
    return { model, protocol, endpointIdentitySha256: sha256(Buffer.from(apiUrl, 'utf8')) };
}
function assertDeepExecutionLimit(field, value) {
    const valid = DEEP_EXECUTION_TEMPERATURE_FIELDS.has(field)
        ? Number.isFinite(value) && value >= 0 && value <= 1
        : Number.isSafeInteger(value) && value > 0;
    if (!valid) throw new Error(`deep execution config ${field} is invalid`);
    return value;
}
function deepExecutionConfigIdentity(options = {}) {
    const env = options.env || process.env;
    const analysisConfig = options.analysisConfig;
    const secondaryModelConfig = options.secondaryModelConfig || {};
    const utilsApi = options.utilsApi || require('../utils.js');
    if (!analysisConfig || typeof analysisConfig !== 'object' || Array.isArray(analysisConfig)) {
        throw new Error('deep execution config requires ANALYSIS_CONFIG');
    }
    const primaryModel = normalizedModel(env.PAPER_ANALYZER_MODEL, 'primary model');
    const primaryEndpoint = String(env.PAPER_ANALYZER_ENDPOINT || '');
    const primary = endpointAudit(primaryEndpoint, primaryModel, utilsApi);
    const secondaryModelRaw = String(secondaryModelConfig.model || '');
    const secondary = secondaryModelRaw
        ? endpointAudit(String(secondaryModelConfig.endpoint || primaryEndpoint),
            normalizedModel(secondaryModelRaw, 'secondary model'), utilsApi)
        : null;
    const reasoning = String(env.PD_OPENAI_RESPONSES_REASONING_EFFORT || '').trim().toLowerCase();
    const responses = {
        reasoningEffort: ['low', 'medium', 'high'].includes(reasoning) ? reasoning : null,
        stream: ['1', 'true', 'yes', 'on'].includes(
            String(env.PD_OPENAI_RESPONSES_STREAM || '').trim().toLowerCase()
        )
    };
    const limits = {};
    for (const field of DEEP_EXECUTION_LIMIT_FIELDS) {
        limits[field] = assertDeepExecutionLimit(field, analysisConfig[field]);
    }
    const audit = { primary, secondary, responses, limits };
    const body = { contract: DEEP_EXECUTION_CONFIG_CONTRACT,
        version: DEEP_EXECUTION_CONFIG_VERSION, audit };
    return { ...body, identitySha256: stableHash(body) };
}
function assertDeepExecutionConfigIdentity(value) {
    exactKeys(value, ['contract', 'version', 'audit', 'identitySha256'], 'deep execution config identity');
    if (value.contract !== DEEP_EXECUTION_CONFIG_CONTRACT || value.version !== DEEP_EXECUTION_CONFIG_VERSION) {
        throw new Error('deep execution config identity contract is unsupported');
    }
    exactKeys(value.audit, ['primary', 'secondary', 'responses', 'limits'], 'deep execution config audit');
    for (const [label, route] of [['primary', value.audit.primary], ['secondary', value.audit.secondary]]) {
        if (route === null && label === 'secondary') continue;
        exactKeys(route, ['model', 'protocol', 'endpointIdentitySha256'], `deep execution ${label} route`);
        normalizedModel(route.model, `${label} model`);
        if (!['openai', 'openai_responses', 'anthropic'].includes(route.protocol)
            || !/^[a-f0-9]{64}$/.test(route.endpointIdentitySha256 || '')) {
            throw new Error(`deep execution ${label} route is invalid`);
        }
    }
    exactKeys(value.audit.responses, ['reasoningEffort', 'stream'], 'deep execution Responses config');
    if (![null, 'low', 'medium', 'high'].includes(value.audit.responses.reasoningEffort)
        || typeof value.audit.responses.stream !== 'boolean') {
        throw new Error('deep execution Responses config is invalid');
    }
    exactKeys(value.audit.limits, DEEP_EXECUTION_LIMIT_FIELDS, 'deep execution limits');
    for (const field of DEEP_EXECUTION_LIMIT_FIELDS) {
        assertDeepExecutionLimit(field, value.audit.limits[field]);
    }
    const body = clone(value); delete body.identitySha256;
    if (value.identitySha256 !== stableHash(body)) throw new Error('deep execution config identity SHA mismatch');
    return value;
}
function currentDeepExecutionConfigIdentity(deps) {
    const builder = deps.deepExecutionConfigIdentity || deepExecutionConfigIdentity;
    return assertDeepExecutionConfigIdentity(builder({ env: deps.env || process.env,
        analysisConfig: deps.analysisConfig, secondaryModelConfig: deps.secondaryModelConfig,
        utilsApi: deps.utilsApi }));
}
function assertRuntimeAuthorityUnchanged(context, deps, phase) {
    const currentImplementation = (deps.implementationSha256 || implementationSha256)();
    if (currentImplementation !== context.authority.implementationSha256) {
        throw new Error(`Conference process implementation drifted ${phase}`);
    }
    const currentConfig = currentDeepExecutionConfigIdentity(deps);
    const expectedConfig = assertDeepExecutionConfigIdentity(context.authority.deepExecutionConfig);
    if (stableHash(currentConfig) !== stableHash(expectedConfig)) {
        throw new Error(`Conference process deep execution config drifted ${phase}`);
    }
    return true;
}

function deterministicUuid(...parts) {
    const bytes = Buffer.from(sha256(parts.join('\0')).slice(0, 32), 'hex');
    bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function stateDigest(value) { const body = clone(value); delete body.stateSha256; return stableHash(body); }
function exactFile(filename, bytes) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const existing = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (existing && (existing.mode & 0o777) !== 0o600) {
        throw new Error(`会议进程不可变文件权限必须为 0600：${filename}`);
    }
    writeImmutableFile(filename, bytes, (message, details = {}) => {
        throw Object.assign(new Error(`会议进程不可变文件写入失败：${message}：${filename}`), details);
    });
    return filename;
}
function safeProcessDirectory(root, processId, create = false) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || !/^[a-f0-9-]{36}$/.test(processId)) {
        throw new Error('conferenceProcessDir and processId are invalid');
    }
    if (create) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const absolute = path.resolve(root);
    for (const directory of [absolute]) {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
            throw new Error(`conference process root is not a private directory: ${directory}`);
        }
    }
    const target = path.resolve(absolute, processId);
    if (path.dirname(target) !== absolute) throw new Error('conference process directory escapes configured root');
    if (create) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
        || fs.realpathSync(target) !== target) {
        throw new Error(`conference process directory is unsafe: ${target}`);
    }
    return target;
}
function processFormat(value) {
    if (value?.contract === CONTRACT && value.version === PROCESS_VERSION) return PROCESS_VERSION;
    if (value?.contract === LEGACY_CONTRACT && value.version === LEGACY_VERSION) return LEGACY_VERSION;
    throw new Error('会议进程记录的格式标识和版本不属于支持的组合。');
}
function authorityForComparison(authority, version) {
    if (!authority || typeof authority !== 'object' || Array.isArray(authority)
        || ![PROCESS_VERSION, LEGACY_VERSION].includes(version)) throw new Error('会议进程的权限记录或格式版本无效。');
    const current = ['tagCatalogVersion', 'tagCatalogSha256'];
    const legacy = ['taxonomyVersion', 'taxonomyRegistrySha256'];
    const hasCurrent = current.some(key => Object.hasOwn(authority, key));
    const hasLegacy = legacy.some(key => Object.hasOwn(authority, key));
    if (hasCurrent && hasLegacy) throw new Error('会议进程不能混用新旧词表身份字段。');
    if (version === PROCESS_VERSION && hasLegacy || version === LEGACY_VERSION && hasCurrent) {
        throw new Error('会议进程的词表身份字段与格式版本不一致。');
    }
    if (version === PROCESS_VERSION && (typeof authority.tagCatalogVersion !== 'string'
        || !authority.tagCatalogVersion.trim() || typeof authority.tagCatalogSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(authority.tagCatalogSha256))) {
        throw new Error('会议进程的词表版本或原文件 SHA 无效。');
    }
    const view = { ...authority };
    if (version === LEGACY_VERSION) {
        for (const [oldKey, newKey] of [['taxonomyVersion', 'tagCatalogVersion'], ['taxonomyRegistrySha256', 'tagCatalogSha256']]) {
            if (Object.hasOwn(authority, oldKey)) view[newKey] = authority[oldKey];
            delete view[oldKey];
        }
    }
    return view;
}
function authorityWithoutTagCatalog(authority, version) {
    const view = authorityForComparison(authority, version);
    delete view.tagCatalogVersion;
    delete view.tagCatalogSha256;
    return view;
}
function authorityForExistingState(state, currentAuthority) {
    const checked = assertState(state);
    authorityForComparison(currentAuthority, PROCESS_VERSION);
    const authority = { ...currentAuthority };
    delete authority.tagCatalogVersion;
    delete authority.tagCatalogSha256;
    const fields = checked.version === LEGACY_VERSION
        ? ['taxonomyVersion', 'taxonomyRegistrySha256'] : ['tagCatalogVersion', 'tagCatalogSha256'];
    for (const key of fields) if (Object.hasOwn(checked.authority, key)) authority[key] = checked.authority[key];
    return authority;
}

function initialState(authority, members, processId, now) {
    authorityForComparison(authority, PROCESS_VERSION);
    if (processId !== deterministicUuid(stableHash(authority), CONTRACT)) throw new Error('新会议进程标识与当前权限记录不一致。');
    const items = Object.fromEntries(members.map(member => [member.paperId, {
        paperId: member.paperId, sourceIdentity: member.sourceIdentity,
        analysisRunId: deterministicUuid(processId, member.paperId, 'analysis'), status: 'pending',
        sourceProof: null, analysisProof: null, pageProof: null, attempts: 0, lastError: null, updatedAt: now
    }]));
    const value = { contract: CONTRACT, version: VERSION, generation: 1, processId, createdAt: now, updatedAt: now,
        authority, status: 'pending', items, aggregate: null, completionReceiptSha256: null };
    value.stateSha256 = stateDigest(value); return value;
}
function assertState(value, expected = null) {
    if (!value || value.stateSha256 !== stateDigest(value)
        || !/^[a-f0-9-]{36}$/.test(value.processId || '')
        || !value.authority || !value.items || typeof value.items !== 'object'
        || !/^[a-f0-9]{64}$/.test(value.authority.implementationSha256 || '')
        || !['pending', 'running', 'partial', 'complete'].includes(value.status)) {
        throw new Error('Conference process checkpoint integrity failed');
    }
    const format = processFormat(value);
    authorityForComparison(value.authority, format);
    try { assertDeepExecutionConfigIdentity(value.authority.deepExecutionConfig); }
    catch (error) { throw new Error(`Conference process checkpoint deep execution config integrity failed: ${error.message}`); }
    if (value.sourceUpgradePromotion) {
        const promotion = value.sourceUpgradePromotion;
        if (promotion.contract !== 'conference-source-upgrade-promotion-v1'
            || !/^[a-f0-9]{64}$/.test(promotion.planSha256 || '')
            || !/^[a-f0-9]{64}$/.test(promotion.sourceImplementationSha256 || '')
            || !/^[a-f0-9-]{36}$/.test(promotion.originalProcessId || '')
            || value.processId !== deterministicUuid(promotion.planSha256, 'conference-source-upgrade-process-v1')) {
            throw new Error('Source upgrade promotion identity failed');
        }
        if (promotion.preferUpgrade !== undefined && typeof promotion.preferUpgrade !== 'boolean') {
            throw new Error('Source upgrade preferUpgrade is invalid');
        }
        if (promotion.pageRepairPolicy !== undefined) {
            const policy = exactKeys(promotion.pageRepairPolicy, ['contract', 'mode', 'implementationSha256'], 'page repair policy');
            if (policy.contract !== 'conference-caption-only-page-repair-policy-v1' || policy.mode !== 'caption-only'
                || !/^[a-f0-9]{64}$/.test(policy.implementationSha256 || '')) throw new Error('Unknown page repair policy');
        }
        if (promotion.preferUpgrade === true && (!Array.isArray(promotion.upgradedPaperIds)
            || !Array.isArray(promotion.preservedOriginalCompletePaperIds))) {
            throw new Error('Source upgrade preferUpgrade ledger arrays are missing');
        }
        for (const field of ['preservedOriginalCompletePaperIds', 'preservedPriorUpgradePaperIds', 'upgradedPaperIds']) {
            const ids = promotion[field];
            if (ids !== undefined && (!Array.isArray(ids)
                || stableHash(ids) !== stableHash([...ids].sort())
                || new Set(ids).size !== ids.length
                || ids.some(paperId => !Object.hasOwn(value.items || {}, paperId)))) {
                throw new Error(`Source upgrade ${field} is invalid`);
            }
        }
    }
    if (value.sourceImplementationSha256 && !/^[a-f0-9]{64}$/.test(value.sourceImplementationSha256)) {
        throw new Error('Conference process source implementation identity is invalid');
    }
    if (value.sourceImplementationSha256 && value.processId !== deterministicUuid(stableHash({
        ...value.authority, implementationSha256: value.sourceImplementationSha256 }), value.contract)) {
        throw new Error('Conference process source implementation does not bind its original identity');
    }
    if (expected) {
        // 比较当前配置时，先排除进程创建时保存的词表版本和哈希。它们参与原 processId
        // 的计算，不能因更换词表就覆盖原值。是否允许继续使用标签记录，由后续标签阶段
        // 和发布检查决定。implementationSha256 仍参与比较，实现变化须先按迁移流程核验。
        const valueAuthority = authorityWithoutTagCatalog(value.authority, format);
        const expectedAuthority = authorityWithoutTagCatalog(expected.authority, PROCESS_VERSION);
        if (stableHash(valueAuthority) !== stableHash(expectedAuthority)
            || stableHash(Object.keys(value.items).sort()) !== stableHash(expected.paperIds)) {
            throw new Error('会议进程记录的来源、筛选、配置或论文集合与当前输入不一致。');
        }
    }
    const preservedComplete = new Set([
        ...(value.sourceUpgradePromotion?.preservedOriginalCompletePaperIds || []),
        ...(value.sourceUpgradePromotion?.preservedPriorUpgradePaperIds || [])
    ]);
    for (const [paperId, item] of Object.entries(value.items)) {
        if (!Number.isSafeInteger(item.attempts) || item.attempts < 0
            || (item.retryBudgetStart !== undefined && (!Number.isSafeInteger(item.retryBudgetStart)
                || item.retryBudgetStart < 0 || item.retryBudgetStart > item.attempts))
            || (item.retryNotBefore != null && !Number.isFinite(Date.parse(item.retryNotBefore)))) {
            throw new Error(`Conference process retry state is invalid: ${paperId}`);
        }
        if (item.paperId !== paperId || (!preservedComplete.has(paperId)
            && item.analysisRunId !== deterministicUuid(value.processId, paperId, 'analysis'))
            || preservedComplete.has(paperId) && (!(item.preservedOriginalComplete || item.preservedPriorUpgradeComplete)
                || !/^[a-f0-9-]{36}$/i.test(item.analysisRunId || ''))
            || !['pending', 'source_sealed', 'analyzing', 'analysis_partial', 'complete'].includes(item.status)) {
            throw new Error(`Conference process item integrity failed: ${paperId}`);
        }
        if (item.status === 'complete' && (!item.sourceProof || !item.analysisProof || !item.pageProof)) {
            throw new Error(`论文 ${paperId} 已标为完成，但缺少来源、分析或页面记录。`);
        }
    }
    const incomplete = Object.values(value.items).filter(item => item.status !== 'complete');
    if (value.status === 'complete') {
        if (incomplete.length || !value.aggregate
            || !/^[a-f0-9]{64}$/.test(value.completionReceiptSha256 || '')) {
            throw new Error('会议进程已标为完成，但仍有未完成论文，或缺少汇总记录及格式有效的完成凭证哈希。');
        }
    } else {
        if (value.aggregate !== null || value.completionReceiptSha256 !== null) {
            throw new Error('会议进程尚未完成，不能保存汇总记录或完成凭证哈希。');
        }
        if (value.status === 'partial' && !incomplete.length) {
            throw new Error('会议进程标为 partial，但所有论文都已完成。');
        }
    }
    return value;
}
function completionBodyFor(state, planReceiptSha256, aggregate) {
    const checked = assertState(state);
    const legacy = checked.version === LEGACY_VERSION;
    return { contract: legacy ? LEGACY_COMPLETION_CONTRACT : COMPLETION_CONTRACT,
        version: legacy ? LEGACY_VERSION : COMPLETION_VERSION, processId: state.processId,
        ...(state.sourceUpgradePromotion ? { sourceUpgradePromotion: clone(state.sourceUpgradePromotion) } : {}),
        authority: clone(state.authority), planReceiptSha256,
        items: Object.values(state.items).sort((a, b) => a.paperId.localeCompare(b.paperId)).map(item => ({
            paperId: item.paperId, analysisRunId: item.analysisRunId, sourceProof: item.sourceProof,
            analysisProof: item.analysisProof, pageProof: item.pageProof })), aggregate };
}
function validateCompletionReceipt(state, receipt, planReceiptSha256 = null) {
    const checked = assertState(state);
    if (checked.status !== 'complete') {
        throw new Error('Conference process completion receipt requires a complete checkpoint');
    }
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Conference process completion receipt identity failed');
    const body = clone(receipt); delete body.receiptSha256;
    if (receipt.receiptSha256 !== stableHash(body)) throw new Error('Conference process completion receipt does not bind the current lifecycle');
    const legacy = checked.version === LEGACY_VERSION;
    if (receipt.contract !== (legacy ? LEGACY_COMPLETION_CONTRACT : COMPLETION_CONTRACT)
        || receipt.version !== (legacy ? LEGACY_VERSION : COMPLETION_VERSION)
        || receipt.processId !== checked.processId) throw new Error('Conference process completion receipt identity failed');
    authorityForComparison(receipt.authority, checked.version);
    if (receipt.receiptSha256 !== stableHash(body)
        || stableHash(body.sourceUpgradePromotion || null) !== stableHash(checked.sourceUpgradePromotion || null)
        || checked.completionReceiptSha256 !== receipt.receiptSha256
        || stableHash(body.authority) !== stableHash(checked.authority)
        || stableHash(body.items) !== stableHash(completionBodyFor(checked,
            body.planReceiptSha256, body.aggregate).items)
        || stableHash(body.aggregate) !== stableHash(checked.aggregate)
        || (planReceiptSha256 && body.planReceiptSha256 !== planReceiptSha256)) {
        throw new Error('Conference process completion receipt does not bind the current lifecycle');
    }
    return receipt;
}

// 为标签分配被确定性地阻塞的论文建一个只读队列。
// 队列里的条目让批次保持未完成状态，并且不进完成回执。
// 未解决的分配不能授权页面暂存或发布。
// 队列报告哪些论文还需要分类决定。
// 它不会把待定的分配当成已完成的分类。
function buildTagReviewQueue(state) {
    const checked = assertState(state);
    const items = Object.values(checked.items)
        .filter(item => item.reviewRequired
            || item.lastFailure?.code === 'CONFERENCE_TAG_REVIEW_REQUIRED'
            // 保留旧检查点原字节与哈希，只在当前队列中转换输出名称。
            || item.lastFailure?.code === 'CONFERENCE_TAXONOMY_REVIEW_REQUIRED')
        .map(item => ({ paperId: item.paperId, analysisRunId: item.analysisRunId,
            status: 'needs_tag_review',
            blockedReasons: item.reviewRequired?.blockedReasons || [],
            registrySha256: item.reviewRequired?.registrySha256 || null,
            assignmentSha256: item.reviewRequired?.assignmentSha256 || null,
            lastError: item.lastError || null }))
        .sort((left, right) => left.paperId.localeCompare(right.paperId));
    const body = { contract: TAG_REVIEW_QUEUE_CONTRACT, version: TAG_REVIEW_QUEUE_VERSION,
        processId: checked.processId, conferenceId: checked.authority.conferenceId,
        stateGeneration: checked.generation, tagReview: items.length, items };
    return { ...body, queueSha256: stableHash(body) };
}
function writeTagReviewQueue(directory, queue) {
    const filename = path.join(directory, TAG_REVIEW_QUEUE_FILE);
    const legacyFilename = path.join(directory, LEGACY_TAG_REVIEW_QUEUE_FILE);
    if (!queue.tagReview) {
        if (fs.existsSync(filename)) fs.rmSync(filename);
        if (fs.existsSync(legacyFilename)) fs.rmSync(legacyFilename);
        return null;
    }
    const bytes = Buffer.from(`${JSON.stringify(queue, null, 2)}\n`);
    const temporary = path.join(directory, `.tag-review-queue.${sha256(bytes).slice(0, 12)}.tmp`);
    const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, filename);
    if (fs.existsSync(legacyFilename)) fs.rmSync(legacyFilename);
    return filename;
}
function buildTagReviewQueueFields(queue, directory) {
    if (!queue.tagReview) return {};
    const filename = path.join(directory, TAG_REVIEW_QUEUE_FILE);
    const legacyFilename = path.join(directory, LEGACY_TAG_REVIEW_QUEUE_FILE);
    const existingFile = fs.existsSync(filename) ? filename
        : fs.existsSync(legacyFilename) ? legacyFilename : null;
    return { tagReviewQueue: queue.items,
        ...(existingFile ? { tagReviewQueueFile: existingFile } : {}) };
}

function defaultDependencies() {
    const Config = require('../config.js'); const discovery = require('./conference-discovery.js');
    const filter = require('./conference-filter.js'); const engine = require('../analysis-engine.js');
    return { files: Config.FILES, analysisConfig: Config.ANALYSIS_CONFIG,
        secondaryModelConfig: Config.SECONDARY_MODEL_CONFIG, env: process.env, utilsApi: require('../utils.js'),
        discovery, filter, engine, staging: require('./conference-staging.js'),
        importer: require('./conference-importer.js'), importCli: require('../conference-import.js'),
        plan: require('./conference-plan.js'), adapter: require('./conference-analysis-adapter.js'),
        postprocess: require('./conference-postprocess.js'), ledger: require('./conference-source-ledger.js'),
        now: () => new Date().toISOString(), execFileSync };
}
// 新写入按当前版本清单绑定（7 个文本阶段是 v2 正文）；旧记录按 promptTextVersion
// 为 'v1' 的冻结清单取值。这张清单包含 conference-process.js 自己，所以改代码之后
// 旧记录的 implementationSha256 本来就不再复现，只能走显式的实现迁移记录。
function implementationSha256(options = {}) {
    const root = options.root || path.join(__dirname, '..', '..');
    const readFileSync = options.readFileSync || fs.readFileSync;
    const version = options.promptTextVersion || 'current';
    if (!IMPLEMENTATION_PROMPT_TEXT_VERSIONS.includes(version)) {
        throw new Error(`会议实现指纹的提示词版本 ${version} 没有登记；只认识 ${IMPLEMENTATION_PROMPT_TEXT_VERSIONS.join(' 和 ')}。`);
    }
    const files = version === 'v1' ? IMPLEMENTATION_FILES : currentImplementationFiles();
    return sha256(files.map(name => (
        `${name}\0${sha256(readFileSync(path.join(root, name)))}\0`
    )).join(''));
}
function loadAuthority(options, deps) {
    const files = deps.files; const catalogFile = path.join(files.conferenceDiscoveryCatalogDir, options.catalogName);
    const reportFile = path.join(files.conferenceDiscoveryReportDir, options.reportName);
    const discoveryHandle = deps.discovery.loadDiscoveryHandle(catalogFile, reportFile);
    const selectionHandle = deps.filter.loadSelectionHandle(files.conferenceFiltersDir, options.filterId, discoveryHandle);
    const discovery = deps.discovery.discoveryHandleSnapshot(discoveryHandle);
    const selection = deps.filter.selectionHandleSnapshot(selectionHandle);
    if (discovery.candidateManifest.adapter !== 'official-proceedings') {
        throw new Error('conference:new:process 只接受从官方论文集精确匹配 PDF 的发现结果。');
    }
    let acquisitionReceipt = discovery.candidateManifest.acquisitionReceipt || null;
    if (process.env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE === '1' && !acquisitionReceipt) {
        const configuredRoot = files.officialConferenceAcquisitionDir;
        const expectedRoot = configuredRoot && path.resolve(configuredRoot, discovery.candidateManifest.conference.id);
        if (typeof deps.discovery.officialAcquisitionBindingFromRoot !== 'function'
            || !expectedRoot || path.resolve(discovery.candidateManifest.pdfRoot) !== expectedRoot
            || discovery.candidateManifest.metadataSnapshot.file !== path.join(expectedRoot, 'metadata.json')) {
            throw new Error('新会议流程的发现结果必须对应官方文件获取记录。');
        }
        acquisitionReceipt = deps.discovery.officialAcquisitionBindingFromRoot(
            discovery.candidateManifest.conference,
            discovery.candidateManifest.metadataSnapshot,
            expectedRoot
        );
    }
    if (!selection.included.length) throw new Error('conference:new:process 要求筛选结果包含入选论文。');
    for (const member of selection.included) {
        const replay = deps.discovery.replayDiscoveryMember(discoveryHandle, member.sourceIdentity);
        if (replay.match.kind !== 'exact' || replay.match.candidates.length !== 1) {
            throw new Error(`论文 ${member.paperId} 未能精确匹配唯一一份官方 PDF。`);
        }
    }
    const tagCatalogFile = deps.ledger.readRegularJson(files.tagCatalogFile);
    const tagCatalogVersion = String(tagCatalogFile.value.version || tagCatalogFile.value.registryVersion || '');
    if (!tagCatalogVersion) throw new Error('当前标签词表缺少版本标识。');
    const authority = { conferenceId: selection.conferenceId, catalogName: options.catalogName,
        reportName: options.reportName, filterId: options.filterId, catalogSha256: discovery.catalogSha256,
        reportSha256: discovery.reportSha256, filterPolicySha256: selection.filterPolicySha256,
        selectionReceiptSha256: selection.selectionReceiptSha256,
        selectedMemberSetSha256: selection.selectedMemberSetSha256,
        acquisitionReceiptSha256: acquisitionReceipt?.catalogReceiptSha256 || null,
        acquisitionPdfReceiptSetSha256: acquisitionReceipt?.pdfReceiptSetSha256 || null,
        tagCatalogVersion, tagCatalogSha256: tagCatalogFile.sha256,
        implementationSha256: (deps.implementationSha256 || implementationSha256)(),
        deepExecutionConfig: currentDeepExecutionConfigIdentity(deps) };
    return { files, discoveryHandle, selectionHandle, discovery, selection, authority,
        members: selection.included.map(({ paperId, sourceIdentity }) => ({ paperId, sourceIdentity })) };
}
function namesFor(context) {
    const stem = `${context.authority.conferenceId}-${context.authority.selectionReceiptSha256.slice(0, 16)}-${context.authority.implementationSha256.slice(0, 12)}`;
    return { extraction: `${stem}-source-seal.json`, import: `${stem}-import.json`,
        stagingReceipt: `${stem}-staging-receipt.json`, ledger: `${stem}-ledger.json`,
        importReceipt: `${stem}-ledger.import-receipt.json`, plan: `${stem}-plan.json`, run: `${stem}-run.json` };
}
function sourceNames(paperId, implementationSha256 = '') {
    const suffix = implementationSha256 ? `-${implementationSha256.slice(0, 12)}` : '';
    const stem = `paper-${sha256(paperId).slice(0, 24)}${suffix}`;
    return { metadata: `${stem}-metadata.json`, pdf: `${stem}.pdf`, request: `${stem}-extract.json`,
        text: `${stem}.txt`, artifacts: `${stem}-artifacts.json`, receipt: `${stem}-extraction-receipt.json` };
}
function sourceCacheRoot(context) {
    const base = context?.files?.conferenceSourceCacheDir;
    const implementation = context?.authority?.implementationSha256;
    if (typeof base !== 'string' || !path.isAbsolute(base) || !/^[a-f0-9]{64}$/.test(implementation || '')) {
        throw new Error('会议来源文件目录必须为绝对路径，实现指纹也必须有效。');
    }
    return path.join(base, `generation-${implementation}`);
}
function sealOneSource(context, member, deps, createdAt, { replayExisting = true } = {}) {
    const { discovery, discoveryHandle, files } = context; const replay = deps.discovery.replayDiscoveryMember(discoveryHandle, member.sourceIdentity);
    let names = sourceNames(member.paperId, context.authority.implementationSha256); const root = files.conferenceStagingSourceDir; fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const extraction = deps.extraction || require('./conference-extraction-receipt.js');
    const record = { ...replay.metadataRecord, conferenceId: replay.conference.id, year: replay.conference.year,
        identity: clone(replay.identity) };
    const metadataBytes = canonicalBytes(record); const candidate = replay.match.candidates[0];
    // 优先用已保存并核验的 PDF，但把它的字节重新绑定到当前官方的 discovery SHA。
    const sealedPdf = path.join(root, names.pdf);
    const sealedStat = fs.lstatSync(sealedPdf, { throwIfNoEntry: false });
    if (sealedStat?.isFile() && !sealedStat.isSymbolicLink() && sealedStat.nlink === 2) {
        // 只有重新核验官方原 PDF 后，才允许恢复同字节的已退出写者链接。
        const official = deps.discovery.safeAbsoluteFile(path.join(discovery.candidateManifest.pdfRoot, candidate.path),
            `official PDF for ${member.paperId}`, deps.discovery.MAX_PDF_BYTES);
        if (sha256(official.bytes) !== candidate.sha256) throw new Error(`论文 ${member.paperId} 的官方 PDF 哈希与发现记录不一致。`);
        exactFile(sealedPdf, official.bytes);
    }
    const pdfLoaded = deps.discovery.safeAbsoluteFile(fs.existsSync(sealedPdf) ? sealedPdf : path.join(discovery.candidateManifest.pdfRoot, candidate.path),
        `official PDF for ${member.paperId}`, deps.discovery.MAX_PDF_BYTES);
    if (sha256(pdfLoaded.bytes) !== candidate.sha256) throw new Error(`论文 ${member.paperId} 的官方 PDF 哈希与发现记录不一致。`);
    const pdfProvenanceKind = String(replay.metadataRecord.pdfUrl || '').includes('ICMC2026_proceedings_')
        ? 'conference-proceedings' : 'official-pdf';
    exactFile(path.join(root, names.metadata), metadataBytes); exactFile(path.join(root, names.pdf), pdfLoaded.bytes);
    let upgradedFrom = null;
    const previousReceipt = path.join(root, names.receipt);
    if (fs.existsSync(previousReceipt)) {
        const old = recovery.readPrivateJson(previousReceipt);
        const receiptReady = old.status === 'ready' && old.textReplayable === true;
        if (!receiptReady || old.extractor?.version !== extraction.EXTRACTOR_VERSION
            || old.extractor?.backend?.version !== extraction.BACKEND_VERSION
            || old.version !== extraction.VERSION) {
            // 被阻塞或过期的回执永远不能当作当前证明。保留它原来的文件名，
            // 只把独立核验过的原始 PDF/元数据交给新的提取器代次。
            // 这样实现迁移就能修掉一个确定性的 PDF 审计缺陷，
            // 既不用删掉失败证据，也不用授权新的分析运行。
            upgradedFrom = names.receipt;
            const generation = stableHash({ source: context.authority.implementationSha256,
                extractor: extraction.EXTRACTOR_VERSION, backend: extraction.BACKEND_VERSION,
                contract: extraction.RECEIPT_CONTRACT, version: extraction.VERSION,
                pdfSha256: candidate.sha256, metadataSha256: sha256(metadataBytes),
                previousReceiptSha256: old.receiptSha256 || null });
            names = sourceNames(member.paperId, generation);
            exactFile(path.join(root, names.metadata), metadataBytes); exactFile(path.join(root, names.pdf), pdfLoaded.bytes);
        }
    }
    const extractionOptions = typeof extraction.optionsForConference === 'function'
        ? extraction.optionsForConference(context.authority.conferenceId) : extraction.OPTIONS;
    const request = { contract: extraction.REQUEST_CONTRACT, version: extraction.VERSION, paperId: member.paperId,
        sourceIdentity: member.sourceIdentity, source: {
            metadata: { file: names.metadata, sha256: sha256(metadataBytes), identityEvidence: {
                conferenceIdPointer: '/conferenceId', conferenceYearPointer: '/year', identityTypePointer: '/identity/type',
                identityValuePointer: '/identity/value' }, discoveryBinding: { catalogSha256: replay.catalogSha256,
                metadataSnapshotSha256: replay.metadataSnapshotSha256, metadataIndex: replay.metadataIndex,
                metadataRecordSha256: replay.metadataRecordSha256 }, provenance: { kind: 'official-metadata',
                locator: String(replay.metadataRecord.recordUrl), retrievedAt: createdAt } },
            pdf: { file: names.pdf, sha256: candidate.sha256, provenance: { kind: pdfProvenanceKind,
                locator: String(replay.metadataRecord.pdfUrl), retrievedAt: createdAt } } },
        outputs: { textFile: names.text, artifactsFile: names.artifacts, receiptFile: names.receipt },
        options: extractionOptions };
    exactFile(path.join(root, names.request), canonicalBytes(request));
    const hadReceipt = fs.existsSync(path.join(root, names.receipt));
    if (!hadReceipt) {
        deps.execFileSync('bash', [path.join(__dirname, '..', 'python-runtime.sh'), path.join(__dirname, '..', 'conference-extract.py'),
            '--apply', '--manifest', names.request], { cwd: path.join(__dirname, '..', '..'), stdio: 'pipe' });
    }
    const snapshot = extraction.extractionHandleSnapshot(extraction.loadExtractionHandle(root, names.receipt,
        { replay: !hadReceipt || replayExisting }));
    return { paperId: member.paperId, sourceIdentity: member.sourceIdentity, receiptName: names.receipt,
        ...(upgradedFrom ? { upgradedFrom } : {}),
        proof: { requestSha256: snapshot.verification.requestSha256, receiptSha256: snapshot.receipt.receiptSha256,
            verificationSha256: snapshot.verification.verificationSha256, textSha256: snapshot.text.sha256,
            artifactsSha256: snapshot.artifacts.sha256, pdfSha256: snapshot.pdf.sha256 } };
}
function prepareShared(context, deps, createdAt) {
    const files = context.files;
    const sealed = context.members.map(member => sealOneSource(context, member, deps, createdAt,
        { replayExisting: false }));
    // 来源升级会另建一套不可变的暂存/导入/计划命名空间。
    // 已有的来源包和分析执行在这里绝不重写。
    const generationContext = sealed.some(item => item.upgradedFrom) ? { ...context, authority: {
        ...context.authority, implementationSha256: stableHash({ implementation: context.authority.implementationSha256,
            sources: sealed.map(item => ({ paperId: item.paperId, receiptName: item.receiptName,
                receiptSha256: item.proof.receiptSha256 })).sort((a, b) => a.paperId.localeCompare(b.paperId)) }) } } : context;
    const names = namesFor(generationContext); const cacheRoot = sourceCacheRoot(generationContext);
    for (const root of [files.conferenceStagingSpecsDir, files.conferenceStagingSourceDir,
        files.conferenceStagingDir, files.conferenceSourceCacheDir, cacheRoot, files.conferenceSourceLedgerDir,
        files.conferenceRunsDir, files.conferenceAnalysisDir, files.conferencePageStagingDir,
        files.conferenceAggregateDir]) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const seal = { contract: deps.staging.AUTOMATED_EXTRACTION_CONTRACT, version: deps.staging.VERSION,
        conference: clone(context.discovery.candidateManifest.conference), acceptance: {
            method: 'official-proceedings-exact-pdf-v1', catalogSha256: context.discovery.catalogSha256,
            selectionReceiptSha256: context.selection.selectionReceiptSha256 },
        members: sealed.map(({ paperId, sourceIdentity, receiptName }) => ({ paperId, sourceIdentity, receiptName })) };
    seal.members.sort((a, b) => a.paperId.localeCompare(b.paperId)); seal.membersSha256 = deps.staging.stableHash(seal.members);
    fs.mkdirSync(files.conferenceStagingSpecsDir, { recursive: true, mode: 0o700 });
    const sealFile = exactFile(path.join(files.conferenceStagingSpecsDir, names.extraction), canonicalBytes(seal));
    const staged = deps.staging.bindInputs({ selectionHandle: context.selectionHandle, discoveryHandle: context.discoveryHandle,
        extractionManifest: seal, extractionFileSha256: sha256(fs.readFileSync(sealFile)),
        extractionSourceRoot: files.conferenceStagingSourceDir, importManifestName: names.import, replay: false });
    const importFile = path.join(files.conferenceStagingDir, names.import);
    const stagingReceiptFile = path.join(files.conferenceStagingDir, names.stagingReceipt);
    if (!fs.existsSync(importFile) && !fs.existsSync(stagingReceiptFile)) deps.staging.writeStagingBundle({
        stagingRoot: files.conferenceStagingDir, importManifestName: names.import, receiptName: names.stagingReceipt, staged });
    if (fs.existsSync(importFile) !== fs.existsSync(stagingReceiptFile)) throw new Error('会议来源准备文件不完整，不能恢复；预期的清单和凭证必须同时存在。');
    const stagingHandle = deps.staging.loadStagingHandle(importFile, stagingReceiptFile, context.selectionHandle,
        context.discoveryHandle, files.conferenceStagingSourceDir, { replay: false });
    const result = deps.importer.importConferenceSourcesFromStaging({ stagingHandle,
        sourceRoot: files.conferenceStagingSourceDir, cacheRoot,
        updatedAt: createdAt, apply: true, replay: false });
    const bundle = deps.importer.createImportReceipt({ result, ledgerName: names.ledger });
    const ledgerFile = path.join(files.conferenceSourceLedgerDir, names.ledger);
    const importReceiptFile = path.join(files.conferenceSourceLedgerDir, names.importReceipt);
    if (!fs.existsSync(ledgerFile) && !fs.existsSync(importReceiptFile)) deps.importCli.reserveOutputPair(
        files.conferenceSourceLedgerDir, names.ledger, bundle.ledgerBytes, bundle.receipt, names.importReceipt);
    if (fs.existsSync(ledgerFile) !== fs.existsSync(importReceiptFile)) throw new Error('会议来源导入文件不完整，不能恢复；预期的清单和凭证必须同时存在。');
    const importHandle = deps.importer.loadImportHandle(ledgerFile, importReceiptFile, stagingHandle);
    const imported = deps.importer.importHandleSnapshot(importHandle); const tagCatalogFile = deps.ledger.readRegularJson(files.tagCatalogFile);
    const tagCatalogVersion = String(tagCatalogFile.value.version || tagCatalogFile.value.registryVersion || '');
    if (!tagCatalogVersion) throw new Error('标签词表缺少版本标识。');
    const identities = imported.verifiedMembers;
    const planIdentities = [...identities].sort((left, right) => left.paperId.localeCompare(right.paperId));
    const shards = [];
    for (let index = 0; index < planIdentities.length; index += 50) shards.push({ shardId: `part-${String(index / 50 + 1).padStart(4, '0')}`,
        paperIds: planIdentities.slice(index, index + 50).map(item => item.paperId) });
    const planDoc = { contract: deps.plan.PLAN_CONTRACT, version: deps.plan.PLAN_VERSION, ledgerName: names.ledger,
        tagMetadata: { version: tagCatalogVersion, sha256: tagCatalogFile.sha256 }, selectionPolicy: {
            contract: deps.plan.SELECTION_CONTRACT, identities: planIdentities,
            selectedMemberSetSha256: deps.plan.stableHash(planIdentities.map(item => item.paperId)) },
        shards };
    const planFile = path.join(files.conferenceSourceLedgerDir, names.plan);
    const runFile = path.join(files.conferenceRunsDir, names.run);
    const planReceiptFile = path.join(files.conferenceRunsDir, deps.plan.receiptNameFor(names.run));
    if (fs.existsSync(runFile) !== fs.existsSync(planReceiptFile)) throw new Error('会议分析计划文件不完整，不能恢复；预期的计划和凭证必须同时存在。');
    let planHandle;
    if (fs.existsSync(runFile)) {
        // 原文件对先完整核验，再比较当前来源和成员；不能以新版计划覆盖旧表示。
        planHandle = deps.plan.loadPlanHandle(runFile, planReceiptFile, planFile, importHandle, files.tagCatalogFile);
        const saved = deps.plan.planHandleSnapshot(planHandle);
        if (saved.receipt.ledger.name !== names.ledger
            || deps.plan.stableHash(deps.plan.tagMetadataForReceipt(saved.receipt)) !== deps.plan.stableHash(planDoc.tagMetadata)
            || deps.plan.stableHash(saved.receipt.members) !== deps.plan.stableHash(planIdentities)
            || deps.plan.stableHash(saved.receipt.shards) !== deps.plan.stableHash(shards)) {
            throw new Error('已保存的会议计划与当前来源、标签词表或成员分片不一致。');
        }
    } else {
        if (fs.existsSync(planFile)) {
            const planStat = fs.lstatSync(planFile);
            if (planStat.isFile() && !planStat.isSymbolicLink() && planStat.nlink === 2) {
                // 当前计划由已重放的来源、导入凭证、词表和完整成员集合推导。
                exactFile(planFile, canonicalBytes(planDoc));
            }
            const savedPlan = deps.plan.normalizePlan(deps.plan.readRuntimeJson(files.conferenceSourceLedgerDir, names.plan).value);
            if (savedPlan.version === deps.plan.LEGACY_VERSION) throw new Error('旧会议计划缺少完整运行文件和凭证，请保留原文件并使用新的运行标识。');
        }
        exactFile(planFile, canonicalBytes(planDoc));
        const planned = deps.plan.createRunFromImportPlan({ files, importHandle, planName: names.plan, runName: names.run });
        deps.plan.applyRunPlan(planned);
        planHandle = deps.plan.loadPlanHandle(runFile, planReceiptFile, planFile, importHandle, files.tagCatalogFile);
    }
    return { planHandle, names, sealed, sourceCacheRoot: cacheRoot,
        sourceGenerationChanged: sealed.some(item => item.upgradedFrom),
        planReceiptSha256: deps.plan.planHandleSnapshot(planHandle).receipt.receiptSha256 };
}

async function processOne(context, shared, item, deps) {
    const files = context.files;
    const readerRetryRound = Array.isArray(item.retryReleases) && item.retryReleases.length > 0
        ? item.retryReleases.length : undefined;
    if (shared.sourceGenerationChanged && fs.existsSync(path.join(files.conferenceAnalysisDir, item.analysisRunId, 'run.json'))) {
        const loaded = deps.adapter.loadConferenceAnalysis({ analysisRoot: files.conferenceAnalysisDir, executionId: item.analysisRunId });
        try { deps.adapter.verifyPlanAuthority(loaded, shared.planHandle, shared.sourceCacheRoot); }
        catch (cause) {
            throw Object.assign(new Error(`论文 ${item.paperId} 的已有分析未通过当前来源与计划核验；继续使用前，必须按正式流程重新核验来源绑定。`, { cause }),
                { code: 'CONFERENCE_SOURCE_UPGRADE_REBIND_REQUIRED', retryable: false });
        }
    }
    deps.adapter.prepareConferenceAnalysis({ planHandle: shared.planHandle,
        paperId: item.paperId, sourceRoot: shared.sourceCacheRoot,
        analysisRoot: files.conferenceAnalysisDir, executionId: item.analysisRunId });
    const analyzed = await deps.adapter.analyzeConference({ analysisRoot: files.conferenceAnalysisDir,
        executionId: item.analysisRunId, concurrency: 1, planHandle: shared.planHandle,
        sourceRoot: shared.sourceCacheRoot },
    readerRetryRound !== undefined ? { readerRetryEpoch: readerRetryRound } : undefined);
    if (analyzed.status !== 'complete') {
        const loaded = deps.adapter.loadConferenceAnalysis({ analysisRoot: files.conferenceAnalysisDir,
            executionId: item.analysisRunId });
        const paper = loaded.analysis.papers[0];
        const error = new Error(paper.latestAnalysisAttemptError || paper.error || `分析结束后状态仍为 ${analyzed.status}。`);
        error.code = paper.latestAnalysisAttemptErrorCode || null;
        error.retryable = paper.latestAnalysisAttemptRetryable;
        throw error;
    }
    const staged = deps.postprocess.stagePaper({ analysisRoot: files.conferenceAnalysisDir,
        executionId: item.analysisRunId, tagCatalogPath: files.tagCatalogFile,
        stagingRoot: files.conferencePageStagingDir, planHandle: shared.planHandle,
        sourceRoot: shared.sourceCacheRoot, apply: true });
    if (staged.status === 'blocked') {
        // 标签分配尚未确定时，后处理只保存 assignment.json，不生成页面或页面清单。
        // 这篇论文进入标签审查队列，其他论文仍可继续处理；它不属于模型或系统故障。
        const assignment = staged.assignment || {};
        const blockedReasons = Array.isArray(assignment.blockedReasons) ? assignment.blockedReasons : [];
        const error = new Error(`论文 ${item.paperId} 的标签需要重新核对：`
            + `${blockedReasons.join('; ') || '标签选择尚未确定'}`);
        error.code = 'CONFERENCE_TAG_REVIEW_REQUIRED';
        error.retryable = false;
        error.tagReview = { paperId: item.paperId, analysisRunId: item.analysisRunId,
            status: 'needs_tag_review', blockedReasons,
            registrySha256: assignment.registrySha256 || null,
            assignmentSha256: assignment.assignmentSha256 || null };
        throw error;
    }
    if (staged.status !== 'staged') throw new Error(`论文后处理结束后状态仍为 ${staged.status}。`);
    return { analysisProof: { analysisSha256: analyzed.analysisSha256,
        completionReceiptSha256: staged.manifest.completionReceiptSha256,
        sourceSnapshotSha256: staged.manifest.sourceSnapshotSha256 },
    pageProof: { manifestSha256: staged.manifest.manifestSha256, contentSha256: staged.manifest.contentSha256,
        pagePath: staged.manifest.pagePath } };
}
async function runWorkers(items, concurrency, worker, shouldStop = () => false) {
    let cursor = 0; const results = [];
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (!shouldStop()) { const index = cursor++; if (index >= items.length) return; results[index] = await worker(items[index], index); }
    });
    await Promise.all(runners); return results;
}

function assertSourceContinuity(state, shared) {
    const sealed = new Map(shared.sealed.map(item => [item.paperId, item.proof]));
    for (const item of Object.values(state.items)) {
        if (!item.sourceProof || !(item.attempts > 0 || item.analysisProof || item.status === 'complete')) continue;
        if (stableHash(item.sourceProof) !== stableHash(sealed.get(item.paperId) || null)) {
            throw Object.assign(new Error(`已有分析对应的来源记录发生变化；请先检查 --source-upgrade-plan --from ${state.processId} 的结果，再决定是否授权论文 ${item.paperId} 重新分析。`),
                { code: 'CONFERENCE_SOURCE_UPGRADE_REBIND_REQUIRED', retryable: false });
        }
    }
}

async function runConferenceProcessLocked(options, deps, context, processId, directory, operationLockProof) {
    assertRuntimeAuthorityUnchanged(context, deps, 'before shared preparation');
    const stateFile = path.join(directory, 'state.json');
    const expected = { authority: context.authority, paperIds: context.members.map(item => item.paperId).sort() };
    // 只有本模块外层持锁回调的私有证明允许首次更新恢复同机已退出进程的内部状态锁。
    let state = deps.engine.updateJsonFileLocked(stateFile, current => {
        if (current) { assertState(current, expected); return undefined; }
        return initialState(context.authority, context.members, processId, deps.now());
    }, { allowMissing: true, ...(operationLockProof === PROCESS_OPERATION_LOCK_HELD
        ? { recoveryPolicy: deps.engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY } : {}) });
    state = assertState(state || JSON.parse(fs.readFileSync(stateFile)), expected);
    const publishReviewQueue = current => {
        const queue = buildTagReviewQueue(current);
        writeTagReviewQueue(directory, queue);
        return queue;
    };
    if (state.status === 'complete') {
        validateCompletionReceipt(state, JSON.parse(fs.readFileSync(path.join(directory, 'completion-receipt.json'))));
    }
    // 在做任何准备或模型工作之前，先升级旧的只含错误的检查点。
    // 失败的分析字节保持原样；调度器元数据只是追加。
    state = deps.engine.updateJsonFileLocked(stateFile, current => {
        const next = clone(assertState(current, expected)); let changed = false;
        for (const item of Object.values(next.items)) {
            if (item.status === 'complete') continue;
            if (!item.lastFailure && (item.lastError || item.status === 'analysis_partial')) {
                let error = new Error(item.lastError || 'legacy partial analysis');
                const filename = deps.files.conferenceAnalysisDir
                    && path.join(deps.files.conferenceAnalysisDir, item.analysisRunId, 'analysis.json');
                if (filename && fs.existsSync(filename)) {
                    const paper = recovery.readPrivateJson(filename).papers?.[0];
                    if (paper) error = Object.assign(new Error(paper.latestAnalysisAttemptError || paper.error || error.message), {
                        code: paper.latestAnalysisAttemptErrorCode, retryable: paper.latestAnalysisAttemptRetryable });
                }
                item.lastFailure = recovery.classifyFailure(error, item.updatedAt);
                item.lastError = item.lastFailure.message;
                item.retryNotBefore = new Date(Date.parse(item.updatedAt) + recovery.RETRY_COOLDOWN_MS).toISOString();
                if (item.lastFailure.systemic) next.batchFailure = item.lastFailure;
                changed = true;
            }
            if (options.retryFailed && (item.lastFailure || item.status === 'analyzing')) {
                item.retryReleases = [...(item.retryReleases || []), { at: deps.now(), attempts: item.attempts,
                    previousFailure: item.lastFailure || null }];
                item.retryBudgetStart = item.attempts; item.retryNotBefore = null;
                // 把失败留作证据，另外记录显式的重试许可。
                item.retryAuthorizedAtAttempt = item.attempts;
                if (item.status === 'analyzing') item.status = 'analysis_partial';
                changed = true;
            }
        }
        if (options.retryFailed && next.batchFailure) { next.batchFailure = null; changed = true; }
        if (!changed) return undefined;
        next.generation += 1; next.updatedAt = deps.now(); next.stateSha256 = stateDigest(next);
        return assertState(next, expected);
    }) || state;
    if (state.batchFailure && !options.retryFailed) {
        const review = publishReviewQueue(state);
        return { status: 'partial', processId,
            conferenceId: context.authority.conferenceId, stopped: true, batchFailure: state.batchFailure,
            complete: Object.values(state.items).filter(item => item.status === 'complete').length,
            failed: Object.values(state.items).filter(item => item.status !== 'complete').length,
            tagReview: review.tagReview, ...buildTagReviewQueueFields(review, directory) };
    }
    const sourceContext = { ...context, authority: { ...context.authority,
        implementationSha256: recovery.sourceImplementation(state, directory, module.exports) } };
    const shared = await (deps.prepareShared || prepareShared)(sourceContext, deps, state.createdAt);
    assertSourceContinuity(state, shared);
    const sourceByPaper = new Map(shared.sealed.map(item => [item.paperId, item.proof]));
    const updateItem = (paperId, expectedStatuses, updater) => deps.engine.updateJsonFileLocked(stateFile, current => {
        const checked = assertState(current, expected); const currentItem = checked.items[paperId];
        if (!currentItem || !Array.isArray(expectedStatuses) || expectedStatuses.length === 0) {
            throw new Error(`Conference process item CAS is invalid: ${paperId}`);
        }
        if (!expectedStatuses.includes(currentItem.status)) {
            if (currentItem.status === 'complete') return undefined;
            throw new Error(`Conference process item CAS failed: ${paperId} is ${currentItem.status}`);
        }
        const nextItem = updater(clone(currentItem));
        if (!nextItem || typeof nextItem !== 'object' || Array.isArray(nextItem)
            || (currentItem.status === 'complete' && nextItem.status !== 'complete')) {
            throw new Error(`Conference process refuses invalid item transition: ${paperId}`);
        }
        const next = clone(checked); next.items[paperId] = nextItem;
        next.updatedAt = deps.now(); next.status = 'running'; next.aggregate = null; next.completionReceiptSha256 = null;
        next.generation = checked.generation + 1;
        next.stateSha256 = stateDigest(next); return assertState(next, expected);
    });
    for (const member of context.members) {
        const current = assertState(JSON.parse(fs.readFileSync(stateFile)), expected).items[member.paperId];
        if (current.status === 'complete') continue;
        updateItem(member.paperId, [current.status], item => ({ ...item,
            status: item.status === 'pending' ? 'source_sealed' : item.status,
            sourceProof: sourceByPaper.get(member.paperId), updatedAt: deps.now() }));
    }
    const pending = context.members.map(member => assertState(JSON.parse(fs.readFileSync(stateFile)), expected).items[member.paperId])
        .filter(item => recovery.eligible(item, deps.now()));
    let stopped = false;
    await runWorkers(pending, options.concurrency, async item => {
        const claimed = updateItem(item.paperId, [item.status], current => ({ ...current,
            status: 'analyzing', attempts: current.attempts + 1,
            updatedAt: deps.now() }));
        if (claimed.items[item.paperId].status === 'complete') return;
        try {
            const proof = await (deps.processPaper || processOne)(context, shared, item, deps);
            updateItem(item.paperId, ['analyzing'], current => ({ ...current, ...proof,
                status: 'complete', lastError: null, lastFailure: null, reviewRequired: null,
                retryNotBefore: null, updatedAt: deps.now() }));
        } catch (error) {
            const failure = recovery.classifyFailure(error, deps.now());
            if (failure.systemic) stopped = true;
            updateItem(item.paperId, ['analyzing'], current => ({ ...current,
                status: 'analysis_partial', lastError: failure.message, lastFailure: failure,
                // 标签分配复核是显式的逐篇待定状态，通过复核队列报出，
                // 而不是报成普通失败。
                ...(error.tagReview
                    ? { reviewRequired: { ...error.tagReview, classifiedAt: failure.at } }
                    : {}),
                retryNotBefore: new Date(Date.parse(failure.at) + recovery.RETRY_COOLDOWN_MS).toISOString(), updatedAt: deps.now() }));
            if (failure.systemic) deps.engine.updateJsonFileLocked(stateFile, current => {
                const next = clone(assertState(current, expected)); next.batchFailure = failure;
                next.generation += 1; next.updatedAt = deps.now(); next.stateSha256 = stateDigest(next); return next;
            });
        }
    }, () => stopped);
    state = assertState(JSON.parse(fs.readFileSync(stateFile)), expected);
    let incomplete = Object.values(state.items).filter(item => item.status !== 'complete');
    if (incomplete.length) {
        state = deps.engine.updateJsonFileLocked(stateFile, current => {
            const checked = assertState(current, expected);
            if (Object.values(checked.items).every(item => item.status === 'complete')) return undefined;
            const next = clone(checked); next.status = 'partial'; next.aggregate = null;
            next.completionReceiptSha256 = null; next.updatedAt = deps.now();
            next.generation = checked.generation + 1; next.stateSha256 = stateDigest(next); return next;
        });
        state = assertState(state || JSON.parse(fs.readFileSync(stateFile)), expected);
        incomplete = Object.values(state.items).filter(item => item.status !== 'complete');
        if (incomplete.length) {
            const review = publishReviewQueue(state);
            return { status: 'partial', processId, conferenceId: context.authority.conferenceId,
                complete: context.members.length - incomplete.length, failed: incomplete.length,
                ...(state.batchFailure ? { stopped: true, batchFailure: state.batchFailure } : {}),
                deferred: incomplete.filter(item => !recovery.eligible(item, deps.now())).length,
                tagReview: review.tagReview, ...buildTagReviewQueueFields(review, directory) };
        }
    }
    // 每个成员都已完成：没有待定的标签分配复核，
    // 所以任何过期的队列附属文件都会在汇总/完成事务之前删掉。
    publishReviewQueue(state);
    assertRuntimeAuthorityUnchanged(context, deps, 'before aggregate');
    const executionIds = context.members.map(member => state.items[member.paperId].analysisRunId);
    const aggregate = await (deps.aggregate || (async () => deps.postprocess.aggregateConference({
        analysisRoot: deps.files.conferenceAnalysisDir, executionIds, tagCatalogPath: deps.files.tagCatalogFile,
        stagingRoot: deps.files.conferencePageStagingDir, aggregateRoot: deps.files.conferenceAggregateDir,
        planHandle: shared.planHandle, sourceRoot: shared.sourceCacheRoot, apply: true })))(context, shared, executionIds, deps);
    const aggregateProof = { manifestSha256: aggregate.manifest.manifestSha256,
        markdownSha256: aggregate.manifest.markdownSha256, aggregateId: aggregate.manifest.aggregateId,
        pagePath: aggregate.manifest.pagePath };
    const receiptBody = completionBodyFor(state, shared.planReceiptSha256, aggregateProof);
    const receipt = { ...receiptBody, receiptSha256: stableHash(receiptBody) };
    state = deps.engine.updateJsonFileLocked(stateFile, current => {
        assertRuntimeAuthorityUnchanged(context, deps, 'during final completion transaction');
        const checked = assertState(current, expected);
        if (Object.values(checked.items).some(item => item.status !== 'complete')) {
            throw new Error('Conference process completion transaction found incomplete items');
        }
        if (stableHash(completionBodyFor(checked, shared.planReceiptSha256, aggregateProof))
            !== stableHash(receiptBody)) {
            throw new Error('Conference process completion transaction drifted from its receipt');
        }
        exactFile(path.join(directory, 'completion-receipt.json'), canonicalBytes(receipt));
        const next = clone(checked);
        next.status = 'complete'; next.aggregate = aggregateProof; next.completionReceiptSha256 = receipt.receiptSha256;
        next.updatedAt = deps.now(); next.generation = current.generation + 1;
        next.stateSha256 = stateDigest(next); return assertState(next, expected); });
    validateCompletionReceipt(assertState(state, expected), receipt, shared.planReceiptSha256);
    return { status: 'complete', processId, conferenceId: context.authority.conferenceId,
        papers: context.members.length, completionReceiptSha256: receipt.receiptSha256, aggregate: aggregateProof,
        tagReview: 0 };
}

async function runConferenceProcess(options, overrides = {}) {
    if (!options || typeof options.apply !== 'boolean' || !Number.isInteger(options.concurrency)
        || (options.retryFailed !== undefined && typeof options.retryFailed !== 'boolean')
        || options.concurrency < 1 || options.concurrency > MAX_CONCURRENCY) {
        throw new Error('conference process requires explicit mode and concurrency 1-5');
    }
    const deps = { ...defaultDependencies(), ...overrides };
    const context = (deps.loadAuthority || loadAuthority)(options, deps);
    const processId = recovery.resolveProcess(context, deps, module.exports);
    if (!options.apply) return { status: 'dry-run', processId, conferenceId: context.authority.conferenceId,
        papers: context.members.length, concurrency: options.concurrency };
    const directory = safeProcessDirectory(deps.files.conferenceProcessDir, processId, true);
    const withProcessLock = deps.withProcessLock
        || ((target, callback, lockOptions) => deps.engine.withFileLock(target, callback, lockOptions));
    return withProcessLock(path.join(directory, '.operation'), () => (
        runConferenceProcessLocked(options, deps, context, processId, directory, PROCESS_OPERATION_LOCK_HELD)
    ), { recoveryPolicy: deps.engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY });
}

module.exports = { CONTRACT, LEGACY_CONTRACT, COMPLETION_CONTRACT, LEGACY_COMPLETION_CONTRACT,
    PROCESS_VERSION, COMPLETION_VERSION, LEGACY_VERSION, VERSION,
    authorityForComparison, authorityWithoutTagCatalog, authorityForExistingState,
    TAG_REVIEW_QUEUE_CONTRACT, TAG_REVIEW_QUEUE_FILE,
    MAX_CONCURRENCY, stableHash, deterministicUuid, canonicalBytes,
    DEEP_EXECUTION_CONFIG_CONTRACT, DEEP_EXECUTION_CONFIG_VERSION, DEEP_EXECUTION_LIMIT_FIELDS,
    deepExecutionConfigIdentity, assertDeepExecutionConfigIdentity, currentDeepExecutionConfigIdentity,
    assertRuntimeAuthorityUnchanged,
    stateDigest, assertState, completionBodyFor, validateCompletionReceipt, buildTagReviewQueue,
    writeTagReviewQueue, buildTagReviewQueueFields, defaultDependencies, loadAuthority,
    namesFor, sourceNames, sealOneSource, prepareShared,
    IMPLEMENTATION_FILES, IMPLEMENTATION_PROMPT_TEXT_VERSIONS, SOURCE_VERIFICATION_FILES, currentImplementationFiles,
    implementationSha256, processOne, runWorkers, assertSourceContinuity,
    runConferenceProcessLocked, runConferenceProcess, safeProcessDirectory, exactFile };
