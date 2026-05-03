#!/usr/bin/env node
/**
 * 博文图文一致性自动校验器
 *
 * 用法：
 *   node scripts/verify-blog-images.js <md_file> [<md_file> ...]
 *   node scripts/verify-blog-images.js content/posts/2026-05-04-*.md   # shell 展开
 *
 * 选项：
 *   --apply              真正写回 .md（默认开启）
 *   --dry-run            只打印 verdict，不改文件
 *   --concurrency N      并发处理 N 篇博文 (默认 4)
 *   --log <path>         日志文件 (默认 /tmp/iclr_fix/verify-results.tsv)
 *   --max-images N       单篇博文校验图片上限 (默认 12)
 *
 * 流程：
 *   1) 调用 python3 scripts/inspect-blog-images.py <md> --json 拿到 image manifest
 *   2) 跳过无图博文
 *   3) 对每张图读取 local_path 转 base64
 *   4) 把所有图 + 元信息 + prompt 合成单条多模态 user message，调用 PAPER_ANALYZER_*
 *   5) 解析 JSON verdicts；逐条应用：REWRITE 改 alt，DELETE 删图行
 *   6) 落 /tmp/iclr_fix/verify-results.tsv 日志
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFileSync } = require('child_process');

const {
    loadEnvFile,
    detectApiType,
    buildApiUrl,
    buildRequestBody,
    buildHeaders,
    parseResponseText,
    loadPrompt,
    writeFileAtomic,
} = require('./utils.js');

loadEnvFile();

const DEEP_CONFIG = {
    endpoint: process.env.PAPER_ANALYZER_ENDPOINT || '',
    key: process.env.PAPER_ANALYZER_API_KEY || '',
    model: process.env.PAPER_ANALYZER_MODEL || '',
};
for (const [k, v] of Object.entries(DEEP_CONFIG)) {
    if (!v) {
        console.error(`[verify] 缺少环境变量 PAPER_ANALYZER_${k.toUpperCase()}`);
        process.exit(1);
    }
}

const SCRIPT_DIR = __dirname;
const INSPECT_SCRIPT = path.join(SCRIPT_DIR, 'inspect-blog-images.py');
const PROMPT_REL = 'prompts/verify-blog-images.md';

const API_OVERALL_TIMEOUT_MS = 600000;
const API_TEMPERATURE = 0.0;
const MAX_TOKENS = 4096;
const RETRY_BASE_DELAY_MS = 2000;
const MAX_RETRIES = 3;

function parseArgs(argv) {
    const args = {
        files: [],
        apply: true,
        concurrency: 4,
        logPath: '/tmp/iclr_fix/verify-results.tsv',
        maxImages: 12,
    };
    let i = 2;
    while (i < argv.length) {
        const a = argv[i];
        if (a === '--apply') {
            args.apply = true;
        } else if (a === '--dry-run') {
            args.apply = false;
        } else if (a === '--concurrency' && i + 1 < argv.length) {
            args.concurrency = parseInt(argv[++i], 10) || 4;
        } else if (a === '--log' && i + 1 < argv.length) {
            args.logPath = argv[++i];
        } else if (a === '--max-images' && i + 1 < argv.length) {
            args.maxImages = parseInt(argv[++i], 10) || 12;
        } else if (!a.startsWith('--')) {
            args.files.push(a);
        }
        i++;
    }
    args.files = Array.from(new Set(args.files));
    return args;
}

function inspectMd(mdPath) {
    const out = execFileSync('python3', [INSPECT_SCRIPT, mdPath, '--json'], {
        env: process.env,
        maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(out.toString('utf-8'));
}

function imageToBase64Block(localPath) {
    const buf = fs.readFileSync(localPath);
    const ext = path.extname(localPath).toLowerCase();
    const mime = (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'image/png';
    return {
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${buf.toString('base64')}` },
    };
}

function buildPrompt(report, maxImages) {
    const images = (report.images || []).slice(0, maxImages);
    const blocks = images.map((img, idx) => {
        const before = (img.context_before || []).map(([ln, t]) => `      L${ln}: ${t}`).join('\n');
        const after = (img.context_after || []).map(([ln, t]) => `      L${ln}: ${t}`).join('\n');
        const sec = `${'#'.repeat(img.section_level || 2)} ${img.section || '(无)'}`;
        return `[IMG_${idx + 1}] line=${img.line} section=${JSON.stringify(sec)} alt=${JSON.stringify(img.alt)}\n  上下文(前):\n${before || '      (无)'}\n  上下文(后):\n${after || '      (无)'}`;
    }).join('\n\n');

    const promptText = loadPrompt(PROMPT_REL, {
        title: report.title || '(未知)',
        paper_id: report.paper_id || '(未知)',
        section_summary: report.images && report.images[0] ? report.images[0].section : '',
        image_blocks: blocks,
    });

    return { promptText, images };
}

function callModelOnce(messages) {
    const apiType = detectApiType(DEEP_CONFIG.endpoint, DEEP_CONFIG.model);
    const modelUrl = buildApiUrl(apiType, DEEP_CONFIG.endpoint);
    const url = new URL(modelUrl);
    const bodyObj = buildRequestBody(apiType, DEEP_CONFIG.model, messages, MAX_TOKENS, API_TEMPERATURE);
    const postData = JSON.stringify(bodyObj);
    const headers = buildHeaders(apiType, DEEP_CONFIG.key, postData);

    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), API_OVERALL_TIMEOUT_MS);
        const req = https.request({
            hostname: url.hostname,
            path: url.pathname + (url.search || ''),
            port: url.port || 443,
            method: 'POST',
            headers,
            agent: false,
            signal: controller.signal,
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                clearTimeout(timeoutId);
                try {
                    const response = JSON.parse(data);
                    const content = parseResponseText(apiType, response);
                    if (content !== null) return resolve(content);
                    if (response.error) return reject(new Error(response.error.message || JSON.stringify(response.error)));
                    return reject(new Error('Invalid response: ' + data.substring(0, 200)));
                } catch (e) {
                    reject(new Error('Parse error: ' + e.message + ' | body: ' + data.substring(0, 300)));
                }
            });
        });
        req.on('error', (e) => { clearTimeout(timeoutId); reject(e); });
        req.on('timeout', () => { clearTimeout(timeoutId); req.destroy(); reject(new Error('Request timeout')); });
        req.write(postData);
        req.end();
    });
}

async function callModel(messages) {
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await callModelOnce(messages);
        } catch (e) {
            lastErr = e;
            if (attempt < MAX_RETRIES) {
                const delay = Math.pow(2, attempt) * RETRY_BASE_DELAY_MS;
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }
    throw new Error(`callModel failed after ${MAX_RETRIES} retries: ${lastErr.message}`);
}

function extractJson(text) {
    if (!text) return null;
    let s = text.trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    const candidate = s.substring(start, end + 1);
    try {
        return JSON.parse(candidate);
    } catch (_) {
        return null;
    }
}

function applyVerdicts(mdPath, report, verdicts) {
    const lines = fs.readFileSync(mdPath, 'utf-8').split('\n');
    const stats = { kept: 0, modified: 0, deleted: 0, skipped: 0 };
    const verdictByLine = new Map();
    const images = report.images || [];
    for (const v of verdicts) {
        const idx = (v.i || 0) - 1;
        if (idx < 0 || idx >= images.length) { stats.skipped++; continue; }
        const img = images[idx];
        verdictByLine.set(img.line - 1, v);
    }

    const linesToDelete = new Set();
    for (const [lineIdx, v] of verdictByLine) {
        if (v.verdict === 'PASS') {
            stats.kept++;
        } else if (v.verdict === 'REWRITE' && v.new_alt) {
            const m = lines[lineIdx].match(/^(\s*)!\[(.*?)\]\((.+?)\)\s*$/);
            if (m) {
                const cleanAlt = String(v.new_alt).replace(/[\[\]\(\)\n\r]/g, '').trim().slice(0, 60);
                lines[lineIdx] = `${m[1]}![${cleanAlt}](${m[3]})`;
                stats.modified++;
            } else {
                stats.skipped++;
            }
        } else if (v.verdict === 'DELETE') {
            linesToDelete.add(lineIdx);
            stats.deleted++;
        } else {
            stats.skipped++;
        }
    }

    if (linesToDelete.size > 0) {
        // 对每个被删的图，向下扫描看紧邻是否有 figure 题注段，一并删除
        const captionRe = /^(?:\s*)(?:图\s*\d+|Figure\s*\d+|Fig\.?\s*\d+)/i;
        for (const li of [...linesToDelete]) {
            let j = li + 1;
            while (j < lines.length && !lines[j].trim()) j++;
            if (j < lines.length && captionRe.test(lines[j])) {
                let k = j;
                while (k < lines.length && lines[k].trim()) {
                    linesToDelete.add(k);
                    k++;
                }
            }
        }
        const collapseAdjacentBlanks = new Set();
        for (const li of linesToDelete) {
            if (li - 1 >= 0 && !lines[li - 1].trim()) collapseAdjacentBlanks.add(li - 1);
            if (li + 1 < lines.length && !lines[li + 1].trim()) collapseAdjacentBlanks.add(li + 1);
        }
        const allDel = new Set([...linesToDelete]);
        for (const blankIdx of collapseAdjacentBlanks) {
            const prev = blankIdx - 1;
            const next = blankIdx + 1;
            const prevDel = prev >= 0 && allDel.has(prev);
            const nextDel = next < lines.length && allDel.has(next);
            if (prevDel && nextDel) allDel.add(blankIdx);
        }
        const newLines = lines.filter((_, i) => !allDel.has(i));
        return { newContent: newLines.join('\n'), stats };
    }
    return { newContent: lines.join('\n'), stats };
}

async function processOne(mdPath, options) {
    const result = {
        md: mdPath,
        paper_id: '',
        verdict: 'PASS',
        kept: 0,
        modified: 0,
        deleted: 0,
        message: '',
    };
    try {
        const report = inspectMd(mdPath);
        result.paper_id = report.paper_id || '';
        const images = report.images || [];
        if (images.length === 0) {
            result.verdict = 'PASS';
            result.message = 'no_images';
            return result;
        }
        const usable = images.slice(0, options.maxImages).filter((img) => img.local_exists);
        if (usable.length === 0) {
            result.verdict = 'PASS';
            result.message = 'no_local_images';
            return result;
        }
        const { promptText } = buildPrompt(report, options.maxImages);
        const content = [{ type: 'text', text: promptText }];
        for (const img of usable) {
            try {
                content.push(imageToBase64Block(img.local_path));
            } catch (e) {
                result.message += `image_read_fail:${img.local_path}; `;
            }
        }

        const messages = [{ role: 'user', content }];
        const reply = await callModel(messages);
        const parsed = extractJson(reply);
        if (!parsed || !Array.isArray(parsed.verdicts)) {
            result.verdict = 'FAIL';
            result.message = 'json_parse_fail; head=' + (reply || '').slice(0, 200);
            return result;
        }

        if (options.apply) {
            const { newContent, stats } = applyVerdicts(mdPath, report, parsed.verdicts);
            writeFileAtomic(mdPath, newContent);
            result.kept = stats.kept;
            result.modified = stats.modified;
            result.deleted = stats.deleted;
            result.verdict = (stats.modified > 0 || stats.deleted > 0) ? 'FIXED' : 'PASS';
            result.message = parsed.verdicts.map((v) => `${v.i}:${v.verdict}`).join(',');
        } else {
            const summary = parsed.verdicts.map((v) => `${v.i}:${v.verdict}${v.new_alt ? '(' + v.new_alt.slice(0, 30) + ')' : ''}`).join(' | ');
            result.verdict = 'DRY_RUN';
            result.message = summary;
        }
        return result;
    } catch (e) {
        result.verdict = 'FAIL';
        result.message = 'exception:' + e.message;
        return result;
    }
}

async function runWithConcurrency(items, n, fn) {
    const results = [];
    let cursor = 0;
    const workers = [];
    for (let w = 0; w < n; w++) {
        workers.push((async () => {
            while (true) {
                const idx = cursor++;
                if (idx >= items.length) break;
                results[idx] = await fn(items[idx], idx);
            }
        })());
    }
    await Promise.all(workers);
    return results;
}

function appendLog(logPath, row) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, row + '\n');
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.files.length === 0) {
        console.error('Usage: node verify-blog-images.js <md_file> [...]  or  --glob "<pattern>"');
        process.exit(1);
    }
    console.log(`[verify] files=${args.files.length} concurrency=${args.concurrency} apply=${args.apply} log=${args.logPath}`);

    let done = 0;
    const total = args.files.length;
    const results = await runWithConcurrency(args.files, args.concurrency, async (mdPath) => {
        const r = await processOne(mdPath, { apply: args.apply, maxImages: args.maxImages });
        done++;
        const tag = r.verdict === 'PASS' ? '✓' : r.verdict === 'FIXED' ? '🔧' : r.verdict === 'FAIL' ? '✗' : '·';
        console.log(`[${done}/${total}] ${tag} ${r.verdict} ${path.basename(mdPath)} kept=${r.kept} mod=${r.modified} del=${r.deleted} ${r.message ? '| ' + r.message.slice(0, 120) : ''}`);
        const logRow = [path.basename(mdPath), r.paper_id, r.kept, r.modified, r.deleted, r.verdict, r.message.replace(/\t/g, ' ').replace(/\n/g, ' ')].join('\t');
        appendLog(args.logPath, logRow);
        return r;
    });

    const counts = results.reduce((acc, r) => {
        acc[r.verdict] = (acc[r.verdict] || 0) + 1;
        return acc;
    }, {});
    console.log('\n[verify] 汇总:');
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
    console.log(`[verify] 日志: ${args.logPath}`);

    const failCount = counts.FAIL || 0;
    process.exit(failCount > 0 ? 2 : 0);
}

main().catch((e) => {
    console.error('[verify] fatal:', e);
    process.exit(1);
});
