'use strict';
// 日为已封存 Reader 准备“按篇正文重做”：写 readerRevisionHistory 并清掉 Reader
// 阶段与产物，保留分析、评分、标签、核心与全部历史；不发模型请求、不改来源。
// 用法：node scripts/prepare-reader-revision.js <arxivId...> [--dry-run]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Config = require('./config');
const { normalizedId } = require('./utils');
const daily = require('./lib/daily-fresh-source-plan');

function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const ids = args.filter(value => !value.startsWith('--')).map(value => String(value).replace(/v\d+$/, ''));
    if (!ids.length || ids.some(id => !/^\d{4}\.\d{4,5}$/.test(id))) {
        console.error('用法：node scripts/prepare-reader-revision.js <arxivId...> [--dry-run]');
        process.exit(1);
    }
    const DATA = Config.FILES.deepAnalysisResult;
    const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    const plan = daily.requireDailyFreshSourceRecoveryPlan(data, { papers: data.papers, label: 'reader-revision-prepare' });
    const payload = daily.withDailyFreshAnalysisContext(plan, () => data);
    const papers = Array.isArray(payload) ? payload : payload.papers;
    const report = [];
    for (const id of ids) {
        const paper = papers.find(item => normalizedId(item) === id);
        if (!paper) { report.push({ id, skipped: 'paper missing' }); continue; }
        const stage = paper.analysisManifest?.stages?.apiReaderArticle;
        let proof = stage?.ordinalCompletionProof;
        if (!proof?.path || !proof?.sha256) {
            // 阶段曾被不受支持的重跑清掉时，仍以该篇最新的封存完成文件作为历史指针；
            // 它必须真实存在且字节自洽，才允许按正文重做恢复。
            const completionDir = path.join(plan.readerAttemptsDir, 'ordinal-completions');
            const files = fs.existsSync(completionDir)
                ? fs.readdirSync(completionDir).filter(name => name.startsWith(`${id}-`)).sort() : [];
            if (!files.length) {
                const stageNow = paper.analysisManifest?.stages?.apiReaderArticle;
                if (stageNow && stageNow.status === 'complete') {
                    // 没有完成文件的普通已签稿也可重做：登记历史、清阶段，不写完成指针。
                    if (!dryRun) {
                        paper.readerRevisionHistory = {
                            contract: 'daily-reader-revision-history-v1', reason: 'explicit-reader-revision',
                            completionProof: null, previousArticleSha256: stageNow.articleSha256 || null,
                            previousPlanSha256: stageNow.planSha256 || null, recordedAt: new Date().toISOString()
                        };
                        delete paper.analysisManifest.stages.apiReaderArticle;
                        delete paper.analysisManifest.contracts.apiReaderArticle;
                        delete paper.analysisManifest.contracts.readerTargetOrdinalPatch;
                        if (paper.analysisStageCheckpoints) delete paper.analysisStageCheckpoints.apiReaderArticle;
                        for (const key of ['apiReaderArticle', 'apiReaderPlan', 'apiReaderArticleSha256', 'apiReaderPlanSha256']) delete paper[key];
                    }
                    report.push({ id, prepared: true, completion: null });
                    continue;
                }
                report.push({ id, skipped: 'no ordinal completion' });
                continue;
            }
            const file = path.join(completionDir, files.at(-1));
            proof = { path: file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
        }
        const completionBytes = fs.readFileSync(path.resolve(proof.path));
        if (crypto.createHash('sha256').update(completionBytes).digest('hex') !== proof.sha256) {
            report.push({ id, skipped: 'completion bytes differ' }); continue;
        }
        const sealed = JSON.parse(completionBytes.toString('utf8'));
        const articleSha = crypto.createHash('sha256').update(String(paper.apiReaderArticle || '')).digest('hex');
        if (paper.apiReaderArticle && sealed.articleSha256 !== articleSha) { report.push({ id, skipped: 'article differs from sealed completion' }); continue; }
        const history = {
            contract: 'daily-reader-revision-history-v1',
            reason: 'explicit-reader-revision',
            completionProof: { path: proof.path, sha256: proof.sha256 },
            previousArticleSha256: sealed.articleSha256,
            previousPlanSha256: sealed.planSha256,
            previousOrdinalPatchCompilations: structuredClone(stage?.ordinalPatchCompilations || []),
            recordedAt: new Date().toISOString()
        };
        if (!dryRun) {
            // 旧失败候选的次数属于旧窗口：重做前按既有 API 退休它，新稿从零计数，
            // 旧候选、旧次数与旧费用原字节保留。
            const repair = require('./lib/reader-repair');
            let retired = false;
            for (const name of fs.readdirSync(plan.readerAttemptsDir).filter(item => /^[a-f0-9]{64}\.json$/.test(item))) {
                const candidateFile = path.join(plan.readerAttemptsDir, name);
                let envelope;
                try { envelope = JSON.parse(fs.readFileSync(candidateFile, 'utf8')); } catch (_) { continue; }
                if (normalizedId(envelope.identity?.paperId) !== id) continue;
                retired = repair.retireFailedCandidate(plan.readerAttemptsDir, envelope.identity) || retired;
            }
            if (retired) history.retiredFailedCandidate = true;
            paper.readerRevisionHistory = history;
            const manifest = paper.analysisManifest;
            if (manifest?.stages) { delete manifest.stages.apiReaderArticle; delete manifest.stages.imageSupplement; }
            if (manifest?.contracts) {
                delete manifest.contracts.apiReaderArticle;
                delete manifest.contracts.imageNarrative;
                delete manifest.contracts.readerTargetOrdinalPatch;
            }
            if (paper.analysisStageCheckpoints) { delete paper.analysisStageCheckpoints.apiReaderArticle; delete paper.analysisStageCheckpoints.imageSupplement; }
            // 只清正文与写作计划；资源身份、作者与图片仍属于本次封存来源，保留可复用，
            // 否则重做时会被资源身份核验拒绝。
            for (const key of ['apiReaderArticle', 'apiReaderPlan',
                'apiReaderArticleSha256', 'apiReaderPlanSha256']) delete paper[key];
        }
        report.push({ id, prepared: true, completion: proof.sha256, article: articleSha });
    }
    if (!dryRun) {
        const temp = `${DATA}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
        fs.renameSync(temp, DATA);
    }
    console.log(JSON.stringify({ dryRun, report }, null, 1));

}

if (require.main === module) main();
