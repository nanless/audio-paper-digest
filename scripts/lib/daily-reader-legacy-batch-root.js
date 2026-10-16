'use strict';
// Read-only authentication of the original failed-paper -> paid draft -> batch
// operator root. This is deliberately separate from retired API-paid readers.
const fs = require('node:fs'), path = require('node:path');
const { isDeepStrictEqual: equal } = require('node:util');
const daily = require('./daily-fresh-source-plan'), repair = require('./reader-repair');
const sha = require('./daily-fact-review').sha;
const CONTRACT = 'daily-reader-legacy-batch-root-v1';
const fail = message => { throw Object.assign(new Error(`旧批次Reader根拒绝：${message}`), { retryable: false }); };
const id = paper => require('../utils').normalizedId(paper);
function assertDescriptor(descriptor) {
    if (!descriptor || Object.keys(descriptor).sort().join(',') !==
        'authorizationFile,authorizationFileSha256,contract,failedParentFile,failedParentFileSha256'
        || descriptor.contract !== CONTRACT
        || !['authorizationFile', 'failedParentFile'].every(k => typeof descriptor[k] === 'string' && path.isAbsolute(descriptor[k]))
        || !['authorizationFileSha256', 'failedParentFileSha256'].every(k => /^[a-f0-9]{64}$/.test(descriptor[k] || '')))
        fail('须有真实失败父快照和原用户授权的精确文件SHA');
}
function readSnapshot(file, expected, root, json = true) {
    const relative = path.relative(path.resolve(root), path.resolve(file));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('文件超出受控运行目录');
    require('./fresh-rewrite-run').assertSafeDirectory(path.dirname(path.resolve(file)));
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 32 * 1024 * 1024)
            fail('须为有界0600普通独立文件');
        const bytes = fs.readFileSync(fd), digest = sha(bytes);
        if (!/^[a-f0-9]{64}$/.test(expected || '') || digest !== expected) fail('原文件SHA改变');
        return { file: path.resolve(file), sha256: digest, value: json ? JSON.parse(bytes) : bytes.toString('utf8') };
    } finally { fs.closeSync(fd); }
}
function failedParent(value, paper) {
    const matches = Array.isArray(value?.papers) ? value.papers.filter(p => id(p) === id(paper))
        : id(value) === id(paper) ? [value] : [];
    if (matches.length !== 1) fail('失败父快照论文缺失或重复');
    const parent = matches[0];
    if (parent.analysis !== null || typeof parent.analysisCheckpoint !== 'string' || !parent.analysisCheckpoint.trim()
        || parent.analysisManifest?.stages?.apiReaderArticle?.status !== 'invalid_output'
        || !parent.latestAnalysisAttemptError || parent.analysisCheckpoint !== paper.analysis
        || !equal(parent.analysisManifest.stages.scoringAudit, paper.analysisManifest?.stages?.scoringAudit))
        fail('须为真实未完成Reader父及逐字完整已评分检查点');
    const allowed = new Set(['analysisManifest', 'analysis', 'parsed', 'error',
        'latestAnalysisAttemptError', 'latestAnalysisAttemptErrorCode', 'latestAnalysisAttemptRetryable',
        'latestAnalysisAttemptErrorCategory', 'latestAnalysisAttemptErrorStatus',
        'latestAnalysisAttemptErrorScope', 'latestAnalysisAttemptAt']);
    for (const key of Object.keys(parent)) {
        if (!allowed.has(key) && !equal(parent[key], paper[key])) fail(`原非Reader字段改变：${key}`);
    }
    for (const [name, stage] of Object.entries(parent.analysisManifest.stages)) {
        if (!['apiReaderArticle', 'apiReaderTableAudit', 'imageSupplement', 'imageDownload'].includes(name)
            && !equal(stage, paper.analysisManifest.stages[name])) fail(`原上游阶段改变：${name}`);
    }
    return parent;
}
function assertLedger(record, envelope, stage, proof) {
    const payload = envelope.payload;
    for (const [name, value] of Object.entries(record.retainedCounters || {})) {
        if (!equal(value, payload[name])) fail(`原请求/失败账改变：${name}`);
    }
    for (const [name, field] of [['attempts', 'retainedAttempts'], ['fullAttempts', 'retainedFullAttempts'], ['noProgress', 'retainedNoProgress']]) {
        if (!Number.isSafeInteger(payload[name]) || payload[name] < 0 || proof[field] !== payload[name]
            || (name !== 'noProgress' && stage[name] !== payload[name])) fail('原尝试/全文/无进展账改变');
    }
    if ((stage.transportFailures || 0) !== (payload.transportFailures || 0)
        || daily.stableHash(payload.imageEvidence) !== stage.imageEvidenceSha256
        || repair.hashDraft(payload.ephemeralImageEvidence) !== stage.modelImagePreflightEvidenceSha256)
        fail('原传输或已见像素账改变');
}
function validateLegacyBatchRoot({ descriptor, paper, plan, source }) {
    assertDescriptor(descriptor);
    const stage = paper?.analysisManifest?.stages?.apiReaderArticle, proof = stage?.operatorProvenance;
    if (!stage || stage.status !== 'complete' || stage.executionKind !== 'operator'
        || stage.model !== 'operator-local' || stage.protocol !== 'local_operator'
        || stage.newReaderApiRequests !== 0 || stage.operatorHistory !== undefined || stage.originApiStage !== undefined
        || proof?.contract !== 'daily-reader-operator-correction-v1' || proof.executionKind !== 'operator'
        || proof.newReaderApiRequests !== 0 || proof.runId !== plan?.runId || proof.batchDate !== plan.batchDate
        || proof.paperId !== id(paper) || !/^[a-f0-9]{64}$/.test(stage.fingerprint || '')) fail('须为真实原批次operator根，不能伪造API或新历史');
    if (!require('./saved-fact-feedback').completedReaderUpstream(paper, plan)) fail('当前完整上游未通过正常资格');
    const authors = paper.apiReaderAuthors, resources = paper.apiReaderResources;
    const { identitySha256: resourceSha, ...resourceBody } = resources || {};
    if (!authors || daily.stableHash(authors) !== stage.readerAuthorsSha256
        || daily.stableHash(authors.identity) !== authors.identitySha256
        || authors.identitySha256 !== stage.readerAuthorIdentitySha256
        || !resources || daily.stableHash(resourceBody) !== resourceSha
        || resourceSha !== stage.resourceIdentitySha256) fail('原作者或资源完整身份改变');
    const official = daily.readDailyFreshSource(plan, paper);
    if (!equal(source, official) || !equal(proof.sourceDescriptor, official.freshSourceDescriptor)) fail('四源上下文不一致');
    const root = path.dirname(require('../config').FILES.dailyFreshSourceRunsDir), snapshots = [];
    const read = (file, digest, json = true) => {
        const snapshot = readSnapshot(file, digest, root, json); snapshots.push(snapshot); return snapshot.value;
    };
    const parent = failedParent(read(descriptor.failedParentFile, descriptor.failedParentFileSha256), paper);
    const manifest = read(proof.manifestFile, proof.manifestSha256);
    const record = read(proof.correctionFile, proof.correctionSha256);
    const authorization = read(descriptor.authorizationFile, descriptor.authorizationFileSha256);
    if (manifest.contract !== 'daily-reader-operator-correction-batch-v1'
        || manifest.runId !== plan.runId || manifest.batchDate !== plan.batchDate || manifest.authorization !== proof.authorization
        || authorization.contract !== 'daily-reader-operator-user-authorization-v1' || authorization.approved !== true
        || authorization.runId !== plan.runId || authorization.batchDate !== plan.batchDate
        || typeof authorization.userAnswer !== 'string' || !authorization.userAnswer.trim()
        || !proof.authorization.includes(descriptor.authorizationFileSha256)
        || !Array.isArray(manifest.correctionFiles) || manifest.correctionFiles.length < 1 || manifest.correctionFiles.length > 15
        || new Set(manifest.correctionFiles.map(f => path.resolve(f))).size !== manifest.correctionFiles.length
        || !Array.isArray(authorization.correctionRecords) || authorization.correctionRecords.length !== manifest.correctionFiles.length
        || new Set(authorization.correctionRecords.map(r => r.paperId)).size !== authorization.correctionRecords.length)
        fail('原批次清单或真实用户授权断链');
    const authFiles = authorization.correctionRecords.map(r => path.resolve(r.file)).sort();
    if (!equal(authFiles, manifest.correctionFiles.map(f => path.resolve(f)).sort())) fail('原授权没有覆盖精确批次');
    const index = read(path.join(path.dirname(descriptor.authorizationFile), 'review-index.json'), authorization.reviewIndexSha256);
    read(path.join(path.dirname(descriptor.authorizationFile), 'review.md'), authorization.reviewMarkdownSha256, false);
    if (index.runId !== plan.runId || index.batchDate !== plan.batchDate || index.newModelRequests !== 0
        || !equal(index.results, authorization.correctionRecords)) fail('原审阅清单与授权不同');
    for (const entry of authorization.correctionRecords) {
        const value = read(entry.file, entry.sha256);
        if (value.paperId !== entry.paperId || value.runId !== plan.runId || value.batchDate !== plan.batchDate
            || entry.nodes !== value.patch?.replacements?.length || !equal(entry.retainedCounters, value.retainedCounters))
            fail('原授权节点/计数/记录不同');
    }
    if (!manifest.correctionFiles.some(f => path.resolve(f) === path.resolve(proof.correctionFile))
        || record.paperId !== id(paper) || record.runId !== plan.runId || record.batchDate !== plan.batchDate
        || record.baselineCandidateFile !== proof.originalCandidateFile
        || record.baselineCandidateEnvelopeSha256 !== proof.originalCandidateEnvelopeSha256
        || record.baselineDraftSha256 !== proof.beforeDraftSha256
        || !equal(record.sourceDescriptor, official.freshSourceDescriptor)) fail('原批次修正记录或四源断链');
    read(proof.originalCandidateFile, proof.originalCandidateEnvelopeSha256);
    const checked = repair.readFailedCandidateEnvelope(plan.readerAttemptsDir, null, proof.originalCandidateFile);
    if (!checked || repair.hashDraft(checked.envelope.identity) !== proof.originalIdentitySha256) fail('原active付费档身份不同');
    const envelope = checked.envelope, identity = envelope.identity;
    if (identity.paperId !== paper.arxivId || identity.sourceSha256 !== paper.sourceSha256
        || identity.freshAnalysis?.runId !== plan.runId || identity.freshAnalysis?.sourceOnly !== true
        || ['sourceSha256', 'sourceManifestSha256', 'sourceSnapshotSha256', 'structuredArtifactsSha256', 'sourceGeneration']
            .some(k => identity.freshAnalysis[k] !== official.freshSourceDescriptor[k])
        || identity.promptSha256 !== stage.promptTemplateSha256 || identity.repairPromptSha256 !== stage.repairPromptTemplateSha256)
        fail('真实付费输入与原四源不同');
    assertLedger(record, envelope, stage, proof);
    const draft = require('./daily-reader-operator-correction').replay(record, envelope);
    if (repair.hashDraft(draft) !== proof.afterDraftSha256) fail('公共原补丁重放终点不同');
    const deep = require('../deep-analyzer');
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(draft), {
        arxivId: paper.arxivId, requiredVersion: 3, requireIntegratedTables: true, minimumIntegratedTables: 2,
        requireSourceBindings: true, allowDeterministicQuoteRepair: true,
        allowDeterministicUnsupportedClaimPruning: true, enforceResourceAvailabilityClaims: true,
        verifiedResourceIdentity: paper.apiReaderResources, structuredArtifacts: source.structuredArtifacts, sourceText: source.text,
        availableFigureOrdinals: envelope.payload.imageEvidence.filter(i => i.status === 'ready' && i.kind === 'figure').map(i => i.ordinal)
    });
    const rendered = deep.injectApiReaderFigures(parsed, source.structuredArtifacts, paper.arxivId);
    const figures = rendered.figures.map(figure => {
        const old = paper.apiReaderFigures?.find(f => f.ordinal === figure.ordinal);
        const image = envelope.payload.imageEvidence.find(i => i.kind === 'figure' && i.status === 'ready' && i.ordinal === figure.ordinal);
        if (!old || !image || image.url !== figure.url || old.assetSha256 !== image.sha256
            || image.sourceSha256 !== image.sha256 || !/^[a-f0-9]{64}$/.test(image.modelPayloadSha256 || '')) fail('原图像素身份不同');
        return { ...figure, assetSha256: image.sha256 };
    });
    if (!equal(figures, paper.apiReaderFigures) || !equal(rendered.plan, paper.apiReaderPlan)
        || deep.normalizeApiReaderFigureMarkdown(rendered.article, figures) !== paper.apiReaderArticle
        || stage.articleSha256 !== paper.apiReaderArticleSha256 || stage.planSha256 !== paper.apiReaderPlanSha256
        || sha(paper.apiReaderArticle) !== paper.apiReaderArticleSha256
        || daily.stableHash(paper.apiReaderPlan) !== paper.apiReaderPlanSha256
        || daily.stableHash(figures) !== stage.figuresSha256) fail('原paid与真实批次补丁不能逐字重放当前完整Reader');
    const assertUnchanged = () => {
        for (const snapshot of snapshots) readSnapshot(snapshot.file, snapshot.sha256, root, false);
        if (!equal(official, daily.readDailyFreshSource(plan, paper))) fail('四源在核验后改变');
    };
    assertUnchanged();
    return { envelope, identitySha: repair.hashDraft(identity), draft, rootStage: structuredClone(stage),
        rootPaper: structuredClone(paper), failedParent: parent, snapshots, assertUnchanged };
}
module.exports = { CONTRACT, assertDescriptor, validateLegacyBatchRoot };
