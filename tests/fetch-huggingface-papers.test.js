const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
    fetchHuggingFacePapers,
    mergeAndDeduplicate,
    convertDailyPaper,
    convertPaper
} = require('../scripts/fetch-huggingface-papers.js');

describe('mergeAndDeduplicate', () => {
    it('按 normalizedId 合并 arXiv 与 HuggingFace 版本号差异', () => {
        const merged = mergeAndDeduplicate([
            {
                paper_id: '2604.12345v1',
                arxivId: '2604.12345v1',
                title: 'arxiv version',
                summary: ''
            }
        ], [
            {
                paper_id: '2604.12345v2',
                arxivId: '2604.12345v2',
                title: 'hf version',
                summary: 'HF summary',
                hf_upvotes: 12,
                hf_ai_summary: 'AI',
                hf_ai_keywords: ['audio'],
                hf_github_repo: 'repo',
                hf_project_page: 'page',
                hf_github_stars: 3,
                hf_discussion_id: 'disc'
            }
        ]);

        assert.strictEqual(merged.length, 1);
        assert.deepStrictEqual(merged[0].sources, ['arxiv', 'huggingface']);
        assert.strictEqual(merged[0].paper_id, '2604.12345v1');
        assert.strictEqual(merged[0].summary, 'HF summary');
        assert.strictEqual(merged[0].hf_upvotes, 12);
    });
});

describe('HuggingFace date guards', () => {
    it('缺少 publishedAt 的 daily paper 会被跳过', () => {
        const paper = convertDailyPaper({
            paper: {
                id: '2604.10000',
                title: 'No date',
                authors: []
            }
        });
        assert.strictEqual(paper, null);
    });

    it('缺少 publishedAt 的 papers API 记录会被跳过', () => {
        const paper = convertPaper({
            id: '2604.10001',
            title: 'No date',
            authors: []
        });
        assert.strictEqual(paper, null);
    });
});

describe('HuggingFace 抓取健康状态', () => {
    it('默认 HuggingFace 抓取缺少项目代理时拒绝直连', async () => {
        const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
        const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
        try {
            for (const key of keys) delete process.env[key];
            await assert.rejects(
                fetchHuggingFacePapers(),
                /必须通过当前项目.*代理|拒绝直连/
            );
        } finally {
            for (const key of keys) {
                if (original[key] === undefined) delete process.env[key];
                else process.env[key] = original[key];
            }
        }
    });

    it('所有 API 请求失败时抛出带健康状态的异常', async () => {
        await assert.rejects(
            fetchHuggingFacePapers(new Set(), {
                days: 7,
                minUpvotes: 0,
                fetchFn: () => ({ ok: false, data: null, error: 'network down' }),
                sleepFn: async () => {}
            }),
            error => error.code === 'SOURCE_FETCH_FAILED'
                && error.sourceHealth.allFailed === true
                && error.sourceHealth.attempts === 2
                && error.sourceHealth.successfulRequests === 0
        );
    });

    it('两个 API 均成功返回空数组时是合法空结果', async () => {
        const papers = await fetchHuggingFacePapers(new Set(), {
            days: 7,
            minUpvotes: 0,
            fetchFn: () => ({ ok: true, data: [], error: null }),
            sleepFn: async () => {}
        });

        assert.deepStrictEqual(papers, []);
        assert.strictEqual(papers._sourceHealth.ok, true);
        assert.strictEqual(papers._sourceHealth.allFailed, false);
        assert.strictEqual(papers._sourceHealth.attempts, 2);
        assert.strictEqual(papers._sourceHealth.successfulRequests, 2);
    });

    it('一个 API 失败、另一个成功为空时保留部分失败诊断但不误报全失败', async () => {
        const papers = await fetchHuggingFacePapers(new Set(), {
            days: 7,
            minUpvotes: 0,
            fetchFn: url => url.includes('daily_papers')
                ? { ok: false, data: null, error: 'daily unavailable' }
                : { ok: true, data: [], error: null },
            sleepFn: async () => {}
        });

        assert.strictEqual(papers._sourceHealth.ok, true);
        assert.strictEqual(papers._sourceHealth.allFailed, false);
        assert.strictEqual(papers._sourceHealth.failures.length, 1);
    });
});
