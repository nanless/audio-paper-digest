const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const scriptPath = path.resolve(__dirname, '../run-daily-digest.sh');
const source = fs.readFileSync(scriptPath, 'utf8');

test('日更只保留 API、博客三阶段和视觉阶段顺序', () => {
    const expected = [
        'node scripts/full-fetch.js --date "$target_date"',
        'bash scripts/python-runtime.sh scripts/generate-blog.py --date "$target_date"',
        'bash scripts/python-runtime.sh scripts/review-blog.py --date "$target_date"',
        'bash scripts/python-runtime.sh scripts/push-blog.py --date "$target_date" --require-visual-plan',
        'bash scripts/python-runtime.sh scripts/plan-post-publish-visuals.py --date "$target_date"',
        'node scripts/visual-summary-state.js prepare --date "$target_date"'
    ];
    let previous = -1;
    for (const command of expected) {
        const index = source.indexOf(command);
        assert.ok(index > previous, `缺少命令或阶段顺序错误: ${command}`);
        previous = index;
    }
});

test('默认论文速递脚本不调用图像 API，并明确要求 Codex 继续完成图片生成、检查和登记', () => {
    assert.doesNotMatch(source, /OPENAI_API_KEY|images\/generations|images\/edits|image_gen\.py/);
    assert.match(source, /digest:prepare 仅完成博客发布与视觉输入准备；退出成功不代表整条论文速递完成/);
    assert.match(source, /Codex 现在必须继续生成、目检并登记 TOP 10 论文长图和汇总封面/);
    assert.match(source, /npm run visual:status/);
    assert.match(source, /npm run cover:status/);
});

test('默认论文速递脚本要求显式日期并支持从 review 续跑', () => {
    assert.match(source, /\^\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}\$/);
    assert.match(source, /review\) start_index=6/);
    assert.match(source, /--from fetch\|generate\|review\|push\|visual/);
    assert.match(source, /\[--api\]/);
    assert.match(source, /PD_DAILY_API_MODE:-1/);
});

test('默认论文速递脚本校验真实公历日期，且新抓取只能绑定北京时间当天', () => {
    assert.match(source, /validate_calendar_date/);
    assert.match(source, /10#\$year % 400/);
    assert.match(source, /TZ=Asia\/Shanghai date \+%Y-%m-%d/);
    assert.match(source, /抓取阶段只允许北京时间当天/);
    assert.match(source, /历史批次只能使用 --from generate\|review\|push\|visual/);
});

test('三流程不再暴露整批 Manual、旧拆分分析和渠道发布入口', () => {
    const scripts = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).scripts;
    assert.equal(scripts['digest:prepare'], 'PD_DAILY_API_MODE=1 node scripts/workspace-role.js exec daily -- bash run-daily-digest.sh');
    assert.equal(scripts['digest:api'], scripts['digest:prepare']);
    assert(scripts['conference:process']);
    assert(scripts['history:run']);
    assert(scripts['history:resume']);
    assert(scripts['blog:manual-review']);
    for (const name of ['digest:manual', 'conference:analyze', 'conference:execution', 'conference:postprocess',
        'history:arxiv-analyze', 'history:analyze-batch', 'wechat', 'xiaohongshu', 'visual:render:debug']) assert.equal(scripts[name], undefined, name);
    assert(!Object.keys(scripts).some(name => name.startsWith('manual:') || name.startsWith('conference:new:')));
});

test('默认论文速递脚本在启动业务阶段前实际拒绝非法日期与历史抓取', () => {
    const env = { ...process.env };
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
    for (const command of ['python3.11', 'node']) {
        const fake = path.join(dir, command);
        fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s %s\\n' '${command}' "$*" >> '${logPath}'\n`);
        fs.chmodSync(fake, 0o755);
    }
    const env = {
        ...process.env,
        PATH: `${dir}:${process.env.PATH || ''}`,
        PD_PYTHON_RUNTIME_DISABLE_VENV: '1'
    };

    let result = spawnSync('bash', [scriptPath, '2026-07-13', '--from', 'push'], {
        cwd: path.dirname(scriptPath), env, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    let commands = fs.readFileSync(logPath, 'utf8');
    assert.match(commands, /python3\.11 scripts\/push-blog\.py --date 2026-07-13 --require-visual-plan/);
    assert.doesNotMatch(commands, /plan-post-publish-visuals\.py/);

    fs.writeFileSync(logPath, '');
    result = spawnSync('bash', [scriptPath, '2026-07-13', '--from', 'visual'], {
        cwd: path.dirname(scriptPath), env, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    commands = fs.readFileSync(logPath, 'utf8');
    assert.match(commands, /python3\.11 scripts\/plan-post-publish-visuals\.py --date 2026-07-13/);
    assert.doesNotMatch(commands, /push-blog\.py/);
});

test('已退役 Manual 和旧写作阶段在业务调用前被拒绝', () => {
    for (const args of [['2026-07-13', '--manual', '--from', 'generate'],
        ['2026-07-13', '--api', '--from', 'spec'], ['2026-07-13', '--from', 'tasks']]) {
        const result = spawnSync('bash', [scriptPath, ...args], { cwd: path.dirname(scriptPath), env: process.env, encoding: 'utf8' });
        assert.equal(result.status, 2);
        assert.match(result.stderr, /已退役|未知阶段/);
        assert.doesNotMatch(result.stdout, /论文速递阶段:/);
    }
});


test('显式取消视觉仍按发布版本登记豁免，并跳过实际图片准备', () => {
    const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'daily-digest-waiver-'));
    const log=path.join(dir,'commands.log');
    try {
        for(const command of ['python3.11','node']){
            const fake=path.join(dir,command);
            fs.writeFileSync(fake,`#!/bin/sh\nprintf '%s %s\\n' '${command}' "$*" >> '${log}'\n`);
            fs.chmodSync(fake,0o755);
        }
        const result=spawnSync('bash',[scriptPath,'2026-07-13','--from','push','--no-visuals'],{
            cwd:path.dirname(scriptPath),env:{...process.env,PATH:`${dir}:${process.env.PATH||''}`,PD_PYTHON_RUNTIME_DISABLE_VENV:'1'},encoding:'utf8'});
        assert.equal(result.status,0,result.stderr);
        const commands=fs.readFileSync(log,'utf8');
        assert.match(commands,/scripts\/push-blog\.py --date 2026-07-13 --require-visual-plan/);
        assert.match(commands,/scripts\/waive-post-publish-visuals\.js --date 2026-07-13 --reason/);
        assert.doesNotMatch(commands,/visual-summary-state\.js prepare/);
        assert.match(result.stdout,/当前发布版本的视觉豁免/);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('阶段计时记录成功和失败，保留真实退出码且失败后不执行下一阶段', t => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'daily-stage-timing-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const log = path.join(dir, 'commands.log');
    for (const command of ['python3.11', 'node']) {
        const fake = path.join(dir, command);
        fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$*" in *push-blog.py*) exit "\${TEST_PUSH_EXIT:-0}";; esac\n`);
        fs.chmodSync(fake, 0o755);
    }
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH || ''}`, PD_PYTHON_RUNTIME_DISABLE_VENV: '1' };
    const success = spawnSync('bash', [scriptPath, '2026-07-13', '--from', 'push', '--no-visuals'], { env, encoding: 'utf8' });
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /日期=2026-07-13 开始=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    assert.match(success.stdout, /阶段完成: 发布博客并规划视觉任务 \[耗时=\d+秒 结束=/);
    fs.writeFileSync(log, '');
    const failed = spawnSync('bash', [scriptPath, '2026-07-13', '--from', 'push', '--no-visuals'], {
        env: { ...env, TEST_PUSH_EXIT: '23' }, encoding: 'utf8'
    });
    assert.equal(failed.status, 23, failed.stderr);
    assert.match(failed.stderr, /阶段失败: 发布博客并规划视觉任务（退出码 23，耗时 \d+ 秒）/);
    assert.doesNotMatch(failed.stdout, /阶段完成: 发布博客|登记当前发布版本/);
    assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /waive-post-publish-visuals|visual-summary-state/);
});

test('官方 OAI 恢复仅在显式抓取参数中透传，默认不启用', t => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'daily-oai-option-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const log = path.join(dir, 'commands.log');
    const fake = path.join(dir, 'node');
    fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 23\n`);
    fs.chmodSync(fake, 0o755);
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH || ''}` };
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    for (const extra of [[], ['--official-oai-recovery']]) {
        fs.writeFileSync(log, '');
        const result = spawnSync('bash', [scriptPath, today, '--no-visuals', ...extra], { env, encoding: 'utf8' });
        assert.equal(result.status, 23, result.stderr);
        const command = fs.readFileSync(log, 'utf8').trim();
        assert.equal(command, `scripts/full-fetch.js --date ${today} --require-previously-fetched${extra.length ? ' --official-oai-recovery' : ''}`);
    }
    for (const extra of [['--official-oai-recovery', '--official-oai-recovery'], ['--from', 'push', '--official-oai-recovery']]) {
        fs.writeFileSync(log, '');
        const result = spawnSync('bash', [scriptPath, today, ...extra], { env, encoding: 'utf8' });
        assert.equal(result.status, 2, result.stderr);
        assert.equal(fs.readFileSync(log, 'utf8'), '');
    }
});
