const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert');

const PROJECT_ROOT = path.join(__dirname, '..');

function readPrompt(name) {
    return require('../scripts/lib/prompt-evidence.js').readPromptEvidenceBytes(`prompts/${name}`).toString('utf8');
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

    it('已退休的调试绘制入口不会替代正式生图工具', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
        assert.ok(!Object.hasOwn(pkg.scripts, 'visual:render:debug'));
        assert.ok(!Object.hasOwn(pkg.scripts, 'visual:render'));
    });

    // 两版原始字节都只供历史凭证核验，不能重新成为现用写作入口。
    it('已退休中文长图与封面保留原设计事实，现用登记拒绝两阶段', () => {
        const { currentTextStagePromptPath } = require('../scripts/lib/prompt-contracts.js');
        const { originalCurrent } = require('../scripts/lib/prompt-legacy-codec.js');
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
            assert.throws(() => currentTextStagePromptPath(stage), /没有登记/);
            const promptPath = originalCurrent[stage].path;
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
