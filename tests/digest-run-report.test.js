const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const {
    parseDate,
    sourceHealthComplete,
    samePaperIds,
    visualAssetsAreValid,
    postPublishVisualWaiverIsValid,
    llmApiPaperComplete,
    buildDigestRunReport,
    formatDigestRunSummary,
    analysisFailureMessage
} = require('../scripts/digest-run-report.js');
const Config = require('../scripts/config.js');
const { autoArchiveCurrentData } = require('../scripts/full-fetch.js');
const { validAnalysisPaper } = require('./valid-analysis-fixture.js');
const {
    cardTaskToken,
    visualSummaryAssetPath
} = require('../scripts/visual-summary-state.js');

function crc32(buffer) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let value = n;
        for (let k = 0; k < 8; k += 1) {
            value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        }
        table[n] = value >>> 0;
    }
    let value = 0xffffffff;
    for (const byte of buffer) value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(kind, payload) {
    const type = Buffer.from(kind, 'ascii');
    const chunk = Buffer.alloc(12 + payload.length);
    chunk.writeUInt32BE(payload.length, 0);
    type.copy(chunk, 4);
    payload.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(Buffer.concat([type, payload])), 8 + payload.length);
    return chunk;
}

function makePng() {
    const width = 768;
    const height = 1200;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.set([8, 0, 0, 0, 0], 8);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(Buffer.alloc((width + 1) * height))),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

function healthySourceHealth() {
    return {
        arxiv: {
            ok: true,
            categories: Config.ARXIV_CATEGORIES.map(item => ({ id: item.id, ok: true }))
        },
        huggingface: { ok: true }
    };
}

function withDigestPaths(root, callback) {
    const originals = {
        currentDir: Config.CURRENT_DIR,
        rawCandidates: Config.FILES.rawCandidates,
        filterDecisions: Config.FILES.filterDecisions,
        filteredPapers: Config.FILES.filteredPapers,
        deepAnalysisResult: Config.FILES.deepAnalysisResult,
        analyzed: Config.FILES.analyzed,
        visualSummaryManifestDir: Config.FILES.visualSummaryManifestDir,
        digestCoverManifestDir: Config.FILES.digestCoverManifestDir
    };
    const current = path.join(root, 'current');
    fs.mkdirSync(current, { recursive: true });
    Config.CURRENT_DIR = current;
    Config.FILES.rawCandidates = path.join(current, 'raw-candidates.json');
    Config.FILES.filterDecisions = path.join(current, 'filter-decisions.json');
    Config.FILES.filteredPapers = path.join(current, 'filtered-papers.json');
    Config.FILES.deepAnalysisResult = path.join(current, 'deep-analysis-result.json');
    Config.FILES.analyzed = path.join(current, 'analyzed.json');
    Config.FILES.visualSummaryManifestDir = path.join(current, 'visual-summary-manifests');
    Config.FILES.digestCoverManifestDir = path.join(current, 'digest-cover-manifests');
    try {
        return callback({ current, archive: path.join(root, 'archive') });
    } finally {
        Config.CURRENT_DIR = originals.currentDir;
        for (const [key, value] of Object.entries(originals)) {
            if (key !== 'currentDir') Config.FILES[key] = value;
        }
    }
}

describe('日更运行报告', () => {
    it('只接受与当前发布和精确清单绑定的用户视觉豁免', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-waiver-'));
        const visualPath = path.join(dir, 'visual.json');
        const coverPath = path.join(dir, 'cover.json');
        fs.writeFileSync(visualPath, '{"visual":1}');
        fs.writeFileSync(coverPath, '{"cover":1}');
        const digest = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
        const publication = {
            publicationCommit: 'a'.repeat(40), remoteVerifiedOid: 'a'.repeat(40),
            generationManifestSha256: 'b'.repeat(64),
        };
        const waiver = {
            version: 1, batchDate: '2026-08-26', status: 'waived', requestedBy: 'user',
            reason: '用户明确取消本批次发布后视觉资产生成。',
            publicationCommit: publication.publicationCommit,
            remoteVerifiedOid: publication.remoteVerifiedOid,
            generationManifestSha256: publication.generationManifestSha256,
            visualManifestSha256: digest(visualPath), coverManifestSha256: digest(coverPath)
        };
        try {
            assert.equal(postPublishVisualWaiverIsValid(
                waiver, '2026-08-26', publication, visualPath, coverPath
            ), true);
            fs.appendFileSync(visualPath, 'drift');
            assert.equal(postPublishVisualWaiverIsValid(
                waiver, '2026-08-26', publication, visualPath, coverPath
            ), false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('严格解析批次日期', () => {
        assert.strictEqual(parseDate(['--date', '2026-07-29']), '2026-07-29');
        assert.throws(() => parseDate(['--date', '2026-02-30']), /日期非法/);
        assert.throws(() => parseDate([]), /用法/);
    });

    it('筛选未跑完时 pending 报未决篇数，不报可重试项数', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-pending-'));
        try {
            withDigestPaths(dir, () => {
                // 255 篇候选，只有 247 篇拿到决定，剩下 8 篇在写决定之前运行就被杀了。
                // 这 8 篇不属于「可重试」，所以 retryable 是 0。
                const papers = Array.from({ length: 255 }, (_, i) => ({ arxivId: `2607.${i + 1}` }));
                fs.writeFileSync(Config.FILES.rawCandidates, JSON.stringify({
                    batchDate: '2026-07-29',
                    papers,
                    stats: { afterBlogSkip: papers.length }
                }));
                fs.writeFileSync(Config.FILES.filterDecisions, JSON.stringify({
                    batchDate: '2026-07-29',
                    decisions: Object.fromEntries(papers.slice(0, 247).map(paper => [
                        paper.arxivId, { id: paper.arxivId, related: false }
                    ])),
                    stats: { totalCandidates: 255, decided: 247, retryable: 0, related: 0 }
                }));
                fs.writeFileSync(Config.FILES.filteredPapers, JSON.stringify({
                    batchDate: '2026-07-29',
                    status: 'filtering',
                    papers: [],
                    stats: { afterBlogSkip: 255, afterFilter: 0, decisionCount: 247 }
                }));

                const report = buildDigestRunReport('2026-07-29', { today: '2026-07-29' });
                assert.strictEqual(report.filter.complete, false);
                assert.strictEqual(report.filter.pendingDecisions, 8);
                assert.strictEqual(report.filter.retryableDecisions, 0);
                assert.match(formatDigestRunSummary(report), /pending=8/);
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('抓取健康必须覆盖配置中的全部来源', () => {
        const raw = {
            batchDate: '2026-07-29',
            papers: [{ arxivId: '2607.1' }],
            sourceHealth: {
                arxiv: {
                    ok: true,
                    categories: Config.ARXIV_CATEGORIES.map(item => ({ id: item.id, ok: true }))
                },
                huggingface: { ok: true }
            }
        };
        assert.strictEqual(sourceHealthComplete(raw, '2026-07-29'), true);
        raw.sourceHealth.arxiv.categories.pop();
        assert.strictEqual(sourceHealthComplete(raw, '2026-07-29'), false);
        raw.sourceHealth.arxiv.categories = Config.ARXIV_CATEGORIES.map(() => ({ id: 'eess.AS', ok: true }));
        assert.strictEqual(sourceHealthComplete(raw, '2026-07-29'), false);
    });

    it('分析集合必须按规范化论文 ID 精确覆盖筛选集合', () => {
        assert.strictEqual(
            samePaperIds([{ arxivId: '2607.1v2' }], [{ arxivId: '2607.1' }]),
            true
        );
        assert.strictEqual(
            samePaperIds([{ arxivId: '2607.1' }], [{ arxivId: '2607.2' }]),
            false
        );
        assert.strictEqual(
            samePaperIds([{ arxivId: '2607.1' }, { arxivId: '2607.1v2' }], [{ arxivId: '2607.1' }]),
            false
        );
    });

    it('LLM API canonical 必须与 reader、评分、来源和实际正文哈希保持一致', () => {
        const stable = value => {
            if (Array.isArray(value)) return value.map(stable);
            if (value && typeof value === 'object') {
                return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
            }
            return value;
        };
        const hashText = value => crypto.createHash('sha256').update(String(value)).digest('hex');
        const hashStable = value => crypto.createHash('sha256')
            .update(JSON.stringify(stable(value))).digest('hex');
        const paper = validAnalysisPaper('2607.00001');
        paper.analysis = '完整的 API 深度分析正文';
        paper.apiReaderArticle = '### 面向初学者的论文解释\n\n正文';
        paper.apiReaderPlan = {
            version: 3,
            contract: 'beginner-researcher-v3',
            figurePlacements: [],
            tableBindings: [],
            formulaBindings: [],
            sourceBindingsContract: 'api-reader-source-bindings-v4'
        };
        paper.apiReaderPlan.sourceBindingsSha256 = hashStable({
            tableBindings: paper.apiReaderPlan.tableBindings,
            formulaBindings: paper.apiReaderPlan.formulaBindings
        });
        paper.apiReaderFigures = [];
        paper.sourceSha256 = '1'.repeat(64);
        const authorIdentity = {
            contract: 'api-reader-author-identity-v1',
            sourceDomSha256: '', sourceTextSha256: paper.sourceSha256,
            metadataSha256: hashStable(paper.authors || []),
            authors: [{
                name: 'Author', affiliations: ['机构信息未在 arXiv HTML 中可靠披露'],
                nameBinding: {
                    sourceKind: 'paper_metadata', sourceValue: 'Author',
                    metadataSha256: hashStable(paper.authors || [])
                },
                affiliationBindings: [{
                    sourceKind: 'explicit_unavailable',
                    sourceValue: '机构信息未在 arXiv HTML 中可靠披露',
                    sourceTextSha256: paper.sourceSha256
                }]
            }]
        };
        paper.apiReaderAuthors = {
            authors: [{ name: 'Author', affiliations: ['机构信息未在 arXiv HTML 中可靠披露'] }],
            sourceDomSha256: paper.sourceSha256,
            identity: authorIdentity,
            identitySha256: hashStable(authorIdentity)
        };
        const resourceIdentity = {
            contract: 'api-reader-resource-identity-v1',
            sourceTextSha256: paper.sourceSha256,
            resources: []
        };
        paper.apiReaderResources = {
            ...resourceIdentity,
            identitySha256: hashStable(resourceIdentity)
        };
        paper.apiReaderArticleSha256 = hashText(paper.apiReaderArticle);
        paper.apiReaderPlanSha256 = hashStable(paper.apiReaderPlan);
        paper.parsed = { ...(paper.parsed || {}), score: 7.5 };
        paper.analysisManifest = {
            contracts: {
                apiReaderArticle: 'beginner-researcher-v3',
                apiReaderSourceBindings: 'api-reader-source-bindings-v4',
                apiReaderAuthorIdentity: 'api-reader-author-identity-v1',
                apiReaderResourceIdentity: 'api-reader-resource-identity-v1'
            },
            sourceAcquisition: {
                fullTextAvailable: true,
                sourceSha256: paper.sourceSha256,
                structuredArtifactsSha256: '4'.repeat(64)
            },
            stages: {
                scoringAudit: {
                    status: 'complete', scoringContract: 'api-scoring-audit-v2',
                    auditSha256: '2'.repeat(64), evidenceSha256: '3'.repeat(64),
                    outputAnalysisSha256: hashText(paper.analysis), finalScore: 7.5
                },
                openSourceScan: {
                    status: 'complete',
                    resourceEvidenceContract: 'api-reader-resource-identity-v1',
                    resourceEvidenceSha256: paper.apiReaderResources.identitySha256
                },
                apiReaderArticle: {
                    status: 'complete', model: 'muse-spark-1.2-contributor',
                    protocol: 'openai_responses', articleSha256: paper.apiReaderArticleSha256,
                    planSha256: paper.apiReaderPlanSha256,
                    figureCount: 0,
                    figuresSha256: hashStable(paper.apiReaderFigures),
                    readerAuthorsSha256: hashStable(paper.apiReaderAuthors),
                    readerAuthorIdentityContractVersion: 'api-reader-author-identity-v1',
                    readerAuthorIdentitySha256: paper.apiReaderAuthors.identitySha256,
                    resourceIdentityContractVersion: 'api-reader-resource-identity-v1',
                    resourceIdentitySha256: paper.apiReaderResources.identitySha256,
                    resourceCount: 0,
                    parserVersion: 'api-reader-parser-v3',
                    assemblerVersion: 'api-reader-assembler-v3',
                    tableContractVersion: 'api-reader-tables-v3',
                    figureContractVersion: 'api-reader-figures-v3',
                    qualityMetricsContractVersion: 'api-reader-quality-metrics-v2',
                    qualityMetrics: {
                        contract: 'api-reader-quality-metrics-v2',
                        rawIssueCount: 0,
                        waivedIssueCount: 0,
                        blockingIssueCount: 0,
                        warningCount: 0
                    },
                    sourceBindingsContractVersion: 'api-reader-source-bindings-v4',
                    sourceBindingsSha256: paper.apiReaderPlan.sourceBindingsSha256,
                    sourceBindingsSourceTextSha256: paper.sourceSha256,
                    tableBindingCount: 0,
                    formulaBindingCount: 0,
                    structuredArtifactsSha256: '4'.repeat(64)
                }
            }
        };
        assert.strictEqual(llmApiPaperComplete(paper), true);
        const scoringOutputSha256 = paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256;
        paper.analysis += '\n\n![受控插图](https://arxiv.org/html/2607.00001/figure.png)';
        paper.analysisManifest.stages.imageSupplement = {
            status: 'complete',
            inputAnalysisSha256: scoringOutputSha256,
            outputAnalysisSha256: hashText(paper.analysis)
        };
        assert.strictEqual(llmApiPaperComplete(paper), true);
        paper.analysisManifest.stages.imageSupplement.outputAnalysisSha256 = '0'.repeat(64);
        assert.strictEqual(llmApiPaperComplete(paper), false);
        paper.analysisManifest.stages.imageSupplement.outputAnalysisSha256 = hashText(paper.analysis);
        paper.apiReaderArticle += '漂移';
        assert.strictEqual(llmApiPaperComplete(paper), false);
    });

    it('默认自动归档完整保存历史 fetch/filter/analysis companion 并可恢复报告', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-report-history-'));
        try {
            withDigestPaths(dir, ({ current, archive }) => {
                const targetDate = '2026-07-29';
                const newerDate = '2026-07-30';
                const paper = { arxivId: '2607.00001', fetchBatchDate: targetDate };
                const rejected = { arxivId: '2607.00002', fetchBatchDate: targetDate };
                fs.writeFileSync(Config.FILES.rawCandidates, JSON.stringify({
                    timestamp: `${targetDate}T08:00:00+08:00`,
                    batchDate: targetDate,
                    sourceHealth: healthySourceHealth(),
                    stats: { afterBlogSkip: 2 },
                    papers: [paper, rejected]
                }));
                fs.writeFileSync(Config.FILES.filterDecisions, JSON.stringify({
                    timestamp: `${targetDate}T08:00:00+08:00`,
                    batchDate: targetDate,
                    stats: {
                        complete: true,
                        totalCandidates: 2,
                        decided: 2,
                        related: 1,
                        retryable: 0,
                        keywordRejected: 1,
                        llmCandidates: 1
                    },
                    decisions: {
                        '2607.00001': { related: true },
                        '2607.00002': { related: false }
                    }
                }));
                fs.writeFileSync(Config.FILES.filteredPapers, JSON.stringify({
                    timestamp: `${targetDate}T08:00:00+08:00`,
                    batchDate: targetDate,
                    status: 'complete',
                    sourceHealth: healthySourceHealth(),
                    stats: {
                        batchDate: targetDate,
                        afterBlogSkip: 2,
                        decisionCount: 2,
                        afterFilter: 1,
                        afterArchiveSkip: 1,
                        skippedFromArchive: 0,
                        keywordRejected: 1,
                        llmCandidates: 1
                    },
                    papers: [paper]
                }));
                fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify({
                    timestamp: `${targetDate}T08:00:00+08:00`,
                    batchDate: targetDate,
                    papers: [validAnalysisPaper('2607.00001', { fetchBatchDate: targetDate })]
                }));

                autoArchiveCurrentData(newerDate, { archiveDir: archive });

                const archived = path.join(archive, targetDate);
                for (const name of [
                    'raw-candidates.json', 'filter-decisions.json',
                    'filtered-papers.json', 'deep-analysis-result.json'
                ]) {
                    assert.strictEqual(fs.existsSync(path.join(current, name)), false);
                    assert.strictEqual(fs.existsSync(path.join(archived, name)), true);
                }

                const report = buildDigestRunReport(targetDate, {
                    today: newerDate,
                    archiveDir: archive
                });
                assert.deepStrictEqual(report.dataSources, {
                    rawCandidates: 'archive',
                    filteredPapers: 'archive',
                    filterDecisions: 'archive',
                    deepAnalysisResult: 'archive'
                });
                assert.strictEqual(report.fetch.complete, true);
                assert.strictEqual(report.fetch.rawCandidateCount, 2);
                assert.strictEqual(report.filter.complete, true);
                assert.strictEqual(report.filter.selectedCount, 1);
                assert.strictEqual(report.analysis.complete, false);
                assert.strictEqual(report.analysis.publicationMode, 'invalid_or_legacy');
                assert.strictEqual(report.analysis.successful, 1);
                assert.strictEqual(report.analysis.total, 1);
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('当前日期缺失或错批次时不得用同日 archive 掩盖 current 故障', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-report-current-'));
        try {
            withDigestPaths(dir, ({ archive }) => {
                const targetDate = '2026-07-29';
                const archived = path.join(archive, targetDate);
                fs.mkdirSync(archived, { recursive: true });
                fs.writeFileSync(path.join(archived, 'raw-candidates.json'), JSON.stringify({
                    batchDate: targetDate,
                    sourceHealth: healthySourceHealth(),
                    papers: [{ arxivId: '2607.00001', fetchBatchDate: targetDate }]
                }));
                fs.writeFileSync(path.join(archived, 'filtered-papers.json'), JSON.stringify({
                    batchDate: targetDate,
                    status: 'complete',
                    papers: [{ arxivId: '2607.00001', fetchBatchDate: targetDate }]
                }));
                fs.writeFileSync(path.join(archived, 'filter-decisions.json'), JSON.stringify({
                    batchDate: targetDate,
                    stats: { complete: true, totalCandidates: 1, decided: 1, retryable: 0 }
                }));
                fs.writeFileSync(path.join(archived, 'deep-analysis-result.json'), JSON.stringify({
                    papers: [{ arxivId: '2607.00001', fetchBatchDate: targetDate }]
                }));

                const report = buildDigestRunReport(targetDate, {
                    today: targetDate,
                    archiveDir: archive
                });
                assert.deepStrictEqual(report.dataSources, {
                    rawCandidates: 'missing',
                    filteredPapers: 'missing',
                    filterDecisions: 'missing',
                    deepAnalysisResult: 'missing'
                });
                assert.strictEqual(report.fetch.complete, false);
                assert.strictEqual(report.filter.complete, false);
                assert.strictEqual(report.analysis.total, 0);
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('历史 archive 中存在但损坏的决定快照不得被 filtered 契约静默替代', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-report-corrupt-'));
        try {
            withDigestPaths(dir, ({ archive }) => {
                const targetDate = '2026-07-29';
                const archived = path.join(archive, targetDate);
                fs.mkdirSync(archived, { recursive: true });
                fs.writeFileSync(path.join(archived, 'filter-decisions.json'), '{broken');
                fs.writeFileSync(path.join(archived, 'filtered-papers.json'), JSON.stringify({
                    batchDate: targetDate,
                    status: 'complete',
                    sourceHealth: healthySourceHealth(),
                    stats: { afterBlogSkip: 1, decisionCount: 1 },
                    papers: [{ arxivId: '2607.00001', fetchBatchDate: targetDate }]
                }));
                fs.writeFileSync(path.join(archived, 'deep-analysis-result.json'), JSON.stringify({
                    papers: [{ arxivId: '2607.00001', fetchBatchDate: targetDate }]
                }));

                const report = buildDigestRunReport(targetDate, {
                    today: '2026-07-30', archiveDir: archive
                });
                assert.strictEqual(report.dataSources.filterDecisions, 'invalid');
                assert.strictEqual(report.filter.complete, false);
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('旧归档缺少 raw/decisions companion 时保持 fail-closed', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-report-missing-companion-'));
        try {
            withDigestPaths(dir, ({ archive }) => {
                const targetDate = '2026-07-29';
                const archived = path.join(archive, targetDate);
                const paper = { arxivId: '2607.00001', fetchBatchDate: targetDate };
                fs.mkdirSync(archived, { recursive: true });
                fs.writeFileSync(path.join(archived, 'filtered-papers.json'), JSON.stringify({
                    batchDate: targetDate,
                    status: 'complete',
                    stats: {
                        afterBlogSkip: 1,
                        decisionCount: 1,
                        afterFilter: 1,
                        afterArchiveSkip: 1,
                        skippedFromArchive: 0
                    },
                    papers: [paper]
                }));
                fs.writeFileSync(path.join(archived, 'deep-analysis-result.json'), JSON.stringify({
                    batchDate: targetDate,
                    papers: [validAnalysisPaper('2607.00001', { fetchBatchDate: targetDate })]
                }));

                const report = buildDigestRunReport(targetDate, {
                    today: '2026-07-30', archiveDir: archive
                });
                assert.strictEqual(report.dataSources.rawCandidates, 'missing');
                assert.strictEqual(report.dataSources.filterDecisions, 'missing');
                assert.strictEqual(report.dataSources.filteredPapers, 'archive');
                assert.strictEqual(report.dataSources.deepAnalysisResult, 'archive');
                assert.strictEqual(report.fetch.complete, false);
                assert.strictEqual(report.filter.complete, false);
                assert.strictEqual(report.analysis.complete, false);
                assert.strictEqual(report.analysis.publicationMode, 'invalid_or_legacy');
                assert.strictEqual(report.overallStatus, 'incomplete');
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('历史 archive 的 decisions 未完整覆盖 raw 时筛选门禁保持 incomplete', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-report-coverage-'));
        try {
            withDigestPaths(dir, ({ archive }) => {
                const targetDate = '2026-07-29';
                const archived = path.join(archive, targetDate);
                fs.mkdirSync(archived, { recursive: true });
                const selected = { arxivId: '2607.00001', fetchBatchDate: targetDate };
                const missing = { arxivId: '2607.00002', fetchBatchDate: targetDate };
                fs.writeFileSync(path.join(archived, 'raw-candidates.json'), JSON.stringify({
                    batchDate: targetDate,
                    sourceHealth: healthySourceHealth(),
                    stats: { afterBlogSkip: 2 },
                    papers: [selected, missing]
                }));
                fs.writeFileSync(path.join(archived, 'filter-decisions.json'), JSON.stringify({
                    batchDate: targetDate,
                    stats: {
                        complete: true, totalCandidates: 2, decided: 2,
                        related: 1, retryable: 0
                    },
                    decisions: { '2607.00001': { related: true } }
                }));
                fs.writeFileSync(path.join(archived, 'filtered-papers.json'), JSON.stringify({
                    batchDate: targetDate,
                    status: 'complete',
                    stats: {
                        afterBlogSkip: 2, decisionCount: 2, afterFilter: 1,
                        afterArchiveSkip: 1, skippedFromArchive: 0
                    },
                    papers: [selected]
                }));
                fs.writeFileSync(path.join(archived, 'deep-analysis-result.json'), JSON.stringify({
                    papers: [selected]
                }));

                const report = buildDigestRunReport(targetDate, {
                    today: '2026-07-30', archiveDir: archive
                });
                assert.strictEqual(report.fetch.complete, true);
                assert.strictEqual(report.filter.complete, false);
                assert.strictEqual(report.overallStatus, 'incomplete');
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('历史 archive 的 filtered 集合不等于 related 决定时筛选门禁保持 incomplete', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-report-filter-set-'));
        try {
            withDigestPaths(dir, ({ archive }) => {
                const targetDate = '2026-07-29';
                const archived = path.join(archive, targetDate);
                fs.mkdirSync(archived, { recursive: true });
                const related = { arxivId: '2607.00001', fetchBatchDate: targetDate };
                const unrelated = { arxivId: '2607.00002', fetchBatchDate: targetDate };
                fs.writeFileSync(path.join(archived, 'raw-candidates.json'), JSON.stringify({
                    batchDate: targetDate,
                    sourceHealth: healthySourceHealth(),
                    stats: { afterBlogSkip: 2 },
                    papers: [related, unrelated]
                }));
                fs.writeFileSync(path.join(archived, 'filter-decisions.json'), JSON.stringify({
                    batchDate: targetDate,
                    stats: {
                        complete: true, totalCandidates: 2, decided: 2,
                        related: 1, retryable: 0
                    },
                    decisions: {
                        '2607.00001': { related: true },
                        '2607.00002': { related: false }
                    }
                }));
                fs.writeFileSync(path.join(archived, 'filtered-papers.json'), JSON.stringify({
                    batchDate: targetDate,
                    status: 'complete',
                    stats: {
                        afterBlogSkip: 2, decisionCount: 2, afterFilter: 1,
                        afterArchiveSkip: 1, skippedFromArchive: 0
                    },
                    papers: [unrelated]
                }));
                fs.writeFileSync(path.join(archived, 'deep-analysis-result.json'), JSON.stringify({
                    papers: [unrelated]
                }));

                const report = buildDigestRunReport(targetDate, {
                    today: '2026-07-30', archiveDir: archive
                });
                assert.strictEqual(report.filter.complete, false);
                assert.strictEqual(report.overallStatus, 'incomplete');
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('历史 archive 的 filtered 或 deep 混批时不得静默过滤错误论文', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-report-mixed-'));
        try {
            withDigestPaths(dir, ({ archive }) => {
                const targetDate = '2026-07-29';
                const otherDate = '2026-07-28';
                const archived = path.join(archive, targetDate);
                fs.mkdirSync(archived, { recursive: true });
                const target = { arxivId: '2607.00001', fetchBatchDate: targetDate };
                const mixed = { arxivId: '2607.99999', fetchBatchDate: otherDate };
                fs.writeFileSync(path.join(archived, 'raw-candidates.json'), JSON.stringify({
                    batchDate: targetDate,
                    sourceHealth: healthySourceHealth(),
                    stats: { afterBlogSkip: 1 },
                    papers: [target]
                }));
                fs.writeFileSync(path.join(archived, 'filter-decisions.json'), JSON.stringify({
                    batchDate: targetDate,
                    stats: {
                        complete: true, totalCandidates: 1, decided: 1,
                        related: 1, retryable: 0
                    },
                    decisions: { '2607.00001': { related: true } }
                }));
                fs.writeFileSync(path.join(archived, 'filtered-papers.json'), JSON.stringify({
                    batchDate: targetDate,
                    status: 'complete',
                    stats: {
                        afterBlogSkip: 1, decisionCount: 1, afterFilter: 1,
                        afterArchiveSkip: 2, skippedFromArchive: 0
                    },
                    papers: [target, mixed]
                }));
                fs.writeFileSync(path.join(archived, 'deep-analysis-result.json'), JSON.stringify({
                    papers: [target, mixed]
                }));

                const report = buildDigestRunReport(targetDate, {
                    today: '2026-07-30', archiveDir: archive
                });
                assert.strictEqual(report.dataSources.filteredPapers, 'invalid');
                assert.strictEqual(report.dataSources.deepAnalysisResult, 'invalid');
                assert.strictEqual(report.filter.complete, false);
                assert.strictEqual(report.analysis.complete, false);
                assert.strictEqual(report.analysis.total, 0);
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('默认终端摘要保留门禁数字但不展开来源健康大对象', () => {
        const summary = formatDigestRunSummary({
            batchDate: '2026-07-29',
            overallStatus: 'incomplete',
            errors: ['长图未完成'],
            fetch: { complete: true, rawCandidateCount: 42, sourceHealth: { huge: true } },
            filter: { complete: true, selectedCount: 6, totalCandidates: 42, pendingDecisions: 0 },
            analysis: { complete: true, successful: 6, total: 6, failed: 0 },
            blog: { complete: true, strictReview: true, publicationVerified: true },
            visuals: { gateComplete: false, complete: 8, total: 10, pending: 2, failed: 0 },
            cover: { complete: true, status: 'complete' }
        });
        assert.match(summary, /candidates=42/);
        assert.match(summary, /complete=8\/10/);
        assert.match(summary, /错误: 长图未完成/);
        assert.doesNotMatch(summary, /sourceHealth|huge/);
    });

    it('长图计数满额但资产门禁失败时终端不得误报 complete', () => {
        const summary = formatDigestRunSummary({
            batchDate: '2026-07-29',
            overallStatus: 'incomplete',
            errors: ['TOP 10 论文长图状态或资产校验未完成'],
            fetch: { complete: true, rawCandidateCount: 10 },
            filter: { complete: true, selectedCount: 10, totalCandidates: 10, pendingDecisions: 0 },
            analysis: { complete: true, successful: 10, total: 10, failed: 0 },
            blog: { complete: true, strictReview: true, publicationVerified: true },
            visuals: {
                gateComplete: false,
                status: 'complete',
                complete: 10,
                total: 10,
                pending: 0,
                failed: 0,
                assetsValid: false,
                archiveUnique: true
            },
            cover: { complete: true, status: 'complete' }
        });
        // 门禁不过就不得印 status=complete。改前这里打的是
        // `长图 incomplete | status=complete | complete=10/10 | pending=0 | failed=0`，
        // 同一行自相矛盾。
        assert.match(summary, /长图 incomplete \| status=incomplete \| complete=10\/10/);
        assert.doesNotMatch(summary, /长图 incomplete \| status=complete/);
        assert.doesNotMatch(summary, /长图 complete \|/);
    });

    it('长图清单不存在时摘要报 ? 与 status，不把未知显示成 0', () => {
        const summary = formatDigestRunSummary({
            batchDate: '2026-07-29',
            overallStatus: 'incomplete',
            errors: ['TOP 10 论文长图状态或资产校验未完成'],
            fetch: { complete: true, rawCandidateCount: 10 },
            filter: { complete: true, selectedCount: 10, totalCandidates: 10, pendingDecisions: 0 },
            analysis: { complete: true, successful: 10, total: 10, failed: 0 },
            blog: { complete: true, strictReview: true, publicationVerified: true },
            visuals: {
                gateComplete: false,
                status: 'missing',
                complete: null,
                total: null,
                pending: null,
                failed: null,
                assetsValid: false,
                archiveUnique: false
            },
            cover: { complete: false, status: 'incomplete' }
        });
        // 关键：不能出现 complete=0/0 | pending=0 | failed=0 —— 那看着像已经全做完。
        const visualLine = summary.split('\n').find(line => line.includes('长图'));
        assert.match(visualLine, /长图 incomplete \| status=missing \| complete=\?\/\? \| pending=\? \| failed=\?/);
        assert.doesNotMatch(visualLine, /complete=0\/0/);
        assert.doesNotMatch(visualLine, /pending=0/);
        assert.doesNotMatch(visualLine, /failed=0/);
    });

    it('封面门禁不过时摘要不得显示 status=complete', () => {
        const summary = formatDigestRunSummary({
            batchDate: '2026-07-29',
            overallStatus: 'incomplete',
            errors: ['汇总封面状态或资产校验未完成'],
            fetch: { complete: true, rawCandidateCount: 10 },
            filter: { complete: true, selectedCount: 10, totalCandidates: 10, pendingDecisions: 0 },
            analysis: { complete: true, successful: 10, total: 10, failed: 0 },
            blog: { complete: true, strictReview: true, publicationVerified: true },
            visuals: {
                gateComplete: true, status: 'complete', complete: 10, total: 10,
                pending: 0, failed: 0, assetsValid: true, archiveUnique: true
            },
            cover: { complete: false, status: 'complete' }
        });
        assert.match(summary, /封面 incomplete \| status=incomplete/);
        assert.doesNotMatch(summary, /封面 incomplete \| status=complete/);
    });

    it('没有长图清单时 build 出来的计数是 null，不是 0', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-report-novisual-'));
        try {
            withDigestPaths(dir, () => {
                const date = '2026-07-29';
                // 什么清单都不放：visualSummaryManifestDir 是空的。
                const report = buildDigestRunReport(date, { today: date });
                // 必须是 null 而不是 0——0 是「清单在、一张都没做」，与「清单不存在」不同。
                assert.strictEqual(report.visuals.complete, null);
                assert.strictEqual(report.visuals.total, null);
                assert.strictEqual(report.visuals.pending, null);
                assert.strictEqual(report.visuals.failed, null);
                assert.strictEqual(report.visuals.status, 'missing');
                const visualLine = formatDigestRunSummary(report).split('\n')
                    .find(line => line.includes('长图'));
                assert.match(visualLine, /complete=\?\/\? \| pending=\? \| failed=\?/);
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('长图清单里的归档路径参数非法时也要出报告，不能抛栈', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-report-badvisual-'));
        try {
            withDigestPaths(dir, () => {
                const date = '2026-07-29';
                fs.mkdirSync(Config.FILES.visualSummaryManifestDir, { recursive: true });
                // rank 超出 1–10 时 visualSummaryAssetPath 会抛「视觉摘要归档路径参数非法」。
                // 修复前这会让整个 digest:status 抛栈，运维拿不到报告。
                fs.writeFileSync(
                    path.join(Config.FILES.visualSummaryManifestDir, `${date}.json`),
                    JSON.stringify({
                        batchDate: date,
                        publication: { publicationCommit: 'c'.repeat(40) },
                        papers: {
                            '2607.1': {
                                normalizedArxivId: '2607.1',
                                title: 'Bad rank',
                                rank: 99,
                                analysisSha256: 'a'.repeat(64),
                                promptSha256: 'b'.repeat(64),
                                cards: { infographic: { status: 'complete' } }
                            }
                        }
                    })
                );
                const report = buildDigestRunReport(date, { today: date });
                assert.strictEqual(report.visuals.assetsValid, false);
                assert.strictEqual(report.visuals.gateComplete, false);
                // 能打出摘要，就说明没抛栈。
                assert.match(formatDigestRunSummary(report), /长图 incomplete/);
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('分析未完成的文案要区分「复验不通过」与「集合缺篇」', () => {
        // 复验不通过、但集合覆盖精确：不能说成集合问题。
        const reverify = analysisFailureMessage({
            productionAnalysisComplete: true,
            failedCount: 75,
            failedIds: ['2609.30083', '2609.29923', '2609.29867'],
            missing: 0
        });
        assert.match(reverify, /75 篇未通过逐篇核验/);
        assert.match(reverify, /集合覆盖精确/);
        assert.match(reverify, /未通过核验的这部分/);
        assert.doesNotMatch(reverify, /集合未精确覆盖筛选结果/);

        // 缺口篇数读不到时（归档里有分析结果、当天筛选快照已不在）不能拼出「还缺 null 篇」。
        const unknownGap = analysisFailureMessage({
            productionAnalysisComplete: true, failedCount: 75, failedIds: ['x'], missing: null
        });
        assert.match(unknownGap, /集合缺口未知/);
        assert.doesNotMatch(unknownGap, /null/);

        // 复验失败与真缺口同时存在时，尾句不能把真缺口一起带过去。
        const both = analysisFailureMessage({
            productionAnalysisComplete: true, failedCount: 5, failedIds: ['a'], missing: 3
        });
        assert.match(both, /集合还缺 3 篇/);
        assert.match(both, /未通过核验的这部分/);

        // 集合真的缺篇时要报缺多少，不能只说「未精确覆盖」。
        const missing = analysisFailureMessage({
            productionAnalysisComplete: true, failedCount: 0, failedIds: [], missing: 3
        });
        assert.match(missing, /集合未精确覆盖筛选结果/);
        assert.match(missing, /还缺 3 篇/);

        // 没有缺篇却没覆盖，是成员对不上，不是缺篇——不能报「还缺 0 篇」，
        // 也不能断言「篇数相同」：分析结果是入选集超集时篇数并不相等。
        const swapped = analysisFailureMessage({
            productionAnalysisComplete: true, failedCount: 0, failedIds: [],
            missing: 0, total: 3, expected: 2
        });
        assert.match(swapped, /没有缺篇，但成员与筛选入选集对不上/);
        assert.match(swapped, /分析结果 3 篇、筛选入选 2 篇/);
        assert.doesNotMatch(swapped, /还缺 0 篇/);
        assert.doesNotMatch(swapped, /篇数相同/);

        // 两个数读不到时不要编括号。
        const swappedUnknownCounts = analysisFailureMessage({
            productionAnalysisComplete: true, failedCount: 0, failedIds: [], missing: 0
        });
        assert.match(swappedUnknownCounts, /没有缺篇，但成员与筛选入选集对不上/);
        assert.doesNotMatch(swappedUnknownCounts, /篇、筛选入选/);

        // 缺篇数读不到时不能编一个 0 出来。
        const missingUnknown = analysisFailureMessage({
            productionAnalysisComplete: true, failedCount: 0, failedIds: [], missing: null
        });
        assert.match(missingUnknown, /集合未精确覆盖筛选结果/);
        assert.match(missingUnknown, /缺口篇数未知/);
        assert.doesNotMatch(missingUnknown, /还缺/);

        // 生产契约本身不满足时，报原文案，不去猜是复验还是集合。
        const notProduction = analysisFailureMessage({
            productionAnalysisComplete: false, failedCount: 9, failedIds: ['x'], missing: 9
        });
        assert.match(notProduction, /既未满足 Manual v6 的完整要求/);
    });

    it('摘要把远端 OID 核验与凭证有效性分开报', () => {
        const base = {
            batchDate: '2026-07-29',
            overallStatus: 'incomplete',
            errors: [],
            fetch: { complete: true, rawCandidateCount: 10 },
            filter: { complete: true, selectedCount: 10, totalCandidates: 10, pendingDecisions: 0 },
            analysis: { complete: true, successful: 10, total: 10, expected: 10, missing: 0, failed: 0 },
            blog: { complete: false, strictReview: true, publicationVerified: false, remoteOidVerified: true },
            visuals: {
                gateComplete: true, status: 'complete', complete: 10, total: 10,
                pending: 0, failed: 0, assetsValid: true, archiveUnique: true
            },
            cover: { complete: true, status: 'complete' }
        };
        const summary = formatDigestRunSummary(base);
        assert.match(summary, /remoteOidVerified=true \| receiptValid=false/);
        // 不能再只打一个 remoteVerified，那会让人以为推送没到远端。
        assert.doesNotMatch(summary, /remoteVerified=/);
    });

    it('摘要把分析分母与缺口一起报出来', () => {
        const summary = formatDigestRunSummary({
            batchDate: '2026-07-29',
            overallStatus: 'incomplete',
            errors: [],
            fetch: { complete: true, rawCandidateCount: 46 },
            filter: { complete: true, selectedCount: 46, totalCandidates: 46, pendingDecisions: 0 },
            analysis: { complete: false, successful: 0, total: 0, expected: 46, missing: 46, failed: 0 },
            blog: { complete: false, strictReview: false, publicationVerified: false, remoteOidVerified: false },
            visuals: {
                gateComplete: false, status: 'pending', complete: 0, total: 10,
                pending: 10, failed: 0, assetsValid: false, archiveUnique: false
            },
            cover: { complete: false, status: 'pending' }
        });
        assert.match(summary, /success=0\/0 \| expected=46 \| missing=46/);
    });

    it('分析缺口的两个数读不到时报 ?，不显示成 0', () => {
        const summary = formatDigestRunSummary({
            batchDate: '2026-07-29',
            overallStatus: 'incomplete',
            errors: [],
            fetch: { complete: false, rawCandidateCount: 0 },
            filter: { complete: false, selectedCount: 0, totalCandidates: null, pendingDecisions: null },
            analysis: { complete: false, successful: 0, total: 0, expected: null, missing: null, failed: 0 },
            blog: { complete: false, strictReview: false, publicationVerified: false, remoteOidVerified: false },
            visuals: {
                gateComplete: false, status: 'missing', complete: null, total: null,
                pending: null, failed: null, assetsValid: false, archiveUnique: false
            },
            cover: { complete: false, status: 'missing' }
        });
        const analysisLine = summary.split('\n').find(line => line.includes('分析 '));
        assert.match(analysisLine, /expected=\? \| missing=\?/);
        assert.doesNotMatch(analysisLine, /expected=0/);
        assert.doesNotMatch(analysisLine, /missing=0/);
    });

    it('统一状态门禁与 visual:status 一样严格绑定 canonical 长图路径', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-report-visual-'));
        const originalAssetDir = Config.FILES.visualSummaryAssetDir;
        try {
            Config.FILES.visualSummaryAssetDir = path.join(dir, 'archive');
            const date = '2026-07-29';
            const id = '2607.12345';
            const title = 'Canonical visual';
            const analysisSha = 'a'.repeat(64);
            const promptSha = 'b'.repeat(64);
            const publication = {
                publicationCommit: 'c'.repeat(40),
                generationManifestSha256: 'd'.repeat(64)
            };
            const canonical = visualSummaryAssetPath(date, id, 'infographic', 1, title);
            const raw = makePng();
            fs.mkdirSync(path.dirname(canonical), { recursive: true });
            fs.writeFileSync(canonical, raw);
            const visual = {
                batchDate: date,
                publication,
                papers: {
                    [id]: {
                        normalizedArxivId: id,
                        title,
                        rank: 1,
                        analysisSha256: analysisSha,
                        promptSha256: promptSha,
                        cards: {
                            infographic: {
                                status: 'complete',
                                analysisSha256: analysisSha,
                                promptSha256: promptSha,
                                taskToken: cardTaskToken(
                                    id, 'infographic', analysisSha, promptSha, 1, publication
                                ),
                                assetPath: path.relative(Config.PROJECT_ROOT, canonical),
                                assetSha256: crypto.createHash('sha256').update(raw).digest('hex'),
                                qaAttestation: {
                                    attested: true,
                                    checklistVersion: 'visual-semantic-v1',
                                    attestedAt: '2026-07-29T12:00:00.000+08:00'
                                }
                            }
                        }
                    }
                }
            };
            assert.deepStrictEqual(visualAssetsAreValid(visual), {
                visualCards: [{
                    id,
                    paper: visual.papers[id],
                    kind: 'infographic',
                    card: visual.papers[id].cards.infographic
                }],
                assetsValid: true,
                archiveUnique: true
            });

            const nonCanonical = path.join(Config.FILES.visualSummaryAssetDir, 'other.png');
            fs.renameSync(canonical, nonCanonical);
            visual.papers[id].cards.infographic.assetPath = path.relative(
                Config.PROJECT_ROOT, nonCanonical
            );
            const invalid = visualAssetsAreValid(visual);
            assert.strictEqual(invalid.assetsValid, false);
        } finally {
            Config.FILES.visualSummaryAssetDir = originalAssetDir;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('长图 status 由门禁派生：清单自称 complete 而资产不过时不得说 complete', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-report-visual-status-'));
        const originalAssetDir = Config.FILES.visualSummaryAssetDir;
        const originalWaiverDir = Config.FILES.postPublishVisualWaiverDir;
        const originalAnalysisWaiverDir = Config.FILES.analysisWaiverDir;
        try {
            Config.FILES.visualSummaryAssetDir = path.join(dir, 'archive');
            Config.FILES.postPublishVisualWaiverDir = path.join(dir, 'waivers');
            Config.FILES.analysisWaiverDir = path.join(dir, 'analysis-waivers');
            withDigestPaths(dir, () => {
                const date = '2026-07-29';
                fs.mkdirSync(Config.FILES.visualSummaryManifestDir, { recursive: true });
                const manifestPath = path.join(Config.FILES.visualSummaryManifestDir, `${date}.json`);
                // 清单自己说 complete、计数也满，但这张卡的资产核验过不了。
                const manifest = {
                    batchDate: date,
                    overallStatus: 'complete',
                    counts: { totalCards: 1, completeCards: 1, pendingCards: 0, failedCards: 0 },
                    publication: {
                        publicationCommit: 'c'.repeat(40),
                        generationManifestSha256: 'd'.repeat(64)
                    },
                    papers: {
                        '2607.1': {
                            normalizedArxivId: '2607.1',
                            title: 'T',
                            rank: 1,
                            analysisSha256: 'a'.repeat(64),
                            promptSha256: 'b'.repeat(64),
                            cards: { infographic: { status: 'complete' } }
                        }
                    }
                };
                fs.writeFileSync(manifestPath, JSON.stringify(manifest));
                const report = buildDigestRunReport(date, { today: date });
                assert.strictEqual(report.visuals.gateComplete, false);
                assert.strictEqual(report.visuals.assetsValid, false);
                assert.strictEqual(report.visuals.status, 'incomplete');
                const line = formatDigestRunSummary(report).split('\n')
                    .find(item => item.includes('长图'));
                assert.match(line, /长图 incomplete \| status=incomplete/);
                assert.doesNotMatch(line, /status=complete/);

                // 清单自己说 pending 时照说 pending，不要一律压成 incomplete。
                manifest.overallStatus = 'pending';
                fs.writeFileSync(manifestPath, JSON.stringify(manifest));
                const pending = buildDigestRunReport(date, { today: date });
                assert.strictEqual(pending.visuals.status, 'pending');
            });
        } finally {
            Config.FILES.visualSummaryAssetDir = originalAssetDir;
            Config.FILES.postPublishVisualWaiverDir = originalWaiverDir;
            Config.FILES.analysisWaiverDir = originalAnalysisWaiverDir;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('候选快照不在时 rawCandidateCount 是 null，摘要打 ?；快照在但为空才是 0', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-report-rawcount-'));
        try {
            withDigestPaths(dir, () => {
                const date = '2026-07-29';
                // 快照不在：读不到就报 null，不能报 0。
                const missing = buildDigestRunReport(date, { today: date });
                assert.strictEqual(missing.fetch.rawCandidateCount, null);
                assert.match(formatDigestRunSummary(missing), /抓取 incomplete \| candidates=\?/);
                assert.doesNotMatch(formatDigestRunSummary(missing), /candidates=0/);

                // 快照在、候选确实为空：这时 0 是真值，要照打 0。
                fs.writeFileSync(Config.FILES.rawCandidates, JSON.stringify({
                    batchDate: date,
                    sourceHealth: healthySourceHealth(),
                    papers: []
                }));
                const empty = buildDigestRunReport(date, { today: date });
                assert.strictEqual(empty.fetch.rawCandidateCount, 0);
                assert.match(formatDigestRunSummary(empty), /candidates=0/);
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('文件存在但读不出来时报告给出告警，真·不存在保持安静', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-report-readproblems-'));
        try {
            withDigestPaths(dir, () => {
                const date = '2026-07-29';
                // A 真·不存在：不算错误，也不该有告警。
                const missing = buildDigestRunReport(date, { today: date });
                assert.deepStrictEqual(missing.readProblems, []);
                assert.strictEqual(missing.dataSources.rawCandidates, 'missing');
                assert.doesNotMatch(formatDigestRunSummary(missing), /读取告警/);

                // B 存在但 JSON 坏了：要能看出是「坏了」，不是「没生成」。
                fs.writeFileSync(Config.FILES.rawCandidates, '{broken');
                const corrupt = buildDigestRunReport(date, { today: date });
                assert.deepStrictEqual(corrupt.readProblems, [
                    { path: Config.FILES.rawCandidates, kind: 'invalid-json' }
                ]);
                assert.match(formatDigestRunSummary(corrupt), /存在，但 JSON 解析失败/);

                // C 存在但不是文件：同样要说出来。
                fs.rmSync(Config.FILES.rawCandidates);
                fs.mkdirSync(Config.FILES.rawCandidates);
                const unreadable = buildDigestRunReport(date, { today: date });
                assert.strictEqual(unreadable.readProblems.length, 1);
                assert.strictEqual(unreadable.readProblems[0].kind, 'unreadable');
                assert.strictEqual(unreadable.readProblems[0].code, 'EISDIR');
                assert.match(formatDigestRunSummary(unreadable), /无法读取（EISDIR）/);
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
