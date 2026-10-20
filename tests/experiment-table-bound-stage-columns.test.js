'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto'), zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const Config = require('../scripts/config'), contract = require('../scripts/analysis-contract');
const engine = require('../scripts/analysis-engine'), daily = require('../scripts/lib/daily-fresh-source-plan');
const fresh = require('../scripts/lib/fresh-analysis-context'), stop = require('../scripts/lib/analysis-stop-control');
const { parseAnalysis } = require('../scripts/utils');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const reason = paper => contract.getInvalidAnalysisReason(paper.analysis, parseAnalysis(paper.analysis), {
    paper, enforceExperimentTableContract: true,
    experimentTableContractVersion: contract.EXPERIMENT_TABLE_CONTRACT_VERSION
});

if (process.argv[2] === '--cold-child') {
    Config.FILES.deepAnalysisResult = process.argv[3];
    Config.FILES.dailyFreshSourceRunsDir = process.argv[4];
    const paper = JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)).papers[0];
    stop.withModelRequestsForbidden(() => console.log('COLD_STAGE_COLUMNS=' + JSON.stringify({
        reason: reason(paper), validBody: engine.hasValidAnalysisBody(paper)
    })));
} else {
    const test = require('node:test'), assert = require('node:assert/strict');
    const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/core-summary-daily-20261020-real.json.gz'));
    const real = JSON.parse(zlib.gunzipSync(bytes)).papers.find(paper => paper.paperId === '2610.25640');
    const noModel = callback => t => stop.withModelRequestsForbidden(() => callback(t));
    async function sealed(t, text = real.sourceText) {
        const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bound-stage-columns-'));
        const previous = { deepAnalysisResult: Config.FILES.deepAnalysisResult,
            dailyFreshSourceRunsDir: Config.FILES.dailyFreshSourceRunsDir };
        Config.FILES.deepAnalysisResult = path.join(root, 'result.json');
        Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
        t.after(() => { Object.assign(Config.FILES, previous); fs.rmSync(root, { recursive: true, force: true }); });
        const paper = require('./valid-analysis-fixture').validAnalysisPaper(real.paperId, {}, real.checkpointAnalysis);
        paper.analysisManifest.contracts.experimentTables = contract.EXPERIMENT_TABLE_CONTRACT_VERSION;
        const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-20', batchId: 'bound-stage-columns', papers: [paper] });
        // Original complete paid analysis/TXT exercise source-dependent table identity.
        // The local test PDF is a storage fixture, not production source authority.
        await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: options =>
            require('../scripts/lib/fresh-arxiv-rewrite-source').captureFreshArxivRewriteSource(options, {
                fetchText: async id => ({ source: 'html', sourceId: id, text,
                    url: 'https://arxiv.org/html/' + id, imageInfos: [], warnings: [] }),
                fetchPdf: async id => ({ bytes: Buffer.from('%PDF-1.7\nlocal test fixture\n%%EOF\n'),
                    url: 'https://arxiv.org/pdf/' + id })
            }) });
        daily.withDailyFreshAnalysisContext(plan, () => {
            const source = daily.readDailyFreshSource(plan, paper);
            paper.sourceSha256 = source.freshSourceDescriptor.sourceSha256;
            paper.analysisManifest.sourceAcquisition = { sourceSha256: paper.sourceSha256,
                ...require('../scripts/lib/model-text-sanitization').modelTextFingerprintFields(paper, source),
                ...require('../scripts/lib/prompt-rendering-contract').promptRenderingFingerprintFields(paper, source) };
            fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source);
        });
        fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify({ batchDate: plan.batchDate,
            dailyFreshSourceRun: daily.dailyFreshSourceReference(plan), papers: [paper] }));
        return { paper, plan, root };
    }

    test('真实ThinkCompress完整保存稿由公共最终检查及独立冷进程重放阶段身份，不改原稿或费用', noModel(async t => {
        assert.equal(sha(bytes), '964cb2f120aa4dcaa41d01d7163ebf6f136d1acd1c56de3c4bd116caf1c76161');
        assert.equal(sha(real.checkpointAnalysis), real.checkpointAnalysisSha256);
        assert.equal(sha(real.sourceText), real.sourceSha256);
        const { paper, plan } = await sealed(t);
        const before = JSON.stringify(paper), stored = fs.readFileSync(Config.FILES.deepAnalysisResult);
        assert.match(contract.getInvalidAnalysisReason(paper.analysis, parseAnalysis(paper.analysis), {
            enforceExperimentTableContract: true,
            experimentTableContractVersion: contract.EXPERIMENT_TABLE_CONTRACT_VERSION
        }), /第 2 张表缺少.*识别列/);
        assert.equal(reason(paper), null);
        assert.equal(engine.hasValidAnalysisBody(paper), true);
        await daily.withDailyFreshAnalysisContext(plan, () => fresh.withFreshPaperContext(paper, () => {
            assert.equal(reason(paper), null);
            assert.equal(engine.hasValidAnalysisBody(paper), true);
        }));
        const child = spawnSync(process.execPath, [__filename, '--cold-child', Config.FILES.deepAnalysisResult,
            Config.FILES.dailyFreshSourceRunsDir], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000 });
        assert.equal(child.status, 0, child.stderr + child.stdout);
        const line = child.stdout.split('\n').find(value => value.includes('COLD_STAGE_COLUMNS='));
        assert.ok(line, child.stdout);
        assert.deepEqual(JSON.parse(line.split('COLD_STAGE_COLUMNS=')[1]), { reason: null, validBody: true });
        assert.equal(JSON.stringify(paper), before);
        assert.deepEqual(fs.readFileSync(Config.FILES.deepAnalysisResult), stored);
    }));

    test('另一来源或错误阶段配置不因身份列fallback获得通过', noModel(async t => {
        const { paper } = await sealed(t, real.sourceText.replaceAll('Stage 4', 'Part 4'));
        assert.match(reason(paper), /识别列/);
        assert.equal(engine.hasValidAnalysisBody(paper), false);
    }));

    test('错误论文、来源绑定、缺计划与四件封存漂移不能借调用方文本通过', noModel(async t => {
        const { paper, plan } = await sealed(t);
        for (const change of [p => { p.arxivId = '2610.99999'; },
            p => { p.sourceSha256 = 'a'.repeat(64); },
            p => { p.analysisManifest.sourceAcquisition.sourceSha256 = 'b'.repeat(64); },
            p => { p.freshRewriteProvenance.sourceSha256 = 'c'.repeat(64); }]) {
            const wrong = structuredClone(paper); change(wrong); wrong.sourceText = real.sourceText;
            assert.throws(() => reason(wrong), /来源|绑定|计划|论文/);
            assert.equal(engine.hasValidAnalysisBody(wrong), false);
        }
        const stored = fs.readFileSync(Config.FILES.deepAnalysisResult);
        fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify({ papers: [paper] }));
        assert.throws(() => reason(paper), /来源|计划/);
        fs.writeFileSync(Config.FILES.deepAnalysisResult, stored);
        for (const name of ['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json']) {
            const file = path.join(plan.sourcesDir, real.paperId, 'generation-000001', name), original = fs.readFileSync(file);
            try { fs.appendFileSync(file, ' altered evidence'); assert.throws(() => reason(paper), /来源|SHA|不一致/); }
            finally { fs.writeFileSync(file, original); }
        }
        assert.equal(reason(paper), null);
    }));

    test('普通通过表格不额外读取封存来源，调用方没有paper仍不能获得阶段身份', noModel(t => {
        t.mock.method(daily, 'requireDailyFreshSourceRecoveryPlan', () => assert.fail('ordinary table must not read source'));
        const ordinary = require('./valid-analysis-fixture').validAnalysisPaper('2610.99998');
        assert.equal(reason(ordinary), null);
        assert.match(contract.getInvalidAnalysisReason(real.checkpointAnalysis, parseAnalysis(real.checkpointAnalysis), {
            enforceExperimentTableContract: true,
            experimentTableContractVersion: contract.EXPERIMENT_TABLE_CONTRACT_VERSION
        }), /识别列/);
    }));
}
