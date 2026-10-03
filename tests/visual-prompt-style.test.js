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
            'Render legible text without random characters or pseudo-text',
            'Do not use a dark navy or black full-page background, neon glow, cyberpunk or sci-fi HUD',
            'avoid cluttered icons, repeated decorative waveforms, a dense grid of equal-sized boxes',
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
            'up to ten clearly aligned rows',
            'full image generation',
            'complete final cover',
            'highest available portrait resolution',
            'visually verify every supplied title',
            'Render legible text without random characters or pseudo-text',
            'Do not use a dark navy or black full-page background, neon glow, cyberpunk or sci-fi HUD',
            'Avoid podiums, medals, laurels, trophies',
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
