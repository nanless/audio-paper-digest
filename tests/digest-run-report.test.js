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
    formatDigestRunSummary
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

describe('digest run report', () => {
    it('accepts only a user visual waiver bound to current publication and exact manifests', () => {
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

    it('LLM API canonical 必须闭环 reader、评分、来源与实际正文哈希', () => {
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
        paper.apiReaderPlan = { version: 1, contract: 'beginner-researcher-v2' };
        paper.apiReaderFigures = [];
        paper.apiReaderAuthors = { authors: [{ name: 'Author', affiliations: ['Lab'] }] };
        paper.sourceSha256 = '1'.repeat(64);
        paper.apiReaderArticleSha256 = hashText(paper.apiReaderArticle);
        paper.apiReaderPlanSha256 = hashStable(paper.apiReaderPlan);
        paper.parsed = { ...(paper.parsed || {}), score: 7.5 };
        paper.analysisManifest = {
            contracts: { apiReaderArticle: 'beginner-researcher-v2' },
            sourceAcquisition: { fullTextAvailable: true, sourceSha256: paper.sourceSha256 },
            stages: {
                scoringAudit: {
                    status: 'complete', scoringContract: 'api-scoring-audit-v2',
                    auditSha256: '2'.repeat(64), evidenceSha256: '3'.repeat(64),
                    outputAnalysisSha256: hashText(paper.analysis), finalScore: 7.5
                },
                apiReaderArticle: {
                    status: 'complete', model: 'muse-spark-1.2-contributor',
                    protocol: 'openai_responses', articleSha256: paper.apiReaderArticleSha256,
                    planSha256: paper.apiReaderPlanSha256,
                    figuresSha256: hashStable(paper.apiReaderFigures),
                    readerAuthorsSha256: hashStable(paper.apiReaderAuthors)
                }
            }
        };
        assert.strictEqual(llmApiPaperComplete(paper), true);
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
        assert.match(summary, /长图 incomplete \| complete=10\/10/);
        assert.doesNotMatch(summary, /长图 complete \|/);
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
});
