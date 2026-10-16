'use strict';
// Read-only resolution of a genuinely ambiguous diagnostic migration. No new budget.
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const CONTRACT = 'reader-compatible-candidate-replay-v1';
const IMPLEMENTATION_FIELDS = new Set(['parserImplementationSha256', 'editorialImplementationSha256',
    'mechanicalContractSha256', 'tableCompilerSha256', 'repairImplementationSha256',
    'sourceDiagnosticsImplementationSha256', 'draftOrderImplementationSha256', 'draftOrderContract']);
const semantic = identity => Object.fromEntries(Object.entries(identity).filter(([key]) => !IMPLEMENTATION_FIELDS.has(key)));
const sameInput = (left, right) => isDeepStrictEqual(semantic(left), semantic(right));
function safeDirectory(root) {
    const absolute = path.resolve(root);
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Reader replay proof directory is unsafe');
    }
    return absolute;
}
function readProof(file, expectedSha256) {
    return require('./reader-proof-read-scope').readReaderProofJson(file, { expectedSha256 });
}
function latestReaderRequest(usageDirectory, paperId, runId) {
    let latest = null, ambiguous = false;
    for (const name of fs.readdirSync(safeDirectory(usageDirectory)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
        const file = path.join(usageDirectory, name);
        const checked = readProof(file);
        const event = checked.value;
        if (event.kind !== 'request' || event.paperId !== paperId || event.runId !== runId
            || !['apiReaderArticle', 'apiReaderRepair'].includes(event.stage)) continue;
        if (require('./reader-unsent-empty-candidate').excludedUsage(file, checked)) continue;
        const at = Date.parse(event.at);
        if (!Number.isFinite(at)) return null;
        if (!latest || at > latest.at) { latest = { ...checked, file, at }; ambiguous = false; }
        else if (at === latest.at && event.eventId !== latest.value.eventId) ambiguous = true;
    }
    return ambiguous ? null : latest;
}
// A paper may have several genuinely different resource inputs. The most recent
// paper-level fee is not permission to move its draft into another input.
// Resolve the fee within the complete actual input, only after the global latest
// response itself is uniquely bound to a real request (unknown latest stays shut).
function latestReaderRequestForInput(directory, identity, latest) {
    if (!latest) return null;
    const repair = require('./reader-repair');
    const diagnostics = safeDirectory(path.join(directory, 'request-diagnostics'));
    const records = [], knownRequests = [];
    for (const name of fs.readdirSync(diagnostics).filter(name => /^[a-f0-9-]{36}\.request\.json$/.test(name))) {
        const requestFile = path.join(diagnostics, name), request = readProof(requestFile), req = request.value;
        if (req.identity?.paperId !== identity.paperId || req.identity?.freshAnalysis?.runId !== identity.freshAnalysis?.runId) continue;
        if (req.contract !== 'reader-repair-request-diagnostics-v1' || name !== req.id + '.request.json'
            || req.promptSha256 !== repair.shaText(req.prompt) || req.draftSha256 !== repair.hashDraft(req.draft)) continue;
        knownRequests.push({ requestFile, request });
        const responseFile = path.join(diagnostics, req.id + '.response.json'); let response;
        try { response = readProof(responseFile); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const res = response.value;
        if (res.contract !== req.contract || res.id !== req.id || res.requestSha256 !== request.sha256
            || res.outputTextSha256 !== repair.shaText(res.rawResponse)
            || !Number.isFinite(Date.parse(req.at)) || !Number.isFinite(Date.parse(res.at))
            || Date.parse(req.at) > Date.parse(res.at)) continue;
        records.push({ requestFile, request, responseFile, response });
    }
    const matches = proof => records.filter(({ request, response }) => {
        const req = request.value, res = response.value, event = proof.value;
        return event.stage === 'apiReaderRepair' && event.contentAttempt === req.contentAttempt
            && event.model === req.identity.model?.model && event.protocol === req.identity.model?.protocol
            && event.outputTextSha256 === res.outputTextSha256 && proof.at >= Date.parse(req.at)
            && Math.abs(proof.at - Date.parse(res.at)) <= 30000;
    });
    const globalMatches = matches(latest);
    if (globalMatches.length !== 1) return null;
    if (sameInput(globalMatches[0].request.value.identity, identity)) return { usage: latest, binding: globalMatches[0], snapshots: [] };
    let selected = null, ambiguous = false;
    let selectedBinding;
    const unprovenOwnFees = [];
    const snapshots = [[latest.file, latest.sha256], ...globalMatches.flatMap(record =>
        [[record.requestFile, record.request.sha256], [record.responseFile, record.response.sha256]])];
    for (const name of fs.readdirSync(require('../config').FILES.llmUsageDir).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
        const file = path.join(require('../config').FILES.llmUsageDir, name), proof = readProof(file), event = proof.value;
        if (event.kind !== 'request' || event.paperId !== identity.paperId || event.runId !== identity.freshAnalysis?.runId
            || !['apiReaderArticle','apiReaderRepair'].includes(event.stage)) continue;
        const at = Date.parse(event.at); if (!Number.isFinite(at)) return null;
        proof.file = file; proof.at = at;
        const bound = matches(proof), own = bound.filter(record => sameInput(record.request.value.identity, identity));
        if (!own.length) {
            if (!bound.length && knownRequests.some(record => sameInput(record.request.value.identity, identity)
                && record.request.value.contentAttempt === event.contentAttempt && Date.parse(record.request.value.at) <= at))
                unprovenOwnFees.push(at);
            continue;
        }
        if (bound.length !== 1) return null;
        snapshots.push([file, proof.sha256], [own[0].requestFile, own[0].request.sha256], [own[0].responseFile, own[0].response.sha256]);
        if (!selected || at > selected.at) { selected = proof; selectedBinding = own[0]; ambiguous = false; }
        else if (at === selected.at && event.eventId !== selected.value.eventId) ambiguous = true;
    }
    return selected && !ambiguous && !unprovenOwnFees.some(at => at > selected.at)
        ? { usage: selected, binding: selectedBinding, snapshots } : null;
}
function migrationDominance(compatible) {
    const repair = require('./reader-repair');
    const dominated = new Set();
    const edges = [];
    for (const child of compatible) {
        for (const audit of child.payload.readerRecoveryRevisions || []) {
            const parent = compatible.find(item => repair.hashDraft(item.identity) === audit.fromIdentitySha256);
            if (!parent) continue;
            if (audit.toIdentitySha256 !== repair.hashDraft(child.identity)) continue;
            const changedFields = [...new Set([...Object.keys(parent.identity), ...Object.keys(child.identity)])]
                .filter(field => !isDeepStrictEqual(parent.identity[field], child.identity[field])).sort();
            if (audit.contract !== 'reader-recovery-diagnostics-revision-v1'
                || audit.oldEnvelopeSha256 !== parent.envelopeSha256
                || audit.oldPayloadSha256 !== repair.hashDraft(parent.payload)
                || !Array.isArray(audit.changedFields) || !isDeepStrictEqual([...audit.changedFields].sort(), changedFields)
                || changedFields.some(field => !IMPLEMENTATION_FIELDS.has(field))
                || audit.scope !== 'fresh-run'
                || audit.paperId !== child.identity.paperId || audit.runId !== child.identity.freshAnalysis?.runId
                || !sameInput(parent.identity, child.identity)
                || ['attempts', 'fullAttempts', 'transportFailures'].some(key =>
                    audit[key] !== (parent.payload[key] || 0))
                || ['attempts', 'fullAttempts', 'transportFailures'].some(key =>
                    (child.payload[key] || 0) < (parent.payload[key] || 0))) return null;
            dominated.add(parent);
            edges.push({ parentIdentitySha256: repair.hashDraft(parent.identity), childIdentitySha256: repair.hashDraft(child.identity),
                oldEnvelopeSha256: parent.envelopeSha256, oldPayloadSha256: repair.hashDraft(parent.payload) });
        }
    }
    // An audit must never turn a circular or mutually dominating pair into a preferred draft.
    const leaves = compatible.filter(item => !dominated.has(item));
    if (leaves.length !== 1 || !edges.length) return null;
    const visited = new Set(), active = new Set();
    const walk = identity => {
        if (active.has(identity)) return false;
        if (visited.has(identity)) return true;
        active.add(identity);
        for (const edge of edges.filter(edge => edge.childIdentitySha256 === identity)) if (!walk(edge.parentIdentitySha256)) return false;
        active.delete(identity); visited.add(identity); return true;
    };
    if (!walk(repair.hashDraft(leaves[0].identity)) || visited.size !== compatible.length) return null;
    return { selected: leaves[0], edges };
}
function restoredMigrationAncestor(directory, child) {
    const repair = require('./reader-repair'), record = (child.payload.diagnosticFailureStateRestorations || [])
        .find(item => item.identitySha256 === repair.hashDraft(child.identity));
    if (!record) return null;
    const fields = ['noProgress','failureSignature','validationFailureStreak','validationFailureSignature'];
    if (record.contract !== 'reader-unfunded-diagnostic-state-restoration-v1'
        || !Array.isArray(record.archiveChain) || !record.archiveChain.length || record.archiveChain.length > 32
        || record.migrationAuditSha256 !== repair.hashDraft(child.payload.readerRecoveryRevisions?.at(-1))
        || fields.some(key => !isDeepStrictEqual(child.payload[key], record.originalFailureState?.[key])))
        throw new Error('Reader restored migration proof does not bind the current failure state');
    let node = child; const archives = [], visited = new Set(), at = Date.parse(record.restoredAt);
    if (!Number.isFinite(at)) throw new Error('Reader state restoration date is invalid');
    for (const [index, link] of record.archiveChain.entries()) {
        const audit = node.payload.readerRecoveryRevisions?.at(-1);
        if (!audit || audit.toIdentitySha256 !== repair.hashDraft(node.identity)
            || audit.contract !== 'reader-recovery-diagnostics-revision-v1' || audit.scope !== 'fresh-run'
            || audit.paperId !== child.identity.paperId || audit.runId !== child.identity.freshAnalysis?.runId
            || !/^[a-f0-9]{64}$/.test(audit.fromIdentitySha256 || '')
            || !new RegExp(`^${audit.fromIdentitySha256}\\.migrated-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.json$`).test(audit.archivedName || '')
            || visited.has(audit.archivedName) || link.archivedName !== audit.archivedName
            || link.originalEnvelopeSha256 !== audit.oldEnvelopeSha256 || link.originalPayloadSha256 !== audit.oldPayloadSha256
            || link.migrationAuditSha256 !== repair.hashDraft(audit)) throw new Error('Reader state restoration archive chain drift');
        visited.add(audit.archivedName);
        const checked = readProof(path.join(directory, audit.archivedName), audit.oldEnvelopeSha256), env = checked.value;
        const parent = { name: audit.archivedName, identity: env.identity, payload: env.payload, envelopeSha256: checked.sha256 };
        const changed = [...new Set([...Object.keys(parent.identity || {}), ...Object.keys(node.identity)])]
            .filter(key => !isDeepStrictEqual(parent.identity?.[key], node.identity[key])).sort();
        if (env.version !== repair.REPAIR_VERSION || env.payloadSha256 !== repair.hashDraft(parent.payload)
            || repair.hashDraft(parent.identity) !== audit.fromIdentitySha256 || repair.hashDraft(parent.payload) !== audit.oldPayloadSha256
            || !sameInput(parent.identity, node.identity) || !isDeepStrictEqual([...audit.changedFields].sort(), changed)
            || changed.some(key => !IMPLEMENTATION_FIELDS.has(key))
            || ['attempts','fullAttempts','transportFailures'].some(key => (node.payload[key] || 0) !== (parent.payload[key] || 0)
                || audit[key] !== (parent.payload[key] || 0))
            || parent.payload.implementationRepairAllowanceProof || node.payload.implementationRepairAllowanceProof
            || parent.payload.implementationRepairAllowanceLineage !== repair.IMPLEMENTATION_ALLOWANCE_LINEAGE_CONTRACT
            || node.payload.implementationRepairAllowanceLineage !== parent.payload.implementationRepairAllowanceLineage
            || audit.oldNoProgress !== parent.payload.noProgress || audit.oldFailureSignature !== parent.payload.failureSignature
            || audit.inputDraftSha256 !== repair.hashDraft(parent.payload.draft) || audit.outputDraftSha256 !== repair.hashDraft(node.payload.draft)
            || audit.inputDraftSha256 !== audit.outputDraftSha256 || !Number.isFinite(Date.parse(audit.revisedAt))
            || !isDeepStrictEqual(parent.payload.explicitReaderRetryRound, node.payload.explicitReaderRetryRound))
            throw new Error('Reader state restoration does not preserve original input, draft and budget');
        if (index === record.archiveChain.length - 1) {
            if (audit.clearedNoProgress !== true || fields.some(key => !isDeepStrictEqual(parent.payload[key], record.originalFailureState[key])))
                throw new Error('Reader state restoration original failure state drift');
        } else if (audit.clearedNoProgress !== false || ['noProgress','validationFailureStreak'].some(key => parent.payload[key] !== 0)
            || ['failureSignature','validationFailureSignature'].some(key => parent.payload[key] !== '')
            || index > 0 && fields.some(key => !isDeepStrictEqual(parent.payload[key], node.payload[key])))
            throw new Error('Reader intermediate restoration archive changed failure state');
        archives.push({ ...parent, restorationMigrationAt: Date.parse(audit.revisedAt) }); node = parent;
    }
    if (!/^[a-f0-9-]{36}\.json$/.test(record.latestUsageFileName || '')) throw new Error('Reader restoration fee filename is invalid');
    const file = path.join(require('../config').FILES.llmUsageDir, record.latestUsageFileName), usage = readProof(file, record.latestUsageSha256), event = usage.value;
    const eventAt = Date.parse(event.at);
    if (event.version !== 'llm-usage-v1' || event.kind !== 'request' || event.eventId !== record.latestUsageEventId
        || event.paperId !== child.identity.paperId || event.runId !== child.identity.freshAnalysis.runId
        || !['apiReaderRepair','apiReaderArticle'].includes(event.stage) || event.contentAttempt !== child.payload.attempts
        || event.model !== child.identity.model.model || event.protocol !== child.identity.model.protocol
        || !Number.isFinite(eventAt) || eventAt > at || archives.some(item => eventAt > item.restorationMigrationAt))
        throw new Error('Reader restoration does not bind its original real fee');
    return { parent: node, archives, feeFile: file, feeSha256: usage.sha256, record };
}
// Only original envelopes named by a direct, byte-bound migration audit enter this graph.
function archivedMigrationGraph(directory, compatible, normalizeReplayDraft, paidBoundary) {
    const repair = require('./reader-repair'), nodes = [...compatible], edges = [], examined = new Set(), restorationFees = [], paidFrontiers = [];
    const retained = ['attempts', 'fullAttempts', 'transportFailures', 'noProgress', 'failureSignature',
        'validationFailureStreak', 'validationFailureSignature', 'implementationRepairAllowanceProof'];
    function visit(child, stack) {
        if (stack.has(child.name)) throw new Error('Circular Reader archived migration');
        if (examined.has(child.name)) return;
        const next = new Set(stack).add(child.name);
        const last = child.payload.readerRecoveryRevisions?.at(-1), request = paidBoundary?.request.value;
        // A later paid request consumes the migration output. Its resulting draft
        // and counters are checked against that real response below.
        if (last?.clearedNoProgress === false && request && isDeepStrictEqual(request.identity, child.identity)
            && child.payload.attempts === request.contentAttempt && child.payload.attempts > last.attempts
            && request.draftSha256 === last.outputDraftSha256
            && Number.isFinite(Date.parse(last.revisedAt)) && Date.parse(request.at) > Date.parse(last.revisedAt)) {
            if (!/^[a-f0-9]{64}\.migrated-[a-f0-9-]{36}\.json$/.test(last.archivedName || '')
                || !last.archivedName.startsWith(last.fromIdentitySha256 + '.migrated-')) throw new Error('Invalid paid migration frontier');
            const archived = readProof(path.join(directory, last.archivedName), last.oldEnvelopeSha256), envelope = archived.value;
            const changed = [...new Set([...Object.keys(envelope.identity || {}), ...Object.keys(child.identity)])]
                .filter(key => !isDeepStrictEqual(envelope.identity?.[key], child.identity[key])).sort();
            if (envelope.version !== repair.REPAIR_VERSION || !envelope.payload || !sameInput(envelope.identity, child.identity)
                || envelope.payloadSha256 !== repair.hashDraft(envelope.payload)
                || last.contract !== 'reader-recovery-diagnostics-revision-v1' || last.scope !== 'fresh-run'
                || last.runId !== child.identity.freshAnalysis?.runId || last.paperId !== child.identity.paperId
                || last.toIdentitySha256 !== repair.hashDraft(child.identity) || last.fromIdentitySha256 !== repair.hashDraft(envelope.identity)
                || last.oldPayloadSha256 !== repair.hashDraft(envelope.payload) || !Array.isArray(last.changedFields)
                || !isDeepStrictEqual([...last.changedFields].sort(), changed) || changed.some(key => !IMPLEMENTATION_FIELDS.has(key))
                || ['attempts','fullAttempts','transportFailures'].some(key => last[key] !== (envelope.payload[key] || 0)
                    || (child.payload[key] || 0) < (envelope.payload[key] || 0))
                || last.inputDraftSha256 !== repair.hashDraft(envelope.payload.draft)
                || last.oldNoProgress !== envelope.payload.noProgress || last.oldFailureSignature !== envelope.payload.failureSignature)
                throw new Error('Paid migration frontier original evidence changed');
            if (last.inputDraftSha256 !== last.outputDraftSha256) {
                const normalized = normalizeReplayDraft(structuredClone(envelope.payload.draft),
                    structuredClone(envelope.payload.issues), structuredClone(envelope.payload.imageEvidence || []));
                if (repair.hashDraft(normalized?.draft || normalized) !== request.draftSha256)
                    throw new Error('Paid migration input draft cannot be replayed');
            }
            if (!nodes.some(node => node.name === last.archivedName)) nodes.push({ name: last.archivedName,
                identity: envelope.identity, payload: envelope.payload, envelopeSha256: archived.sha256 });
            paidFrontiers.push({ identitySha256: repair.hashDraft(child.identity), archivedName: last.archivedName,
                oldEnvelopeSha256: archived.sha256, migrationAuditSha256: repair.hashDraft(last),
                migrationAttempts: last.attempts, actualPaidAttempts: request.contentAttempt, requestSha256: paidBoundary.request.sha256 });
            examined.add(child.name); return;
        }
        const restoration = restoredMigrationAncestor(directory, child);
        if (restoration) {
            for (const archive of restoration.archives) if (!nodes.some(node => node.name === archive.name)) nodes.push(archive);
            const parent=nodes.find(node=>node.name===restoration.parent.name);
            edges.push({parent,child,audit:{inputDraftSha256:repair.hashDraft(parent.payload.draft),outputDraftSha256:repair.hashDraft(child.payload.draft)},
                restorationProofSha256:repair.hashDraft(restoration.record)});
            restorationFees.push([restoration.feeFile,restoration.feeSha256]);visit(parent,next);examined.add(child.name);return;
        }
        for (const audit of child.payload.readerRecoveryRevisions || []) {
            if (audit.toIdentitySha256 !== repair.hashDraft(child.identity)) continue;
            const existingAllowance = audit.clearedNoProgress === true && repair.hasUnusedImplementationAllowance(child.payload);
            if (audit.clearedNoProgress !== false && !existingAllowance) continue;
            if (existingAllowance) repair.validateImplementationAllowance(child.payload, child.identity, directory);
            if (!/^[a-f0-9]{64}\.migrated-[a-f0-9-]{36}\.json$/.test(audit.archivedName || '')
                || !audit.archivedName.startsWith(audit.fromIdentitySha256 + '.migrated-')) throw new Error('Invalid Reader archive name');
            const checked = readProof(path.join(directory, audit.archivedName), audit.oldEnvelopeSha256), envelope = checked.value;
            const parent = { name: audit.archivedName, identity: envelope.identity, payload: envelope.payload, envelopeSha256: checked.sha256 };
            if (envelope.version !== repair.REPAIR_VERSION || !parent.identity || !parent.payload || envelope.payloadSha256 !== repair.hashDraft(parent.payload)
                || repair.hashDraft(parent.identity) !== audit.fromIdentitySha256
                || repair.hashDraft(parent.payload) !== audit.oldPayloadSha256) throw new Error('Reader archived envelope drift');
            const changedFields = [...new Set([...Object.keys(parent.identity), ...Object.keys(child.identity)])]
                .filter(field => !isDeepStrictEqual(parent.identity[field], child.identity[field])).sort();
            if (audit.contract !== 'reader-recovery-diagnostics-revision-v1' || audit.scope !== 'fresh-run'
                || audit.paperId !== child.identity.paperId || audit.runId !== child.identity.freshAnalysis?.runId
                || !sameInput(parent.identity, child.identity) || !isDeepStrictEqual([...audit.changedFields].sort(), changedFields)
                || changedFields.some(field => !IMPLEMENTATION_FIELDS.has(field))
                || ['attempts', 'fullAttempts', 'transportFailures'].some(key => audit[key] !== (parent.payload[key] || 0))
                || retained.filter(key => !existingAllowance || ['attempts','fullAttempts','transportFailures'].includes(key))
                    .some(key => !isDeepStrictEqual(parent.payload[key], child.payload[key]))
                || existingAllowance && (child.payload.noProgress !== 0 || child.payload.failureSignature !== ''
                    || child.payload.validationFailureStreak !== 0 || child.payload.validationFailureSignature !== ''
                    || audit.oldNoProgress !== parent.payload.noProgress || audit.oldFailureSignature !== parent.payload.failureSignature)
                || audit.inputDraftSha256 !== repair.hashDraft(parent.payload.draft)
                || audit.outputDraftSha256 !== repair.hashDraft(child.payload.draft)) throw new Error('Reader archived migration does not preserve input and budget');
            if (audit.inputDraftSha256 !== audit.outputDraftSha256) {
                const sourceBlocked = require('./reader-source-blocked-normalization');
                const normalized = normalizeReplayDraft(structuredClone(parent.payload.draft),
                    structuredClone(parent.payload.issues), structuredClone(parent.payload.imageEvidence || []));
                const draft = normalized?.draft || normalized;
                if (normalized?.contract === sourceBlocked.CONTRACT || repair.hashDraft(draft) !== audit.outputDraftSha256)
                    throw new Error('Reader archived migration draft cannot be deterministically replayed');
            }
            const existing = nodes.find(node => node.name === parent.name);
            if (existing && existing.envelopeSha256 !== parent.envelopeSha256) throw new Error('Conflicting Reader archive');
            const actual = existing || parent;
            if (!existing) nodes.push(actual);
            edges.push({ parent: actual, child, audit }); visit(actual, next);
        }
        examined.add(child.name);
    }
    try { for (const child of compatible) visit(child, new Set()); }
    catch (error) { return null; }
    return { nodes, edges, restorationFees, paidFrontiers, descendant(parent) {
        const reached = new Set(), visiting = new Set();
        function walk(node) {
            if (visiting.has(node)) throw new Error('Circular Reader descendants');
            if (reached.has(node)) return;
            visiting.add(node); reached.add(node);
            for (const edge of edges.filter(edge => edge.parent === node)) walk(edge.child);
            visiting.delete(node);
        }
        try { walk(parent); } catch (error) { return null; }
        const leaves = [...reached].filter(node => !edges.some(edge => edge.parent === node));
        return leaves.length === 1 && compatible.includes(leaves[0]) ? { selected: leaves[0],
            edges: edges.filter(edge => reached.has(edge.parent)).map(edge => ({ fromIdentitySha256: repair.hashDraft(edge.parent.identity),
                toIdentitySha256: repair.hashDraft(edge.child.identity), archivedName: edge.parent.name,
                oldEnvelopeSha256: edge.parent.envelopeSha256, oldPayloadSha256: repair.hashDraft(edge.parent.payload),
                inputDraftSha256: edge.audit.inputDraftSha256, outputDraftSha256: edge.audit.outputDraftSha256,
                ...(edge.restorationProofSha256?{restorationProofSha256:edge.restorationProofSha256}:{}) })) } : null;
    } };
}
function replayRepair(request, response, payload, source, normalizeReplayDraft, allowExactArchivedDraft = false) {
    const repair = require('./reader-repair');
    const targetsValid = () => {
        if (!Array.isArray(request.repairTargets) || request.repairTargets.length < 1 || request.repairTargets.length > 8) return false;
        const seen = [];
        for (const target of request.repairTargets) {
            if (typeof target?.path !== 'string' || seen.some(pointer => target.path === pointer
                || target.path.startsWith(pointer + '/') || pointer.startsWith(target.path + '/'))) return false;
            const match = /^\/(readerTitle|oneSentenceThesis|conceptBridges|sections|tableBindings|formulaBindings|figurePlacements)(?:\/(0|[1-9]\d*)(?:\/(body|explanation))?)?$/.exec(target.path);
            if (!match || (match[3] && !((match[1] === 'sections' && match[3] === 'body')
                || (match[1] === 'conceptBridges' && match[3] === 'explanation')))) return false;
            let value = request.draft?.[match[1]];
            if (match[2] !== undefined) {
                if (!Array.isArray(value) || Number(match[2]) >= value.length) return false;
                value = value[Number(match[2])];
            }
            if (match[3] !== undefined) value = value?.[match[3]];
            if (value === undefined || target.oldSha256 !== repair.hashDraft(value) || !isDeepStrictEqual(value, target.value)) return false;
            seen.push(target.path);
        }
        return true;
    };
    if (request.actualRepairPromptContract || request.sectionGroupPlanContract
        || request.draft === null || !request.draft || !Array.isArray(request.repairTargets)
        || !targetsValid() || (request.images !== undefined && !Array.isArray(request.images))) return null;
    let output;
    try {
        const raw = String(response.rawResponse || '');
        const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
        const first = raw.indexOf('{'), last = raw.lastIndexOf('}');
        const text = fenced ? fenced[1] : first >= 0 && last > first ? raw.slice(first, last + 1) : raw;
        const patch = repair.parseReaderPatchJson(text);
        output = repair.applyReaderPatch(structuredClone(request.draft), patch, request.repairTargets.map(target => target.path), {
            rejectUnchanged: payload.issues.some(issue => ['reader_workflow_leakage', 'reader_awkward_translation'].includes(issue.code)
                && request.repairTargets.some(target => target.path === issue.path)),
            atomicOperation: request.atomicOperation,
            availableFigureOrdinals: (request.images || []).filter(image => image.kind === 'figure').map(image => image.ordinal),
            sourceText: source.text, structuredArtifacts: source.structuredArtifacts
        });
    } catch (error) {
        // A rejected response consumes its recorded content attempt but leaves the real request draft.
        if (repair.hashDraft(request.draft) !== repair.hashDraft(payload.draft)) return null;
        return { kind: 'rejected-response-original-draft', draftSha256: repair.hashDraft(payload.draft) };
    }
    if (allowExactArchivedDraft && repair.hashDraft(output) === repair.hashDraft(payload.draft))
        return { kind: 'applied-response-exact-archived-draft', draftSha256: repair.hashDraft(output) };
    const historical = () => {
        const replay = require('./reader-historical-draft-normalizer-replay').replayHistoricalDraftNormalizer(
            output, request.identity, source, repair.hashDraft(payload.draft));
        return replay ? { kind: 'applied-response-bound-historical-normalization', draftSha256: repair.hashDraft(payload.draft),
            historicalNormalization: replay.proof } : null;
    };
    const sourceBlocked = require('./reader-source-blocked-normalization');
    let normalized;
    try {
        normalized = normalizeReplayDraft(structuredClone(output), structuredClone(payload.issues), structuredClone(payload.imageEvidence || []));
    } catch (error) {
        normalized = sourceBlocked.readSourceTableNormalizationError(error, output, source.structuredArtifacts);
        if (!normalized) throw error;
    }
    const blocked = normalized?.contract === sourceBlocked.CONTRACT
        ? sourceBlocked.assertBlockedNormalizationResult(normalized, source.structuredArtifacts) : null;
    const draft = normalized?.draft || normalized;
    if (blocked) {
        if (repair.hashDraft(output) !== repair.hashDraft(payload.draft)) return historical();
        return { kind: 'applied-response-blocked-source-table', draftSha256: repair.hashDraft(output),
            preparedDraftSha256: repair.hashDraft(blocked.draft),
            blockingIssuesSha256: repair.hashDraft(blocked.blockingIssues), blockingIssues: blocked.blockingIssues };
    }
    if (!draft || repair.hashDraft(draft) !== repair.hashDraft(payload.draft)) return historical();
    return { kind: 'applied-response-production-normalization', draftSha256: repair.hashDraft(draft) };
}
function resolveCompatibleCandidates(directory, identity, compatible, options = {}) {
    const fresh = require('./fresh-analysis-context');
    const context = fresh.getFreshAnalysisContext();
    const repair = require('./reader-repair');
    const engine = require('../analysis-engine');
    const requireLatestPaidResponse = options.requireLatestPaidResponse === true;
    if (compatible.length < (requireLatestPaidResponse ? 1 : 2) || !fresh.isDailyFreshSourceScope() || !context?.refreshReaderDiagnostics
        || compatible.some(candidate => !sameInput(candidate.identity, identity))
        || !engine.paperAnalysisLockHeld({ arxivId: identity.paperId })) return null;
    const currentSource = require('./model-text-sanitization').currentModelInputSourceForPaperId(identity.paperId);
    if (!currentSource || repair.shaText(currentSource.text) !== identity.sourceSha256
        || !isDeepStrictEqual(fresh.freshAnalysisIdentity(identity.paperId), identity.freshAnalysis)) return null;
    const dominance = requireLatestPaidResponse ? null : migrationDominance(compatible);
    if (dominance) return { selected: dominance.selected, proof: { contract: CONTRACT, mode: 'verified-migration-descendant',
        selectedIdentitySha256: repair.hashDraft(dominance.selected.identity), edges: dominance.edges,
        retainedAttempts: dominance.selected.payload.attempts, retainedFullAttempts: dominance.selected.payload.fullAttempts,
        retainedTransportFailures: dominance.selected.payload.transportFailures || 0 }, assertUnchanged() {
        for (const candidate of compatible) readProof(path.join(directory, candidate.name), candidate.envelopeSha256);
    } };
    if (typeof options.normalizeReplayDraft !== 'function') return null;
    const globalLatest = latestReaderRequest(require('../config').FILES.llmUsageDir, identity.paperId, context.runId);
    let inputLatest;
    try { inputLatest = latestReaderRequestForInput(directory, identity, globalLatest); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const usage = inputLatest?.usage;
    const event = usage?.value;
    if (!event || event.version !== 'llm-usage-v1' || event.stage !== 'apiReaderRepair'
        || event.outcome !== 'completed' || event.statusCode !== 200 || event.protocol !== identity.model?.protocol
        || event.model !== identity.model?.model || event.usage?.status !== 'reported'
        || !Number.isSafeInteger(event.usage.totalTokens) || event.usage.totalTokens <= 0) return null;
    let diagnostics;
    try { diagnostics = safeDirectory(path.join(directory, 'request-diagnostics')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const graph = archivedMigrationGraph(directory, compatible, options.normalizeReplayDraft, inputLatest.binding);
    if (!graph) return null;
    const matches = [];
    for (const name of fs.readdirSync(diagnostics).filter(name => /^[a-f0-9-]{36}\.request\.json$/.test(name))) {
        const requestFile = path.join(diagnostics, name), request = readProof(requestFile);
        const req = request.value;
        if (req.contract !== 'reader-repair-request-diagnostics-v1' || req.contentAttempt !== event.contentAttempt
            || !/^[a-f0-9-]{36}$/.test(req.id || '') || name !== req.id + '.request.json') continue;
        const roots = graph.nodes.filter(candidate => isDeepStrictEqual(req.identity, candidate.identity) && candidate.payload.attempts === req.contentAttempt);
        if (roots.length !== 1) continue;
        const recorded = roots[0], lineage = graph.descendant(recorded);
        const selected = lineage?.selected;
        if (!selected || selected.payload.attempts !== req.contentAttempt || !selected.payload.draft) continue;
        const responseFile = path.join(diagnostics, req.id + '.response.json');
        let response;
        try { response = readProof(responseFile); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const res = response.value;
        if (res.outputTextSha256 !== event.outputTextSha256) continue;
        if (name !== req.id + '.request.json' || req.promptSha256 !== repair.shaText(req.prompt)
            || req.draftSha256 !== repair.hashDraft(req.draft) || res.contract !== req.contract || res.id !== req.id
            || res.requestSha256 !== request.sha256 || res.outputTextSha256 !== repair.shaText(res.rawResponse)) return null;
        const requestAt = Date.parse(req.at), responseAt = Date.parse(res.at);
        if (!Number.isFinite(requestAt) || !Number.isFinite(responseAt) || requestAt > responseAt
            || usage.at < requestAt || Math.abs(usage.at - responseAt) > 30000) return null;
        const replay = replayRepair(req, res, recorded.payload, currentSource, options.normalizeReplayDraft, !compatible.includes(recorded));
        if (!replay) return null;
        matches.push({ selected, recorded, lineage, request, response, requestFile, responseFile, replay });
    }
    if (matches.length !== 1) return null;
    const match = matches[0];
    const proof = { contract: CONTRACT, mode: 'latest-real-paid-response', selectedIdentitySha256: repair.hashDraft(match.selected.identity),
        selectedEnvelopeSha256: match.selected.envelopeSha256, selectedPayloadSha256: repair.hashDraft(match.selected.payload),
        requestFileName: path.basename(match.requestFile), requestSha256: match.request.sha256,
        responseFileName: path.basename(match.responseFile), responseSha256: match.response.sha256,
        usageFileName: path.basename(usage.file), usageFileSha256: usage.sha256, usageEventId: event.eventId,
        usageAt: event.at, contentAttempt: event.contentAttempt, outputTextSha256: event.outputTextSha256,
        replay: match.replay, actualInputFingerprint: identity.inputFingerprint,
        ...(globalLatest?.value.eventId !== event.eventId ? { globalLatestOtherInputUsageFileName: path.basename(globalLatest.file),
            globalLatestOtherInputUsageSha256: globalLatest.sha256 } : {}),
        archivedAncestorIdentitySha256: repair.hashDraft(match.recorded.identity),
        archivedMigrationEdges: match.lineage.edges, paidMigrationFrontiers: graph.paidFrontiers, retainedAttempts: match.selected.payload.attempts,
        retainedFullAttempts: match.selected.payload.fullAttempts, retainedTransportFailures: match.selected.payload.transportFailures || 0,
        preservedCandidateIdentities: compatible.map(candidate => repair.hashDraft(candidate.identity)).sort() };
    return { selected: match.selected, proof, assertUnchanged() {
        for (const [file, sha256] of inputLatest.snapshots) readProof(file, sha256);
        if (match.replay.historicalNormalization) require('./reader-historical-draft-normalizer-replay')
            .assertHistoricalNormalizerProof(match.replay.historicalNormalization);
        for (const [file,sha256] of graph.restorationFees) readProof(file,sha256);
        for (const candidate of graph.nodes) readProof(path.join(directory, candidate.name), candidate.envelopeSha256);
        for (const [file, sha] of [[match.requestFile, match.request.sha256], [match.responseFile, match.response.sha256], [usage.file, usage.sha256]])
            readProof(file, sha);
        if (!engine.paperAnalysisLockHeld({ arxivId: identity.paperId })
            || repair.shaText(require('./model-text-sanitization').currentModelInputSourceForPaperId(identity.paperId).text) !== identity.sourceSha256)
            throw new Error('Reader replay source or paper lock changed before migration');
    } };
}
module.exports = { CONTRACT, sameInput, latestReaderRequest, resolveCompatibleCandidates, replayRepair };
