'use strict';
const assert = require('node:assert/strict');
const facts = require('../../scripts/lib/daily-fact-review');
const engine = require('../../scripts/analysis-engine');

// 成功样例也走真实审校解析及回执核验；模型响应只由本地替代器生成。
let pending = Promise.resolve();
function attachValidReaderTableAudit(paper, source, bound = null) {
    const result = pending.then(() => attachValidReaderTableAuditInternal(paper, source, bound));
    pending = result.catch(() => {});
    return result;
}
async function attachValidReaderTableAuditInternal(paper, source, bound) {
    const fs = require('node:fs');
    const path = require('node:path');
    const Config = require('../../scripts/config');
    const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'local-audit-usage-'));
    const previousUsage = Config.FILES.llmUsageDir;
    Config.FILES.llmUsageDir = directory;
    const audit = require('../../scripts/lib/reader-table-semantic-audit');
    const usage = require('../../scripts/lib/llm-usage');
    const run = () => audit.run(paper, source, {
        modelConfiguration: { model: 'local-audit-test', endpoint: 'https://example.invalid/v1' },
        assertHardBindings(current) { assert.equal(engine.hasValidApiReaderV3Records(current), true); },
        save: async () => {},
        callModel: async (messages, _maxTokens, options) => {
            const marker = '待审输入：';
            const text = messages[0].content;
            const input = JSON.parse(text.slice(text.indexOf(marker) + marker.length).trim());
            assert.equal(options.usageContext.stage, audit.STAGE);
            assert.equal(options.usageContext.unitId, input.inputSha256);
            const raw = JSON.stringify({ version: 1, inputSha256: input.inputSha256,
                tables: input.tables.map(table => ({ tableIndex: table.tableIndex, issues: [] })) });
            options.usageSink(usage.buildLlmUsageEvent({ model: 'local-audit-test', protocol: 'openai',
                request: { messages }, response: { choices: [{ message: { content: raw } }] },
                statusCode: 200, outputText: raw, context: options.usageContext }));
            return raw;
        }
    });
    try { return await (bound ? facts.withFactReview(bound, run) : run()); }
    finally {
        Config.FILES.llmUsageDir = previousUsage;
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

module.exports = { attachValidReaderTableAudit };
