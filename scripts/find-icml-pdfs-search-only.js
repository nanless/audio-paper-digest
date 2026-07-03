#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 第一阶段：只搜索arXiv ID，不下载PDF
 * 并发搜索以提高效率
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { readJsonSafe, writeFileAtomic } = require('./utils.js');

const FILTERED_FILE = path.join(__dirname, '..', 'data', 'current', 'icml_2026_filtered.json');
const PDF_MAP_FILE = path.join(__dirname, '..', 'data', 'current', 'icml_2026_pdf_map.json');

const data = readJsonSafe(FILTERED_FILE);
let existingMap = readJsonSafe(PDF_MAP_FILE, {});

// 待搜索的论文
const papers = data.papers.filter(p => !existingMap[p.id]);
console.log(`已找到: ${Object.keys(existingMap).length} 篇`);
console.log(`待搜索: ${papers.length} 篇\n`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, protocol = http, maxRetries = 3, timeoutMs = 30000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await new Promise((resolve, reject) => {
                const req = protocol.get(url, { timeout: timeoutMs }, (res) => {
                    const chunks = [];
                    res.on('data', chunk => chunks.push(chunk));
                    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            });
            return result;
        } catch (e) {
            if (attempt < maxRetries) {
                await sleep(2000 * attempt);
            } else {
                throw e;
            }
        }
    }
}

function parseArxivXml(xml) {
    if (!xml) return [];
    const entries = [];
    const re = /<entry>([\s\S]*?)<\/entry>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const entry = m[1];
        const idMatch = entry.match(/<id>(.*?)<\/id>/);
        const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
        const authorMatches = entry.matchAll(/<name>(.*?)<\/name>/g);
        const authors = [...authorMatches].map(a => a[1]);
        if (idMatch && titleMatch) {
            const arxivId = idMatch[1].replace('http://arxiv.org/abs/', '').split('v')[0];
            const title = titleMatch[1].replace(/\n/g, ' ').trim();
            entries.push({ arxivId, title, authors });
        }
    }
    return entries;
}

function titleSimilarity(a, b) {
    const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const na = normalize(a);
    const nb = normalize(b);
    if (na === nb) return 1.0;
    if (na.includes(nb) || nb.includes(na)) return 0.85;
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = [...wordsA].filter(w => wordsB.has(w));
    const union = new Set([...wordsA, ...wordsB]);
    return intersection.length / union.size;
}

function authorOverlap(authorsA, authorsB) {
    if (!authorsA || !authorsB) return 0;
    const a = new Set(authorsA.map(x => x.toLowerCase()));
    const b = new Set(authorsB.map(x => x.toLowerCase()));
    const intersection = [...a].filter(x => b.has(x));
    return intersection.length / Math.max(a.size, b.size);
}

// 批量搜索（每批N个，间隔3.5秒）
async function searchBatch(batch, batchNum, totalBatches) {
    const results = [];
    for (let i = 0; i < batch.length; i++) {
        const paper = batch[i];
        const title = paper.title;
        const authors = paper.authors || [];
        const globalIdx = (batchNum * batch.length) + i + 1;

        let bestMatch = null;
        let bestScore = 0;
        let tried = [];

        // 策略1: arXiv 完整标题
        try {
            const query = encodeURIComponent(title);
            const url = `https://export.arxiv.org/api/query?search_query=all:${query}&max_results=5&sortBy=relevance`;
            const xml = await fetchWithRetry(url, https, 2, 20000);
            const entries = parseArxivXml(xml);
            for (const e of entries) {
                let sim = titleSimilarity(title, e.title);
                const auSim = authorOverlap(authors, e.authors);
                if (auSim > 0.3) sim += 0.15;
                if (sim > bestScore) {
                    bestScore = sim;
                    bestMatch = { source: 'arxiv-full', arxivId: e.arxivId, title: e.title, similarity: sim };
                }
            }
            if (entries.length > 0) tried.push(`full:${entries.length}`);
        } catch (e) { tried.push(`full:err`); }

        // 策略2: arXiv 短关键词
        if (bestScore < 0.6) {
            try {
                const words = title.split(/\s+/).slice(0, 4).join(' ');
                const query = encodeURIComponent(words);
                const url = `http://export.arxiv.org/api/query?search_query=all:${query}&max_results=5&sortBy=relevance`;
                const xml = await fetchWithRetry(url, http, 2, 20000);
                const entries = parseArxivXml(xml);
                for (const e of entries) {
                    let sim = titleSimilarity(title, e.title);
                    const auSim = authorOverlap(authors, e.authors);
                    if (auSim > 0.3) sim += 0.15;
                    if (sim > bestScore) {
                        bestScore = sim;
                        bestMatch = { source: 'arxiv-short', arxivId: e.arxivId, title: e.title, similarity: sim };
                    }
                }
                if (entries.length > 0) tried.push(`short:${entries.length}`);
            } catch (e) { tried.push(`short:err`); }
        }

        // 策略3: Semantic Scholar
        if (bestScore < 0.6) {
            try {
                const query = encodeURIComponent(title);
                const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${query}&fields=title,authors,year,externalIds&limit=5`;
                const data = await fetchWithRetry(url, https, 2, 15000);
                const ssResult = JSON.parse(data);
                if (ssResult.data) {
                    for (const p of ssResult.data) {
                        const sim = titleSimilarity(title, p.title);
                        if (sim > bestScore) {
                            bestScore = sim;
                            const arxivId = p.externalIds?.ArXiv;
                            if (arxivId) {
                                bestMatch = { source: 'ss', arxivId, title: p.title, similarity: sim };
                            }
                        }
                    }
                    if (ssResult.data.length > 0) tried.push(`ss:${ssResult.data.length}`);
                }
            } catch (e) { tried.push(`ss:err`); }
        }

        if (bestMatch && bestScore >= 0.5) {
            results.push({ paper, match: bestMatch });
            console.log(`[${globalIdx}/${papers.length}] ✅ ${bestScore.toFixed(2)} | ${title.substring(0, 60)}... | ${bestMatch.arxivId} | ${tried.join(' ')}`);
        } else {
            console.log(`[${globalIdx}/${papers.length}] ❌ ${bestScore.toFixed(2)} | ${title.substring(0, 60)}... | ${tried.join(' ')}`);
        }

        // arXiv rate limit
        if (i < batch.length - 1) {
            await sleep(3500);
        }
    }
    return results;
}

async function main() {
    const BATCH_SIZE = 3; // 每批3篇，间隔处理
    const batches = [];
    for (let i = 0; i < papers.length; i += BATCH_SIZE) {
        batches.push(papers.slice(i, i + BATCH_SIZE));
    }

    let foundCount = 0;

    for (let bi = 0; bi < batches.length; bi++) {
        console.log(`\n--- 批次 ${bi + 1}/${batches.length} ---`);
        const results = await searchBatch(batches[bi], bi, batches.length);

        for (const { paper, match } of results) {
            existingMap[paper.id] = {
                ...match,
                icmlTitle: paper.title,
                icmlId: paper.id
            };
            foundCount++;
        }

        // 每批保存一次
        writeFileAtomic(PDF_MAP_FILE, JSON.stringify(existingMap, null, 2));

        // 批次间隔
        if (bi < batches.length - 1) {
            await sleep(5000);
        }
    }

    console.log(`\n=== 搜索完成 ===`);
    console.log(`本次新找到: ${foundCount}`);
    console.log(`总计找到: ${Object.keys(existingMap).length}/${data.papers.length}`);
    console.log(`结果: ${PDF_MAP_FILE}`);
}

main().catch(e => {
    console.error('错误:', e);
    process.exit(1);
});
