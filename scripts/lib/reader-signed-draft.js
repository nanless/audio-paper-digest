'use strict';

const crypto = require('node:crypto');
const { apiReaderV3BindsCanonical } = require('../analysis-engine.js');
const { apiReaderPreInjectionQualityView, parseApiReaderArticleResult, injectApiReaderFigures,
    buildApiReaderEvidenceContext } = require('../deep-analyzer.js');
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

// Pure, synchronous inverse plus production round-trip proof. It does not
// fetch assets, touch candidates, certify new prose, or recover original API
// whitespace/selection syntax discarded by the parser. Only an exact legal
// input representation of the existing signed output can be returned.
function recoverSignedReaderDraft({ paper, sourceDetails, runId }) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId || '')
        || paper?.latestAnalysisAttemptError || !apiReaderV3BindsCanonical(paper)) fail('invalid signed parent or run');
    const id = paper.arxivId || paper.paper_id;
    const { freshSourceDescriptor: descriptor, ...sourceSnapshot } = sourceDetails || {};
    const artifacts = sourceDetails?.structuredArtifacts;
    const { payloadSha256, ...artifactBody } = artifacts || {};
    const provenance = paper.freshRewriteProvenance;
    if (!descriptor || descriptor.version !== 1 || descriptor.contract !== 'fresh-source-cache-v1'
        || descriptor.runId !== runId || descriptor.paperId !== id
        || !validSha(descriptor.sourceSnapshotSha256)
        || sha(JSON.stringify(sourceSnapshot)) !== descriptor.sourceSnapshotSha256
        || sha(String(sourceDetails.text || '')) !== descriptor.sourceSha256
        || sha(JSON.stringify(artifactBody)) !== payloadSha256
        || payloadSha256 !== descriptor.structuredArtifactsSha256
        || artifacts.flattenedTextSha256 !== descriptor.sourceSha256
        || provenance?.contract !== 'fresh-source-analysis-v1' || provenance.runId !== runId
        || provenance.sourceOnly !== true || provenance.oldGeneratedTextIncluded !== false
        || provenance.sourceSha256 !== descriptor.sourceSha256
        || provenance.structuredArtifactsSha256 !== descriptor.structuredArtifactsSha256
        || provenance.sourceSnapshotSha256 !== descriptor.sourceSnapshotSha256
        || stableHash(provenance) !== stableHash(paper.analysisManifest.freshRewriteProvenance)
        || paper.sourceSha256 !== descriptor.sourceSha256
        || paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256 !== payloadSha256) {
        fail('sealed source snapshot or fresh provenance mismatch');
    }
    const plan = paper.apiReaderPlan;
    if (!['sections', 'conceptBridges', 'figurePlacements', 'formulaBindings', 'tableBindings']
        .every(key => Array.isArray(plan[key]))) fail('signed plan lacks inverse schema arrays');
    let view = apiReaderPreInjectionQualityView(paper.apiReaderArticle, plan, paper.apiReaderFigures);
    const bridges = plan.conceptBridges.map((bridge, index) => {
        const prefix = `**${bridge.terms?.[0]} × ${bridge.terms?.[1]}：**`;
        if (bridge.marker !== `[[CONCEPT_BRIDGE_${index + 1}]]`
            || typeof bridge.explanation !== 'string' || !bridge.explanation.startsWith(prefix)
            || view.split(bridge.explanation).length !== 2
            || !view.split('\n\n').includes(bridge.explanation)) fail(`bridge ${index} lacks a unique exact paragraph/prefix`);
        const remainder = bridge.explanation.slice(prefix.length);
        const hasSingleSpace = remainder.startsWith(' ');
        const body = hasSingleSpace ? remainder.slice(1) : remainder;
        if (!body || /^\s/.test(body)) fail(`bridge ${index} has ambiguous prefix spacing`);
        view = view.replace(bridge.explanation, bridge.marker);
        // The assembler adds one heading plus a space. A historical no-space
        // signed bridge can only round-trip by retaining its exact heading:
        // production's existing duplicate-heading collapse then retains the
        // original last-heading boundary. Never rewrite the signed paragraph
        // or waive the final article/plan/figure byte-equality checks below.
        return { ...pick(bridge, ['terms', 'sectionKind', 'marker']),
            explanation: hasSingleSpace ? body : bridge.explanation };
    });
    const headings = [...view.matchAll(/^### ([^\n]+)\n\n/gm)];
    if (!Array.isArray(plan.sections) || headings.length !== plan.sections.length || headings[0]?.index !== 0
        || new Set(plan.sections.map(section => section.heading)).size !== plan.sections.length) fail('section headings are not unique/exact');
    const sections = plan.sections.map((section, index) => {
        if (headings[index][1] !== section.heading) fail(`section ${index} heading differs`);
        const start = headings[index].index + headings[index][0].length;
        const end = index + 1 < headings.length ? headings[index + 1].index - 2 : view.length;
        if (index + 1 < headings.length && view.slice(end, end + 2) !== '\n\n') fail('section boundary differs');
        const body = view.slice(start, end);
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
    const parsed = parseApiReaderArticleResult(JSON.stringify(draft), {
        requiredVersion: 3, requireIntegratedTables: true, minimumIntegratedTables,
        availableFigureOrdinals: paper.apiReaderFigures.map(figure => figure.ordinal),
        requireSourceBindings: true, allowDeterministicQuoteRepair: true,
        structuredArtifacts: artifacts, sourceText: sourceDetails.text
    });
    const roundtrip = injectApiReaderFigures(parsed, artifacts, id);
    if (roundtrip.article !== paper.apiReaderArticle) fail('production round-trip article bytes differ');
    if (stableHash(roundtrip.plan) !== paper.apiReaderPlanSha256) fail('production round-trip plan SHA differs');
    const figureCore = paper.apiReaderFigures.map(figure => Object.fromEntries(Object.entries(figure)
        .filter(([key]) => !MATERIALIZED_KEYS.has(key))));
    if (stableHash(roundtrip.figures) !== stableHash(figureCore)) fail('production round-trip figure bindings differ');
    // Retain the exact already-signed materialization metadata, without any
    // download or assertion of a fresh pixel inspection.
    const replayedFigures = roundtrip.figures.map((figure, index) => ({ ...figure,
        ...Object.fromEntries(Object.entries(paper.apiReaderFigures[index]).filter(([key]) => MATERIALIZED_KEYS.has(key))) }));
    const figuresSha256 = stableHash(replayedFigures);
    if (figuresSha256 !== paper.analysisManifest.stages.apiReaderArticle.figuresSha256) fail('materialized figures SHA differs');
    return { draft: structuredClone(draft), proof: { contract: CONTRACT, runId, paperId: id,
        sourceSha256: descriptor.sourceSha256, sourceSnapshotSha256: descriptor.sourceSnapshotSha256,
        articleSha256: sha(roundtrip.article), planSha256: stableHash(roundtrip.plan), figuresSha256,
        draftSha256: sha(JSON.stringify(draft)), operatorRecovered: true, apiGenerated: false } };
}

module.exports = { CONTRACT, recoverSignedReaderDraft };
