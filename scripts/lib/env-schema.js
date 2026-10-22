'use strict';
// .env 的集中 schema：供 config:check 与 doctor 共用，避免两边各写一套必填/范围判断。
// 只描述配置，不读取文件、不写文件、不打印密钥值。

const EXPECTED_MODEL = 'muse-spark-1.3-contributor';

const SECRET_NAMES = new Set([
    'PAPER_ANALYZER_API_KEY', 'PAPER_ANALYZER_FALLBACK_API_KEYS',
    'PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY', 'PAPER_ANALYZER_SECONDARY_API_KEY',
    'PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS', 'PAPER_ANALYZER_SECONDARY_TERTIARY_FALLBACK_API_KEY',
    'KIMI_API_KEY', 'MIMO_API_KEY', 'DEEPSEEK_API_KEY'
]);

function secret(name) {
    return SECRET_NAMES.has(name) || /(?:^|_)(?:API_KEY|API_KEYS|KEYS?|TOKEN|SECRET|PASSWORD)$/.test(name);
}

// type: string | url | proxy | int | bool | csv | path
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
    { name: 'PAPER_DIGEST_BLOG_REPO', required: false, type: 'path', hint: '真实 Hugo 仓库根目录' },
    { name: 'PAPER_DIGEST_BLOG_URL', required: false, type: 'url' },
    { name: 'PAPER_DIGEST_BLOG_BASE_PATH', required: false, type: 'string' },
    { name: 'PD_ANALYSIS_CONCURRENCY', required: false, type: 'int', min: 1, max: 60 },
    { name: 'PD_API_READER_CONCURRENCY', required: false, type: 'int', min: 1, max: 60 },
    { name: 'PD_BLOG_REVIEW_CONCURRENCY', required: false, type: 'int', min: 1, max: 5 },
    { name: 'PD_ANALYSIS_BATCH_MAX_ROUNDS', required: false, type: 'int', min: 1, max: 10 },
    { name: 'PD_ANALYSIS_API_MAX_RETRIES', required: false, type: 'int', min: 1, max: 20 },
    { name: 'PD_API_READER_OVERALL_TIMEOUT_MS', required: false, type: 'int', min: 60000, max: 7200000 },
    { name: 'PD_VISUAL_PLANNER_TIMEOUT_SECONDS', required: false, type: 'int', min: 10, max: 900 },
    { name: 'PD_WORKSPACE_ALLOW_CROSS_ROLE', required: false, type: 'bool' },
    { name: 'PD_STORAGE_RETENTION_DAYS', required: false, type: 'int', min: 1, max: 3650 }
]);

const SCHEMA_BY_NAME = new Map(SCHEMA.map(item => [item.name, item]));

function parseEnvText(text) {
    const entries = {};
    for (const rawLine of String(text == null ? '' : text).split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!match) continue;
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        } else {
            value = value.replace(/\s+#.*$/, '').trim();
        }
        entries[match[1]] = value;
    }
    return entries;
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
            : { ok: 'warn', detail: '未配置（可选）', hint: item.hint };
    }
    switch (item.type) {
    case 'int': {
        const number = Number(value);
        if (!Number.isInteger(number)) return { ok: 'fail', detail: `不是整数：${value}`, hint: item.hint };
        if (item.min !== undefined && number < item.min) return { ok: 'fail', detail: `小于下限 ${item.min}：${number}`, hint: item.hint };
        if (item.max !== undefined && number > item.max) return { ok: 'fail', detail: `大于上限 ${item.max}：${number}`, hint: item.hint };
        return { ok: 'ok', detail: `整数 ${number}` };
    }
    case 'bool':
        if (!/^(?:0|1|true|false|yes|no)$/i.test(value)) return { ok: 'fail', detail: `不是布尔值：${value}`, hint: '用 1/0 或 true/false' };
        return { ok: 'ok', detail: '布尔值合法' };
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
    if (!source.HTTPS_PROXY && !source.HTTP_PROXY) {
        const item = items.find(entry => entry.name === 'HTTPS_PROXY');
        if (item) { item.ok = 'fail'; item.detail = 'HTTPS_PROXY/HTTP_PROXY 都未配置'; item.hint = 'Muse 与 arXiv 必须走项目 HTTP CONNECT 代理'; }
    }
    return { items, unknown };
}

function summarize(items) {
    const counts = { ok: 0, warn: 0, fail: 0 };
    for (const item of items || []) counts[item.ok] = (counts[item.ok] || 0) + 1;
    return counts;
}

module.exports = {
    EXPECTED_MODEL, SECRET_NAMES, SCHEMA, SCHEMA_BY_NAME,
    parseEnvText, validateEntries, validateValue, summarize, secret
};
