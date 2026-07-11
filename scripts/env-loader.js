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

function isScriptsEntrypoint(scriptPath = process.argv[1]) {
    if (!scriptPath) return false;
    const resolved = path.resolve(scriptPath);
    const scriptsDir = path.resolve(__dirname);
    return resolved.startsWith(`${scriptsDir}${path.sep}`) && path.extname(resolved) === '.js';
}

function requireExternalRuntime(commandName = path.basename(process.argv[1] || 'script')) {
    const sandbox = String(process.env.CODEX_SANDBOX || '').trim();
    if (!sandbox) return;
    throw new Error(
        `${commandName} 必须在沙箱外运行（检测到 CODEX_SANDBOX=${sandbox}）。`
        + '项目脚本可能访问本机代理、LLM、外部站点、Hugo 或 Git；'
        + '请以沙箱外权限重新执行，禁止在沙箱内降级、跳过或伪造运行结果。'
    );
}

function resolveEnvFile(envFile) {
    if (envFile) return envFile;
    return DEFAULT_ENV_FILE;
}

function isProjectEnvKey(key) {
    return PROJECT_ENV_KEYS.has(key) || PROJECT_ENV_PREFIXES.some(prefix => key.startsWith(prefix));
}

function parseEnvFile(envFile) {
    envFile = resolveEnvFile(envFile);
    const parsed = {};
    if (!fs.existsSync(envFile)) return parsed;

    try {
        fs.chmodSync(envFile, 0o600);
    } catch (error) {
        if (process.platform !== 'win32') throw error;
    }

    const envContent = fs.readFileSync(envFile, 'utf8');
    envContent.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) return;

        const key = trimmed.substring(0, eq).trim();
        let val = trimmed.substring(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (key) {
            parsed[key] = val;
        }
    });

    return parsed;
}

function buildChildProcessEnv(extra = {}, allowedKeys = []) {
    const env = {};
    for (const key of [...CHILD_ENV_PASSTHROUGH_KEYS, ...allowedKeys]) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return { ...env, ...extra };
}

function loadProjectEnv(envFile) {
    const parsed = parseEnvFile(envFile);

    for (const key of Object.keys(process.env)) {
        if (isProjectEnvKey(key)) {
            delete process.env[key];
        }
    }

    for (const [key, val] of Object.entries(parsed)) {
        process.env[key] = val;
    }

    return parsed;
}

// Run only for a direct scripts/*.js entrypoint, never when tests import modules.
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
    isScriptsEntrypoint,
    requireExternalRuntime,
    resolveEnvFile,
    isProjectEnvKey,
    parseEnvFile,
    loadProjectEnv,
    buildChildProcessEnv
};
