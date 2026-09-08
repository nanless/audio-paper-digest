'use strict';

const crypto = require('node:crypto');
const { extractMarkdownTables } = require('../analysis-contract.js');
const READER_DRAFT_ORDER_CONTRACT = 'reader-draft-order-v4';
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

// Selection markers are semantic references to tableBindings[ordinal - 1].
// When every table is a uniquely bound selection marker, a complete marker
// permutation can therefore be normalized without interpreting prose or table
// contents.  Any mixed, malformed, duplicate, missing or inline marker set is
// left untouched for the authoritative parser to reject.
function completeSelectionMarkerPermutation(draft, tables) {
    const sections = Array.isArray(draft?.sections) ? draft.sections : [];
    const bindings = Array.isArray(draft?.tableBindings) ? draft.tableBindings : [];
    const count = bindings.length;
    if (!count || tables.length !== count || tables.some(table => !table.marker)
        || bindings.some((binding, index) => binding?.tableIndex !== index + 1
            || !Object.prototype.hasOwnProperty.call(binding, 'selection'))) return null;
    const allMarkerTokens = sections.flatMap(section =>
        String(section?.body || '').match(/\[\[TABLE_[^\]]*\]\]/g) || []);
    if (allMarkerTokens.length !== count) return null;
    const ordinals = tables.map(table => table.markerIndex);
    if (ordinals.some(ordinal => !Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > count)
        || new Set(ordinals).size !== count) return null;
    for (let ordinal = 1; ordinal <= count; ordinal += 1) {
        const marker = `[[TABLE_${ordinal}]]`;
        const occurrences = sections.reduce((total, section) => total
            + String(section?.body || '').split(marker).length - 1, 0);
        const standaloneBlocks = sections.reduce((total, section) => total
            + String(section?.body || '').split(/\n\s*\n/).filter(block => block.trim() === marker).length, 0);
        if (occurrences !== 1 || standaloneBlocks !== 1) return null;
    }
    return ordinals;
}

// A bridge marker contains no authored prose; its declaration carries the
// explanation.  Once sections and bridge ordinals are canonical, a missing or
// misplaced marker can be placed deterministically only when its declared
// section kind occurs exactly once and every existing bridge marker is an
// exact, unique, standalone token. Misplaced markers are moved only from a
// paragraph-final position, allowing the exact "\n\nMARKER" byte span to be
// transferred without rewriting any non-marker byte.
function normalizeConceptBridgeMarkerLocations(draft) {
    const sections = Array.isArray(draft?.sections) ? draft.sections : [];
    const bridges = Array.isArray(draft?.conceptBridges) ? draft.conceptBridges : [];
    const canonicalSections = sections.every((section, index) => {
        const rank = READER_SECTION_KINDS.indexOf(section?.kind);
        const previousRank = index ? READER_SECTION_KINDS.indexOf(sections[index - 1]?.kind) : -1;
        return rank >= 0 && rank >= previousRank && typeof section?.body === 'string';
    });
    if (!bridges.length || !canonicalSections || bridges.some((bridge, index) => (
        bridge?.marker !== `[[CONCEPT_BRIDGE_${index + 1}]]`
        || !READER_SECTION_KINDS.includes(bridge?.sectionKind)
    ))) return [];
    const declared = new Set(bridges.map(bridge => bridge.marker));
    const rawTokens = sections.flatMap((section, sectionIndex) => [
        ...section.body.matchAll(/\[\[CONCEPT_BRIDGE_[^\]]+\]\]/g)
    ].map(match => ({ marker: match[0], sectionIndex })));
    const tokens = [];
    for (const [sectionIndex, section] of sections.entries()) {
        let fence = null;
        for (const line of section.body.split('\n')) {
            const boundary = line.match(/^ {0,3}(`{3,}|~{3,})/);
            if (boundary) {
                if (!fence) fence = boundary[1];
                else if (boundary[1][0] === fence[0] && boundary[1].length >= fence.length
                    && line.slice(boundary[0].length).trim() === '') fence = null;
                continue;
            }
            if (fence) continue;
            if (/^\[\[CONCEPT_BRIDGE_[^\]]+\]\]$/.test(line)) {
                tokens.push({ marker: line, sectionIndex });
            }
        }
    }
    if (rawTokens.length !== tokens.length || tokens.some(token => !declared.has(token.marker))
        || new Set(tokens.map(token => token.marker)).size !== tokens.length) return [];
    const changes = [];
    for (const [bridgeIndex, bridge] of bridges.entries()) {
        const targetIndexes = sections.flatMap((section, index) =>
            section.kind === bridge.sectionKind ? [index] : []);
        if (targetIndexes.length !== 1) continue;
        const targetIndex = targetIndexes[0];
        const location = tokens.find(token => token.marker === bridge.marker);
        if (!location) {
            const before = sections[targetIndex].body;
            if (!before || /\s$/.test(before)) continue;
            sections[targetIndex].body = `${before}\n\n${bridge.marker}`;
            changes.push({ bridgeIndex, marker: bridge.marker, operation: 'insert',
                fromSectionIndex: null, toSectionIndex: targetIndex,
                fromBodySha256: null, toBodyBeforeSha256: sha(before),
                toBodyAfterSha256: sha(sections[targetIndex].body) });
            continue;
        }
        if (location.sectionIndex === targetIndex) continue;
        const source = sections[location.sectionIndex];
        const span = `\n\n${bridge.marker}`;
        if (!source.body.endsWith(span) || !sections[targetIndex].body
            || /\s$/.test(sections[targetIndex].body)) continue;
        const sourceBefore = source.body;
        const targetBefore = sections[targetIndex].body;
        source.body = source.body.slice(0, -span.length);
        sections[targetIndex].body = targetBefore + span;
        changes.push({ bridgeIndex, marker: bridge.marker, operation: 'move',
            fromSectionIndex: location.sectionIndex, toSectionIndex: targetIndex,
            fromBodyBeforeSha256: sha(sourceBefore), fromBodyAfterSha256: sha(source.body),
            toBodyBeforeSha256: sha(targetBefore), toBodyAfterSha256: sha(sections[targetIndex].body),
            movedSpanSha256: sha(span) });
    }
    return changes;
}

// A draft can contain an extra handwritten table even though its declared
// bindings still describe one uniquely ordered table stream.  Selection
// markers are strong anchors: if there is exactly one order-preserving match
// from bindings to table nodes, and every unmatched node is an ordinary
// Markdown table, those unmatched tables are provably unbound.  Remove only
// that narrow case; multiple possible matches remain parser errors.
function pruneUniquelyUnboundReaderMarkdownTables(input) {
    if (!Array.isArray(input?.sections) || !Array.isArray(input?.tableBindings)) return 0;
    const nodes = locateReaderDraftTables(input);
    const bindings = input.tableBindings;
    if (nodes.length <= bindings.length || bindings.length === 0) return 0;
    const solutions = [];
    const matches = (binding, node) => Object.prototype.hasOwnProperty.call(binding || {}, 'selection')
        ? Boolean(node.marker && node.markerIndex === binding.tableIndex)
        : Boolean(node.table && !node.marker);
    const visit = (bindingIndex, nodeIndex, selected) => {
        if (solutions.length > 1) return;
        if (bindingIndex === bindings.length) {
            solutions.push(selected.slice());
            return;
        }
        for (let index = nodeIndex; index < nodes.length; index += 1) {
            if (!matches(bindings[bindingIndex], nodes[index])) continue;
            selected.push(index);
            visit(bindingIndex + 1, index + 1, selected);
            selected.pop();
        }
    };
    visit(0, 0, []);
    if (solutions.length !== 1) return 0;
    const selected = new Set(solutions[0]);
    const unbound = nodes.map((node, index) => ({ node, index }))
        .filter(item => !selected.has(item.index));
    if (unbound.length !== nodes.length - bindings.length
        || unbound.some(item => item.node.marker || !item.node.table?.markdown)) return 0;

    const draft = structuredClone(input);
    const bySection = new Map();
    for (const { node } of unbound) {
        if (!bySection.has(node.sectionIndex)) bySection.set(node.sectionIndex, []);
        bySection.get(node.sectionIndex).push(node.table.markdown);
    }
    for (const [sectionIndex, markdowns] of bySection) {
        let blocks = String(draft.sections[sectionIndex]?.body || '')
            .split(/\n\s*\n/).map(block => block.trim()).filter(Boolean);
        for (const markdown of markdowns) {
            const indexes = blocks.flatMap((block, index) => block === markdown ? [index] : []);
            if (indexes.length !== 1) return 0;
            const index = indexes[0];
            const removals = new Set([index]);
            const before = blocks[index - 1] || '';
            const after = blocks[index + 1] || '';
            if (before.length <= 800 && /(?:下表|下列(?:宽)?表|以下(?:宽)?表)/.test(before)) {
                removals.add(index - 1);
            }
            if (after.length <= 1200 && /(?:表前|表后|上表|该表|此表)/.test(after)) {
                removals.add(index + 1);
            }
            blocks = blocks.filter((_block, blockIndex) => !removals.has(blockIndex));
        }
        draft.sections[sectionIndex].body = blocks.join('\n\n').trim();
    }
    const remaining = locateReaderDraftTables(draft);
    if (remaining.length !== bindings.length
        || !remaining.every((node, index) => matches(bindings[index], node))) return 0;
    input.sections = draft.sections;
    return unbound.length;
}

function normalizeReaderDraftOrder(input) {
    const draft = structuredClone(input);
    const inputSha256 = sha(input);
    const sections = Array.isArray(draft?.sections) ? draft.sections : [];
    const ranked = sections.map((section, index) => ({ section, index }));
    // Unknown/malformed kinds belong to the parser's shape gate; do not invent
    // an order or alter indices before it reports them.
    const sectionsAreKnown = ranked.every(({ section }) => READER_SECTION_KINDS.includes(section?.kind));
    if (sectionsAreKnown) {
        ranked.sort((a, b) => READER_SECTION_KINDS.indexOf(a.section.kind)
            - READER_SECTION_KINDS.indexOf(b.section.kind) || a.index - b.index);
    }
    const sectionMap = ranked.map(({ index }, canonicalIndex) => ({ rawIndex: index, canonicalIndex }));
    const sectionOrderChanged = sectionMap.some(item => item.rawIndex !== item.canonicalIndex);
    const originalTables = locateReaderDraftTables(draft);
    let tableMap = originalTables.map(table => ({ rawIndex: table.bindingIndex, canonicalIndex: table.bindingIndex,
        rawSectionIndex: table.sectionIndex, canonicalSectionIndex: table.sectionIndex }));
    if (sectionOrderChanged && Array.isArray(draft.tableBindings)) {
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
    } else if (!sectionOrderChanged && sectionsAreKnown && Array.isArray(draft.tableBindings)) {
        const markerOrdinals = completeSelectionMarkerPermutation(draft, originalTables);
        if (markerOrdinals && markerOrdinals.some((ordinal, index) => ordinal !== index + 1)) {
            tableMap = originalTables.map((table, canonicalIndex) => ({
                rawIndex: table.markerIndex - 1,
                canonicalIndex,
                rawSectionIndex: table.sectionIndex,
                canonicalSectionIndex: table.sectionIndex
            }));
            const markerMap = new Map(markerOrdinals.map((ordinal, canonicalIndex) =>
                [ordinal, canonicalIndex + 1]));
            draft.tableBindings = tableMap.map(item => ({
                ...draft.tableBindings[item.rawIndex], tableIndex: item.canonicalIndex + 1
            }));
            for (const section of sections) {
                if (typeof section?.body === 'string') section.body = section.body.replace(/\[\[TABLE_(\d+)\]\]/g,
                    (marker, index) => markerMap.has(Number(index))
                        ? `[[TABLE_${markerMap.get(Number(index))}]]` : marker);
            }
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
    const conceptMarkerLocations = normalizeConceptBridgeMarkerLocations(draft);
    const outputSha256 = sha(draft);
    return { draft, mapping: { contract: READER_DRAFT_ORDER_CONTRACT, inputSha256, outputSha256,
        changed: inputSha256 !== outputSha256, sections: sectionMap, tables: tableMap,
        conceptBridges: bridgeMap, conceptMarkerLocations } };
}

module.exports = { READER_DRAFT_ORDER_CONTRACT, READER_SECTION_KINDS, locateReaderDraftTables,
    completeSelectionMarkerPermutation, pruneUniquelyUnboundReaderMarkdownTables,
    normalizeReaderDraftOrder };
