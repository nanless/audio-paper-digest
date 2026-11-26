#!/usr/bin/env node
'use strict';

/**
 * 只读 LLM 运行记分卡。
 *
 * 按北京日期汇总真实 LLM 请求的成功率、ECONNRESET/传输错误率、KV 前缀缓存命中率、
 * 隐式思考 token 占比、各阶段 P50/P95 延迟与匿名化账号负载分布。
 * 绝不展示 API 密钥、认证头或稳定凭据指纹（账号分布仅按当次报告匿名编号 acct#1..N）。
 */

const fs = require('node:fs');
const path = require('node:path');
const Config = require('./config.js');
const { requireExternalRuntime } = require('./env-loader.js');
const { isUsageEventFormat } = require('./lib/llm-usage-format.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const MTIME_SLACK_MS = 12 * 60 * 60 * 1000;
const MAX_EVENT_BYTES = 512 * 1024;
const VALID_WORKFLOWS = Object.freeze(['daily', 'conference', 'history']);

function classifyEventWorkflow(event) {
    if (!event || typeof event !== 'object') return 'daily';
    if (typeof event.workflow === 'string') {
        const normalized = event.workflow.trim().toLowerCase();
        if (VALID_WORKFLOWS.includes(normalized)) return normalized;
    }
    const paperId = String(event.paperId || '').trim();
    const stage = String(event.stage || '').trim();
    if (paperId.startsWith('conference:') || /^conference(?:[-_.]|$)/i.test(stage)) {
        return 'conference';
    }
    if (paperId.startsWith('history:') || /^(?:history|historical)(?:[-_.]|$)/i.test(stage)) {
        return 'history';
    }
    return 'daily';
}

function beijingDateFromMs(ms) {
    return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

function isValidDate(date) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const ms = Date.parse(`${date}T00:00:00+08:00`);
    return Number.isFinite(ms) && beijingDateFromMs(ms) === date;
}

function resolveTargetDates(options) {
    if (options.batchDate && options.days === undefined) {
        if (!isValidDate(options.batchDate)) {
            throw new Error(`--batch-date 必须是有效的北京日期 YYYY-MM-DD：${String(options.batchDate)}`);
        }
        const batchMs = Date.parse(`${options.batchDate}T00:00:00+08:00`);
        const set = new Set([options.batchDate, beijingDateFromMs(batchMs + DAY_MS)]);
        if (options.date) {
            if (!isValidDate(options.date)) {
                throw new Error(`--date 必须是有效的北京日期 YYYY-MM-DD：${String(options.date)}`);
            }
            set.add(options.date);
        }
        return [...set].sort();
    }
    const today = beijingDateFromMs(Date.now());
    const anchor = options.date || options.batchDate || today;
    if (!isValidDate(anchor)) {
        throw new Error(`--date 必须是有效的北京日期 YYYY-MM-DD：${String(anchor)}`);
    }
    const days = options.days ?? 1;
    if (!Number.isInteger(days) || days < 1 || days > 90) {
        throw new Error(`--days 必须是 1–90 之间的整数：${String(days)}`);
    }
    const anchorMs = Date.parse(`${anchor}T00:00:00+08:00`);
    const dates = [];
    for (let i = days - 1; i >= 0; i -= 1) {
        dates.push(beijingDateFromMs(anchorMs - i * DAY_MS));
    }
    return dates;
}

function parseEventDate(at) {
    if (typeof at !== 'string') return null;
    const ms = Date.parse(at);
    return Number.isFinite(ms) ? beijingDateFromMs(ms) : null;
}

function loadEventsForDates(usageDir, targetDates, options = {}) {
    const dateSet = new Set(targetDates);
    const seenEventIds = new Set();
    const events = [];
    const loadedDatesFromIndex = new Set();
    const canonical = Boolean(options.canonical);
    const fast = Boolean(options.fast) && !canonical;

    const dailyIndexDir = path.join(path.dirname(usageDir), `${path.basename(usageDir)}-daily`);
    let dailyIndexDirOk = false;
    if (!canonical) {
        try {
            const idxDirStat = fs.lstatSync(dailyIndexDir);
            dailyIndexDirOk = idxDirStat.isDirectory() && !idxDirStat.isSymbolicLink();
        } catch (_) {
            dailyIndexDirOk = false;
        }
    }
    if (dailyIndexDirOk) {
        for (const date of targetDates) {
            const indexFile = path.join(dailyIndexDir, `${date}.jsonl`);
            let stat;
            try { stat = fs.lstatSync(indexFile); } catch (_) { continue; }
            if (!stat.isFile() || stat.isSymbolicLink()) continue;
            let rawIndexText;
            try { rawIndexText = fs.readFileSync(indexFile, 'utf8'); } catch (_) { continue; }
            const lines = rawIndexText.split('\n');
            for (const line of lines) {
                if (!line.trim()) continue;
                let event;
                try { event = JSON.parse(line); } catch (_) { continue; }
                if (!isUsageEventFormat(event) || event.kind !== 'request') continue;
                if (parseEventDate(event.at) !== date) continue;
                if (event.eventId) {
                    if (seenEventIds.has(event.eventId)) continue;
                    seenEventIds.add(event.eventId);
                }
                events.push(event);
            }
            // 可读的 0 行日索引文件也代表该日已有索引覆盖，避免触发 20 万级平铺目录回退扫描。
            loadedDatesFromIndex.add(date);
        }
    }

    // 默认模式与 --fast 模式优先读每日 JSONL 索引与日期分片子目录（避开 20 万级历史扁平根目录全扫，200x+ 加速）；
    // --fast 模式只读日索引与可选日期分片子目录，绝不回退扫描平铺根目录；
    // 仅非 --fast 模式下某目标日既无日索引也无日期分片子目录，或显式传 --canonical 时才扫描平铺根目录。
    const scannedSubdirDates = new Set();
    if (!canonical && fs.existsSync(usageDir)) {
        const rootStatCheck = fs.lstatSync(usageDir);
        if (!rootStatCheck.isDirectory() || rootStatCheck.isSymbolicLink()) {
            throw new Error('用量目录必须是真实目录，不能是符号链接');
        }
        for (const date of targetDates) {
            const subDir = path.join(usageDir, date);
            let subStat;
            try { subStat = fs.lstatSync(subDir); } catch (_) { continue; }
            if (!subStat.isDirectory() || subStat.isSymbolicLink()) continue;
            scannedSubdirDates.add(date);
            for (const name of fs.readdirSync(subDir)) {
                if (name.startsWith('.') || !name.endsWith('.json')) continue;
                const filePath = path.join(subDir, name);
                let stat;
                try { stat = fs.lstatSync(filePath); } catch (_) { continue; }
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EVENT_BYTES) continue;
                let event;
                try { event = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { continue; }
                if (!isUsageEventFormat(event) || event.kind !== 'request') continue;
                if (parseEventDate(event.at) !== date) continue;
                if (event.eventId) {
                    if (seenEventIds.has(event.eventId)) continue;
                    seenEventIds.add(event.eventId);
                }
                events.push(event);
            }
        }
    }

    if (fast) {
        return {
            events: filterEventsByRunAndBatch(events, options),
            source: loadedDatesFromIndex.size > 0
                ? (scannedSubdirDates.size > 0 ? 'daily-index+date-shard-fast' : 'daily-index-fast')
                : (scannedSubdirDates.size > 0 ? 'date-shard-fast' : 'empty-fast')
        };
    }

    // 默认模式优先读每日 JSONL 索引与日期分片子目录；若平铺根目录体积在轻量阈值内（<= 5000 项）
    // 仍与 mtime 窗口去重合并以保持 daily-index+usage-dir 语义；面对 20 万级历史扁平根目录且
    // 已有日索引覆盖时直接跳过全目录扫描（200x+ 加速），显式传 --canonical 时才全扫。
    const FLAT_SCAN_SKIP_THRESHOLD = 5000;
    const uncoveredDates = targetDates.filter(d => !loadedDatesFromIndex.has(d) && !scannedSubdirDates.has(d));
    let flatEntriesCount = null;
    if (!canonical && !fast && uncoveredDates.length === 0 && fs.existsSync(usageDir)) {
        const rootStatPre = fs.lstatSync(usageDir);
        if (rootStatPre.isDirectory() && !rootStatPre.isSymbolicLink()) {
            const dir = fs.opendirSync(usageDir);
            let counted = 0;
            try {
                while (counted <= FLAT_SCAN_SKIP_THRESHOLD && dir.readSync() !== null) {
                    counted += 1;
                }
            } finally {
                dir.closeSync();
            }
            flatEntriesCount = counted;
        }
    }
    const shouldMergeSmallFlatRoot = !canonical && !fast
        && flatEntriesCount !== null
        && flatEntriesCount <= FLAT_SCAN_SKIP_THRESHOLD
        && scannedSubdirDates.size < targetDates.length;
    const scanDates = canonical
        ? targetDates
        : (shouldMergeSmallFlatRoot
            ? targetDates.filter(d => !scannedSubdirDates.has(d))
            : uncoveredDates);
    if (scanDates.length === 0 || !fs.existsSync(usageDir)) {
        const filteredEvents = filterEventsByRunAndBatch(events, options);
        return {
            events: filteredEvents,
            source: (loadedDatesFromIndex.size > 0 || scannedSubdirDates.size > 0)
                ? (fast
                    ? 'daily-index-fast'
                    : (loadedDatesFromIndex.size > 0 && scannedSubdirDates.size > 0
                        ? 'daily-index+usage-dir'
                        : (scannedSubdirDates.size > 0 ? 'date-shard' : 'daily-index')))
                : 'empty'
        };
    }

    const scanDateSet = new Set(scanDates);
    const minMs = Math.min(...scanDates.map(d => Date.parse(`${d}T00:00:00+08:00`))) - MTIME_SLACK_MS;
    const maxMs = Math.max(...scanDates.map(d => Date.parse(`${d}T00:00:00+08:00`) + DAY_MS)) + MTIME_SLACK_MS;
    const rootStat = fs.lstatSync(usageDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error('用量目录必须是真实目录，不能是符号链接');
    }

    const scanDir = (dirPath, skipMtimeFilter = false) => {
        for (const name of fs.readdirSync(dirPath)) {
            if (name.startsWith('.') || !name.endsWith('.json')) continue;
            const filePath = path.join(dirPath, name);
            let stat;
            try { stat = fs.lstatSync(filePath); } catch (_) { continue; }
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EVENT_BYTES) continue;
            if (!skipMtimeFilter && (stat.mtimeMs < minMs || stat.mtimeMs > maxMs)) continue;
            let event;
            try { event = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { continue; }
            if (!isUsageEventFormat(event) || event.kind !== 'request') continue;
            const evDate = parseEventDate(event.at);
            if (!evDate || !scanDateSet.has(evDate)) continue;
            if (event.eventId) {
                if (seenEventIds.has(event.eventId)) continue;
                seenEventIds.add(event.eventId);
            }
            events.push(event);
        }
    };

    for (const date of scanDates) {
        const subDir = path.join(usageDir, date);
        let subStat;
        try { subStat = fs.lstatSync(subDir); } catch (_) { continue; }
        if (subStat.isDirectory() && !subStat.isSymbolicLink()) {
            scanDir(subDir, true);
        }
    }
    scanDir(usageDir, canonical);
    return {
        events: filterEventsByRunAndBatch(events, options),
        source: canonical
            ? 'canonical-usage-dir'
            : (loadedDatesFromIndex.size > 0 ? (fast ? 'mixed-fast' : 'daily-index+usage-dir') : 'usage-dir-mtime')
    };
}

function filterEventsByRunAndBatch(events, options = {}) {
    let out = events;
    if (options.runId) {
        out = out.filter(ev => ev && ev.runId === options.runId);
    }
    if (options.batchDate) {
        // 若事件显式记录了 batchDate，严格按 batchDate 匹配；仅当历史事件未记录 batchDate 时回退事件北京日期。
        out = out.filter(ev => ev && (
            ev.batchDate
                ? ev.batchDate === options.batchDate
                : parseEventDate(ev.at) === options.batchDate
        ));
    }
    if (options.workflow) {
        out = out.filter(ev => ev && classifyEventWorkflow(ev) === options.workflow);
    }
    return out;
}

function percentile(values, p) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
}

function pct(numerator, denominator) {
    if (!denominator || denominator <= 0) return null;
    return Number(((numerator / denominator) * 100).toFixed(2));
}

function emptyMetricBucket() {
    return {
        requests: 0,
        completed: 0,
        incomplete: 0,
        transportErrors: 0,
        econnresetErrors: 0,
        httpErrors: 0,
        providerErrors: 0,
        blockedBeforeTransport: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        durationsMs: []
    };
}

function accumulate(bucket, event) {
    const blocked = event.transportStarted === false || event.outcome === 'blocked_before_transport'
        || (event.transportStarted === undefined && event.outcome === 'transport_error'
            && event.errorCode === 'READER_EXPLICIT_ROUND_BUDGET_EXHAUSTED'
            && event.statusCode == null && !event.outputTextSha256 && event.usage?.status !== 'reported');
    bucket.requests += 1;
    if (blocked) bucket.blockedBeforeTransport += 1;
    else if (event.outcome === 'completed') bucket.completed += 1;
    else if (event.outcome === 'incomplete') bucket.incomplete += 1;
    else if (event.outcome === 'transport_error') {
        bucket.transportErrors += 1;
        const codeUpper = String(event.errorCode || '').toUpperCase();
        if (codeUpper.includes('ECONNRESET') || codeUpper.includes('CONNECTIONRESETERROR')) {
            bucket.econnresetErrors += 1;
        }
    } else if (event.outcome === 'http_error') bucket.httpErrors += 1;
    else if (event.outcome === 'provider_error') bucket.providerErrors += 1;

    const u = event.usage || {};
    if (Number.isSafeInteger(u.inputTokens) && u.inputTokens >= 0) bucket.inputTokens += u.inputTokens;
    if (Number.isSafeInteger(u.cachedInputTokens) && u.cachedInputTokens >= 0) bucket.cachedInputTokens += u.cachedInputTokens;
    if (Number.isSafeInteger(u.outputTokens) && u.outputTokens >= 0) bucket.outputTokens += u.outputTokens;
    if (Number.isSafeInteger(u.reasoningTokens) && u.reasoningTokens >= 0) bucket.reasoningTokens += u.reasoningTokens;
    if (Number.isSafeInteger(event.durationMs) && event.durationMs >= 0) bucket.durationsMs.push(event.durationMs);
}

function finalizeBucket(bucket) {
    return {
        requests: bucket.requests,
        completed: bucket.completed,
        successRatePct: pct(bucket.completed, bucket.requests),
        incomplete: bucket.incomplete,
        transportErrors: bucket.transportErrors,
        econnresetErrors: bucket.econnresetErrors,
        httpErrors: bucket.httpErrors,
        providerErrors: bucket.providerErrors,
        blockedBeforeTransport: bucket.blockedBeforeTransport,
        inputTokens: bucket.inputTokens,
        cachedInputTokens: bucket.cachedInputTokens,
        cacheHitRatePct: pct(bucket.cachedInputTokens, bucket.inputTokens),
        outputTokens: bucket.outputTokens,
        reasoningTokens: bucket.reasoningTokens,
        reasoningSharePct: pct(bucket.reasoningTokens, bucket.outputTokens),
        p50DurationMs: percentile(bucket.durationsMs, 50),
        p95DurationMs: percentile(bucket.durationsMs, 95)
    };
}

function buildScorecard(events, { dates, source, workflow = null }) {
    const overall = emptyMetricBucket();
    const byStage = new Map();
    const byDate = new Map();
    const byAccountRaw = new Map();

    for (const event of events) {
        accumulate(overall, event);
        const stage = event.stage || 'unknown';
        if (!byStage.has(stage)) byStage.set(stage, emptyMetricBucket());
        accumulate(byStage.get(stage), event);

        const date = parseEventDate(event.at) || 'unknown';
        if (!byDate.has(date)) byDate.set(date, emptyMetricBucket());
        accumulate(byDate.get(date), event);

        if (typeof event.accountId === 'string' && /^[a-f0-9]{64}$/i.test(event.accountId)) {
            const key = event.accountId.toLowerCase();
            byAccountRaw.set(key, (byAccountRaw.get(key) || 0) + 1);
        }
    }

    // 匿名化账号槽位分布：按本次窗口请求量排序后仅暴露 acct#1..N，不输出任何稳定凭据指纹。
    const accountCounts = [...byAccountRaw.values()].sort((a, b) => b - a);
    const anonymizedAccounts = Object.fromEntries(
        accountCounts.map((count, idx) => [`acct#${idx + 1}`, count])
    );

    return {
        contract: 'digest-scorecard',
        dates,
        source,
        ...(workflow ? { workflow } : {}),
        totals: finalizeBucket(overall),
        byStage: Object.fromEntries(
            [...byStage.entries()]
                .sort((a, b) => b[1].requests - a[1].requests || a[0].localeCompare(b[0]))
                .map(([stage, bucket]) => [stage, finalizeBucket(bucket)])
        ),
        byDate: Object.fromEntries(
            [...byDate.entries()]
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([date, bucket]) => [date, finalizeBucket(bucket)])
        ),
        observedAccountDistribution: anonymizedAccounts
    };
}

function formatTextScorecard(card) {
    const t = card.totals;
    const fmtPct = v => (v === null ? 'N/A' : `${v.toFixed(1)}%`);
    const fmtMs = v => (v === null ? 'N/A' : `${(v / 1000).toFixed(1)}s`);
    const workflowLabel = card.workflow ? ` | workflow=${card.workflow}` : '';
    const lines = [
        `📊 LLM 运行记分卡（${card.dates[0]}${card.dates.length > 1 ? ` ~ ${card.dates[card.dates.length - 1]}` : ''} | source=${card.source}${workflowLabel}）`,
        `总请求: ${t.requests} | 成功: ${t.completed} (${fmtPct(t.successRatePct)}) | 截断: ${t.incomplete} | 传输错: ${t.transportErrors} (ECONNRESET=${t.econnresetErrors}) | HTTP错: ${t.httpErrors} | 服务商错: ${t.providerErrors} | 本地拦截: ${t.blockedBeforeTransport}`,
        `输入 Token: ${t.inputTokens.toLocaleString('en-US')} | 缓存命中: ${t.cachedInputTokens.toLocaleString('en-US')} (${fmtPct(t.cacheHitRatePct)})`,
        `输出 Token: ${t.outputTokens.toLocaleString('en-US')} | 思考占比: ${t.reasoningTokens.toLocaleString('en-US')} (${fmtPct(t.reasoningSharePct)}) | P50=${fmtMs(t.p50DurationMs)} P95=${fmtMs(t.p95DurationMs)}`
    ];
    const acctEntries = Object.entries(card.observedAccountDistribution || {});
    if (acctEntries.length > 0) {
        lines.push(`匿名账号分布: ${acctEntries.map(([slot, cnt]) => `${slot}=${cnt}`).join(', ')}`);
    }
    const stageEntries = Object.entries(card.byStage || {});
    if (stageEntries.length > 0) {
        lines.push('', '按阶段明细：');
        for (const [stage, s] of stageEntries) {
            lines.push(
                `  - ${stage}: req=${s.requests} ok=${fmtPct(s.successRatePct)} cache=${fmtPct(s.cacheHitRatePct)} think=${fmtPct(s.reasoningSharePct)} econnreset=${s.econnresetErrors} p50=${fmtMs(s.p50DurationMs)} p95=${fmtMs(s.p95DurationMs)}`
            );
        }
    }
    return lines.join('\n');
}

function parseArgs(argv) {
    const options = { json: false, canonical: false, fast: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--json') {
            options.json = true;
        } else if (arg === '--canonical') {
            options.canonical = true;
        } else if (arg === '--fast') {
            options.fast = true;
        } else if (arg === '--date' && argv[i + 1]) {
            options.date = argv[++i];
        } else if (arg === '--days' && argv[i + 1]) {
            options.days = Number(argv[++i]);
        } else if (arg === '--dir' && argv[i + 1]) {
            options.dir = argv[++i];
        } else if (arg === '--run-id' && argv[i + 1]) {
            const rid = argv[++i];
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rid)) {
                throw new Error(`--run-id 必须是规范 UUID v4：${rid}`);
            }
            options.runId = rid.toLowerCase();
        } else if (arg === '--batch-date' && argv[i + 1]) {
            const bd = argv[++i];
            if (!isValidDate(bd)) throw new Error(`--batch-date 必须是有效的北京日期 YYYY-MM-DD：${bd}`);
            options.batchDate = bd;
            if (!options.date) options.date = bd;
        } else if (arg === '--workflow' || arg.startsWith('--workflow=')) {
            const rawWf = arg === '--workflow' ? argv[++i] : arg.slice('--workflow='.length);
            const wf = String(rawWf || '').trim().toLowerCase();
            if (!VALID_WORKFLOWS.includes(wf)) {
                throw new Error(`--workflow 必须是 ${VALID_WORKFLOWS.join('|')} 之一：${String(rawWf || '')}`);
            }
            options.workflow = wf;
        } else {
            throw new Error('用法：digest:scorecard [--date YYYY-MM-DD] [--days N] [--run-id UUID] [--batch-date YYYY-MM-DD] [--workflow daily|conference|history] [--dir DIR] [--fast|--canonical] [--json]');
        }
    }
    return options;
}

function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    const dates = resolveTargetDates(options);
    const usageDir = path.resolve(options.dir || Config.FILES.llmUsageDir);
    const { events, source } = loadEventsForDates(usageDir, dates, {
        canonical: options.canonical,
        fast: options.fast,
        runId: options.runId,
        batchDate: options.batchDate,
        workflow: options.workflow
    });
    const card = buildScorecard(events, { dates, source, workflow: options.workflow || null });
    if (options.json) {
        console.log(JSON.stringify(card, null, 2));
    } else {
        console.log(formatTextScorecard(card));
    }
    return card;
}

if (require.main === module) {
    requireExternalRuntime('digest-scorecard');
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    VALID_WORKFLOWS,
    classifyEventWorkflow,
    main,
    parseArgs,
    resolveTargetDates,
    loadEventsForDates,
    buildScorecard,
    formatTextScorecard
};
