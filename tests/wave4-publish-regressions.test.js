'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

test('D-H2: conference-postprocess.js repairCaptionQuotedGlossLinks 支持 v4 冒号图注格式', () => {
    const { repairPreservedPage } = require('../scripts/lib/conference-postprocess');
    const v4 = '*论文图 3：Vowel [i](“ee”) spectral contour（原论文 Figure 3）。*\n';
    const out = repairPreservedPage(v4);
    assert.match(out, /&#91;i&#93;\(“ee”\)/);
    assert.match(out, /^\*论文图 3：/);
});

test('D-M4: verify-web parseDeployRuns/verifyWorkflowSource/waitForDeploy/deployExitCode 严格标记并阻断 run_ambiguous', async () => {
    const verifyWeb = require('../scripts/verify-web');
    const OID = 'a'.repeat(40);
    const twoRuns = [
        { headSha: OID, status: 'completed', conclusion: 'success', workflowName: 'Deploy Hugo to Pages', event: 'push', databaseId: 101 },
        { headSha: OID, status: 'completed', conclusion: 'success', workflowName: 'Deploy Hugo to Pages', event: 'push', databaseId: 102 }
    ];
    const parsed = verifyWeb.parseDeployRuns(twoRuns, OID);
    assert.equal(parsed.ambiguous, true);
    assert.equal(parsed.code, 'run_ambiguous');
    assert.equal(parsed.runId, undefined);
    assert.deepEqual(parsed.matchedRunIds, [101, 102]);
    assert.equal(verifyWeb.deployExitCode(parsed), 1);
    assert.equal(verifyWeb.deployExitCode(parsed, { allowDegraded: true }), 1);

    const wf = verifyWeb.verifyWorkflowSource(OID, {
        run: parsed,
        spawnSync: () => { throw new Error('ambiguous run must fail immediately without gh calls'); }
    });
    assert.equal(wf.verified, false);
    assert.equal(wf.code, 'run_ambiguous');

    // waitForDeploy 遇到 run_ambiguous 必须立即停止，不得继续轮询等待
    let pollCalls = 0;
    let sleepCalls = 0;
    const waited = await verifyWeb.waitForDeploy(OID, {
        waitSeconds: 60,
        pollIntervalMs: 1000,
        sleep: async () => { sleepCalls += 1; },
        spawnSync: () => {
            pollCalls += 1;
            return { status: 0, stdout: JSON.stringify(twoRuns), stderr: '' };
        }
    });
    assert.equal(pollCalls, 1);
    assert.equal(sleepCalls, 0);
    assert.equal(waited.deploy.ambiguous, true);
    assert.equal(waited.deploy.code, 'run_ambiguous');
    assert.equal(waited.snapshots.length, 1);
});

test('D-C1 & D-H5: reader-inline-svg.js 拒绝 CDATA/注释/DTD 并对超大输出安全中止进程而不触发 PID 复杀', async () => {
    const { EventEmitter } = require('node:events');
    const inlineSvg = require('../scripts/lib/reader-inline-svg');
    const cdata = '<svg id="f1" width="10" height="10" viewBox="0 0 10 10"><text><![CDATA[x]]></text></svg>';
    const comment = '<svg id="f1" width="10" height="10" viewBox="0 0 10 10"><!-- x --><text>y</text></svg>';
    const elementDecl = '<!ELEMENT foo EMPTY><svg id="f1" width="10" height="10" viewBox="0 0 10 10"><text>y</text></svg>';
    for (const body of [cdata, comment, elementDecl]) {
        const buf = Buffer.from(body, 'utf8');
        const sha = crypto.createHash('sha256').update(buf).digest('hex');
        assert.equal(
            inlineSvg.inlineSvgSourceDescriptor({
                kind: 'inline_svg',
                mediaType: 'image/svg+xml',
                inlineSvg: body,
                inlineSvgBytes: buf.length,
                inlineSvgSha256: sha
            }, '2611.00001'),
            null
        );
    }

    // 1. 真实子进程验证：HTML5 breakout 标签被严格拒绝
    const badSvg = '<svg id="f1" width="10" height="10" viewBox="0 0 10 10"><p>breakout</p></svg>';
    const badBuf = Buffer.from(badSvg, 'utf8');
    await assert.rejects(
        () => inlineSvg.renderOfficialInlineSvg({
            kind: 'inline_svg',
            mediaType: 'image/svg+xml',
            inlineSvg: badSvg,
            inlineSvgBytes: badBuf.length,
            inlineSvgSha256: crypto.createHash('sha256').update(badBuf).digest('hex')
        }),
        err => err && err.code === 'READER_INLINE_SVG_INTEGRITY'
    );

    // 2. 注入受控子进程直接覆盖 MAX_OUTPUT_BYTES 超限中止（kill(-pid, SIGKILL)）与流销毁
    const goodSvg = '<svg id="f1" width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
    const goodBuf = Buffer.from(goodSvg, 'utf8');
    const goodResource = {
        kind: 'inline_svg',
        mediaType: 'image/svg+xml',
        inlineSvg: goodSvg,
        inlineSvgBytes: goodBuf.length,
        inlineSvgSha256: crypto.createHash('sha256').update(goodBuf).digest('hex')
    };
    const makeFakeChild = (pid) => {
        const child = new EventEmitter();
        child.pid = pid;
        child.exitCode = null;
        child.signalCode = null;
        child.destroyed = { stdin: false, stdout: false, stderr: false };
        child.stdin = new EventEmitter();
        child.stdin.destroy = () => { child.destroyed.stdin = true; };
        child.stdin.end = () => {};
        child.stdout = new EventEmitter();
        child.stdout.destroy = () => { child.destroyed.stdout = true; };
        child.stderr = new EventEmitter();
        child.stderr.destroy = () => { child.destroyed.stderr = true; };
        child.killCalls = [];
        child.kill = sig => { child.killCalls.push(sig); };
        return child;
    };

    const killCallsAlive = [];
    let aliveChild;
    await assert.rejects(
        () => inlineSvg.renderOfficialInlineSvg(goodResource, {
            maxOutputBytes: 16,
            kill: (targetPid, sig) => { killCallsAlive.push([targetPid, sig]); },
            spawn: () => {
                aliveChild = makeFakeChild(42424);
                aliveChild.stdin.end = () => {
                    queueMicrotask(() => {
                        aliveChild.stdout.emit('data', Buffer.alloc(32, 0x41));
                        aliveChild.emit('close', null);
                    });
                };
                return aliveChild;
            }
        }),
        err => err && err.code === 'READER_INLINE_SVG_INTEGRITY'
    );
    assert.deepEqual(killCallsAlive, [[-42424, 'SIGKILL']], '存活子进程超限时必须对进程组发送 SIGKILL');
    assert.deepEqual(aliveChild.destroyed, { stdin: true, stdout: true, stderr: true }, '超限中止必须销毁全部流');

    // 3. 验证 PID 复杀防护：子进程已 exit 后触发超限/超时不得调用 process.kill(-pid, SIGKILL)
    const killCallsExited = [];
    let exitedChild;
    await assert.rejects(
        () => inlineSvg.renderOfficialInlineSvg(goodResource, {
            maxOutputBytes: 16,
            kill: (targetPid, sig) => { killCallsExited.push([targetPid, sig]); },
            spawn: () => {
                exitedChild = makeFakeChild(51515);
                exitedChild.stdin.end = () => {
                    queueMicrotask(() => {
                        exitedChild.exitCode = 0;
                        exitedChild.emit('exit', 0, null);
                        exitedChild.stdout.emit('data', Buffer.alloc(32, 0x42));
                        exitedChild.emit('close', 0);
                    });
                };
                return exitedChild;
            }
        }),
        err => err && err.code === 'READER_INLINE_SVG_INTEGRITY'
    );
    assert.deepEqual(killCallsExited, [], '已退出的子进程不得再次发送 SIGKILL 以免误杀复用 PID');
    assert.deepEqual(exitedChild.killCalls, [], '已退出的子进程不得回退调用 child.kill');
});
