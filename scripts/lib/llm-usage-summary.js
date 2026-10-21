'use strict';

// 只读聚合 LLM 用量事件，供状态面板和费用账本使用。
//
// data/runtime/llm-usage 在生产环境是 14 万级文件的平铺目录，每次状态刷新都全量
// 读取既慢又浪费。这里先 readdir、再用文件 mtime 把读取范围限定到目标日期前后，
// 并在进程内缓存目录索引与已解析事件：
//   - 同一个进程里，目录 mtime 未变时直接命中缓存，只花一次 stat；
//   - 目录 mtime 变化时只 stat / 解析新增文件；
//   - 事件文件是只读后不再修改的，因此已解析文件不会失效。
// 事件里的 `at` 才是日期归属的权威值；mtime 只用来决定要不要读这个文件。

const fs = require('node:fs');
const path = require('node:path');

const VERSION = 'llm-usage-summary-v1';
const USAGE_EVENT_VERSION = 'llm-usage-v1';
const DAY_MS = 24 * 60 * 60 * 1000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
// 文件写入时间与事件时间通常只差毫秒；留一段余量容忍时钟偏移和跨盘复制。
const DEFAULT_MTIME_SLACK_MS = 12 * 60 * 60 * 1000;
const MAX_EVENT_BYTES = 512 * 1024;
const MAX_CACHED_DIRECTORIES = 8;

function beijingDateFromMs(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value)) return null;
    return new Date(value + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

function isValidDate(date) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const ms = Date.parse(`${date}T00:00:00+08:00`);
    if (!Number.isFinite(ms)) return false;
    return beijingDateFromMs(ms) === date;
}

function assertDate(date) {
    if (!isValidDate(date)) throw new Error(`日期必须是有效的北京日期 YYYY-MM-DD：${String(date)}`);
    return date;
}

function dateRange(date) {
    assertDate(date);
    const startMs = Date.parse(`${date}T00:00:00+08:00`);
    return { startMs, endMs: startMs + DAY_MS };
}

function eventDate(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const ms = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(ms) ? beijingDateFromMs(ms) : null;
}

function safeLabel(value, fallback = 'unknown') {
    if (value === null || value === undefined) return fallback;
    const text = String(value).trim();
    if (!text) return fallback;
    // 不把控制字符、换行或超长内容带进状态面板；这里只做展示键。
    const cleaned = text.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
    return cleaned || fallback;
}

// 真实 llm-usage 事件当前没有 accountId 字段，所以“按账号”默认不可得，不能伪造
// unknown 分组。写入端以后补上账号时只接受 64 位十六进制指纹；其他形态转成不可逆短指纹，
// 不把原始凭据带进状态面板。
function accountKey(event) {
    const raw = event?.accountId ?? event?.account_id ?? event?.accountKey ?? event?.account_key
        ?? event?.apiKeyId ?? event?.api_key_id ?? event?.keyId ?? event?.account;
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'object') return null;
    const text = String(raw).trim();
    if (!text) return null;
    if (/^[a-f0-9]{64}$/i.test(text)) return text.toLowerCase();
    return `sha256:${require('node:crypto').createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

function costNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
        const parsed = Number(value.trim());
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const key of ['usd', 'USD', 'costUsd', 'cost_usd', 'amount', 'total', 'value', 'cost', 'estimated', 'estimatedUsd']) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
            const parsed = costNumber(value[key]);
            if (parsed !== null) return parsed;
        }
    }
    return null;
}

// 兼容不同调用方可能写入的费用字段：cost / estimatedCost / usage.cost 等。
// 只认明确的金额字段，不拿 token 数猜钱。
function extractCost(event) {
    const candidates = [
        event?.cost,
        event?.estimatedCost,
        event?.estimated_cost,
        event?.totalCost,
        event?.total_cost,
        event?.usageCost,
        event?.usage_cost,
        event?.fee,
        event?.price,
        event?.usage?.cost,
        event?.usage?.estimatedCost,
        event?.usage?.estimated_cost,
        event?.usage?.totalCost,
        event?.usage?.price,
        event?.usage?.fee
    ];
    for (const candidate of candidates) {
        const value = costNumber(candidate);
        if (value !== null) return value;
    }
    return null;
}

function compactUsageRecord(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
    if (event.version !== USAGE_EVENT_VERSION || event.kind !== 'request') return null;
    const date = eventDate(event.at);
    if (!date) return null;
    const eventId = typeof event.eventId === 'string' && event.eventId ? event.eventId : null;
    const cost = extractCost(event);
    return {
        date,
        eventId,
        outcome: safeLabel(event.outcome),
        stage: safeLabel(event.stage),
        model: safeLabel(event.model),
        account: accountKey(event),
        cost
    };
}

function createUsageSummaryCache() {
    return { directories: new Map() };
}

const defaultCache = createUsageSummaryCache();

function emptySummary(date) {
    return {
        version: VERSION,
        date,
        total: 0,
        success: 0,
        failed: 0,
        cost: 0,
        costEvents: 0,
        byStage: {},
        byModel: {},
        byAccount: {}
    };
}

function emptyBucket() {
    return { total: 0, success: 0, failed: 0, cost: 0, costEvents: 0 };
}

function roundCost(value) {
    return Number(Number(value || 0).toFixed(8));
}

function addToBucket(bucket, record) {
    bucket.total += 1;
    if (record.outcome === 'completed') bucket.success += 1;
    else bucket.failed += 1;
    if (record.cost !== null) {
        bucket.cost += record.cost;
        bucket.costEvents += 1;
    }
}

function sortedBuckets(buckets) {
    return Object.fromEntries([...buckets.entries()].sort((left, right) => (
        right[1].total - left[1].total || left[0].localeCompare(right[0])
    )).map(([key, bucket]) => [key, { ...bucket, cost: roundCost(bucket.cost) }]));
}

function aggregateRecords(records, date) {
    const summary = emptySummary(date);
    const byStage = new Map();
    const byModel = new Map();
    const byAccount = new Map();
    const seenEventIds = new Set();
    for (const record of records.values()) {
        if (!record || record.date !== date) continue;
        if (record.eventId) {
            if (seenEventIds.has(record.eventId)) continue;
            seenEventIds.add(record.eventId);
        }
        addToBucket(summary, record);
        for (const [map, key] of [[byStage, record.stage], [byModel, record.model], [byAccount, record.account]]) {
            // 账号字段缺失时不生成分组，也不伪造 unknown。
            if (key === null || key === undefined) continue;
            if (!map.has(key)) map.set(key, emptyBucket());
            addToBucket(map.get(key), record);
        }
    }
    summary.byStage = sortedBuckets(byStage);
    summary.byModel = sortedBuckets(byModel);
    summary.byAccount = sortedBuckets(byAccount);
    summary.cost = roundCost(summary.cost);
    return summary;
}

function listJsonNames(directory) {
    return fs.readdirSync(directory).filter(name => name.endsWith('.json') && !name.startsWith('.'));
}

function readRegularFileStat(filePath) {
    let stat;
    try {
        stat = fs.lstatSync(filePath);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    return stat;
}

function readEventFile(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(text);
}

function noteNewRecord(state, name, record, currentDate) {
    if (!record) return;
    state.records.set(name, record);
    if (record.date !== currentDate && state.days.has(record.date)) {
        // 迟到的旧日期事件（例如复制目录）不能继续沿用旧汇总。
        state.days.delete(record.date);
    }
}

function readCandidate(state, directory, name, counters, knownStat = null) {
    if (state.attempted.has(name)) return;
    state.attempted.add(name);
    const filePath = path.join(directory, name);
    let stat = knownStat;
    if (!stat) {
        try {
            stat = readRegularFileStat(filePath);
        } catch (_error) {
            counters.invalid += 1;
            return;
        }
    }
    if (!stat) return;
    if (stat.size > MAX_EVENT_BYTES) {
        counters.tooLarge += 1;
        return;
    }
    let event;
    try {
        event = readEventFile(filePath);
    } catch (_error) {
        counters.invalid += 1;
        return;
    }
    counters.read += 1;
    noteNewRecord(state, name, compactUsageRecord(event), counters.date);
}

function collectForDate(state, directory, date, fromMs, toMs, counters) {
    for (const [name, mtimeMs] of state.mtimes) {
        if (mtimeMs < fromMs || mtimeMs > toMs) continue;
        if (state.attempted.has(name)) continue;
        counters.date = date;
        readCandidate(state, directory, name, counters);
    }
}

function missingSummary(date) {
    const summary = emptySummary(date);
    return {
        summary,
        scan: {
            directoryMissing: true,
            cacheHit: false,
            filesListed: 0,
            filesStatted: 0,
            filesRead: 0,
            skippedByMtime: 0,
            invalidJson: 0,
            tooLarge: 0
        }
    };
}

function scanForDate({ state, directory, date, slackMs }) {
    let dirStat;
    try {
        dirStat = fs.statSync(directory);
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return missingSummary(date);
        throw error;
    }
    if (!dirStat.isDirectory()) return missingSummary(date);

    if (state && state.dirMtimeMs === dirStat.mtimeMs) {
        if (state.days.has(date)) {
            return {
                state,
                summary: state.days.get(date),
                scan: {
                    directoryMissing: false,
                    cacheHit: true,
                    filesListed: state.mtimes.size,
                    filesStatted: 0,
                    filesRead: 0,
                    skippedByMtime: 0,
                    invalidJson: 0,
                    tooLarge: 0
                }
            };
        }
        // 目录没变但换了一个日期：索引已在内存里，按 mtime 补读目标日期窗口即可。
        const range = dateRange(date);
        const counters = { read: 0, skipped: 0, invalid: 0, tooLarge: 0, date };
        collectForDate(state, directory, date, range.startMs - slackMs, range.endMs + slackMs, counters);
        const summary = aggregateRecords(state.records, date);
        state.days.set(date, summary);
        return {
            state,
            summary,
            scan: {
                directoryMissing: false,
                cacheHit: false,
                filesListed: state.mtimes.size,
                filesStatted: 0,
                filesRead: counters.read,
                skippedByMtime: counters.skipped,
                invalidJson: counters.invalid,
                tooLarge: counters.tooLarge
            }
        };
    }

    const counters = { read: 0, skipped: 0, invalid: 0, tooLarge: 0, date };
    if (!state) {
        state = { dirMtimeMs: null, mtimes: new Map(), records: new Map(), attempted: new Set(), days: new Map() };
    }
    const names = listJsonNames(directory);
    const currentNames = new Set(names);
    let filesStatted = 0;

    // 目录条目被删除时，索引和对应日期汇总都要失效。
    for (const name of [...state.mtimes.keys()]) {
        if (currentNames.has(name)) continue;
        const record = state.records.get(name);
        state.mtimes.delete(name);
        state.records.delete(name);
        state.attempted.delete(name);
        if (record && state.days.has(record.date)) state.days.delete(record.date);
    }

    const range = dateRange(date);
    const fromMs = range.startMs - slackMs;
    const toMs = range.endMs + slackMs;
    const cachedWindows = [...state.days.keys()].map(cachedDate => {
        const cachedRange = dateRange(cachedDate);
        return [cachedRange.startMs - slackMs, cachedRange.endMs + slackMs];
    });
    for (const name of names) {
        if (state.mtimes.has(name)) continue;
        filesStatted += 1;
        const stat = readRegularFileStat(path.join(directory, name));
        if (!stat) {
            state.mtimes.set(name, -1);
            continue;
        }
        state.mtimes.set(name, stat.mtimeMs);
        const inWantedWindow = (stat.mtimeMs >= fromMs && stat.mtimeMs <= toMs)
            || cachedWindows.some(([start, end]) => stat.mtimeMs >= start && stat.mtimeMs <= end);
        if (!inWantedWindow) {
            counters.skipped += 1;
            continue;
        }
        counters.date = date;
        readCandidate(state, directory, name, counters, stat);
    }
    state.dirMtimeMs = dirStat.mtimeMs;
    collectForDate(state, directory, date, fromMs, toMs, counters);
    const summary = aggregateRecords(state.records, date);
    state.days.set(date, summary);
    return {
        state,
        summary,
        scan: {
            directoryMissing: false,
            cacheHit: false,
            filesListed: names.length,
            filesStatted,
            filesRead: counters.read,
            skippedByMtime: counters.skipped,
            invalidJson: counters.invalid,
            tooLarge: counters.tooLarge
        }
    };
}

function trimCache(cache) {
    while (cache.directories.size > MAX_CACHED_DIRECTORIES) {
        const oldest = cache.directories.keys().next().value;
        cache.directories.delete(oldest);
    }
}

function defaultUsageDirectory() {
    return require('../config.js').FILES.llmUsageDir;
}

// 主入口：按日期聚合事件。directory 省略时使用项目配置。
function buildDailyUsageSummary(options = {}) {
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs
        : (typeof options.clock === 'function' ? Number(options.clock()) : Date.now());
    const date = assertDate(options.date || beijingDateFromMs(nowMs));
    const directory = path.resolve(options.directory || defaultUsageDirectory());
    const slackMs = Number.isFinite(options.mtimeSlackMs) && options.mtimeSlackMs >= 0
        ? options.mtimeSlackMs : DEFAULT_MTIME_SLACK_MS;
    const cache = options.cache || defaultCache;
    const state = cache.directories.get(directory) || null;
    const result = scanForDate({ state, directory, date, slackMs });
    if (result.state) cache.directories.set(directory, result.state);
    trimCache(cache);
    return { ...result.summary, scan: result.scan };
}

function formatCost(value) {
    const cost = Number.isFinite(value) ? value : 0;
    if (Math.abs(cost) >= 1) return `$${cost.toFixed(2)}`;
    return `$${cost.toFixed(4)}`;
}

function formatBuckets(label, buckets, limit = 8) {
    const entries = Object.entries(buckets || {});
    if (entries.length === 0) return [];
    const lines = [`  ${label}:`];
    for (const [key, bucket] of entries.slice(0, limit)) {
        const cost = bucket.costEvents > 0 ? ` 费用=${formatCost(bucket.cost)}` : '';
        lines.push(`    ${key} 调用=${bucket.total} 成功=${bucket.success} 失败=${bucket.failed}${cost}`);
    }
    if (entries.length > limit) lines.push(`    …还有 ${entries.length - limit} 组`);
    return lines;
}

function formatText(summary) {
    const costText = summary.costEvents > 0
        ? formatCost(summary.cost)
        : '无费用记录（仅有 token 用量）';
    const lines = [
        `[llm-usage] ${summary.date} 调用=${summary.total} 成功=${summary.success} 失败=${summary.failed} 费用=${costText}`
    ];
    if (summary.total === 0) lines.push('  该日期没有可用的用量事件。');
    lines.push(...formatBuckets('按阶段', summary.byStage));
    lines.push(...formatBuckets('按模型', summary.byModel));
    if (Object.keys(summary.byAccount || {}).length > 0) {
        lines.push(...formatBuckets('按账号', summary.byAccount));
    } else {
        lines.push('  按账号: 不可得（事件未记录账号字段）');
    }
    if (summary.costEvents > 0) lines.push(`  费用事件数=${summary.costEvents}`);
    return lines.join('\n');
}

function formatJson(summary, options = {}) {
    return JSON.stringify(summary, null, options.pretty ? 2 : 0);
}

function clearUsageSummaryCache(cache = defaultCache) {
    if (cache && cache.directories) cache.directories.clear();
}

module.exports = {
    VERSION,
    USAGE_EVENT_VERSION,
    DEFAULT_MTIME_SLACK_MS,
    beijingDateFromMs,
    isValidDate,
    dateRange,
    eventDate,
    extractCost,
    accountKey,
    compactUsageRecord,
    createUsageSummaryCache,
    clearUsageSummaryCache,
    buildDailyUsageSummary,
    formatCost,
    formatText,
    formatJson
};
