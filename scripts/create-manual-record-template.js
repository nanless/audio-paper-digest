#!/usr/bin/env node
/** Create one isolated-paper Manual v5 records skeleton. No LLM/API is called. */
const fs = require('fs');
const path = require('path');
const Config = require('./config.js');
const { normalizedId, writeFileAtomic } = require('./utils.js');
const { REQUIRED_RECOVERY_STAGES } = require('./analysis-contract.js');

function parseArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (!['--date', '--paper', '--output'].includes(arg)) throw new Error(`未知参数: ${arg}`);
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
        options[arg.slice(2)] = value;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date || '')) throw new Error('--date 必须是 YYYY-MM-DD');
    options.paper = normalizedId(options.paper);
    if (!options.paper) throw new Error('--paper 必须是合法 arXiv ID');
    return options;
}

function readJson(filePath, label) {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!value || typeof value !== 'object') throw new Error(`${label} 非法: ${filePath}`);
    return value;
}

function buildTemplate(date, paperId, options = {}) {
    const filtered = options.filtered || readJson(Config.FILES.filteredPapers, 'filtered-papers');
    if (filtered.batchDate !== date || filtered.status !== 'complete') {
        throw new Error(`filtered-papers.json 不是 ${date} complete 批次`);
    }
    const paper = filtered.papers.find(item => normalizedId(item) === paperId);
    if (!paper) throw new Error(`${paperId} 不在 filtered 批次`);
    const manifestPath = path.join(Config.CURRENT_DIR, 'manual-full-text', date, 'manifest.json');
    const manifest = options.manifest || readJson(manifestPath, 'manual full-text manifest');
    const source = manifest.papers?.[paperId];
    if (!source || source.status !== 'complete') throw new Error(`${paperId} 缺少 complete 全文 checkpoint`);
    const imageInfos = Array.isArray(source.imageInfos) ? source.imageInfos : [];
    const placeholderStage = stage => ({
        decision: 'manual_verified',
        attempts: 2,
        evidenceIds: ['E01'],
        sourceQuotes: [`TODO: ${stage} 连续全文原句`],
        issues: [],
        conclusion: `TODO: ${stage} 的论文特有人工核验结论，至少 20 字。`
    });
    const record = {
        arxivId: paperId,
        type: 'TODO',
        task: '#TODO',
        tags: '#TODO #TODO #TODO',
        dims: [0, 0, 0, 0, 0, 0, 0, 0],
        confidence: '低',
        authorInfo: {
            firstAuthorAffiliation: 'TODO', correspondingAuthors: 'TODO',
            affiliations: 'TODO', sourceQuote: 'TODO: 连续作者机构原句'
        },
        question: 'TODO', method: 'TODO', method2: 'TODO', method3: 'TODO',
        innovations: 'TODO', results: 'TODO', details: 'TODO', limits: 'TODO',
        open: 'TODO', review: 'TODO', scoringReasons: Array(8).fill('TODO'),
        evidenceLedger: [], resultClaims: [],
        researchBrief: {
            version: 1, contract: 'audio-researcher-v1', audience: 'audio_researcher',
            paperSubagent: {
                version: 1, taskName: `paper-${paperId}-authoring`, paperId,
                singlePaperOnly: true, isolatedContext: true,
                model: 'gpt-5.6-terra', reasoningEffort: 'high', completedAt: 'TODO:+08:00'
            },
            editorialPlan: {
                version: 1,
                governingTension: {
                    conflict: 'TODO: 论文试图化解的可争辩技术矛盾',
                    sideA: 'TODO: 矛盾一端的需求与代价',
                    sideB: 'TODO: 另一端的需求与代价',
                    paperChoice: 'TODO: 论文把共享与分工分别放在哪里'
                },
                readerQuestions: [],
                evidencePillars: [],
                sectionPlan: []
            },
            centralQuestion: { question: 'TODO', whyItMatters: 'TODO', sourceQuote: 'TODO', readerQuote: 'TODO' },
            mustExplain: [], compress: [], omit: [], takeaways: [], derivedFacts: [],
            evidenceProfile: {
                version: 1, ablationStatus: 'none', targetEvaluation: 'not_applicable',
                sampleScaleReported: false, deploymentMeasured: false,
                publicGeneralizationEvaluated: false, evidenceBoundary: 'TODO'
            }
        },
        manualAudit: { version: 1, attempts: 2, passes: [], checks: {} },
        stageReviewAttemptsByStage: Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => [stage, 2])),
        stageReviews: {
            version: 2,
            stages: Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => [stage, placeholderStage(stage)]))
        },
        scoringCalibration: {
            version: 1, independentReview: true, reviewerTaskName: `paper-${paperId}-scoring`,
            model: 'gpt-5.6-terra', reasoningEffort: 'high',
            crossDimensionChecked: true, batchScaleChecked: true,
            calibrationNotes: 'TODO', evidenceIdsByDimension: {}
        },
        openSourceEvidence: { version: 1, state: 'none', urls: [], sourceQuotes: [] },
        readabilityRubric: {
            paperId, independentReview: true,
            reviewerTaskName: `paper-${paperId}-reader-review`,
            model: 'gpt-5.6-terra', reasoningEffort: 'high', dimensions: {}
        },
        selectedImageUrls: [], imageInsertions: [],
        figureReview: {
            version: 1,
            decisions: imageInfos.map((info, index) => ({
                url: info.url,
                decision: 'reject',
                reason: 'TODO: 逐像素审查后的论文特有选择或拒绝理由。',
                figureNumber: `TODO:${index + 1}`,
                captionIdentity: info.caption || info.alt || 'TODO caption identity'
            }))
        },
        editorial: {
            summary: 'TODO', method: 'TODO', innovations: 'TODO', results: 'TODO',
            details: 'TODO', limits: 'TODO', open: 'TODO', review: 'TODO'
        }
    };
    return {
        version: 3,
        mode: 'manual_analysis_records',
        date,
        agent: 'Codex',
        reviewProtocol: 'manual-v5-isolated-paper-review-v1',
        source: { fullTextPath: source.path, sourceSha256: source.sourceSha256, imageCount: imageInfos.length },
        papers: { [paperId]: record }
    };
}

function run(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const template = buildTemplate(args.date, args.paper);
    const output = path.resolve(args.output || path.join(
        Config.CURRENT_DIR, `manual-analysis-record-${args.date}-${args.paper}.json`
    ));
    writeFileAtomic(output, JSON.stringify(template, null, 2));
    console.log(`已生成单论文 Manual v5 records 模板: ${output}`);
    return { output, template };
}

if (require.main === module) {
    require('./env-loader.js').requireExternalRuntime('create-manual-record-template.js');
    try { run(); } catch (error) { console.error(`manual record template 失败: ${error.message}`); process.exitCode = 1; }
}

module.exports = { parseArgs, buildTemplate, run };
