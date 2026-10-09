'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { promoteManualV5Draft, validateReview, validateAuthorAuthority } = require('../scripts/manual-v5-promote-draft.js');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-promote-'));
    const previewRoot = path.join(root, 'manual-tutorial-previews');
    const paperRoot = path.join(previewRoot, '2026-08-27', '2608.25177');
    const source = path.join(paperRoot, 'revision2');
    fs.mkdirSync(source, { recursive: true });
    const authorityRoot = path.join(root, 'authority');
    fs.mkdirSync(authorityRoot, { recursive: true });
    const kinds = [
        'paper_metadata', 'source_snapshot', 'artifact_index',
        'authoring_prompt', 'editorial_contract', 'blank_schema'
    ];
    const allowedInputs = kinds.map(kind => {
        const file = path.join(authorityRoot, `${kind}.txt`);
        fs.writeFileSync(file, `${kind}\n`);
        return { kind, path: file, sha256: hash(fs.readFileSync(file)) };
    });
    const packetPath = path.join(authorityRoot, 'packet.json');
    const packet = {
        date: '2026-08-27', paperId: '2608.25177', mode: 'fresh_from_evidence',
        singlePaperOnly: true, isolatedContext: true, requiredModel: 'gpt-5.6-terra',
        requiredReasoningEffort: 'high', packetSha256: '9'.repeat(64),
        sourceIdentitySha256: '8'.repeat(64),
        sourceEntry: { sourceSha256: '7'.repeat(64) },
        artifactEntry: { outputSha256: '6'.repeat(64) }, allowedInputs
    };
    fs.writeFileSync(packetPath, JSON.stringify(packet));
    const reviewsRoot = path.join(paperRoot, 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const feedbackInputs = [
        ['technical_review_findings', 'technical-findings.json'],
        ['pedagogy_review_findings', 'pedagogy-findings.json']
    ].map(([kind, name]) => {
        const file = path.join(reviewsRoot, name);
        fs.writeFileSync(file, JSON.stringify({ kind }));
        return { kind, path: file, sha256: hash(fs.readFileSync(file)) };
    });
    const article = '### 新稿\n\n只来自权威证据的全新文章。\n';
    const articleSha = hash(article);
    fs.writeFileSync(path.join(source, 'article.md'), article);
    fs.writeFileSync(path.join(source, 'author-record.json'), JSON.stringify({
        paperId: '2608.25177', mode: 'fresh_from_evidence', article: { sha256: articleSha },
        sourceIdentity: {
            authorPacketSha256: packet.packetSha256,
            fullTextSha256: packet.sourceEntry.sourceSha256,
            artifactIndexSha256: packet.artifactEntry.outputSha256,
            paperSourceIdentitySha256: packet.sourceIdentitySha256
        },
        freshAuthoring: {
            contract: 'fresh-authoring-v1', prohibitedProseInputs: [],
            inputs: [...allowedInputs, ...feedbackInputs]
        }
    }));
    fs.writeFileSync(path.join(source, 'author-self-check.json'), JSON.stringify({
        paperId: '2608.25177', articleSha256: articleSha
    }));
    fs.writeFileSync(path.join(source, 'research-brief.json'), JSON.stringify({ paperId: '2608.25177' }));
    const review = name => {
        const file = path.join(reviewsRoot, `${name}.json`);
        fs.writeFileSync(file, JSON.stringify({
            paperId: '2608.25177', passed: true, blockers: [], articleSha,
            provenance: { taskName: name, model: 'gpt-5.6-terra', reasoningEffort: 'high' }
        }));
        return file;
    };
    return {
        root, previewRoot, source, article, articleSha, packetPath,
        technicalReview: review('technical'), readabilityReview: review('readability'),
        figureReview: review('figures')
    };
}

function snapshotTree(root) {
    const result = {};
    for (const name of fs.readdirSync(root).sort()) {
        const file = path.join(root, name), info = fs.lstatSync(file);
        if (info.isDirectory()) {
            for (const [key, value] of Object.entries(snapshotTree(file))) result[`${name}/${key}`] = value;
        } else result[name] = info.isSymbolicLink() ? `link:${fs.readlinkSync(file)}` : hash(fs.readFileSync(file));
    }
    return result;
}

describe('Manual v5 旧草稿只读审查与写入拒绝', () => {
    it('旧草稿写入已关闭，即使三份审查通过也不写正式正文或凭证', () => {
        const f = fixture();
        const before = snapshotTree(f.root);
        for (const file of [f.technicalReview, f.readabilityReview, f.figureReview]) {
            assert.doesNotThrow(() => validateReview(file, '2608.25177', f.articleSha, '旧审查'));
        }
        assert.throws(() => promoteManualV5Draft({
            date: '2026-08-27', paperId: '2608.25177', previewRoot: f.previewRoot,
            currentDir: f.root, authorPacketPath: f.packetPath,
            sourceDir: f.source, technicalReview: f.technicalReview,
            readabilityReview: f.readabilityReview, figureReview: f.figureReview
        }), /旧 v5.*仅保留读取与核验/);
        assert.deepEqual(snapshotTree(f.root), before);
        const paperRoot = path.dirname(f.source);
        assert.equal(fs.existsSync(path.join(paperRoot, 'draft', 'article.md')), false);
        assert.equal(fs.existsSync(path.join(paperRoot, 'draft-promotion.json')), false);
    });

    it('拒绝未绑定当前文章 SHA 的 review', () => {
        const f = fixture();
        fs.writeFileSync(f.technicalReview, JSON.stringify({
            paperId: '2608.25177', passed: true, blockers: [], articleSha: '0'.repeat(64),
            provenance: { taskName: 'technical', model: 'gpt-5.6-terra', reasoningEffort: 'high' }
        }));
        assert.throws(() => validateReview(f.technicalReview, '2608.25177', f.articleSha, '旧审查'),
            /没有绑定当前 revision article SHA/);
    });

    it('拒绝只写 SHA 不写真实 authority path 的 fresh 自报', () => {
        const f = fixture();
        const recordPath = path.join(f.source, 'author-record.json');
        const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        delete record.freshAuthoring.inputs[0].path;
        fs.writeFileSync(recordPath, JSON.stringify(record));
        // 此样例的 packet 是最小格式控制；这里只隔离测试来源路径核验，
        // 完整生产作者包读取另由 author-packet 测试检查。
        assert.throws(() => validateAuthorAuthority(record, f.packetPath,
            '2026-08-27', '2608.25177', () => true, f.root),
        /paper_metadata 未精确绑定 author packet allowlist/);
    });
});
