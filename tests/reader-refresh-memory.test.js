'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

async function probe() {
    const references = [];
    let reads = 0, verified = 0, arrived = 0;
    const pending = [];
    const read = () => {
        reads++;
        const papers = Array.from({ length: 245 }, (_, index) => ({
            arxivId: `2610.${String(index).padStart(5, '0')}`,
            analysis: `${reads}-${index}:` + '正文'.repeat(10000),
            analysisManifest: { stages: {} }
        }));
        references.push(new WeakRef(papers[244]));
        return { papers };
    };
    const stop = { withAnalysisStopControl: fn => fn(), assertMayStartRequest() {} };
    const modules = {
        './config.js': { FILES: { deepAnalysisResult: 'unused' } },
        './deep-analyzer.js': { stableFingerprint: value => JSON.stringify(value) },
        './analysis-engine.js': {
            readJsonFileStrict: read,
            isSuccessfulAnalysisRecord: () => true,
            withPaperAnalysisLock: (_, fn) => fn()
        },
        './lib/daily-fresh-source-plan.js': {
            requireDailyFreshSourceRecoveryPlan(payload) {
                assert.equal(payload.papers.length, 245);
                verified += payload.papers.length;
                return { paperIds: payload.papers.map(paper => paper.arxivId) };
            },
            requireLockedDailyFreshSourceRecoveryPlan(payload, { entryPlan, paper }) {
                assert.equal(payload.papers.length, 245);
                assert.ok(payload.papers.some(row => row.arxivId === paper.arxivId));
                verified++;
                return entryPlan;
            },
            requireFinalDailyFreshSourceRecoveryPlan(payload, { entryPlan }) {
                assert.equal(payload.papers.length, 245);
                verified += payload.papers.length;
                return entryPlan;
            },
            isPaperBoundToPlan: () => true,
            withDailyFreshAnalysisContext: (_, fn) => fn(),
            withDailyFreshPaperSource: (_, paper, fn) => fn({ text: paper.analysis })
        },
        './lib/reader-tables.js': {},
        './lib/analysis-failure-rounds.js': require('../scripts/lib/analysis-failure-rounds'),
        './lib/analysis-batch-report.js': { writeAnalysisBatchReport: () => 'test-diagnostics' },
        './digest-status.js': {},
        './utils.js': { normalizedId: item => typeof item === 'string' ? item : item.arxivId },
        './lib/analysis-stop-control': stop
    };
    const filename = path.resolve(__dirname, '../scripts/refresh-api-reader.js');
    const module = { exports: {} };
    const source = fs.readFileSync(filename, 'utf8').replace(/^#![^\n]*\n/, '');
    const localRequire = name => {
        if (Object.hasOwn(modules, name)) return modules[name];
        if (name.startsWith('node:')) return require(name);
        throw new Error(`不应调用其他模块：${name}`);
    };
    new vm.Script(`(function(require,module,exports){${source}\n})`, { filename })
        .runInThisContext()(localRequire, module, module.exports);
    const calls = Array.from({ length: 10 }, (_, index) => module.exports.refreshApiReader(
        `2610.${String(index).padStart(5, '0')}`, {
            operations: { article: async () => {
                arrived++;
                await new Promise(resolve => pending.push(resolve));
                throw new Error('测试在保存前停止');
            } }
        }
    ).catch(error => error));
    assert.equal(arrived, 10);
    assert.equal(reads, 20, '每篇锁前和锁内都重新读取');
    assert.equal(verified, 10 * 245 + 10, '锁前全批核验、锁内只免除其他论文重复核验');
    await new Promise(resolve => setImmediate(resolve));
    for (let i = 0; i < 5; i++) {
        global.gc();
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(references.filter(reference => reference.deref()).length, 0,
        '十个请求等待时，未选论文应可回收，不能保留二十份整批记录');
    console.log(JSON.stringify({ reads, verified, pendingRequests: arrived,
        retainedUnselectedRecords: 0, heapUsed: process.memoryUsage().heapUsed }));
    pending.forEach(resolve => resolve());
    await Promise.all(calls);
    assert.equal(reads, 30, '结束时仍读最新中央记录');
    assert.equal(verified, 20 * 245 + 10, '即使刷新失败，结束时仍重新核验全批来源');
}

if (process.argv.includes('--memory-probe')) {
    probe().catch(error => { console.error(error.stack); process.exitCode = 1; });
} else {
    const test = require('node:test');
    test('十篇公共刷新释放非目标记录，锁内检查当前来源且结束复核全批', () => {
        const result = spawnSync(process.execPath, ['--expose-gc', __filename, '--memory-probe'],
            { encoding: 'utf8', timeout: 30000 });
        assert.equal(result.status, 0, result.stderr + result.stdout);
        const line = result.stdout.trim().split('\n').at(-1);
        const evidence = JSON.parse(line);
        assert.equal(evidence.pendingRequests, 10);
        assert.equal(evidence.retainedUnselectedRecords, 0);
    });
}
