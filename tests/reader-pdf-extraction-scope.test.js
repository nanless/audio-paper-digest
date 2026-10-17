'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), child = require('node:child_process');
const api = require('../scripts/lib/reader-pdf-extraction-scope');
const program = path.resolve('scripts/reader_sealed_pdf_quote_evidence.py');
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-extraction-scope-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dependency = path.join(dir, 'dependency.py'); fs.writeFileSync(dependency, 'original');
    const root = path.resolve('.'), venv = path.join(dir, '.venv');
    for (const [file, text] of Object.entries({ 'bin/python': 'isolated interpreter',
        'pyvenv.cfg': 'version = 3.11\ninclude-system-site-packages = false\n',
        'lib/python3.11/site-packages/fitz/__init__.py': 'from pymupdf import *',
        'lib/python3.11/site-packages/pymupdf/__init__.py': 'isolated pymupdf',
        'lib/python3.11/site-packages/pymupdf-1.0.dist-info/METADATA': 'Version: 1.0' })) {
        const target = path.join(venv, file); fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text, { mode: file === 'bin/python' ? 0o700 : 0o600 });
    }
    fs.writeFileSync(path.join(dir, '.env'), '', { mode: 0o600 });
    const roleFile = path.join(dir, '.paper-digest-workspace-role.json');
    fs.writeFileSync(roleFile, JSON.stringify({ contract: 'paper-digest-workspace-role-v1', version: 1,
        role: 'daily', workspaceRealpath: root }), { mode: 0o600 });
    const map = file => {
        if (typeof file !== 'string') return file;
        const resolved = path.resolve(file);
        if (resolved === path.join(root, '.venv') || resolved.startsWith(path.join(root, '.venv') + path.sep))
            return path.join(venv, path.relative(path.join(root, '.venv'), resolved));
        return ['.env', '.paper-digest-workspace-role.json'].some(n => resolved === path.join(root, n))
            ? path.join(dir, path.basename(resolved)) : file;
    };
    for (const key of ['accessSync', 'readFileSync', 'readdirSync', 'lstatSync', 'realpathSync', 'openSync']) {
        const original = fs[key]; t.mock.method(fs, key, (file, ...args) => original.call(fs, map(file), ...args));
    }
    const run = (input, deps = [dependency], mode = 0o600) => {
        const file = path.join(dir, 'input.json'); fs.writeFileSync(file, JSON.stringify(input), { mode }); fs.chmodSync(file, mode);
        const fd = fs.openSync(file, 'r');
        try { return api.runPdfExtractor(program, fd, deps); } finally { fs.closeSync(fd); }
    };
    return { run, dependency, roleFile, dir, venv };
}
test('未知Python布局只按正常提取执行，作用域不伪造缓存能力', t => {
    const { run } = fixture(t); let calls = 0;
    const access = fs.accessSync;
    t.mock.method(fs, 'accessSync', (file, mode) => {
        if (String(file).endsWith('/.venv/bin/python')) throw new Error('unknown runtime');
        return access(file, mode);
    });
    t.mock.method(child, 'execFileSync', () => { calls++; return Buffer.from('{"ok":true}'); });
    api.withPdfExtractionScope(() => { run({ literal: true }); run({ literal: true }); });
    assert.equal(calls, 2);
});
test('认证PDF使用同一纯executor并保留继承环境，未知导入或启动覆盖不复用', t => {
    const { dir } = fixture(t), saved = new Map();
    const unsafe = key => /^(?:PYTHON|PYMUPDF|FITZ|LD_|DYLD_|BASH_FUNC_)/i.test(key) || ['BASH_ENV', 'ENV'].includes(key);
    for (const key of Object.keys(process.env)) if (unsafe(key)) { saved.set(key, process.env[key]); delete process.env[key]; }
    const marker = process.env.PD_PDF_SHARED_TEST, disableVenv = process.env.PD_PYTHON_RUNTIME_DISABLE_VENV;
    delete process.env.PD_PYTHON_RUNTIME_DISABLE_VENV;
    t.after(() => {
        for (const key of Object.keys(process.env)) if (unsafe(key)) delete process.env[key];
        for (const [key, value] of saved) process.env[key] = value;
        if (marker === undefined) delete process.env.PD_PDF_SHARED_TEST; else process.env.PD_PDF_SHARED_TEST = marker;
        if (disableVenv === undefined) delete process.env.PD_PYTHON_RUNTIME_DISABLE_VENV;
        else process.env.PD_PYTHON_RUNTIME_DISABLE_VENV = disableVenv;
    });
    process.env.PD_PDF_SHARED_TEST = 'inherited-original';
    let calls = 0;
    t.mock.method(child, 'execFileSync', (_file, args, options) => {
        calls++; assert.equal(args[1], program); assert.equal(args[2], '3');
        assert.equal(options.env.PD_PDF_SHARED_TEST, process.env.PD_PDF_SHARED_TEST);
        assert.equal(options.env.PD_PYTHON_RUNTIME_DISABLE_VENV, process.env.PD_PYTHON_RUNTIME_DISABLE_VENV);
        return Buffer.from('{"document":{"exact":"source"}}');
    });
    const run = () => {
        const file = path.join(dir, 'authenticated.json'); fs.writeFileSync(file, '{"pdf":"same"}', { mode: 0o600 });
        const fd = fs.openSync(file, 'r');
        try { return api.runAuthenticatedPdfQuoteExtractor(fd); } finally { fs.closeSync(fd); }
    };
    api.withPdfExtractionScope(() => {
        run(); run(); assert.equal(calls, 1);
        process.env.PD_PDF_SHARED_TEST = 'changed-original'; run(); assert.equal(calls, 2, 'inherited environment enters exact key');
        for (const key of ['PYTHONPATH', 'PYTHONHOME', 'PYMUPDF_MESSAGE', 'LD_PRELOAD', 'DYLD_LIBRARY_PATH', 'BASH_ENV', 'ENV', 'BASH_FUNC_untracked%%']) {
            process.env[key] = '/unknown/mutable/startup';
            try { run(); run(); assert.equal(calls % 2, 0, key + ' stays uncached'); }
            finally { delete process.env[key]; }
        }
        const beforeExternal = calls;
        process.env.PD_PYTHON_RUNTIME_DISABLE_VENV = '1';
        run(); run();
        assert.equal(calls, beforeExternal + 2, 'same inherited external-runtime selection cannot use project-venv cache');
        delete process.env.PD_PYTHON_RUNTIME_DISABLE_VENV;
    });
    run(); assert.equal(calls, 21, 'scope end cannot carry extraction into next qualification');
});
test('纯提取仅作用域内复用，完整输入/程序/环境/运行时变更miss且返回隔离', async t => {
    const { run, dependency } = fixture(t); let calls = 0;
    t.mock.method(child, 'execFileSync', () => { calls++; return Buffer.from('{"document":{"exact":"value"}}'); });
    const input = { pdfBase64: 'exact-pdf', pdfSha256: 'sha', quotes: ['literal quote'], view: [['header']] };
    run(input); run(input); assert.equal(calls, 2, 'ordinary calls have no process-global cache');
    api.withPdfExtractionScope(() => {
        const first = run(input); first.fill(0);
        assert.deepEqual(JSON.parse(run(input)), { document: { exact: 'value' } }); assert.equal(calls, 3);
        for (const patch of [{ pdfBase64: 'changed-pdf' }, { pdfSha256: 'different' }, { quotes: ['other'] }, { view: [['other']] }]) run({ ...input, ...patch });
        assert.equal(calls, 7);
        fs.writeFileSync(dependency, 'changed'); run(input); assert.equal(calls, 8);
        const home = process.env.HOME; process.env.HOME = home + '/different';
        try { run(input); assert.equal(calls, 9); } finally { process.env.HOME = home; }
        const lstat = fs.lstatSync, python = fs.realpathSync('.venv/bin/python');
        t.mock.method(fs, 'lstatSync', (file, options) => {
            const stat = lstat(file, options);
            return String(file) === python && options?.bigint ? { ...stat, ctimeNs: stat.ctimeNs + 1n } : stat;
        });
        run(input); assert.equal(calls, 10, 'interpreter metadata change cannot reuse old extraction');
    });
    await api.withPdfExtractionScope(async () => { run(input); await Promise.resolve(); run(input); });
    assert.equal(calls, 11); run(input); assert.equal(calls, 12, 'completed scope drops all responses');
});
test('子进程异常和非JSON响应不缓存；容量上限不驱动新许可', t => {
    const { run } = fixture(t); let calls = 0, mode = 'throw';
    t.mock.method(child, 'execFileSync', () => {
        calls++; if (mode === 'throw') throw new Error('extractor failure');
        return Buffer.from(mode === 'invalid' ? 'not JSON' : JSON.stringify({ text: 'x'.repeat(17 * 1024 * 1024) }));
    });
    api.withPdfExtractionScope(() => {
        assert.throws(() => run({ a: 1 }), /extractor failure/); assert.throws(() => run({ a: 1 }), /extractor failure/);
        mode = 'invalid'; assert.throws(() => run({ a: 1 }), SyntaxError); assert.throws(() => run({ a: 1 }), SyntaxError);
        assert.equal(calls, 4); mode = 'large';
        run({ a: 1 }); run({ a: 2 }); run({ a: 2 }); run({ a: 1 });
        assert.equal(calls, 7, 'second 17MiB result exceeds scope cap and must not be retained');
    });
});
test('即使输入字节相同，非私有FD及非纯提取程序仍须走原执行检查', t => {
    const { run } = fixture(t); let calls = 0;
    t.mock.method(child, 'execFileSync', (_file, _args, options) => {
        calls++; if (fs.fstatSync(options.stdio[3]).mode & 0o077) throw new Error('private descriptor required');
        return Buffer.from('{"ok":true}');
    });
    api.withPdfExtractionScope(() => {
        run({ same: true }); assert.throws(() => run({ same: true }, [], 0o644), /private descriptor/);
        assert.equal(calls, 2);
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-non-extractor-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const input = path.join(dir, 'input.json'); fs.writeFileSync(input, '{}', { mode: 0o600 });
    const fd = fs.openSync(input, 'r');
    try { api.withPdfExtractionScope(() => {
        api.runPdfExtractor('/different-program.py', fd); api.runPdfExtractor('/different-program.py', fd);
    }); } finally { fs.closeSync(fd); }
    assert.equal(calls, 4, 'the generic helper cannot memoize arbitrary programs');
});
test('缓存命中之前仍实时检查sandbox及角色文件权限、硬链接和角色身份', t => {
    const { run, roleFile, dir } = fixture(t); let calls = 0;
    t.mock.method(child, 'execFileSync', () => { calls++; return Buffer.from('{"ok":true}'); });
    api.withPdfExtractionScope(() => {
        run({ same: true }); run({ same: true }); assert.equal(calls, 1);
        const sandbox = process.env.CODEX_SANDBOX; process.env.CODEX_SANDBOX = 'seatbelt';
        try { assert.throws(() => run({ same: true }), /必须在沙箱外运行/); }
        finally { if (sandbox === undefined) delete process.env.CODEX_SANDBOX; else process.env.CODEX_SANDBOX = sandbox; }
        fs.chmodSync(roleFile, 0o644); assert.throws(() => run({ same: true }), /0600/); fs.chmodSync(roleFile, 0o600);
        const original = fs.readFileSync(roleFile); fs.writeFileSync(roleFile, JSON.stringify({ ...JSON.parse(original), role: 'history' }));
        assert.throws(() => run({ same: true }), /工作区|daily/); fs.writeFileSync(roleFile, original);
        const link = path.join(dir, 'role-link'); fs.linkSync(roleFile, link);
        assert.throws(() => run({ same: true }), /硬链接/); fs.unlinkSync(link);
        run({ same: true }); assert.equal(calls, 1, 'all guard failures occurred before any subprocess');
    });
});
test('未知startup hook或非隔离venv不缓存；唯一标准distutils及其真实模块变化入key', t => {
    const { run, venv } = fixture(t); let calls = 0;
    t.mock.method(child, 'execFileSync', () => { calls++; return Buffer.from('{"ok":true}'); });
    const packages = path.join(venv, 'lib/python3.11/site-packages'), cfg = path.join(venv, 'pyvenv.cfg');
    const originalCfg = fs.readFileSync(cfg), same = { same: true };
    api.withPdfExtractionScope(() => {
        run(same); run(same); assert.equal(calls, 1);
        for (const name of ['evil.pth', 'sitecustomize.py', 'usercustomize.py']) {
            const file = path.join(packages, name); fs.writeFileSync(file, 'import outside_graph');
            run(same); run(same); assert.equal(calls % 2, 1);
            fs.unlinkSync(file);
        }
        assert.equal(calls, 7);
        for (const contents of ['version = 3.11\n', 'include-system-site-packages = true\n',
            'include-system-site-packages = false\ninclude-system-site-packages = true\n']) {
            fs.writeFileSync(cfg, contents); run(same); run(same);
        }
        assert.equal(calls, 13); fs.writeFileSync(cfg, originalCfg);
        const pth = path.join(packages, 'distutils-precedence.pth');
        fs.writeFileSync(pth, 'import evil_same_filename\n'); run(same); run(same); assert.equal(calls, 15);
        fs.writeFileSync(pth, "import os; var = 'SETUPTOOLS_USE_DISTUTILS'; enabled = os.environ.get(var, 'local') == 'local'; enabled and __import__('_distutils_hack').add_shim(); \n");
        const hack = path.join(packages, '_distutils_hack'); fs.mkdirSync(hack);
        const moduleFile = path.join(hack, '__init__.py'); fs.writeFileSync(moduleFile, 'original shim');
        run(same); run(same); assert.equal(calls, 16);
        fs.writeFileSync(moduleFile, 'changed shim'); run(same); assert.equal(calls, 17);
    });
});
test('真实package或模块目录symlink是未知runtime，改target文件也必须正常重提取', t => {
    const { run, dir, venv } = fixture(t);
    const packages = path.join(venv, 'lib/python3.11/site-packages');
    let calls = 0, targetFile;
    t.mock.method(child, 'execFileSync', () => {
        calls++;
        return Buffer.from(JSON.stringify({ text: fs.readFileSync(targetFile, 'utf8') }));
    });
    const same = { literal: 'same input' };
    function checkChangedTarget() {
        const before = calls;
        fs.writeFileSync(targetFile, 'original');
        const first = JSON.parse(run(same));
        fs.writeFileSync(targetFile, 'modified');
        const second = JSON.parse(run(same));
        assert.equal(calls, before + 2, 'unknown linked module layout must never hit a cached result');
        assert.equal(first.text, 'original');
        assert.equal(second.text, 'modified');
    }
    // Top-level package link: old identity recorded only the link inode.
    const module = path.join(packages, 'pymupdf'), saved = module + '-original';
    fs.renameSync(module, saved);
    const external = path.join(dir, 'external-package'); fs.mkdirSync(external);
    targetFile = path.join(external, '__init__.py');
    fs.symlinkSync(external, module, 'dir');
    try { api.withPdfExtractionScope(checkChangedTarget); }
    finally { fs.unlinkSync(module); fs.renameSync(saved, module); }
    // Internal directory link: changing an existing target child does not
    // change the target directory's inode/mtime, so directory metadata is insufficient.
    const nested = path.join(dir, 'external-nested'); fs.mkdirSync(nested);
    targetFile = path.join(nested, 'runtime.py');
    const link = path.join(module, 'linked'); fs.symlinkSync(nested, link, 'dir');
    try { api.withPdfExtractionScope(checkChangedTarget); }
    finally { fs.unlinkSync(link); }
    // A linked layout root is likewise outside the known isolated runtime.
    const realPackages = packages + '-real'; fs.renameSync(packages, realPackages);
    fs.symlinkSync(realPackages, packages, 'dir');
    targetFile = path.join(realPackages, 'pymupdf/__init__.py');
    try { api.withPdfExtractionScope(() => {
        const before = calls; run(same); run(same);
        assert.equal(calls, before + 2, 'linked site-packages root is uncached');
    }); } finally { fs.unlinkSync(packages); fs.renameSync(realPackages, packages); }
});
test('解释器自身已追真实目标的symlink保持合法，模块文件symlink仍不缓存', t => {
    const { run, dir, venv } = fixture(t); let calls = 0;
    const python = path.join(venv, 'bin/python'), realPython = python + '-real';
    fs.renameSync(python, realPython); fs.symlinkSync(realPython, python);
    t.mock.method(child, 'execFileSync', () => { calls++; return Buffer.from('{"exact":true}'); });
    api.withPdfExtractionScope(() => { run({ same: true }); run({ same: true }); });
    assert.equal(calls, 1, 'the explicitly fingerprinted interpreter target is supported');
    const module = path.join(venv, 'lib/python3.11/site-packages/fitz/__init__.py');
    const target = path.join(dir, 'external-module.py'); fs.writeFileSync(target, 'original');
    fs.unlinkSync(module); fs.symlinkSync(target, module);
    api.withPdfExtractionScope(() => {
        run({ same: true }); fs.writeFileSync(target, 'modified'); run({ same: true });
    });
    assert.equal(calls, 3, 'arbitrary module file links are unknown and always re-executed');
});
