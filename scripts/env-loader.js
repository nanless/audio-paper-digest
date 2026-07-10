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
    'KIMI_API_KEY'
]);

function resolveEnvFile(envFile) {
    if (envFile) return envFile;
    if (process.env.PAPER_DIGEST_TEST_ENV_FILE) {
        return process.env.PAPER_DIGEST_TEST_ENV_FILE;
    }
    return DEFAULT_ENV_FILE;
}

function isProjectEnvKey(key) {
    return PROJECT_ENV_KEYS.has(key) || PROJECT_ENV_PREFIXES.some(prefix => key.startsWith(prefix));
}

function parseEnvFile(envFile) {
    envFile = resolveEnvFile(envFile);
    const parsed = {};
    if (!fs.existsSync(envFile)) return parsed;

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

function loadProjectEnv(envFile) {
    const parsed = parseEnvFile(envFile);

    for (const key of Object.keys(process.env)) {
        if (key === 'PAPER_DIGEST_TEST_ENV_FILE') continue;
        if (isProjectEnvKey(key)) {
            delete process.env[key];
        }
    }

    for (const [key, val] of Object.entries(parsed)) {
        process.env[key] = val;
    }

    return parsed;
}

module.exports = {
    DEFAULT_ENV_FILE,
    PROJECT_ENV_PREFIXES,
    PROJECT_ENV_KEYS,
    resolveEnvFile,
    isProjectEnvKey,
    parseEnvFile,
    loadProjectEnv
};
