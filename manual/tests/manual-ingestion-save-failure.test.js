const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

for (const failure of ['lock', 'save']) {
    test(`真实人工录入遇到${failure === 'lock' ? '锁' : '写入文件'}失败，不能把旧成功记录算成本轮完成`, () => {
        const script = `
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const fx=require('./manual/tests/helpers/current-v6-public-pipeline.cjs').createCurrentV6Pipeline();
const root=fx.temporaryRoot;
const Config=require('./scripts/config');
const engine=require('./scripts/analysis-engine');
const {validAnalysisPaper}=require('./tests/valid-analysis-fixture');
const paper=validAnalysisPaper(fx.id);
if (!engine.isSuccessfulAnalysisRecord(paper)) throw new Error('用于测试的旧记录必须实际通过分析成功检查');
const canonical=fx.canonicalPath,specPath=fx.specPath;
const defaultPapers = require('node:path').join(fx.temporaryRoot, 'default-papers.json');
const defaultLegacyPapers = require('node:path').join(fx.temporaryRoot, 'default-legacy-papers.json');
const defaultBytes = Buffer.from(JSON.stringify({ papers: { [fx.id]: { arxivId: fx.id, title: '原有本地样例', digestStatus: { status: 'seen' } } }, lastUpdated: null }));
fs.writeFileSync(defaultPapers, defaultBytes);
fs.writeFileSync(defaultLegacyPapers, defaultBytes);
Config.FILES.papers = defaultPapers;
Config.FILES.papersLegacy = defaultLegacyPapers;
// 默认位置仅指向本地合成库；本次录入必须使用任务自己的论文库。
Config.FILES.papers = require('node:path').join(fx.currentDir, 'papers.json');
Config.FILES.papersLegacy = require('node:path').join(fx.currentDir, 'papers-legacy.json');
Config.CURRENT_DIR=fx.currentDir;
Config.FILES.filteredPapers=fx.filteredPath;Config.FILES.deepAnalysisResult=canonical;
Config.FILES.manualExternalResourceCache=path.join(fx.currentDir,'manual-external-resource-cache.json');
fs.writeFileSync(canonical,JSON.stringify({batchDate:fx.date,status:'complete',papers:[paper]}));
const failure=${JSON.stringify(failure)};
engine.withPaperAnalysisLock=async(_paper,callback)=>{
    if(failure==='lock') throw Object.assign(new Error('模拟本轮锁失败'),{code:'EIO'});
    return callback();
};
engine.mergeAndSaveResults=async()=>{throw Object.assign(new Error('模拟本轮磁盘写入失败'),{code:'EIO'})};
const manual=require('./manual/scripts/manual-deep-analysis');
process.argv=[process.execPath,'manual-deep-analysis.js','--date',fx.date,'--spec',specPath,'--v6-production','--force'];
manual.run().then(()=>{
    require('node:assert/strict').ok(fs.readFileSync(defaultPapers).equals(defaultBytes), '默认论文库原字节必须保持');
    require('node:assert/strict').ok(fs.readFileSync(defaultLegacyPapers).equals(defaultBytes), '默认旧版论文库原字节必须保持');
    const saved=JSON.parse(fs.readFileSync(canonical));
    const failed={status:saved.status,failed:saved.stats.failed,success:saved.stats.success,
        failedIds:saved.stats.failedIds,errors:saved.stats.failedAttempts,
        oldArticlePreserved:saved.papers[0].analysis===paper.analysis};
    // 随后一次无失败的实际最终汇总必须清除本轮错误，不能永久污染恢复。
    const recovered=manual.finalizeManualAnalysisBatchState(canonical,{date:fx.date,expectedIds:[fx.id]});
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
        assert.deepEqual(result.failed.failedIds, ['2610.90001']);
        assert.match(result.failed.errors['2610.90001'], failure === 'lock' ? /模拟本轮锁失败/ : /模拟本轮磁盘写入失败/);
        assert.equal(result.failed.oldArticlePreserved, true);
        assert.equal(result.recoveredStatus, 'complete');
        assert.deepEqual(result.recoveredErrors, {});
    });
}
