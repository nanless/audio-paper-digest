'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Config = require('../scripts/config.js');
const { fetchHuggingFacePapers } = require('../scripts/fetch-huggingface-papers.js');
const fullFetch = require('../scripts/full-fetch.js');

function paper(overrides = {}) {
    return {
        id: '2610.12345',
        title: 'Speech recognition',
        summary: 'An audio model.',
        publishedAt: new Date().toISOString(),
        authors: [{ name: 'Author' }],
        ...overrides
    };
}

function fetchRows(endpoint, rows) {
    return fetchHuggingFacePapers(new Set(), {
        days: 7,
        minUpvotes: 0,
        sleepFn: async () => {},
        fetchFn: async url => {
            const daily = url.includes('/daily_papers?');
            if (daily !== (endpoint === 'daily_papers')) return [];
            return daily ? rows.map(item => ({ paper: item, publishedAt: item.publishedAt })) : rows;
        }
    });
}

for (const endpoint of ['daily_papers', 'papers']) {
    test(`${endpoint} 损坏条目不能与合法条目一起声明来源完整`, async () => {
        for (const overrides of [
            { id: 'not-an-arxiv-id' },
            { id: '   ' },
            { id: 12345 },
            { id: ['2610.12345'] },
            { id: 'arxiv:2610.12345' },
            { id: 'https://arxiv.org/abs/2610.12345' },
            { id: 'math.gt/0309136' },
            { id: '2610.12345v0' },
            { id: '2610.12345v01' },
            { title: '' },
            { title: ' \n ' },
            { title: ['Speech'] },
            { summary: '' },
            { summary: '\t' },
            { summary: { text: 'Audio' } }
        ]) {
            await assert.rejects(fetchRows(endpoint, [paper({ id: '2610.99999' }), paper(overrides)]),
                error => error.code === 'SOURCE_FETCH_FAILED'
                    && error.sourceHealth.ok === false
                    && error.sourceHealth.failures.some(item => /响应包含非法论文条目/.test(item.error)),
                JSON.stringify(overrides));
        }
    });

    test(`${endpoint} 保留现代和旧式编号、显式版本及题摘原字节`, async () => {
        const ids = ['2610.1234', '2610.12345v2', 'hep-th/9901001v3', 'math.GT/0309136v1'];
        const rows = ids.map(id => paper({ id, title: '  数学与语音  ', summary: '原摘要\n第二行' }));
        const result = await fetchRows(endpoint, rows);
        assert.equal(result._sourceHealth.ok, true);
        assert.deepEqual(result.map(item => item.paper_id), ids);
        for (const item of result) {
            assert.equal(item.title, '  数学与语音  ');
            assert.equal(item.abstract, '原摘要\n第二行');
            assert.equal(item.pdfLink, `https://arxiv.org/pdf/${item.paper_id}`);
        }
    });
}

test('papers 重复ID页也必须先核题摘，不能当作正常分页终点', async () => {
    const rows = Array.from({ length: Config.HUGGINGFACE_CONFIG.pageLimit }, (_, index) =>
        paper({ id: `2610.${String(index).padStart(5, '0')}` }));
    await assert.rejects(fetchHuggingFacePapers(new Set(), {
        days: 7,
        minUpvotes: 0,
        sleepFn: async () => {},
        fetchFn: async url => {
            if (url.includes('daily_papers')) return [];
            return url.includes('offset=0') ? rows : rows.map(item => ({ ...item, summary: '' }));
        }
    }), error => error.code === 'SOURCE_FETCH_FAILED' && error.sourceHealth.ok === false);
});

test('来源v5抓取检查点不能复用，新契约的原样检查点可以续跑', () => {
    // v5固定来源协议形状：旧候选SHA自洽也不代表条目已按新规则核验。
    const sourceConfigFingerprint = fullFetch.stableHash({
        sourceContractVersion: 5,
        arxivCategories: Config.ARXIV_CATEGORIES.map(({ id, priority }) => ({ id, priority })),
        arxiv: {
            maxResultsPerCategory: Config.ARXIV_CONFIG.maxResultsPerCategory,
            consecutiveExistingThreshold: Config.ARXIV_CONFIG.consecutiveExistingThreshold,
            explicitPageSize: 50,
            mergeCrossCategoryMembership: true
        },
        huggingface: {
            days: Config.HUGGINGFACE_CONFIG.defaultDays,
            minUpvotes: Config.HUGGINGFACE_CONFIG.defaultMinUpvotes,
            maxPages: Config.HUGGINGFACE_CONFIG.maxPages,
            pageLimit: Config.HUGGINGFACE_CONFIG.pageLimit,
            paginatePapersApi: true,
            dailyCutoffField: 'hfSelectedAt'
        }
    });
    const emptySetSha = fullFetch.stableHash([]);
    const oldCandidate = fullFetch.stableHash({
        sourceConfigFingerprint,
        blogDedupFingerprint: emptySetSha,
        historyFingerprint: emptySetSha
    });
    const current = fullFetch.buildCandidateFingerprints(new Set(), new Set());
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-checkpoint-contract-'));
    const filename = path.join(root, 'checkpoint.json');
    const date = '2026-10-09';
    try {
        const checkpoint = {
            batchDate: date,
            timestamp: `${date}T12:00:00+08:00`,
            candidateFingerprint: oldCandidate,
            historicalDedupIds: [],
            categoryOrder: [],
            arxiv: {},
            huggingface: {
                status: 'complete',
                papers: [paper()],
                health: { ok: true }
            }
        };
        fullFetch.saveFetchCheckpoint(checkpoint, filename);
        const original = fs.readFileSync(filename);
        assert.equal(fullFetch.loadFetchCheckpoint(date, current.candidateFingerprint, filename), null);
        assert.deepEqual(fs.readFileSync(filename), original);
        checkpoint.candidateFingerprint = current.candidateFingerprint;
        fullFetch.saveFetchCheckpoint(checkpoint, filename);
        assert.equal(fullFetch.loadFetchCheckpoint(date, current.candidateFingerprint, filename)
            .huggingface.papers.length, 1);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
