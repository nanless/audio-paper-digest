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
            
            // 对于 rankBucket，使用扩展映射表
            if (mappedKey === 'rankBucket') {
                val = rankMap[val] || '';
            }
            
            // 对于分数类字段，提取数字部分
            if (['qualityScore', 'valueScore', 'reproducibilityBonus'].includes(mappedKey)) {
                // 处理 "3.5/5"、"3.5分"、"3.5 / 5" 等格式
                const numMatch = val.match(/^(\d+\.?\d*)/);
                if (numMatch) {
                    val = numMatch[1];
                } else {
                    // 如果没有数字，尝试映射中文描述
                    const scoreMap = {
                        '高': '6', '很高': '6.5', '上': '6', '上上': '6.5',
                        '中高': '5', '中上': '5', '较高': '5.5',
                        '中': '3.5', '中等': '3.5', '中等偏下': '3', '中下': '3',
                        '一般': '3.5', '中低': '3', '较低': '2.5',
                        '低': '2', '很低': '1.5', '下': '2', '差': '1.5',
                        '较弱': '2', '偏低': '2.5', '较低': '2.5',
                        'solid': '4', 'incremental': '2', 'partial': '1',
                        'high': '6', 'medium': '3.5', 'low': '2'
                    };
                    val = scoreMap[val.toLowerCase()] || '';
                }
            }
            
            // 对于 confidence，标准化
            if (mappedKey === 'confidence') {
                // 处理数字（0.9 → 高）
                const numMatch = val.match(/^(\d+\.?\d*)/);
                if (numMatch) {
                    const num = parseFloat(numMatch[1]);
                    if (num >= 0.8 || num >= 4) val = '高';
                    else if (num >= 0.5 || num >= 3) val = '中';
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

// ═══════════════════════════════════════════════════════
// 允许的标签白名单（与 prompts/deep-analysis.md 标签表同步）
// ═══════════════════════════════════════════════════════
const ALLOWED_TAGS = new Set([
    // 模型/架构
    '#音频大模型','#语音大模型','#多模态模型','#统一音频模型',
    '#大语言模型','#生成模型','#自回归模型','#端到端',
    // 任务 — 语音
    '#语音合成','#语音识别','#语音增强','#语音分离',
    '#语音生成','#语音克隆','#语音转换','#语音翻译','#语音情感识别','#语音情感计算','#语音活动检测',
    '#说话人识别','#说话人验证','#说话人分离','#说话人日志',
    '#语音对话系统','#语音伪造检测','#语音鉴伪','#语音匿名化','#语音生物标志物','#语音编辑','#语音质量评估','#语音打断处理',
    '#语音去噪','#语音去混响','#语音超分辨','#语音补全','#语音风格迁移','#情感语音合成','#语音编码','#语音检索','#语音问答','#语音摘要',
    '#语音唤醒','#关键词检测','#语音评测','#语音隐写','#语音变声','#语音混淆','#语音隐私保护',
    '#口音识别','#年龄估计','#性别识别','#语音可懂度评估','#语音清晰度评估',
    // 任务 — 音频
    '#音频生成','#音频分类','#音频事件检测','#声事件定位','#音频场景理解','#音频问答','#音频检索',
    '#盲源分离','#信号分离',
    '#音频安全','#音频深度伪造检测','#音频鉴伪','#音频异常检测',
    '#空间音频','#3D音频','#声源定位','#声学场景识别','#生物声学','#音频编码','#音频修复','#音频水印','#音频质量评估',
    '#声景生成','#音频超分辨','#音频指纹','#音频降噪','#音频分离','#混响消除','#主动降噪','#回声消除','#声学测量','#信号处理基础',
    // 任务 — 音乐
    '#音乐生成','#音乐信息检索','#音乐理解','#歌唱语音合成','#音乐转录','#和弦识别','#节拍跟踪','#音乐源分离','#音乐结构分析','#乐器识别','#音乐表示学习','#风格迁移','#音乐评估','#舞台技术','#乐谱生成','#音乐推荐',
    '#音乐去噪','#音乐超分辨','#音乐分类','#音乐情感识别','#自动伴奏生成','#音乐对齐','#MIDI生成','#音乐版权检测','#翻唱识别','#音乐水印','#哼唱识别','#音乐合成',
    // 方法 — 神经网络架构
    '#Transformer','#CNN','#RNN','#LSTM','#GRU','#ResNet','#U-Net','#Conformer',
    '#WaveNet','#wav2vec','#HuBERT','#Whisper','#Codec','#Neural Codec','#RVQ','#VQ-VAE','#NSF',
    '#ConNeXt','#Swin Transformer','#MLP-Mixer','#图神经网络','#胶囊网络',
    '#生成对抗网络','#变分自编码器','#归一化流','#扩散模型','#流匹配','#条件流匹配',
    // 方法 — 训练策略
    '#预训练','#自监督学习','#无监督学习','#对比学习','#强化学习','#知识蒸馏','#迁移学习',
    '#领域适应','#测试时自适应','#元学习','#持续学习','#课程学习','#对抗训练','#多任务学习',
    '#模型压缩','#模型剪枝','#模型融合','#模型集成','#集成学习','#参数高效微调','#正则化微调',
    '#LoRA','#Adapter','#前缀微调','#提示学习','#指令微调','#联邦学习',
    '#混合精度训练','#梯度累积','#学习率预热','#早停','#warm-up','#冷启动',
    // 方法 — 优化算法
    '#Adam','#SGD','#AdamW','#RMSprop','#AdaGrad','#AdaDelta','#Adamax',
    '#余弦退火','#指数衰减','#阶梯衰减','#多项式衰减',
    '#梯度裁剪','#权重衰减','#动量','#Nesterov加速','#学习率调度',
    // 方法 — 正则化与归一化
    '#Dropout','#DropConnect','#标签平滑','#Mixup','#CutMix','#SpecAugment',
    '#批归一化','#层归一化','#组归一化','#实例归一化','#谱归一化',
    '#权重标准化','#数据增强','#随机擦除','#随机裁剪','#时间拉伸','#音高偏移',
    // 方法 — 信号处理基础
    '#STFT','#iSTFT','#短时傅里叶变换','#梅尔频谱','#梅尔频率倒谱系数','#MFCC',
    '#滤波器组','#倒谱分析','#线性预测编码','#LPC','#谱减法','#维纳滤波',
    '#卡尔曼滤波','#粒子滤波','#自适应滤波','#谱包络','#基频提取','#谐波分析',
    '#包络提取','#过零率','#能量检测','#谱质心','#谱通量','#过零率检测',
    // 方法 — 评估与统计
    '#MOS评测','#ABX测试','#显著性检验','#交叉验证','#自助法','#假设检验',
    '#半参数方法','#稳健估计','#统计推断',
    '#混淆矩阵','#ROC曲线','#AUC','#t检验','#方差分析','#置信区间','#效应量',
    '#K折交叉验证','#留一法','#分层抽样','#自助聚合',
    // 方法 — 概率与图模型
    '#贝叶斯方法','#隐马尔可夫模型','#条件随机场','#高斯混合模型',
    '#变分推断','#马尔可夫链蒙特卡洛','#期望最大化','#信念传播',
    '#概率图模型','#高斯过程','#狄利克雷过程',
    // 方法 — 传统机器学习
    '#聚类分析','#K均值','#层次聚类','#DBSCAN','#谱聚类',
    '#时间序列分析','#降维','#主成分分析','#t-SNE','#UMAP','#线性判别分析',
    '#支持向量机','#决策树','#随机森林','#梯度提升树','#XGBoost','#LightGBM',
    '#K近邻','#线性回归','#逻辑回归','#岭回归','#Lasso','#弹性网络',
    // 属性/设置
    '#多语言','#零样本','#少样本','#低资源',
    '#流式处理','#实时处理','#多通道','#在线','#离线',
    '#对抗样本','#鲁棒性','#模型量化','#高效推理','#长音频处理','#理论分析',
    // 数据/工具/评估
    '#基准测试','#数据集','#开源工具','#模型评估','#模型比较','#数据清洗','#评测协议','#数据隐私',
    // 领域/应用
    '#音视频','#跨模态','#工业应用','#医疗音频','#智能座舱','#内容审核','#游戏音频','#计算机视觉',
    '#声纹识别','#语音驱动','#智能音箱','#助听器','#会议转录'
]);

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

    // 检查标签是否在白名单中
    function _isAllowedTag(tag) {
        if (!tag) return false;
        return ALLOWED_TAGS.has(tag);
    }

    // 过滤标签列表，只保留白名单中的标签
    function _filterAllowedTags(tags) {
        if (!tags || !Array.isArray(tags)) return [];
        return tags.map(t => _normalizeTag(t)).filter(t => _isAllowedTag(t));
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
        // 强制过滤：只保留白名单中的标签
        result.tags = _filterAllowedTags(tags);
    }

    const machineSummary = parseMachineSummary(analysis);
    result.machineSummary = machineSummary;
    result.rankBucket = machineSummary.rankBucket;
    result.qualityScore = machineSummary.qualityScore;
    result.valueScore = machineSummary.valueScore;
    result.reproducibilityBonus = machineSummary.reproducibilityBonus;
    result.confidence = machineSummary.confidence;

    // ═══════════════════════════════════════════════════════
    // 主任务/主方法标签解析（强制白名单验证）
    // ═══════════════════════════════════════════════════════

    // 定义任务标签和方法标签的分类（用于验证）
    const TASK_TAG_PREFIXES = [
        '#语音', '#音频', '#音乐', '#说话人', '#声源', '#声景', '#声纹',
        '#听觉', '#被动', '#痴呆', '#帕金森', '#统计信号', '#盲源', '#信号处理'
    ];
    const METHOD_TAG_PREFIXES = [
        '#Transformer','#CNN','#RNN','#LSTM','#GRU','#ResNet','#U-Net','#Conformer',
        '#WaveNet','#wav2vec','#HuBERT','#Whisper','#Codec','#Neural','#RVQ','#VQ-VAE','#NSF',
        '#ConNeXt','#Swin','#MLP-Mixer','#图神经网络','#胶囊网络',
        '#生成对抗网络','#变分自编码器','#归一化流','#条件流匹配',
        '#预训练','#自监督','#对比学习','#强化学习','#知识蒸馏','#迁移学习',
        '#领域适应','#元学习','#持续学习','#课程学习','#对抗训练','#多任务学习',
        '#模型压缩','#模型剪枝','#模型融合','#模型集成','#集成学习','#参数高效微调',
        '#LoRA','#Adapter','#前缀微调','#提示学习','#指令微调','#联邦学习',
        '#混合精度训练','#梯度累积','#学习率预热','#早停','#warm-up','#冷启动',
        '#Adam','#SGD','#AdamW','#RMSprop','#AdaGrad','#AdaDelta','#Adamax',
        '#余弦退火','#指数衰减','#阶梯衰减','#多项式衰减',
        '#梯度裁剪','#权重衰减','#动量','#Nesterov','#学习率调度',
        '#Dropout','#DropConnect','#标签平滑','#Mixup','#CutMix','#SpecAugment',
        '#批归一化','#层归一化','#组归一化','#实例归一化','#谱归一化',
        '#权重标准化','#数据增强','#随机擦除','#随机裁剪','#时间拉伸','#音高偏移',
        '#STFT','#iSTFT','#短时傅里叶变换','#梅尔频谱','#梅尔频率倒谱系数','#MFCC',
        '#滤波器组','#倒谱分析','#线性预测编码','#LPC','#谱减法','#维纳滤波',
        '#卡尔曼滤波','#粒子滤波','#自适应滤波','#谱包络','#基频提取','#谐波分析',
        '#包络提取','#过零率','#能量检测','#谱质心','#谱通量',
        '#MOS评测','#ABX测试','#显著性检验','#交叉验证','#自助法','#假设检验',
        '#混淆矩阵','#ROC曲线','#AUC','#t检验','#方差分析','#置信区间','#效应量',
        '#K折交叉验证','#留一法','#分层抽样','#自助聚合',
        '#贝叶斯方法','#隐马尔可夫模型','#条件随机场','#高斯混合模型',
        '#变分推断','#马尔可夫链蒙特卡洛','#期望最大化','#信念传播',
        '#概率图模型','#高斯过程','#狄利克雷过程',
        '#聚类分析','#K均值','#层次聚类','#DBSCAN','#谱聚类',
        '#降维','#主成分分析','#t-SNE','#UMAP','#线性判别分析',
        '#支持向量机','#决策树','#随机森林','#梯度提升树','#XGBoost','#LightGBM',
        '#K近邻','#线性回归','#逻辑回归','#岭回归','#Lasso','#弹性网络'
    ];

    function _isTaskTag(tag) {
        if (!tag) return false;
        return TASK_TAG_PREFIXES.some(prefix => tag.startsWith(prefix));
    }

    function _isMethodTag(tag) {
        if (!tag) return false;
        return METHOD_TAG_PREFIXES.some(prefix => tag.startsWith(prefix));
    }

    // 从已过滤的 tags 中找到第一个任务标签
    function _findFirstTaskTag(tags) {
        for (const t of tags) {
            const nt = _normalizeTag(t);
            if (_isAllowedTag(nt) && _isTaskTag(nt)) return nt;
        }
        return '';
    }

    // 从已过滤的 tags 中找到第一个方法标签
    function _findFirstMethodTag(tags) {
        for (const t of tags) {
            const nt = _normalizeTag(t);
            if (_isAllowedTag(nt) && _isMethodTag(nt)) return nt;
        }
        return '';
    }

    // 验证并修正主任务标签
    const validatedTaskTag = _isAllowedTag(extractedTaskTag) ? extractedTaskTag : '';
    const msTask = _isAllowedTag(_normalizeTag(machineSummary.primaryTaskTag)) ? _normalizeTag(machineSummary.primaryTaskTag) : '';
    const firstTaskFromTags = _findFirstTaskTag(result.tags);

    if (validatedTaskTag && _isTaskTag(validatedTaskTag)) {
        result.primaryTaskTag = validatedTaskTag;
    } else if (msTask && _isTaskTag(msTask)) {
        result.primaryTaskTag = msTask;
    } else if (firstTaskFromTags) {
        result.primaryTaskTag = firstTaskFromTags;
    } else {
        // 兜底：如果找不到任务标签，使用第一个允许的 tag（即使是方法标签）
        result.primaryTaskTag = result.tags.length > 0 ? result.tags[0] : '';
    }

    // 验证并修正主方法标签
    const validatedMethodTag = _isAllowedTag(extractedMethodTag) ? extractedMethodTag : '';
    const msMethod = _isAllowedTag(_normalizeTag(machineSummary.primaryMethodTag)) ? _normalizeTag(machineSummary.primaryMethodTag) : '';
    const firstMethodFromTags = _findFirstMethodTag(result.tags);

    if (validatedMethodTag && _isMethodTag(validatedMethodTag)) {
        result.primaryMethodTag = validatedMethodTag;
    } else if (msMethod && _isMethodTag(msMethod)) {
        result.primaryMethodTag = msMethod;
    } else if (firstMethodFromTags) {
        result.primaryMethodTag = firstMethodFromTags;
    } else {
        // 兜底：如果找不到方法标签，使用第一个非任务标签
        for (const t of result.tags) {
            if (t !== result.primaryTaskTag) {
                result.primaryMethodTag = t;
                break;
            }
        }
        if (!result.primaryMethodTag) {
            result.primaryMethodTag = result.tags.length > 1 ? result.tags[1] : (result.tags[0] || '');
        }
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
    // 排除单字母（如 {N}, {k}, {i} 等数学公式变量）
    const templateVars = [...blockMatch[1].matchAll(/\{([a-zA-Z_]\w{1,})\}/g)].map(m => m[1]);
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
