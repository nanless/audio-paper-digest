'use strict';

// 已完成来源升级进程可能同时保留原抽取与升级抽取。按原分析实际绑定的
// 计划重放全部上游，不能将统一的新计划当作所有已完成论文的原来源。
const fs = require('node:fs');
const path = require('node:path');
const codec = require('./protocol-codec');
const os = require('node:os');
const crypto = require('node:crypto');
const api = require('./conference-process');
const recovery = require('./conference-process-recovery');
const extraction = require('./conference-extraction-receipt');
const SHA_RE = /^[a-f0-9]{64}$/;

function withOriginalPlanFile(filename, receipt, deps, callback) {
    const loaded = deps.ledger.readRegularJson(filename);
    if (loaded.sha256 === receipt.planSha256) return callback(filename);
    // 旧标签维护曾直接更改计划中的词表字段。只有恢复该字段就能得到原凭证
    // 精确绑定的全部原字节时，才在系统临时目录只读重放；现有计划保持不动。
    deps.plan.normalizeSecureReceipt(receipt);
    const plan = deps.plan.normalizePlan(loaded.value);
    if (codec.format(plan.contract, 'conference-run-plan', plan.schemaFingerprint)
        !== codec.format(receipt.contract, 'conference-run-plan-secure-receipt', receipt.schemaFingerprint)
        || codec.isCurrentHeader(plan, 'conference-run-plan') !== codec.isCurrentHeader(receipt, 'conference-run-plan-secure-receipt')) {
        throw new Error('原会议计划的格式语义或原头命名空间不同，不能重放。');
    }
    const field = Object.hasOwn(plan, 'taxonomy') ? 'taxonomy' : 'tagMetadata';
    const original = { ...loaded.value, [field]: deps.plan.tagMetadataForReceipt(receipt) };
    const bytes = api.canonicalBytes(original);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== receipt.planSha256) {
        throw new Error('原会议计划文件字节缺失，不能仅按原词表字段重放同一 SHA。');
    }
    const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-retained-plan-'));
    fs.chmodSync(temporary, 0o700);
    const originalFile = path.join(temporary, path.basename(filename));
    try {
        fs.writeFileSync(originalFile, bytes, { mode: 0o600, flag: 'wx' });
        return callback(originalFile);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function readCompletion(state, directory, deps) {
    const names = fs.readdirSync(directory).filter(name =>
        name === 'completion-receipt.json' || /^completion-receipt-[a-f0-9]{16}(?:-\d+)?\.json$/.test(name));
    const candidates = names.map(name => deps.ledger.readRegularJson(path.join(directory, name)).value)
        .filter(receipt => receipt.processId === state.processId);
    for (const receipt of candidates) {
        const { receiptSha256, ...body } = receipt;
        if (receiptSha256 !== api.stableHash(body)
            || !codec.hasValidHeader(receipt, 'conference-process-completion-receipt')
            || codec.format(receipt.contract, 'conference-process-completion-receipt', receipt.schemaFingerprint) !== api.processFormat(state)
            || codec.isCurrentHeader(receipt, 'conference-process-completion-receipt') !== codec.isCurrentHeader(state, 'conference-process')) {
            throw new Error('保留的会议完成凭证版本或 SHA 不一致。');
        }
    }
    const currentItems = Object.values(state.items);
    const projections = new Map(currentItems.map(item => [item.paperId, completionItemProjections(item, deps, new Set(), directory)]));
    const matching = candidates.filter(receipt =>
        api.stableHash(receipt.sourceUpgradePromotion) === api.stableHash(state.sourceUpgradePromotion)
        && Array.isArray(receipt.items) && receipt.items.length === currentItems.length
        && new Set(receipt.items.map(item => item.paperId)).size === currentItems.length
        && receipt.items.every(item => projections.get(item.paperId)?.some(expected =>
            api.stableHash(expected) === api.stableHash(completionItem(item))))
        && api.stableHash(withoutImplementation(receipt.authority, api.processFormat(state)))
            === api.stableHash(withoutImplementation(state.authority, api.processFormat(state))));
    const active = matching.find(receipt => receipt.receiptSha256 === state.completionReceiptSha256);
    if (state.status === 'complete') {
        if (!active) throw new Error('已完成会议缺少与当前状态对应的原完成凭证。');
        return api.validateCompletionReceipt(state, active);
    }
    // 显式实现迁移可能已更新暂存页后中断。这里只接受原分析及来源完全相同的
    // 已归档完成凭证；新页面仍须重新正常暂存、汇总、审查，不能沿用旧页面通过状态。
    if (!matching.length) throw new Error('实现迁移恢复缺少与原完成稿连续链对应的会议完成凭证。');
    if (new Set(matching.map(item => item.planReceiptSha256)).size !== 1) {
        throw new Error('实现迁移恢复对应多个不同的原完成计划。');
    }
    // 全部候选均已逐项归到同一不可变父链；优先最近一层，避免重复迁移时误阻断。
    return matching.sort((left, right) => {
        const distance = receipt => receipt.items.reduce((sum, item) => sum + projections.get(item.paperId)
            .findIndex(expected => api.stableHash(expected) === api.stableHash(completionItem(item))), 0);
        return distance(left) - distance(right) || left.receiptSha256.localeCompare(right.receiptSha256);
    })[0];
}

function completionItem({ paperId, analysisRunId, sourceProof, analysisProof }) {
    return { paperId, analysisRunId, sourceProof, analysisProof };
}
function analysisProof(loaded) {
    return { analysisSha256: loaded.analysisFileSha256,
        completionReceiptSha256: loaded.run.completionReceipt?.receiptSha256,
        sourceSnapshotSha256: loaded.run.sourceSnapshotSha256 };
}
// Completion receipt projection authenticates original source/CAS ancestry only.
// Ordinary revisions must not replay today's Reader rules against old ancestors;
// the actual current Reader is still fully qualified during normal staging.
function sourceIdentityReaderRevision(executionId, deps) {
    const options = { analysisRoot: deps.files.conferenceAnalysisDir, executionId };
    const initial = deps.adapter.loadConferenceAnalysis(options);
    const record = deps.adapter.readJsonRecord(path.join(initial.directory, 'reader-revision.json'));
    return codec.hasValidHeader(record.value, 'conference-reader-recovery-window')
        ? deps.adapter.loadConferenceReaderRevision(options)
        : deps.adapter.loadConferenceReaderRevisionIdentity(options);
}
function completionItemProjections(item, deps, sourceAncestors = new Set(), directory = null) {
    const result = [completionItem(item)];
    if (item.sourceResourceCorrectionAdoption) {
        if (sourceAncestors.has(item.analysisRunId) || sourceAncestors.size >= 16) {
            throw new Error('来源纠正原完成凭证投影循环或超过16层。');
        }
        const next = new Set(sourceAncestors); next.add(item.analysisRunId);
        const original = require('./conference-source-resource-correction')
            .readPreviousSourceIdentityItem(item);
        return [...result, ...completionItemProjections(original, deps, next, directory)];
    }
    if (item.reviewReanalysisAdoption && directory) {
        if (sourceAncestors.has(item.analysisRunId) || sourceAncestors.size >= 16) {
            throw new Error('审查重分析原完成凭证投影循环或超过16层。');
        }
        const adoption = item.reviewReanalysisAdoption;
        const receiptFile = adoption.receiptFile;
        if (typeof receiptFile !== 'string' || !/^review-reanalysis-adoption-[a-f0-9-]+-[a-f0-9]{12}\.json$/.test(receiptFile)) {
            throw new Error('保留的审查重分析采纳回执文件名不合法。');
        }
        const loaded = deps.ledger.readRegularJson(path.join(directory, receiptFile));
        const receipt = loaded.value;
        const { receiptSha256, ...body } = receipt;
        if (receiptSha256 !== adoption.receiptSha256
            || receiptSha256 !== api.stableHash(body)
            || receipt.paperId !== item.paperId
            || receipt.newExecutionId !== adoption.newExecutionId
            || receipt.previousExecutionId !== adoption.previousExecutionId
            || !receipt.previousItem || typeof receipt.previousItem !== 'object'
            || api.stableHash(receipt.previousItem) !== adoption.previousItemSha256) {
            throw new Error('保留的审查重分析采纳回执与当前成员原凭证不一致。');
        }
        const next = new Set(sourceAncestors); next.add(item.analysisRunId);
        return [...result, ...completionItemProjections(receipt.previousItem, deps, next, directory)];
    }
    if (!item.readerRevision) return result;
    let current = sourceIdentityReaderRevision(item.analysisRunId, deps);
    if (api.stableHash(current.revision) !== api.stableHash(item.readerRevision)
        || current.run.status !== 'complete' || current.analysis.status !== 'complete'
        || api.stableHash(analysisProof(current)) !== api.stableHash(item.analysisProof)) {
        throw new Error('保留的会议 Reader 修订与当前成员原凭证不一致。');
    }
    const seen = new Set([current.run.executionId]);
    for (let depth = 0; depth < 16; depth += 1) {
        const parent = current.parent;
        if (seen.has(parent.run.executionId)) throw new Error('保留的会议 Reader 修订父链循环。');
        seen.add(parent.run.executionId);
        result.push({ paperId: item.paperId, analysisRunId: parent.run.executionId,
            sourceProof: item.sourceProof, analysisProof: analysisProof(parent) });
        if (!fs.existsSync(path.join(parent.directory, 'reader-revision.json'))) return result;
        current = sourceIdentityReaderRevision(parent.run.executionId, deps);
    }
    throw new Error('保留的会议 Reader 修订父链超过16层。');
}

function withoutImplementation(authority, version) {
    const result = api.authorityWithoutTagCatalog(authority, version);
    delete result.implementationSha256;
    return result;
}

function createRetainedSourceReplay(context, deps) {
    const files = deps.files;
    const prefix = `${context.authority.conferenceId}-${context.authority.selectionReceiptSha256.slice(0, 16)}-`;
    const receipts = new Map();
    for (const name of fs.readdirSync(files.conferenceRunsDir).filter(name =>
        name.startsWith(prefix) && name.endsWith('-run.plan-receipt.json'))) {
        const loaded = deps.ledger.readRegularJson(path.join(files.conferenceRunsDir, name));
        const receipt = loaded.value;
        if (!SHA_RE.test(receipt.receiptSha256 || '')) throw new Error('原会议计划凭证缺少有效 SHA。');
        if (receipts.has(receipt.receiptSha256)) throw new Error('同一原会议计划 SHA 对应多个文件。');
        receipts.set(receipt.receiptSha256, { name, ...loaded });
    }
    const plans = new Map();
    function loadPlan(receiptSha256) {
        if (plans.has(receiptSha256)) return plans.get(receiptSha256);
        const found = receipts.get(receiptSha256);
        if (!found) throw new Error('原分析绑定的会议计划凭证缺失。');
        const receipt = found.value;
        const runName = receipt.run?.name;
        if (!/^[a-z0-9][a-z0-9._-]{0,159}-run\.json$/.test(runName || '')
            || runName !== found.name.replace('.plan-receipt.json', '.json')
            || !runName.startsWith(prefix)) throw new Error('原会议计划凭证文件名或运行身份不一致。');
        const stem = runName.slice(0, -'-run.json'.length);
        const staging = deps.staging.loadStagingHandle(
            path.join(files.conferenceStagingDir, stem + '-import.json'),
            path.join(files.conferenceStagingDir, stem + '-staging-receipt.json'),
            context.selectionHandle, context.discoveryHandle, files.conferenceStagingSourceDir, { replay: false });
        const imported = deps.importer.loadImportHandle(
            path.join(files.conferenceSourceLedgerDir, stem + '-ledger.json'),
            path.join(files.conferenceSourceLedgerDir, stem + '-ledger.import-receipt.json'), staging);
        const planHandle = withOriginalPlanFile(path.join(files.conferenceSourceLedgerDir, stem + '-plan.json'),
            receipt, deps, planFile => deps.plan.loadPlanHandle(path.join(files.conferenceRunsDir, runName),
                path.join(files.conferenceRunsDir, found.name), planFile, imported, files.tagCatalogFile));
        const snapshot = deps.plan.planHandleReadOnlyAuthority(planHandle).snapshot;
        if (snapshot.receipt.receiptSha256 !== receiptSha256) throw new Error('原会议计划的完整重放 SHA 不一致。');
        const suffix = stem.slice(prefix.length);
        if (!/^[a-f0-9]{12}$/.test(suffix)) throw new Error('原会议来源命名空间格式无效。');
        const roots = fs.readdirSync(files.conferenceSourceCacheDir).filter(name =>
            /^generation-[a-f0-9]{64}$/.test(name) && name.startsWith('generation-' + suffix));
        if (roots.length !== 1) throw new Error('原会议来源缓存目录缺失或有多个候选。');
        const sourceRoot = path.join(files.conferenceSourceCacheDir, roots[0]);
        const stat = fs.lstatSync(sourceRoot);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('原会议来源缓存目录不安全。');
        const staged = deps.staging.stagingHandleSnapshot(staging, { replay: false });
        const sourceMembers = new Map(staged.receipt.members.map(member => [member.paperId, member]));
        const shared = { planHandle, sourceRoot, sourceCacheRoot: sourceRoot, sourceMembers,
            planReceiptSha256: receiptSha256 };
        plans.set(receiptSha256, shared);
        return shared;
    }
    function forItem(item) {
        const loaded = deps.adapter.loadConferenceAnalysis({ analysisRoot: files.conferenceAnalysisDir,
            executionId: item.analysisRunId });
        const proof = analysisProof(loaded);
        if (item.sourceResourceCorrectionAdoption || item.readerRevision
            || fs.existsSync(path.join(loaded.directory, 'reader-revision.json'))) {
            if (!item.sourceResourceCorrectionAdoption && !item.readerRevision) {
                throw new Error('保留的会议 Reader 子稿缺少当前成员修订凭证。');
            }
            completionItemProjections(item, deps);
        }
        if (loaded.run.status !== 'complete' || loaded.analysis.status !== 'complete'
            || loaded.run.paperId !== item.paperId
            || api.stableHash(proof) !== api.stableHash(item.analysisProof)) {
            throw new Error('保留的会议分析或完成凭证与原成员不一致。');
        }
        const binding = loaded.source.planAuthorityBinding;
        const shared = loadPlan(binding?.planReceiptSha256);
        const snapshot = deps.plan.planHandleReadOnlyAuthority(shared.planHandle).snapshot;
        if (snapshot.receiptFileSha256 !== binding.planReceiptFileSha256
            || snapshot.runFileSha256 !== binding.runFileSha256
            || snapshot.receipt.import.receiptSha256 !== binding.importReceiptSha256
            || binding.filterPolicySha256 !== context.authority.filterPolicySha256
            || binding.selectionReceiptSha256 !== context.authority.selectionReceiptSha256
            || binding.selectedMemberSetSha256 !== context.authority.selectedMemberSetSha256) {
            throw new Error('保留的会议分析未绑定原计划、导入或筛选凭证。');
        }
        deps.adapter.verifyPlanAuthority(loaded, shared.planHandle, shared.sourceRoot);
        verifyRetainedExtraction(item, shared.sourceMembers.get(item.paperId), deps);
        const source = loaded.source.sourceSnapshotBinding?.sourceBinding;
        if (!item.sourceProof || source?.pdfSha256 !== item.sourceProof.pdfSha256
            || source.textSha256 !== item.sourceProof.textSha256
            || source.artifactsFileSha256 !== item.sourceProof.artifactsSha256) {
            throw new Error('保留的会议分析与原成员来源 SHA 不一致。');
        }
        return shared;
    }
    return { loadPlan, forItem };
}

const RETAINED_ENHANCED_EXTRACTOR_PROFILES = Object.freeze([
    // Pre-38250016 (commit 1458254f) enhanced layout extractor before pdf_author_extract.py Mode F / header-boundary fix.
    Object.freeze({
        implementationSha256: 'e34d76ec0eecc776c4e0b6cce625f148d49638729b946f2a842ec1d1dee8e819',
        dependencySha256s: Object.freeze({
            'conference_layout_extractor.py': '89eb43d6d38e8c4b54589a0657adf8efbd4be57e2e49fe032ca4a8aa5adc31bd',
            'conference_extractor.py': '36254b211c07e4070c6b1ed805764ce04b2b63572907ab581d9b21b75f03406b',
            'pdf_figure_table_extract.py': '9ac8020f84599216c6123c4a56110c3d012d5863bb872927fa7ca2a7c306ea76',
            'pdf_author_extract.py': '84debbbeaad603738d60c1b3788b32cec03f02118aac6333e86116e7e1fbc27d'
        })
    })
]);

function matchingRetainedEnhancedProfile(receipt) {
    if (!receipt || typeof receipt !== 'object' || receipt.contract !== extraction.RECEIPT_ENHANCED_CONTRACT) return null;
    const ext = receipt.extractor;
    if (!ext || typeof ext !== 'object' || ext.contract !== extraction.EXTRACTOR_ENHANCED_CONTRACT
        || ext.name !== extraction.EXTRACTOR_ENHANCED_NAME
        || ext.backend?.name !== extraction.BACKEND_NAME
        || ext.backend?.version !== extraction.BACKEND_VERSION) return null;
    if (ext.implementationSha256 === extraction.EXTRACTOR_ENHANCED_IMPLEMENTATION_SHA256) return null;
    return RETAINED_ENHANCED_EXTRACTOR_PROFILES.find(profile =>
        ext.implementationSha256 === profile.implementationSha256
        && api.stableHash(ext.dependencySha256s) === api.stableHash(profile.dependencySha256s)
        && api.stableHash(ext.dependencySha256s) === profile.implementationSha256
    ) || null;
}

function retainedEnhancedSnapshot(root, receiptName, receipt, item, deps, profile) {
    if (receipt.status !== 'ready' || receipt.textReplayable !== true || receipt.blockedReason !== null) {
        throw new Error('原会议增强抽取凭证状态无效。');
    }
    const names = { receipt: receiptName, request: receipt.request?.file,
        metadata: receipt.source?.metadata?.file, pdf: receipt.source?.pdf?.file,
        text: receipt.text?.file, artifacts: receipt.artifacts?.file };
    if (Object.values(names).some(name => typeof name !== 'string'
        || !/^[a-z0-9][a-z0-9._-]{0,164}\.(?:json|pdf|txt)$/.test(name))) {
        throw new Error('原会议增强抽取文件名不安全。');
    }
    const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    const read = key => deps.discovery.safeAbsoluteFile(path.join(root, names[key]), `retained enhanced ${key}`, 256 * 1024 * 1024);
    const requestFile = read('request'), request = JSON.parse(requestFile.bytes), metadataFile = read('metadata'),
        pdf = read('pdf'), text = read('text'), artifacts = read('artifacts'), receiptFile = read('receipt');
    if (request.paperId !== item.paperId || request.sourceIdentity !== item.sourceIdentity
        || request.source?.metadata?.file !== names.metadata || request.source?.pdf?.file !== names.pdf
        || request.outputs?.textFile !== names.text || request.outputs?.artifactsFile !== names.artifacts
        || request.outputs?.receiptFile !== names.receipt || receipt.request?.file !== names.request
        || receipt.request?.sha256 !== sha(requestFile.bytes)
        || api.stableHash(request.source) !== api.stableHash(receipt.source)
        || request.source.metadata.sha256 !== sha(metadataFile.bytes) || request.source.pdf.sha256 !== sha(pdf.bytes)
        || receipt.text?.file !== names.text || receipt.text?.sha256 !== sha(text.bytes)
        || receipt.artifacts?.file !== names.artifacts || receipt.artifacts?.sha256 !== sha(artifacts.bytes)
        || receipt.text?.utf8Bytes !== text.bytes.length || pdf.bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
        throw new Error('原会议增强抽取来源字节或身份绑定漂移。');
    }
    const verification = { contract: extraction.VERIFICATION_ENHANCED_CONTRACT, status: 'verified',
        paperId: item.paperId, sourceIdentity: item.sourceIdentity, requestSha256: sha(requestFile.bytes),
        metadataSha256: sha(metadataFile.bytes), pdfSha256: sha(pdf.bytes), textSha256: sha(text.bytes),
        artifactsSha256: sha(artifacts.bytes), receiptFileSha256: sha(receiptFile.bytes),
        receiptSha256: receipt.receiptSha256 };
    verification.verificationSha256 = api.stableHash(verification);
    return { paperId: item.paperId, sourceIdentity: item.sourceIdentity, metadata: request.source.metadata,
        pdf: request.source.pdf,
        text: { sha256: sha(text.bytes), provenance: { extractor: extraction.EXTRACTOR_ENHANCED_NAME, implementationSha256: profile.implementationSha256 } },
        artifacts: { sha256: sha(artifacts.bytes), provenance: { extractor: extraction.EXTRACTOR_ENHANCED_NAME, implementationSha256: profile.implementationSha256 } },
        receipt: { receiptSha256: receipt.receiptSha256 }, verification };
}

function verifyRetainedExtraction(item, bound, deps) {
    if (!bound || !/^[a-z0-9][a-z0-9._-]{0,159}\.json$/.test(bound.extractionReceiptName || '')) {
        throw new Error('原会议暂存清单缺少本篇抽取凭证。');
    }
    const root = deps.files.conferenceStagingSourceDir;
    const loaded = deps.ledger.readRegularJson(path.join(root, bound.extractionReceiptName));
    const receipt = loaded.value;
    const { receiptSha256, ...body } = receipt;
    if (loaded.sha256 !== bound.extractionReceiptFileSha256 || receiptSha256 !== api.stableHash(body)
        || receiptSha256 !== bound.extractionReceiptSha256 || receipt.paperId !== item.paperId
        || receipt.sourceIdentity !== item.sourceIdentity) throw new Error('原会议抽取凭证身份或 SHA 不一致。');
    let snapshot;
    const retainedEnhanced = matchingRetainedEnhancedProfile(receipt);
    if (codec.hasValidHeader(receipt.extractor, 'conference-retained-pdf-extractor', 'version')) {
        const names = { receipt: bound.extractionReceiptName, request: receipt.request?.file,
            metadata: receipt.source?.metadata?.file, pdf: receipt.source?.pdf?.file,
            text: receipt.text?.file, artifacts: receipt.artifacts?.file };
        if (Object.values(names).some(name => typeof name !== 'string'
            || !/^[a-z0-9][a-z0-9._-]{0,164}\.(?:json|pdf|txt)$/.test(name))) {
            throw new Error('原会议抽取文件名不安全。');
        }
        snapshot = require('./conference-source-upgrade').retainedLegacySnapshot(root, names, receipt, item, deps);
    } else if (retainedEnhanced) {
        snapshot = retainedEnhancedSnapshot(root, bound.extractionReceiptName, receipt, item, deps, retainedEnhanced);
    } else {
        snapshot = extraction.extractionHandleSnapshot(extraction.loadExtractionHandle(root,
            bound.extractionReceiptName, { replay: false }));
    }
    const proof = { requestSha256: snapshot.verification.requestSha256,
        receiptSha256: snapshot.receipt.receiptSha256,
        verificationSha256: snapshot.verification.verificationSha256,
        textSha256: snapshot.text.sha256, artifactsSha256: snapshot.artifacts.sha256,
        pdfSha256: snapshot.pdf.sha256 };
    if (api.stableHash(proof) !== api.stableHash(item.sourceProof)
        || proof.verificationSha256 !== bound.extractionVerificationSha256
        || snapshot.metadata.sha256 !== bound.metadataSha256) {
        throw new Error('原会议抽取文件与原成员、暂存凭证的逐项 SHA 不一致。');
    }
}

function replayCompletedPromotedShared({ context, state, directory }, deps) {
    api.assertState(state);
    if (!state.sourceUpgradePromotion || Object.values(state.items).some(item => item.status !== 'complete'
        && !(item.readerRefreshRequired === true && ['analyzing', 'analysis_partial'].includes(item.status) && item.analysisProof && item.sourceProof))) {
        throw new Error('只读保留来源重放仅支持原已完成或受控 Reader 续写的来源升级进程。');
    }
    recovery.sourceImplementation(state, directory, api);
    const receipt = readCompletion(state, directory, deps);
    const replay = createRetainedSourceReplay(context, deps);
    const retainedSources = new Map();
    const items = Object.values(state.items), total = items.length;
    const progress = completed => {
        if (typeof deps.onRetainedSourceProgress !== 'function') return;
        try { deps.onRetainedSourceProgress({ completed, total }); } catch (_) { /* 进度通知不能改变核验结果。 */ }
    };
    progress(0);
    for (const [index, item] of items.entries()) {
        retainedSources.set(item.analysisRunId, replay.forItem(item));
        if ((index + 1) % 100 === 0 || index + 1 === total) progress(index + 1);
    }
    const native = replay.loadPlan(receipt.planReceiptSha256);
    return { ...native, retainedSources,
        sealed: Object.values(state.items).map(item => ({ paperId: item.paperId, proof: structuredClone(item.sourceProof) })) };
}

module.exports = { createRetainedSourceReplay, replayCompletedPromotedShared, verifyRetainedExtraction, withOriginalPlanFile };
