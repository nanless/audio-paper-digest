#!/usr/bin/env node
'use strict';

// 只读扫描博客仓库 content/posts/ 下的历史文章 frontmatter，
// 识别落后于当前日更/会议规范的旧页面，输出按日期与范围分组的清单及可直接执行的重写命令。
// 不修改任何博客文件，也不修改 config/historical-page-scan-formats.json。

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { requireExternalRuntime } = require('./env-loader.js');
const codec = require('./lib/protocol-codec.js');
const readerFormat = require('./lib/reader-record-format.js');
const scoringRubric = require('./lib/scoring-rubric.js');
const tagRulesApi = require('./lib/tag-rules.js');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAILY_SUMMARY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const DAILY_PAPER_FILE_RE = /^(\d{4}-\d{2}-\d{2})-.+\.md$/;
const CONFERENCE_PREFIX_RE = /^(?:conference-[a-z0-9-]+-20\d{2}(?:-|$)|(icassp|interspeech|icml|neurips|iclr|acl|emnlp|aaai|waspaa|ismir|asru|slt|cvpr)-?\d{4})/i;
const CONFERENCE_SUMMARY_FILE_RE = /^(?:(?:icassp|iclr|icml)\d{4}-(?:summary|task-[^/]+)\.md|conference-[a-z0-9-]+-20\d{2}(?:-task-[^/]+)?\.md)$/i;

const USAGE = [
    '用法: node scripts/historical-outdated-audit.js',
    '[--blog-repo ABS]',
    '[--from-date YYYY-MM-DD]',
    '[--to-date YYYY-MM-DD]',
    '[--scope daily|conference|all]',
    '[--complete-days-only]',
    '[--json]',
    '[--help]'
].join(' ');

function currentStandards() {
    const tagRules = tagRulesApi.getDefaultTagRules();
    const currentReaderFp = codec.schemaFingerprint('beginner-researcher');
    return {
        readerContract: codec.contract('beginner-researcher'),
        readerSchemaFingerprint: currentReaderFp,
        acceptedReaderSchemaFingerprints: [currentReaderFp, readerFormat.V5_PLAN_FP],
        readerEditorialProfile: readerFormat.STRUCTURED_EDITORIAL,
        scoringRubricVersion: scoringRubric.CURRENT_SCORING_RUBRIC,
        acceptedScoringRubricVersions: [...scoringRubric.UNIFIED_SCORING_RUBRIC_VERSIONS],
        tagsRegistrySha256: tagRules.registrySha256,
        tagsRegistryVersion: tagRules.registryVersion,
        readerQualityContract: codec.contract('reader-facing-page'),
        readerQualitySchemaFingerprint: codec.schemaFingerprint('reader-facing-page')
    };
}

function parseArgs(argv = []) {
    const options = {
        blogRepo: null,
        fromDate: null,
        toDate: null,
        scope: 'all',
        completeDaysOnly: false,
        json: false,
        help: false
    };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        if (flag === '--blog-repo') {
            const val = argv[++index] || '';
            if (!val || !path.isAbsolute(val)) throw new Error('--blog-repo 必须是绝对路径');
            options.blogRepo = val;
        } else if (flag === '--from-date') {
            const val = argv[++index] || '';
            if (!DATE_RE.test(val)) throw new Error('--from-date 必须是 YYYY-MM-DD');
            options.fromDate = val;
        } else if (flag === '--to-date') {
            const val = argv[++index] || '';
            if (!DATE_RE.test(val)) throw new Error('--to-date 必须是 YYYY-MM-DD');
            options.toDate = val;
        } else if (flag === '--scope') {
            const val = argv[++index] || '';
            if (!['daily', 'conference', 'all'].includes(val)) {
                throw new Error('--scope 必须是 daily、conference 或 all');
            }
            options.scope = val;
        } else if (flag === '--complete-days-only') {
            options.completeDaysOnly = true;
        } else if (flag === '--json') {
            options.json = true;
        } else if (flag === '--help' || flag === '-h') {
            options.help = true;
        } else {
            throw new Error(`未知参数：${flag}\n${USAGE}`);
        }
    }
    if (options.fromDate && options.toDate && options.fromDate > options.toDate) {
        throw new Error('--from-date 不能晚于 --to-date');
    }
    return options;
}

function parseFrontmatterAndBody(text) {
    const match = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
    if (!match) return { frontmatter: null, body: String(text || ''), parseError: 'missing-frontmatter' };
    try {
        const parsed = YAML.parse(match[1], { uniqueKeys: false, maxAliasCount: 100 });
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { frontmatter: null, body: match[2] || '', parseError: 'non-object-frontmatter' };
        }
        return { frontmatter: parsed, body: match[2] || '', parseError: null };
    } catch (error) {
        return { frontmatter: null, body: match[2] || '', parseError: `yaml-parse-error: ${error.message}` };
    }
}

function normalizeFrontmatterDate(value) {
    if (value instanceof Date && Number.isFinite(value.getTime())) {
        return value.toISOString().slice(0, 10);
    }
    const text = String(value || '').trim();
    const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : null;
}

function classifyPage(relativePath, frontmatter) {
    const basename = path.basename(relativePath);
    const fm = frontmatter || {};
    const pageType = String(fm.paper_digest_page_type || '').trim();
    const isSummary = pageType === 'index'
        || pageType === 'conference'
        || DAILY_SUMMARY_FILE_RE.test(basename)
        || CONFERENCE_SUMMARY_FILE_RE.test(basename);
    const categories = Array.isArray(fm.categories) ? fm.categories.map(String) : [];
    const directPaperId = typeof fm.paper_digest_direct_paper_id === 'string' ? fm.paper_digest_direct_paper_id : '';
    const paperId = typeof fm.paper_digest_paper_id === 'string' ? fm.paper_digest_paper_id : '';
    const arxivId = typeof fm.paper_digest_arxiv_id === 'string' ? fm.paper_digest_arxiv_id : '';
    const isConference = fm.paper_digest_source_kind === 'conference'
        || pageType === 'conference'
        || Boolean(fm.paper_digest_conference_id)
        || directPaperId.startsWith('conference:')
        || paperId.startsWith('conference:')
        || CONFERENCE_PREFIX_RE.test(basename)
        || categories.some(cat => /(?:icassp|interspeech|icml|neurips|iclr|acl|emnlp|aaai|waspaa|ismir|会议)/i.test(cat));
    const scope = isConference ? 'conference' : 'daily';
    const dailyFileDate = (DAILY_SUMMARY_FILE_RE.exec(basename) || DAILY_PAPER_FILE_RE.exec(basename))?.[1] || null;
    const date = dailyFileDate || normalizeFrontmatterDate(fm.date);
    const canonicalPaperId = directPaperId || paperId || (arxivId ? `arxiv:${arxivId}` : null);
    return { scope, kind: isSummary ? 'summary' : 'paper', date, paperId: canonicalPaperId, arxivId: arxivId || null };
}

function isValidEmptyDailySummary(record, standards) {
    if (record.kind !== 'summary' || record.scope !== 'daily') return false;
    const fm = record.frontmatter || {};
    const body = String(record.body || '');
    const hasZeroPapersMarker = /共分析\s*\*\*0\*\*\s*篇论文/.test(body)
        || body.includes('今日没有新论文')
        || String(fm.description || '').trim() === '今日没有新论文';
    const hasEmptyTags = !Array.isArray(fm.tags) || fm.tags.length === 0;
    const hasReaderQuality = fm.paper_digest_reader_quality === standards.readerQualityContract;
    const hasLegacyTaxonomy = Object.keys(fm).some(key => key.startsWith('paper_digest_taxonomy_'));
    return hasZeroPapersMarker && hasEmptyTags && hasReaderQuality && !hasLegacyTaxonomy;
}

function evaluatePageOutdatedReasons(record, standards) {
    const { frontmatter, body, parseError, kind } = record;
    const reasons = [];
    if (parseError || !frontmatter) {
        reasons.push(parseError || 'missing-frontmatter');
        return reasons;
    }
    if (isValidEmptyDailySummary(record, standards)) {
        return reasons;
    }
    // 检查受控词表 SHA（单篇与汇总页通用）
    const hasLegacyTaxonomy = Object.keys(frontmatter).some(key => key.startsWith('paper_digest_taxonomy_'));
    const tagSha = typeof frontmatter.paper_digest_tags_registry_sha256 === 'string'
        ? frontmatter.paper_digest_tags_registry_sha256.trim() : '';
    if (hasLegacyTaxonomy || tagSha !== standards.tagsRegistrySha256) {
        reasons.push('outdated-tag-registry');
    }
    if (kind === 'summary') {
        const hasMonographBrief = /###\s*🧭\s*(?:今日|会议)研究脉络/.test(body);
        const hasReadingTiers = /###\s*🎯\s*三档阅读分级/.test(body);
        const hasSpotlight = /###\s*🌟\s*(?:今日|会议)精选焦点/.test(body);
        const hasReaderQuality = frontmatter.paper_digest_reader_quality === standards.readerQualityContract;
        const bodyChars = body.replace(/\s+/g, '').length;
        if (!hasMonographBrief || !hasReadingTiers || !hasSpotlight || !hasReaderQuality || bodyChars < 300) {
            reasons.push('legacy-short-summary');
        }
        return reasons;
    }
    // 单篇论文页面检查
    const readerFp = typeof frontmatter.paper_digest_api_reader_schema_fingerprint === 'string'
        ? frontmatter.paper_digest_api_reader_schema_fingerprint.trim() : '';
    const readerContract = typeof frontmatter.paper_digest_api_reader_contract === 'string'
        ? frontmatter.paper_digest_api_reader_contract.trim() : '';
    const acceptedReaderFps = Array.isArray(standards.acceptedReaderSchemaFingerprints)
        ? standards.acceptedReaderSchemaFingerprints
        : [standards.readerSchemaFingerprint];
    if (readerContract !== standards.readerContract || !acceptedReaderFps.includes(readerFp)) {
        reasons.push('missing-structured-pipeline-reader');
    }
    const rubricVersion = typeof frontmatter.paper_digest_scoring_rubric_version === 'string'
        ? frontmatter.paper_digest_scoring_rubric_version.trim() : '';
    const scoringContract = typeof frontmatter.paper_digest_scoring_contract === 'string'
        ? frontmatter.paper_digest_scoring_contract.trim() : '';
    const acceptedRubrics = Array.isArray(standards.acceptedScoringRubricVersions)
        ? standards.acceptedScoringRubricVersions
        : [standards.scoringRubricVersion];
    let hasUnifiedRubric = false;
    if (rubricVersion) {
        hasUnifiedRubric = acceptedRubrics.includes(rubricVersion)
            || scoringRubric.isUnifiedRubric(rubricVersion);
    } else {
        const escapeRe = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const contractMatches = acceptedRubrics.some(v => v
            && new RegExp(`(?:^|[^A-Za-z0-9])${escapeRe(v)}(?=$|[^\\w-])`, 'i').test(scoringContract));
        const bodyRubricMatch = /(?:^|\n)\s*[-*]?\s*评分规则\s*[：:]\s*type-aware(?:-v2)?(?=$|[^\w-])/i.test(body);
        const bodyScaleMatch = /八维.*0[–-]10|\/10\s*\|.*\/10\s*\|.*\/10/.test(body);
        hasUnifiedRubric = contractMatches || bodyRubricMatch || bodyScaleMatch;
    }
    if (!hasUnifiedRubric) {
        reasons.push('missing-type-aware-rubric');
    }
    const readerSections = frontmatter.paper_digest_reader_sections;
    if (!Array.isArray(readerSections) || readerSections.length === 0) {
        reasons.push('missing-reader-sections');
    }
    return reasons;
}

function collectMarkdownFiles(postsDir) {
    if (!fs.existsSync(postsDir)) {
        throw new Error(`博客文章目录不存在：${postsDir}`);
    }
    const results = [];
    const walk = current => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) continue;
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== '_index.md') {
                results.push(full);
            }
        }
    };
    walk(postsDir);
    return results.sort();
}

function buildRecommendedCommands(report) {
    const commands = [];
    const outdatedDailyPapers = report.outdatedPages.filter(page => page.scope === 'daily' && page.kind === 'paper');
    const outdatedPaperIds = [...new Set(outdatedDailyPapers.map(page => page.paperId).filter(Boolean))].sort();
    const dates = [...new Set(report.outdatedPages.filter(page => page.scope === 'daily' && page.date).map(page => page.date))].sort();
    if (outdatedDailyPapers.length > 0) {
        const dateHint = dates.length === 1 ? dates[0] : `${dates[0]}..${dates[dates.length - 1]}`;
        const paperIdsArg = outdatedPaperIds.length > 0 && outdatedPaperIds.length <= 20
            ? ` --paper-ids ${outdatedPaperIds.join(',')}`
            : ' --paper-ids <ARXIV_IDS_COMMA_SEPARATED>';
        commands.push({
            label: `日更 arXiv 范围重写（${dateHint}，${outdatedDailyPapers.length} 篇）`,
            steps: [
                'npm run history:inventory -- --apply --ledger <LEDGER_NAME.json> --receipt <RECEIPT_NAME.json>',
                'npm run history:inputs -- --apply --arxiv-only --inventory <INVENTORY_JSON> --blog-root <BLOG_REPO> --name scoped-arxiv.json',
                'npm run history:plan -- --apply --catalog <CATALOG_JSON> --inventory <INVENTORY_JSON>',
                `npm run history:sources -- --apply --plan <PLAN_JSON> --queue arxiv${paperIdsArg}`,
                `npm run history:run -- --apply --plan <PLAN_JSON> --queue arxiv${paperIdsArg}`,
                ...(dates.length === 1
                    ? [`npm run history:aggregate -- aggregate --apply --plan-file <PLAN_JSON> --registry-file <REGISTRY_JSON> --projection-file <PROJECTION_JSON> --daily ${dates[0]}`]
                    : ['npm run history:aggregate -- aggregate --apply --plan-file <PLAN_JSON> --registry-file <REGISTRY_JSON> --projection-file <PROJECTION_JSON> --daily <YYYY-MM-DD>']),
                `npm run history:publication -- plan --apply --publication-id <UUID> --plan-file <PLAN_JSON> --registry-file <REGISTRY_JSON> --projection-file <PROJECTION_JSON> --waive-visuals${paperIdsArg}`,
                `npm run history:publication -- generate --apply --publication-id <UUID> --plan-file <PLAN_JSON> --registry-file <REGISTRY_JSON> --projection-file <PROJECTION_JSON> --waive-visuals${paperIdsArg}`,
                'npm run history:publication -- review --apply --publication-id <UUID>',
                'npm run history:publication -- publish --apply --publication-id <UUID>',
                'npm run verify:web -- --historical-publication-id <UUID> --wait'
            ]
        });
    }
    const outdatedConference = report.outdatedPages.filter(page => page.scope === 'conference');
    if (outdatedConference.length > 0) {
        commands.push({
            label: `会议历史页面重写（${outdatedConference.length} 页）`,
            steps: [
                'npm run history:inventory -- --apply --ledger <LEDGER_NAME.json> --receipt <RECEIPT_NAME.json>',
                'npm run history:inputs -- --apply --conference-manifest <CONFERENCE_MANIFEST_JSON> --inventory <INVENTORY_JSON> --blog-root <BLOG_REPO> --name scoped-conference.json',
                'npm run history:plan -- --apply --catalog <CATALOG_JSON> --inventory <INVENTORY_JSON> --conference-projections <PROJECTION_JSON>',
                'npm run history:sources -- --apply --plan <PLAN_JSON> --queue conference',
                'npm run history:run -- --apply --plan <PLAN_JSON> --queue conference',
                'npm run history:aggregate -- aggregate --apply --plan-file <PLAN_JSON> --registry-file <REGISTRY_JSON> --projection-file <PROJECTION_JSON> --conference <CONFERENCE_KEY>',
                'npm run history:publication -- plan --apply --publication-id <UUID> --plan-file <PLAN_JSON> --registry-file <REGISTRY_JSON> --projection-file <PROJECTION_JSON> --waive-visuals',
                'npm run history:publication -- generate --apply --publication-id <UUID> --plan-file <PLAN_JSON> --registry-file <REGISTRY_JSON> --projection-file <PROJECTION_JSON> --waive-visuals',
                'npm run history:publication -- review --apply --publication-id <UUID>',
                'npm run history:publication -- publish --apply --publication-id <UUID>',
                'npm run verify:web -- --historical-publication-id <UUID> --wait'
            ]
        });
    }
    return commands;
}

function auditBlogPosts(options = {}) {
    const Config = options.config || require('./config.js');
    const blogRepo = path.resolve(options.blogRepo || Config.PUBLISH_CONFIG.blogRepo);
    const postsDir = path.join(blogRepo, 'content', 'posts');
    const standards = options.standards || currentStandards();
    const files = collectMarkdownFiles(postsDir);
    const allPages = [];
    for (const filename of files) {
        const relativePath = path.relative(blogRepo, filename).split(path.sep).join('/');
        const text = fs.readFileSync(filename, 'utf8');
        const parsed = parseFrontmatterAndBody(text);
        const classified = classifyPage(relativePath, parsed.frontmatter);
        const reasons = evaluatePageOutdatedReasons({ ...parsed, ...classified }, standards);
        allPages.push({
            path: relativePath,
            scope: classified.scope,
            kind: classified.kind,
            date: classified.date,
            paperId: classified.paperId,
            arxivId: classified.arxivId,
            outdated: reasons.length > 0,
            reasons
        });
    }

    // 计算每日完整批次信息（有 YYYY-MM-DD.md 汇总页且有单篇论文页）
    const dailyByDate = new Map();
    for (const page of allPages) {
        if (page.scope !== 'daily' || !page.date) continue;
        const entry = dailyByDate.get(page.date) || { date: page.date, summary: null, papers: [] };
        if (page.kind === 'summary') {
            if (DAILY_SUMMARY_FILE_RE.test(path.basename(page.path))) {
                entry.summary = page;
            }
        } else {
            entry.papers.push(page);
        }
        dailyByDate.set(page.date, entry);
    }

    const filtered = allPages.filter(page => {
        if (options.scope && options.scope !== 'all' && page.scope !== options.scope) return false;
        if (options.fromDate && (!page.date || page.date < options.fromDate)) return false;
        if (options.toDate && (!page.date || page.date > options.toDate)) return false;
        if (options.completeDaysOnly) {
            if (page.scope !== 'daily' || !page.date) return false;
            const cohort = dailyByDate.get(page.date);
            if (!cohort || !cohort.summary || cohort.papers.length === 0) return false;
        }
        return true;
    });

    const outdatedPages = filtered.filter(page => page.outdated);
    const reasonCounts = {};
    for (const page of outdatedPages) {
        for (const reason of page.reasons) {
            reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
        }
    }
    const dateCohorts = [...dailyByDate.values()]
        .filter(cohort => (!options.fromDate || cohort.date >= options.fromDate)
            && (!options.toDate || cohort.date <= options.toDate)
            && (!options.completeDaysOnly || (cohort.summary && cohort.papers.length > 0)))
        .map(cohort => {
            const outdatedPaperCount = cohort.papers.filter(p => p.outdated).length;
            const summaryOutdated = Boolean(cohort.summary?.outdated);
            return {
                date: cohort.date,
                completeDay: Boolean(cohort.summary && cohort.papers.length > 0),
                paperCount: cohort.papers.length,
                outdatedPaperCount,
                summaryOutdated,
                outdated: outdatedPaperCount > 0 || summaryOutdated,
                paperIds: cohort.papers.map(p => p.paperId).filter(Boolean).sort()
            };
        })
        .filter(cohort => cohort.outdated)
        .sort((a, b) => a.date.localeCompare(b.date));

    const report = {
        blogRepo,
        filters: {
            fromDate: options.fromDate || null,
            toDate: options.toDate || null,
            scope: options.scope || 'all',
            completeDaysOnly: Boolean(options.completeDaysOnly)
        },
        standards,
        scannedCount: filtered.length,
        upToDateCount: filtered.length - outdatedPages.length,
        outdatedCount: outdatedPages.length,
        reasonCounts,
        dateCohorts,
        outdatedPages
    };
    report.recommendedCommands = buildRecommendedCommands(report);
    return report;
}

function formatAuditReport(report) {
    const lines = [
        `历史博客规范审计（只读）：${report.blogRepo}`,
        `扫描范围：scope=${report.filters.scope}`
            + (report.filters.fromDate ? ` from=${report.filters.fromDate}` : '')
            + (report.filters.toDate ? ` to=${report.filters.toDate}` : '')
            + (report.filters.completeDaysOnly ? ' complete-days-only=true' : ''),
        `合计扫描 ${report.scannedCount} 页：最新 ${report.upToDateCount} 页，过时 ${report.outdatedCount} 页`
    ];
    if (Object.keys(report.reasonCounts).length > 0) {
        lines.push('过时原因统计：');
        for (const [reason, count] of Object.entries(report.reasonCounts).sort()) {
            lines.push(`  - ${reason}: ${count}`);
        }
    }
    if (report.dateCohorts.length > 0) {
        lines.push(`涉及待更新日更日期（${report.dateCohorts.length} 天）：`);
        for (const cohort of report.dateCohorts) {
            lines.push(`  - ${cohort.date}（单篇过时 ${cohort.outdatedPaperCount}/${cohort.paperCount}，汇总页${cohort.summaryOutdated ? '过时' : '最新'}${cohort.completeDay ? '，完整日批次' : ''}）`);
        }
    }
    if (report.recommendedCommands.length > 0) {
        lines.push('建议执行命令：');
        for (const group of report.recommendedCommands) {
            lines.push(`# ${group.label}`);
            for (const step of group.steps) lines.push(`  ${step}`);
        }
    }
    return lines.join('\n');
}

function main(argv = process.argv.slice(2), deps = {}) {
    requireExternalRuntime('historical-outdated-audit.js');
    const print = typeof deps.print === 'function' ? deps.print : line => console.log(line);
    const options = parseArgs(argv);
    if (options.help) {
        print(USAGE);
        return { help: true };
    }
    const report = auditBlogPosts({ ...options, config: deps.config, standards: deps.standards });
    if (options.json) print(JSON.stringify(report, null, 2));
    else print(formatAuditReport(report));
    return report;
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`[historical-outdated-audit] ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    USAGE,
    currentStandards,
    parseArgs,
    parseFrontmatterAndBody,
    classifyPage,
    evaluatePageOutdatedReasons,
    auditBlogPosts,
    formatAuditReport,
    main
};
