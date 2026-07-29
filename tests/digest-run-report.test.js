const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
    parseDate,
    sourceHealthComplete,
    samePaperIds
} = require('../scripts/digest-run-report.js');
const Config = require('../scripts/config.js');

describe('digest run report', () => {
    it('严格解析批次日期', () => {
        assert.strictEqual(parseDate(['--date', '2026-07-29']), '2026-07-29');
        assert.throws(() => parseDate(['--date', '2026-02-30']), /日期非法/);
        assert.throws(() => parseDate([]), /用法/);
    });

    it('抓取健康必须覆盖配置中的全部来源', () => {
        const raw = {
            batchDate: '2026-07-29',
            papers: [{ arxivId: '2607.1' }],
            sourceHealth: {
                arxiv: {
                    ok: true,
                    categories: Config.ARXIV_CATEGORIES.map(item => ({ id: item.id, ok: true }))
                },
                huggingface: { ok: true }
            }
        };
        assert.strictEqual(sourceHealthComplete(raw, '2026-07-29'), true);
        raw.sourceHealth.arxiv.categories.pop();
        assert.strictEqual(sourceHealthComplete(raw, '2026-07-29'), false);
        raw.sourceHealth.arxiv.categories = Config.ARXIV_CATEGORIES.map(() => ({ id: 'eess.AS', ok: true }));
        assert.strictEqual(sourceHealthComplete(raw, '2026-07-29'), false);
    });

    it('分析集合必须按规范化论文 ID 精确覆盖筛选集合', () => {
        assert.strictEqual(
            samePaperIds([{ arxivId: '2607.1v2' }], [{ arxivId: '2607.1' }]),
            true
        );
        assert.strictEqual(
            samePaperIds([{ arxivId: '2607.1' }], [{ arxivId: '2607.2' }]),
            false
        );
        assert.strictEqual(
            samePaperIds([{ arxivId: '2607.1' }, { arxivId: '2607.1v2' }], [{ arxivId: '2607.1' }]),
            false
        );
    });
});
