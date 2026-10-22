'use strict';
// .env 的集中 schema：供 config:check 与 doctor 共用，避免两边各写一套必填/范围判断。
// 只描述配置，不读取文件、不写文件、不打印密钥值。

const EXPECTED_MODEL = 'muse-spark-1.3-contributor';

const SECRET_NAMES = new Set([
    'PAPER_ANALYZER_API_KEY', 'PAPER_ANALYZER_FALLBACK_API_KEYS',
    'PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY', 'PAPER_ANALYZER_SECONDARY_API_KEY',
    'PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS', 'PAPER_ANALYZER_SECONDARY_TERTIARY_FALLBACK_API_KEY',
    'KIMI_API_KEY', 'MIMO_API_KEY', 'DEEPSEEK_API_KEY',
    'FEISHU_APP_SECRET', 'WECHAT_APP_SECRET', 'XIAOHONGSHU_COOKIES'
]);

function secret(name) {
    return SECRET_NAMES.has(name) || /(?:^|_)(?:API_KEY|API_KEYS|KEYS?|TOKEN|SECRET|PASSWORD|COOKIES)$/.test(name);
}

// type: string | url | proxy | int | bool | csv | path | model
const SCHEMA = Object.freeze([
    { name: 'PAPER_ANALYZER_API_KEY', required: true, type: 'string', secret: true, hint: '在 .env 填写主账号 key；同池所有 key 等权' },
    { name: 'PAPER_ANALYZER_MODEL', required: true, type: 'model', hint: `应为 ${EXPECTED_MODEL}` },
    { name: 'PAPER_ANALYZER_ENDPOINT', required: true, type: 'url', hint: 'Muse 端点，例如 https://opencode.ai/zen/go/v1' },
    { name: 'PAPER_ANALYZER_FALLBACK_API_KEYS', required: false, type: 'csv', secret: true, hint: '同池更多 key，逗号分隔，顺序不代表优先级' },
    { name: 'PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY', required: false, type: 'csv', secret: true, hint: '同池更多 key（与 fallback 列表合并）' },
    { name: 'PAPER_ANALYZER_SECONDARY_MODEL', required: false, type: 'model', hint: `未配置时回退主模型；如配置应为 ${EXPECTED_MODEL}` },
    { name: 'PAPER_ANALYZER_SECONDARY_ENDPOINT', required: false, type: 'url' },
    { name: 'PAPER_ANALYZER_SECONDARY_API_KEY', required: false, type: 'string', secret: true },
    { name: 'PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS', required: false, type: 'csv', secret: true },
    { name: 'PAPER_ANALYZER_SECONDARY_TERTIARY_FALLBACK_API_KEY', required: false, type: 'csv', secret: true },
    { name: 'HTTPS_PROXY', required: false, type: 'proxy', hint: 'Muse/arXiv 必须走项目 HTTP CONNECT 代理' },
    { name: 'HTTP_PROXY', required: false, type: 'proxy' },
    { name: 'ALL_PROXY', required: false, type: 'string', hint: '可选的 SOCKS 代理（HuggingFace curl 使用）' },
    { name: 'NO_PROXY', required: false, type: 'string' },
    { name: 'PAPER_DIGEST_BLOG_REPO', required: false, type: 'path', hint: '真实 Hugo 仓库根目录' },
    { name: 'PAPER_DIGEST_BLOG_URL', required: false, type: 'url', hint: '站点 posts 根地址（verify:web 拼页面 URL）' },
    { name: 'PAPER_DIGEST_BLOG_REPO_RUN', required: false, type: 'string', hint: 'Pages 部署 workflow 所属仓库 owner/repo（可选）' },
    { name: 'PAPER_DIGEST_BLOG_BASE_PATH', required: false, type: 'string', hint: '站点子路径（可选）' },
    { name: 'PAPER_DIGEST_BLOG_URL', required: false, type: 'url' },
    { name: 'PAPER_DIGEST_BLOG_BASE_PATH', required: false, type: 'string' },
    { name: 'PAPER_DIGEST_GITHUB_REMOTE', required: false, type: 'string' },
    { name: 'PAPER_DIGEST_REPO_URL', required: false, type: 'string' },
    { name: 'PAPER_DIGEST_IMAGE_BASE_URL', required: false, type: 'string' },
    { name: 'PAPER_DIGEST_IMAGE_HOST', required: false, type: 'string' },
    { name: 'PAPER_DIGEST_AUTHOR', required: false, type: 'string' },
    { name: 'FEISHU_APP_ID', required: false, type: 'string' },
    { name: 'FEISHU_APP_SECRET', required: false, type: 'string', secret: true },
    { name: 'WECHAT_APP_ID', required: false, type: 'string' },
    { name: 'WECHAT_APP_SECRET', required: false, type: 'string', secret: true },
    { name: 'WECHAT_THUMB_MEDIA_ID', required: false, type: 'string' },
    { name: 'XIAOHONGSHU_COOKIES', required: false, type: 'string', secret: true },
    { name: 'PD_ANALYSIS_CONCURRENCY', required: false, type: 'int', min: 1 },
    { name: 'PD_API_READER_CONCURRENCY', required: false, type: 'int', min: 1, max: 60 },
    { name: 'PD_FILTER_BATCH_SIZE', required: false, type: 'int', min: 1 },
    { name: 'PD_BLOG_REVIEW_CONCURRENCY', required: false, type: 'int', min: 1, max: 5 },
    { name: 'PD_ANALYSIS_BATCH_MAX_ROUNDS', required: false, type: 'int', min: 1, max: 10 },
    { name: 'PD_ANALYSIS_API_MAX_RETRIES', required: false, type: 'int', min: 1 },
    { name: 'PD_ANALYSIS_API_MAX_TOKENS', required: false, type: 'int', min: 1 },
    { name: 'PD_ANALYSIS_REVISION_MAX_TOKENS', required: false, type: 'int', min: 1 },
    { name: 'PD_ANALYSIS_STRUCTURE_MAX_TOKENS', required: false, type: 'int', min: 1 },
    { name: 'PD_ANALYSIS_CORE_SUMMARY_REPAIR_MAX_TOKENS', required: false, type: 'int', min: 1 },
    { name: 'PD_ANALYSIS_REPAIR_MAX_TOKENS', required: false, type: 'int', min: 1 },
    { name: 'PD_API_READER_MAX_TOKENS', required: false, type: 'int', min: 1 },
    { name: 'PD_API_READER_REPAIR_MAX_TOKENS', required: false, type: 'int', min: 1 },
    { name: 'PD_API_READER_EVIDENCE_MAX_CHARS', required: false, type: 'int', min: 1 },
    { name: 'PD_API_READER_CONTEXT_MAX_CHARS', required: false, type: 'int', min: 1 },
    { name: 'PD_API_READER_OVERALL_TIMEOUT_MS', required: false, type: 'int', min: 1 },
    { name: 'PD_ARXIV_MAX_RESULTS', required: false, type: 'int', min: 1 },
    { name: 'PD_ARXIV_PDF_MAX_BYTES', required: false, type: 'int', min: 1 },
    { name: 'PD_BLOG_REVIEW_CHUNK_CHARS', required: false, type: 'int', min: 1 },
    { name: 'PD_OPENAI_RESPONSES_STREAM', required: false, type: 'bool' },
    { name: 'PD_OPENAI_RESPONSES_REASONING_EFFORT', required: false, type: 'string' },
    { name: 'PD_VISUAL_PLANNER_TIMEOUT_SECONDS', required: false, type: 'int', min: 10, max: 900 },
    { name: 'PD_WORKSPACE_ALLOW_CROSS_ROLE', required: false, type: 'bool' },
    { name: 'PD_STORAGE_RETENTION_DAYS', required: false, type: 'int', min: 1, max: 3650 }
]);

const SCHEMA_BY_NAME = new Map(SCHEMA.map(item => [item.name, item]));
const KNOWN_NAMES = Object.freeze(SCHEMA.map(item => item.name));

// 只有这两个前缀参与拼写纠错分级；其它前缀/无前缀的未知变量记为提示，不阻断。
const SPELLING_PREFIX = /^(?:PAPER_ANALYZER_|PD_)/;

// 与 env-loader.parseEnvFile 保持一致的只读解析：
// - 支持 # 注释行、等号两侧空白、成对引号；
// - 不识别 export，也不剥离未加引号的值后面的行内 #（运行时同样不剥离）；
// - 同名键后者覆盖前者。
function parseEnvText(text) {
    const entries = {};
    for (const rawLine of String(text == null ? '' : text).split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        if (!key) continue;
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        entries[key] = value;
    }
    return entries;
}

function levenshtein(left, right) {
    const a = String(left == null ? '' : left);
    const b = String(right == null ? '' : right);
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
        const current = [i];
        for (let j = 1; j <= b.length; j += 1) {
            current[j] = Math.min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
        previous = current;
    }
    return previous[b.length];
}

// 返回与未知变量编辑距离恰为 1 的已知变量；多个候选时按字典序取第一个，
// 同时返回全部候选，便于诊断输出。
function spellingCandidates(name) {
    const raw = String(name == null ? '' : name);
    if (!SPELLING_PREFIX.test(raw)) return [];
    return KNOWN_NAMES
        .filter(known => known !== raw && Math.abs(known.length - raw.length) <= 1)
        .filter(known => levenshtein(raw, known) === 1)
        .sort();
}

function classifyUnknown(name) {
    const raw = String(name == null ? '' : name);
    const candidates = spellingCandidates(raw);
    if (candidates.length > 0) {
        return { name: raw, ok: 'fail', suggestion: candidates[0], suggestions: candidates,
            detail: `疑似拼写错误：未登记变量 ${raw}，是否想写 ${candidates[0]}？`,
            hint: '核对变量名；拼写错误的变量不会被运行时使用' };
    }
    return { name: raw, ok: 'info', suggestion: null, suggestions: [],
        detail: '未登记变量（不阻断；如属自定义可忽略）', hint: null };
}

function isValidProxy(value) {
    try {
        const parsed = new URL(value);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
    } catch (_) {
        return false;
    }
}

function validateValue(item, rawValue) {
    const value = String(rawValue == null ? '' : rawValue).trim();
    if (!value) {
        return item.required
            ? { ok: 'fail', detail: '缺失（必填）', hint: item.hint }
            : { ok: 'ok', detail: '未配置（可选）', hint: item.hint };
    }
    switch (item.type) {
    case 'int': {
        if (!/^\d+$/.test(value)) return { ok: 'fail', detail: `不是十进制整数：${value}`, hint: item.hint };
        const number = Number.parseInt(value, 10);
        if (item.min !== undefined && number < item.min) return { ok: 'fail', detail: `小于下限 ${item.min}：${number}`, hint: item.hint };
        if (item.max !== undefined && number > item.max) return { ok: 'fail', detail: `大于上限 ${item.max}：${number}`, hint: item.hint };
        return { ok: 'ok', detail: `整数 ${number}` };
    }
    case 'bool':
        if (value !== '0' && value !== '1') return { ok: 'fail', detail: `不是布尔值：${value}`, hint: '运行时只认 1/0' };
        return { ok: 'ok', detail: `布尔值 ${value}` };
    case 'url':
        try {
            const parsed = new URL(value);
            if (!parsed.protocol.startsWith('https:') && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
                return { ok: 'warn', detail: `非 HTTPS：${parsed.protocol}//${parsed.hostname}`, hint: '生产端点应为 HTTPS' };
            }
            return { ok: 'ok', detail: `URL ${parsed.protocol}//${parsed.hostname}` };
        } catch (_) {
            return { ok: 'fail', detail: '不是合法 URL', hint: item.hint };
        }
    case 'proxy':
        return isValidProxy(value)
            ? { ok: 'ok', detail: 'HTTP CONNECT 代理地址合法' }
            : { ok: 'fail', detail: '不是合法 HTTP(S) 代理地址', hint: '例如 http://127.0.0.1:7897' };
    case 'model':
        return value === EXPECTED_MODEL
            ? { ok: 'ok', detail: EXPECTED_MODEL }
            : { ok: 'fail', detail: `当前 ${value}，预期 ${EXPECTED_MODEL}`, hint: `把模型改为 ${EXPECTED_MODEL}` };
    case 'csv':
        return { ok: 'ok', detail: `逗号分隔 ${value.split(',').filter(Boolean).length} 项（值不显示）` };
    case 'path':
    case 'string':
    default:
        return { ok: 'ok', detail: secret(item.name) ? '已配置（值不显示）' : value };
    }
}

function validateEntries(entries, options = {}) {
    const source = entries && typeof entries === 'object' ? entries : {};
    const items = SCHEMA.map(item => {
        const result = validateValue(item, source[item.name]);
        return { name: item.name, type: item.type, required: item.required, secret: secret(item.name), ...result };
    });
    const known = new Set(SCHEMA.map(item => item.name));
    const extraKnown = new Set(options.extraKnown || []);
    const unknown = Object.keys(source).filter(name => !known.has(name) && !extraKnown.has(name)).sort();
    const spelling = [];
    for (const name of unknown) {
        const classified = classifyUnknown(name);
        if (classified.suggestion) spelling.push({ ...classified });
        // 未知变量不改变已登记变量的结果；拼写错误按 fail 计入，其余只提示。
        items.push({ name: classified.name, type: 'unknown', required: false, secret: secret(classified.name),
            ok: classified.ok, detail: classified.detail, hint: classified.hint });
    }
    if (!source.HTTPS_PROXY && !source.HTTP_PROXY && !source.https_proxy && !source.http_proxy) {
        const item = items.find(entry => entry.name === 'HTTPS_PROXY');
        if (item) { item.ok = 'fail'; item.detail = 'HTTPS_PROXY/HTTP_PROXY 都未配置'; item.hint = 'Muse 与 arXiv 必须走项目 HTTP CONNECT 代理'; }
    }
    return { items, unknown, spelling };
}

function summarize(items) {
    const counts = { ok: 0, warn: 0, fail: 0, info: 0 };
    for (const item of items || []) {
        if (Object.prototype.hasOwnProperty.call(counts, item.ok)) counts[item.ok] += 1;
    }
    return counts;
}

module.exports = {
    EXPECTED_MODEL, SECRET_NAMES, SCHEMA, SCHEMA_BY_NAME, KNOWN_NAMES, SPELLING_PREFIX,
    parseEnvText, levenshtein, spellingCandidates, classifyUnknown,
    validateEntries, validateValue, summarize, secret
};
