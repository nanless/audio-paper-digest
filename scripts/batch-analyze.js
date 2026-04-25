#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 批量分析论文 - 读取 deep-analysis-result.json 中未分析的论文
 * 使用 analysis-engine.js 统一封装的重试与保存逻辑
 */

const fs = require('fs');
const path = require('path');
const { loadEnvFile, writeFileAtomic, readJsonSafe } = require('./utils.js');
const { analyzeBatch, createFileSaver } = require('./analysis-engine.js');
const Config = require('./config.js');

loadEnvFile();

const DATA_DIR = path.join(__dirname, '..', 'data');
const CURRENT_DIR = path.join(DATA_DIR, 'current');
const LEGACY_RESULT_FILE = path.join(DATA_DIR, 'deep-analysis-result.json');
const RESULT_FILE = fs.existsSync(path.join(CURRENT_DIR, 'deep-analysis-result.json')) || !fs.existsSync(LEGACY_RESULT_FILE)
    ? path.join(CURRENT_DIR, 'deep-analysis-result.json')
    : LEGACY_RESULT_FILE;

async function main() {
    console.log('=== 批量论文分析 ===');
    console.log(`数据文件: ${RESULT_FILE}`);

    const data = readJsonSafe(RESULT_FILE, null);
    if (!data) {
        console.error(`读取数据文件失败: ${RESULT_FILE}`);
        process.exit(1);
    }

    const papers = Array.isArray(data) ? data : (data.papers || []);
    console.log(`总论文数: ${papers.length}`);

    const notAnalyzed = papers.filter(p => !p.analysis);
    console.log(`未分析论文: ${notAnalyzed.length}`);

    if (notAnalyzed.length === 0) {
        console.log('所有论文已分析完成！');
        return;
    }

    const saver = createFileSaver(RESULT_FILE);

    const { stats } = await analyzeBatch(notAnalyzed, {
        concurrency: Config.ANALYSIS_CONFIG.concurrency,
        maxRetries: Config.ANALYSIS_CONFIG.maxRetries,
        retryDelayMs: Config.ANALYSIS_CONFIG.retryDelayMs,
        saveInterval: 1,
        onPaperStart: (idx, total, paper) => {
            console.log(`\n--- [${idx + 1}/${total}] 分析: ${paper.arxivId} ---`);
            const titleStr = paper.title || '(无标题)';
            console.log(`标题: ${titleStr.substring(0, 80)}${titleStr.length > 80 ? '...' : ''}`);
        },
        onPaperDone: (idx, total, paper, result, duration) => {
            const durSec = (duration / 1000).toFixed(1);
            if (result.success) {
                console.log(`✅ 分析成功 (${durSec}s)`);
                if (result.parsed) {
                    console.log(`   评分: ${result.parsed.score || 'N/A'}`);
                    console.log(`   标签: ${result.parsed.tags ? result.parsed.tags.slice(0, 5).join(' ') : 'N/A'}`);
                    console.log(`   分档: ${result.parsed.rankBucket || 'N/A'} | 主任务: ${result.parsed.primaryTaskTag || 'N/A'} | 主方法: ${result.parsed.primaryMethodTag || 'N/A'}`);
                }
            } else {
                console.log(`❌ 分析异常 (${durSec}s): ${result.error}`);
            }
        },
        onSave: async (results, saveStats) => {
            // 按 ID 匹配替换，避免顺序错位
            const resultMap = new Map();
            for (const r of results) {
                if (!r.success || !r.result) continue;
                const key = r.result.arxivId || r.result.paper_id;
                if (key) resultMap.set(key, r.result);
            }
            for (let i = 0; i < papers.length; i++) {
                const key = papers[i].arxivId || papers[i].paper_id;
                if (resultMap.has(key)) {
                    papers[i] = resultMap.get(key);
                }
            }
            await saver(papers, saveStats);
            console.log(`   已保存到 ${RESULT_FILE}`);
        }
    });

    console.log('\n=== 批量分析完成 ===');
    console.log(`成功: ${stats.success} | 失败: ${stats.failed} | 总计处理: ${notAnalyzed.length}`);
    const remaining = papers.filter(p => !p.analysis).length;
    console.log(`剩余未分析: ${remaining}`);
}

main().catch(err => {
    console.error('批量分析异常:', err);
    process.exit(1);
});
