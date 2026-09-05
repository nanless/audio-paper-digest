'use strict';

// Reader candidates are recovery inputs, never production proof. Every merged
// candidate must still pass the caller's full Reader parser and source gates.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { READER_LIMITS } = require('./reader-contract.js');
const { locateReaderDraftTables } = require('./reader-draft-order.js');

const REPAIR_VERSION = 'reader-node-repair-v1';
const ARRAY_FIELDS = ['sections', 'conceptBridges', 'figurePlacements', 'tableBindings', 'formulaBindings'];
const ROOT_FIELDS = ['version', 'readerTitle', 'oneSentenceThesis', ...ARRAY_FIELDS];
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const hashDraft = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const shaText = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function assertSafeJson(value) {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
        throw new Error('Reader repair rejects non-plain objects');
    }
    for (const key of Object.keys(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) {
            throw new Error(`Reader repair rejects unsafe key: ${key}`);
        }
        assertSafeJson(value[key]);
    }
}

function parseRepairableDraft(raw) {
    let value;
    try {
        value = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw);
        assertSafeJson(value);
    } catch { return null; }
    if (!value || Array.isArray(value) || typeof value !== 'object'
        || Object.keys(value).some(key => !ROOT_FIELDS.includes(key))
        || !ROOT_FIELDS.every(key => own(value, key))
        || value.version !== 3
        || typeof value.readerTitle !== 'string' || typeof value.oneSentenceThesis !== 'string'
        || ARRAY_FIELDS.some(field => !Array.isArray(value[field]))
        || value.sections.length < READER_LIMITS.minimumSections || value.sections.length > READER_LIMITS.maximumSections
        || value.conceptBridges.length < READER_LIMITS.minimumConceptBridges
        || value.conceptBridges.length > READER_LIMITS.maximumConceptBridges
        || value.figurePlacements.length > READER_LIMITS.maximumFigures) return null;
    return value;
}

function nodeAt(draft, pointer) {
    if (['/readerTitle', '/oneSentenceThesis'].includes(pointer)) {
        return draft[pointer.slice(1)];
    }
    const match = /^\/(sections|conceptBridges|figurePlacements|tableBindings|formulaBindings)\/(0|[1-9]\d*)(\/body)?$/.exec(pointer);
    if (!match || (match[3] && match[1] !== 'sections')) throw new Error(`Reader patch path is not allowed: ${pointer}`);
    const list = draft[match[1]];
    const index = Number(match[2]);
    if (!Array.isArray(list) || index >= list.length || !own(list, index)) {
        throw new Error(`Reader patch index is out of bounds: ${pointer}`);
    }
    if (match[3]) {
        if (!list[index] || !own(list[index], 'body')) throw new Error(`Reader patch body is missing: ${pointer}`);
        return list[index].body;
    }
    return list[index];
}

function applyReaderPatch(draft, patch, allowedPaths, options = {}) {
    assertSafeJson(patch);
    if (!patch || Object.keys(patch).sort().join(',') !== 'draftSha256,replacements,version'
        || patch.version !== 1 || patch.draftSha256 !== hashDraft(draft)
        || !Array.isArray(patch.replacements) || patch.replacements.length < 1
        || patch.replacements.length > 8) throw new Error('Reader patch has invalid shape or stale draft SHA');
    const allowed = new Set(allowedPaths);
    const seen = [];
    for (const item of patch.replacements) {
        if (!item || Object.keys(item).sort().join(',') !== 'oldSha256,path,value'
            || typeof item.path !== 'string' || !allowed.has(item.path)) {
            throw new Error('Reader patch contains an unknown or unauthorized target');
        }
        if (seen.some(pointer => pointer === item.path || pointer.startsWith(`${item.path}/`)
            || item.path.startsWith(`${pointer}/`))) throw new Error('Reader patch has duplicate or overlapping targets');
        const old = nodeAt(draft, item.path);
        if (item.oldSha256 !== hashDraft(old)) throw new Error(`Reader patch has stale node SHA: ${item.path}`);
        if ((item.path.endsWith('/body') || ['/readerTitle', '/oneSentenceThesis'].includes(item.path))
            && typeof item.value !== 'string') throw new Error('Reader patch text replacement must be a string');
        if (!item.path.endsWith('/body') && !['/readerTitle', '/oneSentenceThesis'].includes(item.path)
            && (!item.value || typeof item.value !== 'object' || Array.isArray(item.value))) {
            throw new Error('Reader patch node replacement must be an object');
        }
        if (Array.isArray(options.availableFigureOrdinals)) {
            const ordinals = [...JSON.stringify(item.value).matchAll(/\[\[FIGURE_(\d+)\]\]/g)]
                .map(match => Number(match[1]));
            if (item.path.startsWith('/figurePlacements/') && Number.isInteger(item.value?.figureOrdinal)) {
                ordinals.push(item.value.figureOrdinal);
            }
            if (ordinals.some(ordinal => !options.availableFigureOrdinals.includes(ordinal))) {
                throw new Error('Reader patch figure was not included as pixels in this repair request');
            }
        }
        seen.push(item.path);
    }
    const merged = structuredClone(draft);
    for (const item of patch.replacements) {
        const parts = item.path.slice(1).split('/');
        let target = merged;
        for (const part of parts.slice(0, -1)) target = target[part];
        target[parts.at(-1)] = structuredClone(item.value);
    }
    assertSafeJson(merged);
    return merged;
}

// Independent diagnostics supplement (never replace) the authoritative parser.
function collectDraftIssues(draft, parserError, options = {}) {
    const issues = [];
    if (parserError) issues.push({ path: null, message: String(parserError.message || parserError) });
    if (Array.isArray(parserError?.readerIssues)) issues.push(...parserError.readerIssues);
    if (!draft) return issues;
    draft.sections.forEach((section, index) => {
        if (!section || typeof section !== 'object' || Array.isArray(section)
            || Object.keys(section).sort().join(',') !== 'body,heading,kind') {
            issues.push({ path: `/sections/${index}`, message: '小节必须只含 kind、heading、body' });
        } else if (typeof section.body !== 'string' || section.body.trim().length < 120) {
            issues.push({ path: `/sections/${index}/body`, message: '小节 body 至少 120 字符' });
        }
    });
    for (const field of ['conceptBridges', 'figurePlacements', 'formulaBindings']) {
        draft[field].forEach((binding, index) => {
            if (field === 'conceptBridges' && (!Array.isArray(binding?.terms) || binding.terms.length !== 2
                || binding.terms.some(term => typeof term !== 'string' || term.trim().length < 2 || term.trim().length > 48))) {
                issues.push({ path: `/${field}/${index}`,
                    message: `${field}[${index}].terms 必须是恰含2个真实术语字符串的数组，每项2–48字符` });
            }
            const marker = binding?.marker;
            const expectedKind = field === 'conceptBridges' ? binding?.sectionKind : binding?.targetKind;
            const matches = draft.sections.flatMap((section, sectionIndex) => (
                typeof marker === 'string' && marker && typeof section?.body === 'string'
                    ? section.body.split(/\n\s*\n/).filter(block => block.trim() === marker)
                        .map(() => sectionIndex) : []
            ));
            if (matches.length !== 1 || draft.sections[matches[0]]?.kind !== expectedKind) {
                issues.push({ path: `/${field}/${index}`, message: `${field}[${index}] marker 必须唯一独占一段并位于声明 kind 小节` });
            }
        });
    }
    collectTableBindingIssues(draft, options).forEach(issue => issues.push(issue));
    require('./reader-source-diagnostics.js').buildReaderSourceDiagnostics({ draft,
        sourceText: options.sourceText, structuredArtifacts: options.structuredArtifacts, parserError
    }).forEach(issue => issues.push(issue));
    try {
        const tables = require('./reader-tables.js');
        const compiled = tables.compileReaderTableSelections(draft.sections, draft.tableBindings, options.structuredArtifacts);
        tables.validateReaderResultTableCoverage(compiled.sections, options.structuredArtifacts);
    } catch (error) {
        if (error.message.startsWith('读者文章主结果表覆盖不足')) {
            issues.push({ path: null, code: 'reader_result_table_missing', message: error.message });
        }
    }
    // This is a preflight estimate, not a second length gate. The parser later
    // counts its normalized/compiled article, which remains authoritative.
    const countText = draft.sections.map(section => `${section?.heading || ''}\n${section?.body || ''}`).join('\n')
        + draft.conceptBridges.map(bridge => `${(Array.isArray(bridge?.terms) ? bridge.terms : []).join(' ')} ${bridge?.explanation || ''}`).join('\n');
    const chineseChars = (countText.match(/[\u3400-\u9fff]/g) || []).length;
    if (chineseChars < READER_LIMITS.minimumChineseChars || chineseChars > READER_LIMITS.maximumChineseChars) {
        issues.push({ path: null, code: 'reader_length_preflight', diagnosticOnly: true,
            message: `Reader 篇幅预估为 ${chineseChars} 个汉字（标题、正文和术语桥；不含绑定JSON），`
                + `最终门禁为 ${READER_LIMITS.minimumChineseChars}–${READER_LIMITS.maximumChineseChars}；`
                + (chineseChars < READER_LIMITS.minimumChineseChars
                    ? `目前估计至少还需 ${READER_LIMITS.minimumChineseChars - chineseChars} 字。修复表格时同时扩写已有方法、执行顺序或实验比较段落，保留正确事实。`
                    : '压缩重复段落，保留正确事实。')
                + '此项仅预检提示，最终中文字数以完整parser组装后为准。' });
    }
    return issues;
}

function collectTableBindingIssues(draft, options = {}) {
    const { extractMarkdownTables } = require('../analysis-contract.js');
    const { renderReaderTableSelection } = require('./reader-tables.js');
    const exactKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).sort().join(',') === expected.slice().sort().join(',');
    const issues = [];
    const add = (index, message, extra = {}) => issues.push({ path: `/tableBindings/${index}`,
        message: `tableBindings[${index}] ${message}`, ...extra });
    const tables = draft.sections.flatMap((section, sectionIndex) => extractMarkdownTables(String(section?.body || ''))
        .map(table => ({ ...table, sectionIndex })));
    const markers = draft.sections.flatMap((section, sectionIndex) => [...String(section?.body || '').matchAll(/\[\[TABLE_([^\]]*)\]\]/g)]
        .map(match => ({ marker: match[0], tableIndex: Number(match[1]), sectionIndex })));
    draft.tableBindings.forEach((binding, index) => {
        if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
            add(index, '必须是合法表格绑定对象'); return;
        }
        if (binding.tableIndex !== index + 1) add(index, 'tableIndex 必须按最终正文表格顺序从 1 唯一递增');
        if (own(binding, 'selection')) {
            if (!exactKeys(binding, ['tableIndex', 'selection'])
                || !exactKeys(binding.selection, ['sourceTableOrdinal', 'sourceRows', 'sourceColumns'])) {
                add(index, 'selection 只含 sourceTableOrdinal/sourceRows/sourceColumns，不能混入 sourceType/cellBindings/sourceQuotes');
            } else if (options.structuredArtifacts) {
                try { renderReaderTableSelection(binding, options.structuredArtifacts); }
                catch (error) { add(index, error.message); }
            }
            const marker = `[[TABLE_${binding.tableIndex}]]`;
            const occurrences = draft.sections.reduce((count, section) => count
                + String(section?.body || '').split(/\n\s*\n/).filter(block => block.trim() === marker).length, 0);
            if (occurrences !== 1) add(index, `的 ${marker} 必须在正文中唯一独占一段`);
            return;
        }
        if (!exactKeys(binding, ['tableIndex', 'sourceType', 'sourceTableOrdinal', 'cellBindings', 'sourceQuotes'])) {
            add(index, '普通绑定必须且仅含 tableIndex/sourceType/sourceTableOrdinal/cellBindings/sourceQuotes');
        }
        if (binding.sourceType === 'source_quotes') {
            if (binding.sourceTableOrdinal !== null || !Array.isArray(binding.cellBindings)
                || binding.cellBindings.length !== 0 || !Array.isArray(binding.sourceQuotes) || binding.sourceQuotes.length < 1) {
                add(index, 'source_quotes 结构非法：sourceTableOrdinal 必须为 null；cellBindings 必须是 []，'
                    + '不接受 quoteIndex/value/渲染坐标；sourceQuotes 必须为非空原文字符串数组');
            }
            if (Array.isArray(binding.sourceQuotes)) {
                const invalid = binding.sourceQuotes.flatMap((quote, quoteIndex) => (
                    typeof quote !== 'string' || quote.length < 12 || quote.length > 4000
                        || (typeof options.sourceText === 'string' && !options.sourceText.includes(quote)) ? [quoteIndex] : []
                ));
                if (invalid.length) add(index, `sourceQuotes 的索引 ${invalid.slice(0, 12).join(', ')} 未提供全文中12–4000字符的连续原句；`
                    + '不要只摘独立数值或把引文写成对象。原文双写数值可留在引文中，正文写法仍须通过既有来源门禁。',
                { diagnosticOnly: true });
            }
        } else if (binding.sourceType === 'artifact_table') {
            if (!Array.isArray(binding.cellBindings) || binding.sourceQuotes?.length !== 0) {
                add(index, 'artifact_table 要求完整 cellBindings 和空 sourceQuotes 数组');
            } else if (binding.cellBindings.some(cell => !exactKeys(cell,
                ['renderedRow', 'renderedColumn', 'sourceRow', 'sourceColumn']))) {
                add(index, 'artifact_table 每个cellBindings项必须且仅含 renderedRow/renderedColumn/sourceRow/sourceColumn');
            }
        } else add(index, 'sourceType 只能为 source_quotes 或 artifact_table；selection 是独立互斥结构');
        const matchingMarkers = markers.filter(marker => marker.tableIndex === binding.tableIndex);
        for (const marker of matchingMarkers) {
            add(index, `使用 ${binding.sourceType || '普通绑定'} 时正文必须直接写 Markdown 表，不能使用 ${marker.marker}；`
                + `同步修改 sections[${marker.sectionIndex}].body 与本绑定项`);
            issues.push({ path: `/sections/${marker.sectionIndex}/body`,
                message: `sections[${marker.sectionIndex}].body 的 ${marker.marker} 没有selection绑定，`
                    + `需由模型按原文写出完整Markdown表；tableBindings[${index}]本身不会生成表格` });
        }
    });
    for (const marker of markers) {
        if (!draft.tableBindings.some(binding => binding?.selection && binding.tableIndex === marker.tableIndex)) {
            const message = `sections[${marker.sectionIndex}].body 存在未绑定的 ${marker.marker}；只有selection模式可以使用TABLE marker`;
            if (!issues.some(issue => issue.path === `/sections/${marker.sectionIndex}/body`)) {
                issues.push({ path: `/sections/${marker.sectionIndex}/body`, message });
            }
        }
    }
    const selectionCount = draft.tableBindings.filter(binding => binding?.selection).length;
    if (tables.length + selectionCount !== draft.tableBindings.length) {
        issues.push({ path: null, diagnosticOnly: true,
            message: `Reader 表格清单尚未闭合：正文实际Markdown表 ${tables.length} 张、selection ${selectionCount} 项、`
                + `tableBindings ${draft.tableBindings.length} 项。source_quotes/artifact_table 都必须有对应的实际Markdown；`
                + '由完整parser决定现有确定性quote补绑定能否恢复。' });
    }
    return issues;
}

function buildRepairTargets(draft, issues) {
    const paths = new Set();
    const add = pointer => {
        try {
            nodeAt(draft, pointer);
            if (/^\/sections\/\d+\/body$/.test(pointer) && paths.has(pointer.slice(0, -5))) return;
            if (/^\/sections\/\d+$/.test(pointer)) paths.delete(`${pointer}/body`);
            paths.add(pointer);
        } catch { /* Invalid root shape needs full retry. */ }
    };
    const sectionForBinding = (field, index) => {
        const binding = draft[field]?.[index];
        if (!binding) return;
        draft.sections.forEach((section, sectionIndex) => {
            if ((binding.marker && String(section?.body || '').includes(binding.marker))
                || section?.kind === (binding.targetKind || binding.sectionKind)) add(`/sections/${sectionIndex}/body`);
        });
    };
    for (const issue of issues) {
        if (issue.path) add(issue.path);
        if (issue.bindingPath) add(issue.bindingPath);
        const message = issue.message || '';
        if (/主结果表覆盖不足/.test(message)) {
            draft.sections.forEach((section, index) => {
                if (['result', 'ablation'].includes(section?.kind)) add(`/sections/${index}/body`);
            });
        }
        for (const match of message.matchAll(/(sections|conceptBridges|figurePlacements|tableBindings|formulaBindings)\[(\d+)\](?:\.(body|heading|kind))?/g)) {
            add(`/${match[1]}/${match[2]}${match[1] === 'sections' && match[3] === 'body' ? '/body' : ''}`);
            sectionForBinding(match[1], Number(match[2]));
        }
        const direct = /^\/(conceptBridges|figurePlacements|formulaBindings)\/(\d+)$/.exec(issue.path || '');
        if (direct) sectionForBinding(direct[1], Number(direct[2]));
        if (/读者标题|readerTitle/.test(message)) add('/readerTitle');
        if (/oneSentenceThesis/.test(message)) add('/oneSentenceThesis');
        if (issue.code === 'reader_length_preflight' || /中文字数|篇幅预估/.test(message)) {
            draft.sections.forEach((_section, index) => add(`/sections/${index}/body`));
        }
        if (/表|tableBindings|cell|quote/i.test(message)) {
            const boundIndex = /^\/tableBindings\/(\d+)$/.exec(issue.bindingPath || issue.path || '');
            const wanted = Number(boundIndex ? Number(boundIndex[1]) + 1 : message.match(/第\s*(\d+)\s*张/)?.[1]
                || (message.match(/tableBindings\[(\d+)\]/) ? Number(message.match(/tableBindings\[(\d+)\]/)[1]) + 1 : 0));
            for (const table of locateReaderDraftTables(draft)) {
                if (!wanted || wanted === table.tableIndex) add(table.path);
            }
            draft.tableBindings.forEach((_binding, index) => {
                if (!wanted || wanted === index + 1) add(`/tableBindings/${index}`);
            });
            if (![...paths].some(pointer => pointer.startsWith('/sections/'))) {
                draft.sections.forEach((section, index) => {
                    if (['training', 'experiment_setup', 'result', 'ablation'].includes(section?.kind)) add(`/sections/${index}/body`);
                });
            }
        }
    }
    // Global readability/length errors cannot safely be localized from a regex
    // message. Keep all body targets reviewable, but cap each patch to 8 nodes.
    if (!paths.size) draft.sections.forEach((_section, index) => add(`/sections/${index}/body`));
    return [...paths].map(pointer => ({ path: pointer, oldSha256: hashDraft(nodeAt(draft, pointer)), value: nodeAt(draft, pointer) }));
}

function buildRepairContext(draft, issues, sourceEvidence, sourceText = '') {
    const targets = buildRepairTargets(draft, issues);
    const targetText = JSON.stringify(targets);
    const figureOrdinals = new Set();
    for (const match of targetText.matchAll(/\[\[FIGURE_(\d+)\]\]/g)) figureOrdinals.add(Number(match[1]));
    for (const target of targets) {
        if (target.path.startsWith('/figurePlacements/') && Number.isInteger(target.value?.figureOrdinal)) {
            figureOrdinals.add(target.value.figureOrdinal);
        }
    }
    // Preserve complete evidence when safe narrowing cannot prove semantic
    // coverage. Output and allowed mutations remain strictly local regardless.
    const evidence = String(sourceEvidence || '');
    const exactQuotes = [...new Set(targets.flatMap(target => target.value?.sourceQuotes || []))]
        .filter(quote => typeof quote === 'string' && String(sourceText).includes(quote));
    return { draftSha256: hashDraft(draft), targets, issues, evidence,
        exactQuotes, figureOrdinals: [...figureOrdinals], evidenceMode: 'full-evidence-local-output' };
}

function assertSafeDirectory(directory, create = false) {
    const absolute = path.resolve(directory);
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        let stat;
        try { stat = fs.lstatSync(cursor); } catch (error) {
            if (error.code !== 'ENOENT' || !create) throw error;
            fs.mkdirSync(cursor, { mode: 0o700 });
            stat = fs.lstatSync(cursor);
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe Reader candidate directory: ${cursor}`);
    }
    return absolute;
}

function candidatePath(directory, identity) {
    return path.join(directory, `${hashDraft(identity)}.json`);
}

function loadFailedCandidate(directory, identity) {
    try { assertSafeDirectory(directory); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const filename = candidatePath(directory, identity);
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES || (stat.mode & 0o777) !== 0o600) {
            throw new Error('Unsafe Reader candidate file or permissions');
        }
        const envelope = JSON.parse(fs.readFileSync(fd, 'utf8'));
        assertSafeJson(envelope);
        if (envelope.version !== REPAIR_VERSION || hashDraft(envelope.identity) !== hashDraft(identity)
            || envelope.payloadSha256 !== hashDraft(envelope.payload)
            || envelope.payload?.status !== 'failed'
            || !Number.isInteger(envelope.payload.attempts) || envelope.payload.attempts < 0
            || !Number.isInteger(envelope.payload.fullAttempts) || envelope.payload.fullAttempts < 0
            || (envelope.payload.transportFailures !== undefined
                && (!Number.isInteger(envelope.payload.transportFailures) || envelope.payload.transportFailures < 0))
            || !Number.isInteger(envelope.payload.noProgress) || envelope.payload.noProgress < 0
            || typeof envelope.payload.failureSignature !== 'string'
            || !Array.isArray(envelope.payload.issues)
            || envelope.payload.issues.some(issue => !issue || typeof issue.message !== 'string'
                || (issue.path !== null && typeof issue.path !== 'string'))
            || (envelope.payload.draft && !parseRepairableDraft(envelope.payload.draft))) {
            throw new Error('Corrupt or drifted Reader candidate');
        }
        return envelope.payload;
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error(`Reader candidate refused: ${error.message}`, { cause: error });
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function saveFailedCandidate(directory, identity, payload) {
    assertSafeJson(identity);
    assertSafeJson(payload);
    if (payload.status !== 'failed') throw new Error('Reader candidate cannot certify success');
    const absolute = assertSafeDirectory(directory, true);
    const filename = candidatePath(absolute, identity);
    try {
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe Reader candidate destination');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const serialized = JSON.stringify({ version: REPAIR_VERSION, identity, payload, payloadSha256: hashDraft(payload) });
    if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw new Error('Reader candidate exceeds recovery size budget');
    const temporary = path.join(absolute, `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
    let fd;
    try {
        fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, serialized);
        fs.fsyncSync(fd);
        fs.closeSync(fd); fd = undefined;
        assertSafeDirectory(directory);
        fs.renameSync(temporary, filename);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return filename;
}

function retireFailedCandidate(directory, identity) {
    // Retire only an independently replayed failure at this exact identity.
    // There is deliberately no successful-candidate cache to load next time.
    if (!loadFailedCandidate(directory, identity)) return null;
    const absolute = assertSafeDirectory(directory);
    const filename = candidatePath(absolute, identity);
    const retired = path.join(absolute, `${hashDraft(identity)}.${crypto.randomUUID()}.resolved.json`);
    fs.renameSync(filename, retired);
    return retired;
}

module.exports = { REPAIR_VERSION, hashDraft, shaText, parseRepairableDraft, collectDraftIssues,
    buildRepairTargets, applyReaderPatch, buildRepairContext, loadFailedCandidate, saveFailedCandidate,
    retireFailedCandidate };
