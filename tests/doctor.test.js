'use strict';

// scripts/doctor.js 的测试：全部使用纯函数 / 伪造对象 / 临时目录，
// 不联网、不读真实 .env 密钥、不扫描真实 data/ 目录。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const doctor = require('../scripts/doctor.js');

const POLICY = 'opencode-go-sticky-quota-failover-v1';

function envWith(overrides = {}) {
    return {
        PAPER_ANALYZER_API_KEY: 'sk-test-primary-1234',
        PAPER_ANALYZER_MODEL: 'muse-spark-1.3-contributor',
        PAPER_ANALYZER_ENDPOINT: 'https://opencode.ai/zen/go/v1',
        PAPER_ANALYZER_SECONDARY_API_KEY: 'sk-test-secondary-5678',
        PAPER_ANALYZER_SECONDARY_MODEL: 'muse-spark-1.3-contributor',
        PAPER_ANALYZER_SECONDARY_ENDPOINT: 'https://opencode.ai/zen/go/v1/responses',
        HTTPS_PROXY: 'http://127.0.0.1:7897',
        PAPER_DIGEST_BLOG_REPO: '/Users/tester/blog',
        ...overrides
    };
}

function byLabel(checks, label) {
    return checks.find(check => check.label === label);
}

function fakeStat(kind, size = 0) {
    return {
        isDirectory: () => kind === 'directory',
        isFile: () => kind === 'file',
        isSymbolicLink: () => kind === 'symlink',
        size
    };
}

function createFakeFs(tree) {
    return {
        lstatSync(target) {
            const node = tree[target];
            if (!node) {
                const error = new Error(`ENOENT: ${target}`);
                error.code = 'ENOENT';
                throw error;
            }
            return fakeStat(node.kind, node.size);
        },
        readdirSync(target) {
            return tree[target]?.children || [];
        }
    };
}

function blogState(overrides = {}) {
    return {
        repoPath: '/Users/tester/blog',
        exists: true,
        postsExists: true,
        isGitRepo: true,
        git: { status: 0, stdout: '', stderr: '', error: null, timedOut: false },
        date: '2026-10-22',
        dateNote: '',
        configured: true,
        homeDirectory: '/Users/tester',
        ...overrides
    };
}

function validAccountPoolState(nowMs) {
    return {
        schemaVersion: 1,
        policyVersion: POLICY,
        generation: 3,
        services: {
            serviceA: {
                endpoint: 'https://opencode.ai/zen/go/v1',
                accounts: {
                    aaaa: { blockedUntilMs: nowMs + 60_000 },
                    bbbb: {},
                    cccc: { blockedUntilMs: nowMs + 120_000 }
                },
                groups: {}
            }
        }
    };
}

// ═══════════════════════════════════════════════════════
// 参数解析
// ═══════════════════════════════════════════════════════

test('默认参数：offline、非 json，目标日期取北京时间今天', () => {
    const parsed = doctor.parseArgs([], { nowMs: Date.parse('2026-10-21T16:09:00Z') });
    assert.equal(parsed.date, '2026-10-22');
    assert.equal(parsed.dateProvided, false);
    assert.equal(parsed.offline, true);
    assert.equal(parsed.network, false);
    assert.equal(parsed.json, false);
    assert.equal(parsed.help, false);
});

test('--network / --date / --json 解析正确', () => {
    const parsed = doctor.parseArgs(['--network', '--date', '2026-10-01', '--json']);
    assert.equal(parsed.date, '2026-10-01');
    assert.equal(parsed.dateProvided, true);
    assert.equal(parsed.network, true);
    assert.equal(parsed.offline, false);
    assert.equal(parsed.json, true);
});

test('非法/冲突参数报错', () => {
    assert.throws(() => doctor.parseArgs(['--bogus']), /未知参数/);
    assert.throws(() => doctor.parseArgs(['--date']), /需要 YYYY-MM-DD/);
    assert.throws(() => doctor.parseArgs(['--date', '2026-02-30']), /日期非法/);
    assert.throws(() => doctor.parseArgs(['--date', '20261001']), /日期非法/);
    assert.throws(() => doctor.parseArgs(['--offline', '--network']), /不能同时使用/);
});

test('北京时间日期字符串独立于本机时区', () => {
    assert.equal(doctor.beijingDateString(Date.parse('2026-10-21T16:00:00Z')), '2026-10-22');
    assert.equal(doctor.beijingDateString(Date.parse('2026-10-21T15:59:59Z')), '2026-10-21');
});

// ═══════════════════════════════════════════════════════
// Node 版本
// ═══════════════════════════════════════════════════════

test('Node 版本按 engines 边界判断', () => {
    const cases = [
        ['20.18.0', false],
        ['20.18.1', true],
        ['20.99.0', true],
        ['21.0.0', false],
        ['21.7.3', false],
        ['22.2.9', false],
        ['22.3.0', true],
        ['22.22.2', true],
        ['23.1.0', true],
        ['v22.3.0', true]
    ];
    for (const [version, expected] of cases) {
        assert.equal(doctor.satisfiesNodeRange(version), expected, version);
    }
    assert.equal(doctor.checkNodeVersion('22.22.2').ok, 'ok');
    assert.equal(doctor.checkNodeVersion('21.0.0').ok, 'fail');
    assert.equal(doctor.checkNodeVersion('not-a-version').ok, 'fail');
});

// ═══════════════════════════════════════════════════════
// .env / 模型 / 代理
// ═══════════════════════════════════════════════════════

test('.env 存在性与权限检查', () => {
    const missing = doctor.evaluateEnvFile({ exists: false });
    assert.equal(missing.ok, 'fail');
    assert.match(missing.hint, /env\.example/);

    const loose = doctor.evaluateEnvFile({ exists: true, mode: 0o644, entries: {} });
    assert.equal(loose.ok, 'warn');
    assert.match(loose.detail, /644/);

    const good = doctor.evaluateEnvFile({ exists: true, mode: 0o600, entries: {} });
    assert.equal(good.ok, 'ok');

    const unreadable = doctor.evaluateEnvFile({ exists: true, mode: 0o600, readError: '无法读取 .env: EACCES' });
    assert.equal(unreadable.ok, 'fail');
});

test('.env 解析规则与 env-loader 一致（引号、注释、后值覆盖）', () => {
    const parsed = doctor.parseDotEnvText([
        '# 注释',
        'PLAIN=value',
        'QUOTED="a b"',
        "SINGLE='c d'",
        'DUP=first',
        'DUP=second',
        'export NOPE=1',
        'INVALID LINE'
    ].join('\n'));
    assert.equal(parsed.PLAIN, 'value');
    assert.equal(parsed.QUOTED, 'a b');
    assert.equal(parsed.SINGLE, 'c d');
    assert.equal(parsed.DUP, 'second');
    assert.equal(parsed.NOPE, undefined);
});

test('只读读取 .env 不会修改文件权限', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-env-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const envFile = path.join(directory, '.env');
    fs.writeFileSync(envFile, 'A=1\nB="two"\n', { mode: 0o644 });
    fs.chmodSync(envFile, 0o644);
    const info = doctor.readEnvFileReadOnly(envFile);
    assert.equal(info.exists, true);
    assert.equal(info.entries.A, '1');
    assert.equal(info.entries.B, 'two');
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o644, '读取后权限必须保持 0644');

    const missing = doctor.readEnvFileReadOnly(path.join(directory, 'missing.env'));
    assert.equal(missing.exists, false);
});

test('主模型配置：缺项 fail、模型不符 fail、正常 ok', () => {
    assert.equal(doctor.evaluatePrimaryModel({}).ok, 'fail');
    assert.equal(doctor.evaluatePrimaryModel(envWith({ PAPER_ANALYZER_MODEL: 'mimo-v2.6-flash' })).ok, 'fail');
    const ok = doctor.evaluatePrimaryModel(envWith());
    assert.equal(ok.ok, 'ok');
    assert.match(ok.detail, /muse-spark-1\.3-contributor/);
    assert.ok(!ok.detail.includes('sk-test-primary-1234'), '不得显示 API Key 值');
    const invalidEndpoint = doctor.evaluatePrimaryModel(envWith({ PAPER_ANALYZER_ENDPOINT: 'not-a-url' }));
    assert.equal(invalidEndpoint.ok, 'warn');
});

test('副模型配置：缺失单模型 warn、不完整 warn、不符 fail、完整 ok', () => {
    assert.equal(doctor.evaluateSecondaryModel({}).ok, 'warn');
    const partial = doctor.evaluateSecondaryModel(envWith({ PAPER_ANALYZER_SECONDARY_ENDPOINT: '' }));
    assert.equal(partial.ok, 'warn');
    assert.match(partial.detail, /不完整/);
    const mismatch = doctor.evaluateSecondaryModel(envWith({ PAPER_ANALYZER_SECONDARY_MODEL: 'other-model' }));
    assert.equal(mismatch.ok, 'fail');
    assert.equal(doctor.evaluateSecondaryModel(envWith()).ok, 'ok');
});

test('代理检查：HTTP CONNECT 通过，SOCKS/缺失失败，凭据被掩码', () => {
    const ok = doctor.evaluateProxy(envWith());
    assert.equal(ok.ok, 'ok');
    assert.match(ok.detail, /127\.0\.0\.1:7897/);

    const withCredentials = doctor.evaluateProxy(envWith({ HTTPS_PROXY: 'http://user:proxy-pass-987@127.0.0.1:7897' }));
    assert.equal(withCredentials.ok, 'ok');
    assert.ok(!withCredentials.detail.includes('proxy-pass-987'));
    assert.ok(!withCredentials.detail.includes('user:'), '代理用户名也不显示');

    assert.equal(doctor.evaluateProxy({ HTTPS_PROXY: 'socks5://127.0.0.1:1080' }).ok, 'fail');
    assert.equal(doctor.evaluateProxy({ ALL_PROXY: 'socks5://127.0.0.1:1080' }).ok, 'fail');
    assert.equal(doctor.evaluateProxy({}).ok, 'fail');
});

// ═══════════════════════════════════════════════════════
// Python / node_modules / 角色 / 沙箱
// ═══════════════════════════════════════════════════════

test('Python 运行时输出解析', () => {
    const ok = doctor.evaluatePythonRuntime({
        status: 0,
        stdout: '3.11.15\nOpenSSL 3.5.5 27 Jan 2026\n',
        stderr: ''
    });
    assert.equal(ok.ok, 'ok');
    assert.match(ok.detail, /3\.11\.15/);

    const old = doctor.evaluatePythonRuntime({ status: 0, stdout: '3.10.0\nOpenSSL 3.0.0\n' });
    assert.equal(old.ok, 'fail');

    const noSsl = doctor.evaluatePythonRuntime({ status: 0, stdout: '3.11.15\nLibreSSL 3.0\n' });
    assert.equal(noSsl.ok, 'fail');

    const failed = doctor.evaluatePythonRuntime({ status: 1, stdout: '', stderr: '需要 Python >= 3.11' });
    assert.equal(failed.ok, 'fail');
    assert.match(failed.detail, /3\.11/);

    const spawnError = doctor.evaluatePythonRuntime({ error: new Error('spawn bash ENOENT') });
    assert.equal(spawnError.ok, 'fail');
});

test('node_modules 检查', () => {
    assert.equal(doctor.evaluateNodeModules('directory').ok, 'ok');
    assert.equal(doctor.evaluateNodeModules(null).ok, 'fail');
    assert.equal(doctor.evaluateNodeModules('file').ok, 'fail');
    assert.equal(doctor.evaluateNodeModules('error').ok, 'fail');
});

test('工作区角色与沙箱检查', () => {
    assert.equal(doctor.evaluateWorkspaceRole({ ok: true, role: 'daily' }).ok, 'ok');
    assert.equal(doctor.evaluateWorkspaceRole({ ok: true, role: 'history' }).ok, 'warn');
    const missing = doctor.evaluateWorkspaceRole({ ok: false, error: '工作区角色标记缺失' });
    assert.equal(missing.ok, 'fail');
    assert.match(missing.hint, /workspace:role/);

    assert.equal(doctor.evaluateSandbox({}).ok, 'ok');
    assert.equal(doctor.evaluateSandbox({ CODEX_SANDBOX: '1' }).ok, 'warn');
});

// ═══════════════════════════════════════════════════════
// 磁盘占用
// ═══════════════════════════════════════════════════════

test('formatBytes 输出人话单位', () => {
    assert.equal(doctor.formatBytes(0), '0 B');
    assert.equal(doctor.formatBytes(1024), '1.0 KiB');
    assert.equal(doctor.formatBytes(3.9 * 1024 ** 3), '3.9 GiB');
});

test('有界扫描：统计字节与不跟随符号链接', () => {
    const root = '/fake/root';
    const tree = {
        [root]: { kind: 'directory', children: ['a.bin', 'b.bin', 'sub', 'link'] },
        [`${root}/a.bin`]: { kind: 'file', size: 10 },
        [`${root}/b.bin`]: { kind: 'file', size: 20 },
        [`${root}/sub`]: { kind: 'directory', children: ['c.bin'] },
        [`${root}/sub/c.bin`]: { kind: 'file', size: 30 },
        [`${root}/link`]: { kind: 'symlink' }
    };
    const result = doctor.walkDirSizeLimited(root, {
        fsModule: createFakeFs(tree),
        now: () => 0,
        budgetMs: 1000,
        maxEntries: 100
    });
    assert.equal(result.exists, true);
    assert.equal(result.complete, true);
    assert.equal(result.bytes, 60);
    assert.equal(result.files, 3);
    assert.equal(result.symlinks, 1);
    assert.equal(result.directories, 2);
});

test('有界扫描：条目上限与时间预算都会停止并标记不完整', () => {
    const root = '/fake/root2';
    const tree = {
        [root]: { kind: 'directory', children: ['a', 'b', 'c', 'd'] },
        [`${root}/a`]: { kind: 'file', size: 1 },
        [`${root}/b`]: { kind: 'file', size: 1 },
        [`${root}/c`]: { kind: 'file', size: 1 },
        [`${root}/d`]: { kind: 'file', size: 1 }
    };
    const byEntries = doctor.walkDirSizeLimited(root, {
        fsModule: createFakeFs(tree),
        now: () => 0,
        budgetMs: 1000,
        maxEntries: 2
    });
    assert.equal(byEntries.complete, false);
    assert.equal(byEntries.entries, 2);

    let clock = 0;
    const byTime = doctor.walkDirSizeLimited(root, {
        fsModule: createFakeFs(tree),
        now: () => {
            const value = clock;
            clock += 2000;
            return value;
        },
        budgetMs: 3000,
        maxEntries: 100
    });
    assert.equal(byTime.complete, false);
    assert.ok(byTime.entries < 5);
});

test('目录缺失视为空，不报错', () => {
    const result = doctor.walkDirSizeLimited('/fake/missing', {
        fsModule: createFakeFs({}),
        now: () => 0,
        budgetMs: 10,
        maxEntries: 10
    });
    assert.equal(result.exists, false);
    assert.equal(result.bytes, 0);
    assert.equal(result.complete, true);
});

test('measureDiskUsage 只统计三个受控目录且顺序稳定', () => {
    const projectRoot = '/fake/project';
    const tree = {};
    for (const key of ['logs', 'data/current', 'data/runtime']) {
        const root = path.join(projectRoot, key);
        tree[root] = { kind: 'directory', children: ['x.bin'] };
        tree[`${root}/x.bin`] = { kind: 'file', size: 7 };
    }
    const measurements = doctor.measureDiskUsage(projectRoot, {
        fsModule: createFakeFs(tree),
        now: () => 0,
        budgetMs: 1000,
        maxEntries: 100
    });
    assert.deepEqual(measurements.map(item => item.key), ['data/current', 'data/runtime', 'logs']);
    assert.deepEqual(measurements.map(item => item.bytes), [7, 7, 7]);
});

test('磁盘检查：正常 ok、超软上限 warn、截断 warn、缺失 ok', () => {
    const checks = doctor.checkDiskUsage([
        { key: 'data/current', exists: true, complete: true, bytes: 10, files: 1, entries: 5, budgetMs: 10 },
        { key: 'data/runtime', exists: true, complete: true, bytes: doctor.DISK_TARGETS[1].softLimitBytes + 1, files: 2, entries: 5, budgetMs: 10 },
        { key: 'logs', exists: true, complete: false, bytes: 3, files: 0, entries: 2, budgetMs: 10 }
    ]);
    assert.equal(checks.length, 3);
    assert.equal(checks[0].ok, 'ok');
    assert.equal(checks[1].ok, 'warn');
    assert.match(checks[1].detail, /软上限/);
    assert.equal(checks[2].ok, 'warn');
    assert.match(checks[2].detail, /不完整/);

    const missing = doctor.checkDiskUsage([
        { key: 'data/current', exists: false, complete: true, bytes: 0, files: 0, entries: 0, budgetMs: 10 },
        { key: 'data/runtime', exists: false, complete: true, bytes: 0, files: 0, entries: 0, budgetMs: 10 },
        { key: 'logs', exists: false, complete: true, bytes: 0, files: 0, entries: 0, budgetMs: 10 }
    ]);
    assert.ok(missing.every(check => check.ok === 'ok'));
});

// ═══════════════════════════════════════════════════════
// 博客仓库
// ═══════════════════════════════════════════════════════

test('解析 git status 输出（含改名与特殊字符）', () => {
    const parsed = doctor.parseGitStatusPaths([
        ' M content/posts/2026-10-22-a.md',
        '?? notes/new.md',
        'R  content/posts/old.md -> content/posts/2026-10-23-b.md',
        'A  "content/posts/space name.md"',
        ''
    ].join('\n'));
    assert.equal(parsed.lineCount, 4);
    assert.ok(parsed.paths.includes('content/posts/2026-10-22-a.md'));
    assert.ok(parsed.paths.includes('content/posts/old.md'));
    assert.ok(parsed.paths.includes('content/posts/2026-10-23-b.md'));
    assert.ok(parsed.paths.includes('content/posts/space name.md'));
});

test('目标日期重叠检测只匹配完整日期段', () => {
    const paths = [
        'content/posts/2026-10-22-a.md',
        'content/posts/2026-10-22.md',
        'content/posts/2026-10-220-x.md',
        'content/posts/2026-10-21-a.md'
    ];
    const overlap = doctor.findDateOverlap(paths, '2026-10-22');
    assert.deepEqual(overlap.sort(), ['content/posts/2026-10-22-a.md', 'content/posts/2026-10-22.md']);
    assert.deepEqual(doctor.findDateOverlap(paths, ''), []);
});

test('博客仓库检查：缺失/非 Hugo/非 Git/重叠/未提交/干净', () => {
    assert.equal(doctor.evaluateBlogRepo(blogState({ exists: false })).ok, 'fail');
    assert.equal(doctor.evaluateBlogRepo(blogState({ postsExists: false })).ok, 'fail');
    assert.equal(doctor.evaluateBlogRepo(blogState({ isGitRepo: false })).ok, 'fail');
    assert.equal(doctor.evaluateBlogRepo(blogState({ git: { error: new Error('git 不存在') } })).ok, 'fail');
    assert.equal(doctor.evaluateBlogRepo(blogState({ git: { status: 128, stdout: '', stderr: 'fatal' } })).ok, 'fail');

    const overlap = doctor.evaluateBlogRepo(blogState({
        git: { status: 0, stdout: ' M content/posts/2026-10-22-a.md\n', stderr: '', error: null, timedOut: false }
    }));
    assert.equal(overlap.ok, 'fail');
    assert.match(overlap.detail, /重叠/);
    assert.match(overlap.detail, /2026-10-22-a\.md/);

    const dirty = doctor.evaluateBlogRepo(blogState({
        git: { status: 0, stdout: ' M content/posts/2026-10-01-a.md\n', stderr: '', error: null, timedOut: false }
    }));
    assert.equal(dirty.ok, 'warn');
    assert.match(dirty.detail, /1 个未提交改动/);

    const clean = doctor.evaluateBlogRepo(blogState());
    assert.equal(clean.ok, 'ok');
    assert.match(clean.detail, /工作区干净/);

    const unmasked = doctor.evaluateBlogRepo(blogState({
        git: { status: 0, stdout: ' M content/posts/2026-10-01-a.md\n', stderr: '', error: null, timedOut: false }
    }));
    assert.ok(unmasked.detail.includes('~/blog'), '主目录应被掩码为 ~');
    assert.ok(!unmasked.detail.includes('/Users/tester/blog'), '不应输出完整主目录路径');
});

test('未设置 PAPER_DIGEST_BLOG_REPO 时按默认路径提示', () => {
    const check = doctor.evaluateBlogRepo(blogState({ configured: false }));
    assert.equal(check.ok, 'ok');
    assert.match(check.detail, /未设置 PAPER_DIGEST_BLOG_REPO/);
});

test('inspectBlogRepo 在临时目录中为只读探测', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-blog-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.mkdirSync(path.join(directory, 'content', 'posts'), { recursive: true });
    const result = doctor.inspectBlogRepo(directory);
    assert.equal(result.exists, true);
    assert.equal(result.postsExists, true);
    assert.equal(result.isGitRepo, false);
});

// ═══════════════════════════════════════════════════════
// 账号池
// ═══════════════════════════════════════════════════════

test('账号池状态只读统计：可用/冷却/最早恢复', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-pool-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const stateFile = path.join(directory, 'llm-account-pool.json');
    const nowMs = Date.parse('2026-10-21T00:00:00Z');
    fs.writeFileSync(stateFile, JSON.stringify(validAccountPoolState(nowMs)), { mode: 0o644 });
    fs.chmodSync(stateFile, 0o644);

    const state = doctor.readAccountPoolState(stateFile, nowMs);
    assert.equal(state.exists, true);
    assert.equal(state.valid, true);
    assert.equal(state.accounts, 3);
    assert.equal(state.blocked, 2);
    assert.equal(state.earliestRecoveryMs, nowMs + 60_000);
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o644, '只读读取不得 chmod 状态文件');

    const check = doctor.evaluateAccountPool(state);
    assert.equal(check.ok, 'warn');
    assert.match(check.detail, /3 个账号，2 个冷却/);

    const missing = doctor.readAccountPoolState(path.join(directory, 'missing.json'), nowMs);
    assert.equal(missing.exists, false);
    assert.equal(doctor.evaluateAccountPool(missing).ok, 'ok');

    fs.writeFileSync(path.join(directory, 'bad.json'), '{not json', { mode: 0o600 });
    const bad = doctor.readAccountPoolState(path.join(directory, 'bad.json'), nowMs);
    assert.equal(bad.valid, false);
    assert.equal(doctor.evaluateAccountPool(bad).ok, 'fail');

    const allBlocked = {
        exists: true,
        valid: true,
        accounts: 2,
        blocked: 2,
        earliestRecoveryMs: nowMs + 5000
    };
    assert.equal(doctor.evaluateAccountPool(allBlocked).ok, 'fail');

    const allFree = { exists: true, valid: true, accounts: 2, blocked: 0 };
    assert.equal(doctor.evaluateAccountPool(allFree).ok, 'ok');
});

// ═══════════════════════════════════════════════════════
// 网络探测结果评估（不实际联网）
// ═══════════════════════════════════════════════════════

test('RSS pubDate 解析与目标日期判断', () => {
    const rssBody = '<?xml version="1.0"?><rss version="2.0"><channel>'
        + '<title>eess.AS updates on arXiv.org</title>'
        + '<pubDate>Wed, 21 Oct 2026 00:00:00 -0400</pubDate>'
        + '<item><pubDate>Wed, 21 Oct 2026 00:00:00 -0400</pubDate></item>'
        + '</channel></rss>';
    const parsed = doctor.parseRssPubDate(rssBody);
    assert.equal(parsed.raw, 'Wed, 21 Oct 2026 00:00:00 -0400');
    assert.equal(doctor.formatDateInTimeZone(parsed.date, 'America/New_York'), '2026-10-21');
    assert.equal(doctor.evaluateRssProbe({ status: 200, body: rssBody, error: null }, '2026-10-21').ok, 'ok');
    const notYet = doctor.evaluateRssProbe({ status: 200, body: rssBody, error: null }, '2026-10-22');
    assert.equal(notYet.ok, 'warn');
    assert.match(notYet.detail, /尚未生成/);

    assert.equal(doctor.parseRssPubDate('<rss></rss>'), null);
    assert.equal(doctor.evaluateRssProbe({ status: 200, body: '<rss></rss>', error: null }, '2026-10-22').ok, 'fail');
    assert.equal(doctor.evaluateRssProbe({ status: 200, body: rssBody, error: new Error('boom') }, '2026-10-21').ok, 'fail');
});

test('Atom / OAI 探测结果评估', () => {
    assert.equal(doctor.evaluateAtomProbe({ status: 200, body: '<feed><entry><id>x</id></entry></feed>', error: null }).ok, 'ok');
    assert.equal(doctor.evaluateAtomProbe({ status: 500, body: '', error: null }).ok, 'fail');
    assert.equal(doctor.evaluateAtomProbe({ status: 200, body: '<html>blocked</html>', error: null }).ok, 'fail');
    assert.equal(doctor.evaluateAtomProbe({ status: null, body: '', error: new Error('connect ECONNREFUSED') }).ok, 'fail');

    assert.equal(doctor.evaluateOaiProbe({ status: 200, body: '<OAI-PMH><Identify><repositoryName>x</repositoryName></Identify></OAI-PMH>', error: null }).ok, 'ok');
    assert.equal(doctor.evaluateOaiProbe({ status: 200, body: '<OAI-PMH><error>bad</error></OAI-PMH>', error: null }).ok, 'fail');
    assert.equal(doctor.evaluateOaiProbe({ status: 429, body: '', error: null }).ok, 'fail');
});

test('网络探测在缺少代理时报告未探测而不是直连', () => {
    const checks = doctor.evaluateNetworkProbes({ proxyError: '未配置 HTTPS_PROXY/HTTP_PROXY' }, '2026-10-22');
    assert.equal(checks.length, 3);
    assert.ok(checks.every(check => check.ok === 'fail'));
    assert.ok(checks.every(check => check.detail.includes('未探测')));
});

// ═══════════════════════════════════════════════════════
// 聚合、退出码、掩码与密钥
// ═══════════════════════════════════════════════════════

test('聚合统计与退出码：只有 fail 返回 1', () => {
    const okChecks = [doctor.makeCheck('ok', 'a', 'x'), doctor.makeCheck('warn', 'b', 'y')];
    assert.equal(doctor.exitCodeFor(okChecks), 0);
    assert.deepEqual(doctor.countStatuses(okChecks), { ok: 1, warn: 1, fail: 0 });

    const failing = [...okChecks, doctor.makeCheck('fail', 'c', 'z')];
    assert.equal(doctor.exitCodeFor(failing), 1);
    assert.deepEqual(doctor.countStatuses(failing), { ok: 1, warn: 1, fail: 1 });
    assert.equal(doctor.exitCodeFor([]), 0);
});

test('人话表格包含图标、详情、提示和退出码汇总', () => {
    const table = doctor.renderTable([
        doctor.makeCheck('ok', 'Node 版本', 'v22.22.2'),
        doctor.makeCheck('fail', 'HTTP 代理', '未配置', '在 .env 配置 HTTPS_PROXY')
    ], { date: '2026-10-22', network: false });
    assert.match(table, /✅/);
    assert.match(table, /❌/);
    assert.match(table, /Node 版本/);
    assert.match(table, /未配置/);
    assert.match(table, /↳ 在 \.env 配置 HTTPS_PROXY/);
    assert.match(table, /退出码 1/);
    assert.match(table, /离线/);
});

test('主目录掩码只替换完整路径前缀', () => {
    assert.equal(doctor.maskPath('/Users/tester/blog', '/Users/tester'), '~/blog');
    assert.equal(doctor.maskPath('/Users/tester', '/Users/tester'), '~');
    assert.equal(doctor.maskPath('/Users/tester-other/blog', '/Users/tester'), '/Users/tester-other/blog');
    assert.equal(doctor.maskPath('/tmp/x', '/Users/tester'), '/tmp/x');
});

test('密钥收集与输出脱敏', () => {
    const env = envWith({
        PAPER_ANALYZER_API_KEY: 'sk-super-secret-key-123',
        PAPER_ANALYZER_FALLBACK_API_KEYS: 'sk-backup-one-456, sk-backup-two-789',
        HTTPS_PROXY: 'http://user:proxy-pass-987@127.0.0.1:7897'
    });
    const secrets = doctor.collectSecretValues(env);
    assert.ok(secrets.includes('sk-super-secret-key-123'));
    assert.ok(secrets.includes('sk-backup-one-456'));
    assert.ok(secrets.includes('proxy-pass-987'));

    const checks = [
        doctor.makeCheck('fail', '测试', '泄露 sk-super-secret-key-123 与 proxy-pass-987'),
        doctor.makeCheck('warn', '测试2', '正常文本')
    ];
    const redacted = doctor.redactChecks(checks, secrets);
    const serialized = JSON.stringify(redacted) + doctor.renderTable(redacted, { date: '2026-10-22' });
    assert.ok(!serialized.includes('sk-super-secret-key-123'));
    assert.ok(!serialized.includes('proxy-pass-987'));
    assert.match(redacted[0].detail, /\*\*\*/);
    assert.equal(redacted[1].detail, '正常文本');
});

// ═══════════════════════════════════════════════════════
// runDoctor：注入依赖做端到端聚合
// ═══════════════════════════════════════════════════════

function fakeDeps(overrides = {}) {
    const env = envWith();
    return {
        nodeVersion: () => '22.22.2',
        readEnvFile: () => ({ exists: true, mode: 0o600, entries: env, readError: null, error: null }),
        checkPython: () => ({ status: 0, stdout: '3.11.15\nOpenSSL 3.5.5 27 Jan 2026\n', stderr: '', error: null }),
        pathKind: () => 'directory',
        readWorkspaceRole: () => ({ ok: true, role: 'daily' }),
        measureDisk: () => [
            { key: 'data/current', exists: true, complete: true, bytes: 1024, files: 1, entries: 3, budgetMs: 100 },
            { key: 'data/runtime', exists: true, complete: true, bytes: 2048, files: 2, entries: 4, budgetMs: 100 },
            { key: 'logs', exists: true, complete: true, bytes: 4096, files: 3, entries: 5, budgetMs: 100 }
        ],
        inspectBlog: () => ({
            repoPath: '/Users/tester/blog',
            exists: true,
            postsExists: true,
            isGitRepo: true,
            git: { status: 0, stdout: '', stderr: '', error: null, timedOut: false }
        }),
        readAccountPool: () => ({ exists: false, valid: true }),
        probeNetwork: () => { throw new Error('offline 模式不应联网'); },
        ...overrides
    };
}

test('runDoctor offline：不联网、不抛错、无 fail 时退出码 0', async () => {
    const parsed = doctor.parseArgs(['--offline'], { nowMs: Date.parse('2026-10-21T16:09:00Z') });
    const result = await doctor.runDoctor({
        parsed,
        projectRoot: '/fake/project',
        deps: fakeDeps()
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.checks.length, 15);
    assert.equal(byLabel(result.checks, '网络探测').ok, 'warn');
    assert.match(byLabel(result.checks, '网络探测').detail, /--offline/);
    assert.ok(!result.checks.some(check => check.ok === 'fail'));
    const serialized = JSON.stringify(result.checks);
    assert.ok(!serialized.includes('sk-test-primary-1234'), '聚合结果不得包含 API Key');
    assert.ok(!serialized.includes('sk-test-secondary-5678'), '聚合结果不得包含副模型 API Key');
});

test('runDoctor：任一 fail 时退出码 1', async () => {
    const parsed = doctor.parseArgs(['--offline']);
    const result = await doctor.runDoctor({
        parsed,
        projectRoot: '/fake/project',
        deps: fakeDeps({ nodeVersion: () => '21.0.0' })
    });
    assert.equal(result.exitCode, 1);
    assert.equal(byLabel(result.checks, 'Node 版本').ok, 'fail');
});

test('runDoctor --network：只调用注入的探测器并评估结果', async () => {
    let probeCalls = 0;
    const parsed = doctor.parseArgs(['--network', '--date', '2026-10-21']);
    const result = await doctor.runDoctor({
        parsed,
        projectRoot: '/fake/project',
        deps: fakeDeps({
            probeNetwork: () => {
                probeCalls += 1;
                return Promise.resolve({
                    proxyError: null,
                    atom: { status: 200, body: '<feed><entry></entry></feed>', error: null },
                    oai: { status: 200, body: '<OAI-PMH><Identify></Identify></OAI-PMH>', error: null },
                    rss: { status: 200, body: '<rss><channel><pubDate>Wed, 21 Oct 2026 00:00:00 -0400</pubDate></channel></rss>', error: null }
                });
            }
        })
    });
    assert.equal(probeCalls, 1);
    assert.equal(byLabel(result.checks, 'arXiv Atom 探测').ok, 'ok');
    assert.equal(byLabel(result.checks, 'arXiv OAI 探测').ok, 'ok');
    assert.equal(byLabel(result.checks, 'arXiv RSS 公告').ok, 'ok');
    assert.equal(result.exitCode, 0);
});

test('runDoctor 中单个检查抛错时变成 fail 而不是崩溃', async () => {
    const parsed = doctor.parseArgs(['--offline']);
    const result = await doctor.runDoctor({
        parsed,
        projectRoot: '/fake/project',
        deps: fakeDeps({
            measureDisk: () => {
                throw new Error('扫描失败');
            }
        })
    });
    const disk = byLabel(result.checks, '磁盘占用');
    assert.equal(disk.ok, 'fail');
    assert.match(disk.detail, /检查执行失败/);
    assert.equal(result.exitCode, 1);
});
