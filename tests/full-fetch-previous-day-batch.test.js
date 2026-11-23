const test = require('node:test');
const assert = require('node:assert/strict');
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const full = require('../scripts/full-fetch.js');
const at = value => new Date(value);

test('跨零点补跑只接受显式授权且限定 0–8 点与上一自然日', () => {
    const midnight = at('2026-11-17T00:40:00+08:00');
    assert.deepEqual(full.resolveBatchDateOverride({ requested: '2026-11-17', now: midnight }),
        { date: '2026-11-17', overridden: false });
    assert.deepEqual(full.resolveBatchDateOverride({ requested: '2026-11-16', now: midnight, allowPreviousDayDate: true }),
        { date: '2026-11-16', overridden: true });
    assert.match(full.resolveBatchDateOverride({ requested: '2026-11-16', now: midnight }).error, /--allow-previous-day-date/);
    assert.match(full.resolveBatchDateOverride({ requested: '2026-11-16', now: at('2026-11-17T09:00:00+08:00'),
        allowPreviousDayDate: true }).error, /0–8/);
    assert.match(full.resolveBatchDateOverride({ requested: '2026-11-15', now: midnight,
        allowPreviousDayDate: true }).error, /抓取启动日期已变化/);
});

test('参数解析把 --allow-previous-day-date 当作布尔开关', () => {
    assert.equal(full.parseFullFetchArgs(['--allow-previous-day-date']).allowPreviousDayDate, true);
    assert.equal(full.parseFullFetchArgs(['--date', '2026-11-16']).date, '2026-11-16');
});

test('跨零点补跑宽限贯穿 isWithinBatchDateGrace、getRecordDate、validate-data-files 与成功分析索引', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { isWithinBatchDateGrace, getRecordDate } = require('../scripts/utils.js');
    const { validateFetchCheckpointFile } = require('../scripts/validate-data-files.js');

    assert.equal(isWithinBatchDateGrace('2026-11-16T23:59:59+08:00', '2026-11-16'), true);
    assert.equal(isWithinBatchDateGrace('2026-11-17T00:00:00+08:00', '2026-11-16'), true);
    assert.equal(isWithinBatchDateGrace('2026-11-17T07:59:59+08:00', '2026-11-16'), true);
    assert.equal(isWithinBatchDateGrace('2026-11-17T08:00:00+08:00', '2026-11-16'), false);
    assert.equal(isWithinBatchDateGrace('2026-11-18T00:30:00+08:00', '2026-11-16'), false);
    assert.equal(isWithinBatchDateGrace('2026-11-17T00:30:00+08:00', '2026-02-30'), false);

    assert.equal(getRecordDate({ batchDate: '2026-11-16', timestamp: '2026-11-17T00:30:00.000+08:00' }), '2026-11-16');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prev-day-grace-'));
    try {
        const cpPath = path.join(tmp, 'fetch-checkpoint.json');
        const makeCp = ts => ({
            timestamp: ts, batchDate: '2026-11-16', batchId: 'a'.repeat(16),
            candidateFingerprint: 'b'.repeat(16), sourceConfigFingerprint: 'c'.repeat(16), blogDedupFingerprint: 'd'.repeat(16),
            historicalDedupIds: [], categoryOrder: ['cs.SD', 'eess.AS', 'cs.CL', 'cs.AI', 'cs.LG'],
            arxiv: {}, huggingface: { status: 'failed', papers: [], papersCount: 0, papersSha256: '0'.repeat(64), health: { id: 'huggingface', ok: false } }
        });
        fs.writeFileSync(cpPath, JSON.stringify(makeCp('2026-11-17T00:30:00.000+08:00')));
        assert.ok(!validateFetchCheckpointFile(cpPath).some(msg => msg.includes('batchDate 必须等于不可变 timestamp')));
        fs.writeFileSync(cpPath, JSON.stringify(makeCp('2026-11-17T08:00:00.000+08:00')));
        assert.ok(validateFetchCheckpointFile(cpPath).some(msg => msg.includes('batchDate 必须等于不可变 timestamp')));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
