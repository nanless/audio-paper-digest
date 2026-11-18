'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installTmpOnlyWriteGuard } = require('./helpers/isolated-tmp-write-guard.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const GUARD_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'direct-entry-role-guard-suite-')));
installTmpOnlyWriteGuard(GUARD_ROOT);

const role = require('../scripts/workspace-role.js');
const envLoader = require('../scripts/env-loader.js');

process.on('exit', () => {
    try {
        fs.rmSync(GUARD_ROOT, { recursive: true, force: true });
    } catch (_) {
        // ignore cleanup errors at exit
    }
});

const DAILY_CORE_ENTRIES = Object.freeze([
    'full-fetch.js',
    'batch-analyze.js',
    'deep-analysis-only.js',
    'reanalyze.js',
    'refresh-api-reader.js',
    'reanalyze-selected.js'
]);

function createIsolatedWorkspaceFixture(t) {
    const fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(GUARD_ROOT, 'workspace-')));
    t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

    const scriptsDir = path.join(fixtureRoot, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });

    // 复制 env-loader.js、workspace-role.js 和 6 个核心入口到隔离工作区，
    // 使其 __dirname / PROJECT_ROOT 指向 fixtureRoot，绝不触碰真实仓库标记或 .env。
    const copiedScripts = new Set([
        'env-loader.js',
        'workspace-role.js',
        ...DAILY_CORE_ENTRIES
    ]);
    for (const name of copiedScripts) {
        fs.copyFileSync(
            path.join(REPO_ROOT, 'scripts', name),
            path.join(scriptsDir, name)
        );
    }

    // 仅为验证 daily 角色通过后能正常进入各脚本参数校验提供最小只读依赖拷贝（限制在 GUARD_ROOT 内以遵守 tmp-write-guard）
    function copyTreeReadOnly(srcDir, destDir) {
        fs.mkdirSync(destDir, { recursive: true });
        for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
            const srcPath = path.join(srcDir, entry.name);
            const destPath = path.join(destDir, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                copyTreeReadOnly(srcPath, destPath);
            } else if (entry.isFile() && !fs.existsSync(destPath)) {
                fs.copyFileSync(srcPath, destPath);
            }
        }
    }

    for (const entry of fs.readdirSync(path.join(REPO_ROOT, 'scripts'), { withFileTypes: true })) {
        if (copiedScripts.has(entry.name) || entry.isSymbolicLink()) continue;
        const srcPath = path.join(REPO_ROOT, 'scripts', entry.name);
        const destPath = path.join(scriptsDir, entry.name);
        if (entry.isDirectory()) {
            copyTreeReadOnly(srcPath, destPath);
        } else if (entry.isFile()) {
            fs.copyFileSync(srcPath, destPath);
        }
    }
    copyTreeReadOnly(path.join(REPO_ROOT, 'config'), path.join(fixtureRoot, 'config'));
    copyTreeReadOnly(path.join(REPO_ROOT, 'prompts'), path.join(fixtureRoot, 'prompts'));
    copyTreeReadOnly(path.join(REPO_ROOT, 'manual', 'scripts'), path.join(fixtureRoot, 'manual', 'scripts'));

    return { fixtureRoot, scriptsDir };
}

function buildCleanSubprocessEnv(extra = {}) {
    const env = {
        ...process.env,
        NODE_PATH: path.join(REPO_ROOT, 'node_modules'),
        VERIFY_PROJECT_DISABLE_FILE_LOGS: '1'
    };
    delete env.CODEX_SANDBOX;
    delete env.AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE;
    delete env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE;
    delete env.PD_WORKSPACE_ALLOW_CROSS_ROLE;
    for (const [key, value] of Object.entries(extra)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
    }
    return env;
}

test('requiredWorkspaceRoleForCommand 将全部 6 个日更核心 Node 入口明确映射为 daily', () => {
    for (const script of DAILY_CORE_ENTRIES) {
        assert.equal(envLoader.requiredWorkspaceRoleForCommand(script), 'daily', script);
        assert.equal(envLoader.requiredWorkspaceRoleForCommand(`scripts/${script}`), 'daily', script);
    }
});

test('6 个日更核心 Node 入口裸跑时强制拒绝沙箱、缺失角色标记、history 工作区及错误包装器', t => {
    const realMarkerPath = path.join(REPO_ROOT, '.paper-digest-workspace-role.json');
    const realEnvPath = path.join(REPO_ROOT, '.env');
    const markerBefore = fs.existsSync(realMarkerPath) ? fs.readFileSync(realMarkerPath) : null;
    const envBefore = fs.existsSync(realEnvPath) ? fs.readFileSync(realEnvPath) : null;

    const { fixtureRoot, scriptsDir } = createIsolatedWorkspaceFixture(t);

    // 1. CODEX_SANDBOX 下全部 6 个入口在日志与环境初始化前立即拒绝
    for (const script of DAILY_CORE_ENTRIES) {
        const result = spawnSync(
            process.execPath,
            [path.join(scriptsDir, script)],
            {
                cwd: fixtureRoot,
                env: buildCleanSubprocessEnv({ CODEX_SANDBOX: 'seatbelt-test' }),
                encoding: 'utf8',
                timeout: 8000
            }
        );
        const output = `${result.stdout}${result.stderr}`;
        assert.notEqual(result.status, 0, `${script} 沙箱内不应返回 0`);
        assert.match(output, /必须在沙箱外运行/, `${script} 应输出必须在沙箱外运行`);
        assert.equal(fs.existsSync(path.join(fixtureRoot, 'logs')), false, `${script} 拒绝前不应创建 logs 目录`);
    }

    // 2. 无工作区角色标记时，全部 6 个入口裸跑立即拒绝（包括含顶层 env 检查的 reanalyze.js）
    for (const script of DAILY_CORE_ENTRIES) {
        const result = spawnSync(
            process.execPath,
            [path.join(scriptsDir, script)],
            {
                cwd: fixtureRoot,
                env: buildCleanSubprocessEnv(),
                encoding: 'utf8',
                timeout: 8000
            }
        );
        const output = `${result.stdout}${result.stderr}`;
        assert.notEqual(result.status, 0, `${script} 无角色标记不应返回 0`);
        assert.match(output, /工作区角色标记缺失/, `${script} 应报工作区角色标记缺失，实际输出: ${output}`);
        assert.doesNotMatch(output, /缺少必需环境变量/, `${script} 必须在业务逻辑和环境变量报错前先拦截角色`);
        assert.equal(fs.existsSync(path.join(fixtureRoot, 'logs')), false, `${script} 拒绝前不应创建 logs 目录`);
    }

    // 3. history 工作区（即使开启 PD_WORKSPACE_ALLOW_CROSS_ROLE=1）裸跑全部 6 个入口均立即拒绝
    role.writeWorkspaceRole('history', { root: fixtureRoot });
    for (const allowCross of [undefined, '1']) {
        for (const script of DAILY_CORE_ENTRIES) {
            const result = spawnSync(
                process.execPath,
                [path.join(scriptsDir, script)],
                {
                    cwd: fixtureRoot,
                    env: buildCleanSubprocessEnv({ PD_WORKSPACE_ALLOW_CROSS_ROLE: allowCross }),
                    encoding: 'utf8',
                    timeout: 8000
                }
            );
            const output = `${result.stdout}${result.stderr}`;
            assert.notEqual(result.status, 0, `${script} 在 history 工作区不应返回 0`);
            assert.match(output, /当前工作区 role=history，该命令只允许 role=daily/, `${script} 应拒绝 history 工作区`);
            assert.equal(fs.existsSync(path.join(fixtureRoot, 'logs')), false, `${script} 拒绝前不应创建 logs 目录`);
        }
    }

    // 4. daily 工作区下：错误传入 wrapper=history 仍拒绝；正常 daily 角色通过角色门并进入各自参数/环境检查
    role.writeWorkspaceRole('daily', { root: fixtureRoot, force: true });
    for (const script of DAILY_CORE_ENTRIES) {
        const wrongWrapper = spawnSync(
            process.execPath,
            [path.join(scriptsDir, script), '--invalid-flag-for-role-test'],
            {
                cwd: fixtureRoot,
                env: buildCleanSubprocessEnv({ AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE: 'history' }),
                encoding: 'utf8',
                timeout: 8000
            }
        );
        assert.notEqual(wrongWrapper.status, 0, `${script} wrapper=history 应拒绝`);
        assert.match(
            `${wrongWrapper.stdout}${wrongWrapper.stderr}`,
            /固定要求 role=daily，当前环境指定 wrapper=history/,
            script
        );

        const validDaily = spawnSync(
            process.execPath,
            [path.join(scriptsDir, script), '--invalid-flag-for-role-test'],
            {
                cwd: fixtureRoot,
                env: buildCleanSubprocessEnv(),
                encoding: 'utf8',
                timeout: 10000
            }
        );
        const validOutput = `${validDaily.stdout}${validDaily.stderr}`;
        assert.notEqual(validDaily.status, 0);
        assert.doesNotMatch(validOutput, /工作区角色标记缺失|只允许 role=daily|必须在沙箱外运行|Cannot find module/, `${script} 在 daily 工作区应通过角色守卫`);
        assert.match(validOutput, /未知参数|无法识别参数|用法[：:]|缺少(?:必需)?环境变量|不存在/, `${script} 应进入自身参数或前置状态校验，实际输出: ${validOutput}`);
    }

    // 5. 单元测试在无角色标记的临时工作区中 require() 导入导出纯函数时，不要求角色标记
    const importOnlyRoot = createIsolatedWorkspaceFixture(t);
    fs.writeFileSync(
        path.join(importOnlyRoot.fixtureRoot, '.env'),
        [
            'PAPER_ANALYZER_ENDPOINT=https://example.invalid/v1',
            'PAPER_ANALYZER_API_KEY=test-dummy-key-value',
            'PAPER_ANALYZER_MODEL=muse-spark-1.3-contributor'
        ].join('\n') + '\n',
        { encoding: 'utf8', mode: 0o600 }
    );
    const importerScript = path.join(importOnlyRoot.fixtureRoot, 'unit-import-check.cjs');
    fs.writeFileSync(importerScript, `'use strict';
const path = require('node:path');
for (const name of ['full-fetch.js', 'batch-analyze.js', 'deep-analysis-only.js', 'reanalyze.js', 'refresh-api-reader.js', 'reanalyze-selected.js']) {
    const exported = require(path.join(__dirname, 'scripts', name));
    if (!exported || typeof exported !== 'object') {
        throw new Error('unexpected export for ' + name);
    }
}
process.stdout.write('import-without-marker-ok');
`, 'utf8');
    const importResult = spawnSync(
        process.execPath,
        [importerScript],
        {
            cwd: importOnlyRoot.fixtureRoot,
            env: buildCleanSubprocessEnv(),
            encoding: 'utf8',
            timeout: 15000
        }
    );
    assert.equal(importResult.status, 0, importResult.stderr);
    assert.equal(importResult.stdout, 'import-without-marker-ok');

    // 确认真实仓库文件字节未被修改
    if (markerBefore !== null) {
        assert.deepEqual(fs.readFileSync(realMarkerPath), markerBefore);
    } else {
        assert.equal(fs.existsSync(realMarkerPath), false);
    }
    if (envBefore !== null) {
        assert.deepEqual(fs.readFileSync(realEnvPath), envBefore);
    } else {
        assert.equal(fs.existsSync(realEnvPath), false);
    }
});
