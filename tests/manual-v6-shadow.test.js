const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
    SHADOW_MODE,
    SHADOW_CONTRACT_FINGERPRINT,
    assertDate,
    outputPathWithin,
    coverageStatus,
    buildShadowReport,
    initializeShadowWorkspace,
    parseArgs
} = require('../scripts/manual-v6-shadow.js');
const {
    PERCENTILE_ALGORITHM,
    MIN_BATCH_SAMPLES,
    embeddedInputFingerprint,
    aggregateShadowReports,
    loadVerifiedShadowReport,
    assertShadowOutputPath
} = require('../scripts/manual-shadow-benchmark.js');
const { tableNumericCellIds } = require('../scripts/manual-longform-contract.js');
const { buildStageMetric } = require('../scripts/manual-performance-metrics.js');

function sha(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function makeFixture(options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-shadow-'));
    const currentDir = path.join(root, 'current');
    const archiveDir = path.join(root, 'archive');
    const shadowRoot = path.join(currentDir, 'manual-v6-shadow');
    const workspaceDir = path.join(shadowRoot, '2026-08-28', 'trial-a');
    const date = options.date || '2026-08-28';
    const id = '2608.30001';
    let artifactPath = null;
    let v6RecordPath = null;
    fs.mkdirSync(currentDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });
    writeJson(path.join(currentDir, 'filtered-papers.json'), {
        status: 'complete', batchDate: date, papers: [{ arxivId: id, title: 'Audio' }]
    });
    const fullDir = path.join(currentDir, 'manual-full-text', date);
    fs.mkdirSync(fullDir, { recursive: true });
    // Deliberately invalid as structure: a correct shadow reader must never use
    // flattened text to invent table/formula completeness.
    fs.writeFileSync(path.join(fullDir, `${id}.txt`), 'Table 1  1  2\n$$x=1$$');
    const sourceEntry = { status: 'complete', path: path.join(fullDir, `${id}.txt`) };
    if (options.structured !== false) {
        const artifactDir = path.join(fullDir, 'artifacts');
        const snapshotPath = path.join(artifactDir, 'source', `${id}.structured.json`);
        const snapshot = {
            version: 1, mode: 'manual_structured_source_snapshot', paperId: id,
            payloadSha256: 'a'.repeat(64), structuredArtifacts: { marker: true }
        };
        writeJson(snapshotPath, snapshot);
        const snapshotBytes = fs.readFileSync(snapshotPath);
        sourceEntry.structuredArtifactsSnapshot = {
            version: 1, path: snapshotPath, payloadSha256: snapshot.payloadSha256,
            outputSha256: sha(snapshotBytes), bytes: snapshotBytes.length
        };
        const table = {
            id: 'TAB0001', kind: 'result', matrix: [['Method', 'WER'], ['A', '12.5']],
            matrixSha256: 'b'.repeat(64)
        };
        const artifact = {
            version: 1, paperId: id,
            inputIdentity: { structuredArtifactsSha256: snapshot.payloadSha256 },
            inventoryHealth: { status: 'complete', issues: [] },
            sourceSpans: [{ id: 'SPAN0001', text: 'source evidence' }],
            tables: [table], figures: [{ id: 'IMG0001', url: 'https://example.com/a.png' }],
            formulas: [{ id: 'FOR0001', raw: 'x=1' }], acronyms: [{ id: 'ACR0001', value: 'ASR' }],
            citations: [{ id: 'CIT0001', value: '[1]' }], references: [{ id: 'REF0001', text: 'Paper' }]
        };
        artifactPath = path.join(artifactDir, `${id}.artifact.json`);
        writeJson(artifactPath, artifact);
        const artifactBytes = fs.readFileSync(artifactPath);
        writeJson(path.join(artifactDir, 'manifest.json'), {
            version: 1, date, papers: {
                [id]: { status: 'complete', path: artifactPath, outputSha256: sha(artifactBytes) }
            }
        });
        if (options.v6Record) {
            const numericIds = tableNumericCellIds(table);
            v6RecordPath = path.join(workspaceDir, 'records', `${id}.json`);
            writeJson(v6RecordPath, {
                date, papers: { [id]: {
                    paperId: id,
                    evidenceLedger: [{ id: 'E1' }, { id: 'E2' }],
                    resultClaims: [{ id: 'R1' }],
                    editorial: {
                        readerArticle: `第一段${'甲'.repeat(650)}\n\n第二段`,
                        longformBundle: {
                            blocks: [{ id: 'B01', evidenceSpanIds: ['SPAN0001'] }],
                            tables: [{ sourceTableId: 'TAB0001', disposition: 'inline', coveredNumericCellIds: numericIds }],
                            figures: [{ id: 'IMG0001', disposition: 'inline' }],
                            formulas: [{ id: 'FOR0001', disposition: 'inline' }],
                            terms: [{ id: 'ACR0001' }], relatedWorks: [{ citationId: 'CIT0001' }],
                            authorReceipt: {
                                startedAt: '2026-08-28T10:00:00.000+08:00',
                                completedAt: '2026-08-28T10:02:00.000+08:00'
                            }
                        }
                    }
                } }
            });
        }
    }
    writeJson(path.join(fullDir, 'manifest.json'), { version: 2, date, papers: { [id]: sourceEntry } });
    writeJson(path.join(currentDir, `manual-analysis-record-${date}-${id}.json`), {
        version: 3, mode: 'manual_analysis_records', date, papers: { [id]: {
            arxivId: id, evidenceLedger: [{ id: 'E1' }], resultClaims: [{ id: 'R1' }],
            editorial: { readerArticle: 'v5 第一段\n\nv5 第二段' }
        } }
    });
    if (v6RecordPath) {
        const metric = buildStageMetric({
            date, stage: 'artifact_index', status: 'complete',
            wallNs: 250000000n,
            wallAggregation: 'union_of_observed_same_stage_operation_intervals',
            cache: { hits: 3, misses: 1 }, paperCount: 1, taskCount: 4,
            inputFiles: [{ role: 'artifact_index', path: artifactPath }],
            outputFiles: [{ role: 'v6_shadow_record', path: v6RecordPath }],
            projectRoot: root, allowedRoots: [currentDir, archiveDir, shadowRoot],
            recordedAt: '2026-08-28T12:00:00.000+08:00'
        });
        writeJson(path.join(workspaceDir, 'metrics.json'), metric);
    }
    return { root, currentDir, archiveDir, shadowRoot, workspaceDir, fullDir, date, id };
}

describe('Manual v6 shadow audit', () => {
    it('历史扁平全文缺少结构快照时明确 blocked，绝不把 txt 推导为完整 inventory', () => {
        const fixture = makeFixture({ date: '2026-08-27', structured: false });
        const report = buildShadowReport({
            date: fixture.date, currentDir: fixture.currentDir, archiveDir: fixture.archiveDir,
            generatedAt: '2026-08-28T12:00:00.000+08:00', shadowRoot: fixture.shadowRoot
        });
        const paper = report.papers[fixture.id];
        assert.strictEqual(report.status, 'blocked');
        assert.strictEqual(paper.status, 'blocked');
        assert.deepStrictEqual(paper.failureReasons, ['blocked_by_missing_structured_source']);
        assert.strictEqual(paper.inventory.tables.status, 'unknown');
        assert.strictEqual(paper.coverage.numericCells.status, 'blocked');
        assert.strictEqual(paper.article.status, 'known');
        assert.strictEqual(report.summary.quality.numericCellCoverageRate.status, 'blocked');
        assert.strictEqual(report.summary.quality.numericCellCoverageRate.value, null);
    });

    it('报告记录真实输入 SHA、结构覆盖、正文统计与真实 metrics/receipt', () => {
        const fixture = makeFixture({ v6Record: true });
        const report = buildShadowReport({
            date: fixture.date, currentDir: fixture.currentDir, archiveDir: fixture.archiveDir,
            workspaceDir: fixture.workspaceDir, shadowRoot: fixture.shadowRoot,
            projectRoot: fixture.root,
            generatedAt: '2026-08-28T12:00:00.000+08:00'
        });
        const paper = report.papers[fixture.id];
        assert.strictEqual(report.contractFingerprint, SHADOW_CONTRACT_FINGERPRINT);
        assert.strictEqual(report.inputFingerprint, embeddedInputFingerprint(report));
        assert.ok(report.inputs.every(item => /^[a-f0-9]{64}$/.test(item.sha256) && item.bytes > 0));
        assert.strictEqual(paper.status, 'v6_candidate_available');
        assert.strictEqual(paper.inventory.numericCells.value, 1);
        assert.strictEqual(paper.facts.sourceSpanCoverage.rate, 1);
        assert.strictEqual(paper.coverage.numericCells.rate, 1);
        assert.strictEqual(paper.article.longParagraphs.over600, 1);
        assert.strictEqual(report.metrics.stages.artifact_index.durationMs.value, 250);
        assert.strictEqual(report.metrics.stages.artifact_index.cacheHitRate.value, 0.75);
        assert.strictEqual(report.metrics.stages.author_receipt_sum.durationMs.value, 120000);
        assert.strictEqual(report.metrics.stages.technical_scoring.durationMs.status, 'unknown');
        assert.strictEqual(report.summary.quality.numericCellCoverageRate.status, 'known');
        assert.strictEqual(report.summary.quality.numericCellCoverageRate.value, 1);
    });

    it('显式 fresh init 只写 shadow workspace，复用相同 checkpoint 并拒绝历史日期', () => {
        const fixture = makeFixture();
        const officialFiles = [
            path.join(fixture.currentDir, 'filtered-papers.json'),
            path.join(fixture.fullDir, 'manifest.json')
        ];
        const before = officialFiles.map(file => sha(fs.readFileSync(file)));
        const report = buildShadowReport({
            date: fixture.date, currentDir: fixture.currentDir, archiveDir: fixture.archiveDir,
            shadowRoot: fixture.shadowRoot, generatedAt: '2026-08-28T12:00:00.000+08:00'
        });
        const first = initializeShadowWorkspace(report, fixture.workspaceDir, {
            currentDate: fixture.date, shadowRoot: fixture.shadowRoot
        });
        const second = initializeShadowWorkspace(report, fixture.workspaceDir, {
            currentDate: fixture.date, shadowRoot: fixture.shadowRoot
        });
        assert.strictEqual(first.cacheHit, false);
        assert.strictEqual(second.cacheHit, true);
        assert.deepStrictEqual(officialFiles.map(file => sha(fs.readFileSync(file))), before);
        assert.throws(() => initializeShadowWorkspace(report, path.join(fixture.shadowRoot, 'old'), {
            currentDate: '2026-08-29', shadowRoot: fixture.shadowRoot
        }), /历史批次仅允许审计/);
    });

    it('输入与输出 symlink realpath 逃逸均 fail closed', () => {
        const fixture = makeFixture();
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-shadow-outside-'));
        const outputLink = path.join(fixture.shadowRoot, 'escape');
        fs.mkdirSync(fixture.shadowRoot, { recursive: true });
        fs.symlinkSync(outside, outputLink);
        assert.throws(
            () => outputPathWithin(fixture.shadowRoot, path.join(outputLink, 'report.json'), 'report'),
            /逃逸/
        );

        const artifactManifest = JSON.parse(fs.readFileSync(path.join(fixture.fullDir, 'artifacts', 'manifest.json')));
        const outsideArtifact = path.join(outside, 'artifact.json');
        writeJson(outsideArtifact, { paperId: fixture.id });
        artifactManifest.papers[fixture.id].path = outsideArtifact;
        artifactManifest.papers[fixture.id].outputSha256 = sha(fs.readFileSync(outsideArtifact));
        writeJson(path.join(fixture.fullDir, 'artifacts', 'manifest.json'), artifactManifest);
        assert.throws(() => buildShadowReport({
            date: fixture.date, currentDir: fixture.currentDir, archiveDir: fixture.archiveDir,
            shadowRoot: fixture.shadowRoot
        }), /realpath 逃逸/);
    });

    it('参数和 package wiring 保持显式 shadow，不改默认链路', () => {
        assert.throws(() => assertDate('2026-02-30'), /非法日期/);
        assert.strictEqual(coverageStatus(0, 0).status, 'not_applicable');
        assert.strictEqual(coverageStatus(null, null).status, 'unknown');
        assert.throws(() => parseArgs(['--date', '2026-08-28', '--init-shadow']), /--workspace/);
        const parsed = parseArgs(['--date', '2026-08-28']);
        assert.strictEqual(parsed.initShadow, false);
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json')));
        assert.strictEqual(pkg.scripts['manual:shadow'], 'node scripts/manual-v6-shadow.js');
        assert.strictEqual(pkg.scripts['manual:shadow:benchmark'], 'node scripts/manual-shadow-benchmark.js');
        assert.match(fs.readFileSync(path.join(__dirname, '..', 'run-daily-digest.sh'), 'utf8'), /manual:spec\/manual:analyze/);
    });
});

function reportFixture(date, duration, cacheRate, quality = {}) {
    const report = {
        version: 1, mode: SHADOW_MODE, contractFingerprint: SHADOW_CONTRACT_FINGERPRINT, date,
        inputs: [], paperSet: { ids: [`${date}-paper`], sha256: null },
        metrics: { stages: {
            author: {
                durationMs: { status: 'known', value: duration },
                cacheHitRate: cacheRate === null
                    ? { status: 'unknown', value: null }
                    : { status: 'known', value: cacheRate }
            }
        } },
        summary: { quality }
    };
    const stable = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
    // IDs are already ordered and contain no object-key ambiguity.
    report.paperSet.sha256 = stable(report.paperSet.ids);
    report.inputFingerprint = embeddedInputFingerprint(report);
    return report;
}

describe('Manual shadow benchmark', () => {
    it('少于三批明确 insufficient_samples，unknown 不当作 0', () => {
        const result = aggregateShadowReports([
            reportFixture('2026-08-25', 100, null),
            reportFixture('2026-08-26', 200, null)
        ]);
        assert.strictEqual(result.percentileAlgorithm, PERCENTILE_ALGORITHM);
        assert.strictEqual(result.minimumBatchSamples, MIN_BATCH_SAMPLES);
        assert.strictEqual(result.stages.author.durationMs.status, 'insufficient_samples');
        assert.strictEqual(result.stages.author.durationMs.sampleCount, 2);
        assert.strictEqual(result.stages.author.cacheHitRate.sampleCount, 0);
        assert.strictEqual(result.stages.author.durationMs.p50, null);
    });

    it('三批使用进入协议指纹的 nearest-rank-v1 计算 P50/P95', () => {
        const result = aggregateShadowReports([
            reportFixture('2026-08-25', 100, 0.1, { articleCharsMean: 2000 }),
            reportFixture('2026-08-26', 300, 0.9, { articleCharsMean: 4000 }),
            reportFixture('2026-08-27', 200, 0.5, { articleCharsMean: 3000 })
        ]);
        assert.strictEqual(result.stages.author.durationMs.status, 'known');
        assert.strictEqual(result.stages.author.durationMs.p50, 200);
        assert.strictEqual(result.stages.author.durationMs.p95, 300);
        assert.strictEqual(result.quality.articleCharsMean.p50, 3000);
        assert.strictEqual(result.quality.articleCharsMean.p95, 4000);
    });

    it('篡改 contract 或 embedded input fingerprint 时拒绝 benchmark', () => {
        const report = reportFixture('2026-08-25', 100, 0.5);
        assert.throws(() => aggregateShadowReports([{ ...report, contractFingerprint: '0'.repeat(64) }]), /contractFingerprint/);
        assert.throws(() => aggregateShadowReports([{ ...report, inputFingerprint: '0'.repeat(64) }]), /inputFingerprint/);
    });

    it('从隔离目录加载报告时复核报告 SHA、输入文件 SHA 与 embedded fingerprint', () => {
        const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-shadow-benchmark-'));
        const currentDir = path.join(projectRoot, 'data', 'current');
        const archiveDir = path.join(projectRoot, 'data', 'archive');
        const shadowRoot = path.join(currentDir, 'manual-v6-shadow');
        fs.mkdirSync(shadowRoot, { recursive: true });
        fs.mkdirSync(archiveDir, { recursive: true });
        const sourcePath = path.join(currentDir, 'filtered-papers.json');
        const sourceBytes = Buffer.from('{"status":"complete"}\n');
        fs.writeFileSync(sourcePath, sourceBytes);
        const report = reportFixture('2026-08-25', 100, 0.5);
        report.inputs = [{
            role: 'filtered_papers',
            path: path.relative(projectRoot, sourcePath),
            bytes: sourceBytes.length,
            sha256: sha(sourceBytes)
        }];
        report.inputFingerprint = embeddedInputFingerprint(report);
        const reportPath = path.join(shadowRoot, 'reports', '2026-08-25.json');
        writeJson(reportPath, report);
        const reportBytes = fs.readFileSync(reportPath);

        const loaded = loadVerifiedShadowReport(reportPath, {
            projectRoot, shadowRoot, allowedInputRoots: [currentDir, archiveDir, shadowRoot]
        });
        assert.strictEqual(loaded.input.sha256, sha(reportBytes));
        assert.strictEqual(loaded.input.bytes, reportBytes.length);
        assert.strictEqual(loaded.input.reportInputFingerprint, report.inputFingerprint);
        assert.strictEqual(loaded.input.reportContractFingerprint, SHADOW_CONTRACT_FINGERPRINT);
        const benchmark = aggregateShadowReports([loaded.report], { inputFiles: [loaded.input] });
        assert.strictEqual(benchmark.inputs[0].sha256, sha(reportBytes));
        assert.strictEqual(benchmark.inputs[0].reportInputFingerprint, report.inputFingerprint);

        fs.writeFileSync(sourcePath, '{"status":"tampered"}\n');
        assert.throws(() => loadVerifiedShadowReport(reportPath, {
            projectRoot, shadowRoot, allowedInputRoots: [currentDir, archiveDir, shadowRoot]
        }), /SHA\/bytes 已变化/);
    });

    it('benchmark 的输入报告 symlink 与输出 symlink 均 fail closed', () => {
        const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-shadow-benchmark-link-'));
        const currentDir = path.join(projectRoot, 'data', 'current');
        const archiveDir = path.join(projectRoot, 'data', 'archive');
        const shadowRoot = path.join(currentDir, 'manual-v6-shadow');
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-shadow-benchmark-outside-'));
        fs.mkdirSync(shadowRoot, { recursive: true });
        fs.mkdirSync(archiveDir, { recursive: true });
        const reportPath = path.join(outside, 'report.json');
        writeJson(reportPath, reportFixture('2026-08-25', 100, 0.5));
        const inputLink = path.join(shadowRoot, 'report-link.json');
        fs.symlinkSync(reportPath, inputLink);
        assert.throws(() => loadVerifiedShadowReport(inputLink, {
            projectRoot, shadowRoot, allowedInputRoots: [currentDir, archiveDir, shadowRoot]
        }), /不得为 symlink/);

        const outputLink = path.join(shadowRoot, 'output-link.json');
        fs.symlinkSync(path.join(outside, 'output.json'), outputLink);
        assert.throws(() => assertShadowOutputPath(outputLink, { shadowRoot }), /输出必须位于|不得覆盖 symlink/);
    });
});
