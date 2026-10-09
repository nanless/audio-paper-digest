'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const repair = require('./reader-repair.js');
const { READER_SOURCE_CONTENT_MODE, READER_SIGNED_REVISION_CONTENT_MODE } = require('./reader-contract.js');
const CONTRACT = 'reader-operator-patch-v1';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const isSha = value => /^[a-f0-9]{64}$/.test(String(value || ''));
const same = (a, b) => repair.hashDraft(a) === repair.hashDraft(b);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');

function readPrivate(filename) {
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 20 * 1024 * 1024) {
            throw new Error('Operator patch requires a regular single-link 0600 file within the run');
        }
        const bytes = fs.readFileSync(fd);
        return { bytes, sha256: sha(bytes), value: JSON.parse(bytes.toString('utf8')) };
    } finally { fs.closeSync(fd); }
}

function syncDirectory(directory) {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function installImmutable(filename, bytes) {
    try {
        const existing = readPrivate(filename);
        if (!existing.bytes.equals(bytes)) throw new Error('operator patch 的不可变审计字节已变化');
        return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
    let fd;
    try {
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        // 调用方持有 run 锁和论文锁。上面已经检查过已提交的审计文件，这些文件按设计
        // 从不覆盖。
        fs.renameSync(temporary, filename);
        syncDirectory(path.dirname(filename));
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}

function patchPath(runDir, name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.json$/.test(name)) {
        throw new Error('--patch 必须指向本次运行 run/patches 目录内的 JSON 文件');
    }
    return path.join(runDir, 'patches', name);
}

function validateRequest(value, run) {
    if (!exactKeys(value, ['paperId', 'candidateIdentitySha256', 'sourceSha256', 'reason', 'patch'])
        || !/^\d{4}\.\d{4,5}$/.test(value.paperId || '') || !run.paperIds.includes(value.paperId)
        || !isSha(value.candidateIdentitySha256) || !isSha(value.sourceSha256)
        || value.sourceSha256 !== run.sourceExpectations[value.paperId]?.sourceSha256
        || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 2000) {
        throw new Error('operator patch 的信封或运行／来源范围无效');
    }
    if (!Array.isArray(value.patch?.replacements) || value.patch.replacements.length < 1 || value.patch.replacements.length > 8) {
        throw new Error('operator patch 需要 1 到 8 处已有节点替换');
    }
    return value;
}

function parserOptions(details, identity, payload, deps) {
    const descriptor = details?.freshSourceDescriptor;
    const fresh = identity.freshAnalysis;
    if (!descriptor || identity.paperId !== descriptor.paperId || identity.sourceSha256 !== descriptor.sourceSha256
        || fresh?.contract !== 'fresh-source-analysis-v1' || fresh.runId !== descriptor.runId
        || fresh.paperId !== descriptor.paperId || fresh.sourceSha256 !== descriptor.sourceSha256
        || fresh.structuredArtifactsSha256 !== descriptor.structuredArtifactsSha256
        || fresh.sourceSnapshotSha256 !== descriptor.sourceSnapshotSha256
        || fresh.sourceOnly !== true || fresh.oldGeneratedTextIncluded !== false
        || ![READER_SOURCE_CONTENT_MODE, READER_SIGNED_REVISION_CONTENT_MODE].includes(identity.contentMode)
        || sha(details.text || '') !== descriptor.sourceSha256
        || details.structuredArtifacts?.payloadSha256 !== descriptor.structuredArtifactsSha256) {
        throw new Error('Operator patch candidate is not bound to the current fresh source snapshot');
    }
    const images = payload.imageEvidence;
    if (!Array.isArray(images) || new Set(images.map(image => image?.ordinal)).size !== images.length
        || images.some(image => !Number.isInteger(image?.ordinal) || !isSha(image.sha256)
            || !(details.structuredArtifacts.figures || []).some(figure => figure.ordinal === image.ordinal
                && (figure.images || []).some(source => source.url === image.url && source.url)))) {
        throw new Error('operator patch 的图片证据缺失，或不在原始来源内');
    }
    const evidence = deps.buildApiReaderEvidenceContext('', details.text, details.structuredArtifacts, identity.paperId);
    const availableTableCount = [...String(evidence).matchAll(/^TABLE_(\d+):/gm)].length;
    const minimumIntegratedTables = require('./reader-contract.js').readerRequirements({ version: 3, availableTableCount }).minimumTables;
    return { requiredVersion: 3, requireIntegratedTables: true, minimumIntegratedTables,
        availableFigureOrdinals: images.map(image => image.ordinal), requireSourceBindings: true,
        allowDeterministicQuoteRepair: true, structuredArtifacts: details.structuredArtifacts, sourceText: details.text };
}

function dependencies(overrides) {
    return { rootDir: require('../config.js').FILES.freshRewriteRunsDir,
        readFreshSource: (...args) => require('./fresh-analysis-context.js').readFreshSource(...args),
        withPaperAnalysisLock: (...args) => require('../analysis-engine.js').withPaperAnalysisLock(...args),
        isSuccessfulAnalysisRecord: (...args) => require('../analysis-engine.js').isSuccessfulAnalysisRecord(...args),
        readCurrentPaper: (runDir, paperId) => readPrivate(path.join(runDir, 'analysis.json')).value.papers
            .find(paper => (paper.arxivId || paper.paper_id) === paperId),
        parseApiReaderArticleResult: (...args) => require('../deep-analyzer.js').parseApiReaderArticleResult(...args),
        buildApiReaderEvidenceContext: (...args) => require('../deep-analyzer.js').buildApiReaderEvidenceContext(...args),
        now: () => new Date().toISOString(), ...overrides };
}

function validateScratchParent(current, identity, details, run, deps) {
    const { hasValidApiReaderV3Records } = require('../analysis-engine.js');
    if (!current || (current.arxivId || current.paper_id) !== identity.paperId) {
        throw new Error('operator patch 需要当前同一次运行的分析记录');
    }
    if (identity.contentMode === READER_SOURCE_CONTENT_MODE) {
        if (hasValidApiReaderV3Records(current) || deps.isSuccessfulAnalysisRecord(current)) {
            throw new Error('Source-only operator patch cannot edit a successful analysis or signed Reader');
        }
        return;
    }
    // 这里只允许改失败留下的 scratch。signed-revision 服务在消费候选之前仍须重新算
    // 出「父记录 + 反馈」的输入身份；当前父记录有效不等于就是一份 revision 凭据。
    if (current.latestAnalysisAttemptError || !hasValidApiReaderV3Records(current)) {
        throw new Error('Signed-revision operator patch requires a valid signed parent Reader');
    }
    require('./fresh-rewrite-run.js').assertFreshSourceRecordMatchesRun(current, run, details.freshSourceDescriptor);
    if (current.sourceSha256 !== identity.sourceSha256
        || current.analysisManifest.sourceAcquisition.structuredArtifactsSha256
            !== details.freshSourceDescriptor.structuredArtifactsSha256) {
        throw new Error('已签名修订的父 Reader 具有不同的来源或产物快照');
    }
}

async function applyOperatorPatch({ loaded, patchFile }, overrides = {}) {
    require('../env-loader.js').requireExternalRuntime('reader-operator-patch.js');
    const deps = dependencies(overrides);
    const { assertSafeDirectory, stableHash } = require('./fresh-rewrite-run.js');
    const { runDir, run, inputs } = loaded;
    if (run.status === 'promoted') throw new Error('已提升的 fresh 运行不可修改');
    if (path.resolve(runDir) !== path.join(path.resolve(deps.rootDir), run.runId)) {
        throw new Error('operator patch 必须使用配置好的 fresh 运行根目录');
    }
    assertSafeDirectory(path.join(runDir, 'patches'));
    const filename = patchPath(runDir, patchFile);
    const requestFile = readPrivate(filename);
    const request = validateRequest(requestFile.value, run);
    const paper = inputs.papers.find(item => (item.arxivId || item.paper_id) === request.paperId);
    if (!paper) throw new Error('operator patch 的论文不在原始运行输入中');
    return deps.withPaperAnalysisLock(paper, async () => {
        const details = deps.readFreshSource(runDir, paper, run);
        if (!details) throw new Error('operator patch 需要经过核验的原始来源缓存');
        const directory = assertSafeDirectory(path.join(runDir, 'reader-attempts'));
        const candidateFile = path.join(directory, `${request.candidateIdentitySha256}.json`);
        const before = readPrivate(candidateFile);
        const identity = before.value.identity;
        if (repair.hashDraft(identity) !== request.candidateIdentitySha256 || identity.paperId !== request.paperId
            || identity.freshAnalysis?.runId !== run.runId
            || identity.freshAnalysis?.inputSetSha256 !== stableHash(run.paperIds.slice().sort())) {
            throw new Error('Operator patch candidate identity or run paper-set mismatch');
        }
        const payload = repair.loadFailedCandidate(directory, identity);
        if (!payload?.draft || !same(payload, before.value.payload)) throw new Error('operator patch 需要未发生变化的活跃失败草稿');
        // 只按哈希命名的文件才是活跃的；已解析或已迁移的审计文件不算。
        for (const name of fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
            if (name === path.basename(candidateFile)) continue;
            if (readPrivate(path.join(directory, name)).value.identity?.paperId === request.paperId) {
                throw new Error('Operator patch has multiple active candidates for this paper');
            }
        }
        const options = parserOptions(details, identity, payload, deps);
        validateScratchParent(deps.readCurrentPaper(runDir, request.paperId), identity, details, run, deps);
        const archiveDir = path.join(runDir, 'patches', 'operator-archive', requestFile.sha256);
        if (payload.operatorPatches !== undefined && !Array.isArray(payload.operatorPatches)) {
            throw new Error('operator patch 的审计历史格式错误');
        }
        const auditEntry = (payload.operatorPatches || []).find(entry => entry.patchFileSha256 === requestFile.sha256);
        if (auditEntry) {
            assertSafeDirectory(archiveDir);
            const intent = readPrivate(path.join(archiveDir, 'intent.json')).value;
            if (!same(intent.audit, auditEntry) || intent.afterPayloadSha256 !== repair.hashDraft(payload)
                || auditEntry.afterDraftSha256 !== repair.hashDraft(payload.draft)
                || readPrivate(path.join(archiveDir, 'before.json')).sha256 !== auditEntry.oldEnvelopeSha256
                || readPrivate(path.join(archiveDir, 'patch.json')).sha256 !== requestFile.sha256) {
                throw new Error('Operator patch replay audit or current draft drifted');
            }
            deps.parseApiReaderArticleResult(JSON.stringify(payload.draft), options);
            return { runId: run.runId, paperId: request.paperId, status: 'failed', operatorPatchApplied: true,
                alreadyApplied: true, draftSha256: auditEntry.afterDraftSha256, patchFileSha256: requestFile.sha256 };
        }
        const allowedPaths = request.patch.replacements.map(item => item?.path).filter(pointer =>
            /^\/(?:readerTitle|oneSentenceThesis)$|^\/(?:sections|conceptBridges|figurePlacements|tableBindings|formulaBindings)\/(?:0|[1-9]\d*)(?:\/body)?$/.test(pointer || ''));
        const draft = repair.applyReaderPatch(payload.draft, request.patch, allowedPaths,
            { availableFigureOrdinals: options.availableFigureOrdinals });
        if (!repair.parseRepairableDraft(draft) || repair.hashDraft(draft) === repair.hashDraft(payload.draft)) {
            throw new Error('operator patch 必须改动一个已有的有效草稿节点');
        }
        // 生产解析器是唯一的验收闸门。它返回的文章按设计被丢弃：这次操作发不出成功
        // 证明。
        deps.parseApiReaderArticleResult(JSON.stringify(draft), options);
        const audit = { contract: CONTRACT, runId: run.runId, paperId: request.paperId,
            candidateIdentitySha256: request.candidateIdentitySha256, patchFileSha256: requestFile.sha256,
            sourceSha256: request.sourceSha256, reason: request.reason,
            beforeDraftSha256: repair.hashDraft(payload.draft), afterDraftSha256: repair.hashDraft(draft),
            oldPayloadSha256: before.value.payloadSha256, oldEnvelopeSha256: before.sha256,
            archive: path.relative(runDir, archiveDir), appliedAt: deps.now() };
        let intent;
        try {
            assertSafeDirectory(archiveDir);
            intent = readPrivate(path.join(archiveDir, 'intent.json')).value;
            if (!same({ ...intent.audit, appliedAt: audit.appliedAt }, audit)) throw new Error('Operator patch pending intent drifted');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const committedAudit = intent?.audit || audit;
        const updated = { ...payload, draft, rawDraft: JSON.stringify(draft), status: 'failed',
            operatorPatches: [...(payload.operatorPatches || []), committedAudit] };
        const expectedIntent = { contract: CONTRACT, audit: committedAudit, afterPayloadSha256: repair.hashDraft(updated) };
        if (intent && !same(intent, expectedIntent)) throw new Error('operator patch 的待处理载荷已变化');
        if (Buffer.byteLength(JSON.stringify({ version: repair.REPAIR_VERSION, identity,
            payload: updated, payloadSha256: repair.hashDraft(updated) })) > 20 * 1024 * 1024) {
            throw new Error('operator patch 已超出 Reader 候选大小预算');
        }
        // 完整解析器跑通之前不写任何候选或审计文件。
        assertSafeDirectory(archiveDir, true);
        installImmutable(path.join(archiveDir, 'before.json'), before.bytes);
        installImmutable(path.join(archiveDir, 'patch.json'), requestFile.bytes);
        installImmutable(path.join(archiveDir, 'intent.json'), Buffer.from(JSON.stringify(expectedIntent)));
        syncDirectory(path.dirname(archiveDir));
        syncDirectory(path.join(runDir, 'patches'));
        if (deps.afterArchive) await deps.afterArchive();
        if (readPrivate(candidateFile).sha256 !== before.sha256 || readPrivate(filename).sha256 !== requestFile.sha256) {
            throw new Error('Operator patch candidate/request bytes changed before save');
        }
        repair.saveFailedCandidate(directory, identity, updated);
        syncDirectory(directory);
        if (deps.afterSave) await deps.afterSave();
        const saved = repair.loadFailedCandidate(directory, identity);
        if (!same(saved, updated)) throw new Error('operator patch 的保存未能重放');
        return { runId: run.runId, paperId: request.paperId, status: 'failed', operatorPatchApplied: true,
            alreadyApplied: false, draftSha256: committedAudit.afterDraftSha256, patchFileSha256: requestFile.sha256,
            archive: committedAudit.archive };
    });
}

module.exports = { CONTRACT, applyOperatorPatch, patchPath, readerOperatorParserOptions: parserOptions };
