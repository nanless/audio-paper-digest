'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stableSha256 } = require('../scripts/manual-v6-workflow.js');
const { renderLongformBlocks } = require('../scripts/manual-longform-contract.js');
const { submitTask } = require('../scripts/manual-v6-task-runner.js');
const {
    parseArgs,
    normalizeLegacyArtifactIndexBinding,
    sealRecordFromValidatedState
} = require('../scripts/manual-v6-production-records.js');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value));
    return { path: filePath, fileSha256: sha(fs.readFileSync(filePath)) };
}

function minimalUnsealedLongform(paperId) {
    const artifactIndex = {
        outputSha256: '9'.repeat(64),
        sourceSpans: [], tables: [], figures: [], formulas: [], acronyms: [], citations: []
    };
    const kinds = [
        'prerequisites', 'problem', 'related_work', 'signal_path', 'training',
        'experiment_setup', 'result', 'reproduction', 'limitation'
    ];
    const blocks = kinds.map((kind, index) => ({
        id: `B${String(index + 1).padStart(2, '0')}`,
        kind,
        heading: `教学节点 ${index + 1} 的完整说明`,
        learningObjective: `理解第 ${index + 1} 个节点在论文论证链中的具体职责。`,
        markdown: `这一教学段落专门解释第 ${index + 1} 个节点，并交代它与输入、方法选择、实验比较和结论边界之间的关系。文本保持为论文特有的完整句子，使研究生读者可以沿着问题、信号路径、训练、结果和限制逐步复核论证，同时区分直接报告的事实与尚需额外实验验证的推断。`,
        evidenceSpanIds: [], tableIds: [], figureIds: [], formulaIds: []
    }));
    const article = renderLongformBlocks(blocks);
    return {
        article,
        artifactIndex,
        bundle: {
            version: 2, contract: 'reader-longform-v2', paperId,
            artifactIndexSha256: artifactIndex.outputSha256,
            articleSha256: sha(Buffer.from(article, 'utf8')),
            blocks, tables: [], figures: [], formulas: [], terms: [], relatedWorks: []
        }
    };
}

describe('Manual v6 production records envelope assembler', () => {
    it('CLI 只接受固定日期与显式 force', () => {
        assert.deepEqual(parseArgs(['--date', '2026-08-29']), {
            date: '2026-08-29', force: false
        });
        assert.equal(parseArgs(['--date', '2026-08-29', '--force']).force, true);
        assert.throws(() => parseArgs(['--date', '2026-08-29', '--output', 'x']), /未知参数/);
    });

    it('只把精确等于受控文件 SHA 的 legacy ArtifactIndex 别名改绑为语义 SHA', () => {
        const fileSha = 'a'.repeat(64);
        const semanticSha = 'b'.repeat(64);
        const record = {
            paperId: '2608.12345',
            sourceSnapshot: {
                artifactIndexSha256: fileSha,
                artifactIndexFileSha256: fileSha
            }
        };
        normalizeLegacyArtifactIndexBinding(record, {
            paperId: record.paperId, outputSha256: semanticSha
        }, fileSha);
        assert.equal(record.sourceSnapshot.artifactIndexSha256, semanticSha);
        assert.equal(record.sourceSnapshot.artifactIndexFileSha256, fileSha);
        const legacyObject = { paperId: record.paperId, outputSha256: semanticSha };
        const objectAlias = {
            ...record,
            sourceSnapshot: { ...record.sourceSnapshot, artifactIndexSha256: stableSha256(legacyObject) }
        };
        normalizeLegacyArtifactIndexBinding(objectAlias, legacyObject, fileSha);
        assert.equal(objectAlias.sourceSnapshot.artifactIndexSha256, semanticSha);
        const missingFileIdentity = {
            paperId: record.paperId,
            sourceSnapshot: { artifactIndexSha256: fileSha }
        };
        normalizeLegacyArtifactIndexBinding(missingFileIdentity, {
            paperId: record.paperId, outputSha256: semanticSha
        }, fileSha);
        assert.equal(missingFileIdentity.sourceSnapshot.artifactIndexSha256, semanticSha);
        assert.equal(missingFileIdentity.sourceSnapshot.artifactIndexFileSha256, fileSha);
        const inputIdentity = {
            paperInputSha256: 'd'.repeat(64), sourceIdentitySha256: 'e'.repeat(64),
            sourceSha256: 'f'.repeat(64), structuredArtifactsSha256: '1'.repeat(64)
        };
        const structuredAlias = {
            paperId: record.paperId,
            sourceSnapshot: {
                artifactIndexSha256: inputIdentity.structuredArtifactsSha256,
                artifactIndexFileSha256: fileSha,
                paperInputSha256: inputIdentity.paperInputSha256,
                sourceIdentitySha256: inputIdentity.sourceIdentitySha256,
                sourceSha256: inputIdentity.sourceSha256
            }
        };
        normalizeLegacyArtifactIndexBinding(structuredAlias, {
            paperId: record.paperId, outputSha256: semanticSha, inputIdentity
        }, fileSha);
        assert.equal(structuredAlias.sourceSnapshot.artifactIndexSha256, semanticSha);
        assert.throws(() => normalizeLegacyArtifactIndexBinding({
            ...record,
            sourceSnapshot: { ...record.sourceSnapshot, artifactIndexSha256: 'c'.repeat(64) }
        }, { paperId: record.paperId, outputSha256: semanticSha }, fileSha), /不是当前 SHA/);
    });

    it('从 revision 绑定的无环 payload 与 runner receipts 确定性封印 record', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-v6-seal-'));
        const id = '2608.12345';
        const finalText = '这是最终正文。';
        const finalPath = path.join(root, 'draft', 'final-article.md');
        fs.mkdirSync(path.dirname(finalPath)); fs.writeFileSync(finalPath, `${finalText}\n`);
        const finalSha = sha(Buffer.from(finalText));
        const payload = {
            version: 4, manualDepth: 'full-text-evidence-v6', paperId: id,
            editorial: {
                readerArticle: finalText,
                longformBundle: { version: 2, contract: 'reader-longform-v2', articleSha256: finalSha }
            }
        };
        const payloadFile = writeJson(path.join(root, 'draft', 'revision-record-payload.json'), payload);
        const findings = ['技术结论一具有足够长度并绑定全文证据。', '可读性结论二具有足够长度并绑定教学路径。'];
        const technicalOutput = { findings: [findings[0]] };
        const readabilityOutput = { findings: [findings[1]] };
        const technicalOutputFile = writeJson(path.join(root, 'reviews', 'technical-scoring.json'), technicalOutput);
        const readabilityOutputFile = writeJson(path.join(root, 'reviews', 'pedagogy-readability.json'), readabilityOutput);
        const independentAudit = {
            version: 1,
            contract: 'manual-v6-independent-revision-audit-v1',
            paperId: id,
            taskName: 'revision-audit-task',
            finalPassed: true
        };
        const independentAuditFile = writeJson(
            path.join(root, 'reviews', 'revision-independent-audit.json'),
            independentAudit
        );
        const technicalReceipt = { taskName: 'technical-task', outputSha256: stableSha256(technicalOutput) };
        const readabilityReceipt = { taskName: 'readability-task', outputSha256: stableSha256(readabilityOutput) };
        const authorReceipt = { taskName: 'author-task', articleSha256: 'a'.repeat(64) };
        const authorOutput = { version: 2, contract: 'manual-v6-author-output-v2', paperId: id };
        const authorOutputFile = writeJson(path.join(root, 'outputs', 'author.json'), authorOutput);
        const revisionOutput = {
            version: 2, contract: 'manual-v6-author-revision-output-v2', role: 'author_revision',
            paperId: id, taskName: 'revision-task', passed: true,
            technicalOutputSha256: stableSha256(technicalOutput),
            readabilityOutputSha256: stableSha256(readabilityOutput),
            finalArticleSha256: finalSha,
            finalArticle: { path: 'draft/final-article.md', fileSha256: sha(fs.readFileSync(finalPath)) },
            recordPayload: {
                path: 'draft/revision-record-payload.json', fileSha256: payloadFile.fileSha256,
                semanticSha256: stableSha256(payload)
            },
            independentAudit: {
                path: 'reviews/revision-independent-audit.json',
                fileSha256: independentAuditFile.fileSha256,
                semanticSha256: stableSha256(independentAudit),
                taskName: independentAudit.taskName
            },
            resolvedFindingSha256s: findings.map(stableSha256),
            notes: ['具体修订说明一包含足够细节并对应技术审查结论。', '具体修订说明二包含足够细节并对应可读性审查结论。']
        };
        const revisionOutputFile = writeJson(path.join(root, 'outputs', 'author-revision.json'), revisionOutput);
        const revisionReceipt = {
            taskName: 'revision-task', outputSha256: stableSha256(revisionOutput), articleSha256: finalSha
        };
        const task = (receiptPath, outputPath, outputSemanticSha256) => ({
            artifactRoot: root, receiptPath, outputPath, outputSemanticSha256,
            outputFileSha256: sha(fs.readFileSync(outputPath)),
            receiptFileSha256: sha(fs.readFileSync(receiptPath)),
            receiptSemanticSha256: stableSha256(JSON.parse(fs.readFileSync(receiptPath, 'utf8')))
        });
        const authorReceiptFile = writeJson(path.join(root, 'receipts', 'author.json'), authorReceipt);
        const technicalReceiptFile = writeJson(path.join(root, 'receipts', 'technical.json'), technicalReceipt);
        const readabilityReceiptFile = writeJson(path.join(root, 'receipts', 'readability.json'), readabilityReceipt);
        const revisionReceiptFile = writeJson(path.join(root, 'receipts', 'revision.json'), revisionReceipt);
        const state = { papers: { [id]: { tasks: {
            author: task(authorReceiptFile.path, authorOutputFile.path, stableSha256(authorOutput)),
            technical_scoring: task(technicalReceiptFile.path, technicalOutputFile.path, stableSha256(technicalOutput)),
            pedagogy_readability: task(readabilityReceiptFile.path, readabilityOutputFile.path, stableSha256(readabilityOutput)),
            author_revision: {
                ...task(revisionReceiptFile.path, revisionOutputFile.path, stableSha256(revisionOutput)),
                taskName: 'revision-task'
            }
        } } } };
        for (const [role, runnerTask] of Object.entries(state.papers[id].tasks)) {
            const packet = { packetSha256: stableSha256({ paperId: id, role }) };
            const packetFile = writeJson(path.join(root, 'packets', `${role}.json`), packet);
            runnerTask.packetPath = packetFile.path;
            runnerTask.packetFileSha256 = packetFile.fileSha256;
            runnerTask.packetSha256 = packet.packetSha256;
        }
        const sealed = sealRecordFromValidatedState(state, id, root);
        assert.equal(sealed.record.editorial.longformBundle.authorReceipt.taskName, 'author-task');
        assert.equal(sealed.record.editorial.longformBundle.finalRevisionAuthorReceipt.taskName, 'revision-task');
        assert.equal(sealed.record.reviewResolution.readerArticleSha256, finalSha);
        const semantic = structuredClone(sealed.record); delete semantic.sealedRecordSha256;
        assert.equal(sealed.record.sealedRecordSha256, stableSha256(semantic));
        const firstBytes = fs.readFileSync(sealed.sealedPath);
        sealRecordFromValidatedState(state, id, root);
        assert.ok(firstBytes.equals(fs.readFileSync(sealed.sealedPath)));
        fs.appendFileSync(technicalReceiptFile.path, ' ');
        assert.throws(() => sealRecordFromValidatedState(state, id, root), /runner validated state/);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('production runner 拒绝 revision v1，并在 v2 签名边界重放 records-v3 基础完整性', () => {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'manual-v6-revision-submit-')));
        const id = '2608.12345';
        const claimedAt = '2026-08-29T08:00:00.000+08:00';
        const startedAt = '2026-08-29T08:01:00.000+08:00';
        const completedAt = '2026-08-29T08:10:00.000+08:00';
        const packetSha = 'a'.repeat(64);
        const technicalSha = 'b'.repeat(64);
        const readabilitySha = 'c'.repeat(64);
        const revisionTask = {
            status: 'running', claimId: 'revision-claim', taskName: 'revision-production-task',
            artifactRoot: root, packetSha256: packetSha, claimedAt, startedAt,
            packetFileSha256: 'd'.repeat(64), attempt: 1, error: null
        };
        revisionTask.inputKey = stableSha256({
            contract: 'manual-v6-task-input-v1', paperId: id, role: 'author_revision',
            packetSha256: packetSha, packetFileSha256: revisionTask.packetFileSha256,
            dependencies: [
                { role: 'technical_scoring', outputSemanticSha256: technicalSha },
                { role: 'pedagogy_readability', outputSemanticSha256: readabilitySha }
            ]
        });
        const state = { executionScope: 'production', expectedPaperIds: [id], papers: { [id]: { tasks: {
            author: {},
            author_revision: revisionTask,
            technical_scoring: { outputSemanticSha256: technicalSha },
            pedagogy_readability: { outputSemanticSha256: readabilitySha }
        } } } };
        const outputPath = path.join(root, 'outputs', 'author-revision.json');
        const receiptPath = path.join(root, 'receipts', 'author-revision.json');
        const legacy = {
            version: 1, role: 'author_revision', paperId: id,
            taskName: revisionTask.taskName, passed: true
        };
        writeJson(outputPath, legacy);
        writeJson(receiptPath, {
            role: 'author_revision', paperId: id, taskName: revisionTask.taskName,
            singlePaperOnly: true, isolatedContext: true,
            model: 'gpt-5.6-terra', reasoningEffort: 'high',
            consumedPacketSha256: packetSha, outputSha256: stableSha256(legacy),
            articleSha256: 'e'.repeat(64), queuedAt: claimedAt, startedAt, completedAt, revision: 1
        });
        assert.throws(() => submitTask(state, 'revision-claim', { outputPath, receiptPath }), /revision-output-v2/);
        const { article: text, artifactIndex, bundle } = minimalUnsealedLongform(id);
        const finalPath = path.join(root, 'draft', 'final-article.md');
        fs.mkdirSync(path.dirname(finalPath)); fs.writeFileSync(finalPath, `${text}\n`);
        const finalSha = sha(Buffer.from(text));
        writeJson(path.join(root, 'evidence', 'artifact-index.json'), artifactIndex);
        const payload = {
            version: 4, manualDepth: 'full-text-evidence-v6', paperId: id,
            arxivId: id, type: '方法研究', task: '#语音识别',
            tags: '#语音识别 #Transformer #鲁棒性',
            editorial: {
                readerArticle: text,
                longformBundle: bundle
            }
        };
        const payloadFile = writeJson(path.join(root, 'draft', 'revision-record-payload.json'), payload);
        const output = {
            version: 2, contract: 'manual-v6-author-revision-output-v2', role: 'author_revision',
            paperId: id, taskName: revisionTask.taskName, passed: true,
            technicalOutputSha256: technicalSha, readabilityOutputSha256: readabilitySha,
            finalArticleSha256: finalSha,
            finalArticle: { path: 'draft/final-article.md', fileSha256: sha(fs.readFileSync(finalPath)) },
            recordPayload: {
                path: 'draft/revision-record-payload.json', fileSha256: payloadFile.fileSha256,
                semanticSha256: stableSha256(payload)
            },
            resolvedFindingSha256s: ['f'.repeat(64)],
            notes: ['第一项具体修订说明包含足够长度并明确对应审查发现。', '第二项具体修订说明包含足够长度并明确对应证据边界。']
        };
        writeJson(outputPath, output);
        writeJson(receiptPath, {
            role: 'author_revision', paperId: id, taskName: revisionTask.taskName,
            singlePaperOnly: true, isolatedContext: true,
            model: 'gpt-5.6-terra', reasoningEffort: 'high',
            consumedPacketSha256: packetSha, outputSha256: stableSha256(output),
            articleSha256: finalSha, queuedAt: claimedAt, startedAt, completedAt, revision: 1
        });
        assert.throws(() => submitTask(
            state, 'revision-claim', { outputPath, receiptPath }
        ), /dims/);
        fs.rmSync(root, { recursive: true, force: true });
    });
});
