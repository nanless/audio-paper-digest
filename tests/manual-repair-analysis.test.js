const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { validAnalysisText } = require('./valid-analysis-fixture.js');
const { enrichAnalysis, selectEvidence } = require('../scripts/manual-repair-analysis.js');
const { parseAnalysis } = require('../scripts/utils.js');

const forbiddenEditorial = /第\s*(?:\d+|[一二三四五六七八九十]+)\s*个证据块|证据块|结果证据\s*\d+|方法事实\s*\d+|实验事实\s*\d+|实现细节\s*\d+|实验\/部署细节\s*\d+|论文的核心贡献形态|可执行的音频|对音频读者而言/i;

describe('manual full-text repair quality', () => {
    it('does not select author metadata or diagram glue as method/result evidence', () => {
        const source = [
            'A Paper Author University author@example.org',
            '1 Introduction The problem matters for speech systems and prior work is extensive.',
            '2 Methods The waveform is converted into 80-bin log-mel features and passed to an encoder and decoder.',
            'The model is trained for 100 epochs with a 10 ms hop and outputs a token sequence.',
            '3 Results On the held-out test set the proposed recognizer reports WER falling from 12.4% to 10.1% under the same noise and speaker split, while an ablation removes the context module.',
            'executionAudioLog-mel front endFixed xxx^ diagram glue.'
        ].join('\n');
        const methods = selectEvidence(source, 'method', 3).join('\n');
        const results = selectEvidence(source, 'results', 3).join('\n');
        assert.doesNotMatch(methods, /author@example|A Paper Author|executionAudio|xxx\^/i);
        assert.match(methods, /log-mel|encoder|decoder/i);
        assert.doesNotMatch(results, /author@example|executionAudio|xxx\^/i);
        assert.match(results, /WER|12\.4|10\.1/i);
    });

    it('renders reader-facing prose instead of evidence-block/editorial scaffolding', () => {
        const source = [
            '2 Methods The waveform is converted into log-mel features before encoding.',
            'The encoder predicts a token sequence with a supervised objective.',
            '3 Results WER decreases from 12.4% to 10.1% on the held-out test set under the same speaker split, noise condition, decoding budget and evaluation protocol.',
            'The ablation removes the context module and reports a 1.8 point degradation while keeping the feature extractor, training data and decoder unchanged.',
            'The held-out evaluation uses fixed preprocessing, the same sampling rate, identical decoding parameters, and a speaker-disjoint test split for every baseline.',
            'The implementation reports the optimizer, batch size, training schedule, validation selection and inference-time output format as part of the reproducible setup.',
            'The encoder receives normalized acoustic features, applies the context module, and exposes an intermediate representation to the decoder before the final sequence is scored.',
            'The deployment protocol fixes the input window, hop size, latency measurement boundary and error aggregation rule so comparisons do not mix model quality with preprocessing changes.',
            'The evaluation repeats the same protocol across clean and noisy conditions and records the error metric, confidence range, baseline configuration and compute budget for each comparison.',
            'The reported inference path preserves the feature normalization, context state, decoder vocabulary and output timing used during evaluation rather than changing them for deployment.'
        ].join('\n');
        const analysis = enrichAnalysis(validAnalysisText(), source, { imageManifest: { candidates: [] } });
        const parsed = parseAnalysis(analysis);
        assert.doesNotMatch(analysis, forbiddenEditorial);
        assert.match(parsed.architecture, /输入|模块|训练|推理/);
        assert.match(parsed.results, /12\.4|10\.1|WER/);
        assert.match(parsed.innovation, /输入|模块|实验|数据流/);
        assert.ok((parsed.details.match(/[\u4e00-\u9fff]/g) || []).length >= 450);
        assert.ok((parsed.limitations.match(/[\u4e00-\u9fff]/g) || []).length >= 200);
    });
});
