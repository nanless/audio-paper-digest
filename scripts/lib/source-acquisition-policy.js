'use strict';
// 抓取前/失败后的“下一步”策略：纯函数，不联网、不写文件，便于测试。

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function beijingParts(nowMs) {
    const date = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
    const shifted = new Date(date.getTime() + BEIJING_OFFSET_MS);
    return {
        date: `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`,
        hour: shifted.getUTCHours()
    };
}

function preflightWarnings({ date, nowMs } = {}) {
    const target = typeof date === 'string' ? date : null;
    const today = beijingParts(nowMs);
    if (!target) return [{ level: 'warn', message: '未提供目标日期；抓取会按当前北京时间处理。' }];
    if (target > today.date) {
        return [{ level: 'warn', message: `目标日 ${target} 尚未到来（今天 ${today.date}），确认日期是否正确。` }];
    }
    if (target < today.date) {
        return [{ level: 'info', message: `目标是历史日期 ${target}；历史维护应使用已有受控数据，而不是重新抓取。` }];
    }
    if (today.hour < 8) {
        return [{ level: 'warn', message: `现在是北京时间 ${today.hour} 点，arXiv 当天公告通常 08:00 后才生成；先运行 npm run source:probe -- --date ${target} 探测，或等待后重试。` }];
    }
    return [];
}

function fetchFailureAdvice(error) {
    const text = String(error && (error.message || error) || '');
    if (/(?<![\d])429(?![\d])|HTTP\s*429|status\s*429|rate.?limit|too many requests/i.test(text)) {
        return ['arXiv 限流：等待 10–30 分钟或降低并发后重试；先运行 npm run source:probe -- --date <DATE> 确认三个入口。'];
    }
    if (/(?<![\d])5\d\d(?![\d])|HTTP\s*5\d{2}|status\s*5\d{2}|bad gateway|service unavailable/i.test(text)) {
        return ['arXiv 服务暂时 5xx：先探测 Atom/OAI/RSS，等待服务恢复后重试。官方 OAI 恢复仅接受 Atom 日期查询及分类前缀查询均为 HTTP 429 的已核验失败链，或原 OAI 失败的受控延续；5xx 本身不满足触发条件。'];
    }
    if (/rss|pubdate|公告|stale/i.test(text)) {
        return ['RSS 公告可能未生成：确认目标日期与当前公告日，探测后等待公告更新。官方 OAI 恢复须有 Atom 日期查询及分类前缀查询均为 HTTP 429 的已核验失败链，或原 OAI 失败的受控延续；过期 RSS 本身不满足触发条件。'];
    }
    return [];
}

module.exports = { beijingParts, preflightWarnings, fetchFailureAdvice };
