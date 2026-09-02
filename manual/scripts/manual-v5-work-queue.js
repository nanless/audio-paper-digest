#!/usr/bin/env node
'use strict';

/**
 * Read-only observer for the default Manual v5 paper queue.
 *
 * The observer never claims work, starts a subagent, edits records/canonical
 * data, or changes blog state.  It derives readiness from immutable artifacts
 * and writes only an isolated observability snapshot.  Active claims can only
 * come from an explicit orchestrator observation file whose task input SHA
 * still matches the current derived task.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
if (require.main === module) require('../../scripts/env-loader.js').requireExternalRuntime('manual-v5-work-queue.js');
const Config = require('../../scripts/config.js');
const { normalizedId, writeFileAtomic, getBeijingISOString } = require('../../scripts/utils.js');
const {
    AUTHORING_PROMPT_PATH,
    EDITORIAL_CONTRACT_PATH,
    BLANK_SCHEMA_PATH,
    defaultArticlePath,
    rawFileSha256,
    stableSha256,
    validateFreshAuthoringReceipt
} = require('./manual-fresh-authoring-contract.js');
const {
    PACKET_CONTRACT: AUTHOR_PACKET_CONTRACT,
    AUTHOR_TASK_INPUT_CONTRACT,
    buildAuthorPacket,
    defaultAuthorPacketPaths
} = require('./manual-v5-author-packet.js');

const VERSION = 1;
const MODE = 'manual_v5_observed_work_queue';
const METRICS_MODE = 'manual_v5_work_queue_metrics';
const OBSERVATIONS_MODE = 'manual_v5_orchestrator_observations';
const ACTIVE_LIMIT = 3;
const ROLES = Object.freeze(['author', 'reviewer', 'page_review']);
const SHA_RE = /^[a-f0-9]{64}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3,6})?\+08:00$/;

function sha256Bytes(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function assertDate(value) {
    const date = String(value || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date 必须是 YYYY-MM-DD');
    return date;
}

function parseArgs(argv) {
    const options = { writeSidecar: true };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--no-sidecar') {
            options.writeSidecar = false;
            continue;
        }
        if (!['--date', '--observations', '--output-dir'].includes(arg)) {
            throw new Error(`未知参数: ${arg}`);
        }
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
        options[arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
    }
    options.date = assertDate(options.date);
    return options;
}

function readPlainFile(filePath, label, required = true) {
    const declared = path.resolve(String(filePath || ''));
    const stat = fs.lstatSync(declared, { throwIfNoEntry: false });
    if (!stat) {
        if (!required) return null;
        throw new Error(`${label} 不存在: ${declared}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} 必须是普通文件且不得为 symlink`);
    return { path: fs.realpathSync(declared), bytes: fs.readFileSync(declared) };
}

function readJson(filePath, label, required = true) {
    const file = readPlainFile(filePath, label, required);
    if (!file) return null;
    try {
        return { ...file, value: JSON.parse(file.bytes.toString('utf8')) };
    } catch (error) {
        throw new Error(`${label} JSON 损坏: ${error.message}`);
    }
}

function descriptor(file, role, root) {
    if (!file) return null;
    return {
        role,
        path: path.relative(root, file.path),
        bytes: file.bytes.length,
        sha256: sha256Bytes(file.bytes)
    };
}

function describedFile(filePath, role, root, required = false) {
    const file = readPlainFile(filePath, role, required);
    return file ? descriptor(file, role, root) : null;
}

function unknownMeasurement(reason = 'not_observed_by_orchestrator_monotonic_clock') {
    return { status: 'unknown', value: null, clock: null, reason };
}

function knownMeasurement(value, field) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} 必须是非负安全整数`);
    return {
        status: 'known', value, unit: 'ms', clock: 'process.hrtime.bigint',
        source: 'orchestrator_observed_monotonic_v1'
    };
}

function validateObservations(document, date) {
    if (!document) return new Map();
    if (document.version !== 1 || document.mode !== OBSERVATIONS_MODE || document.date !== date
        || !Array.isArray(document.tasks)) {
        throw new Error(`observations 必须是 ${OBSERVATIONS_MODE} v1 且绑定 ${date}`);
    }
    const result = new Map();
    for (const [index, item] of document.tasks.entries()) {
        const paperId = normalizedId(item?.paperId);
        const role = String(item?.role || '');
        const key = `${paperId}:${role}`;
        if (!paperId || !ROLES.includes(role) || result.has(key)
            || !['claimed', 'running', 'finished'].includes(item.status)
            || !SHA_RE.test(String(item.inputSha256 || ''))
            || typeof item.taskName !== 'string' || item.taskName.trim().length < 4) {
            throw new Error(`observations.tasks[${index}] 身份/status/inputSha256 非法或重复`);
        }
        for (const field of ['claimedAt', 'startedAt', 'completedAt']) {
            if (item[field] !== null && item[field] !== undefined && !TIME_RE.test(String(item[field]))) {
                throw new Error(`observations.tasks[${index}].${field} 不是北京时间`);
            }
        }
        if (item.status === 'running' && !TIME_RE.test(String(item.startedAt || ''))) {
            throw new Error(`observations.tasks[${index}] running 必须提供 startedAt`);
        }
        if (item.status === 'finished' && !TIME_RE.test(String(item.completedAt || ''))) {
            throw new Error(`observations.tasks[${index}] finished 必须提供 completedAt`);
        }
        const measurements = item.measurements || {};
        result.set(key, {
            ...item,
            paperId,
            role,
            taskName: item.taskName.trim(),
            queueWaitMs: measurements.queueWaitMs === undefined
                ? unknownMeasurement()
                : knownMeasurement(measurements.queueWaitMs, `${key}.queueWaitMs`),
            runtimeMs: measurements.runtimeMs === undefined
                ? unknownMeasurement()
                : knownMeasurement(measurements.runtimeMs, `${key}.runtimeMs`)
        });
    }
    const activeCount = [...result.values()].filter(item => item.status !== 'finished').length;
    if (activeCount > ACTIVE_LIMIT) throw new Error(`observations 活动任务超过 ${ACTIVE_LIMIT} 槽`);
    return result;
}

function findRecordEnvelopes(currentDir, date, projectRoot) {
    const records = new Map();
    const descriptors = [];
    const names = fs.readdirSync(currentDir).filter(name => (
        name.startsWith('manual-analysis-record') && name.endsWith('.json')
    )).sort();
    for (const name of names) {
        const filePath = path.join(currentDir, name);
        let file;
        try {
            file = readJson(filePath, `record ${name}`);
        } catch {
            continue;
        }
        const envelope = file.value;
        if (envelope?.mode !== 'manual_analysis_records' || envelope.date !== date
            || !envelope.papers || typeof envelope.papers !== 'object') continue;
        descriptors.push(descriptor(file, 'manual_record_envelope', projectRoot));
        for (const [rawId, record] of Object.entries(envelope.papers)) {
            const id = normalizedId(rawId);
            if (!id || normalizedId(record) !== id) continue;
            if (records.has(id)) {
                records.set(id, { error: 'duplicate_record_envelopes', files: [records.get(id).file.path, file.path] });
            } else {
                records.set(id, { record, envelope, file });
            }
        }
    }
    return { records, descriptors };
}

function validateAuthorOutput(recordEntry, context) {
    if (!recordEntry) return { finished: false, reason: 'record_missing' };
    if (recordEntry.error) return { finished: false, reason: recordEntry.error };
    const record = recordEntry.record;
    const provenance = record?.researchBrief?.paperSubagent;
    if (!provenance || provenance.paperId !== context.paperId || provenance.singlePaperOnly !== true
        || provenance.isolatedContext !== true || provenance.model !== 'gpt-5.6-terra'
        || provenance.reasoningEffort !== 'high' || !TIME_RE.test(String(provenance.completedAt || ''))
        || typeof provenance.taskName !== 'string' || provenance.taskName.length < 4) {
        return { finished: false, reason: 'author_provenance_incomplete' };
    }
    try {
        const receipt = validateFreshAuthoringReceipt(record.freshAuthoring, {
            paperId: context.paperId,
            articlePath: context.articlePath,
            readerArticle: record.editorial?.readerArticle,
            authorityPaths: context.authorityPaths
        });
        return {
            finished: true,
            taskName: provenance.taskName,
            completedAt: provenance.completedAt,
            outputSha256: stableSha256({
                paperId: context.paperId,
                articleSha256: receipt.articleSha256,
                receiptSha256: receipt.receiptSha256,
                taskName: provenance.taskName
            }),
            recordFile: descriptor(recordEntry.file, 'manual_record_envelope', context.projectRoot)
        };
    } catch (error) {
        return { finished: false, reason: `fresh_authoring_invalid:${error.message}` };
    }
}

function validIndependentReview(value, authorTaskName, taskField) {
    return value?.independentReview === true
        && value.model === 'gpt-5.6-terra'
        && value.reasoningEffort === 'high'
        && typeof value[taskField] === 'string'
        && value[taskField].trim().length >= 4
        && value[taskField] !== authorTaskName;
}

function validateReviewerOutput(recordEntry, author) {
    if (!author.finished || !recordEntry || recordEntry.error) {
        return { finished: false, reason: author.finished ? 'record_missing' : 'author_not_finished' };
    }
    const record = recordEntry.record;
    const scoring = record.scoringCalibration;
    const readability = record.readabilityRubric;
    if (!validIndependentReview(scoring, author.taskName, 'reviewerTaskName')
        || scoring.crossDimensionChecked !== true || scoring.batchScaleChecked !== true) {
        return { finished: false, reason: 'technical_scoring_review_incomplete' };
    }
    if (!validIndependentReview(readability, author.taskName, 'reviewerTaskName')
        || readability.paperId !== recordEntry.record.arxivId) {
        return { finished: false, reason: 'readability_review_incomplete' };
    }
    if (readability.reviewerTaskName === scoring.reviewerTaskName) {
        return { finished: false, reason: 'review_task_names_not_independent' };
    }
    return {
        finished: true,
        taskName: `${scoring.reviewerTaskName}+${readability.reviewerTaskName}`,
        outputSha256: stableSha256({
            scoringTaskName: scoring.reviewerTaskName,
            scoring,
            readabilityTaskName: readability.reviewerTaskName,
            readability
        })
    };
}

function generatedPageForPaper(generation, paperId) {
    if (!generation || generation.date === undefined) return null;
    const suffix = paperId.replace('.', '-');
    const matches = (generation.files || []).filter(item => (
        item?.deleted === false && typeof item.path === 'string'
        && item.path.endsWith(`-${suffix}.md`) && SHA_RE.test(String(item.sha256 || ''))
    ));
    return matches.length === 1 ? matches[0] : null;
}

function materializeTask(options) {
    const {
        paperId, role, inputSha256, finished, finishedDetails, blockedReasons,
        observation, inputFiles, staleObservation, packet
    } = options;
    let status;
    if (finished) status = 'finished';
    else if (blockedReasons.length) status = 'blocked';
    else if (observation && observation.inputSha256 === inputSha256) status = 'claimed';
    else status = 'ready';
    return {
        paperId,
        role,
        status,
        inputSha256,
        inputFiles: inputFiles.filter(Boolean),
        packet: packet || null,
        blockingReasons: status === 'blocked' ? blockedReasons : [],
        taskName: status === 'claimed' ? observation.taskName : (finishedDetails?.taskName || null),
        claimState: status === 'claimed' ? observation.status : null,
        staleObservation: Boolean(staleObservation || (observation && observation.inputSha256 !== inputSha256)),
        outputSha256: finishedDetails?.outputSha256 || null,
        completedAt: finishedDetails?.completedAt || null,
        performance: {
            queueWaitMs: observation?.inputSha256 === inputSha256
                ? observation.queueWaitMs : unknownMeasurement(),
            runtimeMs: observation?.inputSha256 === inputSha256
                ? observation.runtimeMs : unknownMeasurement()
        }
    };
}

function buildWorkQueue(options) {
    const scanStart = process.hrtime.bigint();
    const date = assertDate(options.date);
    const projectRoot = path.resolve(options.projectRoot || Config.PROJECT_ROOT);
    const currentDir = path.resolve(options.currentDir || Config.CURRENT_DIR);
    const filteredPath = path.resolve(options.filteredPath || Config.FILES.filteredPapers);
    const fulltextManifestPath = path.resolve(options.fulltextManifestPath || path.join(
        currentDir, 'manual-full-text', date, 'manifest.json'
    ));
    const artifactManifestPath = path.resolve(options.artifactManifestPath || path.join(
        currentDir, 'manual-full-text', date, 'artifacts', 'manifest.json'
    ));
    const generationPath = path.resolve(options.generationPath || path.join(
        currentDir, `blog-generation-manifest-${date}.json`
    ));
    const reviewPassesPath = path.resolve(options.reviewPassesPath || path.join(
        currentDir, `blog-review-passes-${date}.json`
    ));
    const blogRepo = path.resolve(options.blogRepo || Config.PUBLISH_CONFIG.blogRepo);
    const filteredFile = readJson(filteredPath, 'filtered-papers');
    if (filteredFile.value?.status !== 'complete' || filteredFile.value?.batchDate !== date
        || !Array.isArray(filteredFile.value?.papers)) {
        throw new Error(`filtered-papers 不是 ${date} complete 批次`);
    }
    const fulltextFile = readJson(fulltextManifestPath, 'manual fulltext manifest', false);
    const artifactFile = readJson(artifactManifestPath, 'ArtifactIndex manifest', false);
    const generationFile = readJson(generationPath, 'blog generation manifest', false);
    const reviewPassesFile = readJson(reviewPassesPath, 'blog review passes', false);
    const observationsFile = options.observationsPath
        ? readJson(options.observationsPath, 'orchestrator observations', false)
        : null;
    const observations = validateObservations(observationsFile?.value, date);
    const { records, descriptors: recordDescriptors } = findRecordEnvelopes(currentDir, date, projectRoot);
    const filteredDescriptor = descriptor(filteredFile, 'filtered_papers', projectRoot);
    const fulltextDescriptor = descriptor(fulltextFile, 'fulltext_manifest', projectRoot);
    const artifactDescriptor = descriptor(artifactFile, 'artifact_manifest', projectRoot);
    const generationDescriptor = descriptor(generationFile, 'blog_generation_manifest', projectRoot);
    const reviewPassesDescriptor = descriptor(reviewPassesFile, 'blog_review_passes', projectRoot);
    const staticFiles = {
        prompt: describedFile(options.authoringPromptPath || AUTHORING_PROMPT_PATH, 'authoring_prompt', projectRoot, true),
        contract: describedFile(options.editorialContractPath || EDITORIAL_CONTRACT_PATH, 'editorial_contract', projectRoot, true),
        schema: describedFile(options.blankSchemaPath || BLANK_SCHEMA_PATH, 'blank_schema', projectRoot, true)
    };
    const pagePasses = new Set((reviewPassesFile?.value?.files || []).map(item => `${item.path}:${item.sha256}`));
    const papers = {};
    const tasks = [];
    const ids = filteredFile.value.papers.map(normalizedId).sort();
    for (const paperId of ids) {
        const paper = filteredFile.value.papers.find(item => normalizedId(item) === paperId);
        const source = fulltextFile?.value?.papers?.[paperId];
        const artifact = artifactFile?.value?.papers?.[paperId];
        const sourceFile = source?.path ? describedFile(source.path, 'paper_fulltext', projectRoot, false) : null;
        const artifactIndexFile = artifact?.path ? describedFile(artifact.path, 'artifact_index', projectRoot, false) : null;
        let artifactInventoryComplete = false;
        if (artifactIndexFile && artifact?.status === 'complete' && artifact?.inventoryStatus === 'complete') {
            try {
                const artifactIndex = JSON.parse(fs.readFileSync(path.resolve(projectRoot, artifactIndexFile.path), 'utf8'));
                artifactInventoryComplete = artifactIndex?.inventoryHealth?.status === 'complete';
            } catch {
                artifactInventoryComplete = false;
            }
        }
        const authorBlocks = [];
        if (!source || source.status !== 'complete' || !sourceFile || source.sourceSha256 !== sourceFile.sha256) {
            authorBlocks.push('fulltext_missing_incomplete_or_sha_drift');
        }
        if (!artifact || artifact.status !== 'complete' || artifact.inventoryStatus !== 'complete'
            || !artifactIndexFile || artifact.outputSha256 !== artifactIndexFile.sha256 || !artifactInventoryComplete) {
            authorBlocks.push('artifact_index_inventory_not_complete_or_sha_drift');
        }
        let authorPacketBuild = null;
        try {
            authorPacketBuild = buildAuthorPacket({
                date,
                paperId,
                projectRoot,
                currentDir,
                filteredPath,
                fulltextManifestPath,
                artifactManifestPath,
                blogRepo,
                authoringPromptPath: options.authoringPromptPath || AUTHORING_PROMPT_PATH,
                editorialContractPath: options.editorialContractPath || EDITORIAL_CONTRACT_PATH,
                blankSchemaPath: options.blankSchemaPath || BLANK_SCHEMA_PATH
            });
        } catch (error) {
            authorBlocks.push(`author_packet_invalid:${error.message}`);
        }
        const authorPacketPaths = authorPacketBuild?.packetPaths
            || defaultAuthorPacketPaths(currentDir, date, paperId);
        const authorInputFiles = authorPacketBuild
            ? authorPacketBuild.packet.allowedInputs.map(item => ({
                role: item.kind,
                path: item.projectRelativePath,
                bytes: item.bytes,
                sha256: item.sha256
            }))
            : [sourceFile, artifactIndexFile, staticFiles.prompt, staticFiles.contract, staticFiles.schema]
                .filter(Boolean);
        const authorInputSha256 = authorPacketBuild?.packet.inputSha256 || stableSha256({
            contract: AUTHOR_TASK_INPUT_CONTRACT,
            date,
            paperId,
            status: 'blocked_before_exact_author_packet',
            reasons: [...authorBlocks].sort(),
            paperMetadataSha256: stableSha256(paper),
            files: authorInputFiles.map(item => ({ role: item.role, sha256: item.sha256 }))
        });
        const articlePath = options.articlePathResolver
            ? options.articlePathResolver(date, paperId)
            : defaultArticlePath(currentDir, date, paperId);
        const recordEntry = records.get(paperId);
        const officialEvidenceInput = authorPacketBuild?.packet.allowedInputs.find(
            item => item.kind === 'official_project_evidence'
        );
        const authorityPaths = {
            paperId,
            filteredPath,
            sourcePath: source?.path,
            artifactPath: artifact?.path,
            authoringPromptPath: options.authoringPromptPath || AUTHORING_PROMPT_PATH,
            editorialContractPath: options.editorialContractPath || EDITORIAL_CONTRACT_PATH,
            blankSchemaPath: options.blankSchemaPath || BLANK_SCHEMA_PATH,
            ...(officialEvidenceInput
                ? { officialProjectEvidencePath: officialEvidenceInput.path }
                : {})
        };
        const authorOutput = validateAuthorOutput(recordEntry, {
            paperId, articlePath, authorityPaths, projectRoot
        });
        const authorObservation = observations.get(`${paperId}:author`);
        const authorTask = materializeTask({
            paperId, role: 'author', inputSha256: authorInputSha256,
            finished: authorOutput.finished && Boolean(authorPacketBuild), finishedDetails: authorOutput,
            blockedReasons: authorBlocks, observation: authorObservation,
            inputFiles: authorInputFiles,
            packet: {
                contract: AUTHOR_PACKET_CONTRACT,
                inputContract: AUTHOR_TASK_INPUT_CONTRACT,
                path: path.relative(projectRoot, authorPacketPaths.packetPath),
                command: `npm run manual:v5:author-packet -- --date ${date} --paper ${paperId}`,
                materialized: Boolean(fs.lstatSync(authorPacketPaths.packetPath, { throwIfNoEntry: false })),
                expectedPacketSha256: authorPacketBuild?.packet.packetSha256 || null
            }
        });
        const reviewerInputFiles = [...authorInputFiles, authorOutput.recordFile].filter(Boolean);
        const reviewerInputSha256 = stableSha256({
            contract: 'manual-v5-reviewer-task-input-v1', paperId,
            authorOutputSha256: authorOutput.outputSha256 || null,
            files: reviewerInputFiles.map(item => ({ role: item.role, sha256: item.sha256 }))
        });
        const reviewerOutput = validateReviewerOutput(recordEntry, authorOutput);
        const reviewerBlocks = authorOutput.finished ? [] : ['author_not_finished'];
        const reviewerTask = materializeTask({
            paperId, role: 'reviewer', inputSha256: reviewerInputSha256,
            finished: reviewerOutput.finished, finishedDetails: reviewerOutput,
            blockedReasons: reviewerBlocks,
            observation: observations.get(`${paperId}:reviewer`), inputFiles: reviewerInputFiles
        });
        const page = generatedPageForPaper(generationFile?.value, paperId);
        let pageFile = null;
        let pageShaMatches = false;
        if (page) {
            const absolutePagePath = path.join(blogRepo, page.path);
            pageFile = describedFile(absolutePagePath, 'generated_blog_page', projectRoot, false);
            pageShaMatches = Boolean(pageFile && pageFile.sha256 === page.sha256);
        }
        const pageInputFiles = [generationDescriptor, pageFile].filter(Boolean);
        const pageInputSha256 = stableSha256({
            contract: 'manual-v5-page-review-task-input-v1', paperId,
            pagePath: page?.path || null, pageSha256: page?.sha256 || null,
            files: pageInputFiles.map(item => ({ role: item.role, sha256: item.sha256 }))
        });
        const pageFinished = Boolean(
            reviewerOutput.finished && page && pageShaMatches
            && pagePasses.has(`${page.path}:${page.sha256}`)
        );
        const pageBlocks = [];
        if (!reviewerOutput.finished) pageBlocks.push('reviewer_not_finished');
        if (!page) pageBlocks.push('generation_page_missing');
        else if (!pageShaMatches) pageBlocks.push('generation_page_sha_drift_or_file_missing');
        const pageTask = materializeTask({
            paperId, role: 'page_review', inputSha256: pageInputSha256,
            finished: pageFinished,
            finishedDetails: pageFinished ? { outputSha256: page.sha256 } : null,
            blockedReasons: pageBlocks,
            observation: observations.get(`${paperId}:page_review`), inputFiles: pageInputFiles
        });
        papers[paperId] = { paperId, tasks: { author: authorTask, reviewer: reviewerTask, page_review: pageTask } };
        tasks.push(authorTask, reviewerTask, pageTask);
    }
    const activeTasks = tasks.filter(item => item.status === 'claimed');
    if (activeTasks.length > ACTIVE_LIMIT) throw new Error(`当前有效 claim 超过 ${ACTIVE_LIMIT} 槽`);
    const availableSlots = ACTIVE_LIMIT - activeTasks.length;
    const ready = tasks.filter(item => item.status === 'ready');
    const rolePriority = { author: 0, reviewer: 1, page_review: 2 };
    ready.sort((left, right) => rolePriority[left.role] - rolePriority[right.role]
        || left.paperId.localeCompare(right.paperId));
    const dispatch = ready.slice(0, availableSlots).map(item => ({
        paperId: item.paperId, role: item.role, inputSha256: item.inputSha256,
        requiredModel: 'gpt-5.6-terra', requiredReasoningEffort: 'high',
        ...(item.role === 'author' ? { packet: item.packet } : {})
    }));
    const scanEnd = process.hrtime.bigint();
    const scanMs = Number((scanEnd - scanStart + 999999n) / 1000000n);
    const sourceFiles = [
        filteredDescriptor, fulltextDescriptor, artifactDescriptor,
        generationDescriptor, reviewPassesDescriptor,
        descriptor(observationsFile, 'orchestrator_observations', projectRoot),
        staticFiles.prompt, staticFiles.contract, staticFiles.schema,
        ...recordDescriptors
    ].filter(Boolean);
    const counts = Object.fromEntries(['ready', 'blocked', 'claimed', 'finished'].map(status => [
        status, tasks.filter(item => item.status === status).length
    ]));
    const perRole = Object.fromEntries(ROLES.map(role => [role, Object.fromEntries(
        ['ready', 'blocked', 'claimed', 'finished'].map(status => [
            status, tasks.filter(item => item.role === role && item.status === status).length
        ])
    )]));
    return {
        version: VERSION,
        mode: MODE,
        date,
        generatedAt: options.generatedAt || getBeijingISOString(),
        activeLimit: ACTIVE_LIMIT,
        summary: {
            paperCount: ids.length,
            taskCount: tasks.length,
            ...counts,
            perRole,
            activeClaims: activeTasks.length,
            availableSlots,
            dispatchableNow: dispatch.length
        },
        dispatch,
        papers,
        sourceFiles,
        sourceFingerprint: stableSha256(sourceFiles),
        performance: {
            contract: 'manual-v5-work-queue-observed-v1',
            scanWallMs: {
                status: 'known', value: scanMs, unit: 'ms', clock: 'process.hrtime.bigint',
                source: 'observer_scan_monotonic_v1'
            },
            taskTimingRule: 'only_explicit_orchestrator_monotonic_measurements_are_known',
            timestampDifferencesUsed: false
        }
    };
}

function buildMetricsSidecar(report) {
    const taskMetrics = [];
    for (const paper of Object.values(report.papers)) {
        for (const role of ROLES) {
            const task = paper.tasks[role];
            taskMetrics.push({
                paperId: paper.paperId,
                role,
                status: task.status,
                inputSha256: task.inputSha256,
                queueWaitMs: task.performance.queueWaitMs,
                runtimeMs: task.performance.runtimeMs
            });
        }
    }
    return {
        version: 1,
        mode: METRICS_MODE,
        contract: 'manual-v5-work-queue-observed-v1',
        date: report.date,
        recordedAt: report.generatedAt,
        scanWallMs: report.performance.scanWallMs,
        taskTimingRule: report.performance.taskTimingRule,
        timestampDifferencesUsed: false,
        counts: report.summary,
        tasks: taskMetrics,
        sourceFingerprint: report.sourceFingerprint
    };
}

function writeSidecars(report, outputDir) {
    const target = path.resolve(outputDir);
    const currentRoot = fs.realpathSync(Config.CURRENT_DIR);
    const relative = path.relative(currentRoot, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('output-dir 必须位于 data/current 内');
    }
    fs.mkdirSync(target, { recursive: true });
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('output-dir 不得为 symlink');
    const queuePath = path.join(target, 'work-queue.json');
    const metricsPath = path.join(target, 'metrics.json');
    writeFileAtomic(queuePath, JSON.stringify(report, null, 2));
    const queueBytes = fs.readFileSync(queuePath);
    const metrics = {
        ...buildMetricsSidecar(report),
        queueSnapshot: {
            path: path.relative(Config.PROJECT_ROOT, queuePath),
            bytes: queueBytes.length,
            sha256: sha256Bytes(queueBytes)
        }
    };
    writeFileAtomic(metricsPath, JSON.stringify(metrics, null, 2));
    return { queuePath, metricsPath };
}

function run(argv = process.argv.slice(2), overrides = {}) {
    const args = parseArgs(argv);
    const outputDir = path.resolve(args.outputDir || path.join(
        Config.FILES.manualV5ObservabilityDir, args.date
    ));
    const defaultObservations = path.join(outputDir, 'observations.json');
    const observationsPath = args.observations || (fs.existsSync(defaultObservations) ? defaultObservations : null);
    const report = buildWorkQueue({ ...overrides, date: args.date, observationsPath });
    const paths = args.writeSidecar ? writeSidecars(report, outputDir) : null;
    console.log(JSON.stringify({
        date: report.date,
        summary: report.summary,
        dispatch: report.dispatch,
        sidecars: paths
    }, null, 2));
    return { report, paths };
}

if (require.main === module) {
    try { run(); } catch (error) {
        console.error(`Manual v5 work queue 失败: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    VERSION,
    MODE,
    METRICS_MODE,
    OBSERVATIONS_MODE,
    ACTIVE_LIMIT,
    ROLES,
    parseArgs,
    validateObservations,
    validateAuthorOutput,
    validateReviewerOutput,
    materializeTask,
    buildWorkQueue,
    buildMetricsSidecar,
    writeSidecars,
    run
};
