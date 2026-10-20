'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child = require('node:child_process');
const bridge = require('../scripts/lib/python-json-packet-bridge.js');
const staging = require('../scripts/lib/paper-page-staging.js');
const conference = require('../scripts/lib/conference-postprocess.js');
const scripts = path.resolve(__dirname, '../scripts');
const invocation = { script: path.join(scripts, 'historical-page-render.py'),
    inputFlag: '--input-file', prefix: 'packet-bridge-test-' };
const limit = 64 * 1024 * 1024;

test('共享 packet transport 原字节经 0600 独占文件，保留 flags、继承环境和有界执行', t => {
    const packet = { title: '中文{abstract}', assets: [{ bytes: '原图' }], literal: '\\times' };
    const roots = [];
    t.mock.method(child, 'execFileSync', (program, args, options) => {
        assert.equal(program, 'bash');
        assert.equal(args[0], path.join(scripts, 'python-runtime.sh'));
        const input = args[3]; roots.push(path.dirname(input));
        assert.equal(fs.statSync(input).mode & 0o777, 0o600);
        assert.equal(fs.readFileSync(input, 'utf8'), JSON.stringify(packet));
        assert.equal(options.maxBuffer, limit);
        assert.equal(options.timeout, args[1] === path.join(scripts, 'conference-page-render.py') ? 615000 : 195000);
        assert.equal(options.killSignal, 'SIGTERM');
        assert.equal(Object.hasOwn(options, 'input'), false);
        assert.equal(options.env.PD_PUBLICATION_ERROR_FD, '3');
        assert.equal(options.stdio[3] >= 3, true);
        assert.equal(Object.hasOwn(options, 'cwd'), false);
        if (args[1].endsWith('conference-page-render.py')) {
            assert.equal(args[2], '--packet-file'); return Buffer.from('{"conference":true}');
        }
        assert.equal(args[1], invocation.script); assert.equal(args[2], '--input-file');
        return Buffer.from('{"markdown":"正文","assets":[]}');
    });
    assert.deepEqual(staging.defaultRender(packet), { markdown: '正文', assets: [] });
    assert.deepEqual(conference.render(packet), { conference: true });
    for (const root of roots) assert.equal(fs.existsSync(root), false);
});

test('固定页面预算与清理余量，其他入口和调用者覆写仍为60秒', () => {
    for (const [script, inputFlag, timeout] of [
        ['conference-page-render.py', '--packet-file', 615000],
        ['conference-page-render.py', '--input-file', 60000],
        ['historical-page-render.py', '--input-file', 195000],
        ['reader-aggregate-render.py', '--packet-file', 60000],
        ['other-conference-page-render.py', '--packet-file', 60000]
    ]) {
        bridge.runPythonJsonPacket({}, { ...invocation, script: path.join(scripts, script), inputFlag,
            timeout: 9999999 }, { execFileSync: (_program, _args, options) => {
            assert.equal(options.timeout, timeout);
            assert.equal(options.killSignal, 'SIGTERM');
            assert.equal(options.maxBuffer, limit);
            return Buffer.from('{}');
        } });
    }
});

test('原 adapter JSON/正文校验不合并；无效输出清理临时文件且不授成功', t => {
    const roots = [];
    let output = Buffer.from('{');
    t.mock.method(child, 'execFileSync', (_program, args) => {
        roots.push(path.dirname(args[3])); return output;
    });
    assert.throws(() => staging.defaultRender({}), SyntaxError);
    assert.throws(() => conference.render({}), /JSON/);
    output = Buffer.from('{"markdown":" ","assets":[]}');
    assert.throws(() => staging.defaultRender({}), /非空 Markdown/);
    output = Buffer.from('{"markdown":"正文","assets":{}}');
    assert.throws(() => staging.defaultRender({}), /资源数组/);
    output = Buffer.from('{"key":1,"key":2}');
    assert.throws(() => conference.render({}), /重复|JSON/);
    output = Buffer.from([0xff]);
    assert.throws(() => conference.render({}), /UTF|JSON/);
    for (const root of roots) assert.equal(fs.existsSync(root), false);
});

test('timeout/overflow/写入异常原样拒绝，成功与失败均清理，保持两种原清理策略', t => {
    for (const cleanup of ['strict', 'recursive']) {
        let root;
        const failure = Object.assign(new Error('execution fixture'), { code: 'ETIMEDOUT' });
        const dependencies = { execFileSync: (_program, args) => {
            root = path.dirname(args[3]); throw failure;
        } };
        for (const code of ['ETIMEDOUT', 'ENOBUFS']) {
            failure.code = code;
            assert.throws(() => bridge.runPythonJsonPacket({}, { ...invocation, cleanup }, dependencies), error => error === failure);
            assert.equal(fs.existsSync(root), false);
        }
        const calls = [];
        const io = { ...fs, unlinkSync: name => { calls.push('unlink'); fs.unlinkSync(name); },
            rmdirSync: name => { calls.push('rmdir'); fs.rmdirSync(name); },
            rmSync: (name, options) => { calls.push('rm'); fs.rmSync(name, options); } };
        bridge.runPythonJsonPacket({}, { ...invocation, cleanup }, { io, execFileSync: () => Buffer.from('{}') });
        assert.deepEqual(calls, cleanup === 'strict' ? ['unlink', 'unlink', 'rmdir'] : ['rm']);
    }
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'packet-write-failure-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const failure = new Error('write failure');
    assert.throws(() => bridge.runPythonJsonPacket({}, invocation, { tmpdir: () => directory,
        io: { ...fs, writeFileSync: () => { throw failure; } },
        execFileSync: () => assert.fail('must not execute') }), error => error === failure);
    assert.deepEqual(fs.readdirSync(directory), []);
});

test('只有真实私有FD中的固定worker超时能进入typed错误，stderr和裸字段不能冒充', () => {
    const crypto = require('node:crypto');
    const hash = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
    const renderer = path.join(scripts,'conference-page-render.py');
    const worker = 'reader-resource-claims-replay-cli.js';
    const empty = crypto.createHash('sha256').update('').digest('hex');
    const proof = {contract:'publication-local-replay-failure-v1',renderer:path.basename(renderer),
        rendererSha256:hash(renderer),worker,workerSha256:hash(path.join(scripts,'lib',worker)),
        timedOut:true,outputTruncated:false,returncode:-15,timeoutSeconds:180,
        stdoutSha256:empty,stderrSha256:empty,stdoutBytes:0,stderrBytes:0};
    for (const [channel, delta, expected] of [['private',{},true],['stderr',{},false],
        ['private',{timedOut:false},false],['private',{worker:'unknown.js'},false],
        ['private',{rendererSha256:'0'.repeat(64)},false],['private',{extra:'unknown'},false]]) {
        const error = Object.assign(new Error('fixed renderer exited'),{status:1,stderr:Buffer.from(JSON.stringify(proof)),
            localReplayTimeout:proof});
        assert.throws(() => bridge.runPythonJsonPacket({}, {script:renderer,inputFlag:'--packet-file',prefix:'typed-replay-fixture-'},
            {execFileSync:(_p,_args,options)=>{
                if(channel==='private')fs.writeSync(options.stdio[3],JSON.stringify({...proof,...delta}));
                throw error;
            }}), value=>value===error);
        assert.equal(!!bridge.getVerifiedLocalReplayTimeout(error),expected);
        assert.equal(error.code,undefined);
    }
    assert.equal(bridge.getVerifiedLocalReplayTimeout(Object.assign(new Error(),{localReplayTimeout:proof})),null);
});

test('跨语言固定预算按单次合并冷核及实际汇总槽位闭合，不读取调用方timeout', () => {
    const paper={conferenceSourceCorrection:{contract:'conference-source-resource-correction-v1'}};
    assert.equal(bridge.renderTimeout({paper},path.join(scripts,'conference-page-render.py'),'--packet-file'),735000);
    assert.equal(bridge.renderTimeout({paper},path.join(scripts,'historical-page-render.py'),'--input-file'),735000);
    assert.equal(bridge.renderTimeout({aggregatePresentationBatch:[{paper},{paper:{}}]},
        path.join(scripts,'conference-page-render.py'),'--packet-file'),765000);
});

test('Python实际总期限协议独立于内层Node超时，必须由私有FD和真实退出码闭合',()=>{
    const crypto=require('node:crypto');const script=path.join(scripts,'conference-page-render.py');
    const proof={contract:'publication-fixed-render-deadline-v1',renderer:path.basename(script),
        rendererSha256:crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex'),
        signal:'SIGALRM',timeoutSeconds:600};
    for(const [delta,status,accepted] of [[{},1,true],[{},2,false],[{signal:'SIGTERM'},1,false],
        [{timeoutSeconds:1},1,false],[{extra:true},1,false]]) {
        const error=Object.assign(new Error('renderer stopped'),{status});
        assert.throws(()=>bridge.runPythonJsonPacket({}, {script,inputFlag:'--packet-file',prefix:'deadline-bridge-fixture-'},
            {execFileSync:(_p,_a,options)=>{fs.writeSync(options.stdio[3],JSON.stringify({...proof,...delta}));throw error;}}),e=>e===error);
        const actual=bridge.getVerifiedLocalReplayTimeout(error);assert.equal(!!actual,accepted);
        if(actual)assert.deepEqual(actual,{...proof,returncode:1});
    }
});

test('packet 输入大小按 UTF-8 字节有界；有效大包不裁剪，超限和循环在创建前拒绝', () => {
    // 9 MiB UTF-8 的完整 JSON 字节路径，远大于一般无图片 packet。
    const large = { body: '汉'.repeat(3 * 1024 * 1024) };
    let calls = 0;
    bridge.runPythonJsonPacket(large, invocation, { execFileSync: (_program, args) => {
        calls++;
        assert.equal(fs.readFileSync(args[3], 'utf8'), JSON.stringify(large));
        return Buffer.from('{}');
    } });
    assert.equal(calls, 1);
    const rendered = staging.defaultRender(large, { execFileSync: () =>
        Buffer.from(JSON.stringify({ markdown: large.body, assets: [] })) });
    assert.equal(rendered.markdown, large.body);
    const noIo = { io: { mkdtempSync: () => assert.fail('must reject before creating a directory') },
        execFileSync: () => assert.fail('must not execute') };
    assert.throws(() => bridge.runPythonJsonPacket({ body: 'x'.repeat(limit) }, invocation, noIo), /64 MiB input/);
    const circular = {}; circular.self = circular;
    assert.throws(() => bridge.runPythonJsonPacket(circular, invocation, noIo), /circular/i);
});

test('沙箱/调用配置在临时写入前拒绝；私有桥不替代工作流权限校验', t => {
    const guard = require('../scripts/env-loader.js');
    const failure = new Error('external runtime required');
    const mocked = t.mock.method(guard, 'requireExternalRuntime', () => { throw failure; });
    assert.throws(() => bridge.runPythonJsonPacket({}, invocation, {
        io: { mkdtempSync: () => assert.fail('must not write') }
    }), error => error === failure);
    mocked.mock.restore();
    for (const changed of [{ script: '/tmp/other.py' }, { inputFlag: '--unsafe' },
        { prefix: '../escape-' }, { cleanup: 'none' }]) {
        assert.throws(() => bridge.runPythonJsonPacket({}, { ...invocation, ...changed }), /private Python packet/);
    }
});

test('两条生产实现闭包自动包含共享 transport 与实际 Python runtime', () => {
    const historical = staging.rendererImplementationFiles();
    const conferenceFiles = require('../scripts/lib/workflow-implementation-files.js').collectWorkflowImplementationFiles({
        root: path.resolve(__dirname, '..'), entryFiles: ['scripts/lib/conference-postprocess.js']
    });
    for (const files of [historical, conferenceFiles]) {
        assert.ok(files.includes('scripts/lib/python-json-packet-bridge.js'));
        assert.ok(files.includes('scripts/python-runtime.sh'));
        assert.ok(files.includes('scripts/env-loader.js'));
    }
});
