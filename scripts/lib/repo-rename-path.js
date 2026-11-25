'use strict';

const path = require('node:path');

const OLD_REPO_DIRNAME = 'audio-paper-digest';
const NEW_REPO_DIRNAME = 'audio-research-workbench';

function isNormalizedAbsolutePath(value) {
    return typeof value === 'string' && value.length > 0 && path.isAbsolute(value) && path.resolve(value) === value;
}

/**
 * Returns true if recordedPath equals expectedCurrentPath, OR differs from it
 * strictly in one directory segment where the repository was renamed from
 * `audio-paper-digest` to `audio-research-workbench` (and never accepts `..`
 * or unrelated foreign directories).
 */
function matchesRelocatedRepoPath(recordedPath, expectedCurrentPath) {
    if (typeof recordedPath !== 'string' || typeof expectedCurrentPath !== 'string') return false;
    const expected = path.resolve(expectedCurrentPath);
    if (!isNormalizedAbsolutePath(recordedPath)) {
        // Still allow callers passing unnormalized identical paths when exact resolve matches
        if (path.resolve(recordedPath) === expected && !recordedPath.split(/[\\/]/).includes('..')) {
            return true;
        }
        return false;
    }
    if (recordedPath === expected) return true;
    const recParts = recordedPath.split(path.sep);
    const curParts = expected.split(path.sep);
    if (recParts.length !== curParts.length) return false;
    let diffIndex = -1;
    for (let i = 0; i < recParts.length; i += 1) {
        if (recParts[i] !== curParts[i]) {
            if (diffIndex !== -1) return false;
            diffIndex = i;
        }
    }
    return diffIndex !== -1
        && recParts[diffIndex] === OLD_REPO_DIRNAME
        && curParts[diffIndex] === NEW_REPO_DIRNAME;
}

/**
 * Resolves recordedPath within currentRoot, allowing either:
 * 1. An existing path strictly inside currentRoot (no `..` traversal), OR
 * 2. A pre-rename absolute path that becomes strictly inside currentRoot
 *    after replacing strictly ONE directory segment `audio-paper-digest`
 *    with `audio-research-workbench` at the matching segment index of currentRoot.
 *
 * Returns the normalized absolute path inside currentRoot, or null if outside.
 */
function relocatePathWithinRoot(recordedPath, currentRoot) {
    if (typeof recordedPath !== 'string' || typeof currentRoot !== 'string'
        || !recordedPath || !currentRoot || !path.isAbsolute(recordedPath)) return null;
    if (recordedPath.split(/[\\/]/).includes('..')) return null;
    const root = path.resolve(currentRoot);
    const direct = path.resolve(recordedPath);
    const directRel = path.relative(root, direct);
    if (directRel && !directRel.startsWith('..') && !path.isAbsolute(directRel)) {
        return direct;
    }
    const rootParts = root.split(path.sep);
    const recParts = direct.split(path.sep);
    if (recParts.length <= rootParts.length) return null;
    let diffIndex = -1;
    for (let i = 0; i < rootParts.length; i += 1) {
        if (recParts[i] !== rootParts[i]) {
            if (diffIndex !== -1) return null;
            if (recParts[i] !== OLD_REPO_DIRNAME || rootParts[i] !== NEW_REPO_DIRNAME) return null;
            diffIndex = i;
        }
    }
    if (diffIndex === -1) return null;
    const relocatedParts = [...recParts];
    relocatedParts[diffIndex] = NEW_REPO_DIRNAME;
    const relocated = relocatedParts.join(path.sep);
    if (path.resolve(relocated) !== relocated) return null;
    const rel = path.relative(root, relocated);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return relocated;
}

module.exports = {
    OLD_REPO_DIRNAME,
    NEW_REPO_DIRNAME,
    matchesRelocatedRepoPath,
    relocatePathWithinRoot
};
