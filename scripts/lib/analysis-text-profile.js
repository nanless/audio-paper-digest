'use strict';

const { SHORT_PROCEEDINGS_OPTIONS, isShortProceedingsConference,
    pythonNonWhitespaceCharacters } = require('./conference-extraction-receipt');

// Text length and structured evidence are separate capabilities. A verified PDF
// can supply its complete short text without supplying machine-readable TeX or tables.
function resolveAnalysisTextProfile(paper, sourceDetails, fullText, minimumFullTextChars) {
    const text = String(fullText || '');
    if (text.length > minimumFullTextChars) {
        return { hasFullText: true, analysisConfidence: 'full_text', shortProceedings: false };
    }
    const degraded = { hasFullText: false, analysisConfidence: 'degraded_abstract', shortProceedings: false };
    const conferenceId = paper?.conference?.id;
    const minimum = SHORT_PROCEEDINGS_OPTIONS.minimumTextCharacters;
    if (!isShortProceedingsConference(conferenceId) || text !== sourceDetails?.text
        || pythonNonWhitespaceCharacters(text) < minimum) return degraded;

    const context = require('./conference-analysis-context');
    const active = context.getConferenceAnalysisContext();
    const handle = active?.readerPdfSourceHandle;
    const sources = require('./conference-source-context');
    if (!handle || handle.contract !== sources.CONTRACT || handle.conference?.id !== conferenceId
        || handle.paperId !== paper?.id || active.paperId !== paper.id
        || !handle.analysisReady || !handle.extractionReceipt?.available) return degraded;
    const provider = sources.readerPdfSourceForContext(handle);
    if (!provider || provider.paperId !== paper.id || provider.sourceText !== text
        || provider.structuredArtifactsSha256 !== sourceDetails?.structuredArtifacts?.payloadSha256) return degraded;

    // Rebuild from the actual capability; caller-supplied or copied JSON cannot
    // change the PDF's evidence capabilities while retaining its payload hash.
    const expected = require('./conference-analysis-adapter').sourceDetails(handle);
    if (sources.stableHash(expected) !== sources.stableHash(sourceDetails)
        || sources.stableHash(expected) !== sources.stableHash(active.sourceDetails)) return degraded;
    provider.assertUnchanged();
    return { hasFullText: true, analysisConfidence: 'short_proceedings', shortProceedings: true };
}

module.exports = { resolveAnalysisTextProfile };
