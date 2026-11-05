'use strict';

// Read-only bridge for callers that need the same implementation closure the
// Node workflows fingerprint. The only input channel is an inherited private
// descriptor, and the collector only reads project files; no scanned module is
// executed, so this worker cannot reach models, the network, or runtime data.
const fs = require('node:fs');
const path = require('node:path');
const { collectWorkflowImplementationFiles } = require('./workflow-implementation-files.js');

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_ENTRY_FILES = 64;

function readRequest() {
    const raw = process.argv[2];
    const fd = Number(raw);
    if (process.argv.length !== 3 || !/^\d+$/.test(raw || '')
        || !Number.isSafeInteger(fd) || fd < 3) {
        throw new Error('A private request descriptor is required');
    }
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600
        || stat.size < 2 || stat.size > MAX_INPUT_BYTES) {
        throw new Error('The request descriptor is not a bounded private file');
    }
    const request = JSON.parse(fs.readFileSync(fd, 'utf8'));
    const keys = request && typeof request === 'object' && !Array.isArray(request)
        ? Object.keys(request).sort().join(',') : '';
    if (keys !== 'entryFiles,root') {
        throw new Error('The request must contain exactly a project root and entry files');
    }
    if (typeof request.root !== 'string' || !path.isAbsolute(request.root)) {
        throw new Error('The project root must be an absolute path');
    }
    const root = fs.realpathSync(request.root);
    if (!fs.lstatSync(root).isDirectory()) {
        throw new Error('The project root must be a directory');
    }
    if (!Array.isArray(request.entryFiles) || request.entryFiles.length < 1
        || request.entryFiles.length > MAX_ENTRY_FILES) {
        throw new Error('Entry files must be a non-empty bounded list');
    }
    const entryFiles = request.entryFiles.map(entry => {
        if (typeof entry !== 'string' || !entry || entry.includes('\0')
            || path.isAbsolute(entry)
            || entry.split(/[\\/]/).includes('..')) {
            throw new Error('Entry files must be project-relative paths');
        }
        return entry;
    });
    return { root, entryFiles };
}

try {
    const { root, entryFiles } = readRequest();
    const files = collectWorkflowImplementationFiles({ root, entryFiles });
    const bytes = Buffer.from(JSON.stringify({ files }), 'utf8');
    if (bytes.length > MAX_OUTPUT_BYTES) {
        throw new Error('The dependency closure is unexpectedly large');
    }
    fs.writeSync(1, bytes);
} catch (error) {
    fs.writeSync(2, String(error && error.message ? error.message : error));
    process.exitCode = 1;
}
