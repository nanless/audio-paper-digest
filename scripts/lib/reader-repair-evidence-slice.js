'use strict';

const { MAX_READER_PATCH_NODES, MIN_READER_PATCH_NODES } = require('./reader-patch-limits.js');
const { READER_LIMITS } = require('./reader-contract.js');
const {
    assessReaderTableSelectionEligibility,
    assessReaderCompleteTableEligibility,
    effectiveReaderTableRows
} = require('./reader-tables.js');

const PROVABLE_SLICE_MAX_RATIO = 0.85;
const TABLE_CONTEXT_RADIUS_CHARS = 2500;
const LOCAL_NODE_CONTEXT_RADIUS_CHARS = 1500;
const OPENING_ABSTRACT_MAX_CHARS = 3000;
const MAX_TABLE_CONTEXT_WINDOWS = 6;
const MAX_LOCAL_NODE_HIT_WINDOWS = 6;
const MAX_PROVABLE_TABLE_ORDINALS = 12;

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidSha256(value) {
    return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function alignUtf16Bounds(text, rawStart = 0, rawEnd = undefined) {
    const str = String(text ?? '');
    const len = str.length;
    if (len === 0) return { start: 0, end: 0 };

    let start = rawStart === undefined ? 0 : Math.trunc(Number(rawStart));
    if (!Number.isFinite(start) || start < 0) start = 0;
    start = Math.min(len, start);

    let end = rawEnd === undefined ? len : Math.trunc(Number(rawEnd));
    if (!Number.isFinite(end)) end = len;
    if (end < 0) end = 0;
    end = Math.max(start, Math.min(len, end));

    while (start < end) {
        const code = str.charCodeAt(start);
        if (code >= 0xDC00 && code <= 0xDFFF) start += 1;
        else break;
    }
    while (end > start) {
        const code = str.charCodeAt(end - 1);
        if (code >= 0xD800 && code <= 0xDBFF) end -= 1;
        else break;
    }
    return { start, end };
}

function sliceUtf16WellFormed(text, start = 0, end = undefined) {
    const str = String(text ?? '');
    const bounds = alignUtf16Bounds(str, start, end);
    const sliced = str.slice(bounds.start, bounds.end);
    return sliced.isWellFormed() ? sliced : sliced.toWellFormed();
}

function resolveExistingDraftNode(draft, pointer) {
    if (typeof pointer !== 'string' || !pointer.startsWith('/')) return { exists: false, value: undefined };
    const parts = sliceUtf16WellFormed(pointer, 1).split('/');
    let current = draft;
    for (const part of parts) {
        if (!part) return { exists: false, value: undefined };
        if (Array.isArray(current)) {
            if (!/^(?:0|[1-9]\d*)$/.test(part)) return { exists: false, value: undefined };
            const index = Number(part);
            if (index < 0 || index >= current.length || !Object.prototype.hasOwnProperty.call(current, index)) {
                return { exists: false, value: undefined };
            }
            current = current[index];
        } else if (isPlainObject(current)) {
            if (!Object.prototype.hasOwnProperty.call(current, part)) {
                return { exists: false, value: undefined };
            }
            current = current[part];
        } else {
            return { exists: false, value: undefined };
        }
    }
    return { exists: true, value: current };
}

function countDraftProseChineseChars(draft) {
    if (!Array.isArray(draft?.sections)) return 0;
    const rawLines = draft.sections
        .map(section => String(section?.body || ''))
        .join('\n')
        .split('\n');
    const proseLines = rawLines.filter(line => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        if (trimmed.startsWith('|') && trimmed.endsWith('|')) return false;
        if (/^\[\[(?:TABLE|FIGURE|FORMULA|CONCEPT_BRIDGE)_[^\]]+\]\]$/.test(trimmed)) return false;
        if (/^!\[[^\]]*\]\([^)]+\)$/.test(trimmed)) return false;
        if (/^\*\*[^*]+ × [^*]+：\*\*/.test(trimmed)) return false;
        return true;
    });
    const proseSurface = proseLines
        .join('\n')
        .replace(/\[\[(?:TABLE|FIGURE|FORMULA|CONCEPT_BRIDGE)_[^\]]+\]\]/g, '');
    return (proseSurface.match(/[\u3400-\u9fff]/g) || []).length;
}

function issueIndicatesLengthShortfall(issue) {
    const message = String(issue?.message || '');
    const exact = /中文字数必须为\s*(\d+)[–-](\d+)，当前\s*(\d+)/.exec(message);
    if (exact && Number(exact[3]) < Number(exact[1])) return true;
    const estimated = /篇幅预估为\s*(\d+)\s*个汉字[^\n]*完整文章要求\s*(\d+)[–-](\d+)/.exec(message);
    if (estimated && Number(estimated[1]) < Number(estimated[2])) return true;
    return /散文(?:汉字|字数)[^。\n]*(?:偏少|不足)|纯散文字数不足|字数不足|篇幅不足|<\s*4500/.test(message);
}

function isPureTableIssue(issue) {
    if (!issue || typeof issue !== 'object') return false;
    const code = String(issue.code || '');
    const path = issue.path;
    const message = String(issue.message || '');
    if (issueIndicatesLengthShortfall(issue)) return false;
    if (/方法推导|推导缺失|核心步骤|跨节|散文扩写|formulaBindings|figurePlacements|\[\[FIGURE_|\[\[FORMULA_|开源|resource|至少需要\s*\d+\s*张\s*Markdown\s*表|主结果表覆盖不足|与第\s*\d+\s*张表(?:完全重复|重复或高度重叠)|同一张实验或消融表不得在文章中重复展示|冒充主结果表/i.test(message)) {
        return false;
    }
    if (code === 'reader_invalid_source_quotes'
        || code === 'reader_source_table_unrenderable'
        || code === 'reader_table_count_insufficient'
        || code === 'reader_result_table_missing'
        || code === 'reader_duplicate_table'
        || code === 'reader_result_ablation_misplacement') {
        return false;
    }
    if (typeof path === 'string' && /^\/tableBindings\/(?:0|[1-9]\d*)(?:\/|$)/.test(path)) {
        return true;
    }
    if (/^reader_(?:source_)?table_|^table_binding_/.test(code)) {
        return true;
    }
    if ((path === null || path === undefined || path === '')
        && /(?:tableBindings\[\d+\]|sourceTableOrdinal=\d+|\[\[TABLE_\d+\]\]|表格绑定|原表选择)/.test(message)) {
        return true;
    }
    return false;
}

function isCompleteOriginalTableDefinition(table, allTables) {
    if (!isPlainObject(table)) return false;
    if (!Number.isSafeInteger(table.ordinal) || table.ordinal < 1) return false;
    if (!Array.isArray(allTables)
        || allTables.filter(candidate => candidate?.ordinal === table.ordinal).length !== 1) {
        return false;
    }
    if (table.recoveryStatus !== 'complete' || !isValidSha256(table.sourceDomSha256)) {
        return false;
    }
    const caption = String(table.caption || '').trim();
    if (!caption) return false;
    const matrix = table.matrix;
    if (!Array.isArray(matrix) || matrix.length < 2) return false;
    const width = Array.isArray(matrix[0]) ? matrix[0].length : 0;
    if (width < 2) return false;
    if (matrix.some(row => !Array.isArray(row) || row.length !== width
        || row.some(cell => typeof cell !== 'string'))) {
        return false;
    }
    const hasNonEmptyCell = matrix.some(row => row.some(cell => String(cell ?? '').trim().length > 0));
    if (!hasNonEmptyCell) return false;

    const selectionEligible = assessReaderTableSelectionEligibility(table).eligible;
    const completeEligible = assessReaderCompleteTableEligibility(table).eligible;
    return selectionEligible || completeEligible;
}

function renderMatrixAsMarkdown(table) {
    if (typeof table.markdown === 'string' && table.markdown.trim()) {
        return table.markdown.trim();
    }
    const matrix = table.matrix;
    const effectiveRows = effectiveReaderTableRows(table);
    const headerRowIndex = effectiveRows.headerRows[0] ?? 0;
    const sanitizeCell = cell => String(cell ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
    const headerLine = `| ${matrix[headerRowIndex].map(sanitizeCell).join(' | ')} |`;
    const separatorLine = `| ${matrix[headerRowIndex].map(() => '---').join(' | ')} |`;
    const dataRows = matrix
        .filter((_row, index) => index !== headerRowIndex)
        .map(row => `| ${row.map(sanitizeCell).join(' | ')} |`);
    return [headerLine, separatorLine, ...dataRows].join('\n');
}

function generationSelectionProfileForSlice(table) {
    return assessReaderTableSelectionEligibility(table);
}

function mergeWindows(rawWindows, sourceText, maxWindows) {
    const str = String(sourceText ?? '');
    const textLength = str.length;
    if (!rawWindows.length || textLength <= 0) return [];
    const clipped = rawWindows
        .map(win => {
            const aligned = alignUtf16Bounds(str, win.start, win.end);
            return {
                start: aligned.start,
                end: aligned.end,
                label: win.label || ''
            };
        })
        .filter(win => win.end > win.start)
        .sort((left, right) => left.start - right.start || left.end - right.end);
    const merged = [];
    for (const win of clipped) {
        const prev = merged.at(-1);
        if (prev && win.start <= prev.end + 120) {
            prev.end = Math.max(prev.end, win.end);
            if (win.label && !prev.labels.includes(win.label)) prev.labels.push(win.label);
        } else {
            merged.push({ start: win.start, end: win.end, labels: win.label ? [win.label] : [] });
        }
        if (merged.length >= maxWindows) break;
    }
    return merged;
}

function collectTableTextWindows(sourceText, table) {
    const ordinal = table.ordinal;
    const rawWindows = [];
    const mentionPatterns = [
        new RegExp(`\\bTable\\s*${ordinal}(?!\\d)`, 'gi'),
        new RegExp(`\\bTab\\.\\s*${ordinal}(?!\\d)`, 'gi'),
        new RegExp(`表\\s*${ordinal}(?!\\d)`, 'g')
    ];
    for (const pattern of mentionPatterns) {
        for (const match of sourceText.matchAll(pattern)) {
            rawWindows.push({
                start: match.index - TABLE_CONTEXT_RADIUS_CHARS,
                end: match.index + match[0].length + TABLE_CONTEXT_RADIUS_CHARS,
                label: match[0]
            });
            if (rawWindows.length >= MAX_TABLE_CONTEXT_WINDOWS * 2) break;
        }
    }
    const cleanCaption = String(table.caption || '').replace(/\s+/g, ' ').trim();
    if (cleanCaption.length >= 12) {
        const strippedCaption = cleanCaption.replace(/^(?:Table|Tab\.|表)\s*\d+\s*[:.：]?\s*/i, '');
        const captionAnchor = sliceUtf16WellFormed(strippedCaption, 0, 48).trim();
        if (captionAnchor.length >= 8) {
            const exactIdx = sourceText.indexOf(captionAnchor);
            const anchorMatch = exactIdx >= 0
                ? { index: exactIdx, length: captionAnchor.length }
                : (() => {
                    const hit = new RegExp(escapeRegExp(captionAnchor), 'i').exec(sourceText);
                    return hit ? { index: hit.index, length: hit[0].length } : null;
                })();
            if (anchorMatch) {
                rawWindows.push({
                    start: anchorMatch.index - TABLE_CONTEXT_RADIUS_CHARS,
                    end: anchorMatch.index + anchorMatch.length + TABLE_CONTEXT_RADIUS_CHARS,
                    label: 'caption'
                });
            }
        }
    }
    if (rawWindows.length === 0) {
        const captionTokens = (cleanCaption.match(/[A-Za-z][A-Za-z0-9_-]{3,}/g) || [])
            .filter(token => !/^(?:table|results?|comparison|performance|evaluation|models?|methods?|with|from|over|that|this)$/i.test(token))
            .slice(0, 4);
        for (const token of captionTokens) {
            const hit = new RegExp(escapeRegExp(token), 'i').exec(sourceText);
            if (hit) {
                rawWindows.push({
                    start: hit.index - TABLE_CONTEXT_RADIUS_CHARS,
                    end: hit.index + hit[0].length + TABLE_CONTEXT_RADIUS_CHARS,
                    label: token
                });
            }
        }
    }
    return mergeWindows(rawWindows, sourceText, MAX_TABLE_CONTEXT_WINDOWS);
}

function locateTermHitOffsets(sourceText, rawTerm) {
    const trimmed = String(rawTerm || '').trim();
    if (!trimmed) return [];
    const candidates = new Set();
    const strippedPrefix = trimmed.replace(/^(?:符号|术语|概念)\s+/u, '').trim();
    if (strippedPrefix.length >= 2) candidates.add(strippedPrefix);
    if (trimmed.length >= 2) candidates.add(trimmed);

    for (const parenMatch of trimmed.matchAll(/[（(]([^（）()\n]{2,48})[）)]/g)) {
        const inner = parenMatch[1].trim();
        if (inner.length >= 2) candidates.add(inner);
    }
    for (const latinMatch of strippedPrefix.matchAll(/[A-Za-z\\][A-Za-z0-9_\\{}^+-]{1,47}/g)) {
        const token = latinMatch[0].trim();
        if (token.length >= 2) candidates.add(token);
    }

    const hits = [];
    for (const needle of candidates) {
        const pattern = new RegExp(escapeRegExp(needle), 'gi');
        for (const match of sourceText.matchAll(pattern)) {
            hits.push({ index: match.index, length: match[0].length, term: trimmed });
            if (hits.length >= MAX_LOCAL_NODE_HIT_WINDOWS) break;
        }
        if (hits.length > 0) break;
    }
    return hits;
}

function extractPreservedPolicyHeaders(fullSourceEvidence) {
    const preserved = [];
    const text = String(fullSourceEvidence || '');
    for (const block of text.split(/\n\n+/)) {
        const trimmed = block.trim();
        if (trimmed.startsWith('[READER_CAPABILITY_POLICY]')
            || trimmed.startsWith('[READER_VERIFIED_RESOURCES]')) {
            preserved.push(trimmed);
        }
    }
    return preserved;
}

function collectReferencedTableOrdinalsForBinding(binding, bindingIndex, issues) {
    if (binding?.sourceType === 'source_quotes') return null;
    const ordinals = new Set();
    const directCandidates = [
        binding?.selection?.sourceTableOrdinal,
        binding?.completeTable?.sourceTableOrdinal,
        binding?.sourceTableOrdinal
    ];
    for (const value of directCandidates) {
        if (value !== undefined && value !== null) {
            if (!Number.isSafeInteger(value) || value < 1) return null;
            ordinals.add(value);
        }
    }
    for (const issue of issues) {
        const matchesBinding = issue?.path === `/tableBindings/${bindingIndex}`
            || (typeof issue?.path === 'string' && issue.path.startsWith(`/tableBindings/${bindingIndex}/`))
            || String(issue?.message || '').includes(`tableBindings[${bindingIndex}]`);
        if (!matchesBinding) continue;
        for (const match of String(issue?.message || '').matchAll(/sourceTableOrdinal=(\d+)/g)) {
            const parsed = Number(match[1]);
            if (Number.isSafeInteger(parsed) && parsed >= 1) ordinals.add(parsed);
        }
        const altMatch = String(issue?.message || '').match(/其他可选择原表序号=(\[[^\]\n]*\])/);
        if (altMatch) {
            try {
                const parsedList = JSON.parse(altMatch[1]);
                if (Array.isArray(parsedList) && parsedList.length <= MAX_PROVABLE_TABLE_ORDINALS
                    && parsedList.every(item => Number.isSafeInteger(item) && item >= 1)) {
                    for (const item of parsedList) ordinals.add(item);
                }
            } catch (_) {
                return null;
            }
        }
    }
    return ordinals.size > 0 && ordinals.size <= MAX_PROVABLE_TABLE_ORDINALS ? [...ordinals] : null;
}

function collectIssueExampleOrdinals(issues, draft, allTables) {
    const ordinals = new Set();
    for (const issue of issues || []) {
        const message = String(issue?.message || '');
        const alternatives = message.match(/其他可选择原表序号=(\[[^\]\n]*\])/);
        if (alternatives) {
            try {
                const values = JSON.parse(alternatives[1]);
                if (Array.isArray(values) && values.length <= MAX_PROVABLE_TABLE_ORDINALS
                    && values.every(value => Number.isInteger(value) && value > 0)) {
                    for (const value of values) ordinals.add(value);
                }
            } catch (_) {
                // ignore non-JSON diagnostic fragments
            }
        }
        for (const match of message.matchAll(/sourceTableOrdinal=(\d+)/g)) {
            ordinals.add(Number(match[1]));
        }
        for (const match of message.matchAll(/tableBindings\[(\d+)\]/g)) {
            const ordinal = draft?.tableBindings?.[Number(match[1])]?.selection?.sourceTableOrdinal;
            if (Number.isInteger(ordinal) && ordinal >= 1) ordinals.add(ordinal);
        }
    }
    return [...ordinals].filter(ordinal => {
        const matches = allTables.filter(table => table?.ordinal === ordinal);
        return matches.length === 1
            && isCompleteOriginalTableDefinition(matches[0], allTables)
            && assessReaderTableSelectionEligibility(matches[0]).eligible;
    });
}

function isNullPathTableIssueCovered(issue, verifiedBindings, verifiedTableMarkers, verifiedOrdinals) {
    if (!isPureTableIssue(issue) || verifiedBindings.size === 0) return false;
    const message = String(issue?.message || '');
    const bindingRefs = [...message.matchAll(/tableBindings\[(\d+)\]/g)].map(m => Number(m[1]));
    const markerRefs = [...message.matchAll(/\[\[TABLE_(\d+)\]\]/g)].map(m => Number(m[1]));
    const ordinalRefs = [...message.matchAll(/sourceTableOrdinal=(\d+)/g)].map(m => Number(m[1]));
    if (bindingRefs.length > 0 || markerRefs.length > 0) {
        return bindingRefs.every(idx => verifiedBindings.has(idx))
            && markerRefs.every(marker => verifiedTableMarkers.has(marker))
            && ordinalRefs.every(ord => verifiedOrdinals.has(ord));
    }
    if (ordinalRefs.length > 0) {
        return ordinalRefs.every(ord => verifiedOrdinals.has(ord));
    }
    return false;
}

/**
 * 为 Reader 局部节点修复请求构造可证明覆盖的紧凑来源证据切片。
 * 任一安全放行条件不满足，或切片压缩后未显著小于原证据（< 85%），均 100% 原样回退 fullSourceEvidence。
 */
function selectProvableRepairSourceEvidence({
    fullSourceEvidence,
    sourceText,
    structuredSourcePayload,
    candidateDraft,
    repairContext,
    maxChars
} = {}) {
    if (typeof fullSourceEvidence !== 'string' || fullSourceEvidence.length === 0) {
        return String(fullSourceEvidence ?? '');
    }
    const fallback = () => fullSourceEvidence;

    if (typeof sourceText !== 'string' || sourceText.trim().length === 0) return fallback();
    if (!isPlainObject(candidateDraft) || !isPlainObject(repairContext)) return fallback();

    // 条件 1：必须是普通既有节点局部补丁请求（1..8 个节点），排除全文、原子结构操作与定向外部审查修订
    if (repairContext.requestKind === 'full') return fallback();
    if (repairContext.atomicOperation != null) return fallback();
    if (repairContext.sectionGroupPlanContract) return fallback();
    if (repairContext.readerFactLocalRevision === true || repairContext.resourceLocalRevision === true) {
        return fallback();
    }
    if (repairContext.sealedPdfQuoteDocumentAvailable === true) return fallback();
    if (typeof repairContext.reviewFeedback === 'string' && repairContext.reviewFeedback.trim().length > 0) {
        return fallback();
    }
    if (typeof repairContext.targetGuidance === 'string' && repairContext.targetGuidance.includes('篇幅不足时')) {
        return fallback();
    }

    const targets = Array.isArray(repairContext.targets)
        ? repairContext.targets
        : Array.isArray(repairContext.repairTargets)
            ? repairContext.repairTargets
            : null;
    if (!targets || targets.length < MIN_READER_PATCH_NODES || targets.length > MAX_READER_PATCH_NODES) {
        return fallback();
    }

    const activeTargetPaths = [];
    for (const target of targets) {
        if (!isPlainObject(target) || typeof target.path !== 'string' || !target.path.startsWith('/')) {
            return fallback();
        }
        if (activeTargetPaths.includes(target.path)) return fallback();
        if (!resolveExistingDraftNode(candidateDraft, target.path).exists) return fallback();
        activeTargetPaths.push(target.path);
    }

    const deferredTargetPaths = [];
    if (repairContext.deferredTargets !== undefined && repairContext.deferredTargets !== null) {
        if (!Array.isArray(repairContext.deferredTargets)) return fallback();
        for (const deferred of repairContext.deferredTargets) {
            const pointer = typeof deferred === 'string'
                ? deferred
                : isPlainObject(deferred)
                    ? deferred.path
                    : null;
            if (typeof pointer !== 'string' || !pointer.startsWith('/')) return fallback();
            if (activeTargetPaths.includes(pointer) || deferredTargetPaths.includes(pointer)) return fallback();
            if (!resolveExistingDraftNode(candidateDraft, pointer).exists) return fallback();
            deferredTargetPaths.push(pointer);
        }
    }

    const allRoundTargetPaths = [...activeTargetPaths, ...deferredTargetPaths];
    if (allRoundTargetPaths.length > MAX_READER_PATCH_NODES) {
        return fallback();
    }
    const activeTargetSet = new Set(activeTargetPaths);

    // 条件 3（前置全局阻断检查）：不存在全文纯散文字数不足（< 4500 字）、跨节散文扩写或不可渲染原表问题
    const proseChineseChars = countDraftProseChineseChars(candidateDraft);
    if (proseChineseChars < READER_LIMITS.minimumProseChineseChars) {
        return fallback();
    }

    const allIssues = Array.isArray(repairContext.issues) ? repairContext.issues : [];
    for (const issue of allIssues) {
        if (issueIndicatesLengthShortfall(issue)) return fallback();
    }

    const blockingIssues = allIssues.filter(issue => issue?.diagnosticOnly !== true);
    for (const issue of blockingIssues) {
        const message = String(issue?.message || '');
        if (/方法推导|推导缺失|核心步骤|推导过程|跨节|散文扩写|各节分工|formulaBindings|figurePlacements|\[\[FIGURE_|\[\[FORMULA_|开源|resource/i.test(message)) {
            return fallback();
        }
        if (issue?.code === 'reader_invalid_source_quotes'
            || issue?.code === 'reader_source_table_unrenderable'
            || issue?.code === 'reader_table_count_insufficient'
            || issue?.code === 'reader_result_table_missing'
            || issue?.code === 'reader_duplicate_table'
            || issue?.code === 'reader_result_ablation_misplacement'
            || /至少需要\s*\d+\s*张\s*Markdown\s*表|主结果表覆盖不足|与第\s*\d+\s*张表(?:完全重复|重复或高度重叠)|同一张实验或消融表不得在文章中重复展示|冒充主结果表/.test(message)) {
            return fallback();
        }
    }

    // 条件 2：激活与顺延目标全部必须属于类型 I（原表精确绑定）或类型 II（/readerTitle、/conceptBridges/<i>）
    const allTables = Array.isArray(structuredSourcePayload?.tables) ? structuredSourcePayload.tables : [];
    const availableSelectionOrdinals = allTables
        .slice(0, MAX_PROVABLE_TABLE_ORDINALS)
        .filter(table => isCompleteOriginalTableDefinition(table, allTables)
            && assessReaderTableSelectionEligibility(table).eligible)
        .map(table => table.ordinal);
    const hasTruncatedEligibleBeyondCap = allTables
        .slice(MAX_PROVABLE_TABLE_ORDINALS)
        .some(table => isCompleteOriginalTableDefinition(table, allTables)
            && assessReaderTableSelectionEligibility(table).eligible);

    const activeTableOrdinals = new Set();
    const allVerifiedOrdinals = new Set();
    const allVerifiedBindingIndices = new Set();
    const allVerifiedTableMarkers = new Set();
    const localTermHits = [];
    let hasTitleTarget = false;
    let hasBridgeTarget = false;

    const explicitTableBindingIndices = new Set();
    for (const pointer of allRoundTargetPaths) {
        const tableMatch = /^\/tableBindings\/(0|[1-9]\d*)(?:\/[A-Za-z0-9_]+)?$/.exec(pointer);
        if (tableMatch) explicitTableBindingIndices.add(Number(tableMatch[1]));
    }

    const validateAndRecordBindingOrdinals = (binding, bindingIndex, isActive) => {
        const ordinals = collectReferencedTableOrdinalsForBinding(binding, bindingIndex, blockingIssues);
        if (!ordinals || ordinals.length === 0) return false;
        allVerifiedBindingIndices.add(bindingIndex);
        if (Number.isSafeInteger(binding?.tableIndex) && binding.tableIndex >= 1) {
            allVerifiedTableMarkers.add(binding.tableIndex);
        }
        for (const ordinal of ordinals) {
            const sourceTable = allTables.find(item => item?.ordinal === ordinal);
            if (!isCompleteOriginalTableDefinition(sourceTable, allTables)) return false;
            allVerifiedOrdinals.add(ordinal);
            if (isActive) activeTableOrdinals.add(ordinal);
            if (!assessReaderTableSelectionEligibility(sourceTable).eligible) {
                const needsSwitch = Boolean(binding?.selection)
                    || !binding?.completeTable
                    || blockingIssues.some(issue => {
                        const msg = String(issue?.message || '');
                        return (issue?.path === `/tableBindings/${bindingIndex}`
                            || (typeof issue?.path === 'string' && issue.path.startsWith(`/tableBindings/${bindingIndex}/`))
                            || msg.includes(`tableBindings[${bindingIndex}]`))
                            && /selection|改选|其他可选择原表/.test(msg);
                    });
                if (needsSwitch) {
                    if (hasTruncatedEligibleBeyondCap || availableSelectionOrdinals.length === 0) {
                        return false;
                    }
                    for (const altOrdinal of availableSelectionOrdinals) {
                        allVerifiedOrdinals.add(altOrdinal);
                        if (isActive) activeTableOrdinals.add(altOrdinal);
                    }
                }
            }
        }
        return allVerifiedOrdinals.size <= MAX_PROVABLE_TABLE_ORDINALS;
    };

    for (const pointer of allRoundTargetPaths) {
        const isActive = activeTargetSet.has(pointer);
        const tableMatch = /^\/tableBindings\/(0|[1-9]\d*)(?:\/[A-Za-z0-9_]+)?$/.exec(pointer);
        if (tableMatch) {
            const bindingIndex = Number(tableMatch[1]);
            const binding = candidateDraft.tableBindings?.[bindingIndex];
            if (!validateAndRecordBindingOrdinals(binding, bindingIndex, isActive)) return fallback();
            continue;
        }

        const sectionBodyMatch = /^\/sections\/(0|[1-9]\d*)\/body$/.exec(pointer);
        if (sectionBodyMatch) {
            if (explicitTableBindingIndices.size === 0 || blockingIssues.length === 0) {
                return fallback();
            }
            if (!blockingIssues.every(isPureTableIssue)) return fallback();
            const sectionIndex = Number(sectionBodyMatch[1]);
            const bodyText = String(candidateDraft.sections?.[sectionIndex]?.body || '');
            const sectionTableMarkers = [...bodyText.matchAll(/\[\[TABLE_(\d+)\]\]/g)].map(m => Number(m[1]));
            if (sectionTableMarkers.length === 0) return fallback();
            const pairedWithTargetedBinding = [...explicitTableBindingIndices].some(bindingIndex => {
                const tableIndex = candidateDraft.tableBindings?.[bindingIndex]?.tableIndex;
                return Number.isSafeInteger(tableIndex) && sectionTableMarkers.includes(tableIndex);
            });
            if (!pairedWithTargetedBinding) return fallback();
            for (const tableIndex of sectionTableMarkers) {
                const bindingIndex = (candidateDraft.tableBindings || []).findIndex(item => item?.tableIndex === tableIndex);
                if (bindingIndex < 0) return fallback();
                if (!validateAndRecordBindingOrdinals(candidateDraft.tableBindings[bindingIndex], bindingIndex, isActive)) {
                    return fallback();
                }
            }
            continue;
        }

        if (pointer === '/readerTitle') {
            if (typeof candidateDraft.readerTitle !== 'string') return fallback();
            if (isActive) {
                hasTitleTarget = true;
                const titleTokens = [
                    ...(String(candidateDraft.readerTitle || '').match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || []),
                    ...(String(candidateDraft.oneSentenceThesis || '').match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || [])
                ].slice(0, 4);
                for (const token of titleTokens) {
                    localTermHits.push(...locateTermHitOffsets(sourceText, token));
                }
            }
            continue;
        }

        const bridgeMatch = /^\/conceptBridges\/(0|[1-9]\d*)(?:\/(?:terms|explanation)(?:\/(?:0|[1-9]\d*))?)?$/.exec(pointer);
        if (bridgeMatch) {
            const bridgeIndex = Number(bridgeMatch[1]);
            const bridge = candidateDraft.conceptBridges?.[bridgeIndex];
            if (!isPlainObject(bridge) || !Array.isArray(bridge.terms) || bridge.terms.length === 0) {
                return fallback();
            }
            let bridgeHitsCount = 0;
            const bridgeHits = [];
            for (const term of bridge.terms) {
                if (typeof term !== 'string' || !term.trim()) return fallback();
                const hits = locateTermHitOffsets(sourceText, term);
                if (hits.length === 0) return fallback();
                bridgeHitsCount += hits.length;
                bridgeHits.push(...hits);
            }
            if (bridgeHitsCount === 0) return fallback();
            if (isActive) {
                hasBridgeTarget = true;
                localTermHits.push(...bridgeHits);
            }
            continue;
        }

        return fallback();
    }

    // 条件 3（完整阻断问题归属校验）：全部 blockingIssues 必须被已核验的激活+顺延目标集合严格覆盖
    for (const issue of blockingIssues) {
        const message = String(issue?.message || '');
        const issuePath = issue?.path;
        if (typeof issuePath === 'string' && issuePath.length > 0) {
            const coveredByTarget = allRoundTargetPaths.some(targetPath =>
                issuePath === targetPath
                || issuePath.startsWith(`${targetPath}/`)
                || targetPath.startsWith(`${issuePath}/`)
            );
            if (!coveredByTarget) return fallback();
        } else {
            const mappedToTable = isNullPathTableIssueCovered(
                issue,
                allVerifiedBindingIndices,
                allVerifiedTableMarkers,
                allVerifiedOrdinals
            );
            const mappedToTitle = /readerTitle|读者标题/.test(message)
                && allRoundTargetPaths.includes('/readerTitle');
            const bridgeMatches = [...message.matchAll(/conceptBridges\[(\d+)\]/g)].map(m => m[1]);
            const mappedToBridge = bridgeMatches.length > 0
                && bridgeMatches.every(idx =>
                    allRoundTargetPaths.some(p => p === `/conceptBridges/${idx}`
                        || p.startsWith(`/conceptBridges/${idx}/`))
                );
            if (!mappedToTable && !mappedToTitle && !mappedToBridge) {
                return fallback();
            }
        }
    }

    if (hasBridgeTarget && localTermHits.length === 0) {
        return fallback();
    }

    // 构造紧凑切片：激活目标产出完整切片窗口，同时保留 currentIssues 引用的合格原表矩阵以确保 readerVerifiedTableIndexExamples 示例不丢失
    const sections = [...extractPreservedPolicyHeaders(fullSourceEvidence)];
    const issueExampleOrdinals = collectIssueExampleOrdinals(allIssues, candidateDraft, allTables);
    const artifactOrdinals = new Set([...activeTableOrdinals, ...issueExampleOrdinals]);
    if (artifactOrdinals.size > MAX_PROVABLE_TABLE_ORDINALS) {
        return fallback();
    }

    if (artifactOrdinals.size > 0) {
        const sortedOrdinals = [...artifactOrdinals].sort((a, b) => a - b);
        const artifactLines = [
            '[READER_ARTIFACTS] 结构化原文图表与公式（局部补丁可证明覆盖原表切片）',
            `TABLE_ORDINALS_AVAILABLE: ${JSON.stringify(availableSelectionOrdinals)}`
        ];
        for (const ordinal of sortedOrdinals) {
            const table = allTables.find(item => item?.ordinal === ordinal);
            const effectiveRows = effectiveReaderTableRows(table);
            const cleanCaption = String(table.caption || '').replace(/\s+/g, ' ').trim();
            const isActiveTable = activeTableOrdinals.has(ordinal);
            const tableBlock = [
                isActiveTable
                    ? `[REPAIR_PROVABLE_SLICE:TABLE_${ordinal}]`
                    : `[READER_ISSUE_REFERENCED_TABLE:${ordinal}]`,
                `TABLE_${ordinal}: ${cleanCaption}`,
                `TABLE_${ordinal}_SELECTION: ${JSON.stringify(generationSelectionProfileForSlice(table))}`,
                `TABLE_${ordinal}_HEADER_ROWS: ${JSON.stringify(effectiveRows.headerRows)}`,
                `TABLE_${ordinal}_INDEX_RULES: ${JSON.stringify({
                    indexBase: 0,
                    minimumSelectedRows: 2,
                    minimumSelectedColumns: 2,
                    maximumRowIndex: table.matrix.length - 1,
                    maximumColumnIndex: table.matrix[0].length - 1,
                    distinctIndexesRequired: true,
                    action: 'Select only this table’s shown source cells. Counts are not indexes; do not copy adjacent-table dimensions.'
                })}`,
                `TABLE_${ordinal}_SHAPE: ${JSON.stringify({
                    rows: table.matrix.length,
                    columns: table.matrix[0].length,
                    shownRows: table.matrix.length,
                    role: 'unknown'
                })}`,
                JSON.stringify(table.matrix)
            ];
            if (isActiveTable) {
                tableBlock.push(`TABLE_${ordinal}_MARKDOWN:\n${renderMatrixAsMarkdown(table)}`);
                const textWindows = collectTableTextWindows(sourceText, table);
                if (textWindows.length > 0) {
                    for (let idx = 0; idx < textWindows.length; idx++) {
                        const win = textWindows[idx];
                        tableBlock.push(
                            `[TABLE_${ordinal}_SOURCE_CONTEXT_${idx + 1}/${textWindows.length}]\n`
                            + sliceUtf16WellFormed(sourceText, win.start, win.end)
                        );
                    }
                } else {
                    tableBlock.push(
                        `[TABLE_${ordinal}_SOURCE_OPENING_CONTEXT]\n`
                        + sliceUtf16WellFormed(sourceText, 0, Math.min(sourceText.length, TABLE_CONTEXT_RADIUS_CHARS * 2))
                    );
                }
            }
            artifactLines.push(tableBlock.join('\n'));
        }
        sections.push(artifactLines.join('\n\n'));
    }

    if (hasTitleTarget || hasBridgeTarget) {
        const rawTermWindows = localTermHits.map(hit => ({
            start: hit.index - LOCAL_NODE_CONTEXT_RADIUS_CHARS,
            end: hit.index + hit.length + LOCAL_NODE_CONTEXT_RADIUS_CHARS,
            label: hit.term
        }));
        const mergedTermWindows = mergeWindows(rawTermWindows, sourceText, MAX_LOCAL_NODE_HIT_WINDOWS);
        if (hasBridgeTarget && mergedTermWindows.length === 0) return fallback();

        const localBlocks = [
            '[REPAIR_PROVABLE_SLICE:LOCAL_NODES]',
            `[READER_OPENING_ABSTRACT]\n${sliceUtf16WellFormed(sourceText, 0, Math.min(sourceText.length, OPENING_ABSTRACT_MAX_CHARS))}`
        ];
        for (let idx = 0; idx < mergedTermWindows.length; idx++) {
            const win = mergedTermWindows[idx];
            localBlocks.push(
                `[READER_TERM_CONTEXT_${idx + 1}/${mergedTermWindows.length}] terms=${JSON.stringify(win.labels)}\n`
                + sliceUtf16WellFormed(sourceText, win.start, win.end)
            );
        }
        sections.push(localBlocks.join('\n\n'));
    }

    const sliced = sections.filter(Boolean).join('\n\n');
    if (!sliced || !sliced.trim() || !sliced.isWellFormed()) return fallback();

    const effectiveMaxChars = Number.isSafeInteger(maxChars) && maxChars > 0
        ? maxChars
        : fullSourceEvidence.length;
    if (sliced.length > effectiveMaxChars) return fallback();
    if (sliced.length >= fullSourceEvidence.length * PROVABLE_SLICE_MAX_RATIO) {
        return fallback();
    }
    return sliced;
}

module.exports = {
    PROVABLE_SLICE_MAX_RATIO,
    TABLE_CONTEXT_RADIUS_CHARS,
    LOCAL_NODE_CONTEXT_RADIUS_CHARS,
    sliceUtf16WellFormed,
    isCompleteOriginalTableDefinition,
    countDraftProseChineseChars,
    selectProvableRepairSourceEvidence
};
