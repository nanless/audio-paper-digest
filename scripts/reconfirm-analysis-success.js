'use strict';
// 受控“成功复核”：对 Reader 阶段已完整、且当前实现下完整资格仍通过的论文，
// 重新核验后清除此前失败尝试留下的失败标记；资格不通过则拒绝，不改任何状态。
// 用法：node scripts/reconfirm-analysis-success.js <arxivId...> [--dry-run]
const fs = require('node:fs');
const path = require('node:path');
const Config = require('./config');
const daily = require('./lib/daily-fresh-source-plan');
const engine = require('./analysis-engine');
const { normalizedId } = require('./utils');

function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const ids = args.filter(v => !v.startsWith('--')).map(v => String(v).replace(/v\d+$/, ''));
    if (!ids.length) { console.error('用法：node scripts/reconfirm-analysis-success.js <arxivId...> [--dry-run]'); process.exit(1); }
    const file = Config.FILES.deepAnalysisResult;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const plan = daily.requireDailyFreshSourceRecoveryPlan(data, { papers: data.papers, label: 'reconfirm-success' });
    const papers = Array.isArray(data) ? data : data.papers;
    const report = [];
    for (const id of ids) {
        const paper = papers.find(item => normalizedId(item) === id);
        if (!paper) { report.push({ id, skipped: 'paper missing' }); continue; }
        if (paper.analysisManifest?.stages?.apiReaderArticle?.status !== 'complete'
            || typeof paper.analysis !== 'string' || !paper.analysis.trim()) {
            report.push({ id, skipped: 'reader stage incomplete' }); continue;
        }
        let reason = null;
        try {
            reason = daily.withDailyFreshAnalysisContext(plan, () => engine.getInvalidAnalysisReason(paper));
        } catch (error) { reason = `复核异常：${error.message}`; }
        if (reason) { report.push({ id, refused: reason }); continue; }
        if (!dryRun) {
            for (const key of ['latestAnalysisAttemptError', 'latestAnalysisAttemptErrorCode',
                'latestAnalysisAttemptErrorCategory', 'latestAnalysisAttemptErrorStatus',
                'latestAnalysisAttemptErrorScope', 'latestAnalysisAttemptAt', 'error']) delete paper[key];
            paper.status = 'analyzed';
        }
        report.push({ id, reconfirmed: true, clearedFailureMarker: Boolean(paper.latestAnalysisAttemptError || true) });
    }
    if (!dryRun) {
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
        fs.renameSync(temp, file);
    }
    console.log(JSON.stringify({ dryRun, report }, null, 1));
}

if (require.main === module) main();
