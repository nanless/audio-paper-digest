'use strict';

// 只更新或核验标签阶段记录，不重新生成 Reader、评分或图片，也不调用模型。
// 更新前须取得原词表快照，重新判断词表变更，并确认正文标签仍解析为原概念 ID。
// destructive 变更还须属于可确认范围，并带有与本次原因对应的显式确认。
// 更新后的阶段记录必须通过 analysis-contract 核验，才能返回可写入的分析记录。
// 无法继续时返回原有 blocked 结果，并按具体原因标明是否需要人工或模型重新核对。

const registryChange = require('./tag-catalog-change.js');

const RESEAL_MODES = Object.freeze(['reproject', 'annotate']);
const RESEAL_REPORT_CONTRACT = 'paper-taxonomy-reseal-report-v1';
const NEEDS_HUMAN_OUTCOMES = Object.freeze([
    'missing-registry-snapshot',
    'destructive-change',
    'selection-invalid',
    'concept-ids-changed'
]);

function sameIds(left, right) {
    const a = Array.isArray(left) ? left : [];
    const b = Array.isArray(right) ? right : [];
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

function idDiff(before, after) {
    const oldIds = Array.isArray(before) ? before : [];
    const newIds = Array.isArray(after) ? after : [];
    const oldSet = new Set(oldIds);
    const newSet = new Set(newIds);
    return {
        added: newIds.filter(id => !oldSet.has(id)),
        removed: oldIds.filter(id => !newSet.has(id))
    };
}

function parseAnalysisText(text, runtime) {
    // utils.js 与 analysis-contract.js 互相依赖，因此在调用时加载，避免循环加载。
    return require('../utils.js').parseAnalysis(text, { tagRules: runtime });
}

function contract() {
    return require('../analysis-contract.js');
}

function stageResult({ paper, analysisRunId, status, outcome, errors = [], ...extra }) {
    const conceptIds = Array.isArray(extra.conceptIds) ? extra.conceptIds : [];
    const oldConceptIds = Array.isArray(extra.oldConceptIds) ? extra.oldConceptIds : conceptIds;
    const item = {
        paperId: paper?.id ?? null,
        analysisRunId: analysisRunId ?? null,
        status,
        outcome,
        needsHuman: NEEDS_HUMAN_OUTCOMES.includes(outcome),
        registry: {
            from: extra.fromRegistrySha256 ?? null,
            to: extra.toRegistrySha256 ?? null
        },
        changeLevel: extra.changeLevel ?? null,
        oldConceptIds,
        newConceptIds: conceptIds,
        conceptIdsDiff: idDiff(oldConceptIds, conceptIds),
        pageRestageRequired: Boolean(extra.pageRestageRequired),
        errors
    };
    if (extra.reasons?.length) item.reasons = extra.reasons;
    if (extra.errorsDetail?.length) item.errorsDetail = extra.errorsDetail;
    if (extra.destructiveAcknowledgement) item.destructiveAcknowledgement = extra.destructiveAcknowledgement;
    return item;
}

// 为只含一篇论文的分析记录计算标签更新结果，不写入文件。
// acknowledgeDestructive 仅适用于白名单内的破坏性变更；缺少确认或不属于
// 可确认范围时，仍返回 blocked/destructive-change，并标明需要重新核对。
function reprojectAnalysis({ analysis, runtime, mode = 'reproject', snapshotOptions = {},
    acknowledgeDestructive = false, acknowledgementNote = null } = {}) {
    if (!RESEAL_MODES.includes(mode)) throw new Error(`不支持的标签记录更新模式：${mode}`);
    if (!runtime || !runtime.registrySha256) throw new Error('更新标签记录需要提供标签规则及词表哈希。');
    const contractApi = contract();
    const record = analysis && typeof analysis === 'object' ? analysis : null;
    const paper = record?.papers?.length === 1 ? record.papers[0] : null;
    if (!paper) {
        return { ok: false, analysis: null,
            item: { paperId: record?.paperId ?? null, analysisRunId: record?.executionId ?? null,
                status: 'blocked', outcome: 'unreadable-analysis', needsHuman: false,
                registry: { from: null, to: runtime.registrySha256 }, changeLevel: null,
                oldConceptIds: [], newConceptIds: [],
                conceptIdsDiff: { added: [], removed: [] },
                pageRestageRequired: false,
                errors: ['分析记录必须恰好包含一篇论文。'] } };
    }
    const executionId = typeof record.executionId === 'string' ? record.executionId : null;
    const stage = paper.analysisManifest?.stages?.taxonomySeal;
    const base = {
        paper,
        analysisRunId: executionId,
        fromRegistrySha256: typeof stage?.registrySha256 === 'string' ? stage.registrySha256 : null,
        toRegistrySha256: runtime.registrySha256
    };
    if (!contractApi.isRecoveryStageTerminal('taxonomySeal', stage?.status)) {
        return { ok: false, analysis: null,
            item: stageResult({ ...base, status: 'skipped', outcome: 'stage-not-terminal',
                errors: [`标签阶段的状态为 ${stage?.status ?? '缺失'}，尚未完成，不能更新记录。`] }) };
    }
    const oldConceptIds = Array.isArray(stage.conceptIds) ? stage.conceptIds : [];
    const parsed = parseAnalysisText(paper.analysis, runtime);
    let paperRef = paper;
    const validate = () => contractApi.validateTagStageProof(paperRef, {
        parsed, tagRules: runtime, registrySnapshotOptions: snapshotOptions
    });

    // 已使用当前词表时，只核验现有记录，不生成新的写入内容。
    if (stage.registrySha256 === runtime.registrySha256) {
        const issue = validate();
        if (issue) {
            return { ok: false, analysis: null,
                item: stageResult({ ...base, status: 'blocked', outcome: 'binding-refused',
                    oldConceptIds, conceptIds: oldConceptIds,
                    changeLevel: 'none', errors: [issue] }) };
        }
        return { ok: false, analysis: null,
            item: stageResult({ ...base, status: 'assigned', outcome: 'already-current',
                oldConceptIds, conceptIds: parsed.taxonomyValidation?.conceptIds ?? oldConceptIds,
                changeLevel: 'none', errors: [] }) };
    }

    const snapshot = registryChange.resolveRegistrySnapshot(stage.registrySha256, snapshotOptions);
    if (!snapshot) {
        return { ok: false, analysis: null,
            item: stageResult({ ...base, status: 'blocked', outcome: 'missing-registry-snapshot',
                oldConceptIds, conceptIds: oldConceptIds, errors: [
                    `无法取得词表更新前的快照 ${stage.registrySha256}，不能更新标签记录。`] }) };
    }
    const { changeLevel, detail } = registryChange.classifyRegistryChange(snapshot, runtime.tagCatalog);
    if (changeLevel === 'destructive') {
        const eligibility = registryChange.acknowledgementEligibility(detail);
        const baseError = '词表包含破坏性变更，需要重新分析整篇论文，或由人工或模型重新选择标签；本工具不调用模型。';
        if (!eligibility.eligible) {
            return { ok: false, analysis: null,
                item: stageResult({ ...base, status: 'blocked', outcome: 'destructive-change',
                    oldConceptIds, conceptIds: oldConceptIds, changeLevel,
                    reasons: detail.reasons.filter(reason => reason.level === 'destructive')
                        .map(reason => reason.message),
                    errors: [baseError,
                        `--acknowledge-destructive 不适用于本次改动：${eligibility.ineligibleReasons.join('、')} 不属于可人工确认的范围。`] }) };
        }
        if (!acknowledgeDestructive) {
            return { ok: false, analysis: null,
                item: stageResult({ ...base, status: 'blocked', outcome: 'destructive-change',
                    oldConceptIds, conceptIds: oldConceptIds, changeLevel,
                    reasons: detail.reasons.filter(reason => reason.level === 'destructive')
                        .map(reason => reason.message),
                    errors: [baseError,
                        '本次改动属于可人工确认的范围；明确使用 --acknowledge-destructive 后，仍须通过后续标签核验才能更新记录。'] }) };
        }
        // 人工确认有效后，仍须核对正文标签的解析结果和更新后的阶段记录。
    }

    const validation = parsed?.taxonomyValidation;
    if (!validation?.valid) {
        return { ok: false, analysis: null,
            item: stageResult({ ...base, status: 'blocked', outcome: 'selection-invalid',
                oldConceptIds, conceptIds: oldConceptIds, changeLevel,
                errorsDetail: Array.isArray(validation?.errors) ? validation.errors : ['标签无法解析'],
                errors: ['正文标签无法按当前词表解析，需要人工或模型重新选择标签；本工具不会调用模型。'] }) };
    }
    if (!sameIds(validation.conceptIds, oldConceptIds)) {
        return { ok: false, analysis: null,
            item: stageResult({ ...base, status: 'blocked', outcome: 'concept-ids-changed',
                oldConceptIds, conceptIds: validation.conceptIds, changeLevel,
                errors: ['正文标签在当前词表中解析出的概念 ID 与原标签阶段记录不同，需要人工或模型重新核对；本工具不会调用模型。'] }) };
    }

    let annotation;
    try {
        annotation = registryChange.buildRegistryUpgradeAnnotation({
            from: snapshot,
            to: runtime.tagCatalog,
            changeLevel,
            detail,
            note: `确定性重投影：${detail.summary}`,
            acknowledgeDestructive: changeLevel === 'destructive' && acknowledgeDestructive === true,
            acknowledgementNote
        });
    } catch (error) {
        return { ok: false, analysis: null,
            item: stageResult({ ...base, status: 'blocked', outcome: 'annotation-failed',
                oldConceptIds, conceptIds: oldConceptIds, changeLevel,
                errors: [`无法生成词表更新说明：${error.message}`] }) };
    }

    const nextStage = mode === 'reproject'
        ? rebuildStage(stage, runtime, annotation, contractApi)
        : { ...stage, registryUpgradeFrom: annotation };
    const nextPaper = { ...paper, analysisManifest: {
        ...paper.analysisManifest,
        stages: { ...paper.analysisManifest.stages, taxonomySeal: nextStage }
    } };
    // Python 发布端会优先读取已保存的 parsed.taxonomyValidation，因此更新
    // 标签记录时也更新其中的词表版本与 SHA，使它们与当前解析结果一致。
    if (paper.parsed && typeof paper.parsed === 'object' && paper.parsed.taxonomyValidation) {
        nextPaper.parsed = {
            ...paper.parsed,
            taxonomyValidation: {
                ...paper.parsed.taxonomyValidation,
                registryVersion: validation.registryVersion,
                registrySha256: validation.registrySha256
            }
        };
    }
    paperRef = nextPaper;
    const issue = validate();
    if (issue) {
        return { ok: false, analysis: null,
            item: stageResult({ ...base, status: 'blocked', outcome: 'binding-refused',
                oldConceptIds, conceptIds: oldConceptIds, changeLevel,
                errors: [`更新后的标签阶段记录未通过核验，不能写入：${issue}`] }) };
    }
    const nextAnalysis = { ...record, papers: [nextPaper] };
    return {
        ok: true,
        analysis: nextAnalysis,
        stage: nextStage,
        item: stageResult({ ...base,
            status: 'assigned',
            outcome: mode === 'reproject' ? 'resealed' : 'annotated',
            oldConceptIds,
            conceptIds: validation.conceptIds,
            changeLevel,
            pageRestageRequired: true,
            destructiveAcknowledgement: annotation.destructiveAcknowledgement,
            errors: [] })
    };
}

// 只更新阶段记录中的词表与提示文本字段、升级说明和 bindingSha256。正文及原检查点的 SHA
// 保持不变，以便核心摘要和评分阶段继续核验它们对应的正文。
function rebuildStage(stage, runtime, annotation, contractApi) {
    const binding = {
        registryVersion: runtime.registryVersion,
        registrySha256: runtime.registrySha256,
        projectionContract: runtime.projectionContract,
        projectionSha256: runtime.projectionSha256,
        selectionContract: runtime.selectionContract,
        inputAnalysisSha256: stage.inputAnalysisSha256,
        outputAnalysisSha256: stage.outputAnalysisSha256,
        inputProtectedProjectionSha256: stage.inputProtectedProjectionSha256,
        outputProtectedProjectionSha256: stage.outputProtectedProjectionSha256,
        taxonomySurfaceSha256: stage.taxonomySurfaceSha256,
        primaryTaskId: stage.primaryTaskId,
        primaryMethodId: stage.primaryMethodId,
        conceptIds: stage.conceptIds
    };
    return {
        ...stage,
        registryVersion: runtime.registryVersion,
        registrySha256: runtime.registrySha256,
        projectionContract: runtime.projectionContract,
        projectionSha256: runtime.projectionSha256,
        selectionContract: runtime.selectionContract,
        registryUpgradeFrom: annotation,
        bindingSha256: contractApi.manualSha256(binding)
    };
}

function summarizeTagRecordUpdates(report) {
    const items = Array.isArray(report?.items) ? report.items : [];
    const counts = { assigned: 0, blocked: 0, skipped: 0 };
    const outcomes = {};
    for (const item of items) {
        counts[item.status] = (counts[item.status] || 0) + 1;
        outcomes[item.outcome] = (outcomes[item.outcome] || 0) + 1;
    }
    return {
        total: items.length,
        assigned: counts.assigned,
        blocked: counts.blocked,
        skipped: counts.skipped,
        needsHuman: items.filter(item => item.needsHuman).length,
        outcomes
    };
}

// 列出 historical-taxonomy-assignments 中词表 SHA 与当前值不同的分类文件。
// 此函数只读取文件，不删除、改名或改写原记录。
function scanStaleAssignments({ root, currentRegistrySha256, readDir, readJson }) {
    const fs = require('node:fs');
    const path = require('node:path');
    const listDir = readDir || (target => fs.readdirSync(target, { withFileTypes: true }));
    const load = readJson || (file => JSON.parse(fs.readFileSync(file, 'utf8')));
    const entries = [];
    let directories = [];
    try {
        directories = listDir(root).filter(entry => typeof entry === 'object' && entry.isDirectory?.())
            .map(entry => entry.name).sort();
    } catch (error) {
        if (error.code === 'ENOENT') return { root, currentRegistrySha256, directories: [], entries: [], stale: 0, current: 0, unreadable: 0 };
        throw error;
    }
    let stale = 0;
    let current = 0;
    let unreadable = 0;
    for (const directory of directories) {
        let files = [];
        try {
            files = listDir(path.join(root, directory))
                .filter(entry => typeof entry === 'object' && entry.isFile?.())
                .map(entry => entry.name).filter(name => name.endsWith('.json')).sort();
        } catch {
            unreadable += 1;
            entries.push({ directory, file: null, registrySha256: null,
                stale: null, reason: '目录不可读' });
            continue;
        }
        for (const file of files) {
            const match = file.match(/\.taxonomy\.([a-f0-9]{64})(?:\.[a-f0-9]+)?\.json$/);
            let sha = match ? match[1] : null;
            let paperId = null;
            let reason = null;
            if (!sha) {
                try {
                    const value = load(path.join(root, directory, file));
                    sha = typeof value.registrySha256 === 'string' ? value.registrySha256 : null;
                    paperId = typeof value.paperId === 'string' ? value.paperId : null;
                } catch (error) {
                    reason = `无法解析文件：${error.message}`;
                }
            }
            const isStale = sha ? sha !== currentRegistrySha256 : null;
            if (reason) unreadable += 1;
            else if (isStale === true) stale += 1;
            else if (isStale === false) current += 1;
            else unreadable += 1;
            entries.push({ directory, file, paperId, registrySha256: sha,
                stale: isStale, reason: reason || (isStale === null ? '文件未记录词表 SHA（registrySha256）。' : null) });
        }
    }
    return { root, currentRegistrySha256, directories, entries, stale, current, unreadable };
}

module.exports = {
    RESEAL_MODES,
    RESEAL_REPORT_CONTRACT,
    NEEDS_HUMAN_OUTCOMES,
    reprojectAnalysis,
    rebuildStage,
    summarizeTagRecordUpdates,
    scanStaleAssignments,
    idDiff
};
