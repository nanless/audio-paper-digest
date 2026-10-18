'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{Module}=require('node:module');
const file=require.resolve('../scripts/deep-analyzer'),probe=new Module(file,module);
probe.filename=file;probe.paths=Module._nodeModulePaths(path.dirname(file));
probe._compile(fs.readFileSync(file,'utf8')+'\nmodule.exports.selectDisplayForTest=selectReaderReviewCandidateDisplay;',file);
const choose=probe.exports.selectDisplayForTest;
test('原候选按完整逻辑身份唯一选择精简或完整显示，实现升级不重授输入',()=>{
 const mini={paperId:'synthetic',inputFingerprint:'minimal-input',signedRevisionDisplayContract:'v1',signedRevisionDisplaySha256:'sha',parserImplementationSha256:'new'},full={paperId:'synthetic',inputFingerprint:'full-input',parserImplementationSha256:'new'};
 const options=[{minimal:true,identity:mini},{minimal:false,identity:full}];
 assert.equal(choose([{envelope:{identity:{...mini,parserImplementationSha256:'old'}}}],options),true);
 assert.equal(choose([{envelope:{identity:{...full,parserImplementationSha256:'old'}}}],options),false);
 assert.throws(()=>choose([{envelope:{identity:{...mini,inputFingerprint:'different-request'}}}],options),/禁止新建输入/);
 assert.throws(()=>choose([{envelope:{identity:{...mini,paperId:'other'}}}],options),/禁止新建输入/);
 assert.throws(()=>choose([{envelope:{identity:mini}},{envelope:{identity:full}}],options),/唯一真实/);
});
test('没有真实私有父seed能力时 plain JSON 不授精简父稿资格',()=>{
 const maintenance=require('../scripts/lib/conference-reader-review-maintenance');
 assert.throws(()=>maintenance.readVerifiedParentReaderSeed({}, {paper:{},revisionSeed:{initialDraft:'forged'}}),/opaque original parent Reader seed required/);
});
