'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), child = require('node:child_process'), Module = require('node:module');
const repair = require('../scripts/lib/reader-repair'), historical = require('../scripts/lib/reader-historical-draft-normalizer-replay');
const repository = path.resolve(__dirname, '..');
const closure = require('../scripts/lib/reader-historical-markdown-closure');
function legacyAnalysisRecord() {
    const file = 'scripts/analysis-contract.js';
    const bytes = child.execFileSync('git', ['show', `${legacyCommit}:${file}`], {cwd: repository});
    const blobOid = child.execFileSync('git', ['rev-parse', `${legacyCommit}:${file}`], {cwd: repository}).toString().trim();
    return {path: file, bytes, blobOid, sha256: repair.shaText(bytes)};
}
// 历史失败稿产生时的真实Git版本；提交新guard后不能把HEAD当作旧程序。
const legacyCommit = 'cba0e47ae170b52a9dc42f2364297289c8174ec1';
function fixture() {
    const code = child.execFileSync('git', ['show',`${legacyCommit}:scripts/lib/reader-draft-order.js`], {cwd:repository});
    const tableCode = child.execFileSync('git', ['show',`${legacyCommit}:scripts/lib/reader-tables.js`], {cwd:repository});
    assert.equal(repair.shaText(code), '81eebbd475a4bc68201db5ca232e187338cb2f43f046738800c79e76c0a3b7c5');
    assert.equal(repair.shaText(tableCode), 'affc5145cf360f8492f3c8b1bcc0bb3abc3d3d05e67bba7092d4fccd3c2bc727');
    const tableFilename=path.join(repository,'scripts/lib/reader-tables.js'),legacyTables=new Module(tableFilename,module);
    legacyTables.filename=tableFilename;legacyTables.paths=Module._nodeModulePaths(path.dirname(tableFilename));
    const oldMarkdown=closure.loadHistoricalMarkdownClosure(legacyAnalysisRecord()).api;
    const tableRequire=legacyTables.require.bind(legacyTables);
    legacyTables.require=spec=>spec==='../analysis-contract.js'?oldMarkdown:tableRequire(spec);
    legacyTables._compile(tableCode.toString(),tableFilename);
    const filename=path.join(repository,'scripts/lib/reader-draft-order.js'),legacy=new Module(filename,module);
    legacy.filename=filename;legacy.paths=Module._nodeModulePaths(path.dirname(filename));
    const normalRequire=legacy.require.bind(legacy);
    legacy.require=spec=>spec==='./reader-tables'?legacyTables.exports
        :spec==='../analysis-contract.js'?oldMarkdown:normalRequire(spec);
    legacy._compile(code.toString(),filename);
    const sourceText='The sealed corpus preserves original evidence.';
    const table={ordinal:1,caption:'Generic original benchmark',recoveryStatus:'complete',sourceDomSha256:'a'.repeat(64),headerRows:[0],bodyRows:[1],matrix:[['Method','Score'],['Baseline','0.10.1']]};
    table.cells=table.matrix.flatMap((row,r)=>row.map((text,c)=>({row:r,column:c,rowspan:1,colspan:1,text,header:r===0,sourceDomSha256:'b'.repeat(64)})));
    const source={text:sourceText,structuredArtifacts:{sourceKind:'arxiv_html',tables:[table],figures:[],formulas:[]}};
    const identity={sourceSha256:repair.shaText(sourceText),draftOrderImplementationSha256:repair.shaText(code),
        tableCompilerSha256:repair.shaText(tableCode)};
    const draft={version:3,readerTitle:'保留来源限定的失败稿',oneSentenceThesis:'真实已付费稿继续严格核验。',conceptBridges:[],figurePlacements:[],formulaBindings:[],
        tableBindings:[{tableIndex:1,completeTable:{sourceTableOrdinal:1}}],
        sections:require('../scripts/lib/reader-draft-order').READER_SECTION_KINDS.map((kind,index)=>({kind,heading:kind,body:index===0?'比较问题。\n\n[[TABLE_1]]\n\n只解释原数据。':kind.repeat(130)}))};
    const saved=legacy.exports.normalizeReaderDraftOrder(structuredClone(draft),{structuredArtifacts:source.structuredArtifacts}).draft;
    return {source,identity,draft,saved};
}
test('真实Git绑定原程序逐字确认失败稿来源，当前完整原表guard仍拒，不增加预算',()=>{
    const f=fixture(),before=repair.hashDraft(f.draft);
    const headProgram=child.execFileSync('git',['show','HEAD:scripts/lib/reader-draft-order.js'],{cwd:repository});
    assert.notEqual(repair.shaText(headProgram),f.identity.draftOrderImplementationSha256,
        '本回归必须在提交新guard之后复验原Git失败稿，不能把HEAD当成旧程序');
    const replay=historical.replayHistoricalDraftNormalizer(f.draft,f.identity,f.source,repair.hashDraft(f.saved));assert.ok(replay);
    assert.equal(replay.proof.purpose,'paid-failed-draft-provenance-only');assert.equal(replay.proof.normalizerSha256,f.identity.draftOrderImplementationSha256);
    assert.equal(replay.proof.outputDraftSha256,repair.hashDraft(f.saved));assert.equal(repair.hashDraft(f.draft),before);
    assert.equal(f.saved.tableBindings[0].sourceType,'artifact_table');assert.ok(f.saved.sections[0].body.includes('0.10.1'));
    assert.throws(()=>require('../scripts/lib/reader-draft-order').normalizeReaderDraftOrder(f.draft,{structuredArtifacts:f.source.structuredArtifacts}),/无法安全显示完整原表/);
    replay.assertUnchanged();historical.assertHistoricalNormalizerProof(replay.proof);
});
test('不匹配Git程序、源、保存稿或selection/PDF输入不猜历史分支',()=>{
    const f=fixture();
    for(const identity of [{...f.identity,draftOrderImplementationSha256:'f'.repeat(64)},{...f.identity,sourceSha256:'f'.repeat(64)},{...f.identity,tableCompilerSha256:'f'.repeat(64)}])
        assert.equal(historical.replayHistoricalDraftNormalizer(f.draft,identity,f.source,repair.hashDraft(f.saved)),null);
    assert.equal(historical.replayHistoricalDraftNormalizer(f.draft,f.identity,f.source,'f'.repeat(64)),null);
    const selected=structuredClone(f.draft);selected.tableBindings[0].selection={};
    assert.equal(historical.replayHistoricalDraftNormalizer(selected,f.identity,f.source,repair.hashDraft(f.saved)),null);
});
test('历史proof不能改Git字节、依赖身份或注入任意文件路径',()=>{
    const f=fixture(),replay=historical.replayHistoricalDraftNormalizer(f.draft,f.identity,f.source,repair.hashDraft(f.saved));
    for(const change of [p=>{p.normalizerSha256='f'.repeat(64);},p=>{p.dependencies[0].sha256='f'.repeat(64);},
        p=>{p.dependencies[0].path='../../untrusted.js';},p=>{p.dependencies[1]=p.dependencies[0];},p=>{delete p.markdownClosure;},
        p=>{p.markdownClosure.declarations[0].startByte+=1;},p=>{p.markdownClosure.closureSha256='f'.repeat(64);},
        p=>{p.markdownClosure.exports.push('require');}]){
        const bad=structuredClone(replay.proof);change(bad);assert.throws(()=>historical.assertHistoricalNormalizerProof(bad),/historical|Historical/);
    }
});
test('实际Git重放拒绝继承替换配置且禁止联网，仍只认证原SHA失败稿',t=>{
    const f=fixture(),run=child.execFileSync,calls=[];
    const original=process.env.GIT_DIR;
    process.env.GIT_DIR='/nonexistent-untrusted-git-directory';
    t.mock.method(child,'execFileSync',function(command,args,options){
        if(command==='git')calls.push({args:[...args],options});
        return run.apply(this,arguments);
    });
    try {
        const replay=historical.replayHistoricalDraftNormalizer(f.draft,f.identity,f.source,repair.hashDraft(f.saved));
        assert.ok(replay);replay.assertUnchanged();
        assert.ok(calls.length>0);
        for(const {args,options} of calls){
            assert.deepEqual(args.slice(0,2),['--no-lazy-fetch','--no-replace-objects']);
            assert.equal(options.env.GIT_DIR,undefined);
            assert.equal(options.env.GIT_NO_LAZY_FETCH,'1');
            assert.equal(options.env.GIT_TERMINAL_PROMPT,'0');
            assert.equal(options.env.GIT_CONFIG_GLOBAL,'/dev/null');
            assert.equal(options.timeout,10000);assert.equal(options.maxBuffer,8*1024*1024);
        }
    } finally {if(original===undefined)delete process.env.GIT_DIR;else process.env.GIT_DIR=original;}
});
test('新Git程序需要未核验依赖时明确不复用，Git读取损坏仍原错误停止',t=>{
    const f=fixture(),before=JSON.stringify(f);
    const identity={...f.identity,
        draftOrderImplementationSha256:repair.shaText(child.execFileSync('git',
            ['show','HEAD:scripts/lib/reader-draft-order.js'],{cwd:repository})),
        tableCompilerSha256:repair.shaText(child.execFileSync('git',
            ['show','HEAD:scripts/lib/reader-tables.js'],{cwd:repository}))};
    assert.notEqual(identity.draftOrderImplementationSha256,f.identity.draftOrderImplementationSha256);
    assert.equal(historical.replayHistoricalDraftNormalizer(f.draft,identity,f.source,repair.hashDraft(f.saved)),null);
    assert.equal(JSON.stringify(f),before);
    const run=child.execFileSync,failure=new Error('模拟Git物件读取损坏');
    t.mock.method(child,'execFileSync',function(command,args){
        if(command==='git'&&args.includes('cat-file'))throw failure;
        return run.apply(this,arguments);
    });
    assert.throws(()=>historical.replayHistoricalDraftNormalizer(f.draft,f.identity,f.source,
        repair.hashDraft(f.saved)),error=>error===failure);
    assert.equal(JSON.stringify(f),before);
});

// 这些测试直接读取原 Git 源码；不修改生产文件、失败稿、来源或预算。
test('历史纯闭包具备完整Git来源和逐声明边界，只导出旧程序需要的三个纯函数',()=>{
    const record=legacyAnalysisRecord(),loaded=closure.loadHistoricalMarkdownClosure(record);
    assert.ok(loaded);assert.equal(record.sha256,'b568585f94dc7745c9b66444188280713bd33a93d27ffecfe6ec69d5d5dff00c');
    assert.equal(loaded.proof.sourceSha256,record.sha256);
    assert.equal(loaded.proof.sourceBlobOid,record.blobOid);assert.equal(loaded.proof.declarations.length,13);
    assert.deepEqual(loaded.proof.exports,['extractMarkdownTables','maskProtectedMarkdownTableRegions','maskInlineMarkdownCodeSpans']);
    assert.deepEqual(Object.keys(loaded.api),loaded.proof.exports);assert.ok(Object.isFrozen(loaded.api));
    for(const entry of loaded.proof.declarations){
        const selected=record.bytes.subarray(entry.startByte,entry.endByte);
        assert.equal(repair.shaText(selected),entry.sha256);
        assert.match(selected.toString(),new RegExp(`^(?:const|function) ${entry.name}\\b`));
        assert.doesNotMatch(selected.toString(),/\brequire\s*\(|\bimport\s*\(/);
    }
    const text='`inline`\n\n| Method | Score |\n| --- | --- |\n| Baseline | 0.10.1 |';
    const tables=JSON.parse(JSON.stringify(loaded.api.extractMarkdownTables(text)));
    assert.deepEqual(tables[0].rows,[['Baseline','0.10.1']]);
    assert.equal(loaded.api.maskInlineMarkdownCodeSpans('`inline`'),'        ');
    assert.equal(loaded.api.maskProtectedMarkdownTableRegions('> hidden'),'        ');
});
test('任何闭包声明改变、重复边界、增加require或非UTF8字节都拒绝，绝不执行模块顶层',()=>{
    const record=legacyAnalysisRecord();
    for(const bytes of [
        Buffer.from(record.bytes.toString().replace('function extractMarkdownTables(text) {','function extractMarkdownTables(text) {\n    require("node:https");')),
        Buffer.from(record.bytes.toString().replace('const cells = splitMarkdownTableRow(row);','const cells = [];')),
        Buffer.concat([record.bytes,Buffer.from('\nfunction extractMarkdownTables(text) {\n    return [];\n}\n')]),
        Buffer.concat([record.bytes,Buffer.from([255])])
    ])assert.equal(closure.loadHistoricalMarkdownClosure({...record,bytes,sha256:repair.shaText(bytes)}),null);
    assert.equal(closure.loadHistoricalMarkdownClosure({...record,sha256:'f'.repeat(64)}),null);
    // 原模块顶层本来就 require 已删除的 Manual 模块；额外顶层异常也不属于纯闭包。
    const bytes=Buffer.concat([Buffer.from('throw new Error("MUST NEVER EXECUTE TOP LEVEL");\n'),record.bytes]);
    assert.ok(closure.loadHistoricalMarkdownClosure({...record,bytes,sha256:repair.shaText(bytes)}));
});
test('当前analysis-contract可独立变化，但PDF依赖当前字节漂移仍阻断历史重放',t=>{
    const f=fixture(),read=fs.readFileSync;
    t.mock.method(fs,'readFileSync',function(file,...args){
        if(file===path.join(repository,'scripts/analysis-contract.js'))throw new Error('不得加载当前analysis-contract');
        return read.call(this,file,...args);
    });
    const replay=historical.replayHistoricalDraftNormalizer(f.draft,f.identity,f.source,repair.hashDraft(f.saved));
    assert.ok(replay);replay.assertUnchanged();historical.assertHistoricalNormalizerProof(replay.proof);
    t.mock.restoreAll();
    t.mock.method(fs,'readFileSync',function(file,...args){
        if(file===path.join(repository,'scripts/lib/reader-pdf-cell-evidence.js'))return Buffer.from('changed PDF runtime');
        return read.call(this,file,...args);
    });
    assert.equal(historical.replayHistoricalDraftNormalizer(f.draft,f.identity,f.source,repair.hashDraft(f.saved)),null);
    assert.throws(()=>replay.assertUnchanged(),/dependency changed/);
    assert.throws(()=>historical.assertHistoricalNormalizerProof(replay.proof),/dependency bytes changed/);
});
test('Git返回同OID而不同blob字节必须在闭包装载前拒绝',t=>{
    const f=fixture(),run=child.execFileSync;
    t.mock.method(child,'execFileSync',function(command,args){
        const result=run.apply(this,arguments);
        if(command==='git'&&args.includes('cat-file'))return Buffer.concat([result,Buffer.from('\n')]);
        return result;
    });
    assert.throws(()=>historical.replayHistoricalDraftNormalizer(f.draft,f.identity,f.source,repair.hashDraft(f.saved)),/blob bytes do not match/);
});

test('旧v1凭证按原整blob在内存核闭包且不补字段，新v2删closure不得降级',()=>{
    const f=fixture(),replay=historical.replayHistoricalDraftNormalizer(f.draft,f.identity,f.source,repair.hashDraft(f.saved));
    assert.equal(replay.proof.contract,'reader-historical-draft-normalizer-replay-v2');
    // 模拟此前保存的原v1字段集合；外层候选/迁移SHA仍由调用方先核验。
    const legacy=structuredClone(replay.proof);legacy.contract='reader-historical-draft-normalizer-replay-v1';
    delete legacy.markdownClosure;const original=JSON.stringify(legacy);
    historical.assertHistoricalNormalizerProof(legacy);assert.equal(JSON.stringify(legacy),original);
    assert.equal(Object.hasOwn(legacy,'markdownClosure'),false);
    const missing=structuredClone(replay.proof);delete missing.markdownClosure;
    assert.throws(()=>historical.assertHistoricalNormalizerProof(missing),/proof is invalid/);
    for(const change of [p=>{p.dependencies[0].sha256='f'.repeat(64);},p=>{p.dependencies[0].blobOid='f'.repeat(40);},
        p=>{p.markdownClosure=replay.proof.markdownClosure;},p=>{p.untrustedDependency='node:https';}]){
        const bad=structuredClone(legacy);change(bad);assert.throws(()=>historical.assertHistoricalNormalizerProof(bad),/Historical/);
    }
});
