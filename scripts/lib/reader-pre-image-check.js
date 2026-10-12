'use strict';
// 这里只能证明纯文本或封存 DOM 检查仍失败；不把旧像素记录当成本次像素证明。
function checkReaderBeforeImages({ recovered, maxAttempts, hasPendingGrant, hasUnusedAllowance,
    canEscalate, normalizeCandidate, isIndependentFailure, readerAttemptLimit }) {
    if (!recovered?.draft || hasUnusedAllowance || canEscalate) return { action: 'download' };
    const attempts = recovered.attempts;
    if (!Number.isSafeInteger(attempts) || attempts < 0) return { action: 'download' };
    const limit = recovered.explicitReaderRetryRound?.maxResponses
        ?? readerAttemptLimit(maxAttempts, attempts, recovered.draft, 0);
    if (!Number.isSafeInteger(limit) || limit < 1) return { action: 'download' };
    const exhausted = attempts >= limit || recovered.noProgress >= 2 || recovered.validationFailureStreak >= 2;
    if (!exhausted) return { action: 'download' };
    try {
        // 必须重跑当前实现。被新校验器接受的旧失败稿继续原下载及完整验收。
        normalizeCandidate(structuredClone(recovered.draft), recovered.issues || []);
        return { action: 'download' };
    } catch (error) {
        if (!isIndependentFailure(error)) return { action: 'download' };
        // 仅确有纯DOM阻塞且额度耗尽时扫描授权账；未知账也交回原事务核验。
        const pending = typeof hasPendingGrant === 'function' ? hasPendingGrant() : hasPendingGrant;
        return pending ? { action: 'download' } : { action: 'stop', cause: error };
    }
}
module.exports = { checkReaderBeforeImages };
