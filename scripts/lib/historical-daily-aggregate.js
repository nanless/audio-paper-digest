'use strict';

// 根据当前单篇页面记录生成每日汇总，不读取旧汇总正文。
// 旧页面清单只提供需要保留的路径、网址及原文件 SHA。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const crosswalkApi = require('./page-source-crosswalk.js');
const pageStagingApi = require('./historical-page-staging.js');
const fresh = require('./fresh-rewrite-run.js');
const { writeImmutableFile } = require('./immutable-file.js');

const PAGE_STAGING_CONTRACT = pageStagingApi.CONTRACT;
const CONTRACT = 'historical-daily-aggregate-staging-v2';
const LEGACY_CONTRACT = 'historical-daily-aggregate-staging-v1';
const VERSION = 2;
const UUID_RE = fresh.UUID_RE || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const stableHash = fresh.stableHash;
const clone = value => JSON.parse(JSON.stringify(value));

function fail(message) {
    const error = new Error(`无法生成历史每日汇总：${message}`);
    error.code = 'HISTORICAL_DAILY_AGGREGATE_INTEGRITY'; error.retryable = false; throw error;
}
function exact(value, keys, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) fail(`${label}必须为对象，且字段集合必须符合要求。`);
}
function boundedText(value, label, maximum = 20000) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > maximum
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail(`${label}必须为非空字符串，首尾不能有空白，长度不能超过允许上限，且不能含有 NUL 等禁止使用的控制字符。`);
    return value;
}
function strictJson(bytes, label) {
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail(`${label}内容无法按 UTF-8 解码。`); }
    const stack = [];
    for (const match of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0]; const top = stack[stack.length - 1];
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            let key; try { key = JSON.parse(token); } catch { fail(`${label}内容不是有效的 JSON。`); }
            if (top.keys.has(key)) fail(`${label}中出现重复的 JSON 字段：${key}。`);
            top.keys.add(key); top.expectKey = false;
        }
    }
    let value; try { value = JSON.parse(source); } catch { fail(`${label}内容不是有效的 JSON。`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}的 JSON 顶层必须为对象。`);
    return value;
}
function readRegular(filename, maximum, label) {
    let fd;
    try {
        const before = fs.lstatSync(filename);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) fail(`${label}不安全：不是普通文件、存在符号链接、硬链接数量不为 1，或大小超过允许上限。`);
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size) fail(`${label}在打开时发生变化，或不再满足普通文件和单硬链接要求。`);
        const bytes = fs.readFileSync(fd); if (bytes.length !== opened.size) fail(`${label}的实际读取字节数与打开时记录的文件大小不一致。`);
        return { bytes, sha256: sha256(bytes) };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function normalizePageStagingManifest(value, stagingRunId) {
    exact(value, ['contract', 'version', 'stagingRunId', 'crosswalkId', 'crosswalkStateSha256',
        'identityGroupsSha256', 'rendererImplementationSha256', 'createdAt', 'pages', 'pageSetSha256', 'assets', 'assetSetSha256',
        'selectedBindings', 'selectedBindingSha256', 'manifestSha256'], '页面生成清单');
    const originalBody = clone(value); delete originalBody.manifestSha256;
    if (!SHA_RE.test(value.manifestSha256 || '') || value.manifestSha256 !== stableHash(originalBody)) fail('页面生成清单自身的 SHA 缺失、格式无效，或与清单内容不一致。');
    const legacy = value.contract === pageStagingApi.LEGACY_CONTRACT && value.version === 1;
    if (!legacy && !(value.contract === PAGE_STAGING_CONTRACT && value.version === pageStagingApi.VERSION)) fail('页面生成清单的格式标识和版本不属于支持的组合。');
    if (value.stagingRunId !== stagingRunId || !UUID_RE.test(value.crosswalkId)
        || !SHA_RE.test(value.crosswalkStateSha256) || !SHA_RE.test(value.identityGroupsSha256)
        || !SHA_RE.test(value.rendererImplementationSha256)
        || !SHA_RE.test(value.assetSetSha256) || !SHA_RE.test(value.selectedBindingSha256)
        || !Array.isArray(value.pages) || !value.pages.length) fail('页面生成清单的版本、运行标识、输入指纹或页面列表不符合要求。');
    if (Number.isNaN(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) fail('页面生成清单的创建时间必须是规范的 UTC 时间字符串。');
    const pages = value.pages.map((page, index) => {
        pageStagingApi.tagAssignmentProofFor(value, page);
        exact(page, ['paperId', 'pageKey', 'pagePath', 'primaryUrl', 'cohortDate', 'sourcePageContentSha256',
            'stagedPath', 'contentSha256', 'analysisRunId', 'analysisFileSha256',
            'analysisRecordSha256', 'analysisSha256',
            legacy ? 'taxonomyAssignmentSha256' : 'tagAssignmentSha256',
            legacy ? 'taxonomyFileSha256' : 'tagAssignmentFileSha256'], `页面生成清单中的页面项 ${index}`);
        if (!/^arxiv:\d{4}\.\d{4,5}$/.test(page.paperId) || !/^page:[a-f0-9]{64}$/.test(page.pageKey)
            || !/^content\/posts\/[a-zA-Z0-9._/-]+\.md$/.test(page.pagePath)
            || page.stagedPath !== path.posix.join('pages', page.pagePath)
            || !/^\d{4}-\d{2}-\d{2}$/.test(page.cohortDate) || !UUID_RE.test(page.analysisRunId)) fail(`页面生成清单中的页面项 ${index} 的论文标识、页面标识、路径、日期或分析运行 ID 不符合要求。`);
        for (const field of ['sourcePageContentSha256', 'contentSha256', 'analysisFileSha256',
            'analysisRecordSha256', 'analysisSha256']) if (!SHA_RE.test(page[field])) fail(`页面生成清单中的页面项 ${index} 的 ${field} 字段不是有效的 SHA 格式。`);
        let url; try { url = new URL(page.primaryUrl); } catch { fail(`页面生成清单中的页面项 ${index} 的正式网址无法解析。`); }
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail(`页面生成清单中的页面项 ${index} 的正式网址不安全：必须使用 HTTPS，且不能包含认证信息、查询参数或片段。`);
        return clone(page);
    });
    if (new Set(pages.map(item => item.pageKey)).size !== pages.length
        || new Set(pages.map(item => item.stagedPath)).size !== pages.length
        || value.pageSetSha256 !== stableHash(pages)) fail('页面生成清单中存在重复页面或路径，或页面集合的 SHA 与记录不一致。');
    if (!Array.isArray(value.assets)) fail('页面生成清单中的资源必须为数组。');
    const assets = value.assets.map((asset, index) => {
        exact(asset, ['path', 'sha256', 'size'], `页面生成清单中的资源项 ${index}`);
        if (!/^(?:static\/images\/papers|static\/data\/papers)\/[A-Za-z0-9._/-]+$/.test(asset.path)
            || path.posix.normalize(asset.path) !== asset.path || !SHA_RE.test(asset.sha256)
            || !Number.isSafeInteger(asset.size) || asset.size < 0 || asset.size > 64 * 1024 * 1024) fail(`页面生成清单中的资源项 ${index} 的路径、SHA 格式或字节数不符合要求。`);
        return clone(asset);
    });
    if (new Set(assets.map(item => item.path)).size !== assets.length
        || stableHash(assets) !== value.assetSetSha256
        || assets.some((item, index) => index && assets[index - 1].path.localeCompare(item.path) >= 0)) fail('页面生成清单中存在重复资源、资源未按路径排序，或资源集合的 SHA 与记录不一致。');
    if (!Array.isArray(value.selectedBindings) || !value.selectedBindings.length
        || stableHash(value.selectedBindings) !== value.selectedBindingSha256) fail('页面生成清单中的已选论文对应记录必须为非空数组，且其 SHA 必须与记录一致。');
    const body = clone(value); delete body.manifestSha256;
    if (!SHA_RE.test(value.manifestSha256) || value.manifestSha256 !== stableHash(body)) fail('页面生成清单自身的 SHA 缺失、格式无效，或与清单内容不一致。');
    return clone(value);
}

function loadCompletedPageStaging({ stagingRoot, stagingRunId } = {}) {
    if (typeof stagingRoot !== 'string' || !path.isAbsolute(stagingRoot) || !UUID_RE.test(String(stagingRunId || ''))) {
        fail('页面生成目录必须使用绝对路径，且 stagingRunId 必须为 UUID v4。');
    }
    const root = fresh.assertSafeDirectory(stagingRoot); const runRoot = fresh.assertSafeDirectory(path.join(root, stagingRunId));
    const manifestLoaded = readRegular(path.join(runRoot, 'manifest.json'), 16 * 1024 * 1024, '页面生成清单');
    const manifest = normalizePageStagingManifest(strictJson(manifestLoaded.bytes, '页面生成清单'), stagingRunId);
    for (const page of manifest.pages) {
        const filename = path.resolve(runRoot, ...page.stagedPath.split('/'));
        if (!filename.startsWith(`${runRoot}${path.sep}`)) fail('已生成页面的路径超出对应运行目录。');
        const loaded = readRegular(filename, 32 * 1024 * 1024, `已生成页面 ${page.pageKey}`);
        if (loaded.sha256 !== page.contentSha256) fail(`页面 ${page.pageKey} 的文件 SHA 与生成清单不一致。`);
    }
    for (const asset of manifest.assets) {
        const filename = path.resolve(runRoot, 'assets', ...asset.path.split('/'));
        if (!filename.startsWith(`${path.join(runRoot, 'assets')}${path.sep}`)) fail('已生成资源的路径超出对应运行的资源目录。');
        const loaded = readRegular(filename, 64 * 1024 * 1024, `已生成资源 ${asset.path}`);
        if (loaded.bytes.length !== asset.size || loaded.sha256 !== asset.sha256) fail(`资源 ${asset.path} 的文件 SHA 或字节数与生成清单不一致。`);
    }
    return { runRoot, manifest, manifestFileSha256: manifestLoaded.sha256 };
}

function bindTopology({ crosswalkRoot, crosswalkId, inventoryRoot } = {}) {
    const state = crosswalkApi.readCrosswalk({ crosswalkRoot, crosswalkId });
    const handle = crosswalkApi.loadHistoricalInventoryHandle({ inventoryRoot,
        ledgerName: state.source.ledgerName, receiptName: state.source.receiptName });
    const inventory = crosswalkApi.inventoryHandleSnapshot(handle);
    if (stableHash(crosswalkApi.sourceBinding(inventory)) !== stableHash(state.source)) fail('历史页面清单与页面对应表记录的来源不一致。');
    return { state, inventory };
}

function buildDailyPaperDisplayRecord(paper, tagAssignment) {
    if (!paper || typeof paper !== 'object' || typeof paper.analysis !== 'string' || !paper.analysis.trim()
        || !paper.parsed || typeof paper.parsed !== 'object') fail('论文记录必须包含非空分析正文及解析结果对象。');
    try { require('../utils.js').readTagValidation(paper.parsed); }
    catch (error) { fail(error.message); }
    const reparsed = require('../utils.js').parseAnalysis(paper.analysis);
    if (!reparsed || stableHash({ summary: String(reparsed.summary || '').trim(), score: String(reparsed.score ?? '').trim() })
        !== stableHash({ summary: String(paper.parsed.summary || '').trim(), score: String(paper.parsed.score ?? '').trim() })) {
        fail('无法重新解析分析正文，或缓存的摘要、评分与正文解析结果不一致。');
    }
    const title = boundedText(paper.title, '论文标题', 2000);
    const summary = boundedText(reparsed.summary, '论文核心摘要', 20000);
    const score = Number(reparsed.score);
    if (!Number.isFinite(score) || score < 0 || score > 10) fail('从分析正文解析的评分必须为 0–10 之间的有限数值。');
    if (!tagAssignment || tagAssignment.status !== 'assigned' || !Array.isArray(tagAssignment.concepts)) fail('论文缺少已完成分配且包含概念数组的标签记录。');
    const concepts = tagAssignment.concepts.map((concept, index) => {
        const label = boundedText(concept?.preferredLabel?.zh, `标签记录中概念项 ${index} 的中文首选名称`, 200);
        if (typeof concept.id !== 'string' || typeof concept.facet !== 'string') fail(`标签记录中概念项 ${index} 的 ID 和分类维度必须为字符串。`);
        return { id: concept.id, facet: concept.facet, label };
    });
    const task = concepts.find(item => item.id === tagAssignment.primaryTaskId && item.facet === 'task');
    const method = concepts.find(item => item.id === tagAssignment.primaryMethodId && item.facet === 'method');
    if (!task || !method || new Set(concepts.map(item => item.id)).size !== concepts.length) fail('标签记录中的主任务或主方法未找到对应概念，或概念 ID 重复。');
    return { title, summary, score, analysisSha256: sha256(Buffer.from(paper.analysis, 'utf8')),
        tagAssignmentSha256: tagAssignment.assignmentSha256, tagCatalogSha256: tagAssignment.registrySha256,
        primaryTaskId: task.id, primaryTaskLabel: task.label, primaryMethodId: method.id,
        primaryMethodLabel: method.label, labels: concepts.map(item => item.label) };
}

function loadAggregateInputs(options, dependencies = {}) {
    const stagingRunIds = options.stagingRunIds || (options.stagingRunId ? [options.stagingRunId] : []);
    if (!Array.isArray(stagingRunIds) || !stagingRunIds.length || new Set(stagingRunIds).size !== stagingRunIds.length
        || stagingRunIds.some(runId => !UUID_RE.test(runId))) fail('必须提供非空且没有重复项的页面生成运行 ID 数组，每个 ID 都须为 UUID v4。');
    const stagedRuns = stagingRunIds.map(stagingRunId => (dependencies.loadCompletedPageStaging || loadCompletedPageStaging)({
        stagingRoot: options.stagingRoot, stagingRunId }));
    const assignmentProofs = Object.create(null);
    for (const staged of stagedRuns) for (const page of staged.manifest.pages) {
        const proof = { analysisRunId: page.analysisRunId, ...pageStagingApi.tagAssignmentProofFor(staged.manifest, page) };
        if (Object.hasOwn(assignmentProofs, page.paperId) && stableHash(assignmentProofs[page.paperId]) !== stableHash(proof)) {
            fail(`论文 ${page.paperId} 的多个已保存页面绑定了不同的标签分配凭证。`);
        }
        assignmentProofs[page.paperId] = proof;
    }
    const crosswalkIds = [...new Set(stagedRuns.map(item => item.manifest.crosswalkId))];
    if (crosswalkIds.length !== 1) fail('所有页面生成运行必须使用同一份页面对应表。');
    const rendererImplementationShas = [...new Set(stagedRuns
        .map(item => item.manifest.rendererImplementationSha256))];
    if (rendererImplementationShas.length !== 1 || !SHA_RE.test(rendererImplementationShas[0] || '')) {
        fail('所有页面生成运行必须使用同一份格式有效的生成器实现指纹。');
    }
    const topology = (dependencies.bindTopology || bindTopology)({ crosswalkRoot: options.crosswalkRoot,
        crosswalkId: crosswalkIds[0], inventoryRoot: options.inventoryRoot });
    const stagedPages = [];
    for (const staged of stagedRuns) {
        (dependencies.replaySelectedBindings || pageStagingApi.replaySelectedBindings)(staged.manifest, topology.state);
        const analysisRunIds = [...new Set(staged.manifest.pages.map(page => page.analysisRunId))];
        if (analysisRunIds.length !== 1) fail('每份页面生成清单必须且只能对应一次分析运行。');
        const pageGenerationInputs = (dependencies.loadPageGenerationInputs || pageStagingApi.loadPageGenerationInputs)({
            crosswalkRoot: options.crosswalkRoot, crosswalkId: staged.manifest.crosswalkId,
            analysisRoot: options.analysisRoot, tagAssignmentRoot: options.tagAssignmentRoot,
            tagCatalogPath: options.tagCatalogPath, analysisRunId: analysisRunIds[0],
            assignmentProofs: Object.fromEntries(staged.manifest.pages.map(page => [page.paperId, assignmentProofs[page.paperId]])) }, dependencies.pageGenerationDependencies || {});
        if (pageGenerationInputs.crosswalk.stateSha256 !== topology.state.stateSha256) fail('页面生成输入所用的页面对应表状态与当前状态不一致。');
        const groups = new Map(pageGenerationInputs.groups.map(group => [group.paperId, group]));
        for (const page of staged.manifest.pages) {
            const proof = pageStagingApi.tagAssignmentProofFor(staged.manifest, page);
            const group = groups.get(page.paperId); const sourcePage = group?.pages.find(item => item.pageKey === page.pageKey);
            if (!group || !sourcePage || sourcePage.pagePath !== page.pagePath || sourcePage.primaryUrl !== page.primaryUrl
                || sourcePage.cohortDate !== page.cohortDate || sourcePage.pageContentSha256 !== page.sourcePageContentSha256
                || group.analysisRunId !== page.analysisRunId || group.analysisFileSha256 !== page.analysisFileSha256
                || group.analysisRecordSha256 !== page.analysisRecordSha256
                || group.analysisSha256 !== page.analysisSha256
                || group.tagAssignment.assignmentSha256 !== proof.assignmentSha256
                || group.tagAssignmentFileSha256 !== proof.fileSha256) fail(`页面 ${page.pageKey} 的生成记录与当前论文、分析、标签或页面对应记录不一致。`);
            stagedPages.push({ ...page, stagingRunId: staged.manifest.stagingRunId,
                stagingManifestSha256: staged.manifest.manifestSha256,
                rendererImplementationSha256: staged.manifest.rendererImplementationSha256,
                canonical: buildDailyPaperDisplayRecord(group.paper, group.tagAssignment) });
        }
    }
    if (new Set(stagedPages.map(page => page.pageKey)).size !== stagedPages.length) fail('合并后的页面生成记录中存在重复页面。');
    return { topology, stagedRuns, stagedPages,
        rendererImplementationSha256: rendererImplementationShas[0] };
}

function aggregateRunIdFor(stagingRunIds) {
    if (!Array.isArray(stagingRunIds) || !stagingRunIds.length || new Set(stagingRunIds).size !== stagingRunIds.length
        || stagingRunIds.some(runId => !UUID_RE.test(runId))) fail('必须提供非空且没有重复项的页面生成运行 ID 数组，每个 ID 都须为 UUID v4。');
    const bytes = Buffer.from(sha256([...stagingRunIds].sort().join('\0')).slice(0, 32), 'hex');
    bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function md(value) { return String(value).replace(/([\\`*_[\]<>|])/g, '\\$1').replace(/\s+/g, ' ').trim(); }
function internalUrl(value) { const url = new URL(value); return `${url.pathname}${url.pathname.endsWith('/') ? '' : '/'}`; }
function renderDaily(date, members, labels) {
    const tags = [...new Set(labels)].sort();
    let output = `---\ntitle: "语音/音乐/音频论文速递 ${date}"\ndate: ${date}\ndraft: false\n`;
    output += `tags: ${JSON.stringify(tags)}\ncategories: ["论文速递"]\npaper_digest_pipeline_owned: true\n`;
    output += `paper_digest_page_type: index\n---\n\n# 语音/音乐/音频论文速递 ${date}\n\n`;
    output += `本期共收录 **${members.length}** 篇完成深度分析和标签更新的论文。\n\n`;
    output += '| 排名 | 论文 | 评分 | 主任务 | 主方法 |\n|---:|---|---:|---|---|\n';
    for (const member of members) output += `| ${member.rank} | [${md(member.title)}](${member.url}) | ${member.score.toFixed(1)} | ${md(member.primaryTaskLabel)} | ${md(member.primaryMethodLabel)} |\n`;
    output += '\n---\n';
    for (const member of members) {
        output += `\n## ${member.rank}. [${md(member.title)}](${member.url})\n\n`;
        output += `标签：${member.labels.map(label => `#${md(label)}`).join(' ')}\n\n`;
        output += `评分：${member.score.toFixed(1)}/10\n\n${member.summary}\n`;
    }
    return output;
}

function buildDailyAggregates({ inputs, date = null } = {}) {
    return formatDailyAggregates(inputs, date, false);
}

// 只有已核验的原保存汇总可以选择旧格式；普通生成入口始终写新版。
function formatDailyAggregates(inputs, date, legacy) {
    const { state, inventory } = inputs.topology; const pages = inventory.ledger.pages;
    const rendererImplementationShas = [...new Set(inputs.stagedRuns
        .map(item => item.manifest.rendererImplementationSha256))];
    if (rendererImplementationShas.length !== 1 || !SHA_RE.test(rendererImplementationShas[0] || '')
        || inputs.rendererImplementationSha256 !== undefined
            && inputs.rendererImplementationSha256 !== rendererImplementationShas[0]) {
        fail('每日汇总缺少有效的页面生成器实现指纹，或所用指纹不一致。');
    }
    const cohorts = [...new Set(state.source.papers.filter(page => page.scope.type === 'daily').map(page => page.cohortDate))].sort();
    const dates = date === null ? cohorts : cohorts.includes(date) ? [date] : [];
    if (!dates.length) fail('页面对应表中没有所请求日期的论文。');
    const selectedPages = state.source.papers.filter(page => page.scope.type === 'daily' && dates.includes(page.cohortDate));
    const byPage = new Map(inputs.stagedPages.map(item => [item.pageKey, item]));
    if (byPage.size !== inputs.stagedPages.length
        || selectedPages.some(page => !byPage.has(page.pageKey))) fail('生成记录中存在重复页面，或未覆盖所选日期的全部论文页。');
    return dates.map(cohortDate => {
        const paperPages = selectedPages.filter(page => page.cohortDate === cohortDate);
        const summaryPages = pages.filter(page => page.kind === 'daily-summary' && page.scope.type === 'daily' && page.cohortDate === cohortDate);
        if (summaryPages.length !== 1 || !paperPages.length) fail(`日期 ${cohortDate} 必须且只能对应一份待保留的每日汇总页，并至少包含一篇论文页。`);
        const members = paperPages.map(page => {
            const staged = byPage.get(page.pageKey); const assignment = state.assignments[page.pageKey];
            if (!staged || assignment?.status !== 'verified' || staged.paperId !== assignment.sourceAuthority.paperId
                || staged.pagePath !== page.pagePath || staged.primaryUrl !== page.primaryUrl) fail(`日期 ${cohortDate} 的页面 ${page.pageKey} 缺少已核验的对应记录，或论文标识、路径或网址不一致。`);
            return { paperId: staged.paperId, pageKey: staged.pageKey, pagePath: staged.pagePath,
                stagingRunId: staged.stagingRunId, stagingManifestSha256: staged.stagingManifestSha256,
                url: internalUrl(staged.primaryUrl), title: staged.canonical.title, summary: staged.canonical.summary,
                score: staged.canonical.score, analysisSha256: staged.canonical.analysisSha256,
                [legacy ? 'taxonomyAssignmentSha256' : 'tagAssignmentSha256']: staged.canonical.tagAssignmentSha256,
                singlePageContentSha256: staged.contentSha256,
                primaryTaskId: staged.canonical.primaryTaskId, primaryTaskLabel: staged.canonical.primaryTaskLabel,
                primaryMethodId: staged.canonical.primaryMethodId, primaryMethodLabel: staged.canonical.primaryMethodLabel,
                labels: staged.canonical.labels };
        }).sort((left, right) => right.score - left.score || left.paperId.localeCompare(right.paperId)
            || left.pagePath.localeCompare(right.pagePath)).map((item, index) => ({ rank: index + 1, ...item }));
        const registryShas = new Set(paperPages.map(page => byPage.get(page.pageKey).canonical.tagCatalogSha256));
        if (registryShas.size !== 1) fail(`日期 ${cohortDate} 的论文使用了不同的标签词表 SHA。`);
        const summary = summaryPages[0]; const markdown = renderDaily(cohortDate, members, members.flatMap(item => item.labels));
        const stagingRuns = inputs.stagedRuns.map(item => ({ stagingRunId: item.manifest.stagingRunId,
            stagingManifestSha256: item.manifest.manifestSha256,
            stagingManifestFileSha256: item.manifestFileSha256 })).sort((a, b) => a.stagingRunId.localeCompare(b.stagingRunId));
        const body = { contract: legacy ? LEGACY_CONTRACT : CONTRACT, version: legacy ? 1 : VERSION, status: 'complete', date: cohortDate,
            outputPage: { pageKey: summary.pageId, path: summary.path, primaryUrl: summary.primaryUrl,
                previousContentSha256: summary.contentSha256 },
            source: { stagingRuns, stagingSetSha256: stableHash(stagingRuns),
                rendererImplementationSha256: rendererImplementationShas[0],
                crosswalkId: state.crosswalkId, crosswalkStateSha256: state.stateSha256,
                ledgerSha256: inventory.ledger.ledgerSha256, pageSetSha256: inventory.ledger.pageSetSha256,
                [legacy ? 'taxonomyRegistrySha256' : 'tagCatalogSha256']: [...registryShas][0] },
            members, memberSetSha256: stableHash(members), markdown, markdownSha256: sha256(Buffer.from(markdown, 'utf8')) };
        return { ...body, manifestSha256: stableHash(body) };
    });
}

function normalizeDailyAggregate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('每日汇总记录必须为对象。');
    const body = clone(value); delete body.manifestSha256;
    if (!SHA_RE.test(value.manifestSha256 || '') || value.manifestSha256 !== stableHash(body)) fail('每日汇总记录自身的 SHA 缺失、格式无效或与内容不一致。');
    if (value.status !== 'complete' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date || '')
        || typeof value.markdown !== 'string' || value.markdownSha256 !== sha256(Buffer.from(value.markdown, 'utf8'))
        || !Array.isArray(value.members) || !value.members.length || value.memberSetSha256 !== stableHash(value.members)
        || new Set(value.members.map(member => member.pageKey)).size !== value.members.length
        || new Set(value.members.map(member => member.pagePath)).size !== value.members.length) fail('每日汇总记录的完成状态、日期、正文或成员集合的 SHA 无效。');
    const legacy = value.contract === LEGACY_CONTRACT && value.version === 1;
    if (!legacy && !(value.contract === CONTRACT && value.version === VERSION)) fail('每日汇总记录的格式标识和版本不属于支持的组合。');
    if (!legacy && value.members.some(member => !member || typeof member !== 'object' || Array.isArray(member))) fail('新版每日汇总的每个成员必须为对象。');
    const readSha = (record, oldField, newField) => {
        const hasOld = Object.hasOwn(record, oldField); const hasNew = Object.hasOwn(record, newField);
        if (hasOld && hasNew) fail('每日汇总记录不能混用新旧标签字段。');
        if (legacy ? hasNew : hasOld || !hasNew) fail('每日汇总记录的标签字段与格式版本不一致。');
        if (legacy && !hasOld) return;
        const value = record[legacy ? oldField : newField];
        if (typeof value !== 'string' || !SHA_RE.test(value)) fail('每日汇总记录中的标签分配或词表 SHA 格式无效。');
    };
    if (!legacy && (!value.source || typeof value.source !== 'object' || Array.isArray(value.source)
        || !Array.isArray(value.source.stagingRuns)
        || value.source.stagingSetSha256 !== stableHash(value.source.stagingRuns))) fail('新版每日汇总缺少完整的来源记录，或来源集合的 SHA 无效。');
    if (value.source && typeof value.source === 'object') readSha(value.source, 'taxonomyRegistrySha256', 'tagCatalogSha256');
    for (const member of value.members) readSha(member, 'taxonomyAssignmentSha256', 'tagAssignmentSha256');
    return clone(value);
}

function replayDailyAggregate({ inputs, originalAggregate } = {}) {
    const original = normalizeDailyAggregate(originalAggregate);
    const legacy = original.contract === LEGACY_CONTRACT;
    const [rebuilt] = formatDailyAggregates(inputs, original.date, legacy);
    if (stableHash(rebuilt) !== stableHash(original)) fail('每日汇总的原完整记录与当前已核验来源重新计算的结果不一致。');
    return rebuilt;
}

function writeAggregates({ outputRoot, aggregateRunId, aggregates } = {}) {
    if (!UUID_RE.test(String(aggregateRunId || '')) || !Array.isArray(aggregates) || !aggregates.length) fail('aggregateRunId 必须为 UUID v4，且每日汇总结果必须为非空数组。');
    for (const aggregate of aggregates) {
        if (aggregate?.contract !== CONTRACT || aggregate.version !== VERSION) fail('新写入的每日汇总必须使用当前格式。');
        normalizeDailyAggregate(aggregate);
    }
    const root = fresh.assertSafeDirectory(outputRoot, true);
    const runRoot = fresh.assertSafeDirectory(path.join(root, aggregateRunId), true); const outputs = [];
    for (const aggregate of aggregates) {
        const filename = path.join(runRoot, `daily-${aggregate.date}.json`);
        const bytes = Buffer.from(`${JSON.stringify(aggregate, null, 2)}\n`);
        writeImmutableFile(filename, bytes, fail);
        outputs.push({ date: aggregate.date, filename, fileSha256: sha256(bytes) });
    }
    return outputs;
}

module.exports = { PAGE_STAGING_CONTRACT, CONTRACT, LEGACY_CONTRACT, VERSION, UUID_RE, stableHash, strictJson,
    normalizePageStagingManifest, loadCompletedPageStaging, bindTopology, buildDailyPaperDisplayRecord,
    loadAggregateInputs, aggregateRunIdFor, renderDaily, buildDailyAggregates, normalizeDailyAggregate, replayDailyAggregate, writeAggregates };
