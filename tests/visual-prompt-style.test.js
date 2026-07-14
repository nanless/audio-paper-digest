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
            'Preserve its real module relationships',
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
            'five calm stacked editorial rows',
            'no cyberpunk or sci-fi HUD',
            'no neon glow',
            'no podium, medal, laurel, trophy',
        ]) {
            assert.match(prompt, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
        }
        assert.doesNotMatch(prompt, /deep midnight-blue background/i);
        assert.doesNotMatch(prompt, /luminous cyan/i);
    });
});
