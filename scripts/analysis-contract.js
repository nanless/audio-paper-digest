const { CURRENT_MODEL_POLICY, boundModelPolicy, assertAgentIdentity } = require('../manual/scripts/manual-agent-policy.js');
const crypto = require('crypto');
const { TAG_STAGE_RECORD_CONTRACT, readTagStageRecord } = require('./lib/tag-stage-record.js');
const {
    PAPER_EVALUATION_TITLE,
    normalizeAnalysisSectionTitle,
    analysisSectionHeadings,
    extractAnalysisSection,
    getPaperEvaluationHeadingIssue
} = require('./lib/analysis-section-titles.js');
const {
    validateEditorialQuality,
    validateResultClaims,
    validateReadabilityRubric
} = require('./editorial-quality.js');
const {
    MANUAL_RESEARCH_CONTRACT_VERSION,
    validateResearchBrief,
    validateStageReviews,
    validateFigureReview,
    validateScoringCalibration,
    validateExactFactCoverage,
    validateResultClaimCoverageV5,
    validateEditorialReview
} = require('../manual/scripts/manual-research-contract.js');
const {
    validateManualTutorialReaderBundle
} = require('../manual/scripts/manual-tutorial-contract-orchestrator.js');
const {
    FRESH_AUTHORING_CONTRACT,
    FRESH_AUTHORING_MODE
} = require('../manual/scripts/manual-fresh-authoring-contract.js');
const {
    MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT
} = require('../manual/scripts/manual-v5-tutorial-payload.js');

const REQUIRED_ANALYSIS_SECTIONS = Object.freeze([
    '评分',
    '机器摘要',
    '标签',
    '作者与机构',
    PAPER_EVALUATION_TITLE,
    '核心摘要',
    '方法概述和架构',
    '核心创新点',
    '实验结果',
    '细节详述',
    '评分理由',
    '局限与问题',
    '开源详情'
]);

const REQUIRED_MACHINE_SUMMARY_KEYS = Object.freeze([
    'document_type',
    'rank_bucket',
    'innovation',
    'technical_rigor',
    'experimental_sufficiency',
    'clarity',
    'impact',
    'open_source',
    'reproducibility',
    'engineering_score',
    'confidence',
    'primary_task_tag',
    'primary_method_tag',
    'sota_claim',
    'has_code',
    'has_model',
    'has_dataset'
]);

const MACHINE_SCORE_MAXIMA = Object.freeze({
    innovation: 2,
    technical_rigor: 1.5,
    experimental_sufficiency: 1.5,
    clarity: 1,
    impact: 1.5,
    open_source: 1.5,
    reproducibility: 0.5,
    engineering_score: 1.5
});
const OPEN_SOURCE_SCORE_ANCHORS = Object.freeze([0, 0.2, 0.5, 1, 1.2, 1.5]);
const DOCUMENT_TYPES = new Set(['方法研究', '系统技术报告', '模型报告', '数据集与基准', '综述', '理论研究', '应用研究']);
const NON_EMPIRICAL_DOCUMENT_TYPES = new Set(['综述', '理论研究']);
const EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION = 'bounded-v1';
const EXPERIMENT_TABLE_CONTRACT_VERSION = 'evidence-rich-v2';
const EXPERIMENT_TABLE_CONTRACT_VERSIONS = Object.freeze([
    EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION,
    EXPERIMENT_TABLE_CONTRACT_VERSION
]);
const METHOD_DETAIL_CONTRACT_VERSION = 'detailed-v1';
const EDITORIAL_QUALITY_CONTRACT_VERSION = 'reader-facing-v1';
// Manual/离线分析除了要满足 API 分析用的结构约定，还必须带真实全文证据。
// 这里特意做成单独的可选约定：旧的合法 API 记录继续兼容，
// 新的 manual 记录则不能缩水成摘要加几句泛泛的过程评述。
const MANUAL_DEPTH_CONTRACT_VERSION = 'full-text-evidence-v1';
// v2 根据 2026-08-20 批次的问题增加 manual 分析正文检查：跨章节重复、
// 编辑模板句、遗漏原文开源 URL，以及评分理由没有引用证据编号。
const MANUAL_DEPTH_CONTRACT_VERSION_V2 = 'full-text-evidence-v2';
// v3 补的是对比 2026-08-25 manual 批次和 2026-08-14 API 批次时发现的读者
// 可见差距。只够长不行：成稿要读起来像技术解读——摘要里有真正的论证，
// 数据流分多步，创新点各自独立，有对比实验和复现信息，评分理由逐维度写，
// 证据与审查者局限分开标注。
const MANUAL_DEPTH_CONTRACT_VERSION_V3 = 'full-text-evidence-v3';
// v4 保留 v3 的全部行文与证据要求，另外绑定更细的实验表格约定和
// 与上下文绑定的图片讲述约定。这个绑定刻意按版本走：
// 已发布的 v1–v3 manual 记录沿用当时的表格规则，不套用新版正文检查。
const MANUAL_DEPTH_CONTRACT_VERSION_V4 = 'full-text-evidence-v4';
const MANUAL_DEPTH_CONTRACT_VERSION_V5 = 'full-text-evidence-v5';
const MANUAL_DEPTH_CONTRACT_VERSIONS = Object.freeze([
    MANUAL_DEPTH_CONTRACT_VERSION,
    MANUAL_DEPTH_CONTRACT_VERSION_V2,
    MANUAL_DEPTH_CONTRACT_VERSION_V3,
    MANUAL_DEPTH_CONTRACT_VERSION_V4,
    MANUAL_DEPTH_CONTRACT_VERSION_V5
]);
const MANUAL_READER_QUALITY_VERSIONS = Object.freeze([
    MANUAL_DEPTH_CONTRACT_VERSION_V4,
    MANUAL_DEPTH_CONTRACT_VERSION_V5
]);
const ANALYSIS_EDITORIAL_LEAKAGE_CONTRACT_VERSION = 'high-confidence-v1';
const MANUAL_COMPLETE_STATUS = 'manual_complete';
const MANUAL_COMPLETE_PROVENANCE_VERSION = 2;
const MANUAL_PROVENANCE_PROTOCOL = 'manual-offline-review-v1';
const MANUAL_STAGE_EXECUTION_KIND = 'manual_attestation';
// 2026-08-21 之前完成的记录还没有逐阶段提示词/上下文绑定。这批已发布的
// 记录继续可读，但不许新记录删掉加固字段退回旧档案。
const MANUAL_V2_HARDENED_CUTOFF_DATE = '2026-08-22';
const MANUAL_AUDIT_CHECKS = Object.freeze([
    'sourceCoverage',
    'promptConformance',
    'factualClaimsLedger',
    'scoreRecomputed',
    'methodContract',
    'tableContract',
    'boilerplateScan',
    'finalContract'
]);
const MANUAL_STAGE_EVIDENCE_STAGES = Object.freeze([
    'imageDownload', 'primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision',
    'tableRepair', 'methodRepair', 'structureRepair', 'scoringAudit', 'imageSupplement'
]);
const MANUAL_STAGE_CLAIM_HINTS = Object.freeze({
    imageDownload: /(?:图|图片|插图|image|caption|下载)/i,
    primaryAnalysis: /(?:方法|架构|输入|输出|模块|全文|主分析)/i,
    openSourceScan: /(?:开源|代码|权重|数据集|仓库|链接|复现)/i,
    demoLinkScan: /(?:demo|演示|链接|部署|示例|未提及)/i,
    revision: /(?:修订|事实|错误|一致|正文|局限|审校)/i,
    tableRepair: /(?:表|指标|数值|实验|基线|消融)/i,
    methodRepair: /(?:方法|架构|模块|训练|推理|数据流)/i,
    structureRepair: /(?:章节|结构|标题|摘要|标签|格式)/i,
    coreSummaryRepair: /(?:核心摘要|问题|方法链|结果|边界|成本)/i,
    scoringAudit: /(?:评分|维度|总分|分数|严谨|实验充分)/i,
    imageSupplement: /(?:图|图片|插图|caption|视觉|段落)/i
});
const MANUAL_BOILERPLATE_PATTERNS = Object.freeze([
    /从复现角度(?:看)?[，,:：]/,
    /这样的边界很重要/,
    /本文的实验和图示应/,
    /对于未报告的参数、?硬件、?随机种子或服务版本/,
    /应按数据流逐项复核/,
    /不能把整条流水线的收益都归因/,
    /对于多模态系统，还要区分/,
    /可执行的(?:音频|语音|音乐或多模态)处理流程/,
    /对音频读者而言.{0,80}提供可复用的任务定义或工程证据/,
    /全文(?:方法|实验)与训练段落给出的可复现设置如下/,
    /结果证据\s*\d+：.{0,80}数字、比较方向和统计口径均按原文保留/,
    /第\s*(?:\d+|[一二三四五六七八九十]+)\s*个证据块/,
    /(?:证据块|结果证据|方法事实|实验事实|实现细节|实验\/部署细节)\s*\d+\s*[：:]/i,
    /(?:该事实用于|这项结果对应|该信息用于)[^。！？\n]{0,120}(?:复现|限定|解释|边界)/,
    /全文事实(?:摘录)?[：:]?|专项复核|二次复核输入\/输出边界|manual[-_ ](?:complete|full-text)|论文明确写到/i
]);
const REQUIRED_RECOVERY_STAGES = Object.freeze([
    'imageDownload', 'primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision',
    'tableRepair', 'methodRepair', 'structureRepair', 'coreSummaryRepair',
    'scoringAudit', 'imageSupplement'
]);
const CORE_SUMMARY_CONTRACT_VERSION = 'core-summary-detailed-v3';
const CORE_SUMMARY_MIN_CHINESE_CHARS = 320;
const CORE_SUMMARY_MAX_CHINESE_CHARS = 600;
const CORE_SUMMARY_MIN_SENTENCES = 6;
const CORE_SUMMARY_MAX_SENTENCES = 9;
const CORE_SUMMARY_RESULT_UNAVAILABLE = '原文未提供可核对的关键定量结果';
const CORE_SUMMARY_COST_UNAVAILABLE = '原文未披露训练、推理或部署成本';
const CORE_SUMMARY_NUMBER_PATTERN = /(?<![A-Za-z0-9])[-+]?\d+(?:\.\d+)?(?:\s*(?:%|％|dB|ms|s|秒|分钟|小时|倍|点|分))?(?![A-Za-z0-9])/g;
// 英文指标名必须整词匹配。没有这里的两侧边界，mAP/PAR/PER 这类短指标会命中
// "mapping"、"Particle"、"performance" 等普通词，把章节号和引用位置误当成
// 实验测量结果。
const CORE_SUMMARY_METRIC_PATTERN = /(?:(?<![A-Za-z0-9_])(?:(?:cp|tcp)?WER|SWER|AER|CER|PER|DER|JER|F1|F[- ]?Scores?|BLEU|COMET|ROUGE|MOS(?:[- ]?[PT])?|PCC|FAD(?:CLAP|Vggish)|CQT1-PCC|LPAPS|CDPAM|PESQ|STOI|SI-SDR|SDR|SNR|EER|PPL|ASR|mAP|AUROC|AUC|mIoU|IoU|J&F|MJ|MF|Jaccard|LangRank|Exact Match|Pearson|Spearman|Kendall|PSNR|SSIM|MSE|MAE|RMSE|FGD|BeatAlign|Diversity|R@\d+(?:\.\d+)?|SAR|DAR|PISR|RtA|NBS|OIC|PAR|Fair[ -]?Rate|BMSR|JSR|RSF|OH|n?TVD|SpkSim|LPS|SBS|UTMOS|PLCMOS|precision|recall|MSR|FVD|FID|Acc(?:[_ -]?(?:macro|num))?|CLAP(?:[_ -](?:MS|LAION))?|VISQOL|MCD|SPK[_ -]?SIM|Mel(?:[ -]Dist(?:ance)?)?|STFT(?:[ -]Dist(?:ance)?)?|DeSync|IB|accuracy|error rate|success rate|win rate|compression[ -](?:ratio|rate)|real[ -]time factor|scores?|latency|throughput|RTF|FPS|performance|metrics?)(?![A-Za-z0-9_])|词(?:字)?错率|困惑度|攻击成功率|准确率|正确率|错误率|误差率|召回率|精确率|总体分|得分|分数|胜率|成功率|延迟|吞吐|实时率|主观评分|客观评分|相似度|相似分数|性能|指标)/i;
// 会议论文常用领域内的中文指标名（例如 DAFx 的“抖动”和“包络相关”）。
// 这里显式列出来，免得把任何结果名词都当成定量证据。
const CORE_SUMMARY_CONFERENCE_METRIC_PATTERN = /包络相关(?:性)?|抖动|计数偏差|总误差|频率误差|衰减误差|增益误差|相对误差|平均误差|压缩率|谐波失真|频谱对比度损失|起音时间(?:对数)?偏差/;
const CORE_SUMMARY_GENERIC_ENGLISH_METRIC_PATTERN = /(?<![A-Za-z0-9_])(?:scores?|performance|metrics?)(?![A-Za-z0-9_])/i;
const CORE_SUMMARY_COMPARISON_PATTERN = /(?:from\b[^。！？!?]{0,50}\bto\b|improv(?:e|es|ed|ement)|outperform(?:s|ed)?|reduc(?:e|es|ed|tion)|increase[sd]?|decrease[sd]?|degrad(?:e|es|ed|ation)|on par|comparable|从[^。！？!?]{0,40}(?:升至|升到|降至|降到|提升至|提高到)|相比|相较|优于|超过|反超|低于|高于|提升|提高|改善|改进|降低|下降|减少|达到|增至|减至|领先|持平|相当|接近)/i;
const CORE_SUMMARY_COMPARISON_OBJECT_PATTERN = /(?:\bbaseline\b|\bcontrol\b|\breference\b|\bcomparison\b|\b(?:our|ours|proposed|present|this)\s+(?:approach|method|model|system|technique)\b|基线|对照|相比|相较|原方法|已有方法|先前方法|本文方法|本方法|所提方法|完整模型|竞品)/i;
// 这些量描述系统怎么运行、怎么配置。写成本段落时有用，但没有基线或对照，
// 它们不算核心摘要结果句所需的实测结果证据。
const CORE_SUMMARY_OPERATIONAL_PARAMETER_PATTERN = /(?:\b(?:train(?:ing)?|inference|deployment|hardware|gpu|cpu|tpu|npu|parameter(?:s)?|layers?|hidden(?:\s+units?)?|batch(?:\s+size)?|learning\s+rate|epochs?|steps?|iterations?|sampling\s+rate|window(?:\s+size)?|channels?|dimensions?|memory|vram|flops?|macs?|rtf|latency|throughput|fps|runtime|duration|cost|overhead)\b|训练|推理|部署|硬件|显存|内存|参数量|层数|隐藏单元|批量|学习率|轮次|步数|迭代|采样率|窗口|通道|维度|耗时|延迟|吞吐|实时率|计算量|成本|开销)/i;
const CORE_SUMMARY_DIRECTION_CONNECTOR_PATTERN = /(?:高于|低于|超过|优于|领先)/g;
const CORE_SUMMARY_BARE_TRANSITION_PATTERN = /(?:升至|降至)/;
const CORE_SUMMARY_NON_RESULT_PATTERN = /(?:模型|版本|参数量|样本量|训练步数|轮次|批量|batch|学习率|年份|第\s*\d+|图\s*\d+|表\s*\d+|式\s*\d+|章节|引用)/i;
const RECOVERY_STAGE_TERMINAL_STATUSES = Object.freeze({
    imageDiscovery: Object.freeze(['complete', 'no_candidates', MANUAL_COMPLETE_STATUS]),
    imageDownload: Object.freeze(['complete', 'skipped', 'no_candidates', 'no_downloadable_images', MANUAL_COMPLETE_STATUS]),
    primaryAnalysis: Object.freeze(['complete', MANUAL_COMPLETE_STATUS]),
    openSourceScan: Object.freeze(['complete', MANUAL_COMPLETE_STATUS]),
    demoLinkScan: Object.freeze(['complete', 'not_needed', MANUAL_COMPLETE_STATUS]),
    revision: Object.freeze(['complete', MANUAL_COMPLETE_STATUS]),
    tableRepair: Object.freeze(['complete', 'not_needed', MANUAL_COMPLETE_STATUS]),
    methodRepair: Object.freeze(['complete', 'not_needed', MANUAL_COMPLETE_STATUS]),
    taxonomySeal: Object.freeze(['complete', 'not_needed']),
    tagSelection: Object.freeze(['complete', 'not_needed']),
    coreSummaryRepair: Object.freeze(['complete', 'not_needed', MANUAL_COMPLETE_STATUS]),
    structureRepair: Object.freeze(['complete', 'not_needed', MANUAL_COMPLETE_STATUS]),
    scoringAudit: Object.freeze(['complete', MANUAL_COMPLETE_STATUS]),
    apiReaderArticle: Object.freeze(['complete']),
    imageSupplement: Object.freeze(['complete', 'skipped', 'no_candidates', 'no_high_value_images', 'no_downloadable_images', MANUAL_COMPLETE_STATUS])
});
const EXPERIMENT_TABLE_LIMITS = Object.freeze({
    maxTables: 2,
    maxDataRows: 12,
    maxMetricColumns: 8,
    minEvidenceRows: 3,
    minNumericCells: 2
});
const TABLE_IDENTIFIER_HEADER_RE = /(?:^editing(?: operation)?$|(?:^|\b)(?:method|algorithm|approach|strategy|mechanism|aggregation|model|system|backbone|front[ -]?end|pipeline|variant|ablation|representation|embedding|feature|encoder|baseline|config(?:uration)?|dataset|corpus|benchmark|task|experiment|evaluation|test|comparison|control|boundary|slice|subset|input|query|language|scenario|condition|setting|split|category|type|modality|version|stage|phase|step|round|epoch|decoder?|context|metric|measure|family|language family)(?:\b|$)|^编辑操作$|方法|算法|方案|策略|方式|机制|聚合|模型|系统|骨干|前端|流程|变体|消融(?:项|设置|变体)?|表征|嵌入|特征|编码器|基线|配置|数据集|语料|基准|任务|实验|检验|评估|测试|比较|对照|边界|切片|子集|输入|查询|题数|语言|语系|语族|场景|条件|设置|划分|类别|类型|模态|版本|阶段|阶数|步骤|轮次|训练轮|解码|上下文|指标|度量|拓扑)/i;
const TABLE_VAGUE_METRIC_HEADER_RE = /^(?:结果|数值|数值变化|观察|观察结果|实际观测|报告结果|主要观察|说明|解释|含义|方向|关键条件|结论|结论边界|证据边界|应如何解读|对照或说明|对照或变化|结果或结论)$/i;
const TABLE_DIRECTION_MARK_RE = /(?:↑|↓|\\(?:uparrow|downarrow|nearrow|searrow)\b|越高越好|越低越好|higher\s+is\s+better|lower\s+is\s+better|max(?:imize)?|min(?:imize)?)/i;
const TABLE_DIRECTIONAL_METRIC_RE = /(?:accuracy|precision|recall|f[- ]?score|\bf1\b|\bwer\b|\bcer\b|\bder\b|\bauc\b|\bmap\b|\bmiou\b|\biou\b|\bpesq\b|\bstoi\b|\bsdr\b|\bsisdr\b|\bsnr\b|\bbleu\b|\brouge\b|\bmeteor\b|\bclap\b|\bfad\b|\brmse\b|\bmae\b|\berle\b|\bmos\b|\bl[12]\b|\bmse\b|\bnmse\b|\bmste\b|\bmr[- ]?stft\b|准确率|精确率|召回率|错误率|误差|损失|延迟|耗时|速度|吞吐|内存|显存|功耗|能耗|复杂度|参数量|相关系数|相似度|评分|分数|裁判分)/i;
// “无条件 AVG ↑”这类聚合/均值列是可测量的指标，不能当成设置标识；但与
// WER/accuracy 不同，它们本身不要求带 ↑/↓ 标记（比如 “Avg Total (s)”
// 只是个普通时长）。把它们排除在 TABLE_DIRECTIONAL_METRIC_RE 之外，
// 方向闸的行为就不变；只有在 isTableIdentifierHeader 已经看到方向标记时，
// 才来查这张表。
const TABLE_GENERIC_METRIC_HEADER_RE = /(?:\bavg\b|\bmean\b|\baverage\b|均值|平均)/i;
// 身份词在聚合表头里仍然表示行身份：“6 基准平均 ↑”里的基准/数据集限定词
// 继续锚定这一行；而“无条件”这类弱条件词会让位给“无条件 AVG ↑”的指标读法。
const TABLE_STRONG_IDENTITY_HEADER_RE = /基准|数据集|语料|任务|语言|语系|语族|类别|类型|模态|版本|阶段|阶数|步骤|轮次|训练轮|划分|切片|子集|场景|配置|拓扑/;
const TABLE_NON_DIRECTIONAL_MEASURE_RE = /(?:置信区间|confidence interval|\bci\b|p[- ]?value|p值|显著性|样本数|数量|规模|时长|采样率|方差|标准差|系数|\bbeta\b|\bΔ?AIC\b|复杂度|参数|容量|内存|显存|耗时|延迟|速度|吞吐|功耗|能耗|bytes?|hours?|seconds?|milliseconds?)/i;
const TABLE_NUMERIC_CELL_RE = /(?:^|[^A-Za-z])[-+]?\d(?:[\d,]*)(?:\.\d+)?(?:\s*(?:%|pp|×|x|ms|s|h|Hz|kHz|MHz|GB|MB|KB|dB|mJ|W))?/i;

// 第一列也可能描述训练条件而不是指标。这里显式列出来，
// 好让“训练损失 × evaluation metrics”这类表格按对比表处理，
// 又不硬给条件列加上 ↑/↓ 标记。
const TABLE_ADDITIONAL_IDENTIFIER_HEADER_RE = /^(?:训练损失|损失函数|监督目标|训练目标|评估设置|实验设置)$/i;
function isTableIdentifierHeader(value) {
    const normalized = String(value || '').trim();
    if (TABLE_ADDITIONAL_IDENTIFIER_HEADER_RE.test(normalized)) return true;
    const withoutDirection = normalized
        .replace(TABLE_DIRECTION_MARK_RE, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const identifier = !normalized || TABLE_IDENTIFIER_HEADER_RE.test(withoutDirection);
    if (!TABLE_DIRECTION_MARK_RE.test(normalized)) return identifier;
    // “方法 ↓”“设置 H ↓”和“方法 ↑ 成功率”说的仍然是行身份。光有方向标记
    // 不能把第一列变成指标列。反过来，真正的指标前面加个“评估”这样的限定词
    // （例如“评估 L1(...) ↓”）不算标识。
    // 这条分支只在出现方向标记时才走，所以把“无条件 AVG ↑”当指标
    // 不会顺带给“Avg Total (s)”加上箭头。
    if (TABLE_DIRECTIONAL_METRIC_RE.test(withoutDirection)) return false;
    if (TABLE_GENERIC_METRIC_HEADER_RE.test(withoutDirection)
        && !TABLE_STRONG_IDENTITY_HEADER_RE.test(withoutDirection)) return false;
    if (/(?:^|[\s/])(?:方法|算法|方案|策略|模型|系统|设置|条件|拓扑|数据集|基线|配置|场景|阶段|实验|评估设置|实验设置)(?:[\s/]|$)/i.test(withoutDirection)) {
        return true;
    }
    return identifier;
}

// 只匹配独立行/段落中高度明确的模型编辑、自检或对用户指令的复述。
// 普通论文论述可以自然包含“这里”“注意”“已有分析”等词，因此不能用
// 单个关键词作拒绝条件；每条模式都要求同时出现编辑动作、输出格式或用户语境。
const ANALYSIS_EDITORIAL_LEAK_PATTERNS = Object.freeze([
    /^(?:这里|此处|这一段)(?:保持|保留)原样(?:[。；，,！!]|$)/,
    /^(?:这里|此处|这一段)我(?:已经|已)?(?:补充|加入|加上|修改|修正|更正|删除|删去|保留|调整)(?:了|过)?.{0,120}(?:[。；！!]|$)/,
    /^(?:这里|此处|这一段)(?:已经|已)?(?:补充|加入|加上|修改|修正|更正|删除|删去|保留|调整)(?:了|过)?.{0,120}(?:原分析|已有分析|上述分析|机器摘要|评分理由|标签章节|协议(?:差异|不一致)|严格限定|字数|格式要求)/,
    /^(?:这里|此处|这一段)(?:已经|已)?(?:补充|加入|加上|修改|修正|更正|删除|删去|保留|调整)(?:了|过)?.{0,160}(?:原文|原分析|已有分析|机器摘要|评分理由).{0,100}(?:可以|可接受|没问题)(?:[。；！!]|$)/,
    /^(?:这里|此处)第\s*\d+\s*(?:点|条|项).{0,80}(?:加(?:入|上|个)?|修正|修改|补充|新增|保留|删除|调整)/,
    /^注意(?:[：:]\s*)?(?:修正|更正)(?:拼写|错别字|格式|措辞|标点|编号|公式)(?:[。；，,！!]|$)/,
    /^(?:现在|接下来)(?:我们)?(?:需要|将要)(?:开始)?(?:生成|输出|给出)(?:(?:最终|完整)(?:文本|分析|内容|答案)|答案)(?=$|[。！？!?，,；;：:]|\s+(?:但|请|直接|不要|必须|可能))/,
    /^让我们(?:再)?检查一下是否有任何(?:遗漏|错误)/,
    /^(?:以上|当前|这段)(?:方法概述|核心摘要|实验结果|评分理由|开源详情).{0,80}(?:\d+\s*(?:字|字符)|字数|长度要求|格式(?:书写)?正确|符合(?:格式|契约|要求))/,
    /^(?:另外)?注意[：:]?\s*(?:机器摘要|评分理由|开源详情|输出格式|代码块|全文(?:必须|需要|从))/,
    /^注意[：:]?\s*用户可能期望.{0,100}(?:机器摘要|评分理由|标签章节|##\s*(?:评分|机器摘要|标签))/,
    /^(?:最后)?需(?:要)?确保全文(?:从|以).{0,40}##\s*评分/,
    /^(?:机器摘要|评分理由|标签章节|输出)(?:中|部分)?(?:不允许|必须|要求).{0,80}(?:格式|列表符号|key|键|开头|代码块)/i,
    /^(?:但)?需要检查(?:机器摘要(?:中|的)|输出格式|是否有任何遗漏)/,
    /^需要检查细节[：:].{0,160}(?:原分析|已有分析|上述分析|最终输出|机器摘要|评分理由|开源详情)/,
    /^(?:这里|此处)\s*`[^`]{1,80}`\s*(?:可能)?正确.{0,100}(?:用户要求|示例|格式|空格)/,
    /^(?:原文标题|作者与机构|原文作者)[：:].{0,140}(?:已有分析|无需在分析中)/,
    /^(?:now|next),?\s+i\s+(?:need to|will)\s+(?:produce|output|generate)\s+(?:the\s+)?(?:final\s+)?(?:answer|analysis|response|output|text)(?=$|[.:;,!?]|\s+(?:but|directly|for\s+the\s+user))/i,
    /^(?:note|important)\s*:\s*(?:the user|output format|i (?:fixed|added|changed|kept|removed))\b/i
]);

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getMissingRequiredSections(text) {
    const headings = analysisSectionHeadings(text);
    return REQUIRED_ANALYSIS_SECTIONS.filter(title => !headings.some(heading => heading.section === title));
}

function countSectionHeadings(text, title) {
    return analysisSectionHeadings(text)
        .filter(heading => heading.section === normalizeAnalysisSectionTitle(title)).length;
}

function getDuplicateRequiredSections(text) {
    return REQUIRED_ANALYSIS_SECTIONS.filter(title => countSectionHeadings(text, title) > 1);
}

function extractSection(text, title) {
    return extractAnalysisSection(text, title);
}

function splitMarkdownTableRow(row) {
    const text = String(row || '').trim();
    if (!text.includes('|')) return [];
    const cells = [];
    let current = '';
    let inCode = false;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (char === '\\' && index + 1 < text.length) {
            current += char + text[index + 1];
            index += 1;
            continue;
        }
        if (char === '`') {
            inCode = !inCode;
            current += char;
            continue;
        }
        if (char === '|' && !inCode) {
            cells.push(current.trim());
            current = '';
            continue;
        }
        current += char;
    }
    cells.push(current.trim());
    if (text.startsWith('|') && cells[0] === '') cells.shift();
    if (text.endsWith('|') && cells[cells.length - 1] === '') cells.pop();
    return cells;
}

function isMarkdownTableSeparator(row) {
    const cells = splitMarkdownTableRow(row);
    return cells.length >= 2 && cells.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function stripFencedCodeBlocks(text) {
    let fence = null;
    return String(text || '').split('\n').map(line => {
        const match = line.match(/^\s*(`{3,}|~{3,})/);
        if (!fence) {
            if (match) {
                fence = { char: match[1][0], length: match[1].length };
                return '';
            }
            return line;
        }
        if (match && match[1][0] === fence.char && match[1].length >= fence.length) {
            fence = null;
        }
        return '';
    }).join('\n');
}

function normalizeAnalysisEditorialFragment(fragment) {
    let value = String(fragment || '').trim();
    if (!value) return '';
    // 句界切分可能把包裹整句的强调标记一分为二；先处理加粗标签，
    // 再独立剥离 fragment 边缘标记，兼容 **注意：** 文本和
    // **现在需要生成最终文本。**，且不会人为补冒号形成“注意：：”。
    value = value.replace(/^\*\*([^*\n]{1,80})\*\*\s*/, '$1 ')
        .replace(/^__([^_\n]{1,80})__\s*/, '$1 ')
        .replace(/^(?:\*\*|__)+/, '')
        .replace(/(?:\*\*|__)+$/, '')
        .trim();
    return value;
}

function analysisEditorialFragments(line) {
    const value = normalizeAnalysisEditorialFragment(line);
    if (!value) return [];
    // 保留整行兼容既有规则，同时按明确句末标点切分，防止正常论述在同一
    // Markdown 行开头时遮蔽后面的模型自检句。ASCII 句点仅在后面紧跟
    // 高置信度自检开头时切分，避免把小数、缩写和 URL 拆碎。
    const parts = value.split(
        /[。！？!?；;]+\s*|\.\s+(?=(?:现在|接下来|让我们|注意|需要检查|now\b|next\b|note\b|important\b))/i
    );
    return [...new Set(
        [value, ...parts]
            .map(normalizeAnalysisEditorialFragment)
            .filter(Boolean)
    )];
}

function findAnalysisEditorialLeakages(analysis, options = {}) {
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 5;
    const matches = [];
    const seen = new Set();
    for (const rawLine of stripFencedCodeBlocks(analysis).split('\n')) {
        const trimmed = rawLine.trim();
        // 论文可能把模型输出作为引用/代码/表格研究对象；这些不是分析作者
        // 自己的叙事，因此不作为高置信度泄漏证据。
        if (!trimmed
            || /^(?:#{1,6}\s|>|\||!\[)/.test(trimmed)) continue;
        const line = trimmed
            .replace(/^(?:[-*+]\s+|\d+[.)、]\s*)/, '')
            .trim();
        const evidence = analysisEditorialFragments(line).find(fragment =>
            ANALYSIS_EDITORIAL_LEAK_PATTERNS.some(pattern => pattern.test(fragment))
        )?.slice(0, 180);
        if (!evidence) continue;
        if (seen.has(evidence)) continue;
        seen.add(evidence);
        matches.push(evidence);
        if (matches.length >= limit) break;
    }
    return matches;
}

function validateAnalysisEditorialLeakageContract(analysis) {
    const leakages = findAnalysisEditorialLeakages(analysis);
    return leakages.length > 0
        ? `检测到模型编辑/自检批注泄漏: ${leakages.join('；')}`
        : null;
}

function extractMarkdownTables(text) {
    const lines = stripFencedCodeBlocks(text).split('\n');
    const tables = [];
    for (let index = 0; index + 1 < lines.length;) {
        const header = splitMarkdownTableRow(lines[index]);
        if (header.length < 2 || !isMarkdownTableSeparator(lines[index + 1])) {
            index += 1;
            continue;
        }
        let end = index + 2;
        let dataRows = 0;
        const rows = [];
        const invalidColumnCounts = [];
        const separatorColumns = splitMarkdownTableRow(lines[index + 1]).length;
        while (end < lines.length) {
            const line = lines[end];
            const cells = splitMarkdownTableRow(line);
            if (!line.trim()) break;
            if (cells.length < 2 && !/^\s*\|.*\|\s*$/.test(line)) break;
            dataRows += 1;
            rows.push(cells);
            if (cells.length !== header.length) {
                invalidColumnCounts.push({ row: dataRows, columns: cells.length });
            }
            end += 1;
        }
        const identifierColumns = header.filter(cell => {
            const normalized = cell
                .replace(/<br\s*\/?>/gi, ' ')
                .replace(/[*_`]/g, '')
                .trim();
            return isTableIdentifierHeader(normalized);
        }).length;
        tables.push({
            header,
            rows,
            markdown: lines.slice(index, end).join('\n'),
            startLine: index,
            endLine: end - 1,
            dataRows,
            separatorColumns,
            invalidColumnCounts,
            identifierColumns,
            metricColumns: Math.max(0, header.length - identifierColumns)
        });
        index = Math.max(end, index + 2);
    }
    return tables;
}

function repairMissingMarkdownTableSeparators(text) {
    const lines = String(text || '').split('\n');
    const repaired = [];
    for (let index = 0; index < lines.length;) {
        if (!/^\s*\|.*\|\s*$/.test(lines[index])) {
            repaired.push(lines[index]);
            index += 1;
            continue;
        }
        let end = index;
        while (end < lines.length && /^\s*\|.*\|\s*$/.test(lines[end])) end += 1;
        const run = lines.slice(index, end);
        const header = splitMarkdownTableRow(run[0]);
        const second = run[1] ? splitMarkdownTableRow(run[1]) : [];
        if (run.length >= 2 && header.length >= 2
            && second.length === header.length
            && !isMarkdownTableSeparator(run[1])) {
            repaired.push(run[0], `| ${header.map(() => '---').join(' | ')} |`, ...run.slice(1));
        } else {
            repaired.push(...run);
        }
        index = end;
    }
    return repaired.join('\n');
}

function normalizeExperimentTableNumericFormatting(analysis) {
    const source = String(analysis || '');
    const rawResults = extractSection(source, '实验结果');
    const results = repairMissingMarkdownTableSeparators(rawResults);
    if (!results) return source;
    const normalized = results.split('\n').map(line => {
        if (!line.includes('|') || isMarkdownTableSeparator(line)) return line;
        const leading = /^\s*\|/.test(line);
        const trailing = /\|\s*$/.test(line);
        const cells = splitMarkdownTableRow(line);
        if (cells.length < 2) return line;
        const cleaned = cells.map(cell => cell
            .replace(/−/g, '-')
            .replace(/％/g, '%')
            .replace(/([<>=±+\-\[(,;/]|^)(\s*)\.(\d+)/g, '$1$20.$3')
            .replace(/(\d)\s+%/g, '$1%')
            .replace(/(\d)\s+pp\b/gi, '$1 pp')
            .trim());
        return `${leading ? '| ' : ''}${cleaned.join(' | ')}${trailing ? ' |' : ''}`;
    }).join('\n');
    if (normalized === rawResults) return source;
    const heading = /(^|\n)##(?!#)\s*实验结果[：:\s]*\n/;
    const match = heading.exec(source);
    if (!match) return source;
    const contentStart = match.index + match[0].length;
    const rest = source.slice(contentStart);
    const next = /\n##(?!#)\s/.exec(rest);
    const contentEnd = next ? contentStart + next.index : source.length;
    return source.slice(0, contentStart) + normalized + source.slice(contentEnd);
}

function capExperimentTableMetricColumns(analysis, maxMetricColumns = EXPERIMENT_TABLE_LIMITS.maxMetricColumns) {
    const source = String(analysis || '');
    const rawResults = extractSection(source, '实验结果');
    const results = repairMissingMarkdownTableSeparators(rawResults);
    if (!results) return source;
    const lines = results.split('\n');
    const tables = extractMarkdownTables(results);
    let changed = false;
    for (const table of tables.slice().reverse()) {
        if (table.metricColumns <= maxMetricColumns
            || table.separatorColumns !== table.header.length
            || table.invalidColumnCounts.length > 0) continue;
        let keptMetrics = 0;
        const keepIndexes = table.header.reduce((indexes, cell, index) => {
            const normalized = cell
                .replace(/<br\s*\/?>/gi, ' ')
                .replace(/[*_`]/g, '')
                .trim();
            const identifier = isTableIdentifierHeader(normalized);
            if (identifier || keptMetrics < maxMetricColumns) {
                indexes.push(index);
                if (!identifier) keptMetrics += 1;
            }
            return indexes;
        }, []);
        for (let lineIndex = table.startLine; lineIndex <= table.endLine; lineIndex += 1) {
            const cells = splitMarkdownTableRow(lines[lineIndex]);
            if (cells.length !== table.header.length) continue;
            lines[lineIndex] = `| ${keepIndexes.map(index => cells[index]).join(' | ')} |`;
        }
        changed = true;
    }
    if (!changed) return source;
    const normalized = lines.join('\n');
    const heading = /(^|\n)##(?!#)\s*实验结果[：:\s]*\n/;
    const match = heading.exec(source);
    if (!match) return source;
    const contentStart = match.index + match[0].length;
    const rest = source.slice(contentStart);
    const next = /\n##(?!#)\s/.exec(rest);
    const contentEnd = next ? contentStart + next.index : source.length;
    return source.slice(0, contentStart) + normalized + source.slice(contentEnd);
}

function sourceExperimentEvidence(sourceText) {
    const source = String(sourceText || '');
    const sectionNumber = '(?:(?:\\d+(?:\\.\\d+)*)|(?:[IVXLCDM]+))';
    const start = source.search(new RegExp(`(?:^|\\n)\\s*(?:${sectionNumber}\\s+)?(?:experiments?|experimental\\s+(?:setup|results?)|evaluation|results?(?:\\s+and\\s+discussion)?)\\s*(?:\\n|$)`, 'i'));
    if (start < 0) return source.slice(0, 50000);
    const tail = source.slice(start, start + 60000);
    const end = tail.search(new RegExp(`(?:^|\\n)\\s*(?:${sectionNumber}\\s+)?(?:conclusions?|limitations?|references?)\\s*(?:\\n|$)`, 'i'));
    return end > 0 ? tail.slice(0, end) : tail;
}

function hasAffirmedOverfittingEvidence(text) {
    const clauses = String(text || '').split(/[。；！？!?\n]/);
    const positivePattern = /(?:出现|发生|呈现|表现出|暴露出|导致|造成)(?:了)?[^，,：:\n未无不没]{0,12}(?:域)?过拟合/gi;
    for (const clause of clauses) {
        for (const match of clause.matchAll(positivePattern)) {
            const prefix = clause.slice(Math.max(0, match.index - 12), match.index);
            if (!/(?:未|没有|无|不曾|并未)[^，,：:\n]{0,10}$/.test(prefix)) return true;
        }
    }
    return false;
}

function validateExperimentTableEvidenceDepth(analysis, options = {}) {
    const results = extractSection(analysis, '实验结果');
    if (!results) return null;
    const tables = extractMarkdownTables(results);
    const documentType = String(options.documentType || '');
    const empirical = !NON_EMPIRICAL_DOCUMENT_TYPES.has(documentType);
    const sourceHasTable = /\b(?:table|tbl)\.?\s*(?:[a-z]?\d+|[ivxlcdm]+)\b|表\s*[（(]?\s*(?:\d+|[一二三四五六七八九十百零]+)|\\begin\{tabular\}|<table[\s>]/i.test(String(options.sourceText || ''));
    if (empirical && sourceHasTable && tables.length === 0) {
        return '实证论文的实验结果必须包含至少一张可读 Markdown 证据表';
    }
    const totalRows = tables.reduce((sum, table) => sum + table.dataRows, 0);
    if (empirical && tables.length > 0 && totalRows < EXPERIMENT_TABLE_LIMITS.minEvidenceRows) {
        return `实验表格合计只有 ${totalRows} 个数据行，至少需要 ${EXPERIMENT_TABLE_LIMITS.minEvidenceRows} 行比较证据`;
    }
    let numericCells = 0;
    const resultLines = results.split('\n');
    for (const [index, table] of tables.entries()) {
        if (table.identifierColumns < 1) {
            return `实验结果第 ${index + 1} 张表缺少方法、数据集或设置识别列`;
        }
        for (const header of table.header) {
            const normalized = header.replace(/[*_`]/g, '').trim();
            const identifier = isTableIdentifierHeader(normalized);
            if (!identifier && TABLE_VAGUE_METRIC_HEADER_RE.test(normalized)) {
                return `实验结果第 ${index + 1} 张表含叙述型伪指标列“${normalized}”，应改为可核对指标、设置或比较对象`;
            }
            if (!identifier && TABLE_DIRECTIONAL_METRIC_RE.test(normalized)
                && !TABLE_DIRECTION_MARK_RE.test(normalized)
                && !TABLE_NON_DIRECTIONAL_MEASURE_RE.test(normalized)) {
                return `实验结果第 ${index + 1} 张表指标“${normalized}”缺少 ↑/↓ 方向`;
            }
        }
        const metricIndexes = table.header.flatMap((header, index) => (
            isTableIdentifierHeader(header.replace(/<br\s*\/?>/gi, ' ').replace(/[*_`]/g, '').trim())
                ? [] : [index]
        ));
        for (const row of table.rows) {
            for (const columnIndex of metricIndexes) {
                const cell = row[columnIndex];
                const normalized = String(cell || '').replace(/[*_`]/g, '').trim();
                if (TABLE_NUMERIC_CELL_RE.test(normalized)) numericCells += 1;
                if (/−|％|(?:^|[<>=±+\-\[(,;/]\s*)\.\d|\d\s+%/.test(normalized)) {
                    return `实验结果第 ${index + 1} 张表数字格式未规范化：“${normalized}”`;
                }
            }
        }
        const comparisonPattern = /(?:比较|对比|基线|对照|检验|考察|回答|关键问题|差异|收益|代价|是否|能否|何种|多大|哪些)/;
        const boundaryPattern = /(?:相比|相对|差异|提升|下降|降低|增加|减少|但|而|同时|代价|边界|未|不显著|跨零|失败|退化)/;
        const before = resultLines.slice(0, table.startLine).join('\n').trim()
            .split(/\n\s*\n/).filter(Boolean).slice(-5).reverse()
            .find(paragraph => paragraph.replace(/[*_`#>\s]/g, '').length >= 20
                && comparisonPattern.test(paragraph)) || '';
        const after = resultLines.slice(table.endLine + 1).join('\n').trim()
            .split(/\n\s*\n/).filter(Boolean).slice(0, 5)
            .find(paragraph => paragraph.replace(/[*_`#>\s]/g, '').length >= 50
                && boundaryPattern.test(paragraph)) || '';
        if (!before) {
            return `实验结果第 ${index + 1} 张表前缺少与上下文衔接的具体比较问题`;
        }
        if (!after) {
            return `实验结果第 ${index + 1} 张表后缺少最关键差异、解释与证据边界`;
        }
    }
    if (empirical && tables.length > 0 && numericCells < EXPERIMENT_TABLE_LIMITS.minNumericCells) {
        return `实验表格只有 ${numericCells} 个可核对数字，至少需要 ${EXPERIMENT_TABLE_LIMITS.minNumericCells} 个；纯趋势或结论摘要不能替代结果表`;
    }
    const sourceText = sourceExperimentEvidence(options.sourceText);
    const sourceHasComparison = /\b(?:baseline|compared?\s+(?:to|with)|comparison|outperform(?:s|ed)?|versus|vs\.)\b|基线|对照|相比|优于|弱于/i.test(sourceText);
    const resultHasComparison = /\b(?:baseline|compared?\s+(?:to|with)|comparison|versus|vs\.)\b|基线|对照|比较(?:对象)?是|相比|相对|优于|弱于|对比|超过|高于|低于|升至|降至|比(?!较)[^。；\n]{0,30}(?:高|低|强|弱|好|差|大|小|提升|下降)/i.test(results);
    if (empirical && sourceHasComparison && !resultHasComparison) {
        return '全文包含基线或对照比较，但实验结果没有保留比较对象';
    }
    const sourceAblationEvidence = String(sourceText || '').replace(
        /\bno\s+(?:component\s+)?ablations?\b(?:\s+[^.?!\n]{0,40})?|\b(?:controlled\s+)?ablations?\s+(?:were|was)\s+not\s+(?:conducted|performed)\b|\babsence\s+of\s+(?:component\s+)?ablations?\b/gi,
        ' '
    );
    const sourceHasAblation = /\bablation\b|\bw\/?o\b|without\s+(?:the\s+)?(?:module|component|loss)|消融|移除|去掉/i.test(sourceAblationEvidence);
    const resultHasAblation = /\bablation\b|\bw\/?o\b|without\s+(?:the\s+)?(?:module|component|loss)|消融|移除|去掉|不含|排除|无外推/i.test(results)
        // 有的论文只用 `+ L_j`、`+ L_s` … 标注消融行，正文里说是逐级叠加。
        // 只要原文确实有消融，这仍然算显式的组件对照。
        || /(?:逐级|逐步|依次)(?:叠加|加入|添加|移除|比较)|(?:组件|约束|模块|损失|监督目标|局部配对|竞争归一化)[^。；\n]{0,24}(?:对照|贡献|差异|是否必要|必要性)/i.test(results)
        || /\+\s*L[_\s]?[A-Za-z](?:\s*\+\s*L[_\s]?[A-Za-z])+/i.test(results);
    if (empirical && sourceHasAblation && !resultHasAblation) {
        return '全文包含消融实验，但实验结果没有保留关键消融或组件对照';
    }
    // 原文明确说“没有退化/失败”时，不能当成负面结果。论文常写某个适配
    // "does not degrade" 源性能；否则光凭 `degrad` 这个词会把意思读反。
    const sourceNegativeEvidence = String(sourceText || '').replace(
        /\b(?:does|do|did)\s+not(?:\s+\w+){0,2}\s+(?:degrad(?:e|es|ed|ation)|fail(?:s|ed|ure)?)\b|\bno\s+(?:degrad(?:e|es|ed|ation)|fail(?:ure|ures)?)\b|\bwithout\s+(?:any\s+)?(?:degrad(?:e|es|ed|ation)|fail(?:ure|ures)?)\b|(?:未|没有|并未|无)[^。；\n]{0,12}(?:退化|失败)/gi,
        ' '
    );
    const sourceHasNegative = /not\s+significant|no\s+significant|degrad(?:e|es|ed|ation)|fail(?:s|ed|ure)?|worse\s+than|does\s+not\s+(?:improve|outperform)|未显著|不显著|退化|失败|更差|无效|负(?:面)?结果|性能回落|回落至|降幅|回退|不单调(?:性|改进)?|不保证单调(?:改进|提升)/i.test(sourceNegativeEvidence);
    const explicitHigherIsBetterMetric = '(?:性能|质量|得分|分数|准确率|自然度|一致性|合规率|动态幅度|多样性|表达力|成功率|召回率|精确率|F1)';
    const contextualNegative = new RegExp(
        `(?:代价|牺牲)[^。；\\n]{0,80}${explicitHigherIsBetterMetric}[^。；\\n]{0,40}(?:下降|降低|降至|减少|受限|受损)`
    ).test(results) || new RegExp(
        `(?:移除|去掉)[^。；\\n]{1,80}${explicitHigherIsBetterMetric}[^。；\\n]{0,40}(?:下降|降低|降至|受损)`
    ).test(results);
    const explicitMetricDecline = new RegExp(
        `(?:${explicitHigherIsBetterMetric}|转写|关键点覆盖)[^。；\\n]{0,40}(?:下降|下滑|降低|减少|受限|受损)`
    ).test(results) || new RegExp(
        `(?:下降|下滑|降低|受损)[^。；\\n]{0,40}(?:${explicitHigherIsBetterMetric}|转写|关键点覆盖)`
    ).test(results);
    const resultHasNegative = contextualNegative
        || explicitMetricDecline
        || /not\s+significant|no\s+significant|degrad(?:e|es|ed|ation)|fail(?:s|ed|ure)?|worse\s+than|does\s+not\s+(?:improve|outperform)|未显著|不显著|无显著(?:差异)?|退化|恶化|失败|失效|崩溃|接近随机|低于随机|损失|更差|比(?!较)[^。；\n]{0,30}差|未改善|没有改善|无效|负(?:面)?结果|负增益|性能回落|回落至|降幅|负面|暴露短板|跨零|落后|回退|不单调(?:性|改进)?|不保证单调(?:改进|提升)|(?:例外|反例)[^。；\n]{0,80}(?:低于|下降|更差)/i.test(results)
        || hasAffirmedOverfittingEvidence(results);
    if (empirical && sourceHasNegative && !resultHasNegative) {
        return '全文包含退化、不显著或失败结果，但实验结果没有保留负面证据';
    }
    return null;
}

function validateExperimentTableContract(analysis, options = {}) {
    const results = extractSection(analysis, '实验结果');
    if (!results) return null;
    const tables = extractMarkdownTables(results);
    if (tables.length > EXPERIMENT_TABLE_LIMITS.maxTables) {
        return `实验结果包含 ${tables.length} 张 Markdown 表格，最多允许 ${EXPERIMENT_TABLE_LIMITS.maxTables} 张`;
    }
    for (const [index, table] of tables.entries()) {
        if (table.separatorColumns !== table.header.length) {
            return `实验结果第 ${index + 1} 张表分隔行有 ${table.separatorColumns} 列，表头有 ${table.header.length} 列`;
        }
        if (table.invalidColumnCounts.length > 0) {
            const invalid = table.invalidColumnCounts[0];
            return `实验结果第 ${index + 1} 张表第 ${invalid.row} 个数据行有 ${invalid.columns} 列，表头有 ${table.header.length} 列`;
        }
        if (table.dataRows > EXPERIMENT_TABLE_LIMITS.maxDataRows) {
            return `实验结果第 ${index + 1} 张表包含 ${table.dataRows} 个数据行，最多允许 ${EXPERIMENT_TABLE_LIMITS.maxDataRows} 行`;
        }
        if (table.metricColumns > EXPERIMENT_TABLE_LIMITS.maxMetricColumns) {
            return `实验结果第 ${index + 1} 张表包含 ${table.metricColumns} 个指标列，最多允许 ${EXPERIMENT_TABLE_LIMITS.maxMetricColumns} 列（方法/数据集识别列不计）`;
        }
    }
    const contractVersion = options.contractVersion || EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION;
    if (contractVersion === EXPERIMENT_TABLE_CONTRACT_VERSION) {
        return validateExperimentTableEvidenceDepth(analysis, options);
    }
    if (contractVersion !== EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION) {
        return `未知实验表格契约版本: ${contractVersion}`;
    }
    return null;
}

function analysisManifestRequiresExperimentTableContract(manifest) {
    return EXPERIMENT_TABLE_CONTRACT_VERSIONS.includes(manifest?.contracts?.experimentTables);
}

function validateMethodDetailContract(analysis) {
    const method = extractSection(analysis, '方法概述和架构');
    const chineseCount = (method.match(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g) || []).length;
    if (chineseCount < 600) return `方法概述中文字符不足: ${chineseCount}/600`;
    if ([/详见原文/, /论文描述了详细架构/, /详细方法见/, /具体实现请参考/].some(pattern => pattern.test(method))) {
        return '方法概述包含空泛占位表述';
    }
    const structuralKeywords = ['输入', '输出', '流程', '组件', '模块', '阶段', '结构', '网络', '模型'];
    if (!structuralKeywords.some(keyword => method.includes(keyword))) return '方法概述缺少结构性描述';
    const paragraphs = method.split(/\n\s*\n/).filter(paragraph => paragraph.trim().length > 20);
    if (paragraphs.length < 3) return `方法概述有效段落不足: ${paragraphs.length}/3`;
    return null;
}

function validateManualDepthContract(analysis, options = {}) {
    const evaluationIssue = getPaperEvaluationHeadingIssue(analysis);
    if (evaluationIssue) return evaluationIssue;
    // 旧的 manual 闸只看方法段够不够长，于是模板文也能蒙混过关：摘要很短、
    // 三条泛泛的创新点、一个两列占位表格。API 那条路有完整的全文审查与修复链；
    // manual_complete 即使不调用 LLM，也要达到同样的读者可见质量下限。
    const method = extractSection(analysis, '方法概述和架构');
    const results = extractSection(analysis, '实验结果');
    const details = extractSection(analysis, '细节详述');
    const summary = extractSection(analysis, '核心摘要');
    const innovation = extractSection(analysis, '核心创新点');
    const scoring = extractSection(analysis, '评分理由');
    const limits = extractSection(analysis, '局限与问题');
    const chineseCount = value => (String(value || '').match(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g) || []).length;
    if (chineseCount(method) < 650) return `manual 全文方法证据不足: ${chineseCount(method)}/650 个中文字符`;
    if (chineseCount(summary) < 360) return `manual 核心摘要过短: ${chineseCount(summary)}/360 个中文字符`;
    if (chineseCount(innovation) < 380) return `manual 核心创新点过短: ${chineseCount(innovation)}/380 个中文字符`;
    if (chineseCount(results) < 300) return `manual 全文实验证据不足: ${chineseCount(results)}/300 个中文字符`;
    if (chineseCount(details) < 450) return `manual 全文细节证据不足: ${chineseCount(details)}/450 个中文字符`;
    if (chineseCount(scoring) < 250) return `manual 评分理由过短: ${chineseCount(scoring)}/250 个中文字符`;
    if (chineseCount(limits) < 200) return `manual 局限分析过短: ${chineseCount(limits)}/200 个中文字符`;
    if (/(?:从复现角度|本分析|人工(?:审计|接管)|manual_complete|不能由本分析|不补造|实验数字只采用|按来源逐项核对|全文事实摘录|论文明确写到|第\s*(?:\d+|[一二三四五六七八九十]+)\s*个证据块|证据块|结果证据\s*\d+|方法事实\s*\d+|实验事实\s*\d+|实现细节\s*\d+|实验\/部署细节\s*\d+)/i.test(analysis)) {
        return 'manual 正文包含流程/审计元话语，必须改写为论文事实';
    }
    const resultTables = extractMarkdownTables(results);
    const sourceText = String(options.sourceText || '');
    const paperHasTable = /(?:\btable\s*\d+\b|\btab\.\s*\d+\b|表\s*\d+)/i.test(sourceText);
    if (paperHasTable && resultTables.length === 0) return '全文包含实验表格，但实验结果没有可读 Markdown 表格';
    if (paperHasTable && resultTables.length < 1) return '全文实验表格未被转写为读者可读证据';
    const numericHits = (results.match(/(?<![A-Za-z])\d+(?:\.\d+)?(?:%|ms|s|Hz|kHz|M|B|GB|×)?/g) || []).length;
    const sourceNumericHits = (sourceText.match(/(?<![A-Za-z])\d+(?:\.\d+)?(?:%|ms|s|Hz|kHz|M|B|GB|×)?/g) || []).length;
    if (sourceNumericHits >= 8 && numericHits < 3) return `manual 实验结果缺少可核对数字: ${numericHits}/3`;
    if ([MANUAL_DEPTH_CONTRACT_VERSION_V2, MANUAL_DEPTH_CONTRACT_VERSION_V3,
        ...MANUAL_READER_QUALITY_VERSIONS]
        .includes(options.manualDepthContractVersion)) {
        const v2Issue = validateManualDepthContractV2(analysis, { sourceText });
        if (v2Issue) return v2Issue;
    }
    if ([MANUAL_DEPTH_CONTRACT_VERSION_V3, ...MANUAL_READER_QUALITY_VERSIONS]
        .includes(options.manualDepthContractVersion)) {
        const v3Issue = validateManualDepthContractV3(analysis, { sourceText });
        if (v3Issue) return v3Issue;
    }
    if (MANUAL_READER_QUALITY_VERSIONS.includes(options.manualDepthContractVersion)) {
        const quality = validateEditorialQuality(analysis);
        if (!quality.valid) {
            const details = quality.issues.slice(0, 6)
                .map(item => `${item.code}:${item.section || '-'}:${item.match || item.message}`)
                .join('；');
            return `manual v4 读者文本质量未通过: ${details}`;
        }
    }
    if (options.manualDepthContractVersion === MANUAL_DEPTH_CONTRACT_VERSION_V5) {
        try {
            validateExactFactCoverage(analysis, sourceText, {
                label: 'manual v5 analysis',
                derivedFacts: options.researchBrief?.derivedFacts || [],
                externalEvidence: options.openSourceEvidence?.sourceQuotes || [],
                boundEvidence: [
                    ...(options.resultClaims || []).map(claim => claim.sourceQuote),
                    ...(options.evidenceLedger || []).map(item => item.sourceQuote)
                ]
            });
        } catch (error) {
            return error.message;
        }
    }
    return null;
}

// 这些章节必须各写各的。2026-08-20 那批 manual 最突出的毛病就是跨章节重复：
// 同一段动机/取舍文字被贴进 4-5 个章节，连评分理由里也有。
const MANUAL_DUP_CHECK_SECTIONS = Object.freeze([
    '核心摘要', '方法概述和架构', '核心创新点', '实验结果',
    '细节详述', '评分理由', '局限与问题', '开源详情'
]);
const MANUAL_DUP_MIN_SENTENCE_CHARS = 15;
const MANUAL_DUP_MAX_SENTENCES = 2;
const MANUAL_DUP_MAX_SECTION_SPREAD = 2;

function normalizeManualDupSentence(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[\s\p{P}\p{S}]+/gu, '')
        .toLowerCase();
}

function findCrossSectionDuplicateSentences(analysis, options = {}) {
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 3;
    const sentenceSections = new Map();
    for (const section of MANUAL_DUP_CHECK_SECTIONS) {
        const body = extractSection(analysis, section);
        if (!body) continue;
        const seenInSection = new Set();
        for (const rawSentence of body.split(/[。！？!?\n]/)) {
            const normalized = normalizeManualDupSentence(rawSentence);
            if (normalized.length < MANUAL_DUP_MIN_SENTENCE_CHARS) continue;
            if (seenInSection.has(normalized)) continue;
            seenInSection.add(normalized);
            if (!sentenceSections.has(normalized)) sentenceSections.set(normalized, new Set());
            sentenceSections.get(normalized).add(section);
        }
    }
    const duplicates = [];
    for (const [sentence, sections] of sentenceSections) {
        if (sections.size >= 2) duplicates.push({ sentence, sections: [...sections] });
    }
    return duplicates.slice(0, limit);
}

// 2026-08-20 那批 20 篇论文套的是同一个编辑模板：
// “亮点是一是……二是……三是……短板是……”，而“短板”只是复述作者自己承认的
// 局限，不是独立审查发现的问题。
const MANUAL_EDITORIAL_TEMPLATE_PATTERNS = Object.freeze([
    /亮点[：:]?\s*一是/,
    /优点[：:]?\s*一是/,
    /短板是/,
    /不足[：:]?\s*一是[^。]{0,120}二是[^。]{0,120}三是/
]);

const MANUAL_SCORING_ANCHOR_TAG_MIN = 4;
const MANUAL_SCORING_ANCHOR_TAG_RE = /\[A_[A-Z_]{2,}\]/g;

function findManualOpensourceRepoUrls(sourceText) {
    return String(sourceText || '').match(
        /https?:\/\/(?:[a-z0-9-]+\.)*(?:github\.com|huggingface\.co|gitlab\.com|modelscope\.cn)\/[^\s)"'<>，。；]+/i
    ) || [];
}

function validateManualDepthContractV2(analysis, options = {}) {
    const sourceText = String(options.sourceText || '');
    const duplicates = findCrossSectionDuplicateSentences(analysis);
    const worstSectionSpread = duplicates.reduce((max, item) => Math.max(max, item.sections.length), 0);
    if (duplicates.length > MANUAL_DUP_MAX_SENTENCES || worstSectionSpread > MANUAL_DUP_MAX_SECTION_SPREAD) {
        const example = duplicates[0];
        return `manual 正文存在跨章节自我复制: ${duplicates.length} 个句子重复出现在多个章节（如「${example.sentence.slice(0, 24)}…」同时出现在${example.sections.join('、')}），每个章节必须独立撰写`;
    }
    const editorial = extractSection(analysis, PAPER_EVALUATION_TITLE);
    for (const pattern of MANUAL_EDITORIAL_TEMPLATE_PATTERNS) {
        if (pattern.test(editorial)) {
            return 'Manual 论文评价使用了固定模板句式（亮点一是二是/短板是），必须依据这篇论文独立评价。';
        }
    }
    const scoringReason = extractSection(analysis, '评分理由');
    const anchorTags = new Set((scoringReason.match(MANUAL_SCORING_ANCHOR_TAG_RE) || []));
    if (anchorTags.size < MANUAL_SCORING_ANCHOR_TAG_MIN) {
        return `manual 评分理由缺少证据锚点标签 [A_*]: 仅 ${anchorTags.size}/${MANUAL_SCORING_ANCHOR_TAG_MIN} 个不同标签，每个维度必须引用可定位的证据组并说明锚点档位`;
    }
    const opensource = extractSection(analysis, '开源详情');
    if (findManualOpensourceRepoUrls(sourceText).length > 0 && !/https?:\/\//i.test(opensource)) {
        return '全文提及 GitHub/HuggingFace 等开源仓库链接，但开源详情未提取任何具体 URL，必须逐项核对 availability statement 后列出';
    }
    return null;
}

function chineseCharacterCount(value) {
    return (String(value || '').match(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g) || []).length;
}

function proseParagraphs(value) {
    return String(value || '').split(/\n\s*\n/).map(item => item.trim()).filter(item => (
        item.length > 20 && !/^\|/.test(item) && !/^!\[/.test(item)
    ));
}

function validateManualDepthContractV3(analysis, options = {}) {
    const summary = extractSection(analysis, '核心摘要');
    const method = extractSection(analysis, '方法概述和架构');
    const innovations = extractSection(analysis, '核心创新点');
    const results = extractSection(analysis, '实验结果');
    const details = extractSection(analysis, '细节详述');
    const scoring = extractSection(analysis, '评分理由');
    const limits = extractSection(analysis, '局限与问题');
    const sourceText = String(options.sourceText || '');

    const summarySentences = summary.split(/[。！？!?]/).map(item => item.trim()).filter(item => chineseCharacterCount(item) >= 8);
    if (summarySentences.length < 5) return `manual v3 核心摘要缺少论证推进: ${summarySentences.length}/5 个有效句子`;

    const methodParagraphs = proseParagraphs(method);
    if (methodParagraphs.length < 5) return `manual v3 方法段落不足: ${methodParagraphs.length}/5`;
    const methodSignals = [
        /输入|波形|特征|样本|数据/,
        /模块|编码器|解码器|网络|组件|算子|阶段|结构/,
        /训练|优化|损失|目标|监督|更新|拟合|求解|实验|控制|构造|标注|证明/,
        /输出|推理|解码|预测|生成|检索|评估|结果|结论|决策/
    ];
    const missingMethodSignals = methodSignals.filter(pattern => !pattern.test(method)).length;
    if (missingMethodSignals > 1) return `manual v3 方法缺少输入、组件、训练目标或输出边界中的 ${missingMethodSignals} 类`;

    const innovationItems = proseParagraphs(innovations).filter(item => !/^引导|^总的来说/.test(item));
    if (innovationItems.length < 3) return `manual v3 创新论证不足: ${innovationItems.length}/3 个独立段落`;
    if (!/(?:相比|相较|比|既有|传统|标准|过去|不同于|不再|无需|而不|而非|避免|问题|限制|瓶颈|缺口|代价)/.test(innovations)
        || !/(?:机制|通过|采用|引入|设计|改为|拆分|把|将|使用|以|定义|提出)/.test(innovations)
        || !/(?:实验|评测|结果|消融|证据|数据|数值|观察|报告|达到|下降|提升|改善|验证)/.test(innovations)) {
        return 'manual v3 创新点必须同时说明既有缺口、新机制和实验证据，不能只列贡献名词';
    }

    if (!/(?:相比|相较|比较|配对|对照|基线|baseline|vs\.?|消融|移除|加入|主方法|提出方法|最强|高于|低于|超过|落后|优于|改善|差距|从[^。]{0,40}(?:升至|降至|到))/i.test(results)) {
        return 'manual v3 实验结果缺少明确比较对象或消融关系';
    }
    if (!/(?:但是|但|不过|仅|尚未|不能|限制|边界|未报告|未说明|而非|并非|不存在|退化|失败|更差|不显著|跨零)/.test(results)) {
        return 'manual v3 实验结果缺少结论边界或负面结果';
    }
    const numericHits = results.match(/(?<![A-Za-z])\d+(?:\.\d+)?(?:%|ms|s|Hz|kHz|M|B|GB|×)?/g) || [];
    const sourceNumericHits = sourceText.match(/(?<![A-Za-z])\d+(?:\.\d+)?(?:%|ms|s|Hz|kHz|M|B|GB|×)?/g) || [];
    if (sourceNumericHits.length >= 12 && numericHits.length < 3) {
        return `manual v3 实验数字密度不足: ${numericHits.length}/3`;
    }

    const reproducibilitySignals = [
        /数据|语料|样本|划分|训练集|测试集/,
        /损失|目标|优化器|学习率|训练|求解/,
        /超参数|批量|轮|epoch|步数|阈值|维度|窗口/i,
        /硬件|GPU|CPU|显卡|内存|显存|未说明/,
        /推理|解码|延迟|吞吐|部署|测试时|未说明/
    ];
    const reproducibilityText = `${method}\n${details}`;
    const detailsCoverage = reproducibilitySignals.filter(pattern => pattern.test(reproducibilityText)).length;
    if (detailsCoverage < 3) return `manual v3 复现信息覆盖不足: ${detailsCoverage}/5 类`;

    const scoreLines = scoring.split(/\n+/).map(item => item.trim()).filter(item => /^\*/.test(item));
    if (scoreLines.length !== 8) return `manual v3 评分理由必须恰好 8 条: ${scoreLines.length}/8`;
    const shallowScore = scoreLines.find(item => chineseCharacterCount(item.replace(/^\*[^：:]*[：:]\s*/, '')) < 25);
    if (shallowScore) return `manual v3 评分理由过于概括: ${shallowScore.slice(0, 80)}`;
    if (scoreLines.some(item => /(?:创新|方法|实验|清晰度|实用|开源|可复现性|综合)维度(?:认可|体现|有|中)/.test(item))) {
        return 'manual v3 评分理由仍是“某维度认可/体现”模板，必须直接写论文证据与扣分边界';
    }

    if (!/论文证据直接支持的边界/.test(limits) || !/进一步审视/.test(limits)) {
        return 'manual v3 局限必须分开标注论文证据支持的边界与进一步审视';
    }
    if (chineseCharacterCount(limits) < 300) return `manual v3 局限分析过短: ${chineseCharacterCount(limits)}/300`;
    return null;
}

function analysisManifestRequiresMethodDetailContract(manifest) {
    return manifest?.contracts?.methodDetail === METHOD_DETAIL_CONTRACT_VERSION;
}

function isRecoveryStageTerminal(stage, status) {
    return Boolean(RECOVERY_STAGE_TERMINAL_STATUSES[stage]?.includes(status));
}

function stripCoreSummaryNonResultNumerals(text) {
    return String(text || '')
        // 短指标缩写要区分大小写："map"、"per"、"most" 这些普通词
        // 不是 mAP、PER 或 MOS-T 的测量值。
        .replace(/\b(?:map|Map|per|Per|most|Most|MOST)\b/g, ' ')
        .replace(/\bMel(?=[- ](?:spectrogram|filterbank|QCD|control)\b)/gi, ' ')
        .replace(/\bSTFT(?=[⁡(])/g, ' ')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/\[[0-9,;\s-]+\]/g, ' ')
        .replace(/§\s*\d+(?:\.\d+)*/g, ' ')
        .replace(/\b(?:theorem|lemma|proposition|corollary|definition|def\.?|problem|prob\.?|assumption|equation|fig(?:ure)?\.?|table|section|appendix)\s*\d+(?:\.\d+)*/gi, ' ')
        .replace(/(?:定理|引理|命题|推论|公理|定义|假设|公式|方程|等式|式|图|表|章节|附录)\s*(?:编号)?\s*\d+(?:\.\d+)*/g, ' ')
        .replace(/(?<![A-Za-z0-9_])\d+(?:,\d{3})*(?:\.\d+)?\s*(?:种\s*)?(?:languages?|语言)(?![A-Za-z0-9_])/gi, ' ')
        .replace(/\b(?:19|20)\d{2}\b/g, ' ')
        .replace(/\b\d+(?:\.\d+)?\s*[BbMmKk]\b/g, ' ')
        .replace(/\b(?:v|ver(?:sion)?\.?)[-_ ]?\d+(?:\.\d+)*\b/gi, ' ')
        .replace(/\b[A-Za-z][A-Za-z0-9_-]*[-_]\d+(?:\.\d+)+(?:[-_][A-Za-z0-9.]+)?\b/g, ' ')
        .replace(/\b(?:Qwen|Llama|Gemma|Phi|GPT|Claude|Mistral|Whisper|HuBERT|WavLM|Wan|LTX)\s*[-_ ]?\d+(?:\.\d+)*(?:\s*[BbMmKk])?\b/gi, ' ');
}

function hasCoreSummaryComparisonDirection(sentence, numbers) {
    // 示意图里的 "from inputs to outputs" 是映射关系，不是实测提升。
    // 数字上的变化必须写明起始值。
    const directionSurface = sentence.replace(/\bfrom\b([^。！？!?]{0,50})\bto\b/gi,
        (match, between) => /\d/.test(between) ? match : ' ');
    if (CORE_SUMMARY_COMPARISON_PATTERN.test(directionSurface)
        || /(?:从|由)[^。！？!?]{0,40}(?:升至|升到|降至|降到|提升至|提高到)/.test(sentence)) return true;
    // “基线为 12.4%，本文方法降至 9.8%”省略“从/由”，仍写明了起始值、终止值及各自对应的方法；
    // “相对基线 12.4% 升至 9.8%”仍没有独立命名终点，不能仅凭两个数字通过。
    return numbers.length >= 2 && CORE_SUMMARY_BARE_TRANSITION_PATTERN.test(sentence)
        && /(?:基线|对照)[^，；。]{0,80}[，；][^。]{0,80}(?:本文方法|本方法|所提方法|完整模型)[^。]{0,40}(?:升至|降至)/.test(sentence);
}

function hasCoreSummaryQuantitativeEvidence(text) {
    return String(text || '').split(/[。！？!?\n]/).some(rawSentence => {
        const sentence = stripCoreSummaryNonResultNumerals(rawSentence.trim());
        if (!sentence) return false;
        const numbers = sentence.match(CORE_SUMMARY_NUMBER_PATTERN) || [];
        if (!numbers.length) return false;
        const hasComparisonObject = CORE_SUMMARY_COMPARISON_OBJECT_PATTERN.test(sentence);
        const hasDirection = hasCoreSummaryComparisonDirection(sentence, numbers);
        // 音乐论文里的 "score(s)" 通常指乐谱而不是评价指标；"performance"
        // 也可能指实际演奏的音频。这些通用英文词只有在句子明确把它们
        // 和数值或方向绑在一起时，才算结果指标。
        const withoutGenericEnglishMetrics = sentence.replace(
            new RegExp(CORE_SUMMARY_GENERIC_ENGLISH_METRIC_PATTERN.source, 'gi'), ' '
        );
        const hasSpecificMetric = CORE_SUMMARY_METRIC_PATTERN.test(withoutGenericEnglishMetrics)
            || CORE_SUMMARY_CONFERENCE_METRIC_PATTERN.test(withoutGenericEnglishMetrics);
        const hasExplicitGenericMetric = CORE_SUMMARY_GENERIC_ENGLISH_METRIC_PATTERN.test(sentence)
            && (hasDirection || /(?<![A-Za-z0-9_])(?:scores?|performance|metrics?)(?![A-Za-z0-9_])[^。！？!?\n]{0,24}\b(?:is|are|was|were|at|of)\b\s*[-+]?\d/i.test(sentence));
        const nonOperationalSentence = sentence.replace(
            new RegExp(CORE_SUMMARY_OPERATIONAL_PARAMETER_PATTERN.source, 'gi'), ' ');
        const nonOperationalWithoutGeneric = nonOperationalSentence.replace(
            new RegExp(CORE_SUMMARY_GENERIC_ENGLISH_METRIC_PATTERN.source, 'gi'), ' '
        );
        const hasNonOperationalMetric = CORE_SUMMARY_METRIC_PATTERN.test(nonOperationalWithoutGeneric)
            || CORE_SUMMARY_CONFERENCE_METRIC_PATTERN.test(nonOperationalWithoutGeneric)
            || hasExplicitGenericMetric;
        // 延迟、吞吐、硬件、训练设置的数字不会因为邻近句子出现
        // “experiment”或“evaluation”就变成结果对比。只有原文点明了对比对象，
        // 或给出明确的方向变化，它才算结果证据。同一句里的运行细节
        // 不能掩盖单独报告的结果指标。
        if (CORE_SUMMARY_OPERATIONAL_PARAMETER_PATTERN.test(sentence)
            && !hasComparisonObject && !hasDirection && !hasNonOperationalMetric) return false;
        if (hasSpecificMetric || hasExplicitGenericMetric) return true;
        if (!hasDirection) return false;
        const measuredUnit = numbers.some(value => /(?:%|％|dB|ms|s|秒|分钟|小时|倍|点|分)$/i.test(value.trim()));
        const resultNoun = /(?:结果|数值|增益|差值|百分点|相对|绝对)/.test(sentence);
        return !(CORE_SUMMARY_NON_RESULT_PATTERN.test(sentence) && !measuredUnit && !resultNoun)
            && (numbers.length >= 2 || measuredUnit || resultNoun);
    });
}

function hasSourceMeasuredLossComparison(sentences) {
    const values = Array.isArray(sentences) ? sentences : [];
    return values.some((rawSentence, index) => {
        const sentence = stripCoreSummaryNonResultNumerals(rawSentence);
        const numbers = sentence.match(CORE_SUMMARY_NUMBER_PATTERN) || [];
        if (numbers.length < 2
            || !/\b(?:(?:signal|test|validation)\s+)?loss\s+function\s+values?\b|\b(?:test|validation)\s+loss(?:\s+values?)?\b/i.test(sentence)) {
            return false;
        }
        const hasNamedSides = /\b(?:baseline|control|reference|comparison)\b/i.test(sentence)
            && /\b(?:our|ours|proposed|present|this)\s+(?:approach|method|model|system|technique)\b/i.test(sentence);
        const hasExplicitContrast = /\b(?:while|whereas|versus|vs\.?|compared\s+(?:with|to))\b/i.test(sentence);
        if (!hasNamedSides && !hasExplicitContrast) return false;
        const localContext = values.slice(Math.max(0, index - 2), index + 1).join(' ');
        // 只有训练目标的数字属于运行证据。loss function 这条特殊分支只在
        // 上下文把它绑到评测/测试/基准结果上时才保留。
        return /(?:comparative\s+evaluation|evaluation\s+result|benchmark|test\s+set|validation\s+set|dataset|对比评测|评测结果|基准|测试集|验证集|数据集)/i.test(localContext);
    });
}

function classifySourceQuantitativeEvidence(sourceText, sentences = null) {
    if (!sourceText) return null;
    const values = Array.isArray(sentences) ? sentences : String(sourceText).trim()
        .split(/[。！？!?\n]|\.(?=\s+[A-Z][A-Za-z]|$)/)
        .map(sentence => sentence.trim()).filter(Boolean);
    return values.some((sentence, index) => {
        if (!hasCoreSummaryQuantitativeEvidence(sentence)) return false;
        const localContext = values.slice(Math.max(0, index - 1), Math.min(values.length, index + 2)).join(' ');
        return /(?:experiment|evaluation|result|benchmark|test set|dataset|table|metric|实验|评测|结果|基准|测试集|数据集|表格|指标)/i
            .test(localContext);
    }) || hasSourceMeasuredLossComparison(values);
}

function stripDuplicatedLineFootnoteMarkers(text) {
    return String(text || '').replace(
        /([^\d\r\n])[ \t]+(\d{1,3})\r?\n[ \t]*(\d{1,3})[ \t]*(?=\r?\n|$)/g,
        (match, preceding, inline, standalone) => (
            inline === standalone || inline === `${standalone}${standalone}` ? preceding : match
        )
    );
}

function coreSummaryQuantitativeResultState(text) {
    const candidates = String(text || '').split(/[。！？!?\n]/).map(rawSentence => {
        const sentence = stripCoreSummaryNonResultNumerals(rawSentence.trim());
        // CLAP 既可能指指标，也可能指对照模型。写明 model/baseline
        // 不能顶替缺失的结果指标。
        const metricText = sentence.replace(/\bCLAP\s*(?:基线|模型|baseline\b|model\b)/giu, '');
        const hasMetric = Boolean(sentence && (
            CORE_SUMMARY_METRIC_PATTERN.test(metricText)
            || CORE_SUMMARY_CONFERENCE_METRIC_PATTERN.test(metricText)
        ));
        const numbers = sentence.match(CORE_SUMMARY_NUMBER_PATTERN) || [];
        const hasDirection = Boolean(sentence
            && hasCoreSummaryComparisonDirection(sentence, numbers));
        // 会议原文常把具体划分写成“AliMeeting远场集”或“VoxAngeles未见语言集”，
        // 这算真实的评测设置，尽管里面既没有“数据集”三个字，也没有
        // `test/benchmark` 这样的英文词。只接受带明确设置后缀的拉丁文命名标识；
        // 上面那套通用设置词表不变。
        const hasNamedSetting = /(?:[A-Z][A-Za-z0-9._-]{2,}\s*[\u3400-\u9fff]{0,8}(?:集|数据集|语料|任务|基准)|(?:在|于)\s*[A-Z][A-Za-z0-9._-]{2,}(?:\s*[上中下]))/i.test(sentence);
        const hasSetting = /(?:数据集|测试集|验证集|基准|评测|评价|协议|设置|条件|场景|任务|语料|套件|主干|对照|数据点|样本点|观测(?:点|值)|语言|口音|性别|选项顺序|码切换|单语|多语|语言对|组合|同一|相同|公开|内部|外部|\b(?:on|test|benchmark|evaluation)\b)/i.test(sentence)
            || hasNamedSetting;
        const hasComparisonObjects = numbers.length >= 2
            || /(?:基线|对照|相比|相较|原方法|已有方法|先前方法|本文方法|移除|完整模型|竞品)/.test(sentence);
        const crossMetricComparison = hasCrossMetricDirectionalComparison(sentence);
        const missing = [
            !hasSetting && '评测设置', !hasMetric && '指标名称',
            numbers.length === 0 && '数值', !hasDirection && '比较方向',
            !hasComparisonObjects && '比较对象',
            crossMetricComparison && '指标口径一致（方向连接词两侧不能是不同指标）'
        ].filter(Boolean);
        return {
            complete: Boolean(sentence) && missing.length === 0,
            missing,
            hasNumbers: numbers.length > 0,
            signalCount: Number(hasSetting) + Number(hasMetric) + Number(numbers.length > 0)
                + Number(hasDirection) + Number(hasComparisonObjects)
        };
    });
    if (candidates.some(candidate => candidate.complete)) return { complete: true, missing: [] };
    const best = candidates.sort((left, right) => right.signalCount - left.signalCount
        || Number(right.hasNumbers) - Number(left.hasNumbers))[0];
    return { complete: false, missing: best?.missing || [
        '评测设置', '指标名称', '数值', '比较方向', '比较对象'
    ] };
}

function nearestCoreSummaryMetricLabel(segment, fromRight) {
    const candidates = [];
    // PESQ 这样的裸词既可能是指标，也可能是基线方法。
    // Only an explicit "X分数/X得分/X指标" label is safe to compare here.
    const custom = /(?<![A-Za-z0-9_])([A-Za-z][A-Za-z0-9_-]{1,39})(?=\s*(?:分数|得分|指标))/g;
    for (const match of String(segment || '').matchAll(custom)) {
        candidates.push({ index: match.index, value: match[1].toLowerCase().replace(/[\s_-]+/g, '') });
    }
    if (!candidates.length) return '';
    candidates.sort((left, right) => left.index - right.index);
    return (fromRight ? candidates[candidates.length - 1] : candidates[0]).value;
}

function hasCrossMetricDirectionalComparison(sentence) {
    const source = String(sentence || '');
    for (const match of source.matchAll(CORE_SUMMARY_DIRECTION_CONNECTOR_PATTERN)) {
        const left = nearestCoreSummaryMetricLabel(source.slice(Math.max(0, match.index - 80), match.index), true);
        const rightStart = match.index + match[0].length;
        const right = nearestCoreSummaryMetricLabel(source.slice(rightStart, rightStart + 80), false);
        if (left && right && left !== right) return true;
    }
    return false;
}

function hasCompleteCoreSummaryQuantitativeResult(text) {
    return coreSummaryQuantitativeResultState(text).complete;
}

function validateCoreSummarySemanticContract(analysis, options = {}) {
    const summary = extractSection(String(analysis || ''), '核心摘要');
    const count = chineseCharacterCount(summary);
    const sentences = (summary.match(/[。！？!?]/g) || []).length;
    const issues = [];
    if (count < CORE_SUMMARY_MIN_CHINESE_CHARS) {
        issues.push(`中文字符不足: ${count}/${CORE_SUMMARY_MIN_CHINESE_CHARS}`);
    } else if (count > CORE_SUMMARY_MAX_CHINESE_CHARS) {
        issues.push(`中文字符过多: ${count}/${CORE_SUMMARY_MAX_CHINESE_CHARS}`);
    }
    if (sentences < CORE_SUMMARY_MIN_SENTENCES || sentences > CORE_SUMMARY_MAX_SENTENCES) {
        issues.push(`句数必须为 ${CORE_SUMMARY_MIN_SENTENCES}–${CORE_SUMMARY_MAX_SENTENCES}，当前 ${sentences}`);
    }
    if (!/(?:问题|难点|任务|目标|输入|输出|旨在|针对|解决)/.test(summary)) {
        issues.push('缺少任务问题、输入输出或实际难点');
    }
    const chain = summary.match(/(?:第一|第二|第三|第四|首先|其次|然后|随后|接着|最后|先|再|阶段|步骤|模块|组件|分(?:\d+|[一二三四五六七八九十]+)步)/g) || [];
    const roles = summary.match(/(?:负责|用于|承担|提取|编码|定位|筛选|生成|融合|对比|优化|校准|解码|预测|输出|构建|约束|传递|送入)/g) || [];
    const tierRoleStages = new Set([...summary.matchAll(
        /(?<![A-Za-z0-9_])Tier[-‐‑‒–—]([LMH])(?![A-Za-z0-9_])[^；。！？!?\n]{0,120}(?:负责|用于|承担|提取|编码|定位|筛选|生成|融合|对比|优化|校准|解码|预测|输出|构建|约束|传递|送入|打分|匹配|投票|检索|推理|判决|路由)/gi
    )].map(match => match[1].toUpperCase()));
    const hasNumberedMethodChain = (chain.length >= 2
        || /分(?:\d+|[一二三四五六七八九十]+)步/.test(summary)) && roles.length >= 2;
    const hasTieredMethodChain = tierRoleStages.size >= 2;
    if (!hasNumberedMethodChain && !hasTieredMethodChain) {
        issues.push('缺少 2–4 步方法链的分工与衔接');
    }
    const sourceText = typeof options === 'string' ? options : String(options.sourceText || '');
    // LaTeXML/PDF 抽取会把脚注标记重复一次：正文里一次，下一行又单独出现一遍
    // （观察到的 "11\n1" 就是标记 1 的双重渲染）。合并软换行前只删掉完全相同的
    // 这一对；普通的行尾测量值只要下一行不同，仍然是证据。
    const quantitativeSourceText = stripDuplicatedLineFootnoteMarkers(sourceText)
        // 合并 PDF 软换行前只剥掉大纲编号。指标词表旁边的标题不是数值结果。
        .replace(/^\s*\d{1,2}(?:\.\d+){0,3}[ \t]+(?=[A-Z][A-Za-z])/gm, '')
        .replace(/([^\n])\r?\n(?!\r?\n)/g, '$1 ');
    const quantitativeSourceSentences = quantitativeSourceText.trim()
        .split(/[。！？!?\n]|\.(?=\s+[A-Z][A-Za-z]|$)/)
        .map(sentence => sentence.trim())
        .filter(Boolean);
    // 上面已经合并过 PDF 软换行。来源分类器特意把实测结果证据和
    // GPU 数、步数、延迟、算力开销这类运行参数分开。
    const sourceHasQuantitativeEvidence = classifySourceQuantitativeEvidence(
        sourceText, quantitativeSourceSentences);
    const quantitativeResultState = coreSummaryQuantitativeResultState(summary);
    const completeQuantitativeResult = quantitativeResultState.complete;
    if (sourceHasQuantitativeEvidence === true && !completeQuantitativeResult) {
        issues.push('已有证据包含关键定量结果，但摘要没有写清比较对象、评测设置、指标、数值与方向'
            + `（最接近的同句量化候选缺少：${quantitativeResultState.missing.join('、')}）`);
    } else if (sourceHasQuantitativeEvidence === false
        && !summary.includes(CORE_SUMMARY_RESULT_UNAVAILABLE)) {
        issues.push(`原文无可核定量结果时必须明确写“${CORE_SUMMARY_RESULT_UNAVAILABLE}”`);
    } else if (sourceHasQuantitativeEvidence === null && !completeQuantitativeResult
        && !summary.includes(CORE_SUMMARY_RESULT_UNAVAILABLE)) {
        issues.push(`缺少完整关键定量结果或明确的“${CORE_SUMMARY_RESULT_UNAVAILABLE}”声明`);
    }
    const explicitBoundary = /(?:边界|局限|适用|失败|尚未|未覆盖|未验证|外推|仅限|受限)/.test(summary);
    const separatedUnverifiedBoundary = /(?:尚未|未曾|未能|未|没有)[^。！？!?\n]{0,60}(?:验证|覆盖|评估|测试)/.test(summary);
    const conditionalFailure = /(?:但|不过|然而)[^。！？!?\n]{0,80}(?:在|对)[^。！？!?\n]{1,60}(?:时|下|中|上)[^。！？!?\n]{0,60}(?:可能|易|会|明显)?(?:失真|退化|恶化|不稳定|不可靠|失效|下降|受损|偏差)/.test(summary);
    if (!explicitBoundary && !separatedUnverifiedBoundary && !conditionalFailure) {
        issues.push('缺少结论适用边界、失败条件或未验证范围');
    }
    const scopedResourceDisclosure = summary.split(/[。！？!?\n]/).some(sentence => (
        /(?:训练|推理|部署)/.test(sentence)
        && /\d/.test(sentence)
        && /(?:计算量|计算复杂度|MACs?|FLOPs?|GPU|CPU|TPU|NPU|RTX|显卡|(?:训练|推理|采样|优化|迭代)步数|\d\s*(?:[kKmMgG]\s*)?\s*(?:步|轮|次))/i.test(sentence)
    ));
    const cost = summary.includes(CORE_SUMMARY_COST_UNAVAILABLE)
        || /(?:成本|代价|开销|硬件|算力|显存|内存|延迟|吞吐|实时率|能耗)/.test(summary)
        || /(?:训练|推理|部署)[^。！？!?]{0,24}(?:需要|增加|额外|占用|耗时|更高|更低|受限|负担)/.test(summary)
        || scopedResourceDisclosure;
    if (!cost) issues.push(`缺少训练、推理或部署成本；未披露时必须写“${CORE_SUMMARY_COST_UNAVAILABLE}”`);
    return issues.length ? `核心摘要未达到 ${CORE_SUMMARY_CONTRACT_VERSION}: ${issues.join('；')}` : null;
}

function hashAnalysisWithMaskedCoreSummary(analysis) {
    const source = String(analysis || '');
    const matches = [...source.matchAll(/^##\s*核心摘要\s*\r?\n/gm)];
    if (matches.length !== 1) return '';
    const start = matches[0].index + matches[0][0].length;
    const next = /^##\s+/gm;
    next.lastIndex = start;
    const found = next.exec(source);
    const end = found ? found.index : source.length;
    return crypto.createHash('sha256')
        .update(`${source.slice(0, start)}<CORE_SUMMARY_BODY>${source.slice(end)}`)
        .digest('hex');
}

function hashTagSectionAndPrimaryTags(analysis) {
    const source = String(analysis || '');
    const tagSectionText = extractSection(source, '标签');
    const machineSummaryText = extractSection(source, '机器摘要');
    const primaryTaskTag = machineSummaryText.match(/^primary_task_tag\s*[:：]\s*(\S+)\s*$/m)?.[1] || '';
    const primaryMethodTag = machineSummaryText.match(/^primary_method_tag\s*[:：]\s*(\S+)\s*$/m)?.[1] || '';
    if (!tagSectionText || !primaryTaskTag || !primaryMethodTag) return '';
    return crypto.createHash('sha256')
        .update(`primary_task_tag=${primaryTaskTag}\nprimary_method_tag=${primaryMethodTag}\n${tagSectionText}`)
        .digest('hex');
}

function findAnalysisSectionBounds(analysis, title) {
    const match = new RegExp(
        `(^|\\n)((#{2,3})\\s*(?:\\d+[.\\s]+)?${escapeRegExp(title)}[：:\\s]*\\n)`,
        'm'
    ).exec(analysis);
    if (!match) return null;
    const start = match.index + match[1].length;
    const contentStart = start + match[2].length;
    const rest = analysis.slice(contentStart);
    const level = match[3].length;
    const next = new RegExp(`\\n#{2,${level}}\\s`).exec(rest);
    return { contentStart, end: next ? contentStart + next.index : analysis.length };
}

function maskClassificationFields(analysis) {
    let source = String(analysis || '');
    const machineSummaryBounds = findAnalysisSectionBounds(source, '机器摘要');
    if (!machineSummaryBounds) return '';
    let body = source.slice(machineSummaryBounds.contentStart, machineSummaryBounds.end);
    for (const [key, value] of [
        ['primary_task_tag', '__PRIMARY_TASK__'],
        ['primary_method_tag', '__PRIMARY_METHOD__']
    ]) {
        const pattern = new RegExp(`^${key}\\s*[:：]\\s*.*$`, 'gm');
        if ((body.match(pattern) || []).length !== 1) return '';
        body = body.replace(pattern, `${key}: ${value}`);
    }
    source = `${source.slice(0, machineSummaryBounds.contentStart)}${body}${source.slice(machineSummaryBounds.end)}`;
    const tagSectionBounds = findAnalysisSectionBounds(source, '标签');
    if (!tagSectionBounds) return '';
    return `${source.slice(0, tagSectionBounds.contentStart)}__TAXONOMY_SECTION__${source.slice(tagSectionBounds.end)}`;
}

function validateTagStageProof(paper, options = {}) {
    const manifest = paper?.analysisManifest;
    let tagRecord;
    try { tagRecord = readTagStageRecord(manifest, paper?.analysisStageCheckpoints); }
    catch (error) { return error.message; }
    const stage = tagRecord.stage;
    if (!isRecoveryStageTerminal(tagRecord.stageKey, stage?.status)) return '标签阶段记录缺失，或状态不是 complete 或 not_needed。';
    const tagRulesApi = require('./lib/tag-rules.js');
    const runtime = options.tagRules || tagRulesApi.getDefaultTagRules();
    if (manifest?.contracts?.[tagRecord.contractKey] !== (tagRecord.format === 'current'
        ? TAG_STAGE_RECORD_CONTRACT : stage.selectionContract)
        || (stage.registryVersion !== runtime.registryVersion
            && !(stage.registrySha256 !== runtime.registrySha256
                && stage.registryVersion === 'paper-taxonomy-v1'
                && runtime.registryVersion === 'paper-tag-catalog-v2'))
        || (stage.projectionContract !== tagRulesApi.TAG_PROMPT_TEXT_CONTRACT
            && stage.projectionContract !== tagRulesApi.LEGACY_TAG_PROMPT_TEXT_CONTRACT)
        || !tagRulesApi.isSupportedTagSelectionContract(stage.selectionContract)) {
        return '标签阶段记录中的词表版本、标签提示文本或标签选择规则与当前配置不一致。';
    }
    if (stage.registrySha256 !== runtime.registrySha256) {
        // v1 沿用原升级规则。v2 只读取一次旧词表，升级检查和提示重建使用
        // 同一个快照，避免动态读取器在一次核验中返回不同内容。
        let promptCatalog = null;
        let snapshotOptions = options.registrySnapshotOptions;
        if (stage.projectionContract === tagRulesApi.TAG_PROMPT_TEXT_CONTRACT) {
            let snapshot;
            try {
                snapshot = require('./lib/tag-catalog-change.js').resolveRegistrySnapshot(
                    stage.registrySha256, snapshotOptions
                );
            } catch {
                return '无法完成词表升级核验：无法读取标签提示所需的旧词表快照。';
            }
            if (!snapshot || (snapshot.registrySha256
                && snapshot.registrySha256 !== stage.registrySha256)) {
                return '标签提示所需的旧词表快照缺失，或其 SHA 与阶段记录不一致。';
            }
            promptCatalog = { ...snapshot, registrySha256: stage.registrySha256 };
            snapshotOptions = { registryHistory: new Map([[stage.registrySha256, snapshot]]) };
        }
        // 旧快照、升级说明、允许的变更及原概念有效性仍须全部通过原检查。
        const upgrade = require('./lib/tag-catalog-change.js').validateTagCatalogUpgrade({
            fromRegistrySha256: stage.registrySha256,
            currentRegistry: runtime.tagCatalog,
            currentRegistrySha256: runtime.registrySha256,
            conceptIds: stage.conceptIds,
            annotation: stage.registryUpgradeFrom,
            fromRegistryVersion: stage.registryVersion,
            snapshotOptions
        });
        if (!upgrade.ok) return upgrade.error;
        if (promptCatalog) {
            const promptSha256 = crypto.createHash('sha256').update(
                tagRulesApi.buildTagPromptText(promptCatalog, stage.projectionContract), 'utf8'
            ).digest('hex');
            if (stage.projectionSha256 !== promptSha256) {
                return '标签阶段的提示 SHA 与其版本和旧词表生成的提示文本不一致。';
            }
        }
    } else {
        const promptSha256 = crypto.createHash('sha256').update(
            tagRulesApi.buildTagPromptText(runtime.tagCatalog, stage.projectionContract), 'utf8'
        ).digest('hex');
        if (stage.projectionSha256 !== promptSha256) {
            return '标签阶段记录中的词表版本、标签提示文本或标签选择规则与当前配置不一致。';
        }
    }
    const parsed = options.parsed;
    let validation;
    try { validation = require('./utils.js').readTagValidation(parsed); }
    catch (error) { return error.message; }
    if (!validation?.valid
        || stage.primaryTaskId !== validation.primaryTaskId
        || stage.primaryMethodId !== validation.primaryMethodId
        || manualSha256(stage.conceptIds) !== manualSha256(validation.conceptIds)) {
        return '正文标签未通过校验，或其主任务、主方法及概念 ID 与标签阶段记录不一致。';
    }
    const structure = manifest.stages?.structureRepair;
    if (!/^[a-f0-9]{64}$/.test(String(stage.inputAnalysisSha256 || ''))
        || !/^[a-f0-9]{64}$/.test(String(stage.outputAnalysisSha256 || ''))
        || !/^[a-f0-9]{64}$/.test(String(stage.inputProtectedProjectionSha256 || ''))
        || structure?.outputAnalysisSha256 !== stage.inputAnalysisSha256
        || stage.inputProtectedProjectionSha256 !== stage.outputProtectedProjectionSha256
        || stage[tagRecord.hashKey] !== hashTagSectionAndPrimaryTags(paper.analysis)
        || manifest.stages?.coreSummaryRepair?.inputAnalysisSha256 !== stage.outputAnalysisSha256) {
        return '标签阶段的输入、输出、标签内容或受保护正文哈希不匹配，或与前后阶段的记录不一致。';
    }
    if (stage.status === 'not_needed' && stage.inputAnalysisSha256 !== stage.outputAnalysisSha256) {
        return '标签阶段标为 not_needed 时，记录中的输入与输出正文哈希必须相同。';
    }
    const checkpoints = paper?.analysisStageCheckpoints;
    const tagCheckpointText = tagRecord.checkpoint;
    const maskedAnalysisText = typeof tagCheckpointText === 'string'
        ? maskClassificationFields(tagCheckpointText) : '';
    if (typeof tagCheckpointText !== 'string' || !maskedAnalysisText
        || crypto.createHash('sha256').update(tagCheckpointText).digest('hex') !== stage.outputAnalysisSha256
        || crypto.createHash('sha256').update(maskedAnalysisText).digest('hex')
            !== stage.outputProtectedProjectionSha256
        || hashTagSectionAndPrimaryTags(tagCheckpointText) !== stage[tagRecord.hashKey]) {
        return '标签阶段的正文检查点缺失，或正文、受保护内容和标签的哈希与阶段记录不符。';
    }
    if (stage.status === 'complete') {
        const structureCheckpoint = checkpoints?.structureRepair;
        const maskedInputAnalysisText = typeof structureCheckpoint === 'string'
            ? maskClassificationFields(structureCheckpoint) : '';
        if (typeof structureCheckpoint !== 'string' || !maskedInputAnalysisText
            || crypto.createHash('sha256').update(structureCheckpoint).digest('hex') !== stage.inputAnalysisSha256
            || crypto.createHash('sha256').update(maskedInputAnalysisText).digest('hex')
                !== stage.inputProtectedProjectionSha256
        ) {
            return '标签阶段标为 complete 时，必须保留与其输入正文及受保护正文哈希一致的结构修复检查点。';
        }
    }
    const binding = Object.fromEntries(tagRecord.bindingFields.map(field => [field, stage[field]]));
    if (stage.bindingSha256 !== manualSha256(binding)) return '标签阶段的 bindingSha256 与重新计算的阶段记录哈希不一致。';
    return null;
}

function validateCoreSummaryStageBinding(paper, options = {}) {
    const manifest = paper?.analysisManifest;
    const stage = manifest?.stages?.coreSummaryRepair;
    if (stage?.status === MANUAL_COMPLETE_STATUS) return null;
    const summary = extractSection(String(paper?.analysis || ''), '核心摘要');
    const summarySha256 = crypto.createHash('sha256').update(String(summary || '')).digest('hex');
    if (!isRecoveryStageTerminal('coreSummaryRepair', stage?.status)) return '核心摘要阶段记录缺失，或状态不是 complete 或 not_needed。';
    if (manifest?.contracts?.coreSummary !== CORE_SUMMARY_CONTRACT_VERSION
        || stage.contractVersion !== CORE_SUMMARY_CONTRACT_VERSION) return '核心摘要阶段记录未采用当前 v3 规则。';
    if (!/^[a-f0-9]{64}$/.test(String(stage.fingerprint || ''))) return '核心摘要阶段的输入指纹缺失，或格式无效。';
    if (!/^[a-f0-9]{64}$/.test(String(stage.outputAnalysisSha256 || ''))) return '核心摘要阶段的输出正文哈希缺失，或格式无效。';
    if (options.skipSemantic !== true) {
        const semanticIssue = validateCoreSummarySemanticContract(paper?.analysis, options);
        if (semanticIssue) return semanticIssue;
    }
    if (stage.summarySha256 !== summarySha256) return '核心摘要正文的哈希与阶段记录不一致。';
    const structure = manifest?.stages?.structureRepair;
    let tagRecord;
    try { tagRecord = readTagStageRecord(manifest, paper?.analysisStageCheckpoints); }
    catch (error) { return error.message; }
    const tagStage = tagRecord.stage;
    const scoring = manifest?.stages?.scoringAudit;
    const requiredShaFields = [
        'inputAnalysisSha256', 'inputSummarySha256',
        'inputStructureProjectionSha256', 'outputStructureProjectionSha256', 'bindingSha256'
    ];
    if (requiredShaFields.some(field => !/^[a-f0-9]{64}$/.test(String(stage[field] || '')))) {
        return '核心摘要阶段的输入正文、输入摘要、受保护正文或阶段记录哈希缺失，或格式无效。';
    }
    const tagOutputAnalysisSha256 = String(tagStage?.outputAnalysisSha256 || '');
    const hasTagStageOutput = isRecoveryStageTerminal(tagRecord.stageKey, tagStage?.status)
        && /^[a-f0-9]{64}$/.test(tagOutputAnalysisSha256);
    if (tagRecord.format === 'current' && !hasTagStageOutput) {
        return '核心摘要的上游标签阶段记录缺失、尚未完成，或输出正文哈希无效。';
    }
    const upstreamStage = hasTagStageOutput ? tagStage : structure;
    const upstreamLabel = hasTagStageOutput ? tagRecord.checkpointKey : 'structureRepair';
    if (upstreamStage?.outputAnalysisSha256 !== stage.inputAnalysisSha256) {
        return `核心摘要的输入正文哈希与上一阶段 ${upstreamLabel} 的输出记录不一致。`;
    }
    if (stage.inputStructureProjectionSha256 !== stage.outputStructureProjectionSha256) {
        return '核心摘要阶段记录中的输入与输出受保护正文哈希不一致。';
    }
    const upstreamCheckpoint = paper?.analysisStageCheckpoints?.[upstreamLabel];
    if (typeof upstreamCheckpoint !== 'string') {
        return `核心摘要阶段缺少上一阶段 ${upstreamLabel} 的正文检查点。`;
    }
    const checkpointSummarySha256 = crypto.createHash('sha256')
        .update(extractSection(upstreamCheckpoint, '核心摘要')).digest('hex');
    if (crypto.createHash('sha256').update(upstreamCheckpoint).digest('hex')
            !== stage.inputAnalysisSha256
        || checkpointSummarySha256 !== stage.inputSummarySha256
        || hashAnalysisWithMaskedCoreSummary(upstreamCheckpoint)
            !== stage.inputStructureProjectionSha256) {
        return `核心摘要阶段的输入正文、摘要或受保护正文哈希与上一阶段 ${upstreamLabel} 的正文检查点不一致。`;
    }
    const summaryCheckpoint = paper?.analysisStageCheckpoints?.coreSummaryRepair;
    if (typeof summaryCheckpoint === 'string'
        && (crypto.createHash('sha256').update(summaryCheckpoint).digest('hex')
                !== stage.outputAnalysisSha256
            || crypto.createHash('sha256')
                .update(extractSection(summaryCheckpoint, '核心摘要')).digest('hex')
                !== stage.summarySha256
            || hashAnalysisWithMaskedCoreSummary(summaryCheckpoint)
                !== stage.outputStructureProjectionSha256)) {
        return '核心摘要阶段的输出正文、摘要或受保护正文哈希与本阶段的正文检查点不一致。';
    }
    const bindingBody = {
        contractVersion: stage.contractVersion,
        inputAnalysisSha256: stage.inputAnalysisSha256,
        outputAnalysisSha256: stage.outputAnalysisSha256,
        inputSummarySha256: stage.inputSummarySha256,
        summarySha256: stage.summarySha256,
        inputStructureProjectionSha256: stage.inputStructureProjectionSha256,
        outputStructureProjectionSha256: stage.outputStructureProjectionSha256
    };
    if (stage.bindingSha256 !== manualSha256(bindingBody)) return '核心摘要阶段的绑定哈希与重新计算的阶段记录哈希不一致。';
    if (scoring?.status !== MANUAL_COMPLETE_STATUS) {
        if (scoring?.coreSummaryInputAnalysisSha256 !== stage.outputAnalysisSha256
            || scoring?.inputCoreSummarySha256 !== stage.summarySha256
            || scoring?.outputCoreSummarySha256 !== stage.summarySha256) {
            return '评分阶段记录的输入正文、输入摘要或输出摘要哈希与核心摘要阶段的输出不一致。';
        }
    }
    return null;
}

function manualStableValue(value) {
    if (Array.isArray(value)) return value.map(manualStableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, manualStableValue(value[key])]));
}

// Python 的 _manual_hash 用 _manual_js_number_text 写数字，两边必须是同一套规则：
// ECMAScript 规定的最短十进制（0.00002 不用指数，1e-7 与 1e21 用指数，1.0 写 1）。
// 这里把数字文本单独列出来，两端共用一组向量，避免再退回 Python json.dumps 的
// 2e-05 / 1e+17 / 1.0 写法。JSON.stringify 的数字输出就是这条规则。
function manualNumberText(value) {
    if (!Number.isFinite(value)) return 'null';
    return JSON.stringify(value);
}

function manualCanonicalJson(value) {
    if (typeof value === 'number') return manualNumberText(value);
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(item => (
            item === undefined || typeof item === 'function' ? 'null' : manualCanonicalJson(item)
        )).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort()
            .filter(key => value[key] !== undefined && typeof value[key] !== 'function')
            .map(key => `${JSON.stringify(key)}:${manualCanonicalJson(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

function manualSha256(value) {
    assertManualHashKeyPremises(value, 'manual 哈希输入');
    return crypto.createHash('sha256')
        .update(manualCanonicalJson(manualStableValue(value)))
        .digest('hex');
}

// manualSha256 与 Python 的 _manual_hash 必须对同一个对象写出同一串字节。Node 按
// UTF-16 码元排序键，Python 按码点排序；键里出现 emoji 这类增补平面字符时两端顺序
// 不同，哈希也就不同。键由 JSON 载入时一定是字符串，直接调用则不一定，所以在这里挡住。
function assertManualHashKeyPremises(value, label) {
    if (Array.isArray(value)) {
        value.forEach((item, index) => assertManualHashKeyPremises(item, `${label}[${index}]`));
        return;
    }
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
        if ([...key].some(character => character.codePointAt(0) > 0xFFFF)) {
            throw new Error(`${label}.${key} 的对象键含 BMP 以外的字符；`
                + 'Node 按 UTF-16 码元排序、Python 按码点排序，两端顺序会不同');
        }
        assertManualHashKeyPremises(value[key], `${label}.${key}`);
    }
}

// 文本证据按原始 UTF-8 字节计算哈希（不做 JSON 字符串转义），
// 这样 Node 端和 Python 发布闸绑定到同一个值。
function manualTextSha256(value) {
    return crypto.createHash('sha256')
        .update(String(value ?? ''), 'utf8')
        .digest('hex');
}

function normalizeManualEvidenceText(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/\s+/g, '')
        .trim();
}

function findManualBoilerplate(analysis, options = {}) {
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 8;
    const matches = [];
    const seen = new Set();
    for (const line of String(analysis || '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || /^```/.test(trimmed) || /^\s*[>|]/.test(trimmed)) continue;
        for (const pattern of MANUAL_BOILERPLATE_PATTERNS) {
            if (!pattern.test(trimmed)) continue;
            const evidence = trimmed.slice(0, 220);
            if (!seen.has(evidence)) {
                seen.add(evidence);
                matches.push(evidence);
            }
            break;
        }
        if (matches.length >= limit) break;
    }
    return matches;
}

function validateManualEvidenceLedger(ledger, sourceText = '') {
    if (!Array.isArray(ledger) || ledger.length < 6) {
        return 'manual evidenceLedger 至少需要 6 条可回溯事实';
    }
    const seen = new Set();
    const sections = new Set();
    const normalizedSource = normalizeManualEvidenceText(sourceText);
    for (const [index, item] of ledger.entries()) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return `manual evidenceLedger 第 ${index + 1} 条不是对象`;
        }
        if (typeof item.id !== 'string' || !/^E\d{2,3}$/.test(item.id) || seen.has(item.id)) {
            return `manual evidenceLedger 第 ${index + 1} 条 id 非法或重复`;
        }
        seen.add(item.id);
        if (!REQUIRED_ANALYSIS_SECTIONS.includes(normalizeAnalysisSectionTitle(item.section))
            || ['评分', '标签', '作者与机构'].includes(item.section)) {
            return `manual evidenceLedger ${item.id} section 必须对应事实正文章节`;
        }
        sections.add(normalizeAnalysisSectionTitle(item.section));
        if (typeof item.claim !== 'string' || item.claim.trim().length < 20) {
            return `manual evidenceLedger ${item.id} claim 过短`;
        }
        if (typeof item.sourceQuote !== 'string' || item.sourceQuote.trim().length < 12) {
            return `manual evidenceLedger ${item.id} 缺少原文引用`;
        }
        if (normalizedSource) {
            const quote = normalizeManualEvidenceText(item.sourceQuote);
            if (!quote || !normalizedSource.includes(quote)) {
                return `manual evidenceLedger ${item.id} 的 sourceQuote 不存在于全文来源`;
            }
        }
    }
    const requiredSections = ['核心摘要', '方法概述和架构', '实验结果', '局限与问题', '开源详情'];
    const missingSections = requiredSections.filter(section => !sections.has(section));
    if (missingSections.length > 0) {
        return `manual evidenceLedger 缺少章节覆盖: ${missingSections.join('、')}`;
    }
    return null;
}

function validateFreshAuthoringRecordConsistency(manifest, takeover) {
    const marker = manifest?.contracts?.freshAuthoring;
    // 历史的 v5 正式记录早于 file-backed fresh-authoring 约定。这些记录在
    // 校验和迁移时继续可读，而 manual-deep-analysis 产出的每条新 v5 记录
    // 都带这个显式标记。
    if (marker === undefined) return null;
    if (marker !== FRESH_AUTHORING_CONTRACT) {
        return `Manual v5 的 freshAuthoring 格式标识不符合要求：${String(marker)}`;
    }
    if (!takeover?.freshAuthoring
        || takeover.freshAuthoring.contract !== FRESH_AUTHORING_CONTRACT
        || takeover.freshAuthoring.mode !== FRESH_AUTHORING_MODE
        || takeover.freshAuthoring.prohibitedProseInputs?.length !== 0
        || takeover.freshAuthoringSha256 !== manualSha256(takeover.freshAuthoring)) {
        return '独立成稿记录 freshAuthoring 缺失，格式、生成方式或输入限制不符合要求，或内容 SHA 不一致。';
    }
    return null;
}

function validateTutorialPayloadRecordConsistency(manifest, takeover) {
    const marker = manifest?.contracts?.tutorialPayload;
    // 没带标记的历史 v5 记录只能读。发布器另外会拒绝把它们打包成新的教程页。
    if (marker === undefined) return null;
    if (marker !== MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT) {
        return `Manual v5 的 tutorialPayload 格式标识不符合要求：${String(marker)}`;
    }
    const payload = takeover?.tutorialPayload;
    if (!payload || payload.contract !== MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT
        || payload.paperId !== manifest?.sourceAcquisition?.sourceId
        || payload.articleSha256 !== takeover?.freshAuthoring?.articleSha256
        || payload.freshAuthoringReceiptSha256 !== takeover?.freshAuthoring?.receiptSha256
        || takeover.tutorialPayloadSha256 !== manualSha256(payload)
        || payload.receiptSha256 !== manualSha256((({ receiptSha256: _sha, ...rest }) => rest)(payload))) {
        return '教程正文记录 tutorialPayload 缺失，格式或论文编号不符合要求，或正文、成稿凭证和记录内容的 SHA 不一致。';
    }
    return null;
}

function validateManualV2Takeover(manifest, takeover, sourceSha256 = '', options = {}) {
    let modelPolicy;
    try {
        modelPolicy = boundModelPolicy(manifest, options.expectedModelPolicy, '分析清单');
        boundModelPolicy(takeover, modelPolicy, '人工分析结果');
        if (modelPolicy === CURRENT_MODEL_POLICY) {
            assertAgentIdentity(takeover.readabilityRubric, modelPolicy, '可读性审查', { receipt: false });
        }
    } catch (error) { return error.message; }
    if (takeover.version !== MANUAL_COMPLETE_PROVENANCE_VERSION
        || takeover.mode !== MANUAL_COMPLETE_STATUS) {
        return '人工分析记录的 version 必须为 2，mode 必须为 manual_complete。';
    }
    if (typeof takeover.agent !== 'string' || !takeover.agent.trim()) {
        return 'manualTakeover.agent 缺失';
    }
    if (takeover.basis !== 'full_text') return 'manualTakeover.basis 必须为 full_text';
    if (!/^[a-f0-9]{64}$/.test(String(takeover.sourceSha256 || ''))) {
        return 'manualTakeover.sourceSha256 必须是 SHA-256';
    }
    if (sourceSha256 && takeover.sourceSha256 !== sourceSha256) {
        return 'manualTakeover.sourceSha256 与来源 SHA 不一致';
    }
    if (!/^[a-f0-9]{64}$/.test(String(takeover.promptSha256 || ''))) {
        return 'manualTakeover.promptSha256 必须是 SHA-256';
    }
    if ([MANUAL_DEPTH_CONTRACT_VERSION_V3, ...MANUAL_READER_QUALITY_VERSIONS]
        .includes(manifest?.contracts?.manualDepth)
        && !/^[a-f0-9]{64}$/.test(String(takeover.manualAuthoringPromptSha256 || ''))) {
        return 'manual v3/v4 必须绑定 manualAuthoringPromptSha256';
    }
    if (!/^[a-f0-9]{64}$/.test(String(takeover.analysisSha256 || ''))) {
        return 'manualTakeover.analysisSha256 必须是 SHA-256';
    }
    if (options.analysis !== undefined && takeover.analysisSha256 !== manualTextSha256(options.analysis)) {
        return 'manualTakeover.analysisSha256 与正文不一致';
    }
    if (typeof takeover.completedAt !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?\+08:00$/.test(takeover.completedAt)) {
        return 'manualTakeover.completedAt 必须是北京时间 ISO 时间';
    }
    if (typeof takeover.reason !== 'string' || takeover.reason.trim().length < 20) {
        return 'manualTakeover.reason 过短';
    }
    const review = takeover.review;
    if (!review || typeof review !== 'object'
        || review.sourceVerified !== true || review.analysisContractVerified !== true
        || review.scoringVerified !== true || review.stageEvidenceVerified !== true) {
        return 'manualTakeover.review 必须确认来源、正文、评分和阶段证据';
    }
    if (MANUAL_READER_QUALITY_VERSIONS.includes(manifest?.contracts?.manualDepth)
        && review.readerQualityVerified !== true) {
        return 'manual v4 manualTakeover.review 必须确认 readerQualityVerified';
    }

    const audit = takeover.audit;
    if (!audit || typeof audit !== 'object' || audit.version !== 1) {
        return 'manualTakeover.audit 必须为 v1 对象';
    }
    if (!Number.isInteger(audit.attempts) || audit.attempts < 2) {
        return 'manualTakeover.audit.attempts 至少为 2，必须存在复核/修订轮次';
    }
    if (!Array.isArray(audit.passes) || audit.passes.length < 2) {
        return 'manualTakeover.audit.passes 至少需要初审和终审两轮';
    }
    const finalPass = audit.passes[audit.passes.length - 1];
    if (!finalPass || finalPass.status !== 'pass'
        || !Array.isArray(finalPass.issues) || finalPass.issues.length !== 0) {
        return 'manualTakeover.audit 最后一轮必须为无问题 pass';
    }
    const checks = audit.checks;
    if (!checks || typeof checks !== 'object'
        || new Set(Object.keys(checks)).size !== MANUAL_AUDIT_CHECKS.length
        || MANUAL_AUDIT_CHECKS.some(key => checks[key] !== true)) {
        return 'manualTakeover.audit.checks 必须完整且全部为 true';
    }
    const boilerplate = findManualBoilerplate(options.analysis || takeover.analysis || '');
    if (boilerplate.length > 0) {
        return `manual 分析含通用提示词残留: ${boilerplate.join('；')}`;
    }
    const ledgerIssue = validateManualEvidenceLedger(takeover.evidenceLedger, options.sourceText || '');
    if (ledgerIssue) return ledgerIssue;
    if (!/^[a-f0-9]{64}$/.test(String(takeover.evidenceLedgerSha256 || ''))
        || takeover.evidenceLedgerSha256 !== manualSha256(takeover.evidenceLedger)) {
        return 'manualTakeover.evidenceLedgerSha256 不匹配';
    }
    if (MANUAL_READER_QUALITY_VERSIONS.includes(manifest?.contracts?.manualDepth)) {
        const resultClaims = validateResultClaims(takeover.resultClaims, options.sourceText || '', {
            documentType: takeover.documentType,
            exception: takeover.resultClaimsException,
            // 内存中的状态或复用检查可以不传全文，此时不检查引文是否来自全文；
            // 结果主张的结构和数字仍须核验，后面还会单独核对 resultClaimsSha256。
            // validate:data 校验 Manual v4/v5 持久记录时，会从同批 manual-full-text 清单
            // 定位全文并核对文件 SHA，再把文本传到这里。Manual 录入流程则使用刚读取
            // 并计算过 SHA 的全文，声明了 sourceSha256 时还会核对它。这里的
            // Boolean(options.sourceText) 只控制引文与全文的比较，不认证来源 SHA。
            requireSourceBinding: Boolean(options.sourceText),
            readerResultsText: options.analysis === undefined
                ? undefined
                : extractSection(options.analysis, '实验结果')
        });
        if (!resultClaims.valid) {
            return `结果声明 resultClaims 未通过核验：${resultClaims.errors.join('；')}`;
        }
        if (!/^[a-f0-9]{64}$/.test(String(takeover.resultClaimsSha256 || ''))
            || takeover.resultClaimsSha256 !== manualSha256({
                claims: takeover.resultClaims,
                exception: takeover.resultClaimsException || null
            })) {
            return '结果声明的 resultClaimsSha256 格式无效，或与声明及例外记录重算的 SHA 不一致。';
        }
        const readability = validateReadabilityRubric(takeover.readabilityRubric);
        if (!readability.valid || !readability.passing) {
            return `可读性检查 readabilityRubric 未通过：${readability.errors.join('；') || `total=${readability.total}`}`;
        }
        if (!/^[a-f0-9]{64}$/.test(String(takeover.readabilityRubricSha256 || ''))
            || takeover.readabilityRubricSha256 !== manualSha256(takeover.readabilityRubric)) {
            return '可读性检查的 readabilityRubricSha256 格式无效，或与检查记录重算的 SHA 不一致。';
        }
    }
    if (manifest?.contracts?.manualDepth === MANUAL_DEPTH_CONTRACT_VERSION_V5) {
        if (manifest?.contracts?.researcherFocus !== MANUAL_RESEARCH_CONTRACT_VERSION) {
            return `manual v5 必须绑定 researcherFocus=${MANUAL_RESEARCH_CONTRACT_VERSION}`;
        }
        const freshAuthoringIssue = validateFreshAuthoringRecordConsistency(manifest, takeover);
        if (freshAuthoringIssue) return freshAuthoringIssue;
        const tutorialPayloadIssue = validateTutorialPayloadRecordConsistency(manifest, takeover);
        if (tutorialPayloadIssue) return tutorialPayloadIssue;
        try {
            validateResearchBrief(takeover.researchBrief, {
                expectedModelPolicy: modelPolicy,
                paperId: manifest?.sourceAcquisition?.sourceId,
                documentType: takeover.documentType,
                sourceText: options.sourceText || '',
                analysis: options.analysis || '',
                requireBindings: Boolean(options.sourceText && options.analysis)
            });
            validateStageReviews(takeover.stageReviews, {
                stages: REQUIRED_RECOVERY_STAGES,
                sourceText: options.sourceText || '',
                evidenceLedger: takeover.evidenceLedger,
                requireSourceBinding: Boolean(options.sourceText),
                label: 'manualTakeover.stageReviews'
            });
            validateScoringCalibration(takeover.scoringCalibration, {
                expectedModelPolicy: modelPolicy,
                evidenceLedger: takeover.evidenceLedger,
                paperSubagentTask: takeover.researchBrief?.paperSubagent?.taskName,
                label: 'manualTakeover.scoringCalibration'
            });
            validateResultClaimCoverageV5(takeover.resultClaims, {
                documentType: takeover.documentType,
                evidenceProfile: takeover.researchBrief?.evidenceProfile || {},
                label: 'manualTakeover.resultClaims'
            });
            if (takeover.readabilityRubric?.reviewerTaskName
                === takeover.researchBrief?.paperSubagent?.taskName) {
                throw new Error('readability reviewer 必须独立于 paper author subagent');
            }
            const imageCandidates = options.imageManifest?.candidates || [];
            const selectedImageUrls = (options.imageManifest?.selected || [])
                .map(item => typeof item === 'string' ? item : item?.url)
                .filter(Boolean);
            validateFigureReview(takeover.figureReview, {
                imageInfos: imageCandidates,
                selectedImageUrls,
                selectedOrderFlexible: true,
                paperId: manifest?.sourceAcquisition?.sourceId
            });
            if (takeover.researchBrief?.editorialPlan?.version === 2) {
                validateManualTutorialReaderBundle(takeover.researchBrief.editorialPlan, takeover.readerArticle, takeover.evidenceLedger, {
                    expectedModelPolicy: modelPolicy,
                    label: 'manualTakeover.readerArticle', sourceText: options.sourceText || '',
                    boundEvidence: [
                        ...(takeover.resultClaims || []).map(claim => claim.sourceQuote),
                        ...(takeover.evidenceLedger || []).map(item => item.sourceQuote)
                    ],
                    derivedFacts: takeover.researchBrief?.derivedFacts || [],
                    readerNarratives: (takeover.resultClaims || []).map(claim => claim.readerNarrative),
                    imageInsertions: options.imageManifest?.insertionPlan || [],
                    ...(options.readerLongform && options.artifactIndex ? {
                        longformBundle: options.readerLongform,
                        artifactIndex: options.artifactIndex,
                        paperId: manifest?.sourceAcquisition?.sourceId,
                        runtimeMode: options.runtimeMode
                    } : {})
                });
                if (!/^[a-f0-9]{64}$/.test(String(takeover.readerArticleSha256 || ''))
                    || takeover.readerArticleSha256 !== manualTextSha256(takeover.readerArticle)) {
                    return 'manualTakeover.readerArticleSha256 不匹配';
                }
                validateEditorialReview(takeover.editorialReview, takeover.readerArticle, {
                    label: 'manualTakeover.editorialReview'
                });
                if (!/^[a-f0-9]{64}$/.test(String(takeover.editorialReviewSha256 || ''))
                    || takeover.editorialReviewSha256 !== manualTextSha256(takeover.editorialReview)) {
                    return 'manualTakeover.editorialReviewSha256 不匹配';
                }
                if (options.analysis
                    && extractSection(options.analysis, PAPER_EVALUATION_TITLE).trim() !== takeover.editorialReview.trim()) {
                    return 'manualTakeover.editorialReview 与分析正文中的论文评价不逐字一致。';
                }
            }
        } catch (error) {
            return `manual v5 研究者契约失败: ${error.message}`;
        }
        for (const [field, value] of Object.entries({
            researchBriefSha256: takeover.researchBrief,
            stageReviewsSha256: takeover.stageReviews,
            scoringCalibrationSha256: takeover.scoringCalibration,
            openSourceEvidenceSha256: takeover.openSourceEvidence,
            figureReviewSha256: takeover.figureReview,
            externalResourceVerificationSha256: takeover.externalResourceVerification
        })) {
            if (!/^[a-f0-9]{64}$/.test(String(takeover[field] || ''))
                || takeover[field] !== manualSha256(value)) {
                return `manualTakeover.${field} 不匹配`;
            }
        }
        const verification = takeover.externalResourceVerification;
        const declaredUrls = takeover.openSourceEvidence?.urls || [];
        const outcomesValid = Array.isArray(verification?.outcomes)
            && verification.outcomes.every(item => item
                && item.status === 'reachable_public_https'
                && item.httpStatus === 200
                && /^https:\/\//.test(String(item.finalUrl || ''))
                && !Number.isNaN(Date.parse(String(item.verifiedAt || '')))
                && Array.isArray(item.discoveredLinks)
                && item.discoveredLinks.every(url => /^https:\/\//.test(String(url))));
        if (!verification || verification.version !== 1
            || verification.state !== takeover.openSourceEvidence?.state
            || !Array.isArray(verification.outcomes)
            || !outcomesValid
            || verification.outcomes.map(item => item?.url).join('\n') !== declaredUrls.join('\n')) {
            return 'manualTakeover.externalResourceVerification 未逐 URL 绑定 openSourceEvidence';
        }
    }

    const stages = manifest?.stages || {};
    const evidence = takeover.stageEvidence;
    if (!evidence || typeof evidence !== 'object') return 'manualTakeover.stageEvidence 缺失';
    const auditSha256 = manualSha256(audit);
    const hardenedFields = ['protocol', 'promptSource', 'promptSha256', 'contextSha256'];
    const hasHardenedBindings = MANUAL_STAGE_EVIDENCE_STAGES.some(stage => {
        const item = evidence[stage] || {};
        const state = stages[stage] || {};
        return hardenedFields.some(key => Object.prototype.hasOwnProperty.call(item, key)
            || Object.prototype.hasOwnProperty.call(state, key));
    });
    const completedDate = String(takeover.completedAt || '').slice(0, 10);
    if (!hasHardenedBindings && completedDate >= MANUAL_V2_HARDENED_CUTOFF_DATE) {
        return `manualTakeover.stageEvidence 缺少 ${MANUAL_V2_HARDENED_CUTOFF_DATE} 起必需的逐阶段 prompt/context 绑定`;
    }
    const imageManifest = options.imageManifest || manifest?.imageManifest;
    const imageContextFields = {
        imageDownload: 'downloadEvidenceSha256',
        imageSupplement: 'selectionEvidenceSha256'
    };
    if (hasHardenedBindings && imageManifest !== undefined) {
        const normalizeImageEvidence = info => ({
            url: info?.url,
            caption: info?.caption || '',
            source: info?.source || null,
            sourceOrder: info?.sourceOrder ?? null,
            candidateScore: info?.candidateScore ?? null,
            mime: info?.mime,
            sha256: info?.sha256,
            bytes: info?.bytes,
            ...(manifest?.contracts?.manualDepth === MANUAL_DEPTH_CONTRACT_VERSION_V5 ? {
                reviewDecision: info?.reviewDecision || null,
                reviewReason: info?.reviewReason || null,
                figureNumber: info?.figureNumber || null,
                visibleFacts: info?.visibleFacts || [],
                renderPlan: info?.renderPlan || null
            } : {})
        });
        if (!imageManifest || !Array.isArray(imageManifest.candidates)
            || !Array.isArray(imageManifest.downloadOutcomes) || !Array.isArray(imageManifest.selected)) {
            return 'manual imageManifest 缺少可重算的 candidates/downloadOutcomes/selected';
        }
        const expectedDownloadContext = manualSha256({
            candidates: imageManifest.candidates.map(normalizeImageEvidence),
            outcomes: imageManifest.downloadOutcomes
        });
        if (imageManifest.downloadEvidenceSha256 !== expectedDownloadContext) {
            return '图片下载记录的 downloadEvidenceSha256 与候选图片及下载结果重新计算的 SHA 不一致。';
        }
        const normalizedSelected = imageManifest.selected.map(normalizeImageEvidence);
        const expectedSelectionContext = imageManifest.version >= 2
            ? manualSha256({
                selected: normalizedSelected,
                insertionPlan: imageManifest.insertionPlan || [],
                insertionDiagnostics: imageManifest.insertionDiagnostics || []
            })
            : manualSha256(normalizedSelected);
        if (imageManifest.selectionEvidenceSha256 !== expectedSelectionContext) {
            return '选图记录的 selectionEvidenceSha256 与按当前清单版本从选中图片及相关字段重新计算的 SHA 不一致。';
        }
    }
    for (const stage of MANUAL_STAGE_EVIDENCE_STAGES) {
        const item = evidence[stage];
        const state = stages[stage];
        if (!item || typeof item !== 'object' || !state || item.status !== state.status) {
            return `manualTakeover.stageEvidence.${stage} 与阶段状态不一致`;
        }
        if ([MANUAL_DEPTH_CONTRACT_VERSION_V3, ...MANUAL_READER_QUALITY_VERSIONS]
            .includes(manifest?.contracts?.manualDepth)
            && (item.executionKind !== MANUAL_STAGE_EXECUTION_KIND
                || state.executionKind !== MANUAL_STAGE_EXECUTION_KIND)) {
            return `manualTakeover.stageEvidence.${stage}.executionKind 必须明确为 ${MANUAL_STAGE_EXECUTION_KIND}，不得把人工核验伪装成 LLM 阶段执行`;
        }
        if (!Number.isInteger(item.attempts) || item.attempts < 2) {
            return `manualTakeover.stageEvidence.${stage}.attempts 至少为 2`;
        }
        for (const key of ['inputSha256', 'outputSha256', 'auditSha256']) {
            if (!/^[a-f0-9]{64}$/.test(String(item[key] || ''))) {
                return `manualTakeover.stageEvidence.${stage}.${key} 必须是 SHA-256`;
            }
        }
        if (item.outputSha256 !== takeover.analysisSha256) {
            return `manualTakeover.stageEvidence.${stage}.outputSha256 与最终正文 SHA 不一致`;
        }
        if (!Array.isArray(item.reviewedClaims) || item.reviewedClaims.length === 0) {
            return `manualTakeover.stageEvidence.${stage}.reviewedClaims 不能为空`;
        }
        const hint = MANUAL_STAGE_CLAIM_HINTS[stage];
        if (manifest?.contracts?.manualDepth !== MANUAL_DEPTH_CONTRACT_VERSION_V5
            && hint && !item.reviewedClaims.some(claim => hint.test(String(claim)))) {
            return `manualTakeover.stageEvidence.${stage}.reviewedClaims 缺少该阶段专属事实范围`;
        }
        let expectedInputSha256;
        if (hasHardenedBindings) {
            if (item.protocol !== MANUAL_PROVENANCE_PROTOCOL || state.protocol !== MANUAL_PROVENANCE_PROTOCOL) {
                return `manualTakeover.stageEvidence.${stage}.protocol 与阶段协议不一致`;
            }
            if (typeof item.promptSource !== 'string' || !item.promptSource.trim()
                || item.promptSource !== state.promptSource) {
                return `manualTakeover.stageEvidence.${stage}.promptSource 与阶段 manifest 不一致`;
            }
            if (!/^[a-f0-9]{64}$/.test(String(item.promptSha256 || ''))
                || item.promptSha256 !== state.promptSha256) {
                return `manualTakeover.stageEvidence.${stage}.promptSha256 与阶段 manifest 不一致`;
            }
            if (stage === 'primaryAnalysis' && item.promptSha256 !== takeover.promptSha256) {
                return 'manualTakeover.promptSha256 与 primaryAnalysis 阶段不一致';
            }
            const contextField = imageContextFields[stage];
            if (contextField) {
                if (!/^[a-f0-9]{64}$/.test(String(item.contextSha256 || ''))) {
                    return `manualTakeover.stageEvidence.${stage}.contextSha256 缺失或非法`;
                }
                if (imageManifest !== undefined) {
                    if (!imageManifest || item.contextSha256 !== imageManifest[contextField]) {
                        return `manualTakeover.stageEvidence.${stage}.contextSha256 与 imageManifest.${contextField} 不一致`;
                    }
                }
            } else if (item.contextSha256 !== undefined) {
                return `manualTakeover.stageEvidence.${stage}.contextSha256 不应存在`;
            }
            expectedInputSha256 = manualSha256({
                stage,
                ...([MANUAL_DEPTH_CONTRACT_VERSION_V3, ...MANUAL_READER_QUALITY_VERSIONS]
                    .includes(manifest?.contracts?.manualDepth)
                    ? { executionKind: item.executionKind || null }
                    : {}),
                sourceSha256: takeover.sourceSha256,
                analysisSha256: takeover.analysisSha256,
                claims: item.reviewedClaims,
                stagePromptSha256: item.promptSha256,
                stageContextSha256: item.contextSha256 || null
            });
        } else {
            expectedInputSha256 = manualSha256({
                stage,
                sourceSha256: takeover.sourceSha256,
                analysisSha256: takeover.analysisSha256,
                claims: item.reviewedClaims
            });
        }
        if (item.inputSha256 !== expectedInputSha256) {
            return `阶段 ${stage} 的 inputSha256 与该阶段输入记录重新计算的 SHA 不一致。`;
        }
        const expectedAuditSha256 = manualSha256({
            stage,
            claims: item.reviewedClaims,
            auditSha256,
            stageInputSha256: item.inputSha256
        });
        if (item.auditSha256 !== expectedAuditSha256) {
            return `阶段 ${stage} 的 auditSha256 与阶段输入及审核记录重新计算的 SHA 不一致。`;
        }
    }
    return null;
}

function validateManualTakeoverManifest(manifest, sourceSha256 = '', options = {}) {
    // v6 正文沿用 v5 的离线阶段输入和质量规则，只调整本次核验视图，不改保存的记录。
    if (manifest?.contracts?.manualDepth === 'full-text-evidence-v6') {
        if (!manifest.manualTakeover || typeof manifest.manualTakeover !== 'object'
            || Array.isArray(manifest.manualTakeover)) {
            return 'v6 人工分析结果缺少有效的 manualTakeover 记录';
        }
        try {
            const policy = boundModelPolicy(manifest, options.expectedModelPolicy, '分析清单');
            boundModelPolicy(manifest.manualTakeover, policy, '人工分析结果');
        } catch (error) { return error.message; }
        return validateManualTakeoverManifest({
            ...manifest,
            contracts: { ...manifest.contracts, manualDepth: MANUAL_DEPTH_CONTRACT_VERSION_V5 }
        }, sourceSha256, options);
    }
    const manualStatuses = Object.values(manifest?.stages || {})
        .some(stage => stage?.status === MANUAL_COMPLETE_STATUS);
    if (!manualStatuses && manifest?.manualTakeover === undefined) return null;
    const evaluationIssue = getPaperEvaluationHeadingIssue(options.analysis || manifest?.manualTakeover?.analysis || '');
    if (evaluationIssue) return evaluationIssue;
    if (MANUAL_READER_QUALITY_VERSIONS.includes(manifest?.contracts?.manualDepth)
        && manifest?.contracts?.experimentTables !== EXPERIMENT_TABLE_CONTRACT_VERSION) {
        return `manual v4 必须绑定 experimentTables=${EXPERIMENT_TABLE_CONTRACT_VERSION}`;
    }
    if (MANUAL_READER_QUALITY_VERSIONS.includes(manifest?.contracts?.manualDepth)
        && manifest?.contracts?.imageNarrative !== 'context-bound-v1') {
        return 'manual v4 必须绑定 imageNarrative=context-bound-v1';
    }
    if (MANUAL_READER_QUALITY_VERSIONS.includes(manifest?.contracts?.manualDepth)
        && manifest?.contracts?.editorialQuality !== EDITORIAL_QUALITY_CONTRACT_VERSION) {
        return `manual v4 必须绑定 editorialQuality=${EDITORIAL_QUALITY_CONTRACT_VERSION}`;
    }
    if (manifest?.contracts?.manualDepth === MANUAL_DEPTH_CONTRACT_VERSION_V5
        && manifest?.contracts?.researcherFocus !== MANUAL_RESEARCH_CONTRACT_VERSION) {
        return `manual v5 必须绑定 researcherFocus=${MANUAL_RESEARCH_CONTRACT_VERSION}`;
    }
    const takeover = manifest?.manualTakeover;
    if (!takeover || typeof takeover !== 'object' || Array.isArray(takeover)) {
        return '人工分析的 manualTakeover 记录缺失或格式无效。';
    }
    try {
        const policy = boundModelPolicy(manifest, options.expectedModelPolicy, '分析清单');
        boundModelPolicy(takeover, policy, '人工分析结果');
        if (takeover.version === 1 && policy === CURRENT_MODEL_POLICY) {
            return '历史 v1 人工分析结果不能借用当前模型规则';
        }
    } catch (error) { return error.message; }
    if (takeover.version === MANUAL_COMPLETE_PROVENANCE_VERSION) {
        return validateManualV2Takeover(manifest, takeover, sourceSha256, options);
    }
    if (takeover.version !== 1 || takeover.mode !== MANUAL_COMPLETE_STATUS) return 'manualTakeover.version/mode 非法';
    if (typeof takeover.agent !== 'string' || !takeover.agent.trim()) {
        return 'manualTakeover.agent 缺失';
    }
    if (takeover.basis !== 'full_text') {
        return 'manualTakeover.basis 必须为 full_text';
    }
    if (!/^[a-f0-9]{64}$/.test(String(takeover.sourceSha256 || ''))) {
        return 'manualTakeover.sourceSha256 必须是 SHA-256';
    }
    if (sourceSha256 && takeover.sourceSha256 !== sourceSha256) {
        return 'manualTakeover.sourceSha256 与来源 SHA 不一致';
    }
    if (typeof takeover.completedAt !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?\+08:00$/.test(takeover.completedAt)) {
        return 'manualTakeover.completedAt 必须是北京时间 ISO 时间';
    }
    if (typeof takeover.reason !== 'string' || takeover.reason.trim().length < 20) {
        return 'manualTakeover.reason 过短';
    }
    const review = takeover.review;
    if (!review || typeof review !== 'object' || review.sourceVerified !== true
        || review.analysisContractVerified !== true || review.scoringVerified !== true
        || review.stageEvidenceVerified !== true) {
        return 'manualTakeover.review 必须确认来源、正文、评分和阶段证据';
    }
    return null;
}

function validateTopLevelSectionContract(analysis) {
    const headings = analysisSectionHeadings(analysis).map(heading => heading.section);
    const evaluationIssue = getPaperEvaluationHeadingIssue(analysis);
    if (evaluationIssue) return evaluationIssue;
    const extra = headings.filter(title => !REQUIRED_ANALYSIS_SECTIONS.includes(title));
    if (extra.length > 0) return `包含额外一级章节: ${[...new Set(extra)].join('、')}`;
    if (headings.length !== REQUIRED_ANALYSIS_SECTIONS.length) return '一级章节数量与固定契约不一致';
    const outOfOrder = headings.findIndex((title, index) => title !== REQUIRED_ANALYSIS_SECTIONS[index]);
    if (outOfOrder >= 0) {
        return `一级章节顺序非法: 第 ${outOfOrder + 1} 节应为 ${REQUIRED_ANALYSIS_SECTIONS[outOfOrder]}`;
    }
    return null;
}

function validateMachineSummaryContract(analysis, parsed, options = {}) {
    const block = extractSection(analysis, '机器摘要');
    if (!block) return '机器摘要为空';

    const occurrences = new Map(REQUIRED_MACHINE_SUMMARY_KEYS.map(key => [key, []]));
    const unknown = [];
    for (const rawLine of block.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        const match = line.match(/^([a-z_]+)\s*[:：]\s*(.*?)$/);
        if (!match) return `机器摘要行格式非法: ${line.slice(0, 60)}`;
        if (!occurrences.has(match[1])) {
            unknown.push(match[1]);
            continue;
        }
        occurrences.get(match[1]).push(match[2].trim());
    }

    if (unknown.length > 0) return `机器摘要包含额外键: ${[...new Set(unknown)].join('、')}`;
    const missing = REQUIRED_MACHINE_SUMMARY_KEYS.filter(key => occurrences.get(key).length === 0);
    if (missing.length > 0) return `机器摘要缺少键: ${missing.join('、')}`;
    const duplicate = REQUIRED_MACHINE_SUMMARY_KEYS.filter(key => occurrences.get(key).length > 1);
    if (duplicate.length > 0) return `机器摘要键重复: ${duplicate.join('、')}`;
    const empty = REQUIRED_MACHINE_SUMMARY_KEYS.filter(key => !occurrences.get(key)[0]);
    if (empty.length > 0) return `机器摘要键为空: ${empty.join('、')}`;

    for (const [key, maximum] of Object.entries(MACHINE_SCORE_MAXIMA)) {
        const rawValue = occurrences.get(key)[0];
        if (!/^\d+(?:\.\d)?$/.test(rawValue)) {
            return `机器摘要 ${key} 必须是最多一位小数的非负数`;
        }
        const value = Number(rawValue);
        if (value > maximum) return `机器摘要 ${key} 超出 0-${maximum}`;
        if (key === 'open_source' && !OPEN_SOURCE_SCORE_ANCHORS.includes(value)) {
            return '机器摘要 open_source 必须使用固定开源锚点';
        }
    }
    if (!DOCUMENT_TYPES.has(occurrences.get('document_type')[0])) return '机器摘要 document_type 非法';
    if (!['前10%', '前25%', '前50%', '后50%'].includes(occurrences.get('rank_bucket')[0])) return '机器摘要 rank_bucket 非法';
    if (!['高', '中', '低'].includes(occurrences.get('confidence')[0])) return '机器摘要 confidence 非法';
    for (const key of ['primary_task_tag', 'primary_method_tag']) {
        if (!/^#[^\s#]+$/.test(occurrences.get(key)[0])) return `机器摘要 ${key} 必须是单个 #标签`;
    }
    for (const key of ['sota_claim', 'has_code', 'has_model', 'has_dataset']) {
        if (!['是', '否', '未说明'].includes(occurrences.get(key)[0])) {
            return `机器摘要 ${key} 只允许 是/否/未说明`;
        }
    }
    const parsedFields = {
        innovation: 'innovationScore',
        technical_rigor: 'technicalRigorScore',
        experimental_sufficiency: 'experimentalSufficiencyScore',
        clarity: 'clarityScore',
        impact: 'impactScore',
        open_source: 'openSourceScore',
        reproducibility: 'reproducibilityScore',
        engineering_score: 'engineeringScore'
    };
    if (options.checkScoringConsistency !== false && parsed?.scoreValidation?.valid) {
        const displayedScore = String(analysis || '').match(/(^|\n)##(?!#)\s*评分[：:\s]*\n\s*(\d+(?:\.\d)?)\s*\/\s*10(?=\s|$)/)?.[2];
        if (displayedScore === undefined || Number(displayedScore) !== Number(parsed.score)) {
            return '评分章节总分与八维评分理由不一致';
        }
        if (occurrences.get('rank_bucket')[0] !== parsed.rankBucket) {
            return '机器摘要 rank_bucket 与最终总分不一致';
        }
        for (const [machineKey, parsedKey] of Object.entries(parsedFields)) {
            if (Number(occurrences.get(machineKey)[0]) !== Number(parsed[parsedKey])) {
                return `机器摘要 ${machineKey} 与评分理由不一致`;
            }
        }
    }
    return null;
}

function validateTagSectionContract(analysis, parsed, options = {}) {
    let validation;
    try { validation = require('./utils.js').readTagValidation(parsed); }
    catch (error) { return error.message; }
    const block = extractSection(analysis, '标签');
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.length !== 4) return '标签章节必须恰好四行';
    if (!/^(?:#[^\s,，;；、]+)(?:\s+#[^\s,，;；、]+){2,4}$/.test(lines[0])) {
        return '标签首行必须包含 3-5 个以空格分隔的 #标签';
    }
    if (!/^主任务标签\s*[:：]\s*#\S+$/.test(lines[1])) return '标签章节缺少合法主任务标签行';
    if (!/^主方法标签\s*[:：]\s*#\S+$/.test(lines[2])) return '标签章节缺少合法主方法标签行';
    if (!/^补充标签\s*[:：]\s*#\S+(?:\s+#\S+)*$/.test(lines[3])) return '标签章节缺少合法补充标签行';
    const allTags = lines[0].match(/#[^\s]+/g) || [];
    const taskTag = lines[1].match(/#[^\s]+/)?.[0];
    const methodTag = lines[2].match(/#[^\s]+/)?.[0];
    const supplemental = lines[3].match(/#[^\s]+/g) || [];
    if (!allTags.includes(taskTag) || !allTags.includes(methodTag)) return '主任务/主方法标签必须出现在标签首行';
    if (options.legacyTagSurface === true) {
        if (!Array.isArray(parsed?.tags) || allTags.length !== parsed.tags.length
            || new Set(parsed.tags).size !== parsed.tags.length) {
            return '旧标签首行包含未知、歧义或角色不匹配标签';
        }
    } else {
        if (!Array.isArray(parsed?.tags) || parsed.tags.length < 3 || parsed.tags.length > 5) {
            return '标签首行包含非白名单标签';
        }
        if (!parsed.primaryTaskTag) return '标签章节缺少可解析的主任务标签';
        if (!parsed.primaryMethodTag) return '标签章节缺少可解析的主方法标签';
        if (validation?.valid !== true) {
            return `标签不符合当前词表要求： ${validation?.errors?.[0] || '缺少验证结果'}`;
        }
        if (allTags.length !== parsed.tags.length
        || allTags.some((tag, index) => tag !== parsed.tags[index])) {
            return '标签首行必须与当前词表中仍有效的中文首选标签逐字一致';
        }
    }
    if (parsed.machineSummary?.primaryTaskTag !== taskTag
        || parsed.machineSummary?.primaryMethodTag !== methodTag) {
        return '机器摘要与标签章节的主任务/主方法标签不一致';
    }
    const expectedSupplemental = allTags.filter(tag => tag !== taskTag && tag !== methodTag);
    if (new Set(supplemental).size !== supplemental.length
        || supplemental.length !== expectedSupplemental.length
        || supplemental.some((tag, index) => tag !== expectedSupplemental[index])) {
        return '补充标签必须恰好列出首行中除主任务/主方法外的标签';
    }
    return null;
}

function hasRequiredSections(text) {
    return getMissingRequiredSections(text).length === 0;
}

function getInvalidAnalysisReason(analysis, parsed, options = {}) {
    const missingSections = getMissingRequiredSections(analysis);
    if (missingSections.length > 0) {
        return `分析结果缺少必要章节: ${missingSections.join('、')}`;
    }
    const duplicateSections = getDuplicateRequiredSections(analysis);
    if (duplicateSections.length > 0) {
        return `分析结果必要章节重复: ${duplicateSections.join('、')}`;
    }
    const topLevelIssue = validateTopLevelSectionContract(analysis);
    if (topLevelIssue) return `分析结果章节契约无效: ${topLevelIssue}`;
    const editorialLeakageIssue = validateAnalysisEditorialLeakageContract(analysis);
    if (editorialLeakageIssue) return `分析结果叙事契约无效: ${editorialLeakageIssue}`;
    if (!parsed) return '分析结果无法解析';
    const machineSummaryIssue = validateMachineSummaryContract(analysis, parsed);
    if (machineSummaryIssue) return `分析结果机器摘要契约无效: ${machineSummaryIssue}`;
    const tagIssue = validateTagSectionContract(analysis, parsed, options);
    if (tagIssue) return `分析结果标签契约无效: ${tagIssue}`;
    if (options.enforceExperimentTableContract === true) {
        const tableIssue = validateExperimentTableContract(analysis, {
            contractVersion: options.experimentTableContractVersion
                || EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION,
            documentType: parsed?.documentType,
            sourceText: options.sourceText
        });
        if (tableIssue) return `分析结果表格契约无效: ${tableIssue}`;
    }
    if (options.enforceMethodDetailContract === true) {
        const methodIssue = validateMethodDetailContract(analysis);
        if (methodIssue) return `分析结果方法契约无效: ${methodIssue}`;
    }
    if (options.enforceManualDepthContract === true) {
        const manualIssue = validateManualDepthContract(analysis, options);
        if (manualIssue) return `分析结果 manual 深度契约无效: ${manualIssue}`;
    }
    if (!parsed.documentType) return '分析结果缺少有效文档类型';
    if (!parsed.scoreValidation?.valid) {
        const details = Array.isArray(parsed.scoreValidation?.errors)
            ? parsed.scoreValidation.errors.slice(0, 3).join('；')
            : '八维评分不完整或格式非法';
        return `分析结果评分契约无效: ${details}`;
    }
    if (parsed.score === undefined || parsed.score === null || Number.isNaN(Number(parsed.score))) {
        return '分析结果缺少有效评分';
    }
    if (!parsed.scoringReason || parsed.scoringReason.trim().length < 80) return '分析结果缺少有效评分理由';
    if (!parsed.summary || parsed.summary.trim().length < 80) return '分析结果缺少有效核心摘要';
    if (!parsed.architecture || parsed.architecture.trim().length < 80) return '分析结果缺少有效方法概述';
    const resultMinimumChars = NON_EMPIRICAL_DOCUMENT_TYPES.has(parsed.documentType) ? 20 : 50;
    if (!parsed.results || parsed.results.trim().length < resultMinimumChars) {
        return NON_EMPIRICAL_DOCUMENT_TYPES.has(parsed.documentType)
            ? '分析结果缺少适用验证证据'
            : '分析结果缺少有效实验结果';
    }
    return null;
}

module.exports = {
    REQUIRED_ANALYSIS_SECTIONS,
    REQUIRED_MACHINE_SUMMARY_KEYS,
    getMissingRequiredSections,
    getDuplicateRequiredSections,
    extractSection,
    hasRequiredSections,
    validateMachineSummaryContract,
    validateTagSectionContract,
    validateTopLevelSectionContract,
    findAnalysisEditorialLeakages,
    validateAnalysisEditorialLeakageContract,
    EXPERIMENT_TABLE_CONTRACT_VERSION,
    EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION,
    EXPERIMENT_TABLE_CONTRACT_VERSIONS,
    METHOD_DETAIL_CONTRACT_VERSION,
    EDITORIAL_QUALITY_CONTRACT_VERSION,
    ANALYSIS_EDITORIAL_LEAKAGE_CONTRACT_VERSION,
    CORE_SUMMARY_CONTRACT_VERSION,
    CORE_SUMMARY_RESULT_UNAVAILABLE,
    REQUIRED_RECOVERY_STAGES,
    RECOVERY_STAGE_TERMINAL_STATUSES,
    MANUAL_COMPLETE_STATUS,
    MANUAL_COMPLETE_PROVENANCE_VERSION,
    MANUAL_STAGE_EXECUTION_KIND,
    MANUAL_AUDIT_CHECKS,
    EXPERIMENT_TABLE_LIMITS,
    splitMarkdownTableRow,
    extractMarkdownTables,
    repairMissingMarkdownTableSeparators,
    normalizeExperimentTableNumericFormatting,
    capExperimentTableMetricColumns,
    validateExperimentTableEvidenceDepth,
    validateExperimentTableContract,
    analysisManifestRequiresExperimentTableContract,
    validateMethodDetailContract,
    validateManualDepthContract,
    MANUAL_DEPTH_CONTRACT_VERSION,
    MANUAL_DEPTH_CONTRACT_VERSION_V2,
    MANUAL_DEPTH_CONTRACT_VERSION_V3,
    MANUAL_DEPTH_CONTRACT_VERSION_V4,
    MANUAL_DEPTH_CONTRACT_VERSION_V5,
    MANUAL_DEPTH_CONTRACT_VERSIONS,
    MANUAL_READER_QUALITY_VERSIONS,
    findCrossSectionDuplicateSentences,
    validateManualDepthContractV2,
    validateManualDepthContractV3,
    analysisManifestRequiresMethodDetailContract,
    isRecoveryStageTerminal,
    CORE_SUMMARY_CONTRACT_VERSION,
    CORE_SUMMARY_MIN_CHINESE_CHARS,
    CORE_SUMMARY_MAX_CHINESE_CHARS,
    CORE_SUMMARY_MIN_SENTENCES,
    CORE_SUMMARY_MAX_SENTENCES,
    hasCoreSummaryQuantitativeEvidence,
    hasSourceMeasuredLossComparison,
    classifySourceQuantitativeEvidence,
    validateCoreSummarySemanticContract,
    hashAnalysisWithMaskedCoreSummary,
    hashTagSectionAndPrimaryTags,
    maskClassificationFields,
    validateTagStageProof,
    validateCoreSummaryStageBinding,
    manualSha256,
    manualTextSha256,
    findManualBoilerplate,
    validateManualEvidenceLedger,
    validateFreshAuthoringRecordConsistency,
    validateTutorialPayloadRecordConsistency,
    validateManualTakeoverManifest,
    getInvalidAnalysisReason
};

if (require.main === module) {
    require('./env-loader.js').requireExternalRuntime('analysis-contract.js');
}
