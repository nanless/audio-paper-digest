const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    parseArgs,
    validateRecord,
    validateRecordsEnvelope,
    assertNoCrossPaperTemplateReuse,
    mergeRecordsEnvelopes,
    buildSpec
} = require('../scripts/create-manual-analysis-spec.js');
const {
    buildManifestContext,
    buildCompleteEntry
} = require('../scripts/manual-fetch-fulltext.js');

const DATE = '2026-08-25';
const ID = '2608.29999';
const REQUESTED_ID = `${ID}v1`;

function audit() {
    return {
        version: 1,
        attempts: 3,
        passes: [
            { status: 'revise', issues: ['初审发现实验条件和方法边界需要补充说明。'] },
            { status: 'revise', issues: ['二审重新核对评分、资源状态和局限范围。'] },
            { status: 'pass', issues: [] }
        ],
        checks: {
            sourceCoverage: true,
            promptConformance: true,
            factualClaimsLedger: true,
            scoreRecomputed: true,
            methodContract: true,
            tableContract: true,
            boilerplateScan: true,
            finalContract: true
        }
    };
}

function prose(prefix, count = 10) {
    return Array.from({ length: count }, (_, index) => (
        `${prefix}${index + 1}围绕输入表示、组件交互、训练条件、输出边界和评价口径展开，`
        + `该段只描述本篇论文在对应章节给出的具体机制与限制，并区分数据条件和结论范围。`
    )).join('');
}

function methodProse() {
    return [
        prose('方法第一阶段', 5),
        prose('方法第二阶段', 5),
        prose('方法第三阶段', 5)
    ].join('\n\n');
}

function validRecord() {
    const quotes = sourceText().split('\n');
    return {
        arxivId: ID,
        type: '方法研究',
        task: '#语音识别',
        tags: '#语音识别 #Transformer #鲁棒性',
        dims: [1.5, 1.2, 1.1, 0.8, 1.0, 0, 0.3, 1.0],
        authorInfo: {
            firstAuthorAffiliation: '测试大学语音实验室',
            correspondingAuthors: 'Test Author',
            affiliations: '测试大学语音实验室',
            sourceQuote: sourceText().split('\n')[0]
        },
        question: '论文研究复杂噪声条件下如何保持语音识别的上下文建模稳定性和输出可靠性。',
        method: prose('人工记录方法主干', 2),
        method2: prose('人工记录训练流程', 2),
        method3: prose('人工记录推理取舍', 2),
        innovations: prose('人工记录创新机制', 2),
        results: '实验分别报告 WER 12.4、10.8 和 9.7，并在相同数据划分和解码预算下比较主方法、基线与消融。' + prose('人工记录结果条件', 2),
        details: prose('人工记录复现细节', 2),
        limits: prose('人工记录适用局限', 2),
        open: '论文正文没有给出可公开访问的代码、模型权重、训练数据或演示仓库地址，资源可得性因此保持未说明。',
        review: '论文把语音识别的模块关系和评价口径交代得较完整，但跨设备测试、部署成本与失败样本覆盖仍不足。',
        scoringReasons: Array.from({ length: 8 }, (_, index) => (
            `第${index + 1}维依据对应的方法、实验、资源或部署证据独立评分，并按照该维度上限保留未验证边界。`
        )),
        evidenceLedger: [
            ['E01', '核心摘要', '论文围绕语音识别架构、训练输入与受控评测展开。', quotes[0]],
            ['E02', '方法概述和架构', '方法证据明确覆盖架构组件、训练输入和模块关系。', quotes[1]],
            ['E03', '实验结果', '实验证据记录了受控划分中的两项测量结果。', quotes[2]],
            ['E04', '实验结果', '消融证据与主实验使用同一评价条件和数据划分。', quotes[3]],
            ['E05', '局限与问题', '来源段落明确记录实现条件和适用范围限制。', quotes[4]],
            ['E06', '开源详情', '来源段落包含代码、模型、数据和演示资源的可得性声明供人工逐项核对。', quotes[5]]
        ].map(([id, section, claim, sourceQuote]) => ({ id, section, claim, sourceQuote })),
        manualAudit: audit(),
        editorial: {
            summary: prose('摘要专属事实', 8),
            method: methodProse(),
            innovations: prose('创新专属机制', 9),
            results: '结果专属指标包含 WER 12.4、10.8 与 9.7，数值越低表示识别错误越少。' + prose('结果专属比较', 8),
            details: prose('细节专属配置', 10),
            limits: prose('局限专属边界', 6),
            open: prose('资源专属核验', 2),
            review: '方法的层级关系清楚，实验也给出可比较的错误率；真正薄弱之处是跨设备迁移和线上资源开销仍缺少直接测量。'
        }
    };
}

function sourceText() {
    return Array.from({ length: 8 }, (_, index) => (
        `Experiment section ${index + 1} describes the speech recognition architecture, training inputs, evaluation results, `
        + `and ablation evidence with measured values ${10 + index}.1 and ${9 + index}.2 under a controlled split. `
        + `The paragraph also records limitations, implementation conditions, and the reported resource availability statement.`
    )).join('\n');
}

function envelope(papers = { [ID]: validRecord() }, overrides = {}) {
    return {
        version: 1,
        mode: 'manual_analysis_records',
        date: DATE,
        agent: 'Codex',
        reviewProtocol: 'manual-full-text-three-pass-v1',
        papers,
        ...overrides
    };
}

function distinctRecord(id, marker) {
    const record = JSON.parse(JSON.stringify(validRecord()));
    record.arxivId = id;
    for (const [field, value] of Object.entries(record.editorial)) {
        record.editorial[field] = value.replace(/[。！？]/g, punctuation => `${marker}${punctuation}`);
    }
    record.scoringReasons = record.scoringReasons.map(reason => `${reason}${marker}`);
    return record;
}

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-spec-v2-'));
    const outDir = path.join(root, 'manual-full-text', DATE);
    fs.mkdirSync(outDir, { recursive: true });
    const paper = {
        arxivId: REQUESTED_ID,
        title: 'Strict manual spec fixture',
        authors: ['Test Author'],
        categories: ['cs.SD'],
        abstract: 'A speech recognition fixture.'
    };
    const filtered = { version: 1, batchDate: DATE, status: 'complete', papers: [paper] };
    const context = buildManifestContext(filtered, DATE, outDir);
    const input = context.inputs[0];
    const text = sourceText();
    fs.writeFileSync(input.filePath, text);
    const entry = buildCompleteEntry(input, {
        source: 'html',
        sourceId: REQUESTED_ID,
        text,
        warnings: [],
        imageInfos: [{
            url: `https://arxiv.org/html/${REQUESTED_ID}/figure1.png`,
            caption: 'Figure 1: architecture',
            alt: 'Architecture',
            source: 'arxiv_html'
        }]
    }, fs.readFileSync(input.filePath));
    const manifest = {
        version: 2,
        mode: 'manual_full_text_fetch',
        date: DATE,
        status: 'complete',
        filteredBatchSha256: context.filteredBatchSha256,
        filteredPapersSha256: context.filteredBatchSha256,
        expectedPaperInputs: context.expectedPaperInputs,
        count: 1,
        failed: 0,
        completedAt: '2026-08-25T12:00:00.000+08:00',
        papers: { [ID]: entry }
    };
    const manifestPath = path.join(outDir, 'manifest.json');
    writeJson(manifestPath, manifest);
    const recordsPath = path.join(root, 'records.json');
    writeJson(recordsPath, envelope());
    const mergedRecords = mergeRecordsEnvelopes([
        { path: recordsPath, document: envelope() }
    ], DATE);
    return { root, filtered, manifest, manifestPath, recordsPath, mergedRecords, input, entry };
}

describe('strict reusable manual v2 spec assembler', () => {
    it('parses repeated --records and rejects unknown flags', () => {
        assert.deepEqual(parseArgs([
            '--date', DATE,
            '--records', 'part-a.json',
            '--records', 'part-b.json'
        ]), { date: DATE, records: ['part-a.json', 'part-b.json'] });
        assert.throws(() => parseArgs(['--date', DATE, '--records', 'a.json', '--output', 'x']), /未知参数/);
        assert.throws(() => parseArgs(['--date', DATE]), /至少指定一个/);
    });

    it('validates records fields, eight dimensions, and actual audit passes', () => {
        const record = validateRecord(validRecord(), ID);
        assert.equal(record.dims.length, 8);
        assert.equal(record.stageReviewAttemptsByStage.primaryAnalysis, 3);
        const structuredAuthors = validRecord();
        structuredAuthors.authorInfo.correspondingAuthors = ['Test Author'];
        structuredAuthors.authorInfo.affiliations = ['测试大学', '测试研究院'];
        assert.equal(validateRecord(structuredAuthors, ID).authorInfo.affiliations, '测试大学；测试研究院');
        const invalidScore = validRecord();
        invalidScore.dims[5] = 0.7;
        assert.throws(() => validateRecord(invalidScore, ID), /开源评分/);
        const unboundOpenSource = validRecord();
        unboundOpenSource.dims[5] = 1.2;
        assert.throws(() => validateRecord(unboundOpenSource, ID), /至少一项已开放资源/);
        unboundOpenSource.hasCode = '是';
        assert.equal(validateRecord(unboundOpenSource, ID).hasCode, '是');
        const theoreticalOpenSource = validRecord();
        theoreticalOpenSource.type = '理论研究';
        theoreticalOpenSource.dims[5] = 1.5;
        assert.equal(validateRecord(theoreticalOpenSource, ID).dims[5], 1.5);
        const missingAuthorInfo = validRecord();
        delete missingAuthorInfo.authorInfo;
        assert.throws(() => validateRecord(missingAuthorInfo, ID), /authorInfo 必须是对象/);
        const missingAuthorQuote = validRecord();
        delete missingAuthorQuote.authorInfo.sourceQuote;
        assert.throws(() => validateRecord(missingAuthorQuote, ID), /authorInfo\.sourceQuote/);
        const invalidTags = validRecord();
        invalidTags.tags = '#语音识别 #Transformer #自造标签';
        assert.throws(() => validateRecord(invalidTags, ID), /非白名单标签/);
        const invalidAudit = validRecord();
        invalidAudit.manualAudit.attempts = 2;
        assert.throws(() => validateRecord(invalidAudit, ID), /实际 passes/);
        const missingLedger = validRecord();
        delete missingLedger.evidenceLedger;
        assert.throws(() => validateRecord(missingLedger, ID), /evidenceLedger 必须由人工显式提供/);
    });

    it('rejects duplicate papers across shards and cross-date envelopes', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-record-shards-'));
        const first = path.join(root, 'first.json');
        const second = path.join(root, 'second.json');
        writeJson(first, envelope());
        writeJson(second, envelope());
        assert.throws(() => mergeRecordsEnvelopes([
            { path: first, document: envelope() },
            { path: second, document: envelope() }
        ], DATE), /重复提供论文/);
        assert.throws(() => validateRecordsEnvelope(
            envelope(undefined, { date: '2026-08-24' }),
            first,
            DATE
        ), /date 与 --date 不一致/);
    });

    it('rejects a normalized long editorial sentence reused by three papers', () => {
        const shared = '该段统一声称模型依次完成输入编码、跨层交互、目标解码和受控评测，却没有写出任何属于单篇论文的组件名称、数据条件或测量结果';
        const papers = {};
        ['2608.29991', '2608.29992', '2608.29993'].forEach((id, index) => {
            const record = distinctRecord(id, `论文${index + 1}`);
            record.editorial.summary = `${shared}。${record.editorial.summary}`;
            papers[id] = record;
        });
        assert.throws(
            () => assertNoCrossPaperTemplateReuse(papers),
            error => /跨论文模板复用/.test(error.message)
                && /editorial\.summary/.test(error.message)
                && /2608\.29991,2608\.29992,2608\.29993/.test(error.message)
                && error.message.includes(shared.slice(0, 24))
        );
    });

    it('rejects one complete scoring reason reused by three papers', () => {
        const shared = '该维评分完全沿用固定模板，只罗列方法、实验、资源和部署四类名词，没有引用本篇论文的具体证据。';
        const papers = {};
        ['2608.29981', '2608.29982', '2608.29983'].forEach((id, index) => {
            const record = distinctRecord(id, `评分论文${index + 1}`);
            record.scoringReasons[index] = shared;
            papers[id] = record;
        });
        assert.throws(
            () => assertNoCrossPaperTemplateReuse(papers),
            error => /完整 scoringReason/.test(error.message)
                && /2608\.29981,2608\.29982,2608\.29983/.test(error.message)
                && /scoringReasons\[0\],scoringReasons\[1\],scoringReasons\[2\]/.test(error.message)
        );
    });

    it('allows two-paper reuse, short terms, and similar but paper-specific facts', () => {
        const papers = {};
        ['2608.29971', '2608.29972', '2608.29973'].forEach((id, index) => {
            const record = distinctRecord(id, `事实论文${index + 1}`);
            record.editorial.method = [
                index < 2 ? '这是一条足够长但只在两篇论文出现的共同方法描述，它详细覆盖编码、交互、解码、训练条件、推理路径和输出边界。' : '',
                'Transformer。',
                `论文 ${id} 在测试集报告 WER ${(9.1 + index).toFixed(1)}，并使用独立的语料划分、解码预算和消融配置核对该结果。`,
                record.editorial.method
            ].filter(Boolean).join('\n');
            papers[id] = record;
        });
        assert.doesNotThrow(() => assertNoCrossPaperTemplateReuse(papers));
    });

    it('binds the exact fingerprinted v2 full-text path and manifest images', () => {
        const f = fixture();
        const spec = buildSpec({
            date: DATE,
            filtered: f.filtered,
            manifest: f.manifest,
            manifestPath: f.manifestPath,
            mergedRecords: f.mergedRecords,
            generatedAt: '2026-08-25T12:30:00.000+08:00'
        });
        assert.equal(spec.version, 2);
        assert.equal(spec.mode, 'manual_complete');
        assert.equal(spec.filteredBatchSha256, f.entry.filteredBatchSha256);
        assert.equal(spec.papers[ID].fullTextPath, f.input.filePath);
        assert.equal(spec.papers[ID].sourceSha256, f.entry.sourceSha256);
        assert.deepEqual(spec.papers[ID].imageInfos, f.entry.imageInfos);
        assert.equal(spec.papers[ID].manualAudit.attempts, 3);
        assert.equal(Object.keys(spec.stagePromptSha256).length, 10);

        const titleRecord = validRecord();
        titleRecord.titleOverride = 'Strictmanual spec fixture';
        const titlePath = path.join(f.root, 'title-records.json');
        const titleEnvelope = envelope({ [ID]: titleRecord });
        writeJson(titlePath, titleEnvelope);
        const titleSpec = buildSpec({
            date: DATE,
            filtered: f.filtered,
            manifest: f.manifest,
            manifestPath: f.manifestPath,
            mergedRecords: mergeRecordsEnvelopes([{ path: titlePath, document: titleEnvelope }], DATE),
            generatedAt: '2026-08-25T12:30:00.000+08:00'
        });
        assert.equal(titleSpec.papers[ID].titleOverride, 'Strictmanual spec fixture');

        const invalidTitleRecord = validRecord();
        invalidTitleRecord.titleOverride = 'Different paper title';
        const invalidTitlePath = path.join(f.root, 'invalid-title-records.json');
        const invalidTitleEnvelope = envelope({ [ID]: invalidTitleRecord });
        writeJson(invalidTitlePath, invalidTitleEnvelope);
        assert.throws(() => buildSpec({
            date: DATE,
            filtered: f.filtered,
            manifest: f.manifest,
            manifestPath: f.manifestPath,
            mergedRecords: mergeRecordsEnvelopes([{ path: invalidTitlePath, document: invalidTitleEnvelope }], DATE)
        }), /仅允许修复标题空白/);

        const invalidAuthorRecord = validRecord();
        invalidAuthorRecord.authorInfo.sourceQuote = 'This author block does not exist in the source.';
        const invalidAuthorPath = path.join(f.root, 'invalid-author-records.json');
        const invalidAuthorEnvelope = envelope({ [ID]: invalidAuthorRecord });
        writeJson(invalidAuthorPath, invalidAuthorEnvelope);
        assert.throws(() => buildSpec({
            date: DATE,
            filtered: f.filtered,
            manifest: f.manifest,
            manifestPath: f.manifestPath,
            mergedRecords: mergeRecordsEnvelopes([{ path: invalidAuthorPath, document: invalidAuthorEnvelope }], DATE)
        }), /authorInfo\.sourceQuote 不存在/);
    });

    it('rejects missing records, manifest v1, source tampering, and filtered batch drift', () => {
        const f = fixture();
        assert.throws(() => buildSpec({
            date: DATE,
            filtered: f.filtered,
            manifest: f.manifest,
            manifestPath: f.manifestPath,
            mergedRecords: { ...f.mergedRecords, papers: {} }
        }), /records 论文集合不一致/);

        const legacy = { ...f.manifest, version: 1 };
        writeJson(f.manifestPath, legacy);
        assert.throws(() => buildSpec({
            date: DATE,
            filtered: f.filtered,
            manifest: legacy,
            manifestPath: f.manifestPath,
            mergedRecords: f.mergedRecords
        }), /完整 v2 批次/);
        writeJson(f.manifestPath, f.manifest);

        fs.appendFileSync(f.input.filePath, 'tampered');
        assert.throws(() => buildSpec({
            date: DATE,
            filtered: f.filtered,
            manifest: f.manifest,
            manifestPath: f.manifestPath,
            mergedRecords: f.mergedRecords
        }), /内容指纹无效/);

        const drift = fixture();
        const changedFiltered = { ...drift.filtered, extraMetadata: 'changed' };
        assert.throws(() => buildSpec({
            date: DATE,
            filtered: changedFiltered,
            manifest: drift.manifest,
            manifestPath: drift.manifestPath,
            mergedRecords: drift.mergedRecords
        }), /filtered 完整批次指纹不一致/);
    });
});
