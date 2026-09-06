#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');

const USAGE = 'prepare --dry-run|--apply --run-id UUID --id YYMM.NNNNN --date YYYY-MM-DD --authority arxiv-YYMM.NNNNN.json | analyze|status --run-id UUID [--concurrency 1-5]';

function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseArgs(argv) {
    const action = argv[0];
    if (!['prepare', 'analyze', 'status'].includes(action)) throw new Error(`Use ${USAGE}`);
    const flags = {}; const booleans = new Set();
    for (let i = 1; i < argv.length; i++) {
        const flag = argv[i];
        if (['--apply', '--dry-run'].includes(flag)) {
            if (booleans.has(flag)) throw new Error(`Use ${USAGE}`);
            booleans.add(flag); continue;
        }
        if (!['--id', '--date', '--authority', '--run-id', '--concurrency'].includes(flag)
            || Object.hasOwn(flags, flag) || argv[i + 1] === undefined) throw new Error(`Use ${USAGE}`);
        flags[flag] = argv[++i];
    }
    if (action === 'prepare') {
        if (booleans.size !== 1 || !booleans.has('--apply') && !booleans.has('--dry-run')
            || !/^\d{4}\.\d{4,5}$/.test(flags['--id'] || '')
            || !validDate(flags['--date'])
            || !/^arxiv-\d{4}\.\d{4,5}(?:-[a-z0-9][a-z0-9._-]{0,80})?\.json$/.test(flags['--authority'] || '')
            || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(flags['--run-id'] || '')
            || flags['--concurrency']) throw new Error(`Use ${USAGE}`);
        return { action, apply: booleans.has('--apply'), runId: flags['--run-id'], arxivId: flags['--id'], date: flags['--date'], authorityName: flags['--authority'] };
    }
    if (booleans.size || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(flags['--run-id'] || '')
        || flags['--id'] || flags['--date'] || flags['--authority']
        || (action === 'status' && flags['--concurrency'])
        || (flags['--concurrency'] && !/^[1-5]$/.test(flags['--concurrency']))) throw new Error(`Use ${USAGE}`);
    return { action, runId: flags['--run-id'], ...(flags['--concurrency'] ? { concurrency: Number(flags['--concurrency']) } : {}) };
}

function readMetadata(date, arxivId, config) {
    const candidates = [config.FILES.rawCandidates, path.join(config.ARCHIVE_DIR, date, 'raw-candidates.json')];
    for (const filename of candidates) {
        let bytes;
        try {
            const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1) throw new Error('unsafe raw metadata file'); bytes = fs.readFileSync(fd); }
            finally { fs.closeSync(fd); }
        } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const value = JSON.parse(bytes.toString('utf8'));
        if (value.batchDate !== date || !Array.isArray(value.papers)) continue;
        const matches = value.papers.filter(paper => (paper.arxivId || paper.paper_id) === arxivId);
        if (matches.length !== 1) continue;
        const allowed = new Set(require('./lib/fresh-rewrite-run.js').ORIGINAL_METADATA_FIELDS);
        const metadata = Object.fromEntries(Object.entries(matches[0]).filter(([key]) => allowed.has(key)));
        return { metadata, proof: { contract: require('./lib/historical-arxiv-analysis.js').METADATA_CONTRACT,
            paperId: `arxiv:${arxivId}`, sourceName: path.relative(config.PROJECT_ROOT, filename),
            fileSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            recordSha256: require('./lib/fresh-rewrite-run.js').stableHash(metadata) } };
    }
    throw new Error(`No unique raw metadata record for ${arxivId} on ${date}`);
}

async function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('historical-arxiv-analysis.js');
    const options = parseArgs(argv);
    const Config = runtime.config || require('./config.js');
    const runner = runtime.runner || require('./lib/fresh-rewrite-run.js');
    if (options.action === 'analyze') {
        const result = await runner.analyzeRewrite({ runId: options.runId, concurrency: options.concurrency || 1 });
        console.log(JSON.stringify(result)); return result;
    }
    if (options.action === 'status') {
        const result = runner.rewriteStatus({ runId: options.runId });
        console.log(JSON.stringify(result)); return result;
    }
    if (!options.apply) {
        const result = { status: 'dry-run', paperId: `arxiv:${options.arxivId}`, date: options.date,
            runId: options.runId, authorityName: options.authorityName,
            metadataSource: `https://export.arxiv.org/api/query?id_list=${options.arxivId}&max_results=1` };
        console.log(JSON.stringify(result)); return result;
    }
    const historyApi = runtime.historyApi || require('./lib/historical-arxiv-analysis.js');
    const recovered = historyApi.recoverHistoricalArxivRun({ runId: options.runId, date: options.date,
        arxivId: options.arxivId, rootDir: Config.FILES.freshRewriteRunsDir });
    if (recovered) { console.log(JSON.stringify(recovered)); return recovered; }
    const source = await (runtime.metadataApi || require('./lib/arxiv-metadata-source.js'))
        .fetchOfficialArxivMetadata(options.arxivId);
    const preparedAuthority = await (runtime.arxivApi || require('./lib/arxiv-source-authority.js'))
        .prepareArxivSourceAuthority({ authorityRoot: Config.FILES.paperSourceAuthorityDir,
            arxivId: options.arxivId, authorityName: options.authorityName, apply: true,
            requireLiveAuthorization: true });
    const result = historyApi.prepareHistoricalArxivRun({
        authorityHandle: preparedAuthority.authorityHandle, metadata: source.metadata, metadataProof: source.proof,
        metadataArtifact: source.rawBytes, date: options.date, rootDir: Config.FILES.freshRewriteRunsDir,
        runId: options.runId });
    console.log(JSON.stringify(result)); return result;
}

if (require.main === module) main().catch(error => { console.error(`[historical-arxiv-analysis] ${error.message}`); process.exitCode = 1; });
module.exports = { USAGE, validDate, parseArgs, readMetadata, main };
