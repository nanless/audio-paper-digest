'use strict';

const crypto = require('node:crypto');
const { extractMarkdownTables } = require('../analysis-contract.js');
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

// 选择 marker 是对 tableBindings[ordinal - 1] 的语义引用。当每张表都是
// 唯一绑定的选择 marker 时，一整套 marker 排列就可以规范化，不必解读
// 正文或表格内容。混用、畸形、重复、缺失或行内的 marker 集合一律不动，
// 留给权威解析器报错。
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

// 桥接 marker 本身不含作者写的正文，解释都在它的声明里。小节和桥接序号
// 都规范之后，要确定地补上或挪动一个 marker，只有两个条件同时成立才行：
// 它声明的小节类型恰好出现一次，且现有每个桥接 marker 都是精确、唯一、
// 独立成行的 token。位置不对的 marker 只从段落末尾搬走，这样 "\n\nMARKER"
// 这段字节能原样转移，不改动任何非 marker 字节。
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
        // 模型有时会在相邻几行上各放一个独立的桥接 token。它们作为 marker 身份
        // 仍然唯一，但 Markdown 会把这几行当成一个段落，下游的绑定闸门也确实
        // 会拒绝它。这里只补上缺的那个空行分隔，作者写的正文和 marker 字节都不动。
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
// 表格串。选择 marker 是强锚点：如果绑定到表格节点的顺序保持匹配只有
// 一种，且每个没匹配上的节点都是普通 Markdown 表，那些表就可以证明是
// 未绑定的。只处理这一种窄情况；存在多种可能的匹配仍然算解析错误。
function pruneUniquelyUnboundReaderMarkdownTables(input) {
    if (!Array.isArray(input?.sections) || !Array.isArray(input?.tableBindings)) return 0;
    const nodes = locateReaderDraftTables(input);
    const bindings = input.tableBindings;
    if (nodes.length <= bindings.length || bindings.length === 0) return 0;
    const solutions = [];
    // 会议 PDF 抽取可能把引文里带千分位的数字（如 `169,221`）压平，而作者
    // 写的表里是 `169221`。这个匹配器只服务于剪除证明：最终的来源绑定仍会
    // 做权威的数字重放。旧匹配器会把带分组的来源数字拆成 `169` 和 `221`，
    // 于是一张本来可以证明的 SounDiT 表看起来就成了未绑定。
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

    // 上面那套严格的顺序保持证明，处理常规情况时仍是权威。第二套证明同样
    // 失败即停，用来处理选择 marker 和作者写的引文表以不同顺序输出的混排
    // 草稿。它有意只限于至少有一处数量重叠的 source_quotes。引文绑定生成的
    // `来源证据` 表是确定性的恢复产物；优先用它，而不是一张未绑定、内容更
    // 丰富的手写重复表，因为在这个阶段只有被引用的数字经过了核验。
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
    // 放宽后的混排顺序分配，上面那套一一对应的评分证明已经专门核对过；
    // 它们的节点顺序由后面那道混排绑定流程规范化。在这里重新套用旧的
    // 位置匹配器，反而会否掉这套证明刚刚处理过的那种 marker/表格排列。
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

// 没有 marker 的来源引文绑定和 artifact 表绑定，都没有可见的序号标记。
// 模型把各节以不同顺序输出时，只能靠唯一且有证据支撑的表格分配来恢复
// 排列。artifact 表要求每个渲染出来的单元格都能对上它已核验的 DOM
// 单元格。选择 marker 仍是更强的锚点，绝不从正文里推断。
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
                    || normalize(sourceCell.text.replace(/<br\s*\/?>/gi, ' ').replace(/[％]/g, '%'))
                        !== normalize(row[columnIndex].replace(/<br\s*\/?>/gi, ' ').replace(/[％]/g, '%'))) {
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
    const candidates = evidenceBindings.map(({ binding, kind, sourceTable }) => proseNodes.map((node, index) => ({
        index, score: score(binding, node, kind, sourceTable)
    })).filter(candidate => candidate.score > 0));
    if (candidates.some(items => items.length === 0)) return false;
    let bestScore = -1, bestAssignments = [], assignment = [];
    const visit = (bindingIndex, used, total) => {
        if (bindingIndex === evidenceBindings.length) {
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
    const assignedByNode = new Map(bestAssignments[0].map((item, index) => [
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

// 末尾那些没有可见表格节点的 source_quotes 声明，不含面向读者的内容，
// 也编译不出来。只有满足以下条件时才删掉这段末尾后缀：可见的整条表格
// 串都是普通 Markdown，前面所有绑定都是顺序的 source_quotes，且任何
// 地方都不存在 TABLE marker。完整解析器仍会重放剩下每一条引文。
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

function normalizeReaderDraftOrder(input, { structuredArtifacts = null } = {}) {
    const draft = structuredClone(input);
    const inputSha256 = sha(input);
    const sections = Array.isArray(draft?.sections) ? draft.sections : [];
    const ranked = sections.map((section, index) => ({ section, index }));
    // 未知或畸形的小节类型归解析器的形状闸门管；在它报出来之前，不要自己
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
    let tableMap = originalTables.map(table => ({ rawIndex: table.bindingIndex, canonicalIndex: table.bindingIndex,
        rawSectionIndex: table.sectionIndex, canonicalSectionIndex: table.sectionIndex }));
    if (sectionOrderChanged && Array.isArray(draft.tableBindings)) {
        // 有核验过的证据时优先于位置顺序。这也覆盖了一种常见情况：位置形状
        // 看着有效，但每个绑定其实属于另一个原始小节。
        const sourceQuoteAligned = alignSourceQuoteBindingsToCurrentTableNodes(
            draft, originalTables, structuredArtifacts
        );
        if (sourceQuoteAligned) originalTables = locateReaderDraftTables(draft);
        let valid = originalTables.length === draft.tableBindings.length
            && draft.tableBindings.every((binding, index) => binding?.tableIndex === index + 1
                && (Object.prototype.hasOwnProperty.call(binding, 'selection')
                    ? originalTables[index]?.markerIndex === index + 1
                        && sections.reduce((n, section) => n + String(section?.body || '').split(`[[TABLE_${index + 1}]]`).length - 1, 0) === 1
                    : !originalTables[index]?.marker));
        // 混排的表格串可以在小节排序之前无歧义地对齐：选择绑定靠它唯一的
        // TABLE 序号锚定，来源引文和 artifact 绑定保持原有的相对顺序。
        // 下游的来源绑定解析器仍会重放每一个单元格和每一条引文。
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
        // 一趟替换可以避免 1→2→1 这类连锁改名冲突。正文和表格单元格都不改：
        // 只重命名显式绑定的选择 marker。
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
    // 桥接 marker 是稳定 ID，不表示它在正文里出现的先后。只有完整且无歧义的
    // 1..N 排列才允许重排。凡是畸形的集合，一个字节都不改，留给解析器报错。
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

module.exports = { READER_DRAFT_ORDER_CONTRACT, TABLE_BINDING_ORDER_ISSUE_CODE, READER_SECTION_KINDS, locateReaderDraftTables,
    completeSelectionMarkerPermutation, pruneUniquelyUnboundReaderMarkdownTables,
    alignMixedBindingsToCurrentTableNodes, alignSourceQuoteBindingsToCurrentTableNodes,
    pruneTrailingUnboundSourceQuoteBindings,
    normalizeReaderDraftOrder };
