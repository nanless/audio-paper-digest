'use strict';
// scripts/source-probe.js 的离线测试：把 doctor.probeNetwork 替换成伪造的三入口结果，
// 不联网、不写 data/current、不发模型请求。
const test = require('node:test');
const assert = require('node:assert');
const doctor = require('../scripts/doctor');
const sourceProbe = require('../scripts/source-probe');

const RSS_OK = '<rss><channel><pubDate>Wed, 21 Oct 2026 00:00:00 -0400</pubDate></channel></rss>';

function withStubbedProbe(fixture, { today = '2026-10-22' } = {}, callback) {
    const originalProbe = doctor.probeNetwork;
    const originalToday = doctor.beijingDateString;
    doctor.probeNetwork = async () => fixture;
    doctor.beijingDateString = () => today;
    try {
        return callback();
    } finally {
        doctor.probeNetwork = originalProbe;
        doctor.beijingDateString = originalToday;
    }
}

function captureConsole() {
    const logs = [];
    const original = console.log;
    console.log = line => logs.push(String(line));
    return { logs, restore: () => { console.log = original; } };
}

test('parseArgs：日期/JSON/超时/帮助与未知参数', () => {
    assert.deepStrictEqual(sourceProbe.parseArgs([]), { date: null, json: false, timeoutMs: undefined });
    assert.deepStrictEqual(sourceProbe.parseArgs(['--date', '2026-10-21', '--json']),
        { date: '2026-10-21', json: true, timeoutMs: undefined });
    assert.strictEqual(sourceProbe.parseArgs(['--timeout-ms', '5000']).timeoutMs, 5000);
    assert.strictEqual(sourceProbe.parseArgs(['--help']).help, true);
    assert.throws(() => sourceProbe.parseArgs(['--bogus']), /未知参数/);
});

test('probe：三个入口都正常时给出 ok，并保留目标日期', async () => {
    const fixture = {
        proxyError: null,
        atom: { status: 200, body: '<feed><entry><id>x</id></entry></feed>', error: null },
        oai: { status: 200, body: '<OAI-PMH><Identify></Identify></OAI-PMH>', error: null },
        rss: { status: 200, body: RSS_OK, error: null }
    };
    await withStubbedProbe(fixture, {}, async () => {
        const result = await sourceProbe.probe({ date: '2026-10-21' });
        assert.strictEqual(result.date, '2026-10-21');
        assert.deepStrictEqual(result.checks.map(check => check.label),
            ['arXiv Atom 探测', 'arXiv OAI 探测', 'arXiv RSS 公告']);
        assert.ok(result.checks.every(check => check.ok === 'ok'), JSON.stringify(result.checks));
        assert.match(sourceProbe.render(result), /结论：入口可用/);
    });
});

test('probe：代理缺失时三个入口都判 fail，建议先处理代理', async () => {
    const fixture = { proxyError: '未配置 HTTPS_PROXY/HTTP_PROXY', atom: null, oai: null, rss: null };
    await withStubbedProbe(fixture, {}, async () => {
        const result = await sourceProbe.probe({ date: '2026-10-21' });
        assert.ok(result.checks.every(check => check.ok === 'fail'));
        const rendered = sourceProbe.render(result);
        assert.match(rendered, /入口不可用/);
        assert.match(rendered, /代理/);
    });
});

test('probe：RSS 公告未生成时只是 warn，不阻断抓取判断', async () => {
    const fixture = {
        proxyError: null,
        atom: { status: 200, body: '<feed><entry></entry></feed>', error: null },
        oai: { status: 200, body: '<OAI-PMH><Identify></Identify></OAI-PMH>', error: null },
        rss: { status: 200, body: RSS_OK, error: null }
    };
    await withStubbedProbe(fixture, { today: '2026-10-22' }, async () => {
        // 目标日是今天，但 RSS 仍是前一天的公告 → 尚未生成。
        const result = await sourceProbe.probe({ date: '2026-10-22' });
        const rss = result.checks.find(check => check.label === 'arXiv RSS 公告');
        assert.strictEqual(rss.ok, 'warn');
        assert.match(rss.detail, /尚未生成/);
        assert.ok(!result.checks.some(check => check.ok === 'fail'));
    });
});

test('probe：历史目标日提示使用受控历史入口', async () => {
    const fixture = {
        proxyError: null,
        atom: { status: 200, body: '<feed><entry></entry></feed>', error: null },
        oai: { status: 200, body: '<OAI-PMH><Identify></Identify></OAI-PMH>', error: null },
        rss: { status: 200, body: RSS_OK, error: null }
    };
    await withStubbedProbe(fixture, { today: '2026-10-22' }, async () => {
        const result = await sourceProbe.probe({ date: '2026-09-01' });
        const rss = result.checks.find(check => check.label === 'arXiv RSS 公告');
        assert.strictEqual(rss.ok, 'warn');
        assert.match(rss.detail, /历史日期/);
        assert.match(rss.hint, /历史入口/);
    });
});

test('render：按状态输出图标与结论', () => {
    const rendered = sourceProbe.render({
        date: '2026-10-21',
        checks: [
            { ok: 'ok', label: 'arXiv Atom 探测', detail: 'HTTP 200', hint: null },
            { ok: 'warn', label: 'arXiv RSS 公告', detail: '尚未生成', hint: '稍后重试' },
            { ok: 'fail', label: 'arXiv OAI 探测', detail: 'HTTP 503', hint: '检查代理' }
        ]
    });
    assert.match(rendered, /✅/);
    assert.match(rendered, /⚠️/);
    assert.match(rendered, /❌/);
    assert.match(rendered, /1 个入口不可用/);
});

test('main --json：无 fail 时退出码 0 且 JSON 可解析（不联网）', async () => {
    const fixture = {
        proxyError: null,
        atom: { status: 200, body: '<feed><entry></entry></feed>', error: null },
        oai: { status: 200, body: '<OAI-PMH><Identify></Identify></OAI-PMH>', error: null },
        rss: { status: 200, body: RSS_OK, error: null }
    };
    await withStubbedProbe(fixture, {}, async () => {
        const capture = captureConsole();
        try {
            const code = await sourceProbe.main(['--date', '2026-10-21', '--json']);
            assert.strictEqual(code, 0);
            const parsed = JSON.parse(capture.logs.join('\n'));
            assert.strictEqual(parsed.date, '2026-10-21');
            assert.strictEqual(parsed.checks.length, 3);
        } finally {
            capture.restore();
        }
    });
});

test('main --help：不探测、退出码 0', async () => {
    const capture = captureConsole();
    try {
        const code = await sourceProbe.main(['--help']);
        assert.strictEqual(code, 0);
        assert.match(capture.logs.join('\n'), /用法: node scripts\/source-probe\.js/);
    } finally {
        capture.restore();
    }
});
