'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { getFreshAnalysisContext } = require('./fresh-analysis-context.js');
const { loadFailedCandidate, readFailedCandidateEnvelope, saveFailedCandidate, hashDraft, shaText, parseRecoveryDraft,
    IMPLEMENTATION_ALLOWANCE_CONTRACT, IMPLEMENTATION_ALLOWANCE_LINEAGE_CONTRACT,
    hasUnusedImplementationAllowance, TABLE_COUNT_ISSUE_CODE, classifyTableBindingOrderIssue, readTableBindingOrderError,
    REPAIR_VERSION, validateImplementationAllowance, TABLE_BINDING_ORDER_ISSUE_CODE, readTableBindingOrderIssue, readTableCountIssue } = require('./reader-repair.js');
const { normalizeReaderDraftOrder, pruneUniquelyUnboundReaderMarkdownTables } = require('./reader-draft-order.js');
const { normalizeDanglingReaderConnectors,
    normalizeIssueBoundReaderQuantitativeNumerals } = require('../editorial-quality.js');

function assertSafeResolvedJson(value) {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new Error('已归档读者稿含非普通对象');
    for (const key of Object.keys(value)) {
        if (['__proto__','prototype','constructor'].includes(key)) throw new Error('已归档读者稿含危险对象字段');
        assertSafeResolvedJson(value[key]);
    }
}
function readFullResolvedReader(directory, filename, expectedSha) {
    const checked = require('./reader-paid-resolved-render').readResolvedFile(directory,filename,expectedSha);
    if (fs.statSync(filename).size > 20 * 1024 * 1024) throw new Error('已归档读者稿超过原候选大小上限');
    const envelope = checked.envelope;
    assertSafeResolvedJson(envelope);
    if (!envelope.identity || typeof envelope.identity !== 'object' || Array.isArray(envelope.identity)
        || envelope.version !== REPAIR_VERSION
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
        throw new Error('已归档读者稿的内容或次数证明损坏');
    }
    validateImplementationAllowance(envelope.payload, envelope.identity, directory);
    require('./explicit-reader-retry-round').validatePersistedRound(directory, envelope.identity, envelope.payload);
    checked.assertUnchanged();
    return { ...checked, envelopeSha256:expectedSha };
}

const CONTRACT = 'reader-recovery-diagnostics-revision-v1';
const ALLOWED_FIELDS = Object.freeze(['repairImplementationSha256', 'tableCompilerSha256', 'draftOrderContract',
    'draftOrderImplementationSha256', 'sourceDiagnosticsImplementationSha256',
    'parserImplementationSha256', 'editorialImplementationSha256', 'mechanicalContractSha256',
    'resourceLocalRevisionContract', 'readerFactLocalRevisionContract', 'readerRecoveryEpochSha256', 'readerJsonRequestPolicy', 'repairPromptSha256', 'promptSha256']);
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
            require('./reader-proof-read-scope').assertReaderReceiptSnapshots();
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

function restoreUnfundedDiagnosticFailureState(directory, identity, payload) {
    const last = payload.readerRecoveryRevisions?.at(-1), fresh = require('./fresh-analysis-context');
    const fields = ['noProgress','failureSignature','validationFailureStreak','validationFailureSignature'];
    if (!last || !payload.readerRecoveryRevisions.some(audit => audit.clearedNoProgress === true)
        || payload.implementationRepairAllowanceProof || payload.noProgress !== 0 || payload.failureSignature !== ''
        || payload.validationFailureStreak !== 0 || payload.validationFailureSignature !== '') return payload;
    const context = getFreshAnalysisContext();
    if (!fresh.isDailyFreshSourceScope() || !context?.refreshReaderDiagnostics
        || !require('../analysis-engine').paperAnalysisLockHeld({ arxivId: identity.paperId })
        || path.resolve(directory) !== path.join(context.runDir, 'reader-attempts')
        || !isDeepStrictEqual(fresh.freshAnalysisIdentity(identity.paperId), identity.freshAnalysis)) return payload;
    const same = require('./reader-compatible-candidate-replay');
    const source = require('./model-text-sanitization').currentModelInputSourceForPaperId(identity.paperId);
    if (!source || shaText(source.text) !== identity.sourceSha256) throw new Error('Unfunded diagnostic state recovery scope drift');
    const chain = [], seen = new Set();
    let nodeIdentity = identity, node = payload, originalState;
    while (chain.length < 32) {
        const audit = node.readerRecoveryRevisions?.at(-1);
        if (!audit || audit.scope !== 'fresh-run' || audit.toIdentitySha256 !== hashDraft(nodeIdentity)
            || audit.paperId !== identity.paperId || audit.runId !== context.runId
            || !/^[a-f0-9]{64}$/.test(audit.fromIdentitySha256 || '')
            || !new RegExp(`^${audit.fromIdentitySha256}\\.migrated-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.json$`).test(audit.archivedName || '')
            || seen.has(audit.archivedName)) throw new Error('Unfunded diagnostic state recovery scope or archive drift');
        seen.add(audit.archivedName);
        const file = path.join(directory, audit.archivedName), checked = readEnvelope(file), envelope = checked.envelope;
        const old = envelope.payload, oldIdentity = envelope.identity;
        const changed = [...new Set([...Object.keys(oldIdentity || {}), ...Object.keys(nodeIdentity)])]
            .filter(key => !isDeepStrictEqual(oldIdentity?.[key], nodeIdentity[key])).sort();
        if (checked.envelopeSha256 !== audit.oldEnvelopeSha256 || envelope.version !== REPAIR_VERSION
            || envelope.payloadSha256 !== hashDraft(old) || old?.status !== 'failed' || !parseRecoveryDraft(old?.draft)
            || hashDraft(oldIdentity) !== audit.fromIdentitySha256 || hashDraft(old) !== audit.oldPayloadSha256
            || !same.sameInput(oldIdentity, nodeIdentity) || !isDeepStrictEqual([...audit.changedFields].sort(), changed)
            || changed.some(key => !implementationFields.includes(key) || key === 'readerRecoveryEpochSha256')
            || old.implementationRepairAllowanceProof || old.implementationRepairAllowanceLineage !== IMPLEMENTATION_ALLOWANCE_LINEAGE_CONTRACT
            || node.implementationRepairAllowanceLineage !== old.implementationRepairAllowanceLineage
            || ['attempts','fullAttempts','transportFailures'].some(key => (node[key] || 0) !== (old[key] || 0) || audit[key] !== (old[key] || 0))
            || audit.oldNoProgress !== old.noProgress || audit.oldFailureSignature !== old.failureSignature
            || audit.inputDraftSha256 !== hashDraft(old.draft) || audit.outputDraftSha256 !== hashDraft(node.draft)
            || hashDraft(old.draft) !== hashDraft(node.draft)
            || !isDeepStrictEqual(old.explicitReaderRetryRound, node.explicitReaderRetryRound))
            throw new Error('Unfunded diagnostic state recovery requires unchanged original draft, input and paid budget');
        chain.push({ file, sha256: checked.envelopeSha256, audit, oldPayloadSha256: hashDraft(old) });
        if (audit.clearedNoProgress === true) { originalState = Object.fromEntries(fields.map(key => [key, old[key]])); break; }
        if (audit.clearedNoProgress !== false || fields.some(key => !isDeepStrictEqual(node[key], old[key])))
            throw new Error('Intermediate diagnostic migration changed failure state');
        node = old; nodeIdentity = oldIdentity;
    }
    if (!originalState) throw new Error('Unfunded diagnostic state recovery lacks a bounded original archive');
    const latest = same.latestReaderRequest(require('../config').FILES.llmUsageDir, identity.paperId, context.runId);
    if (!latest || latest.value.contentAttempt !== payload.attempts
        || chain.some(edge => !Number.isFinite(Date.parse(edge.audit.revisedAt)) || latest.at > Date.parse(edge.audit.revisedAt)))
        throw new Error('Unfunded diagnostic state recovery has a later or unproven Reader request');
    const checked = readFailedCandidateEnvelope(directory, identity);
    if (!checked || hashDraft(checked.envelope.payload) !== hashDraft(payload)) throw new Error('Diagnostic candidate changed before state recovery');
    const restored = { ...structuredClone(payload), ...originalState };
    restored.diagnosticFailureStateRestorations = [...(restored.diagnosticFailureStateRestorations || []), {
        contract: 'reader-unfunded-diagnostic-state-restoration-v1', restoredAt: new Date().toISOString(),
        identitySha256: hashDraft(identity), migrationAuditSha256: hashDraft(last),
        originalFailureState: originalState, previousEnvelopeSha256: checked.envelopeSha256,
        archiveChain: chain.map(edge => ({ archivedName: path.basename(edge.file), originalEnvelopeSha256: edge.sha256,
            originalPayloadSha256: edge.oldPayloadSha256, migrationAuditSha256: hashDraft(edge.audit) })),
        latestUsageFileName: path.basename(latest.file), latestUsageSha256: latest.sha256, latestUsageEventId: latest.value.eventId
    }];
    for (const edge of chain) if (readEnvelope(edge.file).envelopeSha256 !== edge.sha256) throw new Error('Original diagnostic archive changed before restoration');
    require('./reader-proof-read-scope').readReaderProofJson(latest.file, { expectedSha256: latest.sha256 });
    require('./reader-proof-read-scope').assertReaderReceiptSnapshots();
    saveFailedCandidate(directory, identity, restored);
    return loadFailedCandidate(directory, identity);
}

function loadReaderRecoveryRevision(directory, identity, options = {}) {
    if (options.allowNewImplementationAllowance !== undefined
        && typeof options.allowNewImplementationAllowance !== 'boolean') {
        throw new TypeError('Reader implementation allowance policy must be boolean');
    }
    if (options.allowNewImplementationAllowance === true) {
        throw new Error('Reader implementation allowance grants are retired; new budget requires an explicit paid round');
    }
    return require('./reader-proof-read-scope').withReaderProofReadScope(
        () => require('./reader-proof-read-scope').withReaderReceiptScan(() => {
            try { return require('./reader-unsent-empty-candidate').withRecovery(directory, identity,
                () => loadReaderRecoveryRevisionInternal(directory, identity, options)); }
            catch (cause) {
                if (options.resolvedReaderCandidate === undefined) throw cause;
                throw Object.assign(new Error(`已归档读者稿复验输入不合法：${cause.message}`, { cause }), {
                    code: 'RESOLVED_READER_REVALIDATION_INPUT_INVALID', category: 'config',
                    retryable: false, scope: 'run', modelRequestClassified: true
                });
            }
        }));
}
function loadReaderRecoveryRevisionInternal(directory, identity, options = {}) {
    if (options.savedReaderInputContinuity !== undefined) {
        const source = require('./model-text-sanitization').currentModelInputSource(options.paper);
        require('./reader-saved-feedback-input-continuity').readSavedReaderInputContinuity(
            options.savedReaderInputContinuity, options.paper, source, identity);
    }
    if (identity?.resourceLocalRevisionContract !== undefined
        && (identity.resourceLocalRevisionContract !== 'signed-reader-resource-local-repair-v1'
            || identity.contentMode !== 'reader-source-signed-revision-v1')) {
        throw new Error('资源局部修订的恢复模式记录无效');
    }
    if (identity?.readerFactLocalRevisionContract !== undefined
        && (identity.readerFactLocalRevisionContract !== 'signed-reader-fact-local-repair-v1'
            || identity.contentMode !== 'reader-source-signed-revision-v1'
            || identity.resourceLocalRevisionContract !== undefined)) {
        throw new Error('事实局部修订的恢复模式记录无效');
    }
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
    if (options.paidReaderResponseReplay !== undefined) {
        const request = options.paidReaderResponseReplay;
        if (!/^[a-f0-9]{64}$/.test(request?.candidateIdentitySha256 || '')) {
            throw new Error('原付费响应复验须指定唯一原候选');
        }
        const filename = path.join(directory, request.candidateIdentitySha256 + '.json');
        const old = readFailedCandidateEnvelope(directory, null, filename);
        if (!old || hashDraft(identity) === hashDraft(old.envelope.identity)
            || loadFailedCandidate(directory, identity)) {
            throw new Error('原付费响应复验不能覆盖原记录或其他当前候选');
        }
        verifyPixels(old.envelope.payload);
        const replay = require('./reader-paid-response-replay').replayPaidReaderResponse(
            directory, old, identity, request
        );
        const updated = structuredClone(old.envelope.payload);
        updated.draft = replay.draft;
        updated.rawDraft = replay.rawDraft;
        const changedFields = ALLOWED_FIELDS.filter(field =>
            !isDeepStrictEqual(old.envelope.identity[field], identity[field]));
        const audit = {
            contract: CONTRACT, runId: identity.freshAnalysis.runId,
            scope: 'daily-fresh-source', paperId: identity.paperId,
            fromIdentitySha256: hashDraft(old.envelope.identity), toIdentitySha256: hashDraft(identity),
            oldPayloadSha256: old.envelope.payloadSha256, oldEnvelopeSha256: old.envelopeSha256,
            archivedName: `${hashDraft(old.envelope.identity)}.migrated-${crypto.randomUUID()}.json`,
            changedFields, clearedNoProgress: false,
            attempts: updated.attempts, fullAttempts: updated.fullAttempts,
            transportFailures: updated.transportFailures || 0,
            inputDraftSha256: hashDraft(old.envelope.payload.draft), outputDraftSha256: hashDraft(updated.draft),
            paidResponseReplay: replay.proof
        };
        updated.readerRecoveryRevisions = [...(updated.readerRecoveryRevisions || []), audit];
        replay.assertUnchanged();
        const stillOld = readFailedCandidateEnvelope(directory, null, filename);
        if (stillOld.envelopeSha256 !== old.envelopeSha256) {
            throw new Error('原付费响应保存前候选已变化');
        }
        require('./reader-proof-read-scope').assertReaderReceiptSnapshots();
        saveFailedCandidate(directory, identity, updated);
        finishRevisionArchives(directory, identity, updated);
        return loadFailedCandidate(directory, identity);
    }
    const unsentEmpty = require('./reader-unsent-empty-candidate');
    const exact = unsentEmpty.suppressExact(directory, identity) ? null : loadFailedCandidate(directory, identity);
    if (exact) {
        if (options.resolvedReaderCandidate !== undefined) throw new Error('显式归档复验不能覆盖现有活动候选');
        verifyPixels(exact);
        const recovered = restoreUnfundedDiagnosticFailureState(directory, identity, finishRevisionArchives(directory, identity, exact));
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
        if (context.refreshReaderDiagnostics !== true) {
            if (options.resolvedReaderCandidate !== undefined) throw new Error('显式归档复验须启用当前封存来源的恢复诊断');
            return null;
        }
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
    } else {
        if (options.resolvedReaderCandidate !== undefined) throw new Error('显式归档复验须在当前封存来源作用域内');
        return null;
    }
    if (options.resolvedReaderCandidate !== undefined) {
        const request = options.resolvedReaderCandidate;
        const paper = options.paper;
        const allowed = ['parserImplementationSha256','editorialImplementationSha256','draftOrderImplementationSha256'];
        if (!request || Object.keys(request).sort().join(',') !== 'basename,envelopeSha256,readerArticleSha256,readerPlanSha256'
            || !/^[a-f0-9]{64}\.[a-f0-9-]{36}\.resolved\.json$/.test(request.basename || '')
            || ['envelopeSha256','readerArticleSha256','readerPlanSha256'].some(key=>!/^[a-f0-9]{64}$/.test(request[key] || ''))
            || !context || context.refreshReaderDiagnostics !== true
            || (expectedPixels === undefined && expectedEphemeralPixels === undefined)
            || !paper?.latestAnalysisAttemptError
            || !(paper.analysisManifest?.stages?.apiReaderArticle?.qualityMetrics?.blockingIssueCount > 0)
            || paper.apiReaderArticleSha256 !== request.readerArticleSha256
            || paper.apiReaderPlanSha256 !== request.readerPlanSha256
            || shaText(paper.apiReaderArticle) !== request.readerArticleSha256
            || require('./fresh-rewrite-run').stableHash(paper.apiReaderPlan) !== request.readerPlanSha256) {
            throw new Error('显式归档复验须绑定未改变且质量计数失败的正式读者稿');
        }
        if (loadFailedCandidate(directory, identity)) throw new Error('显式归档复验不能覆盖现有活动候选');
        const checked = require('./reader-paid-resolved-render').readResolvedFile(directory,
            path.join(directory,request.basename), request.envelopeSha256);
        const full = readFullResolvedReader(directory,path.join(directory,request.basename),request.envelopeSha256);
        if (!full || full.envelopeSha256 !== request.envelopeSha256) throw new Error('已归档读者稿的完整证明与指定字节不一致');
        const old = full.envelope;
        const strip = value => Object.fromEntries(Object.entries(value).filter(([key])=>!allowed.includes(key)));
        const changedFields = allowed.filter(field=>!isDeepStrictEqual(old.identity[field],identity[field]));
        if (!isDeepStrictEqual(strip(old.identity),strip(identity)) || !changedFields.length
            || old.identity.model?.model !== 'muse-spark-1.3-contributor'
            || request.basename.slice(0,64) !== hashDraft(old.identity)
            || !old.payload.draft || typeof old.payload.rawDraft !== 'string') {
            throw new Error('已归档读者稿的原身份或完整草稿无效');
        }
        const stage = paper.analysisManifest?.stages?.apiReaderArticle;
        if (String(paper.arxivId || paper.id || '').replace(/v[1-9]\d*$/, '') !== identity.paperId.replace(/v[1-9]\d*$/, '')
            || paper.sourceSha256 !== identity.sourceSha256
            || stage?.sourceBindingsSourceTextSha256 !== identity.sourceSha256
            || stage?.model !== old.identity.model.model || stage?.protocol !== old.identity.model.protocol
            || stage?.promptTemplateSha256 !== old.identity.promptSha256
            || stage?.repairPromptTemplateSha256 !== old.identity.repairPromptSha256
            || stage?.imageEvidenceSha256 !== hashDraft(old.payload.imageEvidence || [])
            || stage?.modelImagePreflightEvidenceSha256 !== hashDraft(old.payload.ephemeralImageEvidence)) {
            throw new Error('已归档读者稿与当前正式执行证明不一致');
        }
        verifyPixels(old.payload);
        const updated = structuredClone(old.payload);
        const audit = { contract:CONTRACT,runId:revisionRunId,scope:revisionScope,paperId:identity.paperId,
            fromIdentitySha256:hashDraft(old.identity),toIdentitySha256:hashDraft(identity),
            oldPayloadSha256:old.payloadSha256,oldEnvelopeSha256:request.envelopeSha256,
            resolvedSourceName:request.basename,changedFields,clearedNoProgress:false,
            attempts:updated.attempts,fullAttempts:updated.fullAttempts,transportFailures:updated.transportFailures || 0,
            inputDraftSha256:hashDraft(updated.draft),outputDraftSha256:hashDraft(updated.draft) };
        // 已归档的费用证明仍按原身份保存；只读重验不新建候选、不转交或增发许可。
        updated.resolvedReaderCandidateReplayProof = audit;
        checked.assertUnchanged();
        require('./reader-proof-read-scope').assertReaderReceiptSnapshots();
        return updated;
    }
    let names;
    try { names = fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort(); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const compatible = [];
    for (const name of names) {
        if (unsentEmpty.suppressCandidate(directory, name)) continue;
        let checked = readFailedCandidateEnvelope(directory, null, path.join(directory, name));
        if (checked && require('./reader-compatible-candidate-replay').sameInput(checked.envelope.identity, identity)) {
            restoreUnfundedDiagnosticFailureState(directory, checked.envelope.identity, checked.envelope.payload);
            checked = readFailedCandidateEnvelope(directory, null, path.join(directory, name));
        }
        if (!checked) throw new Error('Reader 恢复候选在审查期间消失');
        const { envelope, envelopeSha256 } = checked;
        const payload = envelope.payload;
        // 只允许从同输入的旧签名模式收紧为资源局部模式，不允许解除已保存的局部限制。
        if (envelope.identity.resourceLocalRevisionContract !== undefined
            && envelope.identity.resourceLocalRevisionContract !== identity.resourceLocalRevisionContract) continue;
        if (envelope.identity.readerFactLocalRevisionContract !== undefined
            && envelope.identity.readerFactLocalRevisionContract !== identity.readerFactLocalRevisionContract) continue;
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
        // 仅固定的中文提示升级；同源身份、原回执和预算仍由原恢复链核验。
        const plainChinesePromptUpgrade = envelope.identity.promptSha256 === 'a41f67166a0f366a10bf23cc17aa51ca6105b246ce7964ec14c21d6b4018f380'
            && envelope.identity.repairPromptSha256 === 'f50f85a04017de568f8225e97d7b4e230ae40b969d99266afcef045e011829a4'
            && identity.promptSha256 === 'b4f0b864fd338cc3a58a2e061ec952947a6faa4a09971167d6daa7add9ebbd9f'
            && identity.repairPromptSha256 === 'd3fa5851973b36e0944a9abf13f719aa34b1782f784ee086e6e637deea8979c2'
            && isDeepStrictEqual(envelope.identity.readerRecoveryEpochSha256, identity.readerRecoveryEpochSha256);
        if (envelope.identity.promptSha256 !== identity.promptSha256 && !completeTablePromptUpgrade && !metadataPromptUpgrade && !tablePriorityPromptUpgrade && !sectionReorganizationPromptUpgrade && !plainChinesePromptUpgrade) continue;
        if (envelope.identity.repairPromptSha256 !== identity.repairPromptSha256
            && !(envelope.identity.repairPromptSha256 === 'c63148bca8bed36a8c31b0327b87e2a1e9ddf51fd8641813827f5e8f1eb4a6ec'
                && identity.repairPromptSha256 === '8d1483030d1167b9ac3b81602c267ae5e5ec0fc5e88fb7308aea5f1e2a52d470')
            && !(envelope.identity.repairPromptSha256 === '89faba16d2b3af5a1549e13c85800bc7301d3a4217a1d9ae362b33c76cff9a34'
                && identity.repairPromptSha256 === '7cb7332fa3085b4497c31d73a7075eb10f8700cd84d23f68875d8341cb97f5de')
            && !completeTablePromptUpgrade && !metadataPromptUpgrade && !tablePriorityPromptUpgrade && !sectionReorganizationPromptUpgrade && !plainChinesePromptUpgrade) continue;
        if (!isDeepStrictEqual(withoutRevisionFields(envelope.identity), withoutRevisionFields(identity))) continue;
        verifyPixels(payload);
        const changedFields = ALLOWED_FIELDS.filter(field => !isDeepStrictEqual(envelope.identity[field], identity[field]));
        if (changedFields.length) compatible.push({ identity: envelope.identity, payload, changedFields, name, envelopeSha256, plainChinesePromptUpgrade });
    }
    let compatibleReplay;
    if (compatible.length > 1) {
        compatibleReplay = require('./reader-compatible-candidate-replay').resolveCompatibleCandidates(
            directory, identity, compatible, options);
        if (!compatibleReplay) throw new Error('Ambiguous Reader diagnostic revision: multiple compatible candidates');
        compatible.splice(0, compatible.length, compatibleReplay.selected);
    }
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
        const sourceBlocked = require('./reader-source-blocked-normalization');
        let currentSource = null;
        if (typeof options.normalizeReplayDraft === 'function'
            || require('./fresh-analysis-context').isDailyFreshSourceScope()) {
            currentSource = require('./model-text-sanitization').currentModelInputSourceForPaperId(identity.paperId);
            if (currentSource && shaText(currentSource.text) !== identity.sourceSha256) {
                throw new Error('来源阻塞恢复的当前正文与候选身份不同');
            }
        }
        try {
            normalized = typeof options.normalizeReplayDraft === 'function'
                ? options.normalizeReplayDraft(structuredClone(updated.draft), structuredClone(updated.issues), structuredClone(updated.imageEvidence || []))
                : normalizeReaderDraftOrder(updated.draft, { structuredArtifacts: currentSource?.structuredArtifacts });
        } catch (error) {
            const blocked = sourceBlocked.readSourceTableNormalizationError(error, updated.draft, currentSource?.structuredArtifacts);
            if (blocked) normalized = blocked;
            else if (!readTableBindingOrderError(error)) throw error;
        }
        if (normalized?.contract === sourceBlocked.CONTRACT) {
            const blocked = sourceBlocked.assertBlockedNormalizationResult(normalized, currentSource?.structuredArtifacts);
            updated.blockedSourceTableNormalization = { contract: sourceBlocked.CONTRACT,
                inputDraftSha256: hashDraft(updated.draft), outputDraftSha256: blocked.draftSha256,
                blockingIssuesSha256: hashDraft(blocked.blockingIssues), artifactsSha256: blocked.artifactsSha256 };
            updated.draft = blocked.draft;
            updated.issues = require('./reader-repair').collectDraftIssues(updated.draft,
                Object.assign(new Error('来源完整表仍阻塞，交回正常约束修复'), {
                    code: 'READER_SOURCE_TABLE_UNRENDERABLE', readerIssues: blocked.blockingIssues }),
                { sourceText: currentSource.text, structuredArtifacts: currentSource.structuredArtifacts });
            updated.status = 'failed';
            normalized = null;
        }
        if (normalized) {
            updated.draft = normalized.draft || normalized;
            updated.rawDraft = JSON.stringify(updated.draft);
            if (normalized.mapping?.changed) {
                updated.draftOrderMappings = [...(updated.draftOrderMappings || []), normalized.mapping];
            }
        }
    }
    const diagnosticImplementationChanged = options.savedReaderInputContinuity === undefined && !compatibleReplay && !identity.readerFactLocalRevisionContract && !old.plainChinesePromptUpgrade
        && implementationFields.some(field => old.changedFields.includes(field));
    const previousActiveAllowance = hasUnusedImplementationAllowance(updated)
        ? updated.implementationRepairAllowanceProof : null;
    // 只迁移真实既存的历史许可证明；实现和恢复版本变化均不能创造新付费额度。
    const transferExistingCompatibleAllowance = Boolean(options.savedReaderInputContinuity === undefined && compatibleReplay && previousActiveAllowance
        && !updated.explicitReaderRetryRound && old.changedFields.some(field => implementationFields.includes(field)));
    const grantOrTransferAllowance = transferExistingCompatibleAllowance || !compatibleReplay && !updated.explicitReaderRetryRound && diagnosticImplementationChanged
        && Boolean(previousActiveAllowance);
    const clearDiagnosticState = false;
    const archivedName = `${hashDraft(old.identity)}.migrated-${crypto.randomUUID()}.json`;
    const audit = { contract: CONTRACT, revisedAt: new Date().toISOString(), scope: revisionScope,
        runId: revisionRunId, paperId: identity.paperId,
        fromIdentitySha256: hashDraft(old.identity), toIdentitySha256: hashDraft(identity),
        changedFields: old.changedFields, archivedName,
        oldPayloadSha256: hashDraft(old.payload), oldEnvelopeSha256: old.envelopeSha256,
        oldNoProgress: updated.noProgress, oldFailureSignature: updated.failureSignature,
        clearedNoProgress: clearDiagnosticState,
        attempts: updated.attempts, fullAttempts: updated.fullAttempts,
        transportFailures: updated.transportFailures ?? 0,
        inputDraftSha256: old.payload.draft ? hashDraft(old.payload.draft) : null,
        outputDraftSha256: updated.draft ? hashDraft(updated.draft) : null,
        ...(compatibleReplay ? { compatibleCandidateReplay: compatibleReplay.proof } : {}),
        ...(transferExistingCompatibleAllowance ? { transferredExistingImplementationAllowanceSha256: previousActiveAllowance.allowanceSha256 } : {}) };
    updated.readerRecoveryRevisions = [...(updated.readerRecoveryRevisions || []), audit];
    delete updated.implementationRepairAllowance;
    if (grantOrTransferAllowance) {
        updated.implementationRepairAllowanceLineage = IMPLEMENTATION_ALLOWANCE_LINEAGE_CONTRACT;
    }
    const transferUnusedAllowance = !updated.explicitReaderRetryRound && old.changedFields.length > 0
        && (old.plainChinesePromptUpgrade
            || old.changedFields.every(field => ['repairPromptSha256', 'promptSha256'].includes(field)))
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
    if (racedExact && !unsentEmpty.suppressExact(directory, identity)) { verifyPixels(racedExact); return finishRevisionArchives(directory, identity, racedExact); }
    if (hashDraft(loadFailedCandidate(directory, old.identity)) !== hashDraft(old.payload)) {
        throw new Error('Reader diagnostic revision source changed before installation');
    }
    require('./reader-proof-read-scope').assertReaderReceiptSnapshots();
    if (compatibleReplay) compatibleReplay.assertUnchanged();
    unsentEmpty.beforeInstall(directory, identity, updated, old);
    saveFailedCandidate(directory, identity, updated);
    finishRevisionArchives(directory, identity, updated);
    unsentEmpty.afterInstall(directory, identity);
    // 仍然是失败的恢复输入，不是已接受的正文，也不是证明。
    return loadFailedCandidate(directory, identity);
}

module.exports = { CONTRACT, ALLOWED_FIELDS, loadReaderRecoveryRevision,
    readFullResolvedReaderForReadOnlyInspection: readFullResolvedReader };
function implementationAllowanceProof(identity, audit) {
    const body = { contract: IMPLEMENTATION_ALLOWANCE_CONTRACT,
        fromIdentitySha256: audit.fromIdentitySha256, toIdentitySha256: hashDraft(identity),
        oldPayloadSha256: audit.oldPayloadSha256, revisionAuditSha256: hashDraft(audit),
        changedFields: audit.changedFields.filter(field => implementationFields.includes(field)).sort() };
    return { ...body, allowanceSha256: hashDraft(body) };
}
