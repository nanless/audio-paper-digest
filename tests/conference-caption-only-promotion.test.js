 'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const api = require('../scripts/lib/conference-process.js');
const recovery = require('../scripts/lib/conference-process-recovery.js');
const post = require('../scripts/lib/conference-postprocess.js');
const cli = require('../scripts/conference-process.js');
const H = api.stableHash;
const args = ['--catalog','catalog.json','--report','report.json','--filter','11111111-1111-4111-8111-111111111111','--from','22222222-2222-4222-8222-222222222222'];

test('caption-only is an explicit plan/promote mode; apply and unknown modes fail', () => {
 assert.equal(cli.parseArgs(['--source-upgrade-plan',...args]).pageRepairMode,undefined);
 assert.equal(cli.parseArgs(['--source-upgrade-plan',...args,'--page-repair-mode','caption-only']).pageRepairMode,'caption-only');
 assert.equal(cli.parseArgs(['--source-upgrade-promote',...args,'--plan-sha','a'.repeat(64),'--page-repair-mode','caption-only']).pageRepairMode,'caption-only');
 for (const mode of ['generic','caption-only-extra','']) assert.throws(()=>cli.parseArgs(['--source-upgrade-plan',...args,'--page-repair-mode',mode]));
 assert.throws(()=>cli.parseArgs(['--source-upgrade-apply',...args,'--plan-sha','a'.repeat(64),'--paper-ids','conference:odyssey:2026:conference-paper-id:x','--authorize-new-analysis','--page-repair-mode','caption-only']));
});

test('caption-only does not run the broader math, currency, image or prose repairs', () => {
 const caption='*论文图 2。[ph5P](‘beat’) 表示音标与释义。*';
 assert.equal(post.repairCaptionQuotedGlossLinks(caption),'*论文图 2。&#91;ph5P&#93;(‘beat’) 表示音标与释义。*');
 const plain='正文 [ph5P](‘beat’)'; assert.equal(post.repairCaptionQuotedGlossLinks(plain),plain);
 for(const marker of ['\\alpha','$z^{*}$','`code`','<em>x</em>','![nested](x)','**bold**','a_b','x~y']){
  const line='*论文图 2。[ph5P](‘beat’) '+marker+'*';assert.equal(post.repairCaptionQuotedGlossLinks(line),line,marker);
 }
 const fence='```text\r\n'+caption+'\r\n```\r\n';assert.equal(post.repairCaptionQuotedGlossLinks(fence),fence);
 const math='公式 $z^{*}$，有效公式 >。\n'+caption;
 assert.equal(post.repairCaptionQuotedGlossLinks(math),'公式 $z^{*}$，有效公式 >。\n*论文图 2。&#91;ph5P&#93;(‘beat’) 表示音标与释义。*');
});

test('caption-only stage loader rejects unissued mode, code SHA and additional policy fields before reading stages', () => {
 const code=crypto.createHash('sha256').update(fs.readFileSync(require.resolve('../scripts/lib/conference-postprocess.js'))).digest('hex');
 const policy={contract:'conference-caption-only-page-repair-policy-v1',mode:'caption-only',implementationSha256:code};
 for(const altered of [{...policy,implementationSha256:'0'.repeat(64)},{...policy,mode:'generic'},{...policy,extra:true},null]){
  assert.throws(()=>post.loadPreservedStage({repair:true,repairMode:'caption-only',repairPolicy:altered}),/exact authorized policy/);
 }
 assert.throws(()=>post.loadPreservedStage({repair:false,repairMode:'caption-only',repairPolicy:policy}),/exact authorized policy/);
});

function provenance(t) {
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'caption-parent-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const origin=H('issued original implementation'), authority={catalogSha256:H('catalog'),taxonomyVersion:'old',taxonomyRegistrySha256:H('old-registry'),implementationSha256:origin};
 const paperId='conference:interspeech:2026:conference-paper-id:du26b_interspeech';
 const parent={authority,items:{[paperId]:{analysisRunId:'33333333-3333-4333-8333-333333333333',status:'pending',sourceIdentity:'conference-paper-id:du26b_interspeech'}},status:'running'};
 parent.processId=api.deterministicUuid(H(authority),'conference-process-v1');parent.stateSha256=H(parent);
 const newer={...authority,taxonomyVersion:'a3',taxonomyRegistrySha256:H('a3'),implementationSha256:H('current')};
 const plan={authority:newer,fromProcessId:parent.processId,originalStateSha256:parent.stateSha256,sourceImplementationSha256:origin,papers:[{paperId,previousExecutionId:parent.items[paperId].analysisRunId,previousStatus:'pending'}]};plan.planSha256=H(plan);
 const child={processId:api.deterministicUuid(plan.planSha256,'conference-source-upgrade-process-v1'),authority:newer,items:structuredClone(parent.items),status:'running',sourceUpgradePromotion:{originalProcessId:parent.processId,sourceImplementationSha256:origin,planSha256:plan.planSha256}};
 const save=(state,p)=>{const dir=path.join(root,state.processId);fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(state),{mode:0o600});if(p)fs.writeFileSync(path.join(dir,'source-upgrade-plan.json'),JSON.stringify(p),{mode:0o600});return dir;};
 const childDir=save(child,plan);save(parent);
 // These focused provenance fixtures are explicitly synthetic. Full-state schema,
 // canonical, receipt and source proof replay is tested by the real 1354-page run.
 const focusedApi={...api,assertState:v=>v};
 return {root,parent,child,plan,childDir,origin,save,focusedApi};
}
test('original authority determines parent UUID, allowing a separately issued newer taxonomy',t=>{
 const f=provenance(t);assert.equal(recovery.sourceImplementation(f.child,f.childDir,f.focusedApi),f.origin);
});
test('exact original state hash and source authority cannot be bypassed by rehashing a newer plan',t=>{
 const f=provenance(t);f.parent.stateSha256=H('drift');f.save(f.parent);assert.throws(()=>recovery.sourceImplementation(f.child,f.childDir,f.focusedApi),/original plan/);
});
test('缺少原上级进程时，拒绝合并，不能用当前词表推算原进程身份',t=>{
 const f=provenance(t);fs.rmSync(path.join(f.root,f.parent.processId),{recursive:true});assert.throws(()=>recovery.sourceImplementation(f.child,f.childDir,f.focusedApi),/ENOENT/);
});
test('re-signed plan cannot change parent member status or source identity',t=>{
 const f=provenance(t);f.plan.papers[0].previousStatus='complete';delete f.plan.planSha256;f.plan.planSha256=H(f.plan);f.child.sourceUpgradePromotion.planSha256=f.plan.planSha256;f.save(f.child,f.plan);
 assert.throws(()=>recovery.sourceImplementation(f.child,f.childDir,f.focusedApi),/source\/authority\/UUID/);
});
test('promoted-parent recursion checks its own plan and detects a parent cycle',t=>{
 const f=provenance(t);assert.throws(()=>recovery.sourceImplementation(f.child,f.childDir,f.focusedApi,new Set([f.child.processId])),/cycle/);
 const secondPlan={authority:f.child.authority,fromProcessId:f.child.processId,originalStateSha256:H('child issued state'),sourceImplementationSha256:f.origin,papers:structuredClone(f.plan.papers)};
 f.child.stateSha256=secondPlan.originalStateSha256;f.save(f.child,f.plan);secondPlan.planSha256=H(secondPlan);
 const second={...structuredClone(f.child),processId:api.deterministicUuid(secondPlan.planSha256,'conference-source-upgrade-process-v1'),sourceUpgradePromotion:{originalProcessId:f.child.processId,sourceImplementationSha256:f.origin,planSha256:secondPlan.planSha256}};
 const dir=f.save(second,secondPlan);assert.equal(recovery.sourceImplementation(second,dir,f.focusedApi),f.origin);
});
