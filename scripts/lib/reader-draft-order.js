'use strict';

const crypto = require('node:crypto');
const { extractMarkdownTables } = require('../analysis-contract.js');
const READER_DRAFT_ORDER_CONTRACT = 'reader-draft-order-v2';
const READER_SECTION_KINDS = Object.freeze([
    'background', 'related_work', 'problem', 'method_overview', 'component', 'training',
    'experiment_setup', 'result', 'ablation', 'limitation', 'reproduction', 'synthesis'
]);
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Enumerate the actual candidate, not a separately sorted parser copy. The
// line offsets come from the same Markdown extractor used by production.
function locateReaderDraftTables(draft) {
    const found = [];
    for (const [sectionIndex, section] of (draft.sections || []).entries()) {
        const body = String(section?.body || '');
        const entries = extractMarkdownTables(body).map(table => ({ line: table.startLine, table }));
        body.split('\n').forEach((line, index) => {
            const match = line.trim().match(/^\[\[TABLE_(\d+)\]\]$/);
            if (match) entries.push({ line: index, marker: match[0], markerIndex: Number(match[1]) });
        });
        entries.sort((a, b) => a.line - b.line);
        for (const entry of entries) found.push({ ...entry, sectionIndex,
            path: `/sections/${sectionIndex}/body`, tableIndex: found.length + 1, bindingIndex: found.length });
    }
    return found;
}

function normalizeReaderDraftOrder(input) {
    const draft = structuredClone(input);
    const inputSha256 = sha(input);
    const sections = Array.isArray(draft?.sections) ? draft.sections : [];
    const ranked = sections.map((section, index) => ({ section, index }));
    // Unknown/malformed kinds belong to the parser's shape gate; do not invent
    // an order or alter indices before it reports them.
    if (ranked.every(({ section }) => READER_SECTION_KINDS.includes(section?.kind))) {
        ranked.sort((a, b) => READER_SECTION_KINDS.indexOf(a.section.kind)
            - READER_SECTION_KINDS.indexOf(b.section.kind) || a.index - b.index);
    }
    const sectionMap = ranked.map(({ index }, canonicalIndex) => ({ rawIndex: index, canonicalIndex }));
    const changed = sectionMap.some(item => item.rawIndex !== item.canonicalIndex);
    const originalTables = locateReaderDraftTables(draft);
    let tableMap = originalTables.map(table => ({ rawIndex: table.bindingIndex, canonicalIndex: table.bindingIndex,
        rawSectionIndex: table.sectionIndex, canonicalSectionIndex: table.sectionIndex }));
    if (changed && Array.isArray(draft.tableBindings)) {
        const valid = originalTables.length === draft.tableBindings.length
            && draft.tableBindings.every((binding, index) => binding?.tableIndex === index + 1
                && (Object.prototype.hasOwnProperty.call(binding, 'selection')
                    ? originalTables[index]?.markerIndex === index + 1
                        && sections.reduce((n, section) => n + String(section?.body || '').split(`[[TABLE_${index + 1}]]`).length - 1, 0) === 1
                    : !originalTables[index]?.marker));
        if (!valid) {
            const error = new Error('Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格');
            error.code = 'READER_DRAFT_ORDER_AMBIGUOUS';
            error.readerIssues = [
                ...originalTables.map(table => ({ path: table.path, message: error.message })),
                ...draft.tableBindings.map((_binding, index) => ({ path: `/tableBindings/${index}`, message: error.message }))
            ];
            throw error;
        }
        const newSectionIndex = new Map(sectionMap.map(item => [item.rawIndex, item.canonicalIndex]));
        const sortedTables = originalTables.slice().sort((a, b) => newSectionIndex.get(a.sectionIndex)
            - newSectionIndex.get(b.sectionIndex) || a.line - b.line);
        tableMap = sortedTables.map((table, canonicalIndex) => ({ rawIndex: table.bindingIndex, canonicalIndex,
            rawSectionIndex: table.sectionIndex, canonicalSectionIndex: newSectionIndex.get(table.sectionIndex) }));
        const markerMap = new Map(tableMap.filter(item => originalTables[item.rawIndex].marker)
            .map(item => [item.rawIndex + 1, item.canonicalIndex + 1]));
        draft.tableBindings = tableMap.map(item => ({ ...draft.tableBindings[item.rawIndex], tableIndex: item.canonicalIndex + 1 }));
        // One pass prevents 1→2→1 replacement collisions. No prose/table cell
        // is edited: only explicitly bound selection markers are renamed.
        for (const section of sections) {
            if (typeof section?.body === 'string') section.body = section.body.replace(/\[\[TABLE_(\d+)\]\]/g,
                (marker, index) => markerMap.has(Number(index)) ? `[[TABLE_${markerMap.get(Number(index))}]]` : marker);
        }
    }
    if (Array.isArray(draft?.sections)) draft.sections = ranked.map(item => item.section);
    // Bridge markers are stable IDs, not their order of appearance in prose.
    // Only a complete, unambiguous 1..N permutation permits reordering. All
    // malformed sets remain byte-for-byte unchanged for the parser to reject.
    let bridgeMap = [];
    if (Array.isArray(draft?.conceptBridges)) {
        const bridges = draft.conceptBridges.map((bridge, rawIndex) => {
            const match = typeof bridge?.marker === 'string'
                && bridge.marker.match(/^\[\[CONCEPT_BRIDGE_([1-9]\d*)\]\]$/);
            return { bridge, rawIndex, ordinal: match ? Number(match[1]) : null };
        });
        const valid = bridges.every(item => Number.isSafeInteger(item.ordinal)
            && item.ordinal >= 1 && item.ordinal <= bridges.length)
            && new Set(bridges.map(item => item.ordinal)).size === bridges.length;
        if (valid) {
            bridges.sort((a, b) => a.ordinal - b.ordinal);
            bridgeMap = bridges.map(({ bridge, rawIndex }, canonicalIndex) => ({
                rawIndex, canonicalIndex, marker: bridge.marker,
                inputSha256: sha(bridge), outputSha256: sha(bridge)
            }));
            draft.conceptBridges = bridges.map(item => item.bridge);
        }
    }
    const outputSha256 = sha(draft);
    return { draft, mapping: { contract: READER_DRAFT_ORDER_CONTRACT, inputSha256, outputSha256,
        changed: inputSha256 !== outputSha256, sections: sectionMap, tables: tableMap,
        conceptBridges: bridgeMap } };
}

module.exports = { READER_DRAFT_ORDER_CONTRACT, READER_SECTION_KINDS, locateReaderDraftTables, normalizeReaderDraftOrder };
