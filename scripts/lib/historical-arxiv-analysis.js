'use strict';

// 将经官方来源核验、允许用于正式分析的 arXiv 来源对象交给分析引擎。
// 它会新建一次隔离的分析运行，既不读也不写日更的正式分析结果。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const authorityApi = require('./paper-source-authority.js');
const arxivApi = require('./arxiv-source-authority.js');
const fresh = require('./fresh-rewrite-run.js');
const { writeImmutableFile, recoverImmutableFileLink } = require('./immutable-file.js');

const BASELINE_CONTRACT = 'historical-arxiv-authority-baseline-v1';
const METADATA_CONTRACT = 'historical-raw-metadata-proof-v1';
const GENERATED_FIELD_RE = /^(?:analysis(?:$|Checkpoint|Manifest|Stage|Recovery)|parsed$|apiReader|freshRewrite|freshSource|imageManifest$)/;
const SHA_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function fail(message) {
    const error = new Error(`历史 arXiv 分析被拒绝：${message}`);
    error.code = 'HISTORICAL_ARXIV_ANALYSIS_INTEGRITY';
    error.retryable = false;
    throw error;
}

function writeExact(filename, bytes) {
    const payload = Buffer.from(bytes);
    writeImmutableFile(filename, payload, fail);
    return sha256(payload);
}
const writeJsonExact = (filename, value) => writeExact(filename, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));

function normalizedMetadata(metadata, expectedId) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('需要传入原始元数据对象');
    if (Object.keys(metadata).some(key => GENERATED_FIELD_RE.test(key))) fail('原始元数据不得包含旧分析正文、Reader 文章或检查点字段');
    const unexpected = Object.keys(metadata).filter(key => !fresh.ORIGINAL_METADATA_FIELDS.includes(key));
    if (unexpected.length) fail(`原始元数据包含来源信息之外的字段： ${unexpected.join(', ')}`);
    const clean = fresh.metadataOnly(metadata);
    if (fresh.paperId(clean) !== expectedId) fail('原始元数据属于另一篇论文');
    return clean;
}

function normalizedMetadataProof(proof, paper) {
    const acceptedContracts = new Set([METADATA_CONTRACT, require('./arxiv-metadata-source.js').CONTRACT]);
    if (!proof || !acceptedContracts.has(proof.contract) || proof.paperId !== `arxiv:${fresh.paperId(paper)}`
        || !SHA_RE.test(String(proof.fileSha256 || '')) || !SHA_RE.test(String(proof.recordSha256 || ''))
        || proof.recordSha256 !== fresh.stableHash(paper)
        || typeof proof.sourceName !== 'string' || !proof.sourceName) fail('原始元数据凭证不合法：contract、paperId、SHA 或来源名不符');
    return structuredClone(proof);
}

function recoverSourceFiles(sourceDir) {
    for (const filename of ['source.txt', 'artifacts.json', 'source-details.json', 'source.json']) {
        recoverImmutableFileLink(path.join(sourceDir, filename), fail, 64 * 1024 * 1024);
    }
}

function prepareHistoricalArxivRun({ authorityHandle, metadata, metadataProof, metadataArtifact = null, date, rootDir,
    runId = crypto.randomUUID(), now = new Date().toISOString() } = {}) {
    const parsedDate = new Date(`${date}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))
        || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
        fail('日期必须是真实的 YYYY-MM-DD');
    }
    if (!UUID_RE.test(String(runId || ''))) fail('runId 必须是 UUID v4');
    const replayed = authorityApi.replayAuthorityHandle(authorityHandle, { requireProduction: true });
    const authority = authorityApi.authorityHandleSnapshot(replayed);
    if (authority.authority.evidenceKind !== 'arxiv-official-fulltext'
        || authority.productionAuthorized !== true) fail('需要一份线上、已授权生产的 arXiv 来源句柄');
    const id = authority.authority.identity.arxivId;
    const paper = normalizedMetadata(metadata, id);
    const proof = normalizedMetadataProof(metadataProof, paper);
    const sourceDetails = arxivApi.readLiveProductionSourceDetails(authorityHandle);
    const sourceSha256 = sha256(Buffer.from(sourceDetails.text, 'utf8'));
    const structuredArtifactsSha256 = sourceDetails.structuredArtifacts?.payloadSha256;
    if (sourceSha256 !== authority.fulltextSha256 || !SHA_RE.test(String(structuredArtifactsSha256 || ''))
        || sourceDetails.structuredArtifacts.flattenedTextSha256 !== sourceSha256) {
        fail('线上来源的全文 SHA 或结构化提取结果的 SHA 与来源记录不同');
    }

    const absoluteRoot = fresh.assertSafeDirectory(rootDir, true);
    const runDir = fresh.assertSafeDirectory(path.join(absoluteRoot, runId), true);
    for (const filename of ['inputs.json', 'analysis.json', 'run.json', `metadata-${id}.atom.xml`]) {
        recoverImmutableFileLink(path.join(runDir, filename), fail, 64 * 1024 * 1024);
    }
    if (fs.existsSync(path.join(runDir, 'run.json'))) {
        const loaded = fresh.loadRun(runId, { rootDir: absoluteRoot });
        if (loaded.run.date !== date || fresh.paperId(loaded.inputs.papers[0]) !== id
            || loaded.run.paperIds.length !== 1 || loaded.run.baseline.contract !== BASELINE_CONTRACT
            || loaded.run.baseline.authorityFileSha256 !== authority.authorityFileSha256
            || loaded.run.baseline.authoritySha256 !== authority.authority.authoritySha256
            || fresh.stableHash(loaded.inputs.papers[0]) !== fresh.stableHash(paper)) {
            fail('已有 runId 的来源、元数据、日期或论文集合与本次不同');
        }
        const sourceDir = fresh.assertSafeDirectory(path.join(runDir, 'sources', id));
        recoverSourceFiles(sourceDir);
        recoverHistoricalArxivRun({ runId, date, arxivId: id, rootDir: absoluteRoot });
        verifyHistoricalArxivRunAuthority({ runId, rootDir: absoluteRoot, authorityHandle });
        return { runId, runDir, paperId: `arxiv:${id}`, status: 'recovered',
            canonicalPath: path.join(runDir, 'analysis.json') };
    }
    try {
        const inputs = { version: 1, contract: fresh.INPUT_CONTRACT, runId, date, papers: [paper] };
        const inputsSha256 = writeJsonExact(path.join(runDir, 'inputs.json'), inputs);
        writeJsonExact(path.join(runDir, 'analysis.json'), { version: 1,
            contract: fresh.ANALYSIS_CONTRACT, runId, batchDate: date, status: 'pending', generation: 0,
            papers: [paper] });
        const sourceDir = fresh.assertSafeDirectory(path.join(runDir, 'sources', id), true);
        recoverSourceFiles(sourceDir);
        const sourceBytes = Buffer.from(JSON.stringify(sourceDetails));
        const descriptor = { version: 1, contract: 'fresh-source-cache-v1', runId, paperId: id,
            sourceSha256, structuredArtifactsSha256, sourceSnapshotSha256: sha256(sourceBytes) };
        writeExact(path.join(sourceDir, 'source.txt'), Buffer.from(sourceDetails.text, 'utf8'));
        writeExact(path.join(sourceDir, 'artifacts.json'), Buffer.from(JSON.stringify(sourceDetails.structuredArtifacts)));
        writeExact(path.join(sourceDir, 'source-details.json'), sourceBytes);
        writeExact(path.join(sourceDir, 'source.json'), Buffer.from(JSON.stringify(descriptor)));
        if (metadataArtifact !== null) {
            const artifact = Buffer.from(metadataArtifact);
            if (sha256(artifact) !== proof.fileSha256) fail('官方元数据文件的 SHA 与凭证记录不符');
            writeExact(path.join(runDir, `metadata-${id}.atom.xml`), artifact);
        }
        const sourceExpectations = { [id]: { sourceId: sourceDetails.sourceId, sourceSha256,
            structuredArtifactsSha256, authoritySha256: authority.authority.authoritySha256,
            authorityFileSha256: authority.authorityFileSha256,
            authoritySourceSnapshotSha256: authority.sourceSnapshotSha256 } };
        const baseline = { version: 1, contract: BASELINE_CONTRACT, paperId: `arxiv:${id}`,
            authorityName: authority.authorityName, authorityFileSha256: authority.authorityFileSha256,
            authoritySha256: authority.authority.authoritySha256,
            authoritySourceSnapshotSha256: authority.sourceSnapshotSha256,
            fulltextSha256: authority.fulltextSha256, metadata: proof };
        const run = { version: 1, contract: fresh.RUN_CONTRACT, freshnessContract: fresh.FRESHNESS_CONTRACT,
            runId, date, createdAt: new Date(now).toISOString(), paperIds: [id],
            paperSetSha256: fresh.stableHash([id]), inputsSha256, baseline, sourceExpectations,
            metadataSources: { historicalRawMetadata: proof }, sourceRecords: { [id]: descriptor },
            status: 'sources_ready', generation: 0,
            diagnostics: { analysisInvocations: 0, outerAnalysisEntries: {} } };
        run.identitySha256 = fresh.stableHash({ version: run.version, contract: run.contract, runId: run.runId,
            date: run.date, paperIds: run.paperIds, paperSetSha256: run.paperSetSha256,
            inputsSha256: run.inputsSha256, baseline: run.baseline,
            sourceExpectations: run.sourceExpectations, metadataSources: run.metadataSources });
        writeJsonExact(path.join(runDir, 'run.json'), run);
        fresh.loadRun(runId, { rootDir: absoluteRoot });
        return { runId, runDir, paperId: `arxiv:${id}`, status: 'sources_ready',
            canonicalPath: path.join(runDir, 'analysis.json') };
    } catch (error) {
        throw new Error(`历史 arXiv 运行保留在 ${runDir} 供检查：${error.message}`, { cause: error });
    }
}

function recoverHistoricalArxivRun({ runId, date, arxivId, rootDir, now = new Date().toISOString() } = {}) {
    if (!UUID_RE.test(String(runId || '')) || !/^\d{4}\.\d{4,5}$/.test(String(arxivId || ''))) fail('需要合法的 runId（UUID v4）和 arxivId（YYMM.NNNNN）');
    const runDir = path.join(path.resolve(rootDir), runId);
    if (!fs.existsSync(path.join(runDir, 'run.json'))) return null;
    const loaded = fresh.loadRun(runId, { rootDir: path.resolve(rootDir) });
    if (loaded.run.date !== date || loaded.run.paperIds.length !== 1 || loaded.run.paperIds[0] !== arxivId
        || loaded.run.baseline.contract !== BASELINE_CONTRACT
        || loaded.run.baseline.paperId !== `arxiv:${arxivId}`) fail('已有 runId 属于另一次历史分析');
    normalizedMetadataProof(loaded.run.baseline.metadata, loaded.inputs.papers[0]);
    if (loaded.run.baseline.metadata.contract === require('./arxiv-metadata-source.js').CONTRACT) {
        const filename = path.join(runDir, `metadata-${arxivId}.atom.xml`);
        let bytes; let fd;
        try {
            fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            if (!fs.fstatSync(fd).isFile()) throw new Error('官方元数据文件必须是普通文件');
            bytes = fs.readFileSync(fd);
        }
        catch (error) { fail(`无法重新读取已保存的官方元数据文件：${error.message}`); }
        finally { if (fd !== undefined) fs.closeSync(fd); }
        if (sha256(bytes) !== loaded.run.baseline.metadata.fileSha256) fail('官方元数据文件的 SHA 与运行记录中的原 SHA 不一致');
    }
    const analysisFile = fresh.readRegularJson(path.join(runDir, 'analysis.json'));
    const storageSealed = loaded.run.status === 'complete';
    if (storageSealed && (loaded.analysis.status !== 'complete'
        || !SHA_RE.test(String(loaded.run.analysisSha256 || ''))
        || loaded.run.analysisSha256 !== analysisFile.sha256)) {
        fail('已标为 complete 的历史运行没有保存完整的正式分析结果，或结果文件的 SHA 与运行记录不符');
    }
    const engine = require('../analysis-engine.js');
    const paper = loaded.analysis.papers[0];
    let currentContractComplete = false;
    if (storageSealed && loaded.analysis.papers.length === 1
        && engine.isSuccessfulAnalysisRecord(paper)) {
        try {
            currentContractComplete = fresh.assertFreshSourceRecordMatchesRun(
                paper, loaded.run, loaded.run.sourceRecords?.[arxivId]
            ) === true && (require('./model-text-sanitization.js').canReuseModelTextInputs(paper,
                require('./fresh-analysis-context.js').readFreshSource(runDir, paper, loaded.run)) && require('./reader-author-source.js').canReuseReaderAuthorInputs(paper,
                require('./fresh-analysis-context.js').readFreshSource(runDir, paper, loaded.run)));
        } catch {
            currentContractComplete = false;
        }
    }
    const upgradeRequired = storageSealed && !currentContractComplete;
    let operationLock = null;
    if (!currentContractComplete) {
        const nowMs = new Date(now).getTime();
        if (!Number.isFinite(nowMs)) fail('恢复时间必须是合法的 ISO 时间戳');
        operationLock = engine.inspectFileLockState(path.join(runDir, '.operation'), { nowMs });
    }
    const operationBlocked = operationLock?.exists === true
        && operationLock.reclaimable !== true;
    const interruptedRecoverable = loaded.run.status === 'analyzing'
        && operationLock?.reclaimable === true;
    const status = currentContractComplete ? 'complete'
        : operationBlocked ? 'analyzing'
            : upgradeRequired || interruptedRecoverable ? 'analysis_partial'
            : loaded.run.status;
    return { runId, runDir, paperId: `arxiv:${arxivId}`, status,
        storedStatus: loaded.run.status,
        canonicalPath: path.join(runDir, 'analysis.json'),
        storageSealed,
        currentContractComplete,
        upgradeRequired,
        recoveryKind: currentContractComplete ? null : 'full',
        interruptedRecoverable,
        operationBlocked,
        operationLock,
        recovered: true };
}

function verifyHistoricalArxivRunAuthority({ runId, rootDir, authorityHandle } = {}) {
    const loaded = fresh.loadRun(runId, { rootDir: path.resolve(rootDir) });
    const replayed = authorityApi.replayAuthorityHandle(authorityHandle, { requireProduction: true });
    const authority = authorityApi.authorityHandleSnapshot(replayed);
    const id = loaded.run.paperIds[0]; const expected = loaded.run.sourceExpectations[id];
    if (loaded.run.paperIds.length !== 1 || loaded.run.baseline.contract !== BASELINE_CONTRACT
        || authority.productionAuthorized !== true || authority.authority.paperId !== `arxiv:${id}`
        || authority.authorityName !== loaded.run.baseline.authorityName
        || authority.authorityFileSha256 !== loaded.run.baseline.authorityFileSha256
        || authority.authority.authoritySha256 !== loaded.run.baseline.authoritySha256
        || authority.sourceSnapshotSha256 !== loaded.run.baseline.authoritySourceSnapshotSha256
        || authority.fulltextSha256 !== loaded.run.baseline.fulltextSha256
        || expected.authorityFileSha256 !== authority.authorityFileSha256
        || expected.authoritySha256 !== authority.authority.authoritySha256
        || expected.authoritySourceSnapshotSha256 !== authority.sourceSnapshotSha256) {
        fail('线上 arXiv 来源句柄与已准备的历史运行不符');
    }
    const details = arxivApi.readLiveProductionSourceDetails(authorityHandle);
    if (sha256(Buffer.from(details.text, 'utf8')) !== expected.sourceSha256
        || details.structuredArtifacts?.payloadSha256 !== expected.structuredArtifactsSha256) {
        fail('线上 arXiv 来源详情与已准备的历史运行不符');
    }
    return true;
}

module.exports = { BASELINE_CONTRACT, METADATA_CONTRACT, prepareHistoricalArxivRun,
    recoverHistoricalArxivRun, verifyHistoricalArxivRunAuthority,
    normalizedMetadata, normalizedMetadataProof };
