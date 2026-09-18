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
    const spacingChanges = [];
    for (const [sectionIndex, section] of sections.entries()) {
        const before = section.body;
        // Models sometimes emit several standalone bridge tokens on adjacent
        // lines.  They are still unambiguous marker identities, but Markdown
        // treats the run as one paragraph and the downstream binding gate
        // correctly rejects it.  Insert only the missing blank separator; no
        // authored prose or marker bytes are changed.
        const after = before.replace(
            /(^|\n)([ \t]{0,3}\[\[CONCEPT_BRIDGE_\d+\]\][ \t]*)\n(?=[ \t]{0,3}\[\[CONCEPT_BRIDGE_\d+\]\][ \t]*(?:\n|$))/gm,
            '$1$2\n\n'
        );
        if (after !== before) {
            section.body = after;
            spacingChanges.push({ sectionIndex, operation: 'separate-adjacent',
                bodyBeforeSha256: sha(before), bodyAfterSha256: sha(after) });
        }
    }
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
    const changes = [...spacingChanges];
    for (const [bridgeIndex, bridge] of bridges.entries()) {
        const targetIndexes = sections.flatMap((section, index) =>
            section.kind === bridge.sectionKind ? [index] : []);
        if (targetIndexes.length !== 1) continue;
        const targetIndex = targetIndexes[0];
        const location = tokens.find(token => token.marker === bridge.marker);
        if (!location) {
            const before = sections[targetIndex].body;
            const trailingLineFeeds = before.match(/\n*$/)?.[0] || '';
            const beforeStem = before.slice(0, before.length - trailingLineFeeds.length);
            if (!beforeStem || /[ \t]$/.test(beforeStem)) continue;
            sections[targetIndex].body = `${beforeStem}\n\n${bridge.marker}${trailingLineFeeds}`;
            changes.push({ bridgeIndex, marker: bridge.marker, operation: 'insert',
                fromSectionIndex: null, toSectionIndex: targetIndex,
                fromBodySha256: null, toBodyBeforeSha256: sha(before),
                toBodyAfterSha256: sha(sections[targetIndex].body) });
            continue;
        }
        if (location.sectionIndex === targetIndex) continue;
        const source = sections[location.sectionIndex];
        const span = `\n\n${bridge.marker}`;
        const sourceTrailingLineFeeds = source.body.match(/\n*$/)?.[0] || '';
        const sourceStem = source.body.slice(0, source.body.length - sourceTrailingLineFeeds.length);
        const targetTrailingLineFeeds = sections[targetIndex].body.match(/\n*$/)?.[0] || '';
        const targetStem = sections[targetIndex].body.slice(
            0, sections[targetIndex].body.length - targetTrailingLineFeeds.length
        );
        if (!sourceStem.endsWith(span) || !targetStem || /[ \t]$/.test(targetStem)) continue;
        const sourceBefore = source.body;
        const targetBefore = sections[targetIndex].body;
        source.body = sourceStem.slice(0, -span.length) + sourceTrailingLineFeeds;
        sections[targetIndex].body = targetStem + span + targetTrailingLineFeeds;
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
    // Conference-PDF extraction can flatten a grouped number such as
    // `169,221` in the quote while the authored table contains `169221`.
    // Keep this matcher local to the pruning proof: final source binding still
    // performs the authoritative numeric replay.  The old matcher split the
    // grouped source number into `169` and `221`, making an otherwise provable
    // SounDiT table look unbound.
    const numericTokens = value => String(value || '').match(
        /(?<![A-Za-z0-9])[-+]?(?:\d{1,3}(?:[ ,]\d{3})+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?:\s*(?:k|m|b|samples?|bins?|epochs?|%|dB|kHz|MHz|Hz|GB|MB|KB|ms|s|h))?(?![A-Za-z0-9])/gi
    ) || [];
    const canonicalNumericToken = token => String(token || '').normalize('NFKC')
        .replace(/[\u2212\uFF0D]/g, '-')
        .replace(/[ ,](?=\d{3}(?:\D|$))/g, '')
        .replace(/\s+/g, '').toLowerCase().replace(/%$/, '');
    const sourceQuoteTokens = binding => new Set(
        (Array.isArray(binding?.sourceQuotes) ? binding.sourceQuotes : [])
            .flatMap(numericTokens)
            .map(canonicalNumericToken)
    );
    const tableTokens = node => new Set(
        numericTokens(node?.table?.markdown || '').map(canonicalNumericToken)
    );
    const matches = (binding, node) => Object.prototype.hasOwnProperty.call(binding || {}, 'selection')
        ? Boolean(node.marker && node.markerIndex === binding.tableIndex)
        : Boolean(node.table && !node.marker)
            && (!Array.isArray(binding?.sourceQuotes) || binding.sourceQuotes.length === 0
                || [...sourceQuoteTokens(binding)].every(token => tableTokens(node).has(token)));
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

    // The strict order-preserving proof above remains authoritative for the
    // ordinary case.  A second, still fail-closed proof handles a mixed draft
    // where selection markers and authored quote tables were emitted in a
    // different order.  It is intentionally limited to source_quotes with at
    // least one quantitative overlap.  A generated `来源证据` table is the
    // deterministic recovery output for a quote binding; prefer it over an
    // unbound, richer handwritten duplicate because only the quoted numbers
    // are authenticated at this stage.
    let selectedIndexes = solutions.length === 1 ? solutions[0] : null;
    let usedRelaxedAssignment = false;
    if (!selectedIndexes) {
        const selectionIndexes = new Map();
        const sourceEntries = [];
        for (const [bindingIndex, binding] of bindings.entries()) {
            if (Object.prototype.hasOwnProperty.call(binding || {}, 'selection')) {
                const candidates = nodes.flatMap((node, index) => (
                    node.marker && node.markerIndex === binding.tableIndex ? [index] : []
                ));
                if (candidates.length !== 1) return 0;
                selectionIndexes.set(bindingIndex, candidates[0]);
                continue;
            }
            const sourceTokens = sourceQuoteTokens(binding);
            if (sourceTokens.size === 0) return 0;
            const candidates = nodes.flatMap((node, index) => {
                if (node.marker || !node.table) return [];
                const tableSet = tableTokens(node);
                const overlap = [...sourceTokens].filter(token => tableSet.has(token));
                if (overlap.length === 0) return [];
                const generatedEvidence = /^\|\s*来源证据\s*\|/m.test(node.table.markdown);
                const exact = overlap.length === sourceTokens.size;
                const score = (generatedEvidence ? 1_000_000 : 0)
                    + (exact ? 100_000 : 0)
                    + overlap.length * 1_000
                    + Math.round((overlap.length * 100) / sourceTokens.size);
                return [{ index, score }];
            });
            if (candidates.length === 0) return 0;
            sourceEntries.push({ bindingIndex, candidates });
        }
        let bestScore = -1;
        let best = null;
        let bestCount = 0;
        const visitAssignments = (entryIndex, used, assigned, score) => {
            if (entryIndex === sourceEntries.length) {
                const all = [...selectionIndexes.values(), ...assigned.map(item => item.index)];
                if (new Set(all).size !== bindings.length) return;
                if (score > bestScore) {
                    bestScore = score;
                    best = all;
                    bestCount = 1;
                } else if (score === bestScore) {
                    bestCount += 1;
                }
                return;
            }
            const entry = sourceEntries[entryIndex];
            for (const candidate of entry.candidates) {
                if (used.has(candidate.index) || selectionIndexesHas(candidate.index)) continue;
                used.add(candidate.index);
                assigned.push(candidate);
                visitAssignments(entryIndex + 1, used, assigned, score + candidate.score);
                assigned.pop();
                used.delete(candidate.index);
            }
        };
        const selectionIndexesHas = index => new Set(selectionIndexes.values()).has(index);
        visitAssignments(0, new Set(), [], 0);
        if (bestCount === 1) {
            selectedIndexes = best;
            usedRelaxedAssignment = true;
        }
    }
    if (!selectedIndexes || selectedIndexes.length !== bindings.length) return 0;
    const selected = new Set(selectedIndexes);
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
    if (remaining.length !== bindings.length) return 0;
    // Relaxed mixed-order assignments are deliberately checked by the
    // one-to-one score proof above; their node order is normalized by the
    // subsequent mixed-binding pass.  Reapplying the old positional matcher
    // here would reject the very marker/table permutation this proof handled.
    if (!usedRelaxedAssignment && !remaining.every((node, index) => matches(bindings[index], node))) return 0;
    input.sections = draft.sections;
    return unbound.length;
}

function alignMixedBindingsToCurrentTableNodes(draft, tables) {
    const bindings = Array.isArray(draft?.tableBindings) ? draft.tableBindings : [];
    if (!bindings.length || tables.length !== bindings.length) return false;
    if (!bindings.every((binding, index) => binding?.tableIndex === index + 1)) return false;
    const selectionByOrdinal = new Map();
    const proseBindings = [];
    for (const binding of bindings) {
        if (Object.prototype.hasOwnProperty.call(binding || {}, 'selection')) {
            if (selectionByOrdinal.has(binding.tableIndex)) return false;
            selectionByOrdinal.set(binding.tableIndex, binding);
        } else {
            proseBindings.push(binding);
        }
    }
    if (!selectionByOrdinal.size || !proseBindings.length) return false;
    const markerNodes = tables.filter(table => table.marker);
    const proseNodes = tables.filter(table => !table.marker);
    if (markerNodes.length !== selectionByOrdinal.size || proseNodes.length !== proseBindings.length
        || markerNodes.some(table => !selectionByOrdinal.has(table.markerIndex))) return false;
    for (const table of markerNodes) {
        const body = String(draft.sections?.[table.sectionIndex]?.body || '');
        if (body.split(table.marker).length - 1 !== 1
            || body.split(/\n\s*\n/).filter(block => block.trim() === table.marker).length !== 1) return false;
    }
    let proseIndex = 0;
    const markerMap = new Map();
    draft.tableBindings = tables.map((table, canonicalIndex) => {
        const binding = table.marker
            ? selectionByOrdinal.get(table.markerIndex)
            : proseBindings[proseIndex++];
        if (table.marker) markerMap.set(table.markerIndex, canonicalIndex + 1);
        return { ...binding, tableIndex: canonicalIndex + 1 };
    });
    for (const section of draft.sections) {
        if (typeof section?.body !== 'string') continue;
        section.body = section.body.replace(/\[\[TABLE_(\d+)\]\]/g,
            (marker, ordinal) => markerMap.has(Number(ordinal))
                ? `[[TABLE_${markerMap.get(Number(ordinal))}]]` : marker);
    }
    return true;
}

// Source-quote bindings have no visible ordinal marker.  When a model emits
// the sections in a different order, the old positional check therefore
// treated an otherwise recoverable table/binding permutation as ambiguous.
// Recover it only when every binding has a unique, evidence-backed table
// assignment.  Selection markers remain stronger anchors and are never
// inferred from prose.
function alignSourceQuoteBindingsToCurrentTableNodes(draft, tables) {
    const bindings = Array.isArray(draft?.tableBindings) ? draft.tableBindings : [];
    if (!bindings.length || tables.length !== bindings.length
        || !bindings.every((binding, index) => binding?.tableIndex === index + 1)) return false;
    const markerBindings = new Map();
    const quoteBindings = [];
    for (const binding of bindings) {
        if (Object.prototype.hasOwnProperty.call(binding || {}, 'selection')) {
            if (markerBindings.has(binding.tableIndex)) return false;
            markerBindings.set(binding.tableIndex, binding);
        } else if (binding?.sourceType === 'source_quotes' && Array.isArray(binding.sourceQuotes)) {
            quoteBindings.push(binding);
        } else {
            return false;
        }
    }
    if (!quoteBindings.length) return false;
    const markerNodes = tables.filter(table => table.marker);
    const proseNodes = tables.filter(table => table.table && !table.marker);
    if (markerNodes.length !== markerBindings.size
        || proseNodes.length !== quoteBindings.length
        || markerNodes.some(table => !markerBindings.has(table.markerIndex))) return false;

    const normalize = value => String(value || '').normalize('NFKC').toLowerCase()
        .replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
    const tokens = value => normalize(value).match(/[a-z0-9]+|[\u3400-\u9fff]+/g) || [];
    const numbers = value => normalize(value).match(/(?<![a-z0-9])[-+]?\d+(?:\.\d+)?%?(?![a-z0-9])/g) || [];
    const score = (binding, node) => {
        const tableText = normalize(node.table?.markdown);
        let best = 0;
        for (const raw of binding.sourceQuotes) {
            const quote = normalize(typeof raw === 'string' ? raw : raw?.quote);
            if (!quote) continue;
            if (tableText.includes(quote) || quote.includes(tableText)) best = Math.max(best, 100000);
            const quoteNumbers = new Set(numbers(quote));
            const tableNumbers = new Set(numbers(tableText));
            const numericOverlap = [...quoteNumbers].filter(token => tableNumbers.has(token)).length;
            const quoteTokens = new Set(tokens(quote));
            const tableTokens = new Set(tokens(tableText));
            const wordOverlap = [...quoteTokens].filter(token => token.length > 1 && tableTokens.has(token)).length;
            if (quoteNumbers.size && numericOverlap === quoteNumbers.size) best = Math.max(best, 10000 + numericOverlap * 100 + wordOverlap);
            else if (!quoteNumbers.size && wordOverlap >= 2) best = Math.max(best, wordOverlap * 100);
        }
        return best;
    };
    const candidates = quoteBindings.map(binding => proseNodes.map((node, index) => ({
        index, score: score(binding, node)
    })).filter(candidate => candidate.score > 0));
    if (candidates.some(items => items.length === 0)) return false;
    let bestScore = -1, bestAssignments = [], assignment = [];
    const visit = (bindingIndex, used, total) => {
        if (bindingIndex === quoteBindings.length) {
            if (total > bestScore) {
                bestScore = total;
                bestAssignments = [assignment.slice()];
            } else if (total === bestScore && bestAssignments.length < 2) {
                bestAssignments.push(assignment.slice());
            }
            return;
        }
        for (const candidate of candidates[bindingIndex]) {
            if (used.has(candidate.index)) continue;
            used.add(candidate.index);
            assignment.push(candidate);
            visit(bindingIndex + 1, used, total + candidate.score);
            assignment.pop();
            used.delete(candidate.index);
        }
    };
    visit(0, new Set(), 0);
    if (bestAssignments.length !== 1) return false;
    const assignedByNode = new Map(bestAssignments[0].map((item, index) => [item.index, quoteBindings[index]]));
    let markerMap = new Map();
    draft.tableBindings = tables.map((table, canonicalIndex) => {
        const binding = table.marker
            ? markerBindings.get(table.markerIndex)
            : assignedByNode.get(proseNodes.indexOf(table));
        if (table.marker) markerMap.set(table.markerIndex, canonicalIndex + 1);
        return { ...binding, tableIndex: canonicalIndex + 1 };
    });
    for (const section of draft.sections || []) {
        if (typeof section?.body !== 'string') continue;
        section.body = section.body.replace(/\[\[TABLE_(\d+)\]\]/g,
            (marker, ordinal) => markerMap.has(Number(ordinal))
                ? `[[TABLE_${markerMap.get(Number(ordinal))}]]` : marker);
    }
    return true;
}

// Trailing source_quotes declarations with no visible table nodes carry no
// reader-facing content and cannot be compiled. Remove only that trailing
// suffix when the entire visible stream is ordinary
// Markdown, all earlier bindings are sequential source_quotes, and no TABLE
// marker exists anywhere. The full parser still replays every remaining quote.
function pruneTrailingUnboundSourceQuoteBindings(draft, tables) {
    const bindings = Array.isArray(draft?.tableBindings) ? draft.tableBindings : [];
    if (!Array.isArray(draft?.sections) || bindings.length <= tables.length
        || tables.length < 1 || tables.some(table => table.marker)
        || draft.sections.some(section => /\[\[TABLE_\d+\]\]/.test(String(section?.body || '')))) return false;
    if (!bindings.every((binding, index) => binding?.tableIndex === index + 1
        && !Object.prototype.hasOwnProperty.call(binding, 'selection')
        && binding?.sourceType === 'source_quotes'
        && Array.isArray(binding.sourceQuotes))) return false;
    draft.tableBindings = bindings.slice(0, tables.length);
    return true;
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
    let originalTables = locateReaderDraftTables(draft);
    pruneTrailingUnboundSourceQuoteBindings(draft, originalTables);
    let tableMap = originalTables.map(table => ({ rawIndex: table.bindingIndex, canonicalIndex: table.bindingIndex,
        rawSectionIndex: table.sectionIndex, canonicalSectionIndex: table.sectionIndex }));
    if (sectionOrderChanged && Array.isArray(draft.tableBindings)) {
        // Prefer authenticated source-quote evidence over positional order.
        // This also handles the common case where the positional shape looks
        // valid but each quote binding belongs to a different raw section.
        const sourceQuoteAligned = alignSourceQuoteBindingsToCurrentTableNodes(draft, originalTables);
        if (sourceQuoteAligned) originalTables = locateReaderDraftTables(draft);
        let valid = originalTables.length === draft.tableBindings.length
            && draft.tableBindings.every((binding, index) => binding?.tableIndex === index + 1
                && (Object.prototype.hasOwnProperty.call(binding, 'selection')
                    ? originalTables[index]?.markerIndex === index + 1
                        && sections.reduce((n, section) => n + String(section?.body || '').split(`[[TABLE_${index + 1}]]`).length - 1, 0) === 1
                    : !originalTables[index]?.marker));
        // A mixed stream can be unambiguously realigned before section sorting:
        // selection bindings are anchored by their unique TABLE ordinal, while
        // source-quote/artifact bindings keep their existing relative order.
        // The downstream source-binding parser still replays every cell/quote.
        if (!valid && alignMixedBindingsToCurrentTableNodes(draft, originalTables)) {
            originalTables = locateReaderDraftTables(draft);
            valid = originalTables.length === draft.tableBindings.length
                && draft.tableBindings.every((binding, index) => binding?.tableIndex === index + 1
                    && (Object.prototype.hasOwnProperty.call(binding, 'selection')
                        ? originalTables[index]?.markerIndex === index + 1
                            && sections.reduce((n, section) => n
                                + String(section?.body || '').split(`[[TABLE_${index + 1}]]`).length - 1, 0) === 1
                        : !originalTables[index]?.marker));
        }
        if (!valid && alignSourceQuoteBindingsToCurrentTableNodes(draft, originalTables)) {
            originalTables = locateReaderDraftTables(draft);
            valid = originalTables.length === draft.tableBindings.length
                && draft.tableBindings.every((binding, index) => binding?.tableIndex === index + 1
                    && (Object.prototype.hasOwnProperty.call(binding, 'selection')
                        ? originalTables[index]?.markerIndex === index + 1
                            && sections.reduce((n, section) => n
                                + String(section?.body || '').split(`[[TABLE_${index + 1}]]`).length - 1, 0) === 1
                        : !originalTables[index]?.marker));
        }
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
        const mixedAligned = alignMixedBindingsToCurrentTableNodes(draft, originalTables);
        if (mixedAligned) originalTables = locateReaderDraftTables(draft);
        const markerOrdinals = mixedAligned ? null : completeSelectionMarkerPermutation(draft, originalTables);
        if (!mixedAligned && markerOrdinals && markerOrdinals.some((ordinal, index) => ordinal !== index + 1)) {
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
    alignMixedBindingsToCurrentTableNodes, alignSourceQuoteBindingsToCurrentTableNodes,
    pruneTrailingUnboundSourceQuoteBindings,
    normalizeReaderDraftOrder };
