'use strict';

const crypto = require('node:crypto');
const { extractMarkdownTables, maskProtectedMarkdownTableRegions, maskInlineMarkdownCodeSpans } = require('../analysis-contract.js');
const READER_DRAFT_ORDER_CONTRACT = 'reader-draft-order-v4';
const TABLE_BINDING_ORDER_ISSUE_CODE = 'reader_table_binding_order_ambiguous';
const READER_SECTION_KINDS = Object.freeze([
    'background', 'related_work', 'problem', 'method_overview', 'component', 'training',
    'experiment_setup', 'result', 'ablation', 'limitation', 'reproduction', 'synthesis'
]);
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// 枚举的就是真正的候选，而不是另做一份排过序的解析器副本。行偏移
// 来自生产环境同一个 Markdown 提取器。
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

// 表格选择标记对应 tableBindings[ordinal - 1] 中的记录。每张表都使用
// 唯一且完整的选择标记时，可以统一这些标记的序号，不需解读正文或表格内容。
// 混用、格式错误、重复、缺失或嵌在正文行内的标记均不处理，交给后续解析检查报错。
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

// 概念组合解释标记不包含作者正文，解释另存于对应声明。小节和标记序号
// 已符合规则时，仅在目标小节类型唯一、现有标记格式正确且唯一独立成行的
// 条件下补入或移动标记。移动只从段落末尾取走 "\n\nMARKER"，
// 原样放入目标小节，不改其他正文。
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
        // 模型有时把不同的概念组合解释标记放在相邻行，虽各自唯一，Markdown
        // 仍会将它们解析为同一段，导致后续来源对应检查拒绝。这里只补空行，
        // 不改作者正文或标记本身。
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

// 草稿里可能多出一张手写的表，而它声明的绑定仍然只描述一条唯一有序的
// 表格串。选择标记可确定对应表格：如果保持先后顺序的匹配只有
// 一种，且未匹配项全部是普通 Markdown 表，就能判断这些表是
// 未绑定的。只处理这一种窄情况；存在多种可能的匹配仍然算解析错误。
function pruneUniquelyUnboundReaderMarkdownTables(input) {
    if (!Array.isArray(input?.sections) || !Array.isArray(input?.tableBindings)) return 0;
    const nodes = locateReaderDraftTables(input);
    const bindings = input.tableBindings;
    if (nodes.length <= bindings.length || bindings.length === 0) return 0;
    const solutions = [];
    // 会议 PDF 引文中的千位分隔数字（如 `169,221`）可能与草稿表中的 `169221` 写法不同。
    // 这里统一数字写法，只用于判断哪些表没有匹配的来源记录；
    // 最终接受正文前仍须核对表中数字与来源。旧匹配会把 `169,221` 拆成两个数字，
    // 导致实际相同的数字无法匹配，把 SounDiT 的表误判为没有来源记录。
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

    // 先按严格顺序匹配；没有唯一匹配时，再检查选择标记与引文表顺序不同的草稿。
    // 第二种匹配也要求唯一结果，否则不删除表格；仅检查与来源引文至少有一个数字相同的表。
    // 根据绑定引文生成的
    // `来源证据` 表优先于未绑定、内容更丰富的手写重复表，
    // 因为在这个阶段只有被引用的数字经过了核验。
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
    // 混排情况已经按上面的匹配分值选出唯一的表格对应结果；
    // 后续会按当前表格位置重新排列绑定并更新选择标记序号。这里不再要求原位置顺序，
    // 否则会拒绝刚刚按数字匹配成功的混排结果；来源事实仍由后续正文检查核验。
    if (!usedRelaxedAssignment && !remaining.every((node, index) => matches(bindings[index], node))) return 0;
    input.sections = draft.sections;
    return unbound.length;
}

function alignMixedBindingsToCurrentTableNodes(draft, tables, allowCompleteDeclarations = false) {
    const bindings = Array.isArray(draft?.tableBindings) ? draft.tableBindings : [];
    if (!bindings.length || tables.length !== bindings.length) return false;
    if (!bindings.every((binding, index) => binding?.tableIndex === index + 1)) return false;
    const selectionByOrdinal = new Map();
    const proseBindings = [];
    for (const binding of bindings) {
        if (Object.prototype.hasOwnProperty.call(binding || {}, 'selection')
            || allowCompleteDeclarations && Object.prototype.hasOwnProperty.call(binding || {}, 'completeTable')) {
            if (selectionByOrdinal.has(binding.tableIndex)) return false;
            selectionByOrdinal.set(binding.tableIndex, binding);
        } else {
            proseBindings.push(binding);
        }
    }
    if (!selectionByOrdinal.size || !allowCompleteDeclarations && !proseBindings.length) return false;
    const markerNodes = tables.filter(table => table.marker);
    const proseNodes = tables.filter(table => !table.marker);
    if (new Set(markerNodes.map(node => node.markerIndex)).size !== markerNodes.length
        || markerNodes.length !== selectionByOrdinal.size || proseNodes.length !== proseBindings.length
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

// 来源引文表和结构化原表的绑定没有可见序号。模型改变小节顺序后，
// 必须找到唯一的表格对应关系才能重新排列。结构化原表要求每个展示单元格
// 都与已核验的原表 DOM 单元格一致；带选择标记的表仍按显式序号对应，不从正文猜测。
function alignSourceQuoteBindingsToCurrentTableNodes(draft, tables, structuredArtifacts = null) {
    const bindings = Array.isArray(draft?.tableBindings) ? draft.tableBindings : [];
    if (!bindings.length || tables.length !== bindings.length
        || !bindings.every((binding, index) => binding?.tableIndex === index + 1)) return false;
    const markerBindings = new Map();
    const evidenceBindings = [];
    for (const binding of bindings) {
        if (Object.prototype.hasOwnProperty.call(binding || {}, 'selection')) {
            if (markerBindings.has(binding.tableIndex)) return false;
            markerBindings.set(binding.tableIndex, binding);
        } else if (binding?.sourceType === 'source_quotes' && Array.isArray(binding.sourceQuotes)) {
            evidenceBindings.push({ binding, kind: 'source_quotes' });
        } else if (binding?.sourceType === 'artifact_table'
            && Number.isInteger(binding.sourceTableOrdinal)
            && Array.isArray(binding.cellBindings) && binding.cellBindings.length > 0
            && Array.isArray(binding.sourceQuotes) && binding.sourceQuotes.length === 0) {
            const sourceTable = (structuredArtifacts?.tables || []).find(table => (
                table?.ordinal === binding.sourceTableOrdinal
                && table?.recoveryStatus === 'complete'
                && /^[a-f0-9]{64}$/.test(String(table?.sourceDomSha256 || ''))
            ));
            if (!sourceTable || !Array.isArray(sourceTable.cells)) return false;
            evidenceBindings.push({ binding, kind: 'artifact_table', sourceTable });
        } else {
            return false;
        }
    }
    if (!evidenceBindings.length) return false;
    const markerNodes = tables.filter(table => table.marker);
    const proseNodes = tables.filter(table => table.table && !table.marker);
    if (markerNodes.length !== markerBindings.size
        || proseNodes.length !== evidenceBindings.length
        || markerNodes.some(table => !markerBindings.has(table.markerIndex))) return false;

    const normalize = value => String(value || '').normalize('NFKC').toLowerCase()
        .replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
    const tokens = value => normalize(value).match(/[a-z0-9]+|[\u3400-\u9fff]+/g) || [];
    const numbers = value => normalize(value).match(/(?<![a-z0-9])[-+]?\d+(?:\.\d+)?%?(?![a-z0-9])/g) || [];
    const score = (binding, node, kind, sourceTable = null) => {
        if (kind === 'artifact_table') {
            const renderedRows = [node.table?.header, ...(node.table?.rows || [])];
            const seenCells = new Set();
            const exactCells = binding.cellBindings.every(cell => {
                const rowIndex = cell?.renderedRow;
                const columnIndex = cell?.renderedColumn;
                const sourceRow = cell?.sourceRow;
                const sourceColumn = cell?.sourceColumn;
                const key = `${rowIndex}:${columnIndex}`;
                const row = renderedRows[rowIndex];
                const sourceCell = sourceTable.cells.find(source => (
                    Number.isInteger(source?.row) && Number.isInteger(source?.column)
                    && Number.isInteger(sourceRow) && Number.isInteger(sourceColumn)
                    && sourceRow >= source.row
                    && sourceRow < source.row + Number(source.rowspan || 1)
                    && sourceColumn >= source.column
                    && sourceColumn < source.column + Number(source.colspan || 1)
                ));
                if (!Number.isInteger(rowIndex) || !Number.isInteger(columnIndex)
                    || rowIndex < 0 || columnIndex < 0
                    || !Number.isInteger(sourceRow) || !Number.isInteger(sourceColumn)
                    || !Array.isArray(row) || typeof row[columnIndex] !== 'string'
                    || typeof sourceCell?.text !== 'string'
                    || seenCells.has(key)
                    || ![sourceCell.text, require('./reader-table-pdf-evidence').displayCell(sourceTable, sourceRow, sourceColumn)]
                        .some(value => normalize(value.replace(/<br\s*\/?>/gi, ' ').replace(/[％]/g, '%'))
                            === normalize(row[columnIndex].replace(/<br\s*\/?>/gi, ' ').replace(/[％]/g, '%')))) {
                    return false;
                }
                seenCells.add(key);
                return true;
            });
            const expectedCellCount = renderedRows.reduce((count, row) => (
                count + (Array.isArray(row) ? row.length : 0)
            ), 0);
            return exactCells && binding.cellBindings.length === expectedCellCount
                && seenCells.size === expectedCellCount ? 1000000 : 0;
        }
        const tableText = normalize(node.table?.markdown);
        let best = 0;
        for (const raw of binding.sourceQuotes) {
            const quote = normalize(typeof raw === 'string' ? raw : raw?.quote);
            if (!quote) continue;
            if (tableText.includes(quote) || quote.includes(tableText)) best = Math.max(best, 100000);
            // 明确的来源表图编号只用于定位引文，不是当前表格必须展示的观测值。
            // 原引文不改；表格结果数字和最终逐字来源核验仍按原规则检查。
            const quoteData = quote.replace(/(?<![a-z0-9])(?:table|figure)\s*\d+(?![a-z0-9_.%])|(?:表|图)\s*\d+(?![a-z0-9_.%])/gu,
                match => ' '.repeat(match.length));
            const quoteNumbers = new Set(numbers(quoteData));
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
    const candidates = evidenceBindings.map(({ binding, kind, sourceTable }) => proseNodes.map((node, index) => ({
        index, score: score(binding, node, kind, sourceTable)
    })).filter(candidate => candidate.score > 0));
    if (candidates.some(items => items.length === 0)) return false;
    // 为所有表格选择总匹配分值最高的一一对应关系（最大权匹配）。
    // 旧实现枚举全部排列，12 张相似小表就有 12! 种；这里使用多项式时间算法，
    // 再逐个排除已选对应关系，检查最高分结果是否唯一。
    const size = evidenceBindings.length;
    const weights = candidates.map(items => new Map(items.map(item => [item.index, item.score])));
    const maximumScore = candidates.reduce((maximum, items) =>
        items.reduce((current, item) => Math.max(current, item.score), maximum), 0);
    const forbiddenCost = (maximumScore + 1) * (size + 1);
    const solve = (excludedRow = -1, excludedColumn = -1) => {
        const rowPotential = Array(size + 1).fill(0), columnPotential = Array(size + 1).fill(0);
        const matchedRow = Array(size + 1).fill(0), previousColumn = Array(size + 1).fill(0);
        for (let row = 1; row <= size; row++) {
            matchedRow[0] = row;
            let column = 0;
            const distance = Array(size + 1).fill(Infinity), visited = Array(size + 1).fill(false);
            do {
                visited[column] = true;
                const activeRow = matchedRow[column];
                let delta = Infinity, nextColumn = 0;
                for (let candidateColumn = 1; candidateColumn <= size; candidateColumn++) {
                    if (visited[candidateColumn]) continue;
                    const weight = weights[activeRow - 1].get(candidateColumn - 1);
                    const excluded = activeRow - 1 === excludedRow && candidateColumn - 1 === excludedColumn;
                    const cost = weight === undefined || excluded ? forbiddenCost : -weight;
                    const reduced = cost - rowPotential[activeRow] - columnPotential[candidateColumn];
                    if (reduced < distance[candidateColumn]) {
                        distance[candidateColumn] = reduced;
                        previousColumn[candidateColumn] = column;
                    }
                    if (distance[candidateColumn] < delta) {
                        delta = distance[candidateColumn];
                        nextColumn = candidateColumn;
                    }
                }
                for (let candidateColumn = 0; candidateColumn <= size; candidateColumn++) {
                    if (visited[candidateColumn]) {
                        rowPotential[matchedRow[candidateColumn]] += delta;
                        columnPotential[candidateColumn] -= delta;
                    } else distance[candidateColumn] -= delta;
                }
                column = nextColumn;
            } while (matchedRow[column] !== 0);
            do {
                const previous = previousColumn[column];
                matchedRow[column] = matchedRow[previous];
                column = previous;
            } while (column !== 0);
        }
        const assignment = Array(size);
        let score = 0;
        for (let column = 1; column <= size; column++) {
            const row = matchedRow[column] - 1, index = column - 1;
            const weight = weights[row]?.get(index);
            if (weight === undefined || (row === excludedRow && index === excludedColumn)) return null;
            assignment[row] = { index, score: weight };
            score += weight;
        }
        return { assignment, score };
    };
    const best = solve();
    if (!best) return false;
    // 另一组完整的最高分匹配至少会改变一个对应关系；逐个排除当前对应关系再重算，
    // 若仍能得到相同总分，就拒绝这次重新排列，不能把先找到的结果当作唯一来源对应。
    for (let row = 0; row < size; row++) {
        const alternative = solve(row, best.assignment[row].index);
        if (alternative?.score === best.score) return false;
    }
    const assignedByNode = new Map(best.assignment.map((item, index) => [
        item.index, evidenceBindings[index].binding
    ]));
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

// 没有展示表格与之对应的末尾 source_quotes 记录不会生成读者可见内容。
// 只有所有可见表格均为普通 Markdown、全部绑定按连续序号使用 source_quotes，
// 且正文没有 TABLE 选择标记时，才删去这些多余的末尾记录。
// 完整解析器仍须逐条核对保留的来源引文。
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

// 只补齐完整原表的确定性展示。这里不创建selection、不推断字段或数值；
// 完整来源SHA以及后续逐格绑定、粘贴和正文检查仍由正式解析器执行。
function restoreCompleteArtifactTableMarkers(draft, artifacts) {
    // 恢复身份迁移尚未传入来源，留给带封存来源的正式解析器校验和恢复。
    if (artifacts === null || artifacts === undefined) return;
    if (!Array.isArray(draft?.sections) || !Array.isArray(draft?.tableBindings)) return;
    for (const [index, binding] of draft.tableBindings.entries()) {
        const marker = `[[TABLE_${binding?.tableIndex}]]`;
        const matching = draft.sections.filter(section => typeof section?.body === 'string'
            && section.body.includes(marker));
        if (!matching.length || binding?.sourceType !== 'artifact_table'
            || Object.prototype.hasOwnProperty.call(binding, 'selection')) continue;
        const fail = (reason = '坐标、来源或独占标记不完整') => {
            const error = new Error(`完整原表 ${marker} 的${reason}，不能自动恢复；tableBindings[${index}] 应核对 sourceTableOrdinal=${binding.sourceTableOrdinal}，只修对应来源记录和正文，不补造原格。`);
            error.readerIssues = [{ path: `/tableBindings/${index}`, message: error.message }];
            throw error;
        };
        if (Object.keys(binding).sort().join(',') !== 'cellBindings,sourceQuotes,sourceTableOrdinal,sourceType,tableIndex'
            || binding.tableIndex !== index + 1 || !Number.isInteger(binding.sourceTableOrdinal)
            || !Array.isArray(binding.sourceQuotes) || binding.sourceQuotes.length !== 0
            || !Array.isArray(binding.cellBindings) || matching.length !== 1
            || matching[0].body.split(marker).length !== 2
            || !matching[0].body.split(/\n\s*\n/).some(block => block.trim() === marker)) fail();
        const candidates = (artifacts?.tables || []).filter(t => t?.ordinal === binding.sourceTableOrdinal);
        if (candidates.length !== 1) fail();
        const source = candidates[0], matrix = source.matrix;
        const completeEligibility = require('./reader-tables').assessReaderCompleteTableEligibility(source);
        if (!completeEligibility.eligible) {
            const error = require('./reader-tables').readerSourceTableError(binding.tableIndex, source, completeEligibility);
            const sectionIndex = draft.sections.indexOf(matching[0]);
            error.readerIssues.push({ ...error.readerIssues[0], path: `/sections/${sectionIndex}/body`,
                bindingPath: `/tableBindings/${index}` });
            throw error;
        }
        const validSha = value => /^[a-f0-9]{64}$/.test(String(value || ''));
        if (source.recoveryStatus !== 'complete' || !validSha(source.sourceDomSha256)
            || !Array.isArray(matrix) || matrix.length < 2 || !Array.isArray(matrix[0])) fail();
        const width = matrix[0].length;
        if (width < 2 || matrix.some(row => !Array.isArray(row) || row.length !== width)
            || binding.cellBindings.length !== matrix.length * width) fail();
        const seen = new Set();
        for (const cell of binding.cellBindings) {
            if (!cell || Object.keys(cell).sort().join(',') !== 'renderedColumn,renderedRow,sourceColumn,sourceRow'
                || !Number.isInteger(cell.renderedRow) || !Number.isInteger(cell.renderedColumn)
                || cell.renderedRow !== cell.sourceRow || cell.renderedColumn !== cell.sourceColumn) fail();
            const row = cell.sourceRow, column = cell.sourceColumn, key = `${row}:${column}`;
            const text = matrix[row]?.[column];
            const dom = (source.cells || []).filter(item => Number.isInteger(item?.row)
                && Number.isInteger(item?.column) && row >= item.row
                && row < item.row + Number(item.rowspan || 1) && column >= item.column
                && column < item.column + Number(item.colspan || 1));
            if (dom.length !== 1) fail(`来源坐标 row=${row},column=${column} 对应 ${dom.length} 个原始单元格`);
            if (seen.has(key) || typeof text !== 'string'
                || !validSha(dom[0].sourceDomSha256) || dom[0].text !== text
                || /[|\r\n]|\[\[|<\/?[A-Za-z!]|!?\[[^\]]*\]\(/.test(text)
                || /^\s*:?-{3,}:?\s*$/.test(text)) fail();
            seen.add(key);
        }
        const nodes = locateReaderDraftTables(draft);
        const position = nodes.findIndex(node => node.marker === marker);
        if (position !== index || nodes.filter(node => node.marker === marker).length !== 1) fail();
        const line = cells => `| ${cells.join(' | ')} |`;
        const displayMatrix = require('./reader-table-pdf-evidence').displayMatrix(source)
            .map(row => row.map(require('./reader-source-display').normalizeReaderSourceDisplayArtifacts));
        const markdown = [line(displayMatrix[0]), line(displayMatrix[0].map(() => '---')),
            ...displayMatrix.slice(1).map(line)].join('\n');
        const parsed = extractMarkdownTables(markdown);
        if (parsed.length !== 1 || JSON.stringify([parsed[0].header, ...parsed[0].rows]) !== JSON.stringify(displayMatrix)) fail();
        matching[0].body = matching[0].body.replace(marker, markdown);
    }
}

// 新输入模式只声明整表身份，不接受模型填写单元格或选择子集。
// 最终仍转换为已有 artifact_table 协议，再执行完整原表恢复和来源核验。
function compileCompleteReaderTableDeclarations(draft, artifacts) {
    if (artifacts === null || artifacts === undefined) return;
    if (!Array.isArray(draft?.tableBindings)) return;
    draft.tableBindings = draft.tableBindings.map((binding, index) => {
        if (!binding || !Object.prototype.hasOwnProperty.call(binding, 'completeTable')) return binding;
        const fail = () => { throw new Error('完整原表声明的字段或原表身份非法，不能推断表格'); };
        // 某些模型显式重复写出模式名；它只是一条冗余判别标签，
        // 不提供来源或单元格证据。只接受与声明一致的精确标签，
        // 后面仍核验唯一标记、完整原矩阵及每个 DOM 单元格。
        const fields = Object.keys(binding).sort().join(',');
        const redundantModeLabel = fields === 'completeTable,sourceType,tableIndex'
            && binding.sourceType === 'completeTable';
        if ((fields !== 'completeTable,tableIndex' && !redundantModeLabel)
            || binding.tableIndex !== index + 1
            || !binding.completeTable || typeof binding.completeTable !== 'object'
            || Array.isArray(binding.completeTable)
            || Object.keys(binding.completeTable).join(',') !== 'sourceTableOrdinal'
            || !Number.isInteger(binding.completeTable.sourceTableOrdinal)) fail();
        const marker = `[[TABLE_${binding.tableIndex}]]`;
        const matching = (draft.sections || []).filter(section => typeof section?.body === 'string'
            && section.body.includes(marker));
        if (matching.length !== 1 || matching[0].body.split(marker).length !== 2
            || !matching[0].body.split(/\n\s*\n/).some(block => block.trim() === marker)) fail();
        try {
            return require('./reader-tables').renderReaderCompleteTable(binding, artifacts).binding;
        } catch (error) {
            if (error.code === 'READER_SOURCE_TABLE_UNRENDERABLE') {
                const sectionIndex = (draft.sections || []).indexOf(matching[0]);
                error.readerIssues.push({ ...error.readerIssues[0], path: `/sections/${sectionIndex}/body`,
                    bindingPath: `/tableBindings/${index}` });
            }
            throw error;
        }
    });
}

// 只读取完整正文后唯一明确的续段字符串；原始草稿仍由恢复档案保存。
// 未知字段、非文字或标记的放置含义不能由程序猜测。
function normalizeReaderBodyContinuations(draft) {
    const requiredKeys = ['version', 'readerTitle', 'oneSentenceThesis', 'conceptBridges',
        'figurePlacements', 'sections', 'tableBindings', 'formulaBindings'];
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)
        || Object.keys(draft).length !== requiredKeys.length
        || requiredKeys.some(key => !Object.hasOwn(draft, key))
        || ![2, 3].includes(draft.version)
        || typeof draft.readerTitle !== 'string' || typeof draft.oneSentenceThesis !== 'string'
        || ['sections', 'conceptBridges', 'figurePlacements', 'tableBindings', 'formulaBindings']
            .some(key => !Array.isArray(draft[key]))) return;
    for (const section of draft.sections) {
        if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
        const keys = Object.keys(section);
        const aliases = keys.filter(key => key === 'body2' || key === 'body_after');
        if (aliases.length !== 1 || keys.length !== 4
            || ['kind', 'heading', 'body'].some(key => !Object.hasOwn(section, key))
            || !READER_SECTION_KINDS.includes(section.kind)
            || typeof section.heading !== 'string' || typeof section.body !== 'string'
            || !section.body.trim()) continue;
        const alias = aliases[0];
        const continuation = section[alias];
        if (keys.indexOf('body') > keys.indexOf(alias)
            || typeof continuation !== 'string' || !continuation.trim()
            || /\[\[(?:TABLE|FIGURE|FORMULA|CONCEPT_BRIDGE)_[^\]]*\]\]/.test(continuation)) continue;
        section.body += '\n\n' + continuation;
        delete section[alias];
    }
}

function normalizeReaderDraftOrder(input, { structuredArtifacts = null } = {}) {
    return require('./reader-table-pdf-evidence').withArtifacts(structuredArtifacts, structuredArtifacts?.paperId,
        () => normalizeReaderDraftOrderUnchecked(input, { structuredArtifacts }));
}
function normalizeReaderDraftOrderUnchecked(input, { structuredArtifacts = null } = {}) {
    const draft = structuredClone(input);
    const inputSha256 = sha(input);
    normalizeReaderBodyContinuations(draft);
    normalizeUniqueRenderedReaderSelections(draft, structuredArtifacts);
    for (const [index, section] of (Array.isArray(draft?.sections) ? draft.sections : []).entries()) {
        if (typeof section?.body !== 'string') continue;
        const visible = maskInlineMarkdownCodeSpans(maskProtectedMarkdownTableRegions(section.body));
        for (const match of section.body.matchAll(/\[\[TABLE_\d+\]\]/g)) {
            if (visible.slice(match.index, match.index + match[0].length) !== match[0]) {
                throw new Error(`sections[${index}].body 的 ${match[0]} 位于注释、代码或引用中，不能作为正文表格展示`);
            }
        }
    }
    // 完整原表的标记已明确指定来源；先按唯一标记顺序排列声明，
    // 再逐格核验并展开，避免合法表格顺序不同就进入反复模型修复。
    if (draft.tableBindings?.some(binding => Object.hasOwn(binding || {}, 'completeTable'))) {
        alignMixedBindingsToCurrentTableNodes(draft, locateReaderDraftTables(draft), true);
    }
    try {
        compileCompleteReaderTableDeclarations(draft, structuredArtifacts);
        restoreCompleteArtifactTableMarkers(draft, structuredArtifacts);
    } catch (error) {
        if (error.code === 'READER_SOURCE_TABLE_UNRENDERABLE') {
            // Indices may already have been deterministically aligned to the
            // visible stream. Keep the failed draft in that exact index space.
            error.normalizationInputSha256 = inputSha256;
            error.blockedNormalizationDraft = structuredClone(draft);
            error.blockedNormalizationDraftSha256 = sha(draft);
        }
        throw error;
    }
    const sections = Array.isArray(draft?.sections) ? draft.sections : [];
    const ranked = sections.map((section, index) => ({ section, index }));
    // 未知或格式错误的小节类型由解析器检查；在它报告错误之前，不要自己
    // 编一个顺序，也不要改索引。
    const sectionsAreKnown = ranked.every(({ section }) => READER_SECTION_KINDS.includes(section?.kind));
    if (sectionsAreKnown) {
        ranked.sort((a, b) => READER_SECTION_KINDS.indexOf(a.section.kind)
            - READER_SECTION_KINDS.indexOf(b.section.kind) || a.index - b.index);
    }
    const sectionMap = ranked.map(({ index }, canonicalIndex) => ({ rawIndex: index, canonicalIndex }));
    const sectionOrderChanged = sectionMap.some(item => item.rawIndex !== item.canonicalIndex);
    let originalTables = locateReaderDraftTables(draft);
    pruneTrailingUnboundSourceQuoteBindings(draft, originalTables);
    // 小节顺序正确也可能把来源声明留在旧表序；仅按唯一的原格或引文对应重排。
    if (Array.isArray(draft.tableBindings)
        && alignSourceQuoteBindingsToCurrentTableNodes(draft, originalTables, structuredArtifacts)) {
        originalTables = locateReaderDraftTables(draft);
    }
    let tableMap = originalTables.map(table => ({ rawIndex: table.bindingIndex, canonicalIndex: table.bindingIndex,
        rawSectionIndex: table.sectionIndex, canonicalSectionIndex: table.sectionIndex }));
    if (sectionOrderChanged && Array.isArray(draft.tableBindings)) {
        // 先尝试按来源引文或原表单元格内容匹配，而非直接沿用位置序号；
        // 位置序号可能看似有效，实际对应的表却属于另一个原始小节。
        let valid = originalTables.length === draft.tableBindings.length
            && draft.tableBindings.every((binding, index) => binding?.tableIndex === index + 1
                && (Object.prototype.hasOwnProperty.call(binding, 'selection')
                    ? originalTables[index]?.markerIndex === index + 1
                        && sections.reduce((n, section) => n + String(section?.body || '').split(`[[TABLE_${index + 1}]]`).length - 1, 0) === 1
                    : !originalTables[index]?.marker));
        // 小节排序前先检查选择标记与普通表混排的对应关系：选择绑定按唯一 TABLE 序号对应，
        // 来源引文与原表绑定保持原有相对顺序。
        // 后续来源检查仍须逐个核对单元格和引文。
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
        if (!valid && alignSourceQuoteBindingsToCurrentTableNodes(
            draft, originalTables, structuredArtifacts
        )) {
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
            const error = new Error('重排正文前，表格与来源记录不能一一对应。请按当前草稿的正文顺序核对 tableBindings 和 TABLE 占位符，不猜测缺失数据，也不丢弃已有来源的表格。');
            error.code = 'READER_DRAFT_ORDER_AMBIGUOUS';
            error.readerIssues = [
                ...originalTables.map(table => ({ path: table.path, message: error.message, code: TABLE_BINDING_ORDER_ISSUE_CODE })),
                ...draft.tableBindings.map((_binding, index) => ({ path: `/tableBindings/${index}`, message: error.message, code: TABLE_BINDING_ORDER_ISSUE_CODE }))
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
        // 一次替换全部序号，避免 1→2→1 的连续改名冲突；只改有明确对应记录的
        // 表格选择标记，不改其他正文或表格单元格。
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
    // 术语组合解释标记用固定编号表示身份，不表示正文中的出现顺序。
    // 编号必须完整覆盖 1..N 且无重复，才按编号重新排列；否则保留原内容，由解析器报错。
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

// 模型有时已逐格抄出 selection 指定的表，却漏写 TABLE 占位符。
// 只在现成表与公共表格生成程序的原 DOM 选区完全一致且唯一时恢复声明形式；
// 不推断坐标、不翻译表头、不改数字，也不选择重复的表。
function normalizeUniqueRenderedReaderSelections(draft, structuredArtifacts) {
    if (!structuredArtifacts || !Array.isArray(draft?.tableBindings)
        || !Array.isArray(draft.sections)) return;
    const tables = locateReaderDraftTables(draft);
    const plans = [];
    const { renderReaderTableSelection } = require('./reader-tables');
    const cells = table => [table.header, ...table.rows];
    for (const [index, binding] of draft.tableBindings.entries()) {
        if (!binding?.selection || binding.tableIndex !== index + 1) continue;
        const marker = `[[TABLE_${binding.tableIndex}]]`;
        if (draft.sections.some(section => String(section?.body || '').includes(marker))) continue;
        let rendered;
        try { rendered = renderReaderTableSelection(binding, structuredArtifacts); } catch (_) { continue; }
        const expected = extractMarkdownTables(rendered.markdown);
        if (expected.length !== 1) continue;
        const matches = tables.filter(node => node.table
            && JSON.stringify(cells(node.table)) === JSON.stringify(cells(expected[0])));
        if (matches.length !== 1) continue;
        const node = matches[0];
        const body = String(draft.sections[node.sectionIndex]?.body || '');
        if (body.split(/\n\s*\n/).filter(block => block.trim() === node.table.markdown).length !== 1) continue;
        plans.push({ node, marker });
    }
    // 两条声明争用同一现成表也不具备唯一身份。
    for (const { node, marker } of plans.filter(plan => plans.filter(other =>
        other.node.sectionIndex === plan.node.sectionIndex && other.node.line === plan.node.line).length === 1)
        .sort((a, b) => b.node.line - a.node.line)) {
        const section = draft.sections[node.sectionIndex];
        const lines = section.body.split('\n');
        const end = node.table.endLine;
        if (lines.slice(node.table.startLine, end + 1).join('\n') !== node.table.markdown) continue;
        lines.splice(node.table.startLine, end - node.table.startLine + 1, marker);
        section.body = lines.join('\n');
    }
}

module.exports = { READER_DRAFT_ORDER_CONTRACT, TABLE_BINDING_ORDER_ISSUE_CODE, READER_SECTION_KINDS, locateReaderDraftTables,
    completeSelectionMarkerPermutation, pruneUniquelyUnboundReaderMarkdownTables,
    alignMixedBindingsToCurrentTableNodes, alignSourceQuoteBindingsToCurrentTableNodes,
    pruneTrailingUnboundSourceQuoteBindings,
    normalizeReaderBodyContinuations, normalizeReaderDraftOrder };
