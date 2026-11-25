'use strict';

// Single-source authorized JSON-pointer paths for Reader node patches across
// daily, conference, signed operator, compatible candidate replay, ordinal patch,
// and manifest generation.
const AUTHORIZED_READER_PATCH_PATH_RE = /^\/(?:readerTitle|oneSentenceThesis|implementationSpecs)$|^\/sections\/(?:0|[1-9]\d*)(?:\/body)?$|^\/conceptBridges\/(?:0|[1-9]\d*)(?:\/explanation)?$|^\/(?:figurePlacements|tableBindings|formulaBindings)\/(?:0|[1-9]\d*)$/;

const AUTHORIZED_READER_PATCH_WITH_FIGURE_QUOTES_RE = /^\/(?:readerTitle|oneSentenceThesis|implementationSpecs)$|^\/sections\/(?:0|[1-9]\d*)(?:\/body)?$|^\/conceptBridges\/(?:0|[1-9]\d*)(?:\/explanation)?$|^\/figurePlacements\/(?:0|[1-9]\d*)(?:\/(?:explanationQuote|leadQuote))?$|^\/(?:tableBindings|formulaBindings)\/(?:0|[1-9]\d*)$/;

function isAuthorizedReaderPatchPath(pointer, { allowFigureQuotes = false } = {}) {
    if (typeof pointer !== 'string') return false;
    return allowFigureQuotes
        ? AUTHORIZED_READER_PATCH_WITH_FIGURE_QUOTES_RE.test(pointer)
        : AUTHORIZED_READER_PATCH_PATH_RE.test(pointer);
}

function isStringValuePatchPath(pointer) {
    return pointer === '/readerTitle'
        || pointer === '/oneSentenceThesis'
        || (typeof pointer === 'string' && (
            pointer.endsWith('/body')
            || pointer.endsWith('/explanation')
            || pointer.endsWith('/explanationQuote')
            || pointer.endsWith('/leadQuote')
        ));
}

module.exports = {
    AUTHORIZED_READER_PATCH_PATH_RE,
    AUTHORIZED_READER_PATCH_WITH_FIGURE_QUOTES_RE,
    isAuthorizedReaderPatchPath,
    isStringValuePatchPath
};
