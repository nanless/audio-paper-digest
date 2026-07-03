#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * ICML 2026 PDF 全文重分析 — 薄封装，委托给 analysis-engine.js
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomic, readJsonSafe } = require('./utils.js');
const Config = require('./config.js');
const { analyzeBatch } = require('./analysis-engine.js');

const PROJECT_ROOT = path.join(__dirname, '..');
const PDF_DIR = path.join(PROJECT_ROOT, 'data', 'pdfs', 'icml2026');
const PDF_MAP_FILE = path.join(PROJECT_ROOT, 'data', 'current', 'icml_2026_pdf_map.json');
const ANALYSIS_FILE = path.join(PROJECT_ROOT, 'data', 'current', 'icml_2026_deep_analysis.json');
const CONCURRENCY = parseInt(process.env.ICML_ANALYSIS_CONCURRENCY || '3', 10);

async function main() {
    const missing = [];
    if (!process.env.PAPER_ANALYZER_ENDPOINT) missing.push('PAPER_ANALYZER_ENDPOINT');
    if (!process.env.PAPER_ANALYZER_API_KEY) missing.push('PAPER_ANALYZER_API_KEY');
    if (!process.env.PAPER_ANALYZER_MODEL) missing.push('PAPER_ANALYZER_MODEL');
    if (missing.length > 0) { console.error(`缺少: ${missing.join(', ')}`); process.exit(1); }

    const pdfMap = readJsonSafe(PDF_MAP_FILE, {});
    const data = readJsonSafe(ANALYSIS_FILE, { papers: [] });

    const toReanalyze = [];
    for (const p of data.papers) {
        const info = pdfMap[p.id];
        if (!info?.arxivId) continue;
        const txt = path.join(PDF_DIR, info.arxivId + '.txt');
        if (!fs.existsSync(txt)) continue;
        let text = fs.readFileSync(txt, 'utf-8');
        if (text.length < 1000) continue;
        p.fullText = text.length > 120000 ? text.substring(0, 120000) + '\n\n[... 截断 ...]' : text;
        toReanalyze.push(p);
    }

    console.log(`=== ICML PDF 重分析 ===`);
    console.log(`模型: ${process.env.PAPER_ANALYZER_MODEL}`);
    if (process.env.PAPER_ANALYZER_SECONDARY_MODEL) console.log(`副模型: ${process.env.PAPER_ANALYZER_SECONDARY_MODEL}`);
    console.log(`可重分析: ${toReanalyze.length}\n`);

    if (!toReanalyze.length) { console.log('无可重分析论文'); return; }

    let ok = 0, fail = 0;
    await analyzeBatch(toReanalyze, {
        concurrency: CONCURRENCY,
        maxRetries: Config.ANALYSIS_CONFIG.maxRetries,
        onPaperStart: (i, t, p) => console.log(`[${i + 1}/${t}] ${(p.title || '').substring(0, 60)}`),
        onPaperDone: (i, t, p, r, dur) => {
            const idx = data.papers.findIndex(pp => pp.id === p.id);
            if (idx >= 0) {
                if (r.success) {
                    ok++; data.papers[idx].analysis = r.result?.analysis;
                    data.papers[idx].parsed = r.parsed;
                    data.papers[idx].pdfAnalyzed = true;
                    console.log(`  ✅ ${(dur/1000).toFixed(1)}s`);
                } else {
                    fail++;
                    console.log(`  ❌ ${r.error}`);
                }
            }
            writeFileAtomic(ANALYSIS_FILE, JSON.stringify(data, null, 2));
        }
    });

    console.log(`\n=== 完成 ===\n成功: ${ok}, 失败: ${fail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
