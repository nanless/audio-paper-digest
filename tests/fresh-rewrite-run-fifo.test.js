"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function exercise(rootDir, filename) {
    const fs = require('node:fs');
    const path = require('node:path');
    const assert = require('node:assert/strict');
    const { spawnSync } = require('node:child_process');
    const api = require('./scripts/lib/fresh-rewrite-run.js');
    const runId = '11111111-2222-4333-8444-555555555555';
    const id = '2609.12345';
    const runDir = path.join(rootDir, runId);
    fs.mkdirSync(runDir, { mode: 0o700 });
    const paper = {
        arxivId: id, paper_id: id,
        title: 'Original paper', abstract: 'Original evidence'
    };
    const inputs = {
        contract: api.INPUT_CONTRACT, runId, date: '2026-09-04', papers: [paper]
    };
    const inputsSha256 = api.writeImmutableJson(path.join(runDir, 'inputs.json'), inputs);
    api.writeImmutableJson(path.join(runDir, 'analysis.json'), {
        contract: api.ANALYSIS_CONTRACT, runId, batchDate: inputs.date,
        status: 'pending', papers: [paper]
    });
    const identity = {
        version: 1, contract: api.RUN_CONTRACT, runId, date: inputs.date,
        paperIds: [id], paperSetSha256: api.stableHash([id]), inputsSha256, baseline: {},
        sourceExpectations: {
            [id]: { sourceSha256: 'a'.repeat(64), structuredArtifactsSha256: 'b'.repeat(64) }
        },
        metadataSources: {}
    };
    api.writeImmutableJson(path.join(runDir, 'run.json'), {
        ...identity, status: 'prepared', identitySha256: api.stableHash(identity)
    });
    const dependencies = { rootDir, readFreshSource: () => null };
    const original = api.rewriteStatus({ runId }, dependencies);
    assert.equal(original.status, 'prepared');
    assert.deepEqual(original.sourceMissingIds, [id]);
    assert.equal(original.analysisComplete, 0);
    const target = path.join(runDir, filename);
    const saved = fs.readdirSync(runDir).filter(name => name !== filename)
        .map(name => [name, fs.readFileSync(path.join(runDir, name))]);
    fs.unlinkSync(target);
    assert.equal(spawnSync('mkfifo', [target]).status, 0);
    const inode = fs.lstatSync(target).ino;
    assert.throws(() => api.rewriteStatus({ runId }, dependencies), /Unsafe fresh rewrite file/);
    assert.equal(fs.lstatSync(target).isFIFO(), true);
    assert.equal(fs.lstatSync(target).ino, inode);
    for (const [name, bytes] of saved) {
        assert.deepEqual(fs.readFileSync(path.join(runDir, name)), bytes);
    }
    console.log('preserved');
}

for (const name of ['run.json', 'inputs.json', 'analysis.json']) {
    test(`公开新抓状态拒绝 ${name} 管道并保留原节点`, t => {
        const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fresh-run-fifo-'));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        const code = `(${exercise.toString()})(process.argv[1], process.argv[2]);`;
        const result = spawnSync(process.execPath, ['-e', code, directory, name], {
            cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 2500
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /preserved/);
    });
}
