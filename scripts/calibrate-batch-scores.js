#!/usr/bin/env node
'use strict';

/**
 * Wave 14.4 CLI: Post-Batch Swiss-Tournament Bradley-Terry Relative Score Calibration.
 *
 * Cold-replay & sealed-data invariant:
 * - Strictly read-only on `deep-analysis-result.json`; NEVER mutates sealed input files
 *   or overwrites original `scoringAudit` scores.
 * - Produces an opt-in, deterministic, replayable `score-calibration-v1.json` sidecar.
 * - Uses `requestLlmJson` from `scripts/utils.js` ONLY when `--live` is explicitly passed;
 *   `--dry-run` and `--replay` execute 100% offline with zero LLM API calls.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const Config = require('./config.js');
const { requireExternalRuntime } = require('./env-loader.js');
const utils = require('./utils.js');
const { resolvePrimaryApiKeyPool } = require('./llm-account-pool.js');
const {
    SCORE_CALIBRATION_CONTRACT,
    DEFAULT_SWISS_ROUNDS,
    DEFAULT_PRIOR_WEIGHT,
    DEFAULT_MAX_DELTA,
    DEFAULT_SEED,
    MAPPING_METHODS,
    sha256Hex,
    stableJsonSha256,
    validateSwissRounds,
    validateMaxDelta,
    validatePriorWeight,
    extractCalibratablePapers,
    planSwissRoundPairs,
    planSwissTournamentSchedule,
    buildPairwiseComparisonPrompt,
    parsePairwiseComparisonResponse,
    resolvePositionSwappedComparison,
    fitBradleyTerryRatings,
    calibrateBatchScores
} = require('./lib/bradley-terry-calibration.js');

const DEFAULT_LIVE_CONCURRENCY = 4;
const MAX_LIVE_CONCURRENCY = 16;
const DEFAULT_LIVE_MAX_TOKENS = 32768;
const MIN_LIVE_MAX_TOKENS = 256;
const MAX_LIVE_MAX_TOKENS = 192000;
const DEFAULT_LIVE_TEMPERATURE = 0.1;
const DEFAULT_LIVE_TIMEOUT_MS = 120000;

function isValidCalendarDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const probe = new Date(Date.UTC(year, month - 1, day));
    return probe.getUTCFullYear() === year
        && probe.getUTCMonth() === month - 1
        && probe.getUTCDate() === day;
}

function formatUsage() {
    return [
        'Usage: node scripts/calibrate-batch-scores.js [options]',
        '',
        'Modes (specify exactly one):',
        '  --dry-run                    Compute deterministic Swiss pairing schedule & estimated API calls (0 tokens)',
        '  --replay <comparisons.json>  Deterministic offline recomputation from saved pairwise comparisons (0 tokens)',
        '  --live                       Explicit opt-in: execute live Swiss-tournament pairwise LLM comparisons',
        '',
        'Options:',
        '  --date YYYY-MM-DD            Target batch date (resolves default input & output paths)',
        '  --conference-process <uuid>  Aggregate completed analysis.json files from a conference process run (read-only)',
        '  --input <path>               Path to sealed deep-analysis-result.json (read-only)',
        '  --output <path>              Path to write score-calibration-v1.json sidecar',
        '  --rounds <1..6>              Swiss tournament rounds (default: 3, max: 6)',
        '  --max-delta <0..5>           Max absolute score shift in points (default: 0.6)',
        '  --prior-weight <num>         Bradley-Terry virtual-anchor prior weight (default: 0.25)',
        '  --mapping <method>           Score mapping: moment_anchored | quantile_anchored (default: moment_anchored)',
        '  --seed <string>              Deterministic pairing seed (default: swiss-bt-v1[:date])',
        '  --unidirectional             Disable reverse position-swap evaluation (default: bidirectional)',
        '  --concurrency <1..16>        Max concurrent LLM requests in --live mode (default: 4)',
        `  --max-tokens <256..192000>   Max output tokens per --live LLM call (default: ${DEFAULT_LIVE_MAX_TOKENS})`,
        '  --json                       Print full sidecar JSON to stdout',
        '  -h, --help                   Show this help message'
    ].join('\n');
}

function parseStrictCliInt(raw, flagName, min, max) {
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max) {
        return raw;
    }
    if (typeof raw !== 'string' || !/^[+-]?\d+$/.test(raw.trim())) {
        throw new RangeError(`${flagName} must be an integer in ${min}..${max}, received: ${JSON.stringify(raw)}`);
    }
    const parsed = Number(raw.trim());
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        throw new RangeError(`${flagName} must be an integer in ${min}..${max}, received: ${JSON.stringify(raw)}`);
    }
    return parsed;
}

function parseCliArgs(argv = process.argv.slice(2)) {
    const options = {
        date: null,
        conferenceProcess: null,
        input: null,
        output: null,
        rounds: DEFAULT_SWISS_ROUNDS,
        roundsExplicit: false,
        maxDelta: DEFAULT_MAX_DELTA,
        priorWeight: DEFAULT_PRIOR_WEIGHT,
        mappingMethod: 'moment_anchored',
        seed: null,
        bidirectional: true,
        bidirectionalExplicit: false,
        concurrency: DEFAULT_LIVE_CONCURRENCY,
        maxTokens: DEFAULT_LIVE_MAX_TOKENS,
        dryRun: false,
        replay: null,
        replaySpecified: false,
        live: false,
        json: false,
        help: false
    };

    const isFlagLike = value => value === '--' || value.startsWith('--') || /^-[a-zA-Z]/.test(value);

    const requireValue = (flag, idx) => {
        if (idx + 1 >= argv.length) {
            throw new Error(`Missing value for ${flag}`);
        }
        const value = argv[idx + 1];
        if (typeof value !== 'string' || !value.trim()) {
            throw new Error(`Empty value for ${flag}`);
        }
        if (isFlagLike(value)) {
            throw new Error(`Missing value for ${flag} (got flag ${value})`);
        }
        return value;
    };

    const requireEqualsValue = (arg, prefix) => {
        const value = arg.slice(prefix.length);
        if (!value.trim()) {
            throw new Error(`Empty value for ${prefix.slice(0, -1)}`);
        }
        return value;
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg === '--dry-run') {
            options.dryRun = true;
        } else if (arg === '--live') {
            options.live = true;
        } else if (arg === '--json') {
            options.json = true;
        } else if (arg === '--unidirectional') {
            options.bidirectional = false;
            options.bidirectionalExplicit = true;
        } else if (arg === '--date') {
            options.date = requireValue(arg, i);
            i += 1;
        } else if (arg.startsWith('--date=')) {
            options.date = requireEqualsValue(arg, '--date=');
        } else if (arg === '--conference-process') {
            options.conferenceProcess = requireValue(arg, i);
            i += 1;
        } else if (arg.startsWith('--conference-process=')) {
            options.conferenceProcess = requireEqualsValue(arg, '--conference-process=');
        } else if (arg === '--input') {
            options.input = requireValue(arg, i);
            i += 1;
        } else if (arg.startsWith('--input=')) {
            options.input = requireEqualsValue(arg, '--input=');
        } else if (arg === '--output') {
            options.output = requireValue(arg, i);
            i += 1;
        } else if (arg.startsWith('--output=')) {
            options.output = requireEqualsValue(arg, '--output=');
        } else if (arg === '--replay') {
            options.replay = requireValue(arg, i);
            options.replaySpecified = true;
            i += 1;
        } else if (arg.startsWith('--replay=')) {
            options.replay = requireEqualsValue(arg, '--replay=');
            options.replaySpecified = true;
        } else if (arg === '--rounds') {
            options.rounds = requireValue(arg, i);
            options.roundsExplicit = true;
            i += 1;
        } else if (arg.startsWith('--rounds=')) {
            options.rounds = requireEqualsValue(arg, '--rounds=');
            options.roundsExplicit = true;
        } else if (arg === '--max-delta') {
            options.maxDelta = requireValue(arg, i);
            i += 1;
        } else if (arg.startsWith('--max-delta=')) {
            options.maxDelta = requireEqualsValue(arg, '--max-delta=');
        } else if (arg === '--prior-weight') {
            options.priorWeight = requireValue(arg, i);
            i += 1;
        } else if (arg.startsWith('--prior-weight=')) {
            options.priorWeight = requireEqualsValue(arg, '--prior-weight=');
        } else if (arg === '--mapping') {
            options.mappingMethod = requireValue(arg, i);
            i += 1;
        } else if (arg.startsWith('--mapping=')) {
            options.mappingMethod = requireEqualsValue(arg, '--mapping=');
        } else if (arg === '--seed') {
            options.seed = requireValue(arg, i);
            i += 1;
        } else if (arg.startsWith('--seed=')) {
            options.seed = requireEqualsValue(arg, '--seed=');
        } else if (arg === '--concurrency') {
            options.concurrency = requireValue(arg, i);
            i += 1;
        } else if (arg.startsWith('--concurrency=')) {
            options.concurrency = requireEqualsValue(arg, '--concurrency=');
        } else if (arg === '--max-tokens') {
            options.maxTokens = requireValue(arg, i);
            i += 1;
        } else if (arg.startsWith('--max-tokens=')) {
            options.maxTokens = requireEqualsValue(arg, '--max-tokens=');
        } else {
            throw new Error(`Unknown CLI argument: ${arg}`);
        }
    }

    if (options.help) return options;

    if (options.date !== null && !isValidCalendarDate(options.date)) {
        throw new Error(`--date must be a valid calendar date YYYY-MM-DD, received: ${options.date}`);
    }
    if (options.conferenceProcess !== null) {
        const trimmed = options.conferenceProcess.trim().toLowerCase();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(trimmed)) {
            throw new Error(`--conference-process must be a valid UUID v4, received: ${options.conferenceProcess}`);
        }
        options.conferenceProcess = trimmed;
        if (options.input || options.date) {
            throw new Error('--conference-process cannot be combined with --input or --date');
        }
    }
    options.rounds = validateSwissRounds(options.rounds);
    options.maxDelta = validateMaxDelta(options.maxDelta);
    options.priorWeight = validatePriorWeight(options.priorWeight);
    if (!MAPPING_METHODS.includes(options.mappingMethod)) {
        throw new RangeError(`--mapping must be one of ${MAPPING_METHODS.join(', ')}, received: ${options.mappingMethod}`);
    }
    options.concurrency = parseStrictCliInt(options.concurrency, '--concurrency', 1, MAX_LIVE_CONCURRENCY);
    options.maxTokens = parseStrictCliInt(options.maxTokens, '--max-tokens', MIN_LIVE_MAX_TOKENS, MAX_LIVE_MAX_TOKENS);

    const activeModes = [
        options.dryRun ? '--dry-run' : null,
        options.replaySpecified ? '--replay' : null,
        options.live ? '--live' : null
    ].filter(Boolean);

    if (activeModes.length === 0) {
        throw new Error(
            'Explicit mode required: specify one of --dry-run, --replay <comparisons.json>, or --live (live LLM calls are opt-in only).'
        );
    }
    if (activeModes.length > 1) {
        throw new Error(`Modes are mutually exclusive, received: ${activeModes.join(' and ')}`);
    }

    return options;
}

function resolveInputPath(options, paths = {}) {
    if (options.input) {
        return path.resolve(options.input);
    }
    const currentPath = paths.currentPath || Config.FILES.deepAnalysisResult;
    const archiveDir = paths.archiveDir || Config.ARCHIVE_DIR;
    if (options.date) {
        const archivePath = path.join(archiveDir, options.date, 'deep-analysis-result.json');
        let currentBatchDate = null;
        if (fs.existsSync(currentPath)) {
            try {
                const currentData = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
                currentBatchDate = typeof currentData?.batchDate === 'string' ? currentData.batchDate : null;
                if (currentBatchDate === options.date) {
                    return path.resolve(currentPath);
                }
            } catch (_) {
                // Fall through to archive check if current is unreadable.
            }
        }
        if (fs.existsSync(archivePath)) {
            return path.resolve(archivePath);
        }
        throw new Error(
            `No deep-analysis-result.json found matching --date ${options.date} `
            + `(current batchDate=${currentBatchDate || 'none'}, archive missing: ${archivePath}). `
            + 'Pass --input explicitly to override.'
        );
    }
    return path.resolve(currentPath);
}

function resolveDefaultOutputPath(batchDate, { conferenceProcessId = null, dataDir = Config.DATA_DIR } = {}) {
    if (conferenceProcessId) {
        return path.join(dataDir, 'runtime', 'score-calibrations', 'conference', conferenceProcessId, 'score-calibration-v1.json');
    }
    const safeBucket = isValidCalendarDate(batchDate) ? batchDate : 'undated';
    return path.join(dataDir, 'runtime', 'score-calibrations', safeBucket, 'score-calibration-v1.json');
}

function readConferenceProcessBatch(processId, paths = {}) {
    const processRoot = path.resolve(paths.conferenceProcessDir || Config.FILES.conferenceProcessDir);
    const analysisRoot = path.resolve(paths.conferenceAnalysisDir || Config.FILES.conferenceAnalysisDir);
    const stateFile = path.join(processRoot, processId, 'state.json');
    if (!fs.existsSync(stateFile)) {
        throw new Error(`Conference process state file not found: ${stateFile}`);
    }
    const stateBytes = fs.readFileSync(stateFile);
    const stateSha256 = sha256Hex(stateBytes);
    const state = JSON.parse(stateBytes.toString('utf8'));
    if (!state || typeof state !== 'object' || !state.items || typeof state.items !== 'object' || Array.isArray(state.items)) {
        throw new Error(`Conference process state file has invalid items map: ${stateFile}`);
    }
    const papers = [];
    const constituentFiles = [];
    const paperIds = Object.keys(state.items).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const paperId of paperIds) {
        const item = state.items[paperId];
        if (!item || item.status !== 'complete' || typeof item.analysisRunId !== 'string' || !item.analysisRunId.trim()) {
            continue;
        }
        const runId = item.analysisRunId.trim();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
            continue;
        }
        const analysisFile = path.join(analysisRoot, runId, 'analysis.json');
        if (!fs.existsSync(analysisFile)) {
            throw new Error(`Completed conference paper ${paperId} is missing analysis file: ${analysisFile}`);
        }
        const rawBytes = fs.readFileSync(analysisFile);
        const fileSha256 = sha256Hex(rawBytes);
        const parsedAnalysis = JSON.parse(rawBytes.toString('utf8'));
        if (parsedAnalysis?.status !== 'complete' || !Array.isArray(parsedAnalysis.papers) || !parsedAnalysis.papers.length) {
            continue;
        }
        const paper = parsedAnalysis.papers[0];
        papers.push(paper);
        constituentFiles.push({
            paperId,
            analysisRunId: runId,
            analysisFileSha256: fileSha256
        });
    }
    if (!papers.length) {
        throw new Error(`Conference process ${processId} contains zero completed analysis.json papers`);
    }
    const conferenceId = typeof state.authority?.conferenceId === 'string' ? state.authority.conferenceId : null;
    const completedDates = papers
        .map(p => (typeof p?.analyzedAt === 'string' ? p.analyzedAt.slice(0, 10) : null))
        .filter(d => d && isValidCalendarDate(d))
        .sort();
    const batchDate = completedDates.at(-1)
        || (typeof state.updatedAt === 'string' && isValidCalendarDate(state.updatedAt.slice(0, 10)) ? state.updatedAt.slice(0, 10) : null);
    const sourceFileSha256 = stableJsonSha256({
        processId,
        conferenceId,
        stateSha256,
        constituentFiles
    });
    return {
        inputPath: stateFile,
        sourceFileSha256,
        constituentFiles,
        parsed: {
            batchDate,
            batchId: conferenceId || processId,
            conferenceId,
            processId,
            papers
        }
    };
}

function resolveCanonicalPathWithMissingTail(targetPath) {
    const resolved = path.resolve(targetPath);
    const tailSegments = [];
    let cursor = resolved;
    while (!fs.existsSync(cursor)) {
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        tailSegments.unshift(path.basename(cursor));
        cursor = parent;
    }
    const realBase = fs.existsSync(cursor) ? fs.realpathSync.native(cursor) : cursor;
    return tailSegments.length > 0 ? path.join(realBase, ...tailSegments) : realBase;
}

function assertSafeOutputPath(inputPath, outputPath) {
    if (typeof outputPath !== 'string' || !outputPath.trim()) {
        throw new Error('Output path must be a non-empty file path.');
    }
    const resolvedInput = path.resolve(inputPath);
    const resolvedOutput = path.resolve(outputPath.trim());

    let outLstat = null;
    try {
        outLstat = fs.lstatSync(resolvedOutput);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (outLstat) {
        if (outLstat.isSymbolicLink()) {
            throw new Error(
                `Refusing to write calibration sidecar through symbolic link: ${resolvedOutput}`
            );
        }
        if (outLstat.isDirectory()) {
            throw new Error(
                `Refusing to write calibration sidecar to directory path: ${resolvedOutput}`
            );
        }
    }

    const realInput = fs.existsSync(resolvedInput)
        ? fs.realpathSync.native(resolvedInput)
        : resolveCanonicalPathWithMissingTail(resolvedInput);
    const canonicalOutput = resolveCanonicalPathWithMissingTail(resolvedOutput);

    if (path.basename(resolvedOutput).toLowerCase() === 'deep-analysis-result.json'
        || path.basename(canonicalOutput).toLowerCase() === 'deep-analysis-result.json') {
        throw new Error(
            'Refusing to write to deep-analysis-result.json; calibration output must be a separate sidecar (e.g. score-calibration-v1.json).'
        );
    }

    const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32';
    const normalizePathForCompare = p => (caseInsensitive ? p.toLowerCase() : p);
    if (normalizePathForCompare(resolvedInput) === normalizePathForCompare(resolvedOutput)
        || normalizePathForCompare(realInput) === normalizePathForCompare(canonicalOutput)) {
        throw new Error(
            'Refusing to write calibration sidecar over sealed input file; --output must be a distinct sidecar path.'
        );
    }

    if (outLstat && fs.existsSync(resolvedInput)) {
        const inStat = fs.statSync(resolvedInput);
        const outStat = fs.statSync(resolvedOutput);
        if (inStat.dev === outStat.dev && inStat.ino === outStat.ino) {
            throw new Error(
                'Refusing to write calibration sidecar over hardlink to sealed input file; --output must be a distinct file.'
            );
        }
    }

    return resolvedOutput;
}

function readSealedBatchFile(inputPath) {
    if (!fs.existsSync(inputPath)) {
        throw new Error(`Sealed batch input file not found: ${inputPath}`);
    }
    const stat = fs.lstatSync(inputPath);
    if (!stat.isFile()) {
        throw new Error(`Sealed batch input path is not a regular file: ${inputPath}`);
    }
    const rawBytes = fs.readFileSync(inputPath);
    const sourceFileSha256 = sha256Hex(rawBytes);
    let parsed;
    try {
        parsed = JSON.parse(rawBytes.toString('utf8'));
    } catch (error) {
        throw new Error(`Failed to parse input JSON (${inputPath}): ${error.message}`);
    }
    return { parsed, sourceFileSha256 };
}

function loadReplayComparisons(replayPath) {
    const resolvedReplay = path.resolve(replayPath);
    if (!fs.existsSync(resolvedReplay)) {
        throw new Error(`Replay comparisons file not found: ${resolvedReplay}`);
    }
    const stat = fs.lstatSync(resolvedReplay);
    if (!stat.isFile()) {
        throw new Error(`Replay comparisons path must be a regular file (not symlink or directory): ${resolvedReplay}`);
    }
    const rawBytes = fs.readFileSync(resolvedReplay);
    const replayFileSha256 = sha256Hex(rawBytes);
    let parsed;
    try {
        parsed = JSON.parse(rawBytes.toString('utf8'));
    } catch (error) {
        throw new Error(`Failed to parse replay comparisons JSON (${resolvedReplay}): ${error.message}`);
    }

    if (Array.isArray(parsed)) {
        return { comparisons: parsed, replayFileSha256, replayMetadata: null };
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.comparisons)) {
        return {
            comparisons: parsed.comparisons,
            replayFileSha256,
            replayMetadata: {
                contract: parsed.contract || null,
                rounds: parsed.config?.rounds ?? parsed.rounds?.length ?? null,
                seed: parsed.config?.seed ?? null,
                bidirectional: typeof parsed.config?.bidirectional === 'boolean'
                    ? parsed.config.bidirectional
                    : null
            }
        };
    }
    throw new Error(
        `Replay file (${resolvedReplay}) must be a JSON array of comparisons or an object with a "comparisons" array.`
    );
}

async function runWithConcurrency(tasks, concurrency) {
    if (tasks.length === 0) return [];
    const results = new Array(tasks.length);
    let nextIndex = 0;
    let aborted = false;
    let firstError = null;

    async function worker() {
        while (true) {
            if (aborted) return;
            const current = nextIndex;
            nextIndex += 1;
            if (current >= tasks.length) return;
            try {
                results[current] = await tasks[current](current);
            } catch (error) {
                aborted = true;
                if (!firstError) firstError = error;
                return;
            }
        }
    }

    const workerCount = Math.max(1, Math.min(concurrency, tasks.length));
    await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
    if (firstError) throw firstError;
    return results;
}

function resolveLiveLlmConfig(env = process.env) {
    const endpoint = String(env.PAPER_ANALYZER_ENDPOINT || '').trim();
    const apiKey = String(env.PAPER_ANALYZER_API_KEY || '').trim();
    const model = String(env.PAPER_ANALYZER_MODEL || '').trim();
    const apiKeys = resolvePrimaryApiKeyPool(
        apiKey,
        env.PAPER_ANALYZER_FALLBACK_API_KEYS || '',
        env.PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY || ''
    );
    const missing = [];
    if (!endpoint) missing.push('PAPER_ANALYZER_ENDPOINT');
    if (!apiKey) missing.push('PAPER_ANALYZER_API_KEY');
    if (!model) missing.push('PAPER_ANALYZER_MODEL');
    if (missing.length > 0) {
        throw new Error(`Missing required LLM configuration for --live calibration: ${missing.join(', ')}`);
    }
    return { endpoint, apiKey, apiKeys, model };
}

async function invokeSinglePairwiseEvaluation(paperPresentedA, paperPresentedB, llmConfig, options = {}) {
    const requestFn = typeof options.requestFn === 'function' ? options.requestFn : utils.requestLlmJson;
    const { endpoint, apiKey, apiKeys, model } = llmConfig;
    const apiType = utils.detectApiType(endpoint, model);
    const apiUrl = utils.buildApiUrl(apiType, endpoint);
    const effectiveMaxTokens = options.maxTokens ?? DEFAULT_LIVE_MAX_TOKENS;

    const prompt = buildPairwiseComparisonPrompt(paperPresentedA, paperPresentedB);
    const promptCacheKey = `score-calibration-v1:${sha256Hex(prompt.systemPrompt).slice(0, 16)}`;
    const body = utils.buildRequestBody(
        apiType,
        model,
        prompt.messages,
        effectiveMaxTokens,
        options.temperature ?? DEFAULT_LIVE_TEMPERATURE,
        {
            stage: 'scoreCalibration',
            promptCacheKey,
            usageContext: {
                runId: options.runId,
                paperId: paperPresentedA.paperId,
                stage: 'scoreCalibration'
            }
        }
    );
    const bodyStr = JSON.stringify(body);
    const headers = utils.buildHeaders(apiType, apiKey, bodyStr);

    const response = await requestFn(
        apiUrl,
        endpoint,
        model,
        body,
        headers,
        {
            timeoutMs: options.timeoutMs || DEFAULT_LIVE_TIMEOUT_MS,
            apiKeys,
            accountPoolStateFile: Config.FILES.llmAccountPoolState,
            affinityKey: paperPresentedA.paperId,
            usageContext: {
                runId: options.runId,
                paperId: paperPresentedA.paperId,
                stage: 'scoreCalibration'
            }
        }
    );

    if (!response || response.statusCode < 200 || response.statusCode >= 300) {
        const status = response?.statusCode ?? 'unknown';
        throw new Error(
            `Pairwise LLM request failed (HTTP ${status}) for ${paperPresentedA.paperId} vs ${paperPresentedB.paperId}`
        );
    }

    if (apiType === 'openai_responses') {
        const truncationError = utils.getResponsesOutputTruncationError(response.body, effectiveMaxTokens);
        if (truncationError) {
            throw truncationError;
        }
    } else if (Array.isArray(response.body?.choices)
        && response.body.choices.some(choice => choice?.finish_reason === 'length')) {
        const error = new Error(
            `OpenAI Chat pairwise output truncated at finish_reason=length (max_tokens=${effectiveMaxTokens}) `
            + `for ${paperPresentedA.paperId} vs ${paperPresentedB.paperId}`
        );
        error.code = 'MODEL_OUTPUT_TRUNCATED';
        error.maxOutputTokens = effectiveMaxTokens;
        throw error;
    } else if (response.body?.stop_reason === 'max_tokens') {
        const error = new Error(
            `Anthropic pairwise output truncated at stop_reason=max_tokens (max_tokens=${effectiveMaxTokens}) `
            + `for ${paperPresentedA.paperId} vs ${paperPresentedB.paperId}`
        );
        error.code = 'MODEL_OUTPUT_TRUNCATED';
        error.maxOutputTokens = effectiveMaxTokens;
        throw error;
    }

    const rawText = utils.parseResponseText(apiType, response.body);
    const verdict = parsePairwiseComparisonResponse(rawText, {
        label: `pairwise(${paperPresentedA.paperId} vs ${paperPresentedB.paperId})`
    });

    return {
        ...verdict,
        promptSha256: prompt.promptSha256
    };
}

/**
 * Executes an opt-in live Swiss-tournament pairwise comparison run.
 * Updates Bradley-Terry ratings dynamically after each round before pairing the next round.
 */
async function executeLiveSwissTournament(papers, options = {}) {
    const rounds = validateSwissRounds(options.rounds ?? DEFAULT_SWISS_ROUNDS);
    const seed = options.seed || DEFAULT_SEED;
    const bidirectional = options.bidirectional !== false;
    const priorWeight = validatePriorWeight(options.priorWeight ?? DEFAULT_PRIOR_WEIGHT);
    const concurrency = options.concurrency || DEFAULT_LIVE_CONCURRENCY;

    const llmConfig = options.llmConfig || resolveLiveLlmConfig(process.env);
    const runId = options.runId || crypto.randomUUID();

    const paperById = new Map(papers.map(p => [p.paperId, p]));
    const itemIds = papers.map(p => p.paperId);
    const currentRatings = new Map(papers.map(p => [p.paperId, p.rawScore]));

    const pairCounts = new Map();
    const byeCounts = new Map();
    const roundSummaries = [];
    const resolvedComparisons = [];

    for (let round = 1; round <= rounds; round += 1) {
        const ratedItems = itemIds.map(id => ({
            id,
            rating: currentRatings.get(id)
        }));
        const roundPlan = planSwissRoundPairs(ratedItems, {
            round,
            seed,
            bidirectional,
            previousPairs: pairCounts,
            previousByes: byeCounts
        });

        const evalTasks = [];
        for (const pair of roundPlan.pairs) {
            for (const evaluation of pair.evaluations) {
                evalTasks.push(async () => {
                    const presentedA = paperById.get(evaluation.presentedA);
                    const presentedB = paperById.get(evaluation.presentedB);
                    const result = await invokeSinglePairwiseEvaluation(presentedA, presentedB, llmConfig, {
                        requestFn: options.requestFn,
                        runId,
                        maxTokens: options.maxTokens,
                        temperature: options.temperature,
                        timeoutMs: options.timeoutMs
                    });
                    return {
                        pairKey: pair.pairKey,
                        direction: evaluation.direction,
                        result
                    };
                });
            }
        }

        const evalOutputs = await runWithConcurrency(evalTasks, concurrency);
        const byPair = new Map();
        for (const out of evalOutputs) {
            if (!byPair.has(out.pairKey)) byPair.set(out.pairKey, {});
            byPair.get(out.pairKey)[out.direction] = out.result;
        }

        for (const pair of roundPlan.pairs) {
            const pairResults = byPair.get(pair.pairKey) || {};
            // In unidirectional mode, evaluations[0] may have randomized (presentedA, presentedB) order
            // to eliminate primacy bias; align paperA/paperB to the presented orientation before resolving.
            const forwardEval = pair.evaluations[0];
            const resolved = resolvePositionSwappedComparison({
                paperA: bidirectional ? pair.paperA : forwardEval.presentedA,
                paperB: bidirectional ? pair.paperB : forwardEval.presentedB,
                forward: pairResults.forward,
                reverse: bidirectional ? pairResults.reverse : null,
                round
            });
            resolvedComparisons.push(resolved);
            pairCounts.set(pair.pairKey, (pairCounts.get(pair.pairKey) || 0) + 1);
        }

        if (roundPlan.bye) {
            byeCounts.set(roundPlan.bye, (byeCounts.get(roundPlan.bye) || 0) + 1);
        }

        roundSummaries.push({
            round: roundPlan.round,
            pairCount: roundPlan.pairs.length,
            bye: roundPlan.bye,
            repeatedPairsCount: roundPlan.repeatedPairsCount,
            evaluationsExecuted: evalOutputs.length
        });

        // Update current Swiss standings using Bradley-Terry log-strengths from completed rounds.
        if (round < rounds && resolvedComparisons.length > 0) {
            const interimBt = fitBradleyTerryRatings(itemIds, resolvedComparisons, { priorWeight });
            for (const id of itemIds) {
                currentRatings.set(id, interimBt.logStrengths[id]);
            }
        }
    }

    return {
        runId,
        roundSummaries,
        resolvedComparisons
    };
}

function formatHumanSummary(sidecar) {
    const lines = [
        `=== ${SCORE_CALIBRATION_CONTRACT} (${sidecar.mode}) ===`,
        `Batch Date: ${sidecar.batchDate || '(unspecified)'} | Papers: ${sidecar.diagnostics?.paperCount ?? sidecar.schedule?.participantCount ?? 0}`,
        `Source File: ${sidecar.sourceFile} (sha256: ${String(sidecar.sourceFileSha256 || '').slice(0, 12)}...)`
    ];

    if (sidecar.mode === 'dry_run') {
        const s = sidecar.schedule;
        lines.push(
            `Swiss Plan: ${s.rounds} rounds | ${s.totalPairs} pairs (${s.uniquePairsPlanned} unique, ${s.totalRepeatedPairs} repeats) | bidirectional=${s.bidirectional}`,
            `Estimated API Calls: ${s.estimatedApiCalls} (vs ${s.fullRoundRobinCalls} full round-robin, savings: ${s.savingsPct}%)`,
            'Dry-run completed with 0 LLM requests.'
        );
        return lines.join('\n');
    }

    const d = sidecar.diagnostics;
    const sc = d.scoreSummary;
    const tc = d.tieClusterStats;
    const consistencyStr = d.positionConsistencyRate === null
        ? 'n/a (unidirectional)'
        : `${(d.positionConsistencyRate * 100).toFixed(1)}% (${d.positionBiasSummary.consistentCount}/${d.positionBiasSummary.bidirectionalCount})`;
    lines.push(
        `BT Solver: converged=${sidecar.solver.converged} in ${sidecar.solver.iterations} iters (maxDelta=${sidecar.solver.maxDelta.toExponential(2)})`,
        `Scores: rawMean=${sc.rawMean.toFixed(2)} -> calMean=${sc.calibratedMean.toFixed(2)} | maxObservedDelta=${sc.maxObservedDelta.toFixed(2)} (cap ±${sidecar.config.maxDelta}) | capped=${sc.cappedCount}`,
        `Diagnostics: kendallTau=${d.kendallTau === null ? 'n/a' : d.kendallTau.toFixed(4)} | positionConsistency=${consistencyStr} | tiesBroken=${tc.brokenTiesCount}/${tc.totalRawTiedPairs}`,
        `Hashes: input=${sidecar.inputSha256.slice(0, 12)} comparisons=${sidecar.comparisonsSha256.slice(0, 12)} calibration=${sidecar.calibrationSha256.slice(0, 12)}`
    );
    if (Array.isArray(sidecar.papers) && sidecar.papers.length > 0) {
        lines.push('', 'Top Ranked Papers (Calibrated):');
        for (const p of sidecar.papers.slice(0, 10)) {
            lines.push(
                `  #${p.calibratedRank} ${p.paperId}  raw=${p.rawScore.toFixed(1)} -> cal=${p.calibratedScore.toFixed(2)}  ${p.badge}  bt=${p.btLogStrength.toFixed(3)}`
            );
        }
    }
    return lines.join('\n');
}

/**
 * Programmatic entry point for CLI execution (supports dependency injection for tests).
 */
async function runCalibrationCli(argv = process.argv.slice(2), deps = {}) {
    const options = parseCliArgs(argv);
    if (options.help) {
        return { help: true, usage: formatUsage(), sidecar: null, outputPath: null };
    }

    let inputPath;
    let rawBatch;
    let sourceFileSha256;
    if (options.conferenceProcess) {
        const loaded = readConferenceProcessBatch(options.conferenceProcess, deps.paths);
        inputPath = loaded.inputPath;
        rawBatch = loaded.parsed;
        sourceFileSha256 = loaded.sourceFileSha256;
    } else {
        inputPath = resolveInputPath(options, deps.paths);
        ({ parsed: rawBatch, sourceFileSha256 } = readSealedBatchFile(inputPath));
    }
    const batchDate = options.date || (typeof rawBatch?.batchDate === 'string' ? rawBatch.batchDate : null);
    const batchId = typeof rawBatch?.batchId === 'string' ? rawBatch.batchId : null;
    const seed = options.seed || (options.conferenceProcess
        ? `${DEFAULT_SEED}:conference:${options.conferenceProcess}`
        : (batchDate ? `${DEFAULT_SEED}:${batchDate}` : DEFAULT_SEED));

    const { papers, excludedPapers } = extractCalibratablePapers(rawBatch);

    // 1. DRY-RUN MODE: strictly offline, 0 LLM requests!
    if (options.dryRun) {
        const outputPath = options.output ? assertSafeOutputPath(inputPath, options.output) : null;
        const ratedItems = papers.map(p => ({ id: p.paperId, rating: p.rawScore }));
        const schedule = planSwissTournamentSchedule(ratedItems, {
            rounds: options.rounds,
            seed,
            bidirectional: options.bidirectional
        });
        const inputSha256 = stableJsonSha256(
            papers.slice().sort((a, b) => (a.paperId < b.paperId ? -1 : 1)).map(p => ({
                paperId: p.paperId,
                rawScore: p.rawScore,
                sourceSha256: p.sourceSha256,
                title: p.title
            }))
        );
        const coreDryRun = {
            contract: SCORE_CALIBRATION_CONTRACT,
            mode: 'dry_run',
            batchDate,
            batchId,
            sourceFile: inputPath,
            sourceFileSha256,
            inputSha256,
            readOnlyInvariant: {
                mutatedSealedInput: false,
                overwroteScoringAudit: false,
                llmRequestsSent: 0
            },
            config: {
                rounds: options.rounds,
                bidirectional: options.bidirectional,
                seed,
                priorWeight: options.priorWeight,
                maxDelta: options.maxDelta,
                mappingMethod: options.mappingMethod
            },
            excludedPaperCount: excludedPapers.length,
            excludedPapers,
            schedule
        };
        const sidecar = {
            ...coreDryRun,
            planSha256: stableJsonSha256(coreDryRun)
        };

        if (outputPath) {
            utils.writeFileAtomic(outputPath, `${JSON.stringify(sidecar, null, 2)}\n`);
        }
        return { help: false, sidecar, outputPath, options };
    }

    // Validate output path BEFORE replay or any paid --live LLM requests!
    const targetOutput = options.output || resolveDefaultOutputPath(batchDate, {
        conferenceProcessId: options.conferenceProcess,
        dataDir: deps.paths?.dataDir || Config.DATA_DIR
    });
    const outputPath = assertSafeOutputPath(inputPath, targetOutput);

    // 2. REPLAY MODE: strictly offline deterministic recomputation, 0 LLM requests!
    if (options.replaySpecified) {
        const { comparisons, replayFileSha256, replayMetadata } = loadReplayComparisons(options.replay);
        const effectiveBidirectional = options.bidirectionalExplicit
            ? options.bidirectional
            : (replayMetadata?.bidirectional ?? options.bidirectional);
        const effectiveRounds = options.roundsExplicit
            ? options.rounds
            : (replayMetadata?.rounds ?? options.rounds);
        const calibrated = calibrateBatchScores(rawBatch, comparisons, {
            rounds: effectiveRounds,
            seed: options.seed || replayMetadata?.seed || seed,
            bidirectional: effectiveBidirectional,
            priorWeight: options.priorWeight,
            maxDelta: options.maxDelta,
            mappingMethod: options.mappingMethod
        });
        const sidecar = {
            ...calibrated,
            mode: 'replay',
            batchDate,
            batchId,
            sourceFile: inputPath,
            sourceFileSha256,
            replaySourceFile: path.resolve(options.replay),
            replayFileSha256,
            readOnlyInvariant: {
                ...calibrated.readOnlyInvariant,
                llmRequestsSent: 0
            }
        };

        utils.writeFileAtomic(outputPath, `${JSON.stringify(sidecar, null, 2)}\n`);
        return { help: false, sidecar, outputPath, options };
    }

    // 3. LIVE MODE: explicit opt-in via `--live` only!
    if (!deps.skipEnvLoad) {
        utils.loadEnvFile();
    }
    const liveRun = await executeLiveSwissTournament(papers, {
        rounds: options.rounds,
        seed,
        bidirectional: options.bidirectional,
        priorWeight: options.priorWeight,
        concurrency: options.concurrency,
        maxTokens: options.maxTokens,
        llmConfig: deps.llmConfig,
        requestFn: deps.requestFn,
        runId: deps.runId
    });
    const llmRequestsSent = liveRun.roundSummaries.reduce((sum, r) => sum + (r.evaluationsExecuted || 0), 0);
    const calibrated = calibrateBatchScores(rawBatch, liveRun.resolvedComparisons, {
        rounds: options.rounds,
        seed,
        bidirectional: options.bidirectional,
        priorWeight: options.priorWeight,
        maxDelta: options.maxDelta,
        mappingMethod: options.mappingMethod
    });
    const sidecar = {
        ...calibrated,
        mode: 'live',
        runId: liveRun.runId,
        batchDate,
        batchId,
        sourceFile: inputPath,
        sourceFileSha256,
        readOnlyInvariant: {
            ...calibrated.readOnlyInvariant,
            llmRequestsSent
        },
        rounds: liveRun.roundSummaries,
        generatedAt: utils.getBeijingISOString()
    };

    utils.writeFileAtomic(outputPath, `${JSON.stringify(sidecar, null, 2)}\n`);
    return { help: false, sidecar, outputPath, options };
}

async function main(argv = process.argv.slice(2)) {
    requireExternalRuntime('calibrate-batch-scores.js');
    const result = await runCalibrationCli(argv);
    if (result.help) {
        console.log(result.usage);
        return;
    }
    if (result.options.json) {
        console.log(JSON.stringify(result.sidecar, null, 2));
    } else {
        console.log(formatHumanSummary(result.sidecar));
        if (result.outputPath) {
            console.log(`\nSaved sidecar: ${result.outputPath}`);
        }
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(`[calibrate-batch-scores] Error: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    DEFAULT_LIVE_MAX_TOKENS,
    parseCliArgs,
    resolveInputPath,
    resolveDefaultOutputPath,
    readConferenceProcessBatch,
    assertSafeOutputPath,
    readSealedBatchFile,
    loadReplayComparisons,
    runWithConcurrency,
    invokeSinglePairwiseEvaluation,
    executeLiveSwissTournament,
    runCalibrationCli,
    formatHumanSummary,
    formatUsage
};
