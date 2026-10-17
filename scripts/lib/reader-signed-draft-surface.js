'use strict';
// Pure representation operations. No source capability, completion, authorship,
// model request or additional allowance is issued by either function.
const crypto = require('node:crypto');
const { stableHash } = require('./fresh-rewrite-run');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
const MATERIALIZED_KEYS = new Set(['cachePath','assetFilename','assetMediaType','assetSha256','assetBytes','assetWidth','assetHeight']);
const fail = message => { throw Object.assign(new Error('Signed Reader inverse refused: ' + message), { code: 'READER_SIGNED_DRAFT_NOT_REVERSIBLE' }); };
function reconstructReaderDraftSurface({paper, paperId}) {
    if (!paper || typeof paperId !== 'string' || !paperId.trim()) fail('explicit surface identity missing');
    const { restoreApiReaderInjectionMarkers, normalizeReaderProseFormatting } = require('../deep-analyzer');
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
        const signedTerms = (bridge.terms || []).map(term => String(term || '').trim());
        const prefixes = [...new Set([signedTerms,formattedTerms].flatMap(terms => {
            const value = `**${terms.join(' × ')}：**`;
            return [value,normalizeReaderProseFormatting(value)];
        }))].filter(prefix => typeof bridge.explanation === 'string' && bridge.explanation.startsWith(prefix));
        if (prefixes.length !== 1) fail(`bridge ${index} lacks an unambiguous signed prefix`);
        const prefix = prefixes[0];
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
    return { draft: structuredClone(draft), articleSha256: sha(paper.apiReaderArticle),
        planSha256: stableHash(plan), figuresSha256: stableHash(paper.apiReaderFigures),
        draftSha256: sha(JSON.stringify(draft)) };
}
function replayReaderDraftSurface({ paper, sourceDetails, paperId, parserOptions = {} }) {
    const { parseApiReaderArticleResult, injectApiReaderFigures, buildApiReaderEvidenceContext } = require('../deep-analyzer');
    const surface = reconstructReaderDraftSurface({paper,paperId}), artifacts = sourceDetails.structuredArtifacts;
    const evidence = buildApiReaderEvidenceContext('', sourceDetails.text, artifacts, paperId);
    const minimumIntegratedTables = require('./reader-contract').readerRequirements({version:3,
        availableTableCount:[...evidence.matchAll(/^TABLE_(\d+):/gm)].length}).minimumTables;
    const parsed = parseApiReaderArticleResult(JSON.stringify(surface.draft), {
        requiredVersion:3, requireIntegratedTables:true, minimumIntegratedTables,
        availableFigureOrdinals:paper.apiReaderFigures.map(figure => figure.ordinal),
        requireSourceBindings:true, allowDeterministicQuoteRepair:true,
        ...parserOptions, structuredArtifacts:artifacts, sourceText:sourceDetails.text,
        exactSignedBridgeSurfaces:paper.apiReaderPlan.conceptBridges.map(bridge => bridge.explanation) });
    const roundtrip = injectApiReaderFigures(parsed, artifacts, paperId);
    const figures = roundtrip.figures.map((figure,index) => ({...figure,
        ...Object.fromEntries(Object.entries(paper.apiReaderFigures[index] || {}).filter(([key]) => MATERIALIZED_KEYS.has(key))) }));
    return { ...surface, roundtrip:{article:roundtrip.article,plan:roundtrip.plan,figures},
        replayArticleSha256:sha(roundtrip.article), replayPlanSha256:stableHash(roundtrip.plan), replayFiguresSha256:stableHash(figures),
        figureCoreMatches:stableHash(roundtrip.figures) === stableHash(paper.apiReaderFigures.map(figure =>
            Object.fromEntries(Object.entries(figure).filter(([key]) => !MATERIALIZED_KEYS.has(key))))) };
}
module.exports = { reconstructReaderDraftSurface, replayReaderDraftSurface };
