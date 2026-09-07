'use strict';

// Deterministic daily-summary staging. The existing summary body is never read:
// its inventory record contributes only the retained path/URL and old byte SHA.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const crosswalkApi = require('./page-source-crosswalk.js');
const pageStagingApi = require('./historical-page-staging.js');
const fresh = require('./fresh-rewrite-run.js');

const PAGE_STAGING_CONTRACT = pageStagingApi.CONTRACT;
const CONTRACT = 'historical-daily-aggregate-staging-v1';
const VERSION = 1;
const UUID_RE = fresh.UUID_RE || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const stableHash = fresh.stableHash;
const clone = value => JSON.parse(JSON.stringify(value));

function fail(message) {
    const error = new Error(`Historical daily aggregate rejected: ${message}`);
    error.code = 'HISTORICAL_DAILY_AGGREGATE_INTEGRITY'; error.retryable = false; throw error;
}
function exact(value, keys, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) fail(`${label} has unknown or missing fields`);
}
function boundedText(value, label, maximum = 20000) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > maximum
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail(`${label} must be bounded trimmed text`);
    return value;
}
function strictJson(bytes, label) {
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail(`${label} must be UTF-8 JSON`); }
    const stack = [];
    for (const match of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0]; const top = stack[stack.length - 1];
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            let key; try { key = JSON.parse(token); } catch { fail(`${label} contains invalid JSON`); }
            if (top.keys.has(key)) fail(`${label} contains duplicate JSON key: ${key}`);
            top.keys.add(key); top.expectKey = false;
        }
    }
    let value; try { value = JSON.parse(source); } catch { fail(`${label} contains invalid JSON`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must contain an object`);
    return value;
}
function readRegular(filename, maximum, label) {
    let fd;
    try {
        const before = fs.lstatSync(filename);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) fail(`${label} is unsafe or oversized`);
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size) fail(`${label} changed while opening`);
        const bytes = fs.readFileSync(fd); if (bytes.length !== opened.size) fail(`${label} changed while reading`);
        return { bytes, sha256: sha256(bytes) };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function normalizePageStagingManifest(value, stagingRunId) {
    exact(value, ['contract', 'version', 'stagingRunId', 'crosswalkId', 'crosswalkStateSha256',
        'identityGroupsSha256', 'rendererImplementationSha256', 'createdAt', 'pages', 'pageSetSha256', 'assets', 'assetSetSha256',
        'selectedBindings', 'selectedBindingSha256', 'manifestSha256'], 'page staging manifest');
    if (value.contract !== PAGE_STAGING_CONTRACT || value.version !== pageStagingApi.VERSION
        || value.stagingRunId !== stagingRunId || !UUID_RE.test(value.crosswalkId)
        || !SHA_RE.test(value.crosswalkStateSha256) || !SHA_RE.test(value.identityGroupsSha256)
        || !SHA_RE.test(value.rendererImplementationSha256)
        || !SHA_RE.test(value.assetSetSha256) || !SHA_RE.test(value.selectedBindingSha256)
        || !Array.isArray(value.pages) || !value.pages.length) fail('page staging manifest identity/version is invalid');
    if (Number.isNaN(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) fail('page staging createdAt is invalid');
    const pages = value.pages.map((page, index) => {
        exact(page, ['paperId', 'pageKey', 'pagePath', 'primaryUrl', 'cohortDate', 'sourcePageContentSha256',
            'stagedPath', 'contentSha256', 'analysisRunId', 'analysisFileSha256', 'taxonomyAssignmentSha256',
            'taxonomyFileSha256'], `page staging pages[${index}]`);
        if (!/^arxiv:\d{4}\.\d{4,5}$/.test(page.paperId) || !/^page:[a-f0-9]{64}$/.test(page.pageKey)
            || !/^content\/posts\/[a-zA-Z0-9._/-]+\.md$/.test(page.pagePath)
            || page.stagedPath !== path.posix.join('pages', page.pagePath)
            || !/^\d{4}-\d{2}-\d{2}$/.test(page.cohortDate) || !UUID_RE.test(page.analysisRunId)) fail(`page staging pages[${index}] identity is invalid`);
        for (const field of ['sourcePageContentSha256', 'contentSha256', 'analysisFileSha256',
            'taxonomyAssignmentSha256', 'taxonomyFileSha256']) if (!SHA_RE.test(page[field])) fail(`page staging pages[${index}].${field} is invalid`);
        let url; try { url = new URL(page.primaryUrl); } catch { fail(`page staging pages[${index}] primaryUrl is invalid`); }
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail(`page staging pages[${index}] primaryUrl is unsafe`);
        return clone(page);
    });
    if (new Set(pages.map(item => item.pageKey)).size !== pages.length
        || new Set(pages.map(item => item.stagedPath)).size !== pages.length
        || value.pageSetSha256 !== stableHash(pages)) fail('page staging page set is duplicate or drifted');
    if (!Array.isArray(value.assets)) fail('page staging assets must be an array');
    const assets = value.assets.map((asset, index) => {
        exact(asset, ['path', 'sha256', 'size'], `page staging assets[${index}]`);
        if (!/^(?:static\/images\/papers|static\/data\/papers)\/[A-Za-z0-9._/-]+$/.test(asset.path)
            || path.posix.normalize(asset.path) !== asset.path || !SHA_RE.test(asset.sha256)
            || !Number.isSafeInteger(asset.size) || asset.size < 0 || asset.size > 64 * 1024 * 1024) fail(`page staging assets[${index}] is invalid`);
        return clone(asset);
    });
    if (new Set(assets.map(item => item.path)).size !== assets.length
        || stableHash(assets) !== value.assetSetSha256
        || assets.some((item, index) => index && assets[index - 1].path.localeCompare(item.path) >= 0)) fail('page staging asset set is duplicate, unsorted, or drifted');
    if (!Array.isArray(value.selectedBindings) || !value.selectedBindings.length
        || stableHash(value.selectedBindings) !== value.selectedBindingSha256) fail('page staging selected bindings drifted');
    const body = clone(value); delete body.manifestSha256;
    if (!SHA_RE.test(value.manifestSha256) || value.manifestSha256 !== stableHash(body)) fail('page staging manifest self-SHA drifted');
    return clone(value);
}

function loadCompletedPageStaging({ stagingRoot, stagingRunId } = {}) {
    if (typeof stagingRoot !== 'string' || !path.isAbsolute(stagingRoot) || !UUID_RE.test(String(stagingRunId || ''))) {
        fail('configured staging root and UUID v4 stagingRunId are required');
    }
    const root = fresh.assertSafeDirectory(stagingRoot); const runRoot = fresh.assertSafeDirectory(path.join(root, stagingRunId));
    const manifestLoaded = readRegular(path.join(runRoot, 'manifest.json'), 16 * 1024 * 1024, 'page staging manifest');
    const manifest = normalizePageStagingManifest(strictJson(manifestLoaded.bytes, 'page staging manifest'), stagingRunId);
    for (const page of manifest.pages) {
        const filename = path.resolve(runRoot, ...page.stagedPath.split('/'));
        if (!filename.startsWith(`${runRoot}${path.sep}`)) fail('staged page path escapes its run');
        const loaded = readRegular(filename, 32 * 1024 * 1024, `staged page ${page.pageKey}`);
        if (loaded.sha256 !== page.contentSha256) fail(`staged page bytes drifted for ${page.pageKey}`);
    }
    for (const asset of manifest.assets) {
        const filename = path.resolve(runRoot, 'assets', ...asset.path.split('/'));
        if (!filename.startsWith(`${path.join(runRoot, 'assets')}${path.sep}`)) fail('staged asset path escapes its run');
        const loaded = readRegular(filename, 64 * 1024 * 1024, `staged asset ${asset.path}`);
        if (loaded.bytes.length !== asset.size || loaded.sha256 !== asset.sha256) fail(`staged asset bytes drifted for ${asset.path}`);
    }
    return { runRoot, manifest, manifestFileSha256: manifestLoaded.sha256 };
}

function bindTopology({ crosswalkRoot, crosswalkId, inventoryRoot } = {}) {
    const state = crosswalkApi.readCrosswalk({ crosswalkRoot, crosswalkId });
    const handle = crosswalkApi.loadHistoricalInventoryHandle({ inventoryRoot,
        ledgerName: state.source.ledgerName, receiptName: state.source.receiptName });
    const inventory = crosswalkApi.inventoryHandleSnapshot(handle);
    if (stableHash(crosswalkApi.sourceBinding(inventory)) !== stableHash(state.source)) fail('inventory differs from crosswalk source binding');
    return { state, inventory };
}

function canonicalProjection(paper, taxonomy) {
    if (!paper || typeof paper !== 'object' || typeof paper.analysis !== 'string' || !paper.analysis.trim()
        || !paper.parsed || typeof paper.parsed !== 'object') fail('completed canonical paper is missing parsed analysis');
    const reparsed = require('../utils.js').parseAnalysis(paper.analysis);
    if (!reparsed || stableHash({ summary: String(reparsed.summary || '').trim(), score: String(reparsed.score ?? '').trim() })
        !== stableHash({ summary: String(paper.parsed.summary || '').trim(), score: String(paper.parsed.score ?? '').trim() })) {
        fail('cached summary/score drifted from canonical analysis');
    }
    const title = boundedText(paper.title, 'canonical title', 2000);
    const summary = boundedText(reparsed.summary, 'canonical core summary', 20000);
    const score = Number(reparsed.score);
    if (!Number.isFinite(score) || score < 0 || score > 10) fail('canonical score is invalid');
    if (!taxonomy || taxonomy.status !== 'assigned' || !Array.isArray(taxonomy.concepts)) fail('assigned taxonomy is required');
    const concepts = taxonomy.concepts.map((concept, index) => {
        const label = boundedText(concept?.preferredLabel?.zh, `taxonomy concept[${index}] Chinese label`, 200);
        if (typeof concept.id !== 'string' || typeof concept.facet !== 'string') fail(`taxonomy concept[${index}] is invalid`);
        return { id: concept.id, facet: concept.facet, label };
    });
    const task = concepts.find(item => item.id === taxonomy.primaryTaskId && item.facet === 'task');
    const method = concepts.find(item => item.id === taxonomy.primaryMethodId && item.facet === 'method');
    if (!task || !method || new Set(concepts.map(item => item.id)).size !== concepts.length) fail('taxonomy primary task/method projection is incomplete');
    return { title, summary, score, analysisSha256: sha256(Buffer.from(paper.analysis, 'utf8')),
        taxonomyAssignmentSha256: taxonomy.assignmentSha256, taxonomyRegistrySha256: taxonomy.registrySha256,
        primaryTaskId: task.id, primaryTaskLabel: task.label, primaryMethodId: method.id,
        primaryMethodLabel: method.label, labels: concepts.map(item => item.label) };
}

function loadAggregateInputs(options, dependencies = {}) {
    const stagingRunIds = options.stagingRunIds || (options.stagingRunId ? [options.stagingRunId] : []);
    if (!Array.isArray(stagingRunIds) || !stagingRunIds.length || new Set(stagingRunIds).size !== stagingRunIds.length
        || stagingRunIds.some(runId => !UUID_RE.test(runId))) fail('unique staging run IDs are required');
    const stagedRuns = stagingRunIds.map(stagingRunId => (dependencies.loadCompletedPageStaging || loadCompletedPageStaging)({
        stagingRoot: options.stagingRoot, stagingRunId }));
    const crosswalkIds = [...new Set(stagedRuns.map(item => item.manifest.crosswalkId))];
    if (crosswalkIds.length !== 1) fail('all page staging runs must bind the same crosswalk');
    const rendererImplementationShas = [...new Set(stagedRuns
        .map(item => item.manifest.rendererImplementationSha256))];
    if (rendererImplementationShas.length !== 1 || !SHA_RE.test(rendererImplementationShas[0] || '')) {
        fail('all page staging runs must bind the same renderer implementation');
    }
    const topology = (dependencies.bindTopology || bindTopology)({ crosswalkRoot: options.crosswalkRoot,
        crosswalkId: crosswalkIds[0], inventoryRoot: options.inventoryRoot });
    const stagedPages = [];
    for (const staged of stagedRuns) {
        (dependencies.replaySelectedBindings || pageStagingApi.replaySelectedBindings)(staged.manifest, topology.state);
        const analysisRunIds = [...new Set(staged.manifest.pages.map(page => page.analysisRunId))];
        if (analysisRunIds.length !== 1) fail('each page staging manifest must bind exactly one analysis run');
        const projection = (dependencies.loadProjectionInputs || pageStagingApi.loadProjectionInputs)({
            crosswalkRoot: options.crosswalkRoot, crosswalkId: staged.manifest.crosswalkId,
            analysisRoot: options.analysisRoot, taxonomyRoot: options.taxonomyRoot,
            taxonomyRegistry: options.taxonomyRegistry, analysisRunId: analysisRunIds[0] }, dependencies.projectionDependencies || {});
        if (projection.crosswalk.stateSha256 !== topology.state.stateSha256) fail('canonical projection used a different crosswalk state');
        const groups = new Map(projection.groups.map(group => [group.paperId, group]));
        for (const page of staged.manifest.pages) {
            const group = groups.get(page.paperId); const projectedPage = group?.pages.find(item => item.pageKey === page.pageKey);
            if (!group || !projectedPage || projectedPage.pagePath !== page.pagePath || projectedPage.primaryUrl !== page.primaryUrl
                || projectedPage.cohortDate !== page.cohortDate || projectedPage.pageContentSha256 !== page.sourcePageContentSha256
                || group.analysisRunId !== page.analysisRunId || group.analysisFileSha256 !== page.analysisFileSha256
                || group.taxonomy.assignmentSha256 !== page.taxonomyAssignmentSha256
                || group.taxonomyFileSha256 !== page.taxonomyFileSha256) fail(`staging/canonical projection drifted for ${page.pageKey}`);
            stagedPages.push({ ...page, stagingRunId: staged.manifest.stagingRunId,
                stagingManifestSha256: staged.manifest.manifestSha256,
                rendererImplementationSha256: staged.manifest.rendererImplementationSha256,
                canonical: canonicalProjection(group.paper, group.taxonomy) });
        }
    }
    if (new Set(stagedPages.map(page => page.pageKey)).size !== stagedPages.length) fail('page appears in multiple staging manifests');
    return { topology, stagedRuns, stagedPages,
        rendererImplementationSha256: rendererImplementationShas[0] };
}

function aggregateRunIdFor(stagingRunIds) {
    if (!Array.isArray(stagingRunIds) || !stagingRunIds.length || new Set(stagingRunIds).size !== stagingRunIds.length
        || stagingRunIds.some(runId => !UUID_RE.test(runId))) fail('unique staging run IDs are required');
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
    output += `本期共收录 **${members.length}** 篇完成深度分析与重标的论文。\n\n`;
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
    const { state, inventory } = inputs.topology; const pages = inventory.ledger.pages;
    const rendererImplementationShas = [...new Set(inputs.stagedRuns
        .map(item => item.manifest.rendererImplementationSha256))];
    if (rendererImplementationShas.length !== 1 || !SHA_RE.test(rendererImplementationShas[0] || '')
        || inputs.rendererImplementationSha256 !== undefined
            && inputs.rendererImplementationSha256 !== rendererImplementationShas[0]) {
        fail('daily aggregate renderer implementation binding is missing or mixed');
    }
    const cohorts = [...new Set(state.source.papers.filter(page => page.scope.type === 'daily').map(page => page.cohortDate))].sort();
    const dates = date === null ? cohorts : cohorts.includes(date) ? [date] : [];
    if (!dates.length) fail('requested daily cohort is absent from crosswalk');
    const selectedPages = state.source.papers.filter(page => page.scope.type === 'daily' && dates.includes(page.cohortDate));
    const byPage = new Map(inputs.stagedPages.map(item => [item.pageKey, item]));
    if (byPage.size !== inputs.stagedPages.length
        || selectedPages.some(page => !byPage.has(page.pageKey))) fail('staging manifest must exactly cover selected daily paper pages');
    return dates.map(cohortDate => {
        const paperPages = selectedPages.filter(page => page.cohortDate === cohortDate);
        const summaryPages = pages.filter(page => page.kind === 'daily-summary' && page.scope.type === 'daily' && page.cohortDate === cohortDate);
        if (summaryPages.length !== 1 || !paperPages.length) fail(`${cohortDate} must have one retained daily summary and paper pages`);
        const members = paperPages.map(page => {
            const staged = byPage.get(page.pageKey); const assignment = state.assignments[page.pageKey];
            if (!staged || assignment?.status !== 'verified' || staged.paperId !== assignment.sourceAuthority.paperId
                || staged.pagePath !== page.pagePath || staged.primaryUrl !== page.primaryUrl) fail(`${cohortDate} staging identity/path differs for ${page.pageKey}`);
            return { paperId: staged.paperId, pageKey: staged.pageKey, pagePath: staged.pagePath,
                stagingRunId: staged.stagingRunId, stagingManifestSha256: staged.stagingManifestSha256,
                url: internalUrl(staged.primaryUrl), title: staged.canonical.title, summary: staged.canonical.summary,
                score: staged.canonical.score, analysisSha256: staged.canonical.analysisSha256,
                taxonomyAssignmentSha256: staged.canonical.taxonomyAssignmentSha256,
                singlePageContentSha256: staged.contentSha256,
                primaryTaskId: staged.canonical.primaryTaskId, primaryTaskLabel: staged.canonical.primaryTaskLabel,
                primaryMethodId: staged.canonical.primaryMethodId, primaryMethodLabel: staged.canonical.primaryMethodLabel,
                labels: staged.canonical.labels };
        }).sort((left, right) => right.score - left.score || left.paperId.localeCompare(right.paperId)
            || left.pagePath.localeCompare(right.pagePath)).map((item, index) => ({ rank: index + 1, ...item }));
        const registryShas = new Set(paperPages.map(page => byPage.get(page.pageKey).canonical.taxonomyRegistrySha256));
        if (registryShas.size !== 1) fail(`${cohortDate} taxonomy registry differs across members`);
        const summary = summaryPages[0]; const markdown = renderDaily(cohortDate, members, members.flatMap(item => item.labels));
        const stagingRuns = inputs.stagedRuns.map(item => ({ stagingRunId: item.manifest.stagingRunId,
            stagingManifestSha256: item.manifest.manifestSha256,
            stagingManifestFileSha256: item.manifestFileSha256 })).sort((a, b) => a.stagingRunId.localeCompare(b.stagingRunId));
        const body = { contract: CONTRACT, version: VERSION, status: 'complete', date: cohortDate,
            outputPage: { pageKey: summary.pageId, path: summary.path, primaryUrl: summary.primaryUrl,
                previousContentSha256: summary.contentSha256 },
            source: { stagingRuns, stagingSetSha256: stableHash(stagingRuns),
                rendererImplementationSha256: rendererImplementationShas[0],
                crosswalkId: state.crosswalkId, crosswalkStateSha256: state.stateSha256,
                ledgerSha256: inventory.ledger.ledgerSha256, pageSetSha256: inventory.ledger.pageSetSha256,
                taxonomyRegistrySha256: [...registryShas][0] },
            members, memberSetSha256: stableHash(members), markdown, markdownSha256: sha256(Buffer.from(markdown, 'utf8')) };
        return { ...body, manifestSha256: stableHash(body) };
    });
}

function writeAggregates({ outputRoot, aggregateRunId, aggregates } = {}) {
    if (!UUID_RE.test(String(aggregateRunId || '')) || !Array.isArray(aggregates) || !aggregates.length) fail('aggregateRunId and aggregates are required');
    const root = fresh.assertSafeDirectory(outputRoot, true);
    const runRoot = fresh.assertSafeDirectory(path.join(root, aggregateRunId), true); const outputs = [];
    for (const aggregate of aggregates) {
        const filename = path.join(runRoot, `daily-${aggregate.date}.json`); const bytes = Buffer.from(`${JSON.stringify(aggregate, null, 2)}\n`); let fd;
        try { fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const existing = readRegular(filename, 64 * 1024 * 1024, `existing daily aggregate ${aggregate.date}`);
            if (!existing.bytes.equals(bytes)) fail(`refuses to overwrite different aggregate ${aggregate.date}`);
        } finally { if (fd !== undefined) fs.closeSync(fd); }
        outputs.push({ date: aggregate.date, filename, fileSha256: sha256(bytes) });
    }
    return outputs;
}

module.exports = { PAGE_STAGING_CONTRACT, CONTRACT, VERSION, UUID_RE, stableHash, strictJson,
    normalizePageStagingManifest, loadCompletedPageStaging, bindTopology, canonicalProjection,
    loadAggregateInputs, aggregateRunIdFor, renderDaily, buildDailyAggregates, writeAggregates };
