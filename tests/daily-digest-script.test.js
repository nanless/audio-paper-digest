const fs = require('fs');
const path = require('path');
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
