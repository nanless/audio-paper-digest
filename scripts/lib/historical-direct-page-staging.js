'use strict';

// 使用直接来源运行已保存并核验的来源、分析和论文解读记录生成页面文件。
// historical-page-staging 从页面对应表、旧分析运行和标签分配记录读取输入；
// 本模块使用直接来源运行提供的输入。两种输入必须按各自的规则核验。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const renderer = require('./historical-page-staging.js');

const CONTRACT = 'historical-direct-paper-page-staging-v1';
const VERSION = 1;
const PUBLICATION_SOURCE_CONTRACT = 'historical-direct-publication-source-v1';
const PUBLICATION_METADATA_CONTRACT = 'historical-arxiv-publication-metadata-v1';
const PRIOR_PREPRINT_VERSION_RELATION = 'author-prior-preprint-with-different-title';
const PRIOR_PREPRINT_DISCLOSURE_CONTRACT = 'historical-author-prior-preprint-disclosure-v1';
const PRIOR_PREPRINT_PAPER_ID = 'conference:icml:2026:openreview-forum-id:n1mAjfRDZ6';
const HISTORICAL_ARXIV_VERSION_CONTRACT = 'arxiv-historical-version-source-v1';
const SHA = /^[a-f0-9]{64}$/;

class HistoricalDirectPageStagingError extends Error {
    constructor(message) { super(`历史单篇页面生成被拒绝：${message}`); this.code = 'HISTORICAL_DIRECT_PAGE_STAGING_INTEGRITY'; }
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
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 必须是对象。`);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} 包含未知字段或缺少必需字段。`);
}
function safeDirectory(value, label, create = false) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${label} 必须是绝对目录路径。`);
    const absolute = path.resolve(value); let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part); let stat;
        try { stat = fs.lstatSync(cursor); }
        catch (error) { if (error.code !== 'ENOENT' || !create) throw error; fs.mkdirSync(cursor, { mode: 0o700 }); stat = fs.lstatSync(cursor); }
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} 的路径必须指向目录，且不能包含符号链接：${cursor}`);
    }
    return absolute;
}
function readFile(filename, maximum, label) {
    let fd;
    try {
        const before = fs.lstatSync(filename);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) fail(`${label} 必须是没有符号链接、仅有一个硬链接且大小不超过限制的普通文件。`);
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size) fail(`${label} 打开后的文件与当前路径不对应，或文件类型、链接数量、大小不符合要求。`);
        const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
        if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) fail(`${label} 的读取字节数、文件标识或大小与打开时的记录不一致。`);
        return { bytes, fileSha256: sha256(bytes) };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function parseJson(bytes, label) {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail(`${label} 必须使用有效的 UTF-8 编码，且内容必须是有效的 JSON。`); }
}
function pageProjection(item) {
    if (!item || typeof item !== 'object' || !SHA.test(String(item.projectionSha256 || ''))
        || !Array.isArray(item.pages) || !item.pages.length) fail('直接来源论文的目标页面记录缺失、格式无效或没有页面。');
    const seen = new Set(); const pages = item.pages.map(page => {
        exact(page, ['pageKey', 'pagePath', 'primaryUrl', 'cohortDate', 'scope', 'pageContentSha256', 'mapping', 'historicalArxivLink'], '直接来源论文的目标页面记录');
        if (!/^page:[a-f0-9]{64}$/.test(String(page.pageKey || '')) || seen.has(page.pageKey)
            || typeof page.pagePath !== 'string' || !/^content\/posts\/[A-Za-z0-9._/-]+\.md$/.test(page.pagePath)
            || path.posix.normalize(page.pagePath) !== page.pagePath || page.pagePath.split('/').includes('..')
            || typeof page.primaryUrl !== 'string' || !/^https:\/\//.test(page.primaryUrl)
            || !/^\d{4}-\d{2}-\d{2}$/.test(String(page.cohortDate || '')) || !SHA.test(String(page.pageContentSha256 || ''))) {
            fail('目标页面的标识、路径、HTTPS 网址、日期格式或原页面 SHA 无效，或页面标识重复。');
        }
        seen.add(page.pageKey); return { pageKey: page.pageKey, pagePath: page.pagePath, primaryUrl: page.primaryUrl,
            cohortDate: page.cohortDate, pageContentSha256: page.pageContentSha256 };
    }).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
    return { projectionSha256: item.projectionSha256, pages, pageSetSha256: stableHash(pages) };
}
function renderedPath(page) { return path.posix.join('pages', page.pagePath); }
function safeTarget(root, relative, label) {
    const target = path.resolve(root, ...relative.split('/'));
    if (!target.startsWith(`${root}${path.sep}`)) fail(`${label} 的路径越出了当前页面生成目录。`);
    return target;
}
function directPaper(item, analysis) {
    const paper = clone(analysis);
    paper.directPaperId = item.paperId;
    if (item.route?.kind === 'arxiv-fresh-fetch') paper.arxivId = item.route.arxivId;
    else { delete paper.arxivId; paper.id = item.paperId; }
    return paper;
}
function publicationSourceProof(item, sourceDescriptor, value) {
    if (item?.route?.kind !== 'arxiv-fresh-fetch') {
        if (value !== null && value !== undefined) fail(`论文 ${item?.paperId || 'unknown paper'} 的会议来源不能附带 arXiv 发布来源记录。`);
        return null;
    }
    const hasMetadataSidecar = Object.hasOwn(value || {}, 'metadataSidecar');
    if (!hasMetadataSidecar) fail(`论文 ${item.paperId} 缺少官方论文元数据对应记录。`);
    exact(value, ['contract', 'version', 'paperId', 'sourceSnapshotSha256', 'sourceTextSha256',
        'abstract', 'abstractSha256', ...(hasMetadataSidecar ? ['metadataSidecar'] : [])], `论文 ${item.paperId} 的发布来源记录`);
    if (value.contract !== PUBLICATION_SOURCE_CONTRACT || value.version !== 1
        || value.paperId !== item.paperId
        || value.sourceSnapshotSha256 !== sourceDescriptor?.sourceSnapshotSha256
        || value.sourceTextSha256 !== sourceDescriptor?.textSha256
        || typeof value.abstract !== 'string' || !value.abstract.trim()
        || value.abstract.includes('\0') || /\r/.test(value.abstract)
        || Buffer.byteLength(value.abstract, 'utf8') > 200000
        || value.abstractSha256 !== sha256(Buffer.from(value.abstract, 'utf8'))) {
        fail(`论文 ${item.paperId} 的发布来源记录格式无效，或与来源快照、全文及摘要哈希不一致。`);
    }
    if (hasMetadataSidecar) {
        const proof = value.metadataSidecar;
        exact(proof, ['contract', 'paperId', 'manifestSha256', 'atomResponseSha256', 'metadataRecordSha256',
            'abstractSha256', 'sourceName', 'querySourceId', 'sourceManifestSha256', 'sourceSnapshotSha256',
            'sourceTextSha256', 'sourceId', 'entryVersion', 'entryUpdatedAt', 'publishedAt', 'observedAt',
            'sourceCapturedAt', 'sourceEarliestCapturedAt', 'sourceLatestCapturedAt', 'generation'], `论文 ${item.paperId} 的元数据对应记录`);
        const sourceVersion = String(proof.sourceId || '').match(/v([1-9]\d*)$/i);
        if (proof.contract !== PUBLICATION_METADATA_CONTRACT
            || proof.paperId !== item.paperId
            || !Number.isSafeInteger(proof.entryVersion) || proof.entryVersion < 1
            || ![proof.entryUpdatedAt, proof.publishedAt, proof.observedAt, proof.sourceCapturedAt,
                proof.sourceEarliestCapturedAt, proof.sourceLatestCapturedAt]
                .every(item => typeof item === 'string' && Number.isFinite(Date.parse(item))
                    && new Date(item).toISOString() === item)
            || Date.parse(proof.publishedAt) > Date.parse(proof.entryUpdatedAt)
            || Date.parse(proof.entryUpdatedAt) > Date.parse(proof.observedAt)
            || Date.parse(proof.entryUpdatedAt) > Date.parse(proof.sourceEarliestCapturedAt)
            || Date.parse(proof.sourceEarliestCapturedAt) > Date.parse(proof.sourceLatestCapturedAt)
            || sourceVersion && Number(sourceVersion[1]) !== proof.entryVersion
            || !sourceVersion && Date.parse(proof.observedAt) < Date.parse(proof.sourceLatestCapturedAt)
            || ![proof.manifestSha256, proof.atomResponseSha256, proof.metadataRecordSha256,
                proof.abstractSha256, proof.sourceManifestSha256].every(item => SHA.test(String(item || '')))
            || proof.abstractSha256 !== value.abstractSha256
            || proof.sourceManifestSha256 !== sourceDescriptor?.sourceManifestSha256
            || proof.sourceSnapshotSha256 !== value.sourceSnapshotSha256
            || proof.sourceTextSha256 !== value.sourceTextSha256
            || proof.sourceId !== sourceDescriptor?.sourceId
            || proof.generation !== sourceDescriptor?.generation
            || proof.querySourceId !== proof.sourceId
            || proof.sourceName !== `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(proof.querySourceId)}&max_results=1`) {
            fail(`论文 ${item.paperId} 的元数据对应记录格式无效，或其来源、版本、时间和哈希与来源记录不一致。`);
        }
    }
    return clone(value);
}
function sourceProof(item, sourceDescriptor, artifact) {
    if (!sourceDescriptor || sourceDescriptor.paperId !== item.paperId || !SHA.test(String(sourceDescriptor.sourceSnapshotSha256 || ''))
        || !SHA.test(String(sourceDescriptor.textSha256 || '')) || !SHA.test(String(sourceDescriptor.structuredArtifactsSha256 || ''))
        || !artifact || artifact.paperId !== item.paperId || artifact.runId !== item.runId || artifact.route !== item.route.kind
        || artifact.sourceSnapshotSha256 !== sourceDescriptor.sourceSnapshotSha256 || !SHA.test(String(artifact.analysisFileSha256 || ''))
        || !SHA.test(String(artifact.analysisRecordSha256 || ''))) fail(`论文 ${item.paperId} 的来源或分析记录缺失、格式无效，或与目标论文、运行和来源快照不一致。`);
    if (item.route.kind === 'arxiv-fresh-fetch' && (!Number.isSafeInteger(sourceDescriptor.generation)
        || !SHA.test(String(sourceDescriptor.sourceManifestSha256 || '')) || !SHA.test(String(sourceDescriptor.sourceRunIdentitySha256 || ''))
        || artifact.sourceGeneration !== sourceDescriptor.generation || artifact.sourceManifestSha256 !== sourceDescriptor.sourceManifestSha256
        || artifact.sourceRunIdentitySha256 !== sourceDescriptor.sourceRunIdentitySha256)) {
        fail(`论文 ${item.paperId} 的 arXiv 来源生成记录格式无效，或其来源清单、运行记录与分析记录不一致。`);
    }
    return clone(sourceDescriptor);
}
function readerProof(item, analysis, artifact, checks = {}) {
    const assertComplete = checks.assertCompleteAnalysis;
    if (assertComplete !== undefined && typeof assertComplete !== 'function') fail('直接来源分析的完整性检查器必须是函数。');
    if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis) || analysis.directPaperId !== item.paperId
        || typeof analysis.analysis !== 'string' || !analysis.analysis.trim() || typeof analysis.apiReaderArticle !== 'string'
        || !analysis.apiReaderArticle.trim() || !SHA.test(String(analysis.apiReaderArticleSha256 || ''))
        || analysis.apiReaderArticleSha256 !== sha256(Buffer.from(analysis.apiReaderArticle, 'utf8'))
        || stableHash(analysis) !== artifact.analysisRecordSha256) {
        fail(`论文 ${item.paperId} 的分析正文、解读文章或对应记录缺失、格式无效，或哈希不一致。`);
    }
    if (assertComplete) assertComplete(analysis, item);
    return { analysisFileSha256: artifact.analysisFileSha256, analysisRecordSha256: artifact.analysisRecordSha256,
        analysisSha256: sha256(Buffer.from(analysis.analysis, 'utf8')), sourceSnapshotSha256: artifact.sourceSnapshotSha256,
        readerArticleSha256: analysis.apiReaderArticleSha256 };
}
function normalizeRendererResult(value, page) {
    const markdown = typeof value === 'string' ? value : value?.markdown;
    const assets = typeof value === 'string' ? [] : value?.assets;
    if (typeof markdown !== 'string' || !markdown.trim() || !Array.isArray(assets)) fail(`页面 ${page.pageKey} 的生成结果必须包含非空 Markdown 正文和资源数组。`);
    return { markdown, assets: assets.map((asset, index) => {
        if (!asset || typeof asset.path !== 'string' || !/^(?:static\/images\/papers|static\/data\/papers)\/[A-Za-z0-9._/-]+$/.test(asset.path)
            || path.posix.normalize(asset.path) !== asset.path || asset.path.split('/').includes('..')
            || typeof asset.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.base64)) {
            fail(`页面 ${page.pageKey} 中索引为 ${index} 的资源路径或 base64 数据格式无效。`);
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
        if (Object.hasOwn(item?.route || {}, 'sourceDisclosure')) fail(`论文 ${item.paperId} 未使用指定的早期预印本来源，不能附带该来源版本说明。`);
        return null;
    }
    exact(disclosure, ['contract', 'version', 'paperId', 'icmlTitle', 'preprintTitle', 'doi', 'versionRelation',
        'sourceKind', 'receiptSelfSha256', 'sourceBindingSha256', 'cameraReady', 'openreviewResponseBytes',
        'statement', 'disclosureSha256'], `论文 ${item.paperId} 的早期预印本说明`);
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
        fail(`论文 ${item.paperId} 的早期预印本说明格式无效，或与允许的论文及来源记录不一致。`);
    }
    return clone(disclosure);
}
function priorPreprintPageDisclosure(item) {
    const disclosure = priorPreprintDisclosureProof(item);
    if (!disclosure) return null;
    const sourceTitle = markdownInline(disclosure.preprintTitle);
    const sourceDoi = markdownInline(disclosure.doi);
    if (!sourceTitle || !sourceDoi) fail(`论文 ${item.paperId} 的早期预印本说明缺少非空来源标题或 DOI。`);
    return [
        '> **⚠️ 来源版本说明（非 Camera-ready）**',
        '>',
        '> 本页分析使用可访问的作者早期预印本，**不是会议 camera-ready 定稿**。',
        `> 预印本标题：${sourceTitle}`,
        `> DOI：${sourceDoi}`,
        '> 标题、内容、实验结果和结论可能与会议最终版本不同；本文不代表已核验 camera-ready 版本。'
    ].join('\n');
}
function arxivHistoricalVersionDisclosureProof(item, sourceDescriptor) {
    const value = sourceDescriptor?.sourceVersion;
    if (!value) return null;
    if (item?.route?.kind !== 'arxiv-fresh-fetch') fail(`论文 ${item?.paperId || 'unknown paper'} 未使用 arXiv 来源，不能附带 arXiv 版本记录。`);
    const normalized = require('./fresh-arxiv-rewrite-source.js')
        .normalizeHistoricalVersionIdentity(value, item.route.arxivId);
    if (normalized.contract !== HISTORICAL_ARXIV_VERSION_CONTRACT
        || sourceDescriptor.sourceId !== normalized.selectedSourceId
        || !SHA.test(String(sourceDescriptor.sourceManifestSha256 || ''))) {
        fail(`论文 ${item.paperId} 的历史 arXiv 版本记录与来源说明不一致，或来源清单 SHA 格式无效。`);
    }
    return normalized;
}
function arxivHistoricalVersionPageDisclosure(item, sourceDescriptor) {
    const disclosure = arxivHistoricalVersionDisclosureProof(item, sourceDescriptor);
    if (!disclosure) return null;
    return [
        '> **⚠️ 来源版本说明（当前稿不可用）**',
        '>',
        `> arXiv 当前无版本 PDF（${markdownInline(disclosure.attemptedCurrentPdfUrl)}）返回 HTTP 404，不能视为当前有效稿件。`,
        `> 本页只封存并分析官方历史版本 **${markdownInline(disclosure.selectedSourceId)}**：${markdownInline(disclosure.selectedPdfUrl)}`,
        '> 文中结论仅对应该历史版本，不得暗示当前稿仍有效或已恢复。'
    ].join('\n');
}
function sourceDisclosureProof(item, sourceDescriptor) {
    return priorPreprintDisclosureProof(item) || arxivHistoricalVersionDisclosureProof(item, sourceDescriptor);
}
function pageDisclosureFor(item, sourceDescriptor) {
    return priorPreprintPageDisclosure(item) || arxivHistoricalVersionPageDisclosure(item, sourceDescriptor);
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
        fail('页面生成器返回的 Hugo 页头缺少结束标记。');
    }
    return `${disclosure.replace(/\n/g, newline)}${newline}${newline}${markdown}`;
}
function hasExactTopDisclosure(markdown, disclosure) {
    if (!disclosure) return true;
    const newline = markdown.startsWith('---\r\n') ? '\r\n' : '\n';
    const normalized = disclosure.replace(/\n/g, newline);
    if (!markdown.startsWith(`---${newline}`)) return markdown.startsWith(`${normalized}${newline}${newline}`);
    const delimiter = `${newline}---${newline}`;
    const closing = markdown.indexOf(delimiter, 3 + newline.length);
    if (closing < 0) return false;
    return markdown.slice(closing + delimiter.length).startsWith(`${normalized}${newline}${newline}`);
}
function buildManifest({ item, projection, source, publicationSource, analysis, sourceDisclosure = null, stagingInputSha256, stagingBindingSha256,
    rendererImplementationSha256, pages, assets }) {
    const body = { contract: CONTRACT, version: VERSION, status: 'complete', paperId: item.paperId, runId: item.runId,
        route: item.route.kind, rendererImplementationSha256, stagingInputSha256, stagingBindingSha256,
        source, publicationSource, analysis, ...(sourceDisclosure ? { sourceDisclosure } : {}),
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
function validateManifest({ value, item, sourceDescriptor, publicationSource, artifact, analysis, stagingInputSha256, stagingBindingSha256,
    directory, rendererImplementationSha256, assertCompleteAnalysis } = {}) {
    const projection = pageProjection(item); const source = sourceProof(item, sourceDescriptor, artifact);
    const publication = publicationSourceProof(item, sourceDescriptor, publicationSource);
    const reader = readerProof(item, analysis, artifact, { assertCompleteAnalysis });
    const sourceDisclosure = sourceDisclosureProof(item, sourceDescriptor);
    const pageDisclosure = pageDisclosureFor(item, sourceDescriptor);
    const hasSourceDisclosure = Object.hasOwn(value || {}, 'sourceDisclosure');
    exact(value, ['contract', 'version', 'status', 'paperId', 'runId', 'route', 'rendererImplementationSha256', 'stagingInputSha256',
        'stagingBindingSha256', 'source', 'publicationSource', 'analysis', ...(hasSourceDisclosure ? ['sourceDisclosure'] : []),
        'projection', 'pages', 'pageSetSha256', 'assets', 'assetSetSha256', 'manifestSha256'],
    `论文 ${item.paperId} 的页面生成清单`);
    if (value.contract !== CONTRACT || value.version !== VERSION || value.status !== 'complete' || value.paperId !== item.paperId
        || value.runId !== item.runId || value.route !== item.route.kind || value.rendererImplementationSha256 !== rendererImplementationSha256
        || value.stagingInputSha256 !== stagingInputSha256 || value.stagingBindingSha256 !== stagingBindingSha256
        || !SHA.test(String(value.manifestSha256 || '')) || !SHA.test(String(value.pageSetSha256 || ''))
        || !SHA.test(String(value.assetSetSha256 || '')) || !Array.isArray(value.pages) || !Array.isArray(value.assets)) {
        fail(`论文 ${item.paperId} 的页面生成清单格式无效，或论文、运行、来源和生成器记录不一致。`);
    }
    if (Boolean(sourceDisclosure) !== hasSourceDisclosure
        || sourceDisclosure && stableHash(value.sourceDisclosure) !== stableHash(sourceDisclosure)) {
        fail(`论文 ${item.paperId} 的页面生成清单未按要求保存来源版本说明，或说明内容与当前来源不一致。`);
    }
    const body = { ...value }; delete body.manifestSha256;
    if (stableHash(body) !== value.manifestSha256 || stableHash(value.source) !== stableHash(source)
        || stableHash(value.publicationSource) !== stableHash(publication)
        || stableHash(value.analysis) !== stableHash(reader)
        || stableHash(value.projection) !== stableHash({ projectionSha256: projection.projectionSha256, pageSetSha256: projection.pageSetSha256 })
        || stableHash(value.pages) !== value.pageSetSha256 || stableHash(value.assets) !== value.assetSetSha256) {
        fail(`论文 ${item.paperId} 的页面生成清单自身或其中的来源、分析、页面和资源记录哈希不一致。`);
    }
    const expectedByKey = new Map(projection.pages.map(page => [page.pageKey, page])); const seen = new Set();
    for (const page of value.pages) {
        const expected = expectedByKey.get(page?.pageKey);
        if (!expected || seen.has(page.pageKey) || page.pagePath !== expected.pagePath || page.primaryUrl !== expected.primaryUrl
            || page.cohortDate !== expected.cohortDate || page.sourcePageContentSha256 !== expected.pageContentSha256
            || page.stagedPath !== renderedPath(expected) || !SHA.test(String(page.contentSha256 || ''))) {
            fail(`论文 ${item.paperId} 的生成页面记录格式无效、重复，或与目标页面的路径、网址、日期和原页面 SHA 不一致。`);
        }
        const bytes = readFile(safeTarget(directory, page.stagedPath, `论文 ${item.paperId} 的页面文件`), 64 * 1024 * 1024,
            `论文 ${item.paperId} 的生成页面文件`);
        if (bytes.fileSha256 !== page.contentSha256) fail(`论文 ${item.paperId} 的生成页面 SHA 与清单不一致。`);
        if (!hasExactTopDisclosure(bytes.bytes.toString('utf8'), pageDisclosure)) {
            fail(`论文 ${item.paperId} 的来源版本说明缺失、内容不一致或未位于页面正文开头。`);
        }
        seen.add(page.pageKey);
    }
    if (seen.size !== expectedByKey.size) fail(`论文 ${item.paperId} 的生成页面记录未覆盖全部目标页面。`);
    const assets = new Set();
    for (const asset of value.assets) {
        if (!asset || typeof asset.path !== 'string' || assets.has(asset.path) || !SHA.test(String(asset.sha256 || ''))
            || !Number.isSafeInteger(asset.size) || asset.size < 0) fail(`论文 ${item.paperId} 的生成资源记录格式无效，或资源路径重复。`);
        const root = path.join(directory, 'assets'); const bytes = readFile(safeTarget(root, asset.path, `论文 ${item.paperId} 的资源文件`),
            64 * 1024 * 1024, `论文 ${item.paperId} 的生成资源文件`);
        if (bytes.fileSha256 !== asset.sha256 || bytes.bytes.length !== asset.size) fail(`论文 ${item.paperId} 的生成资源 SHA 或字节数与清单不一致。`);
        assets.add(asset.path);
    }
    return clone(value);
}
function stageDirectPages({ item, sourceDescriptor, publicationSource, artifact, analysis, directory, stagingInputSha256, stagingBindingSha256,
    expectedRendererImplementationSha256 = null, dependencies = {} } = {}) {
    const root = safeDirectory(directory, '直接来源论文的页面生成目录', true);
    if (!SHA.test(String(stagingInputSha256 || '')) || !SHA.test(String(stagingBindingSha256 || ''))) fail('直接来源页面生成的输入 SHA 或对应记录 SHA 缺失或格式无效。');
    const rendererImplementationSha256 = renderer.currentRendererImplementationSha256(dependencies);
    if (expectedRendererImplementationSha256 !== null
        && expectedRendererImplementationSha256 !== rendererImplementationSha256) {
        fail(`论文 ${item?.paperId || 'paper'} 的页面生成器实现指纹与预期指纹不一致。`);
    }
    const manifestFile = path.join(root, 'page-staging-manifest.json');
    if (fs.existsSync(manifestFile)) return validateManifest({ value: parseJson(readFile(manifestFile, 64 * 1024 * 1024,
        `论文 ${item.paperId} 的页面生成清单`).bytes, `论文 ${item.paperId} 的页面生成清单`), item, sourceDescriptor, publicationSource, artifact, analysis,
    stagingInputSha256, stagingBindingSha256, directory: root, rendererImplementationSha256, assertCompleteAnalysis: dependencies.assertCompleteAnalysis });
    const projection = pageProjection(item); const source = sourceProof(item, sourceDescriptor, artifact);
    const publication = publicationSourceProof(item, sourceDescriptor, publicationSource);
    const analysisProof = readerProof(item, analysis, artifact, { assertCompleteAnalysis: dependencies.assertCompleteAnalysis });
    const render = dependencies.renderDirectPage || renderer.defaultRender; const assets = new Map(); const pages = [];
    const sourceDisclosure = sourceDisclosureProof(item, sourceDescriptor);
    const pageDisclosure = pageDisclosureFor(item, sourceDescriptor);
    for (const page of projection.pages) {
        const result = normalizeRendererResult(render({ directStaging: true, paper: directPaper(item, analysis),
            publicationSource: publication, cohortDate: page.cohortDate }), page);
        for (const asset of result.assets) {
            const previous = assets.get(asset.record.path);
            if (previous && previous.record.sha256 !== asset.record.sha256) fail(`页面生成器为论文 ${item.paperId} 的同一资源路径返回了不同内容。`);
            assets.set(asset.record.path, asset);
        }
        const markdown = injectTopDisclosure(result.markdown, pageDisclosure);
        const relative = renderedPath(page); const bytes = Buffer.from(markdown, 'utf8'); const contentSha256 = sha256(bytes);
        if (renderer.writeExact(safeTarget(root, relative, `论文 ${item.paperId} 的生成页面`), bytes) !== contentSha256) {
            fail(`论文 ${item.paperId} 的页面写入 SHA 与待写入内容不一致。`);
        }
        pages.push({ pageKey: page.pageKey, pagePath: page.pagePath, primaryUrl: page.primaryUrl, cohortDate: page.cohortDate,
            sourcePageContentSha256: page.pageContentSha256, stagedPath: relative, contentSha256 });
    }
    for (const asset of assets.values()) {
        const rootAssets = path.join(root, 'assets');
        if (renderer.writeExact(safeTarget(rootAssets, asset.record.path, `论文 ${item.paperId} 的生成资源`), asset.bytes) !== asset.record.sha256) {
            fail(`论文 ${item.paperId} 的资源写入 SHA 与待写入内容不一致。`);
        }
    }
    if (renderer.currentRendererImplementationSha256(dependencies) !== rendererImplementationSha256) {
        fail(`论文 ${item.paperId} 的页面生成期间，生成器的实现指纹发生变化。`);
    }
    const manifest = buildManifest({ item, projection, source, publicationSource: publication,
        analysis: analysisProof, sourceDisclosure,
        stagingInputSha256, stagingBindingSha256,
        rendererImplementationSha256, pages, assets: [...assets.values()].map(asset => asset.record) });
    renderer.writeExact(manifestFile, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
    return validateManifest({ value: manifest, item, sourceDescriptor, publicationSource: publication,
        artifact, analysis, stagingInputSha256, stagingBindingSha256,
        directory: root, rendererImplementationSha256, assertCompleteAnalysis: dependencies.assertCompleteAnalysis });
}

module.exports = { CONTRACT, VERSION, PUBLICATION_SOURCE_CONTRACT, HistoricalDirectPageStagingError,
    stableHash, pageProjection, directPaper, publicationSourceProof,
    sourceProof, readerProof, priorPreprintDisclosureProof, priorPreprintPageDisclosure,
    arxivHistoricalVersionDisclosureProof, arxivHistoricalVersionPageDisclosure,
    sourceDisclosureProof, pageDisclosureFor, injectTopDisclosure, hasExactTopDisclosure,
    buildManifest, receipt, validateManifest, stageDirectPages,
    currentRendererImplementationSha256: dependencies => renderer.currentRendererImplementationSha256(dependencies) };
