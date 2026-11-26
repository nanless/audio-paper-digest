'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const editorial = require('../scripts/editorial-quality.js');
const format = require('../scripts/lib/reader-record-format.js');
const deep = require('../scripts/deep-analyzer.js');

const ROOT = path.resolve(__dirname, '..');

describe('Wave 12 Track 12.3: Chinese fluency & quantitative_chinese_numeral on STRUCTURED_V5', () => {
    it('allows natural Chinese singular 一 & idiomatic phrases strictly on STRUCTURED_V5 while preserving v4/legacy behavior', () => {
        const naturalSentences = [
            '实验采用留一会话与留一说话人交叉验证，留一个受试者作为测试集。',
            '这一对比说明另一位说话人的音色并未泄漏，最后一次更新后结果稳定。',
            '读者可以一次看清整体数据流，并将这一类特征一并送入解码器。',
            '模型构建一套统一框架，通过一路辅助分支学习一种声学先验与一条残差路径。',
            '在一项客观评测中，一段语音对应一场对话，每次只处理一帧并做一遍遍历。',
            '一组对照实验仅需一次前向推理与一次解码即可完成校准，采用一层线性投影。',
            '设计一套基于 Transformer 的编码器，统计一次输出分布并估计一个残差项。',
            '开源权重便于社区二次开发，并避免了传统自注意力的二次复杂度与二次计算开销。',
            // Round 2 P1-1 regressions: audio tensor-flow pipeline & negative-dB quantities must NEVER be flagged as ranges
            '从一段语音中提取到 80 维梅尔特征，从一个波形直接映射到 50 Hz 令牌，由一组特征聚合到 256 维向量。',
            '从一帧频谱预测到 4 个谐波分量，由一套编码器压缩到 12.5 Hz 帧率，从 16 kHz 波形下采样到一帧 20 ms 特征。',
            '由 1000 小时数据训练得到一个通用模型，从 24 kHz 音频编码得到一套离散令牌，从 80 维频谱映射到一路隐特征。',
            '合成一段 -5 dB 信噪比的音频，并混入一个 -3 dB 噪声源。'
        ];

        for (const text of naturalSentences) {
            const v5Findings = editorial.findQuantitativeChineseNumerals(text, {
                editorialProfile: format.STRUCTURED_EDITORIAL
            });
            assert.deepEqual(v5Findings, [], `STRUCTURED_V5 should allow natural Chinese: ${text}`);
        }

        // Legacy & cohesive-functional-v4 MUST retain original behavior (zero cold-replay drift)
        const v4Probe = '实验采用留一会话交叉验证，这一对比说明另一位说话人表现稳定。';
        const v4Findings = editorial.findQuantitativeChineseNumerals(v4Probe, {
            editorialProfile: format.COHESIVE_EDITORIAL
        });
        assert.ok(v4Findings.length >= 2, `cohesive-functional-v4 should keep historical checks intact: ${JSON.stringify(v4Findings)}`);
    });

    it('still catches genuine quantitative counts, decimals/fractions/ratios, physical/bit-width units, ranges, and exact totals on STRUCTURED_V5', () => {
        const mustCatchExact = [
            ['训练了三个模型并叠加五层卷积。', ['三个模型', '五层']],
            ['音频采样率为十六千赫兹，准确率达到百分之八十五。', ['采样率为十六千', '百分之八十五']],
            ['单句延迟五毫秒，缓存一秒音频后吞吐提升一倍。', ['五毫秒', '一秒', '一倍']],
            ['信噪比改善一分贝，准确率提升一个百分点，显存占用一 GB。', ['一分贝', '一个', '一 GB']],
            ['模型深度从一层扩展到四层，从四层降到一层，由一轮增至三轮。', ['一层', '四层', '一轮', '三轮']],
            ['基准总计一个数据集、共计一个模型、恰好一个会话。', ['一个数据集', '一个模型', '一个']],
            ['在配比三比一且延迟一毫秒的条件下，输入一 token。', ['三比一', '一毫秒', '一 token']],
            // Round 1 P1-4 regressions: decimals, fractions, ratios/products, 一个+physical units, 保留一个百分点, 总计一次前向, 一位量化
            ['平均耗时零点一帧，模型有二点一层，仅需零点一次前向。', ['零点一', '二点一', '零点一']],
            ['仅占四分之一帧，比例为三比一组，计算量为三乘一次。', ['四分之一', '三比一', '三乘一']],
            ['音频时长为一个小时，包含一个字节和一个 token。', ['一个', '一个', '一个']],
            ['误差仅保留一个百分点。', ['一个']],
            ['总计一次前向推理，共计一次评估，总共执行一次。', ['一次', '一次', '一次']],
            ['模型深度从一次推理增至四次推理，采用一位量化压缩权重。', ['一次', '四次', '一位']]
        ];

        for (const [text, expectedList] of mustCatchExact) {
            const findings = editorial.findQuantitativeChineseNumerals(text, {
                editorialProfile: format.STRUCTURED_EDITORIAL
            });
            const matches = findings.map(f => f.match);
            for (const expected of expectedList) {
                assert.ok(
                    matches.includes(expected),
                    `Expected exact match "${expected}" in "${text}", got: ${JSON.stringify(matches)}`
                );
            }
            assert.ok(
                matches.length >= expectedList.length,
                `Expected at least ${expectedList.length} matches in "${text}", got: ${JSON.stringify(matches)}`
            );
        }
    });

    it('protects natural Chinese in both normalizeReaderProseFormatting and normalizeIssueBoundReaderQuantitativeNumerals on STRUCTURED_V5 (no Catch-22 loop)', () => {
        const input = '留一会话交叉验证下，这一对比证明另一位说话人用Transformer做一次前向即可一次看清结果，最后一次用BERT完成一套特征映射。';
        const fakeStaleIssues = [
            { code: 'quantitative_chinese_numeral', match: '一会话' },
            { code: 'quantitative_chinese_numeral', match: '一对' },
            { code: 'quantitative_chinese_numeral', match: '一位' },
            { code: 'quantitative_chinese_numeral', match: '一次' },
            { code: 'quantitative_chinese_numeral', match: '一套' }
        ];
        const formatted = deep.normalizeReaderProseFormatting(input, fakeStaleIssues, {
            editorialProfile: format.STRUCTURED_EDITORIAL
        });
        assert.ok(formatted.includes('留一会话'));
        assert.ok(formatted.includes('这一对比'));
        assert.ok(formatted.includes('另一位'));
        assert.ok(formatted.includes('一次前向'));
        assert.ok(formatted.includes('一次看清'));
        assert.ok(formatted.includes('最后一次'));
        assert.ok(formatted.includes('一套'));
        assert.ok(formatted.includes('用 Transformer 做一次前向'));
        assert.ok(formatted.includes('用 BERT 完成一套'));
        assert.ok(!/留\s*1\s*会话|这\s*1\s*对比|另\s*1\s*位|最后\s*1\s*次|1\s*次看清|1\s*套/.test(formatted));

        // Round 1 P0-2 regression: co-occurring exact-total singular 一 + natural Chinese in same section
        const mixed = '模型训练总计一次测试。最后一次更新后可以一次看清结果，总计一位测试者，另一位说话人表现稳定。';
        const v5NumIssues = editorial.findQuantitativeChineseNumerals(mixed, {
            editorialProfile: format.STRUCTURED_EDITORIAL
        }).map(f => ({ ...f, code: 'quantitative_chinese_numeral' }));
        assert.deepEqual(v5NumIssues.map(i => i.match), ['一次', '一位']);
        const normalizedMixed = editorial.normalizeIssueBoundReaderQuantitativeNumerals(
            mixed,
            v5NumIssues,
            { editorialProfile: format.STRUCTURED_EDITORIAL }
        );
        assert.equal(
            normalizedMixed,
            '模型训练总计 1 次测试。最后一次更新后可以一次看清结果，总计 1 位测试者，另一位说话人表现稳定。'
        );
        assert.deepEqual(
            editorial.findReaderLanguageIssues(normalizedMixed, { editorialProfile: format.STRUCTURED_EDITORIAL }),
            []
        );
        assert.deepEqual(
            editorial.findQuantitativeChineseNumerals(normalizedMixed, { editorialProfile: format.STRUCTURED_EDITORIAL }),
            []
        );
    });
});

describe('Wave 12 Track 12.3: Audio/hardware mistranslation, mechanical 1 & AI cliché rules on STRUCTURED_V5', () => {
    it('flags GPU/CPU/MACs/ViSQOL mistranslations, mechanical 1 phrases, and AI clichés strictly on STRUCTURED_V5', () => {
        const badText = [
            '模型在单张 A100 图形处理器与多核中央处理器上完成评测，计算量为 1.93 G 乘加操作。',
            '客观听感采用虚拟语音质量客观分数与虚拟语音质量客观得分衡量，并在留 1 会话与这 1 对比中观察另 1 位说话人的表现，以上 1 帧为例，下 1 帧语音在最后 1 次中 1 次看清结果。',
            '值得一提的是，不仅如此，该方法成为核心抓手与能力底座，彻底消除高频失真，令人瞩目，总而言之具有里程碑式的突破。'
        ].join('\n\n');

        const v5Issues = editorial.findReaderLanguageIssues(badText, {
            editorialProfile: format.STRUCTURED_EDITORIAL
        });
        const matched = v5Issues.map(i => i.match);
        for (const expected of [
            '图形处理器',
            '中央处理器',
            '乘加操作',
            '虚拟语音质量客观分数',
            '虚拟语音质量客观得分',
            '留 1 会话',
            '这 1 对比',
            '另 1 位',
            '上 1 帧',
            '下 1 帧',
            '最后 1 次',
            '1 次看清',
            '值得一提的是',
            '不仅如此',
            '核心抓手',
            '能力底座',
            '彻底消除',
            '令人瞩目',
            '总而言之',
            '里程碑式的突破'
        ]) {
            assert.ok(matched.includes(expected), `Expected STRUCTURED_V5 to flag "${expected}", got: ${JSON.stringify(matched)}`);
        }

        // Zero drift on cohesive-functional-v4
        const v4Issues = editorial.findReaderLanguageIssues(badText, {
            editorialProfile: format.COHESIVE_EDITORIAL
        });
        assert.equal(v4Issues.length, 0, `cohesive-functional-v4 must not fail on new STRUCTURED_V5 rules, got: ${JSON.stringify(v4Issues)}`);
    });

    it('avoids false positives on valid locative 上/下, 保留/预留 1 个, acronym glosses, and clause-local negation of 彻底消除', () => {
        const safeText = [
            // Round 1 P0-3 regressions: valid 保留/预留 1 个 & locative 在...上/下 & 加上/剩下 1 帧
            '剪枝后最多保留 1 个候选注意力头，微调阶段仅保留 1 个百分点余量，消融实验只保留 1 个说话人分支，缓冲区预留 1 个会话槽位。',
            '在 16 kHz 采样率下 1 帧对应 20 ms，在单张 A100 上 1 轮微调耗时 2 小时。',
            '在 LibriSpeech 上 1 次前向推理仅需 5 ms，在盲测条件下 1 人评测 50 条语音。',
            '原模型加上 1 路辅助分支并加上 1 帧前瞻，剩下 1 帧作为缓冲区。',
            // Round 1 P1-6 & Round 2 P2-2/P2-3 regressions: threshold 以下/以上, bilingual acronym glosses & non-adjacent clause negation
            '在 0 dB 以下 1 帧语音的信噪比显著恶化，在 100 ms 以下 1 次前向即可满足实时要求，在 10 dB 以上 1 路音频几乎无失真。',
            '计算量为 1.93 GMACs（十亿次乘加操作），MACs（Multiply-Accumulate Operations，乘加操作数），并在单张 TPU（张量处理器）与 GPU（图形处理器）上完成评测。',
            '该方法未必能彻底消除混响，也无法将高频伪影彻底消除，且并非旨在彻底消除所有背景声，可恢复信息减少约 30%，而非彻底消除。',
            '标准硬件简称 GPU 不要译成“图形处理器”，指标 ViSQOL 不应译为“虚拟语音质量客观分数”。',
            '值得注意的是仅重建版本的谱误差下降，但听感仍略低于参考系统。'
        ].join('\n\n');
        const issues = editorial.findReaderLanguageIssues(safeText, {
            editorialProfile: format.STRUCTURED_EDITORIAL
        });
        assert.deepEqual(issues, []);
    });
});

describe('Wave 12 Track 12.3: Expanded audio metric whitelist on STRUCTURED_V5', () => {
    it('exports canonical AUDIO_METRIC_WHITELIST with all 16 core audio metrics and respects ASCII word boundaries in numericFactSignatures', () => {
        for (const metric of [
            'UTMOS', 'DNSMOS', 'NISQA', 'ViSQOL', 'STOI', 'ESTOI',
            'FAD', 'CLAP', 'RTF', 'TTFA', 'EER', 'SI-SDR', 'SI-SDRi',
            'MCD', 'LSD', 'WV-MOS'
        ]) {
            assert.ok(editorial.AUDIO_METRIC_WHITELIST.includes(metric), `Missing metric ${metric} in AUDIO_METRIC_WHITELIST`);
        }

        // Round 1 P1-7 regression: Vocoder/Decoder/Encoder must not match DER inside ASCII words
        const reuse = editorial.findCrossSectionNumericFactReuse({
            summary: 'Vocoder 在 16 kHz 下处理 20 ms 帧。',
            method: 'Decoder 在 16 kHz 下处理 20 ms 帧。',
            results: 'Encoder 在 16 kHz 下输出 20 ms 帧。'
        }, { editorialProfile: format.STRUCTURED_EDITORIAL });
        assert.equal(reuse.length, 1);
        assert.equal(reuse[0].signature, '16khz|20ms::');
    });

    it('avoids false percentage_metric_delta_without_unit on audio metrics & latency units while keeping WER/EER strict and legacy zero-drift', () => {
        const validAudioSentences = [
            '虽然 WER 略有下降，但 DNSMOS 提升到 3.85，ViSQOL 从 3.40 提升到 4.12，NISQA 达到 4.05，WV-MOS 为 4.15。',
            '在准确率改善的同时，SI-SDR 从 11.2 提升到 15.6，SI-SDRi 达到 11.4，FAD 从 2.80 降至 1.35，MCD 降至 4.2，LSD 降至 0.85。',
            '错误率保持稳定的前提下，RTF 降至 0.08，TTFA 降至 120 毫秒，STOI 提高到 0.92，ESTOI 为 0.86，CLAP 为 0.58。',
            // Round 1 P1-5 & P2-9 regressions: 提升至, 由...提升到, ± CI, conjunctions, bare metric value, SDR/SNR/SIM/SECS, latency ms, EER pp interval
            'WER 降低，PESQ 从 2.15 提升至 3.40，SI-SDR 由 11.2 提升到 15.6，SDR 达到 +12.5 dB，SNR 升至 18.0 分贝。',
            'WER 改善时 MOS 为 4.2 ± 0.1，UTMOS 提升到 4.12 与 PESQ 提升到 3.45，SIM 为 0.88 且 SECS 为 0.85。',
            'WER 改善时 MOS 4.2，PESQ 3.4，且延迟降至 12 ms、显存降至 8 GB，延迟在 10 到 20 ms、码率为 16 到 32 kbps。',
            'EER 降低了 2.5 pp [1.2, 3.8]。',
            // 2026-11-26 真实保存稿 2611.33409v1：0–1 尺度 BERTScore 召回率与无量纲 CIDEr 同句并列不应误报缺单位
            '3 组中听觉语境事实准确但参考句未收录，佐证验证集上 BERTScore 召回率从 0.9366 升至 0.9376 而 CIDEr 从 64.0 降至 62.0 的分叉，同时门控变体在第一阶段即从 0.85 CIDEr 降至 0.79 CIDEr 并在第二阶段崩溃，纯音频消融仅 0.14 CIDEr，说明单全局 token 难以承载时序语法。'
        ];
        for (const s of validAudioSentences) {
            const issues = editorial.findMissingComparisonUnits(s, {
                editorialProfile: format.STRUCTURED_EDITORIAL
            });
            assert.deepEqual(issues, [], `Should not flag valid audio metrics on STRUCTURED_V5: ${s}`);
        }

        // Must still catch genuine bare percentage WER/EER & negated ViSQOL/CIDEr transfer
        assert.equal(
            editorial.findMissingComparisonUnits('虽然 ViSQOL 从 3.40 提升到 4.12，但 WER 从 8.5 降至 4.2。', { editorialProfile: format.STRUCTURED_EDITORIAL }).length,
            1
        );
        assert.equal(
            editorial.findMissingComparisonUnits('验证集上 BERTScore 召回率从 93.66 升至 93.76 而 CIDEr 从 64.0 降至 62.0。', { editorialProfile: format.STRUCTURED_EDITORIAL }).length,
            1
        );
        assert.equal(
            editorial.findMissingComparisonUnits('这里变化不是 CIDEr 从 64.0 降至 62.0，而是召回率从 64.0 降至 62.0。', { editorialProfile: format.STRUCTURED_EDITORIAL }).length,
            1
        );
        assert.equal(
            editorial.findMissingComparisonUnits('说话人验证 EER 从 5.8 降至 2.3。', { editorialProfile: format.STRUCTURED_EDITORIAL }).length,
            1
        );
        assert.equal(
            editorial.findMissingComparisonUnits('这里变化不是 ViSQOL 升至 4.12，而是 WER 降至 4.2。', { editorialProfile: format.STRUCTURED_EDITORIAL }).length,
            1
        );

        // Round 1 P0-1 regression: zero drift on omitted/legacy/v4 for EER & nasal filter 对零点
        assert.equal(editorial.findMissingComparisonUnits('说话人验证 EER 从 5.8 降至 2.3。').length, 0);
        assert.equal(editorial.findMissingComparisonUnits('该鼻音滤波器引入一对零点以降低 EER。').length, 0);
        assert.equal(
            editorial.findMissingComparisonUnits('该鼻音滤波器引入一对零点以降低 EER。', { editorialProfile: format.COHESIVE_EDITORIAL }).length,
            0
        );
    });
});

describe('Wave 12 Track 12.3: Audio pedagogy reinforcement in prompts', () => {
    it('reinforces Delta, 1-second signal tensor flow, MOS vs neural proxy callout, and Demo listening pointer while keeping KV prefix >= 90%', () => {
        const readerPrompt = fs.readFileSync(path.join(ROOT, 'prompts/current/api-reader-article.md'), 'utf8');
        const analysisPrompt = fs.readFileSync(path.join(ROOT, 'prompts/current/deep-analysis.md'), 'utf8');

        for (const [name, text] of [['api-reader-article.md', readerPrompt], ['deep-analysis.md', analysisPrompt]]) {
            assert.match(text, /Delta/, `${name} should instruct Delta vs closest baseline`);
            assert.match(text, /1\s*秒.*张量流|1\s*秒输入样本/, `${name} should instruct 1-second signal tensor flow`);
            assert.match(text, /神经代理.*(?:UTMOS|DNSMOS|NISQA)|(?:UTMOS|DNSMOS|NISQA).*神经代理/, `${name} should distinguish subjective MOS vs neural proxies`);
            assert.match(text, /Demo.*试听|试听.*Demo/, `${name} should include Demo listening pointer`);
            assert.match(text, /留一会话/, `${name} should allow natural Chinese singular phrases`);
            assert.match(text, /图形处理器.*中央处理器|图形处理器\/中央处理器/, `${name} should forbid GPU/CPU mistranslations`);
        }

        // KV static prefix ratio remains >= 90%
        const dynIdx = readerPrompt.lastIndexOf('<paper_input>');
        assert.ok(dynIdx > 0);
        assert.ok(dynIdx / readerPrompt.length >= 0.90, `KV static prefix ratio dipped: ${(dynIdx / readerPrompt.length).toFixed(3)}`);
    });
});

describe('PC-P1-5 + PC-P2-1: Typography masking, SMOS/CMOS/DMOS, extended v5 units & scoped explicitScoreUnit', () => {
    it('masks fenced code, inline backticks, LaTeX math, and URLs in findNumericTypographyDefects while preserving prose indices', () => {
        const clean = [
            '参考实现见 https://github.com/audio-lab/codec2026年，详情见代码：',
            '```python',
            '层数=3层',
            'x = "共10个样本"',
            '```',
            '行内代码 `共12个` 与公式 \\(T=1\\)、$K=4$、$$L=8$$ 和 \\[N=16\\] 不应触发排版告警。'
        ].join('\n');
        assert.deepEqual(editorial.findNumericTypographyDefects(clean), []);

        const withProseDefect = clean + '\n实际模型包含3层解码器。';
        const findings = editorial.findNumericTypographyDefects(withProseDefect);
        assert.ok(findings.length >= 1, `Expected real prose defect after masked regions, got: ${JSON.stringify(findings)}`);
        const first = findings[0];
        assert.equal(withProseDefect.slice(first.index, first.index + first.match.length), first.match);
        assert.equal(first.line, withProseDefect.split('\n').length);
    });

    it('includes SMOS/CMOS/DMOS in AUDIO_METRIC_WHITELIST and v5 audio score masking, plus GiB/MiB/KiB/TB/Gbps/bps/FPS/RTFx/dB/Hz/kHz/MHz/s/秒', () => {
        for (const metric of ['SMOS', 'CMOS', 'DMOS']) {
            assert.ok(editorial.AUDIO_METRIC_WHITELIST.includes(metric), `Missing ${metric}`);
        }
        const validV5 = [
            '虽然 WER 下降，但 SMOS 从 3.65 提升到 4.18，CMOS 提升到 +0.42，DMOS 为 4.05。',
            '准确率提升的同时，显存占用为 16 GiB、缓存为 512 MiB 与 64 KiB、语料容量 2 TB，吞吐达 10 Gbps、码率 128 bps、帧率 30 FPS、速度 25 RTFx。',
            '在 -5 dB 噪声、16 kHz 与 48000 Hz 及 2.4 MHz 条件下，推理耗时 1.8 s（即 1.8 秒），错误率显著下降。',
            '该鼻音滤波器引入一对零点以降低 EER。'
        ];
        for (const s of validV5) {
            assert.deepEqual(
                editorial.findMissingComparisonUnits(s, { editorialProfile: format.STRUCTURED_EDITORIAL }),
                [],
                `Should pass on STRUCTURED_V5: ${s}`
            );
        }
        // Negative: negated SMOS/CMOS attribution or bare WER alongside SMOS MUST still fail
        assert.equal(
            editorial.findMissingComparisonUnits('这里变化不是 SMOS 提升到 4.18，而是 WER 降至 4.2。', { editorialProfile: format.STRUCTURED_EDITORIAL }).length,
            1
        );
        assert.equal(
            editorial.findMissingComparisonUnits('尽管 CMOS 提升到 +0.42，但 WER 从 12.4 降至 8.3。', { editorialProfile: format.STRUCTURED_EDITORIAL }).length,
            1
        );
    });

    it('scopes explicitScoreUnit to the matched delta span (catches condition % + bare WER delta, keeps unit-bound deltas valid)', () => {
        const mustCatchBoth = [
            '在 100% 干净语音条件下，WER 从 12.4 降至 8.3。',
            '在 100% 干净语音下 WER 从 12.4 降至 8.3。',
            '在 100% 干净语音条件下，WER 降低至 8.3。',
            '测试集 A 上准确率从 70% 提升到 80%，但测试集 B 上 WER 从 12.4 降至 8.3。'
        ];
        for (const s of mustCatchBoth) {
            assert.equal(
                editorial.findMissingComparisonUnits(s, { editorialProfile: format.STRUCTURED_EDITORIAL }).length,
                1,
                `Expected v5 to catch bare delta despite unrelated %: ${s}`
            );
            assert.equal(
                editorial.findMissingComparisonUnits(s).length,
                1,
                `Expected default profile to catch bare delta despite unrelated %: ${s}`
            );
        }
        assert.equal(
            editorial.findMissingComparisonUnits('在 100% 干净语音条件下，WER 降至 8.3。', { editorialProfile: format.STRUCTURED_EDITORIAL }).length,
            1
        );

        const mustPass = [
            '在 100% 干净语音条件下，WER 从 12.4% 降至 8.3%。',
            '在 100% 干净语音条件下，WER 降至 8.3%。',
            '在 100% 干净语音条件下，WER 从 0.124 降至 0.083。',
            '模型在 24 核 CPU 上将准确率提升了 3.2 个百分点。',
            '在 100% 干净语音条件下，WER 显著下降。'
        ];
        for (const s of mustPass) {
            assert.deepEqual(
                editorial.findMissingComparisonUnits(s, { editorialProfile: format.STRUCTURED_EDITORIAL }),
                [],
                `Should pass with unit-bound or ratio-scale delta: ${s}`
            );
        }
    });
});
