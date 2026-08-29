'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    stableSha256,
    tableNumericCellIds,
    renderArtifactTableMarkdown,
    sanitizeArtifactTableCellForReader,
    renderLongformBlocks,
    validateManualLongformBundle
} = require('../scripts/manual-longform-contract.js');
const {
    MANUAL_TUTORIAL_ORCHESTRATOR_CONTRACT,
    MANUAL_TUTORIAL_ORCHESTRATOR_FINGERPRINT,
    validateManualTutorialLongformBundle
} = require('../scripts/manual-tutorial-contract-orchestrator.js');

describe('Manual longform table reader rendering', () => {
    it('只清理 LaTeXML 可见文本与 TeX fallback 的确定性重影', () => {
        assert.equal(sanitizeArtifactTableCellForReader('binary {0,1}\\{0,1\\}'), 'binary {0,1}');
        assert.equal(sanitizeArtifactTableCellForReader('𝒰{3,…,7}\\mathcal{U}\\{3,\\ldots,7\\}'), 'U{3,...,7}');
        assert.equal(sanitizeArtifactTableCellForReader('F1F_{1}'), 'F1');
        assert.equal(sanitizeArtifactTableCellForReader('λ\\lambda'), '\\(\\lambda\\)');
        assert.equal(sanitizeArtifactTableCellForReader('Gain (Δ\\Delta)'), 'Gain (Δ)');
        assert.equal(sanitizeArtifactTableCellForReader('Δ​En\\Delta E_{n}'), 'ΔE_n');
        assert.equal(sanitizeArtifactTableCellForReader('Bigram Δ​E2\\Delta E_{2}'), 'Bigram ΔE2');
        assert.equal(sanitizeArtifactTableCellForReader('Trigram Δ​E3\\Delta E_{3}'), 'Trigram ΔE3');
        assert.equal(sanitizeArtifactTableCellForReader('Δ\\DeltaWER'), 'ΔWER');
        assert.equal(sanitizeArtifactTableCellForReader('16×\\times and A→\\rightarrow B'), '16× and A→ B');
        assert.equal(sanitizeArtifactTableCellForReader('✓\\checkmark / ✓\\mathbf{\\checkmark}'), '✓ / ✓');
        assert.equal(sanitizeArtifactTableCellForReader('τ\\tau-Voice / Cliff’s δ\\delta'), 'τ-Voice / Cliff’s δ');
        assert.equal(sanitizeArtifactTableCellForReader('γ\\gamma / θ\\theta'), 'γ / θ');
        assert.equal(sanitizeArtifactTableCellForReader('Groups carrying gradient (σi>0\\sigma_{i}>0)'), 'Groups carrying gradient (σ_i>0)');
        assert.equal(sanitizeArtifactTableCellForReader('NfftN_{\\text{fft}} / fcvf_{\\text{cv}}'), 'N_fft / f_cv');
        assert.equal(sanitizeArtifactTableCellForReader('RT60\\textrm{RT}_{60} / C50C_{50}'), 'RT60 / C50');
        assert.equal(sanitizeArtifactTableCellForReader('RT60=0.2\\mathrm{RT}_{60}=0.2 s'), 'RT60=0.2 s');
        assert.equal(sanitizeArtifactTableCellForReader('1st1^{\\text{st}} / 6th6^{\\text{th}}'), '1st / 6th');
        assert.equal(sanitizeArtifactTableCellForReader('k=1\\mathbf{k=1} / k=0k{=}0 / kk'), 'k=1 / k=0 / k');
        assert.equal(sanitizeArtifactTableCellForReader('1≤k<|S|1\\leq k<|S| / k=|S|k=|S|'), '1≤k<|S| / k=|S|');
        assert.equal(sanitizeArtifactTableCellForReader('N=(3,600,1,800)N=(3{,}600,1{,}800)'), 'N=(3,600,1,800)');
        assert.equal(sanitizeArtifactTableCellForReader('6 - 10 m\\mathrm{m} / 0.2 - 0.5 s\\mathrm{s}'), '6 - 10 m / 0.2 - 0.5 s');
        assert.equal(sanitizeArtifactTableCellForReader('Cohen’s dd'), 'Cohen’s d');
        assert.equal(
            sanitizeArtifactTableCellForReader('AdamW (β1=0.9,β2=0.999\\beta_{1}=0.9,\\beta_{2}=0.999)'),
            'AdamW (β1=0.9, β2=0.999)'
        );
        assert.equal(
            sanitizeArtifactTableCellForReader('Model ↓\\downarrow ∣\\mid Datasets →\\rightarrow'),
            'Model / Datasets'
        );
        assert.equal(
            sanitizeArtifactTableCellForReader('Model ↓\\downarrow ∣\\mid #Datasets →\\rightarrow'),
            'Model / #Datasets'
        );
        assert.equal(sanitizeArtifactTableCellForReader('N=15,000N=15{,}000, p<0.001p<0.001'), 'N=15,000, p<0.001');
        assert.equal(sanitizeArtifactTableCellForReader('−8%-8\\% / +20+20'), '−8% / +20');
        assert.equal(sanitizeArtifactTableCellForReader('λ=0.3\\lambda=0.3'), '\\(\\lambda=0.3\\)');
        assert.equal(sanitizeArtifactTableCellForReader('EtE_{t} / HtH_{t} / J​StJS_{t}'), '\\(E_t\\) / \\(H_t\\) / \\(JS_t\\)');
        assert.equal(sanitizeArtifactTableCellForReader('∼\\bm{\\sim} indicates partial support'), '~ indicates partial support');
        assert.equal(sanitizeArtifactTableCellForReader('Random, p=0.5p=0.5'), 'Random, p=0.5');
        assert.equal(sanitizeArtifactTableCellForReader('12.3\\bf 12.3'), '12.3');
        assert.equal(sanitizeArtifactTableCellForReader('−0.90\\mathbf{-0.90}'), '−0.90');
        assert.equal(sanitizeArtifactTableCellForReader('±1.12\\pm 1.12 / ±1.39\\pm 1.39'), '±1.12 / ±1.39');
        assert.equal(sanitizeArtifactTableCellForReader('35.1±235.1\\pm 2'), '35.1±2');
        assert.equal(sanitizeArtifactTableCellForReader('12.3±𝟐\\bf 12.3\\pm 2'), '12.3±2');
        assert.equal(sanitizeArtifactTableCellForReader('Silence threshold 2.02.0 s'), 'Silence threshold 2.0 s');
        assert.equal(sanitizeArtifactTableCellForReader('Scored speeches 130130'), 'Scored speeches 130');
        assert.equal(sanitizeArtifactTableCellForReader('user_11 and 22 folds'), 'user_11 and 22 folds');
        assert.equal(sanitizeArtifactTableCellForReader('0.9790.979'), '0.979');
        assert.equal(sanitizeArtifactTableCellForReader('−0.715-0.715'), '−0.715');
        assert.equal(sanitizeArtifactTableCellForReader('CI [−0.15,+0.08][−0.15,+0.08]'), 'CI [−0.15,+0.08]');
        assert.equal(sanitizeArtifactTableCellForReader('95%95\\% CIs'), '95% CIs');
        assert.equal(sanitizeArtifactTableCellForReader('≥1\\geq 1'), '≥1');
        assert.equal(sanitizeArtifactTableCellForReader('Underpowered (<100<100 pairs)'), 'Underpowered (<100 pairs)');
        assert.equal(sanitizeArtifactTableCellForReader('most artists have degree 00–11'), 'most artists have degree 0–1');
        assert.equal(sanitizeArtifactTableCellForReader('140×80140\\times 80 matrix'), '140×80 matrix');
        assert.equal(sanitizeArtifactTableCellForReader('3×10−53\\times 10^{-5}'), '3×10^-5');
        assert.equal(sanitizeArtifactTableCellForReader('2×10−52\\times 10^{-5}'), '2×10^-5');
        assert.equal(sanitizeArtifactTableCellForReader('ρ\\rho (n=130n=130)'), 'ρ (n=130)');
        assert.equal(sanitizeArtifactTableCellForReader('≈0.99\\approx 0.99'), '≈0.99');
        assert.equal(sanitizeArtifactTableCellForReader('WER 12.3'), 'WER 12.3');
        assert.equal(
            sanitizeArtifactTableCellForReader('Label quality is measured on 55K samples, and ranking performance is assessed via Hit@1 on 11K, respectively.'),
            'Label quality is measured on 5K samples, and ranking performance is assessed via Hit@1 on 1K, respectively.'
        );
        assert.equal(
            sanitizeArtifactTableCellForReader('(A+V−Ours)/A+V(\\text{A+V}-\\text{Ours})/\\text{A+V}'),
            '(A+V−Ours)/A+V'
        );
    });

    it('把 LaTeXML 伪 colspan 的 contrast 行只路由到匹配样本量列', () => {
        const rendered = renderArtifactTableMarkdown({
            id: 'T04', caption: 'Contrasts', matrix: [
                ['Arm', 'rho (n=130)', 'rho (n=125 diar.)'],
                ['Contrasts, official n=130:', 'Contrasts, official n=130:', 'Contrasts, official n=130:'],
                ['B − A', '−0.069, CI [−0.15,+0.08]', '−0.069, CI [−0.15,+0.08]'],
                ['Contrasts, diarization n=125:', 'Contrasts, diarization n=125:', 'Contrasts, diarization n=125:'],
                ['B − A', '−0.086', '−0.086']
            ]
        });
        assert.match(rendered, /\| B − A \| −0\.069, CI \[−0\.15,\+0\.08\] \|  \|/u);
        assert.match(rendered, /\| B − A \|  \| −0\.086 \|/u);
    });

    it('按结构化 colspan 去掉重复组名并确定性标注指标方向', () => {
        const rendered = renderArtifactTableMarkdown({
            id: 'T05', caption: 'Table 5: MRR and EM comparison.',
            cells: [
                { row: 0, column: 1, colspan: 2, text: 'MS MARCO' },
                { row: 0, column: 3, colspan: 2, text: 'Spoken SQuAD' }
            ],
            matrix: [
                ['Backbone', 'MS MARCO', 'MS MARCO', 'Spoken SQuAD', 'Spoken SQuAD'],
                ['', 'Hit@1', 'NDCG@5', 'Single', 'Mixed'],
                ['Model A', '0.78', '0.79', '0.40', '0.41']
            ]
        });
        assert.match(rendered, /\| Backbone \| MS MARCO \/ Hit@1 ↑ \| MS MARCO \/ NDCG@5 ↑ \| Spoken SQuAD \/ Single ↑ \| Spoken SQuAD \/ Mixed ↑ \|/u);
        assert.doesNotMatch(rendered, /\| MS MARCO \| MS MARCO \|/u);
    });

    it('把明确标记的多级 HTML 表头扁平化为单行可读 Markdown 表头', () => {
        const rendered = renderArtifactTableMarkdown({
            id: 'T06', caption: 'Table 6: grouped results.',
            cells: [
                { row: 0, column: 0, colspan: 1, header: true, text: '' },
                { row: 0, column: 1, colspan: 2, header: true, text: 'Inputs' },
                { row: 1, column: 0, colspan: 1, header: true, text: 'Model' },
                { row: 1, column: 1, colspan: 1, header: true, text: 'Audio' },
                { row: 1, column: 2, colspan: 1, header: true, text: 'Video' },
                // LaTeXML may incorrectly mark numeric body rows as headers;
                // the first measurement row remains a deterministic fallback.
                { row: 2, column: 0, colspan: 1, header: true, text: 'A' }
            ],
            matrix: [
                ['', 'Inputs', 'Inputs'],
                ['Model', 'Audio', 'Video'],
                ['A', '0.8', '0.7']
            ]
        });
        assert.match(rendered, /\| Model \| Inputs \/ Audio \| Inputs \/ Video \|/u);
        assert.doesNotMatch(rendered, /^\| Model \| Audio \| Video \|$/mu);
    });

    it('保留全宽分组标签及其后的默认配置数据行，不把它们塞进表头', () => {
        const rendered = renderArtifactTableMarkdown({
            id: 'T-grouped', caption: 'Grouped configurations', headerRows: [0, 1, 2, 3],
            matrix: [
                ['Architecture', 'Layer', 'Language', 'Hours', 'P@10'],
                ['Default configuration', 'Default configuration', 'Default configuration', 'Default configuration', 'Default configuration'],
                ['HuBERT Base', '7', 'English', '960', '49.9'],
                ['Other configurations', 'Other configurations', 'Other configurations', 'Other configurations', 'Other configurations'],
                ['mHuBERT', '8', 'Multilingual', '90k', '50.7']
            ],
            cells: [
                { row: 1, column: 0, header: true, colspan: 5, text: 'Default configuration' },
                { row: 2, column: 0, header: true, text: 'HuBERT Base' },
                { row: 2, column: 1, header: true, text: '7' },
                { row: 2, column: 2, header: true, text: 'English' },
                { row: 2, column: 3, header: true, text: '960' },
                { row: 2, column: 4, header: true, text: '49.9' },
                { row: 3, column: 0, header: true, colspan: 5, text: 'Other configurations' },
                { row: 4, column: 0, header: false, text: 'mHuBERT' }
            ]
        });
        assert.match(rendered, /\| Architecture \| Layer \| Language \| Hours \| P@10 \|/u);
        assert.match(rendered, /\| Default configuration \| {1,2}\| {1,2}\| {1,2}\| {1,2}\|/u);
        assert.match(rendered, /\| HuBERT Base \| 7 \| English \| 960 \| 49\.9 \|/u);
        assert.doesNotMatch(rendered, /Architecture \/ Default configuration/u);
    });

    it('为空的比较表首列表头提供确定性可访问标签', () => {
        const rendered = renderArtifactTableMarkdown({
            id: 'T07', caption: 'Table 7: process comparison.', matrix: [
                ['', 'Process', 'Outcome-only'],
                ['Groups carrying gradient', '99.6%', '16%']
            ]
        });
        assert.match(rendered, /^\| Metric \| Process \| Outcome-only \|$/mu);
    });
});

function fixture() {
    const artifactIndex = {
        outputSha256: 'a'.repeat(64),
        sourceSpans: Array.from({ length: 4 }, (_, index) => ({ id: `S0${index + 1}` })),
        tables: [{
            id: 'T01', kind: 'result', caption: 'Table 1. Public benchmark results',
            matrix: [['System', 'WER'], ['Strong baseline', '10.0'], ['Proposed', '8.0']],
            matrixSha256: 'b'.repeat(64)
        }],
        figures: [{ id: 'F01', url: 'https://arxiv.org/html/2608.12345/figure1.png' }],
        formulas: [{ id: 'M01', raw: '$$L=L_{asr}+0.2L_{gen}$$' }],
        acronyms: [{ id: 'A01' }],
        citations: [{ id: 'C01' }, { id: 'C02' }]
    };
    const renderedTable = renderArtifactTableMarkdown(artifactIndex.tables[0]);
    const visibleFact = '图中两条音频路径在共享主干前保持分离。';
    const termDefinition = 'AEC 表示声学回声消除任务，用于压制扬声器回灌。';
    const formulaExplanation = '这个目标把识别损失作为主约束，并用 0.2 权重保留生成路径所需的连续声学细节。';
    const relationships = [
        ['同属分离表示路线并共享公开评测设置。', '该工作只处理理解任务，没有可重建生成路径。'],
        ['提供统一接口的强基线和直接比较对象。', '统一接口压缩了生成所需的连续声学细节。']
    ];
    const blocks = [
        ['B01', 'prerequisites', '先补齐理解论文所需前置概念'],
        ['B02', 'problem', '再把任务冲突说清楚'],
        ['B03', 'related_work', '相关路线为何仍不够'],
        ['B04', 'signal_path', '沿着音频信号追踪数据流'],
        ['B05', 'architecture', '组件如何在主干中会合'],
        ['B06', 'training', '训练目标怎样约束两条路径'],
        ['B07', 'experiment_setup', '实验设置如何保证比较公平'],
        ['B08', 'result', '公开结果回答了什么'],
        ['B09', 'ablation', '消融把整机收益拆开'],
        ['B10', 'reproduction', '复现时必须锁定哪些条件'],
        ['B11', 'limitation', '证据边界停在哪里']
    ].map(([id, kind, heading], index) => ({
        id, kind, heading,
        learningObjective: `理解第 ${index + 1} 个递进节点在论文论证中的具体职责。`,
        markdown: `这一段围绕${heading}展开，并使用本篇论文的局部证据解释输入、方法选择、比较设置和结论边界。为了让入门研究生能够顺着信号路径理解，段落明确交代前因、组件职责、实验问题以及不能外推的部分。读者可以据此区分论文直接报告的事实、由比较支持的判断，以及仍然需要额外实验才能确认的推断。`,
        evidenceSpanIds: [`S${String(Math.min(index + 1, 4)).padStart(2, '0')}`],
        tableIds: kind === 'result' || kind === 'ablation' ? ['T01'] : [],
        figureIds: kind === 'signal_path' ? ['F01'] : [],
        formulaIds: kind === 'training' ? ['M01'] : []
    }));
    blocks[0].markdown += ` ${termDefinition}`;
    blocks[2].markdown += ` ${relationships.map(pair => pair.join(' ')).join(' ')}`;
    blocks[3].markdown += ` ![论文架构图](${artifactIndex.figures[0].url}) ${visibleFact}`;
    blocks[5].markdown += ` ${artifactIndex.formulas[0].raw} ${formulaExplanation}`;
    blocks[7].markdown += `\n\n${renderedTable}`;
    const article = renderLongformBlocks(blocks);
    const bundle = {
        version: 2,
        contract: 'reader-longform-v2',
        paperId: '2608.12345',
        artifactIndexSha256: artifactIndex.outputSha256,
        articleSha256: stableSha256(article),
        authorReceipt: {
            taskName: 'paper-2608.12345-authoring', paperId: '2608.12345',
            singlePaperOnly: true, isolatedContext: true,
            model: 'gpt-5.6-terra', reasoningEffort: 'high',
            inputPacketSha256: 'd'.repeat(64), articleSha256: 'e'.repeat(64),
            queuedAt: '2026-08-28T08:00:00+08:00',
            startedAt: '2026-08-28T08:01:00+08:00',
            completedAt: '2026-08-28T08:31:00+08:00', revision: 1
        },
        finalRevisionAuthorReceipt: {
            role: 'author_revision',
            taskName: 'paper-2608.12345-author-revision', paperId: '2608.12345',
            singlePaperOnly: true, isolatedContext: true,
            model: 'gpt-5.6-terra', reasoningEffort: 'high',
            consumedPacketSha256: 'f'.repeat(64), outputSha256: '1'.repeat(64),
            articleSha256: stableSha256(article),
            queuedAt: '2026-08-28T09:00:00+08:00',
            startedAt: '2026-08-28T09:01:00+08:00',
            completedAt: '2026-08-28T09:31:00+08:00', revision: 1
        },
        blocks,
        tables: [{
            sourceTableId: 'T01', kind: 'result', disposition: 'appendix',
            sourceMatrixSha256: 'b'.repeat(64), numericCellCount: 2,
            coveredNumericCellIds: tableNumericCellIds(artifactIndex.tables[0]),
            blockId: 'B08', renderedMarkdown: renderedTable,
            renderedFragmentSha256: stableSha256(renderedTable)
        }],
        figures: [{ id: 'F01', disposition: 'inline', blockId: 'B04', visibleFacts: [visibleFact] }],
        formulas: [{ id: 'M01', disposition: 'inline', blockId: 'B06', explanation: formulaExplanation }],
        terms: [{ id: 'A01', term: 'AEC', definition: termDefinition, firstUseBlockId: 'B01' }],
        relatedWorks: [
            { citationId: 'C01', relationship: relationships[0][0], difference: relationships[0][1], blockId: 'B03' },
            { citationId: 'C02', relationship: relationships[1][0], difference: relationships[1][1], blockId: 'B03' }
        ]
    };
    return { article, artifactIndex, bundle };
}

describe('Manual v6 longform contract', () => {
    it('接受可逐字重放并完整处置表图公式的教学正文', () => {
        const { article, artifactIndex, bundle } = fixture();
        const result = validateManualLongformBundle(bundle, article, artifactIndex, {
            paperId: '2608.12345'
        });
        assert.equal(result.blockCount, 11);
        assert.equal(result.tableCount, 1);
        const orchestrated = validateManualTutorialLongformBundle(
            bundle, article, artifactIndex, { paperId: '2608.12345' }
        );
        assert.equal(orchestrated.contract, MANUAL_TUTORIAL_ORCHESTRATOR_CONTRACT);
        assert.equal(orchestrated.fingerprint, MANUAL_TUTORIAL_ORCHESTRATOR_FINGERPRINT);
        assert.equal(orchestrated.validation.blockCount, result.blockCount);
    });

    it('只要求定义正文实际使用的术语，相关工作使用至少两个真实引用', () => {
        const { article, artifactIndex, bundle } = fixture();
        artifactIndex.acronyms.push({ id: 'A02', value: 'UNUSED' });
        artifactIndex.citations.push({ id: 'C03', value: '[99]' });
        assert.doesNotThrow(() => validateManualLongformBundle(bundle, article, artifactIndex));

        const usedWithoutDefinition = structuredClone(bundle);
        usedWithoutDefinition.blocks[0].markdown += ' UNUSED';
        const usedArticle = renderLongformBlocks(usedWithoutDefinition.blocks);
        usedWithoutDefinition.articleSha256 = stableSha256(usedArticle);
        usedWithoutDefinition.finalRevisionAuthorReceipt.articleSha256 = usedWithoutDefinition.articleSha256;
        assert.throws(
            () => validateManualLongformBundle(usedWithoutDefinition, usedArticle, artifactIndex),
            /正文实际使用/
        );

        const oneRelatedWork = structuredClone(bundle);
        oneRelatedWork.relatedWorks.pop();
        assert.throws(
            () => validateManualLongformBundle(oneRelatedWork, article, artifactIndex),
            /至少 2 个真实/
        );
    });

    it('revision submit 可在未注入 receipt 时完整重放 longform，但拒绝提前伪造 receipt', () => {
        const { article, artifactIndex, bundle } = fixture();
        delete bundle.authorReceipt;
        delete bundle.finalRevisionAuthorReceipt;
        assert.doesNotThrow(() => validateManualLongformBundle(bundle, article, artifactIndex, {
            paperId: '2608.12345', runtimeMode: 'production', unsealedRevision: true
        }));
        bundle.authorReceipt = { taskName: 'premature-receipt' };
        assert.throws(() => validateManualLongformBundle(bundle, article, artifactIndex, {
            paperId: '2608.12345', runtimeMode: 'production', unsealedRevision: true
        }), /不得提前注入/);
    });

    it('结果表不能省略或漏掉数值单元格', () => {
        const { article, artifactIndex, bundle } = fixture();
        bundle.tables[0].coveredNumericCellIds.pop();
        assert.throws(() => validateManualLongformBundle(bundle, article, artifactIndex), /100%/);
        bundle.tables[0].coveredNumericCellIds = tableNumericCellIds(artifactIndex.tables[0]);
        bundle.tables[0].disposition = 'omit';
        bundle.tables[0].omissionReason = '即使提供原因，结果表也必须进入正文或完整数据附录。';
        assert.throws(() => validateManualLongformBundle(bundle, article, artifactIndex), /不能.*省略/);
    });

    it('完整确定性长表不触发自然语言 1200 字段落限制', () => {
        const { artifactIndex, bundle } = fixture();
        artifactIndex.tables[0].matrix = [
            ['System', 'WER'],
            ...Array.from({ length: 55 }, (_, index) => [`Baseline-${index + 1}`, `${10 + index / 10}`])
        ];
        artifactIndex.tables[0].matrixSha256 = 'c'.repeat(64);
        const prior = bundle.tables[0].renderedMarkdown;
        const rendered = renderArtifactTableMarkdown(artifactIndex.tables[0]);
        assert.ok(rendered.length > 1200);
        bundle.blocks[7].markdown = bundle.blocks[7].markdown.replace(prior, rendered);
        const numericCellIds = tableNumericCellIds(artifactIndex.tables[0]);
        bundle.tables[0] = {
            ...bundle.tables[0], sourceMatrixSha256: artifactIndex.tables[0].matrixSha256,
            numericCellCount: numericCellIds.length,
            coveredNumericCellIds: numericCellIds,
            renderedMarkdown: rendered,
            renderedFragmentSha256: stableSha256(rendered)
        };
        const article = renderLongformBlocks(bundle.blocks);
        bundle.articleSha256 = stableSha256(article);
        bundle.finalRevisionAuthorReceipt.articleSha256 = bundle.articleSha256;
        assert.doesNotThrow(() => validateManualLongformBundle(bundle, article, artifactIndex, {
            paperId: '2608.12345'
        }));
    });

    it('拒绝正文重放漂移、漏处置图片和内部 schema 泄露', () => {
        const { article, artifactIndex, bundle } = fixture();
        assert.throws(() => validateManualLongformBundle(bundle, `${article}\n额外文本`, artifactIndex), /逐字重放/);
        const missingFigure = structuredClone(bundle);
        missingFigure.figures = [];
        assert.throws(() => validateManualLongformBundle(missingFigure, article, artifactIndex), /未逐项处置/);
        const leaked = structuredClone(bundle);
        leaked.blocks[0].markdown += ' sourceBindings 字段必须通过。';
        const leakedArticle = renderLongformBlocks(leaked.blocks);
        leaked.articleSha256 = stableSha256(leakedArticle);
        assert.throws(() => validateManualLongformBundle(leaked, leakedArticle, artifactIndex), /schema\/validator/);
    });

    it('要求真实的单篇 author 排队、开始、完成和修订遥测', () => {
        const { article, artifactIndex, bundle } = fixture();
        bundle.authorReceipt.startedAt = '2026-08-28T07:59:00+08:00';
        assert.throws(() => validateManualLongformBundle(bundle, article, artifactIndex), /queuedAt.*startedAt/);
        bundle.authorReceipt.startedAt = '2026-08-28T08:01:00+08:00';
        bundle.authorReceipt.model = 'gpt-5.6-sol';
        assert.throws(() => validateManualLongformBundle(bundle, article, artifactIndex), /terra\/high/);
    });

    it('production 保留初稿 receipt，并只允许独立 author_revision 绑定最终正文', () => {
        const { article, artifactIndex, bundle } = fixture();
        assert.notEqual(bundle.authorReceipt.articleSha256, bundle.articleSha256);
        assert.equal(bundle.finalRevisionAuthorReceipt.articleSha256, bundle.articleSha256);
        const missingFinal = structuredClone(bundle);
        delete missingFinal.finalRevisionAuthorReceipt;
        assert.throws(
            () => validateManualLongformBundle(missingFinal, article, artifactIndex),
            /finalRevisionAuthorReceipt/
        );
        assert.doesNotThrow(() => validateManualLongformBundle(
            { ...missingFinal, authorReceipt: {
                ...missingFinal.authorReceipt, articleSha256: missingFinal.articleSha256
            } },
            article,
            artifactIndex,
            { runtimeMode: 'shadow' }
        ));
        const driftedFinal = structuredClone(bundle);
        driftedFinal.finalRevisionAuthorReceipt.articleSha256 = '0'.repeat(64);
        assert.throws(
            () => validateManualLongformBundle(driftedFinal, article, artifactIndex),
            /唯一绑定最终 readerArticle/
        );
    });
});
