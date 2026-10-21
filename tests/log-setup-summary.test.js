const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeStageSummary } = require('../scripts/log-setup.js');

// 北京时间 2026-10-21 21:10:00，固定时间戳便于锁住完整行格式。
const BEIJING_NOW = new Date('2026-10-21T13:10:00.000Z');

function createRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-stage-summary-'));
}

function readLines(filePath) {
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(line => line !== '');
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
            assert.strictEqual(fs.statSync(logsDir).mode & 0o777, 0o700);
            assert.strictEqual(fs.statSync(filePath).mode & 0o777, 0o600);
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
        t.mock.method(fs, 'appendFileSync', () => {
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
});
