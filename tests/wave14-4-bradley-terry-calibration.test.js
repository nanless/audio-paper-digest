'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const bt = require('../scripts/lib/bradley-terry-calibration.js');
const cli = require('../scripts/calibrate-batch-scores.js');
const utils = require('../scripts/utils.js');

const ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(ROOT, 'scripts', 'calibrate-batch-scores.js');

function deepFreeze(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    Object.freeze(obj);
    for (const value of Object.values(obj)) {
        deepFreeze(value);
    }
    return obj;
}

function makeRealisticPaper(id, score, extra = {}) {
    const scoreStr = score.toFixed(1);
    return {
        arxivId: id,
        title: extra.title || `Audio Neural Codec Study ${id}`,
        abstract: extra.abstract || `We propose an acoustic neural codec evaluated on LibriSpeech and AudioSet (${id}).`,
        categories: extra.categories || ['eess.AS', 'cs.SD'],
        sourceSha256: bt.sha256Hex(`source:${id}`),
        error: null,
        parsed: {
            score: scoreStr,
            tags: extra.tags || ['#语音编码', '#音频生成'],
            summary: extra.summary || `Core summary for ${id}: improves PESQ by +0.42 at 1.5 kbps bitrate.`
        },
        analysis: extra.analysis || [
            '## 评分',
            `${scoreStr}/10`,
            '',
            '## 机器摘要',
            'document_type: 方法论文',
            'rank_bucket: 前25%',
            '',
            '## 核心创新点',
            `Introduces residual vector quantization with streaming causal attention for ${id}.`,
            '',
            '## 实验结果',
            `Evaluated on LibriSpeech test-clean, VCTK, and DNS Challenge with WER 2.1% and PESQ 3.85 (${id}).`,
            '',
            '## 局限与问题',
            `Latency profiling limited to 16 kHz mono audio (${id}).`,
            '',
            '## 开源详情',
            `Official inference weights and evaluation scripts verified at https://example.org/${id}.`
        ].join('\n'),
        analysisManifest: {
            stages: {
                scoringAudit: {
                    finalScore: score,
                    audit: {
                        total: score,
                        rankBucket: '前25%'
                    }
                }
            }
        }
    };
}

function makeTempDir(prefix = 'wave14-4-bt-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ═══════════════════════════════════════════════════════
// 1. Contract & Parameter Validation
// ═══════════════════════════════════════════════════════

test('Wave 14.4: exports exact contract identifier and validates bounds', () => {
    assert.equal(bt.SCORE_CALIBRATION_CONTRACT, 'batch-score-calibration-v1');
    assert.equal(bt.validateSwissRounds(3), 3);
    assert.equal(bt.validateSwissRounds(6), 6);
    assert.throws(() => bt.validateSwissRounds(0), RangeError);
    assert.throws(() => bt.validateSwissRounds(7), RangeError);
    assert.throws(() => bt.validateSwissRounds(2.5), RangeError);
    assert.throws(() => bt.validateMaxDelta(-0.1), RangeError);
    assert.throws(() => bt.validateMaxDelta(NaN), RangeError);
    assert.throws(() => bt.validatePriorWeight(0), RangeError);
    assert.throws(() => bt.validatePriorWeight(-0.25), RangeError);
});

// ═══════════════════════════════════════════════════════
// 2. Swiss-Tournament Pairing Engine
// ═══════════════════════════════════════════════════════

test('Wave 14.4: planSwissRoundPairs handles even N=4 across 3 rounds with zero duplicate pairs', () => {
    const items = [
        { id: 'P1', rating: 8.4 },
        { id: 'P2', rating: 8.1 },
        { id: 'P3', rating: 7.5 },
        { id: 'P4', rating: 7.2 }
    ];

    const seenPairs = new Set();
    for (let round = 1; round <= 3; round += 1) {
        const plan = bt.planSwissRoundPairs(items, {
            round,
            seed: 'even-test',
            previousPairs: seenPairs
        });
        assert.equal(plan.bye, null);
        assert.equal(plan.pairs.length, 2);
        assert.equal(plan.repeatedPairsCount, 0);
        assert.equal(plan.estimatedEvaluations, 4); // bidirectional
        const participantsThisRound = new Set();
        for (const pair of plan.pairs) {
            assert.equal(pair.isRepeat, false);
            assert.equal(pair.evaluations.length, 2);
            assert.equal(pair.evaluations[0].direction, 'forward');
            assert.equal(pair.evaluations[1].direction, 'reverse');
            assert.equal(pair.evaluations[0].presentedA, pair.evaluations[1].presentedB);
            assert.equal(pair.evaluations[0].presentedB, pair.evaluations[1].presentedA);
            assert.ok(!seenPairs.has(pair.pairKey), `Duplicate pair ${pair.pairKey} in round ${round}`);
            seenPairs.add(pair.pairKey);
            participantsThisRound.add(pair.paperA);
            participantsThisRound.add(pair.paperB);
        }
        assert.equal(participantsThisRound.size, 4);
    }
    // 3 rounds on 4 items covers all C(4, 2) = 6 unique pairs.
    assert.equal(seenPairs.size, 6);
});

test('Wave 14.4: planSwissRoundPairs handles odd N=3 and N=25 with clean bye rotation and huge API savings', () => {
    // Odd N=3 across 3 rounds -> each paper gets exactly 1 bye and plays each other once.
    const smallOdd = [
        { id: 'A', rating: 8.0 },
        { id: 'B', rating: 7.5 },
        { id: 'C', rating: 7.0 }
    ];
    const smallSchedule = bt.planSwissTournamentSchedule(smallOdd, { rounds: 3, seed: 'odd-3' });
    const byes3 = smallSchedule.scheduleRounds.map(r => r.bye);
    assert.equal(new Set(byes3).size, 3, 'Each of 3 papers should receive a distinct bye across 3 rounds');
    assert.equal(smallSchedule.totalRepeatedPairs, 0);
    assert.equal(smallSchedule.uniquePairsPlanned, 3);

    // Realistic batch N=25, rounds=3: 12 pairs/round = 36 pairs, 72 bidirectional evals vs 600 full round-robin!
    const batch25 = Array.from({ length: 25 }, (_, i) => ({
        id: `2611.${String(25000 + i)}v1`,
        rating: Number((6.0 + (i % 7) * 0.35).toFixed(2))
    }));
    const schedule25 = bt.planSwissTournamentSchedule(batch25, {
        rounds: 3,
        seed: 'daily-2026-11-24',
        bidirectional: true
    });
    assert.equal(schedule25.totalPairs, 36);
    assert.equal(schedule25.uniquePairsPlanned, 36);
    assert.equal(schedule25.totalRepeatedPairs, 0);
    assert.equal(schedule25.estimatedApiCalls, 72);
    assert.equal(schedule25.fullRoundRobinCalls, 600);
    assert.ok(schedule25.savingsPct >= 85);
    const byes25 = schedule25.scheduleRounds.map(r => r.bye);
    assert.equal(byes25.filter(Boolean).length, 3);
    assert.equal(new Set(byes25).size, 3, 'Byes should rotate cleanly across distinct papers');
});

test('Wave 14.4: planSwissRoundPairs handles small edge sizes (N=2, N=1, N=0) and is deterministic', () => {
    // N=2: round 1 has 0 repeats; round 2 gracefully falls back to repeat with isRepeat=true.
    const two = [{ id: 'X', rating: 7.8 }, { id: 'Y', rating: 7.4 }];
    const r1 = bt.planSwissRoundPairs(two, { round: 1, seed: 's' });
    assert.equal(r1.pairs.length, 1);
    assert.equal(r1.pairs[0].isRepeat, false);
    assert.equal(r1.bye, null);

    const r2 = bt.planSwissRoundPairs(two, {
        round: 2,
        seed: 's',
        previousPairs: [r1.pairs[0].pairKey]
    });
    assert.equal(r2.pairs.length, 1);
    assert.equal(r2.pairs[0].isRepeat, true);
    assert.equal(r2.repeatedPairsCount, 1);

    // N=1 and N=0
    const one = bt.planSwissRoundPairs([{ id: 'ONLY', rating: 8.0 }], { round: 1 });
    assert.equal(one.pairs.length, 0);
    assert.equal(one.bye, 'ONLY');
    assert.equal(one.estimatedEvaluations, 0);

    const empty = bt.planSwissRoundPairs([], { round: 1 });
    assert.equal(empty.pairs.length, 0);
    assert.equal(empty.bye, null);

    // Determinism & input-order permutation invariance (even when all ratings are tied!).
    const tied = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].map(id => ({ id, rating: 7.4 }));
    const tiedShuffled = [tied[4], tied[1], tied[5], tied[0], tied[3], tied[2]];
    const runA = bt.planSwissRoundPairs(tied, { round: 1, seed: 'det-seed' });
    const runB = bt.planSwissRoundPairs(tiedShuffled, { round: 1, seed: 'det-seed' });
    assert.deepEqual(runA, runB);
});

// ═══════════════════════════════════════════════════════
// 3. Position-Swap Bias Mitigation & Diagnostics
// ═══════════════════════════════════════════════════════

test('Wave 14.4: position-swap resolves unanimous wins, inconsistent flips to 0.5 tie, and tracks consistency rate', () => {
    // Unanimous A (forward: A wins -> P1; reverse: B wins -> P1)
    const unanimousA = bt.resolvePositionSwappedComparison({
        paperA: 'P1',
        paperB: 'P2',
        forward: { winner: 'A', confidence: 'high', reason: 'P1 stronger' },
        reverse: { winner: 'B', confidence: 'high', reason: 'P1 stronger in slot B too' }
    });
    assert.equal(unanimousA.scoreA, 1);
    assert.equal(unanimousA.scoreB, 0);
    assert.equal(unanimousA.consistent, true);
    assert.equal(unanimousA.positionBiasDetected, false);
    assert.equal(unanimousA.resolution, 'unanimous_A');

    // Inconsistent first-slot bias flip: forward picks A (P1 beats P2) AND reverse picks A (P2 beats P1)!
    const flipFirstSlot = bt.resolvePositionSwappedComparison({
        paperA: 'P1',
        paperB: 'P2',
        forward: { winner: 'A', confidence: 'medium', reason: 'Slot A looked good' },
        reverse: { winner: 'A', confidence: 'medium', reason: 'Slot A looked good again' }
    });
    assert.equal(flipFirstSlot.scoreA, 0.5);
    assert.equal(flipFirstSlot.scoreB, 0.5);
    assert.equal(flipFirstSlot.resolvedWinner, 'tie');
    assert.equal(flipFirstSlot.consistent, false);
    assert.equal(flipFirstSlot.flipped, true);
    assert.equal(flipFirstSlot.positionBiasDetected, true);
    assert.equal(flipFirstSlot.positionBiasType, 'first_slot');
    assert.equal(flipFirstSlot.resolution, 'position_flip_tie');

    // Inconsistent second-slot bias flip: forward picks B (P2) AND reverse picks B (P1)!
    const flipSecondSlot = bt.resolvePositionSwappedComparison({
        paperA: 'P1',
        paperB: 'P2',
        forward: { winner: 'B', confidence: 'low', reason: 'Recency bias' },
        reverse: { winner: 'B', confidence: 'low', reason: 'Recency bias' }
    });
    assert.equal(flipSecondSlot.scoreA, 0.5);
    assert.equal(flipSecondSlot.scoreB, 0.5);
    assert.equal(flipSecondSlot.positionBiasType, 'second_slot');

    // Partial agreement: forward A (P1), reverse tie -> 0.75 / 0.25
    const partial = bt.resolvePositionSwappedComparison({
        paperA: 'P1',
        paperB: 'P2',
        forward: { winner: 'A', confidence: 'medium', reason: 'Slight edge to P1' },
        reverse: { winner: 'tie', confidence: 'low', reason: 'Very close' }
    });
    assert.equal(partial.scoreA, 0.75);
    assert.equal(partial.scoreB, 0.25);
    assert.equal(partial.consistent, false);
    assert.equal(partial.flipped, false);
    assert.equal(partial.partialAgreement, true);

    // Aggregate positionConsistencyRate across 4 bidirectional pairs (2 consistent, 1 flip, 1 partial -> 0.5)
    const agg = bt.normalizeAndResolveComparisons([
        {
            round: 1,
            paperA: 'P2', // intentionally reverse lexicographical order to test orientation swap!
            paperB: 'P1',
            forward: { winner: 'A', confidence: 'high', reason: 'P2 beats P1' },
            reverse: { winner: 'B', confidence: 'high', reason: 'P2 beats P1' }
        },
        {
            round: 1,
            paperA: 'P3',
            paperB: 'P4',
            forward: { winner: 'tie', confidence: 'low', reason: 'Equal' },
            reverse: { winner: 'tie', confidence: 'low', reason: 'Equal' }
        },
        {
            round: 1,
            paperA: 'P1',
            paperB: 'P3',
            forward: { winner: 'A', confidence: 'medium', reason: 'Primacy flip' },
            reverse: { winner: 'A', confidence: 'medium', reason: 'Primacy flip' }
        },
        {
            round: 1,
            paperA: 'P2',
            paperB: 'P4',
            forward: { winner: 'A', confidence: 'medium', reason: 'Edge to P2' },
            reverse: { winner: 'tie', confidence: 'low', reason: 'Close' }
        }
    ]);

    assert.equal(agg.positionConsistencyRate, 0.5);
    assert.equal(agg.positionFlipRate, 0.25);
    assert.equal(agg.positionBiasSummary.firstSlotBiasCount, 1);

    // Verify P2 > P1 remained intact after canonicalizing paperA='P1', paperB='P2',
    // AND verify round-trip idempotency when re-normalizing the canonicalized array!
    const p1p2 = agg.resolvedComparisons.find(r => r.pairKey === 'P1::P2');
    assert.equal(p1p2.paperA, 'P1');
    assert.equal(p1p2.paperB, 'P2');
    assert.equal(p1p2.scoreA, 0);
    assert.equal(p1p2.scoreB, 1);
    assert.equal(p1p2.resolvedWinner, 'B');

    const roundTrip = bt.normalizeAndResolveComparisons(agg.resolvedComparisons);
    assert.deepEqual(roundTrip.resolvedComparisons, agg.resolvedComparisons);
    assert.equal(roundTrip.positionConsistencyRate, agg.positionConsistencyRate);
});

// ═══════════════════════════════════════════════════════
// 4. Bradley-Terry MLE Solver Convergence & Edge Graphs
// ═══════════════════════════════════════════════════════

test('Wave 14.4: fitBradleyTerryRatings converges cleanly on transitive, cyclic, disconnected, and undefeated/winless graphs', () => {
    // (a) Transitive 5-node tournament: A > B > C > D > E
    const transIds = ['A', 'B', 'C', 'D', 'E'];
    const transComps = [];
    for (let i = 0; i < transIds.length; i += 1) {
        for (let j = i + 1; j < transIds.length; j += 1) {
            transComps.push({ paperA: transIds[i], paperB: transIds[j], winner: 'A' });
        }
    }
    const transFit = bt.fitBradleyTerryRatings(transIds, transComps);
    assert.equal(transFit.converged, true);
    assert.ok(transFit.maxDelta <= 1e-9);
    assert.ok(transFit.iterations <= 500);
    assert.ok(transFit.logStrengths.A > transFit.logStrengths.B);
    assert.ok(transFit.logStrengths.B > transFit.logStrengths.C);
    assert.ok(transFit.logStrengths.C > transFit.logStrengths.D);
    assert.ok(transFit.logStrengths.D > transFit.logStrengths.E);
    assert.deepEqual(transFit.winMatrixSummary.undefeatedItems, ['A']);
    assert.deepEqual(transFit.winMatrixSummary.winlessItems, ['E']);
    for (const id of transIds) {
        assert.ok(Number.isFinite(transFit.ratings[id]) && transFit.ratings[id] > 0);
        assert.ok(Number.isFinite(transFit.logStrengths[id]));
    }

    // Verify exact MLE stationary condition: (W_i + alpha) == 2*alpha*p_i/(p_i+1) + sum_j n_ij*p_i/(p_i+p_j)
    const alpha = transFit.priorWeight;
    for (const id of transIds) {
        const pi = transFit.ratings[id];
        const wi = transFit.winMatrixSummary.perItem[id].effectiveWins;
        let expected = (2 * alpha * pi) / (pi + 1);
        for (const other of transIds) {
            if (other === id) continue;
            expected += pi / (pi + transFit.ratings[other]);
        }
        assert.ok(Math.abs((wi + alpha) - expected) < 1e-7, `MLE stationarity check failed for ${id}`);
    }

    // (b) Pure 3-cycle: A > B > C > A -> symmetric equal ratings
    const cycleFit = bt.fitBradleyTerryRatings(['A', 'B', 'C'], [
        { paperA: 'A', paperB: 'B', winner: 'A' },
        { paperA: 'B', paperB: 'C', winner: 'A' },
        { paperA: 'C', paperB: 'A', winner: 'A' }
    ]);
    assert.equal(cycleFit.converged, true);
    assert.ok(Math.abs(cycleFit.logStrengths.A) < 1e-9);
    assert.ok(Math.abs(cycleFit.logStrengths.B) < 1e-9);
    assert.ok(Math.abs(cycleFit.logStrengths.C) < 1e-9);

    // (c) Disconnected graph: {A > B}, {C > D > E}, and isolated {F}
    const discFit = bt.fitBradleyTerryRatings(['F', 'E', 'D', 'C', 'B', 'A'], [
        { paperA: 'A', paperB: 'B', winner: 'A' },
        { paperA: 'C', paperB: 'D', winner: 'A' },
        { paperA: 'D', paperB: 'E', winner: 'A' },
        { paperA: 'C', paperB: 'E', winner: 'A' }
    ]);
    assert.equal(discFit.converged, true);
    assert.ok(discFit.maxDelta <= 1e-9);
    assert.equal(discFit.winMatrixSummary.connectedComponents, 3);
    assert.deepEqual(discFit.winMatrixSummary.isolatedItems, ['F']);
    assert.ok(discFit.logStrengths.A > discFit.logStrengths.B);
    assert.ok(discFit.logStrengths.C > discFit.logStrengths.D);
    assert.ok(discFit.logStrengths.D > discFit.logStrengths.E);
    assert.equal(discFit.logStrengths.F, 0);
    assert.equal(discFit.ratings.F, 1);

    // (d) Extreme undefeated/winless 20-0 blowout -> still finite, zero NaN/Infinity!
    const blowoutComps = Array.from({ length: 20 }, (_, i) => ({
        round: i + 1,
        paperA: 'CHAMP',
        paperB: 'ZERO',
        winner: 'A'
    }));
    const blowoutFit = bt.fitBradleyTerryRatings(['CHAMP', 'ZERO'], blowoutComps);
    assert.equal(blowoutFit.converged, true);
    assert.ok(Number.isFinite(blowoutFit.ratings.CHAMP) && blowoutFit.ratings.CHAMP > 1);
    assert.ok(Number.isFinite(blowoutFit.ratings.ZERO) && blowoutFit.ratings.ZERO > 0 && blowoutFit.ratings.ZERO < 1);
    assert.ok(Math.abs(blowoutFit.logStrengths.CHAMP + blowoutFit.logStrengths.ZERO) < 1e-7);
    assert.ok(blowoutFit.maxDelta <= 1e-9);

    // (e) Permutation invariance: reversed itemIds and shuffled comparisons yield identical fit.
    const transFitShuffled = bt.fitBradleyTerryRatings(
        transIds.slice().reverse(),
        transComps.slice().reverse()
    );
    assert.deepEqual(transFitShuffled.logStrengths, transFit.logStrengths);
    assert.deepEqual(transFitShuffled.ratings, transFit.ratings);
});

// ═══════════════════════════════════════════════════════
// 5. Bounded Score Calibration, Tie-Cluster Breaking, Kendall's Tau & Replay Determinism
// ═══════════════════════════════════════════════════════

test('Wave 14.4: calibrateBatchScores sharpens an 8-paper tie cluster at 7.4 within ±maxDelta without mutating input', () => {
    const ids = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'];
    const sealedBatch = deepFreeze({
        batchDate: '2026-11-24',
        papers: ids.map(id => makeRealisticPaper(id, 7.4))
    });

    // Clear transitive ground truth: P1 > P2 > ... > P8 via bidirectional comparisons.
    const comparisons = [];
    for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < Math.min(ids.length, i + 4); j += 1) {
            comparisons.push({
                round: j - i,
                paperA: ids[i],
                paperB: ids[j],
                forward: { winner: 'A', confidence: 'high', reason: `${ids[i]} beats ${ids[j]}` },
                reverse: { winner: 'B', confidence: 'high', reason: `${ids[i]} beats ${ids[j]} reversed` }
            });
        }
    }

    const result = bt.calibrateBatchScores(sealedBatch, comparisons, { maxDelta: 0.6, rounds: 3 });

    assert.equal(result.contract, 'batch-score-calibration-v1');
    assert.equal(result.solver.converged, true);
    assert.equal(result.readOnlyInvariant.mutatedSealedInput, false);
    assert.equal(result.readOnlyInvariant.overwroteScoringAudit, false);
    assert.equal(result.diagnostics.positionConsistencyRate, 1);

    // Every single paper remains strictly within [7.4 - 0.6, 7.4 + 0.6] = [6.8, 8.0].
    for (const p of result.papers) {
        assert.equal(p.rawScore, 7.4);
        assert.ok(Math.abs(p.calibratedScore - p.rawScore) <= 0.6 + 1e-12, `Exceeded maxDelta for ${p.paperId}`);
        assert.ok(p.calibratedScore >= 0 && p.calibratedScore <= 10);
    }

    // All 8 papers broke out of the 7.4 tie cluster in exact BT order P1 > P2 > ... > P8!
    assert.deepEqual(result.papers.map(p => p.paperId), ids);
    assert.equal(result.diagnostics.tieClusterStats.rawTieClusterCount, 1);
    assert.equal(result.diagnostics.tieClusterStats.totalRawTiedPairs, 28);
    assert.equal(result.diagnostics.tieClusterStats.brokenTiesCount, 28);
    assert.equal(result.diagnostics.tieClusterStats.tieBreakRate, 1);
    assert.equal(result.diagnostics.tieClusterStats.calibratedTieClusterCount, 0);

    // Mean stays anchored at 7.4; Kendall's tau is null (not NaN) because all raw scores were identical.
    assert.ok(Math.abs(result.diagnostics.scoreSummary.calibratedMean - 7.4) < 0.05);
    assert.equal(result.diagnostics.kendallTau, null);

    // Replay determinism: re-running with shuffled comparisons & replaying sidecar's own comparisons
    // yields IDENTICAL inputSha256, comparisonsSha256, and calibrationSha256!
    const reversedComparisons = comparisons.slice().reverse();
    const rerunShuffled = bt.calibrateBatchScores(sealedBatch, reversedComparisons, { maxDelta: 0.6, rounds: 3 });
    assert.equal(rerunShuffled.inputSha256, result.inputSha256);
    assert.equal(rerunShuffled.comparisonsSha256, result.comparisonsSha256);
    assert.equal(rerunShuffled.calibrationSha256, result.calibrationSha256);

    const replayFromSidecar = bt.calibrateBatchScores(sealedBatch, result.comparisons, { maxDelta: 0.6, rounds: 3 });
    assert.equal(replayFromSidecar.calibrationSha256, result.calibrationSha256);
    assert.deepEqual(replayFromSidecar.papers, result.papers);
});

test('Wave 14.4: calibrateBatchScores enforces strict ±maxDelta cap, [0, 10] bounds, Kendall tau-b, and top-K movement', () => {
    const papers = [
        makeRealisticPaper('HIGH', 9.8),
        makeRealisticPaper('MID_A', 7.4),
        makeRealisticPaper('MID_B', 7.4),
        makeRealisticPaper('MID_C', 7.4),
        makeRealisticPaper('LOW', 0.2)
    ];

    // Upsets: LOW beats everyone, HIGH loses to everyone -> forces safety cap to engage!
    const upsetComps = [
        { paperA: 'LOW', paperB: 'HIGH', winner: 'A' },
        { paperA: 'LOW', paperB: 'MID_A', winner: 'A' },
        { paperA: 'LOW', paperB: 'MID_B', winner: 'A' },
        { paperA: 'MID_C', paperB: 'HIGH', winner: 'A' },
        { paperA: 'MID_C', paperB: 'MID_B', winner: 'A' },
        { paperA: 'MID_B', paperB: 'MID_A', winner: 'A' }
    ];

    const maxDelta = 0.45;
    const cal = bt.calibrateBatchScores(papers, upsetComps, { maxDelta });

    assert.ok(cal.diagnostics.scoreSummary.cappedCount >= 2, 'Extreme upsets should hit safety cap');
    assert.ok(cal.diagnostics.scoreSummary.maxObservedDelta <= maxDelta + 1e-12);
    for (const p of cal.papers) {
        assert.ok(Math.abs(p.calibratedScore - p.rawScore) <= maxDelta + 1e-12);
        assert.ok(p.calibratedScore >= 0 && p.calibratedScore <= 10);
    }

    // Because of ±0.45 safety cap, HIGH (9.8 -> >=9.35) stays #1 and LOW (0.2 -> <=0.65) stays #5,
    // preserving the absolute rubric scale while reordering the 7.4 tie cluster (MID_C > MID_B > MID_A)!
    assert.equal(cal.papers[0].paperId, 'HIGH');
    assert.equal(cal.papers[4].paperId, 'LOW');
    const midOrder = cal.papers.slice(1, 4).map(p => p.paperId);
    assert.deepEqual(midOrder, ['MID_C', 'MID_B', 'MID_A']);
    assert.ok(Number.isFinite(cal.diagnostics.kendallTau));
    assert.ok(cal.diagnostics.topKMovement.top3);

    // Quantile-anchored mode also respects ±maxDelta strictly.
    const quantCal = bt.calibrateBatchScores(papers, upsetComps, {
        maxDelta: 0.35,
        mappingMethod: 'quantile_anchored'
    });
    for (const p of quantCal.papers) {
        assert.ok(Math.abs(p.calibratedScore - p.rawScore) <= 0.35 + 1e-12);
    }

    // Exact Kendall's tau-b sanity checks.
    assert.equal(bt.computeKendallTauB([1, 2, 3, 4], [10, 20, 30, 40]).tauB, 1);
    assert.equal(bt.computeKendallTauB([1, 2, 3, 4], [40, 30, 20, 10]).tauB, -1);
    assert.equal(bt.computeKendallTauB([5, 5, 5], [1, 2, 3]).tauB, null);
});

// ═══════════════════════════════════════════════════════
// 6. Blind Pairwise Prompt Builder & Strict Response Parser
// ═══════════════════════════════════════════════════════

test('Wave 14.4: buildPairwiseComparisonPrompt omits raw absolute scores to prevent anchoring', () => {
    const paperA = makeRealisticPaper('2611.26409v1', 8.7, {
        title: 'WeMM-Audio: Unified Acoustic Transformer',
        abstract: 'A unified acoustic transformer achieving 1.9% WER on LibriSpeech.',
        analysis: [
            '## 评分',
            '8.7/10',
            '',
            '## 机器摘要',
            'rank_bucket: 前10%',
            '',
            '## 核心创新点',
            'Proposes causal multi-scale audio tokenization. 总分：8.7/10 (8.7/10)',
            '',
            '## 实验结果',
            'Beats Whisper-Large-v3 on 12 speech benchmarks with full ablations.',
            '',
            '## 开源详情',
            'Weights and code publicly released under Apache-2.0.'
        ].join('\n')
    });
    const paperB = makeRealisticPaper('2611.25960v1', 6.3, {
        title: 'Lightweight Noise Suppressor',
        abstract: 'Small recurrent denoiser for 16 kHz speech enhancement.'
    });

    const prompt = bt.buildPairwiseComparisonPrompt(paperA, paperB);
    const fullText = `${prompt.systemPrompt}\n${prompt.userPrompt}`;

    assert.equal(prompt.messages.length, 2);
    assert.match(prompt.promptSha256, /^[a-f0-9]{64}$/);
    assert.ok(fullText.includes('WeMM-Audio: Unified Acoustic Transformer'));
    assert.ok(fullText.includes('Lightweight Noise Suppressor'));
    assert.ok(fullText.includes('causal multi-scale audio tokenization'));
    assert.ok(fullText.includes('Beats Whisper-Large-v3'));

    // Anti-anchoring assertions: absolute scores and rank buckets MUST NOT appear!
    assert.ok(!fullText.includes('8.7/10'), 'Raw score 8.7/10 must be omitted from blind prompt');
    assert.ok(!fullText.includes('6.3/10'), 'Raw score 6.3/10 must be omitted from blind prompt');
    assert.ok(!fullText.includes('8.7'), 'Raw score numeric 8.7 must be stripped from blind prompt');
    assert.ok(!fullText.includes('rank_bucket'), 'Rank bucket must be omitted from blind prompt');
    assert.ok(!fullText.includes('前10%'), 'Rank bucket label must be omitted from blind prompt');
    assert.ok(prompt.omittedFields.includes('scoringAudit'));
});

test('Wave 14.4: parsePairwiseComparisonResponse strictly validates JSON schema and rejects malformed payloads', () => {
    const clean = bt.parsePairwiseComparisonResponse(
        '{"winner":"A","confidence":"high","reason":"Paper A provides stronger ablations and public weights."}'
    );
    assert.deepEqual(clean, {
        winner: 'A',
        confidence: 'high',
        reason: 'Paper A provides stronger ablations and public weights.'
    });

    const fenced = bt.parsePairwiseComparisonResponse(
        '```json\n{"winner":"Tie","confidence":"MEDIUM","reason":"Comparable novelty and rigor."}\n```'
    );
    assert.deepEqual(fenced, {
        winner: 'tie',
        confidence: 'medium',
        reason: 'Comparable novelty and rigor.'
    });

    // Reject invalid winners, confidences, empty reasons, extra keys, duplicate JSON keys, malformed JSON.
    assert.throws(() => bt.parsePairwiseComparisonResponse('{"winner":"C","confidence":"high","reason":"bad"}'));
    assert.throws(() => bt.parsePairwiseComparisonResponse('{"winner":"Paper A","confidence":"high","reason":"bad"}'));
    assert.throws(() => bt.parsePairwiseComparisonResponse('{"winner":"A","confidence":"certain","reason":"bad"}'));
    assert.throws(() => bt.parsePairwiseComparisonResponse('{"winner":"A","confidence":"high","reason":"   "}'));
    assert.throws(() => bt.parsePairwiseComparisonResponse('{"winner":"A","confidence":"high","reason":"ok","extra":1}'));
    assert.throws(() => bt.parsePairwiseComparisonResponse('{"winner":"A","winner":"B","confidence":"high","reason":"dup"}'));
    assert.throws(() => bt.parsePairwiseComparisonResponse('Winner is A because it is better'));
    assert.throws(() => bt.parsePairwiseComparisonResponse('{"winner":"A","confidence":'));
});

// ═══════════════════════════════════════════════════════
// 7. CLI: --dry-run, --replay, Sealed-Data Guards, Sandbox Enforcement & Mocked --live
// ═══════════════════════════════════════════════════════

test('Wave 14.4 CLI: --dry-run and --replay execute 100% offline, never call requestLlmJson, and preserve sealed input', async () => {
    const tmpDir = makeTempDir();
    try {
        const inputPath = path.join(tmpDir, 'deep-analysis-result.json');
        const dryOutPath = path.join(tmpDir, 'dry-run-plan.json');
        const replayCompsPath = path.join(tmpDir, 'comparisons.json');
        const replayOut1 = path.join(tmpDir, 'score-calibration-v1.json');
        const replayOut2 = path.join(tmpDir, 'score-calibration-v1-second.json');

        const batch = {
            batchDate: '2026-11-24',
            batchId: 'batch-2026-11-24',
            papers: [
                makeRealisticPaper('2611.00001v1', 7.4),
                makeRealisticPaper('2611.00002v1', 7.4),
                makeRealisticPaper('2611.00003v1', 7.4),
                makeRealisticPaper('2611.00004v1', 7.4),
                makeRealisticPaper('2611.00005v1', 8.1)
            ]
        };
        fs.writeFileSync(inputPath, `${JSON.stringify(batch, null, 2)}\n`, 'utf8');
        const sealedShaBefore = bt.sha256Hex(fs.readFileSync(inputPath));

        // 1. Subprocess --dry-run (clean env without any API key!).
        const dryStdout = execFileSync(process.execPath, [
            CLI_PATH,
            '--date', '2026-11-24',
            '--input', inputPath,
            '--output', dryOutPath,
            '--rounds', '3',
            '--max-delta', '0.6',
            '--dry-run',
            '--json'
        ], {
            cwd: ROOT,
            encoding: 'utf8',
            env: { PATH: process.env.PATH, HOME: process.env.HOME }
        });

        const dryPayload = JSON.parse(dryStdout);
        assert.equal(dryPayload.contract, 'batch-score-calibration-v1');
        assert.equal(dryPayload.mode, 'dry_run');
        assert.equal(dryPayload.readOnlyInvariant.llmRequestsSent, 0);
        assert.equal(dryPayload.schedule.rounds, 3);
        assert.equal(dryPayload.schedule.totalPairs, 6); // floor(5/2)=2 pairs/round * 3
        assert.equal(dryPayload.schedule.estimatedApiCalls, 12); // bidirectional
        assert.equal(dryPayload.schedule.totalRepeatedPairs, 0);
        assert.equal(dryPayload.sourceFileSha256, sealedShaBefore);
        assert.ok(fs.existsSync(dryOutPath));

        // 2. Flat directional comparisons log -> Subprocess --replay.
        const directionalLog = [
            // Round 1: 00001 beats 00002 unanimously
            { round: 1, paperA: '2611.00001v1', paperB: '2611.00002v1', direction: 'forward', presentedA: '2611.00001v1', presentedB: '2611.00002v1', winner: 'A', confidence: 'high', reason: 'Stronger ablations' },
            { round: 1, paperA: '2611.00001v1', paperB: '2611.00002v1', direction: 'reverse', presentedA: '2611.00002v1', presentedB: '2611.00001v1', winner: 'B', confidence: 'high', reason: 'Stronger ablations reversed' },
            // Round 1: 00003 vs 00004 position-swap flip -> resolves to 0.5 tie!
            { round: 1, paperA: '2611.00003v1', paperB: '2611.00004v1', direction: 'forward', presentedA: '2611.00003v1', presentedB: '2611.00004v1', winner: 'A', confidence: 'low', reason: 'Slot A preference' },
            { round: 1, paperA: '2611.00003v1', paperB: '2611.00004v1', direction: 'reverse', presentedA: '2611.00004v1', presentedB: '2611.00003v1', winner: 'A', confidence: 'low', reason: 'Slot A preference again' },
            // Round 2: 00005 beats 00001 unanimously; 00002 beats 00003 unanimously
            { round: 2, paperA: '2611.00005v1', paperB: '2611.00001v1', direction: 'forward', presentedA: '2611.00005v1', presentedB: '2611.00001v1', winner: 'A', confidence: 'high', reason: 'Clear top paper' },
            { round: 2, paperA: '2611.00005v1', paperB: '2611.00001v1', direction: 'reverse', presentedA: '2611.00001v1', presentedB: '2611.00005v1', winner: 'B', confidence: 'high', reason: 'Clear top paper reversed' },
            { round: 2, paperA: '2611.00002v1', paperB: '2611.00003v1', direction: 'forward', presentedA: '2611.00002v1', presentedB: '2611.00003v1', winner: 'A', confidence: 'medium', reason: 'Better audio benchmarks' },
            { round: 2, paperA: '2611.00002v1', paperB: '2611.00003v1', direction: 'reverse', presentedA: '2611.00003v1', presentedB: '2611.00002v1', winner: 'B', confidence: 'medium', reason: 'Better audio benchmarks reversed' }
        ];
        fs.writeFileSync(replayCompsPath, JSON.stringify(directionalLog, null, 2), 'utf8');

        execFileSync(process.execPath, [
            CLI_PATH,
            '--date', '2026-11-24',
            '--input', inputPath,
            '--replay', replayCompsPath,
            '--output', replayOut1,
            '--max-delta', '0.6'
        ], {
            cwd: ROOT,
            encoding: 'utf8',
            env: { PATH: process.env.PATH, HOME: process.env.HOME }
        });

        // Second replay directly from the generated sidecar itself!
        execFileSync(process.execPath, [
            CLI_PATH,
            '--date', '2026-11-24',
            '--input', inputPath,
            '--replay', replayOut1,
            '--output', replayOut2,
            '--max-delta', '0.6'
        ], {
            cwd: ROOT,
            encoding: 'utf8',
            env: { PATH: process.env.PATH, HOME: process.env.HOME }
        });

        const sidecar1 = JSON.parse(fs.readFileSync(replayOut1, 'utf8'));
        const sidecar2 = JSON.parse(fs.readFileSync(replayOut2, 'utf8'));

        assert.equal(sidecar1.contract, 'batch-score-calibration-v1');
        assert.equal(sidecar1.mode, 'replay');
        assert.equal(sidecar1.readOnlyInvariant.llmRequestsSent, 0);
        assert.equal(sidecar1.diagnostics.positionConsistencyRate, 0.75); // 3 consistent / 4 bidirectional
        assert.equal(sidecar1.diagnostics.positionFlipRate, 0.25);
        assert.equal(sidecar1.calibrationSha256, sidecar2.calibrationSha256);
        assert.equal(sidecar1.comparisonsSha256, sidecar2.comparisonsSha256);
        assert.deepEqual(sidecar1.papers, sidecar2.papers);

        // Sealed deep-analysis-result.json bytes MUST be 100% untouched!
        const sealedShaAfter = bt.sha256Hex(fs.readFileSync(inputPath));
        assert.equal(sealedShaAfter, sealedShaBefore);

        // In-process proof: requestLlmJson is NEVER invoked during --dry-run or --replay!
        const originalRequestLlmJson = utils.requestLlmJson;
        utils.requestLlmJson = async () => {
            throw new Error('requestLlmJson MUST NOT be called in offline mode');
        };
        try {
            const inProcDry = await cli.runCalibrationCli(['--input', inputPath, '--dry-run']);
            assert.equal(inProcDry.sidecar.mode, 'dry_run');
            const inProcReplay = await cli.runCalibrationCli([
                '--input', inputPath,
                '--replay', replayCompsPath,
                '--output', path.join(tmpDir, 'inproc-replay.json')
            ]);
            assert.equal(inProcReplay.sidecar.calibrationSha256, sidecar1.calibrationSha256);
        } finally {
            utils.requestLlmJson = originalRequestLlmJson;
        }
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('Wave 14.4 CLI: enforces sealed-input overwrite protection, explicit mode opt-in, and requireExternalRuntime sandbox block', () => {
    const tmpDir = makeTempDir();
    try {
        const inputPath = path.join(tmpDir, 'deep-analysis-result.json');
        fs.writeFileSync(inputPath, JSON.stringify({
            batchDate: '2026-11-24',
            papers: [makeRealisticPaper('2611.00001v1', 7.5), makeRealisticPaper('2611.00002v1', 7.5)]
        }), 'utf8');

        // Refuses overwriting sealed input or any file named deep-analysis-result.json.
        assert.throws(() => cli.assertSafeOutputPath(inputPath, inputPath), /Refusing to write/);
        assert.throws(
            () => cli.assertSafeOutputPath(inputPath, path.join(tmpDir, 'other', 'deep-analysis-result.json')),
            /deep-analysis-result\.json/
        );

        // Refuses implicit live execution when no mode flag is provided.
        assert.throws(() => cli.parseCliArgs(['--input', inputPath]), /Explicit mode required/);

        // Refuses mutually exclusive modes.
        assert.throws(() => cli.parseCliArgs(['--input', inputPath, '--dry-run', '--live']), /mutually exclusive/);

        // Direct CLI execution MUST reject CODEX_SANDBOX via requireExternalRuntime().
        const sandboxRun = spawnSync(process.execPath, [CLI_PATH, '--input', inputPath, '--dry-run'], {
            cwd: ROOT,
            encoding: 'utf8',
            env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                CODEX_SANDBOX: 'seatbelt'
            }
        });
        assert.notEqual(sandboxRun.status, 0);
        assert.match(sandboxRun.stderr, /CODEX_SANDBOX/);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('Wave 14.4 CLI: explicit --live mode executes round-by-round Swiss tournament via requestFn without mutating sealed input', async () => {
    const tmpDir = makeTempDir();
    try {
        const inputPath = path.join(tmpDir, 'deep-analysis-result.json');
        const outPath = path.join(tmpDir, 'score-calibration-v1.json');

        const batch = {
            batchDate: '2026-11-24',
            papers: [
                makeRealisticPaper('2611.10001v1', 7.4, { title: 'Alpha Codec' }),
                makeRealisticPaper('2611.10002v1', 7.4, { title: 'Beta Codec' }),
                makeRealisticPaper('2611.10003v1', 7.4, { title: 'Gamma Codec' }),
                makeRealisticPaper('2611.10004v1', 7.4, { title: 'Delta Codec' })
            ]
        };
        fs.writeFileSync(inputPath, `${JSON.stringify(batch, null, 2)}\n`, 'utf8');
        const sealedBefore = bt.sha256Hex(fs.readFileSync(inputPath));

        // Deterministic mock judge preferring Alpha > Beta > Gamma > Delta regardless of slot order.
        const merit = {
            'Alpha Codec': 4,
            'Beta Codec': 3,
            'Gamma Codec': 2,
            'Delta Codec': 1
        };
        let callCount = 0;
        const mockRequestFn = async (_apiUrl, _endpoint, _model, body) => {
            callCount += 1;
            const userMsg = body.messages ? body.messages[1].content : body.input[1].content[0].text;
            assert.ok(!userMsg.includes('7.4/10'), 'Live blind prompt must omit raw scores');
            const titleMatches = Array.from(userMsg.matchAll(/- Title: (.+)/g)).map(m => m[1].trim());
            assert.equal(titleMatches.length, 2);
            const scoreA = merit[titleMatches[0]];
            const scoreB = merit[titleMatches[1]];
            const winner = scoreA > scoreB ? 'A' : (scoreB > scoreA ? 'B' : 'tie');
            const content = JSON.stringify({
                winner,
                confidence: 'high',
                reason: `${titleMatches[0]} vs ${titleMatches[1]} evaluated blindly.`
            });
            return {
                statusCode: 200,
                body: {
                    choices: [{ message: { content }, finish_reason: 'stop' }]
                }
            };
        };

        const res = await cli.runCalibrationCli([
            '--date', '2026-11-24',
            '--input', inputPath,
            '--output', outPath,
            '--rounds', '3',
            '--max-delta', '0.5',
            '--live'
        ], {
            skipEnvLoad: true,
            llmConfig: {
                endpoint: 'https://api.example.com/v1',
                apiKey: 'test-key-not-sent',
                apiKeys: ['test-key-not-sent'],
                model: 'mimo-v2.6-flash'
            },
            requestFn: mockRequestFn
        });

        // 4 papers * 3 rounds = 6 matchups * 2 bidirectional evals = 12 LLM calls.
        assert.equal(callCount, 12);
        assert.equal(res.sidecar.mode, 'live');
        assert.equal(res.sidecar.readOnlyInvariant.llmRequestsSent, 12);
        assert.equal(res.sidecar.diagnostics.positionConsistencyRate, 1);
        assert.deepEqual(
            res.sidecar.papers.map(p => p.paperId),
            ['2611.10001v1', '2611.10002v1', '2611.10003v1', '2611.10004v1']
        );
        assert.ok(fs.existsSync(outPath));
        assert.equal(bt.sha256Hex(fs.readFileSync(inputPath)), sealedBefore);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ═══════════════════════════════════════════════════════
// 8. Round 1 Adversarial Review Regression Tests (All 11 P0/P1/P2 Fixes)
// ═══════════════════════════════════════════════════════

test('Wave 14.4 Regression [P0-1]: assertSafeOutputPath blocks case variants, symlinks, dirs, hardlinks & validates BEFORE paid calls', async () => {
    const tmpDir = makeTempDir('wave14-4-p01-');
    try {
        const subDir = path.join(tmpDir, 'sealed');
        fs.mkdirSync(subDir, { recursive: true });
        const inputPath = path.join(subDir, 'my-sealed-batch.json');
        fs.writeFileSync(inputPath, JSON.stringify({
            batchDate: '2026-11-24',
            papers: [makeRealisticPaper('2611.00001v1', 7.4), makeRealisticPaper('2611.00002v1', 7.4)]
        }), 'utf8');

        // Empty / whitespace output path
        assert.throws(() => cli.assertSafeOutputPath(inputPath, ''), /non-empty/);
        assert.throws(() => cli.assertSafeOutputPath(inputPath, '   '), /non-empty/);

        // Case-insensitive basename deep-analysis-result.json
        assert.throws(
            () => cli.assertSafeOutputPath(inputPath, path.join(tmpDir, 'DEEP-ANALYSIS-RESULT.JSON')),
            /deep-analysis-result\.json/
        );
        assert.throws(
            () => cli.assertSafeOutputPath(inputPath, path.join(tmpDir, 'nonexistent-dir', 'Deep-Analysis-Result.json')),
            /deep-analysis-result\.json/
        );

        // Existing directory
        assert.throws(() => cli.assertSafeOutputPath(inputPath, subDir), /directory/);

        // Existing symlink to sealed input AND dangling symlink
        const symlinkToInput = path.join(tmpDir, 'sidecar-link.json');
        fs.symlinkSync(inputPath, symlinkToInput);
        assert.throws(() => cli.assertSafeOutputPath(inputPath, symlinkToInput), /symbolic link/);

        const danglingLink = path.join(tmpDir, 'dangling-link.json');
        fs.symlinkSync(path.join(tmpDir, 'does-not-exist.json'), danglingLink);
        assert.throws(() => cli.assertSafeOutputPath(inputPath, danglingLink), /symbolic link/);

        // Symlinked ancestor directory resolving to sealed input
        const dirSymlink = path.join(tmpDir, 'sealed-alias');
        fs.symlinkSync(subDir, dirSymlink);
        assert.throws(
            () => cli.assertSafeOutputPath(inputPath, path.join(dirSymlink, 'my-sealed-batch.json')),
            /Refusing to write/
        );

        // Hardlink to sealed input under an unrelated filename
        const hardlinkPath = path.join(tmpDir, 'score-calibration-v1.json');
        fs.linkSync(inputPath, hardlinkPath);
        assert.throws(() => cli.assertSafeOutputPath(inputPath, hardlinkPath), /hardlink/);

        // Case-insensitive comparison on darwin/win32
        if (process.platform === 'darwin' || process.platform === 'win32') {
            assert.throws(
                () => cli.assertSafeOutputPath(inputPath, path.join(subDir, 'MY-SEALED-BATCH.JSON')),
                /Refusing to write/
            );
        }

        // Pre-payment guarantee: --live with unsafe --output MUST fail with 0 LLM requests sent!
        let liveCalls = 0;
        await assert.rejects(
            () => cli.runCalibrationCli([
                '--input', inputPath,
                '--output', hardlinkPath,
                '--live'
            ], {
                skipEnvLoad: true,
                llmConfig: {
                    endpoint: 'https://api.example.com/v1',
                    apiKey: 'k',
                    apiKeys: ['k'],
                    model: 'mimo-v2.6-flash'
                },
                requestFn: async () => {
                    liveCalls += 1;
                    throw new Error('should never be invoked');
                }
            }),
            /hardlink/
        );
        assert.equal(liveCalls, 0, 'Unsafe --output must abort BEFORE dispatching any paid LLM request');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('Wave 14.4 Regression [P0-2]: runWithConcurrency stops dispatching new tasks immediately on first failure', async () => {
    const started = [];
    const tasks = Array.from({ length: 20 }, (_, idx) => async () => {
        started.push(idx);
        await new Promise(resolve => setTimeout(resolve, 10));
        if (idx === 0) {
            throw new Error('STOP_DISPATCH_ERROR');
        }
        return idx;
    });

    await assert.rejects(
        () => cli.runWithConcurrency(tasks, 2),
        /STOP_DISPATCH_ERROR/
    );
    // With concurrency 2, at most the initial 2 in-flight workers should ever start; remaining 18 must NOT be dispatched!
    assert.ok(started.length <= 2, `Expected fail-fast <=2 dispatched tasks, got ${started.length}`);
});

test('Wave 14.4 Regression [P0-3]: --live uses 32768 default max_tokens and rejects truncation across Responses, Chat, and Anthropic', async () => {
    assert.equal(cli.DEFAULT_LIVE_MAX_TOKENS, 32768);
    const parsedDefault = cli.parseCliArgs(['--dry-run']);
    assert.equal(parsedDefault.maxTokens, 32768);
    const parsedCustom = cli.parseCliArgs(['--dry-run', '--max-tokens', '65536']);
    assert.equal(parsedCustom.maxTokens, 65536);

    const paperA = makeRealisticPaper('2611.20001v1', 7.5);
    const paperB = makeRealisticPaper('2611.20002v1', 7.5);

    // 1. OpenAI Responses (muse-spark-1.3-contributor) truncation passes effectiveMaxTokens cleanly
    let seenMaxOutputTokens = null;
    await assert.rejects(
        () => cli.invokeSinglePairwiseEvaluation(paperA, paperB, {
            endpoint: 'https://opencode.ai/zen/go/v1',
            apiKey: 'k',
            apiKeys: ['k'],
            model: 'muse-spark-1.3-contributor'
        }, {
            requestFn: async (_url, _ep, _m, body) => {
                seenMaxOutputTokens = body.max_output_tokens;
                return {
                    statusCode: 200,
                    body: {
                        status: 'incomplete',
                        incomplete_details: { reason: 'max_output_tokens' },
                        usage: { output_tokens: 32768 },
                        output_text: '{"winner":"A"'
                    }
                };
            }
        }),
        err => err.code === 'MODEL_OUTPUT_TRUNCATED' && err.message.includes('max_output_tokens=32768')
    );
    assert.equal(seenMaxOutputTokens, 32768);

    // 2. OpenAI Chat finish_reason='length' rejected explicitly
    await assert.rejects(
        () => cli.invokeSinglePairwiseEvaluation(paperA, paperB, {
            endpoint: 'https://api.example.com/v1',
            apiKey: 'k',
            apiKeys: ['k'],
            model: 'mimo-v2.6-flash'
        }, {
            maxTokens: 8192,
            requestFn: async () => ({
                statusCode: 200,
                body: {
                    choices: [{
                        message: { content: '{"winner":"A","confidence":"high","reason":"truncated"}' },
                        finish_reason: 'length'
                    }]
                }
            })
        }),
        err => err.code === 'MODEL_OUTPUT_TRUNCATED' && err.message.includes('finish_reason=length')
    );

    // 3. Anthropic stop_reason='max_tokens' rejected explicitly
    await assert.rejects(
        () => cli.invokeSinglePairwiseEvaluation(paperA, paperB, {
            endpoint: 'https://api.anthropic.com/v1',
            apiKey: 'k',
            apiKeys: ['k'],
            model: 'claude-sonnet-4-5'
        }, {
            maxTokens: 8192,
            requestFn: async () => ({
                statusCode: 200,
                body: {
                    stop_reason: 'max_tokens',
                    content: [{ type: 'text', text: '{"winner":"A","confidence":"high","reason":"truncated"}' }]
                }
            })
        }),
        err => err.code === 'MODEL_OUTPUT_TRUNCATED' && err.message.includes('stop_reason=max_tokens')
    );
});

test('Wave 14.4 Regression [P1-4]: true log-space BT MM never overflows/NaNs, flags hitBoundary without false convergence, and bounds priorWeight', () => {
    // priorWeight bounds [1e-6, 1e6]
    assert.equal(bt.validatePriorWeight(1e-6), 1e-6);
    assert.equal(bt.validatePriorWeight(1e6), 1e6);
    assert.throws(() => bt.validatePriorWeight(1e-7), RangeError);
    assert.throws(() => bt.validatePriorWeight(1e7), RangeError);

    // Extreme 100-item chain with tiny priorWeight=1e-6: log-space stays finite, zero NaN/Inf.
    const chainIds = Array.from({ length: 12 }, (_, i) => `C${String(i).padStart(2, '0')}`);
    const chainComps = [];
    for (let i = 0; i < chainIds.length; i += 1) {
        for (let j = i + 1; j < chainIds.length; j += 1) {
            chainComps.push({ paperA: chainIds[i], paperB: chainIds[j], winner: 'A' });
        }
    }
    const tightFit = bt.fitBradleyTerryRatings(chainIds, chainComps, { priorWeight: 1e-6, maxIterations: 500 });
    for (const id of chainIds) {
        assert.ok(Number.isFinite(tightFit.logStrengths[id]), `Non-finite logStrength for ${id}`);
        assert.ok(Number.isFinite(tightFit.ratings[id]) && tightFit.ratings[id] > 0, `Non-finite rating for ${id}`);
    }
    assert.ok(tightFit.logStrengths.C00 > tightFit.logStrengths.C11);

    // Pathological boundary-hitting chain (40-node strict chain with tiny priorWeight=1e-6):
    // When any theta hits THETA_SAFETY_BOUND (±50), hitBoundary=true MUST prevent falsely reporting converged=true!
    const hugeIds = Array.from({ length: 40 }, (_, i) => `H${String(i).padStart(2, '0')}`);
    const hugeComps = [];
    for (let i = 0; i < hugeIds.length; i += 1) {
        for (let j = i + 1; j < hugeIds.length; j += 1) {
            hugeComps.push({ paperA: hugeIds[i], paperB: hugeIds[j], winner: 'A' });
        }
    }
    const boundaryFit = bt.fitBradleyTerryRatings(hugeIds, hugeComps, { priorWeight: 1e-6, maxIterations: 300 });
    assert.equal(boundaryFit.hitBoundary, true);
    assert.equal(boundaryFit.converged, false, 'Clamping at ±50 must never falsely claim converged=true');
    for (const id of hugeIds) {
        assert.ok(Number.isFinite(boundaryFit.logStrengths[id]));
        assert.ok(Number.isFinite(boundaryFit.ratings[id]));
    }
});

test('Wave 14.4 Regression [P1-5]: resolveInputPath enforces strict --date matching and throws instead of falling back to wrong date', () => {
    const tmpDir = makeTempDir('wave14-4-p15-');
    try {
        const currentPath = path.join(tmpDir, 'current', 'deep-analysis-result.json');
        const archiveDir = path.join(tmpDir, 'archive');
        fs.mkdirSync(path.dirname(currentPath), { recursive: true });
        fs.writeFileSync(currentPath, JSON.stringify({ batchDate: '2026-11-24', papers: [] }), 'utf8');

        const arch23 = path.join(archiveDir, '2026-11-23', 'deep-analysis-result.json');
        fs.mkdirSync(path.dirname(arch23), { recursive: true });
        fs.writeFileSync(arch23, JSON.stringify({ batchDate: '2026-11-23', papers: [] }), 'utf8');

        // Exact current match
        assert.equal(
            cli.resolveInputPath({ date: '2026-11-24', input: null }, { currentPath, archiveDir }),
            path.resolve(currentPath)
        );
        // Exact archive match
        assert.equal(
            cli.resolveInputPath({ date: '2026-11-23', input: null }, { currentPath, archiveDir }),
            path.resolve(arch23)
        );
        // Mismatched date MUST throw instead of silently reading 2026-11-24 current!
        assert.throws(
            () => cli.resolveInputPath({ date: '2026-11-20', input: null }, { currentPath, archiveDir }),
            /No deep-analysis-result\.json found matching --date 2026-11-20/
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('Wave 14.4 Regression [P1-6]: sanitizeBlindEvidenceText skips scoring blocks/dimensions/inline leaks while preserving metrics', () => {
    const leakyText = [
        '## 评分',
        '8.5/10',
        '### 明细',
        '这一整段在评分节下都必须跳过',
        '## 评分理由',
        '- **创新性**: 1.4/1.5 — 提出新架构',
        '- **技术严谨性** (1.5分): 1.3/1.5',
        '- **工程/实践价值**: 1.0/1.0',
        '## 机器摘要',
        'document_type: 模型报告',
        'rank_bucket: 前10%',
        'innovation: 1.4',
        '## 论文评价',
        '毒舌评价正文不应进入盲审',
        '## 核心创新点',
        '- **创新性**：1.4/1.5',
        '- **评分理由**：该文表现突出',
        '- technical_rigor: 1.3',
        '- 核心贡献与创新 1.4/2.0',
        '模型在音频降噪上实现 **评分**：8.5/10（前10%），最终得分 8.5，综合评分为 8.5 分，Score: 8.5/10，Overall score: 8.5（8.5/10）。',
        '在 LibriSpeech 上 WER 2.1%，PESQ 3.85，信噪比提升 8.5 dB（4/5 基准领先），支持 16 kHz 实时流式推理。'
    ].join('\n');

    const cleaned = bt.sanitizeBlindEvidenceText(leakyText, 4000);

    // Every single score/rubric/section leak must be gone!
    assert.ok(!cleaned.includes('这一整段在评分节下都必须跳过'));
    assert.ok(!cleaned.includes('毒舌评价正文不应进入盲审'));
    assert.ok(!cleaned.includes('8.5/10'));
    assert.ok(!cleaned.includes('1.4/1.5'));
    assert.ok(!cleaned.includes('1.3/1.5'));
    assert.ok(!cleaned.includes('1.0/1.0'));
    assert.ok(!cleaned.includes('1.4/2.0'));
    assert.ok(!cleaned.includes('technical_rigor'));
    assert.ok(!cleaned.includes('评分理由'));
    assert.ok(!cleaned.includes('前10%'));
    assert.ok(!cleaned.includes('最终得分 8.5'));
    assert.ok(!cleaned.includes('综合评分为 8.5'));
    assert.ok(!cleaned.includes('Score: 8.5'));
    assert.ok(!cleaned.includes('Overall score: 8.5'));

    // Legitimate scientific audio metrics MUST remain intact!
    assert.ok(cleaned.includes('WER 2.1%'));
    assert.ok(cleaned.includes('PESQ 3.85'));
    assert.ok(cleaned.includes('8.5 dB'));
    assert.ok(cleaned.includes('16 kHz'));
    assert.ok(cleaned.includes('4/5 基准领先'));
});

test('Wave 14.4 Regression [P1-7]: isolated (games === 0) papers keep delta === 0 and do not skew compared papers', () => {
    const papers = [
        makeRealisticPaper('C1', 8.0),
        makeRealisticPaper('C2', 7.6),
        makeRealisticPaper('C3', 7.4),
        makeRealisticPaper('ISO_LOW', 4.0),
        makeRealisticPaper('ISO_HIGH', 9.9)
    ];
    const comparisons = [
        { paperA: 'C1', paperB: 'C2', winner: 'A' },
        { paperA: 'C2', paperB: 'C3', winner: 'A' },
        { paperA: 'C1', paperB: 'C3', winner: 'A' }
    ];

    for (const mappingMethod of ['moment_anchored', 'quantile_anchored']) {
        const res = bt.calibrateBatchScores(papers, comparisons, { mappingMethod, maxDelta: 0.6 });
        const byId = new Map(res.papers.map(p => [p.paperId, p]));

        // Isolated papers MUST have zero drift!
        assert.equal(byId.get('ISO_LOW').games, 0);
        assert.equal(byId.get('ISO_LOW').calibratedScore, 4.0);
        assert.equal(byId.get('ISO_LOW').delta, 0);
        assert.equal(byId.get('ISO_LOW').capped, false);

        assert.equal(byId.get('ISO_HIGH').games, 0);
        assert.equal(byId.get('ISO_HIGH').calibratedScore, 9.9);
        assert.equal(byId.get('ISO_HIGH').delta, 0);
        assert.equal(byId.get('ISO_HIGH').capped, false);

        // Compared papers MUST calibrate identically with or without isolated papers present!
        const comparedOnly = bt.calibrateBatchScores(papers.slice(0, 3), comparisons, { mappingMethod, maxDelta: 0.6 });
        for (const cp of comparedOnly.papers) {
            assert.equal(
                byId.get(cp.paperId).calibratedScore,
                cp.calibratedScore,
                `Isolated papers skewed ${cp.paperId} under ${mappingMethod}`
            );
        }
    }
});

test('Wave 14.4 Regression [P1-8]: strict numeric and CLI flag validation rejects booleans, null, empty strings, and flag-like values', () => {
    for (const bad of [true, false, null, '', '   ']) {
        assert.throws(() => bt.validateSwissRounds(bad), RangeError);
        assert.throws(() => bt.validateMaxDelta(bad), RangeError);
        assert.throws(() => bt.validatePriorWeight(bad), RangeError);
    }

    assert.throws(() => cli.parseCliArgs(['--replay=']), /Empty value/);
    assert.throws(() => cli.parseCliArgs(['--dry-run', '--rounds=']), /Empty value/);
    assert.throws(() => cli.parseCliArgs(['--dry-run', '--max-delta=']), /Empty value/);
    assert.throws(() => cli.parseCliArgs(['--dry-run', '--rounds', '--json']), /Missing value/);
    assert.throws(() => cli.parseCliArgs(['--replay', '--json']), /Missing value/);
    assert.throws(() => cli.parseCliArgs(['--dry-run', '--output', '   ']), /Empty value/);
    assert.throws(() => cli.parseCliArgs(['--dry-run', '--concurrency', '0']), RangeError);
    assert.throws(() => cli.parseCliArgs(['--dry-run', '--max-tokens', 'abc']), RangeError);
});

test('Wave 14.4 Regression [P2-9, P2-10, P2-11]: scoreDecimals tie stats, unidirectional slot randomization, provenance & finite Kendall guard', async () => {
    // [P2-9] scoreDecimals=3 distinguishes closely spaced calibrated scores in tieClusterStats
    const closePapers = [
        makeRealisticPaper('D1', 7.4),
        makeRealisticPaper('D2', 7.4),
        makeRealisticPaper('D3', 7.4),
        makeRealisticPaper('D4', 7.4)
    ];
    const tinyComps = [
        { paperA: 'D1', paperB: 'D2', winner: 'A' },
        { paperA: 'D2', paperB: 'D3', winner: 'A' },
        { paperA: 'D3', paperB: 'D4', winner: 'A' },
        { paperA: 'D1', paperB: 'D4', winner: 'A' }
    ];
    const dec3 = bt.calibrateBatchScores(closePapers, tinyComps, { maxDelta: 0.01, scoreDecimals: 3 });
    assert.equal(dec3.diagnostics.tieClusterStats.clusters[0].uniqueCalibratedScores, 4);
    assert.equal(dec3.diagnostics.tieClusterStats.calibratedTieClusterCount, 0);

    // [P2-10] Unidirectional Swiss pairing randomizes slot A/B order deterministically across pairs
    const items40 = Array.from({ length: 40 }, (_, i) => ({ id: `U${String(i).padStart(2, '0')}`, rating: 9.5 - i * 0.1 }));
    const uniRound = bt.planSwissRoundPairs(items40, { round: 1, seed: 'uni-slot-test', bidirectional: false });
    const higherInSlotA = uniRound.pairs.filter(p => p.ratingA > p.ratingB).length;
    const lowerInSlotA = uniRound.pairs.filter(p => p.ratingA < p.ratingB).length;
    assert.ok(higherInSlotA > 0 && lowerInSlotA > 0, 'Unidirectional mode should mix higher/lower rated papers across slots');
    for (const pair of uniRound.pairs) {
        assert.equal(pair.paperA, pair.evaluations[0].presentedA);
        assert.equal(pair.paperB, pair.evaluations[0].presentedB);
    }
    // Re-running with same seed produces exact same slot assignment
    assert.deepEqual(
        bt.planSwissRoundPairs(items40, { round: 1, seed: 'uni-slot-test', bidirectional: false }),
        uniRound
    );

    // [P2-10 + P2-11] Unidirectional --live execution aligns randomized slots accurately,
    // preserves promptSha256, records llmRequestsSent, and preserves config.bidirectional on replay!
    const tmpDir = makeTempDir('wave14-4-p2-');
    try {
        const inputPath = path.join(tmpDir, 'deep-analysis-result.json');
        const liveOut = path.join(tmpDir, 'live-uni-sidecar.json');
        const replayOut = path.join(tmpDir, 'replay-uni-sidecar.json');
        fs.writeFileSync(inputPath, JSON.stringify({
            batchDate: '2026-11-24',
            papers: [
                makeRealisticPaper('2611.30001v1', 7.4, { title: 'Paper One' }),
                makeRealisticPaper('2611.30002v1', 7.4, { title: 'Paper Two' }),
                makeRealisticPaper('2611.30003v1', 7.4, { title: 'Paper Three' }),
                makeRealisticPaper('2611.30004v1', 7.4, { title: 'Paper Four' })
            ]
        }), 'utf8');

        const rankVal = { 'Paper One': 4, 'Paper Two': 3, 'Paper Three': 2, 'Paper Four': 1 };
        const liveUni = await cli.runCalibrationCli([
            '--input', inputPath,
            '--output', liveOut,
            '--rounds', '3',
            '--unidirectional',
            '--live'
        ], {
            skipEnvLoad: true,
            llmConfig: {
                endpoint: 'https://api.example.com/v1',
                apiKey: 'k',
                apiKeys: ['k'],
                model: 'mimo-v2.6-flash'
            },
            requestFn: async (_url, _ep, _m, body) => {
                const userMsg = body.messages[1].content;
                const titles = Array.from(userMsg.matchAll(/- Title: (.+)/g)).map(m => m[1].trim());
                const winner = rankVal[titles[0]] > rankVal[titles[1]] ? 'A' : 'B';
                return {
                    statusCode: 200,
                    body: {
                        choices: [{
                            message: { content: JSON.stringify({ winner, confidence: 'high', reason: 'blind merit' }) },
                            finish_reason: 'stop'
                        }]
                    }
                };
            }
        });

        assert.equal(liveUni.sidecar.readOnlyInvariant.llmRequestsSent, 6);
        assert.equal(liveUni.sidecar.config.bidirectional, false);
        assert.deepEqual(
            liveUni.sidecar.papers.map(p => p.paperId),
            ['2611.30001v1', '2611.30002v1', '2611.30003v1', '2611.30004v1']
        );
        // promptSha256 preserved on every comparison
        for (const comp of liveUni.sidecar.comparisons) {
            assert.match(comp.forward.promptSha256, /^[a-f0-9]{64}$/);
        }

        // Replay saved unidirectional sidecar without passing --unidirectional -> preserves bidirectional: false & identical calibrationSha256!
        const replayed = await cli.runCalibrationCli([
            '--input', inputPath,
            '--replay', liveOut,
            '--output', replayOut
        ]);
        assert.equal(replayed.sidecar.config.bidirectional, false);
        assert.equal(replayed.sidecar.calibrationSha256, liveUni.sidecar.calibrationSha256);

        // loadReplayComparisons rejects symlink and directory
        const replayLink = path.join(tmpDir, 'replay-symlink.json');
        fs.symlinkSync(liveOut, replayLink);
        assert.throws(() => cli.loadReplayComparisons(replayLink), /regular file/);
        assert.throws(() => cli.loadReplayComparisons(tmpDir), /regular file/);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // [P2-11] Canonical sort tie-breaker yields identical order regardless of input comparison permutation
    const dupA = { round: 1, paperA: 'P1', paperB: 'P2', winner: 'A', confidence: 'high', reason: 'reason alpha' };
    const dupB = { round: 1, paperA: 'P1', paperB: 'P2', winner: 'A', confidence: 'low', reason: 'reason beta' };
    const norm1 = bt.normalizeAndResolveComparisons([dupA, dupB]);
    const norm2 = bt.normalizeAndResolveComparisons([dupB, dupA]);
    assert.deepEqual(norm1.resolvedComparisons, norm2.resolvedComparisons);

    // [P2-11] computeKendallTauB rejects NaN / Infinity
    assert.throws(() => bt.computeKendallTauB([1, NaN], [1, 2]), RangeError);
    assert.throws(() => bt.computeKendallTauB([1, 2], [1, Infinity]), RangeError);
});
