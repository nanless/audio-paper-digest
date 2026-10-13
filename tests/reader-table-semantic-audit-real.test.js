'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const manifestPath = process.env.PD_TABLE_SEMANTIC_AUDIT_REAL_MANIFEST;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const utils = require('../scripts/utils');
utils.loadEnvFile = () => {};
process.env.PAPER_ANALYZER_MODEL = 'test-only-no-network';
process.env.PAPER_ANALYZER_ENDPOINT = 'https://example.invalid/v1';
utils.requestLlmJson = () => { throw new Error('真实来源离线回放禁止模型请求'); };
const Config = require('../scripts/config');
const audit = require('../scripts/lib/reader-table-semantic-audit');
const deep = require('../scripts/deep-analyzer');
const repair = require('../scripts/lib/reader-repair');
const engine = require('../scripts/analysis-engine');
test('真实错误表的独立诊断经来源核验后定位既有正文和表绑定，换引文仍拒', {
    skip: !manifestPath && '需显式提供真实文章快照与封存来源清单；不伪造真实回放通过'
}, async () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    Config.FILES.dailyFreshSourceRunsDir = path.join(manifest.sourceProject, 'data/runtime/daily-fresh-source-runs');
    for (const sample of manifest.samples) {
        const originalBytes = fs.readFileSync(sample.paperFile);
        const paper = JSON.parse(originalBytes);
        const feedback = JSON.parse(fs.readFileSync(sample.feedbackFile));
        const source = audit.sourceForPaper(paper);
        assert.equal(engine.hasValidApiReaderV3Records(paper), true);
        assert.equal(audit.canAuditSavedReader(paper), true);
        const context = audit.buildContext(paper, source);
        const issue = { statementQuote: feedback.rejectedReaderClaims[sample.claimIndex],
            sourceQuote: feedback.sourceQuotes[sample.quoteIndex], message: sample.message, correction: sample.correction };
        const response = { version: 1, inputSha256: context.inputSha256,
            tables: context.content.tables.map(table => ({ tableIndex: table.tableIndex,
                issues: table.tableIndex === sample.tableIndex ? [issue] : [] })) };
        const diagnosed = audit.compileResponse(response, context);
        assert.equal(diagnosed.issues.length, 1);
        const seed = deep.prepareApiReaderRevisionSeed(paper, source.text, sample.correction);
        const draft = require('../scripts/lib/signed-reader-recovery-draft').convert(seed);
        const targets = repair.buildRepairContext(draft, audit.issuesForDraft(draft, diagnosed.issues),
            source.text, source.text, { structuredArtifacts: source.structuredArtifacts }).targets;
        assert.ok(targets.some(target => target.path === `/tableBindings/${sample.tableIndex - 1}`));
        assert.ok(targets.some(target => target.path.startsWith('/sections/')));
        response.tables[sample.tableIndex - 1].issues[0].sourceQuote = '原文不存在的比较条件';
        assert.throws(() => audit.compileResponse(response, context));
        const usage = require('../scripts/lib/llm-usage');
        const oldWriter = usage.writeLlmUsageEvent; const simulatedReceipts = [];
        usage.writeLlmUsageEvent = event => simulatedReceipts.push(event);
        try {
            await audit.run(paper, source, { assertHardBindings(current) {
                assert.equal(engine.hasValidApiReaderV3Records(current), true);
            }, async save() {}, async callModel(messages, maxTokens, opts) {
                const current = audit.buildContext(paper, source);
                const raw = JSON.stringify({ version: 1, inputSha256: current.inputSha256,
                    tables: current.content.tables.map(table => ({ tableIndex: table.tableIndex, issues: [] })) });
                opts.usageSink(usage.buildLlmUsageEvent({ model: current.config.model, protocol: 'openai',
                    request: { messages }, response: { choices: [{ finish_reason: 'stop', message: { content: raw } }] },
                    statusCode: 200, outputText: raw, context: opts.usageContext }));
                return raw;
            } });
            // 成功响应是本地替代值，只验证真实保存格式的冷启动资格，不能据此宣称实际语义已正确。
            const cold = JSON.parse(JSON.stringify(paper));
            assert.equal(audit.hasValidProof(cold), true);
            assert.equal(engine.getIncompleteAnalysisContentReason(cold), null);
            cold.analysisManifest.stages.apiReaderTableAudit.records[0].responseSha256 = 'a'.repeat(64);
            assert.equal(audit.hasValidProof(cold), false);
            assert.equal(simulatedReceipts.length, 1);
        } finally { usage.writeLlmUsageEvent = oldWriter; }
        assert.equal(fs.readFileSync(sample.paperFile).equals(originalBytes), true);
    }
});
