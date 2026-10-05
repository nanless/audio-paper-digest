'use strict';
const fs = require('node:fs'),
    path = require('node:path'),
    crypto = require('node:crypto');
const io = require('./historical-conference-page-projections.js'),
    runner = require('./historical-direct-rewrite-runner.js');
const api = require('./historical-source-tag-assignment.js'),
    writer = require('./historical-direct-tag-supplement.js');
const snippets = require('./source-evidence-snippets.js');
const digest = v => crypto.createHash('sha256').update(v).digest('hex');
const fail = m => {
    throw new Error("来源标签检查点导出被拒绝：" + m);
};

function validateExcludedIds(ids, selection, plan) {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length ||
        ids.some(id => !selection.paperIds.includes(id) || !plan.queue.some(item => item.paperId === id)))
        fail("排除论文编号必须组成数组，不能重复，且必须同时属于原选择集合和计划。");
    return ids;
}

function validateSelectionPlan(selection, plan) {
    if (!Array.isArray(plan?.queue) || !Array.isArray(selection?.paperIds) ||
        new Set(selection.paperIds).size !== selection.paperIds.length)
        fail("选择记录的 paperIds 和计划的 queue 必须是数组，论文编号不能重复。每个计划项须有非空字符串编号和非空页面数组。");
    const items = new Map(),
        pagePaths = new Set();
    for (const item of plan.queue) {
        if (!item || typeof item.paperId !== 'string' || !item.paperId || items.has(item.paperId) ||
            !Array.isArray(item.pages) ||
            !item.pages.length)
            fail("选择记录的 paperIds 和计划的 queue 必须是数组，论文编号不能重复。每个计划项须有非空字符串编号和非空页面数组。");
        for (const page of item.pages) {
            if (!page || typeof page.pagePath !== 'string' || !page.pagePath ||
                pagePaths.has(page.pagePath) ||
                typeof page.pageKey !== 'string' ||
                !page.pageKey ||
                !/^[a-f0-9]{64}$/.test(page.pageContentSha256 || ''))
                fail("计划中的页面路径必须是非空字符串且不能重复；每项页面记录还必须提供非空字符串编号和有效的内容 SHA。");
            pagePaths.add(page.pagePath);
        }
        items.set(item.paperId, item);
    }
    if (selection.paperIds.some(id => !items.has(id)))
        fail("选择集合中包含计划未列出的论文编号。");
    return items;
}

function validatePageRecordsAgainstPlan(records, items) {
    for (const [key, record] of Object.entries(records)) {
        const item = items.get(record?.paperId),
            page = item?.pages.find(p => p.pagePath === key);
        if (!page || record.pageKey !== page.pageKey || record.pageSha256 !== page.pageContentSha256)
            fail("页面记录无法对应计划中的论文和页面，或所在路径、页面编号及内容 SHA 不一致。");
    }
    return records;
}

function validatePageClassificationRecord(record, classification) {
    const { proofSha256, ...pageRecordFields } = record;
    if (proofSha256 !== runner.stableHash(pageRecordFields) ||
        record.classificationRecordSha256 !== runner.stableHash(classification) ||
        record.classificationProofSha256 !== classification.proofSha256 ||
        record.requestStageFingerprint !== classification.fingerprint ||
        record.paperId !== classification.paperId ||
        runner.stableHash(record.source) !== runner.stableHash(classification.source) ||
        runner.stableHash(record.evidence) !== runner.stableHash(classification.concepts) ||
        record.primaryTaskId !== classification.primaryTaskId ||
        record.primaryMethodId !== classification.primaryMethodId)
        fail("页面记录的内容哈希不一致，或分类结果、请求指纹、论文、来源、概念及主标签与已接受的分类记录不对应。");
    return record;
}

function filterAndValidatePageRecords(records, classifications, excludePaperIds) {
    const result = {};
    for (const [key, r] of Object.entries(records)) {
        if (excludePaperIds.includes(r.paperId))
            continue;
        if (!classifications.has(r.paperId))
            fail("页面记录的论文缺少已重新核验的分类缓存。");
        result[key] = validatePageClassificationRecord(r, classifications.get(r.paperId));
    }
    return result;
}

function buildPageClassificationRecord(item, page, loaded, record, tagRules) {
    if (loaded.fileSha256 !== page.pageContentSha256 || record.paperId !== item.paperId)
        fail("读取页面的 SHA 与计划不一致，或分类记录中的论文编号与当前计划项不一致。");
    const pageRecordFields = {
        paperId: item.paperId,
        runId: record.runId,
        pageKey: page.pageKey,
        pageSha256: loaded.fileSha256,
        bodySha256: digest(writer.pageBody(loaded.bytes)),
        registrySha256: tagRules.registrySha256,
        registryVersion: tagRules.registryVersion,
        concepts: record.concepts.map(({ id, facet, label }) => ({ id, facet, label })),
        primaryTaskId: record.primaryTaskId,
        primaryTaskLabel: record.primaryTaskLabel,
        primaryMethodId: record.primaryMethodId,
        primaryMethodLabel: record.primaryMethodLabel,
        evidenceType: 'source-only-taxonomy',
        classificationContract: api.CONTRACT,
        classificationRecordSha256: runner.stableHash(record),
        classificationProofSha256: record.proofSha256,
        source: record.source,
        evidence: record.concepts,
        evidenceSelectionContract: record.evidenceSelectionContract,
        quoteSelections: record.quoteSelections,
        requestStageFingerprint: record.fingerprint,
        reviewProof: record.reviewProof,
        reviewProofSha256: record.reviewProofSha256
    };
    return {
        ...pageRecordFields,
        proofSha256: runner.stableHash(pageRecordFields)
    };
}

function processedIdsForExport(selection, checkpoint, classifications) {
    if (checkpoint.checkpointScheduling === 'completion-set-v1') {
        const acceptedPaperIds = new Set(checkpoint.decisions.map(d => d.paperId));
        if ([...acceptedPaperIds].some(id => !classifications.has(id)))
            fail("检查点中已接受的论文决策缺少已重新核验的分类缓存。");
        return [...checkpoint.processedPaperIds];
    }
    const failedPaperIds = new Set(checkpoint.failures.map(f => f.paperId)),
        processed = [];
    for (const id of selection.paperIds) {
        if (!classifications.has(id) && !failedPaperIds.has(id))
            break;
        processed.push(id);
    }
    if (processed.length < checkpoint.processed ||
        [...classifications.keys()].some(id => !processed.includes(id)))
        fail("已接受的分类缓存超出按原选择顺序可重建的连续范围，或该范围未覆盖检查点记载的已处理数量。");
    return processed;
}

function normalizeCheckpoint(value, selection, options) {
    if (!Object.hasOwn(value || {}, 'report')) {
        api.validateResumeCheckpoint(value, selection, options);
        return value;
    }
    // 部分运行的报告和分类补充保存在同一条独立记录中。先核对其格式、数量、停止信息
    // 及文件名，再把实际已处理集合交给原检查点验证器；这不表示整批已经完成。
    const report = value.report,
        records = value.supplement?.records;
    const statuses = new Set([
        'operator-stopped',
        'implementation-changed',
        'local-integrity-failure',
        'account-pool-exhausted',
        'account-authentication-failed',
        'account-service-unavailable',
        'model-service-timeout',
        'model-service-network-unavailable',
        'model-service-http-unavailable',
        'model-service-configuration-unavailable',
        'model-account-state-unavailable',
        'model-service-response-unavailable'
    ]);
    if (value.contract !== api.CONTRACT + '-checkpoint' ||
        value.supplement?.contract !== writer.CONTRACT ||
        !records ||
        typeof records !== 'object' ||
        Array.isArray(records) ||
        report?.contract !== api.CONTRACT + '-report' ||
        report.state !== 'partial' ||
        !Number.isSafeInteger(report.selected) ||
        report.selected < 1 ||
        report.selected !== selection?.paperIds?.length ||
        !Number.isSafeInteger(report.processed) ||
        report.processed < 1 ||
        report.processed > report.selected ||
        !Array.isArray(report.decisions) ||
        !Array.isArray(report.failures) ||
        report.processed !== report.decisions.length + report.failures.length ||
        report.pageCount !== Object.keys(records).length ||
        !Array.isArray(report.remainingPaperIds) ||
        !Array.isArray(selection.paperIds) ||
        new Set(selection.paperIds).size !== selection.paperIds.length ||
        !report.stopped ||
        !statuses.has(report.stopped.status) ||
        typeof report.stopped.error !== 'string' ||
        !report.stopped.error ||(
        report.stopped.paperId !== undefined &&
        !selection.paperIds.includes(report.stopped.paperId)) ||
        path.basename(options.filename) !== 'partial-' + String(report.processed).padStart(6, '0') + '-' + runner.stableHash(value).slice(0, 16) + '.json')
        fail("部分运行记录未通过核验。请核对字段与记录类型、数量和页面统计、与原选择记录的对应关系、剩余论文列表及停止信息，以及文件名中的已处理数量和内容哈希。");
    const done = [...report.decisions, ...report.failures].map(r => r.paperId),
        set = new Set(done);
    const remaining = selection.paperIds.filter(id => !set.has(id));
    if (set.size !== done.length || done.some(id => !selection.paperIds.includes(id)) ||
        JSON.stringify(report.remainingPaperIds) !== JSON.stringify(remaining))
        fail("已处理集合包含重复或未入选的论文，或者剩余论文列表的内容和顺序不符合原选择记录。");
    const normalized = {
        contract: value.contract,
        checkpointScheduling: 'completion-set-v1',
        processedPaperIds: selection.paperIds.filter(id => set.has(id)),
        supplement: value.supplement,
        processed: report.processed,
        decisions: report.decisions,
        failures: report.failures
    };
    api.validateResumeCheckpoint(
        normalized,
        selection,
        {
            ...options,
            filename: 'checkpoint-' + String(normalized.processed).padStart(6, '0') + '-' + runner.stableHash(normalized).slice(0, 16) + '.json'
        }
    );
    return normalized;
}

async function exportCheckpoint(options) {
    const config = require('../config.js'),
        { plan } = writer.readPlanRegistry(options);
    const tagRules = require('./tag-rules.js').createTagRules({ registryPath: options.registrySnapshot });
    const checkpointDirectory = path.dirname(options.checkpointFile),
        loadedCheckpointFile = io.readStableJson(options.checkpointFile, 'original immutable classifier checkpoint');
    const selection = io.readStableJson(path.join(checkpointDirectory, 'selection.json'), 'original immutable selection');
    const checkpoint = {
        ...loadedCheckpointFile,
        value: normalizeCheckpoint(
            loadedCheckpointFile.value,
            selection.value,
            {
                planSha256: plan.planSha256,
                registrySha256: tagRules.registrySha256,
                filename: options.checkpointFile
            }
        )
    };
    const planItemsByPaperId = validateSelectionPlan(selection.value, plan),
        acceptedClassificationsByPaperId = new Map(),
        excludedPaperIds = validateExcludedIds(options.excludePaperIds || [], selection.value, plan);
    const usesCompletionSetCheckpoint = checkpoint.value.checkpointScheduling === 'completion-set-v1';
    const checkpointCacheNames = new Set(checkpoint.value.decisions.map(d => 'decision-' + digest(d.paperId).slice(0, 16) + '-' + d.fingerprint + '.json'));
    for (const filename of fs.readdirSync(checkpointDirectory).filter(n => n.startsWith('decision-') && n.endsWith('.json')).sort()) {
        // 采用已处理集合格式的检查点时，只读取决策记录对应文件名的分类缓存。
        // 其他并行缓存即使已保存模型响应，本次也不读取或导出。
        if (usesCompletionSetCheckpoint && !checkpointCacheNames.has(filename))
            continue;
        const record = io.readStableJson(path.join(checkpointDirectory, filename), 'accepted classifier cache').value;
        if (filename !== 'decision-' + digest(record.paperId).slice(0, 16) + '-' + record.fingerprint + '.json' ||
            !selection.value.paperIds.includes(record.paperId) ||
            acceptedClassificationsByPaperId.has(record.paperId))
            fail("分类缓存文件名与论文编号及请求指纹不一致，或者缓存属于未入选论文、同一论文的缓存重复。");
        const sourceDetails = await api.loadSource(planItemsByPaperId.get(record.paperId), config, 1);
        // 以下两个明确排除的论文仍计入已处理集合，但不导出其分类记录。若旧缓存没有
        // PDF 版本字段而本次来源对象已有该字段，仅在用于比对的来源对象中去除新增字段。
        if (excludedPaperIds.includes(record.paperId) &&
            ['arxiv:2605.12987', 'arxiv:2606.01009'].includes(record.paperId) &&
            sourceDetails.source.pdfVersionBinding &&
            !Object.hasOwn(record.source, 'pdfVersionBinding')) {
            delete sourceDetails.source.pdfVersionBinding;
            delete sourceDetails.source.sourceVersionWarning;
        }
        api.validateCachedDecision(
            record,
            {
                fingerprint: record.fingerprint,
                runtime: tagRules,
                bundle: snippets.buildSnippets(sourceDetails.text),
                source: sourceDetails
            }
        );
        acceptedClassificationsByPaperId.set(record.paperId, record);
    }
    const processedPaperIds = processedIdsForExport(selection.value, checkpoint.value, acceptedClassificationsByPaperId);
    // 先核对原记录所在的每个页面路径，以及论文、页面编号和页面 SHA 与计划的对应关系，
    // 再处理排除集合，避免排除操作掩盖错误的页面分配。排除论文不进入导出结果。
    const records = filterAndValidatePageRecords(
        validatePageRecordsAgainstPlan(checkpoint.value.supplement.records, planItemsByPaperId),
        acceptedClassificationsByPaperId,
        excludedPaperIds
    );
    const retainedKeys = Object.keys(records),
        replayedKeys = new Set();
    for (const id of processedPaperIds) {
        if (!acceptedClassificationsByPaperId.has(id) || excludedPaperIds.includes(id))
            continue;
        const item = planItemsByPaperId.get(id),
            record = acceptedClassificationsByPaperId.get(id);
        for (const page of item.pages) {
            const loaded = io.readStableFile(path.join(options.blogRoot, page.pagePath), 'original classified frozen page');
            if (/^paper_digest_taxonomy_contract:\s*["']?paper-taxonomy-flat-tags-compat-v1/m.test(
                    loaded.bytes.toString('utf8').split('---', 3)[1] || ''
                )) {
                if (Object.hasOwn(records, page.pagePath))
                    fail("页面已声明正式标签兼容格式，却仍保留在检查点的分类补充记录中。");
                continue;
            }
            const pageRecord = buildPageClassificationRecord(item, page, loaded, record, tagRules);
            if (records[page.pagePath] &&
                runner.stableHash(records[page.pagePath]) !== runner.stableHash(pageRecord))
                fail("重新生成的页面分类记录与检查点中保留的记录内容不一致。");
            records[page.pagePath] = pageRecord;
            replayedKeys.add(page.pagePath);
        }
    }
    if (retainedKeys.some(key => !replayedKeys.has(key)))
        fail("检查点中保留的部分页面记录，未能按原计划中的页面重新生成并核对。");
    const supplement = { contract: writer.CONTRACT, records };
    const report = {
        contract: api.CONTRACT + '-checkpoint-export-report',
        checkpointFileSha256: checkpoint.fileSha256,
        selectionFileSha256: selection.fileSha256,
        selected: selection.value.paperIds.length,
        processed: processedPaperIds.length,
        processedPaperIds,
        acceptedCaches: acceptedClassificationsByPaperId.size,
        rejected: checkpoint.value.failures.length,
        excludedPaperIds: excludedPaperIds,
        exportedPaperCount: new Set(Object.values(records).map(r => r.paperId)).size,
        pageCount: Object.keys(records).length,
        remainingPaperIds: selection.value.paperIds.filter(id => !processedPaperIds.includes(id)),
        failures: checkpoint.value.failures
    };
    return { supplement, report };
}
module.exports = {
    validateExcludedIds,
    validateSelectionPlan,
    validatePageRecordsAgainstPlan,
    validatePageClassificationRecord,
    filterAndValidatePageRecords,
    buildPageClassificationRecord,
    processedIdsForExport,
    normalizeCheckpoint,
    exportCheckpoint
};
