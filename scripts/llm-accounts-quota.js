#!/usr/bin/env node
'use strict';
/**
 * OpenCode Go 多账号月/周/5小时额度与到期日管理 CLI。
 *
 * 调度规则（默认 PD_LLM_ACCOUNT_POOL_STRATEGY=expiry_priority）：
 * 1. 只选择月、周、5小时（以及余额）窗口全部有额度的账号；
 * 2. 在有额度的账号中，优先选择月额度最先到期（按北京时间 YYYY-MM-DD）的账号；
 * 3. 若多个账号月额度同一天到期，优先选择剩余月额度百分比最高的账号（并列时再比周剩余、5小时剩余）；
 * 4. 未配置月到期日的账号排在已知到期日账号之后，并回退为原有亲和/等权轮转；首次触发月限额 429 时自动学习到期日。
 *
 * 用法：
 *   npm run llm:accounts:quota -- [status] [--live] [--route primary|secondary] [--json] [--state PATH]
 *   npm run llm:accounts:quota -- sync [--route primary|secondary] [--json] [--state PATH]
 *   npm run llm:accounts:quota -- init-from-history [--route primary|secondary] [--json] [--state PATH]
 *   npm run llm:accounts:quota -- set --account <1..N> [--monthly-expiry YYYY-MM-DD|ISO] [--monthly-day 1-31] \
 *       [--monthly-remaining 0-100] [--monthly-remaining-usd N] [--monthly-budget-usd N] \
 *       [--weekly-remaining 0-100] [--5h-remaining 0-100] [--label NAME] [--clear-cooldown] \
 *       [--route primary|secondary] [--json] [--state PATH]
 *   npm run llm:accounts:quota -- import --file <JSON_PATH> [--route primary|secondary] [--json] [--state PATH]
 *   npm run llm:accounts:quota -- clear --account <1..N> [--route primary|secondary] [--json] [--state PATH]
 *
 * 约束：绝不输出 API Key、端点地址或 64 位十六进制账号指纹。
 */

const fs = require('node:fs');
const path = require('node:path');
const pool = require('./llm-account-pool');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_STATE_FILE = path.join(PROJECT_ROOT, 'data', 'runtime', 'llm-account-pool.json');

class QuotaCliUsageError extends Error {
    constructor(message) {
        super(message);
        this.name = 'QuotaCliUsageError';
        this.exitCode = 2;
    }
}

function printHelp() {
    console.log([
        'OpenCode Go 账号池额度与到期优先调度管理（不泄露密钥与账号指纹）',
        '',
        '用法:',
        '  npm run llm:accounts:quota -- [status] [--live] [--route primary|secondary] [--json] [--state PATH]',
        '  npm run llm:accounts:quota -- sync [--route primary|secondary] [--json] [--state PATH]',
        '  npm run llm:accounts:quota -- init-from-history [--route primary|secondary] [--json] [--state PATH]',
        '  npm run llm:accounts:quota -- set --account <1..N> [选项...]',
        '  npm run llm:accounts:quota -- import --file <JSON_PATH> [--route primary|secondary] [--json] [--state PATH]',
        '  npm run llm:accounts:quota -- clear --account <1..N> [--route primary|secondary] [--json] [--state PATH]',
        '',
        'sync / --live:',
        '  通过项目代理实时请求 OpenCode Go 官方 GET /zen/go/v1/usage，拉取所有账号的',
        '  5 小时 / 周 / 月三窗口真实剩余百分比与精确重置时间并写入状态文件。',
        '',
        'set 可用选项:',
        '  --account <1..N>            必选，当前配置中的账号序号（与 llm:accounts 输出一致）',
        '  --monthly-expiry <日期>     月额度到期日：YYYY-MM-DD（按北京时间当日结束）或 ISO 时间戳',
        '  --monthly-day <1-31>        每月固定续期日（按北京时间日期）',
        '  --monthly-remaining <0-100> 当前月额度剩余百分比',
        '  --monthly-remaining-usd <N> 当前月额度剩余美元（按月预算换算为百分比）',
        '  --monthly-budget-usd <N>    该账号月额度美元预算（默认 30，影响请求后本地消耗扣减精度）',
        '  --weekly-remaining <0-100>  当前周额度剩余百分比',
        '  --5h-remaining <0-100>      当前 5 小时滚动额度剩余百分比',
        '  --label <名称>              安全备注（1-40 位字母/数字/中文/._-；传空串清空）',
        '  --clear-cooldown            手动清除该账号当前已存的窗口冷却记录',
        '',
        '环境变量:',
        '  PD_LLM_ACCOUNT_POOL_STRATEGY=expiry_priority|equal_rotation（默认 expiry_priority）',
        '  PD_LLM_ACCOUNT_POOL_LIVE_SYNC=1|0（默认 1，运行时自动按 5 分钟 TTL 同步官方实时额度）'
    ].join('\n'));
}

function readOptionValue(argv, index, flagName) {
    const next = argv[index + 1];
    if (typeof next !== 'string' || (next.startsWith('--') && flagName !== '--label')) {
        throw new QuotaCliUsageError(`${flagName} 缺少参数值`);
    }
    if (flagName !== '--label' && !next.trim()) {
        throw new QuotaCliUsageError(`${flagName} 参数不能为空`);
    }
    return next;
}

function parseNumberOption(raw, flagName) {
    const trimmed = String(raw || '').trim();
    if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
        throw new QuotaCliUsageError(`${flagName} 必须为合法数字`);
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
        throw new QuotaCliUsageError(`${flagName} 必须为有限数字`);
    }
    return parsed;
}

function parseIntOption(raw, flagName) {
    const trimmed = String(raw || '').trim();
    if (!/^\d+$/.test(trimmed)) {
        throw new QuotaCliUsageError(`${flagName} 必须为正整数`);
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(parsed)) {
        throw new QuotaCliUsageError(`${flagName} 超出安全整数范围`);
    }
    return parsed;
}

function parseArgs(argv) {
    const args = Array.isArray(argv) ? [...argv] : [];
    if (args.includes('--help') || args.includes('-h')) {
        return { help: true };
    }
    let command = 'status';
    let startIndex = 0;
    if (args.length > 0 && !args[0].startsWith('-')) {
        command = args[0];
        startIndex = 1;
    }
    if (!['status', 'sync', 'init-from-history', 'set', 'import', 'clear'].includes(command)) {
        throw new QuotaCliUsageError(`未知子命令：${command}（支持 status / sync / init-from-history / set / import / clear）`);
    }

    const opts = {
        help: false,
        command,
        live: command === 'sync',
        route: 'primary',
        json: false,
        stateFile: DEFAULT_STATE_FILE,
        account: null,
        file: null,
        patch: {}
    };
    let explicitLive = false;

    for (let i = startIndex; i < args.length; i += 1) {
        const flag = args[i];
        if (flag === '--json') {
            opts.json = true;
        } else if (flag === '--live') {
            opts.live = true;
            explicitLive = true;
        } else if (flag === '--state') {
            opts.stateFile = path.resolve(readOptionValue(args, i, '--state'));
            i += 1;
        } else if (flag === '--route') {
            const route = readOptionValue(args, i, '--route').trim().toLowerCase();
            if (!['primary', 'secondary'].includes(route)) {
                throw new QuotaCliUsageError(`--route 只能是 primary 或 secondary，收到：${route}`);
            }
            opts.route = route;
            i += 1;
        } else if (flag === '--account') {
            opts.account = parseIntOption(readOptionValue(args, i, '--account'), '--account');
            i += 1;
        } else if (flag === '--file') {
            opts.file = path.resolve(readOptionValue(args, i, '--file'));
            i += 1;
        } else if (flag === '--monthly-expiry') {
            opts.patch.monthlyExpiry = readOptionValue(args, i, '--monthly-expiry').trim();
            i += 1;
        } else if (flag === '--monthly-day') {
            opts.patch.monthlyResetDay = parseIntOption(readOptionValue(args, i, '--monthly-day'), '--monthly-day');
            i += 1;
        } else if (flag === '--monthly-remaining') {
            opts.patch.monthlyRemainingPct = parseNumberOption(readOptionValue(args, i, '--monthly-remaining'), '--monthly-remaining');
            i += 1;
        } else if (flag === '--monthly-remaining-usd') {
            opts.patch.monthlyRemainingUsd = parseNumberOption(readOptionValue(args, i, '--monthly-remaining-usd'), '--monthly-remaining-usd');
            i += 1;
        } else if (flag === '--monthly-budget-usd') {
            opts.patch.monthlyBudgetUsd = parseNumberOption(readOptionValue(args, i, '--monthly-budget-usd'), '--monthly-budget-usd');
            i += 1;
        } else if (flag === '--weekly-remaining') {
            opts.patch.weeklyRemainingPct = parseNumberOption(readOptionValue(args, i, '--weekly-remaining'), '--weekly-remaining');
            i += 1;
        } else if (flag === '--5h-remaining' || flag === '--rolling-5h-remaining') {
            opts.patch.rolling5hRemainingPct = parseNumberOption(readOptionValue(args, i, flag), flag);
            i += 1;
        } else if (flag === '--label') {
            const next = args[i + 1];
            if (typeof next !== 'string') throw new QuotaCliUsageError('--label 缺少参数值');
            opts.patch.label = next;
            i += 1;
        } else if (flag === '--clear-cooldown') {
            opts.patch.clearCooldown = true;
        } else {
            throw new QuotaCliUsageError(`未知参数：${flag}`);
        }
    }

    if (explicitLive && command !== 'status' && command !== 'sync') {
        throw new QuotaCliUsageError(`--live 只能用于 status 或 sync 子命令，不能与 ${command} 同时使用`);
    }

    if (command === 'set') {
        if (!opts.account || opts.account < 1) {
            throw new QuotaCliUsageError('set 子命令必须指定 --account <1..N>');
        }
        if (Object.keys(opts.patch).length === 0) {
            throw new QuotaCliUsageError('set 子命令至少需要指定一项更新字段（如 --monthly-expiry / --monthly-remaining / --weekly-remaining / --5h-remaining / --label / --clear-cooldown）');
        }
    } else if (command === 'clear') {
        if (!opts.account || opts.account < 1) {
            throw new QuotaCliUsageError('clear 子命令必须指定 --account <1..N>');
        }
    } else if (command === 'import') {
        if (!opts.file) {
            throw new QuotaCliUsageError('import 子命令必须指定 --file <JSON_PATH>');
        }
    }

    return opts;
}

function resolveRoutePool(env, route) {
    const primaryEndpoint = String(env.PAPER_ANALYZER_ENDPOINT || '').trim();
    const primaryKey = String(env.PAPER_ANALYZER_API_KEY || '').trim();
    const primaryKeys = pool.resolvePrimaryApiKeyPool(
        primaryKey,
        env.PAPER_ANALYZER_FALLBACK_API_KEYS || '',
        env.PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY || ''
    );
    if (route === 'primary') {
        if (!primaryEndpoint || primaryKeys.length === 0) {
            throw new Error('当前 .env 缺少主模型端点或主模型 API Key 配置');
        }
        if (!pool.isOpenCodeGoEndpoint(primaryEndpoint)) {
            throw new Error('当前主模型端点不是 OpenCode Go 服务，不适用多账号池额度调度');
        }
        return { route: 'primary', endpoint: primaryEndpoint, keys: primaryKeys };
    }
    const secondaryModel = String(env.PAPER_ANALYZER_SECONDARY_MODEL || '').trim();
    if (!secondaryModel) {
        throw new Error('当前 .env 未启用副模型（PAPER_ANALYZER_SECONDARY_MODEL 为空）');
    }
    const secondaryEndpoint = String(env.PAPER_ANALYZER_SECONDARY_ENDPOINT || primaryEndpoint).trim();
    const secondaryKeys = pool.resolveSecondaryApiKeys({
        primaryEndpoint,
        primaryKey,
        primaryApiKeys: primaryKeys,
        secondaryEndpoint,
        secondaryKey: env.PAPER_ANALYZER_SECONDARY_API_KEY,
        secondaryModel,
        secondaryFallbackApiKeys: env.PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS,
        secondaryTertiaryFallbackApiKey: env.PAPER_ANALYZER_SECONDARY_TERTIARY_FALLBACK_API_KEY
    });
    if (!secondaryEndpoint || secondaryKeys.length === 0) {
        throw new Error('当前 .env 缺少副模型端点或 API Key 配置');
    }
    if (!pool.isOpenCodeGoEndpoint(secondaryEndpoint)) {
        throw new Error('当前副模型端点不是 OpenCode Go 服务，不适用多账号池额度调度');
    }
    return { route: 'secondary', endpoint: secondaryEndpoint, keys: secondaryKeys };
}

function readStateReadOnly(stateFile) {
    try {
        fs.lstatSync(stateFile);
    } catch (error) {
        if (error && error.code === 'ENOENT') return { state: null, present: false };
        throw new Error('账号池状态文件无法访问');
    }
    try {
        const state = pool.readStateStrict(stateFile);
        return { state, present: true };
    } catch (error) {
        if (error && error.code === 'ENOENT') return { state: null, present: false };
        throw error;
    }
}

function normalizeImportPatch(entry, index, totalAccounts) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new QuotaCliUsageError(`导入文件第 ${index + 1} 项不是 JSON 对象`);
    }
    const rawAccount = entry.account !== undefined ? entry.account : entry.slot;
    if (typeof rawAccount !== 'number' || !Number.isInteger(rawAccount) || rawAccount < 1 || rawAccount > totalAccounts) {
        throw new QuotaCliUsageError(`导入文件第 ${index + 1} 项的 account 超出范围（应为 1..${totalAccounts} 的整数）`);
    }
    const account = rawAccount;
    const patch = {};
    if (entry.label !== undefined) {
        if (entry.label !== null && typeof entry.label !== 'string') {
            throw new QuotaCliUsageError(`导入文件第 ${index + 1} 项 label 必须为字符串或 null`);
        }
        if (entry.label !== null && entry.label !== '') {
            const label = entry.label.trim();
            if (!/^[A-Za-z0-9\u4e00-\u9fff._-]{1,40}$/.test(label) || /^sk-/i.test(label) || /^[a-f0-9]{32,}$/i.test(label)) {
                throw new QuotaCliUsageError(`导入文件第 ${index + 1} 项 label 非法（仅允许 1-40 位字母/数字/中文/._-，且不能类似密钥）`);
            }
        }
        patch.label = entry.label;
    }
    if (entry.monthlyExpiry !== undefined) {
        if (typeof entry.monthlyExpiry !== 'string' || !entry.monthlyExpiry.trim()) {
            throw new QuotaCliUsageError(`导入文件第 ${index + 1} 项 monthlyExpiry 必须为非空日期字符串`);
        }
        const raw = entry.monthlyExpiry.trim();
        try {
            pool.parseMonthlyExpiryInput(raw);
        } catch (error) {
            throw new QuotaCliUsageError(`导入文件第 ${index + 1} 项 monthlyExpiry 非法：${error.message}`);
        }
        patch.monthlyExpiry = raw;
    }
    const resetDay = entry.monthlyResetDay !== undefined ? entry.monthlyResetDay : entry.monthlyDay;
    if (resetDay !== undefined) {
        if (typeof resetDay !== 'number' || !Number.isInteger(resetDay) || resetDay < 1 || resetDay > 31) {
            throw new QuotaCliUsageError(`导入文件第 ${index + 1} 项 monthlyResetDay 必须为 1-31 整数`);
        }
        patch.monthlyResetDay = resetDay;
    }
    if (entry.monthlyBudgetUsd !== undefined) {
        const budget = entry.monthlyBudgetUsd;
        if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) {
            throw new QuotaCliUsageError(`导入文件第 ${index + 1} 项 monthlyBudgetUsd 必须为正数`);
        }
        patch.monthlyBudgetUsd = budget;
    }
    const monthlyPct = entry.monthlyRemainingPct !== undefined ? entry.monthlyRemainingPct : entry.monthlyRemaining;
    if (monthlyPct !== undefined) {
        if (typeof monthlyPct !== 'number' || !Number.isFinite(monthlyPct) || monthlyPct < 0 || monthlyPct > 100) {
            throw new QuotaCliUsageError(`导入文件第 ${index + 1} 项 monthlyRemainingPct 必须在 0-100 之间`);
        }
        patch.monthlyRemainingPct = monthlyPct;
    }
    if (entry.monthlyRemainingUsd !== undefined) {
        const usd = entry.monthlyRemainingUsd;
        if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) {
            throw new QuotaCliUsageError(`导入文件第 ${index + 1} 项 monthlyRemainingUsd 不能为负数`);
        }
        patch.monthlyRemainingUsd = usd;
    }
    const weeklyPct = entry.weeklyRemainingPct !== undefined ? entry.weeklyRemainingPct : entry.weeklyRemaining;
    if (weeklyPct !== undefined) {
        if (typeof weeklyPct !== 'number' || !Number.isFinite(weeklyPct) || weeklyPct < 0 || weeklyPct > 100) {
            throw new QuotaCliUsageError(`导入文件第 ${index + 1} 项 weeklyRemainingPct 必须在 0-100 之间`);
        }
        patch.weeklyRemainingPct = weeklyPct;
    }
    const rolling5hPct = entry.rolling5hRemainingPct !== undefined ? entry.rolling5hRemainingPct : entry['5hRemaining'];
    if (rolling5hPct !== undefined) {
        if (typeof rolling5hPct !== 'number' || !Number.isFinite(rolling5hPct) || rolling5hPct < 0 || rolling5hPct > 100) {
            throw new QuotaCliUsageError(`导入文件第 ${index + 1} 项 rolling5hRemainingPct 必须在 0-100 之间`);
        }
        patch.rolling5hRemainingPct = rolling5hPct;
    }
    if (entry.clearCooldown !== undefined) {
        if (typeof entry.clearCooldown !== 'boolean') {
            throw new QuotaCliUsageError(`导入文件第 ${index + 1} 项 clearCooldown 必须为布尔值`);
        }
        if (entry.clearCooldown === true) patch.clearCooldown = true;
    }
    if (Object.keys(patch).length === 0) {
        throw new QuotaCliUsageError(`导入文件第 ${index + 1} 项未提供任何可更新的额度或到期字段`);
    }
    return { account, patch };
}

function formatPct(value) {
    if (!Number.isFinite(value)) return '-';
    return `${Number(value.toFixed(1))}%`;
}

function formatUsd(value) {
    if (!Number.isFinite(value)) return '$0.00';
    return `$${value.toFixed(2)}`;
}

function formatSourceTag(source) {
    if (source === 'live_api') return '实时API';
    if (source === 'manual') return '手动';
    if (source === 'auto_429') return '429自动学习';
    return '未配置';
}

function formatBeijingDateTime(iso) {
    if (!iso) return null;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

function formatStatusText(summary, meta = {}) {
    const lines = [];
    const strategyLabel = summary.strategy === 'equal_rotation'
        ? 'equal_rotation（纯等权轮转）'
        : 'expiry_priority（月到期优先 → 同天选月剩余最多 → 三窗口有额）';
    lines.push(`路由：${meta.route || 'primary'} | 调度策略：${strategyLabel}`);
    const nextLabel = summary.nextSlot ? `账号 ${summary.nextSlot}` : '无可用账号（全部冷却）';
    lines.push(`当前首选：${nextLabel} | 可用：${summary.eligibleCount}/${summary.rows.length}（已定月到期日 ${summary.tier1Count} 个，冷却 ${summary.blockedCount} 个）`);
    lines.push('');
    const ordered = [...summary.rows].sort((a, b) => {
        const ra = a.priorityRank ?? 9999;
        const rb = b.priorityRank ?? 9999;
        return (ra - rb) || (a.slot - b.slot);
    });
    for (const row of ordered) {
        const rank = row.priorityRank !== null ? `#${row.priorityRank}` : '冷却';
        const labelPart = row.label ? ` [${row.label}]` : '';
        const bjTime = formatBeijingDateTime(row.nextMonthlyResetIso);
        const expiryDisplay = bjTime || row.nextMonthlyExpiryBeijing;
        const expiryPart = expiryDisplay
            ? `月到期 ${expiryDisplay}（${formatSourceTag(row.monthlyResetSource)}）`
            : '月到期 未配置（Tier 2）';
        const quotaPart = `月 ${formatPct(row.monthlyRemainingPct)} / 周 ${formatPct(row.weeklyRemainingPct)} / 5h ${formatPct(row.rolling5hRemainingPct)}`;
        const spentPart = `本地已耗 月${formatUsd(row.monthlySpentUsd)} 周${formatUsd(row.weeklySpentUsd)} 5h${formatUsd(row.rolling5hSpentUsd)}`;
        const windowFlags = [];
        if (!row.hasMonthlyQuota) windowFlags.push('月空');
        if (!row.hasWeeklyQuota) windowFlags.push('周空');
        if (!row.hasRolling5hQuota) windowFlags.push('5h空');
        if (!row.hasBalanceQuota) windowFlags.push('余额空');
        const statusPart = row.eligible
            ? (row.slot === summary.nextSlot ? '★ 下一优先' : '可用')
            : `冷却至 ${row.blockedUntil || '未知'}${windowFlags.length ? ` [${windowFlags.join('/')}]` : ''}`;
        lines.push(`${rank.padEnd(4)} 账号 ${row.slot}${labelPart} | ${expiryPart} | 剩余 ${quotaPart} | ${spentPart} | ${statusPart}`);
    }
    return lines.join('\n');
}

function runCommand(opts, env, options = {}) {
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const resolved = resolveRoutePool(env, opts.route);
    const strategy = env.PD_LLM_ACCOUNT_POOL_STRATEGY;

    if (opts.command === 'status') {
        const { state } = readStateReadOnly(opts.stateFile);
        const summary = pool.describePoolPriorities(resolved.keys, resolved.endpoint, state, { nowMs, strategy });
        return {
            action: 'status',
            route: resolved.route,
            ...summary
        };
    }

    if (opts.command === 'init-from-history') {
        const result = pool.initQuotasFromHistory(resolved.keys, resolved.endpoint, opts.stateFile, { nowMs });
        const { state } = readStateReadOnly(opts.stateFile);
        const summary = pool.describePoolPriorities(resolved.keys, resolved.endpoint, state, { nowMs, strategy });
        return {
            action: 'init-from-history',
            route: resolved.route,
            initialized: result.initialized,
            skipped: result.skipped,
            ...summary
        };
    }

    if (opts.command === 'set') {
        if (opts.account > resolved.keys.length) {
            throw new QuotaCliUsageError(`--account ${opts.account} 超出范围，当前 ${resolved.route} 池共有 ${resolved.keys.length} 个账号`);
        }
        const key = resolved.keys[opts.account - 1];
        try {
            pool.setAccountQuota(key, resolved.endpoint, opts.patch, opts.stateFile, { nowMs });
        } catch (error) {
            if (error && error.code === 'LLM_ACCOUNT_POOL_CONFIG_ERROR') {
                throw new QuotaCliUsageError(error.message);
            }
            throw error;
        }
        const { state } = readStateReadOnly(opts.stateFile);
        const summary = pool.describePoolPriorities(resolved.keys, resolved.endpoint, state, { nowMs, strategy });
        return {
            action: 'set',
            route: resolved.route,
            updatedAccount: opts.account,
            ...summary
        };
    }

    if (opts.command === 'clear') {
        if (opts.account > resolved.keys.length) {
            throw new QuotaCliUsageError(`--account ${opts.account} 超出范围，当前 ${resolved.route} 池共有 ${resolved.keys.length} 个账号`);
        }
        const key = resolved.keys[opts.account - 1];
        const cleared = pool.clearAccountQuota(key, resolved.endpoint, opts.stateFile);
        const { state } = readStateReadOnly(opts.stateFile);
        const summary = pool.describePoolPriorities(resolved.keys, resolved.endpoint, state, { nowMs, strategy });
        return {
            action: 'clear',
            route: resolved.route,
            clearedAccount: opts.account,
            cleared,
            ...summary
        };
    }

    if (opts.command === 'import') {
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
        } catch (_) {
            throw new QuotaCliUsageError(`无法读取或解析导入文件：${opts.file}`);
        }
        const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.accounts) ? parsed.accounts : null);
        if (!list || list.length === 0) {
            throw new QuotaCliUsageError('导入文件必须是非空 JSON 数组或包含非空 accounts 数组的对象');
        }
        const normalized = list.map((item, idx) => normalizeImportPatch(item, idx, resolved.keys.length));
        const updatedAccounts = [];
        for (const item of normalized) {
            const key = resolved.keys[item.account - 1];
            try {
                pool.setAccountQuota(key, resolved.endpoint, item.patch, opts.stateFile, { nowMs });
            } catch (error) {
                if (error && error.code === 'LLM_ACCOUNT_POOL_CONFIG_ERROR') {
                    throw new QuotaCliUsageError(`账号 ${item.account} 配置非法：${error.message}`);
                }
                throw error;
            }
            updatedAccounts.push(item.account);
        }
        const { state } = readStateReadOnly(opts.stateFile);
        const summary = pool.describePoolPriorities(resolved.keys, resolved.endpoint, state, { nowMs, strategy });
        return {
            action: 'import',
            route: resolved.route,
            updatedAccounts,
            ...summary
        };
    }

    throw new QuotaCliUsageError(`不支持的子命令：${opts.command}`);
}

async function runSyncCommand(opts, env, options = {}) {
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const resolved = resolveRoutePool(env, opts.route);
    const strategy = env.PD_LLM_ACCOUNT_POOL_STRATEGY;
    const syncResult = await pool.syncOpenCodeGoPoolUsage(resolved.keys, resolved.endpoint, opts.stateFile, {
        force: true,
        nowMs,
        env,
        ...(typeof options.fetcher === 'function' ? { fetcher: options.fetcher } : {})
    });
    const { state } = readStateReadOnly(opts.stateFile);
    const summary = pool.describePoolPriorities(resolved.keys, resolved.endpoint, state, { nowMs, strategy });
    return {
        action: 'sync',
        route: resolved.route,
        sync: {
            synced: syncResult.synced,
            failed: syncResult.failed,
            authErrors: syncResult.authErrors,
            results: syncResult.results
        },
        ...summary
    };
}

async function main(argv = process.argv.slice(2)) {
    try {
        require('./env-loader').requireExternalRuntime('llm-accounts-quota.js');
    } catch (error) {
        console.error(`[llm-accounts-quota] ${error.message}`);
        return 1;
    }

    const opts = parseArgs(argv);
    if (opts.help) {
        printHelp();
        return 0;
    }

    const env = require('./env-loader').loadProjectEnv();
    const result = (opts.command === 'sync' || opts.live)
        ? await runSyncCommand(opts, env)
        : runCommand(opts, env);

    if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        if (result.action === 'sync') {
            console.log(`已实时同步 ${result.sync.synced}/${result.rows.length} 个账号的官方三窗口额度（失败 ${result.sync.failed} 个）。`);
            for (const item of result.sync.results || []) {
                if (!item.ok) {
                    console.log(`  ⚠️ 账号 ${item.slot} 同步失败：${item.error || '未知错误'}`);
                }
            }
        } else if (result.action === 'init-from-history') {
            console.log(`已从历史 monthly 429 记录初始化 ${result.initialized.length} 个账号，跳过 ${result.skipped.length} 个账号。`);
        } else if (result.action === 'set') {
            console.log(`已更新 账号 ${result.updatedAccount} 的额度/到期配置。`);
        } else if (result.action === 'clear') {
            console.log(result.cleared ? `已清空 账号 ${result.clearedAccount} 的额度/到期配置。` : `账号 ${result.clearedAccount} 原无额度配置。`);
        } else if (result.action === 'import') {
            console.log(`已批量更新 ${result.updatedAccounts.length} 个账号：${result.updatedAccounts.map(n => `账号 ${n}`).join('、')}。`);
        }
        console.log(formatStatusText(result, { route: result.route }));
    }
    return result.action === 'sync' && result.sync.synced === 0 && result.sync.failed > 0 ? 1 : 0;
}

module.exports = {
    QuotaCliUsageError,
    parseArgs,
    resolveRoutePool,
    readStateReadOnly,
    runCommand,
    runSyncCommand,
    formatStatusText,
    main
};

if (require.main === module) {
    Promise.resolve()
        .then(() => main())
        .then(code => { process.exitCode = code; })
        .catch(error => {
            const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
            console.error(`[llm-accounts-quota] ${error?.message || error}`);
            process.exitCode = exitCode;
        });
}
