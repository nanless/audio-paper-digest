#!/usr/bin/env node
'use strict';

// 显式的离线候选发现。这条命令绝不会把匹配结果提升为「已核验」。Apply 只写配置的
// 运行根目录下的直接文件名。

const fs = require('node:fs');
const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const discovery = require('./lib/conference-discovery.js');

const USAGE = '用法：--dry-run|--apply --adapter icassp|iclr|icml|official-proceedings --year YYYY [--conference-id SLUG-YYYY] --metadata ABS.json --pdf-root ABS [--acquisition-root ABS] [--candidate-output NAME.json --report-output NAME.json]';

function parseArgs(args) {
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
        const flag = args[index]; const value = args[index + 1];
        if (!['--adapter', '--year', '--conference-id', '--metadata', '--pdf-root', '--acquisition-root', '--candidate-output', '--report-output'].includes(flag) || value === undefined) {
            throw new Error(USAGE);
        }
        if (Object.hasOwn(options, flag)) throw new Error(`参数重复：${flag}`);
        options[flag] = value;
    }
    return options;
}

function requireFiles(files) {
    for (const field of ['conferenceDiscoveryCatalogDir', 'conferenceDiscoveryReportDir']) {
        if (typeof files?.[field] !== 'string' || !path.isAbsolute(files[field])) {
            throw new Error(`配置项 ${field} 必须是绝对路径目录`);
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
        throw new Error(`${name} 必须是不带子目录的 .json 文件名`);
    }
    const root = ensureConfiguredDirectory(directory, `${name} directory`);
    const absolute = path.resolve(root, filename);
    if (path.dirname(absolute) !== root) throw new Error(`${name} 必须直接放在配置目录下，不能带子目录`);
    return absolute;
}

function parseCommand(argv) {
    const [mode, ...rest] = argv;
    if (!['--dry-run', '--apply'].includes(mode)) throw new Error(`第一个参数只能是 --dry-run 或 --apply。用法：${USAGE}`);
    const options = parseArgs(rest);
    for (const field of ['--adapter', '--year', '--metadata', '--pdf-root']) {
        if (!options[field]) throw new Error(`缺少必需参数：${field}`);
    }
    if (!/^\d{4}$/.test(options['--year'])) throw new Error(`--year 必须是四位年份：当前是 ${options['--year']}`);
    if (options['--adapter'] === 'official-proceedings' && !options['--conference-id']) {
        throw new Error('official-proceedings requires --conference-id');
    }
    if (options['--conference-id'] && !/^[a-z0-9]+(?:-[a-z0-9]+)*-\d{4}$/.test(options['--conference-id'])) {
        throw new Error('--conference-id must be a normalized conference slug ending in its year');
    }
    if (options['--conference-id'] && !options['--conference-id'].endsWith(`-${options['--year']}`)) {
        throw new Error('--conference-id must end with the exact --year');
    }
    if (options['--acquisition-root'] !== undefined && !path.isAbsolute(options['--acquisition-root'])) {
        throw new Error('--acquisition-root 必须是绝对路径');
    }
    if (options['--acquisition-root'] !== undefined && options['--adapter'] !== 'official-proceedings') {
        throw new Error('--acquisition-root 只对 official-proceedings 有效');
    }
    const outputs = [options['--candidate-output'], options['--report-output']];
    if (mode === '--dry-run' && outputs.some(Boolean)) throw new Error('--dry-run must not specify output files');
    if (mode === '--apply' && outputs.some(value => !value)) throw new Error('--apply requires --candidate-output and --report-output');
    if (mode === '--apply' && outputs.some(value => !discovery.SAFE_JSON_NAME.test(String(value)))) {
        throw new Error('--apply output values must be safe direct JSON filenames');
    }
    return { apply: mode === '--apply', adapter: options['--adapter'], year: Number(options['--year']),
        ...(options['--conference-id'] ? { conferenceId: options['--conference-id'] } : {}),
        metadataFile: options['--metadata'], pdfRoot: options['--pdf-root'],
        ...(options['--acquisition-root'] ? { acquisitionRoot: options['--acquisition-root'] } : {}),
        candidateOutput: options['--candidate-output'],
        reportOutput: options['--report-output'] };
}

function writeOutputsOnce({ catalogDir, catalogName, candidate, reportDir, reportName, report, forbiddenRoot }) {
    discovery.validateDiscoveryBundle(candidate, report);
    const candidateOutput = safeOutput(catalogDir, catalogName, 'candidate output');
    const reportOutput = safeOutput(reportDir, reportName, 'report output');
    if (candidateOutput === reportOutput) throw new Error('候选输出和报告输出不能是同一个文件');
    if ([candidateOutput, reportOutput].some(output => output === forbiddenRoot || output.startsWith(`${forbiddenRoot}${path.sep}`))) {
        throw new Error('discovery outputs must not be inside pdfRoot');
    }
    const specs = [[candidateOutput, discovery.canonicalBytes(candidate)], [reportOutput, discovery.canonicalBytes(report)]];
    const opened = [];
    try {
        for (const [filename] of specs) {
            const directory = path.dirname(filename);
            const parent = fs.lstatSync(directory);
            const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
            opened.push({ filename, fd, directory, parent });
        }
        for (let index = 0; index < specs.length; index += 1) {
            fs.writeFileSync(opened[index].fd, specs[index][1]);
            fs.fsyncSync(opened[index].fd);
        }
    } catch (error) {
        const cleanupErrors = [];
        for (const item of opened) {
            try {
                const parent = fs.lstatSync(item.directory);
                if (!parent.isDirectory() || parent.isSymbolicLink()
                    || parent.dev !== item.parent.dev || parent.ino !== item.parent.ino) {
                    throw new Error(`发现结果的输出目录已被替换，保留现有路径：${item.directory}`);
                }
                const held = fs.fstatSync(item.fd);
                const named = fs.lstatSync(item.filename);
                if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1
                    || named.dev !== held.dev || named.ino !== held.ino) {
                    throw new Error(`发现结果文件已被替换或增加硬链接，保留现有路径：${item.filename}`);
                }
                fs.unlinkSync(item.filename);
            } catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT') cleanupErrors.push(cleanupError);
            } finally {
                try { fs.closeSync(item.fd); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
            }
        }
        if (cleanupErrors.length) {
            const failure = new Error(`会议发现结果写入失败：${error.message}；部分文件未清理：`
                + cleanupErrors.map(item => item.message).join('；'), { cause: error });
            if (error.code) failure.code = error.code;
            failure.cleanupError = new AggregateError(cleanupErrors, '会议发现写入失败后的清理未完成');
            throw failure;
        }
        throw error;
    }
    for (const item of opened) fs.closeSync(item.fd);
    return { candidateOutput, reportOutput };
}

function main(argv = process.argv.slice(2), dependencies = {}) {
    requireExternalRuntime('conference-discover.js');
    const args = parseCommand(argv);
    if (process.env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE === '1'
        && args.adapter === 'official-proceedings' && !args.acquisitionRoot) {
        throw new Error('新会议发现需要 --acquisition-root，并且要带上官方 catalog.receipt.json');
    }
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
