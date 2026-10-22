'use strict';
// 稳定错误码字典：code/标签/可重试性/建议入口/文档锚点，与 error-guidance 的规则 id 对齐。

const ENTRIES = Object.freeze([
    { id: 'arxiv-rate-limit', label: 'arXiv 限流（429）', retryable: true, command: 'npm run source:probe -- --date <DATE>', doc: 'docs/troubleshooting.md' },
    { id: 'upstream-rate-limit', label: '上游/模型服务限流（429）', retryable: true, command: 'npm run recover -- --date <DATE>', doc: 'docs/troubleshooting.md' },
    { id: 'official-oai-rss-stale', label: '官方 OAI/RSS 公告未生成', retryable: true, command: 'npm run source:probe -- --date <DATE>', doc: 'docs/daily-fetch-boundary.md' },
    { id: 'llm-account-pool', label: '模型账号池耗尽/余额不足', retryable: true, command: 'npm run llm:accounts', doc: 'docs/setup.md' },
    { id: 'reader-repair-no-progress', label: 'Reader 同组问题无进展', retryable: false, command: 'npm run recover -- --date <DATE>', doc: 'docs/reader-explicit-retry.md' },
    { id: 'reader-operator-correction-rejected', label: 'Reader 人工修正被拒', retryable: false, command: 'npm run recover -- --date <DATE>', doc: 'docs/reader-explicit-retry.md' },
    { id: 'reader-table-adhesion', label: '表格单元格粘连复写', retryable: false, command: 'npm run table:check -- --draft <FILE>', doc: 'docs/maintenance.md' },
    { id: 'reader-table-header-units', label: '表头单位缺少来源证据', retryable: false, command: 'npm run table:check -- --draft <FILE>', doc: 'docs/maintenance.md' },
    { id: 'reader-ablation-missing', label: '缺少消融/组件对照', retryable: false, command: 'npm run recover -- --date <DATE>', doc: 'docs/reader-explicit-retry.md' },
    { id: 'blog-repository-dirty', label: '博客仓库有清单外改动', retryable: false, command: 'git -C "$PAPER_DIGEST_BLOG_REPO" status --porcelain', doc: 'docs/maintenance.md' },
    { id: 'paper-lock-busy', label: '论文/运行锁被占用', retryable: true, command: 'npm run locks', doc: 'docs/troubleshooting.md' },
    { id: 'source-sha-mismatch', label: '封存来源 SHA 不一致', retryable: false, command: 'npm run validate:data', doc: 'docs/data-format.md#日更来源的保存与核验' },
    { id: 'generation-snapshot-stale', label: '生成快照未随 Reader 更新', retryable: true, command: 'npm run blog:generate -- --date <DATE>', doc: 'docs/troubleshooting.md' },
    { id: 'blog-push-guard', label: '推送前审查/状态门禁未通过', retryable: false, command: 'npm run digest:status -- --date <DATE>', doc: 'docs/data-format.md' },
    { id: 'config-invalid', label: '配置缺失或非法', retryable: false, command: 'npm run config:check', doc: 'docs/setup.md' },
    { id: 'generic-fallback', label: '未分类失败', retryable: false, command: 'npm run digest:status -- --date <DATE>', doc: 'docs/troubleshooting.md' }
]);

const BY_ID = new Map(ENTRIES.map(entry => [entry.id, entry]));

const PATTERNS = [
    { id: 'config-invalid', regex: /config|配置|missing (?:api|model|endpoint)|缺少 PAPER_ANALYZER/i },
    { id: 'llm-account-pool', regex: /account.?pool|账号池|gousagelimiterror|insufficient[_\s-]?balance|余额不足/i },
    { id: 'paper-lock-busy', regex: /lock|锁|busy|held|timeout.*lock/i },
    { id: 'source-sha-mismatch', regex: /sha-?256.*(?:mismatch|不一致)|来源.*(?:sha|哈希).*不一致/i },
    { id: 'blog-repository-dirty', regex: /uncommitted|未提交|清单外.*改动|dirty/i },
    { id: 'reader-table-adhesion', regex: /粘连|复写|duplicat/i },
    { id: 'reader-table-header-units', regex: /列头单位|header unit|单位缺少.*证据/i },
    { id: 'reader-ablation-missing', regex: /消融|ablation/i },
    { id: 'reader-operator-correction-rejected', regex: /操作员|operator|人工修正.*拒绝/i },
    { id: 'reader-repair-no-progress', regex: /无进展|no.?progress/i },
    { id: 'official-oai-rss-stale', regex: /oai|rss|公告未生成|pubdate/i },
    { id: 'arxiv-rate-limit', regex: /arxiv.*(?:429|rate|限流)|429.*arxiv/i },
    { id: 'upstream-rate-limit', regex: /429|rate.?limit|too many requests/i },
    { id: 'generation-snapshot-stale', regex: /快照|snapshot/i },
    { id: 'generation-snapshot-stale', regex: /清单.*(?:删除|状态|不一致)|manifest.*(?:delete|stale|inconsistent)|生成快照|snapshot/i },
    { id: 'blog-push-guard', regex: /推送|push|审查凭证|review receipt|hugo|preflight|渲染失败|视觉规划/i }
];

function classify(text) {
    const value = String(text || '');
    for (const rule of PATTERNS) {
        if (rule.regex.test(value)) return BY_ID.get(rule.id);
    }
    return BY_ID.get('generic-fallback');
}

function describe(id) {
    return BY_ID.get(id) || BY_ID.get('generic-fallback');
}

module.exports = { ENTRIES, PATTERNS, BY_ID, classify, describe };
