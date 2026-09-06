'use strict';

// Deterministic taxonomy projection from a completed, source-bound historical
// analysis run. This module never reads old blog tags and never calls an LLM.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const taxonomyApi = require('./paper-taxonomy.js');
const fresh = require('./fresh-rewrite-run.js');

const CONTRACT = 'paper-taxonomy-assignment-v1';
const VERSION = 1;
const HISTORICAL_BASELINE_CONTRACT = 'historical-arxiv-authority-baseline-v1';
const UUID_RE = fresh.UUID_RE || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const HANDLES = new WeakSet();
const HANDLE_DATA = new WeakMap();
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const stableHash = fresh.stableHash;

function fail(message) {
    const error = new Error(`Historical taxonomy assignment rejected: ${message}`);
    error.code = 'HISTORICAL_TAXONOMY_ASSIGNMENT_INTEGRITY';
    error.retryable = false;
    throw error;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function canonicalBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function paperIdOf(paper) { return `arxiv:${fresh.paperId(paper)}`; }

function loadCompletedHistoricalAnalysisRun({ analysisRoot, runId } = {}, dependencies = {}) {
    if (typeof analysisRoot !== 'string' || !path.isAbsolute(analysisRoot) || !UUID_RE.test(String(runId || ''))) {
        fail('configured absolute analysisRoot and UUID v4 runId are required');
    }
    const loadRun = dependencies.loadRun || fresh.loadRun;
    const loaded = loadRun(runId, { rootDir: path.resolve(analysisRoot) });
    if (loaded.run?.baseline?.contract !== HISTORICAL_BASELINE_CONTRACT) fail('run is not a historical source-authorized analysis');
    if (loaded.run.status !== 'complete' || loaded.analysis?.status !== 'complete') fail('historical analysis run is not complete');
    const analysisFile = path.join(loaded.runDir, 'analysis.json');
    const current = (dependencies.readRegularJson || fresh.readRegularJson)(analysisFile);
    if (!SHA_RE.test(String(loaded.run.analysisSha256 || '')) || current.sha256 !== loaded.run.analysisSha256
        || stableHash(current.value) !== stableHash(loaded.analysis)) fail('completed analysis bytes drifted from the run receipt');
    const isSuccessful = dependencies.isSuccessfulAnalysisRecord
        || require('../analysis-engine.js').isSuccessfulAnalysisRecord;
    for (const paper of loaded.analysis.papers) if (!isSuccessful(paper)) fail(`${paperIdOf(paper)} is not a complete canonical analysis`);
    const handle = Object.freeze(Object.create(null)); HANDLES.add(handle);
    HANDLE_DATA.set(handle, Object.freeze({ runId, analysisFile, analysisFileSha256: current.sha256,
        papers: clone(loaded.analysis.papers) }));
    return handle;
}

function runSnapshot(handle) {
    if (!handle || typeof handle !== 'object' || !HANDLES.has(handle)) fail('authenticated completed historical analysis handle required');
    return clone(HANDLE_DATA.get(handle));
}

function labelProjection(paper) {
    const parsed = paper?.parsed;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof paper.analysis !== 'string' || !paper.analysis.trim()) {
        fail(`${paperIdOf(paper)} lacks canonical analysis/parsed labels`);
    }
    const reparsed = require('../utils.js').parseAnalysis(paper.analysis);
    const normalize = value => String(value || '').trim();
    const cached = { tags: Array.isArray(parsed.tags) ? parsed.tags.map(normalize) : null,
        primaryTaskTag: normalize(parsed.primaryTaskTag), primaryMethodTag: normalize(parsed.primaryMethodTag) };
    const fromText = { tags: Array.isArray(reparsed?.tags) ? reparsed.tags.map(normalize) : null,
        primaryTaskTag: normalize(reparsed?.primaryTaskTag), primaryMethodTag: normalize(reparsed?.primaryMethodTag) };
    if (!cached.tags || !fromText.tags || stableHash(cached) !== stableHash(fromText)) {
        fail(`${paperIdOf(paper)} cached parsed labels drifted from canonical analysis`);
    }
    return cached;
}

function resolveOne(taxonomy, label, facet, reasons, role) {
    const matches = taxonomyApi.resolveLabelCandidates(taxonomy, label, facet);
    if (matches.length === 0) { reasons.push(`${role}:unknown:${label || '<empty>'}`); return null; }
    if (matches.length > 1) { reasons.push(`${role}:ambiguous:${label}`); return null; }
    if (matches[0].status !== 'active') { reasons.push(`${role}:deprecated:${matches[0].id}`); return null; }
    return matches[0];
}
function conceptMatchesLabel(concept, label) {
    if (!concept) return false;
    const normalized = taxonomyApi.normalizeLabel(label);
    return [concept.preferredLabel.zh, concept.preferredLabel.en, ...concept.aliases]
        .some(value => taxonomyApi.normalizeLabel(value) === normalized);
}

function buildAssignment({ runHandle, paper, taxonomy } = {}) {
    const run = runSnapshot(runHandle);
    const paperId = paperIdOf(paper);
    const matches = run.papers.filter(item => paperIdOf(item) === paperId);
    if (matches.length !== 1 || stableHash(matches[0]) !== stableHash(paper)) fail('paper is not the exact canonical record from this analysis run');
    if (!taxonomy || !SHA_RE.test(String(taxonomy.registrySha256 || ''))) fail('loaded taxonomy with registry SHA is required');
    taxonomyApi.validateTaxonomy({ version: taxonomy.version, facets: taxonomy.facets, concepts: taxonomy.concepts });
    const input = labelProjection(paper); const reasons = []; const concepts = new Map();
    const task = resolveOne(taxonomy, input.primaryTaskTag, 'task', reasons, 'primary-task');
    const method = resolveOne(taxonomy, input.primaryMethodTag, 'method', reasons, 'primary-method');
    for (const label of input.tags) {
        const roleMatches = [task, method].filter(concept => conceptMatchesLabel(concept, label));
        const concept = roleMatches.length === 1 ? roleMatches[0] : resolveOne(taxonomy, label, undefined, reasons, 'tag');
        if (concept) concepts.set(concept.id, concept);
    }
    for (const concept of [task, method]) if (concept) concepts.set(concept.id, concept);
    if (!input.tags.includes(input.primaryTaskTag)) reasons.push('primary-task:not-in-canonical-tags');
    if (!input.tags.includes(input.primaryMethodTag)) reasons.push('primary-method:not-in-canonical-tags');
    const prunedIds = taxonomyApi.pruneAncestors(taxonomy, [...concepts.keys()].sort()).sort();
    if (task && !prunedIds.includes(task.id)) reasons.push(`primary-task:ancestor-pruned:${task.id}`);
    if (method && !prunedIds.includes(method.id)) reasons.push(`primary-method:ancestor-pruned:${method.id}`);
    const blockedReasons = [...new Set(reasons)].sort();
    const body = { contract: CONTRACT, version: VERSION, paperId,
        analysisRunId: run.runId, analysisFileSha256: run.analysisFileSha256,
        analysisSha256: sha256(Buffer.from(paper.analysis, 'utf8')), analysisRecordSha256: stableHash(paper),
        registryVersion: taxonomy.version, registrySha256: taxonomy.registrySha256,
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

function buildAssignments({ runHandle, taxonomy, paperId = null } = {}) {
    const run = runSnapshot(runHandle);
    const selected = paperId === null ? run.papers : run.papers.filter(paper => paperIdOf(paper) === paperId);
    if (!selected.length || (paperId !== null && selected.length !== 1)) fail('requested paperId is absent or ambiguous in the analysis run');
    return selected.map(paper => buildAssignment({ runHandle, paper, taxonomy }))
        .sort((a, b) => a.paperId.localeCompare(b.paperId));
}

function assignmentFilename(paperId, registrySha256) {
    const match = String(paperId || '').match(/^arxiv:(\d{4}\.\d{4,5})$/);
    if (!match || !SHA_RE.test(String(registrySha256 || ''))) fail('canonical arXiv paper ID and registry SHA are required');
    return `arxiv-${match[1]}.taxonomy.${registrySha256}.json`;
}

function writeAssignments({ outputRoot, assignments } = {}) {
    if (!Array.isArray(assignments) || !assignments.length) fail('non-empty assignments are required');
    const runIds = [...new Set(assignments.map(item => item.analysisRunId))];
    if (runIds.length !== 1 || !UUID_RE.test(runIds[0])) fail('assignments must belong to one analysis run');
    const root = fresh.assertSafeDirectory(outputRoot, true);
    const runRoot = fresh.assertSafeDirectory(path.join(root, runIds[0]), true); const outputs = [];
    for (const assignment of assignments) {
        const filename = path.join(runRoot, assignmentFilename(assignment.paperId, assignment.registrySha256));
        const bytes = canonicalBytes(assignment); let fd;
        try {
            fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
            fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const existingStat = fs.lstatSync(filename);
            if (!existingStat.isFile() || existingStat.isSymbolicLink() || existingStat.nlink !== 1) {
                fail(`existing assignment is unsafe: ${path.basename(filename)}`);
            }
            const existingFd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            let existing;
            try { existing = fs.readFileSync(existingFd); } finally { fs.closeSync(existingFd); }
            if (!existing.equals(bytes)) fail(`refuses to overwrite different assignment: ${path.basename(filename)}`);
        } finally { if (fd !== undefined) fs.closeSync(fd); }
        outputs.push({ paperId: assignment.paperId, filename, fileSha256: sha256(bytes), status: assignment.status });
    }
    return outputs;
}

module.exports = { CONTRACT, VERSION, HISTORICAL_BASELINE_CONTRACT, stableHash, canonicalBytes,
    loadCompletedHistoricalAnalysisRun, runSnapshot, labelProjection, buildAssignment, buildAssignments,
    assignmentFilename, writeAssignments };
