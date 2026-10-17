'use strict';
// Shared decision semantics. Preserve v3 outputs and retryable fallbacks for saved requests.
const FILTER_DECISION_VERSION = 3;
const FILTER_DECISION_CONTRACT = `filter-decision-contract-v${FILTER_DECISION_VERSION}`;

function parseFilterDecision(responseText, paperId = '') {
    return parseFilterDecisionDetails(responseText, paperId).related;
}

function extractFilterReason(responseText) {
    const text = String(responseText || '').trim();
    if (!text) return '';
    try {
        const jsonStart = text.indexOf('{');
        const jsonEnd = text.lastIndexOf('}');
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
            const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
            if (parsed.reason || parsed.rationale || parsed.explanation) {
                return String(parsed.reason || parsed.rationale || parsed.explanation).trim();
            }
        }
    } catch {
        // JSON 解析失败，继续走下面的正则匹配
    }
    const reasonMatch = text.match(/(?:理由|原因|reason|rationale)\s*[：:]\s*([^\n]+)/i);
    if (reasonMatch) return reasonMatch[1].trim();
    return text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 2).join(' ');
}

function parseFilterDecisionDetails(responseText, paperId = '') {
    const rawText = String(responseText || '').trim();
    const answer = rawText.toLowerCase();
    const reason = extractFilterReason(responseText);
    const makeDecision = (related, source) => ({
        related,
        reason,
        rawResponse: rawText,
        parseSource: source
    });
    const makeRetryable = (source, suggestedRelated = null) => ({
        ...makeDecision(null, source),
        suggestedRelated,
        retryable: true,
        fallback: true
    });

    // 1. 优先解析 JSON 格式，便于未来让 prompt 输出机器可读结构
    try {
        const jsonStart = answer.indexOf('{');
        const jsonEnd = answer.lastIndexOf('}');
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
            const parsed = JSON.parse(rawText.slice(jsonStart, jsonEnd + 1));
            const decisionValue = getCaseInsensitiveField(parsed, ['decision', 'related', 'conclusion']);
            if (typeof decisionValue === 'boolean') return makeDecision(decisionValue, 'json');
            const decision = String(decisionValue ?? '').trim().toLowerCase();
            if (['related', 'yes', 'y', 'true', '相关', '是'].includes(decision)) return makeDecision(true, 'json');
            if (['not_related', 'not related', 'no', 'n', 'false', '不相关', '无关', '否'].includes(decision)) return makeDecision(false, 'json');
        }
    } catch {
        // JSON 解析失败，交给下面的文本解析
    }

    // 2. 优先匹配结构化结论行，先判否定，避免 fallback 中“是否相关”的“否”误伤
    const conclusionMatch = answer.match(/(?:结论|判断|是否相关|conclusion|judgment|related)\s*[：:]\s*(not\s+related|not_related|unrelated|不相关|无关|否|no|n|related|相关|是|yes|y)(?=\s|$|[。；;，,])/i);
    if (conclusionMatch) {
        const v = conclusionMatch[1].toLowerCase();
        return makeDecision(
            !(v === 'not related' || v === 'not_related' || v === 'unrelated' || v === '不相关' || v === '无关' || v === '否' || v === 'no' || v === 'n'),
            'conclusion_line'
        );
    }

    // 3. 检查最后一行
    const lines = answer.split('\n').map(l => l.trim()).filter(l => l);
    const lastLine = lines[lines.length - 1] || '';
    if (lastLine === '相关' || lastLine === '是' || lastLine === 'yes' || lastLine === 'y' || lastLine === 'related') {
        return makeDecision(true, 'last_line');
    }
    if (lastLine === '不相关' || lastLine === '无关' || lastLine === '否' || lastLine === 'no' || lastLine === 'n' || lastLine === 'not related' || lastLine === 'not_related' || lastLine === 'unrelated') {
        return makeDecision(false, 'last_line');
    }

    // 非结构化关键词只能作为诊断提示，不能写入正式完成缓存。
    if (answer.includes('不相关') || answer.includes('无关') || /\b(not related|not_related|unrelated)\b/i.test(answer)) {
        return makeRetryable('keyword_negative_retryable', false);
    }
    if (answer.includes('相关') || /\brelated\b/i.test(answer)) {
        return makeRetryable('keyword_positive_retryable', true);
    }

    // 无法可靠解析时保留为可重试状态，不得作为正式相关结论进入缓存。
    console.log(`[filter] 无法判断 ${paperId}: "${answer.substring(0, 50)}" → 标记为待重试`);
    return makeRetryable('fallback_retryable');
}

function getCaseInsensitiveField(obj, names) {
    if (!obj || typeof obj !== 'object') return undefined;
    const wanted = new Set(names.map(name => name.toLowerCase()));
    for (const [key, value] of Object.entries(obj)) {
        if (wanted.has(String(key).toLowerCase())) return value;
    }
    return undefined;
}

module.exports = { FILTER_DECISION_VERSION, FILTER_DECISION_CONTRACT,
    parseFilterDecision, parseFilterDecisionDetails, extractFilterReason, getCaseInsensitiveField };
