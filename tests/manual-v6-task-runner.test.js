'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Config = require('../scripts/config.js');
const {
    buildTaskPacket, stableSha256, validateReviewOutput
} = require('../scripts/manual-v6-workflow.js');
const { computeArtifactIndexSha256 } = require('../scripts/manual-artifact-index.js');
const { buildFilteredBatchFingerprint, buildPaperInputIdentity } = require('../scripts/manual-fetch-fulltext.js');
const { buildBlankRecordSkeleton } = require('../scripts/manual-v6-production-packet.js');
const {
    ACTIVE_LIMIT, initializeState, registerPacket, claimTasks, startTask, submitTask,
    failTask, retryTask, abandonTask, verifyBoundInputs, validateState, stateSummary,
    runnerPaths, recordsEnvelopeStatus, validateProductionAuthorOutput, parseArgs
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

function writeProductionAuthorDraft(root, draft, output, receipt) {
    const draftPath = path.join(root, 'draft', 'author-record.json');
    fs.writeFileSync(draftPath, JSON.stringify(draft));
    output.recordDraft.fileSha256 = bytesSha(draftPath);
    output.recordDraft.semanticSha256 = stableSha256(draft);
    receipt.outputSha256 = stableSha256(output);
    return receipt.outputSha256;
}

function fixture(ids = ['2608.12345'], executionScope = 'shadow') {
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
        }, executionScope)
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
    if (role === 'pedagogy_readability') {
        output.readabilityRubric = {
            paperId: claim.paperId,
            independentReview: true,
            reviewerTaskName: taskName,
            model: 'gpt-5.6-terra',
            reasoningEffort: 'high',
            dimensions: Object.fromEntries([
                'paragraphLogic', 'interParagraphContinuity', 'sectionResponsibility',
                'factLocality', 'terminologyAndPerspective', 'sentenceRhythm',
                'antiTemplateOriginality'
            ].map((dimension, index) => [dimension, {
                score: index === 0 ? 1 : 2,
                reason: `${dimension} 已由独立审查者结合本篇正文与局部证据完成核验。`,
                evidence: [index % 2 === 0 ? 'TAB0001' : 'SEC0002']
            }]))
        };
    } else {
        output.dims = [1.5, 1.2, 1.1, 0.8, 1.0, 0.5, 0.3, 1.0];
        output.confidence = '中';
        output.scoringReasons = Array.from({ length: 8 }, (_, index) => (
            `第${index + 1}维评分已结合本篇方法、实验结果和未报告信息边界独立校准。`
        ));
        output.scoringCalibration = {
            version: 1, independentReview: true, reviewerTaskName: taskName,
            model: 'gpt-5.6-terra', reasoningEffort: 'high',
            crossDimensionChecked: true, batchScaleChecked: true,
            calibrationNotes: '八个评分维度已经逐项回到本篇局部证据，并检查维度间重复计分、未报告信息和全批次尺度一致性。',
            evidenceIdsByDimension: Object.fromEntries([
                'innovation', 'technicalRigor', 'experimentalSufficiency', 'clarity',
                'impact', 'openSource', 'reproducibility', 'engineering'
            ].map(key => [key, ['TAB0001']]))
        };
    }
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
        outputSha256: stableSha256(output), queuedAt, startedAt, completedAt, revision: 1
    }));
    submitTask(fx.state, claim.claimId, { outputPath, receiptPath });
}

describe('Manual v6 persistent task runner', () => {
    it('production author submit 在接收签名草稿时门禁 type/task/tags', () => {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'manual-v6-author-base-')));
        fs.mkdirSync(path.join(root, 'draft'));
        const articlePath = path.join(root, 'draft', 'author-article.md');
        fs.writeFileSync(articlePath, '单篇论文初稿正文。\n');
        const articleSha256 = crypto.createHash('sha256').update('单篇论文初稿正文。').digest('hex');
        const task = {
            artifactRoot: root, taskName: 'author-base-contract', packetSha256: A,
            claimedAt: queuedAt, startedAt
        };
        const output = {
            version: 2, contract: 'manual-v6-author-output-v2', role: 'author',
            paperId: '2608.12345', taskName: task.taskName, passed: true,
            articleSha256,
            article: { path: 'draft/author-article.md', fileSha256: bytesSha(articlePath) },
            recordDraft: { path: 'draft/author-record.json', fileSha256: '', semanticSha256: '' }
        };
        const receipt = {
            inputPacketSha256: A, articleSha256, outputSha256: ''
        };
        const base = buildBlankRecordSkeleton('2608.12345');
        Object.assign(base, {
            type: '方法研究', task: '#语音识别',
            tags: '#语音识别 #Transformer #鲁棒性', evidenceLedger: [{ id: 'E1' }],
            question: '研究问题完整说明了当前技术输入、预期输出与现有系统的关键局限。',
            method: '方'.repeat(80), method2: '法'.repeat(80), method3: '路'.repeat(80),
            innovations: '创'.repeat(60), results: '果'.repeat(80), details: '细'.repeat(80),
            limits: '限'.repeat(60), open: '开'.repeat(20), review: '评'.repeat(40)
        });
        Object.assign(base.authorInfo, {
            firstAuthorAffiliation: '测试大学', correspondingAuthors: '测试作者',
            affiliations: '测试大学', sourceQuote: 'Test Author, Test University'
        });
        let semanticSha = writeProductionAuthorDraft(root, base, output, receipt);
        assert.doesNotThrow(() => validateProductionAuthorOutput(
            output, receipt, task, '2608.12345', semanticSha
        ));

        semanticSha = writeProductionAuthorDraft(root, { ...base, type: 'benchmark' }, output, receipt);
        assert.doesNotThrow(() => validateProductionAuthorOutput(
            output, receipt, task, '2608.12345', semanticSha
        ));
        for (const [draft, pattern] of [
            [{ ...base, type: 'system/method paper' }, /type 必须是受控文档类型/],
            [{ ...base, type: '' }, /type 必须是受控文档类型/],
            [{ ...base, task: '语音识别' }, /task 必须是单个合法/],
            [{ ...base, tags: ['#语音识别', '#Transformer', '#鲁棒性'] }, /tags 必须是 3-5 个空格分隔/]
        ]) {
            semanticSha = writeProductionAuthorDraft(root, draft, output, receipt);
            assert.throws(() => validateProductionAuthorOutput(
                output, receipt, task, '2608.12345', semanticSha
            ), pattern);
        }
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('technical review 在 runner submit 前强制正式 V6 八维评分闭环', () => {
        const paperId = '2608.12345';
        const taskName = 'technical-schema-review';
        const output = {
            version: 1, role: 'technical_scoring', paperId, taskName,
            passed: true, issues: [],
            findings: [
                '第一条技术审查结论已经结合本篇局部证据核对方法与结果边界。',
                '第二条技术审查结论已经核对八维分数与论文实际证据强度。'
            ],
            evidenceChecks: [
                { claim: '主结果比较方向与局部表格证据一致', evidenceId: 'E1', verified: true },
                { claim: '方法限制与论文原文证据边界一致', evidenceId: 'E2', verified: true }
            ]
        };
        let receipt = { taskName, outputSha256: stableSha256(output) };
        assert.throws(() => validateReviewOutput(
            output, 'technical_scoring', paperId, receipt, 'review'
        ), /dims/);
        Object.assign(output, {
            dims: [1.5, 1.2, 1.1, 0.8, 1.0, 0.5, 0.3, 1.0],
            confidence: '中',
            scoringReasons: Array.from({ length: 8 }, (_, index) => (
                `第${index + 1}维评分已结合本篇方法、实验和局部证据边界独立校准。`
            )),
            scoringCalibration: {
                version: 1, independentReview: true, reviewerTaskName: taskName,
                model: 'gpt-5.6-terra', reasoningEffort: 'high',
                crossDimensionChecked: true, batchScaleChecked: true,
                calibrationNotes: '八个维度已经逐项回到本篇证据，并检查维度间重复计分、未报告信息和全批次尺度的一致性。',
                evidenceIdsByDimension: Object.fromEntries([
                    'innovation', 'technicalRigor', 'experimentalSufficiency', 'clarity',
                    'impact', 'openSource', 'reproducibility', 'engineering'
                ].map(key => [key, ['E1']]))
            }
        });
        receipt = { taskName, outputSha256: stableSha256(output) };
        assert.doesNotThrow(() => validateReviewOutput(
            output, 'technical_scoring', paperId, receipt, 'review'
        ));
        output.dims[5] = 0.7;
        receipt.outputSha256 = stableSha256(output);
        assert.throws(() => validateReviewOutput(
            output, 'technical_scoring', paperId, receipt, 'review'
        ), /开源评分锚点/);
    });

    it('pedagogy review 强制绑定 canonical 7 维 Terra-high 独立量表', () => {
        const paperId = '2608.12345';
        const taskName = 'pedagogy-schema-review';
        const output = {
            version: 1, role: 'pedagogy_readability', paperId, taskName,
            passed: true, issues: [],
            findings: [
                '第一条审查结论已经结合本篇正文段落和局部证据完成独立核验。',
                '第二条审查结论已经核对术语解释、事实邻近性和章节职责边界。'
            ],
            evidenceChecks: [
                { claim: '主结果比较与受控表格证据保持一致', evidenceId: 'TAB0001', verified: true },
                { claim: '方法边界与正文局部证据保持一致', evidenceId: 'SEC0002', verified: true }
            ]
        };
        let receipt = { taskName, outputSha256: stableSha256(output) };
        assert.throws(() => validateReviewOutput(
            output, 'pedagogy_readability', paperId, receipt, 'review'
        ), /readabilityRubric/);
        output.readabilityRubric = {
            paperId, independentReview: true, reviewerTaskName: taskName,
            model: 'gpt-5.6-terra', reasoningEffort: 'high',
            dimensions: Object.fromEntries([
                'paragraphLogic', 'interParagraphContinuity', 'sectionResponsibility',
                'factLocality', 'terminologyAndPerspective', 'sentenceRhythm',
                'antiTemplateOriginality'
            ].map((dimension, index) => [dimension, {
                score: index === 0 ? 1 : 2,
                reason: `${dimension} 已结合本篇局部证据完成独立核验。`,
                evidence: ['SEC0002']
            }]))
        };
        receipt = { taskName, outputSha256: stableSha256(output) };
        assert.doesNotThrow(() => validateReviewOutput(
            output, 'pedagogy_readability', paperId, receipt, 'review'
        ));
    });

    it('production 拒绝 v1 author output，并只接受重开真实 article/record draft 的 v2 descriptor', () => {
        const fx = fixture(['2608.12345'], 'production');
        register(fx, '2608.12345', 'author');
        const claim = claimTasks(fx.state, 1, queuedAt).claimed[0];
        startTask(fx.state, claim.claimId, 'production-author-2608-12345', startedAt);
        const task = fx.state.papers['2608.12345'].tasks.author;
        const outputPath = path.join(fx.papers['2608.12345'].root, 'outputs', 'author.json');
        const receiptPath = path.join(fx.papers['2608.12345'].root, 'receipts', 'author.json');
        fs.mkdirSync(path.dirname(outputPath)); fs.mkdirSync(path.dirname(receiptPath));
        fs.writeFileSync(outputPath, JSON.stringify({
            version: 1, role: 'author', paperId: '2608.12345', taskName: task.taskName,
            passed: true, articleSha256: A
        }));
        fs.writeFileSync(receiptPath, JSON.stringify({
            paperId: '2608.12345', taskName: task.taskName, singlePaperOnly: true,
            isolatedContext: true, model: 'gpt-5.6-terra', reasoningEffort: 'high',
            inputPacketSha256: task.packetSha256, articleSha256: A,
            queuedAt, startedAt, completedAt, revision: 1
        }));
        assert.throws(() => submitTask(fx.state, claim.claimId, { outputPath, receiptPath }), /output-v2/);
        const articlePath = path.join(fx.papers['2608.12345'].root, 'draft', 'author-article.md');
        const draftPath = path.join(fx.papers['2608.12345'].root, 'draft', 'author-record.json');
        fs.mkdirSync(path.dirname(articlePath));
        fs.writeFileSync(articlePath, '一篇只属于当前论文且由真实文件绑定的初稿正文。\n');
        const articleSha256 = crypto.createHash('sha256')
            .update('一篇只属于当前论文且由真实文件绑定的初稿正文。').digest('hex');
        const draft = buildBlankRecordSkeleton('2608.12345');
        Object.assign(draft, {
            type: '方法研究', task: '#语音识别',
            tags: '#语音识别 #Transformer #鲁棒性',
            evidenceLedger: [{ id: 'E1', claim: '当前论文的可回放局部证据。' }],
            question: '研究问题完整说明了当前技术输入、预期输出与现有系统的关键局限。',
            method: '方'.repeat(80), method2: '法'.repeat(80), method3: '路'.repeat(80),
            innovations: '创'.repeat(60), results: '果'.repeat(80), details: '细'.repeat(80),
            limits: '限'.repeat(60), open: '开'.repeat(20), review: '评'.repeat(40)
        });
        Object.assign(draft.authorInfo, {
            firstAuthorAffiliation: '测试大学', correspondingAuthors: '测试作者',
            affiliations: '测试大学', sourceQuote: 'Test Author, Test University'
        });
        fs.writeFileSync(draftPath, JSON.stringify(draft));
        fs.writeFileSync(outputPath, JSON.stringify({
            version: 2, contract: 'manual-v6-author-output-v2', role: 'author',
            paperId: '2608.12345', taskName: task.taskName, passed: true, articleSha256,
            article: { path: 'draft/author-article.md', fileSha256: bytesSha(articlePath) },
            recordDraft: {
                path: 'draft/author-record.json', fileSha256: bytesSha(draftPath),
                semanticSha256: stableSha256(draft)
            }
        }));
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        receipt.articleSha256 = articleSha256;
        receipt.outputSha256 = stableSha256(JSON.parse(fs.readFileSync(outputPath, 'utf8')));
        receipt.consumedPacketSha256 = task.packetSha256;
        delete receipt.inputPacketSha256;
        fs.writeFileSync(receiptPath, JSON.stringify(receipt));
        assert.throws(() => submitTask(fx.state, claim.claimId, { outputPath, receiptPath }), /input packet/);
        receipt.inputPacketSha256 = task.packetSha256;
        fs.writeFileSync(receiptPath, JSON.stringify(receipt));
        assert.equal(submitTask(fx.state, claim.claimId, { outputPath, receiptPath }).status, 'validated');
        fs.rmSync(fx.root, { recursive: true, force: true });
    });
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
        Object.assign(output, {
            dims: [1.5, 1.2, 1.1, 0.8, 1.0, 0.5, 0.3, 1.0],
            confidence: '中',
            scoringReasons: Array.from({ length: 8 }, (_, index) => (
                `第${index + 1}维评分已结合本篇方法、实验结果和未报告信息边界独立校准。`
            )),
            scoringCalibration: {
                version: 1, independentReview: true, reviewerTaskName: 'technical-2608-12345',
                model: 'gpt-5.6-terra', reasoningEffort: 'high',
                crossDimensionChecked: true, batchScaleChecked: true,
                calibrationNotes: '八个评分维度已经逐项回到本篇局部证据，并检查维度间重复计分、未报告信息和全批次尺度一致性。',
                evidenceIdsByDimension: Object.fromEntries([
                    'innovation', 'technicalRigor', 'experimentalSufficiency', 'clarity',
                    'impact', 'openSource', 'reproducibility', 'engineering'
                ].map(key => [key, ['table-1']]))
            }
        });
        const outputPath = path.join(fx.papers['2608.12345'].root, 'reviews', 'technical-scoring.json');
        const receiptPath = path.join(fx.papers['2608.12345'].root, 'technical-receipt.json');
        fs.writeFileSync(outputPath, JSON.stringify(output));
        const receipt = {
            role: 'technical_scoring', paperId: '2608.12345', taskName: output.taskName,
            singlePaperOnly: true, isolatedContext: true, model: 'gpt-5.6-sol', reasoningEffort: 'high',
            consumedPacketSha256: fx.state.papers['2608.12345'].tasks.technical_scoring.packetSha256,
            outputSha256: stableSha256(output), queuedAt, startedAt, completedAt, revision: 1
        };
        fs.writeFileSync(receiptPath, JSON.stringify(receipt));
        assert.throws(() => submitTask(fx.state, claim.claimId, { outputPath, receiptPath }), /Terra-high/);
        receipt.model = 'gpt-5.6-terra'; receipt.outputSha256 = A;
        fs.writeFileSync(receiptPath, JSON.stringify(receipt));
        assert.throws(() => submitTask(fx.state, claim.claimId, { outputPath, receiptPath }), /语义 SHA/);
        receipt.outputSha256 = stableSha256(output); delete receipt.queuedAt;
        fs.writeFileSync(receiptPath, JSON.stringify(receipt));
        assert.throws(() => submitTask(fx.state, claim.claimId, { outputPath, receiptPath }), /claim\/start/);
        receipt.queuedAt = queuedAt;
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

    it('上游 review 显式 retry 必须清空下游 revision packet 并允许重新物化', () => {
        const fx = fixture();
        const author = register(fx, '2608.12345', 'author');
        validateAuthor(fx);
        register(fx, '2608.12345', 'technical_scoring');
        register(fx, '2608.12345', 'pedagogy_readability');
        submitReview(fx, 'technical_scoring', 'technical-retry-lineage');
        submitReview(fx, 'pedagogy_readability', 'readability-retry-lineage');
        const paper = fx.papers['2608.12345'];
        const revision = buildTaskPacket({
            role: 'author_revision', paperId: '2608.12345',
            paperInputSha256: paper.paperInputSha256,
            sourceIdentitySha256: paper.sourceIdentitySha256,
            contractSha256: C,
            allowedArtifacts: [
                ...author.packet.allowedArtifacts.map(({ path: artifactPath, sha256, kind }) => ({
                    path: artifactPath, sha256, kind
                })),
                {
                    path: 'reviews/technical-scoring.json',
                    sha256: bytesSha(path.join(paper.root, 'reviews', 'technical-scoring.json')),
                    kind: 'technical_review'
                },
                {
                    path: 'reviews/pedagogy-readability.json',
                    sha256: bytesSha(path.join(paper.root, 'reviews', 'pedagogy-readability.json')),
                    kind: 'readability_review'
                }
            ]
        });
        const revisionPath = path.join(paper.root, 'author-revision-retry.packet.json');
        fs.writeFileSync(revisionPath, JSON.stringify(revision));
        registerPacket(fx.state, {
            paperId: '2608.12345', role: 'author_revision', artifactRoot: paper.root,
            packetPath: revisionPath, controlledTaskRoot: fx.root
        });
        assert.ok(fx.state.papers['2608.12345'].tasks.author_revision.packetPath);

        assert.doesNotThrow(() => retryTask(fx.state, '2608.12345', 'pedagogy_readability'));
        const tasks = fx.state.papers['2608.12345'].tasks;
        assert.equal(tasks.pedagogy_readability.status, 'pending');
        assert.ok(tasks.pedagogy_readability.packetPath);
        assert.equal(tasks.author_revision.status, 'awaiting_packet');
        assert.equal(tasks.author_revision.packetPath, null);
        assert.doesNotThrow(() => validateState(fx.state));
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

    it('CLI 默认进入生产 v6，shadow 必须显式声明，且不接受隐式 action', () => {
        assert.deepEqual(parseArgs(['claim', '--date', '2026-08-28', '--limit', '3']), {
            command: 'claim', limit: '3', shadow: false, date: '2026-08-28'
        });
        assert.equal(parseArgs(['status', '--date', '2026-08-28', '--shadow']).shadow, true);
        assert.throws(() => parseArgs(['status', '--date', '2026-08-28', '--shadow', '--shadow']), /参数重复/);
        assert.throws(() => parseArgs(['--date', '2026-08-28']), /command/);
        assert.throws(() => parseArgs(['claim', '--date', '2026-08-28', '--unknown', 'x']), /未知参数/);
        assert.equal(parseArgs(['abandon', '--date', '2026-08-28', '--claim', 'x', '--reason', 'confirmed dead']).command, 'abandon');
    });

    it('runner 默认根是 manual-v6，status 明示人工边界与 records envelope 缺口', () => {
        const paths = runnerPaths('2026-08-28');
        assert.match(paths.root, /data\/current\/manual-v6\/2026-08-28\/task-runner$/);
        assert.doesNotMatch(paths.root, /manual-v6-shadow/);
        assert.equal(Config.FILES.manualV6MetricsDir, Config.FILES.manualV6Dir);
        assert.notEqual(Config.FILES.manualV6MetricsDir, Config.FILES.manualV6ShadowMetricsDir);
        const fx = fixture();
        const summary = stateSummary(fx.state, {
            executionScope: 'production',
            recordsEnvelope: { status: 'awaiting_records_envelope', path: '/controlled/records-v4.json', fileSha256: null }
        });
        assert.equal(summary.workflow, 'manual-v6-production');
        assert.equal(summary.recordsContract, 'manual_analysis_records_v4');
        assert.equal(summary.specContract, 'manual_analysis_spec_v6');
        assert.equal(summary.packetPreparationStatus, 'awaiting_packet');
        assert.equal(summary.recordsEnvelope.status, 'awaiting_records_envelope');
        assert.equal(summary.orchestrationBoundary.createsSubagents, false);
        assert.match(summary.orchestrationBoundary.nextAction, /materialize and register exact per-role packets/);
        fs.rmSync(fx.root, { recursive: true, force: true });
    });

    it('records-v4 envelope 只报告真实普通文件并绑定 bytes SHA，symlink fail closed', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-v6-envelope-'));
        const dateRoot = path.join(root, '2026-08-28');
        fs.mkdirSync(dateRoot);
        const missing = recordsEnvelopeStatus(root, '2026-08-28');
        assert.equal(missing.status, 'awaiting_records_envelope');
        const recordsPath = path.join(dateRoot, 'records-v4.json');
        fs.writeFileSync(recordsPath, '{"version":4}\n');
        const present = recordsEnvelopeStatus(root, '2026-08-28');
        assert.equal(present.status, 'present_pending_spec_validation');
        assert.equal(present.path, fs.realpathSync(recordsPath));
        assert.equal(present.bytes, fs.readFileSync(recordsPath).length);
        assert.equal(present.fileSha256, bytesSha(recordsPath));
        fs.unlinkSync(recordsPath);
        const target = path.join(dateRoot, 'target.json');
        fs.writeFileSync(target, '{}');
        fs.symlinkSync(target, recordsPath);
        assert.throws(() => recordsEnvelopeStatus(root, '2026-08-28'), /普通文件且不得为 symlink/);
        fs.rmSync(root, { recursive: true, force: true });
    });
});
