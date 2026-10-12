'use strict';

// 这里只记录内存中结果对象与待保存稿件的对应关系；读取来源或复制结果时，
// 不应因此启动分析器、修改日志设置或访问文件。
const deferredReaderCandidateTransactions = new WeakMap();

function transferDeferredReaderCandidate(from, to) {
    const transaction = deferredReaderCandidateTransactions.get(from);
    if (!transaction || from === to) return to;
    if (!to || typeof to !== 'object' || Array.isArray(to)) {
        throw new Error('Reader 保存事务需要对应的分析结果对象');
    }
    deferredReaderCandidateTransactions.set(to, transaction);
    deferredReaderCandidateTransactions.delete(from);
    return to;
}

function hasDeferredReaderCandidate(result) {
    return deferredReaderCandidateTransactions.has(result);
}

module.exports = {
    deferredReaderCandidateTransactions,
    transferDeferredReaderCandidate,
    hasDeferredReaderCandidate
};
