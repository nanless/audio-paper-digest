'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReaderProseFormatting } = require('../scripts/lib/reader-prose-normalization');
const { classifySingleClauseFirstPartyFacets } = require('../scripts/lib/reader-resource-binding');

test('prose normalization: never inserts bogus 个 after years, model/dataset versions, IDs, 第, or numbered labels', () => {
    const preserved = [
        '在 DCASE 2026 任务 1 中评测',
        '使用 BioDCASE 2026 数据集训练',
        '基于 Wav2vec 2.0 模型提取表征',
        '评测 DeepSpeak v1.1 数据集与 BEAT2 数据集',
        '在 SpeechOcean762 数据集与 ESC-50 数据集上对比',
        '使用 S5 系统与 D1 分支建模',
        '基于 (CAS) 2023 数据集验证',
        '对比 Tacotron 2 模型与 FastSpeech 2 系统',
        '第 2 阶段训练完成后评估',
        '阶段 2a 与任务 4 保持一致'
    ];
    for (const input of preserved) {
        const out = normalizeReaderProseFormatting(input);
        assert.ok(!out.includes('个'), `unexpected 个 in ${JSON.stringify(out)} from ${JSON.stringify(input)}`);
    }

    // Legitimate bare counts followed by punctuation/space/end must still receive 个.
    assert.match(normalizeReaderProseFormatting('包含 3 数据集，共 5 条件。'), /3 个数据集.*5 个条件/);
    assert.match(normalizeReaderProseFormatting('对比 4 基线、12 模型，以及 2 分支'), /4 个基线.*12 个模型.*2 个分支/);
});

test('reader-resource-binding: rescues PDF-hyphenated, section-headed, footnote-prefixed, and longer we...our first-party clauses while blocking third-party repos', () => {
    // 1. PDF line-break hyphenated lowercase descriptor
    assert.deepEqual(
        classifySingleClauseFirstPartyFacets(
            'Ex-\ntraction and analysis code is available at https://github.com/alefiury/Echoes-Platos-Cave.'
        ),
        ['code']
    );

    // 2. Leading numbered section heading
    assert.deepEqual(
        classifySingleClauseFirstPartyFacets(
            '6 Open Access Statement Our code and dataset are publicly available at https://github.com/example/my-audio-repo.'
        ),
        ['code', 'dataset']
    );

    // 3. Leading footnote digit glued to All/Our/Code
    assert.deepEqual(
        classifySingleClauseFirstPartyFacets(
            '1All accompanying code is publicly released at https://github.com/example/clinical-wer.'
        ),
        ['code']
    );

    // 4. Longer "We ... and release our code" clause (> 40 chars between We and our)
    assert.deepEqual(
        classifySingleClauseFirstPartyFacets(
            'We report results on the full set and release our code, including a list of overlap-free clips (https://github.com/Jonathan-Greif/silent-failure-sed).'
        ),
        ['code']
    );

    // Negative cases: named third-party repositories, citations, consumption verbs, and possessives MUST remain third_party!
    assert.deepEqual(
        classifySingleClauseFirstPartyFacets(
            'Whisper code is publicly available at https://github.com/openai/whisper.'
        ),
        ['third_party']
    );
    assert.deepEqual(
        classifySingleClauseFirstPartyFacets(
            'We evaluate Qwen2.5-Omni code available at https://github.com/QwenLM/Qwen2.5-Omni.'
        ),
        ['third_party']
    );
    assert.deepEqual(
        classifySingleClauseFirstPartyFacets(
            'Their extraction and analysis code is available at https://github.com/other/repo.'
        ),
        ['third_party']
    );
    assert.deepEqual(
        classifySingleClauseFirstPartyFacets(
            'We follow the baseline code available at https://github.com/other/repo (Smith et al., 2024).'
        ),
        ['third_party']
    );
});
