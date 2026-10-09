'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const planApi = require('./historical-direct-rewrite-plan.js');
const runner = require('./historical-direct-rewrite-runner.js');
const fresh = require('./fresh-arxiv-rewrite-source.js');
const io = require('./historical-conference-page-projections.js');
const supplements = require('./historical-direct-tag-supplement.js');
const alternate = require('./historical-icml-alternate-pdf-source.js');
const { hasPageTagMetadata } = require('./page-tag-metadata.js');
const CONTRACT = 'historical-source-identity-supplement-v2';
const LEGACY_CONTRACT = 'historical-source-identity-supplement-v1';
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

function identityRecordFor(item, page, bytes, source, options, plan, planFileSha256, contract) {
    if (digest(bytes) !== page.pageContentSha256) fail('frozen page SHA changed');
    if (source.paperId !== item.paperId) fail('source/page identity differs');
    const body = { contract, paperId:item.paperId, runId:options.runId, planSha256:plan.planSha256,
        planFileSha256, pageKey:page.pageKey, pageSha256:digest(bytes),
        bodySha256:digest(supplements.pageBody(bytes)), source, identityStatus:'verified',
        evidenceType:'sealed-source-identity-only', sourceProofSha256:runner.stableHash(source),
        [contract === LEGACY_CONTRACT ? 'taxonomyStatus' : 'tagStatus']:'not-classified-by-identity-proof' };
    return {...body,proofSha256:runner.stableHash(body)};
}

function identityRecord(item, page, bytes, source, options, plan, planFileSha256) {
    return identityRecordFor(item, page, bytes, source, options, plan, planFileSha256, CONTRACT);
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

const rejectSaved = message => { throw new Error(`来源身份补充记录被拒绝：${message}`); };
function knownContract(contract) {
    if (![CONTRACT, LEGACY_CONTRACT].includes(contract)) rejectSaved('格式标识不受支持。');
    return contract;
}
function validateSavedRecords(value, options, plan, planFileSha256) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !value.records || typeof value.records !== 'object' || Array.isArray(value.records)) rejectSaved('保存的页面记录格式无效。');
    const contract = knownContract(value.contract);
    const pages = new Map(plan.queue.flatMap(item => item.pages.map(page => [page.pagePath, { item, page }])));
    for (const [pagePath, record] of Object.entries(value.records)) {
        if (!record || typeof record !== 'object' || Array.isArray(record)) rejectSaved('保存的单页身份记录格式无效。');
        const { proofSha256, ...body } = record;
        if (proofSha256 !== runner.stableHash(body)) rejectSaved('保存的单页身份记录与其原内容摘要不一致。');
        if (record.sourceProofSha256 !== runner.stableHash(record.source)) rejectSaved('保存的来源记录与其原内容摘要不一致。');
        const selected = pages.get(pagePath);
        if (!selected) rejectSaved('保存的页面不属于当前计划。');
        const { item, page } = selected;
        const filename = path.resolve(options.blogRoot, pagePath);
        if (!filename.startsWith(path.resolve(options.blogRoot) + path.sep)) rejectSaved('保存的页面路径超出博客目录。');
        const loaded = io.readStableFile(filename, '原身份记录对应的页面');
        if (loaded.fileSha256 !== page.pageContentSha256 || record.pageSha256 !== loaded.fileSha256
            || record.bodySha256 !== digest(supplements.pageBody(loaded.bytes))) rejectSaved('保存的页面或正文与原摘要不一致。');
        const hasCurrent = Object.hasOwn(record, 'tagStatus');
        const hasLegacy = Object.hasOwn(record, 'taxonomyStatus');
        if (hasCurrent && hasLegacy) rejectSaved('身份记录不能混用新旧标签状态字段。');
        if (record.contract !== contract || contract === CONTRACT && hasLegacy || contract === LEGACY_CONTRACT && hasCurrent) {
            rejectSaved('身份记录的标签状态字段或格式与总文件不一致。');
        }
        const status = contract === CONTRACT ? record.tagStatus : record.taxonomyStatus;
        if (status !== 'not-classified-by-identity-proof' || record.identityStatus !== 'verified'
            || record.evidenceType !== 'sealed-source-identity-only' || record.paperId !== item.paperId
            || record.source?.paperId !== item.paperId || record.pageKey !== page.pageKey
            || record.runId !== options.runId || record.planSha256 !== plan.planSha256
            || record.planFileSha256 !== planFileSha256) rejectSaved('身份、标签状态、页面或计划绑定不一致。');
    }
    return contract;
}
function savedIdentityFor(options, config, plan, planFileSha256) {
    const root = config.FILES.historicalSourceIdentitySupplementDir;
    if (!root) return null;
    if (!path.isAbsolute(root)) rejectSaved('配置的输出目录必须是绝对路径。');
    const exists = filename => {
        try { fs.lstatSync(filename); return true; }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    };
    const directory = path.resolve(root, options.runId);
    if (path.dirname(directory) !== path.resolve(root)) rejectSaved('运行标识超出配置的输出目录。');
    if (!exists(directory)) return null;
    io.safeDirectory(directory, '原身份补充记录目录');
    const historyPath = path.join(directory, 'identity-history.json');
    const reportPath = path.join(directory, 'report.json');
    const hasHistory = exists(historyPath), hasReport = exists(reportPath);
    if (hasHistory !== hasReport) rejectSaved('已有输出缺少完整身份总文件或报告，请保留原文件并使用新的运行标识。');
    const checkpoints = fs.readdirSync(directory).filter(name => /^checkpoint-[0-9]{6,}\.json$/.test(name))
        .map(name => ({ name, loaded: io.readStableJson(path.join(directory, name), '原身份补充检查点') }));
    if (!hasHistory) {
        for (const checkpoint of checkpoints) {
            const contract = validateSavedRecords(checkpoint.loaded.value, options, plan, planFileSha256);
            if (contract !== CONTRACT) rejectSaved('只有旧格式的部分检查点，不能继续生成；请保留原文件并使用新的运行标识。');
        }
        return null;
    }
    const history = io.readStableJson(historyPath, '原身份补充总文件');
    const report = io.readStableJson(reportPath, '原身份补充报告');
    if (report.value.supplementSha256 !== runner.stableHash(history.value)) rejectSaved('报告与原身份总文件的内容摘要不一致。');
    const contract = validateSavedRecords(history.value, options, plan, planFileSha256);
    if (report.value.contract !== contract + '-report' || report.value.planSha256 !== plan.planSha256) {
        rejectSaved('报告格式或原计划绑定不一致。');
    }
    for (const checkpoint of checkpoints) if (validateSavedRecords(checkpoint.loaded.value, options, plan, planFileSha256) !== contract) {
        rejectSaved('检查点与完整身份总文件的格式不一致。');
    }
    return { contract, history, report, checkpoints };
}
function reuseSavedIdentity(saved, result, checkpoints) {
    const bytesFor = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
    const originals = [saved.history, saved.report];
    if (!saved.history.bytes.equals(bytesFor(result.supplement)) || !saved.report.bytes.equals(bytesFor(result.report))) {
        rejectSaved('完整原输出不能按原格式和当前计划逐字重放，请保留原文件并使用新的运行标识。');
    }
    for (const checkpoint of saved.checkpoints) {
        if (!checkpoints.has(checkpoint.name) || !checkpoint.loaded.bytes.equals(bytesFor(checkpoints.get(checkpoint.name)))) {
            rejectSaved('原检查点不能按完整原输出重放。');
        }
        originals.push(checkpoint.loaded);
    }
    for (const original of originals) if (!io.readStableFile(original.filename, '复用前再次核验的原身份文件').bytes.equals(original.bytes)) {
        rejectSaved('原身份文件在重放期间发生变化。');
    }
    return { supplement: saved.history.value, report: saved.report.value,
        reusedOutputs: [saved.history, saved.report].map(original => ({ filename: original.filename, fileSha256: original.fileSha256 })) };
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
    planApi.verifySelectedHistoricalIdentityLinks(selected, options.blogRoot);
    const saved = savedIdentityFor(options, config, plan, planFileSha256);
    const contract = saved ? saved.contract : CONTRACT;
    const checkpoints = new Map();
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
                if (loaded.fileSha256 !== page.pageContentSha256) fail('frozen page SHA changed');
                if (hasPageTagMetadata(loaded.bytes)) continue;
                projections.push([page.pagePath,identityRecordFor(item,page,loaded.bytes,source,options,plan,planFileSha256,contract)]);
            }
            const replay = sourceIdentity(item,config,1);
            if (runner.stableHash(source)!==runner.stableHash(replay)) fail('source changed while projecting identity');
            for (const [key,record] of projections) { if (records[key]) fail('duplicate page'); records[key]=record; }
            papers += projections.length ? 1 : 0;
        } catch(error) { failures.push({paperId:item.paperId,error:String(error.message)}); }
        if (attempted % 50 === 0 || attempted === selected.length) {
            const checkpoint = { contract, records: structuredClone(records) };
            checkpoints.set(`checkpoint-${String(attempted).padStart(6, '0')}.json`, checkpoint);
            if (!saved) options.onProgress?.({attempted,paperCount:papers,pageCount:Object.keys(records).length,failures:failures.length},checkpoint);
        }
    }
    const supplement = {contract,records};
    const report = {contract:contract+'-report',planSha256:plan.planSha256,selected:selected.length,
        paperCount:papers,pageCount:Object.keys(records).length,failures,supplementSha256:runner.stableHash(supplement)};
    const result = {supplement,report};
    return saved ? reuseSavedIdentity(saved, result, checkpoints) : result;
}
module.exports = {CONTRACT,LEGACY_CONTRACT,publicSourceURL,publicAcquisition,metadataTitle,versionDisclosure,pdfVersionDisclosure,identityRecord,sourceIdentity,buildIdentitySupplement};
