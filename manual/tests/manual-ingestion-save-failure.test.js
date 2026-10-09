const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

for (const failure of ['lock', 'save']) {
    test(`真实人工录入遇到${failure === 'lock' ? '锁' : '写入文件'}失败，不能把旧成功记录算成本轮完成`, () => {
        const script = `
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'manual-failed-attempt-'));
const Config=require('./scripts/config');
const engine=require('./scripts/analysis-engine');
const {validAnalysisPaper}=require('./tests/valid-analysis-fixture');
const paper=validAnalysisPaper('2601.12345');
if (!engine.isSuccessfulAnalysisRecord(paper)) throw new Error('用于测试的旧记录必须实际通过分析成功检查');
const filtered=path.join(root,'filtered.json'),canonical=path.join(root,'canonical.json'),specPath=path.join(root,'spec.json');
Config.FILES.filteredPapers=filtered;Config.FILES.deepAnalysisResult=canonical;
fs.writeFileSync(filtered,JSON.stringify({batchDate:'2026-09-01',status:'complete',papers:[{arxivId:'2601.12345',title:'Paper'}]}));
fs.writeFileSync(canonical,JSON.stringify({batchDate:'2026-09-01',status:'complete',papers:[paper]}));
const failure=${JSON.stringify(failure)};
engine.withPaperAnalysisLock=async(_paper,callback)=>{
    if(failure==='lock') throw Object.assign(new Error('模拟本轮锁失败'),{code:'EIO'});
    return callback();
};
engine.mergeAndSaveResults=async()=>{throw Object.assign(new Error('模拟本轮磁盘写入失败'),{code:'EIO'})};
const manual=require('./manual/scripts/manual-deep-analysis');
const bindings=manual.buildLegacyStagePromptBindings();
fs.writeFileSync(specPath,JSON.stringify({version:3,mode:'manual_complete',date:'2026-09-01',
    manualAuthoringPromptPath:'manual/prompts/manual-analysis-record.md',manualAuthoringPromptSha256:'a'.repeat(64),
    promptSha256:bindings.primaryAnalysis.sha256,
    stagePromptSha256:Object.fromEntries(Object.entries(bindings).map(([key,b])=>[key,b.sha256])),
    papers:{'2601.12345':{}}}));
process.argv=[process.execPath,'manual-deep-analysis.js','--date','2026-09-01','--spec',specPath,'--force'];
manual.run().then(()=>{
    const saved=JSON.parse(fs.readFileSync(canonical));
    const failed={status:saved.status,failed:saved.stats.failed,success:saved.stats.success,
        failedIds:saved.stats.failedIds,errors:saved.stats.failedAttempts,
        oldArticlePreserved:saved.papers[0].analysis===paper.analysis};
    // 随后一次无失败的实际最终汇总必须清除本轮错误，不能永久污染恢复。
    const recovered=manual.finalizeManualAnalysisBatchState(canonical,{date:'2026-09-01',expectedIds:['2601.12345']});
    console.log('PROBE_RESULT '+JSON.stringify({failed,recoveredStatus:recovered.status,recoveredErrors:recovered.stats.failedAttempts}));
    fs.rmSync(root,{recursive:true,force:true});
}).catch(error=>{console.error(error);fs.rmSync(root,{recursive:true,force:true});process.exitCode=1});
`;
        const child = spawnSync(process.execPath, ['-e', script], {
            cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8', timeout: 10000
        });
        assert.equal(child.status, 2, child.stderr);
        const result = JSON.parse(child.stdout.match(/PROBE_RESULT (\{.*\})/)[1]);
        assert.equal(result.failed.status, 'partial_failed');
        assert.equal(result.failed.failed, 1);
        assert.equal(result.failed.success, 0);
        assert.deepEqual(result.failed.failedIds, ['2601.12345']);
        assert.match(result.failed.errors['2601.12345'], failure === 'lock' ? /模拟本轮锁失败/ : /模拟本轮磁盘写入失败/);
        assert.equal(result.failed.oldArticlePreserved, true);
        assert.equal(result.recoveredStatus, 'complete');
        assert.deepEqual(result.recoveredErrors, {});
    });
}
