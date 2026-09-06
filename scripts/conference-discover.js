#!/usr/bin/env node
'use strict';

// Explicit, offline candidate discovery. This command never promotes a match
// to verified. Apply writes only direct names under configured runtime roots.

const fs = require('node:fs');
const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const discovery = require('./lib/conference-discovery.js');

const USAGE = 'Use --dry-run|--apply --adapter icassp|iclr|icml --year YYYY --metadata ABS.json --pdf-root ABS [--candidate-output NAME.json --report-output NAME.json]';

function parseArgs(args) {
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
        const flag = args[index]; const value = args[index + 1];
        if (!['--adapter', '--year', '--metadata', '--pdf-root', '--candidate-output', '--report-output'].includes(flag) || value === undefined) {
            throw new Error(USAGE);
        }
        if (Object.hasOwn(options, flag)) throw new Error(`Duplicate argument: ${flag}`);
        options[flag] = value;
    }
    return options;
}

function requireFiles(files) {
    for (const field of ['conferenceDiscoveryCatalogDir', 'conferenceDiscoveryReportDir']) {
        if (typeof files?.[field] !== 'string' || !path.isAbsolute(files[field])) {
            throw new Error(`Configured ${field} must be an absolute directory`);
        }
    }
    return files;
}

function ensureConfiguredDirectory(directory, name) {
    const absolute = path.resolve(directory);
    const parent = path.dirname(absolute);
    discovery.safeAbsoluteDirectory(parent, `${name} parent`);
    try { fs.mkdirSync(absolute, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return discovery.safeAbsoluteDirectory(absolute, name);
}

function safeOutput(directory, filename, name) {
    if (typeof filename !== 'string' || !discovery.SAFE_JSON_NAME.test(filename)) {
        throw new Error(`${name} must be a safe direct .json filename`);
    }
    const root = ensureConfiguredDirectory(directory, `${name} directory`);
    const absolute = path.resolve(root, filename);
    if (path.dirname(absolute) !== root) throw new Error(`${name} must be directly inside its configured directory`);
    return absolute;
}

function parseCommand(argv) {
    const [mode, ...rest] = argv;
    if (!['--dry-run', '--apply'].includes(mode)) throw new Error(`First argument must be --dry-run or --apply. ${USAGE}`);
    const options = parseArgs(rest);
    for (const field of ['--adapter', '--year', '--metadata', '--pdf-root']) {
        if (!options[field]) throw new Error(`Missing required argument: ${field}`);
    }
    if (!/^\d{4}$/.test(options['--year'])) throw new Error('--year must be four digits');
    const outputs = [options['--candidate-output'], options['--report-output']];
    if (mode === '--dry-run' && outputs.some(Boolean)) throw new Error('--dry-run must not specify output files');
    if (mode === '--apply' && outputs.some(value => !value)) throw new Error('--apply requires --candidate-output and --report-output');
    if (mode === '--apply' && outputs.some(value => !discovery.SAFE_JSON_NAME.test(String(value)))) {
        throw new Error('--apply output values must be safe direct JSON filenames');
    }
    return { apply: mode === '--apply', adapter: options['--adapter'], year: Number(options['--year']),
        metadataFile: options['--metadata'], pdfRoot: options['--pdf-root'], candidateOutput: options['--candidate-output'],
        reportOutput: options['--report-output'] };
}

function writeOutputsOnce({ catalogDir, catalogName, candidate, reportDir, reportName, report, forbiddenRoot }) {
    discovery.validateDiscoveryBundle(candidate, report);
    const candidateOutput = safeOutput(catalogDir, catalogName, 'candidate output');
    const reportOutput = safeOutput(reportDir, reportName, 'report output');
    if (candidateOutput === reportOutput) throw new Error('candidate output and report output must be different files');
    if ([candidateOutput, reportOutput].some(output => output === forbiddenRoot || output.startsWith(`${forbiddenRoot}${path.sep}`))) {
        throw new Error('discovery outputs must not be inside pdfRoot');
    }
    const specs = [[candidateOutput, discovery.canonicalBytes(candidate)], [reportOutput, discovery.canonicalBytes(report)]];
    const opened = [];
    try {
        for (const [filename] of specs) {
            const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
            opened.push({ filename, fd });
        }
        for (let index = 0; index < specs.length; index += 1) {
            fs.writeFileSync(opened[index].fd, specs[index][1]);
            fs.fsyncSync(opened[index].fd);
        }
    } catch (error) {
        for (const item of opened) {
            try { fs.closeSync(item.fd); } catch {}
            try { fs.unlinkSync(item.filename); } catch {}
        }
        throw error;
    }
    for (const item of opened) fs.closeSync(item.fd);
    return { candidateOutput, reportOutput };
}

function main(argv = process.argv.slice(2), dependencies = {}) {
    requireExternalRuntime('conference-discover.js');
    const args = parseCommand(argv);
    const files = requireFiles(dependencies.files || Config.FILES);
    const result = discovery.discoverConference(args);
    let outputs = { candidateOutput: null, reportOutput: null };
    if (args.apply) outputs = writeOutputsOnce({ catalogDir: files.conferenceDiscoveryCatalogDir,
        catalogName: args.candidateOutput, candidate: result.manifest,
        reportDir: files.conferenceDiscoveryReportDir, reportName: args.reportOutput,
        report: result.report, forbiddenRoot: result.manifest.pdfRoot });
    const summary = { status: args.apply ? 'written' : 'dry-run', adapter: result.manifest.adapter,
        conference: result.manifest.conference, candidateManifestSha256: result.report.candidateManifestSha256,
        metadataSnapshotSha256: result.report.metadataSnapshotSha256, pdfCatalogSha256: result.report.pdfCatalogSha256,
        counts: result.report.counts, ...outputs };
    console.log(JSON.stringify(summary));
    return summary;
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(`[conference-discover] ${error.message}`); process.exitCode = 1; }
}

module.exports = { USAGE, parseArgs, parseCommand, requireFiles, ensureConfiguredDirectory, safeOutput, writeOutputsOnce, main };
