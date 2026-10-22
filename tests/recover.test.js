'use strict';
const test = require('node:test');
const assert = require('node:assert');
const recover = require('../scripts/recover');
const fs = require('node:fs');
const path = require('node:path');
const DATE = '2026-10-22';

function savedInputs(t, overrides = {}, date = DATE) {
    const sources = {
        analysis: JSON.stringify({ batchDate: date, papers: [] }),
        review: JSON.stringify({ date, files: [], issues: [] }),
        ...overrides
    };
    const files = new Map([
        [path.resolve(__dirname, '../data/current/deep-analysis-result.json'), sources.analysis],
        [path.resolve(__dirname, `../data/current/blog-review-failure-${date}.json`), sources.review]
    ]);
    const original = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
        if (!files.has(file)) return original(file, ...args);
        const value = files.get(file);
        if (value instanceof Error) throw value;
        if (value === undefined) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
        return value;
    });
}

function cliSnapshot(overrides = {}, flags = []) {
    const records = {
        analysis: JSON.stringify({ batchDate: DATE, papers: [] }),
        review: JSON.stringify({ date: DATE, files: [], issues: [] }),
        ...overrides
    };
    const output = [];
    const spawnCalls = [];
    const previous = console.log;
    console.log = value => output.push(String(value));
    try {
        const exitCode = recover.main(['--date', DATE, '--json', ...flags], {
            readFile: file => {
                const value = records[file.endsWith('deep-analysis-result.json') ? 'analysis' : 'review'];
                if (value instanceof Error) throw value;
                if (value === undefined) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
                return value;
            },
            spawnSync: (...args) => { spawnCalls.push(args); return { status: 0 }; }
        });
        if (!spawnCalls.length) assert.strictEqual(output.length, 1, '预览/阻断的JSON输出只能有一份完整对象');
        return { exitCode, report: JSON.parse(output[0]), spawnCalls };
    } finally { console.log = previous; }
}

test('损坏JSON和错误顶层形状不再伪装成无保存失败', t => {
    savedInputs(t, { analysis: '{' });
    assert.throws(() => recover.collectFailures(DATE), /invalid_json/);
});

test('错批分析不能只警告后继续生成恢复建议', t => {
    savedInputs(t, { analysis: JSON.stringify({ batchDate: '2026-10-21', papers: [] }) });
    assert.throws(() => recover.collectFailures(DATE), /date_mismatch/);
});

test('恢复日期必须是真实日历日期', t => {
    savedInputs(t, {}, '2026-02-30');
    assert.throws(() => recover.collectFailures('2026-02-30'), /有效|真实|日期/);
});

test('papers非数组的正式对象明确阻断', t => {
    savedInputs(t, { analysis: JSON.stringify({ batchDate: DATE, papers: 'bad' }) });
    assert.throws(() => recover.collectFailures(DATE), /invalid_shape/);
});

test('页面issues和顶层批次issues独立收集，顶层摘要同样脱敏', t => {
    savedInputs(t, { review: JSON.stringify({ date: DATE,
        files: [{ path: 'content/posts/a.md', passed: false,
            issues: [{ severity: 'error', description: '缺少当前页面审查凭证' }] }],
        issues: [{ severity: 'error', description: '批次失败 api_key=TOP_SECRET_FIXTURE' }]
    }) });
    const failures = recover.collectFailures(DATE);
    assert.strictEqual(failures.length, 2);
    assert.ok(failures.some(item => item.page === 'a.md'));
    assert.ok(!JSON.stringify(failures).includes('TOP_SECRET_FIXTURE'));
});

test('collectFailures 遇审查凭证和共享博客锁错误仍收齐后续失败', t => {
    const fs = require('node:fs');
    const path = require('node:path');
    const date = '2026-10-22';
    const currentDir = path.resolve(__dirname, '../data/current');
    const analysisFile = path.join(currentDir, 'deep-analysis-result.json');
    const reviewFile = path.join(currentDir, `blog-review-failure-${date}.json`);
    const readFileSync = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
        if (file === analysisFile) return JSON.stringify({ batchDate: date, papers: [
            { arxivId: '2610.12345', error: '缺少与当前页面字节匹配的审查凭证' },
            { arxivId: '2610.12346', error: '等待共享博客仓库锁超时' },
            { arxivId: '2610.12347', error: '来源 SHA 不一致' }
        ] });
        if (file === reviewFile) return JSON.stringify({ date, files: [] });
        return readFileSync(file, ...args);
    });
    const failures = recover.collectFailures(date);
    assert.deepStrictEqual(failures.map(item => item.code), [
        'blog-review-receipt-missing', 'blog-lock-busy', 'source-sha-mismatch'
    ]);
    const groups = recover.plan(failures);
    const output = recover.render(date, failures, groups);
    assert.match(output, /3 个失败项/);
    assert.match(output, /blog-review-receipt-missing/);
    assert.match(output, /blog-lock-busy/);
    assert.ok(groups.some(group => group.command === `npm run blog:review -- --date ${date}`));
    assert.ok(groups.some(group => group.command === 'npm run locks'));
});

test('plan 按命令聚合失败项并保留可重试性', () => {
    const groups = recover.plan([
        { source: 'analysis', paperId: '2610.1', code: 'reader-repair-no-progress', label: 'x', retryable: false, command: 'npm run deep -- --date 2026-10-21', doc: 'd', message: 'm' },
        { source: 'analysis', paperId: '2610.2', code: 'reader-repair-no-progress', label: 'x', retryable: false, command: 'npm run deep -- --date 2026-10-21', doc: 'd', message: 'm2' }
    ]);
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].items.length, 2);
    assert.match(groups[0].command, /npm run deep/);
});

test('buildExecutionArgs 保留建议命令的真实 flags 并替换日期', () => {
    const args = recover.buildExecutionArgs('npm run api:reader:refresh -- --all --date <DATE> --concurrency 5 --scoring-and-reader', '2026-10-21');
    assert.deepStrictEqual(args, ['run', 'api:reader:refresh', '--', '--all', '--date', '2026-10-21', '--concurrency', '5', '--scoring-and-reader']);
    assert.deepStrictEqual(recover.buildExecutionArgs('npm run config:check', '2026-10-21'), ['run', 'config:check', '--']);
    assert.strictEqual(recover.buildExecutionArgs('npm run table:check -- --draft <FILE>', '2026-10-21'), null);
    assert.strictEqual(recover.buildExecutionArgs('npm run recover -- --date <DATE>', '2026-10-21'), null);
});

test('无失败时 render 给出正常提示', () => {
    const text = recover.render('2026-10-21', [], []);
    assert.match(text, /未发现可采集的已保存失败项/);
    assert.match(text, /不表示正式资格通过/);
});

test('真实日历及北京默认日期保留，不接受缺值或非法日期', () => {
    assert.strictEqual(recover.parseRecoveryDate('2024-02-29'), '2024-02-29');
    for (const date of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-00-01', '2026-01-00', '2026-1-01', '', null]) {
        assert.throws(() => recover.parseRecoveryDate(date), /日期|YYYY-MM-DD/);
    }
    assert.strictEqual(recover.beijingDate(new Date('2026-10-21T16:00:00.000Z')), DATE);
    assert.throws(() => recover.main(['--date']), /缺少/);
    assert.throws(() => recover.main(['--date', '--json']), /缺少/);
});

test('真实CLI非法日历和缺date值在读材料前退出2', () => {
    const { spawnSync } = require('node:child_process');
    for (const args of [['--date', '2026-02-30', '--json'], ['--date'], ['--date', '--json']]) {
        const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/recover.js'), ...args], { encoding: 'utf8' });
        assert.strictEqual(result.status, 2);
        assert.strictEqual(result.stdout, '');
        assert.match(result.stderr, /日期|缺少/);
    }
});

test('nullable诊断字段、正式ID别名和独立义务均保留真实保存兼容', t => {
    savedInputs(t, { analysis: JSON.stringify({ batchDate: DATE, papers: [
        { paper_id: ' ABCv2', arxivId: '2610.99999', error: '普通失败', latestAnalysisAttemptErrorCode: null,
            latestAnalysisAttemptErrorCategory: null, latestAnalysisAttemptErrorStatus: 429, latestAnalysisAttemptErrorScope: null },
        { arxivId: '2610.12345v3', error: null, latestAnalysisAttemptError: '', latestAnalysisAttemptErrorCode: '' },
        { id: '2610.12346v1', latestAnalysisAttemptError: null, analysisFactReviewObligation: {} },
        { arxivId: '2610.12347', digestStatus: { latestAttemptStatus: 'analysis_failed' } },
        { id: '2610.12348', error: '正文失败', analysisFactReviewObligation: {} }
    ] }) });
    const result = recover.collectSavedRecoveryState(DATE);
    assert.strictEqual(result.status, 'collected');
    assert.deepStrictEqual(result.failures.map(item => item.paperId), ['abc', '2610.12346', '2610.12347', '2610.12348', '2610.12348']);
    assert.strictEqual(result.failures.filter(item => item.code === 'fact-review-obligation').length, 2);
    assert.strictEqual(result.coverage.analysisRecords, 5);
});

test('旧数组和缺batchDate仅unsupported，不推断今日或迁移', () => {
    for (const value of [[{ arxivId: '2610.12345', fetchedAt: `${DATE}T00:00:00Z` }], [], { papers: [] }]) {
        const result = cliSnapshot({ analysis: JSON.stringify(value) }, ['--execute', '--yes']);
        assert.strictEqual(result.report.status, 'blocked');
        assert.strictEqual(result.report.coverage.sources[0].state, 'unsupported_legacy');
        assert.strictEqual(result.exitCode, 2);
        assert.strictEqual(result.spawnCalls.length, 0);
    }
});

test('任一missing仅partial预览，strict非零，execute整体拒绝', () => {
    const failure = JSON.stringify({ batchDate: DATE, papers: [{ arxivId: '2610.12345', error: '普通失败' }] });
    for (const input of [{ analysis: failure, review: undefined }, { analysis: undefined }, { analysis: undefined, review: undefined }]) {
        const preview = cliSnapshot(input);
        assert.strictEqual(preview.exitCode, 0);
        assert.strictEqual(preview.report.status, 'partial');
        assert.strictEqual(preview.report.coverage.scopeComplete, false);
        assert.strictEqual(preview.report.semanticCoverage, 'not_checked');
        assert.strictEqual(cliSnapshot(input, ['--strict']).exitCode, 1);
        const execute = cliSnapshot(input, ['--execute', '--yes']);
        assert.strictEqual(execute.exitCode, 2);
        assert.strictEqual(execute.spawnCalls.length, 0);
    }
});

test('present坏JSON/读错/错批/形状始终阻断并保留另一通道诊断，零spawn', () => {
    const invalidAnalysis = [
        ['{', 'invalid_json'],
        [Object.assign(new Error('private detail'), { code: 'EACCES' }), 'unreadable'],
        [Object.assign(new Error('private detail'), { code: 'EIO' }), 'unreadable'],
        [JSON.stringify({ batchDate: '2026-10-21', papers: [] }), 'date_mismatch'],
        ...[null, 42, 'bad', { batchDate: DATE }, { batchDate: DATE, papers: null },
            { batchDate: DATE, papers: [null] }, { batchDate: DATE, papers: [{ arxivId: 123 }] },
            { batchDate: DATE, papers: [{ arxivId: '2610.12345', error: {} }] },
            { batchDate: DATE, papers: [{ arxivId: '2610.12345', latestAnalysisAttemptErrorCode: 401 }] },
            { batchDate: DATE, papers: [{ arxivId: '2610.12345', digestStatus: [] }] }
        ].map(value => [JSON.stringify(value), 'invalid_shape'])
    ];
    const review = JSON.stringify({ date: DATE, issues: [{ severity: 'error', description: '缺少当前审查凭证' }] });
    for (const [analysis, state] of invalidAnalysis) {
        const result = cliSnapshot({ analysis, review }, ['--execute', '--yes']);
        assert.strictEqual(result.report.status, 'blocked');
        assert.strictEqual(result.report.coverage.sources[0].state, state);
        assert.strictEqual(result.report.failures.length, 1, '另一合法输入仍提供诊断，不作为执行依据');
        assert.strictEqual(result.report.coverage.analysisRecords, null);
        assert.strictEqual(result.exitCode, 2);
        assert.strictEqual(result.spawnCalls.length, 0);
        assert.ok(!JSON.stringify(result.report).includes('private detail'));
    }
});

test('review日期和各保存通道形状严格校验，合法旧issues-only仍可采集', () => {
    for (const value of [null, [], { files: [] }, { date: '2026-10-21', files: [] },
        { date: DATE }, { date: DATE, files: {} }, { date: DATE, issues: null },
        { date: DATE, files: [null] }, { date: DATE, files: [{ path: 123 }] },
        { date: DATE, files: [{ path: 'content/posts/a.md', issues: [null] }] },
        { date: DATE, issues: [{ severity: 'error', description: {} }] }]) {
        const result = cliSnapshot({ review: JSON.stringify(value) }, ['--execute', '--yes']);
        assert.strictEqual(result.report.status, 'blocked');
        assert.strictEqual(result.exitCode, 2);
        assert.strictEqual(result.spawnCalls.length, 0);
    }
    const legacy = cliSnapshot({ review: JSON.stringify({ date: DATE, issues: [
        { severity: 'error', description: '缺少当前审查凭证' }
    ] }) });
    assert.strictEqual(legacy.report.status, 'collected');
    assert.strictEqual(legacy.report.failures[0].scope, 'batch');
    assert.strictEqual(legacy.report.coverage.reviewBatchIssues, 1);
});

test('both valid空记录明确saved-records而非正式通过，不输出原正文', () => {
    const result = cliSnapshot({ analysis: JSON.stringify({ batchDate: DATE, papers: [], secretBody: 'DO_NOT_PRINT_BODY' }) });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.report.status, 'collected');
    assert.strictEqual(result.report.collectionMode, 'saved_records');
    assert.strictEqual(result.report.semanticCoverage, 'not_checked');
    assert.strictEqual(result.report.coverage.scopeComplete, false);
    assert.deepStrictEqual(result.report.coverage.sources.map(source => source.state), ['valid', 'valid']);
    assert.strictEqual(result.report.coverage.analysisRecords, 0);
    assert.strictEqual(result.report.coverage.reviewFiles, 0);
    assert.strictEqual(result.report.coverage.reviewBatchIssues, 0);
    assert.ok(result.report.coverage.sources.every(source => /^[a-f0-9]{64}$/.test(source.sha256)));
    assert.ok(!JSON.stringify(result.report).includes('DO_NOT_PRINT_BODY'));
    assert.ok(!Object.hasOwn(result.report, 'ready'));
});

test('both valid仍保留显式execute加yes及原参数行为，测试仅捕获替身', () => {
    const input = { analysis: JSON.stringify({ batchDate: DATE, papers: [
        { arxivId: '2610.12345', error: '配置缺失' }
    ] }) };
    assert.strictEqual(cliSnapshot(input).spawnCalls.length, 0);
    assert.throws(() => cliSnapshot(input, ['--execute']), /--yes/);
    const result = cliSnapshot(input, ['--execute', '--yes']);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.report.coverage.scopeComplete, false);
    assert.strictEqual(result.spawnCalls.length, 1);
    assert.deepStrictEqual(result.spawnCalls[0].slice(0, 2), ['npm', ['run', 'config:check', '--']]);
});

test('真实temp输入按原字节指纹只读采集，旧error字段null不会误拒', t => {
    const os = require('node:os');
    const crypto = require('node:crypto');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-saved-records-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const analysis = Buffer.from(JSON.stringify({ batchDate: DATE, papers: [{ id: '2610.12345', error: null,
        latestAnalysisAttemptError: null, latestAnalysisAttemptErrorCode: null }] }, null, 2) + '\n');
    const review = Buffer.from(JSON.stringify({ date: DATE, files: [] }) + '\n');
    const analysisFile = path.join(directory, 'deep-analysis-result.json');
    const reviewFile = path.join(directory, `blog-review-failure-${DATE}.json`);
    fs.writeFileSync(analysisFile, analysis);
    fs.writeFileSync(reviewFile, review);
    const snapshot = recover.collectSavedRecoveryState(DATE, { currentDir: directory });
    assert.strictEqual(snapshot.status, 'collected');
    assert.strictEqual(snapshot.coverage.sources[0].sha256, crypto.createHash('sha256').update(analysis).digest('hex'));
    assert.deepStrictEqual(fs.readFileSync(analysisFile), analysis);
    assert.deepStrictEqual(fs.readFileSync(reviewFile), review);
});
