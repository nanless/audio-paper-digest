'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Config = require('../scripts/config.js');
const prefilter = require('../scripts/lib/daily-filter-prefilter.js');
const scope = require('../scripts/lib/filter-scope-evidence.js');
const sources = require('../scripts/lib/fresh-arxiv-rewrite-source.js');
const protocolCodec = require('../scripts/lib/protocol-codec.js');
const fetchPapers = require('../scripts/fetch-papers.js');
const fullFetch = require('../scripts/full-fetch.js');
const utils = require('../scripts/utils.js');

const BATCH_DATE = '2026-11-27';

function withIsolatedSources(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-filter-recall-scope-'));
    const orig = Config.FILES.freshArxivFetchedSourcesDir;
    Config.FILES.freshArxivFetchedSourcesDir = path.join(root, 'sources');
    t.after(() => {
        Config.FILES.freshArxivFetchedSourcesDir = orig;
        fs.rmSync(root, { recursive: true, force: true });
    });
    return root;
}

function makeMultimodalPaper(id, overrides = {}) {
    return {
        arxivId: id,
        paper_id: id,
        title: 'A Unified Multimodal Representation Study',
        abstract: 'We study multimodal representations and evaluate general cross-modal reasoning benchmarks across diverse tasks.',
        categories: ['cs.AI'],
        ...overrides
    };
}

function makeOfficialOverrides(text) {
    return {
        fetchText: async id => ({
            text,
            source: 'html',
            sourceId: `${id}v1`,
            url: `https://arxiv.org/html/${id}v1`,
            fetchedAt: '2026-11-27T00:00:00.000Z'
        }),
        fetchPdf: async id => ({
            bytes: Buffer.from(`%PDF-1.7\nOfficial ${id}\n%%EOF\n`),
            url: `https://arxiv.org/pdf/${id}.pdf`,
            fetchedAt: '2026-11-27T00:00:01.000Z'
        })
    };
}

function makeFilterOptions(text, decisionFn) {
    return {
        batchSize: 2,
        delayBetweenBatches: 0,
        decisionMetadata: {
            batchDate: BATCH_DATE,
            filterModel: 'local-test-model',
            filterPromptHash: fullFetch.getFilterPromptHash()
        },
        decisionOptions: {
            scopeSourceOverrides: makeOfficialOverrides(text)
        },
        decisionFn
    };
}

describe('F1 & F2: Full-text body-anchor exclusion & 30K LLM excerpt recall guarantees', () => {
    it('Dot minimal repro: deep speaker verification at offset 95k survives noisy sound/codec/F0 flooding in both body-anchor & 30K excerpt', async t => {
        withIsolatedSources(t);
        // Flood first 94k chars with noisy non-anchor terms (sound/codec/F0/pitch/chord/voice)
        const noisyBlock = 'Our video compression codec preserves visual F0 statistics and sounds smooth across chord graphs and pitch angles with a unified voice of design. ';
        const prefix = noisyBlock.repeat(Math.ceil(95000 / noisyBlock.length)).slice(0, 95000);
        const deepTarget = 'Section 6.4 Speaker Verification Benchmark: We evaluate speaker verification EER on unseen target identities with frozen encoders. ';
        const suffix = 'Neutral closing ablation summary on image grids and text comprehension benchmarks. '.repeat(120);
        const fullText = prefix + deepTarget + suffix;
        assert.ok(fullText.length > 104000);

        // 1) Direct 30K excerpt check: budget <= 30,000 and MUST contain the deep speaker verification window
        const excerpt = scope.selectScopeText(fullText);
        assert.ok(excerpt.length <= scope.MAX_SCOPE_CHARACTERS_V2);
        assert.equal(excerpt.isWellFormed(), true);
        assert.match(excerpt, /speaker verification/i);

        // 2) Full-text capture + end-to-end filterPapersWithLLM: passes $0 body anchor and reaches LLM with speaker verification in prompt excerpt
        const candidate = makeMultimodalPaper('2611.95001');
        let llmSeenExcerpt = '';
        let savedSnapshot = null;
        const selected = await fetchPapers.filterPapersWithLLM([candidate], {
            ...makeFilterOptions(fullText, async input => {
                llmSeenExcerpt = input.filterScopeEvidence.text;
                return {
                    related: true,
                    reason: '正文第 6.4 节包含 speaker verification 实验',
                    rawResponse: '{"related":true}',
                    parseSource: 'json',
                    retryable: false,
                    fallback: false
                };
            }),
            onBatchComplete: async snap => { savedSnapshot = snap; }
        });
        assert.equal(selected.length, 1);
        assert.ok(llmSeenExcerpt.length <= scope.MAX_SCOPE_CHARACTERS_V2);
        assert.match(llmSeenExcerpt, /speaker verification/i);
        assert.equal(savedSnapshot.decisions[candidate.arxivId].related, true);

        // 3) F1 fail-closed verification: forging scope_body_audio_anchor_prefilter against this full text MUST throw
        const { evidence } = await scope.captureFilterScopeEvidenceWithFullText(candidate, BATCH_DATE, makeOfficialOverrides(fullText));
        const forged = {
            id: candidate.arxivId,
            paper_id: candidate.arxivId,
            title: candidate.title,
            related: false,
            reason: 'forged body anchor rejection',
            rawResponse: '',
            parseSource: 'scope_body_audio_anchor_prefilter',
            error: null,
            fallback: false,
            retryable: false,
            decidedAt: '2026-11-27T00:00:00.000Z',
            filterScopeEvidence: evidence,
            inputSha256: fetchPapers.buildFilterInputSha256(candidate, evidence),
            batchDate: BATCH_DATE
        };
        assert.throws(
            () => scope.validatedDecisionInputSha256(candidate, forged, { batchDate: BATCH_DATE }),
            /官方全文 References 前正文含音频锚点/
        );
    });

    it('preserves a strong anchor straddling the 10,000-char intro boundary ([9990, 10010]) without slicing it', () => {
        const neutral = 'Visual layout analysis and structured document modeling without auditory signals. ';
        const before = neutral.repeat(Math.ceil(9990 / neutral.length)).slice(0, 9990);
        const anchor = 'speaker verification';
        const after = neutral.repeat(500);
        const fullText = before + anchor + after;
        assert.equal(fullText.slice(9990, 10010), 'speaker verification');

        const excerpt = scope.selectScopeText(fullText);
        assert.ok(excerpt.length <= scope.MAX_SCOPE_CHARACTERS_V2);
        assert.equal(excerpt.isWellFormed(), true);
        assert.ok(excerpt.includes('speaker verification'), 'boundary-straddling anchor must appear intact');
    });

    it('diversity-first Pass 1 selects a rare deep anchor amid 50x repeated waveform occurrences', () => {
        const chunk = 'We analyze the simulated radar waveform evolution across fifty distinct geometric test benches and report grid stability metrics. ';
        let body = 'Introduction to general physical modeling and differential equations across synthetic grids. '.repeat(120);
        // 50 spatially spread waveform occurrences across the body
        for (let i = 0; i < 50; i += 1) {
            body += `Experiment ${i}: ` + chunk.repeat(12);
        }
        const rareDeep = 'Section 9.2 Unexpected Audio Transfer: We additionally evaluate VoxCeleb and speaker verification transfer with Moshi tokens. ';
        body += rareDeep + 'Neutral concluding remarks on numerical integration and matrix sparsity. '.repeat(80);
        assert.ok(body.length > 90000);

        const excerpt = scope.selectScopeText(body);
        assert.ok(excerpt.length <= scope.MAX_SCOPE_CHARACTERS_V2);
        assert.match(excerpt, /VoxCeleb/);
        assert.match(excerpt, /speaker verification/i);
        assert.match(excerpt, /Moshi/);
    });

    it('uses Tier-2 qualified anchors only when Tier-1 slots remain and ignores noisy bare sound/voice/codec/F0/pitch/chord', () => {
        const neutral = 'Structured symbolic graph processing and algebraic topology experiments without acoustic sensors. ';
        const textWithTier2 = neutral.repeat(200)
            + 'Section 4 Symbolic Composition: We evaluate MIDI generation, beat-tracking accuracy, chord recognition, and timbre transfer. '
            + neutral.repeat(300);
        const excerptTier2 = scope.selectScopeText(textWithTier2);
        assert.ok(excerptTier2.length <= scope.MAX_SCOPE_CHARACTERS_V2);
        assert.match(excerptTier2, /MIDI/);
        assert.match(excerptTier2, /beat-tracking/);
        assert.match(excerptTier2, /chord recognition/);

        // Noisy bare terms alone should NOT displace a real Tier-2 anchor
        const noisySpam = 'A sound proof of codec efficiency with F0 score, pitch angle, chord length, and editorial voice. ';
        const textNoisyPlusTier2 = noisySpam.repeat(300)
            + 'Section 8 Symbolic Music Task: We evaluate sheet music alignment and fundamental frequency contours. '
            + noisySpam.repeat(300);
        const excerptClean = scope.selectScopeText(textNoisyPlusTier2);
        assert.ok(excerptClean.length <= scope.MAX_SCOPE_CHARACTERS_V2);
        assert.match(excerptClean, /sheet music/);
        assert.match(excerptClean, /fundamental frequency/);
    });

    it('blocks References-only audio leak on FULL sealed text and excludes References from Tier-1 anchor sampling', async t => {
        withIsolatedSources(t);
        const visualBody = 'Section 2 Visual Geometry: We train a multimodal vision-language backbone on static RGB images, 3D point clouds, and document OCR layouts. '.repeat(350);
        const refs = '\n\nReferences\n'
            + '[1] Radford et al. Robust Speech Recognition via Large-Scale Weak Supervision (Whisper). ICML 2023.\n'
            + '[2] Gemmeke et al. AudioSet: An ontology and human-labeled dataset for audio events. ICASSP 2017.\n'
            + '[3] Hsu et al. HuBERT: Self-Supervised Speech Representation Learning. IEEE/ACM TASLP 2021.\n'.repeat(20);
        const fullText = visualBody + refs;
        assert.ok(fullText.length > 50000);

        // Excerpt must NOT chase Whisper/AudioSet/HuBERT inside References
        const excerpt = scope.selectScopeText(fullText);
        assert.ok(excerpt.length <= scope.MAX_SCOPE_CHARACTERS_V2);
        assert.ok(!excerpt.includes('AudioSet'), 'References-only AudioSet must not be sampled as an excerpt anchor');
        assert.ok(!excerpt.includes('HuBERT'), 'References-only HuBERT must not be sampled as an excerpt anchor');

        // Full-text deterministic rejection at $0
        const candidate = makeMultimodalPaper('2611.95002');
        let llmCalls = 0;
        let savedSnapshot = null;
        const selected = await fetchPapers.filterPapersWithLLM([candidate], {
            ...makeFilterOptions(fullText, async () => {
                llmCalls += 1;
                return { related: true, reason: 'unexpected', rawResponse: '{}', parseSource: 'json', retryable: false, fallback: false };
            }),
            onBatchComplete: async snap => { savedSnapshot = snap; }
        });
        assert.equal(llmCalls, 0);
        assert.equal(selected.length, 0);
        const dec = savedSnapshot.decisions[candidate.arxivId];
        assert.equal(dec.parseSource, 'scope_body_audio_anchor_prefilter');
        assert.equal(dec.related, false);
        assert.equal(
            scope.validatedDecisionInputSha256(candidate, dec, { batchDate: BATCH_DATE }),
            dec.inputSha256
        );
    });
});

describe('F4: Segment-aware References stripping & Appendix preservation', () => {
    const bibEntries = [
        '[1] A. Radford et al. Robust Speech Recognition via Large-Scale Weak Supervision (Whisper). Proceedings of ICML 2023, pp. 12-24.',
        '[2] J. Gemmeke et al. AudioSet: An ontology and human-labeled dataset for audio events. IEEE ICASSP 2017, vol. 1, pp. 776-780.',
        '[3] W. Hsu et al. HuBERT: Self-Supervised Speech Representation Learning. arXiv:2106.07447, 2021.',
        '[4] S. Chen et al. WavLM: Large-Scale Self-Supervised Pre-Training for Full Stack Speech Processing. IEEE JSTSP 2022.',
        '[5] A. Defossez et al. High Fidelity Neural Audio Compression (EnCodec). arXiv:2210.13438, 2022.'
    ].join('\n');

    it('preserves Appendix after References (including early <40% References with >=2 bib signals)', () => {
        // Main body is ~25% of total length, References is ~10%, Appendix is ~65%
        const mainBody = 'Section 1 Introduction: We present a unified multimodal transformer architecture evaluated across diverse tasks. '.repeat(80);
        const refs = `\n\nReferences\n${bibEntries}\n${bibEntries}\n`;
        const appendix = '\n\nAppendix A: Additional Audio and Speech Benchmarks\n'
            + 'In this appendix we evaluate zero-shot LibriSpeech transcription and FunASR latency across noisy environments. '.repeat(220);
        const fullText = mainBody + refs + appendix;

        const refOffset = fullText.indexOf('References');
        assert.ok(refOffset / fullText.length >= 0.20 && refOffset / fullText.length < 0.40,
            `expected early References ratio in [0.20, 0.40), got ${(refOffset / fullText.length).toFixed(3)}`);

        const segments = prefilter.getNonReferencesSegments(fullText);
        assert.equal(segments.length, 2, 'should emit Main Body segment and Appendix segment');

        const stripped = prefilter.stripReferencesFromScopeText(fullText);
        assert.ok(!stripped.includes('Gemmeke et al.'), 'References entries must be stripped');
        assert.ok(!stripped.includes('AudioSet'), 'References-only AudioSet must be stripped');
        assert.ok(stripped.includes('Appendix A: Additional Audio and Speech Benchmarks'), 'Appendix heading must be preserved');
        assert.ok(stripped.includes('LibriSpeech'), 'Appendix audio benchmark must be preserved');
        assert.ok(stripped.includes('FunASR'), 'Appendix modern audio model must be preserved');

        const anchorCheck = prefilter.evaluateScopeBodyAudioAnchor(fullText, { categories: ['cs.AI'] });
        assert.equal(anchorCheck.pass, true);
        assert.match(anchorCheck.matchedAnchor, /audio|speech|LibriSpeech|FunASR/i);

        const excerpt = scope.selectScopeText(fullText);
        assert.ok(excerpt.length <= scope.MAX_SCOPE_CHARACTERS_V2);
        assert.ok(!excerpt.includes('Gemmeke et al.'));
        assert.match(excerpt, /LibriSpeech|FunASR/);
    });

    it('detects invisible-char (References\\u200b) and Markdown (## References, ### **References**) headings', () => {
        const body = 'We train a purely visual document layout model over scanned PDF pages and tables. '.repeat(80);
        for (const heading of ['References\u200b', '## References', '### **References**', '**BIBLIOGRAPHY:**', '7.1 References 14']) {
            const doc = `${body}\n\n${heading}\n${bibEntries}\n`;
            const stripped = prefilter.stripReferencesFromScopeText(doc);
            assert.ok(!stripped.includes('AudioSet'), `heading "${heading}" should strip References`);
            assert.equal(prefilter.evaluateScopeBodyAudioAnchor(doc, { categories: ['cs.CV'] }).pass, false,
                `heading "${heading}" should block References-only audio leak`);
        }
    });

    it('never false-cuts lowercase JSON/table "references" or non-bibliography table headers', () => {
        const bodyBefore = 'We design a multimodal architecture and serialize schema metadata cleanly. '.repeat(60);
        const jsonSchemaBlock = '\n{\n  "references": [\n    "doc_a",\n    "doc_b"\n  ]\n}\nreferences\n';
        const bodyAfter = 'Section 5 Audio Evaluation: We evaluate speech recognition with Whisper and mel-spectrogram encoders. '.repeat(60);
        const docJson = bodyBefore + jsonSchemaBlock + bodyAfter;

        assert.deepEqual(prefilter.getNonReferencesSegments(docJson), [[0, docJson.length]]);
        assert.equal(prefilter.evaluateScopeBodyAudioAnchor(docJson, { categories: ['cs.AI'] }).pass, true);

        // Capitalized "References" as a table column label in middle of paper with 0 bib signals and >2000 trailing chars
        const tableSection = '\nReferences\n12.4\n15.8\n19.2\nAccuracy\n88.1\n91.3\n' + bodyAfter;
        const docTable = bodyBefore + tableSection;
        assert.deepEqual(prefilter.getNonReferencesSegments(docTable), [[0, docTable.length]]);
        assert.equal(prefilter.evaluateScopeBodyAudioAnchor(docTable, { categories: ['cs.AI'] }).pass, true);
    });

    it('handles duplicate Main References + Appendix + Appendix References cleanly', () => {
        const mainBody = 'Section 1 Main Body: Visual foundation pretraining over images and captions. '.repeat(80);
        const mainRefs = `\n\nReferences\n${bibEntries}\n`;
        const appendix = '\n\n**A.1 Audio Evaluation Protocol**\nWe evaluate audiovisual dubbing and lip-sync consistency on unseen clips. '.repeat(45);
        const appendixRefs = `\n\n## References\n[6] K. Author et al. Unrelated Citation on Birdsong. IEEE ICASSP 2024.\n[7] M. Writer et al. Second Citation. NeurIPS 2025.\n`;
        const fullText = mainBody + mainRefs + appendix + appendixRefs;

        const segments = prefilter.getNonReferencesSegments(fullText);
        assert.equal(segments.length, 2, 'should keep Main Body and Appendix while stripping both References blocks');

        const stripped = prefilter.stripReferencesFromScopeText(fullText);
        assert.ok(!stripped.includes('Gemmeke et al.'), 'main References must be stripped');
        assert.ok(!stripped.includes('Birdsong'), 'appendix References must be stripped');
        assert.ok(stripped.includes('audiovisual dubbing'), 'Appendix audio content must be kept');
        assert.equal(prefilter.evaluateScopeBodyAudioAnchor(fullText, { categories: ['cs.AI'] }).pass, true);
    });
});

describe('F3 & F5: Prefilter recall fixes (cross-listed cs.AI/cs.CV, CardioState-JEPA, acronym isolation, anchors, withdrawn guard)', () => {
    it('F3: cross-listed cs.AI/cs.LG/cs.CL papers with cs.CV/cs.HC are NOT rejected by cs.CV/cs.HC flood gate while pure cs.CV/cs.HC still are', () => {
        const baseAbstract = 'We propose a unified multimodal foundation architecture for cross-modal representation learning and general reasoning benchmarks.';
        for (const cats of [['cs.AI', 'cs.CV'], ['cs.LG', 'cs.CV'], ['cs.CL', 'cs.HC'], ['cs.MM', 'cs.CV']]) {
            const res = prefilter.evaluateDailyFilterPrefilter({
                title: 'Unified Multimodal Foundation Model',
                abstract: baseAbstract,
                categories: cats
            });
            assert.equal(res.pass, true, `cross-listed ${cats.join(',')} must NOT be rejected by cs.CV/cs.HC flood gate`);
        }

        for (const cats of [['cs.CV'], ['cs.HC'], ['cs.CV', 'cs.HC']]) {
            const res = prefilter.evaluateDailyFilterPrefilter({
                title: 'Unified Multimodal Foundation Model',
                abstract: baseAbstract,
                categories: cats
            });
            assert.equal(res.pass, false, `pure ${cats.join(',')} without audiovisual anchor must still be rejected`);
            assert.equal(res.dailyFilterPrefilterRule, 'non_audio_cv_hc_without_audio_anchor');
        }
    });

    it('F5: CardioState-JEPA phonocardiography passes (both with ECG+waveform and phonocardiography-only), while pure ECG+PCG without phonocardiography stays rejected', () => {
        const cardioWithEcgWaveform = prefilter.evaluateDailyFilterPrefilter({
            title: 'CardioState-JEPA: Multimodal Cardiac Signal Representation Learning',
            abstract: 'We pretrain joint embeddings across 12-lead ECG and phonocardiography waveform recordings to detect valvular abnormalities in clinical cohorts.',
            categories: ['eess.SP', 'cs.LG']
        });
        assert.equal(cardioWithEcgWaveform.pass, true);

        const cardioPhonoOnly = prefilter.evaluateDailyFilterPrefilter({
            title: 'CardioState-JEPA: Self-Supervised Phonocardiography Pretraining',
            abstract: 'We introduce a joint-embedding predictive architecture trained on clinical phonocardiogram datasets for automated screening across hospital cohorts.',
            categories: ['cs.LG']
        });
        assert.equal(cardioPhonoOnly.pass, true);

        // Pure ECG + bare PCG (NOT phonocardiography) must still be rejected as non_audio_waveform
        const pureEcgBarePcg = prefilter.evaluateDailyFilterPrefilter({
            title: 'ECG and PCG Waveform Denoising on Wearable Sensors',
            abstract: 'We denoise 12-lead electrocardiogram (ECG) and PCG waveform traces collected from cardiac monitor patches in clinical trials.',
            categories: ['eess.SP']
        });
        assert.equal(pureEcgBarePcg.pass, false);
        assert.equal(pureEcgBarePcg.dailyFilterPrefilterRule, 'non_audio_waveform');
    });

    it('F5: eliminates acronym cross-contamination (TTS + MOS + CER + standard deviation (SD) MUST PASS)', () => {
        const ttsWithLiteralSd = prefilter.evaluateDailyFilterPrefilter({
            title: 'Evaluating Zero-Shot TTS Systems Across Multiple Languages',
            abstract: 'We report MOS and CER with standard deviation (SD) across 10 languages for our neural TTS framework on standard evaluation splits.',
            categories: ['cs.CL']
        });
        assert.equal(ttsWithLiteralSd.pass, true, 'disambiguating SD must NOT cross-contaminate TTS/MOS/CER');

        // Pure Stable Diffusion (SD) still rejected
        const pureSd = prefilter.evaluateDailyFilterPrefilter({
            title: 'Fast SD Distillation for Image Generation',
            abstract: 'We distill Stable Diffusion (SD) checkpoints to 4 steps for high-resolution image synthesis on consumer GPUs.',
            categories: ['cs.LG']
        });
        assert.equal(pureSd.pass, false);
        assert.equal(pureSd.dailyFilterPrefilterRule, 'non_audio_sd_vc_sdr_tts');

        // When ALL matched ambiguous tokens are disambiguated (TTS=test-time scaling AND SD=Stable Diffusion), STILL rejected
        const bothDisambiguated = prefilter.evaluateDailyFilterPrefilter({
            title: 'Test-Time Scaling (TTS) for Stable Diffusion (SD)',
            abstract: 'We apply test-time scaling (TTS) search budgets to Stable Diffusion (SD) latent trajectories for sharper image synthesis.',
            categories: ['cs.LG']
        });
        assert.equal(bothDisambiguated.pass, false);
        assert.equal(bothDisambiguated.dailyFilterPrefilterRule, 'non_audio_sd_vc_sdr_tts');
    });

    it('F5: recognizes audiovisual, Moshi, FunASR, CLAP, AVSR, HRTF, lip-sync, dubbing, foley, screen reader, ESC-50, FSD50K, VGGSound in body anchor & excerpt while ignoring lowercase "clap"', () => {
        const padding = 'We study general neural network architectures and scaling laws on synthetic reasoning tasks. '.repeat(60);
        const positiveAnchors = [
            'audiovisual alignment',
            'Moshi duplex interaction',
            'FunASR streaming model',
            'SenseVoice multilingual model',
            'CLAP contrastive embeddings',
            'AVSR visual-acoustic fusion',
            'HRTF personalization',
            'lip-sync fidelity',
            'neural dubbing',
            'foley synthesis',
            'soundscape generation',
            'data sonification',
            'talking-avatar animation',
            'screen reader navigation',
            'LAION-CLAP retrieval',
            'ESC-50 zero-shot classification',
            'FSD50K tagging',
            'VGGSound benchmark',
            'CREMA-D evaluation',
            'Kinetics-Sounds transfer',
            'UrbanSound8K scenes',
            'phonocardiography screening',
            'voice interface design',
            '音视频联合建模',
            '口型同步评测'
        ];
        for (const phrase of positiveAnchors) {
            const fullText = `${padding} Section 4: We evaluate ${phrase} across held-out splits. ${padding}`;
            const anchor = prefilter.evaluateScopeBodyAudioAnchor(fullText, { categories: ['cs.AI'] });
            assert.equal(anchor.pass, true, `body anchor MUST accept "${phrase}"`);

            // Also verify 30K excerpt captures deep occurrence beyond intro
            const deepText = padding.repeat(5) + ` Section 7 Deep Evaluation: We measure ${phrase} accurately. ` + padding.repeat(3);
            assert.ok(deepText.length > 35000);
            const excerpt = scope.selectScopeText(deepText);
            assert.ok(excerpt.length <= scope.MAX_SCOPE_CHARACTERS_V2);
            assert.ok(excerpt.includes(phrase), `30K excerpt MUST capture deep "${phrase}"`);
        }

        // Case-sensitive guard: lowercase "clap" in non-audio prose MUST NOT trigger CLAP anchor
        const lowercaseClap = `${padding} Participants in the video frequently clap their hands during celebration gestures. ${padding}`;
        assert.equal(prefilter.evaluateScopeBodyAudioAnchor(lowercaseClap, { categories: ['cs.CV'] }).pass, false);
    });

    it('F5 (P2): withdrawn guard does not falsely reject non-arXiv earlier-version withdrawal notes while still blocking real arXiv withdrawals', () => {
        assert.equal(prefilter.isWithdrawnArxivPaper({
            title: 'Neural Speech Codec Improvements',
            abstract: 'We introduce a low-bitrate neural speech codec evaluated on LibriSpeech.',
            comment: 'An earlier version of this paper was withdrawn from ICLR 2026.'
        }), false);
        assert.equal(prefilter.isWithdrawnArxivPaper({
            title: 'Streaming ASR',
            abstract: 'We improve streaming automatic speech recognition.',
            comment: 'A previous version of this manuscript has been withdrawn from NeurIPS 2025 for further revision.'
        }), false);

        assert.equal(prefilter.isWithdrawnArxivPaper({
            title: 'Withdrawn Speech Paper',
            abstract: 'We study speech synthesis.',
            comment: 'This paper has been withdrawn by the authors due to a critical data leak.'
        }), true);
        assert.equal(prefilter.isWithdrawnArxivPaper({
            title: 'Withdrawn Paper',
            abstract: 'We study audio generation.',
            comment: 'Withdrawn from arXiv due to an error in Section 3.'
        }), true);
        // R35-Rev P1-2: explicit arXiv withdrawals mentioning a previous version or prior venue withdrawal MUST still return true
        for (const withdrawnComment of [
            'Because the previous version had a bug, this paper has been withdrawn from arXiv',
            'As noted in the previous version, this paper has been withdrawn by the authors',
            'This paper was previously accepted to NeurIPS 2026 Workshop and is withdrawn from arXiv',
            'This paper has been withdrawn from arXiv; an earlier version was withdrawn from ICLR 2026.'
        ]) {
            assert.equal(prefilter.isWithdrawnArxivPaper({
                title: 'Withdrawn Audio Paper',
                abstract: 'We evaluate audio representations.',
                comment: withdrawnComment
            }), true, `genuine arXiv withdrawal must be detected: ${withdrawnComment}`);
        }
        // Non-arXiv / negated / replacement comments MUST remain false
        for (const nonWithdrawnComment of [
            'Withdrawn from ICML 2026 workshop; accepted to NeurIPS 2026',
            'This paper was never withdrawn from arXiv',
            'Replaces a previous withdrawn preprint',
            'Replaces a previously withdrawn paper on speech coding'
        ]) {
            assert.equal(prefilter.isWithdrawnArxivPaper({
                title: 'Active Audio Paper',
                abstract: 'We evaluate speech codecs.',
                comment: nonWithdrawnComment
            }), false, `non-withdrawal comment must not be flagged: ${nonWithdrawnComment}`);
        }
    });

    it('R35-Rev P1-1: acronym disambiguation never cross-contaminates co-occurring omni-modal or multimodal emotion tokens in cs.AI/cs.LG/cs.CL', () => {
        const cases = [
            {
                title: 'OmniX: Unified Omni-Modal Foundation Model',
                abstract: 'We evaluate unified omni-modal representations across diverse benchmarks and report mean and standard deviation (SD) over 5 runs.',
                categories: ['cs.AI']
            },
            {
                title: 'Test-Time Scaling for Omni-Modal Reasoning',
                abstract: 'We analyze test-time scaling (TTS) compute laws for omni-modal reasoning agents on cross-modal tasks.',
                categories: ['cs.LG']
            },
            {
                title: 'Multimodal Emotion Recognition from Video and Clinical Interviews',
                abstract: 'We study multimodal emotion recognition from recorded interviews and report mean and standard deviation (SD) across clinical folds.',
                categories: ['cs.CL']
            },
            {
                title: 'Evaluating Jailbreak Safety of Multimodal Foundation Models',
                abstract: 'We measure attack success rate (ASR) under multimodal jailbreak prompts across general foundation models.',
                categories: ['cs.AI']
            }
        ];
        for (const paper of cases) {
            const res = prefilter.evaluateDailyFilterPrefilter(paper);
            assert.equal(res.pass, true, `must pass prefilter (never killed at $0 by acronym disambiguation): ${paper.title}`);
            assert.equal(res.dailyFilterPrefilterRule, null, `must not trigger rejection rule: ${paper.title}`);
        }
        // Pure cs.CV multimodal ViTs without audiovisual anchor still blocked by cs.CV/cs.HC flood gate
        const pureCvVits = prefilter.evaluateDailyFilterPrefilter({
            title: 'Multimodal ViTs for 3D Object Detection',
            abstract: 'We train vision transformer (ViTs) backbones on multimodal RGB-D and LiDAR benchmarks.',
            categories: ['cs.CV']
        });
        assert.equal(pureCvVits.pass, false);
        assert.equal(pureCvVits.dailyFilterPrefilterRule, 'non_audio_cv_hc_without_audio_anchor');
    });

    it('R35-Rev P1-3: strips early unnumbered author-year References, supports space-separated/digit/long Appendix headings, and ignores wrapped Supplementary citation titles', () => {
        // 1) Unnumbered author-year NeurIPS/ICML bibliography at ~28% with huge visual Appendix
        const mainVisual = 'Section 1 Visual Backbone: We study dense visual correspondence on static RGB images. '.repeat(60);
        const authorYearRefs = '\n\nReferences\n'
            + 'Alec Radford, Jong Wook Kim, Tao Xu, Greg Brockman, Christine McLeavey, and Ilya Sutskever. Robust speech recognition via large-scale weak supervision. International Conference on Machine Learning, pages 28492-28518. PMLR, 2023.\n'
            + 'Jort F. Gemmeke, Daniel P. W. Ellis, Dylan Freedman, Aren Jansen, Wade Lawrence, R. Channing Moore, Manoj Plakal, and Marvin Ritter. AudioSet: An ontology and human-labeled dataset for audio events. Advances in Neural Information Processing Systems, pages 101-112, 2022.\n'
            + 'Alexei Baevski, Yuhao Zhou, Abdelrahman Mohamed, and Michael Auli. wav2vec 2.0: A framework for self-supervised learning of speech representations. Journal of Machine Learning Research, pages 1-24, 2020.\n'.repeat(2);
        const hugeVisualAppendix = '\n\nAppendix A Additional Visual Ablation Results Without Colon Separator\n'
            + 'We present extra image segmentation heatmaps and bounding box tables across static camera datasets. '.repeat(140);
        const authorYearDoc = mainVisual + authorYearRefs + hugeVisualAppendix;
        const ratio = authorYearDoc.indexOf('References') / authorYearDoc.length;
        assert.ok(ratio >= 0.20 && ratio < 0.40, `expected early ratio in [0.20, 0.40), got ${ratio.toFixed(3)}`);
        assert.equal(prefilter.getNonReferencesSegments(authorYearDoc).length, 2);
        assert.equal(prefilter.evaluateScopeBodyAudioAnchor(authorYearDoc, { categories: ['cs.AI'] }).pass, false);

        // 2) Space-separated Appendix, A.1 3D / T-SNE headings, and >80-char Appendix title all resume non-References scanning
        for (const appHeading of [
            'Appendix A Additional Audio Experiments',
            'A.1 3D Audio Experiments and Room Impulse Modeling',
            'A.1 T-SNE Audio Visualization Across Speakers',
            'Appendix B: Comprehensive Extended Analysis of Cross-Lingual Acoustic Representations, Prosody Alignment, and Robustness Under Extreme Noise Conditions'
        ]) {
            const doc = mainVisual + authorYearRefs + `\n\n${appHeading}\nWe evaluate speaker verification and mel-spectrogram encoders on held-out recordings. `.repeat(15);
            const stripped = prefilter.stripReferencesFromScopeText(doc);
            assert.ok(!stripped.includes('Alec Radford'), `References stripped for "${appHeading}"`);
            assert.ok(stripped.includes('speaker verification'), `Appendix preserved for "${appHeading}"`);
            assert.equal(prefilter.evaluateScopeBodyAudioAnchor(doc, { categories: ['cs.AI'] }).pass, true);
        }

        // 3) Wrapped bibliography title starting with "Supplementary Material:" inside References MUST NOT exit inReferences early
        const wrappedRefDoc = mainVisual
            + '\n\nReferences\n'
            + '[1] A. Author and B. Author. Pure Visual Pretraining. In Proc. CVPR, pages 10-20, 2023.\n'.repeat(8)
            + '[9] C. Researcher, D. Researcher, 2024,\n'
            + 'Supplementary Material: Audio-Visual Benchmarks for Multimodal Learning\n'
            + 'In Proc. NeurIPS, pages 120-135, 2024.\n'
            + '[10] E. Writer et al. Whisper and LibriSpeech Baselines. IEEE ICASSP, 2025.\n'.repeat(4);
        assert.equal(prefilter.evaluateScopeBodyAudioAnchor(wrappedRefDoc, { categories: ['cs.AI'] }).pass, false,
            'wrapped Supplementary Material citation title inside References must NOT leak trailing bibliography anchors');
    });
});

describe('F6 & Cold Replay: uniform low dailyFilter reasoning & historical v1/f2dc6a7f/official-modality-scope-v1 replay', () => {
    it('F6: dailyFilter and dailyFilterAbstractOnly both resolve to low reasoning effort uniformly', async t => {
        withIsolatedSources(t);
        const prevEffort = process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT;
        const prevTiered = process.env.PD_TIERED_REASONING_EFFORT;
        process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT = 'xhigh';
        delete process.env.PD_TIERED_REASONING_EFFORT;
        t.after(() => {
            if (prevEffort === undefined) delete process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT;
            else process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT = prevEffort;
            if (prevTiered === undefined) delete process.env.PD_TIERED_REASONING_EFFORT;
            else process.env.PD_TIERED_REASONING_EFFORT = prevTiered;
        });

        assert.equal(utils.STAGE_REASONING_EFFORT_TIERS.dailyFilter, 'low');
        assert.equal(utils.STAGE_REASONING_EFFORT_TIERS.dailyFilterAbstractOnly, 'low');
        assert.equal(utils.resolveStageReasoningEffort('xhigh', 'muse-spark-1.3-contributor', 'dailyFilter'), 'low');
        assert.equal(utils.resolveStageReasoningEffort('xhigh', 'muse-spark-1.3-contributor', 'dailyFilterAbstractOnly'), 'low');

        const filterConfig = { endpoint: 'https://example.invalid/v1', key: 'local-test', model: 'muse-spark-1.3-contributor' };
        const captured = [];
        const mockRequestFn = async (_url, _endpoint, _model, body, _headers, reqOpts) => {
            captured.push({ effort: body.reasoning?.effort, stage: reqOpts?.usageContext?.stage, cacheKey: body.prompt_cache_key });
            return { statusCode: 200, body: { status: 'completed', output_text: '{"related":true,"reason":"语音识别实验"}' } };
        };

        // 1) Abstract-only paper (non-core cs.CL category) -> MUST use 'low' (never silent 'minimal' downgrade!)
        const abstractPaper = {
            arxivId: '2611.96001',
            title: 'Context-Aware Automatic Speech Recognition',
            abstract: 'We evaluate contextual biasing for automatic speech recognition on LibriSpeech.',
            categories: ['cs.CL']
        };
        const res1 = await fetchPapers.getSpeechAudioDecision(abstractPaper, {
            batchDate: BATCH_DATE,
            filterConfig,
            requestFn: mockRequestFn
        });
        assert.equal(res1.related, true);
        assert.equal(captured[0].effort, 'low');
        assert.equal(captured[0].stage, 'dailyFilter');
        assert.match(captured[0].cacheKey, /^pd:dailyFilter:/);

        // 2) Scope-evidence multimodal paper -> ALSO 'low'
        const scopedPaper = makeMultimodalPaper('2611.96002');
        const res2 = await fetchPapers.getSpeechAudioDecision(scopedPaper, {
            batchDate: BATCH_DATE,
            filterConfig,
            scopeSourceOverrides: makeOfficialOverrides('The model includes a speech tokenizer and LibriSpeech evaluation. '.repeat(80)),
            requestFn: mockRequestFn
        });
        assert.equal(res2.related, true);
        assert.equal(captured[1].effort, 'low');
        assert.equal(captured[1].stage, 'dailyFilter');
    });

    it('preserves 100% cold-replay compatibility for v1, historical f2dc6a7f... schema, and official-modality-scope-v1', async t => {
        withIsolatedSources(t);
        const candidate = makeMultimodalPaper('2611.96003');
        const longText = 'a'.repeat(9999) + '𝐱' + 'b'.repeat(13998) + '𝐲'
            + ('audio 𝐱 speech 𝛽 '.repeat(11000))
            + 'Section 8 evaluates speaker verification and Whisper transcription. ';
        assert.equal(longText.isWellFormed(), true);

        const { evidence: v2, fullText } = await scope.captureFilterScopeEvidenceWithFullText(
            candidate,
            BATCH_DATE,
            makeOfficialOverrides(longText)
        );
        assert.equal(fullText, longText);
        assert.equal(v2.selectionProfile, 'codepoint-safe-excerpt-v2');
        assert.ok(v2.text.length <= scope.MAX_SCOPE_CHARACTERS_V2);
        assert.equal(v2.text.isWellFormed(), true);
        assert.equal(scope.assertFilterScopeEvidence(candidate, v2, BATCH_DATE), v2);

        const stored = sources.readFreshArxivRewriteSource({
            rootDir: v2.rootDir,
            arxivId: candidate.arxivId,
            generation: 1
        });

        // 1) v1 under current schemaFingerprint
        const v1Current = scope.buildFilterScopeEvidence(candidate, BATCH_DATE, stored, { profile: 'v1' });
        assert.equal(v1Current.selectionProfile, 'codepoint-safe-excerpt');
        assert.equal(scope.assertFilterScopeEvidence(candidate, v1Current, BATCH_DATE), v1Current);

        // 2) Historical schemaFingerprint f2dc6a7f...
        const historicalHeader = protocolCodec.historicalHeader(
            'official-modality-scope',
            'unicode-safe-official-excerpt',
            'f2dc6a7f5da235c9abfde9e5330d3d30fef9a3e95b0aad318b4ede542004ad28'
        );
        const v1Historical = scope.buildFilterScopeEvidence(candidate, BATCH_DATE, stored, {
            profile: 'v1',
            header: historicalHeader
        });
        assert.equal(scope.assertFilterScopeEvidence(candidate, v1Historical, BATCH_DATE), v1Historical);

        // 3) Legacy official-modality-scope-v1 contract under filter-scope-v1/
        const baseSourcesDir = Config.FILES.freshArxivFetchedSourcesDir;
        const legacyScopeRoot = path.join(baseSourcesDir, 'filter-scope-v1');
        fs.cpSync(path.join(baseSourcesDir, 'filter-scope'), legacyScopeRoot, { recursive: true });
        const legacyRootDir = path.join(legacyScopeRoot, BATCH_DATE, path.basename(v2.rootDir));
        const legacyStored = sources.readFreshArxivRewriteSource({
            rootDir: legacyRootDir,
            arxivId: candidate.arxivId,
            generation: 1
        });
        const originalV1 = scope.buildFilterScopeEvidence(candidate, BATCH_DATE, legacyStored, { original: true });
        assert.equal(originalV1.contract, 'official-modality-scope-v1');
        assert.equal(scope.assertFilterScopeEvidence(candidate, originalV1, BATCH_DATE), originalV1);
    });
});
