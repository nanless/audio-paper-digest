#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 单独分析一篇论文并合并到结果中
 * 使用 analysis-engine.js 统一封装的分析逻辑
 * 用法: node scripts/analyze-single-paper.js <arxiv_id> [--force]
 */

const fs = require('fs');
const { getBeijingISOString, normalizedId } = require('./utils.js');
const {
    analyzePaperWithRetry,
    readJsonFileStrict,
    updateJsonFileLocked,
    initializeJsonFileLocked,
    mergePapersById,
    mergeCanonicalAnalysisState,
    persistAnalysisCheckpoint,
    isSuccessfulAnalysisRecord,
    getCanonicalAnalysisRunSummary,
    withPaperAnalysisLock
} = require('./analysis-engine.js');
const { loadPapersDatabase, updateAnalysisDigestStatuses } = require('./digest-status.js');
const Config = require('./config.js');

async function analyzeSinglePaper(targetArxivId, options = {}) {
    const forceReanalyze = Boolean(options.force);
    const targetNormalizedId = normalizedId(targetArxivId);
    console.log(`=== 单独分析论文 ${targetArxivId} ===\n`);

    const papersPath = Config.FILES.papers;
    const papersData = loadPapersDatabase(papersPath, Config.FILES.papersLegacy);
    const allPapers = papersData.papers || papersData;

    let targetPaper = null;
    for (const [key, paper] of Object.entries(allPapers)) {
        if (paper && (normalizedId(paper) === targetNormalizedId || normalizedId(key) === targetNormalizedId)) {
            targetPaper = paper;
            break;
        }
    }

    if (!targetPaper) {
        throw new Error(`在 papers.json 中找不到 ${targetArxivId}`);
    }

    console.log(`📄 找到论文: ${targetPaper.title || '(无标题)'}\n`);

    const resultPath = Config.FILES.deepAnalysisResult;
    const legacyResultPath = Config.FILES.deepAnalysisResultLegacy;
    if (!fs.existsSync(resultPath) && fs.existsSync(legacyResultPath)) {
        const legacyData = readJsonFileStrict(legacyResultPath);
        initializeJsonFileLocked(resultPath, Array.isArray(legacyData)
            ? { timestamp: getBeijingISOString(), source: legacyResultPath, papers: legacyData }
            : legacyData);
        console.log(`📦 已将 legacy 分析结果迁移到权威路径: ${resultPath}`);
    }
    const existingData = readJsonFileStrict(resultPath, { allowMissing: true }) || { papers: [], stats: {} };

    const papersList = Array.isArray(existingData) ? existingData : (existingData.papers || []);
    const existingIndex = papersList.findIndex(p => normalizedId(p) === targetNormalizedId);
    if (existingIndex >= 0 && isSuccessfulAnalysisRecord(papersList[existingIndex]) && !forceReanalyze) {
        updateAnalysisDigestStatuses([papersList[existingIndex]], {
            batchDate: String(papersList[existingIndex].fetchedAt || getBeijingISOString()).slice(0, 10)
        });
        console.log('⚠️ 该论文已在分析结果中，跳过（使用 --force 可强制重分析）');
        return { status: 'skipped', exitCode: 0 };
    }
    if (existingIndex >= 0 && forceReanalyze) {
        console.log('♻️ 该论文已存在，将强制重分析并替换旧结果');
    }

    updateJsonFileLocked(resultPath, current => {
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            papers: Array.isArray(current) ? current : (current?.papers || []),
            lastUpdated: getBeijingISOString(),
            status: 'running',
            stats: {
                ...(!Array.isArray(current) ? current?.stats : {}),
                analysisStatus: 'running',
                singleAnalysisStatus: 'running'
            }
        };
        delete payload.deepAnalysisCompletedAt;
        return payload;
    });

    console.log('🔬 开始深度分析...');
    const analysisResult = await withPaperAnalysisLock(targetPaper, async () => {
        const latestData = readJsonFileStrict(resultPath, { allowMissing: true }) || { papers: [] };
        const latestPapers = Array.isArray(latestData) ? latestData : (latestData.papers || []);
        const canonical = latestPapers.find(p => normalizedId(p) === targetNormalizedId);
        if (canonical && isSuccessfulAnalysisRecord(canonical) && !forceReanalyze) {
            console.log('⚠️ 该论文已由其他进程完成，跳过');
            updateJsonFileLocked(resultPath, current => {
                const currentPapers = Array.isArray(current) ? current : (current?.papers || []);
                const canonicalSummary = getCanonicalAnalysisRunSummary(currentPapers);
                const payload = {
                    ...(!Array.isArray(current) && current ? current : {}),
                    papers: currentPapers,
                    status: canonicalSummary.status,
                    lastUpdated: getBeijingISOString(),
                    stats: {
                        ...(!Array.isArray(current) ? current?.stats : {}),
                        analysisStatus: canonicalSummary.status,
                        remainingFailed: canonicalSummary.remaining,
                        singleAnalysisStatus: 'skipped'
                    }
                };
                if (canonicalSummary.status === 'complete') {
                    payload.deepAnalysisCompletedAt = getBeijingISOString();
                } else {
                    delete payload.deepAnalysisCompletedAt;
                }
                return payload;
            });
            return { status: 'skipped', exitCode: 0 };
        }
        // deep-analysis-result.json 是恢复状态的权威来源；papers.json 只补充元数据。
        const paperForAnalysis = canonical
            ? mergeCanonicalAnalysisState(targetPaper, canonical)
            : targetPaper;
        const r = await analyzePaperWithRetry(paperForAnalysis, {
            maxRetries: Config.ANALYSIS_CONFIG.maxRetries,
            retryDelayMs: Config.ANALYSIS_CONFIG.retryDelayMs,
            onCheckpoint: checkpoint => persistAnalysisCheckpoint(resultPath, checkpoint),
            onAttempt: (attempt) => {
                if (attempt > 0) console.log(`    🔄 第 ${attempt + 1} 次尝试...`);
            }
        });
        const attempted = r.result || { ...paperForAnalysis, analysis: null, parsed: null, error: r.error || '分析失败' };
        const payload = updateJsonFileLocked(resultPath, current => {
            const mergedPapers = mergePapersById(
                Array.isArray(current) ? current : (current?.papers || []),
                [attempted],
                { preserveSuccessfulAnalysis: true }
            );
            const canonicalSummary = getCanonicalAnalysisRunSummary(mergedPapers);
            const next = {
                ...(!Array.isArray(current) && current ? current : {}),
                papers: mergedPapers,
                lastUpdated: getBeijingISOString(),
                status: canonicalSummary.status,
                stats: {
                    ...(!Array.isArray(current) ? current?.stats : {}),
                    analysisStatus: canonicalSummary.status,
                    remainingFailed: canonicalSummary.remaining,
                    singleAnalysisStatus: r.success ? 'complete' : 'failed'
                }
            };
            if (canonicalSummary.status === 'complete') {
                next.deepAnalysisCompletedAt = getBeijingISOString();
            } else {
                delete next.deepAnalysisCompletedAt;
            }
            return next;
        });
        const digestStatus = updateAnalysisDigestStatuses([attempted], {
            batchDate: getBeijingISOString().slice(0, 10)
        });
        if (r.success) {
            console.log(`    ✅ 成功！已合并到分析结果中`);
            if (digestStatus.updated > 0) console.log(`    papers.json 状态已同步: ${digestStatus.updated} 篇`);
            console.log(`    📊 当前总数: ${payload.papers.length} 篇`);
            return { status: 'complete', exitCode: 0, result: attempted };
        }
        console.log(`    ❌ 最终失败: ${r.error}`);
        if (digestStatus.updated > 0) console.log(`    papers.json 状态已同步: ${digestStatus.updated} 篇`);
        console.log(`    💾 已保留恢复 checkpoint（当前总数: ${payload.papers.length} 篇）`);
        return { status: 'failed', exitCode: 1, error: r.error, result: attempted };
    });
    return analysisResult;
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const targetArxivId = args.find(arg => !arg.startsWith('--'));
    if (!targetArxivId) {
        console.error('❌ 用法: node scripts/analyze-single-paper.js <arxiv_id> [--force]');
        console.error('   示例: node scripts/analyze-single-paper.js 2604.16044 --force');
        process.exitCode = 1;
    } else {
        analyzeSinglePaper(targetArxivId, { force: args.includes('--force') }).then(result => {
            process.exitCode = result.exitCode;
        }).catch(err => {
            console.error('脚本执行失败:', err);
            process.exitCode = 1;
        });
    }
}

module.exports = { analyzeSinglePaper };
