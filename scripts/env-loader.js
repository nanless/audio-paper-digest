const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_ENV_FILE = path.join(PROJECT_ROOT, '.env');

const PROJECT_ENV_PREFIXES = [
    'PAPER_ANALYZER_',
    'PAPER_DIGEST_',
    'PD_',
    'WECHAT_',
    'FEISHU_',
    'XIAOHONGSHU_'
];

const PROJECT_ENV_KEYS = new Set([
    'KIMI_API_KEY',
    'MIMO_API_KEY',
    'DEEPSEEK_API_KEY',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'
]);

const CHILD_ENV_PASSTHROUGH_KEYS = Object.freeze([
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SYSTEMROOT', 'WINDIR', 'PATHEXT',
    'COMSPEC'
]);

const VCS_CHILD_ENV_KEYS = Object.freeze(['SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GPG_TTY']);

const TRANSPORT_ENV_KEYS = Object.freeze([
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'
]);

// 受严格核验的进程级输入/运行时标记，不改变模型或代理配置；与 scripts/project_env.py 保持一致。
const PROCESS_INPUT_KEYS = Object.freeze([
    'PD_PUBLISH_RASTER_RECOVERY_FILE',
    'PD_PYTHON_RUNTIME_VERIFIED_BIN'
]);

function isScriptsEntrypoint(scriptPath = process.argv[1]) {
    if (!scriptPath) return false;
    // 在 `node -e` 下，argv[1] 是第一个用户参数，不是被执行的模块。
    // 把它当成入口点会影响单独运行的工作进程测试，
    // 还会给一个只是被导入的模块分配角色。
    if (process.execArgv.some(arg => arg === '-e' || arg === '--eval' || arg.startsWith('--eval='))) {
        return false;
    }
    const resolved = path.resolve(scriptPath);
    const entryRoots = [
        path.resolve(__dirname),
        path.join(PROJECT_ROOT, 'manual', 'scripts')
    ];
    return entryRoots.some(root => resolved.startsWith(`${root}${path.sep}`))
        && path.extname(resolved) === '.js';
}

function requireExternalRuntime(commandName = path.basename(process.argv[1] || 'script'), options = {}) {
    const sandbox = String(process.env.CODEX_SANDBOX || '').trim();
    if (sandbox) {
        throw new Error(
            `${commandName} 必须在沙箱外运行（检测到 CODEX_SANDBOX=${sandbox}）。`
            + '项目脚本可能访问本机代理、LLM、外部站点、Hugo 或 Git；'
            + '请以沙箱外权限重新执行，禁止在沙箱内降级、跳过或伪造运行结果。'
        );
    }
    const inferredRole = requiredWorkspaceRoleForCommand(commandName);
    const wrappedRole = String(process.env.AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE || '').trim();
    const enforceRole = Boolean(wrappedRole) || isScriptsEntrypoint()
        || options.enforceWorkspaceRole === true;
    if (enforceRole && wrappedRole && inferredRole && wrappedRole !== inferredRole) {
        throw new Error(`${commandName} 固定要求 role=${inferredRole}，当前环境指定 wrapper=${wrappedRole}，两者不一致`);
    }
    const requiredRole = enforceRole ? inferredRole || wrappedRole : null;
    // workspaceRoot 是内部测试注入用的；生产入口从不从 CLI 或环境里接受它。
    if (requiredRole) require('./workspace-role.js').requireWorkspaceRole(
        requiredRole, options.workspaceRoot || PROJECT_ROOT
    );
}

const DEFAULT_JS_WORKSPACE_ROLE_COMMANDS = Object.freeze({
    newConferenceDaily: [
        'conference-tools.js', 'conference-discover.js', 'conference-filter.js',
        'conference-filter-run.js', 'conference-filter-evidence.js', 'conference-staging.js', 'conference-import.js',
        'conference-plan.js', 'conference-process.js', 'conference-reader-publication-evidence.js',
        'conference-publication-author-replay-cli.js'
    ],
    daily: [
        'full-fetch.js', 'deep-analysis-only.js', 'batch-analyze.js', 'reanalyze.js',
        'refresh-api-reader.js', 'reanalyze-selected.js', 'official-conference-acquire.js', 'conference-queue.js',
        'daily-scoring-refresh-checkpoint-cli.js', 'compact-papers-ledger.js', 'publish-daily-podcast.js',
        'calibrate-batch-scores.js', 'conference-workspace.js', 'migrate-conference-process.js',
        'conference-complete-stage-worker.js', 'conference-publication-figure-crop-replay-cli.js',
        'recover-conference-process-locks.js', 'prepare-daily-fetch-witness-recovery.js',
        'waive-analysis-failures.js', 'waive-post-publish-visuals.js'
    ],
    historyExact: ['page-source-crosswalk.js', 'arxiv-source-authority.js', 'activate-fresh-publication.js'],
    historyPrefixes: ['conference-', 'historical-', 'history-']
});
const WORKSPACE_ROLE_CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'workspace-roles.json');
const WORKSPACE_ROLE_JS_COMMANDS = fs.existsSync(WORKSPACE_ROLE_CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(WORKSPACE_ROLE_CONFIG_PATH, 'utf8')).commands.js
    : DEFAULT_JS_WORKSPACE_ROLE_COMMANDS;
const JS_NEW_CONFERENCE_DAILY_COMMANDS = new Set(WORKSPACE_ROLE_JS_COMMANDS.newConferenceDaily);
const JS_DAILY_COMMANDS = new Set(WORKSPACE_ROLE_JS_COMMANDS.daily);
const JS_HISTORY_EXACT_COMMANDS = new Set(WORKSPACE_ROLE_JS_COMMANDS.historyExact);
const JS_HISTORY_PREFIXES = Object.freeze([...WORKSPACE_ROLE_JS_COMMANDS.historyPrefixes]);

function requiredWorkspaceRoleForCommand(commandName) {
    const name = path.basename(String(commandName || ''));
    const wrappedRole = String(process.env.AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE || '').trim();
    const newConferenceDaily = process.env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE === '1' && wrappedRole === 'daily'
        && JS_NEW_CONFERENCE_DAILY_COMMANDS.has(name);
    if (newConferenceDaily) return 'daily';
    if (JS_DAILY_COMMANDS.has(name)) return 'daily';
    if (JS_HISTORY_PREFIXES.some(prefix => name.startsWith(prefix))
        || JS_HISTORY_EXACT_COMMANDS.has(name)) return 'history';
    return null;
}

function resolveEnvFile(envFile) {
    if (envFile) return envFile;
    return DEFAULT_ENV_FILE;
}

function isProjectEnvKey(key) {
    return PROJECT_ENV_KEYS.has(key) || PROJECT_ENV_PREFIXES.some(prefix => key.startsWith(prefix));
}

function parseEnvContent(envContent) {
    const parsed = {};
    const firstDefinitionLines = new Map();
    String(envContent == null ? '' : envContent).split('\n').forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) return;

        const key = trimmed.substring(0, eq).trim();
        let val = trimmed.substring(eq + 1).trim();
        if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
            val = val.slice(1, -1);
        }
        if (key) {
            const lineNumber = index + 1;
            if (firstDefinitionLines.has(key)) {
                // 不要把这两个值写进诊断信息：重复的键尤其可能含有凭据。
                // 解析仍然有意保持后者覆盖前者，以兼容旧行为。
                console.warn(`[env-loader] 第 ${firstDefinitionLines.get(key)} 行和第 ${lineNumber} 行重复定义 ${key}；采用后一项的值`);
            } else {
                firstDefinitionLines.set(key, lineNumber);
            }
            parsed[key] = val;
        }
    });
    return parsed;
}

function readEnvFileStrict(envFile, { enforcePermissions = false } = {}) {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    let fd;
    try {
        fd = fs.openSync(envFile, flags);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        if (error?.code === 'ELOOP') {
            throw new Error(`项目 .env 必须是无硬链接的普通文件，禁止符号链接: ${envFile}`);
        }
        throw error;
    }
    try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || (process.platform !== 'win32' && opened.nlink !== 1)) {
            throw new Error(`项目 .env 必须是无硬链接的普通文件，禁止符号链接: ${envFile}`);
        }
        if (enforcePermissions) {
            try {
                // 已经是 0600 时不再写元数据，保证只读监控（如 --watch）不产生写副作用。
                if (process.platform === 'win32') {
                    fs.chmodSync(envFile, 0o600);
                } else if ((opened.mode & 0o777) !== 0o600) {
                    fs.fchmodSync(fd, 0o600);
                }
            } catch (error) {
                if (process.platform !== 'win32') throw error;
            }
        }
        const MAX_ENV_BYTES = 2 * 1024 * 1024;
        if (opened.size > MAX_ENV_BYTES) {
            throw new Error(`项目 .env 超过大小限制 (${MAX_ENV_BYTES} bytes): ${envFile}`);
        }
        const chunks = [];
        let total = 0;
        const buf = Buffer.alloc(65536);
        while (total <= MAX_ENV_BYTES) {
            const toRead = Math.min(buf.length, MAX_ENV_BYTES + 1 - total);
            const n = fs.readSync(fd, buf, 0, toRead, null);
            if (n <= 0) break;
            chunks.push(Buffer.from(buf.subarray(0, n)));
            total += n;
        }
        if (total > MAX_ENV_BYTES) {
            throw new Error(`项目 .env 超过大小限制 (${MAX_ENV_BYTES} bytes): ${envFile}`);
        }
        return Buffer.concat(chunks, total).toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
}

function parseEnvFile(envFile) {
    envFile = resolveEnvFile(envFile);
    const envContent = readEnvFileStrict(envFile, { enforcePermissions: true });
    if (envContent === null) return {};
    return parseEnvContent(envContent);
}

function buildChildProcessEnv(extra = {}, allowedKeys = []) {
    const env = {};
    for (const key of [...CHILD_ENV_PASSTHROUGH_KEYS, ...allowedKeys]) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return { ...env, ...extra };
}

function loadProjectEnv(envFile) {
    const processInputs = {};
    for (const key of PROCESS_INPUT_KEYS) {
        if (process.env[key] !== undefined) processInputs[key] = process.env[key];
    }
    const parsed = parseEnvFile(envFile);

    for (const key of Object.keys(process.env)) {
        if (isProjectEnvKey(key)) {
            delete process.env[key];
        }
    }

    for (const [key, val] of Object.entries(parsed)) {
        process.env[key] = val;
    }
    for (const [key, val] of Object.entries(processInputs)) {
        process.env[key] = val;
    }

    return parsed;
}

// 只在直接的共享命令或 Manual 命令入口点运行，导入时绝不运行。
if (isScriptsEntrypoint()) {
    requireExternalRuntime();
}

module.exports = {
    DEFAULT_ENV_FILE,
    PROJECT_ENV_PREFIXES,
    PROJECT_ENV_KEYS,
    CHILD_ENV_PASSTHROUGH_KEYS,
    VCS_CHILD_ENV_KEYS,
    TRANSPORT_ENV_KEYS,
    PROCESS_INPUT_KEYS,
    isScriptsEntrypoint,
    requiredWorkspaceRoleForCommand,
    requireExternalRuntime,
    resolveEnvFile,
    isProjectEnvKey,
    parseEnvContent,
    parseEnvFile,
    loadProjectEnv,
    buildChildProcessEnv
};
