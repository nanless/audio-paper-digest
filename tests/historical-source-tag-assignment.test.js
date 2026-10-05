'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const api = require('../scripts/lib/historical-source-tag-assignment.js');
const runtime = require('../scripts/lib/tag-rules.js').createTagRules({ registryPath: require('node:path').resolve(__dirname, '../config/tag-catalog.json') });
const concepts = ['task.asr', 'method.self-supervised', 'setting.multilingual'].map(id => ({ id, quote: 'This is exact multilingual self-supervised speech recognition evidence.', rationale: '原文明确包含该论文任务方法与条件。' }));
const raw = { primaryTaskId: concepts[0].id, primaryMethodId: concepts[1].id, concepts };
const evidence = concepts[0].quote;
test('source-only classification verifies exact source quotes and explicit roles', () => {
    const decision = api.parseTagSelectionResponse(JSON.stringify(raw), runtime, evidence);
    assert.equal(decision.primaryTaskId, raw.primaryTaskId); assert.equal(decision.concepts[2].quoteStart, 0);
});
test('unseen quotes, duplicate concepts, invented IDs and mixed primary facets reject', () => {
    assert.throws(() => api.parseTagSelectionResponse(JSON.stringify(raw), runtime, 'unrelated source'), /引文必须同时存在于所给证据和来源全文中/);
    assert.throws(() => api.parseTagSelectionResponse(JSON.stringify(raw), runtime, evidence, 'Only a selection window label, no quote in source.'), /引文必须同时存在于所给证据和来源全文中/);
    assert.throws(() => api.parseTagSelectionResponse(JSON.stringify({ ...raw, concepts: [concepts[0], concepts[0], concepts[2]] }), runtime, evidence), /同一个概念不能重复入选/);
    assert.throws(() => api.parseTagSelectionResponse(JSON.stringify({ ...raw, primaryMethodId: raw.primaryTaskId }), runtime, evidence), /主任务、主方法或所选概念的上下级关系/);
    assert.throws(() => api.parseTagSelectionResponse(JSON.stringify({ ...raw, concepts: [...concepts.slice(0,2), { ...concepts[2], id: 'task.fake' }] }), runtime, evidence), /引文必须同时存在于所给证据和来源全文中/);
});
test('duplicate JSON role fields and fenced model text reject', () => {
    assert.throws(() => api.parseTagSelectionResponse('{"primaryTaskId":"a","primaryTaskId":"b","primaryMethodId":"c","concepts":[]}', runtime, evidence), /分类响应缺少必要的顶层字段，或同一字段出现多次/);
    assert.throws(() => api.parseTagSelectionResponse('```json\n' + JSON.stringify(raw) + '\n```', runtime, evidence), /不能使用代码围栏/);
});
test('independent review must explicitly accept with no issues and no duplicate keys', () => {
    assert.deepEqual(api.parseTagReviewResponse('{"accepted":true,"issues":[]}'), { accepted: true, issues: [] });
    assert.throws(() => api.parseTagReviewResponse('{"accepted":false,"issues":["method is not core"]}'), /独立标签审核未通过/);
    assert.throws(() => api.parseTagReviewResponse('{"accepted":false,"accepted":true,"issues":[]}'), /审核响应缺少必要字段，或同一字段出现多次/);
    assert.throws(() => api.parseTagReviewResponse('{"accepted":true,"issues":[],"other":1}'), /独立标签审核未通过/);
});
test('removed or inactive concepts and primary roles absent from selection reject', () => {
    const missing = { ...raw, concepts: raw.concepts.map(c => ({ ...c })) };
    missing.concepts[0].id = 'task.deleted-from-registry';
    assert.throws(() => api.parseTagSelectionResponse(JSON.stringify(missing), runtime, evidence), /引文必须同时存在于所给证据和来源全文中/);
    const activeTask = runtime.tagCatalog.concepts.find(c => c.status === 'active' && c.facet === 'task' && c.id !== raw.primaryTaskId);
    assert.throws(() => api.parseTagSelectionResponse(JSON.stringify({ ...raw, primaryTaskId: activeTask.id }), runtime, evidence), /主任务、主方法或所选概念的上下级关系/);
});
test('cache must bind source, registry, fingerprint, injected quotes and independent review', () => {
    const sn = require('../scripts/lib/source-evidence-snippets.js');
    const hash = require('../scripts/lib/historical-direct-rewrite-runner.js').stableHash;
    const crypto = require('node:crypto'),sha = v => crypto.createHash('sha256').update(v).digest('hex');
    const text = evidence.repeat(3),bundle = sn.buildSourceEvidenceSnippets(text),source = { text, source: { paperId: 'arxiv:2601.00001', textSha256: sha(text), pdfSha256: 'a'.repeat(64) } };
    const modelResponseText = JSON.stringify({ ...raw, concepts: raw.concepts.map(c => ({ id: c.id, evidenceId: bundle.snippets[0].id, rationale: c.rationale })) });
    const injected = sn.fillConceptQuotesFromSnippets(modelResponseText,bundle),decision = api.parseTagSelectionResponse(injected.responseText,runtime,bundle.projection,text);
    const reviewProof = { decisionSha256:hash(decision),sourceTextSha256:source.source.textSha256,evidenceSha256:bundle.evidenceSha256,registrySha256:runtime.registrySha256,response:{accepted:true,issues:[]} };
    const body = { fingerprint:'fp',source:source.source,registrySha256:runtime.registrySha256,modelResponseText,modelResponseSha256:sha(modelResponseText),responseText:injected.responseText,responseSha256:sha(injected.responseText),quoteSelections:injected.selections,reviewProof,reviewProofSha256:hash(reviewProof),...decision };
    const record = { ...body, proofSha256:hash(body) },options = { fingerprint:'fp',runtime,bundle,source };
    assert.equal(api.validateCachedTagSelection(record,options).primaryTaskId,raw.primaryTaskId);
    assert.throws(() => api.validateCachedTagSelection(record,{...options,fingerprint:'other-model-route'}),/保存的分类结果与本次指纹、来源或词表不一致/);
    assert.throws(() => api.validateCachedTagSelection(record,{...options,source:{...source,source:{...source.source,pdfSha256:'b'.repeat(64)}}}),/保存的分类结果与本次指纹、来源或词表不一致/);
    const tampered = structuredClone(body);tampered.reviewProof.sourceTextSha256='c'.repeat(64);tampered.reviewProofSha256=hash(tampered.reviewProof);
    assert.throws(() => api.validateCachedTagSelection({...tampered,proofSha256:hash(tampered)},options),/保存的独立审核记录缺失/);
});
test('typed account pool exhaustion is run stopping but classification issues are per paper', () => {
    const runner = require('../scripts/lib/historical-direct-rewrite-runner.js');
    assert.ok(runner.globalAccountFailure({code:'LLM_ACCOUNT_POOL_EXHAUSTED',scope:'run'}));
    assert.equal(runner.globalAccountFailure(new Error('unknown quote')),null);
});
test('partial quota checkpoint does not occupy final names and can resume to larger final result',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'source-taxonomy-resume-')));
 try {
  const selected=[{paperId:'arxiv:2601.00001'},{paperId:'arxiv:2601.00002'}];
  const first={contract:'historical-direct-taxonomy-supplement-v1',records:{'one.md':{paperId:selected[0].paperId}}};
  const partial=api.persistRunResult(root,selected,first,[selected[0]],[],{paperId:selected[1].paperId,status:'account-pool-exhausted'});
  assert.equal(partial.state,'partial');assert.equal(partial.processed,1);assert.deepEqual(partial.remainingPaperIds,[selected[1].paperId]);
  assert.equal(fs.existsSync(path.join(root,'taxonomy-history.json')),false);
  assert.equal(fs.existsSync(path.join(root,'report.json')),false);
  const final={...first,records:{...first.records,'two.md':{paperId:selected[1].paperId}}};
  const complete=api.persistRunResult(root,selected,final,selected,[]);
  assert.equal(complete.state,'complete');assert.equal(complete.processed,2);assert.equal(complete.remainingPaperIds.length,0);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(root,'taxonomy-history.json'))).records).length,2);
  assert.equal(fs.readdirSync(root).filter(n=>n.startsWith('partial-')).length,1);
  assert.throws(()=>api.persistRunResult(root,selected,first,[selected[0]],[]),/最终报告未覆盖本次全部所选论文/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('partial parallel completion reports the actual gaps instead of assuming a completed prefix',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'source-taxonomy-parallel-')));
 try {
  const selected=['a','b','c'].map(paperId=>({paperId})),supplement={contract:'historical-direct-taxonomy-supplement-v1',records:{}};
  const partial=api.persistRunResult(root,selected,supplement,[selected[2]],[],{status:'operator-stopped'});
  assert.deepEqual(partial.remainingPaperIds,['a','b']);assert.equal(partial.processed,1);
  assert.throws(()=>api.persistRunResult(root,selected,supplement,[selected[2],selected[2]],[],{status:'operator-stopped'}),/已处理论文重复，或包含本次所选集合之外的论文/);
  assert.throws(()=>api.persistRunResult(root,selected,supplement,[{paperId:'outside'}],[],{status:'operator-stopped'}),/已处理论文重复，或包含本次所选集合之外的论文/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('conference descriptor binds extracted full text and PDF to the verified public source binding',()=>{
 const identityApi=require('../scripts/lib/historical-source-identity-supplement.js'),runner=require('../scripts/lib/historical-direct-rewrite-runner.js');
 const paperId='conference:icml:2026:openreview-forum-id:example123';
 const input={sourceSet:'official',provenance:'sealed',metadata:{sha256:'a'.repeat(64),recordIndex:0,metadataIdentityBindingSha256:'b'.repeat(64)},pdf:{sha256:'c'.repeat(64),bytes:1000,pdfIdentityBindingSha256:'d'.repeat(64),acquisition:{sourceKind:'retained-local-no-network-receipt',networkResponseObserved:false}},sourceBindingSha256:'e'.repeat(64)};
 const item={paperId,route:{kind:'conference-local-pdf',writerInputs:[input]}};
 const binding={sourceSet:input.sourceSet,provenance:input.provenance,metadataSha256:input.metadata.sha256,metadataRecordIndex:0,metadataIdentityBindingSha256:input.metadata.metadataIdentityBindingSha256,pdfSha256:input.pdf.sha256,pdfBytes:1000,pdfIdentityBindingSha256:input.pdf.pdfIdentityBindingSha256,sourceBindingSha256:input.sourceBindingSha256,acquisition:identityApi.publicAcquisition(input.pdf.acquisition),acquisitionSha256:runner.stableHash(input.pdf.acquisition)};
 const identity={kind:item.route.kind,paperId,sourceId:paperId,writerInputsSha256:runner.stableHash(item.route.writerInputs),sourceBindings:[binding],originalTitle:'Exact original',sourceUrl:'https://openreview.net/forum?id=example123',pdfUrl:'',provenanceDisclosure:'历史本地封存来源；未记录下载时网络响应。',privateUnexpectedPath:'/private/not-public'};
 const extracted={pdfSha256:input.pdf.sha256,sourceDetails:{paperId,sourceId:paperId,text:'Actual extracted PDF text, not a metadata title or abstract.',structuredArtifacts:{payloadSha256:'f'.repeat(64)}}};
 const descriptor=api.buildConferenceSourceRecord(item,identity,extracted);
 assert.deepEqual(descriptor.sourceBindings,identity.sourceBindings);assert.equal(descriptor.pdfSha256,input.pdf.sha256);assert.notEqual(descriptor.textSha256,runner.stableHash(identity.originalTitle));assert.equal(Object.hasOwn(descriptor,'privateUnexpectedPath'),false);
 const changed=structuredClone(identity);changed.sourceBindings[0].metadataIdentityBindingSha256='f'.repeat(64);
 assert.throws(()=>api.buildConferenceSourceRecord(item,changed,extracted),/会议来源的对应记录或 PDF SHA/);
 assert.throws(()=>api.buildConferenceSourceRecord(item,{...identity,paperId:'arxiv:2601.00001'},extracted),/会议来源记录与当前论文、提取结果或写入材料/);
 assert.throws(()=>api.buildConferenceSourceRecord(item,{...identity,sourceBindings:[]},extracted),/会议来源记录与当前论文、提取结果或写入材料/);
 assert.throws(()=>api.buildConferenceSourceRecord(item,identity,{...extracted,pdfSha256:'a'.repeat(64)}),/会议来源的对应记录或 PDF SHA/);
 assert.throws(()=>api.buildConferenceSourceRecord(item,{...identity,versionRelation:'invented-preprint'},extracted),/会议来源的版本、标题、DOI 或版本说明/);
 assert.throws(()=>api.buildConferenceSourceRecord(item,{...identity,provenanceDisclosure:''},extracted),/保留的本地来源缺少获取情况说明/);
 assert.throws(()=>api.buildConferenceSourceRecord(item,{...identity,sourceUrl:'https://arxiv.org/abs/2601.00001'},extracted),/会议官方来源地址不一致/);
});

async function sourceClassificationFixture(t, respond) {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const crypto = require('node:crypto'), Module = require('node:module');
    const fresh = require('../scripts/lib/fresh-arxiv-rewrite-source.js');
    const supplement = require('../scripts/lib/historical-direct-tag-supplement.js');
    const runner = require('../scripts/lib/historical-direct-rewrite-runner.js');
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'source-tag-prompts-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sha = value => crypto.createHash('sha256').update(value).digest('hex');
    const id = '2601.00001', paperId = 'arxiv:' + id;
    const sourceRoot = path.join(root, 'sources'), blogRoot = path.join(root, 'blog');
    const text = 'This is exact multilingual self-supervised speech recognition evidence. '.repeat(30);
    await fresh.captureFreshArxivRewriteSource({ rootDir: sourceRoot, arxivId: id, generation: 1,
        now: '2026-09-07T00:00:00.000Z' }, {
        fetchText: async () => ({ text, title: 'Exact source title', source: 'html', sourceId: id,
            url: `https://arxiv.org/html/${id}`, fetchedAt: '2026-09-07T00:00:01.000Z' }),
        fetchPdf: async () => ({ bytes: Buffer.from('%PDF-1.7\nOffline source fixture\n%%EOF\n'),
            url: `https://arxiv.org/pdf/${id}.pdf`, fetchedAt: '2026-09-07T00:00:02.000Z' })
    });
    const pagePath = 'content/posts/one.md', page = '---\ntitle: Historical paper\n---\nOriginal historical body.\n';
    fs.mkdirSync(path.join(blogRoot, 'content/posts'), { recursive: true });
    fs.writeFileSync(path.join(blogRoot, pagePath), page, { mode: 0o600 });
    const item = { paperId, runId: 'offline-source-tags', route: { kind: 'arxiv-fresh-fetch', arxivId: id },
        pages: [{ pagePath, pageKey: 'one', pageContentSha256: sha(page) }] };
    const plan = { planSha256: 'b'.repeat(64), queue: [item] };
    const registry = { entries: [{ paperId, status: 'pending' }] };
    const filename = require.resolve('../scripts/lib/historical-source-tag-assignment.js');
    const realRequire = Module.createRequire(filename), loaded = new Module(filename, module);
    loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    const calls = [];
    // Only external plan/control/configuration/model entry points are substituted.
    // Source files, evidence injection, parser, scheduler and immutable writes remain real.
    loaded.require = request => {
        if (request === '../config.js') return { FILES: { freshArxivFetchedSourcesDir: sourceRoot } };
        if (request === '../deep-analyzer.js') return { callModel: async (messages, maxTokens, options) => {
            const call = { prompt: messages[0].content, maxTokens, options }; calls.push(call);
            return respond(call, calls);
        } };
        if (request === '../llm-account-pool.js') return {
            resolvePrimaryApiKeyPool: () => [], getPoolIdentity: () => ({ groupId: 'offline-account-group' }) };
        if (request === './historical-direct-tag-supplement.js') return {
            ...supplement, readPlanRegistry: () => ({ plan, registry }) };
        if (request === './historical-direct-rewrite-runner.js') return {
            ...runner, sourcePrerequisiteSnapshot: options => {
                assert.equal(options.sourceRoot, sourceRoot); assert.equal(options.generation, 1);
                assert.equal(options.required, true);
                assert.ok(options.selected.length <= 1);
                for (const selected of options.selected) assert.equal(selected, item);
                return { status: 'ready' };
            } };
        if (request === './historical-direct-page-staging.js') return {
            currentRendererImplementationSha256: () => 'f'.repeat(64) };
        return realRequire(request);
    };
    loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
    const normalResponse = JSON.stringify({ primaryTaskId: raw.primaryTaskId, primaryMethodId: raw.primaryMethodId,
        concepts: raw.concepts.map(c => ({ id: c.id, evidenceId: 's00001', rationale: c.rationale })) });
    const options = { outputDirectory: path.join(root, 'output'), blogRoot, runId: 'offline-source-tags',
        registrySnapshot: path.resolve(__dirname, '../config/tag-catalog.json'), concurrency: 1 };
    return { fs, path, root, calls, sha, text, page, pagePath, normalResponse,
        run: (outputDirectory, extra = {}) => loaded.exports.classifyRun({ ...options,
            ...(outputDirectory ? { outputDirectory } : {}), ...extra }), options, api: loaded.exports };
}

test('actual source classification prompts reach selection, independent review and second-round feedback', async t => {
    for (const failure of ['selection', 'truncated']) {
        let selectionCalls = 0, fixture;
        fixture = await sourceClassificationFixture(t, call => {
            if (call.maxTokens === 3000) return '{"accepted":true,"issues":[]}';
            if (++selectionCalls === 1) {
                if (failure === 'truncated') throw Object.assign(new Error('Unit incomplete'), { code: 'MODEL_OUTPUT_INCOMPLETE' });
                return fixture.normalResponse.replace('"primaryMethodId":"method.self-supervised"',
                    '"primaryMethodId":"task.asr"');
            }
            return fixture.normalResponse;
        });
        const result = await fixture.run();
        assert.equal(result.report.decisions.length, 1); assert.deepEqual(result.report.failures, []);
        assert.equal(fixture.calls.length, 3);
        const [first, second, review] = fixture.calls;
        assert.equal(first.maxTokens, 6000); assert.equal(second.maxTokens, 6000); assert.equal(review.maxTokens, 3000);
        assert.match(first.prompt, /程序会根据编号填入原文引文/);
        assert.match(first.prompt, /"evidenceId":"s00001"/);
        assert.match(first.prompt, /只分类本次封存来源中的实际研究内容，不认证会议定稿/);
        assert.match(second.prompt, failure === 'truncated' ? /上次模型响应不完整，或超过了响应长度上限/ : /主任务、主方法或所选概念的上下级关系/);
        assert.match(review.prompt, /请结合提供的原文片段/);
        assert.doesNotMatch(review.prompt, /全文上下文/);
        const files = fixture.fs.readdirSync(fixture.options.outputDirectory);
        const decision = JSON.parse(fixture.fs.readFileSync(fixture.path.join(fixture.options.outputDirectory,
            files.find(name => name.startsWith('decision-'))), 'utf8'));
        assert.equal(decision.modelResponseText, fixture.normalResponse);
        assert.equal(decision.reviewProof.promptSha256, fixture.sha(review.prompt));
        assert.ok(decision.concepts.every(c => fixture.text.includes(c.quote)));
        assert.deepEqual(decision.quoteSelections.map(c => c.evidenceId), ['s00001', 's00001', 's00001']);
        assert.equal(fixture.fs.readFileSync(fixture.path.join(fixture.options.blogRoot, fixture.pagePath), 'utf8'), fixture.page);
        const directPrompt = fixture.api.buildQuotedTagSelectionPrompt({ paperId: 'paper', title: 'title', evidence: fixture.text,
            projection: runtime.projection, feedback: '' });
        assert.match(directPrompt, /20–1000个字符的连续逐字引文/);
        assert.match(directPrompt, /"quote":"原文逐字引文"/);
        assert.doesNotMatch(directPrompt, /"evidenceId"/);
    }
});

test('actual source classification rejects saved attempt and review prompt SHA mismatches', async t => {
    let fixture;
    fixture = await sourceClassificationFixture(t, call => call.maxTokens === 3000
        ? '{"accepted":true,"issues":[]}' : fixture.normalResponse);
    const accepted = await fixture.run(); assert.equal(accepted.report.decisions.length, 1);
    const originalCalls = fixture.calls.length, originalDirectory = fixture.options.outputDirectory;
    const names = fixture.fs.readdirSync(originalDirectory);
    const attemptName = names.find(name => name.startsWith('attempt-'));
    const reviewName = names.find(name => name.startsWith('review-'));
    const attemptBytes = fixture.fs.readFileSync(fixture.path.join(originalDirectory, attemptName));
    const reviewBytes = fixture.fs.readFileSync(fixture.path.join(originalDirectory, reviewName));
    for (const target of ['attempt', 'review']) {
        const output = fixture.path.join(fixture.root, 'bad-' + target);
        fixture.fs.mkdirSync(output);
        const attempt = JSON.parse(attemptBytes), review = JSON.parse(reviewBytes);
        if (target === 'attempt') attempt.promptSha256 = fixture.sha('old selection prompt');
        else review.promptSha256 = fixture.sha('old review prompt');
        fixture.fs.writeFileSync(fixture.path.join(output, attemptName), JSON.stringify(attempt), { mode: 0o600 });
        if (target === 'review') {
            fixture.fs.writeFileSync(fixture.path.join(output, reviewName), JSON.stringify(review), { mode: 0o600 });
            const feedback = '来源标签分类被拒绝：审核尝试记录的提示 SHA 或响应 SHA 不一致。';
            const secondAttempt = { ...attempt, promptSha256: fixture.sha(fixture.calls[0].prompt + feedback) };
            fixture.fs.writeFileSync(fixture.path.join(output, attemptName.replace(/-1\.json$/, '-2.json')),
                JSON.stringify(secondAttempt), { mode: 0o600 });
            fixture.fs.writeFileSync(fixture.path.join(output, reviewName.replace(/-1\.json$/, '-2.json')),
                JSON.stringify(review), { mode: 0o600 });
        }
        const result = await fixture.run(output);
        assert.equal(result.report.decisions.length, 0); assert.equal(result.report.failures.length, 1);
        assert.match(result.report.failures[0].error, target === 'attempt'
            ? /分类尝试记录的指纹、提示 SHA 或响应 SHA 不一致/
            : /审核尝试记录的提示 SHA 或响应 SHA 不一致/);
        assert.equal(fixture.calls.length, originalCalls);
    }
    assert.deepEqual(fixture.fs.readFileSync(fixture.path.join(originalDirectory, attemptName)), attemptBytes);
    assert.deepEqual(fixture.fs.readFileSync(fixture.path.join(originalDirectory, reviewName)), reviewBytes);
});

test('actual uncovered response retains its status and explicit resume excludes the original processed set', async t => {
    const reason = '当前词表没有覆盖本文实际研究的主任务和主方法。';
    const fixture = await sourceClassificationFixture(t, () => JSON.stringify({
        status: 'not-covered-by-current-taxonomy', reason, evidenceId: 's00001' }));
    const result = await fixture.run();
    assert.equal(fixture.calls.length, 1); assert.equal(result.report.decisions.length, 0);
    assert.equal(result.report.failures[0].status, 'not-covered-by-current-taxonomy');
    assert.equal(result.report.failures[0].error, '当前词表没有覆盖适用类别：' + reason);
    assert.match(fixture.calls[0].prompt, /"status":"not-covered-by-current-taxonomy"/);
    const runner = require('../scripts/lib/historical-direct-rewrite-runner.js');
    const checkpoint = { contract: fixture.api.CONTRACT + '-checkpoint', processed: 1,
        decisions: [], failures: result.report.failures, supplement: result.supplement };
    const checkpointFile = fixture.path.join(fixture.options.outputDirectory,
        'checkpoint-000001-' + runner.stableHash(checkpoint).slice(0, 16) + '.json');
    fixture.fs.writeFileSync(checkpointFile, JSON.stringify(checkpoint), { mode: 0o600 });
    const originalBytes = fixture.fs.readFileSync(checkpointFile);
    const output = fixture.path.join(fixture.root, 'resumed');
    const resumed = await fixture.run(output, { resumeCheckpointFile: checkpointFile });
    assert.equal(fixture.calls.length, 1, 'the original processed paper is not requested again');
    assert.equal(resumed.report.selected, 0); assert.equal(resumed.report.processed, 0);
    const selection = JSON.parse(fixture.fs.readFileSync(fixture.path.join(output, 'selection.json'), 'utf8'));
    assert.deepEqual(selection.paperIds, []);
    assert.deepEqual(selection.resumeProvenance.processedPaperIds, ['arxiv:2601.00001']);
    assert.deepEqual(fixture.fs.readFileSync(checkpointFile), originalBytes);
});
