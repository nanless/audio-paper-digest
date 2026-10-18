'use strict';
const { stable, sha, draftHash } = require('../../scripts/lib/conference-reader-review-maintenance-evidence');
function seal(value, field) {
    delete value[field]; value[field] = stable(value); return value;
}
function fixture(count = 2) {
    const input = { actualPhysicalShas: { generation: sha('generation-file'), state: sha('state-file'),
        reviewBatch: sha('review-file') }, failures: {}, parents: {}, surfaces: {},imageClassifications:{},passCaches:{} };
    const state = { processId: 'synthetic-complete-process', generation:1,status: 'complete', items: {} };
    const generation = { processId: state.processId, files: [] };
    const review = { contract: 'conference-page-content-review-batch-failure-v1', status: 'blocked',
        protocol: sha('one-protocol'), pages: [] };
    const members = [];
    for (let i = 0; i < count; i++) {
        const paperId = 'synthetic-paper-' + i, execution = 'synthetic-parent-' + i;
        const sourceText = 'This is a literal source evidence sentence for synthetic paper ' + i;
        const sourceSha256 = sha(sourceText), pdfSha256 = sha('pdf-' + i), snapshot = sha('snapshot-' + i);
        const receipt = sha('completion-' + i), fileShas = { analysis: sha('analysis-' + i),
            run: sha('run-' + i), source: sha('source-' + i) };
        const page = { kind: 'paper', paperId, path: 'content/posts/paper-' + i + '.md', sourceSha256: sha('page-' + i),manifestSha256:sha('page-manifest-'+i) };
        generation.files.push(page, { kind: 'sidecar', path: page.path + '.provenance.json' });
        const rejection = seal({ contract: 'conference-page-content-review-failure-v1', path: page.path,
            sha256: page.sourceSha256, paperId, passed: false, stage: 'text', protocol: review.protocol,
            issues: [{ severity: 'error', description: 'synthetic rejected original text' }],
            completed: true, failureKind: 'content' }, 'failureSha256');
        const failureFileSha256 = sha('failure-file-' + i);
        review.pages.push({ ...structuredClone(rejection), message: 'native runtime display message' });
        input.failures[rejection.failureSha256] = { value: rejection, fileSha256: failureFileSha256 };
        state.items[paperId] = { status: 'complete', analysisRunId: execution,
            pageProof:{pagePath:page.path,contentSha256:page.sourceSha256,manifestSha256:page.manifestSha256},
            analysisProof: { analysisSha256: fileShas.analysis, completionReceiptSha256: receipt, sourceSnapshotSha256: snapshot },
            sourceProof: { textSha256: sourceSha256, pdfSha256 } };
        input.parents[execution] = { fileShas, sourceText, pdfSha256,
            analysis: { status: 'complete' }, run: { executionId: execution, paperId, status: 'complete',
                sourceSnapshotSha256: snapshot, completionReceipt: { receiptSha256: receipt } } };
        const body = 'The existing Reader contains rejected phrase ' + i;
        const surface = { sections: [{ body }] }; input.surfaces[execution] = surface;
        const reviewFeedback = 'Use the quoted source to correct existing phrase ' + i;
        members.push({ paperId, parentExecutionId: execution, pagePath: page.path, pageSha256: page.sourceSha256,feedbackMode:'corrective-assertion-v1',
            failureSha256: rejection.failureSha256, failureFileSha256,
            parentCAS: Object.fromEntries(Object.entries(fileShas).map(([key,value]) => [key+'FileSha256',value])),
            sourceSha256, pdfSha256, sourceSnapshotSha256: snapshot, parentReaderDraftSha256: draftHash(surface),
            rejectedClaims: [{ path: '/sections/0/body', oldSha256: draftHash(body), quote: 'rejected phrase ' + i }],
            sourceQuotes: [sourceText], reviewFeedback, reviewFeedbackSha256: sha(reviewFeedback) });
    }
    const aggregate = { kind: 'aggregate', path: 'content/posts/aggregate.md', sourceSha256: sha('aggregate') };
    generation.files.push(aggregate);
    const aggregatePass=seal({contract:'conference-page-content-review-v1',path:aggregate.path,sha256:aggregate.sourceSha256,passed:true,issues:[],imageCount:0,protocol:review.protocol},'resultSha256');
    review.pages.push(aggregatePass);input.passCaches[stable({path:aggregate.path,sha256:aggregate.sourceSha256})]={value:aggregatePass,fileSha256:sha('native aggregate pass file')};
    const unrelated = { kind: 'paper', paperId: 'synthetic-image-only', path: 'content/posts/image-only.md', sourceSha256: sha('image-page') };
    generation.files.push(unrelated);
    const imageRejection=seal({contract:'conference-page-content-review-failure-v1',path:unrelated.path,
        sha256:unrelated.sourceSha256,paperId:unrelated.paperId,passed:false,stage:'image',failureKind:'content',
        protocol:review.protocol,issues:[],completed:true},'failureSha256');
    review.pages.push({...structuredClone(imageRejection),message:'synthetic image-only rejection'});
    input.failures[imageRejection.failureSha256]={value:imageRejection,fileSha256:sha('image failure file')};
    const classification=seal({contract:'conference-reader-review-classification-v1',path:unrelated.path,
        pageSha256:unrelated.sourceSha256,failureSha256:imageRejection.failureSha256,kind:'asset-only'},'classificationSha256');
    const classificationFileSha256=sha('classification file');
    input.imageClassifications[classification.classificationSha256]={value:classification,fileSha256:classificationFileSha256};
    seal(generation, 'generationSha256'); seal(review, 'batchSha256'); seal(state, 'stateSha256');
    input.manifest = seal({ contract: 'conference-reader-review-maintenance-batch-v1', version: 1,
        processId: state.processId, baselineStateSha256: state.stateSha256,
        generationSha256: generation.generationSha256, reviewBatchSha256: review.batchSha256,
        generationFileSha256: input.actualPhysicalShas.generation, stateFileSha256: input.actualPhysicalShas.state,
        reviewBatchFileSha256: input.actualPhysicalShas.reviewBatch, protocol: review.protocol, members,
        imageClassifications:[{failureSha256:imageRejection.failureSha256,failureFileSha256:input.failures[imageRejection.failureSha256].fileSha256,classificationSha256:classification.classificationSha256,classificationFileSha256}] }, 'manifestSha256');
    Object.assign(input, { state, generation, reviewBatch: review });
    input.resealManifest = () => seal(input.manifest, 'manifestSha256');
    input.resealBatch = () => { seal(review,'batchSha256'); input.manifest.reviewBatchSha256=review.batchSha256; input.resealManifest(); };
    input.resealState = () => { seal(state,'stateSha256'); input.manifest.baselineStateSha256=state.stateSha256; input.resealManifest(); };
    return input;
}


module.exports={fixture,seal};
