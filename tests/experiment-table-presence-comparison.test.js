'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const zlib=require('node:zlib');
const {createHash}=require('node:crypto');
const c=require('../scripts/analysis-contract');
// Extracted unchanged from the saved analysisCheckpoint and its sealed source.txt;
// this fixture is a regression input, never a production completion proof.
const raw=fs.readFileSync(require.resolve('./fixtures/presence-comparison-daily-20261021-real.json.gz'));
const sha=s=>createHash('sha256').update(s).digest('hex');
assert.equal(sha(raw),'2f27661fdc6f738b5eb16db8dca92118f4ec8d872f52b76c1cbc1fcf70cabe09');
const f=JSON.parse(zlib.gunzipSync(raw));
assert.equal(sha(f.analysis),f.provenance.analysisSha256);
assert.equal(sha(f.source),f.provenance.sourceSha256);
const validate=(analysis=f.analysis,sourceText=f.source)=>c.validateExperimentTableContract(analysis,{contractVersion:c.EXPERIMENT_TABLE_CONTRACT_VERSION,documentType:'方法研究',sourceText});
test('真实付费稿的无草图、有草图和原表数值无需改写即可识别',()=>{
 assert.equal(validate(),null);
 assert.match(f.provenance.originalFailure,/没有保留关键消融/);
 for(const row of ['| 直接对照 | 0.5 / 0.2 | 60.8 | 67.6 |','| SKAD | 0.2 | 63.3 | 70.4 |']) assert.ok(f.analysis.includes(row));
});
test('缺少同组件对照、原表数值或本篇已发生的来源陈述仍拒绝',()=>{
 const mutations=[
  f.analysis.replaceAll('有草图后','有提示后'),
  f.analysis.replaceAll('无草图时','原设置时'),
  f.analysis.replaceAll('| 60.8 | 67.6 |','| 61.8 | 67.6 |'),
  f.analysis.replaceAll('本组比较','本组介绍'),
  ...['如果','假设','假定','假如','倘若','若','设想','拟','该研究中，','该论文中，','文献中，','据报告，','他人实验中，','未来实验中，','没有观察到：','“'].map(prefix=>f.analysis.replaceAll('无草图时',prefix+'无草图时')),
  f.analysis.replaceAll('本组比较','计划比较'),
  f.analysis.replaceAll('Avg. % ↑','Avg. ms ↑'),
  f.analysis.replaceAll('| 直接对照 | 0.5 / 0.2 | 60.8 | 67.6 |','| 直接对照 | 0.5 / 0.2 | 60.8 | 69.5 |').replaceAll('| SKAD | 1.0 | 63.7 | 69.5 |','| SKAD | 1.0 | 63.7 | 67.6 |'),
 ];
 for(const analysis of mutations) assert.match(validate(analysis),/没有保留关键消融/);
 for(const source of [f.source.replaceAll('without','excluding').replaceAll('Without','Excluding'),
   f.source.replace('First, directly applying','Hypothetical experiment: directly applying'),
   f.source.replace('First, directly applying','Other study: directly applying'),
   ...['In [12], ','Zhang et al. ','文献[12]报告，'].map(prefix=>f.source.replace('First, directly applying',prefix+'directly applying'))]) assert.match(validate(f.analysis,source),/没有保留关键消融/);
});
