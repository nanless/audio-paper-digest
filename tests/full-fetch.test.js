const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('full-fetch helpers', () => {
    it('模块可安全导入且不会自动启动长流程', () => {
        const mod = require('../scripts/full-fetch.js');
        assert.strictEqual(typeof mod.fullFetch, 'function');
        assert.strictEqual(typeof mod.loadCompleteFilteredForToday, 'function');
    });

    it('sourceHealth 汇总保留来源状态', () => {
        const { buildSourceHealth } = require('../scripts/full-fetch.js');
        const health = buildSourceHealth(
            {
                arxiv: { categories: [{ id: 'cs.SD', fetched: 2, ok: true }] },
                huggingface: { ok: true, fetched: 1 }
            },
            [{ arxivId: '1' }, { arxivId: '2' }],
            [{ arxivId: '3' }]
        );

        assert.strictEqual(health.arxiv.totalFetched, 2);
        assert.strictEqual(health.huggingface.totalFetched, 1);
        assert.strictEqual(health.arxiv.categories[0].id, 'cs.SD');
        assert.match(health.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    });

    it('续跑统计可从 sourceHealth 恢复抓取数量', () => {
        const { getSourceFetchedCount } = require('../scripts/full-fetch.js');
        assert.strictEqual(getSourceFetchedCount({ arxiv: { totalFetched: 12 } }, 'arxiv', 0), 12);
        assert.strictEqual(getSourceFetchedCount({ huggingface: { fetched: 3 } }, 'huggingface', 0), 3);
        assert.strictEqual(getSourceFetchedCount({}, 'arxiv', 7), 7);
    });

    it('只复用今日 complete 的 filtered-papers 文件', () => {
        const { loadCompleteFilteredForToday } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-filtered-'));
        const file = path.join(dir, 'filtered-papers.json');

        fs.writeFileSync(file, JSON.stringify({
            timestamp: '2026-07-08T10:00:00+08:00',
            status: 'complete',
            papers: [{ arxivId: '2607.00001' }]
        }));
        assert.strictEqual(loadCompleteFilteredForToday('2026-07-08', file).papers.length, 1);

        fs.writeFileSync(file, JSON.stringify({
            timestamp: '2026-07-08T10:00:00+08:00',
            status: 'filtering',
            papers: [{ arxivId: '2607.00001' }]
        }));
        assert.strictEqual(loadCompleteFilteredForToday('2026-07-08', file), null);
        assert.strictEqual(loadCompleteFilteredForToday('2026-07-09', file), null);
    });
});
