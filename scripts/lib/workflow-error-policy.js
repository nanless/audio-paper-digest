'use strict';

// Shared classification only; workflow receipts, queues and retry budgets stay with their owners.
const STORAGE_FAILURE_CODES = new Set(['EIO', 'ENOSPC', 'EDQUOT', 'EROFS', 'EMFILE', 'ENFILE', 'EACCES', 'EPERM']);

function findStorageFailure(error) {
    const seen = new Set();
    const inspect = value => {
        if (!value || typeof value !== 'object' || seen.has(value)) return null;
        seen.add(value);
        if (STORAGE_FAILURE_CODES.has(value.code)) return value;
        if (value instanceof AggregateError) for (const cause of value.errors) {
            const found = inspect(cause); if (found) return found;
        }
        for (const key of ['cause', 'errorDetails', 'error']) {
            const found = inspect(value[key]); if (found) return found;
        }
        return null;
    };
    return inspect(error);
}

function classifyFailure(error, now) {
    // 保存错误前，遮掉 URL 和可识别的账号凭据，再限制说明长度。
    const message = String(error?.message || error || '分析失败')
        .replace(/https?:\/\/\S+/gi, '[URL]')
        .replace(/\b(api[_-]?key|authorization|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
        .replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]+/gi, '[REDACTED]').slice(0, 2000);
    const storageFailure = findStorageFailure(error);
    const rawCode = error?.code || storageFailure?.code;
    const code = typeof rawCode === 'string' && /^[A-Z0-9_]{1,100}$/.test(rawCode) ? rawCode : null;
    let category = 'paper';
    // 分析或页面资产保存也可能先于进程状态写入失败；共享磁盘故障不能逐篇重试。
    if (storageFailure) category = 'storage';
    // 以下来源和后处理错误按确切错误码分类，不根据说明文字猜测。
    else if (['CONFERENCE_POSTPROCESS_INTEGRITY', 'CONFERENCE_SOURCE_CONTEXT_INTEGRITY',
        'CONFERENCE_EXTRACTION_RECEIPT_INTEGRITY', 'ARXIV_SOURCE_AUTHORITY_INTEGRITY',
        'FRESH_ANALYSIS_INTEGRITY', 'READER_IMAGE_SOURCE_INTEGRITY'].includes(code)) category = 'integrity';
    else if (/insufficient.balance|GoUsageLimitError|quota.*exhaust|billing|ACCOUNT_POOL.*EXHAUST/i.test(`${code} ${message}`)) category = 'quota';
    // 认证失败同样必须同时认中英文：旧记录存英文，当前消息已汉化。
    // 前半段英文词逐字保持原样，后半段只加「authentication」的对应中文说法「认证失败」。
    // 有意不加「未授权」（unauthorized 的直译）：它出现在 deep-analyzer 的修复指引正文里，
    // 那段正文会被拼进「上一次输出被代码拒绝」这条错误消息，加进去会把单篇拒稿误判成
    // 整批停止的认证失败。
    else if (/HTTP\s*(401|403)\b|authentication|invalid.api.key|unauthorized|认证失败/i.test(message)) category = 'authentication';
    else if (/HTTP\s*429\b|rate.limit/i.test(message)) category = 'rate_limit';
    // Demo 或资源链接检查属于单篇论文的可选依据。某个 Demo 网站无法连接时，
    // 这篇论文要能重试，但不能让整个会议批次停下来，
    // 避免误认为所有分析请求都无法连接服务。
    else if (code === 'DEMO_TRANSIENT_FAILURE') category = 'paper';
    // 未解决的标签分配是确定的逐篇复核条件：它既不会让批次停下，也不会自己重试
    // （得先修好标签），并且通过复核队列报出。
    else if (code === 'CONFERENCE_TAG_REVIEW_REQUIRED'
        // 旧失败记录仍可读取；当前分类名称统一使用 tag_review。
        || code === 'CONFERENCE_TAXONOMY_REVIEW_REQUIRED') category = 'tag_review';
    else if (/^(?:ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|REQUEST_DEADLINE_EXCEEDED|REQUEST_SOCKET_TIMEOUT)$/.test(code)) category = 'paper';
    // 失败分类必须同时认英文和中文消息：旧失败记录里存的是英文，当前消息已汉化。
    // 前半段英文词必须逐字保持原样，否则旧记录的复算结果会变；
    // 后半段是英文词的对应中文说法（代理＝proxy，隧道＝CONNECT tunnel）。
    // 「代理」不能裸写：中文「代理项」指 Unicode surrogate，与 proxy 无关，故用 (?!项) 排除。
    else if (/HTTP\s*5\d\d\b|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|proxy|CONNECT tunnel|代理(?!项)|隧道/i.test(`${code} ${message}`)) category = 'transport';
    else if (/LLM_ACCOUNT_POOL_|model.*not.found|unsupported.model|missing.*API.key|implementation drifted|deep execution config drifted/i.test(`${code} ${message}`)) category = 'configuration';
    else if (code === 'CONFERENCE_SOURCE_UPGRADE_REBIND_REQUIRED') category = 'source_upgrade';
    // 失败分类必须同时认英文和中文消息：旧失败记录里存的是英文，当前消息已汉化。
    // 前半段英文词必须逐字保持原样，否则旧记录的复算结果会变；
    // 后半段是英文词的对应中文说法（不安全／不一致／完整性／已漂移／非规范／SHA 不符）。
    else if (/integrity|SHA.*mismatch|authority.*drift|unsafe|non.canonical|不安全|不一致|完整性|已漂移|非规范|SHA\s*不符/i.test(message)) category = 'integrity';
    // 公共分析层已判定的运行级故障必须原样阻止补派，不能靠错误文案再次猜回单篇失败。
    if (category === 'paper' && error?.scope === 'run') category = 'run';
    const systemic = error?.scope === 'run'
        || ['quota', 'authentication', 'rate_limit', 'transport', 'configuration', 'storage'].includes(category);
    return { category, code, message, systemic,
        retryable: !['quota', 'authentication', 'integrity', 'configuration', 'source_upgrade',
            'tag_review', 'storage', 'run'].includes(category) && error?.scope !== 'run'
            && error?.retryable !== false, at: now };
}

// Reconstruct the typed failure already saved by the shared analysis engine.
// Do not infer run scope, status or retry permission from prose or a fallback.
function analysisFailureFromRecord(record, fallbackMessage = '分析失败') {
    const error = new Error(record.latestAnalysisAttemptError || record.error || fallbackMessage);
    for (const [field, saved] of Object.entries({ code: 'latestAnalysisAttemptErrorCode',
        retryable: 'latestAnalysisAttemptRetryable', category: 'latestAnalysisAttemptErrorCategory',
        status: 'latestAnalysisAttemptErrorStatus', scope: 'latestAnalysisAttemptErrorScope' })) {
        if (Object.hasOwn(record, saved)) error[field] = record[saved];
    }
    return error;
}

module.exports = { findStorageFailure, classifyFailure, analysisFailureFromRecord };
