#!/usr/bin/env node
'use strict';

/** Assemble the one controlled production records-v4 descriptor envelope. No prose is generated. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
if (require.main === module) {
    require('../../scripts/env-loader.js').requireExternalRuntime('manual-v6-production-records.js');
}
const Config = require('../../scripts/config.js');
const { writeFileAtomic } = require('../../scripts/utils.js');
const { withFileLockSync } = require('../../scripts/analysis-engine.js');
const { loadRecordsV4Envelopes } = require('./create-manual-analysis-spec-v6.js');
const {
    stableSha256, validateTaskPacket, normalizeLegacyArtifactIndexBinding
} = require('./manual-v6-workflow.js');
const {
    runnerPaths,
    verifyBoundInputs
} = require('./manual-v6-task-runner.js');
const {
    AUTHOR_OUTPUT_CONTRACT,
    validateAuthorOutputDescriptor
} = require('./manual-v6-production-packet.js');
const { REVISION_OUTPUT_CONTRACT } = require('./manual-v6-task-runner.js');
const {
    needsMetadataCorrection,
    applyMetadataCorrection,
    loadValidatedManifest,
    buildCorrectionProof
} = require('./manual-v6-metadata-correction.js');

const PRODUCTION_RECORDS_CONTRACT = 'manual-v6-production-records-envelope-v1';
const REVIEW_PROTOCOL = 'manual-v6-production-independent-review-v1';
const RECORDS_MODE = 'manual_analysis_records';

function sha256Bytes(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readOrdinaryFile(filePath, label) {
    const declared = path.resolve(filePath);
    const stat = fs.lstatSync(declared, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) {
        throw new Error(`${label} 必须是存在的普通文件且不得为 symlink`);
    }
    return { path: fs.realpathSync(declared), bytes: fs.readFileSync(declared) };
}

function readJsonFile(filePath, label) {
    const file = readOrdinaryFile(filePath, label);
    let value;
    try { value = JSON.parse(file.bytes.toString('utf8')); } catch (error) {
        throw new Error(`${label} JSON 损坏: ${error.message}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} 顶层必须是对象`);
    }
    return { ...file, value };
}

function relativeOrdinaryRef(rootPath, filePath, label) {
    const root = fs.realpathSync(rootPath);
    const file = readOrdinaryFile(filePath, label);
    const relative = path.relative(root, file.path);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)) {
        throw new Error(`${label} 逃逸单篇 artifactRoot`);
    }
    return { path: relative.replace(/\\/g, '/'), sha256: sha256Bytes(file.bytes) };
}

function parseArgs(argv) {
    const options = { force: false };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--force') {
            if (options.force) throw new Error('参数重复: --force');
            options.force = true;
            continue;
        }
        if (arg !== '--date') throw new Error(`未知参数: ${arg}`);
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error('--date 缺少值');
        if (options.date !== undefined) throw new Error('参数重复: --date');
        options.date = value;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(options.date || ''))) {
        throw new Error('--date 必须是 YYYY-MM-DD');
    }
    return options;
}

function assertValidatedProductionState(state) {
    verifyBoundInputs(state);
    for (const paperId of state.expectedPaperIds) {
        for (const role of ['author', 'technical_scoring', 'pedagogy_readability', 'author_revision']) {
            if (state.papers[paperId].tasks[role].status !== 'validated') {
                throw new Error(`${paperId}.${role} 尚未被 production runner validated`);
            }
        }
    }
    return state;
}

function assertProductionAuthorClosure(state, paperId, artifactRoot, correctionContext = null) {
    const task = state.papers[paperId].tasks.author;
    const output = readJsonFile(task.outputPath, `${paperId}.author output`);
    if (sha256Bytes(output.bytes) !== task.outputFileSha256
        || output.value.contract !== AUTHOR_OUTPUT_CONTRACT) {
        throw new Error(`${paperId}.author output 不是 runner 绑定的 production v2 descriptor`);
    }
    validateAuthorOutputDescriptor(output.value, artifactRoot, {
        paperId, taskName: task.taskName,
        ...(correctionContext ? { metadataCorrection: correctionContext.correction.changes } : {})
    });
}

function assertProductionRevisionClosure(state, paperId, artifactRoot) {
    const tasks = state.papers[paperId].tasks;
    const task = tasks.author_revision;
    const outputFile = readJsonFile(task.outputPath, `${paperId}.revision output`);
    const receiptFile = readJsonFile(task.receiptPath, `${paperId}.revision receipt`);
    if (sha256Bytes(outputFile.bytes) !== task.outputFileSha256
        || sha256Bytes(receiptFile.bytes) !== task.receiptFileSha256) {
        throw new Error(`${paperId}.revision output/receipt 已偏离 runner validated 字节`);
    }
    const output = outputFile.value;
    if (output.version !== 2 || output.contract !== REVISION_OUTPUT_CONTRACT
        || output.role !== 'author_revision' || output.paperId !== paperId
        || output.taskName !== task.taskName || output.passed !== true
        || output.technicalOutputSha256 !== tasks.technical_scoring.outputSemanticSha256
        || output.readabilityOutputSha256 !== tasks.pedagogy_readability.outputSemanticSha256) {
        throw new Error(`${paperId}.revision output 不是当前 production v2 closure`);
    }
    const articleRef = relativeOrdinaryRef(
        artifactRoot, path.join(artifactRoot, output.finalArticle?.path || ''),
        `${paperId}.final article`
    );
    const payloadRef = relativeOrdinaryRef(
        artifactRoot, path.join(artifactRoot, output.recordPayload?.path || ''),
        `${paperId}.revision record payload`
    );
    if (articleRef.path !== 'draft/final-article.md'
        || payloadRef.path !== 'draft/revision-record-payload.json'
        || articleRef.sha256 !== output.finalArticle.fileSha256
        || payloadRef.sha256 !== output.recordPayload.fileSha256) {
        throw new Error(`${paperId}.revision output 固定 article/payload 引用不闭环`);
    }
    const payloadFile = readJsonFile(
        path.join(artifactRoot, payloadRef.path), `${paperId}.revision record payload`
    );
    if (stableSha256(payloadFile.value) !== output.recordPayload.semanticSha256) {
        throw new Error(`${paperId}.revision record payload 语义 SHA 不匹配`);
    }
    const auditRef = output.independentAudit;
    const auditFile = readJsonFile(
        path.join(artifactRoot, auditRef?.path || ''), `${paperId}.revision independent audit`
    );
    if (auditRef?.path !== 'reviews/revision-independent-audit.json'
        || sha256Bytes(auditFile.bytes) !== auditRef.fileSha256
        || stableSha256(auditFile.value) !== auditRef.semanticSha256
        || auditFile.value.taskName !== auditRef.taskName
        || auditFile.value.paperId !== paperId || auditFile.value.finalPassed !== true) {
        throw new Error(`${paperId}.revision independent audit 未绑定 runner validated closure`);
    }
    return { output, receipt: receiptFile.value, payload: payloadFile.value };
}

function verifyTaskArtifactsAgainstState(state, paperId) {
    const tasks = state.papers[paperId].tasks;
    for (const role of ['author', 'technical_scoring', 'pedagogy_readability', 'author_revision']) {
        const task = tasks[role];
        for (const [kind, pathField, fileShaField, semanticShaField] of [
            ['packet', 'packetPath', 'packetFileSha256', null],
            ['output', 'outputPath', 'outputFileSha256', 'outputSemanticSha256'],
            ['receipt', 'receiptPath', 'receiptFileSha256', 'receiptSemanticSha256']
        ]) {
            const item = readJsonFile(task[pathField], `${paperId}.${role}.${kind}`);
            if (sha256Bytes(item.bytes) !== task[fileShaField]) {
                throw new Error(`${paperId}.${role}.${kind} 当前文件 SHA 与 runner validated state 不一致`);
            }
            if (kind === 'packet') {
                if (item.value.packetSha256 !== task.packetSha256) {
                    throw new Error(`${paperId}.${role}.packet 语义身份与 runner state 不一致`);
                }
            } else if (stableSha256(item.value) !== task[semanticShaField]) {
                throw new Error(`${paperId}.${role}.${kind} 语义 SHA 与 runner validated state 不一致`);
            }
        }
    }
}

function sealedRecordSemanticSha256(record) {
    const payload = structuredClone(record);
    delete payload.sealedRecordSha256;
    return stableSha256(payload);
}

function sealRecordFromValidatedState(state, paperId, artifactRoot, options = {}) {
    const tasks = state.papers[paperId].tasks;
    verifyTaskArtifactsAgainstState(state, paperId);
    const closure = assertProductionRevisionClosure(state, paperId, artifactRoot);
    const authorReceipt = readJsonFile(tasks.author.receiptPath, `${paperId}.author receipt`).value;
    const technicalReceipt = readJsonFile(
        tasks.technical_scoring.receiptPath, `${paperId}.technical receipt`
    ).value;
    const readabilityReceipt = readJsonFile(
        tasks.pedagogy_readability.receiptPath, `${paperId}.readability receipt`
    ).value;
    const technicalOutput = readJsonFile(
        tasks.technical_scoring.outputPath, `${paperId}.technical output`
    ).value;
    const readabilityOutput = readJsonFile(
        tasks.pedagogy_readability.outputPath, `${paperId}.readability output`
    ).value;
    const expectedFindingSha256s = [...technicalOutput.findings, ...readabilityOutput.findings]
        .map(finding => stableSha256(finding)).sort();
    const resolved = [...closure.output.resolvedFindingSha256s].sort();
    if (stableSha256(expectedFindingSha256s) !== stableSha256(resolved)) {
        throw new Error(`${paperId}.revision output 未逐项解决 runner validated reviewer findings`);
    }
    const correctionContext = options.correctionContext || null;
    if (options.requireCorrectionClosure === true
        && needsMetadataCorrection(closure.payload) !== Boolean(correctionContext)) {
        throw new Error(`${paperId}.metadata correction 与 revision payload 实际合法性不一致`);
    }
    const record = correctionContext
        ? applyMetadataCorrection(closure.payload, correctionContext.correction)
        : structuredClone(closure.payload);
    if (correctionContext) record.metadataCorrectionProof = buildCorrectionProof(correctionContext);
    normalizeLegacyArtifactIndexBinding(
        record, options.artifactIndex, options.artifactIndexFileSha256
    );
    record.editorial.longformBundle.authorReceipt = authorReceipt;
    record.editorial.longformBundle.finalRevisionAuthorReceipt = closure.receipt;
    record.reviewReceipts = {
        technicalScoring: technicalReceipt,
        pedagogyReadability: readabilityReceipt,
        authorRevision: closure.receipt
    };
    record.reviewResolution = {
        revisionTaskName: closure.receipt.taskName,
        technicalOutputSha256: technicalReceipt.outputSha256,
        readabilityOutputSha256: readabilityReceipt.outputSha256,
        readerArticleSha256: closure.output.finalArticleSha256,
        revisionOutputSha256: closure.receipt.outputSha256,
        resolvedFindingSha256s: resolved,
        notes: closure.output.notes
    };
    record.sealedRecordSha256 = sealedRecordSemanticSha256(record);
    const sealedPath = path.join(artifactRoot, 'sealed', 'record-v4.json');
    const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    const existing = fs.lstatSync(sealedPath, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
        throw new Error(`${paperId}.sealed record 目标类型非法或使用 symlink`);
    }
    if (existing && !fs.readFileSync(sealedPath).equals(bytes) && options.force !== true) {
        throw new Error(`${paperId}.sealed record 已存在且闭包已变化；显式 --force 后才可替换`);
    }
    if (!existing || !fs.readFileSync(sealedPath).equals(bytes)) writeFileAtomic(sealedPath, bytes);
    return { sealedPath, record };
}

function buildPaperDescriptor(state, paperId, expectedRoot, options = {}) {
    const tasks = state.papers[paperId].tasks;
    const roots = new Set(Object.values(tasks).map(task => task.artifactRoot));
    if (roots.size !== 1 || !roots.has(expectedRoot)) {
        throw new Error(`${paperId} 四类 task 未绑定同一受控 production artifactRoot`);
    }
    assertProductionAuthorClosure(state, paperId, expectedRoot, options.correctionContext || null);
    const authorPacketFile = readJsonFile(tasks.author.packetPath, `${paperId}.author packet`);
    const authorPacket = validateTaskPacket(authorPacketFile.value, {
        paperId, artifactRoot: expectedRoot, requireFiles: true
    });
    const artifactRef = authorPacket.allowedArtifacts.find(item => item.kind === 'artifact_index');
    if (!artifactRef) throw new Error(`${paperId}.author packet 缺少 ArtifactIndex`);
    const artifactIndexFile = readJsonFile(
        path.join(expectedRoot, artifactRef.path), `${paperId}.ArtifactIndex`
    );
    const sealed = sealRecordFromValidatedState(state, paperId, expectedRoot, {
        ...options,
        artifactIndex: artifactIndexFile.value,
        artifactIndexFileSha256: sha256Bytes(artifactIndexFile.bytes)
    });
    const sealedPath = sealed.sealedPath;
    const record = readJsonFile(sealedPath, `${paperId}.sealed record`);
    if (record.value.version !== 4 || record.value.manualDepth !== 'full-text-evidence-v6'
        || record.value.paperId !== paperId || !record.value.sealedRecordSha256) {
        throw new Error(`${paperId}.sealed/record-v4.json 不是当前论文的 sealed records v4`);
    }
    const packetKeys = {
        author: 'author',
        technicalScoring: 'technical_scoring',
        pedagogyReadability: 'pedagogy_readability',
        authorRevision: 'author_revision'
    };
    const taskPackets = {};
    const taskReceipts = {};
    for (const [key, role] of Object.entries(packetKeys)) {
        taskPackets[key] = relativeOrdinaryRef(expectedRoot, tasks[role].packetPath, `${paperId}.${role}.packet`);
        taskReceipts[key] = relativeOrdinaryRef(expectedRoot, tasks[role].receiptPath, `${paperId}.${role}.receipt`);
    }
    const reviewOutputs = {
        technicalScoring: relativeOrdinaryRef(
            expectedRoot, tasks.technical_scoring.outputPath, `${paperId}.technical output`
        ),
        pedagogyReadability: relativeOrdinaryRef(
            expectedRoot, tasks.pedagogy_readability.outputPath, `${paperId}.readability output`
        ),
        authorRevision: relativeOrdinaryRef(
            expectedRoot, tasks.author_revision.outputPath, `${paperId}.revision output`
        )
    };
    return {
        artifactRoot: null,
        record: relativeOrdinaryRef(expectedRoot, sealedPath, `${paperId}.sealed record`),
        artifactIndex: relativeOrdinaryRef(
            expectedRoot, artifactIndexFile.path, `${paperId}.ArtifactIndex`
        ),
        taskPackets,
        taskReceipts,
        reviewOutputs
    };
}

function buildRecordsEnvelope(state, options = {}) {
    assertValidatedProductionState(state);
    const dateRoot = path.resolve(options.dateRoot);
    const taskRoot = fs.realpathSync(options.taskRoot);
    const papers = {};
    for (const paperId of state.expectedPaperIds) {
        const root = fs.realpathSync(path.join(taskRoot, paperId));
        let descriptor;
        try {
            descriptor = buildPaperDescriptor(state, paperId, root, {
                force: options.force,
                requireCorrectionClosure: true,
                correctionContext: options.correctionManifest?.byPaper?.[paperId] || null
            });
        } catch (error) {
            throw new Error(`${paperId}: ${error.message}`);
        }
        const rootRelative = path.relative(dateRoot, root);
        if (!rootRelative || rootRelative === '..' || rootRelative.startsWith(`..${path.sep}`)
            || path.isAbsolute(rootRelative)) {
            throw new Error(`${paperId}.artifactRoot 逃逸 production 日期根`);
        }
        descriptor.artifactRoot = rootRelative.replace(/\\/g, '/');
        papers[paperId] = descriptor;
    }
    const manifest = options.correctionManifest;
    if (!manifest?.manifestFile || !manifest?.manifest) {
        throw new Error('production records 必须绑定已验证的 metadata correction manifest');
    }
    return {
        version: 4,
        mode: RECORDS_MODE,
        date: state.date,
        agent: 'Codex-v6-production-orchestrator',
        reviewProtocol: REVIEW_PROTOCOL,
        descriptorContract: PRODUCTION_RECORDS_CONTRACT,
        metadataCorrectionManifest: {
            path: path.relative(dateRoot, manifest.manifestFile.path).replace(/\\/g, '/'),
            sha256: manifest.manifestFile.fileSha256,
            semanticSha256: manifest.manifest.manifestSha256,
            merkleRoot: manifest.manifest.merkleRoot
        },
        papers
    };
}

function assembleRecordsEnvelope(options = {}) {
    const date = options.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
        throw new Error('assembleRecordsEnvelope 需要合法日期');
    }
    const currentDir = path.resolve(options.currentDir || Config.CURRENT_DIR);
    const dateRoot = path.join(currentDir, 'manual-v6', date);
    const paths = runnerPaths(date, path.join(currentDir, 'manual-v6'));
    const outputPath = path.join(dateRoot, 'records-v4.json');
    fs.mkdirSync(dateRoot, { recursive: true });
    return withFileLockSync(path.join(dateRoot, '.records-v4'), () => {
        const state = readJsonFile(paths.statePath, 'production runner state').value;
        const correctionManifest = loadValidatedManifest(
            path.join(dateRoot, 'metadata-corrections-manifest.json'),
            { date, dateRoot, expectedPaperIds: state.expectedPaperIds }
        );
        const envelope = buildRecordsEnvelope(state, {
            dateRoot, taskRoot: paths.taskRoot, force: options.force, correctionManifest
        });
        const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
        const existing = fs.lstatSync(outputPath, { throwIfNoEntry: false });
        if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
            throw new Error('records-v4.json 输出类型非法或使用 symlink');
        }
        if (existing && fs.readFileSync(outputPath).equals(bytes)) {
            loadRecordsV4Envelopes([outputPath], date);
            assertValidatedProductionState(readJsonFile(paths.statePath, 'production runner state').value);
            return { outputPath, envelope, cacheHit: true, fileSha256: sha256Bytes(bytes) };
        }
        if (existing && options.force !== true) {
            throw new Error('records-v4.json 已存在且闭包已变化；显式 --force 后才可替换');
        }
        const stagingPath = path.join(dateRoot, `.records-v4.${process.pid}.${Date.now()}.staging.json`);
        try {
            writeFileAtomic(stagingPath, bytes);
            loadRecordsV4Envelopes([stagingPath], date);
            assertValidatedProductionState(readJsonFile(paths.statePath, 'production runner state').value);
            fs.renameSync(stagingPath, outputPath);
            loadRecordsV4Envelopes([outputPath], date);
        } finally {
            if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath);
        }
        return { outputPath, envelope, cacheHit: false, fileSha256: sha256Bytes(bytes) };
    }, { timeoutMs: 0 });
}

function run(argv = process.argv.slice(2), overrides = {}) {
    const args = parseArgs(argv);
    const result = assembleRecordsEnvelope({
        date: args.date, force: args.force,
        currentDir: overrides.currentDir || Config.CURRENT_DIR
    });
    console.log(JSON.stringify({
        contract: PRODUCTION_RECORDS_CONTRACT,
        outputPath: result.outputPath,
        fileSha256: result.fileSha256,
        paperCount: Object.keys(result.envelope.papers).length,
        cacheHit: result.cacheHit
    }, null, 2));
    return result;
}

if (require.main === module) {
    try { run(); } catch (error) {
        console.error(`Manual v6 production records 失败: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    PRODUCTION_RECORDS_CONTRACT,
    REVIEW_PROTOCOL,
    parseArgs,
    assertValidatedProductionState,
    verifyTaskArtifactsAgainstState,
    sealedRecordSemanticSha256,
    normalizeLegacyArtifactIndexBinding,
    assertProductionRevisionClosure,
    sealRecordFromValidatedState,
    buildPaperDescriptor,
    buildRecordsEnvelope,
    assembleRecordsEnvelope,
    run
};
