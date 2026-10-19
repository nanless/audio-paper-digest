'use strict';

// Publication display derivations only. No Reader or process writes,
// source repair, analysis permission, budget release, or model input re-signing.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { isDeepStrictEqual: equal } = require('node:util');
const root = path.resolve(__dirname, '../..');
const CONTRACT = 'conference-publication-figure-crops-v1';
const MANIFEST = 'conference-publication-figure-crop-manifest-v1';
const SHA = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const stable = value => hash(JSON.stringify(canonical(value)));
const need = (value, message) => { if (!value) throw new Error('会议出版图片派生被拒：' + message); };
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

function beneath(parent, child) {
    const relative = path.relative(parent, child);
    need(relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative), '文件越出固定根目录');
    return child;
}
function regular(filename, limit = 64 * 1024 * 1024) {
    need(path.isAbsolute(filename), '文件必须使用绝对路径');
    const pieces = filename.split(path.sep).filter(Boolean); let cursor = path.parse(filename).root;
    for (const piece of pieces) {
        cursor = path.join(cursor, piece); const info = fs.lstatSync(cursor);
        need(!info.isSymbolicLink(), '不接受符号链接');
    }
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        need(stat.isFile() && stat.nlink === 1 && stat.size >= 1 && stat.size <= limit, '文件类型、链接数或大小不合法');
        const bytes = fs.readFileSync(fd); need(bytes.length === stat.size, '读取期间文件大小改变');
        return { bytes, sha256: hash(bytes) };
    } finally { fs.closeSync(fd); }
}
function readJson(filename, limit) {
    const result = regular(filename, limit); return { ...result, value: JSON.parse(result.bytes.toString('utf8')) };
}
function selfHash(value, key) {
    const body = { ...value }; const declared = body[key]; delete body[key];
    need(SHA.test(declared || '') && stable(body) === declared, key + ' 不合法');
    return declared;
}
function writeImmutable(filename, bytes) {
    // Only the fixed publication derivative directory is passed by the caller.
    let cursor = path.parse(filename).root;
    for (const piece of path.dirname(filename).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, piece);
        if (!fs.existsSync(cursor)) fs.mkdirSync(cursor, { mode: 0o700 });
        const info = fs.lstatSync(cursor); need(info.isDirectory() && !info.isSymbolicLink(), '派生目录不安全');
    }
    if (fs.existsSync(filename)) { need(regular(filename).bytes.equals(bytes), '不可覆盖既有派生字节'); return; }
    const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function findBaseGeneration(directory, semanticSha256, fileSha256) {
    need(SHA.test(semanticSha256 || '') && SHA.test(fileSha256 || ''), '原生成缺少语义与物理双SHA');
    const names = ['generation.json', `generation.superseded-${fileSha256.slice(0, 12)}.json`];
    const matches = [];
    for (const name of names) {
        const filename = path.join(directory, name); if (!fs.existsSync(filename)) continue;
        const loaded = readJson(filename); selfHash(loaded.value, 'generationSha256');
        if (loaded.sha256 === fileSha256 && loaded.value.generationSha256 === semanticSha256) matches.push({ ...loaded, filename });
    }
    need(matches.length === 1, '必须唯一找到原规范或不可变superseded生成记录');
    return matches[0];
}
function findStageBySha(stagingRoot, wanted, operationIndex, { executionId, paperId, pageProof } = {}) {
    need(SHA.test(wanted || '') && UUID.test(executionId || '') && typeof paperId === 'string'
        && pageProof?.manifestSha256 === wanted, '本篇暂存manifest与完整原页面证明不一致');
    const key = stable({ stagingRoot, executionId, paperId, pageProof });
    if (operationIndex.has(key)) {
        const saved = operationIndex.get(key), fresh = readJson(saved.filename);
        need(fresh.sha256 === saved.sha256, '本篇暂存manifest实物改变');
        selfHash(fresh.value, 'manifestSha256'); return { ...fresh, filename: saved.filename };
    }
    // The canonical read-only loader searches only this execution's fixed
    // registry/implementation levels, and verifies page, assignment and assets.
    // It never recursively treats unrelated asset paths as stage directories.
    const loaded = require('./conference-postprocess').loadPreservedStage({
        stagingRoot, executionId, paperId, pageProof, repair: false });
    const filename = path.join(loaded.directory, 'manifest.json'), record = readJson(filename);
    need(record.sha256 === loaded.manifestFileSha256 && record.value.manifestSha256 === wanted,
        '本篇暂存manifest物理或语义SHA不一致');
    selfHash(record.value, 'manifestSha256');
    const found = { ...record, filename }; operationIndex.set(key, found); return found;
}

function imagePath(value, conferenceId) {
    need(new RegExp('^' + conferenceId + '/[a-f0-9]{12}/figure-[1-9][0-9]*\\.png$').test(value || ''), '图片路径不合法');
    return value;
}
function actualState(runtimeRoot, processId, conferenceId) {
    const directory = path.join(runtimeRoot, 'conference-processes', processId);
    const state = readJson(path.join(directory, 'state.json')), completion = readJson(path.join(directory, 'completion-receipt.json'));
    need(state.value.processId === processId && state.value.status === 'complete'
        && state.value.authority.conferenceId === conferenceId, '实际process尚未完成');
    selfHash(completion.value, 'receiptSha256');
    need(completion.value.processId === processId && completion.value.authority.conferenceId === conferenceId
        && state.value.completionReceiptSha256 === completion.value.receiptSha256, '当前完成凭证不闭合');
    const items = Object.entries(state.value.items || {}).sort(([a], [b]) => a.localeCompare(b));
    need(items.length && items.every(([, item]) => item.status === 'complete'), '有未完成成员');
    const expected = items.map(([paperId, item]) => ({ paperId, analysisRunId: item.analysisRunId,
        sourceProof: item.sourceProof, analysisProof: item.analysisProof, pageProof: item.pageProof }));
    need(equal([...completion.value.items].sort((a, b) => a.paperId.localeCompare(b.paperId)), expected), '当前完整成员与完成凭证不一致');
    return { state, completion, items };
}
function validateFailure(runtimeRoot, member) {
    need(SHA.test(member.reviewFailureSha256 || ''), '缺少真实审查失败SHA');
    const result = readJson(path.join(runtimeRoot, 'conference-publications', 'page-review-failures', member.reviewFailureSha256 + '.json'));
    const failure = result.value; selfHash(failure, 'failureSha256');
    need(failure.failureSha256 === member.reviewFailureSha256 && failure.contract === 'conference-page-content-review-failure-v1'
        && failure.passed === false && failure.completed === true && failure.failureKind === 'content'
        && failure.stage === 'image' && failure.path === member.pagePath && failure.sha256 === member.pageSha256
        && failure.paperId === member.paperId, '不是原确切页面的完整真实图片拒稿');
    return result;
}
function retainNonblockingObservation(issue, context) {
    need(issue && typeof issue === 'object' && typeof issue.severity === 'string'
        && ['warning', 'info'].includes(issue.severity.toLowerCase()), '非阻断观察只能用于原明确warning/info');
    return { ...context, issueSha256: stable(issue), originalIssue: structuredClone(issue), doesNotGrantReviewPass: true };
}
function validatePublicationViewRoute(route) {
    need(route && ['crop', 'source-page-view'].includes(route.kind), '不是固定出版来源展示路由');
    const fields = route.kind === 'crop' ? ['evidencePath', 'evidenceSha256', 'figureOrdinals', 'issueIndex', 'kind']
        : ['figureOrdinals', 'issueIndex', 'kind'];
    need(equal(Object.keys(route).sort(), fields) && Number.isInteger(route.issueIndex) && route.issueIndex >= 0
        && Array.isArray(route.figureOrdinals) && route.figureOrdinals.length >= 1
        && route.figureOrdinals.every(value => Number.isInteger(value) && value >= 1)
        && new Set(route.figureOrdinals).size === route.figureOrdinals.length,
        '出版来源展示路由必须明确唯一原图序号且不得携带自由矩形或profile');
    if (route.kind === 'source-page-view') return null;
    need(SHA.test(route.evidenceSha256 || '') && regular(route.evidencePath).sha256 === route.evidenceSha256,
        'crop来源分类实证SHA不闭合');
    return { filename: route.evidencePath, sha256: route.evidenceSha256 };
}
function runGeometry(source, paper, figure, attestedSourceRef) {
    const number = /^Figure\s+([1-9][0-9]*)\s*[:.]?$/i.exec(figure.label || '');
    need(number, '原作者Figure编号不明确');
    const input = { pdfBase64: source.pdf.toString('base64'), pdfSha256: source.pdfSha256,
        figureNumber: Number(number[1]), fullCaption: figure.caption, title: paper.title, authors: paper.authors };
    if (attestedSourceRef?.eligible === true) input.attestedSourceRef = attestedSourceRef;
    const os = require('node:os'), child = require('node:child_process');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'conference-publication-crop-')); let fd;
    try {
        fs.chmodSync(temporary, 0o700); const filename = path.join(temporary, 'input.json');
        fs.writeFileSync(filename, JSON.stringify(input), { mode: 0o600, flag: 'wx' });
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const raw = child.execFileSync('bash', [path.join(root, 'scripts/python-runtime.sh'),
            path.join(root, 'scripts/conference_publication_figure_crop.py'), '3'], {
            cwd: root, timeout: 60000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe', fd] });
        const returned = JSON.parse(raw.toString('utf8'));
        if (returned.eligible === false && returned.reasonCode === 'unsupported_complete_figure_geometry') {
            throw Object.assign(new Error(returned.reason), { code: 'CROP_UNSUPPORTED_GEOMETRY', scope: 'paper' });
        }
        const pixels = Buffer.from(returned.generatedBytesBase64, 'base64');
        const proof = returned.proof;
        const proofCanonical = Buffer.from(returned.proofCanonicalBytesBase64, 'base64');
        const proofBody = { ...proof }; delete proofBody.proofSha256;
        need(SHA.test(proof.proofSha256 || '') && hash(proofCanonical) === proof.proofSha256
            && equal(JSON.parse(proofCanonical.toString('utf8')), proofBody), 'Python原生规范proof字节不闭合');
        need(proof.contract === 'conference-publication-pdf-figure-crop-v1' && proof.purpose === 'publication-display-only'
            && proof.readerInputPixelsChanged === false && proof.originalPdfSha256 === source.pdfSha256
            && proof.figureNumber === Number(number[1]) && proof.originalReaderCaptionSha256 === hash(figure.caption)
            && proof.assetSha256 === hash(pixels) && proof.assetBytes === pixels.length && pixels.length <= 8 * 1024 * 1024
            && proof.renderer.implementationSha256 === hash(regular(path.join(root, 'scripts/conference_publication_figure_crop.py')).bytes),
            '几何程序返回身份或像素不闭合');
        if (proof.geometry.limitedSourcePageOnly === true) {
            need(attestedSourceRef?.eligible === true && equal(proof.geometry.sourceRefAttestation, attestedSourceRef)
                && proof.geometry.page === attestedSourceRef.page && proof.geometry.fullPage === true
                && proof.geometry.completeCaptionVerified === false && proof.geometry.completeTargetCaption === null
                && ['unavailable', 'partial'].includes(proof.geometry.captionExtractionStatus), '有限原页显示缺少真实原图页范围或冒称完整图注');
        }
        source.assertUnchanged(); return { pixels, proof, figureNumber: Number(number[1]) };
    } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { recursive: true, force: true }); }
}

function freezeData(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freezeData(child);
        Object.freeze(value);
    }
    return value;
}

function maintenancePublicationHistory(input, handle) {
    // The real issuer resolves canonical generation/review/baseline/parents and
    // current adopted descendant CAS before minting this private WeakMap token.
    // There is no CLI flag or JSON alternative for this read-only old evidence.
    const scope = require('./conference-reader-review-maintenance').readMaintenancePublicationHistory(handle);
    need(scope && scope.purpose === 'reader-maintenance-historical-publication-evidence'
        && scope.processId === input.processId && scope.conferenceId === input.conferenceId
        && scope.analysisRoot === path.join(input.runtimeRoot, 'conference-analysis-executions')
        && scope.processDirectory === path.join(input.runtimeRoot, 'conference-processes', input.processId)
        && typeof scope.assertUnchanged === 'function', '缺少真实维护历史出版来源能力');
    scope.assertUnchanged();
    const view = scope.generation?.figurePublicationView;
    need(view && view.processId === input.processId && view.conferenceId === input.conferenceId
        && path.resolve(view.manifestPath) === path.resolve(input.manifestPath)
        && view.baseGenerationSha256 === input.expectedGenerationSha256
        && equal(view.nodeDerivation, input.expectedDerivation), '历史出版证据不属于实际维护原生成');
    need(scope.baselineState?.processId === input.processId && scope.baselineState.status === 'complete'
        && scope.baselineState.authority?.conferenceId === input.conferenceId
        && SHA.test(scope.baselineStateFileSha256 || '')
        && Object.values(scope.baselineState.items || {}).length > 0
        && Object.values(scope.baselineState.items).every(item => item.status === 'complete'), '历史能力缺少原实际完整基线');
    // This is explicitly the immutable historical baseline, not a fabricated
    // complete view of the current running process. Current state is separately
    // pinned by the issuer; source/Reader/stage below use this original owner.
    return { scope, state: { value: scope.baselineState, sha256: scope.baselineStateFileSha256 },
        items: Object.entries(scope.baselineState.items).sort(([a], [b]) => a.localeCompare(b)) };
}

const SOURCE_REVALIDATION = 'conference-publication-current-source-revalidation-v1';
const LEGACY_SOURCE_COMMIT = 'd1a9e292d5b91b83dfc3f3ac036027a9a82fa397';
const LEGACY_SOURCE_IMPLEMENTATION = Object.freeze({
    moduleSha256: '561b6f6539ca3c5e0b56098cfb90439e88c0174f176caf6888aa1250e4a88673',
    cliSha256: 'e4842546e5b4778e627f3e1aea0270e67548be36b00a7ac12c8e5ae2eb46c7f9',
    geometrySha256: '08d477bc45f8d5502a1dfa310acce1e3e46d76d856338217d805fe1b3c66297e',
    sharedPageGeometrySha256: '101417a041f5fa51859b5666076e83d506a2708b60cec6cb2fa273a1d458ee38',
    canonicalPdfReplaySha256: 'e2b0dca9d7b316620c4bf2b10cd7668b8fa6f46c9ed04baf16ca71605958c784',
    retainedSourceReplaySha256: '59d106dec623cc307db9dcfd17f9fd41f5401ab5378acba3e4c574a4b20a6280'
});
function verifyLegacySourceImplementation(original, implementationFiles) {
    need(equal(original.implementation, LEGACY_SOURCE_IMPLEMENTATION)
        && original.status === 'complete' && equal(original.blocked, []) && equal(original.unresolvedRoutes, []),
        '只有固定原六实现的完整历史派生可做当前来源重验');
    selfHash(original, 'derivationSha256');
    for (const [key, filename] of implementationFiles) {
        const relative = path.relative(root, filename).split(path.sep).join('/');
        need(relative.startsWith('scripts/') && !relative.includes('..'), '历史实现不属于固定源码');
        const bytes = require('node:child_process').execFileSync('git', ['show', `${LEGACY_SOURCE_COMMIT}:${relative}`],
            { cwd: root, maxBuffer: 2 * 1024 * 1024, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
        need(hash(bytes) === original.implementation[key], '原六实现真实Git blob与原声明不同');
    }
}
function projectHistoricalOutcome(current, original) {
    const old = new Map(original.derivations.map(item => [item.paperId + ':' + item.figureOrdinal, item]));
    need(old.size === original.derivations.length && current.derivations.length === old.size,
        '当前重验不能遗漏或重复原派生成员');
    const derivations = current.derivations.map(item => {
        const previous = old.get(item.paperId + ':' + item.figureOrdinal);
        need(previous, '当前重验出现未知派生成员');
        // These are the only changed fields: current proof locator/identity.
        // All pixels, URLs, source notes, target captions/pages and source owner
        // fields still participate in the complete outcome comparison below.
        return { ...item, proofPath: previous.proofPath, proofSha256: previous.proofSha256 };
    });
    const body = { ...current, implementation: original.implementation, derivations };
    delete body.derivationSha256;
    const projected = { ...body, derivationSha256: stable(body) };
    need(equal(projected, original), '当前来源重验改变原像素、几何显示目标、URL或完整原派生集合');
    return projected;
}
function currentSourceReceipt({ original, current, issuanceStateFileSha256, baselineStateFileSha256,
    generationFileSha256, originalProofs }) {
    projectHistoricalOutcome(current, original);
    const body = { contract: SOURCE_REVALIDATION, version: 1, purpose: 'read-only-source-revalidation',
        publicationPassed: false, modelRequests: 0, originalOutcomeSha256: original.derivationSha256,
        originalOutcomeCanonicalBytesSha256: hash(jsonBytes(original)), legacyImplementationCommit: LEGACY_SOURCE_COMMIT,
        originalImplementation: original.implementation, currentImplementation: current.implementation,
        issuanceStateFileSha256, baselineStateFileSha256, generationFileSha256,
        manifestFileSha256: original.manifestFileSha256, originalProofs,
        currentOutcome: current };
    return { ...body, receiptSha256: stable(body) };
}
function operation(input, replay = false, maintenanceHandle = undefined, registerSourceRevalidation = false) {
    input = structuredClone(input); // Cache closures never depend on caller mutations.
    const expectedInput = ['runtimeRoot', 'conferenceId', 'processId', 'manifestPath', 'expectedGenerationSha256',
        ...(replay ? ['expectedDerivation'] : [])];
    need(input && equal(Object.keys(input).sort(), expectedInput.sort()), '入口含未知字段或缺少固定字段');
    const { runtimeRoot, conferenceId, processId, manifestPath, expectedGenerationSha256 } = input;
    need(runtimeRoot === path.join(root, 'data/runtime') && /^[a-z0-9][a-z0-9-]{0,80}$/.test(conferenceId || '')
        && UUID.test(processId || ''), '运行根或会议/流程身份不合法');
    const publication = path.join(runtimeRoot, 'conference-publications', conferenceId, processId);
    const manifest = readJson(manifestPath, 8 * 1024 * 1024), selection = manifest.value;
    need(equal(Object.keys(selection).sort(), ['contract', 'version', 'conferenceId', 'processId',
        'baseGenerationSha256', 'baseGenerationFileSha256', 'reviewProtocolSha256', 'imageFailureUniverse', 'members'].sort()),
        'manifest含未知字段或自由几何参数');
    need(selection.contract === MANIFEST && selection.version === 1 && selection.conferenceId === conferenceId
        && selection.processId === processId && selection.baseGenerationSha256 === expectedGenerationSha256
        && Array.isArray(selection.members) && selection.members.length >= 0 && selection.members.length <= 10000,
        '出版派生完整清单不合法');
    const allowedMemberFields = ['paperId', 'figureOrdinal', 'imagePath', 'imageSha256', 'imageSize', 'pagePath',
        'pageSha256', 'analysisSha256', 'sourceSnapshotSha256', 'reviewFailureSha256', 'figureUrl',
        'sourceDomSha256', 'readerArticleSha256', 'readerPlanSha256'];
    const base = findBaseGeneration(publication, selection.baseGenerationSha256, selection.baseGenerationFileSha256);
    need(base.value.contract === 'conference-blog-generation-v1' && base.value.version === 2
        && base.value.conferenceId === conferenceId && base.value.processId === processId, '旧生成不属于本会议流程');
    need(maintenanceHandle === undefined || replay === true, '历史来源能力只能只读重放');
    const history = maintenanceHandle === undefined ? null : maintenancePublicationHistory(input, maintenanceHandle);
    const current = history || actualState(runtimeRoot, processId, conferenceId);
    need(SHA.test(selection.reviewProtocolSha256 || ''), '缺少原完整审查协议');
    const basePageRecords = new Map(base.value.files.filter(record => record.kind === 'paper')
        .map(record => [record.path, record]));
    const failureDirectory = path.join(runtimeRoot, 'conference-publications', 'page-review-failures');
    const failureSet = () => {
        const result = [];
        for (const name of fs.readdirSync(failureDirectory)) {
            if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
            const record = readJson(path.join(failureDirectory, name)).value;
            const page = basePageRecords.get(record.path);
            if (!page || page.sourceSha256 !== record.sha256 || record.protocol !== selection.reviewProtocolSha256
                || record.stage !== 'image' || record.failureKind !== 'content' || record.completed !== true) continue;
            selfHash(record, 'failureSha256');
            need(record.passed === false && record.paperId === page.paperId && name === record.failureSha256 + '.json',
                '原全批图片拒稿身份不合法');
            result.push(record.failureSha256);
        }
        return result.sort();
    };
    const originalFailureSet = failureSet();
    need(Array.isArray(selection.imageFailureUniverse) && originalFailureSet.length >= 1
        && equal(selection.imageFailureUniverse.map(record => record.failureSha256).sort(), originalFailureSet),
        '清单没有逐项记录原同协议完整图片拒稿universe');
    const cropRoutes = new Set(), deferredRoutes = [], unresolvedRoutes = [], nonblockingObservations = [], routeEvidencePins = [];
    for (const entry of selection.imageFailureUniverse) {
        need(equal(Object.keys(entry).sort(), ['failureSha256', 'routes']), '拒稿universe含未知字段');
        const failureFile = path.join(failureDirectory, entry.failureSha256 + '.json');
        const failureRecord = readJson(failureFile), failure = failureRecord.value;
        selfHash(failure, 'failureSha256');
        need(failure.failureSha256 === entry.failureSha256, '原拒稿内容地址不闭合');
        routeEvidencePins.push({ filename: failureFile, sha256: failureRecord.sha256 });
        need(Array.isArray(entry.routes) && entry.routes.length >= 1 && Array.isArray(failure.issues), '拒稿没有明确issue路由');
        const covered = new Set();
        for (const route of entry.routes) {
            need(Number.isInteger(route.issueIndex) && route.issueIndex >= 0 && route.issueIndex < failure.issues.length
                && ['crop', 'source-page-view', 'reader-maintenance', 'protocol-replay', 'unresolved', 'nonblocking-observation'].includes(route.kind), 'issue路由索引或类型不合法');
            covered.add(route.issueIndex);
            const originalIssue = failure.issues[route.issueIndex];
            if (route.kind === 'nonblocking-observation') {
                need(equal(Object.keys(route).sort(), ['issueIndex', 'kind']), '非阻断观察不得附加修改权限');
                nonblockingObservations.push(retainNonblockingObservation(originalIssue, {
                    failureSha256: entry.failureSha256, paperId: failure.paperId, issueIndex: route.issueIndex,
                    originalPagePath: failure.path, originalPageSha256: failure.sha256,
                    originalFailureFileSha256: readJson(path.join(failureDirectory, entry.failureSha256 + '.json')).sha256 }));
                continue;
            }
            if (route.kind !== 'unresolved') need(originalIssue && typeof originalIssue.severity === 'string'
                && originalIssue.severity.toLowerCase() === 'error', '实际修复路由只能用于原真实blocking error');
            if (['crop', 'source-page-view'].includes(route.kind)) {
                const evidencePin = validatePublicationViewRoute(route);
                if (evidencePin) routeEvidencePins.push(evidencePin);
                // source-page-view makes no diagnosis or scientific repair
                // claim. Real member/PDF/Figure/source pins remain mandatory.
                for (const ordinal of route.figureOrdinals) cropRoutes.add(entry.failureSha256 + ':' + ordinal);
            } else {
                // This module records other real routes without declaring them
                // scientifically fixed or authorizing a changed review protocol.
                const required = route.kind === 'unresolved' ? ['issueIndex', 'kind', 'reason']
                    : route.kind === 'reader-maintenance' ? ['evidencePath', 'evidenceSha256', 'issueIndex', 'kind', 'maintenanceManifestPath', 'maintenanceManifestSha256']
                    : ['evidencePath', 'evidenceSha256', 'issueIndex', 'kind'];
                need(equal(Object.keys(route).sort(), required), '非crop路由字段不完整');
                if (route.kind !== 'unresolved') {
                    need(SHA.test(route.evidenceSha256 || '') && regular(route.evidencePath).sha256 === route.evidenceSha256,
                        '路由来源分类实证SHA不闭合');
                    routeEvidencePins.push({ filename: route.evidencePath, sha256: route.evidenceSha256 });
                    if (route.kind === 'reader-maintenance') need(SHA.test(route.maintenanceManifestSha256 || '')
                        && regular(route.maintenanceManifestPath).sha256 === route.maintenanceManifestSha256,
                        '独立正常Reader维护manifest引用不闭合');
                    if (route.kind === 'reader-maintenance') routeEvidencePins.push({ filename: route.maintenanceManifestPath, sha256: route.maintenanceManifestSha256 });
                } else need(typeof route.reason === 'string' && route.reason.trim(), 'unresolved必须保留真实原因');
                (route.kind === 'unresolved' ? unresolvedRoutes : deferredRoutes).push({ failureSha256: entry.failureSha256,
                    paperId: failure.paperId, originalPagePath: failure.path, originalPageSha256: failure.sha256, ...route });
            }
        }
        need(covered.size === failure.issues.length, '拒稿中有issue被遗漏');
    }
    need(equal([...cropRoutes].sort(), selection.members.map(member => member.reviewFailureSha256 + ':' + member.figureOrdinal).sort()),
        'crop成员与完整universe真实crop路由不一致');
    const baseMembers = (base.value.files || []).filter(file => file.kind === 'paper').map(file => file.paperId).sort();
    need(equal(baseMembers, current.items.map(([id]) => id).sort()), '全体成员不能随派生更换');
    const adapter = require('./conference-analysis-adapter'), pdfApi = require('./conference-reader-publication-evidence');
    const implementationFiles = [
        ['moduleSha256', __filename],
        ['cliSha256', path.join(__dirname, 'conference-publication-figure-crop-replay-cli.js')],
        ['geometrySha256', path.join(root, 'scripts/conference_publication_figure_crop.py')],
        ['sharedPageGeometrySha256', path.join(root, 'scripts/reader_pdf_page_geometry.py')],
        ['canonicalPdfReplaySha256', path.join(__dirname, 'conference-reader-publication-evidence.js')],
        ['retainedSourceReplaySha256', path.join(__dirname, 'conference-retained-source-replay.js')],
    ];
    const implementation = Object.fromEntries(implementationFiles.map(([key, filename]) => [key, regular(filename).sha256]));
    const revalidation = history && !equal(implementation, input.expectedDerivation.implementation);
    need(!registerSourceRevalidation || revalidation, '显式来源重验只用于真实历史实现升级');
    const oldProofPins = [];
    let receiptFile, receiptState, issuanceStateSnapshotPath;
    let currentStatePin;
    if (revalidation) {
        verifyLegacySourceImplementation(input.expectedDerivation, implementationFiles);
        // Source-only upgrade: geometry and every other fixed producer remain
        // the authentic historical implementation; no general code migration.
        for (const key of ['cliSha256', 'geometrySha256', 'sharedPageGeometrySha256', 'retainedSourceReplaySha256']) {
            need(implementation[key] === input.expectedDerivation.implementation[key], '来源重验不得迁移几何、CLI或封存来源实现');
        }
        need(typeof history.scope.assertIssuanceState === 'function', '来源重验缺少真实opaque签发状态核验器');
        const stateFile = path.join(history.scope.processDirectory, 'state.json');
        const actualStateAtEntry = regular(stateFile);
        history.scope.assertUnchanged();
        currentStatePin = { filename: stateFile, sha256: actualStateAtEntry.sha256 };
        const verificationDirectory = path.join(publication, 'figure-source-revalidations',
            input.expectedDerivation.derivationSha256, stable(implementation));
        receiptFile = path.join(verificationDirectory, 'receipt.json');
        if (fs.existsSync(receiptFile)) {
            const saved = readJson(receiptFile).value;
            need(SHA.test(saved.issuanceStateFileSha256 || ''), '原来源重验缺少真实签发状态SHA');
            history.scope.assertIssuanceState(saved.issuanceStateFileSha256);
            issuanceStateSnapshotPath = path.join(verificationDirectory,
                'issuance-state-' + saved.issuanceStateFileSha256 + '.json');
            receiptState = regular(issuanceStateSnapshotPath);
            need(receiptState.sha256 === saved.issuanceStateFileSha256, '来源重验签发状态原字节漂移');
        } else {
            // No cold installation and no implicit state transition signing.
            need(registerSourceRevalidation, '当前来源重验receipt缺失，须显式正常重验');
            history.scope.assertIssuanceState(actualStateAtEntry.sha256);
            receiptState = actualStateAtEntry;
            issuanceStateSnapshotPath = path.join(verificationDirectory,
                'issuance-state-' + receiptState.sha256 + '.json');
            writeImmutable(issuanceStateSnapshotPath, receiptState.bytes);
        }
        const issuance = require('./conference-process').assertState(JSON.parse(receiptState.bytes.toString('utf8')));
        need(issuance.processId === processId && issuance.authority.conferenceId === conferenceId
            && equal(Object.keys(issuance.items).sort(), current.items.map(([id]) => id).sort()),
            '来源重验签发状态不属于同一真实完整成员集合');
    }

    const outRoot = path.join(publication, 'figure-crop-derivations', manifest.sha256);
    const results = [], blocked = [], seen = new Set(), destinations = new Map(), stageIndexes = new Map(), sourceCache = new Map(), sourceHandles = new Map();
    const pins = [{ filename: manifestPath, sha256: manifest.sha256 }, { filename: base.filename, sha256: base.sha256 }, ...routeEvidencePins,
        ...implementationFiles.map(([key, filename]) => ({ filename, sha256: implementation[key] }))];
    if (revalidation) pins.push(currentStatePin, { filename: issuanceStateSnapshotPath, sha256: receiptState.sha256 });
    for (const member of selection.members) {
        need(equal(Object.keys(member).sort(), allowedMemberFields.slice().sort()), '清单含未知字段或自由几何参数');
        need(Number.isInteger(member.figureOrdinal) && member.figureOrdinal > 0, '原figureOrdinal不合法');
        const key = member.paperId + ':' + member.figureOrdinal; need(!seen.has(key), '派生成员重复'); seen.add(key);
        imagePath(member.imagePath, conferenceId);
        const item = current.state.value.items[member.paperId]; need(item, '论文不在当前规范成员中');
        const failure = validateFailure(runtimeRoot, member);
        const oldPage = base.value.files.filter(record => record.kind === 'paper' && record.paperId === member.paperId);
        const oldImage = base.value.imageFiles.filter(record => record.kind === 'asset' && record.paperId === member.paperId
            && record.path === member.imagePath);
        need(oldPage.length === 1 && oldImage.length === 1 && oldPage[0].path === member.pagePath
            && oldPage[0].sourceSha256 === member.pageSha256 && oldImage[0].sourceSha256 === member.imageSha256
            && oldImage[0].size === member.imageSize, '原生成图片及页面身份不闭合');
        for (const record of [oldPage[0], oldImage[0]]) {
            beneath(path.join(runtimeRoot, 'conference-page-staging'), record.sourcePath);
            const saved = regular(record.sourcePath); need(saved.sha256 === record.sourceSha256 && saved.bytes.length === record.size,
                '原生成来源实物漂移'); pins.push({ filename: record.sourcePath, sha256: saved.sha256 });
        }
        const originalStage = readJson(path.join(path.dirname(oldPage[0].sourcePath), 'manifest.json'));
        selfHash(originalStage.value, 'manifestSha256');
        need(originalStage.value.manifestSha256 === oldPage[0].manifestSha256
            && oldImage[0].manifestSha256 === oldPage[0].manifestSha256
            && originalStage.value.paperId === member.paperId && originalStage.value.analysisExecutionId === item.analysisRunId
            && originalStage.value.analysisSha256 === member.analysisSha256
            && originalStage.value.sourceSnapshotSha256 === member.sourceSnapshotSha256
            && originalStage.value.contentSha256 === member.pageSha256, '原完整暂存与当前执行/来源不同');
        pins.push({ filename: path.join(path.dirname(oldPage[0].sourcePath), 'manifest.json'), sha256: originalStage.sha256 });
        // Current stage may have different implementation metadata, but its
        // actual page/asset bytes and this member's analysis must be identical.
        need(item.pageProof.contentSha256 === member.pageSha256 && item.analysisProof.analysisSha256 === member.analysisSha256
            && item.analysisProof.sourceSnapshotSha256 === member.sourceSnapshotSha256, '成员已改变，须新真实图片审查');
        const stage = findStageBySha(path.join(runtimeRoot, 'conference-page-staging'), item.pageProof.manifestSha256, stageIndexes,
            { executionId: item.analysisRunId, paperId: member.paperId, pageProof: item.pageProof });
        const stagePage = regular(path.join(path.dirname(stage.filename), 'page.md'));
        need(stage.value.paperId === member.paperId && stage.value.analysisExecutionId === item.analysisRunId
            && stage.value.analysisSha256 === member.analysisSha256 && stage.value.contentSha256 === stagePage.sha256
            && stagePage.sha256 === member.pageSha256, '当前暂存来源不同');
        const sourceAsset = 'static/images/conference/' + member.imagePath;
        const currentAsset = stage.value.assets.filter(record => record.path === sourceAsset);
        need(currentAsset.length === 1 && currentAsset[0].sha256 === member.imageSha256
            && currentAsset[0].size === member.imageSize, '当前暂存像素已变化');
        pins.push({ filename: stage.filename, sha256: stage.sha256 },
            { filename: path.join(path.dirname(stage.filename), 'page.md'), sha256: stagePage.sha256 });
        const stagedPixels = regular(path.join(path.dirname(stage.filename), 'assets', sourceAsset));
        need(stagedPixels.sha256 === member.imageSha256 && stagedPixels.bytes.length === member.imageSize, '当前暂存像素实物不符');
        pins.push({ filename: path.join(path.dirname(stage.filename), 'assets', sourceAsset), sha256: stagedPixels.sha256 });
        const loaded = adapter.loadConferenceAnalysis({ analysisRoot: path.join(runtimeRoot, 'conference-analysis-executions'), executionId: item.analysisRunId });
        const paper = loaded.analysis.papers[0];
        need(loaded.run.status === 'complete' && loaded.analysis.status === 'complete'
            && loaded.run.paperId === member.paperId && loaded.analysisFileSha256 === member.analysisSha256
            && loaded.run.completionReceipt.receiptSha256 === item.analysisProof.completionReceiptSha256
            && loaded.run.sourceSnapshotSha256 === member.sourceSnapshotSha256
            && hash(paper.apiReaderArticle) === member.readerArticleSha256 && paper.apiReaderPlanSha256 === member.readerPlanSha256,
            '真实当前完成稿或Reader已变化');
        const figures = (paper.apiReaderFigures || []).filter(f => f.ordinal === member.figureOrdinal);
        need(figures.length === 1, '原图片序号不唯一'); const figure = figures[0];
        need(figure.url === member.figureUrl && figure.sourceDomSha256 === member.sourceDomSha256
            && figure.assetSha256 === member.imageSha256 && figure.assetBytes === member.imageSize,
            '原Reader像素或来源图身份改变');
        const originalSource = loaded.source.sourceDetails.structuredArtifacts.figures.filter(f => f.ordinal === figure.ordinal);
        need(originalSource.length === 1 && originalSource[0].label === figure.label
            && require('../deep-analyzer').getApiReaderFigureInventory(loaded.source.sourceDetails.structuredArtifacts)
                .some(candidate => candidate.ordinal === figure.ordinal && candidate.label === figure.label
                    && candidate.caption === figure.caption && candidate.url === figure.url && candidate.sourceDomSha256 === figure.sourceDomSha256)
            && originalSource[0].sourceDomSha256 === figure.sourceDomSha256
            && originalSource[0].images.some(image => image.url === figure.url), '原来源图号/完整或截断caption身份不一致');
        const sourceIdentity = { contract: 'conference-reader-pdf-source-v1', paperId: loaded.run.paperId,
            sourceSnapshotSha256: loaded.run.sourceSnapshotSha256,
            rawStructuredArtifactsSha256: loaded.source.sourceSnapshotBinding.sourceBinding.artifactsPayloadSha256,
            effectiveStructuredArtifactsSha256: loaded.source.sourceDetails.structuredArtifacts.payloadSha256,
            sourceSnapshotBinding: loaded.source.sourceSnapshotBinding, planAuthorityBinding: loaded.source.planAuthorityBinding,
            executionId: loaded.run.executionId };
        const sourceKey = loaded.run.executionId + ':' + loaded.analysisFileSha256 + ':' + loaded.sourceFileSha256;
        let source = sourceCache.get(sourceKey);
        if (!source) {
            const handle = pdfApi.replayCanonicalReaderPdfSource(paper, sourceIdentity);
            source = pdfApi.readVerifiedPublicationReaderPdfSource(handle);
            need(source && source.paperId === member.paperId && equal(source.sourceIdentity, sourceIdentity), '缺少真实PDF来源能力');
            sourceCache.set(sourceKey, source); sourceHandles.set(sourceKey, handle);
        } else {
            need(equal(source.sourceIdentity, sourceIdentity), '同操作PDF来源能力身份改变');
            source.assertUnchanged();
        }
        const attested = pdfApi.readVerifiedPublicationReaderPdfAttestedFigureRef(sourceHandles.get(sourceKey), { ordinal: figure.ordinal });
        need(attested && (attested.eligible === false && attested.reason === 'original_attested_figure_page_ref_unavailable'
            || attested.eligible === true && attested.paperId === member.paperId && attested.executionId === sourceIdentity.executionId
                && attested.ordinal === figure.ordinal && attested.sourceDomSha256 === figure.sourceDomSha256
                && attested.originalCaptionSha256 === hash(originalSource[0].caption) && attested.readerCaptionSha256 === hash(figure.caption) && attested.pdfSha256 === source.pdfSha256
                && figure.label === `Figure ${attested.figureNumber}`), '原图原始页码证明未绑定本次真实来源能力');
        let derived;
        try { derived = runGeometry(source, paper, figure, attested); }
        catch (error) {
            if (error.code !== 'CROP_UNSUPPORTED_GEOMETRY') throw error;
            source.assertUnchanged();
            const failed = { contract: 'conference-publication-figure-crop-blocked-v1', purpose: 'publication-display-only',
                manifestFileSha256: manifest.sha256, baseGenerationSha256: selection.baseGenerationSha256, implementation,
                ...member, reasonCode: error.code, reason: error.message,
                geometryImplementationSha256: regular(path.join(root, 'scripts/conference_publication_figure_crop.py')).sha256 };
            const receipt = { ...failed, blockedSha256: stable(failed) };
            const blockedReceiptPath = path.join(outRoot, 'blocked-' + receipt.blockedSha256 + '.json');
            if (replay) need(regular(blockedReceiptPath).bytes.equals(jsonBytes(receipt)), '未支持项的原真实阻断记录漂移');
            else writeImmutable(blockedReceiptPath, jsonBytes(receipt));
            pins.push({ filename: blockedReceiptPath, sha256: hash(jsonBytes(receipt)) });
            blocked.push({ paperId: member.paperId, figureOrdinal: member.figureOrdinal,
                reviewFailureSha256: member.reviewFailureSha256, reasonCode: error.code, reason: error.message,
                blockedReceiptPath, blockedReceiptSha256: receipt.blockedSha256 });
            continue;
        }
        const directoryIdentity = { paperId: member.paperId, figureOrdinal: figure.ordinal,
            figureNumber: derived.figureNumber, originalSourceDomSha256: figure.sourceDomSha256,
            publicationPixelSha256: hash(derived.pixels) };
        const directoryHash = stable(directoryIdentity);
        const newImagePath = `${conferenceId}/${directoryHash.slice(0, 12)}/figure-${figure.ordinal}.png`;
        need(newImagePath !== member.imagePath && !base.value.imageFiles.some(record => record.path === newImagePath), '新内容地址与既有目录冲突');
        need(!destinations.has(newImagePath), '12位路径发生碰撞'); destinations.set(newImagePath, directoryHash);
        const oldUrlSuffix = '/' + member.imagePath;
        const urls = [...stagePage.bytes.toString('utf8').matchAll(/https:\/\/[^\s<>\)\]]+/g)].map(match => match[0]).filter(url => url.endsWith(oldUrlSuffix));
        need(new Set(urls).size === 1, '原页面图片URL不唯一'); const originalUrl = urls[0];
        const newUrl = originalUrl.slice(0, -member.imagePath.length) + newImagePath;
        const proofBody = { contract: CONTRACT, purpose: 'publication-display-only', baseGenerationSha256: selection.baseGenerationSha256,
            baseGenerationFileSha256: selection.baseGenerationFileSha256, originalCompletionReceiptSha256: base.value.completionReceiptSha256,
            manifestFileSha256: manifest.sha256, conferenceId, processId, implementation, ...member,
            originalStageManifestSha256: oldPage[0].manifestSha256, originalReaderPixelSha256: member.imageSha256,
            canonicalSourceIdentity: sourceIdentity, originalPdfSha256: source.pdfSha256,
            geometryProof: derived.proof, directoryIdentity, directorySha256: directoryHash,
            originalUrl, newUrl, newImagePath, publicationPixelSha256: hash(derived.pixels),
            readerInputPixelsChanged: false, sourceNote: derived.proof.geometry.limitedSourcePageOnly
                ? `原论文 PDF 第 ${derived.proof.geometry.page} 页，本文讨论 Figure ${derived.figureNumber}（完整原页；图注未完整抽取，以原页为准）`
                : derived.proof.geometry.fullPage
                ? `原论文 PDF 第 ${derived.proof.geometry.page} 页，本文讨论 Figure ${derived.figureNumber}（完整原页）`
                : `原论文 PDF 第 ${derived.proof.geometry.page} 页 Figure ${derived.figureNumber}（出版显示裁切）` };
        const proof = { ...proofBody, proofSha256: stable(proofBody) };
        const derivedSourcePath = path.join(outRoot, hash(derived.pixels) + '.png');
        const proofPath = revalidation
            ? path.join(publication, 'figure-source-revalidations', input.expectedDerivation.derivationSha256,
                stable(implementation), 'proofs', proof.proofSha256 + '.json')
            : path.join(outRoot, proof.proofSha256 + '.json');
        if (revalidation) {
            const old = input.expectedDerivation.derivations.filter(item => item.paperId === member.paperId
                && item.figureOrdinal === member.figureOrdinal);
            need(old.length === 1, '原派生没有唯一同论文同图证明');
            const originalBody = { ...proofBody, implementation: input.expectedDerivation.implementation };
            const originalProof = { ...originalBody, proofSha256: stable(originalBody) };
            const expectedPath = path.join(outRoot, originalProof.proofSha256 + '.json');
            need(old[0].proofPath === expectedPath && old[0].proofSha256 === originalProof.proofSha256,
                '原proof路径或身份与本次同PDF几何重算不一致');
            const previous = regular(expectedPath);
            need(previous.bytes.equals(jsonBytes(originalProof)), '原完整proof与当前正常几何或源逐字不同');
            oldProofPins.push({ filename: expectedPath, sha256: previous.sha256 });
            pins.push({ filename: expectedPath, sha256: previous.sha256 });
        }
        if (replay) {
            need(regular(derivedSourcePath, 8 * 1024 * 1024).bytes.equals(derived.pixels), '保存的派生图无法冷重放');
            if (revalidation && registerSourceRevalidation) writeImmutable(proofPath, jsonBytes(proof));
            else need(regular(proofPath).bytes.equals(jsonBytes(proof)), '保存的完整proof无法冷重放');
        } else { writeImmutable(derivedSourcePath, derived.pixels); writeImmutable(proofPath, jsonBytes(proof)); }
        pins.push({ filename: derivedSourcePath, sha256: hash(derived.pixels) },
            { filename: proofPath, sha256: hash(jsonBytes(proof)) });
        source.assertUnchanged();
        pins.push({ filename: failure.filename || path.join(runtimeRoot, 'conference-publications', 'page-review-failures', member.reviewFailureSha256 + '.json'), sha256: failure.sha256 });
        results.push({ paperId: member.paperId, figureOrdinal: figure.ordinal, figureNumber: derived.figureNumber,
            originalImagePath: member.imagePath, originalUrl, newImagePath, newUrl, derivedSourcePath,
            sha256: hash(derived.pixels), size: derived.pixels.length, sourceNote: proof.sourceNote,
            reviewTarget: { displayMode: derived.proof.geometry.limitedSourcePageOnly ? 'source-pdf-attested-source-page-only-v1'
                : derived.proof.geometry.fullPage ? 'source-pdf-full-page-v1' : 'source-pdf-figure-crop-v1',
                pdfPage: derived.proof.geometry.page, targetPrintedFigureNumber: derived.figureNumber,
                originalPdfSha256: derived.proof.originalPdfSha256, completeTargetCaption: derived.proof.geometry.limitedSourcePageOnly ? null : derived.proof.geometry.caption.rawText,
                ...(derived.proof.geometry.limitedSourcePageOnly ? {captionExtractionStatus: derived.proof.geometry.captionExtractionStatus} : {}) },
            proofPath, proofSha256: proof.proofSha256 });
    }
    const assertUnchanged = () => {
        pdfApi.assertVerifiedPublicationReaderPdfSourcesUnchanged([...sourceHandles.values()]);
        need(equal(failureSet(), originalFailureSet), '图片拒稿集合在操作中改变');
        for (const pin of pins) need(regular(pin.filename).sha256 === pin.sha256, '派生过程中原字节漂移');
        if (history) {
            history.scope.assertUnchanged();
            const checked = maintenancePublicationHistory(input, maintenanceHandle);
            need(checked.state.sha256 === current.state.sha256, '历史维护基线在操作中改变');
        } else {
            const after = actualState(runtimeRoot, processId, conferenceId);
            need(after.state.sha256 === current.state.sha256 && after.completion.sha256 === current.completion.sha256, '当前完整state在操作中改变');
        }
    };
    assertUnchanged();
    const body = { contract: CONTRACT, purpose: 'publication-display-only', conferenceId, processId,
        baseGenerationSha256: selection.baseGenerationSha256, baseGenerationFileSha256: selection.baseGenerationFileSha256,
        manifestFileSha256: manifest.sha256, implementation, status: blocked.length || unresolvedRoutes.length ? 'partial' : 'complete',
        publicationPassed: false, derivations: results, blocked, deferredRoutes, unresolvedRoutes, nonblockingObservations };
    const outcome = { ...body, derivationSha256: stable(body) };
    if (revalidation) {
        const receipt = currentSourceReceipt({ original: input.expectedDerivation, current: outcome,
            issuanceStateFileSha256: receiptState.sha256, baselineStateFileSha256: history.scope.baselineStateFileSha256,
            generationFileSha256: history.scope.generationFileSha256, originalProofs: oldProofPins });
        history.scope.assertUnchanged();
        need(regular(path.join(history.scope.processDirectory, 'state.json')).sha256 === currentStatePin.sha256,
            '当前来源重验期间真实state变化');
        if (registerSourceRevalidation) writeImmutable(receiptFile, jsonBytes(receipt));
        else need(regular(receiptFile).bytes.equals(jsonBytes(receipt)), '当前来源重验receipt不能正常重放');
        pins.push({ filename: receiptFile, sha256: hash(jsonBytes(receipt)) });
        assertUnchanged();
        return Object.freeze({ referencedOriginalOutcome: freezeData(structuredClone(input.expectedDerivation)),
            currentOutcome: freezeData(structuredClone(outcome)), currentRevalidationReceipt: freezeData(receipt),
            currentRevalidationReceiptPath: receiptFile, issuanceStateSnapshotPath, assertUnchanged });
    }
    if (replay) need(equal(outcome, input.expectedDerivation), '完整派生清单或来源发生漂移');
    return history ? Object.freeze({ outcome: freezeData(structuredClone(outcome)), assertUnchanged }) : outcome;
}
async function derivePublicationFigureCrops(input) {
    return require('./analysis-stop-control').withModelRequestsForbidden(() => operation(input, false));
}
async function replayPublicationFigureCrops(input) {
    return require('./analysis-stop-control').withModelRequestsForbidden(() => operation(input, true));
}
function replayPublicationFigureCropsForMaintenance(input, maintenanceHandle) {
    need(input && input.expectedDerivation && maintenanceHandle, '维护历史重放需要真实原派生及私有能力');
    return require('./analysis-stop-control').withModelRequestsForbidden(() => operation(input, true, maintenanceHandle));
}
function revalidatePublicationFigureCropsForMaintenance(input, maintenanceHandle) {
    need(input && input.expectedDerivation && maintenanceHandle, '显式当前来源重验需要真实历史能力');
    return require('./analysis-stop-control').withModelRequestsForbidden(() => operation(input, true, maintenanceHandle, true));
}
module.exports = { CONTRACT, derivePublicationFigureCrops, replayPublicationFigureCrops, replayPublicationFigureCropsForMaintenance,
    revalidatePublicationFigureCropsForMaintenance };
