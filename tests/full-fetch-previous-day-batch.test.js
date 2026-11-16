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
