'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
    PREVIEW_MODE, buildTutorialPreview, parseArgs, assertFreshAuthoringInputBindings
} = require('../scripts/manual-tutorial-preview.js');
const { buildTutorialArtifactPlan, renderMarkdownTable } = require('../scripts/manual-tutorial-artifacts.js');
const { MANUAL_TUTORIAL_QUALITY_CONTRACT } = require('../scripts/manual-tutorial-quality-contract.js');

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}
function filler(seed) {
    return Array.from({ length: 8 }, (_, index) => `${seed}；这里同时说明比较条件、结论强度和仍待验证的假设，使刚入门的研究生能把每一个技术判断放回数据、模型和实验协议中核对，而不是把单一分数当成万能结论 ${index + 1}。`).join('');
}

function makeFormalPacket({ id, artifactIndex }) {
    const table = renderMarkdownTable(artifactIndex.tables[0]);
    const headings = [
        ['先把专辑评论的监督错配说清楚', 'teaching_entry'], ['从评论到曲目的端到端心智模型', 'mental_model'],
        ['曲目级聚合到底改变了哪个机制', 'mechanism'], ['训练配方与可复现实验变量', 'training_reproduction'],
        ['实验协议先回答什么问题', 'experiment_protocol'], ['完整结果表不能只摘最好一行', 'complete_results'],
        ['负面结果与不能外推的边界', 'negative_boundary'], ['给研究者复现者产品团队的收束', 'reader_closeout']
    ];
    const body = [
        `问题是标签 caption 无法表达场景化评价，反例是用户用专辑叙事查询时找不到对应曲目。论文的核心判断是评论必须先对齐到曲目，才能成为补充监督。路线一是标签 caption，其限制是表达稀疏；路线二是网页描述，其限制是混入与曲目无关的叙事。${filler('读者应先比较两条旧路线失败在哪里')}`,
        `输入是专辑评论与曲目元数据，表示是受约束 caption，组件包括抽取器、曲目聚合器和 CLAP，输出是音乐检索分数，代价是生成改写可能引入事实偏差。${filler('这条数据流把专辑级语言压缩为曲目级监督')}`,
        `设计选择是曲目级聚合，预期机制是减少专辑叙事错配，结果证据是公开检索比较提高 MRR，替代解释是不能排除提示策略和语料混合的影响。${filler('整机分数上升不能自动证明每个组件单独有效')}`,
        `数据使用公开评论与既有语料；划分沿用论文公开协议；模型为 CLAP；训练使用混合语料和对比目标；目标函数为检索损失；超参数按论文附录；论文未报告计算资源；推理按文本到音乐检索执行。${filler('复现应先固定曲目聚合版本和语料比例')}`,
        `这张表的问题是混入评论后是否在同一公开检索设置改善；协议固定为 MRR，指标越高越好。${table}\n表后发现是主方法从 15.1 升到 18.8；反证是这不能说明所有音乐理解任务都改善。${filler('先交代比较问题再解释表格数字')}`,
        `完整结果必须保留基线和主方法，而不是只摘最高分。${table}\n主方法从 15.1 升到 18.8。这组结果支持目标检索设置中的系统收益，不能推出每个组件单独有效。${filler('完整表格比挑选一行更能显示收益边界')}`,
        `负面结果是评论单独训练弱于混合 baseline，证据来自同一结果表，后果是评论只能作为互补监督。未报告项是设备延迟，证据是论文没有同设备测量，后果是不能把离线检索分数外推为生产吞吐。${filler('边界会直接改变论文结论可适用的范围')}`,
        `研究者可迁移的启示是把语域缺口与配对质量一起测量。复现者的最小行动是固定曲目聚合、数据比例和公开 split。产品团队需要补做延迟、长尾查询和版权许可评测。${filler('最后回到开篇问题并给三类读者不同的下一步')}`
    ];
    const article = headings.map(([heading], index) => `### ${heading}\n\n${body[index]}`).join('\n\n');
    const packet = {
        version: 1, contract: MANUAL_TUTORIAL_QUALITY_CONTRACT, paperId: id, articleSha256: sha(Buffer.from(article)),
        summaryFirstParagraph: '本文把专辑级评论视为需要先解决配对粒度的问题，而不是无条件增加文本；后续从数据流、训练配方、完整比较、反例和实际复现动作逐层说明其有效范围，并把每项结论限定在论文实际报告的公开检索协议之内。',
        sectionPlan: headings.map(([heading, kind]) => ({ heading, kind })),
        teachingEntrance: { sectionHeading: headings[0][0], problem: '问题是标签 caption 无法表达场景化评价', counterexample: '反例是用户用专辑叙事查询时找不到对应曲目', thesis: '论文的核心判断是评论必须先对齐到曲目，才能成为补充监督', priorRoutes: [{ route: '路线一是标签 caption', limit: '其限制是表达稀疏' }, { route: '路线二是网页描述', limit: '其限制是混入与曲目无关的叙事' }] },
        mentalModel: { sectionHeading: headings[1][0], mode: 'flow_table', input: '输入是专辑评论与曲目元数据', representation: '表示是受约束 caption', components: '组件包括抽取器、曲目聚合器和 CLAP', output: '输出是音乐检索分数', tradeoff: '代价是生成改写可能引入事实偏差' },
        artifactDisposition: { tables: [{ artifactId: 'TAB0001', disposition: 'inline_full', sectionHeading: headings[4][0], fullTableMarkdown: table }], figures: [] },
        tableClosures: [{ artifactId: 'TAB0001', sectionHeading: headings[4][0], questionBefore: '这张表的问题是混入评论后是否在同一公开检索设置改善', protocol: '协议固定为 MRR，指标越高越好', findingAfter: '表后发现是主方法从 15.1 升到 18.8', counterevidenceAfter: '反证是这不能说明所有音乐理解任务都改善' }],
        causalBridges: [
            { sectionHeading: headings[2][0], designChoice: '设计选择是曲目级聚合', expectedMechanism: '预期机制是减少专辑叙事错配', resultEvidence: '结果证据是公开检索比较提高 MRR', alternativeExplanation: '替代解释是不能排除提示策略和语料混合的影响', evidenceLevel: 'system_level' },
            { sectionHeading: headings[5][0], designChoice: '完整结果必须保留基线和主方法', expectedMechanism: '这组结果支持目标检索设置中的系统收益', resultEvidence: '主方法从 15.1 升到 18.8', alternativeExplanation: '不能推出每个组件单独有效', evidenceLevel: 'system_level' }
        ],
        negativeBoundary: [{ sectionHeading: headings[6][0], negativeOrMissing: '负面结果是评论单独训练弱于混合 baseline', evidence: '证据来自同一结果表', consequence: '后果是评论只能作为互补监督' }, { sectionHeading: headings[6][0], negativeOrMissing: '未报告项是设备延迟', evidence: '论文没有同设备测量', consequence: '不能把离线检索分数外推为生产吞吐' }],
        reproductionPath: { sectionHeading: headings[3][0], steps: [['data', 'reported', '数据使用公开评论与既有语料'], ['split', 'reported', '划分沿用论文公开协议'], ['model', 'reported', '模型为 CLAP'], ['training', 'reported', '训练使用混合语料和对比目标'], ['objective', 'reported', '目标函数为检索损失'], ['hyperparameters', 'reported', '超参数按论文附录'], ['compute', 'not_reported', '论文未报告计算资源'], ['inference', 'reported', '推理按文本到音乐检索执行']].map(([field, status, statement]) => ({ field, status, statement })) },
        readerCloseouts: { researcher: { sectionHeading: headings[7][0], takeaway: '研究者可迁移的启示是把语域缺口与配对质量一起测量' }, reproducer: { sectionHeading: headings[7][0], takeaway: '复现者的最小行动是固定曲目聚合、数据比例和公开 split' }, product: { sectionHeading: headings[7][0], takeaway: '产品团队需要补做延迟、长尾查询和版权许可评测' } },
        reviewRubric: {},
        presentation: { titleZh: '专辑评论为何能补齐音乐语义，却不能冒充万能标签', tags: ['音乐信息检索', '推荐系统'], score: { total: 7.4 }, scoreBreakdown: { innovationScore: 1.4, technicalRigorScore: 1.1, experimentalSufficiencyScore: 1.1, clarityScore: 0.8, impactScore: 1.0, openSourceScore: 1.0, reproducibilityScore: 0.3, engineeringScore: 0.7 }, authors: 'Alice Audio；Bob Music', institutions: 'Example University；Audio Lab', oneSentence: '论文把专辑评论作为与曲目标签互补的监督信号，并用检索实验检验它究竟补上了哪些语义。', roast: '这不是把评论文本随手倒进训练集就能完成的工作：配对粒度确实指出了监督错配，但没有长尾和跨域证据时，离线提升还远不该被包装成通用音乐理解。', coreSummary: '作者把关键判断放在评论到曲目的配对，而非文本长度本身；正文会用数据流、表格和反例区分哪些收益有公开比较支撑，哪些仍缺少部署和泛化证据。', openSource: '- 论文：<https://arxiv.org/abs/2608.25244>\n- 代码：论文未报告公开仓库。', scoringEvidence: '创新分来自把监督粒度和配对质量拆开讨论；实验分只覆盖当前公开检索设置。没有跨平台用户研究、同设备延迟或公开复现仓库，因此不能把可复现性和部署价值写成已证实事实。' }
    };
    for (const name of ['conceptTeaching', 'progression', 'mechanismClarity', 'evidenceCompleteness', 'causalCalibration', 'figureTableCooperation', 'reproducibility', 'readerCloseout', 'proseQuality']) {
        packet.reviewRubric[name] = { score: 3, sectionHeading: headings[0][0], evidence: '比较条件、结论强度和仍待验证的假设', countercheck: '复核时仍需检查读者是否能指出比较设置与不能外推的边界。' };
    }
    return { article, packet };
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-tutorial-preview-'));
    const current = path.join(root, 'current'); const date = '2026-08-27'; const id = '2608.25244';
    const filteredPath = path.join(current, 'filtered-papers.json'); const canonicalPath = path.join(current, 'deep-analysis-result.json');
    const artifactDir = path.join(current, 'manual-full-text', date, 'artifacts'); const artifactPath = path.join(artifactDir, `${id}.artifact.json`); const artifactManifestPath = path.join(artifactDir, 'manifest.json');
    const sourcePath = path.join(current, 'manual-full-text', date, `${id}-source.txt`);
    const fulltextManifestPath = path.join(current, 'manual-full-text', date, 'manifest.json');
    const previewRoot = path.join(current, 'manual-tutorial-previews');
    const articlePath = path.join(previewRoot, date, id, 'draft', 'article.md');
    const qualityPath = path.join(previewRoot, date, id, 'quality.json');
    const matrix = [['Method', 'MRR'], ['Baseline', '15.1'], ['Proposed', '18.8']];
    const artifact = { paperId: id, outputSha256: 'a'.repeat(64), inventoryHealth: { status: 'complete' }, tables: [{ id: 'TAB0001', kind: 'result', caption: 'Table 1: Retrieval MRR', matrix, matrixSha256: sha(JSON.stringify(matrix)) }], figures: [], formulas: [], acronyms: [{ value: 'MRR' }], citations: [], references: [] };
    const { article, packet } = makeFormalPacket({ id, artifactIndex: artifact }); const plan = buildTutorialArtifactPlan(artifact);
    packet.artifactPlan = { version: plan.version, paperId: id, sha256: sha(JSON.stringify(plan)) };
    writeJson(filteredPath, { status: 'complete', batchDate: date, papers: [{ arxivId: id, title: 'AllMusicCaps: Album Reviews as Complementary Music Supervision', authors: ['Alice Audio', 'Bob Music'] }] });
    writeJson(canonicalPath, { papers: [{ arxivId: id, title: 'AllMusicCaps: Album Reviews as Complementary Music Supervision', parsed: { score: '7.4', tags: ['音乐信息检索'], innovationScore: 1.4, technicalRigorScore: 1.1, experimentalSufficiencyScore: 1.1, clarityScore: 0.8, impactScore: 1.0, openSourceScore: 1.0, reproducibilityScore: 0.3, engineeringScore: 0.7 } }] });
    writeJson(artifactPath, artifact); writeJson(artifactManifestPath, { papers: { [id]: { status: 'complete', path: artifactPath, outputSha256: sha(fs.readFileSync(artifactPath)) } } });
    fs.writeFileSync(sourcePath, '受控论文全文证据快照。'.repeat(80));
    writeJson(fulltextManifestPath, { papers: { [id]: { status: 'complete', path: sourcePath, sourceSha256: sha(fs.readFileSync(sourcePath)) } } });
    fs.mkdirSync(path.dirname(articlePath), { recursive: true });
    fs.writeFileSync(articlePath, article);
    packet.freshAuthoring = {
        contract: 'fresh-authoring-v1', mode: 'fresh_from_evidence',
        authoringSessionId: 'fresh-preview-fixture-1',
        articleSha256: sha(Buffer.from(article.normalize('NFKC'))),
        articleFileSha256: sha(Buffer.from(article)), prohibitedProseInputs: [],
        inputs: [
            { kind: 'paper_metadata', path: filteredPath, sha256: sha(fs.readFileSync(filteredPath)) },
            { kind: 'source_snapshot', path: sourcePath, sha256: sha(fs.readFileSync(sourcePath)) },
            { kind: 'artifact_index', path: artifactPath, sha256: sha(fs.readFileSync(artifactPath)) },
            { kind: 'authoring_prompt', path: path.resolve(__dirname, '..', 'prompts', 'manual-tutorial-article.md'), sha256: sha(fs.readFileSync(path.resolve(__dirname, '..', 'prompts', 'manual-tutorial-article.md'))) },
            { kind: 'editorial_contract', path: path.resolve(__dirname, '..', 'docs', 'manual-editorial-reference-contract.md'), sha256: sha(fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'manual-editorial-reference-contract.md'))) },
            { kind: 'blank_schema', path: path.resolve(__dirname, '..', 'scripts', 'manual-tutorial-quality-contract.js'), sha256: sha(fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'manual-tutorial-quality-contract.js'))) }
        ]
    };
    writeJson(qualityPath, packet);
    return { date, id, filteredPath, canonicalPath, artifactManifestPath, articlePath, qualityPath, previewRoot, article, packet };
}
function options(f, extra = {}) { return { date: f.date, paperId: f.id, articlePath: f.articlePath, qualityPath: f.qualityPath, filteredPath: f.filteredPath, canonicalPath: f.canonicalPath, artifactManifestPath: f.artifactManifestPath, previewRoot: f.previewRoot, generatedAt: '2026-08-28T12:00:00.000+08:00', ...extra }; }

describe('isolated Manual tutorial preview', () => {
    it('正式 quality/artifact contracts 通过后仅生成一篇预览并绑定 plan 覆盖', () => {
        const f = fixture(); const before = fs.readFileSync(f.canonicalPath); const result = buildTutorialPreview(options(f));
        assert.equal(result.reused, false); assert.equal(result.manifest.mode, PREVIEW_MODE); assert.equal(result.manifest.inputs.quality.contract, MANUAL_TUTORIAL_QUALITY_CONTRACT);
        assert.match(result.manifest.inputs.artifactPlan.sha256, /^[a-f0-9]{64}$/); assert.deepEqual(result.manifest.inputs.artifactPlan.coverage, { tables: 1, figures: 0, formulas: 0, numericCells: 2 });
        assert.equal(result.manifest.inputs.tutorialPayload.contract, 'manual-v5-tutorial-payload-v1');
        assert.equal(result.manifest.inputs.tutorialPayload.orchestratorContract, 'manual-tutorial-validation-orchestrator-v1');
        assert.match(result.manifest.inputs.tutorialPayload.orchestratorFingerprint, /^[a-f0-9]{64}$/);
        assert.match(result.manifest.inputs.tutorialPayload.receiptSha256, /^[a-f0-9]{64}$/);
        assert.equal(fs.readFileSync(f.canonicalPath).equals(before), true);
        const markdown = fs.readFileSync(result.postPath, 'utf8'); const order = ['---', 'title: "专辑评论', 'paper_digest_arxiv_id: "2608.25244"', 'paper_digest_tutorial_contract:', '# 专辑评论', '> 英文题目', '> arXiv', '**标签：**', '**评分：**', '**八维分项：**', '**作者与机构：**', '**机构：**', '**一句话概括：**', '## 💬 毒舌点评', '## 📌 核心摘要', '## 🔗 开源与复现资源', '## 🧭 深度解读', f.article, '## ⚖️ 评分依据与证据']; let previous = -1;
        for (const marker of order) { const current = markdown.indexOf(marker); assert.ok(current > previous, `顺序错误或缺失: ${marker}`); previous = current; }
        assert.deepEqual(fs.readdirSync(result.outputDir).sort(), ['artifact-plan.json', 'draft', 'manifest.json', 'post.md', 'quality.json']);
    });

    it('相同输入复用，而单篇 article SHA 改变只重建自己的页', () => {
        const f = fixture(); const first = buildTutorialPreview(options(f)); const mtime = fs.statSync(first.postPath).mtimeMs;
        assert.equal(buildTutorialPreview(options(f, { generatedAt: '2026-08-28T12:01:00.000+08:00' })).reused, true); assert.equal(fs.statSync(first.postPath).mtimeMs, mtime);
        const canonical = JSON.parse(fs.readFileSync(f.canonicalPath, 'utf8'));
        canonical.papers.push({ arxivId: '2608.99999', title: 'Unrelated paper changed later' });
        writeJson(f.canonicalPath, canonical);
        assert.equal(buildTutorialPreview(options(f, { generatedAt: '2026-08-28T12:01:30.000+08:00' })).reused, true, '其他论文变化不应使本页缓存失效');
        const changed = `${f.article}\n\n补充一段只属于本篇论文的边界讨论，它不新增教程小节但会改变正文哈希。`; fs.writeFileSync(f.articlePath, changed); f.packet.articleSha256 = sha(Buffer.from(changed)); writeJson(f.qualityPath, f.packet);
        const rebuilt = buildTutorialPreview(options(f, { generatedAt: '2026-08-28T12:02:00.000+08:00' })); assert.equal(rebuilt.reused, false); assert.notEqual(rebuilt.manifest.output.postSha256, first.manifest.output.postSha256); assert.equal(fs.existsSync(path.join(f.previewRoot, f.date, '2608.99999')), false);
    });

    it('当前旧 AllMusic 文章配 passed=true 伪 quality 不能绕过正式质量契约', () => {
        const f = fixture();
        const source = [
            '### 方法摘要', '只复述模型名称和语料规模，没有教学入口、端到端心智模型或因果桥。',
            '### 实验摘要', '只摘录最高分，不保留完整原始表格、比较协议、反证或指标方向。',
            '### 局限摘要', '只写泛化不足，没有绑定具体负面结果、未报告项及其实际后果。',
            '### 复现摘要', '只列代码链接，不交代数据、划分、模型、训练、目标、超参数、算力和推理。',
            '### 结论摘要', '以五个可互换栏目结束，没有研究者、复现者和产品团队的独立行动收束。'
        ].join('\n\n');
        fs.writeFileSync(f.articlePath, source); writeJson(f.qualityPath, { version: 1, mode: 'manual_tutorial_quality', passed: true, paperId: f.id });
        assert.throws(() => buildTutorialPreview(options(f)), /fresh-authoring-v1|artifactPlan|graduate-researcher-tutorial-quality-v2|正文至少/);
    });

    it('sealed payload 拒绝评分、artifact plan 与完整表格任一处被篡改', () => {
        const scoring = fixture();
        scoring.packet.presentation.scoreBreakdown.engineeringScore = 0.2;
        writeJson(scoring.qualityPath, scoring.packet);
        assert.throws(() => buildTutorialPreview(options(scoring)), /总分与八维分项不一致/);

        const plan = fixture();
        plan.packet.artifactPlan.sha256 = '0'.repeat(64);
        writeJson(plan.qualityPath, plan.packet);
        assert.throws(() => buildTutorialPreview(options(plan)), /未绑定当前确定性 artifact plan/);

        const table = fixture();
        table.packet.artifactDisposition.tables[0].fullTableMarkdown = table.packet
            .artifactDisposition.tables[0].fullTableMarkdown.replace('18.8', '99.9');
        writeJson(table.qualityPath, table.packet);
        assert.throws(
            () => buildTutorialPreview(options(table)),
            /逐字进入绑定正文|表格处置与 artifact plan 不一致|tableTranscriptionAttestation/
        );
    });

    it('测试 presentation adapter 只能在正式质量与 fresh 门禁通过后运行', () => {
        const f = fixture(); const adapter = { validate({ article }) { return { adapter: 'test-only-adapter', titleZh: '注入适配器预览', oneSentence: '这只验证隔离注入接口，正式 CLI 不会使用它。', roast: '测试适配器只用于证明可注入性，不能替代正式教程质量契约。', coreSummary: '测试摘要足够长，用于覆盖预览排版所需的固定字段。', openSource: '论文未报告。', scoringEvidence: '测试评分依据用于覆盖预览固定结构，正式运行必须通过独立质量契约。', tags: ['测试'], score: '0/10', scoreBreakdown: [ ['innovationScore', '创新', 2], ['technicalRigorScore', '技术严谨', 1.5], ['experimentalSufficiencyScore', '实验充分', 1.5], ['clarityScore', '清晰度', 1], ['impactScore', '影响力', 1.5], ['openSourceScore', '开源', 1.5], ['reproducibilityScore', '可复现', 0.5], ['engineeringScore', '工程/实践', 1.5] ].map(([key, label, maximum]) => ({ key, label, score: 0, maximum })), authors: 'Test Author', institutions: 'Test Lab', article }; } };
        assert.equal(buildTutorialPreview(options(f, { qualityAdapter: adapter })).manifest.inputs.quality.contract, 'custom');
        const invalid = fixture();
        delete invalid.packet.freshAuthoring;
        writeJson(invalid.qualityPath, invalid.packet);
        assert.throws(
            () => buildTutorialPreview(options(invalid, { qualityAdapter: adapter })),
            /fresh-authoring-v1/
        );
    });

    it('CLI 参数必须精确指定单篇输入', () => {
        assert.deepEqual(parseArgs(['--date', '2026-08-27', '--paper-id', '2608.25244v1', '--article', 'article.md', '--quality', 'quality.json']), { date: '2026-08-27', paperId: '2608.25244', articlePath: 'article.md', qualityPath: 'quality.json' });
        assert.throws(() => parseArgs(['--date', '2026-08-27']), /缺少必填参数/);
    });

    it('拒绝把旧博客 post、其他路径或符号链接伪装成 fresh draft', () => {
        const f = fixture();
        const oldPost = path.join(path.dirname(f.previewRoot), 'old-post.md');
        fs.writeFileSync(oldPost, f.article);
        assert.throws(
            () => buildTutorialPreview(options(f, { articlePath: oldPost })),
            /只接受受控 fresh draft/
        );
        const realArticle = f.articlePath;
        const saved = `${realArticle}.saved`;
        fs.renameSync(realArticle, saved);
        fs.symlinkSync(saved, realArticle);
        assert.throws(() => buildTutorialPreview(options(f)), /不得使用符号链接/);
    });

    it('fresh authoring 声明必须逐项绑定当前权威输入，过期契约或额外旧 prose 都失败', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-tutorial-author-inputs-'));
        const expected = {
            paper_metadata: { path: path.join(root, 'metadata.json'), sha256: '1'.repeat(64) },
            source_snapshot: { path: path.join(root, 'fulltext.txt'), sha256: '2'.repeat(64) },
            artifact_index: { path: path.join(root, 'artifact.json'), sha256: '3'.repeat(64) },
            authoring_prompt: { path: path.join(root, 'prompt.md'), sha256: '4'.repeat(64) },
            editorial_contract: { path: path.join(root, 'contract.md'), sha256: '5'.repeat(64) },
            blank_schema: { path: path.join(root, 'schema.js'), sha256: '6'.repeat(64) }
        };
        const fresh = {
            contract: 'fresh-authoring-v1',
            inputs: Object.entries(expected).map(([kind, value]) => ({ kind, ...value }))
        };
        assert.doesNotThrow(() => assertFreshAuthoringInputBindings({ freshAuthoring: fresh }, expected));
        const stale = structuredClone(fresh);
        stale.inputs.find(item => item.kind === 'editorial_contract').sha256 = '7'.repeat(64);
        assert.throws(
            () => assertFreshAuthoringInputBindings({ freshAuthoring: stale }, expected),
            /未绑定当前权威文件/
        );
        const smuggled = structuredClone(fresh);
        smuggled.inputs.push({ kind: 'reader_article', path: path.join(root, 'old.md'), sha256: '8'.repeat(64) });
        assert.throws(
            () => assertFreshAuthoringInputBindings({ freshAuthoring: smuggled }, expected),
            /只能包含当前权威/
        );
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('存在官方项目证据快照时必须作为第七类 authority 精确绑定', () => {
        const f = fixture();
        const evidencePath = path.join(
            path.dirname(path.dirname(f.artifactManifestPath)),
            'external-evidence', `${f.id}-official-project.json`
        );
        writeJson(evidencePath, {
            version: 1, kind: 'official_project_evidence', paperId: f.id,
            url: 'https://github.com/mtg/allmusiccaps/',
            resources: [{ type: 'code', license: 'AGPL-3.0' }]
        });
        f.packet.freshAuthoring.inputs.push({
            kind: 'official_project_evidence', path: evidencePath,
            sha256: sha(fs.readFileSync(evidencePath))
        });
        writeJson(f.qualityPath, f.packet);
        assert.doesNotThrow(() => buildTutorialPreview(options(f)));
        writeJson(evidencePath, {
            version: 1, kind: 'official_project_evidence', paperId: f.id,
            url: 'https://github.com/mtg/allmusiccaps/',
            resources: [{ type: 'code', license: 'changed' }]
        });
        assert.throws(() => buildTutorialPreview(options(f)), /官方项目证据|未绑定当前权威文件/);
    });
});
