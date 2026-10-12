'use strict';
const { isSuccessfulAnalysisRecord } = require('../analysis-engine');
const dailyFreshSources = require('./daily-fresh-source-plan');
const factReview = require('./daily-fact-review');
function hasCompletedBoundFactFeedback(paper, feedback, plan) {
    if (!paper || !feedback || !isSuccessfulAnalysisRecord(paper)
        || !dailyFreshSources.isPaperReusableForAnalysis(paper, plan)) return false;
    // 来源或反馈绑定失败仍必须阻断；不把这类失败转换为可跳过的结果。
    const bound = factReview.validateFeedback(feedback, plan, paper);
    return factReview.withFactReview(bound, () => {
        const stages = paper.analysisManifest?.stages || {};
        const primaryActive = Boolean(String(feedback.primaryFeedback || '').trim());
        const required = [
            ['primaryAnalysis', primaryActive, paper.analysis],
            ['coreSummaryRepair', Boolean(feedback.coreFeedback.trim()), require('../analysis-contract').extractSection(paper.analysis, '核心摘要')],
            ['tagSelection', Boolean(String(feedback.tagFeedback || '').trim()), paper.analysis],
            ['apiReaderArticle', Boolean(feedback.readerFeedback.trim() || primaryActive), paper.apiReaderArticle],
            ['scoringAudit', Boolean(String(feedback.scoringFeedback || '').trim() || primaryActive),
                String(paper.analysis || '') + '\n' + JSON.stringify(stages.scoringAudit?.audit || {})]
        ];
        try {
            for (const [stageName, active, text] of required) {
                if (!active) continue;
                const stage = stages[stageName];
                if (stage?.status !== 'complete') return false;
                const expected = factReview.fingerprintFields(stageName, stage);
                if (!Object.keys(expected).length || Object.entries(expected).some(([field, value]) =>
                    !require('node:util').isDeepStrictEqual(stage[field], value))) return false;
                factReview.validateRepairedClaims(stageName, text || '', feedback.paperId);
                if (stageName === 'apiReaderArticle') {
                    const raw = String(feedback.readerFeedback || feedback.primaryFeedback || '').trim();
                    const rendered = factReview.reviewFeedback(stageName, feedback.paperId).trim();
                    if (![factReview.sha(raw), factReview.sha(rendered)].includes(stage.reviewFeedbackSha256)) return false;
                }
            }
            return true;
        } catch (_) {
            // 旧或未知证明、仍含错误原句的成功记录仍走正常纠错流程。
            return false;
        }
    });
}

module.exports = { hasCompletedBoundFactFeedback };
