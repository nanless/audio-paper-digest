'use strict';

process.env.PAPER_DIGEST_DISABLE_FILE_LOGS = '1';
process.env.PD_DISABLE_FILE_LOGS = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const {
    validAnalysisText,
    validAnalysisPaper
} = require('./valid-analysis-fixture.js');

const {
    PAPERS_LEDGER_STRIP_ON_WRITE_FIELDS,
    PAPERS_BACKUP_CONTRACT,
    stripPapersLedgerEphemeralFields,
    normalizePapersMap,
    mergeAnalysisDigestPaper,
    mergePapersDatabases,
    applyAnalysisDigestStatuses,
    savePapersDatabase,
    verifyPapersBackup
} = require('../scripts/digest-status.js');
const { normalizePaperForLedger } = require('../scripts/full-fetch.js');
const { requiredWorkspaceRoleForCommand } = require('../scripts/env-loader.js');
const { writeWorkspaceRole } = require('../scripts/workspace-role.js');
const {
    COMPACTION_RECEIPT_CONTRACT,
    VERIFIED_ARCHIVED_BLOB_FIELDS,
    LEDGER_HISTORICAL_TOP_LEVEL_FIELDS,
    LEDGER_HISTORICAL_DIGEST_STATUS_FIELDS,
    validatePapersDatabaseRecords,
    buildArchiveRecordProof,
    isLeakedMergeAttemptMetadata,
    getMostRecentPaperDate,
    parseCompactPapersArgs,
    compactPapersLedger
} = require('../scripts/compact-papers-ledger.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const COMPACT_CLI_PATH = path.join(REPO_ROOT, 'scripts', 'compact-papers-ledger.js');

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeAllEphemeralFields() {
    const out = {};
    for (const field of PAPERS_LEDGER_STRIP_ON_WRITE_FIELDS) {
        out[field] = { marker: field, payload: 'x'.repeat(256) };
    }
    return out;
}

function makeRichHistoricalAnalyzedPaper(id, batchDate, overrides = {}) {
    const abstractText = `Detailed abstract for ${id}: ` + 'audio speech modeling '.repeat(20);
    return {
        arxivId: `${id}v1`,
        paper_id: `${id}v1`,
        title: `Title for ${id}`,
        authors: ['Alice Smith', 'Bob Jones'],
        published: `${batchDate}T00:00:00Z`,
        updated: `${batchDate}T01:00:00Z`,
        fetchedAt: `${batchDate}T08:00:00+08:00`,
        fetchBatchDate: batchDate,
        batchDate,
        categories: ['eess.AS', 'cs.SD'],
        sources: ['arxiv', 'huggingface'],
        pdfUrl: `https://arxiv.org/pdf/${id}`,
        absUrl: `https://arxiv.org/abs/${id}`,
        abstract: abstractText,
        summary: abstractText,
        hf_ai_summary: 'HF AI summary text '.repeat(12),
        hf_ai_keywords: ['speech', 'audio', 'codec'],
        analysis: validAnalysisText() + '\n' + '详细分析内容。'.repeat(80),
        parsed: { score: 8.4, summary: '核心摘要内容', primaryTaskTag: 'ASR' },
        apiReaderArticle: '# Reader Longform\n' + '深度解读长文内容。'.repeat(120),
        analysisManifest: {
            version: 1,
            stages: { primaryAnalysis: { status: 'complete' } }
        },
        freshRewriteProvenance: { runId: `run-${id}`, sourceGeneration: 1 },
        selectedImageUrls: [`https://arxiv.org/html/${id}/fig1.png`],
        imageUrls: [`https://arxiv.org/html/${id}/fig1.png`],
        imageManifest: { selected: [{ url: `https://arxiv.org/html/${id}/fig1.png`, caption: 'Fig 1' }] },
        analysisRecoveryImageManifest: { candidates: [{ url: `https://arxiv.org/html/${id}/fig1.png` }] },
        ...makeAllEphemeralFields(),
        digestStatus: {
            status: 'analyzed',
            batchDate,
            updatedAt: `${batchDate}T12:00:00+08:00`,
            latestAttemptStatus: 'analyzed',
            filterDecision: true,
            error: null,
            filterRawResponse: '{"related":true,"reason":"speech model"}'.repeat(6),
            filterReason: 'Directly improves speech recognition and audio modeling.',
            filterPromptHash: 'abcdef0123456789',
            filterParseSource: 'llm_json',
            filterModel: 'muse-spark-1.3-contributor',
            filterDecidedAt: `${batchDate}T09:00:00+08:00`
        },
        ...overrides
    };
}

function makeMatchingArchiveEntry(paper, overrides = {}) {
    return {
        arxivId: paper.arxivId,
        analysis: paper.analysis,
        apiReaderArticle: paper.apiReaderArticle,
        // Intentionally reversed key order in parsed to test canonical SHA matching!
        parsed: paper.parsed ? { primaryTaskTag: paper.parsed.primaryTaskTag, summary: paper.parsed.summary, score: paper.parsed.score } : undefined,
        analysisManifest: paper.analysisManifest,
        imageManifest: paper.imageManifest,
        ...overrides
    };
}

function makeHistoricalSeenPaper(id, batchDate, overrides = {}) {
    const abstractText = `Unrelated vision abstract for ${id}: ` + 'image segmentation '.repeat(25);
    return {
        arxivId: `${id}v1`,
        paper_id: `${id}v1`,
        title: `Seen Title ${id}`,
        authors: ['Carol Lee'],
        published: `${batchDate}T00:00:00Z`,
        fetchedAt: `${batchDate}T08:00:00+08:00`,
        fetchBatchDate: batchDate,
        categories: ['cs.CV'],
        sources: ['arxiv'],
        pdfUrl: `https://arxiv.org/pdf/${id}`,
        absUrl: `https://arxiv.org/abs/${id}`,
        abstract: abstractText,
        summary: abstractText,
        hf_ai_summary: 'HF unrelated summary '.repeat(10),
        hf_ai_keywords: ['vision', 'segmentation'],
        apiReaderPlan: { leftover: true },
        digestStatus: {
            status: 'seen',
            batchDate,
            updatedAt: `${batchDate}T09:30:00+08:00`,
            filterDecision: false,
            error: null,
            filterRawResponse: '{"related":false,"reason":"pure computer vision"}'.repeat(6),
            filterReason: 'No speech or audio component.',
            filterPromptHash: 'abcdef0123456789',
            filterParseSource: 'llm_json',
            filterModel: 'muse-spark-1.3-contributor',
            filterDecidedAt: `${batchDate}T09:00:00+08:00`
        },
        ...overrides
    };
}

function createCompactionFixtureWorkspace(referenceDate = '2026-11-24') {
    const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wave14-6a-compact-')));
    const currentDir = path.join(rootDir, 'data', 'current');
    const archiveDir = path.join(rootDir, 'data', 'archive');
    const receiptDir = path.join(rootDir, 'data', 'runtime', 'papers-compaction');
    fs.mkdirSync(currentDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });

    const papers = {
        // 1. Historical analyzed + cryptographically verified archived -> eligible for BOTH blob & ledger stripping
        '2601.00001': makeRichHistoricalAnalyzedPaper('2601.00001', '2026-06-01'),
        // 2. Historical seen -> eligible for ephemeral/dedup (safe-blobs) & ledger text/filter trim (ledger)
        '2601.00002': makeHistoricalSeenPaper('2601.00002', '2026-06-02'),
        // 3. Historical analyzed but UNARCHIVED -> MUST be protected!
        '2601.00003': makeRichHistoricalAnalyzedPaper('2601.00003', '2026-06-03'),
        // 4. Historical analyzed with CORRUPT archive JSON -> fail-closed unarchived, MUST be protected!
        '2601.00004': makeRichHistoricalAnalyzedPaper('2601.00004', '2026-06-04'),
        // 5. Recent analyzed (9 days old <= 14 retainDays) even though archived -> MUST be protected!
        '2611.00010': makeRichHistoricalAnalyzedPaper('2611.00010', '2026-11-15'),
        // 6. Active current/filtered-papers.json paper (even with old date) -> MUST be protected!
        '2611.00011': makeRichHistoricalAnalyzedPaper('2611.00011', '2026-05-01'),
        // 7. Active current/deep-analysis-result.json paper -> MUST be protected (including analysisRecoveryImageManifest)!
        '2611.00012': makeRichHistoricalAnalyzedPaper('2611.00012', '2026-11-24'),
        // 8. Old pending_analysis paper -> MUST be protected!
        '2602.00020': makeHistoricalSeenPaper('2602.00020', '2026-02-01', {
            analysisRecoveryImageManifest: { candidates: [{ url: 'https://arxiv.org/html/2602.00020/f1.png' }] },
            digestStatus: {
                status: 'pending_analysis',
                batchDate: '2026-02-01',
                updatedAt: '2026-02-01T10:00:00+08:00',
                filterDecision: true,
                filterReason: 'Pending audio paper'
            }
        }),
        // 9. Old analysis_failed paper -> MUST be protected!
        '2602.00021': makeRichHistoricalAnalyzedPaper('2602.00021', '2026-02-01', {
            digestStatus: {
                status: 'analysis_failed',
                batchDate: '2026-02-01',
                updatedAt: '2026-02-01T10:00:00+08:00',
                latestAttemptStatus: 'analysis_failed',
                filterDecision: true,
                error: 'timeout',
                filterReason: 'Failed audio paper'
            }
        }),
        // 10. Old analyzed paper with latestAttemptStatus='analysis_failed' -> MUST keep analysis + analysisRecoveryImageManifest!
        '2602.00022': makeRichHistoricalAnalyzedPaper('2602.00022', '2026-02-01', {
            analysisCheckpoint: 'partial-checkpoint-body',
            digestStatus: {
                status: 'analyzed',
                batchDate: '2026-02-01',
                updatedAt: '2026-02-01T11:00:00+08:00',
                latestAttemptStatus: 'analysis_failed',
                filterDecision: true,
                error: 'reanalysis failed',
                filterReason: 'Retrying reanalysis'
            }
        }),
        // 11. Unknown-date paper (no fetch/batch/updated date) -> fail-closed protected!
        '2602.00023': {
            arxivId: '2602.00023v1',
            title: 'Legacy Paper Without Date',
            authors: ['Dave'],
            abstract: 'Legacy abstract without batch date',
            digestStatus: { status: 'seen' }
        }
    };

    const papersFile = path.join(currentDir, 'papers.json');
    const database = {
        generation: 7,
        lastUpdated: '2026-11-24T08:00:00+08:00',
        papers
    };
    fs.writeFileSync(papersFile, JSON.stringify(database));

    // Write cryptographically matching archives for 2601.00001, 2611.00010, 2611.00011, 2602.00022
    const writeArchive = (date, archivePapers) => {
        const dir = path.join(archiveDir, date);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'deep-analysis-result.json'), JSON.stringify({
            batchDate: date,
            timestamp: `${date}T12:00:00+08:00`,
            papers: archivePapers
        }));
    };
    writeArchive('2026-06-01', [makeMatchingArchiveEntry(papers['2601.00001'])]);
    writeArchive('2026-11-15', [makeMatchingArchiveEntry(papers['2611.00010'])]);
    writeArchive('2026-05-01', [makeMatchingArchiveEntry(papers['2611.00011'])]);
    writeArchive('2026-02-01', [makeMatchingArchiveEntry(papers['2602.00022'])]);

    // Write corrupt archive for 2601.00004 (must fail-closed!)
    fs.mkdirSync(path.join(archiveDir, '2026-06-04'), { recursive: true });
    fs.writeFileSync(path.join(archiveDir, '2026-06-04', 'deep-analysis-result.json'), '{not-valid-json');

    // Write active current/filtered-papers.json and current/deep-analysis-result.json
    fs.writeFileSync(path.join(currentDir, 'filtered-papers.json'), JSON.stringify({
        batchDate: referenceDate,
        timestamp: `${referenceDate}T09:00:00+08:00`,
        status: 'complete',
        papers: [{ arxivId: '2611.00011v1' }, { arxivId: '2611.00012v1' }]
    }));
    fs.writeFileSync(path.join(currentDir, 'deep-analysis-result.json'), JSON.stringify({
        batchDate: referenceDate,
        timestamp: `${referenceDate}T10:00:00+08:00`,
        status: 'running',
        papers: [makeMatchingArchiveEntry(papers['2611.00012'])]
    }));

    return { rootDir, currentDir, archiveDir, receiptDir, papersFile, database, writeArchive };
}

function createIsolatedDailyCliWorkspace(roleName = 'daily') {
    const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wave14-6a-cli-ws-')));
    const scriptsDest = path.join(workspaceRoot, 'scripts');
    const copyTree = (src, dst) => {
        fs.mkdirSync(dst, { recursive: true });
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) continue;
            const from = path.join(src, entry.name);
            const to = path.join(dst, entry.name);
            if (entry.isDirectory()) copyTree(from, to);
            else if (entry.isFile()) fs.copyFileSync(from, to);
        }
    };
    copyTree(path.join(REPO_ROOT, 'scripts'), scriptsDest);
    copyTree(path.join(REPO_ROOT, 'config'), path.join(workspaceRoot, 'config'));
    copyTree(path.join(REPO_ROOT, 'prompts'), path.join(workspaceRoot, 'prompts'));
    copyTree(path.join(REPO_ROOT, 'manual', 'scripts'), path.join(workspaceRoot, 'manual', 'scripts'));
    if (roleName) {
        writeWorkspaceRole(roleName, { root: workspaceRoot, force: true });
    }
    return {
        workspaceRoot,
        cliPath: path.join(scriptsDest, 'compact-papers-ledger.js')
    };
}

function buildStrictCleanSubprocessEnv(extra = {}) {
    const env = { ...process.env };
    delete env.CODEX_SANDBOX;
    delete env.AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE;
    delete env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE;
    delete env.PD_WORKSPACE_ALLOW_CROSS_ROLE;
    // P0 #1: Remove ALL log-disabling / test-context env vars to prove zero log files are written!
    delete env.NODE_TEST_CONTEXT;
    delete env.PAPER_DIGEST_DISABLE_FILE_LOGS;
    delete env.PD_DISABLE_FILE_LOGS;
    delete env.VERIFY_PROJECT_DISABLE_FILE_LOGS;
    for (const [k, v] of Object.entries(extra)) {
        if (v === undefined) delete env[k];
        else env[k] = v;
    }
    return env;
}

describe('Wave 14.6A Part A: write-time bloat prevention in digest-status.js & full-fetch.js', () => {
    it('PAPERS_LEDGER_STRIP_ON_WRITE_FIELDS 完整冻结导出全部 17 个临时字段', () => {
        assert.strictEqual(Object.isFrozen(PAPERS_LEDGER_STRIP_ON_WRITE_FIELDS), true);
        assert.deepStrictEqual([...PAPERS_LEDGER_STRIP_ON_WRITE_FIELDS], [
            'apiReaderPlan',
            'apiReaderFailedBundleHistory',
            'analysisStaleSnapshots',
            'apiReaderFigures',
            'apiReaderAuthors',
            'apiReaderResources',
            'readerRevisionHistory',
            'dailyScoringRefreshHistory',
            'fullStageReanalysis',
            'apiReaderSourceBindingEvidence',
            'apiReaderTableEvidence',
            'apiReaderFormulaEvidence',
            'manualArtifactIndex',
            'manualReaderLongform',
            'manualResultClaims',
            'manualReadabilityRubric',
            'manualIngestionCheckpoint'
        ]);
    });

    it('stripPapersLedgerEphemeralFields 清理全部 17 个字段并去重重复 summary，同时严格保留核心分析字段且不改原对象', () => {
        const input = {
            arxivId: '2611.00001v1',
            title: 'Speech Codec',
            abstract: 'Same abstract text',
            summary: 'Same abstract text',
            analysis: validAnalysisText(),
            parsed: { score: 8.6 },
            apiReaderArticle: '# Reader Article',
            analysisManifest: { version: 1, stages: { primaryAnalysis: { status: 'complete' } } },
            freshRewriteProvenance: { runId: 'run-1', sourceGeneration: 1 },
            selectedImageUrls: ['https://example.com/1.png'],
            imageUrls: ['https://example.com/1.png'],
            imageManifest: { selected: ['fig1'] },
            analysisCheckpoint: 'checkpoint-data',
            ...makeAllEphemeralFields()
        };

        const cleaned = stripPapersLedgerEphemeralFields(input);

        assert.strictEqual(input.summary, 'Same abstract text');
        assert.ok(input.apiReaderPlan);

        for (const field of PAPERS_LEDGER_STRIP_ON_WRITE_FIELDS) {
            assert.strictEqual(Object.prototype.hasOwnProperty.call(cleaned, field), false, `${field} should be stripped`);
        }
        assert.strictEqual(Object.prototype.hasOwnProperty.call(cleaned, 'summary'), false);
        assert.strictEqual(cleaned.abstract, 'Same abstract text');

        assert.strictEqual(cleaned.analysis, input.analysis);
        assert.deepStrictEqual(cleaned.parsed, input.parsed);
        assert.strictEqual(cleaned.apiReaderArticle, input.apiReaderArticle);
        assert.deepStrictEqual(cleaned.analysisManifest, input.analysisManifest);
        assert.deepStrictEqual(cleaned.freshRewriteProvenance, input.freshRewriteProvenance);
        assert.deepStrictEqual(cleaned.selectedImageUrls, input.selectedImageUrls);
        assert.deepStrictEqual(cleaned.imageUrls, input.imageUrls);
        assert.deepStrictEqual(cleaned.imageManifest, input.imageManifest);
        assert.strictEqual(cleaned.analysisCheckpoint, input.analysisCheckpoint);

        const distinct = stripPapersLedgerEphemeralFields({
            arxivId: '2611.00002',
            abstract: 'Original abstract',
            summary: 'Distinct short summary'
        });
        assert.strictEqual(distinct.summary, 'Distinct short summary');
    });

    it('mergeAnalysisDigestPaper / applyAnalysisDigestStatuses 在成功与失败合并后均剥离 17 个临时字段并保留核心字段', () => {
        const incomingSuccess = validAnalysisPaper('2611.00100v1', {
            abstract: 'Identical abstract',
            summary: 'Identical abstract',
            freshRewriteProvenance: { runId: 'r-100', sourceGeneration: 1 },
            imageManifest: { selected: ['fig1'] },
            ...makeAllEphemeralFields()
        });
        const mergedSuccess = mergeAnalysisDigestPaper({ arxivId: '2611.00100v1' }, incomingSuccess);
        for (const field of PAPERS_LEDGER_STRIP_ON_WRITE_FIELDS) {
            assert.strictEqual(Object.prototype.hasOwnProperty.call(mergedSuccess, field), false);
        }
        assert.strictEqual(Object.prototype.hasOwnProperty.call(mergedSuccess, 'summary'), false);
        assert.strictEqual(mergedSuccess.analysis, incomingSuccess.analysis);
        assert.strictEqual(mergedSuccess.apiReaderArticle, incomingSuccess.apiReaderArticle);
        assert.deepStrictEqual(mergedSuccess.freshRewriteProvenance, incomingSuccess.freshRewriteProvenance);

        const papersData = {
            papers: {
                '2611.00101': {
                    arxivId: '2611.00101',
                    analysis: validAnalysisText(),
                    parsed: { score: 8.1 },
                    imageManifest: { selected: ['old'] },
                    digestStatus: { status: 'analyzed' }
                }
            }
        };
        applyAnalysisDigestStatuses(papersData, [{
            arxivId: '2611.00101',
            analysis: null,
            error: 'reanalysis timeout',
            analysisCheckpoint: 'partial-ckpt',
            imageManifest: { selected: ['recovery-fig'] },
            ...makeAllEphemeralFields()
        }], { batchDate: '2026-11-24', updatedAt: '2026-11-24T12:00:00+08:00' });

        const failedRec = papersData.papers['2611.00101'];
        for (const field of PAPERS_LEDGER_STRIP_ON_WRITE_FIELDS) {
            assert.strictEqual(Object.prototype.hasOwnProperty.call(failedRec, field), false);
        }
        assert.strictEqual(failedRec.analysis, validAnalysisText());
        assert.deepStrictEqual(failedRec.analysisRecoveryImageManifest, { selected: ['recovery-fig'] });
        assert.strictEqual(failedRec.latestAnalysisAttemptError, 'reanalysis timeout');
        assert.strictEqual(failedRec.analysisCheckpoint, 'partial-ckpt');
    });

    it('[P0 #4] mergePapersDatabases 短路未变更含陈旧 error 记录、阻断缺失 status 降级、正确处理新分析/纯元数据刷新与真实失败', () => {
        // 1. wouldDowngradeAnalyzed covers pending_analysis, seen, AND missing digestStatus.status
        for (const incomingDigestStatus of [
            { status: 'pending_analysis', batchDate: '2026-11-24', updatedAt: '2026-11-24T09:00:00+08:00' },
            { status: 'seen', batchDate: '2026-11-24', updatedAt: '2026-11-24T09:00:00+08:00' },
            undefined,
            { updatedAt: '2026-11-24T09:00:00+08:00' }
        ]) {
            const currentDb = {
                generation: 10,
                papers: {
                    '2611.00200': {
                        arxivId: '2611.00200v1',
                        title: 'Already Analyzed',
                        abstract: 'Dup text',
                        summary: 'Dup text',
                        sources: ['arxiv'],
                        analysis: validAnalysisText(),
                        parsed: { score: 8.5 },
                        apiReaderArticle: '# Reader',
                        imageManifest: { selected: ['fig1'] },
                        ...makeAllEphemeralFields(),
                        digestStatus: {
                            status: 'analyzed',
                            batchDate: '2026-11-20',
                            updatedAt: '2026-11-20T12:00:00+08:00',
                            latestAttemptStatus: 'analyzed',
                            error: null
                        }
                    }
                }
            };
            const incomingPaper = {
                arxivId: '2611.00200v1',
                title: 'Already Analyzed',
                abstract: 'Dup text',
                summary: 'Dup text',
                sources: ['huggingface'],
                imageManifest: { selected: ['fig1'] },
                ...makeAllEphemeralFields(),
                ...(incomingDigestStatus !== undefined ? { digestStatus: incomingDigestStatus } : {})
            };

            const merged = mergePapersDatabases(currentDb, { generation: 5, papers: { '2611.00200': incomingPaper } });
            const rec = merged.papers['2611.00200'];
            assert.strictEqual(rec.digestStatus.status, 'analyzed');
            assert.strictEqual(rec.analysis, validAnalysisText());
            assert.deepStrictEqual(rec.imageManifest, { selected: ['fig1'] });
            assert.strictEqual(rec.analysisRecoveryImageManifest, undefined);
            assert.strictEqual(rec.latestAnalysisAttemptError, undefined);
            assert.strictEqual(rec.latestAnalysisAttemptAt, undefined);
            assert.strictEqual(Object.prototype.hasOwnProperty.call(rec, 'summary'), false);
            assert.deepStrictEqual(rec.sources.sort(), ['arxiv', 'huggingface']);
        }

        // 2. Unchanged historical analyzed record with stale `error` field MUST NOT re-leak recovery fields!
        const staleErrorAnalyzed = {
            arxivId: '2611.00201v1',
            sources: ['arxiv'],
            analysis: validAnalysisText(),
            apiReaderArticle: '# Existing Reader',
            imageManifest: { selected: ['fig-legacy'] },
            error: 'ancient transient error',
            digestStatus: {
                status: 'analyzed',
                batchDate: '2026-08-01',
                updatedAt: '2026-08-01T12:00:00+08:00',
                latestAttemptStatus: 'analyzed'
            }
        };
        const mergedUnchanged = mergePapersDatabases(
            { generation: 2, papers: { '2611.00201': staleErrorAnalyzed } },
            { generation: 2, papers: { '2611.00201': { ...staleErrorAnalyzed, sources: ['huggingface'] } } }
        );
        const recUnchanged = mergedUnchanged.papers['2611.00201'];
        assert.strictEqual(recUnchanged.analysisRecoveryImageManifest, undefined);
        assert.strictEqual(recUnchanged.latestAnalysisAttemptError, undefined);
        assert.strictEqual(recUnchanged.latestAnalysisAttemptAt, undefined);
        assert.deepStrictEqual(recUnchanged.sources.sort(), ['arxiv', 'huggingface']);

        // 3. Non-failed analyzed update WITH valid updated analysis body (even after ephemeral stripping!)
        // MUST adopt the new analysis & clear all 6 stale failure-recovery fields!
        const newAnalysisBody = validAnalysisText() + '\n更新后的重分析段落。';
        const currentWithStaleRecovery = {
            arxivId: '2611.00202v1',
            sources: ['arxiv'],
            analysis: validAnalysisText(),
            apiReaderArticle: '# Old Reader',
            analysisManifest: { version: 1, tag: 'old' },
            analysisRecoveryImageManifest: { candidates: [{ url: 'old' }] },
            latestAnalysisAttemptError: 'old timeout',
            latestAnalysisAttemptAt: '2026-11-20T10:00:00+08:00',
            analysisCheckpoint: 'old-ckpt',
            analysisStageCheckpoints: { s1: 'old' },
            analysisFactReviewObligation: { required: true },
            error: 'old timeout',
            digestStatus: {
                status: 'analyzed',
                batchDate: '2026-11-20',
                updatedAt: '2026-11-20T10:00:00+08:00',
                latestAttemptStatus: 'analysis_failed'
            }
        };
        const incomingUpdatedAnalyzed = {
            arxivId: '2611.00202v1',
            sources: ['huggingface'],
            analysis: newAnalysisBody,
            apiReaderArticle: '# New Reader v2',
            analysisManifest: { version: 1, tag: 'new' },
            ...makeAllEphemeralFields(),
            digestStatus: {
                status: 'analyzed',
                batchDate: '2026-11-24',
                updatedAt: '2026-11-24T12:00:00+08:00',
                latestAttemptStatus: 'analyzed',
                error: null
            }
        };
        const mergedUpdated = mergePapersDatabases(
            { generation: 3, papers: { '2611.00202': currentWithStaleRecovery } },
            { generation: 3, papers: { '2611.00202': incomingUpdatedAnalyzed } }
        );
        const recUpdated = mergedUpdated.papers['2611.00202'];
        assert.strictEqual(recUpdated.analysis, newAnalysisBody);
        assert.strictEqual(recUpdated.apiReaderArticle, '# New Reader v2');
        assert.deepStrictEqual(recUpdated.analysisManifest, { version: 1, tag: 'new' });
        assert.strictEqual(recUpdated.analysisRecoveryImageManifest, undefined);
        assert.strictEqual(recUpdated.latestAnalysisAttemptError, undefined);
        assert.strictEqual(recUpdated.latestAnalysisAttemptAt, undefined);
        assert.strictEqual(recUpdated.analysisCheckpoint, undefined);
        assert.strictEqual(recUpdated.analysisStageCheckpoints, undefined);
        assert.strictEqual(recUpdated.analysisFactReviewObligation, undefined);
        assert.strictEqual(recUpdated.error, undefined);
        assert.deepStrictEqual(recUpdated.sources.sort(), ['arxiv', 'huggingface']);
        for (const field of PAPERS_LEDGER_STRIP_ON_WRITE_FIELDS) {
            assert.strictEqual(Object.prototype.hasOwnProperty.call(recUpdated, field), false);
        }

        // 4. Non-failed analyzed metadata/status-only refresh (no new valid analysis body)
        const mergedMetaOnly = mergePapersDatabases(
            {
                generation: 4,
                papers: {
                    '2611.00203': {
                        arxivId: '2611.00203v1',
                        sources: ['arxiv'],
                        analysis: validAnalysisText(),
                        parsed: { score: 8.3 },
                        imageManifest: { selected: ['fig1'] },
                        digestStatus: { status: 'analyzed', batchDate: '2026-11-20', updatedAt: '2026-11-20T10:00:00+08:00' }
                    }
                }
            },
            {
                generation: 4,
                papers: {
                    '2611.00203': {
                        arxivId: '2611.00203v1',
                        sources: ['huggingface'],
                        imageManifest: { selected: ['fig1'] },
                        digestStatus: { status: 'analyzed', batchDate: '2026-11-24', updatedAt: '2026-11-24T10:00:00+08:00', latestAttemptStatus: 'analyzed' }
                    }
                }
            }
        );
        const recMeta = mergedMetaOnly.papers['2611.00203'];
        assert.strictEqual(recMeta.analysis, validAnalysisText());
        assert.strictEqual(recMeta.digestStatus.batchDate, '2026-11-24');
        assert.strictEqual(recMeta.analysisRecoveryImageManifest, undefined);
        assert.strictEqual(recMeta.latestAnalysisAttemptError, undefined);
        assert.deepStrictEqual(recMeta.sources.sort(), ['arxiv', 'huggingface']);

        // 5. Explicitly analyzed metadata refresh carrying stale top-level `error` with digestStatus.error === null
        //    MUST NOT re-enter isRealFailureUpdate or leak recovery fields (Round 2 P2)!
        const mergedStaleTopLevelError = mergePapersDatabases(
            {
                generation: 5,
                papers: {
                    '2611.00205': {
                        arxivId: '2611.00205v1',
                        sources: ['arxiv'],
                        analysis: validAnalysisText(),
                        imageManifest: { selected: ['fig-a'] },
                        error: 'stale old top-level error',
                        digestStatus: {
                            status: 'analyzed',
                            batchDate: '2026-11-20',
                            updatedAt: '2026-11-20T10:00:00+08:00',
                            latestAttemptStatus: 'analyzed',
                            error: null
                        }
                    }
                }
            },
            {
                generation: 5,
                papers: {
                    '2611.00205': {
                        arxivId: '2611.00205v1',
                        sources: ['huggingface'],
                        imageManifest: { selected: ['fig-a'] },
                        error: 'stale old top-level error',
                        digestStatus: {
                            status: 'analyzed',
                            batchDate: '2026-11-24',
                            updatedAt: '2026-11-24T10:00:00+08:00',
                            latestAttemptStatus: 'analyzed',
                            error: null
                        }
                    }
                }
            }
        );
        const recStaleErr = mergedStaleTopLevelError.papers['2611.00205'];
        assert.strictEqual(recStaleErr.digestStatus.status, 'analyzed');
        assert.strictEqual(recStaleErr.digestStatus.batchDate, '2026-11-24');
        assert.strictEqual(recStaleErr.analysis, validAnalysisText());
        assert.strictEqual(recStaleErr.analysisRecoveryImageManifest, undefined);
        assert.strictEqual(recStaleErr.latestAnalysisAttemptError, undefined);
        assert.strictEqual(recStaleErr.latestAnalysisAttemptAt, undefined);
        assert.deepStrictEqual(recStaleErr.sources.sort(), ['arxiv', 'huggingface']);

        // 6. Real newer failure update MUST preserve existing valid analysis and record recovery fields
        const mergedRealFail = mergePapersDatabases(
            {
                generation: 5,
                papers: {
                    '2611.00204': {
                        arxivId: '2611.00204v1',
                        analysis: validAnalysisText(),
                        imageManifest: { selected: ['old-fig'] },
                        digestStatus: { status: 'analyzed', updatedAt: '2026-11-20T10:00:00+08:00', latestAttemptStatus: 'analyzed' }
                    }
                }
            },
            {
                generation: 5,
                papers: {
                    '2611.00204': {
                        arxivId: '2611.00204v1',
                        analysis: null,
                        error: 'real timeout',
                        imageManifest: { selected: ['new-recovery-fig'] },
                        digestStatus: { status: 'analysis_failed', updatedAt: '2026-11-24T10:00:00+08:00', latestAttemptStatus: 'analysis_failed', error: 'real timeout' }
                    }
                }
            }
        );
        assert.strictEqual(mergedRealFail.papers['2611.00204'].analysis, validAnalysisText());
        assert.deepStrictEqual(mergedRealFail.papers['2611.00204'].analysisRecoveryImageManifest, { selected: ['new-recovery-fig'] });
        assert.strictEqual(mergedRealFail.papers['2611.00204'].latestAnalysisAttemptError, 'real timeout');
    });

    it('[P0 #4] mergeVersionedPaperRecords 合并非失败新版本元数据时不合成失败恢复字段', () => {
        const normalized = normalizePapersMap({
            '2611.00250v1': {
                arxivId: '2611.00250v1',
                title: 'Old Version Title',
                sources: ['arxiv'],
                analysis: validAnalysisText(),
                parsed: { score: 8.7 },
                apiReaderArticle: '# Reader v1',
                imageManifest: { selected: ['fig1'] },
                digestStatus: { status: 'analyzed', batchDate: '2026-11-10', updatedAt: '2026-11-10T12:00:00+08:00' }
            },
            '2611.00250v2': {
                arxivId: '2611.00250v2',
                title: 'New Version Title',
                sources: ['huggingface'],
                imageManifest: { selected: ['fig1'] },
                ...makeAllEphemeralFields(),
                digestStatus: { status: 'seen', batchDate: '2026-11-24', updatedAt: '2026-11-24T09:00:00+08:00' }
            }
        });
        const rec = normalized['2611.00250'];
        assert.strictEqual(rec.arxivId, '2611.00250v2');
        assert.strictEqual(rec.title, 'New Version Title');
        assert.strictEqual(rec.analysis, validAnalysisText());
        assert.strictEqual(rec.apiReaderArticle, '# Reader v1');
        assert.strictEqual(rec.digestStatus.status, 'analyzed');
        assert.strictEqual(rec.analysisRecoveryImageManifest, undefined);
        assert.strictEqual(rec.latestAnalysisAttemptError, undefined);
        assert.strictEqual(rec.latestAnalysisAttemptAt, undefined);
        assert.deepStrictEqual(rec.sources.sort(), ['arxiv', 'huggingface']);
        for (const field of PAPERS_LEDGER_STRIP_ON_WRITE_FIELDS) {
            assert.strictEqual(Object.prototype.hasOwnProperty.call(rec, field), false);
        }
    });

    it('[P2 #10] savePapersDatabase 与 full-fetch normalizePaperForLedger 统一经 stripPapersLedgerEphemeralFields 去重且不修改原候选', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave14-6a-save-'));
        try {
            const file = path.join(dir, 'papers.json');
            const rawCandidate = {
                arxivId: '2611.00300v1',
                title: 'New Audio Paper',
                abstract: 'Exact same text',
                summary: 'Exact same text',
                apiReaderPlan: { steps: [1, 2] }
            };
            const normalized = normalizePaperForLedger(null, rawCandidate);
            assert.strictEqual(rawCandidate.summary, 'Exact same text');
            assert.ok(rawCandidate.apiReaderPlan);
            assert.strictEqual(Object.prototype.hasOwnProperty.call(normalized, 'summary'), false);
            assert.strictEqual(Object.prototype.hasOwnProperty.call(normalized, 'apiReaderPlan'), false);
            assert.strictEqual(normalized.abstract, 'Exact same text');

            const data = {
                generation: 0,
                papers: {
                    '2611.00300': {
                        ...rawCandidate,
                        digestStatus: { status: 'seen', batchDate: '2026-11-24', updatedAt: '2026-11-24T10:00:00+08:00' }
                    }
                }
            };
            savePapersDatabase(data, file);
            const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
            assert.strictEqual(saved.generation, 1);
            assert.strictEqual(Object.prototype.hasOwnProperty.call(saved.papers['2611.00300'], 'summary'), false);
            assert.strictEqual(Object.prototype.hasOwnProperty.call(saved.papers['2611.00300'], 'apiReaderPlan'), false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('Wave 14.6A Part B: compact-papers-ledger.js 参数、安全闸门、压缩档位与对抗测试', () => {
    it('parseCompactPapersArgs 严格解析合法参数并拒绝冲突或非法输入', () => {
        const defaults = parseCompactPapersArgs([]);
        assert.strictEqual(defaults.dryRun, true);
        assert.strictEqual(defaults.write, false);
        assert.strictEqual(defaults.profile, 'ledger');
        assert.strictEqual(defaults.retainDays, 14);

        const custom = parseCompactPapersArgs([
            '--write',
            '--profile=safe-blobs',
            '--retain-days', '7',
            '--papers-file', '/tmp/p.json',
            '--current-dir=/tmp/c',
            '--archive-dir', '/tmp/a',
            '--receipt-dir', '/tmp/r',
            '--json'
        ]);
        assert.strictEqual(custom.write, true);
        assert.strictEqual(custom.dryRun, false);
        assert.strictEqual(custom.profile, 'safe-blobs');
        assert.strictEqual(custom.retainDays, 7);
        assert.strictEqual(custom.json, true);

        assert.throws(() => parseCompactPapersArgs(['--dry-run', '--write']), /不能同时指定/);
        assert.throws(() => parseCompactPapersArgs(['--profile', 'aggressive']), /--profile/);
        assert.throws(() => parseCompactPapersArgs(['--retain-days', '0']), /--retain-days/);
        assert.throws(() => parseCompactPapersArgs(['--retain-days', '-2']), /--retain-days/);
        assert.throws(() => parseCompactPapersArgs(['--retain-days', '3.5']), /--retain-days/);
        assert.throws(() => parseCompactPapersArgs(['--unknown-flag']), /未知参数/);
    });

    it('--dry-run 严格只读，零写入且返回准确的字节节省、受保护计数和字段明细', () => {
        const fx = createCompactionFixtureWorkspace('2026-11-24');
        try {
            const rawBefore = fs.readFileSync(fx.papersFile);
            const shaBefore = sha256(rawBefore);

            const report = compactPapersLedger({
                write: false,
                profile: 'ledger',
                retainDays: 14,
                referenceDate: '2026-11-24',
                papersFile: fx.papersFile,
                currentDir: fx.currentDir,
                archiveDir: fx.archiveDir,
                receiptDir: fx.receiptDir
            });

            assert.strictEqual(report.mode, 'dry-run');
            assert.strictEqual(report.noOp, false);
            assert.strictEqual(report.before.bytes, rawBefore.length);
            assert.ok(report.after.bytes < report.before.bytes);
            assert.strictEqual(report.savings.bytes, report.before.bytes - report.after.bytes);
            assert.ok(report.savings.percent > 0);
            assert.strictEqual(report.before.paperCount, 11);
            assert.strictEqual(report.after.paperCount, 11);
            assert.strictEqual(report.counts.protectedCount, 9);
            assert.strictEqual(report.counts.protectedBreakdown.inCurrent, 2);
            assert.strictEqual(report.counts.protectedBreakdown.withinRetainDays, 2);
            assert.strictEqual(report.counts.protectedBreakdown.pendingOrFailed, 3);
            assert.strictEqual(report.counts.protectedBreakdown.hasRecoveryState, 1);
            assert.strictEqual(report.counts.protectedBreakdown.unarchivedAnalyzed, 4);
            assert.strictEqual(report.counts.protectedBreakdown.unknownDate, 1);
            assert.strictEqual(report.archiveVerification.unreadableArchiveFiles.length, 1);
            assert.ok(report.fieldBreakdown.analysis);
            assert.ok(report.fieldBreakdown.apiReaderArticle);
            assert.ok(report.fieldBreakdown.abstract);
            assert.ok(report.fieldBreakdown['digestStatus.filterRawResponse']);
            assert.strictEqual(report.backup, null);
            assert.strictEqual(report.receiptPath, null);

            assert.strictEqual(sha256(fs.readFileSync(fx.papersFile)), shaBefore);
            assert.strictEqual(fs.existsSync(fx.receiptDir), false);
            assert.strictEqual(fs.existsSync(`${fx.papersFile}.lock`), false);
        } finally {
            fs.rmSync(fx.rootDir, { recursive: true, force: true });
        }
    });

    it('--profile safe-blobs 与 --profile ledger 均零丢键、正确保护全部活跃/近期/未完成/未归档论文，并生成已验证备份与回执', async () => {
        const fxSafe = createCompactionFixtureWorkspace('2026-11-24');
        const fxLedger = createCompactionFixtureWorkspace('2026-11-24');
        try {
            const beforeOriginal = JSON.parse(fs.readFileSync(fxSafe.papersFile, 'utf8'));
            const beforeKeys = Object.keys(beforeOriginal.papers).sort();

            const safeReport = compactPapersLedger({
                write: true,
                profile: 'safe-blobs',
                retainDays: 14,
                referenceDate: '2026-11-24',
                papersFile: fxSafe.papersFile,
                currentDir: fxSafe.currentDir,
                archiveDir: fxSafe.archiveDir,
                receiptDir: fxSafe.receiptDir
            });

            const ledgerReport = compactPapersLedger({
                write: true,
                profile: 'ledger',
                retainDays: 14,
                referenceDate: '2026-11-24',
                papersFile: fxLedger.papersFile,
                currentDir: fxLedger.currentDir,
                archiveDir: fxLedger.archiveDir,
                receiptDir: fxLedger.receiptDir
            });

            assert.strictEqual(safeReport.mode, 'write');
            assert.strictEqual(ledgerReport.mode, 'write');
            assert.strictEqual(safeReport.noOp, false);
            assert.strictEqual(ledgerReport.noOp, false);
            assert.ok(safeReport.savings.bytes > 0);
            assert.ok(ledgerReport.savings.bytes > safeReport.savings.bytes);
            assert.ok(ledgerReport.after.bytes < safeReport.after.bytes);

            const safeAfter = JSON.parse(fs.readFileSync(fxSafe.papersFile, 'utf8'));
            const ledgerAfter = JSON.parse(fs.readFileSync(fxLedger.papersFile, 'utf8'));

            assert.deepStrictEqual(Object.keys(safeAfter.papers).sort(), beforeKeys);
            assert.deepStrictEqual(Object.keys(ledgerAfter.papers).sort(), beforeKeys);
            assert.strictEqual(safeAfter.generation, 8);
            assert.strictEqual(ledgerAfter.generation, 8);
            assert.deepStrictEqual(validatePapersDatabaseRecords(safeAfter), []);
            assert.deepStrictEqual(validatePapersDatabaseRecords(ledgerAfter), []);

            // 1. Cryptographically verified archived historical analyzed paper (2601.00001)
            for (const field of [...PAPERS_LEDGER_STRIP_ON_WRITE_FIELDS, 'analysisRecoveryImageManifest', ...VERIFIED_ARCHIVED_BLOB_FIELDS]) {
                assert.strictEqual(Object.prototype.hasOwnProperty.call(safeAfter.papers['2601.00001'], field), false, `safe-blobs should strip ${field}`);
                assert.strictEqual(Object.prototype.hasOwnProperty.call(ledgerAfter.papers['2601.00001'], field), false, `ledger should strip ${field}`);
            }
            assert.ok(safeAfter.papers['2601.00001'].abstract);
            assert.ok(safeAfter.papers['2601.00001'].hf_ai_summary);
            assert.ok(safeAfter.papers['2601.00001'].digestStatus.filterRawResponse);
            assert.strictEqual(Object.prototype.hasOwnProperty.call(safeAfter.papers['2601.00001'], 'summary'), false);

            for (const field of LEDGER_HISTORICAL_TOP_LEVEL_FIELDS) {
                assert.strictEqual(Object.prototype.hasOwnProperty.call(ledgerAfter.papers['2601.00001'], field), false);
            }
            for (const subField of LEDGER_HISTORICAL_DIGEST_STATUS_FIELDS) {
                assert.strictEqual(Object.prototype.hasOwnProperty.call(ledgerAfter.papers['2601.00001'].digestStatus, subField), false);
            }
            const ledgerRec1 = ledgerAfter.papers['2601.00001'];
            assert.strictEqual(ledgerRec1.title, 'Title for 2601.00001');
            assert.deepStrictEqual(ledgerRec1.authors, ['Alice Smith', 'Bob Jones']);
            assert.deepStrictEqual(ledgerRec1.categories, ['eess.AS', 'cs.SD']);
            assert.deepStrictEqual(ledgerRec1.sources, ['arxiv', 'huggingface']);
            assert.strictEqual(ledgerRec1.pdfUrl, 'https://arxiv.org/pdf/2601.00001');
            assert.strictEqual(ledgerRec1.digestStatus.status, 'analyzed');
            assert.strictEqual(ledgerRec1.digestStatus.batchDate, '2026-06-01');
            assert.strictEqual(ledgerRec1.digestStatus.latestAttemptStatus, 'analyzed');
            assert.strictEqual(ledgerRec1.digestStatus.filterDecision, true);
            assert.strictEqual(ledgerRec1.digestStatus.error, null);

            // 2. Historical seen paper (2601.00002)
            assert.ok(safeAfter.papers['2601.00002'].abstract);
            assert.strictEqual(Object.prototype.hasOwnProperty.call(ledgerAfter.papers['2601.00002'], 'abstract'), false);
            assert.strictEqual(Object.prototype.hasOwnProperty.call(ledgerAfter.papers['2601.00002'].digestStatus, 'filterReason'), false);
            assert.strictEqual(ledgerAfter.papers['2601.00002'].digestStatus.status, 'seen');

            // 3-10. Protected papers MUST retain all heavy blobs & metadata
            const protectedAnalyzedIds = ['2601.00003', '2601.00004', '2611.00010', '2611.00011', '2611.00012', '2602.00021', '2602.00022'];
            for (const id of protectedAnalyzedIds) {
                for (const dataset of [safeAfter, ledgerAfter]) {
                    const rec = dataset.papers[id];
                    for (const blobField of VERIFIED_ARCHIVED_BLOB_FIELDS) {
                        assert.ok(rec[blobField], `${id} MUST preserve ${blobField}`);
                    }
                    assert.ok(rec.abstract, `${id} MUST preserve abstract`);
                }
            }
            assert.ok(ledgerAfter.papers['2602.00020'].abstract);
            assert.ok(ledgerAfter.papers['2602.00020'].analysisRecoveryImageManifest);
            assert.ok(ledgerAfter.papers['2602.00023'].abstract);
            assert.ok(ledgerAfter.papers['2611.00012'].analysisRecoveryImageManifest);
            assert.ok(ledgerAfter.papers['2602.00021'].analysisRecoveryImageManifest);
            assert.ok(ledgerAfter.papers['2602.00022'].analysisRecoveryImageManifest);

            for (const report of [safeReport, ledgerReport]) {
                assert.ok(report.backup && fs.existsSync(report.backup.backupPath));
                assert.ok(fs.existsSync(report.backup.manifestPath));
                const verifiedBackup = await verifyPapersBackup(report.backup.backupPath, {
                    manifestPath: report.backup.manifestPath
                });
                assert.strictEqual(verifiedBackup.manifest.contract, PAPERS_BACKUP_CONTRACT);
                assert.deepStrictEqual(verifiedBackup.data, beforeOriginal);

                assert.ok(report.receiptPath && fs.existsSync(report.receiptPath));
                const receipt = JSON.parse(fs.readFileSync(report.receiptPath, 'utf8'));
                assert.strictEqual(receipt.contract, COMPACTION_RECEIPT_CONTRACT);
                assert.strictEqual(receipt.after.generation, 8);
                assert.strictEqual(receipt.after.paperCount, beforeKeys.length);
            }
        } finally {
            fs.rmSync(fxSafe.rootDir, { recursive: true, force: true });
            fs.rmSync(fxLedger.rootDir, { recursive: true, force: true });
        }
    });

    it('[P0 #2] 密码学归档哈希核验：归档正文/Reader/parsed/manifest 不一致、含错、失败或正文无效时一律拒绝剥离', () => {
        const fx = createCompactionFixtureWorkspace('2026-11-24');
        try {
            const pAnalysisDrift = makeRichHistoricalAnalyzedPaper('2603.00001', '2026-03-01');
            const pReaderDrift = makeRichHistoricalAnalyzedPaper('2603.00002', '2026-03-01');
            const pManifestDrift = makeRichHistoricalAnalyzedPaper('2603.00003', '2026-03-01');
            const pArchiveError = makeRichHistoricalAnalyzedPaper('2603.00004', '2026-03-01');
            const pArchiveFailedAttempt = makeRichHistoricalAnalyzedPaper('2603.00005', '2026-03-01');
            const pArchiveInvalidBody = makeRichHistoricalAnalyzedPaper('2603.00006', '2026-03-01');
            const pArchiveMissingReader = makeRichHistoricalAnalyzedPaper('2603.00007', '2026-03-01');

            const db = {
                generation: 1,
                lastUpdated: '2026-11-24T08:00:00+08:00',
                papers: {
                    '2603.00001': pAnalysisDrift,
                    '2603.00002': pReaderDrift,
                    '2603.00003': pManifestDrift,
                    '2603.00004': pArchiveError,
                    '2603.00005': pArchiveFailedAttempt,
                    '2603.00006': pArchiveInvalidBody,
                    '2603.00007': pArchiveMissingReader
                }
            };
            fs.writeFileSync(fx.papersFile, JSON.stringify(db));

            fx.writeArchive('2026-03-01', [
                // 1. Stale older analysis text in archive
                makeMatchingArchiveEntry(pAnalysisDrift, { analysis: validAnalysisText() + '\nOLDER ARCHIVE VERSION' }),
                // 2. Stale older apiReaderArticle in archive
                makeMatchingArchiveEntry(pReaderDrift, { apiReaderArticle: '# Old Reader Version' }),
                // 3. Different analysisManifest in archive
                makeMatchingArchiveEntry(pManifestDrift, { analysisManifest: { version: 1, stages: { primaryAnalysis: { status: 'pending' } } } }),
                // 4. Archive entry has non-null error
                makeMatchingArchiveEntry(pArchiveError, { error: 'partial failure' }),
                // 5. Archive entry has latestAttemptStatus === 'analysis_failed'
                makeMatchingArchiveEntry(pArchiveFailedAttempt, { digestStatus: { status: 'analyzed', latestAttemptStatus: 'analysis_failed' } }),
                // 6. Archive entry has truncated/invalid analysis body failing hasValidAnalysisBody
                makeMatchingArchiveEntry(pArchiveInvalidBody, { analysis: 'truncated body' }),
                // 7. Archive entry lacks apiReaderArticle while papers.json has one
                makeMatchingArchiveEntry(pArchiveMissingReader, { apiReaderArticle: undefined })
            ]);

            compactPapersLedger({
                write: true,
                profile: 'ledger',
                retainDays: 14,
                referenceDate: '2026-11-24',
                papersFile: fx.papersFile,
                currentDir: fx.currentDir,
                archiveDir: fx.archiveDir,
                receiptDir: fx.receiptDir
            });

            const after = JSON.parse(fs.readFileSync(fx.papersFile, 'utf8'));
            for (const id of Object.keys(db.papers)) {
                const rec = after.papers[id];
                for (const blobField of VERIFIED_ARCHIVED_BLOB_FIELDS) {
                    assert.ok(rec[blobField], `${id} MUST keep ${blobField} when archive cryptographic proof fails`);
                }
                assert.ok(rec.abstract, `${id} MUST keep abstract when unarchived/proof-mismatched`);
            }
        } finally {
            fs.rmSync(fx.rootDir, { recursive: true, force: true });
        }
    });

    it('[P0 #3] 全目录 fail-closed 豁免守卫：按日期/papersSha/deepSha/filteredSha/损坏JSON/符号链接均中止且零写入，不相关历史豁免可放行', () => {
        const cases = [
            {
                name: 'filename matches active batchDate',
                file: '2026-11-24.json',
                content: ({ shaBefore }) => JSON.stringify({ batchDate: '2026-11-24', source: { papersDatabaseSha256: shaBefore } }),
                expectRegex: /活动分析豁免/
            },
            {
                name: 'unrelated filename binds papersDatabaseSha256',
                file: '2026-10-01.json',
                content: ({ shaBefore }) => JSON.stringify({ batchDate: '2026-10-01', source: { papersDatabaseSha256: shaBefore } }),
                expectRegex: /papersDatabaseSha256/
            },
            {
                name: 'unrelated filename binds deepAnalysisResultSha256',
                file: '2026-10-02.json',
                content: ({ deepSha }) => JSON.stringify({ batchDate: '2026-10-02', source: { deepAnalysisResultSha256: deepSha } }),
                expectRegex: /deepAnalysisResultSha256/
            },
            {
                name: 'unrelated filename binds filteredPapersSha256',
                file: '2026-10-03.json',
                content: ({ filteredSha }) => JSON.stringify({ batchDate: '2026-10-03', source: { filteredPapersSha256: filteredSha } }),
                expectRegex: /filteredPapersSha256/
            },
            {
                name: 'corrupt waiver JSON fails closed',
                file: '2026-09-01.json',
                content: () => '{broken-json',
                expectRegex: /无法解析/
            },
            {
                name: 'non-object waiver JSON fails closed',
                file: '2026-09-02.json',
                content: () => '[]',
                expectRegex: /格式无效/
            }
        ];

        for (const tc of cases) {
            const fx = createCompactionFixtureWorkspace('2026-11-24');
            try {
                const rawBefore = fs.readFileSync(fx.papersFile);
                const shaBefore = sha256(rawBefore);
                const deepSha = sha256(fs.readFileSync(path.join(fx.currentDir, 'deep-analysis-result.json')));
                const filteredSha = sha256(fs.readFileSync(path.join(fx.currentDir, 'filtered-papers.json')));

                const waiverDir = path.join(fx.currentDir, 'analysis-waivers');
                fs.mkdirSync(waiverDir, { recursive: true });
                fs.writeFileSync(path.join(waiverDir, tc.file), tc.content({ shaBefore, deepSha, filteredSha }));

                assert.throws(() => compactPapersLedger({
                    write: true,
                    profile: 'ledger',
                    retainDays: 14,
                    referenceDate: '2026-11-24',
                    papersFile: fx.papersFile,
                    currentDir: fx.currentDir,
                    archiveDir: fx.archiveDir,
                    receiptDir: fx.receiptDir
                }), tc.expectRegex, tc.name);

                assert.strictEqual(sha256(fs.readFileSync(fx.papersFile)), shaBefore, tc.name);
                assert.strictEqual(fs.existsSync(fx.receiptDir), false, tc.name);
            } finally {
                fs.rmSync(fx.rootDir, { recursive: true, force: true });
            }
        }

        // Symlink waiver file AND symlink analysis-waivers dir fail closed
        const fxSym = createCompactionFixtureWorkspace('2026-11-24');
        try {
            const target = path.join(fxSym.rootDir, 'outside.json');
            fs.writeFileSync(target, JSON.stringify({ batchDate: '2025-01-01', source: {} }));
            const waiverDir = path.join(fxSym.currentDir, 'analysis-waivers');
            fs.mkdirSync(waiverDir, { recursive: true });
            fs.symlinkSync(target, path.join(waiverDir, '2025-01-01.json'));

            assert.throws(() => compactPapersLedger({
                write: true,
                referenceDate: '2026-11-24',
                papersFile: fxSym.papersFile,
                currentDir: fxSym.currentDir,
                archiveDir: fxSym.archiveDir,
                receiptDir: fxSym.receiptDir
            }), /非符号链接/);

            // Replace waiverDir itself with a symlink
            fs.rmSync(waiverDir, { recursive: true, force: true });
            const realAlt = path.join(fxSym.rootDir, 'alt-waivers');
            fs.mkdirSync(realAlt, { recursive: true });
            fs.symlinkSync(realAlt, waiverDir);
            assert.throws(() => compactPapersLedger({
                write: true,
                referenceDate: '2026-11-24',
                papersFile: fxSym.papersFile,
                currentDir: fxSym.currentDir,
                archiveDir: fxSym.archiveDir,
                receiptDir: fxSym.receiptDir
            }), /非符号链接目录/);

            // Valid unrelated historical waiver allows compaction
            fs.unlinkSync(waiverDir);
            fs.mkdirSync(waiverDir, { recursive: true });
            fs.writeFileSync(path.join(waiverDir, '2026-01-01.json'), JSON.stringify({
                batchDate: '2026-01-01',
                source: {
                    papersDatabaseSha256: '0'.repeat(64),
                    deepAnalysisResultSha256: '1'.repeat(64),
                    filteredPapersSha256: '2'.repeat(64)
                }
            }));
            const report = compactPapersLedger({
                write: false,
                referenceDate: '2026-11-24',
                papersFile: fxSym.papersFile,
                currentDir: fxSym.currentDir,
                archiveDir: fxSym.archiveDir,
                receiptDir: fxSym.receiptDir
            });
            assert.strictEqual(report.waiverGuard.ok, true);
            assert.strictEqual(report.waiverGuard.checkedWaiverFiles.length, 1);
        } finally {
            fs.rmSync(fxSym.rootDir, { recursive: true, force: true });
        }
    });

    it('[P1 #5 & #6] 保护活动恢复态 (analysisStageCheckpoints / analysisFactReviewObligation) 并对日期解析 fail-closed', () => {
        const fx = createCompactionFixtureWorkspace('2026-11-24');
        try {
            // Invalid options.referenceDate must throw loudly
            assert.throws(() => compactPapersLedger({
                write: false,
                referenceDate: '2026-02-30',
                papersFile: fx.papersFile,
                currentDir: fx.currentDir,
                archiveDir: fx.archiveDir,
                receiptDir: fx.receiptDir
            }), /referenceDate 日期格式无效/);

            const pStageCkpt = makeRichHistoricalAnalyzedPaper('2604.00001', '2026-04-01', {
                analysisStageCheckpoints: { scoringAudit: { status: 'pending' } }
            });
            const pFactObligation = makeRichHistoricalAnalyzedPaper('2604.00002', '2026-04-01', {
                analysisFactReviewObligation: { required: true, reason: 'pending review' }
            });
            const pRecentAttempt = makeRichHistoricalAnalyzedPaper('2604.00003', '2026-04-01', {
                latestAnalysisAttemptAt: '2026-11-20T09:00:00+08:00'
            });
            const pMalformedDate = makeRichHistoricalAnalyzedPaper('2604.00004', '2026-04-01', {
                latestAnalysisAttemptAt: 'not-a-valid-date'
            });
            const pRecentFilterDecided = makeHistoricalSeenPaper('2604.00005', '2026-04-01', {
                digestStatus: {
                    status: 'seen',
                    batchDate: '2026-04-01',
                    updatedAt: '2026-04-01T10:00:00+08:00',
                    filterDecidedAt: '2026-11-22T08:00:00+08:00',
                    filterReason: 'recent decision'
                }
            });

            assert.strictEqual(getMostRecentPaperDate(pRecentAttempt), '2026-11-20');
            assert.strictEqual(getMostRecentPaperDate(pRecentFilterDecided), '2026-11-22');
            assert.strictEqual(getMostRecentPaperDate(pMalformedDate), '');

            const db = {
                generation: 1,
                lastUpdated: '2026-11-24T08:00:00+08:00',
                papers: {
                    '2604.00001': pStageCkpt,
                    '2604.00002': pFactObligation,
                    '2604.00003': pRecentAttempt,
                    '2604.00004': pMalformedDate,
                    '2604.00005': pRecentFilterDecided
                }
            };
            fs.writeFileSync(fx.papersFile, JSON.stringify(db));
            fx.writeArchive('2026-04-01', [
                makeMatchingArchiveEntry(pStageCkpt),
                makeMatchingArchiveEntry(pFactObligation),
                makeMatchingArchiveEntry(pRecentAttempt),
                makeMatchingArchiveEntry(pMalformedDate)
            ]);

            const report = compactPapersLedger({
                write: true,
                profile: 'ledger',
                retainDays: 14,
                referenceDate: '2026-11-24',
                papersFile: fx.papersFile,
                currentDir: fx.currentDir,
                archiveDir: fx.archiveDir,
                receiptDir: fx.receiptDir
            });

            assert.strictEqual(report.counts.protectedCount, 5);
            assert.strictEqual(report.counts.protectedBreakdown.hasRecoveryState, 2);
            assert.strictEqual(report.counts.protectedBreakdown.unknownDate, 1);

            const after = JSON.parse(fs.readFileSync(fx.papersFile, 'utf8'));
            for (const id of ['2604.00001', '2604.00002', '2604.00003', '2604.00004']) {
                for (const blobField of VERIFIED_ARCHIVED_BLOB_FIELDS) {
                    assert.ok(after.papers[id][blobField], `${id} MUST keep ${blobField}`);
                }
                assert.ok(after.papers[id].abstract, `${id} MUST keep abstract`);
            }
            // Recovery-state papers ALSO preserve analysisRecoveryImageManifest
            assert.ok(after.papers['2604.00001'].analysisRecoveryImageManifest);
            assert.ok(after.papers['2604.00002'].analysisRecoveryImageManifest);
            // Recent filterDecidedAt protects seen paper's abstract & filterReason
            assert.ok(after.papers['2604.00005'].abstract);
            assert.strictEqual(after.papers['2604.00005'].digestStatus.filterReason, 'recent decision');
        } finally {
            fs.rmSync(fx.rootDir, { recursive: true, force: true });
        }
    });

    it('[Round 2 P1] buildArchiveRecordProof 放行合法旧版归档并拒绝任何失败/未完成标记或短/无标题残稿', () => {
        const legacyBody = [
            '## 背景与问题',
            '这篇 2026 年 4 月旧版归档论文使用早期写作模板，不包含当前新版评分细则字段，但正文完整详实。'.repeat(8),
            '### 核心方法与实验结果',
            '模型在 LibriSpeech 与内部音频基准上实现了显著 WER 下降，训练配置与消融分析清晰完整。'.repeat(8)
        ].join('\n\n');
        assert.ok(legacyBody.length >= 500);

        // 1. Valid legacy-schema archive record (even with non-blocking apiReaderTableAudit failure) is admitted
        const legacyOk = buildArchiveRecordProof({
            arxivId: '2604.10001v1',
            analysis: legacyBody,
            parsed: { score: 7.8, summary: '旧版摘要' },
            analysisManifest: {
                version: 1,
                stages: {
                    primaryAnalysis: { status: 'complete' },
                    apiReaderTableAudit: { status: 'transient_failure' }
                }
            }
        }, '2026-04-15');
        assert.ok(legacyOk);
        assert.strictEqual(legacyOk.archiveDate, '2026-04-15');
        assert.match(legacyOk.analysisSha256, /^[a-f0-9]{64}$/);
        assert.match(legacyOk.parsedSha256, /^[a-f0-9]{64}$/);
        assert.match(legacyOk.analysisManifestSha256, /^[a-f0-9]{64}$/);

        // 2. Explicit failure / incomplete markers & structural stubs MUST be rejected
        const rejectedCases = [
            ['digestStatus.status=analysis_failed', { analysis: legacyBody, digestStatus: { status: 'analysis_failed' } }],
            ['latestAnalysisAttemptError', { analysis: legacyBody, latestAnalysisAttemptError: 'timeout' }],
            ['analysisCheckpoint', { analysis: legacyBody, analysisCheckpoint: 'partial checkpoint' }],
            ['non-terminal stage transient_failure', { analysis: legacyBody, analysisManifest: { stages: { revision: { status: 'transient_failure' } } } }],
            ['non-terminal stage pending', { analysis: legacyBody, analysisManifest: { stages: { scoringAudit: { status: 'pending' } } } }],
            ['non-terminal stage invalid_output', { analysis: legacyBody, analysisManifest: { stages: { primaryAnalysis: { status: 'invalid_output' } } } }],
            ['non-terminal stage contract_rejected', { analysis: legacyBody, analysisManifest: { stages: { coreSummaryRepair: { status: 'contract_rejected' } } } }],
            ['stub < 500 chars with 2 headings', { analysis: '## Heading 1\nShort text.\n## Heading 2\nMore short text.' }],
            ['>= 500 chars with < 2 headings', { analysis: '## Only One Heading\n\n' + '详细正文内容但只有一个标题。'.repeat(60) }]
        ];
        for (const [label, record] of rejectedCases) {
            assert.strictEqual(buildArchiveRecordProof(record, '2026-04-15'), null, `should reject: ${label}`);
        }

        // 3. End-to-end compaction strips verified legacy-schema archive blobs while protecting rejected archive entries
        const fx = createCompactionFixtureWorkspace('2026-11-24');
        try {
            const pLegacyValid = makeRichHistoricalAnalyzedPaper('2604.10001', '2026-04-15', {
                analysis: legacyBody,
                apiReaderArticle: undefined,
                analysisManifest: { version: 1, stages: { primaryAnalysis: { status: 'complete' } } }
            });
            delete pLegacyValid.apiReaderArticle;
            const pStageIncomplete = makeRichHistoricalAnalyzedPaper('2604.10002', '2026-04-15', {
                analysis: legacyBody,
                apiReaderArticle: undefined,
                analysisManifest: { version: 1, stages: { revision: { status: 'transient_failure' } } }
            });
            delete pStageIncomplete.apiReaderArticle;

            fs.writeFileSync(fx.papersFile, JSON.stringify({
                generation: 1,
                lastUpdated: '2026-11-24T08:00:00+08:00',
                papers: {
                    '2604.10001': pLegacyValid,
                    '2604.10002': pStageIncomplete
                }
            }));
            fx.writeArchive('2026-04-15', [
                makeMatchingArchiveEntry(pLegacyValid),
                makeMatchingArchiveEntry(pStageIncomplete)
            ]);

            compactPapersLedger({
                write: true,
                profile: 'safe-blobs',
                retainDays: 14,
                referenceDate: '2026-11-24',
                papersFile: fx.papersFile,
                currentDir: fx.currentDir,
                archiveDir: fx.archiveDir,
                receiptDir: fx.receiptDir
            });
            const after = JSON.parse(fs.readFileSync(fx.papersFile, 'utf8'));
            assert.strictEqual(Object.prototype.hasOwnProperty.call(after.papers['2604.10001'], 'analysis'), false);
            assert.strictEqual(Object.prototype.hasOwnProperty.call(after.papers['2604.10001'], 'parsed'), false);
            assert.strictEqual(after.papers['2604.10002'].analysis, legacyBody);
            assert.ok(after.papers['2604.10002'].parsed);
        } finally {
            fs.rmSync(fx.rootDir, { recursive: true, force: true });
        }
    });

    it('[Round 3 P2] 识别并清理旧 mergePapersDatabases 泄漏的 分析未完成 尝试字段，不误锁为近期论文且严格保护真实近期尝试', () => {
        const fx = createCompactionFixtureWorkspace('2026-11-24');
        try {
            // 1. Historical verified-archived analyzed paper with leaked merge attempt metadata
            const pLeaked = makeRichHistoricalAnalyzedPaper('2605.00001', '2026-05-01', {
                latestAnalysisAttemptError: '分析未完成',
                latestAnalysisAttemptAt: '2026-11-23T12:00:00+08:00'
            });
            // 2. Real recent attempt with a non-leaked error message -> MUST remain protected!
            const pRealError = makeRichHistoricalAnalyzedPaper('2605.00002', '2026-05-01', {
                latestAnalysisAttemptError: 'real timeout error',
                latestAnalysisAttemptAt: '2026-11-23T12:00:00+08:00'
            });
            // 3. Real recent attempt with latestAttemptStatus === 'analysis_failed' -> MUST remain protected!
            const pFailedAttempt = makeRichHistoricalAnalyzedPaper('2605.00003', '2026-05-01', {
                latestAnalysisAttemptError: '分析未完成',
                latestAnalysisAttemptAt: '2026-11-23T12:00:00+08:00',
                digestStatus: {
                    status: 'analyzed',
                    batchDate: '2026-05-01',
                    updatedAt: '2026-05-01T12:00:00+08:00',
                    latestAttemptStatus: 'analysis_failed',
                    error: null
                }
            });
            // 4. Real recent attempt with non-empty digestStatus.error -> MUST remain protected!
            const pDigestError = makeRichHistoricalAnalyzedPaper('2605.00004', '2026-05-01', {
                latestAnalysisAttemptError: '分析未完成',
                latestAnalysisAttemptAt: '2026-11-23T12:00:00+08:00',
                digestStatus: {
                    status: 'analyzed',
                    batchDate: '2026-05-01',
                    updatedAt: '2026-05-01T12:00:00+08:00',
                    latestAttemptStatus: 'analyzed',
                    error: 'recorded error'
                }
            });

            assert.strictEqual(isLeakedMergeAttemptMetadata(pLeaked), true);
            assert.strictEqual(getMostRecentPaperDate(pLeaked), '2026-05-01');
            assert.strictEqual(isLeakedMergeAttemptMetadata(pRealError), false);
            assert.strictEqual(getMostRecentPaperDate(pRealError), '2026-11-23');
            assert.strictEqual(isLeakedMergeAttemptMetadata(pFailedAttempt), false);
            assert.strictEqual(getMostRecentPaperDate(pFailedAttempt), '2026-11-23');
            assert.strictEqual(isLeakedMergeAttemptMetadata(pDigestError), false);
            assert.strictEqual(getMostRecentPaperDate(pDigestError), '2026-11-23');

            fs.writeFileSync(fx.papersFile, JSON.stringify({
                generation: 1,
                lastUpdated: '2026-11-24T08:00:00+08:00',
                papers: {
                    '2605.00001': pLeaked,
                    '2605.00002': pRealError,
                    '2605.00003': pFailedAttempt,
                    '2605.00004': pDigestError
                }
            }));
            fx.writeArchive('2026-05-01', [
                makeMatchingArchiveEntry(pLeaked),
                makeMatchingArchiveEntry(pRealError),
                makeMatchingArchiveEntry(pFailedAttempt),
                makeMatchingArchiveEntry(pDigestError)
            ]);

            const report = compactPapersLedger({
                write: true,
                profile: 'ledger',
                retainDays: 14,
                referenceDate: '2026-11-24',
                papersFile: fx.papersFile,
                currentDir: fx.currentDir,
                archiveDir: fx.archiveDir,
                receiptDir: fx.receiptDir
            });

            assert.strictEqual(report.counts.protectedCount, 3);
            assert.strictEqual(report.counts.protectedBreakdown.withinRetainDays, 3);
            assert.strictEqual(report.fieldBreakdown.latestAnalysisAttemptError.count, 1);
            assert.strictEqual(report.fieldBreakdown.latestAnalysisAttemptAt.count, 1);

            const after = JSON.parse(fs.readFileSync(fx.papersFile, 'utf8'));
            // pLeaked was NOT falsely trapped in withinRetainDays: leaked attempt fields & archived blobs stripped!
            const recLeaked = after.papers['2605.00001'];
            assert.strictEqual(Object.prototype.hasOwnProperty.call(recLeaked, 'latestAnalysisAttemptError'), false);
            assert.strictEqual(Object.prototype.hasOwnProperty.call(recLeaked, 'latestAnalysisAttemptAt'), false);
            assert.strictEqual(Object.prototype.hasOwnProperty.call(recLeaked, 'analysisRecoveryImageManifest'), false);
            for (const blobField of VERIFIED_ARCHIVED_BLOB_FIELDS) {
                assert.strictEqual(Object.prototype.hasOwnProperty.call(recLeaked, blobField), false);
            }
            assert.strictEqual(Object.prototype.hasOwnProperty.call(recLeaked, 'abstract'), false);
            assert.strictEqual(recLeaked.digestStatus.status, 'analyzed');

            // All 3 real recent attempts MUST stay strictly protected!
            for (const id of ['2605.00002', '2605.00003', '2605.00004']) {
                const rec = after.papers[id];
                assert.ok(rec.latestAnalysisAttemptError, `${id} must keep latestAnalysisAttemptError`);
                assert.ok(rec.latestAnalysisAttemptAt, `${id} must keep latestAnalysisAttemptAt`);
                for (const blobField of VERIFIED_ARCHIVED_BLOB_FIELDS) {
                    assert.ok(rec[blobField], `${id} must keep ${blobField}`);
                }
                assert.ok(rec.abstract, `${id} must keep abstract`);
            }
        } finally {
            fs.rmSync(fx.rootDir, { recursive: true, force: true });
        }
    });

    it('[P1 #7 & P2 #9] O_NOFOLLOW 拒绝符号链接输入与符号链接备份祖先、备份中断清理孤儿文件、死锁恢复及 no-op 短路', () => {
        const fx = createCompactionFixtureWorkspace('2026-11-24');
        try {
            const rawBefore = fs.readFileSync(fx.papersFile);
            const shaBefore = sha256(rawBefore);

            // 1. Symlink papers.json rejected via O_NOFOLLOW
            const symPapers = path.join(fx.currentDir, 'papers-link.json');
            fs.symlinkSync(fx.papersFile, symPapers);
            assert.throws(() => compactPapersLedger({
                write: true,
                referenceDate: '2026-11-24',
                papersFile: symPapers,
                currentDir: fx.currentDir,
                archiveDir: fx.archiveDir,
                receiptDir: fx.receiptDir
            }), /非符号链接/);
            fs.unlinkSync(symPapers);

            // 2. Symlink ancestor in receiptDir rejected before mkdirSync
            const realTarget = path.join(fx.rootDir, 'real-dir');
            fs.mkdirSync(realTarget, { recursive: true });
            const symParent = path.join(fx.rootDir, 'sym-parent');
            fs.symlinkSync(realTarget, symParent);
            assert.throws(() => compactPapersLedger({
                write: true,
                referenceDate: '2026-11-24',
                papersFile: fx.papersFile,
                currentDir: fx.currentDir,
                archiveDir: fx.archiveDir,
                receiptDir: path.join(symParent, 'nested-receipts')
            }), /符号链接/);
            assert.strictEqual(fs.existsSync(path.join(realTarget, 'nested-receipts')), false);

            // 3. Mid-backup failure cleans up partial .json.gz leaving zero orphan files
            assert.throws(() => compactPapersLedger({
                write: true,
                referenceDate: '2026-11-24',
                papersFile: fx.papersFile,
                currentDir: fx.currentDir,
                archiveDir: fx.archiveDir,
                receiptDir: fx.receiptDir,
                backupHooks: {
                    beforeManifestWrite: () => { throw new Error('simulated mid-backup crash'); }
                }
            }), /simulated mid-backup crash/);
            assert.strictEqual(sha256(fs.readFileSync(fx.papersFile)), shaBefore);
            assert.deepStrictEqual(fs.readdirSync(fx.receiptDir), []);

            // 4. Dead-PID lock left by crashed writer is recovered cleanly via LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY
            const enginePath = path.join(REPO_ROOT, 'scripts', 'analysis-engine.js');
            const crashed = spawnSync(process.execPath, [
                '-e',
                'const { acquireFileLockSync } = require(process.argv[1]); acquireFileLockSync(process.argv[2]); process.kill(process.pid, "SIGKILL");',
                enginePath,
                fx.papersFile
            ], {
                env: { ...process.env, NODE_PATH: process.env.NODE_PATH || path.join(REPO_ROOT, 'node_modules') },
                encoding: 'utf8'
            });
            assert.strictEqual(crashed.signal, 'SIGKILL');
            assert.strictEqual(fs.existsSync(`${fx.papersFile}.lock`), true);

            // 5. First --write recovers dead lock & succeeds; second identical --write short-circuits as no-op!
            const first = compactPapersLedger({
                write: true,
                profile: 'ledger',
                retainDays: 14,
                referenceDate: '2026-11-24',
                papersFile: fx.papersFile,
                currentDir: fx.currentDir,
                archiveDir: fx.archiveDir,
                receiptDir: fx.receiptDir
            });
            assert.strictEqual(first.noOp, false);
            assert.strictEqual(first.after.generation, 8);
            assert.strictEqual(fs.existsSync(`${fx.papersFile}.lock`), false);
            const filesAfterFirst = fs.readdirSync(fx.receiptDir).sort();
            const shaAfterFirst = sha256(fs.readFileSync(fx.papersFile));

            const second = compactPapersLedger({
                write: true,
                profile: 'ledger',
                retainDays: 14,
                referenceDate: '2026-11-24',
                papersFile: fx.papersFile,
                currentDir: fx.currentDir,
                archiveDir: fx.archiveDir,
                receiptDir: fx.receiptDir
            });
            assert.strictEqual(second.noOp, true);
            assert.strictEqual(second.savings.bytes, 0);
            assert.strictEqual(second.savings.percent, 0);
            assert.strictEqual(second.after.generation, 8);
            assert.strictEqual(second.backup, null);
            assert.strictEqual(second.receiptPath, null);
            assert.strictEqual(sha256(fs.readFileSync(fx.papersFile)), shaAfterFirst);
            assert.deepStrictEqual(fs.readdirSync(fx.receiptDir).sort(), filesAfterFirst);
        } finally {
            fs.rmSync(fx.rootDir, { recursive: true, force: true });
        }
    });

    it('输入 papers.json 结构或校验非法时在写入和备份前中止', () => {
        const fx = createCompactionFixtureWorkspace('2026-11-24');
        try {
            const invalidPayload = JSON.stringify({
                generation: 1,
                papers: {
                    '2601.11111': {
                        arxivId: '2601.11111',
                        digestStatus: { status: 'bogus_status' }
                    }
                }
            });
            fs.writeFileSync(fx.papersFile, invalidPayload);

            assert.throws(() => compactPapersLedger({
                write: true,
                papersFile: fx.papersFile,
                currentDir: fx.currentDir,
                archiveDir: fx.archiveDir,
                receiptDir: fx.receiptDir
            }), /未通过数据文件校验/);

            assert.strictEqual(fs.readFileSync(fx.papersFile, 'utf8'), invalidPayload);
            assert.strictEqual(fs.existsSync(fx.receiptDir), false);
        } finally {
            fs.rmSync(fx.rootDir, { recursive: true, force: true });
        }
    });

    it('[P0 #1 & P1 #8] CLI 强制校验 daily 角色与沙箱外运行，且 --dry-run --json 零日志文件输出纯净 JSON', () => {
        assert.strictEqual(requiredWorkspaceRoleForCommand('compact-papers-ledger.js'), 'daily');
        assert.strictEqual(requiredWorkspaceRoleForCommand('scripts/compact-papers-ledger.js'), 'daily');

        const fx = createCompactionFixtureWorkspace('2026-11-24');
        const wsNoMarker = createIsolatedDailyCliWorkspace(null);
        const wsHistory = createIsolatedDailyCliWorkspace('history');
        const wsDaily = createIsolatedDailyCliWorkspace('daily');
        try {
            const strictEnv = buildStrictCleanSubprocessEnv({
                NODE_PATH: process.env.NODE_PATH || path.join(REPO_ROOT, 'node_modules')
            });

            // 1. CODEX_SANDBOX rejected immediately with zero writes & zero logs
            const sandboxed = spawnSync(process.execPath, [
                wsDaily.cliPath,
                '--write',
                '--papers-file', fx.papersFile,
                '--current-dir', fx.currentDir,
                '--archive-dir', fx.archiveDir,
                '--receipt-dir', fx.receiptDir
            ], {
                cwd: wsDaily.workspaceRoot,
                env: { ...strictEnv, CODEX_SANDBOX: 'seatbelt-test' },
                encoding: 'utf8'
            });
            assert.notStrictEqual(sandboxed.status, 0);
            assert.match(`${sandboxed.stdout}${sandboxed.stderr}`, /必须在沙箱外运行/);
            assert.strictEqual(fs.existsSync(fx.receiptDir), false);

            // 2. Missing workspace role marker rejected
            const noMarker = spawnSync(process.execPath, [
                wsNoMarker.cliPath,
                '--dry-run',
                '--papers-file', fx.papersFile
            ], {
                cwd: wsNoMarker.workspaceRoot,
                env: strictEnv,
                encoding: 'utf8'
            });
            assert.notStrictEqual(noMarker.status, 0);
            assert.match(`${noMarker.stdout}${noMarker.stderr}`, /工作区角色标记缺失/);

            // 3. history workspace role rejected
            const wrongRole = spawnSync(process.execPath, [
                wsHistory.cliPath,
                '--dry-run',
                '--papers-file', fx.papersFile
            ], {
                cwd: wsHistory.workspaceRoot,
                env: strictEnv,
                encoding: 'utf8'
            });
            assert.notStrictEqual(wrongRole.status, 0);
            assert.match(`${wrongRole.stdout}${wrongRole.stderr}`, /只允许 role=daily/);

            // 4. daily workspace --dry-run --json with ALL log-disable env vars removed:
            //    MUST output pure parseable JSON and create ZERO files in logs/!
            const rawBefore = fs.readFileSync(fx.papersFile);
            const dryOut = execFileSync(process.execPath, [
                wsDaily.cliPath,
                '--dry-run',
                '--json',
                '--profile', 'ledger',
                '--retain-days', '14',
                '--papers-file', fx.papersFile,
                '--current-dir', fx.currentDir,
                '--archive-dir', fx.archiveDir,
                '--receipt-dir', fx.receiptDir
            ], {
                cwd: wsDaily.workspaceRoot,
                env: strictEnv,
                encoding: 'utf8'
            });
            const dryReport = JSON.parse(dryOut);
            assert.strictEqual(dryReport.mode, 'dry-run');
            assert.ok(dryReport.savings.bytes > 0);
            assert.strictEqual(sha256(fs.readFileSync(fx.papersFile)), sha256(rawBefore));
            assert.strictEqual(fs.existsSync(fx.receiptDir), false);
            assert.strictEqual(fs.existsSync(path.join(wsDaily.workspaceRoot, 'logs')), false, 'dry-run MUST NOT create logs/');

            // 5. daily workspace --write --json succeeds with zero logs/ created
            const writeOut = execFileSync(process.execPath, [
                wsDaily.cliPath,
                '--write',
                '--json',
                '--profile', 'ledger',
                '--retain-days', '14',
                '--papers-file', fx.papersFile,
                '--current-dir', fx.currentDir,
                '--archive-dir', fx.archiveDir,
                '--receipt-dir', fx.receiptDir
            ], {
                cwd: wsDaily.workspaceRoot,
                env: strictEnv,
                encoding: 'utf8'
            });
            const writeReport = JSON.parse(writeOut);
            assert.strictEqual(writeReport.mode, 'write');
            assert.strictEqual(writeReport.noOp, false);
            assert.strictEqual(writeReport.after.generation, 8);
            assert.strictEqual(writeReport.after.paperCount, writeReport.before.paperCount);
            assert.ok(fs.existsSync(writeReport.backup.backupPath));
            assert.ok(fs.existsSync(writeReport.receiptPath));
            assert.strictEqual(fs.existsSync(path.join(wsDaily.workspaceRoot, 'logs')), false);
        } finally {
            fs.rmSync(fx.rootDir, { recursive: true, force: true });
            fs.rmSync(wsNoMarker.workspaceRoot, { recursive: true, force: true });
            fs.rmSync(wsHistory.workspaceRoot, { recursive: true, force: true });
            fs.rmSync(wsDaily.workspaceRoot, { recursive: true, force: true });
        }
    });
});
