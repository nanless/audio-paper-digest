'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
    buildFilteredBatchFingerprint,
    buildPaperInputIdentity,
    sourceIdentitySha256
} = require('../scripts/manual-fetch-fulltext.js');
const {
    stableSha256
} = require('../scripts/manual-fresh-authoring-contract.js');
const {
    PACKET_CONTRACT,
    AUTHOR_TASK_INPUT_CONTRACT,
    FORBIDDEN_INPUT_KINDS,
    buildAuthorPacket,
    validateAuthorPacket,
    materializeAuthorPacket,
    defaultAuthorPacketPaths
} = require('../scripts/manual-v5-author-packet.js');
const { buildWorkQueue } = require('../scripts/manual-v5-work-queue.js');

const DATE = '2026-08-28';
const ID = '2608.29999';

function sha(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function write(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
    return filePath;
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-v5-author-packet-'));
    const current = path.join(root, 'data', 'current');
    const fulltextDir = path.join(current, 'manual-full-text', DATE);
    const artifactDir = path.join(fulltextDir, 'artifacts');
    const paper = {
        paper_id: ID,
        arxivId: ID,
        title: 'An isolated packet fixture',
        authors: ['A. Author'],
        abstract: 'Current-paper evidence only.',
        categories: ['eess.AS']
    };
    const filtered = { status: 'complete', batchDate: DATE, papers: [paper] };
    const filteredPath = write(path.join(current, 'filtered-papers.json'), filtered);
    const filteredBatchSha256 = buildFilteredBatchFingerprint(filtered);
    const input = buildPaperInputIdentity(paper, filteredBatchSha256, fulltextDir);
    write(input.filePath, 'Only the current paper full text may be read by the author.');
    const sourceEntry = {
        status: 'complete',
        path: input.filePath,
        requestedArxivId: input.requestedArxivId,
        paperMetadataSha256: input.paperMetadataSha256,
        paperInputSha256: input.paperInputSha256,
        filteredBatchSha256,
        source: 'arxiv_html',
        sourceId: `https://arxiv.org/html/${ID}`,
        bytes: fs.statSync(input.filePath).size,
        sourceSha256: sha(input.filePath),
        imageInfos: [],
        structuredArtifactsSnapshot: {
            healthStatus: 'complete',
            payloadSha256: 'd'.repeat(64)
        }
    };
    sourceEntry.sourceIdentitySha256 = sourceIdentitySha256(sourceEntry);
    const fulltextManifestPath = write(path.join(fulltextDir, 'manifest.json'), {
        version: 2,
        mode: 'manual_full_text_fetch',
        date: DATE,
        filteredBatchSha256,
        status: 'complete',
        papers: { [ID]: sourceEntry }
    });
    const artifactIndex = {
        paperId: ID,
        inputIdentity: {
            sourceSha256: sourceEntry.sourceSha256,
            sourceIdentitySha256: sourceEntry.sourceIdentitySha256,
            paperInputSha256: sourceEntry.paperInputSha256
        },
        inventoryHealth: { status: 'complete', issues: [] },
        artifactIndexSha256: 'e'.repeat(64),
        tables: [], figures: [], formulas: []
    };
    const artifactPath = write(path.join(artifactDir, `${ID}.json`), artifactIndex);
    const artifactEntry = {
        status: 'complete',
        paperId: ID,
        parserVersion: 'manual-artifact-parser-v2-structured',
        path: artifactPath,
        paperInputSha256: sourceEntry.paperInputSha256,
        sourceSha256: sourceEntry.sourceSha256,
        sourceIdentitySha256: sourceEntry.sourceIdentitySha256,
        structuredArtifactsSha256: sourceEntry.structuredArtifactsSnapshot.payloadSha256,
        inventoryStatus: 'complete',
        inventoryIssues: [],
        artifactIndexSha256: artifactIndex.artifactIndexSha256,
        outputSha256: sha(artifactPath),
        bytes: fs.statSync(artifactPath).size
    };
    const artifactManifestPath = write(path.join(artifactDir, 'manifest.json'), {
        version: 1,
        mode: 'manual_artifact_index',
        parserVersion: 'manual-artifact-parser-v2-structured',
        date: DATE,
        filteredBatchSha256,
        status: 'complete',
        papers: { [ID]: artifactEntry }
    });
    const authoringPromptPath = write(path.join(root, 'prompts', 'manual-tutorial-article.md'), 'fresh prompt');
    const editorialContractPath = write(path.join(root, 'docs', 'manual-editorial-reference-contract.md'), 'editorial contract');
    const blankSchemaPath = write(path.join(root, 'scripts', 'blank-schema.js'), 'module.exports = {};');
    const blogRepo = path.join(root, 'blog');
    fs.mkdirSync(blogRepo, { recursive: true });
    const packetPaths = defaultAuthorPacketPaths(current, DATE, ID);
    const options = {
        date: DATE,
        paperId: ID,
        projectRoot: root,
        currentDir: current,
        filteredPath,
        fulltextManifestPath,
        artifactManifestPath,
        authoringPromptPath,
        editorialContractPath,
        blankSchemaPath,
        blogRepo,
        packetPaths
    };
    return {
        root, current, fulltextDir, artifactDir, paper, filtered, sourceEntry,
        artifactEntry, artifactPath, input, options, packetPaths
    };
}

describe('Manual v5 cold-start author packet', () => {
    it('materializes an exact single-paper allowlist and closes the work-queue input SHA', () => {
        const fx = fixture();
        const built = materializeAuthorPacket(fx.options);
        assert.equal(built.packet.contract, PACKET_CONTRACT);
        assert.equal(built.packet.inputContract, AUTHOR_TASK_INPUT_CONTRACT);
        assert.deepEqual(
            built.packet.allowedInputs.map(item => item.kind),
            ['paper_metadata', 'source_snapshot', 'artifact_index', 'authoring_prompt', 'editorial_contract', 'blank_schema']
        );
        assert.deepEqual(built.packet.forbidden.forbiddenKinds, [...FORBIDDEN_INPUT_KINDS]);
        assert.equal(built.metadata.paper.arxivId, ID);
        assert.equal(Object.keys(built.metadata).includes('papers'), false);
        assert.doesNotThrow(() => validateAuthorPacket(built.packet, {
            ...fx.options, requireMaterialized: true
        }));

        const queue = buildWorkQueue({
            date: DATE,
            projectRoot: fx.root,
            currentDir: fx.current,
            filteredPath: fx.options.filteredPath,
            fulltextManifestPath: fx.options.fulltextManifestPath,
            artifactManifestPath: fx.options.artifactManifestPath,
            blogRepo: fx.options.blogRepo,
            authoringPromptPath: fx.options.authoringPromptPath,
            editorialContractPath: fx.options.editorialContractPath,
            blankSchemaPath: fx.options.blankSchemaPath,
            generatedAt: '2026-08-28T10:00:00.000+08:00'
        });
        assert.equal(queue.papers[ID].tasks.author.status, 'ready');
        assert.equal(queue.papers[ID].tasks.author.inputSha256, built.packet.inputSha256);
        assert.equal(queue.dispatch[0].packet.expectedPacketSha256, built.packet.packetSha256);
    });

    it('rejects source symlinks and symlink-spoofed packet roots', () => {
        const fx = fixture();
        const realSource = `${fx.input.filePath}.real`;
        fs.renameSync(fx.input.filePath, realSource);
        fs.symlinkSync(realSource, fx.input.filePath);
        assert.throws(() => buildAuthorPacket(fx.options), /symlink/);

        const fx2 = fixture();
        const elsewhere = path.join(fx2.current, 'elsewhere');
        fs.mkdirSync(elsewhere);
        fs.mkdirSync(path.dirname(fx2.packetPaths.root), { recursive: true });
        fs.symlinkSync(elsewhere, fx2.packetPaths.root);
        assert.throws(() => materializeAuthorPacket(fx2.options), /symlink|父路径/);
    });

    it('rejects path escape, extra allowlist entries and extra directory inputs', () => {
        const fx = fixture();
        assert.throws(() => buildAuthorPacket({
            ...fx.options,
            packetPaths: {
                root: path.join(fx.root, 'escaped'),
                metadataPath: path.join(fx.root, 'escaped', 'paper-metadata.json'),
                packetPath: path.join(fx.root, 'escaped', 'packet.json')
            }
        }), /受控单篇 input 目录|输出目录必须位于 data\/current/);

        const built = materializeAuthorPacket(fx.options);
        const injected = structuredClone(built.packet);
        injected.allowedInputs.push({
            kind: 'historical_article', authority: 'renamed_file',
            path: '/tmp/old.md', projectRelativePath: 'old.md', bytes: 1, sha256: 'a'.repeat(64)
        });
        assert.throws(() => validateAuthorPacket(injected, fx.options), /exact allowlist|不一致/);
        write(path.join(fx.packetPaths.root, 'old-post.md'), 'old prose');
        assert.throws(() => materializeAuthorPacket(fx.options), /额外输入/);
    });

    it('fails closed when fulltext or ArtifactIndex identity drifts', () => {
        const fx = fixture();
        const manifest = JSON.parse(fs.readFileSync(fx.options.fulltextManifestPath, 'utf8'));
        manifest.papers[ID].paperInputSha256 = 'f'.repeat(64);
        write(fx.options.fulltextManifestPath, manifest);
        assert.throws(() => buildAuthorPacket(fx.options), /identity drift/);

        const fx2 = fixture();
        const artifacts = JSON.parse(fs.readFileSync(fx2.options.artifactManifestPath, 'utf8'));
        artifacts.papers[ID].sourceIdentitySha256 = 'f'.repeat(64);
        write(fx2.options.artifactManifestPath, artifacts);
        assert.throws(() => buildAuthorPacket(fx2.options), /checkpoint 未与当前全文|身份/);
    });

    it('does not open forbidden canonical, old article, quality or review prose', () => {
        const fx = fixture();
        const forbiddenPaths = [
            write(path.join(fx.current, 'deep-analysis-result.json'), '{ invalid canonical'),
            write(path.join(fx.current, 'manual-tutorial-previews', DATE, ID, 'draft', 'article.md'), 'old article'),
            write(path.join(fx.current, 'manual-tutorial-previews', DATE, ID, 'draft', 'quality.json'), '{ invalid quality'),
            write(path.join(fx.current, 'old-review.json'), '{ invalid review')
        ].map(item => path.resolve(item));
        const originalRead = fs.readFileSync;
        fs.readFileSync = function guardedRead(filePath, ...args) {
            if (forbiddenPaths.includes(path.resolve(String(filePath)))) {
                throw new Error(`forbidden content was read: ${filePath}`);
            }
            return originalRead.call(this, filePath, ...args);
        };
        try {
            const built = buildAuthorPacket(fx.options);
            assert.equal(built.packet.paperId, ID);
        } finally {
            fs.readFileSync = originalRead;
        }
    });
});
