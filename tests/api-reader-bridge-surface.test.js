const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
    collapseRepeatedReaderBridgeHeadings,
    repairApiReaderArticleAndPlanBindings,
    stableFingerprint,
    buildApiReaderQualityMetrics,
    restoreApiReaderInjectionMarkers,
    normalizeReaderConceptBridgeTerms,
    normalizeReaderProsePreservingSelectedTables,
    normalizeReaderProseFormatting,
    restoreReaderSelectedTableBytes,
    normalizeReaderWorkflowLeakageSurface,
    normalizeReaderFigureMetricUnits,
    repairReportedTextSpacing,
    normalizeReaderBridgeTerm,
    findReaderBridgeParagraph
} = require('../scripts/deep-analyzer.js');
const { hasValidApiReaderV3Records } = require('../scripts/analysis-engine.js');
const { validateEditorialQuality } = require('../scripts/editorial-quality.js');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const heading = '**声学先验 × 测试时适应：**';
const explanation = ' 声学先验负责描述干净语音，测试时适应负责更新当前输入的增强模型，两者共同指导增强过程。';

test('只有精确且连续出现在段首的桥接标题会合并，多份副本也一样', () => {
    for (const count of [2, 3, 5]) {
        const raw = Array(count).fill(heading).join(' ') + explanation;
        const once = collapseRepeatedReaderBridgeHeadings(raw);
        assert.equal(once, heading + explanation);
        assert.equal(collapseRepeatedReaderBridgeHeadings(once), once);
    }
    assert.equal(collapseRepeatedReaderBridgeHeadings(heading + '\n' + heading + explanation), heading + explanation);
});

test('只修复已确认的单字熵术语，Reader 事实保持不变', () => {
    const candidate = { sections: [{ body: '指标包括问题熵与 APES。' }], conceptBridges: [
        { terms: ['熵', 'APES'], explanation: '熵负责描述分布。' }
    ] };
    assert.equal(normalizeReaderConceptBridgeTerms(candidate), true);
    assert.deepEqual(candidate.conceptBridges[0].terms, ['问题熵', 'APES']);
    assert.equal(candidate.conceptBridges[0].explanation, '问题熵负责描述分布。');
    assert.equal(normalizeReaderConceptBridgeTerms(candidate), false);
    for (const raw of [
        '该图后解释需要强调辨别好不等于自发可用。',
        '图后解释必须与图前导读形成闭环且只描述本次实际收到的像素。',
        '根据当前 prompt 要求改写。'
    ]) {
        assert.equal(normalizeReaderWorkflowLeakageSurface(raw), raw);
    }
    for (const raw of [
        '该图像素显示准确率与一致率分别为 20 和 36.5。',
        '纵轴为准确率 20 到 80。',
        '图中有两条曲线，数值为 20%。'
    ]) {
        assert.equal(normalizeReaderFigureMetricUnits(raw), raw);
    }
});

test('只去掉已知的桥接字段尾部泄漏，其它数组仍做严格术语校验', () => {
    const candidate = { sections: [{ body: '音素识别、音位与 component 都在正文出现。' }], conceptBridges: [
        { terms: ['音素识别', '音位', 'sectionKind', 'component'], explanation: '术语组合说明。' }
    ] };
    assert.equal(normalizeReaderConceptBridgeTerms(candidate), true);
    assert.deepEqual(candidate.conceptBridges[0].terms, ['音素识别', '音位']);

    const unrelated = { sections: [{ body: '真实术语出现在正文。' }], conceptBridges: [
        { terms: ['真实术语', '另一个术语', '第三个术语'], explanation: '术语组合说明。' }
    ] };
    assert.equal(normalizeReaderConceptBridgeTerms(unrelated), false);
    assert.equal(unrelated.conceptBridges[0].terms.length, 3);
});

test('只有前缀在文章里可见时，才修复重复的桥接术语后缀', () => {
    const candidate = {
        sections: [{ body: '本文比较声音事件定位与检测和六自由度，并说明两者如何协同。' }],
        conceptBridges: [{
            terms: ['声音事件定位与检测', '六自由度声音事件定位与检测'],
            explanation: '六自由度声音事件定位与检测负责描述运动听者。'
        }]
    };
    assert.equal(normalizeReaderConceptBridgeTerms(candidate), true);
    assert.deepEqual(candidate.conceptBridges[0].terms, ['声音事件定位与检测', '六自由度']);
    assert.equal(candidate.conceptBridges[0].explanation, '六自由度负责描述运动听者。');

    const unrelated = {
        sections: [{ body: '本文只出现了声音事件定位与检测。' }],
        conceptBridges: [{
            terms: ['声音事件定位与检测', '六自由度声音事件定位与检测'],
            explanation: '重复词组不应在正文缺少前缀时被猜测修复。'
        }]
    };
    assert.equal(normalizeReaderConceptBridgeTerms(unrelated), false);
    assert.deepEqual(unrelated.conceptBridges[0].terms, [
        '声音事件定位与检测', '六自由度声音事件定位与检测'
    ]);
});

test('中文数字排版做有限归一化之后重新绑定桥接', () => {
    const cases = [
        ['叠加论', '三模态叠加显示', '**叠加论 × 3 模态叠加显示：** 两者分别描述组合视角与显示方式。'],
        ['无线标记', '六自由度头部位姿', '**无线标记 × 6 自由度头部位姿：** 两者分别提供标记信息与姿态信息。'],
        ['十折交叉验证', '置换检验', '**10 折交叉验证 × 置换检验：** 两者分别用于稳定评估与检验结果可靠性。']
    ];
    for (const [left, right, paragraph] of cases) {
        assert.equal(normalizeReaderBridgeTerm(left), normalizeReaderBridgeTerm(
            paragraph.match(/\*\*(.+?)：\*\*/u)[1].split(' × ')[0]
        ));
        assert.equal(
            findReaderBridgeParagraph([paragraph], [left, right]),
            paragraph,
            `${left} × ${right} 应只容忍确定性的数字/空格表面变化`
        );
    }
    assert.equal(
        findReaderBridgeParagraph([
            '**叠加论 × 3 模态叠加显示：** 一处说明。',
            '**叠加论 × 3 模态叠加显示：** 另一处说明。'
        ], ['叠加论', '三模态叠加显示']),
        null,
        '重复桥段不能因容错而产生歧义绑定'
    );
});

test('修复两个方向的汉字/ASCII 问题，不动引号、围栏和已选表格', () => {
    const table = [
        '| 方法 | 说明 |',
        '| --- | --- |',
        '| A | Conformer编码器 |'
    ].join('\n');
    const candidate = {
        sections: [{ body: [
            '普通段包含 Conformer编码器，也包含 编码器Conformer。',
            '普通段还包含 bellplay~环境 与 rtcmix~数据。',
            '> 原文引用 Conformer编码器。',
            '```text',
            'Conformer编码器',
            '```',
            table
        ].join('\n') }],
        tableBindings: [{ tableIndex: 1, selection: {} }],
        conceptBridges: [{ explanation: '桥段说明 Conformer编码器 与 编码器Conformer。' }]
    };
    const changed = repairReportedTextSpacing(candidate, [
        { code: 'technical_term_adhesion', match: 'Conformer编码器' },
        { message: 'technical_term_adhesion:编码器Conformer；technical_term_adhesion:bellplay环；technical_term_adhesion:rtcmix数' }
    ]);
    assert.equal(changed, true);
    assert.match(candidate.sections[0].body, /Conformer 编码器，也包含 编码器 Conformer/u);
    assert.match(candidate.sections[0].body, /bellplay~ 环境 与 rtcmix~ 数据/u);
    assert.match(candidate.conceptBridges[0].explanation, /Conformer 编码器 与 编码器 Conformer/u);
    assert.match(candidate.sections[0].body, /> 原文引用 Conformer编码器。/u);
    assert.match(candidate.sections[0].body, /```text\nConformer编码器\n```/u);
    assert.match(candidate.sections[0].body, /\| A \| Conformer编码器 \|/u);
});

test('进入编辑检查之前，归一化带波浪号的拉丁名', () => {
    assert.equal(
        normalizeReaderProseFormatting('运行 bellplay~环境 与 rtcmix~数据。'),
        '运行 bellplay~ 环境 与 rtcmix~ 数据。'
    );
});

test('归一化周边 Reader 正文时，PDF 单元格字节保持原样', () => {
    const table = '| Model | 0-12kHz | 12-18kHz |\n| --- | --- | --- |\n| Ours | 1.24 | 1.39 |';
    const article = `量化结果应保留来源表格。\n\n${table}\n\n表后解释保留比较方向。`;
    const normalized = normalizeReaderProsePreservingSelectedTables(article, [1]);
    assert.ok(normalized.includes('| Model | 0-12kHz | 12-18kHz |'));
    assert.ok(!normalized.includes('0-12 kHz'));
    assert.ok(normalized.includes('量化结果应保留来源表格。'));
});

test('后续清理跑完之后，重新核对选中的产物表格单元格', () => {
    const domSha = 'a'.repeat(64);
    const table = {
        ordinal: 8, recoveryStatus: 'complete', cells: [
            { row: 0, column: 0, text: 'Model', sourceDomSha256: domSha },
            { row: 0, column: 1, text: '0-12kHz', sourceDomSha256: domSha },
            { row: 1, column: 0, text: 'Ours', sourceDomSha256: domSha },
            { row: 1, column: 1, text: '1.24', sourceDomSha256: domSha }
        ]
    };
    const binding = {
        tableIndex: 1, sourceType: 'artifact_table', sourceTableOrdinal: 8,
        cellBindings: [
            { renderedRow: 0, renderedColumn: 0, sourceRow: 0, sourceColumn: 0 },
            { renderedRow: 0, renderedColumn: 1, sourceRow: 0, sourceColumn: 1 },
            { renderedRow: 1, renderedColumn: 0, sourceRow: 1, sourceColumn: 0 },
            { renderedRow: 1, renderedColumn: 1, sourceRow: 1, sourceColumn: 1 }
        ], sourceQuotes: []
    };
    const article = '| Model | 0-12 kHz |\n| --- | --- |\n| Ours | 1.24 |';
    const restored = restoreReaderSelectedTableBytes(article, [binding], { tables: [table] });
    assert.equal(restored, '| Model | 0-12kHz |\n| --- | --- |\n| Ours | 1.24 |');
});

test('不同的标题、行内引文、独立段落、表格和围栏示例都不变', () => {
    for (const raw of [
        heading + ' **声学先验 × 监督训练：**' + explanation,
        '**声学先验×测试时适应：** ' + heading + explanation,
        '正文引用 ' + heading + ' ' + heading + explanation,
        heading + explanation + ' 文中再次引用 ' + heading,
        heading + '\n\n' + heading + explanation,
        '| 项目 | 解释 |\n| --- | --- |\n| 例子 | ' + heading + ' ' + heading + ' |',
        '```markdown\n\n' + heading + ' ' + heading + '\n\n```',
        '~~~text\n' + heading + ' ' + heading + '\n~~~'
    ]) assert.equal(collapseRepeatedReaderBridgeHeadings(raw), raw);
});

function signedFixture() {
    const sourceSha256 = '1'.repeat(64);
    const bridge = { terms: ['声学先验', '测试时适应'], sectionKind: 'component',
        marker: '[[CONCEPT_BRIDGE_1]]', explanation: heading + ' ' + heading + explanation };
    const article = '### 两个组件如何共同工作\n\n' + bridge.explanation;
    const plan = { version: 3, contract: 'beginner-researcher-v3',
        readerTitle: '两个组件如何共同工作', oneSentenceThesis: '解释已有机制。',
        sections: [{ kind: 'component', heading: '两个组件如何共同工作' }],
        conceptBridges: [bridge], figurePlacements: [], tableBindings: [], formulaBindings: [],
        sourceBindingsContract: 'api-reader-source-bindings-v4',
        sourceBindingsSha256: stableFingerprint({ tableBindings: [], formulaBindings: [] }) };
    const paperAuthors = ['Author One'];
    const metadataSha256 = stableFingerprint(paperAuthors);
    const renderedAuthor = { name: 'Author One', affiliations: ['机构信息未可靠披露'] };
    const identityAuthor = { ...renderedAuthor,
        nameBinding: { sourceKind: 'paper_metadata', sourceValue: 'Author One', metadataSha256 },
        affiliationBindings: [{ sourceKind: 'explicit_unavailable', sourceValue: '机构信息未可靠披露',
            sourceTextSha256: sourceSha256 }] };
    const identity = { contract: 'api-reader-author-identity-v1', sourceTextSha256: sourceSha256,
        metadataSha256, authors: [identityAuthor] };
    const authors = { authors: [renderedAuthor], identity, identitySha256: stableFingerprint(identity) };
    const resourceBody = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sourceSha256, resources: [] };
    const resources = { ...resourceBody, identitySha256: stableFingerprint(resourceBody) };
    const paper = { arxivId: '2609.03622', authors: paperAuthors, sourceSha256,
        apiReaderArticle: article, apiReaderPlan: plan, apiReaderFigures: [],
        apiReaderAuthors: authors, apiReaderResources: resources,
        apiReaderArticleSha256: sha(article), apiReaderPlanSha256: stableFingerprint(plan),
        analysisManifest: {
            sourceAcquisition: { sourceSha256, structuredArtifactsSha256: '2'.repeat(64) },
            contracts: { apiReaderArticle: plan.contract, apiReaderSourceBindings: plan.sourceBindingsContract,
                apiReaderAuthorIdentity: identity.contract, apiReaderResourceIdentity: resources.contract },
            stages: { openSourceScan: { resourceEvidenceContract: resources.contract,
                resourceEvidenceSha256: resources.identitySha256 }, apiReaderArticle: {
                status: 'complete', fingerprint: '3'.repeat(64), attempts: 2, model: 'signed-model',
                protocol: 'openai_responses', temperature: 0.1,
                articleSha256: sha(article), planSha256: stableFingerprint(plan),
                figureCount: 0, figuresSha256: stableFingerprint([]),
                readerAuthorsSha256: stableFingerprint(authors), readerAuthorIdentityContractVersion: identity.contract,
                readerAuthorIdentitySha256: authors.identitySha256,
                resourceIdentityContractVersion: resources.contract, resourceIdentitySha256: resources.identitySha256,
                resourceCount: 0, parserVersion: 'api-reader-parser-v3', assemblerVersion: 'api-reader-assembler-v3',
                tableContractVersion: 'api-reader-tables-v3', figureContractVersion: 'api-reader-figures-v3',
                qualityMetricsContractVersion: 'api-reader-quality-metrics-v2',
                qualityMetrics: { contract: 'api-reader-quality-metrics-v2', blockingIssueCount: 0, rawIssueCount: 999 },
                sourceBindingsContractVersion: plan.sourceBindingsContract, sourceBindingsSha256: plan.sourceBindingsSha256,
                sourceBindingsSourceTextSha256: sourceSha256, tableBindingCount: 0, formulaBindingCount: 0,
                structuredArtifactsSha256: '2'.repeat(64)
            } }
        } };
    assert.equal(hasValidApiReaderV3Records(paper), true);
    return paper;
}

test('内容修复保留生产绑定，按实际字节和指标重新记录，但不声称跑过新的 LLM', () => {
    const paper = signedFixture();
    const before = structuredClone(paper);
    const stage = paper.analysisManifest.stages.apiReaderArticle;
    assert.equal(repairApiReaderArticleAndPlanBindings(paper, paper.analysisManifest), true);
    assert.equal(paper.apiReaderArticle, before.apiReaderArticle.replace(heading + ' ' + heading, heading));
    assert.equal(paper.apiReaderPlan.conceptBridges[0].explanation, heading + explanation);
    assert.equal(paper.apiReaderArticleSha256, sha(paper.apiReaderArticle));
    assert.equal(paper.apiReaderPlanSha256, stableFingerprint(paper.apiReaderPlan));
    assert.equal(hasValidApiReaderV3Records(paper), true);
    assert.equal(stage.surfaceRepairVersion, 'api-reader-surface-repair-v2');
    assert.equal(stage.surfaceRepair.executionKind, 'deterministic_surface_repair');
    assert.equal(stage.surfaceRepair.inputArticleSha256, before.apiReaderArticleSha256);
    assert.equal(stage.surfaceRepair.outputArticleSha256, paper.apiReaderArticleSha256);
    assert.equal(stage.surfaceRepair.inputPlanSha256, before.apiReaderPlanSha256);
    assert.equal(stage.surfaceRepair.outputPlanSha256, paper.apiReaderPlanSha256);
    assert.deepEqual(stage.qualityMetrics, buildApiReaderQualityMetrics(validateEditorialQuality({
        summary: '', method: paper.apiReaderArticle, innovations: '', results: '', details: '', limits: ''
    }), paper.apiReaderArticle));
    for (const key of ['fingerprint', 'attempts', 'model', 'protocol', 'temperature']) {
        assert.equal(stage[key], before.analysisManifest.stages.apiReaderArticle[key]);
    }
    const once = JSON.stringify(paper);
    assert.equal(repairApiReaderArticleAndPlanBindings(paper, paper.analysisManifest), false);
    assert.equal(JSON.stringify(paper), once);
});

test('内容指标只把已绑定的图和 TeX 注入复核回解析器质量视图', () => {
    const figure = { ordinal: 1, label: 'Figure 1', caption: 'A result chart.',
        url: 'https://arxiv.org/html/2609.03622v1/fig.png' };
    const focus = '先对比四个频谱面板中的噪声变化';
    const figureBlock = '> **看图路径：** 1. ' + focus + '\n\n'
        + '![原论文 Figure 1：A result chart.](' + figure.url + ')\n\n'
        + '*论文图 1。原论文 Figure 1：“A result chart.”。*';
    const formula = '\\[x=1\\]';
    const plan = { figurePlacements: [{ figureOrdinal: 1, marker: '[[FIGURE_1]]', focusPoints: [focus] }],
        formulaBindings: [{ marker: '[[FORMULA_1]]', latex: 'x=1', renderedBlockSha256: sha(formula) }] };
    const authored = '### 解释现有图表\n\n这里是作者写出的说明段。\n\n';
    const final = authored + figureBlock + '\n\n' + formula;
    const view = restoreApiReaderInjectionMarkers(final, plan, [figure]);
    assert.equal(view, authored + '[[FIGURE_1]]\n\n[[FORMULA_1]]');
    const quality = value => validateEditorialQuality({
        summary: '', method: value, innovations: '', results: '', details: '', limits: ''
    });
    assert.ok(quality(final).issues.some(issue => issue.match === '四个'));
    assert.ok(!quality(view).issues.some(issue => issue.match === '四个'));
    assert.throws(() => restoreApiReaderInjectionMarkers(final.replace(focus, '未绑定图文'), plan, [figure]),
        /无法精确重放 Figure/);
    assert.throws(() => restoreApiReaderInjectionMarkers(final.replace('x=1', 'x=2'), plan, [figure]),
        /无法精确重放公式/);
    const unboundProse = '> **看图路径：** 正文声称四个未绑定面板';
    assert.equal(restoreApiReaderInjectionMarkers(unboundProse, {}, []), unboundProse);
});
