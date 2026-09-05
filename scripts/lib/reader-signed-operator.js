'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const runner = require('./fresh-rewrite-run.js');
const repair = require('./reader-repair.js');
const { recoverSignedReaderDraft } = require('./reader-signed-draft.js');
const CONTRACT = 'reader-signed-operator-v1';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const validSha = value => /^[a-f0-9]{64}$/.test(String(value || ''));
const sameKeys = (value, keys) => value && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');

function validateSignedOperatorRequest(request, run) {
    if (!sameKeys(request, ['version', 'runId', 'paperId', 'parentPaperSha256', 'parentArticleSha256',
        'parentPlanSha256', 'sourceSha256', 'reason', 'patch']) || request.version !== 1
        || request.runId !== run.runId || !run.paperIds.includes(request.paperId)
        || !['parentPaperSha256','parentArticleSha256','parentPlanSha256','sourceSha256'].every(key => validSha(request[key]))
        || request.sourceSha256 !== run.sourceExpectations[request.paperId]?.sourceSha256
        || typeof request.reason !== 'string' || !request.reason.trim() || request.reason.length > 2000
        || !Array.isArray(request.patch?.replacements) || request.patch.replacements.length < 1
        || request.patch.replacements.length > 8) throw new Error('Invalid signed operator envelope/run/source');
    return request;
}

function checkParent(parent, request) {
    if (!parent || runner.stableHash(parent) !== request.parentPaperSha256
        || parent.apiReaderArticleSha256 !== request.parentArticleSha256
        || parent.apiReaderPlanSha256 !== request.parentPlanSha256
        || parent.sourceSha256 !== request.sourceSha256) throw new Error('Signed operator parent full-paper CAS mismatch');
}

function implementationIdentity() {
    return Object.fromEntries(['reader-signed-operator.js', 'reader-signed-draft.js', 'reader-repair.js']
        .map(name => [name, sha(fs.readFileSync(path.join(__dirname, name)))]));
}

async function prepareSignedReaderOperatorResult({ parent, sourceDetails, run, request, patchFileSha256, appliedAt }) {
    validateSignedOperatorRequest(request, run); checkParent(parent, request);
    if (!validSha(patchFileSha256) || !Number.isFinite(Date.parse(appliedAt))) throw new Error('Invalid operator execution audit');
    const inverse = recoverSignedReaderDraft({ paper: parent, sourceDetails, runId: run.runId });
    const allowedPaths = request.patch.replacements.map(item => item?.path).filter(pointer =>
        /^\/(?:readerTitle|oneSentenceThesis)$|^\/(?:sections|conceptBridges|figurePlacements|tableBindings|formulaBindings)\/(?:0|[1-9]\d*)(?:\/body)?$/.test(pointer || ''));
    const draft = repair.applyReaderPatch(inverse.draft, request.patch, allowedPaths,
        { availableFigureOrdinals: parent.apiReaderFigures.map(figure => figure.ordinal) });
    if (repair.hashDraft(draft) === inverse.proof.draftSha256) throw new Error('Signed operator patch must change an existing node');
    const deep = require('../deep-analyzer.js');
    const provenance = { contract: CONTRACT, executionKind: 'operator', runId: run.runId,
        paperId: request.paperId, parentPaperSha256: request.parentPaperSha256,
        parentArticleSha256: request.parentArticleSha256, parentPlanSha256: request.parentPlanSha256,
        sourceSha256: request.sourceSha256, sourceSnapshotSha256: inverse.proof.sourceSnapshotSha256,
        patchFileSha256, beforeDraftSha256: inverse.proof.draftSha256, afterDraftSha256: repair.hashDraft(draft),
        reason: request.reason, appliedAt, implementationIdentity: implementationIdentity(),
        deepFinalizerSha256: sha(fs.readFileSync(path.join(__dirname, '../deep-analyzer.js'))),
        newApiRequests: 0, requiresFactReview: true };
    const paper = await deep.finalizeOperatorApiReaderArticleFromSource(
        structuredClone(parent), sourceDetails, draft, provenance
    );
    if (!require('../analysis-engine.js').apiReaderV3BindsCanonical(paper)) throw new Error('Operator output failed production sealing');
    return { contract: CONTRACT, provenance, paper, paperSha256: runner.stableHash(paper) };
}

function readPrivate(filename, json = true) {
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
            || stat.size > 64 * 1024 * 1024) throw new Error('Signed operator file must be regular single-link 0600');
        const bytes = fs.readFileSync(fd);
        return { bytes, value: json ? JSON.parse(bytes.toString('utf8')) : bytes.toString('utf8'), sha256: sha(bytes) };
    } finally { fs.closeSync(fd); }
}

function immutable(filename, value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    try {
        const prior = readPrivate(filename);
        if (prior.sha256 !== sha(bytes)) throw new Error('Signed operator immutable archive drift');
        return prior;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // A temporary fsynced file plus rename avoids exposing half-written audit
    // files after a crash. Caller holds the run operation and paper locks.
    const temp = path.join(path.dirname(filename), `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, filename);
    const directoryFd = fs.openSync(path.dirname(filename), 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    return readPrivate(filename);
}

// Called only by the operation-locked runner; acquire the shared paper lock
// here, and reload the run again inside it. No arbitrary output paths.
async function applySignedReaderOperator({ loaded, patchFile }, deps) {
    require('../env-loader.js').requireExternalRuntime('reader-signed-operator.js');
    const { runDir, run } = loaded;
    if (path.resolve(runDir) !== path.join(path.resolve(deps.rootDir), run.runId)) throw new Error('Signed operator outside configured run root');
    runner.assertSafeDirectory(path.join(runDir, 'patches'));
    const filename = require('./reader-operator-patch.js').patchPath(runDir, patchFile);
    const requestFile = readPrivate(filename), request = validateSignedOperatorRequest(requestFile.value, run);
    return deps.withPaperAnalysisLock({ arxivId: request.paperId }, async () => {
        let current = deps.reload();
        if (current.run.status === 'promoted') throw new Error('Promoted fresh run is immutable');
        const original = current.inputs.papers.find(paper => runner.paperId(paper) === request.paperId);
        const sourceDetails = deps.readFreshSource(runDir, original, current.run);
        if (!sourceDetails) throw new Error('Signed operator requires sealed source');
        const directory = path.join(runDir, 'patches', 'signed-operator-archive', requestFile.sha256);
        let output, intent, before;
        try {
            runner.assertSafeDirectory(directory);
            intent = readPrivate(path.join(directory, 'intent.json')).value;
            before = readPrivate(path.join(directory, 'before.json')).value;
            if (intent.contract !== CONTRACT || intent.patchFileSha256 !== requestFile.sha256
                || intent.parentPaperSha256 !== request.parentPaperSha256
                || intent.runIdentitySha256 !== current.run.identitySha256
                || intent.sourceSnapshotSha256 !== sourceDetails.freshSourceDescriptor.sourceSnapshotSha256
                || readPrivate(path.join(directory, 'request.json')).sha256 !== requestFile.sha256) {
                throw new Error('Signed operator intent/request drift');
            }
            checkParent(before, request);
            recoverSignedReaderDraft({ paper: before, sourceDetails, runId: run.runId });
            try { output = readPrivate(path.join(directory, 'output.json')).value; }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const parent = current.analysis.papers.find(paper => runner.paperId(paper) === request.paperId);
        if (!intent) {
            checkParent(parent, request);
            // All content/figure validation must succeed before archiving.
            output = await prepareSignedReaderOperatorResult({ parent, sourceDetails, run: current.run,
                request, patchFileSha256: requestFile.sha256, appliedAt: deps.now() });
            before = parent;
            runner.assertSafeDirectory(directory, true);
            immutable(path.join(directory, 'before.json'), before);
            immutable(path.join(directory, 'request.json'), requestFile.bytes);
            intent = { contract: CONTRACT, patchFileSha256: requestFile.sha256,
                parentPaperSha256: request.parentPaperSha256, runIdentitySha256: current.run.identitySha256,
                sourceSnapshotSha256: sourceDetails.freshSourceDescriptor.sourceSnapshotSha256,
                appliedAt: output.provenance.appliedAt, outputSha256: runner.stableHash(output) };
            immutable(path.join(directory, 'intent.json'), intent);
            if (deps.afterIntent) await deps.afterIntent();
        }
        if (!output) {
            checkParent(parent, request);
            output = await prepareSignedReaderOperatorResult({ parent: before, sourceDetails, run: current.run,
                request, patchFileSha256: requestFile.sha256, appliedAt: intent.appliedAt });
        }
        if (runner.stableHash(output) !== intent.outputSha256
            || output.contract !== CONTRACT || output.paperSha256 !== runner.stableHash(output.paper)
            || output.provenance.parentPaperSha256 !== request.parentPaperSha256
            || output.provenance.patchFileSha256 !== requestFile.sha256
            || output.provenance.sourceSnapshotSha256 !== sourceDetails.freshSourceDescriptor.sourceSnapshotSha256
            || !require('../analysis-engine.js').apiReaderV3BindsCanonical(output.paper)) throw new Error('Signed operator durable output drift');
        immutable(path.join(directory, 'output.json'), output);
        if (deps.afterOutput) await deps.afterOutput();
        if (readPrivate(filename).sha256 !== requestFile.sha256) throw new Error('Signed operator patch bytes changed');
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

async function acceptSignedReaderFactReview({ loaded, request }, deps) {
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
            recoverSignedReaderDraft({ paper: parent, sourceDetails: source, runId: run.runId });
            const accepted = structuredClone(parent);
            accepted.readerFactReview = { ...parent.readerFactReview, status: 'complete',
                contract: 'reader-operator-fact-review-v1', parentPaperSha256: request.parentPaperSha256,
                sourceSha256: request.sourceSha256, reportFile: request.reportFile, reportSha256: request.reportSha256,
                reviewer: request.reviewer, verdict: 'pass', acceptedAt: deps.now() };
            receipt = { contract: 'reader-operator-fact-review-v1', requestSha256: runner.stableHash(request),
                sourceSnapshotSha256: source.freshSourceDescriptor.sourceSnapshotSha256,
                beforePaperSha256: request.parentPaperSha256, afterPaperSha256: runner.stableHash(accepted), paper: accepted };
            runner.assertSafeDirectory(directory, true); immutable(filename, receipt);
        }
        if (receipt.contract !== 'reader-operator-fact-review-v1' || receipt.requestSha256 !== runner.stableHash(request)
            || receipt.sourceSnapshotSha256 !== source.freshSourceDescriptor.sourceSnapshotSha256
            || receipt.beforePaperSha256 !== request.parentPaperSha256 || receipt.afterPaperSha256 !== runner.stableHash(receipt.paper)
            || receipt.paper.apiReaderArticleSha256 !== request.articleSha256
            || receipt.paper.apiReaderPlanSha256 !== request.planSha256
            || receipt.paper.sourceSha256 !== request.sourceSha256
            || !require('../analysis-engine.js').apiReaderV3BindsCanonical(receipt.paper)) throw new Error('Fact acceptance durable receipt drift');
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
                : baseline === 'complete' ? (papers.every(deps.isSuccessfulAnalysisRecord) ? 'complete' : 'partial')
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

module.exports = { CONTRACT, validateSignedOperatorRequest, prepareSignedReaderOperatorResult,
    applySignedReaderOperator, acceptSignedReaderFactReview };
