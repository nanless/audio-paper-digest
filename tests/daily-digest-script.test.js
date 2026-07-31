const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const scriptPath = path.resolve(__dirname, '../run-daily-digest.sh');
const source = fs.readFileSync(scriptPath, 'utf8');

test('默认论文速递脚本保持完整阶段顺序和博客三阶段分离', () => {
    const expected = [
        'node scripts/full-fetch.js',
        'python3 scripts/generate-blog.py --date "$target_date"',
        'python3 scripts/review-blog.py --date "$target_date"',
        'python3 scripts/push-blog.py --date "$target_date"',
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
    assert.match(source, /Codex 现在必须继续生成、目检并登记 TOP 10 论文长图和汇总封面/);
    assert.match(source, /npm run visual:status/);
    assert.match(source, /npm run cover:status/);
});

test('默认论文速递脚本要求显式日期并支持从 review 续跑', () => {
    assert.match(source, /\^\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}\$/);
    assert.match(source, /review\) start_index=3/);
    assert.match(source, /--from fetch\|generate\|review\|push\|visual/);
});

test('默认论文速递脚本校验真实公历日期，且新抓取只能绑定北京时间当天', () => {
    assert.match(source, /validate_calendar_date/);
    assert.match(source, /10#\$year % 400/);
    assert.match(source, /TZ=Asia\/Shanghai date \+%Y-%m-%d/);
    assert.match(source, /抓取阶段只允许北京时间当天/);
    assert.match(source, /历史批次只能使用 --from generate\|review\|push\|visual/);
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
