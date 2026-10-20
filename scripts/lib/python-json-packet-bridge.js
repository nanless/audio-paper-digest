'use strict';
// Private transport only: each adapter still owns its packet and output checks.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const child = require('node:child_process');
const crypto = require('node:crypto');
const policy = require('../publication_replay_policy.json');
const localReplayFailures = new WeakMap();
const scripts = path.resolve(__dirname, '..');
const MAX_PACKET_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 60 * 1000;
function sourceReplay(paper) {
    return paper && (['conference-source-resource-correction-v1','conference-source-core-correction-v1']
        .includes(paper.conferenceSourceCorrection?.contract)
        || (paper.apiReaderPlan?.tableBindings || []).some(b => b && Object.hasOwn(b,'authenticatedPdfTableEvidence'))
        || (paper.apiReaderResources?.resources || []).some(r => r && Object.hasOwn(r,'authenticatedPdfFootnoteEvidence')));
}
function renderTimeout(packet, script, flag) {
    const conference = script === path.join(scripts, 'conference-page-render.py') && flag === '--packet-file';
    const history = script === path.join(scripts, 'historical-page-render.py') && flag === '--input-file';
    if (!conference && !history) return TIMEOUT_MS;
    let seconds = conference ? policy.ordinaryConferenceSeconds : policy.ordinaryHistorySeconds;
    const records = packet?.aggregatePresentationBatch;
    if (conference && Array.isArray(records) && records.length >= 1 && records.length <= policy.maxAggregatePapers) {
        seconds = policy.renderOverheadSeconds + records.reduce((total,r) => total
            + (sourceReplay(r?.paper) ? policy.sourceReplaySeconds : policy.simpleReplaySeconds),0);
    } else if (sourceReplay(packet?.paper)) seconds = policy.sourceReplaySeconds + policy.renderOverheadSeconds;
    return (seconds + policy.transportGraceSeconds) * 1000;
}
function getVerifiedLocalReplayTimeout(error) { return localReplayFailures.get(error) || null; }
function runPythonJsonPacket(packet, { script, inputFlag, prefix, cleanup = 'strict' }, dependencies = {}) {
    require('../env-loader').requireExternalRuntime('python-json-packet-bridge');
    if (!path.isAbsolute(script) || path.dirname(script) !== scripts || !script.endsWith('.py')
        || !/^--[a-z-]+-file$/.test(inputFlag) || !/^[a-z0-9-]+-$/.test(prefix)
        || !['strict', 'recursive'].includes(cleanup)) throw new TypeError('Invalid private Python packet invocation');
    const bytes = JSON.stringify(packet);
    if (Buffer.byteLength(bytes) > MAX_PACKET_BYTES) throw new Error('Python JSON packet exceeds 64 MiB input limit');
    const io = dependencies.io || fs, execute = dependencies.execFileSync || child.execFileSync;
    const temporaryRoot = dependencies.tmpdir?.() || fs.realpathSync(os.tmpdir());
    const temporary = io.mkdtempSync(path.join(temporaryRoot, prefix));
    const inputFile = path.join(temporary, 'packet.json');
    // Conference rendering can run several independently bounded, read-only source replays.
    const timeout = renderTimeout(packet, script, inputFlag);
    let errorFd;
    const errorFile = path.join(temporary, 'failure.json');
    try {
        io.writeFileSync(inputFile, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        errorFd = io.openSync(errorFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
        let output;
        try {
            output = execute('bash', [path.join(scripts, 'python-runtime.sh'), script, inputFlag, inputFile], {
                maxBuffer: MAX_PACKET_BYTES, timeout, killSignal: 'SIGTERM',
                env: { ...process.env, PD_PUBLICATION_ERROR_FD: '3' }, stdio: ['ignore','pipe','pipe',errorFd]
            });
        } catch (error) {
            const stat = io.fstatSync(errorFd);
            if (stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && stat.size > 0 && stat.size <= 4096) {
                let proof;
                try { const raw = Buffer.alloc(stat.size); io.readSync(errorFd,raw,0,raw.length,0);
                    proof = JSON.parse(raw.toString('utf8')); } catch {}
                const hash = name => crypto.createHash('sha256').update(io.readFileSync(name)).digest('hex');
                const allowed = ['reader-resource-claims-replay-cli.js','core-summary-semantic-replay-cli.js'];
                const fixedRenderer = ['conference-page-render.py','historical-page-render.py']
                    .some(name => script === path.join(scripts,name));
                if (proof?.contract === 'publication-fixed-render-deadline-v1' && fixedRenderer
                    && Object.keys(proof).sort().join(',') === 'contract,renderer,rendererSha256,signal,timeoutSeconds'
                    && proof.renderer === path.basename(script) && proof.rendererSha256 === hash(script)
                    && proof.signal === 'SIGALRM' && proof.timeoutSeconds === timeout / 1000 - policy.transportGraceSeconds
                    && error.status === 1 && !error.signal) {
                    localReplayFailures.set(error,Object.freeze({...proof,returncode:error.status}));
                }
                if (proof?.contract === 'publication-local-replay-failure-v1' && proof.renderer === path.basename(script)
                    && Object.keys(proof).sort().join(',') === ['contract','renderer','rendererSha256','worker','workerSha256',
                        'timedOut','outputTruncated','returncode','timeoutSeconds','stdoutSha256','stderrSha256',
                        'stdoutBytes','stderrBytes'].sort().join(',')
                    && fixedRenderer
                    && proof.rendererSha256 === hash(script) && allowed.includes(proof.worker)
                    && proof.workerSha256 === hash(path.join(scripts,'lib',proof.worker))
                    && proof.timedOut === true && proof.outputTruncated === false
                    && [30,180,policy.sourceReplaySeconds].includes(proof.timeoutSeconds)
                    && Number.isInteger(proof.returncode) && proof.returncode !== 0
                    && ['stdoutSha256','stderrSha256'].every(k => /^[a-f0-9]{64}$/u.test(proof[k] || ''))
                    && ['stdoutBytes','stderrBytes'].every(k => Number.isSafeInteger(proof[k]) && proof[k] >= 0)) {
                    localReplayFailures.set(error,Object.freeze({...proof}));
                }
            }
            throw error;
        }
        if (Buffer.byteLength(output) > MAX_PACKET_BYTES) throw new Error('Python JSON packet exceeds 64 MiB output limit');
        return output;
    } finally {
        if (errorFd !== undefined) io.closeSync(errorFd);
        if (cleanup === 'recursive') io.rmSync(temporary, { recursive: true, force: true });
        else {
            try { io.unlinkSync(errorFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            try { io.unlinkSync(inputFile); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            io.rmdirSync(temporary);
        }
    }
}
module.exports = { runPythonJsonPacket, getVerifiedLocalReplayTimeout, renderTimeout };
