#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 为 ICML 2026 论文搜索 arXiv 和其他来源的 PDF
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { readJsonSafe, writeFileAtomic } = require('./utils.js');

const PROJECT_ROOT = path.join(__dirname, '..');
const FILTERED_FILE = path.join(PROJECT_ROOT, 'data', 'current', 'icml_2026_filtered.json');
const PDF_MAP_FILE = path.join(PROJECT_ROOT, 'data', 'current', 'icml_2026_pdf_map.json');
const PDF_DIR = path.join(PROJECT_ROOT, 'data', 'pdfs', 'icml2026');

// 加载论文
const data = readJsonSafe(FILTERED_FILE);
if (!data || !data.papers) {
    console.error('无法加载过滤后的论文');
    process.exit(1);
}
const papers = data.papers;
console.log(`加载 ${papers.length} 篇论文，开始搜索 PDF...\n`);

// 睡眠函数
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 搜索 arXiv API
async function searchArxiv(title) {
    const query = encodeURIComponent(title);
    const url = `http://export.arxiv.org/api/query?search_query=all:${query}&max_results=5&sortBy=relevance`;

    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 15000 }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

// 解析 arXiv 搜索结果
function parseArxivResult(xml, originalTitle) {
    const entries = [];
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    let match;
    while ((match = entryRegex.exec(xml)) !== null) {
        const entry = match[1];
        const idMatch = entry.match(/<id>(.*?)<\/id>/);
        const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
        if (idMatch && titleMatch) {
            const arxivId = idMatch[1].replace('http://arxiv.org/abs/', '').split('v')[0];
            const title = titleMatch[1].replace(/\n/g, ' ').trim();
            entries.push({ arxivId, title });
        }
    }
    return entries;
}

// 计算标题相似度（简单版本）
function titleSimilarity(a, b) {
    const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const na = normalize(a);
    const nb = normalize(b);
    if (na === nb) return 1.0;
    // 检查是否是子串
    if (na.includes(nb) || nb.includes(na)) return 0.9;
    // 计算共同词
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = [...wordsA].filter(w => wordsB.has(w));
    const union = new Set([...wordsA, ...wordsB]);
    return intersection.length / union.size;
}

// 搜索 Semantic Scholar
async function searchSemanticScholar(title) {
    const query = encodeURIComponent(title);
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${query}&fields=title,authors,year,externalIds,openAccessPdf&limit=5`;

    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: 15000 }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { resolve({ data: [] }); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

// 下载 PDF
async function downloadPdf(url, outputPath) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : require('http');
        const req = protocol.get(url, { timeout: 30000 }, (res) => {
            if (res.statusCode === 302 || res.statusCode === 301) {
                return downloadPdf(res.headers.location, outputPath).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            const file = fs.createWriteStream(outputPath);
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(true); });
            file.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

async function main() {
    const pdfMap = readJsonSafe(PDF_MAP_FILE, {});
    let foundCount = 0;
    let downloadedCount = 0;

    fs.mkdirSync(PDF_DIR, { recursive: true });

    for (let i = 0; i < papers.length; i++) {
        const paper = papers[i];
        const title = paper.title;

        // 跳过已找到的
        if (pdfMap[paper.id] && pdfMap[paper.id].arxivId) {
            console.log(`[${i+1}/${papers.length}] ${paper.id} 已找到，跳过`);
            continue;
        }

        console.log(`[${i+1}/${papers.length}] 搜索: ${title.substring(0, 60)}...`);

        let bestMatch = null;
        let bestScore = 0;

        // 1. 搜索 arXiv
        try {
            await sleep(3500); // arXiv rate limit
            const xml = await searchArxiv(title);
            const entries = parseArxivResult(xml, title);
            for (const entry of entries) {
                const sim = titleSimilarity(title, entry.title);
                if (sim > bestScore) {
                    bestScore = sim;
                    bestMatch = { source: 'arxiv', arxivId: entry.arxivId, title: entry.title, similarity: sim };
                }
            }
            if (entries.length > 0) {
                console.log(`  arXiv: ${entries.length} 结果，最佳匹配 ${bestScore.toFixed(2)}`);
            }
        } catch (e) {
            console.log(`  arXiv 搜索失败: ${e.message}`);
        }

        // 2. 搜索 Semantic Scholar
        try {
            await sleep(500);
            const ssResult = await searchSemanticScholar(title);
            if (ssResult.data && ssResult.data.length > 0) {
                for (const p of ssResult.data) {
                    const sim = titleSimilarity(title, p.title);
                    if (sim > bestScore) {
                        bestScore = sim;
                        const arxivId = p.externalIds?.ArXiv;
                        const pdfUrl = p.openAccessPdf?.url;
                        bestMatch = {
                            source: 'semanticscholar',
                            title: p.title,
                            similarity: sim,
                            arxivId,
                            pdfUrl,
                            year: p.year
                        };
                    }
                }
                console.log(`  SS: ${ssResult.data.length} 结果，最佳匹配 ${bestScore.toFixed(2)}`);
            }
        } catch (e) {
            console.log(`  SS 搜索失败: ${e.message}`);
        }

        // 保存结果
        if (bestMatch && bestScore >= 0.6) {
            pdfMap[paper.id] = {
                ...bestMatch,
                icmlTitle: title,
                icmlId: paper.id
            };
            foundCount++;
            console.log(`  ✅ 找到匹配 (${bestScore.toFixed(2)}): ${bestMatch.title.substring(0, 60)}...`);

            // 尝试下载 PDF
            let pdfUrl = null;
            if (bestMatch.arxivId) {
                pdfUrl = `https://arxiv.org/pdf/${bestMatch.arxivId}.pdf`;
            } else if (bestMatch.pdfUrl) {
                pdfUrl = bestMatch.pdfUrl;
            }

            if (pdfUrl) {
                const pdfPath = path.join(PDF_DIR, `${paper.id}.pdf`);
                if (!fs.existsSync(pdfPath)) {
                    try {
                        await sleep(1000);
                        await downloadPdf(pdfUrl, pdfPath);
                        const stats = fs.statSync(pdfPath);
                        if (stats.size > 10000) {
                            pdfMap[paper.id].pdfPath = pdfPath;
                            pdfMap[paper.id].pdfSize = stats.size;
                            downloadedCount++;
                            console.log(`  📥 PDF 下载成功: ${(stats.size/1024).toFixed(0)}KB`);
                        } else {
                            fs.unlinkSync(pdfPath);
                            console.log(`  ⚠️ PDF 太小，已删除`);
                        }
                    } catch (e) {
                        console.log(`  ❌ PDF 下载失败: ${e.message}`);
                    }
                } else {
                    console.log(`  📄 PDF 已存在`);
                    pdfMap[paper.id].pdfPath = pdfPath;
                }
            }

            writeFileAtomic(PDF_MAP_FILE, JSON.stringify(pdfMap, null, 2));
        } else {
            console.log(`  ❌ 未找到匹配`);
        }
    }

    console.log(`\n=== 搜索完成 ===`);
    console.log(`找到: ${foundCount}/${papers.length}`);
    console.log(`下载: ${downloadedCount}`);
    console.log(`结果: ${PDF_MAP_FILE}`);
    console.log(`PDF目录: ${PDF_DIR}`);
}

main().catch(e => {
    console.error('错误:', e);
    process.exit(1);
});
