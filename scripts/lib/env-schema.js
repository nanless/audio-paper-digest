'use strict';
// .env 的集中 schema：供 config:check 与 doctor 共用，避免两边各写一套必填/范围判断。
// 只描述配置，不读取文件、不写文件、不打印密钥值。

// 允许的论文模型：muse-spark 与 deepseek-v4.1-flash 都按 OpenAI Responses 调用，
// 推理强度档位不同（前者 minimal…xhigh，后者 low/high/max）。新增模型时在这里登记。
const SUPPORTED_MODELS = Object.freeze([
    'muse-spark-1.3-contributor',
    'deepseek-v4.1-flash'
]);
const EXPECTED_MODEL = SUPPORTED_MODELS[0];

const SECRET_NAMES = new Set([
    'PAPER_ANALYZER_API_KEY', 'PAPER_ANALYZER_FALLBACK_API_KEYS',
    'PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY', 'PAPER_ANALYZER_SECONDARY_API_KEY',
    'PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS', 'PAPER_ANALYZER_SECONDARY_TERTIARY_FALLBACK_API_KEY',
    'PD_INDEXTTS_API_KEY',
    'KIMI_API_KEY', 'MIMO_API_KEY', 'DEEPSEEK_API_KEY',
    'FEISHU_APP_SECRET', 'WECHAT_APP_SECRET', 'XIAOHONGSHU_COOKIES'
]);

function secret(name) {
    return SECRET_NAMES.has(name) || /(?:^|_)(?:API_KEY|API_KEYS|KEYS?|TOKEN|SECRET|PASSWORD|COOKIES)$/.test(name);
}

// type: string | url | proxy | int | float | bool | csv | path | model
const SCHEMA = Object.freeze([
    { name: 'PAPER_ANALYZER_API_KEY', required: true, type: 'string', secret: true, hint: '在 .env 填写主账号 key；同池所有 key 等权' },
    { name: 'PAPER_ANALYZER_MODEL', required: true, type: 'model', hint: `可选：${SUPPORTED_MODELS.join(' / ')}` },
    { name: 'PAPER_ANALYZER_ENDPOINT', required: true, type: 'url', hint: 'Muse 端点，例如 https://opencode.ai/zen/go/v1' },
    { name: 'PAPER_ANALYZER_FALLBACK_API_KEYS', required: false, type: 'csv', secret: true, hint: '同池更多 key，逗号分隔，顺序不代表优先级' },
    { name: 'PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY', required: false, type: 'csv', secret: true, hint: '同池更多 key（与 fallback 列表合并）' },
    { name: 'PAPER_ANALYZER_SECONDARY_MODEL', required: false, type: 'model', hint: `未设置型号时不启用副模型；可选：${SUPPORTED_MODELS.join(' / ')}` },
    { name: 'PAPER_ANALYZER_SECONDARY_ENDPOINT', required: false, type: 'url' },
    { name: 'PAPER_ANALYZER_SECONDARY_API_KEY', required: false, type: 'string', secret: true },
    { name: 'PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS', required: false, type: 'csv', secret: true },
    { name: 'PAPER_ANALYZER_SECONDARY_TERTIARY_FALLBACK_API_KEY', required: false, type: 'csv', secret: true },
    { name: 'HTTPS_PROXY', required: false, type: 'proxy', hint: 'Muse/arXiv 必须走项目 HTTP CONNECT 代理' },
    { name: 'HTTP_PROXY', required: false, type: 'proxy' },
    { name: 'https_proxy', required: false, type: 'proxy' },
    { name: 'http_proxy', required: false, type: 'proxy' },
    { name: 'ALL_PROXY', required: false, type: 'string', hint: '可选的 SOCKS 代理（HuggingFace curl 使用）' },
    { name: 'NO_PROXY', required: false, type: 'string' },
    { name: 'PAPER_DIGEST_BLOG_REPO', required: false, type: 'path', hint: '真实 Hugo 仓库根目录' },
    { name: 'PAPER_DIGEST_BLOG_URL', required: false, type: 'url', hint: '站点 posts 根地址（verify:web 拼页面 URL）' },
    { name: 'PAPER_DIGEST_BLOG_REPO_RUN', required: false, type: 'string', hint: 'Pages 部署 workflow 所属仓库 owner/repo（可选）' },
    { name: 'PAPER_DIGEST_BLOG_BASE_PATH', required: false, type: 'string', hint: '站点子路径（可选）' },
    { name: 'PAPER_DIGEST_ICLR_2026_ACCEPTED_ROOT', required: false, type: 'path', hint: '历史 ICLR 2026 官方本地抓取根目录（可选）' },
    { name: 'PAPER_DIGEST_IMAGE_REPO', required: false, type: 'path', hint: '会议图片仓库本地路径（可选）' },
    { name: 'PAPER_DIGEST_GITHUB_REMOTE', required: false, type: 'string' },
    { name: 'PAPER_DIGEST_IMAGE_BASE_URL', required: false, type: 'string' },
    { name: 'PAPER_DIGEST_IMAGE_HOST', required: false, type: 'string' },
    // 已退役/废弃配置：保留登记以兼容本机既有 .env 与静默脱敏，不在新配置中使用。
    { name: 'PAPER_DIGEST_REPO_URL', required: false, type: 'string', deprecated: true, hint: '已废弃：运行时不再读取' },
    { name: 'PAPER_DIGEST_AUTHOR', required: false, type: 'string', deprecated: true, hint: '已废弃：运行时不再读取' },
    { name: 'FEISHU_APP_ID', required: false, type: 'string', deprecated: true, hint: '已退役：飞书发布通道已移除' },
    { name: 'FEISHU_APP_SECRET', required: false, type: 'string', secret: true, deprecated: true, hint: '已退役：飞书发布通道已移除' },
    { name: 'WECHAT_APP_ID', required: false, type: 'string', deprecated: true, hint: '已退役：微信发布通道已移除' },
    { name: 'WECHAT_APP_SECRET', required: false, type: 'string', secret: true, deprecated: true, hint: '已退役：微信发布通道已移除' },
    { name: 'WECHAT_THUMB_MEDIA_ID', required: false, type: 'string', deprecated: true, hint: '已退役：微信发布通道已移除' },
    { name: 'XIAOHONGSHU_COOKIES', required: false, type: 'string', secret: true, deprecated: true, hint: '已退役：小红书发布通道已移除' },
    // 播客生成与 GitHub Release 发布（可选 CLI：npm run podcast:generate）
    { name: 'PD_PODCAST_GITHUB_REPO', required: false, type: 'string', hint: '播客 GitHub Release 宿主仓库 owner/repo（可选）' },
    { name: 'PD_PODCAST_RELEASE_TAG_PREFIX', required: false, type: 'string', hint: '播客 Release tag 前缀（默认 podcast-）' },
    { name: 'PD_PODCAST_RELEASE_TAG_GROUPING', required: false, type: 'string', allowed: ['month', 'day', 'single'], hint: '播客 Release tag 分组模式：month / day / single' },
    { name: 'PD_INDEXTTS_MODEL_DIR', required: false, type: 'path', hint: 'IndexTTS2 本地模型目录（本地合成模式）' },
    { name: 'PD_INDEXTTS_CFG_PATH', required: false, type: 'path', hint: 'IndexTTS2 配置文件 config.yaml 路径' },
    { name: 'PD_INDEXTTS_VOICE_PROMPT', required: false, type: 'path', hint: '主讲人参考音频 WAV 路径' },
    { name: 'PD_INDEXTTS_COHOST_VOICE_PROMPT', required: false, type: 'path', hint: '对谈搭档参考音频 WAV 路径（可选）' },
    { name: 'PD_INDEXTTS_ENDPOINT', required: false, type: 'url', hint: 'IndexTTS2 远端/本地 HTTP 合成端点（HTTP 模式）' },
    { name: 'PD_INDEXTTS_API_KEY', required: false, type: 'string', secret: true, hint: 'IndexTTS2 HTTP 端点密钥（可选）' },
    { name: 'PD_INDEXTTS_MODEL', required: false, type: 'string', hint: 'IndexTTS2 HTTP 端点模型名（可选）' },
    { name: 'PD_INDEXTTS_ALLOW_LOCAL_ENDPOINT', required: false, type: 'bool', allowed: ['1','0','true','false','yes','no','on','off'], hint: '设为 1 允许 IndexTTS2 访问本机 loopback 端点' },
    // 抓取、筛选、深度分析与并发预算
    { name: 'PD_ANALYSIS_CONCURRENCY', required: false, type: 'int', min: 1 },
    { name: 'PD_REANALYZE_CONCURRENCY', required: false, type: 'int', min: 1 },
    { name: 'PD_API_READER_CONCURRENCY', required: false, type: 'int', min: 1, max: 60 },
    { name: 'PD_FILTER_BATCH_SIZE', required: false, type: 'int', min: 1 },
    { name: 'PD_FILTER_SCOPE_CONCURRENCY', required: false, type: 'int', min: 1, max: 8 },
    { name: 'PD_KEYWORD_PREFILTER_ENABLED', required: false, type: 'bool', allowed: ['1','0','true','false','yes','no','on','off'] },
    { name: 'PD_BLOG_REVIEW_CONCURRENCY', required: false, type: 'int', min: 1, max: 32 },
    { name: 'PD_CONFERENCE_ONLINE_VERIFY_CONCURRENCY', required: false, type: 'int', min: 1, max: 16 },
    { name: 'PD_HISTORY_REVIEW_CONCURRENCY', required: false, type: 'int', min: 1, max: 16 },
    { name: 'PD_ANALYSIS_BATCH_MAX_ROUNDS', required: false, type: 'int', min: 1, max: 10 },
    { name: 'PD_DAILY_CORRECTION_LIMIT', required: false, type: 'int', min: 1, max: 15, hint: '用户明确授权的日更人工修正名额，只允许抬高到硬上限 15；默认按入选数 10% 计算' },
    { name: 'PD_ANALYSIS_MAX_RETRIES', required: false, type: 'int', min: 0, max: 9 },
    { name: 'PD_ANALYSIS_MANUAL_HANDOFF_MAX_ITEMS', required: false, type: 'int', min: 0, max: 5 },
    { name: 'PD_ANALYSIS_MANUAL_HANDOFF_MIN_ROUNDS', required: false, type: 'int', min: 3, max: 10 },
    { name: 'PD_ANALYSIS_MANUAL_HANDOFF_NO_PROGRESS_ROUNDS', required: false, type: 'int', min: 3, max: 10 },
    { name: 'PD_DAILY_SOURCE_SKIP_MAX', required: false, type: 'int', min: 0, max: 5 },
    { name: 'PD_ALLOW_EMPTY_DAILY', required: false, type: 'bool', hint: '仅用于 .env 写法；命令行请用 --allow-empty-daily，且用完应删除' },
    { name: 'PD_ANALYSIS_API_MAX_RETRIES', required: false, type: 'int', min: 1 },
    { name: 'PD_ANALYSIS_API_MAX_RESPONSE_BYTES', required: false, type: 'int', min: 1024 },
    { name: 'PD_ANALYSIS_API_MAX_TOKENS', required: false, type: 'int', min: 1 },
    { name: 'PD_ANALYSIS_REVISION_MAX_TOKENS', required: false, type: 'int', min: 1 },
    { name: 'PD_ANALYSIS_STRUCTURE_MAX_TOKENS', required: false, type: 'int', min: 1 },
    { name: 'PD_ANALYSIS_CORE_SUMMARY_REPAIR_MAX_TOKENS', required: false, type: 'int', min: 1 },
    { name: 'PD_ANALYSIS_REPAIR_MAX_TOKENS', required: false, type: 'int', min: 1 },
    { name: 'PD_API_READER_MAX_TOKENS', required: false, type: 'int', min: 1 },
    { name: 'PD_API_READER_REPAIR_MAX_TOKENS', required: false, type: 'int', min: 1 },
    { name: 'PD_ANALYSIS_FULL_TEXT_MAX_CHARS', required: false, type: 'int', min: 1 },
    { name: 'PD_OPENSOURCE_EVIDENCE_MAX_CHARS', required: false, type: 'int', min: 1 },
    { name: 'PD_REVISION_EVIDENCE_MAX_CHARS', required: false, type: 'int', min: 1 },
    { name: 'PD_SCORING_EVIDENCE_MAX_CHARS', required: false, type: 'int', min: 1 },
    { name: 'PD_REPAIR_EVIDENCE_MAX_CHARS', required: false, type: 'int', min: 1 },
    { name: 'PD_STRUCTURE_EVIDENCE_MAX_CHARS', required: false, type: 'int', min: 1 },
    { name: 'PD_API_READER_EVIDENCE_MAX_CHARS', required: false, type: 'int', min: 1 },
    { name: 'PD_API_READER_CONTEXT_MAX_CHARS', required: false, type: 'int', min: 1 },
    { name: 'PD_API_READER_OVERALL_TIMEOUT_MS', required: false, type: 'int', min: 1 },
    { name: 'PD_SCORING_AUDIT_TEMPERATURE', required: false, type: 'float', min: 0, max: 2 },
    { name: 'PD_IMAGE_PLAN_TEMPERATURE', required: false, type: 'float', min: 0, max: 2 },
    { name: 'PD_IMAGE_MAX_BYTES', required: false, type: 'int', min: 1 },
    { name: 'PD_IMAGE_INSERTION_MAX', required: false, type: 'int', min: 1 },
    { name: 'PD_IMAGE_MAX_BASE64_CHARS', required: false, type: 'int', min: 1 },
    { name: 'PD_IMAGE_TOTAL_BASE64_CHARS', required: false, type: 'int', min: 1 },
    { name: 'PD_ARXIV_MAX_RESULTS', required: false, type: 'int', min: 1 },
    { name: 'PD_ARXIV_MAX_CONCURRENCY', required: false, type: 'int', min: 1, max: 6, hint: 'arXiv 源站并发闸门上限，默认 3（防止 429/403 限流）' },
    { name: 'PD_ARXIV_FETCH_MAX_RETRIES', required: false, type: 'int', min: 1 },
    { name: 'PD_ARXIV_FETCH_RETRY_BASE_DELAY_MS', required: false, type: 'int', min: 0 },
    { name: 'PD_ARXIV_RATE_LIMIT_BASE_DELAY_MS', required: false, type: 'int', min: 0 },
    { name: 'PD_ARXIV_RATE_LIMIT_MAX_WAIT_MS', required: false, type: 'int', min: 0 },
    { name: 'PD_ARXIV_FETCH_MAX_WAIT_MS', required: false, type: 'int', min: 0 },
    { name: 'PD_ARXIV_HEALTHY_COOLDOWN_MS', required: false, type: 'int', min: 0 },
    { name: 'PD_ARXIV_TRANSIENT_COOLDOWN_MS', required: false, type: 'int', min: 0 },
    { name: 'PD_ARXIV_RATE_LIMIT_COOLDOWN_MS', required: false, type: 'int', min: 0 },
    { name: 'PD_ARXIV_COOLDOWN_JITTER_MS', required: false, type: 'int', min: 0 },
    { name: 'PD_ARXIV_METADATA_TIMEOUT_MS', required: false, type: 'int', min: 1 },
    { name: 'PD_ARXIV_METADATA_MAX_BYTES', required: false, type: 'int', min: 1 },
    { name: 'PD_ARXIV_FETCH_TIMEOUT_MS', required: false, type: 'int', min: 1 },
    { name: 'PD_ARXIV_PDF_TIMEOUT_MS', required: false, type: 'int', min: 1 },
    { name: 'PD_ARXIV_PDF_MAX_BYTES', required: false, type: 'int', min: 1 },
    { name: 'PD_ARXIV_USER_AGENT', required: false, type: 'string' },
    { name: 'PD_BLOG_REVIEW_CHUNK_CHARS', required: false, type: 'int', min: 4000, max: 24000,
        hint: '单页审查分块字符数，默认 20000，上限 24000；增大可减少重复 prompt 并提升缓存复用' },
    { name: 'PD_BLOG_REVIEW_MAX_TOKENS', required: false, type: 'int', min: 1000, max: 32000,
        hint: '单页审查输出上限，默认 4000；推理型模型需更大预算' },
    { name: 'PD_FILTER_MAX_TOKENS', required: false, type: 'int', min: 1000, max: 64000,
        hint: '筛选单次响应预算；推理 token 与可见输出共用它，推理档高时需要抬高' },
    { name: 'PD_BLOG_REVIEW_TIMEOUT', required: false, type: 'int', min: 30, max: 600,
        hint: '单页审查读超时（秒），默认 120；不进审查协议指纹' },
    { name: 'PD_BLOG_IMAGE_REVIEW_DEADLINE_SECONDS', required: false, type: 'int', min: 10, max: 1800 },
    { name: 'PD_HUGO_GATE_TIMEOUT_SECONDS', required: false, type: 'int', min: 10, max: 1800 },
    { name: 'PD_GIT_LOCAL_TIMEOUT_SECONDS', required: false, type: 'int', min: 5, max: 600 },
    { name: 'PD_GIT_ARCHIVE_TIMEOUT_SECONDS', required: false, type: 'int', min: 10, max: 900 },
    { name: 'PD_GIT_COMMIT_TIMEOUT_SECONDS', required: false, type: 'int', min: 10, max: 1800 },
    { name: 'PD_GIT_NETWORK_TIMEOUT_SECONDS', required: false, type: 'int', min: 10, max: 1800 },
    { name: 'PD_IMAGE_DOWNLOAD_TIMEOUT_MS', required: false, type: 'int', min: 1,
        hint: '单张图片下载超时（毫秒），默认 60000；大图走代理常需更高' },
    { name: 'PD_OPENAI_RESPONSES_STREAM', required: false, type: 'bool', allowed: ['1','0','true','false','yes','no','on','off'] },
    { name: 'PD_OPENAI_RESPONSES_PROMPT_CACHE_KEY', required: false, type: 'bool', allowed: ['1','0','true','false','yes','no','on','off'],
        hint: '默认开启（1）按阶段注入稳定 prompt_cache_key 以提升前缀缓存命中；设为 0 可关闭' },
    { name: 'PD_TIERED_REASONING_EFFORT', required: false, type: 'bool', allowed: ['1','0','true','false','yes','no','on','off'],
        hint: '默认开启（1）按阶段分级推理强度（主分析与解读长文保持配置上限，审校/局部修复为 high，轻量机械阶段下调）；设为 0 恢复全阶段统一档位' },
    { name: 'PD_OPENCODE_SESSION_ID', required: false, type: 'string' },
    { name: 'PD_API_READER_THINKING_MODE', required: false, type: 'string', allowed: ['enabled', 'disabled', 'auto'] },
    { name: 'PD_ANALYSIS_REPAIR_THINKING_MODE', required: false, type: 'string', allowed: ['enabled', 'disabled', 'auto'] },
    { name: 'PD_ANALYSIS_PRIMARY_THINKING_MODE', required: false, type: 'string', allowed: ['enabled', 'disabled', 'auto'] },
    { name: 'PD_ANALYSIS_AUXILIARY_THINKING_MODE', required: false, type: 'string', allowed: ['enabled', 'disabled', 'auto'] },
    // Responses 推理强度；max/highest/maximum 视作 xhigh（网关支持的最高档）。
    // 取值按模型分表：muse-spark-* 最高 xhigh，deepseek-v4.1-flash 只有 low/high/max。
    // 这里登记并集；max/highest/maximum 是「最高档」的别名，运行时由 normalizeReasoningEffort
    // 按模型落到 xhigh 或 max，配置检查用同一规则归一化后再比对。
    { name: 'PD_OPENAI_RESPONSES_REASONING_EFFORT', required: false, type: 'string',
        allowed: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'highest', 'maximum'] },
    { name: 'PD_WORKSPACE_ALLOW_CROSS_ROLE', required: false, type: 'bool' },
    { name: 'PD_STORAGE_RETENTION_DAYS', required: false, type: 'int', min: 1, max: 3650 },
    { name: 'PD_LLM_USAGE_SHARD_BY_DATE', required: false, type: 'bool', allowed: ['1','0','true','false','yes','no','on','off'],
        hint: '设为 1 按北京时间 YYYY-MM-DD/ 子目录分片写入新用量事件（默认 0 保持平铺兼容全量历史回放）' },
    { name: 'PD_LOG_RETENTION_DAYS', required: false, type: 'int', min: 1, max: 3650 },
    { name: 'PD_LOG_MAX_TOTAL_BYTES', required: false, type: 'int', min: 1048576 },
    { name: 'PAPER_DIGEST_ENABLE_FILE_LOGS', required: false, type: 'bool', allowed: ['1','0','true','false','yes','no','on','off'] },
    { name: 'PD_ENABLE_FILE_LOGS', required: false, type: 'bool', allowed: ['1','0','true','false','yes','no','on','off'] },
    { name: 'PAPER_DIGEST_DISABLE_FILE_LOGS', required: false, type: 'bool', allowed: ['1','0','true','false','yes','no','on','off'] },
    { name: 'PD_DISABLE_FILE_LOGS', required: false, type: 'bool', allowed: ['1','0','true','false','yes','no','on','off'] },
    { name: 'PD_CHECKPOINT_TIMING', required: false, type: 'bool', allowed: ['1','0','true','false','yes','no','on','off'] },
    { name: 'PD_DISABLE_NODE_REPLAY_WORKER', required: false, type: 'bool', allowed: ['1','0','true','false','yes','no','on','off'] },
    { name: 'PD_PYTHON_RUNTIME_DISABLE_VENV', required: false, type: 'bool', allowed: ['1','0','true','false','yes','no','on','off'] },
    { name: 'PD_PUBLISH_RASTER_RECOVERY_FILE', required: false, type: 'path' }
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
    return require('./public-network-policy.js').isValidHttpConnectProxyUrl(value);
}

function validateValue(item, rawValue) {
    if (item.type === 'proxy') {
        const raw = rawValue == null ? '' : String(rawValue);
        if (!raw) {
            return item.required
                ? { ok: 'fail', detail: '缺失（必填）', hint: item.hint }
                : { ok: 'ok', detail: '未配置（可选）', hint: item.hint };
        }
        return isValidProxy(raw)
            ? { ok: 'ok', detail: 'HTTP CONNECT 代理地址合法' }
            : { ok: 'fail', detail: '不是合法 HTTP(S) 代理地址', hint: '例如 http://127.0.0.1:7897' };
    }
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
        if (!Number.isSafeInteger(number)) return { ok: 'fail', detail: '超出安全整数范围', hint: item.hint };
        if (item.min !== undefined && number < item.min) return { ok: 'fail', detail: `小于下限 ${item.min}：${number}`, hint: item.hint };
        if (item.max !== undefined && number > item.max) return { ok: 'fail', detail: `大于上限 ${item.max}：${number}`, hint: item.hint };
        return { ok: 'ok', detail: `整数 ${number}` };
    }
    case 'float': {
        if (!/^-?\d+(?:\.\d+)?$/.test(value)) return { ok: 'fail', detail: `不是合法数值：${value}`, hint: item.hint };
        const number = Number.parseFloat(value);
        if (!Number.isFinite(number)) return { ok: 'fail', detail: '不是有限数值', hint: item.hint };
        if (item.min !== undefined && number < item.min) return { ok: 'fail', detail: `小于下限 ${item.min}：${number}`, hint: item.hint };
        if (item.max !== undefined && number > item.max) return { ok: 'fail', detail: `大于上限 ${item.max}：${number}`, hint: item.hint };
        return { ok: 'ok', detail: `数值 ${number}` };
    }
    case 'bool': {
        const allowed = item.allowed || ['0', '1'];
        if (!allowed.includes(String(value).toLowerCase())) return { ok: 'fail', detail: `不是布尔值：${value}`, hint: `允许值：${allowed.join('/')}` };
        return { ok: 'ok', detail: `布尔值 ${value}` };
    }
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
    case 'model':
        return SUPPORTED_MODELS.includes(value)
            ? { ok: 'ok', detail: value }
            : { ok: 'fail', detail: `当前 ${value} 不在受支持的模型清单里`,
                hint: `可选：${SUPPORTED_MODELS.join(' / ')}` };
    case 'csv':
        return { ok: 'ok', detail: `逗号分隔 ${value.split(',').filter(Boolean).length} 项（值不显示）` };
    case 'path':
    case 'string':
    default:
        if (Array.isArray(item.allowed)) {
            // 字符串型白名单：写错的值不会报错而是被静默忽略，所以在配置检查里直接拦住。
            const seen = String(value).trim().toLowerCase();
            if (!item.allowed.includes(seen)) {
                return { ok: 'fail', detail: `不在允许值内：${value}`,
                    hint: `允许值：${item.allowed.join('/')}` };
            }
            return { ok: 'ok', detail: seen };
        }
        return { ok: 'ok', detail: '已配置（值不显示）' };
    }
}

function validateEntries(entries, options = {}) {
    const source = entries && typeof entries === 'object' ? entries : {};
    const items = SCHEMA.map(item => {
        const result = validateValue(item, source[item.name]);
        return {
            name: item.name,
            type: item.type,
            required: item.required,
            secret: secret(item.name),
            ...(item.deprecated ? { deprecated: true } : {}),
            ...result
        };
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
    if (!['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'].some(name => String(source[name] ?? '').trim())) {
        const item = items.find(entry => entry.name === 'HTTPS_PROXY');
        if (item && item.ok !== 'fail') { item.ok = 'fail'; item.detail = 'HTTPS_PROXY/HTTP_PROXY 都未配置'; item.hint = 'Muse 与 arXiv 必须走项目 HTTP CONNECT 代理'; }
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
    EXPECTED_MODEL, SUPPORTED_MODELS, SECRET_NAMES, SCHEMA, SCHEMA_BY_NAME, KNOWN_NAMES, SPELLING_PREFIX,
    parseEnvText, levenshtein, spellingCandidates, classifyUnknown,
    validateEntries, validateValue, summarize, secret
};
