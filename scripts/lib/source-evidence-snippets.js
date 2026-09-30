'use strict';
const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const CONTRACT = 'sealed-source-evidence-snippets-v1';

function buildSnippets(source, { maxChars = 50000, maxSnippetChars = 800 } = {}) {
    if (typeof source !== 'string' || source.length < 100 || !Number.isInteger(maxChars) || maxChars < 1000
        || !Number.isInteger(maxSnippetChars) || maxSnippetChars < 100 || maxSnippetChars > 1000) throw new Error('bounded sealed source text required');
    const chunks = []; let offset = 0;
    while (offset < source.length) {
        let end = Math.min(source.length, offset + maxSnippetChars);
        if (end < source.length) {
            const paragraph = source.lastIndexOf('\n\n', end), sentence = source.lastIndexOf('. ', end);
            if (paragraph > offset + maxSnippetChars / 3) end = paragraph;
            else if (sentence > offset + maxSnippetChars / 2) end = sentence + 1;
        }
        if (end <= offset) throw new Error('snippet selector made no progress');
        const quote = source.slice(offset, end);
        if (quote.trim().length >= 20) chunks.push({ id: 's' + String(chunks.length + 1).padStart(5, '0'), quote,
            quoteStart: offset, quoteEnd: end, offsetUnit: 'utf16-code-unit', quoteSha256: digest(quote) });
        offset = end;
    }
    let selected = chunks;
    if (source.length > maxChars) {
        const count = Math.floor(maxChars / maxSnippetChars), chosen = new Set();
        // Balanced coverage keeps the beginning, methods/body and conclusion;
        // all selected spans remain literal contiguous bytes of the source.
        for (let i = 0; i < count; i++) chosen.add(Math.round(i * (chunks.length - 1) / (count - 1)));
        selected = [...chosen].sort((a, b) => a - b).map(i => chunks[i]);
    }
    const projection = selected.map(s => `[${s.id}; source UTF16 ${s.quoteStart}:${s.quoteEnd}]\n${s.quote}`).join('\n\n');
    return { contract: CONTRACT, sourceTextSha256: digest(source), offsetUnit: 'utf16-code-unit',
        sourceChars: source.length, evidenceChars: selected.reduce((n,s) => n + s.quote.length,0),
        sampling: selected.length === chunks.length ? 'full-source' : 'balanced-spans',
        snippets: selected, projection, evidenceSha256: digest(projection) };
}

function injectEvidence(raw, bundle) {
    const text = String(raw).trim();
    if (!text.startsWith('{') || !text.endsWith('}')) throw new Error('unfenced JSON required');
    for (const key of ['primaryTaskId','primaryMethodId','concepts']) if ((text.match(new RegExp(`"${key}"\\s*:`, 'g')) || []).length !== 1) throw new Error('duplicate or absent selection key');
    const value = JSON.parse(text);
    if (Object.keys(value).sort().join(',') !== 'concepts,primaryMethodId,primaryTaskId' || !Array.isArray(value.concepts)) throw new Error('snippet selection schema invalid');
    const byId = new Map(bundle.snippets.map(s => [s.id,s]));
    const concepts = value.concepts.map(c => {
        if (!c || Object.keys(c).sort().join(',') !== 'evidenceId,id,rationale' || !byId.has(c.evidenceId)) throw new Error('evidence ID must name a sealed source span');
        const span = byId.get(c.evidenceId);
        return { id: c.id, rationale: c.rationale, quote: span.quote };
    });
    return { responseText: JSON.stringify({ primaryTaskId:value.primaryTaskId, primaryMethodId:value.primaryMethodId, concepts }),
        selections: value.concepts.map(c => ({ conceptId:c.id, evidenceId:c.evidenceId, ...byId.get(c.evidenceId) })) };
}
module.exports = { CONTRACT, buildSnippets, injectEvidence };
