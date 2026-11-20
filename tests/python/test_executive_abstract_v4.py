"""Executive Abstract v4 dual-fingerprint protocol, semantic, cold-replay, and page/index binding tests."""
import copy
import hashlib
import json
from pathlib import Path
import re
import sys
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import core_summary_format as csf
import protocol_codec as protocols
from project_env_isolation import isolate_module_environment, restore_environment_after
from test_publish_to_blog import (
    llm_api_publication_fixture,
    publish_to_blog as publisher,
    reseal_llm_api_reader_fixture,
)

setUpModule, tearDownModule = isolate_module_environment()

OLD_SUMMARY_FP = '0492b17abed5cb34bcd340790cb9bd803e79c59b2e7bbb08a13de750e0f66ba6'
NEW_SUMMARY_FP = 'f4354643c215dba4717d9769a310db87adafec301da7ec30434c8f43c1ef8f99'

EXECUTIVE_SOURCE_TEXT = (
    'We address streaming low-bitrate speech coding at 1.5 kbps on 16 kHz mono waveforms. '
    'Conventional residual vector quantization codecs entangle speaker timbre and phonetic content across 8 codebooks at 50 Hz, '
    'causing severe intelligibility collapse under ultra-low bitrates. '
    'Our DualStreamCodec uses a frozen WavLM-Large teacher and a causal Conformer encoder operating at 25 Hz frame rate with 512 hidden dimensions '
    'and 84.5M trainable parameters. '
    'On the LibriSpeech test-clean benchmark under the 1.5 kbps streaming setting, DualStreamCodec reduces WER from 9.84% (Mimi baseline) to 6.15%, '
    'while improving UTMOS from 3.42 to 3.96 and speaker similarity SpkSim from .763.763 to 0.841. '
    'Removing the disentangled prosody bottleneck degrades WER from 6.15% back to 8.27%. '
    'Streaming inference incurs 28.5 ms lookahead latency with real-time factor RTF of 0.14 on a single GPU and 1.45s cold-start compilation. '
    'Evaluation is limited to clean and moderate-reverberation English and Mandarin speech; overlapping multi-speaker mixtures remain unverified.'
)

FOUR_PARAGRAPH_EXECUTIVE_SUMMARY = '\n\n'.join([
    '**问题与瓶颈：**流式超低码率语音编解码任务需要将 16 kHz 单声道连续语音波形实时压缩为离散比特流并高保真重建语音波形，核心矛盾在于极端带宽预算下语义可懂度与声学音色自然度彼此挤占码本容量。现有主流残差向量量化编解码器普遍在 50 Hz 帧率的多层码本中把说话人音色、局部基频韵律与音素内容耦合建模。一旦总传输码率压低至 1.5 kbps，高层残差码本被迫截断，导致清辅音瞬态包络丢失与下游识别词错率急剧恶化，难以支撑弱网实时语音交互与大模型语音接口。',
    '**核心思路与方法架构：**本文的核心洞察是在离散化之前沿时间尺度对慢变全局声学属性与快变局部音素内容实施显式正交解耦，从而把宝贵的序列比特预算集中留给高频变化的音素序列。模型整体为包含 84.5M 可训练参数的因果双流编解码架构，首先由 512 维因果 Conformer 编码器将连续输入波形下采样映射为 25 Hz 帧率隐表征，其中冻结权重的预训练 WavLM-Large 教师模型通过中间层蒸馏损失引导语义分支量化生成单码本离散内容令牌，而并行的全局条件分支通过因果注意力池化提取句级音色嵌入向量并在流匹配声码器解码阶段经自适应层归一化注入频谱重构主干，由此在不额外消耗帧级码率的前提下恢复说话人身份特征并消除音色信息对语义码本的干扰。',
    '**关键实验与核心代价：**作者在 LibriSpeech test-clean 主基准的 1.5 kbps 流式评测设置下将本文系统与最强流式基线 Mimi 进行了严格同码率对照。实验结果显示转写词错率 WER 从 9.84% 显著降低至 6.15%，主观自然度预测分 UTMOS 从 3.42 提升至 3.96，同时说话人余弦相似度 SpkSim 也从 0.763 提升至 0.841（两句跨句组合完成数据集、比较对象与多指标对比）。关键消融实验进一步证实，若移除正交韵律信息瓶颈约束，词错率 WER 会从 6.15% 明显回升至 8.27%，说明解耦机制而非单纯参数规模贡献了主要可懂度增益。该方案付出的核心工程代价是流式推理需引入 28.5 ms 因果前瞻窗口延迟与 1.45s 首次图编译冷启动耗时，单张 GPU 上的推理实时率 RTF 为 0.14。',
    '**适用边界与深读导览：**上述实验结论目前仅在干净朗读及中等室内混响的英语与普通话单说话人语料上得到验证。面对多人重叠抢话、强非平稳突发背景噪声以及零样本跨语种歌唱音色迁移场景尚未覆盖，极端低信噪比下仍可能出现局部清浊音切换失真。读者若希望深入核查正交信息瓶颈的变分互信息上界推导、25 Hz 因果卷积块掩码细节或不同码率档位下的逐层消融曲线，可针对性阅读下方长文的方法推导与实验消融章节。',
])

ZERO_TRAINING_SOURCE_TEXT = (
    'We study training-free identifiability diagnostics for linear audio source separation matrices on 2-channel reverberant mixtures. '
    'Existing blind separation metrics require ground-truth isolated sources and fail to distinguish permutation ambiguity from subspace collapse. '
    'Our closed-form Gram-condition diagnostic computes frequency-binned cross-spectral singular values via 1024-point STFT and projects '
    'estimated demixing filters onto orthogonal frequency subspaces without neural network training. '
    'On the SMS-WSJ benchmark across 500 reverberant mixtures, our diagnostic achieves Spearman rank correlation of 0.892 with true SI-SDR, '
    'outperforming the Kurtosis-proxy baseline correlation of 0.614. '
    'Closed-form SVD evaluation takes 12.4 ms per mixture on CPU. '
    'The theoretical guarantee breaks down under nonlinear clipping distortion above 5% sample saturation.'
)

THREE_PARAGRAPH_THEORY_SUMMARY = '\n\n'.join([
    '**问题与瓶颈：**双通道混响混合音频的盲源分离可辨识性诊断任务以观测混合波形与待测解混矩阵为输入、以分离质量可信度评分为输出，实际瓶颈在于真实远场部署现场根本不存在干净独立参考源。现有无参考代理指标普遍依赖输出信号的峰度或非高斯性高阶统计量。这类统计代理无法区分良性的频点通道排列置换与致命的子空间秩亏坍缩，导致解混滤波器组在混响退化下发生声源混叠时仍给出严重虚高的置信评分，误导自适应前端门控决策。',
    '**核心思路与方法架构：**本文利用室内混响声场跨频带空间相干结构的局部几何不变性，提出一套完全免训练的闭式谱条件诊断框架，无需任何神经网络训练、反向传播或领域微调即可精确定位子空间退化频段。系统首先对双通道观测信号执行 1024 点短时傅里叶变换以提取频带跨谱协方差矩阵。随后诊断求解器通过闭式奇异值分解计算相邻频带解混滤波器的正交子空间投影残差与格拉姆矩阵条件数。最后算子将病态频点上的噪声放大因子按能量加权聚合为全局可辨识度指标，从代数结构上剥离了通道排列顺序对可分性判据的干扰。',
    '**关键实验与适用边界：**作者在 SMS-WSJ 混响分离基准的 500 条测试混合音频上对闭式诊断算子与传统统计代理进行了系统对照。实验表明本文诊断指标与真实信号失真比 SI-SDR 的斯皮尔曼秩相关系数达到 0.892，大幅高于传统峰度代理基线的 0.614。消融对比还验证了跨频带正交投影比单频点独立条件数更能抑制窄带共振峰引起的误报。整套闭式奇异值分解在普通单核 CPU 上处理每条混合音频仅耗时 12.4 ms，无任何模型训练或显卡显存开销。该线性可辨识性上界仅在满足线性时不变卷积混响假设时严格成立，当麦克风前端出现超过 5% 样本饱和的非线性削波失真时闭式正交性假设将失效；关于格拉姆条件数扰动上界证明与窗长敏感度分析可重点阅读下方长文的理论推导章节。',
])


def _reseal_publication_paper_with_summary(paper, summary_text, core_header, source_text=None):
    paper = copy.deepcopy(paper)
    clean_summary = summary_text.strip()
    old_analysis = paper['analysis']
    new_analysis = re.sub(
        r'## 核心摘要\n[\s\S]*?(?=\n## 方法概述和架构)',
        f'## 核心摘要\n{clean_summary}\n',
        old_analysis,
        count=1,
    )
    paper['analysis'] = new_analysis
    paper['analysisStageCheckpoints'] = {'structureRepair': new_analysis}
    paper['parsed']['summary'] = clean_summary
    analysis_sha = publisher._javascript_string_sha256(new_analysis)
    summary_sha = publisher._javascript_string_sha256(clean_summary)
    projection_sha = publisher._analysis_sha256_ignoring_core_summary_body(new_analysis)

    header_dict = csf.read_declaration(core_header)
    assert header_dict is not None
    stage_fields = csf.stage_fields(header_dict)
    binding = {
        **stage_fields,
        'inputAnalysisSha256': analysis_sha,
        'outputAnalysisSha256': analysis_sha,
        'inputSummarySha256': summary_sha,
        'summarySha256': summary_sha,
        'inputStructureProjectionSha256': projection_sha,
        'outputStructureProjectionSha256': projection_sha,
    }
    paper['analysisManifest']['contracts']['coreSummary'] = core_header
    paper['analysisManifest']['stages']['structureRepair']['outputAnalysisSha256'] = analysis_sha
    paper['analysisManifest']['stages']['coreSummaryRepair'] = {
        'status': 'complete',
        'fingerprint': '5' * 64,
        **binding,
        'bindingSha256': publisher._stable_json_sha256(binding),
    }
    scoring = paper['analysisManifest']['stages']['scoringAudit']
    scoring['outputAnalysisSha256'] = analysis_sha
    scoring['coreSummaryInputAnalysisSha256'] = analysis_sha
    scoring['inputCoreSummarySha256'] = summary_sha
    scoring['outputCoreSummarySha256'] = summary_sha

    if source_text is not None:
        resource_line = '- 代码：https://github.com/example/audio-model'
        full_source = f'{source_text}\n{resource_line}\n'
        source_sha = hashlib.sha256(full_source.encode('utf-8')).hexdigest()
        paper['sourceSha256'] = source_sha
        paper['analysisManifest']['sourceAcquisition']['sourceSha256'] = source_sha
        paper['apiReaderAuthors']['identity']['sourceTextSha256'] = source_sha
        paper['apiReaderAuthors']['identitySha256'] = publisher._stable_json_sha256(
            paper['apiReaderAuthors']['identity']
        )
        paper['analysisManifest']['stages']['apiReaderArticle']['readerAuthorIdentitySha256'] = (
            paper['apiReaderAuthors']['identitySha256']
        )
        paper['analysisManifest']['stages']['apiReaderArticle']['readerAuthorsSha256'] = (
            publisher._stable_json_sha256(paper['apiReaderAuthors'])
        )
        paper['apiReaderResources']['sourceTextSha256'] = source_sha
        paper['apiReaderResources']['identitySha256'] = publisher._stable_json_sha256({
            'contract': paper['apiReaderResources']['contract'],
            'sourceTextSha256': source_sha,
            'resources': paper['apiReaderResources']['resources'],
        })
        paper['analysisManifest']['stages']['openSourceScan']['resourceEvidenceSha256'] = (
            paper['apiReaderResources']['identitySha256']
        )
        paper['analysisManifest']['stages']['apiReaderArticle']['resourceIdentitySha256'] = (
            paper['apiReaderResources']['identitySha256']
        )
        paper['analysisManifest']['stages']['apiReaderArticle']['sourceBindingsSourceTextSha256'] = source_sha
        latex = paper['apiReaderPlan']['formulaBindings'][0]['latex']
        dom_sha = paper['apiReaderPlan']['formulaBindings'][0]['sourceDomSha256']
        source_payload = json.dumps({
            'flattenedTextSha256': source_sha,
            'formulas': [{
                'ordinal': 1,
                'recoveryStatus': 'complete',
                'latex': latex,
                'text': latex,
                'mathml': '<math display="block">',
                'sourceDomSha256': dom_sha,
            }],
        }, ensure_ascii=False, separators=(',', ':'))
        paper['apiReaderPlan']['structuredSourcePayload'] = source_payload
        structured_sha = hashlib.sha256(source_payload.encode('utf-8')).hexdigest()
        paper['analysisManifest']['sourceAcquisition']['structuredArtifactsSha256'] = structured_sha
        paper['analysisManifest']['stages']['apiReaderArticle']['structuredArtifactsSha256'] = structured_sha
        reseal_llm_api_reader_fixture(paper)
        return paper, full_source

    return paper, None


class ExecutiveAbstractV4Test(unittest.TestCase):
    def setUp(self):
        restore_environment_after(self)
        self.network = mock.patch('socket.socket.connect', side_effect=AssertionError('no network'))
        self.models = mock.patch('publish_common.call_publish_llm_api', side_effect=AssertionError('no model'))
        self.network.start()
        self.models.start()
        self.addCleanup(self.network.stop)
        self.addCleanup(self.models.stop)

    def test_protocol_dual_fingerprint_dispatch(self):
        current = csf.current_header()
        self.assertEqual(current, {'contract': 'core-summary', 'schemaFingerprint': NEW_SUMMARY_FP})
        self.assertEqual(csf.LEGACY_SCHEMA_FINGERPRINT, OLD_SUMMARY_FP)
        self.assertEqual(csf.ORIGINAL_TAG, 'core-summary-detailed-v3')
        self.assertTrue(protocols.is_contract('core-summary-detailed-v3', 'core-summary'))
        self.assertTrue(protocols.has_valid_header({'contract': 'core-summary', 'schemaFingerprint': OLD_SUMMARY_FP}, 'core-summary'))
        self.assertTrue(protocols.has_valid_header(current, 'core-summary'))
        self.assertFalse(protocols.has_valid_header({'contract': 'core-summary', 'schemaFingerprint': 'f' * 64}, 'core-summary'))

        self.assertTrue(csf.is_executive_abstract_header(current))
        self.assertFalse(csf.is_executive_abstract_header({'contract': 'core-summary', 'schemaFingerprint': OLD_SUMMARY_FP}))
        self.assertFalse(csf.is_executive_abstract_header('core-summary-detailed-v3'))
        self.assertFalse(csf.is_executive_abstract_header({'contract': 'core-summary-detailed-v3'}))
        self.assertFalse(csf.is_executive_abstract_header(None))

    def test_executive_abstract_v4_positive_cases(self):
        new_header = csf.current_header()
        char_count = len(re.findall(r'[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]', FOUR_PARAGRAPH_EXECUTIVE_SUMMARY))
        self.assertGreaterEqual(char_count, 850)
        self.assertLessEqual(char_count, 1150)

        self.assertIsNone(publisher._detailed_core_summary_semantic_issue(
            FOUR_PARAGRAPH_EXECUTIVE_SUMMARY,
            summary_header=new_header,
            source_text=EXECUTIVE_SOURCE_TEXT,
        ))
        self.assertNotIn('原文未披露训练、推理或部署成本', THREE_PARAGRAPH_THEORY_SUMMARY)
        self.assertIsNone(publisher._detailed_core_summary_semantic_issue(
            THREE_PARAGRAPH_THEORY_SUMMARY,
            summary_header=new_header,
            source_text=ZERO_TRAINING_SOURCE_TEXT,
        ))

    def test_executive_abstract_v4_negative_cases(self):
        new_header = csf.current_header()
        base_fixture = llm_api_publication_fixture()
        short_legacy = base_fixture['parsed']['summary']

        short_issue = publisher._detailed_core_summary_semantic_issue(
            short_legacy, summary_header=new_header, source_text='WER improved from 10.2% to 8.4%.',
        )
        self.assertRegex(short_issue, r'中文字符必须为 700–1400')
        self.assertRegex(short_issue, r'自然段数必须为 3–4 段')

        heading_issue = publisher._detailed_core_summary_semantic_issue(
            f'### 问题与瓶颈\n\n{FOUR_PARAGRAPH_EXECUTIVE_SUMMARY}',
            summary_header=new_header,
            source_text=EXECUTIVE_SOURCE_TEXT,
        )
        self.assertIn('禁止使用 # 等 Markdown 标题', heading_issue)

        numbered_issue = publisher._detailed_core_summary_semantic_issue(
            f'1. **问题与瓶颈**\n{FOUR_PARAGRAPH_EXECUTIVE_SUMMARY}',
            summary_header=new_header,
            source_text=EXECUTIVE_SOURCE_TEXT,
        )
        self.assertRegex(numbered_issue, r'禁止使用独立编号标题行|段内不拆行')

        paragraphs = FOUR_PARAGRAPH_EXECUTIVE_SUMMARY.split('\n\n')
        strip_problem = lambda s: re.sub(r'问题|难点|瓶颈|症结|失效|缺陷|受限|局限|挑战|任务|目标|输入|输出|旨在|针对|解决', '现象', s)
        no_problem = '\n\n'.join([
            '**问题与瓶颈：**流式语音编解码研究观察到波形采样率为 16 kHz，常规量化方案在 50 Hz 帧率与 1.5 kbps 带宽条件下会出现明显变化，音素包络与声学属性呈现耦合状态。这种耦合状态在低码率传输过程中经常出现，引起了语音信号处理社区的长期关注与讨论。',
            strip_problem(paragraphs[1]),
            strip_problem(paragraphs[2]),
            strip_problem(paragraphs[3]),
        ])
        self.assertIn('缺少任务问题', publisher._detailed_core_summary_semantic_issue(
            no_problem, summary_header=new_header, source_text=EXECUTIVE_SOURCE_TEXT,
        ))

        no_method = '\n\n'.join([
            paragraphs[0],
            '**核心思路与方法架构：**作者从理论上重新审视了超低码率场景下不同声学属性的时间尺度差异。慢变说话人特质与快变局部音素在信息速率上天然存在数量级落差。这一观察为流式语音研究提供了新的分析视角，也让学术界重新思考低码率条件下的信息分配原则。整体设计围绕带宽预算与听感质量之间的平衡展开讨论。',
            re.sub(r'方法|模块|模型|编码器|声码器|瓶颈|先|再', '方案', paragraphs[2]),
            re.sub(r'架构|模块|推导|先|再', '内容', paragraphs[3]),
        ])
        self.assertIn('缺少 2–4 步方法链', publisher._detailed_core_summary_semantic_issue(
            no_method, summary_header=new_header, source_text=EXECUTIVE_SOURCE_TEXT,
        ))

        no_quant = '\n\n'.join([
            paragraphs[0],
            paragraphs[1],
            '**关键实验与核心代价：**作者在公开语音基准数据集上开展了系统性的对比实验与主观听感测试，整体重构音质与语音可懂度均明显优于以往流式编解码基线方案。多组消融分析也进一步印证了正交信息瓶颈约束对稳定训练的必要性。在工程部署开销方面，流式推理需引入 28.5 ms 前瞻窗口延迟与 1.45s 首次编译耗时，单卡实时率 RTF 为 0.14，整体计算资源占用可控。',
            paragraphs[3],
        ])
        self.assertIn('缺少完整关键定量结果', publisher._detailed_core_summary_semantic_issue(
            no_quant, summary_header=new_header, source_text=EXECUTIVE_SOURCE_TEXT,
        ))

        for old_val, bad_val, expected in (
            ('6.15%', '6.2%', '数值“6.2%”未在原文中以相同精度出现'),
            ('3.96', '3.98', '数值“3.98”未在原文中以相同精度出现'),
            ('0.841', '84.1%', '数值“84.1%”未在原文中以相同精度出现'),
            ('9.84%', '9.84', '数值“9.84”遗漏了原文的百分号'),
        ):
            with self.subTest(old_val=old_val, bad_val=bad_val):
                tampered = FOUR_PARAGRAPH_EXECUTIVE_SUMMARY.replace(old_val, bad_val)
                issue = publisher._detailed_core_summary_semantic_issue(
                    tampered, summary_header=new_header, source_text=EXECUTIVE_SOURCE_TEXT,
                )
                self.assertIn(expected, issue)

    def test_historical_cold_replay_compatibility_for_v3_and_old_fingerprint(self):
        legacy_source = (
            'In our evaluation on the public test set, our separation model reduces WER from 10.2% to 8.4% '
            'compared with the baseline under identical listening conditions.'
        )
        for legacy_header in (
            'core-summary-detailed-v3',
            {'contract': 'core-summary', 'schemaFingerprint': OLD_SUMMARY_FP},
        ):
            with self.subTest(header=legacy_header):
                base = llm_api_publication_fixture()
                paper, full_source = _reseal_publication_paper_with_summary(
                    base, base['parsed']['summary'], legacy_header, source_text=legacy_source,
                )
                validated = publisher._validated_detailed_core_summary(
                    paper, paper['parsed'], source_text=full_source,
                )
                self.assertEqual(validated, paper['parsed']['summary'])

                # 在旧契约下，900+ 字的 4 段式摘要仍被旧 600 字上限拦截
                overlong_paper, overlong_source = _reseal_publication_paper_with_summary(
                    base, FOUR_PARAGRAPH_EXECUTIVE_SUMMARY, legacy_header, source_text=EXECUTIVE_SOURCE_TEXT,
                )
                with self.assertRaises(publisher.PublishDataValidationError) as ctx:
                    publisher._validated_detailed_core_summary(
                        overlong_paper, overlong_paper['parsed'], source_text=overlong_source,
                    )
                self.assertRegex(str(ctx.exception), r'600')

    def test_paper_page_and_digest_index_binding_parity_for_executive_abstract(self):
        base = llm_api_publication_fixture()
        paper, full_source = _reseal_publication_paper_with_summary(
            base, FOUR_PARAGRAPH_EXECUTIVE_SUMMARY, csf.current_header(), source_text=EXECUTIVE_SOURCE_TEXT,
        )
        validated = publisher._validated_detailed_core_summary(
            paper, paper['parsed'], source_text=full_source,
        )
        self.assertEqual(validated, FOUR_PARAGRAPH_EXECUTIVE_SUMMARY)

        page_md, _ = publisher.generate_paper_page(paper, '2026-11-20', source_text=full_source)
        index_md = publisher.generate_index_page(
            [(6.1, paper, paper['parsed'])], [], '2026-11-20', {paper['arxivId']: 'fixture'},
        )
        self.assertIsNone(publisher._api_reader_page_binding_issue(page_md, paper))
        self.assertIsNone(publisher._api_reader_index_display_fields_issue(index_md, [paper]))

        sanitized_summary = publisher.sanitize_markdown_for_publish(FOUR_PARAGRAPH_EXECUTIVE_SUMMARY).strip()
        self.assertIn(f'## 📌 核心摘要\n\n{sanitized_summary}', page_md)
        self.assertIn(f'📌 **核心摘要**\n\n{sanitized_summary}\n\n🔗 **开源资源**', index_md)
        for prefix in ('**问题与瓶颈：**', '**核心思路与方法架构：**', '**关键实验与核心代价：**', '**适用边界与深读导览：**'):
            self.assertIn(prefix, page_md)
            self.assertIn(prefix, index_md)

        # 篡改单篇页或汇总页任意一个摘要字符都会被绑定门禁拦截
        tampered_page = page_md.replace('6.15%', '6.20%', 1)
        self.assertIsNotNone(publisher._api_reader_page_binding_issue(tampered_page, paper))
        tampered_index = index_md.replace('6.15%', '6.20%', 1)
        self.assertIsNotNone(publisher._api_reader_index_display_fields_issue(tampered_index, [paper]))

    def test_latexml_grounding_and_window_boundary_cost_hardening(self):
        new_header = csf.current_header()
        tricky_source = (
            'Training uses 1{,}850 ms chunks and 12,400 utterances. '
            'Latency is \\SI12.5\\milli\\second with relative gain \\uparrow6.6% and variance \\pm0.3. '
            'MOS reaches ±.04583.9061\\!\\pm\\!.0458 and 4.3099±.05284.3099\\!\\pm\\!.0528 on the test set with 84.5M parameters.'
        )
        self.assertIsNone(publisher._validate_core_summary_source_grounded_claims(
            '基于Qwen2.5编码器与 84.5 M 可训练参数，在 1,850 ms 切片和 12,400 条样本上 MOS 达 3.9061（标准差 0.0458）与 4.3099（标准差 0.0528），相对增益 6.6%（波动 0.3），延迟 12.5 ms。',
            tricky_source,
        ))

        citation_decimal_source = 'We apply 10% dropout during training [85]. Test accuracy is 0.85 versus 0.79.'
        self.assertIn(
            '添加了原文不存在的百分号',
            publisher._validate_core_summary_source_grounded_claims('测试集准确率达到 85%。', citation_decimal_source),
        )
        percent_table_source = 'Table 1: WER (%) on test-clean: Baseline 9.84, Ours 6.15. Serving holds WER at 1.89 to 1.91%.'
        self.assertIsNone(publisher._validate_core_summary_source_grounded_claims(
            '词错率 WER 从 9.84% 降至 6.15%，服务区间保持在 1.89% 至 1.91%。', percent_table_source,
        ))

        paragraphs = FOUR_PARAGRAPH_EXECUTIVE_SUMMARY.split('\n\n')
        borrowed_rtf_quant = '\n\n'.join([
            paragraphs[0],
            paragraphs[1],
            '**关键实验与核心代价：**作者在 LibriSpeech test-clean 主基准的流式评测设置下完成了系统测试，转写词错率 WER 显著降低至 6.15%。单张 GPU 上的流式推理实时率 RTF 为 0.14，前瞻窗口延迟为 28.5 ms。整体系统在低带宽语音通信场景下展现出良好的工程实用性。',
            paragraphs[3],
        ])
        self.assertIn('缺少完整关键定量结果', publisher._detailed_core_summary_semantic_issue(
            borrowed_rtf_quant, summary_header=new_header, source_text=EXECUTIVE_SOURCE_TEXT,
        ))

        fake_boundary = '\n\n'.join([
            paragraphs[0],
            paragraphs[1].replace('在不额外消耗帧级码率', '明确划分训练与冻结边界并在不额外消耗帧级码率'),
            paragraphs[2],
            '**适用边界与深读导览：**读者若希望深入核查正交信息瓶颈的变分互信息上界推导、25 Hz 因果卷积块掩码细节或不同码率档位下的逐层消融曲线，可针对性阅读下方长文的方法推导与实验消融章节。本文全部模块设计与实验流程均已在长文中给出逐节说明。',
        ])
        self.assertIn('缺少结论适用边界', publisher._detailed_core_summary_semantic_issue(
            fake_boundary, summary_header=new_header, source_text=EXECUTIVE_SOURCE_TEXT,
        ))

        fake_cost = '\n\n'.join([
            paragraphs[0],
            paragraphs[1].replace('冻结预训练 WavLM 蒸馏引导', '冻结编码器进行特征提取并蒸馏引导'),
            '**关键实验与核心代价：**作者在 LibriSpeech test-clean 主基准的 1.5 kbps 流式评测设置下将本文系统与最强流式基线 Mimi 进行了严格同码率对照。实验结果显示转写词错率 WER 从 9.84% 显著下降至 6.15%，主观自然度预测分 UTMOS 从 3.42 提升至 3.96，说话人余弦相似度 SpkSim 也从 0.763 提升至 0.841。本文方法并非免训练方案，如果采用闭式求解则会损失细节，这种双流设计体现了编码码率与表征维度之间的良好权衡。',
            paragraphs[3],
        ])
        self.assertIn('缺少关键代价、资源开销或实际计算方式说明', publisher._detailed_core_summary_semantic_issue(
            fake_cost, summary_header=new_header, source_text=EXECUTIVE_SOURCE_TEXT,
        ))

        valid_frozen_direct_cost = '\n\n'.join([
            paragraphs[0],
            paragraphs[1],
            '**关键实验与核心代价：**作者在 LibriSpeech test-clean 主基准的 1.5 kbps 流式评测设置下将本文系统与最强流式基线 Mimi 进行了严格同码率对照。实验结果显示转写词错率 WER 从 9.84% 显著下降至 6.15%，主观自然度预测分 UTMOS 从 3.42 提升至 3.96，说话人余弦相似度 SpkSim 也从 0.763 提升至 0.841。推理阶段评估分支仅利用冻结编码器直接推理而无需额外微调。',
            paragraphs[3],
        ])
        self.assertIsNone(publisher._detailed_core_summary_semantic_issue(
            valid_frozen_direct_cost, summary_header=new_header, source_text=EXECUTIVE_SOURCE_TEXT,
        ))

        import time
        long_digit_source = f"{'9' * 10000}±{'8' * 10000} WER 6.15%."
        t0 = time.perf_counter()
        self.assertIsNone(publisher._validate_core_summary_source_grounded_claims(
            '词错率 WER 降至 6.15%。', long_digit_source,
        ))
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        self.assertLess(elapsed_ms, 100.0, f'expected <100ms on 10000-digit string, got {elapsed_ms:.2f}ms')

        custom_metric_source = (
            EXECUTIVE_SOURCE_TEXT + ' '
            'We evaluate music-to-color prediction on 265 official music videos including 65 from the DEAP dataset. '
            'Color accuracy is measured by Average Color Bin Difference (ACBD) and temporal consistency by Average Temporal Bin Difference (ATBD). '
            'Our model achieves ACBD of 3.5161, outperforming non-autoregressive Transformer 3.8853 and static MLP 4.6757, '
            'with ATBD of 0.8671 versus 1.0068 and 0.9959.'
        )
        custom_metric_summary = '\n\n'.join([
            paragraphs[0],
            paragraphs[1],
            '**关键实验与核心代价：**评测基于 265 个完整官方音乐视频与 DEAP 数据集测试划分完成。颜色准确性用平均颜色区间差异 ACBD 衡量，时间变化一致性用平均时间区间差异 ATBD 衡量。对照对象是静态多层感知机和不依赖历史预测的非自回归 Transformer。本文方法平均 ACBD 为 3.5161，低于非自回归基线的 3.8853 和静态基线的 4.6757，平均 ATBD 为 0.8671，低于非自回归基线的 1.0068 和静态基线的 0.9959。代价是自回归推理必须逐帧展开，论文未报告参数量与推理时延的定量对比。',
            paragraphs[3],
        ])
        self.assertIsNone(publisher._detailed_core_summary_semantic_issue(
            custom_metric_summary, summary_header=new_header, source_text=custom_metric_source,
        ))
        self.assertIn('缺少完整关键定量结果', publisher._detailed_core_summary_semantic_issue(
            custom_metric_summary,
            summary_header=new_header,
            source_text=custom_metric_source.replace('ACBD', 'FAKE1').replace('ATBD', 'FAKE2'),
        ))


if __name__ == '__main__':
    unittest.main()
