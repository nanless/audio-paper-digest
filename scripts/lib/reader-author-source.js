'use strict';

const { readerAuthorIdentityMatchesSource } = require('./reader-author-parser.js');

// 当前生产复用资格；不改变旧记录的结构成功、只读页面或历史统计。
function canReuseReaderAuthorInputs(paper, sourceDetails = null) {
    const readerContract = paper?.analysisManifest?.contracts?.apiReaderArticle;
    if (!['beginner-researcher-v2', 'beginner-researcher-v3'].includes(readerContract)) return true;
    const details = sourceDetails || require('./model-text-sanitization.js').currentModelInputSource(paper);
    if (!details) return false;
    try {
        return readerAuthorIdentityMatchesSource(paper, details);
    } catch (_) {
        return false;
    }
}

module.exports = { canReuseReaderAuthorInputs };
