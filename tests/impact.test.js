'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const impact = require('../scripts/impact');

const ROOT = path.resolve(__dirname, '..');
const IMPACT_CLI = path.join(ROOT, 'scripts', 'impact.js');

function captureMain(argv, options = {}) {
    const stdout = [];
    const stderr = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args) => stdout.push(args.map(String).join(' '));
    console.error = (...args) => stderr.push(args.map(String).join(' '));
    try {
        const code = impact.main(argv, { quiet: true, ...options });
        return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
    } finally {
        console.log = origLog;
        console.error = origErr;
    }
}

test('已知路径列出受影响入口与测试', () => {
    const result = impact.impactOf('scripts/publish_common.py');
    assert.strictEqual(result.matched, true);
    assert.ok(result.entries.includes('blog:review'));
    assert.ok(result.tests.some(test => test.includes('test_publish')));
});

test('分析引擎与目录参数能命中', () => {
    const engine = impact.impactOf('scripts/analysis-engine.js');
    assert.strictEqual(engine.matched, true);
    assert.ok(engine.entries.includes('deep'));
    const dir = impact.impactOf('scripts');
    assert.strictEqual(dir.matched, true);
});

test('未知路径给出通用建议', () => {
    const result = impact.impactOf('unknown/file.txt');
    assert.strictEqual(result.matched, false);
    assert.match(result.scope, /通用规则/);
});

function entryCovered(entries, name) {
    return entries.some(entry => entry === name
        || entry.endsWith(':*') && name.startsWith(entry.slice(0, -1)));
}

test('package.json 里每个 Reader 相关入口都有映射', () => {
    // 这些脚本直接驱动会读取/重验 Reader 的流程；新增同类入口时先登记到这里。
    const driverPattern = /(?:deep-analysis-only|batch-analyze|reanalyze|reanalyze-selected|refresh-api-reader|conference-process|migrate-conference-process|historical-direct-rewrite-run|historical-direct-publication)\.js/;
    const readerEntries = Object.entries(require('../package.json').scripts)
        .filter(([, command]) => driverPattern.test(command))
        .map(([name]) => name);
    assert.ok(readerEntries.length > 0);
    const result = impact.impactOf('scripts/lib/reader-contract.js');
    assert.strictEqual(result.matched, true);
    for (const name of readerEntries) {
        assert.ok(entryCovered(result.entries, name),
            `${name} 未出现在 Reader 库影响映射：${result.entries.join(', ')}`);
    }
});

test('真实深层 scripts/lib 模块通过反向传递依赖定位入口、npm 命令与精确测试且具备毫秒级缓存', () => {
    const scheduler = impact.impactOf('scripts/lib/source-classification-scheduler.js');
    assert.strictEqual(scheduler.matched, true);
    assert.ok(scheduler.entries.includes('history:source-tags'));
    assert.ok(scheduler.npmCommands.includes('npm run history:source-tags'));
    assert.ok(scheduler.exactTests.js.includes('tests/source-classification-scheduler.test.js'));
    assert.ok(scheduler.exactTests.js.includes('tests/historical-source-tag-assignment.test.js'));

    const archiveAuth = impact.impactOf('scripts/lib/historical-archive-crawl-authority.js');
    assert.strictEqual(archiveAuth.matched, true);
    assert.ok(archiveAuth.entries.includes('history:crosswalk'));
    assert.ok(archiveAuth.npmCommands.includes('npm run history:crosswalk'));
    assert.ok(archiveAuth.reverseClosure.includes('scripts/page-source-crosswalk.js'));

    const started = Date.now();
    const announce = impact.impactOf('scripts/lib/daily-arxiv-announcement-source.js');
    const elapsedMs = Date.now() - started;
    assert.strictEqual(announce.matched, true);
    assert.ok(announce.entries.includes('fetch'));
    assert.ok(announce.entries.includes('digest:prepare'));
    assert.ok(announce.exactTests.js.includes('tests/daily-arxiv-oai-source.test.js'));
    assert.ok(elapsedMs < 100, `惰性缓存命中后应保持毫秒级响应，实际耗时 ${elapsedMs}ms`);
});

test('精准识别五大协议与阶段指纹爆炸半径闭包（含完整生产入口）且不误报无关脚本', () => {
    const idsOf = target => impact.impactOf(target).fingerprintImpacts.map(item => item.id);

    // 1) paperPageRenderer：覆盖日更/会议/历史页面渲染与标签展示策略
    const rendererRes = impact.impactOf('config/publish-image-exclusions.json');
    assert.strictEqual(rendererRes.matched, true);
    assert.ok(rendererRes.fingerprintImpacts.some(item =>
        item.id === 'paperPageRenderer' && item.effect.includes('rendererImplementationSha256')));
    for (const rendererFile of [
        'scripts/lib/paper-page-staging.js',
        'scripts/generate-blog.py',
        'scripts/conference-page-render.py',
        'scripts/lib/conference-postprocess.js',
        'scripts/lib/historical-direct-aggregate.js',
        'config/tag-display-policy.json'
    ]) {
        assert.ok(idsOf(rendererFile).includes('paperPageRenderer'), `${rendererFile} 应命中 paperPageRenderer`);
    }

    // 2) blogReviewProtocol：覆盖日更/会议/历史博客审查协议
    const reviewRes = impact.impactOf('scripts/review-blog.py');
    assert.ok(reviewRes.fingerprintImpacts.some(item =>
        item.id === 'blogReviewProtocol' && item.effect.includes('reviewProtocolFingerprint')));
    assert.ok(idsOf('scripts/historical-direct-review.py').includes('blogReviewProtocol'));
    assert.ok(idsOf('scripts/lib/historical-direct-publication.js').includes('blogReviewProtocol'));

    // 3) conferenceProcess：覆盖当前实现清单及进程迁移工作线程池闭包
    assert.ok(idsOf('prompts/current/deep-analysis.md').includes('conferenceProcess'));
    assert.ok(idsOf('scripts/lib/conference-importer.js').includes('conferenceProcess'));
    assert.ok(idsOf('scripts/lib/conference-complete-stage-pool.js').includes('conferenceProcess'));

    // 4) historicalDirectRewrite
    assert.ok(idsOf('scripts/historical-direct-rewrite-inputs.js').includes('historicalDirectRewrite'));
    assert.ok(idsOf('scripts/lib/historical-direct-publication.js').includes('historicalDirectRewrite'));

    // 5) clientProtocols：覆盖 clients*.json、生成器、双端 protocol_codec 与原生客户端协议文件
    const nativeProtoIds = idsOf('config/protocols/clients-reading.json');
    assert.deepStrictEqual(nativeProtoIds, ['clientProtocols']);
    assert.ok(idsOf('scripts/lib/protocol-codec.js').includes('clientProtocols'));
    const clientGen = impact.impactOf('apps/generate-client-protocols.py');
    assert.ok(clientGen.fingerprintImpacts.some(item => item.id === 'clientProtocols'));
    assert.ok(clientGen.exactTests.python.includes('tests/python/test_client_protocol_generation.py'));

    // 负例：纯诊断锁观察工具不属于任何协议/渲染指纹闭包
    assert.deepStrictEqual(idsOf('scripts/locks.js'), []);
});

test('严格拦截工作区越界路径（.. / 外部绝对路径）及内外部符号链接穿透', t => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-symlink-guard-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-outside-secret-'));
    t.after(() => {
        impact.clearCaches();
        fs.rmSync(tmpBase, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    fs.mkdirSync(path.join(outsideDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'secret.js'), "module.exports = 'outside';\n");
    fs.writeFileSync(path.join(outsideDir, 'scripts', 'publish_common.py'), "# outside decoy\n");
    fs.writeFileSync(path.join(outsideDir, 'secret.test.js'), "require('node:test')('x', () => {});\n");

    fs.mkdirSync(path.join(tmpBase, 'scripts', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(tmpBase, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(tmpBase, 'data', 'current'), { recursive: true });
    fs.mkdirSync(path.join(tmpBase, 'node_modules', 'pkg'), { recursive: true });

    fs.writeFileSync(path.join(tmpBase, 'package.json'), JSON.stringify({
        scripts: { 'safe:cmd': 'node scripts/safe.js' }
    }));
    fs.writeFileSync(path.join(tmpBase, 'scripts', 'safe.js'), "'use strict';\nmodule.exports = 1;\n");
    fs.writeFileSync(path.join(tmpBase, 'scripts', 'publish_common.py'), "# inside real\n");
    fs.writeFileSync(path.join(tmpBase, 'data', 'current', 'prod.js'), "require('../../scripts/safe.js');\n");
    fs.writeFileSync(path.join(tmpBase, 'node_modules', 'pkg', 'index.js'), "require('../../scripts/safe.js');\n");

    // 仓内软链 -> 仓外文件/目录
    fs.symlinkSync(path.join(outsideDir, 'secret.js'), path.join(tmpBase, 'scripts', 'evil-link.js'));
    fs.symlinkSync(outsideDir, path.join(tmpBase, 'scripts', 'evil-dir'));
    fs.symlinkSync(path.join(outsideDir, 'secret.test.js'), path.join(tmpBase, 'tests', 'evil.test.js'));

    // 仓外软链 -> 仓内真实文件与目录（验证外部软链穿透防护）
    const extFileLink = path.join(outsideDir, 'ext-to-inside.py');
    const extDirLink = path.join(outsideDir, 'ext-scripts-link');
    fs.symlinkSync(path.join(tmpBase, 'scripts', 'publish_common.py'), extFileLink);
    fs.symlinkSync(path.join(tmpBase, 'scripts'), extDirLink);

    const graph = impact.buildDependencyGraph({ root: tmpBase, fresh: true });
    assert.strictEqual(graph.files.has('scripts/safe.js'), true);
    assert.strictEqual(graph.files.has('scripts/evil-link.js'), false);
    assert.strictEqual(graph.files.has('scripts/evil-dir/secret.js'), false);
    assert.strictEqual(graph.files.has('tests/evil.test.js'), false);
    assert.strictEqual(graph.files.has('data/current/prod.js'), false);
    assert.strictEqual(graph.files.has('node_modules/pkg/index.js'), false);

    // 越界路径（..、../、含 MAP 关键词的外部相对/绝对路径）与内外部软链均须返回 matched: false
    for (const forbidden of [
        '..',
        '../',
        '../outside/scripts/publish_common.py',
        path.join(outsideDir, 'scripts', 'publish_common.py'),
        '/tmp/nonexistent-outside/scripts/deep-analyzer.js',
        'scripts/evil-link.js',
        'scripts/evil-dir/secret.js',
        'data/current/prod.js',
        extFileLink,
        path.join(extDirLink, 'publish_common.py')
    ]) {
        const res = impact.impactOf(forbidden, { root: tmpBase });
        assert.strictEqual(res.matched, false, `越界或软链目标不应命中: ${forbidden}`);
        assert.deepStrictEqual(res.entries, []);
        assert.deepStrictEqual(res.tests, []);
    }

    // 合法的未解析软链根目录别名（如 macOS /var/folders/...）内真实文件仍可正常定位
    const validInsideAbs = path.join(tmpBase, 'scripts', 'safe.js');
    assert.strictEqual(impact.impactOf(validInsideAbs, { root: tmpBase }).matched, true);
});

test('静态依赖图解析跨行括号 Python import、require.resolve、SCRIPTS_DIR/MANUAL_SCRIPTS_DIR 且 fresh 覆盖更新缓存', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-parser-cache-'));
    t.after(() => {
        impact.clearCaches();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    fs.mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'manual', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tests', 'python'), { recursive: true });

    fs.writeFileSync(path.join(dir, 'scripts', 'lib', 'resolved-mod.js'), "'use strict';\nmodule.exports = 1;\n");
    fs.writeFileSync(path.join(dir, 'scripts', 'py_worker.py'), "VALUE = 42\n");
    fs.writeFileSync(path.join(dir, 'manual', 'scripts', 'manual_worker.py'), "MVAL = 7\n");
    fs.writeFileSync(path.join(dir, 'scripts', 'caller.js'), [
        "'use strict';",
        "const path = require('node:path');",
        "const target = require.resolve('./lib/resolved-mod');",
        "const SCRIPTS_DIR = path.join(__dirname);",
        "const MANUAL_SCRIPTS_DIR = path.join(__dirname, '..', 'manual', 'scripts');",
        "const py = path.join(SCRIPTS_DIR, 'py_worker.py');",
        "const mpy = path.join(MANUAL_SCRIPTS_DIR, 'manual_worker.py');",
        "module.exports = { target, py, mpy };",
        ""
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'tests', 'caller.test.js'),
        "'use strict';\nrequire('../scripts/caller');\n");
    fs.writeFileSync(path.join(dir, 'tests', 'python', 'test_multiline.py'), [
        "from py_worker import (  # inline comment on open paren",
        "    VALUE,  # trailing comment",
        ")",
        "from pathlib import Path",
        "MANUAL_SCRIPTS_DIR = Path('.')",
        "SPEC = MANUAL_SCRIPTS_DIR / 'manual_worker.py'",
        ""
    ].join('\n'));

    // 首次建图缓存
    assert.deepStrictEqual(impact.impactOf('scripts/lib/resolved-mod.js', { root: dir }).exactTests.js, ['tests/caller.test.js']);
    assert.deepStrictEqual(impact.impactOf('scripts/py_worker.py', { root: dir }).exactTests, {
        js: ['tests/caller.test.js'],
        python: ['tests/python/test_multiline.py']
    });
    assert.deepStrictEqual(impact.impactOf('manual/scripts/manual_worker.py', { root: dir }).exactTests, {
        js: ['tests/caller.test.js'],
        python: ['tests/python/test_multiline.py']
    });

    // 新增文件后：fresh: true 重建必须覆盖更新缓存，使紧随其后的无 fresh 调用也能读取最新图
    fs.writeFileSync(path.join(dir, 'scripts', 'late-added.js'), "'use strict';\nmodule.exports = 2;\n");
    fs.writeFileSync(path.join(dir, 'tests', 'late-added.test.js'), "'use strict';\nrequire('../scripts/late-added');\n");
    assert.strictEqual(impact.impactOf('scripts/late-added.js', { root: dir }).matched, false);
    assert.strictEqual(impact.impactOf('scripts/late-added.js', { root: dir, fresh: true }).matched, true);
    const cachedAfterFresh = impact.impactOf('scripts/late-added.js', { root: dir });
    assert.strictEqual(cachedAfterFresh.matched, true);
    assert.deepStrictEqual(cachedAfterFresh.exactTests.js, ['tests/late-added.test.js']);
});

test('隔离 Git 仓库验证无锁 -z 解析、最小环境隔离（防密钥与 GIT_DIR 穿透）、中文/空格/箭头路径与 git mv 重命名', t => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-git-porcelain-z-'));
    t.after(() => {
        impact.clearCaches();
        fs.rmSync(repoDir, { recursive: true, force: true });
    });

    fs.mkdirSync(path.join(repoDir, 'scripts', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'tests', 'python'), { recursive: true });

    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
        name: 'impact-git-z-fixture',
        scripts: {
            'alpha:run': 'node scripts/alpha-entry.js',
            'py:worker': 'bash scripts/python-runtime.sh scripts/py_calc.py'
        }
    }, null, 2));
    fs.writeFileSync(path.join(repoDir, 'scripts', 'lib', 'deep-leaf.js'),
        "'use strict';\nmodule.exports = { add: (a, b) => a + b };\n");
    fs.writeFileSync(path.join(repoDir, 'scripts', 'alpha-entry.js'),
        "'use strict';\nconst { add } = require('./lib/deep-leaf');\nmodule.exports = { run: () => add(2, 3) };\n");
    fs.writeFileSync(path.join(repoDir, 'scripts', 'old-target.js'), "'use strict';\nmodule.exports = 'old';\n");
    fs.writeFileSync(path.join(repoDir, 'scripts', '中文 模块.js'), "'use strict';\nmodule.exports = 'zh';\n");
    fs.writeFileSync(path.join(repoDir, 'scripts', 'weird -> arrow.js'), "'use strict';\nmodule.exports = 'arrow';\n");
    fs.writeFileSync(path.join(repoDir, 'scripts', 'stem-widget.js'), "'use strict';\nmodule.exports = { ok: true };\n");
    fs.writeFileSync(path.join(repoDir, 'scripts', 'ste.js'), "'use strict';\nmodule.exports = { short: true };\n");
    fs.writeFileSync(path.join(repoDir, 'scripts', 'py_calc.py'), "def double(x):\n    return x * 2\n");

    fs.writeFileSync(path.join(repoDir, 'tests', 'alpha-caller.test.js'), [
        "'use strict';",
        "const test = require('node:test');",
        "const assert = require('node:assert/strict');",
        "const entry = require('../scripts/alpha-entry');",
        "test('alpha run & log disable env', () => {",
        "    assert.equal(entry.run(), 5);",
        "    assert.equal(process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS, '1');",
        "});",
        ""
    ].join('\n'));
    fs.writeFileSync(path.join(repoDir, 'tests', 'old-target.test.js'),
        "'use strict';\nrequire('node:test')('t', () => {});\n");
    fs.writeFileSync(path.join(repoDir, 'tests', 'stem-widget-extra.test.js'),
        "'use strict';\nrequire('node:test')('stem', () => {});\n");
    fs.writeFileSync(path.join(repoDir, 'tests', 'python', 'test_py_calc.py'), [
        "import os",
        "import sys",
        "import unittest",
        "from pathlib import Path",
        "sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))",
        "from py_calc import double",
        "",
        "class PyCalcTest(unittest.TestCase):",
        "    def test_double_and_env(self):",
        "        self.assertEqual(double(4), 8)",
        "        self.assertEqual(os.environ.get('VERIFY_PROJECT_DISABLE_FILE_LOGS'), '1')",
        ""
    ].join('\n'));

    const gitSetupEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'tester',
        GIT_AUTHOR_EMAIL: 'tester@example.com',
        GIT_COMMITTER_NAME: 'tester',
        GIT_COMMITTER_EMAIL: 'tester@example.com'
    };
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, env: gitSetupEnv, stdio: 'pipe' });
    execFileSync('git', ['add', '.'], { cwd: repoDir, env: gitSetupEnv, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init fixture'], { cwd: repoDir, env: gitSetupEnv, stdio: 'pipe' });

    // 1) 拦截并核验 git 子进程参数、超时与最小环境隔离（不得泄漏密钥或外层 GIT_DIR/GIT_WORK_TREE）
    const prevKey = process.env.PAPER_ANALYZER_API_KEY;
    const prevGitDir = process.env.GIT_DIR;
    const prevWorkTree = process.env.GIT_WORK_TREE;
    let capturedGitCall = null;
    try {
        process.env.PAPER_ANALYZER_API_KEY = 'sk-top-secret-should-not-pass';
        process.env.GIT_DIR = '/nonexistent/polluted-git-dir';
        process.env.GIT_WORK_TREE = '/nonexistent/polluted-work-tree';

        impact.impactFromGitStatus({
            root: repoDir,
            spawnSync: (cmd, args, opts) => {
                capturedGitCall = { cmd, args, opts };
                return { status: 0, stdout: '', stderr: '' };
            }
        });
        assert.ok(capturedGitCall);
        assert.strictEqual(capturedGitCall.cmd, 'git');
        assert.deepStrictEqual(capturedGitCall.args, [
            '--no-optional-locks', '-C', fs.realpathSync(repoDir), 'status', '--porcelain=v1', '-z'
        ]);
        assert.strictEqual(capturedGitCall.opts.env.GIT_OPTIONAL_LOCKS, '0');
        assert.strictEqual(capturedGitCall.opts.env.GIT_TERMINAL_PROMPT, '0');
        assert.strictEqual(capturedGitCall.opts.env.LC_ALL, 'C');
        assert.strictEqual(capturedGitCall.opts.env.PAPER_ANALYZER_API_KEY, undefined);
        assert.strictEqual(capturedGitCall.opts.env.GIT_DIR, undefined);
        assert.strictEqual(capturedGitCall.opts.env.GIT_WORK_TREE, undefined);
        assert.strictEqual(capturedGitCall.opts.timeout, 15000);
        assert.strictEqual(capturedGitCall.opts.killSignal, 'SIGKILL');

        // 即使外层进程存在错误 GIT_DIR，真实 git 调用因最小环境隔离仍能在 repoDir 正常执行
        const cleanRun = captureMain(['--git'], { root: repoDir });
        assert.strictEqual(cleanRun.code, 0, cleanRun.stderr);
        assert.match(cleanRun.stdout, /无已修改文件/);
    } finally {
        if (prevKey === undefined) delete process.env.PAPER_ANALYZER_API_KEY;
        else process.env.PAPER_ANALYZER_API_KEY = prevKey;
        if (prevGitDir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = prevGitDir;
        if (prevWorkTree === undefined) delete process.env.GIT_WORK_TREE;
        else process.env.GIT_WORK_TREE = prevWorkTree;
    }

    // 2) 词干边界校验
    assert.deepStrictEqual(impact.impactOf('scripts/ste.js', { root: repoDir, fresh: true }).exactTests.js, []);
    const multi = captureMain(['scripts/lib/deep-leaf.js', 'scripts/stem-widget.js', '--json'], { root: repoDir });
    assert.strictEqual(multi.code, 0);
    assert.deepStrictEqual(JSON.parse(multi.stdout).exactTests.js, [
        'tests/alpha-caller.test.js', 'tests/stem-widget-extra.test.js'
    ]);

    // 3) 真实 git mv 重命名 + 中文空格路径 + 含 ' -> ' 文件名 + Python/JS 改动联合解析与执行
    execFileSync('git', ['mv', 'scripts/old-target.js', 'scripts/renamed -> target.js'], {
        cwd: repoDir, env: gitSetupEnv, stdio: 'pipe'
    });
    fs.appendFileSync(path.join(repoDir, 'scripts', '中文 模块.js'), '// zh edit\n');
    fs.appendFileSync(path.join(repoDir, 'scripts', 'weird -> arrow.js'), '// arrow edit\n');
    fs.appendFileSync(path.join(repoDir, 'scripts', 'lib', 'deep-leaf.js'), '// leaf edit\n');
    fs.appendFileSync(path.join(repoDir, 'scripts', 'py_calc.py'), '# py edit\n');

    const dirtyRun = captureMain(['--git', '--run-tests', '--json'], { root: repoDir, fresh: true });
    assert.strictEqual(dirtyRun.code, 0, dirtyRun.stderr);
    const dirtyParsed = JSON.parse(dirtyRun.stdout);
    assert.strictEqual(dirtyParsed.clean, false);
    for (const expectedGitFile of [
        'scripts/renamed -> target.js',
        'scripts/old-target.js',
        'scripts/中文 模块.js',
        'scripts/weird -> arrow.js',
        'scripts/lib/deep-leaf.js',
        'scripts/py_calc.py'
    ]) {
        assert.ok(dirtyParsed.gitFiles.includes(expectedGitFile), `缺少 Git 变更路径: ${expectedGitFile}`);
    }
    assert.ok(dirtyParsed.testRun.jsTests.includes('tests/alpha-caller.test.js'));
    assert.deepStrictEqual(dirtyParsed.testRun.pythonTests, ['tests/python/test_py_calc.py']);
    assert.match(dirtyRun.stderr, /定向测试通过不代替提交前完整 `npm run verify`/);
});

test('Python 双套件同目录 helper 隔离执行（不跨套件污染 sys.modules）且 JS/Python 失败均不短路后续套件', t => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-suite-isolation-'));
    t.after(() => {
        impact.clearCaches();
        fs.rmSync(repoDir, { recursive: true, force: true });
    });

    fs.mkdirSync(path.join(repoDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'tests', 'python'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'manual', 'tests', 'python'), { recursive: true });

    const markerDir = path.join(repoDir, 'markers');
    fs.mkdirSync(markerDir, { recursive: true });

    // 故意在 tests/python 与 manual/tests/python 放置同名 helper（suite_local_helper.py），验证独立进程与 PYTHONPATH 隔离
    fs.writeFileSync(path.join(repoDir, 'tests', 'python', 'suite_local_helper.py'), "SUITE_TAG = 'default-suite'\n");
    fs.writeFileSync(path.join(repoDir, 'manual', 'tests', 'python', 'suite_local_helper.py'), "SUITE_TAG = 'manual-suite'\n");

    fs.writeFileSync(path.join(repoDir, 'tests', 'python', 'test_alpha_suite.py'), [
        "import unittest",
        "from pathlib import Path",
        "import suite_local_helper",
        "",
        "class AlphaSuiteTest(unittest.TestCase):",
        "    def test_helper_and_fail(self):",
        `        Path(${JSON.stringify(path.join(markerDir, 'py-default.ran'))}).write_text(suite_local_helper.SUITE_TAG, encoding='utf-8')`,
        "        self.assertEqual(suite_local_helper.SUITE_TAG, 'default-suite')",
        "        self.fail('intentional first python suite failure')",
        ""
    ].join('\n'));

    fs.writeFileSync(path.join(repoDir, 'manual', 'tests', 'python', 'test_beta_manual.py'), [
        "import unittest",
        "from pathlib import Path",
        "import suite_local_helper",
        "",
        "class BetaManualSuiteTest(unittest.TestCase):",
        "    def test_isolated_helper_runs_even_after_failures(self):",
        `        Path(${JSON.stringify(path.join(markerDir, 'py-manual.ran'))}).write_text(suite_local_helper.SUITE_TAG, encoding='utf-8')`,
        "        self.assertEqual(suite_local_helper.SUITE_TAG, 'manual-suite')",
        ""
    ].join('\n'));

    // 同时让 JS 测试也失败，验证 JS 失败不会短路 Python 套件，且第一个 Python 套件失败不会短路第二个 Python 套件
    fs.writeFileSync(path.join(repoDir, 'tests', 'js-broken.test.js'), [
        "'use strict';",
        "const test = require('node:test');",
        "const assert = require('node:assert/strict');",
        `require('node:fs').writeFileSync(${JSON.stringify(path.join(markerDir, 'js.ran'))}, 'ran');`,
        "test('broken js', () => { assert.fail('boom'); });",
        ""
    ].join('\n'));

    const runRes = impact.runAffectedTests({
        exactTests: {
            js: ['tests/js-broken.test.js'],
            python: ['tests/python/test_alpha_suite.py', 'manual/tests/python/test_beta_manual.py']
        },
        tests: []
    }, { root: repoDir, fresh: true, json: true, quiet: true });

    assert.strictEqual(runRes.jsOk, false);
    assert.strictEqual(runRes.pyOk, false);
    assert.strictEqual(runRes.ok, false);
    assert.strictEqual(runRes.exitCode, 1);
    assert.strictEqual(fs.readFileSync(path.join(markerDir, 'js.ran'), 'utf8'), 'ran');
    assert.strictEqual(fs.readFileSync(path.join(markerDir, 'py-default.ran'), 'utf8'), 'default-suite');
    assert.strictEqual(fs.readFileSync(path.join(markerDir, 'py-manual.ran'), 'utf8'), 'manual-suite');

    // 通配符展开有界保护
    const capped = impact.runAffectedTests(
        { exactTests: { js: [], python: [] }, tests: ['tests/*'] },
        { root: repoDir, maxWildcardTests: 0, json: true, quiet: true }
    );
    assert.strictEqual(capped.ok, true);
    assert.strictEqual(capped.jsOk, true);
    assert.strictEqual(capped.pyOk, true);
    assert.match(capped.wildcardNotice, /超过自动执行上限/);

    // 大规模反向闭包 JS 分批串行执行（含浮点/Infinity jsBatchSize 归一化与显式 testTimeoutMs 透传）
    fs.writeFileSync(path.join(repoDir, 'tests', 'js-ok-second.test.js'),
        "'use strict';\nrequire('node:test')('ok2', () => {});\n");
    const jsBatches = [];
    let pyCapturedTimeout = null;
    const batchedRes = impact.runAffectedTests(
        {
            exactTests: {
                js: ['tests/js-broken.test.js', 'tests/js-ok-second.test.js'],
                python: ['tests/python/test_alpha_suite.py']
            },
            tests: []
        },
        {
            root: repoDir,
            jsBatchSize: 1.9,
            testTimeoutMs: 5000,
            json: true,
            quiet: true,
            spawnSync: (cmd, args, opts) => {
                if (cmd === 'bash') {
                    pyCapturedTimeout = opts.timeout;
                    return { status: 0, stdout: '', stderr: '' };
                }
                jsBatches.push({ args, maxBuffer: opts.maxBuffer, timeout: opts.timeout });
                return { status: args.includes('tests/js-broken.test.js') ? 1 : 0, stdout: '', stderr: '' };
            }
        }
    );
    assert.strictEqual(batchedRes.jsOk, false);
    assert.strictEqual(batchedRes.pyOk, true);
    assert.strictEqual(batchedRes.exitCode, 1);
    assert.strictEqual(jsBatches.length, 2);
    assert.deepStrictEqual(jsBatches[0].args, ['--test', '--test-concurrency=1', 'tests/js-broken.test.js']);
    assert.deepStrictEqual(jsBatches[1].args, ['--test', '--test-concurrency=1', 'tests/js-ok-second.test.js']);
    assert.strictEqual(jsBatches[0].maxBuffer, 64 * 1024 * 1024);
    assert.strictEqual(jsBatches[0].timeout, 5000);
    assert.strictEqual(pyCapturedTimeout, 5000);
});

test('真实子进程验证 --help --json、--json --run-tests 纯净 JSON stdout 以及非法/空白/冲突参数与沙箱拒绝', t => {
    // 1) 真实 CLI --help --json 输出纯 JSON 且退出 0
    const helpJson = spawnSync(process.execPath, [IMPACT_CLI, '--help', '--json'], {
        cwd: ROOT,
        encoding: 'utf8'
    });
    assert.strictEqual(helpJson.status, 0, helpJson.stderr);
    const helpPayload = JSON.parse(helpJson.stdout);
    assert.strictEqual(helpPayload.help, true);
    assert.match(helpPayload.usage, /用法:/);

    // 2) 真实子进程运行 --json --run-tests（不传 quiet）：子单测大量 console.log 噪音重定向到 stderr，stdout 保持纯净可解析 JSON
    const noisyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-noisy-json-'));
    t.after(() => fs.rmSync(noisyRepo, { recursive: true, force: true }));
    fs.mkdirSync(path.join(noisyRepo, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(noisyRepo, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(noisyRepo, 'scripts', 'noisy.js'), "'use strict';\nmodule.exports = 9;\n");
    fs.writeFileSync(path.join(noisyRepo, 'tests', 'noisy.test.js'), [
        "'use strict';",
        "const test = require('node:test');",
        "const assert = require('node:assert/strict');",
        "const v = require('../scripts/noisy');",
        "console.log('CHILD_STDOUT_NOISE_MARKER_999');",
        "test('noisy pass', () => {",
        "    console.log('INSIDE_TEST_NOISE_888');",
        "    assert.equal(v, 9);",
        "});",
        ""
    ].join('\n'));

    const realJsonRun = spawnSync(
        process.execPath,
        [
            '-e',
            'const impact = require(process.argv[1]); process.exitCode = impact.main(["scripts/noisy.js", "--json", "--run-tests"], { root: process.argv[2] });',
            IMPACT_CLI,
            noisyRepo
        ],
        { cwd: ROOT, encoding: 'utf8' }
    );
    assert.strictEqual(realJsonRun.status, 0, realJsonRun.stderr);
    assert.ok(!realJsonRun.stdout.includes('CHILD_STDOUT_NOISE_MARKER_999'), '子单测噪音不得污染 stdout JSON');
    assert.match(realJsonRun.stderr, /CHILD_STDOUT_NOISE_MARKER_999/);
    const parsedRun = JSON.parse(realJsonRun.stdout);
    assert.strictEqual(parsedRun.matched, true);
    assert.strictEqual(parsedRun.testRun.ok, true);
    assert.deepStrictEqual(parsedRun.testRun.jsTests, ['tests/noisy.test.js']);

    // 3) 非法、空白、重复、冲突与非 Git 参数均退出 2
    assert.strictEqual(captureMain(['--help']).code, 0);

    const empty = captureMain([]);
    assert.strictEqual(empty.code, 2);
    assert.match(empty.stderr, /用法:/);

    for (const blankArg of ['', '   ', '\t']) {
        const blank = captureMain([blankArg]);
        assert.strictEqual(blank.code, 2);
        assert.match(blank.stderr, /目标路径不能为空/);
    }

    const unknown = captureMain(['scripts/locks.js', '--unknown-flag']);
    assert.strictEqual(unknown.code, 2);
    assert.match(unknown.stderr, /未知参数: --unknown-flag/);

    const duplicate = captureMain(['--git', '--git']);
    assert.strictEqual(duplicate.code, 2);
    assert.match(duplicate.stderr, /参数不能重复: --git/);

    const conflict = captureMain(['--git', 'scripts/locks.js']);
    assert.strictEqual(conflict.code, 2);
    assert.match(conflict.stderr, /参数冲突/);

    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-non-git-'));
    t.after(() => fs.rmSync(nonGitDir, { recursive: true, force: true }));
    const gitFail = captureMain(['--git'], { root: nonGitDir });
    assert.strictEqual(gitFail.code, 2);
    assert.match(gitFail.stderr, /无法读取 Git 工作区状态/);

    // 4) 沙箱守卫负例
    const sandboxRun = spawnSync(process.execPath, [IMPACT_CLI, 'scripts/locks.js'], {
        cwd: ROOT,
        env: { ...process.env, CODEX_SANDBOX: 'seatbelt' },
        encoding: 'utf8'
    });
    assert.strictEqual(sandboxRun.status, 1);
    assert.match(sandboxRun.stderr, /必须在沙箱外运行/);
});
