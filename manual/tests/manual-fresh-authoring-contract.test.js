const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
    FRESH_AUTHORING_CONTRACT,
    FRESH_AUTHORING_MODE,
    articleSha256,
    stableSha256,
    rawFileSha256,
    buildAuthorityInputs,
    validateFreshAuthoringReceipt,
    resolveArtifactAuthority
} = require('../scripts/manual-fresh-authoring-contract.js');

const ID = '2608.29999';
const DATE = '2026-08-27';

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-fresh-contract-'));
    const evidenceRoot = path.join(root, 'manual-full-text', DATE);
    const artifactDir = path.join(evidenceRoot, 'artifacts');
    fs.mkdirSync(artifactDir, { recursive: true });
    const files = {
        filteredPath: path.join(root, 'filtered-papers.json'),
        sourcePath: path.join(evidenceRoot, `${ID}.txt`),
        artifactPath: path.join(artifactDir, `${ID}.json`),
        authoringPromptPath: path.join(root, 'prompt.md'),
        editorialContractPath: path.join(root, 'contract.md'),
        blankSchemaPath: path.join(root, 'blank-schema.js'),
        officialProjectEvidencePath: path.join(evidenceRoot, 'external-evidence', `${ID}-official-project.json`),
        articlePath: path.join(root, 'manual-tutorial-previews', DATE, ID, 'draft', 'article.md')
    };
    Object.values(files).forEach(file => fs.mkdirSync(path.dirname(file), { recursive: true }));
    fs.writeFileSync(files.filteredPath, JSON.stringify({ status: 'complete', papers: [{ arxivId: ID }] }));
    fs.writeFileSync(files.sourcePath, '本篇论文的结构化完整全文证据。');
    fs.writeFileSync(files.authoringPromptPath, '只从本篇原始证据冷启动写作。');
    fs.writeFileSync(files.editorialContractPath, '研究生教程编辑契约。');
    fs.writeFileSync(files.blankSchemaPath, 'module.exports = {};');
    fs.writeFileSync(files.officialProjectEvidencePath, JSON.stringify({
        paperId: ID, kind: 'official_project_evidence', url: 'https://github.com/example/project'
    }));
    const sourceSha256 = rawFileSha256(files.sourcePath);
    const sourceIdentitySha256 = 'b'.repeat(64);
    const paperInputSha256 = 'c'.repeat(64);
    const artifactIndex = {
        paperId: ID,
        inputIdentity: { sourceSha256, sourceIdentitySha256, paperInputSha256 },
        inventoryHealth: { status: 'complete', issues: [] },
        artifactIndexSha256: 'd'.repeat(64)
    };
    fs.writeFileSync(files.artifactPath, JSON.stringify(artifactIndex));
    const artifactBytes = fs.readFileSync(files.artifactPath);
    const artifactManifestPath = path.join(artifactDir, 'manifest.json');
    fs.writeFileSync(artifactManifestPath, JSON.stringify({
        mode: 'manual_artifact_index', parserVersion: 'manual-artifact-parser-v2-structured',
        date: DATE, filteredBatchSha256: 'a'.repeat(64),
        papers: { [ID]: {
            status: 'complete', paperId: ID, path: files.artifactPath,
            sourceSha256, sourceIdentitySha256, paperInputSha256,
            artifactIndexSha256: artifactIndex.artifactIndexSha256,
            outputSha256: sha256(artifactBytes), bytes: artifactBytes.length
        } }
    }));
    const article = '### 从问题进入\n\n这是一篇只由当前论文证据写成的完整替换稿。'.repeat(80);
    fs.writeFileSync(files.articlePath, article);
    const authority = buildAuthorityInputs({ paperId: ID, ...files });
    const receipt = {
        contract: FRESH_AUTHORING_CONTRACT, mode: FRESH_AUTHORING_MODE,
        authoringSessionId: 'paper-2608.29999-fresh-author',
        articlePath: files.articlePath,
        articleSha256: articleSha256(article),
        articleFileSha256: rawFileSha256(files.articlePath),
        prohibitedProseInputs: [], inputs: Object.values(authority)
    };
    receipt.receiptSha256 = stableSha256(receipt);
    return {
        root, files, article, receipt, artifactManifestPath,
        artifactExpected: {
            date: DATE, paperId: ID, filteredBatchSha256: 'a'.repeat(64),
            sourceSha256, sourceIdentitySha256, paperInputSha256
        }
    };
}

describe('Manual v5 fresh-authoring-v1 文件约定', () => {
    it('接受原样字节和 NFKC 字节，以及可选的官方项目证据', () => {
        const f = fixture();
        const normalized = validateFreshAuthoringReceipt(f.receipt, {
            paperId: ID, articlePath: f.files.articlePath, readerArticle: f.article,
            authorityPaths: { paperId: ID, ...f.files }
        });
        assert.equal(normalized.inputs.at(-1).kind, 'official_project_evidence');
        assert.equal(normalized.receiptSha256, f.receipt.receiptSha256);
        assert.doesNotThrow(() => resolveArtifactAuthority(f.artifactManifestPath, f.artifactExpected));
    });

    it('拒绝声明使用旧文章正文，以及文章文件被改动的情况', () => {
        const f = fixture();
        const options = {
            paperId: ID, articlePath: f.files.articlePath, readerArticle: f.article,
            authorityPaths: { paperId: ID, ...f.files }
        };
        const oldProse = structuredClone(f.receipt);
        oldProse.prohibitedProseInputs = ['old readerArticle'];
        assert.throws(() => validateFreshAuthoringReceipt(oldProse, options), /必须为空/);
        fs.appendFileSync(f.files.articlePath, '发生漂移');
        assert.throws(() => validateFreshAuthoringReceipt(f.receipt, options), /raw\/NFKC SHA/);
    });

    it('在调用方给出的权威路径上核对当前字节', context => {
        const f = fixture();
        context.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
        const contractPath = f.files.editorialContractPath;
        const contractBytes = fs.readFileSync(path.resolve(
            __dirname, '..', 'docs', 'editorial-reference-contract.md'
        ));
        fs.writeFileSync(contractPath, contractBytes);
        const input = f.receipt.inputs.find(item => item.kind === 'editorial_contract');
        input.sha256 = sha256(contractBytes);
        delete f.receipt.receiptSha256;
        f.receipt.receiptSha256 = stableSha256(f.receipt);
        const options = {
            paperId: ID, articlePath: f.files.articlePath, readerArticle: f.article,
            authorityPaths: { paperId: ID, ...f.files }
        };
        assert.doesNotThrow(() => validateFreshAuthoringReceipt(f.receipt, options));
        const oldCopy = path.join(f.root, 'previous-contract.md');
        fs.writeFileSync(oldCopy, contractBytes);
        fs.appendFileSync(contractPath, '\n测试中的下一版编辑要求。\n');
        const { receiptSha256, ...receiptBody } = f.receipt;
        assert.equal(stableSha256(receiptBody), receiptSha256);
        assert.equal(rawFileSha256(oldCopy), input.sha256);
        assert.throws(() => validateFreshAuthoringReceipt(f.receipt, options), {
            message: `${ID}.freshAuthoring.inputs.editorial_contract.sha256 与当前权威文件不一致`
        });
        fs.writeFileSync(contractPath, contractBytes);
        assert.doesNotThrow(() => validateFreshAuthoringReceipt(f.receipt, options));

        fs.appendFileSync(contractPath, '\n测试中的下一版编辑要求。\n');
        assert.notEqual(rawFileSha256(contractPath), rawFileSha256(oldCopy));
        const oldCopyReceipt = structuredClone(f.receipt);
        oldCopyReceipt.inputs.find(item => item.kind === 'editorial_contract').path = oldCopy;
        delete oldCopyReceipt.receiptSha256;
        oldCopyReceipt.receiptSha256 = stableSha256(oldCopyReceipt);
        assert.throws(() => validateFreshAuthoringReceipt(oldCopyReceipt, options), /editorial_contract\.path/);
        const oldCopyOptions = {
            ...options, authorityPaths: { ...options.authorityPaths, editorialContractPath: oldCopy }
        };
        assert.doesNotThrow(() => validateFreshAuthoringReceipt(oldCopyReceipt, oldCopyOptions));
    });

    it('即使声明的哈希全部对得上，ArtifactIndex 不完整也要拒绝', () => {
        const f = fixture();
        const manifest = JSON.parse(fs.readFileSync(f.artifactManifestPath, 'utf8'));
        manifest.papers[ID].status = 'incomplete';
        fs.writeFileSync(f.artifactManifestPath, JSON.stringify(manifest));
        assert.throws(
            () => resolveArtifactAuthority(f.artifactManifestPath, f.artifactExpected),
            /checkpoint 与当前全文/
        );
    });
});
