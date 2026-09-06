'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('node:path');

const scope = new AsyncLocalStorage();

function paperId(paper) { return typeof paper === 'string' ? paper : paper?.id || paper?.conferencePaperId || ''; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function withConferenceAnalysisSource(identity, callback) {
    if (!identity || typeof identity !== 'object' || !/^conference:[a-z0-9-]+:\d{4}:[a-z0-9-]+:[A-Za-z0-9_-]+$/.test(identity.paperId)
        || !identity.sourceDetails || identity.sourceDetails.source !== 'conference_pdf_text'
        || typeof identity.sourceDetails.text !== 'string' || typeof identity.executionDir !== 'string'
        || !path.isAbsolute(identity.executionDir)) {
        throw new Error('Authenticated conference analysis source identity is required');
    }
    return scope.run(Object.freeze({ executionId: identity.executionId, executionDir: path.resolve(identity.executionDir), paperId: identity.paperId,
        sourceDetails: Object.freeze(clone(identity.sourceDetails)) }), callback);
}
function getConferenceAnalysisContext() { return scope.getStore() || null; }
function getConferenceAnalysisSource(paper) {
    const active = scope.getStore();
    if (!active) return null;
    if (paper?.arxivId || paper?.paper_id || paperId(paper) !== active.paperId) {
        throw new Error('Conference analysis refuses arXiv aliases or a different canonical paperId');
    }
    return clone(active.sourceDetails);
}
function conferenceReaderAttemptsDirectory(requestedDirectory = null) {
    const active = scope.getStore();
    if (!active) return requestedDirectory;
    const expected = path.join(active.executionDir, 'reader-attempts');
    if (requestedDirectory && path.resolve(requestedDirectory) !== expected) {
        throw new Error('Conference Reader attempts must stay inside its analysis execution');
    }
    return expected;
}

module.exports = { withConferenceAnalysisSource, getConferenceAnalysisContext,
    getConferenceAnalysisSource, conferenceReaderAttemptsDirectory };
