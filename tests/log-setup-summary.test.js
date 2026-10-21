const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { writeStageSummary, setupScriptLogging } = require('../scripts/log-setup.js');

const ROOT = path.resolve(__dirname, '..');
// 北京时间 2026-10-21 21:10:00，固定时间戳便于锁住完整行格式。
const BEIJING_NOW = new Date('2026-10-21T13:10:00.000Z');

function createRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-stage-summary-'));
}

function readLines(filePath) {
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(line => line !== '');
}

function writeFor(root, options) {
    return writeStageSummary({
        stage: '默认',
        status: 'ok',
        message: '消息',
        date: '2026-10-21',
        now: BEIJING_NOW,
        logsDir: path.join(root, 'summaries'),
        ...options
    });
}

describe('阶段摘要日志', () => {
    it('按固定格式写入当天文件，同日多次只追加不覆盖', () => {
        const root = createRoot();
        const logsDir = path.join(root, 'logs', 'summaries');
        try {
            const first = writeStageSummary({
                stage: '3/6 筛选',
                status: 'ok',
                message: '662→34 篇',
                elapsedMs: 95000,
                date: '2026-10-21',
                now: BEIJING_NOW,
                extra: '说明',
                logsDir
            });
            assert.ok(first, '写入成功应返回结果');
            assert.strictEqual(first.filePath, path.join(logsDir, '2026-10-21-summary.log'));
            assert.strictEqual(first.status, 'ok');

            const second = writeStageSummary({
                stage: '1/6 抓取',
                status: 'start',
                message: '抓取候选',
                date: '2026-10-21',
                now: BEIJING_NOW,
                logsDir
            });
            assert.ok(second);

            const filePath = first.filePath;
            assert.deepStrictEqual(readLines(filePath), [
                '[2026-10-21 21:10:00] [阶段 3/6 筛选] 完成 662→34 篇 用时 95s 说明',
                '[2026-10-21 21:10:00] [阶段 1/6 抓取] 开始 抓取候选'
            ]);
            assert.ok(fs.readFileSync(filePath, 'utf8').endsWith('\n'), '每行以换行结尾');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('没有传 date 时按注入的北京时间推导文件名', () => {
        const root = createRoot();
        const logsDir = path.join(root, 'summaries');
        try {
            const result = writeStageSummary({
                stage: '默认日期',
                status: 'ok',
                message: '推导日期',
                now: BEIJING_NOW,
                logsDir
            });
            assert.ok(result);
            assert.strictEqual(path.basename(result.filePath), '2026-10-21-summary.log');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('status 仅接受 start/ok/warn/error，非法值按 error 记录并提示', t => {
        const root = createRoot();
        const logsDir = path.join(root, 'summaries');
        const warnings = [];
        t.mock.method(console, 'warn', message => warnings.push(String(message)));
        try {
            const labels = [['start', '开始'], ['ok', '完成'], ['warn', '注意'], ['error', '失败']];
            for (const [status] of labels) {
                writeStageSummary({
                    stage: '状态校验',
                    status,
                    message: status,
                    date: '2026-10-21',
                    now: BEIJING_NOW,
                    logsDir
                });
            }
            assert.deepStrictEqual(warnings, [], '合法 status 不提示');

            const invalid = writeStageSummary({
                stage: '状态校验',
                status: 'done',
                message: '非法状态',
                date: '2026-10-21',
                now: BEIJING_NOW,
                logsDir
            });
            assert.strictEqual(invalid.status, 'error');
            assert.strictEqual(warnings.length, 1);
            assert.match(warnings[0], /status 非法/);
            assert.match(warnings[0], /按 error 处理/);

            const lines = readLines(path.join(logsDir, '2026-10-21-summary.log'));
            assert.strictEqual(lines.length, 5);
            labels.forEach(([, label], index) => {
                assert.match(lines[index], new RegExp(`\\] ${label} `));
            });
            assert.match(lines[4], /\] 失败 非法状态$/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('脱敏 oc_sk_、Bearer、api_key= 和 sk- 形态的密钥', () => {
        const root = createRoot();
        const logsDir = path.join(root, 'summaries');
        try {
            writeStageSummary({
                stage: '脱敏',
                status: 'warn',
                message: '认证失败 Authorization: Bearer eyJhbGciOi.payload '
                    + 'oc_sk_deadbeef api_key=plain-value sk-live-key-123 继续',
                date: '2026-10-21',
                now: BEIJING_NOW,
                logsDir
            });
            const content = fs.readFileSync(
                path.join(logsDir, '2026-10-21-summary.log'),
                'utf8'
            );
            for (const secret of ['eyJhbGciOi', 'deadbeef', 'plain-value', 'live-key-123']) {
                assert.ok(!content.includes(secret), `未脱敏: ${secret}`);
            }
            assert.match(content, /api_key=\[REDACTED\]/);
            assert.ok((content.match(/\[REDACTED\]/g) || []).length >= 4);
            assert.match(content, /继续/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('与文件日志同形的凭证形态都脱敏，oc_sk_ 不区分大小写', () => {
        const root = createRoot();
        try {
            const result = writeFor(root, {
                stage: '凭证形态',
                message: 'proxy=https://alice:password@example.com/path '
                    + 'Authorization: Basic dXNlcjpwYXNz '
                    + 'x-api-key: x-key-value '
                    + 'Cookie: session=cookie-value '
                    + 'token=token-value '
                    + 'password: password-value '
                    + 'OC_SK_deadbeef '
                    + 'SK-super-short '
                    + '继续'
            });
            assert.ok(result);
            const content = fs.readFileSync(result.filePath, 'utf8');
            for (const secret of [
                'alice:password', 'dXNlcjpwYXNz', 'x-key-value', 'cookie-value',
                'token-value', 'password-value', 'deadbeef', 'super-short'
            ]) {
                assert.ok(!content.includes(secret), `未脱敏: ${secret}`);
            }
            assert.match(content, /https:\/\/\[REDACTED\]@example\.com\/path/);
            assert.match(content, /Authorization: \[REDACTED\]/);
            assert.match(content, /x-api-key: \[REDACTED\]/);
            assert.match(content, /Cookie: \[REDACTED\]/);
            assert.match(content, /token=\[REDACTED\]/);
            assert.match(content, /password: \[REDACTED\]/);
            assert.match(content, /继续/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('脱敏 configuredSecrets 与动态收集的环境密钥', () => {
        const root = createRoot();
        const envPath = path.join(root, '.env');
        const logsDir = path.join(root, 'summaries');
        const previousDynamic = process.env.PD_SUMMARY_DYN_TOKEN;
        try {
            fs.writeFileSync(envPath, 'PD_SUMMARY_CFG_TOKEN=cfg-secret-value\n', 'utf8');
            setupScriptLogging(null, { envFile: envPath });
            // configuredSecrets 已经记住值；删掉环境变量，确保这条只靠它脱敏。
            delete process.env.PD_SUMMARY_CFG_TOKEN;
            process.env.PD_SUMMARY_DYN_TOKEN = 'dyn-secret-value';

            const result = writeStageSummary({
                stage: '密钥来源',
                status: 'ok',
                message: '配置密钥 cfg-secret-value 与环境密钥 dyn-secret-value 结束',
                date: '2026-10-21',
                now: BEIJING_NOW,
                logsDir
            });
            assert.ok(result);
            const content = fs.readFileSync(result.filePath, 'utf8');
            assert.ok(!content.includes('cfg-secret-value'), 'configuredSecrets 未脱敏');
            assert.ok(!content.includes('dyn-secret-value'), '动态环境密钥未脱敏');
            assert.strictEqual((content.match(/\[REDACTED\]/g) || []).length, 2);
            assert.match(content, /结束/);
        } finally {
            if (previousDynamic === undefined) delete process.env.PD_SUMMARY_DYN_TOKEN;
            else process.env.PD_SUMMARY_DYN_TOKEN = previousDynamic;
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('剥离 ANSI 与控制/行分隔字符，保持单行', () => {
        const root = createRoot();
        try {
            const result = writeFor(root, {
                stage: '控制字符',
                message: '前\x1b[31m红色\x1b[0m\u2028后\u2029a\u0085b\x0bc\x0cd\x1ce\n换行',
                extra: '尾\x1b[0m'
            });
            assert.ok(result);
            const content = fs.readFileSync(result.filePath, 'utf8');
            assert.strictEqual(readLines(result.filePath).length, 1, '仍然是单行');
            assert.ok(!content.includes('\x1b'), '不能留下 ESC');
            for (const separator of ['\u2028', '\u2029', '\u0085', '\x0b', '\x0c', '\x1c', '\x1d', '\x1e']) {
                assert.ok(!content.includes(separator), `不能留下分隔字符 ${JSON.stringify(separator)}`);
            }
            assert.match(content, /前红色后abcde 换行/);
            assert.match(content, /尾\n$/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('now/date 注入：数字时间戳可用，非法日历日期回退到注入日期', () => {
        const root = createRoot();
        try {
            const numeric = writeFor(root, {
                stage: '时间注入',
                now: BEIJING_NOW.getTime()
            });
            assert.strictEqual(numeric.line, '[2026-10-21 21:10:00] [阶段 时间注入] 完成 消息');

            const invalidDate = writeFor(root, { stage: '非法日期', date: '2026-13-99' });
            assert.strictEqual(path.basename(invalidDate.filePath), '2026-10-21-summary.log');
            assert.ok(invalidDate.line.startsWith('[2026-10-21 21:10:00]'));

            const looseDate = writeFor(root, { stage: '宽松日期', date: '2026-10-21T00:00:00Z' });
            assert.strictEqual(path.basename(looseDate.filePath), '2026-10-21-summary.log');

            const dateObject = writeFor(root, {
                stage: '日期对象',
                date: new Date('2026-10-20T13:10:00.000Z')
            });
            assert.strictEqual(path.basename(dateObject.filePath), '2026-10-20-summary.log');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('elapsed 先 trim、拒绝十六进制/空白/科学计数，接受十进制数字串', () => {
        const root = createRoot();
        const logsDir = path.join(root, 'summaries');
        const cases = [
            [' 95000 ', ' 用时 95s'],
            ['95000', ' 用时 95s'],
            ['95500', ' 用时 95.5s'],
            ['0x10', ''],
            ['1e3', ''],
            ['', ''],
            ['   ', ''],
            [95000, ' 用时 95s'],
            [NaN, ''],
            [-1, '']
        ];
        try {
            cases.forEach(([elapsedMs], index) => {
                writeStageSummary({
                    stage: '用时校验',
                    status: 'ok',
                    message: `用例${index}`,
                    elapsedMs,
                    date: '2026-10-21',
                    now: BEIJING_NOW,
                    logsDir
                });
            });
            const lines = readLines(path.join(logsDir, '2026-10-21-summary.log'));
            assert.strictEqual(lines.length, cases.length);
            cases.forEach(([, suffix], index) => {
                assert.ok(lines[index].endsWith(`用例${index}${suffix}`), `用例 ${index} 不符: ${lines[index]}`);
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('数字 extra 使用统一的跨语言格式', () => {
        const root = createRoot();
        const logsDir = path.join(root, 'summaries');
        try {
            const cases = [
                [1e-7, '1e-7'],
                [1e21, '1e+21'],
                [1, '1'],
                [1.5, '1.5'],
                [0.1, '0.1'],
                [{ count: 1, ratio: 1e-7, big: 1e21, label: '中文' },
                    '{"count":1,"ratio":1e-7,"big":1e+21,"label":"中文"}']
            ];
            cases.forEach(([extra], index) => {
                writeStageSummary({
                    stage: '数字格式',
                    status: 'ok',
                    message: `用例${index}`,
                    date: '2026-10-21',
                    now: BEIJING_NOW,
                    extra,
                    logsDir
                });
            });
            const lines = readLines(path.join(logsDir, '2026-10-21-summary.log'));
            cases.forEach(([, suffix], index) => {
                assert.ok(lines[index].endsWith(`用例${index} ${suffix}`), `数字格式不符: ${lines[index]}`);
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('message 超过 500 字符时截断到 500 个字符', () => {
        const root = createRoot();
        const logsDir = path.join(root, 'summaries');
        try {
            writeStageSummary({
                stage: '截断',
                status: 'ok',
                message: '长'.repeat(600),
                date: '2026-10-21',
                now: BEIJING_NOW,
                logsDir
            });
            const [line] = readLines(path.join(logsDir, '2026-10-21-summary.log'));
            assert.strictEqual(
                line,
                `[2026-10-21 21:10:00] [阶段 截断] 完成 ${'长'.repeat(499)}…`
            );
            const messagePart = line.slice(line.indexOf('] 完成 ') + '] 完成 '.length);
            assert.strictEqual(Array.from(messagePart).length, 500);
            assert.ok(messagePart.endsWith('…'));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('超长 message 先截断原始输入再脱敏', () => {
        const root = createRoot();
        try {
            const result = writeFor(root, {
                stage: '超长输入',
                message: `oc_sk_verylongsecretvalue ${'长'.repeat(30000)} 尾部`
            });
            assert.ok(result);
            const [line] = readLines(result.filePath);
            const messagePart = line.slice(line.indexOf('] 完成 ') + '] 完成 '.length);
            assert.strictEqual(Array.from(messagePart).length, 500);
            assert.ok(!line.includes('verylongsecretvalue'), '开头密钥仍要脱敏');
            assert.match(messagePart, /^\[REDACTED\] 长/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('POSIX 下把目录收紧为 0700、文件收紧为 0600', t => {
        if (process.platform === 'win32') return t.skip('POSIX 权限语义仅在 POSIX 上可断言');
        const root = createRoot();
        const logsDir = path.join(root, 'logs', 'summaries');
        try {
            fs.mkdirSync(logsDir, { recursive: true, mode: 0o755 });
            const filePath = path.join(logsDir, '2026-10-21-summary.log');
            fs.writeFileSync(filePath, '', 'utf8');
            fs.chmodSync(logsDir, 0o755);
            fs.chmodSync(filePath, 0o644);

            const result = writeStageSummary({
                stage: '权限',
                status: 'ok',
                message: '收紧权限',
                date: '2026-10-21',
                now: BEIJING_NOW,
                logsDir
            });
            assert.ok(result);
            assert.strictEqual(result.permissionsTightened, true);
            assert.strictEqual(fs.statSync(logsDir).mode & 0o777, 0o700);
            assert.strictEqual(fs.statSync(filePath).mode & 0o777, 0o600);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('测试上下文未显式传 logsDir 时不写真实日志目录', () => {
        const result = writeStageSummary({
            stage: '守卫',
            status: 'ok',
            message: '不应落盘',
            date: '1999-01-01',
            now: BEIJING_NOW
        });
        assert.strictEqual(result, null);
        assert.ok(
            !fs.existsSync(path.join(ROOT, 'logs', 'summaries', '1999-01-01-summary.log')),
            '测试上下文不应写入真实 logs/summaries'
        );
    });

    it('拒绝符号链接的摘要目录与摘要文件', t => {
        if (process.platform === 'win32') return t.skip('符号链接语义仅在 POSIX 上可断言');
        const root = createRoot();
        const warnings = [];
        t.mock.method(console, 'warn', message => warnings.push(String(message)));
        try {
            const target = path.join(root, 'target');
            fs.mkdirSync(target);
            const linkDir = path.join(root, 'link-summaries');
            fs.symlinkSync(target, linkDir, 'dir');
            const dirResult = writeStageSummary({
                stage: '符号链接',
                status: 'ok',
                message: '目录',
                date: '2026-10-21',
                now: BEIJING_NOW,
                logsDir: linkDir
            });
            assert.strictEqual(dirResult, null);
            assert.match(warnings[0], /符号链接/);
            assert.deepStrictEqual(fs.readdirSync(target), [], '符号链接目录里不能落文件');

            const realDir = path.join(root, 'real');
            fs.mkdirSync(realDir);
            const realFile = path.join(root, 'real-target.log');
            fs.writeFileSync(realFile, '', 'utf8');
            const linkFile = path.join(realDir, '2026-10-21-summary.log');
            fs.symlinkSync(realFile, linkFile, 'file');
            const fileResult = writeStageSummary({
                stage: '符号链接',
                status: 'ok',
                message: '文件',
                date: '2026-10-21',
                now: BEIJING_NOW,
                logsDir: realDir
            });
            assert.strictEqual(fileResult, null);
            assert.match(warnings[1], /符号链接/);
            assert.strictEqual(fs.readFileSync(realFile, 'utf8'), '', '不能透过符号链接写文件');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('目录创建失败只提示警告，不向业务层抛错', t => {
        const root = createRoot();
        const warnings = [];
        t.mock.method(console, 'warn', message => warnings.push(String(message)));
        try {
            const blocker = path.join(root, 'blocker');
            fs.writeFileSync(blocker, '不是目录', 'utf8');
            const result = writeStageSummary({
                stage: '写入失败',
                status: 'error',
                message: '目录不可用',
                date: '2026-10-21',
                now: BEIJING_NOW,
                logsDir: path.join(blocker, 'summaries')
            });
            assert.strictEqual(result, null);
            assert.strictEqual(warnings.length, 1);
            assert.match(warnings[0], /阶段摘要写入失败/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('追加写入抛错时同样降级为 console.warn', t => {
        const root = createRoot();
        const logsDir = path.join(root, 'summaries');
        const warnings = [];
        t.mock.method(console, 'warn', message => warnings.push(String(message)));
        t.mock.method(fs, 'openSync', () => {
            throw Object.assign(new Error('模拟追加失败：oc_sk_leaked-value'), { code: 'EACCES' });
        });
        try {
            const result = writeStageSummary({
                stage: '写入失败',
                status: 'warn',
                message: '追加异常',
                date: '2026-10-21',
                now: BEIJING_NOW,
                logsDir
            });
            assert.strictEqual(result, null);
            assert.strictEqual(warnings.length, 1);
            assert.match(warnings[0], /阶段摘要写入失败/);
            assert.ok(!warnings[0].includes('leaked-value'), '警告里的密钥也要脱敏');
            assert.match(warnings[0], /\[REDACTED\]/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('多进程并发追加同一文件不互相覆盖', async () => {
        const root = createRoot();
        const logsDir = path.join(root, 'summaries');
        const code = [
            "const { writeStageSummary } = require('./scripts/log-setup.js');",
            'writeStageSummary({',
            "    stage: '并发', status: 'ok', message: process.argv[1],",
            "    date: '2026-10-21', now: new Date('2026-10-21T13:10:00.000Z'),",
            '    logsDir: process.argv[2]',
            '});'
        ].join('\n');
        try {
            const children = Array.from({ length: 6 }, (_, index) => new Promise((resolve, reject) => {
                const child = spawn(process.execPath, ['-e', code, `消息-${index}`, logsDir], {
                    cwd: ROOT,
                    env: process.env,
                    stdio: ['ignore', 'ignore', 'pipe']
                });
                let stderr = '';
                child.stderr.on('data', chunk => { stderr += String(chunk); });
                child.on('error', reject);
                child.on('close', exitCode => {
                    if (exitCode === 0) resolve();
                    else reject(new Error(`并发子进程失败 ${exitCode}: ${stderr}`));
                });
            }));
            await Promise.all(children);
            const lines = readLines(path.join(logsDir, '2026-10-21-summary.log'));
            assert.strictEqual(lines.length, 6);
            const messages = new Set();
            for (const line of lines) {
                const match = /^\[2026-10-21 21:10:00\] \[阶段 并发\] 完成 (消息-\d)$/.exec(line);
                assert.ok(match, `行格式被破坏: ${line}`);
                messages.add(match[1]);
            }
            assert.deepStrictEqual(
                [...messages].sort(),
                Array.from({ length: 6 }, (_, index) => `消息-${index}`).sort()
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('Node 与 Python 写出的文件逐字节一致', t => {
        const root = createRoot();
        const scenarios = [
            {
                stage: '跨语言 阶段',
                status: 'ok',
                message: '认证 Authorization: Bearer tok.en 与 oc_sk_ABC9 api_key=v1 结束',
                elapsedMs: 95500,
                date: '2026-10-21',
                extra: { count: 1, ratio: 1e-7, big: 1e21, label: '中文' },
                now: BEIJING_NOW
            },
            {
                stage: '跨语言2',
                status: 'warn',
                message: '重复'.repeat(100),
                elapsedMs: '0x10',
                date: '2026-13-99',
                extra: 1e-7,
                now: BEIJING_NOW.getTime()
            },
            {
                stage: '跨语言3',
                status: 'done',
                message: '非法状态与宽松日期',
                elapsedMs: ' 95000 ',
                date: '2026-10-21T00:00:00Z',
                extra: 'x\u2028y',
                now: '2026-10-21T13:10:00.000Z'
            }
        ];
        const pythonCode = [
            'import json, sys',
            "sys.path.insert(0, 'scripts')",
            'import log_setup',
            'payload = json.loads(sys.stdin.read())',
            'log_setup.write_stage_summary(',
            "    payload['stage'], payload['status'], payload['message'],",
            "    elapsed_ms=payload['elapsedMs'], date=payload['date'], extra=payload['extra'],",
            '    logs_dir=sys.argv[1], now=payload[\'now\'])'
        ].join('\n');
        try {
            scenarios.forEach((scenario, index) => {
                const nodeDir = path.join(root, `node-${index}`);
                const pythonDir = path.join(root, `python-${index}`);
                const nodeResult = writeStageSummary({ ...scenario, logsDir: nodeDir });
                assert.ok(nodeResult, `场景 ${index} Node 写入失败`);

                const payload = {
                    ...scenario,
                    now: scenario.now instanceof Date
                        ? scenario.now.toISOString()
                        : scenario.now
                };
                const run = spawnSync(
                    'bash',
                    ['scripts/python-runtime.sh', '-c', pythonCode, pythonDir],
                    { cwd: ROOT, env: process.env, encoding: 'utf8', input: JSON.stringify(payload), timeout: 60000 }
                );
                if (run.error || (run.status !== 0 && /未安装|运行时检查失败/.test(run.stderr || ''))) {
                    return t.skip(`Python 运行时不可用: ${run.error ? run.error.message : run.stderr}`);
                }
                assert.strictEqual(run.status, 0, run.stderr);

                const nodeFiles = fs.readdirSync(nodeDir).sort();
                const pythonFiles = fs.readdirSync(pythonDir).sort();
                assert.deepStrictEqual(nodeFiles, pythonFiles, `场景 ${index} 文件名不一致`);
                for (const name of nodeFiles) {
                    assert.deepStrictEqual(
                        fs.readFileSync(path.join(nodeDir, name)),
                        fs.readFileSync(path.join(pythonDir, name)),
                        `场景 ${index} 的 ${name} 不是逐字节一致`
                    );
                }
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
