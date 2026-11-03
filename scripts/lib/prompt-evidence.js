'use strict';

// Current writing reads the checkout. Retired templates are immutable Git
// evidence, never recreated as files and never fetched from the network.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readRegularBytes, readGitBlob } = require('./git-file-bytes');
const { CURRENT_PROMPT_FILES } = require('./prompt-contracts');
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const LIMIT = 8 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PROMPT = /^(?:prompts|manual\/prompts)\/[A-Za-z0-9_/-]+\.md$/;
const indexCache = new Map();

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function controlledPath(relative) {
    if (typeof relative !== 'string' || !PROMPT.test(relative)
        || relative.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('Prompt evidence path is outside the registered prompt namespace');
    }
    return relative;
}
function readPlain(filename) {
    return readRegularBytes(filename);
}
function loadIndex(root) {
    const filename = path.join(root, 'scripts/lib/git-prompt-evidence-index.json');
    if (fs.realpathSync(filename) !== filename) throw new Error('Prompt evidence forbids symlink index paths');
    const stat = fs.lstatSync(filename, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(LIMIT)) throw new Error('Unsafe Prompt evidence index');
    const signature = [stat.dev, stat.ino, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    const cached = indexCache.get(filename);
    if (cached?.signature === signature) return cached.index;
    const { strictJson } = require('./publication-file-primitives');
    const bytes = readPlain(filename);
    const index = strictJson(bytes, 'Git Prompt evidence index');
    const protocol = require('./protocol-codec.js');
    const validHeader = protocol.hasValidHeader(index, 'git-prompt-evidence');
    if (!validHeader
        || !OID.test(index.provenanceCommit || '') || !index.retiredPaths || !index.blobs
        || Array.isArray(index.retiredPaths) || Array.isArray(index.blobs)) throw new Error('Invalid Git Prompt evidence index');
    for (const [relative, sha] of Object.entries(index.retiredPaths)) {
        controlledPath(relative);
        if (!SHA.test(sha) || !index.blobs[sha]?.paths?.includes(relative)) throw new Error('Retired Prompt path lacks its original Git evidence');
    }
    for (const [sha, blob] of Object.entries(index.blobs)) {
        if (!SHA.test(sha) || !OID.test(blob?.blobOid || '') || !Array.isArray(blob.paths)
            || !blob.paths.length || new Set(blob.paths).size !== blob.paths.length) throw new Error('Invalid Git Prompt blob identity');
        blob.paths.forEach(controlledPath);
    }
    indexCache.set(filename, { signature, index, sha256: sha256(bytes) });
    return index;
}
function promptEvidenceIndexFingerprint({ root = PROJECT_ROOT } = {}) {
    const base = fs.realpathSync(root);
    loadIndex(base);
    return indexCache.get(path.join(base, 'scripts/lib/git-prompt-evidence-index.json')).sha256;
}
function readBlob(root, blob, sha) {
    return readGitBlob(root, blob.blobOid, sha);
}
function historicalPromptEvidenceBytesForSha256(sha, { root = PROJECT_ROOT, relativePath = null } = {}) {
    if (!SHA.test(String(sha || ''))) return null;
    const base = fs.realpathSync(root);
    const index = loadIndex(base);
    const blob = index.blobs[sha];
    if (!blob || (relativePath !== null && !blob.paths.includes(controlledPath(relativePath)))) return null;
    return readBlob(base, blob, sha);
}
function listHistoricalPromptEvidence({ root = PROJECT_ROOT } = {}) {
    return Object.entries(loadIndex(fs.realpathSync(root)).blobs)
        .map(([sha256, blob]) => ({ sha256, blobOid: blob.blobOid, paths: [...blob.paths] }));
}
function readPromptEvidenceBytes(relativePath, { expectedSha256 = null, root = PROJECT_ROOT } = {}) {
    const relative = controlledPath(relativePath);
    const base = fs.realpathSync(root);
    if (expectedSha256 !== null && !SHA.test(String(expectedSha256))) throw new Error('Invalid declared Prompt SHA256');
    let bytes;
    if (CURRENT_PROMPT_FILES.includes(relative)) {
        // Missing or modified current files must fail, never fall back to Git.
        bytes = readPlain(path.join(base, relative));
    } else {
        const index = loadIndex(base);
        const sha = expectedSha256 || index.retiredPaths[relative];
        const blob = sha && index.blobs[sha];
        if (!index.retiredPaths[relative] || !blob?.paths.includes(relative)) throw new Error('Unregistered retired Prompt evidence path or SHA256');
        bytes = readBlob(base, blob, sha);
    }
    if (expectedSha256 !== null && sha256(bytes) !== expectedSha256) throw new Error('Prompt bytes do not match the declared SHA256');
    return bytes;
}
// Explicit original-byte evidence for an already bound request. This does not
// select a writing scope or authorize retries. Current files must remain safe;
// their changed contents cannot replace a declared original Git blob.
function readDeclaredPromptEvidenceBytes(relativePath, expectedSha256, { root = PROJECT_ROOT } = {}) {
    const relative = controlledPath(relativePath), base = fs.realpathSync(root);
    if (typeof expectedSha256 !== 'string' || !SHA.test(expectedSha256)) throw new Error('Invalid original Prompt SHA256');
    if (CURRENT_PROMPT_FILES.includes(relative)) {
        const current = readPlain(path.join(base, relative));
        if (sha256(current) === expectedSha256) return current;
    }
    const bytes = historicalPromptEvidenceBytesForSha256(expectedSha256, { root: base, relativePath: relative });
    if (!bytes) throw new Error('Original Prompt path/SHA256 is not registered');
    return bytes;
}

// Evidence lookup only: this neither installs a Prompt declaration nor changes
// current writing. Authenticated paid-replay scopes still own that authority.
function declaredPromptTemplateEvidence(relativePath, templateSha256, { root = PROJECT_ROOT } = {}) {
    const relative = controlledPath(relativePath), base = fs.realpathSync(root);
    if (!SHA.test(String(templateSha256 || ''))) throw new Error('Invalid declared Prompt template SHA256');
    const index = loadIndex(base), current = CURRENT_PROMPT_FILES.includes(relative);
    const registered = Object.entries(index.blobs).filter(([, blob]) => blob.paths.includes(relative));
    if (!current && !index.retiredPaths[relative] && !registered.length) return null;
    const candidates = new Map(), match = bytes => {
        if (require('./prompt-history').promptTemplateSha256(bytes.toString('utf8')) === templateSha256)
            candidates.set(sha256(bytes), Buffer.from(bytes));
    };
    // A missing/unsafe current file is still an error. Historical declarations
    // can select original registered bytes, never hide a broken current path.
    if (current || index.retiredPaths[relative]) match(readPromptEvidenceBytes(relative, { root: base }));
    for (const [wholeSha256, blob] of registered) match(readBlob(base, blob, wholeSha256));
    if (!candidates.size) return null;
    if (candidates.size !== 1) throw new Error('Declared Prompt template has ambiguous registered whole-file evidence');
    const [fileSha256, bytes] = candidates.entries().next().value;
    return { path: relative, fileSha256, templateSha256, bytes };
}
function declaredStagePromptTemplateEvidence(stage, templateSha256, options = {}) {
    const versions = require('./prompt-contracts'), matches = [];
    for (const contract of require('./prompt-legacy-codec').legacyDeclarations(stage)) {
        let relative; try { relative = versions.promptFilePathForContract(stage, contract); } catch { continue; }
        const evidence = declaredPromptTemplateEvidence(relative, templateSha256, options);
        if (evidence) matches.push({ ...evidence, contract });
    }
    if (matches.length > 1) throw new Error('Declared Prompt stage/template identity is ambiguous');
    if (matches.length) return matches[0];
    let current;
    try { current = versions.currentTextStagePromptPath(stage); } catch { return null; }
    const evidence = declaredPromptTemplateEvidence(current, templateSha256, options);
    return evidence ? { ...evidence, contract: versions.CURRENT_PROMPT_CONTRACT } : null;
}

module.exports = { readPromptEvidenceBytes, readDeclaredPromptEvidenceBytes, historicalPromptEvidenceBytesForSha256,
    listHistoricalPromptEvidence, promptEvidenceIndexFingerprint,
    declaredPromptTemplateEvidence, declaredStagePromptTemplateEvidence };
