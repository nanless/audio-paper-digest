const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert');

const PROJECT_ROOT = path.join(__dirname, '..');

function readPrompt(name) {
    return fs.readFileSync(path.join(PROJECT_ROOT, 'prompts', name), 'utf8');
}

describe('post-publication visual prompt style contract', () => {
    it('论文长图使用清新编辑设计并显式排除旧版霓虹仪表盘风格', () => {
        const prompt = readPrompt('visual-summary.md');
        for (const required of [
            'warm off-white',
            'low-saturation palette',
            'flat-vector editorial illustration',
            '12-column editorial grid',
            'negative space',
            '220–360 Simplified-Chinese characters',
            '2–4 complete explanatory statements',
            'Reference figures supplied with the task',
            'Preserve real parallel branches',
            'full image generation',
            'complete final poster',
            'visually verify every title',
            'no illegible pseudo-text',
            'no cyberpunk or sci-fi HUD',
            'no neon glow',
            'no dense grid of equal-sized boxes',
        ]) {
            assert.match(prompt, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
        }
        assert.doesNotMatch(prompt, /deep midnight-blue background/i);
        assert.doesNotMatch(prompt, /luminous cyan/i);
    });

    it('汇总封面与论文长图共享清新风格且排行榜采用编辑式行布局', () => {
        const prompt = readPrompt('digest-cover.md');
        for (const required of [
            'warm off-white',
            'low-saturation palette',
            'flat-vector editorial illustration',
            'generous negative space',
            'up to ten compact, calm editorial rows',
            'full image generation',
            'complete final cover',
            'highest available portrait resolution',
            'visually verify every supplied title',
            'no illegible pseudo-text',
            'no cyberpunk or sci-fi HUD',
            'no neon glow',
            'no podium, medal, laurel, trophy',
        ]) {
            assert.match(prompt, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
        }
        assert.doesNotMatch(prompt, /deep midnight-blue background/i);
        assert.doesNotMatch(prompt, /luminous cyan/i);
    });

    it('确定性渲染器只暴露调试命令，不伪装成默认生图流程', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
        assert.strictEqual(
            pkg.scripts['visual:render:debug'],
            'bash scripts/python-runtime.sh scripts/render-visual-summary.py'
        );
        assert.ok(!Object.hasOwn(pkg.scripts, 'visual:render'));
    });
});
