#!/usr/bin/env node
/** Fetch only the full-text evidence needed by the offline manual analyst. */
const fs = require('fs');
const path = require('path');
const Config = require('./config.js');
const { normalizedId, writeFileAtomic, getBeijingISOString } = require('./utils.js');
const { fetchArxivTextDetailed } = require('./deep-analyzer.js');

const DATE = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE || '')) throw new Error('用法: node scripts/manual-fetch-fulltext.js YYYY-MM-DD');

async function main() {
    const filtered = JSON.parse(fs.readFileSync(Config.FILES.filteredPapers, 'utf8'));
    if (filtered.batchDate !== DATE || filtered.status !== 'complete' || !Array.isArray(filtered.papers)) {
        throw new Error(`filtered-papers.json 不是 ${DATE} complete 批次`);
    }
    const outDir = path.join(Config.CURRENT_DIR, 'manual-full-text', DATE);
    fs.mkdirSync(outDir, { recursive: true });
    const manifest = {
        version: 1,
        mode: 'manual_full_text_fetch',
        date: DATE,
        startedAt: getBeijingISOString(),
        papers: {}
    };
    let cursor = 0;
    const worker = async () => {
        while (cursor < filtered.papers.length) {
            const paper = filtered.papers[cursor++];
            const id = normalizedId(paper);
            if (!id) throw new Error('filtered paper 缺少 ID');
            const filePath = path.join(outDir, `${id}.txt`);
            console.log(`[manual-full-text] ${id} 获取全文...`);
            const result = await fetchArxivTextDetailed(id);
            if (!result.text || result.text.length < 1000) {
                throw new Error(`${id} 正文不足 1000 字符（source=${result.source || 'none'}）`);
            }
            writeFileAtomic(filePath, result.text);
            manifest.papers[id] = {
                path: filePath,
                source: result.source,
                sourceId: result.sourceId,
                chars: result.text.length,
                sourceSha256: result.sourceSha256,
                warnings: result.warnings || [],
                fetchedAt: getBeijingISOString()
            };
            console.log(`[manual-full-text] ${id} 完成 ${result.source} ${result.text.length} chars`);
        }
    };
    await Promise.all(Array.from({ length: Math.min(3, filtered.papers.length) }, worker));
    manifest.completedAt = getBeijingISOString();
    manifest.count = Object.keys(manifest.papers).length;
    writeFileAtomic(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`✅ manual 全文证据完成：${manifest.count} 篇，目录 ${outDir}`);
}

main().catch(error => {
    console.error(`❌ manual-full-text 失败: ${error.message}`);
    process.exitCode = 1;
});
