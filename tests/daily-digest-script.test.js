const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const scriptPath = path.resolve(__dirname, '../run-daily-digest.sh');
const source = fs.readFileSync(scriptPath, 'utf8');

test('默认论文速递脚本保持生产 v6、博客三阶段和视觉阶段顺序', () => {
    const expected = [
        'node scripts/full-fetch.js',
        'npm run manual:tasks -- init --date "$target_date"',
        'npm run manual:records -- --date "$target_date"',
        'npm run manual:spec -- --date "$target_date" --records "$records_v4"',
        'npm run manual:analyze -- --date "$target_date" --spec "$spec_v6"',
        'python3 scripts/generate-blog.py --date "$target_date"',
        'python3 scripts/review-blog.py --date "$target_date"',
        'python3 scripts/push-blog.py --date "$target_date" --require-visual-plan',
        'python3 scripts/plan-post-publish-visuals.py --date "$target_date"',
        'node scripts/visual-summary-state.js prepare --date "$target_date"'
    ];
    let previous = -1;
    for (const command of expected) {
        const index = source.indexOf(command);
        assert.ok(index > previous, `缺少命令或阶段顺序错误: ${command}`);
        previous = index;
    }
});

test('默认论文速递脚本不调用图像 API，并明确要求 Codex 接续最终视觉门禁', () => {
    assert.doesNotMatch(source, /OPENAI_API_KEY|images\/generations|images\/edits|image_gen\.py/);
    assert.match(source, /digest:prepare 仅完成博客发布与视觉输入准备；退出成功不代表整条论文速递完成/);
    assert.match(source, /Codex 现在必须继续生成、目检并登记 TOP 10 论文长图和汇总封面/);
    assert.match(source, /npm run visual:status/);
    assert.match(source, /npm run cover:status/);
});

test('默认论文速递脚本要求显式日期并支持从 review 续跑', () => {
    assert.match(source, /\^\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}\$/);
    assert.match(source, /review\) start_index=6/);
    assert.match(source, /--from fetch\|tasks\|spec\|analyze\|generate\|review\|push\|visual/);
});

test('默认论文速递脚本校验真实公历日期，且新抓取只能绑定北京时间当天', () => {
    assert.match(source, /validate_calendar_date/);
    assert.match(source, /10#\$year % 400/);
    assert.match(source, /TZ=Asia\/Shanghai date \+%Y-%m-%d/);
    assert.match(source, /抓取阶段只允许北京时间当天/);
    assert.match(source, /历史批次只能使用 --from tasks\|spec\|analyze\|generate\|review\|push\|visual/);
});

test('默认 Manual 边界只声明生产 records v4/spec v6，不伪装自动 subagent DAG', () => {
    assert.match(source, /data\/current\/manual-v6\/\$\{target_date\}/);
    assert.match(source, /records-v4\.json/);
    assert.match(source, /生产 spec v6\/canonical/);
    assert.match(source, /不会创建 subagent、物化 role packet 或组装 records envelope/);
    assert.match(source, /逐篇创建 Terra-high leaf subagent/);
    assert.doesNotMatch(source, /每篇由独立 paper subagent 写 records v3/);
    assert.doesNotMatch(source, /manual-v6-shadow\/\$\{target_date\}/);
});

test('package 默认 manual 命令进入 production v6，legacy v5 和 shadow 都必须显式命名', () => {
    const scripts = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).scripts;
    assert.equal(scripts['manual:spec'], 'node scripts/create-manual-analysis-spec-v6.js --production');
    assert.equal(scripts['manual:analyze'], 'node scripts/manual-deep-analysis.js --v6-production');
    assert.equal(scripts['manual:packet'], 'node scripts/manual-v6-production-packet.js');
    assert.equal(scripts['manual:records'], 'node scripts/manual-v6-production-records.js');
    assert.equal(scripts['manual:work-queue'], 'node scripts/manual-v6-task-runner.js status');
    assert.equal(scripts['manual:v5:spec'], 'node scripts/create-manual-analysis-spec.js');
    assert.equal(scripts['manual:v5:analyze'], 'node scripts/manual-deep-analysis.js');
    assert.equal(scripts['manual:v6:shadow:spec'], 'node scripts/create-manual-analysis-spec-v6.js --shadow');
    assert.equal(scripts['manual:v6:shadow:analyze'], 'node scripts/manual-deep-analysis.js --v6-shadow');
    assert.equal(scripts['manual:template'], undefined);
    assert.equal(scripts['manual:record-validate'], undefined);
    assert.equal(scripts['manual:tutorial-preview'], undefined);
    assert.equal(scripts['manual:author-packet'], undefined);
});

test('默认论文速递脚本在启动业务阶段前实际拒绝非法日期与历史抓取', () => {
    const env = { ...process.env };
    delete env.CODEX_SANDBOX;
    for (const [date, expected] of [
        ['2026-02-30', /非法日期/],
        ['2000-01-01', /抓取阶段只允许北京时间当天/],
    ]) {
        const result = spawnSync('bash', [scriptPath, date], {
            cwd: path.dirname(scriptPath),
            env,
            encoding: 'utf8',
        });
        assert.equal(result.status, 2, `${date}: ${result.stdout}\n${result.stderr}`);
        assert.match(result.stderr, expected);
        assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /论文速递阶段:/);
    }
});

test('push 续跑只由 push 规划一次，visual 续跑才直接调用独立规划器', () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'daily-digest-path-'));
    const logPath = path.join(dir, 'commands.log');
    for (const command of ['python3', 'node']) {
        const fake = path.join(dir, command);
        fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s %s\\n' '${command}' "$*" >> '${logPath}'\n`);
        fs.chmodSync(fake, 0o755);
    }
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH || ''}` };
    delete env.CODEX_SANDBOX;

    let result = spawnSync('bash', [scriptPath, '2026-07-13', '--from', 'push'], {
        cwd: path.dirname(scriptPath), env, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    let commands = fs.readFileSync(logPath, 'utf8');
    assert.match(commands, /python3 scripts\/push-blog\.py --date 2026-07-13 --require-visual-plan/);
    assert.doesNotMatch(commands, /plan-post-publish-visuals\.py/);

    fs.writeFileSync(logPath, '');
    result = spawnSync('bash', [scriptPath, '2026-07-13', '--from', 'visual'], {
        cwd: path.dirname(scriptPath), env, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    commands = fs.readFileSync(logPath, 'utf8');
    assert.match(commands, /python3 scripts\/plan-post-publish-visuals\.py --date 2026-07-13/);
    assert.doesNotMatch(commands, /push-blog\.py/);
});

test('tasks 续跑只初始化并展示持久 runner，然后在真实 subagent 边界退出', () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'daily-digest-tasks-'));
    const logPath = path.join(dir, 'commands.log');
    const fake = path.join(dir, 'npm');
    fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s %s\\n' 'npm' "$*" >> '${logPath}'\n`);
    fs.chmodSync(fake, 0o755);
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH || ''}`, PD_DAILY_API_MODE: '0' };
    delete env.CODEX_SANDBOX;
    const result = spawnSync('bash', [scriptPath, '2026-07-13', '--from', 'tasks'], {
        cwd: path.dirname(scriptPath), env, encoding: 'utf8'
    });
    assert.equal(result.status, 3, result.stderr);
    const commands = fs.readFileSync(logPath, 'utf8');
    assert.match(commands, /npm run manual:tasks -- init --date 2026-07-13/);
    assert.match(commands, /npm run manual:tasks -- status --date 2026-07-13/);
    assert.match(result.stdout, /不会创建 subagent、物化 packet 或组装 records-v4\.json/);
    assert.doesNotMatch(commands, /manual:spec|manual:analyze|generate-blog/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('--api 拒绝 Manual v6 专属 tasks/spec/analyze 续跑阶段', () => {
    const env = { ...process.env };
    delete env.CODEX_SANDBOX;
    const result = spawnSync('bash', [scriptPath, '2026-07-13', '--api', '--from', 'spec'], {
        cwd: path.dirname(scriptPath), env, encoding: 'utf8'
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--api 不使用 Manual v6 的 tasks\/spec\/analyze/);
});
