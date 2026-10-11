'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const repair = require('../scripts/lib/reader-repair');
const deep = require('../scripts/deep-analyzer');

function createReaderDraft() {
    return {
        version: 3,
        readerTitle: '论文方法与实验的来源核对',
        oneSentenceThesis: '这篇论文只报告原文中可以核对的方法和实验。',
        sections: Array.from({ length: 12 }, (_, index) => ({
            kind: 'component', heading: `第 ${index + 1} 节`, body: '已有正文。'.repeat(30)
        })),
        conceptBridges: Array.from({ length: 4 }, (_, index) => ({
            terms: ['术语甲', '术语乙'], sectionKind: 'component',
            marker: `[[CONCEPT_BRIDGE_${index + 1}]]`, explanation: '已有解释。'.repeat(20)
        })),
        figurePlacements: [], tableBindings: [], formulaBindings: []
    };
}

function createRawDraft() {
    return JSON.stringify({ ...createReaderDraft(),
        sourceBindingsContract: 'api-reader-source-bindings-v4',
        sourceBindingsSha256: 'a'.repeat(64)
    }, null, 2);
}

function createDeletionPatch(context) {
    return { version: 1, rawSha256: context.rawSha256, deleteFields: [...context.deleteFields] };
}

test('只有模型明确删除两项程序元数据才生成八字段草稿，其他成员原始字节保留', () => {
    for (const placement of ['beginning', 'middle', 'end']) {
        const draft = createReaderDraft();
        const metadata = { sourceBindingsContract: 'api-reader-source-bindings-v4', sourceBindingsSha256: 'a'.repeat(64) };
        const entries = Object.entries(draft);
        entries.splice(placement === 'beginning' ? 0 : placement === 'middle' ? 4 : entries.length, 0, ...Object.entries(metadata));
        const raw = JSON.stringify(Object.fromEntries(entries), null, 2);
        const context = repair.buildTopLevelMetadataRepairContext(raw);
        assert.ok(context);
        assert.equal(repair.parseRecoveryDraft(raw), null);
        const result = repair.applyTopLevelMetadataRepair(raw, createDeletionPatch(context), context);
        assert.deepEqual(JSON.parse(result), draft);
        for (const [name, value] of Object.entries(draft)) {
            const memberBytes = `${JSON.stringify(name)}: ${JSON.stringify(value, null, 2).replace(/\n/g, '\n  ')}`;
            assert.ok(raw.includes(memberBytes), '测试成员必须能在原稿逐字定位');
            assert.ok(result.includes(memberBytes), '除删除成员外原始字节必须保留');
        }
    }
});

test('重复顶层键、缺必要字段、多余事实字段、错误元数据值和不完整JSON均不授权', () => {
    const raw = createRawDraft();
    const parsed = JSON.parse(raw);
    const invalidSamples = [
        raw.replace('"version": 3', '"version": 3, "version": 3'),
        raw.replace('"sourceBindingsContract":', '"sourceBindingsSha256": "a", "sourceBindingsContract":'),
        raw.slice(0, -1),
        JSON.stringify({ ...parsed, unknown: '不能丢弃的事实说明' }),
        JSON.stringify({ ...parsed, sourceBindingsContract: 'other-contract' }),
        JSON.stringify({ ...parsed, sourceBindingsSha256: 'fake' })
    ];
    delete parsed.sections;
    invalidSamples.push(JSON.stringify(parsed));
    for (const sample of invalidSamples) assert.equal(repair.buildTopLevelMetadataRepairContext(sample), null);
});

test('过期SHA、单字段删除、正文或嵌套删除和附加替换均拒绝，原稿不变', () => {
    const raw = createRawDraft();
    const context = repair.buildTopLevelMetadataRepairContext(raw);
    const valid = createDeletionPatch(context);
    const patches = [
        { ...valid, rawSha256: 'b'.repeat(64) },
        { ...valid, deleteFields: ['sourceBindingsContract'] },
        { ...valid, deleteFields: ['sections', 'sourceBindingsSha256'] },
        { ...valid, deleteFields: ['/sections/0/sourceBindingsContract', 'sourceBindingsSha256'] },
        { ...valid, replacements: [] }
    ];
    for (const patch of patches) assert.throws(() => repair.applyTopLevelMetadataRepair(raw, patch, context), /明确授权/);
    assert.equal(raw, createRawDraft());
});

test('正常恢复第二次请求只删两字段，仍执行完整检查且保留付费次数', async t => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-metadata-review-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourceText = '原文只用于离线核对，不提供未验证的新事实。';
    const artifacts = { parserVersion: 'unstructured-text-signals-v1', tables: [], formulas: [], figures: [],
        flattenedTextSha256: crypto.createHash('sha256').update(sourceText).digest('hex') };
    artifacts.payloadSha256 = deep.stableFingerprint(artifacts);
    const raw = createRawDraft();
    let requests = 0;
    await assert.rejects(deep.generateApiReaderArticleDetailed({ arxivId: '2610.99971', title: '离线元数据恢复' }, '', '', {
        sourceText, structuredArtifacts: artifacts, readerAttemptsDir: directory,
        readerMaterializeFigures: async () => [], readerRecordDisposition: () => {}, readerMaxAttempts: 2,
        readerCallModel: async (messages, budget, options) => {
            requests += 1;
            if (requests === 1) return raw;
            const prompt = messages[0].content[0].text;
            assert.match(prompt, /delete_top_level_program_metadata_v1/);
            assert.match(prompt, /不能改其他字段/);
            assert.equal(options.usageContext.stage, 'apiReaderRepair');
            return JSON.stringify(createDeletionPatch(repair.buildTopLevelMetadataRepairContext(raw)));
        }
    }), /读者文章|Reader/);
    assert.equal(requests, 2);
    const filename = fs.readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name));
    const envelope = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
    assert.equal(envelope.payload.attempts, 2);
    assert.equal(envelope.payload.fullAttempts, 1);
    assert.deepEqual(envelope.payload.draft.sections, createReaderDraft().sections);
    assert.ok(envelope.payload.issues.length > 0, '删除元数据不能跳过完整正文检查');
});


test('新版本的第一围栏 SHA 与迁移配对一致，旧局部修复原路径仍可复算', () => {
    const registry = require('../scripts/lib/prompt-text-versions');
    const promptPath = registry.currentTextStagePromptPath('apiReaderRepair');
    assert.equal(promptPath, 'prompts/api-reader-repair-v8.md');
    assert.equal(deep.runtimePromptTemplateSha256(promptPath), '9a7e72d75fdd05f7004c132533425fa140d237c22bc98a3c6c64333e5d76e22e');
    const oldPath = registry.promptFilePathForContract('apiReaderRepair', 'analysis-prompt-text-v7');
    assert.equal(oldPath, 'prompts/api-reader-repair-v7.md');
    assert.equal(deep.runtimePromptTemplateSha256(oldPath),
        'cdbf91f9bb2fb48e085c72195000059bdb2ccc4eb6a0bd47a6f31bb9d4835965');
});

test('错误删除授权消耗一次修复尝试但不替换原始草稿，不增加全篇次数', async t => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-metadata-stale-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourceText = '原文只用于离线核对，不提供未验证的新事实。';
    const artifacts = { parserVersion: 'unstructured-text-signals-v1', tables: [], formulas: [], figures: [],
        flattenedTextSha256: crypto.createHash('sha256').update(sourceText).digest('hex') };
    artifacts.payloadSha256 = deep.stableFingerprint(artifacts);
    const raw = createRawDraft();
    let requests = 0;
    await assert.rejects(deep.generateApiReaderArticleDetailed({ arxivId: '2610.99972', title: '错误授权离线回放' }, '', '', {
        sourceText, structuredArtifacts: artifacts, readerAttemptsDir: directory,
        readerMaterializeFigures: async () => [], readerRecordDisposition: () => {}, readerMaxAttempts: 2,
        readerCallModel: async () => {
            requests += 1;
            if (requests === 1) return raw;
            return JSON.stringify({ ...createDeletionPatch(repair.buildTopLevelMetadataRepairContext(raw)),
                rawSha256: 'b'.repeat(64) });
        }
    }), /明确授权/);
    assert.equal(requests, 2);
    const filename = fs.readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name));
    const envelope = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
    assert.equal(envelope.payload.draft, null);
    assert.equal(envelope.payload.rawDraft, raw);
    assert.equal(envelope.payload.attempts, 2);
    assert.equal(envelope.payload.fullAttempts, 1);
});
