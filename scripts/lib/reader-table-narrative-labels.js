'use strict';

const crypto = require('node:crypto');
const { maskProtectedMarkdownTableRegions, maskInlineMarkdownCodeSpans } = require('../analysis-contract');
const { locateReaderDraftTables } = require('./reader-draft-order');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

// 只移除紧邻已声明表格的独立标签；标签之后的文字不作任何改写。
function normalizeReaderTableNarrativeLabels(draft) {
    if (!draft || !Array.isArray(draft.sections) || !Array.isArray(draft.tableBindings)) return null;
    const nodes = locateReaderDraftTables(draft);
    const removals = [];
    const beforeDraftSha256 = sha(JSON.stringify(draft));
    for (const [sectionIndex, section] of draft.sections.entries()) {
        if (typeof section?.body !== 'string') continue;
        const body = section.body;
        const lines = body.split('\n');
        const offsets = []; let offset = 0;
        for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
        let visible = maskInlineMarkdownCodeSpans(maskProtectedMarkdownTableRegions(body));
        visible = visible.replace(/\$\$[\s\S]*?\$\$|\$[^\n$]*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|“[^”]*”|「[^」]*」|"[^"\n]*"/g,
            value => value.replace(/[^\n\r]/g, ' '));
        const sectionNodes = nodes.filter(node => node.sectionIndex === sectionIndex).map(node => ({
            ...node, start: offsets[node.line],
            end: offsets[node.table?.endLine ?? node.line] + lines[node.table?.endLine ?? node.line].length
        }));
        const spans = [];
        for (const match of visible.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g)) {
            const start = match.index; const end = start + match[0].length;
            if (sectionNodes.some(node => start <= node.end && end >= node.start)) continue;
            if (/^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s)/.test(match[0])) continue;
            for (const label of match[0].matchAll(/(?:^|[。！？])[ \t]{0,3}(表前说明：|表后解释主要收益与限制：|表后解释：)/g)) {
                const prefix = label[1];
                const position = start + label.index + label[0].length - prefix.length;
                const pre = prefix === '表前说明：';
                const adjacent = sectionNodes.filter(node => pre
                    ? node.start >= end && /^\s*$/.test(body.slice(end, node.start))
                    : node.end <= start && /^\s*$/.test(body.slice(node.end, start)));
                if (adjacent.length !== 1) continue;
                const node = adjacent[0];
                if (draft.tableBindings.filter(binding => binding?.tableIndex === node.tableIndex).length !== 1) continue;
                spans.push({ position, prefix, tableIndex: node.tableIndex });
            }
        }
        for (const span of spans.sort((a, b) => b.position - a.position)) {
            section.body = section.body.slice(0, span.position) + section.body.slice(span.position + span.prefix.length);
            removals.push({ path: `/sections/${sectionIndex}/body`, start: span.position,
                length: span.prefix.length, removedSha256: sha(span.prefix), tableIndex: span.tableIndex });
        }
    }
    return removals.length ? { contract: 'reader-table-narrative-labels-v1', changed: true, beforeDraftSha256,
        afterDraftSha256: sha(JSON.stringify(draft)), removals } : null;
}

module.exports = { normalizeReaderTableNarrativeLabels };
