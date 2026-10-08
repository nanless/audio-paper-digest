'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { getFreshAnalysisContext } = require('./fresh-analysis-context.js');
const { loadFailedCandidate, saveFailedCandidate, hashDraft, shaText, parseRecoveryDraft,
    IMPLEMENTATION_ALLOWANCE_CONTRACT, IMPLEMENTATION_ALLOWANCE_LINEAGE_CONTRACT,
    TABLE_COUNT_ISSUE_CODE, classifyTableBindingOrderIssue, readTableBindingOrderError } = require('./reader-repair.js');
const { normalizeReaderDraftOrder, pruneUniquelyUnboundReaderMarkdownTables } = require('./reader-draft-order.js');
const { normalizeDanglingReaderConnectors,
    normalizeIssueBoundReaderQuantitativeNumerals } = require('../editorial-quality.js');
const CONTRACT = 'reader-recovery-diagnostics-revision-v1';
const ALLOWED_FIELDS = Object.freeze(['repairImplementationSha256', 'tableCompilerSha256', 'draftOrderContract',
    'draftOrderImplementationSha256', 'sourceDiagnosticsImplementationSha256',
    'parserImplementationSha256', 'editorialImplementationSha256', 'mechanicalContractSha256',
    'readerRecoveryEpochSha256']);
const implementationFields = ALLOWED_FIELDS.filter(field => field.endsWith('Sha256'));
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const withoutRevisionFields = identity => Object.fromEntries(Object.entries(identity)
    .filter(([key]) => !ALLOWED_FIELDS.includes(key)));
const getConferenceAnalysisContext = () => require('./conference-analysis-context.js').getConferenceAnalysisContext();

function readEnvelope(filename) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 20 * 1024 * 1024 || (stat.mode & 0o777) !== 0o600) {
            throw new Error('Unsafe Reader recovery revision candidate');
        }
        const bytes = fs.readFileSync(fd);
        return { envelope: JSON.parse(bytes.toString('utf8')),
            envelopeSha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function finishRevisionArchives(directory, identity, payload) {
    for (const audit of payload.readerRecoveryRevisions || []) {
        const conference = getConferenceAnalysisContext();
        const expectedRunId = identity.freshAnalysis?.runId || conference?.executionId || null;
        const direct = expectedRunId ? null
            : require('./direct-rewrite-analysis-context.js').getDirectRewriteAnalysisContext();
        const directPaperId = String(direct?.paperId || '').replace(/^arxiv:/, '');
        const directScopeValid = Boolean(direct?.runId)
            && audit.scope === 'historical-direct'
            && audit.runId === direct.runId
            && audit.paperId === directPaperId
            && identity.paperId === directPaperId
            && identity.sourceSha256 === direct.sourceSha256
            && path.resolve(directory) === path.resolve(direct.readerAttemptsDir);
        const conferenceScopeValid = Boolean(conference?.executionId)
            && audit.scope === 'conference-process'
            && audit.runId === conference.executionId
            && audit.paperId === conference.paperId
            && identity.paperId === conference.paperId
            && identity.sourceSha256 === shaText(conference.sourceDetails?.text || '')
            && path.resolve(directory) === path.join(path.resolve(conference.executionDir), 'reader-attempts');
        const auditScopeValid = identity.freshAnalysis?.runId
            ? audit.runId === identity.freshAnalysis.runId
            : conference?.executionId ? conferenceScopeValid : directScopeValid;
        if (audit.contract !== CONTRACT || expectedRunId && audit.runId !== expectedRunId
            || !auditScopeValid
            || audit.fromIdentitySha256 === hashDraft(identity)
            || !/^[a-f0-9]{64}$/.test(audit.fromIdentitySha256 || '')
            || !/^[a-f0-9]{64}$/.test(audit.oldPayloadSha256 || '')
            || !/^[a-f0-9]{64}$/.test(audit.oldEnvelopeSha256 || '')
            || !new RegExp(`^${audit.fromIdentitySha256}\\.migrated-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.json$`).test(audit.archivedName || '')) {
            throw new Error('Invalid Reader diagnostic revision archive audit');
        }
        const original = path.join(directory, `${audit.fromIdentitySha256}.json`);
        const archived = path.join(directory, audit.archivedName);
        const verify = filename => {
            const checked = readEnvelope(filename);
            if (checked.envelopeSha256 !== audit.oldEnvelopeSha256
                || hashDraft(checked.envelope.identity) !== audit.fromIdentitySha256
                || checked.envelope.payloadSha256 !== audit.oldPayloadSha256
                || hashDraft(checked.envelope.payload) !== audit.oldPayloadSha256) {
                throw new Error('Reader diagnostic revision archive/source bytes drifted');
            }
            return checked;
        };
        let archiveExists = false;
        try { fs.lstatSync(archived); archiveExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (archiveExists) {
            verify(archived);
            try { fs.lstatSync(original); throw new Error('Reader diagnostic revision has duplicate unarchived evidence'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        } else {
            // 先装新文件再改名旧文件，有意做成可恢复的。只有旧文件的完整字节通过 CAS
            // 校验，并且补上缺失的归档步骤之后，新的候选才算就绪。
            const checked = verify(original);
            if (hashDraft(loadFailedCandidate(directory, checked.envelope.identity)) !== audit.oldPayloadSha256) {
                throw new Error('Reader diagnostic revision old payload drifted before archive');
            }
            fs.renameSync(original, archived);
            verify(archived);
        }
    }
    return payload;
}

function loadReaderRecoveryRevision(directory, identity, options = {}) {
    const expectedPixels = options.pixelEvidenceSha256;
    if (expectedPixels !== undefined && !/^[a-f0-9]{64}$/.test(expectedPixels)) {
        throw new Error('Reader recovery pixel evidence identity is invalid');
    }
    const expectedEphemeralPixels = options.ephemeralImageEvidenceSha256;
    if (expectedEphemeralPixels !== undefined && !/^[a-f0-9]{64}$/.test(expectedEphemeralPixels)) {
        throw new Error('Reader recovery ephemeral pixel evidence identity is invalid');
    }
    const verifyPixels = payload => {
        if (expectedPixels !== undefined && hashDraft(payload?.imageEvidence || []) !== expectedPixels) {
            throw new Error('Reader failed candidate image evidence drifted; refusing to migrate pixel-dependent narration');
        }
        if (expectedEphemeralPixels !== undefined
            && hashDraft(payload?.ephemeralImageEvidence) !== expectedEphemeralPixels) {
            throw new Error('Reader failed candidate ephemeral image evidence drifted; refusing to migrate pixel-dependent narration');
        }
    };
    const exact = loadFailedCandidate(directory, identity);
    if (exact) { verifyPixels(exact); return finishRevisionArchives(directory, identity, exact); }
    const context = getFreshAnalysisContext();
    const direct = require('./direct-rewrite-analysis-context.js').getDirectRewriteAnalysisContext();
    const conference = getConferenceAnalysisContext();
    let revisionRunId; let revisionScope;
    if (context) {
        if (context.refreshReaderDiagnostics !== true) return null;
        if (path.resolve(directory) !== path.join(context.runDir, 'reader-attempts')
            || identity?.freshAnalysis?.runId !== context.runId
            || identity.freshAnalysis.paperId !== identity.paperId
            || identity.sourceSha256 !== context.sourceExpectations[identity.paperId]?.sourceSha256
            || identity.freshAnalysis.sourceSha256 !== identity.sourceSha256
            || identity.freshAnalysis.structuredArtifactsSha256 !== context.sourceExpectations[identity.paperId]?.structuredArtifactsSha256) {
            throw new Error('Reader diagnostic revision must remain in the exact fresh run/source scope');
        }
        revisionRunId = context.runId; revisionScope = 'fresh-run';
    } else if (direct?.runId) {
        const directPaperId = String(direct.paperId || '').replace(/^arxiv:/, '');
        if (path.resolve(directory) !== path.resolve(direct.readerAttemptsDir)
            || identity?.freshAnalysis !== undefined || identity?.paperId !== directPaperId
            || identity.sourceSha256 !== direct.sourceSha256) {
            throw new Error('Reader diagnostic revision must remain in the exact historical direct run/source scope');
        }
        revisionRunId = direct.runId; revisionScope = 'historical-direct';
    } else if (conference?.executionId) {
        if (path.resolve(directory) !== path.join(path.resolve(conference.executionDir), 'reader-attempts')
            || identity?.freshAnalysis !== undefined || identity?.paperId !== conference.paperId
            || identity.sourceSha256 !== shaText(conference.sourceDetails?.text || '')) {
            throw new Error('Reader diagnostic revision must remain in the exact conference execution/source scope');
        }
        revisionRunId = conference.executionId; revisionScope = 'conference-process';
    } else return null;
    let names;
    try { names = fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort(); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const compatible = [];
    for (const name of names) {
        const { envelope, envelopeSha256 } = readEnvelope(path.join(directory, name));
        if (!envelope?.identity || name !== `${hashDraft(envelope.identity)}.json`) {
            throw new Error('Corrupt Reader diagnostic revision identity/filename');
        }
        // 常规加载器仍然是权威：外层对象、私有文件、JSON 安全性、载荷哈希、
        // 根结构以及持久化计数器的校验都由它负责。
        const payload = loadFailedCandidate(directory, envelope.identity);
        if (!payload || hashDraft(payload) !== envelope.payloadSha256) {
            throw new Error('Reader diagnostic revision candidate changed during audit');
        }
        if (!isDeepStrictEqual(withoutRevisionFields(envelope.identity), withoutRevisionFields(identity))) continue;
        verifyPixels(payload);
        const changedFields = ALLOWED_FIELDS.filter(field => !isDeepStrictEqual(envelope.identity[field], identity[field]));
        if (changedFields.length) compatible.push({ identity: envelope.identity, payload, changedFields, name, envelopeSha256 });
    }
    if (compatible.length > 1) throw new Error('Ambiguous Reader diagnostic revision: multiple compatible candidates');
    if (!compatible.length) return null;
    const old = compatible[0];
    const updated = structuredClone(old.payload);
    // 有些旧的失败载荷保留了合法的原始 JSON 响应，却因为严格的生产形状解析器
    // 拒绝而把 draft 留成 null。这里只补全受限的恢复形状；调用方在接受之前
    // 仍要跑完整的 Reader 解析器和来源绑定闸门。
    if (!updated.draft && updated.rawDraft) {
        updated.draft = parseRecoveryDraft(updated.rawDraft);
    }
    if (updated.draft) {
        const normalizationIssues = updated.issues.filter(issue => issue?.code !== TABLE_COUNT_ISSUE_CODE
            && !classifyTableBindingOrderIssue(issue).ignoreMessageForRepair);
        updated.draft.sections = updated.draft.sections.map(section => ({
            ...section,
            body: typeof section?.body === 'string'
                ? normalizeIssueBoundReaderQuantitativeNumerals(
                    normalizeDanglingReaderConnectors(section.body), normalizationIssues
                ) : section?.body
        }));
        if (Array.isArray(updated.draft.conceptBridges)) {
            updated.draft.conceptBridges = updated.draft.conceptBridges.map(bridge => ({
                ...bridge,
                explanation: typeof bridge?.explanation === 'string'
                    ? normalizeIssueBoundReaderQuantitativeNumerals(
                        bridge.explanation, normalizationIssues
                    ) : bridge?.explanation
            }));
        }
        // 会议 PDF 候选里可能确定性地混有真实 Markdown 表格和选择标记。先修复这个
        // 受限的来源绑定形状，再交给通用的分节顺序闸门；否则闸门会在
        // deep-analyzer 的会议归一化器有机会证明顺序之前就拒绝候选。
        // 这里用惰性导入，避免恢复库在启动时依赖分析器。
        if (conference?.sourceDetails?.structuredArtifacts?.sourceKind === 'conference_pdf') {
            const deepAnalyzer = require('../deep-analyzer.js');
            deepAnalyzer.normalizeReaderConferenceNarrowComparisonTable(updated.draft);
            deepAnalyzer.normalizeDeclaredReaderMarkerParagraphs(updated.draft);
            deepAnalyzer.normalizeReaderSourceQuotes(
                updated.draft, conference.sourceDetails.text || ''
            );
            deepAnalyzer.repairConferenceReaderQuoteTables(
                updated.draft,
                conference.sourceDetails.text || '',
                conference.sourceDetails.structuredArtifacts
            );
            deepAnalyzer.normalizeReaderSourceQuoteTableMarkers(updated.draft);
            const prunedUnboundTables = pruneUniquelyUnboundReaderMarkdownTables(updated.draft);
            if (prunedUnboundTables > 0) {
                updated.draftOrderMappings = [...(updated.draftOrderMappings || []), {
                    contract: 'conference-reader-prune-unbound-tables-v1',
                    changed: true,
                    removedTables: prunedUnboundTables
                }];
            }
            const mixedTableOrder = deepAnalyzer.normalizeConferenceMixedTableBindings(updated.draft);
            if (mixedTableOrder) {
                updated.draftOrderMappings = [...(updated.draftOrderMappings || []), mixedTableOrder];
            }
        }
        let normalized;
        try {
            normalized = normalizeReaderDraftOrder(updated.draft);
        } catch (error) {
            if (!readTableBindingOrderError(error)) throw error;
        }
        if (normalized) {
            updated.draft = normalized.draft;
            updated.rawDraft = JSON.stringify(updated.draft);
            if (normalized.mapping.changed) {
                updated.draftOrderMappings = [...(updated.draftOrderMappings || []), normalized.mapping];
            }
        }
    }
    const diagnosticImplementationChanged = implementationFields.some(field => old.changedFields.includes(field));
    const lineageAlreadyIssued = updated.implementationRepairAllowanceLineage
        === IMPLEMENTATION_ALLOWANCE_LINEAGE_CONTRACT;
    const previousActiveAllowance = updated.implementationRepairAllowanceProof || null;
    // 同一条实现谱系最多只能多得到一次正文尝试。尚未使用的证明可以转到更新的
    // 实现身份上，但一旦某个模型请求用掉它，之后实现再变也不能再生出更多调用。
    const recoveryEpochChanged = old.changedFields.includes('readerRecoveryEpochSha256');
    const grantOrTransferAllowance = diagnosticImplementationChanged
        && (!lineageAlreadyIssued || Boolean(previousActiveAllowance) || recoveryEpochChanged);
    const archivedName = `${hashDraft(old.identity)}.migrated-${crypto.randomUUID()}.json`;
    const audit = { contract: CONTRACT, revisedAt: new Date().toISOString(), scope: revisionScope,
        runId: revisionRunId, paperId: identity.paperId,
        fromIdentitySha256: hashDraft(old.identity), toIdentitySha256: hashDraft(identity),
        changedFields: old.changedFields, archivedName,
        oldPayloadSha256: hashDraft(old.payload), oldEnvelopeSha256: old.envelopeSha256,
        oldNoProgress: updated.noProgress, oldFailureSignature: updated.failureSignature,
        clearedNoProgress: diagnosticImplementationChanged,
        attempts: updated.attempts, fullAttempts: updated.fullAttempts,
        transportFailures: updated.transportFailures ?? 0,
        inputDraftSha256: old.payload.draft ? hashDraft(old.payload.draft) : null,
        outputDraftSha256: updated.draft ? hashDraft(updated.draft) : null };
    if (diagnosticImplementationChanged) {
        updated.noProgress = 0; updated.failureSignature = '';
        updated.validationFailureStreak = 0; updated.validationFailureSignature = '';
        // 保留已付费的计数器，但在今天的完整解析器发现新代码引入的闸门之后，
        // 只允许新增一次本地修复。
    }
    updated.readerRecoveryRevisions = [...(updated.readerRecoveryRevisions || []), audit];
    delete updated.implementationRepairAllowance;
    if (grantOrTransferAllowance) {
        updated.implementationRepairAllowanceLineage = IMPLEMENTATION_ALLOWANCE_LINEAGE_CONTRACT;
    }
    if (previousActiveAllowance) {
        updated.consumedImplementationAllowanceSha256 = [...new Set([
            ...(updated.consumedImplementationAllowanceSha256 || []),
            previousActiveAllowance.allowanceSha256
        ])].sort();
    }
    updated.implementationRepairAllowanceProof = grantOrTransferAllowance
        ? implementationAllowanceProof(identity, audit) : null;
    // 调用方外面已经有常规的逐篇锁。安装前仍要重新检查：
    // 绝不覆盖更新的精确候选，也不覆盖过期的预算。
    const racedExact = loadFailedCandidate(directory, identity);
    if (racedExact) { verifyPixels(racedExact); return finishRevisionArchives(directory, identity, racedExact); }
    if (hashDraft(loadFailedCandidate(directory, old.identity)) !== hashDraft(old.payload)) {
        throw new Error('Reader diagnostic revision source changed before installation');
    }
    saveFailedCandidate(directory, identity, updated);
    finishRevisionArchives(directory, identity, updated);
    // 仍然是失败的恢复输入，不是已接受的正文，也不是证明。
    return loadFailedCandidate(directory, identity);
}

module.exports = { CONTRACT, ALLOWED_FIELDS, loadReaderRecoveryRevision };
function implementationAllowanceProof(identity, audit) {
    const body = { contract: IMPLEMENTATION_ALLOWANCE_CONTRACT,
        fromIdentitySha256: audit.fromIdentitySha256, toIdentitySha256: hashDraft(identity),
        oldPayloadSha256: audit.oldPayloadSha256, revisionAuditSha256: hashDraft(audit),
        changedFields: audit.changedFields.filter(field => implementationFields.includes(field)).sort() };
    return { ...body, allowanceSha256: hashDraft(body) };
}
