'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const api = require('../scripts/lib/historical-source-tag-assignment.js');
const runtime = require('../scripts/lib/tag-rules.js').createTagRules({ registryPath: require('node:path').resolve(__dirname, '../config/tag-catalog.json') });
const concepts = ['task.asr', 'method.self-supervised', 'setting.multilingual'].map(id => ({ id, quote: 'This is exact multilingual self-supervised speech recognition evidence.', rationale: '原文明确包含该论文任务方法与条件。' }));
const raw = { primaryTaskId: concepts[0].id, primaryMethodId: concepts[1].id, concepts };
const evidence = concepts[0].quote;
test('只含来源的分类核对精确的来源引文和显式角色', () => {
    const decision = api.parseTagSelectionResponse(JSON.stringify(raw), runtime, evidence);
    assert.equal(decision.primaryTaskId, raw.primaryTaskId); assert.equal(decision.concepts[2].quoteStart, 0);
});
test('没见过的引文、重复概念、编造的 ID 和混用的主 facet 都拒绝', () => {
    assert.throws(() => api.parseTagSelectionResponse(JSON.stringify(raw), runtime, 'unrelated source'), /引文必须同时存在于所给证据和来源全文中/);
    assert.throws(() => api.parseTagSelectionResponse(JSON.stringify(raw), runtime, evidence, 'Only a selection window label, no quote in source.'), /引文必须同时存在于所给证据和来源全文中/);
    assert.throws(() => api.parseTagSelectionResponse(JSON.stringify({ ...raw, concepts: [concepts[0], concepts[0], concepts[2]] }), runtime, evidence), /同一个概念不能重复入选/);
    assert.throws(() => api.parseTagSelectionResponse(JSON.stringify({ ...raw, primaryMethodId: raw.primaryTaskId }), runtime, evidence), /主任务、主方法或所选概念的上下级关系/);
    assert.throws(() => api.parseTagSelectionResponse(JSON.stringify({ ...raw, concepts: [...concepts.slice(0,2), { ...concepts[2], id: 'task.fake' }] }), runtime, evidence), /引文必须同时存在于所给证据和来源全文中/);
});
test('JSON 角色字段重复和模型输出带代码围栏都拒绝', () => {
    assert.throws(() => api.parseTagSelectionResponse('{"primaryTaskId":"a","primaryTaskId":"b","primaryMethodId":"c","concepts":[]}', runtime, evidence), /分类响应缺少必要的顶层字段，或同一字段出现多次/);
    assert.throws(() => api.parseTagSelectionResponse('```json\n' + JSON.stringify(raw) + '\n```', runtime, evidence), /不能使用代码围栏/);
});
test('独立审核必须显式接受，且没有问题、没有重复键', () => {
    assert.deepEqual(api.parseTagReviewResponse('{"accepted":true,"issues":[]}'), { accepted: true, issues: [] });
    assert.throws(() => api.parseTagReviewResponse('{"accepted":false,"issues":["method is not core"]}'), /独立标签审核未通过/);
    assert.throws(() => api.parseTagReviewResponse('{"accepted":false,"accepted":true,"issues":[]}'), /审核响应缺少必要字段，或同一字段出现多次/);
    assert.throws(() => api.parseTagReviewResponse('{"accepted":true,"issues":[],"other":1}'), /独立标签审核未通过/);
});
test('已删除或已停用的概念，以及不在选择里的主角色都拒绝', () => {
    const missing = { ...raw, concepts: raw.concepts.map(c => ({ ...c })) };
    missing.concepts[0].id = 'task.deleted-from-registry';
    assert.throws(() => api.parseTagSelectionResponse(JSON.stringify(missing), runtime, evidence), /引文必须同时存在于所给证据和来源全文中/);
    const activeTask = runtime.tagCatalog.concepts.find(c => c.status === 'active' && c.facet === 'task' && c.id !== raw.primaryTaskId);
    assert.throws(() => api.parseTagSelectionResponse(JSON.stringify({ ...raw, primaryTaskId: activeTask.id }), runtime, evidence), /主任务、主方法或所选概念的上下级关系/);
});
test('缓存必须绑定来源、词表、指纹、注入的引文和独立审核', () => {
    const sn = require('../scripts/lib/source-evidence-snippets.js');
    const hash = require('../scripts/lib/historical-direct-rewrite-runner.js').stableHash;
    const crypto = require('node:crypto'),sha = v => crypto.createHash('sha256').update(v).digest('hex');
    const text = evidence.repeat(3),bundle = sn.buildSourceEvidenceSnippets(text),source = { text, source: { paperId: 'arxiv:2601.00001', textSha256: sha(text), pdfSha256: 'a'.repeat(64) } };
    const modelResponseText = JSON.stringify({ ...raw, concepts: raw.concepts.map(c => ({ id: c.id, evidenceId: bundle.snippets[0].id, rationale: c.rationale })) });
    const injected = sn.fillConceptQuotesFromSnippets(modelResponseText,bundle),decision = api.parseTagSelectionResponse(injected.responseText,runtime,bundle.projection,text);
    const reviewProof = { contract:api.CONTRACT+'-review',decisionSha256:hash(decision),sourceTextSha256:source.source.textSha256,evidenceSha256:bundle.evidenceSha256,registrySha256:runtime.registrySha256,response:{accepted:true,issues:[]} };
    const body = { contract:api.CONTRACT,fingerprint:'fp',source:source.source,registrySha256:runtime.registrySha256,modelResponseText,modelResponseSha256:sha(modelResponseText),responseText:injected.responseText,responseSha256:sha(injected.responseText),quoteSelections:injected.selections,reviewProof,reviewProofSha256:hash(reviewProof),...decision };
    const record = { ...body, proofSha256:hash(body) },options = { fingerprint:'fp',runtime,bundle,source };
    assert.equal(api.validateCachedTagSelection(record,options).primaryTaskId,raw.primaryTaskId);
    assert.throws(() => api.validateCachedTagSelection(record,{...options,fingerprint:'other-model-route'}),/保存的分类结果与本次指纹、来源或词表不一致/);
    assert.throws(() => api.validateCachedTagSelection(record,{...options,source:{...source,source:{...source.source,pdfSha256:'b'.repeat(64)}}}),/保存的分类结果与本次指纹、来源或词表不一致/);
    const tampered = structuredClone(body);tampered.reviewProof.sourceTextSha256='c'.repeat(64);tampered.reviewProofSha256=hash(tampered.reviewProof);
    assert.throws(() => api.validateCachedTagSelection({...tampered,proofSha256:hash(tampered)},options),/保存的独立审核记录缺失/);
    const wrongReviewFormat = structuredClone(body);
    wrongReviewFormat.reviewProof.contract = api.LEGACY_CONTRACT + '-review';
    wrongReviewFormat.reviewProofSha256 = hash(wrongReviewFormat.reviewProof);
    assert.throws(() => api.validateCachedTagSelection({ ...wrongReviewFormat, proofSha256: hash(wrongReviewFormat) }, options),
        /分类记录与审核记录格式不受支持，或不属于同一代格式/);
});
test('带类型的账号池耗尽会让整轮停下，分类问题只影响单篇', () => {
    const runner = require('../scripts/lib/historical-direct-rewrite-runner.js');
    assert.ok(runner.globalAccountFailure({code:'LLM_ACCOUNT_POOL_EXHAUSTED',scope:'run'}));
    assert.equal(runner.globalAccountFailure(new Error('unknown quote')),null);
});
test('部分配额检查点不占用最终文件名，续跑后能得到更大的最终结果',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'source-tag-resume-')));
 try {
  const selected=[{paperId:'arxiv:2601.00001'},{paperId:'arxiv:2601.00002'}];
  const first={contract:require('../scripts/lib/historical-direct-tag-supplement.js').CONTRACT,records:{'one.md':{paperId:selected[0].paperId}}};
  const partial=api.persistRunResult(root,selected,first,[selected[0]],[],{paperId:selected[1].paperId,status:'account-pool-exhausted'});
  assert.equal(partial.state,'partial');assert.equal(partial.processed,1);assert.deepEqual(partial.remainingPaperIds,[selected[1].paperId]);
  assert.equal(fs.existsSync(path.join(root,'tag-history.json')),false);
  assert.equal(fs.existsSync(path.join(root,'report.json')),false);
  const final={...first,records:{...first.records,'two.md':{paperId:selected[1].paperId}}};
  const complete=api.persistRunResult(root,selected,final,selected,[]);
  assert.equal(complete.state,'complete');assert.equal(complete.processed,2);assert.equal(complete.remainingPaperIds.length,0);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(root,'tag-history.json'))).records).length,2);
  assert.equal(fs.readdirSync(root).filter(n=>n.startsWith('partial-')).length,1);
  assert.throws(()=>api.persistRunResult(root,selected,first,[selected[0]],[]),/最终报告未覆盖本次全部所选论文/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('并行完成度不足时报告真实缺口，不假定已完成前缀',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'source-tag-parallel-')));
 try {
  const selected=['a','b','c'].map(paperId=>({paperId})),supplement={contract:require('../scripts/lib/historical-direct-tag-supplement.js').CONTRACT,records:{}};
  const partial=api.persistRunResult(root,selected,supplement,[selected[2]],[],{status:'operator-stopped'});
  assert.deepEqual(partial.remainingPaperIds,['a','b']);assert.equal(partial.processed,1);
  assert.throws(()=>api.persistRunResult(root,selected,supplement,[selected[2],selected[2]],[],{status:'operator-stopped'}),/已处理论文重复，或包含本次所选集合之外的论文/);
  assert.throws(()=>api.persistRunResult(root,selected,supplement,[{paperId:'outside'}],[],{status:'operator-stopped'}),/已处理论文重复，或包含本次所选集合之外的论文/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('会议描述符把提取的全文和 PDF 绑定到已核验的公开来源绑定',()=>{
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

async function sourceClassificationFixture(t, respond, metadataFamily = null) {
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
    const tagFields = metadataFamily === 'mixed'
        ? 'paper_digest_tags_contract: "paper-taxonomy-flat-tags-compat-v1"\n"paper_digest_taxonomy_scope": null\n'
        : metadataFamily ? `paper_digest_${metadataFamily}_contract: "paper-taxonomy-flat-tags-compat-v1"\n` : '';
    const pagePath = 'content/posts/one.md', page = `---\ntitle: Historical paper\n${tagFields}---\nOriginal historical body.\n`;
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
    let checkpointExporter;
    function loadCheckpointExporter() {
        if (checkpointExporter) return checkpointExporter;
        const exportFilename = require.resolve('../scripts/lib/historical-tag-checkpoint-export.js');
        const exportRequire = Module.createRequire(exportFilename), exportModule = new Module(exportFilename, module);
        exportModule.filename = exportFilename;
        exportModule.paths = Module._nodeModulePaths(path.dirname(exportFilename));
        exportModule.require = request => {
            if (request === '../config.js') return { FILES: { freshArxivFetchedSourcesDir: sourceRoot } };
            if (request === './historical-source-tag-assignment.js') return loaded.exports;
            if (request === './historical-direct-tag-supplement.js') return { ...supplement, readPlanRegistry: () => ({ plan, registry }) };
            return exportRequire(request);
        };
        exportModule._compile(fs.readFileSync(exportFilename, 'utf8'), exportFilename);
        checkpointExporter = exportModule.exports;
        return checkpointExporter;
    }
    // 只替换对外的计划、控制、配置和模型入口。
    // 来源文件、证据注入、解析器、调度器和不可变写入都保持真实实现。
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
        if (request === './historical-tag-checkpoint-export.js') return loadCheckpointExporter();
        return realRequire(request);
    };
    loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
    const normalResponse = JSON.stringify({ primaryTaskId: raw.primaryTaskId, primaryMethodId: raw.primaryMethodId,
        concepts: raw.concepts.map(c => ({ id: c.id, evidenceId: 's00001', rationale: c.rationale })) });
    const options = { outputDirectory: path.join(root, 'output'), blogRoot, runId: 'offline-source-tags',
        registrySnapshot: path.resolve(__dirname, '../config/tag-catalog.json'), concurrency: 1 };
    return { fs, path, root, calls, sha, text, page, pagePath, item, normalResponse, plan, sourceRoot,
        get exportApi() { return loadCheckpointExporter(); },
        run: (outputDirectory, extra = {}) => loaded.exports.classifyRun({ ...options,
            ...(outputDirectory ? { outputDirectory } : {}), ...extra }), options, api: loaded.exports };
}

test('真实的来源分类提示词会走到选择、独立审核和第二轮反馈', async t => {
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
        assert.equal(fixture.api.CONTRACT, 'historical-source-tag-classification-v2');
        assert.equal(decision.contract, fixture.api.CONTRACT);
        assert.equal(decision.reviewProof.contract, fixture.api.CONTRACT + '-review');
        assert.equal(result.report.contract, fixture.api.CONTRACT + '-report');
        assert.equal(result.supplement.contract, 'historical-direct-tag-supplement-v2');
        assert.equal(result.supplement.records[fixture.pagePath].evidenceType, 'source-only-tags');
        assert.equal(result.supplement.records[fixture.pagePath].classificationContract, decision.contract);
        assert.equal(files.includes('taxonomy-history.json'), false);
        assert.equal(files.includes('tag-history.json'), true);
        for (const [prefix, suffix] of [['attempt-', '-attempt'], ['review-', '-review-attempt']]) {
            const saved = JSON.parse(fixture.fs.readFileSync(fixture.path.join(fixture.options.outputDirectory,
                files.find(name => name.startsWith(prefix))), 'utf8'));
            assert.equal(saved.contract, fixture.api.CONTRACT + suffix);
        }
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

test('来源标签选择跳过已声明新旧标签格式的页面，先核原页面 SHA', async t => {
    for (const family of ['tags', 'taxonomy']) {
        const f = await sourceClassificationFixture(t, () => { throw new Error('已标记页面不应请求模型'); }, family);
        const result = await f.run();
        assert.deepEqual(result.report.failures, []);
        assert.deepEqual(result.report.decisions, []);
        assert.equal(f.calls.length, 0);
        assert.equal(f.fs.readFileSync(f.path.join(f.options.blogRoot, f.pagePath), 'utf8'), f.page);
        f.fs.writeFileSync(f.path.join(f.options.blogRoot, f.pagePath), `${f.page}Changed body.\n`);
        await assert.rejects(f.run(), /历史页面内容与选定时的 SHA 不一致/);
        assert.equal(f.calls.length, 0);
    }
    const f = await sourceClassificationFixture(t, () => { throw new Error('后续页面 SHA 不符时不应请求模型'); });
    const secondPagePath = 'content/posts/two.md';
    f.item.pages.push({ pagePath: secondPagePath, pageKey: 'two', pageContentSha256: f.sha(f.page) });
    f.fs.writeFileSync(f.path.join(f.options.blogRoot, secondPagePath), f.page.replace('title: Historical paper\n',
        'title: Historical paper\npaper_digest_tags_contract: "paper-taxonomy-flat-tags-compat-v1"\n'));
    await assert.rejects(f.run(), /历史页面内容与选定时的 SHA 不一致/);
    assert.equal(f.calls.length, 0);
});

test('来源标签选择拒绝混用字段，审核后新增标签字段不能绕过原页面 SHA', async t => {
    const mixed = await sourceClassificationFixture(t, () => { throw new Error('混用页面不应请求模型'); }, 'mixed');
    await assert.rejects(mixed.run(), /新旧标签字段/);
    let f;
    f = await sourceClassificationFixture(t, call => {
        if (call.maxTokens === 3000) {
            f.fs.writeFileSync(f.path.join(f.options.blogRoot, f.pagePath),
                f.page.replace('title: Historical paper\n', 'title: Historical paper\npaper_digest_tags_contract: "paper-taxonomy-flat-tags-compat-v1"\n'));
            return '{"accepted":true,"issues":[]}';
        }
        return f.normalResponse;
    });
    const result = await f.run();
    assert.equal(result.report.failures.length, 1);
    assert.match(result.report.failures[0].error, /历史页面内容与选定时的 SHA 不一致/);
    assert.deepEqual(Object.keys(result.supplement.records), []);
});

test('真实的来源分类拒绝保存的提示词 SHA 不匹配和错代请求缓存', async t => {
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
    const decisionName = names.find(name => name.startsWith('decision-'));
    const decisionBytes = fixture.fs.readFileSync(fixture.path.join(originalDirectory, decisionName));
    for (const target of ['attempt', 'review', 'attempt-format', 'review-format', 'decision-format']) {
        const output = fixture.path.join(fixture.root, 'bad-' + target);
        fixture.fs.mkdirSync(output);
        const attempt = JSON.parse(attemptBytes), review = JSON.parse(reviewBytes);
        if (target === 'attempt') attempt.promptSha256 = fixture.sha('old selection prompt');
        if (target === 'review') review.promptSha256 = fixture.sha('old review prompt');
        if (target === 'attempt-format') attempt.contract = fixture.api.LEGACY_CONTRACT + '-attempt';
        if (target === 'review-format') review.contract = fixture.api.LEGACY_CONTRACT + '-review-attempt';
        if (target === 'decision-format') {
            // 独立负例保持新请求指纹，却使用自洽的旧格式；原缓存文件不修改。
            const { proofSha256, ...wrongGeneration } = JSON.parse(decisionBytes);
            const hash = require('../scripts/lib/historical-direct-rewrite-runner.js').stableHash;
            wrongGeneration.contract = fixture.api.LEGACY_CONTRACT;
            wrongGeneration.reviewProof.contract = fixture.api.LEGACY_CONTRACT + '-review';
            wrongGeneration.reviewProofSha256 = hash(wrongGeneration.reviewProof);
            fixture.fs.writeFileSync(fixture.path.join(output, decisionName),
                JSON.stringify({ ...wrongGeneration, proofSha256: hash(wrongGeneration) }), { mode: 0o600 });
        }
        fixture.fs.writeFileSync(fixture.path.join(output, attemptName), JSON.stringify(attempt), { mode: 0o600 });
        if (target.startsWith('review')) {
            fixture.fs.writeFileSync(fixture.path.join(output, reviewName), JSON.stringify(review), { mode: 0o600 });
            const feedback = '来源标签分类被拒绝：审核尝试记录的格式不符合要求，或提示 SHA 或响应 SHA 不一致。';
            const secondAttempt = { ...attempt, promptSha256: fixture.sha(fixture.calls[0].prompt + feedback) };
            fixture.fs.writeFileSync(fixture.path.join(output, attemptName.replace(/-1\.json$/, '-2.json')),
                JSON.stringify(secondAttempt), { mode: 0o600 });
            fixture.fs.writeFileSync(fixture.path.join(output, reviewName.replace(/-1\.json$/, '-2.json')),
                JSON.stringify(review), { mode: 0o600 });
        }
        const result = await fixture.run(output);
        assert.equal(result.report.decisions.length, 0); assert.equal(result.report.failures.length, 1);
        assert.match(result.report.failures[0].error, target.startsWith('attempt')
            ? /分类尝试记录的格式不符合要求，或指纹、提示 SHA 或响应 SHA 不一致/
            : target.startsWith('review') ? /审核尝试记录的格式不符合要求，或提示 SHA 或响应 SHA 不一致/
                : /新运行的请求缓存必须采用当前分类格式/);
        assert.equal(fixture.calls.length, originalCalls);
    }
    assert.deepEqual(fixture.fs.readFileSync(fixture.path.join(originalDirectory, attemptName)), attemptBytes);
    assert.deepEqual(fixture.fs.readFileSync(fixture.path.join(originalDirectory, reviewName)), reviewBytes);
    assert.deepEqual(fixture.fs.readFileSync(fixture.path.join(originalDirectory, decisionName)), decisionBytes);
});

test('真实的未覆盖响应保留原状态，显式续跑排除最初已处理的集合', async t => {
    const reason = '当前词表没有覆盖本文实际研究的主任务和主方法。';
    const fixture = await sourceClassificationFixture(t, () => JSON.stringify({
        status: 'not-covered-by-current-tag-catalog', reason, evidenceId: 's00001' }));
    const result = await fixture.run();
    assert.equal(fixture.calls.length, 1); assert.equal(result.report.decisions.length, 0);
    assert.equal(result.report.failures[0].status, 'not-covered-by-current-tag-catalog');
    assert.equal(result.report.failures[0].error, '当前词表没有覆盖适用类别：' + reason);
    assert.match(fixture.calls[0].prompt, /"status":"not-covered-by-current-tag-catalog"/);
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
    const wrongStatus = structuredClone(checkpoint);
    wrongStatus.failures[0].status = 'not-covered-by-current-taxonomy';
    const wrongCheckpointFile = fixture.path.join(fixture.options.outputDirectory,
        'checkpoint-000001-' + runner.stableHash(wrongStatus).slice(0, 16) + '.json');
    fixture.fs.writeFileSync(wrongCheckpointFile, JSON.stringify(wrongStatus), { mode: 0o600 });
    await assert.rejects(fixture.run(fixture.path.join(fixture.root, 'wrong-status'),
        { resumeCheckpointFile: wrongCheckpointFile }), /失败记录的状态、错误说明格式无效/);
    assert.equal(fixture.calls.length, 1);
});

test('真实文件导出与续跑保留旧分类、子证明及原报告字节，正常导出只写新版包装', async t => {
    const fixture = await sourceClassificationFixture(t, () => { throw new Error('旧已处理论文不应请求模型'); });
    const supplement = require('../scripts/lib/historical-direct-tag-supplement.js');
    const runner = require('../scripts/lib/historical-direct-rewrite-runner.js');
    const snippets = require('../scripts/lib/source-evidence-snippets.js');
    const hash = runner.stableHash, legacy = fixture.api.LEGACY_CONTRACT;
    const sourceDetails = await fixture.api.loadPaperSourceDetails(fixture.item,
        { FILES: { freshArxivFetchedSourcesDir: fixture.sourceRoot } }, 1);
    const bundle = snippets.buildSourceEvidenceSnippets(sourceDetails.text);
    const injected = snippets.fillConceptQuotesFromSnippets(fixture.normalResponse, bundle);
    const decision = fixture.api.parseTagSelectionResponse(injected.responseText, runtime, bundle.projection, sourceDetails.text);
    // 独立合成原 v1 格式样本，明确写全原字段；没有改签任何保存的原记录。
    const reviewProof = { contract: legacy + '-review', decisionSha256: hash(decision),
        sourceTextSha256: sourceDetails.source.textSha256, evidenceSha256: bundle.evidenceSha256,
        registrySha256: runtime.registrySha256, promptSha256: fixture.sha('Original legacy review prompt'),
        responseSha256: fixture.sha('{"accepted":true,"issues":[]}'), response: { accepted: true, issues: [] }, model: 'offline-legacy' };
    const fingerprint = fixture.sha('Original legacy request fingerprint');
    const body = { contract: legacy, paperId: fixture.item.paperId, runId: 'original-legacy-run', fingerprint,
        registrySha256: runtime.registrySha256, source: sourceDetails.source, evidenceSha256: bundle.evidenceSha256,
        evidenceSelectionContract: bundle.contract, modelResponseText: fixture.normalResponse,
        modelResponseSha256: fixture.sha(fixture.normalResponse), responseText: injected.responseText,
        responseSha256: fixture.sha(injected.responseText), quoteSelections: injected.selections,
        reviewProof, reviewProofSha256: hash(reviewProof), ...decision };
    const record = { ...body, proofSha256: hash(body) };
    const pageFields = { paperId: fixture.item.paperId, runId: record.runId, pageKey: fixture.item.pages[0].pageKey,
        pageSha256: fixture.sha(fixture.page), bodySha256: fixture.sha(supplement.pageBody(Buffer.from(fixture.page))),
        registrySha256: runtime.registrySha256, registryVersion: runtime.registryVersion,
        concepts: record.concepts.map(({ id, facet, label }) => ({ id, facet, label })),
        primaryTaskId: record.primaryTaskId, primaryTaskLabel: record.primaryTaskLabel,
        primaryMethodId: record.primaryMethodId, primaryMethodLabel: record.primaryMethodLabel,
        evidenceType: 'source-only-taxonomy', classificationContract: legacy,
        classificationRecordSha256: hash(record), classificationProofSha256: record.proofSha256,
        source: record.source, evidence: record.concepts, evidenceSelectionContract: record.evidenceSelectionContract,
        quoteSelections: record.quoteSelections, requestStageFingerprint: fingerprint,
        reviewProof, reviewProofSha256: record.reviewProofSha256 };
    const pageRecord = { ...pageFields, proofSha256: hash(pageFields) };
    const directory = fixture.path.join(fixture.root, 'original-legacy-input');
    const selected = { contract: legacy + '-selection', planSha256: fixture.plan.planSha256,
        registrySha256: runtime.registrySha256, paperIds: [fixture.item.paperId] };
    const selectionFile = supplement.writeImmutable(directory, 'selection.json', selected);
    const cacheFile = supplement.writeImmutable(directory,
        'decision-' + fixture.sha(record.paperId).slice(0,16) + '-' + fingerprint + '.json', record);
    const checkpoint = { contract: legacy + '-checkpoint', checkpointScheduling: 'completion-set-v1',
        processedPaperIds: [fixture.item.paperId], supplement: { contract: supplement.LEGACY_CONTRACT,
            records: { [fixture.pagePath]: pageRecord } }, processed: 1,
        decisions: [{ paperId: fixture.item.paperId, fingerprint }], failures: [] };
    const checkpointFile = supplement.writeImmutable(directory, 'checkpoint-000001-' + hash(checkpoint).slice(0,16) + '.json', checkpoint);
    const originalReport = { contract: legacy + '-checkpoint-export-report', checkpointFileSha256: checkpointFile.fileSha256,
        selectionFileSha256: selectionFile.fileSha256, selected: 1, processed: 1,
        processedPaperIds: [fixture.item.paperId], acceptedCaches: 1, rejected: 0, excludedPaperIds: [],
        exportedPaperCount: 1, pageCount: 1, remainingPaperIds: [], failures: [] };
    const reportFile = supplement.writeImmutable(directory, 'report.json', originalReport);
    const inputs = [selectionFile, cacheFile, checkpointFile, reportFile];
    const originalBytes = inputs.map(input => fixture.fs.readFileSync(input.filename));
    const options = { ...fixture.options, checkpointFile: checkpointFile.filename };
    // 正常输出不能通过 options 中的格式选项降级；旧 formatter 只用于原报告的只读核验。
    const exported = await fixture.exportApi.exportCheckpoint({ ...options, reportFamily: legacy, legacy: true });
    assert.equal(exported.supplement.contract, supplement.CONTRACT);
    assert.equal(exported.report.contract, fixture.api.CONTRACT + '-checkpoint-export-report');
    assert.deepEqual(exported.supplement.records[fixture.pagePath], pageRecord);
    const replay = await fixture.exportApi.replayCheckpointExportReport(options, originalReport);
    assert.deepEqual(replay.report, originalReport);
    assert.deepEqual(replay.supplement.records[fixture.pagePath], pageRecord);
    await assert.rejects(fixture.exportApi.replayCheckpointExportReport(options,
        { ...originalReport, pageCount: 2 }), /重新核验的来源、缓存和检查点不一致/);
    await assert.rejects(fixture.exportApi.replayCheckpointExportReport(options,
        { ...originalReport, contract: legacy + '-checkpoint-export-report-future' }), /格式不受支持/);
    const resumed = await fixture.run(fixture.path.join(fixture.root, 'new-remaining-run'),
        { resumeCheckpointFile: checkpointFile.filename, resumeExportFile: reportFile.filename });
    assert.equal(resumed.report.contract, fixture.api.CONTRACT + '-report');
    assert.equal(resumed.report.processed, 0);
    assert.equal(fixture.calls.length, 0);
    for (const [index, input] of inputs.entries())
        assert.deepEqual(fixture.fs.readFileSync(input.filename), originalBytes[index]);
    assert.equal(fixture.fs.readFileSync(fixture.path.join(fixture.options.blogRoot, fixture.pagePath), 'utf8'), fixture.page);
    fixture.fs.writeFileSync(fixture.path.join(fixture.options.blogRoot, fixture.pagePath), fixture.page + 'Changed body.\n');
    await assert.rejects(fixture.exportApi.exportCheckpoint(options), /读取页面的 SHA 与计划不一致/);
    assert.equal(fixture.calls.length, 0);
});
