'use strict';

// 只保存真实修复请求与响应，不授予正文或发布资格。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function syncDirectory(directoryPath) {
    const fd = fs.openSync(directoryPath, 'r');
    let failure;
    try { fs.fsyncSync(fd); }
    catch (error) { failure = error; throw error; }
    finally { try { fs.closeSync(fd); } catch (error) { if (!failure) throw error; } }
}
function directory(root) {
    const absolute = path.resolve(root, 'request-diagnostics');
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        let created = false;
        try { fs.mkdirSync(cursor, { mode: 0o700 }); created = true; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (created) syncDirectory(path.dirname(cursor));
        const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('长文修复记录目录必须是真实目录');
    }
    return absolute;
}
function write(directoryPath, filename, payload) {
    const bytes = JSON.stringify(payload, null, 2) + '\n';
    const file = path.join(directoryPath, filename);
    const fd = fs.openSync(file, 'wx', 0o600);
    let failure;
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    catch (error) { failure = error; throw error; }
    finally {
        try { fs.closeSync(fd); } catch (error) { if (!failure) throw error; }
    }
    syncDirectory(directoryPath);
    return { path: file, sha256: sha(bytes) };
}
function begin(root, context, options = {}) {
    const repair = require('./reader-repair');
    let metadataOperation;
    if (context?.atomicOperation?.kind === repair.READER_VERSION_METADATA_KIND) {
        // Live source/lock authority is an out-of-band argument; never serialize
        // the whole paper or infer authority from a copied request context.
        const actual = readReaderVersionMetadataOrigin({ directory: root, paper: options.paper,
            identity: context.identity, rawDraft: context.rawDraft });
        vmNeed(options.versionMetadataOrigin?.file === actual.file
            && options.versionMetadataOrigin.sha256 === actual.sha256, 'diagnostic lacks the actual origin capability');
        metadataOperation = repair.buildReaderVersionMetadataRepairContext(context.rawDraft);
    } else metadataOperation = repair.buildTopLevelMetadataRepairContext(context?.rawDraft);
    const metadataRepairValid = metadataOperation
        && JSON.stringify(metadataOperation) === JSON.stringify(context.atomicOperation)
        && context.draft === null && Array.isArray(context.repairTargets) && context.repairTargets.length === 0
        && context.draftSha256 === metadataOperation.rawSha256;
    if (typeof context?.prompt !== 'string' || !Array.isArray(context.repairTargets)
        || (!metadataRepairValid && context.draftSha256 !== sha(JSON.stringify(context.draft)))) {
        throw new Error('长文修复记录必须对应当前真实草稿和修复上下文');
    }
    const id = crypto.randomUUID();
    const dir = directory(root);
    const request = { ...context, contract: 'reader-repair-request-diagnostics-v1', id,
        at: new Date().toISOString(), promptSha256: sha(context.prompt) };
    const receipt = write(dir, `${id}.request.json`, request);
    return { id, directory: dir, requestSha256: receipt.sha256 };
}
function response(diagnostic, rawResponse) {
    if (typeof rawResponse !== 'string') throw new Error('长文修复记录只保存真实响应文本');
    return write(diagnostic.directory, `${diagnostic.id}.response.json`, {
        contract: 'reader-repair-request-diagnostics-v1', id: diagnostic.id,
        at: new Date().toISOString(), requestSha256: diagnostic.requestSha256,
        outputTextSha256: sha(rawResponse), rawResponse
    });
}
function guarded(action) {
    try { return action(); }
    catch (cause) {
        const error = new Error(`长文修复记录无法保存：${cause.message}`, { cause });
        error.code = 'READER_DIAGNOSTIC_FAILED';
        error.retryable = false;
        error.scope = 'run';
        throw error;
    }
}
const beginReaderRepairDiagnostic = (root, context, options) => guarded(() => begin(root, context, options));
const saveReaderRepairResponse = (diagnostic, raw) => guarded(() => response(diagnostic, raw));
const CORE_CONTRACT = 'core-summary-request-diagnostics-v1';
function beginCoreSummaryDiagnostic(root, context) {
    return guarded(() => {
        if (!context || typeof context.prompt !== 'string'
            || typeof context.inputAnalysis !== 'string' || typeof context.sourceText !== 'string'
            || typeof context.evidenceText !== 'string' || !context.identity
            || context.identity.inputAnalysisSha256 !== sha(context.inputAnalysis)
            || context.identity.sourceTextSha256 !== sha(context.sourceText)
            || context.identity.evidenceSha256 !== sha(context.evidenceText)) {
            throw new Error('摘要修复记录必须绑定真实来源、输入和证据');
        }
        const id = crypto.randomUUID();
        const dir = directory(root);
        const receipt = write(dir, `${id}.request.json`, { ...context,
            contract: CORE_CONTRACT, id, at: new Date().toISOString(),
            promptSha256: sha(context.prompt) });
        return { id, directory: dir, requestSha256: receipt.sha256, contract: CORE_CONTRACT };
    });
}
function saveCoreSummaryResponse(record, rawResponse) {
    return guarded(() => {
        if (typeof rawResponse !== 'string') throw new Error('摘要修复记录只保存真实响应');
        return write(record.directory, `${record.id}.response.json`, {
            contract: CORE_CONTRACT, id: record.id, requestSha256: record.requestSha256,
            at: new Date().toISOString(), outputTextSha256: sha(rawResponse), rawResponse
        });
    });
}
function saveCoreSummaryDisposition(record, disposition) {
    return guarded(() => {
        if (!['request_failed', 'rejected', 'validated'].includes(disposition?.status)
            || (disposition.status !== 'request_failed'
                && !/^[a-f0-9]{64}$/.test(String(disposition.outputTextSha256))))
            throw new Error('摘要修复结果记录格式无效');
        return write(record.directory, `${record.id}.disposition.json`, {
            ...disposition, contract: CORE_CONTRACT, id: record.id,
            requestSha256: record.requestSha256, at: new Date().toISOString()
        });
    });
}
function readCoreSummaryDiagnostic(root, id, expectedIdentity) {
    return guarded(() => {
        if (!/^[a-f0-9-]{36}$/.test(String(id))) throw new Error('摘要修复记录身份无效');
        const dir = path.resolve(root, 'request-diagnostics');
        let cursor = path.parse(dir).root;
        for (const part of dir.slice(cursor.length).split(path.sep).filter(Boolean)) {
            cursor = path.join(cursor, part);
            const stat = fs.lstatSync(cursor);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('摘要修复记录目录必须为真实目录');
        }
        const read = suffix => {
            const filename = path.join(dir, `${id}.${suffix}.json`);
            const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            let failure;
            try {
                const stat = fs.fstatSync(fd);
                if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024)
                    throw new Error('摘要修复记录必须为普通独立文件且不超过 64 MiB');
                const bytes = fs.readFileSync(fd);
                return { value: JSON.parse(bytes), sha256: sha(bytes) };
            } catch (error) { failure = error; throw error; }
            finally { try { fs.closeSync(fd); } catch (error) { if (!failure) throw error; } }
        };
        const request = read('request'); const response = read('response');
        const disposition = read('disposition');
        if (!['rejected', 'validated'].includes(disposition.value.status)
            || [request, response, disposition].some(item => item.value.contract !== CORE_CONTRACT || item.value.id !== id)
            || JSON.stringify(request.value.identity) !== JSON.stringify(expectedIdentity)
            || request.value.promptSha256 !== sha(request.value.prompt)
            || request.value.identity.inputAnalysisSha256 !== sha(request.value.inputAnalysis)
            || request.value.identity.sourceTextSha256 !== sha(request.value.sourceText)
            || request.value.identity.evidenceSha256 !== sha(request.value.evidenceText)
            || response.value.requestSha256 !== request.sha256
            || disposition.value.requestSha256 !== request.sha256
            || response.value.outputTextSha256 !== sha(response.value.rawResponse)
            || disposition.value.outputTextSha256 !== response.value.outputTextSha256)
            throw new Error('摘要修复记录与当前来源或输入不一致');
        return { request: request.value, response: response.value, disposition: disposition.value,
            fileSha256: { request: request.sha256, response: response.sha256, disposition: disposition.sha256 } };
    });
}
// Read-only discovery for an explicitly requested replay. The returned ID is
// only an index; the ordinary strict reader rechecks the complete original chain.
function latestCoreSummaryDiagnosticId(root, expectedIdentity) {
    return guarded(() => {
        const dir = path.resolve(root, 'request-diagnostics');
        const matching = [];
        const names = fs.readdirSync(dir).filter(name => /^[a-f0-9-]{36}\.request\.json$/.test(name)).sort();
        for (const name of names) {
            const fd = fs.openSync(path.join(dir, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            let request, requestSha256;
            try {
                const stat = fs.fstatSync(fd);
                if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw new Error('摘要修复索引必须为普通独立文件且不超过64MiB');
                const bytes = fs.readFileSync(fd); requestSha256 = sha(bytes);
                request = JSON.parse(bytes);
            } finally { fs.closeSync(fd); }
            if (JSON.stringify(request.identity) !== JSON.stringify(expectedIdentity)) continue;
            const id = name.slice(0, -'.request.json'.length);
            if (request.contract !== CORE_CONTRACT || request.id !== id
                || request.promptSha256 !== sha(request.prompt)
                || request.identity.inputAnalysisSha256 !== sha(request.inputAnalysis)
                || request.identity.sourceTextSha256 !== sha(request.sourceText)
                || request.identity.evidenceSha256 !== sha(request.evidenceText)) throw new Error('摘要原请求索引与其真实输入不一致');
            const time = Date.parse(request.at);
            if (!Number.isFinite(time)) throw new Error('摘要原请求时间无效');
            matching.push({ id, time, requestSha256 });
        }
        if (JSON.stringify(names) !== JSON.stringify(fs.readdirSync(dir).filter(name => /^[a-f0-9-]{36}\.request\.json$/.test(name)).sort())) throw new Error('摘要原请求集合在只读索引期间改变');
        matching.sort((a, b) => b.time - a.time);
        if (!matching.length || (matching.length > 1 && matching[0].time === matching[1].time)) throw new Error('当前完整摘要身份没有唯一最新的原付费响应');
        const latest = matching[0];
        const saved = readCoreSummaryDiagnostic(root, latest.id, expectedIdentity);
        if (saved.fileSha256.request !== latest.requestSha256) throw new Error('摘要原请求在索引与严格读取之间改变');
        if (JSON.stringify(names) !== JSON.stringify(fs.readdirSync(dir).filter(name => /^[a-f0-9-]{36}\.request\.json$/.test(name)).sort())) throw new Error('摘要原请求集合在严格读取期间改变');
        return latest.id;
    });
}
// New metadata recovery evidence only; no content/request allowance.
const VERSION_METADATA_PROOF = 'reader-paid-version-metadata-proof-v1';
const VM_FILE = /^[a-f0-9-]{36}\.json$/;
const vmHash = value => require('../deep-analyzer').stableFingerprint(value);
const vmCanonical = value => String(value || '').replace(/v\d+$/, '');
function vmNeed(value, message) { if (!value) throw Object.assign(new Error('Reader version metadata evidence: ' + message),
    { code: 'READER_VERSION_METADATA_EVIDENCE_INVALID', scope: 'run', category: 'config', retryable: false, modelRequestClassified: true }); }
function vmRead(file, expected) {
    const result = require('./reader-proof-read-scope').readReaderProofJson(file, { expectedSha256: expected });
    vmNeed((fs.statSync(file).mode & 0o777) === 0o600, 'private file mode differs');
    return result;
}
function vmSubdirectory(root, name, create) {
    const parent = path.resolve(root), result = path.join(parent, name);
    require('./fresh-rewrite-run').assertSafeDirectory(parent);
    if (create) {
        try { fs.mkdirSync(result, { mode: 0o700 }); syncDirectory(parent); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    if (fs.existsSync(result)) require('./fresh-rewrite-run').assertSafeDirectory(result);
    return result;
}
function vmSource(paper, identity, requireLock = false) {
    const fresh = require('./fresh-analysis-context'), Config = require('../config');
    const provenance = paper?.freshRewriteProvenance;
    vmNeed(provenance?.contract === 'fresh-source-analysis-v1'
        && vmHash(provenance) === vmHash(paper.analysisManifest?.freshRewriteProvenance), 'daily source provenance differs');
    const runDir = path.join(Config.FILES.dailyFreshSourceRunsDir, provenance.runId);
    const run = vmRead(path.join(runDir, 'run.json')).value;
    vmNeed(run.contract === fresh.DAILY_SOURCE_RUN_CONTRACT, 'not an actual daily run');
    const source = fresh.readFreshSource(runDir, paper, { runId: run.runId, sourceExpectations: run.sourceExpectations });
    vmNeed(['runId','sourceSha256','structuredArtifactsSha256','sourceSnapshotSha256','sourceGeneration','sourceManifestSha256']
        .every(key => provenance[key] === source.freshSourceDescriptor[key]), 'four-source identity differs');
    const attempts = path.join(runDir, 'reader-attempts');
    if (identity) vmNeed(identity.sourceSha256 === source.freshSourceDescriptor.sourceSha256
        && vmHash(identity.freshAnalysis) === vmHash(fresh.freshAnalysisIdentity(identity.paperId)), 'current identity differs');
    if (requireLock) vmNeed(fresh.isDailyFreshSourceScope()
        && require('../analysis-engine').paperAnalysisLockHeld(paper)
        && path.resolve(fresh.freshReaderAttemptsDirectory()) === path.resolve(attempts), 'actual daily source and paper lock required');
    return { source, attempts };
}
function vmLogical(identity) {
    const allowed = require('./reader-recovery-revision').ALLOWED_FIELDS;
    return Object.fromEntries(Object.entries(identity).filter(([key]) => !allowed.includes(key)
        || ['readerRecoveryEpochSha256','readerJsonRequestPolicy','promptSha256','repairPromptSha256'].includes(key)));
}
function vmFeeFiles(records) {
    const root = path.resolve(require('../config').FILES.llmUsageDir);
    return records.map(record => {
        vmNeed(path.dirname(path.resolve(record.file)) === root && VM_FILE.test(path.basename(record.file)), 'fee path is not the normal ledger');
        const read = vmRead(record.file, record.sha256);
        return { file: path.resolve(record.file), sha256: read.sha256, event: read.value };
    });
}
function vmPair(records, { identity, stage, contentAttempt, outputSha256, disposition, unitId, inputSha256 }) {
    const rows = vmFeeFiles(records), starts = rows.filter(row => row.event.kind === 'request_started');
    const ends = rows.filter(row => row.event.kind === 'request');
    const dispositions = rows.filter(row => row.event.kind === 'disposition');
    vmNeed(rows.length === starts.length + ends.length + dispositions.length && starts.length >= 1 && starts.length <= 2
        && ends.length === starts.length && dispositions.length === 1, 'fee starts/terminals/disposition are incomplete or ambiguous');
    const labels = ['runId','paperId','stage','unitId','contentAttempt','transportAttempt','protocol','model','inputSha256'];
    for (const row of starts) {
        const matches = ends.filter(end => end.event.eventId === row.event.eventId);
        vmNeed(matches.length === 1 && labels.every(key => (matches[0].event[key] ?? null) === (row.event[key] ?? null))
            && Date.parse(matches[0].event.at) > Date.parse(row.event.at), 'request-start and terminal do not pair');
    }
    vmNeed(rows.every(({ event }) => event.version === 'llm-usage-v1' && event.runId === identity.freshAnalysis.runId
        && event.paperId === identity.paperId && event.stage === stage && event.contentAttempt === contentAttempt), 'paid request identity differs');
    vmNeed(starts.every(({ event }) => event.model === identity.model.model && event.protocol === identity.model.protocol
        && /^[a-f0-9]{64}$/.test(event.inputSha256 || '') && (unitId === undefined || event.unitId === unitId)
        && (inputSha256 === undefined || event.inputSha256 === inputSha256)), 'paid model/input/diagnostic binding differs');
    const success = ends.filter(({ event }) => event.outcome === 'completed' && event.statusCode === 200
        && event.outputTextSha256 === outputSha256 && event.usage?.status === 'reported');
    vmNeed(success.length === 1 && ends.filter(row => row !== success[0]).every(({ event }) =>
        event.outcome === 'transport_error' && event.outputTextSha256 === null), 'unique completed response is missing');
    const final = dispositions[0].event;
    vmNeed(final.disposition === disposition && final.outputTextSha256 === outputSha256
        && Date.parse(final.at) >= Date.parse(success[0].event.at), 'disposition does not bind the paid output');
    return rows.map(({ file, sha256 }) => ({ file, sha256 }));
}
function vmOriginFile(directoryPath, paperId, rawSha256, create = false) {
    vmNeed(/^\d{4}\.\d{4,5}$/.test(vmCanonical(paperId)) && /^[a-f0-9]{64}$/.test(rawSha256), 'origin identity is invalid');
    return path.join(vmSubdirectory(directoryPath, 'version-metadata-origins', create), vmCanonical(paperId) + '-' + rawSha256 + '.json');
}
function prepareReaderVersionMetadataOrigin({ directory: directoryPath, paper, identity, candidateFile, usageFiles }) {
    const repair = require('./reader-repair'), bound = vmSource(paper, identity, true);
    vmNeed(path.resolve(directoryPath) === path.resolve(bound.attempts)
        && path.dirname(path.resolve(candidateFile)) === path.resolve(directoryPath)
        && path.basename(candidateFile) === repair.hashDraft(identity) + '.json', 'origin candidate path differs');
    const candidate = vmRead(candidateFile), envelope = candidate.value, payload = envelope.payload;
    vmNeed(repair.hashDraft(envelope.identity) === repair.hashDraft(identity)
        && envelope.payloadSha256 === repair.hashDraft(payload) && payload.status === 'failed'
        && payload.draft === null && payload.attempts >= 1 && payload.fullAttempts >= 1, 'origin is not the actual failed paid full candidate');
    const operation = repair.buildReaderVersionMetadataRepairContext(payload.rawDraft);
    vmNeed(operation, 'origin raw is not the complete unsupported-version family');
    const fees = vmPair(usageFiles, { identity, stage: 'apiReaderArticle', contentAttempt: payload.attempts,
        outputSha256: operation.rawSha256, disposition: 'rejected' });
    const origin = { contract: VERSION_METADATA_PROOF, kind: 'original_paid_full', paperId: identity.paperId,
        sourceDescriptor: bound.source.freshSourceDescriptor, logicalIdentity: vmLogical(identity),
        wholeSha256: sha(paper.analysisCheckpoint || paper.analysis || ''), rawSha256: operation.rawSha256,
        candidateFile: path.resolve(candidateFile), candidateEnvelopeSha256: candidate.sha256,
        candidateRawBase64: candidate.bytes.toString('base64'), operation, fees,
        originalCounters: Object.fromEntries(['attempts','fullAttempts','transportFailures','noProgress','validationFailureStreak'].map(key => [key, payload[key] || 0])),
        newPermissions: 0, newRequests: 0 };
    const target = vmOriginFile(directoryPath, identity.paperId, operation.rawSha256, true);
    if (fs.existsSync(target)) {
        vmNeed(vmHash(vmRead(target).value) === vmHash(origin), 'a different origin already exists');
        return { file: target, sha256: vmRead(target).sha256 };
    }
    return write(path.dirname(target), path.basename(target), origin);
}
function readReaderVersionMetadataOrigin({ directory: directoryPath, paper, identity, rawDraft }) {
    const bound = vmSource(paper, identity, true);
    vmNeed(path.resolve(directoryPath) === path.resolve(bound.attempts), 'origin directory differs');
    const record = vmRead(vmOriginFile(directoryPath, identity.paperId, sha(rawDraft))), origin = record.value;
    const bytes = Buffer.from(origin.candidateRawBase64 || '', 'base64'), envelope = JSON.parse(bytes);
    vmNeed(origin.contract === VERSION_METADATA_PROOF && origin.kind === 'original_paid_full'
        && origin.rawSha256 === sha(rawDraft) && sha(bytes) === origin.candidateEnvelopeSha256
        && envelope.payload.rawDraft === rawDraft && vmHash(origin.sourceDescriptor) === vmHash(bound.source.freshSourceDescriptor)
        && vmHash(origin.logicalIdentity) === vmHash(vmLogical(identity))
        && origin.wholeSha256 === sha(paper.analysisCheckpoint || paper.analysis || ''), 'original paid raw/source/input differs');
    vmPair(origin.fees, { identity: envelope.identity, stage: 'apiReaderArticle', contentAttempt: envelope.payload.attempts,
        outputSha256: origin.rawSha256, disposition: 'rejected' });
    return { file: record.file || vmOriginFile(directoryPath, identity.paperId, sha(rawDraft)), sha256: record.sha256 };
}
function findReaderVersionMetadataOrigin(input) {
    // The shared metadata builder remains legacy-only. A complete v4 response
    // does not authorize this protocol without an explicitly prepared origin.
    if (!require('./fresh-analysis-context').isDailyFreshSourceScope()
        || !require('../analysis-engine').paperAnalysisLockHeld(input.paper)) return null;
    const bound = vmSource(input.paper, input.identity, true);
    vmNeed(path.resolve(input.directory) === path.resolve(bound.attempts), 'origin directory differs');
    const file = vmOriginFile(input.directory, input.identity.paperId, sha(input.rawDraft));
    if (!fs.existsSync(file)) return null;
    const origin = readReaderVersionMetadataOrigin(input);
    const original = vmRead(origin.file, origin.sha256).value;
    const repair = require('./reader-repair');
    const envelope = vmRead(path.join(input.directory, repair.hashDraft(input.identity) + '.json')).value;
    vmNeed(envelope.version === repair.REPAIR_VERSION && vmHash(envelope.identity) === vmHash(input.identity)
        && envelope.payloadSha256 === repair.hashDraft(envelope.payload)
        && envelope.payload.rawDraft === input.rawDraft && envelope.payload.fullAttempts === original.originalCounters.fullAttempts,
        'current metadata candidate differs from the fixed original full');
    if (envelope.payload.attempts !== original.originalCounters.attempts) {
        throw Object.assign(new Error('Reader 版本元数据首版只允许原付费全文之后一次逻辑确认；已用内容响应和未用余额均保留，未派发额外请求。'),
            { code: 'READER_VERSION_METADATA_SINGLE_ACK_EXHAUSTED', scope: 'paper', retryable: false });
    }
    return origin;
}
function buildReaderVersionMetadataRecoveryProof({ directory: directoryPath, paper, identity, origin, diagnostic, response,
    transportRecords, dispositionRecords, repairedRaw }) {
    const requestFile = path.join(diagnostic.directory, diagnostic.id + '.request.json');
    const request = vmRead(requestFile, diagnostic.requestSha256), req = request.value;
    vmNeed(req.identity && vmHash(req.identity) === vmHash(identity), 'new metadata request identity differs');
    const actualOrigin = readReaderVersionMetadataOrigin({ directory: directoryPath, paper, identity, rawDraft: req.rawDraft });
    vmNeed(origin.file === actualOrigin.file && origin.sha256 === actualOrigin.sha256, 'metadata origin locator differs');
    const res = vmRead(response.path, response.sha256);
    vmNeed(res.value.id === req.id && res.value.requestSha256 === request.sha256
        && res.value.outputTextSha256 === sha(res.value.rawResponse) && req.promptSha256 === sha(req.prompt)
        && req.draft === null && req.repairTargets.length === 0 && req.images.length === 0
        && req.draftSha256 === sha(req.rawDraft), 'metadata request/response context differs');
    const repair = require('./reader-repair');
    const bodySha256 = vmMetadataBody(req, identity);
    const replayed = repair.applyTopLevelMetadataRepair(req.rawDraft, repair.parseReaderVersionMetadataPatch(res.value.rawResponse), req.atomicOperation);
    vmNeed(replayed === repairedRaw && req.atomicOperation.kind === repair.READER_VERSION_METADATA_KIND, 'ACK does not reproduce the exact version-only result');
    const fees = vmPair([...transportRecords, ...dispositionRecords], { identity, stage: 'apiReaderRepair',
        contentAttempt: req.contentAttempt, outputSha256: res.value.outputTextSha256, disposition: 'accepted', unitId: sha(req.id), inputSha256: bodySha256 });
    return { contract: VERSION_METADATA_PROOF, origin, identity, request: { file: requestFile, sha256: request.sha256 },
        response: { file: response.path, sha256: response.sha256 }, fees,
        beforeRawSha256: sha(req.rawDraft), afterRawSha256: sha(replayed), operation: req.atomicOperation,
        contentAttempt: req.contentAttempt, newContentResponses: 1, newFullResponses: 0 };
}
function vmMetadataBody(req, identity) {
    const cfg = req.metadataRequestConfig, messages = req.metadataInputMessages;
    vmNeed(cfg && cfg.model === identity.model.model && cfg.protocol === identity.model.protocol
        && cfg.maxTokens === identity.repairMaxTokens && cfg.temperature === identity.repairTemperature
        && Array.isArray(messages) && messages.length === 1 && messages[0].role === 'user'
        && Array.isArray(messages[0].content) && messages[0].content.length === 2
        && messages[0].content.every(block => block.type === 'text' && typeof block.text === 'string')
        && messages[0].content[0].text === req.prompt && messages[0].content[1].text === req.visibilityNotice
        && sha(JSON.stringify(messages)) === req.inputMessagesSha256, 'metadata zero-image messages/config differ');
    const expected = require('../utils').buildRequestBody(cfg.protocol, cfg.model,
        require('../deep-analyzer').sanitizeModelMessages(messages), cfg.maxTokens, cfg.temperature,
        { usageContext: { stage: 'apiReaderRepair' }, readerResponseFormat: cfg.readerResponseFormat ?? undefined,
            readerThinkingMode: cfg.readerThinkingMode ?? undefined });
    vmNeed(vmHash(expected) === vmHash(req.metadataRequestBody), 'metadata provider body cannot replay from exact prompt/messages');
    return sha(JSON.stringify(req.metadataRequestBody));
}
function vmRegistryFile(attempts, paper, create) {
    const articleSha256 = sha(paper.apiReaderArticle || '');
    return path.join(vmSubdirectory(attempts, 'version-metadata-completions', create), vmCanonical(paper.arxivId) + '-' + articleSha256 + '.json');
}
function vmIndexFile(attempts, paper, create) {
    vmNeed(/^\d{4}\.\d{4,5}$/.test(vmCanonical(paper.arxivId)), 'stable index paper identity differs');
    return path.join(vmSubdirectory(attempts, 'version-metadata-completion-index', create), vmCanonical(paper.arxivId) + '.json');
}
function vmStageCore(stage) {
    const { versionMetadataRecoveryContract, versionMetadataRecoveryProof, ...core } = stage || {};
    return core;
}
function sealReaderVersionMetadataCompletion(paper, pending) {
    const bound = vmSource(paper, pending.identity, true), stage = paper.analysisManifest.stages.apiReaderArticle;
    const filename = vmRegistryFile(bound.attempts, paper, true);
    let registry;
    if (fs.existsSync(filename)) {
        registry = vmRead(filename);
        const { refreshedAt: oldAt, ...oldCore } = registry.value.stageCore;
        const { refreshedAt: newAt, ...newCore } = vmStageCore(stage);
        vmNeed(vmHash(oldCore) === vmHash(newCore) && vmHash(registry.value.pending) === vmHash(pending), 'existing completion stage differs');
        // Reuse the actual first finalization time after a failed outer save.
        stage.refreshedAt = oldAt;
    } else {
        const record = { contract: VERSION_METADATA_PROOF, paperId: paper.arxivId,
            sourceDescriptor: bound.source.freshSourceDescriptor, pending,
            articleSha256: sha(paper.apiReaderArticle), planSha256: vmHash(paper.apiReaderPlan), stageCore: vmStageCore(stage) };
        write(path.dirname(filename), path.basename(filename), record);
        registry = vmRead(filename);
    }
    stage.versionMetadataRecoveryContract = VERSION_METADATA_PROOF;
    stage.versionMetadataRecoveryProof = { file: filename, sha256: registry.sha256 };
    paper.analysisManifest.contracts.readerVersionMetadataRecovery = VERSION_METADATA_PROOF;
    const indexFile = vmIndexFile(bound.attempts, paper, true);
    const index = { contract: VERSION_METADATA_PROOF, kind: 'stable_source_paper_completion_index', paperId: paper.arxivId,
        sourceDescriptor: bound.source.freshSourceDescriptor, origin: pending.origin,
        completion: { file: filename, sha256: registry.sha256 } };
    if (fs.existsSync(indexFile)) vmNeed(vmHash(vmRead(indexFile).value) === vmHash(index),
        'future completion is not an authorized supersession of the stable original metadata index');
    else write(path.dirname(indexFile), path.basename(indexFile), index);
}
function validateReaderVersionMetadataCompletion(paper) {
    const stage = paper.analysisManifest?.stages?.apiReaderArticle;
    const marker = paper.analysisManifest?.contracts?.readerVersionMetadataRecovery;
    if (paper.freshRewriteProvenance?.contract !== 'fresh-source-analysis-v1') {
        vmNeed(!marker && !stage?.versionMetadataRecoveryContract && !stage?.versionMetadataRecoveryProof,
            'metadata recovery cannot move outside its daily source');
        return true;
    }
    const attempts = path.join(require('../config').FILES.dailyFreshSourceRunsDir, paper.freshRewriteProvenance.runId, 'reader-attempts');
    if (!fs.existsSync(attempts)) {
        vmNeed(!marker && !stage?.versionMetadataRecoveryContract && !stage?.versionMetadataRecoveryProof, 'metadata registry directory is missing');
        return true;
    }
    const indexFile = vmIndexFile(attempts, paper, false);
    if (!fs.existsSync(indexFile)) {
        vmNeed(!marker && !stage?.versionMetadataRecoveryContract && !stage?.versionMetadataRecoveryProof,
            'completion marker/proof has no immutable registry');
        return true;
    }
    const bound = vmSource(paper);
    const index = vmRead(indexFile).value;
    vmNeed(index.contract === VERSION_METADATA_PROOF && index.kind === 'stable_source_paper_completion_index'
        && index.paperId === paper.arxivId && vmHash(index.sourceDescriptor) === vmHash(bound.source.freshSourceDescriptor)
        && path.dirname(index.completion?.file || '') === vmSubdirectory(attempts, 'version-metadata-completions', false)
        && /^[a-f0-9]{64}$/.test(index.completion.sha256 || ''), 'stable paper/source index differs');
    const filename = index.completion.file;
    const registry = vmRead(filename, index.completion.sha256), record = registry.value, locator = stage?.versionMetadataRecoveryProof;
    vmNeed(marker === VERSION_METADATA_PROOF && stage?.versionMetadataRecoveryContract === VERSION_METADATA_PROOF
        && locator?.file === filename && locator.sha256 === registry.sha256, 'completion proof/marker was removed or changed');
    vmNeed(record.contract === VERSION_METADATA_PROOF && record.paperId === paper.arxivId
        && path.basename(filename) === vmCanonical(paper.arxivId) + '-' + record.articleSha256 + '.json'
        && vmHash(record.sourceDescriptor) === vmHash(bound.source.freshSourceDescriptor)
        && record.articleSha256 === sha(paper.apiReaderArticle) && record.articleSha256 === stage.articleSha256
        && record.planSha256 === vmHash(paper.apiReaderPlan) && record.planSha256 === stage.planSha256
        && vmHash(record.stageCore) === vmHash(vmStageCore(stage)), 'normal final source/article/plan/stage differs');
    const pending = record.pending;
    vmNeed(pending.origin.file === vmOriginFile(bound.attempts, paper.arxivId, pending.beforeRawSha256), 'cold origin fixed path differs');
    const origin = vmRead(pending.origin.file, pending.origin.sha256);
    const envelopeBytes = Buffer.from(origin.value.candidateRawBase64, 'base64'), envelope = JSON.parse(envelopeBytes);
    vmNeed(origin.value.contract === VERSION_METADATA_PROOF && origin.value.kind === 'original_paid_full'
        && sha(envelopeBytes) === origin.value.candidateEnvelopeSha256
        && envelope.version === require('./reader-repair').REPAIR_VERSION
        && envelope.payloadSha256 === require('./reader-repair').hashDraft(envelope.payload)
        && origin.value.wholeSha256 === sha(paper.analysisCheckpoint || paper.analysis || '')
        && origin.value.rawSha256 === pending.beforeRawSha256 && sha(envelope.payload.rawDraft) === pending.beforeRawSha256
        && vmHash(origin.value.sourceDescriptor) === vmHash(bound.source.freshSourceDescriptor)
        && vmHash(origin.value.logicalIdentity) === vmHash(vmLogical(envelope.identity))
        && vmHash(origin.value.logicalIdentity) === vmHash(vmLogical(pending.identity)), 'cold original raw/source identity differs');
    vmPair(origin.value.fees, { identity: envelope.identity, stage: 'apiReaderArticle', contentAttempt: envelope.payload.attempts,
        outputSha256: pending.beforeRawSha256, disposition: 'rejected' });
    const req = vmRead(pending.request.file, pending.request.sha256), res = vmRead(pending.response.file, pending.response.sha256);
    vmNeed(path.dirname(pending.request.file) === path.join(bound.attempts, 'request-diagnostics')
        && path.dirname(pending.response.file) === path.join(bound.attempts, 'request-diagnostics')
        && path.basename(pending.request.file) === req.value.id + '.request.json'
        && path.basename(pending.response.file) === req.value.id + '.response.json'
        && req.value.contract === 'reader-repair-request-diagnostics-v1' && res.value.contract === req.value.contract
        && req.value.contentAttempt === envelope.payload.attempts + 1 && pending.contentAttempt === req.value.contentAttempt
        && stage.attempts === pending.contentAttempt && stage.fullAttempts === envelope.payload.fullAttempts
        && stage.transportFailures >= (envelope.payload.transportFailures || 0)
        && req.value.promptSha256 === sha(req.value.prompt) && req.value.draft === null
        && req.value.rawDraft === envelope.payload.rawDraft && req.value.draftSha256 === pending.beforeRawSha256
        && req.value.repairTargets.length === 0 && req.value.images.length === 0
        && vmHash(req.value.identity) === vmHash(pending.identity)
        && res.value.id === req.value.id && res.value.requestSha256 === req.sha256
        && res.value.outputTextSha256 === sha(res.value.rawResponse), 'cold metadata diagnostic chain differs');
    const bodySha256 = vmMetadataBody(req.value, pending.identity);
    const repair = require('./reader-repair');
    const replayed = repair.applyTopLevelMetadataRepair(req.value.rawDraft, repair.parseReaderVersionMetadataPatch(res.value.rawResponse), req.value.atomicOperation);
    vmNeed(sha(replayed) === pending.afterRawSha256 && vmHash(req.value.atomicOperation) === vmHash(pending.operation)
        && pending.operation.kind === repair.READER_VERSION_METADATA_KIND, 'cold metadata ACK cannot reproduce exact version-only bytes');
    vmPair(pending.fees, { identity: pending.identity, stage: 'apiReaderRepair', contentAttempt: pending.contentAttempt,
        outputSha256: res.value.outputTextSha256, disposition: 'accepted', unitId: sha(req.value.id), inputSha256: bodySha256 });
    const deep = require('../deep-analyzer'), evidence = deep.buildApiReaderEvidenceContext('', bound.source.text, bound.source.structuredArtifacts, paper.arxivId);
    const parsed = deep.parseApiReaderArticleResult(replayed, { arxivId: paper.arxivId,
        availableFigureOrdinals: (envelope.payload.imageEvidence || []).filter(image => image.kind === 'figure').map(image => image.ordinal),
        requireIntegratedTables: true, minimumIntegratedTables: require('./reader-contract').readerRequirements({ version: 3,
            availableTableCount: [...evidence.matchAll(/^TABLE_(\d+):/gm)].length }).minimumTables,
        requiredVersion: 3, requireSourceBindings: true, allowDeterministicQuoteRepair: true,
        allowDeterministicUnsupportedClaimPruning: true, enforceResourceAvailabilityClaims: true,
        verifiedResourceIdentity: deep.replayVerifiedReaderResourceIdentity(paper.apiReaderResources, bound.source.text),
        sourceText: bound.source.text, structuredArtifacts: bound.source.structuredArtifacts });
    const final = deep.replayApiReaderFinalDisplay(parsed, bound.source, paper.apiReaderFigures, paper.arxivId);
    vmNeed(final.article === paper.apiReaderArticle && vmHash(final.plan) === vmHash(paper.apiReaderPlan), 'cold full parser/display differs');
    return true;
}

// Publication resumes do not enter the analysis scheduler's saved-source
// scopes. Recreate those exact scopes only for this new metadata protocol.
function validateReaderVersionMetadataPublicationCompletion(paper) {
    const stage = paper.analysisManifest?.stages?.apiReaderArticle;
    const hasMarker = Boolean(paper.analysisManifest?.contracts?.readerVersionMetadataRecovery
        || stage?.versionMetadataRecoveryContract || stage?.versionMetadataRecoveryProof);
    const provenance = paper.freshRewriteProvenance;
    const fresh = require('./fresh-analysis-context'), Config = require('../config');
    const safeRunId = /^[a-f0-9-]{36}$/.test(provenance?.runId || '');
    const runFile = safeRunId
        ? path.join(Config.FILES.dailyFreshSourceRunsDir, provenance.runId, 'run.json') : null;
    const run = runFile && fs.existsSync(runFile) ? vmRead(runFile).value : null;
    const actualDaily = run?.contract === fresh.DAILY_SOURCE_RUN_CONTRACT;
    // Conference/historical direct sources may use the same fresh-source
    // provenance contract. A caller's missing arxivId is not the daily test.
    if (!actualDaily) {
        vmNeed(!hasMarker, 'version metadata completion cannot move outside its actual daily run');
        return true;
    }
    vmNeed(provenance?.contract === 'fresh-source-analysis-v1' && run.runId === provenance.runId
        && /^\d{4}\.\d{4,5}(?:v\d+)?$/.test(paper.arxivId || '')
        && run.paperIds?.filter(id => vmCanonical(id) === vmCanonical(paper.arxivId)).length === 1,
        'actual daily publication requires its canonical paper identity');
    const attempts = path.join(path.dirname(runFile), 'reader-attempts');
    const indexed = fs.existsSync(attempts) && fs.existsSync(vmIndexFile(attempts, paper, false));
    if (!indexed && !hasMarker) return validateReaderVersionMetadataCompletion(paper);
    const local = require('./conference-source-resource-correction');
    const route = local.isSourceCorrectionRecord(paper)
        ? local : require('./conference-reader-operator-correction');
    return require('./analysis-stop-control').withModelRequestsForbidden(() => route.withSavedPaper(paper, () =>
        require('./reader-dom-span-projection').withSavedPaper(paper, () =>
        require('./reader-table-pdf-evidence').withSavedPaper(paper, () =>
        require('./reader-sealed-pdf-quote-evidence').withSavedPaper(paper, () =>
        require('./reader-source-table-column-units').withSavedPaper(paper, () =>
        require('./reader-authenticated-pdf-table-evidence').withSavedPaper(paper, () =>
            validateReaderVersionMetadataCompletion(paper))))))));
}

module.exports = { validateReaderVersionMetadataPublicationCompletion, findReaderVersionMetadataOrigin, prepareReaderVersionMetadataOrigin, readReaderVersionMetadataOrigin, buildReaderVersionMetadataRecoveryProof, sealReaderVersionMetadataCompletion, validateReaderVersionMetadataCompletion, beginReaderRepairDiagnostic, saveReaderRepairResponse,
    beginCoreSummaryDiagnostic, saveCoreSummaryResponse, saveCoreSummaryDisposition,
    readCoreSummaryDiagnostic, latestCoreSummaryDiagnosticId };
