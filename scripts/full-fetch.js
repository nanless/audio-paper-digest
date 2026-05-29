#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 完整论文抓取 + 深度分析（arxiv + HuggingFace Papers）
 */

const fs = require('fs');
const path = require('path');
const { fetchCategoryPapers, deduplicatePapers, filterPapersWithLLM, loadPapers, savePapers } = require('./fetch-papers.js');
const { fetchHuggingFacePapers, mergeAndDeduplicate } = require('./fetch-huggingface-papers.js');
const { writeFileAtomic, getBeijingISOString, getBeijingCompactTimestamp, getBeijingDateString, readJsonSafe, getRecordDate, normalizedId, backupPapersJson, loadPublishedIdsFromBlog } = require('./utils.js');
const { analyzeBatch, mergeAndSaveResults } = require('./analysis-engine.js');

const Config = require('./config.js');

// 从配置中解构常用参数
const ANALYSIS_CONCURRENCY = Config.ANALYSIS_CONFIG.concurrency;
const ANALYSIS_RETRY_MAX = Config.ANALYSIS_CONFIG.maxRetries;
const ANALYSIS_RETRY_DELAY_MS = Config.ANALYSIS_CONFIG.retryDelayMs;
const FETCH_DELAY_MS = Config.ARXIV_CONFIG.categoryDelayMs;

const ARCHIVE_DIR = Config.ARCHIVE_DIR;
const RESULT_FILE = Config.FILES.deepAnalysisResult;
const LEGACY_RESULT_FILE = Config.FILES.deepAnalysisResultLegacy;
const FILTERED_FILE = Config.FILES.filteredPapers;
const PAPERS_FILE = Config.FILES.papers;
const ANALYZED_FILE = Config.FILES.analyzed;

function autoArchiveCurrentData() {
    const today = getBeijingDateString();
    const targets = [RESULT_FILE, FILTERED_FILE, ANALYZED_FILE];
    let archived = 0;
    let removed = 0;

    for (const filePath of targets) {
        if (!fs.existsSync(filePath)) continue;
        const data = readJsonSafe(filePath);
        const recordDate = getRecordDate(data);

        if (!recordDate) {
            console.log(`  [归档] 跳过 ${path.basename(filePath)}（缺少可识别日期字段）`);
            continue;
        }
        if (recordDate >= today) continue;

        const archiveDayDir = path.join(ARCHIVE_DIR, recordDate);
        const archivePath = path.join(archiveDayDir, path.basename(filePath));
        if (fs.existsSync(archivePath)) {
            console.log(`  [归档] 已存在，跳过 ${recordDate}/${path.basename(filePath)}`);
        } else {
            try {
                fs.mkdirSync(archiveDayDir, { recursive: true });
                fs.copyFileSync(filePath, archivePath);
                archived++;
                console.log(`  [归档] ${path.basename(filePath)} -> ${recordDate}/${path.basename(filePath)}`);
            } catch (e) {
                console.log(`  [归档] 复制失败 ${path.basename(filePath)}: ${e.message}`);
                continue;
            }
        }

        try {
            fs.unlinkSync(filePath);
            removed++;
            console.log(`  [移走] 已清空 ${path.basename(filePath)}`);
        } catch (e) {
            console.log(`  [移走] 删除失败 ${path.basename(filePath)}: ${e.message}`);
        }
    }

    if (archived > 0 || removed > 0) {
        console.log(`📦 自动归档完成：${archived} 个文件备份，${removed} 个文件移走`);
    } else {
        console.log('📦 自动归档：无需归档');
    }
}

/**
 * 从归档目录加载已分析论文的规范化ID集合
 * 用于跳过之前已经成功分析过的论文（避免HF论文在7天窗口内重复出现）
 */
function loadAnalyzedIdsFromArchive() {
    const analyzedIds = new Set();
    if (!fs.existsSync(ARCHIVE_DIR)) return analyzedIds;

    const entries = fs.readdirSync(ARCHIVE_DIR, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // 只读取日期格式的目录 (YYYY-MM-DD)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;

        const archiveFile = path.join(ARCHIVE_DIR, entry.name, 'deep-analysis-result.json');
        if (!fs.existsSync(archiveFile)) continue;

        try {
            const data = readJsonSafe(archiveFile);
            if (data.papers && Array.isArray(data.papers)) {
                for (const paper of data.papers) {
                    // 只跳过有成功分析结果的论文
                    if (paper.analysis && paper.analysis.trim().length > 0) {
                        const nid = normalizedId(paper);
                        if (nid) analyzedIds.add(nid);
                    }
                }
            }
        } catch (e) {
            // 忽略损坏的归档文件
        }
    }
    return analyzedIds;
}

async function fullFetch() {
    console.log('=== 论文抓取 + 深度分析（arxiv + HuggingFace Papers）===');
    console.log('');
    autoArchiveCurrentData();
    console.log('');

    // papers.json 自动备份（去重数据库，不归档但需备份防损坏）
    const backupResult = backupPapersJson(PAPERS_FILE, ARCHIVE_DIR);
    console.log(`📦 ${backupResult.message}`);
    console.log('');

    const categories = Config.ARXIV_CATEGORIES;

    const papersData = loadPapers();
    const existingIds = new Set(Object.keys(papersData.papers).map(id => normalizedId(id)));
    console.log(`已有 ${existingIds.size} 篇论文ID（已规范化），遇到重复将跳过\n`);

    // 加载博客已发布论文 ID，加入去重集合
    const blogRepo = Config.PUBLISH_CONFIG.blogRepo;
    const publishedIds = loadPublishedIdsFromBlog(blogRepo);
    for (const pid of publishedIds) {
        existingIds.add(pid);
    }

    // ========== 第一步：从 arxiv 抓取 ==========
    console.log('📥 第一步：从 arxiv 抓取论文');
    const arxivPapers = [];

    // 核心类别优先，补充类别随机打乱
    const coreCategories = categories.filter(c => c.priority === 'core');
    const supplementCategories = categories.filter(c => c.priority !== 'core');
    for (let i = supplementCategories.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [supplementCategories[i], supplementCategories[j]] = [supplementCategories[j], supplementCategories[i]];
    }
    const shuffledCategories = [...coreCategories, ...supplementCategories];
    console.log(`  请求顺序: ${shuffledCategories.map(c => c.id).join(' → ')}\n`);

    for (let i = 0; i < shuffledCategories.length; i++) {
        const category = shuffledCategories[i];
        // 首次请求前加随机延迟
        if (i === 0) {
            const baseDelay = Config.ARXIV_CONFIG.firstRequestDelayMs;
            const jitter = Math.floor(Math.random() * 10000);
            const firstDelay = baseDelay + jitter;
            console.log(`  首次请求前等待 ${(firstDelay/1000).toFixed(1)} 秒...`);
            await new Promise(resolve => setTimeout(resolve, firstDelay));
        }
        console.log(`  [${i+1}/${shuffledCategories.length}] 抓取 ${category.name} (${category.id})...`);
        const fetchStartTime = Date.now();
        const papers = await fetchCategoryPapers(
            category.id,
            Config.ARXIV_CONFIG.maxResultsPerCategory,
            Config.ARXIV_CONFIG.fetchMaxRetries,
            existingIds
        );
        const fetchDuration = Date.now() - fetchStartTime;
        arxivPapers.push(...papers);
        console.log(`    获取 ${papers.length} 篇新论文`);

        // 核心类别检查：无新论文时继续运行（可能是已知论文太多）
        if (category.priority === 'core' && papers.length === 0) {
            console.log(`\nℹ️ 核心类别 ${category.id}（${category.name}）无新论文（可能均已被收录）`);
            console.log(`   继续运行，尝试其他来源...`);
        }

        // 类别间延迟：基础延迟 + 随机抖动 + 限流检测补偿
        const baseJitter = Math.floor(Math.random() * 15000) + 5000; // 5-20秒随机
        const rateLimitPenalty = fetchDuration > 120000 ? 60000 : (fetchDuration > 60000 ? 30000 : 0);
        const totalDelay = FETCH_DELAY_MS + baseJitter + rateLimitPenalty;
        if (rateLimitPenalty > 0) {
            console.log(`    检测到可能的限流，额外等待 ${(rateLimitPenalty/1000).toFixed(0)} 秒...`);
        }
        console.log(`    等待 ${(totalDelay/1000).toFixed(0)} 秒后继续下一类别...`);
        await new Promise(resolve => setTimeout(resolve, totalDelay));
    }

    console.log(`\narxiv 抓取完成: ${arxivPapers.length} 篇`);

    // ========== 第二步：从 HuggingFace Papers 抓取 ==========
    console.log('\n📥 第二步：从 HuggingFace Papers 抓取论文');

    const allExistingIds = new Set([...existingIds, ...arxivPapers.map(p => normalizedId(p.paper_id || p.arxivId))]);

    const hfPapers = await fetchHuggingFacePapers(allExistingIds, {
        days: Config.HUGGINGFACE_CONFIG.defaultDays,
        minUpvotes: Config.HUGGINGFACE_CONFIG.defaultMinUpvotes
    });

    console.log(`\nHuggingFace Papers 抓取完成: ${hfPapers.length} 篇`);

    // ========== 第三步：合并去重 ==========
    console.log('\n🔄 第三步：合并去重（arxiv + HuggingFace）');
    const allPapers = mergeAndDeduplicate(arxivPapers, hfPapers);
    console.log(`合并后: ${allPapers.length} 篇`);

    const arxivOnly = allPapers.filter(p => p.sources?.includes('arxiv') && !p.sources?.includes('huggingface')).length;
    const hfOnly = allPapers.filter(p => !p.sources?.includes('arxiv') && p.sources?.includes('huggingface')).length;
    const both = allPapers.filter(p => p.sources?.includes('arxiv') && p.sources?.includes('huggingface')).length;
    console.log(`  - 仅 arxiv: ${arxivOnly} 篇`);
    console.log(`  - 仅 HuggingFace: ${hfOnly} 篇`);
    console.log(`  - 两个来源都有: ${both} 篇`);

    // 过滤掉已发布到博客的论文
    const beforeBlogSkip = allPapers.length;
    const allPapersFiltered = allPapers.filter(paper => !publishedIds.has(normalizedId(paper)));
    const blogSkippedCount = beforeBlogSkip - allPapersFiltered.length;
    if (blogSkippedCount > 0) {
        console.log(`📝 过滤 ${blogSkippedCount} 篇已发布到博客的论文`);
    }

    // ========== 第四步：大模型筛选 ==========
    console.log('\n🤖 第四步：大模型筛选（判断是否语音/音频相关）');
    const filtered = await filterPapersWithLLM(allPapersFiltered, {
        batchSize: Config.FILTER_CONFIG.batchSize,
        delayBetweenBatches: Config.FILTER_CONFIG.delayBetweenBatchesMs,
        useKeywordPreFilter: false
    });
    console.log(`筛选后: ${filtered.length} 篇相关论文`);

    // ========== 第四步半：跳过已在归档中分析过的论文 ==========
    const archiveAnalyzedIds = loadAnalyzedIdsFromArchive();
    const beforeArchiveSkip = filtered.length;
    const filteredNew = filtered.filter(paper => {
        const nid = normalizedId(paper);
        // 如果论文已在归档中成功分析过，且当前来源包含 huggingface，则跳过
        if (archiveAnalyzedIds.has(nid) && paper.sources?.includes('huggingface')) {
            return false;
        }
        return true;
    });
    const skippedCount = beforeArchiveSkip - filteredNew.length;
    if (skippedCount > 0) {
        console.log(`📦 跳过 ${skippedCount} 篇已在归档中分析过的 HuggingFace 论文`);
    }

    writeFileAtomic(FILTERED_FILE, JSON.stringify({
        timestamp: getBeijingISOString(),
        stats: {
            beforeFilter: allPapers.length,
            beforeBlogSkip: allPapers.length,
            afterBlogSkip: allPapersFiltered.length,
            afterFilter: filtered.length,
            afterArchiveSkip: filteredNew.length,
            skippedFromBlog: blogSkippedCount,
            skippedFromArchive: skippedCount,
            arxivOnly,
            hfOnly,
            both
        },
        papers: filteredNew
    }, null, 2));
    console.log(`💾 筛选结果已保存到: ${FILTERED_FILE}`);

    // ========== 第五步：深度分析 ==========
    console.log('\n🔬 第五步：深度分析每篇论文');
    const analyzedPapers = [];
    let saveInProgress = false;
    let pendingSave = false;

    const doIncrementalSave = () => {
        if (saveInProgress) {
            pendingSave = true;
            return;
        }
        saveInProgress = true;
        const outputFile = fs.existsSync(RESULT_FILE) || !fs.existsSync(LEGACY_RESULT_FILE) ? RESULT_FILE : LEGACY_RESULT_FILE;
        mergeAndSaveResults(analyzedPapers, outputFile, {
            timestamp: getBeijingISOString(),
            stats: { afterFilter: filteredNew.length, newlyAnalyzed: analyzedPapers.filter(p => p.analysis).length }
        }).then(({ totalMerged }) => {
            console.log(`  💾 增量保存: ${analyzedPapers.filter(p => p.analysis).length}/${analyzedPapers.length} 篇已分析完成 (合并后 ${totalMerged} 篇)`);
            saveInProgress = false;
            if (pendingSave) {
                pendingSave = false;
                doIncrementalSave();
            }
        }).catch(err => {
            console.log(`  ⚠️ 增量保存失败: ${err.message}`);
            saveInProgress = false;
            if (pendingSave) {
                pendingSave = false;
                doIncrementalSave();
            }
        });
    };

    const { stats: analysisStats } = await analyzeBatch(filteredNew, {
        concurrency: ANALYSIS_CONCURRENCY,
        maxRetries: ANALYSIS_RETRY_MAX,
        retryDelayMs: ANALYSIS_RETRY_DELAY_MS,
        onPaperStart: (idx, total, paper) => {
            console.log(`  [${idx + 1}/${total}] ▶ 开始: ${paper.title.substring(0, 50)}...`);
        },
        onPaperDone: (idx, total, paper, result, duration) => {
            const durSec = (duration / 1000).toFixed(1);
            if (result.success) {
                const score = result.parsed?.score ? `[${result.parsed.score}分]` : '[N/A]';
                const rank = result.parsed?.rankBucket || '未分档';
                const primaryTask = result.parsed?.primaryTaskTag || '';
                const extra = primaryTask ? ` ${primaryTask}` : '';
                console.log(`  [${idx + 1}/${total}] ✅ 完成 ${score} ${rank}${extra} | ${durSec}s | ${paper.title.substring(0, 50)}...`);
            } else {
                console.log(`  [${idx + 1}/${total}] ❌ 最终失败 | ${durSec}s | ${paper.title.substring(0, 50)}... | ${result.error}`);
            }
        },
        onBatchDone: (batchNum, batchResults) => {
            const batchSuccess = batchResults.filter(r => r.success).length;
            const batchFailed = batchResults.length - batchSuccess;
            const batchScores = batchResults.filter(r => r.success && r.parsed?.score).map(r => r.parsed.score);
            const batchScoreInfo = batchScores.length > 0 ? ` 评分: ${batchScores.join(', ')}` : '';
            const totalBatches = Math.ceil(filteredNew.length / ANALYSIS_CONCURRENCY);
            console.log(`  ── 批次 ${batchNum}/${totalBatches} 完成: 成功 ${batchSuccess}/${batchResults.length}${batchScoreInfo}${batchFailed > 0 ? ` | 失败 ${batchFailed}` : ''}\n`);

            // 收集成功结果到 analyzedPapers
            for (const r of batchResults) {
                if (r.success && r.result) {
                    analyzedPapers.push(r.result);
                } else if (!r.skipped) {
                    analyzedPapers.push(r.result || r);
                }
            }

            // 增量保存（带锁防止竞态条件）
            doIncrementalSave();
        }
    });

    // ========== 第六步：保存论文数据库 ==========
    console.log('\n💾 第六步：更新 papers.json 去重数据库');
    let newPaperCount = 0;
    for (const paper of allPapers) {
        const rawId = paper.paper_id || paper.arxivId;
        const normId = normalizedId(rawId);
        if (normId && !papersData.papers[normId]) {
            papersData.papers[normId] = paper;
            newPaperCount++;
        }
    }
    try {
        savePapers(papersData);
        console.log(`  新增 ${newPaperCount} 篇论文ID到数据库，累计 ${Object.keys(papersData.papers).length} 篇`);
    } catch (e) {
        console.error(`  ❌ 保存 papers.json 失败: ${e.message}`);
    }

    // ========== 第七步：保存深度分析结果 ==========
    console.log('\n💾 第七步：保存深度分析结果');

    const outputFile = fs.existsSync(RESULT_FILE) || !fs.existsSync(LEGACY_RESULT_FILE) ? RESULT_FILE : LEGACY_RESULT_FILE;

    let existingPapers = [];
    let existingTimestamp = null;
    const existingData = readJsonSafe(outputFile, null);
    if (existingData) {
        existingPapers = Array.isArray(existingData) ? existingData : (existingData.papers || []);
        existingTimestamp = existingData.timestamp || null;
        console.log(`  读取到已有结果: ${existingPapers.length} 篇 (${existingTimestamp})`);
    } else {
        console.log('  读取已有结果失败或文件不存在，将创建新文件');
    }

    if (fs.existsSync(outputFile) && existingPapers.length > 0) {
        const backupName = `deep-analysis-result-${getBeijingCompactTimestamp()}.bak.json`;
        const backupPath = path.join(ARCHIVE_DIR, backupName);
        fs.copyFileSync(outputFile, backupPath);
        console.log(`  已备份: ${backupName}`);

        // 清理旧 backup，保留最近 10 个
        try {
            const backups = fs.readdirSync(ARCHIVE_DIR)
                .filter(f => f.startsWith('deep-analysis-result-') && f.endsWith('.bak.json'))
                .map(f => ({ name: f, path: path.join(ARCHIVE_DIR, f), mtime: fs.statSync(path.join(ARCHIVE_DIR, f)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);
            if (backups.length > 10) {
                for (const b of backups.slice(10)) {
                    fs.unlinkSync(b.path);
                }
                console.log(`  已清理 ${backups.length - 10} 个旧 backup`);
            }
        } catch (e) {
            // ignore cleanup errors
        }
    }

    const mergedMap = new Map();

    for (const paper of existingPapers) {
        const key = normalizedId(paper);
        if (key) mergedMap.set(key, paper);
    }

    for (const paper of analyzedPapers) {
        const key = normalizedId(paper);
        if (!key) continue;
        // 避免用无 analysis 的失败结果覆盖已有成功结果
        const existing = mergedMap.get(key);
        if (existing && existing.analysis && !paper.analysis) {
            continue;
        }
        mergedMap.set(key, paper);
    }

    const mergedPapers = Array.from(mergedMap.values());

    const result = {
        timestamp: getBeijingISOString(),
        previousTimestamp: existingTimestamp,
        stats: {
            arxivFetched: arxivPapers.length,
            hfFetched: hfPapers.length,
            totalMerged: allPapers.length,
            afterFilter: filtered.length,
            newlyAnalyzed: analyzedPapers.length,
            preservedExisting: existingPapers.length,
            totalAfterMerge: mergedPapers.length,
            arxivOnly,
            hfOnly,
            both
        },
        papers: mergedPapers
    };

    try {
        writeFileAtomic(outputFile, JSON.stringify(result, null, 2));
    } catch (e) {
        console.error(`\n❌ 保存结果失败: ${e.message}`);
        throw e;
    }

    console.log(`\n✅ 分析完成！`);
    console.log(`📊 统计:`);
    console.log(`  - arxiv 抓取: ${arxivPapers.length} 篇`);
    console.log(`  - HuggingFace 抓取: ${hfPapers.length} 篇`);
    console.log(`  - 合并去重: ${allPapers.length} 篇`);
    console.log(`  - LLM 筛选: ${filtered.length} 篇`);
    if (skippedCount > 0) console.log(`  - 归档去重: -${skippedCount} 篇`);
    if (blogSkippedCount > 0) console.log(`  - 博客去重: -${blogSkippedCount} 篇`);
    console.log(`  - 本次分析: ${analyzedPapers.length} 篇`);
    console.log(`  - 保留已有: ${existingPapers.length} 篇`);
    console.log(`  - 合并后总计: ${mergedPapers.length} 篇`);
    if (analysisStats) {
        const avgSec = analysisStats.durationTotal > 0 ? (analysisStats.durationTotal / 1000 / (analysisStats.success + analysisStats.failed)).toFixed(1) : '0';
        console.log(`  - 分析引擎: 成功 ${analysisStats.success} | 失败 ${analysisStats.failed} | 跳过 ${analysisStats.skipped} | 平均 ${avgSec}s/篇`);
    }
    console.log(`\n💾 结果已保存到: ${outputFile}`);

    return result;
}

fullFetch().catch(err => {
    console.error(`❌ 失败: ${err.message}`);
    process.exit(1);
});
