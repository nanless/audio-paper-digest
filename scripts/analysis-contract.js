const { historicalContract: historicalManualContract } = require('./lib/protocol-codec');
const crypto = require('crypto');
const { TAG_STAGE_RECORD_CONTRACT, tagStageRecordDeclaration, isTagStageRecordDeclaration, readTagStageRecord } = require('./lib/tag-stage-record.js');
const { sourceBackedSampleSizeBoundary } = require('./lib/experiment-source-setting-axes.js');
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
const { createPaperExemptions } = require('./lib/analysis-contract-paper-exemptions.js');

// 退役 manual/ 契约模块按需惰性加载，常规日更/会议/历史 API 路径导入本模块时不加载 manual/scripts/*。
let cachedManualAgentPolicy = null;
function getManualAgentPolicy() {
    if (!cachedManualAgentPolicy) {
        cachedManualAgentPolicy = require('../manual/scripts/manual-agent-policy.js');
    }
    return cachedManualAgentPolicy;
}

let cachedManualResearchContract = null;
function getManualResearchContract() {
    if (!cachedManualResearchContract) {
        cachedManualResearchContract = require('../manual/scripts/manual-research-contract.js');
    }
    return cachedManualResearchContract;
}

let cachedManualTutorialOrchestrator = null;
function getManualTutorialOrchestrator() {
    if (!cachedManualTutorialOrchestrator) {
        cachedManualTutorialOrchestrator = require('../manual/scripts/manual-tutorial-contract-orchestrator.js');
    }
    return cachedManualTutorialOrchestrator;
}

let cachedManualFreshAuthoring = null;
function getManualFreshAuthoring() {
    if (!cachedManualFreshAuthoring) {
        cachedManualFreshAuthoring = require('../manual/scripts/manual-fresh-authoring-contract.js');
    }
    return cachedManualFreshAuthoring;
}

let cachedManualTutorialPayload = null;
function getManualTutorialPayload() {
    if (!cachedManualTutorialPayload) {
        cachedManualTutorialPayload = require('../manual/scripts/manual-tutorial-payload.js');
    }
    return cachedManualTutorialPayload;
}

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
const qualityFormats = require('./lib/analysis-quality-format');
const EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION = qualityFormats.original('experiment-tables', 'size-limits-only');
const EXPERIMENT_TABLE_CONTRACT_VERSION = qualityFormats.original('experiment-tables', 'evidence-rich');
const EXPERIMENT_TABLE_CONTRACT_VERSIONS = Object.freeze([
    EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION,
    EXPERIMENT_TABLE_CONTRACT_VERSION
]);
const METHOD_DETAIL_CONTRACT_VERSION = qualityFormats.original('method-detail', 'detailed-method');
const EDITORIAL_QUALITY_CONTRACT_VERSION = qualityFormats.original('manual-editorial-quality', 'original-reader-facing');
// Manual/离线分析除了要满足 API 分析用的结构约定，还必须带真实全文证据。
// 这里特意做成单独的可选约定：旧的合法 API 记录继续兼容，
// 新的 manual 记录则不能缩水成摘要加几句泛泛的过程评述。
const MANUAL_DEPTH_SOURCE_CONTRACT = historicalManualContract('manual-analysis-depth', 'baseline-source');
// v2 根据 2026-08-20 批次的问题增加 manual 分析正文检查：跨章节重复、
// 编辑模板句、遗漏原文开源 URL，以及评分理由没有引用证据编号。
const MANUAL_DEPTH_COVERAGE_CONTRACT = historicalManualContract('manual-analysis-depth', 'source-coverage');
// v3 补的是对比 2026-08-25 manual 批次和 2026-08-14 API 批次时发现的读者
// 可见差距。只够长不行：成稿要读起来像技术解读——摘要里有真正的论证，
// 数据流分多步，创新点各自独立，有对比实验和复现信息，评分理由逐维度写，
// 证据与审查者局限分开标注。
const MANUAL_DEPTH_EXPLANATION_CONTRACT = historicalManualContract('manual-analysis-depth', 'beginner-explanation');
// v4 保留 v3 的全部行文与证据要求，另外绑定更细的实验表格约定和
// 与上下文绑定的图片讲述约定。这个绑定刻意按版本走：
// 已发布的 v1–v3 manual 记录沿用当时的表格规则，不套用新版正文检查。
const MANUAL_DEPTH_READER_QUALITY_CONTRACT = historicalManualContract('manual-analysis-depth', 'reader-quality');
const MANUAL_DEPTH_FACT_COVERAGE_CONTRACT = historicalManualContract('manual-analysis-depth', 'fact-coverage');
const MANUAL_DEPTH_CONTRACTS = Object.freeze([
    MANUAL_DEPTH_SOURCE_CONTRACT,
    MANUAL_DEPTH_COVERAGE_CONTRACT,
    MANUAL_DEPTH_EXPLANATION_CONTRACT,
    MANUAL_DEPTH_READER_QUALITY_CONTRACT,
    MANUAL_DEPTH_FACT_COVERAGE_CONTRACT
]);
const MANUAL_READER_QUALITY_CONTRACTS = Object.freeze([
    MANUAL_DEPTH_READER_QUALITY_CONTRACT,
    MANUAL_DEPTH_FACT_COVERAGE_CONTRACT
]);
const ANALYSIS_EDITORIAL_LEAKAGE_CONTRACT_VERSION = qualityFormats.original('analysis-editorial-leakage', 'editorial-text-excluded');
const MANUAL_COMPLETE_STATUS = 'manual_complete';
const MANUAL_COMPLETE_PROVENANCE_VERSION = 2;
const MANUAL_PROVENANCE_PROTOCOL = historicalManualContract('manual-stage-attestation', 'source-bound-review');
const MANUAL_STAGE_EXECUTION_KIND = 'manual_attestation';
// 2026-08-21 之前完成的记录还没有逐阶段提示词/上下文绑定。这批已发布的
// 记录继续可读，但不许新记录删掉加固字段退回旧档案。
const MANUAL_BOUND_STAGE_CUTOFF_DATE = '2026-08-22';
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
const coreSummaryFormat = require('./lib/core-summary-format');
const CORE_SUMMARY_CONTRACT_VERSION = coreSummaryFormat.originalTag;
const CORE_SUMMARY_LEGACY_MIN_CHINESE_CHARS = 320;
const CORE_SUMMARY_LEGACY_MAX_CHINESE_CHARS = 600;
const CORE_SUMMARY_LEGACY_MIN_SENTENCES = 6;
const CORE_SUMMARY_LEGACY_MAX_SENTENCES = 12;
const CORE_SUMMARY_MIN_CHINESE_CHARS = 700;
const CORE_SUMMARY_MAX_CHINESE_CHARS = 1400;
const CORE_SUMMARY_MIN_SENTENCES = 10;
const CORE_SUMMARY_MAX_SENTENCES = 26;
const CORE_SUMMARY_MIN_PARAGRAPHS = 3;
const CORE_SUMMARY_MAX_PARAGRAPHS = 4;
const CORE_SUMMARY_MAX_METHOD_SENTENCE_CHARS = 520;
const CORE_SUMMARY_RESULT_UNAVAILABLE = '原文未提供可核对的关键定量结果';
const CORE_SUMMARY_COST_UNAVAILABLE = '原文未披露训练、推理或部署成本';
const CORE_SUMMARY_NUMBER_PATTERN = /(?<![A-Za-z0-9])[-+]?\d+(?:\.\d+)?(?:\s*(?:%|％|dB|ms|s|秒|分钟|小时|倍|点|分))?(?![A-Za-z0-9])/g;
// 英文指标名必须整词匹配。没有这里的两侧边界，mAP/PAR/PER 这类短指标会命中
// "mapping"、"Particle"、"performance" 等普通词，把章节号和引用位置误当成
// 实验测量结果。
const CORE_SUMMARY_METRIC_PATTERN = /(?:(?<![A-Za-z0-9_])(?:(?:cp|tcp)?WER|SWER|AER|CER|PER|DER|JER|F1|F[- ]?Scores?|BLEU|COMET|ROUGE|MOS(?:[- ]?[PT])?|CCC(?![A-Za-z0-9_.-]|[ \t]*(?:(?:的|为|是|作为|用作)[ \t]*)?(?:模型|方法|系统|基线|算法|网络|model\b|method\b|system\b|baseline\b|network\b))|PCC|FAD(?:CLAP|Vggish)|CQT1-PCC|LPAPS|CDPAM|PESQ|STOI|SI-SDR|CA-SDRi|SDRi|SNRi|SDR|SNR|EER|UAR|PPL|NLL|negative[ -]log[ -]likelihood|false[ -]acceptance[ -]rate|unsafe[ -]response[ -]rate|safety[ -]understanding[ -]rate|deepfake[ ]+FAR|TNR|TPR|LSD|ILD[ -]+error|Human[ ]+S|ILD[- ]W|ASR|mAP|gAP|AUROC|AUC|GMR|GMC|ECE|mIoU|IoU|J&F|MJ|MF|Jaccard|LangRank|Exact Match|Pearson|Spearman|Kendall|PSNR|SSIM|MSE|MAE|RMSE|FGD|BeatAlign|Diversity|R1@(?:0(?:\.\d+)?|1(?:\.0+)?)(?![.\d@])|R@\d+(?:\.\d+)?|SAR|DAR|PISR|RtA|NBS|OIC|PAR|Fair[ -]?Rate|BMSR|JSR|RSF|OH|n?TVD|SpkSim|LPS|SBS|UTMOS|PLCMOS|precision|recall|MSR|FVD|FID|Acc(?:[_ -]?(?:macro|num))?|CLAP(?:[_ -](?:MS|LAION))?|VISQOL|MCD|SPK[_ -]?SIM|Mel(?:[ -]Dist(?:ance)?)?|STFT(?:[ -]Dist(?:ance)?)?|DeSync|MotionQ|IB|accuracy|error rate|success rate|win rate|compression[ -](?:ratio|rate)|real[ -]time factor|scores?|latency|throughput|RTF|FPS|performance|metrics?)(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])E2E(?=[ ]*(?:比例|命中率|成功率))|(?:皮尔逊(?:积矩)?相关系数|斯皮尔曼(?:秩)?相关系数|肯德尔(?:秩相关|和谐|协调|一致性)系数)(?!\s*(?:的)?(?:模型|方法|基线|算法|网络))|一致性相关系数(?![ \t]*(?:(?:的|为|是|作为|用作)[ \t]*)?(?:模型|方法|系统|基线|算法|网络|model\b|method\b|system\b|baseline\b|network\b))|字错率|评估损失(?:终值)?(?=[^。；\n]{0,90}(?:[二两三四五六七八九十百1-9][0-9]*(?:\.\d+)?倍|(?:为|是|从)\s*\d+(?:\.\d+)?))|不安全回答率|安全理解率|伪造假接受率|耳间强度差(?:Wasserstein)?距离|平均绝对误差|端到端命中率|有用性偏好率|均方根误差|词(?:字)?错率|困惑度|负对数似然|攻击成功率|准确率|正确率|错误率|误差率|期望校准误差|召回率|精确率|总体分|总分|得分|分数|胜率|成功率|延迟|吞吐|实时率|对数谱失真|两耳声级差误差|正确拒绝率|真负率|真阳性率|检出率|(?:人类|人工)(?:语义)?评分|主观评分|客观评分|相似度|相似分数|性能|指标)/i;
// These source-native names describe measured quantities, not similarly named models.
const CORE_SUMMARY_ADDITIONAL_METRIC_NAME = /(?:DAP|DLP|AMLt|F-measure|F-Measure|Fmeasure|Fmeter|MV2H[45]|OMR-NED|R(?:²|\^2)(?:_[VA])?|MSS|决定系数(?:[ \t]*R(?:²|\^2)(?:_[VA])?)?|(?:目标字|字符|音节|音素|单词)时长(?:均值|平均值)|自然度平均意见分)/iu;
const CORE_SUMMARY_ADDITIONAL_MODEL_SUFFIX = String.raw`(?:模型|方法|系统|基线(?![ \t]*[-+]?[0-9])|算法|网络|model\b|method\b|system\b|baseline\b|network\b)`;
const CORE_SUMMARY_ADDITIONAL_METRIC_PATTERN = new RegExp(String.raw`(?<![A-Za-z0-9_])${CORE_SUMMARY_ADDITIONAL_METRIC_NAME.source}(?![A-Za-z0-9_.-]|[ \t]*(?:(?:的|为|是|作为|用作)[ \t]*)?${CORE_SUMMARY_ADDITIONAL_MODEL_SUFFIX})`, 'iu');
// 会议论文常用领域内的中文指标名（例如 DAFx 的“抖动”和“包络相关”）。
// 这里显式列出来，免得把任何结果名词都当成定量证据。
const CORE_SUMMARY_CONFERENCE_METRIC_PATTERN = /包络相关(?:性)?|抖动|计数偏差|总误差|频率误差|衰减误差|增益误差|相对误差|平均误差|压缩率|谐波失真|频谱对比度损失|起音时间(?:对数)?偏差|(?:对数似然比代价(?:[ \t]*[Cc][Ll][Ll][Rr](?![A-Za-z0-9_])|(?![ \t-]*[Cc][Ll][Ll][Rr]))|声对比度|声压级)(?=[ \t]*(?:指标|分数|得分)?(?:为|是|从|升至|降至)[ \t]*[-+]?[0-9]+(?:\.[0-9]+)?(?![A-Za-z0-9_.]))/;
const CORE_SUMMARY_GENERIC_ENGLISH_METRIC_PATTERN = /(?<![A-Za-z0-9_])(?:scores?|performance|metrics?)(?![A-Za-z0-9_])/i;
// Source-native vertex/gesture metrics; an alias naming a model is not a metric.
const CORE_SUMMARY_VERTEX_GESTURE_METRIC_PATTERN = /(?<![A-Za-z0-9_])(?:LVE|MVE|Lip[ -]+Vertex[ -]+Error|Mean[ -]+Vertex[ -]+Error|Fr[eé]chet[ -]+Gesture[ -]+Distance|Beat[ -]+Consistency)(?![A-Za-z0-9_.-]|[ \t]*(?:(?:的|为|是|作为|用作|这个|这一|那个|这种|一种|一个|该)[ \t]*)?(?:模型|方法|系统|基线|算法|网络|model\b|method\b|system\b|baseline\b|network\b))|(?:平均)?(?:唇顶点误差|全脸顶点误差)(?![ \t]*(?:的|这个|这一|那个|这种|一种|一个|该)?(?:模型|方法|系统|基线|算法|网络))/iu;
const CORE_SUMMARY_COMPARISON_PATTERN = /(?:from\b[^。！？!?]{0,50}\bto\b|improv(?:e|es|ed|ement)|outperform(?:s|ed)?|reduc(?:e|es|ed|tion)|increase[sd]?|decrease[sd]?|degrad(?:e|es|ed|ation)|\bon par\b|comparable|从[^。！？!?]{0,40}(?:升至|升到|降至|降到|提升至|提高到)|相比|相较|优于|超过|反超|低于|高于|提升|提高|改善|改进|降低|下降|减少|达到|增至|减至|领先|持平|相当|接近)/i;
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
const TABLE_ADDITIONAL_IDENTIFIER_HEADER_RE = /^(?:(?:评价|问卷)项目(?:[，,]\s*N\s*=\s*\d+)?|目标|蒸馏目标|环节|(?:distillation )?objective|训练损失|损失函数|监督目标|训练目标|评估设置|实验设置|提取来源|任务向量来源|表示|检测器|生成器|选择器|selector|组合|声源|音源|乐器|sound sources?|audio sources?|instruments?|分割规则|领域|合并点|合并位置|提示词|对比|对比对象|评测对象|量化水平|操作|被试\s*ID|预训练目标|训练数据|分词器|家族|NFE|number of function evaluations|函数求值次数|词表大小(?:\s*\$\\\|V\\\|\$)?|(?:潜|隐|表征|嵌入|特征|语义)空间|segmentation rule|domain|merge point|prompt|comparison object|participant\s+ID|pretraining objective|training data|tokenizer|vocabulary size)$/i;
function isTableIdentifierHeader(value) {
    const normalized = String(value || '').trim();
    if (/^推理窗长$/u.test(normalized)) return true;
    // 检验名称可以标识一行，但 F/t/p 等统计检验结果是可核对的测量值。
    // 仅识别完整列名，不能把“检验设置”等真正的条件列变成结果列。
    if (/^(?:(?:检验|统计检验)?统计量|统计检验结果|(?:F|t|z|χ²)\s*统计量|(?:test\s+)?statistics?|[Ftzp][ -]?(?:values?|statistics?))$/i.test(normalized)) return false;
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

const {
    CORE_SUMMARY_DNSMOS_PATTERN,
    CORE_SUMMARY_DNSMOS_DENIED,
    sourceBackedIdentityColumns,
    sourceBoundLossSwitchColumns,
    ownObservedSourceScope,
    adjacentSourceStatementAfter,
    hasOwnSourceStatement,
    hasObservedStageSwitchTable,
    isReportedExperimentPrefix,
    hasReportedExperimentPhrase,
    hasSourceBackedSequenceOrderAblation,
    hasSourceBackedPresenceComparison,
    hasSourceBackedComponentSwitchAblation,
    hasSourceBackedTrainingStageAblation,
    hasSourceBackedSettingVariantAblation,
    normalizeLocalEvidenceHeading,
    hasOwnLocalReportedExperiment,
    hasSourceBackedPlacementControl,
    hasSourceBackedZeroCorrectionAblation,
    hasAdjacentAffirmativeEvidenceWithdrawal,
    hasSourceBackedNetIntervalNegative,
    hasSourceBackedRewardSwitchAblation,
    matchesSourceAudiogramMetricPairs,
    hasSourceBackedQualityAudibilityTradeoff,
    sourceBoundPredictionRefinementDecline,
    hasTableBoundHigherMetricRegression,
    hasSourceBackedWindowConfusion,
    observedExperimentClaim,
    observedSourceNegativeEvidence,
    sourceHasObservedReasoningFailure,
    sourceBoundLowerMetricIncrease,
    sourceTwoBaselineMetricRegressions,
    sourceBoundReverseBaselineComparison,
    sourceBoundMatchedAcousticGap,
    unquotedObservedComparison,
    observedAdverseComparison,
    sourceBoundListeningScoreRegression,
    sourceBoundRenderedDurationShortfall,
    sourceBoundFoldedObjectiveRegression,
    sourceBoundDeadlineF1Comparison,
    sourceBoundNotationRoundtripRegression,
    hasBoundFormerLatterComparison,
    hasBoundDisjointIntervalComparison,
    hasConditionalMetricDeltaDirection,
    hasPrefixedCoreMetricComparison,
    stripSymbolicPatternRelation,
    hasSymbolicGeometryMethodChain,
    hasScopedSymbolicDemonstration,
    sourceHasMeasuredMetricTable,
    sourceCorpusCurationResult,
    hasCompleteCorpusCurationResult,
    sourceSoftwareFunctionalValidationResult,
    hasCompleteSoftwareFunctionalValidationResult,
    sourceHasBoundEventProportionComparison,
    sourceHasBoundMeanF0Comparison,
    sourceHasObservedOutcomeComparison,
    sourceMeasuredPlannerSelection,
    sourceBoundPlannerSelectionResult,
    hasSourceBoundTextVideoComparison,
    hasConcreteCoreSummarySetting,
    hasRecordedDissonanceComparison,
    hasMeanRoomSimulationComparison,
    hasSourceBackedBayesianGroupResult,
    sourceCorrectionRateProfile,
    sourceBoundCorrectionRateObservations,
    hasAffirmativeDnsMosStatement,
    hasSourceDefinedDnsMos,
    hasSourceBoundDnsMosBoundary,
    hasCountedEvaluationScope,
    hasSourceBoundHitCountMetric,
    hasBlockLayoutProductChain,
    hasPosteriorUpdateProductChain,
    hasConcreteProductHandoff,
    hasExplicitArtifactHandoff,
    hasCachedCausalStateHandoff,
    hasOfflineOperationalBoundary,
    hasNaturalScopedBoundary,
    hasGeneratedInputModelHeadChain,
    hasExplicitEditedVectorHandoff,
    hasTypedNaturalProductHandoff,
    hasSourceBoundEditedWaveformOrCachedAvChain,
    hasTypedProcessingProductChain,
    hasSourceBoundSymbolAndTrajectoryHandoff,
    hasExplicitNaturalProductChain,
    hasConcreteUnnumberedMethodChain,
    hasAdjacentConcreteMethodChain,
    hasConcreteCompressionPurpose,
    hasConcreteAcousticSimulationPurpose,
    hasConcreteRuntimeDisclosure
} = createPaperExemptions({
    isTableIdentifierHeader,
    CORE_SUMMARY_METRIC_PATTERN,
    CORE_SUMMARY_CONFERENCE_METRIC_PATTERN,
    CORE_SUMMARY_GENERIC_ENGLISH_METRIC_PATTERN,
    CORE_SUMMARY_NUMBER_PATTERN,
    CORE_SUMMARY_OPERATIONAL_PARAMETER_PATTERN
});

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
            if (match && !(match[1][0] === '`' && line.slice(match[0].length).includes('`'))) {
                fence = { char: match[1][0], length: match[1].length };
                return '';
            }
            return line;
        }
        if (match && match[1][0] === fence.char && match[1].length >= fence.length
            && line.slice(match[0].length).trim() === '') {
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

function validateAnalysisEditorialLeakageContract(analysis, options = {}) {
    const leakages = findAnalysisEditorialLeakages(analysis);
    if (leakages.length > 0) {
        return `检测到模型编辑/自检批注泄漏: ${leakages.join('；')}`;
    }
    if (options.enforceCyrillicProseGarble === true) {
        return validateCyrillicProseGarbleContract(analysis, options);
    }
    return null;
}

const EXPLICIT_SLAVIC_TOPIC_RE = /(?:俄语|俄文|西里尔(?:字母|文)?|斯拉夫|乌克兰语|保加利亚语|塞尔维亚语|白俄罗斯语|\bRussian\b|\bCyrillic\b)/iu;

function maskProseForCyrillicCheck(text) {
    const original = String(text ?? '');
    const mask = value => value.replace(/[^\r\n]/g, ' ');
    let fence = null;
    let mathEnd = null;
    let visible = original.split(/(?<=\n)/u).map(line => {
        const trimmed = line.trim();
        const marker = trimmed.match(/^(`{3,}|~{3,})/u);
        if (fence) {
            if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length
                && trimmed.slice(marker[1].length).trim() === '') fence = null;
            return mask(line);
        }
        if (marker) {
            if (trimmed.indexOf(marker[1], marker[1].length) < 0) fence = marker[1];
            return mask(line);
        }
        if (mathEnd) {
            if (trimmed.includes(mathEnd)) mathEnd = null;
            return mask(line);
        }
        if (/^(?:\$\$|\\\[)/u.test(trimmed)) {
            const end = trimmed.startsWith('$$') ? '$$' : '\\]';
            if (!trimmed.slice(2).includes(end)) mathEnd = end;
            return mask(line);
        }
        if (/^(?:>\s?|!\[)/u.test(trimmed)) return mask(line);
        return line;
    }).join('')
        .replace(/(`+)[^`\n]*?\1/gu, mask)
        .replace(/\$[^$\n]+\$|\\\([^\n]*?\\\)/gu, mask)
        .replace(/https?:\/\/\S+/gu, mask)
        .replace(/(?:原文(?:写道|原句|引文|表述)|逐字引文|来源引文)\s*[：:]\s*[“「"'][^”」"'\n]*[”」"']/gu, mask);
    const tableLines = new Set(extractMarkdownTables(visible)
        .flatMap(table => Array.from({ length: table.endLine - table.startLine + 1 },
            (_, index) => table.startLine + index)));
    if (tableLines.size > 0) {
        visible = visible.split('\n').map((line, index) => tableLines.has(index)
            ? mask(line) : line).join('\n');
    }
    return visible;
}

function findCyrillicProseGarbleIssues(text, options = {}) {
    const original = typeof options.originalText === 'string' ? options.originalText : String(text ?? '');
    if (!/[\u0400-\u04FF]/u.test(original)) return [];
    const visible = options.alreadyMasked === true ? String(text ?? '') : maskProseForCyrillicCheck(original);
    if (!/[\u0400-\u04FF]/u.test(visible)) return [];
    const sourceCyrillicTokens = typeof options.sourceText === 'string' && options.sourceText.trim()
        ? new Set([...options.sourceText.toLowerCase().matchAll(/[\u0400-\u04FF]+/gu)].map(item => item[0]))
        : null;
    const documentHasSlavicTopic = EXPLICIT_SLAVIC_TOPIC_RE.test(
        [original, options.documentText || '', options.contextText || ''].join('\n')
    );
    const findings = [];
    for (const match of visible.matchAll(/[\u0400-\u04FF]+/gu)) {
        const index = match.index;
        const surface = original.slice(index, index + match[0].length);
        const token = match[0].toLowerCase();
        if (sourceCyrillicTokens && sourceCyrillicTokens.has(token)) continue;
        if (documentHasSlavicTopic && [...token].length === 1) continue;
        const sentenceStart = Math.max(
            original.lastIndexOf('。', index),
            original.lastIndexOf('！', index),
            original.lastIndexOf('？', index),
            original.lastIndexOf('!', index),
            original.lastIndexOf('?', index),
            original.lastIndexOf('\n', index)
        ) + 1;
        const tailOffset = original.slice(index + match[0].length).search(/[。！？!?\n]/u);
        const sentenceEnd = tailOffset < 0 ? original.length : index + match[0].length + tailOffset;
        const visibleSentence = visible.slice(sentenceStart, sentenceEnd);
        const lineStart = original.lastIndexOf('\n', index) + 1;
        const lineEndOffset = original.slice(index + match[0].length).indexOf('\n');
        const lineEnd = lineEndOffset < 0 ? original.length : index + match[0].length + lineEndOffset;
        const visibleLine = visible.slice(lineStart, lineEnd);
        const adjacentSentencePunct = (sentenceStart > lineStart && /[。！？!?]/u.test(original[sentenceStart - 1]))
            || (sentenceEnd < lineEnd && /[。！？!?]/u.test(original[sentenceEnd]));
        const inChineseProseContext = /[\u4e00-\u9fff]/u.test(visibleSentence)
            || (adjacentSentencePunct && /[\u4e00-\u9fff]/u.test(visibleLine));
        if (!inChineseProseContext) continue;
        const sentence = original.slice(sentenceStart, sentenceEnd);
        if (EXPLICIT_SLAVIC_TOPIC_RE.test(sentence)) continue;
        findings.push({
            code: 'cyrillic_prose_garble',
            match: surface,
            tokens: [token],
            index,
            line: original.slice(0, index).split('\n').length,
            message: '检测到中文正文中混入西里尔字母乱码词（如俄语词碎片），请对照论文原文改写为准确的自然中文表述，保留原有数值、单位、方法归属与来源证据。'
        });
    }
    return findings;
}

function validateCyrillicProseGarbleContract(text, options = {}) {
    const findings = findCyrillicProseGarbleIssues(text, options);
    if (findings.length === 0) return null;
    const snippets = [...new Set(findings.map(item => item.match.trim()).filter(Boolean))].slice(0, 5);
    return `检测到中文正文混入西里尔字母乱码词: ${snippets.join('；')}`;
}

function maskMarkdownCodeSpanParagraph(text, fill = ' ') {
    const output = text.split('');
    const ticks = [...text.matchAll(/`+/g)];
    for (let index = 0; index < ticks.length; index += 1) {
        const start = ticks[index].index;
        let escaped = 0;
        for (let before = start - 1; before >= 0 && text[before] === '\\'; before -= 1) escaped += 1;
        if (escaped % 2) continue;
        const closing = ticks.findIndex((match, next) => next > index && match[0].length === ticks[index][0].length);
        if (closing < 0) continue;
        const end = ticks[closing].index + ticks[closing][0].length;
        for (let offset = start; offset < end; offset += 1) if (!/[\r\n]/.test(text[offset])) output[offset] = fill;
        index = closing;
    }
    return output.join('');
}

// 保留字符位置和换行；只遮罩代码、引用及 Markdown 原样 HTML 区域。
// 优先处理已开始的 HTML 原样块/声明和围栏，其内部不再启动其他 Markdown 状态。
// 普通 HTML 块到空行结束：忽略内部围栏，但继续跟踪真实 HTML 注释。
// 行内代码先作等长探针，防止单元格中的 HTML 示例触发注释或区块状态。
function maskProtectedMarkdownTableRegions(text, { excludeQuotes = true } = {}) {
    let fence = null;
    let quote = false;
    let htmlBlock = false;
    let htmlLiteral = null;
    let comment = false;
    let htmlTerminator = null;
    return String(text || '').split('\n').map(line => {
        const blank = () => line.replace(/[^\r]/g, ' ');
        const syntaxLine = excludeQuotes ? line : line.replace(/^ {0,3}(?:>[ \t]?)+/, '');
        const quotePrefixLength = line.length - syntaxLine.length;
        if (htmlLiteral) {
            if (new RegExp(`</${htmlLiteral}\\s*>`, 'i').test(line)) htmlLiteral = null;
            return blank();
        }
        if (htmlTerminator) {
            if (line.includes(htmlTerminator)) htmlTerminator = null;
            return blank();
        }
        if (htmlBlock && !line.trim()) htmlBlock = false;
        const boundary = htmlBlock ? null : syntaxLine.match(/^ {0,3}(`{3,}|~{3,})/);
        if (fence) {
            if (boundary && boundary[1][0] === fence[0] && boundary[1].length >= fence.length
                && syntaxLine.slice(boundary[0].length).trim() === '') fence = null;
            return blank();
        }
        if (boundary && !comment && !htmlLiteral
            && !(boundary[1][0] === '`' && syntaxLine.slice(boundary[0].length).includes('`'))) {
            fence = boundary[1];
            return blank();
        }
        // 行内代码里的 HTML 字样是单元格内容，不是注释或 HTML 区块。
        const startsHtmlBlock = /^ {0,3}<\/?(?:address|article|aside|blockquote|body|caption|center|col|colgroup|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|iframe|legend|li|main|menu|nav|ol|p|section|summary|table|tbody|td|tfoot|th|thead|title|tr|ul)(?=[\s/>])/i.test(syntaxLine);
        const probe = (htmlBlock || comment || startsHtmlBlock) ? line : maskMarkdownCodeSpanParagraph(line, 'x');
        const chars = line.split('');
        for (let index = 0; index < line.length; index += 1) {
            if (comment) {
                if (probe.startsWith('-->', index)) {
                    for (let offset = 0; offset < 3; offset += 1) chars[index + offset] = ' ';
                    index += 2; comment = false;
                } else if (line[index] !== '\r') chars[index] = ' ';
            } else if (probe.startsWith('<!--', index)) {
                comment = true;
                for (let offset = 0; offset < 4; offset += 1) chars[index + offset] = ' ';
                index += 3;
            }
        }
        const visible = chars.join('');
        const syntaxVisible = visible.slice(quotePrefixLength);
        if (htmlBlock) return blank();
        const literal = syntaxVisible.match(/^ {0,3}<(pre|code|script|style|textarea)(?=[\s/>])/iu);
        if (literal) {
            // HTML 原样块的内部注释不是 Markdown 注释，不能影响块后的正文。
            comment = false;
            // Hugo 可把 ſcript 作为原样块开始；实际 DOM 中 </ſcript> 不结束 ASCII script。
            // 开始按已证大小写折叠识别，结束仍要求普通 ASCII 标签，不能合并为同一 /iu。
            const literalName = literal[1].toLowerCase().replace(/ſ/g, 's');
            if (!new RegExp(`</${literalName}\\s*>`, 'i').test(probe)) htmlLiteral = literalName;
            return blank();
        }
        const terminator = /^ {0,3}<\?/.test(syntaxVisible) ? '?>'
            : /^ {0,3}<!\[CDATA\[/.test(syntaxVisible) ? ']]>'
                : /^ {0,3}<![A-Z]/.test(syntaxVisible) ? '>' : null;
        if (terminator) {
            if (!probe.includes(terminator)) htmlTerminator = terminator;
            return blank();
        }
        if (!visible.trim()) { quote = false; htmlBlock = false; }
        if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(syntaxVisible)) quote = false;
        if (/^ {0,3}>/.test(visible)) quote = true;
        if (startsHtmlBlock && visible.trim()) htmlBlock = true;
        if (/^ {0,3}<\/?[a-z][\w-]*(?:\s+[^<>]*)?\s*\/?>[ \t]*$/i.test(syntaxVisible)) htmlBlock = true;
        if (excludeQuotes && quote || htmlBlock || /^(?: {4}|\t)/.test(syntaxVisible)) return blank();
        return visible;
    }).join('\n');
}

// 行内代码可以跨一个段落的换行，不能跨空段落、真实标题或表格区块。
function maskInlineMarkdownCodeSpans(text) {
    const lines = String(text || '').split('\n');
    const tableLines = new Set(extractMarkdownTables(text).flatMap(table =>
        Array.from({ length: table.endLine - table.startLine + 1 }, (_, index) => table.startLine + index)));
    const output = lines.slice();
    let first = 0;
    const flush = end => {
        if (end <= first) return;
        const paragraph = maskMarkdownCodeSpanParagraph(lines.slice(first, end).join('\n'));
        output.splice(first, end - first, ...paragraph.split('\n'));
    };
    for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].trim() || tableLines.has(index)
            || /^ {0,3}(?:#{1,6}[ \t]|(?:[-+*]|\d+[.)])[ \t])/.test(lines[index])) {
            flush(index);
            output[index] = maskMarkdownCodeSpanParagraph(lines[index]);
            first = index + 1;
        }
    }
    flush(lines.length);
    return output.join('\n');
}

// Markdown 图片的地址允许平衡括号；共享扫描用于图的排序和可见性核验。
function extractVisibleMarkdownImages(text) {
    const original = String(text || '');
    const visible = maskInlineMarkdownCodeSpans(
        maskProtectedMarkdownTableRegions(original, { excludeQuotes: false }));
    const images = [];
    for (const match of visible.matchAll(/!\[(?:\\.|[^\]\\\n])*\]\(/g)) {
        const start = match.index;
        let backslashes = 0;
        for (let index = start - 1; index >= 0 && visible[index] === '\\'; index -= 1) backslashes += 1;
        if (backslashes % 2 === 1) continue;
        let index = start + match[0].length;
        const urlStart = index;
        let depth = 1;
        for (; index < visible.length && !/[\r\n]/.test(visible[index]); index += 1) {
            if (visible[index] === '\\') { index += 1; continue; }
            if (visible[index] === '(') depth += 1;
            if (visible[index] === ')' && --depth === 0) break;
        }
        if (depth !== 0) continue;
        const destination = visible.slice(urlStart, index).trim();
        // 现有装配器使用无标题的 URL；遇未知地址也返回给调用者核对，不能静默忽略。
        const url = destination.replace(/^<([^>]+)>$/, '$1').replace(/\\([()])/g, '$1');
        images.push({ url, markdown: original.slice(start, index + 1), start, end: index + 1 });
    }
    return images;
}

function extractMarkdownTables(text) {
    const lines = maskProtectedMarkdownTableRegions(text).split('\n');
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
        const categoricalLossColumns = sourceBackedIdentityColumns(table, options.sourceText);
        if (table.identifierColumns < 1 && categoricalLossColumns.size === 0) {
            return `实验结果第 ${index + 1} 张表缺少方法、数据集或设置识别列`;
        }
        for (const [column, header] of table.header.entries()) {
            const normalized = header.replace(/[*_`]/g, '').trim();
            const identifier = isTableIdentifierHeader(normalized) || categoricalLossColumns.has(column);
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
            isTableIdentifierHeader(header.replace(/<br\s*\/?>/gi, ' ').replace(/[*_`]/g, '').trim()) || categoricalLossColumns.has(index)
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
        const boundaryPattern = /(?:相比|相对|差异|提升|下降|降低|增加|减少|但|而|同时|代价|边界|未|不显著|跨零|失败|退化|仅[^。；\n]{1,40}(?:保持|达到)?显著|只说明|不支持|(?:证据|结论)(?:范围)?限于|不宜(?:直接)?(?:解释|推广|视为|当作)|不能(?:直接)?(?:解释|推广|视为)|不可(?:直接)?(?:解释|推广|视为)|不应(?:直接)?(?:解释|推广|视为))/;
        const before = resultLines.slice(0, table.startLine).join('\n').trim()
            .split(/\n\s*\n/).filter(Boolean).slice(-5).reverse()
            .find(paragraph => paragraph.replace(/[*_`#>\s]/g, '').length >= 20
                && comparisonPattern.test(paragraph)) || '';
        const after = resultLines.slice(table.endLine + 1).join('\n').trim()
            .split(/\n\s*\n/).filter(Boolean).slice(0, 5)
            .find(paragraph => paragraph.replace(/[*_`#>\s]/g, '').length >= 50
                && (boundaryPattern.test(paragraph)
                    || sourceBackedSampleSizeBoundary(paragraph, table, options.sourceText, results))) || '';
        if (!before) {
            return `实验结果第 ${index + 1} 张表前缺少与上下文衔接的具体比较问题`;
        }
        if (!after) {
            return `实验结果第 ${index + 1} 张表后缺少最关键差异、解释与证据边界`;
        }
    }
    if (options.enforceTableCommentaryAlignment === true) {
        const tableAlignmentIssue = validateTableCommentaryAlignmentContract(results, options);
        if (tableAlignmentIssue) {
            return tableAlignmentIssue;
        }
    }
    if (empirical && tables.length > 0 && numericCells < EXPERIMENT_TABLE_LIMITS.minNumericCells) {
        return `实验表格只有 ${numericCells} 个可核对数字，至少需要 ${EXPERIMENT_TABLE_LIMITS.minNumericCells} 个；纯趋势或结论摘要不能替代结果表`;
    }
    const sourceText = sourceExperimentEvidence(options.sourceText);
    const sourceHasComparison = /\b(?:baseline|compared?\s+(?:to|with)|comparison|outperform(?:s|ed)?|versus|vs\.)\b|基线|对照|相比|优于|弱于/i.test(sourceText);
    const resultHasComparison = /\b(?:baseline|compared?\s+(?:to|with)|comparison|versus|vs\.)\b|基线|对照|比较(?:对象)?是|相比|相对|优于|弱于|对比|超过|高于|低于|升至|降至|比(?!较)[^。；\n]{0,30}(?:高|低|强|弱|好|差|大|小|提升|下降)/i.test(results)
        || hasReportedExperimentPhrase(results, /将[^。；\n]{2,60}(?:排序|模型|系统|方法|结果)与[^。；\n]{2,80}(?:排序|模型|系统|方法|结果)[^。；\n]{0,20}比较/g);
    if (empirical && sourceHasComparison && !resultHasComparison) {
        return '全文包含基线或对照比较，但实验结果没有保留比较对象';
    }
    const sourceAblationEvidence = String(sourceText || '').replace(
        /\bno\s+(?:component\s+)?ablations?\b(?:\s+[^.?!\n]{0,40})?|\b(?:controlled\s+)?ablations?\s+(?:were|was)\s+not\s+(?:conducted|performed)\b|\babsence\s+of\s+(?:component\s+)?ablations?\b/gi,
        ' '
    );
    const sourceHasAblation = /\bablation\b|\bw\/?o\b|without\s+(?:the\s+)?(?:module|component|loss)|消融|移除|去掉/i.test(sourceAblationEvidence);
    const resultHasAblation = hasSourceBackedPlacementControl(results, sourceAblationEvidence)
        || hasSourceBackedPresenceComparison(results, tables, sourceAblationEvidence)
        || hasSourceBackedTrainingStageAblation(tables, sourceAblationEvidence)
        || hasSourceBackedSequenceOrderAblation(results, tables, sourceAblationEvidence)
        || hasSourceBackedSettingVariantAblation(results, tables, sourceAblationEvidence)
        || hasSourceBackedZeroCorrectionAblation(results, sourceAblationEvidence)
        || hasSourceBackedComponentSwitchAblation(results, sourceAblationEvidence)
        // 原文的全因子试点比较三项训练选择，结果表用“代替”而非“消融”。
        // 同时核对原文与同一结果表的各项名称、设置和对应效应。
        || (/eleven pilot runs[\s\S]{0,700}factorial[\s\S]{0,400}BPE-dropout/i.test(String(options.sourceText || ''))
            && /CR-CTC[\s\S]{0,100}0\.0115[\s\S]{0,200}CTC.side weight 0\.1 instead of 0\.3[\s\S]{0,100}0\.0020[\s\S]{0,200}BPE-dropout 0\.1 instead of none[\s\S]{0,100}0\.0062/i.test(String(options.sourceText || ''))
            && tables.some(table => {
                const rows = table.rows.map(row => row.join(' '));
                return rows.some(row => /CR-CTC/i.test(row) && /0\.0115/.test(row))
                    && rows.some(row => /CTC/i.test(row) && /0\.1/.test(row) && /0\.3/.test(row) && /0\.0020/.test(row))
                    && rows.some(row => /BPE.dropout/i.test(row) && /0\.0062/.test(row));
            }))
        || /\bablation\b|\bw\/?o\b|without\s+(?:the\s+)?(?:module|component|loss)|消融|移除|去掉|不含|排除|无外推/i.test(results)
        // 有的论文只用 `+ L_j`、`+ L_s` … 标注消融行，正文里说是逐级叠加。
        // 只要原文确实有消融，这仍然算显式的组件对照。
        || /(?:逐级|逐步|依次)(?:叠加|加入|添加|移除|比较)|(?:组件|约束|模块|损失|监督目标|局部配对|竞争归一化)[^。；\n]{0,24}(?:对照|贡献|差异|是否必要|必要性)/i.test(results)
        || /\+\s*L[_\s]?[A-Za-z](?:\s*\+\s*L[_\s]?[A-Za-z])+/i.test(results)
        || hasReportedExperimentPhrase(results,
            /(?:分离|隔离)[^。；\n]{1,32}(?:贡献|影响|作用)|(?:比较|对照)[^。；\n]{0,24}(?:组件|模块|门控)[^。；\n]{0,12}(?:组合|配置)/g);
    const reportedRewardAblation = hasSourceBackedRewardSwitchAblation(results, tables, sourceAblationEvidence);
    if (empirical && sourceHasAblation && !resultHasAblation && !reportedRewardAblation) {
        return '全文包含消融实验，但实验结果没有保留关键消融或组件对照';
    }
    // 原文明确说“没有退化/失败”时，不能当成负面结果。论文常写某个适配
    // "does not degrade" 源性能；否则光凭 `degrad` 这个词会把意思读反。
    const sourceNegativeEvidence = observedSourceNegativeEvidence(sourceText).replace(
        /\b(?:does|do|did)\s+not(?:\s+\w+){0,2}\s+(?:degrad(?:e|es|ed|ation)|fail(?:s|ed|ure)?)\b|\bno\s+(?:degrad(?:e|es|ed|ation)|fail(?:ure|ures)?)\b|\bwithout\s+(?:any\s+)?(?:degrad(?:e|es|ed|ation)|fail(?:ure|ures)?)\b|(?:未|没有|并未|无)[^。；\n]{0,12}(?:退化|失败)/gi,
        ' '
    ).replace(
        // "平台拒绝计为攻击失败"只是评测口径定义，不是论文报告的退化或失败结果。
        /\b(?:count(?:s|ed|ing)?|treated|recorded|considered|scored|classif(?:y|ied))\s+as\s+(?:an?\s+)?(?:[A-Za-z-]+\s+){0,3}fail(?:ure|ures)\b/gi,
        ' '
    );
    const sourceHasNegative = /not\s+significant|no\s+significant|degrad(?:e|es|ed|ation)|fail(?:s|ed|ure)?|worse\s+than|does\s+not\s+(?:improve|outperform)|未显著|不显著|退化|失败|更差|无效|负(?:面)?结果|性能回落|回落至|降幅|回退|不单调(?:性|改进)?|不保证单调(?:改进|提升)/i.test(sourceNegativeEvidence)
        || sourceTwoBaselineMetricRegressions(sourceText).length > 0;
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
    const reportedLowerScore = hasReportedExperimentPhrase(results, new RegExp(
        `${explicitHigherIsBetterMetric}(?:\\s|[0-9.%:：=（）()，,]|为|是|都|均|仍|却|也|则|反而|明显|显著|略|要){0,40}(?:更低|低于|不及)`, 'g'));
    const reportedBiasRegression = String(results).split(/[。；\n]/u).some(sentence =>
        !/(?:他人|其他模型|另一(?:个|种)(?:模型|系统)|无关(?:模型|系统)|否定|驳斥|转述)|(?:说法|表述|观点|判断)[^。；\n]{0,20}(?:错误|有误|不成立|不正确)/u.test(sentence)
        &&
        !/(?:假设|假想|如果|计划|未来|预计|可能|先前工作|相关工作|此前研究|并非|不是|没有|尚未|未曾|未|不|是否|尚无|未知|值得|有待|否认|反驳|引用|引述|错误说法|[?？])/u.test(sentence)
        && /(?:报告|发现|显示|实测|观测)/u.test(sentence)
        && /(?:蒸馏|候选)检查点[^。；\n]{0,70}[0-9]+(?:\.[0-9]+)?%[^。；\n]{0,40}比原始模型更偏/u.test(sentence)
        && [...sentence.matchAll(/([0-9]+(?:\.[0-9]+)?)%/gu)].every(match =>
            new RegExp(`distilled checkpoints[^\\n]{0,140}(?<![0-9.])${match[1].replace('.', '\\.')}%[^\\n]{0,140}scored worse on the bias benchmark than the original variants`, 'i').test(sourceText)));
    const resultHasNegative = sourceBoundListeningScoreRegression(results, tables, options.sourceText)
        || sourceBoundRenderedDurationShortfall(results, tables, options.sourceText)
        || sourceBoundPredictionRefinementDecline(results, options.sourceText)
        || sourceBoundNotationRoundtripRegression(results, options.sourceText)
        || hasSourceBackedQualityAudibilityTradeoff(results, tables, sourceText)
        || tables.some(table => String(results).split(/\n\s*\n/u)
            .some(paragraph => sourceBackedSampleSizeBoundary(paragraph, table, options.sourceText, results)))
        || sourceBoundMatchedAcousticGap(results, tables, options.sourceText)
        || sourceBoundFoldedObjectiveRegression(results, tables, options.sourceText)
        || sourceBoundDeadlineF1Comparison(results, tables, options.sourceText)
        || hasSourceBackedNetIntervalNegative(results, tables, options.sourceText)
        || sourceBoundLowerMetricIncrease(results, sourceText)
        || hasSourceBackedSequenceOrderAblation(results, tables, sourceText, true)
        || sourceHasObservedReasoningFailure(options.sourceText)
            && String(results).split(/[。；\n]/u).some(sentence =>
                !/(?:假设|假想|如果|未来|计划|讨论|提及|他人|其他(?:模型|方法)|第三方|引用|转述|并非|不是|不意味着|否认|反驳)/u.test(sentence)
                && /当推理阶段[^。；\n]{0,30}误识别目标时[^。；\n]{0,30}压缩无法恢复正确目标/u.test(sentence))
        || sourceBoundReverseBaselineComparison(results, tables, sourceText)
        || contextualNegative
        || hasSourceBackedWindowConfusion(results, sourceText)
        || hasTableBoundHigherMetricRegression(results, tables, options.sourceText)
        || explicitMetricDecline
        || reportedLowerScore
        || reportedBiasRegression
        || /not\s+significant|no\s+significant|degrad(?:e|es|ed|ation)|fail(?:s|ed|ure)?|worse\s+than|does\s+not\s+(?:improve|outperform)|未显著|不显著|无显著(?:差异)?|退化|恶化|失败|未能完成|失效|崩溃|接近随机|低于随机|损失(?!函数|项|权重|率)|更差|比(?!较)[^。；\n]{0,30}差|净下降|反而[^。；\n]{0,10}(?:下降|变差|降低|退化)|低于(?:基线|对照|原方法|原方案)|(?:未|没有|并未|不曾|未能)(?:带来|产生|有)?(?:改善|提升|改进|增益)|未改善|没有改善|无效|负(?:面)?结果|负增益|性能回落|回落至|负面|暴露短板|跨零|落后|回退|不单调(?:性|改进)?|非单调(?:性|响应|作答|情况|变化)?|不保证单调(?:改进|提升)|(?:例外|反例)(?![^。；\n]{0,80}(?:耗时|成本|时间|速度|内存|显存))[^。；\n]{0,80}(?:低于|下降|更差)/i.test(results)
        || hasAffirmedOverfittingEvidence(results);
    // 2026-11-06 曾以“先完成发布”为由取消这条阻断，但替换进来的回调没有任何调用方，
    // 也没有降级或审查记录，等于静默放行只挑正面结果的写法；发布端的同名规则和本文件的
    // 回归用例都仍要求拒绝。因此恢复原判据：来源含退化、不显著或失败结果时，
    // 实验结果必须把负面证据写出来，不能只报告提升。
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
    const tableProfile = qualityFormats.profile('experiment-tables', contractVersion);
    if (tableProfile === 'evidence-rich') {
        return validateExperimentTableEvidenceDepth(analysis, options);
    }
    if (tableProfile !== 'size-limits-only') {
        return `未知实验表格契约版本: ${contractVersion}`;
    }
    return null;
}

function analysisManifestRequiresExperimentTableContract(manifest) {
    return !!qualityFormats.profile('experiment-tables', manifest?.contracts?.experimentTables);
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
    if ([MANUAL_DEPTH_COVERAGE_CONTRACT, MANUAL_DEPTH_EXPLANATION_CONTRACT,
        ...MANUAL_READER_QUALITY_CONTRACTS]
        .includes(options.manualDepthContractVersion)) {
        const sourceCoverageIssue = validateManualSourceCoverage(analysis, { sourceText });
        if (sourceCoverageIssue) return sourceCoverageIssue;
    }
    if ([MANUAL_DEPTH_EXPLANATION_CONTRACT, ...MANUAL_READER_QUALITY_CONTRACTS]
        .includes(options.manualDepthContractVersion)) {
        const explanationIssue = validateManualBeginnerExplanation(analysis, { sourceText });
        if (explanationIssue) return explanationIssue;
    }
    if (MANUAL_READER_QUALITY_CONTRACTS.includes(options.manualDepthContractVersion)) {
        const quality = validateEditorialQuality(analysis, {
            sourceText,
            skipTableCommentaryAlignment: true
        });
        if (!quality.valid) {
            const details = quality.issues.slice(0, 6)
                .map(item => `${item.code}:${item.section || '-'}:${item.match || item.message}`)
                .join('；');
            return `manual v4 读者文本质量未通过: ${details}`;
        }
    }
    if (options.manualDepthContractVersion === MANUAL_DEPTH_FACT_COVERAGE_CONTRACT) {
        try {
            getManualResearchContract().validateExactFactCoverage(analysis, sourceText, {
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

function validateManualSourceCoverage(analysis, options = {}) {
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

function validateManualBeginnerExplanation(analysis, options = {}) {
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
    return !!qualityFormats.profile('method-detail', manifest?.contracts?.methodDetail);
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
        // A symbolic next/previous index is not a measured scalar. Keep any
        // actual metric value beside the symbol, including on the same PDF line.
        .replace(/(?<![A-Za-z0-9_])(?:[A-Z]?[tijkn][ \t]*[+-][ \t]*\d+|[A-Za-z]_[tijkn][ \t]*[+-][ \t]*\d+|[A-Za-z]_\{[tijkn][ \t]*[+-][ \t]*\d+\})(?![A-Za-z0-9_%]|\.[0-9])/g, ' ')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/\[[0-9,;\s-]+\]/g, ' ')
        .replace(/§\s*\d+(?:\.\d+)*/g, ' ')
        .replace(/\b(?:theorem|lemma|proposition|corollary|definition|def\.?|problem|prob\.?|assumption|equation|fig(?:ure)?\.?|table|section|appendix)\s*\d+(?:\.\d+)*/gi, ' ')
        .replace(/(?:定理|引理|命题|推论|公理|定义|假设|公式|方程|等式|式|图|表|章节|附录)\s*(?:编号)?\s*\d+(?:\.\d+)*/g, ' ')
        // 参考文献的卷、期和页码范围是文献定位，不是测量值。双栏 PDF 抽取会把
        // 文献行粘进正文句子，页码于是成了句内唯一数值，与正文的指标词拼成一条
        // 假结果（2611.05637 的 “pp. 1497–1500” 与 “accuracy” 就是这样被读成
        // 实测准确率）。只删这些定位记号，句内真正的测量值保留并照常判定。
        .replace(/\b(?:pp?\.|pages?)\s*\d+(?:\s*[–—~-]\s*\d+)?/gi, ' ')
        .replace(/\b(?:vol|no)\.\s*\d+(?:\s*[–—~-]\s*\d+)?/gi, ' ')
        // 会议 PDF 抽取会把正文里的上标脚注编号（如 "vocals, 10 so a comparison"）、
        // 软换行拼入句中的小节编号与步骤范围（如 ". 3.2 Data Flow ... (Steps 1–8)"）
        // 以及 "a 30-second audio clip, for example" 这类假设输入时长示例保留为裸数字，
        // 它们不是实测结果；仅移除这些结构化非结果记号，保留同句中的真实指标数值。
        .replace(/(?<=[,;])\s+\d{1,2}(?=\s+(?:so|and|but|or|which|that|where|when|while|who|because|as|in|on|for|with|the|a|an|it|this|these|they|we)\b)/g, ' ')
        .replace(/(?<=\.\s+)\d{1,2}\.\d{1,2}(?:\.\d{1,2})?\s+(?=[A-Z][a-z]+)/g, ' ')
        .replace(/\(\s*Steps?\s+\d+(?:\s*[–—-]\s*\d+)?\s*\)/gi, ' ')
        .replace(/\b(?:a|an)\s+\d+(?:\.\d+)?\s*-?\s*(?:second|sec|minute|min|hour|hr|ms|millisecond)s?\s+(?:audio|speech|video|input|sample|clip|utterance|segment)(?:\s+(?:clip|segment|sample|file|input))?(?=,?\s+for\s+example\b)/gi, ' ')
        // Calendar intervals and decades describe recording/composition history,
        // not a measured from/to improvement. Other numbers in the sentence stay.
        .replace(/\b(?:from|between)\s+(?:[12]?[0-9]|3[01])\s+(?:to|and)\s+(?:[12]?[0-9]|3[01])\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+(?:19|20)\d{2})?\b/gi, ' ')
        .replace(/\b(?:throughout|during|in|since)\s+the\s+(?:19|20)\d{2}s\b/gi, ' ')
        .replace(/(?<![A-Za-z0-9_])\d+(?:,\d{3})*(?:\.\d+)?\s*(?:种\s*)?(?:languages?|语言)(?![A-Za-z0-9_])/gi, ' ')
        .replace(/\b(?:19|20)\d{2}\b/g, ' ')
        .replace(/\b\d+(?:\.\d+)?\s*([BbMmKk])\b/g, (match, unit, offset, surface) => {
            // Lowercase m is a length only in an explicit spatial error report.
            // A later parameter-count label must not borrow an earlier MAE.
            const before = surface.slice(0, offset).split(/[。！？!?；;\n]/u).pop();
            const physicalError = /(?:房间尺寸|房间维度|位置|定位|距离|长度)[^。！？!?；;\n]{0,100}(?:平均绝对误差|均方根误差|MAE|RMSE)/iu.exec(before);
            const count = [...before.matchAll(/参数(?:量|规模|个数)?|parameter(?:s)?|params?\b/giu)].pop();
            return unit === 'm' && physicalError && (!count || count.index < physicalError.index)
                && !/^\s*(?:参数|(?:parameters?|params?)\b)/iu.test(surface.slice(offset + match.length)) ? match : ' ';
        })
        .replace(/\b(?:v|ver(?:sion)?\.?)[-_ ]?\d+(?:\.\d+)*\b/gi, ' ')
        .replace(/\b[A-Za-z][A-Za-z0-9_-]*[-_]\d+(?:\.\d+)+(?:[-_][A-Za-z0-9.]+)?\b/g, ' ')
        .replace(/\b(?:Qwen|Llama|Gemma|Phi|GPT|Claude|Mistral|Whisper|HuBERT|WavLM|Wan|LTX)\s*[-_ ]?\d+(?:\.\d+)*(?:\s*[BbMmKk])?\b/gi, ' ');
}

function hasCoreSummaryComparisonDirection(sentence, numbers, sourceText = '') {
    // 示意图里的 "from inputs to outputs" 是映射关系，不是实测提升。
    // 数字上的变化必须写明起始值。
    const directionSurface = sentence.replace(/\bfrom\b([^。！？!?]{0,50})\bto\b/gi,
        (match, between) => /\d/.test(between) ? match : ' ');
    if (hasPrefixedCoreMetricComparison(sentence, sourceText) || hasConditionalMetricDeltaDirection(sentence) || hasBoundFormerLatterComparison(sentence) || hasBoundDisjointIntervalComparison(sentence) || CORE_SUMMARY_COMPARISON_PATTERN.test(directionSurface)
        || /(?:从|由)[^。！？!?]{0,40}(?:升至|升到|降至|降到|提升至|提高到)/.test(sentence)) return true;
    // 比字比较的指标必须和高/低差值处在同一分句，且紧邻比较关系。
    // 指标在左侧时，右侧须以明确比较对象结尾，避免借别处的 UAR 给参数量差背书。
    const metricAtEnd = new RegExp(`(?:${CORE_SUMMARY_METRIC_PATTERN.source})\\s*$`, 'i');
    for (const clause of sentence.split(/[，,；;。！？!?\n]/)) {
        const comparison = clause.match(/^(.*?)比(?!例|值|较|特|率|重)([^，,；;。！？!?\n]{1,60}?)(?:高|低)(?:了|出)?\s*[+-]?\d/);
        if (!comparison) continue;
        const [, before, after] = comparison;
        // 两边都紧邻明确指标时，不能把 UAR 与 WER 等不同指标相减。
        // “指标/分数/得分”只是指标名的后缀，比较的是其前面的完整名称。
        const adjacentMetric = surface => metricAtEnd.exec(surface.trim()
            .replace(/(?:指标|分数|得分)\s*$/, ''))?.[0].trim().toLowerCase();
        const leftMetric = adjacentMetric(before);
        const rightMetric = adjacentMetric(after);
        if (leftMetric && rightMetric && leftMetric !== rightMetric) continue;
        const boundMetric = metricAtEnd.test(after.trim())
            || (metricAtEnd.test(before.trim().replace(/计\s*$/, ''))
                && /(?:模型|方法|系统|基线|对照|算法|方案|编码器|表示)\s*$/.test(after.trim().replace(/分别\s*$/, '')));
        if (boundMetric && !hasCrossMetricDirectionalComparison(clause.replace(/比(?!例|值|较|特|率|重)/g, '高于'))) return true;
    }
    // Duration means and descriptive opinion means are outcomes, unlike a
    // runtime window. Bind both values to this same quantity and named arms.
    if (!/(?:假设|如果|预计|未来|并未|没有|不是|引用|第三方|他人|相关工作)/u.test(sentence)) {
        const mean = /((?:目标字|字符|音节|音素|单词)时长(?:均值|平均值)|自然度平均意见分)的基线\s*(\d+(?:\.\d+)?)\s*(ms)?(?:变为|对)本文方法\s*(\d+(?:\.\d+)?)\s*(ms)?[，,]\s*(?:增幅为\s*(\d+(?:\.\d+)?)%|本文方法略(低|高))/u.exec(sentence);
        if (mean && (mean[1] === '自然度平均意见分' ? !mean[3] && !mean[5] : mean[3] === 'ms' && mean[5] === 'ms')) {
            const a = Number(mean[2]), b = Number(mean[4]);
            if (mean[6] ? a > 0 && b > a && Math.abs((b / a - 1) * 100 - Number(mean[6])) < 0.1
                : mean[7] === '低' ? b < a : b > a) return true;
        }
    }
    // “基线为 12.4%，本文方法降至 9.8%”省略“从/由”，仍写明了起始值、终止值及各自对应的方法；
    // “相对基线 12.4% 升至 9.8%”仍没有独立命名终点，不能仅凭两个数字通过。
    return numbers.length >= 2 && CORE_SUMMARY_BARE_TRANSITION_PATTERN.test(sentence)
        && /(?:基线|对照)[^，；。]{0,80}[，；][^。]{0,80}(?:本文方法|本方法|所提方法|完整模型)[^。]{0,40}(?:升至|降至)/.test(sentence);
}

function hasCoreSummaryStatisticalResult(sentence) {
    // 率比和几率比也是实测结果。只认带数值、区间和实测说明的报告，
    // 不把公式示例、先验设置或文献介绍当成本篇研究的发现。
    const metric = /(?<![A-Za-z0-9_])(?:rate|odds|risk)\s+ratio(?![A-Za-z0-9_])|率比|几率比|比值比|优势比|风险比/i;
    if (!metric.test(sentence)
        || /\b(?:prior|hyperparameters?|hypothetical|illustrative|formula|defined?|assum(?:e|ed)|previous\s+stud(?:y|ies)|cited|references?)\b|先验|超参数|假设值|示意|公式|定义|文献引用|既有研究/i.test(sentence)) return false;
    const metricValue = new RegExp(`(?:${metric.source})\\s*(?:\\((?:IRR|RR|OR)\\)\\s*)?(?:of|=|:|为|是)?\\s*[-+]?\\d+(?:\\.\\d+)?`, 'i');
    const interval = /(?:\b(?:confidence\s+interval|CI)\b|置信区间)[^。！？!?\n]{0,20}\d+(?:\.\d+)?\s*(?:[-–—至]|\bto\b)\s*\d+(?:\.\d+)?/i;
    const observed = /\b(?:adjusted|estimated|observed|reported|interaction|association)\b|调整后|经[^。！？!?\n]{0,20}调整|估计|观测|实测|交互项|组别效应/i;
    return metricValue.test(sentence) && interval.test(sentence) && observed.test(sentence);
}

function hasCoreSummaryQuantitativeEvidence(text) {
    return String(text || '').split(/[。！？!?\n]/).some(rawSentence => {
        const sentence = stripCoreSummaryNonResultNumerals(stripSymbolicPatternRelation(rawSentence.trim()));
        if (!sentence) return false;
        const numbers = sentence.match(CORE_SUMMARY_NUMBER_PATTERN) || [];
        if (!numbers.length) return false;
        if (hasCoreSummaryStatisticalResult(sentence)) return true;
        const hasComparisonObject = CORE_SUMMARY_COMPARISON_OBJECT_PATTERN.test(sentence);
        const hasDirection = hasCoreSummaryComparisonDirection(sentence, numbers);
        // 音乐论文里的 "score(s)" 通常指乐谱而不是评价指标；"performance"
        // 也可能指实际演奏的音频。这些通用英文词只有在句子明确把它们
        // 和数值或方向绑在一起时，才算结果指标。
        const withoutGenericEnglishMetrics = sentence.replace(
            new RegExp(CORE_SUMMARY_GENERIC_ENGLISH_METRIC_PATTERN.source, 'gi'), ' '
        );
        const hasSpecificMetric = CORE_SUMMARY_METRIC_PATTERN.test(withoutGenericEnglishMetrics)
            || CORE_SUMMARY_CONFERENCE_METRIC_PATTERN.test(withoutGenericEnglishMetrics)
            || CORE_SUMMARY_VERTEX_GESTURE_METRIC_PATTERN.test(withoutGenericEnglishMetrics);
        const hasExplicitGenericMetric = CORE_SUMMARY_GENERIC_ENGLISH_METRIC_PATTERN.test(sentence)
            && (hasDirection || /(?<![A-Za-z0-9_])(?:scores?|performance|metrics?)(?![A-Za-z0-9_])[^。！？!?\n]{0,24}\b(?:is|are|was|were|at|of)\b\s*[-+]?\d/i.test(sentence));
        const nonOperationalSentence = sentence.replace(
            new RegExp(CORE_SUMMARY_OPERATIONAL_PARAMETER_PATTERN.source, 'gi'), ' ');
        const nonOperationalWithoutGeneric = nonOperationalSentence.replace(
            new RegExp(CORE_SUMMARY_GENERIC_ENGLISH_METRIC_PATTERN.source, 'gi'), ' '
        );
        const hasNonOperationalMetric = CORE_SUMMARY_METRIC_PATTERN.test(nonOperationalWithoutGeneric)
            || CORE_SUMMARY_CONFERENCE_METRIC_PATTERN.test(nonOperationalWithoutGeneric)
            || CORE_SUMMARY_VERTEX_GESTURE_METRIC_PATTERN.test(nonOperationalWithoutGeneric)
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

function classifyGenericSourceQuantitativeEvidence(sourceText, sentences = null) {
    if (!sourceText) return null;
    if (sourceHasMeasuredMetricTable(sourceText) || sourceCorpusCurationResult(sourceText)
        || sourceHasObservedOutcomeComparison(sourceText)) return true;
    const values = Array.isArray(sentences) ? sentences : String(sourceText).trim()
        .split(/[。！？!?\n]|\.(?=\s+[A-Z][A-Za-z]|$)/)
        .map(sentence => sentence.trim()).filter(Boolean);
    return values.some((sentence, index) => {
        // A sentence explicitly framed as other work or a hypothetical setup
        // is not an observation by this paper. Do not let adjacent PDF columns
        // supply its missing result role.
        let observedSentence = sentence;
        if (/^\s*(?:(?:prior|previous|earlier|related)\s+(?:work|research|stud(?:y|ies))\b|(?:hypothetical(?:ly)?|assuming|suppose|if)\b|(?:we|the authors)\s+(?:plan|hypothesi[sz]e|assume)\b)/iu.test(sentence)) {
            // A real observation can follow the earlier/hypothetical clause in
            // the same PDF sentence. Only an explicit own evaluation plus an
            // observed predicate establishes that turn, never a metric alone.
            const turn = /(?:;\s*(?:(?:whereas|but|however|in contrast)\s*,?\s*)?|,\s*(?:whereas|but|however|in contrast)\s*,?\s*)(?:(?:in|during)\s+our\s+(?:actual\s+)?(?:evaluation|experiments?|measurements?)\s*,?\s+(?:our\s+(?:model|method|system|approach)|we)\s+(?:actually\s+)?(?:measured|achieved|obtained|observed|found|yielded)|our\s+actual\s+(?:evaluation|experiments?|measurements?)\s+(?:measured|showed|found|demonstrated|observed|yielded)|we\s+actually\s+(?:measured|observed|obtained|achieved))\b/iu.exec(sentence);
            if (!turn) return false;
            observedSentence = sentence.slice(turn.index + 1).trim();
            if (/['"“”‘’]/u.test(sentence) || /\b(?:no|not|never|hypothetical(?:ly)?|assuming|would|might|could|planned|retracted|withdrawn|incorrect|false)\b|\b(?:according\s+to|other\s+authors?|reported\s+by)\b/iu.test(observedSentence)) return false;
        }
        // These are input controls, including when PDF columns put an unrelated
        // metric name on the same extracted line. Keep any actual outcome values.
        const resultSentence = require('./lib/core-symbolic-source-numerals').stripDefinedGeometryNumerals(
            stripSymbolicPatternRelation(observedSentence))
            // Page/DOI metadata, symbolic sample indices and channel-format
            // labels are not measured outcomes, even after PDF columns merge.
            // Remove only these typed tokens; a real result in the same clause
            // must keep its number and still be classified normally.
            .replace(/\b\d{1,5}[ \t]+(?=10\.\d{4,9}\/)/gu, ' ')
            .replace(/\b10\.\d{4,9}\/[^\s]+/gu, ' ')
            .replace(/(\b[A-Za-z]_?([A-Za-z])\s*,\s*\2\s*(?:∈|:|=)\s*)\[\s*1\s*,\s*[A-Za-z]\s*\]/gu, '$1[index range]')
            .replace(/\(\s*[1-9][0-9]*\s*-\s*ch\s*\)/giu, '(channel format)')
            .replace(/\b(?:source\s+)?sweeps?\s+[−+-]?\d+(?:\.\d+)?[◦°]\s*[→↔]\s*[−+-]?\d+(?:\.\d+)?[◦°]/giu, ' ')
            .replace(/\bthe other\s+[−+-]?\d+(?:\.\d+)?[◦°]\s*[→↔]\s*[−+-]?\d+(?:\.\d+)?[◦°]/giu, ' ')
            .replace(/\brandom\s+SNR\s+(?:between|from)\s+[−+-]?\d+(?:\.\d+)?\s+(?:and|to)\s+[−+-]?\d+(?:\.\d+)?\s*dB\b/giu, ' ');
        const localContext = values.slice(Math.max(0, index - 1), Math.min(values.length, index + 2)).join(' ');
        const widerBenchmarkContext = values.slice(Math.max(0, index - 4), Math.min(values.length, index + 3)).join(' ');
        const wrappedNextLine = [resultSentence, values[index + 1] || ''].join(' ');
        const hasBenchmarkContext = /(?:experiment|evaluation|result|benchmark|test set|dataset|table|metric|实验|评测|结果|基准|测试集|数据集|表格|指标)/i
            .test(localContext);
        // Benchmark-grounded multiplicative speedups (e.g. "achieves approximately 5.4× faster\ntraining compared to FS")
        // are genuine measured quantitative comparisons when accompanied by benchmark/table context within ~4 PDF lines.
        if (/(?:experiment|evaluation|result|benchmark|test set|dataset|table|metric|实验|评测|结果|基准|测试集|数据集|表格|指标)/i.test(widerBenchmarkContext)
            && /\b(?:achieves?|attains?|obtains?|delivers?|provides?|shows?|yields?|reaches?|runs?)\b[^。！？!?\n]{0,48}\d+(?:\.\d+)?\s*(?:×|x)\s*(?:faster|slower|speedup)\b/i.test(resultSentence)
            && /\b(?:compared\s+(?:with|to)|versus|vs\.?|over|than)\b/i.test(wrappedNextLine)) {
            return true;
        }
        if (!hasCoreSummaryQuantitativeEvidence(resultSentence)) return false;
        return hasBenchmarkContext
            // Explicit own measured metric comparisons (e.g. "It attains the low-\nest error rates (CER 4.08%, WER 13.11% versus ...)")
            // are direct quantitative results even when 2-column PDF wrapping splits the verb onto the preceding line.
            || (/\b(?:attains?|achieves?|obtains?|yields?|outperforms?)\b/i.test(localContext)
                && !/\b(?:(?:prior|previous|earlier|related)\s+(?:work|stud(?:y|ies))|hypothetical(?:ly)?|assuming|suppose)\b/i.test(localContext)
                && /\b(?:versus|vs\.?|compared\s+(?:with|to)|outperforming)\b/i.test(observedSentence)
                && /\b(?:CER|WER|MOS|PESQ|STOI|SI-SDR|SDR|EER|UAR|F1|BLEU|ROUGE|FAD|CLAP|MCD|PSNR|SSIM|AUROC|AUC|mAP|accuracy|error\s+rates?)\b/i.test(observedSentence))
            // 听测结果须明确本方法、实测指标和已发生的数值变化。
            // 人数、量表、音频时长、预测及转述的旧工作不能用这条规则通过。
            || /^In (?:a|our) listening study\b[^,.;]{0,100},\s*(?:our|the proposed|this|region[- ]aware)\s+(?:method|model|system|approach|masking)\s+(?:reduces?|lowers?|improves?|increases?)\s+(?:the\s+)?(?:perceived\s+accent|accent\s+(?:ratings?|scores?))\s+from\s+[+-]?\d+(?:\.\d+)?\s+to\s+[+-]?\d+(?:\.\d+)?\b/i.test(observedSentence)
                && /\b(?:baseline|control|reference)\b/i.test(observedSentence)
            || hasCoreSummaryStatisticalResult(observedSentence)
                && /\b(?:adjusted|mixed[- ]effects?|count\s+models?|interaction|groups?)\b|调整后|计数模型|交互项|组别/i.test(localContext);
    }) || hasSourceMeasuredLossComparison(values);
}

function classifySourceQuantitativeEvidence(sourceText, sentences = null) {
    const generic = classifyGenericSourceQuantitativeEvidence(sourceText, sentences);
    return generic === true || sourceSoftwareFunctionalValidationResult(sourceText)
        || sourceMeasuredPlannerSelection(sourceText) ? true : generic;
}

function stripDuplicatedLineFootnoteMarkers(text) {
    return String(text || '').replace(
        /([^\d\r\n])[ \t]+(\d{1,3})\r?\n[ \t]*(\d{1,3})[ \t]*(?=\r?\n|$)/g,
        (match, preceding, inline, standalone) => (
            inline === standalone || inline === `${standalone}${standalone}` ? preceding : match
        )
    );
}

function coreSummaryQuantitativeResultState(text, sourceText = null, definedAcronyms = []) {
    const correctionRates = sourceBoundCorrectionRateObservations(text, sourceText);
    const rawSentences = String(text || '').split(/[。！？!?\n]/);
    const candidates = rawSentences.map((rawSentence, sentenceIndex) => {
        const sentence = stripCoreSummaryNonResultNumerals(rawSentence.trim());
        const retrievalComparison = hasSourceBoundTextVideoComparison(rawSentence, sourceText,
            rawSentences.slice(0, sentenceIndex).join('\n'), rawSentences.slice(sentenceIndex + 1).find(part => part.trim()) || '');
        const bayesianGroupResult = hasSourceBackedBayesianGroupResult(sentence, sourceText);
        const plannerSelection = sourceBoundPlannerSelectionResult(sentence, text, sourceText);
        // CLAP 既可能指指标，也可能指对照模型。写明 model/baseline
        // 不能顶替缺失的结果指标。
        const metricText = sentence.replace(/(?:\bCLAP\s*(?:基线|模型|baseline\b|model\b)|\bNLL\s*(?:基线|模型|方法|baseline\b|model\b|method\b)|(?<![A-Za-z0-9_])(?:TNR|TPR|LSD|ILD[ -]+error|Human[ ]+S)\s*(?:基线|模型|方法|baseline\b|model\b|method\b))/giu, '');
        // Only this newly admitted metric family removes its attached generic
        // label too: a hypothetical "Fmeter指标" cannot survive as bare 指标.
        // Keep the pre-existing generic/other-metric acceptance domain intact.
        const additionalDenied = /\b(?:if|suppose|assuming|hypothetical|(?:future|planned|proposed)\s+experiments?|not\s+(?:observed|reported)|(?:previous|prior|related|other)\s+(?:work|stud(?:y|ies)|research)|third[- ]party|quoted|retracted)\b|(?:假设|假想|假定|设想|如果|若(?:在|用|以)|可能|预计|预期|(?:未来|后续)(?:计划|实验|评测|测量)|计划(?:比较|评估|测量|报告)|讨论|提及|引用|引述|转述|他人|第三方|其他研究|先前(?:工作|研究)|旧(?:工作|研究)|既有(?:工作|研究)|相关(?:工作|研究)|并非|并未|不是|没有|不能|尚未|否认|撤回|不成立|未报告|未观察)/iu.test(sentence);
        const additionalMention = new RegExp(String.raw`(?<![A-Za-z0-9_])${CORE_SUMMARY_ADDITIONAL_METRIC_NAME.source}(?![A-Za-z0-9_.-])(?:[ \t]*(?:(?:的|为|是|作为|用作)[ \t]*)?(${CORE_SUMMARY_ADDITIONAL_MODEL_SUFFIX}))?(?:[ \t]*(?:指标|分数|得分))?`, 'giu');
        const measuredMetricText = metricText.replace(additionalMention, (match, model) => additionalDenied || model ? ' ' : match);
        // The admitted CCC and source-native aliases lose metric status in an
        // explicitly hypothetical, denied, quoted or foreign result clause.
        // "未来表示" is an observed input type, not a future experiment.
        const admittedMetricText = /\b(?:if|suppose|assuming|hypothetical|(?:future|planned|proposed)\s+experiments?|not\s+(?:observed|reported)|third[- ]party|quoted|retracted)\b|(?:假设|假想|假定|设想|如果|若(?:在|用|以)|可能|预计|预期|(?:未来|后续)(?:计划|实验|评测|测量)|计划(?:比较|评估|测量|报告)|讨论|提及|引用|引述|转述|他人|第三方|其他研究|先前研究|相关工作|并非|并未|不是|没有|不能|尚未|否认|撤回|不成立|未报告|未观察|(?:未|没有|不)(?:能|曾|实际|真正)?(?:测量|报告|观察到|观察|检验|比较))/iu.test(sentence)
            ? measuredMetricText.replace(/(?<![A-Za-z0-9_])CCC(?![A-Za-z0-9_])|一致性相关系数/giu, ' ')
            : measuredMetricText;
        const hasRecognizedMetric = Boolean(sentence && (
            CORE_SUMMARY_METRIC_PATTERN.test(admittedMetricText.replace(
                /(?<![A-Za-z0-9_.-])DNSMOS(?:[ \t]+P\.835)?(?:[ \t]+(?:SIG|BAK|OVL)(?:\/(?:SIG|BAK|OVL))*)?(?![A-Za-z0-9_.-])(?:[ \t]*(?:指标|分数|得分))?/giu, ' '))
            || CORE_SUMMARY_ADDITIONAL_METRIC_PATTERN.test(admittedMetricText)
            || matchesDefinedMetricAcronyms(admittedMetricText, definedAcronyms)
            || hasSourceDefinedDnsMos(sourceText) && hasAffirmativeDnsMosStatement(
                rawSentence, CORE_SUMMARY_DNSMOS_PATTERN,
                rawSentences[sentenceIndex - 1] || '', rawSentences[sentenceIndex + 1] || '')
            || CORE_SUMMARY_CONFERENCE_METRIC_PATTERN.test(admittedMetricText)
            || !/(?:假设|假想|如果|预计|预期|可能|计划|未来|引用|引述|转述|他人|第三方|其他研究|先前研究|相关工作|并非|并未|不是|没有|尚未|未报告|否认|撤回|不成立|错误说法)|\b(?:hypothetical|assuming|if|planned|quoted|third[- ]party|not reported)\b/iu.test(sentence)
                && CORE_SUMMARY_VERTEX_GESTURE_METRIC_PATTERN.test(sentence)
            || hasCoreSummaryStatisticalResult(metricText) || bayesianGroupResult || plannerSelection || correctionRates[sentenceIndex]?.metric
            || hasSourceBoundHitCountMetric(sentence, sourceText)
        ));
        const numericSentenceSurface = definedAcronyms.length
            ? stripDefinedMetricAcronymNumbers(sentence, definedAcronyms)
            : sentence;
        const numbers = numericSentenceSurface.match(CORE_SUMMARY_NUMBER_PATTERN) || [];
        const hasDirection = Boolean(sentence
            && (hasCoreSummaryComparisonDirection(sentence, numbers, sourceText) || plannerSelection || correctionRates[sentenceIndex]?.direction || retrievalComparison));
        // 会议原文常把具体划分写成“AliMeeting远场集”或“VoxAngeles未见语言集”，
        // 这算真实的评测设置，尽管里面既没有“数据集”三个字，也没有
        // `test/benchmark` 这样的英文词。只接受带明确设置后缀的拉丁文命名标识；
        // 上面那套通用设置词表不变。
        const hasNamedSetting = /(?:[A-Z][A-Za-z0-9._-]{2,}\s*[\u3400-\u9fff]{0,8}(?:集|数据集|语料|任务|基准)|(?:在|于)\s*[A-Z][A-Za-z0-9._-]{2,}(?:\s*[上中下]))/i.test(sentence);
        const hasTimedNamedSplit = /(?:在|于)\s*[A-Z][A-Za-z0-9._-]{2,}\s+\d+(?:\.\d+)?\s+s\s+[\u3400-\u9fff]{0,12}划分(?:上|中)/.test(sentence);
        const narrowMeasuredResult = hasRecordedDissonanceComparison(sentence) || hasMeanRoomSimulationComparison(sentence);
        const hasMeasuredCrossValidation = !/(?:假设|假想|如果|若在|预计|预期|可能|计划|未来|并非|不是|未进行|未做|没有)/u.test(sentence)
            && /(?:在|于)[^。！？!?\n]{1,160}(?:[1-9][0-9]*|[一二两三四五六七八九十]+)折交叉验证(?:下|中|上)/u.test(sentence);
        const hasSetting = hasMeasuredCrossValidation || narrowMeasuredResult || /(?:数据集|测试集|验证集|基准|评测|评价|协议|设置|条件|场景|任务|语料|套件|主干|对照|数据点|样本点|观测(?:点|值)|语言|口音|性别|选项顺序|码切换|单语|多语|语言对|组合|同一|相同|公开|内部|外部|\b(?:on|test|benchmark|evaluation)\b)/i.test(sentence)
            || hasNamedSetting || retrievalComparison
            || /(?<![A-Za-z0-9_])[1-9][0-9]*[A-Za-z][A-Za-z0-9._-]{0,39}-(?:Bench|Benchmark)(?![A-Za-z0-9_])(?:上|中|下)/i.test(rawSentence) || hasTimedNamedSplit || hasConcreteCoreSummarySetting(sentence, sourceText)
            || hasCountedEvaluationScope(sentence, sourceText)
            || /(?:在|于)\s*FLEURS(?![A-Za-z0-9_])(?:[\u3400-\u9fff]{1,8}(?:到|→)[\u3400-\u9fff]{1,8}(?:上|中)|[^，,；;。！？!?\n]{0,60}(?:oracle提交决策|校准评测)上下文(?:上|中))/.test(sentence);
        const hasComparisonObjects = numbers.length >= 2
            || /(?:基线|对照|相比|相较|原方法|已有方法|先前方法|本文方法|移除|完整模型|竞品)/.test(sentence);
        // 只补原文中实际使用的结果写法，不把同名方法或公式符号算作指标。
        const fadComparison = /(?<![A-Za-z0-9_])FAD(?![A-Za-z0-9_])\s*[）)]?\s*(?:为|是|=|:|：)?\s*(\d+(?:\.\d+)?)(?=\s*(?:[,，;；、]|优于|低于|高于))[^。！？!?]{0,50}?(优于|低于|高于)([^。！？!?\d]{0,50})(?:(?<![A-Za-z0-9_.])|(?<=FAD))(\d+(?:\.\d+)?)(?=\s*(?:[,，;；、]|$))/.exec(sentence);
        const fadNumbersAgree = Boolean(fadComparison && (fadComparison[2] === '高于'
            ? Number(fadComparison[1]) > Number(fadComparison[4])
            : Number(fadComparison[1]) < Number(fadComparison[4])));
        const fadValue = fadNumbersAgree && !/FAD\s*(?:模型|方法|基线)/.test(sentence);
        const dirComparison = /(?<![A-Za-z0-9_])DIR@FAR\s*=\s*(\d+(?:\.\d+)?)%\s*(?:从|由)\s*(\d+(?:\.\d+)?)%\s*(?:提升到|提升至|提高到|提高至|升至|升到|降至|降到|降低至|降低到)\s*(\d+(?:\.\d+)?)%(?=\s*(?:[,，;；、]|$))/.exec(sentence);
        const dirResult = Boolean(dirComparison && dirComparison.slice(1).every(value => Number(value) <= 100)
            && (/提升|提高|升至|升到/.test(dirComparison[0])
                ? Number(dirComparison[3]) > Number(dirComparison[2])
                : Number(dirComparison[3]) < Number(dirComparison[2])));
        const addedComparison = /(?<![A-Za-z0-9_])(?:FAD(?![A-Za-z0-9_])\s*[）)]?\s*(?:为|是|=|:|：)?\s*\d+(?:\.\d+)?|DIR@FAR\s*=\s*\d+(?:\.\d+)?%)[^。！？!?]{0,90}?(?:优于|低于|高于|提升到|提升至|提高到|提高至|升至|升到|降至|降到|降低至|降低到)([^。！？!?\d]{0,50})\d/.exec(sentence);
        const comparedLabel = String(addedComparison?.[1] || '').replace(/(?:指标|分数|得分)/g, '');
        const addedMetricHasConflictingLabel = Boolean(comparedLabel && (
            CORE_SUMMARY_METRIC_PATTERN.test(comparedLabel)
            || CORE_SUMMARY_CONFERENCE_METRIC_PATTERN.test(comparedLabel)));
        const addedMetricIsNonResult = /(?:公式|符号|定义为|假设|预计|预期|可能|将会|若|如果|先前工作|相关工作|文献)/.test(sentence);
        const fadComparisonObjectIsValue = /(?:^$|(?:的|为|是|=|:|：|基线|对照|FAD)\s*$)/.test(String(fadComparison?.[3] || '').trim());
        const hasMetric = narrowMeasuredResult || hasRecognizedMetric || Boolean(hasSetting && hasDirection
            && hasComparisonObjects && !addedMetricHasConflictingLabel
            && !addedMetricIsNonResult && ((fadValue && fadComparisonObjectIsValue) || dirResult));
        const crossMetricComparison = hasCrossMetricDirectionalComparison(sentence)
            || addedMetricHasConflictingLabel;
        const missing = [
            !hasSetting && '评测设置', !hasMetric && '指标名称',
            numbers.length === 0 && '数值', !hasDirection && '比较方向',
            !hasComparisonObjects && '比较对象',
            crossMetricComparison && '指标口径一致（方向连接词两侧不能是不同指标）'
        ].filter(Boolean);
        return {
            complete: Boolean(sentence) && missing.length === 0,
            sentenceNumber: sentenceIndex + 1,
            missing,
            hasNumbers: numbers.length > 0,
            signalCount: Number(hasSetting) + Number(hasMetric) + Number(numbers.length > 0)
                + Number(hasDirection) + Number(hasComparisonObjects)
        };
    });
    if (candidates.some(candidate => candidate.complete)) return { complete: true, missing: [] };
    const candidateIssues = candidates.filter(candidate => candidate.hasNumbers)
        .map(candidate => ({ sentenceNumber: candidate.sentenceNumber, missing: candidate.missing }));
    const best = candidates.sort((left, right) => right.signalCount - left.signalCount
        || Number(right.hasNumbers) - Number(left.hasNumbers))[0];
    return { complete: false, candidateIssues, missing: best?.missing || [
        '评测设置', '指标名称', '数值', '比较方向', '比较对象'
    ] };
}

function nearestCoreSummaryMetricLabel(segment, fromRight) {
    const candidates = [];
    for (const match of String(segment || '').matchAll(new RegExp(CORE_SUMMARY_DNSMOS_PATTERN.source, 'giu'))) {
        candidates.push({ index: match.index, value: 'dnsmos-' + match[0].split(/[ \t]+/u).at(-1).toLowerCase() });
    }
    for (const match of String(segment || '').matchAll(new RegExp(CORE_SUMMARY_VERTEX_GESTURE_METRIC_PATTERN.source, 'giu'))) {
        const key = /(?:LVE|lip|唇)/iu.test(match[0]) ? 'lve'
            : /(?:MVE|mean|全脸)/iu.test(match[0]) ? 'mve'
                : /(?:fr[eé]chet|gesture)/iu.test(match[0]) ? 'fgd' : 'bc';
        candidates.push({ index: match.index, value: key });
    }
    for (const match of String(segment || '').matchAll(/(?<![A-Za-z0-9_])(WER|CER|DER|MAE|RMSE|MOS|FGD|BC)(?![A-Za-z0-9_])(?=\s*(?:(?:指标|分数|得分))?(?:(?:为|是|=)\s*)?[-+]?\d)/giu)) {
        candidates.push({ index: match.index, value: match[1].toLowerCase() });
    }
    const local = fromRight ? String(segment || '') : String(segment || '').split(/[，,；;]/u)[0];
    for (const match of local.matchAll(new RegExp(CORE_SUMMARY_ADDITIONAL_METRIC_PATTERN.source, 'giu'))) {
        if (!fromRight && /(?<![A-Za-z0-9_.])\d+(?:\.\d+)?(?![A-Za-z0-9_.])/u.test(local.slice(0, match.index))) continue;
        const key = match[0].replace(/决定系数\s*/u, '').replace(/\^2/u, '²').toLowerCase() || 'r²';
        candidates.push({ index: match.index, value: key });
    }
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

function coreSummarySentenceView(text, sourceText) {
    // 方法名内的感叹号不是句末；只保护原文确有同名且后接中文衔接词的写法。
    return String(text || '').replace(/(?<![A-Za-z0-9_])([A-Z][A-Za-z0-9_-]{0,39}(?:[ \t]+[A-Za-z][A-Za-z0-9_-]{0,39}){0,3})!(?=的|切分|分割|进行|用于|作为|生成|输出)/gu, (match, name) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?<![A-Za-z0-9_])${escaped}!(?![A-Za-z0-9_])`, 'u').test(String(sourceText || ''))
            ? match.slice(0, -1) + '\uE000' : match;
    });
}

const EXECUTIVE_ABSTRACT_BOLD_LEAD_RE = /^\s*(?:\*\*[^*\n]{2,36}[：:]\*\*[ \t]*|\*\*[^*\n]{2,36}\*\*[ \t]*[：:][ \t]*)/u;

function stripExecutiveAbstractBoldLeadIns(rawSummary) {
    return String(rawSummary || '')
        .split(/\r?\n[ \t]*\r?\n/u)
        .map(paragraph => paragraph.trim().replace(EXECUTIVE_ABSTRACT_BOLD_LEAD_RE, '').trim())
        .filter(Boolean)
        .join('\n\n');
}

function validateExecutiveAbstractSurfaceStructure(rawSummary) {
    const raw = String(rawSummary || '');
    const issues = [];
    if (/^\s*#{1,6}\s/mu.test(raw)) {
        issues.push('核心摘要内禁止使用 # 等 Markdown 标题，请改用段首粗体引导词');
    }
    if (/^\s*\d+\.\s*\*\*[^*\n]+\*\*\s*$/mu.test(raw)) {
        issues.push('核心摘要内禁止使用独立编号标题行（如 1. **...**），请直接以粗体引导词开启自然段');
    }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/mu.test(raw)) {
        issues.push('核心摘要内禁止使用水平分隔线');
    }
    const trimmed = raw.trim();
    if (/\r?\n(?:[ \t]*\r?\n){2,}/u.test(trimmed)) {
        issues.push('核心摘要自然段之间只能保留一个空行（\\n\\n）');
    }
    const paragraphs = trimmed ? trimmed.split(/\r?\n[ \t]*\r?\n/u).map(p => p.trim()).filter(Boolean) : [];
    if (paragraphs.length < CORE_SUMMARY_MIN_PARAGRAPHS || paragraphs.length > CORE_SUMMARY_MAX_PARAGRAPHS) {
        issues.push(`自然段数必须为 ${CORE_SUMMARY_MIN_PARAGRAPHS}–${CORE_SUMMARY_MAX_PARAGRAPHS} 段（以空行分隔），当前 ${paragraphs.length} 段`);
    } else {
        if (paragraphs.some(paragraph => /\r?\n/u.test(paragraph))) {
            issues.push('核心摘要每个自然段须写成连贯散文段落，段间以空行分隔，段内不拆行或列点');
        }
        if (!paragraphs.every(paragraph => EXECUTIVE_ABSTRACT_BOLD_LEAD_RE.test(paragraph))) {
            issues.push('核心摘要每个自然段须以粗体引导词开头（如 **问题与瓶颈：**）');
        }
    }
    return issues;
}

function hasExecutiveMethodArchitecture(contentBody) {
    const componentPattern = /(?:编码器|解码器|声码器|分词器|量化器|转换器|变换器|Transformer|Conformer|Mamba|UNet|扩散|流匹配|注意力|网络|主干|骨干|适配器|投影层|投影头|模块|分支|前端|后端|分类头|回归头|预测头|判别器|生成器|检索器|规划器|求解器|滤波器|估计器|识别器|合成器|谱均衡|引擎|探针|矩阵|子空间|表征|特征|嵌入|隐状态|隐变量|码本|令牌|token|掩码|掩膜|损失|目标函数|正则|采样器|蒸馏|知识图谱|大模型|智能体|工具链|后台工具|对话系统|管线|流水线|仿真器|模拟器|编排器|评测协议|评分准则|任务契约|评测基准|基准集|日志|录音|访谈|统计检验)/giu;
    const actionPattern = /(?:输入|接收|提取|编码|映射|投影|压缩|量化|池化|聚合|融合|拼接|注入|调制|对齐|检索|筛选|路由|分解|预测|估计|重构|重建|解码|合成|生成|输出|优化|更新|训练|微调|冻结|约束|抑制|消除|解耦|提炼|写入|记录|组装|重写|划分|扩展|调度|核查|实例化|计分|复核|刻画|校验|采集|整理|标注)/giu;
    const leadingContrastPrefix = /^(?:(?:与|跟|同|相比于?|相较于?|较之|不同于|区别于)[^，,。；;]{0,40}(?:现有|已有|传统|以往|先前|主流)[^，,。；;]{0,30}[，,]\s*)/u;
    const deniedSentence = /(?:假设|假想|假定|设想|如果|预计|预期|可能|未来实验|计划采用|第三方|他人研究|先前工作|相关工作|现有(?:主流|方法|方案|路线|编解码器|模型|系统|工作)|传统(?:方法|方案|路线|指标|编解码器|模型|系统|工作)|以往(?:方法|方案|路线|模型|工作|研究)|主流(?:方法|方案|路线|编解码器|模型)|任务需要将|任务以[^。]{1,48}为输入)/u;
    for (const paragraph of String(contentBody || '').split(/\n\s*\n/u)) {
        const sentences = paragraph.split(/[。！？!?\n]/u).map(s => s.trim()).filter(Boolean);
        const validSentences = sentences
            .filter(s => s.length <= CORE_SUMMARY_MAX_METHOD_SENTENCE_CHARS)
            .map(s => s.replace(leadingContrastPrefix, '').trim())
            .filter(s => s && !deniedSentence.test(s));
        if (!validSentences.length) continue;
        const joined = validSentences.join('。');
        const components = new Set([...joined.matchAll(componentPattern)].map(m => m[0].toLowerCase()));
        const actions = [...joined.matchAll(actionPattern)];
        if (components.size >= 2 && actions.length >= 3) return true;
    }
    return false;
}

function findOverlongExecutiveMethodSentence(contentBody) {
    const componentHint = /(?:编码器|解码器|声码器|分词器|量化器|Transformer|Conformer|注意力|网络|主干|模块|分支|前端|后端|表征|特征|嵌入|令牌|token)/iu;
    for (const paragraph of String(contentBody || '').split(/\n\s*\n/u)) {
        for (const sentence of paragraph.split(/[。！？!?\n]/u).map(s => s.trim()).filter(Boolean)) {
            if (sentence.length > CORE_SUMMARY_MAX_METHOD_SENTENCE_CHARS && componentHint.test(sentence)) {
                return sentence.length;
            }
        }
    }
    return 0;
}

function extractExecutiveParagraphDefinedMetricAcronyms(paragraph, sourceText, deniedWindowSentence) {
    const found = new Set();
    const defPattern = /(?:用|以|通过|采用)[^，,。；\n]{1,28}?(?:误差|差异|距离|偏差|失真|得分|分数|系数|比率|率|度|量|熵)[ \t]*([A-Z][A-Z0-9_-]{2,10})[ \t]*(?:衡量|评估|评测|度量|表征|量化)/gu;
    for (const sentence of String(paragraph || '').split(/[。！？!?\n]/u).map(s => s.trim()).filter(Boolean)) {
        if (deniedWindowSentence.test(sentence)) continue;
        for (const match of sentence.matchAll(defPattern)) {
            const acronym = match[1];
            const escaped = acronym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (sourceText && !new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'u').test(String(sourceText))) continue;
            found.add(acronym);
        }
    }
    return [...found];
}

function matchesDefinedMetricAcronyms(text, definedAcronyms = []) {
    for (const acronym of definedAcronyms) {
        const escaped = acronym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_.-]|[ \\t]*(?:(?:的|为|是|作为|用作)[ \\t]*)?${CORE_SUMMARY_ADDITIONAL_MODEL_SUFFIX})`, 'u');
        if (re.test(text)) return true;
    }
    return false;
}

function stripDefinedMetricAcronymNumbers(text, definedAcronyms = []) {
    let out = String(text || '');
    for (const acronym of definedAcronyms) {
        const escaped = acronym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'gu');
        out = out.replace(re, match => match.replace(/[-_.]?\d+(?:\.\d+)?/g, ''));
    }
    return out;
}

function sentenceHasExecutiveMetric(rawSentence, sourceText, definedAcronyms = []) {
    const cleaned = stripCoreSummaryNonResultNumerals(stripSymbolicPatternRelation(String(rawSentence || '').trim()));
    if (!cleaned) return false;
    const withoutModelLabels = cleaned.replace(/(?:\bCLAP\s*(?:基线|模型|baseline\b|model\b)|\bNLL\s*(?:基线|模型|方法|baseline\b|model\b|method\b)|(?<![A-Za-z0-9_])(?:TNR|TPR|LSD|ILD[ -]+error|Human[ ]+S)\s*(?:基线|模型|方法|baseline\b|model\b|method\b))/giu, '');
    const withoutGeneric = withoutModelLabels.replace(new RegExp(CORE_SUMMARY_GENERIC_ENGLISH_METRIC_PATTERN.source, 'gi'), ' ');
    return CORE_SUMMARY_METRIC_PATTERN.test(withoutGeneric)
        || CORE_SUMMARY_ADDITIONAL_METRIC_PATTERN.test(withoutGeneric)
        || CORE_SUMMARY_CONFERENCE_METRIC_PATTERN.test(withoutGeneric)
        || CORE_SUMMARY_VERTEX_GESTURE_METRIC_PATTERN.test(withoutGeneric)
        || matchesDefinedMetricAcronyms(withoutGeneric, definedAcronyms)
        || hasSourceDefinedDnsMos(sourceText) && CORE_SUMMARY_DNSMOS_PATTERN.test(rawSentence)
        || hasCoreSummaryStatisticalResult(withoutModelLabels)
        || hasSourceBoundHitCountMetric(cleaned, sourceText);
}

function sentenceHasExecutiveMetricAndResultNumber(rawSentence, sourceText, definedAcronyms = []) {
    const cleaned = stripCoreSummaryNonResultNumerals(stripSymbolicPatternRelation(String(rawSentence || '').trim()));
    if (!cleaned) return false;
    const nonOp = stripDefinedMetricAcronymNumbers(
        cleaned.replace(new RegExp(CORE_SUMMARY_OPERATIONAL_PARAMETER_PATTERN.source, 'gi'), ' '),
        definedAcronyms
    );
    const numbers = nonOp.match(CORE_SUMMARY_NUMBER_PATTERN) || [];
    if (numbers.length === 0) return false;
    return sentenceHasExecutiveMetric(rawSentence, sourceText, definedAcronyms);
}

function executiveSummaryQuantitativeResultState(contentBody, sourceText = null) {
    const direct = coreSummaryQuantitativeResultState(contentBody, sourceText);
    if (direct.complete) return direct;
    const allSentences = String(contentBody || '').split(/[。！？!?\n]/u).map(s => s.trim()).filter(Boolean);
    const deniedWindowSentence = /(?:假设|假想|假定|设想|如果|若在|预计|预期|可能|计划|未来|先前研究|相关工作|第三方|他人|引用|引述|转述|并非|并未|不是|未测|未报告|未进行)/u;
    const operationalClausePattern = /(?:\d+(?:\.\d+)?\s*(?:kbps|bps|kHz|MHz|Hz)\b|(?:训练|推理|部署|单卡|单核|多卡|冷启动|前瞻(?:窗口)?|首次编译|图编译|编译|显存|内存|硬件|参数(?:量|规模|开销)?|实时率|(?<![A-Za-z0-9_])RTF(?![A-Za-z0-9_])|延迟|(?<![A-Za-z0-9_])latency(?![A-Za-z0-9_])|吞吐|(?<![A-Za-z0-9_])throughput(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])FLOPs?(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])MACs?(?![A-Za-z0-9_]))[^，,；;。！？!?\n]{0,36})/giu;
    const explicitCounterpartPattern = /(?:基线|对照|相比|相较|原方法|已有方法|先前方法|竞品|移除|消融|完整模型|次优|(?<![A-Za-z0-9_])(?:baseline|versus|vs\.?)(?![A-Za-z0-9_])|(?:传统|主流|现有|以往)[^，,。；\n]{0,18}(?:方法|模型|系统|基线|代理|方案|编解码器)|与\s*[A-Za-z0-9\u4e00-\u9fa5_-]{2,30}\s*(?:相比|对照|对比|比较)|比较\s*\d+\s*个(?:系统|模型|方法)|(?:高于|低于|优于|超过|领先)(?:最优|最佳|最强|次优|经典|传统|内置|原生|原始|单一|基础|随机|零样本|微调前|基线|对照|同量|同规模)[^，,。；\n]{0,16}的)/iu;
    for (const paragraph of String(contentBody || '').split(/\n\s*\n/u)) {
        const sentences = paragraph.split(/[。！？!?\n]/u).map(s => s.trim()).filter(Boolean);
        const definedAcronyms = extractExecutiveParagraphDefinedMetricAcronyms(paragraph, sourceText, deniedWindowSentence);
        for (const windowSize of [1, 2, 3, 4]) {
            for (let index = 0; index + windowSize <= sentences.length; index++) {
                const windowParts = sentences.slice(index, index + windowSize);
                if (windowParts.some(part => deniedWindowSentence.test(part) || hasCrossMetricDirectionalComparison(part))) continue;
                const hasSameSentenceMetricComparison = windowParts.some(part =>
                    sentenceHasExecutiveMetricAndResultNumber(part, sourceText, definedAcronyms)
                    && CORE_SUMMARY_COMPARISON_PATTERN.test(part));
                const hasSplitMetricComparison = !hasSameSentenceMetricComparison
                    && windowParts.length >= 2
                    && windowParts.some(part => sentenceHasExecutiveMetric(part, sourceText, definedAcronyms))
                    && windowParts.some(part => {
                        if (!CORE_SUMMARY_COMPARISON_PATTERN.test(part)) return false;
                        const cleanedPart = stripDefinedMetricAcronymNumbers(
                            stripCoreSummaryNonResultNumerals(part)
                                .replace(operationalClausePattern, ' ')
                                .replace(new RegExp(CORE_SUMMARY_OPERATIONAL_PARAMETER_PATTERN.source, 'gi'), ' ')
                                .replace(new RegExp(CORE_SUMMARY_METRIC_PATTERN.source, 'gi'), match => match.replace(/\d+(?:\.\d+)?/g, '')),
                            definedAcronyms
                        );
                        return (cleanedPart.match(CORE_SUMMARY_NUMBER_PATTERN) || []).length >= 2;
                    });
                if (!hasSameSentenceMetricComparison && !hasSplitMetricComparison) continue;
                const combined = windowParts.join('，');
                if (!explicitCounterpartPattern.test(combined)) continue;
                const nonOpWindow = stripDefinedMetricAcronymNumbers(
                    stripCoreSummaryNonResultNumerals(combined)
                        .replace(operationalClausePattern, ' ')
                        .replace(new RegExp(CORE_SUMMARY_OPERATIONAL_PARAMETER_PATTERN.source, 'gi'), ' ')
                        .replace(new RegExp(CORE_SUMMARY_METRIC_PATTERN.source, 'gi'), match => match.replace(/\d+(?:\.\d+)?/g, '')),
                    definedAcronyms
                );
                const nonOpResultNumbers = nonOpWindow.match(CORE_SUMMARY_NUMBER_PATTERN) || [];
                if (nonOpResultNumbers.length < 2) continue;
                const windowState = coreSummaryQuantitativeResultState(combined, sourceText, definedAcronyms);
                if (windowState.complete) return { complete: true, missing: [], candidateIssues: [] };
            }
        }
    }
    if (allSentences.some(sentence => hasCrossMetricDirectionalComparison(sentence))) {
        return {
            complete: false,
            candidateIssues: direct.candidateIssues || [],
            missing: ['指标口径一致（方向连接词两侧不能是不同指标）']
        };
    }
    return direct;
}

function validateCoreSummarySourceGroundedClaims(summary, sourceText) {
    const srcRaw = String(sourceText || '').trim();
    if (!srcRaw) return null;
    const normalizeThousands = text => {
        let current = String(text || '');
        let prev = '';
        while (current !== prev) {
            prev = current;
            current = current
                .replace(/(?<=\d)\{,\}(?=\d{3}(?![0-9]))/gu, '')
                .replace(/(?<=\d),(?=\d{3}(?![0-9]))/gu, '');
        }
        return current;
    };
    const buildSurfaces = baseText => {
        const normalized = normalizeThousands(baseText);
        const texMerged = normalized
            .replace(/\\!/gu, '')
            .replace(/\\pm\s*/gu, '±')
            .replace(/\\times\s*/gu, '×');
        const deduped = texMerged.replace(
            /(?<![0-9])(?<!\d\.)((?:\d{1,16}\.\d{1,16}|\.\d{1,16}|\d{1,16})(?:[±×/+-](?:\d{1,16}\.\d{1,16}|\.\d{1,16}|\d{1,16})){0,4})\1(?![0-9]|\.\d)/gu,
            '$1'
        );
        const sandwichSplit = normalized.replace(
            /([±+-]|(?<![0-9]))(\.\d{1,16}|\d{1,16}\.\d{1,16}|\d{1,16})(\d{1,16}\.\d{1,16}|\.\d{1,16}|\d{1,16})(?:\\!|\s)*(?:\\pm|±)(?:\\!|\s)*\2(?![0-9]|\.\d)/gu,
            '$1$2 $3 ± $2'
        );
        const subscriptStdSplit = normalized.replace(
            /(?<![A-Za-z0-9.])(\d{1,12}\.\d{1,4})(0\.\d{1,4})(?![0-9]|\.\d)/gu,
            '$1 ± $2'
        );
        const texSpaced = normalized
            .replace(/\\[,;!:]/gu, ' ')
            .replace(/\\[A-Za-z]+/gu, ' ')
            .replace(/[{}]/gu, ' ');
        return [normalized, deduped, sandwichSplit, subscriptStdSplit, texSpaced];
    };
    const exactTokens = new Set();
    const percentTokens = new Set();
    const nonPercentTokens = new Set();
    const nonCitationTokens = new Set();
    const tokenRegex = /(?<![A-Za-z0-9])(?<![A-Za-z0-9]\.)([+-]?(?:\d+\.\d+|\.\d+|\d+))(\s*\\?%)?(?![0-9]|\.\d)/gu;
    const percentRangeRegex = /(?<![A-Za-z0-9])(?<![A-Za-z0-9]\.)([+-]?(?:\d+\.\d+|\.\d+|\d+))\s*(?:to|and|or|[–—-])\s*[+-]?(?:\d+\.\d+|\.\d+|\d+)\s*\\?%(?![0-9]|\.\d)/giu;
    for (const surface of buildSurfaces(srcRaw)) {
        for (const match of surface.matchAll(tokenRegex)) {
            const unsigned = match[1].replace(/^[+-]/u, '');
            const normalized = unsigned.startsWith('.') ? `0${unsigned}` : unsigned;
            exactTokens.add(normalized);
            exactTokens.add(unsigned);
            if (match[2]) percentTokens.add(normalized);
            else nonPercentTokens.add(normalized);
        }
        for (const match of surface.matchAll(percentRangeRegex)) {
            const unsigned = match[1].replace(/^[+-]/u, '');
            percentTokens.add(unsigned.startsWith('.') ? `0${unsigned}` : unsigned);
        }
    }
    const citationStrippedSrc = srcRaw.replace(/\[\s*\d+(?:\s*[,;–—-]\s*\d+)*\s*\]/gu, ' ');
    for (const surface of buildSurfaces(citationStrippedSrc)) {
        for (const match of surface.matchAll(tokenRegex)) {
            const unsigned = match[1].replace(/^[+-]/u, '');
            const normalized = unsigned.startsWith('.') ? `0${unsigned}` : unsigned;
            nonCitationTokens.add(normalized);
            nonCitationTokens.add(unsigned);
        }
    }
    const normalizedSrc = normalizeThousands(srcRaw);
    const percentTableContextRe = /(?:\(\s*\\?%[^)\n]{0,16}\)|\[\s*\\?%\s*\]|\/\s*\\?%(?![0-9A-Za-z])|(?<![A-Za-z0-9_])in\s+\\?%(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?:in|as)\s+percent(?:age|ages)?(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?:WER|CER|EER|UAR|DER|PER|ACC|Accuracy|Precision|Recall|F1)\s*\\?%(?![0-9]))/giu;
    const pairedRateTableHeaderRe = /(?<![A-Za-z0-9_])(?:WER|CER|PER|EER)\s*\/\s*(?:WER|CER|PER|EER)(?![A-Za-z0-9_])/giu;
    const sourceHasPercentTableContext = percentTableContextRe.test(normalizedSrc)
        || (percentTokens.size > 0 && pairedRateTableHeaderRe.test(normalizedSrc));
    const pValueRe = /(?<![A-Za-z0-9_])(?:p(?:-?values?)?|q(?:-?values?)?|α|alpha)\s*(?:<=|>=|<|>|=|≤|≥|(?:\\leq|\\le|\\geq|\\ge|\\ll|\\lt|\\gt)(?![A-Za-z]))\s*0?\.\d+/giu;
    const stripPValues = text => {
        let current = String(text || '');
        for (let pass = 0; pass < 4; pass++) {
            const next = current.replace(pValueRe, ' ');
            if (next === current) break;
            current = next;
        }
        return current;
    };
    const pValueStrippedSrc = stripPValues(citationStrippedSrc);
    const unitDecimalTokens = new Set();
    for (const surface of buildSurfaces(pValueStrippedSrc)) {
        for (const match of stripPValues(surface).matchAll(tokenRegex)) {
            if (match[2]) continue;
            const unsigned = match[1].replace(/^[+-]/u, '');
            const normalized = unsigned.startsWith('.') ? `0${unsigned}` : unsigned;
            if (/^0\.\d{2}$/u.test(normalized)) unitDecimalTokens.add(normalized);
        }
    }
    const nonPercentUnitAfterRe = /^\s*(?:epochs?|layers?|steps?|speakers?|samples?|hours?|hrs?|minutes?|mins?|seconds?|secs?|ms|Hz|kHz|MHz|GHz|dB|GiB|GB|MB|KB|TB|params?|parameters?|blocks?|heads?|dims?|dimensions?|channels?|frames?|tokens?|utterances?|files?|clips?|sentences?|words?|classes?|models?|datasets?|runs?|seeds?|folds?|GPUs?|CPUs?)(?![A-Za-z0-9_])/iu;
    const nonPercentPrefixBeforeRe = /(?:(?<![A-Za-z0-9_])(?:batch[\s_-]*size|bsz|mini-?batch|top|table|tab\.?|fig(?:ure)?\.?|sec(?:tion)?\.?|eq(?:uation)?\.?|alg(?:orithm)?\.?|appendix|step|layer|epoch|seed|fold|beam|head|dim(?:ension)?|channel|block|stage|rank|order|num(?:ber)?(?:\s+of)?|size|length|width|height|depth|stride|kernel|window)\s*[-:=]?\s*|(?<![A-Za-z0-9_])(?:k|n|m|d|r|b)\s*[-:=]\s*|#)\s*$/iu;
    const percentTableNearbyTokens = new Set();
    if (sourceHasPercentTableContext) {
        percentTableContextRe.lastIndex = 0;
        const normalizedCitationStrippedSrc = normalizeThousands(citationStrippedSrc);
        for (const ctxMatch of normalizedCitationStrippedSrc.matchAll(percentTableContextRe)) {
            const winStart = Math.max(0, ctxMatch.index - 1500);
            const winEnd = Math.min(normalizedCitationStrippedSrc.length, ctxMatch.index + 2500);
            const windowText = normalizedCitationStrippedSrc.slice(winStart, winEnd);
            for (const m of windowText.matchAll(tokenRegex)) {
                const unsigned = m[1].replace(/^[+-]/u, '');
                if (!/^\d{1,2}$/u.test(unsigned)) continue;
                const before = windowText.slice(Math.max(0, m.index - 28), m.index);
                if (nonPercentPrefixBeforeRe.test(before)) continue;
                const after = windowText.slice(m.index + m[0].length);
                if (nonPercentUnitAfterRe.test(after)) continue;
                percentTableNearbyTokens.add(unsigned);
            }
        }
    }
    const cleaned = normalizeThousands(String(summary || ''))
        .replace(/https?:\/\/\S+/gu, ' ')
        .replace(/(?<![A-Za-z0-9_])(?:Qwen|Llama|Gemma|Phi|GPT|Claude|Mistral|Whisper|HuBERT|WavLM|Wan|LTX|Python|PyTorch|CUDA|IEEE|P|v|ver|version)\s*[-_.]?\d+(?:\.\d+)*(?:\s*[-_.]?\d+(?:\.\d+)*\s*[BbMmKk](?![A-Za-z0-9_]))?/giu, ' ')
        .replace(/(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9_-]*[-_.]\d+(?:\.\d+)*[A-Za-z0-9_.-]*/gu, ' ')
        .replace(/(?:§|第|图|表|式|公式|章节|附录)\s*\d+(?:\.\d+)*/gu, ' ');
    for (const match of cleaned.matchAll(/(?<![A-Za-z0-9._])(?<!(?<![0-9A-Za-z])[+-])([+-]?(?:\d+\.\d+|\d+))(\s*(?:%|％))?(?=\s*(?:dB|ms|s|Hz|kHz|MHz|GHz|kbps|bps|fps|GiB|GB|MB|KB|TB|B|M|K|G|倍|点|分)?(?![A-Za-z0-9]|\.\d))/giu)) {
        const full = match[0].trim();
        const num = match[1].replace(/^[+-]/u, '');
        const hasPercent = Boolean(match[2]);
        const hasUnitAfter = /^\s*(?:dB|ms|Hz|kHz|MHz|GHz|kbps|bps|fps|GiB|GB|MB|KB|TB)(?![A-Za-z])/iu.test(cleaned.slice(match.index + match[0].length));
        const isDecimal = num.includes('.');
        if (!isDecimal && !hasPercent && !hasUnitAfter) continue;
        if (!exactTokens.has(num)) {
            return `核心摘要数值“${full}”未在原文中以相同精度出现（禁止编造、四舍五入或转换小数与百分数）`;
        }
        if (hasPercent && !percentTokens.has(num)) {
            const scaledFromUnitDecimal = /^\d{1,2}$/u.test(num)
                && unitDecimalTokens.has(`0.${num.padStart(2, '0')}`)
                && !percentTableNearbyTokens.has(num);
            if (!sourceHasPercentTableContext || !nonCitationTokens.has(num) || scaledFromUnitDecimal) {
                return `核心摘要数值“${full}”添加了原文不存在的百分号`;
            }
        }
        if (!hasPercent && isDecimal && percentTokens.has(num) && !nonPercentTokens.has(num)) {
            return `核心摘要数值“${full}”遗漏了原文的百分号`;
        }
    }
    return null;
}

function validateCoreSummarySemanticContract(analysis, options = {}) {
    const sourceText = typeof options === 'string' ? options : String(options?.sourceText || '');
    const summaryHeader = options && typeof options === 'object' ? options.summaryHeader : null;
    const useExecutiveAbstract = coreSummaryFormat.isExecutiveAbstractHeader(summaryHeader);
    const rawExtractedSummary = extractSection(String(analysis || ''), '核心摘要');
    const summary = coreSummarySentenceView(rawExtractedSummary, sourceText);
    const contentBody = useExecutiveAbstract
        ? coreSummarySentenceView(stripExecutiveAbstractBoldLeadIns(rawExtractedSummary), sourceText)
        : summary;
    const count = chineseCharacterCount(summary);
    const sentences = (summary.match(/[。！？!?]/g) || []).length;
    const minChineseChars = useExecutiveAbstract ? CORE_SUMMARY_MIN_CHINESE_CHARS : CORE_SUMMARY_LEGACY_MIN_CHINESE_CHARS;
    const maxChineseChars = useExecutiveAbstract ? CORE_SUMMARY_MAX_CHINESE_CHARS : CORE_SUMMARY_LEGACY_MAX_CHINESE_CHARS;
    const minSentences = useExecutiveAbstract ? CORE_SUMMARY_MIN_SENTENCES : CORE_SUMMARY_LEGACY_MIN_SENTENCES;
    const maxSentences = useExecutiveAbstract ? CORE_SUMMARY_MAX_SENTENCES : CORE_SUMMARY_LEGACY_MAX_SENTENCES;
    const maxMethodSentenceChars = useExecutiveAbstract ? CORE_SUMMARY_MAX_METHOD_SENTENCE_CHARS : 320;
    const issues = [];
    if (count < minChineseChars) {
        issues.push(`中文字符不足: ${count}/${minChineseChars}`);
    } else if (count > maxChineseChars) {
        issues.push(`中文字符过多: ${count}/${maxChineseChars}`);
    }
    if (sentences < minSentences || sentences > maxSentences) {
        issues.push(`句数必须为 ${minSentences}–${maxSentences}，当前 ${sentences}`);
    }
    if (useExecutiveAbstract) {
        issues.push(...validateExecutiveAbstractSurfaceStructure(rawExtractedSummary));
        const overlongMethodLen = findOverlongExecutiveMethodSentence(contentBody);
        if (overlongMethodLen > 0) {
            issues.push(`方法机制单句过长（${overlongMethodLen}/${CORE_SUMMARY_MAX_METHOD_SENTENCE_CHARS}），请按信号流拆分为多句自然表达`);
        }
    }
    // 明确写了材料用于哪项具体处理，就不必再强塞“任务”或“输入输出”这些词。
    const purposePattern = /(?:用于|用来|用以)(?:从[^。！？!?.;；,，\n]{1,24}中)?(?:筛查|诊断|检测|识别|转写|翻译|分离|定位|合成|预测|估计)(?![的了地得吧呢而但并或不未没非])(?:[“‘"\'「『])?[A-Za-z0-9\u4e00-\u9fff]{2,48}/;
    // 只在同一分句里判断用途，明确否定的说法和只有一个字的对象不能充数。
    const concretePurpose = contentBody.split(/[。！？!?.;；,，\n]|而(?:不是|是)|但(?=不能替代)/).some(clause => (
        purposePattern.test(clause)
        && !/(?:并非|并未|不是|不再|不会|不能|不曾|未曾|并不|没有|未被|不成立|不正确|不存在|不属于|不适用)/.test(clause)
        && !/(?:不|未)(?:被|直接|主要|实际|真正|仅|只|也|还|曾|能|会|再|尚)*\s*(?:用于|用来|用以)/.test(clause)
    ));
    const problemKeywordPattern = useExecutiveAbstract
        ? /(?:问题|难点|瓶颈|症结|失效|缺陷|受限|局限|挑战|任务|目标|输入|输出|旨在|针对|解决|误选|错分|偏差|风险|障碍|缺口|不足|丢弃|鲁棒性|难以|无法)/
        : /(?:问题|难点|任务|目标|输入|输出|旨在|针对|解决)/;
    if (!problemKeywordPattern.test(contentBody) && !concretePurpose && !hasConcreteCompressionPurpose(contentBody) && !hasConcreteAcousticSimulationPurpose(contentBody, sourceText)) {
        issues.push('缺少任务问题、输入输出或实际难点');
    }
    const chain = contentBody.match(/(?:第一|第二|第三|第四|首先|其次|然后|随后|随即|接着|最后|先|再|阶段|步骤|模块|组件|分(?:\d+|[一二三四五六七八九十]+)步)/g) || [];
    const roles = contentBody.match(/(?:负责|用于|承担|提取|编码|定位|筛选|生成|融合|对比|优化|校准|解码|预测|输出|构建|约束|传递|送入|计算|建立|锚定|量化|平滑|展平|丢弃)/g) || [];
    const tierRoleStages = new Set([...contentBody.matchAll(
        /(?<![A-Za-z0-9_])Tier[-‐‑‒–—]([LMH])(?![A-Za-z0-9_])[^；。！？!?\n]{0,120}(?:负责|用于|承担|提取|编码|定位|筛选|生成|融合|对比|优化|校准|解码|预测|输出|构建|约束|传递|送入|打分|匹配|投票|检索|推理|判决|路由)/gi
    )].map(match => match[1].toUpperCase()));
    const hasNumberedMethodChain = (chain.length >= 2
        || /分(?:\d+|[一二三四五六七八九十]+)步/.test(contentBody)) && roles.length >= 2;
    const hasTieredMethodChain = tierRoleStages.size >= 2;
    const musicPillarChain = /semantics extraction, semantic-aware orchestration, and cross-modal semantic synchronization/i.test(sourceText)
        && /语义提取负责[^。！？\n]{1,100}语义编排负责[^。！？\n]{1,100}(?:跨模态)?语义同步负责[^。！？\n]{1,100}/.test(contentBody)
        && !/(?:不|未|没有|假设|假如)[^。！？\n]{0,15}(?:语义提取|语义编排|语义同步)/.test(contentBody);
    const hasMethodMechanism = hasNumberedMethodChain
        || hasTieredMethodChain
        || musicPillarChain
        || hasConcreteUnnumberedMethodChain(contentBody)
        || hasAdjacentConcreteMethodChain(contentBody, maxMethodSentenceChars)
        || hasExplicitNaturalProductChain(contentBody, sourceText, maxMethodSentenceChars)
        || hasSymbolicGeometryMethodChain(contentBody)
        || (useExecutiveAbstract && hasExecutiveMethodArchitecture(contentBody));
    if (!hasMethodMechanism) {
        issues.push('缺少 2–4 步方法链的分工与衔接');
    }
    // LaTeXML/PDF 抽取会把脚注标记重复一次：正文里一次，下一行又单独出现一遍
    // （观察到的 "11\n1" 就是标记 1 的双重渲染）。合并软换行前只删掉完全相同的
    // 这一对；普通的行尾测量值只要下一行不同，仍然是证据。
    const quantitativeSourceText = stripDuplicatedLineFootnoteMarkers(sourceText)
        // 原文将示例场景中的延迟列为文献指标和设计目标，不能作为本研究的实测。
        .replace(/(TABLE I: Representative MM Use Cases\. Latency values are indicative targets; see Table\s*II\.[\s\S]{0,180}?UC1: Remote jamming\s*)3[–-]5 musicians\s+Audio, kinematic\s+30[–-]40\s*ms audio; low, stable gesture delay/i, '$1[文献目标示例]')
        // 合并 PDF 软换行前只剥掉大纲编号。指标词表旁边的标题不是数值结果。
        .replace(/^\s*\d{1,2}(?:\.\d+){0,3}\.?[ \t]+(?=[A-Z][A-Za-z])/gm, '')
        .replace(/([^\n])\r?\n(?!\r?\n)/g, '$1 ');
    const quantitativeSourceSentences = quantitativeSourceText.trim()
        .split(/[。！？!?\n]|\.(?=\s+[A-Z][A-Za-z]|$)/)
        .map(sentence => sentence.trim())
        .filter(Boolean);
    // 上面已经合并过 PDF 软换行。来源分类器特意把实测结果证据和
    // GPU 数、步数、延迟、算力开销这类运行参数分开。
    const sourceHasQuantitativeEvidence = classifySourceQuantitativeEvidence(
        sourceText, quantitativeSourceSentences);
    const quantitativeResultState = useExecutiveAbstract
        ? executiveSummaryQuantitativeResultState(contentBody, sourceText)
        : coreSummaryQuantitativeResultState(summary, sourceText);
    const scopedSymbolicDemonstration = sourceHasQuantitativeEvidence === false
        && /point[- ](?:set|pattern)/i.test(sourceText)
        && /transformation class/i.test(sourceText)
        && /inter[- ]pattern transformation graph/i.test(sourceText)
        && hasScopedSymbolicDemonstration(contentBody);
    const corpusCurationResult = sourceCorpusCurationResult(sourceText);
    const softwareFunctionalResult = sourceSoftwareFunctionalValidationResult(sourceText);
    const softwareOnlyResult = softwareFunctionalResult
        && classifyGenericSourceQuantitativeEvidence(sourceText, quantitativeSourceSentences) !== true;
    const completeSoftwareResult = hasCompleteSoftwareFunctionalValidationResult(contentBody, softwareFunctionalResult);
    const completeQuantitativeResult = softwareOnlyResult ? completeSoftwareResult
        : quantitativeResultState.complete || hasCompleteCorpusCurationResult(contentBody, corpusCurationResult)
            || completeSoftwareResult;
    if (softwareOnlyResult && quantitativeResultState.complete) {
        issues.push('纯软件功能验证来源不支持泛型基准性能结果；须保留同来源的完整性与重复性验证，不能编造准确率或模型性能对比');
    }
    if (softwareFunctionalResult && contentBody.includes(CORE_SUMMARY_RESULT_UNAVAILABLE)) {
        issues.push('原文已有可核的软件完整性与重复性验证结果，不能笼统声明没有关键定量结果；它不等于模型性能、移植性或感知质量');
    }
    if (corpusCurationResult && contentBody.includes(CORE_SUMMARY_RESULT_UNAVAILABLE)) {
        issues.push('原文已有可核的语料清洗质量结果，不能笼统声明没有关键定量结果；它们不等于模型性能实验');
    }
    if (sourceHasQuantitativeEvidence === true && !completeQuantitativeResult) {
        if (softwareOnlyResult) {
            issues.push('已有软件功能验证证据，但摘要没有按同一来源完整匹配运行环境、全新进程、计划与输出哈希、参数与信号组合、负向用例及包测试的关键定量结果');
        } else {
            issues.push('已有证据包含关键定量结果，但摘要没有写清比较对象、评测设置、指标、数值与方向'
            + `（最接近的${useExecutiveAbstract ? '' : '同句'}量化候选缺少：${quantitativeResultState.missing.join('、')}）`
            + (!useExecutiveAbstract && quantitativeResultState.candidateIssues.length
                ? `；含数值的句子还须逐句核对：${quantitativeResultState.candidateIssues.map(candidate =>
                    `第${candidate.sentenceNumber}句缺少${candidate.missing.join('、')}`).join('；')}。这些句子不一定都是结果，不得为运行参数编造指标或结论`
                : ''));
        }
    } else if (sourceHasQuantitativeEvidence === false
        && !scopedSymbolicDemonstration && !contentBody.includes(CORE_SUMMARY_RESULT_UNAVAILABLE)) {
        issues.push(`原文无可核定量结果时必须明确写“${CORE_SUMMARY_RESULT_UNAVAILABLE}”`);
    } else if (sourceHasQuantitativeEvidence === null && !completeQuantitativeResult
        && !contentBody.includes(CORE_SUMMARY_RESULT_UNAVAILABLE)) {
        issues.push(`缺少完整关键定量结果或明确的“${CORE_SUMMARY_RESULT_UNAVAILABLE}”声明`);
    }
    if (useExecutiveAbstract && sourceText) {
        const groundedIssue = validateCoreSummarySourceGroundedClaims(rawExtractedSummary, sourceText);
        if (groundedIssue) issues.push(groundedIssue);
    }
    const leadingContrastPrefix = /^\s*(?:(?:与|跟|同|相比于?|相较于?|较之|不同于|区别于)[^，,。；;]{0,40}(?:现有|已有|传统|以往|先前|主流)[^，,。；;]{0,30}[，,]\s*)/u;
    const priorMethodSentencePattern = /(?:现有|已有|传统|以往|先前|主流)(?:主流)?[^。！？!?\n]{0,28}(?:方法|方案|路线|模型|系统|编解码器|指标|代理|工作|研究)/u;
    const technicalBoundaryCompoundPattern = /(?:训练与冻结|冻结与更新|冻结与微调|训练|冻结|音素|音节|词|字|帧|分块|切分|窗口|时序|频带|声学|决策|分类|判别|模块|层间|梯度|相位|周期|起止|静音|语音活动)边界/gu;
    const boundaryBody = useExecutiveAbstract
        ? contentBody
            .replace(technicalBoundaryCompoundPattern, ' ')
            .split(/\n\s*\n/u)
            .map((paragraph, index, all) => (
                paragraph
                    .split(/(?<=[。！？!?\n])/u)
                    .map(sentence => (index === all.length - 1 ? sentence.replace(leadingContrastPrefix, '') : sentence))
                    .filter(sentence => !priorMethodSentencePattern.test(sentence))
                    .join('')
            ))
            .join('\n\n')
        : contentBody;
    const executiveNoLimitDisclaimer = useExecutiveAbstract
        && /(?:任何场景都适用|所有条件下均成立|不会失效|不存在局限|无适用限制)/u.test(contentBody);
    const boundaryParagraphs = boundaryBody.split(/\n\s*\n/u);
    const conclusionFramedPattern = /(?:结论|上述(?:结论|同时提升|提升|增益|结果|发现)|研究(?:结果|发现)|该(?:结论|结果|发现)|本(?:研究|文)的?(?:结论|结果|发现))/u;
    const methodConstraintPhrasePattern = /(?:延迟|显存|实时|算力|内存|带宽|码率|功耗|预算)[^，,；;。！？!?\n]{0,10}约束下[^，,；;。！？!?\n]{0,20}(?:提出|实现|解码|运行|部署|完成|工作|设计|构造)/gu;
    const executiveExplicitBoundary = useExecutiveAbstract && !executiveNoLimitDisclaimer
        && boundaryParagraphs.some((paragraph, paragraphIndex) => {
            const isLastParagraph = paragraphIndex === boundaryParagraphs.length - 1;
            return paragraph.split(/[。！？!?\n]/u).some(sentence => {
                const trimmedSentence = sentence.trim();
                if (!trimmedSentence) return false;
                if (/(?:并非仅在|不是仅在|并非仅见|不限于|不会漏检|不易漏检|不存在域差异)/u.test(trimmedSentence)) {
                    return false;
                }
                if (/(?:成立于|成立依赖|成立前提|域差异|易漏检|依赖[^。！？!?\n]{0,12}前提)/u.test(trimmedSentence)) {
                    return true;
                }
                const inBoundaryContext = isLastParagraph || conclusionFramedPattern.test(trimmedSentence);
                if (inBoundaryContext) {
                    const scopedSentence = trimmedSentence
                        .replace(/仅在(?:训练|预训练|微调|推理|解码)阶段/gu, '')
                        .replace(methodConstraintPhrasePattern, '');
                    if (/(?:仅见|仅在|约束下)/u.test(scopedSentence)) {
                        return true;
                    }
                }
                return /(?:仍|明显|显著|大幅|仍旧|依旧)?落后(?!于?(?:本文|本方法|本研究|本工作|本系统|所提))/u.test(trimmedSentence)
                    && !/(?:既有|基线|对照|现有|传统|先前|以往)[^，,。；;]{0,32}落后/u.test(trimmedSentence);
            });
        });
    const explicitBoundary = (/(?:边界|局限|适用|失败|尚未|尚不覆盖|未覆盖|未验证|外推|仅限|受限)/.test(boundaryBody)
        && !executiveNoLimitDisclaimer) || executiveExplicitBoundary;
    const separatedUnverifiedBoundary = /(?:尚未|未曾|未能|未|没有)[^。！？!?\n]{0,60}(?:验证|覆盖|评估|测试)/.test(boundaryBody);
    const conditionalFailure = /(?:但|不过|然而)[^。！？!?\n]{0,80}(?:在|对)[^。！？!?\n]{1,60}(?:时|下|中|上)[^。！？!?\n]{0,60}(?:可能|易|会|明显)?(?:失真|退化|恶化|不稳定|不可靠|失效|下降|受损|偏差)/.test(boundaryBody);
    const conditionalMetricFailure = boundaryBody.split(/[，,；;。！？!?\n]/u).some(clause =>
        /^(?:若|如果|当)[^。！？!?\n]{1,100}(?:一致性|准确率|召回率|识别率|辨识率|性能|结果)[^。！？!?\n]{0,30}(?:回落|下降|退化|恶化|失效|受损)/u.test(clause.trim())
        && !/(?:不会|不再|不能|不曾|没有|不意味着|并非|不是|无法|不|未|无须)[^。！？!?\n]{0,20}(?:回落|下降|退化|恶化|失效|受损)/u.test(clause));
    const singleReferenceBoundary = boundaryBody.split(/[。！？!?\n]/u).some(sentence =>
        !/(?:假设|如果|预计|可能|并非|不是|否认|引用|第三方|他人)/u.test(sentence)
        && /(?:结论|研究结果|研究发现)只在以单一(?:专业)?混音为目标的重建误差下成立/u.test(sentence)
        && hasOwnSourceStatement(sourceText, /reconstruction error against one professional mix does not fully capture mixing quality/iu));
    const scopedConclusionBoundary = /(?:结论|研究结果|研究发现)[^。！？!?\n]{0,40}(?<!不)(?<!非)限于[^。！？!?\n]{1,80}(?:语音|语料|数据|场景|条件|设置|样本|任务)/.test(boundaryBody);
    const attentionScopeBoundary = boundaryBody.split(/[。！？!?\n]/u).some(sentence =>
        !/(?:并非|不是|不能认为|不可认为|不应认为|没有)|(?:并不|不|未|没有|不会|不能)(?:曾|实际|一直|始终|确实|能|会)*保持不变/u.test(sentence)
        && /(?:结论|研究结果|研究发现)(?<!不)(?<!非)限于(?:视频|音频|图像)(?:自|交叉|跨模态)注意力(?:的)?(?:稀疏化|计算|处理)/u.test(sentence)
        && /(?:音频|视频|图像)(?:自|交叉|跨模态)注意力[^。！？!?\n]{0,30}保持不变/u.test(sentence));
    const observationalCausalBoundary = /(?:观察性|非实验|非干预)[^。！？!?\n]{0,40}(?:不建立|不能建立|不支持|不能证明)[^。！？!?\n]{0,20}因果/.test(boundaryBody);
    const uncoveredScopeBoundary = boundaryBody.split(/[。！？!?\n]/).some(sentence => (
        /未涵盖[^。！？!?\n]{1,60}(?:语音|语料|数据|场景|条件|设置|样本|任务|攻击|环境|设备|人群|语种|语言|录音)/.test(sentence)
        && !/(?:并非|不是|不存在|没有|并不|不能说|不能认为|无法断言)[^，,；;。！？!?\n]{0,20}未涵盖/.test(sentence)
        && !/未涵盖[^。！？!?\n]{0,90}(?:说法|表述|观点|判断|结论)[^。！？!?\n]{0,20}(?:不成立|不正确|不属实|并非事实|不符合事实|错误|有误)/.test(sentence)
        && !/未涵盖[^。！？!?\n]{0,60}(?:并非事实|不是事实|并不属实|不属实|不是真的)/.test(sentence)
    ));
    // “换对话域或换模型可能失效”是失败条件，“对照外部知识库核查不在验证范围”是
    // 未验证范围；两者都符合本节要求，只是没有用“局限/适用”这些词。前者必须带
    // 可能性副词，且不能是否定式（“不会失效”不算边界）。
    const failureConditionBoundary = /(?<![不未没])(?:可能|会|将|易|容易|仍会)(?:(?![不未没])[^。！？!?\n]){0,10}(?:失效|失灵|失准|退化|恶化)/.test(boundaryBody);
    const unverifiedScopeBoundary = /(?:不在|不属于|未纳入|不纳入)[^。！？!?\n]{0,12}(?:验证|覆盖|评估|评测|测试)范围/.test(boundaryBody);
    const executivePendingOrUncoveredBoundary = useExecutiveAbstract && boundaryBody.split(/[。！？!?\n]/u).some(sentence => (
        (/(?:仍需|尚需|尚待|有待)[^。！？!?\n]{0,60}(?:验证|评估|测试)/u.test(sentence)
            && !/(?:无需|不需|不必|已完成|已经完成|不再需要)/u.test(sentence))
        || (/不覆盖[^。！？!?\n]{1,60}/u.test(sentence)
            && !/(?:并非|不是|并不|不存在|没有|未曾|不能说|无法断言)[^，,；;。！？!?\n]{0,20}不覆盖/u.test(sentence))
    ));
    // 2026-11-06 曾以“先完成发布”为由整段取消除阻断，但写作提示词（core-summary-repair.md）
    // 和发布端的同名规则仍要求结论适用边界，只关 Node 一侧会让两端判定分叉，并让下面这组
    // 已经按真实保存稿迭代过的边界判据连同回归用例一起失效。因此恢复原判据：
    // 没有可核验的结论适用边界、失败条件或未验证范围时仍然拒绝。
    if (!explicitBoundary && !separatedUnverifiedBoundary && !conditionalFailure
        && !conditionalMetricFailure && !singleReferenceBoundary && !scopedConclusionBoundary && !attentionScopeBoundary && !observationalCausalBoundary && !uncoveredScopeBoundary && !failureConditionBoundary && !unverifiedScopeBoundary && !executivePendingOrUncoveredBoundary && !hasNaturalScopedBoundary(boundaryBody) && !hasSourceBoundDnsMosBoundary(boundaryBody, sourceText)) {
        issues.push('缺少结论适用边界、失败条件或未验证范围');
    }
    const costBody = useExecutiveAbstract
        ? contentBody
            .split(/(?<=[。！？!?\n])/u)
            .filter(sentence => !priorMethodSentencePattern.test(sentence))
            .join('')
        : contentBody;
    const scopedResourceDisclosure = costBody.split(/[。！？!?\n]/).some(sentence => (
        /(?:训练|推理|部署)/.test(sentence)
        && /\d/.test(sentence)
        && /(?:计算量|计算复杂度|MACs?|FLOPs?|GPU|CPU|TPU|NPU|RTX|显卡|(?:训练|推理|采样|优化|迭代)步数|\d\s*(?:[kKmMgG]\s*)?\s*(?:步|轮|次))/i.test(sentence)
    ));
    const executiveComputationOrTradeoff = useExecutiveAbstract && costBody.split(/[。！？!?\n]/u).some(sentence => (
        !/(?:并非|并未|不是|不能|不采用|不涉及|假设|如果|未记录)/u.test(sentence)
        && /(?:(?:额外|新增|引入|付出)[^。！？!?\n]{0,24}(?:参数开销|计算开销|内存开销|通信开销|编译开销|延迟|耗时|代价)|(?:多花\s*\d+(?:\.\d+)?\s*(?:秒|毫秒|ms|s)|(?:多出|额外)(?:的)?[^。！？!?\n]{0,20}(?:渲染时间|生成时间|推理时间))|代价是|作为代价|以[^。！？!?\n]{1,24}为代价|指标折损|(?:移除|去掉|消融)[^。！？!?\n]{1,36}(?:回升|恶化|回落|折损)|免训练|无需(?:任何)?(?:神经网络)?训练|零样本(?:直接)?推理|闭式(?:解|求解|奇异值分解|计算|诊断)|解析解|冻结(?:权重|编码器|骨干|主干)?[^。！？!?\n]{0,20}(?:直接推理|零样本推理|无需训练)|离线统计检验|(?:未披露|未报告)[^。！？!?\n]{0,24}(?:训练|推理|部署)?(?:成本|开销|延迟|耗时|算力|显存))/iu.test(sentence)
    ));
    const cost = hasConcreteRuntimeDisclosure(costBody) || costBody.includes(CORE_SUMMARY_COST_UNAVAILABLE)
        || /(?:成本|代价|开销|硬件|算力|显存|内存|延迟|吞吐|实时率|(?<![A-Za-z0-9_])RTF(?![A-Za-z0-9_])|能耗)/i.test(costBody)
        || /(?:训练|推理|部署)[^。！？!?]{0,24}(?:需要|增加|额外|占用|耗时|更高|更低|受限|负担)/.test(costBody)
        || scopedResourceDisclosure
        || executiveComputationOrTradeoff;
    if (!cost) {
        issues.push(useExecutiveAbstract
            ? '缺少关键代价、资源开销或实际计算方式说明'
            : `缺少训练、推理或部署成本；未披露时必须写“${CORE_SUMMARY_COST_UNAVAILABLE}”`);
    }
    return issues.length ? `核心摘要未达到 详细摘要规则：${issues.join('；')}` : null;
}
validateCoreSummarySemanticContract.validateCoreSummarySourceGroundedClaims = validateCoreSummarySourceGroundedClaims;

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
    if ((tagRecord.format === 'current' ? !isTagStageRecordDeclaration(manifest?.contracts?.[tagRecord.contractKey])
        : manifest?.contracts?.[tagRecord.contractKey] !== stage.selectionContract)
        || (stage.registryVersion !== runtime.registryVersion
            && !(stage.registrySha256 !== runtime.registrySha256
                && require('./lib/tag-catalog.js').isCatalogIdentityUpgrade(stage.registryVersion,runtime.registryVersion)))
        || !require('./lib/protocol-codec.js').isContract(stage.projectionContract,'paper-tag-prompt-text')
        || !tagRulesApi.isSupportedTagSelectionContract(stage.selectionContract)) {
        return '标签阶段记录中的词表版本、标签提示文本或标签选择规则与当前配置不一致。';
    }
    if (stage.registrySha256 !== runtime.registrySha256) {
        // v1 沿用原升级规则。v2 只读取一次旧词表，升级检查和提示重建使用
        // 同一个快照，避免动态读取器在一次核验中返回不同内容。
        let promptCatalog = null;
        let snapshotOptions = options.registrySnapshotOptions;
        const catalogChange = require('./lib/tag-catalog-change.js');
        const appendOnlyCatalog = !Object.hasOwn(stage, 'registryUpgradeFrom')
            ? catalogChange.resolveCompatibleProofCatalog(stage.registrySha256,
                runtime.tagCatalog, snapshotOptions) : null;
        if (appendOnlyCatalog) {
            // 保存稿仍使用原词表、原提示和原签名；下方的正文/选择/检查点
            // 核验不变。新分类请求始终使用当前词表，不借此重签旧记录。
            promptCatalog = appendOnlyCatalog;
            const originalRules = tagRulesApi.createTagRules({ tagCatalog: appendOnlyCatalog });
            for (const text of [paper.analysis, tagRecord.checkpoint]) {
                if (typeof text !== 'string') return '原标签阶段缺少可按旧词表重放的正文或检查点。';
                const originalParsed = require('./utils.js').parseAnalysis(text, { tagRules: originalRules });
                const originalSelection = require('./utils.js').readTagValidation(originalParsed);
                if (!originalSelection?.valid
                    || originalSelection.primaryTaskId !== stage.primaryTaskId
                    || originalSelection.primaryMethodId !== stage.primaryMethodId
                    || manualSha256(originalSelection.conceptIds) !== manualSha256(stage.conceptIds)) {
                    return '原标签阶段的正文或检查点不能按其保存的旧词表重放相同选择。';
                }
            }
        } else if (tagRulesApi.isCurrentTagPromptTextContract(stage.projectionContract)) {
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
        const upgrade = appendOnlyCatalog ? { ok: true } : catalogChange.validateTagCatalogUpgrade({
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

function coreSummaryBoundMethodSource(paper) {
    const fresh = require('./lib/fresh-analysis-context');
    const context = fresh.getFreshAnalysisContext();
    let source;
    const conference = require('./lib/conference-analysis-context');
    const direct = require('./lib/direct-rewrite-analysis-context');
    const conferenceContext = conference.getConferenceAnalysisContext();
    const directContext = direct.getDirectRewriteAnalysisContext();
    if (conferenceContext && (context || directContext)) throw new Error('摘要来源不能混用会议与日更或历史上下文');
    if (context) {
        // 使用原有完整 fresh 身份核验；另一个论文或来源上下文不能借来解释方法名。
        fresh.assertFreshPaper(paper);
        const id = require('./utils').normalizedId(paper);
        if (context.paperId && context.paperId !== id) throw new Error('摘要来源上下文属于另一篇论文');
        source = require('./lib/model-text-sanitization').currentModelInputSourceForPaperId(id);
    } else if (conferenceContext) {
        // 原论文对象保留别名冲突检查，不从上下文抄一个可通过的paperId。
        conference.getConferenceAnalysisSource(paper);
        source = require('./lib/model-text-sanitization').currentModelInputSourceForPaperId(
            paper.id || paper.conferencePaperId);
    } else if (directContext) {
        direct.getDirectRewriteSource(paper);
        source = require('./lib/model-text-sanitization').currentModelInputSourceForPaperId(direct.paperId(paper));
    } else {
        const daily = require('./lib/daily-fresh-source-plan');
        const data = require('./analysis-engine').readJsonFileStrict(require('./config').FILES.deepAnalysisResult);
        const plan = daily.requireDailyFreshSourceRecoveryPlan(data);
        if (!daily.isPaperBoundToPlan(paper, plan)) throw new Error('论文未与当前封存来源计划绑定');
        source = daily.readDailyFreshSource(plan, paper);
    }
    if (!source || crypto.createHash('sha256').update(String(source.text || '')).digest('hex') !== paper.sourceSha256
        || paper.sourceSha256 !== paper.analysisManifest?.sourceAcquisition?.sourceSha256) {
        throw new Error('原封存来源未与当前论文完整绑定');
    }
    return source.text;
}

function validateCoreSummaryStageBinding(paper, options = {}) {
    const manifest = paper?.analysisManifest;
    const stage = manifest?.stages?.coreSummaryRepair;
    if (stage?.status === MANUAL_COMPLETE_STATUS) return null;
    const summary = extractSection(String(paper?.analysis || ''), '核心摘要');
    const summarySha256 = crypto.createHash('sha256').update(String(summary || '')).digest('hex');
    if (!isRecoveryStageTerminal('coreSummaryRepair', stage?.status)) return '核心摘要阶段记录缺失，或状态不是 complete 或 not_needed。';
    const declaredSummaryHeader = coreSummaryFormat.readDeclaration(manifest?.contracts?.coreSummary);
    const summaryHeader = coreSummaryFormat.readStage(manifest?.contracts?.coreSummary, stage);
    if (!declaredSummaryHeader || !summaryHeader) return '核心摘要声明、阶段格式或结构指纹不一致。';
    if (!/^[a-f0-9]{64}$/.test(String(stage.fingerprint || ''))) return '核心摘要阶段的输入指纹缺失，或格式无效。';
    if (!/^[a-f0-9]{64}$/.test(String(stage.outputAnalysisSha256 || ''))) return '核心摘要阶段的输出正文哈希缺失，或格式无效。';
    if (options.skipSemantic !== true) {
        const baseOptions = typeof options === 'string' ? { sourceText: options } : { ...options };
        let semanticOptions = { ...baseOptions, summaryHeader: declaredSummaryHeader };
        let replayedBoundSource = false;
        const hasExplicitSource = typeof options === 'string' || Object.hasOwn(options, 'sourceText');
        if (!hasExplicitSource && (hasScopedSymbolicDemonstration(summary)
            || /(?:采样计划|render[- ]plan)\s*(?:哈希|hash)/iu.test(summary)
                && /(?:输出\s*哈希|output[- ]byte\s+hash)/iu.test(summary)
            || /(?<![A-Za-z0-9_])[A-Z][A-Za-z0-9_-]{0,39}(?:[ \t]+[A-Za-z][A-Za-z0-9_-]{0,39}){0,3}!(?=的)/u.test(summary))) {
            try {
                semanticOptions = { ...baseOptions, sourceText: coreSummaryBoundMethodSource(paper), summaryHeader: declaredSummaryHeader };
                replayedBoundSource = true;
            } catch (error) { return `核心摘要方法名的原封存来源未通过核验：${error.message}`; }
        }
        let semanticIssue = validateCoreSummarySemanticContract(paper?.analysis, semanticOptions);
        // 新来源绑定规则在正常分析时收到全文；最终完整资格也须重放同一真实来源。
        // 仅在无显式来源且首次语义失败时读取，普通已通过摘要不增加冷态来源IO。
        // 显式空来源仍按原调用检查，不能被自动换成另一份全文。
        if (semanticIssue && !hasExplicitSource && !replayedBoundSource) {
            try { semanticOptions = { ...baseOptions, sourceText: coreSummaryBoundMethodSource(paper), summaryHeader: declaredSummaryHeader }; }
            catch (error) { return `核心摘要语义的原封存来源未通过核验：${error.message}`; }
            semanticIssue = validateCoreSummarySemanticContract(paper?.analysis, semanticOptions);
        }
        if (semanticIssue) return semanticIssue;
    }
    if (stage.summarySha256 !== summarySha256) return '核心摘要正文的哈希与阶段记录不一致。';
    // A local core is an independently authenticated source correction, not an
    // API model response. Even skipSemantic cannot authorize its private proof.
    if (stage.sourceCoreCorrection !== undefined
        || (stage.executionKind === 'operator' && stage.model === 'operator-local')) {
        try {
            const local = require('./lib/conference-source-resource-correction');
            // The shared validator is also called directly by cold publication
            // checks. Rebuild the registered canonical receipt/source scope;
            // stage JSON alone must never authorize the local core proof.
            if (local.withSavedPaper(paper, () => local.assertVerifiedCoreStage(paper, stage)) !== true) {
                return '核心本地修正未通过真实来源与原句冷重放。';
            }
        } catch (error) { return `核心本地修正未通过真实来源与原句冷重放：${error.message}`; }
    }
    // 已付响应的人工短语变更必须独立重放来源、原付费字节和 operator 证明。
    // 即使调用方跳过语义检查，也不能把该变更当成模型原始输出。
    if (stage.operatorLiteralCorrection !== undefined || stage.paidDiagnosticReplay !== undefined) {
        const paidReplayIssue = require('./lib/paid-core-literal-correction').validateStage(paper);
        if (paidReplayIssue) return paidReplayIssue;
    }
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
        ...coreSummaryFormat.stageFields(summaryHeader),
        inputAnalysisSha256: stage.inputAnalysisSha256,
        outputAnalysisSha256: stage.outputAnalysisSha256,
        inputSummarySha256: stage.inputSummarySha256,
        summarySha256: stage.summarySha256,
        inputStructureProjectionSha256: stage.inputStructureProjectionSha256,
        outputStructureProjectionSha256: stage.outputStructureProjectionSha256
    };
    if (stage.operatorLiteralCorrection !== undefined) {
        bindingBody.operatorLiteralCorrection = stage.operatorLiteralCorrection;
        bindingBody.paidDiagnosticReplay = stage.paidDiagnosticReplay;
    }
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
    const { FRESH_AUTHORING_CONTRACT, FRESH_AUTHORING_MODE } = getManualFreshAuthoring();
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
    const { MANUAL_TUTORIAL_PAYLOAD_CONTRACT } = getManualTutorialPayload();
    if (marker !== MANUAL_TUTORIAL_PAYLOAD_CONTRACT) {
        return `Manual v5 的 tutorialPayload 格式标识不符合要求：${String(marker)}`;
    }
    const payload = takeover?.tutorialPayload;
    if (!payload || payload.contract !== MANUAL_TUTORIAL_PAYLOAD_CONTRACT
        || payload.paperId !== manifest?.sourceAcquisition?.sourceId
        || payload.articleSha256 !== takeover?.freshAuthoring?.articleSha256
        || payload.freshAuthoringReceiptSha256 !== takeover?.freshAuthoring?.receiptSha256
        || takeover.tutorialPayloadSha256 !== manualSha256(payload)
        || payload.receiptSha256 !== manualSha256((({ receiptSha256: _sha, ...rest }) => rest)(payload))) {
        return '教程正文记录 tutorialPayload 缺失，格式或论文编号不符合要求，或正文、成稿凭证和记录内容的 SHA 不一致。';
    }
    return null;
}

function validateManualTakeoverBindings(manifest, takeover, sourceSha256 = '', options = {}) {
    const { CURRENT_MODEL_POLICY, boundModelPolicy, assertAgentIdentity } = getManualAgentPolicy();
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
    if ([MANUAL_DEPTH_EXPLANATION_CONTRACT, ...MANUAL_READER_QUALITY_CONTRACTS]
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
    if (MANUAL_READER_QUALITY_CONTRACTS.includes(manifest?.contracts?.manualDepth)
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
    if (MANUAL_READER_QUALITY_CONTRACTS.includes(manifest?.contracts?.manualDepth)) {
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
    if (manifest?.contracts?.manualDepth === MANUAL_DEPTH_FACT_COVERAGE_CONTRACT) {
        const {
            MANUAL_RESEARCH_CONTRACT,
            validateResearchBrief,
            validateStageReviews,
            validateFigureReview,
            validateScoringCalibration,
            validateAttributedResultClaimCoverage,
            validateEditorialReview
        } = getManualResearchContract();
        if (manifest?.contracts?.researcherFocus !== MANUAL_RESEARCH_CONTRACT) {
            return `manual v5 必须绑定 researcherFocus=${MANUAL_RESEARCH_CONTRACT}`;
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
            validateAttributedResultClaimCoverage(takeover.resultClaims, {
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
                getManualTutorialOrchestrator().validateManualTutorialReaderBundle(takeover.researchBrief.editorialPlan, takeover.readerArticle, takeover.evidenceLedger, {
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
    if (!hasHardenedBindings && completedDate >= MANUAL_BOUND_STAGE_CUTOFF_DATE) {
        return `manualTakeover.stageEvidence 缺少 ${MANUAL_BOUND_STAGE_CUTOFF_DATE} 起必需的逐阶段 prompt/context 绑定`;
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
            ...(manifest?.contracts?.manualDepth === MANUAL_DEPTH_FACT_COVERAGE_CONTRACT ? {
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
        if ([MANUAL_DEPTH_EXPLANATION_CONTRACT, ...MANUAL_READER_QUALITY_CONTRACTS]
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
        if (manifest?.contracts?.manualDepth !== MANUAL_DEPTH_FACT_COVERAGE_CONTRACT
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
                ...([MANUAL_DEPTH_EXPLANATION_CONTRACT, ...MANUAL_READER_QUALITY_CONTRACTS]
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
    if (manifest?.contracts?.manualDepth === historicalManualContract('manual-analysis-depth', 'signed-longform')) {
        if (!manifest.manualTakeover || typeof manifest.manualTakeover !== 'object'
            || Array.isArray(manifest.manualTakeover)) {
            return 'v6 人工分析结果缺少有效的 manualTakeover 记录';
        }
        const { boundModelPolicy } = getManualAgentPolicy();
        try {
            const policy = boundModelPolicy(manifest, options.expectedModelPolicy, '分析清单');
            boundModelPolicy(manifest.manualTakeover, policy, '人工分析结果');
        } catch (error) { return error.message; }
        return validateManualTakeoverManifest({
            ...manifest,
            contracts: { ...manifest.contracts, manualDepth: MANUAL_DEPTH_FACT_COVERAGE_CONTRACT }
        }, sourceSha256, options);
    }
    const manualStatuses = Object.values(manifest?.stages || {})
        .some(stage => stage?.status === MANUAL_COMPLETE_STATUS);
    if (!manualStatuses && manifest?.manualTakeover === undefined) return null;
    const evaluationIssue = getPaperEvaluationHeadingIssue(options.analysis || manifest?.manualTakeover?.analysis || '');
    if (evaluationIssue) return evaluationIssue;
    if (MANUAL_READER_QUALITY_CONTRACTS.includes(manifest?.contracts?.manualDepth)
        && manifest?.contracts?.experimentTables !== EXPERIMENT_TABLE_CONTRACT_VERSION) {
        return `manual v4 必须绑定 experimentTables=${EXPERIMENT_TABLE_CONTRACT_VERSION}`;
    }
    if (MANUAL_READER_QUALITY_CONTRACTS.includes(manifest?.contracts?.manualDepth)
        && manifest?.contracts?.imageNarrative !== qualityFormats.original('image-narrative', 'context-bound-figures')) {
        return '历史人工稿缺少原图片上下文声明。';
    }
    if (MANUAL_READER_QUALITY_CONTRACTS.includes(manifest?.contracts?.manualDepth)
        && manifest?.contracts?.editorialQuality !== EDITORIAL_QUALITY_CONTRACT_VERSION) {
        return `manual v4 必须绑定 editorialQuality=${EDITORIAL_QUALITY_CONTRACT_VERSION}`;
    }
    if (manifest?.contracts?.manualDepth === MANUAL_DEPTH_FACT_COVERAGE_CONTRACT) {
        const { MANUAL_RESEARCH_CONTRACT } = getManualResearchContract();
        if (manifest?.contracts?.researcherFocus !== MANUAL_RESEARCH_CONTRACT) {
            return `manual v5 必须绑定 researcherFocus=${MANUAL_RESEARCH_CONTRACT}`;
        }
    }
    const takeover = manifest?.manualTakeover;
    if (!takeover || typeof takeover !== 'object' || Array.isArray(takeover)) {
        return '人工分析的 manualTakeover 记录缺失或格式无效。';
    }
    const { CURRENT_MODEL_POLICY, boundModelPolicy } = getManualAgentPolicy();
    try {
        const policy = boundModelPolicy(manifest, options.expectedModelPolicy, '分析清单');
        boundModelPolicy(takeover, policy, '人工分析结果');
        if (takeover.version === 1 && policy === CURRENT_MODEL_POLICY) {
            return '历史 v1 人工分析结果不能借用当前模型规则';
        }
    } catch (error) { return error.message; }
    if (takeover.version === MANUAL_COMPLETE_PROVENANCE_VERSION) {
        return validateManualTakeoverBindings(manifest, takeover, sourceSha256, options);
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

    const scoringRubric = require('./lib/scoring-rubric');
    const occurrences = new Map(REQUIRED_MACHINE_SUMMARY_KEYS.map(key => [key, []]));
    const optionalOccurrences = new Map([['rubric_version', []]]);
    const unknown = [];
    for (const rawLine of block.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        const match = line.match(/^([a-z_]+)\s*[:：]\s*(.*?)$/);
        if (!match) return `机器摘要行格式非法: ${line.slice(0, 60)}`;
        if (optionalOccurrences.has(match[1])) {
            optionalOccurrences.get(match[1]).push(match[2].trim());
            continue;
        }
        if (!occurrences.has(match[1])) {
            unknown.push(match[1]);
            continue;
        }
        occurrences.get(match[1]).push(match[2].trim());
    }

    if (unknown.length > 0) return `机器摘要包含额外键: ${[...new Set(unknown)].join('、')}`;
    const rubricVals = optionalOccurrences.get('rubric_version');
    if (rubricVals.length > 1) return '机器摘要键重复: rubric_version';
    const rubricVersion = rubricVals.length === 1 ? rubricVals[0] : scoringRubric.LEGACY_SCORING_RUBRIC;
    if (rubricVals.length === 1 && !scoringRubric.SUPPORTED_SCORING_RUBRIC_VERSIONS.includes(rubricVersion)) {
        return `机器摘要 rubric_version 非法: ${rubricVersion}`;
    }
    const isUnified = scoringRubric.isUnifiedRubric(rubricVersion);

    const missing = REQUIRED_MACHINE_SUMMARY_KEYS.filter(key => occurrences.get(key).length === 0);
    if (missing.length > 0) return `机器摘要缺少键: ${missing.join('、')}`;
    const duplicate = REQUIRED_MACHINE_SUMMARY_KEYS.filter(key => occurrences.get(key).length > 1);
    if (duplicate.length > 0) return `机器摘要键重复: ${duplicate.join('、')}`;
    const empty = REQUIRED_MACHINE_SUMMARY_KEYS.filter(key => !occurrences.get(key)[0]);
    if (empty.length > 0) return `机器摘要键为空: ${empty.join('、')}`;

    const scoreMaxima = isUnified
        ? Object.fromEntries(Object.keys(MACHINE_SCORE_MAXIMA).map(k => [k, 10]))
        : MACHINE_SCORE_MAXIMA;
    const openAnchors = isUnified ? scoringRubric.UNIFIED_OPEN_SOURCE_ANCHORS : OPEN_SOURCE_SCORE_ANCHORS;
    for (const [key, maximum] of Object.entries(scoreMaxima)) {
        const rawValue = occurrences.get(key)[0];
        if (!/^\d+(?:\.\d)?$/.test(rawValue)) {
            return `机器摘要 ${key} 必须是最多一位小数的非负数`;
        }
        const value = Number(rawValue);
        if (value > maximum) return `机器摘要 ${key} 超出 0-${maximum}`;
        if (key === 'open_source' && !openAnchors.includes(value)) {
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
    const editorialLeakageIssue = validateAnalysisEditorialLeakageContract(analysis, {
        sourceText: options.sourceText,
        enforceCyrillicProseGarble: options.enforceCyrillicProseGarble === true
    });
    if (editorialLeakageIssue) return `分析结果叙事契约无效: ${editorialLeakageIssue}`;
    if (!parsed) return '分析结果无法解析';
    const machineSummaryIssue = validateMachineSummaryContract(analysis, parsed);
    if (machineSummaryIssue) return `分析结果机器摘要契约无效: ${machineSummaryIssue}`;
    const tagIssue = validateTagSectionContract(analysis, parsed, options);
    if (tagIssue) return `分析结果标签契约无效: ${tagIssue}`;
    if (options.enforceExperimentTableContract === true) {
        const tableOptions = {
            contractVersion: options.experimentTableContractVersion
                || EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION,
            documentType: parsed?.documentType,
            sourceText: options.sourceText,
            enforceTableCommentaryAlignment: options.enforceTableCommentaryAlignment === true
        };
        let tableIssue = validateExperimentTableContract(analysis, tableOptions);
        // 损失名称的方向与阶段开关的身份须结合来源判断；仅相应歧义重放
        // 正常封存来源，不能从调用方字符串或错误文字授予身份。
        if (options.paper && tableIssue
            && (/^实验结果第 \d+ 张表指标“(?:损失|loss|波形损失归一化|损失归一化|waveform[- ]loss normalization|语谱图辅助损失|auxiliary spectrogram loss)”缺少 ↑\/↓ 方向$/i.test(tableIssue)
                || /^实验结果第 \d+ 张表缺少方法、数据集或设置识别列$/u.test(tableIssue))) {
            const sourceText = coreSummaryBoundMethodSource(options.paper);
            tableIssue = validateExperimentTableContract(analysis, { ...tableOptions, sourceText });
        }
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

const TABLE_ALIGNMENT_STOPWORDS = new Set([
    'method', 'methods', 'model', 'models', 'metric', 'metrics', 'dataset', 'datasets',
    'baseline', 'baselines', 'system', 'systems', 'overall', 'average', 'mean', 'score', 'scores',
    'total', 'value', 'values', 'result', 'results', 'setting', 'settings', 'table', 'tables',
    'ours', 'proposed', 'arrow', 'uparrow', 'downarrow', 'textbf', 'mathrm', 'mathbf', 'mathcal',
    'text', 'best', 'second', 'input', 'output', 'audio', 'video', 'speech', 'music', 'sound',
    'time', 'size', 'rate', 'loss', 'train', 'test', 'valid', 'eval', 'task', 'tasks', 'type',
    'params', 'param', 'speed', 'latency', 'memory', 'cost', 'human', 'large', 'small', 'base',
    'none', 'full', 'with', 'without', 'from', 'into', 'over', 'under', 'only', 'both', 'each',
    'stage', 'layer', 'layers', 'block', 'blocks', 'step', 'steps', 'mode', 'modes', 'level',
    'high', 'low', 'true', 'false', 'zero', 'shot', 'fine', 'tuned', 'free', 'open', 'closed',
    'track', 'tracks', 'clean', 'other', 'pair', 'pairs', 'approach', 'ratio', 'density'
]);

const GENERIC_TABLE_CJK_LABELS_RE = /^(?:方法|模型|指标|数据集|基准|条件|设置|结果|平均|总体|合计|备注|说明|对比|基线|本文|变化|提升|相对提升|实验|阶段|类别|任务|配置|参数|表现|性能)$/u;
const TABLE_BLOCK_BOUNDARY_RE = /^(?:#{1,6}\s|\||!\[|>|\[\[(?:TABLE|FIGURE|FORMULA|CONCEPT_BRIDGE)_|\\\[|\$\$|\*论文图|\*\*[^*\n]+ × [^*\n]+：\*\*)/u;
const CROSS_TABLE_OR_SCOPE_SENTENCE_RE = /(?:两表|两张表|双表|二表|各表|上述两表|以上两表|同表|上表|下表|前表|后表|另一张表|前一张表|下一张表|主表|第\s*[0-9一二三四五六七八九十]+\s*张表|表\s*[0-9一二三四五六七八九十]+|对照|相比常见|强调与|限制(?:是|在于)|结论(?:只|仅)在|这组实验(?:只|仅)在|(?:未|没有)(?:报告|覆盖|测试|评测))/u;
const NON_COMMENTARY_TOPIC_SHIFT_RE = /(?:^(?:对比协议|复现输入)|上述输入方式是评测条件)/u;

function cleanTableAlignmentTex(text) {
    return String(text || '')
        .replace(/\\(?:uparrow|downarrow|pm|times|mathbf|mathrm|mathcal|textbf|textit|underline)\b/g, ' ')
        .replace(/[`*_~]/g, ' ');
}

function extractTableAlignmentIdentifiers(text) {
    const cleaned = cleanTableAlignmentTex(text);
    const out = new Set();
    for (const match of cleaned.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*/g)) {
        const raw = match[0].replace(/\.+$/, '');
        const low = raw.toLowerCase();
        if (raw.length < 4 || TABLE_ALIGNMENT_STOPWORDS.has(low)) continue;
        out.add(low);
    }
    return out;
}

function extractTableRowAcronyms(rows) {
    const out = new Set();
    for (const row of rows) {
        for (const match of cleanTableAlignmentTex(row[0] || '').matchAll(/\b[A-Z]{2,4}\b/g)) {
            out.add(match[0]);
        }
    }
    return out;
}

function extractProseCamelCaseInitials(text) {
    const out = new Set();
    for (const match of cleanTableAlignmentTex(text).matchAll(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g)) {
        const caps = (match[0].match(/[A-Z]/g) || []).join('');
        if (caps.length >= 2 && caps.length <= 4) out.add(caps);
    }
    return out;
}

function extractTableAlignmentNumbers(text, { expandRounded = false, tableRows = null } = {}) {
    const cleaned = cleanTableAlignmentTex(text).replace(/[−–]/g, '-');
    const out = new Set();
    for (const match of cleaned.matchAll(/(?<![A-Za-z0-9])[-+]?(?:\d+\.\d+|\.\d{2,})(?![A-Za-z0-9.])/g)) {
        const unsigned = match[0].replace(/^[-+]/, '');
        const normalized = unsigned.startsWith('.') ? `0${unsigned}` : unsigned;
        out.add(unsigned);
        out.add(normalized);
        if (expandRounded) {
            const value = Number(normalized);
            if (Number.isFinite(value)) {
                out.add(value.toFixed(2));
                out.add(value.toFixed(1));
            }
        }
    }
    for (const match of cleaned.matchAll(/(?<![A-Za-z0-9.,])[-+]?\d+(?:,\d{3})*(?![A-Za-z0-9.])/g)) {
        out.add(match[0].replace(/^[-+]/, '').replace(/,/g, ''));
    }
    if (expandRounded && Array.isArray(tableRows) && tableRows.length >= 2) {
        const columns = tableRows[0]?.length || 0;
        for (let col = 0; col < columns; col += 1) {
            const values = tableRows
                .map(row => cleanTableAlignmentTex(row[col] || '').match(/(?<![A-Za-z0-9])[-+]?\d+\.\d{2,}(?![A-Za-z0-9.])/)?.[0])
                .filter(Boolean)
                .map(Number)
                .filter(Number.isFinite);
            for (let left = 0; left < values.length; left += 1) {
                for (let right = left + 1; right < values.length; right += 1) {
                    const diff = Math.abs(values[left] - values[right]);
                    if (diff > 0) out.add(diff.toFixed(2));
                }
            }
        }
    }
    return out;
}

function extractTableAlignmentCjkPhrases(cells) {
    const out = new Set();
    for (const cell of cells) {
        for (const match of String(cell || '').matchAll(/[\u4e00-\u9fff]{2,10}/gu)) {
            if (!GENERIC_TABLE_CJK_LABELS_RE.test(match[0])) {
                out.add(match[0]);
            }
        }
    }
    return out;
}

/**
 * 检查多表文章中紧邻表格的表后评述是否与相邻表格错位（例如表 A 后的评述完全没有引用表 A 的
 * 非全局专有标识与数值，却在首句主判断中引用了另一张表 B 的 >=2 个表头/首列专有标识）。
 */
function findMisalignedTableCommentaryIssues(markdown, options = {}) {
    const text = String(markdown ?? '');
    const tables = extractMarkdownTables(text);
    if (tables.length < 2) return [];
    const lines = text.split('\n');
    const sectionIndexAtLine = new Array(lines.length).fill(null);
    let fence = null;
    let sectionCount = 0;
    for (let cursor = 0; cursor < lines.length; cursor += 1) {
        const line = lines[cursor];
        const openMatch = !fence ? /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/.exec(line) : null;
        if (fence) {
            const closeMatch = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
            if (closeMatch && closeMatch[1][0] === fence[0] && closeMatch[1].length >= fence.length) {
                fence = null;
            }
        } else if (openMatch && (openMatch[1][0] === '~' || !openMatch[2].includes('`'))) {
            fence = openMatch[1];
        } else if (/^###\s+\S/.test(line.trim())) {
            sectionCount += 1;
        }
        sectionIndexAtLine[cursor] = sectionCount > 0 ? sectionCount - 1 : null;
    }
    const hasReaderSectionHeadings = sectionCount > 0;
    const sectionIndexBeforeLine = lineNumber => {
        if (!hasReaderSectionHeadings || lines.length === 0) return null;
        return sectionIndexAtLine[Math.min(Math.max(0, lineNumber), lines.length - 1)];
    };

    const infos = tables.map((table, index) => {
        const nextTableStart = tables[index + 1]?.startLine ?? lines.length;
        const afterLines = [];
        let postStartLine = table.endLine + 1;
        for (let cursor = table.endLine + 1; cursor < Math.min(lines.length, nextTableStart); cursor += 1) {
            const trimmed = lines[cursor].trim();
            if (!trimmed) {
                if (afterLines.length > 0) break;
                continue;
            }
            if (TABLE_BLOCK_BOUNDARY_RE.test(trimmed)) break;
            if (afterLines.length === 0) postStartLine = cursor;
            afterLines.push(trimmed);
        }
        if (afterLines.length >= 2 && postStartLine + afterLines.length === nextTableStart) {
            afterLines.pop();
        }
        const prevTableEnd = tables[index - 1]?.endLine ?? -1;
        const beforeLines = [];
        let leadEndLine = table.startLine - 1;
        for (let cursor = table.startLine - 1; cursor > prevTableEnd; cursor -= 1) {
            const trimmed = lines[cursor].trim();
            if (!trimmed) {
                if (beforeLines.length > 0) break;
                continue;
            }
            if (TABLE_BLOCK_BOUNDARY_RE.test(trimmed)) break;
            if (beforeLines.length === 0) leadEndLine = cursor;
            beforeLines.unshift(trimmed);
        }
        if (beforeLines.length >= 2 && leadEndLine - beforeLines.length + 1 === prevTableEnd + 1) {
            beforeLines.splice(0, beforeLines.length - 1);
        }
        const allCells = [...table.header, ...table.rows.flat()];
        const axisCells = [
            ...table.header,
            ...(table.rows[0] && String(table.rows[0][0] || '').trim() === '' ? table.rows[0] : []),
            ...table.rows.map(row => row[0] || '')
        ];
        return {
            index,
            table,
            sectionIndex: sectionIndexBeforeLine(table.startLine),
            postStartLine,
            leadParagraph: beforeLines.join(' '),
            postParagraph: afterLines.join(' '),
            allIds: extractTableAlignmentIdentifiers(allCells.join(' ')),
            axisIds: extractTableAlignmentIdentifiers(axisCells.join(' ')),
            rowAcronyms: extractTableRowAcronyms(table.rows),
            cjk: extractTableAlignmentCjkPhrases(allCells),
            numbers: extractTableAlignmentNumbers(allCells.join(' '), { expandRounded: true, tableRows: table.rows })
        };
    });

    const ubiquitousIds = new Set(
        [...infos[0].allIds].filter(id => infos.every(info => info.allIds.has(id)))
    );

    const findings = [];
    for (let i = 0; i < infos.length; i += 1) {
        const own = infos[i];
        if (!own.postParagraph || own.axisIds.size === 0) continue;
        if (NON_COMMENTARY_TOPIC_SHIFT_RE.test(own.postParagraph) || /另以正文/u.test(own.leadParagraph)) continue;

        const sentences = own.postParagraph
            .split(/[。！？!?]/u)
            .map(sentence => sentence.trim())
            .filter(Boolean);
        if (sentences.length === 0) continue;
        if (CROSS_TABLE_OR_SCOPE_SENTENCE_RE.test(sentences[0])) continue;

        const postIdsAll = extractTableAlignmentIdentifiers(own.postParagraph);
        const postNumsAll = extractTableAlignmentNumbers(own.postParagraph, { expandRounded: false });
        const postInitials = extractProseCamelCaseInitials(own.postParagraph);
        const ownNonUbiquitousIds = [...own.allIds].filter(id => !ubiquitousIds.has(id) && postIdsAll.has(id));
        const ownAcronymMatches = [...postInitials].filter(initial => own.rowAcronyms.has(initial));
        const ownNums = [...postNumsAll].filter(num => own.numbers.has(num));
        if (ownNonUbiquitousIds.length > 0 || ownAcronymMatches.length > 0 || ownNums.length > 0) continue;

        const ownCjk = [...own.cjk].filter(phrase => own.postParagraph.includes(phrase));
        const opening = (sentences[0].length < 24 && sentences[1] && !CROSS_TABLE_OR_SCOPE_SENTENCE_RE.test(sentences[1])
            ? sentences.slice(0, 2)
            : sentences.slice(0, 1)).join('。');
        if (!opening) continue;
        const openingIds = extractTableAlignmentIdentifiers(opening);
        if (openingIds.size < 2) continue;

        const exemptLeadIds = extractTableAlignmentIdentifiers(own.leadParagraph);

        let bestRival = null;
        for (let j = 0; j < infos.length; j += 1) {
            if (i === j) continue;
            const rival = infos[j];
            const ownUniqueCjk = ownCjk.filter(phrase => !rival.cjk.has(phrase));
            if (ownUniqueCjk.length > 0) continue;
            const foreignTokens = [...openingIds].filter(
                id => !own.allIds.has(id) && !exemptLeadIds.has(id) && rival.axisIds.has(id)
            );
            if (foreignTokens.length >= 2) {
                if (!bestRival || foreignTokens.length > bestRival.foreignTokens.length) {
                    bestRival = { rival, foreignTokens };
                }
            }
        }
        if (!bestRival) continue;

        const rival = bestRival.rival;
        const foreignTokens = bestRival.foreignTokens.slice(0, 6);
        const ownLocator = [
            own.sectionIndex !== null ? `sections[${own.sectionIndex}].body` : null,
            `tableBindings[${i}]`
        ].filter(Boolean).join(', ');
        const rivalLocator = [
            rival.sectionIndex !== null ? `sections[${rival.sectionIndex}].body` : null,
            `tableBindings[${rival.index}]`
        ].filter(Boolean).join(', ');
        findings.push({
            code: 'table_commentary_misaligned',
            tableIndex: i + 1,
            otherTableIndex: rival.index + 1,
            bindingIndex: i,
            otherBindingIndex: rival.index,
            sectionIndex: own.sectionIndex,
            otherSectionIndex: rival.sectionIndex,
            line: own.postStartLine + 1,
            foreignTokens,
            message: options.analysisMode === true
                ? `实验结果第 ${i + 1} 张表的表后解释未引用本表专有指标或数值，却引用了第 ${rival.index + 1} 张表的专有标识（${foreignTokens.join('、')}），疑似多表与表后评述错位`
                : `第 ${i + 1} 张表（${ownLocator}）的表后首段未引用本表专有行列标识或数值，却集中引用了第 ${rival.index + 1} 张表（${rivalLocator}）的专有标识（${foreignTokens.join('、')}），疑似多表与表后评述错位；请核对原表将对应小节正文与表绑定索引逐一对齐`
        });
    }
    return findings;
}

function validateTableCommentaryAlignmentContract(markdown, options = {}) {
    const findings = findMisalignedTableCommentaryIssues(markdown, { ...options, analysisMode: true });
    return findings.length > 0 ? findings[0].message : null;
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
    findCyrillicProseGarbleIssues,
    validateCyrillicProseGarbleContract,
    findMisalignedTableCommentaryIssues,
    validateTableCommentaryAlignmentContract,
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
    maskProtectedMarkdownTableRegions,
    extractVisibleMarkdownImages,
    maskInlineMarkdownCodeSpans,
    repairMissingMarkdownTableSeparators,
    normalizeExperimentTableNumericFormatting,
    capExperimentTableMetricColumns,
    validateExperimentTableEvidenceDepth,
    validateExperimentTableContract,
    analysisManifestRequiresExperimentTableContract,
    validateMethodDetailContract,
    validateManualDepthContract,
    MANUAL_DEPTH_SOURCE_CONTRACT,
    MANUAL_DEPTH_COVERAGE_CONTRACT,
    MANUAL_DEPTH_EXPLANATION_CONTRACT,
    MANUAL_DEPTH_READER_QUALITY_CONTRACT,
    MANUAL_DEPTH_FACT_COVERAGE_CONTRACT,
    MANUAL_DEPTH_CONTRACTS,
    MANUAL_READER_QUALITY_CONTRACTS,
    findCrossSectionDuplicateSentences,
    validateManualSourceCoverage,
    validateManualBeginnerExplanation,
    analysisManifestRequiresMethodDetailContract,
    isRecoveryStageTerminal,
    CORE_SUMMARY_MIN_CHINESE_CHARS,
    CORE_SUMMARY_MAX_CHINESE_CHARS,
    CORE_SUMMARY_MIN_SENTENCES,
    CORE_SUMMARY_MAX_SENTENCES,
    hasCoreSummaryQuantitativeEvidence,
    hasSourceMeasuredLossComparison,
    classifySourceQuantitativeEvidence,
    sourceSoftwareFunctionalValidationResult,
    hasCompleteSoftwareFunctionalValidationResult,
    coreSummarySentenceView,
    validateCoreSummarySemanticContract,
    coreSummaryQuantitativeResultState,
    hasExplicitNaturalProductChain,
    hasConcreteProductHandoff,
    hasExplicitArtifactHandoff,
    hasConditionalMetricDeltaDirection, hasGeneratedInputModelHeadChain,
    hasNaturalScopedBoundary,
    hasCachedCausalStateHandoff,
    hasOfflineOperationalBoundary,
    hasBoundFormerLatterComparison,
    hasBoundDisjointIntervalComparison,
    stripSymbolicPatternRelation,
    hasSymbolicGeometryMethodChain,
    hasScopedSymbolicDemonstration,
    hasConcreteUnnumberedMethodChain,
    hasBlockLayoutProductChain,
    hasPosteriorUpdateProductChain,
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

for (const [exportName, getter] of [
    ['CURRENT_MODEL_POLICY', () => getManualAgentPolicy().CURRENT_MODEL_POLICY],
    ['MANUAL_RESEARCH_CONTRACT', () => getManualResearchContract().MANUAL_RESEARCH_CONTRACT],
    ['FRESH_AUTHORING_CONTRACT', () => getManualFreshAuthoring().FRESH_AUTHORING_CONTRACT],
    ['FRESH_AUTHORING_MODE', () => getManualFreshAuthoring().FRESH_AUTHORING_MODE],
    ['MANUAL_TUTORIAL_PAYLOAD_CONTRACT', () => getManualTutorialPayload().MANUAL_TUTORIAL_PAYLOAD_CONTRACT]
]) {
    Object.defineProperty(module.exports, exportName, {
        enumerable: true,
        configurable: true,
        get: getter
    });
}

if (require.main === module) {
    require('./env-loader.js').requireExternalRuntime('analysis-contract.js');
}
