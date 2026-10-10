'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const child = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');
const assert = require('node:assert/strict');
const projectRoot=process.argv[1],kind=process.argv[2],swap=process.argv[3]==='swap';
const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'reader-public-data-')));
console.log(JSON.stringify({temp}));
let target,call;
if(kind==='tag') {
    const api=require(path.join(projectRoot,'scripts/tag-record-update.js'));
    target=path.join(temp,'state.json');
    fs.writeFileSync(target,'{"fixture":true}\n',{mode:0o600});
    call=()=>api.readProcessJson(target);
}
else {
    const discovery=require(path.join(projectRoot,'scripts/lib/conference-discovery.js')),api=require(path.join(projectRoot,'scripts/lib/conference-filter-evidence.js'));
    const source=path.join(temp,'source'),runs=path.join(temp,'runs');
    fs.mkdirSync(source);
    fs.mkdirSync(runs);
    fs.mkdirSync(path.join(source,'pdfs'));
    fs.writeFileSync(path.join(source,'pdfs/a.pdf'),'%PDF-1.4\nsynthetic\n',{mode:0o600});
    const metadata=path.join(source,'metadata.json');
    fs.writeFileSync(metadata,JSON.stringify({
        conference: { id: 'fixture-2026', year: 2026 },
        papers: [{
            id: 'a', title: 'One', authors: ['Author'], abstract: '',
            pdfFile: 'pdfs/a.pdf', recordUrl: 'https://example.org/a',
            pdfUrl: 'https://example.org/a.pdf', doi: null, track: null
        }]
    }),{mode:0o600});
    const found=discovery.discoverConference({adapter:'official-proceedings',conferenceId:'fixture-2026',year:2026,metadataFile:metadata,pdfRoot:source});
    const catalog=path.join(temp,'catalog.json'),report=path.join(temp,'report.json');
    fs.writeFileSync(catalog,discovery.canonicalBytes(found.manifest),{mode:0o600});
    fs.writeFileSync(report,discovery.canonicalBytes(found.report),{mode:0o600});
    const handle=discovery.loadDiscoveryHandle(catalog,report);
    const id='11111111-1111-4111-8111-111111111111',run=path.join(runs,id);
    fs.mkdirSync(run);
    target=path.join(run,'state.json');
    fs.writeFileSync(target,JSON.stringify(api.initialState(discovery.discoveryHandleSnapshot(handle),id)),{mode:0o600});
    call=()=>api.inspectEvidence({evidenceRunsRoot:runs,runId:id,discoveryHandle:handle});
}
const original=fs.readFileSync(target),saved=target+'.saved',open=fs.openSync;
let swapped=false;
fs.openSync=function(name,...args) {
    if(swap&&name===target&&!swapped) {
        swapped=true;
        fs.renameSync(target,saved);
        childProcess.execFileSync('mkfifo',[target]);
        fs.chmodSync(target,0o600);
    }return open.call(this,name,...args)};
let error,value;
try {
    value=call();
}
catch(errorFromRead) {
    error=errorFromRead;
}
finally {
    fs.openSync=open;
}
if(swap) {
    assert(error);
    assert.match(error.message,kind==='tag'?/^会议进程文件不安全：打开后发现不是普通文件：/:/changed while opening/);
    assert(fs.lstatSync(target).isFIFO());
    assert.deepEqual(fs.readFileSync(saved),original);
}
else {
    assert.equal(error,undefined);
    assert.deepEqual(fs.readFileSync(target),original);
    assert.equal(kind==='tag'?value.fixture:value.status,kind==='tag'?true:'pending');
}
console.log(JSON.stringify({kind,swapped,error:error?.message||null}));
`;

for (const kind of ['tag', 'evidence']) {
    for (const mode of ['normal', 'swap']) {
        const title = (kind === 'tag' ? '标签更新进程读取' : '会议筛选来源检查')
            + (mode === 'normal' ? '接受正常文件' : '拒绝检查后换成无写入方管道');
        test(title, t => {
            if (mode === 'swap' && process.platform === 'win32') {
                return t.skip('本用例需要系统支持命名管道');
            }
            const result = childProcess.spawnSync(process.execPath,
                ['-e', child, path.resolve(__dirname, '..'), kind, mode],
                { encoding: 'utf8', timeout: 5000 });
            const firstLine = result.stdout.split('\n')[0];
            if (firstLine) {
                const { temp } = JSON.parse(firstLine);
                t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
            }
            assert.equal(result.error, undefined, '公开读取入口不能等待管道写入');
            assert.equal(result.status, 0, result.stderr);
        });
    }
}
