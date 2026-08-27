const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
    validateExactFactCoverage,
    validateEditorialPlan,
    validateEditorialPlanBindings,
    validateReaderArticle,
    validateEditorialReview,
    validateResearchScoringCaps,
    validateResultClaimCoverageV5,
    validateFigureReview,
    validateStageReviews
} = require('../scripts/manual-research-contract.js');
const { validateResultClaims } = require('../scripts/editorial-quality.js');

describe('Manual v5 audio researcher contract', () => {
    it('新论文编辑蓝图必须形成中心矛盾、递进问题、证据柱和小节计划', () => {
        const plan = {
            version: 1,
            governingTension: {
                conflict: '理解需要紧凑语义表示，生成需要保留可重建声学细节，两种目标在同一表示中相互拉扯。',
                sideA: '理解通路希望压缩帧率并突出任务相关语义。',
                sideB: '生成通路需要保留音色、韵律和相位等连续细节。',
                paperChoice: '论文共享语言推理中枢，但把理解表示和生成表示放入两条独立输入通路。'
            },
            readerQuestions: Array.from({ length: 4 }, (_, index) => ({
                id: `Q${index + 1}`,
                question: `第 ${index + 1} 个递进问题具体要回答哪项机制或证据？`,
                purpose: `帮助音频研究者理解第 ${index + 1} 个设计选择及其证据边界。`,
                evidenceIds: [`E0${index + 1}`]
            })),
            evidencePillars: [
                { id: 'P1', claim: '目标任务结果支持解耦表示没有牺牲音频理解能力，并保持跨任务覆盖。', strongestComparison: '与同规模统一表示强基线在公开理解基准上直接比较。', boundary: '结论只覆盖论文报告的公开基准，不能外推到实时部署。' },
                { id: 'P2', claim: '直接组件消融支持两条表示通路承担不同职责，并揭示共享位置。', strongestComparison: '完整系统与移除生成表示通路的同主干消融进行比较。', boundary: '论文尚未提供真实设备上的资源、延迟和长期稳定性曲线。' }
            ],
            sectionPlan: Array.from({ length: 4 }, (_, index) => ({
                heading: `论文特有小节 ${index + 1}`,
                container: ['核心摘要', '方法概述和架构', '实验结果', '局限与问题'][index],
                readerQuestionIds: [`Q${index + 1}`]
            }))
        };
        assert.doesNotThrow(() => validateEditorialPlan(plan, 'FireRedAudio.editorialPlan'));
        plan.evidencePillars = [plan.evidencePillars[0]];
        assert.throws(() => validateEditorialPlan(plan, 'FireRedAudio.editorialPlan'), /2-4/);
    });

    it('editorialPlan v2 必须把标题、问题和证据柱真正落入读者正文', () => {
        const plan = {
            version: 2,
            readerTitle: '两条表示为何比一条接口更适合统一音频模型',
            oneSentenceThesis: '论文把共享放在语言推理层，把理解与生成分别交给不同连续表示，从而避免两种目标在同一接口内争抢容量。',
            governingTension: {
                conflict: '理解需要紧凑语义表示，生成需要保留可重建声学细节，两种目标在同一表示中相互拉扯。',
                sideA: '理解通路希望压缩帧率并突出任务相关语义。', sideB: '生成通路需要保留音色、韵律和相位等连续细节。',
                paperChoice: '论文共享语言推理中枢，但把理解表示和生成表示放入两条独立输入通路。'
            },
            readerQuestions: [
                { id: 'Q1', question: '两类任务为何不能使用同一连续表示接口？', purpose: '先建立表示冲突。', evidenceIds: ['E01'], answerQuote: '理解与生成对表示的压缩率和可重建性提出相反要求。' },
                { id: 'Q2', question: '模型如何把两条通路接到同一推理主干？', purpose: '解释数据流。', evidenceIds: ['E02'], answerQuote: '两条表示只在共享语言主干会合。' },
                { id: 'Q3', question: '哪组实验最能支持这项分工？', purpose: '检验公开比较。', evidenceIds: ['E03'], answerQuote: '公开基准上主方法高于强基线。' },
                { id: 'Q4', question: '哪些结论仍不能外推？', purpose: '收束边界。', evidenceIds: ['E04'], answerQuote: '论文没有报告设备延迟或组件消融。' }
            ],
            evidencePillars: [
                { id: 'P1', claim: '公开理解比较支持分路表示仍可保持感知能力。', strongestComparison: '主方法与强外部基线在公开测试集上直接比较。', boundary: '该比较不说明每个组件的因果贡献。', evidenceIds: ['E03'], readerQuote: '公开基准上主方法高于强基线。' },
                { id: 'P2', claim: '部署结论仍受未报告测量限制。', strongestComparison: '论文没有提供延迟和吞吐的同设备比较。', boundary: '不能将离线结果直接外推为实时性能。', evidenceIds: ['E03'], readerQuote: '公开基准上主方法高于强基线。' }
            ],
            sectionPlan: [
                { heading: '表示冲突先于统一接口', container: '核心摘要', readerQuestionIds: ['Q1'], anchorQuote: '理解与生成对表示的压缩率和可重建性提出相反要求。' },
                { heading: '两条通路只在语言主干会合', container: '方法概述和架构', readerQuestionIds: ['Q2'], anchorQuote: '两条表示只在共享语言主干会合。' },
                { heading: '公开比较支持整机而非组件因果', container: '实验结果', readerQuestionIds: ['Q3'], anchorQuote: '公开基准上主方法高于强基线。' },
                { heading: '部署证据仍然缺位', container: '局限与问题', readerQuestionIds: ['Q4'], anchorQuote: '论文没有报告设备延迟或组件消融。' }
            ]
        };
        const analysis = `## 核心摘要\n${plan.oneSentenceThesis}\n\n### 表示冲突先于统一接口\n理解与生成对表示的压缩率和可重建性提出相反要求。\n\n## 方法概述和架构\n### 两条通路只在语言主干会合\n两条表示只在共享语言主干会合。\n\n## 实验结果\n### 公开比较支持整机而非组件因果\n公开基准上主方法高于强基线。\n\n## 局限与问题\n### 部署证据仍然缺位\n论文没有报告设备延迟或组件消融。`;
        assert.doesNotThrow(() => validateEditorialPlanBindings(plan, analysis, [
            { id: 'E01' }, { id: 'E02' }, { id: 'E03' }, { id: 'E04' }
        ]));
        assert.throws(() => validateEditorialPlanBindings(
            plan, analysis.replace('### 两条通路只在语言主干会合', '### 错误标题'), [{ id: 'E01' }, { id: 'E02' }, { id: 'E03' }, { id: 'E04' }]
        ), /小节标题/);

        const sharedQuestionPlan = JSON.parse(JSON.stringify(plan));
        sharedQuestionPlan.sectionPlan[1].readerQuestionIds.push('Q1');
        assert.doesNotThrow(() => validateEditorialPlanBindings(
            sharedQuestionPlan, analysis, [{ id: 'E01' }, { id: 'E02' }, { id: 'E03' }, { id: 'E04' }]
        ));
    });

    it('v5 resultClaim 拒绝 CSV 字段串并要求同段自然比较句', () => {
        const claim = {
            datasetOrSetting: '公开测试集', splitOrCondition: '英语 RP', method: '主方法', baseline: '强基线',
            metric: 'ACC', value: '70.3', unit: '%', direction: '越高越好',
            sourceQuote: '公开测试集英语 RP中，主方法 ACC为70.3%，高于强基线64.2%。',
            sourceBindings: { datasetOrSetting: '公开测试集', splitOrCondition: '英语 RP', method: '主方法', baseline: '强基线', metric: 'ACC', value: '70.3', unit: '%', direction: '高于' },
            readerBindings: { datasetOrSetting: '公开测试集', splitOrCondition: '英语 RP', method: '主方法', baseline: '强基线', metric: 'ACC', value: '70.3', unit: '%', direction: '越高越好' },
            readerNarrative: '主方法，英语 RP，强基线，ACC，70.3%，越高越好。'
        };
        const readerResultsText = '在公开测试集的英语 RP 项上，主方法 ACC 为 70.3%，指标越高越好且高于强基线的 64.2%，但这一比较只覆盖论文报告的评测协议。';
        assert.equal(validateResultClaims([claim], claim.sourceQuote, {
            readerResultsText, requireReaderNarrative: true, minimumClaims: 1
        }).valid, false);
        claim.readerNarrative = readerResultsText;
        assert.equal(validateResultClaims([claim], claim.sourceQuote, {
            readerResultsText, requireReaderNarrative: true, minimumClaims: 1
        }).valid, true);
    });

    it('readerArticle 用论文特有叙事覆盖固定栏目，并逐项承接蓝图证据', () => {
        const plan = {
            version: 2,
            readerTitle: '两条表示如何统一听懂与生成音频',
            oneSentenceThesis: '论文把共享语言推理与分离音频表示结合，让理解压缩和生成还原不再争抢同一接口。',
            governingTension: { conflict: '紧凑理解表示和可重建生成表示在同一个接口会相互拉扯。', sideA: '理解希望压缩序列并保留任务语义。', sideB: '生成希望保留足够声学细节。', paperChoice: '语言推理共享，连续音频表示按任务分路。' },
            readerQuestions: [
                { id: 'Q1', question: '为何统一接口会同时伤害理解与生成？', purpose: '建立表示冲突。', evidenceIds: ['E01'], answerQuote: '紧凑理解表示和可重建生成表示不能由同一接口兼顾。' },
                { id: 'Q2', question: '两条通路如何在模型中分工？', purpose: '解释数据流。', evidenceIds: ['E02'], answerQuote: '两条通路只在共享语言推理层会合。' },
                { id: 'Q3', question: '哪些比较支持整机主张？', purpose: '核对公开证据。', evidenceIds: ['E03'], answerQuote: '公开基准上主方法高于强基线。' },
                { id: 'Q4', question: '结论还缺少什么证据？', purpose: '收束边界。', evidenceIds: ['E04'], answerQuote: '论文没有报告直接消融和设备延迟。' }
            ],
            evidencePillars: [
                { id: 'P1', claim: '公开比较支持整机能力。', strongestComparison: '主方法与强基线的公开测试比较。', boundary: '不能推出组件因果。', evidenceIds: ['E03'], readerQuote: '公开基准上主方法高于强基线。' },
                { id: 'P2', claim: '部署结论仍然有限。', strongestComparison: '论文没有同设备资源比较。', boundary: '不能外推为实时能力。', evidenceIds: ['E04'], readerQuote: '论文没有报告直接消融和设备延迟。' }
            ],
            sectionPlan: [
                { heading: '先拆开表示冲突', container: '核心摘要', readerQuestionIds: ['Q1'], anchorQuote: '紧凑理解表示和可重建生成表示不能由同一接口兼顾。' },
                { heading: '再追踪两条通路', container: '方法概述和架构', readerQuestionIds: ['Q2'], anchorQuote: '两条通路只在共享语言推理层会合。' },
                { heading: '用公开比较校准主张', container: '实验结果', readerQuestionIds: ['Q3'], anchorQuote: '公开基准上主方法高于强基线。' },
                { heading: '把未测部分留在边界内', container: '局限与问题', readerQuestionIds: ['Q4'], anchorQuote: '论文没有报告直接消融和设备延迟。' }
            ]
        };
        const paragraphs = Array.from({ length: 8 }, (_, index) => (
            `这是第 ${index + 1} 个实质段落，围绕本篇论文的输入表示、数据流、训练取舍和证据边界展开，避免把固定栏目名称当作结构。该段提供足够的上下文来解释为什么读者应当把机制、实验和外推范围连成一个论证。`.repeat(4)
        ));
        const article = `### 先拆开表示冲突\n\n紧凑理解表示和可重建生成表示不能由同一接口兼顾。${paragraphs[0]}\n\n${paragraphs[1]}\n\n### 再追踪两条通路\n\n两条通路只在共享语言推理层会合。${paragraphs[2]}\n\n${paragraphs[3]}\n\n### 用公开比较校准主张\n\n公开基准上主方法高于强基线。${paragraphs[4]}\n\n${paragraphs[5]}\n\n### 把未测部分留在边界内\n\n论文没有报告直接消融和设备延迟。${paragraphs[6]}\n\n${paragraphs[7]}`;
        assert.doesNotThrow(() => validateReaderArticle(plan, article, [
            { id: 'E01' }, { id: 'E02' }, { id: 'E03' }, { id: 'E04' }
        ]));
        const firstImage = 'https://arxiv.org/html/2608.29999/figure-1.png';
        const secondImage = 'https://arxiv.org/html/2608.29999/figure-2.png';
        const firstLead = '承接两条表示只在共享语言推理层会合，下图用于核对输入如何进入两条独立的连续表示通路。';
        const firstExplanation = '图中箭头显示两条连续表示在共享语言推理层汇合；该结构只说明论文绘出的数据流，不能单独证明每条通路的因果贡献。';
        const secondLead = '承接公开基准上主方法高于强基线，下图用于核对该比较覆盖的设置、指标方向和强基线位置。';
        const secondExplanation = '图中比较支持整机在所报告公开设置中优于强基线；它不替代直接组件消融，也不能外推为设备延迟结论。';
        const imageArticle = `${article}\n\n${firstLead}\n\n![表示通路图](${firstImage})\n\n${firstExplanation}\n\n${secondLead}\n\n![公开比较图](${secondImage})\n\n${secondExplanation}`;
        const imageOptions = {
            imageInsertions: [
                { url: firstImage, lead: firstLead, explanation: firstExplanation },
                { url: secondImage, lead: secondLead, explanation: secondExplanation }
            ]
        };
        assert.doesNotThrow(() => validateReaderArticle(plan, imageArticle, [
            { id: 'E01' }, { id: 'E02' }, { id: 'E03' }, { id: 'E04' }
        ], imageOptions));
        assert.throws(() => validateReaderArticle(plan, imageArticle.replace(
            `![表示通路图](${firstImage})`, firstImage
        ), [{ id: 'E01' }, { id: 'E02' }, { id: 'E03' }, { id: 'E04' }], imageOptions), /独立 !\[\]/);
        assert.throws(() => validateReaderArticle(plan, imageArticle.replace(
            firstImage, '__FIRST__'
        ).replace(secondImage, firstImage).replace('__FIRST__', secondImage), [
            { id: 'E01' }, { id: 'E02' }, { id: 'E03' }, { id: 'E04' }
        ], imageOptions), /按 imageInsertions 顺序/);
        assert.throws(() => validateReaderArticle(plan, article.replace('### 再追踪两条通路', '### 方法概述和架构'), [
            { id: 'E01' }, { id: 'E02' }, { id: 'E03' }, { id: 'E04' }
        ]), /sectionPlan/);
    });

    it('毒舌点评必须用两段同时评价优点和不足，并锚定深度解读', () => {
        const article = [
            '### 机制\n\n两条通路只在共享语言推理层会合。这一机制把理解与生成的表示冲突拆开处理，并让后续实验能够分别检验各自职责。',
            '### 证据\n\n公开基准上主方法高于强基线。该比较说明整机方案具备竞争力，但不能自行证明每个组件的因果贡献。',
            '### 边界\n\n论文没有报告直接消融和设备延迟。因此离线结果不应直接被解释为可部署的系统能力。'
        ].join('\n\n');
        const review = '这篇论文最扎实的优点，是两条通路只在共享语言推理层会合这一分工没有停在概念口号：它把冲突放在可检查的数据流位置，并且公开基准上主方法高于强基线，让“分开表示仍能协作”至少有整机证据支撑。更重要的是，这个取舍让研究者能把收益追溯到明确的表示接口，而不是接受一个只靠规模堆出来的黑箱结论。\n\n但最该泼冷水的地方也很明确：论文没有报告直接消融和设备延迟，所以读者还不知道收益究竟来自哪一条通路，也不能把离线公开比较外推成真实设备上的吞吐、时延或维护成本。它目前证明的是一个有竞争力的研究原型，不是已经完成资源、稳定性与维护代价核验的工程方案。';
        assert.doesNotThrow(() => validateEditorialReview(review, article));
        assert.throws(() => validateEditorialReview(review.replace('这篇论文最扎实的优点', '这篇论文的描述'), article), /优点/);
        assert.throws(() => validateEditorialReview(review.replace(/\n\n/, '\n'), article), /两段/);
    });

    it('阻断 TLIVE 异篇 961 帧污染，同时接受本篇 256K 与显式推导', () => {
        const source = 'TLive-Omni supports up to 256K tokens. A 119-frame video is sampled at 30 FPS.';
        const analysis = [
            '## 核心摘要\n模型支持 256K token。',
            '## 方法概述和架构\n采样示例包含 119 帧和 30 FPS。',
            '## 核心创新点\n无额外精确量。',
            '## 实验结果\n无额外精确量。',
            '## 细节详述\n无额外精确量。',
            '## 局限与问题\n论文没有报告 961 帧长流吞吐。',
            '## 开源详情\n未报告。'
        ].join('\n\n');
        assert.throws(
            () => validateExactFactCoverage(analysis, source, { label: '2608.20958' }),
            /961/
        );
        assert.doesNotThrow(() => validateExactFactCoverage(
            analysis.replace('961 帧', '256K token'), source, { label: '2608.20958' }
        ));
    });

    it('精确数量要求数字与单位在同一局部证据中，不能跨全文拼接', () => {
        const analysis = [
            '## 核心摘要\n研究招募 11 人并比较 24 configs。',
            '## 方法概述和架构\n训练设备为 A100。',
            '## 核心创新点\n无额外精确量。',
            '## 实验结果\n无额外精确量。',
            '## 细节详述\n无额外精确量。',
            '## 局限与问题\n无额外精确量。',
            '## 开源详情\n未报告。'
        ].join('\n\n');
        const splitEvidence = 'The model uses 11 layers. Participant recruitment is described elsewhere. The study compares configurations and runs on H100.';
        assert.throws(
            () => validateExactFactCoverage(analysis, splitEvidence, { label: 'local-quantity' }),
            /11人|24configs|A100/
        );
        const localEvidence = 'The study recruited 11 participants, compared 24 configs, and ran every experiment on A100 GPUs.';
        assert.doesNotThrow(
            () => validateExactFactCoverage(analysis, localEvidence, { label: 'local-quantity' })
        );
    });

    it('缺消融、内部评测和中置信度不能把系统报告打到 10 分', () => {
        const record = {
            dims: [1.7, 1.4, 1.5, 1, 1.5, 1.5, 0.4, 1],
            confidence: '中'
        };
        const brief = {
            evidenceProfile: {
                version: 1,
                ablationStatus: 'none',
                targetEvaluation: 'internal',
                sampleScaleReported: false,
                deploymentMeasured: false,
                publicGeneralizationEvaluated: true,
                evidenceBoundary: '目标域数据与样本规模没有公开，缺少任何组件消融，也没有真实延迟、吞吐、显存或在线部署测量。'
            }
        };
        assert.throws(
            () => validateResearchScoringCaps(record, brief, 'TLIVE'),
            /experimental_sufficiency|总分/
        );
    });

    it('系统报告 resultClaims 必须跨实验组并使用强基线', () => {
        const claims = Array.from({ length: 4 }, (_, index) => ({
            evidenceScope: 'target_domain',
            sourceGroup: 'Table 1',
            baselineType: 'sibling_size',
            unit: '%',
            sourceBindings: { direction: '越低越好', value: `${index + 1}.0` },
            readerBindings: { direction: 'WER↓', value: `${index + 1}.0` }
        }));
        assert.throws(() => validateResultClaimCoverageV5(claims, {
            documentType: '系统技术报告',
            evidenceProfile: { publicGeneralizationEvaluated: true, ablationStatus: 'none' },
            label: 'TLIVE.resultClaims'
        }), /至少 2 个|一半以上|public_generalization|强外部/);
    });

    it('resultClaims 接受准确性比较中的真实方向短语', () => {
        const sourceDirections = ['more accurate', 'rising', 'fewer steps', 'less accurate'];
        const readerDirections = ['更准确', '上升', '更少步骤', '准确率更低'];
        const claims = Array.from({ length: 4 }, (_, index) => ({
            evidenceScope: index === 0 ? 'target_domain' : 'qualitative',
            sourceGroup: index < 2 ? 'Figure 2' : 'Figure 3',
            baselineType: index === 0 ? 'external_strong' : 'sibling_size',
            unit: 'score',
            sourceBindings: { direction: sourceDirections[index], value: `${index + 1}.0` },
            readerBindings: { direction: readerDirections[index], value: `${index + 1}.0` }
        }));
        assert.doesNotThrow(() => validateResultClaimCoverageV5(claims, {
            documentType: '方法研究',
            evidenceProfile: { publicGeneralizationEvaluated: false, ablationStatus: 'none' },
            label: 'accuracy-direction.resultClaims'
        }));
    });

    it('图片 inventory 必须覆盖全部图并核对重复 caption identity', () => {
        const urls = ['https://arxiv.org/a.png', 'https://arxiv.org/b.png'];
        const review = {
            version: 1,
            decisions: urls.map((url, index) => ({
                url,
                decision: index === 0 ? 'select' : 'reject',
                reason: '逐图检查后根据研究价值、清晰度和正文职责作出选择。',
                figureNumber: `Figure ${index + 1}`,
                captionIdentity: 'Figure: qualitative examples shared caption',
                ...(index === 0 ? {
                    visibleFacts: ['图中包含音频编码器到语言主干的箭头', '右侧 inset 展示时间网格边界'],
                    renderPlan: { mode: 'crop', mobileReadable: true, cropDescription: '裁出右侧时间网格并保留模块名称。' }
                } : {})
            }))
        };
        assert.throws(() => validateFigureReview(review, {
            imageInfos: urls.map(url => ({ url })),
            selectedImageUrls: [urls[0]],
            paperId: '2608.20958'
        }), /duplicateCaptionConfirmed/);
        review.decisions[1].duplicateCaptionConfirmed = true;
        assert.doesNotThrow(() => validateFigureReview(review, {
            imageInfos: urls.map(url => ({ url })),
            selectedImageUrls: [urls[0]],
            paperId: '2608.20958'
        }));

        review.decisions[1].decision = 'select';
        review.decisions[1].visibleFacts = ['左侧面板显示输入声谱结构', '右侧面板显示输出时间边界'];
        review.decisions[1].renderPlan = { mode: 'full', mobileReadable: true };
        assert.throws(() => validateFigureReview(review, {
            imageInfos: urls.map(url => ({ url })),
            selectedImageUrls: [urls[1], urls[0]],
            paperId: '2608.20958'
        }), /同序/);
        assert.doesNotThrow(() => validateFigureReview(review, {
            imageInfos: urls.map(url => ({ url })),
            selectedImageUrls: [urls[1], urls[0]],
            selectedOrderFlexible: true,
            paperId: '2608.20958'
        }));
    });

    it('逐阶段审计不能省略或用未知 evidence ID', () => {
        const stages = ['primaryAnalysis', 'scoringAudit'];
        const payload = {
            version: 2,
            stages: Object.fromEntries(stages.map(stage => [stage, {
                decision: 'manual_verified',
                attempts: 2,
                evidenceIds: ['E01'],
                sourceQuotes: ['A source quote long enough for review.'],
                issues: [],
                conclusion: `${stage} 已按本篇证据独立核验并确认无需修复。`
            }]))
        };
        assert.doesNotThrow(() => validateStageReviews(payload, {
            stages,
            evidenceLedger: [{ id: 'E01' }],
            requireSourceBinding: false
        }));
        payload.stages.scoringAudit.evidenceIds = ['E99'];
        assert.throws(() => validateStageReviews(payload, {
            stages,
            evidenceLedger: [{ id: 'E01' }]
        }), /未知证据 ID/);
    });
});
