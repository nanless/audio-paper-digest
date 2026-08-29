#!/usr/bin/env node
'use strict';

/** Official records v4 -> complete Manual spec v6 assembler. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
if (require.main === module) {
    require('./env-loader.js').requireExternalRuntime('create-manual-analysis-spec-v6.js');
}
const Config = require('./config.js');
const { normalizedId, writeFileAtomic, getBeijingISOString } = require('./utils.js');
const { withFileLockSync } = require('./analysis-engine.js');
const v5Assembler = require('./create-manual-analysis-spec.js');
const {
    buildManifestContext,
    isReusableFullTextCheckpoint,
    stableSha256: fullTextStableSha256
} = require('./manual-fetch-fulltext.js');
const {
    buildArtifactManifestContext,
    isReusableArtifactCheckpoint
} = require('./manual-artifact-index.js');
const {
    MANUAL_RECORD_VERSION_V4,
    MANUAL_SPEC_VERSION_V6,
    MANUAL_DEPTH_V6,
    MANUAL_V6_RUNTIME_MODE_PRODUCTION,
    MANUAL_V6_RUNTIME_MODE_SHADOW,
    stableSha256,
    resolveManualV6RuntimePaths,
    validateTaskPacket,
    validateAuthorRevisionArtifactLineage,
    validateManualRecordV4,
    buildPaperSpecShard,
    buildBatchSpecV6
} = require('./manual-v6-workflow.js');
const {
    monotonicNs,
    persistStageMetricSafely
} = require('./manual-performance-metrics.js');
const {
    loadValidatedManifest,
    needsMetadataCorrection
} = require('./manual-v6-metadata-correction.js');

const RECORDS_V4_MODE = 'manual_analysis_records';
const SPEC_MODE = 'manual_complete';
const FILE_REF_ROLES = Object.freeze({
    taskPackets: ['author', 'technicalScoring', 'pedagogyReadability', 'authorRevision'],
    taskReceipts: ['author', 'technicalScoring', 'pedagogyReadability', 'authorRevision'],
    reviewOutputs: ['technicalScoring', 'pedagogyReadability', 'authorRevision']
});
const ROLE_BY_KEY = Object.freeze({
    author: 'author',
    technicalScoring: 'technical_scoring',
    pedagogyReadability: 'pedagogy_readability',
    authorRevision: 'author_revision'
});
const SHA256_RE = /^[a-f0-9]{64}$/;

function sha256Buffer(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function readJsonBuffer(buffer, label) {
    let value;
    try { value = JSON.parse(buffer.toString('utf8')); } catch (error) {
        throw new Error(`${label} JSON 损坏: ${error.message}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} 顶层必须是对象`);
    }
    return value;
}

function readJsonFile(filePath, label) {
    return readJsonBuffer(fs.readFileSync(filePath), label);
}

function safeRelative(value, label) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}.path 必须是非空相对路径`);
    const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
    if (path.posix.isAbsolute(normalized) || normalized === '.' || normalized === '..'
        || normalized.startsWith('../') || normalized.includes('/../')) {
        throw new Error(`${label}.path 必须是安全相对路径`);
    }
    return normalized;
}

function assertRealDirectory(rootPath, label) {
    const declared = path.resolve(rootPath);
    if (!fs.statSync(declared, { throwIfNoEntry: false })?.isDirectory()
        || fs.lstatSync(declared).isSymbolicLink()) {
        throw new Error(`${label} 必须是存在的真实目录且不得使用符号链接`);
    }
    return fs.realpathSync(declared);
}

function assertInsideRoot(realRoot, declaredPath, label) {
    if (!fs.statSync(declaredPath, { throwIfNoEntry: false })?.isFile()
        || fs.lstatSync(declaredPath).isSymbolicLink()) {
        throw new Error(`${label} 文件不存在或使用符号链接`);
    }
    const realPath = fs.realpathSync(declaredPath);
    const relative = path.relative(realRoot, realPath);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`${label} 经 realpath 逃逸 artifactRoot`);
    }
    return { realPath, relative: relative.replace(/\\/g, '/') };
}

function readBoundJsonRef(root, ref, label, paperId, occupiedPaths) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)
        || !SHA256_RE.test(String(ref.sha256 || ''))) {
        throw new Error(`${label} 必须包含 path 与真实文件 SHA-256`);
    }
    const realRoot = assertRealDirectory(root, `${label}.artifactRoot`);
    const relative = safeRelative(ref.path, label);
    const resolved = assertInsideRoot(realRoot, path.resolve(realRoot, relative), label);
    const embeddedIds = resolved.relative.match(/\b\d{4}\.\d{4,5}\b/g) || [];
    if (embeddedIds.some(id => normalizedId(id) !== paperId)) {
        throw new Error(`${label} 路径引用了其他论文 ID`);
    }
    if (occupiedPaths.has(resolved.realPath)) throw new Error(`${label} 与其他 official 工件复用同一文件路径`);
    occupiedPaths.add(resolved.realPath);
    const bytes = fs.readFileSync(resolved.realPath);
    const fileSha256 = sha256Buffer(bytes);
    if (fileSha256 !== ref.sha256) throw new Error(`${label} 文件字节 SHA 不匹配`);
    return {
        path: resolved.realPath,
        relativePath: resolved.relative,
        bytes,
        fileSha256,
        value: readJsonBuffer(bytes, label)
    };
}

function sameSemantic(left, right) {
    return stableSha256(left) === stableSha256(right);
}

function validateV4EnvelopeHeader(document, envelopePath, expectedDate) {
    if (!document || document.version !== MANUAL_RECORD_VERSION_V4
        || document.mode !== RECORDS_V4_MODE || document.date !== expectedDate) {
        throw new Error(`${envelopePath} 必须是 date 匹配的 records v4 envelope`);
    }
    if (typeof document.agent !== 'string' || document.agent.trim().length < 2
        || typeof document.reviewProtocol !== 'string' || document.reviewProtocol.trim().length < 12) {
        throw new Error(`${envelopePath} 缺少 agent/reviewProtocol`);
    }
    if (!document.papers || typeof document.papers !== 'object' || Array.isArray(document.papers)
        || Object.keys(document.papers).length === 0) {
        throw new Error(`${envelopePath}.papers 必须是非空对象`);
    }
}

function loadPaperEvidence(envelope, envelopePath, rawId, descriptor, occupiedPaths, options = {}) {
    const paperId = normalizedId(rawId);
    if (!paperId || rawId !== paperId || !descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
        throw new Error(`${envelopePath}.papers 键/descriptor 非法: ${rawId}`);
    }
    const envelopeRoot = fs.realpathSync(path.dirname(envelopePath));
    const rootRelative = safeRelative(descriptor.artifactRoot, `${paperId}.artifactRoot`);
    const rootPaperIds = rootRelative.match(/\b\d{4}\.\d{4,5}\b/g) || [];
    if (rootPaperIds.some(id => normalizedId(id) !== paperId)) {
        throw new Error(`${paperId}.artifactRoot 引用了其他论文 ID`);
    }
    const root = assertRealDirectory(path.resolve(envelopeRoot, rootRelative), `${paperId}.artifactRoot`);
    const rootFromEnvelope = path.relative(envelopeRoot, root);
    if (!rootFromEnvelope || rootFromEnvelope.startsWith(`..${path.sep}`) || path.isAbsolute(rootFromEnvelope)) {
        throw new Error(`${paperId}.artifactRoot 经父目录符号链接逃逸 records envelope 根目录`);
    }
    const recordFile = readBoundJsonRef(root, descriptor.record, `${paperId}.record`, paperId, occupiedPaths);
    const artifactFile = readBoundJsonRef(root, descriptor.artifactIndex, `${paperId}.artifactIndex`, paperId, occupiedPaths);
    const groups = {};
    for (const [group, keys] of Object.entries(FILE_REF_ROLES)) {
        if (!descriptor[group] || typeof descriptor[group] !== 'object' || Array.isArray(descriptor[group])) {
            throw new Error(`${paperId}.${group} 必须是对象`);
        }
        groups[group] = {};
        for (const key of keys) {
            groups[group][key] = readBoundJsonRef(
                root, descriptor[group][key], `${paperId}.${group}.${key}`, paperId, occupiedPaths
            );
        }
    }
    const record = recordFile.value;
    if (record.version !== MANUAL_RECORD_VERSION_V4 || normalizedId(record.paperId || record.arxivId) !== paperId) {
        throw new Error(`${paperId}.record 不是当前论文 records v4`);
    }
    const packets = {
        author: groups.taskPackets.author.value,
        technicalScoring: groups.taskPackets.technicalScoring.value,
        pedagogyReadability: groups.taskPackets.pedagogyReadability.value,
        authorRevision: groups.taskPackets.authorRevision.value
    };
    const outputs = {
        technicalScoring: groups.reviewOutputs.technicalScoring.value,
        pedagogyReadability: groups.reviewOutputs.pedagogyReadability.value,
        authorRevision: groups.reviewOutputs.authorRevision.value
    };
    for (const [key, packet] of Object.entries(packets)) {
        validateTaskPacket(packet, { paperId, artifactRoot: root, requireFiles: true });
        if (packet.role !== ROLE_BY_KEY[key]) throw new Error(`${paperId}.taskPackets.${key}.role 非法`);
    }
    for (const key of ['author', 'technicalScoring', 'pedagogyReadability', 'authorRevision']) {
        if (!packets[key].allowedArtifacts.some(item => item.sha256 === artifactFile.fileSha256)) {
            throw new Error(`${paperId}.taskPackets.${key} 未绑定真实 ArtifactIndex 文件字节`);
        }
    }
    const revisionArtifactShas = new Set(packets.authorRevision.allowedArtifacts.map(item => item.sha256));
    for (const key of ['technicalScoring', 'pedagogyReadability']) {
        if (!revisionArtifactShas.has(groups.reviewOutputs[key].fileSha256)) {
            throw new Error(`${paperId}.taskPackets.authorRevision 未绑定 ${key} 真实 review 输出文件字节`);
        }
    }
    validateAuthorRevisionArtifactLineage(packets.author, packets.authorRevision, {
        technical: {
            path: groups.reviewOutputs.technicalScoring.relativePath,
            sha256: groups.reviewOutputs.technicalScoring.fileSha256
        },
        readability: {
            path: groups.reviewOutputs.pedagogyReadability.relativePath,
            sha256: groups.reviewOutputs.pedagogyReadability.fileSha256
        }
    });
    const embeddedReceipts = {
        author: record.editorial?.longformBundle?.authorReceipt,
        technicalScoring: record.reviewReceipts?.technicalScoring,
        pedagogyReadability: record.reviewReceipts?.pedagogyReadability,
        authorRevision: record.reviewReceipts?.authorRevision
    };
    for (const key of FILE_REF_ROLES.taskReceipts) {
        if (!sameSemantic(groups.taskReceipts[key].value, embeddedReceipts[key])) {
            throw new Error(`${paperId}.taskReceipts.${key} 文件与 record 内嵌 receipt 不一致`);
        }
    }
    validateManualRecordV4(record, artifactFile.value, {
        runtimeMode: options.runtimeMode || MANUAL_V6_RUNTIME_MODE_PRODUCTION,
        artifactRoot: root,
        artifactIndexBytes: artifactFile.bytes,
        taskPackets: packets,
        reviewOutputs: outputs,
        allowSignedLegacyTableRender: (options.runtimeMode || MANUAL_V6_RUNTIME_MODE_PRODUCTION)
            === MANUAL_V6_RUNTIME_MODE_PRODUCTION,
        // A small number of runner-validated migration records predate the
        // editorialPlan v2 metadata.  Their signed reader-longform-v2 bundle
        // remains the authoritative article contract; fresh/shadow records
        // still fail closed on anything other than editorialPlan v2.
        allowSignedLegacyEditorialPlan: (options.runtimeMode || MANUAL_V6_RUNTIME_MODE_PRODUCTION)
            === MANUAL_V6_RUNTIME_MODE_PRODUCTION,
        metadataCorrection: options.metadataCorrection || null
    });
    const taskEvidence = {
        taskNames: {
            author: record.editorial.longformBundle.authorReceipt.taskName,
            technicalScoring: record.reviewReceipts.technicalScoring.taskName,
            pedagogyReadability: record.reviewReceipts.pedagogyReadability.taskName,
            authorRevision: record.reviewReceipts.authorRevision.taskName
        },
        taskPackets: Object.fromEntries(Object.entries(groups.taskPackets).map(([key, item]) => [key, {
            fileSha256: item.fileSha256,
            packetSha256: item.value.packetSha256
        }])),
        taskReceipts: Object.fromEntries(Object.entries(groups.taskReceipts).map(([key, item]) => [key, {
            fileSha256: item.fileSha256,
            semanticSha256: stableSha256(item.value)
        }])),
        reviewOutputs: Object.fromEntries(Object.entries(groups.reviewOutputs).map(([key, item]) => [key, {
            fileSha256: item.fileSha256,
            semanticSha256: stableSha256(item.value)
        }])),
        metadataCorrection: options.metadataCorrection ? {
            manifestSha256: options.metadataCorrection.manifestSha256,
            manifestFileSha256: options.metadataCorrection.manifestFileSha256,
            merkleRoot: options.metadataCorrection.merkleRoot,
            packetSha256: options.metadataCorrection.packet.packetSha256,
            correctionSha256: stableSha256(options.metadataCorrection.correction),
            receiptSha256: stableSha256(options.metadataCorrection.receipt),
            changedFields: [...options.metadataCorrection.correction.changedFields]
        } : null
    };
    return {
        paperId,
        root,
        record,
        recordFile,
        artifactIndex: artifactFile.value,
        artifactFile,
        taskEvidence,
        taskEvidenceSha256: stableSha256(taskEvidence),
        taskNames: [
            record.editorial.longformBundle.authorReceipt.taskName,
            record.reviewReceipts.technicalScoring.taskName,
            record.reviewReceipts.pedagogyReadability.taskName,
            record.reviewReceipts.authorRevision.taskName
        ]
    };
}

function loadRecordsV4Envelopes(inputs, date, options = {}) {
    if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('records v4 至少需要一个 envelope');
    const papers = {};
    const sources = [];
    const roots = [];
    const occupiedPaths = new Set();
    const taskOwners = new Map();
    const agents = new Set();
    const protocols = new Set();
    for (const rawPath of inputs) {
        const envelopePath = path.resolve(rawPath);
        if (!fs.statSync(envelopePath, { throwIfNoEntry: false })?.isFile()
            || fs.lstatSync(envelopePath).isSymbolicLink()) {
            throw new Error(`records v4 envelope 不存在或使用符号链接: ${envelopePath}`);
        }
        const bytes = fs.readFileSync(envelopePath);
        const document = readJsonBuffer(bytes, `records v4 envelope ${envelopePath}`);
        validateV4EnvelopeHeader(document, envelopePath, date);
        const envelopeRoot = fs.realpathSync(path.dirname(envelopePath));
        const manifestRef = document.metadataCorrectionManifest;
        let correctionManifest = { byPaper: {} };
        if (manifestRef) {
            if (typeof manifestRef !== 'object' || Array.isArray(manifestRef)
                || manifestRef.path !== 'metadata-corrections-manifest.json'
                || !SHA256_RE.test(String(manifestRef.sha256 || ''))
                || !SHA256_RE.test(String(manifestRef.semanticSha256 || ''))
                || !SHA256_RE.test(String(manifestRef.merkleRoot || ''))) {
                throw new Error(`${envelopePath}.metadataCorrectionManifest 文件引用非法`);
            }
            correctionManifest = loadValidatedManifest(
                path.join(envelopeRoot, manifestRef.path),
                { date, dateRoot: envelopeRoot, expectedPaperIds: Object.keys(document.papers) }
            );
            if (correctionManifest.manifestFile.fileSha256 !== manifestRef.sha256
                || correctionManifest.manifest.manifestSha256 !== manifestRef.semanticSha256
                || correctionManifest.manifest.merkleRoot !== manifestRef.merkleRoot) {
                throw new Error(`${envelopePath}.metadataCorrectionManifest SHA/Merkle 绑定漂移`);
            }
        } else if (document.descriptorContract === 'manual-v6-production-records-envelope-v1') {
            throw new Error(`${envelopePath}.metadataCorrectionManifest 文件缺失`);
        }
        agents.add(document.agent.trim());
        protocols.add(document.reviewProtocol.trim());
        for (const [id, descriptor] of Object.entries(document.papers)) {
            if (papers[id]) throw new Error(`多个 records v4 envelope 重复提供论文: ${id}`);
            const evidence = loadPaperEvidence(
                document, envelopePath, id, descriptor, occupiedPaths, {
                    ...options,
                    metadataCorrection: correctionManifest.byPaper[id] || null
                }
            );
            const revisionPayload = correctionManifest.byPaper[id]?.originalPayload;
            if (correctionManifest.byPaper[id] && !needsMetadataCorrection(revisionPayload)) {
                throw new Error(`${id} metadata correction 是合法 revision payload 的 orphan`);
            }
            if (roots.some(existing => existing === evidence.root
                || existing.startsWith(`${evidence.root}${path.sep}`)
                || evidence.root.startsWith(`${existing}${path.sep}`))) {
                throw new Error(`${id}.artifactRoot 与其他论文重叠，违反单篇隔离`);
            }
            roots.push(evidence.root);
            claimBatchTaskNames(taskOwners, id, evidence.taskNames);
            papers[id] = {
                ...evidence,
                recordsEnvelopePath: envelopePath,
                recordsEnvelopeFileSha256: sha256Buffer(bytes)
            };
        }
        sources.push({ path: envelopePath, sha256: sha256Buffer(bytes) });
    }
    return {
        date,
        agent: agents.size === 1 ? [...agents][0] : 'Codex-multi-paper-subagents-v6',
        reviewProtocol: protocols.size === 1 ? [...protocols][0] : 'manual-v6-multi-paper-review-v1',
        papers,
        sources
    };
}

function exactSet(label, expected, actual) {
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const missing = [...expectedSet].filter(id => !actualSet.has(id));
    const extra = [...actualSet].filter(id => !expectedSet.has(id));
    if (missing.length || extra.length || actual.length !== actualSet.size) {
        throw new Error(`${label} 集合不一致: missing=${missing.join(',') || '-'} extra=${extra.join(',') || '-'}`);
    }
}

function claimBatchTaskNames(taskOwners, paperId, taskNames) {
    for (const taskName of taskNames) {
        const prior = taskOwners.get(taskName);
        if (prior) throw new Error(`taskName 批次全局复用: ${taskName} (${prior}, ${paperId})`);
        taskOwners.set(taskName, paperId);
    }
}

function assemblerProtocolSha256() {
    return stableSha256(Object.fromEntries([
        __filename,
        require.resolve('./manual-v6-workflow.js'),
        require.resolve('./manual-signature-contract.js'),
        require.resolve('./manual-longform-contract.js'),
        require.resolve('./manual-artifact-index.js'),
        require.resolve('./create-manual-analysis-spec.js')
    ].map(filePath => [path.basename(filePath), sha256Buffer(fs.readFileSync(filePath))])));
}

function buildSpecV6(options = {}) {
    const { date, filtered, filteredPath, fullTextManifest, fullTextManifestPath,
        artifactManifest, artifactManifestPath, records, recordsEnvelope, runtimeMode,
        generatedAt = getBeijingISOString() } = options;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('spec v6 date 非法');
    if (![MANUAL_V6_RUNTIME_MODE_PRODUCTION, MANUAL_V6_RUNTIME_MODE_SHADOW].includes(runtimeMode)) {
        throw new Error('spec v6 runtimeMode 必须显式为 production 或 shadow');
    }
    if (filtered.batchDate !== date || filtered.status !== 'complete' || !Array.isArray(filtered.papers)) {
        throw new Error('spec v6 filtered 批次不完整');
    }
    const ids = filtered.papers.map(normalizedId);
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) {
        throw new Error('spec v6 filtered 含非法或规范化重复 ID');
    }
    exactSet('records v4', ids, Object.keys(records.papers));
    const outDir = path.dirname(fullTextManifestPath);
    const fullContext = buildManifestContext(filtered, date, outDir);
    if (fullTextManifest.version !== 2 || fullTextManifest.mode !== 'manual_full_text_fetch'
        || fullTextManifest.date !== date || fullTextManifest.status !== 'complete' || fullTextManifest.failed !== 0
        || fullTextManifest.count !== ids.length
        || fullTextManifest.filteredBatchSha256 !== fullContext.filteredBatchSha256
        || fullTextStableSha256(fullTextManifest.expectedPaperInputs) !== fullTextStableSha256(fullContext.expectedPaperInputs)) {
        throw new Error('spec v6 full-text manifest 不完整或身份不匹配');
    }
    exactSet('full-text manifest', ids, Object.keys(fullTextManifest.papers || {}));
    const artifactContext = buildArtifactManifestContext(fullContext, outDir);
    if (artifactManifest.version !== 1 || artifactManifest.mode !== 'manual_artifact_index'
        || artifactManifest.date !== date || artifactManifest.status !== 'complete' || artifactManifest.count !== ids.length
        || Number(artifactManifest.incomplete || 0) !== 0 || artifactManifest.failed !== 0
        || artifactManifest.parserVersion !== require('./manual-artifact-index.js').ARTIFACT_PARSER_VERSION
        || artifactManifest.filteredBatchSha256 !== fullContext.filteredBatchSha256
        || stableSha256(artifactManifest.expectedPaperInputs) !== stableSha256(artifactContext.expectedPaperInputs)
        || path.resolve(artifactManifestPath) !== path.resolve(artifactContext.manifestPath)) {
        throw new Error('spec v6 要求精确覆盖 filtered 的 complete ArtifactIndex manifest');
    }
    exactSet('ArtifactIndex manifest', ids, Object.keys(artifactManifest.papers || {}));
    const mergedRecords = {
        date,
        agent: records.agent,
        reviewProtocol: records.reviewProtocol,
        recordsVersion: v5Assembler.RECORDS_VERSION,
        papers: Object.fromEntries(Object.entries(records.papers).map(([id, item]) => [id, item.record])),
        sources: records.sources
    };
    const base = v5Assembler.buildSpec({
        date, filtered, filteredPath, manifest: fullTextManifest,
        manifestPath: fullTextManifestPath, mergedRecords, generatedAt,
        validatedV6Records: options.allowSignedV6CompatibilityOverride === true
    });
    const protocolSha256 = assemblerProtocolSha256();
    const papers = {};
    const shards = [];
    for (const input of fullContext.inputs) {
        const id = input.id;
        const sourceEntry = fullTextManifest.papers[id];
        const artifactEntry = artifactManifest.papers[id];
        const evidence = records.papers[id];
        const sourceText = fs.readFileSync(sourceEntry.path, 'utf8');
        if (!isReusableFullTextCheckpoint(sourceEntry, input.filePath, input)
            || !isReusableArtifactCheckpoint(artifactEntry, {
                context: artifactContext, input, sourceEntry, sourceText
            })) {
            throw new Error(`${id} 全文或 ArtifactIndex checkpoint 不可复用`);
        }
        if (evidence.record.sourceSnapshot.paperInputSha256 !== input.paperInputSha256
            || evidence.record.sourceSnapshot.sourceIdentitySha256 !== sourceEntry.sourceIdentitySha256) {
            throw new Error(`${id} records v4 sourceSnapshot 未绑定当前 filtered/full-text 输入身份`);
        }
        const officialArtifactBytes = fs.readFileSync(artifactEntry.path);
        if (sha256Buffer(officialArtifactBytes) !== artifactEntry.outputSha256
            || evidence.artifactFile.fileSha256 !== artifactEntry.outputSha256
            || !officialArtifactBytes.equals(evidence.artifactFile.bytes)
            || evidence.artifactIndex.outputSha256 !== artifactEntry.artifactIndexSha256
            || evidence.record.sourceSnapshot.artifactIndexFileSha256 !== artifactEntry.outputSha256) {
            throw new Error(`${id} records 工件中的 ArtifactIndex copy 未与 complete official checkpoint 字节闭环`);
        }
        const recordProvenance = {
            sealedRecordSha256: evidence.record.sealedRecordSha256,
            recordFileSha256: evidence.recordFile.fileSha256,
            recordsEnvelopeFileSha256: evidence.recordsEnvelopeFileSha256,
            artifactIndexSha256: evidence.artifactIndex.outputSha256,
            artifactIndexFileSha256: evidence.artifactFile.fileSha256,
            readerLongformSha256: stableSha256(evidence.record.editorial.longformBundle),
            taskEvidenceSha256: evidence.taskEvidenceSha256
        };
        const paperPayload = {
            ...base.papers[id],
            manualDepth: MANUAL_DEPTH_V6,
            runtimeMode,
            ...(options.allowSignedV6CompatibilityOverride === true ? {
                v5BridgeMode: 'signed-v6-task-evidence-override-v1'
            } : {}),
            readerImagesPreembedded: true,
            readerLongform: evidence.record.editorial.longformBundle,
            artifactIndex: evidence.artifactIndex,
            recordProvenance,
            taskEvidence: evidence.taskEvidence
        };
        const paperPayloadSha256 = stableSha256(paperPayload);
        const shard = buildPaperSpecShard({
            paperId: id,
            ...recordProvenance,
            paperInputSha256: input.paperInputSha256,
            sourceIdentitySha256: sourceEntry.sourceIdentitySha256,
            paperPayloadSha256,
            assemblerProtocolSha256: protocolSha256
        });
        papers[id] = { ...paperPayload, paperSpecSha256: shard.paperSpecSha256, paperPayloadSha256 };
        shards.push(shard);
    }
    const batch = buildBatchSpecV6({
        date, runtimeMode, filteredBatchSha256: fullContext.filteredBatchSha256,
        expectedPaperIds: ids, paperShards: shards
    });
    if (batch.status !== 'complete') throw new Error('spec v6 shard 未完整覆盖 filtered');
    const spec = {
        version: MANUAL_SPEC_VERSION_V6,
        mode: SPEC_MODE,
        status: 'complete',
        date,
        agent: records.agent,
        reviewProtocol: records.reviewProtocol,
        recordsVersion: MANUAL_RECORD_VERSION_V4,
        manualDepth: MANUAL_DEPTH_V6,
        runtimeMode,
        ...(options.allowSignedV6CompatibilityOverride === true ? {
            v5BridgeMode: 'signed-v6-task-evidence-override-v1'
        } : {}),
        signatureContract: batch.signatureContract,
        generatedAt,
        assemblerProtocolSha256: protocolSha256,
        filteredBatchSha256: fullContext.filteredBatchSha256,
        filteredPapers: { path: filteredPath, sha256: sha256Buffer(fs.readFileSync(filteredPath)) },
        fullTextManifest: {
            path: fullTextManifestPath, sha256: sha256Buffer(fs.readFileSync(fullTextManifestPath)),
            version: 2, paperCount: ids.length
        },
        artifactManifest: {
            path: artifactManifestPath, sha256: sha256Buffer(fs.readFileSync(artifactManifestPath)),
            version: 1, parserVersion: artifactManifest.parserVersion, paperCount: ids.length
        },
        recordsSources: records.sources,
        ...(recordsEnvelope ? { recordsEnvelope } : {}),
        paperShards: shards,
        paperIndex: batch.paperIndex,
        rootSha256: batch.rootSha256,
        promptPath: base.promptPath,
        promptSha256: base.promptSha256,
        manualAuthoringPromptPath: base.manualAuthoringPromptPath,
        manualAuthoringPromptSha256: base.manualAuthoringPromptSha256,
        stagePromptSha256: base.stagePromptSha256,
        researchContract: base.researchContract,
        perPaperSubagentRequired: true,
        papers
    };
    for (const source of [
        spec.filteredPapers, spec.fullTextManifest, spec.artifactManifest,
        ...(spec.recordsEnvelope ? [spec.recordsEnvelope] : []), ...spec.recordsSources
    ]) {
        if (sha256Buffer(fs.readFileSync(source.path)) !== source.sha256) {
            throw new Error(`spec v6 输入在组装期间发生变化: ${source.path}`);
        }
    }
    return spec;
}

function parseArgs(argv) {
    const options = { records: [], force: false, runtimeMode: null };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--force') {
            if (options.force) throw new Error('参数重复: --force');
            options.force = true;
            continue;
        }
        if (arg === '--production' || arg === '--shadow') {
            if (options.runtimeMode) throw new Error('--production 与 --shadow 必须且只能指定一个');
            options.runtimeMode = arg === '--production'
                ? MANUAL_V6_RUNTIME_MODE_PRODUCTION
                : MANUAL_V6_RUNTIME_MODE_SHADOW;
            continue;
        }
        if (!['--date', '--records'].includes(arg)) throw new Error(`未知参数: ${arg}`);
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
        if (arg === '--records') options.records.push(value);
        else if (options[arg.slice(2)] !== undefined) throw new Error(`参数重复: ${arg}`);
        else options[arg.slice(2)] = value;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date || '')) throw new Error('--date 必须是 YYYY-MM-DD');
    if (options.records.length === 0) throw new Error('--records 至少指定一个 records v4 envelope');
    if (!options.runtimeMode) throw new Error('必须显式指定 --production 或 --shadow');
    return options;
}

function run(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const filteredPath = Config.FILES.filteredPapers;
    const fullTextManifestPath = path.join(Config.CURRENT_DIR, 'manual-full-text', args.date, 'manifest.json');
    const artifactManifestPath = path.join(Config.CURRENT_DIR, 'manual-full-text', args.date, 'artifacts', 'manifest.json');
    const runtimePaths = resolveManualV6RuntimePaths(Config.CURRENT_DIR, args.date, args.runtimeMode);
    const outputDir = runtimePaths.batchDir;
    const outputPath = runtimePaths.specPath;
    const recordsEnvelopePath = runtimePaths.recordsEnvelopePath;
    const recordsPaths = args.records.map(value => path.resolve(Config.PROJECT_ROOT, value));
    if (args.runtimeMode === MANUAL_V6_RUNTIME_MODE_PRODUCTION
        && (recordsPaths.length !== 1
            || path.resolve(recordsPaths[0]) !== path.resolve(recordsEnvelopePath))) {
        throw new Error(`production records v4 必须是唯一受控 envelope: ${recordsEnvelopePath}`);
    }
    fs.mkdirSync(outputDir, { recursive: true });
    const queuedAtNs = monotonicNs();
    let startedAtNs = null;
    let cacheHit = false;
    const spec = withFileLockSync(path.join(outputDir, '.assemble'), () => {
        startedAtNs = monotonicNs();
        let existing = null;
        if (fs.existsSync(outputPath)) {
            if (fs.lstatSync(outputPath).isSymbolicLink()) {
                throw new Error('Manual spec v6 输出不得是符号链接');
            }
            existing = readJsonFile(outputPath, 'existing spec v6');
        }
        const records = loadRecordsV4Envelopes(recordsPaths, args.date, {
            runtimeMode: args.runtimeMode
        });
        const recordsEnvelope = args.runtimeMode === MANUAL_V6_RUNTIME_MODE_PRODUCTION
            ? {
                path: recordsPaths[0],
                sha256: sha256Buffer(fs.readFileSync(recordsPaths[0])),
                version: MANUAL_RECORD_VERSION_V4,
                mode: RECORDS_V4_MODE
            }
            : null;
        const assembled = buildSpecV6({
            date: args.date,
            filtered: readJsonFile(filteredPath, 'filtered-papers'),
            filteredPath,
            fullTextManifest: readJsonFile(fullTextManifestPath, 'manual full-text manifest'),
            fullTextManifestPath,
            artifactManifest: readJsonFile(artifactManifestPath, 'ArtifactIndex manifest'),
            artifactManifestPath,
            records,
            runtimeMode: args.runtimeMode,
            recordsEnvelope,
            allowSignedV6CompatibilityOverride: args.runtimeMode === MANUAL_V6_RUNTIME_MODE_PRODUCTION
                && args.force === true,
            ...(existing?.generatedAt ? { generatedAt: existing.generatedAt } : {})
        });
        if (existing) {
            if (stableSha256(existing) === stableSha256(assembled)) {
                cacheHit = true;
                return existing;
            }
            if (!args.force) throw new Error('spec v6 已存在且输入已变化；显式 --force 后才可替换');
        }
        writeFileAtomic(outputPath, JSON.stringify(assembled, null, 2));
        return assembled;
    }, { timeoutMs: 0 });
    const completedAtNs = monotonicNs();
    persistStageMetricSafely({
        shadowRoot: args.runtimeMode === MANUAL_V6_RUNTIME_MODE_PRODUCTION
            ? Config.FILES.manualV6Dir
            : Config.FILES.manualV6ShadowDir,
        containmentRoot: Config.CURRENT_DIR,
        date: args.date,
        stage: 'spec_v6',
        status: 'complete',
        wallNs: completedAtNs - startedAtNs,
        wallAggregation: 'single_stage_wall_inside_assembler_lock',
        queueNs: startedAtNs - queuedAtNs,
        queueAggregation: 'single_observed_assembler_lock_wait',
        cache: { hits: cacheHit ? 1 : 0, misses: cacheHit ? 0 : 1 },
        paperCount: Object.keys(spec.papers).length,
        taskCount: Object.keys(spec.papers).length,
        inputFiles: [
            { role: 'filtered_papers', path: filteredPath },
            { role: 'fulltext_manifest', path: fullTextManifestPath },
            { role: 'artifact_manifest', path: artifactManifestPath },
            ...recordsPaths.map(filePath => ({ role: 'records_v4_envelope', path: filePath }))
        ],
        outputFiles: [{ role: 'spec_v6', path: outputPath }]
    });
    console.log(`✅ 已原子写入 ${args.runtimeMode} Manual spec v6：${outputPath}（${Object.keys(spec.papers).length} 篇，API 调用 0）`);
    return { outputPath, recordsEnvelopePath, runtimeMode: args.runtimeMode, spec };
}

if (require.main === module) {
    try { run(); } catch (error) {
        console.error(`❌ Manual spec v6 组装失败: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    RECORDS_V4_MODE,
    parseArgs,
    safeRelative,
    readBoundJsonRef,
    loadPaperEvidence,
    loadRecordsV4Envelopes,
    claimBatchTaskNames,
    assemblerProtocolSha256,
    buildSpecV6,
    run
};
