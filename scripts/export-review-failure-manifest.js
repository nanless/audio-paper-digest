#!/usr/bin/env node
'use strict';

// 为两种必须手写、没有生成器的 JSON 清单导出只读骨架：
//   --kind conference-figure-crop        会议 `--figure-crop-manifest`
//   --kind historical-visual-disposition 历史 `--visual-disposition`
//
// 只读取磁盘上已经存在的失败记录、原生成记录和发布计划，不写生产数据、不安装
// 任何授权、不联网。能从记录确定的字段直接填好；必须由人确认的字段一律留 null，
// 并在 `_todo` 中逐条说明为什么不能推导。`_todo` 是注释字段，补齐后必须删除：
// 两边的校验都只接受精确字段集合，留着它会整批拒绝（fail-closed，不会误当通过）。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const codec = require('./lib/protocol-codec');
const { requireExternalRuntime } = require('./env-loader.js');

const ROOT = path.resolve(__dirname, '..');
const SHA_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CONFERENCE_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const FAILURE_FILE_RE = /^[a-f0-9]{64}\.json$/;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_LARGE_JSON_BYTES = 64 * 1024 * 1024;
const KINDS = ['conference-figure-crop', 'historical-visual-disposition'];

const CONFERENCE_MANIFEST = 'conference-publication-figure-crop-manifest';
const FAILURE_CONTRACT = 'conference-page-content-review-failure';
const GENERATION_CONTRACT = 'conference-blog-generation';
const DISPOSITION_CONTRACT = 'historical-direct-visual-disposition';
const PLAN_CONTRACT = 'historical-direct-publication-plan';

const MEMBER_FIELDS = ['paperId', 'figureOrdinal', 'imagePath', 'imageSha256', 'imageSize', 'pagePath',
    'pageSha256', 'analysisSha256', 'sourceSnapshotSha256', 'reviewFailureSha256', 'figureUrl',
    'sourceDomSha256', 'readerArticleSha256', 'readerPlanSha256'];
const ROUTE_KINDS = ['crop', 'source-page-view', 'reader-maintenance', 'protocol-replay', 'unresolved',
    'nonblocking-observation'];

const USAGE = [
    'export-review-failure-manifest — 只读导出会议图片清单/历史视觉处置的骨架 JSON',
    '',
    '用法：',
    '  node scripts/export-review-failure-manifest.js --kind conference-figure-crop \\',
    '    --process PROCESS_UUID --out /absolute/skeleton.json [--conference-id ID]',
    '    [--review-protocol-sha SHA] [--runtime-root /absolute/data/runtime]',
    '',
    '  node scripts/export-review-failure-manifest.js --kind historical-visual-disposition \\',
    '    --publication PUBLICATION_UUID --out /absolute/skeleton.json',
    '    [--plan-file /absolute/direct-rewrite-plan.json] [--runtime-root /absolute/data/runtime]',
    '',
    '只读取 data/runtime/conference-publications/page-review-failures、原 generation.json、',
    'historical-direct-publications/<uuid>/plan.json；不写生产数据、不安装授权、不联网。',
    '无法从记录推导的字段留 null 并写进 `_todo`；补齐后必须删除 `_todo`，否则校验整批拒绝。'
].join('\n');

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) {
    return Array.isArray(value) ? value.map(canonical)
        : value && typeof value === 'object'
            ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
            : value;
}
function stableHash(value) { return sha256(Buffer.from(JSON.stringify(canonical(value)), 'utf8')); }
function literal(value) { return JSON.stringify(value); }
function fail(message) { throw new Error('清单骨架导出被拒：' + message); }

function requireDirectory(directory, label) {
    let info;
    try { info = fs.lstatSync(directory); } catch { fail(`${label}不存在：${directory}`); }
    if (info.isSymbolicLink() || !info.isDirectory()) fail(`${label}不是普通目录：${directory}`);
    return directory;
}
function readRegular(filename, label, limit = MAX_JSON_BYTES) {
    let named;
    try { named = fs.lstatSync(filename); } catch { fail(`${label}不存在：${filename}`); }
    if (named.isSymbolicLink() || !named.isFile() || named.nlink !== 1) fail(`${label}不是普通文件：${filename}`);
    if (named.size < 1 || named.size > limit) fail(`${label}大小不合法：${filename}`);
    const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let bytes;
    try {
        const opened = fs.fstatSync(descriptor);
        if (!opened.isFile() || opened.size !== named.size) fail(`${label}在打开时发生变化：${filename}`);
        bytes = fs.readFileSync(descriptor);
        if (bytes.length !== opened.size) fail(`${label}在读取时发生变化：${filename}`);
    } finally { fs.closeSync(descriptor); }
    return { filename, sha256: sha256(bytes), bytes };
}
function readJson(filename, label, limit) {
    const loaded = readRegular(filename, label, limit);
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes)); }
    catch { fail(`${label}不是合法 JSON：${filename}`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}不是 JSON 对象：${filename}`);
    return { ...loaded, value };
}

// ---- 参数 -----------------------------------------------------------------

function parseArgs(argv) {
    if (!Array.isArray(argv)) fail('argv 必须是数组');
    if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
    const values = new Map();
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (!/^--[a-z][a-z-]*$/.test(flag || '') || value === undefined || value.startsWith('--')
            || values.has(flag)) fail(`命令写法不对，用法：\n${USAGE}`);
        values.set(flag, value);
    }
    const kind = values.get('--kind');
    if (!KINDS.includes(kind)) fail(`--kind 必须是 ${KINDS.join(' 或 ')}`);
    const allowed = new Set(['--kind', '--out', '--runtime-root',
        ...(kind === 'conference-figure-crop'
            ? ['--process', '--conference-id', '--review-protocol-sha']
            : ['--publication', '--plan-file'])]);
    for (const flag of values.keys()) {
        if (!allowed.has(flag)) fail(`${kind} 不接受参数 ${flag}`);
    }
    const out = values.get('--out');
    if (typeof out !== 'string' || !path.isAbsolute(out) || out.includes('\0')) fail('--out 必须是绝对路径');
    const runtimeRoot = values.get('--runtime-root') || path.join(ROOT, 'data', 'runtime');
    if (!path.isAbsolute(runtimeRoot) || runtimeRoot.includes('\0')) fail('--runtime-root 必须是绝对路径');
    const options = { kind, out, runtimeRoot };
    if (kind === 'conference-figure-crop') {
        const processId = values.get('--process');
        if (!UUID_RE.test(processId || '')) fail('--process 必须是会议处理任务的 UUID');
        options.process = processId;
        if (values.has('--conference-id')) {
            const conferenceId = values.get('--conference-id');
            if (!CONFERENCE_RE.test(conferenceId)) fail('--conference-id 不合法');
            options.conferenceId = conferenceId;
        }
        if (values.has('--review-protocol-sha')) {
            const protocol = values.get('--review-protocol-sha');
            if (!SHA_RE.test(protocol)) fail('--review-protocol-sha 必须是 SHA-256');
            options.reviewProtocolSha = protocol;
        }
        return options;
    }
    const publication = values.get('--publication');
    if (!UUID_RE.test(publication || '')) fail('--publication 必须是发布任务的 UUID');
    options.publication = publication;
    if (values.has('--plan-file')) {
        const planFile = values.get('--plan-file');
        if (!path.isAbsolute(planFile) || planFile.includes('\0')) fail('--plan-file 必须是绝对路径');
        options.planFile = planFile;
    }
    return options;
}

// ---- 会议图片清单 ---------------------------------------------------------

function locateConferencePublication(publications, options) {
    if (options.conferenceId) {
        const directory = path.join(publications, options.conferenceId, options.process);
        requireDirectory(directory, '会议发布流程目录');
        return { conferenceId: options.conferenceId, directory };
    }
    const found = [];
    for (const name of fs.readdirSync(publications).sort()) {
        if (!CONFERENCE_RE.test(name)) continue;
        const directory = path.join(publications, name, options.process);
        let info = null;
        try { info = fs.lstatSync(directory); } catch { continue; }
        if (info.isDirectory() && !info.isSymbolicLink()) found.push({ conferenceId: name, directory });
    }
    if (found.length !== 1) {
        fail(`无法按 --process 唯一定位会议发布目录（命中 ${found.length} 个）`
            + (found.length > 1 ? `：${found.map(item => item.conferenceId).join(', ')}，请显式传 --conference-id` : ''));
    }
    return found[0];
}

function sealedGeneration(filename, conferenceId, processId) {
    const loaded = readJson(filename, '原生成记录', MAX_LARGE_JSON_BYTES);
    const value = loaded.value;
    const body = { ...value };
    delete body.generationSha256;
    if (!SHA_RE.test(value.generationSha256 || '') || stableHash(body) !== value.generationSha256) {
        fail(`原生成记录自身 SHA 不闭合：${filename}`);
    }
    const selector = Object.hasOwn(value, 'schemaFingerprint') ? 'contract' : 'version';
    if (!codec.hasValidHeader(value, GENERATION_CONTRACT, selector)
        || codec.format(value[selector], GENERATION_CONTRACT, value.schemaFingerprint) !== 'external-images') {
        fail(`原生成记录不是 external-images 格式：${filename}`);
    }
    if (value.conferenceId !== conferenceId || value.processId !== processId) {
        fail(`原生成记录不属于本会议流程：${filename}`);
    }
    if (!Array.isArray(value.files)) fail(`原生成记录缺少 files：${filename}`);
    return { ...loaded, value };
}

function pageRecords(generation) {
    const pages = new Map();
    for (const record of generation.files) {
        if (!record || record.kind !== 'paper') continue;
        if (typeof record.path !== 'string' || !record.path.trim()
            || typeof record.paperId !== 'string' || !record.paperId.trim()
            || !SHA_RE.test(record.sourceSha256 || '')) {
            fail(`原生成页面记录字段不完整：${literal(record.path)}`);
        }
        if (pages.has(record.path)) fail(`原生成记录重复页面：${record.path}`);
        pages.set(record.path, record);
    }
    return pages;
}

// 失败记录是按内容寻址的不可变文件；读取时重算自身 SHA，坏记录直接报错，不猜。
function loadFailureRecord(filename, stem) {
    const loaded = readJson(filename, '页面审查失败记录');
    const record = loaded.value;
    const body = { ...record };
    delete body.failureSha256;
    if (!SHA_RE.test(record.failureSha256 || '') || record.failureSha256 !== stem
        || stableHash(body) !== record.failureSha256) {
        fail(`失败记录文件名与自身 SHA 不一致：${path.basename(filename)}`);
    }
    if (!codec.hasValidHeader(record, FAILURE_CONTRACT)) fail(`失败记录格式不合法：${path.basename(filename)}`);
    // 汇总页等记录的 paperId 可以是 null；这类记录不可能等于任何单篇页面身份，
    // 后面按“页面/身份不匹配”排除，不在这里判成损坏。
    if (typeof record.path !== 'string' || !record.path.trim()
        || !SHA_RE.test(record.sha256 || '')
        || (record.paperId !== null && record.paperId !== undefined && typeof record.paperId !== 'string')
        || !SHA_RE.test(record.protocol || '')
        || !Array.isArray(record.issues)) {
        fail(`失败记录缺少页面身份、协议或 issues：${path.basename(filename)}`);
    }
    return record;
}

function exportConference(options) {
    const publications = path.join(options.runtimeRoot, 'conference-publications');
    requireDirectory(publications, '会议发布根目录');
    const failureDirectory = path.join(publications, 'page-review-failures');
    requireDirectory(failureDirectory, '页面审查失败目录');

    const located = locateConferencePublication(publications, options);
    const generationFile = path.join(located.directory, 'generation.json');
    const generation = sealedGeneration(generationFile, located.conferenceId, options.process);
    const pages = pageRecords(generation.value);
    // 失败记录只有 imageCount，没有图号；这里只列出原生成中该论文真实存在的
    // figure-N.png 序号，供人工确认目标图，不替人决定哪一张失败。
    const ordinalsByPaper = new Map();
    for (const record of Array.isArray(generation.value.imageFiles) ? generation.value.imageFiles : []) {
        if (!record || record.kind !== 'asset' || typeof record.paperId !== 'string') continue;
        const matchedOrdinal = /figure-([1-9][0-9]*)\.png$/.exec(String(record.path || ''));
        if (!matchedOrdinal) continue;
        const list = ordinalsByPaper.get(record.paperId) || [];
        if (!list.includes(Number(matchedOrdinal[1]))) list.push(Number(matchedOrdinal[1]));
        ordinalsByPaper.set(record.paperId, list);
    }
    for (const list of ordinalsByPaper.values()) list.sort((left, right) => left - right);

    const superseded = fs.readdirSync(located.directory)
        .filter(name => /^generation\.superseded-[a-f0-9]{12}\.json$/.test(name));
    if (superseded.length) {
        // 规范生成与不可变 superseded 的身份由发布器唯一选择；这里不替人挑。
        superseded.sort();
    }

    const skippedNames = [];
    const records = [];
    for (const entry of fs.readdirSync(failureDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!FAILURE_FILE_RE.test(entry.name)) { skippedNames.push(entry.name); continue; }
        if (!entry.isFile() || entry.isSymbolicLink()) fail(`失败记录不是普通文件：${entry.name}`);
        records.push(loadFailureRecord(path.join(failureDirectory, entry.name),
            entry.name.slice(0, -'.json'.length)));
    }

    let otherStage = 0;
    const imageContent = [];
    for (const record of records) {
        if (record.stage !== 'image' || record.failureKind !== 'content'
            || record.completed !== true || record.passed !== false) { otherStage += 1; continue; }
        imageContent.push(record);
    }
    const matched = [];
    let unmatchedPage = 0;
    for (const record of imageContent) {
        const page = pages.get(record.path);
        if (typeof record.paperId !== 'string' || !record.paperId.trim()
            || !page || page.sourceSha256 !== record.sha256 || page.paperId !== record.paperId) {
            unmatchedPage += 1; continue;
        }
        matched.push(record);
    }
    if (!matched.length) {
        fail('原生成页面中没有同协议、同页 SHA 的图片拒稿；不能凭空生成 imageFailureUniverse');
    }
    const protocolCounts = new Map();
    for (const record of matched) protocolCounts.set(record.protocol, (protocolCounts.get(record.protocol) || 0) + 1);
    let protocol = options.reviewProtocolSha;
    if (!protocol) {
        if (protocolCounts.size !== 1) {
            const detail = [...protocolCounts.entries()].sort((a, b) => b[1] - a[1])
                .map(([sha, count]) => `${sha}（${count} 条）`).join('，');
            fail(`同页图片拒稿命中多种审查协议，必须用 --review-protocol-sha 指定：${detail}`);
        }
        protocol = [...protocolCounts.keys()][0];
    }
    const universe = matched.filter(record => record.protocol === protocol)
        .sort((left, right) => left.failureSha256.localeCompare(right.failureSha256));
    if (!universe.length) {
        fail(`没有任何图片拒稿使用 --review-protocol-sha ${protocol}`);
    }

    const todo = [
        '`_todo` 只是人工注释；补齐清单后必须删除整个字段，否则 `--figure-crop-manifest` 会因未知字段整批拒绝。',
        'members 当前是每个失败页的占位条目：figureOrdinal 及图片、分析、Reader 字段必须按真实 crop 路由逐图补齐，'
            + '最终与 imageFailureUniverse 中 crop 路由的 (reviewFailureSha256, figureOrdinal) 一一相等；不能带自由几何参数。',
        `每条 routes 必须覆盖该失败的全部 issue，kind 取 ${ROUTE_KINDS.join(' / ')}；`
            + 'crop 与 source-page-view 必须给 figureOrdinals，reader-maintenance 另需维护清单路径与 SHA，unresolved 必须写原因。',
        `members 的 14 个固定字段：${MEMBER_FIELDS.join(', ')}。`,
        `baseGenerationSha256/baseGenerationFileSha256 取自 ${path.basename(generationFile)}；`
            + '若本目录存在 superseded 生成，请人工确认原生成选择。'
    ];
    if (superseded.length) {
        todo.push(`目录中存在 superseded 生成（${superseded.join(', ')}）：必须人工确认 baseGeneration 应指向哪一份，本工具不代为挑选。`);
    }
    if (unmatchedPage) {
        todo.push(`已排除 ${unmatchedPage} 条页面不在本流程原生成中的图片拒稿；若其中属于本流程，请核对页面路径与源 SHA 后重跑。`);
    }
    if (protocolCounts.size > 1) {
        todo.push(`本流程页面存在 ${protocolCounts.size} 种审查协议；已按 ${protocol} 导出，其他协议拒稿不能混入本清单。`);
    }
    for (const record of universe) {
        const lines = record.issues.map((issue, index) => {
            const severity = String(issue && issue.severity || '?');
            const type = String(issue && issue.type || '?');
            const description = String(issue && issue.description || '').replace(/\s+/g, ' ').slice(0, 60);
            return `#${index} ${severity}/${type}：${description}`;
        });
        const ordinals = ordinalsByPaper.get(record.paperId);
        todo.push(`失败 ${record.failureSha256}（${record.paperId}，页面 ${record.path}，${record.issues.length} 条 issue；`
            + (ordinals && ordinals.length
                ? `原生成该论文图片序号 ${ordinals.join(', ')}，须人工确认目标图`
                : '原生成没有该论文的 figure-N.png 图片记录，图号须人工确认')
            + `）：${lines.join('；')}`);
    }

    const manifest = {
        ...codec.recordHeader(CONFERENCE_MANIFEST, CONFERENCE_MANIFEST),
        conferenceId: located.conferenceId,
        processId: options.process,
        baseGenerationSha256: generation.value.generationSha256,
        baseGenerationFileSha256: generation.sha256,
        reviewProtocolSha256: protocol,
        imageFailureUniverse: universe.map(record => ({ failureSha256: record.failureSha256, routes: [] })),
        members: universe.map(record => ({
            paperId: record.paperId,
            figureOrdinal: null,
            imagePath: null,
            imageSha256: null,
            imageSize: null,
            pagePath: record.path,
            pageSha256: record.sha256,
            analysisSha256: null,
            sourceSnapshotSha256: null,
            reviewFailureSha256: record.failureSha256,
            figureUrl: null,
            sourceDomSha256: null,
            readerArticleSha256: null,
            readerPlanSha256: null
        })),
        _todo: todo
    };

    return {
        kind: options.kind, out: options.out, runtimeRoot: options.runtimeRoot,
        conferenceId: located.conferenceId, processId: options.process, reviewProtocolSha256: protocol,
        baseGenerationSha256: manifest.baseGenerationSha256, baseGenerationFileSha256: manifest.baseGenerationFileSha256,
        counts: {
            failureFilesRead: records.length,
            imageContentFailures: imageContent.length,
            universe: universe.length,
            members: manifest.members.length,
            excludedOtherStage: otherStage,
            excludedUnmatchedPage: unmatchedPage,
            excludedOtherProtocol: matched.length - universe.length,
            skippedNonFailureFiles: skippedNames.length
        },
        manifest, todo
    };
}

// ---- 历史视觉处置 ---------------------------------------------------------

function sealedRewritePlan(filename) {
    const loaded = readJson(filename, '直接重写计划', MAX_LARGE_JSON_BYTES);
    const value = loaded.value;
    const body = { ...value };
    delete body.planSha256;
    if (!SHA_RE.test(value.planSha256 || '') || stableHash(body) !== value.planSha256) {
        fail(`直接重写计划自身 SHA 不闭合：${filename}`);
    }
    return { ...loaded, value };
}

function exportHistorical(options) {
    const publicationsRoot = path.join(options.runtimeRoot, 'historical-direct-publications');
    let publicationPlan = null;
    const planFile = path.join(publicationsRoot, options.publication, 'plan.json');
    let publicationPlanMissing = null;
    try {
        requireDirectory(publicationsRoot, '历史发布根目录');
        publicationPlan = readJson(planFile, '发布计划', MAX_LARGE_JSON_BYTES);
    } catch (error) {
        if (options.planFile === undefined) throw error;
        publicationPlanMissing = error.message;
    }

    let planSha256 = null;
    let scope = null;
    let original = null;
    if (publicationPlan) {
        const value = publicationPlan.value;
        const body = { ...value };
        delete body.planSha256;
        if (!SHA_RE.test(value.planSha256 || '') || stableHash(body) !== value.planSha256) {
            fail(`发布计划自身 SHA 不闭合：${planFile}`);
        }
        if (value.publicationId !== options.publication) fail(`发布计划不属于发布 ${options.publication}`);
        if (!codec.hasValidHeader(value, PLAN_CONTRACT)) fail(`发布计划格式不合法：${planFile}`);
        const producer = value.authorityProof && value.authorityProof.plan;
        if (!producer || !SHA_RE.test(producer.planSha256 || '') || !SHA_RE.test(producer.fileSha256 || '')) {
            fail('发布计划没有绑定原直接重写计划的 SHA，无法推导 disposition 的 planSha256');
        }
        // 旧计划可能没有范围字段；validatePlan 同样把缺失当作全历史。
        const rawScope = value.publicationScope === undefined ? 'full-history' : value.publicationScope;
        const selected = value.selectedPaperIds === undefined ? [] : value.selectedPaperIds;
        if (!['full-history', 'selected-sample'].includes(rawScope)) fail('发布计划的 publicationScope 不合法');
        if (!Array.isArray(selected)) fail('发布计划的 selectedPaperIds 不是数组');
        scope = rawScope === 'selected-sample' ? 'selected-sample-publication' : 'full-history-publication';
        if ((rawScope === 'selected-sample') !== (selected.length > 0)) {
            fail('发布计划的 publicationScope 与 selectedPaperIds 不一致');
        }
        if (value.visualDisposition && value.visualDisposition.planSha256 !== producer.planSha256) {
            fail('发布计划中已绑定的视觉处置与本计划的生产者 SHA 不一致');
        }
        if (value.visualDisposition) {
            original = { mode: value.visualDisposition.mode, requestedBy: value.visualDisposition.requestedBy };
        }
        planSha256 = producer.planSha256;
    }
    if (options.planFile) {
        const rewrite = sealedRewritePlan(options.planFile);
        if (planSha256 !== null && planSha256 !== rewrite.value.planSha256) {
            fail('发布计划与 --plan-file 指向的直接重写计划不是同一份');
        }
        planSha256 = rewrite.value.planSha256;
    }
    if (planSha256 === null) fail('缺少可推导 planSha256 的来源：发布计划或 --plan-file');

    const todo = [
        '`_todo` 只是人工注释；补齐后必须删除整个字段，否则视觉处置校验会因未知字段整批拒绝。',
        'mode 必须由人明确声明：excluded 表示用户明确限定本次只发布正文、不含视觉任务；waived 表示用户明确豁免视觉。'
            + '“重写全历史”本身不授予任何一种处置。',
        'requestedBy 必须与 mode 对应：waived 只能是 user，excluded 只能是 system-contract；它只是范围声明，不能代替用户授权。',
        'reason 必须是真实范围说明（至少 10 个字符），不能照抄示例文字或把示例当授权。',
        'createdAt 必须是本次人工声明的 ISO 时间；不要用导出时间冒充声明时间。',
        'dispositionSha256 必须在补齐全部字段后用键排序 JSON 的 SHA-256 封口，不能手填随机值。'
    ];
    if (scope === null) {
        todo.push('scope 无法从 --plan-file 推导，必须按实际发布范围填 full-history-publication 或 selected-sample-publication。');
    }
    if (original) {
        todo.push(`发布计划中已嵌入原视觉处置（mode=${original.mode}，requestedBy=${original.requestedBy}）；`
            + '那只是原规划记录，不能据此重复授权，本次仍须人工重新声明。');
    }
    if (publicationPlanMissing) {
        todo.push(`未找到发布计划（${publicationPlanMissing}）；scope 只能由人按实际范围确认。`);
    }

    const skeleton = {
        ...codec.recordHeader(DISPOSITION_CONTRACT, DISPOSITION_CONTRACT),
        planSha256,
        scope,
        mode: null,
        reason: null,
        requestedBy: null,
        createdAt: null,
        dispositionSha256: null,
        _todo: todo
    };

    return {
        kind: options.kind, out: options.out, runtimeRoot: options.runtimeRoot,
        publication: options.publication, planSha256, scope,
        counts: { planSha256: planSha256 ? 1 : 0, scope: scope ? 1 : 0, pendingHumanFields: 5 },
        manifest: skeleton, todo
    };
}

// ---- 输出 -----------------------------------------------------------------

function assertOutputTarget(out) {
    if (path.extname(out) !== '.json') fail('--out 必须以 .json 结尾');
    const resolved = path.resolve(out);
    const directory = path.dirname(resolved);
    let info;
    try { info = fs.statSync(directory); } catch { fail(`输出目录不存在：${directory}`); }
    if (!info.isDirectory()) fail(`输出目录不是目录：${directory}`);
    // /tmp 之类可能是指向真实目录的符号链接，按真实路径判断生产目录。
    const realDirectory = fs.realpathSync(directory);
    const production = fs.realpathSync(path.join(ROOT, 'data'));
    const realOut = path.join(realDirectory, path.basename(resolved));
    if (realOut === production || realOut.startsWith(production + path.sep)) {
        fail(`拒绝把骨架写进生产数据目录：${realOut}`);
    }
    if (fs.existsSync(resolved)) fail(`输出文件已存在，拒绝覆盖：${resolved}`);
    return resolved;
}

function writeSkeleton(result) {
    const filename = assertOutputTarget(result.out);
    const bytes = Buffer.from(`${JSON.stringify(result.manifest, null, 2)}\n`, 'utf8');
    const descriptor = fs.openSync(filename,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    return filename;
}

function main(argv = process.argv.slice(2)) {
    requireExternalRuntime('export-review-failure-manifest.js');
    const options = parseArgs(argv);
    if (options.help) { process.stdout.write(USAGE + '\n'); return { help: true }; }
    const result = options.kind === 'conference-figure-crop' ? exportConference(options) : exportHistorical(options);
    const written = writeSkeleton(result);
    return { ...result, written };
}

// 只在真正作为命令运行时禁网；被测试 require 时不改写进程级网络实现。
function denyNetwork() {
    const denied = () => { throw new Error('清单骨架导出只读本地记录，不联网'); };
    require('node:net').Socket.prototype.connect = denied;
    require('node:net').connect = denied;
    require('node:net').createConnection = denied;
    require('node:tls').connect = denied;
    for (const name of ['node:http', 'node:https']) {
        require(name).request = denied;
        require(name).get = denied;
    }
    globalThis.fetch = denied;
}

module.exports = { main, parseArgs, exportConference, exportHistorical, MEMBER_FIELDS, ROUTE_KINDS, USAGE };

if (require.main === module) {
    try {
        denyNetwork();
        const result = main();
        if (!result.help) {
            // 完整骨架只看文件；stdout 只报身份、计数和人工项条数，避免刷屏。
            const summary = { kind: result.kind, out: result.out, written: result.written,
                conferenceId: result.conferenceId, processId: result.processId,
                publication: result.publication, planSha256: result.planSha256, scope: result.scope,
                reviewProtocolSha256: result.reviewProtocolSha256,
                baseGenerationSha256: result.baseGenerationSha256,
                counts: result.counts, todoCount: result.todo.length,
                reminder: '骨架仍是未完成草稿：按文件内 _todo 人工补齐并删除 _todo 后才能用于校验。' };
            console.log(JSON.stringify(summary, null, 2));
        }
    } catch (error) {
        console.error(`[export-review-failure-manifest] ${error.message}`);
        process.exitCode = 1;
    }
}
