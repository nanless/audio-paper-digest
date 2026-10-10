'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

async function exercise(scenario, rootDir) {
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const { spawnSync } = require('node:child_process');
    const config = require('./scripts/config.js');
    const fresh = require('./scripts/lib/fresh-analysis-context.js');
    const daily = require('./scripts/lib/daily-fresh-source-plan.js');
    const sha = value => crypto.createHash('sha256').update(value).digest('hex');
    config.FILES.dailyFreshSourceRunsDir = path.join(rootDir, 'daily');
    config.FILES.freshRewriteRunsDir = path.join(rootDir, 'fresh');
    const id = '2609.99970';
    const papers = [{ arxivId: id }];
    const planInput = { batchDate: '2026-10-09', batchId: 'fifo-test', papers };
    const plan = daily.createDailyFreshSourcePlan(planInput);
    const reference = daily.dailyFreshSourceReference(plan);
    const makeFifo = filename => {
        fs.rmSync(filename, { force: true });
        const result = spawnSync('mkfifo', ['-m', '600', filename], { encoding: 'utf8' });
        if (result.status !== 0) throw new Error(result.stderr);
    };
    let protectedFile = path.join(plan.runDir, 'run.json');
    let calls = 0;
    let operation;
    if (scenario === 'regular') {
        daily.createDailyFreshSourcePlan(planInput);
        const replay = daily.readDailyFreshSourcePlan(reference);
        if (replay.runId !== plan.runId) throw new Error('正常来源运行身份改变');
        return { regular: true };
    } else if (scenario === 'daily-race') {
        fs.unlinkSync(protectedFile);
        const original = fs.linkSync;
        fs.linkSync = (source, target) => {
            if (target === protectedFile) makeFifo(target);
            return original(source, target);
        };
        operation = () => daily.createDailyFreshSourcePlan(planInput);
    } else if (scenario.startsWith('daily-')) {
        makeFifo(protectedFile);
        operation = scenario === 'daily-create' ? () => daily.createDailyFreshSourcePlan(planInput)
            : scenario === 'daily-read' ? () => daily.readDailyFreshSourcePlan(reference)
                : () => daily.requireDailyFreshSourceRecoveryPlan({ batchDate: plan.batchDate, papers,
                    dailyFreshSourceRun: reference });
    } else {
        const runId = crypto.randomUUID();
        const runDir = path.join(config.FILES.freshRewriteRunsDir, runId);
        fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
        const text = 'Original full paper evidence and measured experiment. '.repeat(150);
        const artifacts = { version: 1, tables: [], formulas: [], figures: [], flattenedTextSha256: sha(text) };
        artifacts.payloadSha256 = sha(JSON.stringify(artifacts));
        const sourceExpectations = { [id]: { sourceSha256: sha(text), structuredArtifactsSha256: artifacts.payloadSha256 } };
        const identity = { runId, runDir, sourceExpectations };
        const manifest = { version: 1, contract: 'fresh-rewrite-run-v1', runId, paperIds: [id], sourceExpectations };
        fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(manifest), { mode: 0o600 });
        await fresh.withFreshAnalysisContext(identity, () => fresh.fetchFreshSource(id, async () => {
            calls += 1;
            return { text, source: 'html', sourceId: id, imageInfos: [], structuredArtifacts: artifacts };
        }));
        if (calls !== 1 || fresh.readFreshSource(runDir, id, identity).text !== text) {
            throw new Error('正常封存来源未能原样回读');
        }
        protectedFile = scenario === 'fresh-manifest' ? path.join(runDir, 'run.json')
            : path.join(runDir, 'sources', id, 'source-details.json');
        makeFifo(protectedFile);
        operation = () => fresh.readFreshSource(runDir, id, identity);
    }
    try {
        await operation();
        throw new Error('未拒绝管道文件');
    } catch (error) {
        const expectedMessage = scenario.startsWith('fresh-')
            ? /来源文件不是普通文件、硬链接数量不为 1，或大小超过 64 MiB/
            : /每日来源运行清单 不安全或超过大小限制/;
        if (!expectedMessage.test(error.message)) throw error;
        if (!fs.lstatSync(protectedFile).isFIFO()) throw new Error('管道文件被修改');
        return { code: error.code, message: error.message, calls };
    }
}

for (const scenario of ['regular', 'daily-create', 'daily-read', 'daily-recovery', 'daily-race', 'fresh-manifest', 'fresh-source']) {
    test(`封存来源 ${scenario} 公开路径不因管道文件阻塞`, t => {
        const rootDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'source-fifo-test-'));
        t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
        const code = `(${exercise.toString()})(${JSON.stringify(scenario)}, ${JSON.stringify(rootDir)})
            .then(result => console.log('RESULT:' + JSON.stringify(result)), error => { console.error(error); process.exitCode = 1; });`;
        const result = spawnSync(process.execPath, ['-e', code], {
            cwd: path.resolve(__dirname, '..'), timeout: 3000, encoding: 'utf8'
        });
        assert.equal(result.error, undefined, result.error?.message);
        assert.equal(result.status, 0, result.stderr);
        const line = result.stdout.split('\n').find(value => value.startsWith('RESULT:'));
        assert.ok(line, result.stdout);
        const outcome = JSON.parse(line.slice('RESULT:'.length));
        if (scenario === 'regular') assert.equal(outcome.regular, true);
        else assert.equal(outcome.code, scenario.startsWith('fresh-')
            ? 'FRESH_ANALYSIS_INTEGRITY' : 'DAILY_FRESH_SOURCE_PLAN_INTEGRITY');
    });
}
