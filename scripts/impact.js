#!/usr/bin/env node
'use strict';
// 改一个文件/目录会影响哪些入口、测试与需要重验的范围（静态映射，只读）。
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

const MAP = [
    { match: /(?:^|\/)scripts\/lib\/reader-|scripts\/deep-analyzer\.js|scripts\/analysis-contract\.js/, entries: ['deep', 'batch', 'reanalyze', 'api:reader:refresh'], scope: 'Reader/表格校验；历史已签稿需按当前规则重验，相关缓存不可直接复用', tests: ['tests/reader-*', 'tests/deep-analyzer*'] },
    { match: /(?:^|\/)scripts\/publish_common\.py|scripts\/publish-to-blog\.py/, entries: ['blog:generate', 'blog:review', 'blog:push', 'conference:publish:*', 'history:publication'], scope: '发布渲染/校验；页面需重新生成并按内容 SHA 重审', tests: ['tests/python/test_publish_*', 'tests/documentation.test.js'] },
    { match: /(?:^|\/)scripts\/llm-account-pool\.js|scripts\/llm_account_pool\.py|scripts\/utils\.js/, entries: ['deep', 'batch', 'reanalyze', 'api:reader:refresh', 'blog:review', 'blog:push'], scope: '所有 ND 模型请求；账号池冷却/轮转状态保留，不需重分析', tests: ['tests/llm-account-pool*', 'tests/python/test_llm_account_pool.py'] },
    { match: /(?:^|\/)scripts\/log-setup\.js|scripts\/log_setup\.py|scripts\/lib\/error-guidance/, entries: ['*'], scope: '日志/错误展示；不改变业务数据与已通过结果', tests: ['tests/log-setup*', 'tests/error-guidance*'] },
    { match: /(?:^|\/)scripts\/digest-run-report\.js|scripts\/lib\/digest-live-status\.js|scripts\/lib\/llm-usage-summary\.js/, entries: ['digest:status'], scope: '状态报告/费用汇总；不影响发布资格', tests: ['tests/digest-run-report*', 'tests/llm-usage-summary.test.js'] },
    { match: /(?:^|\/)scripts\/doctor\.js|scripts\/config-check\.js|scripts\/lib\/env-schema\.js/, entries: ['doctor', 'config:check'], scope: '只读体检/配置检查；不触碰数据', tests: ['tests/doctor.test.js', 'tests/config-check.test.js', 'tests/env-schema.test.js'] },
    { match: /(?:^|\/)scripts\/full-fetch\.js|scripts\/source-probe\.js/, entries: ['digest:prepare', 'fetch', 'source:probe'], scope: '抓取/筛选；失败集合与已发布页去重需按检查点复核', tests: ['tests/full-fetch*', 'tests/source-acquisition-policy.test.js'] },
    { match: /(?:^|\/)scripts\/analysis-engine\.js|scripts\/lib\/daily-fresh-source-plan\.js/, entries: ['deep', 'batch', 'reanalyze', 'api:reader:refresh', 'digest:prepare'], scope: '分析引擎/日更来源计划；断点、失败轮次与费用需按原清单复核', tests: ['tests/analysis-*', 'tests/daily-fresh-source-*', 'tests/full-fetch*'] },
    { match: /(?:^|\/)scripts\/(?:recover|manifest-new|table-check|impact|source-probe|config-check|llm-accounts-report|verify-web|publish-finish|locks|docs-consistency)\.js|scripts\/lib\/(?:error-codes|source-acquisition-policy|env-schema|review-overrides)\.js/, entries: ['recover', 'manifest:new', 'table:check', 'impact', 'source:probe', 'config:check', 'llm:accounts', 'verify:web', 'publish:finish', 'locks', 'docs:check'], scope: '运行辅助工具；只影响诊断/清单/验收命令，不改变正式分析与发布数据', tests: ['tests/*'] }
];

function expandTargets(target) {
    const absolute = path.resolve(ROOT, target);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) return [String(target)];
    const files = [];
    const walk = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const next = path.join(directory, entry.name);
            if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(next); }
            else files.push(path.relative(ROOT, next));
        }
    };
    walk(absolute);
    return files;
}

function impactOf(target) {
    const normalizedTarget = String(target || '').replace(/\\/g, '/');
    const targets = expandTargets(normalizedTarget);
    const normalized = targets.join('\n');
    const found = MAP.filter(rule => rule.match.test(normalized));
    if (!found.length) return { target: normalized, matched: false, entries: [], scope: '未命中静态映射：按通用规则跑定向测试与受影响入口', tests: [] };
    return {
        target: normalizedTarget, matched: true,
        entries: [...new Set(found.flatMap(rule => rule.entries))],
        scope: found.map(rule => rule.scope).join('；'),
        tests: [...new Set(found.flatMap(rule => rule.tests))]
    };
}

function main(argv = process.argv.slice(2)) {
    try { require('./env-loader').requireExternalRuntime('impact.js'); } catch (error) { console.error(`[impact] ${error.message}`); return 1; }

    const target = argv.find(value => !value.startsWith('--'));
    const json = argv.includes('--json');
    if (!target || argv.includes('--help')) {
        console.log('用法: node scripts/impact.js <file-or-dir> [--json]');
        return target ? 0 : 2;
    }
    const result = impactOf(target);
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
        console.log(`影响分析：${result.target}`);
        console.log(`入口：${result.entries.length ? result.entries.join(', ') : '（未命中）'}`);
        console.log(`范围：${result.scope}`);
        if (result.tests.length) console.log(`建议测试：${result.tests.join(', ')}`);
    }
    return 0;
}

module.exports = { MAP, impactOf, main };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[impact] ${error.message}`); process.exitCode = 2; }
}
