'use strict';

const crypto = require('node:crypto');
const { hasValidApiReaderV3Records } = require('../analysis-engine.js');
const { restoreApiReaderInjectionMarkers, parseApiReaderArticleResult, injectApiReaderFigures,
    buildApiReaderEvidenceContext, normalizeReaderProseFormatting, stableFingerprint } = require('../deep-analyzer.js');
const { stableHash } = require('./fresh-rewrite-run.js');
const { readerRequirements } = require('./reader-contract.js');
const CONTRACT = 'reader-signed-draft-roundtrip-v1';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const validSha = value => /^[a-f0-9]{64}$/.test(String(value || ''));
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
const fail = message => {
    const error = new Error(`Signed Reader inverse refused: ${message}`);
    error.code = 'READER_SIGNED_DRAFT_NOT_REVERSIBLE';
    throw error;
};
const MATERIALIZED_KEYS = new Set(['cachePath', 'assetFilename', 'assetMediaType', 'assetSha256',
    'assetBytes', 'assetWidth', 'assetHeight']);

// 纯同步的逆运算，外加生产往返验证。它不抓取资源、不碰候选、不为新正文背书，
// 也恢复不了解析器丢弃的原始 API 空白/选择语法。
// 只能返回已有签名输出的某种合法精确输入表示。
function reconstructReaderDraftFromVerifiedArticle({ paper, sourceDetails, runId }) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId || '')
        || paper?.latestAnalysisAttemptError || !hasValidApiReaderV3Records(paper)) fail('invalid signed parent or run');
    const id = paper.arxivId || paper.paper_id;
    const { freshSourceDescriptor: descriptor, ...sourceSnapshot } = sourceDetails || {};
    const artifacts = sourceDetails?.structuredArtifacts;
    const { payloadSha256, ...artifactBody } = artifacts || {};
    const analysisSourceRecord = paper.freshRewriteProvenance;
    if (!descriptor || descriptor.version !== 1 || descriptor.contract !== 'fresh-source-cache-v1'
        || descriptor.runId !== runId || descriptor.paperId !== id
        || !validSha(descriptor.sourceSnapshotSha256)
        || sha(JSON.stringify(sourceSnapshot)) !== descriptor.sourceSnapshotSha256
        || sha(String(sourceDetails.text || '')) !== descriptor.sourceSha256
        || (stableFingerprint(artifactBody) !== payloadSha256
            && sha(JSON.stringify(artifactBody)) !== payloadSha256)
        || payloadSha256 !== descriptor.structuredArtifactsSha256
        || artifacts.flattenedTextSha256 !== descriptor.sourceSha256
        || analysisSourceRecord?.contract !== 'fresh-source-analysis-v1' || analysisSourceRecord.runId !== runId
        || analysisSourceRecord.sourceOnly !== true || analysisSourceRecord.oldGeneratedTextIncluded !== false
        || analysisSourceRecord.sourceSha256 !== descriptor.sourceSha256
        || analysisSourceRecord.structuredArtifactsSha256 !== descriptor.structuredArtifactsSha256
        || analysisSourceRecord.sourceSnapshotSha256 !== descriptor.sourceSnapshotSha256
        || stableHash(analysisSourceRecord) !== stableHash(paper.analysisManifest.freshRewriteProvenance)
        || paper.sourceSha256 !== descriptor.sourceSha256
        || paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256 !== payloadSha256) {
        fail('sealed source snapshot or fresh provenance mismatch');
    }
    const plan = paper.apiReaderPlan;
    if (!['sections', 'conceptBridges', 'figurePlacements', 'formulaBindings', 'tableBindings']
        .every(key => Array.isArray(plan[key]))) fail('signed plan lacks inverse schema arrays');
    let articleWithMarkers = restoreApiReaderInjectionMarkers(paper.apiReaderArticle, plan, paper.apiReaderFigures);
    const bridges = plan.conceptBridges.map((bridge, index) => {
        // 解析器先对术语做与拼装后正文相同的表面规范化，再对规范计划签名
        // （例如把阿拉伯数字与中文分开）。从这个规范表面重建精确前缀；
        // 用未规范化的原始术语会让每个本来合法的签名桥接都显得不可逆。
        const formattedTerms = (bridge.terms || []).map(term =>
            normalizeReaderProseFormatting(String(term || '').trim())
        );
        const rawPrefix = `**${formattedTerms[0]} × ${formattedTerms[1]}：**`;
        const normalizedPrefix = normalizeReaderProseFormatting(rawPrefix);
        const prefix = typeof bridge.explanation === 'string'
            && bridge.explanation.startsWith(normalizedPrefix)
            ? normalizedPrefix
            : rawPrefix;
        if (bridge.marker !== `[[CONCEPT_BRIDGE_${index + 1}]]`
            || typeof bridge.explanation !== 'string' || !bridge.explanation.startsWith(prefix)
            || articleWithMarkers.split(bridge.explanation).length !== 2
            || !articleWithMarkers.split('\n\n').includes(bridge.explanation)) fail(`bridge ${index} lacks a unique exact paragraph/prefix`);
        const remainder = bridge.explanation.slice(prefix.length);
        const hasSingleSpace = remainder.startsWith(' ');
        const body = hasSingleSpace ? remainder.slice(1) : remainder;
        if (!body || /^\s/.test(body)) fail(`bridge ${index} has ambiguous prefix spacing`);
        articleWithMarkers = articleWithMarkers.replace(bridge.explanation, bridge.marker);
        // 拼装器会加一个标题和一个空格。历史上的无空格签名桥接只有保留
        // 它精确的标题才能往返：生产环境现有的重复标题合并随后会保留
        // 原来的末标题边界。不要改写已签名段落，也不要放弃下面
        // 正文/计划/插图逐字节相等的检查。
        return { ...pick(bridge, ['terms', 'sectionKind', 'marker']),
            explanation: hasSingleSpace ? body : bridge.explanation };
    });
    const headings = [...articleWithMarkers.matchAll(/^### ([^\n]+)\n\n/gm)];
    if (!Array.isArray(plan.sections) || headings.length !== plan.sections.length || headings[0]?.index !== 0
        || new Set(plan.sections.map(section => section.heading)).size !== plan.sections.length) fail('section headings are not unique/exact');
    const sections = plan.sections.map((section, index) => {
        if (headings[index][1] !== section.heading) fail(`section ${index} heading differs`);
        const start = headings[index].index + headings[index][0].length;
        const end = index + 1 < headings.length ? headings[index + 1].index - 2 : articleWithMarkers.length;
        if (index + 1 < headings.length && articleWithMarkers.slice(end, end + 2) !== '\n\n') fail('section boundary differs');
        const body = articleWithMarkers.slice(start, end);
        if (body !== body.trim()) fail(`section ${index} body is not exact canonical spacing`);
        return { ...pick(section, ['kind', 'heading']), body };
    });
    const draft = { version: 3, ...pick(plan, ['readerTitle', 'oneSentenceThesis']), sections,
        conceptBridges: bridges,
        figurePlacements: plan.figurePlacements.map(value => pick(value, ['figureOrdinal', 'targetKind', 'marker', 'focusPoints'])),
        formulaBindings: plan.formulaBindings.map(value => pick(value, ['formulaOrdinal', 'targetKind', 'marker'])),
        tableBindings: plan.tableBindings.map(value => ({
            ...pick(value, ['tableIndex', 'sourceType', 'sourceTableOrdinal']),
            cellBindings: value.cellBindings.map(cell => pick(cell, ['renderedRow', 'renderedColumn', 'sourceRow', 'sourceColumn'])),
            sourceQuotes: value.sourceQuotes.map(quote => {
                if (sha(quote.quote) !== quote.sourceQuoteSha256) fail('table quote SHA differs');
                return quote.quote;
            })
        })) };
    const evidence = buildApiReaderEvidenceContext('', sourceDetails.text, artifacts, id);
    const availableTableCount = [...evidence.matchAll(/^TABLE_(\d+):/gm)].length;
    const minimumIntegratedTables = readerRequirements({ version: 3, availableTableCount }).minimumTables;
    const parsedReaderResult = parseApiReaderArticleResult(JSON.stringify(draft), {
        requiredVersion: 3, requireIntegratedTables: true, minimumIntegratedTables,
        availableFigureOrdinals: paper.apiReaderFigures.map(figure => figure.ordinal),
        requireSourceBindings: true, allowDeterministicQuoteRepair: true,
        structuredArtifacts: artifacts, sourceText: sourceDetails.text,
        exactSignedBridgeSurfaces: plan.conceptBridges.map(bridge => bridge.explanation)
    });
    const roundtrip = injectApiReaderFigures(parsedReaderResult, artifacts, id);
    if (roundtrip.article !== paper.apiReaderArticle) fail('production round-trip article bytes differ');
    if (stableHash(roundtrip.plan) !== paper.apiReaderPlanSha256) fail('production round-trip plan SHA differs');
    const figureCore = paper.apiReaderFigures.map(figure => Object.fromEntries(Object.entries(figure)
        .filter(([key]) => !MATERIALIZED_KEYS.has(key))));
    if (stableHash(roundtrip.figures) !== stableHash(figureCore)) fail('production round-trip figure bindings differ');
    // 保留已签名的那份生成元数据，原样不动，不下载任何东西，
    // 也不声称重新检查过像素。
    const replayedFigures = roundtrip.figures.map((figure, index) => ({ ...figure,
        ...Object.fromEntries(Object.entries(paper.apiReaderFigures[index]).filter(([key]) => MATERIALIZED_KEYS.has(key))) }));
    const figuresSha256 = stableHash(replayedFigures);
    if (figuresSha256 !== paper.analysisManifest.stages.apiReaderArticle.figuresSha256) fail('materialized figures SHA differs');
    return { draft: structuredClone(draft), proof: { contract: CONTRACT, runId, paperId: id,
        sourceSha256: descriptor.sourceSha256, sourceSnapshotSha256: descriptor.sourceSnapshotSha256,
        articleSha256: sha(roundtrip.article), planSha256: stableHash(roundtrip.plan), figuresSha256,
        draftSha256: sha(JSON.stringify(draft)), operatorRecovered: true, apiGenerated: false } };
}

module.exports = { CONTRACT, reconstructReaderDraftFromVerifiedArticle };
