'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseFullFetchArgs } = require('../scripts/full-fetch.js');

test('旧获取见证恢复参数只接受显式绝对路径并保留连续性要求', () => {
    const manifest = path.join(os.tmpdir(), 'witness recovery', 'manifest.json');
    assert.deepEqual(parseFullFetchArgs(['--date', '2026-11-02', '--require-previously-fetched',
        '--fetch-witness-recovery-manifest', manifest]), {
        date: '2026-11-02', requirePreviouslyFetched: true, fetchWitnessRecoveryManifest: manifest
    });
    for (const args of [
        ['--fetch-witness-recovery-manifest', manifest],
        ['--require-previously-fetched', '--fetch-witness-recovery-manifest', 'relative.json'],
        ['--require-previously-fetched', '--fetch-witness-recovery-manifest', manifest,
            '--fetch-witness-recovery-manifest', manifest],
        ['--require-previously-fetched', '--fetch-witness-recovery-manifest', manifest,
            '--refilter', '2610.00001', '--refilter-reason', 'test'],
        ['--require-previously-fetched', '--fetch-witness-recovery-manifest'],
    ]) assert.throws(() => parseFullFetchArgs(args), /绝对路径|连续性|重复|用法/);
});

test('日更 shell 不拆开带空格恢复路径，拒绝非抓取阶段及不完整参数', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-witness-option-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const log = path.join(root, 'argv.log');
    const fakeNode = path.join(root, 'node');
    fs.writeFileSync(fakeNode, '#!/bin/sh\nfor arg in "$@"; do printf \'%s\\n\' "$arg"; done > "$WITNESS_OPTION_TEST_LOG"\nexit 23\n');
    fs.chmodSync(fakeNode, 0o755);
    const script = path.resolve(__dirname, '../run-daily-digest.sh');
    const env = { ...process.env, PATH: `${root}:${process.env.PATH || ''}`, WITNESS_OPTION_TEST_LOG: log };
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric',
        month: '2-digit', day: '2-digit' }).format(new Date());
    const manifest = path.join(root, 'with spaces', 'manifest.json');
    const valid = spawnSync('bash', [script, date, '--fetch-witness-recovery-manifest', manifest],
        { env, encoding: 'utf8' });
    assert.equal(valid.status, 23, valid.stderr);
    assert.deepEqual(fs.readFileSync(log, 'utf8').trimEnd().split('\n'), [
        'scripts/full-fetch.js', '--date', date, '--require-previously-fetched',
        '--fetch-witness-recovery-manifest', manifest
    ]);
    for (const args of [
        ['--fetch-witness-recovery-manifest'],
        ['--fetch-witness-recovery-manifest', 'relative.json'],
        ['--fetch-witness-recovery-manifest', manifest, '--fetch-witness-recovery-manifest', manifest],
        ['--from', 'push', '--fetch-witness-recovery-manifest', manifest],
    ]) {
        fs.writeFileSync(log, '');
        const result = spawnSync('bash', [script, date, ...args], { env, encoding: 'utf8' });
        assert.equal(result.status, 2, result.stderr);
        assert.equal(fs.readFileSync(log, 'utf8'), '');
        assert.doesNotMatch(result.stdout, /论文速递阶段:/);
    }
});

test('公告截止恢复须显式绑定当日连续性和官方 OAI', () => {
    const cutoff = '2026-11-03T05:00:00.000Z';
    const args = ['--date', '2026-11-03', '--require-previously-fetched', '--official-oai-recovery'];
    assert.equal(parseFullFetchArgs([...args, '--official-announcement-cutoff', cutoff]).officialAnnouncementCutoff, cutoff);
    assert.throws(() => parseFullFetchArgs(['--official-announcement-cutoff', cutoff]), /公告截止恢复/);
    assert.throws(() => parseFullFetchArgs([...args, '--official-announcement-cutoff', '2026-11-03']), /公告截止恢复/);
    assert.throws(() => parseFullFetchArgs([...args, '--official-announcement-cutoff', cutoff,
        '--fetch-witness-recovery-manifest', '/original.json']), /公告截止恢复/);
});
