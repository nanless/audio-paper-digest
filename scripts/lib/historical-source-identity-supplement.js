'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const planApi = require('./historical-direct-rewrite-plan.js');
const runner = require('./historical-direct-rewrite-runner.js');
const fresh = require('./fresh-arxiv-rewrite-source.js');
const io = require('./historical-conference-page-projections.js');
const supplements = require('./historical-direct-tag-supplement.js');
const alternate = require('./historical-icml-alternate-pdf-source.js');
const CONTRACT = 'historical-source-identity-supplement-v1';
const digest = v => crypto.createHash('sha256').update(v).digest('hex');
const fail = m => { throw new Error(`Historical source identity rejected: ${m}`); };

function publicAcquisition(acquisition) {
    const value = structuredClone(acquisition || {});
    if (value.receipt) value.receipt = { fileSha256: value.receipt.fileSha256, selfSha256: value.receipt.selfSha256 };
    return value;
}

function metadataTitle(snapshot,index) {
    const rows=Array.isArray(snapshot)?snapshot:snapshot?.papers||snapshot?.results;
    const row=rows?.[index];
    if(!row || typeof row!=='object' || typeof (row.title||row.name)!=='string') fail('conference metadata row is missing');
    return row.title||row.name;
}

function versionDisclosure(first,item) {
    const acquisition=first.pdf.acquisition;
    if(!acquisition?.versionRelation) return null;
    const forum=item.paperId.match(/^conference:icml:2026:openreview-forum-id:([A-Za-z0-9_-]+)$/)?.[1];
    const profile=forum?alternate.profileForForum(forum):null;
    if(!profile || acquisition.versionRelation!==profile.versionRelation || acquisition.sourceKind!==profile.sourceKind
        || acquisition.sourceTitle!==profile.sourceTitle || acquisition.sourceDoi!==profile.sourceDoi
        || runner.stableHash(acquisition.sourceAuthors)!==runner.stableHash(profile.sourceAuthors)) fail('unreviewed conference version relation');
    const cross=runner.priorPreprintAnalysisDisclosure(first,item);
    if(cross) return cross;
    if(forum!=='jfpkqjhex4'||profile.versionRelation!=='same-paper-versioned-official-preprint') fail('unreviewed conference version relation');
    return {versionRelation:profile.versionRelation,sourceTitle:profile.sourceTitle,sourceDoi:profile.sourceDoi,
        warning:'封存PDF来自同标题、同作者的官方 arXiv 2510.06927v3 预印本；不是 OpenReview 下载响应，也未据此认证 ICML camera-ready 定稿。'};
}

function pdfVersionDisclosure({paperId,sourceId,manifest,sourceManifestSha256,pdfSha256}) {
    const match=String(sourceId).match(/^(\d{4}\.\d{4,5})v([1-9]\d*)$/);
    if(!match) return null;
    const pdfRequestedUrl=manifest.pdf.requestedUrl||manifest.pdf.url||'';
    if(!new RegExp('^https://arxiv\\.org/pdf/'+match[1].replace('.','\\.')+'(?:\\.pdf)?$').test(pdfRequestedUrl)) return null;
    const textUrl=manifest.text.requestedUrl||manifest.text.url||'';
    if(paperId!=='arxiv:'+match[1] || !['https://arxiv.org/html/'+sourceId,'https://arxiv.org/abs/'+sourceId].includes(textUrl)) fail('versioned source/PDF identity differs');
    const pdfVersionBinding={contract:'sealed-arxiv-pdf-version-binding-v1',paperId,sourceId,textUrl,pdfRequestedUrl,
        pdfSha256,sourceManifestSha256,textVersion:Number(match[2]),pdfVersion:'unspecified',pdfVersionAuthenticated:false,
        status:'versioned-text-unversioned-pdf-url'};
    return {pdfVersionBinding,sourceVersionWarning:`封存文本来自 ${sourceId}；实际 PDF 链接 ${pdfRequestedUrl} 未指定版本。已确认属于同一论文，但尚未确认 PDF 对应 v${match[2]}。`};
}

function identityRecord(item, page, bytes, source, options, plan, planFileSha256) {
    if (digest(bytes) !== page.pageContentSha256) fail('frozen page SHA changed');
    if (source.paperId !== item.paperId) fail('source/page identity differs');
    const body = { contract: CONTRACT, paperId:item.paperId, runId:options.runId, planSha256:plan.planSha256,
        planFileSha256, pageKey:page.pageKey, pageSha256:digest(bytes),
        bodySha256:digest(supplements.pageBody(bytes)), source, identityStatus:'verified',
        evidenceType:'sealed-source-identity-only', sourceProofSha256:runner.stableHash(source),
        taxonomyStatus:'not-classified-by-identity-proof' };
    return {...body,proofSha256:runner.stableHash(body)};
}

function publicSourceURL(paperId) {
    const arxiv = paperId.match(/^arxiv:(\d{4}\.\d{4,5})$/);
    if (arxiv) return 'https://arxiv.org/abs/' + arxiv[1];
    const ieee = paperId.match(/^conference:icassp:\d{4}:icassp-arnumber:([1-9]\d*)$/);
    if (ieee) return 'https://ieeexplore.ieee.org/document/' + ieee[1];
    const forum = paperId.match(/^conference:(?:icml|iclr):\d{4}:openreview-forum-id:([A-Za-z0-9_-]{6,128})$/);
    if (forum) return 'https://openreview.net/forum?id=' + forum[1];
    fail('unsupported canonical source identity');
}

function sourceIdentity(item, config, generation = 1) {
    if (item.route.kind === 'arxiv-fresh-fetch') {
        const stored = fresh.readFreshArxivRewriteSource({ rootDir: config.FILES.freshArxivFetchedSourcesDir, arxivId: item.route.arxivId, generation });
        if (stored.arxivId !== item.route.arxivId || stored.generation !== generation || item.paperId !== 'arxiv:' + item.route.arxivId) fail('arXiv identity differs');
        const details = stored.runtimeDetails || runner.fallbackArxivDetails(stored);
        const binding = planApi.normalizeFreshArxivSourceBinding(item, { contract: planApi.FRESH_ARXIV_SOURCE_CONTRACT,
            paperId: item.paperId, arxivId: item.route.arxivId, generation,
            textSha256: stored.manifest.text.responseSha256, pdfSha256: stored.manifest.pdf.responseSha256, sourceManifestSha256: stored.sourceManifestSha256 });
        const version=pdfVersionDisclosure({paperId:item.paperId,sourceId:details.sourceId,manifest:stored.manifest,
            sourceManifestSha256:stored.sourceManifestSha256,pdfSha256:binding.pdfSha256});
        return { kind: item.route.kind, paperId: item.paperId, sourceId: details.sourceId, generation,
            sourceBinding: binding, sourceRunIdentitySha256: planApi.directSourceRunIdentity(item, binding),
            sourceManifestSha256: stored.sourceManifestSha256, textSha256: binding.textSha256, pdfSha256: binding.pdfSha256,
            structuredArtifactsSha256: details.structuredArtifacts.payloadSha256,
            originalTitle: details.title || '', sourceUrl: 'https://arxiv.org/abs/' + details.sourceId,
            pdfUrl: stored.manifest.pdf.requestedUrl || stored.manifest.pdf.url || '',
            ...(version||{}),
            ...(details.sourceVersion ? { sourceVersion: structuredClone(details.sourceVersion) } : {}) };
    }
    if (item.route.kind !== 'conference-local-pdf') fail('unsupported sealed source route');
    planApi.verifyConferenceWriterInputs(item);
    const bindings = item.route.writerInputs.map(source => ({ sourceSet: source.sourceSet,
        provenance: source.provenance, metadataSha256: source.metadata.sha256, metadataRecordIndex: source.metadata.recordIndex,
        metadataIdentityBindingSha256: source.metadata.metadataIdentityBindingSha256,
        pdfSha256: source.pdf.sha256, pdfBytes: source.pdf.bytes,
        pdfIdentityBindingSha256: source.pdf.pdfIdentityBindingSha256,
        sourceBindingSha256: source.sourceBindingSha256, acquisition: publicAcquisition(source.pdf.acquisition),
        acquisitionSha256: runner.stableHash(source.pdf.acquisition) }));
    const first = item.route.writerInputs[0];
    const loaded = io.readStableJson(first.metadata.absolutePath, 'conference sealed identity metadata');
    if (loaded.fileSha256 !== first.metadata.sha256) fail('conference metadata changed');
    const title=metadataTitle(loaded.value,first.metadata.recordIndex);
    const disclosure = versionDisclosure(first,item);
    return { kind: item.route.kind, paperId: item.paperId, sourceId: item.paperId,
        writerInputsSha256: runner.stableHash(item.route.writerInputs), sourceBindings: bindings,
        originalTitle: title, sourceUrl: publicSourceURL(item.paperId), pdfUrl: '',
        provenanceDisclosure: first.pdf.acquisition?.sourceKind === 'retained-local-no-network-receipt'
            ? '历史本地封存来源；未记录下载时网络响应，身份与PDF/metadata绑定已重放。' : '',
        ...(disclosure ? { versionRelation: disclosure.versionRelation, sourceVersionWarning: disclosure.warning,
            sourceTitle: disclosure.sourceTitle, sourceDoi: disclosure.sourceDoi } : {}) };
}

async function buildIdentitySupplement(options) {
    const config = require('../config.js');
    const { plan, registry, planFileSha256 } = supplements.readPlanRegistry(options);
    const byId = new Map(registry.entries.map(e => [e.paperId,e]));
    let selected = plan.queue;
    if(options.includePaperIds) selected=selected.filter(i=>options.includePaperIds.includes(i.paperId));
    else if (options.sampleMixed) selected = [
        ...plan.queue.filter(i => i.route.kind === 'arxiv-fresh-fetch' && byId.get(i.paperId).status !== 'staged').slice(0,25),
        ...plan.queue.filter(i => i.route.kind === 'conference-local-pdf').slice(0,25)
    ]; else if (options.limit) selected = selected.slice(0,options.limit);
    runner.sourcePrerequisiteSnapshot({ sourceRoot:config.FILES.freshArxivFetchedSourcesDir,plan,generation:1,selected,required:true });
    const records = {}, failures = []; let papers = 0, attempted = 0;
    for (const item of selected) {
        attempted++;
        try {
            const source = sourceIdentity(item,config,1);
            const projections = [];
            for (const page of item.pages) {
                const file = path.resolve(options.blogRoot,page.pagePath);
                if (!file.startsWith(path.resolve(options.blogRoot)+path.sep)) fail('page path escapes blog root');
                const loaded = io.readStableFile(file,'identity frozen page');
                if (/^paper_digest_taxonomy_contract:\s*["']?paper-taxonomy-flat-tags-compat-v1/m.test(loaded.bytes.toString('utf8').split('---',3)[1]||'')) continue;
                projections.push([page.pagePath,identityRecord(item,page,loaded.bytes,source,options,plan,planFileSha256)]);
            }
            const replay = sourceIdentity(item,config,1);
            if (runner.stableHash(source)!==runner.stableHash(replay)) fail('source changed while projecting identity');
            for (const [key,record] of projections) { if (records[key]) fail('duplicate page'); records[key]=record; }
            papers += projections.length ? 1 : 0;
        } catch(error) { failures.push({paperId:item.paperId,error:String(error.message)}); }
        if (attempted % 50 === 0 || attempted === selected.length) options.onProgress?.({attempted,paperCount:papers,pageCount:Object.keys(records).length,failures:failures.length},{contract:CONTRACT,records:structuredClone(records)});
    }
    const supplement = {contract:CONTRACT,records};
    const report = {contract:CONTRACT+'-report',planSha256:plan.planSha256,selected:selected.length,
        paperCount:papers,pageCount:Object.keys(records).length,failures,supplementSha256:runner.stableHash(supplement)};
    return {supplement,report};
}
module.exports = {CONTRACT,publicSourceURL,publicAcquisition,metadataTitle,versionDisclosure,pdfVersionDisclosure,identityRecord,sourceIdentity,buildIdentitySupplement};
