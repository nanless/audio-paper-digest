'use strict';
// An erroneous global table prohibition can be narrowed to its actual location.
// The original feedback, model input, pending proof and candidate stay intact.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual: equal } = require('node:util');
const daily = require('./daily-fresh-source-plan');
const repair = require('./reader-repair');
const CONTRACT = 'daily-reader-fact-table-claim-location-v1';
const FIELD = 'apiReaderFactFeedbackCorrection';
const STAGE_FIELD = 'factReviewClaimLocationCorrection';
const scope = new AsyncLocalStorage(), prepared = new WeakMap();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = message => { throw Object.assign(new Error(`Reader表格反馈位置更正拒绝：${message}`), { code: 'READER_FACT_LOCATION_CORRECTION', retryable: false }); };
function need(condition, message) { if (!condition) fail(message); }
function read(file, maximum = 32 * 1024 * 1024) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const s = fs.fstatSync(fd);
        need(s.isFile() && s.nlink === 1 && (s.mode & 0o777) === 0o600 && s.size <= maximum, '原材料须为有界0600独立文件');
        return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
}
function safeDirectory(directory, create = false) {
    let current = path.parse(path.resolve(directory)).root;
    for (const part of path.resolve(directory).slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        if (create) { try { fs.lstatSync(current); } catch (e) {
            if (e.code !== 'ENOENT') throw e; fs.mkdirSync(current, { mode: 0o700 });
        } }
        const s = fs.lstatSync(current); need(s.isDirectory() && !s.isSymbolicLink(), '归档路径不得包含软链接');
    }
}
function writeExact(file, bytes) {
    try {
        const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (e) { if (e.code !== 'EEXIST') throw e; need(read(file).equals(bytes), '已有不可变归档不同'); }
    const fd = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function planFor(paper, optional = false) {
    const marked = paper?.[FIELD] !== undefined || paper?.analysisManifest?.stages?.apiReaderArticle?.[STAGE_FIELD] !== undefined;
    const prov = paper?.freshRewriteProvenance;
    const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
    if (prov?.contract !== 'fresh-source-analysis-v1' || !uuid.test(prov?.runId || '')) {
        if (optional && !marked) return null;
        fail('更正标记缺少真实日更来源');
    }
    const runDir = path.join(require('../config').FILES.dailyFreshSourceRunsDir, prov.runId);
    const filename = path.join(runDir, 'run.json');
    let run;
    try { run = JSON.parse(read(filename)); } catch (error) {
        if (optional && !marked && error.code === 'ENOENT') return null;
        throw error;
    }
    if (run.contract !== require('./fresh-analysis-context').DAILY_SOURCE_RUN_CONTRACT) {
        if (optional && !marked) return null;
        fail('更正标记不能跨非日更来源');
    }
    return daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({ ...run, runDir }));
}
function directory(plan) { return path.join(plan.runDir, 'reader-feedback-corrections'); }
function indexFile(plan, paperId) { return path.join(directory(plan), paperId + '.json'); }
function id(paper) { return require('../utils').normalizedId(paper); }
function sourceFor(paper, plan) {
    need(equal(daily.dailyFreshSourceReference(plan), daily.dailyFreshSourceReference(planFor(paper))), '必须读取当前规范来源根');
    const source = daily.readDailyFreshSource(plan, paper);
    need(daily.isPaperBoundToPlan(paper, plan), '论文未绑定真实四源');
    return source;
}
function withSource(paper, plan, callback) {
    const source = sourceFor(paper, plan);
    return daily.withDailyFreshAnalysisContext(plan, () => require('./fresh-analysis-context').withFreshPaperContext(paper,
        () => require('./fresh-analysis-context').withVerifiedBundleReaderAuthorSource(source, () =>
            require('./reader-table-pdf-evidence').withArtifacts(source.structuredArtifacts, paper.arxivId, () => callback(source)))));
}
function wholeTable(claim) {
    const tables = require('../analysis-contract').extractMarkdownTables(claim);
    need(typeof claim === 'string' && tables.length === 1 && tables[0].markdown === claim
        && tables[0].rows.length > 0 && tables[0].header.length > 1, '只允许唯一完整真实表字符串');
    return tables[0];
}
function sectionsOf(paper) { return require('../deep-analyzer').readerResourceClaimDraftFromArticle(paper.apiReaderPlan, paper.apiReaderArticle).sections; }
function rawBindings(paper) { return require('./signed-reader-recovery-draft').convert({ initialDraft: JSON.stringify({
    article: paper.apiReaderArticle, plan: paper.apiReaderPlan }) }).tableBindings; }
function allText(draft) {
    const strings = [];
    const visit = value => { if (typeof value === 'string') strings.push(value);
        else if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') Object.values(value).forEach(visit); };
    visit(draft); return strings;
}
function occurrenceCount(strings, text) { return strings.reduce((n, value) => n + value.split(text).length - 1, 0); }
function slot(sections, sectionIndex, tableIndex) {
    need(Number.isSafeInteger(sectionIndex) && sectionIndex >= 0 && sections[sectionIndex]
        && Number.isSafeInteger(tableIndex) && tableIndex > 0, '小节或表序号无效');
    let count = 0, found;
    for (const [i, section] of sections.entries()) for (const table of require('../analysis-contract').extractMarkdownTables(section.body)) {
        count++;
        if (count === tableIndex) found = { sectionIndex: i, kind: section.kind, heading: section.heading,
            tableIndex, markdown: table.markdown };
    }
    need(found && found.sectionIndex === sectionIndex, '表不在绑定的原小节');
    return found;
}
// Pure structural inspection; it cannot issue a source capability or a pass.
function inspectLocations(record, draft) {
    const feedback = JSON.parse(record.feedbackBytes), claim = feedback.rejectedReaderClaims[record.claimIndex];
    wholeTable(claim);
    need(feedback.rejectedReaderClaims.filter(value => value === claim).length === 1, '错误表claim须在原包唯一');
    const parentSections = sectionsOf(record.parentPaper);
    const wrong = slot(parentSections, record.wrong.sectionIndex, record.wrong.tableIndex);
    const keeper = slot(parentSections, record.keeper.sectionIndex, record.keeper.tableIndex);
    need(wrong.sectionIndex !== keeper.sectionIndex && wrong.markdown === claim && keeper.markdown === claim
        && equal(wrong, record.wrong) && equal(keeper, record.keeper)
        && occurrenceCount([record.parentPaper.apiReaderArticle], claim) === 2, '原父稿必须恰有错位与合法保留两个位置');
    const currentWrong = slot(draft.sections, wrong.sectionIndex, wrong.tableIndex);
    const currentKeeper = slot(draft.sections, keeper.sectionIndex, keeper.tableIndex);
    need(currentWrong.heading === wrong.heading && currentWrong.kind === wrong.kind
        && currentKeeper.heading === keeper.heading && currentKeeper.kind === keeper.kind
        && currentWrong.markdown !== claim && currentKeeper.markdown === claim
        && occurrenceCount(allText({ sections: draft.sections, conceptBridges: draft.conceptBridges,
            readerTitle: draft.readerTitle, oneSentenceThesis: draft.oneSentenceThesis }), claim) === 1,
    '当前错位表未移除、keeper变更或表在额外位置出现');
    need(draft.sections.length === parentSections.length
        && draft.tableBindings.length === record.parentPaper.apiReaderPlan.tableBindings.length,
    '不能增加、删除小节或表槽');
    need(equal(draft.sections[keeper.sectionIndex].body.trim(), parentSections[keeper.sectionIndex].body.trim()),
        '合法keeper整个原段落必须保持');
    const others = feedback.rejectedReaderClaims.filter((_value, index) => index !== record.claimIndex);
    need(!others.some(value => allText({ sections: draft.sections, conceptBridges: draft.conceptBridges }).some(text => text.includes(value))),
        '其余已证实错误原句仍存在');
    need(equal(draft.tableBindings[keeper.tableIndex - 1], record.candidateEnvelope.payload.draft.tableBindings[keeper.tableIndex - 1])
        && equal(draft.tableBindings[wrong.tableIndex - 1], record.candidateEnvelope.payload.draft.tableBindings[wrong.tableIndex - 1]),
    '已付替代表或keeper原绑定发生改变');
    return { feedback, claim, wrong, keeper, currentWrong, currentKeeper, others };
}
function authenticateTable(markdown, binding, source, paper) {
    const deep = require('../deep-analyzer');
    return deep.bindApiReaderSourceEvidence(markdown, [{ ...structuredClone(binding), tableIndex: 1 }], [], {
        structuredArtifacts: source.structuredArtifacts, sourceText: source.text,
        arxivId: paper.arxivId, sections: [{ kind: 'result', body: markdown }] }).tableBindings[0];
}
function paidRequestMaterial(plan, candidate) {
    const directory = path.join(plan.readerAttemptsDir, 'request-diagnostics');
    safeDirectory(directory);
    const matches = [];
    for (const name of fs.readdirSync(directory)) {
        if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.request\.json$/.test(name)) continue;
        const bytes = read(path.join(directory, name)).toString('utf8'), request = JSON.parse(bytes);
        if (equal(request.identity, candidate.identity) && request.contentAttempt === candidate.payload.attempts)
            matches.push({ requestBytes: bytes, responseBytes: read(path.join(directory,
                name.replace('.request.json', '.response.json'))).toString('utf8') });
    }
    need(matches.length === 1, '必须有唯一同身份原已付请求及真实返回链');
    return matches[0];
}
function replayPaidRequest(record, sourceText) {
    const request = JSON.parse(record.requestBytes), response = JSON.parse(record.responseBytes);
    need(request.contract === 'reader-repair-request-diagnostics-v1' && response.contract === request.contract
        && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.id || '')
        && response.id === request.id && equal(request.identity, record.candidateEnvelope.identity)
        && request.contentAttempt === record.candidateEnvelope.payload.attempts
        && request.draftSha256 === repair.hashDraft(request.draft)
        && request.promptSha256 === sha(request.prompt)
        && response.requestSha256 === sha(record.requestBytes)
        && response.outputTextSha256 === sha(response.rawResponse)
        && Array.isArray(request.repairTargets) && request.repairTargets.length >= 1
        && request.repairTargets.length <= 8 && !request.atomicOperation,
    '原已付请求/响应/候选身份或完整字节链不符');
    const paid = repair.applyReaderPatch(request.draft, JSON.parse(response.rawResponse), request.repairTargets.map(t => t.path));
    require('../deep-analyzer').normalizeReaderSourceQuotes(paid, sourceText);
    need(equal(paid, record.candidateEnvelope.payload.draft), '原真实付费补丁和正常引文映射不能重放当前完整候选');
}
function verifyRecord(record, paper, plan, draft) {
    need(record?.contract === CONTRACT && record.paperId === id(paper) && record.runId === plan.runId
        && record.batchDate === plan.batchDate && daily.stableHash(record.parentPaper) === record.parentPaperSha256
        && sha(record.candidateBytes) === record.candidateSha256
        && equal(JSON.parse(record.candidateBytes), record.candidateEnvelope)
        && record.candidateEnvelope.payloadSha256 === repair.hashDraft(record.candidateEnvelope.payload)
        && repair.hashDraft(record.candidateEnvelope.identity) === record.candidateIdentitySha256
        && sha(record.feedbackBytes) === record.feedbackFileSha256, '原稿、候选、反馈归档CAS不同');
    const facts = require('./daily-fact-review'), feedback = JSON.parse(record.feedbackBytes);
    facts.validateShape(feedback);
    need(require('./saved-fact-feedback').readerOnlyFeedback(feedback)
        && equal(facts.proofFor(feedback), record.pendingProof)
        && equal(record.parentPaper.analysisFactReviewObligation, record.pendingProof)
        && equal(feedback.sourceFiles, record.sourceFiles), '原严格Reader-only反馈或pending不同');
    facts.validateFeedback(feedback, plan, record.parentPaper);
    const candidate = record.candidateEnvelope;
    need(candidate.identity.paperId.replace(/v\d+$/, '') === id(paper)
        && candidate.identity.freshAnalysis?.runId === plan.runId
        && candidate.identity.freshAnalysis?.sourceOnly === true
        && candidate.identity.sourceSha256 === paper.sourceSha256
        && candidate.payload.status === 'failed' && candidate.payload.draft
        && candidate.payload.attempts > 0 && candidate.payload.fullAttempts > 0, '必须绑定同源真实已付失败候选');
    const inspected = inspectLocations(record, draft);
    return withSource(paper, plan, source => {
        replayPaidRequest(record, source.text);
        const parentBindings = rawBindings(record.parentPaper);
        const oldKeeper = authenticateTable(inspected.claim, parentBindings[inspected.keeper.tableIndex - 1], source, paper);
        const keeper = authenticateTable(inspected.currentKeeper.markdown,
            draft.tableBindings[inspected.keeper.tableIndex - 1], source, paper);
        const replacement = authenticateTable(inspected.currentWrong.markdown,
            draft.tableBindings[inspected.wrong.tableIndex - 1], source, paper);
        need(oldKeeper.sourceType === 'artifact_table' && keeper.sourceType === 'artifact_table'
            && equal(keeper, oldKeeper) && !equal(replacement, keeper), 'keeper必须逐字重放同一完整认证原表，错位槽须为另一真实表');
        return inspected;
    });
}
function pointerFor(record) { return { contract: CONTRACT, paperId: record.paperId,
    runId: record.runId, recordSha256: daily.stableHash(record), feedbackSha256: record.pendingProof.feedbackSha256 }; }
function prepare({ paper, plan, candidateFile, claimIndex, wrongSectionIndex, keeperSectionIndex, wrongTableIndex, keeperTableIndex, formalFileSha256 }) {
    const formal = read(require('../config').FILES.deepAnalysisResult);
    need(sha(formal) === formalFileSha256 && equal(JSON.parse(formal).papers.find(value => id(value) === id(paper)), paper), '当前正式完整父稿CAS不符');
    need(require('../analysis-engine').paperAnalysisLockHeld(paper), '须持真实论文锁准备');
    need(paper.analysisFactReviewObligation && !paper[FIELD], '必须是未完成原pending且未安装更正');
    const feedbackFile = path.join(daily.factFeedbackDirectory(plan), paper.analysisFactReviewObligation.feedbackSha256 + '.json');
    const candidateBytes = read(candidateFile).toString('utf8');
    const checkedCandidate = repair.readFailedCandidateEnvelope(plan.readerAttemptsDir, null, candidateFile);
    need(checkedCandidate, '正常读取器未验证实际active失败候选');
    const envelope = checkedCandidate.envelope;
    need(equal(JSON.parse(candidateBytes), envelope), '候选在正常读取后变化');
    need(path.dirname(path.resolve(candidateFile)) === path.resolve(plan.readerAttemptsDir)
        && path.basename(candidateFile) === repair.hashDraft(envelope.identity) + '.json', '候选必须为该运行实际active文件');
    const sections = sectionsOf(paper);
    const record = { contract: CONTRACT, paperId: id(paper), runId: plan.runId, batchDate: plan.batchDate,
        parentPaper: structuredClone(paper), parentPaperSha256: daily.stableHash(paper), formalFileSha256,
        pendingProof: structuredClone(paper.analysisFactReviewObligation), sourceFiles: structuredClone(paper.analysisFactReviewObligation.sourceFiles),
        feedbackBytes: read(feedbackFile).toString('utf8'), feedbackFileSha256: sha(read(feedbackFile)),
        candidateBytes, candidateSha256: sha(candidateBytes), candidateIdentitySha256: repair.hashDraft(envelope.identity),
        candidateEnvelope: envelope, candidateFile: path.basename(candidateFile),
        ...paidRequestMaterial(plan, envelope), claimIndex,
        wrong: slot(sections, wrongSectionIndex, wrongTableIndex), keeper: slot(sections, keeperSectionIndex, keeperTableIndex),
        origin: 'operator-prepared global table claim incorrectly prohibited its source-authenticated keeper location' };
    verifyRecord(record, paper, plan, envelope.payload.draft);
    const handle = Object.freeze({}); prepared.set(handle, { record, paper, plan, candidateFile }); return handle;
}
function install(handle) {
    const context = prepared.get(handle); need(context, '缺少真实只读准备能力');
    const { record, paper, plan, candidateFile } = context;
    need(require('../analysis-engine').paperAnalysisLockHeld(paper), '安装须持真实论文锁');
    const persist = paper[Symbol.for('audio-paper-digest.analysisCheckpointCallback')];
    need(typeof persist === 'function', '安装需要正常引擎检查点保存回调');
    need(daily.stableHash(paper) === record.parentPaperSha256
        && sha(read(require('../config').FILES.deepAnalysisResult)) === record.formalFileSha256
        && sha(read(candidateFile)) === record.candidateSha256, '安装前正式或候选已变化');
    verifyRecord(record, paper, plan, record.candidateEnvelope.payload.draft);
    const dir = directory(plan); safeDirectory(dir, true);
    const archivedCandidateDir = path.join(dir, record.candidateIdentitySha256);
    safeDirectory(archivedCandidateDir, true);
    writeExact(path.join(archivedCandidateDir, record.candidateFile), Buffer.from(record.candidateBytes));
    const paidId = JSON.parse(record.requestBytes).id;
    const paidDir = path.join(archivedCandidateDir, 'request-diagnostics'); safeDirectory(paidDir, true);
    writeExact(path.join(paidDir, paidId + '.request.json'), Buffer.from(record.requestBytes));
    writeExact(path.join(paidDir, paidId + '.response.json'), Buffer.from(record.responseBytes));
    const pointer = pointerFor(record), bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n');
    writeExact(path.join(dir, pointer.recordSha256 + '.record.json'), bytes);
    writeExact(indexFile(plan, id(paper)), Buffer.from(JSON.stringify(pointer, null, 2) + '\n'));
    paper[FIELD] = pointer;
    // Existing engine callback persists only the pointer; it retains the exact old pending proof.
    try { persist(paper); } catch (error) { delete paper[FIELD]; throw error; }
    prepared.delete(handle); return structuredClone(pointer);
}
function readInstalled(paper, plan) {
    const filename = indexFile(plan, id(paper)); let exists;
    try { fs.lstatSync(filename); exists = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const marker = paper[FIELD], stage = paper.analysisManifest?.stages?.apiReaderArticle?.[STAGE_FIELD];
    if (!exists) { need(!marker && !stage, '更正标记缺少真实归档索引'); return null; }
    safeDirectory(directory(plan));
    const pointer = JSON.parse(read(filename));
    need(pointer.contract === CONTRACT && /^[a-f0-9]{64}$/.test(pointer.recordSha256 || '')
        && equal(pointer, marker), '索引与实际paper指针不同');
    const record = JSON.parse(read(path.join(directory(plan), pointer.recordSha256 + '.record.json')));
    need(equal(pointerFor(record), pointer), '更正记录SHA或原反馈不同');
    const archivedDirectory = path.join(directory(plan), record.candidateIdentitySha256);
    safeDirectory(archivedDirectory);
    const archivedFile = path.join(archivedDirectory, record.candidateFile);
    const paidId = JSON.parse(record.requestBytes).id;
    const paidDir = path.join(archivedDirectory, 'request-diagnostics');
    need(read(path.join(paidDir, paidId + '.request.json')).toString('utf8') === record.requestBytes
        && read(path.join(paidDir, paidId + '.response.json')).toString('utf8') === record.responseBytes, '原付费诊断归档变化');
    const candidate = repair.readFailedCandidateEnvelope(archivedDirectory, null, archivedFile);
    need(candidate && equal(candidate.envelope, record.candidateEnvelope)
        && sha(read(archivedFile)) === record.candidateSha256, '归档候选不再通过原正常读取器');
    return { pointer, record };
}
function withVerified(paper, plan, callback, { completed = false, feedbackProof = null, inheritedObligations = [] } = {}) {
    plan ||= planFor(paper);
    const checked = readInstalled(paper, plan);
    if (!checked) return callback();
    const { pointer, record } = checked;
    if (feedbackProof) need(equal(feedbackProof, record.pendingProof), '当前反馈不是原已核包');
    const correctedClaim = JSON.parse(record.feedbackBytes).rejectedReaderClaims[record.claimIndex];
    need(Array.isArray(inheritedObligations), '继承义务须保留独立来源');
    for (const inherited of inheritedObligations) {
        require('./daily-fact-review').validateProof(inherited.proof);
        need(Array.isArray(inherited.claims) && inherited.claims.every(claim => typeof claim === 'string'), '继承义务原句无效');
        need(equal(inherited.proof, record.pendingProof) || !inherited.claims.includes(correctedClaim),
            '另一独立父反馈仍禁止该表原句，不能因Set合并而豁免');
    }
    if (completed) {
        need(equal(paper.analysisManifest?.stages?.apiReaderArticle?.[STAGE_FIELD], pointer), '完成阶段未绑定更正凭证');
        assertFinalBindings(paper, record);
    }
    verifyRecord(record, paper, plan, record.candidateEnvelope.payload.draft);
    const active = { paper, plan, pointer, record, open: true };
    return scope.run(active, () => {
        let result;
        try { result = require('./analysis-stop-control').withModelRequestsForbidden(callback); }
        catch (error) { active.open = false; throw error; }
        if (result && typeof result.then === 'function') return result.finally(() => { active.open = false; });
        active.open = false; return result;
    });
}
function recheck(active) {
    need(active.open, '更正作用域已关闭');
    const actual = readInstalled(active.paper, active.plan);
    need(actual && equal(actual.pointer, active.pointer) && equal(actual.record, active.record), '当前更正归档或指针已变化');
    verifyRecord(actual.record, active.paper, active.plan, actual.record.candidateEnvelope.payload.draft);
    return actual.record;
}
function effectiveClaims(claims) {
    const active = scope.getStore();
    if (!active) return claims;
    const original = JSON.parse(recheck(active).feedbackBytes).rejectedReaderClaims;
    const claim = original[active.record.claimIndex];
    need(equal(claims, original) && claims.filter(value => value === claim).length === 1,
        '更正范围不能遗漏其它原禁留原句');
    return claims.filter(value => value !== claim);
}
function parseSavedDraft(record, source, paper) {
    return require('../deep-analyzer').parseApiReaderArticleResult(JSON.stringify(record.candidateEnvelope.payload.draft), {
        arxivId: paper.arxivId, requiredVersion: 3, requireIntegratedTables: true,
        requireSourceBindings: true, allowDeterministicQuoteRepair: true,
        sourceText: source.text, structuredArtifacts: source.structuredArtifacts,
        availableFigureOrdinals: record.parentPaper.apiReaderFigures.map(f => f.ordinal),
        imageEvidence: record.candidateEnvelope.payload.imageEvidence, verifiedResourceIdentity: paper.apiReaderResources
    });
}
function validate(text) {
    const active = scope.getStore(); if (!active) return false;
    const { paper, plan } = active, record = recheck(active);
    return withSource(paper, plan, source => {
        const parsed = parseSavedDraft(record, source, paper);
        const display = require('../deep-analyzer').replayApiReaderFinalDisplay(parsed, source,
            record.parentPaper.apiReaderFigures, paper.arxivId);
        need(text === display.article, '完成正文不能偏离原付费候选的正常完整显示');
        return true;
    });
}
function assertFinalBindings(paper, record) {
    const stage = paper.analysisManifest?.stages?.apiReaderArticle;
    need(sha(paper.apiReaderArticle || '') === paper.apiReaderArticleSha256
        && paper.apiReaderArticleSha256 === stage?.articleSha256
        && daily.stableHash(paper.apiReaderPlan) === paper.apiReaderPlanSha256
        && paper.apiReaderPlanSha256 === stage?.planSha256, '完成文章或计划SHA不符');
    const actual = rawBindings(paper), expected = record.candidateEnvelope.payload.draft.tableBindings;
    for (const index of [record.wrong.tableIndex - 1, record.keeper.tableIndex - 1])
        need(equal(actual[index], expected[index]), '完成表绑定与已付候选更正范围不同');
}
function bindCompletion(paper) {
    const active = scope.getStore();
    if (!active) { need(!paper[FIELD], '更正完成须位于真实恢复作用域'); return paper; }
    need(equal(paper[FIELD], active.pointer), '成功稿丢失原更正身份');
    assertFinalBindings(paper, recheck(active));
    validate(paper.apiReaderArticle);
    paper.analysisManifest.stages.apiReaderArticle[STAGE_FIELD] = structuredClone(active.pointer);
    return paper;
}
// Only the saved-candidate replay below opens this private finalizer capability.
const figureScope = new AsyncLocalStorage();
function reuseVerifiedCorrectionFigures(figures, paper) {
    const active = figureScope.getStore();
    if (!active) return null;
    need(active.open && paper === active.paper, '图复用缺少实际恢复对象');
    const record = recheck(scope.getStore()), parent = record.parentPaper;
    const stage = parent.analysisManifest?.stages?.apiReaderArticle;
    need(sha(parent.apiReaderArticle) === parent.apiReaderArticleSha256
        && stage.articleSha256 === parent.apiReaderArticleSha256
        && daily.stableHash(parent.apiReaderPlan) === parent.apiReaderPlanSha256
        && stage.planSha256 === parent.apiReaderPlanSha256
        && stage.figuresSha256 === daily.stableHash(parent.apiReaderFigures), '原签名文章、计划或图片元数据不符');
    const evidence = record.candidateEnvelope.payload.imageEvidence;
    for (const figure of parent.apiReaderFigures) need(/^[a-f0-9]{64}$/.test(figure.sourceDomSha256 || '')
        && /^[a-f0-9]{64}$/.test(figure.assetSha256 || '')
        && evidence.some(item => item.kind === 'figure' && item.ordinal === figure.ordinal
            && item.url === figure.url && item.sha256 === figure.assetSha256 && item.status === 'ready'),
    '已付候选图证据与原签名来源或像素SHA不符');
    // This copies already signed ephemeral metadata; it does not download or attest new pixels.
    return require('./reader-paid-resolved-render').copyUnchangedSignedFigures(figures, parent.apiReaderFigures);
}
async function replaySavedCorrection(paper, source, { reviewFeedback } = {}) {
    need(paper?.[FIELD], '零请求恢复缺少已安装更正');
    need(require('../analysis-engine').paperAnalysisLockHeld(paper), '零请求恢复须持真实论文锁');
    const plan = planFor(paper);
    return withVerified(paper, plan, () => withSource(paper, plan, async actualSource => {
        need(source.text === actualSource.text
            && equal(source.structuredArtifacts, actualSource.structuredArtifacts), '正常当前来源与归档四源不同');
        const active = scope.getStore(), record = recheck(active), saved = record.candidateEnvelope;
        const deep = require('../deep-analyzer');
        const evidence = deep.buildApiReaderEvidenceContext('', actualSource.text, actualSource.structuredArtifacts, paper.arxivId);
        const parsed = parseSavedDraft(record, actualSource, paper);
        const base = deep.buildRecoveryFingerprints(paper, actualSource.text, paper.arxivId).apiReaderArticle;
        const execution = { ...structuredClone(record.parentPaper.analysisManifest.stages.apiReaderArticle),
            fingerprint: deep.buildApiReaderExecutionFingerprint(base, evidence, actualSource.structuredArtifacts),
            contentMode: saved.identity.contentMode, attempts: saved.payload.attempts, fullAttempts: saved.payload.fullAttempts,
            transportFailures: saved.payload.transportFailures, model: saved.identity.model.model,
            reviewFeedbackSha256: sha(reviewFeedback || ''),
            savedClaimLocationReplay: { contract: CONTRACT, candidateIdentitySha256: record.candidateIdentitySha256,
                candidateSha256: record.candidateSha256, originalInputFingerprint: saved.identity.inputFingerprint,
                originalReaderRecoveryEpochSha256: saved.identity.readerRecoveryEpochSha256,
                newReaderApiRequests: 0, figureEvidence: 'reused-original-signed-ephemeral-metadata' }
        };
        const capability = { paper, open: true };
        try {
            return await figureScope.run(capability, async () => {
                const result = await deep.finalizeApiReaderRefresh(paper, actualSource,
                    { ...parsed, imageEvidence: saved.payload.imageEvidence },
                    { readerResources: structuredClone(paper.apiReaderResources), execution });
                return bindCompletion(result);
            });
        } finally { capability.open = false; }
    }));
}
function validatePublication(paper) {
    const plan = planFor(paper, true); if (!plan) return;
    if (!paper?.apiReaderPlan) { need(!paper?.[FIELD], '更正稿缺少计划'); return; }
    withVerified(paper, plan, () => {
        if (!scope.getStore()) return;
        const record = scope.getStore().record;
        need(equal(paper.analysisManifest?.stages?.apiReaderArticle?.factReview, record.pendingProof)
            && !paper.analysisFactReviewObligation && !paper.latestAnalysisAttemptError, '出版仍有未完成义务或新失败');
        assertFinalBindings(paper, record);
        validate(paper.apiReaderArticle);
    }, { completed: true });
    const proof = paper.analysisManifest?.stages?.apiReaderArticle?.factReview;
    if (proof) {
        const facts = require('./daily-fact-review');
        const feedback = facts.readFeedback(path.join(daily.factFeedbackDirectory(plan), proof.feedbackSha256 + '.json'));
        if (feedback.readerFeedback.trim()) need(require('./completed-bound-fact-feedback')
            .hasCompletedBoundFactFeedbackStages(paper, feedback, plan), '出版Reader事实约束未通过同一冷重放');
    }
}
module.exports = { CONTRACT, FIELD, STAGE_FIELD, prepare, install, withVerified, effectiveClaims,
    validate, bindCompletion, validatePublication, inspectLocations, replaySavedCorrection, reuseVerifiedCorrectionFigures };
