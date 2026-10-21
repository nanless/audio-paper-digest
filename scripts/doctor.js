#!/usr/bin/env node
'use strict';

/**
 * 论文速递只读体检命令。
 *
 * 用法：
 *   node scripts/doctor.js [--date YYYY-MM-DD] [--offline] [--network] [--json]
 *
 * 约束（有意保持简单，便于在出问题时先跑这一条）：
 * - 不写任何文件、不创建日志、不发模型请求；
 * - 默认 --offline，不联网；只有显式 --network 才对 arXiv Atom / OAI / RSS
 *   各发一次最小探测，并强制走项目 .env 里的 HTTP CONNECT 代理；
 * - 不打印 API Key、代理密码等密钥值，路径输出会把用户主目录掩码成 ~。
 *
 * 这里有意不调用 env-loader 的 loadProjectEnv/parseEnvFile：它们会把 .env
 * 权限收紧为 0600，属于写操作；体检必须只读。同理，账号池状态直接读 JSON，
 * 不走 readStateStrict（它也会 chmod）。工作区角色只调用只读的
 * workspace-role.readWorkspaceRole。doctor 本身是“角色/环境坏了也要能跑”的
 * 诊断入口，所以不调用 requireExternalRuntime（避免角色检查挡住体检）；但可靠
 * 的 CODEX_SANDBOX 标记仍在 main()/require.main 入口、任何检查前 exit 1，
 * 符合项目“脚本只在沙箱外运行”的约束；被 import 时不杀进程。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
    STATE_SCHEMA_VERSION: LLM_POOL_STATE_SCHEMA_VERSION,
    POLICY_VERSION: LLM_POOL_POLICY_VERSION
} = require('./llm-account-pool.js');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENV_FILE_NAME = '.env';
const REQUIRED_NODE_RANGE = '>=20.18.1 <21 || >=22.3.0';
const REQUIRED_MODEL = 'muse-spark-1.3-contributor';
const DEFAULT_BLOG_REPO = '~/code/github_repos/audio-paper-digest-blog';

const PYTHON_TIMEOUT_MS = 15000;
const GIT_PROBE_TIMEOUT_MS = 5000;
const GIT_STATUS_TIMEOUT_MS = 15000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const NETWORK_TIMEOUT_MS = 20000;
const NETWORK_MAX_BYTES = 8 * 1024 * 1024;

// 磁盘统计是同步递归 stat，和大目录（本机 data/runtime 有数百 GiB）相比必须
// 有明确上限；超限时给出下界并提示用 storage:status 做完整统计。
const DISK_TOTAL_BUDGET_MS = 3000;
const DISK_MAX_ENTRIES = 150000;
const DISK_SOFT_LIMIT_CURRENT = 8 * 1024 ** 3;
const DISK_SOFT_LIMIT_RUNTIME = 200 * 1024 ** 3;
const DISK_SOFT_LIMIT_LOGS = 2 * 1024 ** 3;

const DISK_TARGETS = Object.freeze([
    { key: 'data/current', label: 'data/current 占用', softLimitBytes: DISK_SOFT_LIMIT_CURRENT },
    { key: 'data/runtime', label: 'data/runtime 占用', softLimitBytes: DISK_SOFT_LIMIT_RUNTIME },
    { key: 'logs', label: 'logs 占用', softLimitBytes: DISK_SOFT_LIMIT_LOGS }
]);

const RSS_CATEGORY = 'eess.AS';
const ARXIV_ATOM_URL = 'https://export.arxiv.org/api/query?search_query=all:electron&start=0&max_results=1';
const ARXIV_OAI_URL = 'https://oaipmh.arxiv.org/oai?verb=Identify';
const ARXIV_RSS_URL = `https://rss.arxiv.org/rss/${RSS_CATEGORY}`;
const ARXIV_USER_AGENT = 'audio-paper-digest-doctor/1.0';

const STATUS_ICONS = Object.freeze({ ok: '✅', warn: '⚠️', fail: '❌' });
const STATUS_ORDER = Object.freeze(['ok', 'warn', 'fail']);

const USAGE = [
    '用法: node scripts/doctor.js [--date YYYY-MM-DD] [--offline|--network] [--json]',
    '',
    '  --date YYYY-MM-DD  目标日期；默认北京时间今天。用于 RSS 公告与博客重叠检查。',
    '  --offline          默认模式：不联网。',
    '  --network          显式联网：经项目代理对 arXiv Atom / OAI / RSS 各探测一次。',
    '  --json             输出机器可读的检查数组（退出码规则相同）。',
    '  --help             显示本帮助。',
    '',
    '本命令只读：不写文件、不发模型请求、不打印密钥。'
].join('\n');

// ═══════════════════════════════════════════════════════
// 通用小工具
// ═══════════════════════════════════════════════════════

function makeCheck(ok, label, detail, hint = null) {
    const normalized = STATUS_ORDER.includes(ok) ? ok : 'fail';
    return {
        ok: normalized,
        label: String(label || ''),
        detail: String(detail || ''),
        hint: hint ? String(hint) : null
    };
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasEnvValue(env, key) {
    const value = isPlainObject(env) ? env[key] : undefined;
    return typeof value === 'string' && value.trim() !== '';
}

function truncatedText(value, maxLength = 160) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function maskPath(value, homeDirectory = os.homedir()) {
    const text = String(value == null ? '' : value);
    const home = String(homeDirectory || '');
    if (home) {
        if (text === home) return '~';
        if (text.startsWith(`${home}${path.sep}`)) return `~${text.slice(home.length)}`;
        if (text.startsWith(`${home}/`)) return `~${text.slice(home.length)}`;
    }
    // 非主目录的绝对路径只保留末两级，避免体检输出泄露无关的本机目录结构。
    if (path.isAbsolute(text)) {
        const parts = text.split(path.sep).filter(Boolean);
        if (parts.length > 2) return `…${path.sep}${parts.slice(-2).join(path.sep)}`;
    }
    return text;
}

function maskTextPaths(value, homeDirectory = os.homedir()) {
    const text = String(value == null ? '' : value);
    const home = String(homeDirectory || '');
    if (!home) return text;
    return text.split(home).join('~');
}

function sanitizeUrlForDisplay(value) {
    try {
        const parsed = new URL(String(value));
        const port = parsed.port ? `:${parsed.port}` : '';
        const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
        return `${parsed.protocol}//${parsed.hostname}${port}${pathname}`;
    } catch (_error) {
        return '(非法 URL)';
    }
}

function isHttpUrl(value) {
    try {
        const parsed = new URL(String(value));
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (_error) {
        return false;
    }
}

function expandHomePath(value, homeDirectory = os.homedir()) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return text;
    if (text === '~') return homeDirectory;
    if (text.startsWith('~/')) return path.join(homeDirectory, text.slice(2));
    return text;
}

/**
 * 把密钥值从任意输出里抹掉。API Key、备用 Key、代理密码都算。
 */
function collectSecretValues(env) {
    const secrets = new Set();
    if (!isPlainObject(env)) return [];
    for (const [key, rawValue] of Object.entries(env)) {
        const value = typeof rawValue === 'string' ? rawValue.trim() : '';
        if (!value) continue;
        if (/(API_?KEY|TOKEN|SECRET|PASSWORD)/i.test(key) || /FALLBACK_API_KEYS$/i.test(key)) {
            for (const part of value.split(',')) {
                const candidate = part.trim();
                if (candidate.length >= 4) secrets.add(candidate);
            }
        }
        if (/^(HTTPS?_PROXY|https?_proxy)$/.test(key)) {
            try {
                const parsed = new URL(value);
                for (const part of [parsed.username, parsed.password]) {
                    const decoded = decodeURIComponent(part || '');
                    if (decoded && decoded.length >= 4) secrets.add(decoded);
                }
            } catch (_error) {
                // 非法代理 URL 已在代理检查里报告。
            }
        }
    }
    return [...secrets].sort((a, b) => b.length - a.length);
}

function redactText(value, secrets) {
    let text = String(value == null ? '' : value);
    for (const secret of secrets) {
        if (!secret) continue;
        text = text.split(secret).join('***');
    }
    return text;
}

function redactChecks(checks, secrets) {
    if (!Array.isArray(secrets) || secrets.length === 0) return checks;
    return checks.map(check => ({
        ...check,
        label: redactText(check.label, secrets),
        detail: redactText(check.detail, secrets),
        hint: check.hint === null ? null : redactText(check.hint, secrets)
    }));
}

function countStatuses(checks) {
    const counts = { ok: 0, warn: 0, fail: 0 };
    for (const check of checks || []) {
        if (Object.prototype.hasOwnProperty.call(counts, check?.ok)) counts[check.ok] += 1;
    }
    return counts;
}

function exitCodeFor(checks) {
    return Array.isArray(checks) && checks.some(check => check?.ok === 'fail') ? 1 : 0;
}

function displayWidth(value) {
    let width = 0;
    for (const character of String(value == null ? '' : value)) {
        const code = character.codePointAt(0);
        const wide = (code >= 0x1100 && code <= 0x115f)
            || (code >= 0x2e80 && code <= 0xa4cf)
            || (code >= 0xac00 && code <= 0xd7a3)
            || (code >= 0xf900 && code <= 0xfaff)
            || (code >= 0xfe30 && code <= 0xfe4f)
            || (code >= 0xff00 && code <= 0xff60)
            || (code >= 0xffe0 && code <= 0xffe6)
            || (code >= 0x1f300 && code <= 0x1faff)
            || (code >= 0x20000 && code <= 0x3fffd);
        width += wide ? 2 : 1;
    }
    return width;
}

function padDisplay(value, width) {
    const text = String(value == null ? '' : value);
    return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

// ═══════════════════════════════════════════════════════
// 参数解析
// ═══════════════════════════════════════════════════════

function isValidDateString(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function beijingDateString(nowMs = Date.now()) {
    return new Date(Number(nowMs) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function parseArgs(argv = [], options = {}) {
    const args = Array.isArray(argv) ? argv : [];
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    let date = null;
    let dateProvided = false;
    let offlineFlag = false;
    let networkFlag = false;
    let json = false;
    let help = false;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--date') {
            const value = args[index + 1];
            if (value === undefined || value.startsWith('--')) throw new Error('--date 需要 YYYY-MM-DD');
            if (!isValidDateString(value)) throw new Error(`--date 日期非法: ${value}`);
            date = value;
            dateProvided = true;
            index += 1;
        } else if (arg === '--offline') {
            offlineFlag = true;
        } else if (arg === '--network') {
            networkFlag = true;
        } else if (arg === '--json') {
            json = true;
        } else if (arg === '--help' || arg === '-h') {
            help = true;
        } else {
            throw new Error(`未知参数: ${arg}`);
        }
    }
    if (offlineFlag && networkFlag) throw new Error('--offline 与 --network 不能同时使用');
    if (!date) date = beijingDateString(nowMs);
    return {
        date,
        dateProvided,
        network: networkFlag,
        offline: !networkFlag,
        json,
        help
    };
}

// ═══════════════════════════════════════════════════════
// 版本与运行时检查
// ═══════════════════════════════════════════════════════

function parseVersionParts(value) {
    const match = String(value == null ? '' : value).trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersionParts(left, right) {
    for (let index = 0; index < 3; index += 1) {
        if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
    }
    return 0;
}

function isPrereleaseVersion(version) {
    // semver 预发布版本（如 22.3.0-rc.1）低于同版本正式版，不满足 engines。
    const core = String(version == null ? '' : version).trim().replace(/^v/, '');
    return core.split('+')[0].includes('-');
}

function satisfiesNodeRange(version) {
    if (isPrereleaseVersion(version)) return false;
    const parts = parseVersionParts(version);
    if (!parts) return false;
    const [major] = parts;
    if (major === 20) return compareVersionParts(parts, [20, 18, 1]) >= 0;
    if (major === 21) return false;
    if (major >= 22) return compareVersionParts(parts, [22, 3, 0]) >= 0;
    return false;
}

function checkNodeVersion(version) {
    const parts = parseVersionParts(version);
    if (!parts) {
        return makeCheck('fail', 'Node 版本', `无法识别 Node 版本: ${truncatedText(version, 40)}`,
            `安装满足 ${REQUIRED_NODE_RANGE} 的 Node 后重试`);
    }
    const display = `v${String(version).trim().replace(/^v/, '')}`;
    if (isPrereleaseVersion(version)) {
        return makeCheck('fail', 'Node 版本', `${display} 是预发布版本，不满足 ${REQUIRED_NODE_RANGE}`,
            '安装正式版 Node 22.3+（或 20.18.1+）后重试');
    }
    if (!satisfiesNodeRange(version)) {
        return makeCheck('fail', 'Node 版本', `${display} 不满足 ${REQUIRED_NODE_RANGE}`,
            '安装 Node 22.3+（或 20.18.1+）后重试');
    }
    return makeCheck('ok', 'Node 版本', `${display}（满足 ${REQUIRED_NODE_RANGE}）`);
}

function evaluatePythonRuntime(result) {
    const probe = result || {};
    if (probe.error) {
        return makeCheck('fail', 'Python 运行时', `无法执行 python-runtime.sh: ${truncatedText(probe.error.message || probe.error)}`,
            '确认 bash 可用，或直接运行 bash scripts/python-runtime.sh -c "import sys; print(sys.version)"');
    }
    if (probe.status !== 0) {
        const reason = truncatedText(String(probe.stderr || probe.stdout || '').trim()) || `退出码 ${probe.status}`;
        return makeCheck('fail', 'Python 运行时', `python-runtime.sh 失败: ${reason}`,
            '创建项目 .venv 或安装 Python 3.11+（含 OpenSSL）');
    }
    const lines = String(probe.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const version = lines[0] || '';
    const openssl = lines[1] || '';
    const parts = parseVersionParts(version);
    if (!parts) {
        return makeCheck('fail', 'Python 运行时', `无法解析 Python 版本输出: ${truncatedText(lines[0] || '(空)')}`,
            '运行 bash scripts/python-runtime.sh -c "import sys; print(sys.version)" 查看实际输出');
    }
    if (compareVersionParts(parts, [3, 11, 0]) < 0) {
        return makeCheck('fail', 'Python 运行时', `Python ${parts.join('.')} 低于 3.11`,
            '创建项目 .venv 或安装 Python 3.11+');
    }
    if (!/^OpenSSL\s/.test(openssl)) {
        return makeCheck('fail', 'Python 运行时', `Python ${parts.join('.')} 缺少 OpenSSL: ${truncatedText(openssl || '(无输出)')}`,
            '安装带 OpenSSL 的 Python 3.11+');
    }
    return makeCheck('ok', 'Python 运行时', `Python ${parts.join('.')} / ${truncatedText(openssl, 60)}`);
}

function evaluateNodeModules(kind) {
    if (kind === 'directory') return makeCheck('ok', 'Node 依赖', 'node_modules 已安装');
    if (kind === 'file' || kind === 'other') {
        return makeCheck('fail', 'Node 依赖', 'node_modules 不是目录', '删除异常的 node_modules 后运行 npm ci');
    }
    if (kind === 'error') {
        return makeCheck('fail', 'Node 依赖', '无法读取 node_modules', '检查目录权限后重试');
    }
    return makeCheck('fail', 'Node 依赖', 'node_modules 不存在', '运行 npm ci 安装依赖');
}

// ═══════════════════════════════════════════════════════
// .env 与模型 / 代理配置
// ═══════════════════════════════════════════════════════

/**
 * 只读解析 .env：不 chmod、不写回、不修改 process.env。
 * 取值规则与 env-loader 保持一致（后出现的同名键覆盖前面的）。
 */
function parseDotEnvText(raw) {
    const entries = {};
    for (const line of String(raw == null ? '' : raw).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        entries[key] = value;
    }
    return entries;
}

function readEnvFileReadOnly(envFile) {
    let stat;
    try {
        stat = fs.statSync(envFile);
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
            return { exists: false, mode: null, entries: {}, readError: null, error: null };
        }
        return { exists: false, mode: null, entries: {}, readError: null, error: `无法访问 .env: ${error?.code || error?.message || error}` };
    }
    if (!stat.isFile()) {
        return { exists: false, mode: null, entries: {}, readError: null, error: '.env 不是普通文件' };
    }
    let raw;
    try {
        raw = fs.readFileSync(envFile, 'utf8');
    } catch (error) {
        return { exists: true, mode: stat.mode & 0o777, entries: {}, readError: `无法读取 .env: ${error?.code || error?.message || error}`, error: null };
    }
    return {
        exists: true,
        mode: stat.mode & 0o777,
        entries: parseDotEnvText(raw),
        readError: null,
        error: null
    };
}

function evaluateEnvFile(info, platform = process.platform) {
    const state = info || {};
    if (!state.exists) {
        return makeCheck('fail', '.env 文件与权限', state.error || '项目根缺少 .env',
            `cp env.example ${ENV_FILE_NAME}，再填写 PAPER_ANALYZER_* 与代理配置`);
    }
    if (state.readError) {
        return makeCheck('fail', '.env 文件与权限', state.readError, '修复 .env 读取权限后重试');
    }
    if (platform !== 'win32' && state.mode !== 0o600) {
        const mode = Number.isInteger(state.mode) ? state.mode.toString(8).padStart(3, '0') : '未知';
        return makeCheck('warn', '.env 文件与权限', `.env 存在，权限 ${mode}（应为 0600）`, `chmod 600 ${ENV_FILE_NAME}`);
    }
    return makeCheck('ok', '.env 文件与权限', '.env 存在，权限 0600');
}

function describeEndpoint(value) {
    return isHttpUrl(value) ? sanitizeUrlForDisplay(value) : '(非法 URL)';
}

function evaluatePrimaryModel(env) {
    const required = ['PAPER_ANALYZER_API_KEY', 'PAPER_ANALYZER_MODEL', 'PAPER_ANALYZER_ENDPOINT'];
    const missing = required.filter(key => !hasEnvValue(env, key));
    if (missing.length > 0) {
        return makeCheck('fail', '主模型配置', `缺少 ${missing.join('、')}`,
            '在 .env 补全 PAPER_ANALYZER_API_KEY / MODEL / ENDPOINT');
    }
    const model = String(env.PAPER_ANALYZER_MODEL).trim();
    const endpoint = describeEndpoint(env.PAPER_ANALYZER_ENDPOINT);
    const fallback = hasEnvValue(env, 'PAPER_ANALYZER_FALLBACK_API_KEYS') ? '，备用账号已配置' : '';
    if (!isHttpUrl(env.PAPER_ANALYZER_ENDPOINT)) {
        return makeCheck('warn', '主模型配置', `模型 ${model}；ENDPOINT 不是合法 HTTP(S) URL${fallback}`,
            '检查 .env 的 PAPER_ANALYZER_ENDPOINT');
    }
    if (model !== REQUIRED_MODEL) {
        return makeCheck('fail', '主模型配置', `模型 ${model}，要求 ${REQUIRED_MODEL}（endpoint ${endpoint}${fallback}；API Key 已配置，值不显示）`,
            `把 .env 的 PAPER_ANALYZER_MODEL 设为 ${REQUIRED_MODEL}`);
    }
    return makeCheck('ok', '主模型配置', `模型 ${model}（endpoint ${endpoint}${fallback}；API Key 已配置，值不显示）`);
}

function evaluateSecondaryModel(env) {
    const keys = {
        model: 'PAPER_ANALYZER_SECONDARY_MODEL',
        endpoint: 'PAPER_ANALYZER_SECONDARY_ENDPOINT',
        apiKey: 'PAPER_ANALYZER_SECONDARY_API_KEY'
    };
    const present = Object.entries(keys).filter(([, key]) => hasEnvValue(env, key));
    const missingKeys = Object.values(keys).filter(key => !hasEnvValue(env, key));
    if (present.length === 0) {
        return makeCheck('warn', '副模型配置', '未配置副模型（将按单模型模式运行）',
            '如需多模态图像分析，补全 PAPER_ANALYZER_SECONDARY_MODEL / ENDPOINT / API_KEY');
    }
    if (missingKeys.length > 0) {
        return makeCheck('warn', '副模型配置', `副模型配置不完整（缺少 ${missingKeys.join('、')}），将按单模型模式运行`,
            '补全 PAPER_ANALYZER_SECONDARY_* 三项后生效');
    }
    const model = String(env[keys.model]).trim();
    const endpoint = describeEndpoint(env[keys.endpoint]);
    if (!isHttpUrl(env[keys.endpoint])) {
        return makeCheck('warn', '副模型配置', `模型 ${model}；ENDPOINT 不是合法 HTTP(S) URL`,
            '检查 .env 的 PAPER_ANALYZER_SECONDARY_ENDPOINT');
    }
    if (model !== REQUIRED_MODEL) {
        return makeCheck('fail', '副模型配置', `副模型 ${model}，要求 ${REQUIRED_MODEL}（endpoint ${endpoint}；API Key 已配置，值不显示）`,
            `把 .env 的 PAPER_ANALYZER_SECONDARY_MODEL 设为 ${REQUIRED_MODEL}`);
    }
    return makeCheck('ok', '副模型配置', `副模型 ${model}（endpoint ${endpoint}；API Key 已配置，值不显示）`);
}

function resolveHttpConnectProxy(env) {
    const candidates = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY'];
    let invalid = null;
    for (const key of candidates) {
        if (!hasEnvValue(env, key)) continue;
        const value = String(env[key]).trim();
        try {
            const protocol = new URL(value).protocol;
            if (protocol === 'http:' || protocol === 'https:') return { url: value, source: key, error: null };
            if (!invalid) invalid = { key, protocol };
        } catch (_error) {
            if (!invalid) invalid = { key, protocol: '非法 URL' };
        }
    }
    for (const key of ['all_proxy', 'ALL_PROXY']) {
        if (!hasEnvValue(env, key)) continue;
        let protocol = '未知协议';
        try { protocol = new URL(String(env[key])).protocol; } catch (_error) { /* 保持未知 */ }
        return { url: null, source: key, error: `只配置了 ${key}（${protocol}）；muse-spark 与 arXiv 需要 HTTP(S) CONNECT 代理` };
    }
    if (invalid) {
        return { url: null, source: invalid.key, error: `${invalid.key} 的协议为 ${invalid.protocol}；需要 http: 或 https: 的 HTTP CONNECT 地址` };
    }
    return { url: null, source: null, error: '未配置 HTTPS_PROXY/HTTP_PROXY' };
}

function evaluateProxy(env) {
    const resolved = resolveHttpConnectProxy(env);
    if (resolved.error) {
        return makeCheck('fail', 'HTTP 代理', resolved.error,
            '在 .env 配置 HTTPS_PROXY=http://127.0.0.1:7897（HTTP CONNECT 地址）');
    }
    return makeCheck('ok', 'HTTP 代理', `使用 ${resolved.source}: ${sanitizeUrlForDisplay(resolved.url)}（HTTP CONNECT）`);
}

// ═══════════════════════════════════════════════════════
// 工作区角色
// ═══════════════════════════════════════════════════════

function evaluateWorkspaceRole(result) {
    const state = result || {};
    if (!state.ok) {
        return makeCheck('fail', '工作区角色', `无法确认角色: ${truncatedText(maskTextPaths(state.error || '未知错误'), 160)}`,
            'npm run workspace:role -- set daily（先核对当前目录用途）');
    }
    if (state.role === 'daily') {
        return makeCheck('ok', '工作区角色', 'daily（标记与真实路径一致）');
    }
    return makeCheck('warn', '工作区角色', `${state.role}（日更入口需要 daily）`,
        'npm run workspace:role -- status');
}

function evaluateSandbox(env) {
    const sandbox = typeof env?.CODEX_SANDBOX === 'string' ? env.CODEX_SANDBOX.trim() : '';
    if (sandbox) {
        return makeCheck('warn', '运行环境', `检测到 CODEX_SANDBOX=${truncatedText(sandbox, 40)}；其他项目脚本会拒绝在沙箱内运行`,
            '在沙箱外重新执行生产命令');
    }
    return makeCheck('ok', '运行环境', '未检测到沙箱标志');
}

// ═══════════════════════════════════════════════════════
// 磁盘占用（有界只读递归 stat，不打开文件、不跟随符号链接）
// ═══════════════════════════════════════════════════════

function formatBytes(bytes) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = Number(bytes) || 0;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function walkDirSizeLimited(root, options = {}) {
    const fsModule = options.fsModule || fs;
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const budgetMs = Number.isFinite(options.budgetMs) ? Math.max(1, options.budgetMs) : 1200;
    const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(1, Math.floor(options.maxEntries)) : 50000;
    const deadline = now() + budgetMs;
    const result = {
        path: path.resolve(String(root)),
        exists: false,
        rootKind: 'missing',
        complete: true,
        bytes: 0,
        files: 0,
        directories: 0,
        symlinks: 0,
        entries: 0,
        budgetMs,
        errors: []
    };
    let rootStat;
    try {
        rootStat = fsModule.lstatSync(result.path);
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return result;
        result.rootKind = 'error';
        result.complete = false;
        result.errors.push({ path: result.path, message: error?.code || error?.message || String(error) });
        return result;
    }
    result.exists = true;
    if (rootStat.isSymbolicLink()) {
        // 根是符号链接时不能跟随（统计范围必须留在受控目录内），也不能报 0 B。
        result.rootKind = 'symlink';
        result.symlinks += 1;
        result.entries = 1;
        return result;
    }
    if (rootStat.isFile()) {
        result.rootKind = 'file';
        result.files = 1;
        result.bytes = rootStat.size;
        result.entries = 1;
        return result;
    }
    if (!rootStat.isDirectory()) {
        result.rootKind = 'other';
        result.entries = 1;
        return result;
    }
    result.rootKind = 'directory';
    const stack = [result.path];
    while (stack.length > 0) {
        if (result.entries >= maxEntries || now() > deadline) {
            result.complete = false;
            break;
        }
        const entryPath = stack.pop();
        result.entries += 1;
        let stat;
        try {
            stat = fsModule.lstatSync(entryPath);
        } catch (error) {
            result.errors.push({ path: entryPath, message: error?.code || error?.message || String(error) });
            continue;
        }
        if (stat.isSymbolicLink()) {
            // 不跟随符号链接：统计范围严格限制在这三个目录内。
            result.symlinks += 1;
            continue;
        }
        if (stat.isFile()) {
            result.files += 1;
            result.bytes += stat.size;
            continue;
        }
        if (!stat.isDirectory()) continue;
        result.directories += 1;
        let names;
        try {
            names = fsModule.readdirSync(entryPath);
        } catch (error) {
            result.errors.push({ path: entryPath, message: error?.code || error?.message || String(error) });
            continue;
        }
        for (const name of names) stack.push(path.join(entryPath, name));
    }
    return result;
}

function measureDiskUsage(projectRoot = PROJECT_ROOT, options = {}) {
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const totalBudgetMs = Number.isFinite(options.budgetMs) ? options.budgetMs : DISK_TOTAL_BUDGET_MS;
    let entriesLeft = Number.isFinite(options.maxEntries) ? options.maxEntries : DISK_MAX_ENTRIES;
    const start = now();
    // 小目录先统计；大目录拿剩余预算，避免小目录被挤掉。
    const order = ['logs', 'data/current', 'data/runtime'];
    const measured = new Map();
    for (const key of order) {
        const budgetMs = Math.max(1, start + totalBudgetMs - now());
        const result = walkDirSizeLimited(path.join(projectRoot, key), {
            fsModule: options.fsModule,
            now,
            budgetMs,
            maxEntries: Math.max(1, entriesLeft)
        });
        entriesLeft -= result.entries;
        measured.set(key, { ...result, key });
    }
    return DISK_TARGETS.map(target => measured.get(target.key)).filter(Boolean);
}

function checkDiskUsage(measurements) {
    const byKey = new Map();
    for (const item of measurements || []) {
        if (item && item.key) byKey.set(item.key, item);
    }
    return DISK_TARGETS.map(target => {
        const item = byKey.get(target.key);
        if (!item) {
            return makeCheck('fail', target.label, '未能统计该目录');
        }
        if (item.rootKind === 'error') {
            return makeCheck('fail', target.label, '无法读取目录信息（权限或 I/O 错误）',
                '检查该目录权限后重试；不要为此修改权限或删除目录');
        }
        if (!item.exists) {
            return makeCheck('ok', target.label, '目录不存在（未初始化或已清理）');
        }
        if (item.rootKind === 'symlink') {
            return makeCheck('warn', target.label, '根是符号链接，未跟随符号链接，无法统计占用',
                '把该路径改为真实目录（或确认软链指向的目录后再统计）');
        }
        if (item.rootKind === 'file' || item.rootKind === 'other') {
            const kind = item.rootKind === 'file' ? '普通文件' : '非目录项';
            return makeCheck('warn', target.label, `根不是目录（${kind}），无法统计目录占用`,
                '检查该路径是否被文件占用或挂载异常');
        }
        if (!item.complete) {
            const note = item.bytes > target.softLimitBytes
                ? `，已超过软上限 ${formatBytes(target.softLimitBytes)}`
                : '';
            return makeCheck('warn', target.label,
                `≥ ${formatBytes(item.bytes)}（已扫描 ${item.entries} 项后达到 ${item.budgetMs}ms 预算，结果不完整${note}）`,
                'npm run storage:status 查看完整统计');
        }
        const detail = `${formatBytes(item.bytes)}（${item.files} 个文件）`;
        if (item.bytes > target.softLimitBytes) {
            return makeCheck('warn', target.label, `${detail}，超过软上限 ${formatBytes(target.softLimitBytes)}`,
                'npm run storage:status 查看分布；npm run storage:prune 预览清理');
        }
        return makeCheck('ok', target.label, detail);
    });
}

// ═══════════════════════════════════════════════════════
// 博客仓库
// ═══════════════════════════════════════════════════════

function resolveBlogRepoPath(env) {
    const configured = hasEnvValue(env, 'PAPER_DIGEST_BLOG_REPO');
    const raw = configured ? String(env.PAPER_DIGEST_BLOG_REPO).trim() : DEFAULT_BLOG_REPO;
    return { configured, path: path.resolve(expandHomePath(raw)) };
}

function pathKind(target, fsModule = fs) {
    try {
        const stat = fsModule.statSync(target);
        if (stat.isDirectory()) return 'directory';
        if (stat.isFile()) return 'file';
        return 'other';
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
        return 'error';
    }
}

function unquoteGitPath(value) {
    const text = String(value == null ? '' : value);
    if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
        return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return text;
}

function parseGitStatusPaths(stdout) {
    const paths = [];
    let lineCount = 0;
    for (const rawLine of String(stdout == null ? '' : stdout).split(/\r?\n/)) {
        const line = rawLine.replace(/\r$/, '');
        if (!line.trim()) continue;
        lineCount += 1;
        const rest = line.slice(3);
        // 先按 " -> " 拆分（改名行两侧可能各自带引号），再去引号。
        const renameIndex = rest.indexOf(' -> ');
        if (renameIndex >= 0) {
            const before = unquoteGitPath(rest.slice(0, renameIndex));
            const after = unquoteGitPath(rest.slice(renameIndex + 4));
            if (before) paths.push(before);
            if (after) paths.push(after);
        } else {
            const single = unquoteGitPath(rest);
            if (single) paths.push(single);
        }
    }
    return { lineCount, paths };
}

function findDateOverlap(paths, date) {
    const target = String(date || '');
    if (!target) return [];
    // 日期段后只要不是数字就算重叠：覆盖 "2026-10-22 new.md"、"2026-10-22_v2.md"、
    // "2026-10-22-a.md"，但不匹配 "2026-10-220-x.md"。
    const pattern = new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`);
    const found = new Set();
    for (const candidate of paths || []) {
        const normalized = String(candidate).replace(/\\/g, '/');
        const segments = normalized.split('/');
        if (segments.some(segment => pattern.test(segment))) {
            found.add(String(candidate));
        }
    }
    return [...found];
}

const HUGO_CONFIG_CANDIDATES = Object.freeze([
    'hugo.toml',
    'hugo.yaml',
    'hugo.json',
    'config.toml',
    'config.yaml',
    'config.json',
    'config/_default'
]);

function findHugoConfig(repoPath, fsModule = fs) {
    for (const candidate of HUGO_CONFIG_CANDIDATES) {
        const target = path.join(repoPath, candidate);
        try {
            const stat = fsModule.statSync(target);
            if (stat.isDirectory() || stat.isFile()) return candidate;
        } catch (_error) {
            // 继续检查下一个候选。
        }
    }
    return null;
}

function inspectBlogRepo(repoPath) {
    const result = {
        repoPath,
        exists: false,
        postsExists: false,
        hugoConfig: null,
        isGitRepo: false,
        git: null
    };
    if (!repoPath || pathKind(repoPath) !== 'directory') return result;
    result.exists = true;
    result.postsExists = pathKind(path.join(repoPath, 'content', 'posts')) === 'directory';
    result.hugoConfig = findHugoConfig(repoPath);
    if (!result.postsExists && !result.hugoConfig) return result;
    if (!result.postsExists) return result;

    // GIT_OPTIONAL_LOCKS=0：git status 不刷新索引，保持只读。
    // 只传 git 需要的最小环境，避免把 .env 密钥透传给子进程。
    const gitEnv = {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME || os.homedir(),
        LC_ALL: 'C',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0'
    };
    const probe = spawnSync('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf8',
        timeout: GIT_PROBE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: gitEnv
    });
    result.isGitRepo = probe.status === 0 && String(probe.stdout || '').trim() === 'true';
    if (!result.isGitRepo) {
        return result;
    }
    const status = spawnSync('git', ['-C', repoPath, 'status', '--porcelain=v1', '--untracked-files=normal'], {
        encoding: 'utf8',
        timeout: GIT_STATUS_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        env: gitEnv
    });
    result.git = {
        status: status.status,
        stdout: status.stdout || '',
        stderr: status.stderr || '',
        error: status.error || null,
        timedOut: status.error?.code === 'ETIMEDOUT'
    };
    return result;
}

function evaluateBlogRepo(input) {
    const state = input || {};
    const home = state.homeDirectory || os.homedir();
    const displayRepo = maskPath(state.repoPath || '', home) || '(未配置)';
    const date = String(state.date || '');
    const dateNote = state.dateNote || '';
    const prefix = state.configured ? '' : '未设置 PAPER_DIGEST_BLOG_REPO，按默认路径检查；';
    const targetLabel = date ? `目标日 ${date}${dateNote}` : '未指定目标日';
    if (!state.exists) {
        return makeCheck('fail', '博客仓库', `${prefix}仓库不存在: ${displayRepo}`,
            '在 .env 设置 PAPER_DIGEST_BLOG_REPO 指向真实 Hugo 仓库');
    }
    if (!state.postsExists) {
        if (state.hugoConfig) {
            // 显式配置的仓库缺少 content/posts 时仍是硬错误：发布/去重会得到空集合。
            return makeCheck(state.configured ? 'fail' : 'warn', '博客仓库',
                `${prefix}仓库像 Hugo（找到 ${state.hugoConfig}）但缺少 content/posts: ${displayRepo}`,
                '确认博客仓库的 posts 目录位置；发布与去重都依赖 content/posts');
        }
        return makeCheck('fail', '博客仓库',
            `${prefix}仓库缺少 content/posts 且未找到 Hugo 配置，不是 Hugo 博客仓库: ${displayRepo}`,
            '确认 PAPER_DIGEST_BLOG_REPO 指向 Hugo 博客仓库根目录');
    }
    if (!state.isGitRepo) {
        return makeCheck('fail', '博客仓库', `${prefix}不是 Git 仓库: ${displayRepo}`,
            'git -C "$PAPER_DIGEST_BLOG_REPO" rev-parse --is-inside-work-tree');
    }
    const git = state.git || { error: { message: 'git status 未执行' } };
    if (git.error || git.timedOut) {
        const reason = git.timedOut ? `git status 超过 ${GIT_STATUS_TIMEOUT_MS}ms` : truncatedText(git.error?.message || git.error);
        return makeCheck('fail', '博客仓库', `${prefix}${displayRepo}；git status 失败: ${reason}`,
            'git -C "$PAPER_DIGEST_BLOG_REPO" status --porcelain');
    }
    if (git.status !== 0) {
        return makeCheck('fail', '博客仓库', `${prefix}${displayRepo}；git status 退出码 ${git.status}: ${truncatedText(String(git.stderr || '').trim())}`,
            'git -C "$PAPER_DIGEST_BLOG_REPO" status --porcelain');
    }
    const parsed = parseGitStatusPaths(git.stdout);
    const overlap = findDateOverlap(parsed.paths, date);
    if (overlap.length > 0) {
        const shown = overlap.slice(0, 3).map(item => `“${item}”`).join('、');
        const more = overlap.length > 3 ? ` 等 ${overlap.length} 项` : '';
        return makeCheck('fail', '博客仓库',
            `${prefix}${displayRepo}；发现与${targetLabel}重叠的未提交改动: ${shown}${more}`,
            '先提交、移走或处理这些改动，再运行日更/发布');
    }
    if (parsed.lineCount > 0) {
        return makeCheck('warn', '博客仓库',
            `${prefix}${displayRepo}；${parsed.lineCount} 个未提交改动，与${targetLabel}不重叠`,
            'git -C "$PAPER_DIGEST_BLOG_REPO" status --porcelain');
    }
    return makeCheck('ok', '博客仓库', `${prefix}${displayRepo}；工作区干净（${targetLabel}无重叠）`);
}

// ═══════════════════════════════════════════════════════
// LLM 账号池状态（只读 JSON，不取锁、不发请求）
// ═══════════════════════════════════════════════════════

function readAccountPoolState(stateFile, nowMs = Date.now()) {
    let stat;
    try {
        stat = fs.lstatSync(stateFile);
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
            return { exists: false, valid: true, error: null, mode: null };
        }
        return { exists: true, valid: false, error: `无法读取: ${error?.code || error?.message || error}`, mode: null };
    }
    // 生产读取（readStateStrict）拒绝 symlink；体检也不能跟随它。
    if (stat.isSymbolicLink()) {
        return { exists: true, valid: false, error: '状态路径是符号链接（生产读取会拒绝）', mode: null };
    }
    if (!stat.isFile()) {
        return { exists: true, valid: false, error: '状态路径不是普通文件', mode: null };
    }
    const mode = stat.mode & 0o777;
    let raw;
    try {
        raw = fs.readFileSync(stateFile, 'utf8');
    } catch (error) {
        return { exists: true, valid: false, error: `无法读取: ${error?.code || error?.message || error}`, mode };
    }
    let state;
    try {
        state = JSON.parse(raw);
    } catch (_error) {
        return { exists: true, valid: false, error: 'JSON 无法解析', mode };
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)
        || state.schemaVersion !== LLM_POOL_STATE_SCHEMA_VERSION
        || state.policyVersion !== LLM_POOL_POLICY_VERSION
        || !isPlainObject(state.services)
        || !Number.isSafeInteger(state.generation) || state.generation < 0) {
        return { exists: true, valid: false, error: 'schema 非法', mode };
    }
    let accounts = 0;
    let blocked = 0;
    let services = 0;
    let earliestRecoveryMs = null;
    for (const service of Object.values(state.services)) {
        if (!isPlainObject(service) || typeof service.endpoint !== 'string'
            || !isPlainObject(service.accounts) || !isPlainObject(service.groups)) {
            return { exists: true, valid: false, error: 'service 记录非法', mode };
        }
        services += 1;
        for (const record of Object.values(service.accounts)) {
            if (!isPlainObject(record)
                || (record.blockedUntilMs !== undefined
                    && (!Number.isFinite(record.blockedUntilMs) || record.blockedUntilMs < 0))) {
                return { exists: true, valid: false, error: 'account 记录非法', mode };
            }
            accounts += 1;
            if (Number.isFinite(record.blockedUntilMs) && record.blockedUntilMs > nowMs) {
                blocked += 1;
                if (earliestRecoveryMs === null || record.blockedUntilMs < earliestRecoveryMs) {
                    earliestRecoveryMs = record.blockedUntilMs;
                }
            }
        }
        for (const group of Object.values(service.groups)) {
            // rotationCursor / lastSelectedAtMs 是等权轮转新增的可选字段，
            // 与 llm-account-pool.readStateStrict 的校验保持一致。
            if (!isPlainObject(group)
                || (group.activeAccountId !== null
                    && group.activeAccountId !== undefined
                    && typeof group.activeAccountId !== 'string')
                || (group.rotationCursor !== undefined
                    && (!Number.isSafeInteger(group.rotationCursor) || group.rotationCursor < 0))
                || (group.lastSelectedAtMs !== undefined
                    && (!Number.isFinite(group.lastSelectedAtMs) || group.lastSelectedAtMs < 0))) {
                return { exists: true, valid: false, error: 'group 记录非法', mode };
            }
        }
    }
    return { exists: true, valid: true, error: null, mode, accounts, blocked, services, earliestRecoveryMs };
}

function evaluateAccountPool(input, platform = process.platform) {
    const state = input || {};
    const modeLabel = Number.isInteger(state.mode) ? state.mode.toString(8).padStart(3, '0') : null;
    const modeWarning = platform !== 'win32' && modeLabel !== null && state.mode !== 0o600;
    const withMode = (check) => {
        if (!modeWarning) return check;
        const detail = `权限 ${modeLabel}（应为 0600）；${check.detail}`;
        const chmodHint = 'chmod 600 data/runtime/llm-account-pool.json';
        if (check.ok === 'ok') {
            return makeCheck('warn', check.label, detail, chmodHint);
        }
        if (check.ok === 'warn') {
            const hint = check.hint ? `${chmodHint}；${check.hint}` : chmodHint;
            return { ...check, detail, hint };
        }
        return { ...check, detail };
    };
    if (!state.exists) {
        return makeCheck('ok', '账号池状态', '无状态文件（尚未使用账号池或已清理）');
    }
    if (!state.valid) {
        return makeCheck('fail', '账号池状态', `状态文件不可用: ${state.error}`,
            '检查 data/runtime/llm-account-pool.json（只读）；修复前不要开新批次');
    }
    if (!state.accounts) {
        return withMode(makeCheck('ok', '账号池状态', '状态文件存在，尚无账号记录'));
    }
    const recovery = Number.isFinite(state.earliestRecoveryMs)
        ? new Date(state.earliestRecoveryMs).toISOString()
        : null;
    if (state.blocked === 0) {
        return withMode(makeCheck('ok', '账号池状态', `${state.accounts} 个账号，全部可用`));
    }
    if (state.blocked >= state.accounts) {
        return withMode(makeCheck('fail', '账号池状态', `${state.accounts} 个账号全部冷却；最早恢复 ${recovery || '未知'}`,
            '等待恢复或补充备用账号；不要对同一故障反复重试'));
    }
    return withMode(makeCheck('warn', '账号池状态', `${state.accounts} 个账号，${state.blocked} 个冷却；最早恢复 ${recovery || '未知'}`,
        'npm run usage:report 查看账号用量'));
}

// ═══════════════════════════════════════════════════════
// 网络探测（仅 --network；必须经项目 HTTP CONNECT 代理）
// ═══════════════════════════════════════════════════════

function friendlyNetworkError(error) {
    const message = truncatedText(error?.message || error || '未知网络错误');
    const code = error?.code || error?.cause?.code;
    return code && !message.includes(String(code)) ? `${message}（${code}）` : message;
}

function evaluateAtomProbe(probe) {
    const result = probe || {};
    if (result.error) {
        return makeCheck('fail', 'arXiv Atom 探测', `请求失败: ${friendlyNetworkError(result.error)}`,
            '检查代理与 export.arxiv.org 可达性；不要改成直连');
    }
    if (result.status !== 200) {
        return makeCheck('fail', 'arXiv Atom 探测', `HTTP ${result.status}`,
            '检查代理与 arXiv 服务状态后重试');
    }
    const body = String(result.body || '');
    if (!/<feed[\s>]/.test(body) || !/<entry[\s>]/.test(body)) {
        return makeCheck('fail', 'arXiv Atom 探测', `HTTP 200 但响应不是完整 Atom feed（${Buffer.byteLength(body)} 字节）`,
            '检查代理是否返回了拦截页');
    }
    return makeCheck('ok', 'arXiv Atom 探测', `HTTP 200，Atom feed 正常（${Buffer.byteLength(body)} 字节）`);
}

function evaluateOaiProbe(probe) {
    const result = probe || {};
    if (result.error) {
        return makeCheck('fail', 'arXiv OAI 探测', `请求失败: ${friendlyNetworkError(result.error)}`,
            '检查代理与 oaipmh.arxiv.org 可达性');
    }
    if (result.status !== 200) {
        return makeCheck('fail', 'arXiv OAI 探测', `HTTP ${result.status}`,
            '检查代理与 arXiv OAI 服务状态后重试');
    }
    const body = String(result.body || '');
    if (!/<OAI-PMH[\s>]/.test(body) || !/<Identify>/.test(body) || /<error[\s>]/.test(body)) {
        return makeCheck('fail', 'arXiv OAI 探测', `HTTP 200 但 Identify 响应异常（${Buffer.byteLength(body)} 字节）`,
            '检查代理是否返回了拦截页或 OAI 错误');
    }
    return makeCheck('ok', 'arXiv OAI 探测', `HTTP 200，Identify 正常（${Buffer.byteLength(body)} 字节）`);
}

function parseRssPubDate(xml) {
    const source = String(xml || '');
    const channelMatch = source.match(/<channel[\s>][\s\S]*?<\/channel>/i);
    const scope = channelMatch ? channelMatch[0] : source;
    const match = scope.match(/<pubDate>\s*([^<]+?)\s*<\/pubDate>/i);
    if (!match) return null;
    const raw = match[1].trim();
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) return null;
    return { raw, ms, date: new Date(ms) };
}

function formatDateInTimeZone(date, timeZone) {
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(date);
    } catch (_error) {
        return null;
    }
}

function evaluateRssProbe(probe, targetDate, options = {}) {
    const result = probe || {};
    if (result.error) {
        return makeCheck('fail', 'arXiv RSS 公告', `请求失败: ${friendlyNetworkError(result.error)}`,
            '检查代理与 rss.arxiv.org 可达性');
    }
    if (result.status !== 200) {
        return makeCheck('fail', 'arXiv RSS 公告', `HTTP ${result.status}`,
            '检查代理与 arXiv RSS 服务状态后重试');
    }
    const parsed = parseRssPubDate(result.body);
    if (!parsed) {
        return makeCheck('fail', 'arXiv RSS 公告', `HTTP 200 但未找到可解析的 pubDate（${RSS_CATEGORY}）`,
            '检查 RSS 响应是否为完整 XML');
    }
    // arXiv RSS 的公告日是本机（美国东部）午夜；按东部日期与目标日比较。
    const announcementDate = formatDateInTimeZone(parsed.date, 'America/New_York');
    if (!announcementDate) {
        return makeCheck('warn', 'arXiv RSS 公告', `pubDate 已解析但无法换算东部日期: ${truncatedText(parsed.raw, 60)}`,
            '手动检查 RSS pubDate');
    }
    const target = String(targetDate || '');
    if (announcementDate === target) {
        return makeCheck('ok', 'arXiv RSS 公告', `目标日 ${target} 公告已生成（pubDate ${parsed.raw}）`);
    }
    const today = options.todayDate || beijingDateString();
    if (target && target < today) {
        return makeCheck('warn', 'arXiv RSS 公告',
            `目标日 ${target} 是历史日期，当前公告日 ${announcementDate}（pubDate ${parsed.raw}）`,
            '历史日期不依赖当天公告；使用受控历史入口和已有数据');
    }
    if (target && target > today) {
        return makeCheck('warn', 'arXiv RSS 公告',
            `目标日 ${target} 尚未到来，当前公告日 ${announcementDate}（pubDate ${parsed.raw}）`,
            '确认目标日期是否正确；arXiv 每日公告通常在北京时间 08:00 后生成');
    }
    return makeCheck('warn', 'arXiv RSS 公告',
        `RSS 当前公告日 ${announcementDate}，目标日 ${target} 尚未生成（pubDate ${parsed.raw}）`,
        'arXiv 每日公告通常在北京时间 08:00 后生成；稍后重试或先确认目标日期');
}

const MAX_PROBE_REDIRECTS = 3;

function isPrivateOrReservedHost(hostname) {
    const host = String(hostname == null ? '' : hostname).trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!host) return true;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
    if (host.includes(':')) {
        if (host === '::' || host === '::1') return true;
        if (/^f[cd]/.test(host)) return true; // fc00::/7 ULA
        if (/^fe[89ab]/.test(host)) return true; // fe80::/10 link-local
        if (/^ff/.test(host)) return true; // ff00::/8 multicast
        if (/^64:ff9b::/.test(host)) return true; // NAT64
        if (/^2002:/.test(host)) return true; // 6to4
        if (host.startsWith('::ffff:')) {
            // WHATWG URL 会把 IPv4-mapped 写成十六进制（如 ::ffff:7f00:1），
            // 先还原为点分 IPv4 再走同一套私网判断；无法还原时按保留处理。
            const tail = host.slice(7);
            const groups = tail.split(':').filter(Boolean);
            if (groups.length === 2 && groups.every(g => /^[0-9a-f]{1,4}$/.test(g))) {
                const hi = parseInt(groups[0], 16), lo = parseInt(groups[1], 16);
                const ipv4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
                return isPrivateOrReservedHost(ipv4);
            }
            return true;
        }
        return false;
    }
    const octets = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!octets) return false; // 普通域名交给代理/DNS 解析
    const numbers = octets.slice(1).map(Number);
    if (numbers.some(value => value > 255)) return true;
    const [a, b] = numbers;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0) return true; // 192.0.0/24、192.0.2/24
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 198 && b === 51) return true; // 198.51.100/24
    if (a === 203 && b === 0) return true; // 203.0.113/24
    if (a >= 224) return true; // multicast / reserved
    return false;
}

function assertAllowedProbeUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(String(rawUrl));
    } catch (_error) {
        throw Object.assign(new Error(`探测 URL 非法: ${truncatedText(rawUrl, 80)}`), { code: 'PROBE_URL_INVALID' });
    }
    if (parsed.protocol !== 'https:') {
        throw Object.assign(new Error(`探测只允许 HTTPS: ${parsed.protocol}//${parsed.hostname}`), { code: 'PROBE_URL_INSECURE' });
    }
    const normalizedHost = String(parsed.hostname || '').replace(/\.$/, '');
    if (isPrivateOrReservedHost(normalizedHost)) {
        throw Object.assign(new Error(`探测拒绝私网/保留地址: ${parsed.hostname}`), { code: 'PROBE_URL_PRIVATE' });
    }
    return parsed;
}

function probeTooLargeError(maxBytes) {
    return Object.assign(new Error(`响应超过 ${maxBytes} 字节上限`), { code: 'PROBE_TOO_LARGE' });
}

async function readProbeBody(response, maxBytes) {
    const reader = response.body?.getReader?.();
    if (!reader) {
        const declared = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) throw probeTooLargeError(maxBytes);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > maxBytes) throw probeTooLargeError(maxBytes);
        return buffer.toString('utf8');
    }
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            total += value.byteLength ?? value.length ?? 0;
            if (total > maxBytes) {
                try { await reader.cancel(); } catch (_error) { /* 已超限，取消失败不影响结论 */ }
                throw probeTooLargeError(maxBytes);
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        try { reader.releaseLock?.(); } catch (_error) { /* 释放锁失败可忽略 */ }
    }
    return Buffer.concat(chunks).toString('utf8');
}

async function fetchProbeText(fetchImpl, url, headers, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : NETWORK_TIMEOUT_MS;
    const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : NETWORK_MAX_BYTES;
    const maxRedirects = Number.isFinite(options.maxRedirects) ? options.maxRedirects : MAX_PROBE_REDIRECTS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        let currentUrl = String(url);
        for (let hop = 0; hop <= maxRedirects; hop += 1) {
            // 手动处理重定向：每一跳都重新校验 HTTPS 与非私网/保留地址。
            const parsed = assertAllowedProbeUrl(currentUrl);
            const response = await fetchImpl(parsed.toString(), {
                method: 'GET',
                headers,
                signal: controller.signal,
                redirect: 'manual',
                dispatcher: options.dispatcher
            });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const location = response.headers?.get?.('location');
                try { await response.body?.cancel?.(); } catch (_error) { /* 重定向响应体无需读取 */ }
                if (!location) {
                    throw Object.assign(new Error(`HTTP ${response.status} 重定向缺少 Location`), { code: 'PROBE_REDIRECT_INVALID' });
                }
                if (hop === maxRedirects) {
                    throw Object.assign(new Error(`重定向超过 ${maxRedirects} 次`), { code: 'PROBE_REDIRECT_LIMIT' });
                }
                currentUrl = new URL(String(location), parsed).toString();
                continue;
            }
            const declared = Number(response.headers?.get?.('content-length'));
            if (Number.isFinite(declared) && declared > maxBytes) {
                try { await response.body?.cancel?.(); } catch (_error) { /* 已超限 */ }
                throw probeTooLargeError(maxBytes);
            }
            const body = await readProbeBody(response, maxBytes);
            return { status: response.status, body, error: null };
        }
        throw Object.assign(new Error(`重定向超过 ${maxRedirects} 次`), { code: 'PROBE_REDIRECT_LIMIT' });
    } catch (error) {
        if (error?.code === 'PROBE_TOO_LARGE') {
            // 超过 maxBytes 时取消读取并中止底层请求，避免继续传输。
            try { controller.abort(); } catch (_error) { /* 已取消 */ }
        }
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
            return { status: null, body: '', error: Object.assign(new Error(`请求超过 ${timeoutMs}ms`), { code: 'PROBE_TIMEOUT' }) };
        }
        return { status: null, body: '', error };
    } finally {
        clearTimeout(timer);
    }
}

async function probeNetwork(options = {}) {
    const env = options.env || {};
    const resolved = resolveHttpConnectProxy(env);
    if (resolved.error) {
        return { proxyError: resolved.error, atom: null, oai: null, rss: null };
    }
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : NETWORK_TIMEOUT_MS;
    const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : NETWORK_MAX_BYTES;
    const fetchImpl = options.fetchImpl || require('undici').fetch;
    let dispatcher = options.dispatcher || null;
    try {
        if (!dispatcher) {
            const { ProxyAgent } = require('undici');
            dispatcher = new ProxyAgent(resolved.url);
        }
        const headers = { 'User-Agent': ARXIV_USER_AGENT };
        const [atom, oai, rss] = await Promise.all([
            fetchProbeText(fetchImpl, ARXIV_ATOM_URL, { ...headers, Accept: 'application/atom+xml' }, { timeoutMs, maxBytes, dispatcher }),
            fetchProbeText(fetchImpl, ARXIV_OAI_URL, { ...headers, Accept: 'text/xml' }, { timeoutMs, maxBytes, dispatcher }),
            fetchProbeText(fetchImpl, ARXIV_RSS_URL, { ...headers, Accept: 'application/rss+xml' }, { timeoutMs, maxBytes, dispatcher })
        ]);
        return { proxyError: null, atom, oai, rss };
    } finally {
        if (dispatcher && !options.dispatcher) {
            try { await dispatcher.close(); } catch (_error) { /* 释放连接失败不影响检查结果 */ }
        }
    }
}

function evaluateNetworkProbes(network, targetDate, options = {}) {
    const result = network || {};
    if (result.proxyError) {
        const hint = '在 .env 配置 HTTP CONNECT 代理后重试';
        return [
            makeCheck('fail', 'arXiv Atom 探测', `未探测: ${result.proxyError}`, hint),
            makeCheck('fail', 'arXiv OAI 探测', `未探测: ${result.proxyError}`, hint),
            makeCheck('fail', 'arXiv RSS 公告', `未探测: ${result.proxyError}`, hint)
        ];
    }
    return [
        evaluateAtomProbe(result.atom),
        evaluateOaiProbe(result.oai),
        evaluateRssProbe(result.rss, targetDate, options)
    ];
}

// ═══════════════════════════════════════════════════════
// 默认依赖（可在测试中整体替换，避免联网与真实扫描）
// ═══════════════════════════════════════════════════════

function runPythonRuntimeProbe(projectRoot) {
    const script = path.join(projectRoot, 'scripts', 'python-runtime.sh');
    const result = spawnSync('bash', [script, '-c', 'import sys, ssl; print(sys.version.split()[0]); print(ssl.OPENSSL_VERSION)'], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: PYTHON_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        // 只交给子进程运行所需的最小环境，不把 .env 里的密钥透传出去。
        env: {
            PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
            HOME: process.env.HOME || os.homedir(),
            LANG: process.env.LANG || 'en_US.UTF-8'
        }
    });
    return {
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        error: result.error || null
    };
}

function createDefaultDeps(projectRoot, nowMs) {
    return {
        nodeVersion: () => process.versions.node,
        readEnvFile: () => readEnvFileReadOnly(path.join(projectRoot, ENV_FILE_NAME)),
        checkPython: () => runPythonRuntimeProbe(projectRoot),
        pathKind: (target) => pathKind(target),
        readWorkspaceRole: () => {
            try {
                const marker = require('./workspace-role.js').readWorkspaceRole(projectRoot);
                return { ok: true, role: marker.role };
            } catch (error) {
                return { ok: false, error: error?.message || String(error) };
            }
        },
        measureDisk: () => measureDiskUsage(projectRoot, {
            budgetMs: DISK_TOTAL_BUDGET_MS,
            maxEntries: DISK_MAX_ENTRIES
        }),
        inspectBlog: (env) => inspectBlogRepo(resolveBlogRepoPath(env).path),
        readAccountPool: () => readAccountPoolState(path.join(projectRoot, 'data', 'runtime', 'llm-account-pool.json'), nowMs),
        probeNetwork: (context) => probeNetwork(context)
    };
}

// ═══════════════════════════════════════════════════════
// 聚合与输出
// ═══════════════════════════════════════════════════════

function safeCollect(label, collect) {
    try {
        const result = collect();
        return Array.isArray(result) ? result : [result];
    } catch (error) {
        return [makeCheck('fail', label, `检查执行失败: ${truncatedText(maskTextPaths(error?.message || error))}`,
            '单独运行该检查或查看上面的错误信息')];
    }
}

async function safeCollectAsync(label, collect) {
    try {
        const result = await collect();
        return Array.isArray(result) ? result : [result];
    } catch (error) {
        return [makeCheck('fail', label, `检查执行失败: ${truncatedText(maskTextPaths(error?.message || error))}`,
            '单独运行该检查或查看上面的错误信息')];
    }
}

async function runDoctor(options = {}) {
    const projectRoot = options.projectRoot || PROJECT_ROOT;
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const parsed = options.parsed || parseArgs(options.argv || [], { nowMs });
    const platform = options.platform || process.platform;
    const deps = { ...createDefaultDeps(projectRoot, nowMs), ...(options.deps || {}) };
    const dateNote = parsed.dateProvided ? '' : '（北京时间今天）';
    const checks = [];

    checks.push(...safeCollect('Node 版本', () => checkNodeVersion(deps.nodeVersion())));
    checks.push(...safeCollect('Python 运行时', () => evaluatePythonRuntime(deps.checkPython())));
    checks.push(...safeCollect('Node 依赖', () => evaluateNodeModules(deps.pathKind(path.join(projectRoot, 'node_modules')))));

    let envState = { exists: false, entries: {} };
    checks.push(...safeCollect('.env 文件与权限', () => {
        envState = deps.readEnvFile();
        return evaluateEnvFile(envState, platform);
    }));
    const env = isPlainObject(envState?.entries) ? envState.entries : {};
    // .env 缺失/不可读时，模型与代理检查无法判定；不要再级联出三个 fail。
    const envUsable = Boolean(envState?.exists) && !envState?.readError;
    const notEvaluated = (label) => makeCheck('warn', label, '因 .env 不可读未判定',
        '修复 .env 后重跑 npm run doctor -- --offline');

    checks.push(...safeCollect('主模型配置', () => (envUsable ? evaluatePrimaryModel(env) : notEvaluated('主模型配置'))));
    checks.push(...safeCollect('副模型配置', () => (envUsable ? evaluateSecondaryModel(env) : notEvaluated('副模型配置'))));
    checks.push(...safeCollect('HTTP 代理', () => (envUsable ? evaluateProxy(env) : notEvaluated('HTTP 代理'))));
    checks.push(...safeCollect('运行环境', () => evaluateSandbox(env)));
    checks.push(...safeCollect('工作区角色', () => evaluateWorkspaceRole(deps.readWorkspaceRole())));
    checks.push(...safeCollect('磁盘占用', () => checkDiskUsage(deps.measureDisk())));
    checks.push(...safeCollect('博客仓库', () => evaluateBlogRepo({
        ...deps.inspectBlog(env),
        date: parsed.date,
        dateNote,
        configured: resolveBlogRepoPath(env).configured
    })));
    checks.push(...safeCollect('账号池状态', () => evaluateAccountPool(deps.readAccountPool(), platform)));

    if (parsed.network) {
        const todayDate = beijingDateString(nowMs);
        checks.push(...await safeCollectAsync('网络探测', async () => {
            const network = await deps.probeNetwork({ env, date: parsed.date, timeoutMs: NETWORK_TIMEOUT_MS });
            return evaluateNetworkProbes(network, parsed.date, { todayDate });
        }));
    } else {
        checks.push(makeCheck('warn', '网络探测', '未联网：--offline 默认跳过 arXiv Atom/OAI/RSS 探测',
            'node scripts/doctor.js --network（经项目代理各探测一次）'));
    }

    return { parsed, checks, exitCode: exitCodeFor(checks) };
}

function renderTable(checks, options = {}) {
    const list = Array.isArray(checks) ? checks : [];
    const labelWidth = Math.max(12, ...list.map(check => displayWidth(check.label)));
    const lines = [];
    lines.push('论文速递体检（只读）');
    const date = options.date || '';
    const dateNote = options.dateNote || '';
    const network = options.network ? '联网探测（--network）' : '离线（--offline，不联网）';
    lines.push(`目标日期：${date || '未指定'}${dateNote} · 网络：${network}`);
    lines.push('─'.repeat(72));
    for (const check of list) {
        const icon = STATUS_ICONS[check.ok] || STATUS_ICONS.fail;
        lines.push(`${icon} ${padDisplay(check.label, labelWidth)}  ${check.detail}`);
        if (check.hint) lines.push(`   ${' '.repeat(labelWidth)}  ↳ ${check.hint}`);
    }
    const counts = countStatuses(list);
    lines.push('─'.repeat(72));
    lines.push(`合计：✅ ${counts.ok} 项正常，⚠️ ${counts.warn} 项提醒，❌ ${counts.fail} 项失败；退出码 ${exitCodeFor(list)}`);
    lines.push('本命令只读：不写文件、不发模型请求、不打印密钥。');
    return lines.join('\n');
}

async function main(argv = process.argv.slice(2)) {
    let parsed;
    try {
        parsed = parseArgs(argv);
    } catch (error) {
        console.error(`[doctor] ${error.message}`);
        console.error(USAGE);
        process.exitCode = 2;
        return;
    }
    // 沙箱守卫只放在真实入口：被 import 时不杀进程，spawn 时在任何检查/输出前拒绝。
    const sandbox = String(process.env.CODEX_SANDBOX || '').trim();
    if (sandbox) {
        console.error(`[doctor] 必须在沙箱外运行（检测到 CODEX_SANDBOX=${sandbox}）。`);
        process.exitCode = 1;
        return;
    }
    if (parsed.help) {
        // --help 优先；同时给了 --json 时仍输出可解析的 JSON 数组。
        if (parsed.json) console.log(JSON.stringify([makeCheck('ok', 'help', USAGE)], null, 2));
        else console.log(USAGE);
        return;
    }
    const { checks } = await runDoctor({ parsed });
    const envInfo = safeCollect('.env', () => readEnvFileReadOnly(path.join(PROJECT_ROOT, ENV_FILE_NAME)))[0];
    const envEntries = isPlainObject(envInfo?.entries) ? envInfo.entries : {};
    const redacted = redactChecks(checks, collectSecretValues(envEntries));
    if (parsed.json) {
        console.log(JSON.stringify(redacted, null, 2));
    } else {
        console.log(renderTable(redacted, {
            date: parsed.date,
            dateNote: parsed.dateProvided ? '' : '（北京时间今天）',
            network: parsed.network
        }));
    }
    process.exitCode = exitCodeFor(redacted);
}

module.exports = {
    PROJECT_ROOT,
    REQUIRED_NODE_RANGE,
    REQUIRED_MODEL,
    DEFAULT_BLOG_REPO,
    DISK_TARGETS,
    USAGE,
    makeCheck,
    maskPath,
    maskTextPaths,
    sanitizeUrlForDisplay,
    collectSecretValues,
    redactText,
    redactChecks,
    countStatuses,
    exitCodeFor,
    displayWidth,
    padDisplay,
    isValidDateString,
    beijingDateString,
    parseArgs,
    parseVersionParts,
    compareVersionParts,
    isPrereleaseVersion,
    satisfiesNodeRange,
    checkNodeVersion,
    evaluatePythonRuntime,
    evaluateNodeModules,
    parseDotEnvText,
    readEnvFileReadOnly,
    evaluateEnvFile,
    evaluatePrimaryModel,
    evaluateSecondaryModel,
    resolveHttpConnectProxy,
    evaluateProxy,
    evaluateWorkspaceRole,
    evaluateSandbox,
    formatBytes,
    walkDirSizeLimited,
    measureDiskUsage,
    checkDiskUsage,
    resolveBlogRepoPath,
    pathKind,
    unquoteGitPath,
    parseGitStatusPaths,
    findDateOverlap,
    HUGO_CONFIG_CANDIDATES,
    findHugoConfig,
    inspectBlogRepo,
    evaluateBlogRepo,
    readAccountPoolState,
    evaluateAccountPool,
    parseRssPubDate,
    formatDateInTimeZone,
    evaluateAtomProbe,
    evaluateOaiProbe,
    evaluateRssProbe,
    MAX_PROBE_REDIRECTS,
    isPrivateOrReservedHost,
    assertAllowedProbeUrl,
    readProbeBody,
    fetchProbeText,
    evaluateNetworkProbes,
    probeNetwork,
    createDefaultDeps,
    runDoctor,
    renderTable,
    main
};

if (require.main === module) {
    main().catch(error => {
        console.error(`[doctor] ${maskTextPaths(error?.stack || error?.message || error)}`);
        process.exitCode = 2;
    });
}
