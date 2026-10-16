'use strict';process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),repair=require('../scripts/lib/reader-repair.js');
const old=[{path:'/sections/2/body',code:'reader_workflow_leakage',message:'写作指令泄漏，当前 2 处'}];
const next=[{path:'/tableBindings/0',code:'reader_invalid_source_quotes',message:'原表逐字引文未覆盖全部数字与单位'}];
function input(issues=old){return {candidateRevalidated:true,identity:{maxAttempts:3},maxAttempts:3,attemptLimit:3,currentIssues:next,recovered:{draft:{sections:[]},attempts:2,fullAttempts:1,noProgress:1,validationFailureStreak:2,issues,validationFailureSignature:repair.validationFailureSignature(issues),failureSignature:repair.hashRecoveryIssues(issues)}};}
const allow=x=>repair.canContinueRevalidatedIssuesWithinBudget(x);
test('different complete validation result uses only original remaining response and mutates no counters',()=>{const i=input(),before=structuredClone(i);assert.equal(allow(i),true);assert.deepEqual(i,before);assert.equal(i.attemptLimit-i.recovered.attempts,1);});
test('same gate, retained old gate plus new gate, another cell of same gate and numeric threshold changes do not reopen',()=>{
 for(const currentIssues of [old,[...old,...next],[{...old[0],path:'/sections/12/body'}],[{...old[0],message:'写作指令泄漏，当前 1 处'}]])assert.equal(allow({...input(),currentIssues}),false);
 const legacy=[{path:null,message:'中文字数必须为 5000–18000，当前 4800'}];assert.equal(allow({...input(legacy),currentIssues:[{path:null,message:'中文字数必须为 5200–18000，当前 4950'}]}),false);
});
test('missing, malformed, stale or self-inconsistent saved signatures cannot reopen',()=>{
 for(const edit of [i=>delete i.recovered.failureSignature,i=>delete i.recovered.validationFailureSignature,i=>i.recovered.validationFailureSignature='reader-validation-v2:{}',i=>i.recovered.validationFailureSignature='reader-validation-v2:'+JSON.stringify({gateSha256:'0'.repeat(64),deficits:[]}),i=>i.recovered.failureSignature='0'.repeat(64),i=>i.recovered.issues=[],i=>i.currentIssues=[],i=>i.currentIssues=[{path:null,message:'bad'}]]){const i=input();edit(i);assert.equal(allow(i),false);}
});
test('original max, completed full responses, transport/content interruption and explicit/extra allowance retain original stop',()=>{
 for(const edit of [i=>i.recovered.attempts=3,i=>i.recovered.fullAttempts=2,i=>i.recovered.lastTransportError='503',i=>i.recovered.lastContentError={code:'MODEL_OUTPUT_TRUNCATED'},i=>i.attemptLimit=4,i=>i.maxAttempts=4,i=>i.identity.maxAttempts=6,i=>i.explicitRound={maxResponses:3},i=>i.candidateRevalidated=false]){const i=input();edit(i);assert.equal(allow(i),false);}
});
test('diagnostic-only changes cannot erase old blocking rules',()=>{
 const i=input();i.currentIssues=[...old,{...next[0],diagnosticOnly:true}];assert.equal(allow(i),false);
});
test('normal shared generator spends at most the existing final response and transport interruption preserves all old counts',async t=>{
 const os=require('node:os'),deep=require('../scripts/deep-analyzer');
 const sample=require(path.join(root,'tests/reader-signed-draft-fixture')).fixture({noFigures:true});
 sample.draft.sections[0].body+='\n\n表后解释：';
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'reader-remaining-original-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 let calls=0;const paper={arxivId:'2610.99012',title:'原额内真实恢复边界测试'},options={sourceText:sample.sourceDetails.text,structuredArtifacts:sample.sourceDetails.structuredArtifacts,readerAttemptsDir:directory,readerMaxAttempts:3,readerMaterializeFigures:async()=>[],readerRecordDisposition:()=>{},readerCallModel:async()=>{calls++;throw Object.assign(new Error('TEST-ONLY-ORIGINAL-REQUEST-BOUNDARY'),{scope:'run',retryable:false});}};
 const {identity}=await deep.generateApiReaderArticleDetailed(paper,'','',{...options,readerIdentityOnly:true});
 const payload=input().recovered;payload.draft=sample.draft;payload.rawDraft=JSON.stringify(sample.draft);payload.status='failed';payload.issues=[{path:'/sections/14/body',code:'reader_resource_availability_claim',message:'本文资源声明没有对应的已验证可达状态'}];payload.validationFailureSignature=repair.validationFailureSignature(payload.issues);payload.failureSignature=repair.hashRecoveryIssues(payload.issues);
 repair.saveFailedCandidate(directory,identity,payload);
 await assert.rejects(()=>deep.generateApiReaderArticleDetailed(paper,'','',options),/TEST-ONLY-ORIGINAL-REQUEST-BOUNDARY/);
 assert.equal(calls,1);const saved=repair.loadFailedCandidate(directory,identity);
 for(const key of ['attempts','fullAttempts','noProgress','validationFailureStreak','failureSignature','validationFailureSignature'])assert.deepEqual(saved[key],payload[key],key);
 assert.equal(saved.transportFailures,1);assert.equal(saved.implementationRepairAllowanceProof,null);
 payload.attempts=3;repair.saveFailedCandidate(directory,identity,payload);calls=0;
 await assert.rejects(()=>deep.generateApiReaderArticleDetailed(paper,'','',options),/修复次数已用完/);assert.equal(calls,0);
});
test('normalization failure before the complete parser never releases a historical stop',async t=>{
 const os=require('node:os'),deep=require('../scripts/deep-analyzer');
 const sample=require(path.join(root,'tests/reader-signed-draft-fixture')).fixture({noFigures:true});
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'reader-normalization-original-stop-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 let calls=0;const paper={arxivId:'2610.99013',title:'完整解析前归一化不能释放旧停止'},options={sourceText:sample.sourceDetails.text,structuredArtifacts:sample.sourceDetails.structuredArtifacts,readerAttemptsDir:directory,readerMaxAttempts:3,readerMaterializeFigures:async()=>[],readerRecordDisposition:()=>{},readerCallModel:async()=>{calls++;throw Error('MUST-NOT-REACH-MODEL-BOUNDARY');}};
 const {identity}=await deep.generateApiReaderArticleDetailed(paper,'','',{...options,readerIdentityOnly:true});
 const payload=input().recovered;Object.assign(payload,{draft:sample.draft,rawDraft:JSON.stringify(sample.draft),status:'failed'});
 repair.saveFailedCandidate(directory,identity,payload);const file=path.join(directory,repair.hashDraft(identity)+'.json'),bytes=fs.readFileSync(file);
 const original=repair.normalizeUnavailableReaderFigures;repair.normalizeUnavailableReaderFigures=()=>{throw Error('当前新的归一化错误，尚未执行完整文章解析器');};t.after(()=>repair.normalizeUnavailableReaderFigures=original);
 await assert.rejects(()=>deep.generateApiReaderArticleDetailed(paper,'','',options),/修复次数已用完/);
 assert.equal(calls,0);assert(fs.readFileSync(file).equals(bytes),'original candidate/counts must remain unchanged');
});


// 全文预算耗尽后的变化闸门只能使用原局部余额；模型边界均为离线stub。
{
    const os = require('node:os');
    const deep = require('../scripts/deep-analyzer');
    const originalBuild = repair.buildRepairContext;
    const oldIssues = [{ path: '/sections/14/body', code: 'reader_resource_availability_claim',
        message: '本文资源声明没有对应的已验证可达状态' }];

    async function fixture(t, transformContext = context => context, response = null) {
        const sample = require(path.join(root, 'tests/reader-signed-draft-fixture')).fixture({ noFigures: true });
        sample.draft.sections[0].body += '\n\n表后解释：';
        const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-original-patch-only-'));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        let calls = 0;
        let actualContext;
        const paper = { arxivId: '2610.99014', title: '仅原局部余额的离线行为探针' };
        const options = {
            sourceText: sample.sourceDetails.text,
            structuredArtifacts: sample.sourceDetails.structuredArtifacts,
            readerAttemptsDir: directory,
            readerMaxAttempts: 3,
            readerMaterializeFigures: async () => [],
            readerRecordDisposition: () => {},
            readerCallModel: async () => {
                calls++;
                assert(actualContext);
                assert.equal(actualContext.atomicOperation, null);
                assert.equal(actualContext.targets.length, 1);
                assert.match(actualContext.targets[0].path, /^\/sections\/\d+\/body$/);
                if (response) return response(actualContext, sample.draft);
                return JSON.stringify({ version: 1, draftSha256: actualContext.draftSha256,
                    replacements: actualContext.targets.map(target => ({
                        path: target.path, oldSha256: target.oldSha256,
                        value: target.value.replace(/\n\n表后解释：\s*$/u, '')
                    })) });
            }
        };
        const { identity } = await deep.generateApiReaderArticleDetailed(paper, '', '', {
            ...options, readerIdentityOnly: true
        });
        const payload = {
            status: 'failed', draft: sample.draft, rawDraft: JSON.stringify(sample.draft),
            attempts: 2, fullAttempts: 2, noProgress: 1, validationFailureStreak: 2,
            transportFailures: 0, issues: oldIssues,
            failureSignature: repair.hashRecoveryIssues(oldIssues),
            validationFailureSignature: repair.validationFailureSignature(oldIssues)
        };
        repair.saveFailedCandidate(directory, identity, payload);
        const filename = path.join(directory, repair.hashDraft(identity) + '.json');
        const originalBytes = fs.readFileSync(filename);
        repair.buildRepairContext = (...args) => {
            actualContext = transformContext(originalBuild(...args), args[0]);
            return actualContext;
        };
        t.after(() => { repair.buildRepairContext = originalBuild; });
        return { paper, options, directory, identity, payload, filename, originalBytes,
            get calls() { return calls; },
            run: () => deep.generateApiReaderArticleDetailed(paper, '', '', options) };
    }

    test('real normal generator uses exactly one existing patch response with full fixed at two', async t => {
        const f = await fixture(t);
        const result = await f.run();
        assert.equal(f.calls, 1);
        assert.equal(result.attempts, 3);
        assert.equal(result.fullAttempts, 2);
        assert.equal(result.transportFailures, 0);
        assert.ok(result.article.length > 5000);
    });

    test('real normal generator has zero requests for null empty atomic whole-array or drifted contexts', async t => {
        for (const [name, transform] of [
            ['null', () => null],
            ['empty', context => ({ ...context, targets: [] })],
            ['null-target', context => ({ ...context, targets: [null] })],
            ['missing-path', context => ({ ...context, targets: [{}] })],
            ['atomic', context => ({ ...context, atomicOperation: { kind: 'reorganize_existing_sections_v1' } })],
            ['section-group', context => ({ ...context, sectionGroupPlanContract: 'reader-section-index-groups-v1' })],
            ['whole-array', (context, draft) => ({ ...context, targets: [{ path: '/sections',
                oldSha256: repair.hashDraft(draft.sections), value: draft.sections }] })],
            ['whole-section', (context, draft) => ({ ...context, targets: [{ path: '/sections/0',
                oldSha256: repair.hashDraft(draft.sections[0]), value: draft.sections[0] }] })],
            ['old-node-sha', context => ({ ...context, targets: context.targets.map(target => ({
                ...target, oldSha256: '0'.repeat(64)
            })) })],
            ['node-value', context => ({ ...context, targets: context.targets.map(target => ({
                ...target, value: target.value + '篡改'
            })) })],
            ['draft-sha', context => ({ ...context, draftSha256: '0'.repeat(64) })],
            ['duplicate', context => ({ ...context, targets: [...context.targets, ...context.targets] })],
            ['nine-nodes', (context, draft) => ({ ...context, targets: draft.sections.slice(0, 9)
                .map((section, index) => ({ path: `/sections/${index}/body`,
                    oldSha256: repair.hashDraft(section.body), value: section.body })) })],
            ['overlapping', (context, draft) => ({ ...context, targets: [
                { path: '/conceptBridges/0', oldSha256: repair.hashDraft(draft.conceptBridges[0]),
                    value: draft.conceptBridges[0] },
                { path: '/conceptBridges/0/explanation', oldSha256: repair.hashDraft(draft.conceptBridges[0].explanation),
                    value: draft.conceptBridges[0].explanation }
            ] })]
        ]) {
            await t.test(name, async sub => {
                const f = await fixture(sub, transform);
                await assert.rejects(f.run, error => ['READER_FULL_ATTEMPTS_EXHAUSTED',
                    'READER_PATCH_ONLY_NO_SAFE_TARGET'].includes(error.code));
                assert.equal(f.calls, 0);
                assert.ok(fs.readFileSync(f.filename).equals(f.originalBytes));
            });
        }
    });

    test('transport interruption keeps original counts and cannot consume a third full response', async t => {
        const f = await fixture(t, context => context, () => {
            throw Object.assign(new Error('TEST_ONLY_TRANSPORT_STOP'), { scope: 'run', retryable: false });
        });
        await assert.rejects(f.run, /TEST_ONLY_TRANSPORT_STOP/);
        assert.equal(f.calls, 1);
        const saved = repair.loadFailedCandidate(f.directory, f.identity);
        for (const key of ['attempts', 'fullAttempts', 'noProgress', 'validationFailureStreak',
            'failureSignature', 'validationFailureSignature']) {
            assert.deepEqual(saved[key], f.payload[key], key);
        }
        assert.equal(saved.transportFailures, 1);
        assert.equal(saved.implementationRepairAllowanceProof, null);
    });

    test('pure safe-context guard rejects source-full retry even with intact local nodes', () => {
        const draft = { sections: [{ body: '真实既有节点' }] };
        const context = { draftSha256: repair.hashDraft(draft), targets: [{ path: '/sections/0/body',
            oldSha256: repair.hashDraft(draft.sections[0].body), value: draft.sections[0].body }],
            issues: [{ path: '/sections/0/body', message: '正文精确节点有待局部修复' }],
            figureOrdinals: [], evidence: '原封存证据', atomicOperation: null };
        const before = structuredClone({ draft, context });
        assert.equal(repair.isSafeExistingReaderPatchContext(draft, context, false, context.issues), true);
        assert.equal(repair.isSafeExistingReaderPatchContext(draft, context, true, context.issues), false);
        assert.deepEqual({ draft, context }, before);
    });

    test('patch-only release preserves original gate, max, source, interruption and explicit-round stops', () => {
        const currentIssues = [{ path: '/sections/0/body', code: 'reader_workflow_leakage',
            message: '正文含有写作检查话术，需要按实际源改写对应段落' }];
        const original = { candidateRevalidated: true, patchOnlyAtFullLimit: true,
            maxAttempts: 3, attemptLimit: 3, identity: { maxAttempts: 3 }, currentIssues,
            recovered: { attempts: 2, fullAttempts: 2, noProgress: 1, validationFailureStreak: 2,
                issues: oldIssues, validationFailureSignature: repair.validationFailureSignature(oldIssues),
                failureSignature: repair.hashRecoveryIssues(oldIssues) } };
        const baseline = structuredClone(original);
        assert.equal(repair.canContinueRevalidatedIssuesWithinBudget(original), true);
        assert.deepEqual(original, baseline);
        for (const edit of [
            input => input.patchOnlyAtFullLimit = false,
            input => input.recovered.attempts = 3,
            input => input.recovered.fullAttempts = 3,
            input => input.recovered.lastTransportError = '503',
            input => input.recovered.lastContentError = { code: 'MODEL_OUTPUT_TRUNCATED' },
            input => input.attemptLimit = 4,
            input => input.identity.maxAttempts = 6,
            input => input.explicitRound = { maxResponses: 3 },
            input => input.candidateRevalidated = false,
            input => input.currentIssues = oldIssues,
            input => input.currentIssues = [...oldIssues, ...currentIssues],
            input => input.recovered.failureSignature = '0'.repeat(64)
        ]) {
            const input = structuredClone(original);
            edit(input);
            assert.equal(repair.canContinueRevalidatedIssuesWithinBudget(input), false);
        }
    });

    test('a full-article response to the last allowed patch spends only that response and cannot fall back', async t => {
        const f = await fixture(t, context => context, (_context, draft) => JSON.stringify(draft));
        await assert.rejects(f.run);
        assert.equal(f.calls, 1);
        const saved = repair.loadFailedCandidate(f.directory, f.identity);
        assert.equal(saved.attempts, 3);
        assert.equal(saved.fullAttempts, 2);
        assert.equal(saved.implementationRepairAllowanceProof, null);
        const bytes = fs.readFileSync(f.filename);
        await assert.rejects(f.run, error => error.code === 'READER_REPAIR_ATTEMPTS_EXHAUSTED');
        assert.equal(f.calls, 1, 'reentry has no remaining original responses');
        assert.ok(fs.readFileSync(f.filename).equals(bytes));
    });

    test('an existing implementation-allowance branch cannot reopen a stale full-limit gate', async t => {
        const f = await fixture(t);
        const original = repair.hasUnusedImplementationAllowance;
        repair.hasUnusedImplementationAllowance = () => true;
        t.after(() => { repair.hasUnusedImplementationAllowance = original; });
        await assert.rejects(f.run, error => error.code === 'READER_REPAIR_ATTEMPTS_EXHAUSTED');
        assert.equal(f.calls, 0);
        assert.ok(fs.readFileSync(f.filename).equals(f.originalBytes));
    });

    test('actual generator refuses global unknown or partially uncovered current issues before any request', async t => {
        for (const mode of ['unknown-global', 'partially-covered']) {
            await t.test(mode, async sub => {
                const f = await fixture(sub, context => ({ ...context, targets: context.targets.slice(0, 1) }));
                const original = repair.collectDraftIssues;
                repair.collectDraftIssues = (...args) => [...original(...args), {
                    path: mode === 'unknown-global' ? null : '/sections/1/body',
                    code: 'reader_new_independent_rule', message: '新的独立阻断规则尚未被本次完整局部范围覆盖'
                }];
                sub.after(() => { repair.collectDraftIssues = original; });
                await assert.rejects(f.run, error => error.code === 'READER_PATCH_ONLY_NO_SAFE_TARGET');
                assert.equal(f.calls, 0);
                assert.ok(fs.readFileSync(f.filename).equals(f.originalBytes));
            });
        }
    });

    test('empty issues, malformed paths and prefix-neighbor paths have no complete target authority', () => {
        const draft = { sections: Array.from({ length: 11 }, () => ({ body: '既有局部正文' })) };
        const path = '/sections/1/body';
        const context = { draftSha256: repair.hashDraft(draft), targets: [{ path,
            oldSha256: repair.hashDraft(draft.sections[1].body), value: draft.sections[1].body }],
            issues: [], figureOrdinals: [], evidence: '原来源', atomicOperation: null };
        for (const issues of [[], [{ path: null }], [{}], [{ path: '/sections/10/body' }],
            [{ path, diagnosticOnly: true }]]) {
            assert.equal(repair.isSafeExistingReaderPatchContext(draft, context, false, issues), false);
        }
    });
}
