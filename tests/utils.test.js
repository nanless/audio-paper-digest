const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
    stripMd,
    parseMachineSummary,
    parseAnalysis,
    detectApiType,
    getAnthropicEndpoint,
    buildApiUrl,
    buildRequestBody,
    buildHeaders,
    getClaudeCodeVersion,
    parseResponseText,
    normalizedId,
    extractDatePrefix,
    getRecordDate,
    backupPapersJson
} = require('../scripts/utils.js');

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

describe('parseMachineSummary', () => {
    it('解析标准机器摘要块', () => {
        const analysis = `### 机器摘要
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

    it('空输入返回 null', () => {
        assert.strictEqual(parseAnalysis(''), null);
        assert.strictEqual(parseAnalysis(null), null);
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

    it('通用 OpenAI -> openai', () => {
        assert.strictEqual(detectApiType('https://api.openai.com/v1', 'gpt-4o'), 'openai');
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

    it('OpenAI -> /v1/chat/completions', () => {
        const url = buildApiUrl('openai', 'https://api.openai.com/v1');
        assert.strictEqual(url, 'https://api.openai.com/v1/chat/completions');
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

    it('Anthropic system 为顶级字段', () => {
        const body = buildRequestBody('anthropic', 'mimo', [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hello' }
        ], 1000, 0.5);
        assert.strictEqual(body.model, 'mimo');
        assert.strictEqual(body.system, 'sys');
        assert.strictEqual(body.messages.length, 1);
        assert.strictEqual(body.messages[0].role, 'user');
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

    it('Anthropic text 格式', () => {
        const text = parseResponseText('anthropic', {
            content: [{ type: 'text', text: 'hello' }]
        });
        assert.strictEqual(text, 'hello');
    });

    it('无效响应返回 null', () => {
        assert.strictEqual(parseResponseText('openai', {}), null);
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
