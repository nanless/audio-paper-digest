'use strict';

const crypto = require('crypto');
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
    MANUAL_TUTORIAL_QUALITY_CONTRACT,
    READER_PATH_KINDS,
    validateManualTutorialQualityPacket
} = require('../scripts/manual-tutorial-quality-contract.js');

function paragraph(seed, times = 9) {
    return Array.from({ length: times }, (_, index) => (
        `${seed}。这一段把输入条件、比较口径、结论强度和仍待验证的条件放在同一个因果链中，让刚入门的研究生能够先建立直觉，再回到原始实验核对数字 ${index + 1}。`
    )).join('');
}

function fixture() {
    const headings = [
        ['先把问题放回真实使用场景', 'teaching_entry'], ['用一张流图建立端到端心智模型', 'mental_model'],
        ['关键机制为何需要分工', 'mechanism'], ['训练配方与复现变量', 'training_reproduction'],
        ['实验先回答什么比较问题', 'experiment_protocol'], ['完整结果而非只挑最佳行', 'complete_results'],
        ['负面结果和外推边界', 'negative_boundary'], ['给研究者、复现者和产品团队的收束', 'reader_closeout']
    ];
    const table = '| 方法 | 公开集 MRR↑ |\n| --- | ---: |\n| 基线 | 15.1 |\n| 主方法 | 18.8 |';
    const bodies = [
        `问题是现有 caption 只能描述标签，反例是用户用场景化评价查询时找不到音乐。论文的核心判断是评论文本必须先对齐到曲目，才能补足复杂查询。路线一是标签 caption，其限制是表达稀疏；路线二是网页描述，其限制是混入与曲目无关的叙事。${paragraph('因此读者先比较两条旧路线的失败方式，再理解本文为何不是单纯扩充文本')}`,
        `输入是专辑评论与曲目元数据，表示是受约束 caption，组件包括抽取器、曲目聚合器和 CLAP，输出是音乐检索分数，代价是生成改写可能引入事实偏差。${paragraph('这条数据流把专辑级语言压缩到曲目级监督，并把每个组件的职责与相邻步骤区分开')}`,
        `设计选择是曲目级聚合，预期机制是减少专辑叙事错配，结果证据是公开 Song Describer 比较提高 MRR，替代解释是不能排除提示策略和语料混合的影响。${paragraph('机制解释必须回到同一训练条件下的比较，而不是把整机涨分直接归因给单一组件')}`,
        `数据使用公开评论与四类既有语料；划分沿用论文公开协议；模型为 CLAP；训练使用混合语料和对比目标；目标函数为检索损失；超参数按论文附录；论文未报告计算资源；推理按文本到音乐检索执行。${paragraph('复现实验时应先固定语料比例和曲目聚合版本，因为这些变量改变后数字不能跨配方比较')}`,
        `这张表的问题是混入评论后是否在同一公开检索设置改善；协议固定为 Song Describer 的 MRR，指标越高越好。${table}表后发现是主方法从 15.1 升到 18.8；反证是这不能说明所有音乐理解任务都改善。${paragraph('先说明表在比较什么，再解释数字的强度，避免把一个排行榜当作机制因果证明')}`,
        `完整结果应同时保留基线和主方法，不能只摘 18.8。${table}主方法从 15.1 升到 18.8。这组结果支持的是目标检索设置中的系统收益，不能推出每个组件单独有效。${paragraph('对于其他能力族，读者应回到完整原表而非只接受作者挑出的最佳行')}`,
        `负面结果是评论单独训练弱于混合 baseline，证据来自同一结果表，后果是评论只能作为互补监督。未报告项是设备延迟，证据是论文没有同设备测量，后果是不能把离线检索分数外推为生产吞吐。${paragraph('边界不是礼貌性补一句局限，而是改变结论适用范围的实验条件')}`,
        `研究者可迁移的启示是把语域缺口与配对质量一起测量。复现者的最小行动是固定曲目聚合、数据比例和公开 split。产品团队需要补做延迟、长尾查询和版权许可评测。${paragraph('最后回到开篇：丰富文本只有在可核对地连到音频时才成为有用监督')}`
    ];
    const article = headings.map(([heading, _kind], index) => `### ${heading}\n\n${bodies[index]}`).join('\n\n');
    const section = Object.fromEntries(headings.map(([heading]) => [heading, heading]));
    const packet = {
        version: 1, contract: MANUAL_TUTORIAL_QUALITY_CONTRACT, paperId: '2608.25244',
        summaryFirstParagraph: '本文研究评论文本如何作为补充监督改善复杂音乐检索，并指出它的收益只在受控的曲目级配对与公开比较中成立；文章随后分别解释数据流、训练变量、完整结果、负面结果以及复现和部署边界，避免把一个检索分数误说成通用音乐理解已经解决。',
        sectionPlan: headings.map(([heading, kind]) => ({ heading, kind })),
        teachingEntrance: { sectionHeading: section['先把问题放回真实使用场景'], problem: '问题是现有 caption 只能描述标签', counterexample: '反例是用户用场景化评价查询时找不到音乐', thesis: '论文的核心判断是评论文本必须先对齐到曲目，才能补足复杂查询', priorRoutes: [{ route: '路线一是标签 caption', limit: '其限制是表达稀疏' }, { route: '路线二是网页描述', limit: '其限制是混入与曲目无关的叙事' }] },
        mentalModel: { sectionHeading: section['用一张流图建立端到端心智模型'], mode: 'flow_table', input: '输入是专辑评论与曲目元数据', representation: '表示是受约束 caption', components: '组件包括抽取器、曲目聚合器和 CLAP', output: '输出是音乐检索分数', tradeoff: '代价是生成改写可能引入事实偏差' },
        artifactDisposition: { tables: [{ artifactId: 'T1', disposition: 'inline_full', sectionHeading: section['实验先回答什么比较问题'], fullTableMarkdown: table }], figures: [{ artifactId: 'F1', disposition: 'reject', reason: '该图只包含资助方标志，没有可解释的模型、数据或实验像素事实。' }] },
        tableClosures: [{ artifactId: 'T1', sectionHeading: section['实验先回答什么比较问题'], questionBefore: '这张表的问题是混入评论后是否在同一公开检索设置改善', protocol: '协议固定为 Song Describer 的 MRR，指标越高越好', findingAfter: '表后发现是主方法从 15.1 升到 18.8', counterevidenceAfter: '反证是这不能说明所有音乐理解任务都改善' }],
        causalBridges: [
            { sectionHeading: section['关键机制为何需要分工'], designChoice: '设计选择是曲目级聚合', expectedMechanism: '预期机制是减少专辑叙事错配', resultEvidence: '结果证据是公开 Song Describer 比较提高 MRR', alternativeExplanation: '替代解释是不能排除提示策略和语料混合的影响', evidenceLevel: 'system_level' },
            { sectionHeading: section['完整结果而非只挑最佳行'], designChoice: '完整结果应同时保留基线和主方法', expectedMechanism: '这组结果支持的是目标检索设置中的系统收益', resultEvidence: '主方法从 15.1 升到 18.8', alternativeExplanation: '不能推出每个组件单独有效', evidenceLevel: 'system_level' }
        ],
        negativeBoundary: [{ sectionHeading: section['负面结果和外推边界'], negativeOrMissing: '负面结果是评论单独训练弱于混合 baseline', evidence: '证据来自同一结果表', consequence: '后果是评论只能作为互补监督' }, { sectionHeading: section['负面结果和外推边界'], negativeOrMissing: '未报告项是设备延迟', evidence: '论文没有同设备测量', consequence: '不能把离线检索分数外推为生产吞吐' }],
        reproductionPath: { sectionHeading: section['训练配方与复现变量'], steps: [
            ['data', 'reported', '数据使用公开评论与四类既有语料'], ['split', 'reported', '划分沿用论文公开协议'], ['model', 'reported', '模型为 CLAP'], ['training', 'reported', '训练使用混合语料和对比目标'], ['objective', 'reported', '目标函数为检索损失'], ['hyperparameters', 'reported', '超参数按论文附录'], ['compute', 'not_reported', '论文未报告计算资源'], ['inference', 'reported', '推理按文本到音乐检索执行']
        ].map(([field, status, statement]) => ({ field, status, statement })) },
        readerCloseouts: { researcher: { sectionHeading: section['给研究者、复现者和产品团队的收束'], takeaway: '研究者可迁移的启示是把语域缺口与配对质量一起测量' }, reproducer: { sectionHeading: section['给研究者、复现者和产品团队的收束'], takeaway: '复现者的最小行动是固定曲目聚合、数据比例和公开 split' }, product: { sectionHeading: section['给研究者、复现者和产品团队的收束'], takeaway: '产品团队需要补做延迟、长尾查询和版权许可评测' } },
        reviewRubric: {}
    };
    const evidence = '这一段把输入条件、比较口径、结论强度和仍待验证的条件放在同一个因果链中';
    for (const name of ['conceptTeaching', 'progression', 'mechanismClarity', 'evidenceCompleteness', 'causalCalibration', 'figureTableCooperation', 'reproducibility', 'readerCloseout', 'proseQuality']) {
        packet.reviewRubric[name] = { score: 3, sectionHeading: headings[0][0], evidence, countercheck: '复核时仍需检查读者是否能指出比较设置与不能外推的边界。' };
    }
    return { packet, article, artifactIndex: { tables: [{ id: 'T1' }], figures: [{ id: 'F1' }] } };
}

describe('Manual tutorial quality contract', () => {
    it('接收含完整表格、因果桥、复现和三类读者收束的研究生教程 packet', () => {
        const { packet, article, artifactIndex } = fixture();
        const result = validateManualTutorialQualityPacket(packet, article, artifactIndex);
        assert.equal(result.contract, MANUAL_TUTORIAL_QUALITY_CONTRACT);
        assert.equal(result.sectionCount, 8);
        assert.equal(result.tableCount, 1);
    });

    it('新教程必须显式声明完整学习路径，不能沿用单节教学入口冒充背景', () => {
        const { packet, article, artifactIndex } = fixture();
        packet.version = 2;
        assert.deepEqual(READER_PATH_KINDS, [
            'field_background', 'related_work_map', 'paper_question', 'method_overview',
            'data_component', 'model_component', 'objective_component', 'experiment_protocol',
            'main_results', 'diagnostic_results', 'ablation_results', 'external_comparison',
            'boundary_synthesis', 'reproduction', 'reader_closeout'
        ]);
        assert.throws(
            () => validateManualTutorialQualityPacket(packet, article, artifactIndex),
            /qualityPacket\.freshAuthoring/
        );
        packet.freshAuthoring = {
            contract: 'fresh-authoring-v1', mode: 'fresh_from_evidence',
            authoringSessionId: 'fresh-test-session-1',
            articleSha256: crypto.createHash('sha256').update(article.normalize('NFKC')).digest('hex'),
            articleFileSha256: crypto.createHash('sha256').update(article).digest('hex'),
            prohibitedProseInputs: [],
            inputs: ['paper_metadata', 'source_snapshot', 'artifact_index', 'authoring_prompt']
                .map((kind, index) => ({ kind, sha256: String(index + 1).repeat(64) }))
        };
        packet.readerPath = { version: 'reader-tutorial-path-v1' };
        assert.throws(
            () => validateManualTutorialQualityPacket(packet, article, artifactIndex),
            /sectionPlan 缺少入门教程阶段: field_background/
        );
        packet.freshAuthoring.inputs.push({ kind: 'reader_article', sha256: 'a'.repeat(64) });
        assert.throws(
            () => validateManualTutorialQualityPacket(packet, article, artifactIndex),
            /属于旧 prose: reader_article/
        );
    });

    it('拒绝表格只被口头引用、没有完整 Markdown 转录的 packet', () => {
        const { packet, article, artifactIndex } = fixture();
        packet.artifactDisposition.tables[0].fullTableMarkdown = '| 方法 | 分数 |\n| --- | --- |\n| 主方法 | 18.8 |';
        assert.throws(() => validateManualTutorialQualityPacket(packet, article, artifactIndex), /逐字进入绑定正文/);
    });

    it('拒绝摘要首段复写正文与内部审计腔', () => {
        const { packet, article, artifactIndex } = fixture();
        packet.summaryFirstParagraph = '问题是现有 caption 只能描述标签，反例是用户用场景化评价查询时找不到音乐。论文的核心判断是评论文本必须先对齐到曲目，才能补足复杂查询。路线一是标签 caption，其限制是表达稀疏；路线二是网页描述，其限制是混入与曲目无关的叙事。';
        assert.throws(() => validateManualTutorialQualityPacket(packet, article, artifactIndex), /摘要首段/);
        const clean = fixture();
        const noisy = `${clean.article}\n\n证据账本必须绑定。表格门禁必须校验。readerArticle 是发布契约。`;
        assert.throws(() => validateManualTutorialQualityPacket(clean.packet, noisy, clean.artifactIndex), /内部审计腔/);
    });

    it('拒绝用图表编号组织章节标题以及可能破坏 Hugo 的 Markdown/公式分隔符', () => {
        const numbered = fixture();
        const numberedArticle = numbered.article.replace('### 实验先回答什么比较问题', '### 表 1 的实验结果说明什么');
        assert.throws(
            () => validateManualTutorialQualityPacket(numbered.packet, numberedArticle, numbered.artifactIndex),
            /章节标题不得用图号或表号/
        );
        const dollar = fixture();
        assert.throws(
            () => validateManualTutorialQualityPacket(dollar.packet, `${dollar.article}\n\n裸公式 $x+y$。`, dollar.artifactIndex),
            /禁止使用裸 \$\/\$\$/
        );
        const parenthesizedLatex = fixture();
        assert.throws(
            () => validateManualTutorialQualityPacket(
                parenthesizedLatex.packet,
                `${parenthesizedLatex.article}\n\n错误行内公式 (1\\times10^{-4})。`,
                parenthesizedLatex.artifactIndex
            ),
            /LaTeX 命令不能放在普通圆括号/
        );
        for (const expression of ['(mathbf a_i,mathbf t_i)', '(tau>0)', '(\\ell_2)']) {
            const malformed = fixture();
            assert.throws(
                () => validateManualTutorialQualityPacket(
                    malformed.packet,
                    `${malformed.article}\n\n错误行内公式 ${expression}。`,
                    malformed.artifactIndex
                ),
                /LaTeX 命令不能放在普通圆括号/
            );
        }
        const validBlockMath = fixture();
        assert.doesNotThrow(() => validateManualTutorialQualityPacket(
            validBlockMath.packet,
            `${validBlockMath.article}\n\n\\[y=\\left(1-\\lambda\\right)x\\]`,
            validBlockMath.artifactIndex
        ));
        const glued = fixture();
        assert.throws(
            () => validateManualTutorialQualityPacket(glued.packet, `${glued.article}\n\n**关键判断。**论文随后给出实验。`, glued.artifactIndex),
            /加粗结束符后必须留空格或标点/
        );
    });
});
