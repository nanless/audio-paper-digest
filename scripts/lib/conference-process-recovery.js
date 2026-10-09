'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_ATTEMPTS = 3;
const RETRY_COOLDOWN_MS = 15 * 60 * 1000;

function readPrivateJson(filename) {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
        throw new Error(`Unsafe conference recovery file: ${filename}`);
    }
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
        const named = fs.lstatSync(filename);
        if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== bytes.length || after.size !== bytes.length
            || after.mtimeMs !== opened.mtimeMs || named.ino !== opened.ino || named.dev !== opened.dev
            || named.size !== bytes.length || named.nlink !== 1 || (named.mode & 0o777) !== 0o600) {
            throw new Error('Conference recovery file changed while reading');
        }
        return JSON.parse(bytes.toString('utf8'));
    } finally { fs.closeSync(fd); }
}

function classifyFailure(error, now) {
    // 调度器里不保存凭据、URL 或服务端响应正文。
    const message = String(error?.message || error || 'analysis failed')
        .replace(/https?:\/\/\S+/gi, '[URL]')
        .replace(/\b(api[_-]?key|authorization|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
        .replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]+/gi, '[REDACTED]').slice(0, 2000);
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : null;
    let category = 'paper';
    // 来源和后处理校验器有明确错误码，分类不受诊断措辞、语言或引用文本影响。
    if (['CONFERENCE_POSTPROCESS_INTEGRITY', 'CONFERENCE_SOURCE_CONTEXT_INTEGRITY',
        'CONFERENCE_EXTRACTION_RECEIPT_INTEGRITY'].includes(code)) category = 'integrity';
    else if (/insufficient.balance|GoUsageLimitError|quota.*exhaust|billing|ACCOUNT_POOL.*EXHAUST/i.test(`${code} ${message}`)) category = 'quota';
    // 认证失败同样必须同时认中英文：旧记录存英文，当前消息已汉化。
    // 前半段英文词逐字保持原样，后半段只加「authentication」的对应中文说法「认证失败」。
    // 有意不加「未授权」（unauthorized 的直译）：它出现在 deep-analyzer 的修复指引正文里，
    // 那段正文会被拼进「上一次输出被代码拒绝」这条错误消息，加进去会把单篇拒稿误判成
    // 整批停机的 authentication。
    else if (/HTTP\s*(401|403)\b|authentication|invalid.api.key|unauthorized|认证失败/i.test(message)) category = 'authentication';
    else if (/HTTP\s*429\b|rate.limit/i.test(message)) category = 'rate_limit';
    // Demo/资源核验只是单篇论文的可选证据。某个 demo 主机不可达时，
    // 这篇论文要能重试，但不能让整个会议批次停下来，
    // 好像分析器传输层不可用一样。
    else if (code === 'DEMO_TRANSIENT_FAILURE') category = 'paper';
    // 未解决的标签分配是确定的逐篇复核条件：它既不会让批次停下，也不会自己重试
    // （得先修好标签），并且通过复核队列报出。
    else if (code === 'CONFERENCE_TAG_REVIEW_REQUIRED'
        // 旧失败记录仍可读取；当前分类名称统一使用 tag_review。
        || code === 'CONFERENCE_TAXONOMY_REVIEW_REQUIRED') category = 'tag_review';
    else if (/^(?:ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|REQUEST_DEADLINE_EXCEEDED|REQUEST_SOCKET_TIMEOUT)$/.test(code)) category = 'paper';
    // 失败分类必须同时认英文和中文消息：旧失败记录里存的是英文，当前消息已汉化。
    // 前半段英文词必须逐字保持原样，否则旧记录的复算结果会变；
    // 后半段是英文词的对应中文说法（代理＝proxy，隧道＝CONNECT tunnel）。
    // 「代理」不能裸写：中文「代理项」指 Unicode surrogate，与 proxy 无关，故用 (?!项) 排除。
    else if (/HTTP\s*5\d\d\b|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|proxy|CONNECT tunnel|代理(?!项)|隧道/i.test(`${code} ${message}`)) category = 'transport';
    else if (/LLM_ACCOUNT_POOL_|model.*not.found|unsupported.model|missing.*API.key|implementation drifted|deep execution config drifted/i.test(`${code} ${message}`)) category = 'configuration';
    else if (code === 'CONFERENCE_SOURCE_UPGRADE_REBIND_REQUIRED') category = 'source_upgrade';
    // 失败分类必须同时认英文和中文消息：旧失败记录里存的是英文，当前消息已汉化。
    // 前半段英文词必须逐字保持原样，否则旧记录的复算结果会变；
    // 后半段是英文词的对应中文说法（不安全／不一致／完整性／已漂移／非规范／SHA 不符）。
    else if (/integrity|SHA.*mismatch|authority.*drift|unsafe|non.canonical|不安全|不一致|完整性|已漂移|非规范|SHA\s*不符/i.test(message)) category = 'integrity';
    const systemic = ['quota', 'authentication', 'rate_limit', 'transport', 'configuration'].includes(category);
    return { category, code, message, systemic,
        retryable: !['quota', 'authentication', 'integrity', 'configuration', 'source_upgrade',
            'tag_review'].includes(category) && error?.retryable !== false, at: now };
}

function eligible(item, now) {
    if (item.status === 'complete') return false;
    if (item.status === 'analyzing') return false; // 请求被中断：结果可能已经计费。
    // 旧抽取凭证失败可能曾被记为可重试；按稳定错误码检查，不改写旧失败记录。
    if ((item.lastFailure?.retryable === false
        || item.lastFailure?.code === 'CONFERENCE_EXTRACTION_RECEIPT_INTEGRITY')
        && item.retryAuthorizedAtAttempt !== item.attempts) return false;
    if (item.attempts - (item.retryBudgetStart || 0) >= MAX_ATTEMPTS) return false;
    return !item.retryNotBefore || Date.parse(now) >= Date.parse(item.retryNotBefore);
}

function resolveProcess(context, deps, api) {
    const root = deps.files.conferenceProcessDir;
    api.authorityForComparison(context.authority, api.PROCESS_VERSION);
    const derived = api.deterministicUuid(api.stableHash(context.authority), api.CONTRACT);
    if (!fs.existsSync(root)) return derived;
    const matches = [], older = [];
    const withoutImplementation = (value, version) => {
        const copy = api.authorityForComparison(value, version);
        delete copy.implementationSha256;
        return copy;
    };
    for (const id of fs.readdirSync(root).filter(name => /^[a-f0-9-]{36}$/.test(name))) {
        const directory = api.safeProcessDirectory(root, id, false), filename = path.join(directory, 'state.json');
        if (!fs.existsSync(filename)) continue;
        const saved = readPrivateJson(filename);
        // 先筛选来源、配置和词表值，跳过无关任务；此处不授予任何恢复资格。
        // 匹配后仍须核验原完整摘要、格式和字段族，再作正式身份比较。
        const candidateAuthority = { ...(saved?.authority || {}) };
        const currentAuthority = { ...context.authority };
        for (const key of ['implementationSha256', 'taxonomyVersion', 'taxonomyRegistrySha256', 'tagCatalogVersion', 'tagCatalogSha256']) {
            delete candidateAuthority[key];
            delete currentAuthority[key];
        }
        if (api.stableHash(candidateAuthority) !== api.stableHash(currentAuthority)) continue;
        // 同一来源和配置下的混用字段不能因空值被当作无关词表跳过。
        // 先核原状态摘要，再由正式字段检查拒绝混用。
        const hasCurrentCatalog = ['tagCatalogVersion', 'tagCatalogSha256'].some(key => Object.hasOwn(saved.authority || {}, key));
        const hasLegacyCatalog = ['taxonomyVersion', 'taxonomyRegistrySha256'].some(key => Object.hasOwn(saved.authority || {}, key));
        if (hasCurrentCatalog && hasLegacyCatalog) api.assertState(saved);
        const candidateCatalog = {
            version: Object.hasOwn(saved.authority || {}, 'tagCatalogVersion')
                ? saved.authority.tagCatalogVersion : saved.authority?.taxonomyVersion,
            sha256: Object.hasOwn(saved.authority || {}, 'tagCatalogSha256')
                ? saved.authority.tagCatalogSha256 : saved.authority?.taxonomyRegistrySha256
        };
        if (api.stableHash(candidateCatalog) !== api.stableHash({ version: context.authority.tagCatalogVersion,
            sha256: context.authority.tagCatalogSha256 })) continue;
        const state = api.assertState(saved);
        if (api.stableHash(withoutImplementation(state.authority, state.version))
            !== api.stableHash(withoutImplementation(context.authority, api.PROCESS_VERSION))) continue;
        if (state.processId !== id) throw new Error('Conference process directory identity mismatch');
        if (api.stableHash(api.authorityForComparison(state.authority, state.version))
            !== api.stableHash(api.authorityForComparison(context.authority, api.PROCESS_VERSION))) {
            // 进程可能在共享来源准备阶段就失败，这时还没有任何条目完成保存与核验，
            // 也没有分析。在这种没有进展的窄情况下，实现变更不会让分析失效
            // （本来就没有分析要保留），所以可以让新实现派生新的进程命名空间，
            // 同时保留旧检查点供审计。
            // 一旦任何条目有进展，就必须走正常的显式迁移规则。
            const untouched = state.status === 'pending'
                && Object.values(state.items || {}).every(item => item.status === 'pending'
                    && item.attempts === 0 && !item.sourceProof && !item.analysisProof && !item.pageProof);
            older.push({ id, untouched }); continue;
        }
        api.assertState(state, { authority: context.authority, paperIds: context.members.map(item => item.paperId).sort() });
        if (state.sourceUpgradePromotion) {
            sourceImplementation(state, directory, api);
        } else if (id !== api.deterministicUuid(api.stableHash(state.authority), state.contract)) {
            const records = fs.readdirSync(directory).filter(name => /^implementation-migration(?:-[a-f0-9]{12})?\.json$/.test(name))
                .map(name => readPrivateJson(path.join(directory, name)));
            const record = records.find(value => value.toImplementationSha256 === state.authority.implementationSha256);
            if (!record && !state.sourceImplementationSha256) throw new Error('Migrated process lacks recovery provenance');
            for (const value of records) {
                const { receiptSha256, ...body } = value;
                if (value.processId !== id || receiptSha256 !== api.stableHash(body)) throw new Error('Migration receipt integrity failed');
            }
            sourceImplementation(state, directory, api);
        }
        matches.push({ id, promoted: Boolean(state.sourceUpgradePromotion), worked: Object.values(state.items).some(item => item.attempts > 0 || item.status !== 'pending') });
    }
    const worked = matches.filter(item => item.worked);
    const promoted = worked.filter(item => item.promoted);
    if (promoted.length === 1) return promoted[0].id;
    if (worked.length > 1) throw new Error('Multiple progressed conference processes match; use explicit migration --from');
    if (worked.length) return worked[0].id;
    if (matches.length) return matches.find(item => item.id === derived)?.id || matches[0].id;
    const untouchedOlder = older.filter(item => item.untouched);
    if (older.length && untouchedOlder.length === older.length) return derived;
    if (older.length) throw new Error(`Conference implementation changed; migrate with --from ${older.map(item => item.id).join(' or ')} to preserve analysis`);
    return derived;
}

function sourceImplementation(state, directory, api, ancestry = new Set()) {
    api.assertState(state);
    if (ancestry.has(state.processId) || ancestry.size >= 64) throw new Error('Promotion provenance contains a cycle');
    const parents = new Set(ancestry); parents.add(state.processId);
    const withoutImplementation = (value, version) => {
        const copy = api.authorityForComparison(value, version);
        delete copy.implementationSha256;
        return copy;
    };
    if (state.sourceUpgradePromotion) {
        const promotion = state.sourceUpgradePromotion;
        const savedPlan = require('./conference-source-upgrade.js').assertSourceUpgradePlan(
            readPrivateJson(path.join(directory, 'source-upgrade-plan.json')));
        const { planSha256, ...plan } = savedPlan;
        if (planSha256 !== api.stableHash(plan) || planSha256 !== promotion.planSha256
            || plan.version !== state.version
            // 已晋升的进程之后可能走一次显式的实现迁移。来源升级计划本身受签名保护，
            // 因此必然保留晋升时的权威指纹，而检查点记录的是当前实现。
            // 来源、筛选、成员的权威必须仍然一致，只有这个经过审计的实现字段可以前进。
            || api.stableHash(withoutImplementation(plan.authority, plan.version))
                !== api.stableHash(withoutImplementation(state.authority, state.version))
            || plan.fromProcessId !== promotion.originalProcessId
            || plan.sourceImplementationSha256 !== promotion.sourceImplementationSha256
            || api.stableHash(plan.pageRepairPolicy || null) !== api.stableHash(promotion.pageRepairPolicy || null)
            || api.stableHash(plan.papers.map(item => item.paperId).sort()) !== api.stableHash(Object.keys(state.items).sort())) {
            throw new Error('Source upgrade promotion plan integrity failed');
        }
        // 父进程 UUID 绑定的是它发放的权威，而不是晋升计划里更新的那份登记记录。
        // 重新打开已签名的父状态。
        const parentDirectory = api.safeProcessDirectory(path.dirname(directory), plan.fromProcessId, false);
        const parent = api.assertState(readPrivateJson(path.join(parentDirectory, 'state.json')));
        if (parent.processId !== plan.fromProcessId || parent.stateSha256 !== plan.originalStateSha256
            || api.stableHash(Object.keys(parent.items).sort()) !== api.stableHash(Object.keys(state.items).sort())) {
            throw new Error('Promotion parent state does not bind the original plan');
        }
        const parentSource = sourceImplementation(parent, parentDirectory, api, parents);
        const sourceAuthority = (value, version) => {
            const copy = api.authorityWithoutTagCatalog(value, version);
            delete copy.implementationSha256;
            return copy;
        };
        if (parentSource !== plan.sourceImplementationSha256
            || api.stableHash(sourceAuthority(parent.authority, parent.version)) !== api.stableHash(sourceAuthority(plan.authority, plan.version))
            || plan.papers.some(item => parent.items[item.paperId]?.analysisRunId !== item.previousExecutionId
                || parent.items[item.paperId]?.status !== item.previousStatus
                || parent.items[item.paperId]?.sourceIdentity !== state.items[item.paperId]?.sourceIdentity)
            || (parent.sourceUpgradePromotion
                ? api.deterministicUuid(parent.sourceUpgradePromotion.planSha256, 'conference-source-upgrade-process-v1')
                : api.deterministicUuid(api.stableHash({ ...parent.authority, implementationSha256: parentSource }),
                    parent.contract)) !== parent.processId) {
            throw new Error('Promotion parent source/authority/UUID integrity failed');
        }
        if (parent.status === 'complete') api.validateCompletionReceipt(parent,
            readPrivateJson(path.join(parentDirectory, 'completion-receipt.json')));
        return promotion.sourceImplementationSha256;
    }
    const bindsOrigin = implementationSha256 => /^[a-f0-9]{64}$/.test(implementationSha256 || '')
        && api.deterministicUuid(api.stableHash({ ...state.authority, implementationSha256 }), state.contract) === state.processId;
    if (state.sourceImplementationSha256) {
        if (!bindsOrigin(state.sourceImplementationSha256)) throw new Error('Source implementation does not bind original process UUID');
    }
    const records = fs.readdirSync(directory).filter(name => /^implementation-migration(?:-[a-f0-9]{12})?\.json$/.test(name))
        .map(name => readPrivateJson(path.join(directory, name)));
    for (const value of records) {
        const { receiptSha256, ...body } = value;
        if (value.contract !== 'conference-process-implementation-migration-v1' || value.version !== 1
            || value.processId !== state.processId || value.conferenceId !== state.authority.conferenceId
            || !/^[a-f0-9]{64}$/.test(value.fromImplementationSha256 || '')
            || !/^[a-f0-9]{64}$/.test(value.toImplementationSha256 || '')
            || receiptSha256 !== api.stableHash(body)) throw new Error('Migration receipt integrity failed');
    }
    if (state.sourceImplementationSha256) return state.sourceImplementationSha256;
    let implementation = state.authority.implementationSha256;
    const visited = new Set();
    while (!bindsOrigin(implementation)) {
        if (visited.has(implementation)) throw new Error('Migration provenance contains a cycle');
        visited.add(implementation);
        const parents = [...new Set(records.filter(value => value.toImplementationSha256 === implementation)
            .map(value => value.fromImplementationSha256))];
        if (parents.length !== 1) throw new Error('Migration provenance is missing or ambiguous before original process UUID');
        implementation = parents[0];
    }
    return implementation;
}

module.exports = { MAX_ATTEMPTS, RETRY_COOLDOWN_MS, readPrivateJson, classifyFailure, eligible, resolveProcess, sourceImplementation };
