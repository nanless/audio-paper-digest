'use strict';

// 发布只读回放已有来源；不建立新来源、重抽 PDF 或加载模型配置。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const discovery = require('./conference-discovery.js');
const extraction = require('./conference-extraction-receipt.js');
const adapter = require('./conference-analysis-adapter.js');
const authors = require('./reader-author-source.js');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = adapter.stableHash;
const same = (left, right) => stable(left) === stable(right);
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
function fail(message) { throw new Error(`会议发布作者来源核验失败：${message}`); }
function filename(root, name) {
    if (!/^[a-z0-9][a-z0-9._-]{0,159}\.json$/.test(name || '')) fail('来源文件名不安全');
    return path.join(root, name);
}
function readReceipt(file) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) fail('来源凭证必须为有界普通文件');
        const bytes = fs.readFileSync(fd);
        const named = fs.lstatSync(file);
        if (bytes.length !== stat.size || !named.isFile() || named.isSymbolicLink()
            || named.nlink !== 1 || named.dev !== stat.dev || named.ino !== stat.ino || named.size !== stat.size) {
            fail('来源凭证读取期间换主');
        }
        return JSON.parse(bytes.toString('utf8'));
    } finally { fs.closeSync(fd); }
}
const RETAINED_ENHANCED_EXTRACTOR_PROFILES = Object.freeze([
    // Pre-38250016 (commit 1458254f) enhanced layout extractor before pdf_author_extract.py Mode F / header-boundary fix.
    Object.freeze({
        implementationSha256: 'e34d76ec0eecc776c4e0b6cce625f148d49638729b946f2a842ec1d1dee8e819',
        dependencySha256s: Object.freeze({
            'conference_layout_extractor.py': '89eb43d6d38e8c4b54589a0657adf8efbd4be57e2e49fe032ca4a8aa5adc31bd',
            'conference_extractor.py': '36254b211c07e4070c6b1ed805764ce04b2b63572907ab581d9b21b75f03406b',
            'pdf_figure_table_extract.py': '9ac8020f84599216c6123c4a56110c3d012d5863bb872927fa7ca2a7c306ea76',
            'pdf_author_extract.py': '84debbbeaad603738d60c1b3788b32cec03f02118aac6333e86116e7e1fbc27d'
        })
    })
]);
function matchingRetainedEnhancedProfile(receipt) {
    if (!receipt || typeof receipt !== 'object' || receipt.contract !== extraction.RECEIPT_ENHANCED_CONTRACT) return null;
    const ext = receipt.extractor;
    if (!ext || typeof ext !== 'object' || ext.contract !== extraction.EXTRACTOR_ENHANCED_CONTRACT
        || ext.name !== extraction.EXTRACTOR_ENHANCED_NAME
        || ext.backend?.name !== extraction.BACKEND_NAME
        || ext.backend?.version !== extraction.BACKEND_VERSION) return null;
    if (ext.implementationSha256 === extraction.EXTRACTOR_ENHANCED_IMPLEMENTATION_SHA256) return null;
    return RETAINED_ENHANCED_EXTRACTOR_PROFILES.find(profile =>
        ext.implementationSha256 === profile.implementationSha256
        && same(ext.dependencySha256s, profile.dependencySha256s)
        && stable(ext.dependencySha256s) === profile.implementationSha256
    ) || null;
}
function retainedEnhancedSnapshot(sourceRoot, receiptName, receipt, item, profile) {
    if (receipt.status !== 'ready' || receipt.textReplayable !== true || receipt.blockedReason !== null) {
        fail('原增强抽取凭证状态无效');
    }
    const { receiptSha256, ...body } = receipt;
    if (receiptSha256 !== stable(body) || receiptSha256 !== item.sourceProof?.receiptSha256
        || receipt.paperId !== item.paperId || receipt.sourceIdentity !== item.sourceIdentity) {
        fail('原增强抽取凭证与当前成员或原SHA不一致');
    }
    const names = { receipt: receiptName, request: receipt.request?.file,
        metadata: receipt.source?.metadata?.file, pdf: receipt.source?.pdf?.file,
        text: receipt.text?.file, artifacts: receipt.artifacts?.file };
    if (Object.values(names).some(name => typeof name !== 'string'
        || !/^[a-z0-9][a-z0-9._-]{0,164}\.(?:json|pdf|txt)$/.test(name))) fail('原增强抽取文件名不安全');
    const read = key => discovery.safeAbsoluteFile(path.join(sourceRoot, names[key]), `retained enhanced ${key}`, 256 * 1024 * 1024);
    const requestFile = read('request'), request = JSON.parse(requestFile.bytes), metadataFile = read('metadata'),
        pdf = read('pdf'), text = read('text'), artifacts = read('artifacts'), receiptFile = read('receipt');
    if (request.paperId !== item.paperId || request.sourceIdentity !== item.sourceIdentity
        || request.source?.metadata?.file !== names.metadata || request.source?.pdf?.file !== names.pdf
        || request.outputs?.textFile !== names.text || request.outputs?.artifactsFile !== names.artifacts
        || request.outputs?.receiptFile !== names.receipt || receipt.request?.file !== names.request
        || receipt.request?.sha256 !== hash(requestFile.bytes)
        || !same(request.source, receipt.source)
        || request.source.metadata.sha256 !== hash(metadataFile.bytes) || request.source.pdf.sha256 !== hash(pdf.bytes)
        || receipt.text?.file !== names.text || receipt.text?.sha256 !== hash(text.bytes)
        || receipt.artifacts?.file !== names.artifacts || receipt.artifacts?.sha256 !== hash(artifacts.bytes)
        || receipt.text?.utf8Bytes !== text.bytes.length || pdf.bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
        fail('原增强抽取来源字节或身份绑定漂移');
    }
    const verification = { contract: extraction.VERIFICATION_ENHANCED_CONTRACT, status: 'verified',
        paperId: item.paperId, sourceIdentity: item.sourceIdentity, requestSha256: hash(requestFile.bytes),
        metadataSha256: hash(metadataFile.bytes), pdfSha256: hash(pdf.bytes), textSha256: hash(text.bytes),
        artifactsSha256: hash(artifacts.bytes), receiptFileSha256: hash(receiptFile.bytes),
        receiptSha256: receipt.receiptSha256 };
    verification.verificationSha256 = stable(verification);
    return { paperId: item.paperId, sourceIdentity: item.sourceIdentity, metadata: request.source.metadata,
        pdf: request.source.pdf, text: { sha256: hash(text.bytes), provenance: { extractor: extraction.EXTRACTOR_ENHANCED_NAME, implementationSha256: profile.implementationSha256 } },
        artifacts: { sha256: hash(artifacts.bytes), provenance: { extractor: extraction.EXTRACTOR_ENHANCED_NAME, implementationSha256: profile.implementationSha256 } },
        receipt: { receiptSha256: receipt.receiptSha256 }, verification };
}
function loadPublicationExtractionSnapshot(sourceRoot, receiptName, receipt, item) {
    const retainedEnhanced = matchingRetainedEnhancedProfile(receipt);
    if (retainedEnhanced) {
        return retainedEnhancedSnapshot(sourceRoot, receiptName, receipt, item, retainedEnhanced);
    }
    if (!require('./protocol-codec').hasValidHeader(receipt.extractor, 'conference-retained-pdf-extractor', 'version')) {
        return extraction.extractionHandleSnapshot(extraction.loadExtractionHandle(sourceRoot, receiptName, { replay: false }));
    }
    // Retain the original extraction identity, as normal source-upgrade replay
    // already does. Publication must not relabel old bytes as a new extraction.
    const { receiptSha256, ...body } = receipt;
    if (receiptSha256 !== stable(body) || receiptSha256 !== item.sourceProof?.receiptSha256
        || receipt.paperId !== item.paperId || receipt.sourceIdentity !== item.sourceIdentity) {
        fail('原2.3.0抽取凭证与当前成员或原SHA不一致');
    }
    const names = { receipt: receiptName, request: receipt.request?.file,
        metadata: receipt.source?.metadata?.file, pdf: receipt.source?.pdf?.file,
        text: receipt.text?.file, artifacts: receipt.artifacts?.file };
    if (Object.values(names).some(name => typeof name !== 'string'
        || !/^[a-z0-9][a-z0-9._-]{0,164}\.(?:json|pdf|txt)$/.test(name))) fail('原2.3.0抽取文件名不安全');
    return require('./conference-source-upgrade').retainedLegacySnapshot(sourceRoot, names, receipt, item, { discovery });
}
function verifyPublicationAuthorSources({ runtimeRoot, state, completion }) {
    if (!path.isAbsolute(runtimeRoot || '')) fail('运行目录必须为绝对路径');
    const authority = state?.authority;
    const handle = discovery.loadDiscoveryHandle(
        filename(path.join(runtimeRoot, 'conference-discovery-catalogs'), authority?.catalogName),
        filename(path.join(runtimeRoot, 'conference-discovery-reports'), authority?.reportName));
    const catalog = discovery.discoveryHandleSnapshot(handle);
    if (catalog.catalogSha256 !== authority.catalogSha256 || catalog.reportSha256 !== authority.reportSha256
        || catalog.candidateManifest.conference.id !== authority.conferenceId
        || catalog.candidateManifest.adapter !== 'official-proceedings') fail('官方发现凭证不一致');
    // 一次重放原元数据快照，避免每篇重新读取整个会议名单。
    const discovered = discovery.replayDiscoveryMembers(handle);
    const memberByIdentity = new Map(discovered.map(member => [member.sourceIdentity, member]));
    if (memberByIdentity.size !== discovered.length) fail('官方来源身份重复');
    const items = Object.entries(state.items || {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (!items.length || !same(items.map(([id]) => id), (completion.items || []).map(item => item.paperId).sort())) {
        fail('完成凭证没有完整覆盖当前论文集合');
    }
    const sourceRoot = path.join(runtimeRoot, 'conference-staging-sources');
    const names = fs.readdirSync(sourceRoot).filter(name => /-extraction-receipt\.json$/.test(name));
    if (names.length > 20000) fail('来源凭证数量超出只读核验限制');
    const receipts = new Map();
    let receiptBytes = 0;
    for (const name of names) {
        const stat = fs.lstatSync(filename(sourceRoot, name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('来源凭证必须为普通文件');
        const size = stat.size;
        receiptBytes += size;
        if (size > 1024 * 1024 || receiptBytes > 64 * 1024 * 1024) fail('来源凭证超过只读核验字节限制');
        const record = readReceipt(filename(sourceRoot, name));
        if (record.receiptSha256) {
            if (receipts.has(record.receiptSha256)) fail('来源凭证 SHA 重复');
            receipts.set(record.receiptSha256, { name, record });
        }
    }
    return items.map(([paperId, item]) => {
        const completed = completion.items.find(value => value.paperId === paperId);
        if (!same(completed, { paperId, analysisRunId: item.analysisRunId, sourceProof: item.sourceProof,
            analysisProof: item.analysisProof, pageProof: item.pageProof })) fail(`${paperId} 完成凭证与进程不一致`);
        const replay = memberByIdentity.get(item.sourceIdentity);
        if (!replay) fail(`${paperId} 不在已重放官方元数据集合中`);
        if (replay.match.kind !== 'exact' || replay.match.candidates.length !== 1) fail(`${paperId} 官方 PDF 不唯一`);
        const candidate = replay.match.candidates[0];
        const official = discovery.safeAbsoluteFile(path.join(catalog.candidateManifest.pdfRoot, candidate.path),
            'publication official PDF', discovery.MAX_PDF_BYTES);
        if (hash(official.bytes) !== candidate.sha256) fail(`${paperId} 官方 PDF 字节变化`);
        const retained = receipts.get(item.sourceProof?.receiptSha256);
        if (!retained) fail(`${paperId} 封存来源凭证缺失`);
        const sealed = loadPublicationExtractionSnapshot(sourceRoot, retained.name, retained.record, item);
        const metadata = { ...replay.metadataRecord, conferenceId: replay.conference.id,
            year: replay.conference.year, identity: replay.identity };
        const metadataSha = hash(Buffer.from(`${JSON.stringify(canonical(metadata), null, 2)}\n`));
        const discoveryBinding = sealed.metadata.discoveryBinding;
        if (sealed.paperId !== paperId || sealed.sourceIdentity !== item.sourceIdentity
            || sealed.metadata.sha256 !== metadataSha || sealed.pdf.sha256 !== candidate.sha256
            || !same(discoveryBinding, { catalogSha256: replay.catalogSha256,
                metadataSnapshotSha256: replay.metadataSnapshotSha256, metadataIndex: replay.metadataIndex,
                metadataRecordSha256: replay.metadataRecordSha256 })
            || ['requestSha256', 'receiptSha256', 'verificationSha256', 'textSha256', 'artifactsSha256', 'pdfSha256']
                .some(key => sealed.verification[key] !== item.sourceProof?.[key])) fail(`${paperId} 官方与封存来源不一致`);
        const loaded = adapter.loadConferenceAnalysis({ analysisRoot: path.join(runtimeRoot, 'conference-analysis-executions'),
            executionId: item.analysisRunId });
        const binding = loaded.source.sourceSnapshotBinding.sourceBinding;
        if (loaded.run.status !== 'complete' || loaded.run.paperId !== paperId
            || loaded.analysisFileSha256 !== item.analysisProof?.analysisSha256
            || loaded.run.completionReceipt.receiptSha256 !== item.analysisProof?.completionReceiptSha256
            || loaded.run.sourceSnapshotSha256 !== item.analysisProof?.sourceSnapshotSha256
            || binding.metadataSha256 !== metadataSha || binding.pdfSha256 !== sealed.pdf.sha256
            || binding.textSha256 !== sealed.text.sha256 || binding.artifactsFileSha256 !== sealed.artifacts.sha256
            || hash(loaded.source.sourceDetails.text) !== sealed.text.sha256) fail(`${paperId} 分析来源快照不一致`);
        const paper = loaded.analysis.papers[0];
        const raw = metadata.authors || metadata.author || [];
        const names = Array.isArray(raw)
            ? raw.map(entry => {
                if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
                    return typeof entry.name === 'string' ? entry.name.trim() : '';
                }
                return typeof entry === 'string' ? entry.trim() : '';
            })
            : typeof raw === 'string' ? raw.split(/\s*;\s*/).map(s => s.trim()).filter(Boolean) : [];
        const officialMetadataAuthors = require('./reader-author-parser.js').extractOfficialConferenceMetadataAuthors(metadata, metadataSha);
        if (!names.length || names.some(name => !name) || !same(paper.authors, names)
            || !authors.canReuseReaderAuthorInputs(paper, loaded.source.sourceDetails, {
                pdfBytes: official.bytes,
                expectedPdfSha256: sealed.pdf.sha256,
                officialMetadataAuthors,
                expectedMetadataSha256: metadataSha
            })) fail(`${paperId} 作者未从官方姓名全集与封存全文重放`);
        return { paperId, analysisSha256: loaded.analysisFileSha256,
            completionReceiptSha256: loaded.run.completionReceipt.receiptSha256,
            sourceSnapshotSha256: loaded.run.sourceSnapshotSha256, authors: paper.apiReaderAuthors.authors };
    });
}
module.exports = { verifyPublicationAuthorSources };
