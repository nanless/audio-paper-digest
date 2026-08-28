'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
    WORKFLOW_STAGES,
    buildTaskPacket,
    validateTaskPacket,
    validateAuthorRevisionArtifactLineage,
    validateManualRecordV4,
    buildPaperSpecShard,
    buildBatchSpecV6,
    planWorkflowReuse
} = require('../scripts/manual-v6-workflow.js');

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);

function freshArtifacts() {
    return [
        { path: 'evidence/paper-metadata.json', sha256: A, kind: 'paper_metadata' },
        { path: 'evidence/source-snapshot.json', sha256: B, kind: 'source_snapshot' },
        { path: 'evidence/fulltext.txt', sha256: C, kind: 'fulltext' },
        { path: 'evidence/artifact-index.json', sha256: D, kind: 'artifact_index' },
        { path: 'instructions/manual-tutorial-article.md', sha256: A, kind: 'authoring_prompt' },
        { path: 'instructions/manual-editorial-reference-contract.md', sha256: B, kind: 'editorial_contract' },
        { path: 'schema/blank-record.json', sha256: C, kind: 'record_template' }
    ];
}

describe('Manual v6 workflow and Merkle spec', () => {
    it('task packet 只允许单篇根内的内容寻址工件', () => {
        const packet = buildTaskPacket({
            role: 'technical_scoring', paperId: '2608.12345',
            paperInputSha256: A, sourceIdentitySha256: B, contractSha256: C,
            allowedArtifacts: [
                { path: 'artifact-index.json', sha256: D, kind: 'artifact_index' },
                { path: 'packets/evidence.json', sha256: A, kind: 'evidence_packet' }
            ]
        });
        assert.doesNotThrow(() => validateTaskPacket(packet, { paperId: '2608.12345' }));
        assert.throws(() => buildTaskPacket({ ...packet, allowedArtifacts: [
            { path: '../2608.99999/fulltext.txt', sha256: A, kind: 'fulltext' }
        ] }), /安全相对路径/);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-v6-packet-'));
        const artifactPath = path.join(root, 'artifact-index.json');
        fs.writeFileSync(artifactPath, '{"paper":"2608.12345"}');
        const artifactSha = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
        const filePacket = buildTaskPacket({
            role: 'technical_scoring', paperId: '2608.12345',
            paperInputSha256: A, sourceIdentitySha256: B, contractSha256: C,
            allowedArtifacts: [{ path: 'artifact-index.json', sha256: artifactSha, kind: 'artifact_index' }]
        });
        assert.doesNotThrow(() => validateTaskPacket(filePacket, {
            paperId: '2608.12345', artifactRoot: root, requireFiles: true
        }));
        fs.writeFileSync(artifactPath, '{"paper":"2608.99999"}');
        assert.throws(() => validateTaskPacket(filePacket, {
            paperId: '2608.12345', artifactRoot: root, requireFiles: true
        }), /文件 SHA 不匹配/);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('author 与 author_revision 都必须从论文证据冷启动，旧正文不能进入写作输入', () => {
        const author = buildTaskPacket({
            role: 'author', paperId: '2608.12345',
            paperInputSha256: A, sourceIdentitySha256: B, contractSha256: C,
            allowedArtifacts: freshArtifacts()
        });
        assert.equal(author.version, 3);
        assert.equal(author.authoringMode, 'fresh_from_evidence');
        assert.throws(() => buildTaskPacket({
            role: 'author', paperId: '2608.12345',
            paperInputSha256: A, sourceIdentitySha256: B, contractSha256: C,
            allowedArtifacts: [{ path: 'draft/article.md', sha256: D, kind: 'reader_article' }]
        }), /确定性权威白名单/);
        assert.throws(() => buildTaskPacket({
            role: 'author_revision', paperId: '2608.12345',
            paperInputSha256: A, sourceIdentitySha256: B, contractSha256: C,
            allowedArtifacts: [{ path: 'article.md', sha256: D, kind: 'fulltext' }]
        }), /确定性权威白名单/);
        const replacement = buildTaskPacket({
            role: 'author_revision', paperId: '2608.12345',
            paperInputSha256: A, sourceIdentitySha256: B, contractSha256: C,
            allowedArtifacts: [
                ...freshArtifacts(),
                { path: 'reviews/technical-scoring.json', sha256: B, kind: 'technical_review' },
                { path: 'reviews/pedagogy-readability.json', sha256: C, kind: 'readability_review' }
            ]
        });
        assert.equal(replacement.authoringMode, 'fresh_replacement_from_evidence_and_findings');
        assert.throws(() => buildTaskPacket({
            role: 'author', paperId: '2608.12345',
            paperInputSha256: A, sourceIdentitySha256: B, contractSha256: C,
            allowedArtifacts: freshArtifacts().map(item => item.kind === 'fulltext'
                ? { ...item, path: 'evidence/table.json', kind: 'paper_table' }
                : item)
        }), /确定性权威白名单/);
        assert.doesNotThrow(() => validateAuthorRevisionArtifactLineage(author, replacement, {
            technical: { path: 'reviews/technical-scoring.json', sha256: B },
            readability: { path: 'reviews/pedagogy-readability.json', sha256: C }
        }));
        const changedEvidence = buildTaskPacket({
            role: 'author_revision', paperId: '2608.12345',
            paperInputSha256: A, sourceIdentitySha256: B, contractSha256: C,
            allowedArtifacts: [
                ...freshArtifacts().map(item => item.kind === 'fulltext' ? { ...item, sha256: D } : item),
                { path: 'reviews/technical-scoring.json', sha256: B, kind: 'technical_review' },
                { path: 'reviews/pedagogy-readability.json', sha256: C, kind: 'readability_review' }
            ]
        });
        assert.throws(() => validateAuthorRevisionArtifactLineage(author, changedEvidence, {
            technical: { path: 'reviews/technical-scoring.json', sha256: B },
            readability: { path: 'reviews/pedagogy-readability.json', sha256: C }
        }), /逐项复用 author/);
    });

    it('task packet 通过 symlink 指向根外文件时 fail closed', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-v6-root-'));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-v6-outside-'));
        const outsidePath = path.join(outside, 'artifact.json');
        fs.writeFileSync(outsidePath, '{"paper":"2608.12345"}');
        fs.symlinkSync(outsidePath, path.join(root, 'artifact.json'));
        const sha256 = crypto.createHash('sha256').update(fs.readFileSync(outsidePath)).digest('hex');
        const packet = buildTaskPacket({
            role: 'technical_scoring', paperId: '2608.12345',
            paperInputSha256: A, sourceIdentitySha256: B, contractSha256: C,
            allowedArtifacts: [{ path: 'artifact.json', sha256, kind: 'artifact_index' }]
        });
        assert.throws(() => validateTaskPacket(packet, {
            paperId: '2608.12345', artifactRoot: root, requireFiles: true
        }), /符号链接|逃逸/);
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    });

    it('batch spec 始终列出完整 expected IDs，缺 shard 时只能 running', () => {
        const shard = buildPaperSpecShard({
            paperId: '2608.12345', sealedRecordSha256: A, paperInputSha256: B,
            recordFileSha256: B, recordsEnvelopeFileSha256: C,
            sourceIdentitySha256: C, artifactIndexSha256: D,
            artifactIndexFileSha256: A, readerLongformSha256: B,
            taskEvidenceSha256: C, paperPayloadSha256: D,
            assemblerProtocolSha256: A
        });
        const partial = buildBatchSpecV6({
            date: '2026-08-28', filteredBatchSha256: B,
            expectedPaperIds: ['2608.12345', '2608.54321'], paperShards: [shard]
        });
        assert.equal(partial.status, 'running');
        assert.equal(partial.rootSha256, null);
        assert.equal(partial.paperIndex['2608.54321'].status, 'pending');
        const second = buildPaperSpecShard({
            paperId: '2608.54321', sealedRecordSha256: B, paperInputSha256: C,
            recordFileSha256: C, recordsEnvelopeFileSha256: D,
            sourceIdentitySha256: D, artifactIndexSha256: A,
            artifactIndexFileSha256: B, readerLongformSha256: C,
            taskEvidenceSha256: D, paperPayloadSha256: A,
            assemblerProtocolSha256: A
        });
        const complete = buildBatchSpecV6({
            date: '2026-08-28', filteredBatchSha256: B,
            expectedPaperIds: ['2608.54321', '2608.12345'], paperShards: [second, shard]
        });
        assert.equal(complete.status, 'complete');
        assert.match(complete.rootSha256, /^[a-f0-9]{64}$/);
        assert.throws(() => buildBatchSpecV6({
            date: '2026-08-28', filteredBatchSha256: B,
            expectedPaperIds: ['2608.12345'], paperShards: [shard, shard]
        }), /重复论文/);
    });

    it('paper shard 拒绝缺少真实文件 SHA 的语义-only provenance', () => {
        assert.throws(() => buildPaperSpecShard({
            paperId: '2608.12345', sealedRecordSha256: A,
            paperInputSha256: B, sourceIdentitySha256: C,
            artifactIndexSha256: D, readerLongformSha256: A,
            taskEvidenceSha256: B, paperPayloadSha256: C,
            assemblerProtocolSha256: D
        }), /recordFileSha256/);
    });

    it('records v4 不能用长文和若干 SHA 绕开完整 v5 record 门禁', () => {
        const hollow = {
            version: 4, manualDepth: 'full-text-evidence-v6', paperId: '2608.12345',
            sourceSnapshot: {
                paperInputSha256: A, sourceIdentitySha256: B,
                artifactIndexSha256: C, artifactIndexFileSha256: D
            },
            editorial: { readerArticle: '占位正文'.repeat(700), longformBundle: {} },
            reviewReceipts: {}, sealedRecordSha256: A
        };
        assert.throws(() => validateManualRecordV4(hollow, {
            paperId: '2608.12345', outputSha256: C
        }), /type 非法/);
    });

    it('局部 input key 变化只失效该节点及其后代分支', () => {
        const nodes = Object.fromEntries(WORKFLOW_STAGES.map(stage => [stage, {
            status: 'complete', inputKey: A, outputSha256: B
        }]));
        const state = { version: 1, paperId: '2608.12345', nodes };
        const keys = Object.fromEntries(WORKFLOW_STAGES.map(stage => [stage, A]));
        keys.technical_scoring = C;
        const plan = planWorkflowReuse(state, keys);
        assert.ok(plan.reusable.includes('pedagogy_readability'));
        assert.ok(plan.stale.includes('technical_scoring'));
        assert.ok(plan.stale.includes('sealed_record'));
        assert.ok(plan.stale.includes('final_page_review'));
        assert.ok(!plan.stale.includes('artifact_index'));
    });

    it('v6 签名对象接受真实小数评分并拒绝非法数字/非 ASCII key', () => {
        const { stableSha256 } = require('../scripts/manual-v6-workflow.js');
        assert.match(stableSha256({ score: 1.7, subscore: 1.4 }), /^[a-f0-9]{64}$/);
        assert.throws(() => stableSha256({ score: Number.NaN }), /NaN/);
        assert.throws(() => stableSha256({ '论文': 'audio' }), /key/);
        assert.match(stableSha256({ text: '音频', score: 1 }), /^[a-f0-9]{64}$/);
    });
});
