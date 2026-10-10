'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const child = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const [code, kind, mode] = process.argv.slice(1);
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'history-read-')));
console.log(JSON.stringify({ directory }));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function prepareDirectRecovery() {
    const api = require(path.join(code, 'scripts/lib/historical-direct-rewrite-runner.js'));
    const item = { paperId: 'arxiv:2609.03622', runId: '77777777-7777-4777-8777-777777777777' };
    const sourceDescriptor = { sourceSnapshotSha256: 'a'.repeat(64) };
    const record = { directPaperId: item.paperId, analysisCheckpoint: '本地恢复检查使用的已保存内容' };
    const written = api.writeAnalysisRecovery({ executionDirectory: directory, item,
        sourceDescriptor, record, updatedAt: '2026-09-07T00:00:00.000Z' });
    return { filename: written.filename, expectedRecordSha256: api.stableHash(record),
        read: () => api.readAnalysisRecovery({ executionDirectory: directory, item, sourceDescriptor }) };
}

function prepareArxivRecovery() {
    const fresh = require(path.join(code, 'scripts/lib/fresh-rewrite-run.js'));
    const api = require(path.join(code, 'scripts/lib/historical-arxiv-analysis.js'));
    const runId = '77777777-7777-4777-8777-777777777777';
    const arxivId = '2609.03622';
    const date = '2026-09-04';
    const runDirectory = path.join(directory, runId);
    fs.mkdirSync(runDirectory);
    const paper = fresh.metadataOnly({ arxivId, title: 'Local source title',
        abstract: 'Only synthetic metadata for file reading', authors: ['Test Author'],
        categories: ['cs.SD'], source: 'arxiv' });
    const artifact = Buffer.from('<feed>local synthetic metadata bytes</feed>');
    const filename = path.join(runDirectory, 'metadata-' + arxivId + '.atom.xml');
    fs.writeFileSync(filename, artifact, { mode: 0o600 });
    const proof = {
        contract: require(path.join(code, 'scripts/lib/arxiv-metadata-source.js')).CONTRACT,
        paperId: 'arxiv:' + arxivId, sourceName: 'local-test.atom.xml',
        fileSha256: sha256(artifact), recordSha256: fresh.stableHash(paper)
    };
    const inputs = { version: 1, contract: fresh.INPUT_CONTRACT, runId, date, papers: [paper] };
    const inputsBytes = Buffer.from(JSON.stringify(inputs));
    fs.writeFileSync(path.join(runDirectory, 'inputs.json'), inputsBytes, { mode: 0o600 });
    const baseline = { version: 1, contract: api.BASELINE_CONTRACT, paperId: 'arxiv:' + arxivId,
        metadata: proof };
    const run = { version: 1, contract: fresh.RUN_CONTRACT, runId, date, paperIds: [arxivId],
        paperSetSha256: fresh.stableHash([arxivId]), inputsSha256: sha256(inputsBytes), baseline,
        sourceExpectations: { [arxivId]: { sourceSha256: 'b'.repeat(64),
            structuredArtifactsSha256: 'c'.repeat(64) } },
        metadataSources: { historicalRawMetadata: proof }, status: 'sources_ready' };
    run.identitySha256 = fresh.stableHash({ version: run.version, contract: run.contract,
        runId, date, paperIds: run.paperIds, paperSetSha256: run.paperSetSha256,
        inputsSha256: run.inputsSha256, baseline, sourceExpectations: run.sourceExpectations,
        metadataSources: run.metadataSources });
    fs.writeFileSync(path.join(runDirectory, 'run.json'), JSON.stringify(run), { mode: 0o600 });
    fs.writeFileSync(path.join(runDirectory, 'analysis.json'), JSON.stringify({ version: 1,
        contract: fresh.ANALYSIS_CONTRACT, runId, batchDate: date, status: 'pending', papers: [paper]
    }), { mode: 0o600 });
    return { filename,
        read: () => api.recoverHistoricalArxivRun({ runId, date, arxivId, rootDir: directory }) };
}

const prepared = kind === 'direct' ? prepareDirectRecovery() : prepareArxivRecovery();
const filename = prepared.filename;
const originalBytes = fs.readFileSync(filename);
const originalOpen = fs.openSync;
const originalRead = fs.readFileSync;
const originalClose = fs.closeSync;
let targetReadActive = false;
let replaced = false;
let openedFile;
let fileReads = 0;
let replacementIdentity;
fs.openSync = function (name, ...args) {
    if (name === filename && mode === 'pipe' && !replaced) {
        replaced = true;
        fs.renameSync(filename, filename + '.saved');
        execFileSync('mkfifo', [filename]);
        fs.chmodSync(filename, 0o600);
        const stat = fs.lstatSync(filename);
        replacementIdentity = { dev: stat.dev, ino: stat.ino };
    }
    const file = originalOpen.call(fs, name, ...args);
    if (name === filename) { openedFile = file; targetReadActive = true; }
    return file;
};
fs.readFileSync = function (file, ...args) {
    if (targetReadActive && file === openedFile) fileReads++;
    return originalRead.call(fs, file, ...args);
};
fs.closeSync = function (file) {
    if (targetReadActive && file === openedFile) targetReadActive = false;
    return originalClose.call(fs, file);
};
let value;
let failure;
try { value = prepared.read(); }
catch (error) { failure = { message: error.message, code: error.code || null, retryable: error.retryable }; }
finally { fs.openSync = originalOpen; fs.readFileSync = originalRead; fs.closeSync = originalClose; }
let fileClosed = false;
try { fs.fstatSync(openedFile); } catch (error) { fileClosed = error.code === 'EBADF'; }
const current = fs.lstatSync(filename);
console.log(JSON.stringify({ failure, fileReads, fileClosed, replaced,
    status: value?.status, recovered: value?.recovered,
    recordSha256: value?.recordSha256, expectedRecordSha256: prepared.expectedRecordSha256,
    originalBytesUnchanged: originalRead(filename + (replaced ? '.saved' : '')).equals(originalBytes),
    pipeRemains: current.isFIFO(), replacementUnchanged: !replacementIdentity
        || (current.dev === replacementIdentity.dev && current.ino === replacementIdentity.ino) }));
`;

for (const kind of ['direct', 'arxiv']) {
    for (const mode of ['normal', 'pipe']) {
        const description = kind === 'direct' ? '历史重写的已保存分析' : '历史 arXiv 的已保存元数据';
        test(description + (mode === 'normal' ? '按原内容正常恢复' : '被换成管道后及时拒绝，保留原文件'), t => {
            if (mode === 'pipe' && process.platform === 'win32') return t.skip('本用例需要系统支持命名管道');
            const result = spawnSync(process.execPath, ['-e', child, path.resolve(__dirname, '..'), kind, mode], {
                encoding: 'utf8', timeout: 5000
            });
            const firstLine = result.stdout.split('\n')[0];
            if (firstLine) {
                const { directory } = JSON.parse(firstLine);
                t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
            }
            assert.equal(result.error, undefined, '历史恢复应及时返回，不能等待管道写入');
            assert.equal(result.status, 0, result.stderr);
            const observation = JSON.parse(result.stdout.trim().split('\n').at(-1));
            assert.equal(observation.originalBytesUnchanged, true);
            assert.equal(observation.fileClosed, true);
            if (mode === 'normal') {
                assert.equal(observation.failure, undefined);
                assert.equal(observation.fileReads, 1);
                if (kind === 'direct') assert.equal(observation.recordSha256, observation.expectedRecordSha256);
                else {
                    assert.equal(observation.status, 'sources_ready');
                    assert.equal(observation.recovered, true);
                }
            } else {
                assert.equal(observation.replaced, true);
                assert.equal(observation.fileReads, 0);
                assert.equal(observation.pipeRemains, true);
                assert.equal(observation.replacementUnchanged, true);
                if (kind === 'direct') {
                    assert.equal(observation.failure.code, 'HISTORICAL_DIRECT_REWRITE_EXECUTION_INTEGRITY');
                    assert.match(observation.failure.message, /unsafe file:/);
                } else {
                    assert.equal(observation.failure.code, 'HISTORICAL_ARXIV_ANALYSIS_INTEGRITY');
                    assert.equal(observation.failure.retryable, false);
                    assert.match(observation.failure.message, /官方元数据文件必须是普通文件/);
                }
            }
        });
    }
}
