'use strict';

/**
 * Post-Batch Swiss-Tournament Bradley-Terry Relative Score Calibration.
 *
 * Cold-replay & sealed-data invariant:
 * - Read-only over sealed `deep-analysis-result.json` papers; NEVER mutates input papers
 *   or overwrites original `scoringAudit` scores.
 * - Produces a deterministic, replayable `batch-score-calibration` sidecar payload.
 */

const crypto = require('node:crypto');
const { strictJson } = require('./strict-json.js');
const { extractAnalysisSection } = require('./analysis-section-titles.js');

const SCORE_CALIBRATION_CONTRACT = 'batch-score-calibration';

const DEFAULT_SWISS_ROUNDS = 3;
const MIN_SWISS_ROUNDS = 1;
const MAX_SWISS_ROUNDS = 6;

const DEFAULT_PRIOR_WEIGHT = 0.25;
const MIN_PRIOR_WEIGHT = 1e-6;
const MAX_PRIOR_WEIGHT = 1e6;
const THETA_SAFETY_BOUND = 50;
const DEFAULT_CONVERGENCE_TOLERANCE = 1e-9;
const DEFAULT_MAX_ITERATIONS = 500;
const DEFAULT_MAX_DELTA = 0.6;
const DEFAULT_SCORE_DECIMALS = 2;
const DEFAULT_SEED = 'swiss-bt';

const SCORE_MIN = 0;
const SCORE_MAX = 10;

const PAIRWISE_WINNERS = Object.freeze(['A', 'B', 'tie']);
const PAIRWISE_CONFIDENCES = Object.freeze(['high', 'medium', 'low']);
const MAPPING_METHODS = Object.freeze(['moment_anchored', 'quantile_anchored']);

const OMITTED_BLIND_SCORE_FIELDS = Object.freeze([
    'score',
    'rawScore',
    'finalScore',
    'scoringAudit',
    'scoringDimensions',
    'rankBucket',
    'calibratedScore',
    'btRating',
    'btLogStrength'
]);

// ═══════════════════════════════════════════════════════
// Deterministic Canonical Hashing & Numeric Utilities
// ═══════════════════════════════════════════════════════

function normalizeZero(value) {
    return Object.is(value, -0) ? 0 : value;
}

function canonicalizeForHash(value) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'number') {
        return Number.isFinite(value) ? normalizeZero(value) : String(value);
    }
    if (Array.isArray(value)) {
        return value.map(canonicalizeForHash);
    }
    if (typeof value === 'object') {
        const sorted = {};
        for (const key of Object.keys(value).sort()) {
            if (value[key] === undefined) continue;
            sorted[key] = canonicalizeForHash(value[key]);
        }
        return sorted;
    }
    return value;
}

function sha256Hex(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJsonSha256(value) {
    return sha256Hex(JSON.stringify(canonicalizeForHash(value)));
}

function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
}

function roundTo(value, decimals = 6) {
    if (!Number.isFinite(value)) return value;
    return normalizeZero(Number(value.toFixed(decimals)));
}

function logSigmoid(x) {
    if (x >= 0) {
        return -Math.log1p(Math.exp(-x));
    }
    return x - Math.log1p(Math.exp(x));
}

function logSumExp(logValues) {
    let maxVal = -Infinity;
    for (let i = 0; i < logValues.length; i += 1) {
        if (logValues[i] > maxVal) maxVal = logValues[i];
    }
    if (!Number.isFinite(maxVal)) return maxVal;
    let sumExp = 0;
    for (let i = 0; i < logValues.length; i += 1) {
        sumExp += Math.exp(logValues[i] - maxVal);
    }
    return maxVal + Math.log(sumExp);
}

function parseStrictNumber(value, name) {
    if (typeof value === 'boolean' || value === null || value === undefined) {
        throw new RangeError(`${name} must be a finite number, received: ${JSON.stringify(value)}`);
    }
    if (typeof value === 'string' && !value.trim()) {
        throw new RangeError(`${name} must not be empty or whitespace.`);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new RangeError(`${name} must be a finite number, received: ${JSON.stringify(value)}`);
    }
    return parsed;
}

function canonicalPairKey(idA, idB) {
    const a = String(idA || '').trim();
    const b = String(idB || '').trim();
    if (!a || !b) {
        throw new Error('Pairwise comparison requires two non-empty paper IDs.');
    }
    if (a === b) {
        throw new Error(`Self-comparison is not allowed: ${a}`);
    }
    return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function splitPairKey(pairKey) {
    const idx = String(pairKey || '').indexOf('::');
    if (idx <= 0) return null;
    const a = pairKey.slice(0, idx).trim();
    const b = pairKey.slice(idx + 2).trim();
    if (!a || !b || a === b) return null;
    return [a, b];
}

function validateSwissRounds(rounds = DEFAULT_SWISS_ROUNDS) {
    const parsed = parseStrictNumber(rounds, 'rounds');
    if (!Number.isInteger(parsed) || parsed < MIN_SWISS_ROUNDS || parsed > MAX_SWISS_ROUNDS) {
        throw new RangeError(
            `Swiss rounds must be an integer between ${MIN_SWISS_ROUNDS} and ${MAX_SWISS_ROUNDS}, received: ${rounds}`
        );
    }
    return parsed;
}

function validateMaxDelta(maxDelta = DEFAULT_MAX_DELTA) {
    const parsed = parseStrictNumber(maxDelta, 'maxDelta');
    if (parsed < 0 || parsed > 5) {
        throw new RangeError(`maxDelta must be a finite number in [0, 5], received: ${maxDelta}`);
    }
    return parsed;
}

function validatePriorWeight(priorWeight = DEFAULT_PRIOR_WEIGHT) {
    const parsed = parseStrictNumber(priorWeight, 'priorWeight');
    if (parsed < MIN_PRIOR_WEIGHT || parsed > MAX_PRIOR_WEIGHT) {
        throw new RangeError(
            `priorWeight must be a finite number in [${MIN_PRIOR_WEIGHT}, ${MAX_PRIOR_WEIGHT}], received: ${priorWeight}`
        );
    }
    return parsed;
}

// ═══════════════════════════════════════════════════════
// Read-Only Paper Normalization & Evidence Extraction
// ═══════════════════════════════════════════════════════

function extractPaperId(paper) {
    if (typeof paper === 'string') return paper.trim();
    if (!paper || typeof paper !== 'object') return '';
    const candidates = [
        paper.paperId,
        paper.arxivId,
        paper.conferencePaperId,
        paper.id,
        paper.sourceId
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
    }
    return '';
}

function parseFiniteScore(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value >= SCORE_MIN && value <= SCORE_MAX ? value : null;
    }
    if (typeof value === 'string' && value.trim()) {
        const cleaned = value.trim().replace(/\/10\s*$/, '').trim();
        if (/^-?\d+(?:\.\d+)?$/.test(cleaned)) {
            const num = Number(cleaned);
            if (Number.isFinite(num) && num >= SCORE_MIN && num <= SCORE_MAX) {
                return num;
            }
        }
    }
    return null;
}

function extractRawScore(paper) {
    if (!paper || typeof paper !== 'object') return null;
    const candidates = [
        paper.rawScore,
        paper.analysisManifest?.stages?.scoringAudit?.finalScore,
        paper.scoringAudit?.finalScore,
        paper.finalScore,
        paper.score,
        paper.parsed?.score,
        paper.analysisManifest?.stages?.scoringAudit?.audit?.total
    ];
    for (const candidate of candidates) {
        const parsed = parseFiniteScore(candidate);
        if (parsed !== null) return parsed;
    }
    return null;
}

function extractCalibratablePapers(inputData) {
    const rawList = Array.isArray(inputData)
        ? inputData
        : (Array.isArray(inputData?.papers)
            ? inputData.papers
            : (Array.isArray(inputData?.results) ? inputData.results : null));
    if (!rawList) {
        throw new Error('Input batch must be an array of papers or an object containing a papers array.');
    }

    const papers = [];
    const excludedPapers = [];
    const seenIds = new Set();

    for (let idx = 0; idx < rawList.length; idx += 1) {
        const raw = rawList[idx];
        const paperId = extractPaperId(raw);
        if (!paperId) {
            excludedPapers.push({ index: idx, paperId: null, reason: 'missing_paper_id' });
            continue;
        }
        if (seenIds.has(paperId)) {
            throw new Error(`Duplicate paperId in calibration batch: ${paperId}`);
        }
        seenIds.add(paperId);

        if (raw && typeof raw === 'object' && raw.error) {
            excludedPapers.push({ index: idx, paperId, reason: 'paper_has_analysis_error' });
            continue;
        }
        const rawScore = extractRawScore(raw);
        if (rawScore === null) {
            excludedPapers.push({ index: idx, paperId, reason: 'missing_valid_raw_score' });
            continue;
        }

        // Shallow read-only snapshot; never mutates original sealed paper objects.
        papers.push({
            paperId,
            title: typeof raw.title === 'string' ? raw.title.trim() : '',
            rawScore,
            sourceSha256: typeof raw.sourceSha256 === 'string' ? raw.sourceSha256 : null,
            sourceRecord: raw
        });
    }

    return { papers, excludedPapers };
}

// ═══════════════════════════════════════════════════════
// Swiss-Tournament Pairing Engine
// ═══════════════════════════════════════════════════════

function normalizePreviousPairCounts(previousPairs) {
    const counts = new Map();
    if (!previousPairs) return counts;

    const addPair = (a, b) => {
        const key = canonicalPairKey(a, b);
        counts.set(key, (counts.get(key) || 0) + 1);
    };

    const entries = previousPairs instanceof Map
        ? Array.from(previousPairs.entries())
        : Array.from(previousPairs);

    for (const entry of entries) {
        if (typeof entry === 'string') {
            const parts = splitPairKey(entry) || (entry.includes('||') ? entry.split('||').map(s => s.trim()) : null);
            if (parts && parts.length === 2 && parts[0] && parts[1] && parts[0] !== parts[1]) {
                addPair(parts[0], parts[1]);
            }
        } else if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'number') {
            const parts = splitPairKey(entry[0]);
            if (parts) {
                counts.set(canonicalPairKey(parts[0], parts[1]), Math.max(0, entry[1]));
            }
        } else if (Array.isArray(entry) && entry.length >= 2) {
            addPair(entry[0], entry[1]);
        } else if (entry && typeof entry === 'object') {
            const a = entry.paperA ?? entry.a ?? entry.presentedA;
            const b = entry.paperB ?? entry.b ?? entry.presentedB;
            if (a && b) addPair(a, b);
        }
    }
    return counts;
}

function normalizePreviousByeCounts(previousByes) {
    const counts = new Map();
    if (!previousByes) return counts;
    if (previousByes instanceof Map) {
        for (const [id, c] of previousByes.entries()) {
            const key = String(id || '').trim();
            if (key) counts.set(key, Math.max(0, Number(c) || 0));
        }
        return counts;
    }
    for (const entry of previousByes) {
        const key = String(entry || '').trim();
        if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
}

function findZeroRepeatMatching(pool, pairCounts, maxNodes = 25000) {
    const m = pool.length;
    if (m === 0) return [];
    const played = (i, j) => (pairCounts.get(canonicalPairKey(pool[i].id, pool[j].id)) || 0) > 0;

    // Fast path: greedy Swiss with 2-opt swap repair.
    const unmatched = Array.from({ length: m }, (_, i) => i);
    const greedyPairs = [];
    let greedyFailed = false;

    while (unmatched.length > 0) {
        const u = unmatched.shift();
        let matchPos = -1;
        for (let k = 0; k < unmatched.length; k += 1) {
            if (!played(u, unmatched[k])) {
                matchPos = k;
                break;
            }
        }
        if (matchPos >= 0) {
            const v = unmatched.splice(matchPos, 1)[0];
            greedyPairs.push([u, v]);
            continue;
        }

        // Try 2-opt swap with an existing pair (prefer most recent pairs for rating proximity).
        let repaired = false;
        for (let k = 0; k < unmatched.length && !repaired; k += 1) {
            const v = unmatched[k];
            for (let pIdx = greedyPairs.length - 1; pIdx >= 0; pIdx -= 1) {
                const [a, b] = greedyPairs[pIdx];
                if (!played(a, u) && !played(b, v)) {
                    greedyPairs[pIdx] = [a, u];
                    greedyPairs.push([b, v]);
                    unmatched.splice(k, 1);
                    repaired = true;
                    break;
                }
                if (!played(a, v) && !played(b, u)) {
                    greedyPairs[pIdx] = [a, v];
                    greedyPairs.push([b, u]);
                    unmatched.splice(k, 1);
                    repaired = true;
                    break;
                }
            }
        }

        if (!repaired) {
            greedyFailed = true;
            break;
        }
    }

    if (!greedyFailed) {
        return greedyPairs;
    }

    // Exact bounded backtracking for moderate batch sizes guarantees finding
    // a 0-repeat matching whenever one exists (preferring closest rank first).
    if (m <= 64) {
        const used = new Uint8Array(m);
        const result = [];
        let nodes = 0;

        const dfs = (pairedCount) => {
            if (pairedCount === m) return true;
            if (nodes >= maxNodes) return false;
            nodes += 1;

            let u = -1;
            for (let i = 0; i < m; i += 1) {
                if (!used[i]) {
                    u = i;
                    break;
                }
            }
            if (u < 0) return true;
            used[u] = 1;
            for (let v = u + 1; v < m; v += 1) {
                if (used[v] || played(u, v)) continue;
                used[v] = 1;
                result.push([u, v]);
                if (dfs(pairedCount + 2)) return true;
                result.pop();
                used[v] = 0;
            }
            used[u] = 0;
            return false;
        };

        if (dfs(0)) {
            return result;
        }
    }

    return null;
}

function buildMinimumRepeatFallbackMatching(pool, pairCounts) {
    const m = pool.length;
    const remaining = Array.from({ length: m }, (_, i) => i);
    const pairs = [];

    while (remaining.length >= 2) {
        const u = remaining.shift();
        let bestPos = 0;
        let bestRepeatCount = Infinity;
        for (let k = 0; k < remaining.length; k += 1) {
            const v = remaining[k];
            const repeats = pairCounts.get(canonicalPairKey(pool[u].id, pool[v].id)) || 0;
            if (repeats < bestRepeatCount) {
                bestRepeatCount = repeats;
                bestPos = k;
                if (repeats === 0) break;
            }
        }
        const v = remaining.splice(bestPos, 1)[0];
        pairs.push([u, v]);
    }
    return pairs;
}

/**
 * Deterministic Swiss-tournament single-round pairing engine.
 *
 * @param {Array<string|object>} items - Paper IDs or objects `{ id|paperId, rating|btLogStrength|score|rawScore }`
 * @param {object} [options]
 * @param {number} [options.round=1] - 1-based round number
 * @param {string|number} [options.seed='swiss-bt'] - Deterministic tie-breaking seed
 * @param {Iterable|Map} [options.previousPairs] - Prior matchups to avoid repeating
 * @param {Iterable|Map} [options.previousByes] - Prior bye recipients to rotate fairly
 * @param {boolean} [options.bidirectional=true] - Include both forward (A vs B) and reverse (B vs A) evaluations
 */
function planSwissRoundPairs(items, options = {}) {
    if (!Array.isArray(items)) {
        throw new TypeError('planSwissRoundPairs expects an array of items.');
    }
    const round = options.round === undefined ? 1 : parseStrictNumber(options.round, 'round');
    if (!Number.isInteger(round) || round < 1) {
        throw new RangeError(`round must be a positive integer, received: ${options.round}`);
    }
    const seed = options.seed === undefined ? DEFAULT_SEED : String(options.seed);
    const bidirectional = options.bidirectional !== false;

    const seen = new Set();
    const normalized = items.map((item, idx) => {
        const id = extractPaperId(item);
        if (!id) {
            throw new Error(`Item at index ${idx} is missing a valid paper ID.`);
        }
        if (seen.has(id)) {
            throw new Error(`Duplicate paper ID in planSwissRoundPairs: ${id}`);
        }
        seen.add(id);

        let rating = 0;
        if (item && typeof item === 'object') {
            const rawRating = item.rating ?? item.btLogStrength ?? item.btRating ?? item.score ?? item.rawScore ?? 0;
            rating = Number.isFinite(Number(rawRating)) ? Number(rawRating) : 0;
        }
        return {
            id,
            rating,
            tieHash: sha256Hex(`${seed}:round-${round}:${id}`)
        };
    });

    if (normalized.length < 2) {
        return {
            round,
            seed,
            bidirectional,
            participantCount: normalized.length,
            pairs: [],
            bye: normalized.length === 1 ? normalized[0].id : null,
            repeatedPairsCount: 0,
            estimatedEvaluations: 0
        };
    }

    // Sort strictly by current rating descending, breaking ties deterministically by seeded hash.
    normalized.sort((a, b) => {
        if (Math.abs(b.rating - a.rating) > 1e-12) {
            return b.rating - a.rating;
        }
        if (a.tieHash !== b.tieHash) {
            return a.tieHash < b.tieHash ? -1 : 1;
        }
        return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });

    const pairCounts = normalizePreviousPairCounts(options.previousPairs);
    const byeCounts = normalizePreviousByeCounts(options.previousByes);

    let bye = null;
    const pool = normalized.slice();
    if (pool.length % 2 === 1) {
        // Standard Swiss bye selection: pick the lowest-rated player with the fewest prior byes.
        let minByeCount = Infinity;
        for (const player of pool) {
            const c = byeCounts.get(player.id) || 0;
            if (c < minByeCount) minByeCount = c;
        }
        let byeIndex = pool.length - 1;
        for (let i = pool.length - 1; i >= 0; i -= 1) {
            if ((byeCounts.get(pool[i].id) || 0) === minByeCount) {
                byeIndex = i;
                break;
            }
        }
        bye = pool.splice(byeIndex, 1)[0].id;
    }

    const indexPairs = findZeroRepeatMatching(pool, pairCounts)
        || buildMinimumRepeatFallbackMatching(pool, pairCounts);

    // Order pairs deterministically by highest-ranked participant index.
    indexPairs.sort((p1, p2) => Math.min(p1[0], p1[1]) - Math.min(p2[0], p2[1]));

    let repeatedPairsCount = 0;
    const pairs = indexPairs.map(([idxA, idxB], pairIndex) => {
        const firstIdx = Math.min(idxA, idxB);
        const secondIdx = Math.max(idxA, idxB);
        const playerA = pool[firstIdx];
        const playerB = pool[secondIdx];
        const pairKey = canonicalPairKey(playerA.id, playerB.id);
        const priorCount = pairCounts.get(pairKey) || 0;
        const isRepeat = priorCount > 0;
        if (isRepeat) repeatedPairsCount += 1;

        let slotA = playerA;
        let slotB = playerB;
        let evaluations;
        if (bidirectional) {
            evaluations = [
                { direction: 'forward', presentedA: slotA.id, presentedB: slotB.id },
                { direction: 'reverse', presentedA: slotB.id, presentedB: slotA.id }
            ];
        } else {
            // Deterministically choose [playerA, playerB] vs [playerB, playerA] via seeded hash bit
            // to eliminate primacy bias toward higher-rated papers in unidirectional mode.
            const slotHash = sha256Hex(`${seed}:slot:${round}:${pairKey}`);
            const swapSlots = (parseInt(slotHash.slice(0, 2), 16) & 1) === 1;
            if (swapSlots) {
                slotA = playerB;
                slotB = playerA;
            }
            evaluations = [
                {
                    direction: 'forward',
                    presentedA: slotA.id,
                    presentedB: slotB.id
                }
            ];
        }

        return {
            pairIndex,
            round,
            pairKey,
            paperA: slotA.id,
            paperB: slotB.id,
            ratingA: slotA.rating,
            ratingB: slotB.rating,
            ratingGap: roundTo(Math.abs(slotA.rating - slotB.rating), 6),
            isRepeat,
            priorEncounterCount: priorCount,
            evaluations
        };
    });

    const estimatedEvaluations = pairs.reduce((sum, p) => sum + p.evaluations.length, 0);

    return {
        round,
        seed,
        bidirectional,
        participantCount: normalized.length,
        pairs,
        bye,
        repeatedPairsCount,
        estimatedEvaluations
    };
}

/**
 * Computes a complete deterministic multi-round Swiss pairing plan (used for --dry-run estimation).
 */
function planSwissTournamentSchedule(items, options = {}) {
    const rounds = validateSwissRounds(options.rounds ?? DEFAULT_SWISS_ROUNDS);
    const seed = options.seed === undefined ? DEFAULT_SEED : String(options.seed);
    const bidirectional = options.bidirectional !== false;

    const pairCounts = new Map();
    const byeCounts = new Map();
    const scheduleRounds = [];
    let totalPairs = 0;
    let totalRepeatedPairs = 0;
    let estimatedApiCalls = 0;

    for (let round = 1; round <= rounds; round += 1) {
        const roundPlan = planSwissRoundPairs(items, {
            round,
            seed,
            bidirectional,
            previousPairs: pairCounts,
            previousByes: byeCounts
        });
        scheduleRounds.push(roundPlan);
        totalPairs += roundPlan.pairs.length;
        totalRepeatedPairs += roundPlan.repeatedPairsCount;
        estimatedApiCalls += roundPlan.estimatedEvaluations;
        for (const pair of roundPlan.pairs) {
            pairCounts.set(pair.pairKey, (pairCounts.get(pair.pairKey) || 0) + 1);
        }
        if (roundPlan.bye) {
            byeCounts.set(roundPlan.bye, (byeCounts.get(roundPlan.bye) || 0) + 1);
        }
    }

    const n = items.length;
    const fullRoundRobinCalls = n >= 2 ? n * (n - 1) : 0;

    return {
        rounds,
        seed,
        bidirectional,
        participantCount: n,
        totalPairs,
        uniquePairsPlanned: pairCounts.size,
        totalRepeatedPairs,
        estimatedApiCalls,
        fullRoundRobinCalls,
        savingsPct: fullRoundRobinCalls > 0
            ? roundTo(((fullRoundRobinCalls - estimatedApiCalls) / fullRoundRobinCalls) * 100, 2)
            : 0,
        scheduleRounds
    };
}

// ═══════════════════════════════════════════════════════
// Blind Pairwise Prompt Builder & Strict Response Parser
// ═══════════════════════════════════════════════════════

const SKIPPED_SCORE_HEADING_RE = /^(?:评分理由|评分规则|评分|机器摘要|论文评价|毒舌点评|scoring(?:\s+audit|\s+rubric|\s+rationale)?)(?=$|[\s：:(\[（【-]|(?![A-Za-z0-9_]))/i;

const RUBRIC_DIMENSION_RE = new RegExp(
    '^(?:'
    + '创新性|技术严谨性|实验充分性|清晰度|影响力|开源|可复现性|工程(?:\\/|与)?实践价值|'
    + '核心贡献与创新|方法与分析严谨性|实验与证据充分性|音频领域相关性|开源与可复现|'
    + 'innovation|technical_?rigor|experimental_?sufficiency|clarity|impact|open_?source|'
    + 'reproducibility|engineering|scoring_?audit'
    + ')(?![A-Za-z0-9_])(?:\\s*(?:[（(][^）)]*[）)])?\\s*[：:=]\\s*\\d+(?:\\.\\d+)?(?:\\s*\\/\\s*\\d+(?:\\.\\d+)?)?|[^\\n]*\\b\\d+(?:\\.\\d+)?\\s*\\/\\s*(?:10|2(?:\\.0)?|1\\.5|1(?:\\.0)?|0\\.5)\\b)',
    'i'
);

function sanitizeBlindEvidenceText(text, maxChars = 1800) {
    if (typeof text !== 'string' || !text.trim()) return '';
    const cleanedLines = [];
    let skipHeadingLevel = null;

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;

        // Multi-line block-skipping state machine for scoring/evaluation sections.
        const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
        if (headingMatch) {
            const level = headingMatch[1].length;
            const headingTitle = headingMatch[2]
                .replace(/^[*_`~\s]+|[*_`~\s：:]+$/g, '')
                .trim();
            if (skipHeadingLevel !== null && level <= skipHeadingLevel) {
                skipHeadingLevel = null;
            }
            if (level >= 2 && level <= 4 && SKIPPED_SCORE_HEADING_RE.test(headingTitle)) {
                skipHeadingLevel = level;
                continue;
            }
        }
        if (skipHeadingLevel !== null) {
            continue;
        }

        // Normalize leading list bullets and emphasis wrappers before checking for score/rubric lines.
        const probe = line
            .replace(/^(?:[-*+•]\s+|\d+[.)]\s+)/, '')
            .replace(/\*\*|__|~~|`/g, '')
            .trim();

        if (/^(?:rank_bucket|rankBucket|finalScore|rawScore|scoringAudit|scoring_?audit|overall_?score|total_?score|calibrated_?score)\s*[：:=]/i.test(probe)) {
            continue;
        }
        if (/^(?:总分|综合评分|最终评分|最终得分|综合得分|评分|Score|Overall\s+score|Total\s+score|Final\s+score)\s*(?:为|是|[：:=])\s*\d+(?:\.\d+)?(?:\s*\/\s*10)?/i.test(probe)) {
            continue;
        }
        if (/^\d+(?:\.\d+)?\s*\/\s*10\s*$/.test(probe)) {
            continue;
        }
        if (/^评分理由\s*[：:]/.test(probe) || RUBRIC_DIMENSION_RE.test(probe)) {
            continue;
        }

        // Scrub inline score mentions & Chinese rank buckets without clobbering legitimate scientific metrics.
        const scrubbed = line
            .replace(
                /(?:\*{1,2})?(?:总分|综合评分|最终评分|最终得分|综合得分|评分)(?:\*{1,2})?\s*(?:为|是|[：:=])?\s*(?:\*{1,2})?\d+(?:\.\d+)?(?:\s*\/\s*10)?(?:\s*分)?(?:\*{1,2})?/g,
                '[score omitted]'
            )
            .replace(
                /(?:\*{1,2})?(?:Overall\s+score|Total\s+score|Final\s+score|Score)(?:\*{1,2})?\s*[：:=]\s*(?:\*{1,2})?\d+(?:\.\d+)?(?:\s*\/\s*10)?(?:\*{1,2})?/gi,
                '[score omitted]'
            )
            .replace(/[（(]\s*\d+(?:\.\d+)?\s*\/\s*10\s*[）)]/g, '')
            .replace(/\b(?:rank_bucket|rankBucket)\s*[：:=]\s*\S+/gi, '[rank omitted]')
            .replace(/[（(]?\s*(?:前10%|前25%|前50%|后50%)\s*[）)]?/g, '[rank omitted]')
            .trim();
        if (scrubbed) cleanedLines.push(scrubbed);
    }

    const joined = cleanedLines.join('\n').trim();
    if (joined.length <= maxChars) return joined;
    return `${joined.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function formatFieldList(value, maxChars = 600) {
    if (Array.isArray(value)) {
        const parts = value.map(item => String(item || '').trim()).filter(Boolean);
        return sanitizeBlindEvidenceText(parts.join('; '), maxChars);
    }
    if (typeof value === 'string') {
        return sanitizeBlindEvidenceText(value, maxChars);
    }
    return '';
}

function buildBlindPaperEvidenceBlock(paper, label, maxFieldChars = 1600) {
    const src = paper?.sourceRecord && typeof paper.sourceRecord === 'object' ? paper.sourceRecord : (paper || {});
    const analysis = typeof src.analysis === 'string' ? src.analysis : '';

    const title = sanitizeBlindEvidenceText(src.title || paper?.title || '(Untitled Paper)', 300);
    const abstractText = sanitizeBlindEvidenceText(
        src.abstract || src.summary || src.parsed?.summary || '',
        maxFieldChars
    );
    const innovationsText = sanitizeBlindEvidenceText(
        (Array.isArray(src.innovations) ? src.innovations.join('\n- ') : src.innovations)
        || extractAnalysisSection(analysis, '核心创新点')
        || src.methodOverview
        || extractAnalysisSection(analysis, '方法概述和架构')
        || extractAnalysisSection(analysis, '核心摘要')
        || '',
        maxFieldChars
    );
    const rigorText = sanitizeBlindEvidenceText(
        [
            src.experimentalRigor || src.experimentalResults || extractAnalysisSection(analysis, '实验结果'),
            src.limitations || extractAnalysisSection(analysis, '局限与问题')
        ].filter(Boolean).join('\n\n'),
        maxFieldChars
    );
    const audioEvidenceParts = [
        src.audioDomainEvidence ? sanitizeBlindEvidenceText(String(src.audioDomainEvidence), maxFieldChars) : '',
        formatFieldList(src.categories, 300) ? `Categories: ${formatFieldList(src.categories, 300)}` : '',
        formatFieldList(src.parsed?.tags || src.tags, 300) ? `Domain Tags: ${formatFieldList(src.parsed?.tags || src.tags, 300)}` : '',
        sanitizeBlindEvidenceText(src.openSourceDetails || extractAnalysisSection(analysis, '开源详情') || '', 600)
    ].filter(Boolean);

    return [
        `### ${label}`,
        `- Title: ${title || '(Unavailable)'}`,
        `- Verified Abstract: ${abstractText || '(Not provided)'}`,
        `- Key Innovations & Method: ${innovationsText || '(Not provided)'}`,
        `- Experimental Rigor & Limitations: ${rigorText || '(Not provided)'}`,
        `- Audio Domain Evidence & Reproducibility: ${audioEvidenceParts.join('\n  ') || '(Not provided)'}`
    ].join('\n');
}

/**
 * Builds a structured blind pairwise rubric prompt comparing Paper A vs Paper B.
 * Explicitly omits raw absolute scores, scoringAudit totals, and rank buckets to prevent anchoring.
 */
function buildPairwiseComparisonPrompt(paperA, paperB, options = {}) {
    if (!paperA || typeof paperA !== 'object' || !paperB || typeof paperB !== 'object') {
        throw new TypeError('buildPairwiseComparisonPrompt requires two paper objects.');
    }
    const maxFieldChars = Number.isInteger(options.maxFieldChars) && options.maxFieldChars >= 200
        ? options.maxFieldChars
        : 1600;

    const systemPrompt = [
        'You are a blind senior area chair evaluating pairs of audio, speech, music, and multimodal research papers.',
        'Compare Paper A and Paper B strictly on verifiable research merit across four dimensions:',
        '1. Key Technical Innovation: originality and depth of the core acoustic/audio/multimodal idea.',
        '2. Experimental Rigor: fair strong baselines, meaningful ablations, honest limitations, and sample/benchmark coverage.',
        '3. Audio Domain Evidence: concrete audio/speech/sound grounding (datasets, acoustic metrics, streaming/latency or perceptual evaluations).',
        '4. Reproducibility & Research Impact: clarity of method/config disclosure and verifiable open-source artifacts.',
        'Rules:',
        '- Slot order (Paper A vs Paper B) carries ZERO preference; guard strictly against position bias.',
        '- Do NOT assume or invent external scores, rankings, or unpublished metrics.',
        '- Use "tie" only when both papers are genuinely indistinguishable in overall merit.',
        '- Output STRICT JSON ONLY (no prose before or after) matching this exact schema:',
        '{"winner":"A"|"B"|"tie","confidence":"high"|"medium"|"low","reason":"<concise evidence-grounded comparison>"}'
    ].join('\n');

    const blockA = buildBlindPaperEvidenceBlock(paperA, 'Paper A', maxFieldChars);
    const blockB = buildBlindPaperEvidenceBlock(paperB, 'Paper B', maxFieldChars);

    const userPrompt = [
        'Perform a blind pairwise comparison between Paper A and Paper B based solely on the verified evidence below.',
        '',
        blockA,
        '',
        blockB,
        '',
        'Return strict JSON with keys "winner" ("A" | "B" | "tie"), "confidence" ("high" | "medium" | "low"), and "reason" (concise grounded explanation).'
    ].join('\n');

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ];

    return {
        systemPrompt,
        userPrompt,
        messages,
        promptSha256: stableJsonSha256(messages),
        omittedFields: OMITTED_BLIND_SCORE_FIELDS
    };
}

/**
 * Strictly parses a pairwise comparison LLM response into `{ winner, confidence, reason }`.
 */
function parsePairwiseComparisonResponse(rawResponse, options = {}) {
    const label = options.label || 'pairwise-comparison';
    let parsed;
    if (typeof rawResponse === 'string') {
        if (!rawResponse.trim()) {
            throw new Error(`${label} response is empty.`);
        }
        parsed = strictJson(Buffer.from(rawResponse, 'utf8'), label);
    } else if (Buffer.isBuffer(rawResponse)) {
        if (rawResponse.length === 0) {
            throw new Error(`${label} response buffer is empty.`);
        }
        parsed = strictJson(rawResponse, label);
    } else if (rawResponse && typeof rawResponse === 'object' && !Array.isArray(rawResponse)) {
        parsed = rawResponse;
    } else {
        throw new Error(`${label} response must be a JSON string, Buffer, or plain object.`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${label} JSON payload must be an object.`);
    }

    const allowedKeys = new Set(['winner', 'confidence', 'reason']);
    const unknownKeys = Object.keys(parsed).filter(k => !allowedKeys.has(k));
    if (options.rejectUnknownKeys !== false && unknownKeys.length > 0) {
        throw new Error(`${label} contains unexpected keys: ${unknownKeys.join(', ')}`);
    }

    if (typeof parsed.winner !== 'string') {
        throw new Error(`${label} "winner" must be a string ("A" | "B" | "tie").`);
    }
    const rawWinner = parsed.winner.trim();
    const winner = rawWinner === 'A' || rawWinner === 'B'
        ? rawWinner
        : (rawWinner.toLowerCase() === 'tie' ? 'tie' : null);
    if (!winner) {
        throw new Error(`${label} "winner" must be "A", "B", or "tie", received: ${JSON.stringify(parsed.winner)}`);
    }

    if (typeof parsed.confidence !== 'string') {
        throw new Error(`${label} "confidence" must be a string ("high" | "medium" | "low").`);
    }
    const confidence = parsed.confidence.trim().toLowerCase();
    if (!PAIRWISE_CONFIDENCES.includes(confidence)) {
        throw new Error(
            `${label} "confidence" must be "high", "medium", or "low", received: ${JSON.stringify(parsed.confidence)}`
        );
    }

    if (typeof parsed.reason !== 'string' || !parsed.reason.trim()) {
        throw new Error(`${label} "reason" must be a non-empty string.`);
    }
    const reason = parsed.reason.trim();
    if (reason.length > 4000) {
        throw new Error(`${label} "reason" exceeds maximum length of 4000 characters.`);
    }

    return { winner, confidence, reason };
}

// ═══════════════════════════════════════════════════════
// Position-Swap Bias Mitigation & Comparison Aggregation
// ═══════════════════════════════════════════════════════

function normalizeDirectionalWinner(winner) {
    if (typeof winner !== 'string') {
        throw new Error(`Invalid pairwise winner value: ${JSON.stringify(winner)}`);
    }
    const trimmed = winner.trim();
    if (trimmed === 'A' || trimmed === 'B') return trimmed;
    if (trimmed.toLowerCase() === 'tie') return 'tie';
    throw new Error(`Unsupported pairwise winner value: ${JSON.stringify(winner)}`);
}

/**
 * Resolves a bidirectional (or unidirectional) pairwise matchup between `paperA` and `paperB`.
 *
 * - Forward evaluates `(presentedA = paperA, presentedB = paperB)`.
 * - Reverse evaluates `(presentedA = paperB, presentedB = paperA)`.
 * - Inconsistent flips (`paperA` wins forward AND `paperB` wins reverse, or vice versa)
 *   cleanly resolve to a `0.5` / `0.5` tie and flag `positionBiasDetected: true`.
 */
function resolvePositionSwappedComparison({ paperA, paperB, forward, reverse = null, round = null }) {
    const idA = String(paperA || '').trim();
    const idB = String(paperB || '').trim();
    const pairKey = canonicalPairKey(idA, idB);

    if (!forward || typeof forward !== 'object') {
        throw new Error(`Matchup ${pairKey} is missing a forward comparison result.`);
    }
    const forwardSlot = normalizeDirectionalWinner(forward.winner);
    const forwardWinnerId = forwardSlot === 'A' ? idA : (forwardSlot === 'B' ? idB : 'tie');

    if (!reverse) {
        const scoreA = forwardWinnerId === idA ? 1 : (forwardWinnerId === idB ? 0 : 0.5);
        return {
            round,
            pairKey,
            paperA: idA,
            paperB: idB,
            bidirectional: false,
            resolvedWinner: forwardWinnerId === idA ? 'A' : (forwardWinnerId === idB ? 'B' : 'tie'),
            scoreA,
            scoreB: 1 - scoreA,
            consistent: null,
            flipped: false,
            partialAgreement: false,
            positionBiasDetected: false,
            positionBiasType: 'none',
            resolution: `unidirectional_${forwardSlot}`,
            forward: {
                winner: forwardSlot,
                winnerId: forwardWinnerId,
                confidence: forward.confidence || null,
                reason: forward.reason || '',
                ...(typeof forward.promptSha256 === 'string' && forward.promptSha256 ? { promptSha256: forward.promptSha256 } : {})
            },
            reverse: null
        };
    }

    const reverseSlot = normalizeDirectionalWinner(reverse.winner);
    // In reverse presentation, slot A is paperB and slot B is paperA!
    const reverseWinnerId = reverseSlot === 'A' ? idB : (reverseSlot === 'B' ? idA : 'tie');

    let scoreA;
    let resolvedWinner;
    let consistent;
    let flipped = false;
    let partialAgreement = false;
    let positionBiasDetected = false;
    let positionBiasType = 'none';
    let resolution;

    if (forwardWinnerId === reverseWinnerId) {
        consistent = true;
        if (forwardWinnerId === idA) {
            scoreA = 1;
            resolvedWinner = 'A';
            resolution = 'unanimous_A';
        } else if (forwardWinnerId === idB) {
            scoreA = 0;
            resolvedWinner = 'B';
            resolution = 'unanimous_B';
        } else {
            scoreA = 0.5;
            resolvedWinner = 'tie';
            resolution = 'unanimous_tie';
        }
    } else if (forwardWinnerId !== 'tie' && reverseWinnerId !== 'tie') {
        // Hard position-swap flip: paperA beat paperB in one slot order and paperB beat paperA in reverse!
        consistent = false;
        flipped = true;
        positionBiasDetected = true;
        scoreA = 0.5;
        resolvedWinner = 'tie';
        resolution = 'position_flip_tie';
        if (forwardSlot === 'A' && reverseSlot === 'A') {
            positionBiasType = 'first_slot';
        } else if (forwardSlot === 'B' && reverseSlot === 'B') {
            positionBiasType = 'second_slot';
        }
    } else {
        // Soft disagreement: one direction decisive, one direction tie -> average (0.75 / 0.25).
        consistent = false;
        partialAgreement = true;
        const forwardScoreA = forwardWinnerId === idA ? 1 : (forwardWinnerId === idB ? 0 : 0.5);
        const reverseScoreA = reverseWinnerId === idA ? 1 : (reverseWinnerId === idB ? 0 : 0.5);
        scoreA = (forwardScoreA + reverseScoreA) / 2;
        resolvedWinner = scoreA > 0.5 ? 'A' : 'B';
        resolution = scoreA > 0.5 ? 'partial_A' : 'partial_B';
    }

    return {
        round,
        pairKey,
        paperA: idA,
        paperB: idB,
        bidirectional: true,
        resolvedWinner,
        scoreA,
        scoreB: 1 - scoreA,
        consistent,
        flipped,
        partialAgreement,
        positionBiasDetected,
        positionBiasType,
        resolution,
        forward: {
            winner: forwardSlot,
            winnerId: forwardWinnerId,
            confidence: forward.confidence || null,
            reason: forward.reason || '',
            ...(typeof forward.promptSha256 === 'string' && forward.promptSha256 ? { promptSha256: forward.promptSha256 } : {})
        },
        reverse: {
            winner: reverseSlot,
            winnerId: reverseWinnerId,
            confidence: reverse.confidence || null,
            reason: reverse.reason || '',
            ...(typeof reverse.promptSha256 === 'string' && reverse.promptSha256 ? { promptSha256: reverse.promptSha256 } : {})
        }
    };
}

/**
 * Normalizes heterogeneous comparison log formats into resolved matchup records + position diagnostics.
 * Accepts:
 * - Bidirectional records: `{ paperA, paperB, forward: {...}, reverse: {...}, round? }`
 * - Pre-resolved records: `{ paperA, paperB, scoreA, scoreB }` or `{ paperA, paperB, winner }`
 * - Flat directional records: `{ round?, paperA, paperB, direction: 'forward'|'reverse', presentedA?, presentedB?, winner, confidence?, reason? }`
 */
function normalizeAndResolveComparisons(comparisons) {
    if (!Array.isArray(comparisons)) {
        throw new TypeError('comparisons must be an array.');
    }

    const resolved = [];
    const directionalGroups = new Map();

    for (let idx = 0; idx < comparisons.length; idx += 1) {
        const entry = comparisons[idx];
        if (!entry || typeof entry !== 'object') {
            throw new Error(`Comparison entry at index ${idx} must be an object.`);
        }

        // Case 1: Flat directional log entry (`direction: 'forward' | 'reverse'`).
        if (entry.direction === 'forward' || entry.direction === 'reverse') {
            const presentedA = String(entry.presentedA || (entry.direction === 'forward' ? entry.paperA : entry.paperB) || '').trim();
            const presentedB = String(entry.presentedB || (entry.direction === 'forward' ? entry.paperB : entry.paperA) || '').trim();
            const canonicalA = String(entry.paperA || (entry.direction === 'forward' ? presentedA : presentedB) || '').trim();
            const canonicalB = String(entry.paperB || (entry.direction === 'forward' ? presentedB : presentedA) || '').trim();
            const pairKey = canonicalPairKey(canonicalA, canonicalB);
            const round = Number.isInteger(entry.round) ? entry.round : 0;
            const groupKey = `${round}::${pairKey}`;

            if (!directionalGroups.has(groupKey)) {
                const [sortedA, sortedB] = splitPairKey(pairKey);
                directionalGroups.set(groupKey, {
                    round: Number.isInteger(entry.round) ? entry.round : null,
                    paperA: entry.paperA ? canonicalA : sortedA,
                    paperB: entry.paperB ? canonicalB : sortedB,
                    forward: null,
                    reverse: null
                });
            }
            const group = directionalGroups.get(groupKey);
            const winnerSlot = normalizeDirectionalWinner(entry.winner);
            // Align presented orientation to group's (paperA, paperB).
            if (presentedA === group.paperA && presentedB === group.paperB) {
                if (group.forward) {
                    throw new Error(`Duplicate forward comparison for ${groupKey}`);
                }
                group.forward = {
                    winner: winnerSlot,
                    confidence: entry.confidence || null,
                    reason: entry.reason || '',
                    ...(typeof entry.promptSha256 === 'string' && entry.promptSha256 ? { promptSha256: entry.promptSha256 } : {})
                };
            } else if (presentedA === group.paperB && presentedB === group.paperA) {
                if (group.reverse) {
                    throw new Error(`Duplicate reverse comparison for ${groupKey}`);
                }
                group.reverse = {
                    winner: winnerSlot,
                    confidence: entry.confidence || null,
                    reason: entry.reason || '',
                    ...(typeof entry.promptSha256 === 'string' && entry.promptSha256 ? { promptSha256: entry.promptSha256 } : {})
                };
            } else {
                throw new Error(`Directional comparison paper mismatch for ${groupKey}`);
            }
            continue;
        }

        const paperA = String(entry.paperA ?? entry.a ?? '').trim();
        const paperB = String(entry.paperB ?? entry.b ?? '').trim();
        const pairKey = canonicalPairKey(paperA, paperB);
        const round = Number.isInteger(entry.round) ? entry.round : null;

        // Case 2: Bidirectional object with `forward` (and optional `reverse`).
        if (entry.forward && typeof entry.forward === 'object') {
            resolved.push(resolvePositionSwappedComparison({
                paperA,
                paperB,
                forward: entry.forward,
                reverse: entry.reverse || null,
                round
            }));
            continue;
        }

        // Case 3: Pre-resolved numeric `scoreA` (and optional `scoreB`).
        if (entry.scoreA !== undefined) {
            const scoreA = Number(entry.scoreA);
            const scoreB = entry.scoreB === undefined ? (1 - scoreA) : Number(entry.scoreB);
            if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB) || scoreA < 0 || scoreB < 0 || (scoreA + scoreB) <= 0) {
                throw new Error(`Invalid numeric scores for comparison ${pairKey}: scoreA=${entry.scoreA}, scoreB=${entry.scoreB}`);
            }
            const total = scoreA + scoreB;
            const normA = scoreA / total;
            const normB = scoreB / total;
            resolved.push({
                round,
                pairKey,
                paperA,
                paperB,
                bidirectional: Boolean(entry.bidirectional),
                resolvedWinner: normA > normB ? 'A' : (normB > normA ? 'B' : 'tie'),
                scoreA: normA,
                scoreB: normB,
                consistent: typeof entry.consistent === 'boolean' ? entry.consistent : null,
                flipped: Boolean(entry.flipped),
                partialAgreement: Boolean(entry.partialAgreement),
                positionBiasDetected: Boolean(entry.positionBiasDetected),
                positionBiasType: entry.positionBiasType || 'none',
                resolution: entry.resolution || 'pre_resolved',
                forward: null,
                reverse: null
            });
            continue;
        }

        // Case 4: Simple `{ paperA, paperB, winner: 'A' | 'B' | 'tie' }`.
        if (entry.winner !== undefined) {
            resolved.push(resolvePositionSwappedComparison({
                paperA,
                paperB,
                forward: {
                    winner: entry.winner,
                    confidence: entry.confidence || null,
                    reason: entry.reason || ''
                },
                reverse: null,
                round
            }));
            continue;
        }

        throw new Error(`Comparison entry at index ${idx} (${pairKey}) must provide forward/reverse, scoreA, or winner.`);
    }

    // Finalize grouped directional entries in deterministic key order.
    for (const groupKey of Array.from(directionalGroups.keys()).sort()) {
        const group = directionalGroups.get(groupKey);
        if (group.forward) {
            resolved.push(resolvePositionSwappedComparison(group));
        } else if (group.reverse) {
            // Only reverse was provided: treat presented orientation as forward unidirectional.
            resolved.push(resolvePositionSwappedComparison({
                paperA: group.paperB,
                paperB: group.paperA,
                forward: group.reverse,
                reverse: null,
                round: group.round
            }));
        }
    }

    // Canonicalize record orientation (sorted paperA < paperB) and ordering for deterministic hashing & replay.
    // Swapping orientation also swaps forward/reverse (or flips unidirectional slot) so replaying the
    // canonicalized sidecar comparisons is strictly idempotent and bit-for-bit invariant.
    const flipSlot = slot => (slot === 'A' ? 'B' : (slot === 'B' ? 'A' : 'tie'));
    const flipResolution = res => {
        if (res === 'unanimous_A') return 'unanimous_B';
        if (res === 'unanimous_B') return 'unanimous_A';
        if (res === 'partial_A') return 'partial_B';
        if (res === 'partial_B') return 'partial_A';
        if (res === 'unidirectional_A') return 'unidirectional_B';
        if (res === 'unidirectional_B') return 'unidirectional_A';
        return res;
    };

    const canonicalResolved = resolved.map(rec => {
        if (rec.paperA <= rec.paperB) return rec;
        let swappedForward = rec.forward;
        let swappedReverse = rec.reverse;
        if (rec.forward && rec.reverse) {
            // In reverse, slot A was rec.paperB (= new paperA) and slot B was rec.paperA (= new paperB).
            swappedForward = { ...rec.reverse };
            swappedReverse = { ...rec.forward };
        } else if (rec.forward && !rec.reverse) {
            swappedForward = {
                ...rec.forward,
                winner: flipSlot(rec.forward.winner)
            };
        }
        return {
            ...rec,
            paperA: rec.paperB,
            paperB: rec.paperA,
            resolvedWinner: flipSlot(rec.resolvedWinner),
            scoreA: rec.scoreB,
            scoreB: rec.scoreA,
            resolution: flipResolution(rec.resolution),
            forward: swappedForward,
            reverse: swappedReverse
        };
    });

    canonicalResolved.sort((x, y) => {
        const rx = x.round ?? 0;
        const ry = y.round ?? 0;
        if (rx !== ry) return rx - ry;
        if (x.pairKey !== y.pairKey) return x.pairKey < y.pairKey ? -1 : 1;
        if (x.scoreA !== y.scoreA) return x.scoreA - y.scoreA;
        const resCmp = String(x.resolution).localeCompare(String(y.resolution));
        if (resCmp !== 0) return resCmp;
        const hx = stableJsonSha256(x);
        const hy = stableJsonSha256(y);
        return hx < hy ? -1 : (hx > hy ? 1 : 0);
    });

    // Compute position-swap bias diagnostics.
    let bidirectionalCount = 0;
    let consistentCount = 0;
    let flippedCount = 0;
    let partialAgreementCount = 0;
    let firstSlotBiasCount = 0;
    let secondSlotBiasCount = 0;

    for (const rec of canonicalResolved) {
        if (rec.bidirectional) {
            bidirectionalCount += 1;
            if (rec.consistent === true) consistentCount += 1;
            if (rec.flipped) flippedCount += 1;
            if (rec.partialAgreement) partialAgreementCount += 1;
            if (rec.positionBiasType === 'first_slot') firstSlotBiasCount += 1;
            if (rec.positionBiasType === 'second_slot') secondSlotBiasCount += 1;
        }
    }

    const positionConsistencyRate = bidirectionalCount > 0 ? consistentCount / bidirectionalCount : null;
    const positionFlipRate = bidirectionalCount > 0 ? flippedCount / bidirectionalCount : null;

    return {
        resolvedComparisons: canonicalResolved,
        positionConsistencyRate,
        positionFlipRate,
        positionBiasSummary: {
            totalMatchups: canonicalResolved.length,
            bidirectionalCount,
            unidirectionalCount: canonicalResolved.length - bidirectionalCount,
            consistentCount,
            flippedCount,
            partialAgreementCount,
            firstSlotBiasCount,
            secondSlotBiasCount,
            positionConsistencyRate,
            positionFlipRate
        }
    };
}

// ═══════════════════════════════════════════════════════
// Bradley-Terry MLE Solver (Log-Space Newman MM + Virtual Anchor Prior)
// ═══════════════════════════════════════════════════════

function countConnectedComponents(n, wins) {
    if (n === 0) return 0;
    const visited = new Uint8Array(n);
    let components = 0;
    for (let start = 0; start < n; start += 1) {
        if (visited[start]) continue;
        components += 1;
        const queue = [start];
        visited[start] = 1;
        while (queue.length > 0) {
            const u = queue.shift();
            for (let v = 0; v < n; v += 1) {
                if (visited[v] || u === v) continue;
                if (wins[u][v] > 0 || wins[v][u] > 0) {
                    visited[v] = 1;
                    queue.push(v);
                }
            }
        }
    }
    return components;
}

/**
 * Fits Bradley-Terry ratings via exact Majorization-Minimization (Newman 2023 log-space MM)
 * with a weak symmetric virtual-anchor opponent prior (`priorWeight`, default 0.25).
 *
 * The virtual anchor player (fixed log-strength = 0, strength = 1) adds `priorWeight`
 * virtual wins and `priorWeight` virtual losses for every item, making the regularized
 * log-likelihood strictly concave and coercive on ALL graphs (disconnected, cyclic,
 * undefeated, winless, or empty) with zero `Infinity`/`NaN`.
 */
function fitBradleyTerryRatings(itemIds, comparisons = [], options = {}) {
    if (!Array.isArray(itemIds)) {
        throw new TypeError('fitBradleyTerryRatings expects itemIds to be an array.');
    }
    const priorWeight = validatePriorWeight(options.priorWeight ?? DEFAULT_PRIOR_WEIGHT);
    const tolerance = options.tolerance === undefined
        ? DEFAULT_CONVERGENCE_TOLERANCE
        : parseStrictNumber(options.tolerance, 'tolerance');
    if (tolerance <= 0) {
        throw new RangeError(`tolerance must be a finite positive number, received: ${options.tolerance}`);
    }
    const maxIterations = options.maxIterations === undefined
        ? DEFAULT_MAX_ITERATIONS
        : parseStrictNumber(options.maxIterations, 'maxIterations');
    if (!Number.isInteger(maxIterations) || maxIterations < 1) {
        throw new RangeError(`maxIterations must be a positive integer, received: ${options.maxIterations}`);
    }

    // Deduplicate and canonically sort IDs for strict permutation invariance.
    const seen = new Set();
    const ids = [];
    for (let i = 0; i < itemIds.length; i += 1) {
        const id = extractPaperId(itemIds[i]);
        if (!id) throw new Error(`Invalid item ID at index ${i}.`);
        if (seen.has(id)) throw new Error(`Duplicate item ID in fitBradleyTerryRatings: ${id}`);
        seen.add(id);
        ids.push(id);
    }
    ids.sort();

    const n = ids.length;
    const idToIdx = new Map(ids.map((id, idx) => [id, idx]));
    const wins = Array.from({ length: n }, () => new Float64Array(n));

    const { resolvedComparisons } = normalizeAndResolveComparisons(comparisons);

    let totalComparisons = 0;
    const pairEncounterSet = new Set();

    for (const rec of resolvedComparisons) {
        const i = idToIdx.get(rec.paperA);
        const j = idToIdx.get(rec.paperB);
        if (i === undefined || j === undefined) {
            throw new Error(`Comparison references unknown item ID: ${rec.paperA} vs ${rec.paperB}`);
        }
        wins[i][j] += rec.scoreA;
        wins[j][i] += rec.scoreB;
        totalComparisons += rec.scoreA + rec.scoreB;
        pairEncounterSet.add(rec.pairKey);
    }

    const theta = new Float64Array(n); // initialized to 0 (rating = 1.0)
    const logPriorWeight = Math.log(priorWeight);
    let iterations = 0;
    let maxDelta = 0;
    let converged = true;
    let hitBoundary = false;

    if (n > 0) {
        converged = false;
        const numTerms = [];
        const denTerms = [];
        for (let iter = 1; iter <= maxIterations; iter += 1) {
            iterations = iter;
            maxDelta = 0;
            let iterHitBoundary = false;
            for (let i = 0; i < n; i += 1) {
                const ti = theta[i];
                numTerms.length = 0;
                denTerms.length = 0;
                numTerms.push(logPriorWeight + logSigmoid(-ti));
                denTerms.push(logPriorWeight + logSigmoid(ti));
                for (let j = 0; j < n; j += 1) {
                    if (i === j) continue;
                    const wij = wins[i][j];
                    const wji = wins[j][i];
                    if (wij > 0) numTerms.push(Math.log(wij) + logSigmoid(theta[j] - ti));
                    if (wji > 0) denTerms.push(Math.log(wji) + logSigmoid(ti - theta[j]));
                }
                const logNum = logSumExp(numTerms);
                const logDen = logSumExp(denTerms);
                const step = logNum - logDen;
                const absStep = Math.abs(step);
                if (absStep > maxDelta) maxDelta = absStep;
                const unclampedNext = ti + step;
                if (unclampedNext > THETA_SAFETY_BOUND || unclampedNext < -THETA_SAFETY_BOUND) {
                    iterHitBoundary = true;
                    theta[i] = clamp(unclampedNext, -THETA_SAFETY_BOUND, THETA_SAFETY_BOUND);
                } else {
                    theta[i] = unclampedNext;
                }
            }
            hitBoundary = iterHitBoundary;
            if (maxDelta <= tolerance && !hitBoundary) {
                converged = true;
                break;
            }
        }
    }

    const ratings = {};
    const logStrengths = {};
    const perItem = {};
    const isolatedItems = [];
    const undefeatedItems = [];
    const winlessItems = [];

    for (let i = 0; i < n; i += 1) {
        const id = ids[i];
        const logStrength = normalizeZero(theta[i]);
        const rating = Math.exp(logStrength);
        if (!Number.isFinite(logStrength) || !Number.isFinite(rating)) {
            throw new Error(`Non-finite Bradley-Terry rating encountered for ${id}.`);
        }
        logStrengths[id] = logStrength;
        ratings[id] = rating;

        let effectiveWins = 0;
        let effectiveLosses = 0;
        for (let j = 0; j < n; j += 1) {
            if (i === j) continue;
            effectiveWins += wins[i][j];
            effectiveLosses += wins[j][i];
        }
        const games = effectiveWins + effectiveLosses;
        if (games === 0) isolatedItems.push(id);
        else if (effectiveLosses === 0 && effectiveWins > 0) undefeatedItems.push(id);
        else if (effectiveWins === 0 && effectiveLosses > 0) winlessItems.push(id);

        perItem[id] = {
            games: roundTo(games, 6),
            effectiveWins: roundTo(effectiveWins, 6),
            effectiveLosses: roundTo(effectiveLosses, 6),
            winRate: games > 0 ? roundTo(effectiveWins / games, 6) : null
        };
    }

    return {
        ratings,
        logStrengths,
        converged,
        hitBoundary,
        iterations,
        maxDelta: normalizeZero(maxDelta),
        priorWeight,
        tolerance,
        maxIterations,
        winMatrixSummary: {
            itemCount: n,
            totalComparisons: roundTo(totalComparisons, 6),
            uniquePairsCompared: pairEncounterSet.size,
            connectedComponents: countConnectedComponents(n, wins),
            isolatedItems,
            undefeatedItems,
            winlessItems,
            perItem
        }
    };
}

// ═══════════════════════════════════════════════════════
// Kendall's Tau-b & Bounded Anchor-Preserving Score Calibration
// ═══════════════════════════════════════════════════════

/**
 * Computes tie-adjusted Kendall's tau-b between two equal-length numeric arrays.
 * Returns `tauB: null` (never `NaN`) when fewer than 2 items or either sequence is constant.
 */
function computeKendallTauB(xs, ys, eps = 1e-12) {
    if (!Array.isArray(xs) || !Array.isArray(ys) || xs.length !== ys.length) {
        throw new TypeError('computeKendallTauB requires two arrays of equal length.');
    }
    const n = xs.length;
    for (let i = 0; i < n; i += 1) {
        if (typeof xs[i] !== 'number' || !Number.isFinite(xs[i])) {
            throw new RangeError(`computeKendallTauB xs[${i}] must be a finite number, received: ${xs[i]}`);
        }
        if (typeof ys[i] !== 'number' || !Number.isFinite(ys[i])) {
            throw new RangeError(`computeKendallTauB ys[${i}] must be a finite number, received: ${ys[i]}`);
        }
    }
    const totalPairs = (n * (n - 1)) / 2;
    if (n < 2) {
        return {
            tauB: null,
            concordant: 0,
            discordant: 0,
            tiesX: 0,
            tiesY: 0,
            jointTies: 0,
            totalPairs: 0
        };
    }

    let concordant = 0;
    let discordant = 0;
    let tiesX = 0;
    let tiesY = 0;
    let jointTies = 0;

    for (let i = 0; i < n; i += 1) {
        for (let j = i + 1; j < n; j += 1) {
            const dx = xs[i] - xs[j];
            const dy = ys[i] - ys[j];
            const xTied = Math.abs(dx) <= eps;
            const yTied = Math.abs(dy) <= eps;
            if (xTied && yTied) jointTies += 1;
            else if (xTied) tiesX += 1;
            else if (yTied) tiesY += 1;
            else if (dx * dy > 0) concordant += 1;
            else discordant += 1;
        }
    }

    const denom = Math.sqrt((concordant + discordant + tiesX) * (concordant + discordant + tiesY));
    const tauB = denom > 0 ? normalizeZero((concordant - discordant) / denom) : null;

    return {
        tauB,
        concordant,
        discordant,
        tiesX,
        tiesY,
        jointTies,
        totalPairs
    };
}

function computeMeanAndStd(values) {
    if (values.length === 0) return { mean: 0, std: 0 };
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + ((v - mean) ** 2), 0) / values.length;
    return { mean, std: Math.sqrt(Math.max(0, variance)) };
}

function computeBoundedCalibratedScore(rawScore, targetScore, maxDelta, decimals) {
    const rawBoundLow = Math.max(SCORE_MIN, rawScore - maxDelta);
    const rawBoundHigh = Math.min(SCORE_MAX, rawScore + maxDelta);
    const unclampedDelta = targetScore - rawScore;
    const clampedTarget = clamp(rawScore + clamp(unclampedDelta, -maxDelta, maxDelta), SCORE_MIN, SCORE_MAX);

    const factor = 10 ** decimals;
    // Guarantee even after decimal rounding that |calibratedScore - rawScore| <= maxDelta and in [0, 10].
    const safeLow = Math.ceil((rawBoundLow - 1e-12) * factor) / factor;
    const safeHigh = Math.floor((rawBoundHigh + 1e-12) * factor) / factor;

    let rounded = roundTo(clampedTarget, decimals);
    if (safeLow <= safeHigh) {
        rounded = clamp(rounded, safeLow, safeHigh);
        rounded = roundTo(rounded, decimals);
    } else {
        rounded = roundTo(rawScore, decimals);
    }

    const delta = roundTo(rounded - rawScore, decimals);
    const capped = Math.abs(unclampedDelta) > maxDelta + 1e-12;
    return { calibratedScore: rounded, delta, capped };
}

function computeTieClusterStats(calibratedPapers, scoreDecimals = DEFAULT_SCORE_DECIMALS) {
    const rawDecimals = Math.max(2, scoreDecimals);
    const rawBuckets = new Map();
    const calBuckets = new Map();

    for (const p of calibratedPapers) {
        const rawKey = p.rawScore.toFixed(rawDecimals);
        if (!rawBuckets.has(rawKey)) rawBuckets.set(rawKey, []);
        rawBuckets.get(rawKey).push(p);

        const calKey = p.calibratedScore.toFixed(scoreDecimals);
        if (!calBuckets.has(calKey)) calBuckets.set(calKey, []);
        calBuckets.get(calKey).push(p);
    }

    const clusters = [];
    let rawTiedPaperCount = 0;
    let resolvedClusterCount = 0;
    let totalRawTiedPairs = 0;
    let brokenTiesCount = 0;

    for (const [, bucket] of Array.from(rawBuckets.entries()).sort((a, b) => Number(b[0]) - Number(a[0]))) {
        if (bucket.length < 2) continue;
        rawTiedPaperCount += bucket.length;
        const uniqueCal = new Set(bucket.map(item => item.calibratedScore.toFixed(scoreDecimals)));
        let clusterBrokenPairs = 0;
        let clusterTotalPairs = 0;
        for (let i = 0; i < bucket.length; i += 1) {
            for (let j = i + 1; j < bucket.length; j += 1) {
                clusterTotalPairs += 1;
                if (Math.abs(bucket[i].calibratedScore - bucket[j].calibratedScore) > 1e-9) {
                    clusterBrokenPairs += 1;
                }
            }
        }
        totalRawTiedPairs += clusterTotalPairs;
        brokenTiesCount += clusterBrokenPairs;
        if (uniqueCal.size > 1) resolvedClusterCount += 1;

        const calScores = bucket.map(item => item.calibratedScore);
        clusters.push({
            rawScore: bucket[0].rawScore,
            size: bucket.length,
            paperIds: bucket.map(item => item.paperId).sort(),
            uniqueCalibratedScores: uniqueCal.size,
            calibratedMin: Math.min(...calScores),
            calibratedMax: Math.max(...calScores),
            fullyBroken: uniqueCal.size === bucket.length
        });
    }

    let calibratedTieClusterCount = 0;
    let calibratedTiedPaperCount = 0;
    for (const bucket of calBuckets.values()) {
        if (bucket.length >= 2) {
            calibratedTieClusterCount += 1;
            calibratedTiedPaperCount += bucket.length;
        }
    }

    return {
        rawTieClusterCount: clusters.length,
        rawTiedPaperCount,
        calibratedTieClusterCount,
        calibratedTiedPaperCount,
        resolvedClusterCount,
        brokenTiesCount,
        totalRawTiedPairs,
        tieBreakRate: totalRawTiedPairs > 0 ? roundTo(brokenTiesCount / totalRawTiedPairs, 6) : null,
        clusters
    };
}

function computeTopKMovement(calibratedPapers, topKValues = [3, 5, 10]) {
    const n = calibratedPapers.length;
    if (n === 0) {
        return {
            topKMovement: {},
            rankDisplacementSummary: {
                meanAbsRankShift: 0,
                maxAbsRankShift: 0,
                movedCount: 0,
                unchangedCount: 0
            }
        };
    }

    const rawSorted = calibratedPapers.slice().sort((a, b) => {
        if (Math.abs(b.rawScore - a.rawScore) > 1e-12) return b.rawScore - a.rawScore;
        return a.paperId < b.paperId ? -1 : 1;
    });
    const calSorted = calibratedPapers.slice().sort((a, b) => {
        if (Math.abs(b.calibratedScore - a.calibratedScore) > 1e-12) return b.calibratedScore - a.calibratedScore;
        if (Math.abs(b.btLogStrength - a.btLogStrength) > 1e-12) return b.btLogStrength - a.btLogStrength;
        if (Math.abs(b.rawScore - a.rawScore) > 1e-12) return b.rawScore - a.rawScore;
        return a.paperId < b.paperId ? -1 : 1;
    });

    const rawRankById = new Map(rawSorted.map((p, idx) => [p.paperId, idx + 1]));
    const calRankById = new Map(calSorted.map((p, idx) => [p.paperId, idx + 1]));

    const effectiveKs = Array.from(new Set(
        topKValues.filter(k => Number.isInteger(k) && k >= 1 && k <= n)
    )).sort((a, b) => a - b);
    if (effectiveKs.length === 0) {
        effectiveKs.push(n);
    }

    const topKMovement = {};
    for (const k of effectiveKs) {
        const rawTopK = rawSorted.slice(0, k).map(p => p.paperId);
        const calibratedTopK = calSorted.slice(0, k).map(p => p.paperId);
        const rawSet = new Set(rawTopK);
        const calSet = new Set(calibratedTopK);
        const entered = calibratedTopK.filter(id => !rawSet.has(id));
        const exited = rawTopK.filter(id => !calSet.has(id));
        const retainedCount = calibratedTopK.filter(id => rawSet.has(id)).length;
        const union = new Set([...rawTopK, ...calibratedTopK]);
        let maxRankDisplacement = 0;
        for (const id of union) {
            const shift = Math.abs(rawRankById.get(id) - calRankById.get(id));
            if (shift > maxRankDisplacement) maxRankDisplacement = shift;
        }
        topKMovement[`top${k}`] = {
            k,
            rawTopK,
            calibratedTopK,
            entered,
            exited,
            retainedCount,
            jaccardOverlap: roundTo(retainedCount / union.size, 6),
            maxRankDisplacement
        };
    }

    let absShiftSum = 0;
    let maxAbsRankShift = 0;
    let movedCount = 0;
    let unchangedCount = 0;
    for (const p of calibratedPapers) {
        const rawRank = rawRankById.get(p.paperId);
        const calRank = calRankById.get(p.paperId);
        const absShift = Math.abs(rawRank - calRank);
        absShiftSum += absShift;
        if (absShift > maxAbsRankShift) maxAbsRankShift = absShift;
        if (absShift > 0) movedCount += 1;
        else unchangedCount += 1;
    }

    return {
        rawRankById,
        calRankById,
        topKMovement,
        rankDisplacementSummary: {
            meanAbsRankShift: roundTo(absShiftSum / n, 6),
            maxAbsRankShift,
            movedCount,
            unchangedCount
        }
    };
}

function formatCalibrationBadge(delta, rankDelta, decimals = 2) {
    const sign = delta > 0 ? '+' : '';
    const arrow = rankDelta > 0 ? `↑${rankDelta}` : (rankDelta < 0 ? `↓${Math.abs(rankDelta)}` : '→0');
    return `${sign}${delta.toFixed(decimals)} (${arrow})`;
}

/**
 * Calibrates a batch's scores using Bradley-Terry latent strengths anchored to the existing
 * 0-10 absolute rubric scale with strict `±maxDelta` safety bounds.
 *
 * NEVER mutates input `papers` or `comparisons`.
 */
function calibrateBatchScores(inputPapers, comparisons = [], options = {}) {
    const maxDelta = validateMaxDelta(options.maxDelta ?? DEFAULT_MAX_DELTA);
    const priorWeight = validatePriorWeight(options.priorWeight ?? DEFAULT_PRIOR_WEIGHT);
    const tolerance = options.tolerance === undefined
        ? DEFAULT_CONVERGENCE_TOLERANCE
        : parseStrictNumber(options.tolerance, 'tolerance');
    const maxIterations = options.maxIterations === undefined
        ? DEFAULT_MAX_ITERATIONS
        : parseStrictNumber(options.maxIterations, 'maxIterations');
    const scoreDecimals = options.scoreDecimals === undefined
        ? DEFAULT_SCORE_DECIMALS
        : parseStrictNumber(options.scoreDecimals, 'scoreDecimals');
    if (!Number.isInteger(scoreDecimals) || scoreDecimals < 1 || scoreDecimals > 4) {
        throw new RangeError(`scoreDecimals must be an integer in [1, 4], received: ${options.scoreDecimals}`);
    }
    const mappingMethod = options.mappingMethod || 'moment_anchored';
    if (!MAPPING_METHODS.includes(mappingMethod)) {
        throw new RangeError(`mappingMethod must be one of ${MAPPING_METHODS.join(', ')}, received: ${mappingMethod}`);
    }

    const { papers, excludedPapers } = extractCalibratablePapers(inputPapers);
    const canonicalPapers = papers.slice().sort((a, b) => (a.paperId < b.paperId ? -1 : 1));
    const itemIds = canonicalPapers.map(p => p.paperId);

    const {
        resolvedComparisons,
        positionConsistencyRate,
        positionFlipRate,
        positionBiasSummary
    } = normalizeAndResolveComparisons(comparisons);

    const solverResult = fitBradleyTerryRatings(itemIds, resolvedComparisons, {
        priorWeight,
        tolerance,
        maxIterations
    });

    const rawScores = canonicalPapers.map(p => p.rawScore);
    const { mean: rawMean, std: rawStd } = computeMeanAndStd(rawScores);

    // Partition compared (games > 0) vs isolated (games === 0) papers.
    // Isolated papers receive ZERO drift (delta = 0) and do not skew the anchor stats of compared papers.
    const comparedPapers = [];
    const isolatedPapers = [];
    for (const p of canonicalPapers) {
        const games = solverResult.winMatrixSummary.perItem[p.paperId]?.games || 0;
        if (games > 0) comparedPapers.push(p);
        else isolatedPapers.push(p);
    }

    const targetById = new Map();
    for (const p of isolatedPapers) {
        targetById.set(p.paperId, p.rawScore);
    }

    const comparedRawScores = comparedPapers.map(p => p.rawScore);
    const comparedBtLogStrengths = comparedPapers.map(p => solverResult.logStrengths[p.paperId]);
    const { mean: compRawMean, std: compRawStd } = computeMeanAndStd(comparedRawScores);
    const { mean: compBtMean, std: compBtStd } = computeMeanAndStd(comparedBtLogStrengths);

    // Compute anchor-preserving target scores strictly over compared papers before applying ±maxDelta cap.
    if (comparedPapers.length === 0 || compBtStd <= 1e-12 || maxDelta === 0) {
        for (const p of comparedPapers) {
            targetById.set(p.paperId, p.rawScore);
        }
    } else if (mappingMethod === 'quantile_anchored' && compRawStd > 1e-12) {
        const sortedRawAsc = comparedRawScores.slice().sort((a, b) => a - b);
        const orderAsc = comparedPapers.slice().sort((a, b) => {
            const ta = solverResult.logStrengths[a.paperId];
            const tb = solverResult.logStrengths[b.paperId];
            if (Math.abs(ta - tb) > 1e-12) return ta - tb;
            if (Math.abs(a.rawScore - b.rawScore) > 1e-12) return a.rawScore - b.rawScore;
            return a.paperId < b.paperId ? -1 : 1;
        });
        // Average quantile anchors across exact BT ties so identical strengths receive identical targets.
        let i = 0;
        while (i < orderAsc.length) {
            let j = i + 1;
            const ti = solverResult.logStrengths[orderAsc[i].paperId];
            while (j < orderAsc.length && Math.abs(solverResult.logStrengths[orderAsc[j].paperId] - ti) <= 1e-12) {
                j += 1;
            }
            let sum = 0;
            for (let k = i; k < j; k += 1) sum += sortedRawAsc[k];
            const avgAnchor = sum / (j - i);
            for (let k = i; k < j; k += 1) {
                targetById.set(orderAsc[k].paperId, avgAnchor);
            }
            i = j;
        }
    } else {
        // Moment-anchored mapping preserving compared-group mean and spread.
        // If all compared raw scores are tied (compRawStd === 0, e.g. 8 papers stuck at 7.4),
        // scale the BT range smoothly across [compRawMean - maxDelta, compRawMean + maxDelta]
        // so the tie cluster breaks cleanly while keeping the exact batch mean!
        const zScores = comparedBtLogStrengths.map(v => (v - compBtMean) / compBtStd);
        const maxAbsZ = Math.max(...zScores.map(Math.abs), 1);
        const effectiveSpread = compRawStd > 1e-12 ? compRawStd : (maxDelta / maxAbsZ);
        for (let i = 0; i < comparedPapers.length; i += 1) {
            targetById.set(comparedPapers[i].paperId, compRawMean + zScores[i] * effectiveSpread);
        }
    }

    let cappedCount = 0;
    let maxObservedDelta = 0;

    const calibratedBase = canonicalPapers.map(p => {
        const target = targetById.get(p.paperId);
        const { calibratedScore, delta, capped } = computeBoundedCalibratedScore(
            p.rawScore,
            target,
            maxDelta,
            scoreDecimals
        );
        if (capped) cappedCount += 1;
        if (Math.abs(delta) > maxObservedDelta) maxObservedDelta = Math.abs(delta);
        const itemStats = solverResult.winMatrixSummary.perItem[p.paperId] || {
            games: 0,
            effectiveWins: 0,
            effectiveLosses: 0,
            winRate: null
        };
        return {
            paperId: p.paperId,
            title: p.title,
            rawScore: p.rawScore,
            calibratedScore,
            delta,
            capped,
            btRating: roundTo(solverResult.ratings[p.paperId], 6),
            btLogStrength: roundTo(solverResult.logStrengths[p.paperId], 6),
            games: itemStats.games,
            effectiveWins: itemStats.effectiveWins,
            effectiveLosses: itemStats.effectiveLosses,
            winRate: itemStats.winRate
        };
    });

    const { rawRankById, calRankById, topKMovement, rankDisplacementSummary } = computeTopKMovement(
        calibratedBase,
        options.topKValues
    );

    const calibratedPapers = calibratedBase
        .map(p => {
            const rawRank = rawRankById ? rawRankById.get(p.paperId) : 0;
            const calibratedRank = calRankById ? calRankById.get(p.paperId) : 0;
            // Positive rankDelta means moved UP in ranking (e.g. rank 5 -> rank 2 = +3).
            const rankDelta = rawRank - calibratedRank;
            return {
                ...p,
                rawRank,
                calibratedRank,
                rankDelta,
                badge: formatCalibrationBadge(p.delta, rankDelta, scoreDecimals)
            };
        })
        .sort((a, b) => a.calibratedRank - b.calibratedRank || (a.paperId < b.paperId ? -1 : 1));

    // Align score arrays by canonical paperId order for Kendall's tau.
    const calById = new Map(calibratedPapers.map(p => [p.paperId, p]));
    const alignedRaw = canonicalPapers.map(p => p.rawScore);
    const alignedCal = canonicalPapers.map(p => calById.get(p.paperId).calibratedScore);
    const alignedBt = canonicalPapers.map(p => solverResult.logStrengths[p.paperId]);

    const kendallDetails = computeKendallTauB(alignedRaw, alignedCal);
    const kendallVsBtDetails = computeKendallTauB(alignedRaw, alignedBt);

    const { mean: calibratedMean, std: calibratedStd } = computeMeanAndStd(alignedCal);
    const tieClusterStats = computeTieClusterStats(calibratedPapers, scoreDecimals);

    // Deterministic content hashes of canonical inputs and comparison log.
    const canonicalInputFingerprintPayload = canonicalPapers.map(p => ({
        paperId: p.paperId,
        rawScore: p.rawScore,
        sourceSha256: p.sourceSha256,
        title: p.title
    }));
    const inputSha256 = stableJsonSha256(canonicalInputFingerprintPayload);
    const comparisonsSha256 = stableJsonSha256(resolvedComparisons);

    const corePayload = {
        contract: SCORE_CALIBRATION_CONTRACT,
        inputSha256,
        comparisonsSha256,
        readOnlyInvariant: {
            mutatedSealedInput: false,
            overwroteScoringAudit: false
        },
        config: {
            rounds: options.rounds ?? null,
            bidirectional: options.bidirectional ?? (positionBiasSummary.bidirectionalCount > 0),
            seed: options.seed ?? DEFAULT_SEED,
            priorWeight,
            tolerance,
            maxIterations,
            maxDelta,
            mappingMethod,
            scoreDecimals
        },
        solver: {
            converged: solverResult.converged,
            hitBoundary: solverResult.hitBoundary,
            iterations: solverResult.iterations,
            maxDelta: solverResult.maxDelta,
            priorWeight: solverResult.priorWeight,
            winMatrixSummary: solverResult.winMatrixSummary
        },
        diagnostics: {
            paperCount: canonicalPapers.length,
            excludedPaperCount: excludedPapers.length,
            excludedPapers,
            kendallTau: kendallDetails.tauB,
            kendallTauVsBt: kendallVsBtDetails.tauB,
            kendallDetails,
            positionConsistencyRate,
            positionFlipRate,
            positionBiasSummary,
            scoreSummary: {
                rawMean: roundTo(rawMean, 6),
                calibratedMean: roundTo(calibratedMean, 6),
                meanShift: roundTo(calibratedMean - rawMean, 6),
                rawStd: roundTo(rawStd, 6),
                calibratedStd: roundTo(calibratedStd, 6),
                maxObservedDelta: roundTo(maxObservedDelta, 6),
                cappedCount
            },
            tieClusterStats,
            topKMovement,
            rankDisplacementSummary
        },
        papers: calibratedPapers,
        comparisons: resolvedComparisons
    };

    const calibrationSha256 = stableJsonSha256(corePayload);

    return {
        ...corePayload,
        calibrationSha256
    };
}

module.exports = {
    SCORE_CALIBRATION_CONTRACT,
    DEFAULT_SWISS_ROUNDS,
    MIN_SWISS_ROUNDS,
    MAX_SWISS_ROUNDS,
    DEFAULT_PRIOR_WEIGHT,
    MIN_PRIOR_WEIGHT,
    MAX_PRIOR_WEIGHT,
    THETA_SAFETY_BOUND,
    DEFAULT_CONVERGENCE_TOLERANCE,
    DEFAULT_MAX_ITERATIONS,
    DEFAULT_MAX_DELTA,
    DEFAULT_SCORE_DECIMALS,
    DEFAULT_SEED,
    SCORE_MIN,
    SCORE_MAX,
    PAIRWISE_WINNERS,
    PAIRWISE_CONFIDENCES,
    MAPPING_METHODS,
    OMITTED_BLIND_SCORE_FIELDS,
    // Hashing & validation helpers
    canonicalizeForHash,
    sha256Hex,
    stableJsonSha256,
    canonicalPairKey,
    validateSwissRounds,
    validateMaxDelta,
    validatePriorWeight,
    // Read-only paper extraction
    extractPaperId,
    extractRawScore,
    extractCalibratablePapers,
    // Swiss pairing
    planSwissRoundPairs,
    planSwissTournamentSchedule,
    // Blind prompt & strict parser
    sanitizeBlindEvidenceText,
    buildPairwiseComparisonPrompt,
    parsePairwiseComparisonResponse,
    // Position-swap & comparison normalization
    resolvePositionSwappedComparison,
    normalizeAndResolveComparisons,
    // Bradley-Terry solver & bounded calibration
    fitBradleyTerryRatings,
    computeKendallTauB,
    calibrateBatchScores
};
