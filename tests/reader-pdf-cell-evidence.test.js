'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const child = require('node:child_process');
const { withArtifacts, withSavedPaper, displayCell } = require('../scripts/lib/reader-pdf-cell-evidence');

test('普通原DOM表不启动PDF提取，逐字保留数字', () => {
    const old = child.execFileSync;
    child.execFileSync = () => { throw new Error('不应启动Python'); };
    try {
        const table = { ordinal: 1, matrix: [['Metric'], ['82.582.5']], cells: [] };
        const artifacts = { tables: [table] };
        withArtifacts(artifacts, '2610.12345', () => assert.equal(displayCell(table, 1, 0), '82.582.5'));
        withSavedPaper({ apiReaderPlan: { tableBindings: [] } }, () => assert.ok(true));
    } finally { child.execFileSync = old; }
});

test('伪造PDF证明缺少真实封存来源必须拒绝', () => {
    assert.throws(() => withSavedPaper({ apiReaderPlan: { tableBindings: [{ pdfCellConfirmation: {} }] } }, () => {}), /payload/);
});

test('进程缓存每次核对真实来源与后端字节，变化后不能使用旧证明', () => {
    const os = require('node:os');
    const crypto = require('node:crypto');
    const Config = require('../scripts/config');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reader-pdf-proof-test-')));
    const oldRoot = Config.FILES.dailyFreshSourceRunsDir;
    const oldSpawn = child.execFileSync;
    const sha = value => crypto.createHash('sha256').update(value).digest('hex');
    const runId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const directory = path.join(root, runId, 'sources/2610.12345/generation-000001');
    fs.mkdirSync(directory, { recursive: true });
    const files = { 'source.txt': 'original', 'source.pdf': '%PDF-test', 'source-runtime.json': '{}' };
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), content);
    const manifest = { text: { responseSha256: sha(files['source.txt']) }, pdf: { responseSha256: sha(files['source.pdf']) },
        runtimeMetadata: { responseSha256: sha(files['source-runtime.json']) } };
    fs.writeFileSync(path.join(directory, 'source-manifest.json'), JSON.stringify(manifest));
    const backendDirectory = path.join(root, 'backend-directory');
    fs.mkdirSync(backendDirectory);
    const backend = path.join(backendDirectory, 'backend-test-file');
    fs.writeFileSync(backend, 'original-backend');
    const table = { ordinal: 1, matrix: [['Dataset SNR Setting', 'Test set', 'Metric'], ['A', 'Noisy', '1.21.2']],
        cells: [{ text: '1.21.2' }] };
    const artifacts = { tables: [table] };
    const provenance = { contract: 'fresh-source-analysis-v1', runId, sourceGeneration: 1,
        sourceManifestSha256: sha(JSON.stringify(manifest)) };
    let calls = 0;
    Config.FILES.dailyFreshSourceRunsDir = root;
    child.execFileSync = () => {
        calls += 1;
        if (calls > 1) throw new Error('后端变化须重放，不能继续旧缓存');
        return JSON.stringify({ proofs: [{ contract: 'sealed-pdf-cell-confirmation-v1', sourceTableOrdinal: 1,
            ruleSha256: sha(fs.readFileSync(path.join(__dirname, '../scripts/reader_pdf_cell_evidence.py'))),
            backendImplementationSha256: require('../scripts/lib/reader-repair').hashDraft([{ name: 'backend-test-file', sha256: sha('original-backend') }]) }],
        backendFiles: [{ path: backend, sha256: sha('original-backend') }], backendDirectories: [backendDirectory] });
    };
    try {
        withArtifacts(artifacts, '2610.12345', () => {}, provenance);
        withArtifacts(artifacts, '2610.12345', () => {}, provenance);
        assert.equal(calls, 1);
        fs.writeFileSync(path.join(directory, 'source.txt'), 'changed');
        assert.throws(() => withArtifacts(artifacts, '2610.12345', () => {}, provenance), /SHA变化/);
        assert.equal(calls, 1);
        fs.writeFileSync(path.join(directory, 'source.txt'), 'original');
        fs.writeFileSync(backend, 'changed-backend');
        assert.throws(() => withArtifacts(artifacts, '2610.12345', () => {}, provenance), /须重放/);
        assert.equal(calls, 2);
        fs.writeFileSync(backend, 'original-backend');
        fs.writeFileSync(path.join(backendDirectory, 'new.py'), 'new backend');
        assert.throws(() => withArtifacts(artifacts, '2610.12345', () => {}, provenance), /须重放/);
        assert.equal(calls, 3);
    } finally {
        Config.FILES.dailyFreshSourceRunsDir = oldRoot;
        child.execFileSync = oldSpawn;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('运行时启动脚本、PATH及虚拟环境选择变化必须重新提取', () => {
    const os = require('node:os');
    const crypto = require('node:crypto');
    const sha = value => crypto.createHash('sha256').update(value).digest('hex');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reader-pdf-runtime-test-')));
    const scripts = path.join(root, 'scripts');
    const library = path.join(scripts, 'lib');
    fs.mkdirSync(library, { recursive: true });
    for (const name of ['reader_pdf_cell_evidence.py', 'conference_extractor.py', 'python-runtime.sh']) {
        fs.copyFileSync(path.join(__dirname, '../scripts', name), path.join(scripts, name));
    }
    fs.copyFileSync(path.join(__dirname, '../scripts/lib/reader-pdf-cell-evidence.js'), path.join(library, 'reader-pdf-cell-evidence.js'));
    fs.writeFileSync(path.join(library, 'reader-repair.js'), "exports.hashDraft = value => require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');");
    const runId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const sourceRoot = path.join(root, 'sources');
    fs.writeFileSync(path.join(scripts, 'config.js'), `module.exports = { FILES: { dailyFreshSourceRunsDir: ${JSON.stringify(sourceRoot)} } };`);
    const directory = path.join(sourceRoot, runId, 'sources/2610.12345/generation-000001');
    fs.mkdirSync(directory, { recursive: true });
    const files = { 'source.txt': 'original', 'source.pdf': '%PDF-test', 'source-runtime.json': '{}' };
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), content);
    const manifest = { text: { responseSha256: sha(files['source.txt']) }, pdf: { responseSha256: sha(files['source.pdf']) }, runtimeMetadata: { responseSha256: sha(files['source-runtime.json']) } };
    fs.writeFileSync(path.join(directory, 'source-manifest.json'), JSON.stringify(manifest));
    const backendDirectory = path.join(root, 'backend');
    fs.mkdirSync(backendDirectory);
    const backend = path.join(backendDirectory, 'file');
    fs.writeFileSync(backend, 'backend');
    const local = require(path.join(library, 'reader-pdf-cell-evidence.js'));
    const artifacts = { tables: [{ ordinal: 1, matrix: [['Dataset SNR Setting', 'Test set', 'Metric']], cells: [{ text: '1.21.2' }] }] };
    const provenance = { contract: 'fresh-source-analysis-v1', runId, sourceGeneration: 1, sourceManifestSha256: sha(JSON.stringify(manifest)) };
    const oldSpawn = child.execFileSync;
    const oldPath = process.env.PATH;
    let calls = 0;
    child.execFileSync = () => {
        calls += 1;
        if (calls > 1) throw new Error('运行时变化必须真实重放');
        return JSON.stringify({ proofs: [{ contract: 'sealed-pdf-cell-confirmation-v1', sourceTableOrdinal: 1,
            ruleSha256: sha(fs.readFileSync(path.join(scripts, 'reader_pdf_cell_evidence.py'))),
            backendImplementationSha256: sha(JSON.stringify([{ name: 'file', sha256: sha('backend') }])) }],
        backendFiles: [{ path: backend, sha256: sha('backend') }], backendDirectories: [backendDirectory] });
    };
    try {
        local.withArtifacts(artifacts, '2610.12345', () => {}, provenance);
        local.withArtifacts(artifacts, '2610.12345', () => {}, provenance);
        assert.equal(calls, 1);
        const launcher = path.join(scripts, 'python-runtime.sh');
        const originalLauncher = fs.readFileSync(launcher);
        fs.writeFileSync(launcher, '#!/bin/sh\nexit 99\n');
        assert.throws(() => local.withArtifacts(artifacts, '2610.12345', () => {}, provenance), /必须真实重放/);
        fs.writeFileSync(launcher, originalLauncher);
        process.env.PATH = `${oldPath}${path.delimiter}${root}`;
        assert.throws(() => local.withArtifacts(artifacts, '2610.12345', () => {}, provenance), /必须真实重放/);
        process.env.PATH = oldPath;
        const venv = path.join(root, '.venv');
        fs.mkdirSync(venv);
        fs.writeFileSync(path.join(venv, 'pyvenv.cfg'), 'include-system-site-packages = true\n');
        assert.throws(() => local.withArtifacts(artifacts, '2610.12345', () => {}, provenance), /必须真实重放/);
        assert.equal(calls, 4);
    } finally {
        process.env.PATH = oldPath;
        child.execFileSync = oldSpawn;
        fs.rmSync(root, { recursive: true, force: true });
    }
});


test('普通表仅有cells时还原原单元格字节，不依赖PDF或matrix', () => {
    const table = { ordinal: 1, cells: [
        { row: 0, column: 0, rowspan: 1, colspan: 1, text: 'Model' },
        { row: 0, column: 1, rowspan: 1, colspan: 1, text: '0–12 kHz' },
        { row: 1, column: 0, rowspan: 1, colspan: 1, text: 'Ours' },
        { row: 1, column: 1, rowspan: 1, colspan: 1, text: '1.24' }
    ] };
    assert.equal(displayCell(table, 0, 0), 'Model');
    assert.equal(displayCell(table, 0, 1), '0–12 kHz');
    assert.equal(displayCell(table, 1, 0), 'Ours');
    assert.equal(displayCell(table, 1, 1), '1.24');
    const withMatrix = { ...table, matrix: [['different', 'matrix'], ['not', 'cell']] };
    assert.equal(displayCell(withMatrix, 1, 1), '1.24');
});
