'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const deep = require('../scripts/deep-analyzer.js');
const { fixture: createSignedReaderSample } = require('./reader-signed-draft-fixture.js');

test('保存接受结果失败时保留原存储错误和整批停止范围', async t => {
    const sample = createSignedReaderSample({ noFigures: true });
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-storage-stop-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const storageError = Object.assign(new Error('保存接受结果失败'), {
        code: 'ENOSPC',
        scope: 'run',
        retryable: false
    });
    let modelRequests = 0;
    let acceptedWrites = 0;
    await assert.rejects(deep.generateApiReaderArticleDetailed(sample.paper, '', '', {
        sourceText: sample.sourceDetails.text,
        structuredArtifacts: sample.sourceDetails.structuredArtifacts,
        readerAttemptsDir: directory,
        readerMaxAttempts: 1,
        readerMaterializeFigures: async () => [],
        readerCallModel: async () => {
            modelRequests += 1;
            return JSON.stringify(sample.draft);
        },
        readerRecordDisposition: record => {
            if (record.disposition === 'accepted') {
                acceptedWrites += 1;
                throw storageError;
            }
        }
    }), error => error === storageError);
    assert.equal(modelRequests, 1);
    assert.equal(acceptedWrites, 1, '必须实际进入接受结果的保存步骤');
    const records = fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    assert.equal(records.length, 1, '仍须保留已付费草稿');
    const stored = JSON.parse(fs.readFileSync(path.join(directory, records[0]), 'utf8'));
    assert.equal(stored.payload.attempts, 1);
    assert.equal(stored.payload.fullAttempts, 1);
});
