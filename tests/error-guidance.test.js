const test = require('node:test');
const assert = require('node:assert/strict');
const {
    guidanceFor,
    printErrorGuidance,
    redactSensitive,
    collectErrorChain,
    formatGuidanceLines
} = require('../scripts/lib/error-guidance.js');

const DOCS = 'docs/';

// 表驱动：每个真实事故类型都必须命中专用指引，不能落到通用兜底。
const CASES = [
    {
        name: 'arXiv 429 限流',
        error: Object.assign(new Error('Too Many Requests'), { code: 'ARXIV_RATE_LIMITED', status: 429 }),
        stage: 'fetch',
        cause: /arXiv 或外部来源限流/,
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
    // docRef 与命令都不允许出现占位符未替换的错误。
    assert.ok(!guidance.commands.some(command => command.includes('YYYY-MM-DD')));
    assert.match(guidanceFor(new Error('来源 SHA 不符'), 'deep-analysis').commands.join('\n'), /YYYY-MM-DD/);
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
