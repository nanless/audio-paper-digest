'use strict';

// Reader 候选只是恢复用的输入，从来不能当作生产凭证。每个合并进来的
// 候选仍然要通过调用方完整的 Reader 解析和来源核验。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { READER_LIMITS } = require('./reader-contract.js');
const { locateReaderDraftTables, TABLE_BINDING_ORDER_ISSUE_CODE, READER_SECTION_KINDS } = require('./reader-draft-order.js');

const REPAIR_VERSION = 'reader-node-repair-v1';
const ARRAY_FIELDS = ['sections', 'conceptBridges', 'figurePlacements', 'tableBindings', 'formulaBindings'];
const ROOT_FIELDS = ['version', 'readerTitle', 'oneSentenceThesis', ...ARRAY_FIELDS];
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_RECOVERY_SECTIONS = 64;
const VALIDATION_SIGNATURE_PREFIX = 'reader-validation-v2:';
const IMPLEMENTATION_ALLOWANCE_CONTRACT = 'reader-implementation-repair-allowance-v1';
const IMPLEMENTATION_ALLOWANCE_LINEAGE_CONTRACT = 'reader-implementation-repair-lineage-v1';
const IMPLEMENTATION_ALLOWANCE_FIELDS = new Set(['repairImplementationSha256', 'tableCompilerSha256',
    'draftOrderImplementationSha256', 'sourceDiagnosticsImplementationSha256',
    'parserImplementationSha256', 'editorialImplementationSha256', 'mechanicalContractSha256',
    'readerRecoveryEpochSha256']);
const hashDraft = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const shaText = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
// 按 Unicode 码点比较，结果与 Python 的 sorted() 一致。
// 不能直接用 < 比较：JS 比的是 UTF-16 码元，遇到 emoji 这类非 BMP 字符会排出
// 与码点不同的顺序（例如 U+1F600 会排到 U+FFFD 前面）。
const codePointCompare = (a, b) => {
    const left = Array.from(String(a), char => char.codePointAt(0));
    const right = Array.from(String(b), char => char.codePointAt(0));
    const shared = Math.min(left.length, right.length);
    for (let index = 0; index < shared; index += 1) {
        if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
    }
    return left.length === right.length ? 0 : (left.length < right.length ? -1 : 1);
};
// 这个文件有两种排序，用途不同，不要混用：
// codePointCompare 按码点比较，用于必须与 Python 的 sorted() 对齐的地方；
// codeUnitCompare 按 UTF-16 码元比较，与 Array#sort() 的默认顺序一致，用于
// 校验由 .sort() 规范化过的字段列表。两者只在非 BMP 字符上不同。
const codeUnitCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const TABLE_COUNT_ISSUE_CODE = 'reader_table_count_insufficient';
const LEGACY_TABLE_BINDING_ORDER_MESSAGE = 'Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格';
const TABLE_BINDING_ORDER_ERROR_CODE = 'READER_DRAFT_ORDER_AMBIGUOUS';
const TABLE_BINDING_ORDER_COMPARISON_MESSAGES = Object.freeze({
    'invalid-typed': '表格对应诊断的字段无效',
    'invalid-legacy': '旧格式表格对应诊断的字段无效',
    'code-conflict': '表格对应诊断的代码与旧格式说明不一致',
    'invalid-error': '表格对应异常的子项未通过核验'
});

function classifyTableBindingOrderIssue(issue) {
    let kind = 'unrelated';
    if (issue && typeof issue === 'object' && !Array.isArray(issue)) {
        const defaultCode = issue.code === undefined || issue.code === null || issue.code === '';
        if (issue.code === TABLE_BINDING_ORDER_ERROR_CODE
            || (defaultCode && issue.path === null && issue.message === LEGACY_TABLE_BINDING_ORDER_MESSAGE
                && own(issue, 'readerIssues'))) {
            kind = 'invalid-error';
        } else if (issue.code === TABLE_BINDING_ORDER_ISSUE_CODE
            || issue.message === LEGACY_TABLE_BINDING_ORDER_MESSAGE) {
            if (issue.code !== TABLE_BINDING_ORDER_ISSUE_CODE && !defaultCode) {
                kind = 'code-conflict';
            } else {
                const match = typeof issue.path === 'string'
                    ? /^(?:\/sections\/(0|[1-9]\d*)\/body|\/tableBindings\/(0|[1-9]\d*))$/.exec(issue.path) : null;
                const validPath = own(issue, 'path') && (issue.path === null || (match
                    && match[0] === issue.path && Number.isSafeInteger(Number(match[1] ?? match[2]))));
                const valid = validPath && typeof issue.message === 'string'
                    && (!own(issue, 'diagnosticOnly') || typeof issue.diagnosticOnly === 'boolean');
                kind = issue.code === TABLE_BINDING_ORDER_ISSUE_CODE
                    ? (valid ? 'typed' : 'invalid-typed') : (valid ? 'legacy' : 'invalid-legacy');
            }
        }
    }
    return { kind, actionable: ['typed', 'legacy'].includes(kind) && issue.diagnosticOnly !== true,
        ignoreMessageForRepair: kind !== 'unrelated', issue };
}

function readTableBindingOrderIssue(issue) {
    const result = classifyTableBindingOrderIssue(issue);
    return ['typed', 'legacy'].includes(result.kind) ? issue : null;
}

function classifyTableBindingOrderError(error) {
    const unrelated = { kind: 'unrelated', validOrderError: false, actionable: false,
        ignoreMessageForRepair: false, summary: null, readerIssues: [] };
    const legacy = () => ({ kind: 'legacy', validOrderError: true, actionable: true,
        ignoreMessageForRepair: true, summary: { path: null, message: LEGACY_TABLE_BINDING_ORDER_MESSAGE,
            code: TABLE_BINDING_ORDER_ISSUE_CODE }, readerIssues: [] });
    if (typeof error === 'string') return error === LEGACY_TABLE_BINDING_ORDER_MESSAGE ? legacy() : unrelated;
    if (!(error instanceof Error)) return unrelated;
    const readerIssues = own(error, 'readerIssues') ? error.readerIssues : [];
    if (error.code === TABLE_BINDING_ORDER_ERROR_CODE) {
        const children = Array.isArray(readerIssues) ? readerIssues.map(classifyTableBindingOrderIssue) : [];
        const valid = (!own(error, 'diagnosticOnly') || error.diagnosticOnly === false)
            && typeof error.message === 'string' && children.length > 0
            && children.every(child => child.actionable && child.kind === children[0].kind
                && child.issue.message === error.message);
        const summary = valid
            ? { path: null, message: error.message, code: TABLE_BINDING_ORDER_ISSUE_CODE }
            : { path: null, code: error.code, message: error.message };
        if (!valid && own(error, 'readerIssues')) summary.readerIssues = readerIssues;
        if (!valid && own(error, 'diagnosticOnly')) summary.diagnosticOnly = error.diagnosticOnly;
        return { kind: valid ? children[0].kind : 'invalid-error', validOrderError: valid,
            actionable: valid, ignoreMessageForRepair: true, summary, readerIssues };
    }
    if (error.code === TABLE_BINDING_ORDER_ISSUE_CODE || own(error, 'path') || own(error, 'diagnosticOnly')) {
        const result = classifyTableBindingOrderIssue(error);
        if (!result.ignoreMessageForRepair) return unrelated;
        const summary = Object.fromEntries(Object.getOwnPropertyNames(error)
            .filter(key => key !== 'stack').map(key => [key, error[key]]));
        return { kind: result.kind, validOrderError: false, actionable: result.actionable,
            ignoreMessageForRepair: true, summary, readerIssues };
    }
    if (error.message !== LEGACY_TABLE_BINDING_ORDER_MESSAGE) return unrelated;
    const defaultCode = error.code === undefined || error.code === null || error.code === '';
    if (defaultCode && !own(error, 'readerIssues')) return legacy();
    const summary = { path: null, message: error.message };
    if (own(error, 'code')) summary.code = error.code;
    if (own(error, 'readerIssues')) summary.readerIssues = readerIssues;
    return { kind: defaultCode ? 'invalid-error' : 'code-conflict', validOrderError: false,
        actionable: false, ignoreMessageForRepair: true, summary, readerIssues };
}

function readTableBindingOrderError(error) {
    const result = classifyTableBindingOrderError(error);
    return result.validOrderError ? result : null;
}

function projectTableBindingOrderIssue(issue, result, keepCode = false) {
    if (result.kind === 'legacy') return issue;
    const message = result.kind === 'typed' ? LEGACY_TABLE_BINDING_ORDER_MESSAGE
        : TABLE_BINDING_ORDER_COMPARISON_MESSAGES[result.kind];
    return Object.fromEntries(Object.entries(issue).flatMap(([key, value]) => {
        if (!keepCode && result.kind === 'typed' && key === 'code') return [];
        if (key === 'message' && typeof value === 'string') return [[key, message]];
        if (!keepCode && result.kind === 'invalid-error' && issue.code === TABLE_BINDING_ORDER_ERROR_CODE
            && key === 'readerIssues' && Array.isArray(value)) {
            return [[key, value.map(child => {
                const classified = classifyTableBindingOrderIssue(child);
                return classified.ignoreMessageForRepair && typeof child.message === 'string'
                    ? projectTableBindingOrderIssue(child, classified, true) : child;
            })]];
        }
        return [[key, value]];
    }));
}

function readTableCountIssue(issue) {
    let requiredCount, actualCount;
    if (issue?.code === TABLE_COUNT_ISSUE_CODE) {
        ({ requiredCount, actualCount } = issue);
    } else {
        // 早期保存下来的诊断，只在这一段固定消息里带计数；这句措辞改过一次，
        // 所以新旧两种说法都要认。已经带 code 的诊断，绝不允许从散文消息里
        // 去补缺失字段。
        if (issue?.code !== undefined && issue?.code !== null && issue?.code !== '') return null;
        const match = /至少需要\s*(\d+)\s*张[^，\s]{2,16}的\s*Markdown\s*表，当前\s*(\d+)/
            .exec(String(issue?.message || ''));
        if (!match) return null;
        requiredCount = Number(match[1]);
        actualCount = Number(match[2]);
    }
    if (!Number.isSafeInteger(requiredCount) || requiredCount < 1
        || !Number.isSafeInteger(actualCount) || actualCount < 0
        || actualCount >= requiredCount) return null;
    return { requiredCount, actualCount };
}

function recoveryIssueProjection(issue) {
    const orderIssue = classifyTableBindingOrderIssue(issue);
    if (orderIssue.ignoreMessageForRepair) return projectTableBindingOrderIssue(issue, orderIssue);
    if (issue?.code !== TABLE_COUNT_ISSUE_CODE) return issue;
    const counts = readTableCountIssue(issue);
    // 这里保留的是 v1 候选和 v2 失败签名用到的比较输入。这段兼容文本
    // 不会作为展示消息。
    //
    // 这句旧文本参与 gateSha256 和 failureSignature 的计算，已有失败候选按它保存。
    // 这里继续使用原句核对旧记录，避免同一表格计数失败少记一次「无进展」，
    // 进而多发一次修复请求。它不作为显示消息；显示措辞由当前诊断另行提供。
    // 上面的正则可读取新旧措辞中的计数，原签名输入仍保持不变。
    const projected = counts
        ? { path: issue.path ?? null,
            message: `读者文章至少需要 ${counts.requiredCount} 张有叙事闭环的 Markdown 表，当前 ${counts.actualCount}` }
        : { path: issue.path ?? null, code: TABLE_COUNT_ISSUE_CODE,
            message: '表格数量诊断的计数无效' };
    for (const [key, value] of Object.entries(issue)) {
        if (!['path', 'message', 'code', 'requiredCount', 'actualCount'].includes(key)) projected[key] = value;
    }
    return projected;
}

function hashRecoveryIssues(issues) {
    return hashDraft(issues.map(recoveryIssueProjection));
}

function normalizeValidationMessage(message) {
    return String(message || '')
        // exact 绑定失败的草稿取值会变，而同一个行/列可能一直没绑上。结构坐标
        // 和检查名称要留着，易变的单元格内容和缺失值要去掉。
        .replace(/(关键数字缺少 exact quote\/cell 证据:)\s*[^；]+/giu, '$1 <values>')
        .replace(/\btext="[^"]*"/giu, 'text="<value>"')
        .replace(/\bmissing=[^。；，]+/giu, 'missing=<value>')
        // 篇幅和计数类诊断应当收敛，哪怕一次修复让数量差了几个字符。
        // 必需的阈值保持原样。
        .replace(/(当前|已有|现有|仍缺|还缺|缺少|不足|多出|超出|超过)\s*\d+(?:\.\d+)?/gu,
            (surface, label) => `${['已有', '现有'].includes(label) ? '当前'
                : ['还缺', '缺少', '不足'].includes(label) ? '仍缺'
                    : ['超出', '超过'].includes(label) ? '多出' : label} <value>`);
}

function validationDeficits(message, coordinate) {
    const text = String(message || '');
    const patterns = [
        { kind: 'remaining', direction: 'lower', expression: /(?:仍缺|还缺|缺少|不足)\s*(\d+(?:\.\d+)?)/gu },
        { kind: 'overflow', direction: 'lower', expression: /(?:多出|超出|超过)\s*(\d+(?:\.\d+)?)/gu },
        { kind: 'current', direction: 'higher', expression: /(?:当前|已有|现有)\s*(\d+(?:\.\d+)?)/gu }
    ];
    return patterns.flatMap(({ kind, direction, expression }) => [...text.matchAll(expression)]
        .map((match, index) => ({ key: `${coordinate}\0${kind}\0${index}`, direction,
            value: Number(match[1]) })));
}

function validationFailureSignature(issues) {
    const values = Array.isArray(issues) ? issues : [];
    const blocking = values.filter(issue => issue?.diagnosticOnly !== true);
    const selected = (blocking.length ? blocking : values).map(recoveryIssueProjection);
    const gates = selected.map(issue => ({ path: issue?.path ?? null, code: issue?.code || null,
        message: normalizeValidationMessage(issue?.message) }))
        .sort((a, b) => codePointCompare(JSON.stringify(a), JSON.stringify(b)));
    const deficits = selected.flatMap(issue => {
        const gate = { path: issue?.path ?? null, code: issue?.code || null,
            message: normalizeValidationMessage(issue?.message) };
        return validationDeficits(issue?.message, JSON.stringify(gate));
    }).sort((a, b) => codePointCompare(a.key, b.key));
    return VALIDATION_SIGNATURE_PREFIX + JSON.stringify({ gateSha256: hashDraft(gates), deficits });
}

function parseValidationFailureSignature(signature) {
    if (!String(signature || '').startsWith(VALIDATION_SIGNATURE_PREFIX)) return null;
    try {
        const parsed = JSON.parse(String(signature).slice(VALIDATION_SIGNATURE_PREFIX.length));
        if (!/^[a-f0-9]{64}$/.test(parsed?.gateSha256 || '') || !Array.isArray(parsed.deficits)
            || parsed.deficits.some(item => !item || typeof item.key !== 'string'
                || !['lower', 'higher'].includes(item.direction) || !Number.isFinite(item.value))) return null;
        return parsed;
    } catch { return null; }
}

function validationFailureHasNoProgress(previousSignature, currentSignature) {
    if (!previousSignature) return false;
    if (previousSignature === currentSignature) return true;
    const previous = parseValidationFailureSignature(previousSignature);
    const current = parseValidationFailureSignature(currentSignature);
    if (!previous || !current || previous.gateSha256 !== current.gateSha256) return false;
    const before = new Map(previous.deficits.map(item => [item.key, item]));
    const after = new Map(current.deficits.map(item => [item.key, item]));
    if (before.size !== after.size || [...before.keys()].some(key => !after.has(key))) return true;
    let improved = false;
    for (const [key, prior] of before) {
        const next = after.get(key);
        if (prior.direction !== next.direction) return true;
        const delta = prior.direction === 'lower' ? prior.value - next.value : next.value - prior.value;
        if (delta < 0) return true;
        if (delta > 0) improved = true;
    }
    return !improved;
}

function hasUnusedImplementationAllowance(payload) {
    const proof = payload?.implementationRepairAllowanceProof;
    if (!proof || (payload.consumedImplementationAllowanceSha256 || []).includes(proof.allowanceSha256)) return false;
    const audit = (payload.readerRecoveryRevisions || []).find(item => hashDraft(item) === proof.revisionAuditSha256);
    if (!audit || !Number.isSafeInteger(audit.attempts) || !Number.isSafeInteger(audit.fullAttempts)) {
        throw new Error('Reader 实现许可缺少原始已用次数');
    }
    return payload.attempts <= audit.attempts && payload.fullAttempts <= audit.fullAttempts;
}

function readerAttemptLimit(maxAttempts, completedAttempts, candidate, implementationRepairAllowance) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1
        || !Number.isInteger(completedAttempts) || completedAttempts < 0
        || ![0, 1].includes(implementationRepairAllowance)) {
        throw new Error('Reader attempt limit received invalid counters');
    }
    return Math.max(maxAttempts,
        completedAttempts + (candidate && implementationRepairAllowance === 1 ? 1 : 0));
}

function readAllowanceEnvelope(filename) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES || (stat.mode & 0o777) !== 0o600) {
            throw new Error('Reader implementation allowance source envelope is unsafe');
        }
        const bytes = fs.readFileSync(fd); return { bytes, envelope: JSON.parse(bytes.toString('utf8')) };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function validateImplementationAllowance(payload, identity, directory) {
    const proof = payload?.implementationRepairAllowanceProof;
    if (proof === undefined || proof === null) return false;
    if (proof.contract === 'reader-repair-prompt-unused-allowance-transfer-v1') {
        const keys = ['contract', 'fromIdentitySha256', 'toIdentitySha256', 'oldPayloadSha256',
            'revisionAuditSha256', 'originalAllowanceSha256', 'allowanceSha256'];
        const audit = payload.readerRecoveryRevisions?.at(-1);
        const body = { ...proof }; delete body.allowanceSha256;
        const from = String(proof.fromIdentitySha256 || '');
        if (Object.keys(proof).sort().join('\0') !== keys.sort().join('\0')
            || !audit || audit.contract !== 'reader-recovery-diagnostics-revision-v1'
            || hashDraft(audit) !== proof.revisionAuditSha256
            || audit.fromIdentitySha256 !== from || audit.toIdentitySha256 !== hashDraft(identity)
            || proof.toIdentitySha256 !== hashDraft(identity)
            || proof.oldPayloadSha256 !== audit.oldPayloadSha256
            || hashDraft(body) !== proof.allowanceSha256
            || hashDraft(audit.changedFields) !== hashDraft(['repairPromptSha256'])
            || !new RegExp(`^${from}\\.migrated-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.json$`).test(String(audit.archivedName || ''))
            || !/^[a-f0-9]{64}$/.test(from)) throw new Error('修复提示词升级的原未用许可证明无效');
        const absolute = assertSafeDirectory(directory);
        let old;
        try { old = readAllowanceEnvelope(path.join(absolute, audit.archivedName)); }
        catch (error) { if (error.code !== 'ENOENT') throw error;
            old = readAllowanceEnvelope(path.join(absolute, `${from}.json`)); }
        const envelope = old.envelope;
        const original = envelope?.payload;
        const oldIdentity = envelope?.identity;
        const omitPrompt = value => Object.fromEntries(Object.entries(value || {})
            .filter(([key]) => key !== 'repairPromptSha256'));
        if (crypto.createHash('sha256').update(old.bytes).digest('hex') !== audit.oldEnvelopeSha256
            || hashDraft(oldIdentity) !== from || envelope.payloadSha256 !== audit.oldPayloadSha256
            || hashDraft(original) !== audit.oldPayloadSha256
            || oldIdentity.repairPromptSha256 !== 'c63148bca8bed36a8c31b0327b87e2a1e9ddf51fd8641813827f5e8f1eb4a6ec'
            || identity.repairPromptSha256 !== '8d1483030d1167b9ac3b81602c267ae5e5ec0fc5e88fb7308aea5f1e2a52d470'
            || !require('node:util').isDeepStrictEqual(omitPrompt(oldIdentity), omitPrompt(identity))
            || original.implementationRepairAllowanceProof?.allowanceSha256 !== proof.originalAllowanceSha256
            || original.implementationRepairAllowanceLineage !== IMPLEMENTATION_ALLOWANCE_LINEAGE_CONTRACT
            || (original.consumedImplementationAllowanceSha256 || []).includes(proof.originalAllowanceSha256)
            || !require('node:util').isDeepStrictEqual(payload.consumedImplementationAllowanceSha256 || [],
                original.consumedImplementationAllowanceSha256 || [])
            || (payload.consumedImplementationAllowanceSha256 || []).includes(proof.allowanceSha256)
            || payload.implementationRepairAllowanceLineage !== original.implementationRepairAllowanceLineage
            || ['attempts', 'fullAttempts', 'noProgress'].some(key =>
                !require('node:util').isDeepStrictEqual(payload[key], original[key]))
            || !Number.isSafeInteger(payload.transportFailures ?? 0)
            || (payload.transportFailures ?? 0) < (original.transportFailures ?? 0)
            || audit.attempts !== original.attempts || audit.fullAttempts !== original.fullAttempts
            || audit.oldNoProgress !== original.noProgress
            || audit.transportFailures !== (original.transportFailures ?? 0)
            || audit.paperId !== identity.paperId
            || audit.runId !== original.readerRecoveryRevisions?.at(-1)?.runId
            || audit.scope !== original.readerRecoveryRevisions?.at(-1)?.scope) {
            throw new Error('修复提示词升级不能改变原许可、来源或已用次数');
        }
        // 旧许可仍须通过原公共验证；这里只转交尚未使用的一次许可。
        if (!validateImplementationAllowance(original, oldIdentity, absolute)) {
            throw new Error('修复提示词升级缺少有效的原未用许可');
        }
        return true;
    }
    const keys = ['contract', 'fromIdentitySha256', 'toIdentitySha256', 'oldPayloadSha256',
        'revisionAuditSha256', 'changedFields', 'allowanceSha256'];
    const audits = Array.isArray(payload.readerRecoveryRevisions) ? payload.readerRecoveryRevisions : [];
    const audit = audits.at(-1); const body = proof && { ...proof }; if (body) delete body.allowanceSha256;
    const fromIdentity = String(proof?.fromIdentitySha256 || '');
    const archivePattern = new RegExp(`^${fromIdentity}\\.migrated-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.json$`);
    const conference = identity?.freshAnalysis?.runId ? null
        : require('./conference-analysis-context.js').getConferenceAnalysisContext();
    const direct = identity?.freshAnalysis?.runId || conference?.executionId ? null
        : require('./direct-rewrite-analysis-context.js').getDirectRewriteAnalysisContext();
    const directPaperId = String(direct?.paperId || '').replace(/^arxiv:/, '');
    const directScopeValid = Boolean(direct?.runId)
        && audit?.scope === 'historical-direct'
        && audit?.runId === direct.runId
        && audit?.paperId === directPaperId
        && identity?.paperId === directPaperId
        && identity?.sourceSha256 === direct.sourceSha256
        && typeof directory === 'string'
        && path.resolve(directory) === path.resolve(direct.readerAttemptsDir);
    const conferenceScopeValid = Boolean(conference?.executionId)
        && audit?.scope === 'conference-process'
        && audit?.runId === conference.executionId
        && audit?.paperId === conference.paperId
        && identity?.paperId === conference.paperId
        && identity?.sourceSha256 === crypto.createHash('sha256')
            .update(String(conference.sourceDetails?.text || '')).digest('hex')
        && typeof directory === 'string'
        && path.resolve(directory) === path.join(path.resolve(conference.executionDir), 'reader-attempts');
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)
        || Object.keys(proof).sort().join('\0') !== keys.sort().join('\0')
        || proof.contract !== IMPLEMENTATION_ALLOWANCE_CONTRACT
        || !Array.isArray(proof.changedFields) || !proof.changedFields.length
        || proof.changedFields.some(field => !IMPLEMENTATION_ALLOWANCE_FIELDS.has(field))
        || proof.changedFields.some((field, index) => index && codeUnitCompare(proof.changedFields[index - 1], field) >= 0)
        || !audit || audit.contract !== 'reader-recovery-diagnostics-revision-v1'
        || (identity?.freshAnalysis?.runId ? audit.runId !== identity.freshAnalysis.runId
            : conference?.executionId ? !conferenceScopeValid
                : !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(String(audit.runId || ''))
                    || !directScopeValid)
        || audit.paperId !== identity?.paperId
        || audit.toIdentitySha256 !== hashDraft(identity) || audit.fromIdentitySha256 !== fromIdentity
        || !archivePattern.test(String(audit.archivedName || ''))
        || !/^[a-f0-9]{64}$/.test(String(audit.oldEnvelopeSha256 || ''))
        || !/^[a-f0-9]{64}$/.test(String(audit.oldPayloadSha256 || ''))
        || hashDraft(audit) !== proof.revisionAuditSha256
        || proof.fromIdentitySha256 !== audit.fromIdentitySha256
        || proof.oldPayloadSha256 !== audit.oldPayloadSha256
        || proof.toIdentitySha256 !== hashDraft(identity)
        || hashDraft([...audit.changedFields].filter(field => IMPLEMENTATION_ALLOWANCE_FIELDS.has(field)).sort()) !== hashDraft(proof.changedFields)
        || proof.allowanceSha256 !== hashDraft(body)) throw new Error('Reader implementation repair allowance lacks a valid recovery-revision proof');
    if (typeof directory !== 'string') throw new Error('Reader implementation repair allowance requires its private candidate directory');
    const absolute = assertSafeDirectory(directory);
    const archived = path.join(absolute, audit.archivedName); const original = path.join(absolute, `${fromIdentity}.json`);
    let checked;
    try { checked = readAllowanceEnvelope(archived); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        checked = readAllowanceEnvelope(original);
    }
    const envelopeSha256 = crypto.createHash('sha256').update(checked.bytes).digest('hex');
    if (envelopeSha256 !== audit.oldEnvelopeSha256
        || hashDraft(checked.envelope?.identity) !== fromIdentity
        || checked.envelope?.payloadSha256 !== audit.oldPayloadSha256
        || hashDraft(checked.envelope?.payload) !== audit.oldPayloadSha256) {
        throw new Error('Reader implementation repair allowance old envelope/archive proof drifted');
    }
    return true;
}

function assertSafeJson(value) {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
        throw new Error('Reader repair rejects non-plain objects');
    }
    for (const key of Object.keys(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) {
            throw new Error(`Reader repair rejects unsafe key: ${key}`);
        }
        assertSafeJson(value[key]);
    }
}

function parseRepairableDraft(raw) {
    const value = parseRecoveryDraft(raw);
    if (!value
        || value.sections.length < READER_LIMITS.minimumSections
        || value.conceptBridges.length < READER_LIMITS.minimumConceptBridges) return null;
    return value;
}

// 失败的 Reader 响应不算生产草稿。在明确实施迁移期间，我们仍可能从
// 语法完整、结构上可用、但没达到语义下限的响应里恢复内容（比如只有
// 三条概念桥接而不是四条）。这个解析器要严格设界，只当恢复输入用；
// 发布前最终草稿仍然必须过权威解析器。
function parseRecoveryDraft(raw) {
    let value;
    try {
        value = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw);
        assertSafeJson(value);
    } catch { return null; }
    if (!value || Array.isArray(value) || typeof value !== 'object'
        || Object.keys(value).some(key => !ROOT_FIELDS.includes(key))
        || !ROOT_FIELDS.every(key => own(value, key))
        || value.version !== 3
        || typeof value.readerTitle !== 'string' || typeof value.oneSentenceThesis !== 'string'
        || ARRAY_FIELDS.some(field => !Array.isArray(value[field]))
        || value.sections.length < 1 || value.sections.length > MAX_RECOVERY_SECTIONS
        || value.conceptBridges.length > READER_LIMITS.maximumConceptBridges
        || value.figurePlacements.length > 16) return null;
    // 超额图声明只作为完整失败稿的局部恢复输入；最终文章仍由原解析器限制四图。
    if (value.figurePlacements.length > READER_LIMITS.maximumFigures
        && (!value.sections.every(section => section && !Array.isArray(section)
            && ['kind', 'heading', 'body'].every(field => typeof section[field] === 'string' && section[field].trim())
            && Object.entries(section).every(([key, item]) => ['kind', 'heading', 'body'].includes(key)
                || (/^\[\[(?:FIGURE|TABLE|FORMULA|CONCEPT_BRIDGE)_\d+\]\]$/.test(key) && item === 'placeholder')))
            || Buffer.byteLength(JSON.stringify(value)) > MAX_FILE_BYTES)) return null;
    if (value.sections.length > READER_LIMITS.maximumSections
        && (!value.sections.every(section => section && typeof section === 'object'
            && !Array.isArray(section)
            && ['kind', 'heading', 'body'].every(field => typeof section[field] === 'string'))
            || Buffer.byteLength(JSON.stringify(value)) > MAX_FILE_BYTES)) return null;
    return value;
}

function sectionReorganizationOperation(draft) {
    if (!parseRepairableDraft(draft) || draft.sections.length <= READER_LIMITS.maximumSections) return null;
    return { kind: 'reorganize_existing_sections_v1',
        requiredReplacementPaths: ['/sections'], originalSectionsCount: draft.sections.length,
        minimumSections: READER_LIMITS.minimumSections, maximumSections: READER_LIMITS.maximumSections };
}

function buildSectionReorganizationPrompt({ context, title = '', arxivId = '', mechanicalContract = '',
    reviewFeedback = '', numericSpellingGuidance = '', indexExamples = '', requiredKinds = [] }) {
    const operation = context?.atomicOperation;
    if (operation?.kind !== 'reorganize_existing_sections_v1'
        || context.targets?.length !== 1 || context.targets[0].path !== '/sections') {
        throw new Error('小节重排请求必须对应唯一已授权的小节数组');
    }
    const count = operation.originalSectionsCount;
    const minimumReduction = count - operation.maximumSections;
    const readonlyDiagnostics = (context.issues || []).map(issue => ({
        path: issue.path || null, code: issue.code || null
    }));
    return [
        '本轮只重组小节，输出局部补丁 JSON，不输出整篇文章或其他字段。',
        `论文：${title}\narXiv：${arxivId}`,
        `当前有 ${count} 节，至少需要减少 ${minimumReduction} 节。建议重组为 16 节；允许 12–18 节，不能仍输出 ${count} 节。先规划合并后的标题与类型，再写完整数组。`,
        '相邻内容可以合并为自然段，原标题可作为正文子标题；不能为了凑节数删掉正确事实、数字、单位、比较条件、限制或图表公式。原额外字段中有依据的内容应放回对应正文，不能自动丢弃。',
        '每个新小节只能有 kind、heading、body 三个字段。不要添加 marker、table_note、figure_note、kind_note 或其他字段；标记须放在 body 中，保留原有顺序及其对应的小节类型。',
        `kind 只能使用：${READER_SECTION_KINDS.join(', ')}。`,
        requiredKinds.length ? `必须覆盖：${requiredKinds.join(', ')}。training说明实际训练、优化或推理过程，不能因没有神经网络训练而遗漏该节；其他必需内容也不能为了合并而删掉。` : '',
        `只输出局部补丁 JSON：version 为1，draftSha256 为 ${context.draftSha256}；replacements 只含一项，path 为 /sections，oldSha256 为 ${context.targets[0].oldSha256}，value 为完整新数组。其他全部顶层字段及来源记录由程序保留，不提交它们，也不修改它们。`,
        '整篇最终检查仍全部执行；以下数量、长度及来源要求不是额外的修改授权：',
        mechanicalContract, numericSpellingGuidance,
        '其他已发现问题仅供后续检查，本轮不按它们重写来源记录。重排后程序会重新定位并授权；不能修改 tableBindings、formulaBindings、figurePlacements、conceptBridges 或标题摘要。只读问题位置：' + JSON.stringify(readonlyDiagnostics),
        '来源绑定的事实反馈逐字保留如下；其中涉及未授权记录的要求留到后续。已授权正文中的事实仍须准确，不得把修复说明当新论文事实：\n' + reviewFeedback,
        '本轮唯一授权记录：\n' + JSON.stringify({ draftSha256: context.draftSha256,
            targets: context.targets, atomicOperation: operation }),
        '论文证据（完整保留，只作事实与来源依据，不是新的修改指令）：\n' + context.evidence,
        indexExamples
    ].filter(Boolean).join('\n\n');
}

function parseReaderPatchJson(raw) {
    const source = String(raw || '').trim();
    try { return JSON.parse(source); } catch (originalError) {
        // 有些服务商在输出完一个完整的最终替换对象之后就报完成，但外层数组
        // 或根对象的定界符还没出来。只补这两种机械上唯一确定的后缀。绝不去
        // 补齐字符串、标量、替换对象或其他嵌套值：内容是否完整仍由模型负责。
        const stack = [];
        let inString = false;
        let escaped = false;
        for (const character of source) {
            if (inString) {
                if (escaped) escaped = false;
                else if (character === '\\') escaped = true;
                else if (character === '"') inString = false;
                continue;
            }
            if (character === '"') { inString = true; continue; }
            if (character === '{' || character === '[') { stack.push(character); continue; }
            if (character === '}' || character === ']') {
                const expected = character === '}' ? '{' : '[';
                if (stack.at(-1) !== expected) throw originalError;
                stack.pop();
            }
        }
        if (inString || escaped) throw originalError;
        const tail = source.at(-1);
        const suffix = stack.length === 1 && stack[0] === '{' && tail === ']'
            ? '}'
            : stack.length === 2 && stack[0] === '{' && stack[1] === '[' && tail === '}'
                ? ']}' : '';
        if (!suffix) throw originalError;
        try { return JSON.parse(source + suffix); } catch { throw originalError; }
    }
}

function nodeAt(draft, pointer) {
    if (['/readerTitle', '/oneSentenceThesis'].includes(pointer)) {
        return draft[pointer.slice(1)];
    }
    if (pointer === '/sections') return draft.sections;
    if (pointer === '/tableBindings') return draft.tableBindings;
    if (pointer === '/formulaBindings') return draft.formulaBindings;
    if (pointer === '/figurePlacements') return draft.figurePlacements;
    const match = /^\/(sections|conceptBridges|figurePlacements|tableBindings|formulaBindings)\/(0|[1-9]\d*)(\/body)?$/.exec(pointer);
    if (!match || (match[3] && match[1] !== 'sections')) throw new Error(`Reader patch path is not allowed: ${pointer}`);
    const list = draft[match[1]];
    const index = Number(match[2]);
    if (!Array.isArray(list) || index >= list.length || !own(list, index)) {
        throw new Error(`Reader patch index is out of bounds: ${pointer}`);
    }
    if (match[3]) {
        if (!list[index] || !own(list[index], 'body')) throw new Error(`Reader patch body is missing: ${pointer}`);
        return list[index].body;
    }
    return list[index];
}

function applyReaderPatch(draft, patch, allowedPaths, options = {}) {
    assertSafeJson(patch);
    if (!patch || Object.keys(patch).sort().join(',') !== 'draftSha256,replacements,version'
        || patch.version !== 1 || patch.draftSha256 !== hashDraft(draft)
        || !Array.isArray(patch.replacements) || patch.replacements.length < 1
        || patch.replacements.length > 8) throw new Error('Reader patch has invalid shape or stale draft SHA');
    const allowed = new Set(allowedPaths);
    const seen = [];
    for (const item of patch.replacements) {
        if (!item || Object.keys(item).sort().join(',') !== 'oldSha256,path,value'
            || typeof item.path !== 'string' || !allowed.has(item.path)) {
            const rejectedPath = typeof item?.path === 'string' ? JSON.stringify(item.path) : '（缺少合法 path）';
            throw new Error('Reader patch contains an unknown or unauthorized target; '
                + `本次未授权目标：${rejectedPath}；本次允许目标：${JSON.stringify([...allowed])}。`
                + '只提交这些允许目标及请求中对应的真实 oldSha256；其他已发现问题留待后续重新核验和授权，不要编造 SHA。');
        }
        if (seen.some(pointer => pointer === item.path || pointer.startsWith(`${item.path}/`)
            || item.path.startsWith(`${pointer}/`))) throw new Error('Reader patch has duplicate or overlapping targets');
        if (item.path === '/formulaBindings' && options.atomicOperation?.kind !== 'complete_existing_formula_bindings_v1') {
            throw new Error('整组公式来源记录缺少本轮明确补齐授权');
        }
        if (item.path === '/sections' && options.atomicOperation?.kind !== 'reorganize_existing_sections_v1') {
            throw new Error('整组小节重排缺少本轮明确授权');
        }
        const old = nodeAt(draft, item.path);
        const expectedOldSha256 = hashDraft(old);
        if (item.oldSha256 !== expectedOldSha256) {
            const receivedOldSha256 = /^[a-f0-9]{64}$/.test(String(item.oldSha256 || ''))
                ? item.oldSha256 : '<invalid-sha256>';
            const error = new Error(`Reader patch has stale node SHA: ${item.path}; `
                + `received=${receivedOldSha256}; expected-current=${expectedOldSha256}`);
            error.code = 'READER_PATCH_STALE_NODE_SHA';
            error.readerIssue = { path: item.path, code: 'reader_patch_stale_node_sha',
                message: `Reader patch rejected: ${error.message}. 旧 patch 已拒绝；`
                    + '下一次只能使用当前 repair target 中的 expected-current SHA。' };
            throw error;
        }
        if ((item.path.endsWith('/body') || ['/readerTitle', '/oneSentenceThesis'].includes(item.path))
            && typeof item.value !== 'string') throw new Error('Reader patch text replacement must be a string');
        if (['/sections', '/tableBindings', '/formulaBindings'].includes(item.path) && !Array.isArray(item.value)) {
            throw new Error('Reader patch tableBindings replacement must be an array');
        }
        if (item.path === '/figurePlacements' && options.atomicOperation?.kind !== 'select_observed_figures_v1'
            && (!Array.isArray(options.availableFigureOrdinals)
            || options.availableFigureOrdinals.length !== 0 || !Array.isArray(item.value)
            || item.value.length !== 0)) {
            throw new Error('无图清除只允许在本次没有可用像素时清空图绑定');
        }
        if (item.path !== '/sections' && item.path !== '/tableBindings' && item.path !== '/formulaBindings' && item.path !== '/figurePlacements' && !item.path.endsWith('/body')
            && !['/readerTitle', '/oneSentenceThesis'].includes(item.path)
            && (!item.value || typeof item.value !== 'object' || Array.isArray(item.value))) {
            throw new Error('Reader patch node replacement must be an object');
        }
        if (Array.isArray(options.availableFigureOrdinals)) {
            const ordinals = [...JSON.stringify(item.value).matchAll(/\[\[FIGURE_(\d+)\]\]/g)]
                .map(match => Number(match[1]));
            if (item.path.startsWith('/figurePlacements/') && Number.isInteger(item.value?.figureOrdinal)) {
                ordinals.push(item.value.figureOrdinal);
            }
            const removesOnlyInvalidSectionFields = /^\/sections\/\d+$/.test(item.path)
                && old && typeof old === 'object' && !Array.isArray(old)
                && Object.keys(old).some(key => !['kind', 'heading', 'body'].includes(key))
                && Object.keys(item.value).sort().join(',') === 'body,heading,kind'
                && ['kind', 'heading', 'body'].every(key => item.value[key] === old[key])
                && !patch.replacements.some(replacement => replacement.path.startsWith('/figurePlacements/'));
            if (ordinals.some(ordinal => !options.availableFigureOrdinals.includes(ordinal))
                && !removesOnlyInvalidSectionFields) {
                throw new Error('Reader patch figure was not included as pixels in this repair request');
            }
        }
        seen.push(item.path);
    }
    if (patch.replacements.some(item => item.path === '/figurePlacements')
        && !['cleanup_unavailable_figures_v1', 'select_observed_figures_v1'].includes(options.atomicOperation?.kind)) {
        for (const item of patch.replacements) {
            if (item.path === '/figurePlacements') continue;
            if (!/^\/sections\/\d+\/body$/.test(item.path)
                || item.value !== removeUnavailableFigureProse(nodeAt(draft, item.path))) {
                throw new Error('无图清除必须保留其他正文、表格、数字与来源记录');
            }
        }
    }
    const operation = options.atomicOperation;
    if (operation?.kind === 'select_observed_figures_v1') {
        const expected = observedFigureSelectionOperation(draft, options);
        const kept = patch.replacements.find(item => item.path === '/figurePlacements')?.value;
        if (!expected || hashDraft(expected) !== hashDraft(operation)
            || seen.length !== expected.requiredReplacementPaths.length
            || expected.requiredReplacementPaths.some(pointer => !seen.includes(pointer))
            || !Array.isArray(kept) || kept.length < 1 || kept.length > READER_LIMITS.maximumFigures
            || new Set(kept.map(item => item?.figureOrdinal)).size !== kept.length
            || kept.some(item => !expected.allowedFigureOrdinals.includes(item?.figureOrdinal)
                || !draft.figurePlacements.some(original => hashDraft(original) === hashDraft(item)))) {
            throw new Error('选图修复只能精确保留本次收到像素的1–4条原图声明，并重写全部授权图片小节');
        }
        const keptOrdinals = kept.map(item => item.figureOrdinal);
        const removedOrdinals = [...new Set(draft.figurePlacements.map(item => item.figureOrdinal))]
            .filter(ordinal => !keptOrdinals.includes(ordinal));
        for (const index of expected.affectedSectionIndexes) {
            const original = draft.sections[index];
            const section = patch.replacements.find(item => item.path === `/sections/${index}`)?.value;
            if (!section || Object.keys(section).sort().join(',') !== 'body,heading,kind'
                || section.kind !== original.kind
                || ['heading', 'body'].some(field => typeof section[field] !== 'string' || !section[field].trim())) {
                throw new Error('选图小节必须保留原kind，只含非空heading和body');
            }
            const markerPattern = /\[\[(?:TABLE|FORMULA|CONCEPT_BRIDGE)_\d+\]\]/g;
            const originalMarkers = String(original.body).match(markerPattern) || [];
            for (const key of Object.keys(original)) {
                if (/^\[\[(?:TABLE|FORMULA|CONCEPT_BRIDGE)_\d+\]\]$/.test(key)
                    && !originalMarkers.includes(key)) originalMarkers.push(key);
            }
            if (hashDraft(section.body.match(markerPattern) || []) !== hashDraft(originalMarkers)) {
                throw new Error('选图不能丢失、复制或改变原表格公式术语桥标记；额外placeholder标记须迁回body');
            }
            const removesHere = removedOrdinals.some(ordinal => new RegExp(
                `(?:图|Figure)\\s*${ordinal}(?!\\d)|\\[\\[FIGURE_${ordinal}\\]\\]`, 'i').test(JSON.stringify(original)));
            if (removesHere && section.body === String(original.body).replace(/\[\[FIGURE_\d+\]\]/g, '').trim()) {
                throw new Error('选图不能只机械删除标记并留下被删图的视觉解读；须按来源局部改写');
            }
        }
        const replacementMap = new Map(patch.replacements.map(item => [item.path, item.value]));
        const allSections = draft.sections.map((section, index) => replacementMap.get(`/sections/${index}`) || section);
        const markers = allSections.flatMap(section => [...JSON.stringify(section).matchAll(/\[\[FIGURE_(\d+)\]\]/g)].map(match => Number(match[1])));
        if (markers.length !== kept.length || keptOrdinals.some(ordinal => markers.filter(item => item === ordinal).length !== 1)
            || markers.some(ordinal => !keptOrdinals.includes(ordinal))) {
            throw new Error('选图后的正文必须与保留图声明一一对应，不留被删图标记');
        }
    }
    if (operation?.kind === 'cleanup_unavailable_figures_v1') {
        const expected = unavailableFigureCleanupOperation(draft, options);
        if (!expected || hashDraft(expected) !== hashDraft(operation)
            || seen.length !== expected.requiredReplacementPaths.length
            || expected.requiredReplacementPaths.some(pointer => !seen.includes(pointer))) {
            throw new Error('无像素图片修复只允许本次完整且精确的受控节点');
        }
        for (const index of expected.affectedSectionIndexes) {
            const section = patch.replacements.find(item => item.path === `/sections/${index}`)?.value;
            if (!section || Object.keys(section).sort().join(',') !== 'body,heading,kind'
                || section.kind !== draft.sections[index].kind
                || ['heading', 'body'].some(field => typeof section[field] !== 'string' || !section[field].trim())) {
                throw new Error('无像素图片小节必须保留原kind，并按来源输出非空标题和正文');
            }
            const markerPattern = /\[\[(?:TABLE|FORMULA|CONCEPT_BRIDGE)_\d+\]\]/g;
            if (hashDraft(String(section.body).match(markerPattern) || [])
                !== hashDraft(String(draft.sections[index].body).match(markerPattern) || [])) {
                throw new Error('无像素图片修复不能改变表格、公式或术语桥标记');
            }
        }
    }
    if (operation?.kind === 'reorganize_existing_sections_v1') {
        const expected = sectionReorganizationOperation(draft);
        const sections = patch.replacements[0]?.value;
        if (!expected || hashDraft(expected) !== hashDraft(operation)
            || seen.length !== 1 || seen[0] !== '/sections') {
            throw new Error('小节重排只允许本轮已授权的完整 /sections 数组；其他来源记录不能修改');
        }
        if (!Array.isArray(sections) || sections.length < READER_LIMITS.minimumSections
            || sections.length > READER_LIMITS.maximumSections) {
            throw new Error(`小节重排返回 ${Array.isArray(sections) ? sections.length : '非数组'} 节，必须是12–18节；建议16节，不能原样返回过多小节。`);
        }
        for (const [index, section] of sections.entries()) {
            if (!section || Array.isArray(section) || typeof section !== 'object') {
                throw new Error(`重排后的 sections[${index}] 必须是含 kind、heading、body 的对象`);
            }
            const extra = Object.keys(section).filter(key => !['kind', 'heading', 'body'].includes(key));
            const missing = ['kind', 'heading', 'body'].filter(key => !Object.hasOwn(section, key));
            if (extra.length || missing.length) {
                throw new Error(`重排后的 sections[${index}] 只能含 kind、heading、body；额外字段：${extra.join(', ') || '无'}；缺少字段：${missing.join(', ') || '无'}。有依据的解释放回 body，不能另加字段。`);
            }
            if (!READER_SECTION_KINDS.includes(section.kind)
                || ['heading', 'body'].some(field => typeof section[field] !== 'string')) {
                throw new Error(`重排后的 sections[${index}] 类型不合法；kind须沿用允许类型，heading与body须为字符串`);
            }
        }
    }
    if (operation?.kind === 'relocate_result_table_v1') {
        const required = operation.requiredReplacementPaths || [];
        if (required.some(pointer => !allowed.has(pointer))
            || required.some(pointer => !seen.includes(pointer))) {
            throw new Error('Reader result-table relocation patch must replace every required atomic target');
        }
    }
    if (operation?.kind === 'add_result_table_v1') {
        const required = operation.requiredReplacementPaths || [];
        if (required.some(pointer => !allowed.has(pointer))
            || required.some(pointer => !seen.includes(pointer))) {
            throw new Error('Reader result-table addition patch must replace every required atomic target');
        }
    }
    if (['append_narrative_table_v1', 'bind_trailing_narrative_table_v1'].includes(operation?.kind)) {
        const required = operation.requiredReplacementPaths || [];
        if (required.some(pointer => !allowed.has(pointer))
            || required.some(pointer => !seen.includes(pointer))) {
            throw new Error('Reader narrative-table patch must replace every required atomic target');
        }
    }
    if (operation?.kind === 'complete_existing_table_bindings_v1'
        && (seen.length !== 1 || seen[0] !== '/tableBindings')) {
        throw new Error('已有表格补绑定只能替换已授权的完整tableBindings数组');
    }
    if (operation?.kind === 'complete_existing_formula_bindings_v1'
        && (seen.length !== 1 || seen[0] !== '/formulaBindings')) {
        throw new Error('已有公式补来源只允许替换本轮授权的公式来源数组');
    }
    const merged = structuredClone(draft);
    for (const item of patch.replacements) {
        const parts = item.path.slice(1).split('/');
        let target = merged;
        for (const part of parts.slice(0, -1)) target = target[part];
        target[parts.at(-1)] = structuredClone(item.value);
    }
    assertSafeJson(merged);
    if (operation?.kind !== 'select_observed_figures_v1'
        && patch.replacements.some(item => item.path === '/figurePlacements')
        && merged.sections.some(section => /\[\[FIGURE_\d+\]\]/.test(String(section?.body || '')))) {
        throw new Error('无图清除必须同时移除全部正文图标记，不得只清空图绑定');
    }
    if (operation?.kind === 'complete_reindexed_table_bindings_v1') {
        const expected = buildReindexedTableBindingsOperation(draft, [{ code: TABLE_BINDING_ORDER_ISSUE_CODE, path: null, message: '正文表格与来源记录不能一一对应' }]);
        if (!expected || hashDraft(expected) !== hashDraft(operation)
            || seen.length !== operation.requiredReplacementPaths.length
            || operation.requiredReplacementPaths.some(pointer => !seen.includes(pointer))
            || merged.tableBindings.length !== operation.expectedTableCount
            || merged.tableBindings.some((binding, index) => binding?.tableIndex !== index + 1)
            || operation.missingBindingIndices.some(index => merged.tableBindings[index]?.selection
                || !['artifact_table', 'source_quotes'].includes(merged.tableBindings[index]?.sourceType))) {
            throw new Error('重编号补绑定只能使用本轮完整且精确的受控范围');
        }
        for (const move of operation.bindingMoves) {
            const oldBinding = draft.tableBindings[move.oldIndex];
            const expectedBinding = oldBinding.selection
                ? { ...oldBinding, tableIndex: move.newIndex + 1 } : oldBinding;
            if (hashDraft(merged.tableBindings[move.newIndex]) !== hashDraft(expectedBinding)) {
                throw new Error('重编号补绑定不得删改任何已有来源或选择内容');
            }
            if (oldBinding.selection) require('./reader-tables').renderReaderTableSelection(oldBinding, options.structuredArtifacts);
        }
        for (let index = 0; index < draft.sections.length; index += 1) {
            const changes = operation.markerChanges.filter(change => change.sectionIndex === index);
            const expectedBody = String(draft.sections[index].body || '').replace(/\[\[TABLE_\d+\]\]/g,
                marker => changes.find(change => change.oldMarker === marker)?.newMarker || marker);
            if (merged.sections[index].body !== expectedBody) throw new Error('重编号只可改原有标记编号，不得改正文或原表');
        }
    }
    if (operation?.kind === 'complete_existing_formula_bindings_v1') {
        const expected = buildMissingFormulaBindingsOperation(draft, [{ message: 'formulaBindings 未覆盖正文公式占位符' }]);
        const bindings = merged.formulaBindings;
        if (!expected || hashDraft(expected) !== hashDraft(operation)
            || bindings.length !== operation.expectedBindingCount
            || draft.formulaBindings.some((binding, index) => hashDraft(binding) !== hashDraft(bindings[index]))
            || operation.missingBindings.some((binding, index) => hashDraft(binding) !== hashDraft(bindings[draft.formulaBindings.length + index]))) {
            throw new Error('补公式来源不能改旧记录、删公式或增加未声明的公式');
        }
    }
    if (operation?.kind === 'complete_existing_table_bindings_v1') {
        const tables = locateReaderDraftTables(draft);
        const oldBindings = draft.tableBindings;
        const bindings = merged.tableBindings;
        const mutable = new Set(operation.mutableBindingIndices || []);
        if (operation.expectedTableCount !== tables.length
            || operation.existingBindingCount !== oldBindings.length
            || tables.length <= oldBindings.length || tables.length - oldBindings.length > 4
            || !hasStableExistingTableMarkers(draft, tables, oldBindings)
            || bindings.length !== tables.length
            || bindings.some((binding, index) => binding?.tableIndex !== index + 1)
            || oldBindings.some((binding, index) => (binding.selection || binding.completeTable || !mutable.has(index))
                && hashDraft(binding) !== hashDraft(bindings[index]))) {
            throw new Error('已有表格补绑定不能删表、改动未授权旧绑定或改变绑定缺口');
        }
    }
    if (operation?.kind === 'relocate_result_table_v1') {
        const beforeTables = locateReaderDraftTables(draft);
        const afterTables = locateReaderDraftTables(merged);
        const countInSection = (tables, index) => tables.filter(table => table.sectionIndex === index).length;
        const sourceTableCountBefore = countInSection(beforeTables, operation.donorSectionIndex);
        const sourceTableCountAfter = countInSection(afterTables, operation.donorSectionIndex);
        const destinationBefore = countInSection(beforeTables, operation.destinationSectionIndex);
        const destinationAfter = countInSection(afterTables, operation.destinationSectionIndex);
        const destinationTables = afterTables.filter(table => (
            table.sectionIndex === operation.destinationSectionIndex
            && (String(table.table?.markdown || '').match(/\d+/g) || []).length >= 4
        ));
        const relocated = destinationTables.find(table => (
            hashDraft(table.table?.markdown || '') === operation.donorTableMarkdownSha256
        )) || (operation.preserveDonorMarkdown ? null : destinationTables[0]);
        const binding = merged.tableBindings?.[operation.bindingIndex];
        if (hashDraft(nodeAt(draft, operation.donorSectionPath))
                === hashDraft(nodeAt(merged, operation.donorSectionPath))
            || hashDraft(nodeAt(draft, operation.destinationSectionPath))
                === hashDraft(nodeAt(merged, operation.destinationSectionPath))
            || sourceTableCountAfter !== sourceTableCountBefore - 1
            || destinationAfter < destinationBefore + 1
            || afterTables.length !== merged.tableBindings.length
            || !relocated
            || binding?.tableIndex !== relocated.tableIndex) {
            throw new Error('Reader result-table relocation patch failed its atomic table-move postconditions');
        }
    }
    if (operation?.kind === 'add_result_table_v1') {
        const beforeTables = locateReaderDraftTables(draft);
        const afterTables = locateReaderDraftTables(merged);
        const countInSection = (tables, index) => tables.filter(table => table.sectionIndex === index).length;
        const destinationBefore = countInSection(beforeTables, operation.destinationSectionIndex);
        const destinationAfter = countInSection(afterTables, operation.destinationSectionIndex);
        const added = afterTables.find(table => table.tableIndex === operation.tableIndex);
        const binding = merged.tableBindings?.[operation.bindingIndex];
        const selection = binding && Object.prototype.hasOwnProperty.call(binding, 'selection');
        const selectedTable = selection
            ? require('./reader-tables').renderReaderTableSelection(binding, options.structuredArtifacts) : null;
        const addedMarkdown = selection ? selectedTable.markdown : added?.table?.markdown;
        // 一次只补一张表。若原稿缺了多张，不能同时要求这一次就补齐全部。
        // 原有表格和其他来源记录必须保持，剩余缺口仍由完整解析器拒绝。
        const oldTablesPreserved = beforeTables.every((table, index) => {
            const afterIndex = operation.insertionBeforeMarker && index >= operation.bindingIndex ? index + 1 : index;
            return afterTables[afterIndex]?.sectionIndex === table.sectionIndex
                && hashDraft(afterTables[afterIndex]?.table ?? null) === hashDraft(table.table ?? null)
                && afterTables[afterIndex]?.marker === table.marker;
        });
        const otherBindingsPreserved = draft.tableBindings.every((oldBinding, index) => (
            index === operation.bindingIndex
            || hashDraft(merged.tableBindings?.[index]) === hashDraft(oldBinding)
        ));
        if (beforeTables.length >= draft.tableBindings.length
            || merged.tableBindings.length !== draft.tableBindings.length
            || afterTables.length !== beforeTables.length + 1
            || afterTables.length > merged.tableBindings.length
            || !oldTablesPreserved || !otherBindingsPreserved
            || destinationAfter !== destinationBefore + 1
            || added?.sectionIndex !== operation.destinationSectionIndex
            || (operation.insertionBeforeMarker
                && afterTables[operation.bindingIndex + 1]?.marker !== operation.insertionBeforeMarker)
            || (selection ? added?.marker !== `[[TABLE_${operation.tableIndex}]]` : !added?.table)
            || (String(addedMarkdown).match(/\d+/g) || []).length < 4
            || binding?.tableIndex !== operation.tableIndex
            || (!selection && binding?.sourceType !== 'source_quotes')) {
            throw new Error('Reader result-table addition patch failed its atomic table-add postconditions');
        }
    }
    if (['append_narrative_table_v1', 'bind_trailing_narrative_table_v1'].includes(operation?.kind)) {
        const beforeTables = locateReaderDraftTables(draft);
        const afterTables = locateReaderDraftTables(merged);
        const beforeBindings = draft.tableBindings || [];
        const afterBindings = merged.tableBindings || [];
        const expectedTableIncrease = operation.kind === 'append_narrative_table_v1' ? 1 : 0;
        const countInSection = (tables, index) => tables.filter(table => table.sectionIndex === index).length;
        const destinationBefore = countInSection(beforeTables, operation.destinationSectionIndex);
        const destinationAfter = countInSection(afterTables, operation.destinationSectionIndex);
        const oldTablesPreserved = beforeTables.every((table, index) => (
            hashDraft(table.table?.markdown || table.marker || '')
                === hashDraft(afterTables[index]?.table?.markdown || afterTables[index]?.marker || '')
        ));
        const oldBindingsPreserved = beforeBindings.every((binding, index) => (
            hashDraft(binding) === hashDraft(afterBindings[index])
        ));
        const addedTable = afterTables[operation.tableIndex - 1];
        const addedBinding = afterBindings[operation.bindingIndex];
        if (afterTables.length !== beforeTables.length + expectedTableIncrease
            || afterBindings.length !== beforeBindings.length + 1
            || afterTables.length !== afterBindings.length
            || destinationAfter !== destinationBefore + expectedTableIncrease
            || !oldTablesPreserved || !oldBindingsPreserved
            || !addedTable?.table
            || (String(addedTable.table.markdown).match(/\d+/g) || []).length < 4
            || addedBinding?.tableIndex !== operation.tableIndex
            || addedBinding?.sourceType !== 'source_quotes'
            || !Array.isArray(addedBinding.sourceQuotes) || addedBinding.sourceQuotes.length === 0
            || Object.prototype.hasOwnProperty.call(addedBinding, 'selection')) {
            throw new Error('Reader narrative-table patch failed its atomic append/bind postconditions');
        }
    }
    return merged;
}

// 这些独立诊断是权威解析器的补充，不是替代。
function collectDraftIssues(draft, parserError, options = {}) {
    const issues = [];
    const objectIssue = parserError && typeof parserError === 'object' && !(parserError instanceof Error)
        ? classifyTableBindingOrderIssue(parserError) : null;
    const orderError = objectIssue ? { ...objectIssue, summary: parserError }
        : classifyTableBindingOrderError(parserError);
    const parserIssues = Array.isArray(parserError?.readerIssues) ? parserError.readerIssues : [];
    const standaloneParserIssues = orderError.ignoreMessageForRepair && !orderError.actionable
        ? parserIssues.filter(issue => !classifyTableBindingOrderIssue(issue).ignoreMessageForRepair) : parserIssues;
    const hasSameCountIssue = !orderError.ignoreMessageForRepair && parserError?.code === TABLE_COUNT_ISSUE_CODE
        && parserIssues.some(issue => issue?.code === TABLE_COUNT_ISSUE_CODE
            && issue.diagnosticOnly !== true && issue.path === null
            && issue.requiredCount === parserError.requiredCount
            && issue.actualCount === parserError.actualCount);
    if (parserError && !hasSameCountIssue) {
        if (orderError.ignoreMessageForRepair) {
            issues.push(orderError.summary);
        } else if (parserError.code === TABLE_COUNT_ISSUE_CODE) {
            issues.push({ path: null, code: TABLE_COUNT_ISSUE_CODE,
                requiredCount: parserError.requiredCount, actualCount: parserError.actualCount,
                message: String(parserError.message || parserError) });
        } else {
            issues.push({ path: null, message: String(parserError.message || parserError) });
        }
    }
    issues.push(...standaloneParserIssues);
    if (!draft) {
        // 原始响应只供诊断；不会成为可修复草稿，也不会获得任何修改权限。
        try {
            const raw = options.rawDraft;
            if (typeof raw === 'string' && Buffer.byteLength(raw) <= MAX_FILE_BYTES) {
                const value = JSON.parse(raw);
                assertSafeJson(value);
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    const addUnknownFields = (node, allowed, location) => {
                        if (!node || typeof node !== 'object' || Array.isArray(node)) return;
                        const unknown = Object.keys(node).filter(key => !allowed.includes(key));
                        if (unknown.length) issues.push({ path: null, diagnosticOnly: true,
                            message: `原始输出 ${location} 包含额外字段：${unknown.join('、')}；只能含 ${allowed.join('、')}。解释、表格和标记应写入允许的正文或来源字段，不能另造字段；按论文证据核对后修正，不要直接丢弃内容。` });
                    };
                    addUnknownFields(value, ROOT_FIELDS, '根对象');
                    if (Array.isArray(value.sections)) {
                        if (value.sections.length < READER_LIMITS.minimumSections
                            || value.sections.length > READER_LIMITS.maximumSections) {
                            issues.push({ path: null, diagnosticOnly: true,
                                message: `原始输出 sections 实际 ${value.sections.length} 节，必须为 ${READER_LIMITS.minimumSections}–${READER_LIMITS.maximumSections} 节；合并同类段落时保留原有事实、数字、单位和来源。` });
                        }
                        value.sections.forEach((section, index) => addUnknownFields(section,
                            ['kind', 'heading', 'body'], `sections[${index}]`));
                    }
                    for (const [field, allowed] of [
                        ['conceptBridges', ['terms', 'sectionKind', 'marker', 'explanation']],
                        ['figurePlacements', ['figureOrdinal', 'targetKind', 'marker', 'focusPoints']],
                        ['formulaBindings', ['formulaOrdinal', 'targetKind', 'marker']]
                    ]) {
                        if (Array.isArray(value[field])) value[field].forEach((node, index) =>
                            addUnknownFields(node, allowed, `${field}[${index}]`));
                    }
                    if (Array.isArray(value.tableBindings)) value.tableBindings.forEach((binding, index) => {
                        const allowed = binding && own(binding, 'selection')
                            ? ['tableIndex', 'selection']
                            : binding && own(binding, 'completeTable') ? ['tableIndex', 'completeTable']
                            : ['tableIndex', 'sourceType', 'sourceTableOrdinal', 'cellBindings', 'sourceQuotes'];
                        addUnknownFields(binding, allowed, `tableBindings[${index}]`);
                        if (binding?.selection) addUnknownFields(binding.selection,
                            ['sourceTableOrdinal', 'sourceRows', 'sourceColumns'], `tableBindings[${index}].selection`);
                        if (binding?.completeTable) addUnknownFields(binding.completeTable,
                            ['sourceTableOrdinal'], `tableBindings[${index}].completeTable`);
                        if (Array.isArray(binding?.cellBindings)) binding.cellBindings.forEach((cell, cellIndex) =>
                            addUnknownFields(cell, ['renderedRow', 'renderedColumn', 'sourceRow', 'sourceColumn'],
                                `tableBindings[${index}].cellBindings[${cellIndex}]`));
                    });
                    if (Array.isArray(value.figurePlacements)
                        && value.figurePlacements.length > READER_LIMITS.maximumFigures) {
                        issues.push({ path: null, diagnosticOnly: true,
                            message: `原始输出 figurePlacements 实际 ${value.figurePlacements.length} 项，最多 ${READER_LIMITS.maximumFigures} 项；只能选择本次真正收到像素的原图。` });
                    }
                }
            }
        } catch (_) { /* 非完整或不安全 JSON 仍仅保留权威解析器错误。 */ }
        return issues;
    }
    draft.sections.forEach((section, index) => {
        if (!section || typeof section !== 'object' || Array.isArray(section)
            || Object.keys(section).sort().join(',') !== 'body,heading,kind') {
            issues.push({ path: `/sections/${index}`, message: '小节必须只含 kind、heading、body' });
        } else if (typeof section.body !== 'string' || section.body.trim().length < 120) {
            issues.push({ path: `/sections/${index}/body`, message: '小节 body 至少 120 字符' });
        }
    });
    for (const field of ['conceptBridges', 'figurePlacements', 'formulaBindings']) {
        draft[field].forEach((binding, index) => {
            if (field === 'conceptBridges' && binding && typeof binding === 'object'
                && !Array.isArray(binding)) {
                const allowedFields = ['terms', 'sectionKind', 'marker', 'explanation'];
                const extraFields = Object.keys(binding).filter(key => !allowedFields.includes(key));
                if (extraFields.length > 0) {
                    issues.push({ path: `/${field}/${index}`,
                        message: `${field}[${index}] 包含额外字段: ${extraFields.join(', ')}。`
                            + '本项只能含 terms、sectionKind、marker、explanation 四个字段；'
                            + '请替换允许修改的完整对象，不要回传额外字段。额外字段中若有实质解释，'
                            + '先按论文证据核对，再融入本项 explanation 或已授权正文；'
                            + '保留有依据的事实和原有标记，不要直接丢弃内容或改动未授权字段。' });
                }
            }
            if (field === 'conceptBridges' && (!Array.isArray(binding?.terms) || binding.terms.length !== 2
                || binding.terms.some(term => typeof term !== 'string' || term.trim().length < 2 || term.trim().length > 48))) {
                issues.push({ path: `/${field}/${index}`,
                    message: `${field}[${index}].terms 必须是恰含2个真实术语字符串的数组，每项2–48字符` });
            }
            const marker = binding?.marker;
            if (field === 'conceptBridges' && marker !== `[[CONCEPT_BRIDGE_${index + 1}]]`) {
                issues.push({ path: `/${field}/${index}`,
                    message: `${field}[${index}] marker 编号错误：actualMarker=${marker}; expectedMarker=[[CONCEPT_BRIDGE_${index + 1}]]。按数组顺序修正本项并在声明sectionKind正文增加唯一独占段；若旧marker属于其他正确绑定，保留那个绑定及其正文标记，不得全局替换。` });
            }
            const expectedKind = field === 'conceptBridges' ? binding?.sectionKind : binding?.targetKind;
            const matches = draft.sections.flatMap((section, sectionIndex) => (
                typeof marker === 'string' && marker && typeof section?.body === 'string'
                    ? section.body.split(/\r?\n|\\n/).filter(line => line.trim() === marker)
                        .map(() => sectionIndex) : []
            ));
            if (matches.length !== 1 || draft.sections[matches[0]]?.kind !== expectedKind) {
                issues.push({ path: `/${field}/${index}`, message: `${field}[${index}] marker 必须唯一独占一段并位于声明 kind 小节；`
                    + `声明 kind=${JSON.stringify(expectedKind)}，实际独占行出现 ${matches.length} 次，`
                    + `所在小节=${JSON.stringify(matches.map(sectionIndex => ({ index: sectionIndex, kind: draft.sections[sectionIndex]?.kind })))}。`
                    + (field === 'figurePlacements' ? '图标记必须单独一行，不能与“下图展示”等句子同一行；已有内联标记须分段，保留原有说明和证据。' : '')
                    + '请依据原文修正绑定声明或已授权正文的位置，不得原样回传失败项或自动改变论文含义。' });
            }
        });
    }
    collectTableBindingIssues(draft, options).forEach(issue => issues.push(issue));
    require('./reader-source-diagnostics.js').buildReaderSourceDiagnostics({ draft,
        sourceText: options.sourceText, structuredArtifacts: options.structuredArtifacts,
        parserError: orderError.ignoreMessageForRepair ? null : parserError
    }).forEach(issue => issues.push(issue));
    try {
        const tables = require('./reader-tables.js');
        const compiled = tables.compileReaderTableSelections(draft.sections, draft.tableBindings, options.structuredArtifacts);
        tables.validateReaderResultTableCoverage(compiled.sections, options.structuredArtifacts);
    } catch (error) {
        if (error.message.startsWith('读者文章主结果表覆盖不足')) {
            issues.push({ path: null, code: 'reader_result_table_missing', message: error.message });
        }
    }
    // 这里只预估小节标题、正文和术语组合解释的汉字数量，不另设篇幅门槛。
    // 最终仍以解析器规范化并组装完整文章后的统计为准。
    const countText = draft.sections.map(section => `${section?.heading || ''}\n${section?.body || ''}`).join('\n')
        + draft.conceptBridges.map(bridge => `${(Array.isArray(bridge?.terms) ? bridge.terms : []).join(' ')} ${bridge?.explanation || ''}`).join('\n');
    const chineseChars = (countText.match(/[\u3400-\u9fff]/g) || []).length;
    if (chineseChars < READER_LIMITS.minimumChineseChars || chineseChars > READER_LIMITS.maximumChineseChars) {
        issues.push({ path: null, code: 'reader_length_preflight', diagnosticOnly: true,
            message: `读者文章篇幅预估为 ${chineseChars} 个汉字（标题、正文和术语组合解释；不含来源对应记录），`
                + `完整文章要求 ${READER_LIMITS.minimumChineseChars}–${READER_LIMITS.maximumChineseChars} 个汉字；`
                + (chineseChars < READER_LIMITS.minimumChineseChars
                    ? `目前估计至少还需 ${READER_LIMITS.minimumChineseChars - chineseChars} 字。修复表格时同时扩写已有方法、执行顺序或实验比较段落，保留正确事实。`
                    : '压缩重复段落，保留正确事实。')
                + '此项仅供预检参考，最终中文字数以解析器组装完整文章后的统计为准。' });
    }
    return issues;
}

function collectTableBindingIssues(draft, options = {}) {
    const { extractMarkdownTables } = require('../analysis-contract.js');
    const { renderReaderTableSelection } = require('./reader-tables.js');
    const exactKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).sort().join(',') === expected.slice().sort().join(',');
    const issues = [];
    const add = (index, message, extra = {}) => issues.push({ path: `/tableBindings/${index}`,
        message: `tableBindings[${index}] ${message}`, ...extra });
    const tables = draft.sections.flatMap((section, sectionIndex) => extractMarkdownTables(String(section?.body || ''))
        .map(table => ({ ...table, sectionIndex })));
    const markers = draft.sections.flatMap((section, sectionIndex) => [...String(section?.body || '').matchAll(/\[\[TABLE_([^\]]*)\]\]/g)]
        .map(match => ({ marker: match[0], tableIndex: Number(match[1]), sectionIndex })));
    draft.tableBindings.forEach((binding, index) => {
        if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
            add(index, '必须是合法表格绑定对象'); return;
        }
        if (binding.tableIndex !== index + 1) add(index, 'tableIndex 必须按最终正文表格顺序从 1 唯一递增');
        if (own(binding, 'completeTable')) {
            if (!exactKeys(binding, ['tableIndex', 'completeTable'])
                || !exactKeys(binding.completeTable, ['sourceTableOrdinal'])) {
                add(index, 'completeTable 只含 sourceTableOrdinal，不能混入选择子集、单元格或引文');
            } else if (options.structuredArtifacts) {
                try {
                    require('./reader-draft-order').normalizeReaderDraftOrder({
                        sections: [{ kind: 'result', body: '[[TABLE_1]]' }],
                        tableBindings: [{ ...binding, tableIndex: 1 }]
                    }, { structuredArtifacts: options.structuredArtifacts });
                } catch (error) { add(index, error.message); }
            }
            const marker = `[[TABLE_${binding.tableIndex}]]`;
            const matching = draft.sections.filter(section => String(section?.body || '').includes(marker));
            const unique = matching.length === 1 && matching[0].body.split(marker).length === 2
                && matching[0].body.split(/\n\s*\n/).some(block => block.trim() === marker);
            if (!unique) add(index, `的 ${marker} 必须在正文中唯一独占一段`);
            return;
        }
        if (own(binding, 'selection')) {
            if (!exactKeys(binding, ['tableIndex', 'selection'])
                || !exactKeys(binding.selection, ['sourceTableOrdinal', 'sourceRows', 'sourceColumns'])) {
                add(index, 'selection 只含 sourceTableOrdinal/sourceRows/sourceColumns，不能混入 sourceType/cellBindings/sourceQuotes');
            } else if (options.structuredArtifacts) {
                try { renderReaderTableSelection(binding, options.structuredArtifacts); }
                catch (error) { add(index, error.message); }
            }
            const marker = `[[TABLE_${binding.tableIndex}]]`;
            const occurrences = draft.sections.reduce((count, section) => count
                + String(section?.body || '').split(/\n\s*\n/).filter(block => block.trim() === marker).length, 0);
            if (occurrences !== 1) add(index, `的 ${marker} 必须在正文中唯一独占一段`);
            return;
        }
        if (!exactKeys(binding, ['tableIndex', 'sourceType', 'sourceTableOrdinal', 'cellBindings', 'sourceQuotes'])) {
            add(index, '普通绑定必须且仅含 tableIndex/sourceType/sourceTableOrdinal/cellBindings/sourceQuotes');
        }
        if (binding.sourceType === 'source_quotes') {
            if (binding.sourceTableOrdinal !== null || !Array.isArray(binding.cellBindings)
                || binding.cellBindings.length !== 0 || !Array.isArray(binding.sourceQuotes) || binding.sourceQuotes.length < 1) {
                add(index, 'source_quotes 结构非法：sourceTableOrdinal 必须为 null；cellBindings 必须是 []，'
                    + '不接受 quoteIndex/value/渲染坐标；sourceQuotes 必须为非空原文字符串数组');
            }
            if (Array.isArray(binding.sourceQuotes)) {
                const invalid = binding.sourceQuotes.flatMap((quote, quoteIndex) => (
                    typeof quote !== 'string' || quote.length < 12 || quote.length > 4000
                        || (typeof options.sourceText === 'string' && !options.sourceText.includes(quote)) ? [quoteIndex] : []
                ));
                if (invalid.length) add(index, `sourceQuotes 中以下数组项不是全文中12–4000字符的连续原句：${invalid.slice(0, 12).join(', ')}；`
                    + '不要只摘独立数值或把引文写成对象。原文双写数值可留在引文中，正文写法仍须通过原有的来源检查。',
                { diagnosticOnly: true });
            }
        } else if (binding.sourceType === 'artifact_table') {
            if (!Array.isArray(binding.cellBindings) || binding.sourceQuotes?.length !== 0) {
                add(index, 'artifact_table 要求完整 cellBindings 和空 sourceQuotes 数组');
            } else if (binding.cellBindings.some(cell => !exactKeys(cell,
                ['renderedRow', 'renderedColumn', 'sourceRow', 'sourceColumn']))) {
                add(index, 'artifact_table 每个cellBindings项必须且仅含 renderedRow/renderedColumn/sourceRow/sourceColumn');
            }
        } else add(index, 'sourceType 只能为 source_quotes 或 artifact_table；selection 是独立互斥结构');
        const matchingMarkers = markers.filter(marker => marker.tableIndex === binding.tableIndex);
        for (const marker of matchingMarkers) {
            add(index, `使用 ${binding.sourceType || '普通绑定'} 时正文必须直接写 Markdown 表，不能使用 ${marker.marker}；`
                + `同步修改 sections[${marker.sectionIndex}].body 与本绑定项`);
            issues.push({ path: `/sections/${marker.sectionIndex}/body`,
                message: `sections[${marker.sectionIndex}].body 的 ${marker.marker} 没有selection绑定，`
                    + `需由模型按原文写出完整Markdown表；tableBindings[${index}]本身不会生成表格` });
        }
    });
    for (const marker of markers) {
        if (!draft.tableBindings.some(binding => (binding?.selection || binding?.completeTable)
            && binding.tableIndex === marker.tableIndex)) {
            const message = `sections[${marker.sectionIndex}].body 存在未绑定的 ${marker.marker}；只有 selection 或 completeTable 模式可以使用 TABLE 标记`;
            if (!issues.some(issue => issue.path === `/sections/${marker.sectionIndex}/body`)) {
                issues.push({ path: `/sections/${marker.sectionIndex}/body`, message });
            }
        }
    }
    const selectionCount = draft.tableBindings.filter(binding => binding?.selection || binding?.completeTable).length;
    if (tables.length + selectionCount !== draft.tableBindings.length) {
        issues.push({ path: null, diagnosticOnly: true,
            message: `读者文章中的表格与来源对应记录数量不一致：正文有 ${tables.length} 张 Markdown 表、selection 有 ${selectionCount} 项、`
                + `tableBindings 有 ${draft.tableBindings.length} 项。source_quotes/artifact_table 都必须对应正文中的实际 Markdown 表；`
                + '能否用已有的原文引文自动补齐来源对应记录，仍由完整文章解析器检查。' });
    }
    return issues;
}

// 已有选择标记必须唯一、独占一段且仍处于原绑定对应的位置，不能借补绑定重新排列它。
function hasStableExistingTableMarkers(draft, tables, bindings) {
    const markers = tables.filter(table => table.marker);
    const rawMarkers = draft.sections.flatMap(section => String(section.body || '').match(/\[\[TABLE_[^\]]*\]\]/g) || []);
    if (rawMarkers.length !== markers.length || new Set(rawMarkers).size !== markers.length) return false;
    return tables.every((table, index) => table.marker
        ? table.marker === `[[TABLE_${index + 1}]]` && Boolean(bindings[index]?.selection || bindings[index]?.completeTable)
            && String(draft.sections[table.sectionIndex].body || '').split(/\n\s*\n/)
                .filter(block => block.trim() === table.marker).length === 1
        : Boolean(table.table) && !bindings[index]?.selection && !bindings[index]?.completeTable)
        && bindings.every((binding, index) => !(binding.selection || binding.completeTable) || tables[index]?.marker === `[[TABLE_${index + 1}]]`);
}

// 只为已经写出的普通表补足缺失绑定；正文和未被诊断的旧绑定不能改。
function buildReindexedTableBindingsOperation(draft, issues) {
    if (!issues.some(issue => classifyTableBindingOrderIssue(issue).actionable)) return null;
    const bindings = draft.tableBindings;
    const tables = locateReaderDraftTables(draft);
    if (!Array.isArray(bindings) || !bindings.length || tables.length <= bindings.length
        || tables.length - bindings.length > 4
        || bindings.some((binding, index) => binding?.tableIndex !== index + 1)) return null;
    const markers = tables.filter(table => table.marker);
    const rawMarkers = draft.sections.flatMap(section => String(section.body || '').match(/\[\[TABLE_[^\]]*\]\]/g) || []);
    if (!markers.length || rawMarkers.length !== markers.length
        || new Set(rawMarkers).size !== markers.length) return null;
    const bindingMoves = [];
    for (let index = 0; index < bindings.length; index += 1) {
        const binding = bindings[index];
        if (!binding.selection) {
            if (!tables[index]?.table) return null;
            bindingMoves.push({ oldIndex: index, newIndex: index });
            continue;
        }
        const matching = tables.flatMap((table, tableIndex) => table.marker === `[[TABLE_${index + 1}]]`
            ? [{ table, tableIndex }] : []);
        if (matching.length !== 1) return null;
        const { table, tableIndex } = matching[0];
        if (!String(draft.sections[table.sectionIndex].body || '').split(/\n\s*\n/)
            .some(block => block.trim() === table.marker)) return null;
        bindingMoves.push({ oldIndex: index, newIndex: tableIndex });
    }
    if (markers.some(table => !bindings[table.markerIndex - 1]?.selection)
        || new Set(bindingMoves.map(move => move.newIndex)).size !== bindings.length
        || bindingMoves.every(move => move.oldIndex === move.newIndex)) return null;
    const missingBindingIndices = tables.flatMap((table, index) =>
        bindingMoves.some(move => move.newIndex === index) ? [] : [index]);
    if (missingBindingIndices.some(index => !tables[index].table)) return null;
    const markerChanges = markers.map(table => ({
        sectionIndex: table.sectionIndex,
        oldMarker: table.marker,
        newMarker: `[[TABLE_${tables.indexOf(table) + 1}]]`
    })).filter(change => change.oldMarker !== change.newMarker);
    const bodyPaths = [...new Set(markerChanges.map(change => `/sections/${change.sectionIndex}/body`))];
    if (bodyPaths.length > 7) return null;
    return { kind: 'complete_reindexed_table_bindings_v1', expectedTableCount: tables.length,
        bindingMoves, missingBindingIndices, markerChanges,
        requiredReplacementPaths: ['/tableBindings', ...bodyPaths], requiredPostconditions: [
            '本轮特别允许同时补齐整组表格来源记录并按真实正文表序重编号原有唯一选择标记',
            '正文仅可替换列出的标记编号，所有原表、数字、解释及其余正文逐字保留',
            '全部旧来源记录原样保留；选择记录只改变外层tableIndex，selection内容不得改变',
            '缺口只能对应已经写出的普通表，新增绑定仍须完整DOM单元格或逐字原句核验'
        ] };
}

function buildMissingTableBindingsOperation(draft, issues) {
    if (!issues.some(issue => classifyTableBindingOrderIssue(issue).actionable)) return null;
    const tables = locateReaderDraftTables(draft);
    const bindings = draft.tableBindings;
    if (!Array.isArray(bindings) || !bindings.length || tables.length <= bindings.length
        || tables.length - bindings.length > 4 || !hasStableExistingTableMarkers(draft, tables, bindings)
        || bindings.some((binding, index) => binding?.tableIndex !== index + 1)) return null;
    const mutableBindingIndices = [...new Set(issues.filter(issue => issue?.diagnosticOnly !== true
        && classifyTableBindingOrderIssue(issue).actionable)
        .map(issue => /^\/tableBindings\/(0|[1-9]\d*)$/.exec(String(issue.path || ''))?.[1])
        .filter(index => index !== undefined).map(Number))].filter(index => index < bindings.length && !bindings[index]?.selection && !bindings[index]?.completeTable);
    return { kind: 'complete_existing_table_bindings_v1', expectedTableCount: tables.length,
        existingBindingCount: bindings.length, mutableBindingIndices,
        requiredReplacementPaths: ['/tableBindings'], requiredPostconditions: [
            '正文所有原表、数字、单位和顺序保持逐字不变，只补足已有表的绑定',
            '只有mutableBindingIndices明确列出的旧绑定可修正，其余旧绑定逐字保留',
            '新数组按正文表序连续编号，新增绑定数量恰好等于已有表的缺口',
            '不得编造证据，全部绑定仍须通过完整来源、排序和正文解析器'
        ] };
}

function buildUniqueMissingQuoteTableOperation(draft, issues) {
    if (!issues.some(issue => classifyTableBindingOrderIssue(issue).actionable)) return null;
    const tables = locateReaderDraftTables(draft);
    const bindings = draft.tableBindings;
    if (!Array.isArray(bindings) || tables.length + 1 !== bindings.length
        || bindings.some((binding, index) => binding?.tableIndex !== index + 1)) return null;
    const candidates = [];
    for (let index = 1; index < bindings.length - 1; index += 1) {
        const binding = bindings[index];
        if (binding?.sourceType !== 'source_quotes' || !Array.isArray(binding.sourceQuotes)
            || !binding.sourceQuotes.length || !bindings[index + 1]?.selection) continue;
        const remaining = bindings.filter((_item, ordinal) => ordinal !== index);
        const matches = remaining.every((item, ordinal) => item.selection
            ? tables[ordinal]?.marker === `[[TABLE_${item.tableIndex}]]`
                && draft.sections.reduce((count, section) => count
                    + String(section?.body || '').split(`[[TABLE_${item.tableIndex}]]`).length - 1, 0) === 1
            : !tables[ordinal]?.marker && Boolean(tables[ordinal]?.table));
        const next = tables[index];
        if (!matches || !next?.marker
            || !['result', 'ablation'].includes(draft.sections[next.sectionIndex]?.kind)) continue;
        const destinationSectionPath = `/sections/${next.sectionIndex}/body`;
        const bindingPath = `/tableBindings/${index}`;
        candidates.push({ kind: 'add_result_table_v1', destinationSectionIndex: next.sectionIndex,
            bindingIndex: index, tableIndex: index + 1, destinationSectionPath, bindingPath,
            insertionBeforeMarker: next.marker,
            requiredReplacementPaths: [destinationSectionPath, bindingPath],
            requiredPostconditions: ['insert exactly one source-backed Markdown table before insertionBeforeMarker',
                'all existing tables, selection markers and other bindings remain byte-identical',
                'replace sourceQuotes only with exact continuous source text; final source parser remains mandatory'] });
    }
    return candidates.length === 1 ? candidates[0] : null;
}

function buildMissingResultTableOperation(draft, issues) {
    const blockingIssues = issues.filter(issue => issue?.diagnosticOnly !== true
        && !classifyTableBindingOrderIssue(issue).ignoreMessageForRepair
        && issue?.code !== TABLE_COUNT_ISSUE_CODE && !readTableCountIssue(issue));
    if (!blockingIssues.some(issue => issue?.code === 'reader_result_table_missing'
        || /^读者文章主结果表覆盖不足/.test(String(issue?.message || '')))) return null;
    const locatedTables = locateReaderDraftTables(draft);
    // 无selection绑定的标记不是已存在的表；先按对应诊断修复，不能再要求新增。
    if (locatedTables.some(table => table.marker
        && !draft.tableBindings?.[table.markerIndex - 1]?.selection)) return null;
    const destinationSectionIndex = draft.sections.findIndex(section => (
        ['result', 'ablation'].includes(section?.kind)
    ));
    // 模型声明了绑定却漏掉对应的 Markdown 表时，搬一张现成的表补不上这个
    // 缺口：去掉一张再加一张，表数没变。这里改为授权最小且不造假的那种修复：
    // 在 result/ablation 里补上缺失的 source_quotes 表，只替换它已经声明的
    // 那个绑定。完整解析器仍会核对每条引文和每个数字单元格；这个操作本身
    // 不造证据。
    if (locatedTables.length < draft.tableBindings.length && destinationSectionIndex >= 0) {
        const missingBindingIndex = locatedTables.length;
        const binding = draft.tableBindings[missingBindingIndex];
        if (binding && binding.tableIndex === missingBindingIndex + 1
            && binding.sourceType === 'source_quotes'
            && Array.isArray(binding.sourceQuotes) && binding.sourceQuotes.length > 0) {
            const destinationSectionPath = `/sections/${destinationSectionIndex}/body`;
            const bindingPath = `/tableBindings/${missingBindingIndex}`;
            return {
                kind: 'add_result_table_v1',
                destinationSectionIndex,
                bindingIndex: missingBindingIndex,
                tableIndex: missingBindingIndex + 1,
                destinationSectionPath,
                bindingPath,
                requiredReplacementPaths: [destinationSectionPath, bindingPath],
                requiredPostconditions: [
                    '结果或消融小节每次只补一张含数字的表；原表可用时，以selection记录所选行列并单独放置TABLE标记；否则用source_quotes记录完整逐字引文并配Markdown表格',
                    '每次补上一张已声明来源的表，剩余缺表仍须逐项修复',
                    '新增表和对应来源记录须使用同一tableIndex；原表可用时须采用selection，并通过完整的原表来源检查'
                ]
            };
        }
    }
    const tableToMove = locatedTables.filter(table => (
        typeof table.table?.markdown === 'string'
        && table.table.markdown.trim().length > 0
        && Number.isInteger(table.bindingIndex)
        && draft.tableBindings?.[table.bindingIndex]
        && !['result', 'ablation'].includes(draft.sections?.[table.sectionIndex]?.kind)
    )).sort((left, right) => (
        (draft.sections?.[left.sectionIndex]?.kind === 'experiment_setup' ? 0 : 1)
            - (draft.sections?.[right.sectionIndex]?.kind === 'experiment_setup' ? 0 : 1)
        || right.tableIndex - left.tableIndex
    ))[0];
    if (!tableToMove || destinationSectionIndex < 0) return null;
    const sourceSectionPath = tableToMove.path;
    const destinationSectionPath = `/sections/${destinationSectionIndex}/body`;
    const bindingPath = `/tableBindings/${tableToMove.bindingIndex}`;
    return {
        kind: 'relocate_result_table_v1',
        donorGlobalTableIndex: tableToMove.tableIndex,
        donorTableMarkdownSha256: hashDraft(tableToMove.table.markdown),
        preserveDonorMarkdown: draft.tableBindings?.[tableToMove.bindingIndex]?.sourceType === 'artifact_table',
        donorOrdinalInSection: locatedTables.filter(table => table.sectionIndex === tableToMove.sectionIndex
            && table.line <= tableToMove.line).length,
        donorSectionIndex: tableToMove.sectionIndex,
        destinationSectionIndex,
        bindingIndex: tableToMove.bindingIndex,
        donorSectionPath: sourceSectionPath,
        destinationSectionPath,
        bindingPath,
        requiredReplacementPaths: [sourceSectionPath, destinationSectionPath, bindingPath],
        requiredPostconditions: [
            'donor section loses exactly one Markdown table',
            'destination result/ablation section gains exactly one numeric Markdown table',
            'the total table count and binding stream stay closed',
            'the moved table and binding remain paired; signed artifact tables keep their exact Markdown'
        ]
    };
}

function buildMissingNarrativeTableOperation(draft, issues) {
    const issue = issues.filter(item => item?.diagnosticOnly !== true).find(item => (
        !classifyTableBindingOrderIssue(item).ignoreMessageForRepair && readTableCountIssue(item)
    ));
    const counts = readTableCountIssue(issue);
    if (!counts) return null;
    const { requiredCount, actualCount } = counts;
    const tables = locateReaderDraftTables(draft);
    const bindings = Array.isArray(draft?.tableBindings) ? draft.tableBindings : [];
    if (actualCount >= requiredCount
        || !bindings.every((binding, index) => binding?.tableIndex === index + 1)) return null;
    const trailingTable = tables.at(-1);
    const destinationSectionIndex = trailingTable?.sectionIndex;
    if (!trailingTable?.table || !['result', 'ablation'].includes(
        draft.sections?.[destinationSectionIndex]?.kind
    )) return null;
    const bindingIndex = bindings.length;
    const tableIndex = bindingIndex + 1;
    if (requiredCount === tables.length && tables.length === bindings.length + 1
        && trailingTable.tableIndex === tableIndex) {
        return {
            kind: 'bind_trailing_narrative_table_v1', destinationSectionIndex,
            bindingIndex, tableIndex, requiredReplacementPaths: ['/tableBindings'],
            requiredPostconditions: [
                'all authored tables remain byte-identical and in the same order',
                'all existing table bindings remain byte-identical',
                'exactly one source_quotes binding is appended for the trailing table'
            ]
        };
    }
    if (requiredCount === tables.length + 1 && tables.length === bindings.length) {
        const destinationSectionPath = `/sections/${destinationSectionIndex}/body`;
        return {
            kind: 'append_narrative_table_v1', destinationSectionIndex,
            bindingIndex, tableIndex, destinationSectionPath,
            requiredReplacementPaths: [destinationSectionPath, '/tableBindings'],
            requiredPostconditions: [
                'all existing tables and bindings remain byte-identical and in the same order',
                'the destination result/ablation section gains exactly one numeric Markdown table',
                'exactly one source_quotes binding is appended for the new trailing table'
            ]
        };
    }
    return null;
}

// 没有传入像素时，只删除独立图标记；其余正文逐字保留，内容问题仍须后续核验。
function removeUnavailableFigureProse(body) {
    return String(body).replace(/^[ \t]*\[\[FIGURE_\d+\]\][ \t]*(?:\r?\n|$)/gm, '');
}

function buildMissingFormulaBindingsOperation(draft, issues) {
    if (!issues.some(issue => issue?.diagnosticOnly !== true
        && /formulaBindings 未覆盖正文公式占位符/.test(String(issue?.message || '')))) return null;
    const bindings = draft.formulaBindings;
    if (!Array.isArray(bindings) || !bindings.length) return null;
    const markers = [];
    for (const section of draft.sections || []) {
        for (const match of String(section.body || '').matchAll(/\[\[FORMULA_(\d+)\]\]/g)) {
            if (!String(section.body).split(/\n\s*\n/).some(block => block.trim() === match[0])) return null;
            markers.push({ formulaOrdinal: Number(match[1]), targetKind: section.kind, marker: match[0] });
        }
    }
    if (new Set(markers.map(item => item.marker)).size !== markers.length
        || bindings.some(binding => Object.keys(binding).sort().join(',') !== 'formulaOrdinal,marker,targetKind'
            || !markers.some(marker => hashDraft(marker) === hashDraft(binding)))
        || new Set(bindings.map(item => item.marker)).size !== bindings.length) return null;
    const missingBindings = markers.filter(marker => !bindings.some(binding => binding.marker === marker.marker));
    if (!missingBindings.length || missingBindings.length > 4) return null;
    return { kind: 'complete_existing_formula_bindings_v1', expectedBindingCount: markers.length,
        missingBindings, requiredReplacementPaths: ['/formulaBindings'], requiredPostconditions: [
            '本轮特别允许补齐整组公式来源记录（formulaBindings），其余数组数量限制保持不变',
            '只追加正文已有独立且唯一公式标记对应的记录，旧记录和全部正文逐字保留',
            '公式编号必须属于请求列出的 FORMULA_ORDINALS_AVAILABLE，全部来源仍经完整解析器核验'
        ] };
}

function observedFigureSelectionOperation(draft, options = {}) {
    if (!Array.isArray(options.availableFigureOrdinals) || !options.availableFigureOrdinals.length
        || options.availableFigureOrdinals.some(ordinal => !Number.isInteger(ordinal) || ordinal < 1)
        || !Array.isArray(draft?.figurePlacements) || draft.figurePlacements.length <= READER_LIMITS.maximumFigures
        || draft.figurePlacements.length > 16 || !Array.isArray(draft.sections)) return null;
    const ordinals = draft.figurePlacements.map(item => item?.figureOrdinal);
    if (ordinals.some(ordinal => !Number.isInteger(ordinal) || ordinal < 1)) return null;
    const allowedFigureOrdinals = [...new Set(ordinals.filter(ordinal => options.availableFigureOrdinals.includes(ordinal)))];
    if (!allowedFigureOrdinals.length) return null;
    const targetKinds = new Set(draft.figurePlacements.map(item => item.targetKind));
    const affectedSectionIndexes = draft.sections.flatMap((section, index) => {
        const text = `${section.heading || ''}\n${section.body || ''}`;
        return ordinals.some(ordinal => new RegExp(`(?:图|Figure)\\s*${ordinal}(?!\\d)`, 'i').test(text))
            || /\[\[FIGURE_\d+\]\]/.test(JSON.stringify(section))
            || (targetKinds.has(section.kind) && /看图|读图|图中|横轴|纵轴|坐标轴|颜色|热图|曲线|图注|图解|误差棒|红色|蓝色|绿色/.test(text)) ? [index] : [];
    });
    if (affectedSectionIndexes.length > 7 || affectedSectionIndexes.some(index => Object.entries(draft.sections[index])
        .some(([key, value]) => !['kind', 'heading', 'body'].includes(key)
            && (!/^\[\[(?:FIGURE|TABLE|FORMULA|CONCEPT_BRIDGE)_\d+\]\]$/.test(key) || value !== 'placeholder')))) return null;
    return { kind: 'select_observed_figures_v1', allowedFigureOrdinals, affectedSectionIndexes,
        requiredReplacementPaths: ['/figurePlacements', ...affectedSectionIndexes.map(index => `/sections/${index}`)],
        requiredPostconditions: [
            '按文章问题选择1–4张本次收到像素的原图，保留项逐字复制旧声明，不新增或改写focusPoints；重复编号只能保留一次',
            '同步重写全部授权图片相关小节，只保留kind、heading、body；保留图各一个正文标记，取消展示图不留标记',
            '被取消图的视觉解读按封存文字重新表达，不能只删标记保留看图、颜色或坐标轴陈述；正确文字事实、数字和条件仍须保留',
            '保留所有TABLE、FORMULA、CONCEPT_BRIDGE标记；非法placeholder键中的非图标记按原顺序迁入body',
            '其他小节、术语桥、表格和公式来源绑定逐字保留；修复后仍须完整解析和来源核验'
        ] };
}

function unavailableFigureCleanupOperation(draft, options = {}) {
    if (!Array.isArray(options.availableFigureOrdinals) || options.availableFigureOrdinals.length
        || !Array.isArray(draft?.figurePlacements) || !draft.figurePlacements.length
        || !Array.isArray(draft.sections)) return null;
    const ordinals = draft.figurePlacements.map(item => item?.figureOrdinal);
    if (ordinals.some(ordinal => !Number.isInteger(ordinal) || ordinal < 1)) return null;
    const targetKinds = new Set(draft.figurePlacements.map(item => item.targetKind));
    const affectedSectionIndexes = draft.sections.flatMap((section, index) => {
        const text = `${section.heading || ''}\n${section.body || ''}`;
        const mentionsFigure = ordinals.some(ordinal => new RegExp(
            `(?:图|Figure)\\s*${ordinal}(?!\\d)`, 'i').test(text));
        const visualInterpretation = targetKinds.has(section.kind)
            && /看图|读图|图中|横轴|纵轴|坐标轴|颜色|热图|曲线|图注|图解|误差棒|红色|蓝色|绿色/.test(text);
        return mentionsFigure || visualInterpretation
            || /\[\[FIGURE_\d+\]\]/.test(JSON.stringify(section)) ? [index] : [];
    });
    if (affectedSectionIndexes.length > 7 || affectedSectionIndexes.some(index => (
        Object.keys(draft.sections[index]).some(key => !['kind', 'heading', 'body', 'marker', 'targetKind'].includes(key))
    ))) return null;
    return { kind: 'cleanup_unavailable_figures_v1', affectedSectionIndexes,
        requiredReplacementPaths: ['/figurePlacements', ...affectedSectionIndexes.map(index => `/sections/${index}`)],
        requiredPostconditions: [
            '本次没有图片像素，清空图片声明，并按封存文本重写列出的图片相关小节',
            '删除无证据的颜色、坐标、曲线和看图解读，不能只删图标记而保留臆测图解',
            '小节只保留kind、heading、body，kind原样；保留有原文证据的事实、数字、单位和条件',
            '其他小节、表格、公式、术语桥和全部来源记录逐字保留；不得新增图或图标记'
        ] };
}

function buildRepairTargets(draft, issues, options = {}) {
    const observedFigures = observedFigureSelectionOperation(draft, options);
    if (observedFigures) return observedFigures.requiredReplacementPaths.map(pointer => ({
        path: pointer, oldSha256: hashDraft(nodeAt(draft, pointer)), value: nodeAt(draft, pointer),
        repairInstruction: observedFigures.requiredPostconditions.join('；')
    }));
    const unavailableFigures = unavailableFigureCleanupOperation(draft, options);
    if (unavailableFigures) return unavailableFigures.requiredReplacementPaths.map(pointer => ({
        path: pointer, oldSha256: hashDraft(nodeAt(draft, pointer)), value: nodeAt(draft, pointer),
        repairInstruction: unavailableFigures.requiredPostconditions.join('；')
    }));
    if (sectionReorganizationOperation(draft)) return [{ path: '/sections',
        oldSha256: hashDraft(draft.sections), value: draft.sections,
        repairInstruction: '只将过多小节重组为12–18节，合并的标题改作正文子标题；保留全部正确文字、数字、单位、图表公式标记与对应顺序。额外字段中的内容须依原文核对后归入正文，不能直接丢弃。' }];
    const reindexedOperation = buildReindexedTableBindingsOperation(draft, issues);
    if (reindexedOperation) return reindexedOperation.requiredReplacementPaths.map(pointer => ({
        path: pointer, oldSha256: hashDraft(nodeAt(draft, pointer)), value: nodeAt(draft, pointer),
        repairInstruction: reindexedOperation.requiredPostconditions.join('；')
    }));
    const formulaOperation = buildMissingFormulaBindingsOperation(draft, issues);
    if (formulaOperation) return [{ path: '/formulaBindings', oldSha256: hashDraft(draft.formulaBindings),
        value: draft.formulaBindings, repairInstruction: formulaOperation.requiredPostconditions.join('；') }];
    const paths = new Set();
    const add = pointer => {
        try {
            nodeAt(draft, pointer);
            if (/^\/sections\/\d+\/body$/.test(pointer) && paths.has(pointer.slice(0, -5))) return;
            if (/^\/sections\/\d+$/.test(pointer)) paths.delete(`${pointer}/body`);
            paths.add(pointer);
        } catch { /* 根对象形状不对，只能整轮重试。 */ }
    };
    const sectionForBinding = (field, index) => {
        const binding = draft[field]?.[index];
        if (!binding) return;
        draft.sections.forEach((section, sectionIndex) => {
            if ((binding.marker && String(section?.body || '').includes(binding.marker))
                || section?.kind === (binding.targetKind || binding.sectionKind)) add(`/sections/${sectionIndex}/body`);
        });
    };
    if (issues.some(issue => /论文没有可用 Figure，figurePlacements\s*必须为空/.test(String(issue?.message || '')))
        && draft.figurePlacements?.length) {
        add('/figurePlacements');
        draft.sections.forEach((section, index) => {
            if (removeUnavailableFigureProse(section.body) !== section.body) add(`/sections/${index}/body`);
        });
        if (paths.size > 8) return [];
        return [...paths].map(pointer => ({ path: pointer,
            oldSha256: hashDraft(nodeAt(draft, pointer)), value: nodeAt(draft, pointer),
            repairInstruction: pointer === '/figurePlacements' ? '本次没有可用图像素，只清空为 []；不新增图或图解。'
                : '只移除独立图标记；包括数字、方法、表格与图解在内的其他正文逐字保留。此操作不认证残留图解的内容正确性。',
            expectedCleanupValue: pointer === '/figurePlacements' ? [] : removeUnavailableFigureProse(nodeAt(draft, pointer)) }));
    }
    const conceptBridgePlacementGroup = issue => {
        const message = String(issue?.message || '');
        if (!(/marker 必须唯一独占一段并位于声明 kind 小节/.test(message)
            || (/未形成有效术语桥/.test(message)
                && /已有marker必须唯一独占一段且位于声明小节/.test(message))
            || (/的占位标记、解释长度或所在小节不符合要求/.test(message)
                && /已有占位标记须在指定小节中独占一段，且全文只能出现一次/.test(message)))) return null;
        const pathIndex = /^\/conceptBridges\/(\d+)$/.exec(String(issue?.path || ''))?.[1];
        const messageIndex = /conceptBridges\[(\d+)\]/.exec(message)?.[1];
        const index = Number(pathIndex ?? messageIndex);
        const binding = Number.isInteger(index) ? draft.conceptBridges?.[index] : null;
        if (!binding || binding.marker !== `[[CONCEPT_BRIDGE_${index + 1}]]`
            || !Array.isArray(binding.terms) || binding.terms.length !== 2
            || binding.terms.some(term => typeof term !== 'string'
                || term.trim().length < 2 || term.trim().length > 48)
            || typeof binding.explanation !== 'string'
            || binding.explanation.trim().length < 45 || binding.explanation.trim().length > 320) return null;
        const sectionIndexes = draft.sections.flatMap((section, sectionIndex) => (
            String(section?.body || '').includes(binding.marker) ? [sectionIndex] : []
        ));
        const hasDeclaredStandaloneMarker = sectionIndexes.some(sectionIndex => (
            draft.sections[sectionIndex]?.kind === binding.sectionKind
            && String(draft.sections[sectionIndex]?.body || '').split(/\n\s*\n|\\n/)
                .map(block => block.trim()).includes(binding.marker)
        ));
        if (!hasDeclaredStandaloneMarker) {
            const declaredSectionIndex = draft.sections.findIndex(section => section?.kind === binding.sectionKind);
            if (declaredSectionIndex >= 0) sectionIndexes.push(declaredSectionIndex);
        }
        return { index, paths: [...new Set(sectionIndexes)].map(sectionIndex => `/sections/${sectionIndex}/body`) };
    };
    // 来源诊断说明的是权威解析器为什么失败，不是让你同时把相关的表全改一遍。
    // 只要存在阻塞性问题，就只针对阻塞性问题修。这样局部的 marker 和正文
    // 修复能压在八个节点的补丁上限之内，剩下的来源问题交给完整解析器之后暴露。
    const isCountDiagnostic = issue => issue?.code === TABLE_COUNT_ISSUE_CODE || readTableCountIssue(issue);
    const selectableIssues = issues.filter(issue => {
        const orderIssue = classifyTableBindingOrderIssue(issue);
        return !orderIssue.ignoreMessageForRepair || orderIssue.actionable;
    });
    const allBlockingIssues = selectableIssues.filter(issue => issue?.diagnosticOnly !== true);
    const blockingIssues = allBlockingIssues.filter(issue => !isCountDiagnostic(issue));
    let actionableIssues = (allBlockingIssues.length ? blockingIssues : selectableIssues)
        .filter(issue => !isCountDiagnostic(issue));
    const firstSubstantiveIssue = actionableIssues.find(issue => (
        classifyTableBindingOrderIssue(issue).ignoreMessageForRepair
            || !String(issue?.message || '').startsWith('Reader patch rejected:')
    ));
    const firstPlacementGroup = classifyTableBindingOrderIssue(firstSubstantiveIssue).ignoreMessageForRepair
        ? null : conceptBridgePlacementGroup(firstSubstantiveIssue);
    if (firstPlacementGroup) {
        // 桥接位置不对，不等于可以改一个本来有效的桥接定义。一次可能同时诊断出
        // 好几个重复 marker，所以在稳定顺序下收集正文分组，但仍要守在八个节点
        // 的补丁上限内。剩下没解决的交给完整解析器暴露。
        const seenBridgeIndexes = new Set();
        for (const issue of actionableIssues) {
            if (classifyTableBindingOrderIssue(issue).ignoreMessageForRepair) continue;
            const group = conceptBridgePlacementGroup(issue);
            if (!group || seenBridgeIndexes.has(group.index)) continue;
            seenBridgeIndexes.add(group.index);
            for (const pointer of group.paths) {
                if (paths.size >= 8) break;
                add(pointer);
            }
            if (paths.size >= 8) break;
        }
        if (paths.size) {
            return [...paths].map(pointer => ({ path: pointer,
                oldSha256: hashDraft(nodeAt(draft, pointer)), value: nodeAt(draft, pointer) }));
        }
    }
    // 缺失的表格插入标记没有现成正文位置，不能因其他小节问题已占目标
    // 而只授权改绑定。先把绑定与结果正文一起交给模型，原解析器仍核验来源。
    const missingSelection = blockingIssues.find(issue => {
        const index = /^\/tableBindings\/(\d+)$/.exec(String(issue?.path || ''))?.[1];
        const binding = index === undefined ? null : draft.tableBindings?.[Number(index)];
        const marker = binding?.selection || binding?.completeTable ? `[[TABLE_${binding.tableIndex}]]` : null;
        return marker && /唯一独占一段/.test(String(issue?.message || ''))
            && !draft.sections.some(section => String(section?.body || '').includes(marker));
    });
    if (missingSelection) {
        const destinations = draft.sections.flatMap((section, index) => (
            ['result', 'ablation'].includes(section?.kind) ? [`/sections/${index}/body`] : []
        ));
        if (destinations.length && destinations.length < 8) {
            paths.clear();
            add(missingSelection.path);
            destinations.forEach(add);
            return [...paths].map(pointer => ({ path: pointer,
                oldSha256: hashDraft(nodeAt(draft, pointer)), value: nodeAt(draft, pointer) }));
        }
    }
    const stableMissingTableOperation = buildMissingTableBindingsOperation(draft, issues);
    if (stableMissingTableOperation) return [{ path: '/tableBindings',
        oldSha256: hashDraft(draft.tableBindings), value: draft.tableBindings }];
    // 已定位的坏绑定先与对应正文成对修复；不能被数量诊断挤出权限。
    // 每组整体加入，八个节点上限不能把绑定与正文从中间截开。
    const pairedTableIssues = blockingIssues.filter(issue => (
        /^\/tableBindings\/\d+$/.test(String(issue?.path || ''))
        && !classifyTableBindingOrderIssue(issue).ignoreMessageForRepair
        && issue.code !== TABLE_BINDING_ORDER_ISSUE_CODE
    ));
    const orderPathsExceedLimit = new Set(blockingIssues.filter(issue => (
        classifyTableBindingOrderIssue(issue).actionable && issue.path
    )).map(issue => issue.path)).size > 8;
    if ((pairedTableIssues.length
        && locateReaderDraftTables(draft).length !== draft.tableBindings?.length) || orderPathsExceedLimit) {
        const tables = locateReaderDraftTables(draft);
        const bindingIndexes = pairedTableIssues.length
            ? [...new Set(pairedTableIssues.map(issue => Number(issue.path.split('/').at(-1))))]
            : (draft.tableBindings || []).map((_binding, index) => index);
        const unboundMarkerPaths = orderPathsExceedLimit ? [...new Set(tables.filter(table => (
            table.marker && !draft.tableBindings?.[table.markerIndex - 1]
        )).map(table => table.path))] : [];
        // 未绑定的末尾标记也可能暴露紧邻旧绑定的错位，先授权这一对。
        if (unboundMarkerPaths.length && !pairedTableIssues.length && bindingIndexes.length) {
            bindingIndexes.unshift(bindingIndexes.pop());
        }
        const pairedPaths = new Set(unboundMarkerPaths.slice(0, 8));
        for (const index of bindingIndexes) {
            const binding = draft.tableBindings?.[index];
            if (!binding) continue;
            const marker = `[[TABLE_${binding.tableIndex}]]`;
            const markedSections = draft.sections.flatMap((section, sectionIndex) => (
                String(section?.body || '').includes(marker) ? [`/sections/${sectionIndex}/body`] : []
            ));
            const bodyPaths = markedSections.length ? markedSections
                : tables[index]?.path ? [tables[index].path] : [];
            if (!bodyPaths.length) continue;
            const group = [...new Set([...bodyPaths, `/tableBindings/${index}`])];
            const additions = group.filter(pointer => !pairedPaths.has(pointer));
            if (pairedPaths.size + additions.length > 8) break;
            group.forEach(pointer => pairedPaths.add(pointer));
        }
        if (pairedPaths.size) return [...pairedPaths].map(pointer => ({
            path: pointer, oldSha256: hashDraft(nodeAt(draft, pointer)), value: nodeAt(draft, pointer),
            ...(unboundMarkerPaths.includes(pointer) ? { repairInstruction:
                '本正文存在没有对应来源记录的表标记。只按请求中的原文证据将其改为实际 Markdown 表，保留全部正确解释、数字和条件；不得猜测缺失来源或删除表格求通过。新增来源记录须等待后续明确授权。' } : {})
        }));
    }
    const missingNarrativeTableIssue = allBlockingIssues.find(issue => (
        !classifyTableBindingOrderIssue(issue).ignoreMessageForRepair && readTableCountIssue(issue)
    ));
    const missingNarrativeTableOperation = buildMissingNarrativeTableOperation(draft, issues);
    const ambiguousTableOrderIssue = blockingIssues.find(issue => (
        classifyTableBindingOrderIssue(issue).actionable
    ));
    const missingResultTableOperation = buildUniqueMissingQuoteTableOperation(draft, issues)
        || buildMissingResultTableOperation(draft, issues);
    if (ambiguousTableOrderIssue && missingResultTableOperation) {
        // 表格数量尚未对应时，补表或搬表指令与允许修改的路径必须一致。
        // 不能先授权最后一个实验小节，再要求模型修改第一个结果小节。
        missingResultTableOperation.requiredReplacementPaths.forEach(add);
        return [...paths].map(pointer => ({ path: pointer,
            oldSha256: hashDraft(nodeAt(draft, pointer)), value: nodeAt(draft, pointer) }));
    }
    if (ambiguousTableOrderIssue && buildMissingTableBindingsOperation(draft, issues)) {
        return [{ path: '/tableBindings', oldSha256: hashDraft(draft.tableBindings), value: draft.tableBindings }];
    }
    if (ambiguousTableOrderIssue) {
        const tables = locateReaderDraftTables(draft);
        const bindings = Array.isArray(draft.tableBindings) ? draft.tableBindings : [];
        if (tables.length < bindings.length) {
            const destination = tables.at(-1)?.path || draft.sections.flatMap((section, index) => (
                ['result', 'ablation'].includes(section?.kind) ? [`/sections/${index}/body`] : []
            )).at(-1);
            if (destination) add(destination);
            if (bindings[tables.length]) add(`/tableBindings/${tables.length}`);
        } else if (tables.length > bindings.length) {
            for (const table of tables) add(table.path);
            bindings.forEach((_binding, index) => add(`/tableBindings/${index}`));
        } else {
            for (const table of tables) add(table.path);
            bindings.forEach((_binding, index) => add(`/tableBindings/${index}`));
        }
        if (paths.size) {
            return [...paths].slice(0, 8).map(pointer => ({ path: pointer,
                oldSha256: hashDraft(nodeAt(draft, pointer)), value: nodeAt(draft, pointer) }));
        }
    }
    if (missingNarrativeTableIssue) {
        // 草稿已经声明了缺失的绑定时，只在最后一张现成的表旁边新增一张表。
        // 旧的那条通用表格分支会把每个实验小节、每个绑定都授权出去，结果
        // 「补一张表」的修复大到在 JSON 后缀之前就被截断。顺序和每一项来源
        // 核验仍由完整解析器复核。
        const tables = locateReaderDraftTables(draft);
        const missingBindingIndex = tables.length;
        if (missingNarrativeTableOperation) {
            missingNarrativeTableOperation.requiredReplacementPaths.forEach(add);
            actionableIssues = actionableIssues.filter(issue => issue !== missingNarrativeTableIssue);
        } else if (tables.length && draft.tableBindings?.[missingBindingIndex]) {
            add(tables.at(-1).path);
            add(`/tableBindings/${missingBindingIndex}`);
            actionableIssues = actionableIssues.filter(issue => issue !== missingNarrativeTableIssue);
        } else {
            // 原子化那几种情况不适用时，沿用原来的计数修复范围。选哪些节点看的是
            // 草稿结构，所以改诊断措辞不会把修复转到别处。
            tables.forEach(table => add(table.path));
            draft.tableBindings.forEach((_binding, index) => add(`/tableBindings/${index}`));
            if (![...paths].some(pointer => pointer.startsWith('/sections/'))) {
                draft.sections.forEach((section, index) => {
                    if (['training', 'experiment_setup', 'result', 'ablation'].includes(section?.kind)) {
                        add(`/sections/${index}/body`);
                    }
                });
            }
        }
    }
    const missingResultTableIssue = blockingIssues.find(issue => (
        !classifyTableBindingOrderIssue(issue).ignoreMessageForRepair
        && (issue?.code === 'reader_result_table_missing'
            || /^读者文章主结果表覆盖不足/.test(String(issue?.message || '')))
    ));
    if (missingResultTableIssue && missingResultTableOperation) {
        if (missingResultTableOperation.kind === 'add_result_table_v1') {
            // 这个候选声明了绑定，却没有对应的表。只允许改目标正文和那个绑定；
            // 这样就逼着模型交出有证据支撑的结果表，而不是把 setup/配置表
            // 换个标签充数。
            add(missingResultTableOperation.destinationSectionPath);
            add(missingResultTableOperation.bindingPath);
        } else {
            // 复用已有表格及其对应来源绑定的序号。搬动或替换最后一张
            // 实验设置表，能保住后面所有表的序号不变。
            add(missingResultTableOperation.donorSectionPath);
            add(missingResultTableOperation.destinationSectionPath);
            add(missingResultTableOperation.bindingPath);
        }
        actionableIssues = actionableIssues.filter(issue => !(
            issue?.code === 'reader_result_table_missing'
            || /^读者文章主结果表覆盖不足/.test(String(issue?.message || ''))
        ));
    }
    const globalWideTableIssue = blockingIssues.find(issue => !classifyTableBindingOrderIssue(issue).ignoreMessageForRepair
        && /宽表/.test(String(issue?.message || '')));
    if (globalWideTableIssue) {
        // 过去根据全局的「宽表数量下限」检查，一次允许修改所有表正文和绑定，
        // 结果五个节点的大补丁反复在 JSON 后缀之前就断掉。现在一次只修一对表，
        // 下一轮再让权威完整解析器指出下一个缺口。
        const tableSpecific = blockingIssues.filter(issue => (
            !classifyTableBindingOrderIssue(issue).ignoreMessageForRepair
            && (/^\/tableBindings\/(?:0|[1-9]\d*)$/.test(String(issue?.path || issue?.bindingPath || ''))
                || /tableBindings\[(?:0|[1-9]\d*)\]/.test(String(issue?.message || '')))
        )).sort((left, right) => {
            const index = issue => Number(/^\/tableBindings\/(\d+)$/.exec(
                String(issue?.path || issue?.bindingPath || '')
            )?.[1] ?? /tableBindings\[(\d+)\]/.exec(String(issue?.message || ''))?.[1] ?? Number.MAX_SAFE_INTEGER);
            return index(left) - index(right);
        });
        const locatedTables = locateReaderDraftTables(draft);
        const sectionTableCounts = locatedTables.reduce((counts, table) => {
            counts.set(table.sectionIndex, (counts.get(table.sectionIndex) || 0) + 1);
            return counts;
        }, new Map());
        const repairableTables = locatedTables.filter(table => (
            Number.isInteger(table.bindingIndex) && draft.tableBindings?.[table.bindingIndex]
        ));
        const narrowTables = repairableTables.filter(table => {
            const binding = draft.tableBindings[table.bindingIndex];
            const columnCount = Array.isArray(table.table?.header)
                ? table.table.header.length
                : Array.isArray(binding?.selection?.sourceColumns)
                    ? binding.selection.sourceColumns.length : 0;
            return columnCount < READER_LIMITS.minimumWideColumns;
        });
        const firstTable = (narrowTables.length ? narrowTables : repairableTables).sort((left, right) => (
            (sectionTableCounts.get(left.sectionIndex) || 0) - (sectionTableCounts.get(right.sectionIndex) || 0)
            || String(draft.sections?.[left.sectionIndex]?.body || '').length
                - String(draft.sections?.[right.sectionIndex]?.body || '').length
            || left.bindingIndex - right.bindingIndex
        ))[0];
        const firstBindingIndex = Number.isInteger(firstTable?.bindingIndex)
            ? firstTable.bindingIndex
            : Number.isInteger(firstTable?.tableIndex) ? firstTable.tableIndex - 1 : null;
        actionableIssues = tableSpecific.length ? [tableSpecific[0]]
            : Number.isInteger(firstBindingIndex) && firstBindingIndex >= 0
                ? [{ ...globalWideTableIssue, path: `/tableBindings/${firstBindingIndex}` }]
                : [globalWideTableIssue];
    }
    for (const issue of actionableIssues) {
        if (classifyTableBindingOrderIssue(issue).ignoreMessageForRepair) continue;
        if (issue.path) add(issue.path);
        if (issue.bindingPath) add(issue.bindingPath);
        const message = issue.message || '';
        const workflowLeak = /读者文章泄漏了流程或证据元话语：([^\n]+)/.exec(message)?.[1];
        if (workflowLeak) {
            draft.sections.forEach((section, index) => {
                if (String(section?.body || '').includes(workflowLeak)) add(`/sections/${index}/body`);
            });
            draft.conceptBridges.forEach((bridge, index) => {
                if (JSON.stringify(bridge).includes(workflowLeak)) add(`/conceptBridges/${index}`);
            });
        }
        let localizedComparisonUnit = false;
        for (const match of message.matchAll(/comparison_unit_missing:([^；\n]+)/gu)) {
            const surface = match[1].trim().replace(/\s+/gu, '');
            if (!surface) continue;
            draft.sections.forEach((section, index) => {
                if (String(section?.body || '').replace(/\s+/gu, '').includes(surface)) {
                    add(`/sections/${index}/body`);
                    localizedComparisonUnit = true;
                }
            });
        }
        // 绝不放行或接受过期的补丁。早期持久化的失败记录没有带结构化路径，
        // 所以只能从它们的错误信息里取回那个确切的授权指针；add() 再把它
        // 绑到今天的节点 SHA 上。
        const stalePatchPath = /Reader patch has stale node SHA: (\/(?:sections|conceptBridges|figurePlacements|tableBindings|formulaBindings)\/(?:0|[1-9]\d*)(?:\/body)?)/.exec(message)?.[1];
        if (stalePatchPath) add(stalePatchPath);
        if (/selection[\s\S]*(?:第一行必须是原表头，其余行必须是数据行|行列重复、越界或数量不足)/.test(message)) {
            const index = Number(/tableBindings\[(\d+)\]/.exec(message)?.[1]);
            if (Number.isInteger(index)) add(`/tableBindings/${index}`);
            // marker 和它所在的整节，结构上本来就有效。这里再要一整节正文，会让
            // 本来只改一个对象的修复变得臃肿，也是修复 JSON 被截断的主要来源。
            continue;
        }
        if (/主结果表覆盖不足/.test(message)) {
            draft.sections.forEach((section, index) => {
                if (['result', 'ablation'].includes(section?.kind)) add(`/sections/${index}/body`);
            });
        }
        for (const match of message.matchAll(/quantitative_chinese_numeral:([^；\n]+)/gu)) {
            const surface = match[1].trim();
            if (!surface) continue;
            const normalizedSurface = surface.normalize('NFKC');
            const escaped = normalizedSurface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const attachedNumeral = new RegExp(`${escaped}(?=[零〇一二两三四五六七八九十百千万亿])`, 'u');
            let indexes = draft.sections.flatMap((section, index) => (
                attachedNumeral.test(String(section?.body || '').normalize('NFKC')) ? [index] : []
            ));
            if (!indexes.length) {
                indexes = draft.sections.flatMap((section, index) => (
                    String(section?.body || '').normalize('NFKC').includes(normalizedSurface) ? [index] : []
                ));
            }
            indexes.forEach(index => add(`/sections/${index}/body`));
        }
        for (const match of message.matchAll(/broken_prose:([^；\n]+)/gu)) {
            const surface = match[1].trim();
            if (!surface) continue;
            draft.sections.forEach((section, index) => {
                if (String(section?.body || '').includes(surface)) add(`/sections/${index}/body`);
            });
        }
        for (const match of message.matchAll(/(sections|conceptBridges|figurePlacements|tableBindings|formulaBindings)\[(\d+)\](?:\.(body|heading|kind))?/g)) {
            add(`/${match[1]}/${match[2]}${match[1] === 'sections' && match[3] === 'body' ? '/body' : ''}`);
            sectionForBinding(match[1], Number(match[2]));
        }
        const direct = /^\/(conceptBridges|figurePlacements|formulaBindings)\/(\d+)$/.exec(issue.path || '');
        if (direct) sectionForBinding(direct[1], Number(direct[2]));
        if (/读者标题|readerTitle/.test(message)) add('/readerTitle');
        if (/oneSentenceThesis/.test(message)) add('/oneSentenceThesis');
        if (issue.code === 'reader_length_preflight' || /中文字数|篇幅预估/.test(message)) {
            draft.sections.forEach((_section, index) => add(`/sections/${index}/body`));
        }
        if (!localizedComparisonUnit && /表|tableBindings|cell|quote/i.test(message)) {
            const boundIndex = /^\/tableBindings\/(\d+)$/.exec(issue.bindingPath || issue.path || '');
            const wanted = Number(boundIndex ? Number(boundIndex[1]) + 1 : message.match(/第\s*(\d+)\s*张/)?.[1]
                || (message.match(/tableBindings\[(\d+)\]/) ? Number(message.match(/tableBindings\[(\d+)\]/)[1]) + 1 : 0));
            for (const table of locateReaderDraftTables(draft)) {
                if (!wanted || wanted === table.tableIndex) add(table.path);
            }
            draft.tableBindings.forEach((_binding, index) => {
                if (!wanted || wanted === index + 1) add(`/tableBindings/${index}`);
            });
            if (![...paths].some(pointer => pointer.startsWith('/sections/'))) {
                draft.sections.forEach((section, index) => {
                    if (['training', 'experiment_setup', 'result', 'ablation'].includes(section?.kind)) add(`/sections/${index}/body`);
                });
            }
        }
    }
    // 全局的可读性和篇幅类错误，没法靠正则消息安全地定位到某处。保留所有
    // 正文目标供审查，但每个补丁最多八个节点。
    if (!paths.size && (actionableIssues.some(issue => !classifyTableBindingOrderIssue(issue).ignoreMessageForRepair)
        || !issues.length)) {
        draft.sections.forEach((_section, index) => add(`/sections/${index}/body`));
    }
    return [...paths].slice(0, 8).map(pointer => ({ path: pointer,
        oldSha256: hashDraft(nodeAt(draft, pointer)), value: nodeAt(draft, pointer) }));
}

function normalizeUnavailableReaderFigures(draft, availableFigureOrdinals) {
    if (!Array.isArray(availableFigureOrdinals) || availableFigureOrdinals.length !== 0
        || !Array.isArray(draft?.figurePlacements) || !draft.figurePlacements.length
        || !Array.isArray(draft?.sections)) return null;
    for (const section of draft.sections) {
        const body = String(section?.body || '');
        if (Object.keys(section).some(key => !['kind', 'heading', 'body'].includes(key))
            || /看图|读图|图中|横轴|纵轴|坐标轴|颜色|热图|曲线|图注|图解|误差棒|红色|蓝色|绿色/.test(
                `${section.heading || ''} ${body}`)) return null;
        let fence = null;
        for (const line of body.split(/\r?\n/)) {
            const boundary = line.match(/^ {0,3}(`{3,}|~{3,})/);
            if (boundary) {
                if (!fence) fence = boundary[1];
                else if (boundary[1][0] === fence[0] && boundary[1].length >= fence.length
                    && line.slice(boundary[0].length).trim() === '') fence = null;
            }
            if (/\[\[FIGURE_\d+\]\]/.test(line)
                && (fence || !/^[ \t]*\[\[FIGURE_\d+\]\][ \t]*$/.test(line))) return null;
        }
    }
    const targets = buildRepairTargets(draft, [{ message: '论文没有可用 Figure，figurePlacements 必须为空' }]);
    if (!targets.length || targets.some(target => target.expectedCleanupValue === undefined)) return null;
    const patch = { version: 1, draftSha256: hashDraft(draft), replacements: targets.map(target => ({
        path: target.path, oldSha256: target.oldSha256, value: target.expectedCleanupValue })) };
    const cleaned = applyReaderPatch(draft, patch, targets.map(target => target.path), { availableFigureOrdinals });
    return { draft: cleaned, mapping: { contract: 'reader-no-figure-marker-cleanup-v1',
        changed: true, inputSha256: hashDraft(draft), outputSha256: hashDraft(cleaned),
        paths: targets.map(target => target.path), contentValidated: false } };
}

function buildRepairContext(draft, issues, sourceEvidence, sourceText = '', options = {}) {
    const targets = buildRepairTargets(draft, issues, options);
    const requestedOperation = observedFigureSelectionOperation(draft, options)
        || unavailableFigureCleanupOperation(draft, options)
        || sectionReorganizationOperation(draft)
        || buildReindexedTableBindingsOperation(draft, issues)
        || buildMissingFormulaBindingsOperation(draft, issues)
        || buildMissingTableBindingsOperation(draft, issues)
        || buildUniqueMissingQuoteTableOperation(draft, issues)
        || buildMissingResultTableOperation(draft, issues)
        || buildMissingNarrativeTableOperation(draft, issues);
    // 当前先修术语解释等其他问题时，不夹带一条没有授权修改范围的表格指令。
    const atomicOperation = requestedOperation
        && requestedOperation.requiredReplacementPaths.every(pointer => (
            targets.some(target => target.path === pointer)
        )) ? requestedOperation : null;
    const targetText = JSON.stringify(targets);
    const figureOrdinals = new Set();
    for (const match of targetText.matchAll(/\[\[FIGURE_(\d+)\]\]/g)) figureOrdinals.add(Number(match[1]));
    for (const target of targets) {
        if (target.path.startsWith('/figurePlacements/') && Number.isInteger(target.value?.figureOrdinal)) {
            figureOrdinals.add(target.value.figureOrdinal);
        }
    }
    // 安全的收窄办法证明不了语义覆盖时，就保留完整证据。无论哪种情况，
    // 输出和允许的改动都严格限制在局部。
    const evidence = String(sourceEvidence || '');
    const exactQuotes = [...new Set(targets.flatMap(target => target.value?.sourceQuotes || []))]
        .filter(quote => typeof quote === 'string' && String(sourceText).includes(quote));
    const formulaAppendGuidance = atomicOperation?.kind === 'complete_existing_formula_bindings_v1'
        ? `公式来源数组前 ${draft.formulaBindings.length} 条是不可改动的原记录，内容和顺序必须逐字保持。不要按公式编号排序；正文标记的排列顺序不决定数组顺序。只在数组末尾追加本轮明确列出的缺失记录。原记录前缀：${JSON.stringify(draft.formulaBindings)}。本轮允许提交的完整数组：${JSON.stringify([...draft.formulaBindings, ...atomicOperation.missingBindings])}。`
        : '';
    const protectedTableMarkers = [];
    if (!targets.some(target => target.path === '/tableBindings')) {
        for (const [index, binding] of (draft.tableBindings || []).entries()) {
            if (!(binding?.selection || binding?.completeTable)
                || !Number.isInteger(binding.tableIndex) || binding.tableIndex < 1
                || targets.some(target => target.path === `/tableBindings/${index}`
                    || target.path.startsWith(`/tableBindings/${index}/`))) continue;
            const marker = `[[TABLE_${binding.tableIndex}]]`;
            const count = draft.sections.reduce((total, section) => total
                + (String(section.body || '').split(marker).length - 1), 0);
            // 缺失或重复的标记仍交给原有修复处理，不把坏稿现状固定为要求。
            if (count !== 1) continue;
            const target = targets.find(item => /^\/sections\/\d+\/body$/.test(item.path)
                && typeof item.value === 'string' && item.value.includes(marker));
            if (target) protectedTableMarkers.push({ marker, sectionPath: target.path,
                bindingPath: `/tableBindings/${index}` });
        }
    }
    const markerGuidance = protectedTableMarkers.length
        ? `以下是允许修改的小节里已有的其他表格标记，其来源记录本轮不可修改：${JSON.stringify(protectedTableMarkers)}。`
            + '这些标记须原样保留且仍各出现一次，不能改成手写 Markdown 表，也不能因本次修复其他表而删除。这个只读说明不增加允许修改的路径。'
        : '';
    const targetGuidance = (atomicOperation?.kind === 'select_observed_figures_v1'
        ? '本轮特别允许figurePlacements缩为1–4条本次已见像素的原声明，其余数组数量不变。必须同步按来源改写全部授权小节，保留必要事实及表格公式术语标记；不得机械删图丢弃解释。' : '')
        + (atomicOperation?.kind === 'cleanup_unavailable_figures_v1'
        ? '本轮明确允许清空整组figurePlacements，这是普通数组项数量不变规则的唯一图片例外；同时按来源重写全部指定图片相关小节，删除无证据图解与非法图片元数据，不留图标记。仅有文字依据的事实可以明确按作者文字报告保留，不假装看过图。其他节点逐字保留。' : '')
        + (atomicOperation?.kind === 'reorganize_existing_sections_v1'
        ? '本轮明确授权整组小节重排，只提交/sections完整数组；其他顶层信息与全部来源记录逐字保留。不能据此删除图表、公式或正确事实；重排后仍须通过完整解析与来源检查。' : '')
        + `本轮只允许修改这些目标：${JSON.stringify(targets.map(target => target.path))}。`
        + '下面的诊断可能列出其他已发现问题，列出问题不代表授权修改。只提交本轮允许目标，逐项使用请求给出的真实 oldSha256；其余问题留待下一轮重新核验并授权，不要为未授权目标编造 SHA。' + formulaAppendGuidance + markerGuidance;
    return { draftSha256: hashDraft(draft), targets, issues, evidence, atomicOperation, targetGuidance,
        exactQuotes, figureOrdinals: [...figureOrdinals], evidenceMode: 'full-evidence-local-output' };
}

function assertSafeDirectory(directory, create = false) {
    const absolute = path.resolve(directory);
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        let stat;
        try { stat = fs.lstatSync(cursor); } catch (error) {
            if (error.code !== 'ENOENT' || !create) throw error;
            fs.mkdirSync(cursor, { mode: 0o700 });
            stat = fs.lstatSync(cursor);
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe Reader candidate directory: ${cursor}`);
    }
    return absolute;
}

function candidatePath(directory, identity) {
    return path.join(directory, `${hashDraft(identity)}.json`);
}

function loadFailedCandidate(directory, identity) {
    try { assertSafeDirectory(directory); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const filename = candidatePath(directory, identity);
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES || (stat.mode & 0o777) !== 0o600) {
            throw new Error('Unsafe Reader candidate file or permissions');
        }
        const envelope = JSON.parse(fs.readFileSync(fd, 'utf8'));
        assertSafeJson(envelope);
        if (envelope.version !== REPAIR_VERSION || hashDraft(envelope.identity) !== hashDraft(identity)
            || envelope.payloadSha256 !== hashDraft(envelope.payload)
            || envelope.payload?.status !== 'failed'
            || !Number.isInteger(envelope.payload.attempts) || envelope.payload.attempts < 0
            || !Number.isInteger(envelope.payload.fullAttempts) || envelope.payload.fullAttempts < 0
            || (envelope.payload.transportFailures !== undefined
                && (!Number.isInteger(envelope.payload.transportFailures) || envelope.payload.transportFailures < 0))
            || !Number.isInteger(envelope.payload.noProgress) || envelope.payload.noProgress < 0
            || typeof envelope.payload.failureSignature !== 'string'
            || (envelope.payload.validationFailureSignature !== undefined
                && typeof envelope.payload.validationFailureSignature !== 'string')
            || (envelope.payload.validationFailureStreak !== undefined
                && (!Number.isInteger(envelope.payload.validationFailureStreak)
                    || envelope.payload.validationFailureStreak < 0))
            || Object.prototype.hasOwnProperty.call(envelope.payload, 'implementationRepairAllowance')
            || (envelope.payload.implementationRepairAllowanceLineage !== undefined
                && envelope.payload.implementationRepairAllowanceLineage
                    !== IMPLEMENTATION_ALLOWANCE_LINEAGE_CONTRACT)
            || (envelope.payload.consumedImplementationAllowanceSha256 !== undefined
                && (!Array.isArray(envelope.payload.consumedImplementationAllowanceSha256)
                    || envelope.payload.consumedImplementationAllowanceSha256.some(value => !/^[a-f0-9]{64}$/.test(value))
                    || new Set(envelope.payload.consumedImplementationAllowanceSha256).size !== envelope.payload.consumedImplementationAllowanceSha256.length))
            || !Array.isArray(envelope.payload.issues)
            || envelope.payload.issues.some(issue => !issue || typeof issue.message !== 'string'
                || (issue.path !== null && typeof issue.path !== 'string')
                || (issue.code === TABLE_BINDING_ORDER_ISSUE_CODE && !readTableBindingOrderIssue(issue))
                || (issue.code === TABLE_COUNT_ISSUE_CODE && !readTableCountIssue(issue)))
            || (envelope.payload.draft && !parseRecoveryDraft(envelope.payload.draft))) {
            throw new Error('Corrupt or drifted Reader candidate');
        }
        validateImplementationAllowance(envelope.payload, envelope.identity, directory);
        require('./explicit-reader-retry-round').validatePersistedRound(directory, envelope.identity, envelope.payload);
        return envelope.payload;
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error(`Reader candidate refused: ${error.message}`, { cause: error });
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function saveFailedCandidate(directory, identity, payload) {
    assertSafeJson(identity);
    assertSafeJson(payload);
    if (payload.status !== 'failed') throw new Error('Reader candidate cannot certify success');
    if (Object.prototype.hasOwnProperty.call(payload, 'implementationRepairAllowance')) {
        throw new Error('Reader implementation repair allowance requires a recovery-revision proof');
    }
    for (const issue of payload.issues || []) {
        const original = classifyTableBindingOrderIssue(issue);
        if (!original.ignoreMessageForRepair) continue;
        const persisted = classifyTableBindingOrderIssue(JSON.parse(JSON.stringify(issue)));
        if ((!original.actionable && persisted.actionable) || !persisted.ignoreMessageForRepair) {
            throw new Error('保存后诊断字段会变化，可能扩大修复范围；请保留有效字段后重试。');
        }
    }
    const absolute = assertSafeDirectory(directory, true);
    const filename = candidatePath(absolute, identity);
    const previous = loadFailedCandidate(absolute, identity);
    const storedPayload = structuredClone(payload);
    if (previous?.explicitReaderRetryRound) {
        if (storedPayload.explicitReaderRetryRound
            && hashDraft(storedPayload.explicitReaderRetryRound) !== hashDraft(previous.explicitReaderRetryRound)) {
            throw new Error('明确 Reader 新轮凭证不能变化');
        }
        if (storedPayload.attempts < previous.attempts || storedPayload.fullAttempts < previous.fullAttempts) {
            throw new Error('同一明确 Reader 新轮调用次数不能减少');
        }
        storedPayload.explicitReaderRetryRound = previous.explicitReaderRetryRound;
    }
    if (previous?.implementationRepairAllowanceLineage) {
        if (storedPayload.implementationRepairAllowanceLineage !== undefined
            && storedPayload.implementationRepairAllowanceLineage
                !== previous.implementationRepairAllowanceLineage) {
            throw new Error('Reader implementation repair allowance lineage cannot change');
        }
        storedPayload.implementationRepairAllowanceLineage
            = previous.implementationRepairAllowanceLineage;
    }
    const consumed = new Set(storedPayload.consumedImplementationAllowanceSha256 || []);
    for (const value of previous?.consumedImplementationAllowanceSha256 || []) consumed.add(value);
    const previousProof = previous?.implementationRepairAllowanceProof;
    const nextProof = storedPayload.implementationRepairAllowanceProof;
    if (previousProof && !nextProof) consumed.add(previousProof.allowanceSha256);
    if (previousProof && nextProof && previousProof.allowanceSha256 !== nextProof.allowanceSha256) {
        throw new Error('Reader implementation repair allowance cannot be replaced before consumption');
    }
    if (nextProof && consumed.has(nextProof.allowanceSha256)) {
        throw new Error('Reader implementation repair allowance was already consumed');
    }
    if (consumed.size) storedPayload.consumedImplementationAllowanceSha256 = [...consumed].sort();
    else delete storedPayload.consumedImplementationAllowanceSha256;
    validateImplementationAllowance(storedPayload, identity, absolute);
    require('./explicit-reader-retry-round').validatePersistedRound(absolute, identity, storedPayload);
    try {
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe Reader candidate destination');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const serialized = JSON.stringify({ version: REPAIR_VERSION, identity, payload: storedPayload, payloadSha256: hashDraft(storedPayload) });
    if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw new Error('Reader candidate exceeds recovery size budget');
    const temporary = path.join(absolute, `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
    let fd;
    try {
        fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, serialized);
        fs.fsyncSync(fd);
        fs.closeSync(fd); fd = undefined;
        assertSafeDirectory(directory);
        fs.renameSync(temporary, filename);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return filename;
}

function retireFailedCandidate(directory, identity) {
    // 只有在这个确切身份上被独立重放过的失败才会清退。这里有意不做成功
    // 候选缓存，下一次不加载任何成功结果。
    if (!loadFailedCandidate(directory, identity)) return null;
    const absolute = assertSafeDirectory(directory);
    const filename = candidatePath(absolute, identity);
    const retired = path.join(absolute, `${hashDraft(identity)}.${crypto.randomUUID()}.resolved.json`);
    fs.renameSync(filename, retired);
    return retired;
}

const METADATA_REPAIR_REQUIRED_FIELDS = ['version', 'readerTitle', 'oneSentenceThesis', 'sections',
    'conceptBridges', 'figurePlacements', 'tableBindings', 'formulaBindings'];
const METADATA_FIELDS = ['sourceBindingsContract', 'sourceBindingsSha256'];

// JSON.parse 校验整个输入；扫描器只确定顶层成员的原始字节边界，不重写正文。
function readTopLevelMembers(raw) {
    JSON.parse(raw);
    let cursor = 0;
    const skipWhitespace = () => { while (/\s/.test(raw[cursor] || '') && cursor < raw.length) cursor += 1; };
    const readString = () => {
        const start = cursor;
        cursor += 1;
        while (cursor < raw.length) {
            const character = raw[cursor++];
            if (character === '\\') cursor += 1;
            else if (character === '"') return { start, end: cursor };
        }
        throw new Error('Reader 原始 JSON 字符串未闭合');
    };
    skipWhitespace();
    if (raw[cursor++] !== '{') throw new Error('Reader 原始 JSON 必须是对象');
    const members = [];
    const names = new Set();
    while (true) {
        skipWhitespace();
        if (raw[cursor] === '}') break;
        if (raw[cursor] !== '"') throw new Error('Reader 顶层字段名称无效');
        const keySpan = readString();
        const name = JSON.parse(raw.slice(keySpan.start, keySpan.end));
        if (names.has(name)) throw new Error('Reader 原始 JSON 含重复顶层字段');
        names.add(name);
        skipWhitespace();
        if (raw[cursor++] !== ':') throw new Error('Reader 顶层字段缺少冒号');
        skipWhitespace();
        const valueStart = cursor;
        let nesting = 0;
        while (cursor < raw.length) {
            const character = raw[cursor];
            if (character === '"') { readString(); continue; }
            if (character === '{' || character === '[') nesting += 1;
            if (character === '}' || character === ']') {
                if (nesting === 0) break;
                nesting -= 1;
            }
            if (character === ',' && nesting === 0) break;
            cursor += 1;
        }
        let valueEnd = cursor;
        while (/\s/.test(raw[valueEnd - 1] || '')) valueEnd -= 1;
        const comma = raw[cursor] === ',' ? cursor : null;
        members.push({ name, start: keySpan.start, valueStart, valueEnd, comma });
        if (comma === null) break;
        cursor += 1;
    }
    return members;
}

function buildTopLevelMetadataRepairContext(raw) {
    if (typeof raw !== 'string') return null;
    try {
        const members = readTopLevelMembers(raw);
        const value = JSON.parse(raw);
        const names = members.map(member => member.name);
        if (names.length !== METADATA_REPAIR_REQUIRED_FIELDS.length + METADATA_FIELDS.length
            || !METADATA_REPAIR_REQUIRED_FIELDS.every(name => names.includes(name))
            || !METADATA_FIELDS.every(name => names.includes(name))
            || names.some(name => !METADATA_REPAIR_REQUIRED_FIELDS.includes(name) && !METADATA_FIELDS.includes(name))
            || value.sourceBindingsContract !== 'api-reader-source-bindings-v4'
            || !/^[a-f0-9]{64}$/.test(value.sourceBindingsSha256)
            || value.version !== 3 || typeof value.readerTitle !== 'string'
            || typeof value.oneSentenceThesis !== 'string'
            || !METADATA_REPAIR_REQUIRED_FIELDS.slice(3).every(name => Array.isArray(value[name]))) return null;
        return { kind: 'delete_top_level_program_metadata_v1', rawSha256: shaText(raw),
            deleteFields: [...METADATA_FIELDS] };
    } catch { return null; }
}

function applyTopLevelMetadataRepair(raw, patch, context) {
    const current = buildTopLevelMetadataRepairContext(raw);
    if (!current || JSON.stringify(context) !== JSON.stringify(current)
        || !patch || Object.keys(patch).sort().join(',') !== 'deleteFields,rawSha256,version'
        || patch.version !== 1 || patch.rawSha256 !== current.rawSha256
        || JSON.stringify(patch.deleteFields) !== JSON.stringify(current.deleteFields)) {
        throw new Error('Reader 顶层元数据删除必须明确授权两个字段，并绑定当前原始草稿 SHA');
    }
    const members = readTopLevelMembers(raw);
    const spans = [];
    for (let index = 0; index < members.length; index += 1) {
        if (!METADATA_FIELDS.includes(members[index].name)) continue;
        const firstIndex = index;
        while (index + 1 < members.length && METADATA_FIELDS.includes(members[index + 1].name)) index += 1;
        const first = members[firstIndex];
        const last = members[index];
        spans.push({ start: last.comma === null ? members[firstIndex - 1].comma : first.start,
            end: last.comma === null ? last.valueEnd : last.comma + 1 });
    }
    let result = raw;
    for (const span of spans.reverse()) result = result.slice(0, span.start) + result.slice(span.end);
    const expected = JSON.parse(raw);
    for (const name of METADATA_FIELDS) delete expected[name];
    if (JSON.stringify(JSON.parse(result)) !== JSON.stringify(expected)) {
        throw new Error('Reader 顶层元数据删除改变了其他内容');
    }
    return result;
}


module.exports = { REPAIR_VERSION, IMPLEMENTATION_ALLOWANCE_CONTRACT,
    IMPLEMENTATION_ALLOWANCE_LINEAGE_CONTRACT, TABLE_COUNT_ISSUE_CODE, TABLE_BINDING_ORDER_ISSUE_CODE,
    classifyTableBindingOrderIssue, readTableBindingOrderIssue,
    classifyTableBindingOrderError, readTableBindingOrderError,
    readTableCountIssue, hashRecoveryIssues, hashDraft, shaText, normalizeValidationMessage, validationFailureSignature,
    validationFailureHasNoProgress, readerAttemptLimit,
    validateImplementationAllowance,
    buildTopLevelMetadataRepairContext, applyTopLevelMetadataRepair,
    parseRepairableDraft, parseRecoveryDraft, parseReaderPatchJson, collectDraftIssues,
    buildSectionReorganizationPrompt, buildRepairTargets, applyReaderPatch, normalizeUnavailableReaderFigures, buildRepairContext, loadFailedCandidate, saveFailedCandidate,
    retireFailedCandidate, hasUnusedImplementationAllowance };
