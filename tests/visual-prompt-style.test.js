const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert');

const PROJECT_ROOT = path.join(__dirname, '..');

function readPrompt(name) {
    return fs.readFileSync(path.join(PROJECT_ROOT, 'prompts', name), 'utf8');
}

describe('发布后长图与封面提示词的风格要求', () => {
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

    it('图片绘制脚本只提供调试命令，不作为默认生图入口', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
        assert.strictEqual(
            pkg.scripts['visual:render:debug'],
            'bash scripts/python-runtime.sh scripts/render-visual-summary.py'
        );
        assert.ok(!Object.hasOwn(pkg.scripts, 'visual:render'));
    });

    // v1 永久冻结，上面两条测试保留旧版样式检查。实际使用的提示词由版本登记表解析，
    // 所以还须检查当前中文正文中的设计要求，防止换版时遗漏。
    it('当前长图与封面提示词保留规定的设计要素和禁止样式', () => {
        const { currentTextStagePromptPath } = require('../scripts/lib/prompt-text-versions.js');
        const cases = [
            {
                stage: 'visualSummary',
                required: [
                    '暖白色',
                    '低饱和度',
                    '扁平矢量插画',
                    '12 列网格',
                    '干净空间',
                    '220–360 个简体中文字符',
                    '2–4 句完整解释',
                    '任务附带的参考图均已核验',
                    '保留真实的并行分支',
                    '一次生成整张成图',
                    '同一张图中完成',
                    '逐项目检标题',
                    '文字必须清楚可读，不出现随机字符或伪文字',
                    '不要使用深藏青或黑色整页背景、霓虹光效、赛博朋克或科幻抬头显示界面',
                    '不堆图标、重复装饰波形、同样大小的密集方格',
                ],
            },
            {
                stage: 'digestCover',
                required: [
                    '暖白色',
                    '低饱和度',
                    '扁平矢量插画',
                    '充足空白',
                    '最多十行，行间对齐清楚',
                    '一次生成整张成图',
                    '同一张图中完成',
                    '最高纵向分辨率',
                    '逐项目检所有给定标题',
                    '文字必须清楚可读，不出现随机字符或伪文字',
                    '不要使用深藏青或黑色整页背景、霓虹光效、赛博朋克或科幻抬头显示界面',
                    '避免领奖台、奖牌、桂冠、奖杯',
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
                    `${stage} 的当前提示词缺少设计要求: ${phrase}`
                );
            }
            assert.doesNotMatch(prompt, /deep midnight-blue background/i);
            assert.doesNotMatch(prompt, /luminous cyan/i);
        }
    });
});
