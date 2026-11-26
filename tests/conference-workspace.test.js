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

test('环境变量重复的诊断只暴露键名和行号，绝不暴露值', () => {
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

test('进程诊断只有本地 PID 还活着才标为活跃，并区分过期、完成和无效', () => {
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

test('git 诊断会分别返回代码、博客和图床仓库的逐文件脏状态', () => {
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

test('合并诊断在约定上是只读的，并报告容量和各项内容', () => {
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
        assert.equal(result.contract, 'conference-workspace-diagnostic');
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

test('工作区盘点读取实际新版完成凭证，仍不声明已经发布', async t => {
    const api = require('../scripts/lib/conference-process.js');
    const engine = require('../scripts/analysis-engine.js');
    const root = fs.realpathSync(tempRoot());
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const H = api.stableHash;
    const config = api.deepExecutionConfigIdentity({
        env: { PAPER_ANALYZER_MODEL: 'offline-model', PAPER_ANALYZER_ENDPOINT: 'https://example.invalid/v1' },
        analysisConfig: Object.fromEntries(api.DEEP_EXECUTION_LIMIT_FIELDS.map(field =>
            [field, /Temperature$/.test(field) ? 0.1 : 1000]))
    });
    const files = { conferenceProcessDir: path.join(root, 'processes') };
    const paperId = 'conference:odyssey:2026:conference-paper-id:offline-workspace';
    const members = [{ paperId, sourceIdentity: 'conference-paper-id:offline-workspace' }];
    const authority = { conferenceId: 'odyssey-2026', implementationSha256: H('offline implementation'),
        tagCatalogVersion: 'paper-tag-catalog-v2', tagCatalogSha256: H('offline catalog'),
        deepExecutionConfig: config };
    const proof = { manifestSha256: H('page manifest'), contentSha256: H('page content'),
        pagePath: 'content/posts/offline-workspace.md' };
    const result = await api.runConferenceProcess({ apply: true, concurrency: 1 }, {
        files, engine, loadAuthority: () => ({ files, authority, members }),
        implementationSha256: () => authority.implementationSha256,
        deepExecutionConfigIdentity: () => config,
        now: () => '2026-09-12T00:00:00.000Z',
        prepareShared: async () => ({ planReceiptSha256: H('plan receipt'),
            sealed: [{ paperId, proof: { textSha256: H('source text') } }] }),
        processPaper: async () => ({ analysisProof: { analysisSha256: H('analysis') }, pageProof: proof }),
        aggregate: async () => ({ manifest: { manifestSha256: H('aggregate manifest'),
            markdownSha256: H('aggregate content'), aggregateId: H('aggregate').slice(0, 32),
            pagePath: 'content/posts/conference-odyssey-2026.md' } })
    });
    const directory = path.join(files.conferenceProcessDir, result.processId);
    const stateBytes = fs.readFileSync(path.join(directory, 'state.json'));
    const receiptBytes = fs.readFileSync(path.join(directory, 'completion-receipt.json'));
    const codec = require('../scripts/lib/protocol-codec');
    assert.ok(codec.isCurrentHeader(JSON.parse(stateBytes), 'conference-process'));
    assert.ok(codec.isCurrentHeader(JSON.parse(receiptBytes), 'conference-process-completion-receipt'));
    const report = workspace.inspectProcessStates({ processRoot: files.conferenceProcessDir });
    assert.equal(report.counts.validated_complete, 1);
    assert.equal(report.counts.invalid, 0);
    assert.equal(report.processes[0].publicationStatus, 'not_checked');
    assert.deepEqual(fs.readFileSync(path.join(directory, 'state.json')), stateBytes);
    assert.deepEqual(fs.readFileSync(path.join(directory, 'completion-receipt.json')), receiptBytes);
});

test('命令行只接受无参数调用，未使用的 --json 开关已删除', () => {
    assert.deepStrictEqual(workspace.parseArgs([]), {});
    assert.throws(() => workspace.parseArgs(['--json']), /只读诊断.*JSON/);
    assert.throws(() => workspace.parseArgs(['--other']), /只读诊断/);
});

test('工作区盘点接受合法的 readerRevision 与 sourceUpgradePromotion 论文项并拒绝篡改', t => {
    const root = tempRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const processRoot = path.join(root, 'conference-processes');
    const processId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const processDir = path.join(processRoot, processId);
    fs.mkdirSync(processDir, { recursive: true });

    const adapter = require('../scripts/lib/conference-analysis-adapter.js');
    const grantApi = require('../scripts/lib/conference-recovery-grant.js');
    const codec = require('../scripts/lib/protocol-codec');
    const crypto = require('node:crypto');
    const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
    const sha = v => crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');

    const paperRev = 'conference:icassp:2026:icassp-arnumber:101';
    const paperWin = 'conference:icassp:2026:icassp-arnumber:102';
    const paperPreserved = 'conference:icassp:2026:icassp-arnumber:103';

    const parentExecRev = workspace.deterministicUuid(processId, paperRev, 'analysis');
    const parentShaRev = sha('parent-analysis-rev');
    const revHeader = codec.recordHeader('conference-reader-source-revision', 'conference-reader-source-revision');
    const revBody = {
        ...revHeader,
        paperId: paperRev,
        parentExecutionId: parentExecRev,
        parentAnalysisFileSha256: parentShaRev,
        executionId: adapter.readerRevisionExecutionId(parentExecRev, parentShaRev, revHeader)
    };
    const readerRevision = { ...revBody, revisionSha256: sha(revBody) };

    const parentExecWin = workspace.deterministicUuid(processId, paperWin, 'analysis');
    const grantId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const grantSha256 = sha('grant');
    const failedAnalysisFileSha256 = sha('failed-analysis');
    const failedExecutionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const winHeader = codec.recordHeader('conference-reader-recovery-window', 'conference-reader-recovery-window');
    const winBody = {
        ...winHeader,
        paperId: paperWin,
        originalMemberPaperId: paperWin,
        parentExecutionId: parentExecWin,
        grantId,
        grantSha256,
        failedExecutionId,
        failedAnalysisFileSha256,
        maxAttempts: 3,
        executionId: grantApi.grantedRecoveryExecutionId(grantId, failedExecutionId, failedAnalysisFileSha256, winHeader)
    };
    const windowRevision = { ...winBody, revisionSha256: sha(winBody) };

    const stateBody = {
        ...codec.recordHeader('conference-process', 'conference-process'),
        processId,
        status: 'partial',
        authority: {
            conferenceId: 'icassp-2026',
            implementationSha256: sha('impl'),
            tagCatalogVersion: 'paper-tag-catalog-v2',
            tagCatalogSha256: sha('catalog')
        },
        sourceUpgradePromotion: {
            preservedOriginalCompletePaperIds: [paperPreserved]
        },
        items: {
            [paperRev]: {
                paperId: paperRev,
                status: 'analysis_partial',
                analysisRunId: readerRevision.executionId,
                readerRevision,
                attempts: 2
            },
            [paperWin]: {
                paperId: paperWin,
                status: 'analysis_partial',
                analysisRunId: windowRevision.executionId,
                readerRevision: windowRevision,
                attempts: 3
            },
            [paperPreserved]: {
                paperId: paperPreserved,
                status: 'complete',
                analysisRunId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                preservedOriginalComplete: true,
                attempts: 1,
                sourceProof: { textSha256: sha('src') },
                analysisProof: { analysisSha256: sha('ana') },
                pageProof: { contentSha256: sha('page') }
            }
        },
        aggregate: null,
        completionReceiptSha256: null
    };
    const validState = { ...stateBody, stateSha256: sha(stateBody) };
    fs.writeFileSync(path.join(processDir, 'state.json'), JSON.stringify(validState));

    const report = workspace.inspectProcessStates({ processRoot });
    assert.equal(report.counts.invalid, 0);
    assert.equal(report.processes[0].classification, 'stale');
    assert.equal(report.processes[0].stateStatus, 'partial');

    const badBody = structuredClone(stateBody);
    badBody.items[paperRev].readerRevision.revisionSha256 = '0'.repeat(64);
    fs.writeFileSync(path.join(processDir, 'state.json'), JSON.stringify({ ...badBody, stateSha256: sha(badBody) }));
    const tamperedReport = workspace.inspectProcessStates({ processRoot });
    assert.equal(tamperedReport.counts.invalid, 1);
    assert.equal(tamperedReport.processes[0].reason, 'invalid_state_schema');
});

test('工作区盘点对称接受 sourceResourceCorrectionAdoption 与链式 textMaintenanceAdoption 并拒绝伪造绑定', t => {
    const root = tempRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const processRoot = path.join(root, 'conference-processes');
    const processId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const processDir = path.join(processRoot, processId);
    fs.mkdirSync(processDir, { recursive: true });

    const adapter = require('../scripts/lib/conference-analysis-adapter.js');
    const codec = require('../scripts/lib/protocol-codec');
    const crypto = require('node:crypto');
    const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
    const sha = v => crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');

    const paperSource = 'conference:icassp:2026:icassp-arnumber:201';
    const paperChained = 'conference:icassp:2026:icassp-arnumber:202';
    const sourceChildId = '11111111-aaaa-4bbb-8ccc-111111111111';
    const selectedMainId = '22222222-aaaa-4bbb-8ccc-222222222222';
    const readerParentId = '33333333-aaaa-4bbb-8ccc-333333333333';
    const chainedParentId = '44444444-aaaa-4bbb-8ccc-444444444444';
    const batchId = '55555555-aaaa-4bbb-8ccc-555555555555';
    const maintenanceManifestSha = sha('workspace-maintenance-manifest');
    const revHeader = codec.recordHeader('conference-reader-source-revision', 'conference-reader-source-revision');
    const parentSha = sha('chained-parent-analysis');
    const revBody = {
        ...revHeader,
        paperId: paperChained,
        parentExecutionId: chainedParentId,
        parentAnalysisFileSha256: parentSha,
        readerReviewMaintenance: { batchId, manifestSha256: maintenanceManifestSha },
        executionId: adapter.readerRevisionExecutionId(chainedParentId, parentSha, revHeader)
    };
    const chainedRevision = { ...revBody, revisionSha256: sha(revBody) };

    const stateBody = {
        ...codec.recordHeader('conference-process', 'conference-process'),
        processId,
        status: 'running',
        authority: {
            conferenceId: 'icassp-2026',
            implementationSha256: sha('impl'),
            tagCatalogVersion: 'paper-tag-catalog-v2',
            tagCatalogSha256: sha('catalog')
        },
        items: {
            [paperSource]: {
                paperId: paperSource,
                status: 'complete',
                analysisRunId: sourceChildId,
                attempts: 1,
                sourceProof: { textSha256: sha('src1') },
                analysisProof: { analysisSha256: sha('ana1') },
                pageProof: { contentSha256: sha('page1') },
                sourceResourceCorrectionAdoption: {
                    manifestFile: '/tmp/source-manifest.json',
                    manifestSha256: sha('src-manifest'),
                    previousStateSha256: sha('prev-state'),
                    previousItemSha256: sha('prev-item'),
                    previousAttempts: 1,
                    previousFailure: null,
                    selectedMainExecutionId: selectedMainId,
                    readerParentExecutionId: readerParentId,
                    newApiRequests: 0
                }
            },
            [paperChained]: {
                paperId: paperChained,
                status: 'complete',
                analysisRunId: chainedRevision.executionId,
                readerRevision: chainedRevision,
                textMaintenanceAdoption: {
                    batchId,
                    manifestSha256: maintenanceManifestSha,
                    previousExecutionId: chainedParentId
                },
                attempts: 2,
                sourceProof: { textSha256: sha('src2') },
                analysisProof: { analysisSha256: sha('ana2') },
                pageProof: { contentSha256: sha('page2') }
            }
        },
        aggregate: null,
        completionReceiptSha256: null
    };
    const writeAndInspect = body => {
        fs.writeFileSync(path.join(processDir, 'state.json'), JSON.stringify({ ...body, stateSha256: sha(body) }));
        return workspace.inspectProcessStates({ processRoot });
    };

    const ok = writeAndInspect(stateBody);
    assert.equal(ok.counts.invalid, 0);
    assert.equal(ok.processes[0].stateStatus, 'running');

    for (const mutate of [
        body => { delete body.items[paperSource].sourceResourceCorrectionAdoption; },
        body => { body.items[paperSource].sourceResourceCorrectionAdoption.newApiRequests = 2; },
        body => { delete body.items[paperChained].textMaintenanceAdoption; },
        body => { body.items[paperChained].textMaintenanceAdoption.previousExecutionId = '66666666-aaaa-4bbb-8ccc-666666666666'; },
        body => { body.items[paperChained].textMaintenanceAdoption.manifestSha256 = '0'.repeat(64); }
    ]) {
        const bad = structuredClone(stateBody);
        mutate(bad);
        const report = writeAndInspect(bad);
        assert.equal(report.counts.invalid, 1);
        assert.equal(report.processes[0].reason, 'invalid_state_schema');
    }
});
