#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * ICML 2026 重试失败分析 — 薄封装，委托给 analysis-engine.js
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomic, readJsonSafe } = require('./utils.js');
const Config = require('./config.js');
const { analyzeBatch } = require('./analysis-engine.js');

const PROJECT_ROOT = path.join(__dirname, '..');
const RESULT_FILE = process.env.ICML_RESULT_FILE || path.join(Config.CURRENT_DIR, 'icml_2026_deep_analysis.json');
const CONCURRENCY = Math.min(parseInt(process.env.ICML_ANALYSIS_CONCURRENCY || '3', 10), 3);

function attachPdfText(paper) {
    const safeId = (paper.id || '').replace(/\//g, '_');
    const txtFile = path.join(PROJECT_ROOT, 'data', 'pdfs', 'icml2026', safeId + '.txt');
    try {
        if (fs.existsSync(txtFile)) {
            let text = fs.readFileSync(txtFile, 'utf-8');
            paper.fullText = text.length > 120000 ? text.substring(0, 120000) + '\n\n[... 截断 ...]' : text;
        }
    } catch (e) {}
}

async function main() {
    const missing = [];
    if (!process.env.PAPER_ANALYZER_ENDPOINT) missing.push('PAPER_ANALYZER_ENDPOINT');
    if (!process.env.PAPER_ANALYZER_API_KEY) missing.push('PAPER_ANALYZER_API_KEY');
    if (!process.env.PAPER_ANALYZER_MODEL) missing.push('PAPER_ANALYZER_MODEL');
    if (missing.length > 0) { console.error(`缺少: ${missing.join(', ')}`); process.exit(1); }

    const data = readJsonSafe(RESULT_FILE);
    if (!data?.papers) { console.error('无效结果文件'); process.exit(1); }

    const failed = data.papers.filter(p => p.error);
    console.log('=== ICML 重试失败 ===');
    console.log(`模型: ${process.env.PAPER_ANALYZER_MODEL}`);
    if (process.env.PAPER_ANALYZER_SECONDARY_MODEL) console.log(`副模型: ${process.env.PAPER_ANALYZER_SECONDARY_MODEL}`);
    console.log(`失败: ${failed.length}/${data.papers.length}\n`);

    if (!failed.length) { console.log('无失败论文'); return; }

    for (const p of failed) attachPdfText(p);
    let ok = 0, stillFail = 0;

    await analyzeBatch(failed, {
        concurrency: CONCURRENCY,
        maxRetries: Config.ANALYSIS_CONFIG.maxRetries,
        saveInterval: 5,
        onPaperStart: (i, t, p) => console.log(`[retry] ${p.id} - ${(p.title || '').substring(0, 60)}`),
        onPaperDone: (i, t, p, r, dur) => {
            const idx = data.papers.findIndex(pp => pp.id === p.id);
            if (idx >= 0) {
                if (r.success) {
                    ok++; data.papers[idx].analysis = r.result?.analysis;
                    data.papers[idx].parsed = r.parsed; data.papers[idx].error = null;
                    console.log(`  ✅ ${r.parsed?.score || '?'}/10`);
                } else {
                    stillFail++; data.papers[idx].retry_error = r.error;
                    console.log(`  ❌ ${r.error}`);
                }
            }
            writeFileAtomic(RESULT_FILE, JSON.stringify(data, null, 2));
        }
    });

    console.log(`\n=== 完成 ===\n成功: ${ok}, 仍失败: ${stillFail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
