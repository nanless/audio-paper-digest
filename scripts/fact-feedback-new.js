#!/usr/bin/env node
'use strict';
// 根据当前日更分析结果与封存四来源生成经 validateFeedback 校验的受控事实反馈文件（0600 原子写入）。

const { requireExternalRuntime } = require('./env-loader.js');
if (require.main === module) {
    requireExternalRuntime('fact-feedback-new.js', { enforceWorkspaceRole: true });
}

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Config = require('./config.js');
const { readJsonFileStrict } = require('./analysis-engine.js');
const deep = require('./deep-analyzer.js');
const daily = require('./lib/daily-fresh-source-plan.js');
const sourceApi = require('./lib/fresh-arxiv-rewrite-source.js');
const factReview = require('./lib/daily-fact-review.js');
const { normalizedId } = require('./utils.js');

const SOURCE_FILES = Object.freeze([
    'source.txt',
    'source.pdf',
    'source-runtime.json',
    'source-manifest.json'
]);

const USAGE = [
    '用法: npm run fact-feedback:new -- --paper <ARXIV_ID> --reader-feedback <TEXT>',
    '  --reject <CLAIM> [--reject <CLAIM> ...] --quote <SOURCE_QUOTE> [--quote <SOURCE_QUOTE> ...]',
    '  [--core-feedback <TEXT>] [--reject-core <CLAIM> ...]',
    '  [--from-review-failure [PATH]] [--out <PATH>] [--dry-run] [--json]'
].join('\n');

function parseArgs(argv = process.argv.slice(2)) {
    const options = {
        paper: null,
        fromReviewFailure: null,
        fromReviewFailureAuto: false,
        readerFeedback: '',
        coreFeedback: '',
        rejectedReaderClaims: [],
        rejectedCoreClaims: [],
        sourceQuotes: [],
        out: null,
        dryRun: false,
        json: false,
        help: false
    };
    const requireValue = (flag, next) => {
        if (typeof next !== 'string' || !next.trim() || next.startsWith('--')) {
            throw new Error(`${flag} 需要非空参数值`);
        }
        return next;
    };
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--help' || value === '-h') options.help = true;
        else if (value === '--dry-run') options.dryRun = true;
        else if (value === '--json') options.json = true;
        else if (value === '--paper') options.paper = requireValue('--paper', argv[++index]);
        else if (value === '--reader-feedback') options.readerFeedback = requireValue('--reader-feedback', argv[++index]).trim();
        else if (value === '--core-feedback') options.coreFeedback = requireValue('--core-feedback', argv[++index]).trim();
        else if (value === '--reject') options.rejectedReaderClaims.push(requireValue('--reject', argv[++index]));
        else if (value === '--reject-core') options.rejectedCoreClaims.push(requireValue('--reject-core', argv[++index]));
        else if (value === '--quote') options.sourceQuotes.push(requireValue('--quote', argv[++index]));
        else if (value === '--out') options.out = path.resolve(requireValue('--out', argv[++index]));
        else if (value === '--from-review-failure') {
            const next = argv[index + 1];
            if (typeof next === 'string' && next.trim() && !next.startsWith('--')) {
                options.fromReviewFailure = path.resolve(next);
                index += 1;
            } else {
                options.fromReviewFailureAuto = true;
            }
        } else {
            throw new Error(`未知参数：${value}`);
        }
    }
    return options;
}

function normalizePlatformRootSymlink(resolvedPath) {
    if (process.platform !== 'darwin') return resolvedPath;
    for (const [alias, real] of [['/var', '/private/var'], ['/tmp', '/private/tmp'], ['/etc', '/private/etc']]) {
        if (resolvedPath === alias || resolvedPath.startsWith(`${alias}/`)) {
            try {
                if (fs.lstatSync(alias).isSymbolicLink() && fs.realpathSync(alias) === real) {
                    return `${real}${resolvedPath.slice(alias.length)}`;
                }
            } catch (_) {
                // ignore if alias does not exist
            }
        }
    }
    return resolvedPath;
}

function assertSafeOutputDirectory(directory) {
    const absolute = normalizePlatformRootSymlink(path.resolve(directory));
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        let stat;
        try {
            stat = fs.lstatSync(cursor);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            fs.mkdirSync(cursor, { mode: 0o700 });
            stat = fs.lstatSync(cursor);
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error(`输出目录包含符号链接或非目录：${cursor}`);
        }
    }
    return absolute;
}

function atomicWritePrivateJson(filePath, payload) {
    const resolved = normalizePlatformRootSymlink(path.resolve(filePath));
    assertSafeOutputDirectory(path.dirname(resolved));
    try {
        const stat = fs.lstatSync(resolved);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error(`输出路径不是安全普通文件：${resolved}`);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const temp = `${resolved}.${crypto.randomUUID()}.tmp`;
    const bytes = `${JSON.stringify(payload, null, 2)}\n`;
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
        fs.writeFileSync(fd, bytes, 'utf8');
        fs.fsyncSync(fd);
    } catch (error) {
        try { fs.unlinkSync(temp); } catch (_) { /* ignore */ }
        throw error;
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(temp, resolved);
    return resolved;
}

function extractArxivIdFromFailureEntry(entry) {
    for (const raw of [entry?.arxivId, entry?.paperId, entry?.path, entry?.title]) {
        if (typeof raw !== 'string') continue;
        const match = raw.match(/\b(\d{4}\.\d{4,5})(?:v\d+)?\b/);
        if (match) return match[1];
    }
    return '';
}

function extractReviewFailureContext(failurePath, requestedPaperId = null) {
    if (!fs.existsSync(failurePath)) {
        throw new Error(`找不到博客审查失败报告：${failurePath}`);
    }
    const report = readJsonFileStrict(failurePath);
    const failedFiles = (Array.isArray(report?.files) ? report.files : []).filter(entry => {
        if (!entry || typeof entry !== 'object') return false;
        const issues = Array.isArray(entry.issues) ? entry.issues : [];
        return entry.passed !== true || issues.some(issue => /error/i.test(String(issue?.severity || issue?.level || '')));
    });
    const normalizedTarget = requestedPaperId ? normalizedId(requestedPaperId) : '';
    const candidates = failedFiles
        .map(entry => ({ entry, paperId: extractArxivIdFromFailureEntry(entry) }))
        .filter(item => Boolean(item.paperId));
    let selected;
    if (normalizedTarget) {
        selected = candidates.find(item => item.paperId === normalizedTarget);
        if (!selected) {
            throw new Error(`审查失败报告 ${failurePath} 中未找到论文 ${normalizedTarget}`);
        }
    } else if (candidates.length === 1) {
        selected = candidates[0];
    } else if (candidates.length === 0) {
        throw new Error(`审查失败报告 ${failurePath} 中没有可识别论文 ID 的失败独立页，请显式传入 --paper`);
    } else {
        throw new Error(`审查失败报告包含多篇失败论文（${candidates.map(c => c.paperId).join(', ')}），请用 --paper 指定目标论文`);
    }
    const errorIssues = (Array.isArray(selected.entry.issues) ? selected.entry.issues : [])
        .filter(issue => /error/i.test(String(issue?.severity || issue?.level || 'error')));
    const descriptions = errorIssues
        .map(issue => String(issue?.description || issue?.message || issue?.issue || '').trim())
        .filter(Boolean);
    const extractedQuotes = [];
    const extractedClaims = [];
    for (const issue of errorIssues) {
        for (const key of ['sourceQuote', 'source_quote', 'evidence', 'quote']) {
            if (typeof issue?.[key] === 'string' && issue[key].trim()) extractedQuotes.push(issue[key].trim());
        }
        for (const key of ['claim', 'excerpt', 'articleExcerpt', 'article_excerpt', 'rejectedClaim']) {
            if (typeof issue?.[key] === 'string' && issue[key].trim()) extractedClaims.push(issue[key].trim());
        }
    }
    return {
        paperId: selected.paperId,
        failurePath,
        descriptions,
        extractedQuotes: [...new Set(extractedQuotes)],
        extractedClaims: [...new Set(extractedClaims)]
    };
}

function buildFactFeedback(options = {}) {
    const resultFile = options.resultFile || Config.FILES.deepAnalysisResult;
    const data = readJsonFileStrict(resultFile);
    const papers = Array.isArray(data) ? data : (data?.papers || []);
    const plan = daily.requireDailyFreshSourceRecoveryPlan(data, { papers, label: 'fact-feedback-new' });

    let reviewContext = null;
    if (options.fromReviewFailure || options.fromReviewFailureAuto) {
        const failurePath = options.fromReviewFailure
            || path.join(Config.CURRENT_DIR, `blog-review-failure-${plan.batchDate}.json`);
        reviewContext = extractReviewFailureContext(failurePath, options.paper);
    }

    const targetPaperId = normalizedId(options.paper || reviewContext?.paperId || '');
    if (!targetPaperId || !/^\d{4}\.\d{4,5}$/.test(targetPaperId)) {
        throw new Error('必须通过 --paper <ARXIV_ID>（或包含单篇失败论文的 --from-review-failure）指定合法论文 ID');
    }
    const paper = papers.find(item => normalizedId(item) === targetPaperId);
    if (!paper) {
        throw new Error(`当前分析结果 ${resultFile} 中找不到论文：${targetPaperId}`);
    }
    if (!daily.isPaperBoundToPlan(paper, plan)) {
        throw new Error(`论文 ${targetPaperId} 未绑定当前封存来源计划 ${plan.runId}`);
    }

    const details = daily.readDailyFreshSource(plan, paper);
    const generation = details.freshSourceDescriptor.sourceGeneration;
    const stored = sourceApi.readFreshArxivRewriteSource({
        rootDir: plan.sourcesDir,
        arxivId: targetPaperId,
        generation
    });
    const sourceDir = path.join(
        plan.sourcesDir,
        targetPaperId,
        `generation-${String(generation).padStart(6, '0')}`
    );
    const sourceFiles = {
        'source.txt': stored.manifest.text.responseSha256,
        'source.pdf': stored.manifest.pdf.responseSha256,
        'source-runtime.json': stored.manifest.runtimeMetadata.responseSha256,
        'source-manifest.json': stored.sourceManifestSha256
    };
    for (const name of SOURCE_FILES) {
        const diskSha = factReview.sha(fs.readFileSync(path.join(sourceDir, name)));
        if (diskSha !== sourceFiles[name]) {
            throw new Error(`封存来源文件 ${name} 磁盘 SHA 与 manifest 不一致`);
        }
    }

    const currentAnalysis = paper.analysisCheckpoint || paper.analysis || '';
    if (typeof currentAnalysis !== 'string' || !currentAnalysis.trim()) {
        throw new Error(`论文 ${targetPaperId} 缺少可用于绑定 SHA 的主分析正文`);
    }
    const coreSummary = deep.extractSectionByTitle(currentAnalysis, '核心摘要');
    if (typeof coreSummary !== 'string' || !coreSummary.trim()) {
        throw new Error(`论文 ${targetPaperId} 缺少「核心摘要」小节，无法计算 coreSummarySha256`);
    }

    let readerFeedback = String(options.readerFeedback || '').trim();
    if (!readerFeedback && reviewContext?.descriptions?.length) {
        readerFeedback = `修复博客审查发现的事实问题：${reviewContext.descriptions.join('；')}`.slice(0, 2000);
    }
    const coreFeedback = String(options.coreFeedback || '').trim();

    let rejectedReaderClaims = [...(options.rejectedReaderClaims || [])];
    if (!rejectedReaderClaims.length && reviewContext?.extractedClaims?.length) {
        const readerArticle = String(paper.apiReaderArticle || '');
        rejectedReaderClaims = reviewContext.extractedClaims.filter(claim =>
            readerArticle ? readerArticle.includes(claim) : true);
    }
    const rejectedCoreClaims = [...(options.rejectedCoreClaims || [])];

    let sourceQuotes = [...(options.sourceQuotes || [])];
    if (!sourceQuotes.length && reviewContext?.extractedQuotes?.length) {
        sourceQuotes = reviewContext.extractedQuotes.filter(quote => details.text.includes(quote));
    }
    if (!sourceQuotes.length) {
        throw new Error('缺少已核验的封存原文引文：请通过 --quote 提供至少一条存在于封存 source.txt 中的逐字引文');
    }

    const feedback = {
        contract: factReview.CONTRACT,
        paperId: targetPaperId,
        batchDate: plan.batchDate,
        runId: plan.runId,
        sourceFiles,
        coreAnalysisSha256: factReview.sha(currentAnalysis),
        coreSummarySha256: factReview.sha(coreSummary),
        coreFeedback,
        readerFeedback,
        rejectedCoreClaims,
        rejectedReaderClaims,
        sourceQuotes
    };

    const bound = factReview.validateFeedback(feedback, plan, paper);
    return { feedback, bound, plan, paper, reviewContext };
}

function defaultOutputPath(plan, paperId, feedbackSha256) {
    const runtimeRoot = path.dirname(Config.FILES.dailyFreshSourceRunsDir);
    const dateStamp = String(plan.batchDate || '').replace(/-/g, '');
    return path.join(
        runtimeRoot,
        'fact-feedbacks',
        `fact-feedback-${paperId}-${dateStamp}-${feedbackSha256.slice(0, 8)}.json`
    );
}

function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        console.log(USAGE);
        return 0;
    }
    const { feedback, bound, plan } = buildFactFeedback(options);
    const outPath = options.out || defaultOutputPath(plan, feedback.paperId, bound.proof.feedbackSha256);
    if (!options.dryRun) {
        atomicWritePrivateJson(outPath, feedback);
    }
    const useReaderFactLocal = !feedback.coreFeedback
        && !feedback.rejectedCoreClaims.length
        && feedback.rejectedReaderClaims.length > 0;
    const nextCommand = useReaderFactLocal
        ? `npm run batch -- --fact-feedback-file ${outPath} --reader-fact-local`
        : `npm run batch -- --fact-feedback-file ${outPath}`;
    const report = {
        contract: feedback.contract,
        paperId: feedback.paperId,
        batchDate: feedback.batchDate,
        runId: feedback.runId,
        feedbackSha256: bound.proof.feedbackSha256,
        dryRun: options.dryRun,
        outputPath: outPath,
        nextCommand,
        feedback
    };
    if (options.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(`✅ 事实反馈已校验通过：${feedback.paperId}（feedbackSha256=${bound.proof.feedbackSha256.slice(0, 12)}）`);
        console.log(options.dryRun ? `ℹ️  dry-run 未写入文件（目标路径：${outPath}）` : `💾 已原子写入（0600）：${outPath}`);
        console.log(`👉 下一步：${nextCommand}`);
    }
    return 0;
}

module.exports = {
    parseArgs,
    atomicWritePrivateJson,
    extractReviewFailureContext,
    buildFactFeedback,
    defaultOutputPath,
    main
};

if (require.main === module) {
    try {
        process.exitCode = main();
    } catch (error) {
        console.error(`[fact-feedback-new] ${error.message}`);
        process.exitCode = 1;
    }
}
