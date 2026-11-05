'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const runner = require('./fresh-rewrite-run.js');
const repair = require('./reader-repair.js');
const { MAX_READER_PATCH_NODES, MIN_READER_PATCH_NODES } = require('./reader-patch-limits');
const { reconstructReaderDraftFromVerifiedArticle } = require('./reader-signed-draft.js');
const codec = require('./protocol-codec');
const CONTRACT = 'reader-signed-operator';
const FACT_REVIEW = 'reader-operator-fact-review';
const currentHeader = () => codec.recordHeader(CONTRACT, CONTRACT);
function actualHeader(value) {
    if (!codec.hasValidHeader(value, CONTRACT)) throw new Error('Signed operator archive format differs');
    return codec.recordHeader(value.contract, CONTRACT, value.schemaFingerprint);
}
function sameHeader(value, expected) {
    return codec.hasValidHeader(value, CONTRACT)
        && require('node:util').isDeepStrictEqual(actualHeader(value), expected);
}
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const validSha = value => /^[a-f0-9]{64}$/.test(String(value || ''));
const sameKeys = (value, keys) => value && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');

function validateReaderOperatorPatchRequest(request, run) {
    if (!sameKeys(request, ['version', 'runId', 'paperId', 'parentPaperSha256', 'parentArticleSha256',
        'parentPlanSha256', 'sourceSha256', 'reason', 'patch']) || request.version !== 1
        || request.runId !== run.runId || !run.paperIds.includes(request.paperId)
        || !['parentPaperSha256','parentArticleSha256','parentPlanSha256','sourceSha256'].every(key => validSha(request[key]))
        || request.sourceSha256 !== run.sourceExpectations[request.paperId]?.sourceSha256
        || typeof request.reason !== 'string' || !request.reason.trim() || request.reason.length > 2000
        || !Array.isArray(request.patch?.replacements) || request.patch.replacements.length < MIN_READER_PATCH_NODES
        || request.patch.replacements.length > MAX_READER_PATCH_NODES) throw new Error('Invalid signed operator envelope/run/source');
    return request;
}

function checkParent(parent, request) {
    if (!parent || runner.stableHash(parent) !== request.parentPaperSha256
        || parent.apiReaderArticleSha256 !== request.parentArticleSha256
        || parent.apiReaderPlanSha256 !== request.parentPlanSha256
        || parent.sourceSha256 !== request.sourceSha256) throw new Error('Signed operator parent full-paper CAS mismatch');
}

function readerOperatorImplementationHashes() {
    return Object.fromEntries(['reader-signed-operator.js', 'reader-signed-draft.js', 'reader-repair.js']
        .map(name => [name, sha(fs.readFileSync(path.join(__dirname, name)))]));
}

// 只从配置的真实旧来源运行取得能力；调用方传来的同 SHA 对象不能自行授权。
function withOperatorSourceScope(run, paper, sourceDetails, callback) {
    const rootDir = require('../config.js').FILES.freshRewriteRunsDir;
    const loaded = runner.loadRun(run.runId, { rootDir });
    if (loaded.run.identitySha256 !== run.identitySha256
        || runner.stableHash(loaded.run.sourceExpectations) !== runner.stableHash(run.sourceExpectations)) {
        throw new Error('Signed operator physical run/source identity drift');
    }
    const fresh = require('./fresh-analysis-context.js');
    const verified = fresh.readFreshSource(loaded.runDir, paper, loaded.run);
    if (!verified || runner.stableHash(verified) !== runner.stableHash(sourceDetails)) {
        throw new Error('Signed operator physical source differs from supplied snapshot');
    }
    runner.assertFreshSourceRecordMatchesRun(paper, loaded.run, verified.freshSourceDescriptor);
    return fresh.withFreshAnalysisContext({ runDir: loaded.runDir, runId: loaded.run.runId,
        sourceExpectations: loaded.run.sourceExpectations }, () => callback(verified));
}

async function prepareReaderOperatorPatchResult(input) {
    return prepareReaderOperatorPatchResultWithHeader(input, currentHeader());
}

async function prepareReaderOperatorPatchResultWithHeader({ parent, sourceDetails, run, request, patchFileSha256, appliedAt }, header) {
    validateReaderOperatorPatchRequest(request, run); checkParent(parent, request);
    if (!validSha(patchFileSha256) || !Number.isFinite(Date.parse(appliedAt))) throw new Error('Invalid operator execution audit');
    return withOperatorSourceScope(run, parent, sourceDetails, verified =>
        prepareReaderOperatorPatchResultFromVerifiedSource({ parent, sourceDetails: verified, run,
            request, patchFileSha256, appliedAt }, header));
}

async function prepareReaderOperatorPatchResultFromVerifiedSource({ parent, sourceDetails, run, request, patchFileSha256, appliedAt }, header) {
    const draftRecovery = reconstructReaderDraftFromVerifiedArticle({ paper: parent, sourceDetails, runId: run.runId });
    const allowedPaths = request.patch.replacements.map(item => item?.path).filter(pointer =>
        /^\/(?:readerTitle|oneSentenceThesis)$|^\/(?:sections|conceptBridges|figurePlacements|tableBindings|formulaBindings)\/(?:0|[1-9]\d*)(?:\/body)?$/.test(pointer || ''));
    const draft = repair.applyReaderPatch(draftRecovery.draft, request.patch, allowedPaths,
        { availableFigureOrdinals: parent.apiReaderFigures.map(figure => figure.ordinal) });
    if (repair.hashDraft(draft) === draftRecovery.proof.draftSha256) throw new Error('Signed operator patch must change an existing node');
    const deep = require('../deep-analyzer.js');
    const patchExecutionRecord = { ...header, executionKind: 'operator', runId: run.runId,
        paperId: request.paperId, parentPaperSha256: request.parentPaperSha256,
        parentArticleSha256: request.parentArticleSha256, parentPlanSha256: request.parentPlanSha256,
        sourceSha256: request.sourceSha256, sourceSnapshotSha256: draftRecovery.proof.sourceSnapshotSha256,
        patchFileSha256, beforeDraftSha256: draftRecovery.proof.draftSha256, afterDraftSha256: repair.hashDraft(draft),
        reason: request.reason, appliedAt, implementationIdentity: readerOperatorImplementationHashes(),
        deepFinalizerSha256: sha(fs.readFileSync(path.join(__dirname, '../deep-analyzer.js'))),
        newApiRequests: 0, requiresFactReview: true };
    const paper = await deep.finalizeOperatorApiReaderArticleFromSource(
        structuredClone(parent), sourceDetails, draft, patchExecutionRecord
    );
    if (!require('../analysis-engine.js').hasValidIntegratedApiReaderRecords(paper)) throw new Error('Operator output failed production sealing');
    return { ...header, provenance: patchExecutionRecord, paper, paperSha256: runner.stableHash(paper) };
}

function readPrivate(filename, json = true) {
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
            || stat.size > 64 * 1024 * 1024) throw new Error('Signed operator file must be regular single-link 0600');
        const bytes = fs.readFileSync(fd);
        return { bytes, value: json ? JSON.parse(bytes.toString('utf8')) : bytes.toString('utf8'), sha256: sha(bytes) };
    } finally { fs.closeSync(fd); }
}

function optionalPrivate(filename) {
    try { return readPrivate(filename); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function immutable(filename, value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    try {
        const prior = readPrivate(filename);
        if (prior.sha256 !== sha(bytes)) throw new Error('Signed operator immutable archive drift');
        return prior;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // 临时文件先 fsync 再改名，避免崩溃后留下写了一半的审计文件。
    // 调用方持有运行操作锁和论文锁。
    const temp = path.join(path.dirname(filename), `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, filename);
    const directoryFd = fs.openSync(path.dirname(filename), 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    return readPrivate(filename);
}

// 只由持有操作锁的 runner 调用；在这里获取共享论文锁，
// 并在锁内重新读取运行记录。不接受任意输出路径。
async function applyReaderOperatorPatch({ loaded, patchFile }, deps) {
    require('../env-loader.js').requireExternalRuntime('reader-signed-operator.js');
    const { runDir, run } = loaded;
    if (path.resolve(runDir) !== path.join(path.resolve(deps.rootDir), run.runId)) throw new Error('Signed operator outside configured run root');
    runner.assertSafeDirectory(path.join(runDir, 'patches'));
    const filename = require('./reader-operator-patch.js').patchPath(runDir, patchFile);
    const requestFile = readPrivate(filename), request = validateReaderOperatorPatchRequest(requestFile.value, run);
    return deps.withPaperAnalysisLock({ arxivId: request.paperId }, async () => {
        let current = deps.reload();
        if (current.run.status === 'promoted') throw new Error('Promoted fresh run is immutable');
        const original = current.inputs.papers.find(paper => runner.paperId(paper) === request.paperId);
        const sourceDetails = deps.readFreshSource(runDir, original, current.run);
        if (!sourceDetails) throw new Error('Signed operator requires sealed source');
        const directory = path.join(runDir, 'patches', 'signed-operator-archive', requestFile.sha256);
        const intentFile = path.join(directory, 'intent.json');
        const readyFile = path.join(directory, 'ready-output.json');
        const outputFile = path.join(directory, 'output.json');
        let intent, before, ready, stored;
        try { runner.assertSafeDirectory(directory); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const savedIntent = optionalPrivate(intentFile);
        const parent = current.analysis.papers.find(paper => runner.paperId(paper) === request.paperId);
        let header, output;
        if (savedIntent) {
            intent = savedIntent.value;
            header = actualHeader(intent);
            const isCurrent = codec.isCurrentHeader(intent, CONTRACT);
            const fields = [...Object.keys(header), 'patchFileSha256', 'parentPaperSha256',
                'runIdentitySha256', 'sourceSnapshotSha256', 'appliedAt', 'outputSha256',
                ...(isCurrent ? ['readyOutputFileSha256'] : [])];
            before = readPrivate(path.join(directory, 'before.json')).value;
            if (!sameKeys(intent, fields) || intent.patchFileSha256 !== requestFile.sha256
                || intent.parentPaperSha256 !== request.parentPaperSha256
                || intent.runIdentitySha256 !== current.run.identitySha256
                || intent.sourceSnapshotSha256 !== sourceDetails.freshSourceDescriptor.sourceSnapshotSha256
                || !Number.isFinite(Date.parse(intent.appliedAt)) || !validSha(intent.outputSha256)
                || readPrivate(path.join(directory, 'request.json')).sha256 !== requestFile.sha256) {
                throw new Error('Signed operator intent/request drift');
            }
            checkParent(before, request);
            withOperatorSourceScope(current.run, before, sourceDetails, () =>
                reconstructReaderDraftFromVerifiedArticle({ paper: before, sourceDetails, runId: run.runId }));
            stored = optionalPrivate(outputFile);
            if (isCurrent) {
                ready = readPrivate(readyFile);
                if (!validSha(intent.readyOutputFileSha256) || ready.sha256 !== intent.readyOutputFileSha256
                    || (stored && !stored.bytes.equals(ready.bytes))) {
                    throw new Error('Signed operator prepared output bytes drift');
                }
            }
            output = (stored || ready)?.value;
            if (!output) {
                // Original intent-only archives may recover only the exact
                // original hash. Current code cannot substitute new digests.
                checkParent(parent, request);
                output = await prepareReaderOperatorPatchResultWithHeader({ parent: before, sourceDetails, run: current.run,
                    request, patchFileSha256: requestFile.sha256, appliedAt: intent.appliedAt }, header);
            }
        } else {
            checkParent(parent, request);
            before = parent;
            header = currentHeader();
            if (optionalPrivate(outputFile)) throw new Error('Signed operator output exists without its intent');
            const orphan = optionalPrivate(readyFile);
            // A pre-intent crash never upgrades raw JSON into a permit. The
            // original writer recomputes and compares any unbound ready bytes.
            output = await prepareReaderOperatorPatchResult({ parent, sourceDetails, run: current.run,
                request, patchFileSha256: requestFile.sha256,
                appliedAt: orphan ? orphan.value.provenance?.appliedAt : deps.now() });
            runner.assertSafeDirectory(directory, true);
            immutable(path.join(directory, 'before.json'), before);
            immutable(path.join(directory, 'request.json'), requestFile.bytes);
            ready = immutable(readyFile, output);
            if (deps.afterReady) await deps.afterReady();
            intent = { ...header, patchFileSha256: requestFile.sha256,
                parentPaperSha256: request.parentPaperSha256, runIdentitySha256: current.run.identitySha256,
                sourceSnapshotSha256: sourceDetails.freshSourceDescriptor.sourceSnapshotSha256,
                appliedAt: output.provenance.appliedAt, outputSha256: runner.stableHash(output),
                readyOutputFileSha256: ready.sha256 };
            immutable(intentFile, intent);
            if (deps.afterIntent) await deps.afterIntent();
        }
        if (runner.stableHash(output) !== intent.outputSha256
            || !sameHeader(output, header) || !sameHeader(output.provenance, header)
            || output.paperSha256 !== runner.stableHash(output.paper)
            || output.provenance.appliedAt !== intent.appliedAt
            || output.provenance.parentPaperSha256 !== request.parentPaperSha256
            || output.provenance.patchFileSha256 !== requestFile.sha256
            || output.provenance.sourceSnapshotSha256 !== sourceDetails.freshSourceDescriptor.sourceSnapshotSha256
            || !withOperatorSourceScope(current.run, output.paper, sourceDetails,
                () => require('../analysis-engine.js').hasValidIntegratedApiReaderRecords(output.paper))) throw new Error('Signed operator durable output drift');
        if (ready && readPrivate(readyFile).sha256 !== ready.sha256) {
            throw new Error('Signed operator prepared output bytes drift');
        }
        const installedOutput = immutable(outputFile, (stored || ready)?.bytes || output);
        if (deps.afterOutput) await deps.afterOutput();
        if (readPrivate(filename).sha256 !== requestFile.sha256) throw new Error('Signed operator patch bytes changed');
        if (readPrivate(outputFile).sha256 !== installedOutput.sha256
            || (ready && readPrivate(readyFile).sha256 !== ready.sha256)) {
            throw new Error('Signed operator durable output bytes drift');
        }
        const analysisPath = path.join(runDir, 'analysis.json');
        const installed = deps.updateJsonFileLocked(analysisPath, analysis => {
            const record = analysis.papers.find(paper => runner.paperId(paper) === request.paperId);
            const old = runner.stableHash(record) === request.parentPaperSha256;
            const already = runner.stableHash(record) === output.paperSha256;
            if (!old && !already) throw new Error('Signed operator install parent/output CAS mismatch');
            if (already && analysis.status === 'fact_review_pending') return undefined;
            return { ...analysis, generation: (analysis.generation || 0) + 1, status: 'fact_review_pending',
                operatorFactReviewBaseStatus: analysis.operatorFactReviewBaseStatus || analysis.status,
                papers: analysis.papers.map(paper => runner.paperId(paper) === request.paperId ? output.paper : paper) };
        });
        if (deps.afterAnalysis) await deps.afterAnalysis();
        const analysisSha256 = runner.readRegularJson(analysisPath).sha256;
        current = deps.reload();
        if (current.run.status !== 'fact_review_pending' || current.run.analysisSha256 !== analysisSha256) {
            deps.updateRun({ status: 'fact_review_pending', analysisSha256,
                operatorFactReviewBaseStatus: current.run.operatorFactReviewBaseStatus || current.run.status });
        }
        if (deps.afterRun) await deps.afterRun();
        return { runId: run.runId, paperId: request.paperId, executionKind: 'operator', status: 'fact_review_pending',
            articleSha256: output.paper.apiReaderArticleSha256, planSha256: output.paper.apiReaderPlanSha256,
            paperSha256: output.paperSha256, patchFileSha256: requestFile.sha256,
            generation: installed.generation, newApiRequests: 0, archive: path.relative(runDir, directory) };
    });
}

async function acceptReaderOperatorFactReview({ loaded, request }, deps) {
    require('../env-loader.js').requireExternalRuntime('reader-signed-operator fact acceptance');
    const { runDir, run } = loaded;
    const keys = ['runId','paperId','parentPaperSha256','articleSha256','planSha256','sourceSha256',
        'reportFile','reportSha256','reviewer','verdict'];
    if (!sameKeys(request, keys) || request.runId !== run.runId || !run.paperIds.includes(request.paperId)
        || path.resolve(runDir) !== path.join(path.resolve(deps.rootDir), run.runId)
        || !['parentPaperSha256','articleSha256','planSha256','sourceSha256','reportSha256'].every(key => validSha(request[key]))
        || request.verdict !== 'pass' || typeof request.reviewer !== 'string' || !request.reviewer.trim()
        || request.reviewer.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.md$/.test(request.reportFile || '')) {
        throw new Error('Invalid signed Reader fact-accept request');
    }
    return deps.withPaperAnalysisLock({ arxivId: request.paperId }, async () => {
        const current = deps.reload();
        if (current.run.status === 'promoted') throw new Error('Promoted fresh run is immutable');
        runner.assertSafeDirectory(path.join(runDir, 'source-audits'));
        const report = readPrivate(path.join(runDir, 'source-audits', request.reportFile), false);
        if (report.sha256 !== request.reportSha256 || !report.value.includes(request.paperId)
            || !['parentPaperSha256','articleSha256','planSha256','sourceSha256'].every(key => report.value.includes(request[key]))) {
            throw new Error('Independent fact report bytes or explicit Reader SHA bindings differ');
        }
        const source = deps.readFreshSource(runDir, current.inputs.papers.find(paper => runner.paperId(paper) === request.paperId), current.run);
        if (!source || source.freshSourceDescriptor.sourceSha256 !== request.sourceSha256) throw new Error('Fact acceptance source drift');
        const directory = path.join(runDir, 'patches', 'signed-fact-reviews', request.reportSha256);
        const filename = path.join(directory, `${request.paperId}.json`);
        let receipt;
        try { runner.assertSafeDirectory(directory); receipt = readPrivate(filename).value; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const parent = current.analysis.papers.find(paper => runner.paperId(paper) === request.paperId);
        if (!receipt) {
            if (runner.stableHash(parent) !== request.parentPaperSha256 || parent.readerFactReview?.status !== 'pending'
                || parent.analysisManifest?.stages?.apiReaderArticle?.executionKind !== 'operator'
                || parent.apiReaderArticleSha256 !== request.articleSha256 || parent.apiReaderPlanSha256 !== request.planSha256) {
                throw new Error('Fact acceptance requires the exact pending operator Reader');
            }
            withOperatorSourceScope(current.run, parent, source, () =>
                reconstructReaderDraftFromVerifiedArticle({ paper: parent, sourceDetails: source, runId: run.runId }));
            const accepted = structuredClone(parent);
            const header = codec.recordHeader(FACT_REVIEW, FACT_REVIEW);
            accepted.readerFactReview = { ...parent.readerFactReview, status: 'complete',
                ...header, parentPaperSha256: request.parentPaperSha256,
                sourceSha256: request.sourceSha256, reportFile: request.reportFile, reportSha256: request.reportSha256,
                reviewer: request.reviewer, verdict: 'pass', acceptedAt: deps.now() };
            receipt = { ...header, requestSha256: runner.stableHash(request),
                sourceSnapshotSha256: source.freshSourceDescriptor.sourceSnapshotSha256,
                beforePaperSha256: request.parentPaperSha256, afterPaperSha256: runner.stableHash(accepted), paper: accepted };
            runner.assertSafeDirectory(directory, true); immutable(filename, receipt);
        }
        const review = receipt.paper?.readerFactReview;
        if (!codec.hasValidHeader(receipt, FACT_REVIEW) || !codec.hasValidHeader(review, FACT_REVIEW)
            || review.contract !== receipt.contract || review.schemaFingerprint !== receipt.schemaFingerprint
            || review.status !== 'complete' || review.executionKind !== 'operator'
            || ['parentPaperSha256', 'articleSha256', 'planSha256', 'sourceSha256', 'reportFile',
                'reportSha256', 'reviewer', 'verdict'].some(key => review[key] !== request[key])
            || receipt.requestSha256 !== runner.stableHash(request)
            || receipt.sourceSnapshotSha256 !== source.freshSourceDescriptor.sourceSnapshotSha256
            || receipt.beforePaperSha256 !== request.parentPaperSha256 || receipt.afterPaperSha256 !== runner.stableHash(receipt.paper)
            || receipt.paper.apiReaderArticleSha256 !== request.articleSha256
            || receipt.paper.apiReaderPlanSha256 !== request.planSha256
            || receipt.paper.sourceSha256 !== request.sourceSha256
            || !withOperatorSourceScope(current.run, receipt.paper, source,
                () => require('../analysis-engine.js').hasValidIntegratedApiReaderRecords(receipt.paper))) throw new Error('Fact acceptance durable receipt drift');
        if (deps.afterFactReceipt) await deps.afterFactReceipt();
        if (readPrivate(path.join(runDir, 'source-audits', request.reportFile), false).sha256 !== request.reportSha256) {
            throw new Error('Fact report bytes changed before installation');
        }
        const analysisPath = path.join(runDir, 'analysis.json');
        const updated = deps.updateJsonFileLocked(analysisPath, analysis => {
            const record = analysis.papers.find(paper => runner.paperId(paper) === request.paperId);
            const currentSha = runner.stableHash(record);
            if (![receipt.beforePaperSha256, receipt.afterPaperSha256].includes(currentSha)) throw new Error('Fact acceptance full-paper CAS mismatch');
            const papers = analysis.papers.map(paper => runner.paperId(paper) === request.paperId ? receipt.paper : paper);
            const pending = papers.some(paper => paper.readerFactReview?.status === 'pending');
            const externalFailure = [analysis.status, current.run.status].find(value => /failed|failure/.test(String(value || '')));
            const baseline = [analysis.operatorFactReviewBaseStatus, current.run.operatorFactReviewBaseStatus]
                .find(value => /^fact_review/.test(String(value || ''))) || analysis.operatorFactReviewBaseStatus;
            const status = externalFailure || (pending ? 'fact_review_pending'
                : baseline === 'complete' ? (require('./fresh-analysis-context.js').withFreshAnalysisContext({
                    runDir, runId: current.run.runId, sourceExpectations: current.run.sourceExpectations
                }, () => papers.every(deps.isSuccessfulAnalysisRecord)) ? 'complete' : 'partial')
                    : baseline || analysis.status);
            if (currentSha === receipt.afterPaperSha256 && analysis.status === status) return undefined;
            return { ...analysis, papers, status };
        });
        if (deps.afterFactAnalysis) await deps.afterFactAnalysis();
        const analysisSha256 = runner.readRegularJson(analysisPath).sha256;
        const latest = deps.reload();
        const status = /failed|failure/.test(String(latest.run.status || '')) ? latest.run.status
            : /^fact_review/.test(String(latest.run.operatorFactReviewBaseStatus || '')) ? latest.run.operatorFactReviewBaseStatus
                : updated.status === 'partial' ? 'analysis_partial' : updated.status;
        if (latest.run.status !== status || latest.run.analysisSha256 !== analysisSha256) deps.updateRun({ status, analysisSha256 });
        return { runId: run.runId, paperId: request.paperId, status, factReview: 'complete',
            articleSha256: request.articleSha256, planSha256: request.planSha256,
            reportSha256: request.reportSha256, paperSha256: receipt.afterPaperSha256 };
    });
}

module.exports = { CONTRACT, validateReaderOperatorPatchRequest, prepareReaderOperatorPatchResult,
    applyReaderOperatorPatch, acceptReaderOperatorFactReview };
