const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const {
    stripMd,
    parseMachineSummary,
    parseAnalysis,
    parseScoringDimensions,
    normalizeDocumentType,
    SCORING_RUBRIC_VERSION,
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
    normalizedId,
    requiresLlmProxy,
    extractDatePrefix,
    getRecordDate,
    backupPapersJson,
    loadPublishedIdsFromBlog,
    requestJson,
    loadPrompt,
    createProxyDispatcher,
    createProxyAgent,
    normalizeTlsServername,
    detectHttpConnectProxyUrl,
    buildProxyAuthorizationHeader
} = require('../scripts/utils.js');
const { validateAndFix } = require('../scripts/validate-scores.js');
const { getInvalidAnalysisReason } = require('../scripts/analysis-contract.js');

function scoringAnalysis(overrides = {}) {
    const dimensions = overrides.dimensions || [
        '创新性：1.5/2，理由充分。',
        '技术严谨性：1.2/1.5，理由充分。',
        '实验充分性：1.1/1.5，理由充分。',
        '清晰度：0.8/1，理由充分。',
        '影响力：1.0/1.5，理由充分。',
        '开源：0/1.5，理由充分。',
        '可复现性：0.3/0.5，理由充分。',
        '工程/实践价值：1.0/1.5，理由充分。'
    ];
    return `## 评分
${overrides.score ?? '9.0'}/10

## 机器摘要
document_type: 方法研究
rank_bucket: 前10%
confidence: ${overrides.confidence ?? '高'}
has_code: 否
has_model: 否
has_dataset: 否

## 评分理由
${dimensions.join('\n')}

## 局限与问题
未说明。

## 开源详情
未提供。`;
}

describe('stripMd', () => {
    it('去除加粗标记', () => {
        assert.strictEqual(stripMd('**hello**'), 'hello');
        assert.strictEqual(stripMd('__hello__'), 'hello');
    });

    it('去除斜体标记', () => {
        assert.strictEqual(stripMd('*hello*'), 'hello');
    });

    it('去除空值', () => {
        assert.strictEqual(stripMd(null), '');
        assert.strictEqual(stripMd(''), '');
    });
});

describe('fetch proxy dispatcher', () => {
    it('拒绝将 SOCKS URL 用于 Node arXiv fetch dispatcher', () => {
        assert.throws(
            () => createProxyDispatcher('socks5h://127.0.0.1:7897'),
            /HTTP\(S\).*代理|HTTP CONNECT/
        );
    });

    it('接受 HTTP CONNECT dispatcher', () => {
        assert.ok(createProxyDispatcher('http://127.0.0.1:7897'));
    });

    it('arXiv 前置检测忽略仅 SOCKS 的 ALL_PROXY', () => {
        const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
        const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
        try {
            for (const key of keys) delete process.env[key];
            process.env.ALL_PROXY = 'socks5h://127.0.0.1:7897';
            assert.strictEqual(detectHttpConnectProxyUrl(), null);
            process.env.HTTP_PROXY = 'http://127.0.0.1:7897';
            assert.strictEqual(detectHttpConnectProxyUrl(), 'http://127.0.0.1:7897');
        } finally {
            for (const key of keys) {
                if (original[key] === undefined) delete process.env[key];
                else process.env[key] = original[key];
            }
        }
    });

    it('CONNECT 代理认证生成 Basic 头并正确解码 URL userinfo', () => {
        assert.strictEqual(
            buildProxyAuthorizationHeader('http://alice:p%40ss@proxy.example:8080'),
            `Basic ${Buffer.from('alice:p@ss').toString('base64')}`
        );
        assert.strictEqual(buildProxyAuthorizationHeader('http://proxy.example:8080'), null);
    });
});

describe('parseMachineSummary', () => {
    it('解析标准机器摘要块', () => {
        const analysis = `### 机器摘要
document_type: 系统技术报告
rank_bucket: 前10%
innovation: 2.0
technical_rigor: 1.2
experimental_sufficiency: 1.0
clarity: 0.8
impact: 1.3
open_source: 1.0
reproducibility: 0.3
engineering_score: 1.2
confidence: 高
primary_task_tag: #语音识别
primary_method_tag: #语音大模型
sota_claim: 否
has_code: 是
has_model: 是
has_dataset: 否

### 评分规则
...`;
        const r = parseMachineSummary(analysis);
        assert.strictEqual(r.documentType, '系统技术报告');
        assert.strictEqual(r.rankBucket, '前10%');
        assert.strictEqual(r.innovation, '2.0');
        assert.strictEqual(r.technicalRigor, '1.2');
        assert.strictEqual(r.experimentalSufficiency, '1.0');
        assert.strictEqual(r.clarity, '0.8');
        assert.strictEqual(r.impact, '1.3');
        assert.strictEqual(r.openSource, '1.0');
        assert.strictEqual(r.reproducibility, '0.3');
        assert.strictEqual(r.engineeringScore, '1.2');
        assert.strictEqual(r.confidence, '高');
        assert.strictEqual(r.primaryTaskTag, '#语音识别');
        assert.strictEqual(r.primaryMethodTag, '#语音大模型');
        assert.strictEqual(r.sotaClaim, '否');
        assert.strictEqual(r.hasCode, '是');
        assert.strictEqual(r.hasModel, '是');
        assert.strictEqual(r.hasDataset, '否');
    });

    it('空输入返回空对象', () => {
        const r = parseMachineSummary('');
        assert.strictEqual(r.rankBucket, '');
        assert.strictEqual(r.innovation, '');
    });

    it('文档类型别名归一化且未知类型拒绝进入结构化结果', () => {
        assert.strictEqual(normalizeDocumentType('white paper'), '系统技术报告');
        assert.strictEqual(normalizeDocumentType('benchmark'), '数据集与基准');
        assert.strictEqual(normalizeDocumentType('宣传稿'), '');
    });

    it('按数值量表正确归一化置信度', () => {
        assert.strictEqual(parseMachineSummary('## 机器摘要\nconfidence: 3').confidence, '中');
        assert.strictEqual(parseMachineSummary('## 机器摘要\nconfidence: 4').confidence, '高');
        assert.strictEqual(parseMachineSummary('## 机器摘要\nconfidence: 0.7').confidence, '中');
    });
});

describe('parseAnalysis', () => {
    it('解析完整分析文本', () => {
        const analysis = `## 评分
8.5/10

### 机器摘要
rank_bucket: 前25%
innovation: 2.0

## 标签
#语音识别 #语音大模型 #多语言

## 毒舌点评
不错的工作。

## 核心摘要
摘要内容。

## 详细分析

### 01. 方法概述和架构
架构描述

### 02. 核心创新点
创新点

### 03. 细节详述
细节

### 04. 实验结果
结果

### 05. 评分理由
理由

## 开源详情
开源

## 图片与表格
图片`;
        const r = parseAnalysis(analysis);
        assert.strictEqual(r.score, '8.5');
        assert.deepStrictEqual(r.tags, ['#语音识别', '#语音大模型', '#多语言']);
        assert.strictEqual(r.rankBucket, '前25%');
        assert.strictEqual(r.innovationScore, '2.0');
        assert.ok(r.roast.includes('不错'));
        assert.ok(r.summary.includes('摘要'));
    });

    it('新评分文本保存文档类型和评分版本，旧文本保持兼容', () => {
        const modern = `## 评分\n6.0/10\n\n## 机器摘要\ndocument_type: 白皮书\nrank_bucket: 前50%\n\n## 标签\n#语音识别 #Transformer`;
        const parsedModern = parseAnalysis(modern);
        assert.strictEqual(parsedModern.documentType, '系统技术报告');
        assert.strictEqual(parsedModern.scoringRubricVersion, SCORING_RUBRIC_VERSION);

        const legacy = parseAnalysis('## 评分\n6.0/10\n\n## 机器摘要\nrank_bucket: 前50%\n\n## 标签\n#语音识别 #Transformer');
        assert.strictEqual(legacy.documentType, '');
        assert.strictEqual(legacy.scoringRubricVersion, '');
    });

    it('空输入返回 null', () => {
        assert.strictEqual(parseAnalysis(''), null);
        assert.strictEqual(parseAnalysis(null), null);
    });

    it('按精确任务表保留空间音频并拒绝评估标签冒充主任务', () => {
        const spatial = parseAnalysis(`## 评分\n6.0/10\n\n## 机器摘要\nprimary_task_tag: #空间音频\nprimary_method_tag: #CNN\n\n## 标签\n#空间音频 #音视频生成 #CNN\n主任务标签：#空间音频\n主方法标签：#CNN`);
        assert.strictEqual(spatial.primaryTaskTag, '#空间音频');
        assert.strictEqual(spatial.primaryMethodTag, '#CNN');

        const benchmark = parseAnalysis(`## 评分\n6.0/10\n\n## 机器摘要\nprimary_task_tag: #模型评估\nprimary_method_tag: #基准测试\n\n## 标签\n#模型评估 #基准测试 #音频理解\n主任务标签：#模型评估\n主方法标签：#基准测试`);
        assert.strictEqual(benchmark.primaryTaskTag, '#音频理解');
        assert.strictEqual(benchmark.primaryMethodTag, '#模型评估');
    });

    it('从八维评分理由重算总分并修正开源矛盾', () => {
        const analysis = `## 评分
9.9/10

### 机器摘要
rank_bucket: 前10%
innovation: 0
technical_rigor: 0
experimental_sufficiency: 0
clarity: 0
impact: 0
open_source: 1.2
reproducibility: 0
engineering_score: 0
confidence: 高
primary_task_tag: #语音识别
primary_method_tag: #语音大模型
has_code: 否
has_model: 否
has_dataset: 否

## 标签
#语音识别 #语音大模型

## 评分理由
创新性：2/2，具体理由充分。
技术严谨性：1.5/1.5，具体理由充分。
实验充分性：1.5/1.5，具体理由充分。
清晰度：1/1，具体理由充分。
影响力：1.5/1.5，具体理由充分。
开源：1.2/1.5，具体理由充分。
可复现性：0.5/0.5，具体理由充分。
工程/实践价值：1.5/1.5，具体理由充分。

## 局限与问题
未说明

## 开源详情
未提供`;
        const r = parseAnalysis(analysis);
        assert.strictEqual(r.openSourceScore, '0.0');
        assert.strictEqual(r.score, '9.5');
        assert.strictEqual(r.scoreValidation.scores.openSourceScore, 0);
        assert.strictEqual(r.rankBucket, '前10%');
    });

    it('评分维度缺失时保留正文总分并返回契约错误', () => {
        const analysis = scoringAnalysis({ dimensions: [
            '创新性：2/2，理由充分。',
            '技术严谨性：1.5/1.5，理由充分。'
        ] });
        const parsed = parseAnalysis(analysis);
        assert.strictEqual(parsed.score, '9.0');
        assert.strictEqual(parsed.scoreValidation.valid, false);
        assert.ok(parsed.scoreValidation.errors.some(error => error.includes('实验充分性')));
        const structurallyComplete = `## 评分
9.0/10

## 机器摘要
document_type: 方法研究
rank_bucket: 前10%
innovation: 2.0
technical_rigor: 1.5
experimental_sufficiency: 1.0
clarity: 0.8
impact: 1.0
open_source: 0.0
reproducibility: 0.3
engineering_score: 1.0
confidence: 高
primary_task_tag: #语音识别
primary_method_tag: #Transformer
sota_claim: 否
has_code: 否
has_model: 否
has_dataset: 否

## 标签
#语音识别 #Transformer #多语言
主任务标签：#语音识别
主方法标签：#Transformer
补充标签：#多语言

## 作者与机构
作者信息足够完整。

## 毒舌点评
点评内容足够完整。

## 核心摘要
${'摘要内容'.repeat(30)}

## 方法概述和架构
${'方法内容'.repeat(30)}

## 核心创新点
创新内容足够完整。

## 实验结果
${'实验内容'.repeat(20)}

## 细节详述
细节内容足够完整。

## 评分理由
创新性：2.0/2，理由充分。
技术严谨性：1.5/1.5，理由充分。

## 局限与问题
未说明。

## 开源详情
未提供。`;
        assert.match(getInvalidAnalysisReason(structurallyComplete, parseAnalysis(structurallyComplete)), /评分契约无效/);
    });

    it('理论研究的公开证明开源分不受代码模型数据矛盾规则误伤', () => {
        const analysis = scoringAnalysis({ dimensions: [
            '创新性：1.5/2，理由充分。',
            '技术严谨性：1.2/1.5，理由充分。',
            '实验充分性：1.1/1.5，理由充分。',
            '清晰度：0.8/1，理由充分。',
            '影响力：1.0/1.5，理由充分。',
            '开源：1.2/1.5，核心证明和推导已在正文附录公开。',
            '可复现性：0.3/0.5，理由充分。',
            '工程/实践价值：0/1.5，纯理论工作。'
        ] }).replace('document_type: 方法研究', 'document_type: 理论研究');
        const parsed = parseAnalysis(analysis);

        assert.strictEqual(parsed.documentType, '理论研究');
        assert.strictEqual(parsed.openSourceScore, '1.2');
        assert.strictEqual(parsed.scoreValidation.scores.openSourceScore, 1.2);
    });

    it('拒绝重复维度、错误分母、负数和越界分数', () => {
        const duplicate = parseScoringDimensions(scoringAnalysis().match(/## 评分理由\n([\s\S]*?)\n\n## 局限/)[1] + '\n创新性：1/2');
        assert.strictEqual(duplicate.valid, false);
        assert.ok(duplicate.errors.some(error => error.includes('重复出现')));

        const invalid = parseScoringDimensions([
            '创新性：2.1/2',
            '技术严谨性：-0.1/1.5',
            '实验充分性：1/10',
            '清晰度：1/1',
            '影响力：1/1.5',
            '开源：0/1.5',
            '可复现性：0.3/0.5',
            '工程/实践价值：1/1.5'
        ].join('\n'));
        assert.strictEqual(invalid.valid, false);
        assert.ok(invalid.errors.some(error => error.includes('超出 0-2')));
        assert.ok(invalid.errors.some(error => error.includes('超出 0-1.5')));
        assert.ok(invalid.errors.some(error => error.includes('分母必须为 1.5')));
    });

    it('八维全零时总分保持 0，不设置未约定的最低分', () => {
        const parsed = parseAnalysis(scoringAnalysis({ dimensions: [
            '创新性：0/2，未发现实质创新证据。',
            '技术严谨性：0/1.5，关键推导存在根本缺陷。',
            '实验充分性：0/1.5，没有提供实验验证。',
            '清晰度：0/1，正文表达无法理解。',
            '影响力：0/1.5，未展示潜在影响。',
            '开源：0/1.5，未提供开源产物。',
            '可复现性：0/0.5，缺少复现细节。',
            '工程/实践价值：0/1.5，没有工程价值证据。'
        ] }));
        assert.strictEqual(parsed.scoreValidation.valid, true);
        assert.strictEqual(parsed.score, '0.0');
        assert.strictEqual(parsed.rankBucket, '后50%');
    });

    it('每个评分维度都必须给出具体理由', () => {
        const parsed = parseAnalysis(scoringAnalysis({
            dimensions: [
                '创新性：1.5/2',
                '技术严谨性：1.2/1.5，方法推导较完整。',
                '实验充分性：1.1/1.5，覆盖主要基线。',
                '清晰度：0.8/1，结构较为清楚。',
                '影响力：1.0/1.5，应用范围较广。',
                '开源：0/1.5，未提供开源产物。',
                '可复现性：0.3/0.5，报告主要配置。',
                '工程/实践价值：1.0/1.5，部署路径明确。'
            ]
        }));
        assert.strictEqual(parsed.scoreValidation.valid, false);
        assert.ok(parsed.scoreValidation.errors.some(error => /创新性.*缺少具体评分理由/.test(error)));
    });

    it('validate-scores 从 analysis 修复陈旧、NaN 和负数缓存', () => {
        const analysis = scoringAnalysis();
        const stale = parseAnalysis(analysis);
        stale.score = Number.NaN;
        stale.innovationScore = -1;
        stale.openSourceScore = 1.2;
        const papers = [{ arxivId: '2607.99991', analysis, parsed: stale }];

        const result = validateAndFix(papers);
        assert.strictEqual(result.fixedCount, 1);
        assert.strictEqual(result.remainingIssueCount, 0);
        assert.strictEqual(papers[0].parsed.score, '6.9');
        assert.strictEqual(papers[0].parsed.innovationScore, '1.5');
        assert.strictEqual(papers[0].parsed.openSourceScore, '0.0');
        assert.ok(result.issues[0].oldIssues.some(issue => issue.includes('开源矛盾')));
    });

    it('validate-scores 不用残缺源分析覆盖已有缓存', () => {
        const validAnalysis = scoringAnalysis();
        const cached = parseAnalysis(validAnalysis);
        const incompleteAnalysis = scoringAnalysis({ dimensions: [
            '创新性：1.5/2',
            '技术严谨性：1.2/1.5'
        ] });
        const papers = [{ arxivId: '2607.99992', analysis: incompleteAnalysis, parsed: cached }];

        const result = validateAndFix(papers);
        assert.strictEqual(result.fixedCount, 0);
        assert.strictEqual(result.remainingIssueCount, 1);
        assert.strictEqual(papers[0].parsed, cached);
        assert.ok(result.issues[0].oldIssues.some(issue => issue.includes('缺少评分维度')));
    });

    it('validate-scores 接受理论研究公开证明对应的高开源锚点', () => {
        const analysis = scoringAnalysis({ dimensions: [
            '创新性：1.5/2，理论问题具有明确新意。',
            '技术严谨性：1.2/1.5，主要证明链条较完整。',
            '实验充分性：1.1/1.5，理论验证覆盖核心命题。',
            '清晰度：0.8/1，符号与推导结构清楚。',
            '影响力：1.0/1.5，对后续理论研究有价值。',
            '开源：1.2/1.5，正文公开完整证明材料。',
            '可复现性：0.3/0.5，推导步骤基本可复核。',
            '工程/实践价值：0/1.5，属于纯理论研究。'
        ] }).replace('document_type: 方法研究', 'document_type: 理论研究');
        const paper = { arxivId: '2607.99992', analysis, parsed: parseAnalysis(analysis) };

        const result = validateAndFix([paper]);
        assert.strictEqual(result.remainingIssueCount, 0);
        assert.strictEqual(paper.parsed.openSourceScore, '1.2');
    });
});

describe('detectApiType', () => {
    it('MiMo Token Plan -> anthropic', () => {
        assert.strictEqual(detectApiType('https://token-plan-cn.xiaomimimo.com/v1', 'mimo-v2.5'), 'anthropic');
    });

    it('MiMo 按量付费 -> openai', () => {
        assert.strictEqual(detectApiType('https://api.xiaomimimo.com/v1', 'mimo-v2.5'), 'openai');
    });

    it('Kimi Coding -> anthropic', () => {
        assert.strictEqual(detectApiType('https://api.kimi.com/coding/v1', 'kimi-for-coding'), 'anthropic');
    });

    it('Kimi Coding 通过域名识别 k3 模型并走 anthropic', () => {
        assert.strictEqual(detectApiType('https://api.kimi.com/coding/', 'k3'), 'anthropic');
    });

    it('仅模型名含 kimi、但端点不是 Coding Plan 时仍走 OpenAI', () => {
        assert.strictEqual(detectApiType('https://gateway.example.com/v1', 'kimi-compatible'), 'openai');
    });

    it('通用 OpenAI -> openai', () => {
        assert.strictEqual(detectApiType('https://api.openai.com/v1', 'gpt-4o'), 'openai');
    });

    it('DeepSeek /anthropic 路径 -> openai', () => {
        assert.strictEqual(detectApiType('https://api.deepseek.com/anthropic', 'deepseek-v4-pro'), 'openai');
    });

    it('OpenCode Go 的 DeepSeek 与 MiMo 都走 OpenAI 兼容协议', () => {
        const endpoint = 'https://opencode.ai/zen/go/v1';
        assert.strictEqual(detectApiType(endpoint, 'deepseek-v4-flash'), 'openai');
        assert.strictEqual(detectApiType(endpoint, 'mimo-v2.5'), 'openai');
    });

    it('OpenCode Go Muse Spark Contributor 走 OpenAI Responses API', () => {
        const endpoint = 'https://opencode.ai/zen/go/v1';
        assert.strictEqual(
            detectApiType(endpoint, 'muse-spark-1.2-contributor'),
            'openai_responses'
        );
        assert.strictEqual(
            detectApiType(`${endpoint}/responses`, 'future-model'),
            'openai_responses'
        );
        assert.strictEqual(
            detectApiType(`${endpoint}/responses/`, 'future-model'),
            'openai_responses'
        );
    });
});

describe('buildApiUrl', () => {
    it('MiMo -> /anthropic/v1/messages', () => {
        const url = buildApiUrl('anthropic', 'https://token-plan-cn.xiaomimimo.com/v1');
        assert.strictEqual(url, 'https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages');
    });

    it('Kimi -> /coding/v1/messages', () => {
        const url = buildApiUrl('anthropic', 'https://api.kimi.com/coding/v1');
        assert.strictEqual(url, 'https://api.kimi.com/coding/v1/messages');
    });

    it('Kimi 端点尾随斜杠仍保持 /coding/v1/messages', () => {
        const url = buildApiUrl('anthropic', 'https://api.kimi.com/coding/v1/');
        assert.strictEqual(url, 'https://api.kimi.com/coding/v1/messages');
    });

    it('Kimi 省略 /v1 的 Coding 端点会自动补齐 /coding/v1/messages', () => {
        const url = buildApiUrl('anthropic', 'https://api.kimi.com/coding/');
        assert.strictEqual(url, 'https://api.kimi.com/coding/v1/messages');
    });

    it('OpenAI -> /v1/chat/completions', () => {
        const url = buildApiUrl('openai', 'https://api.openai.com/v1');
        assert.strictEqual(url, 'https://api.openai.com/v1/chat/completions');
    });

    it('DeepSeek /anthropic 端点 -> /v1/chat/completions', () => {
        const url = buildApiUrl('openai', 'https://api.deepseek.com/anthropic');
        assert.strictEqual(url, 'https://api.deepseek.com/v1/chat/completions');
    });

    it('OpenCode Go 基础端点 -> 官方 chat completions URL', () => {
        const url = buildApiUrl('openai', 'https://opencode.ai/zen/go/v1');
        assert.strictEqual(url, 'https://opencode.ai/zen/go/v1/chat/completions');
    });

    it('OpenCode Go Muse 基础端点 -> 官方 responses URL', () => {
        const base = 'https://opencode.ai/zen/go/v1';
        assert.strictEqual(
            buildApiUrl('openai_responses', base),
            'https://opencode.ai/zen/go/v1/responses'
        );
        assert.strictEqual(
            buildApiUrl('openai_responses', `${base}/responses`),
            'https://opencode.ai/zen/go/v1/responses'
        );
    });

    it('拒绝公网明文 HTTP LLM endpoint', () => {
        assert.throws(
            () => buildApiUrl('openai', 'http://api.example.com/v1'),
            /禁止使用公网明文/
        );
        assert.throws(
            () => validateApiEndpointUrl('ftp://127.0.0.1/model'),
            /请改用 HTTPS/
        );
    });

    it('本地测试 HTTP 只允许 loopback 地址', () => {
        assert.strictEqual(
            buildApiUrl('openai', 'http://127.0.0.1:8080/v1'),
            'http://127.0.0.1:8080/v1/chat/completions'
        );
        assert.strictEqual(validateApiEndpointUrl('http://localhost:8080/v1').hostname, 'localhost');
        assert.strictEqual(validateApiEndpointUrl('http://[::1]:8080/v1').hostname, '[::1]');
        assert.throws(() => validateApiEndpointUrl('http://0.0.0.0:8080/v1'), /仅允许 loopback/);
    });
});

describe('buildRequestBody', () => {
    it('OpenAI 包含 system 在 messages 中', () => {
        const body = buildRequestBody('openai', 'gpt-4o', [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hello' }
        ], 1000, 0.5);
        assert.strictEqual(body.model, 'gpt-4o');
        assert.strictEqual(body.messages.length, 2);
        assert.strictEqual(body.temperature, 0.5);
    });

    it('OpenAI 纯文本 content block 会规范化为字符串', () => {
        const body = buildRequestBody('openai', 'deepseek-v4-pro', [
            { role: 'user', content: [{ type: 'text', text: 'hello' }] }
        ], 1000, 0.5);
        assert.strictEqual(body.messages[0].content, 'hello');
    });

    it('Anthropic system 为顶级字段', () => {
        const body = buildRequestBody('anthropic', 'mimo', [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hello' }
        ], 1000, 0.5);
        assert.strictEqual(body.model, 'mimo');
        assert.strictEqual(body.system, 'sys');
        assert.strictEqual(body.messages.length, 1);
        assert.strictEqual(body.messages[0].role, 'user');
        assert.strictEqual(body.temperature, 0.5);
    });

    it('Anthropic 多模态消息转换为 image source 格式', () => {
        const body = buildRequestBody('anthropic', 'mimo', [
            {
                role: 'user',
                content: [
                    { type: 'text', text: '请分析图片' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } }
                ]
            }
        ], 1000, 0.5);

        assert.deepStrictEqual(body.messages[0].content[0], { type: 'text', text: '请分析图片' });
        assert.deepStrictEqual(body.messages[0].content[1], {
            type: 'image',
            source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'abc123'
            }
        });
    });

    it('OpenAI Responses 使用 input/max_output_tokens 并转换内容块', () => {
        const body = buildRequestBody('openai_responses', 'muse-spark-1.2-contributor', [
            { role: 'system', content: 'sys' },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'hello' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc', detail: 'low' } }
                ]
            }
        ], 1200, 0.2);
        assert.strictEqual(body.model, 'muse-spark-1.2-contributor');
        assert.strictEqual(body.max_output_tokens, 1200);
        assert.strictEqual(body.input[0].content[0].type, 'input_text');
        assert.strictEqual(body.input[1].content[1].type, 'input_image');
        assert.strictEqual(body.input[1].content[1].image_url, 'data:image/png;base64,abc');
    });

    it('OpenAI Responses 可从项目 PD 配置显式降低推理强度', () => {
        const previous = process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT;
        process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT = 'low';
        try {
            const body = buildRequestBody('openai_responses', 'muse-spark-1.2-contributor', [
                { role: 'user', content: 'hello' }
            ], 12000, 0.7);
            assert.deepStrictEqual(body.reasoning, { effort: 'low' });
        } finally {
            if (previous === undefined) delete process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT;
            else process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT = previous;
        }
    });

    it('OpenAI Responses 可启用 SSE 流式传输', () => {
        const previous = process.env.PD_OPENAI_RESPONSES_STREAM;
        process.env.PD_OPENAI_RESPONSES_STREAM = '1';
        try {
            const body = buildRequestBody('openai_responses', 'muse-spark-1.2-contributor', [
                { role: 'user', content: 'hello' }
            ], 12000, 0.7);
            assert.strictEqual(body.stream, true);
        } finally {
            if (previous === undefined) delete process.env.PD_OPENAI_RESPONSES_STREAM;
            else process.env.PD_OPENAI_RESPONSES_STREAM = previous;
        }
    });
});

describe('buildHeaders', () => {
    it('Anthropic 使用 x-api-key', () => {
        const h = buildHeaders('anthropic', 'test-key', '{}');
        assert.strictEqual(h['x-api-key'], 'test-key');
        assert.strictEqual(h['anthropic-version'], '2023-06-01');
        assert.ok(h['User-Agent'].startsWith('claude-cli/'));
        assert.ok(h['User-Agent'].endsWith(' (external, cli)'));
    });

    it('OpenAI 使用 Authorization Bearer', () => {
        const h = buildHeaders('openai', 'test-key', '{}');
        assert.strictEqual(h['Authorization'], 'Bearer test-key');
    });
});

describe('getClaudeCodeVersion', () => {
    it('返回 semver 格式的版本号', () => {
        const v = getClaudeCodeVersion();
        assert.ok(/^\d+\.\d+\.\d+$/.test(v), `版本号格式错误: ${v}`);
    });

    it('buildHeaders 使用动态版本号', () => {
        const v = getClaudeCodeVersion();
        const h = buildHeaders('anthropic', 'k', '{}');
        assert.strictEqual(h['User-Agent'], `claude-cli/${v} (external, cli)`);
    });
});

describe('parseResponseText', () => {
    it('OpenAI 格式', () => {
        const text = parseResponseText('openai', {
            choices: [{ message: { content: 'hello' } }]
        });
        assert.strictEqual(text, 'hello');
    });

    it('OpenAI Responses 顶层 output_text 格式', () => {
        assert.strictEqual(
            parseResponseText('openai_responses', { output_text: 'hello' }),
            'hello'
        );
    });

    it('OpenAI Responses output message blocks 会合并', () => {
        const text = parseResponseText('openai_responses', {
            output: [{
                type: 'message',
                content: [
                    { type: 'output_text', text: 'hello' },
                    { type: 'output_text', text: 'world' }
                ]
            }]
        });
        assert.strictEqual(text, 'hello\nworld');
    });

    it('Anthropic text 格式', () => {
        const text = parseResponseText('anthropic', {
            content: [{ type: 'text', text: 'hello' }]
        });
        assert.strictEqual(text, 'hello');
    });

    it('Anthropic 多 text block 会合并', () => {
        const text = parseResponseText('anthropic', {
            content: [
                { type: 'text', text: 'hello' },
                { type: 'text', text: 'world' }
            ]
        });
        assert.strictEqual(text, 'hello\nworld');
    });

    it('无效响应返回 null', () => {
        assert.strictEqual(parseResponseText('openai', {}), null);
    });
});

describe('OpenAI Responses output truncation', () => {
    it('把 max_output_tokens 的 incomplete 结果转成可识别截断错误', () => {
        const error = getResponsesOutputTruncationError({
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            usage: { output_tokens: 47999 }
        }, 48000);
        assert.strictEqual(error.code, 'MODEL_OUTPUT_TRUNCATED');
        assert.strictEqual(error.outputTokens, 47999);
        assert.strictEqual(error.maxOutputTokens, 48000);
        assert.match(error.message, /48000/);
        assert.strictEqual(getResponsesOutputTruncationError({
            status: 'completed'
        }, 48000), null);
    });
});

describe('OpenAI Responses SSE parsing', () => {
    it('优先重放 completed response，并兼容仅 delta 的流', () => {
        const completed = parseSseResponse([
            'event: response.output_text.delta',
            'data: {"type":"response.output_text.delta","delta":"hel"}',
            '',
            'event: response.output_text.delta',
            'data: {"type":"response.output_text.delta","delta":"lo"}',
            '',
            'event: response.completed',
            'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}]}}',
            ''
        ].join('\n'));
        assert.strictEqual(parseResponseText('openai_responses', completed), 'hello');

        const deltasOnly = parseSseResponse([
            'data: {"type":"response.output_text.delta","delta":"a"}',
            '',
            'data: {"type":"response.output_text.delta","delta":"b"}',
            ''
        ].join('\n'));
        assert.strictEqual(deltasOnly.output_text, 'ab');
    });
});

describe('LLM proxy policy', () => {
    it('OpenCode Go Muse Spark Contributor 必须走代理', () => {
        assert.strictEqual(
            requiresLlmProxy(
                'https://opencode.ai/zen/go/v1',
                'muse-spark-1.2-contributor'
            ),
            true
        );
        assert.strictEqual(
            requiresLlmProxy(
                'https://loopback.invalid/v1',
                'muse-spark-1.2-contributor'
            ),
            true
        );
        assert.strictEqual(
            requiresLlmProxy('https://opencode.ai/zen/go/v1', 'deepseek-v4-flash'),
            false
        );
        assert.strictEqual(
            requiresLlmProxy('https://api.kimi.com/coding/v1', 'kimi-for-coding'),
            false
        );
    });
});

describe('requestJson', () => {
    it('支持本地 HTTP endpoint', async (t) => {
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: true, echo: body.value }));
            });
        });
        try {
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', resolve);
            });
        } catch (err) {
            if (err.code === 'EPERM' || err.code === 'EACCES') {
                t.skip(`当前环境不允许监听本地端口: ${err.code}`);
                return;
            }
            throw err;
        }
        try {
            const { port } = server.address();
            const response = await requestJson(
                `http://127.0.0.1:${port}/v1/chat/completions`,
                { value: 'hello' },
                { 'Content-Type': 'application/json' },
                { timeoutMs: 1000, agent: false }
            );

            assert.strictEqual(response.statusCode, 200);
            assert.deepStrictEqual(response.body, { ok: true, echo: 'hello' });
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });

    it('超过响应字节上限时立即失败', async (t) => {
        const server = http.createServer((_req, res) => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ payload: 'x'.repeat(2048) }));
        });
        try {
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', resolve);
            });
        } catch (err) {
            if (err.code === 'EPERM' || err.code === 'EACCES') {
                t.skip(`当前环境不允许监听本地端口: ${err.code}`);
                return;
            }
            throw err;
        }
        try {
            const { port } = server.address();
            await assert.rejects(
                requestJson(`http://127.0.0.1:${port}/`, {}, {}, {
                    timeoutMs: 1000,
                    maxResponseBytes: 128,
                    agent: false
                }),
                error => error.code === 'RESPONSE_TOO_LARGE'
            );
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });

    it('慢速持续响应也受绝对截止时间约束', async (t) => {
        const server = http.createServer((_req, res) => {
            res.write('{"chunks":[');
            const timer = setInterval(() => res.write('0,'), 10);
            res.once('close', () => clearInterval(timer));
        });
        try {
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', resolve);
            });
        } catch (err) {
            if (err.code === 'EPERM' || err.code === 'EACCES') {
                t.skip(`当前环境不允许监听本地端口: ${err.code}`);
                return;
            }
            throw err;
        }
        try {
            const { port } = server.address();
            await assert.rejects(
                requestJson(`http://127.0.0.1:${port}/`, {}, {}, {
                    timeoutMs: 80,
                    maxResponseBytes: 4096,
                    agent: false
                }),
                error => error.code === 'REQUEST_DEADLINE_EXCEEDED'
            );
        } finally {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
    });
});

describe('createProxyAgent', () => {
    it('TLS SNI 主机名会移除 IPv6 URL 方括号', () => {
        assert.strictEqual(normalizeTlsServername('[2606:4700:4700::1111]'), '2606:4700:4700::1111');
        assert.strictEqual(normalizeTlsServername('example.com'), 'example.com');
    });

    it('https.request 会真正通过自定义 CONNECT 通道', async (t) => {
        let connectRequest = '';
        const proxy = net.createServer(socket => {
            socket.once('data', chunk => {
                connectRequest = chunk.toString('utf8');
                socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
            });
        });
        try {
            await new Promise((resolve, reject) => {
                proxy.once('error', reject);
                proxy.listen(0, '127.0.0.1', resolve);
            });
        } catch (err) {
            if (err.code === 'EPERM' || err.code === 'EACCES') {
                t.skip(`当前环境不允许监听本地端口: ${err.code}`);
                return;
            }
            throw err;
        }
        try {
            const { port } = proxy.address();
            const agent = createProxyAgent(`http://127.0.0.1:${port}`, '203.0.113.7', 443, 'example.com');
            await assert.rejects(new Promise((resolve, reject) => {
                const request = https.request({
                    hostname: 'example.com',
                    path: '/',
                    agent
                }, resolve);
                request.once('error', reject);
                request.end();
            }), /Proxy CONNECT failed/);
            assert.match(connectRequest, /^CONNECT 203\.0\.113\.7:443 HTTP\/1\.1\r\n/);
        } finally {
            await new Promise(resolve => proxy.close(resolve));
        }
    });
});

describe('loadPublishedIdsFromBlog', () => {
    it('递归扫描 content/posts 子目录中的 arXiv 链接', () => {
        const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'paper-blog-'));
        const nested = path.join(root, 'content', 'posts', '2026', 'audio');
        fs.mkdirSync(nested, { recursive: true });
        fs.writeFileSync(path.join(nested, 'post.md'), '[arxiv](https://arxiv.org/abs/2604.12345v2)');

        const ids = loadPublishedIdsFromBlog(root);
        assert.strictEqual(ids.has('2604.12345'), true);
    });

    it('Git 博客只扫描 HEAD，忽略已安装但未提交的当日页面', () => {
        const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'paper-blog-head-'));
        const posts = path.join(root, 'content', 'posts');
        fs.mkdirSync(path.join(root, '.git'), { recursive: true });
        fs.mkdirSync(posts, { recursive: true });
        fs.writeFileSync(
            path.join(posts, '2026-09-01-uncommitted.md'),
            '[arxiv](https://arxiv.org/abs/2608.30951)'
        );

        let invocation;
        const ids = loadPublishedIdsFromBlog(root, {
            execFileSync: (command, args, options) => {
                invocation = { command, args, options };
                return '[arxiv](https://arxiv.org/abs/2608.10001v2)\n';
            },
            readFileSync: () => {
                throw new Error('Git 博客不得读取可变工作树 Markdown');
            }
        });

        assert.strictEqual(ids.has('2608.10001'), true);
        assert.strictEqual(ids.has('2608.30951'), false);
        assert.strictEqual(invocation.command, 'git');
        assert.ok(invocation.args.includes('HEAD'));
        assert.ok(invocation.args.includes(':(glob)content/posts/**/*.md'));
        assert.deepStrictEqual(Object.keys(invocation.options.env).sort(), ['LC_ALL', 'PATH']);
    });

    it('Git HEAD 扫描异常时 fail-closed，不能回退工作树', () => {
        const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'paper-blog-head-fail-'));
        fs.mkdirSync(path.join(root, '.git'), { recursive: true });
        fs.mkdirSync(path.join(root, 'content', 'posts'), { recursive: true });
        assert.throws(
            () => loadPublishedIdsFromBlog(root, {
                execFileSync: () => {
                    const error = new Error('invalid HEAD');
                    error.status = 128;
                    throw error;
                }
            }),
            error => error.code === 'BLOG_DEDUP_SCAN_FAILED'
                && /不完整去重基线/.test(error.message)
        );
    });

    it('目录存在但 Markdown 读取失败时 fail-closed', () => {
        const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'paper-blog-fail-'));
        const post = path.join(root, 'content', 'posts', 'post.md');
        fs.mkdirSync(path.dirname(post), { recursive: true });
        fs.writeFileSync(post, 'content');
        assert.throws(
            () => loadPublishedIdsFromBlog(root, {
                readFileSync: () => {
                    throw new Error('simulated EACCES');
                }
            }),
            error => error.code === 'BLOG_DEDUP_SCAN_FAILED'
                && /不完整去重基线/.test(error.message)
        );
    });
});

describe('normalizedId', () => {
    it('去除版本号', () => {
        assert.strictEqual(normalizedId({ arxivId: '2604.12345v1' }), '2604.12345');
    });

    it('小写化', () => {
        assert.strictEqual(normalizedId({ arxivId: 'ABC.DEF' }), 'abc.def');
    });

    it('回退到 paper_id', () => {
        assert.strictEqual(normalizedId({ paper_id: '2604.12345' }), '2604.12345');
    });
});

describe('extractDatePrefix', () => {
    it('提取 ISO 日期前缀', () => {
        assert.strictEqual(extractDatePrefix('2026-04-23T10:00:00+08:00'), '2026-04-23');
    });

    it('非字符串返回 null', () => {
        assert.strictEqual(extractDatePrefix(null), null);
        assert.strictEqual(extractDatePrefix(123), null);
    });
});

describe('getRecordDate', () => {
    it('从 timestamp 提取', () => {
        assert.strictEqual(getRecordDate({ timestamp: '2026-04-23T10:00:00+08:00' }), '2026-04-23');
    });

    it('从 lastUpdated 提取', () => {
        assert.strictEqual(getRecordDate({ lastUpdated: '2026-04-23T10:00:00+08:00' }), '2026-04-23');
    });

    it('无效输入返回 null', () => {
        assert.strictEqual(getRecordDate(null), null);
        assert.strictEqual(getRecordDate({}), null);
    });
});

describe('loadPrompt', () => {
    it('提取第一个代码块并替换占位符', () => {
        const prompt = loadPrompt('tests/fixtures/prompt.md', {
            title: '测试标题',
            score: '9.5'
        });
        assert.strictEqual(prompt.trim(), '标题: 测试标题\n分数: 9.5');
    });

    it('缺少代码块时报错', () => {
        assert.throws(
            () => loadPrompt('tests/fixtures/no-codeblock.md'),
            /未找到/
        );
    });

    it('拒绝项目目录外路径', () => {
        assert.throws(
            () => loadPrompt('../outside.md'),
            /路径不安全/
        );
    });

    it('未绑定占位符 warning 检查 prompt 内容而不是 fence 标记', () => {
        const warnings = [];
        const oldWarn = console.warn;
        console.warn = (msg) => warnings.push(String(msg));
        try {
            const prompt = loadPrompt('tests/fixtures/prompt-unbound.md', {
                title: '测试标题'
            });
            assert.match(prompt, /\{missing_value\}/);
        } finally {
            console.warn = oldWarn;
        }
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0], /\{missing_value\}/);
        assert.doesNotMatch(warnings[0], /\{N\}/);
    });

    it('真实 prompt 文件都包含可解析代码块', () => {
        const vars = {
            title: 'Test Title',
            abstract: 'Test abstract',
            categories: 'cs.SD',
            hasFullText: '以下是论文摘要。',
            authors: 'Test Author',
            arxivId: '2604.12345',
            textForAnalysis: 'Paper text',
            imageList: '图1: https://example.com/a.png',
            anchorCatalog: 's1p1 | 核心摘要 | 测试段落',
            primaryAnalysis: '## 评分\n8/10',
            existingAnalysis: '## 评分\n8/10',
            sourceEvidence: 'Original paper evidence',
            validationFeedback: '没有校验错误',
            previousDraft: '无',
            missingSections: '细节详述',
            methodSection: '## 方法概述和架构\n已有方法。',
            resultsSection: '## 实验结果\n已有结果。'
        };
        const promptFiles = [
            'prompts/filter.md',
            'prompts/deep-analysis.md',
            'prompts/image-supplement.md',
            'prompts/opensource-scan.md',
            'prompts/gap-fill.md',
            'prompts/method-fill.md',
            'prompts/table-fill.md',
            'prompts/scoring-audit.md',
            'prompts/api-reader-article.md',
            'prompts/structure-repair.md'
        ];
        for (const file of promptFiles) {
            const prompt = loadPrompt(file, vars);
            assert.ok(prompt.length > 20, `${file} prompt 过短`);
        }
        for (const file of ['prompts/deep-analysis.md', 'prompts/gap-fill.md']) {
            const prompt = loadPrompt(file, vars);
            assert.match(prompt, /document_type/, `${file} 缺少文档类型契约`);
            assert.match(prompt, /系统技术报告/, `${file} 缺少系统技术报告类型`);
            assert.match(prompt, /单一问题单一主维度|同一个缺陷|single-issue-single-primary-dimension|single defect/i, `${file} 缺少防重复扣分规则`);
        }
    });

    it('运行时中文 prompt 不包含未绑定占位符', () => {
        const vars = {
            title: 'Test Title',
            abstract: 'Test abstract',
            categories: 'cs.SD',
            hasFullText: '以下是论文摘要。',
            authors: 'Test Author',
            arxivId: '2604.12345',
            textForAnalysis: 'Paper text',
            imageList: '图1: https://example.com/a.png',
            anchorCatalog: 's1p1 | 核心摘要 | 测试段落',
            primaryAnalysis: '## 评分\n8/10',
            existingAnalysis: '## 评分\n8/10',
            sourceEvidence: 'Original paper evidence',
            validationFeedback: '没有校验错误',
            previousDraft: '无',
            missingSections: '细节详述',
            methodSection: '## 方法概述和架构\n已有方法。',
            resultsSection: '## 实验结果\n已有结果。'
        };
        const promptFiles = [
            'prompts/filter.md',
            'prompts/deep-analysis.md',
            'prompts/image-supplement.md',
            'prompts/opensource-scan.md',
            'prompts/gap-fill.md',
            'prompts/method-fill.md',
            'prompts/table-fill.md',
            'prompts/scoring-audit.md',
            'prompts/api-reader-article.md',
            'prompts/structure-repair.md'
        ];
        for (const file of promptFiles) {
            const prompt = loadPrompt(file, vars);
            const unbound = [...prompt.matchAll(/\{([a-zA-Z_]\w{1,})\}/g)].map(m => m[0]);
            assert.deepStrictEqual([...new Set(unbound)], [], `${file} 存在未绑定占位符`);
        }
    });
});

describe('LLM request invariants', () => {
    it('筛选和深度分析统一走按供应商隔离代理策略的请求封装', () => {
        const root = path.join(__dirname, '..');
        const fetchPapers = fs.readFileSync(path.join(root, 'scripts', 'fetch-papers.js'), 'utf8');
        const deepAnalyzer = fs.readFileSync(path.join(root, 'scripts', 'deep-analyzer.js'), 'utf8');
        assert.match(fetchPapers, /requestLlmJson\(/);
        assert.match(deepAnalyzer, /requestLlmJson\(/);
        assert.doesNotMatch(fetchPapers, /requestJson\([^)]*agent:\s*false/s);
        assert.doesNotMatch(deepAnalyzer, /requestJson\([^)]*agent:\s*false/s);
    });
});

describe('image markdown parsing', () => {
    it('保留方法和实验章节中的 Markdown 图片引用', () => {
        const analysis = `## 评分
8.0

## 机器摘要
rank_bucket: 前25%
innovation: 1.5/2
technical_rigor: 1.2/1.5
experimental_sufficiency: 1.2/1.5
clarity: 0.8/1
impact: 1.2/1.5
open_source: 0/1.5
reproducibility: 0.3/0.5
engineering_score: 1.0/1.5
confidence: 高
primary_task_tag: #语音识别
primary_method_tag: #Transformer
sota_claim: 否
has_code: 否
has_model: 否
has_dataset: 否

## 标签
#语音识别 #Transformer
主任务标签: #语音识别
主方法标签: #Transformer

## 方法概述和架构
模型流程如下。

![模型架构](https://arxiv.org/html/2604.12345/x1.png)

图中展示了编码器到解码器的数据流。

## 实验结果
结果图显示低信噪比下更稳定。

![语谱图对比](https://arxiv.org/html/2604.12345/x2.png)

## 评分理由
*   创新性 (1.5/2)：有新意。
*   技术严谨性 (1.2/1.5)：基本严谨。
*   实验充分性 (1.2/1.5)：实验较充分。
*   清晰度 (0.8/1)：图文清楚。
*   影响力 (1.2/1.5)：有影响。
*   开源 (0/1.5)：未开源。
*   可复现性 (0.3/0.5)：细节一般。
*   工程/实践价值 (1.0/1.5)：有实践价值。

## 局限与问题
未说明。

## 开源详情
未提及。`;
        const parsed = parseAnalysis(analysis);
        assert.match(parsed.architecture, /!\[模型架构\]\(https:\/\/arxiv\.org\/html\/2604\.12345\/x1\.png\)/);
        assert.match(parsed.results, /!\[语谱图对比\]\(https:\/\/arxiv\.org\/html\/2604\.12345\/x2\.png\)/);
    });
});
