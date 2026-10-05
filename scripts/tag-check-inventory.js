#!/usr/bin/env node
'use strict';

// 更新词表前，读取会议、日更分析和历史分类文件中的标签阶段记录，并按词表 SHA 分组。
// --mark-stale 只检查历史分类文件；本工具还读取会议和日更实际保存的记录。
// 检查范围是 conference-analysis-executions/*/analysis.json、当前深度分析结果，
// 以及 historical-taxonomy-assignments 中的分类文件。所有路径由集中配置或参数指定。
// 本工具只读取文件，不更新记录，也不调用模型。它提供清单，不判断发布资格；
// 无论统计出多少旧词表 SHA，命令均以退出码 0 结束。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { requireExternalRuntime } = require('./env-loader.js');
const { readTagStageRecord } = require('./lib/tag-stage-record.js');
const Config = require('./config.js');

const INVENTORY_CONTRACT = 'paper-tag-record-inventory-v2';
const SHA256_RE = /^[a-f0-9]{64}$/;
const FILENAME_SHA_RE = /\.taxonomy\.([a-f0-9]{64})(?:\.[a-f0-9]+)?\.json$/;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const SAMPLE_LIMIT = 3;

const USAGE = [
    "tags:check-inventory — 更新词表前检查标签记录（只读）",
    "",
    "用法：",
    "  npm run tags:check-inventory [-- --json]",
    "  npm run tags:check-inventory -- --executions DIR --deep FILE --assignments DIR --registry FILE [--json]",
    "",
    "程序读取以下三处记录，按 registrySha256 分组：",
    "  conference-analysis-executions/*/analysis.json 中的新旧标签阶段 registrySha256 和 status；",
    "  data/current/deep-analysis-result.json 中每篇论文的新旧标签阶段记录；",
    "  historical-taxonomy-assignments/*/*.json 中的 registrySha256。",
    "",
    "输出包括每组记录数量、与当前 config/tag-catalog.json 的 SHA 不同的组，以及各组示例 paperId。",
    "程序只读取文件，不删除、改写或更新记录，也不调用模型。",
    "此命令提供检查清单，不判断发布资格；无论记录使用新旧哪份词表，都以退出码 0 结束。"
].join('\n');

function parseArgs(argv) {
    if (!Array.isArray(argv)) throw new Error('命令参数 argv 必须是数组。');
    const options = { json: false };
    const paths = { '--executions': 'executionsDir', '--deep': 'deepFile',
                    '--assignments': 'assignmentsDir', '--registry': 'registryFile' };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        if (flag === '--help' || flag === '-h') return { help: true };
        if (flag === '--json') {
            if (options.json) throw new Error('--json 不能重复指定。');
            options.json = true;
            continue;
        }
        const key = paths[flag];
        const value = argv[index + 1];
        if (!key || value === undefined || value.startsWith('--') || Object.hasOwn(options, key)) {
            throw new Error(`用法：\n${USAGE}`);
        }
        options[key] = value;
        index += 1;
    }
    return options;
}

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readJson(io, file) {
    let bytes;
    try {
        const info = io.statSync(file);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) return { ok: false, reason: 'unbounded' };
        bytes = io.readFileSync(file);
    } catch (error) {
        return { ok: false, reason: error.code === 'ENOENT' ? 'missing' : 'unreadable' };
    }
    try {
        return { ok: true, value: JSON.parse(bytes.toString('utf8')), bytes: bytes.length };
    } catch {
        return { ok: false, reason: 'invalid-json' };
    }
}

// 优先读取每篇论文的标签阶段记录；没有逐篇记录时，才读取顶层的新旧标签阶段。
// 这样可以避免同一次执行被重复计数。
function collectTagStageRecords(value, fallbackPaperId) {
    const entries = [];
    const push = (tagStageRecord, paperId) => {
        if (!tagStageRecord || typeof tagStageRecord !== 'object' || Array.isArray(tagStageRecord)) return;
        const raw = typeof tagStageRecord.registrySha256 === 'string' ? tagStageRecord.registrySha256 : '';
        entries.push({
            paperId: typeof paperId === 'string' && paperId ? paperId : null,
            registrySha256: SHA256_RE.test(raw) ? raw : null,
            status: typeof tagStageRecord.status === 'string' && tagStageRecord.status ? tagStageRecord.status : 'unknown'
        });
    };
    const papers = Array.isArray(value?.papers) ? value.papers : [];
    let found = 0;
    for (const paper of papers) {
        const tagStageRecord = readTagStageRecord(paper?.analysisManifest, paper?.analysisStageCheckpoints).stage;
        if (tagStageRecord) {
            found += 1;
            // 优先使用执行或批次记录的 paperId，缺少时才使用逐篇论文的 ID。
            push(tagStageRecord, fallbackPaperId || paper.paperId || paper.id);
        }
    }
    if (!found) push(readTagStageRecord(value, value?.analysisStageCheckpoints).stage, fallbackPaperId);
    return entries;
}

function scanExecutions(dir, io) {
    const source = 'conference-analysis-executions';
    const state = { source, directories: 0, files: 0, seals: 0, unreadable: 0, withoutSeal: 0, entries: [] };
    let names = [];
    try {
        names = io.readdirSync(dir, { withFileTypes: true })
            .filter(entry => typeof entry === 'object' && entry.isDirectory?.())
            .map(entry => entry.name).sort();
    } catch (error) {
        if (error.code === 'ENOENT') { state.missing = true; return state; }
        throw error;
    }
    state.directories = names.length;
    for (const name of names) {
        const loaded = readJson(io, path.join(dir, name, 'analysis.json'));
        if (!loaded.ok) {
            if (loaded.reason !== 'missing') state.unreadable += 1;
            state.withoutSeal += 1;
            continue;
        }
        state.files += 1;
        let entries;
        try { entries = collectTagStageRecords(loaded.value, loaded.value.paperId || name); }
        catch { state.unreadable += 1; state.withoutSeal += 1; continue; }
        if (!entries.length) state.withoutSeal += 1;
        for (const entry of entries) state.entries.push({ ...entry, source });
        state.seals += entries.length;
    }
    return state;
}

function scanDeep(file, io) {
    const source = 'deep-analysis-result';
    const state = { source, files: 0, seals: 0, unreadable: 0, entries: [] };
    const loaded = readJson(io, file);
    if (!loaded.ok) {
        state.missing = loaded.reason === 'missing';
        if (!state.missing) state.unreadable += 1;
        return state;
    }
    state.files = 1;
    let entries;
    try { entries = collectTagStageRecords(loaded.value, null); }
    catch { state.unreadable += 1; return state; }
    for (const entry of entries) state.entries.push({ ...entry, source });
    state.seals = entries.length;
    return state;
}

function scanAssignments(dir, io) {
    const source = 'historical-taxonomy-assignments';
    const state = { source, directories: 0, files: 0, seals: 0, unreadable: 0, entries: [] };
    let directories = [];
    try {
        directories = io.readdirSync(dir, { withFileTypes: true })
            .filter(entry => typeof entry === 'object' && entry.isDirectory?.())
            .map(entry => entry.name).sort();
    } catch (error) {
        if (error.code === 'ENOENT') { state.missing = true; return state; }
        throw error;
    }
    state.directories = directories.length;
    for (const directory of directories) {
        let names = [];
        try {
            names = io.readdirSync(path.join(dir, directory), { withFileTypes: true })
                .filter(entry => typeof entry === 'object' && entry.isFile?.())
                .map(entry => entry.name).filter(name => name.endsWith('.json')).sort();
        } catch {
            state.unreadable += 1;
            continue;
        }
        for (const name of names) {
            state.files += 1;
            const file = path.join(dir, directory, name);
            const loaded = readJson(io, file);
            if (!loaded.ok) { state.unreadable += 1; continue; }
            const match = name.match(FILENAME_SHA_RE);
            const raw = SHA256_RE.test(String(loaded.value.registrySha256 || ''))
                ? loaded.value.registrySha256 : (match ? match[1] : null);
            const entry = {
                paperId: typeof loaded.value.paperId === 'string' ? loaded.value.paperId : null,
                registrySha256: raw, status: typeof loaded.value.status === 'string'
                    ? loaded.value.status : 'unknown',
                source
            };
            state.entries.push(entry);
            state.seals += 1;
        }
    }
    return state;
}

function groupEntries(entries, currentRegistrySha256) {
    const groups = new Map();
    for (const entry of entries) {
        const key = entry.registrySha256;
        let group = groups.get(key);
        if (!group) {
            group = { registrySha256: key, matchesCurrent: key === null ? null : key === currentRegistrySha256,
                      seals: 0, statuses: {}, bySource: {}, samplePaperIds: [] };
            groups.set(key, group);
        }
        group.seals += 1;
        group.statuses[entry.status] = (group.statuses[entry.status] || 0) + 1;
        group.bySource[entry.source] = (group.bySource[entry.source] || 0) + 1;
        if (entry.paperId && group.samplePaperIds.length < SAMPLE_LIMIT
            && !group.samplePaperIds.includes(entry.paperId)) {
            group.samplePaperIds.push(entry.paperId);
        }
    }
    return [...groups.values()].sort((left, right) => right.seals - left.seals
        || String(left.registrySha256).localeCompare(String(right.registrySha256)));
}

function collect(options = {}, io = fs) {
    const executionsDir = options.executionsDir || Config.FILES.conferenceAnalysisDir;
    const deepFile = options.deepFile || Config.FILES.deepAnalysisResult;
    const assignmentsDir = options.assignmentsDir || Config.FILES.historicalTagAssignmentDir;
    const registryFile = options.registryFile || Config.FILES.tagCatalogFile;

    const registryBytes = io.readFileSync(registryFile);
    const currentRegistrySha256 = sha256(registryBytes);

    const executions = scanExecutions(executionsDir, io);
    const deep = scanDeep(deepFile, io);
    const assignments = scanAssignments(assignmentsDir, io);
    const scans = [executions, deep, assignments];
    const entries = scans.flatMap(scan => scan.entries);

    const groups = groupEntries(entries, currentRegistrySha256);
    const stale = groups.filter(group => group.registrySha256 && !group.matchesCurrent);
    const sealsWithoutSha = groups.find(group => group.registrySha256 === null)?.seals || 0;
    const currentGroup = groups.find(group => group.matchesCurrent);
    const total = entries.length;

    return {
        contract: INVENTORY_CONTRACT,
        readOnly: true,
        currentRegistrySha256,
        currentRegistryFile: path.basename(registryFile),
        sources: Object.fromEntries(scans.map(scan => [scan.source, {
            missing: Boolean(scan.missing),
            directories: scan.directories ?? null,
            files: scan.files, seals: scan.seals, unreadable: scan.unreadable,
            ...(scan.withoutSeal === undefined ? {} : { withoutSeal: scan.withoutSeal })
        }])),
        totals: {
            seals: total,
            sealsWithoutSha,
            bySource: Object.fromEntries(scans.map(scan => [scan.source, scan.seals])),
            unreadable: scans.reduce((sum, scan) => sum + scan.unreadable, 0)
        },
        groups,
        diff: {
            currentRegistrySha256,
            currentSeals: currentGroup?.seals || 0,
            currentPresent: Boolean(currentGroup),
            staleSeals: stale.reduce((sum, group) => sum + group.seals, 0),
            staleRegistrySha256: stale.map(group => ({
                registrySha256: group.registrySha256, seals: group.seals,
                matchesCurrent: false, bySource: group.bySource
            })),
            sealsWithoutSha,
            inSyncRatio: total ? Number(((currentGroup?.seals || 0) / total).toFixed(4)) : 0
        }
    };
}

function short(sha) {
    return sha === null ? '(无 SHA)' : `${sha.slice(0, 16)}…`;
}

function formatHuman(inventory) {
    const lines = [];
    lines.push(`标签阶段记录检查（只读） ${inventory.contract}`);
    lines.push(`当前词表 SHA： ${inventory.currentRegistrySha256}（${inventory.currentRegistryFile}）`);
    lines.push('来源:');
    for (const [name, info] of Object.entries(inventory.sources)) {
        const parts = [];
        if (info.directories !== null && info.directories !== undefined) parts.push(`目录 ${info.directories}`);
        parts.push(`文件 ${info.files}`, `标签阶段记录 ${info.seals}`, `不可读 ${info.unreadable}`);
        if (info.withoutSeal !== undefined) parts.push(`无标签阶段记录 ${info.withoutSeal}`);
        if (info.missing) parts.push('路径不存在');
        lines.push(`  ${name}: ${parts.join(' / ')}`);
    }
    lines.push(`标签阶段记录总数： ${inventory.totals.seals}（缺 SHA ${inventory.totals.sealsWithoutSha}，`
        + `不可读 ${inventory.totals.unreadable}）`);
    lines.push('', '按词表 SHA（registrySha256）分组：');
    for (const group of inventory.groups) {
        const marker = group.registrySha256 === null ? '[缺 SHA]'
            : group.matchesCurrent ? '[当前]' : '[非当前]';
        const statuses = Object.entries(group.statuses).map(([key, value]) => `${key} ${value}`).join(' / ');
        const sources = Object.entries(group.bySource).map(([key, value]) => `${key} ${value}`).join(' / ');
        lines.push(`  ${short(group.registrySha256)} ${marker} 标签阶段记录 ${group.seals} · ${statuses}`);
        lines.push(`      来源: ${sources}`);
        if (group.samplePaperIds.length) lines.push(`      示例 paperId: ${group.samplePaperIds.join(', ')}`);
    }
    const diff = inventory.diff;
    lines.push('', '各组记录与当前词表 SHA 的比较：');
    lines.push(`  一致: ${diff.currentSeals} 条记录（占比 ${(diff.inSyncRatio * 100).toFixed(2)}%）`);
    if (diff.staleRegistrySha256.length) {
        lines.push(`  非当前: ${diff.staleSeals} 条记录，共 ${diff.staleRegistrySha256.length} 个 SHA`);
        for (const item of diff.staleRegistrySha256) {
            lines.push(`    ${short(item.registrySha256)} ${item.seals} 条记录（${Object.entries(item.bySource)
                .map(([key, value]) => `${key} ${value}`).join(' / ')}）`);
        }
        lines.push('  请逐组核对使用旧词表的记录，再决定更新标签记录还是重新分析；本清单不写入任何文件。');
    } else if (diff.currentPresent) {
        lines.push('  已统计且具有有效 SHA 的记录都使用当前词表；缺少 SHA 的记录仍须另行核对。');
    } else {
        lines.push('  没有找到可识别的标签阶段词表 SHA，扫描路径也可能为空。');
    }
    if (diff.sealsWithoutSha) lines.push(`  另有 ${diff.sealsWithoutSha} 条记录的 registrySha256 缺失或格式无效，需人工核对。`);
    return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
    requireExternalRuntime('tag-check-inventory.js');
    const options = parseArgs(argv);
    if (options.help) { console.log(USAGE); return 0; }
    const inventory = collect(options);
    console.log(options.json ? JSON.stringify(inventory, null, 2) : formatHuman(inventory));
    return 0;
}

if (require.main === module) {
    try {
        process.exitCode = main();
    } catch (error) {
        console.error(error && error.message ? error.message : String(error));
        process.exitCode = 1;
    }
}

module.exports = { INVENTORY_CONTRACT, parseArgs, collectTagStageRecords, collect, formatHuman, main };
