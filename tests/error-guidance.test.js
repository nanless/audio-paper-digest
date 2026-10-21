const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
    guidanceFor,
    ruleIdFor,
    printErrorGuidance,
    redactSensitive,
    collectErrorChain,
    formatGuidanceLines,
    DATE_PLACEHOLDER
} = require('../scripts/lib/error-guidance.js');

const ENTRY_FILES = [
    'scripts/full-fetch.js',
    'scripts/batch-analyze.js',
    'scripts/deep-analysis-only.js',
    'scripts/reanalyze.js',
    'scripts/refresh-api-reader.js',
    'scripts/generate-blog.py',
    'scripts/review-blog.py',
    'scripts/push-blog.py'
];

const DOCS = 'docs/';

// 表驱动：每个真实事故类型都必须命中专用指引，不能落到通用兜底。
const CASES = [
    {
        name: 'arXiv 429 限流',
        error: Object.assign(new Error('Too Many Requests'), { code: 'ARXIV_RATE_LIMITED', status: 429 }),
        stage: 'fetch',
        cause: /arXiv 限流/,
        commandIncludes: ['sleep 60', 'npm run fetch -- --date'],
        docRef: 'docs/daily-fetch-boundary.md'
    },
    {
        name: '官方 OAI/RSS stale',
        error: new Error('OAI responseDate is stale or invalid for the fixed batch boundary'),
        stage: 'fetch',
        cause: /OAI\/RSS 元数据与固定批次边界不一致/,
        commandIncludes: ['--require-previously-fetched', 'npm run validate:data'],
        docRef: 'docs/daily-fetch-boundary.md'
    },
    {
        name: 'LLM 账号池额度耗尽（429 GoUsageLimitError）',
        error: new Error('GoUsageLimitError: account pool usage limit reached'),
        stage: 'deep-analysis',
        cause: /模型账号池不可用/,
        commandIncludes: ['PAPER_ANALYZER_API_KEY', 'npm run workspace:role -- status'],
        docRef: 'docs/troubleshooting.md'
    },
    {
        name: 'LLM 账号池 401 Insufficient balance',
        error: Object.assign(new Error('Insufficient balance'), { status: 401, code: 'INSUFFICIENT_BALANCE' }),
        stage: 'api-reader',
        cause: /模型账号池不可用/,
        commandIncludes: ['npm run digest:status -- --date'],
        docRef: 'docs/troubleshooting.md'
    },
    {
        name: 'READER_REPAIR_NO_PROGRESS',
        error: Object.assign(new Error('reader repair stopped'), { code: 'READER_REPAIR_NO_PROGRESS' }),
        stage: 'api-reader',
        cause: /Reader 修复多轮没有进展/,
        commandIncludes: ['npm run api:reader:refresh -- --all --date', '--concurrency 5'],
        docRef: 'docs/reader-explicit-retry.md'
    },
    {
        name: 'READER_OPERATOR_CORRECTION_REJECTED',
        error: Object.assign(new Error('operator correction rejected'), { code: 'READER_OPERATOR_CORRECTION_REJECTED' }),
        stage: 'api-reader',
        cause: /受控人工修正被拒/,
        commandIncludes: ['npm run api:reader:refresh'],
        docRef: 'docs/reader-explicit-retry.md'
    },
    {
        name: '表格粘连复写',
        error: new Error('单元格存在疑似粘连复写“8.7 8.7”，须核对完整原始值与绑定'),
        stage: 'api-reader',
        cause: /表格单元格出现粘连复写/,
        commandIncludes: ['npm run api:reader:refresh', 'npm run blog:generate -- --date'],
        docRef: 'docs/reader-writing.md'
    },
    {
        name: '表格列头单位缺失',
        error: new Error('第 3 个表格的列头单位缺少对应原文证据。'),
        stage: 'api-reader',
        cause: /列头或单位缺少原文证据/,
        commandIncludes: ['npm run api:reader:refresh', 'npm run blog:review -- --date'],
        docRef: 'docs/reader-writing.md'
    },
    {
        name: '消融表缺失',
        error: new Error('全文包含消融实验，但实验结果没有保留关键消融或组件对照'),
        stage: 'api-reader',
        cause: /没有保留关键消融或组件对照/,
        commandIncludes: ['npm run api:reader:refresh'],
        docRef: 'docs/reader-writing.md'
    },
    {
        name: '博客仓库脏状态（未提交改动）',
        error: new Error('博客必须停在基线 HEAD 上且没有未提交改动'),
        stage: 'blog-review',
        cause: /博客仓库工作区不干净/,
        commandIncludes: ['git -C "$PAPER_DIGEST_BLOG_REPO" status --short', 'npm run blog:review -- --date'],
        docRef: 'docs/troubleshooting.md'
    },
    {
        name: '论文锁被占用/等待超时',
        error: new Error('等待文件锁超时: data/.locks/paper-2026.10.12345.lock'),
        stage: 'batch-analyze',
        cause: /论文\/文件锁被其他进程持有/,
        commandIncludes: ['ps -eo pid,etime,command', 'npm run digest:status -- --date'],
        docRef: 'docs/troubleshooting.md'
    },
    {
        name: '来源 SHA 不符',
        error: new Error('分析结果中的论文来源 SHA 与 sourceSha256 不一致： 2026.10.12345'),
        stage: 'deep-analysis',
        cause: /来源文件 SHA 与分析记录不一致/,
        commandIncludes: ['npm run validate:data', 'npm run digest:prepare --'],
        docRef: 'docs/locked-source-validation.md'
    },
    {
        name: '生成快照未刷新',
        error: new Error('博客生成清单无法读取: /tmp/generation/manifest.json'),
        stage: 'blog-push',
        cause: /生成快照\/页面清单未刷新或已过期/,
        commandIncludes: ['npm run blog:generate -- --date', 'npm run blog:review -- --date', 'npm run blog:push -- --date'],
        docRef: 'docs/data-format.md'
    },
    {
        name: '博客仓库/同日期事务锁等待超时',
        error: new Error('等待共享博客仓库锁超时: /tmp/blog-repo.lock'),
        stage: 'blog-push',
        cause: /同日期发布事务正被其他任务持有/,
        commandIncludes: ['ps -eo pid,etime,command', 'npm run blog:push -- --date'],
        docRef: 'docs/troubleshooting.md'
    },
    {
        name: '缺少审查凭证',
        error: new Error('缺少与当前页面字节匹配的审查凭证'),
        stage: 'blog-push',
        cause: /缺少与当前页面字节匹配的审查凭证/,
        commandIncludes: ['npm run blog:review -- --date', 'npm run blog:push -- --date'],
        docRef: 'docs/three-workflows.md'
    }
];

test('表驱动：至少 10 类真实错误都有专用下一步指引', () => {
    assert.ok(CASES.length >= 10, `用例数应不少于 10，实际 ${CASES.length}`);
    for (const item of CASES) {
        const guidance = guidanceFor(item.error, item.stage);
        assert.match(guidance.cause, item.cause, `${item.name} 的 cause 不匹配`);
        assert.equal(typeof guidance.cause, 'string');
        assert.ok(guidance.nextSteps.length >= 2, `${item.name} 的 nextSteps 太少`);
        assert.ok(guidance.commands.length >= 1, `${item.name} 缺少可复制命令`);
        for (const fragment of item.commandIncludes) {
            assert.ok(
                guidance.commands.some(command => command.includes(fragment)),
                `${item.name} 缺少命令片段: ${fragment}\n实际命令: ${JSON.stringify(guidance.commands)}`
            );
        }
        assert.ok(guidance.docRef.startsWith(DOCS), `${item.name} 的 docRef 指向仓库文档`);
        assert.ok(!guidance.cause.includes('未知错误类型'), `${item.name} 落到了通用兜底`);
    }
});

test('未匹配错误给通用兜底，仍保留下一步与可复制命令', () => {
    const guidance = guidanceFor(new Error('totally unexpected pipeline failure'), 'mystery-stage');
    assert.match(guidance.cause, /没有匹配到已知错误类型/);
    assert.ok(guidance.nextSteps.length >= 2);
    assert.ok(guidance.commands.length >= 1);
    assert.equal(guidance.docRef, 'docs/troubleshooting.md');
});

test('兜底对非 Error 输入同样安全（null/字符串/纯对象）', () => {
    for (const value of [null, undefined, 'plain failure text', { foo: 'bar' }]) {
        const guidance = guidanceFor(value, 'fetch');
        assert.equal(typeof guidance.cause, 'string');
        assert.ok(guidance.cause.length > 0);
        assert.ok(Array.isArray(guidance.commands));
    }
});

test('cause 链递归：外层通用错误仍能命中内层专用错误码', () => {
    const inner = Object.assign(new Error('reader repair stopped'), { code: 'READER_REPAIR_NO_PROGRESS' });
    const middle = new Error('batch failed', { cause: inner });
    const outer = new Error('run failed', { cause: middle });
    assert.match(guidanceFor(outer, 'api-reader').cause, /Reader 修复多轮没有进展/);

    const aggregate = new AggregateError([new Error('unrelated'), Object.assign(new Error('x'), { code: 'READER_OPERATOR_CORRECTION_REJECTED' })], 'all failed');
    assert.match(guidanceFor(aggregate, 'api-reader').cause, /受控人工修正被拒/);
});

test('code 链收集有深度上限并容忍循环 cause', () => {
    const first = new Error('a');
    const second = new Error('b', { cause: first });
    first.cause = second;
    const chain = collectErrorChain(first);
    assert.ok(chain.length > 0 && chain.length <= 8);
});

test('错误字段里的日期与 arXiv ID 会进入可复制命令', () => {
    const error = Object.assign(new Error('来源 SHA 不符'), {
        batchDate: '2026-10-21',
        paperId: '2026.10.12345'
    });
    const guidance = guidanceFor(error, 'deep-analysis');
    assert.ok(guidance.commands.includes('npm run digest:prepare -- 2026-10-21'));
    assert.ok(!guidance.commands.some(command => command.includes(DATE_PLACEHOLDER)));
    const undated = guidanceFor(new Error('来源 SHA 不符'), 'deep-analysis');
    assert.ok(undated.commands.some(command => command.includes(DATE_PLACEHOLDER)));
    assert.ok(undated.nextSteps.some(step => step.includes(DATE_PLACEHOLDER) && step.includes('YYYY-MM-DD')),
        '无日期时必须说明 <DATE> 占位要替换成批次日期');
});

test('命令可按 entrypoint 阶段恢复，且不含换行/未定义值', () => {
    for (const item of CASES) {
        const guidance = guidanceFor(item.error, item.stage);
        for (const command of guidance.commands) {
            assert.equal(typeof command, 'string');
            assert.ok(command.trim().length > 0);
            assert.ok(!/[\r\n]/.test(command), '命令应是单行可直接复制');
            assert.ok(!command.includes('undefined'), `命令含 undefined: ${command}`);
            assert.ok(!command.includes('{{'), `命令含模板占位: ${command}`);
        }
    }
    const pushStage = guidanceFor(new Error('博客仓库有未提交改动'), 'blog-push');
    assert.ok(pushStage.commands.some(command => command.startsWith('npm run blog:push -- --date')));
    const generateStage = guidanceFor(new Error('博客仓库有未提交改动'), 'blog-generate');
    assert.ok(generateStage.commands.some(command => command.startsWith('npm run blog:generate -- --date')));
});

test('不泄露 secret：错误文本中的密钥、令牌、口令不会进入指引', () => {
    const secrets = [
        'sk-live-ABCdef123456789',
        'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
        'api_key=SUPER_SECRET_VALUE',
        'https://user:pass@example.com/v1'
    ];
    const known = Object.assign(new Error(`arXiv 429 抓取失败 ${secrets.join(' ')}`), { code: 'ARXIV_RATE_LIMITED' });
    const unknown = new Error(`未分类故障 ${secrets.join(' ')}`);
    for (const error of [known, unknown]) {
        const serialized = JSON.stringify(guidanceFor(error, 'fetch'));
        for (const secret of secrets) {
            assert.ok(!serialized.includes(secret), `指引泄露了 secret: ${secret}`);
        }
        assert.ok(!/sk-live-|Bearer\s+eyJ|SUPER_SECRET_VALUE|user:pass@/.test(serialized));
    }
    assert.equal(redactSensitive('sk-live-ABCdef123456789'), '[已隐藏敏感信息]');
});

test('结果结构固定为 cause/nextSteps/commands/docRef，且不修改原错误', () => {
    const error = Object.assign(new Error('读稿停止'), { code: 'READER_REPAIR_NO_PROGRESS' });
    const snapshot = { code: error.code, message: error.message };
    const guidance = guidanceFor(error, 'api-reader');
    assert.deepEqual(Object.keys(guidance).sort(), ['cause', 'commands', 'docRef', 'nextSteps']);
    assert.ok(guidance.nextSteps.every(step => typeof step === 'string' && step.length > 0));
    assert.ok(guidance.commands.every(command => typeof command === 'string'));
    assert.deepEqual({ code: error.code, message: error.message }, snapshot);
});

test('printErrorGuidance 在原始错误之后追加 [下一步] 且返回同一份指引', () => {
    const lines = [];
    const logger = { error: line => lines.push(line) };
    const error = new Error('waiting for paper lock: 等待文件锁超时');
    const guidance = printErrorGuidance(error, { stage: 'reanalyze', logger });
    assert.deepEqual(guidance, guidanceFor(error, 'reanalyze'));
    assert.ok(lines.length >= 3);
    assert.ok(lines.every(line => line.startsWith('[下一步]')));
    assert.ok(lines[0].startsWith('[下一步] 原因：'));
    assert.ok(lines.some(line => line.startsWith('[下一步] 可复制命令：')));
    assert.ok(lines.some(line => line.startsWith('[下一步] 参考：')));
    assert.deepEqual(formatGuidanceLines(guidance), lines);
});

test('printErrorGuidance 对非法输入不抛出，也不吞掉原错误对象', () => {
    const lines = [];
    const originalError = console.error;
    console.error = line => lines.push(String(line));
    try {
        assert.doesNotThrow(() => printErrorGuidance(null, {}));
        assert.doesNotThrow(() => printErrorGuidance(undefined));
        assert.doesNotThrow(() => printErrorGuidance('plain text', { stage: 'x' }));
    } finally {
        console.error = originalError;
    }
    assert.ok(lines.length > 0);
});

test('默认 logger 使用 console.error 写 stderr，而不是 stdout', () => {
    const errors = [];
    const logs = [];
    const originalError = console.error;
    const originalLog = console.log;
    console.error = line => errors.push(String(line));
    console.log = line => logs.push(String(line));
    try {
        printErrorGuidance(new Error('boom'), { stage: 'fetch' });
    } finally {
        console.error = originalError;
        console.log = originalLog;
    }
    assert.ok(errors.length > 0);
    assert.deepEqual(logs, []);
});


test('429/401 只在专属信号下命中专用规则（负例）', () => {
    assert.equal(ruleIdFor({ status: 429, message: 'upstream busy' }, 'api-reader'), 'upstream-rate-limit');
    assert.equal(ruleIdFor({ status: 429, message: '论文来源刷新限流' }, 'fetch'), 'upstream-rate-limit');
    assert.equal(ruleIdFor({ status: 401, message: 'upstream rejected the request' }, 'fetch'), 'generic-fallback');
    assert.equal(ruleIdFor({ code: 'ARXIV_RATE_LIMITED', message: 'Too Many Requests' }, 'fetch'), 'arxiv-rate-limit');
    assert.equal(ruleIdFor({ status: 401, message: 'Insufficient balance' }, 'fetch'), 'llm-account-pool');
    // 泛词（fetch/html/pdf/来源）不再被当成 arXiv 专属信号。
    for (const message of ['fetch failed 429', 'html 429', 'pdf download 429', '来源 429']) {
        assert.equal(ruleIdFor({ status: 429, message }, 'fetch'), 'upstream-rate-limit', message);
    }
});

test('状态键两语言统一：status/statusCode/status_code/httpStatus/http_status/errno/code', () => {
    for (const key of ['status', 'statusCode', 'status_code', 'httpStatus', 'http_status', 'errno', 'code']) {
        const error = { message: 'request failed', [key]: 429 };
        assert.equal(ruleIdFor(error, 'fetch'), 'upstream-rate-limit', key);
        const unauthorized = { message: 'Insufficient balance', [key]: 401 };
        assert.equal(ruleIdFor(unauthorized, 'fetch'), 'llm-account-pool', key);
    }
});

test('匹配文本不拼接整条 stack，路径里的 arXiv 不会误报', () => {
    const error = new Error('plain upstream failure');
    error.stack = 'Error: plain upstream failure\n    at fetchHtml (/srv/arxiv.org/fetch-paper.js:1:1)';
    assert.equal(ruleIdFor(error, 'fetch'), 'generic-fallback');
    assert.equal(ruleIdFor({ status: 429, message: 'plain', stack: 'at /srv/arxiv.org/x.js' }, 'fetch'), 'upstream-rate-limit');
});

test('Reader 阶段 429 给 Reader 恢复命令，抓取阶段才给抓取命令', () => {
    const readerError = { status: 429, message: 'arxiv.org HTML 429' };
    assert.ok(guidanceFor(readerError, 'api-reader').commands.some(c => c.startsWith('npm run api:reader:refresh -- --all --date')));
    assert.ok(guidanceFor(readerError, 'fetch').commands.some(c => c.startsWith('npm run fetch -- --date')));
    const plain429 = { status: 429, message: 'busy' };
    assert.ok(guidanceFor(plain429, 'api-reader').commands.some(c => c.startsWith('npm run api:reader:refresh -- --all --date')));
    assert.ok(guidanceFor(plain429, 'deep-analysis').commands.some(c => c.startsWith('npm run deep -- --date')));
});

test('source-sha-mismatch 指向 data-format 的真实来源校验章节', () => {
    const guidance = guidanceFor({ message: '来源 SHA 与 sourceSha256 不一致' }, 'deep-analysis');
    assert.equal(guidance.docRef, 'docs/data-format.md#日更来源的保存与核验');
});

// 两语言必须映射到同一组规则 id；Python 测试用同一份 fixtures 断言。
const RULE_ID_FIXTURES = [
    ['llm-account-pool', { status: 401, message: 'Insufficient balance' }, 'fetch'],
    ['official-oai-rss-stale', { message: 'OAI responseDate is stale or invalid for the fixed batch boundary' }, 'fetch'],
    ['arxiv-rate-limit', { code: 'ARXIV_RATE_LIMITED', message: 'Too Many Requests' }, 'fetch'],
    ['reader-repair-no-progress', { code: 'READER_REPAIR_NO_PROGRESS', message: 'stopped' }, 'api-reader'],
    ['reader-operator-correction-rejected', { code: 'READER_OPERATOR_CORRECTION_REJECTED', message: 'x' }, 'api-reader'],
    ['reader-table-adhesion', { message: '单元格存在疑似粘连复写，表格核对' }, 'api-reader'],
    ['reader-table-header-units', { message: '第 3 个表格的列头单位缺少对应原文证据。' }, 'api-reader'],
    ['reader-table-ablation-missing', { message: '全文包含消融实验，但实验结果没有保留关键消融或组件对照' }, 'api-reader'],
    ['blog-repository-dirty', { message: '博客必须停在基线 HEAD 上且没有未提交改动' }, 'blog-review'],
    ['blog-lock-busy', { message: '等待共享博客仓库锁超时: /tmp/lock' }, 'blog-push'],
    ['paper-lock-busy', { message: '等待文件锁超时: data/.locks/paper.lock' }, 'batch-analyze'],
    ['source-sha-mismatch', { message: '分析结果中的论文来源 SHA 与 sourceSha256 不一致' }, 'deep-analysis'],
    ['generation-snapshot-stale', { message: '博客生成清单无法读取: /tmp/manifest.json' }, 'blog-push'],
    ['blog-review-receipt-missing', { message: '缺少与当前页面字节匹配的审查凭证' }, 'blog-push'],
    ['upstream-rate-limit', { status: 429, message: 'busy' }, 'api-reader'],
    ['generic-fallback', { message: '完全未知的故障' }, 'fetch']
];

test('两语言规则 id 一致：fixtures 映射到固定规则 id', () => {
    for (const [expected, error, stage] of RULE_ID_FIXTURES) {
        assert.equal(ruleIdFor(error, stage), expected, `${expected} 映射错误`);
        const guidance = guidanceFor(error, stage);
        assert.ok(guidance.cause && guidance.commands.length > 0);
    }
});

test('入口静态接线：指引只在 catch 内、摘要带批次日期与耗时、错误摘要先脱敏', () => {
    for (const relative of ENTRY_FILES) {
        const source = fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');
        const isPython = relative.endsWith('.py');
        const guidanceName = isPython ? 'print_error_guidance' : 'printErrorGuidance';
        const summaryName = isPython ? 'write_stage_summary' : 'writeStageSummary';
        const redactName = isPython ? 'redact_sensitive' : 'redactSensitive';
        assert.ok(source.includes(summaryName), `${relative} 未接入阶段摘要`);
        assert.ok(source.includes(guidanceName), `${relative} 未接入错误指引`);
        let index = source.indexOf(guidanceName);
        let count = 0;
        while (index !== -1) {
            const lineStart = source.lastIndexOf('\n', index) + 1;
            const lineEnd = source.indexOf('\n', index);
            const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
            const isImport = line.includes('require(') || line.startsWith('from ') || line.startsWith('import ');
            if (!isImport) {
                count += 1;
                const window = source.slice(Math.max(0, index - 900), index);
                const inHandler = isPython ? /except[\s\S]*$/.test(window) : /catch[\s\S]*$/.test(window);
                // 入口级参数校验失败也允许：指引后必须立即以原退出码退出或重新抛出。
                const exitsAfter = /(process\.exit\(|sys\.exit\(|raise\b)/.test(source.slice(index, index + 500));
                assert.ok(inHandler || exitsAfter,
                    `${relative} 的指引必须写在 catch/except 内或紧随原退出码退出（成功路径不得打印）`);
            }
            index = source.indexOf(guidanceName, index + 1);
        }
        assert.ok(count >= 1);
        if (relative !== 'scripts/generate-blog.py') {
            assert.ok(source.includes(isPython ? 'date=date_str' : 'date:'), `${relative} 摘要未传批次日期`);
        }
        assert.ok(source.includes(redactName), `${relative} 错误摘要未先脱敏`);
        assert.ok(source.includes(isPython ? 'elapsed_ms=' : 'elapsedMs:'), `${relative} 摘要缺少耗时`);
    }
});

test('generate-blog.py 的 SystemExit(0) 不写成失败摘要或兜底指引', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../scripts/generate-blog.py'), 'utf8');
    assert.match(source, /if code == 0:/);
    assert.match(source, /write_stage_summary\('生成', 'ok', '生成结束（退出码 0）'/);
    assert.match(source, /else:\n\s+write_stage_summary\('生成', 'error'/);
    assert.match(source, /else:\n\s+write_stage_summary\('生成', 'error'[\s\S]{0,200}print_error_guidance/);
});

test('入口 refresh-api-reader：失败保留原错误与退出码，摘要脱敏，随后追加 [下一步]', () => {
    const SECRET = 'sk-live-ENTRY-SECRET-123456';
    const filename = path.resolve(__dirname, '../scripts/refresh-api-reader.js');
    const source = fs.readFileSync(filename, 'utf8').replace(/^#![^\n]*\n/, '');
    const summaries = [];
    const printed = [];
    const failure = Object.assign(new Error(`arXiv 429 抓取失败 ${SECRET}`), { status_code: 429 });
    const modules = {
        './log-setup': { writeStageSummary: options => { summaries.push(options); return { line: 'stub', status: options.status }; } },
        './lib/error-guidance.js': require('../scripts/lib/error-guidance.js'),
        './config.js': { FILES: { deepAnalysisResult: 'no-file' } },
        './deep-analyzer.js': {},
        './analysis-engine.js': { readJsonFileStrict: () => { throw failure; } },
        './lib/daily-fresh-source-plan.js': {},
        './lib/reader-tables.js': {},
        './digest-status.js': {},
        './utils.js': { normalizedId: value => value, getBeijingISOString: () => '2026-10-21T00:00:00.000Z' },
        './lib/analysis-failure-rounds.js': require('../scripts/lib/analysis-failure-rounds.js'),
        './lib/analysis-batch-report.js': { writeAnalysisBatchReport: () => null },
        './lib/analysis-stop-control': { withAnalysisStopControl: fn => fn() }
    };
    const entryModule = { exports: {} };
    const localRequire = name => {
        if (Object.hasOwn(modules, name)) return modules[name];
        if (name.startsWith('node:')) return require(name);
        throw new Error(`未预期的依赖：${name}`);
    };
    localRequire.main = entryModule;
    const originalError = console.error;
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    console.error = line => printed.push(String(line));
    process.argv = ['node', 'refresh-api-reader.js', '--all', '--date', '2026-10-21'];
    try {
        new vm.Script(`(function(require,module,exports){${source}\n})`, { filename })
            .runInThisContext()(localRequire, entryModule, entryModule.exports);
        assert.equal(process.exitCode, 1, '失败必须保持原退出码 1');
        assert.ok(printed.some(line => line.includes(failure.message)), '原始错误必须照常打印，不得被指引替换');
        const guidance = printed.filter(line => line.includes('[下一步]'));
        assert.ok(guidance.length >= 3, '失败后必须追加 [下一步] 指引');
        assert.ok(guidance.some(line => line.includes('npm run api:reader:refresh')), 'Reader 阶段应给 Reader 恢复命令');
        assert.ok(summaries.length >= 1, '入口必须写阶段摘要');
        assert.equal(summaries[0].status, 'error');
        assert.equal(summaries[0].date, '2026-10-21');
        assert.ok(!summaries.some(item => String(item.message).includes(SECRET)), '摘要不得包含 secret');
    } finally {
        console.error = originalError;
        process.argv = originalArgv;
        process.exitCode = originalExitCode;
    }
});
