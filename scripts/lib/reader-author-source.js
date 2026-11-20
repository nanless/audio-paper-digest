'use strict';

const {
    readerAuthorIdentityMatchesSource,
    AUTHOR_VERIFICATION_CACHE_MAX_ENTRIES,
    clearReaderAuthorVerificationCaches,
    getReaderAuthorVerificationCacheStats
} = require('./reader-author-parser.js');

// 当前生产复用资格；每次仍校验原始封存来源后执行有界只读身份核对，不改变旧记录的结构成功、只读页面或历史统计。
function canReuseReaderAuthorInputs(paper, sourceDetails = null) {
    const readerContract = paper?.analysisManifest?.contracts?.apiReaderArticle;
    if (!require('./reader-record-format').isStructuredContract(readerContract)) return true;
    const details = sourceDetails || require('./model-text-sanitization.js').currentModelInputSource(paper);
    if (!details) return false;
    try {
        return readerAuthorIdentityMatchesSource(paper, details);
    } catch (_) {
        return false;
    }
}

module.exports = {
    canReuseReaderAuthorInputs,
    AUTHOR_VERIFICATION_CACHE_MAX_ENTRIES,
    clearReaderAuthorVerificationCaches,
    getReaderAuthorVerificationCacheStats
};
