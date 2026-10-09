'use strict';

// 根据已完成且绑定原论文来源的历史分析，确定标签分配；不读取旧博客标签，也不调用模型。

const crypto = require('node:crypto');
const path = require('node:path');
const tagCatalogApi = require('./tag-catalog.js');
const fresh = require('./fresh-rewrite-run.js');
const { writeImmutableFile } = require('./immutable-file.js');

const CONTRACT = 'paper-tag-assignment-v2';
const VERSION = 2;
const LEGACY_CONTRACT = 'paper-taxonomy-assignment-v1';
const HISTORICAL_BASELINE_CONTRACT = 'historical-arxiv-authority-baseline-v1';
const UUID_RE = fresh.UUID_RE || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const HANDLES = new WeakSet();
const HANDLE_DATA = new WeakMap();
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const stableHash = fresh.stableHash;

function fail(message) {
    const error = new Error(`历史标签分配记录核验失败：${message}`);
    error.code = 'HISTORICAL_TAG_ASSIGNMENT_INTEGRITY';
    error.retryable = false;
    throw error;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function canonicalBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function paperIdOf(paper) { return `arxiv:${fresh.paperId(paper)}`; }

function loadCompletedHistoricalAnalysisRun({ analysisRoot, runId } = {}, dependencies = {}) {
    if (typeof analysisRoot !== 'string' || !path.isAbsolute(analysisRoot) || !UUID_RE.test(String(runId || ''))) {
        fail('必须提供分析目录的绝对路径，以及有效的 UUID v4 运行 ID。');
    }
    const loadRun = dependencies.loadRun || fresh.loadRun;
    const loaded = loadRun(runId, { rootDir: path.resolve(analysisRoot) });
    if (loaded.run?.baseline?.contract !== HISTORICAL_BASELINE_CONTRACT) fail('该运行不是已获来源授权的历史分析。');
    if (loaded.run.status !== 'complete' || loaded.analysis?.status !== 'complete') fail('历史分析运行尚未完成。');
    const analysisFile = path.join(loaded.runDir, 'analysis.json');
    const current = (dependencies.readRegularJson || fresh.readRegularJson)(analysisFile);
    if (!SHA_RE.test(String(loaded.run.analysisSha256 || '')) || current.sha256 !== loaded.run.analysisSha256
        || stableHash(current.value) !== stableHash(loaded.analysis)) fail('已完成分析文件的字节或内容与运行凭证不一致。');
    const isSuccessful = dependencies.isSuccessfulAnalysisRecord
        || require('../analysis-engine.js').isSuccessfulAnalysisRecord;
    for (const paper of loaded.analysis.papers) {
        if (!isSuccessful(paper)) fail(`${paperIdOf(paper)} 没有完整的正式分析结果。`);
        const source = (dependencies.readFreshSource || require('./fresh-analysis-context.js').readFreshSource)(
            loaded.runDir, paper, loaded.run);
        if (!require('./model-text-sanitization.js').canReuseModelTextInputs(paper, source)) {
            fail(`${paperIdOf(paper)} 的旧 Unicode 模型输入需重分析，不能直接复用标签。`);
        }
        if (!require('./reader-author-source.js').canReuseReaderAuthorInputs(paper, source)) {
            fail(`${paperIdOf(paper)} 的作者来源需从封存全文重新核验，不能直接复用标签。`);
        }
    }
    const handle = Object.freeze(Object.create(null)); HANDLES.add(handle);
    HANDLE_DATA.set(handle, Object.freeze({ runId, analysisFile, analysisFileSha256: current.sha256,
        papers: clone(loaded.analysis.papers) }));
    return handle;
}

function runSnapshot(handle) {
    if (!handle || typeof handle !== 'object' || !HANDLES.has(handle)) fail('必须提供已核验且已完成的历史分析运行句柄。');
    return clone(HANDLE_DATA.get(handle));
}

function getConsistentClassificationLabels(paper) {
    const parsed = paper?.parsed;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof paper.analysis !== 'string' || !paper.analysis.trim()) {
        fail(`${paperIdOf(paper)} 缺少正式分析正文或已解析的标签。`);
    }
    try { require('../utils.js').readTagValidation(parsed); }
    catch (error) { fail(error.message); }
    const reparsed = require('../utils.js').parseAnalysis(paper.analysis);
    const normalize = value => String(value || '').trim();
    const cached = { tags: Array.isArray(parsed.tags) ? parsed.tags.map(normalize) : null,
        primaryTaskTag: normalize(parsed.primaryTaskTag), primaryMethodTag: normalize(parsed.primaryMethodTag) };
    const fromText = { tags: Array.isArray(reparsed?.tags) ? reparsed.tags.map(normalize) : null,
        primaryTaskTag: normalize(reparsed?.primaryTaskTag), primaryMethodTag: normalize(reparsed?.primaryMethodTag) };
    if (!cached.tags || !fromText.tags || stableHash(cached) !== stableHash(fromText)) {
        fail(`${paperIdOf(paper)} 缓存中的标签与重新解析正式分析正文得到的标签不一致。`);
    }
    return cached;
}

function resolveOne(tagCatalog, label, facet, reasons, role) {
    const matches = tagCatalogApi.resolveLabelCandidates(tagCatalog, label, facet);
    if (matches.length === 0) { reasons.push(`${role}:unknown:${label || '<empty>'}`); return null; }
    if (matches.length > 1) { reasons.push(`${role}:ambiguous:${label}`); return null; }
    if (matches[0].status !== 'active') { reasons.push(`${role}:deprecated:${matches[0].id}`); return null; }
    return matches[0];
}
function conceptMatchesLabel(concept, label) {
    if (!concept) return false;
    const normalized = tagCatalogApi.normalizeLabel(label);
    return [concept.preferredLabel.zh, concept.preferredLabel.en, ...concept.aliases]
        .some(value => tagCatalogApi.normalizeLabel(value) === normalized);
}

function buildAssignmentRecord({ runHandle, paper, tagCatalog } = {}, legacy = false) {
    const run = runSnapshot(runHandle);
    const paperId = paperIdOf(paper);
    const matches = run.papers.filter(item => paperIdOf(item) === paperId);
    if (matches.length !== 1 || stableHash(matches[0]) !== stableHash(paper)) fail('论文记录与该分析运行中的完整原记录不一致，或没有唯一对应记录。');
    if (!tagCatalog || !SHA_RE.test(String(tagCatalog.registrySha256 || ''))) fail('必须提供带有效 SHA 的已加载词表。');
    tagCatalogApi.validateTagCatalog({ version: tagCatalog.version, facets: tagCatalog.facets, concepts: tagCatalog.concepts });
    const input = getConsistentClassificationLabels(paper); const reasons = []; const concepts = new Map();
    const currentTagValidation = require('../utils.js')
        .parseAnalysis(paper.analysis)?.tagValidation;
    if (currentTagValidation?.valid === false) {
        reasons.push(`${legacy ? 'canonical-taxonomy' : 'analysis-tags'}:${currentTagValidation.errors?.[0] || 'invalid'}`);
    }
    const task = resolveOne(tagCatalog, input.primaryTaskTag, 'task', reasons, 'primary-task');
    const method = resolveOne(tagCatalog, input.primaryMethodTag, 'method', reasons, 'primary-method');
    for (const label of input.tags) {
        const roleMatches = [task, method].filter(concept => conceptMatchesLabel(concept, label));
        const concept = roleMatches.length === 1 ? roleMatches[0] : resolveOne(tagCatalog, label, undefined, reasons, 'tag');
        if (concept) concepts.set(concept.id, concept);
    }
    for (const concept of [task, method]) if (concept) concepts.set(concept.id, concept);
    if (!input.tags.includes(input.primaryTaskTag)) reasons.push('primary-task:not-in-canonical-tags');
    if (!input.tags.includes(input.primaryMethodTag)) reasons.push('primary-method:not-in-canonical-tags');
    const prunedIds = tagCatalogApi.pruneAncestors(tagCatalog, [...concepts.keys()].sort()).sort();
    if (task && !prunedIds.includes(task.id)) reasons.push(`primary-task:ancestor-pruned:${task.id}`);
    if (method && !prunedIds.includes(method.id)) reasons.push(`primary-method:ancestor-pruned:${method.id}`);
    const blockedReasons = [...new Set(reasons)].sort();
    const body = { contract: legacy ? LEGACY_CONTRACT : CONTRACT, version: legacy ? 1 : VERSION, paperId,
        analysisRunId: run.runId, analysisFileSha256: run.analysisFileSha256,
        analysisSha256: sha256(Buffer.from(paper.analysis, 'utf8')), analysisRecordSha256: stableHash(paper),
        registryVersion: tagCatalog.version, registrySha256: tagCatalog.registrySha256,
        input: { ...input, labelsSha256: stableHash(input) },
        status: blockedReasons.length ? 'blocked' : 'assigned', blockedReasons,
        primaryTaskId: blockedReasons.length ? null : task.id,
        primaryMethodId: blockedReasons.length ? null : method.id,
        conceptIds: blockedReasons.length ? [] : prunedIds,
        concepts: blockedReasons.length ? [] : prunedIds.map(id => {
            const concept = concepts.get(id);
            return { id, facet: concept.facet, preferredLabel: clone(concept.preferredLabel) };
        }) };
    return { ...body, assignmentSha256: stableHash(body) };
}
function buildAssignment(options) { return buildAssignmentRecord(options); }
// 旧记录只按其原格式完整复算，用于读取核验，不交给当前写入器。
function buildLegacyAssignment(options) { return buildAssignmentRecord(options, true); }

function buildAssignments({ runHandle, tagCatalog, paperId = null } = {}) {
    const run = runSnapshot(runHandle);
    const selected = paperId === null ? run.papers : run.papers.filter(paper => paperIdOf(paper) === paperId);
    if (!selected.length || (paperId !== null && selected.length !== 1)) fail('指定论文在分析运行中不存在，或没有唯一对应记录。');
    return selected.map(paper => buildAssignment({ runHandle, paper, tagCatalog }))
        .sort((a, b) => a.paperId.localeCompare(b.paperId));
}

function legacyAssignmentFilename(paperId, registrySha256) {
    const match = String(paperId || '').match(/^arxiv:(\d{4}\.\d{4,5})$/);
    if (!match || !SHA_RE.test(String(registrySha256 || ''))) fail('必须提供规范的 arXiv 论文 ID 和有效的词表 SHA。');
    return `arxiv-${match[1]}.taxonomy.${registrySha256}.json`;
}

function assignmentFilename(paperId, registrySha256, assignmentSha256) {
    const match = String(paperId || '').match(/^arxiv:(\d{4}\.\d{4,5})$/);
    if (!match || !SHA_RE.test(String(registrySha256 || ''))) fail('必须提供规范的 arXiv 论文 ID 和有效的词表 SHA。');
    if (!SHA_RE.test(String(assignmentSha256 || ''))) fail('必须提供有效的标签分配 SHA。');
    return `arxiv-${match[1]}.tags.${registrySha256}.${assignmentSha256}.json`;
}
function legacyHashedAssignmentFilename(paperId, registrySha256, assignmentSha256) {
    const legacy = legacyAssignmentFilename(paperId, registrySha256);
    if (!SHA_RE.test(String(assignmentSha256 || ''))) fail('必须提供有效的标签分配 SHA。');
    return `${legacy.slice(0, -5)}.${assignmentSha256}.json`;
}

function writeAssignments({ outputRoot, assignments } = {}) {
    if (!Array.isArray(assignments) || !assignments.length) fail('标签分配记录必须是非空数组。');
    const runIds = [...new Set(assignments.map(item => item.analysisRunId))];
    if (runIds.length !== 1 || !UUID_RE.test(runIds[0])) fail('所有标签分配记录必须属于同一次分析运行，且运行 ID 必须有效。');
    for (const assignment of assignments) {
        const body = { ...assignment }; delete body.assignmentSha256;
        if (assignment.contract !== CONTRACT || assignment.version !== VERSION
            || !['assigned', 'blocked'].includes(assignment.status)
            || assignment.assignmentSha256 !== stableHash(body)) fail('当前写入器只接受完整且哈希有效的新版标签分配记录。');
    }
    const root = fresh.assertSafeDirectory(outputRoot, true);
    const runRoot = fresh.assertSafeDirectory(path.join(root, runIds[0]), true); const outputs = [];
    for (const assignment of assignments) {
        const filename = path.join(runRoot, assignmentFilename(
            assignment.paperId, assignment.registrySha256, assignment.assignmentSha256
        ));
        const bytes = canonicalBytes(assignment);
        writeImmutableFile(filename, bytes, fail);
        outputs.push({ paperId: assignment.paperId, filename, fileSha256: sha256(bytes), status: assignment.status });
    }
    return outputs;
}

module.exports = { CONTRACT, VERSION, LEGACY_CONTRACT, HISTORICAL_BASELINE_CONTRACT, stableHash, canonicalBytes,
    loadCompletedHistoricalAnalysisRun, runSnapshot, getConsistentClassificationLabels, buildAssignment, buildAssignments,
    buildLegacyAssignment, legacyAssignmentFilename, legacyHashedAssignmentFilename, assignmentFilename, writeAssignments };
