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

test('Node 预发布版本不满足 engines', () => {
    assert.equal(doctor.isPrereleaseVersion('22.3.0-rc.1'), true);
    assert.equal(doctor.satisfiesNodeRange('22.3.0-rc.1'), false);
    assert.equal(doctor.satisfiesNodeRange('20.18.1-beta.2'), false);
    assert.equal(doctor.satisfiesNodeRange('22.3.0+build.5'), true);
    const check = doctor.checkNodeVersion('22.3.0-rc.1');
    assert.equal(check.ok, 'fail');
    assert.match(check.detail, /预发布/);
});

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

test('凭据隔离：发现主池与副池共用同一 key 时 warn 且不输出 key/值', () => {
    const shared = doctor.evaluateCredentialIsolation(envWith({
        PAPER_ANALYZER_FALLBACK_API_KEYS: 'sk-test-secondary-5678,sk-other-9999'
    }));
    assert.equal(shared.ok, 'warn');
    assert.match(shared.detail, /1 个相同的 key 值/);
    assert.match(shared.detail, /互相消耗额度/);
    assert.ok(!shared.detail.includes('sk-test-secondary-5678'), '不得输出共用值');
    assert.ok(!shared.hint.includes('sk-test-secondary-5678'));
    assert.match(shared.hint, /只比较值/);

    const tertiary = doctor.evaluateCredentialIsolation(envWith({
        PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS: 'sk-test-primary-1234'
    }));
    assert.equal(tertiary.ok, 'warn');

    const distinct = doctor.evaluateCredentialIsolation(envWith());
    assert.equal(distinct.ok, 'ok');
    assert.equal(doctor.evaluateCredentialIsolation({}).ok, 'ok');
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
    assert.equal(result.rootKind, 'missing');
    assert.equal(result.bytes, 0);
    assert.equal(result.complete, true);
});

test('磁盘根为 symlink/普通文件时记录 rootKind 并给 warn', () => {
    const linkRoot = '/fake/link-root';
    const link = doctor.walkDirSizeLimited(linkRoot, {
        fsModule: createFakeFs({ [linkRoot]: { kind: 'symlink' } }),
        now: () => 0,
        budgetMs: 10,
        maxEntries: 10
    });
    assert.equal(link.exists, true);
    assert.equal(link.rootKind, 'symlink');
    assert.equal(link.bytes, 0);

    const fileRoot = '/fake/file-root';
    const file = doctor.walkDirSizeLimited(fileRoot, {
        fsModule: createFakeFs({ [fileRoot]: { kind: 'file', size: 5 } }),
        now: () => 0,
        budgetMs: 10,
        maxEntries: 10
    });
    assert.equal(file.rootKind, 'file');
    assert.equal(file.bytes, 5);

    const checks = doctor.checkDiskUsage([
        { key: 'data/current', exists: true, rootKind: 'symlink', complete: true, bytes: 0, files: 0, entries: 1, budgetMs: 10 },
        { key: 'data/runtime', exists: true, rootKind: 'file', complete: true, bytes: 5, files: 1, entries: 1, budgetMs: 10 },
        { key: 'logs', exists: true, rootKind: 'directory', complete: true, bytes: 10, files: 1, entries: 2, budgetMs: 10 }
    ]);
    assert.equal(checks[0].ok, 'warn');
    assert.match(checks[0].detail, /未跟随符号链接/);
    assert.equal(checks[1].ok, 'warn');
    assert.match(checks[1].detail, /根不是目录/);
    assert.equal(checks[2].ok, 'ok');
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

test('git status 改名行：先按箭头拆分再去引号', () => {
    const parsed = doctor.parseGitStatusPaths(
        'R  "content/posts/old name.md" -> "content/posts/2026-10-22 new.md"\n'
    );
    assert.equal(parsed.lineCount, 1);
    assert.deepEqual(parsed.paths.sort(), [
        'content/posts/2026-10-22 new.md',
        'content/posts/old name.md'
    ]);
    assert.ok(!parsed.paths.some(item => item.includes('"')), '两侧引号都要去掉');
    assert.equal(doctor.unquoteGitPath('"a\\"b"'), 'a"b');
});

test('目标日期重叠检测覆盖空格/下划线后缀且排除更长数字', () => {
    const paths = [
        'content/posts/2026-10-22-a.md',
        'content/posts/2026-10-22.md',
        'content/posts/2026-10-22 new.md',
        'content/posts/2026-10-22_v2.md',
        'content/posts/2026-10-220-x.md',
        'content/posts/2026-10-21-a.md'
    ];
    const overlap = doctor.findDateOverlap(paths, '2026-10-22');
    assert.deepEqual(overlap.sort(), [
        'content/posts/2026-10-22 new.md',
        'content/posts/2026-10-22-a.md',
        'content/posts/2026-10-22.md',
        'content/posts/2026-10-22_v2.md'
    ]);
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
    assert.equal(result.hugoConfig, null);
    assert.equal(result.isGitRepo, false);
});

test('Hugo 判定：显式配置缺 content/posts 为 fail，未配置默认路径才降级 warn', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-hugo-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(path.join(directory, 'hugo.toml'), 'baseURL = "https://example.com"\n');
    const inspected = doctor.inspectBlogRepo(directory);
    assert.equal(inspected.exists, true);
    assert.equal(inspected.postsExists, false);
    assert.equal(inspected.hugoConfig, 'hugo.toml');

    const withConfig = doctor.evaluateBlogRepo(blogState({
        postsExists: false,
        hugoConfig: 'hugo.toml'
    }));
    assert.equal(withConfig.ok, 'fail');
    assert.match(withConfig.detail, /content\/posts/);
    assert.match(withConfig.detail, /hugo\.toml/);
    assert.ok(!withConfig.detail.includes('不是 Hugo'), '找到 Hugo 配置时不应判定为非 Hugo');

    const defaultPath = doctor.evaluateBlogRepo(blogState({
        configured: false,
        postsExists: false,
        hugoConfig: 'hugo.toml'
    }));
    assert.equal(defaultPath.ok, 'warn');
    assert.match(defaultPath.detail, /content\/posts/);

    const withoutConfig = doctor.evaluateBlogRepo(blogState({ postsExists: false, hugoConfig: null }));
    assert.equal(withoutConfig.ok, 'fail');
    assert.match(withoutConfig.detail, /不是 Hugo 博客仓库/);
});

test('真实 git 仓库回归：目标日改动判 fail 且 .git/index 字节不变', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-git-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const git = (args) => require('node:child_process').spawnSync('git', ['-C', directory, ...args], {
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    });
    assert.equal(git(['init', '-q']).status, 0);
    assert.equal(git(['config', 'user.email', 'doctor@example.com']).status, 0);
    assert.equal(git(['config', 'user.name', 'Doctor Test']).status, 0);
    fs.mkdirSync(path.join(directory, 'content', 'posts'), { recursive: true });
    const page = path.join(directory, 'content', 'posts', '2026-10-22-a.md');
    fs.writeFileSync(page, '# a\n');
    assert.equal(git(['add', '.']).status, 0);
    assert.equal(git(['commit', '-q', '-m', 'init']).status, 0);

    const indexPath = path.join(directory, '.git', 'index');
    const indexBefore = require('node:crypto').createHash('sha256').update(fs.readFileSync(indexPath)).digest('hex');
    fs.appendFileSync(page, 'changed\n');

    const inspected = doctor.inspectBlogRepo(directory);
    assert.equal(inspected.isGitRepo, true);
    assert.match(inspected.git.stdout, /2026-10-22-a\.md/);
    const check = doctor.evaluateBlogRepo({
        ...inspected,
        date: '2026-10-22',
        configured: true,
        homeDirectory: '/nonexistent-home'
    });
    assert.equal(check.ok, 'fail');
    assert.match(check.detail, /重叠/);

    const indexAfter = require('node:crypto').createHash('sha256').update(fs.readFileSync(indexPath)).digest('hex');
    assert.equal(indexAfter, indexBefore, 'GIT_OPTIONAL_LOCKS=0 下 git status 不得改写索引');
});

test('createDefaultDeps(tmpRoot) 冒烟：不写文件、不联网', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-deps-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const before = fs.readdirSync(directory).sort();
    const deps = doctor.createDefaultDeps(directory, Date.now());
    assert.equal(deps.nodeVersion(), process.versions.node);
    assert.equal(deps.readEnvFile().exists, false);
    assert.equal(deps.pathKind(path.join(directory, 'node_modules')), null);
    assert.equal(deps.readWorkspaceRole().ok, false);
    assert.equal(deps.readAccountPool().exists, false);
    assert.equal(deps.measureDisk().length, 3);
    const blog = deps.inspectBlog({ PAPER_DIGEST_BLOG_REPO: directory });
    assert.equal(blog.exists, true);
    assert.equal(blog.postsExists, false);
    assert.deepEqual(fs.readdirSync(directory).sort(), before, '冒烟调用不得创建文件');
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

test('账号池状态：权限非 0600 给 warn 且不改权限', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-pool-mode-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const stateFile = path.join(directory, 'llm-account-pool.json');
    const nowMs = Date.parse('2026-10-21T00:00:00Z');
    fs.writeFileSync(stateFile, JSON.stringify(validAccountPoolState(nowMs)), { mode: 0o644 });
    fs.chmodSync(stateFile, 0o644);

    const state = doctor.readAccountPoolState(stateFile, nowMs);
    assert.equal(state.mode, 0o644);
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o644);
    const check = doctor.evaluateAccountPool(state, 'darwin');
    assert.equal(check.ok, 'warn');
    assert.match(check.detail, /权限 644/);
    assert.match(check.hint, /chmod 600/);
});

test('账号池状态：symlink 与非法 rotationCursor/lastSelectedAtMs 报 fail', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-pool-invalid-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const nowMs = Date.parse('2026-10-21T00:00:00Z');

    const realFile = path.join(directory, 'real.json');
    fs.writeFileSync(realFile, JSON.stringify(validAccountPoolState(nowMs)), { mode: 0o600 });
    const linkFile = path.join(directory, 'link.json');
    fs.symlinkSync(realFile, linkFile);
    const linked = doctor.readAccountPoolState(linkFile, nowMs);
    assert.equal(linked.valid, false);
    assert.match(linked.error, /符号链接/);
    assert.equal(doctor.evaluateAccountPool(linked).ok, 'fail');

    const badCursor = validAccountPoolState(nowMs);
    badCursor.services.serviceA.groups.groupA = { activeAccountId: null, rotationCursor: -1 };
    const badCursorFile = path.join(directory, 'bad-cursor.json');
    fs.writeFileSync(badCursorFile, JSON.stringify(badCursor), { mode: 0o600 });
    assert.equal(doctor.readAccountPoolState(badCursorFile, nowMs).valid, false);

    const badSelected = validAccountPoolState(nowMs);
    badSelected.services.serviceA.groups.groupA = { activeAccountId: null, lastSelectedAtMs: 'soon' };
    const badSelectedFile = path.join(directory, 'bad-selected.json');
    fs.writeFileSync(badSelectedFile, JSON.stringify(badSelected), { mode: 0o600 });
    assert.equal(doctor.readAccountPoolState(badSelectedFile, nowMs).valid, false);

    const goodGroup = validAccountPoolState(nowMs);
    goodGroup.services.serviceA.groups.groupA = { activeAccountId: 'bbbb', rotationCursor: 2, lastSelectedAtMs: nowMs };
    const goodFile = path.join(directory, 'good-group.json');
    fs.writeFileSync(goodFile, JSON.stringify(goodGroup), { mode: 0o600 });
    const good = doctor.readAccountPoolState(goodFile, nowMs);
    assert.equal(good.valid, true);
    assert.equal(doctor.evaluateAccountPool(good, 'darwin').ok, 'warn');
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
    assert.equal(doctor.evaluateRssProbe({ status: 200, body: rssBody, error: null }, '2026-10-21', { todayDate: '2026-10-21' }).ok, 'ok');
    const notYet = doctor.evaluateRssProbe({ status: 200, body: rssBody, error: null }, '2026-10-22', { todayDate: '2026-10-22' });
    assert.equal(notYet.ok, 'warn');
    assert.match(notYet.detail, /尚未生成/);

    assert.equal(doctor.parseRssPubDate('<rss></rss>'), null);
    assert.equal(doctor.evaluateRssProbe({ status: 200, body: '<rss></rss>', error: null }, '2026-10-22').ok, 'fail');
    assert.equal(doctor.evaluateRssProbe({ status: 200, body: rssBody, error: new Error('boom') }, '2026-10-21').ok, 'fail');
});

test('RSS 历史/未来目标日措辞', () => {
    const rssBody = '<rss><channel><pubDate>Wed, 21 Oct 2026 00:00:00 -0400</pubDate></channel></rss>';
    const probe = { status: 200, body: rssBody, error: null };
    const historical = doctor.evaluateRssProbe(probe, '2026-09-01', { todayDate: '2026-10-22' });
    assert.equal(historical.ok, 'warn');
    assert.match(historical.detail, /历史日期/);
    assert.match(historical.detail, /当前公告日 2026-10-21/);

    const future = doctor.evaluateRssProbe(probe, '2026-11-01', { todayDate: '2026-10-22' });
    assert.equal(future.ok, 'warn');
    assert.match(future.detail, /尚未到来/);
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

function fakeHeaders(map = {}) {
    const lower = new Map(Object.entries(map).map(([key, value]) => [String(key).toLowerCase(), String(value)]));
    return { get: name => (lower.has(String(name).toLowerCase()) ? lower.get(String(name).toLowerCase()) : null) };
}

function streamingResponse({ status = 200, headers = {}, chunks = [], onCancel } = {}) {
    let index = 0;
    let cancelled = false;
    return {
        status,
        headers: fakeHeaders(headers),
        body: {
            getReader() {
                return {
                    async read() {
                        if (index >= chunks.length) return { done: true };
                        const value = chunks[index];
                        index += 1;
                        return { done: false, value };
                    },
                    async cancel() { cancelled = true; if (onCancel) onCancel(); },
                    releaseLock() {}
                };
            },
            async cancel() { cancelled = true; if (onCancel) onCancel(); }
        },
        arrayBuffer: async () => Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).buffer,
        wasCancelled: () => cancelled
    };
}

function redirectResponse(location, status = 302) {
    return {
        status,
        headers: fakeHeaders(location ? { location } : {}),
        body: { cancel: async () => {} },
        arrayBuffer: async () => new ArrayBuffer(0)
    };
}

test('探测 URL 只允许 HTTPS 且拒绝私网/保留地址', () => {
    assert.throws(() => doctor.assertAllowedProbeUrl('http://export.arxiv.org/api'), /HTTPS/);
    assert.throws(() => doctor.assertAllowedProbeUrl('https://127.0.0.1/x'), /私网/);
    assert.throws(() => doctor.assertAllowedProbeUrl('https://10.0.0.5/x'), /私网/);
    assert.throws(() => doctor.assertAllowedProbeUrl('https://localhost/x'), /私网/);
    assert.throws(() => doctor.assertAllowedProbeUrl('https://[::1]/x'), /私网/);
    assert.equal(doctor.assertAllowedProbeUrl('https://export.arxiv.org/api/query').hostname, 'export.arxiv.org');

    assert.equal(doctor.isPrivateOrReservedHost('192.168.1.1'), true);
    assert.equal(doctor.isPrivateOrReservedHost('172.20.1.1'), true);
    assert.equal(doctor.isPrivateOrReservedHost('169.254.1.1'), true);
    assert.equal(doctor.isPrivateOrReservedHost('8.8.8.8'), false);
    assert.equal(doctor.isPrivateOrReservedHost('example.com'), false);
    assert.equal(doctor.isPrivateOrReservedHost('::1'), true);
    assert.equal(doctor.isPrivateOrReservedHost('fd00::1'), true);
    assert.equal(doctor.isPrivateOrReservedHost('fe80::1'), true);
    assert.equal(doctor.isPrivateOrReservedHost('2001:4860:4860::8888'), false);
});

test('fetchProbeText 真正限制 maxBytes（流式累计与 Content-Length）', async () => {
    const chunk = new Uint8Array(4).fill(65);
    const tooBigStream = await doctor.fetchProbeText(
        async () => streamingResponse({ chunks: [chunk, chunk] }),
        'https://export.arxiv.org/api/query',
        {},
        { maxBytes: 5, timeoutMs: 1000 }
    );
    assert.equal(tooBigStream.error?.code, 'PROBE_TOO_LARGE');

    let cancelled = false;
    const declared = await doctor.fetchProbeText(
        async () => streamingResponse({ headers: { 'content-length': '100' }, chunks: [], onCancel: () => { cancelled = true; } }),
        'https://export.arxiv.org/api/query',
        {},
        { maxBytes: 5, timeoutMs: 1000 }
    );
    assert.equal(declared.error?.code, 'PROBE_TOO_LARGE');
    assert.equal(cancelled, true, '超限时应取消响应体');

    const ok = await doctor.fetchProbeText(
        async () => streamingResponse({ chunks: [Buffer.from('hello')] }),
        'https://export.arxiv.org/api/query',
        {},
        { maxBytes: 100, timeoutMs: 1000 }
    );
    assert.equal(ok.error, null);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, 'hello');
});

test('fetchProbeText 手动重定向：逐跳校验并限制次数', async () => {
    const calls = [];
    const ok = await doctor.fetchProbeText(
        async (url, options) => {
            calls.push({ url, redirect: options.redirect });
            if (calls.length === 1) return redirectResponse('https://export.arxiv.org/next');
            return streamingResponse({ chunks: [Buffer.from('final')] });
        },
        'https://export.arxiv.org/api/query',
        {},
        { maxBytes: 100, timeoutMs: 1000 }
    );
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.redirect === 'manual'));
    assert.equal(ok.body, 'final');

    const insecure = await doctor.fetchProbeText(
        async () => redirectResponse('http://127.0.0.1/x'),
        'https://export.arxiv.org/api/query',
        {},
        { maxBytes: 100, timeoutMs: 1000 }
    );
    assert.equal(insecure.error?.code, 'PROBE_URL_INSECURE');

    const missing = await doctor.fetchProbeText(
        async () => redirectResponse(''),
        'https://export.arxiv.org/api/query',
        {},
        { maxBytes: 100, timeoutMs: 1000 }
    );
    assert.equal(missing.error?.code, 'PROBE_REDIRECT_INVALID');

    const loop = await doctor.fetchProbeText(
        async () => redirectResponse('https://export.arxiv.org/api/query'),
        'https://export.arxiv.org/api/query',
        {},
        { maxBytes: 100, timeoutMs: 1000, maxRedirects: 1 }
    );
    assert.equal(loop.error?.code, 'PROBE_REDIRECT_LIMIT');
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

test('主目录掩码与非主目录绝对路径截断', () => {
    assert.equal(doctor.maskPath('/Users/tester/blog', '/Users/tester'), '~/blog');
    assert.equal(doctor.maskPath('/Users/tester', '/Users/tester'), '~');
    assert.equal(doctor.maskPath('/tmp/x', '/Users/tester'), '/tmp/x');
    // 非主目录的绝对路径只保留末两级，避免泄露本机目录结构。
    assert.equal(doctor.maskPath('/Users/tester-other/blog', '/Users/tester'), '…/tester-other/blog');
    assert.equal(doctor.maskPath('/var/log/app/data', '/Users/tester'), '…/app/data');
    assert.equal(doctor.maskPath('data/current', '/Users/tester'), 'data/current');
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

test('runDoctor：仅在主副池共用 key 时增加凭据隔离 warn 行', async () => {
    const parsed = doctor.parseArgs(['--offline']);
    const healthy = await doctor.runDoctor({ parsed, projectRoot: '/fake/project', deps: fakeDeps() });
    assert.equal(healthy.checks.length, 15, '健康配置不新增体检行');
    assert.equal(byLabel(healthy.checks, '凭据隔离'), undefined);
    assert.equal(healthy.exitCode, 0);

    const sharedEnv = envWith({ PAPER_ANALYZER_FALLBACK_API_KEYS: 'sk-test-secondary-5678' });
    const shared = await doctor.runDoctor({
        parsed,
        projectRoot: '/fake/project',
        deps: fakeDeps({
            readEnvFile: () => ({ exists: true, mode: 0o600, entries: sharedEnv, readError: null, error: null })
        })
    });
    const isolation = byLabel(shared.checks, '凭据隔离');
    assert.ok(isolation, '共用 key 时应出现凭据隔离行');
    assert.equal(isolation.ok, 'warn');
    assert.match(isolation.detail, /相同的 key 值/);
    const serialized = JSON.stringify(shared.checks);
    assert.ok(!serialized.includes('sk-test-secondary-5678'), '不得输出共用值');
    assert.ok(!serialized.includes('sk-test-primary-1234'), '不得输出主 key 值');
    assert.equal(shared.exitCode, 0, 'warn 不改变退出码');
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

test('runDoctor：.env 不可读时模型/代理检查输出“未判定”而不级联 fail', async () => {
    const parsed = doctor.parseArgs(['--offline']);
    const result = await doctor.runDoctor({
        parsed,
        projectRoot: '/fake/project',
        deps: fakeDeps({
            readEnvFile: () => ({ exists: true, mode: 0o600, entries: {}, readError: '无法读取 .env: EACCES', error: null })
        })
    });
    assert.equal(byLabel(result.checks, '.env 文件与权限').ok, 'fail');
    for (const label of ['主模型配置', '副模型配置', 'HTTP 代理']) {
        const check = byLabel(result.checks, label);
        assert.equal(check.ok, 'warn', label);
        assert.match(check.detail, /因 \.env 不可读未判定/);
    }
    assert.equal(result.exitCode, 1);
});

test('CLI --help：普通输出为用法文本，--json 时仍输出可解析 JSON', () => {
    const { spawnSync } = require('node:child_process');
    const script = path.join(__dirname, '..', 'scripts', 'doctor.js');
    const plain = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
    assert.equal(plain.status, 0);
    assert.match(plain.stdout, /用法: node scripts\/doctor\.js/);

    const asJson = spawnSync(process.execPath, [script, '--json', '--help'], { encoding: 'utf8' });
    assert.equal(asJson.status, 0);
    const parsed = JSON.parse(asJson.stdout);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed[0].label, 'help');
    assert.match(parsed[0].detail, /用法: node scripts\/doctor\.js/);
});

test('CLI 沙箱守卫：spawn 时业务前 exit 1，import 时不杀进程', () => {
    const { spawnSync } = require('node:child_process');
    const script = path.join(__dirname, '..', 'scripts', 'doctor.js');
    const guarded = spawnSync(process.execPath, [script, '--offline'], {
        encoding: 'utf8',
        env: { ...process.env, CODEX_SANDBOX: '1' }
    });
    assert.equal(guarded.status, 1);
    assert.match(guarded.stderr, /沙箱外运行/);
    assert.ok(!guarded.stdout.includes('论文速递体检'), '沙箱内不得执行业务检查');

    // import 路径不得在模块加载时退出：子进程先设置沙箱标志再 require。
    const imported = spawnSync(process.execPath, [
        '-e',
        `process.env.CODEX_SANDBOX='1';require(${JSON.stringify(script)});process.stdout.write('imported-ok')`
    ], { encoding: 'utf8' });
    assert.equal(imported.status, 0);
    assert.equal(imported.stdout, 'imported-ok');
});

test('doctor 复用 env-schema：模型名/必填项/密钥识别/解析同源', () => {
    const envSchema = require('../scripts/lib/env-schema.js');
    assert.equal(doctor.REQUIRED_MODEL, envSchema.EXPECTED_MODEL);
    assert.deepEqual([...doctor.PRIMARY_REQUIRED_KEYS],
        envSchema.SCHEMA.filter(item => item.required).map(item => item.name));
    for (const name of Object.values(doctor.SECONDARY_MODEL_ENV)) {
        assert.ok(envSchema.SCHEMA_BY_NAME.has(name), name);
    }

    // 解析必须与 env-schema（进而与 env-loader 运行时语义）完全一致。
    const sample = [
        '# comment',
        'PAPER_ANALYZER_API_KEY="abc"',
        'PD_FILTER_BATCH_SIZE=3 # inline',
        'export NOT_SUPPORTED=1'
    ].join('\n');
    assert.deepEqual(doctor.parseDotEnvText(sample), envSchema.parseEnvText(sample));

    // 密钥识别也来自 schema：新登记的平台凭据会被脱敏。
    const secrets = doctor.collectSecretValues({
        FEISHU_APP_SECRET: 'feishu-secret-value',
        XIAOHONGSHU_COOKIES: 'xhs-cookie-value',
        PAPER_ANALYZER_MODEL: 'muse-spark-1.3-contributor'
    });
    assert.ok(secrets.includes('feishu-secret-value'));
    assert.ok(secrets.includes('xhs-cookie-value'));
    assert.ok(!secrets.includes('muse-spark-1.3-contributor'));
});
