'use strict';

// Materialize the page bytes for a sealed direct source-only execution.  This
// is intentionally separate from historical-page-staging: the latter starts
// from crosswalk + legacy fresh-run + taxonomy-assignment inputs, while this
// adapter starts from the direct runner's already sealed source/analysis/Reader
// packet.  Neither path may impersonate the other.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const renderer = require('./historical-page-staging.js');

const CONTRACT = 'historical-direct-paper-page-staging-v1';
const VERSION = 1;
const PRIOR_PREPRINT_VERSION_RELATION = 'author-prior-preprint-with-different-title';
const PRIOR_PREPRINT_DISCLOSURE_CONTRACT = 'historical-author-prior-preprint-disclosure-v1';
const PRIOR_PREPRINT_PAPER_ID = 'conference:icml:2026:openreview-forum-id:n1mAjfRDZ6';
const SHA = /^[a-f0-9]{64}$/;

class HistoricalDirectPageStagingError extends Error {
    constructor(message) { super(`Historical direct page staging rejected: ${message}`); this.code = 'HISTORICAL_DIRECT_PAGE_STAGING_INTEGRITY'; }
}
const fail = message => { throw new HistoricalDirectPageStagingError(message); };
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const stableHash = value => sha256(JSON.stringify(canonical(value)));
const clone = value => structuredClone(value);

function exact(value, fields, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} has unknown or missing fields`);
}
function safeDirectory(value, label, create = false) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${label} must be an absolute directory`);
    const absolute = path.resolve(value); let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part); let stat;
        try { stat = fs.lstatSync(cursor); }
        catch (error) { if (error.code !== 'ENOENT' || !create) throw error; fs.mkdirSync(cursor, { mode: 0o700 }); stat = fs.lstatSync(cursor); }
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`unsafe ${label}: ${cursor}`);
    }
    return absolute;
}
function readFile(filename, maximum, label) {
    let fd;
    try {
        const before = fs.lstatSync(filename);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) fail(`${label} is unsafe or oversized`);
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size) fail(`${label} changed while opening`);
        const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
        if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) fail(`${label} changed while reading`);
        return { bytes, fileSha256: sha256(bytes) };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function parseJson(bytes, label) {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail(`${label} must be UTF-8 JSON`); }
}
function pageProjection(item) {
    if (!item || typeof item !== 'object' || !SHA.test(String(item.projectionSha256 || ''))
        || !Array.isArray(item.pages) || !item.pages.length) fail('direct route page projection is invalid');
    const seen = new Set(); const pages = item.pages.map(page => {
        exact(page, ['pageKey', 'pagePath', 'primaryUrl', 'cohortDate', 'scope', 'pageContentSha256', 'mapping', 'historicalArxivLink'], 'direct page projection');
        if (!/^page:[a-f0-9]{64}$/.test(String(page.pageKey || '')) || seen.has(page.pageKey)
            || typeof page.pagePath !== 'string' || !/^content\/posts\/[A-Za-z0-9._/-]+\.md$/.test(page.pagePath)
            || path.posix.normalize(page.pagePath) !== page.pagePath || page.pagePath.split('/').includes('..')
            || typeof page.primaryUrl !== 'string' || !/^https:\/\//.test(page.primaryUrl)
            || !/^\d{4}-\d{2}-\d{2}$/.test(String(page.cohortDate || '')) || !SHA.test(String(page.pageContentSha256 || ''))) {
            fail('direct page projection entry is invalid');
        }
        seen.add(page.pageKey); return { pageKey: page.pageKey, pagePath: page.pagePath, primaryUrl: page.primaryUrl,
            cohortDate: page.cohortDate, pageContentSha256: page.pageContentSha256 };
    }).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
    return { projectionSha256: item.projectionSha256, pages, pageSetSha256: stableHash(pages) };
}
function renderedPath(page) { return path.posix.join('pages', page.pagePath); }
function safeTarget(root, relative, label) {
    const target = path.resolve(root, ...relative.split('/'));
    if (!target.startsWith(`${root}${path.sep}`)) fail(`${label} escapes staging directory`);
    return target;
}
function directPaper(item, analysis) {
    const paper = clone(analysis);
    paper.directPaperId = item.paperId;
    if (item.route?.kind === 'arxiv-fresh-fetch') paper.arxivId = item.route.arxivId;
    else { delete paper.arxivId; paper.id = item.paperId; }
    return paper;
}
function sourceProof(item, sourceDescriptor, artifact) {
    if (!sourceDescriptor || sourceDescriptor.paperId !== item.paperId || !SHA.test(String(sourceDescriptor.sourceSnapshotSha256 || ''))
        || !SHA.test(String(sourceDescriptor.textSha256 || '')) || !SHA.test(String(sourceDescriptor.structuredArtifactsSha256 || ''))
        || !artifact || artifact.paperId !== item.paperId || artifact.runId !== item.runId || artifact.route !== item.route.kind
        || artifact.sourceSnapshotSha256 !== sourceDescriptor.sourceSnapshotSha256 || !SHA.test(String(artifact.analysisFileSha256 || ''))
        || !SHA.test(String(artifact.analysisRecordSha256 || ''))) fail(`${item.paperId} source/analysis artifact is not sealed`);
    if (item.route.kind === 'arxiv-fresh-fetch' && (!Number.isSafeInteger(sourceDescriptor.generation)
        || !SHA.test(String(sourceDescriptor.sourceManifestSha256 || '')) || !SHA.test(String(sourceDescriptor.sourceRunIdentitySha256 || ''))
        || artifact.sourceGeneration !== sourceDescriptor.generation || artifact.sourceManifestSha256 !== sourceDescriptor.sourceManifestSha256
        || artifact.sourceRunIdentitySha256 !== sourceDescriptor.sourceRunIdentitySha256)) {
        fail(`${item.paperId} arXiv source generation binding is invalid`);
    }
    return clone(sourceDescriptor);
}
function readerProof(item, analysis, artifact, checks = {}) {
    const assertComplete = checks.assertCompleteAnalysis;
    if (assertComplete !== undefined && typeof assertComplete !== 'function') fail('direct analysis completeness checker must be a function');
    if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis) || analysis.directPaperId !== item.paperId
        || typeof analysis.analysis !== 'string' || !analysis.analysis.trim() || typeof analysis.apiReaderArticle !== 'string'
        || !analysis.apiReaderArticle.trim() || !SHA.test(String(analysis.apiReaderArticleSha256 || ''))
        || analysis.apiReaderArticleSha256 !== sha256(Buffer.from(analysis.apiReaderArticle, 'utf8'))
        || stableHash(analysis) !== artifact.analysisRecordSha256) {
        fail(`${item.paperId} sealed complete direct analysis/Reader proof is invalid`);
    }
    if (assertComplete) assertComplete(analysis, item);
    return { analysisFileSha256: artifact.analysisFileSha256, analysisRecordSha256: artifact.analysisRecordSha256,
        analysisSha256: sha256(Buffer.from(analysis.analysis, 'utf8')), sourceSnapshotSha256: artifact.sourceSnapshotSha256,
        readerArticleSha256: analysis.apiReaderArticleSha256 };
}
function normalizeRendererResult(value, page) {
    const markdown = typeof value === 'string' ? value : value?.markdown;
    const assets = typeof value === 'string' ? [] : value?.assets;
    if (typeof markdown !== 'string' || !markdown.trim() || !Array.isArray(assets)) fail(`${page.pageKey} renderer result is incomplete`);
    return { markdown, assets: assets.map((asset, index) => {
        if (!asset || typeof asset.path !== 'string' || !/^(?:static\/images\/papers|static\/data\/papers)\/[A-Za-z0-9._/-]+$/.test(asset.path)
            || path.posix.normalize(asset.path) !== asset.path || asset.path.split('/').includes('..')
            || typeof asset.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.base64)) {
            fail(`${page.pageKey} renderer asset ${index} is unsafe`);
        }
        const bytes = Buffer.from(asset.base64, 'base64');
        return { bytes, record: { path: asset.path, sha256: sha256(bytes), size: bytes.length } };
    }) };
}
function markdownInline(value) {
    return String(value).replace(/\s+/g, ' ').trim().replace(/([\\`*_[\]<>])/g, '\\$1');
}
function priorPreprintDisclosureProof(item) {
    const acquisition = item?.route?.writerInputs?.[0]?.pdf?.acquisition;
    const disclosure = item?.route?.sourceDisclosure;
    if (acquisition?.versionRelation !== PRIOR_PREPRINT_VERSION_RELATION) {
        if (Object.hasOwn(item?.route || {}, 'sourceDisclosure')) fail(`${item.paperId} ordinary source cannot carry a prior-preprint disclosure`);
        return null;
    }
    exact(disclosure, ['contract', 'version', 'paperId', 'icmlTitle', 'preprintTitle', 'doi', 'versionRelation',
        'sourceKind', 'receiptSelfSha256', 'sourceBindingSha256', 'cameraReady', 'openreviewResponseBytes',
        'statement', 'disclosureSha256'], `${item.paperId} prior-preprint disclosure`);
    const body = clone(disclosure); delete body.disclosureSha256;
    if (item.paperId !== PRIOR_PREPRINT_PAPER_ID || disclosure.contract !== PRIOR_PREPRINT_DISCLOSURE_CONTRACT
        || disclosure.version !== 1 || disclosure.paperId !== item.paperId
        || typeof disclosure.icmlTitle !== 'string' || !disclosure.icmlTitle.trim()
        || disclosure.preprintTitle !== acquisition.sourceTitle || disclosure.doi !== acquisition.sourceDoi
        || disclosure.versionRelation !== acquisition.versionRelation || disclosure.sourceKind !== acquisition.sourceKind
        || disclosure.receiptSelfSha256 !== acquisition.receipt?.selfSha256
        || disclosure.sourceBindingSha256 !== item.route.writerInputs[0].sourceBindingSha256
        || disclosure.cameraReady !== false || disclosure.openreviewResponseBytes !== false
        || disclosure.statement !== 'This input is an author prior preprint with a different title; it is neither the ICML camera-ready paper nor OpenReview response bytes.'
        || !SHA.test(String(disclosure.disclosureSha256 || ''))
        || disclosure.disclosureSha256 !== stableHash(body)) {
        fail(`${item.paperId} prior-preprint disclosure is not bound to its source route`);
    }
    return clone(disclosure);
}
function priorPreprintPageDisclosure(item) {
    const disclosure = priorPreprintDisclosureProof(item);
    if (!disclosure) return null;
    const sourceTitle = markdownInline(disclosure.preprintTitle);
    const sourceDoi = markdownInline(disclosure.doi);
    if (!sourceTitle || !sourceDoi) fail(`${item.paperId} prior-preprint disclosure lacks its source title or DOI`);
    return [
        '> **⚠️ 来源版本说明（非 Camera-ready）**',
        '>',
        '> 本页分析使用可访问的作者早期预印本，**不是会议 camera-ready 定稿**。',
        `> 预印本标题：${sourceTitle}`,
        `> DOI：${sourceDoi}`,
        '> 标题、内容、实验结果和结论可能与会议最终版本不同；本文不代表已核验 camera-ready 版本。'
    ].join('\n');
}
function injectTopDisclosure(markdown, disclosure) {
    if (!disclosure) return markdown;
    const newline = markdown.startsWith('---\r\n') ? '\r\n' : '\n';
    if (markdown.startsWith(`---${newline}`)) {
        const delimiter = `${newline}---${newline}`;
        const closing = markdown.indexOf(delimiter, 3 + newline.length);
        if (closing >= 0) {
            const offset = closing + delimiter.length;
            return `${markdown.slice(0, offset)}${disclosure.replace(/\n/g, newline)}${newline}${newline}${markdown.slice(offset)}`;
        }
        fail('renderer emitted an unterminated Hugo front matter block');
    }
    return `${disclosure.replace(/\n/g, newline)}${newline}${newline}${markdown}`;
}
function buildManifest({ item, projection, source, analysis, sourceDisclosure = null, stagingInputSha256, stagingBindingSha256,
    rendererImplementationSha256, pages, assets }) {
    const body = { contract: CONTRACT, version: VERSION, status: 'complete', paperId: item.paperId, runId: item.runId,
        route: item.route.kind, rendererImplementationSha256, stagingInputSha256, stagingBindingSha256,
        source, analysis, ...(sourceDisclosure ? { sourceDisclosure } : {}),
        projection: { projectionSha256: projection.projectionSha256, pageSetSha256: projection.pageSetSha256 },
        pages: pages.slice().sort((left, right) => left.pagePath.localeCompare(right.pagePath)),
        pageSetSha256: stableHash(pages.slice().sort((left, right) => left.pagePath.localeCompare(right.pagePath))),
        assets: assets.slice().sort((left, right) => left.path.localeCompare(right.path)),
        assetSetSha256: stableHash(assets.slice().sort((left, right) => left.path.localeCompare(right.path))) };
    return { ...body, manifestSha256: stableHash(body) };
}
function receipt(manifest) {
    return { manifestSha256: manifest.manifestSha256, rendererImplementationSha256: manifest.rendererImplementationSha256,
        pageSetSha256: manifest.pageSetSha256, assetSetSha256: manifest.assetSetSha256 };
}
function validateManifest({ value, item, sourceDescriptor, artifact, analysis, stagingInputSha256, stagingBindingSha256,
    directory, rendererImplementationSha256, assertCompleteAnalysis } = {}) {
    const projection = pageProjection(item); const source = sourceProof(item, sourceDescriptor, artifact);
    const reader = readerProof(item, analysis, artifact, { assertCompleteAnalysis });
    const sourceDisclosure = priorPreprintDisclosureProof(item);
    const hasSourceDisclosure = Object.hasOwn(value || {}, 'sourceDisclosure');
    exact(value, ['contract', 'version', 'status', 'paperId', 'runId', 'route', 'rendererImplementationSha256', 'stagingInputSha256',
        'stagingBindingSha256', 'source', 'analysis', ...(hasSourceDisclosure ? ['sourceDisclosure'] : []),
        'projection', 'pages', 'pageSetSha256', 'assets', 'assetSetSha256', 'manifestSha256'],
    `${item.paperId} direct page manifest`);
    if (value.contract !== CONTRACT || value.version !== VERSION || value.status !== 'complete' || value.paperId !== item.paperId
        || value.runId !== item.runId || value.route !== item.route.kind || value.rendererImplementationSha256 !== rendererImplementationSha256
        || value.stagingInputSha256 !== stagingInputSha256 || value.stagingBindingSha256 !== stagingBindingSha256
        || !SHA.test(String(value.manifestSha256 || '')) || !SHA.test(String(value.pageSetSha256 || ''))
        || !SHA.test(String(value.assetSetSha256 || '')) || !Array.isArray(value.pages) || !Array.isArray(value.assets)) {
        fail(`${item.paperId} direct page manifest envelope is invalid`);
    }
    if (Boolean(sourceDisclosure) !== hasSourceDisclosure
        || sourceDisclosure && stableHash(value.sourceDisclosure) !== stableHash(sourceDisclosure)) {
        fail(`${item.paperId} direct page manifest source disclosure drifted`);
    }
    const body = { ...value }; delete body.manifestSha256;
    if (stableHash(body) !== value.manifestSha256 || stableHash(value.source) !== stableHash(source)
        || stableHash(value.analysis) !== stableHash(reader)
        || stableHash(value.projection) !== stableHash({ projectionSha256: projection.projectionSha256, pageSetSha256: projection.pageSetSha256 })
        || stableHash(value.pages) !== value.pageSetSha256 || stableHash(value.assets) !== value.assetSetSha256) {
        fail(`${item.paperId} direct page manifest binding SHA drifted`);
    }
    const expectedByKey = new Map(projection.pages.map(page => [page.pageKey, page])); const seen = new Set();
    for (const page of value.pages) {
        const expected = expectedByKey.get(page?.pageKey);
        if (!expected || seen.has(page.pageKey) || page.pagePath !== expected.pagePath || page.primaryUrl !== expected.primaryUrl
            || page.cohortDate !== expected.cohortDate || page.sourcePageContentSha256 !== expected.pageContentSha256
            || page.stagedPath !== renderedPath(expected) || !SHA.test(String(page.contentSha256 || ''))) {
            fail(`${item.paperId} direct rendered page projection drifted`);
        }
        const bytes = readFile(safeTarget(directory, page.stagedPath, `${item.paperId} direct page`), 64 * 1024 * 1024,
            `${item.paperId} direct rendered page`);
        if (bytes.fileSha256 !== page.contentSha256) fail(`${item.paperId} direct rendered page bytes drifted`);
        seen.add(page.pageKey);
    }
    if (seen.size !== expectedByKey.size) fail(`${item.paperId} direct rendered page set is incomplete`);
    const assets = new Set();
    for (const asset of value.assets) {
        if (!asset || typeof asset.path !== 'string' || assets.has(asset.path) || !SHA.test(String(asset.sha256 || ''))
            || !Number.isSafeInteger(asset.size) || asset.size < 0) fail(`${item.paperId} direct staged asset record is invalid`);
        const root = path.join(directory, 'assets'); const bytes = readFile(safeTarget(root, asset.path, `${item.paperId} direct asset`),
            64 * 1024 * 1024, `${item.paperId} direct staged asset`);
        if (bytes.fileSha256 !== asset.sha256 || bytes.bytes.length !== asset.size) fail(`${item.paperId} direct staged asset bytes drifted`);
        assets.add(asset.path);
    }
    return clone(value);
}
function stageDirectPages({ item, sourceDescriptor, artifact, analysis, directory, stagingInputSha256, stagingBindingSha256,
    dependencies = {} } = {}) {
    const root = safeDirectory(directory, 'direct page staging directory', true);
    if (!SHA.test(String(stagingInputSha256 || '')) || !SHA.test(String(stagingBindingSha256 || ''))) fail('direct staging input/binding SHA is invalid');
    const rendererImplementationSha256 = renderer.currentRendererImplementationSha256(dependencies);
    const manifestFile = path.join(root, 'page-staging-manifest.json');
    if (fs.existsSync(manifestFile)) return validateManifest({ value: parseJson(readFile(manifestFile, 64 * 1024 * 1024,
        `${item.paperId} direct page manifest`).bytes, `${item.paperId} direct page manifest`), item, sourceDescriptor, artifact, analysis,
    stagingInputSha256, stagingBindingSha256, directory: root, rendererImplementationSha256, assertCompleteAnalysis: dependencies.assertCompleteAnalysis });
    const projection = pageProjection(item); const source = sourceProof(item, sourceDescriptor, artifact);
    const analysisProof = readerProof(item, analysis, artifact, { assertCompleteAnalysis: dependencies.assertCompleteAnalysis });
    const render = dependencies.renderDirectPage || renderer.defaultRender; const assets = new Map(); const pages = [];
    const sourceDisclosure = priorPreprintDisclosureProof(item);
    const pageDisclosure = priorPreprintPageDisclosure(item);
    for (const page of projection.pages) {
        const result = normalizeRendererResult(render({ directStaging: true, paper: directPaper(item, analysis), cohortDate: page.cohortDate }), page);
        for (const asset of result.assets) {
            const previous = assets.get(asset.record.path);
            if (previous && previous.record.sha256 !== asset.record.sha256) fail(`${item.paperId} direct renderer emitted conflicting asset bytes`);
            assets.set(asset.record.path, asset);
        }
        const markdown = injectTopDisclosure(result.markdown, pageDisclosure);
        const relative = renderedPath(page); const bytes = Buffer.from(markdown, 'utf8'); const contentSha256 = sha256(bytes);
        if (renderer.writeExact(safeTarget(root, relative, `${item.paperId} rendered page`), bytes) !== contentSha256) {
            fail(`${item.paperId} direct rendered page write drifted`);
        }
        pages.push({ pageKey: page.pageKey, pagePath: page.pagePath, primaryUrl: page.primaryUrl, cohortDate: page.cohortDate,
            sourcePageContentSha256: page.pageContentSha256, stagedPath: relative, contentSha256 });
    }
    for (const asset of assets.values()) {
        const rootAssets = path.join(root, 'assets');
        if (renderer.writeExact(safeTarget(rootAssets, asset.record.path, `${item.paperId} rendered asset`), asset.bytes) !== asset.record.sha256) {
            fail(`${item.paperId} direct rendered asset write drifted`);
        }
    }
    if (renderer.currentRendererImplementationSha256(dependencies) !== rendererImplementationSha256) {
        fail(`${item.paperId} historical renderer changed while direct pages were rendering`);
    }
    const manifest = buildManifest({ item, projection, source, analysis: analysisProof, sourceDisclosure,
        stagingInputSha256, stagingBindingSha256,
        rendererImplementationSha256, pages, assets: [...assets.values()].map(asset => asset.record) });
    renderer.writeExact(manifestFile, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
    return validateManifest({ value: manifest, item, sourceDescriptor, artifact, analysis, stagingInputSha256, stagingBindingSha256,
        directory: root, rendererImplementationSha256, assertCompleteAnalysis: dependencies.assertCompleteAnalysis });
}

module.exports = { CONTRACT, VERSION, HistoricalDirectPageStagingError, stableHash, pageProjection, directPaper,
    sourceProof, readerProof, priorPreprintDisclosureProof, priorPreprintPageDisclosure, injectTopDisclosure,
    buildManifest, receipt, validateManifest, stageDirectPages };
