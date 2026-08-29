#!/usr/bin/env node
/** Fetch only the full-text evidence needed by the offline manual analyst. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Config = require('./config.js');
const { normalizedId, writeFileAtomic, getBeijingISOString } = require('./utils.js');
const {
    fetchArxivTextDetailed,
    ARXIV_STRUCTURED_ARTIFACT_PARSER_VERSION
} = require('./deep-analyzer.js');
const { updateJsonFileLocked } = require('./analysis-engine.js');
const { acquireManualRunLock } = require('./manual-fetch.js');
const {
    buildArtifactManifestContext,
    initializeArtifactManifestLocked,
    persistStructuredArtifactSnapshot,
    loadStructuredArtifactSnapshot,
    readArtifactManifestLocked,
    ensureArtifactIndexCheckpoint,
    isReusableArtifactCheckpoint,
    recordArtifactFailure,
    finalizeArtifactManifestLocked
} = require('./manual-artifact-index.js');
const {
    monotonicNs,
    unionNanoseconds,
    persistStageMetricSafely
} = require('./manual-performance-metrics.js');

const MANIFEST_VERSION = 2;
const MANIFEST_MODE = 'manual_full_text_fetch';

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function stableSha256(value) {
    return sha256(Buffer.from(JSON.stringify(stableValue(value))));
}

function getRequestedArxivId(paper) {
    const rawValues = [paper?.arxivId, paper?.paper_id, paper?.id]
        .map(value => String(value || '').trim())
        .filter(Boolean);
    const parsed = rawValues.map(raw => {
        const match = raw.match(/(?:arxiv:\s*|arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5}(?:v\d+)?)(?:\.pdf)?$/i);
        return match ? match[1].toLowerCase() : '';
    }).filter(Boolean);
    if (parsed.length === 0) {
        throw new Error(`filtered paper 缺少可抓取的 arXiv ID: ${rawValues.join(' / ') || '(missing)'}`);
    }
    const normalizedIds = new Set(parsed.map(normalizedId));
    if (normalizedIds.size !== 1) throw new Error(`filtered paper 包含冲突 arXiv ID: ${parsed.join(' / ')}`);
    const versioned = parsed.filter(value => /v\d+$/i.test(value));
    if (new Set(versioned).size > 1) throw new Error(`filtered paper 包含冲突 arXiv 版本: ${versioned.join(' / ')}`);
    return versioned[0] || parsed[0];
}

function buildFilteredBatchFingerprint(filtered) {
    return stableSha256(filtered);
}

function buildPaperInputIdentity(paper, filteredBatchSha256, outDir) {
    const requestedArxivId = getRequestedArxivId(paper);
    const id = normalizedId(requestedArxivId);
    const paperMetadataSha256 = stableSha256(paper);
    const paperInputSha256 = stableSha256({
        filteredBatchSha256,
        paperMetadataSha256,
        requestedArxivId
    });
    return {
        id,
        filteredBatchSha256,
        requestedArxivId,
        paperMetadataSha256,
        paperInputSha256,
        filePath: path.join(outDir, `${id}-${paperInputSha256.slice(0, 16)}.txt`)
    };
}

function buildManifestContext(filtered, date, outDir) {
    const filteredBatchSha256 = buildFilteredBatchFingerprint(filtered);
    const inputs = filtered.papers.map(paper => buildPaperInputIdentity(paper, filteredBatchSha256, outDir));
    const byId = new Map();
    for (const input of inputs) {
        if (byId.has(input.id)) throw new Error(`filtered papers 含重复规范化 ID: ${input.id}`);
        byId.set(input.id, input);
    }
    return {
        date,
        filteredBatchSha256,
        expectedPaperInputs: Object.fromEntries(inputs.map(input => [input.id, {
            requestedArxivId: input.requestedArxivId,
            paperMetadataSha256: input.paperMetadataSha256,
            paperInputSha256: input.paperInputSha256
        }])),
        inputs,
        byId
    };
}

function sourceIdentitySha256(entry) {
    return stableSha256({
        source: entry.source,
        sourceId: entry.sourceId,
        sourceSha256: entry.sourceSha256
    });
}

function isReusableFullTextCheckpoint(entry, filePath, expected = {}) {
    if (entry?.status !== 'complete' || !fs.existsSync(filePath)) return false;
    if (expected.filteredBatchSha256 && entry.filteredBatchSha256 !== expected.filteredBatchSha256) return false;
    if (expected.paperMetadataSha256 && entry.paperMetadataSha256 !== expected.paperMetadataSha256) return false;
    if (expected.paperInputSha256 && entry.paperInputSha256 !== expected.paperInputSha256) return false;
    if (expected.requestedArxivId && entry.requestedArxivId !== expected.requestedArxivId) return false;
    if (entry.path !== filePath || !['html', 'pdf'].includes(entry.source) || !entry.sourceId) return false;
    if (normalizedId(entry.sourceId) !== normalizedId(entry.requestedArxivId)) return false;
    if (/v\d+$/i.test(entry.requestedArxivId) && entry.sourceId.toLowerCase() !== entry.requestedArxivId.toLowerCase()) {
        return false;
    }
    if (entry.sourceIdentitySha256 !== sourceIdentitySha256(entry)) return false;
    let buffer;
    try {
        buffer = fs.readFileSync(filePath);
    } catch (_error) {
        return false;
    }
    return buffer.length >= 1000
        && entry.bytes === buffer.length
        && entry.sourceSha256 === sha256(buffer);
}

function assertManifestContext(manifest, context) {
    if (!manifest || manifest.version !== MANIFEST_VERSION || manifest.mode !== MANIFEST_MODE
        || manifest.date !== context.date
        || manifest.filteredBatchSha256 !== context.filteredBatchSha256
        || stableSha256(manifest.expectedPaperInputs) !== stableSha256(context.expectedPaperInputs)) {
        throw new Error('manual 全文 manifest 已被不同 filtered 批次替换，拒绝并发覆盖');
    }
}

function initializeManifestLocked(manifestPath, context) {
    return updateJsonFileLocked(manifestPath, current => {
        const reusable = current?.version === MANIFEST_VERSION
            && current?.mode === MANIFEST_MODE
            && current?.date === context.date
            && current?.filteredBatchSha256 === context.filteredBatchSha256
            && stableSha256(current?.expectedPaperInputs || {}) === stableSha256(context.expectedPaperInputs)
            && current?.papers && typeof current.papers === 'object' && !Array.isArray(current.papers);
        const conflictingActiveBatch = current?.version === MANIFEST_VERSION
            && current?.mode === MANIFEST_MODE
            && current?.date === context.date
            && current?.status === 'running'
            && !reusable;
        if (conflictingActiveBatch) {
            throw new Error('manual 全文 manifest 已有另一 filtered 批次在运行，拒绝并发重置');
        }
        const now = getBeijingISOString();
        return {
            ...(reusable ? current : {}),
            version: MANIFEST_VERSION,
            mode: MANIFEST_MODE,
            date: context.date,
            filteredBatchSha256: context.filteredBatchSha256,
            filteredPapersSha256: context.filteredBatchSha256,
            expectedPaperInputs: context.expectedPaperInputs,
            status: 'running',
            ...(reusable ? { resumedAt: now } : { startedAt: now }),
            papers: reusable ? { ...current.papers } : {}
        };
    });
}

function readManifestLocked(manifestPath, context) {
    const manifest = updateJsonFileLocked(manifestPath, current => {
        assertManifestContext(current, context);
        return undefined;
    }, { allowMissing: false });
    return manifest;
}

function upsertManifestPaperLocked(manifestPath, context, id, entry) {
    return updateJsonFileLocked(manifestPath, current => {
        assertManifestContext(current, context);
        const expected = context.byId.get(id);
        if (!expected) throw new Error(`manual 全文 manifest 包含批次外论文: ${id}`);
        const existing = current.papers?.[id];
        if (entry.status !== 'complete'
            && isReusableFullTextCheckpoint(existing, expected.filePath, expected)) {
            return undefined;
        }
        return {
            ...current,
            status: 'running',
            lastUpdated: getBeijingISOString(),
            papers: { ...(current.papers || {}), [id]: entry }
        };
    });
}

function finalizeManifestLocked(manifestPath, context) {
    return updateJsonFileLocked(manifestPath, current => {
        assertManifestContext(current, context);
        let count = 0;
        let failed = 0;
        for (const input of context.inputs) {
            const entry = current.papers?.[input.id];
            if (isReusableFullTextCheckpoint(entry, input.filePath, input)) count++;
            else failed++;
        }
        return {
            ...current,
            status: failed > 0 ? 'partial_failed' : 'complete',
            completedAt: getBeijingISOString(),
            count,
            failed
        };
    });
}

function buildCompleteEntry(input, result, sourceBuffer) {
    const sourceId = String(result.sourceId || '').trim().toLowerCase();
    if (!['html', 'pdf'].includes(result.source) || !sourceId
        || normalizedId(sourceId) !== input.id
        || (/v\d+$/i.test(input.requestedArxivId) && sourceId !== input.requestedArxivId)) {
        throw new Error(`${input.id} 全文来源身份与指定版本不一致: requested=${input.requestedArxivId} source=${result.source || '-'}:${sourceId || '-'}`);
    }
    const entry = {
        status: 'complete',
        path: input.filePath,
        requestedArxivId: input.requestedArxivId,
        paperMetadataSha256: input.paperMetadataSha256,
        paperInputSha256: input.paperInputSha256,
        filteredBatchSha256: input.filteredBatchSha256,
        source: result.source,
        sourceId,
        chars: result.text.length,
        bytes: sourceBuffer.length,
        sourceSha256: sha256(sourceBuffer),
        warnings: result.warnings || [],
        imageInfos: Array.isArray(result.imageInfos) ? result.imageInfos.map(info => ({
            url: info.url,
            caption: info.caption || '',
            alt: info.alt || '',
            source: info.source || 'arxiv_html'
        })) : [],
        fetchedAt: getBeijingISOString()
    };
    entry.sourceIdentitySha256 = sourceIdentitySha256(entry);
    return entry;
}

async function fetchFullTextForInput(input, fetchFn = fetchArxivTextDetailed) {
    return fetchFn(input.requestedArxivId);
}

function isReusableStructuredSnapshotForCurrentParser(sourceEntry, structuredArtifacts) {
    if (sourceEntry?.source !== 'html') return true;
    // v4 changes the table candidate inventory as well as cell extraction:
    // earlier "complete" snapshots could omit standalone semantic span
    // tables. Do not bless an older parser merely because its own, narrower
    // inventory closed.
    return structuredArtifacts?.parserVersion === ARXIV_STRUCTURED_ARTIFACT_PARSER_VERSION;
}

async function runFullText(date = process.argv[2]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('用法: node scripts/manual-fetch-fulltext.js YYYY-MM-DD');
    const filtered = JSON.parse(fs.readFileSync(Config.FILES.filteredPapers, 'utf8'));
    if (filtered.batchDate !== date || filtered.status !== 'complete' || !Array.isArray(filtered.papers)) {
        throw new Error(`filtered-papers.json 不是 ${date} complete 批次`);
    }
    const outDir = path.join(Config.CURRENT_DIR, 'manual-full-text', date);
    fs.mkdirSync(outDir, { recursive: true });
    const manifestPath = path.join(outDir, 'manifest.json');
    const context = buildManifestContext(filtered, date, outDir);
    initializeManifestLocked(manifestPath, context);
    const artifactContext = buildArtifactManifestContext(context, outDir);
    initializeArtifactManifestLocked(artifactContext);

    const failures = [];
    const artifactFailures = [];
    const observed = {
        fulltextIntervals: [], artifactIntervals: [],
        fulltextHits: 0, fulltextMisses: 0,
        artifactHits: 0, artifactMisses: 0
    };
    let cursor = 0;
    const worker = async () => {
        while (cursor < filtered.papers.length) {
            const input = context.inputs[cursor++];
            const id = input.id;
            const current = readManifestLocked(manifestPath, context);
            let sourceEntry = current.papers?.[id];
            let structuredSnapshotReusable = false;
            const fulltextStartedNs = monotonicNs();
            if (isReusableFullTextCheckpoint(sourceEntry, input.filePath, input)) {
                try {
                    const structuredArtifacts = loadStructuredArtifactSnapshot(input, sourceEntry);
                    // A parser revision is an evidence-contract revision.  Do
                    // not silently reuse a snapshot that predates a recovery
                    // fix, even if its flattened text remains byte-identical.
                    structuredSnapshotReusable = isReusableStructuredSnapshotForCurrentParser(
                        sourceEntry, structuredArtifacts
                    );
                } catch (_error) {
                    structuredSnapshotReusable = false;
                }
            }
            if (isReusableFullTextCheckpoint(sourceEntry, input.filePath, input) && structuredSnapshotReusable) {
                observed.fulltextHits++;
                console.log(`[manual-full-text] ${input.requestedArxivId} 复用完整全文 checkpoint`);
            } else {
                observed.fulltextMisses++;
                console.log(`[manual-full-text] ${input.requestedArxivId} 获取全文与结构化证据...`);
                try {
                    const result = await fetchFullTextForInput(input);
                    if (!result.text || result.text.length < 1000) {
                        throw new Error(`${input.requestedArxivId} 正文不足 1000 字符（source=${result.source || 'none'}）`);
                    }
                    if (!result.structuredArtifacts) {
                        throw new Error(`${input.requestedArxivId} 抓取结果缺少扁平化前 structuredArtifacts`);
                    }
                    writeFileAtomic(input.filePath, result.text);
                    const sourceBuffer = fs.readFileSync(input.filePath);
                    sourceEntry = buildCompleteEntry(input, result, sourceBuffer);
                    sourceEntry.structuredArtifactsSnapshot = persistStructuredArtifactSnapshot(
                        artifactContext, input, sourceEntry, result.structuredArtifacts
                    );
                    upsertManifestPaperLocked(manifestPath, context, id, sourceEntry);
                    console.log(`[manual-full-text] ${input.requestedArxivId} 完成 ${result.source} ${result.text.length} chars`);
                } catch (error) {
                    failures.push(`${input.requestedArxivId}: ${error.message}`);
                    upsertManifestPaperLocked(manifestPath, context, id, {
                        status: 'failed',
                        path: input.filePath,
                        requestedArxivId: input.requestedArxivId,
                        paperMetadataSha256: input.paperMetadataSha256,
                        paperInputSha256: input.paperInputSha256,
                        filteredBatchSha256: context.filteredBatchSha256,
                        error: error.message,
                        failedAt: getBeijingISOString()
                    });
                    recordArtifactFailure(artifactContext, input, error);
                    const fulltextCompletedNs = monotonicNs();
                    observed.fulltextIntervals.push([fulltextStartedNs, fulltextCompletedNs]);
                    continue;
                }
            }
            const fulltextCompletedNs = monotonicNs();
            observed.fulltextIntervals.push([fulltextStartedNs, fulltextCompletedNs]);
            const artifactStartedNs = monotonicNs();
            try {
                const artifactCurrent = readArtifactManifestLocked(artifactContext);
                const sourceText = fs.readFileSync(sourceEntry.path, 'utf8');
                const artifactHit = isReusableArtifactCheckpoint(
                    artifactCurrent.papers?.[id], { context: artifactContext, input, sourceEntry, sourceText }
                );
                const artifactEntry = ensureArtifactIndexCheckpoint(artifactContext, input, sourceEntry);
                if (artifactHit) observed.artifactHits++;
                else observed.artifactMisses++;
                console.log(`[manual-artifact] ${input.requestedArxivId} ArtifactIndex checkpoint ${artifactEntry.status}`);
            } catch (error) {
                observed.artifactMisses++;
                artifactFailures.push(`${input.requestedArxivId}: ${error.message}`);
                recordArtifactFailure(artifactContext, input, error, { [id]: sourceEntry });
                console.warn(`[manual-artifact] ${input.requestedArxivId} 失败，可在下次 fulltext 续跑: ${error.message}`);
            } finally {
                const artifactCompletedNs = monotonicNs();
                observed.artifactIntervals.push([artifactStartedNs, artifactCompletedNs]);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(3, filtered.papers.length) }, worker));
    const manifest = finalizeManifestLocked(manifestPath, context);
    const artifactManifest = finalizeArtifactManifestLocked(artifactContext, manifest.papers);
    const completeSources = context.inputs.map(input => manifest.papers?.[input.id])
        .filter(entry => entry?.status === 'complete');
    const artifactEntries = context.inputs.map(input => artifactManifest.papers?.[input.id])
        .filter(entry => ['complete', 'incomplete'].includes(entry?.status));
    persistStageMetricSafely({
        date, stage: 'fulltext', status: manifest.status,
        wallNs: unionNanoseconds(observed.fulltextIntervals) ?? undefined,
        wallAggregation: 'union_of_observed_same_stage_operation_intervals',
        cache: { hits: observed.fulltextHits, misses: observed.fulltextMisses },
        paperCount: context.inputs.length,
        taskCount: observed.fulltextHits + observed.fulltextMisses,
        inputFiles: [{ role: 'filtered_papers', path: Config.FILES.filteredPapers }],
        outputFiles: [
            { role: 'fulltext_manifest', path: manifestPath },
            ...completeSources.flatMap(entry => [
                { role: 'fulltext_source', path: entry.path },
                ...(entry.structuredArtifactsSnapshot?.path
                    ? [{ role: 'structured_snapshot', path: entry.structuredArtifactsSnapshot.path }] : [])
            ])
        ]
    });
    persistStageMetricSafely({
        date, stage: 'artifact_index', status: artifactManifest.status,
        wallNs: unionNanoseconds(observed.artifactIntervals) ?? undefined,
        wallAggregation: 'union_of_observed_same_stage_operation_intervals',
        cache: { hits: observed.artifactHits, misses: observed.artifactMisses },
        paperCount: context.inputs.length,
        taskCount: observed.artifactHits + observed.artifactMisses,
        inputFiles: completeSources.flatMap(entry => [
            { role: 'fulltext_source', path: entry.path },
            ...(entry.structuredArtifactsSnapshot?.path
                ? [{ role: 'structured_snapshot', path: entry.structuredArtifactsSnapshot.path }] : [])
        ]),
        outputFiles: [
            { role: 'artifact_manifest', path: artifactContext.manifestPath },
            ...artifactEntries.map(entry => ({ role: 'artifact_index', path: entry.path }))
        ]
    });
    if (manifest.failed > 0) {
        throw new Error(`manual 全文证据仍有 ${manifest.failed} 篇失败: ${failures.join('; ') || '请查看 manifest'}`);
    }
    if (artifactManifest.failed > 0 || artifactManifest.incomplete > 0) {
        console.warn(`⚠️ ArtifactIndex 有 ${artifactManifest.failed} 篇失败、${artifactManifest.incomplete || 0} 篇结构不完整，不阻断历史 manifest v2/spec v5: ${artifactFailures.join('; ') || '请查看 companion manifest'}`);
    }
    console.log(`✅ manual 全文证据完成：${manifest.count} 篇，目录 ${outDir}`);
}

async function main(date = process.argv[2]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('用法: node scripts/manual-fetch-fulltext.js YYYY-MM-DD');
    const release = await acquireManualRunLock(date, 'fulltext');
    try {
        return await runFullText(date);
    } finally {
        await release();
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(`❌ manual-full-text 失败: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    MANIFEST_VERSION,
    main,
    runFullText,
    stableSha256,
    getRequestedArxivId,
    buildFilteredBatchFingerprint,
    buildPaperInputIdentity,
    buildManifestContext,
    sourceIdentitySha256,
    isReusableFullTextCheckpoint,
    initializeManifestLocked,
    readManifestLocked,
    upsertManifestPaperLocked,
    finalizeManifestLocked,
    buildCompleteEntry,
    fetchFullTextForInput,
    isReusableStructuredSnapshotForCurrentParser
};
