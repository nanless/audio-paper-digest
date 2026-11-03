'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const RUN_ID = '11111111-2222-4333-8444-555555555555';
const PAPER_ID = '2609.03107';
const SOURCE_SHA = 'a'.repeat(64);
const entries = [
    ['reader-operator-patch', 'applyOperatorPatch'],
    ['reader-signed-operator', 'applyReaderOperatorPatch']
];

function requestFor(moduleName) {
    const common = {
        paperId: PAPER_ID,
        sourceSha256: SOURCE_SHA,
        reason: '依据受控来源修正已有段落。',
        patch: { replacements: [{ path: '/readerTitle', value: '修正的论文标题' }] }
    };
    return moduleName === 'reader-operator-patch'
        ? { ...common, candidateIdentitySha256: 'b'.repeat(64) }
        : { ...common, version: 1, runId: RUN_ID, parentPaperSha256: 'b'.repeat(64),
            parentArticleSha256: 'c'.repeat(64), parentPlanSha256: 'd'.repeat(64) };
}

function runFileProbe(code) {
    return new Promise((resolve, reject) => {
        const processHandle = spawn(process.execPath, ['-e', code], {
            cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '', stderr = '', ready = false, expired = '';
        const deadline = phase => setTimeout(() => {
            expired = phase;
            processHandle.kill('SIGKILL');
        }, phase === 'startup' ? 15000 : 3000);
        let timer = deadline('startup');
        processHandle.stdout.setEncoding('utf8').on('data', text => {
            stdout += text;
            if (!ready && stdout.includes('READY\n')) {
                ready = true;
                clearTimeout(timer);
                timer = deadline('file probe');
            }
        });
        processHandle.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
        processHandle.once('error', error => { clearTimeout(timer); reject(error); });
        processHandle.once('close', status => {
            clearTimeout(timer);
            if (expired) reject(new Error(`Reader operator ${expired} timed out`));
            else resolve({ status, stdout, stderr });
        });
    });
}

for (const [moduleName, entry] of entries) {
    for (const kind of ['fifo', 'regular', 'symlink']) {
        test(`${moduleName} 公开入口核验 ${kind} 文件且不阻塞`, async t => {
            const rootDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-operator-file-'));
            t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
            const runDir = path.join(rootDir, RUN_ID);
            const directory = path.join(runDir, 'patches');
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
            const filename = path.join(directory, 'input.json');
            if (kind === 'fifo') {
                const made = spawnSync('mkfifo', ['-m', '600', filename], { encoding: 'utf8' });
                assert.equal(made.status, 0, made.stderr);
            } else {
                const target = kind === 'symlink' ? path.join(directory, 'target.json') : filename;
                fs.writeFileSync(target, JSON.stringify(requestFor(moduleName)), { mode: 0o600 });
                if (kind === 'symlink') fs.symlinkSync(target, filename);
            }
            const before = fs.lstatSync(filename);
            const loaded = { runDir, run: { runId: RUN_ID, status: 'analysis_partial', paperIds: [PAPER_ID],
                sourceExpectations: { [PAPER_ID]: { sourceSha256: SOURCE_SHA } } },
                inputs: { papers: [{ arxivId: PAPER_ID }] } };
            const code = `
                const api = require(${JSON.stringify(path.resolve(__dirname, '../scripts/lib', `${moduleName}.js`))});
                let locks = 0;
                process.stdout.write('READY\\n', () => api[${JSON.stringify(entry)}](${JSON.stringify({ loaded, patchFile: 'input.json' })}, {
                    rootDir: ${JSON.stringify(rootDir)},
                    withPaperAnalysisLock() { locks += 1; throw new Error('FILE_VALIDATED'); }
                }).then(() => process.exit(2), error => {
                    process.stdout.write('RESULT:' + JSON.stringify({ message: error.message, code: error.code, locks }) + '\\n');
                }));
            `;
            const result = await runFileProbe(code);
            assert.equal(result.status, 0, result.stderr);
            const line = result.stdout.split('\n').find(value => value.startsWith('RESULT:'));
            assert.ok(line, result.stdout);
            const outcome = JSON.parse(line.slice('RESULT:'.length));
            if (kind === 'regular') {
                assert.equal(outcome.message, 'FILE_VALIDATED');
                assert.equal(outcome.locks, 1);
            } else {
                assert.equal(outcome.locks, 0);
                if (kind === 'fifo') assert.match(outcome.message, moduleName === 'reader-operator-patch'
                    ? /权限为 0600、只有一个硬链接.*普通文件/ : /regular.*single-link.*0600/);
                else assert.equal(outcome.code, 'ELOOP');
            }
            const after = fs.lstatSync(filename);
            assert.equal(after.ino, before.ino);
            assert.equal(after.mode, before.mode);
        });
    }
}
