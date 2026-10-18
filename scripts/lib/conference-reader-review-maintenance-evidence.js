'use strict';
// Pure evidence validation. Authority, source replay, and canonical writes
// remain with the normal conference maintenance engine.
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const draftHash = value => sha(JSON.stringify(value));
function rawReviewFeedback(failure) {
    return '以下是待核验的独立博客审查意见，不是已证实事实。请对照本次认证全文与真实原图，仅修正确认存在的错误；不得把审查建议、猜测或更正数字直接当作论文事实。保留正确内容，不改主文、核心摘要、评分和标签；新 Reader 仍须通过完整来源检查与博客独立审查。\n'
        + (failure.stage === 'markdown' ? '若问题确为原文金额等字面美元符号而非公式，可用闭合行内代码保留原符号与数字，不猜币种；数学仍使用正常 TeX 分隔符。\n' : '')
        + JSON.stringify({ stage: failure.stage, issues: failure.issues });
}
const stable = value => {
    const sort = item => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object'
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
    return sha(JSON.stringify(sort(value)));
};
const SHA = /^[a-f0-9]{64}$/u;
const fail = message => { throw Object.assign(new Error(message), { code: 'CONFERENCE_READER_REVIEW_MAINTENANCE_INTEGRITY' }); };
const check = (value, message) => { if (!value) fail(message); };
function selfHash(document, key) {
    const body = structuredClone(document); const declared = body[key]; delete body[key];
    check(SHA.test(declared || '') && stable(body) === declared, key + ' mismatch');
}
function sorted(values) { return [...values].sort(); }
function equalIds(left, right, message) { check(isDeepStrictEqual(sorted(left), sorted(right)), message); }
function uniqueIds(values, message) { check(new Set(values).size === values.length, message); }
function existingNode(draft, pointer) {
    check(/^\/(?:sections|conceptBridges|figurePlacements|tableBindings|formulaBindings)\/(?:0|[1-9]\d*)(?:\/(?:[A-Za-z][A-Za-z0-9]*|0|[1-9]\d*))*$/u.test(pointer), 'unbounded Reader pointer');
    let node = draft;
    for (const key of pointer.slice(1).split('/')) {
        check(node !== null && typeof node === 'object' && Object.hasOwn(node, key), 'missing existing node');
        node = node[key];
    }
    return node;
}
function validateReviewIdentity({ manifest: m, generation: g, reviewBatch: review, state,
    actualPhysicalShas, failures, parents, surfaces, imageClassifications = {},markdownClassifications = {},aggregateClassifications = {},nativeReviewClassifications = {},passCaches = {} }) {
    check(m?.contract === 'conference-reader-review-maintenance-batch-v1' && m.version === 1, 'maintenance contract');
    selfHash(m, 'manifestSha256'); selfHash(g, 'generationSha256');
    selfHash(review, 'batchSha256'); selfHash(state, 'stateSha256');
    check(state.processId === m.processId && state.processId === g.processId
        && state.status === 'complete' && Object.values(state.items).every(item => item.status === 'complete'), 'real complete baseline required');
    check(m.generationSha256 === g.generationSha256 && m.baselineStateSha256 === state.stateSha256
        && m.reviewBatchSha256 === review.batchSha256, 'semantic baseline mismatch');
    for (const key of ['generation', 'state', 'reviewBatch']) {
        check(SHA.test(actualPhysicalShas[key] || '') && m[key + 'FileSha256'] === actualPhysicalShas[key], 'physical baseline mismatch: ' + key);
    }
    check(review.contract === 'conference-page-content-review-batch-failure-v1' && review.status === 'blocked'
        && SHA.test(review.protocol || '') && m.protocol === review.protocol, 'finished review protocol');
    const pages = g.files.filter(row => ['paper', 'aggregate'].includes(row.kind));
    uniqueIds(pages.map(row => row.path), 'duplicate generation page');
    uniqueIds(review.pages.map(row => row.path), 'duplicate reviewed page');
    equalIds(pages.map(row => row.path), review.pages.map(row => row.path), 'review did not finish exact full generation');
    const byPath = new Map(pages.map(row => [row.path, row]));
    const selected = [],imageFailures=[],markdownFailures=[],aggregateFailures=[],nativeFailures=[];
    for (const row of review.pages) {
        const page = byPath.get(row.path);
        check(row.sha256 === page.sourceSha256, 'review page bytes drift');
        if (row.passed === true) {
            const saved=passCaches[stable({path:row.path,sha256:row.sha256})];
            check(saved&&SHA.test(saved.fileSha256||'')&&isDeepStrictEqual(saved.value,row),'real canonical page pass cache required');
            selfHash(saved.value,'resultSha256');
            check(row.contract==='conference-page-content-review-v1'&&SHA.test(row.protocol||'')
                &&row.passed===true,'canonical page pass identity');
            continue;
        }
        check(row.protocol===review.protocol,'review rejection protocol drift');
        check(row.passed === false, 'unfinished review page');
        // Native stage remains unchanged. Only source-bound explicit semantic
        // classification can send an image-stage original-text defect to Reader.
        check(row.completed === true && SHA.test(row.failureSha256 || ''), 'incomplete text rejection');
        const saved = failures[row.failureSha256];
        // Native batch summaries add only the runtime display message; that
        // field is deliberately absent from the immutable rejection bytes.
        const { message, ...persistedRow } = row;
        check(message === undefined || typeof message === 'string', 'invalid review display message');
        check(saved && stable(saved.value) === stable(persistedRow), 'review summary differs from immutable rejection');
        selfHash(saved.value, 'failureSha256');
        check(SHA.test(saved.fileSha256 || ''), 'missing actual rejection file bytes');
        if(row.failureKind==='transient') {
            nativeFailures.push(row.failureSha256);
            const declared=(m.nativeReviewClassifications||[]).find(item=>item.failureSha256===row.failureSha256);
            const classified=declared&&nativeReviewClassifications[declared.classificationSha256];
            check(classified&&classified.fileSha256===declared.classificationFileSha256
                &&saved.fileSha256===declared.failureFileSha256,'transient review lacks exact original deferred evidence');
            const classification=classified.value;selfHash(classification,'classificationSha256');
            check(isDeepStrictEqual(Object.keys(classification).sort(),['contract','path','pageSha256','failureSha256',
                'kind','status','nextAction','classificationSha256'].sort())
                &&classification.contract==='conference-reader-native-review-classification-v1'
                &&classification.path===row.path&&classification.pageSha256===row.sha256
                &&classification.failureSha256===row.failureSha256
                &&classification.kind==='deferred-native-review'&&classification.status==='pending-new-page-review'
                &&classification.nextAction==='normal-publication-review',
                'transient review cannot become Reader feedback repaired or passed');
            continue;
        }
        check(row.failureKind==='content'&&['text','image','markdown'].includes(row.stage),'unsupported native review failure');
        if(page.kind==='aggregate') {
            aggregateFailures.push(row.failureSha256);
            const declared=(m.aggregateClassifications||[]).find(item=>item.failureSha256===row.failureSha256);
            const classified=declared&&aggregateClassifications[declared.classificationSha256];
            check(page.paperId===null&&row.paperId===null&&classified
                &&classified.fileSha256===declared.classificationFileSha256
                &&saved.fileSha256===declared.failureFileSha256,'aggregate rejection requires ordinary aggregate maintenance and exact deferred evidence');
            const classification=classified.value;selfHash(classification,'classificationSha256');
            check(isDeepStrictEqual(Object.keys(classification).sort(),['contract','path','pageSha256','failureSha256',
                'kind','status','nextAction','classificationSha256'].sort())
                &&classification.contract==='conference-reader-aggregate-review-classification-v1'
                &&classification.path===row.path&&classification.pageSha256===row.sha256
                &&classification.failureSha256===row.failureSha256
                &&classification.kind==='deferred-aggregate-generation'
                &&classification.status==='pending-new-page-review'
                &&classification.nextAction==='normal-aggregate-generation-then-normal-review',
                'deferred aggregate cannot claim Reader selection repaired or passed');
            continue;
        }
        check(page.kind==='paper','ordinary Reader member must be a paper');
        if(row.stage==='markdown') {
            markdownFailures.push(row.failureSha256);
            const declared=(m.markdownClassifications||[]).find(item=>item.failureSha256===row.failureSha256);
            const classified=declared&&markdownClassifications[declared.classificationSha256];
            check(classified&&classified.fileSha256===declared.classificationFileSha256
                &&saved.fileSha256===declared.failureFileSha256,'markdown failure lacks exact classification/rejection bytes');
            const classification=classified.value;selfHash(classification,'classificationSha256');
            check(classification.contract==='conference-reader-markdown-review-classification-v1'
                &&classification.failureSha256===row.failureSha256&&classification.path===row.path
                &&classification.pageSha256===row.sha256
                &&['normal-reader','deferred-publication-format'].includes(classification.kind),'markdown classification identity');
            if(classification.kind==='deferred-publication-format') {
                check(isDeepStrictEqual(Object.keys(classification).sort(),['contract','path','pageSha256','failureSha256',
                    'kind','status','nextAction','classificationSha256'].sort())
                    &&classification.status==='pending-new-page-review'
                    &&classification.nextAction==='publication-format-then-normal-review',
                    'deferred markdown review cannot claim repaired or passed');
                continue;
            }
        }
        if(row.stage==='image') {
            imageFailures.push(row.failureSha256);
            const declared=(m.imageClassifications||[]).find(item=>item.failureSha256===row.failureSha256);
            const classified=declared&&imageClassifications[declared.classificationSha256];
            check(classified&&classified.fileSha256===declared.classificationFileSha256
                &&saved.fileSha256===declared.failureFileSha256,'image failure lacks exact classification/rejection bytes');
            const classification=classified.value;selfHash(classification,'classificationSha256');
            check(classification.contract==='conference-reader-review-classification-v1'
                &&classification.failureSha256===row.failureSha256&&classification.path===row.path
                &&classification.pageSha256===row.sha256
                &&['asset-only','reader-semantic','mixed','deferred-review'].includes(classification.kind),'image classification identity');
            if(classification.kind==='deferred-review') {
                check(isDeepStrictEqual(Object.keys(classification).sort(),['contract','path','pageSha256','failureSha256',
                    'kind','status','nextAction','classificationSha256'].sort())
                    &&classification.status==='pending-new-page-review'
                    &&classification.nextAction==='source-bound-pdf-page-view-then-normal-review',
                    'deferred image review cannot claim repaired or passed');
                continue;
            }
            if(classification.kind==='asset-only')continue;
            check(Array.isArray(classification.imageEvidence)&&classification.imageEvidence.length>0
                &&classification.imageEvidence.every(image=>(g.imageFiles||[]).some(asset=>asset.paperId===page.paperId
                    &&asset.path===image.path&&asset.sourceSha256===image.sha256)),'semantic image evidence differs from generation');
        }
        selected.push({ page, row, saved });
    }
    uniqueIds((m.imageClassifications||[]).map(row=>row.failureSha256),'duplicate image failure classification');
    equalIds(imageFailures,(m.imageClassifications||[]).map(row=>row.failureSha256),'not exact complete image classification set');
    uniqueIds((m.markdownClassifications||[]).map(row=>row.failureSha256),'duplicate markdown failure classification');
    equalIds(markdownFailures,(m.markdownClassifications||[]).map(row=>row.failureSha256),'not exact complete markdown classification set');
    uniqueIds((m.aggregateClassifications||[]).map(row=>row.failureSha256),'duplicate aggregate classification');
    equalIds(aggregateFailures,(m.aggregateClassifications||[]).map(row=>row.failureSha256),'not exact complete aggregate classification set');
    uniqueIds((m.nativeReviewClassifications||[]).map(row=>row.failureSha256),'duplicate native review classification');
    equalIds(nativeFailures,(m.nativeReviewClassifications||[]).map(row=>row.failureSha256),'not exact complete transient review classification set');
    check(selected.length > 0, 'no actual paper Reader rejection');
    uniqueIds(m.members.map(row => row.paperId), 'duplicate maintenance member');
    equalIds(selected.map(({ page }) => page.paperId), m.members.map(row => row.paperId), 'not exact text rejected set');
    for (const member of m.members) {
        const { page, row, saved } = selected.find(({ page }) => page.paperId === member.paperId);
        const item = state.items[member.paperId], parent = parents[member.parentExecutionId];
        check(item && item.analysisRunId === member.parentExecutionId && parent, 'wrong current completed parent');
        check(member.pagePath === page.path && member.pageSha256 === page.sourceSha256
            && member.failureSha256 === row.failureSha256 && member.failureFileSha256 === saved.fileSha256, 'member rejection binding');
        for (const key of ['analysis', 'run', 'source']) {
            check(SHA.test(parent.fileShas[key] || '') && member.parentCAS[key + 'FileSha256'] === parent.fileShas[key], 'parent physical CAS drift');
        }
        check(parent.run.status === 'complete' && parent.analysis.status === 'complete'
            && parent.run.paperId === member.paperId && parent.run.executionId === member.parentExecutionId
            && parent.fileShas.analysis === item.analysisProof.analysisSha256
            && parent.run.completionReceipt.receiptSha256 === item.analysisProof.completionReceiptSha256, 'parent completion mismatch');
        check(member.sourceSha256 === sha(parent.sourceText) && member.sourceSha256 === item.sourceProof.textSha256
            && member.pdfSha256 === parent.pdfSha256 && member.pdfSha256 === item.sourceProof.pdfSha256
            && member.sourceSnapshotSha256 === parent.run.sourceSnapshotSha256
            && member.sourceSnapshotSha256 === item.analysisProof.sourceSnapshotSha256, 'source text/PDF/snapshot mismatch');
        const surface = surfaces[member.parentExecutionId];
        check(surface && draftHash(surface) === member.parentReaderDraftSha256, 'signed Reader reconstruction mismatch');
        const mode=member.feedbackMode||'raw-review-findings-v1';
        check(['raw-review-findings-v1','corrective-assertion-v1'].includes(mode),'unknown feedback mode');
        if(mode==='raw-review-findings-v1') {
            check(member.reviewFeedback===rawReviewFeedback(saved.value)
                &&member.rejectedClaims===undefined&&member.sourceQuotes===undefined,'raw findings cannot claim a proven corrective assertion');
        } else {
            check(Array.isArray(member.rejectedClaims) && member.rejectedClaims.length > 0, 'no original rejected claims');
            for (const claim of member.rejectedClaims) {
                const node = existingNode(surface, claim.path);
                check(draftHash(node) === claim.oldSha256 && typeof node === 'string'
                    && typeof claim.quote === 'string' && claim.quote.length > 0 && node.includes(claim.quote), 'original rejected bytes mismatch');
            }
            check(Array.isArray(member.sourceQuotes) && member.sourceQuotes.length > 0
                && member.sourceQuotes.every(quote => typeof quote === 'string' && quote.length >= 12
                    && parent.sourceText.includes(quote)), 'source quote is not literal authenticated text');
        }
        check(typeof member.reviewFeedback === 'string' && member.reviewFeedback.trim()
            && sha(member.reviewFeedback.trim()) === member.reviewFeedbackSha256
            && member.reviewFeedback.length <= 4000, 'feedback bytes or budget mismatch');
    }
    // Deliberately not an opaque handle or an analysis/publication result.
    return { draftEvidenceOnly: true, paperIds: sorted(m.members.map(row => row.paperId)), protocol: review.protocol };
}
function validateDocuments(input) {
    const result=validateReviewIdentity(input),g=input.generation;
    const raw=g.figurePublicationView?input.publicationRawRecords:g.files;
    check(Array.isArray(raw),'publication view requires actually replayed raw page mapping');
    for(const member of input.manifest.members) {
        const matches=raw.filter(page=>page.kind==='paper'&&page.paperId===member.paperId&&page.path===member.pagePath);
        check(matches.length===1,'one exact raw page mapping required');
        const page=matches[0],item=input.state.items[member.paperId];
        check(item.pageProof?.pagePath===page.path&&item.pageProof?.contentSha256===page.sourceSha256
            &&SHA.test(page.manifestSha256||'')&&item.pageProof?.manifestSha256===page.manifestSha256,
            'current completed page proof differs from reviewed generation');
    }
    return result;
}
// Identity-only validates original review and parent/source CAS; it is NEVER
// an opaque permission or full page/view qualification. Only the private loader
// can issue a history-purpose token and then require actual view replay.
module.exports = { validateDocuments, validateReviewIdentity, stable, sha, draftHash, rawReviewFeedback };
