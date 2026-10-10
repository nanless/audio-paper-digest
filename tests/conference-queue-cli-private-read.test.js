'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const loadPlan = require('../scripts/lib/conference-queue').loadPlan;
const readSafeJson = require('../scripts/conference-process').readSafeJson;

function privateDirectory(t) {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-recovery-read-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

const replacementReader = `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = process.argv[1], filename = process.argv[2], replacement = process.argv[3], entry = process.argv[4];
const originalOpen = fs.openSync, originalClose = fs.closeSync;
let openedFd, closeCount = 0, replaced = false;
fs.openSync = function (name, ...args) {
    if (name === filename && !replaced) {
        replaced = true;
        fs.renameSync(filename, filename + '.original');
        if (replacement === 'fifo') execFileSync('mkfifo', [filename]);
        else if (replacement === 'symlink') fs.symlinkSync(filename + '.original', filename);
        else fs.writeFileSync(filename, '{}', { mode: 0o600 });
        if (replacement !== 'symlink') fs.chmodSync(filename, 0o600);
        openedFd = undefined;
        closeCount = 0;
    }
    const fd = originalOpen.call(fs, name, ...args);
    if (name === filename) openedFd = fd;
    return fd;
};
fs.closeSync = function (fd) {
    if (fd === openedFd) closeCount++;
    return originalClose.call(fs, fd);
};
let error;
try { const api = require(path.join(root, entry === 'queue' ? 'scripts/lib/conference-queue' : 'scripts/conference-process'));
    api[entry === 'queue' ? 'loadPlan' : 'readSafeJson'](filename); }
catch (failure) { error = failure; }
finally { fs.openSync = originalOpen; fs.closeSync = originalClose; }
console.log(JSON.stringify({ rejected: Boolean(error), message: error?.message, code: error?.code || null,
    closeCount, opened: openedFd !== undefined, originalBytes: fs.readFileSync(filename + '.original', 'utf8') }));
`;

test('队列计划与会议状态读取拒绝打开前被替换的 FIFO、文件或符号链接，并关闭已打开的文件', async t => {
    for (const entry of ['queue', 'cli']) {
        for (const replacement of ['fifo', 'regular', 'symlink']) {
            await t.test(`${entry === 'queue' ? '队列计划' : '会议状态'}：${{ fifo: '无写入方 FIFO', regular: '另一普通文件', symlink: '符号链接' }[replacement]}`, subtest => {
                const directory = privateDirectory(subtest), filename = path.join(directory, 'state.json');
                fs.writeFileSync(filename, '{"kept":true}', { mode: 0o600 });
                const result = spawnSync(process.execPath, ['-e', replacementReader,
                    path.resolve(__dirname, '..'), filename, replacement, entry], { encoding: 'utf8', timeout: 2000 });
                assert.equal(result.error, undefined, '替换后的文件必须及时拒绝，不得在打开 FIFO 时等待');
                assert.equal(result.status, 0, result.stderr);
                const observation = JSON.parse(result.stdout.trim());
                assert.equal(observation.rejected, true);
                assert.equal(observation.originalBytes, '{"kept":true}');
                if (replacement === 'symlink') assert.equal(observation.code, 'ELOOP');
                else {
                    assert.match(observation.message, /打开的文件不是先前检查/);
                    assert.equal(observation.opened, true);
                    assert.equal(observation.closeCount, 1, '拒绝文件后关闭已打开的文件描述符');
                }
            });
        }
    }
});

test('队列计划与会议状态的合法私有文件仍可读取，链接和权限限制保持', t => {
    const directory = privateDirectory(t);
    for (const [name, read, value] of [
        ['queue', loadPlan, { contract: 'conference-queue-plan-v1', version: 1, conferences: [] }],
        ['cli', readSafeJson, { private: true }]
    ]) {
        const filename = path.join(directory, name + '.json');
        fs.writeFileSync(filename, JSON.stringify(value), { mode: 0o600 });
        const original = fs.readFileSync(filename), normal = read(filename);
        if (name === 'queue') assert.deepEqual(normal.conferences, []);
        else assert.deepEqual(normal, value);
        const symlink = filename + '.symlink'; fs.symlinkSync(filename, symlink);
        assert.throws(() => read(symlink));
        const hardlink = filename + '.hardlink'; fs.linkSync(filename, hardlink);
        assert.throws(() => read(filename)); fs.unlinkSync(hardlink);
        fs.chmodSync(filename, 0o644); assert.throws(() => read(filename));
        fs.chmodSync(filename, 0o600); assert.deepEqual(read(filename), normal);
        assert.deepEqual(fs.readFileSync(filename), original);
    }
});

function makeProcessInputs(modules, directory, implementationSha256) {
    const processApi = modules.processApi;
    const hash = processApi.stableHash;
    const members = [{
        paperId: 'conference:odyssey:2026:conference-paper-id:paper.1',
        sourceIdentity: 'conference-paper-id:paper.1'
    }];
    const analysisConfig = Object.fromEntries(processApi.DEEP_EXECUTION_LIMIT_FIELDS.map(field => [
        field, /Temperature$/.test(field) ? 0.1 : 1000
    ]));
    const deepExecutionConfig = processApi.deepExecutionConfigIdentity({
        env: {
            PAPER_ANALYZER_MODEL: 'synthetic-model',
            PAPER_ANALYZER_ENDPOINT: 'https://synthetic.invalid/v1'
        },
        analysisConfig,
        secondaryModelConfig: {},
        utilsApi: require(path.join(modules.root, 'scripts/utils.js'))
    });
    const authority = {
        conferenceId: 'odyssey-2026',
        catalogName: 'catalog.json',
        reportName: 'report.json',
        filterId: '11111111-1111-4111-8111-111111111111',
        catalogSha256: hash('catalog'),
        reportSha256: hash('report'),
        filterPolicySha256: hash('policy'),
        selectionReceiptSha256: hash('selection'),
        selectedMemberSetSha256: hash(members.map(member => member.paperId)),
        tagCatalogVersion: 'paper-tag-catalog-v2',
        tagCatalogSha256: hash('catalog-tags'),
        implementationSha256,
        deepExecutionConfig
    };
    const files = { conferenceProcessDir: path.join(directory, 'processes') };
    const context = { authority, members, files };
    let clockTicks = 0;
    let paperCalls = 0;
    const dependencies = {
        files,
        engine: modules.engine,
        loadAuthority: () => context,
        implementationSha256: () => implementationSha256,
        deepExecutionConfigIdentity: () => deepExecutionConfig,
        now: () => new Date(Date.parse('2026-09-09T00:00:00Z') + clockTicks++ * 1000).toISOString(),
        prepareShared: async () => ({
            planHandle: {},
            planReceiptSha256: hash('plan'),
            sealed: members.map(member => ({
                paperId: member.paperId,
                proof: {
                    requestSha256: hash('request'),
                    receiptSha256: hash('receipt'),
                    verificationSha256: hash('verify'),
                    textSha256: hash('text'),
                    artifactsSha256: hash('artifacts'),
                    pdfSha256: hash('pdf')
                }
            }))
        }),
        processPaper: async () => {
            paperCalls++;
            return {
                analysisProof: {
                    analysisSha256: hash('analysis'),
                    completionReceiptSha256: hash('analysis-receipt'),
                    sourceSnapshotSha256: hash('source')
                },
                pageProof: {
                    manifestSha256: hash('page'),
                    contentSha256: hash('content'),
                    pagePath: 'content/posts/test.md'
                }
            };
        },
        aggregate: async () => ({
            manifest: {
                aggregateId: hash('aggregate').slice(0, 32),
                manifestSha256: hash('manifest'),
                markdownSha256: hash('markdown'),
                pagePath: 'content/posts/conference-test.md'
            }
        })
    };
    return { dependencies, context, calls: () => paperCalls };
}

const artifactReader = `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = process.argv[1], replacement = process.argv[2];
${makeProcessInputs.toString()}
(async () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cli-artifact-probe-'));
    try {
        console.log(JSON.stringify({ syntheticDirectory: directory }));
        const modules = {
            root,
            processApi: require(path.join(root, 'scripts/lib/conference-process')),
            engine: require(path.join(root, 'scripts/analysis-engine'))
        };
        const processCase = makeProcessInputs(modules, directory, modules.processApi.implementationSha256());
        Object.assign(processCase.dependencies.files, {
            conferenceAnalysisDir: path.join(directory, 'analysis'),
            conferencePageStagingDir: path.join(directory, 'pages'),
            conferenceAggregateDir: path.join(directory, 'aggregates')
        });
        const completed = await modules.processApi.runConferenceProcess({ apply: true, concurrency: 1 }, processCase.dependencies);
        const state = JSON.parse(fs.readFileSync(path.join(processCase.dependencies.files.conferenceProcessDir,
            completed.processId, 'state.json'), 'utf8'));
        const item = Object.values(state.items)[0];
        const filename = path.join(processCase.dependencies.files.conferenceAnalysisDir, item.analysisRunId, 'analysis.json');
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, '{}', { mode: 0o644 });
        const originalOpen = fs.openSync;
        let replaced = false;
        if (replacement === 'fifo') {
            fs.openSync = function (name, ...args) {
                if (name === filename && !replaced) {
                    replaced = true;
                    fs.renameSync(filename, filename + '.original');
                    require('node:child_process').execFileSync('mkfifo', [filename]);
                    fs.chmodSync(filename, 0o644);
                }
                return originalOpen.call(fs, name, ...args);
            };
        }
        const cli = require(path.join(modules.root, 'scripts/conference-process.js'));
        const result = cli.processStatus({ verifyFiles: true }, { dependencies: processCase.dependencies });
        fs.openSync = originalOpen;
        assert.equal(result.filesVerified, true);
        assert.equal(result.fileVerification.checkedPapers, 1);
        assert.equal(result.fileVerification.status, 'failed');
        assert.equal(cli.statusExitCode(result), 1);
        console.log(JSON.stringify({ status: result.status, filesVerified: result.filesVerified,
            verificationStatus: result.fileVerification.status, exitCode: cli.statusExitCode(result),
            failures: result.fileVerification.failures }));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

test('会议状态的文件核验拒绝被替换的 FIFO，正常公开文件权限仍可读取', t => {
    for (const replacement of ['normal', 'fifo']) {
        const result = spawnSync(process.execPath, ['-e', artifactReader,
            path.resolve(__dirname, '..'), replacement], { encoding: 'utf8', timeout: 2000 });
        const firstLine = result.stdout.split('\n')[0];
        if (firstLine) {
            const directory = JSON.parse(firstLine).syntheticDirectory;
            t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        }
        assert.equal(result.error, undefined, '文件核验必须及时返回，不得在打开 FIFO 时等待');
        assert.equal(result.status, 0, result.stderr);
        const observation = JSON.parse(result.stdout.trim().split('\n').at(-1));
        assert.equal(observation.status, 'complete');
        assert.equal(observation.filesVerified, true);
        assert.equal(observation.verificationStatus, 'failed');
        assert.equal(observation.exitCode, 1);
        const analysisFailure = observation.failures.find(item => item.artifact === 'analysis');
        assert.ok(analysisFailure);
        if (replacement === 'fifo') assert.match(analysisFailure.detail, /不是先前检查的普通单链接文件/);
        else assert.match(analysisFailure.detail, /SHA 与 analysisProof/);
    }
});
