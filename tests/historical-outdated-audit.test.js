'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const audit = require('../scripts/historical-outdated-audit.js');

function writePost(blogRepo, filename, content) {
    const target = path.join(blogRepo, 'content', 'posts', filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
}

function modernPaperMarkdown(standards, { date = '2026-11-20', arxivId = '2611.00001', title = 'Modern Paper' } = {}) {
    return [
        '---',
        `title: "${title}"`,
        `date: ${date}`,
        'draft: false',
        'categories: [论文速递]',
        'paper_digest_pipeline_owned: true',
        'paper_digest_page_type: paper',
        `paper_digest_arxiv_id: "${arxivId}"`,
        `paper_digest_api_reader_contract: "${standards.readerContract}"`,
        `paper_digest_api_reader_schema_fingerprint: "${standards.readerSchemaFingerprint}"`,
        `paper_digest_scoring_rubric_version: "${standards.scoringRubricVersion}"`,
        `paper_digest_tags_registry_sha256: "${standards.tagsRegistrySha256}"`,
        'paper_digest_reader_sections:',
        '  - id: s1',
        '    heading: 问题背景',
        '---',
        '',
        '# 现代单篇页面',
        ''
    ].join('\n');
}

function modernSummaryMarkdown(standards, { date = '2026-11-20' } = {}) {
    return [
        '---',
        `title: "音频研究日报 ${date}"`,
        `date: ${date}`,
        'draft: false',
        'categories: [论文速递]',
        'layout: "posts"',
        'paper_digest_pipeline_owned: true',
        'paper_digest_page_type: index',
        `paper_digest_reader_quality: "${standards.readerQualityContract}"`,
        `paper_digest_tags_registry_sha256: "${standards.tagsRegistrySha256}"`,
        '---',
        '',
        `# 音频研究日报 ${date}`,
        '',
        '### 🧭 今日研究脉络',
        '- 焦点方向与开源快照描述，长度充足以确保通过 Studio Monograph 2.0 现代汇总页规范检查。'.repeat(6),
        '',
        '### 🎯 三档阅读分级',
        '- 🔥 精读必看',
        '',
        '### 🌟 今日精选焦点',
        '> 🥇 焦点卡片',
        ''
    ].join('\n');
}

test('G1: historical-outdated-audit 识别过时单篇与旧汇总页、支持过滤并输出可执行重写命令', t => {
    const blogRepo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-outdated-audit-'));
    t.after(() => fs.rmSync(blogRepo, { recursive: true, force: true }));
    const standards = audit.currentStandards();

    // 1. 2026-11-20：完全符合当前规范的完整日批次（含当前版本与已归档 v5/type-aware-v2 兼容页，均不应被标记过时）
    writePost(blogRepo, '2026-11-20.md', modernSummaryMarkdown(standards, { date: '2026-11-20' }));
    writePost(blogRepo, '2026-11-20-modern-paper.md', modernPaperMarkdown(standards, { date: '2026-11-20', arxivId: '2611.00001' }));
    writePost(blogRepo, '2026-11-20-archived-v5-paper.md', modernPaperMarkdown({
        ...standards,
        readerSchemaFingerprint: require('../scripts/lib/reader-record-format.js').V5_PLAN_FP,
        scoringRubricVersion: 'type-aware-v2'
    }, { date: '2026-11-20', arxivId: '2611.00002', title: 'Archived V5 Paper' }));

    // 2. 2026-03-10：过时的完整日批次（单篇缺 v5/type-aware-v2/reader_sections/旧词表 + 旧短汇总）
    writePost(blogRepo, '2026-03-10.md', [
        '---',
        'title: "音频研究日报 2026-03-10"',
        'date: 2026-03-10',
        'draft: false',
        'categories: [论文速递]',
        'paper_digest_page_type: index',
        'paper_digest_taxonomy_registry_sha256: "0000000000000000000000000000000000000000000000000000000000000000"',
        '---',
        '',
        '# 旧短汇总',
        ''
    ].join('\n'));
    writePost(blogRepo, '2026-03-10-old-paper.md', [
        '---',
        'title: "Legacy Paper"',
        'date: 2026-03-10',
        'draft: false',
        'categories: [论文速递]',
        'paper_digest_page_type: paper',
        'paper_digest_arxiv_id: "2603.00001"',
        'paper_digest_api_reader_contract: "beginner-researcher-v3"',
        'paper_digest_taxonomy_registry_sha256: "0000000000000000000000000000000000000000000000000000000000000000"',
        '---',
        '',
        '# 旧单篇',
        ''
    ].join('\n'));

    // 3. 2026-03-12：缺少汇总页的残缺日批次
    writePost(blogRepo, '2026-03-12-orphan-paper.md', [
        '---',
        'title: "Orphan Old Paper"',
        'date: 2026-03-12',
        'draft: false',
        'categories: [论文速递]',
        'paper_digest_page_type: paper',
        'paper_digest_arxiv_id: "2603.00002"',
        '---',
        '',
        '# 缺汇总的旧单篇',
        ''
    ].join('\n'));

    // 4. 会议过时页面
    writePost(blogRepo, 'icassp2026-paper-100.md', [
        '---',
        'title: "Legacy Conference Paper"',
        'date: 2026-05-01',
        'draft: false',
        'categories: [ICASSP-2026 论文]',
        'paper_digest_page_type: paper',
        'paper_digest_direct_paper_id: "conference:icassp:2026:icassp-arnumber:100"',
        '---',
        '',
        '# 旧会议论文',
        ''
    ].join('\n'));

    const all = audit.auditBlogPosts({ blogRepo, standards });
    assert.equal(all.scannedCount, 7);
    assert.equal(all.upToDateCount, 3);
    assert.equal(all.outdatedCount, 4);

    const oldPaper = all.outdatedPages.find(p => p.path === 'content/posts/2026-03-10-old-paper.md');
    assert.ok(oldPaper);
    assert.ok(oldPaper.reasons.includes('missing-structured-pipeline-reader'));
    assert.ok(oldPaper.reasons.includes('missing-type-aware-rubric'));
    assert.ok(oldPaper.reasons.includes('outdated-tag-registry'));
    assert.ok(oldPaper.reasons.includes('missing-reader-sections'));

    const oldSummary = all.outdatedPages.find(p => p.path === 'content/posts/2026-03-10.md');
    assert.ok(oldSummary);
    assert.ok(oldSummary.reasons.includes('legacy-short-summary'));
    assert.ok(oldSummary.reasons.includes('outdated-tag-registry'));

    // --complete-days-only + 日期过滤：排除 2026-03-12 残缺日和会议页
    const completeOnly = audit.auditBlogPosts({
        blogRepo, standards, scope: 'daily', fromDate: '2026-03-01', toDate: '2026-03-31', completeDaysOnly: true
    });
    assert.equal(completeOnly.scannedCount, 2);
    assert.equal(completeOnly.outdatedCount, 2);
    assert.deepEqual(completeOnly.dateCohorts.map(c => c.date), ['2026-03-10']);
    assert.ok(completeOnly.recommendedCommands.some(group => group.steps.some(s => s.includes('--arxiv-only'))));
    assert.ok(completeOnly.recommendedCommands.some(group => group.steps.some(s => s.includes('--waive-visuals'))));
    assert.ok(completeOnly.recommendedCommands.some(group => group.steps.some(s => s.includes('--historical-publication-id'))));

    // --scope conference 只扫描会议页
    const confOnly = audit.auditBlogPosts({ blogRepo, standards, scope: 'conference' });
    assert.equal(confOnly.scannedCount, 1);
    assert.equal(confOnly.outdatedCount, 1);
    assert.equal(confOnly.outdatedPages[0].paperId, 'conference:icassp:2026:icassp-arnumber:100');

    // CLI --json 解析验证
    const printed = [];
    const cliReport = audit.main(['--blog-repo', blogRepo, '--scope', 'daily', '--complete-days-only', '--json'], {
        standards,
        print: line => printed.push(line)
    });
    assert.equal(cliReport.outdatedCount, 2);
    assert.equal(JSON.parse(printed[0]).outdatedCount, 2);
});
