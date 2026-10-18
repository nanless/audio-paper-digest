'use strict';
// Private transport only: each adapter still owns its packet and output checks.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const child = require('node:child_process');
const scripts = path.resolve(__dirname, '..');
const MAX_PACKET_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 60 * 1000;
const CONFERENCE_RENDER_TIMEOUT_MS = 600 * 1000;
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
    const timeout = script === path.join(scripts, 'conference-page-render.py') && inputFlag === '--packet-file'
        ? CONFERENCE_RENDER_TIMEOUT_MS : TIMEOUT_MS;
    try {
        io.writeFileSync(inputFile, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        const output = execute('bash', [path.join(scripts, 'python-runtime.sh'), script, inputFlag, inputFile], {
            maxBuffer: MAX_PACKET_BYTES, timeout, killSignal: 'SIGKILL'
        });
        if (Buffer.byteLength(output) > MAX_PACKET_BYTES) throw new Error('Python JSON packet exceeds 64 MiB output limit');
        return output;
    } finally {
        if (cleanup === 'recursive') io.rmSync(temporary, { recursive: true, force: true });
        else {
            try { io.unlinkSync(inputFile); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            io.rmdirSync(temporary);
        }
    }
}
module.exports = { runPythonJsonPacket };
