'use strict';
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const CONTRACT = 'reader-table-semantic-audit-v1';

// 仅撤销阶段的明确失败可复用原完整结果；原错误由正常引擎成功收尾清除。
function reusableCancelledReaderAuditResult(paper) {
    if (paper?.latestAnalysisAttemptErrorCode !== 'READER_TABLE_AUDIT_REJECTED') return null;
    const engine = require('../analysis-engine');
    if (engine.getIncompleteAnalysisContentReason(paper) !== null) return null;
    const stage = paper.analysisManifest?.stages?.apiReaderTableAudit;
    const reject = () => {
        const error = new Error('已取消审校的原请求、来源或费用记录不一致，保留原失败');
        Object.assign(error, { code: 'CANCELLED_READER_AUDIT_RECOVERY_REJECTED', retryable: false });
        throw error;
    };
    if (paper.error || !paper.latestAnalysisAttemptError || stage?.contract !== CONTRACT
        || !['transient_failure', 'invalid_output', 'contract_rejected'].includes(stage.status)
        || stage.articleSha256 !== paper.apiReaderArticleSha256 || stage.sourceSha256 !== paper.sourceSha256) reject();
    const record = stage.records?.find(item => item.inputSha256 === stage.inputSha256);
    if (!record || record.articleSha256 !== paper.apiReaderArticleSha256
        || !/^[a-f0-9]{64}$/.test(record.inputSha256 || '')
        || !/^[a-f0-9]{64}$/.test(record.requestSha256 || '')) reject();
    const receipts = (record.requestReceipts || []).filter(event => event.kind === 'request'
        && event.paperId === String(paper.arxivId).replace(/v\d+$/, '')
        && event.stage === 'apiReaderTableAudit' && event.unitId === record.inputSha256
        && event.model === stage.configuration?.model);
    if (record.rawResponse !== undefined) {
        if (typeof record.rawResponse !== 'string' || sha(record.rawResponse) !== record.responseSha256
            || !receipts.some(event => event.outcome === 'completed' && event.outputTextSha256 === record.responseSha256)) reject();
    } else if (!receipts.some(event => event.outcome !== 'completed') || !(record.transportFailures > 0)) reject();
    const facts = require('./daily-fact-review');
    for (const name of ['primaryAnalysis', 'coreSummaryRepair', 'scoringAudit', 'apiReaderArticle']) {
        const saved = paper.analysisManifest.stages[name];
        const current = facts.fingerprintFields(name, saved);
        for (const field of ['factReview', 'scoringFactReview']) if (!isDeepStrictEqual(saved?.[field], current[field])) return null;
    }
    const fresh = require('./fresh-analysis-context');
    const context = fresh.getFreshAnalysisContext();
    if (!context) reject();
    fresh.assertFreshPaper(paper);
    const source = fresh.readFreshSource(context.runDir, paper, context);
    if (!source || sha(source.text) !== paper.sourceSha256
        || sha(source.text) !== paper.analysisManifest.sourceAcquisition?.sourceSha256) reject();
    return paper;
}
module.exports = { reusableCancelledReaderAuditResult };
