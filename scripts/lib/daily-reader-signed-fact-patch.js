'use strict';
// Pure range authorization. Scientific/source validation stays in the normal Reader parser.
const { isDeepStrictEqual } = require('node:util');
const repair = require('./reader-repair');
const CONTRACT = 'daily-reader-signed-correction-v2';
const fail = message => { throw new Error(`签名Reader事实范围拒绝：${message}`); };
const exact = (value, keys) => value && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
function nodeAt(draft, pointer) {
    const parts = pointer.split('/').slice(1);
    let value = draft;
    for (const part of parts) {
        if (!value || !Object.hasOwn(value, part)) fail('只能修改真实既有节点');
        value = value[part];
    }
    return value;
}
const tables = draft => require('../analysis-contract').extractMarkdownTables(draft.sections.map(s => s.body).join('\n\n'));
function applyBoundedFactPatch(original, record, feedback, source) {
    if (record.contract !== CONTRACT || !require('./saved-fact-feedback').readerOnlyFeedback(feedback)) fail('须为v2及严格Reader-only事实包');
    const replacements = record.patch?.replacements, ranges = record.rangeCorrections;
    if (!Array.isArray(replacements) || replacements.length < 1 || replacements.length > 8
        || !Array.isArray(ranges) || !ranges.length || ranges.length > 8
        || !Array.isArray(record.tableCorrections || [])) fail('须为1–8个既有节点的显式范围补丁');
    const allowed = [], expected = new Map(), allEdits = [];
    for (const range of ranges) {
        if (!exact(range, ['path', 'oldSha256', 'edits'])
            || !/^\/(?:sections\/(?:0|[1-9]\d*)\/body|conceptBridges\/(?:0|[1-9]\d*)\/explanation)$/.test(range.path)
            || expected.has(range.path) || !Array.isArray(range.edits) || !range.edits.length || range.edits.length > 20) fail('文本路径或范围声明不合法');
        const old = nodeAt(original, range.path);
        if (typeof old !== 'string' || range.oldSha256 !== repair.hashDraft(old)) fail('原节点SHA不一致');
        let cursor = 0, value = '';
        for (const edit of range.edits) {
            if (!exact(edit, ['claimIndex', 'claimStart', 'start', 'end', 'from', 'to', ...(Object.hasOwn(edit, 'rawClaim') ? ['rawClaim'] : [])])
                || ![edit.claimIndex, edit.claimStart, edit.start, edit.end].every(Number.isSafeInteger)
                || edit.claimIndex < 0 || edit.claimStart < 0 || edit.start < cursor || edit.end <= edit.start
                || typeof edit.from !== 'string' || typeof edit.to !== 'string' || !edit.to.trim()
                || edit.from === edit.to || edit.to.length > 3000 || edit.to.includes('![')
                || edit.from.includes('![')) fail('范围须有序、不重叠且为有界实际替换，不能编辑原图');
            const claim = feedback.rejectedReaderClaims[edit.claimIndex];
            const rawClaim = edit.rawClaim ?? claim;
            if (typeof claim !== 'string' || !claim || typeof rawClaim !== 'string' || !rawClaim || rawClaim.length > 3000
                || !record.parentPaper?.apiReaderArticle?.includes(claim)
                || old.slice(edit.claimStart, edit.claimStart + rawClaim.length) !== rawClaim
                || edit.start < edit.claimStart || edit.end > edit.claimStart + rawClaim.length
                || old.slice(edit.start, edit.end) !== edit.from) fail('替换越出当前逐字rejected claim范围');
            if (edit.rawClaim !== undefined) {
                const format = require('../deep-analyzer').normalizeReaderProseFormatting;
                if (format(rawClaim) !== claim || !format(old).includes(claim)) fail('raw/rendered原句不能按实际正常producer精确映射');
            }
            value += old.slice(cursor, edit.start) + edit.to; cursor = edit.end;
            allEdits.push({ ...edit, path: range.path });
        }
        value += old.slice(cursor);
        expected.set(range.path, value); allowed.push(range.path);
    }
    if (allEdits.length > 32) fail('总替换范围超过有界上限');
    const originalTables = tables(original);
    for (const proof of record.tableCorrections || []) {
        if (!exact(proof, ['path', 'sectionPath', 'claimIndex', 'oldTableSha256', 'sourceTableOrdinal', 'sourceDomSha256', 'sourceTableSha256'])
            || !/^\/tableBindings\/(?:0|[1-9]\d*)$/.test(proof.path) || expected.has(proof.path)) fail('表绑定授权字段或路径不合法');
        const before = nodeAt(original, proof.path), section = nodeAt(original, proof.sectionPath);
        const table = originalTables[before.tableIndex - 1];
        const sources = (source?.structuredArtifacts?.tables || []).filter(t => t.ordinal === proof.sourceTableOrdinal
            && t.sourceDomSha256 === proof.sourceDomSha256 && t.recoveryStatus === 'complete');
        const edits = allEdits.filter(e => e.path === proof.sectionPath && e.claimIndex === proof.claimIndex);
        if (!table || typeof section !== 'string' || section.split(table.markdown).length !== 2
            || repair.hashDraft(table.markdown) !== proof.oldTableSha256 || sources.length !== 1
            || repair.hashDraft(sources[0]) !== proof.sourceTableSha256
            || !edits.some(e => e.start >= section.indexOf(table.markdown)
                && e.end <= section.indexOf(table.markdown) + table.markdown.length)) fail('须绑定同一受拒原表及完整唯一source DOM表');
        const replacement = replacements.find(r => r.path === proof.path)?.value;
        if (!replacement || replacement.tableIndex !== before.tableIndex || replacement.sourceType !== 'artifact_table'
            || replacement.sourceTableOrdinal !== proof.sourceTableOrdinal) fail('修复表绑定只能引用证明中的同一原DOM表');
        expected.set(proof.path, replacement); allowed.push(proof.path);
    }
    if (allowed.length !== replacements.length || allowed.some(p => !replacements.some(r => r.path === p))
        || replacements.some(r => !isDeepStrictEqual(r.value, expected.get(r.path)))) fail('补丁改变了获准逐字范围之外内容');
    const result = repair.applyReaderPatch(original, record.patch, allowed);
    if (!isDeepStrictEqual(result, record.draft) || isDeepStrictEqual(result, original)
        || !isDeepStrictEqual(result.formulaBindings, original.formulaBindings)
        || !isDeepStrictEqual(result.figurePlacements, original.figurePlacements)
        || tables(result).length !== originalTables.length) fail('不得改变公式、原图、表数量或声明范围之外内容');
    const markers = value => [...JSON.stringify(value).matchAll(/\[\[(?:FIGURE|FORMULA|CONCEPT_BRIDGE)_\d+\]\]/g)].map(m => m[0]);
    if (!isDeepStrictEqual(markers(result), markers(original))) fail('不得改变既有图表术语标记的顺序和身份');
    return result;
}
module.exports = { CONTRACT, applyBoundedFactPatch };
