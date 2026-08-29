#!/usr/bin/env node
'use strict';

/**
 * Manual v6 shadow audit.
 *
 * This command never fetches, assembles canonical data, renders a blog page,
 * or publishes. It reads already-persisted batch artifacts and may write only
 * beneath Config.FILES.manualV6ShadowDir after an explicit --output or
 * --init-shadow request.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Config = require('./config.js');
const { normalizedId, writeFileAtomic, getBeijingDateString, getBeijingISOString } = require('./utils.js');
const { tableNumericCellIds } = require('./manual-longform-contract.js');
const { WORKFLOW_STAGES, stableSha256 } = require('./manual-v6-workflow.js');
const {
    SHADOW_REPORT_VERSION,
    PERCENTILE_ALGORITHM,
    MIN_BATCH_SAMPLES,
    SHADOW_CONTRACT_FINGERPRINT
} = require('./manual-shadow-benchmark.js');
const {
    METRICS_MODE,
    METRICS_CONTRACT,
    monotonicNs,
    persistStageMetricSafely,
    verifyStageMetric
} = require('./manual-performance-metrics.js');

const SHADOW_CHECKPOINT_VERSION = 1;
const SHADOW_MODE = 'manual_v6_shadow_audit';
const LONG_PARAGRAPH_THRESHOLDS = Object.freeze([600, 1200]);

function sha256Bytes(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assertDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('--date 必须是 YYYY-MM-DD');
    const [year, month, day] = date.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
        throw new Error(`非法日期: ${date}`);
    }
    return date;
}

function isPathInside(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function existingRealpathWithin(filePath, roots, label) {
    const realFile = fs.realpathSync(filePath);
    const allowed = roots.map(root => fs.realpathSync(root));
    if (!allowed.some(root => isPathInside(root, realFile))) {
        throw new Error(`${label} realpath 逃逸允许目录: ${filePath}`);
    }
    return realFile;
}

function outputPathWithin(rootPath, targetPath, label) {
    fs.mkdirSync(rootPath, { recursive: true });
    if (fs.lstatSync(rootPath).isSymbolicLink()) throw new Error(`${label} 的 Manual shadow 根目录不得为 symlink`);
    const realRoot = fs.realpathSync(rootPath);
    const resolved = path.resolve(targetPath);
    let targetStat = null;
    try { targetStat = fs.lstatSync(resolved); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (targetStat?.isSymbolicLink()) throw new Error(`${label} 不得覆盖 symlink`);
    let ancestor = targetStat ? resolved : path.dirname(resolved);
    while (true) {
        try {
            fs.lstatSync(ancestor);
            break;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw new Error(`${label} 没有可验证父目录`);
        ancestor = parent;
    }
    const realAncestor = fs.realpathSync(ancestor);
    if (!isPathInside(realRoot, realAncestor)) throw new Error(`${label} realpath 逃逸 Manual shadow 隔离目录`);
    return resolved;
}

function readJsonInput(filePath, roots, label, inputFiles) {
    const realPath = existingRealpathWithin(filePath, roots, label);
    const bytes = fs.readFileSync(realPath);
    const item = {
        role: label,
        path: path.relative(Config.PROJECT_ROOT, realPath) || path.basename(realPath),
        bytes: bytes.length,
        sha256: sha256Bytes(bytes)
    };
    inputFiles.push(item);
    try {
        return { value: JSON.parse(bytes.toString('utf8')), input: item, realPath };
    } catch (error) {
        throw new Error(`${label} JSON 不可读: ${error.message}`);
    }
}

function findBatchJson(date, filename, currentDir, archiveDir) {
    const candidates = [path.join(currentDir, filename), path.join(archiveDir, date, filename)];
    for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) continue;
        try {
            const realCandidate = existingRealpathWithin(candidate, [currentDir, archiveDir], filename);
            const parsed = JSON.parse(fs.readFileSync(realCandidate, 'utf8'));
            if ((parsed.batchDate || parsed.date) === date) return candidate;
        } catch {
            return candidate;
        }
    }
    return null;
}

function normalizedPaperSet(filtered) {
    if (!Array.isArray(filtered?.papers)) throw new Error('filtered-papers 缺少 papers 数组');
    const ids = filtered.papers.map(paper => normalizedId(paper)).filter(Boolean);
    if (ids.length !== filtered.papers.length || new Set(ids).size !== ids.length) {
        throw new Error('filtered-papers 含非法或规范化重复 ID');
    }
    return ids.sort();
}

function collectRecordFiles(currentDir, date, workspaceDir = null) {
    const official = fs.readdirSync(currentDir).filter(name => (
        name.startsWith(`manual-analysis-record-${date}-`)
        || name.startsWith(`manual-analysis-records-${date}-`)
    ) && name.endsWith('.json')).map(name => path.join(currentDir, name));
    const shadowRecords = workspaceDir && fs.existsSync(path.join(workspaceDir, 'records'))
        ? fs.readdirSync(path.join(workspaceDir, 'records'))
            .filter(name => name.endsWith('.json')).map(name => path.join(workspaceDir, 'records', name))
        : [];
    return { official: official.sort(), shadow: shadowRecords.sort() };
}

function absorbRecordEnvelope(target, envelope, date, sourceLabel) {
    if (envelope?.date && envelope.date !== date) throw new Error(`${sourceLabel} 日期与 shadow 批次不一致`);
    const papers = envelope?.papers && !Array.isArray(envelope.papers)
        ? envelope.papers
        : (envelope?.paperId || envelope?.arxivId ? { [normalizedId(envelope)]: envelope } : null);
    if (!papers) throw new Error(`${sourceLabel} 缺少 papers 对象`);
    for (const [rawId, record] of Object.entries(papers)) {
        const id = normalizedId(rawId) || normalizedId(record);
        if (!id) throw new Error(`${sourceLabel} 含非法论文 ID`);
        if (target.has(id)) throw new Error(`${sourceLabel} 与其他 record 对 ${id} 重复定义`);
        target.set(id, record);
    }
}

function articleMetrics(record) {
    const article = typeof record?.editorial?.readerArticle === 'string'
        ? record.editorial.readerArticle.trim() : '';
    if (!article) return {
        status: 'unknown', chars: null, paragraphCount: null,
        maxParagraphChars: null, longParagraphs: { over600: null, over1200: null }
    };
    const paragraphs = article.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean);
    const lengths = paragraphs.map(value => value.length);
    return {
        status: 'known', chars: article.length, paragraphCount: paragraphs.length,
        maxParagraphChars: lengths.length ? Math.max(...lengths) : 0,
        longParagraphs: {
            over600: lengths.filter(value => value > 600).length,
            over1200: lengths.filter(value => value > 1200).length
        }
    };
}

function countStatus(value) {
    return Number.isInteger(value) && value >= 0
        ? { status: 'known', value }
        : { status: 'unknown', value: null };
}

function coverageStatus(total, covered) {
    if (!Number.isInteger(total) || total < 0) {
        return { status: 'unknown', total: null, covered: null, rate: null };
    }
    if (total === 0) return { status: 'not_applicable', total: 0, covered: 0, rate: null };
    if (!Number.isInteger(covered) || covered < 0 || covered > total) {
        return { status: 'unknown', total, covered: null, rate: null };
    }
    return { status: 'known', total, covered, rate: covered / total };
}

function dispositionsCovered(values, key, allowedIds) {
    if (!Array.isArray(values)) return null;
    return new Set(values.filter(item => item?.disposition !== 'omit')
        .map(item => String(item?.[key] || item?.id || '').trim())
        .filter(id => id && allowedIds.has(id))).size;
}

function referencedCovered(values, key, allowedIds) {
    if (!Array.isArray(values)) return null;
    return new Set(values.map(item => String(item?.[key] || item?.id || '').trim())
        .filter(id => id && allowedIds.has(id))).size;
}

function buildCoverage(artifact, record) {
    const bundle = record?.editorial?.longformBundle;
    const article = String(record?.editorial?.readerArticle || '').normalize('NFKC');
    const tables = Array.isArray(artifact?.tables) ? artifact.tables : [];
    const numericIds = tables.flatMap(tableNumericCellIds);
    const tableItems = Array.isArray(bundle?.tables) ? bundle.tables : null;
    const coveredNumericIds = tableItems
        ? new Set(tableItems.flatMap(item => Array.isArray(item?.coveredNumericCellIds) ? item.coveredNumericCellIds : []))
        : null;
    const validNumericCovered = coveredNumericIds
        ? numericIds.filter(id => coveredNumericIds.has(id)).length : null;
    const tableIds = new Set(tables.map(item => String(item?.id || item?.sourceTableId || '').trim()).filter(Boolean));
    const figureIds = new Set((artifact?.figures || []).map(item => String(item?.id || item?.url || '').trim()).filter(Boolean));
    const formulaIds = new Set((artifact?.formulas || []).map(item => String(item?.id || '').trim()).filter(Boolean));
    const usedTerms = (artifact?.acronyms || []).filter(item => {
        const value = String(item?.value || item?.term || '').normalize('NFKC').trim();
        if (value.length < 2) return false;
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, 'u').test(article);
    });
    const termIds = new Set(usedTerms.map(item => String(item?.id || '').trim()).filter(Boolean));
    const citationIds = new Set((artifact?.citations || []).map(item => String(item?.id || '').trim()).filter(Boolean));
    return {
        tables: coverageStatus(tables.length, dispositionsCovered(tableItems, 'sourceTableId', tableIds)),
        numericCells: coverageStatus(numericIds.length, validNumericCovered),
        figures: coverageStatus(artifact?.figures?.length ?? null, dispositionsCovered(bundle?.figures, 'id', figureIds)),
        formulas: coverageStatus(artifact?.formulas?.length ?? null, dispositionsCovered(bundle?.formulas, 'id', formulaIds)),
        terms: coverageStatus(termIds.size, referencedCovered(bundle?.terms, 'id', termIds)),
        relatedWorks: coverageStatus(Math.min(2, citationIds.size), Math.min(
            Math.min(2, citationIds.size), referencedCovered(bundle?.relatedWorks, 'citationId', citationIds) ?? 0
        ))
    };
}

function blockedCoverage(reason) {
    return Object.fromEntries(['tables', 'numericCells', 'figures', 'formulas', 'terms', 'relatedWorks'].map(key => [key, {
        status: 'blocked', reason, total: null, covered: null, rate: null
    }]));
}

function sourceSpanCoverage(artifact, record, blockedReason = null) {
    if (blockedReason) return {
        status: 'blocked', reason: blockedReason, total: null, covered: null, rate: null
    };
    const sourceIds = new Set((artifact?.sourceSpans || [])
        .map(item => String(item?.id || '').trim()).filter(Boolean));
    const blocks = record?.editorial?.longformBundle?.blocks;
    const covered = Array.isArray(blocks) ? new Set(blocks.flatMap(block => (
        Array.isArray(block?.evidenceSpanIds) ? block.evidenceSpanIds : []
    )).map(value => String(value || '').trim()).filter(id => sourceIds.has(id))).size : null;
    return coverageStatus(artifact?.sourceSpans?.length ?? null, covered);
}

function makeUnknownMetric() {
    return { status: 'unknown', value: null, display: 'unknown' };
}

function loadMetricStages(date, metricFiles, roots, inputFiles, options = {}) {
    const stages = Object.fromEntries(WORKFLOW_STAGES.map(stage => [stage, {
        durationMs: makeUnknownMetric(), queueMs: makeUnknownMetric(),
        cacheHitRate: makeUnknownMetric(), inputBytes: makeUnknownMetric(),
        outputBytes: makeUnknownMetric(), paperCount: makeUnknownMetric(),
        taskCount: makeUnknownMetric(), source: null
    }]));
    const seenStages = new Set();
    for (const metricFile of metricFiles) {
        const loaded = readJsonInput(metricFile, roots, 'stage_performance_metrics', inputFiles).value;
        const verified = verifyStageMetric(loaded, {
            projectRoot: options.projectRoot || Config.PROJECT_ROOT,
            allowedRoots: roots
        });
        if (loaded.mode !== METRICS_MODE || loaded.contract !== METRICS_CONTRACT || loaded.date !== date) {
            throw new Error(`shadow metrics 日期/契约非法: ${metricFile}`);
        }
        const stage = loaded.stage;
        if (seenStages.has(stage)) throw new Error(`同一 shadow report 不得重复提供 stage metrics: ${stage}`);
        seenStages.add(stage);
        if (!stages[stage]) stages[stage] = {
            durationMs: makeUnknownMetric(), queueMs: makeUnknownMetric(),
            cacheHitRate: makeUnknownMetric(), inputBytes: makeUnknownMetric(),
            outputBytes: makeUnknownMetric(), paperCount: makeUnknownMetric(),
            taskCount: makeUnknownMetric(), source: null
        };
        const known = measurement => measurement?.status === 'known'
            ? { status: 'known', value: measurement.value }
            : { status: measurement?.status || 'unknown', value: null };
        stages[stage].durationMs = known(loaded.timing.wallMs);
        stages[stage].queueMs = known(loaded.timing.queueMs);
        stages[stage].inputBytes = known(loaded.io.inputBytes);
        stages[stage].outputBytes = known(loaded.io.outputBytes);
        stages[stage].paperCount = known(loaded.work.paperCount);
        stages[stage].taskCount = known(loaded.work.taskCount);
        stages[stage].cacheHitRate = loaded.cache.status === 'known'
            ? {
                status: 'known', value: loaded.cache.hits / loaded.cache.total,
                hits: loaded.cache.hits, misses: loaded.cache.misses,
                display: `${loaded.cache.hits}/${loaded.cache.total}`
            }
            : { status: loaded.cache.status, value: null, display: loaded.cache.status };
        stages[stage].source = path.basename(metricFile);
        stages[stage].metricsContract = loaded.contract;
        stages[stage].measurementKind = loaded.timing.wallMs.aggregation;
        for (const [direction, descriptors] of [['input', verified.inputs], ['output', verified.outputs]]) {
            for (const descriptor of descriptors) inputFiles.push({
                ...descriptor,
                role: `metric_${stage}_${direction}:${descriptor.role}`
            });
        }
    }
    return stages;
}

function addDigestFetchMetrics(stages, digestReport) {
    const categories = digestReport?.fetch?.sourceHealth?.arxiv?.categories;
    if (!Array.isArray(categories) || categories.length < 1
        || categories.some(item => !Number.isFinite(item?.durationMs) || item.durationMs < 0)) return;
    const durationMs = categories.reduce((sum, item) => sum + item.durationMs, 0);
    stages.fetch_arxiv_category_sum = {
        durationMs: { status: 'known', value: durationMs, display: `${durationMs}ms` },
        cacheHitRate: makeUnknownMetric(),
        source: 'digest_run_report',
        metricKind: 'sum_of_recorded_category_durations',
        sampleCount: categories.length
    };
}

function addAuthorReceiptMetrics(stages, shadowRecords) {
    const durations = [];
    for (const record of shadowRecords.values()) {
        const receipt = record?.editorial?.longformBundle?.authorReceipt;
        const startedAt = Date.parse(receipt?.startedAt || '');
        const completedAt = Date.parse(receipt?.completedAt || '');
        if (Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt) {
            durations.push(completedAt - startedAt);
        }
    }
    if (!durations.length) return;
    const durationMs = durations.reduce((sum, value) => sum + value, 0);
    stages.author_receipt_sum = {
        durationMs: { status: 'known', value: durationMs, display: `${durationMs}ms` },
        cacheHitRate: makeUnknownMetric(),
        source: 'v6_author_receipts',
        metricKind: 'sum_of_recorded_task_run_durations',
        sampleCount: durations.length
    };
}

function summarizePapers(papers) {
    const values = Object.values(papers);
    const knownArticles = values.map(item => item.article).filter(item => item.status === 'known');
    const factCounts = values.map(item => item.facts.evidenceLedger.value + item.facts.resultClaims.value)
        .filter((_, index) => values[index].facts.evidenceLedger.status === 'known' && values[index].facts.resultClaims.status === 'known');
    const numericRates = values.map(item => item.coverage.numericCells)
        .filter(item => item.status === 'known').map(item => item.rate);
    const summarizeKnown = (list, fallbackStatus = 'unknown') => list.length ? {
        status: 'known', value: list.reduce((sum, value) => sum + value, 0) / list.length,
        sampleCount: list.length
    } : { status: fallbackStatus, value: null, sampleCount: 0 };
    const numericCoverageStatuses = values.map(item => item.coverage.numericCells.status);
    const numericFallback = numericCoverageStatuses.includes('blocked') ? 'blocked'
        : (numericCoverageStatuses.length > 0 && numericCoverageStatuses.every(status => status === 'not_applicable')
            ? 'not_applicable' : 'unknown');
    return {
        paperCount: values.length,
        blockedCount: values.filter(item => item.status === 'blocked').length,
        readyCount: values.filter(item => item.status === 'ready_for_v6_shadow').length,
        v6CandidateCount: values.filter(item => item.status === 'v6_candidate_available').length,
        quality: {
            articleCharsMean: summarizeKnown(knownArticles.map(item => item.chars)),
            factClaimsMean: summarizeKnown(factCounts),
            longParagraphsOver1200: knownArticles.length ? {
                status: 'known',
                value: knownArticles.reduce((sum, item) => sum + item.longParagraphs.over1200, 0),
                sampleCount: knownArticles.length
            } : { status: 'unknown', value: null, sampleCount: 0 },
            numericCellCoverageRate: summarizeKnown(numericRates, numericFallback)
        }
    };
}

function buildShadowReport(options) {
    const date = assertDate(options.date);
    const currentDir = path.resolve(options.currentDir || Config.CURRENT_DIR);
    const archiveDir = path.resolve(options.archiveDir || Config.ARCHIVE_DIR);
    const roots = [currentDir, archiveDir];
    const inputFiles = [];
    const filteredPath = options.filteredPath || findBatchJson(date, 'filtered-papers.json', currentDir, archiveDir);
    if (!filteredPath) throw new Error(`${date} 缺少已有 filtered-papers；shadow 禁止重新抓取`);
    const filtered = readJsonInput(filteredPath, roots, 'filtered_papers', inputFiles).value;
    if ((filtered.batchDate || filtered.date) !== date || filtered.status !== 'complete') {
        throw new Error('shadow 只接受目标日期 complete filtered 批次');
    }
    const paperIds = normalizedPaperSet(filtered);

    const fullTextDir = path.resolve(options.fullTextDir || path.join(currentDir, 'manual-full-text', date));
    const fullTextManifestPath = path.join(fullTextDir, 'manifest.json');
    if (!fs.existsSync(fullTextManifestPath)) throw new Error(`${date} 缺少已有 fulltext manifest；shadow 禁止重新抓取全文`);
    const fullTextManifest = readJsonInput(fullTextManifestPath, roots, 'fulltext_manifest', inputFiles).value;
    if (fullTextManifest.date !== date) throw new Error('fulltext manifest 日期不一致');

    const artifactDir = path.join(fullTextDir, 'artifacts');
    const artifactManifestPath = path.join(artifactDir, 'manifest.json');
    let artifactManifest = null;
    if (fs.existsSync(artifactManifestPath)) {
        artifactManifest = readJsonInput(artifactManifestPath, roots, 'artifact_manifest', inputFiles).value;
        if (artifactManifest.date !== date) throw new Error('ArtifactIndex manifest 日期不一致');
    }

    const workspaceDir = options.workspaceDir ? path.resolve(options.workspaceDir) : null;
    if (workspaceDir && fs.existsSync(workspaceDir)) {
        const shadowRoot = path.resolve(options.shadowRoot || Config.FILES.manualV6ShadowDir);
        existingRealpathWithin(workspaceDir, [shadowRoot], 'shadow_workspace');
        roots.push(workspaceDir);
    }
    const recordFiles = collectRecordFiles(currentDir, date, workspaceDir);
    const officialRecords = new Map();
    for (const file of recordFiles.official) {
        const value = readJsonInput(file, [currentDir], 'v5_record', inputFiles).value;
        absorbRecordEnvelope(officialRecords, value, date, file);
    }
    const shadowRecords = new Map();
    for (const file of recordFiles.shadow) {
        const value = readJsonInput(file, [workspaceDir], 'v6_shadow_record', inputFiles).value;
        absorbRecordEnvelope(shadowRecords, value, date, file);
    }

    const papers = {};
    for (const id of paperIds) {
        const v5Record = officialRecords.get(id) || null;
        const v6Record = shadowRecords.get(id) || null;
        const record = v6Record || v5Record;
        const failureReasons = [];
        let artifact = null;
        let status = 'ready_for_v6_shadow';
        const artifactEntry = artifactManifest?.papers?.[id];
        const sourceEntry = fullTextManifest?.papers?.[id];
        if (!artifactManifest || !artifactEntry || !sourceEntry?.structuredArtifactsSnapshot) {
            status = 'blocked';
            failureReasons.push('blocked_by_missing_structured_source');
        } else if (!['complete', 'incomplete'].includes(artifactEntry.status)) {
            status = 'blocked';
            failureReasons.push(`artifact_${artifactEntry.status || 'missing'}`);
        } else {
            const snapshotPointer = sourceEntry.structuredArtifactsSnapshot;
            const snapshotPath = path.isAbsolute(String(snapshotPointer.path || ''))
                ? snapshotPointer.path : path.join(artifactDir, String(snapshotPointer.path || ''));
            if (!snapshotPointer.path || !fs.existsSync(snapshotPath)) {
                status = 'blocked';
                failureReasons.push('structured_snapshot_file_missing');
            } else {
                const snapshot = readJsonInput(snapshotPath, [artifactDir], `structured_snapshot:${id}`, inputFiles);
                if (snapshotPointer.outputSha256 && snapshot.input.sha256 !== snapshotPointer.outputSha256) {
                    throw new Error(`${id} structured snapshot 文件 SHA 与 manifest 不一致`);
                }
                if (snapshot.value.mode !== 'manual_structured_source_snapshot'
                    || normalizedId(snapshot.value.paperId) !== id
                    || snapshot.value.payloadSha256 !== snapshotPointer.payloadSha256) {
                    throw new Error(`${id} structured snapshot 身份不一致`);
                }
            }
            const artifactPath = path.isAbsolute(String(artifactEntry.path || ''))
                ? artifactEntry.path : path.join(artifactDir, String(artifactEntry.path || ''));
            if (status !== 'blocked' && (!artifactEntry.path || !fs.existsSync(artifactPath))) {
                status = 'blocked';
                failureReasons.push('artifact_file_missing');
            } else if (status !== 'blocked') {
                const loaded = readJsonInput(artifactPath, [artifactDir], `artifact_index:${id}`, inputFiles);
                if (artifactEntry.outputSha256 && loaded.input.sha256 !== artifactEntry.outputSha256) {
                    throw new Error(`${id} ArtifactIndex 文件 SHA 与 manifest 不一致`);
                }
                artifact = loaded.value;
                if (normalizedId(artifact.paperId) !== id) throw new Error(`${id} ArtifactIndex paperId 不一致`);
                if (artifact.inputIdentity?.structuredArtifactsSha256 !== snapshotPointer.payloadSha256) {
                    throw new Error(`${id} ArtifactIndex 与 structured snapshot 输入身份不一致`);
                }
                const requiredInventories = [
                    'sourceSpans', 'tables', 'figures', 'formulas', 'acronyms', 'citations', 'references'
                ];
                if (artifact.inventoryHealth?.status !== 'complete'
                    || requiredInventories.some(field => !Array.isArray(artifact[field]))) {
                    status = 'blocked';
                    failureReasons.push('blocked_by_incomplete_structured_source');
                }
            }
        }
        if (v6Record && status !== 'blocked') status = 'v6_candidate_available';
        const facts = {
            evidenceLedger: countStatus(Array.isArray(record?.evidenceLedger) ? record.evidenceLedger.length : null),
            resultClaims: countStatus(Array.isArray(record?.resultClaims) ? record.resultClaims.length : null),
            sourceSpanCoverage: sourceSpanCoverage(
                artifact, v6Record, status === 'blocked' ? failureReasons[0] : null
            )
        };
        papers[id] = {
            paperId: id,
            status,
            failureReasons,
            recordSource: v6Record ? 'v6_shadow' : (v5Record ? 'v5_official' : 'unknown'),
            facts,
            inventory: artifact ? {
                status: artifact.inventoryHealth.status,
                sourceSpans: countStatus(artifact.sourceSpans?.length),
                tables: countStatus(artifact.tables?.length),
                numericCells: countStatus((artifact.tables || []).flatMap(tableNumericCellIds).length),
                figures: countStatus(artifact.figures?.length),
                formulas: countStatus(artifact.formulas?.length),
                terms: countStatus(artifact.acronyms?.length),
                relatedWorks: countStatus(artifact.citations?.length),
                references: countStatus(artifact.references?.length)
            } : {
                status: 'blocked', reason: failureReasons[0],
                sourceSpans: countStatus(null), tables: countStatus(null), numericCells: countStatus(null), figures: countStatus(null),
                formulas: countStatus(null), terms: countStatus(null), relatedWorks: countStatus(null), references: countStatus(null)
            },
            coverage: status === 'blocked'
                ? blockedCoverage(failureReasons[0])
                : buildCoverage(artifact, v6Record),
            article: articleMetrics(record)
        };
    }

    const metricFiles = [...(options.metricFiles || [])];
    if (workspaceDir && fs.existsSync(path.join(workspaceDir, 'metrics.json'))) {
        metricFiles.push(path.join(workspaceDir, 'metrics.json'));
    }
    const metrics = { stages: loadMetricStages(date, [...new Set(metricFiles)], roots, inputFiles, {
        projectRoot: options.projectRoot || Config.PROJECT_ROOT
    }) };
    addAuthorReceiptMetrics(metrics.stages, shadowRecords);
    const digestReportPath = path.join(currentDir, 'digest-run-reports', `${date}.json`);
    if (fs.existsSync(digestReportPath)) {
        const digestReport = readJsonInput(digestReportPath, [currentDir], 'digest_run_report', inputFiles).value;
        if (digestReport.batchDate === date) addDigestFetchMetrics(metrics.stages, digestReport);
    }
    const inputFingerprint = stableSha256({ date, paperIds, files: inputFiles.map(item => ({ role: item.role, sha256: item.sha256 })) });
    const summary = summarizePapers(papers);
    const status = summary.blockedCount === paperIds.length ? 'blocked'
        : (summary.blockedCount > 0 ? 'partial' : 'ready');
    return {
        version: SHADOW_REPORT_VERSION,
        mode: SHADOW_MODE,
        contractFingerprint: SHADOW_CONTRACT_FINGERPRINT,
        date,
        generatedAt: options.generatedAt || getBeijingISOString(),
        status,
        isolation: {
            fetched: false, fulltextFetched: false, canonicalWritten: false,
            blogGenerated: false, published: false
        },
        inputFingerprint,
        inputs: inputFiles,
        paperSet: { ids: paperIds, count: paperIds.length, sha256: stableSha256(paperIds) },
        papers,
        metrics,
        summary
    };
}

function initializeShadowWorkspace(report, workspaceDir, options = {}) {
    const date = report.date;
    const currentDate = options.currentDate || getBeijingDateString(0);
    if (date !== currentDate) throw new Error('只有北京时间当天 fresh 批次可显式 --init-shadow；历史批次仅允许审计');
    const shadowRoot = path.resolve(options.shadowRoot || Config.FILES.manualV6ShadowDir);
    const workspace = outputPathWithin(shadowRoot, workspaceDir, 'shadow workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const checkpointPath = outputPathWithin(shadowRoot, path.join(workspace, 'checkpoint.json'), 'shadow checkpoint');
    const checkpoint = {
        version: SHADOW_CHECKPOINT_VERSION,
        mode: 'manual_v6_shadow_checkpoint',
        date,
        inputFingerprint: report.inputFingerprint,
        paperSetSha256: report.paperSet.sha256,
        expectedPaperIds: report.paperSet.ids,
        status: report.status === 'blocked' ? 'blocked' : 'ready',
        officialMutationAllowed: false,
        publishAllowed: false,
        papers: Object.fromEntries(report.paperSet.ids.map(id => [id, {
            status: report.papers[id].status,
            failureReasons: report.papers[id].failureReasons
        }]))
    };
    if (fs.existsSync(checkpointPath)) {
        const existing = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
        if (existing.inputFingerprint !== checkpoint.inputFingerprint
            || existing.paperSetSha256 !== checkpoint.paperSetSha256) {
            throw new Error('shadow checkpoint 已绑定不同输入，拒绝覆盖');
        }
        return { checkpoint: existing, checkpointPath, cacheHit: true };
    }
    writeFileAtomic(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    return { checkpoint, checkpointPath, cacheHit: false };
}

function parseArgs(argv) {
    const options = { metricFiles: [], initShadow: false };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--date') options.date = argv[++index];
        else if (arg === '--output') options.output = argv[++index];
        else if (arg === '--workspace') options.workspaceDir = argv[++index];
        else if (arg === '--metrics') options.metricFiles.push(argv[++index]);
        else if (arg === '--init-shadow') options.initShadow = true;
        else throw new Error(`未知参数: ${arg}`);
    }
    assertDate(options.date);
    if (options.metricFiles.some(value => !value)) throw new Error('--metrics 缺少文件');
    if (options.initShadow && !options.workspaceDir) throw new Error('--init-shadow 必须显式提供 --workspace');
    return options;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const startedAtNs = monotonicNs();
    const shadowRoot = Config.FILES.manualV6ShadowDir;
    if (options.workspaceDir) {
        options.workspaceDir = outputPathWithin(shadowRoot, options.workspaceDir, 'shadow workspace');
    }
    const report = buildShadowReport(options);
    let checkpoint = null;
    if (options.initShadow) checkpoint = initializeShadowWorkspace(report, options.workspaceDir);
    const output = `${JSON.stringify({ ...report, shadowCheckpoint: checkpoint ? {
        path: path.relative(Config.PROJECT_ROOT, checkpoint.checkpointPath), cacheHit: checkpoint.cacheHit
    } : { status: 'not_applicable' } }, null, 2)}\n`;
    if (options.output || options.initShadow) {
        const target = outputPathWithin(shadowRoot, options.output || path.join(options.workspaceDir, 'report.json'), 'shadow report');
        const realInputPaths = new Set(report.inputs.map(input => path.resolve(
            path.isAbsolute(input.path) ? input.path : path.join(Config.PROJECT_ROOT, input.path)
        )));
        if (realInputPaths.has(path.resolve(target))) {
            throw new Error('shadow report 输出不得覆盖本次审计输入文件');
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        writeFileAtomic(target, output);
        const uniqueInputs = new Map();
        for (const input of report.inputs) {
            const inputPath = path.isAbsolute(input.path)
                ? input.path : path.join(Config.PROJECT_ROOT, input.path);
            const resolved = path.resolve(inputPath);
            if (!uniqueInputs.has(resolved)) uniqueInputs.set(resolved, {
                role: input.role,
                path: resolved
            });
        }
        persistStageMetricSafely({
            date: report.date,
            stage: 'shadow_audit',
            status: 'complete',
            wallNs: monotonicNs() - startedAtNs,
            wallAggregation: 'single_shadow_audit_and_report_write_wall',
            cache: checkpoint
                ? { hits: checkpoint.cacheHit ? 1 : 0, misses: checkpoint.cacheHit ? 0 : 1 }
                : undefined,
            paperCount: report.paperSet.count,
            taskCount: report.paperSet.count,
            inputFiles: [...uniqueInputs.values()],
            outputFiles: [{ role: 'shadow_report', path: target }]
        });
        console.log(`✅ Manual v6 shadow 报告：${target}`);
    } else {
        process.stdout.write(output);
    }
}

if (require.main === module) {
    try { main(); } catch (error) {
        console.error(`❌ Manual v6 shadow 失败: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    SHADOW_CHECKPOINT_VERSION,
    SHADOW_MODE,
    SHADOW_CONTRACT_FINGERPRINT,
    LONG_PARAGRAPH_THRESHOLDS,
    assertDate,
    isPathInside,
    existingRealpathWithin,
    outputPathWithin,
    articleMetrics,
    coverageStatus,
    loadMetricStages,
    buildShadowReport,
    initializeShadowWorkspace,
    parseArgs
};
