const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseArgs, loadInputs, replaySnapshotPlan, snapshotFigures, safeOutputDirectory, evaluate, stableHash, BUDGETS }
    = require('../scripts/evaluate-reader-efficiency.js');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-eval-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sourceText = 'Under protocol A, the proposed method reports 12 dB on the held-out set.';
    const artifacts = { sourceId: '2609.99980', tables: [{ ordinal: 1, sourceDomSha256: '1'.repeat(64) }],
        formulas: [{ ordinal: 1, latex: 'a=b', sourceDomSha256: '2'.repeat(64) }], figures: [],
        flattenedTextSha256: sha(sourceText) };
    artifacts.payloadSha256 = sha(JSON.stringify(artifacts));
    const plan = { version: 3, sections: [{ kind: 'result', heading: '同一条件下比较结果' }], figurePlacements: [],
        formulaBindings: [{ formulaOrdinal: 1, latex: 'a=b', sourceDomSha256: '2'.repeat(64) }],
        tableBindings: [{ sourceType: 'artifact_table', sourceTableOrdinal: 1, sourceTableDomSha256: '1'.repeat(64) },
            { sourceType: 'source_quotes', sourceQuotes: [{ quote: sourceText, sourceQuoteSha256: sha(sourceText) }] }] };
    const article = '### 同一条件下比较结果\n\n必须先限定相同测试条件，才可以比较报告值。';
    const paper = { arxivId: '2609.99980', analysis: '已冻结的 canonical 内容',
        sourceSha256: sha(sourceText), structuredArtifactsSha256: artifacts.payloadSha256,
        apiReaderArticle: article, apiReaderArticleSha256: sha(article), apiReaderPlan: plan,
        apiReaderPlanSha256: stableHash(plan), apiReaderFigures: [],
        analysisManifest: { sourceAcquisition: { sourceSha256: sha(sourceText), structuredArtifactsSha256: artifacts.payloadSha256 },
            stages: { apiReaderArticle: { articleSha256: sha(article), planSha256: stableHash(plan), structuredArtifactsSha256: artifacts.payloadSha256 } } } };
    const options = { paperId: paper.arxivId, sourceTextPath: path.join(root, 'source.txt'),
        artifactsPath: path.join(root, 'artifacts.json'), snapshotPath: path.join(root, 'paper.json'),
        outputDir: path.join(root, 'output'), live: false };
    fs.writeFileSync(options.sourceTextPath, sourceText);
    fs.writeFileSync(options.artifactsPath, JSON.stringify(artifacts));
    fs.writeFileSync(options.snapshotPath, JSON.stringify(paper));
    return { root, options, sourceText, artifacts, paper };
}

test('命令行默认离线，并要求显式且互不重复的输入输出参数', () => {
    const argv = ['--paper', '2609.99980v2', '--source-text', '/private/tmp/source.txt', '--artifacts', '/private/tmp/artifacts.json',
        '--paper-snapshot', '/private/tmp/paper.json', '--output-dir', '/private/tmp/evaluation'];
    assert.equal(parseArgs(argv).live, false);
    assert.equal(parseArgs(argv).paperId, '2609.99980');
    assert.equal(parseArgs([...argv, '--live']).live, true);
    assert.throws(() => parseArgs([...argv, '--live', '--live']), /参数重复/);
    assert.throws(() => parseArgs(argv.slice(0, -2)), /缺少必需参数/);
    assert.throws(() => parseArgs([...argv, '--model', 'fake']), /参数无效或缺少取值/);
    assert.equal(BUDGETS.logicalRequests, 3);
    assert.equal(BUDGETS.transportAttemptsPerRequest, 1);
});

test('来源载荷和产物载荷必须复核同一份已签名快照', t => {
    const f = fixture(t);
    assert.equal(loadInputs(f.options).artifactSha256, f.artifacts.payloadSha256);
    fs.writeFileSync(f.options.sourceTextPath, f.sourceText + ' changed');
    assert.throws(() => loadInputs(f.options), /来源全文的 SHA/);
    fs.writeFileSync(f.options.sourceTextPath, f.sourceText);
    const changed = structuredClone(f.artifacts); changed.tables[0].sourceDomSha256 = '3'.repeat(64);
    fs.writeFileSync(f.options.artifactsPath, JSON.stringify(changed));
    assert.throws(() => loadInputs(f.options), /结构化来源的 SHA/);
    delete changed.payloadSha256; changed.payloadSha256 = sha(JSON.stringify(changed));
    fs.writeFileSync(f.options.artifactsPath, JSON.stringify(changed));
    assert.throws(() => loadInputs(f.options), /论文快照绑定的 SHA/);
    fs.writeFileSync(f.options.artifactsPath, JSON.stringify({ text: f.sourceText, tables: [], formulas: [] }));
    assert.throws(() => loadInputs(f.options), /不能用摘要重算哈希代替/);
});

test('基线复核拒绝被改动的计划或文章、公式身份，以及精确引用来源', t => {
    const f = fixture(t);
    assert.equal(replaySnapshotPlan(f.paper, f.artifacts, f.sourceText).status, 'replayed');
    const changed = structuredClone(f.paper); changed.apiReaderArticle += 'new';
    assert.throws(() => replaySnapshotPlan(changed, f.artifacts, f.sourceText), /SHA 不一致/);
    const artifacts = structuredClone(f.artifacts); artifacts.formulas[0].latex = 'a=c';
    assert.throws(() => replaySnapshotPlan(f.paper, artifacts, f.sourceText), /快照公式与结构化来源/);
    assert.throws(() => replaySnapshotPlan(f.paper, f.artifacts, 'different source'), /快照表格引用/);
});

test('只接受已存在且 SHA 与记录一致的图片缓存字节', t => {
    const f = fixture(t);
    const cachePath = path.join(f.root, 'figure.png');
    fs.writeFileSync(cachePath, 'fixture pixels');
    f.paper.apiReaderFigures = [{ ordinal: 1, cachePath, assetSha256: sha('fixture pixels') }];
    assert.equal(snapshotFigures(f.paper).length, 1);
    fs.writeFileSync(cachePath, 'changed pixels');
    assert.throws(() => snapshotFigures(f.paper), /SHA 不一致/);
});

test('输出拒绝当前目录、重叠输入、已存在内容和符号链接目录', t => {
    const f = fixture(t);
    const current = path.join(f.root, 'current'); fs.mkdirSync(current);
    assert.throws(() => safeOutputDirectory(path.join(current, 'experiment'), [], current), /data\/current 之外/);
    assert.throws(() => safeOutputDirectory(f.root, [f.options.sourceTextPath], current), /不能包含输入文件/);
    const existing = path.join(f.root, 'existing'); fs.mkdirSync(existing); fs.writeFileSync(path.join(existing, 'keep.txt'), 'keep');
    assert.throws(() => safeOutputDirectory(existing, [], current), /新的空目录/);
    const target = path.join(f.root, 'target'); fs.mkdirSync(target);
    const link = path.join(f.root, 'link'); fs.symlinkSync(target, link);
    assert.throws(() => safeOutputDirectory(link, [], current), /逐级为真实目录/);
    assert.equal(fs.readFileSync(path.join(existing, 'keep.txt'), 'utf8'), 'keep');
});

test('默认离线评估不调模型，写一份私有报告，并保留来源和正式文件', async t => {
    const f = fixture(t);
    const before = [f.options.sourceTextPath, f.options.artifactsPath, f.options.snapshotPath]
        .map(filename => sha(fs.readFileSync(filename)));
    const deepModulePath = require.resolve('../scripts/deep-analyzer.js');
    assert.equal(require.cache[deepModulePath], undefined);
    const report = await evaluate(f.options);
    assert.equal(report.status, 'offline_replay_complete');
    assert.equal(report.calls.length, 0);
    assert.equal(report.usage.status, 'not_requested');
    assert.equal(report.integrity.unchanged, true);
    assert.equal(require.cache[deepModulePath], undefined, '离线评估不能加载模型生成模块');
    assert.deepEqual([f.options.sourceTextPath, f.options.artifactsPath, f.options.snapshotPath]
        .map(filename => sha(fs.readFileSync(filename))), before);
    assert.deepEqual(fs.readdirSync(f.options.outputDir), ['report.json']);
    assert.equal(fs.statSync(path.join(f.options.outputDir, 'report.json')).mode & 0o777, 0o600);
});

test('归档产物无效时写一份失败报告，不加载模型代码', async t => {
    const f = fixture(t);
    fs.writeFileSync(f.options.artifactsPath, JSON.stringify({ text: f.sourceText, tables: [], formulas: [] }));
    const report = await evaluate(f.options);
    assert.equal(report.status, 'failed');
    assert.match(report.error.message, /完整结构化来源记录/);
    assert.equal(report.calls.length, 0);
    assert.equal(report.integrity.unchanged, true);
    assert.equal(require.cache[require.resolve('../scripts/deep-analyzer.js')], undefined);
});


test('来源或监测路径是命名管道时立即拒绝，不等待写入进程', t => {
    const { spawnSync } = require('node:child_process');
    const f = fixture(t), fifo = path.join(f.root, 'source.pipe');
    const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
    for (const operation of ['loadInputs', 'evaluate']) {
        const options = { ...f.options, sourceTextPath: fifo, outputDir: path.join(f.root, operation) };
        const script = `const api=require(${JSON.stringify(require.resolve('../scripts/evaluate-reader-efficiency.js'))});
Promise.resolve().then(()=>api[${JSON.stringify(operation)}](${JSON.stringify(options)}))
.then(()=>process.exitCode=2).catch(error=>{console.error(error.message);process.exitCode=1;});`;
        const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 3000 });
        assert.equal(child.error, undefined, `${operation} 不应因读取管道而超时`);
        assert.equal(child.status, 1, child.stderr);
        assert.match(child.stderr, /普通文件|regular file/);
    }
});

test('评估持久化最终图像装配计划，来源凭证与两个文件及报告哈希一致', async t => {
    const f = fixture(t), id = '2609.15067';
    const figure = { ordinal: 1, label: 'Figure 1:', caption: 'Figure 1: Overview of the study.',
        sourceDomSha256: '4'.repeat(64), recoveryStatus: 'complete',
        images: [{ kind: 'external_url', mediaType: 'image/png', url: `https://arxiv.org/html/${id}v1/method.png` }] };
    f.artifacts.sourceId = id; f.artifacts.figures = [figure];
    delete f.artifacts.payloadSha256; f.artifacts.payloadSha256 = sha(JSON.stringify(f.artifacts));
    f.paper.arxivId = id; f.paper.structuredArtifactsSha256 = f.artifacts.payloadSha256;
    f.paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256 = f.artifacts.payloadSha256;
    f.paper.analysisManifest.stages.apiReaderArticle.structuredArtifactsSha256 = f.artifacts.payloadSha256;
    const cachePath = path.join(f.root, 'verified-figure.png'); fs.writeFileSync(cachePath, 'fixture pixels');
    f.paper.apiReaderFigures = [{ ordinal: 1, url: figure.images[0].url, cachePath, assetSha256: sha('fixture pixels') }];
    fs.writeFileSync(f.options.artifactsPath, JSON.stringify(f.artifacts));
    fs.writeFileSync(f.options.snapshotPath, JSON.stringify(f.paper));
    const options = { ...f.options, paperId: id, live: true };
    // 子进程保留生产入口的新进程约束；仅替换模型生成函数，图像装配和落盘仍走真实实现。
    const script = `const Module=require('node:module'), load=Module._load;
const api=require(${JSON.stringify(require.resolve('../scripts/evaluate-reader-efficiency.js'))});
let generated=0;
Module._load=function(request,parent,isMain){
 const value=load.apply(this,arguments);
 if(request==='./deep-analyzer.js' && parent.filename.endsWith('/evaluate-reader-efficiency.js')) {
  return {...value,callModel:async()=>{throw new Error('测试不得请求真实模型');},
   generateApiReaderArticleDetailed:async()=>{generated++;return {article:'### 结果说明\\n\\n[[FIGURE_1]]',
    plan:{sections:[{kind:'result',heading:'结果说明'}],tableBindings:[],formulaBindings:[],figurePlacements:[{figureOrdinal:1,targetKind:'result',marker:'[[FIGURE_1]]'}]},qualityMetrics:{},attempts:1};}};
 }return value;
};
api.evaluate(${JSON.stringify(options)}).then(report=>{if(report.status!=='live_reader_generated'||generated!==1)throw new Error(JSON.stringify(report));})
.catch(error=>{console.error(error);process.exitCode=1;});`;
    const child = require('node:child_process').spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const read = name => JSON.parse(fs.readFileSync(path.join(options.outputDir, name), 'utf8'));
    const plan = read('reader.plan.json'), result = read('reader.result.json'), report = read('report.json');
    assert.equal(typeof plan.structuredSourcePayload, 'string');
    assert.equal(sha(plan.structuredSourcePayload), f.artifacts.payloadSha256);
    assert.deepEqual(result.plan, plan);
    assert.equal(report.result.planSha256, stableHash(plan));
    assert.equal(report.integrity.unchanged, true);
    assert.equal(report.calls.length, 0);
});
