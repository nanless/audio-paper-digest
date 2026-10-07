const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert');

const PROJECT_ROOT = path.join(__dirname, '..');

function readPrompt(name) {
    return fs.readFileSync(path.join(PROJECT_ROOT, 'prompts', name), 'utf8');
}

describe('发布后视觉提示词风格契约', () => {
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

    // v1 永久冻结，只作为历史契约留在上面两条断言里。实际发出去的是版本登记表解析出的
    // 那一份，所以设计契约必须在这一份上再查一遍——否则提示词换了版、风格要求丢了，
    // 测试还是绿的。自然化改写把三处生图说明换成了同义说法，这里按新说法核对。
    it('当前版本提示词仍带完整设计契约', () => {
        const { currentTextStagePromptPath } = require('../scripts/lib/prompt-text-versions.js');
        const cases = [
            {
                stage: 'visualSummary',
                required: [
                    'warm off-white',
                    'low-saturation palette',
                    'flat-vector editorial illustration',
                    '12-column editorial grid',
                    'negative space',
                    '220–360 Simplified-Chinese characters',
                    '2–4 complete explanatory statements',
                    'Reference figures supplied with the task',
                    'Preserve real parallel branches',
                    'generate the full image',
                    'whole poster in one pass',
                    'visually check every title',
                    'Render legible text without random characters or pseudo-text',
                    'Do not use a dark navy or black full-page background, neon glow, cyberpunk or sci-fi HUD',
                    'avoid cluttered icons, repeated decorative waveforms, a dense grid of equal-sized boxes',
                ],
            },
            {
                stage: 'digestCover',
                required: [
                    'warm off-white',
                    'low-saturation palette',
                    'flat-vector editorial illustration',
                    'generous negative space',
                    'up to ten clearly aligned rows',
                    'generate the full image',
                    'whole cover in one pass',
                    'highest available portrait resolution',
                    'visually check every supplied title',
                    'Render legible text without random characters or pseudo-text',
                    'Do not use a dark navy or black full-page background, neon glow, cyberpunk or sci-fi HUD',
                    'Avoid podiums, medals, laurels, trophies',
                ],
            },
        ];
        for (const { stage, required } of cases) {
            const promptPath = currentTextStagePromptPath(stage);
            const prompt = readPrompt(path.basename(promptPath));
            for (const phrase of required) {
                assert.match(
                    prompt,
                    new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
                    `${stage} 的当前提示词缺少设计契约: ${phrase}`
                );
            }
            assert.doesNotMatch(prompt, /deep midnight-blue background/i);
            assert.doesNotMatch(prompt, /luminous cyan/i);
        }
    });
});
