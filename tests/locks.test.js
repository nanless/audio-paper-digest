'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const locks = require('../scripts/locks');

function makeRoot(entries) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'locks-'));
    for (const [relative, content] of entries) {
        const target = path.join(root, 'data/runtime', relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(content));
    }
    return root;
}

test('识别目录锁 owner.json 与普通锁文件，跳过 .hugo_build.lock', () => {
    const root = makeRoot([
        ['run.lock/owner.json', { pid: process.pid, hostname: os.hostname(), acquiredAt: new Date().toISOString() }],
        ['old.lock/owner.json', { pid: 999999, hostname: os.hostname(), acquiredAt: '2026-01-01T00:00:00Z' }],
        ['plain.lock', { pid: process.pid, hostname: os.hostname() }],
        ['.hugo_build.lock', { pid: 1 }]
    ]);
    try {
        const rows = locks.scanLocks(['data/runtime'], Date.now(), { root });
        const files = rows.map(row => row.file);
        assert.ok(files.includes(path.join('data/runtime', 'run.lock')));
        assert.ok(files.includes(path.join('data/runtime', 'plain.lock')));
        assert.ok(!files.some(file => file.includes('.hugo_build.lock')));
        const dead = rows.find(row => row.file.includes('old.lock'));
        assert.strictEqual(dead.alive, false);
        assert.strictEqual(dead.stale, true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('远端 hostname 不按本地 PID 判死', () => {
    const root = makeRoot([['remote.lock/owner.json', { pid: 999999, hostname: 'other-host', acquiredAt: new Date().toISOString() }]]);
    try {
        const rows = locks.scanLocks(['data/runtime'], Date.now(), { root });
        assert.strictEqual(rows[0].alive, null);
        assert.strictEqual(rows[0].stale, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
