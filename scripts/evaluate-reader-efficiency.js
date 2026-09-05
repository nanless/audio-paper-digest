#!/usr/bin/env node
'use strict';

// Explicit, isolated experiment. This runner never calls refresh, generate,
// review, push, fetch, or image download workflows.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const VERSION = 'reader-efficiency-evaluation-v1';
const BUDGETS = Object.freeze({ logicalRequests: 3, transportAttemptsPerRequest: 1,
    fullOutputTokens: 24000, patchOutputTokens: 8000 });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const normalizeId = value => String(value || '').replace(/v\d+$/, '');
const stableHash = value => {
    const normalize = item => Array.isArray(item) ? item.map(normalize)
        : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])])) : item;
    return sha(JSON.stringify(normalize(value)));
};

function parseArgs(argv) {
    const names = { '--paper': 'paperId', '--source-text': 'sourceTextPath', '--artifacts': 'artifactsPath',
        '--paper-snapshot': 'snapshotPath', '--output-dir': 'outputDir' };
    const options = { live: false };
    const seen = new Set();
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}`);
        seen.add(arg);
        if (arg === '--live') { options.live = true; continue; }
        if (!names[arg] || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Invalid or incomplete option: ${arg}`);
        options[names[arg]] = argv[++index];
    }
    for (const name of Object.values(names)) if (!options[name]) throw new Error(`Required option missing: ${name}`);
    if (!/^\d{4}\.\d{4,5}(?:v\d+)?$/.test(options.paperId)) throw new Error('Invalid arXiv paper ID');
    options.paperId = normalizeId(options.paperId);
    for (const name of ['sourceTextPath', 'artifactsPath', 'snapshotPath', 'outputDir']) options[name] = path.resolve(options[name]);
    return options;
}

function readRegular(filename) {
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error(`Input must be a bounded regular file: ${filename}`);
        return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
}

function loadInputs(options) {
    const sourceBytes = readRegular(options.sourceTextPath);
    const artifactBytes = readRegular(options.artifactsPath);
    const snapshotBytes = readRegular(options.snapshotPath);
    const sourceText = sourceBytes.toString('utf8');
    const artifacts = JSON.parse(artifactBytes.toString('utf8'));
    const paper = JSON.parse(snapshotBytes.toString('utf8'));
    if (!paper || typeof paper !== 'object' || Array.isArray(paper)
        || normalizeId(paper.arxivId || paper.paper_id || paper.id) !== options.paperId) throw new Error('Snapshot paper ID mismatch');
    const sourceSha256 = sha(sourceBytes);
    if (!sourceText || paper.sourceSha256 !== sourceSha256
        || (paper.analysisManifest?.sourceAcquisition?.sourceSha256
            && paper.analysisManifest.sourceAcquisition.sourceSha256 !== sourceSha256)) {
        throw new Error('Source text SHA does not replay the paper snapshot');
    }
    if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)
        || !Array.isArray(artifacts.tables) || !Array.isArray(artifacts.formulas)
        || !/^[a-f0-9]{64}$/.test(String(artifacts.payloadSha256 || ''))) {
        throw new Error('A complete production structured artifact with payloadSha256 is required; a summary cannot be re-signed');
    }
    const { payloadSha256, ...body } = artifacts;
    if (sha(JSON.stringify(body)) !== payloadSha256 || artifacts.flattenedTextSha256 !== sourceSha256
        || (artifacts.sourceId && normalizeId(artifacts.sourceId) !== options.paperId)) {
        throw new Error('Structured artifact SHA, source text, or paper identity does not replay');
    }
    const expectedArtifactHashes = [paper.structuredArtifactsSha256,
        paper.analysisManifest?.sourceAcquisition?.structuredArtifactsSha256,
        paper.analysisManifest?.stages?.apiReaderArticle?.structuredArtifactsSha256].filter(Boolean);
    if (!expectedArtifactHashes.length || expectedArtifactHashes.some(value => value !== payloadSha256)) {
        throw new Error('Structured artifact payload differs from the signed paper snapshot');
    }
    if (typeof paper.analysis !== 'string' || !paper.analysis.trim()) throw new Error('Snapshot canonical analysis is missing');
    return { paper, sourceText, artifacts, sourceSha256, artifactSha256: payloadSha256,
        canonicalSha256: sha(paper.analysis), fileHashes: {
            [options.sourceTextPath]: sourceSha256,
            [options.artifactsPath]: sha(artifactBytes), [options.snapshotPath]: sha(snapshotBytes)
        } };
}

function replaySnapshotPlan(paper, artifacts, sourceText) {
    const plan = paper.apiReaderPlan;
    const article = paper.apiReaderArticle;
    if (!plan || typeof article !== 'string' || paper.apiReaderArticleSha256 !== sha(article)
        || paper.apiReaderPlanSha256 !== stableHash(plan)) throw new Error('Snapshot Reader article/plan SHA mismatch');
    const stage = paper.analysisManifest?.stages?.apiReaderArticle;
    if (stage?.articleSha256 && stage.articleSha256 !== sha(article)) throw new Error('Snapshot Reader stage article SHA mismatch');
    if (stage?.planSha256 && stage.planSha256 !== stableHash(plan)) throw new Error('Snapshot Reader stage plan SHA mismatch');
    for (const binding of plan.formulaBindings || []) {
        const formula = artifacts.formulas.find(item => item.ordinal === binding.formulaOrdinal);
        if (!formula || formula.sourceDomSha256 !== binding.sourceDomSha256 || String(formula.latex).trim() !== binding.latex) {
            throw new Error('Snapshot formula binding does not replay its structured source');
        }
    }
    for (const binding of plan.tableBindings || []) {
        if (binding.sourceType === 'artifact_table') {
            const table = artifacts.tables.find(item => item.ordinal === binding.sourceTableOrdinal);
            if (!table || table.sourceDomSha256 !== binding.sourceTableDomSha256) throw new Error('Snapshot table DOM identity mismatch');
        } else if (binding.sourceType === 'source_quotes') {
            if (!Array.isArray(binding.sourceQuotes) || !binding.sourceQuotes.length
                || binding.sourceQuotes.some(item => typeof item.quote !== 'string' || !sourceText.includes(item.quote)
                    || sha(item.quote) !== item.sourceQuoteSha256)) throw new Error('Snapshot table source quote does not replay');
        } else throw new Error('Unsupported snapshot table binding');
    }
    return { status: 'replayed', scope: 'article/plan hashes, original formula identity, table DOM identity and exact source quotes; not semantic review',
        articleSha256: sha(article), planSha256: stableHash(plan),
        sections: plan.sections?.length || 0, tables: plan.tableBindings?.length || 0,
        formulas: plan.formulaBindings?.length || 0, figures: plan.figurePlacements?.length || 0,
        chineseCharacters: (article.match(/[\u3400-\u9fff]/g) || []).length };
}

function snapshotFigures(paper) {
    if (!Array.isArray(paper.apiReaderFigures)) throw new Error('Snapshot figure inventory is missing');
    return paper.apiReaderFigures.map(figure => {
        if (!Number.isInteger(figure.ordinal) || typeof figure.cachePath !== 'string'
            || !/^[a-f0-9]{64}$/.test(String(figure.assetSha256 || ''))) throw new Error('Snapshot figure identity/cache path is incomplete');
        const bytes = readRegular(figure.cachePath);
        if (sha(bytes) !== figure.assetSha256) throw new Error(`Cached figure ${figure.ordinal} SHA mismatch`);
        return { ...figure, cachePath: path.resolve(figure.cachePath) };
    });
}

function safeOutputDirectory(directory, inputPaths, currentDir) {
    const absolute = path.resolve(directory);
    if (absolute === currentDir || absolute.startsWith(`${currentDir}${path.sep}`)) throw new Error('Evaluation output must be outside data/current');
    if (inputPaths.some(filename => filename === absolute || filename.startsWith(`${absolute}${path.sep}`))) {
        throw new Error('Evaluation output must not contain an input artifact');
    }
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        if (!fs.existsSync(cursor)) fs.mkdirSync(cursor, { mode: 0o700 });
        const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe evaluation output directory');
    }
    if (fs.readdirSync(absolute).length) throw new Error('Use a fresh empty evaluation output directory');
    fs.chmodSync(absolute, 0o700);
    return absolute;
}

function writeArtifact(directory, filename, content) {
    const output = path.join(directory, filename);
    const fd = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    return output;
}

function hashExisting(filename) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        if (!fs.fstatSync(fd).isFile()) throw new Error(`Integrity target is not a regular file: ${filename}`);
        const digest = crypto.createHash('sha256');
        const chunk = Buffer.allocUnsafe(256 * 1024);
        let bytes;
        while ((bytes = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) digest.update(chunk.subarray(0, bytes));
        return digest.digest('hex');
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}

async function evaluate(options) {
    require('./env-loader.js').requireExternalRuntime('evaluate-reader-efficiency');
    const Config = require('./config.js');
    const outputDir = safeOutputDirectory(options.outputDir,
        [options.sourceTextPath, options.artifactsPath, options.snapshotPath], Config.CURRENT_DIR);
    const watchedFiles = [options.sourceTextPath, options.artifactsPath, options.snapshotPath,
        Config.FILES.deepAnalysisResult, Config.FILES.papers];
    const before = Object.fromEntries(watchedFiles.map(filename => [filename, hashExisting(filename)]));
    const report = { version: VERSION, mode: options.live ? 'live' : 'offline', paperId: options.paperId,
        startedAt: new Date().toISOString(),
        status: 'running', budgets: BUDGETS, calls: [], outputs: {}, usage: { status: 'not_requested' },
        scope: 'Isolated Reader evaluation. No canonical mutation or publication.' };
    let failure = null;
    try {
        const inputs = loadInputs(options);
        const implementationFiles = ['scripts/evaluate-reader-efficiency.js', 'scripts/deep-analyzer.js',
            'scripts/config.js', 'scripts/utils.js', 'scripts/lib/llm-usage.js',
            'scripts/lib/reader-contract.js', 'scripts/lib/reader-tables.js', 'scripts/lib/reader-repair.js',
            'prompts/api-reader-article.md', 'prompts/api-reader-repair.md'];
        report.implementation = Object.fromEntries(implementationFiles.map(filename =>
            [filename, hashExisting(path.resolve(__dirname, '..', filename))]));
        const figures = snapshotFigures(inputs.paper);
        report.source = { sourceSha256: inputs.sourceSha256, artifactsSha256: inputs.artifactSha256,
            canonicalSha256: inputs.canonicalSha256, fileHashes: inputs.fileHashes };
        report.baseline = replaySnapshotPlan(inputs.paper, inputs.artifacts, inputs.sourceText);
        report.cachedFigures = figures.map(figure => ({ ordinal: figure.ordinal, sha256: figure.assetSha256, cachePath: figure.cachePath }));
        if (!options.live) {
            report.status = 'offline_replay_complete';
            return report;
        }
        // Configure the actual runtime before deep-analyzer captures constants.
        // No environment guard or provider routing is bypassed.
        if (require.cache[require.resolve('./deep-analyzer.js')]) throw new Error('Live evaluation requires a fresh process before loading deep-analyzer');
        Config.ANALYSIS_CONFIG.apiReaderMaxTokens = BUDGETS.fullOutputTokens;
        Config.ANALYSIS_CONFIG.apiReaderRepairMaxTokens = BUDGETS.patchOutputTokens;
        Config.ANALYSIS_CONFIG.apiMaxRetries = BUDGETS.transportAttemptsPerRequest;
        const deep = require('./deep-analyzer.js');
        const usage = require('./lib/llm-usage.js');
        const usageDirectory = path.join(outputDir, 'usage');
        const sourceEvidence = deep.buildApiReaderEvidenceContext(inputs.paper.analysis, inputs.sourceText, inputs.artifacts, options.paperId);
        report.evidence = { characters: sourceEvidence.length, sha256: sha(sourceEvidence) };
        const endpoint = new URL(process.env.PAPER_ANALYZER_ENDPOINT);
        report.model = { name: process.env.PAPER_ANALYZER_MODEL || '', endpoint: `${endpoint.origin}${endpoint.pathname}` };
        const result = await deep.generateApiReaderArticleDetailed(structuredClone(inputs.paper), inputs.paper.analysis, sourceEvidence, {
            sourceText: inputs.sourceText, structuredArtifacts: inputs.artifacts,
            readerAttemptsDir: path.join(outputDir, 'candidates'), readerMaxAttempts: BUDGETS.logicalRequests,
            readerRecordDisposition: event => usage.recordLlmDisposition(event, { directory: usageDirectory }),
            readerMaterializeFigures: async requested => requested.map(item => {
                const cached = figures.find(figure => figure.ordinal === item.ordinal && figure.url === item.url);
                if (!cached) throw new Error(`Figure ${item.ordinal} has no verified snapshot cache; evaluation will not download it`);
                if (sha(readRegular(cached.cachePath)) !== cached.assetSha256) throw new Error('Figure cache changed before model input');
                return { ...item, ...cached };
            }),
            readerCallModel: async (messages, tokens, requestOptions) => {
                if (report.calls.length >= BUDGETS.logicalRequests) throw new Error('Evaluation logical request budget exhausted');
                const kind = requestOptions.usageContext?.stage === 'apiReaderRepair' ? 'patch' : 'full';
                const expected = kind === 'patch' ? BUDGETS.patchOutputTokens : BUDGETS.fullOutputTokens;
                if (tokens !== expected) throw new Error('Actual Reader output budget drifted from evaluation budget');
                const call = { index: report.calls.length + 1, kind, outputBudgetTokens: tokens,
                    inputCharacters: messages.reduce((sum, message) => sum + (Array.isArray(message.content)
                        ? message.content.reduce((count, block) => count + (block.type === 'text' ? String(block.text || '').length : 0), 0)
                        : String(message.content || '').length), 0), status: 'pending' };
                report.calls.push(call);
                try {
                    const raw = await deep.callModel(messages, tokens, { ...requestOptions,
                        maxRetries: BUDGETS.transportAttemptsPerRequest, usageDirectory });
                    call.status = 'response_received'; call.outputCharacters = raw.length; call.outputSha256 = sha(raw);
                    call.rawResponseFile = writeArtifact(outputDir, `response-${call.index}-${kind}.txt`, raw);
                    return raw;
                } catch (error) { call.status = 'request_failed'; call.errorCode = error.code || 'REQUEST_FAILED'; throw error; }
            }
        });
        const assembled = result.plan.figurePlacements.length
            ? deep.injectApiReaderFigures(result, inputs.artifacts, options.paperId) : { ...result, figures: [] };
        report.outputs.article = writeArtifact(outputDir, 'reader.article.md', assembled.article);
        report.outputs.plan = writeArtifact(outputDir, 'reader.plan.json', result.plan);
        report.outputs.result = writeArtifact(outputDir, 'reader.result.json', { ...result, article: assembled.article, figures: assembled.figures });
        report.result = { attempts: result.attempts, fullAttempts: result.fullAttempts, contentMode: result.contentMode,
            articleSha256: sha(assembled.article), planSha256: stableHash(result.plan), qualityMetrics: result.qualityMetrics,
            sections: result.plan.sections.length, tables: result.plan.tableBindings.length,
            formulas: result.plan.formulaBindings.length, figures: result.plan.figurePlacements.length,
            chineseCharacters: (assembled.article.match(/[\u3400-\u9fff]/g) || []).length,
            review: 'not_performed; requires independent factual and visual review' };
        report.status = 'live_reader_generated';
        return report;
    } catch (error) {
        failure = error;
        report.status = 'failed'; report.error = { code: error.code || 'EVALUATION_FAILED', message: error.message };
        return report;
    } finally {
        report.finishedAt = new Date().toISOString();
        if (options.live) {
            const usage = require('./lib/llm-usage.js');
            const directory = path.join(outputDir, 'usage');
            const events = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith('.json'))
                .map(name => JSON.parse(readRegular(path.join(directory, name)).toString('utf8'))) : [];
            const requests = events.filter(event => event.kind === 'request');
            report.usage = { status: requests.length && requests.every(event => event.usage?.status === 'reported')
                ? 'reported' : report.calls.length ? 'unknown_or_partial' : 'not_requested',
                actualProviderRequests: requests.length, summary: usage.summarizeLlmUsage(events),
                cost: null, costStatus: 'unknown; no provider price configured' };
        }
        const after = Object.fromEntries(watchedFiles.map(filename => [filename, hashExisting(filename)]));
        report.integrity = { unchanged: watchedFiles.every(filename => before[filename] === after[filename]), before, after };
        if (!report.integrity.unchanged) {
            report.status = 'failed'; report.error = { code: 'INPUT_OR_CANONICAL_CHANGED', message: 'A watched source/snapshot/canonical file changed during evaluation' };
        }
        writeArtifact(outputDir, 'report.json', report);
        if (failure) process.stderr.write(`[reader-evaluation] ${failure.message}\n`);
    }
}

if (require.main === module) {
    require('./env-loader.js').requireExternalRuntime('evaluate-reader-efficiency');
    Promise.resolve().then(() => evaluate(parseArgs(process.argv.slice(2)))).then(report => {
        process.stdout.write(JSON.stringify({ status: report.status, paperId: report.paperId, calls: report.calls.length,
            integrity: report.integrity?.unchanged }, null, 2) + '\n');
        if (report.status === 'failed') process.exitCode = 1;
    }).catch(error => { process.stderr.write(`[reader-evaluation] ${error.message}\n`); process.exitCode = 1; });
}

module.exports = { VERSION, BUDGETS, parseArgs, loadInputs, replaySnapshotPlan, snapshotFigures,
    safeOutputDirectory, evaluate, stableHash };
