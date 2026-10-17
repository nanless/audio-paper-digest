'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), child = require('node:child_process');
const crypto = require('node:crypto');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pdfApi = require('../scripts/lib/reader-authenticated-pdf-table-evidence');
const sourceApi = require('../scripts/lib/conference-source-context');
const adapter = require('../scripts/lib/conference-analysis-adapter');
const processApi = require('../scripts/lib/conference-process');
const publication = require('../scripts/lib/conference-reader-publication-evidence');
const context = require('../scripts/lib/conference-analysis-context');
const deep = require('../scripts/deep-analyzer');
const Config = require('../scripts/config');
const markdown = '| Method | EDT (s) | C50 (dB) |\n|---|---|---|\n|Alpha|0.10|3.2|\n|Beta|0.20|4.3|';
const executionId = '33333333-3333-4333-8333-333333333333';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-pdf-cold-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const extraction = require('./helpers/conference-extraction-fixture');
    const original = extraction.buildPdf;
    const text = ['Fixture audio paper', 'Table 1: Measured errors under the same evaluation protocol.',
        'Method', 'EDT (s)', 'C50 (dB)', 'Alpha', '0.10', '3.2', 'Beta', '0.20', '4.3',
        ...Array.from({length: 55}, () => 'Controlled experimental methods and evaluation evidence. ' + 'x'.repeat(40))].join('\n');
    const raw = child.execFileSync('bash', ['scripts/python-runtime.sh', '-c',
        'import fitz,sys;d=fitz.open();p=d.new_page();p.insert_text((25,25),sys.argv[1],fontsize=7);sys.stdout.buffer.write(d.tobytes());d.close()', text],
    { cwd: path.resolve(__dirname, '..'), maxBuffer: 8 * 1024 * 1024 });
    extraction.buildPdf = () => raw;
    let f;
    try { f = require('./helpers/conference-process-storage-fixture').createSourceFixture(root); }
    finally { extraction.buildPdf = original; }
    fs.copyFileSync(path.resolve(__dirname,'../config/tag-catalog.json'),f.files.tagCatalogFile);
    for (const [from,to,folder] of [['catalog.json','odyssey-2026.json','catalogs'], ['report.json','odyssey-2026-report.json','reports']])
        fs.renameSync(path.join(root,folder,from), path.join(root,folder,to));
    f.context = processApi.loadAuthority({catalogName:'odyssey-2026.json', reportName:'odyssey-2026-report.json', filterId:f.options.filterId}, f.deps);
    const shared = processApi.prepareShared(f.context, f.deps, f.stamp);
    const sourceRoot = path.join(f.files.conferenceSourceCacheDir, fs.readdirSync(f.files.conferenceSourceCacheDir).find(name => name.startsWith('generation-')));
    const handle = sourceApi.buildConferenceSourceContext({planHandle:shared.planHandle,paperId:f.paperId,sourceRoot});
    const details = adapter.sourceDetails(handle);
    adapter.prepareConferenceAnalysis({planHandle:shared.planHandle,paperId:f.paperId,sourceRoot,
        analysisRoot:f.files.conferenceAnalysisDir,executionId,now:f.stamp});
    let loaded = adapter.loadConferenceAnalysis({analysisRoot:f.files.conferenceAnalysisDir,executionId});
    const quotes = ['Alpha\n0.10\n3.2', 'Beta\n0.20\n4.3'];
    assert.ok(quotes.every(quote => details.text.includes(quote)));
    const bound = context.withConferenceAnalysisSource({executionId,executionDir:loaded.directory,paperId:f.paperId,
        sourceDetails:details,readerPdfSourceHandle:handle}, () => deep.bindApiReaderSourceEvidence(markdown,
        [{tableIndex:1,sourceType:'source_quotes',sourceTableOrdinal:null,cellBindings:[],sourceQuotes:quotes}],[],
        {sourceText:details.text,structuredArtifacts:details.structuredArtifacts}));
    assert.ok(bound.tableBindings[0].authenticatedPdfTableEvidence);
    const plan = {readerTitle:'Literal source table',oneSentenceThesis:'Evaluate literal source evidence.',sections:[],conceptBridges:[],
        sourceBindingsContract:'api-reader-source-bindings-v4',tableBindings:bound.tableBindings,formulaBindings:[],sourceBindingsSha256:bound.sourceBindingsSha256};
    const resourcesBody = {contract:'api-reader-resource-identity-v1',sourceTextSha256:sha(details.text),resources:[]};
    const paper = {...loaded.analysis.papers[0],sourceSha256:sha(details.text),apiReaderArticle:bound.article,apiReaderPlan:plan,
        apiReaderPlanSha256:deep.stableFingerprint(plan),apiReaderResources:{...resourcesBody,identitySha256:deep.stableFingerprint(resourcesBody)},
        analysisManifest:{contracts:{apiReaderSourceBindings:'api-reader-source-bindings-v4'},sourceAcquisition:{sourceSha256:sha(details.text),
            structuredArtifactsSha256:details.structuredArtifacts.payloadSha256},stages:{apiReaderArticle:{sourceBindingsContractVersion:'api-reader-source-bindings-v4',
            sourceBindingsSha256:bound.sourceBindingsSha256,sourceBindingsSourceTextSha256:sha(details.text),
            structuredArtifactsSha256:details.structuredArtifacts.payloadSha256,tableBindingCount:1,formulaBindingCount:0}}}};
    const analysis = {...loaded.analysis,status:'complete',completedAt:f.stamp,papers:[paper]};
    adapter.replaceJson(path.join(loaded.directory,'analysis.json'),analysis,loaded.analysisFileSha256);
    loaded = adapter.loadConferenceAnalysis({analysisRoot:f.files.conferenceAnalysisDir,executionId}); adapter.sealCompletedRun(loaded);
    const originalConfig = {...Config.FILES}; Object.assign(Config.FILES,f.files);
    t.after(() => Object.assign(Config.FILES,originalConfig));
    return {...f,sourceRoot,handle,details,paper,shared,loaded:adapter.loadConferenceAnalysis({analysisRoot:f.files.conferenceAnalysisDir,executionId})};
}

test('正常签发的新PDF字段经真实canonical和原计划冷核，再由共享只读worker交给Python核单位', t => {
    const f = fixture(t), proof = f.paper.apiReaderPlan.tableBindings[0].authenticatedPdfTableEvidence;
    const original = fs.readFileSync(path.join(f.loaded.directory,'analysis.json'));
    const handle = publication.replayCanonicalReaderPdfSource(f.paper,proof.sourceIdentity);
    assert.equal(pdfApi.withVerifiedSource(handle,()=>pdfApi.withSavedPaper(f.paper,()=>true)),true);
    const input = path.join(f.root,'private.json'); fs.writeFileSync(input,JSON.stringify({paper:f.paper,authenticatedPdfTables:true}),{mode:0o600});
    const fd = fs.openSync(input,'r'); let response;
    try {
        const prelude = `Object.assign(require('./scripts/config').FILES,JSON.parse(process.argv[1]));process.argv=[process.execPath,'reader-resource-claims-replay-cli.js','3'];require('./scripts/lib/reader-resource-claims-replay-cli.js');`;
        const outcome = child.spawnSync(process.execPath,['-e',prelude,JSON.stringify(f.files)],{
            cwd:path.resolve(__dirname,'..'),stdio:['ignore','pipe','pipe',fd],maxBuffer:4*1024*1024});
        assert.equal(outcome.status,0,String(outcome.stdout)+' '+String(outcome.stderr));
        response = JSON.parse(outcome.stdout);
    } finally { fs.closeSync(fd); }
    assert.equal(response.verified,true); assert.equal(response.tableEvidence.tables[0].headerUnits.length,4);
    const payload = path.join(f.root,'python-input.json');fs.writeFileSync(payload,JSON.stringify({paper:f.paper,evidence:response.tableEvidence}),{mode:0o600});
    const python = `import json,sys\nsys.path.insert(0,'scripts')\nimport importlib.util\ns=importlib.util.spec_from_file_location('publisher','scripts/publish-to-blog.py');p=importlib.util.module_from_spec(s);s.loader.exec_module(p)\nx=json.load(open(sys.argv[1]));assert p._validate_api_reader_source_bindings(x['paper'],publication_table_evidence=x['evidence'])['tableCount']==1\nprint('python-cold-unit-bridge-ok')`;
    assert.match(child.execFileSync('bash',['scripts/python-runtime.sh','-c',python,payload],{cwd:path.resolve(__dirname,'..')}).toString(),/python-cold-unit-bridge-ok/);
    assert.deepEqual(fs.readFileSync(path.join(f.loaded.directory,'analysis.json')),original);
    for (const change of ['executionId','pdfSha','table','article']) {
        const bad = structuredClone(f.paper), identity=bad.apiReaderPlan.tableBindings[0].authenticatedPdfTableEvidence.sourceIdentity;
        if(change==='executionId')identity.executionId='44444444-4444-4444-8444-444444444444';
        else if(change==='pdfSha')identity.sourceSnapshotBinding.sourceBinding.pdfSha256='0'.repeat(64);
        else if(change==='table')bad.apiReaderPlan.tableBindings[0].renderedTableSha256='0'.repeat(64);
        else bad.apiReaderArticle+='\nchanged';
        assert.throws(()=>publication.replayCanonicalReaderPdfSource(bad,identity));
    }
    assert.equal(publication.readVerifiedPublicationReaderPdfSource({...proof.sourceIdentity}),null);
});


test('冷表证不能用完整PDF来源替代新增恢复窗口的真实登记凭证', t => {
    const f = fixture(t), proof = f.paper.apiReaderPlan.tableBindings[0].authenticatedPdfTableEvidence;
    const analysis = { ...f.loaded.analysis, readerRevisionProgress: { attempts: 1, failures: [] } };
    adapter.replaceJson(path.join(f.loaded.directory, 'analysis.json'), analysis, f.loaded.analysisFileSha256);
    // replaceJson returns no receipt; read the real canonical bytes before sealing.
    adapter.sealCompletedRun({ ...f.loaded,
        analysisFileSha256: adapter.readJsonRecord(path.join(f.loaded.directory, 'analysis.json')).sha256 });
    assert.throws(() => publication.replayCanonicalReaderPdfSource(f.paper, proof.sourceIdentity), /ENOENT/);
    const body = { contract: 'conference-reader-recovery-window-v1', version: 1,
        executionId, paperId: f.paperId, grantId: '11111111-2222-4333-8444-555555555555',
        grantSha256: 'a'.repeat(64) };
    adapter.writeBytesAtomic(path.join(f.loaded.directory, 'reader-revision.json'),
        Buffer.from(JSON.stringify({ ...body, revisionSha256: adapter.stableHash(body) }, null, 2) + '\n'));
    assert.throws(() => publication.replayCanonicalReaderPdfSource(f.paper, proof.sourceIdentity), /窗口身份或 SHA|追加许可/);
    assert.equal(fs.existsSync(path.join(f.loaded.directory, 'reader-grant-budget.json')), false);
});

test('完成稿页面投影恢复真实会议执行范围，原PDF表证不丢executionId且拒错来源', t => {
    const f = fixture(t);
    // Exercise the real private rendering wrapper with an authenticated source
    // fixture, not an invented whole-paper qualification or exported capability.
    const Module = require('node:module');
    const filename = require.resolve('../scripts/lib/conference-postprocess');
    const compiled = new Module(filename, module);
    compiled.filename = filename;
    compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    compiled._compile(fs.readFileSync(filename, 'utf8')
        + '\nmodule.exports.testCompletedScope = withCompletedPublicationEvidence;', filename);
    const replay = compiled.exports.testCompletedScope;
    const loaded = { ...f.loaded, readerPdfSourceHandle: f.handle };
    assert.equal(context.getConferenceAnalysisContext(), null);
    assert.equal(replay(loaded, () => {
        const current = context.getConferenceAnalysisContext();
        assert.equal(current.executionId, executionId);
        assert.equal(current.readerPdfSourceHandle, f.handle);
        assert.equal(sourceApi.readerPdfSourceForContext(f.handle).sourceIdentity.executionId, executionId);
        return true;
    }), true);
    assert.equal(context.getConferenceAnalysisContext(), null);
    assert.throws(() => replay({ ...loaded, run: { ...loaded.run,
        executionId: '44444444-4444-4444-8444-444444444444' } }, () => true), /differs|不同|identity/);
    const wrongSource = structuredClone(loaded.source);
    wrongSource.sourceDetails.text += '\nnot the retained source';
    assert.throws(() => replay({ ...loaded, source: wrongSource }, () => true));
    assert.throws(() => replay({ ...loaded, readerPdfSourceHandle: { ...f.handle } }, () => true));
});
