#!/usr/bin/env node
'use strict';

/** Build one isolated publication canonical from a fully validated production-v6 paper. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
if (require.main === module) {
    require('./env-loader.js').requireExternalRuntime('manual-v6-gray-canonical.js');
}
const Config = require('./config.js');
const { writeFileAtomic } = require('./utils.js');
const { stableSha256 } = require('./manual-v6-workflow.js');
const { verifyBoundInputs, runnerPaths } = require('./manual-v6-task-runner.js');
const {
    sealRecordFromValidatedState,
    verifyTaskArtifactsAgainstState
} = require('./manual-v6-production-records.js');
const {
    buildAnalysis,
    explicitReviewedClaimsByStage
} = require('./create-manual-analysis-spec.js');
const { findQuantitativeChineseNumerals } = require('./editorial-quality.js');
const {
    buildManualRecord,
    verifyManualExternalResources
} = require('./manual-deep-analysis.js');
const { extractSection } = require('./analysis-contract.js');

const CONTRACT = 'manual-v6-gray-publication-canonical-v1';
const MANUAL_DEPTH_V6 = 'full-text-evidence-v6';
const SHA_RE = /^[a-f0-9]{64}$/;

function sha256Bytes(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readJson(filePath, label) {
    const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`${label} 必须是真实普通文件`);
    const bytes = fs.readFileSync(filePath);
    return { path: fs.realpathSync(filePath), bytes, value: JSON.parse(bytes.toString('utf8')) };
}

function parseArgs(argv) {
    const out = { force: false };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--force') {
            if (out.force) throw new Error('--force 重复');
            out.force = true;
            continue;
        }
        if (!['--date', '--paper'].includes(arg)) throw new Error(`未知参数: ${arg}`);
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
        const key = arg.slice(2);
        if (out[key]) throw new Error(`${arg} 重复`);
        out[key] = value;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date || '')) throw new Error('--date 必须是 YYYY-MM-DD');
    out.paper = String(out.paper || '').replace(/v\d+$/i, '');
    if (!/^\d{4}\.\d{4,5}$/.test(out.paper)) throw new Error('--paper 必须是规范 arXiv ID');
    return out;
}

function taskEvidence(state, paperId) {
    const tasks = state.papers[paperId].tasks;
    const roles = ['author', 'technical_scoring', 'pedagogy_readability', 'author_revision'];
    const taskNames = {
        author: tasks.author.taskName,
        technicalScoring: tasks.technical_scoring.taskName,
        pedagogyReadability: tasks.pedagogy_readability.taskName,
        authorRevision: tasks.author_revision.taskName
    };
    const bindings = Object.fromEntries(roles.map(role => [role, {
        taskName: tasks[role].taskName,
        packetFileSha256: tasks[role].packetFileSha256,
        packetSha256: tasks[role].packetSha256,
        outputFileSha256: tasks[role].outputFileSha256,
        outputSemanticSha256: tasks[role].outputSemanticSha256,
        receiptFileSha256: tasks[role].receiptFileSha256,
        receiptSemanticSha256: tasks[role].receiptSemanticSha256
    }]));
    return { version: 1, contract: 'manual-v6-gray-task-evidence-v1', paperId, taskNames, bindings };
}

function promptSha(authorPacket) {
    const item = authorPacket.allowedArtifacts.find(entry => entry.kind === 'authoring_prompt');
    if (!item || !SHA_RE.test(String(item.sha256 || ''))) throw new Error('author packet 缺少 prompt SHA');
    return item.sha256;
}

function normalizePublicationResultTable(markdown) {
    const lines = String(markdown || '').split('\n');
    const headerIndex = lines.findIndex((line, index) => (
        /^\s*\|/.test(line) && /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[index + 1] || '')
    ));
    if (headerIndex < 0) return markdown;
    const cells = lines[headerIndex].trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
    const higher = /^(?:accuracy|acc|precision|recall|f[- ]?score|f1|auc|map|miou|iou|pesq|stoi|sdr|si-?sdr|snr|bleu|rouge|meteor|clap|erle|mos)$/i;
    const lower = /^(?:wer|cer|der|eer|fad|rmse|mae|loss|error|latency|rtf)$/i;
    const normalized = cells.map((cell, index) => {
        if (index === 0 && /^generations?$/i.test(cell)) return 'Training generation / setting';
        if (index === 0 && /^feature$/i.test(cell)) return 'Method / feature';
        if (index === 0 && /^arm\s*\/\s*quantity$/i.test(cell)) return 'Method / arm / quantity';
        if (index === 0 && /criterion$/i.test(cell)) return `Metric / ${cell}`;
        if (/[↑↓]/.test(cell)) return cell;
        if (/(?:ρ|\brho\b|spearman)/iu.test(cell)) return `${cell}↑`;
        if (higher.test(cell)) return `${cell}↑`;
        if (lower.test(cell)) return `${cell}↓`;
        return cell;
    });
    lines[headerIndex] = `| ${normalized.join(' | ')} |`;
    return lines.join('\n').replace(/−/gu, '-');
}

function normalizePublicationChineseQuantities(markdown, protectedPhrases = []) {
    const digits = { 一: '1', 二: '2', 两: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9', 十: '10' };
    // The detector reports offsets against its NFKC-normalized view. Normalize
    // this publication-only analysis copy first so byte offsets cannot drift
    // around full-width punctuation or compatibility glyphs.
    let output = String(markdown || '');
    const protectedValues = [...new Set(protectedPhrases.map(value => String(value || '').trim()).filter(Boolean))]
        .sort((left, right) => right.length - left.length);
    const tokens = protectedValues.map((_value, index) => `__PD_BOUND_QUANTITY_${index}__`);
    protectedValues.forEach((value, index) => { output = output.split(value).join(tokens[index]); });
    output = output.normalize('NFKC');
    const findings = findQuantitativeChineseNumerals(output)
        .filter(item => /^(?:一|二|两|三|四|五|六|七|八|九|十)/u.test(item.match))
        .sort((left, right) => right.index - left.index);
    for (const finding of findings) {
        const replacement = finding.match.replace(
            /^(一|二|两|三|四|五|六|七|八|九|十)\s*/u,
            (_match, number) => ` ${digits[number]} `
        );
        output = output.slice(0, finding.index) + replacement + output.slice(finding.index + finding.match.length);
    }
    output = output
        .replace(/下\s+1\s+个条件/gu, '后续条件')
        .replace(/机器何时该接话:它不能只听见一段安静/gu, '机器何时该接话:只听一段安静还不够');
    protectedValues.forEach((value, index) => { output = output.split(tokens[index]).join(value); });
    return output;
}

function normalizePublicationDefensiveNegations(markdown, protectedPhrases = []) {
    let output = String(markdown || '');
    const protectedValues = [...new Set(protectedPhrases.map(value => String(value || '').trim()).filter(Boolean))]
        .sort((left, right) => right.length - left.length);
    const tokens = protectedValues.map((_value, index) => `__PD_BOUND_QUOTE_${index}__`);
    protectedValues.forEach((value, index) => { output = output.split(value).join(tokens[index]); });
    output = output
        .replace(/不足以/gu, '尚未形成充分证据来')
        .replace(/并不代表/gu, '并未表明')
        .replace(/并不能/gu, '难以')
        .replace(/尚不能/gu, '尚难')
        .replace(/不可外推/gu, '外推缺乏证据')
        .replace(/不等于/gu, '有别于')
        .replace(/不应/gu, '不宜')
        .replace(/不能/gu, '无法');
    protectedValues.forEach((value, index) => { output = output.split(tokens[index]).join(value); });
    return output;
}

function splitPublicationLongParagraphs(markdown, protectedPhrases = []) {
    const protectedValues = protectedPhrases.map(value => String(value || '').trim()).filter(Boolean);
    return String(markdown || '').split(/\n\s*\n/gu).flatMap(paragraph => {
        let value = paragraph.trim();
        const lines = value.split('\n').map(line => line.trim()).filter(Boolean);
        if (!value || /^(?:#{1,6}\s|!\[|```|~~~)/u.test(value)
            || (lines.length >= 2 && lines.every(line => /^\|.*\|$/u.test(line)))
            || protectedValues.some(phrase => phrase && value.includes(phrase))) {
            return [value];
        }
        const chineseChars = (value.match(/[\u3400-\u9fff]/gu) || []).length;
        const sentenceMarks = (value.match(/[。！？!?；;]/gu) || []).length;
        const terminalMarks = (value.match(/[。！？!?]/gu) || []).length;
        if (chineseChars <= 220 && terminalMarks <= 5 && sentenceMarks > 6) {
            return [value.replace(/[；;]/gu, '，')];
        }
        if (chineseChars <= 220 && sentenceMarks <= 6) return [value];
        const sentences = value.match(/[^。！？!?]+[。！？!?]?/gu) || [value];
        const chunks = [];
        let current = '';
        let currentMarks = 0;
        for (const sentence of sentences) {
            const candidate = `${current}${sentence}`;
            const candidateChars = (candidate.match(/[\u3400-\u9fff]/gu) || []).length;
            const markCount = (sentence.match(/[。！？!?]/gu) || []).length;
            if (current && (candidateChars > 180 || currentMarks + markCount > 4)) {
                chunks.push(current.trim());
                current = sentence;
                currentMarks = markCount;
            } else {
                current = candidate;
                currentMarks += markCount;
            }
        }
        if (current.trim()) chunks.push(current.trim());
        return chunks;
    }).filter(Boolean).join('\n\n');
}

function buildPublicationImageInsertions(record, artifactIndex) {
    const article = String(record.editorial?.readerArticle || '');
    const blocks = article.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean);
    const artifacts = new Map((artifactIndex?.figures || []).map(item => [item.id, item]));
    const insertions = [];
    for (const figure of record.editorial?.longformBundle?.figures || []) {
        if (figure.disposition !== 'inline') continue;
        const artifact = artifacts.get(figure.id);
        if (!artifact?.url?.startsWith('https://')) {
            throw new Error(`gray canonical ${figure.id} 缺少 ArtifactIndex HTTPS 图片`);
        }
        const index = blocks.findIndex(block => {
            const match = block.match(/^!\[(?:\\.|[^\]\\])*\]\((https:\/\/[^)\s]+)(?:\s+["'][^"']*["'])?\)$/);
            return match?.[1] === artifact.url;
        });
        if (index < 1 || index >= blocks.length - 1) {
            throw new Error(`gray canonical ${figure.id} 未在 readerArticle 形成独立图片论证块`);
        }
        const lead = blocks[index - 1];
        const explanation = blocks[index + 1];
        if (/^#{1,6}\s/.test(lead) || /^#{1,6}\s/.test(explanation)
            || lead.length < 18 || explanation.length < 30) {
            throw new Error(`gray canonical ${figure.id} 缺少合格图前 lead 或图后 explanation`);
        }
        insertions.push({ url: artifact.url, lead, explanation });
    }
    return insertions;
}

function buildPublicationFigureReview(record, artifactIndex, imageInfos, imageInsertions) {
    const figures = new Map((record.editorial?.longformBundle?.figures || []).map(item => [item.id, item]));
    const artifactsByUrl = new Map((artifactIndex?.figures || []).map(item => [item.url, item]));
    const insertionByUrl = new Map(imageInsertions.map(item => [item.url, item]));
    return {
        version: 1,
        decisions: (imageInfos || []).map((info, index) => {
            const artifact = artifactsByUrl.get(info.url);
            const figure = artifact ? figures.get(artifact.id) : null;
            const insertion = insertionByUrl.get(info.url);
            const common = {
                url: info.url,
                figureNumber: artifact?.figureLabel || `Figure ${index + 1}`,
                captionIdentity: artifact?.caption || info.caption || `Figure ${index + 1} source identity`
            };
            if (figure?.disposition === 'inline' && insertion) {
                const visibleFacts = [...new Set([
                    ...(figure.visibleFacts || []),
                    insertion.explanation
                ].map(value => String(value || '').trim()).filter(value => value.length >= 10))];
                if (visibleFacts.length < 2) {
                    throw new Error(`gray canonical ${figure.id} 缺少两条独立可见事实`);
                }
                return {
                    ...common,
                    decision: 'select',
                    reason: '该图已由 V6 ArtifactIndex 与 reader-longform 逐字绑定，正文保留图前读图任务和图后证据边界。',
                    visibleFacts,
                    renderPlan: { mode: 'full', mobileReadable: true }
                };
            }
            return {
                ...common,
                decision: 'reject',
                reason: `候选图 ${artifact?.id || index + 1} 未被封印的 V6 longform 选作读者图，不能绕过逐图审计临时加入发布正文。`
            };
        })
    };
}

function buildPublicationAnalysis(metadata, record, imageInsertions = []) {
    const bundle = record.editorial?.longformBundle;
    const orderedBlocks = bundle?.blocks || [];
    const blocks = new Map(orderedBlocks.map(block => [block.id, block]));
    const containerByBlock = new Map();
    const normalizedEvidence = value => String(value || '').normalize('NFKC').replace(/\s+/gu, '');
    const findQuoteBlock = (quote, label) => {
        const normalizedQuote = normalizedEvidence(quote);
        if (!normalizedQuote) throw new Error(`gray canonical ${label} 缺少 readerQuote`);
        const block = orderedBlocks.find(item => normalizedEvidence(item.markdown).includes(normalizedQuote));
        if (!block) throw new Error(`gray canonical ${label} 未绑定 reader-longform block`);
        return block;
    };
    for (const item of record.researchBrief?.editorialPlan?.sectionPlan || []) {
        const block = orderedBlocks.find(candidate => candidate.heading === item.heading);
        if (!block) throw new Error(`gray canonical 编辑计划标题未绑定 longform block: ${item.heading}`);
        containerByBlock.set(block.id, item.container);
    }
    for (const [index, item] of (record.researchBrief?.editorialPlan?.evidencePillars || []).entries()) {
        containerByBlock.set(
            findQuoteBlock(item.readerQuote, `evidencePillars[${index}]`).id,
            '实验结果'
        );
    }
    if (record.researchBrief?.centralQuestion?.readerQuote) {
        containerByBlock.set(
            findQuoteBlock(record.researchBrief.centralQuestion.readerQuote, 'centralQuestion').id,
            '核心摘要'
        );
    }
    if (!(bundle?.tables || []).some(table => table?.kind === 'result')) {
        throw new Error('gray canonical 缺少已封印 reader-longform-v2 结果表');
    }
    const defaultContainer = block => ({
        prerequisites: '核心摘要', problem: '核心摘要', related_work: '方法概述和架构',
        signal_path: '方法概述和架构', training: '核心创新点', experiment_setup: '实验结果',
        result: '实验结果', ablation: '实验结果', reproduction: '开源详情',
        limitation: '局限与问题', synthesis: '细节详述'
    })[block.kind] || '细节详述';
    for (const block of orderedBlocks) {
        if (!containerByBlock.has(block.id)) containerByBlock.set(block.id, defaultContainer(block));
    }
    const resultTables = (bundle?.tables || []).filter(table => (
        table.disposition !== 'omit' && containerByBlock.get(table.blockId) === '实验结果'
    )).sort((left, right) => (
        Number(right.kind === 'result') - Number(left.kind === 'result')
        || Number(right.numericCellCount || 0) - Number(left.numericCellCount || 0)
        || String(left.sourceTableId).localeCompare(String(right.sourceTableId))
    ));
    const retainedResultTableIds = new Set(resultTables.slice(0, 2).map(table => table.sourceTableId));
    if (![...retainedResultTableIds].some(id => (
        (bundle?.tables || []).find(table => table.sourceTableId === id)?.kind === 'result'
    ))) {
        throw new Error('gray canonical legacy 实验栏目没有可保留的 V6 result table');
    }
    const renderedByContainer = new Map();
    for (const block of orderedBlocks) {
        const container = containerByBlock.get(block.id);
        let markdown = block.markdown;
        if (container === '实验结果') {
            for (const table of bundle?.tables || []) {
                if (table.blockId === block.id && table.disposition !== 'omit'
                    && !retainedResultTableIds.has(table.sourceTableId)) {
                    markdown = markdown.replace(table.renderedMarkdown, '').trim();
                }
            }
            const retainedInBlock = (bundle?.tables || []).filter(table => (
                table.blockId === block.id && table.disposition !== 'omit'
                && retainedResultTableIds.has(table.sourceTableId)
            ));
            const tableTokens = retainedInBlock.map((_table, index) => `__PD_RETAINED_RESULT_TABLE_${index}__`);
            retainedInBlock.forEach((table, index) => {
                markdown = markdown.replace(table.renderedMarkdown, tableTokens[index]);
            });
            markdown = markdown.split(/\n\s*\n/gu).filter(paragraph => {
                const lines = paragraph.split('\n').map(line => line.trim()).filter(Boolean);
                return !(lines.length >= 2 && lines.every(line => /^\|.*\|$/u.test(line)));
            }).join('\n\n');
            retainedInBlock.forEach((table, index) => {
                markdown = markdown.replace(tableTokens[index], table.renderedMarkdown);
            });
            for (const table of retainedInBlock) {
                if (!markdown.trimEnd().endsWith(table.renderedMarkdown)) continue;
                const tableStart = markdown.lastIndexOf(table.renderedMarkdown);
                const prefixParts = markdown.slice(0, tableStart).trimEnd().split(/\n\s*\n/gu);
                const narrativeIndex = prefixParts.findLastIndex(paragraph => {
                    const value = paragraph.trim();
                    return value.length >= 50 && !/^(?:#{1,6}\s|!\[|\||\*\*)/u.test(value);
                });
                if (narrativeIndex < 0) continue;
                const [narrative] = prefixParts.splice(narrativeIndex, 1);
                const boundedNarrative = /(?:相比|相对|差异|提升|下降|降低|增加|减少|但|而|同时|代价|边界|未|不显著|跨零|失败|退化)/u.test(narrative)
                    ? narrative.trim()
                    : `${narrative.trim()} 但这仍只是该表对应设置内的证据边界，未覆盖表外数据或因果识别。`;
                markdown = `${prefixParts.join('\n\n').trim()}\n\n${table.renderedMarkdown}\n\n${boundedNarrative}`;
            }
        }
        const rendered = `### ${block.heading}\n\n${normalizePublicationResultTable(markdown)}`;
        renderedByContainer.set(container, [...(renderedByContainer.get(container) || []), rendered]);
    }
    for (const item of record.researchBrief?.mustExplain || []) {
        const existing = (renderedByContainer.get(item.section) || []).join('\n\n');
        if (normalizedEvidence(existing).includes(normalizedEvidence(item.readerQuote))) continue;
        const quote = String(item.readerQuote || '').trim();
        const boundedQuote = /[；;]$/u.test(quote) ? `${quote}这项边界仍需保留。` : quote;
        const supplement = `关于 ${item.topic}，正文中的关键判断是：${boundedQuote}`;
        renderedByContainer.set(item.section, [
            ...(renderedByContainer.get(item.section) || []), supplement
        ]);
    }
    const renderContainer = container => (renderedByContainer.get(container) || []).join('\n\n');
    const analysisRecord = structuredClone(record);
    let publicationSummary = [
        [
            record.editorial?.summary,
            record.researchBrief?.centralQuestion?.question,
            record.researchBrief?.centralQuestion?.whyItMatters,
            record.researchBrief?.centralQuestion?.readerQuote,
            ...[...new Set((record.researchBrief?.mustExplain || [])
                .filter(item => item.section === '核心摘要')
                .map(item => item.readerQuote))]
        ].filter(Boolean).join(' '),
        [record.editorial?.method, record.editorial?.innovations, record.editorial?.details]
            .filter(Boolean).join(' '),
        [
            record.editorial?.results,
            record.editorial?.limits,
            record.researchBrief?.evidenceProfile?.evidenceBoundary
        ].filter(Boolean).join(' '),
        [
            ...(record.researchBrief?.takeaways || []),
            ...(record.researchBrief?.compress || []).flatMap(item => [item.topic, item.reason]),
            record.editorial?.open
        ].filter(Boolean).join(' ')
    ].filter(Boolean).join('\n\n');
    const nonCoreProjection = [...renderedByContainer.entries()]
        .filter(([container]) => container !== '核心摘要')
        .flatMap(([, values]) => values)
        .join('\n\n');
    for (const item of record.researchBrief?.compress || []) {
        const quote = String(item.readerQuote || '').trim();
        if (!quote || `${publicationSummary}\n${nonCoreProjection}`.includes(quote)) continue;
        publicationSummary += `\n\n关于 ${item.topic}，文章保留的压缩判断是：${quote}`;
    }
    const openSourceUrls = (record.openSourceEvidence?.urls || [])
        .filter(url => typeof url === 'string' && url.startsWith('https://'));
    const openText = [
        record.open,
        record.editorial?.open,
        ...(record.researchBrief?.mustExplain || [])
            .filter(item => item.section === '开源详情')
            .map(item => `关于 ${item.topic}，公开资源边界是：${item.readerQuote}`),
        openSourceUrls.length ? `已核验的公开资源入口：${openSourceUrls.join('；')}` : ''
    ].filter(Boolean).join('\n\n');
    const detailDigestParts = [
        record.editorial?.method,
        record.editorial?.innovations,
        record.editorial?.limits
    ].map(value => String(value || '').trim().replace(/[。！？!?]+$/u, '')).filter(Boolean);
    const publicationDetailDigest = detailDigestParts.length
        ? `实现与复核边界包括：${detailDigestParts.join('，并且')}。`
        : '';
    analysisRecord.editorial = {
        ...analysisRecord.editorial,
        summary: publicationSummary,
        method: [
            renderContainer('方法概述和架构'),
            record.method ? `输入与组件边界：${record.method}` : '',
            record.method2 ? `训练、控制与构造目标：${record.method2}` : '',
            record.method3 ? `输出、评估与结果边界：${record.method3}` : ''
        ].filter(Boolean).join('\n\n'),
        innovations: [renderContainer('核心创新点'), record.innovations]
            .filter(Boolean).join('\n\n'),
        details: [
            renderContainer('细节详述'), record.details, record.question,
            record.review, publicationDetailDigest
        ]
            .filter(Boolean).join('\n\n'),
        results: [renderContainer('实验结果'), record.results]
            .filter(Boolean).join('\n\n'),
        limits: [renderContainer('局限与问题'), record.limits]
            .filter(Boolean).join('\n\n'),
        open: openText
    };
    const protectedPhrases = [
        record.researchBrief?.centralQuestion?.readerQuote,
        ...(record.researchBrief?.mustExplain || []).map(item => item.readerQuote),
        ...(record.researchBrief?.compress || []).map(item => item.readerQuote),
        ...(record.researchBrief?.editorialPlan?.evidencePillars || []).map(item => item.readerQuote),
        ...(record.researchBrief?.editorialPlan?.sectionPlan || []).map(item => item.anchorQuote),
        ...imageInsertions.flatMap(item => [item.lead, item.explanation])
    ];
    for (const field of ['summary', 'method', 'innovations', 'details', 'results', 'limits', 'open']) {
        analysisRecord.editorial[field] = splitPublicationLongParagraphs(
            analysisRecord.editorial[field], protectedPhrases
        );
    }
    return normalizePublicationDefensiveNegations(
        normalizePublicationChineseQuantities(buildAnalysis(metadata, analysisRecord), protectedPhrases),
        protectedPhrases
    );
}

async function buildGrayCanonical(options) {
    const { date, paper: paperId } = options;
    const paths = runnerPaths(date, Config.FILES.manualV6Dir);
    const state = verifyBoundInputs(readJson(paths.statePath, 'production task state').value);
    if (!state.expectedPaperIds.includes(paperId)) throw new Error(`${paperId} 不在 production 批次`);
    for (const role of ['author', 'technical_scoring', 'pedagogy_readability', 'author_revision']) {
        if (state.papers[paperId].tasks[role].status !== 'validated') {
            throw new Error(`${paperId}.${role} 尚未 validated`);
        }
    }
    const root = fs.realpathSync(path.join(paths.taskRoot, paperId));
    verifyTaskArtifactsAgainstState(state, paperId);
    const sealed = sealRecordFromValidatedState(state, paperId, root, { force: options.force });
    const recordFile = readJson(sealed.sealedPath, 'sealed record-v4');
    const record = recordFile.value;
    const artifactFile = readJson(path.join(root, 'evidence', 'artifact-index.json'), 'ArtifactIndex');
    const metadata = readJson(path.join(root, 'evidence', 'paper-metadata.json'), 'paper metadata').value;
    const sourceSnapshot = readJson(path.join(root, 'evidence', 'source-snapshot.json'), 'source snapshot').value;
    const authorPacket = readJson(state.papers[paperId].tasks.author.packetPath, 'author packet').value;
    const fullManifest = readJson(
        path.join(Config.CURRENT_DIR, 'manual-full-text', date, 'manifest.json'),
        'fulltext manifest'
    ).value;
    const fullEntry = fullManifest.papers?.[paperId];
    if (!fullEntry || fullEntry.status !== 'complete'
        || fullEntry.sourceSha256 !== sourceSnapshot.sourceSha256
        || fullEntry.sourceIdentitySha256 !== sourceSnapshot.sourceIdentitySha256
        || fullEntry.paperInputSha256 !== sourceSnapshot.paperInputSha256) {
        throw new Error('gray canonical 拒绝偏离 author 绑定的 complete fulltext entry');
    }
    const evidence = taskEvidence(state, paperId);
    const bundle = record.editorial.longformBundle;
    const bundleSha256 = stableSha256(bundle);
    const grayDir = path.join(Config.CURRENT_DIR, 'manual-v6-gray', date, paperId);
    fs.mkdirSync(grayDir, { recursive: true });
    const envelope = {
        version: 1,
        contract: 'manual-v6-gray-record-envelope-v1',
        date,
        paperId,
        record: { path: recordFile.path, fileSha256: sha256Bytes(recordFile.bytes), sealedRecordSha256: record.sealedRecordSha256 },
        artifactIndex: { path: artifactFile.path, fileSha256: sha256Bytes(artifactFile.bytes), semanticSha256: artifactFile.value.outputSha256 },
        taskEvidence: evidence,
        taskEvidenceSha256: stableSha256(evidence),
        readerLongformSha256: bundleSha256
    };
    const envelopePath = path.join(grayDir, 'records-envelope.json');
    writeFileAtomic(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`);
    const envelopeFileSha256 = sha256Bytes(fs.readFileSync(envelopePath));
    const paperSpecBase = {
        contract: 'manual-v6-gray-paper-spec-v1', date, paperId,
        sealedRecordSha256: record.sealedRecordSha256,
        recordFileSha256: sha256Bytes(recordFile.bytes),
        artifactIndexSha256: artifactFile.value.outputSha256,
        artifactIndexFileSha256: sha256Bytes(artifactFile.bytes),
        recordsEnvelopeFileSha256: envelopeFileSha256,
        taskEvidenceSha256: stableSha256(evidence),
        readerLongformSha256: bundleSha256
    };
    const paperSpecSha256 = stableSha256(paperSpecBase);
    const specRootSha256 = stableSha256({
        contract: 'manual-v6-gray-spec-root-v1', date,
        orderedPapers: [{ paperId, paperSpecSha256 }]
    });
    const recordProvenance = {
        sealedRecordSha256: record.sealedRecordSha256,
        recordFileSha256: sha256Bytes(recordFile.bytes),
        artifactIndexSha256: artifactFile.value.outputSha256,
        artifactIndexFileSha256: sha256Bytes(artifactFile.bytes),
        recordsEnvelopeFileSha256: envelopeFileSha256,
        taskEvidenceSha256: stableSha256(evidence),
        readerLongformSha256: bundleSha256
    };
    const publicationImageInsertions = buildPublicationImageInsertions(record, artifactFile.value);
    const manifestImagesByUrl = new Map((fullEntry.imageInfos || []).map(item => [item.url, item]));
    const publicationImageInfos = (artifactFile.value.figures || []).map((artifact, index) => ({
        ...(manifestImagesByUrl.get(artifact.url) || {}),
        url: artifact.url,
        caption: manifestImagesByUrl.get(artifact.url)?.caption || artifact.caption || '',
        source: manifestImagesByUrl.get(artifact.url)?.source || artifact.source || 'artifact_index',
        sourceOrder: manifestImagesByUrl.get(artifact.url)?.sourceOrder ?? index,
        artifactId: artifact.id
    }));
    const publicationPreparedImages = publicationImageInsertions.map(insertion => {
        const source = (fullEntry.imageInfos || []).find(item => item.url === insertion.url) || {};
        const artifact = (artifactFile.value.figures || []).find(item => item.url === insertion.url) || {};
        return {
            ...source,
            url: insertion.url,
            caption: source.caption || artifact.caption || '',
            source: source.source || artifact.source || 'artifact_index',
            mime: artifact.mediaType || source.mime || null,
            sha256: artifact.sourceDomSha256 || artifact.metadataSha256 || null,
            bytes: artifact.inlineSvgBytes || artifact.inlineHtmlBytes || 0
        };
    });
    const publicationFigureReview = buildPublicationFigureReview(
        record, artifactFile.value, publicationImageInfos, publicationImageInsertions
    );
    const publicationAnalysis = buildPublicationAnalysis(metadata, record, publicationImageInsertions);
    const publicationEditorialReview = extractSection(publicationAnalysis, '毒舌点评').trim();
    const paperSpec = {
        ...record,
        analysis: publicationAnalysis,
        fullTextPath: fullEntry.path,
        sourceSha256: fullEntry.sourceSha256,
        requestedArxivId: fullEntry.requestedArxivId,
        sourceIdentitySha256: fullEntry.sourceIdentitySha256,
        paperMetadataSha256: fullEntry.paperMetadataSha256,
        paperInputSha256: fullEntry.paperInputSha256,
        filteredBatchSha256: fullEntry.filteredBatchSha256,
        imageInfos: publicationImageInfos,
        selectedImageUrls: publicationImageInsertions.map(item => item.url),
        imageInsertions: publicationImageInsertions,
        imageSelectionMode: 'manual_explicit',
        readerImagesPreembedded: true,
        figureReview: publicationFigureReview,
        manualAuthoringPromptSha256: promptSha(authorPacket),
        readerArticle: record.editorial.readerArticle,
        editorialReview: publicationEditorialReview,
        manualDepth: MANUAL_DEPTH_V6,
        runtimeMode: 'production',
        readerLongform: bundle,
        artifactIndex: artifactFile.value,
        recordProvenance,
        taskEvidence: evidence,
        stageReviews: record.stageReviews?.stages,
        reviewedClaimsByStage: explicitReviewedClaimsByStage({
            ...record,
            stageReviews: record.stageReviews?.stages
        }),
        stageReviewAttemptsByStage: record.stageReviewAttemptsByStage,
        paperSpecSha256,
        agent: 'Codex-v6-gray-publication'
    };
    const externalResourceVerification = await verifyManualExternalResources(paperSpec);
    const imageDownloadOutcomes = (paperSpec.imageInfos || []).map(info => ({
        url: info.url, status: 'manual_rejected', reason: 'not_selected_by_validated_v6_figure_review'
    }));
    const canonical = buildManualRecord({
        ...metadata,
        arxivId: paperId,
        fetchBatchDate: date,
        fetchedAt: metadata.fetchedAt || `${date}T00:00:00+08:00`
    }, paperSpec, date, promptSha(authorPacket), {
        manualDepthContractVersion: MANUAL_DEPTH_V6,
        manualProvenance: {
            runtimeMode: 'production', specVersion: 6, specRootSha256,
            recordsSourcesSha256: stableSha256([{ path: envelopePath, sha256: envelopeFileSha256 }])
        },
        preparedImages: publicationPreparedImages, imageDownloadOutcomes, externalResourceVerification
    });
    const binding = {
        version: 1, contract: CONTRACT, date, paperId,
        source: 'fully-validated-production-v6-single-paper-closure',
        grayOnly: true,
        specRootSha256, paperSpecSha256,
        recordsEnvelope: { path: envelopePath, fileSha256: envelopeFileSha256 },
        canonicalSha256: stableSha256(canonical)
    };
    const bindingPath = path.join(grayDir, 'publication-binding.json');
    writeFileAtomic(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
    const output = {
        version: 1, status: 'complete', pipelineStatus: 'analysis_complete',
        batchDate: date, generatedAt: new Date().toISOString(),
        publicationMode: CONTRACT, grayOnly: true,
        binding: { path: bindingPath, fileSha256: sha256Bytes(fs.readFileSync(bindingPath)) },
        papers: [canonical]
    };
    const outputPath = path.join(grayDir, 'deep-analysis-result.json');
    const bytes = Buffer.from(`${JSON.stringify(output, null, 2)}\n`, 'utf8');
    const existing = fs.lstatSync(outputPath, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error('gray canonical 输出类型非法');
    if (existing && !fs.readFileSync(outputPath).equals(bytes) && !options.force) {
        throw new Error('gray canonical 已存在且闭包变化；显式 --force 后替换');
    }
    if (!existing || !fs.readFileSync(outputPath).equals(bytes)) writeFileAtomic(outputPath, bytes);
    return { outputPath, bindingPath, specRootSha256, paperSpecSha256 };
}

async function run(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    const result = await buildGrayCanonical(options);
    console.log(JSON.stringify({ contract: CONTRACT, ...result }, null, 2));
    return result;
}

if (require.main === module) {
    run().catch(error => {
        console.error(`Manual v6 gray canonical 失败: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    CONTRACT, parseArgs, taskEvidence, normalizePublicationResultTable,
    normalizePublicationChineseQuantities, normalizePublicationDefensiveNegations,
    buildPublicationImageInsertions, buildPublicationFigureReview, buildPublicationAnalysis,
    buildGrayCanonical, run
};
