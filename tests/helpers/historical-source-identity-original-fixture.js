'use strict';
// 原实现来自 e8b916eb281ac718ee98599155ab6b04304d60b2，先核完整源码字节再隔离装载。
// 仅计划读取、来源就绪和封存资格使用离线夹具；实际来源记录、页面读取和摘要算法不替换。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Module = require('node:module');
const io = require('../../scripts/lib/historical-conference-page-projections.js');
const { pageBody } = require('../../scripts/lib/historical-direct-tag-supplement.js');
const ORIGINAL_SHA = '71810112b2880dc19d05d96a7838cd08ccd61af69993e1d3a6424dad0e56166f';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const filename = path.resolve(__dirname, '../../scripts/lib/historical-source-identity-supplement.js');
const originalFile = path.resolve(__dirname, '../fixtures/historical-source-identity-v1-source.txt');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'identity-original-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const blogRoot = path.join(root, 'blog');
    const outputRoot = path.join(root, 'outputs');
    fs.mkdirSync(blogRoot, { mode: 0o700 });
    const pageBytes = Buffer.from('---\ntitle: Example\n---\nOriginal body\n');
    const pageFile = path.join(blogRoot, 'example.md');
    fs.writeFileSync(pageFile, pageBytes, { mode: 0o600 });
    const metadataFile = path.join(root, 'metadata.json');
    const metadataBytes = Buffer.from(JSON.stringify({ results: [{ title: 'Bound official title' }] }) + '\n');
    fs.writeFileSync(metadataFile, metadataBytes, { mode: 0o600 });
    const paperId = 'conference:icassp:2026:icassp-arnumber:11460320';
    const source = { sourceSet: 'offline-test', provenance: 'offline-test',
        metadata: { absolutePath: metadataFile, sha256: digest(metadataBytes), recordIndex: 0,
            metadataIdentityBindingSha256: 'a'.repeat(64) },
        pdf: { sha256: 'b'.repeat(64), bytes: 32, pdfIdentityBindingSha256: 'c'.repeat(64), acquisition: {} },
        sourceBindingSha256: 'd'.repeat(64) };
    const page = { pagePath: 'example.md', pageContentSha256: digest(pageBytes), pageKey: 'page:' + digest(pageBytes) };
    const item = { paperId, route: { kind: 'conference-local-pdf', writerInputs: [source] }, pages: [page] };
    const plan = { planSha256: 'e'.repeat(64), queue: [item] };
    const registry = { entries: [{ paperId, status: 'pending' }] };
    const options = { runId: 'original-identity-fixture', blogRoot };
    const directory = path.join(outputRoot, options.runId);
    const config = { FILES: { freshArxivFetchedSourcesDir: path.join(root, 'unused-source-root'),
        historicalSourceIdentitySupplementDir: outputRoot } };

    function load(original = false) {
        const raw = fs.readFileSync(original ? originalFile : filename);
        if (original && digest(raw) !== ORIGINAL_SHA) throw new Error('原来源身份模块的归档字节不一致。');
        const instance = new Module(filename, module);
        instance.filename = filename;
        instance.paths = Module._nodeModulePaths(path.dirname(filename));
        const normalRequire = instance.require.bind(instance);
        instance.require = request => {
            if (request === './historical-direct-rewrite-plan.js') return { ...normalRequire(request), verifyConferenceWriterInputs: () => ({ sources: 1 }) };
            if (request === './historical-direct-rewrite-runner.js') return {
                stableHash: io.stableHash, sourcePrerequisiteSnapshot: () => ({ status: 'ready' }) };
            if (request === './historical-direct-tag-supplement.js') return {
                pageBody, readPlanRegistry: () => ({ plan, registry, planFileSha256: 'f'.repeat(64) }) };
            if (request === './fresh-arxiv-rewrite-source.js' || request === './historical-icml-alternate-pdf-source.js') return {};
            if (request === '../config.js') return config;
            return normalRequire(request);
        };
        instance._compile(raw.toString('utf8'), filename);
        return instance.exports;
    }
    const write = (name, value) => {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    };
    async function produce(original = false, complete = true) {
        const result = await load(original).buildIdentitySupplement({ ...options,
            onProgress: (_, checkpoint) => write('checkpoint-000001.json', checkpoint) });
        if (result.report.failures.length || result.report.pageCount !== 1) throw new Error(JSON.stringify(result.report));
        if (complete) { write('identity-history.json', result.supplement); write('report.json', result.report); }
        return result;
    }
    function savedBytes() {
        return Object.fromEntries(fs.readdirSync(directory).sort().map(name => [name, fs.readFileSync(path.join(directory, name))]));
    }
    function changeRecord(result, change, { resealSource = false, resealProof = true } = {}) {
        const record = result.supplement.records[page.pagePath];
        change(record);
        if (resealSource) record.sourceProofSha256 = io.stableHash(record.source);
        if (resealProof) {
            const { proofSha256, ...body } = record;
            record.proofSha256 = io.stableHash(body);
        }
        result.report.supplementSha256 = io.stableHash(result.supplement);
        write('identity-history.json', result.supplement);
        write('report.json', result.report);
        fs.rmSync(path.join(directory, 'checkpoint-000001.json'));
    }
    return { root, directory, plan, options, page, pageFile, pageBytes, metadataFile,
        load, write, produce, savedBytes, changeRecord, digest, originalFile, ORIGINAL_SHA };
}

module.exports = { fixture, ORIGINAL_SHA };
