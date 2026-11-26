'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    DAILY_FILTER_PREFILTER_SHA256,
    MODERN_AUDIO_TERMS,
    evaluateDailyFilterPrefilter,
    stripReferencesFromScopeText,
    hasPreReferencesAudioAnchor,
    evaluateScopeBodyAudioAnchor
} = require('../scripts/lib/daily-filter-prefilter.js');
const { validatedDecisionInputSha256 } = require('../scripts/lib/filter-scope-evidence.js');
const {
    STAGE_REASONING_EFFORT_TIERS,
    resolveStageReasoningEffort,
    buildRequestBody,
    parseSseResponse,
    loadPrompt
} = require('../scripts/utils.js');
const {
    selectApiKey,
    getAccountId,
    markQuotaExhausted,
    readStateStrict
} = require('../scripts/llm-account-pool.js');
const {
    buildLlmUsageEvent,
    recordLlmUsage,
    withLlmUsageContext,
    usageContext
} = require('../scripts/lib/llm-usage.js');
const {
    loadEventsForDates,
    buildScorecard,
    formatTextScorecard
} = require('../scripts/digest-scorecard.js');
const {
    shouldTriggerScoringConsensus,
    resolveConfiguredStageTemperature
} = require('../scripts/deep-analyzer.js');
const { runScoringAuditConsensus } = require('../scripts/lib/scoring-audit-consensus.js');
const { scoringStabilityIsResolved } = require('../scripts/lib/scoring-stability.js');

const ROOT = path.resolve(__dirname, '..');

function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

describe('Wave 11 Track 11C: daily filter prefilter & $0 scope body audio anchor', () => {
    it('rescues 2025-2026 audio models even when abstract omits generic audio keywords', () => {
        assert.match(DAILY_FILTER_PREFILTER_SHA256, /^[a-f0-9]{64}$/);
        assert.ok(MODERN_AUDIO_TERMS.includes('qwen2.5-omni'));
        assert.ok(MODERN_AUDIO_TERMS.includes('indextts'));

        const res = evaluateDailyFilterPrefilter({
            title: 'Evaluating IndexTTS and CosyVoice on Real-World Benchmarks',
            abstract: 'We compare IndexTTS and CosyVoice zero-shot cloning latencies across 12 languages.',
            categories: ['cs.CL']
        });
        assert.equal(res.pass, true);
        assert.ok(res.matchedKeywords.some(k => /indextts|cosyvoice/i.test(k)));
    });

    it('rejects 0%-precision ambiguous noise tokens when zero explicit audio context exists', () => {
        const cases = [
            {
                rule: 'non_audio_vits',
                paper: {
                    title: 'Efficient Pruning of ViTs for ImageNet Classification',
                    abstract: 'We prune Vision Transformers (ViTs) using structured attention heads on ImageNet.',
                    categories: ['cs.CV']
                }
            },
            {
                rule: 'non_audio_wireless_beamforming',
                paper: {
                    title: 'Hybrid Beamforming for 6G RIS-Assisted Massive MIMO',
                    abstract: 'We design downlink precoding and beamforming for mmWave cellular base stations in wireless communication channels with reconfigurable intelligent surfaces.',
                    categories: ['eess.SP']
                }
            },
            {
                rule: 'non_audio_security_asr',
                paper: {
                    title: 'Reducing Attack Success Rate Against Jailbreak Prompts',
                    abstract: 'Our defense lowers ASR from 92% to 4% against prompt injection and adversarial attacks.',
                    categories: ['cs.CR']
                }
            },
            {
                rule: 'non_audio_se_math_or_swe',
                paper: {
                    title: 'SE(3)-Equivariant Graph Networks for Protein Folding',
                    abstract: 'We enforce Lie group SE(3) equivariance for 3D molecular coordinate prediction and geometric message passing across large protein structure benchmarks.',
                    categories: ['cs.LG']
                }
            },
            {
                rule: 'non_audio_waveform',
                paper: {
                    title: 'Deep Learning on 12-Lead ECG Waveform Classification',
                    abstract: 'We classify cardiac arrhythmias directly from twelve-lead electrocardiogram waveform recordings using multi-scale residual convolutions in clinical cohorts.',
                    categories: ['eess.SP']
                }
            },
            {
                rule: 'non_audio_pure_medical_or_vision_vlm',
                paper: {
                    title: 'Multimodal Foundation Model for Chest Radiograph and CT Scan Diagnosis',
                    abstract: 'We align pathology reports and electronic health record EHR notes with radiology CT scan views.',
                    categories: ['cs.CV']
                }
            }
        ];

        for (const item of cases) {
            const res = evaluateDailyFilterPrefilter(item.paper);
            assert.equal(res.pass, false, `expected ${item.rule} rejection`);
            assert.equal(res.dailyFilterPrefilterRule, item.rule);
            assert.equal(res.dailyFilterPrefilterSha256, DAILY_FILTER_PREFILTER_SHA256);
        }
    });

    it('never rejects genuine audio papers even when ambiguous tokens appear', () => {
        const audioCases = [
            {
                title: 'VITS-based End-to-End Speech Synthesis with Neural Vocoder',
                abstract: 'We improve VITS prosody modeling for zero-shot text-to-speech synthesis.',
                categories: ['cs.CL']
            },
            {
                title: 'Microphone Array Acoustic Beamforming for Far-Field Speech Recognition',
                abstract: 'We combine neural beamforming with Whisper ASR in reverberant rooms.',
                categories: ['eess.SP']
            },
            {
                title: 'Multimodal Emotion Recognition from Video and Clinical Interviews',
                abstract: 'We evaluate affective states across multimodal video benchmarks.',
                categories: ['cs.AI']
            },
            {
                // P2-2: TTS + MOS + CER with "standard deviation" (SD disambiguator) must NOT cross-contaminate TTS!
                title: 'Evaluating Zero-Shot TTS Systems Across Multiple Languages',
                abstract: 'We report MOS and CER with standard deviation across 10 languages for our neural TTS framework on standard evaluation splits.',
                categories: ['cs.CL']
            }
        ];
        for (const paper of audioCases) {
            const res = evaluateDailyFilterPrefilter(paper);
            assert.equal(res.pass, true, `must not reject audio paper: ${paper.title}`);
        }
    });

    it('strips References section before checking body audio anchors and fails open on short bodies or core categories', () => {
        const bodyPadding = 'We evaluate vision-language image grounding on document OCR and visual layout benchmarks. '.repeat(65);
        const refsOnlyAudio = `${bodyPadding}\n\nReferences\n[1] Radford et al. Robust Speech Recognition via Whisper. AudioSet 2023.\n`;
        const stripped = stripReferencesFromScopeText(refsOnlyAudio);
        assert.ok(!stripped.includes('Whisper'));
        assert.ok(!stripped.includes('AudioSet'));

        const rejected = evaluateScopeBodyAudioAnchor(refsOnlyAudio, { categories: ['cs.CV'] });
        assert.equal(rejected.pass, false);
        assert.equal(hasPreReferencesAudioAnchor(refsOnlyAudio, { categories: ['cs.CV'] }), false);

        // Fail-open on core audio categories (eess.AS / cs.SD)
        const coreCat = evaluateScopeBodyAudioAnchor(refsOnlyAudio, { categories: ['eess.AS'] });
        assert.equal(coreCat.pass, true);
        assert.equal(coreCat.coreAudioCategory, true);

        // Fail-open on sparse / short body (< 4000 chars)
        const shortBody = 'Short RGB-only document text without audio keywords.';
        const shortRes = evaluateScopeBodyAudioAnchor(shortBody, { categories: ['cs.CV'] });
        assert.equal(shortRes.pass, true);
        assert.equal(shortRes.shortBodyFailOpen, true);

        // Real audio mention in body passes
        const audioBody = `${bodyPadding} In Section 4 we also evaluate speech transcription and mel-spectrogram encoding.`;
        const audioRes = evaluateScopeBodyAudioAnchor(audioBody, { categories: ['cs.CV'] });
        assert.equal(audioRes.pass, true);
        assert.match(audioRes.matchedAnchor, /speech|mel-spectrogram/i);
    });

    it('enforces fail-closed validation on scope_body_audio_anchor_prefilter decisions', () => {
        const paper = {
            arxivId: '2611.90001',
            title: 'Multimodal Vision Benchmark',
            abstract: 'We study multimodal reasoning on images.',
            categories: ['cs.CV']
        };
        assert.throws(() => validatedDecisionInputSha256(paper, {
            related: true,
            retryable: false,
            fallback: false,
            rawResponse: '',
            parseSource: 'scope_body_audio_anchor_prefilter',
            filterScopeEvidence: { text: 'x' }
        }), /正文音频锚点预筛排除记录不完整/);

        assert.throws(() => validatedDecisionInputSha256(paper, {
            related: false,
            retryable: false,
            fallback: false,
            rawResponse: 'unexpected',
            parseSource: 'scope_body_audio_anchor_prefilter',
            filterScopeEvidence: { text: 'x' }
        }), /正文音频锚点预筛排除记录不完整/);

        assert.throws(() => validatedDecisionInputSha256(paper, {
            related: false,
            retryable: false,
            fallback: false,
            rawResponse: '',
            parseSource: 'scope_body_audio_anchor_prefilter'
        }), /正文音频锚点预筛排除记录不完整/);

        // P2-2: Non-scope audio paper cannot be forged with scope_body_audio_anchor_prefilter
        const directAudioPaper = {
            arxivId: '2611.90002',
            title: 'Neural Speech Recognition for Noisy Rooms',
            abstract: 'We improve automatic speech recognition on LibriSpeech with acoustic feature adaptation across reverberant rooms.',
            categories: ['eess.AS']
        };
        assert.throws(() => validatedDecisionInputSha256(directAudioPaper, {
            related: false,
            retryable: false,
            fallback: false,
            rawResponse: '',
            parseSource: 'scope_body_audio_anchor_prefilter',
            filterScopeEvidence: { text: 'x' }
        }), /正文音频锚点预筛排除记录不完整/);
    });
});

describe('Wave 11 Track 11C: tiered reasoning.effort, prompt_cache_key & stage temperatures', () => {
    it('applies authorized stage tiers capped by configured env effort and respects opt-out', () => {
        const prev = process.env.PD_TIERED_REASONING_EFFORT;
        try {
            delete process.env.PD_TIERED_REASONING_EFFORT;
            assert.equal(STAGE_REASONING_EFFORT_TIERS.dailyFilter, 'low');
            assert.equal(STAGE_REASONING_EFFORT_TIERS.openSourceScan, 'minimal');
            assert.equal(STAGE_REASONING_EFFORT_TIERS['publish.text'], 'low');
            assert.equal(STAGE_REASONING_EFFORT_TIERS.tableRepair, 'medium');
            assert.equal(STAGE_REASONING_EFFORT_TIERS.scoringAudit, 'high');
            assert.equal(STAGE_REASONING_EFFORT_TIERS.primaryAnalysis, undefined);
            assert.equal(STAGE_REASONING_EFFORT_TIERS.apiReaderArticle, undefined);

            assert.equal(resolveStageReasoningEffort('xhigh', 'muse-spark-1.3-contributor', 'openSourceScan'), 'minimal');
            assert.equal(resolveStageReasoningEffort('xhigh', 'muse-spark-1.3-contributor', 'dailyFilter'), 'low');
            assert.equal(resolveStageReasoningEffort('xhigh', 'muse-spark-1.3-contributor', 'tableRepair'), 'medium');
            assert.equal(resolveStageReasoningEffort('xhigh', 'muse-spark-1.3-contributor', 'scoringAudit'), 'high');
            assert.equal(resolveStageReasoningEffort('xhigh', 'muse-spark-1.3-contributor', 'primaryAnalysis'), 'xhigh');
            assert.equal(resolveStageReasoningEffort('xhigh', 'muse-spark-1.3-contributor', 'apiReaderArticle'), 'xhigh');

            // Never upgrades above configured ceiling
            assert.equal(resolveStageReasoningEffort('low', 'muse-spark-1.3-contributor', 'primaryAnalysis'), 'low');
            assert.equal(resolveStageReasoningEffort('low', 'muse-spark-1.3-contributor', 'tableRepair'), 'low');
            assert.equal(resolveStageReasoningEffort('medium', 'muse-spark-1.3-contributor', 'apiReaderArticle'), 'medium');

            // DeepSeek v4.1 flash only allows low/high/max — medium maps down safely within ceiling
            assert.equal(resolveStageReasoningEffort('max', 'deepseek-v4.1-flash', 'dailyFilter'), 'low');
            assert.equal(resolveStageReasoningEffort('max', 'deepseek-v4.1-flash', 'primaryAnalysis'), 'max');

            // Explicit opt-out ('0', 'false', 'off') restores uniform configured effort
            for (const disabledVal of ['0', 'false', 'off']) {
                process.env.PD_TIERED_REASONING_EFFORT = disabledVal;
                assert.equal(resolveStageReasoningEffort('xhigh', 'muse-spark-1.3-contributor', 'dailyFilter'), 'xhigh');
            }
        } finally {
            if (prev === undefined) delete process.env.PD_TIERED_REASONING_EFFORT;
            else process.env.PD_TIERED_REASONING_EFFORT = prev;
        }
    });

    it('injects prompt_cache_key on openai_responses and respects PD_OPENAI_RESPONSES_PROMPT_CACHE_KEY=0/false', () => {
        const prevCache = process.env.PD_OPENAI_RESPONSES_PROMPT_CACHE_KEY;
        const prevEffort = process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT;
        const prevTiered = process.env.PD_TIERED_REASONING_EFFORT;
        try {
            delete process.env.PD_OPENAI_RESPONSES_PROMPT_CACHE_KEY;
            delete process.env.PD_TIERED_REASONING_EFFORT;
            process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT = 'xhigh';

            const body = buildRequestBody('openai_responses', 'muse-spark-1.3-contributor', [{ role: 'user', content: 'hello' }], 1000, 0, {
                stage: 'dailyFilter',
                promptCacheKey: 'pd:dailyFilter:muse-spark-1.3-contribut'
            });
            assert.equal(body.reasoning?.effort, 'low');
            assert.equal(body.prompt_cache_key, 'pd:dailyFilter:muse-spark-1.3-contribut');

            // P1-5: reasoningStage overrides usageContext.stage for apiReaderConceptTerms while keeping usageContext.stage='apiReaderRepair'
            const conceptBody = buildRequestBody('openai_responses', 'muse-spark-1.3-contributor', [{ role: 'user', content: 'terms' }], 1000, 0.1, {
                usageContext: { stage: 'apiReaderRepair', paperId: '2611.00001' },
                reasoningStage: 'apiReaderConceptTerms'
            });
            assert.equal(conceptBody.reasoning?.effort, 'minimal');

            // P1-4: Node parseSseResponse handles response.cancelled and synthesizes status on envelope-less response.failed
            const cancelledSse = 'data: {"type":"response.cancelled","response":{"id":"r1","status":"cancelled"}}\n\n';
            assert.equal(parseSseResponse(cancelledSse)?.status, 'cancelled');
            const bareFailedSse = 'data: {"type":"response.failed","error":{"message":"boom"}}\n\n';
            const bareFailed = parseSseResponse(bareFailedSse);
            assert.equal(bareFailed?.status, 'failed');
            const failedUsageEv = buildLlmUsageEvent({
                protocol: 'openai_responses',
                model: 'muse-spark-1.3-contributor',
                request: {},
                response: bareFailed,
                statusCode: 200,
                durationMs: 100,
                transportStarted: true
            });
            assert.equal(failedUsageEv.outcome, 'provider_error');

            for (const disabledVal of ['0', 'false', 'off']) {
                process.env.PD_OPENAI_RESPONSES_PROMPT_CACHE_KEY = disabledVal;
                const noCacheBody = buildRequestBody('openai_responses', 'muse-spark-1.3-contributor', [{ role: 'user', content: 'hello' }], 1000, 0, {
                    stage: 'dailyFilter',
                    promptCacheKey: 'pd:dailyFilter:muse-spark-1.3-contribut'
                });
                assert.equal(noCacheBody.prompt_cache_key, undefined);
            }
        } finally {
            if (prevCache === undefined) delete process.env.PD_OPENAI_RESPONSES_PROMPT_CACHE_KEY;
            else process.env.PD_OPENAI_RESPONSES_PROMPT_CACHE_KEY = prevCache;
            if (prevEffort === undefined) delete process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT;
            else process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT = prevEffort;
            if (prevTiered === undefined) delete process.env.PD_TIERED_REASONING_EFFORT;
            else process.env.PD_TIERED_REASONING_EFFORT = prevTiered;
        }
    });

    it('applies temperature=0.1 to extraction/repair stages while preserving prose stages and explicit overrides', () => {
        const Config = require('../scripts/config.js');
        assert.equal(resolveConfiguredStageTemperature({ usageContext: { stage: 'openSourceScan' } }), 0.1);
        assert.equal(resolveConfiguredStageTemperature({ usageContext: { stage: 'tagSelection' } }), 0.1);
        assert.equal(resolveConfiguredStageTemperature({ usageContext: { stage: 'tableRepair' } }), 0.1);
        assert.equal(resolveConfiguredStageTemperature({ usageContext: { stage: 'apiReaderRepair' }, reasoningStage: 'apiReaderConceptTerms' }), 0.1);
        assert.equal(resolveConfiguredStageTemperature({ usageContext: { stage: 'primaryAnalysis' } }), Config.ANALYSIS_CONFIG.apiTemperature);
        assert.equal(resolveConfiguredStageTemperature({ usageContext: { stage: 'apiReaderArticle' } }), Config.ANALYSIS_CONFIG.apiTemperature);
        assert.equal(resolveConfiguredStageTemperature({ usageContext: { stage: 'openSourceScan' }, temperature: 0.25 }), 0.25);

        // P1-R2-1: end-to-end check that callModel forwards reasoningStage & promptCacheKey to outgoing request body
        const { execFileSync } = require('node:child_process');
        const out = execFileSync(process.execPath, ['-e', `
            require('./scripts/env-loader.js').loadProjectEnv = () => ({});
            process.env.PAPER_ANALYZER_MODEL = 'muse-spark-1.3-contributor';
            process.env.PAPER_ANALYZER_ENDPOINT = 'https://opencode.ai/zen/go/v1';
            process.env.PAPER_ANALYZER_API_KEY = 'sk-test-only';
            process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT = 'xhigh';
            delete process.env.PD_TIERED_REASONING_EFFORT;
            delete process.env.PD_OPENAI_RESPONSES_PROMPT_CACHE_KEY;
            const utils = require('./scripts/utils.js');
            let captured = null;
            utils.requestLlmJson = async (_u, _e, _m, body) => {
                captured = body;
                return { statusCode: 401, body: { error: { message: 'synthetic capture' } } };
            };
            const deep = require('./scripts/deep-analyzer.js');
            deep.callModel([{ role: 'user', content: 'terms' }], 1000, {
                maxRetries: 1,
                usageContext: { stage: 'apiReaderRepair', paperId: '2611.00001' },
                reasoningStage: 'apiReaderConceptTerms',
                promptCacheKey: 'pd:apiReaderConceptTerms:custom'
            }).catch(() => {
                console.log(JSON.stringify({ effort: captured?.reasoning?.effort, cacheKey: captured?.prompt_cache_key, temp: captured?.temperature }));
            });
        `], { cwd: ROOT, encoding: 'utf8' });
        const jsonLine = out.trim().split('\n').pop();
        assert.deepEqual(JSON.parse(jsonLine), {
            effort: 'minimal',
            cacheKey: 'pd:apiReaderConceptTerms:custom',
            temp: 0.1
        });
    });

    it('triggers blind scoring consensus cleanly and preserves scoringStabilityIsResolved invariant (P0-1)', async () => {
        // Mid-tier 7.1 without caps or prior run -> NO redundant 2nd audit!
        assert.equal(shouldTriggerScoringConsensus({ firstScore: 7.1, previousRunScore: null, capsApplied: [] }), false);
        assert.equal(shouldTriggerScoringConsensus({ firstScore: 6.7, previousRunScore: 6.9, capsApplied: [] }), false);

        // High score >= 8.0 -> consensus required
        assert.equal(shouldTriggerScoringConsensus({ firstScore: 8.0, previousRunScore: null, capsApplied: [] }), true);
        // Band boundary within ±0.2 of 6.0 / 7.5 / 8.5 -> consensus required
        assert.equal(shouldTriggerScoringConsensus({ firstScore: 7.4, previousRunScore: null, capsApplied: [] }), true);
        assert.equal(shouldTriggerScoringConsensus({ firstScore: 6.1, previousRunScore: null, capsApplied: [] }), true);
        // Caps applied -> consensus required
        assert.equal(shouldTriggerScoringConsensus({ firstScore: 5.2, previousRunScore: null, capsApplied: ['no_baseline_cap'] }), true);
        // Genuine prior-run shift > 0.5 -> consensus required
        assert.equal(shouldTriggerScoringConsensus({ firstScore: 7.0, previousRunScore: 7.6, capsApplied: [] }), true);

        // P0-1 end-to-end check: mid-tier paper with draft=8.0 vs blindAudit=7.1 (|delta|=0.9 > 0.5)
        // skips pass 2 AND passes scoringStabilityIsResolved with stabilityWarning=false!
        let auditCalls = 0;
        const midConsensusRequired = shouldTriggerScoringConsensus({ firstScore: 7.1, previousRunScore: null, capsApplied: [] });
        const midOutcome = await runScoringAuditConsensus({
            firstResult: { audit: { total: 7.1 } },
            firstScore: 7.1,
            requiresConsensus: midConsensusRequired,
            auditAgain: async () => { auditCalls += 1; return { audit: { total: 7.1 } }; },
            scoreOfResult: r => r.audit.total,
            fingerprintAudit: () => 'a'.repeat(64)
        });
        assert.equal(auditCalls, 0);
        assert.equal(midOutcome.resolution.status, 'not_required');
        assert.equal(scoringStabilityIsResolved({
            stabilityWarning: Boolean(midConsensusRequired),
            stabilityResolution: midOutcome.resolution
        }), true);

        // High-score paper (>=8.0) triggers pass 2 and resolves with stabilityWarning=true
        const highConsensusRequired = shouldTriggerScoringConsensus({ firstScore: 8.2, previousRunScore: null, capsApplied: [] });
        const highOutcome = await runScoringAuditConsensus({
            firstResult: { audit: { total: 8.2 } },
            firstScore: 8.2,
            requiresConsensus: highConsensusRequired,
            auditAgain: async () => { auditCalls += 1; return { audit: { total: 8.1 } }; },
            scoreOfResult: r => r.audit.total,
            fingerprintAudit: () => 'b'.repeat(64)
        });
        assert.equal(auditCalls, 1);
        assert.equal(highOutcome.resolution.status, 'resolved');
        assert.equal(scoringStabilityIsResolved({
            stabilityWarning: Boolean(highConsensusRequired),
            stabilityResolution: highOutcome.resolution
        }), true);
    });
});

describe('Wave 11 Track 11C: equal-weight paper-sticky account affinity & scorecard', () => {
    it('routes the same affinityKey deterministically regardless of key order, fails over on cooldown, and preserves rotationCursor=0', () => {
        const dir = makeTempDir('pd-affinity-pool-');
        try {
            const stateFile = path.join(dir, 'pool-state.json');
            const endpoint = 'https://opencode.ai/zen/go/v1';
            const keysA = ['sk-alpha-111', 'sk-beta-222', 'sk-gamma-333', 'sk-delta-444'];
            const keysB = ['sk-delta-444', 'sk-beta-222', 'sk-alpha-111', 'sk-gamma-333'];
            const orderedIds = keysA.map(getAccountId).sort();

            // Pick an affinityKey that maps to a non-zero slot so we verify cursor does NOT drift to it
            let nonZeroAffinity = '2611.12345';
            for (let n = 0; n < 20; n += 1) {
                const candidate = `2611.1000${n}`;
                const slot = parseInt(crypto.createHash('sha256').update(candidate).digest('hex').slice(0, 8), 16) % orderedIds.length;
                if (slot > 0) { nonZeroAffinity = candidate; break; }
            }

            const pick1 = selectApiKey(keysA, endpoint, stateFile, { affinityKey: nonZeroAffinity });
            const pick2 = selectApiKey(keysB, endpoint, stateFile, { affinityKey: nonZeroAffinity });
            assert.equal(pick1.accountId, pick2.accountId);
            assert.equal(pick1.apiKey, pick2.apiKey);
            assert.notEqual(pick1.accountId, orderedIds[0]);

            // P2-3: inspect real state.services[...].groups[...] schema & verify cursor stays anchored at 0
            const stateAfterAffinity = readStateStrict(stateFile);
            const serviceEntry = Object.values(stateAfterAffinity.services || {})[0];
            assert.ok(serviceEntry, 'expected service entry in account pool state');
            const groupEntry = Object.values(serviceEntry.groups || {})[0];
            assert.ok(groupEntry, 'expected group entry in account pool state');
            assert.equal(groupEntry.rotationCursor, 0);

            // Subsequent non-affinity round-robin call starts cleanly at orderedIds[0]
            const rrPick = selectApiKey(keysA, endpoint, stateFile);
            assert.equal(rrPick.accountId, orderedIds[0]);

            // P1-1: verify AsyncLocalStorage paperId is visible via usageContext() fallback
            const scopedId = withLlmUsageContext({ paperId: '2611.77777' }, () => usageContext({ stage: 'primaryAnalysis' }).paperId);
            assert.equal(scopedId, '2611.77777');
            // P2-R2-1: shared digest stays strictly lowercase for unitId (only accountId normalizes uppercase hex)
            assert.equal(usageContext({ unitId: 'A'.repeat(64) }).unitId, null);
            assert.equal(usageContext({ unitId: 'a'.repeat(64) }).unitId, 'a'.repeat(64));

            // Cooldown on preferred account smoothly fails over to next sorted equal-weight slot
            markQuotaExhausted(pick1, {
                blockedUntilMs: Date.now() + 3600 * 1000,
                reason: 'quota_test',
                source: 'header'
            }, stateFile);
            const failover = selectApiKey(keysA, endpoint, stateFile, { affinityKey: nonZeroAffinity });
            assert.notEqual(failover.accountId, pick1.accountId);
            assert.ok(keysA.includes(failover.apiKey));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('records accountId, mirrors append-only daily JSONL index, supports default/fast/canonical modes without mtime time-bomb, and never leaks hashes', () => {
        const dir = makeTempDir('pd-scorecard-');
        try {
            const usageDir = path.join(dir, 'llm-usage');
            const fakeAccountIdA = getAccountId('sk-secret-key-alpha');
            const fakeAccountIdB = getAccountId('sk-secret-key-beta');
            // Dynamic current Beijing date avoids any calendar time-bomb; plus an old date tests --canonical without mtime filter
            const todayBj = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

            recordLlmUsage({
                protocol: 'openai_responses',
                model: 'muse-spark-1.3-contributor',
                request: { input: [{ role: 'user', content: 'test' }], max_output_tokens: 1000 },
                response: {
                    status: 'completed',
                    output_text: 'ok',
                    usage: {
                        input_tokens: 10000,
                        input_tokens_details: { cached_tokens: 8000 },
                        output_tokens: 500,
                        output_tokens_details: { reasoning_tokens: 100 }
                    }
                },
                statusCode: 200,
                durationMs: 2400,
                transportStarted: true,
                context: { stage: 'dailyFilter', paperId: '2611.00001' },
                accountId: fakeAccountIdA.toUpperCase(), // P2-1: uppercase 64-hex normalized to lowercase
                at: `${todayBj}T10:00:00+08:00`
            }, { directory: usageDir });
            recordLlmUsage({
                protocol: 'openai_responses',
                model: 'muse-spark-1.3-contributor',
                request: { input: [{ role: 'user', content: 'test2' }], max_output_tokens: 1000 },
                response: null,
                statusCode: null,
                durationMs: 12000,
                errorCode: 'ConnectionResetError', // P2-4: Python reset error counted in econnresetErrors
                transportStarted: true,
                context: { stage: 'primaryAnalysis', paperId: '2611.00002' },
                accountId: fakeAccountIdB,
                at: `${todayBj}T10:05:00+08:00`
            }, { directory: usageDir });
            // Historical event whose file mtime is today (proves --canonical ignores mtime cutoff)
            recordLlmUsage({
                protocol: 'openai_responses',
                model: 'muse-spark-1.3-contributor',
                request: { input: [{ role: 'user', content: 'old' }], max_output_tokens: 1000 },
                response: { status: 'completed', output_text: 'ok', usage: { input_tokens: 100, output_tokens: 20 } },
                statusCode: 200,
                durationMs: 500,
                transportStarted: true,
                context: { stage: 'dailyFilter', paperId: '2501.00001' },
                accountId: fakeAccountIdA,
                at: '2025-01-15T10:00:00+08:00'
            }, { directory: usageDir });

            const dailyIndexFile = path.join(dir, 'llm-usage-daily', `${todayBj}.jsonl`);
            assert.ok(fs.existsSync(dailyIndexFile), 'daily JSONL cache should exist');

            // Default merges daily-index + usageDir mtime window cleanly with deduplication
            const loadedDefault = loadEventsForDates(usageDir, [todayBj]);
            assert.equal(loadedDefault.source, 'daily-index+usage-dir');
            assert.equal(loadedDefault.events.length, 2);

            // Fast mode reads daily-index only
            const loadedFast = loadEventsForDates(usageDir, [todayBj], { fast: true });
            assert.equal(loadedFast.source, 'daily-index-fast');
            assert.equal(loadedFast.events.length, 2);

            // Canonical mode scans usageDir authoritatively without mtime cutoff (finds 2025-01-15 despite today's mtime!)
            const loadedCanonicalOld = loadEventsForDates(usageDir, ['2025-01-15'], { canonical: true });
            assert.equal(loadedCanonicalOld.source, 'canonical-usage-dir');
            assert.equal(loadedCanonicalOld.events.length, 1);

            const card = buildScorecard(loadedDefault.events, { dates: [todayBj], source: loadedDefault.source });
            assert.equal(card.totals.requests, 2);
            assert.equal(card.totals.completed, 1);
            assert.equal(card.totals.econnresetErrors, 1);
            assert.equal(card.totals.cacheHitRatePct, 80);
            assert.equal(card.totals.reasoningSharePct, 20);
            assert.deepEqual(card.observedAccountDistribution, { 'acct#1': 1, 'acct#2': 1 });

            // Never expose raw keys or 64-hex stable account hashes in JSON or text output
            const serialized = `${JSON.stringify(card)}\n${formatTextScorecard(card)}`;
            assert.ok(!serialized.includes(fakeAccountIdA), 'must never expose stable accountId A');
            assert.ok(!serialized.includes(fakeAccountIdB), 'must never expose stable accountId B');
            assert.ok(!/[a-f0-9]{64}/i.test(serialized), 'must never expose 64-hex credential fingerprints');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('Wave 11 Track 11C: KV prefix caching prompt ordering invariants', () => {
    it('keeps static prefix before the first dynamic placeholder on all 15 reordered prompt templates', () => {
        const prompts = [
            { name: 'api-reader-article.md', minRatio: 0.85 },
            // Locked patch-protocol suffix after <repair_input> is pinned by prompt-writing-guide-version.test.js (~81.8% static prefix)
            { name: 'api-reader-repair.md', minRatio: 0.80 },
            { name: 'api-reader-fact-local.md', minRatio: 0.85 },
            // Short template (594 chars): 100% of static instructions & JSON schema precede <concept_terms_input> (~75.1%)
            { name: 'api-reader-concept-terms.md', minRatio: 0.75 },
            { name: 'deep-analysis.md', minRatio: 0.85 },
            { name: 'scoring-audit.md', minRatio: 0.85 },
            { name: 'gap-fill.md', minRatio: 0.85 },
            { name: 'core-summary-repair.md', minRatio: 0.85 },
            { name: 'filter.md', minRatio: 0.85 },
            { name: 'tag-repair.md', minRatio: 0.85 },
            { name: 'structure-repair.md', minRatio: 0.85 },
            { name: 'image-supplement.md', minRatio: 0.85 },
            { name: 'opensource-scan.md', minRatio: 0.85 },
            { name: 'method-fill.md', minRatio: 0.85 },
            { name: 'table-fill.md', minRatio: 0.85 }
        ];
        // Batch-static placeholders (identical across every paper in a batch) are part of the cacheable prefix.
        const BATCH_STATIC_PLACEHOLDERS = new Set(['{tagPromptText}']);
        for (const { name, minRatio } of prompts) {
            const template = loadPrompt(`prompts/current/${name}`, {});
            const matches = [...template.matchAll(/(?<![\\A-Za-z])\{[a-z][A-Za-z0-9_]*\}/g)]
                .filter(m => !BATCH_STATIC_PLACEHOLDERS.has(m[0]));
            assert.ok(matches.length > 0, `${name} template must contain per-paper dynamic {var} placeholders after static instructions`);
            const firstDynamic = matches[0];
            assert.ok(firstDynamic.index > 0, `${name} must place static instructions before ${firstDynamic[0]}`);
            const ratio = firstDynamic.index / template.length;
            assert.ok(
                ratio >= minRatio,
                `${name} static prefix ratio ${(ratio * 100).toFixed(1)}% < ${(minRatio * 100).toFixed(0)}% (first per-paper placeholder ${firstDynamic[0]} at ${firstDynamic.index}/${template.length})`
            );
        }
    });
});
