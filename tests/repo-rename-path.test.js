'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    OLD_REPO_DIRNAME,
    NEW_REPO_DIRNAME,
    matchesRelocatedRepoPath,
    relocatePathWithinRoot
} = require('../scripts/lib/repo-rename-path');

test('matchesRelocatedRepoPath accepts exact match and single-segment old->new repo rename', () => {
    const cur = `/Users/example/code/${NEW_REPO_DIRNAME}/data/runtime/run1/proof.json`;
    const old = `/Users/example/code/${OLD_REPO_DIRNAME}/data/runtime/run1/proof.json`;

    assert.equal(matchesRelocatedRepoPath(cur, cur), true);
    assert.equal(matchesRelocatedRepoPath(old, cur), true);
});

test('matchesRelocatedRepoPath rejects traversal, reverse rename, multi-segment changes, and foreign paths', () => {
    const cur = `/Users/example/code/${NEW_REPO_DIRNAME}/data/runtime/run1/proof.json`;
    const old = `/Users/example/code/${OLD_REPO_DIRNAME}/data/runtime/run1/proof.json`;

    // Reverse direction must not match
    assert.equal(matchesRelocatedRepoPath(cur, old), false);
    // Parent traversal must not match
    assert.equal(matchesRelocatedRepoPath(`/Users/example/code/${OLD_REPO_DIRNAME}/data/runtime/x/../run1/proof.json`, cur), false);
    // Relative path must not match
    assert.equal(matchesRelocatedRepoPath(`data/runtime/run1/proof.json`, cur), false);
    // Unrelated repo dirname must not match
    assert.equal(matchesRelocatedRepoPath(`/Users/example/code/other-repo/data/runtime/run1/proof.json`, cur), false);
    // Different leaf file must not match
    assert.equal(matchesRelocatedRepoPath(`/Users/example/code/${OLD_REPO_DIRNAME}/data/runtime/run1/other.json`, cur), false);
    // Extra path segment must not match
    assert.equal(matchesRelocatedRepoPath(`/Users/example/code/${OLD_REPO_DIRNAME}/extra/data/runtime/run1/proof.json`, cur), false);
    // Non-string inputs must not match
    assert.equal(matchesRelocatedRepoPath(null, cur), false);
    assert.equal(matchesRelocatedRepoPath(cur, undefined), false);
});

test('relocatePathWithinRoot resolves direct and single-segment renamed paths strictly inside root', () => {
    const root = `/Users/example/code/${NEW_REPO_DIRNAME}/data/runtime`;
    const direct = `${root}/runs/abc/file.json`;
    const preRename = `/Users/example/code/${OLD_REPO_DIRNAME}/data/runtime/runs/abc/file.json`;

    assert.equal(relocatePathWithinRoot(direct, root), direct);
    assert.equal(relocatePathWithinRoot(preRename, root), direct);
});

test('relocatePathWithinRoot rejects paths equal to root, outside root, with .., reverse rename, or non-renamed roots', () => {
    const root = `/Users/example/code/${NEW_REPO_DIRNAME}/data/runtime`;

    // Equal to root (not strictly inside)
    assert.equal(relocatePathWithinRoot(root, root), null);
    assert.equal(relocatePathWithinRoot(`/Users/example/code/${OLD_REPO_DIRNAME}/data/runtime`, root), null);
    // Outside root even after rename
    assert.equal(relocatePathWithinRoot(`/Users/example/code/${OLD_REPO_DIRNAME}/etc/passwd`, root), null);
    assert.equal(relocatePathWithinRoot(`/Users/example/code/${OLD_REPO_DIRNAME}/data/current/file.json`, root), null);
    // Traversal rejected
    assert.equal(relocatePathWithinRoot(`/Users/example/code/${OLD_REPO_DIRNAME}/data/runtime/runs/../secret.json`, root), null);
    assert.equal(relocatePathWithinRoot(`${root}/runs/../secret.json`, root), null);
    // Foreign sibling repo rejected
    assert.equal(relocatePathWithinRoot(`/Users/example/code/evil-repo/data/runtime/runs/abc/file.json`, root), null);
    // Relative path rejected
    assert.equal(relocatePathWithinRoot(`runs/abc/file.json`, root), null);
    // Reverse direction (old root, new recorded path) rejected
    const oldRoot = `/Users/example/code/${OLD_REPO_DIRNAME}/data/runtime`;
    assert.equal(relocatePathWithinRoot(`${root}/runs/abc/file.json`, oldRoot), null);
    // Arbitrary temp root without NEW_REPO_DIRNAME never allows outside paths
    assert.equal(relocatePathWithinRoot(`/tmp/other/runs/abc/file.json`, `/tmp/test-root/data/runtime`), null);
});
