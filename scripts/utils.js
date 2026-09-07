#!/usr/bin/env node
/**
 * Paper Digest 公共工具模块
 * 统一封装：文件操作、时间处理、数据解析、环境配置
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { loadProjectEnv } = require('./env-loader.js');
const {
    normalizeApiKeys,
    LlmAccountPoolExhaustedError,
    isOpenCodeGoEndpoint,
    classifyOpenCodeGoQuotaResponse,
    replaceCredentialHeaders,
    selectApiKey,
    markQuotaExhausted
} = require('./llm-account-pool.js');

// ═══════════════════════════════════════════════════════
// 文件操作
// ═══════════════════════════════════════════════════════

function writeFileAtomic(filePath, content) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    try {
        let previousMode;
        try {
            const stat = fs.lstatSync(filePath);
            if (stat.isFile()) previousMode = stat.mode & 0o777;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        // Runtime JSON can contain model responses, paper excerpts and recovery
        // metadata.  New files therefore default to private permissions; an
        // existing file keeps its exact prior mode for backwards-compatible
        // replacements.
        const targetMode = previousMode ?? 0o600;
        fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: targetMode });
        fs.chmodSync(tmpPath, targetMode);
        fs.renameSync(tmpPath, filePath);
    } catch (err) {
        if (fs.existsSync(tmpPath)) {
            fs.unlinkSync(tmpPath);
        }
        throw err;
    }
}

function readJsonSafe(filePath, defaultValue = null) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error(`[readJsonSafe] 读取失败 ${filePath}: ${err.message}`);
        }
        return defaultValue;
    }
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

// ═══════════════════════════════════════════════════════
// 北京时间处理（统一正确实现）
// ═══════════════════════════════════════════════════════

// 使用 Intl.DateTimeFormat 正确获取北京时间的各组成部分
function _getBeijingParts(d = new Date()) {
    const formatter = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        fractionalSecondDigits: 3
    });
    const parts = formatter.formatToParts(d);
    const get = (type) => parts.find(p => p.type === type)?.value;
    return {
        year: get('year'),
        month: get('month'),
        day: get('day'),
        hour: get('hour'),
        minute: get('minute'),
        second: get('second'),
        millisecond: get('fractionalSecond') || '000'
    };
}

function getBeijingISOString() {
    const p = _getBeijingParts();
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${p.millisecond}+08:00`;
}

function getBeijingDateString(daysAgo = 0) {
    const d = new Date();
    if (daysAgo > 0) {
        d.setDate(d.getDate() - daysAgo);
    }
    const p = _getBeijingParts(d);
    return `${p.year}-${p.month}-${p.day}`;
}

function getBeijingCompactTimestamp() {
    const p = _getBeijingParts();
    return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}

function getBeijingLocaleString() {
    return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function normalizeToBeijingISOString(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return isoString;
    const p = _getBeijingParts(date);
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${p.millisecond}+08:00`;
}

// ═══════════════════════════════════════════════════════
// 日期/归档辅助
// ═══════════════════════════════════════════════════════

function extractDatePrefix(value) {
    if (typeof value !== 'string') return null;
    const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}

function getRecordDate(data) {
    if (!data || typeof data !== 'object') return null;
    const keys = ['timestamp', 'lastUpdated', 'deepAnalysisCompletedAt', 'previousTimestamp'];
    for (const key of keys) {
        const date = extractDatePrefix(data[key]);
        if (date) return date;
    }
    return null;
}

// ═══════════════════════════════════════════════════════
// ID 规范化
// ═══════════════════════════════════════════════════════

function normalizedId(paperOrId) {
    if (paperOrId == null) return '';
    if (typeof paperOrId === 'string') {
        return paperOrId.replace(/v\d+$/, '').trim().toLowerCase();
    }
    const id = paperOrId.paper_id || paperOrId.arxivId || paperOrId.id || '';
    return id.replace(/v\d+$/, '').trim().toLowerCase();
}

// ═══════════════════════════════════════════════════════
// 环境变量加载
// ═══════════════════════════════════════════════════════

function loadEnvFile() {
    return loadProjectEnv();
}

// ═══════════════════════════════════════════════════════
// 分析文本解析（从 deep-analyzer.js 提取）
// ═══════════════════════════════════════════════════════

function stripMd(text) {
    if (!text) return '';
    let t = text;
    t = t.replace(/\*\*(.+?)\*\*/g, '$1');
    t = t.replace(/__(.+?)__/g, '$1');
    t = t.replace(/\*(.+?)\*/g, '$1');
    // 清理残留的不成对 ** 和 __
    t = t.replace(/\*\*/g, '');
    t = t.replace(/__/g, '');
    return t.trim();
}

const SCORING_RUBRIC_VERSION = 'type-aware-v1';
const DOCUMENT_TYPES = Object.freeze([
    '方法研究',
    '系统技术报告',
    '模型报告',
    '数据集与基准',
    '综述',
    '理论研究',
    '应用研究'
]);

function normalizeDocumentType(value) {
    const raw = stripMd(value || '').trim();
    if (!raw) return '';
    if (DOCUMENT_TYPES.includes(raw)) return raw;

    const normalized = raw.toLowerCase().replace(/[\s_-]+/g, '');
    const aliases = {
        '方法论文': '方法研究',
        '研究论文': '方法研究',
        'methodpaper': '方法研究',
        'methodresearch': '方法研究',
        '技术报告': '系统技术报告',
        '系统报告': '系统技术报告',
        '工业技术报告': '系统技术报告',
        '白皮书': '系统技术报告',
        'techreport': '系统技术报告',
        'technicalreport': '系统技术报告',
        'systemreport': '系统技术报告',
        'whitepaper': '系统技术报告',
        '工业模型报告': '模型报告',
        'modelreport': '模型报告',
        '数据集': '数据集与基准',
        '基准': '数据集与基准',
        '基准测试': '数据集与基准',
        'dataset': '数据集与基准',
        'benchmark': '数据集与基准',
        'datasetbenchmark': '数据集与基准',
        '综述论文': '综述',
        'survey': '综述',
        'review': '综述',
        '理论论文': '理论研究',
        'theory': '理论研究',
        'theoreticalresearch': '理论研究',
        '应用论文': '应用研究',
        'application': '应用研究',
        'appliedresearch': '应用研究'
    };
    return aliases[normalized] || '';
}

function parseMachineSummary(analysis) {
    const result = {
        documentType: '',
        rankBucket: '',
        innovation: '',
        technicalRigor: '',
        experimentalSufficiency: '',
        clarity: '',
        impact: '',
        openSource: '',
        reproducibility: '',
        engineeringScore: '',
        confidence: '',
        primaryTaskTag: '',
        primaryMethodTag: '',
        sotaClaim: '',
        hasCode: '',
        hasModel: '',
        hasDataset: ''
    };

    if (!analysis) return result;

    const blockMatch = analysis.match(/#{2,3}\s*机器摘要\s*\n([\s\S]*?)(?=#{2,3}\s*(?:评分规则|标签)|$)/);
    if (!blockMatch) return result;

    const keyMap = {
        document_type: 'documentType',
        rank_bucket: 'rankBucket',
        innovation: 'innovation',
        technical_rigor: 'technicalRigor',
        experimental_sufficiency: 'experimentalSufficiency',
        clarity: 'clarity',
        impact: 'impact',
        open_source: 'openSource',
        reproducibility: 'reproducibility',
        engineering_score: 'engineeringScore',
        confidence: 'confidence',
        primary_task_tag: 'primaryTaskTag',
        primary_method_tag: 'primaryMethodTag',
        sota_claim: 'sotaClaim',
        has_code: 'hasCode',
        has_model: 'hasModel',
        has_dataset: 'hasDataset'
    };

    // 扩展的 rank_bucket 映射表（处理各种非标准值）
    const rankMap = {
        // 数字
        '1': '前10%', '2': '前25%', '3': '前50%', '4': '后50%',
        // 中文标准
        '前10%': '前10%', '前25%': '前25%', '前50%': '前50%', '后50%': '后50%',
        // 字母映射（A=前10%, B=前25%, C=前50%, D=后50%）
        'a': '前10%', 'b': '前25%', 'c': '前50%', 'd': '后50%',
        'A': '前10%', 'B': '前25%', 'C': '前50%', 'D': '后50%',
        // 英文
        'top_10_percent': '前10%', 'top_25_percent': '前25%', 
        'top_50_percent': '前50%', 'bottom_50_percent': '后50%',
        'top 10%': '前10%', 'top 25%': '前25%', 
        'top 50%': '前50%', 'bottom 50%': '后50%',
        // 中文描述映射
        '高': '前10%', '很高': '前10%', '上': '前10%', '上上': '前10%',
        '中高': '前25%', '中上': '前25%', '较高': '前25%', '优秀': '前25%',
        '中': '前50%', '中等': '前50%', '中等偏下': '前50%', '中下': '前50%',
        '中低': '前50%', '一般': '前50%',
        '低': '后50%', '很低': '后50%', '下': '后50%', '差': '后50%',
        '较弱': '后50%', '偏低': '后50%'
    };

    for (const rawLine of blockMatch[1].split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        
        // 支持多种格式：
        // 1. key: value
        // 2. - key: value
        // 3. * **key**: value
        // 4. - **key**: value
        const m = line.match(/^(?:[-*]\s*)?(?:\*\*)?([a-z_]+)(?:\*\*)?\s*[：:]\s*(.+)$/i);
        if (!m) continue;
        
        const mappedKey = keyMap[m[1]];
            if (mappedKey) {
                let val = stripMd(m[2]).trim();

                if (mappedKey === 'documentType') {
                    val = normalizeDocumentType(val);
                }
            
            // 对于 rankBucket，使用扩展映射表
            if (mappedKey === 'rankBucket') {
                val = rankMap[val] || '';
            }
            
            // 对于分数类字段，提取数字部分
            if (['innovation', 'technicalRigor', 'experimentalSufficiency', 'clarity', 'impact', 'openSource', 'reproducibility', 'engineeringScore'].includes(mappedKey)) {
                // 处理 "3.5/5"、"3.5分"、"3.5 / 5" 等格式
                const numMatch = val.match(/^(\d+\.?\d*)/);
                if (numMatch) {
                    val = numMatch[1];
                }
            }
            
            // 对于 confidence，标准化
            if (mappedKey === 'confidence') {
                // 处理数字（0.9 → 高）
                const numMatch = val.match(/^(\d+\.?\d*)/);
                if (numMatch) {
                    const num = parseFloat(numMatch[1]);
                    if ((num <= 1 && num >= 0.8) || (num > 1 && num >= 4)) val = '高';
                    else if ((num <= 1 && num >= 0.5) || (num > 1 && num >= 3)) val = '中';
                    else val = '低';
                } else {
                    const confMap = {
                        '高': '高', 'high': '高', 'h': '高',
                        '中': '中', 'medium': '中', '中低': '中', '中等': '中', 'm': '中',
                        '低': '低', 'low': '低', '较低': '低', 'l': '低'
                    };
                    val = confMap[val.toLowerCase()] || val;
                }
            }
            
            // 对于 sota_claim，标准化
            if (mappedKey === 'sotaClaim') {
                const sotaMap = {
                    '是': '是', 'yes': '是', 'y': '是', '有': '是',
                    '否': '否', 'no': '否', 'n': '否', '无': '否',
                    '未说明': '未说明', 'unknown': '未说明', ' unclear': '未说明'
                };
                val = sotaMap[val.toLowerCase()] || val;
            }
            
            // 对于 has_code/has_model/has_dataset，标准化
            if (['hasCode', 'hasModel', 'hasDataset'].includes(mappedKey)) {
                // 先清理残留的 Markdown 加粗标记
                val = val.replace(/\*\*/g, '').trim();
                const yesNoMap = {
                    '是': '是', 'yes': '是', 'y': '是', '有': '是',
                    '否': '否', 'no': '否', 'n': '否', '无': '否',
                    '未说明': '未说明', 'unknown': '未说明'
                };
                val = yesNoMap[val.toLowerCase()] || val;
            }
            
            // 对于标签字段，确保有 # 前缀
            if (['primaryTaskTag', 'primaryMethodTag'].includes(mappedKey)) {
                if (val && !val.startsWith('#')) {
                    val = '#' + val;
                }
            }
            
            result[mappedKey] = val;
        }
    }

    return result;
}

// ═══════════════════════════════════════════════════════
// API 路由与协议适配（MiMo/Kimi Token Plan 伪装支持）
// ═══════════════════════════════════════════════════════

/**
 * 检测 API 协议类型：'openai'、'openai_responses' 或 'anthropic'
 * 
 * 规则：
 * 1. MiMo/Kimi Token Plan / Coding Plan → Anthropic（需伪装 Claude Code）
 * 2. 端点路径含 /anthropic 且非 DeepSeek → Anthropic
 * 3. DeepSeek 及其他 → OpenAI
 */
function detectApiType(endpoint, model) {
    const ep = (endpoint || '').replace(/\/+$/, '').toLowerCase();
    const m = (model || '').toLowerCase();

    // DeepSeek 强制 OpenAI 协议（优先级最高）
    if (ep.includes('deepseek.com') || m.includes('deepseek')) {
        return 'openai';
    }

    // OpenCode Go 上的 Muse Spark Contributor 只提供 OpenAI Responses API。
    // 同时允许用户直接配置完整 /responses 端点。
    if (ep.endsWith('/responses') || m.startsWith('muse-spark-')) {
        return 'openai_responses';
    }

    // Token Plan / Coding Plan 特征
    const isTokenPlan = ep.includes('token-plan') || ep.includes('coding');
    const isMimo = ep.includes('xiaomimimo.com') || m.includes('mimo');
    const isKimi = ep.includes('kimi.com') || m.includes('kimi');

    if ((isMimo || isKimi) && isTokenPlan) {
        return 'anthropic';
    }
    // 其他含 /anthropic 路径的端点 → Anthropic 协议
    if (ep.includes('/anthropic')) {
        return 'anthropic';
    }
    return 'openai';
}

/**
 * 将 OpenAI 端点转换为 Anthropic 端点
 * 例如：https://token-plan-cn.xiaomimimo.com/v1 → https://token-plan-cn.xiaomimimo.com/anthropic
 */
function getAnthropicEndpoint(openaiEndpoint) {
    return (openaiEndpoint || '').replace(/\/v1\/?$/, '/anthropic');
}

function isLoopbackHostname(hostname) {
    const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1') return true;
    const match = normalized.match(/^(\d{1,3})(?:\.(\d{1,3})){3}$/);
    if (!match) return false;
    const octets = normalized.split('.').map(Number);
    return octets.every(octet => octet >= 0 && octet <= 255) && octets[0] === 127;
}

/**
 * LLM 凭据只允许发送到 HTTPS；明文 HTTP 仅供 loopback 上的本地测试服务。
 */
function validateApiEndpointUrl(endpoint) {
    let url;
    try {
        url = new URL(endpoint);
    } catch {
        throw new Error('LLM endpoint 必须是完整的 HTTPS URL（本地测试可用 loopback HTTP）');
    }
    if (url.username || url.password) {
        throw new Error('LLM endpoint 禁止包含 URL userinfo 凭据');
    }
    if (url.protocol === 'https:') return url;
    if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return url;
    throw new Error(`LLM endpoint 禁止使用公网明文 ${url.protocol || '协议'}；请改用 HTTPS，本地 HTTP 仅允许 loopback 地址`);
}

/**
 * 构建 API URL
 * MiMo: /v1 → /anthropic/v1/messages
 * Kimi: /coding 或 /coding/v1 → /coding/v1/messages
 * 其他 Anthropic: {base}/messages
 * OpenAI Responses: 基础端点补 /responses，完整端点原样保留
 * OpenAI Chat: 端点路径含 /anthropic 时自动修正为 /v1/chat/completions
 */
function buildApiUrl(apiType, endpoint) {
    validateApiEndpointUrl(endpoint);
    const base = (endpoint || '').replace(/\/+$/, '');
    if (apiType === 'anthropic') {
        if (base.includes('xiaomimimo.com')) {
            // MiMo: 需要 /anthropic/v1/messages（必须含 /v1 中间路径）
            const anthropicBase = getAnthropicEndpoint(base);
            return `${anthropicBase}/v1/messages`;
        }
        if (base.includes('kimi.com')) {
            // Kimi Coding Plan 同时兼容用户配置的 /coding 与 /coding/v1。
            const kimiBase = base.replace(/\/coding(?:\/v1)?$/i, '/coding/v1');
            return `${kimiBase}/messages`;
        }
        // 其他 Anthropic 兼容端点
        return `${base}/messages`;
    }
    if (apiType === 'openai_responses') {
        return base.endsWith('/responses') ? base : `${base}/responses`;
    }
    // OpenAI: 标准化路径（如 /anthropic → /v1）
    const normalized = base.replace(/\/anthropic\/?$/, '/v1');
    return `${normalized}/chat/completions`;
}

/**
 * 构建请求体
 * OpenAI: {model, messages, max_tokens, temperature}
 * Anthropic: {model, messages, max_tokens, temperature?, system?} (system 是顶级字段)
 */
function normalizeAnthropicContent(content) {
    if (!Array.isArray(content)) return content;
    return content.map(block => {
        if (!block || typeof block !== 'object') return block;
        if (block.type !== 'image_url') return block;

        const imageUrl = block.image_url?.url || block.url || '';
        const dataMatch = imageUrl.match(/^data:([^;,]+);base64,(.+)$/);
        if (dataMatch) {
            return {
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: dataMatch[1],
                    data: dataMatch[2]
                }
            };
        }
        if (imageUrl) {
            return {
                type: 'image',
                source: {
                    type: 'url',
                    url: imageUrl
                }
            };
        }
        return block;
    });
}

function normalizeOpenAIContent(content) {
    if (!Array.isArray(content)) return content;
    if (content.length === 1) {
        const only = content[0];
        if (only && only.type === 'text' && typeof only.text === 'string') {
            return only.text;
        }
    }
    return content;
}

function normalizeResponsesContent(content) {
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }];
    return blocks.map(block => {
        if (!block || typeof block !== 'object') {
            return { type: 'input_text', text: String(block || '') };
        }
        if (block.type === 'text' || block.type === 'input_text') {
            return { type: 'input_text', text: String(block.text || '') };
        }
        if (block.type === 'image_url' || block.type === 'input_image') {
            const imageUrl = block.image_url?.url || block.image_url || block.url || '';
            return {
                type: 'input_image',
                image_url: imageUrl,
                ...(block.image_url?.detail || block.detail
                    ? { detail: block.image_url?.detail || block.detail }
                    : {})
            };
        }
        return block;
    });
}

function buildRequestBody(apiType, model, messages, maxTokens, temperature) {
    if (apiType === 'anthropic') {
        // Anthropic: system 必须是顶级字段，不能在 messages 中
        let system = undefined;
        const anthropicMessages = [];
        for (const msg of messages) {
            if (msg.role === 'system') {
                system = msg.content;
            } else {
                anthropicMessages.push({
                    ...msg,
                    content: normalizeAnthropicContent(msg.content)
                });
            }
        }
        const body = { model, max_tokens: maxTokens, messages: anthropicMessages };
        if (system) body.system = system;
        if (Number.isFinite(temperature)) body.temperature = temperature;
        return body;
    }
    if (apiType === 'openai_responses') {
        const body = {
            model,
            input: messages.map(msg => ({
                role: msg.role,
                content: normalizeResponsesContent(msg.content)
            })),
            max_output_tokens: maxTokens
        };
        if (Number.isFinite(temperature)) body.temperature = temperature;
        const reasoningEffort = String(
            process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT || ''
        ).trim().toLowerCase();
        if (['low', 'medium', 'high'].includes(reasoningEffort)) {
            body.reasoning = { effort: reasoningEffort };
        }
        if (['1', 'true', 'yes', 'on'].includes(String(
            process.env.PD_OPENAI_RESPONSES_STREAM || ''
        ).trim().toLowerCase())) {
            body.stream = true;
        }
        return body;
    }
    // OpenAI: 标准格式
    return {
        model,
        messages: messages.map(msg => ({
            ...msg,
            content: normalizeOpenAIContent(msg.content)
        })),
        max_tokens: maxTokens,
        temperature
    };
}

/**
 * 获取本地 Claude Code 版本号（用于伪装 User-Agent）
 * 通过 `claude --version` 动态获取，失败则回退到默认值
 */
function getClaudeCodeVersion() {
    try {
        const { execFileSync } = require('child_process');
        const { buildChildProcessEnv } = require('./env-loader.js');
        const output = execFileSync('claude', ['--version'], {
            encoding: 'utf8',
            timeout: 1000,
            stdio: ['ignore', 'pipe', 'ignore'],
            env: buildChildProcessEnv()
        }).trim();
        const match = output.match(/^(\d+\.\d+\.\d+)/);
        if (match) return match[1];
    } catch {
        // fall through
    }
    return '2.1.108';
}

/**
 * 构建请求头
 * Anthropic 需要：x-api-key, anthropic-version, User-Agent: claude-cli/<version> (external, cli)
 */
function buildHeaders(apiType, key, bodyStr) {
    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
    };
    if (apiType === 'anthropic') {
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
        headers['User-Agent'] = `claude-cli/${getClaudeCodeVersion()} (external, cli)`;
    } else {
        headers['Authorization'] = `Bearer ${key}`;
    }
    return headers;
}

/**
 * 解析响应，提取文本内容
 * OpenAI Responses: response.output_text 或 output[].content[].output_text
 * OpenAI Chat: response.choices[0].message.content
 * Anthropic: 合并所有 text content block
 */
function parseResponseText(apiType, response) {
    if (apiType === 'anthropic') {
        if (response.content && Array.isArray(response.content) && response.content.length > 0) {
            const textBlocks = response.content
                .filter(block => block && (block.type === 'text' || block.text))
                .map(block => block.text || '')
                .filter(Boolean);
            if (textBlocks.length > 0) {
                return textBlocks.join('\n');
            }
            const first = response.content[0];
            return first.text || first.thinking || '';
        }
    } else if (apiType === 'openai_responses') {
        if (typeof response.output_text === 'string' && response.output_text) {
            return response.output_text;
        }
        if (Array.isArray(response.output)) {
            const textBlocks = response.output.flatMap(item => (
                Array.isArray(item?.content) ? item.content : []
            )).filter(block => block?.type === 'output_text' || typeof block?.text === 'string')
                .map(block => block.text || '')
                .filter(Boolean);
            if (textBlocks.length > 0) return textBlocks.join('\n');
        }
    } else {
        if (response.choices && response.choices[0]) {
            const msg = response.choices[0].message;
            return msg.content || msg.reasoning_content || '';
        }
    }
    return null;
}

function getResponsesOutputTruncationError(response, maxOutputTokens) {
    if (response?.status !== 'incomplete'
        || response?.incomplete_details?.reason !== 'max_output_tokens') {
        return null;
    }
    const outputTokens = response?.usage?.output_tokens;
    const error = new Error(
        `OpenAI Responses 输出被 max_output_tokens=${maxOutputTokens} 截断`
        + `${Number.isFinite(outputTokens) ? `，已使用 ${outputTokens} tokens` : ''}`
    );
    error.code = 'MODEL_OUTPUT_TRUNCATED';
    error.outputTokens = Number.isFinite(outputTokens) ? outputTokens : null;
    error.maxOutputTokens = maxOutputTokens;
    return error;
}

function parseSseResponse(raw) {
    const deltas = [];
    let completed = null;
    let terminalFailure = null;
    for (const block of String(raw || '').split(/\r?\n\r?\n/)) {
        let eventName = '';
        const dataLines = [];
        for (const line of block.split(/\r?\n/)) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length === 0) continue;
        const dataText = dataLines.join('\n');
        if (!dataText || dataText === '[DONE]') continue;
        let event;
        try {
            event = JSON.parse(dataText);
        } catch {
            continue;
        }
        const type = event.type || eventName;
        if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
            deltas.push(event.delta);
        } else if (type === 'response.completed' && event.response && typeof event.response === 'object') {
            completed = event.response;
        } else if (type === 'response.incomplete' || type === 'response.failed') {
            terminalFailure = event.response || event;
        }
    }
    if (terminalFailure) return terminalFailure;
    if (completed) {
        if (!parseResponseText('openai_responses', completed) && deltas.length > 0) {
            completed.output_text = deltas.join('');
        }
        return completed;
    }
    if (deltas.length > 0) {
        const error = new Error('OpenAI Responses SSE 缺少 response.completed 终态事件');
        error.code = 'SSE_TERMINAL_EVENT_MISSING';
        throw error;
    }
    return null;
}

function requestJson(urlString, bodyObj, headers, options = {}) {
    const {
        timeoutMs = 60000,
        maxResponseBytes = 16 * 1024 * 1024,
        agent = false,
        method = 'POST'
    } = options;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error(`timeoutMs 必须是正整数，收到: ${timeoutMs}`);
    }
    if (!Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0) {
        throw new Error(`maxResponseBytes 必须是正整数，收到: ${maxResponseBytes}`);
    }
    const url = validateApiEndpointUrl(urlString);
    const transport = url.protocol === 'http:' ? http : https;
    const postData = JSON.stringify(bodyObj);
    const requestHeaders = {
        ...headers,
        'Content-Length': Buffer.byteLength(postData)
    };

    return new Promise((resolve, reject) => {
        let settled = false;
        let deadlineTimer = null;
        const finish = (handler, value) => {
            if (settled) return;
            settled = true;
            if (deadlineTimer) clearTimeout(deadlineTimer);
            handler(value);
        };
        const req = transport.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'http:' ? 80 : 443),
            path: url.pathname + url.search,
            method,
            headers: requestHeaders,
            timeout: timeoutMs,
            agent
        }, (res) => {
            const chunks = [];
            let responseBytes = 0;
            res.on('data', chunk => {
                responseBytes += chunk.length;
                if (responseBytes > maxResponseBytes) {
                    const error = new Error(`Response exceeds ${maxResponseBytes} byte limit`);
                    error.code = 'RESPONSE_TOO_LARGE';
                    res.destroy(error);
                    req.destroy(error);
                    finish(reject, error);
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => {
                if (settled) return;
                const raw = Buffer.concat(chunks).toString('utf8');
                try {
                    const json = JSON.parse(raw);
                    finish(resolve, { statusCode: res.statusCode, headers: res.headers, body: json, raw });
                } catch (err) {
                    let streamed;
                    try {
                        streamed = parseSseResponse(raw);
                    } catch (sseError) {
                        finish(reject, sseError);
                        return;
                    }
                    if (streamed) {
                        finish(resolve, {
                            statusCode: res.statusCode,
                            headers: res.headers,
                            body: streamed,
                            raw
                        });
                    } else {
                        finish(reject, new Error(`JSON/SSE parse error (HTTP ${res.statusCode}): ${err.message}; body=${raw.substring(0, 300)}`));
                    }
                }
            });
            res.on('error', error => finish(reject, error));
        });

        deadlineTimer = setTimeout(() => {
            const error = new Error(`Request deadline exceeded after ${timeoutMs}ms`);
            error.code = 'REQUEST_DEADLINE_EXCEEDED';
            req.destroy(error);
            finish(reject, error);
        }, timeoutMs);
        deadlineTimer.unref?.();

        req.on('error', error => finish(reject, error));
        req.on('timeout', () => {
            const error = new Error(`Request socket timeout after ${timeoutMs}ms`);
            error.code = 'REQUEST_SOCKET_TIMEOUT';
            req.destroy(error);
            finish(reject, error);
        });
        req.write(postData);
        req.end();
    });
}

function requiresLlmProxy(endpoint, model) {
    const m = String(model || '').toLowerCase();
    return m.startsWith('muse-spark-');
}

let openCodeSessionId = null;

function getOpenCodeSessionId() {
    if (openCodeSessionId) return openCodeSessionId;
    const configured = String(process.env.PD_OPENCODE_SESSION_ID || '').trim();
    openCodeSessionId = configured
        || `audio-paper-digest-${require('crypto').randomUUID()}`;
    return openCodeSessionId;
}

function buildOpenCodeRequestHeaders(endpoint, headers) {
    const result = { ...(headers || {}) };
    if (!isOpenCodeGoEndpoint(endpoint)) return result;
    const lowerNames = new Set(Object.keys(result).map(key => key.toLowerCase()));
    if (!lowerNames.has('user-agent')) result['User-Agent'] = 'audio-paper-digest/1.0';
    if (!lowerNames.has('x-opencode-session')) result['x-opencode-session'] = getOpenCodeSessionId();
    return result;
}

async function requestLlmOnce(apiUrl, endpoint, model, bodyObj, headers, options = {}) {
    let agent = false;
    if (requiresLlmProxy(endpoint, model)) {
        const proxyUrl = detectHttpConnectProxyUrl();
        if (!proxyUrl) {
            throw new Error(
                'OpenCode Go muse-spark-* 必须在项目 .env '
                + '配置 HTTPS_PROXY 或 HTTP_PROXY（HTTP CONNECT），禁止静默直连'
            );
        }
        const target = validateApiEndpointUrl(apiUrl);
        agent = createProxyAgent(
            proxyUrl,
            target.hostname,
            Number(target.port) || (target.protocol === 'https:' ? 443 : 80),
            target.hostname
        );
    }
    try {
        // Test-only transport seam. It deliberately lives below requestLlmJson's
        // canonical URL check and account selection/header replacement, so tests
        // can avoid the network without bypassing either security boundary.
        const transportRequestFn = typeof options.transportRequestFn === 'function'
            ? options.transportRequestFn : requestJson;
        const started = Date.now();
        let response;
        let failure;
        try {
            response = await transportRequestFn(apiUrl, bodyObj, headers, { ...options, agent });
            return response;
        } catch (error) {
            failure = error;
            throw error;
        } finally {
            // Never retain headers, credentials, prompts, response text or URLs
            // in the cost ledger. Diagnostic failures must not replay an API call.
            try {
                const protocol = detectApiType(endpoint, model);
                const { recordLlmUsage, buildLlmUsageEvent } = require('./lib/llm-usage.js');
                let outputText = null;
                try { outputText = response?.body ? parseResponseText(protocol, response.body) : null; }
                catch (_) { /* Malformed content must not lose request usage. */ }
                const input = { protocol, model, request: bodyObj, response: response?.body,
                    statusCode: response?.statusCode, durationMs: Date.now() - started,
                    errorCode: failure?.code || (failure ? 'NETWORK_ERROR' : null),
                    context: options.usageContext,
                    outputText };
                if (typeof options.usageSink === 'function') options.usageSink(buildLlmUsageEvent(input));
                else recordLlmUsage(input, { enabled: options.recordUsage !== false, directory: options.usageDirectory });
            } catch (_) {
                console.warn('[llm-usage] 本次请求用量不可记录；不改变请求结果');
            }
        }
    } finally {
        if (agent && typeof agent.destroy === 'function') agent.destroy();
    }
}

/**
 * LLM 默认保持 agent:false 直连；OpenCode Go Muse Spark Contributor
 * 因地区限制必须使用项目 .env 的 HTTP CONNECT 代理。
 * 每次请求创建并销毁独立 Agent，不影响 MiMo/Kimi 的直连语义。
 */
async function requestLlmJson(apiUrl, endpoint, model, bodyObj, headers, options = {}) {
    let expectedApiUrl;
    try {
        expectedApiUrl = buildApiUrl(detectApiType(endpoint, model), endpoint);
    } catch (error) {
        error.code = error.code || 'LLM_ACCOUNT_POOL_CONFIG_ERROR';
        error.retryable = false;
        throw error;
    }
    let actualApiUrl;
    try {
        actualApiUrl = validateApiEndpointUrl(String(apiUrl)).href;
    } catch (error) {
        error.code = 'LLM_ACCOUNT_POOL_CONFIG_ERROR';
        error.retryable = false;
        throw error;
    }
    if (actualApiUrl !== new URL(expectedApiUrl).href) {
        const error = new Error('LLM 请求 URL 与声明的 endpoint/model 路由不一致，已拒绝发送凭据');
        error.code = 'LLM_ACCOUNT_POOL_CONFIG_ERROR';
        error.retryable = false;
        throw error;
    }
    const configuredKeys = Array.isArray(options.apiKeys)
        ? options.apiKeys.map(value => String(value || '').trim()).filter(Boolean)
        : [];
    const apiKeys = normalizeApiKeys(configuredKeys);
    if (apiKeys.length !== configuredKeys.length) {
        const error = new Error('OpenCode Go 主账号与备用账号 API key 不能相同或重复');
        error.code = 'LLM_ACCOUNT_POOL_CONFIG_ERROR';
        error.retryable = false;
        throw error;
    }
    if (apiKeys.length > 1 && !isOpenCodeGoEndpoint(endpoint)) {
        const error = new Error('备用 API key 只允许用于 OpenCode Go 官方端点');
        error.code = 'LLM_ACCOUNT_POOL_CONFIG_ERROR';
        error.retryable = false;
        throw error;
    }

    const baseHeaders = buildOpenCodeRequestHeaders(endpoint, headers);
    if (apiKeys.length < 2) {
        return requestLlmOnce(apiUrl, endpoint, model, bodyObj, baseHeaders, options);
    }

    const stateFile = options.accountPoolStateFile
        || require('./config.js').FILES.llmAccountPoolState;
    const totalTimeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs : 60000;
    const startedAt = Date.now();
    const blockedUntilValues = [];
    const attemptedAccountIds = new Set();
    for (let accountAttempt = 0; accountAttempt < apiKeys.length; accountAttempt += 1) {
        const remainingMs = totalTimeoutMs - (Date.now() - startedAt);
        if (remainingMs <= 0) {
            const error = new Error(`Request deadline exceeded after ${totalTimeoutMs}ms`);
            error.code = 'REQUEST_DEADLINE_EXCEEDED';
            throw error;
        }
        const selection = selectApiKey(apiKeys, endpoint, stateFile, {
            excludeAccountIds: attemptedAccountIds
        });
        attemptedAccountIds.add(selection.accountId);
        const requestHeaders = replaceCredentialHeaders(baseHeaders, selection.apiKey);
        const response = await requestLlmOnce(
            apiUrl,
            endpoint,
            model,
            bodyObj,
            requestHeaders,
            { ...options, timeoutMs: remainingMs }
        );
        const quota = classifyOpenCodeGoQuotaResponse(response);
        if (!quota) return response;
        const blockedUntilMs = markQuotaExhausted(selection, quota, stateFile);
        blockedUntilValues.push(blockedUntilMs);
        const accountNumber = apiKeys.indexOf(selection.apiKey) + 1;
        console.warn(
            `[llm-account-pool] OpenCode Go 账号 ${accountNumber} 已确认额度耗尽`
            + ` (${quota.limitClass})，冷却至 ${new Date(blockedUntilMs).toISOString()}`
        );
    }
    const earliestRetryAtMs = blockedUntilValues.length > 0
        ? Math.min(...blockedUntilValues) : null;
    throw new LlmAccountPoolExhaustedError(
        `本次请求已尝试全部 OpenCode Go 账号；均明确返回额度耗尽`
        + `${earliestRetryAtMs ? `，最早恢复时间 ${new Date(earliestRetryAtMs).toISOString()}` : ''}`,
        { earliestRetryAtMs, blockedAccountCount: blockedUntilValues.length }
    );
}

// The raw registry is the sole tag authority.  These compatibility exports
// remain Sets for existing consumers, but are derived from active preferred
// Chinese labels rather than copied from a prompt table.
const TAXONOMY_RUNTIME = require('./lib/taxonomy-runtime.js').getDefaultTaxonomyRuntime();
const ALLOWED_TAGS = TAXONOMY_RUNTIME.allowedTags;
const PRIMARY_TASK_TAGS = TAXONOMY_RUNTIME.taskTags;
const PRIMARY_METHOD_TAGS = TAXONOMY_RUNTIME.methodTags;

const SCORE_DIMENSIONS = Object.freeze({
    innovationScore: Object.freeze({ label: '创新性', max: 2 }),
    technicalRigorScore: Object.freeze({ label: '技术严谨性', max: 1.5 }),
    experimentalSufficiencyScore: Object.freeze({ label: '实验充分性', max: 1.5 }),
    clarityScore: Object.freeze({ label: '清晰度', max: 1 }),
    impactScore: Object.freeze({ label: '影响力', max: 1.5 }),
    openSourceScore: Object.freeze({ label: '开源', max: 1.5 }),
    reproducibilityScore: Object.freeze({ label: '可复现性', max: 0.5 }),
    engineeringScore: Object.freeze({ label: '工程/实践价值', max: 1.5 })
});

const OPEN_SOURCE_SCORE_ANCHORS = Object.freeze([0, 0.2, 0.5, 1.0, 1.2, 1.5]);

function normalizeScoreToOneDecimal(value) {
    return Math.round((Number(value) + Number.EPSILON) * 10) / 10;
}

function isOpenSourceScoreAnchor(value) {
    const normalized = normalizeScoreToOneDecimal(value);
    return OPEN_SOURCE_SCORE_ANCHORS.some(anchor => Math.abs(anchor - normalized) < 1e-9);
}

function parseScoringDimensions(scoringText) {
    const occurrences = Object.fromEntries(Object.keys(SCORE_DIMENSIONS).map(field => [field, []]));
    const errors = [];

    for (const rawLine of String(scoringText || '').split('\n')) {
        const line = rawLine.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '').replace(/\*\*/g, '').trim();
        if (!line) continue;

        for (const [field, definition] of Object.entries(SCORE_DIMENSIONS)) {
            const labelPattern = escapeRegExp(definition.label);
            if (!new RegExp(`^${labelPattern}(?=\\s|[（(:：/])`).test(line)) continue;

            const rest = line.slice(definition.label.length).trim();
            const patterns = [
                /^[(（]\s*(-?\d+(?:\.\d)?)\s*\/\s*(-?\d+(?:\.\d)?)\s*[)）]/,
                /^[:：]\s*(-?\d+(?:\.\d)?)\s*\/\s*(-?\d+(?:\.\d)?)/,
                /^[(（]\s*(-?\d+(?:\.\d)?)\s*分\s*[)）]\s*[:：]\s*(-?\d+(?:\.\d)?)\s*\/\s*(-?\d+(?:\.\d)?)/,
                /^\/\s*(-?\d+(?:\.\d)?)\s*[:：]\s*(?:得分\s*)?(-?\d+(?:\.\d)?)/,
                /^[(（]\s*(-?\d+(?:\.\d)?)\s*分中的\s*(-?\d+(?:\.\d)?)\s*分\s*[)）]/,
                /^[(（]\s*\/\s*(-?\d+(?:\.\d)?)\s*[)）]\s*[:：]\s*(-?\d+(?:\.\d)?)(?:\s*\/\s*(-?\d+(?:\.\d)?))?/
            ];

            let score;
            let denominator;
            let declaredMaximum;
            let matchedFormat = false;
            let matchedToken = '';
            for (let index = 0; index < patterns.length; index++) {
                const match = rest.match(patterns[index]);
                if (!match) continue;
                matchedFormat = true;
                matchedToken = match[0];
                if (index <= 1) {
                    score = Number(match[1]);
                    denominator = Number(match[2]);
                } else if (index === 2) {
                    declaredMaximum = Number(match[1]);
                    score = Number(match[2]);
                    denominator = Number(match[3]);
                } else if (index === 3 || index === 4) {
                    denominator = Number(match[1]);
                    score = Number(match[2]);
                } else {
                    denominator = Number(match[1]);
                    score = Number(match[2]);
                    if (match[3] !== undefined) declaredMaximum = Number(match[3]);
                }
                break;
            }

            const reason = matchedToken
                ? rest.slice(matchedToken.length).replace(/^[\s:：—–-]+/, '').trim()
                : '';
            occurrences[field].push({ score, denominator, declaredMaximum, matchedFormat, reason });
            break;
        }
    }

    const scores = {};
    for (const [field, definition] of Object.entries(SCORE_DIMENSIONS)) {
        const found = occurrences[field];
        if (found.length === 0) {
            errors.push(`缺少评分维度“${definition.label}”`);
            continue;
        }
        if (found.length > 1) {
            errors.push(`评分维度“${definition.label}”重复出现 ${found.length} 次`);
            continue;
        }

        const item = found[0];
        if (!item.matchedFormat || !Number.isFinite(item.score) || !Number.isFinite(item.denominator)) {
            errors.push(`评分维度“${definition.label}”格式非法，必须写成 得分/${definition.max}`);
            continue;
        }
        if (item.denominator !== definition.max ||
            (item.declaredMaximum !== undefined && item.declaredMaximum !== definition.max)) {
            errors.push(`评分维度“${definition.label}”分母必须为 ${definition.max}`);
            continue;
        }
        if (item.score < 0 || item.score > definition.max) {
            errors.push(`评分维度“${definition.label}”得分 ${item.score} 超出 0-${definition.max}`);
            continue;
        }
        const meaningfulReasonChars = item.reason.match(/[A-Za-z0-9\u4e00-\u9fff]/g) || [];
        if (meaningfulReasonChars.length < 4) {
            errors.push(`评分维度“${definition.label}”缺少具体评分理由`);
            continue;
        }
        const normalizedScore = normalizeScoreToOneDecimal(item.score);
        if (field === 'openSourceScore' && !isOpenSourceScoreAnchor(normalizedScore)) {
            errors.push(`评分维度“${definition.label}”得分必须为 ${OPEN_SOURCE_SCORE_ANCHORS.map(value => value.toFixed(1)).join('/')}`);
            continue;
        }
        scores[field] = normalizedScore;
    }

    return { valid: errors.length === 0, scores, errors };
}

function parseAnalysis(analysis, options = {}) {
    if (!analysis) return null;
    const taxonomyRuntime = options.taxonomyRuntime || TAXONOMY_RUNTIME;
    const legacyTags = options.legacyTags === true;

    // 标准化标签：加 # 前缀，清理分隔符和多余空格
    function _normalizeTag(raw) {
        if (!raw) return '';
        let t = raw.trim();
        // 去除反引号
        t = t.replace(/^[\`\s]+|[\`\s]+$/g, '');
        // 如果有分号/逗号/顿号，只取第一部分
        t = t.split(/[,，;；、]/)[0].trim();
        // 如果还没有 # 前缀，加上
        if (t && !t.startsWith('#')) t = '#' + t;
        return t;
    }

    function _resolveAllowedTag(raw, facet) {
        if (!raw) return null;
        return legacyTags
            ? taxonomyRuntime.resolveLegacyTag(_normalizeTag(raw), facet)
            : taxonomyRuntime.resolveCurrentTag(String(raw).trim(), facet);
    }

    function _canonicalTag(raw, facet) {
        const concept = _resolveAllowedTag(raw, facet);
        return concept ? `#${concept.preferredLabel.zh}` : '';
    }

    function _isAllowedTag(tag) {
        return Boolean(_resolveAllowedTag(tag));
    }

    function _filterAllowedTags(tags) {
        if (!tags || !Array.isArray(tags)) return [];
        return tags.map(tag => _canonicalTag(tag)).filter(Boolean);
    }

    function _isBadTaskTag(tag) {
        if (!tag) return true;
        // snake_case
        if (/^#[a-z]+_[a-z]+/i.test(tag)) return true;
        // arXiv 类别
        if (/^#cs\.[A-Z]{2}$/i.test(tag)) return true;
        if (/^#eess\.[A-Z]{2}$/i.test(tag)) return true;
        // 过于宽泛或不合适的标签
        const badList = ['#theory', '#speech processing', '#system description', '#audio generation', '#系统描述'];
        if (badList.includes(tag.toLowerCase())) return true;
        // 过长且含空格的纯英文描述
        if (tag.length > 15 && tag.includes(' ') && !/[\u4e00-\u9fff]/.test(tag)) return true;
        // 包含冒号/论文类型等明显不是任务标签的内容
        if (tag.includes('论文类型') || tag.includes('类型:') || (tag.includes('类型') && tag.includes(':'))) return true;
        return false;
    }

    const result = {
        score: '', tags: [], authors: '', roast: '', summary: '',
        architecture: '', innovation: '', details: '', results: '',
        scoringReason: '', limitations: '', opensource: '',
        machineSummary: null,
        documentType: '',
        scoringRubricVersion: '',
        rankBucket: '',
        innovationScore: '',
        technicalRigorScore: '',
        experimentalSufficiencyScore: '',
        clarityScore: '',
        impactScore: '',
        openSourceScore: '',
        reproducibilityScore: '',
        engineeringScore: '',
        confidence: '',
        primaryTaskTag: '',
        primaryMethodTag: '',
        sotaClaim: '',
        hasCode: '',
        hasModel: '',
        hasDataset: '',
        scoreValidation: { valid: false, scores: {}, errors: ['缺少评分理由'] },
        taxonomyValidation: {
            valid: false, errors: ['缺少标签章节'],
            registryVersion: taxonomyRuntime.registryVersion,
            registrySha256: taxonomyRuntime.registrySha256,
            primaryTaskId: null, primaryMethodId: null, conceptIds: []
        }
    };

    let m;
    // 评分
    m = analysis.match(/##\s*评分\s*\n\s*(\d+\.?\d*)/);
    if (!m) m = analysis.match(/(?:评分|分数)[：:]\s*(\d+\.?\d*)/);
    if (!m) m = analysis.match(/\*\*(\d+\.?\d*)\s*\/\s*10\*\*/);
    if (!m) m = analysis.match(/(\d+\.?\d*)\s*\/\s*10/);
    if (m) result.score = m[1];

    // 标签（兼容带 # 前缀和不带 # 前缀的格式）
    // 先尝试从 ## 标签 部分提取"主任务标签"和"主方法标签"行
    const tagSectionMatch = analysis.match(/##\s*标签\s*\n([\s\S]*?)(?=\n##\s|\n【|$)/);
    let extractedTaskTag = '';
    let extractedMethodTag = '';
    if (tagSectionMatch) {
        const tagSection = tagSectionMatch[1];
        const taskLine = tagSection.match(/主任务标签\s*[：:]\s*(.+)/);
        if (taskLine) extractedTaskTag = taskLine[1].trim();
        const methodLine = tagSection.match(/主方法标签\s*[：:]\s*(.+)/);
        if (methodLine) extractedMethodTag = methodLine[1].trim();
    }

    let rawTagList = [];
    m = analysis.match(/##\s*标签\s*\n\s*([^\n]+)/);
    if (!m) m = analysis.match(/(?:标签|关键词)[：:]\s*([^\n]+)/);
    if (m) {
        const rawTags = m[1];
        // 先尝试匹配带 # 前缀的标签
        let tags = rawTags.match(/#\S+/g) || [];
        // 如果没有带 # 的标签，尝试按分隔符拆分并自动添加 # 前缀
        if (tags.length === 0 && legacyTags) {
            const parts = rawTags.split(/[,，;；、\s]+/).filter(p => p.trim());
            tags = parts.map(p => {
                const trimmed = p.trim().replace(/^[`\s]+|[`\s]+$/g, '');
                return trimmed ? '#' + trimmed : null;
            }).filter(Boolean);
        }
        rawTagList = tags;
        if (legacyTags) {
            const normalizedTask = _normalizeTag(extractedTaskTag);
            const normalizedMethod = _normalizeTag(extractedMethodTag);
            result.tags = tags.map(tag => {
                const normalized = _normalizeTag(tag);
                let concept = _resolveAllowedTag(tag);
                // A legacy alias may be globally ambiguous (for example
                // #端到端), but an exact echo of an explicit role line can be
                // resolved inside that role.  Supplemental tags remain
                // facet-free and therefore fail closed on ambiguity.
                if (!concept && normalized === normalizedTask) {
                    concept = _resolveAllowedTag(tag, 'task');
                }
                if (!concept && normalized === normalizedMethod) {
                    concept = _resolveAllowedTag(tag, 'method');
                }
                return concept ? `#${concept.preferredLabel.zh}` : '';
            }).filter(Boolean);
        } else {
            result.tags = _filterAllowedTags(tags);
        }
    }

    const machineSummary = parseMachineSummary(analysis);
    result.machineSummary = machineSummary;
    result.documentType = machineSummary.documentType;
    result.scoringRubricVersion = machineSummary.documentType ? SCORING_RUBRIC_VERSION : '';
    result.rankBucket = machineSummary.rankBucket;
    result.innovationScore = machineSummary.innovation;
    result.technicalRigorScore = machineSummary.technicalRigor;
    result.experimentalSufficiencyScore = machineSummary.experimentalSufficiency;
    result.clarityScore = machineSummary.clarity;
    result.impactScore = machineSummary.impact;
    result.openSourceScore = machineSummary.openSource;
    result.reproducibilityScore = machineSummary.reproducibility;
    result.engineeringScore = machineSummary.engineeringScore;
    result.confidence = machineSummary.confidence;

    // ═══════════════════════════════════════════════════════
    // 主任务/主方法标签解析（强制白名单验证）
    // ═══════════════════════════════════════════════════════

    function _isTaskTag(tag) {
        return Boolean(_resolveAllowedTag(tag, 'task'));
    }

    function _isMethodTag(tag) {
        return Boolean(_resolveAllowedTag(tag, 'method'));
    }

    // Role lines are authoritative.  Machine-summary echoes are checked by
    // the contract but never used to invent a missing task/method role.
    result.primaryTaskTag = _isTaskTag(extractedTaskTag)
        ? _canonicalTag(extractedTaskTag, 'task') : '';
    result.primaryMethodTag = _isMethodTag(extractedMethodTag)
        ? _canonicalTag(extractedMethodTag, 'method') : '';
    result.taxonomyValidation = taxonomyRuntime.validateTagSelection({
        tags: legacyTags ? result.tags : rawTagList,
        primaryTaskTag: legacyTags ? result.primaryTaskTag : extractedTaskTag,
        primaryMethodTag: legacyTags ? result.primaryMethodTag : extractedMethodTag
    });
    result.sotaClaim = machineSummary.sotaClaim;
    result.hasCode = machineSummary.hasCode;
    result.hasModel = machineSummary.hasModel;
    result.hasDataset = machineSummary.hasDataset;

    // 作者与机构（使用任意下一节 ## 作为终止，容忍 LLM 标题 typo）
    m = analysis.match(/##\s*作者与机构\s*\n([\s\S]*?)(?=\n##\s|$)/);
    if (m) result.authors = stripMd(m[1]);

    // 毒舌点评（使用任意下一节 ## 作为终止，容忍 LLM 标题 typo）
    m = analysis.match(/##\s*毒舌点评\s*\n([\s\S]*?)(?=\n##\s|$)/);
    if (m) result.roast = stripMd(m[1]);

    // 核心摘要
    m = analysis.match(/##\s*核心摘要\s*\n([\s\S]*?)(?=##\s*(?:详细分析|方法概述和架构)|$)/);
    if (m) result.summary = stripMd(m[1]);

    // 详细分析子部分（兼容两种格式：### 01.xxx 或 ## xxx）
    m = analysis.match(/#{2,3}\s*(?:\d+[.\s]+)?方法概述和架构[：:\s]*\n([\s\S]*?)(?=#{2,3}\s*(?:\d+[.\s]+)?(?:核心创新点|实验结果|细节详述|评分理由)|$)/);
    if (m) result.architecture = stripMd(m[1]);

    m = analysis.match(/#{2,3}\s*(?:\d+[.\s]+)?核心创新点[：:\s]*\n([\s\S]*?)(?=#{2,3}\s*(?:\d+[.\s]+)?(?:方法概述和架构|实验结果|细节详述|评分理由)|$)/);
    if (m) result.innovation = stripMd(m[1]);

    m = analysis.match(/#{2,3}\s*(?:\d+[.\s]+)?实验结果[：:\s]*\n([\s\S]*?)(?=#{2,3}\s*(?:\d+[.\s]+)?(?:方法概述和架构|核心创新点|细节详述|评分理由)|$)/);
    if (m) result.results = stripMd(m[1]);

    m = analysis.match(/#{2,3}\s*(?:\d+[.\s]+)?细节详述[：:\s]*\n([\s\S]*?)(?=#{2,3}\s*(?:\d+[.\s]+)?(?:方法概述和架构|核心创新点|实验结果|评分理由)|$)/);
    if (m) result.details = stripMd(m[1]);

    m = analysis.match(/#{2,3}\s*(?:\d+[.\s]+)?评分理由.*?\n([\s\S]*?)(?=#{2,3}\s*(?:\d+[.\s]+)?(?:方法概述和架构|核心创新点|实验结果|细节详述)|##\s*(?:局限|开源)|$)/);
    if (m) {
        let sr = stripMd(m[1]);
        // 过滤掉 LLM 自己写的"总分"行，避免与代码计算的总分不一致造成困惑
        sr = sr.split('\n').filter(line => !/^\s*总分[：:]/.test(line)).join('\n');
        result.scoringReason = sr;
    }

    // 局限与问题
    m = analysis.match(/##\s*局限与问题\s*\n([\s\S]*?)(?=##\s*开源|$)/);
    if (m) result.limitations = stripMd(m[1]);

    // 开源详情
    m = analysis.match(/##\s*开源(?:详情)?[：:]*\s*([\s\S]*?)$/);
    if (m) result.opensource = stripMd(m[1]);

    // 只有八维评分完整、唯一且分母/范围合法时才覆盖 LLM 给出的总分。
    const scoringText = result.scoringReason || '';
    result.scoreValidation = parseScoringDimensions(scoringText);
    if (result.scoreValidation.valid) {
            const dimScores = result.scoreValidation.scores;
            let total = Object.values(dimScores).reduce((a, b) => a + normalizeScoreToOneDecimal(b), 0);
            total = Math.min(10.0, total);
            result.score = normalizeScoreToOneDecimal(total).toFixed(1);

            // 用评分理由的分项覆盖机器摘要字段，确保与总分一致
            for (const field of Object.keys(SCORE_DIMENSIONS)) {
                result[field] = normalizeScoreToOneDecimal(dimScores[field]).toFixed(1);
            }

            if (result.machineSummary) {
                result.machineSummary.innovation = result.innovationScore;
                result.machineSummary.technicalRigor = result.technicalRigorScore;
                result.machineSummary.experimentalSufficiency = result.experimentalSufficiencyScore;
                result.machineSummary.clarity = result.clarityScore;
                result.machineSummary.impact = result.impactScore;
                result.machineSummary.openSource = result.openSourceScore;
                result.machineSummary.reproducibility = result.reproducibilityScore;
                result.machineSummary.engineeringScore = result.engineeringScore;
            }
    }

    // 非理论论文的资源字段与高开源分矛盾时归零；理论论文的核心产物
    // 可以是正文/附录中的公开证明，三个资源字段不能完整表达其状态。
    const openScoreVal = parseFloat(result.openSourceScore || 0);
    const isTheoryPaper = result.documentType === '理论研究';
    const hasCodeYes = result.hasCode === '是' || result.hasCode === 'yes';
    const hasModelYes = result.hasModel === '是' || result.hasModel === 'yes';
    const hasDatasetYes = result.hasDataset === '是' || result.hasDataset === 'yes';
    if (result.scoreValidation.valid && !isTheoryPaper && openScoreVal >= 1.0
        && !hasCodeYes && !hasModelYes && !hasDatasetYes) {
        // 论文没有任何开源链接但得了高分，强制降低
        result.openSourceScore = '0.0';
        if (result.machineSummary) result.machineSummary.openSource = '0.0';
        // 必须从修正后的八个子项重新求和。不能从已封顶的总分直接减，
        // 否则原始子项和超过 10 时会丢失封顶前的分数。
        result.scoreValidation.scores.openSourceScore = 0.0;
        let total = Object.values(result.scoreValidation.scores)
            .reduce((sum, value) => sum + normalizeScoreToOneDecimal(value), 0);
        total = Math.min(10.0, Math.max(0, total));
        result.score = normalizeScoreToOneDecimal(total).toFixed(1);
    }

    // rankBucket 推断：始终基于最终 score 重新计算（覆盖 LLM 原始值）
    if (result.score) {
        const s = parseFloat(result.score);
        if (!isNaN(s)) {
            if (s >= 9.0) result.rankBucket = '前10%';
            else if (s >= 7.5) result.rankBucket = '前25%';
            else if (s >= 5.5) result.rankBucket = '前50%';
            else result.rankBucket = '后50%';
            // 同步 machineSummary
            if (result.machineSummary) {
                result.machineSummary.rankBucket = result.rankBucket;
            }
        }
    }

    return result;
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ═══════════════════════════════════════════════════════
// 代理检测与 HTTP CONNECT 代理（纯内置模块实现）
// ═══════════════════════════════════════════════════════

const PROXY_ENV_VARS = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'];
const HTTP_CONNECT_PROXY_ENV_VARS = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY'];
const proxyDispatcherCache = new Map();

/**
 * 检测当前项目 .env 明确配置的代理 URL。
 * env-loader 会先清除外层同名变量，因此这里不会继承 shell/IDE 代理。
 */
function detectProxyUrl() {
    for (const envVar of PROXY_ENV_VARS) {
        if (process.env[envVar]) {
            return process.env[envVar];
        }
    }

    return null;
}

/**
 * 仅返回 Node arXiv 抓取可使用的 HTTP(S) CONNECT 代理。
 * ALL_PROXY 可能是 SOCKS，仅供 curl 等原生支持 SOCKS 的调用使用。
 */
function detectHttpConnectProxyUrl() {
    for (const envVar of HTTP_CONNECT_PROXY_ENV_VARS) {
        const value = process.env[envVar];
        if (!value) continue;
        try {
            const protocol = new URL(value).protocol;
            if (protocol === 'http:' || protocol === 'https:') return value;
        } catch (_) {
            // 继续检查下一项；调用方会在没有兼容代理时前置失败。
        }
    }
    return null;
}

function buildProxyAuthorizationHeader(proxy) {
    const parsed = proxy instanceof URL ? proxy : new URL(proxy);
    if (!parsed.username && !parsed.password) return null;
    const username = decodeURIComponent(parsed.username);
    const password = decodeURIComponent(parsed.password);
    return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function normalizeTlsServername(value) {
    return String(value || '').trim().replace(/^\[|\]$/g, '');
}

/**
 * 创建 HTTP CONNECT 代理 Agent（纯 Node 内置模块，无需外部依赖）
 * @param {string} proxyUrl - 代理 URL，如 http://127.0.0.1:7897
 * @param {string} targetHost - CONNECT 目标主机名或已验证 IP
 * @param {number} targetPort - 目标端口（默认 443）
 * @param {string} tlsServername - TLS SNI/证书校验主机名（默认与 targetHost 相同）
 */
function createProxyAgent(proxyUrl, targetHost, targetPort = 443, tlsServername = targetHost) {
    const proxy = new URL(proxyUrl);
    if (!['http:', 'https:'].includes(proxy.protocol)) {
        throw new Error(`当前 Node arXiv 抓取只支持 HTTP CONNECT 代理，收到不兼容协议: ${proxy.protocol}`);
    }
    const proxyPort = parseInt(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
    const https = require('https');
    const net = require('net');
    const tls = require('tls');

    const agent = new https.Agent({ keepAlive: false });
    const pendingSockets = new Set();
    const destroyAgent = agent.destroy.bind(agent);
    agent.destroy = () => {
        for (const pendingSocket of pendingSockets) pendingSocket.destroy();
        pendingSockets.clear();
        destroyAgent();
    };
    // https.Agent 不会采用构造参数 options.createConnection；必须覆盖实例方法。
    agent.createConnection = (_opts, callback) => {
        let callbackCalled = false;
        let socket = null;
        let connectTimer = null;
        const done = (error, connectedSocket) => {
            if (callbackCalled) return;
            callbackCalled = true;
            if (connectTimer) clearTimeout(connectTimer);
            if (socket) pendingSockets.delete(socket);
            callback(error, connectedSocket);
        };
        connectTimer = setTimeout(() => {
            const error = new Error('Proxy CONNECT/TLS handshake timeout after 60000ms');
            error.code = 'PROXY_CONNECT_TIMEOUT';
            socket?.destroy(error);
            done(error);
        }, 60000);
        connectTimer.unref?.();
        socket = proxy.protocol === 'https:'
            ? tls.connect({ host: proxy.hostname, port: proxyPort, servername: proxy.hostname, rejectUnauthorized: true })
            : net.connect({ host: proxy.hostname, port: proxyPort });
        pendingSockets.add(socket);

        socket.once(proxy.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
            const proxyAuthorization = buildProxyAuthorizationHeader(proxy);
            const authHeader = proxyAuthorization ? `Proxy-Authorization: ${proxyAuthorization}\r\n` : '';
            const connectHost = targetHost.includes(':') ? `[${targetHost}]` : targetHost;
            const connectAuthority = `${connectHost}:${targetPort}`;
            const connectReq = `CONNECT ${connectAuthority} HTTP/1.1\r\nHost: ${connectAuthority}\r\n${authHeader}Connection: close\r\n\r\n`;
            socket.write(connectReq);

            let buffer = '';
            const onData = (chunk) => {
                buffer += chunk.toString('binary');
                const headerEnd = buffer.indexOf('\r\n\r\n');
                if (headerEnd !== -1) {
                    socket.removeListener('data', onData);
                    const statusLine = buffer.slice(0, buffer.indexOf('\r\n'));
                    if (!/^HTTP\/1\.[01]\s+200(?:\s|$)/.test(statusLine)) {
                        socket.destroy();
                        done(new Error(`Proxy CONNECT failed: ${statusLine}`));
                        return;
                    }
                    const tlsSocket = tls.connect({
                        socket,
                        servername: normalizeTlsServername(tlsServername),
                        rejectUnauthorized: true
                    }, () => done(null, tlsSocket));
                    pendingSockets.delete(socket);
                    socket = tlsSocket;
                    pendingSockets.add(socket);
                    tlsSocket.once('error', done);
                }
            };
            socket.on('data', onData);
        });

        socket.once('error', done);
    };
    return agent;
}

/**
 * 创建仅用于非 LLM fetch 请求的 undici 代理 dispatcher。
 * 不设置全局 dispatcher，确保 LLM requestJson 继续使用 agent:false 直连。
 */
function createProxyDispatcher(proxyUrl) {
    if (!proxyUrl) throw new Error('缺少项目代理配置');
    if (proxyDispatcherCache.has(proxyUrl)) return proxyDispatcherCache.get(proxyUrl);
    const proxy = new URL(proxyUrl);
    if (!['http:', 'https:'].includes(proxy.protocol)) {
        throw new Error(`Node fetch 抓取只支持 HTTP(S) 代理；请通过 HTTPS_PROXY/HTTP_PROXY 配置 HTTP CONNECT 地址，收到: ${proxy.protocol}`);
    }
    const { ProxyAgent } = require('undici');
    const dispatcher = new ProxyAgent(proxyUrl);
    proxyDispatcherCache.set(proxyUrl, dispatcher);
    return dispatcher;
}

// ═══════════════════════════════════════════════════════
// papers.json 自动备份
// ═══════════════════════════════════════════════════════

/**
 * 备份 papers.json 到归档目录
 * @param {string} papersFilePath - papers.json 文件路径
 * @param {string} archiveDir - 归档目录路径
 * @returns {Object} { backedUp: boolean, backupPath?: string, message: string }
 */
function backupPapersJson(...args) {
    // 延迟 require 避免 utils <-> digest-status 初始化环；保留历史公共 API。
    return require('./digest-status.js').backupPapersJson(...args);
}

// ═══════════════════════════════════════════════════════
// 博客已发布论文扫描
// ═══════════════════════════════════════════════════════

/**
 * 从 Hugo 博客仓库中扫描已发布论文的 arXiv ID 集合
 * 博客文章中的 arXiv 链接格式：[arxiv](https://arxiv.org/abs/XXXX.XXXXX)
 * @param {string} blogRepo - 博客仓库根目录路径
 * @param {Object} options - 测试/诊断注入项
 * @returns {Set<string>} 已发布的规范化 arXiv ID 集合
 */
function loadPublishedIdsFromBlog(blogRepo, options = {}) {
    const publishedIds = new Set();
    if (!blogRepo) return publishedIds;
    const readFileSync = options.readFileSync || fs.readFileSync;
    const execFileSync = options.execFileSync || require('child_process').execFileSync;

    const postsDir = path.join(blogRepo, 'content', 'posts');
    if (!fs.existsSync(postsDir)) {
        console.log(`[blog-dedup] 博客目录不存在: ${postsDir}，跳过博客去重`);
        return publishedIds;
    }

    try {
        const arxivUrlRegex = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?/g;
        const collectIds = (content) => {
            let match;
            while ((match = arxivUrlRegex.exec(content)) !== null) {
                publishedIds.add(normalizedId(match[1]));
            }
            arxivUrlRegex.lastIndex = 0;
        };

        const gitMarker = path.join(blogRepo, '.git');
        if (fs.existsSync(gitMarker)) {
            // Generation installs pages into the blog worktree before review and
            // push.  Those bytes are not published yet and must not change the
            // fetch/filter fingerprint on a same-day retry.  Read the immutable
            // HEAD tree instead of the mutable worktree; this also ignores staged
            // but uncommitted pages and local edits to historical posts.
            let committedMatches = '';
            try {
                committedMatches = execFileSync('git', [
                    '-C', blogRepo,
                    'grep', '-I', '-h', '--no-color', '-E',
                    'arxiv\\.org/(abs|pdf)/[0-9]{4}\\.[0-9]{4,5}(v[0-9]+)?',
                    'HEAD', '--', ':(glob)content/posts/**/*.md'
                ], {
                    encoding: 'utf8',
                    maxBuffer: 64 * 1024 * 1024,
                    env: {
                        PATH: process.env.PATH || '/usr/bin:/bin',
                        LC_ALL: 'C'
                    }
                });
            } catch (error) {
                // git grep uses status 1 for a valid tree with no matches.
                if (error?.status !== 1) throw error;
                committedMatches = String(error.stdout || '');
            }
            collectIds(String(committedMatches || ''));
        } else {
            const files = [];
            const walk = (dir) => {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        walk(fullPath);
                    } else if (entry.isFile() && entry.name.endsWith('.md')) {
                        files.push(fullPath);
                    }
                }
            };
            walk(postsDir);
            for (const file of files) {
                collectIds(readFileSync(file, 'utf8'));
            }
        }

        console.log(`[blog-dedup] 从博客已提交基线扫描到 ${publishedIds.size} 篇已发布论文`);
    } catch (e) {
        const error = new Error(`[blog-dedup] 已存在的博客目录扫描失败，拒绝使用不完整去重基线: ${e.message}`);
        error.code = 'BLOG_DEDUP_SCAN_FAILED';
        error.cause = e;
        throw error;
    }

    return publishedIds;
}

// ═══════════════════════════════════════════════════════
// Prompt 加载（从 markdown 文件读取）
// ═══════════════════════════════════════════════════════

/**
 * 从 markdown 文件加载 prompt
 * 读取文件后，提取第一个 fenced code block 内的内容，并替换占位符
 * @param {string} mdPath - markdown 文件路径（相对项目根目录或绝对路径）
 * @param {Object} vars - 占位符替换映射，如 { title: '...', abstract: '...' }
 * @returns {string} 处理后的 prompt 文本
 */
function loadPrompt(mdPath, vars = {}) {
    const projectRoot = path.resolve(path.join(__dirname, '..'));
    // 统一解析到 projectRoot 下，防止路径遍历（拒绝绝对路径和 ../ 逃逸）
    const resolved = path.resolve(path.join(projectRoot, mdPath));
    if (!resolved.startsWith(projectRoot + path.sep)) {
        throw new Error(`Prompt 路径不安全，必须在项目目录内: ${mdPath}`);
    }
    const fullPath = resolved;

    if (!fs.existsSync(fullPath)) {
        throw new Error(`Prompt 文件不存在: ${fullPath}`);
    }

    const content = fs.readFileSync(fullPath, 'utf8');

    // 提取第一个 fenced code block 内的内容（兼容 CRLF 和更长 fence）
    const blockMatch = content.match(/^(`{3,}|~{3,})(?:text)?\r?\n([\s\S]*?)\r?\n\1/m);
    if (!blockMatch) {
        throw new Error(`Prompt 文件 ${mdPath} 中未找到 fenced code block`);
    }

    let prompt = blockMatch[2];

    // 替换占位符 {key} → value（对 key 做正则转义，防止注入；使用回调避免 $ 特殊含义）
    for (const [key, value] of Object.entries(vars)) {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const placeholder = new RegExp(`\\{${escapedKey}\\}`, 'g');
        prompt = prompt.replace(placeholder, () => String(value));
    }

    // 检测未替换的占位符并警告（只在原始模板中检测，避免将替换值中的 LaTeX 符号误判）
    // 排除单字母（如 {N}, {k}, {i} 等数学公式变量）
    const templateStr = blockMatch[2];
    const templateVars = [...templateStr.matchAll(/\{([a-zA-Z_]\w{1,})\}/g)].map(m => m[1]);
    const providedKeys = new Set(Object.keys(vars));
    const unboundKeys = [...new Set(templateVars)].filter(k => !providedKeys.has(k));
    if (unboundKeys.length > 0) {
        console.warn(`[loadPrompt] 警告: ${mdPath} 中存在未替换的占位符: ${unboundKeys.map(k => `{${k}}`).join(', ')}`);
    }

    return prompt;
}

module.exports = {
    writeFileAtomic,
    readJsonSafe,
    ensureDir,
    getBeijingISOString,
    getBeijingDateString,
    getBeijingCompactTimestamp,
    getBeijingLocaleString,
    normalizeToBeijingISOString,
    extractDatePrefix,
    getRecordDate,
    normalizedId,
    loadEnvFile,
    stripMd,
    parseMachineSummary,
    parseAnalysis,
    parseScoringDimensions,
    ALLOWED_TAGS,
    PRIMARY_TASK_TAGS,
    PRIMARY_METHOD_TAGS,
    SCORE_DIMENSIONS,
    OPEN_SOURCE_SCORE_ANCHORS,
    normalizeScoreToOneDecimal,
    isOpenSourceScoreAnchor,
    normalizeDocumentType,
    DOCUMENT_TYPES,
    SCORING_RUBRIC_VERSION,
    // API 路由
    detectApiType,
    getAnthropicEndpoint,
    validateApiEndpointUrl,
    buildApiUrl,
    buildRequestBody,
    buildHeaders,
    getClaudeCodeVersion,
    parseResponseText,
    getResponsesOutputTruncationError,
    parseSseResponse,
    requestJson,
    requiresLlmProxy,
    requestLlmJson,
    // 代理
    detectProxyUrl,
    detectHttpConnectProxyUrl,
    buildProxyAuthorizationHeader,
    normalizeTlsServername,
    createProxyAgent,
    createProxyDispatcher,
    // 备份
    backupPapersJson,
    // 博客去重
    loadPublishedIdsFromBlog,
    // Prompt
    loadPrompt
};
