'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { buildTaskPacket, stableSha256 } = require('../scripts/manual-v6-workflow.js');
const { computeArtifactIndexSha256 } = require('../scripts/manual-artifact-index.js');
const { buildFilteredBatchFingerprint, buildPaperInputIdentity } = require('../scripts/manual-fetch-fulltext.js');
const {
    ACTIVE_LIMIT, initializeState, registerPacket, claimTasks, startTask, submitTask,
    failTask, retryTask, abandonTask, verifyBoundInputs, validateState, stateSummary, parseArgs
} = require('../scripts/manual-v6-task-runner.js');

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const queuedAt = '2026-08-28T09:00:00.000+08:00';
const startedAt = '2026-08-28T09:01:00.000+08:00';
const completedAt = '2026-08-28T09:10:00.000+08:00';

function bytesSha(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fixture(ids = ['2608.12345']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-v6-runner-'));
    const filteredPath = path.join(root, 'filtered.json');
    const filtered = {
        status: 'complete', batchDate: '2026-08-28', papers: ids.map(arxivId => ({ arxivId }))
    };
    fs.writeFileSync(filteredPath, JSON.stringify(filtered));
    const filteredBatchSha256 = buildFilteredBatchFingerprint(filtered);
    const papers = {};
    for (const id of ids) {
        const paperRoot = path.join(root, id);
        fs.mkdirSync(paperRoot);
        for (const dir of ['evidence', 'instructions', 'schema', 'reviews']) {
            fs.mkdirSync(path.join(paperRoot, dir));
        }
        const metadataPath = path.join(paperRoot, 'evidence', 'paper-metadata.json');
        const metadata = { arxivId: id };
        fs.writeFileSync(metadataPath, JSON.stringify(metadata));
        const paperInputSha256 = buildPaperInputIdentity(metadata, filteredBatchSha256, paperRoot).paperInputSha256;
        const fulltextPath = path.join(paperRoot, 'evidence', 'fulltext.txt');
        fs.writeFileSync(fulltextPath, `Authoritative paper full text for ${id}.`);
        const sourceSha256 = bytesSha(fulltextPath);
        const source = 'arxiv_html';
        const sourceId = `https://arxiv.org/html/${id}`;
        const sourceIdentitySha256 = stableSha256({ source, sourceId, sourceSha256 });
        const sourceSnapshotPath = path.join(paperRoot, 'evidence', 'source-snapshot.json');
        fs.writeFileSync(sourceSnapshotPath, JSON.stringify({
            paperId: id, paperInputSha256, sourceIdentitySha256,
            source, sourceId, sourceSha256
        }));
        const artifact = {
            version: 1, parserVersion: 'manual-artifact-parser-v2-structured', paperId: id,
            inputIdentity: {
                sourceSha256, sourceIdentitySha256, paperInputSha256,
                structuredArtifactsSha256: ''
            },
            inventoryHealth: { status: 'incomplete', issues: ['test fixture'] },
            sections: [], tables: [], figures: [], images: [], formulas: [], references: [],
            acronyms: [], citations: [], baselines: [], datasets: [], metrics: [], sourceSpans: []
        };
        artifact.artifactIndexSha256 = computeArtifactIndexSha256(artifact);
        artifact.outputSha256 = artifact.artifactIndexSha256;
        const artifactPath = path.join(paperRoot, 'evidence', 'artifact-index.json');
        fs.writeFileSync(artifactPath, JSON.stringify(artifact));
        const promptPath = path.join(paperRoot, 'instructions', 'manual-tutorial-article.md');
        const contractPath = path.join(paperRoot, 'instructions', 'manual-editorial-reference-contract.md');
        fs.copyFileSync(path.resolve(__dirname, '..', 'prompts', 'manual-tutorial-article.md'), promptPath);
        fs.copyFileSync(path.resolve(__dirname, '..', 'docs', 'manual-editorial-reference-contract.md'), contractPath);
        const templatePath = path.join(paperRoot, 'schema', 'blank-record.json');
        fs.writeFileSync(templatePath, JSON.stringify({
            version: 1, mode: 'manual_v6_blank_record_schema', paperId: id,
            populated: false, fields: { readerArticle: '' }
        }));
        papers[id] = {
            root: paperRoot, artifactPath, metadataPath, sourceSnapshotPath, fulltextPath,
            promptPath, contractPath, templatePath, sourceIdentitySha256, paperInputSha256
        };
    }
    return {
        root, papers, filteredPath,
        state: initializeState('2026-08-28', ids, queuedAt, {
            path: filteredPath, fileSha256: bytesSha(filteredPath),
            paperSetSha256: stableSha256([...ids].sort())
        })
    };
}

function register(fx, id, role, contractSha = C) {
    const paper = fx.papers[id];
    const freshEvidence = freshEvidenceFor(paper);
    const allowedArtifacts = role === 'author' ? freshEvidence : [{
        path: 'evidence/artifact-index.json', sha256: bytesSha(paper.artifactPath), kind: 'artifact_index'
    }];
    const packet = buildTaskPacket({
        role, paperId: id, paperInputSha256: paper.paperInputSha256, sourceIdentitySha256: paper.sourceIdentitySha256,
        contractSha256: contractSha, allowedArtifacts
    });
    const packetPath = path.join(paper.root, `${role}-${contractSha[0]}.packet.json`);
    fs.writeFileSync(packetPath, JSON.stringify(packet));
    registerPacket(fx.state, {
        paperId: id, role, artifactRoot: paper.root, packetPath, controlledTaskRoot: fx.root
    });
    return { packet, packetPath };
}

function freshEvidenceFor(paper) {
    return [
        { path: 'evidence/paper-metadata.json', sha256: bytesSha(paper.metadataPath), kind: 'paper_metadata' },
        { path: 'evidence/source-snapshot.json', sha256: bytesSha(paper.sourceSnapshotPath), kind: 'source_snapshot' },
        { path: 'evidence/fulltext.txt', sha256: bytesSha(paper.fulltextPath), kind: 'fulltext' },
        { path: 'evidence/artifact-index.json', sha256: bytesSha(paper.artifactPath), kind: 'artifact_index' },
        { path: 'instructions/manual-tutorial-article.md', sha256: bytesSha(paper.promptPath), kind: 'authoring_prompt' },
        { path: 'instructions/manual-editorial-reference-contract.md', sha256: bytesSha(paper.contractPath), kind: 'editorial_contract' },
        { path: 'schema/blank-record.json', sha256: bytesSha(paper.templatePath), kind: 'record_template' }
    ];
}

function validateAuthor(fx, id = '2608.12345', taskName = 'author-2608-12345') {
    const claimed = claimTasks(fx.state, 1, queuedAt).claimed[0];
    startTask(fx.state, claimed.claimId, taskName, startedAt);
    const task = fx.state.papers[id].tasks.author;
    const articleSha256 = 'd'.repeat(64);
    const output = { version: 1, role: 'author', paperId: id, taskName, passed: true, articleSha256 };
    const receipt = {
        paperId: id, taskName, singlePaperOnly: true, isolatedContext: true,
        model: 'gpt-5.6-terra', reasoningEffort: 'high', inputPacketSha256: task.packetSha256,
        articleSha256, queuedAt, startedAt, completedAt, revision: 1
    };
    const outputPath = path.join(fx.papers[id].root, 'author-output.json');
    const receiptPath = path.join(fx.papers[id].root, 'author-receipt.json');
    fs.writeFileSync(outputPath, JSON.stringify(output));
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    submitTask(fx.state, claimed.claimId, { outputPath, receiptPath });
}

function markValidated(state, task, root, paperId, role, name, semanticSha) {
    const outputPath = path.join(root, `${name}-cached-output.json`);
    const receiptPath = path.join(root, `${name}-cached-receipt.json`);
    fs.writeFileSync(outputPath, JSON.stringify({ cached: name }));
    fs.writeFileSync(receiptPath, JSON.stringify({ cached: `${name}-receipt` }));
    Object.assign(task, {
        status: 'validated', outputPath, receiptPath, taskName: name,
        claimId: `${name}-claim`, claimedAt: queuedAt, startedAt, completedAt,
        outputFileSha256: bytesSha(outputPath), outputSemanticSha256: semanticSha,
        receiptFileSha256: bytesSha(receiptPath),
        receiptSemanticSha256: stableSha256({ cached: `${name}-receipt` })
    });
    state.taskNames[name] = { paperId, role, claimId: task.claimId, retired: false };
}

function submitReview(fx, role, taskName) {
    const claim = claimTasks(fx.state, 1, queuedAt).claimed[0];
    assert.equal(claim.role, role);
    startTask(fx.state, claim.claimId, taskName, startedAt);
    const output = {
        version: 1, role, paperId: claim.paperId, taskName, passed: true, issues: [],
        findings: [
            `${role} 已核对主结果数值、指标方向以及对应的局部全文证据，未发现跨论文污染。`,
            `${role} 已核对方法边界、评分依据以及未报告项，结论没有越过受控证据范围。`
        ],
        evidenceChecks: [
            { claim: '主结果比较与受控表格证据一致', evidenceId: 'TAB0001', verified: true },
            { claim: '方法边界与全文局部证据一致', evidenceId: 'SEC0002', verified: true }
        ]
    };
    const outputName = role === 'technical_scoring'
        ? 'technical-scoring.json'
        : 'pedagogy-readability.json';
    const outputPath = path.join(fx.papers[claim.paperId].root, 'reviews', outputName);
    const receiptPath = path.join(fx.papers[claim.paperId].root, `${role}-receipt.json`);
    fs.writeFileSync(outputPath, JSON.stringify(output));
    fs.writeFileSync(receiptPath, JSON.stringify({
        role, paperId: claim.paperId, taskName, singlePaperOnly: true, isolatedContext: true,
        model: 'gpt-5.6-terra', reasoningEffort: 'high',
        consumedPacketSha256: fx.state.papers[claim.paperId].tasks[role].packetSha256,
        outputSha256: stableSha256(output), completedAt
    }));
    submitTask(fx.state, claim.claimId, { outputPath, receiptPath });
}

describe('Manual v6 persistent task runner', () => {
    it('最多占用 3 槽，且只输出 ready 的 pending 单篇任务', () => {
        const ids = ['2608.10001', '2608.10002', '2608.10003', '2608.10004'];
        const fx = fixture(ids);
        ids.forEach(id => register(fx, id, 'author'));
        const first = claimTasks(fx.state, 3, queuedAt);
        assert.equal(first.claimed.length, ACTIVE_LIMIT);
        assert.equal(first.active, ACTIVE_LIMIT);
        assert.equal(claimTasks(fx.state, 3, queuedAt).claimed.length, 0);
        assert.throws(() => claimTasks(fx.state, 0, queuedAt), /1-3/);
        assert.throws(() => claimTasks(fx.state, -1, queuedAt), /1-3/);
        assert.throws(() => claimTasks(fx.state, 1.5, queuedAt), /整数/);
        assert.throws(() => claimTasks(fx.state, 4, queuedAt), /1-3/);
        assert.ok(first.claimed.every(item => item.role === 'author' && item.packetPath.includes(item.paperId)));
        fs.rmSync(fx.root, { recursive: true, force: true });
    });

    it('author validated 后才放行两个独立 review 分支', () => {
        const fx = fixture();
        register(fx, '2608.12345', 'author');
        register(fx, '2608.12345', 'technical_scoring');
        register(fx, '2608.12345', 'pedagogy_readability');
        assert.equal(fx.state.papers['2608.12345'].tasks.technical_scoring.status, 'blocked');
        validateAuthor(fx);
        assert.equal(fx.state.papers['2608.12345'].tasks.technical_scoring.status, 'pending');
        assert.equal(fx.state.papers['2608.12345'].tasks.pedagogy_readability.status, 'pending');
        assert.equal(claimTasks(fx.state, 3, queuedAt).claimed.length, 2);
        fs.rmSync(fx.root, { recursive: true, force: true });
    });

    it('Terra-high receipt、taskName 和真实输出 semantic SHA 全部 fail closed', () => {
        const fx = fixture();
        register(fx, '2608.12345', 'author');
        validateAuthor(fx);
        register(fx, '2608.12345', 'technical_scoring');
        const claim = claimTasks(fx.state, 1, queuedAt).claimed[0];
        startTask(fx.state, claim.claimId, 'technical-2608-12345', startedAt);
        assert.throws(() => startTask(fx.state, claim.claimId, 'duplicate', startedAt), /claimed/);
        const output = {
            version: 1, role: 'technical_scoring', paperId: '2608.12345',
            taskName: 'technical-2608-12345', passed: true, issues: [],
            findings: [
                '逐项核对主结果表中的指标方向和数值后未发现跨论文污染。',
                '八维评分已经回到对应局部证据并保留未报告信息的边界。'
            ],
            evidenceChecks: [
                { claim: '主结果比较方向正确且数值来源一致', evidenceId: 'table-1', verified: true },
                { claim: '消融结论没有越过实际受控实验范围', evidenceId: 'table-2', verified: true }
            ]
        };
        const outputPath = path.join(fx.papers['2608.12345'].root, 'reviews', 'technical-scoring.json');
        const receiptPath = path.join(fx.papers['2608.12345'].root, 'technical-receipt.json');
        fs.writeFileSync(outputPath, JSON.stringify(output));
        const receipt = {
            role: 'technical_scoring', paperId: '2608.12345', taskName: output.taskName,
            singlePaperOnly: true, isolatedContext: true, model: 'gpt-5.6-sol', reasoningEffort: 'high',
            consumedPacketSha256: fx.state.papers['2608.12345'].tasks.technical_scoring.packetSha256,
            outputSha256: stableSha256(output), completedAt
        };
        fs.writeFileSync(receiptPath, JSON.stringify(receipt));
        assert.throws(() => submitTask(fx.state, claim.claimId, { outputPath, receiptPath }), /Terra-high/);
        receipt.model = 'gpt-5.6-terra'; receipt.outputSha256 = A;
        fs.writeFileSync(receiptPath, JSON.stringify(receipt));
        assert.throws(() => submitTask(fx.state, claim.claimId, { outputPath, receiptPath }), /语义 SHA/);
        receipt.outputSha256 = stableSha256(output);
        fs.writeFileSync(receiptPath, JSON.stringify(receipt));
        assert.equal(submitTask(fx.state, claim.claimId, { outputPath, receiptPath }).status, 'validated');
        fs.rmSync(fx.root, { recursive: true, force: true });
    });

    it('content-SHA 相同 packet 命中缓存；技术分支变化不失效可读性兄弟分支', () => {
        const fx = fixture();
        register(fx, '2608.12345', 'author'); validateAuthor(fx);
        const technical = register(fx, '2608.12345', 'technical_scoring');
        register(fx, '2608.12345', 'pedagogy_readability');
        const tasks = fx.state.papers['2608.12345'].tasks;
        markValidated(fx.state, tasks.technical_scoring, fx.papers['2608.12345'].root,
            '2608.12345', 'technical_scoring', 'technical-cache', A);
        markValidated(fx.state, tasks.pedagogy_readability, fx.papers['2608.12345'].root,
            '2608.12345', 'pedagogy_readability', 'readability-cache', B);
        registerPacket(fx.state, {
            paperId: '2608.12345', role: 'technical_scoring', artifactRoot: fx.papers['2608.12345'].root,
            packetPath: technical.packetPath, controlledTaskRoot: fx.root
        });
        assert.equal(tasks.technical_scoring.status, 'validated');
        register(fx, '2608.12345', 'technical_scoring', 'e'.repeat(64));
        assert.notEqual(tasks.technical_scoring.status, 'validated');
        assert.equal(tasks.pedagogy_readability.status, 'validated');
        assert.equal(tasks.author.status, 'validated');
        fs.rmSync(fx.root, { recursive: true, force: true });
    });

    it('author_revision 只接受 author 原权威 allowlist 加 runner 已验证的两份 findings', () => {
        const fx = fixture();
        const author = register(fx, '2608.12345', 'author');
        validateAuthor(fx);
        register(fx, '2608.12345', 'technical_scoring');
        register(fx, '2608.12345', 'pedagogy_readability');
        submitReview(fx, 'technical_scoring', 'technical-lineage-review');
        submitReview(fx, 'pedagogy_readability', 'readability-lineage-review');
        const paper = fx.papers['2608.12345'];
        const reviews = [
            { path: 'reviews/technical-scoring.json', sha256: bytesSha(path.join(paper.root, 'reviews', 'technical-scoring.json')), kind: 'technical_review' },
            { path: 'reviews/pedagogy-readability.json', sha256: bytesSha(path.join(paper.root, 'reviews', 'pedagogy-readability.json')), kind: 'readability_review' }
        ];
        const revision = buildTaskPacket({
            role: 'author_revision', paperId: '2608.12345',
            paperInputSha256: paper.paperInputSha256,
            sourceIdentitySha256: paper.sourceIdentitySha256,
            contractSha256: C,
            allowedArtifacts: [
                ...author.packet.allowedArtifacts.map(({ path: artifactPath, sha256, kind }) => ({
                    path: artifactPath, sha256, kind
                })),
                ...reviews
            ]
        });
        const revisionPath = path.join(paper.root, 'author-revision.packet.json');
        fs.writeFileSync(revisionPath, JSON.stringify(revision));
        assert.doesNotThrow(() => registerPacket(fx.state, {
            paperId: '2608.12345', role: 'author_revision', artifactRoot: paper.root,
            packetPath: revisionPath, controlledTaskRoot: fx.root
        }));

        const changed = buildTaskPacket({
            ...revision,
            allowedArtifacts: revision.allowedArtifacts.map(item => item.kind === 'fulltext'
                ? { path: item.path, sha256: B, kind: item.kind }
                : { path: item.path, sha256: item.sha256, kind: item.kind })
        });
        const changedPath = path.join(paper.root, 'author-revision-changed.packet.json');
        fs.writeFileSync(changedPath, JSON.stringify(changed));
        assert.throws(() => registerPacket(fx.state, {
            paperId: '2608.12345', role: 'author_revision', artifactRoot: paper.root,
            packetPath: changedPath, controlledTaskRoot: fx.root
        }), /文件 SHA 不匹配|逐项复用 author/);
        fs.rmSync(fx.root, { recursive: true, force: true });
    });

    it('失败 checkpoint 必须显式 retry，旧 taskName 永久保留防止批次复用', () => {
        const fx = fixture(); register(fx, '2608.12345', 'author');
        const claim = claimTasks(fx.state, 1, queuedAt).claimed[0];
        startTask(fx.state, claim.claimId, 'author-crashed-task', startedAt);
        failTask(fx.state, claim.claimId, 'subagent context crashed before submission', completedAt);
        assert.equal(claimTasks(fx.state, 1, queuedAt).claimed.length, 0);
        retryTask(fx.state, '2608.12345', 'author');
        const retry = claimTasks(fx.state, 1, queuedAt).claimed[0];
        assert.throws(() => startTask(fx.state, retry.claimId, 'author-crashed-task', startedAt), /已在批次使用/);
        assert.match(stateSummary(fx.state).tasks.find(item => item.role === 'author').status, /claimed/);
        fs.rmSync(fx.root, { recursive: true, force: true });
    });

    it('显式 abandon 恢复悬挂 claim，并退休已启动 taskName', () => {
        const fx = fixture(); register(fx, '2608.12345', 'author');
        const claim = claimTasks(fx.state, 1, queuedAt).claimed[0];
        startTask(fx.state, claim.claimId, 'abandoned-author-task', startedAt);
        abandonTask(fx.state, claim.claimId, '平台确认该 subagent 已经终止，不再可能提交');
        const retry = claimTasks(fx.state, 1, queuedAt).claimed[0];
        assert.throws(() => startTask(fx.state, retry.claimId, 'abandoned-author-task', startedAt), /已在批次使用/);
        fs.rmSync(fx.root, { recursive: true, force: true });
    });

    it('filtered、packet 或 state 字节/字段被篡改后 status/mutation 必须 fail closed', () => {
        const fx = fixture(); register(fx, '2608.12345', 'author');
        assert.doesNotThrow(() => verifyBoundInputs(fx.state));
        fs.appendFileSync(fx.state.papers['2608.12345'].tasks.author.packetPath, ' ');
        assert.throws(() => verifyBoundInputs(fx.state), /packet 文件被篡改/);
        const fx2 = fixture(); register(fx2, '2608.12345', 'author');
        fs.writeFileSync(fx2.filteredPath, JSON.stringify({ status: 'complete', batchDate: '2026-08-28', papers: [] }));
        assert.throws(() => verifyBoundInputs(fx2.state), /filtered 文件字节已变化/);
        const fx3 = fixture(); fx3.state.generation = -1;
        assert.throws(() => validateState(fx3.state), /generation/);
        fs.rmSync(fx.root, { recursive: true, force: true });
        fs.rmSync(fx2.root, { recursive: true, force: true });
        fs.rmSync(fx3.root, { recursive: true, force: true });
    });

    it('不同论文不能共享或嵌套同一 real artifactRoot', () => {
        const fx = fixture(['2608.12345', '2608.54321']);
        register(fx, '2608.12345', 'author');
        const packet = buildTaskPacket({
            role: 'author', paperId: '2608.54321', paperInputSha256: A,
            sourceIdentitySha256: B, contractSha256: C,
            allowedArtifacts: freshEvidenceFor(fx.papers['2608.12345'])
        });
        const packetPath = path.join(fx.papers['2608.12345'].root, 'cross-paper.packet.json');
        fs.writeFileSync(packetPath, JSON.stringify(packet));
        assert.throws(() => registerPacket(fx.state, {
            paperId: '2608.54321', role: 'author', artifactRoot: fx.papers['2608.12345'].root,
            packetPath, controlledTaskRoot: fx.root
        }), /精确等于|单篇隔离/);
        fs.rmSync(fx.root, { recursive: true, force: true });
    });

    it('CLI 参数保持显式 shadow action，不接受隐式执行', () => {
        assert.deepEqual(parseArgs(['claim', '--date', '2026-08-28', '--limit', '3']), {
            command: 'claim', limit: '3', date: '2026-08-28'
        });
        assert.throws(() => parseArgs(['--date', '2026-08-28']), /command/);
        assert.throws(() => parseArgs(['claim', '--date', '2026-08-28', '--unknown', 'x']), /未知参数/);
        assert.equal(parseArgs(['abandon', '--date', '2026-08-28', '--claim', 'x', '--reason', 'confirmed dead']).command, 'abandon');
    });
});
