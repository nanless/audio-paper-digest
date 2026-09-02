'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    AUTHOR_OUTPUT_CONTRACT,
    buildBlankRecordSkeleton,
    buildBlankRecordSchema,
    materializeAuthorizedFigures,
    normalizeAuthorOwnedBaseFields,
    parseArgs,
    sniffImageMime,
    validateAuthorOutputDescriptor,
    validateAuthorOwnedRecordDraft
} = require('../scripts/manual-v6-production-packet.js');
const { taskOutputContract } = require('../scripts/manual-v6-workflow.js');
const { stableSha256 } = require('../scripts/manual-v6-workflow.js');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function populateAuthorMinimums(draft) {
    Object.assign(draft, {
        question: '研究问题的完整表述必须清楚说明输入、目标和现有方法的局限。',
        method: '方'.repeat(80),
        method2: '法'.repeat(80),
        method3: '路'.repeat(80),
        innovations: '创'.repeat(60),
        results: '果'.repeat(80),
        details: '细'.repeat(80),
        limits: '限'.repeat(60),
        open: '开源与复现状态必须基于论文或官方项目的可核验证据。',
        review: '评'.repeat(40)
    });
    Object.assign(draft.authorInfo, {
        firstAuthorAffiliation: '测试大学语音实验室',
        correspondingAuthors: '测试作者',
        affiliations: '测试大学',
        sourceQuote: 'Test Author, Test University Speech Laboratory'
    });
    return draft;
}

describe('Manual v6 production packet materializer', () => {
    it('新 packet 内联角色输出 schema 与稳定签名算法，旧 packet 仍可兼容校验', () => {
        const technical = taskOutputContract('technical_scoring');
        assert.equal(technical.fixedOutputPath, 'reviews/technical-scoring.json');
        assert.equal(technical.fixedReceiptPath, 'receipts/technical-scoring.json');
        assert.deepEqual(technical.dims.maxima, [2, 1.5, 1.5, 1, 1.5, 1.5, 0.5, 1.5]);
        assert.match(technical.receipt.semanticShaAlgorithm, /stable-json-ascii-keys-exact-ieee754/);
    });

    it('CLI 固定单篇 role，blank schema 不含已填写 prose', () => {
        assert.deepEqual(parseArgs([
            '--date', '2026-08-29', '--paper', '2608.12345v2', '--role', 'author'
        ]), { date: '2026-08-29', paper: '2608.12345', role: 'author' });
        const blank = buildBlankRecordSchema('2608.12345');
        assert.equal(blank.populated, false);
        assert.equal(blank.authorOutputDescriptor.contract, 'manual-v6-author-output-v2');
        assert.equal(blank.authorOutputDescriptor.paperId, '2608.12345');
        assert.deepEqual(blank.authorOutputDescriptor.article, {
            path: 'draft/author-article.md', fileSha256: 'SHA256_OF_RAW_FILE_BYTES'
        });
        assert.equal(blank.authorOutputDescriptor.recordDraft.path, 'draft/author-record.json');
        assert.deepEqual(blank.allowedDocumentTypes, [
            '方法研究', '系统技术报告', '模型报告', '数据集与基准',
            '综述', '理论研究', '应用研究'
        ]);
        assert.match(blank.fields.authorOwnedBase.tags, /arrays are forbidden/);
        assert.ok(blank.authorOwnedRequiredFields.includes('manualAudit'));
        assert.ok(blank.authorOwnedRequiredFields.includes('editorial'));
        assert.equal(blank.fixedPaths.authorArticle, 'draft/author-article.md');
        assert.equal(blank.authorReceipt.requiredIdentity.model, 'gpt-5.6-terra');
        assert.ok(blank.fields.editorial.longformBundle.required.includes('blocks'));
        assert.ok(blank.fields.editorial.longformBundle.required.includes('tables'));
        assert.ok(blank.fields.editorial.longformBundle.required.includes('relatedWorks'));
        assert.ok(!blank.fields.editorial.longformBundle.required.includes('tableCoverage'));
        assert.deepEqual(Object.keys(blank.recordSkeleton.editorial.longformBundle).sort(), [
            'articleSha256', 'artifactIndexSha256', 'blocks', 'contract', 'figures',
            'formulas', 'paperId', 'relatedWorks', 'tables', 'terms', 'version'
        ]);
        assert.ok(blank.fields.authorDraftForbidden.includes('sealedRecordSha256'));
        assert.ok(blank.roleOwnership.deterministic_sealer.includes('reviewResolution'));
        assert.deepEqual(blank.reviewOutputDescriptors.common.issues, []);
        assert.match(blank.reviewOutputDescriptors.common.findingEvidencePolicy, /evidenceLedger:E1/);
        assert.deepEqual(blank.reviewOutputDescriptors.technical_scoring.exactOwnedShape.dims.maxima,
            [2, 1.5, 1.5, 1, 1.5, 1.5, 0.5, 1.5]);
        assert.ok(blank.reviewReceipt.requiredBindings.includes('queuedAt'));
        assert.ok(blank.reviewReceipt.requiredBindings.includes('revision'));
        assert.match(blank.fields.evidenceLedger.idContract, /E\\d\{2,3\}/);
        assert.ok(blank.roleOwnership.author_revision.some(item => /dependent binding/.test(item)));
        assert.match(blank.outputContract.figureEvidencePolicy, /pixel facts/);
        assert.throws(() => parseArgs([
            '--date', '2026-08-29', '--paper', '2608.12345', '--role', 'broker'
        ]), /--role/);
    });

    it('production author output v2 重开固定正文和未封印 record draft', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-v6-author-output-'));
        fs.mkdirSync(path.join(root, 'draft'));
        const article = Buffer.from('当前论文的独立初稿正文。\n', 'utf8');
        const draft = populateAuthorMinimums(buildBlankRecordSkeleton('2608.12345'));
        Object.assign(draft, {
            type: '方法研究', task: '#语音识别',
            tags: '#语音识别 #Transformer #鲁棒性'
        });
        fs.writeFileSync(path.join(root, 'draft', 'author-article.md'), article);
        fs.writeFileSync(path.join(root, 'draft', 'author-record.json'), JSON.stringify(draft));
        const output = {
            version: 2, contract: AUTHOR_OUTPUT_CONTRACT, role: 'author',
            paperId: '2608.12345', taskName: 'author-task-12345', passed: true,
            articleSha256: sha(Buffer.from('当前论文的独立初稿正文。', 'utf8')),
            article: { path: 'draft/author-article.md', fileSha256: sha(article) },
            recordDraft: {
                path: 'draft/author-record.json',
                fileSha256: sha(fs.readFileSync(path.join(root, 'draft', 'author-record.json'))),
                semanticSha256: stableSha256(draft)
            }
        };
        assert.doesNotThrow(() => validateAuthorOutputDescriptor(output, root, {
            paperId: '2608.12345', taskName: 'author-task-12345'
        }));
        draft.sealedRecordSha256 = 'a'.repeat(64);
        fs.writeFileSync(path.join(root, 'draft', 'author-record.json'), JSON.stringify(draft));
        output.recordDraft.fileSha256 = sha(fs.readFileSync(path.join(root, 'draft', 'author-record.json')));
        output.recordDraft.semanticSha256 = stableSha256(draft);
        assert.throws(() => validateAuthorOutputDescriptor(output, root, {
            paperId: '2608.12345', taskName: 'author-task-12345'
        }), /不得伪装 sealed/);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('author-owned 基础字段只接受受控类型/无歧义别名和规范标签字符串', () => {
        const valid = {
            type: '方法研究', task: '#语音识别',
            tags: '#语音识别 #Transformer #鲁棒性'
        };
        assert.deepEqual(normalizeAuthorOwnedBaseFields(valid), valid);
        assert.equal(normalizeAuthorOwnedBaseFields({
            ...valid, type: 'benchmark'
        }).type, '数据集与基准');
        assert.throws(() => normalizeAuthorOwnedBaseFields({
            ...valid, type: 'system/method paper'
        }), /type 必须是受控文档类型/);
        assert.throws(() => normalizeAuthorOwnedBaseFields({
            ...valid, type: ''
        }), /type 必须是受控文档类型/);
        assert.throws(() => normalizeAuthorOwnedBaseFields({
            ...valid, task: '语音识别'
        }), /task 必须是单个合法/);
        assert.throws(() => normalizeAuthorOwnedBaseFields({
            ...valid, tags: ['#语音识别', '#Transformer', '#鲁棒性']
        }), /tags 必须是 3-5 个空格分隔/);
        assert.throws(() => normalizeAuthorOwnedBaseFields({
            ...valid, tags: '#Transformer #鲁棒性 #低资源'
        }), /并覆盖 task/);
        const complete = populateAuthorMinimums(buildBlankRecordSkeleton('2608.12345'));
        Object.assign(complete, valid);
        assert.doesNotThrow(() => validateAuthorOwnedRecordDraft(complete));
        const originalMethod = complete.method;
        complete.method = '方'.repeat(79);
        assert.throws(() => validateAuthorOwnedRecordDraft(complete), /method.*80/);
        complete.method = '方'.repeat(80);
        assert.doesNotThrow(() => validateAuthorOwnedRecordDraft(complete));
        complete.method = originalMethod;
        const originalAffiliation = complete.authorInfo.firstAuthorAffiliation;
        complete.authorInfo.firstAuthorAffiliation = '';
        assert.throws(() => validateAuthorOwnedRecordDraft(complete), /authorInfo/);
        complete.authorInfo.firstAuthorAffiliation = originalAffiliation;
        const originalSourceQuote = complete.authorInfo.sourceQuote;
        complete.authorInfo.sourceQuote = '短引文';
        assert.throws(() => validateAuthorOwnedRecordDraft(complete), /authorInfo/);
        complete.authorInfo.sourceQuote = originalSourceQuote;
        delete complete.editorial.summary;
        assert.throws(() => validateAuthorOwnedRecordDraft(complete), /editorial\.summary/);
        complete.editorial.summary = '';
        delete complete.manualAudit;
        assert.throws(() => validateAuthorOwnedRecordDraft(complete), /manualAudit/);
    });

    it('只物化 ArtifactIndex 授权、真实 MIME/SHA 且位于受控 cache 的图片', () => {
        const current = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-v6-figures-'));
        const cache = path.join(current, 'image-cache');
        const paper = path.join(current, 'paper');
        fs.mkdirSync(cache); fs.mkdirSync(path.join(paper, 'evidence', 'figures'), { recursive: true });
        const png = Buffer.concat([
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('fixture')
        ]);
        const cachePath = path.join(cache, 'figure.bin');
        fs.writeFileSync(cachePath, png);
        const index = { figures: [{
            id: 'IMG0001', cachePath, cacheSha256: sha(png), mime: 'image/png'
        }] };
        const result = materializeAuthorizedFigures(index, paper, current);
        assert.equal(result.artifacts.length, 1);
        assert.equal(result.artifacts[0].path, 'evidence/figures/IMG0001.png');
        assert.equal(sniffImageMime(png), 'image/png');
        index.figures[0].mime = 'image/jpeg';
        assert.throws(() => materializeAuthorizedFigures(index, paper, current), /MIME/);
        const outside = path.join(current, 'outside.bin');
        fs.writeFileSync(outside, png);
        index.figures[0] = {
            id: 'IMG0001', cachePath: outside, cacheSha256: sha(png), mime: 'image/png'
        };
        assert.throws(() => materializeAuthorizedFigures(index, paper, current), /逃逸/);
        fs.rmSync(current, { recursive: true, force: true });
    });
});
