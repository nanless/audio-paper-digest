'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const workspace = require('../scripts/conference-workspace.js');

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'conference-workspace-test-'));
}

function writeJson(filename, value) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, JSON.stringify(value));
}

function processState(processId, status, items = {}, extra = {}) {
    const normalizedItems = Object.fromEntries(Object.entries(items).map(([paperId, item]) => [paperId, {
        paperId,
        sourceIdentity: null,
        analysisRunId: workspace.deterministicUuid(processId, paperId, 'analysis'),
        status: item.status,
        sourceProof: null,
        analysisProof: null,
        pageProof: null,
        attempts: item.status === 'complete' ? 1 : 0,
        lastError: null,
        updatedAt: '2026-09-12T00:00:00.000Z',
        ...item
    }]));
    const value = {
        contract: 'conference-process-v1', version: 1, generation: 1,
        processId, createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
        authority: { conferenceId: 'aistats-2026', implementationSha256: 'a'.repeat(64) },
        status, items: normalizedItems, aggregate: null, completionReceiptSha256: null, ...extra
    };
    value.stateSha256 = workspace.stateDigest(value);
    return value;
}

function completeItem(marker) {
    return {
        status: 'complete',
        sourceProof: { sourceSha256: marker.repeat(64) },
        analysisProof: { analysisSha256: marker.repeat(64) },
        pageProof: { contentSha256: marker.repeat(64) }
    };
}

test('env duplicate diagnostics only expose key and line numbers, never values', () => {
    const root = tempRoot();
    try {
        const envFile = path.join(root, '.env');
        fs.writeFileSync(envFile, [
            'PAPER_ANALYZER_API_KEY=super-secret-value',
            'HTTP_PROXY=http://proxy-one.invalid',
            'PAPER_ANALYZER_API_KEY=another-secret-value',
            'HTTP_PROXY=http://proxy-two.invalid',
            'PAPER_ANALYZER_MODEL=muse-test'
        ].join('\n'));
        const report = workspace.inspectEnvDuplicates(envFile);
        assert.deepEqual(report.duplicates, [
            { key: 'HTTP_PROXY', lines: [2, 4] },
            { key: 'PAPER_ANALYZER_API_KEY', lines: [1, 3] }
        ]);
        assert.doesNotMatch(JSON.stringify(report), /super-secret|proxy-one|proxy-two|muse-test/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('process diagnostics mark active only for a live local PID, and distinguish stale/complete/invalid', () => {
    const root = tempRoot();
    try {
        const processRoot = path.join(root, 'data/runtime/conference-processes');
        const processIds = {
            active: '11111111-1111-4111-8111-111111111111',
            stale: '22222222-2222-4222-8222-222222222222',
            reported: '33333333-3333-4333-8333-333333333333',
            validated: '44444444-4444-4444-8444-444444444444',
            partial: '55555555-5555-4555-8555-555555555555',
            pending: '66666666-6666-4666-8666-666666666666',
            tampered: '77777777-7777-4777-8777-777777777777'
        };
        writeJson(path.join(processRoot, `${processIds.active}/state.json`), processState(processIds.active, 'running', {
            a: { status: 'analyzing', attempts: 1 }, b: completeItem('b')
        }, { generation: 4 }));
        fs.mkdirSync(path.join(processRoot, `${processIds.active}/.operation.lock`), { recursive: true });
        writeJson(path.join(processRoot, `${processIds.active}/.operation.lock/owner.json`), { pid: 123, hostname: 'test-host' });
        writeJson(path.join(processRoot, `${processIds.stale}/state.json`), processState(processIds.stale, 'running', {
            stalePaper: { status: 'source_sealed', sourceProof: { sourceSha256: 's'.repeat(64) } }
        }));
        writeJson(path.join(processRoot, `${processIds.partial}/state.json`), processState(
            processIds.partial, 'partial', {
                partialPaper: { status: 'analysis_partial', attempts: 1 }
            }));
        writeJson(path.join(processRoot, `${processIds.pending}/state.json`), processState(
            processIds.pending, 'pending', {
                pendingPaper: { status: 'pending' }
            }));
        const reportedState = processState(processIds.reported, 'complete', {
            reportedPaper: completeItem('r')
        }, { aggregate: { manifestSha256: 'r'.repeat(64) }, completionReceiptSha256: 'd'.repeat(64) });
        writeJson(path.join(processRoot, `${processIds.reported}/state.json`), reportedState);
        const tamperedState = processState(
            processIds.tampered, 'running', {
                tamperedPaper: { status: 'analyzing', attempts: 1 }
            });
        tamperedState.generation = 2;
        writeJson(path.join(processRoot, `${processIds.tampered}/state.json`), tamperedState);
        const validatedItem = completeItem('v');
        const completionBody = {
            contract: 'conference-process-completion-receipt-v1', version: 1,
            processId: processIds.validated,
            authority: { conferenceId: 'aistats-2026', implementationSha256: 'a'.repeat(64) },
            planReceiptSha256: 'b'.repeat(64),
            items: [{ paperId: 'validatedPaper',
                analysisRunId: workspace.deterministicUuid(processIds.validated, 'validatedPaper', 'analysis'),
                sourceProof: validatedItem.sourceProof,
                analysisProof: validatedItem.analysisProof,
                pageProof: validatedItem.pageProof }],
            aggregate: { manifestSha256: 'c'.repeat(64) }
        };
        const completionSha = workspace.stableHash(completionBody);
        const validatedState = processState(processIds.validated, 'complete', {
            validatedPaper: completeItem('v')
        }, { authority: completionBody.authority, aggregate: completionBody.aggregate,
            completionReceiptSha256: completionSha });
        writeJson(path.join(processRoot, `${processIds.validated}/state.json`), validatedState);
        writeJson(path.join(processRoot, `${processIds.validated}/completion-receipt.json`), {
            ...completionBody, receiptSha256: completionSha
        });
        fs.mkdirSync(path.join(processRoot, 'invalid'));
        fs.writeFileSync(path.join(processRoot, 'invalid/state.json'), '{broken');

        const report = workspace.inspectProcessStates({
            processRoot,
            hostname: 'test-host',
            pidProbe: pid => pid === 123
        });
        assert.deepEqual(report.counts, {
            active: 1, stale: 3, reported_complete: 1, validated_complete: 1, invalid: 2
        });
        const byId = new Map(report.processes.map(item => [item.processId, item]));
        assert.equal(byId.get(processIds.active).classification, 'active');
        assert.equal(byId.get(processIds.active).lock.active, true);
        assert.equal(byId.get(processIds.active).itemCounts.analyzing, 1);
        assert.equal(byId.get(processIds.stale).classification, 'stale');
        assert.equal(byId.get(processIds.stale).reason, 'missing');
        assert.equal(byId.get(processIds.partial).stateStatus, 'partial');
        assert.equal(byId.get(processIds.partial).itemCounts.analysis_partial, 1);
        assert.equal(byId.get(processIds.pending).stateStatus, 'pending');
        assert.equal(byId.get(processIds.reported).classification, 'reported_complete');
        assert.equal(byId.get(processIds.reported).completion.valid, false);
        assert.equal(byId.get(processIds.reported).publicationStatus, 'not_checked');
        assert.equal(byId.get(processIds.validated).classification, 'validated_complete');
        assert.equal(byId.get(processIds.validated).completion.valid, true);
        assert.equal(byId.get(processIds.validated).publicationStatus, 'not_checked');
        assert.equal(report.publicationStatus, 'not_checked');
        assert.equal(byId.get('invalid').classification, 'invalid');
        assert.equal(byId.get(processIds.tampered).reason, 'state_sha_mismatch');
        assert.equal(byId.get(processIds.tampered).stateIntegrity.valid, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('git diagnostics return per-file dirty status for code, blog, and image repositories', () => {
    const root = tempRoot();
    try {
        const repos = {
            code: path.join(root, 'code'),
            blog: path.join(root, 'blog'),
            image: path.join(root, 'image')
        };
        for (const repo of Object.values(repos)) fs.mkdirSync(repo, { recursive: true });
        const outputs = {
            [repos.code]: '## main...origin/main\n M scripts/a.js\n?? scratch.txt\n',
            [repos.blog]: '## main\n M content/posts/paper.md\n',
            [repos.image]: '## main\n'
        };
        const runGit = (repo, args) => ({
            status: 0,
            stdout: args[0] === 'status' ? outputs[repo] : 'abc123\n'
        });
        const code = workspace.inspectGitRepository('code', repos.code, { runGit });
        assert.equal(code.dirty, true);
        assert.deepEqual(code.files.map(item => item.path), ['scripts/a.js', 'scratch.txt']);
        assert.equal(code.files[0].status, ' M');
        assert.equal(code.files[1].untracked, true);
        const image = workspace.inspectGitRepository('image', repos.image, { runGit });
        assert.equal(image.dirty, false);
        assert.equal(image.head, 'abc123');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('combined diagnostic is read-only in its contract and reports capacity plus all surfaces', () => {
    const root = tempRoot();
    try {
        for (const relative of ['data/current', 'data/archive', 'data/runtime/conference-processes', 'code', 'blog', 'image']) {
            fs.mkdirSync(path.join(root, relative), { recursive: true });
        }
        fs.writeFileSync(path.join(root, 'data/runtime/probe.bin'), 'probe');
        const envFile = path.join(root, '.env');
        fs.writeFileSync(envFile, 'PAPER_DIGEST_BLOG_REPO=/safe/blog\nPAPER_DIGEST_BLOG_REPO=/safe/blog-2\n');
        const result = workspace.diagnose({
            projectRoot: root,
            envFile,
            paths: {
                codeRepo: path.join(root, 'code'),
                blogRepo: path.join(root, 'blog'),
                imageRepo: path.join(root, 'image'),
                processRoot: path.join(root, 'data/runtime/conference-processes')
            },
            runGit: () => ({ status: 0, stdout: '## main\n' }),
            pidProbe: () => false,
            nowMs: Date.parse('2026-09-12T00:00:00.000Z')
        });
        assert.equal(result.contract, 'conference-workspace-diagnostic-v1');
        assert.equal(result.readOnly, true);
        assert.equal(result.repositories.length, 3);
        assert.equal(result.env.duplicateCount, 1);
        assert.equal(result.capacity.filesystem.path, path.join(root, 'data'));
        assert.equal(result.capacity.roots.find(item => item.path.endsWith('/runtime')).files, 1);
        assert.equal(fs.readFileSync(envFile, 'utf8').includes('/safe/blog-2'), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
