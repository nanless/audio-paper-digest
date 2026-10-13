'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const CONTRACT = 'reader-table-semantic-audit-v1';
const STAGE = 'apiReaderTableAudit';
const PENDING_REASON = '读者文章的表格事实审校尚未通过。';
const PROMPT = 'prompts/api-reader-table-audit-v1.md';
const MAX_VERSIONS = 6;
const repairScope = new (require('node:async_hooks').AsyncLocalStorage)();
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const stable = value => sha(JSON.stringify(value));
function fail(message, code = 'READER_TABLE_AUDIT_REJECTED', issues = []) {
    const error = new Error(message);
    Object.assign(error, { code, category: 'content', retryable: false, readerIssues: issues });
    throw error;
}
function exactKeys(value, names) {
    return value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).sort().join(',') === [...names].sort().join(',');
}
function requiresAudit(paper) {
    const provenance = paper?.freshRewriteProvenance;
    if (provenance?.contract !== 'fresh-source-analysis-v1' || !provenance.sourceManifestSha256) return false;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(provenance.runId || '')) return true;
    // 历史直改使用另一套来源格式；不能只因存在清单SHA就当成日更来源。
    // 已登记的日更或fresh运行始终要求审校，夹带历史字段也不能豁免。
    const Config = require('../config');
    if ([Config.FILES.dailyFreshSourceRunsDir, Config.FILES.freshRewriteRunsDir]
        .filter(Boolean).some(root => fs.existsSync(path.join(root, provenance.runId, 'run.json')))) return true;
    const id = require('../utils').normalizedId(paper);
    return paper.directPaperId !== `arxiv:${id}` || !/^\d{4}\.\d{4,5}$/.test(id);
}
function sourceForPaper(paper) {
    const Config = require('../config');
    const provenance = paper.freshRewriteProvenance;
    if (!provenance || !/^[a-f0-9]{64}$/.test(provenance.sourceManifestSha256 || '') || !isDeepStrictEqual(provenance, paper.analysisManifest?.freshRewriteProvenance)) fail('表格审校缺少一致的封存来源记录');
    const directories = [...new Set([Config.FILES.dailyFreshSourceRunsDir, Config.FILES.freshRewriteRunsDir].filter(Boolean))]
        .map(root => path.join(root, provenance.runId))
        .filter(directory => fs.existsSync(path.join(directory, 'run.json')));
    if (directories.length !== 1) fail('表格审校来源运行缺失或存在歧义');
    const runDir = directories[0];
    const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    const source = require('./fresh-analysis-context').readFreshSource(runDir, paper, { runId: provenance.runId, sourceExpectations: run.sourceExpectations });
    if (!source || source.freshSourceDescriptor?.contract !== 'fresh-source-bundle-v2' || sha(source.text) !== paper.sourceSha256 || sha(source.text) !== provenance.sourceSha256
        || source.structuredArtifacts?.payloadSha256 !== provenance.structuredArtifactsSha256
        || source.freshSourceDescriptor?.sourceManifestSha256 !== provenance.sourceManifestSha256) fail('表格审校的当前四份封存来源不一致');
    return source;
}
function configuration(routing = { model: process.env.PAPER_ANALYZER_MODEL, endpoint: process.env.PAPER_ANALYZER_ENDPOINT }) {
    const c = require('../config').ANALYSIS_CONFIG;
    const maxTokens = c.apiReaderTableAuditMaxTokens || 12000;
    if (!routing.model || !routing.endpoint) fail('表格审校缺少当前模型与请求地址');
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) fail('表格审校输出预算须为正整数');
    return { model: routing.model, endpoint: routing.endpoint,
        responsesStream: process.env.PD_OPENAI_RESPONSES_STREAM === '1',
        responsesReasoningEffort: process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT || '', maxTokens, contextMaxChars: c.apiReaderContextMaxChars || 240000, temperature: 0.1, maxRetries: 2,
        promptSha256: sha(fs.readFileSync(path.resolve(__dirname, '../..', PROMPT))),
        implementationSha256: sha(fs.readFileSync(__filename)), maxVersions: MAX_VERSIONS };
}
function buildContext(paper, source, config = configuration(), savedConstraints) {
    if (typeof paper.apiReaderArticle !== 'string' || sha(paper.apiReaderArticle) !== paper.apiReaderArticleSha256) fail('表格审校的正文SHA不一致');
    if (sha(source.text) !== paper.sourceSha256) fail('表格审校的原文SHA不一致');
    if (paper.freshRewriteProvenance && source.structuredArtifacts?.payloadSha256 !== paper.freshRewriteProvenance.structuredArtifactsSha256) fail('表格审校的结构化来源SHA不一致');
    const tables = require('../analysis-contract').extractMarkdownTables(paper.apiReaderArticle);
    const bindings = paper.apiReaderPlan?.tableBindings;
    if (!Array.isArray(bindings) || tables.length !== bindings.length) fail('表格审校的正文与表来源数量不同');
    const rows = tables.map((table, index) => {
        const binding = bindings[index];
        const original = source.structuredArtifacts?.tables?.find(t => t.ordinal === binding.sourceTableOrdinal);
        const quotes = (binding.sourceQuotes || []).map(item => {
            if (typeof item === 'string') return item;
            if (item && typeof item.quote === 'string' && item.sourceQuoteSha256 === sha(item.quote)) return item.quote;
            fail('表格审校来源引文及其SHA不一致');
        });
        if (quotes.some(quote => typeof quote !== 'string' || !source.text.includes(quote))) fail('表格审校不能豁免非逐字来源引文');
        return { tableIndex: index + 1, header: table.header, rows: table.rows,
            cellBindings: (binding.cellBindings || []).map(cell => [cell.renderedRow, cell.renderedColumn, cell.sourceRow, cell.sourceColumn]),
            verifiedPdfCellConfirmation: binding.pdfCellConfirmation || null,
            source: original ? { ordinal: original.ordinal, caption: original.caption, matrix: original.matrix, headerRows: original.headerRows, cells: original.cells } : { quotes } };
    });
    const facts = require('./daily-fact-review');
    const active = facts.current(paper.arxivId);
    let liveConstraints;
    if (active?.scoringOnly) {
        const parent = active.primaryBound;
        const readerProof = paper.analysisManifest?.stages?.apiReaderArticle?.factReview;
        if (readerProof && !isDeepStrictEqual(readerProof, parent?.proof)) fail('评分单独范围缺少原读者文章的事实约束');
        liveConstraints = parent?.feedback.readerFeedback?.trim()
            ? `${parent.feedback.readerFeedback}\n以下逐字引文已对封存原文核验，仅用作纠错证据：\n${parent.feedback.sourceQuotes.join('\n')}` : '';
    } else liveConstraints = facts.reviewFeedback('apiReaderArticle', paper.arxivId) || '';
    const constraints = savedConstraints === undefined ? liveConstraints : savedConstraints;
    if (typeof constraints !== 'string' || (liveConstraints && constraints !== liveConstraints)) fail('表格审校事实约束与当前已核验反馈不同');
    const content = { contract: CONTRACT, paperId: String(paper.arxivId).replace(/v\d+$/, ''),
        articleSha256: sha(paper.apiReaderArticle), sourceSha256: sha(source.text),
        sealedSourceIdentity: paper.freshRewriteProvenance || null,
        structuredArtifactsSha256: source.structuredArtifacts?.payloadSha256 || '',
        tableBindingsSha256: stable(bindings), resourceIdentitySha256: paper.apiReaderResources?.identitySha256 || '', readerFactReviewSha256: stable(paper.analysisManifest?.stages?.apiReaderArticle?.factReview || null), configuration: config,
        article: paper.apiReaderArticle, tables: rows, verifiedConstraints: constraints, sourceText: source.text };
    const inputSha256 = stable(content);
    const prompt = require('../utils').loadPrompt(PROMPT, { auditInput: JSON.stringify({ inputSha256, ...content }) });
    if (prompt.length > config.contextMaxChars) fail('表格独立审校上下文超过当前字符预算，未发送请求');
    return { inputSha256, content, prompt, promptSha256: sha(prompt), config };
}
function compileResponse(raw, context) {
    let value;
    try { value = typeof raw === 'string' ? JSON.parse(raw.trim()) : raw; } catch { fail('表格审校响应不是完整JSON'); }
    if (!exactKeys(value, ['version', 'inputSha256', 'tables']) || value.version !== 1
        || value.inputSha256 !== context.inputSha256 || !Array.isArray(value.tables)
        || value.tables.length !== context.content.tables.length) fail('表格审校响应与当前正文输入不对应');
    const seen = new Set(), issues = [];
    for (const table of value.tables) {
        if (!exactKeys(table, ['tableIndex', 'issues']) || !Number.isInteger(table.tableIndex)
            || table.tableIndex < 1 || table.tableIndex > value.tables.length || seen.has(table.tableIndex)
            || !Array.isArray(table.issues) || table.issues.length > 10) fail('表格审校遗漏、重复或越界表格');
        seen.add(table.tableIndex);
        for (const item of table.issues) {
            if (!exactKeys(item, ['statementQuote', 'sourceQuote', 'message', 'correction'])
                || Object.values(item).some(text => typeof text !== 'string' || !text.trim() || text.length > 6000)
                || !context.content.article.includes(item.statementQuote)
                || !context.content.sourceText.includes(item.sourceQuote)) fail('表格审校问题缺少当前正文和来源逐字依据');
            issues.push({ code: 'reader_table_semantics', path: `/tableBindings/${table.tableIndex - 1}`,
                bindingPath: `/tableBindings/${table.tableIndex - 1}`, tableIndex: table.tableIndex,
                message: `第${table.tableIndex}张表及对应解释的事实归属错误：${item.message}。原句：${item.statementQuote}。原文：${item.sourceQuote}。修法：${item.correction}`,
                statementQuote: item.statementQuote, sourceQuote: item.sourceQuote });
        }
    }
    return { value, issues };
}
function hasCompletedReceipt(record, context) {
    return Array.isArray(record.requestReceipts) && record.requestReceipts.some(event =>
        event.kind === 'request' && event.outcome === 'completed'
        && event.paperId === context.content.paperId && event.stage === STAGE
        && event.unitId === context.inputSha256 && event.model === context.config.model
        && event.outputTextSha256 === record.responseSha256);
}
function currentProof(paper, source) {
    const stage = paper.analysisManifest?.stages?.[STAGE];
    if (!stage || stage.status !== 'complete' || stage.contract !== CONTRACT) return false;
    const declared = stage.configuration;
    if (!exactKeys(declared, ['model', 'endpoint', 'responsesStream', 'responsesReasoningEffort', 'maxTokens',
        'contextMaxChars', 'temperature', 'maxRetries', 'promptSha256', 'implementationSha256', 'maxVersions'])) return false;
    if (!declared || typeof declared.model !== 'string' || !declared.model
        || typeof declared.endpoint !== 'string' || !declared.endpoint
        || !Number.isSafeInteger(declared.contextMaxChars) || declared.contextMaxChars < 1
        || typeof declared.responsesStream !== 'boolean' || typeof declared.responsesReasoningEffort !== 'string'
        || declared.implementationSha256 !== sha(fs.readFileSync(__filename))
        || !Number.isSafeInteger(declared.maxTokens) || declared.maxTokens < 1
        || declared.promptSha256 !== sha(fs.readFileSync(path.resolve(__dirname, '../..', PROMPT)))
        || !/^[a-f0-9]{64}$/.test(declared.implementationSha256 || '')
        || declared.maxVersions !== MAX_VERSIONS || declared.maxRetries !== 2 || declared.temperature !== 0.1) return false;
    let context;
    try { context = buildContext(paper, source, declared, stage.verifiedConstraints); }
    catch { return false; }
    const record = stage.records?.find(r => r.inputSha256 === context.inputSha256);
    if (!record || record.responseSha256 !== sha(record.rawResponse)
        || record.requestSha256 !== context.promptSha256 || record.status !== 'complete'
        || !hasCompletedReceipt(record, context)) return false;
    try { return compileResponse(record.rawResponse, context).issues.length === 0; } catch { return false; }
}
function hasValidProof(paper) {
    try { return currentProof(paper, sourceForPaper(paper)); } catch { return false; }
}
function repairIssues(paper, sourceText) {
    const active = repairScope.getStore();
    return active && active.articleSha256 === paper.apiReaderArticleSha256
        && active.sourceSha256 === sha(sourceText) && active.paperId === paper.arxivId
        ? active.issues : null;
}
function issuesForDraft(draft, issues) {
    return issues.flatMap(issue => {
        const paths = [];
        (draft.sections || []).forEach((section, index) => {
            if (typeof section.body === 'string' && section.body.includes(issue.statementQuote)) paths.push(`/sections/${index}/body`);
        });
        (draft.conceptBridges || []).forEach((bridge, index) => {
            if (typeof bridge.explanation === 'string' && bridge.explanation.includes(issue.statementQuote)) paths.push(`/conceptBridges/${index}/explanation`);
        });
        return paths.length ? paths.map(path => ({ ...issue, path })) : [issue];
    });
}
function repairInProgress(paperId) { return repairScope.getStore()?.paperId === paperId; }
function originalRepairConstraints(paperId) {
    const active = repairScope.getStore();
    return active?.paperId === paperId ? active.verifiedConstraints : '';
}
function originalRepairFactReview(paperId) {
    const active = repairScope.getStore();
    return active?.paperId === paperId ? structuredClone(active.factReview) : undefined;
}
function canAuditSavedReader(paper) {
    return !paper?.latestAnalysisAttemptError && paper?.digestStatus?.latestAttemptStatus !== 'analysis_failed'
        && require('../analysis-engine').getIncompleteAnalysisContentReason(paper) === PENDING_REASON;
}
function factInputsUnchanged(paper) {
    const facts = require('./daily-fact-review');
    const stages = paper.analysisManifest?.stages || {};
    const active = facts.current(paper.arxivId);
    if (!active && Object.values(stages).some(stage => stage?.factReview || stage?.scoringFactReview)) return false;
    for (const name of ['primaryAnalysis', 'openSourceScan', 'revision', 'tableRepair', 'methodRepair',
        'structureRepair', 'coreSummaryRepair', 'tagSelection', 'scoringAudit', 'apiReaderArticle']) {
        const stage = stages[name] || {};
        const current = facts.fingerprintFields(name, stage);
        for (const key of ['factReview', 'scoringFactReview']) {
            if (!isDeepStrictEqual(stage[key], current[key])) return false;
        }
    }
    return true;
}
async function run(paper, source, options) {
    if (typeof options.assertHardBindings !== 'function' || typeof options.callModel !== 'function'
        || typeof options.save !== 'function') fail('表格审校必须通过正常来源核验、公共模型请求和检查点保存');
    let working = paper;
    for (;;) {
        options.assertHardBindings(working);
        if (currentProof(working, source)) return working;
        const context = buildContext(working, source, configuration(options.modelConfiguration));
        const old = working.analysisManifest.stages[STAGE];
        const records = structuredClone(old?.contract === CONTRACT ? old.records || [] : []);
        let record = records.find(r => r.inputSha256 === context.inputSha256);
        if (!record) {
            if (records.length >= MAX_VERSIONS) fail('表格审校已达到6个正文版本，原记录和费用保留');
            record = { inputSha256: context.inputSha256, articleSha256: context.content.articleSha256,
                requestSha256: context.promptSha256, status: 'running', transportFailures: 0 };
            records.push(record);
        }
        const setStage = status => {
            working.analysisManifest.stages[STAGE] = { contract: CONTRACT, status,
                articleSha256: context.content.articleSha256, inputSha256: context.inputSha256,
                sourceSha256: context.content.sourceSha256, configuration: context.config,
                verifiedConstraints: context.content.verifiedConstraints,
                records, attempts: records.filter(r => r.rawResponse !== undefined).length,
                updatedAt: new Date().toISOString() };
        };
        if (record.rawResponse === undefined) {
            if (record.transportFailures >= 2) fail('表格审校网络失败达到上限，保留原记录');
            setStage('running'); await options.save(working);
            try {
                record.rawResponse = await options.callModel([{ role: 'user', content: context.prompt }], context.config.maxTokens, {
                    temperature: 0.1, maxRetries: 2,
                    usageContext: { paperId: context.content.paperId, stage: STAGE, unitId: context.inputSha256, contentAttempt: records.length },
                    usageSink: event => {
                        require('./llm-usage').writeLlmUsageEvent(event);
                        (record.requestReceipts ||= []).push(structuredClone(event));
                        if (event.outcome !== 'completed') record.transportFailures += 1;
                    }
                });
                record.responseSha256 = sha(record.rawResponse);
                if (!hasCompletedReceipt(record, context)) fail('表格审校缺少与真实响应对应的请求回执');
                record.status = 'received'; setStage('running'); await options.save(working);
            } catch (error) {
                record.error = String(error.message || error);
                setStage('transient_failure'); await options.save(working); throw error;
            }
        } else if (record.responseSha256 !== sha(record.rawResponse) || record.requestSha256 !== context.promptSha256 || !hasCompletedReceipt(record, context)) fail('表格审校原始付费响应或请求SHA发生变化');
        let result;
        try { result = compileResponse(record.rawResponse, context); } catch (error) {
            record.status = 'invalid_output'; setStage('invalid_output'); await options.save(working); throw error;
        }
        record.status = result.issues.length ? 'contract_rejected' : 'complete';
        setStage(record.status); await options.save(working);
        if (!result.issues.length) return working;
        if (typeof options.repair !== 'function') fail('表格事实审校发现错误，原正文保留等待正常局部修复', 'READER_TABLE_SEMANTIC_REJECTED', result.issues);
        const before = sha(working.apiReaderArticle);
        working = await repairScope.run(Object.freeze({ paperId: working.arxivId,
            articleSha256: before, sourceSha256: working.sourceSha256,
            issues: structuredClone(result.issues), verifiedConstraints: context.content.verifiedConstraints,
            factReview: working.analysisManifest.stages.apiReaderArticle.factReview }), () => options.repair(working, result.issues));
        if (sha(working.apiReaderArticle) === before) fail('表格局部修复未改变错误正文，原费用和审校记录保留', 'READER_PATCH_NO_PROGRESS', result.issues);
        if (sha(source.text) !== working.sourceSha256) fail('表格局部修复改变了来源身份');
        working.analysisManifest.stages[STAGE] = { ...working.analysisManifest.stages[STAGE], contract: CONTRACT, records };
    }
}
module.exports = { CONTRACT, STAGE, PROMPT, PENDING_REASON, requiresAudit, canAuditSavedReader, factInputsUnchanged, buildContext, compileResponse, currentProof, hasValidProof, run, sourceForPaper, repairIssues, repairInProgress, originalRepairConstraints, originalRepairFactReview, issuesForDraft };
