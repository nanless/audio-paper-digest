#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 更全面地搜索 ICML 2026 论文的 PDF（多策略）
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { readJsonSafe, writeFileAtomic } = require('./utils.js');

const FILTERED_FILE = path.join(__dirname, '..', 'data', 'current', 'icml_2026_filtered.json');
const PDF_MAP_FILE = path.join(__dirname, '..', 'data', 'current', 'icml_2026_pdf_map.json');
const PDF_DIR = path.join(__dirname, '..', 'data', 'pdfs', 'icml2026');

const data = readJsonSafe(FILTERED_FILE);
const existingMap = readJsonSafe(PDF_MAP_FILE, {});

// 待搜索的论文（排除已找到的）
const papers = data.papers.filter(p => !existingMap[p.id]);
console.log(`已找到: ${Object.keys(existingMap).length} 篇`);
console.log(`待搜索: ${papers.length} 篇\n`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 更robust的HTTP请求
async function fetchWithRetry(url, protocol = http, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await new Promise((resolve, reject) => {
                const req = protocol.get(url, { timeout: 30000 }, (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        const loc = res.headers.location;
                        const p = loc.startsWith('https') ? https : http;
                        return fetchWithRetry(loc, p, 1).then(resolve).catch(reject);
                    }
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                        return;
                    }
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve(data));
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

// 策略1: arXiv 完整标题搜索
async function searchArxivFullTitle(title) {
    const query = encodeURIComponent(title);
    const url = `http://export.arxiv.org/api/query?search_query=all:${query}&max_results=5&sortBy=relevance`;
    const xml = await fetchWithRetry(url, http);
    return parseArxivXml(xml);
}

// 策略2: arXiv 短关键词搜索（前4-5个词）
async function searchArxivShort(title) {
    const words = title.split(/\s+/).slice(0, 4).join(' ');
    const query = encodeURIComponent(words);
    const url = `http://export.arxiv.org/api/query?search_query=all:${query}&max_results=5&sortBy=relevance`;
    const xml = await fetchWithRetry(url, http);
    return parseArxivXml(xml);
}

// 策略3: arXiv 作者+关键词搜索
async function searchArxivAuthorKeyword(authors, title) {
    if (!authors || authors.length === 0) return [];
    const firstAuthor = authors[0].split(' ')[0];
    const keyword = title.split(/\s+/).slice(0, 3).join(' ');
    const query = encodeURIComponent(`au:${firstAuthor} AND ${keyword}`);
    const url = `http://export.arxiv.org/api/query?search_query=${query}&max_results=5&sortBy=relevance`;
    const xml = await fetchWithRetry(url, http);
    return parseArxivXml(xml);
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

// 策略4: Semantic Scholar 搜索
async function searchSemanticScholar(title) {
    const query = encodeURIComponent(title);
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${query}&fields=title,authors,year,externalIds,openAccessPdf&limit=5`;
    try {
        const data = await fetchWithRetry(url, https);
        return JSON.parse(data);
    } catch (e) {
        return { data: [] };
    }
}

// 策略5: Google Scholar 简单搜索（可能被拦截）
async function searchGoogleScholar(title) {
    const query = encodeURIComponent(title);
    const url = `https://scholar.google.com/scholar?q=${query}`;
    try {
        const html = await fetchWithRetry(url, https);
        // 提取 arXiv 链接
        const arxivMatches = html.matchAll(/arxiv\.org\/abs\/(\d+\.\d+)/g);
        return [...arxivMatches].map(m => m[1]);
    } catch (e) {
        return [];
    }
}

// 标题相似度
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

// 作者匹配度
function authorOverlap(authorsA, authorsB) {
    if (!authorsA || !authorsB) return 0;
    const a = new Set(authorsA.map(x => x.toLowerCase()));
    const b = new Set(authorsB.map(x => x.toLowerCase()));
    const intersection = [...a].filter(x => b.has(x));
    return intersection.length / Math.max(a.size, b.size);
}

// 下载 PDF
async function downloadPdf(arxivId, outputPath) {
    const url = `https://arxiv.org/pdf/${arxivId}.pdf`;
    return new Promise((resolve, reject) => {
        const doDownload = (downloadUrl) => {
            const protocol = downloadUrl.startsWith('https') ? https : http;
            protocol.get(downloadUrl, { timeout: 60000 }, (res) => {
                if (res.statusCode === 302 || res.statusCode === 301) {
                    let loc = res.headers.location;
                    if (loc && loc !== downloadUrl) {
                        // 处理相对重定向URL
                        if (loc.startsWith('/')) {
                            loc = 'https://arxiv.org' + loc;
                        }
                        return doDownload(loc);
                    }
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                const file = fs.createWriteStream(outputPath);
                res.pipe(file);
                file.on('finish', () => { file.close(); resolve(true); });
                file.on('error', reject);
            }).on('error', reject);
        };
        doDownload(url);
    });
}

async function main() {
    fs.mkdirSync(PDF_DIR, { recursive: true });
    let foundCount = 0;
    let downloadedCount = 0;

    for (let i = 0; i < papers.length; i++) {
        const paper = papers[i];
        const title = paper.title;
        const authors = paper.authors || [];

        console.log(`[${i+1}/${papers.length}] ${title.substring(0, 70)}...`);

        let bestMatch = null;
        let bestScore = 0;

        // 策略1: arXiv 完整标题
        try {
            await sleep(3500);
            const entries = await searchArxivFullTitle(title);
            for (const e of entries) {
                let sim = titleSimilarity(title, e.title);
                const auSim = authorOverlap(authors, e.authors);
                if (auSim > 0.3) sim += 0.15;
                if (sim > bestScore) {
                    bestScore = sim;
                    bestMatch = { source: 'arxiv-full', arxivId: e.arxivId, title: e.title, similarity: sim };
                }
            }
            if (entries.length > 0) {
                console.log(`  arXiv-full: ${entries.length} 结果, 最佳 ${bestScore.toFixed(2)}`);
            }
        } catch (e) {
            console.log(`  arXiv-full: ${e.message}`);
        }

        // 策略2: arXiv 短关键词
        if (bestScore < 0.6) {
            try {
                await sleep(3500);
                const entries = await searchArxivShort(title);
                for (const e of entries) {
                    let sim = titleSimilarity(title, e.title);
                    const auSim = authorOverlap(authors, e.authors);
                    if (auSim > 0.3) sim += 0.15;
                    if (sim > bestScore) {
                        bestScore = sim;
                        bestMatch = { source: 'arxiv-short', arxivId: e.arxivId, title: e.title, similarity: sim };
                    }
                }
                if (entries.length > 0) {
                    console.log(`  arXiv-short: ${entries.length} 结果, 最佳 ${bestScore.toFixed(2)}`);
                }
            } catch (e) {
                console.log(`  arXiv-short: ${e.message}`);
            }
        }

        // 策略3: arXiv 作者+关键词
        if (bestScore < 0.6 && authors.length > 0) {
            try {
                await sleep(3500);
                const entries = await searchArxivAuthorKeyword(authors, title);
                for (const e of entries) {
                    let sim = titleSimilarity(title, e.title);
                    const auSim = authorOverlap(authors, e.authors);
                    if (auSim > 0.3) sim += 0.15;
                    if (sim > bestScore) {
                        bestScore = sim;
                        bestMatch = { source: 'arxiv-author', arxivId: e.arxivId, title: e.title, similarity: sim };
                    }
                }
                if (entries.length > 0) {
                    console.log(`  arXiv-author: ${entries.length} 结果, 最佳 ${bestScore.toFixed(2)}`);
                }
            } catch (e) {
                console.log(`  arXiv-author: ${e.message}`);
            }
        }

        // 策略4: Semantic Scholar
        if (bestScore < 0.6) {
            try {
                await sleep(1000);
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
                    console.log(`  SS: ${ssResult.data.length} 结果, 最佳 ${bestScore.toFixed(2)}`);
                }
            } catch (e) {
                console.log(`  SS: ${e.message}`);
            }
        }

        // 策略5: Google Scholar
        if (bestScore < 0.6) {
            try {
                await sleep(2000);
                const arxivIds = await searchGoogleScholar(title);
                for (const id of arxivIds) {
                    // 需要获取标题来比较
                    const url = `http://export.arxiv.org/api/query?id_list=${id}&max_results=1`;
                    const xml = await fetchWithRetry(url, http, 2);
                    const entries = parseArxivXml(xml);
                    for (const e of entries) {
                        const sim = titleSimilarity(title, e.title);
                        if (sim > bestScore) {
                            bestScore = sim;
                            bestMatch = { source: 'google-scholar', arxivId: e.arxivId, title: e.title, similarity: sim };
                        }
                    }
                }
                if (arxivIds.length > 0) {
                    console.log(`  GS: ${arxivIds.length} arxiv链接, 最佳 ${bestScore.toFixed(2)}`);
                }
            } catch (e) {
                console.log(`  GS: ${e.message}`);
            }
        }

        // 保存结果
        if (bestMatch && bestScore >= 0.5) {
            existingMap[paper.id] = {
                ...bestMatch,
                icmlTitle: title,
                icmlId: paper.id
            };
            foundCount++;
            console.log(`  ✅ 找到匹配 (${bestScore.toFixed(2)}): ${bestMatch.title.substring(0, 60)}...`);

            // 下载 PDF
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
                        await downloadPdf(bestMatch.arxivId, pdfPath);
                        const stats = fs.statSync(pdfPath);
                        if (stats.size > 10000) {
                            existingMap[paper.id].pdfPath = pdfPath;
                            existingMap[paper.id].pdfSize = stats.size;
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
                    existingMap[paper.id].pdfPath = pdfPath;
                }
            }

            writeFileAtomic(PDF_MAP_FILE, JSON.stringify(existingMap, null, 2));
        } else {
            console.log(`  ❌ 未找到匹配 (最佳: ${bestScore.toFixed(2)})`);
        }
    }

    console.log(`\n=== 搜索完成 ===`);
    console.log(`本次新找到: ${foundCount}`);
    console.log(`总计找到: ${Object.keys(existingMap).length}/${data.papers.length}`);
    console.log(`本次新下载: ${downloadedCount}`);
    console.log(`结果: ${PDF_MAP_FILE}`);
}

main().catch(e => {
    console.error('错误:', e);
    process.exit(1);
});
