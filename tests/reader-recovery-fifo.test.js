'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const repair = require('../scripts/lib/reader-repair.js');

for (const kind of ['exact-fifo', 'migration-fifo', 'regular', 'symlink']) {
    test(`Reader 公开恢复入口处理 ${kind} 时不阻塞且保留原文件`, t => {
        const executionDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-recovery-file-'));
        t.after(() => fs.rmSync(executionDir, { recursive: true, force: true }));
        const directory = path.join(executionDir, 'reader-attempts');
        fs.mkdirSync(directory, { mode: 0o700 });
        const identity = { paperId: 'conference:interspeech:2026:conference-paper-id:example26',
            sourceSha256: crypto.createHash('sha256').update('Original source').digest('hex') };
        const filename = path.join(directory, `${kind === 'migration-fifo' ? 'a'.repeat(64) : repair.hashDraft(identity)}.json`);
        if (kind.endsWith('fifo')) {
            const made = spawnSync('mkfifo', ['-m', '600', filename], { encoding: 'utf8' });
            assert.equal(made.status, 0, made.stderr);
        } else {
            const payload = { status: 'failed', attempts: 1, fullAttempts: 1, noProgress: 0,
                failureSignature: '', issues: [], draft: null, rawDraft: '' };
            const envelope = { version: repair.REPAIR_VERSION, identity, payload, payloadSha256: repair.hashDraft(payload) };
            const target = kind === 'symlink' ? path.join(executionDir, 'target.json') : filename;
            fs.writeFileSync(target, JSON.stringify(envelope), { mode: 0o600 });
            if (kind === 'symlink') fs.symlinkSync(target, filename);
        }
        const before = fs.lstatSync(filename);
        const context = { paperId: identity.paperId, executionDir, executionId: crypto.randomUUID(),
            sourceDetails: { source: 'conference_pdf_text', text: 'Original source' } };
        const code = `
            const context = require('./scripts/lib/conference-analysis-context.js');
            const recovery = require('./scripts/lib/reader-recovery-revision.js');
            try {
                const result = context.withConferenceAnalysisSource(${JSON.stringify(context)}, () =>
                    recovery.loadReaderRecoveryRevision(${JSON.stringify(directory)}, ${JSON.stringify(identity)}));
                console.log('RESULT:' + JSON.stringify({ status: result?.status }));
            } catch (error) { console.log('RESULT:' + JSON.stringify({ message: error.message, code: error.code })); }
        `;
        const result = spawnSync(process.execPath, ['-e', code], {
            cwd: path.resolve(__dirname, '..'), timeout: 3000, encoding: 'utf8'
        });
        assert.equal(result.error, undefined, result.error?.message);
        assert.equal(result.status, 0, result.stderr);
        const line = result.stdout.split('\n').find(value => value.startsWith('RESULT:'));
        assert.ok(line, result.stdout);
        const outcome = JSON.parse(line.slice('RESULT:'.length));
        if (kind === 'regular') assert.equal(outcome.status, 'failed');
        else if (kind === 'symlink') assert.match(outcome.message, /ELOOP|symbolic link|symlink/i);
        else assert.match(outcome.message, /Unsafe Reader/);
        const after = fs.lstatSync(filename);
        assert.equal(after.ino, before.ino);
        assert.equal(after.mode, before.mode);
    });
}

test('真实迁移后再次恢复也拒绝额度证明归档中的管道文件', t => {
    const executionDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-recovery-proof-'));
    t.after(() => fs.rmSync(executionDir, { recursive: true, force: true }));
    const directory = path.join(executionDir, 'reader-attempts');
    const code = `
        const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
        const { spawnSync } = require('node:child_process');
        const context = require('./scripts/lib/conference-analysis-context.js');
        const repair = require('./scripts/lib/reader-repair.js');
        const recovery = require('./scripts/lib/reader-recovery-revision.js');
        const directory = ${JSON.stringify(directory)};
        const paperId = 'conference:interspeech:2026:conference-paper-id:example26';
        const sourceSha256 = crypto.createHash('sha256').update('Original source').digest('hex');
        const oldIdentity = { paperId, sourceSha256, repairImplementationSha256: 'c'.repeat(64) };
        const identity = { ...oldIdentity, repairImplementationSha256: 'd'.repeat(64) };
        const payload = { status: 'failed', attempts: 1, fullAttempts: 1, noProgress: 0,
            failureSignature: '', issues: [], draft: null, rawDraft: '' };
        repair.saveFailedCandidate(directory, oldIdentity, payload);
        context.withConferenceAnalysisSource({ paperId, executionDir: ${JSON.stringify(executionDir)},
            executionId: crypto.randomUUID(), sourceDetails: { source: 'conference_pdf_text', text: 'Original source' } }, () => {
            const migrated = recovery.loadReaderRecoveryRevision(directory, identity);
            if (!migrated.implementationRepairAllowanceProof) throw new Error('真实迁移没有生成额度证明');
            const filename = path.join(directory, migrated.readerRecoveryRevisions[0].archivedName);
            fs.unlinkSync(filename);
            const made = spawnSync('mkfifo', ['-m', '600', filename], { encoding: 'utf8' });
            if (made.status !== 0) throw new Error(made.stderr);
            try { recovery.loadReaderRecoveryRevision(directory, identity); process.exitCode = 2; }
            catch (error) {
                if (!fs.lstatSync(filename).isFIFO()) throw new Error('归档管道被修改');
                console.log('RESULT:' + JSON.stringify({ message: error.message }));
            }
        });
    `;
    const result = spawnSync(process.execPath, ['-e', code], {
        cwd: path.resolve(__dirname, '..'), timeout: 3000, encoding: 'utf8'
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /allowance source envelope is unsafe/);
});
