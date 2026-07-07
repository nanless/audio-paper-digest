const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
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
