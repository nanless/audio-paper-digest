'use strict';
// Pure range authorization. Scientific/source validation stays in the normal Reader parser.
const { isDeepStrictEqual } = require('node:util');
const repair = require('./reader-repair');
const signedTables = require('./reader-signed-table-targets');
const format = require('./daily-reader-signed-correction-format');
const CONTRACT = format.FACT;
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
const FOCUS_PATH = /^\/figurePlacements\/(0|[1-9]\d*)\/focusPoints\/(0|[1-9]\d*)$/;
function boundFigureFocusRanges(original, record, feedback, source) {
    const ranges = record.rangeCorrections.filter(range => FOCUS_PATH.test(range?.path || ''));
    const proofs = record.focusCorrections === undefined ? [] : record.focusCorrections;
    if (!Array.isArray(proofs) || proofs.length !== ranges.length || proofs.length > 8
        || new Set(proofs.map(proof => proof?.path)).size !== proofs.length)
        fail('看图要点授权须唯一且完整对应本次既有叶子范围');
    const result = new Map();
    for (const proof of proofs) {
        if (!exact(proof, ['path', 'sectionPath', 'bodyClaimIndex', 'figureOrdinal', 'sourceDomSha256', 'assetSha256'])
            || !FOCUS_PATH.test(proof.path || '') || !/^\/sections\/(0|[1-9]\d*)\/body$/.test(proof.sectionPath || '')
            || !Number.isSafeInteger(proof.bodyClaimIndex) || proof.bodyClaimIndex < 0
            || !Number.isSafeInteger(proof.figureOrdinal) || proof.figureOrdinal < 1
            || ![proof.sourceDomSha256, proof.assetSha256].every(value => /^[a-f0-9]{64}$/.test(value || '')))
            fail('看图要点只接受精确既有叶子及同图正文和原像素证明');
        const range = ranges.find(value => value.path === proof.path);
        const [, figureIndex, focusIndex] = proof.path.match(FOCUS_PATH);
        const figure = original.figurePlacements?.[figureIndex];
        const parentFigure = record.parentPaper?.apiReaderPlan?.figurePlacements?.[figureIndex];
        const point = figure?.focusPoints?.[focusIndex];
        const parentPoint = parentFigure?.focusPoints?.[focusIndex];
        const bodyRange = record.rangeCorrections.find(value => value.path === proof.sectionPath);
        const section = original.sections?.[Number(proof.sectionPath.split('/')[2])];
        const bodyClaim = feedback.rejectedReaderClaims[proof.bodyClaimIndex];
        const parentImages = (record.parentPaper?.apiReaderFigures || []).filter(value => value.ordinal === proof.figureOrdinal);
        const sourceImages = (source?.structuredArtifacts?.figures || []).filter(value => value.ordinal === proof.figureOrdinal);
        if (!range || typeof point !== 'string' || !point.trim() || point !== parentPoint
            || figure.figureOrdinal !== proof.figureOrdinal || parentFigure.figureOrdinal !== proof.figureOrdinal
            || figure.marker !== parentFigure.marker || figure.targetKind !== parentFigure.targetKind
            || figure.marker !== `[[FIGURE_${proof.figureOrdinal}]]` || section?.kind !== figure.targetKind
            || typeof section.body !== 'string' || section.body.split(figure.marker).length !== 2
            || !bodyRange || !bodyRange.edits?.some(edit => edit.claimIndex === proof.bodyClaimIndex && edit.from !== edit.to)
            || typeof bodyClaim !== 'string' || !bodyClaim || !record.parentPaper.apiReaderArticle?.includes(bodyClaim)
            || ![parentFigure.leadQuote, parentFigure.explanationQuote]
                .some(quote => typeof quote === 'string' && quote.includes(bodyClaim))
            || parentImages.length !== 1 || sourceImages.length !== 1
            || parentImages[0].sourceDomSha256 !== proof.sourceDomSha256
            || parentImages[0].assetSha256 !== proof.assetSha256
            || sourceImages[0].sourceDomSha256 !== proof.sourceDomSha256 || sourceImages[0].recoveryStatus !== 'complete'
            || !sourceImages[0].images?.some(image => image.url === parentImages[0].url)
            || !source.freshSourceDescriptor || !isDeepStrictEqual(source.freshSourceDescriptor, record.sourceDescriptor)
            || require('./daily-fact-review').sha(source.text) !== record.sourceFiles?.['source.txt'])
            fail('看图要点必须绑定同一真实父叶、原图四源及本次确已修改的同图正文原句');
        result.set(proof.path, { point, figureIndex: Number(figureIndex), focusIndex: Number(focusIndex) });
    }
    return result;
}
function applyBoundedFactPatch(original, record, feedback, source, tableProjectionHandle) {
    if (!format.isFact(record) || !require('./saved-fact-feedback').readerOnlyFeedback(feedback)) fail('须使用事实修正格式和仅限解读长文的事实反馈');
    const replacements = record.patch?.replacements, ranges = record.rangeCorrections;
    if (!Array.isArray(replacements) || replacements.length < 1 || replacements.length > 8
        || !Array.isArray(ranges) || !ranges.length || ranges.length > 8
        || !Array.isArray(record.tableCorrections || [])) fail('须为1–8个既有节点的显式范围补丁');
    const focusRanges = boundFigureFocusRanges(original, record, feedback, source);
    const allowed = [], expected = new Map(), allEdits = [];
    for (const range of ranges) {
        if (!exact(range, ['path', 'oldSha256', 'edits'])
            || (!/^\/(?:sections\/(?:0|[1-9]\d*)\/body|conceptBridges\/(?:0|[1-9]\d*)\/explanation)$/.test(range.path)
                && !focusRanges.has(range.path))
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
            const focus = focusRanges.get(range.path);
            if (typeof claim !== 'string' || !claim || typeof rawClaim !== 'string' || !rawClaim || rawClaim.length > 3000
                || (focus ? claim !== focus.point || edit.claimStart !== 0 || Object.hasOwn(edit, 'rawClaim')
                    : !record.parentPaper?.apiReaderArticle?.includes(claim))
                || old.slice(edit.claimStart, edit.claimStart + rawClaim.length) !== rawClaim
                || edit.start < edit.claimStart || edit.end > edit.claimStart + rawClaim.length
                || old.slice(edit.start, edit.end) !== edit.from) fail('替换越出当前逐字rejected claim范围');
            if (edit.rawClaim !== undefined) {
                const format = require('./reader-signed-raw-claim-display').normalizeSignedReaderClaim;
                const readerFormat = require('./reader-record-format');
                const parentPlan = record.parentPaper?.apiReaderPlan;
                const claimOptions = readerFormat.isIntegratedPlan(parentPlan)
                    ? { editorialProfile: readerFormat.compilationOptionsForSavedPlan(parentPlan).editorialProfile }
                    : {};
                if (format(rawClaim, old, claimOptions) !== claim || !format(old, old, claimOptions).includes(claim)) {
                    if (!require('./reader-signed-pruned-table-claim').matchesPrunedTableClaim({
                        handle: tableProjectionHandle, original, record, source, range, edit, claim, rawClaim
                    })) fail('raw/rendered原句不能按实际正常producer精确映射');
                }
            }
            value += old.slice(cursor, edit.start) + edit.to; cursor = edit.end;
            allEdits.push({ ...edit, path: range.path });
        }
        value += old.slice(cursor);
        expected.set(range.path, value); allowed.push(range.path);
    }
    if (allEdits.length > 32) fail('总替换范围超过有界上限');
    for (const proof of record.tableCorrections || []) {
        const bindingOnly = proof.bindingOnly === true;
        if (!exact(proof, ['path', 'sectionPath', bindingOnly ? 'bindingOnly' : 'claimIndex', 'oldTableSha256', 'sourceTableOrdinal', 'sourceDomSha256', 'sourceTableSha256'])
            || !/^\/tableBindings\/(?:0|[1-9]\d*)$/.test(proof.path) || expected.has(proof.path)) fail('表绑定授权字段或路径不合法');
        const section = nodeAt(original, proof.sectionPath);
        const { before, slot, table } = signedTables.resolveSignedOriginalTable(original,
            { ...record, _tableFeedback: feedback }, proof, source);
        const sources = (source?.structuredArtifacts?.tables || []).filter(t => t.ordinal === proof.sourceTableOrdinal
            && t.sourceDomSha256 === proof.sourceDomSha256 && t.recoveryStatus === 'complete');
        const edits = allEdits.filter(e => e.path === proof.sectionPath && e.claimIndex === proof.claimIndex);
        if (!table || typeof section !== 'string'
            || (slot.kind === 'inline' && section.split(table.markdown).length !== 2)
            || repair.hashDraft(table.markdown) !== proof.oldTableSha256 || sources.length !== 1
            || repair.hashDraft(sources[0]) !== proof.sourceTableSha256
            || (slot.kind === 'inline' && !bindingOnly && !edits.some(e => e.start >= section.indexOf(table.markdown)
                && e.end <= section.indexOf(table.markdown) + table.markdown.length))) fail('须绑定同一受拒原表及完整唯一source DOM表');
        if (bindingOnly && !require('./reader-signed-pruned-table-claim').matchesIdenticalTableBinding({
            handle: tableProjectionHandle, original, record, source, proof
        })) fail('仅绑定升级须真实重放，原表字节不变且完整逐格等于唯一原DOM');
        const replacement = replacements.find(r => r.path === proof.path)?.value;
        if (!signedTables.signedTableReplacementMatches(replacement, before.tableIndex, proof.sourceTableOrdinal)
            || (slot.kind === 'marker' && !replacement.completeTable)) fail('修复表绑定只能引用证明中的同一原DOM表');
        expected.set(proof.path, replacement); allowed.push(proof.path);
    }
    if (allowed.length !== replacements.length || allowed.some(p => !replacements.some(r => r.path === p))
        || replacements.some(r => !isDeepStrictEqual(r.value, expected.get(r.path)))) fail('补丁改变了获准逐字范围之外内容');
    // The model's ordinary patch language keeps its existing path whitelist.
    // Apply only these separately authenticated exact focus leaves locally.
    const result = repair.applyReaderPatch(original, { ...record.patch,
        replacements: replacements.filter(replacement => !focusRanges.has(replacement.path)) },
    allowed.filter(pointer => !focusRanges.has(pointer)));
    for (const [pointer, focus] of focusRanges) {
        const replacement = replacements.find(value => value.path === pointer);
        if (!exact(replacement, ['path', 'oldSha256', 'value']) || replacement.oldSha256 !== repair.hashDraft(focus.point)
            || typeof replacement.value !== 'string' || !replacement.value.trim()) fail('看图要点叶子补丁须保留原SHA及精确字符串字段');
        result.figurePlacements[focus.figureIndex].focusPoints[focus.focusIndex] = replacement.value;
    }
    const protectedFigures = structuredClone(result.figurePlacements);
    for (const focus of focusRanges.values())
        protectedFigures[focus.figureIndex].focusPoints[focus.focusIndex] = focus.point;
    const canCompareSourceQuoteSlots = !(record.tableCorrections || []).length
        && require('./daily-reader-signed-correction').authenticatedTableProjection(
            tableProjectionHandle, original, record, source);
    const slots = canCompareSourceQuoteSlots
        ? signedTables.unchangedSourceQuoteTableSlots(original, result) : null;
    if (!isDeepStrictEqual(result, record.draft) || isDeepStrictEqual(result, original)
        || !isDeepStrictEqual(result.formulaBindings, original.formulaBindings)
        || !isDeepStrictEqual(protectedFigures, original.figurePlacements)
        || (slots?.after ?? signedTables.readerTableSlots(result)).length
            !== (slots?.before ?? signedTables.readerTableSlots(original)).length) fail('不得改变公式、原图、表数量或声明范围之外内容');
    const markers = value => [...JSON.stringify(value).matchAll(/\[\[(?:FIGURE|FORMULA|CONCEPT_BRIDGE)_\d+\]\]/g)].map(m => m[0]);
    if (!isDeepStrictEqual(markers(result), markers(original))) fail('不得改变既有图表术语标记的顺序和身份');
    return result;
}
module.exports = { CONTRACT, applyBoundedFactPatch };
