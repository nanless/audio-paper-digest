'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { getFreshAnalysisContext } = require('./fresh-analysis-context.js');
const { loadFailedCandidate, saveFailedCandidate, hashDraft, shaText, parseRecoveryDraft,
    IMPLEMENTATION_ALLOWANCE_CONTRACT, IMPLEMENTATION_ALLOWANCE_LINEAGE_CONTRACT,
    hasUnusedImplementationAllowance, TABLE_COUNT_ISSUE_CODE, classifyTableBindingOrderIssue, readTableBindingOrderError } = require('./reader-repair.js');
const { normalizeReaderDraftOrder, pruneUniquelyUnboundReaderMarkdownTables } = require('./reader-draft-order.js');
const { normalizeDanglingReaderConnectors,
    normalizeIssueBoundReaderQuantitativeNumerals } = require('../editorial-quality.js');
const CONTRACT = 'reader-recovery-diagnostics-revision-v1';
const ALLOWED_FIELDS = Object.freeze(['repairImplementationSha256', 'tableCompilerSha256', 'draftOrderContract',
    'draftOrderImplementationSha256', 'sourceDiagnosticsImplementationSha256',
    'parserImplementationSha256', 'editorialImplementationSha256', 'mechanicalContractSha256',
    'readerRecoveryEpochSha256', 'readerJsonRequestPolicy', 'repairPromptSha256', 'promptSha256']);
const implementationFields = ALLOWED_FIELDS.filter(field => field.endsWith('Sha256')
    && !['repairPromptSha256', 'promptSha256'].includes(field));
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const withoutRevisionFields = identity => Object.fromEntries(Object.entries(identity)
    .filter(([key]) => !ALLOWED_FIELDS.includes(key)));
const getConferenceAnalysisContext = () => require('./conference-analysis-context.js').getConferenceAnalysisContext();

function readEnvelope(filename) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
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
            // 先保存新文件，再把旧文件改名归档，允许中断后继续完成这两步。
            // 旧文件的完整字节和内容 SHA 仍与记录一致，且归档步骤完成后，新的候选才算就绪。
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

function assertReaderJsonRequestPolicy(policy) {
    if (policy === undefined) return;
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)
        || Object.keys(policy).sort().join(',') !== 'contract,model,responseFormat'
        || policy.contract !== 'api-reader-json-request-policy-v1'
        || policy.model !== 'mimo-v2.6-flash' || policy.responseFormat !== 'json_object') {
        throw new Error('长文草稿的 JSON 请求设置无效');
    }
}

function loadReaderRecoveryRevision(directory, identity, options = {}) {
    assertReaderJsonRequestPolicy(identity?.readerJsonRequestPolicy);
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
    if (exact) {
        verifyPixels(exact);
        const recovered = finishRevisionArchives(directory, identity, exact);
        // 同身份续跑也可能保存了旧解析器拒绝的完整原始稿。仅恢复有界结构，
        // 不修改存档、次数或验证凭证；调用方仍须完整校验并按明确目标修复。
        if (!recovered.draft && recovered.rawDraft) {
            const draft = parseRecoveryDraft(recovered.rawDraft);
            if (draft) return { ...recovered, draft };
        }
        return recovered;
    }
    const context = getFreshAnalysisContext();
    const direct = require('./direct-rewrite-analysis-context.js').getDirectRewriteAnalysisContext();
    const conference = getConferenceAnalysisContext();
    let revisionRunId; let revisionScope;
    if (context) {
        if (context.refreshReaderDiagnostics !== true) return null;
        const canonicalMatch = /^(\d{4}\.\d{4,5})(?:v[1-9]\d*)?$/.exec(String(identity.paperId || ''));
        if (!canonicalMatch) throw new Error('长文恢复的 arXiv 身份格式无效');
        const canonicalPaperId = canonicalMatch[1];
        const expectation = context.sourceExpectations[canonicalPaperId];
        const sealedIdentity = expectation?.sourceMode === 'sealed-arxiv-bundle-v1'
            ? require('./fresh-analysis-context.js').freshAnalysisIdentity(canonicalPaperId) : null;
        const sourceMatches = sealedIdentity
            ? isDeepStrictEqual(identity.freshAnalysis, sealedIdentity)
                && identity.sourceSha256 === sealedIdentity.sourceSha256
            : identity.sourceSha256 === expectation?.sourceSha256
                && identity.freshAnalysis?.sourceSha256 === identity.sourceSha256
                && identity.freshAnalysis?.structuredArtifactsSha256 === expectation?.structuredArtifactsSha256;
        if (path.resolve(directory) !== path.join(context.runDir, 'reader-attempts')
            || identity?.freshAnalysis?.runId !== context.runId
            || identity.freshAnalysis.paperId !== canonicalPaperId
            || !sourceMatches) {
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
        // 原加载器继续检查外层对象、文件权限、JSON、失败候选内容哈希、
        // 根结构与已保存的计数。
        const payload = loadFailedCandidate(directory, envelope.identity);
        if (!payload || hashDraft(payload) !== envelope.payloadSha256) {
            throw new Error('Reader diagnostic revision candidate changed during audit');
        }
        const oldJsonPolicy = envelope.identity.readerJsonRequestPolicy;
        const newJsonPolicy = identity.readerJsonRequestPolicy;
        assertReaderJsonRequestPolicy(oldJsonPolicy);
        // 仅旧省略声明到当前明确格式允许保留原草稿；反向撤掉声明不能复用。
        if (oldJsonPolicy !== undefined && newJsonPolicy === undefined) continue;
        // 仅允许已核验的固定 v3→v4 和 v5→v6 修复正文；其他提示词仍不可迁移。
        // 提示词变化本身不发放正文尝试额度，也不清除已有失败计数。
        const completeTablePromptUpgrade = envelope.identity.promptSha256 === '929ec8f6e93b06edf85158e2fdf46de498111581373e54c06d457b265b00aea5'
            && identity.promptSha256 === 'a41f67166a0f366a10bf23cc17aa51ca6105b246ce7964ec14c21d6b4018f380'
            && envelope.identity.repairPromptSha256 === '7cb7332fa3085b4497c31d73a7075eb10f8700cd84d23f68875d8341cb97f5de'
            && ['cdbf91f9bb2fb48e085c72195000059bdb2ccc4eb6a0bd47a6f31bb9d4835965',
                '9a7e72d75fdd05f7004c132533425fa140d237c22bc98a3c6c64333e5d76e22e',
                '5164ce17261a13a009c34bfcf8a71fc2c44f1ae2246f0651de5eda82a7645f65'].includes(identity.repairPromptSha256);
        const metadataPromptUpgrade = envelope.identity.promptSha256 === identity.promptSha256
            && identity.promptSha256 === 'a41f67166a0f366a10bf23cc17aa51ca6105b246ce7964ec14c21d6b4018f380'
            && envelope.identity.repairPromptSha256 === 'cdbf91f9bb2fb48e085c72195000059bdb2ccc4eb6a0bd47a6f31bb9d4835965'
            && identity.repairPromptSha256 === '9a7e72d75fdd05f7004c132533425fa140d237c22bc98a3c6c64333e5d76e22e';
        // 表格方式优先说明只接受这组已冻结模板；提示变化不增加任何尝试额度。
        const tablePriorityPromptUpgrade = envelope.identity.promptSha256 === identity.promptSha256
            && identity.promptSha256 === 'a41f67166a0f366a10bf23cc17aa51ca6105b246ce7964ec14c21d6b4018f380'
            && ['cdbf91f9bb2fb48e085c72195000059bdb2ccc4eb6a0bd47a6f31bb9d4835965',
                '9a7e72d75fdd05f7004c132533425fa140d237c22bc98a3c6c64333e5d76e22e'].includes(envelope.identity.repairPromptSha256)
            && identity.repairPromptSha256 === '5164ce17261a13a009c34bfcf8a71fc2c44f1ae2246f0651de5eda82a7645f65';
        const sectionReorganizationPromptUpgrade = envelope.identity.promptSha256 === identity.promptSha256
            && identity.promptSha256 === 'a41f67166a0f366a10bf23cc17aa51ca6105b246ce7964ec14c21d6b4018f380'
            && ['cdbf91f9bb2fb48e085c72195000059bdb2ccc4eb6a0bd47a6f31bb9d4835965',
                '9a7e72d75fdd05f7004c132533425fa140d237c22bc98a3c6c64333e5d76e22e',
                '5164ce17261a13a009c34bfcf8a71fc2c44f1ae2246f0651de5eda82a7645f65'].includes(envelope.identity.repairPromptSha256)
            && identity.repairPromptSha256 === 'f50f85a04017de568f8225e97d7b4e230ae40b969d99266afcef045e011829a4';
        if (envelope.identity.promptSha256 !== identity.promptSha256 && !completeTablePromptUpgrade && !metadataPromptUpgrade && !tablePriorityPromptUpgrade && !sectionReorganizationPromptUpgrade) continue;
        if (envelope.identity.repairPromptSha256 !== identity.repairPromptSha256
            && !(envelope.identity.repairPromptSha256 === 'c63148bca8bed36a8c31b0327b87e2a1e9ddf51fd8641813827f5e8f1eb4a6ec'
                && identity.repairPromptSha256 === '8d1483030d1167b9ac3b81602c267ae5e5ec0fc5e88fb7308aea5f1e2a52d470')
            && !(envelope.identity.repairPromptSha256 === '89faba16d2b3af5a1549e13c85800bc7301d3a4217a1d9ae362b33c76cff9a34'
                && identity.repairPromptSha256 === '7cb7332fa3085b4497c31d73a7075eb10f8700cd84d23f68875d8341cb97f5de')
            && !completeTablePromptUpgrade && !metadataPromptUpgrade && !tablePriorityPromptUpgrade && !sectionReorganizationPromptUpgrade) continue;
        if (!isDeepStrictEqual(withoutRevisionFields(envelope.identity), withoutRevisionFields(identity))) continue;
        verifyPixels(payload);
        const changedFields = ALLOWED_FIELDS.filter(field => !isDeepStrictEqual(envelope.identity[field], identity[field]));
        if (changedFields.length) compatible.push({ identity: envelope.identity, payload, changedFields, name, envelopeSha256 });
    }
    if (compatible.length > 1) throw new Error('Ambiguous Reader diagnostic revision: multiple compatible candidates');
    if (!compatible.length) return null;
    const old = compatible[0];
    const updated = structuredClone(old.payload);
    // 有些旧失败候选保存了合法的 JSON 响应，但原解析器拒绝其结构，draft 因而为空。
    // 这里只尝试解析允许恢复的结构；调用方接受正文前仍须运行完整的 Reader 解析器，
    // 并核对正文与来源的对应关系。
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
        // 受限的来源绑定结构，再检查各小节的顺序；否则顺序检查会在
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
    const previousActiveAllowance = hasUnusedImplementationAllowance(updated)
        ? updated.implementationRepairAllowanceProof : null;
    // 实现变化时，只有尚未发放过许可、仍有未使用的许可，或恢复规则版本变化，
    // 才会新增或转交一次正文尝试的许可。用过的许可不会因普通实现变化再次发放。
    const recoveryEpochChanged = old.changedFields.includes('readerRecoveryEpochSha256');
    const grantOrTransferAllowance = !updated.explicitReaderRetryRound && diagnosticImplementationChanged
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
        // 保留已有调用次数，清除旧检查留下的连续失败计数；
        // 新增尝试仍受下方恢复许可规则限制。
    }
    updated.readerRecoveryRevisions = [...(updated.readerRecoveryRevisions || []), audit];
    delete updated.implementationRepairAllowance;
    if (grantOrTransferAllowance) {
        updated.implementationRepairAllowanceLineage = IMPLEMENTATION_ALLOWANCE_LINEAGE_CONTRACT;
    }
    const transferUnusedAllowance = !updated.explicitReaderRetryRound && old.changedFields.length > 0
        && old.changedFields.every(field => ['repairPromptSha256', 'promptSha256'].includes(field))
        && Boolean(previousActiveAllowance);
    if (previousActiveAllowance && !transferUnusedAllowance) {
        updated.consumedImplementationAllowanceSha256 = [...new Set([
            ...(updated.consumedImplementationAllowanceSha256 || []),
            previousActiveAllowance.allowanceSha256
        ])].sort();
    }
    if (transferUnusedAllowance) {
        const body = { contract: 'reader-repair-prompt-unused-allowance-transfer-v1',
            fromIdentitySha256: audit.fromIdentitySha256, toIdentitySha256: hashDraft(identity),
            oldPayloadSha256: audit.oldPayloadSha256, revisionAuditSha256: hashDraft(audit),
            originalAllowanceSha256: previousActiveAllowance.allowanceSha256 };
        updated.implementationRepairAllowanceProof = { ...body, allowanceSha256: hashDraft(body) };
    } else {
        updated.implementationRepairAllowanceProof = grantOrTransferAllowance
            ? implementationAllowanceProof(identity, audit) : null;
    }
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
