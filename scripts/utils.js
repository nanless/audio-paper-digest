#!/usr/bin/env node
/**
 * Paper Digest 公共工具模块
 * 统一封装：文件操作、时间处理、数据解析、环境配置
 */

const fs = require('fs');
const path = require('path');

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
        fs.writeFileSync(tmpPath, content, 'utf8');
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
    // 优先从项目根目录的 .env 加载
    const envFile = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envFile)) {
        const envContent = fs.readFileSync(envFile, 'utf8');
        envContent.split('\n').forEach(line => {
            const trimmed = line.trim();
            // 跳过空行和注释
            if (!trimmed || trimmed.startsWith('#')) return;
            const eq = trimmed.indexOf('=');
            if (eq > 0) {
                const key = trimmed.substring(0, eq).trim();
                let val = trimmed.substring(eq + 1).trim();
                // 去除首尾引号（单引号或双引号）
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                if (key) {
                    process.env[key] = val;
                }
            }
        });
    }
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
    return t.trim();
}

function parseMachineSummary(analysis) {
    const result = {
        rankBucket: '',
        qualityScore: '',
        valueScore: '',
        reproducibilityBonus: '',
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
        rank_bucket: 'rankBucket',
        quality_score: 'qualityScore',
        value_score: 'valueScore',
        reproducibility_bonus: 'reproducibilityBonus',
        confidence: 'confidence',
        primary_task_tag: 'primaryTaskTag',
        primary_method_tag: 'primaryMethodTag',
        sota_claim: 'sotaClaim',
        has_code: 'hasCode',
        has_model: 'hasModel',
        has_dataset: 'hasDataset'
    };

    for (const rawLine of blockMatch[1].split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        const m = line.match(/^([a-z_]+)\s*[：:]\s*(.+)$/i);
        if (!m) continue;
        const mappedKey = keyMap[m[1]];
        if (mappedKey) {
            let val = stripMd(m[2]);
            // 对于 rankBucket，只允许四个标准分档
            if (mappedKey === 'rankBucket' && !['前10%', '前25%', '前50%', '后50%'].includes(val)) {
                val = '';
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
 * 检测 API 协议类型：'openai' 或 'anthropic'
 * 
 * 规则：只有 MiMo/Kimi 的 Token Plan / Coding Plan 才使用 anthropic 接口
 * （需要伪装成 Claude Code，否则可能被封号）
 * 其他情况（包括 MiMo 按量付费的 OpenAI 接口）都用通用 openai 接口
 */
function detectApiType(endpoint, model) {
    const ep = (endpoint || '').toLowerCase();
    const m = (model || '').toLowerCase();

    // Token Plan / Coding Plan 特征
    const isTokenPlan = ep.includes('token-plan') || ep.includes('coding');
    const isMimo = ep.includes('xiaomimimo.com') || m.includes('mimo');
    const isKimi = ep.includes('kimi.com') || m.includes('kimi');

    if ((isMimo || isKimi) && isTokenPlan) {
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

/**
 * 构建 API URL
 * MiMo Token Plan: /v1/chat/completions → /anthropic/v1/messages
 * Kimi Coding Plan: /coding/v1/chat/completions → /coding/v1/messages（不需要 /anthropic 中间路径）
 */
function buildApiUrl(apiType, endpoint) {
    const base = (endpoint || '').replace(/\/+$/, '');
    if (apiType === 'anthropic') {
        if (base.includes('kimi.com')) {
            // Kimi Coding Plan: Anthropic 协议直接在 base URL 后加 /messages
            // 例如 https://api.kimi.com/coding/v1 → https://api.kimi.com/coding/v1/messages
            return `${base}/messages`;
        }
        // MiMo Token Plan: 替换 /v1 为 /anthropic，再加 /v1/messages
        const anthropicBase = getAnthropicEndpoint(base);
        return `${anthropicBase}/v1/messages`;
    }
    return `${base}/chat/completions`;
}

/**
 * 构建请求体
 * OpenAI: {model, messages, max_tokens, temperature}
 * Anthropic: {model, messages, max_tokens, system?} (system 是顶级字段)
 */
function buildRequestBody(apiType, model, messages, maxTokens, temperature) {
    if (apiType === 'anthropic') {
        // Anthropic: system 必须是顶级字段，不能在 messages 中
        let system = undefined;
        const anthropicMessages = [];
        for (const msg of messages) {
            if (msg.role === 'system') {
                system = msg.content;
            } else {
                anthropicMessages.push(msg);
            }
        }
        const body = { model, max_tokens: maxTokens, messages: anthropicMessages };
        if (system) body.system = system;
        return body;
    }
    // OpenAI: 标准格式
    return { model, messages, max_tokens: maxTokens, temperature };
}

/**
 * 获取本地 Claude Code 版本号（用于伪装 User-Agent）
 * 通过 `claude --version` 动态获取，失败则回退到默认值
 */
function getClaudeCodeVersion() {
    try {
        const { execSync } = require('child_process');
        const output = execSync('claude --version 2>/dev/null', {
            encoding: 'utf8',
            timeout: 1000
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
 * OpenAI: response.choices[0].message.content
 * Anthropic: response.content[0].text
 */
function parseResponseText(apiType, response) {
    if (apiType === 'anthropic') {
        if (response.content && Array.isArray(response.content) && response.content[0]) {
            const first = response.content[0];
            // 支持 text 和 thinking 两种类型
            if (first.type === 'text') {
                return first.text || '';
            }
            if (first.type === 'thinking') {
                return first.thinking || '';
            }
            return first.text || first.thinking || '';
        }
    } else {
        if (response.choices && response.choices[0]) {
            const msg = response.choices[0].message;
            return msg.content || msg.reasoning_content || '';
        }
    }
    return null;
}

function parseAnalysis(analysis) {
    if (!analysis) return null;

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
        rankBucket: '',
        qualityScore: '',
        valueScore: '',
        reproducibilityBonus: '',
        confidence: '',
        primaryTaskTag: '',
        primaryMethodTag: '',
        sotaClaim: '',
        hasCode: '',
        hasModel: '',
        hasDataset: ''
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
        if (taskLine) extractedTaskTag = _normalizeTag(taskLine[1]);
        const methodLine = tagSection.match(/主方法标签\s*[：:]\s*(.+)/);
        if (methodLine) extractedMethodTag = _normalizeTag(methodLine[1]);
    }

    m = analysis.match(/##\s*标签\s*\n\s*([^\n]+)/);
    if (!m) m = analysis.match(/(?:标签|关键词)[：:]\s*([^\n]+)/);
    if (m) {
        const rawTags = m[1];
        // 先尝试匹配带 # 前缀的标签
        let tags = rawTags.match(/#\S+/g) || [];
        // 如果没有带 # 的标签，尝试按分隔符拆分并自动添加 # 前缀
        if (tags.length === 0) {
            const parts = rawTags.split(/[,，;；、\s]+/).filter(p => p.trim());
            tags = parts.map(p => {
                const trimmed = p.trim().replace(/^[`\s]+|[`\s]+$/g, '');
                return trimmed ? '#' + trimmed : null;
            }).filter(Boolean);
        }
        result.tags = tags;
    }

    const machineSummary = parseMachineSummary(analysis);
    result.machineSummary = machineSummary;
    result.rankBucket = machineSummary.rankBucket;
    result.qualityScore = machineSummary.qualityScore;
    result.valueScore = machineSummary.valueScore;
    result.reproducibilityBonus = machineSummary.reproducibilityBonus;
    result.confidence = machineSummary.confidence;
    // 主任务/主方法标签：优先从 ## 标签 部分的"主任务标签"行提取，
    // 其次从机器摘要获取，最后从 tags[0] fallback。
    // 如果机器摘要的标签质量太差（snake_case/arXiv类别/过于宽泛），则优先使用 tags[0]。
    const msTask = _normalizeTag(machineSummary.primaryTaskTag);
    const msMethod = _normalizeTag(machineSummary.primaryMethodTag);
    const firstTag = result.tags.length > 0 ? _normalizeTag(result.tags[0]) : '';
    const secondTag = result.tags.length > 1 ? _normalizeTag(result.tags[1]) : firstTag;

    // 从 tags 列表中找到第一个非坏标签
    let goodTag = '';
    for (const t of result.tags) {
        const nt = _normalizeTag(t);
        if (nt && !_isBadTaskTag(nt)) {
            goodTag = nt;
            break;
        }
    }

    if (extractedTaskTag) {
        result.primaryTaskTag = extractedTaskTag;
    } else if (!_isBadTaskTag(msTask)) {
        result.primaryTaskTag = msTask;
    } else if (goodTag) {
        result.primaryTaskTag = goodTag;
    } else {
        result.primaryTaskTag = msTask || firstTag;
    }

    if (extractedMethodTag) {
        result.primaryMethodTag = extractedMethodTag;
    } else if (!_isBadTaskTag(msMethod)) {
        result.primaryMethodTag = msMethod;
    } else if (goodTag && goodTag !== result.primaryTaskTag) {
        result.primaryMethodTag = goodTag;
    } else {
        result.primaryMethodTag = msMethod || secondTag;
    }
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

    // 从评分理由中提取七个分项并计算总分，始终覆盖 LLM 给出的总分
    const scoringText = result.scoringReason || '';
    if (scoringText) {
        const dimScores = {};
        // 每个维度的上限（用于截断旧格式或 LLM 越界输出）
        const dimMax = {
            '创新性': 3,
            '技术严谨性': 1.5,
            '实验充分性': 1.5,
            '清晰度': 1,
            '影响力': 2,
            '开源': 1.5,
            '可复现性': 0.5
        };
        const dims = Object.keys(dimMax);
        for (const dim of dims) {
            // 支持多种 LLM 输出格式：
            // 1. **创新性 (3分)**：2.2分
            // 2. **创新性 (2.5/3)**：...
            // 3. **创新性: 2.3/3**
            const patterns = [
                // 格式1: dim (max/max)**：score
                new RegExp('(?:\\*\\*)?\\s*' + escapeRegExp(dim) + '\\s*\\(\\s*\\d+\\.?\\d*\\s*(?:/\\s*\\d+\\.?\\d*)?\\s*分?\\s*\\)\\s*(?:\\*\\*)?\\s*[:：]\\s*(?:\\*\\*)?\\s*(\\d+\\.?\\d*)'),
                // 格式2: dim (score/max)
                new RegExp('(?:\\*\\*)?\\s*' + escapeRegExp(dim) + '\\s*\\(\\s*(\\d+\\.?\\d*)\\s*/\\s*\\d+\\.?\\d*\\s*\\)'),
                // 格式3: dim: score/max
                new RegExp('(?:\\*\\*)?\\s*' + escapeRegExp(dim) + '\\s*[:：]\\s*(\\d+\\.?\\d*)\\s*/\\s*\\d+\\.?\\d*\\s*(?:\\*\\*)?'),
            ];
            let dm = null;
            for (const pat of patterns) {
                dm = scoringText.match(pat);
                if (dm) break;
            }
            if (dm) {
                const v = parseFloat(dm[1]);
                if (!isNaN(v)) {
                    // 截断到该维度的上限，防止旧格式或 LLM 越界输出导致总分异常
                    dimScores[dim] = Math.min(v, dimMax[dim]);
                }
            }
        }
        if (Object.keys(dimScores).length > 0) {
            let total = Object.values(dimScores).reduce((a, b) => a + b, 0);
            total = Math.max(1.0, Math.min(10.0, total));
            result.score = String(Math.round(total * 10) / 10);

            // 用评分理由的分项覆盖机器摘要字段，确保与总分一致
            const qs = (dimScores['创新性'] || 0) + (dimScores['技术严谨性'] || 0)
                     + (dimScores['实验充分性'] || 0) + (dimScores['清晰度'] || 0);
            const vs = dimScores['影响力'] || 0;
            const rb = (dimScores['开源'] || 0) + (dimScores['可复现性'] || 0);

            result.qualityScore = String(Math.round(qs * 10) / 10);
            result.valueScore = String(Math.round(vs * 10) / 10);
            result.reproducibilityBonus = String(Math.round(rb * 10) / 10);

            if (result.machineSummary) {
                result.machineSummary.qualityScore = result.qualityScore;
                result.machineSummary.valueScore = result.valueScore;
                result.machineSummary.reproducibilityBonus = result.reproducibilityBonus;
            }
        }
    }

    // rankBucket 推断：在评分计算完成后执行，确保基于最终 score
    if (!result.rankBucket && result.score) {
        const s = parseFloat(result.score);
        if (!isNaN(s)) {
            if (s >= 9.0) result.rankBucket = '前10%';
            else if (s >= 7.5) result.rankBucket = '前25%';
            else if (s >= 5.5) result.rankBucket = '前50%';
            else result.rankBucket = '后50%';
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

/**
 * 检测系统代理 URL
 * 优先级：环境变量 > macOS 系统代理设置(scutil) > null
 */
function detectProxyUrl() {
    // 1. 检查环境变量
    for (const envVar of PROXY_ENV_VARS) {
        if (process.env[envVar]) {
            return process.env[envVar];
        }
    }

    // 2. 检查 macOS 系统代理 (scutil)
    try {
        const { execSync } = require('child_process');
        const output = execSync('scutil --proxy', { encoding: 'utf8', timeout: 3000 });
        const lines = output.trim().split('\n');
        const proxyInfo = {};
        lines.forEach(line => {
            const match = line.match(/^\s*(\w+)\s*:\s*(.+)$/);
            if (match) {
                proxyInfo[match[1]] = match[2].trim();
            }
        });

        if (proxyInfo.HTTPSEnable === '1' && proxyInfo.HTTPSProxy && proxyInfo.HTTPSPort) {
            return `http://${proxyInfo.HTTPSProxy}:${proxyInfo.HTTPSPort}`;
        }
        if (proxyInfo.HTTPEnable === '1' && proxyInfo.HTTPProxy && proxyInfo.HTTPPort) {
            return `http://${proxyInfo.HTTPProxy}:${proxyInfo.HTTPPort}`;
        }
    } catch (e) {
        // scutil 不可用或失败，忽略
    }

    return null;
}

/**
 * 创建 HTTP CONNECT 代理 Agent（纯 Node 内置模块，无需外部依赖）
 * @param {string} proxyUrl - 代理 URL，如 http://127.0.0.1:7897
 * @param {string} targetHost - 目标主机名（用于 CONNECT 请求和 TLS SNI）
 * @param {number} targetPort - 目标端口（默认 443）
 */
function createProxyAgent(proxyUrl, targetHost, targetPort = 443) {
    const proxy = new URL(proxyUrl);
    const proxyPort = parseInt(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
    const https = require('https');
    const net = require('net');
    const tls = require('tls');

    return new https.Agent({
        createConnection: (opts, callback) => {
            const socket = net.connect({ host: proxy.hostname, port: proxyPort });

            socket.once('connect', () => {
                const connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nConnection: close\r\n\r\n`;
                socket.write(connectReq);

                let buffer = '';
                const onData = (chunk) => {
                    buffer += chunk.toString('binary');
                    const headerEnd = buffer.indexOf('\r\n\r\n');
                    if (headerEnd !== -1) {
                        socket.removeListener('data', onData);
                        const statusLine = buffer.slice(0, buffer.indexOf('\r\n'));
                        if (!statusLine.includes('200')) {
                            callback(new Error(`Proxy CONNECT failed: ${statusLine}`));
                            return;
                        }
                        const tlsSocket = tls.connect({
                            socket: socket,
                            servername: targetHost,
                            rejectUnauthorized: true
                        }, () => callback(null, tlsSocket));
                        tlsSocket.on('error', callback);
                    }
                };
                socket.on('data', onData);
            });

            socket.on('error', callback);
        }
    });
}

// ═══════════════════════════════════════════════════════
// papers.json 自动备份
// ═══════════════════════════════════════════════════════

const PAPERS_BACKUP_MAX_DAYS = 7;
const PAPERS_BACKUP_PREFIX = 'papers-';

/**
 * 备份 papers.json 到归档目录
 * @param {string} papersFilePath - papers.json 文件路径
 * @param {string} archiveDir - 归档目录路径
 * @returns {Object} { backedUp: boolean, backupPath?: string, message: string }
 */
function backupPapersJson(papersFilePath, archiveDir) {
    if (!fs.existsSync(papersFilePath)) {
        return { backedUp: false, message: 'papers.json 不存在，无需备份' };
    }

    const today = getBeijingDateString();
    const backupName = `${PAPERS_BACKUP_PREFIX}${today}.json`;
    const backupPath = path.join(archiveDir, backupName);

    // 如果今天已备份，跳过
    if (fs.existsSync(backupPath)) {
        return { backedUp: false, message: `今日备份已存在: ${backupName}` };
    }

    ensureDir(archiveDir);
    fs.copyFileSync(papersFilePath, backupPath);

    // 清理旧备份（保留最近 N 天）
    try {
        const backups = fs.readdirSync(archiveDir)
            .filter(f => f.startsWith(PAPERS_BACKUP_PREFIX) && f.endsWith('.json'))
            .map(f => ({ name: f, path: path.join(archiveDir, f), mtime: fs.statSync(path.join(archiveDir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
        if (backups.length > PAPERS_BACKUP_MAX_DAYS) {
            for (const b of backups.slice(PAPERS_BACKUP_MAX_DAYS)) {
                fs.unlinkSync(b.path);
            }
        }
    } catch (e) {
        // ignore cleanup errors
    }

    return { backedUp: true, backupPath, message: `已备份: ${backupName}` };
}

// ═══════════════════════════════════════════════════════
// Prompt 加载（从 markdown 文件读取）
// ═══════════════════════════════════════════════════════

/**
 * 从 markdown 文件加载 prompt
 * 读取文件后，提取第一个 ``` 代码块内的内容，并替换占位符
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

    // 提取第一个 ``` 或 ```text 代码块内的内容
    const blockMatch = content.match(/```(?:text)?\n([\s\S]*?)\n```/);
    if (!blockMatch) {
        throw new Error(`Prompt 文件 ${mdPath} 中未找到 \`\`\` 代码块`);
    }

    let prompt = blockMatch[1];

    // 替换占位符 {key} → value（对 key 做正则转义，防止注入；使用回调避免 $ 特殊含义）
    for (const [key, value] of Object.entries(vars)) {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const placeholder = new RegExp(`\\{${escapedKey}\\}`, 'g');
        prompt = prompt.replace(placeholder, () => String(value));
    }

    // 检测未替换的占位符并警告（只在原始模板中检测，避免将替换值中的 LaTeX 符号误判）
    const templateVars = [...blockMatch[1].matchAll(/\{([a-zA-Z_]\w*)\}/g)].map(m => m[1]);
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
    // API 路由
    detectApiType,
    getAnthropicEndpoint,
    buildApiUrl,
    buildRequestBody,
    buildHeaders,
    getClaudeCodeVersion,
    parseResponseText,
    // 代理
    detectProxyUrl,
    createProxyAgent,
    // 备份
    backupPapersJson,
    // Prompt
    loadPrompt
};
