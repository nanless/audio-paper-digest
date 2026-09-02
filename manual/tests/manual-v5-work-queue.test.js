'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
    buildAuthorityInputs, articleSha256, rawFileSha256, stableSha256
} = require('../scripts/manual-fresh-authoring-contract.js');
const {
    buildFilteredBatchFingerprint, buildPaperInputIdentity, sourceIdentitySha256
} = require('../scripts/manual-fetch-fulltext.js');
const {
    ACTIVE_LIMIT, OBSERVATIONS_MODE, parseArgs, validateObservations,
    buildWorkQueue, buildMetricsSidecar
} = require('../scripts/manual-v5-work-queue.js');

const DATE = '2026-08-28';
const ID = '2608.29999';

function sha(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function write(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, typeof value === 'string' ? value : JSON.stringify(value));
    return filePath;
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-v5-queue-'));
    const current = path.join(root, 'data', 'current');
    const blog = path.join(root, 'blog');
    fs.mkdirSync(current, { recursive: true });
    const paths = {
        filteredPath: path.join(current, 'filtered-papers.json'),
        fulltextPath: path.join(current, 'manual-full-text', DATE, `${ID}.txt`),
        fulltextManifestPath: path.join(current, 'manual-full-text', DATE, 'manifest.json'),
        artifactPath: path.join(current, 'manual-full-text', DATE, 'artifacts', `${ID}.json`),
        artifactManifestPath: path.join(current, 'manual-full-text', DATE, 'artifacts', 'manifest.json'),
        promptPath: path.join(root, 'prompt.md'),
        contractPath: path.join(root, 'contract.md'),
        schemaPath: path.join(root, 'schema.js'),
        articlePath: path.join(current, 'manual-tutorial-previews', DATE, ID, 'draft', 'article.md'),
        recordPath: path.join(current, `manual-analysis-record-${DATE}-${ID}.json`),
        generationPath: path.join(current, `blog-generation-manifest-${DATE}.json`),
        passesPath: path.join(current, `blog-review-passes-${DATE}.json`)
    };
    const paper = { paper_id: ID, arxivId: ID, title: 'Queue fixture' };
    const filtered = { status: 'complete', batchDate: DATE, papers: [paper] };
    write(paths.filteredPath, filtered);
    write(paths.fulltextPath, 'Authoritative full text for the isolated paper.');
    write(paths.promptPath, 'fresh authoring prompt');
    write(paths.contractPath, 'editorial contract');
    write(paths.schemaPath, 'module.exports = {};');
    const sourceSha256 = sha(paths.fulltextPath);
    const filteredBatchSha256 = buildFilteredBatchFingerprint(filtered);
    const input = buildPaperInputIdentity(
        paper, filteredBatchSha256, path.join(current, 'manual-full-text', DATE)
    );
    const sourceEntry = {
        status: 'complete', path: paths.fulltextPath,
        requestedArxivId: input.requestedArxivId,
        paperMetadataSha256: input.paperMetadataSha256,
        paperInputSha256: input.paperInputSha256,
        filteredBatchSha256,
        source: 'arxiv_html', sourceId: `https://arxiv.org/html/${ID}`,
        bytes: fs.statSync(paths.fulltextPath).size, sourceSha256,
        imageInfos: [],
        structuredArtifactsSnapshot: { healthStatus: 'complete', payloadSha256: 'd'.repeat(64) }
    };
    sourceEntry.sourceIdentitySha256 = sourceIdentitySha256(sourceEntry);
    const artifactIndex = {
        paperId: ID,
        inputIdentity: {
            sourceSha256,
            sourceIdentitySha256: sourceEntry.sourceIdentitySha256,
            paperInputSha256: sourceEntry.paperInputSha256
        },
        artifactIndexSha256: 'e'.repeat(64),
        inventoryHealth: { status: 'complete', issues: [] }, tables: [], figures: []
    };
    write(paths.artifactPath, artifactIndex);
    const artifactSha = sha(paths.artifactPath);
    write(paths.fulltextManifestPath, {
        version: 2, mode: 'manual_full_text_fetch', date: DATE,
        filteredBatchSha256, status: 'complete', papers: { [ID]: sourceEntry }
    });
    write(paths.artifactManifestPath, {
        version: 1, mode: 'manual_artifact_index',
        parserVersion: 'manual-artifact-parser-v2-structured',
        date: DATE, filteredBatchSha256, status: 'complete', papers: { [ID]: {
            status: 'complete', paperId: ID,
            parserVersion: 'manual-artifact-parser-v2-structured',
            inventoryStatus: 'complete', path: paths.artifactPath,
            outputSha256: artifactSha, bytes: fs.statSync(paths.artifactPath).size,
            paperInputSha256: sourceEntry.paperInputSha256,
            sourceSha256,
            sourceIdentitySha256: sourceEntry.sourceIdentitySha256,
            structuredArtifactsSha256: sourceEntry.structuredArtifactsSnapshot.payloadSha256,
            artifactIndexSha256: artifactIndex.artifactIndexSha256
        } }
    });
    const article = '### Fresh tutorial\n\nOnly current evidence is used. '.repeat(100);
    write(paths.articlePath, article);
    const authorityPaths = {
        paperId: ID,
        filteredPath: paths.filteredPath,
        sourcePath: paths.fulltextPath,
        artifactPath: paths.artifactPath,
        authoringPromptPath: paths.promptPath,
        editorialContractPath: paths.contractPath,
        blankSchemaPath: paths.schemaPath
    };
    const receipt = {
        contract: 'fresh-authoring-v1', mode: 'fresh_from_evidence',
        authoringSessionId: `paper-${ID}-fresh-author`,
        articlePath: paths.articlePath,
        articleSha256: articleSha256(article),
        articleFileSha256: rawFileSha256(paths.articlePath),
        prohibitedProseInputs: [],
        inputs: Object.values(buildAuthorityInputs(authorityPaths))
    };
    receipt.receiptSha256 = stableSha256(receipt);
    const author = {
        arxivId: ID,
        researchBrief: { paperSubagent: {
            paperId: ID, taskName: `paper-${ID}-author`, singlePaperOnly: true,
            isolatedContext: true, model: 'gpt-5.6-terra', reasoningEffort: 'high',
            completedAt: '2026-08-28T09:00:00.000+08:00'
        } },
        editorial: { readerArticle: article },
        freshAuthoring: receipt
    };
    write(paths.recordPath, {
        version: 3, mode: 'manual_analysis_records', date: DATE, papers: { [ID]: author }
    });
    return { root, current, blog, paths, author };
}

function build(fx, extra = {}) {
    return buildWorkQueue({
        date: DATE, projectRoot: fx.root, currentDir: fx.current,
        filteredPath: fx.paths.filteredPath,
        fulltextManifestPath: fx.paths.fulltextManifestPath,
        artifactManifestPath: fx.paths.artifactManifestPath,
        generationPath: fx.paths.generationPath,
        reviewPassesPath: fx.paths.passesPath,
        blogRepo: fx.blog,
        authoringPromptPath: fx.paths.promptPath,
        editorialContractPath: fx.paths.contractPath,
        blankSchemaPath: fx.paths.schemaPath,
        articlePathResolver: () => fx.paths.articlePath,
        generatedAt: '2026-08-28T10:00:00.000+08:00',
        ...extra
    });
}

describe('Manual v5 observable work queue', () => {
    it('derives author finished, reviewer ready, page blocked and a 3-slot dispatch', () => {
        const fx = fixture();
        const report = build(fx);
        assert.equal(report.papers[ID].tasks.author.status, 'finished');
        assert.equal(report.papers[ID].tasks.reviewer.status, 'ready');
        assert.equal(report.papers[ID].tasks.page_review.status, 'blocked');
        assert.equal(report.summary.activeLimit, undefined);
        assert.equal(report.activeLimit, ACTIVE_LIMIT);
        assert.deepEqual(report.dispatch.map(item => item.role), ['reviewer']);
        assert.match(report.papers[ID].tasks.reviewer.inputSha256, /^[a-f0-9]{64}$/);
    });

    it('accepts only matching explicit observations as claimed and never infers timing from timestamps', () => {
        const fx = fixture();
        const initial = build(fx);
        const reviewer = initial.papers[ID].tasks.reviewer;
        const observationsPath = write(path.join(fx.current, 'observations.json'), {
            version: 1, mode: OBSERVATIONS_MODE, date: DATE, tasks: [{
                paperId: ID, role: 'reviewer', status: 'running',
                inputSha256: reviewer.inputSha256, taskName: `paper-${ID}-review`,
                claimedAt: '2026-08-28T09:01:00.000+08:00',
                startedAt: '2026-08-28T09:02:00.000+08:00',
                measurements: { queueWaitMs: 37, runtimeMs: 901 }
            }]
        });
        const report = build(fx, { observationsPath });
        const task = report.papers[ID].tasks.reviewer;
        assert.equal(task.status, 'claimed');
        assert.equal(task.performance.queueWaitMs.value, 37);
        assert.equal(task.performance.runtimeMs.value, 901);
        assert.equal(report.summary.activeClaims, 1);
        assert.equal(report.summary.availableSlots, 2);
        assert.equal(report.performance.timestampDifferencesUsed, false);
        const metrics = buildMetricsSidecar(report);
        assert.equal(metrics.timestampDifferencesUsed, false);
        assert.equal(metrics.tasks.find(item => item.role === 'author').runtimeMs.status, 'unknown');

        const completed = validateObservations({
            version: 1, mode: OBSERVATIONS_MODE, date: DATE, tasks: [{
                paperId: ID, role: 'author', status: 'finished',
                inputSha256: initial.papers[ID].tasks.author.inputSha256,
                taskName: `paper-${ID}-author`, completedAt: '2026-08-28T09:03:00.000+08:00',
                measurements: { queueWaitMs: 5, runtimeMs: 600 }
            }]
        }, DATE);
        assert.equal(completed.get(`${ID}:author`).runtimeMs.value, 600);
    });

    it('marks reviewer/page review finished only after independent review and current page SHA pass', () => {
        const fx = fixture();
        fx.author.scoringCalibration = {
            independentReview: true, reviewerTaskName: `paper-${ID}-scoring`,
            model: 'gpt-5.6-terra', reasoningEffort: 'high',
            crossDimensionChecked: true, batchScaleChecked: true
        };
        fx.author.readabilityRubric = {
            paperId: ID, independentReview: true, reviewerTaskName: `paper-${ID}-readability`,
            model: 'gpt-5.6-terra', reasoningEffort: 'high'
        };
        write(fx.paths.recordPath, {
            version: 3, mode: 'manual_analysis_records', date: DATE, papers: { [ID]: fx.author }
        });
        const relativePage = `content/posts/${DATE}-fixture-${ID.replace('.', '-')}.md`;
        const pagePath = write(path.join(fx.blog, relativePage), '# reviewed page');
        const pageSha = sha(pagePath);
        write(fx.paths.generationPath, {
            schemaVersion: 3, date: DATE, files: [{ path: relativePage, deleted: false, sha256: pageSha }]
        });
        write(fx.paths.passesPath, {
            schemaVersion: 1, date: DATE, files: [{ path: relativePage, sha256: pageSha }]
        });
        const report = build(fx);
        assert.equal(report.papers[ID].tasks.reviewer.status, 'finished');
        assert.equal(report.papers[ID].tasks.page_review.status, 'finished');
        assert.equal(report.summary.finished, 3);
    });

    it('fails closed on malformed observations and CLI arguments', () => {
        assert.throws(() => validateObservations({
            version: 1, mode: OBSERVATIONS_MODE, date: DATE,
            tasks: [{ paperId: ID, role: 'author', status: 'claimed', inputSha256: 'bad', taskName: 'task' }]
        }, DATE), /非法/);
        assert.deepEqual(parseArgs(['--date', DATE, '--no-sidecar']), { date: DATE, writeSidecar: false });
    });
});
