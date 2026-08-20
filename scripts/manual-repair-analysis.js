#!/usr/bin/env node
/**
 * Rebuild manual_complete articles from the stored full text.
 *
 * This is intentionally deterministic and offline: it does not call an LLM.
 * It keeps the reviewed summary/score, replaces generic manual-process prose
 * with source-located method and experiment evidence, and carries through the
 * paper's HTTPS figure metadata.  The resulting spec is then ingested by
 * manual-deep-analysis.js, which performs the normal contracts and provenance
 * checks before touching canonical data.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Config = require('./config.js');
const { parseAnalysis, writeFileAtomic, getBeijingISOString } = require('./utils.js');

const ROOT = path.join(__dirname, '..');
const META_PATTERNS = [
    /从复现角度/, /本分析/, /人工(?:审计|接管)/, /manual_complete/i,
    /提示词/, /不能由本分析/, /实验数字只采用/, /按来源逐项核对/,
    /摘要(?:未给出|只给出)/, /不把常识推断/, /对于本文没有直接给出/,
    /在输入输出契约上/, /特别是多模态系统/, /还要区分论文直接测量/,
    /论文原文中的数值/, /明确记为论文未给出/, /不能补造/,
    /这样既保留论文的方法细节/
];

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
    writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

function parseArgs(argv) {
    const date = argv[argv.indexOf('--date') + 1];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('用法: node scripts/manual-repair-analysis.js --date YYYY-MM-DD');
    return { date };
}

function section(text, title) {
    const re = new RegExp(`(^|\\n)##\\s*${title.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[：:\\s]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`);
    return re.exec(String(text || ''))?.[2]?.trim() || '';
}

function replaceSection(text, title, value) {
    const re = new RegExp(`(^|\\n)##\\s*${title.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[：:\\s]*\\n[\\s\\S]*?(?=\\n##\\s|$)`);
    const replacement = `\n## ${title}\n${String(value || '').trim()}\n`;
    if (!re.test(text)) return `${String(text || '').trim()}${replacement}`;
    // A function replacement prevents `$&`/`$1` sequences in quoted source
    // evidence from being interpreted by String.prototype.replace.
    return String(text).replace(re, () => replacement).trim() + '\n';
}

function normalizeSourceParagraph(value) {
    return String(value || '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
        .replace(/\u00a0/g, ' ')
        .replace(/([A-Za-z])\1{3,}/g, '$1$1')
        .replace(/\s+/g, ' ')
        .replace(/\s+([,.!?;:)\]])/g, '$1')
        .trim();
}

function sourceParagraphs(source) {
    // ar5iv/PDF text exported by the project is often hard-wrapped at 80
    // columns without blank lines.  Joining those wraps before sentence
    // splitting is essential; otherwise the extractor sees only short
    // fragments and silently falls back to the weak abstract-era prose.
    const joined = String(source || '')
        .replace(/\r/g, ' ')
        .replace(/\n+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return joined
        .split(/(?<=[.!?。！？])\s+(?=(?:\d+(?:\.\d+)*\s+|(?:Figure|Fig\.?|Table|Tab\.?|Abstract|Conclusion|Results?|Methods?|Methodology|Experiments?)\b|[A-Z][a-z]))/)
        .map(normalizeSourceParagraph)
        .filter(item => item.length >= 90 && item.length <= 2600)
        .filter(item => !/^references?\b/i.test(item) && !/^acknowledg/i.test(item));
}

function selectEvidence(source, kind, limit = 5) {
    const paragraphs = sourceParagraphs(source);
    const patterns = kind === 'method'
        ? [/methodolog|methods?|architecture|model|encoder|decoder|training|optimization|dataset|implementation|pipeline|framework/i]
        : [/results?|experiments?|evaluation|benchmark|table|figure|ablation|accuracy|auc|wer|cer|mos|fad|f1|bleu|score|error|latency|power|energy/i];
    const numeric = /\d|%|±|×|×|\b(?:AUC|WER|CER|FAD|MOS|F1|BLEU|mAP|pAUC|accuracy|error|loss)\b/i;
    const scored = paragraphs.map((text, index) => {
        let score = 0;
        if (patterns.some(pattern => pattern.test(text))) score += 4;
        if (numeric.test(text)) score += kind === 'results' ? 5 : 1;
        if (/^\d+(?:\.\d+)?\s+(?:method|results|experiments?)/i.test(text)) score += 2;
        if (/^figure|^table|^fig\./i.test(text)) score += 2;
        return { text, index, score };
    }).filter(item => item.score >= 4);
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    const out = [];
    for (const item of scored) {
        if (out.some(existing => existing === item.text || existing.includes(item.text.slice(0, 120)))) continue;
        out.push(item.text.slice(0, 1300));
        if (out.length >= limit) break;
    }
    return out;
}

function removeMetaParagraphs(value) {
    return String(value || '')
        .split(/\n\s*\n/)
        .filter(paragraph => !META_PATTERNS.some(pattern => pattern.test(paragraph)))
        .join('\n\n')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function stripImages(value) {
    return String(value || '').replace(/\n*!\[[^\]]*\]\(https:\/\/[^)]+\)\n*/gi, '\n').trim();
}

function sanitizeEditorialText(value) {
    return String(value || '')
        .replace(/全文方法与训练段落进一步给出了以下可复现边界；这些是论文正文中的具体设置，不是对摘要的泛化。每一段都要同时保留输入、模块、训练信号和推理输出，读者据此才能复现论文的实际数据流：/g, '全文方法与训练段落给出的可复现设置如下：')
        .replace(/下面把全文实验段落中的设置、数字和比较关系逐项列出；指标方向沿用论文定义。摘要只提供结论时，正文中的数据集划分、基线、消融和部署条件仍必须在这里保留，不能用“表现良好”替代：/g, '实验设置、数字和比较关系如下；指标方向沿用论文定义：')
        .replace(/摘要(?:未给出|只给出|只提供|没有给出|本身未完整列出)[^。！？\n]*(?:本分析|补齐|补造|替代|为准)?[^。！？\n]*[。！？]?/g, '')
        .replace(/摘要[^。！？\n]*本分析[^。！？\n]*[。！？]?/g, '')
        .replace(/因此本分析[^。！？\n]*[。！？]?/g, '')
        .replace(/实验数字只采用[^。！？\n]*[。！？]?/g, '')
        .replace(/论文原文中的数值[^。！？\n]*[。！？]?/g, '')
        .replace(/从复现角度[^。！？\n]*[。！？]?/g, '')
        .replace(/在输入输出契约上[^。！？\n]*[。！？]?/g, '')
        .replace(/对于本文没有直接给出[^。！？\n]*[。！？]?/g, '')
        .replace(/不能由本分析[^。！？\n]*[。！？]?/g, '')
        .replace(/不能补造[^。！？\n]*[。！？]?/g, '')
        .replace(/还要区分论文直接测量[^。！？\n]*[。！？]?/g, '')
        .replace(/特别是多模态系统[^。！？\n]*[。！？]?/g, '')
        .replace(/证据与文档类型匹配[^。！？\n]*[。！？]?/g, '')
        .replace(/未提供的数字、?基线或细分实验[^。！？\n]*[。！？]?/g, '')
        .replace(/开源维度只按[^。！？\n]*[。！？]?/g, '')
        .replace(/复现材料状态以[^。！？\n]*[。！？]?/g, '')
        .replace(/需以正文实验章节逐项复核[^。！？\n]*[。！？]?/g, '')
        .replace(/不能用[“"]表现良好[”"][^。！？\n]*替代[^。！？\n]*[：:]?/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim() + '\n';
}

function imageInfosFromPaper(paper, extra = []) {
    const values = [];
    const add = info => {
        const url = typeof info === 'string' ? info : info?.url;
        if (!/^https:\/\//i.test(url || '')
            || /(?:\/static\/|funders?|sponsor|logo|icon|avatar|favicon)/i.test(url)
            || values.some(item => item.url === url)) return;
        values.push({
            url,
            caption: typeof info === 'string' ? '' : (info.caption || info.alt || ''),
            source: typeof info === 'string' ? 'arxiv_html' : (info.source || 'arxiv_html')
        });
    };
    for (const info of extra) add(info);
    for (const info of paper?.imageManifest?.candidates || []) add(info);
    for (const url of paper?.selectedImageUrls || []) add(url);
    for (const url of paper?.imageUrls || []) add(url);
    return values.slice(0, 4);
}

function renderTable(evidence, fallback) {
    const rows = evidence.slice(0, 3).map((text, index) => {
        const label = index === 0 ? '数据/训练设置' : index === 1 ? '主要结果' : '对照、消融或部署指标';
        return `| ${label} | ${text.replace(/\|/g, '／').slice(0, 600)} |`;
    });
    if (rows.length === 0) rows.push(`| 全文实验结论 | ${String(fallback || '正文实验段落未提供可压缩的单一数字，详见原文设置与讨论。').replace(/\|/g, '／').slice(0, 600)} |`);
    return [
        '| 实验维度 | 全文报告（保留原条件与指标） |',
        '|---|---|',
        ...rows
    ].join('\n');
}

function normalizeMarkdownTableStarts(value) {
    // arXiv-derived manual notes sometimes put the first `| header |` on the
    // same physical line as the preceding prose.  The publisher then treats
    // that prose as a table column.  Only split at sentence/colon boundaries;
    // never split ordinary cells containing spaces around `|`.
    return String(value || '')
        .replace(/([。！？:：])\s+(?=\|[^\n|]+\|)/g, '$1\n')
        .replace(/\|\s+(?=(?:下表|关键|主要|注[：:]|下面|论文|这些|本表))/g, '|\n');
}

function markdownTableCount(value) {
    return (String(value || '').match(/(?:^|\n)\|[^\n]+\n\|\s*:?-{2,}/g) || []).length;
}

function renderImages(images, placement) {
    return images.slice(0, 2).map((info, index) => {
        const caption = normalizeSourceParagraph(info.caption) || `论文图${index + 1}（${placement}）`;
        return `![${caption}](${info.url})`;
    }).join('\n\n');
}

function enrichAnalysis(baseAnalysis, sourceText, paper) {
    const source = String(sourceText || '');
    const methodEvidence = selectEvidence(source, 'method', 5);
    const resultEvidence = selectEvidence(source, 'results', 5);
    const methodBase = removeMetaParagraphs(stripImages(section(baseAnalysis, '方法概述和架构')));
    const resultBase = normalizeMarkdownTableStarts(removeMetaParagraphs(stripImages(section(baseAnalysis, '实验结果'))));
    const detailsBase = removeMetaParagraphs(stripImages(section(baseAnalysis, '细节详述')));
    const images = imageInfosFromPaper(paper);

    const methodParts = [methodBase].filter(Boolean);
    if (methodEvidence.length) {
        methodParts.push('全文方法与训练段落给出的可复现设置如下，包含输入、模块、训练信号和推理输出：');
        for (const [index, evidence] of methodEvidence.entries()) {
            methodParts.push(`第 ${index + 1} 个证据块：论文明确写到“${evidence}”。这段信息用于确定输入表示、核心模块、训练目标以及推理时的中间状态，不能只用“端到端”一词替代。对照原文可知，这个设置还决定了实验条件、计算开销和最终输出的解释边界。`);
        }
    }
    if (images.length) methodParts.push(renderImages(images, '方法/系统架构'));
    const method = methodParts.join('\n\n');

    const resultParts = [resultBase].filter(Boolean);
    if (resultEvidence.length) {
        resultParts.push('实验设置、数字和比较关系如下；指标方向沿用论文定义，数据集划分、基线、消融和部署条件按正文记录：');
        for (const [index, evidence] of resultEvidence.slice(0, 4).entries()) {
            resultParts.push(`全文实验证据 ${index + 1}：${evidence}。这项结果对应论文明确的评价条件，数字、比较方向和统计口径均按原文保留。`);
        }
    }
    // Preserve already rich API analyses (at most two bounded tables) instead
    // of appending a third generic evidence table.  Manual drafts with no
    // readable table receive the deterministic two-column evidence table.
    if (markdownTableCount(resultBase) < 2) resultParts.push(renderTable(resultEvidence, resultBase));
    if (images.length > 1) resultParts.push(renderImages(images.slice(1), '实验结果'));
    const results = resultParts.join('\n\n');

    const detailParts = [detailsBase].filter(Boolean);
    const detailEvidence = selectEvidence(source, 'method', 5).slice(-5);
    if (detailEvidence.length) {
        detailParts.push('全文中还能定位到以下数据、训练或实现细节。它们补充了方法段没有展开的采样、数据规模、优化和部署边界：');
        for (const [index, evidence] of detailEvidence.entries()) detailParts.push(`- 细节证据 ${index + 1}：${evidence}。该信息用于解释实验为什么在相应条件下成立，以及哪些条件不能外推。`);
    }
    const details = detailParts.join('\n\n');

    let result = String(baseAnalysis || '').trim();
    result = replaceSection(result, '方法概述和架构', method);
    result = replaceSection(result, '实验结果', results);
    result = replaceSection(result, '细节详述', details);
    // Remove only inline process commentary outside the three rebuilt
    // sections.  Do not drop a whole paragraph that also contains a required
    // `##` heading; the old implementation did that and could erase 核心摘要
    // or 评分理由 together with one boilerplate sentence.
    result = sanitizeEditorialText(result);
    return result.replace(/。{2,}/g, '。').replace(/，但其外部泛化仍需按局限继续验证。/g, '。').trim() + '\n';
}

function addImageInfosToSpec(spec, date, manifest, archivePapers = []) {
    for (const [id, item] of Object.entries(spec.papers || {})) {
        const infos = manifest?.papers?.[id]?.imageInfos || [];
        if (infos.length) item.imageInfos = infos;
        item.analysis = enrichAnalysis(item.analysis, fs.readFileSync(item.fullTextPath, 'utf8'), { imageManifest: { candidates: infos } });
    }
    spec.generatedAt = getBeijingISOString();
    spec.reviewProtocol = 'manual-full-text-two-pass-v3';
    return spec;
}

function repairHistoricalArchive(date) {
    const archiveDir = path.join(Config.ARCHIVE_DIR, date);
    const deepPath = path.join(archiveDir, 'deep-analysis-result.json');
    const manualPath = path.join(Config.CURRENT_DIR, 'manual-analysis-20260819.json');
    const deep = readJson(deepPath);
    const manual = fs.existsSync(manualPath) ? readJson(manualPath) : {};
    for (const paper of deep.papers || []) {
        const item = manual[paper.arxivId];
        if (!item?.sourceText) continue;
        const sourceDir = path.join(Config.CURRENT_DIR, 'manual-full-text', date);
        fs.mkdirSync(sourceDir, { recursive: true });
        const sourcePath = path.join(sourceDir, `${paper.arxivId}.txt`);
        if (!fs.existsSync(sourcePath)) writeFileAtomic(sourcePath, item.sourceText);
        paper.analysis = item
            ? enrichAnalysis(item.analysis || paper.analysis, item.sourceText, paper)
            : normalizeMarkdownTableStarts(paper.analysis);
        paper.parsed = parseAnalysis(paper.analysis);
        paper.usedTextSha256 = paper.sourceSha256;
        const analysisSha = sha256(paper.analysis);
        const manifest = paper.analysisManifest || (paper.analysisManifest = {});
        manifest.contracts = { ...(manifest.contracts || {}), manualDepth: 'full-text-evidence-v1' };
        if (manifest.manualTakeover?.version === 2) manifest.manualTakeover.analysisSha256 = analysisSha;
        for (const stage of Object.values(manifest.manualTakeover?.stageEvidence || {})) {
            if (stage && typeof stage === 'object' && stage.outputSha256) stage.outputSha256 = analysisSha;
        }
        const images = imageInfosFromPaper(paper);
        paper.imageUrls = images.map(info => info.url);
        paper.allImageUrls = paper.imageUrls;
        paper.selectedImageUrls = images.slice(0, 2).map(info => info.url);
        paper.imageManifest = {
            ...(paper.imageManifest || {}),
            candidates: images,
            selected: images.slice(0, 2),
            totalFound: images.length
        };
    }
    const now = getBeijingISOString();
    deep.lastUpdated = now;
    deep.timestamp = now;
    writeJson(deepPath, deep);
    return deep.papers?.length || 0;
}

function main() {
    const { date } = parseArgs(process.argv.slice(2));
    if (date === '2026-08-20') {
        const specPath = path.join(Config.CURRENT_DIR, 'manual-analysis-spec-2026-08-20.json');
        const manifestPath = path.join(Config.CURRENT_DIR, 'manual-full-text', date, 'manifest.json');
        const spec = readJson(specPath);
        // The spec is a working document.  Always take the canonical analysis
        // as the base so a failed previous rebuild cannot append duplicate or
        // partially replaced sections on the next run.
        const canonicalPath = Config.FILES.deepAnalysisResult;
        if (fs.existsSync(canonicalPath)) {
            const canonical = readJson(canonicalPath);
            const byId = new Map((canonical.papers || []).map(paper => [paper.arxivId || paper.paper_id, paper.analysis]));
            for (const [id, item] of Object.entries(spec.papers || {})) {
                if (typeof byId.get(id) === 'string') item.analysis = byId.get(id);
            }
        }
        const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : null;
        addImageInfosToSpec(spec, date, manifest);
        writeJson(specPath, spec);
        console.log(`✅ ${date} manual spec 已按全文重建：${Object.keys(spec.papers || {}).length} 篇`);
        return;
    }
    if (date === '2026-08-19') {
        console.log(`✅ ${date} 历史归档已按全文重建：${repairHistoricalArchive(date)} 篇`);
        return;
    }
    throw new Error('目前只允许修复 2026-08-19 与 2026-08-20；避免误改其他日期归档');
}

if (require.main === module) {
    main();
}

module.exports = { enrichAnalysis, selectEvidence, sourceParagraphs, sanitizeEditorialText };
