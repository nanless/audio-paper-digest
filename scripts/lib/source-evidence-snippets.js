'use strict';
const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const CONTRACT = 'sealed-source-evidence-snippets-v1';

function buildSourceEvidenceSnippets(source, { maxChars = 50000, maxSnippetChars = 800 } = {}) {
    if (typeof source !== 'string' || source.length < 100 || !Number.isInteger(maxChars) || maxChars < 1000
        || !Number.isInteger(maxSnippetChars) || maxSnippetChars < 100 || maxSnippetChars > 1000) throw new Error('来源正文必须是至少 100 个字符的字符串；总字符上限必须是至少 1000 的整数，单段字符上限必须是 100–1000 的整数。');
    const chunks = []; let offset = 0;
    while (offset < source.length) {
        let end = Math.min(source.length, offset + maxSnippetChars);
        if (end < source.length) {
            const paragraph = source.lastIndexOf('\n\n', end), sentence = source.lastIndexOf('. ', end);
            if (paragraph > offset + maxSnippetChars / 3) end = paragraph;
            else if (sentence > offset + maxSnippetChars / 2) end = sentence + 1;
        }
        if (end <= offset) throw new Error('无法继续划分来源片段：本轮结束位置没有超过起始位置。');
        const quote = source.slice(offset, end);
        if (quote.trim().length >= 20) chunks.push({ id: 's' + String(chunks.length + 1).padStart(5, '0'), quote,
            quoteStart: offset, quoteEnd: end, offsetUnit: 'utf16-code-unit', quoteSha256: digest(quote) });
        offset = end;
    }
    if (chunks.length === 0) throw new Error('来源正文没有可用的连续文本片段。');
    let selected = chunks;
    if (source.length > maxChars) {
        const count = Math.floor(maxChars / maxSnippetChars), chosen = new Set();
        // 按片段位置均衡取样；只能容纳一段时取中间片段，不推断具体章节。
        // 引文直接截取来源字符串，保留原始空白，并按 UTF16 代码单元记录位置。
        for (let i = 0; i < count; i++) {
            const position = count === 1 ? Math.floor((chunks.length - 1) / 2)
                : Math.round(i * (chunks.length - 1) / (count - 1));
            chosen.add(position);
        }
        selected = [...chosen].sort((a, b) => a - b).map(i => chunks[i]);
    }
    const evidenceText = selected.map(s => `[${s.id}; source UTF16 ${s.quoteStart}:${s.quoteEnd}]\n${s.quote}`).join('\n\n');
    return { contract: CONTRACT, sourceTextSha256: digest(source), offsetUnit: 'utf16-code-unit',
        sourceChars: source.length, evidenceChars: selected.reduce((n,s) => n + s.quote.length,0),
        sampling: selected.length === chunks.length ? 'full-source' : 'balanced-spans',
        snippets: selected, projection: evidenceText, evidenceSha256: digest(evidenceText) };
}

function fillConceptQuotesFromSnippets(raw, evidenceSnippets) {
    const text = String(raw).trim();
    if (!text.startsWith('{') || !text.endsWith('}')) throw new Error('标签选择响应必须直接以 JSON 对象开头和结尾，不能包在代码围栏中。');
    for (const key of ['primaryTaskId','primaryMethodId','concepts']) if ((text.match(new RegExp(`"${key}"\\s*:`, 'g')) || []).length !== 1) throw new Error('标签选择响应必须各包含一次 primaryTaskId、primaryMethodId 和 concepts 字段。');
    const value = JSON.parse(text);
    if (Object.keys(value).sort().join(',') !== 'concepts,primaryMethodId,primaryTaskId' || !Array.isArray(value.concepts)) throw new Error('标签选择响应只能包含 primaryTaskId、primaryMethodId 和 concepts 字段，且 concepts 必须是数组。');
    const snippetsById = new Map(evidenceSnippets.snippets.map(s => [s.id,s]));
    const concepts = value.concepts.map(c => {
        if (!c || Object.keys(c).sort().join(',') !== 'evidenceId,id,rationale' || !snippetsById.has(c.evidenceId)) throw new Error('每个概念必须仅包含 id、evidenceId 和 rationale，且 evidenceId 必须对应已编号的来源片段。');
        const selectedSnippet = snippetsById.get(c.evidenceId);
        return { id: c.id, rationale: c.rationale, quote: selectedSnippet.quote };
    });
    return { responseText: JSON.stringify({ primaryTaskId:value.primaryTaskId, primaryMethodId:value.primaryMethodId, concepts }),
        selections: value.concepts.map(c => ({ conceptId:c.id, evidenceId:c.evidenceId, ...snippetsById.get(c.evidenceId) })) };
}
module.exports = { CONTRACT, buildSourceEvidenceSnippets, fillConceptQuotesFromSnippets };
