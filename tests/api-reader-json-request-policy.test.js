"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const deep = require('../scripts/deep-analyzer.js');
const { buildRequestBody } = require('../scripts/utils.js');

test('长文与修复的实际公共请求使用 JSON 模式，探图和其他阶段不发送', async t => {
    const bodies = [];
    const server = http.createServer((request, response) => {
        let text = '';
        request.on('data', chunk => { text += chunk; });
        request.on('end', () => {
            bodies.push(JSON.parse(text));
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ choices: [{ message: { content: '本地响应' }, finish_reason: 'stop' }] }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    for (const stage of ['apiReaderArticle', 'apiReaderRepair', 'apiReaderImageProbe', 'primaryAnalysis', 'revision', 'scoringAudit']) {
        assert.equal(await deep.callModelWithConfig([{ role: 'user', content: '本地请求' }], 100, 1, {
            model: 'mimo-v2.6-flash', endpoint: `http://127.0.0.1:${server.address().port}/v1`, key: 'local-only-key',
            readerResponseFormat: 'json_object', usageContext: { stage }, usageSink() {}
        }), '本地响应');
    }
    assert.equal(bodies.length, 6);
    for (const body of bodies.slice(0, 2)) assert.deepEqual(body.response_format, { type: 'json_object' });
    for (const body of bodies.slice(2)) assert.equal(Object.hasOwn(body, 'response_format'), false);
});

test('JSON 请求参数只适用准确模型协议，非法模式拒绝', () => {
    const messages = [{ role: 'user', content: '请求' }];
    assert.deepEqual(buildRequestBody('openai', 'mimo-v2.6-flash', messages, 100, 0,
        { readerResponseFormat: 'json_object', usageContext: {stage: 'apiReaderArticle'} }).response_format, { type: 'json_object' });
    for (const [protocol, model] of [['unknown', 'mimo-v2.6-flash'], ['anthropic', 'mimo-v2.6-flash'],
        ['openai_responses', 'mimo-v2.6-flash'], ['openai', 'other-model']]) {
        assert.equal(Object.hasOwn(buildRequestBody(protocol, model, messages, 100, 0,
            { readerResponseFormat: 'json_object', usageContext: {stage: 'apiReaderArticle'} }), 'response_format'), false);
    }
    assert.throws(() => buildRequestBody('openai', 'mimo-v2.6-flash', messages, 100, 0,
        { readerResponseFormat: 'text', usageContext: {stage: 'apiReaderArticle'} }), /JSON/);
});

test('JSON 策略绑定当前阶段，旧完整阶段不补签，非法声明拒绝', t => {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const cp = require('node:child_process');
    const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reader-json-public-')));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const project = path.resolve(__dirname, '..');
    for (const name of ['scripts', 'manual', 'prompts', 'config']) fs.cpSync(path.join(project, name), path.join(folder, name), { recursive: true });
    fs.symlinkSync(path.join(project, 'node_modules'), path.join(folder, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(folder, '.env'), 'PAPER_ANALYZER_API_KEY=local-only-key\nPAPER_ANALYZER_MODEL=mimo-v2.6-flash\nPAPER_ANALYZER_ENDPOINT=http://127.0.0.1:9/v1\n', { mode: 0o600 });
    const program = `
const assert=require('node:assert/strict');
const deep=require('./scripts/deep-analyzer.js');
const current=deep.currentPromptTextContract;
const paper={arxivId:'2610.90001',title:'实际策略'};
const fp=stage=>deep.buildRecoveryFingerprints(paper,'来源',paper.arxivId,{stages:{apiReaderArticle:stage}}).apiReaderArticle;
const contracts={promptTextContract:current('apiReaderArticle'),repairPromptTextContract:current('apiReaderRepair')};
const thinking={contract:'api-reader-thinking-policy-v1',model:'mimo-v2.6-flash',thinkingMode:'disabled'};
const policy={contract:'api-reader-json-request-policy-v1',model:'mimo-v2.6-flash',responseFormat:'json_object'};
const old={status:'complete',...contracts,readerRequestPolicy:thinking};
const bytes=JSON.stringify(old);
const oldfp=fp(old);
const fresh=fp({status:'pending'});
assert.notEqual(fresh,oldfp);
assert.equal(fp({status:'complete',...contracts,readerRequestPolicy:thinking,readerJsonRequestPolicy:policy}),fresh);
assert.equal(fp(old),oldfp);
assert.equal(JSON.stringify(old),bytes);
for(const bad of [{...policy,contract:'bad'},{...policy,model:'bad'},{...policy,responseFormat:'text'},{...policy,extra:true}]) assert.throws(()=>fp({status:'complete',readerJsonRequestPolicy:bad}),/JSON.*策略不安全/);
`;
    const result = cp.spawnSync(process.execPath, ['-e', program], { cwd: folder, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
});
test('旧省略 JSON 声明的失败草稿正常迁移且付费计数不清，反向和坏声明拒绝', async t => {
    if (process.env.READER_JSON_POLICY_CHILD !== '1') {
        const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
        const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'reader-json-recovery-module-')));
        t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
        const project = path.resolve(__dirname,'..');
        for(const name of ['scripts','manual','prompts','config'])fs.cpSync(path.join(project,name),path.join(folder,name),{recursive:true});
        fs.mkdirSync(path.join(folder,'tests'));fs.copyFileSync(__filename,path.join(folder,'tests',path.basename(__filename)));
        fs.symlinkSync(path.join(project,'node_modules'),path.join(folder,'node_modules'),'dir');
        fs.writeFileSync(path.join(folder,'.env'),'PAPER_ANALYZER_API_KEY=local-only-key\nPAPER_ANALYZER_MODEL=mimo-v2.6-flash\nPAPER_ANALYZER_ENDPOINT=http://127.0.0.1:9/v1\n',{mode:0o600});
        const childEnv={...process.env,READER_JSON_POLICY_CHILD:'1'};delete childEnv.NODE_TEST_CONTEXT;
        const result=cp.spawnSync(process.execPath,['--test','--test-name-pattern=旧省略 JSON 声明','tests/'+path.basename(__filename)],{cwd:folder,encoding:'utf8',env:childEnv});
        assert.equal(result.status,0,result.stdout+result.stderr);
        assert.match(result.stdout,/# tests 1\b/);
        assert.match(result.stdout,/ok 1 - 旧省略 JSON 声明/);return;
    }
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
    const Config = require('../scripts/config.js');
    const fresh = require('../scripts/lib/fresh-analysis-context.js');
    const repair = require('../scripts/lib/reader-repair.js');
    const revision = require('../scripts/lib/reader-recovery-revision.js');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reader-json-recovery-')));
    const previous = Config.FILES.freshRewriteRunsDir;
    Config.FILES.freshRewriteRunsDir = root;
    t.after(() => { Config.FILES.freshRewriteRunsDir = previous; fs.rmSync(root, { recursive:true, force:true }); });
    const runId = crypto.randomUUID(), runDir = path.join(root,runId), paperId = '2610.90006';
    fs.mkdirSync(runDir,{mode:0o700});
    const text = 'This offline source describes controlled acoustic observations without numerical claims. '.repeat(400);
    const sha = value => crypto.createHash('sha256').update(value).digest('hex');
    const artifactBody = { figures:[], flattenedTextSha256:sha(text), formulas:[], parserVersion:'offline-empty-source-v1',tables:[],version:1 };
    const artifacts = {...artifactBody,payloadSha256:sha(JSON.stringify(artifactBody))};
    const sourceExpectations = {[paperId]:{sourceSha256:sha(text),structuredArtifactsSha256:artifacts.payloadSha256}};
    fs.writeFileSync(path.join(runDir,'run.json'),JSON.stringify({version:1,contract:'fresh-rewrite-run-v1',runId,paperIds:[paperId],sourceExpectations}),{mode:0o600});
    const directory = path.join(runDir,'reader-attempts');
    const draft = {version:3,readerTitle:'短',oneSentenceThesis:'本地失败草稿',sections:['background','related_work','problem','method_overview','component','training','experiment_setup','result','ablation','limitation','reproduction','synthesis'].map(kind=>({kind,heading:'本地章节',body:'本地内容'})),conceptBridges:[],figurePlacements:[],tableBindings:[],formulaBindings:[]};
    await fresh.withFreshAnalysisContext({runId,runDir,sourceExpectations,refreshReaderDiagnostics:true},async()=>{
        await fresh.fetchFreshSource(paperId,async()=>({source:'html',sourceId:paperId,text,structuredArtifacts:artifacts}));
        let calls=0;
        await assert.rejects(deep.generateApiReaderArticleDetailed({arxivId:paperId,title:'旧声明兼容'},'', '',{sourceText:text,structuredArtifacts:artifacts,readerAttemptsDir:directory,readerMaterializeFigures:async()=>[],readerRecordDisposition(){},readerCallModel:async()=>{if(++calls===1)return JSON.stringify(draft);throw new Error('本地保存草稿后暂停');}}),/本地保存草稿后暂停/);
        const filename=fs.readdirSync(directory).find(name=>/^[a-f0-9]{64}\.json$/.test(name));
        const envelope=JSON.parse(fs.readFileSync(path.join(directory,filename),'utf8'));
        const current=envelope.identity;
        assert.deepEqual(current.readerJsonRequestPolicy,{contract:'api-reader-json-request-policy-v1',model:'mimo-v2.6-flash',responseFormat:'json_object'});
        const old={...current};delete old.readerJsonRequestPolicy;
        // 仅构造旧省略字段的合法形状，不冒称来自旧程序的真实输出。
        const oldFile=repair.saveFailedCandidate(directory,old,envelope.payload);
        if(path.basename(oldFile)!==filename)fs.unlinkSync(path.join(directory,filename));
        const oldBytes=fs.readFileSync(oldFile);
        const result=revision.loadReaderRecoveryRevision(directory,current);
        for(const key of ['attempts','fullAttempts','transportFailures','noProgress'])assert.equal(result[key],envelope.payload[key]);
        assert.equal(result.implementationRepairAllowanceProof,envelope.payload.implementationRepairAllowanceProof);
        assert.ok(fs.readdirSync(directory).some(name=>name.includes('.migrated-')&&sha(fs.readFileSync(path.join(directory,name)))===sha(oldBytes)));
        assert.equal(revision.loadReaderRecoveryRevision(directory,old),null);
        const bad={...current,readerJsonRequestPolicy:{...current.readerJsonRequestPolicy,responseFormat:'text'}};
        assert.throws(()=>revision.loadReaderRecoveryRevision(directory,bad),/JSON 请求设置无效/);
        const exactDirectory=path.join(runDir,'exact-bad-attempts');
        repair.saveFailedCandidate(exactDirectory,bad,envelope.payload);
        assert.ok(repair.loadFailedCandidate(exactDirectory,bad),'坏声明的精确草稿必须实际存在');
        assert.throws(()=>revision.loadReaderRecoveryRevision(exactDirectory,bad),/JSON 请求设置无效/);
    });
});
