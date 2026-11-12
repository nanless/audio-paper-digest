'use strict';

// apps/macos/test.sh 曾出现 `exit 0` 静默提前退出，57 个套件只跑了 27 个，
// 其余 30 个连编译都没有发生，但脚本退出码是 0。这个测试不执行 macOS 客户端
// 测试（那需要 xcrun 与真实窗口），只静态核对运行器不会静默漏跑，并保证
// Tests 目录里新增的 Swift / CJS / Python 测试文件必须接入某个真实入口。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'apps', 'macos');
const TESTS_DIR = path.join(APP, 'Tests');
const SCRIPT_PATH = path.join(APP, 'test.sh');
const script = fs.readFileSync(SCRIPT_PATH, 'utf8');

function testFiles() {
    return fs.readdirSync(TESTS_DIR, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
        .filter(name => name.endsWith('Tests.swift') || /\.test\.(?:cjs|py)$/.test(name))
        .sort();
}

function swiftSuiteNames() {
    return testFiles()
        .filter(name => name.endsWith('Tests.swift'))
        .map(name => name.slice(0, -'Tests.swift'.length));
}

function suiteLoop() {
    const match = /for suite in ([\s\S]*?); do/.exec(script);
    assert.ok(match, 'apps/macos/test.sh 缺少 `for suite in ...; do` 套件循环');
    return match[1].trim().split(/\s+/).filter(Boolean);
}

function referencedTestFileNames() {
    const referenced = new Set();
    // 套件壳可能用 `appendingPathComponent("X.test.cjs")` 或相对路径引用，
    // 因此按文件名本身匹配，不要求 `Tests/` 前缀。
    const patterns = [
        /([A-Za-z0-9_.-]+\.test\.(?:cjs|py))/g,
        /([A-Za-z0-9_-]+Tests\.swift)/g,
    ];
    for (const file of testFiles()) {
        const text = fs.readFileSync(path.join(TESTS_DIR, file), 'utf8');
        for (const pattern of patterns) {
            for (const match of text.matchAll(pattern)) referenced.add(match[1]);
        }
    }
    return referenced;
}

test('test.sh 不会在套件循环前静默成功退出', () => {
    assert.match(script, /^set -euo pipefail$/m,
        'test.sh 必须保留 `set -euo pipefail`，否则单条断言失败会被后续命令掩盖');
    const silentExits = [...script.matchAll(/^\s*exit\s+0\s*$/gm)];
    assert.deepEqual(silentExits.map(match => match[0].trim()), [],
        'test.sh 不得用 `exit 0` 提前结束；确需跳过时必须显式记录跳过并继续其余套件');
    const swallowed = [...script.matchAll(/^(?!\s*#).*\b(?:node|swiftc)\b.*\|\|\s*(?:true|:)\s*$/gm)];
    assert.deepEqual(swallowed.map(match => match[0].trim()), [],
        '测试命令不得用 `|| true` / `|| :` 吞掉失败；跳过必须是显式分支');
});

test('Swift 套件列表与 Tests 目录一一对应，截断会被发现', () => {
    const suites = suiteLoop();
    const swift = swiftSuiteNames();
    assert.ok(suites.length > 0, '套件循环为空');
    assert.equal(new Set(suites).size, suites.length, '套件循环存在重复套件名');

    const known = new Set(swift);
    assert.deepEqual(suites.filter(name => !known.has(name)), [],
        '套件循环登记了不存在的 Swift 测试文件');

    // ModelServiceTests.swift 不直接进 swiftc 循环：它需要真实回环 HTTP，
    // 由 ModelWorker.test.cjs 单独编译并 spawn。其余 Swift 测试必须逐个进循环。
    const shellScripts = [...script.matchAll(/node\s+"?\$app_root\/Tests\/([A-Za-z0-9_.-]+\.cjs)"/g)]
        .map(match => match[1]);
    const shellBodies = new Map(shellScripts.map(name => [
        name,
        fs.existsSync(path.join(TESTS_DIR, name))
            ? fs.readFileSync(path.join(TESTS_DIR, name), 'utf8') : '',
    ]));
    const coveredByShell = name => [...shellBodies.values()]
        .some(body => body.includes(`${name}Tests.swift`));
    const missing = swift.filter(name => !suites.includes(name) && !coveredByShell(name));
    assert.deepEqual(missing, [],
        `以下 Swift 测试既不在 test.sh 的套件循环里，也没有被某个已运行 CJS 壳编译：${missing.join('、')}`);
});

test('每个 CJS / Python 测试文件都有真实入口或被另一个已运行测试引用', () => {
    const executed = new Set();
    for (const match of script.matchAll(/Tests\/([A-Za-z0-9_.-]+\.test\.(?:cjs|py))/g)) {
        executed.add(match[1]);
    }
    const referenced = referencedTestFileNames();
    const unrun = testFiles()
        .filter(name => /\.test\.(?:cjs|py)$/.test(name))
        .filter(name => !executed.has(name) && !referenced.has(name));
    assert.deepEqual(unrun, [],
        `以下测试文件没有任何执行入口：${unrun.join('、')}；`
        + '新增测试必须写进 test.sh，或在已运行套件里显式调用');
    // 反向：test.sh 里点名的测试文件必须真实存在，避免改名后静默漏跑。
    // DocumentTables.test.cjs 属于 apps/android/Tests，是 macOS 壳的跨端入口。
    const existsAnywhere = name => [
        path.join(TESTS_DIR, name),
        path.join(ROOT, 'apps', 'android', 'Tests', name),
    ].some(file => fs.existsSync(file));
    assert.deepEqual([...executed].filter(name => !existsAnywhere(name)), [],
        'test.sh 点名了不存在的测试文件');
});
